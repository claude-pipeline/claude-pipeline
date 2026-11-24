// `pipeline summary`: the "pushed to a ready PR without redrafting" warning (lib/ci-usage-pr.mjs), only for a repository with ci.draft_while_iterating: true.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { createFakeGh, pipelineYml } from './helpers/fakegh-env.mjs';
import { cli, PR, ME, REPO } from './helpers/gate-env.mjs';
import { MARKERS } from '../pipeline/lib/render.mjs';
import { assertExit } from './helpers/assert-exit.mjs';

const T = (hhmm, sec = 0) => `2026-11-10T${hhmm}:${String(sec).padStart(2, '0')}Z`;
const sha = (c) => c.repeat(40);
const ev = (event, at) => ({ event, created_at: at, actor: { login: 'me' } });
const run = (id, head, created, over = {}) => ({
  id, name: 'ci', event: 'pull_request', head_sha: head, run_attempt: 1, head_branch: 'agent/feat', pull_requests: [{ number: PR }],
  created_at: created, run_started_at: created, updated_at: created, ...over,
});
// PR 12 opened as a draft at 09:00, marked ready at 10:00
const TIMELINE = [ev('ready_for_review', T('10:00'))];
const commitOf = (c) => ({ sha: sha(c), parents: [{ sha: 'p' }], committer: { login: 'me' }, commit: { message: 'work' } });
const gh = ({ runs, timelineFail = false, pullCommits, commits = [commitOf('a'), commitOf('b')], totalRuns, state, comments = [] } = {}) => createFakeGh([
  { match: '^pr view 12 --json title', stdoutJson: { title: 'Add widget', headRefName: 'agent/feat', baseRefName: 'main', headRefOid: sha('b') } },
  ME, REPO,
  { match: '^api repos/acme/widgets/pulls/12/commits', stdoutJson: commits },
  { match: '^api repos/acme/widgets/pulls/12\\b', stdoutJson: { number: PR, created_at: T('09:00'), draft: false, ...(state === undefined ? {} : { state }), ...(pullCommits === undefined ? {} : { commits: pullCommits }), head: { ref: 'agent/feat', repo: { full_name: 'acme/widgets' } } } },
  timelineFail ? { match: '^api repos/acme/widgets/issues/12/timeline', code: 1, stderr: 'gh: HTTP 502' } : { match: '^api repos/acme/widgets/issues/12/timeline', stdoutJson: TIMELINE },
  { match: '^api repos/acme/widgets/actions/runs\\?event=pull_request&branch=agent%2Ffeat', stdoutJson: { total_count: totalRuns ?? runs?.length ?? 0, workflow_runs: runs ?? [] } },
  { match: '^api repos/acme/widgets/issues/12/comments --paginate', stdoutJson: comments },
  { match: '^api -X PATCH repos/acme/widgets/issues/comments/', stdoutJson: { id: 5, html_url: 'https://github.com/acme/widgets/pull/12#issuecomment-5' } },
  { match: '^api -X POST repos/acme/widgets/issues/12/comments', stdoutJson: { id: 5, html_url: 'https://github.com/acme/widgets/pull/12#issuecomment-5' } },
]);
function summary(flag, fake, outcome = 'blocked') {
  const repo = createTmpRepo();
  repo.write('.claude/pipeline.yml', flag === null ? pipelineYml() : `${pipelineYml()}  draft_while_iterating: ${flag}\n`);
  repo.write('.gitignore', '.review/\n.verify/\n');
  repo.commit('init');
  return cli(['summary', '--pr', String(PR), '--outcome', outcome], { dir: repo.dir, fake });
}
const body = (fake) => JSON.parse(fake.calls().find((c) => c.argv.includes('POST') || c.argv.includes('PATCH')).stdin).body;
const pushedReady = [run(1, sha('a'), T('09:30')), run(2, sha('b'), T('10:30')), run(3, sha('b'), T('10:30', 3), { name: 'guards' })];

test('summary: flag true and one push while ready => a warning, the JSON field and one line in the comment', () => {
  const fake = gh({ runs: pushedReady });
  const r = summary(true, fake);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual(r.json.pushedWhileReady, { count: 1, heads: [sha('b').slice(0, 12)] });
  assert.ok(r.json.warnings.includes(`pushed to the ready PR without \`P redraft\` first 1 time(s): ${sha('b').slice(0, 12)}; a push to a ready PR starts the full CI suite`), r.json.warnings.join('\n'));
  const text = body(fake);
  assert.ok(text.startsWith(MARKERS.summary));
  assert.match(text, /Pushed to the ready PR without `pipeline redraft` first once: b{12} \(a push to a ready PR starts the full CI suite\)\./);
});

test('an unlinked run on this PR\'s branch is not counted as a push (only runs whose pull_requests link this PR count)', () => {
  // failure caught: a run GitHub did not link to this PR (a fork's or a sibling PR's, same branch name) published as this PR's push without redrafting
  const own = { head_repository: { full_name: 'acme/widgets' }, pull_requests: [] };
  const fake = gh({ runs: [run(1, sha('a'), T('09:30')), run(2, sha('b'), T('10:30'), own), run(3, sha('f'), T('10:40'), { head_repository: { full_name: 'someone/widgets' }, pull_requests: [] })] });
  const r = summary(true, fake);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.pushedWhileReady, undefined);
  assert.deepEqual(r.json.warnings, []);
  assert.doesNotMatch(body(fake), /Pushed to the ready PR/);
});

test('mixed-link same head: an unlinked run while draft and a linked run on the same head while ready => no accusation, one "could not be checked" warning', () => {
  // failure caught: a false "pushed without redraft" (the unlinked draft-era run was the head\'s first, so the linked ready-time run is only a second suite of it)
  const fake = gh({ runs: [run(1, sha('a'), T('09:30')), run(4, sha('b'), T('09:45'), { pull_requests: [] }), run(2, sha('b'), T('10:30')), run(3, sha('b'), T('10:30', 3), { name: 'guards' })] });
  const r = summary(true, fake);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.pushedWhileReady, undefined);
  const text = r.json.warnings.join('\n');
  assert.match(text, /1 head\(s\) pushed while the PR was ready also have a pull_request run GitHub did not link to a PR, so they could not be checked/);
  assert.doesNotMatch(text, /without `P redraft`/);
  assert.doesNotMatch(body(fake), /Pushed to the ready PR/);
});

test('R4-B4: past the 250-commit cap a head missing from the returned commits is not named as a push, and the warning says it could not be checked', () => {
  // failure caught: the omitted newest head (an update-branch merge, say) has no commit record, so it was published as a push made without redrafting
  const fake = gh({ runs: pushedReady, pullCommits: 251, commits: [commitOf('a')] });
  const r = summary(true, fake);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.pushedWhileReady, undefined);
  assert.match(r.json.warnings.join('\n'), /GitHub lists 251 commits for this PR but returned 1 .*could not be checked/);
  assert.doesNotMatch(r.json.warnings.join('\n'), /may be short|without `P redraft`/);
  assert.doesNotMatch(body(fake), /Pushed to the ready PR/);
});

test('summary: flag true but every push was made in draft => no warning, no field, no comment line', () => {
  const fake = gh({ runs: [run(1, sha('a'), T('09:30'))] });
  const r = summary(true, fake);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.pushedWhileReady, undefined);
  assert.deepEqual(r.json.warnings, []);
  assert.doesNotMatch(body(fake), /Pushed to the ready PR/);
});

test('summary: flag false (or absent) => not a single extra read', () => {
  for (const flag of [false, null]) {
    const fake = gh({ runs: pushedReady });
    const r = summary(flag, fake);
    assertExit(r, 0, r.stderr + r.stdout);
    assert.equal(r.json.pushedWhileReady, undefined);
    const lines = fake.lines();
    assert.ok(!lines.some((l) => /timeline|actions\/runs|pulls\/12|\/commits/.test(l)), lines.join('\n'));
  }
});

test('summary: a read error becomes a warning; the summary still succeeds', () => {
  const fake = gh({ runs: pushedReady, timelineFail: true });
  const r = summary(true, fake);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.pushedWhileReady, undefined);
  assert.match(r.json.warnings.join('\n'), /pushed-while-ready check skipped: GitHub could not be read/);
  assert.ok(fake.lines().some((l) => l.includes('-X POST')), 'the comment was still posted');
});

test('PR #823 round 1 B1: the run list is read before the timeline and the commits, so no listed run is newer than the phases it is judged against', () => {
  // failure caught: a redraft and a push between the timeline read and the run-list read made the new draft-era run look like a push while ready
  const fake = gh({ runs: pushedReady });
  const r = summary(true, fake);
  assertExit(r, 0, r.stderr + r.stdout);
  const at = (re) => fake.lines().findIndex((l) => re.test(l));
  assert.ok(at(/actions\/runs\?event=pull_request/) >= 0 && at(/actions\/runs\?event=pull_request/) < at(/issues\/12\/timeline/), fake.lines().join('\n'));
  assert.ok(at(/actions\/runs\?event=pull_request/) < at(/pulls\/12\/commits/));
});

test('PR #823 round 1 B2: a run list GitHub capped (more runs than returned) is not judged: a "could not be checked" warning, no head named', () => {
  // failure caught: with the oldest runs of a head missing, a later run looked like the head's first and was published as a push without redrafting
  const fake = gh({ runs: pushedReady, totalRuns: 1500 });
  const r = summary(true, fake);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.pushedWhileReady, undefined);
  assert.match(r.json.warnings.join('\n'), /GitHub lists 1500 workflow runs for this branch but returned 3 .*could not be checked, so no head is named/);
  assert.doesNotMatch(body(fake), /Pushed to the ready PR/);
});

test('PR #823 round 1 B3: a head the commit list does not hold (a force push dropped a catch-up merge) is not named as a push', () => {
  // failure caught: the earlier update-branch merge, gone from the rebased branch but still linked to its run, published as a push without redrafting
  const fake = gh({ runs: pushedReady, commits: [commitOf('a')] });
  const r = summary(true, fake);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.pushedWhileReady, undefined);
  assert.match(r.json.warnings.join('\n'), /1 head\(s\) pushed while the PR was ready are not in its commit list .*could not be checked/);
  assert.doesNotMatch(body(fake), /Pushed to the ready PR/);
});

test('PR #823 round 1 B10: an unlinked run from before this PR existed does not hide a genuine push while ready', () => {
  // failure caught: a run on the same SHA from an earlier PR on a reused branch name made the head "ambiguous" and dropped the warning
  const fake = gh({ runs: [...pushedReady, run(9, sha('b'), T('08:00'), { pull_requests: [] })] });
  const r = summary(true, fake);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual(r.json.pushedWhileReady, { count: 1, heads: [sha('b').slice(0, 12)] });
});

// the summary comment an earlier `summary` run left on the PR (the viewer is `me`); `line` is the pushed-while-ready line it held, or none
const earlierComment = (line) => ({ id: 5, user: { login: 'me' }, body: `${MARKERS.summary}\n\n### Outcome\n\n**awaiting-owner-merge**${line ? `\n\n${line}` : ''}` });
const EARLIER_LINE = 'Pushed to the ready PR without `pipeline redraft` first once: bbbbbbbbbbbb (a push to a ready PR starts the full CI suite).';
const closedRuns = pushedReady.map((x) => ({ ...x, pull_requests: [] }));

test('PR #823 round 1 F1 / #832 (a): the final summary of a merged PR keeps the pushed-while-ready line the earlier summary held, with no warning', () => {
  // failure caught: GitHub unlinks the runs of a merged PR, so the re-rendered comment lost the line the owner was meant to read after the merge
  const fake = gh({ runs: closedRuns, state: 'closed', comments: [earlierComment(EARLIER_LINE)] });
  const r = summary(true, fake, 'merged-externally');
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.pushedWhileReady, undefined);
  assert.deepEqual(r.json.warnings, []);
  const text = body(fake);
  assert.match(text, /### Outcome\n\n\*\*merged-externally\*\*\n\nPushed to the ready PR without `pipeline redraft` first once: b{12} \(a push to a ready PR starts the full CI suite\)\./);
  assert.equal(text.split('Pushed to the ready PR').length, 2, 'the line is there once');
});

test('#832 (b): a merged PR with no earlier summary comment in a draft_while_iterating repository says it could not check, and names no head', () => {
  // failure caught: with nothing to carry the line from, the final summary said nothing about a check it could not make
  const fake = gh({ runs: closedRuns, state: 'closed' });
  const r = summary(true, fake, 'merged-externally');
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.pushedWhileReady, undefined);
  assert.match(r.json.warnings.join('\n'), /the PR is no longer open \(merged or closed\).*could not be checked/);
  assert.doesNotMatch(body(fake), /Pushed to the ready PR/);
});

test('#832 (c): a merged PR whose earlier summary had no such line gets no line and no warning (nothing was lost)', () => {
  // failure caught: every merged or closed PR of a draft_while_iterating repository got the "could not be checked" warning on its final summary, pushed or not
  const fake = gh({ runs: closedRuns, state: 'closed', comments: [earlierComment(null)] });
  const r = summary(true, fake, 'merged-externally');
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual(r.json.warnings, []);
  assert.doesNotMatch(body(fake), /Pushed to the ready PR/);
});
