// `pipeline ci-usage` end to end against a scripted fake gh (the same way test/stats-rounds.test.mjs drives `stats rounds`), and the call budget in-process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { createFakeGh, pipelineYml, REPO_VIEW } from './helpers/fakegh-env.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { makeBudget } from '../pipeline/lib/ci-usage-read.mjs';
import { parseRates, parseSince } from '../pipeline/commands/ci-usage.mjs';
import { pages, MAX_PAGES } from '../pipeline/lib/gh-pages.mjs';

const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'pipeline', 'bin', 'pipeline.mjs');
const T = (hhmm, sec = 0) => `2026-11-10T${hhmm}:${String(sec).padStart(2, '0')}Z`;
const sha = (c) => c.repeat(40);
const plus = (at, min) => new Date(Date.parse(at) + min * 60_000).toISOString();
const ev = (event, at, login = 'me') => ({ event, created_at: at, actor: { login } });
const b64 = (text) => ({ content: Buffer.from(text).toString('base64'), encoding: 'base64' });
const PIPELINE_YML = (flag) => `version: 1\nproject: demo\nenforcement: github\nverify:\n  full: npm run verify\n  quick: npm run verify:quick\nci:\n  required_checks: [ci]\n  draft_while_iterating: ${flag}\n`;

// one PR (#7): opened as a draft 09:00, ready 10:00, back to draft 11:00 (by me), ready again 12:00
const PR7 = { number: 7, created_at: T('09:00'), draft: false };
const TIMELINE7 = [ev('ready_for_review', T('10:00')), ev('converted_to_draft', T('11:00')), ev('ready_for_review', T('12:00'))];
const COMMITS7 = [
  { sha: sha('1'), parents: [{ sha: 'p' }], committer: { login: 'me' }, commit: { message: 'work' } },
  { sha: sha('3'), parents: [{ sha: 'p' }], committer: { login: 'me' }, commit: { message: 'work', committer: { date: T('10:25') } } }, // the head pushed while ready (dated inside the period)
  { sha: sha('c'), parents: [{ sha: 'p' }, { sha: 'q' }], committer: { login: 'web-flow' }, commit: { message: "Merge branch 'main' into agent/x" } },
];
const run = (id, over) => ({
  id, name: 'ci', path: '.github/workflows/ci.yml', event: 'pull_request', head_sha: sha('3'), run_attempt: 1, conclusion: 'success', head_branch: 'agent/x', head_repository: { full_name: 'acme/widgets' },
  pull_requests: [{ number: 7 }], created_at: T('10:30'), run_started_at: T('10:30'), updated_at: plus(T('10:30'), 10), ...over,
});
const job = (startedAt, minutes, labels = ['ubuntu-latest'], over = {}) => ({ run_attempt: 1, conclusion: 'success', labels, started_at: startedAt, completed_at: plus(startedAt, minutes), ...over });
const RUNS = [
  run(1001, { head_sha: sha('1'), created_at: T('09:30'), run_started_at: T('09:30'), updated_at: plus(T('09:30'), 0.5) }), // a draft-era push: light
  run(1002, { head_sha: sha('2'), created_at: T('12:00', 30), run_started_at: T('12:00', 30), updated_at: plus(T('12:00', 30), 12) }), // the ready_for_review suite
  run(1003, {}), // pushed while ready
  run(1004, { name: 'guards', path: '.github/workflows/guards.yml', created_at: T('10:30', 2), run_started_at: T('10:30', 2), updated_at: plus(T('10:30', 2), 2) }), // same push, second workflow
  run(1005, { head_sha: sha('c'), created_at: T('12:30'), run_started_at: T('12:30'), updated_at: plus(T('12:30'), 6) }), // a catch-up head
  run(1006, { event: 'schedule', pull_requests: [], head_sha: sha('m'), created_at: T('08:00'), run_started_at: T('08:00'), updated_at: plus(T('08:00'), 2) }),
];
const JOBS = {
  1002: [job(T('12:00', 30), 4), job(T('12:00', 30), 4), job(T('12:00', 30), 4), job(T('12:00', 30), 1)],
  1003: [job(T('10:30'), 6), job(T('10:30'), 3.5, ['macos-latest'])],
  1004: [job(T('10:30', 2), 2, ['windows-latest'])],
  1005: [job(T('12:30'), 6)],
  1006: [job(T('08:00'), 2, ['self-hosted'])],
  1101: [job(T('10:30', 5), 5)],
  1201: [job(T('09:45'), 3)],
};
const rateLimit = (remaining) => ({ match: '^api rate_limit', stdoutJson: { resources: { core: { remaining, limit: 5000, reset: 1 } } } });
const world = ({ priv = true, flag = true, runs = RUNS, remaining = 4000, extra = [] } = {}) => [
  ...extra,
  { match: '^repo view', stdoutJson: REPO_VIEW },
  { match: '^api user', stdout: 'me\n' },
  rateLimit(remaining),
  { match: '^api repos/acme/widgets$', stdoutJson: { private: priv } },
  flag === null ? { match: '^api repos/acme/widgets/contents/', code: 1, stderr: 'gh: Not Found (HTTP 404)' } : { match: '^api repos/acme/widgets/contents/', stdoutJson: b64(PIPELINE_YML(flag)) },
  { match: '^api repos/acme/widgets/actions/runs\\?created', stdoutJson: { total_count: runs.length, workflow_runs: runs } },
  ...Object.entries(JOBS).map(([id, jobs]) => ({ match: `^api repos/acme/widgets/actions/runs/${id}/jobs`, stdoutJson: { total_count: jobs.length, jobs } })),
  { match: '^api repos/acme/widgets/pulls/7/commits', stdoutJson: COMMITS7 },
  { match: '^api repos/acme/widgets/pulls/7\\b', stdoutJson: PR7 },
  { match: '^api repos/acme/widgets/issues/7/timeline', stdoutJson: TIMELINE7 },
];

function usage(entries, args) {
  const repo = createTmpRepo();
  repo.write('.claude/pipeline.yml', pipelineYml());
  repo.commit('init');
  const fake = createFakeGh(entries);
  const env = { ...process.env, ...fake.env };
  delete env.PIPELINE_OFF;
  const r = spawnSync(process.execPath, [bin, 'ci-usage', ...args], { cwd: repo.dir, env, encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* text mode */ }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr, fake };
}
const round4 = (v) => Math.round(v * 1e4) / 1e4;

test('ci-usage --json: classes, pushes while ready, wasted redrafts, churn and the cost quantities of a private repository', () => {
  const r = usage(world(), ['--json', '--since', '2026-11-05']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.classifierVersion, 1);
  assert.equal(r.json.since, '2026-11-05T00:00:00Z');
  const [repo] = r.json.repos;
  assert.deepEqual([repo.slug, repo.private, repo.billing, repo.draftWhileIterating, repo.partial], ['acme/widgets', true, 'estimate-private', true, false]);
  const t = repo.totals;
  // 1001 is light (30 s); 1002..1006 are heavy
  assert.equal(t.heavyRuns, 5);
  assert.equal(t.coverage, 100);
  assert.deepEqual([t.pushesWhileReady, t.missedRedrafts, t.wastedRedrafts], [1, 1, 1]);
  assert.deepEqual(Object.fromEntries(Object.entries(t.byClass).map(([k, v]) => [k, v.runs])), { 'push-while-draft': 1, 'ready-for-review': 1, 'push-while-ready': 2, 'catch-up': 1, other: 1 });
  assert.equal(t.byEvent.schedule.heavyRuns, 1);
  assert.equal(t.workflowElapsedMin, 12 + 10 + 2 + 6 + 2);
  assert.deepEqual(t.jobMinutes, { linux: 13 + 6 + 6, windows: 2, macos: 3.5, 'self-hosted': 2 });
  assert.equal(t.estimatedUsd, round4((13 * 0.006) + (6 * 0.006) + (2 * 0.010) + (4 * 0.062) + (6 * 0.006)), 'ceil per job: 4 min of macOS for the 3.5 min job');
  assert.deepEqual([t.churnRuns, t.churnMinutes, t.catchupsPerPr], [1, 6, 1]);
  const p = repo.prs.find((x) => x.pr === 7);
  assert.deepEqual([p.readyCycles, p.pushesWhileReady, p.pushedHeads, p.pushesWhileDraft, p.wastedRedrafts, p.catchups, p.heavyRuns], [2, 1, [sha('3').slice(0, 12)], 1, 1, 1, 4]);
  assert.match(repo.unexcludable.join('\n'), /convert-failed/);
  assert.equal(r.json.warnings.length, 0, r.json.warnings.join('\n'));
  // the runs list asks for runs created since the date
  assert.ok(r.fake.lines().some((l) => l.includes('actions/runs?created=%3E%3D2026-11-05T00%3A00%3A00Z')), r.fake.lines().join('\n'));
  assert.ok(r.fake.lines().some((l) => l.includes('actions/runs/1002/jobs?filter=all')));
});

test('ci-usage: a public repository is free (usd 0, billing free-public) but the job minutes are still counted', () => {
  const r = usage(world({ priv: false }), ['--json', '--since', '2026-11-05']);
  assertExit(r, 0, r.stderr + r.stdout);
  const [repo] = r.json.repos;
  assert.deepEqual([repo.billing, repo.totals.estimatedUsd, repo.totals.jobMinutes.linux], ['free-public', 0, 25]);
  assert.equal(repo.prs.every((p) => p.estimatedUsd === 0), true, 'R1-B8: the PR rows are free too');
});

test('ci-usage: ci.draft_while_iterating false => no missed redrafts; unreadable pipeline.yml => unknown (null), the pushes while ready are still counted', () => {
  const off = usage(world({ flag: false }), ['--json', '--since', '2026-11-05']).json.repos[0];
  assert.deepEqual([off.draftWhileIterating, off.totals.pushesWhileReady, off.totals.missedRedrafts], [false, 1, 0]);
  const r = usage(world({ flag: null }), ['--json', '--since', '2026-11-05']);
  assertExit(r, 0, r.stderr + r.stdout);
  const unknown = r.json.repos[0];
  assert.deepEqual([unknown.draftWhileIterating, unknown.totals.pushesWhileReady, unknown.totals.missedRedrafts], ['unknown', 1, null]);
  assert.match(r.json.warnings.join('\n'), /acme\/widgets: \.claude\/pipeline\.yml could not be read/);
});

test('ci-usage: --rate overrides the estimate; a bad rate or os is a usage error', () => {
  const base = usage(world(), ['--json', '--since', '2026-11-05']).json.repos[0];
  const doubled = usage(world(), ['--json', '--since', '2026-11-05', '--rate', 'linux=0.012']).json.repos[0];
  assert.equal(doubled.assumptions.rates.linux, 0.012);
  assert.ok(doubled.totals.estimatedUsd > base.totals.estimatedUsd);
  assert.equal(doubled.assumptions.rates['self-hosted'], 0);
  for (const bad of ['linux', 'linux=abc', 'solaris=1', 'linux=-1']) assertExit(usage(world(), ['--json', '--rate', bad]), 2, bad);
  assert.deepEqual(parseRates(['macos=0.1']), { linux: 0.006, windows: 0.010, macos: 0.1 });
});

test('ci-usage --since: YYYY-MM-DD, Nd and invalid values (exit 2)', () => {
  const day = usage(world(), ['--json', '--since', '2026-11-05']);
  assert.equal(day.json.since, '2026-11-05T00:00:00Z');
  const thirty = usage(world(), ['--json', '--since', '30d']);
  assertExit(thirty, 0, thirty.stderr);
  const asked = Date.parse(thirty.json.since);
  assert.ok(Math.abs(Date.now() - 30 * 86_400_000 - asked) < 60_000, thirty.json.since);
  assertExit(usage(world(), ['--json']), 0, 'default 7d');
  for (const bad of ['yesterday', '2026-02-31', '2026-13-01', '0d', '-3d', '7', '7days', '']) assertExit(usage(world(), ['--json', '--since', bad]), 2, `--since ${bad}`);
  assert.equal(parseSince('2d', Date.UTC(2026, 10, 13)), Date.UTC(2026, 10, 11));
});

test('ci-usage: --max-calls reached => partial with skipped counts and a coverage below 100; the jobs of the biggest runs are read first', () => {
  const r = usage(world(), ['--json', '--since', '2026-11-05', '--max-calls', '10']);
  assertExit(r, 0, r.stderr + r.stdout);
  const repo = r.json.repos[0];
  assert.equal(repo.partial, true);
  assert.ok(repo.calls <= 10, `calls ${repo.calls}`);
  assert.ok(repo.skipped.jobs > 0, JSON.stringify(repo.skipped));
  assert.ok(repo.totals.coverage < 100 && repo.totals.coverage > 0, `coverage ${repo.totals.coverage}`);
  assert.match(r.json.warnings.join('\n'), /--max-calls 10 reached: the report is partial/);
  assert.match(r.json.warnings.join('\n'), /had their jobs unread/);
  // the biggest run (1002, 12 min) got its jobs; the smallest candidate (1004, 2 min) did not
  const lines = r.fake.lines();
  assert.ok(lines.some((l) => l.includes('runs/1002/jobs')));
  assert.equal(lines.filter((l) => /runs\/\d+\/jobs/.test(l)).length, 4, 'the budget allowed four job reads');
  assert.equal(repo.skipped.jobs, 1);
  // the estimate only prices the jobs that were read
  assert.ok(repo.totals.estimatedUsd > 0);
});

test('ci-usage: a low rate limit (< 1000 left) stops the reading after the first list: partial, skipped counts, exit 0', () => {
  const r = usage(world({ remaining: 500 }), ['--json', '--since', '2026-11-05']);
  assertExit(r, 0, r.stderr + r.stdout);
  const repo = r.json.repos[0];
  assert.equal(repo.partial, true);
  assert.equal(repo.rateLimit.remaining, 500);
  assert.equal(repo.calls, 3, 'repository, pipeline.yml and the runs list only');
  assert.deepEqual([repo.skipped.prs, repo.skipped.jobs], [1, 5]);
  assert.equal(repo.totals.coverage, 100 * 0, 'no jobs read');
  assert.match(r.json.warnings.join('\n'), /the rate limit is low \(500 calls left/);
  assert.equal(repo.totals.byClass.unclassified.runs, 5, 'the PR runs of the unread PR');
});

test('ci-usage: the budget re-reads the rate limit every 50 calls and stops below 1000 (in-process)', () => {
  let reads = 0;
  const gh = { api: () => { reads += 1; return { resources: { core: { remaining: reads === 1 ? 5000 : 900 } } }; } };
  const warnings = [];
  const b = makeBudget(gh, { maxCalls: 400, warnings, label: 'x' });
  for (let i = 0; i < 49; i += 1) b.tick();
  assert.equal(reads, 1, 'only the first read so far');
  b.tick(); // the 50th call: the rate limit is read again
  assert.equal(reads, 2);
  assert.throws(() => b.tick(), b.stop);
  assert.equal(b.reason, 'rate-limit');
  assert.equal(b.calls, 50);
});

test('ci-usage: a run list cut by the page limit is a warning (and pages() reports the cut once)', () => {
  const light = Array.from({ length: 100 }, (_, i) => ({ id: 5000 + i, name: 'ci', event: 'push', head_sha: sha('a'), run_attempt: 1, created_at: T('10:00'), run_started_at: T('10:00'), updated_at: T('10:00', 5) }));
  const r = usage(world({ runs: light }), ['--json', '--since', '2026-11-05']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.match(r.json.warnings.join('\n'), new RegExp(`acme/widgets: the list of workflow runs was cut after ${MAX_PAGES} pages`));
  assert.equal(r.json.repos[0].partial, true, 'R1-B9: a cut list is not a complete report');
  let cuts = 0;
  const out = pages({ api: () => Array.from({ length: 100 }, () => ({})) }, 'repos/x/y/z', undefined, () => { cuts += 1; });
  assert.deepEqual([out.length, cuts], [MAX_PAGES * 100, 1]);
});

test('R1-B9: GitHub reporting more runs than it returned (the 1000-result cap) makes the report partial', () => {
  const capped = [{ match: '^api repos/acme/widgets/actions/runs\\?created', stdoutJson: { total_count: 1200, workflow_runs: RUNS } }];
  const r = usage(world({ extra: capped }), ['--json', '--since', '2026-11-05']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.match(r.json.warnings.join('\n'), /GitHub lists 1200 runs for this period but returned 6/);
  assert.equal(r.json.repos[0].partial, true);
});

test('ci-usage: --workflow keeps only the runs of that workflow (by name, path or file name)', () => {
  for (const name of ['guards', '.github/workflows/guards.yml', 'guards.yml']) {
    const r = usage(world(), ['--json', '--since', '2026-11-05', '--workflow', name]);
    assertExit(r, 0, r.stderr + r.stdout);
    assert.equal(r.json.repos[0].runsRead, 1, name);
  }
});

test('ci-usage: a pull_request run GitHub did not link to a PR is counted once as "other / pull_request", never given to a PR, and no PR-list or comments read happens', () => {
  // failure caught: an unlinked run dropped, double-counted, or given to PR #7 by its branch name, or the deferred pulls?state=all / comments reads creeping back
  const onBranch = { head_branch: 'agent/x', head_repository: { full_name: 'acme/widgets' }, pull_requests: [] };
  const runs = [
    RUNS.find((x) => x.id === 1005), // linked, heavy, on a catch-up head outside the ready_for_review window (it used to trigger the comments read)
    run(1101, { ...onBranch, head_sha: sha('u'), created_at: T('10:30', 5), run_started_at: T('10:30', 5), updated_at: plus(T('10:30', 5), 5) }), // unlinked, heavy
    run(1102, { ...onBranch, head_sha: sha('v'), created_at: T('10:40'), run_started_at: T('10:40'), updated_at: plus(T('10:40'), 0.5) }), // unlinked, 30 seconds
    RUNS.find((x) => x.id === 1006), // scheduled
  ];
  const r = usage(world({ runs }), ['--json', '--since', '2026-11-05']);
  assertExit(r, 0, r.stderr + r.stdout);
  const [repo] = r.json.repos;
  const t = repo.totals;
  assert.equal(repo.partial, false);
  const count = (key) => Object.fromEntries(Object.entries(t[key]).map(([k, v]) => [k, [v.runs, v.heavyRuns]]));
  assert.deepEqual(count('byClass'), { 'catch-up': [1, 1], other: [3, 2] });
  assert.deepEqual(count('byEvent'), { pull_request: [2, 1], schedule: [1, 1] });
  assert.equal(t.workflowElapsedMin, 6 + 5 + 2);
  assert.deepEqual(t.jobMinutes, { linux: 6 + 5, windows: 0, macos: 0, 'self-hosted': 2 });
  assert.equal(t.estimatedUsd, round4(11 * 0.006));
  assert.deepEqual(repo.prs.map((p) => [p.pr, p.heavyRuns, p.workflowElapsedMin]), [[7, 1, 6]], 'the PR row holds only the linked run');
  assert.deepEqual(t.attribution, { unlinkedRuns: 2, linkedHeavyRuns: 1, linkedHeavyElapsedMin: 6, unlinkedHeavyRuns: 1, unlinkedHeavyElapsedMin: 5 });
  assert.match(r.json.warnings.join('\n'), /acme\/widgets: 2 pull_request run\(s\) were not linked to a PR/);
  const lines = r.fake.lines();
  assert.ok(!lines.some((l) => l.includes('pulls?state=all')), lines.join('\n'));
  assert.ok(!lines.some((l) => /issues\/\d+\/comments/.test(l)), lines.join('\n'));
});

test('ci-usage: an unlinked run on the same head as a linked push while ready leaves that head out of the count, with a warning, and both runs stay in the totals', () => {
  // failure caught: a false "pushed without redraft" (the unlinked run was the head's first, made while the PR was a draft)
  const early = run(1201, { pull_requests: [], created_at: T('09:45'), run_started_at: T('09:45'), updated_at: plus(T('09:45'), 3) }); // head sha('3'), as the linked run 1003 at 10:30
  const r = usage(world({ runs: [...RUNS, early] }), ['--json', '--since', '2026-11-05']);
  assertExit(r, 0, r.stderr + r.stdout);
  const [repo] = r.json.repos;
  const p = repo.prs.find((x) => x.pr === 7);
  assert.deepEqual([p.pushesWhileReady, p.pushedHeads, p.uncheckedHeads], [0, [], 1]);
  assert.deepEqual([repo.totals.pushesWhileReady, repo.totals.missedRedrafts, repo.totals.uncheckedHeads], [0, 0, 1]);
  assert.match(r.json.warnings.join('\n'), /acme\/widgets: 1 head\(s\) pushed while the PR was ready also have a pull_request run GitHub did not link to a PR.* they could not be checked/);
  assert.equal(repo.totals.heavyRuns, 6, 'both runs of the head stay in the totals');
  assert.equal(repo.totals.jobMinutes.linux, 25 + 3);
  assert.equal(repo.totals.workflowElapsedMin, 12 + 10 + 2 + 6 + 2 + 3);
});

test('R3-B4: a PR with more commits than GitHub returned (it caps them at 250, with no cut page) makes the report partial and warns', () => {
  const capped = [{ match: '^api repos/acme/widgets/pulls/7$', stdoutJson: { ...PR7, commits: 251 } }];
  const r = usage(world({ extra: capped }), ['--json', '--since', '2026-11-05']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.repos[0].partial, true);
  assert.match(r.json.warnings.join('\n'), /acme\/widgets: #7: GitHub lists 251 commits for this PR but returned 3 /);
});

test('R1-B7: a run re-run in under a minute still has its jobs read (the first attempt\'s 20 minutes are not lost)', () => {
  const retried = run(2001, { run_attempt: 2, created_at: T('10:30'), run_started_at: T('10:50'), updated_at: plus(T('10:50'), 1 / 3) });
  const jobs = [{ match: '^api repos/acme/widgets/actions/runs/2001/jobs', stdoutJson: { total_count: 2, jobs: [job(T('10:30'), 20), job(T('10:50'), 1 / 3, ['ubuntu-latest'], { run_attempt: 2 })] } }];
  const r = usage(world({ runs: [retried], extra: jobs }), ['--json', '--since', '2026-11-05']);
  assertExit(r, 0, r.stderr + r.stdout);
  const repo = r.json.repos[0];
  assert.ok(r.fake.lines().some((l) => l.includes('runs/2001/jobs')));
  assert.equal(Math.round(repo.totals.jobMinutes.linux * 10) / 10, 20.3);
  assert.deepEqual([repo.totals.byClass.rerun.heavyRuns, repo.totals.coverage], [1, 100]);
});

test('R2-B5: a short retry whose jobs could not be read is still a heavy run of unknown cost: coverage drops below 100', () => {
  const retried = run(2001, { run_attempt: 2, created_at: T('10:30'), run_started_at: T('10:50'), updated_at: plus(T('10:50'), 1 / 3) });
  const down = [{ match: '^api repos/acme/widgets/actions/runs/2001/jobs', code: 1, stderr: 'gh: HTTP 502' }];
  const r = usage(world({ runs: [retried], extra: down }), ['--json', '--since', '2026-11-05']);
  assertExit(r, 0, r.stderr + r.stdout);
  const repo = r.json.repos[0];
  assert.deepEqual([repo.totals.heavyRuns, repo.totals.coverage, repo.partial], [1, 0, true]);
});

test('R2-B3: a jobs list cut by the page limit makes the report partial', () => {
  const many = Array.from({ length: 100 }, () => job(T('10:30'), 0.01));
  const cut = [{ match: '^api repos/acme/widgets/actions/runs/1003/jobs', stdoutJson: { total_count: 5000, jobs: many } }];
  const r = usage(world({ extra: cut }), ['--json', '--since', '2026-11-05']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.match(r.json.warnings.join('\n'), /run 1003: the jobs were cut after/);
  assert.equal(r.json.repos[0].partial, true);
});

test('R3-B3: one heavy run whose jobs list was cut is not fully read: coverage drops below 100 and the run counts in skipped.jobs', () => {
  const many = Array.from({ length: 100 }, () => job(T('10:30'), 0.01));
  const cut = [{ match: '^api repos/acme/widgets/actions/runs/1003/jobs', stdoutJson: { total_count: 5000, jobs: many } }];
  const r = usage(world({ extra: cut }), ['--json', '--since', '2026-11-05']);
  assertExit(r, 0, r.stderr + r.stdout);
  const repo = r.json.repos[0];
  assert.deepEqual([repo.partial, repo.totals.heavyRuns, repo.totals.coverage, repo.skipped.jobs], [true, 5, 80, 1]);
});

test('ci-usage: without --json it prints a plain-text table with the warnings; GitHub unreachable for the first list is exit 3', () => {
  const r = usage(world({ flag: null }), ['--since', '2026-11-05']);
  assertExit(r, 0, r.stderr);
  assert.equal(r.json, null);
  assert.match(r.stdout, /CI usage since 2026-11-05T00:00:00Z in acme\/widgets \(private; classifier v1\)/);
  assert.match(r.stdout, /#7 +2 +1 +1 +1 +1 +4 /);
  assert.match(r.stdout, /Pushed while ready 1 · missed redrafts unknown/);
  assert.match(r.stdout, /Warnings:\n- acme\/widgets: \.claude\/pipeline\.yml could not be read/);
  assert.match(r.stdout, /convert-failed/);
  const down = usage(world().map((e) => (e.match.includes('actions/runs\\?created') ? { match: e.match, code: 1, stderr: 'gh: HTTP 502' } : e)), ['--json', '--since', '2026-11-05']);
  assertExit(down, 3, down.stderr + down.stdout);
});

test('ci-usage: a bad --repo-slug or --max-calls is a usage error', () => {
  assertExit(usage(world(), ['--json', '--repo-slug', 'nope']), 2);
  assertExit(usage(world(), ['--json', '--max-calls', '0']), 2);
  assertExit(usage(world(), ['--json', '--bogus']), 2);
});

test('PR #823 round 1 B3/F3/B5: a head missing from the PR commit list (a force push dropped a catch-up merge), or whose commit predates --since, is not counted as pushed while ready', () => {
  // failure caught: the report naming a head with no commit record (or one whose first run may lie before the period) as a missed redraft; the summary leaves the same heads out
  const without = COMMITS7.filter((c) => c.sha !== sha('3'));
  const dropped = usage(world({ extra: [{ match: '^api repos/acme/widgets/pulls/7/commits', stdoutJson: without }] }), ['--json', '--since', '2026-11-05']);
  const old = COMMITS7.map((c) => (c.sha === sha('3') ? { ...c, commit: { message: 'work', committer: { date: '2026-11-01T08:00:00Z' } } } : c));
  const reopened = usage(world({ extra: [{ match: '^api repos/acme/widgets/pulls/7/commits', stdoutJson: old }] }), ['--json', '--since', '2026-11-05']);
  for (const r of [dropped, reopened]) {
    assertExit(r, 0, r.stderr + r.stdout);
    const [repo] = r.json.repos;
    const p = repo.prs.find((x) => x.pr === 7);
    assert.deepEqual([p.pushesWhileReady, p.pushedHeads, p.uncheckedHeads], [0, [], 1]);
    assert.deepEqual([repo.totals.pushesWhileReady, repo.totals.missedRedrafts, repo.totals.uncheckedHeads], [0, 0, 1]);
    assert.match(r.json.warnings.join('\n'), /1 head\(s\) pushed while the PR was ready .*commit list.*could not be checked/);
  }
});

test('PR #823 round 1 B5: --workflow does not hide an earlier run of another workflow: the head first ran in draft, so the filtered run is no push while ready', () => {
  // failure caught: with --workflow ci the draft-era guards run on the head is gone, the ci run at 10:30 looks like the head's first and is counted as a missed redraft
  const draftEra = run(1301, { name: 'guards', path: '.github/workflows/guards.yml', created_at: T('09:45'), run_started_at: T('09:45'), updated_at: T('09:45', 10) }); // head sha('3'), as the ci run 1003 at 10:30
  const r = usage(world({ runs: [...RUNS, draftEra] }), ['--json', '--since', '2026-11-05', '--workflow', 'ci']);
  assertExit(r, 0, r.stderr + r.stdout);
  const [repo] = r.json.repos;
  assert.deepEqual([repo.totals.pushesWhileReady, repo.totals.missedRedrafts, repo.prs.find((x) => x.pr === 7).pushedHeads], [0, 0, []]);
});

test('PR #823 round 1 B7: a run listed on two pages (a new run pushed it onto the next page) is charged once', () => {
  // failure caught: the same run's job minutes and cost added twice
  const heavy = { id: 5099, name: 'ci', path: '.github/workflows/ci.yml', event: 'push', head_sha: sha('a'), run_attempt: 1, created_at: T('10:00'), run_started_at: T('10:00'), updated_at: plus(T('10:00'), 10) };
  const filler = Array.from({ length: 99 }, (_, i) => ({ ...heavy, id: 5000 + i, updated_at: T('10:00', 5) }));
  const pagesOf = [
    { match: '^api repos/acme/widgets/actions/runs\\?created.*page=1$', stdoutJson: { total_count: 101, workflow_runs: [...filler, heavy] } },
    { match: '^api repos/acme/widgets/actions/runs\\?created.*page=2$', stdoutJson: { total_count: 101, workflow_runs: [heavy, { ...heavy, id: 5100, updated_at: T('10:00', 5) }] } },
    { match: '^api repos/acme/widgets/actions/runs/5099/jobs', stdoutJson: { total_count: 1, jobs: [job(T('10:00'), 10)] } },
  ];
  const r = usage(world({ extra: pagesOf }), ['--json', '--since', '2026-11-05']);
  assertExit(r, 0, r.stderr + r.stdout);
  const [repo] = r.json.repos;
  assert.equal(repo.runsListed, 101);
  assert.equal(repo.totals.jobMinutes.linux, 10);
  assert.equal(repo.totals.estimatedUsd, round4(10 * 0.006));
});

test('PR #823 round 1 B9: when the viewer lookup fails, wasted redrafts are not counted (null), not attributed to everyone', () => {
  // failure caught: another person's draft-then-ready cycle reported as the viewer's wasted redraft, with partial false
  const r = usage(world({ extra: [{ match: '^api user', code: 1, stderr: 'gh: HTTP 401' }] }), ['--json', '--since', '2026-11-05']);
  assertExit(r, 0, r.stderr + r.stdout);
  const [repo] = r.json.repos;
  assert.deepEqual([repo.totals.wastedRedrafts, repo.prs.find((x) => x.pr === 7).wastedRedrafts], [null, null]);
  assert.match(r.json.warnings.join('\n'), /the viewer login could not be read/);
});
