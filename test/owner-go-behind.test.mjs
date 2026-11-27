// `P merge --owner-go` on a PR that lacks commits of its base (plan 2026-11-05-small-fixes item 2). With merge.behind_base: disjoint in the BASE
// commit's config, a PR whose base moved is accepted when main's new commits touch none of the PR's files and none of the toolchain / CI inputs;
// everything else keeps the old refusal (behind-base). Also: no landing on a base nobody checked (the wait pins GitHub's baseRefOid).
// Real CLI against the scripted fake gh and real git repos (main moves with real commits).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mergeRequest, ownerSays } from './helpers/owner-go.mjs';
import { bump, cli, ghEntries, scenario, ymlFor, MERGE_SHA, PR } from './helpers/gate-env.mjs';
import { ymlWith } from './helpers/ci-proof-env.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { behindFreshEnough, evaluateOwnerGo, READABLE_MERGE_STATES, waitBlockers, waitForMerge } from '../pipeline/lib/finalgate.mjs';
import { loadConfig } from '../pipeline/lib/config.mjs';
import { createGitHub } from '../pipeline/lib/github.mjs';
import * as gate from '../pipeline/lib/finalgate.mjs';

const goYml = (yml = ymlFor()) => yml.replace('{pr} {sha}', '{pr} --match-head-commit {sha}');
// The base's config: opted in (or not) and optionally more merge keys. The merge section is the last one, right after wait_minutes.
const withMerge = (yml, lines) => yml.replace('  wait_minutes: 1\n', `  wait_minutes: 1\n${lines}`);
const disjointYml = (more = '', yml = ymlFor()) => goYml(withMerge(yml, `  behind_base: disjoint\n${more}`));
const unique = (change = bump) => (repo) => { change(repo); repo.write('.salt', randomUUID()); };
const fresh = (opts = {}) => scenario({ yml: disjointYml(), report: null, state: null, ...opts, change: unique(opts.change) });
const goMerge = (s, env = {}) => cli(['merge', '--pr', String(PR), '--owner-go'], { dir: s.repo.dir, fake: s.fake, env: { ...s.env, ...env } });
const withRecord = (t, s) => ownerSays(t, 'merge', mergeRequest(PR, s.head, 'none'));
const script = (s, o = {}) => ghEntries({ prHead: s.head, baseOid: s.baseTip, prFiles: s.prFiles, ...o });

// One commit on main, then back on the PR branch. -> the new main tip (what GitHub's baseRefOid becomes).
function mainMoves(s, edit) {
  s.repo.git(['checkout', '-q', 'main']);
  edit(s.repo);
  const tip = s.repo.commit('main moves');
  s.repo.git(['checkout', '-q', 'agent/feature']);
  return tip;
}
// The PR is behind: main moved to `tip`. GitHub's PR `baseRefOid` stays at the fork point (it does not follow main: proven on a real open PR), so only the
// compare API (behind_by, base tip) shows it. GitHub calls the PR CLEAN (or `mergeStateStatus`).
const behindScript = (s, tip, o = {}) => s.fake.setScript(script(s, { baseOid: s.baseTip, behindBy: 1, compareBase: tip, mergeStateStatus: 'CLEAN', ...o }));
const reasons = (r) => (r.json.reasons ?? []).join('\n');
const refusedBehind = (r, s, pattern) => {
  assertExit(r, 1);
  assert.match(reasons(r), /behind-base/);
  if (pattern) assert.match(reasons(r), pattern);
  assert.deepEqual(s.mergeCalls(), [], 'no merge command may run');
};

// ---- accepted ----------------------------------------------------------------------------------------------------------------------

test('behind_base disjoint: main changed only files the PR does not touch -> owner-go merges, output carries `behind`', (t) => {
  const s = fresh();
  const tip = mainMoves(s, (repo) => { repo.write('other.txt', 'x\n'); repo.write('more/other2.txt', 'y\n'); });
  behindScript(s, tip);
  withRecord(t, s);
  const r = goMerge(s);
  assertExit(r, 0);
  assert.equal(r.json.merged, true);
  assert.deepEqual(r.json.behind, { behindBy: 1, mergeBase: s.baseTip, baseRefOid: s.baseTip, baseTip: tip, mainFiles: 2, rule: 'disjoint' });
  assert.equal(s.mergeCalls().length, 1);
});

test('behind_base disjoint: an up-to-date PR reports behind: null', (t) => {
  const s = fresh();
  withRecord(t, s);
  const r = goMerge(s);
  assertExit(r, 0);
  assert.equal(r.json.behind, null);
});

// ---- the opt-in comes from the BASE ----------------------------------------------------------------------------------------------

test('behind_base default (update): a behind PR is refused, and the detail says why disjoint was not applied', (t) => {
  const s = scenario({ yml: goYml(), report: null, state: null, change: unique() });
  const tip = mainMoves(s, (repo) => repo.write('other.txt', 'x\n'));
  behindScript(s, tip);
  withRecord(t, s);
  refusedBehind(goMerge(s), s, /merge\.behind_base is "update"/);
});

test('behind_base: the PR\'s OWN pipeline.yml saying disjoint does not count when the base\'s does not', (t) => {
  const s = scenario({
    yml: goYml(), report: null, state: null,
    change: unique((repo) => { bump(repo); repo.write('.claude/pipeline.yml', disjointYml()); }),
  });
  const tip = mainMoves(s, (repo) => repo.write('other.txt', 'x\n'));
  behindScript(s, tip);
  withRecord(t, s);
  refusedBehind(goMerge(s), s, /merge\.behind_base is "update"/);
});

test('behind_base: a base commit with no .claude/pipeline.yml, or an invalid one, is strict (the reason says which)', (t) => {
  const missing = fresh();
  const gone = mainMoves(missing, (repo) => repo.rm('.claude/pipeline.yml'));
  behindScript(missing, gone);
  withRecord(t, missing);
  refusedBehind(goMerge(missing), missing, /has no \.claude\/pipeline\.yml/);

  const invalid = fresh();
  const bad = mainMoves(invalid, (repo) => repo.write('.claude/pipeline.yml', 'version: 1\nbehind_base: [\n'));
  behindScript(invalid, bad);
  withRecord(t, invalid);
  refusedBehind(goMerge(invalid), invalid, /\.claude\/pipeline\.yml/);
  assert.doesNotMatch(reasons(goMerge(invalid)), /fresh enough: undefined/);

  const typo = fresh();
  const wrong = mainMoves(typo, (repo) => repo.write('.claude/pipeline.yml', withMerge(ymlFor(), '  behind_base: dis-joint\n')));
  behindScript(typo, wrong);
  withRecord(t, typo);
  refusedBehind(goMerge(typo), typo, /not a valid config/);
});

// ---- rule 3: disjoint ----------------------------------------------------------------------------------------------------------------

test('behind_base disjoint: main changed files the PR also touches -> behind-base naming the first 3 and the count', (t) => {
  const many = (repo) => { bump(repo); for (const n of [1, 2, 3, 4]) repo.write(`gen/a${n}.js`, 'pr\n'); };
  const s = fresh({ change: many, baseFiles: Object.fromEntries([1, 2, 3, 4].map((n) => [`gen/a${n}.js`, 'base\n'])) });
  const tip = mainMoves(s, (repo) => { for (const n of [1, 2, 3, 4]) repo.write(`gen/a${n}.js`, 'main\n'); });
  behindScript(s, tip);
  withRecord(t, s);
  const r = goMerge(s);
  refusedBehind(r, s, /changed 4 file\(s\) this PR also touches \(gen\/a1\.js, gen\/a2\.js, gen\/a3\.js, \.\.\.\)/);
  assert.doesNotMatch(reasons(r), /a4\.js/);
});

test('behind_base disjoint: main renamed a PR file away (the old name is one of main\'s paths) -> behind-base', (t) => {
  const s = fresh({ change: (repo) => { bump(repo); repo.write('docs/guide.md', '# Guide\n\nPR edit\n'); } });
  const tip = mainMoves(s, (repo) => repo.git(['mv', 'docs/guide.md', 'docs/manual.md']));
  behindScript(s, tip);
  withRecord(t, s);
  refusedBehind(goMerge(s), s, /docs\/guide\.md/);
});

test('behind_base disjoint: a case-only difference (Src2/A.md vs src2/a.md) is the same file -> behind-base', (t) => {
  const s = fresh({ change: (repo) => { bump(repo); repo.write('Src2/A.md', 'pr\n'); } });
  const tip = mainMoves(s, (repo) => repo.write('src2/a.md', 'main\n'));
  behindScript(s, tip);
  withRecord(t, s);
  refusedBehind(goMerge(s), s, /src2\/a\.md/);
});

test('behind_base disjoint: a non-ASCII path and a path with a space changed on BOTH sides -> behind-base (read the same way on both sides)', (t) => {
  for (const name of ['docs/résumé.md', 'docs/my file.md']) {
    const s = fresh({ change: (repo) => { bump(repo); repo.write(name, 'pr\n'); } });
    const tip = mainMoves(s, (repo) => repo.write(name, 'main\n'));
    // GitHub lists raw UTF-8 names; the fixture's own list may hold git's quoted form
    const raw = [...s.prFiles.filter((f) => !f.filename.startsWith('"')), { filename: name, status: 'added' }];
    behindScript(s, tip, { prFiles: raw });
    withRecord(t, s);
    refusedBehind(goMerge(s), s, new RegExp(`this PR also touches \\(${name}\\)`));
  }
});

test('behind_base disjoint: main removed src/foo/, which the PR adds a file into -> behind-base naming the directory (rule 4b)', (t) => {
  const s = fresh({ baseFiles: { 'src/foo/a.js': 'a\n' }, change: (repo) => { bump(repo); repo.write('src/foo/new.js', 'n\n'); } });
  const tip = mainMoves(s, (repo) => repo.git(['mv', 'src/foo', 'src/bar']));
  behindScript(s, tip);
  withRecord(t, s);
  refusedBehind(goMerge(s), s, /removed src\/foo\/, which this PR adds into \(src\/foo\/new\.js\)/);
});

// Codex code review R1: the directory is compared folded. Called directly with the PR's side as a diff entry: a case-insensitive checkout
// (macOS, Windows) cannot even write src/foo/new.js next to src/Foo/, and main's side (real commits) is what must be read folded.
test('behind_base disjoint: main removed src/Foo/ and the PR adds src/foo/new.js -> the same directory, folded (rule 4b)', () => {
  const s = fresh({ baseFiles: { 'src/Foo/a.js': 'a\n' } });
  const tip = mainMoves(s, (repo) => repo.git(['rm', '-q', '-r', 'src/Foo']));
  const r = behindFreshEnough({
    root: s.repo.dir, config: { default_branch: 'main' }, baseSha: tip, info: { mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE' },
    diff: () => ({ ok: true, mb: s.baseTip, files: [{ status: 'A', oldPath: null, newPath: 'src/foo/new.js' }] }),
  });
  assert.deepEqual(r, { ok: false, reason: 'main removed src/foo/, which this PR adds into (src/foo/new.js)' });
});

// ---- rule 4: nothing on main's side changes how the checks run ------------------------------------------------------------------------

const hits = [
  ['.github/workflows/x.yml', (repo) => repo.write('.github/workflows/x.yml', 'on: push\n')],
  ['.claude/pipeline.yml', (repo) => repo.write('.claude/pipeline.yml', `${disjointYml()}# main edit\n`)],
  ['scripts/verify.mjs', (repo) => repo.write('scripts/verify.mjs', 'x\n')],
  ['scripts/verify/run.mjs', (repo) => repo.write('scripts/verify/run.mjs', 'x\n')],
  ['.gitattributes', (repo) => repo.write('.gitattributes', '* text=auto\n')],
  ['sub/.gitattributes', (repo) => repo.write('sub/.gitattributes', '*.js -diff\n')],
  ['.nvmrc', (repo) => repo.write('.nvmrc', '20\n')],
  ['.node-version', (repo) => repo.write('.node-version', '20\n')],
  ['.tool-versions', (repo) => repo.write('.tool-versions', 'nodejs 20\n')],
  ['.gitmodules', (repo) => repo.write('.gitmodules', '# none\n')],
  ['.GITHUB/workflows/y.yml', (repo) => repo.write('.GITHUB/workflows/y.yml', 'on: push\n')],
];
for (const [name, edit] of hits) {
  test(`behind_base disjoint: ${name} changed on main always forces the update`, (t) => {
    const s = fresh();
    const tip = mainMoves(s, edit);
    behindScript(s, tip);
    withRecord(t, s);
    refusedBehind(goMerge(s), s, /changes how the checks run/);
  });
}

test('behind_base disjoint: the base\'s merge.behind_base_stale_paths and verify.ci_proof_inputs globs force the update', (t) => {
  const stale = scenario({ yml: disjointYml("  behind_base_stale_paths: ['package.json', 'supabase/**']\n"), report: null, state: null, change: unique() });
  const a = mainMoves(stale, (repo) => repo.write('supabase/migrations/0001.sql', 'select 1;\n'));
  behindScript(stale, a);
  withRecord(t, stale);
  refusedBehind(goMerge(stale), stale, /supabase\/migrations\/0001\.sql.*matches supabase\/\*\*/);

  const inputs = scenario({ yml: disjointYml('', ymlWith({ inputs: ["'data/**'"] })), report: null, state: null, change: unique() });
  const b = mainMoves(inputs, (repo) => repo.write('data/spec.json', '{}\n'));
  behindScript(inputs, b);
  withRecord(t, inputs);
  refusedBehind(goMerge(inputs), inputs, /data\/spec\.json.*matches data\/\*\*/);

  // and a main change outside every list is still fine for the same configs
  const ok = scenario({ yml: disjointYml("  behind_base_stale_paths: ['package.json']\n", ymlWith({ inputs: ["'data/**'"] })), report: null, state: null, change: unique() });
  const c = mainMoves(ok, (repo) => repo.write('notes/readme.txt', 'x\n'));
  behindScript(ok, c);
  withRecord(t, ok);
  assertExit(goMerge(ok), 0);
});

// ---- rule 2: GitHub agrees --------------------------------------------------------------------------------------------------------------

test('behind_base disjoint: mergeStateStatus BEHIND / DIRTY / UNKNOWN / HAS_HOOKS-less odd values are never accepted; the readable ones are', (t) => {
  for (const state of ['BEHIND', 'DIRTY', 'UNKNOWN', 'DRAFT', undefined]) {
    const s = fresh();
    const tip = mainMoves(s, (repo) => repo.write('other.txt', 'x\n'));
    behindScript(s, tip, { mergeStateStatus: state });
    withRecord(t, s);
    refusedBehind(goMerge(s), s, /mergeStateStatus/);
  }
  for (const state of READABLE_MERGE_STATES) {
    const s = fresh();
    const tip = mainMoves(s, (repo) => repo.write('other.txt', 'x\n'));
    behindScript(s, tip, { mergeStateStatus: state });
    withRecord(t, s);
    assertExit(goMerge(s), 0);
  }
});

test('behind_base disjoint: GitHub mergeable CONFLICTING / UNKNOWN is never accepted', (t) => {
  for (const mergeable of ['CONFLICTING', 'UNKNOWN']) {
    const s = fresh();
    const tip = mainMoves(s, (repo) => repo.write('other.txt', 'x\n'));
    behindScript(s, tip, { mergeable });
    withRecord(t, s);
    const r = goMerge(s, { PIPELINE_MERGEABLE_PAUSE_MS: '1' });
    assertExit(r, 1);
    assert.deepEqual(s.mergeCalls(), []);
  }
});

// ---- rule 6: no landing on a base nobody checked --------------------------------------------------------------------------------------

const QUICK = { PIPELINE_MERGE_WAIT_MS: '1500', PIPELINE_MERGE_POLL_MS: '50' };
// The poll (state,mergeCommit,labels,baseRefOid) says OPEN on base `baseRefOid`; so does the look after the abandon (state,mergeCommit).
const pollOpen = (s, baseRefOid) => [
  { match: '^pr view 12 --json state,mergeCommit,labels,baseRefOid', stdoutJson: { state: 'OPEN', mergeCommit: null, labels: [], baseRefOid } },
  { match: '^pr view 12 --json state,mergeCommit$', stdoutJson: { state: 'OPEN', mergeCommit: null } },
];

test('--owner-go (behind, accepted): GitHub\'s baseRefOid changing while the queued merge waits -> auto-merge disabled, exit 1, not merged', (t) => {
  const s = fresh();
  const tip = mainMoves(s, (repo) => repo.write('other.txt', 'x\n'));
  behindScript(s, tip, { extra: pollOpen(s, 'e'.repeat(40)) });
  withRecord(t, s);
  const r = goMerge(s, QUICK);
  assertExit(r, 1);
  assert.equal(r.json.merged, false);
  assert.match(r.json.reason, /a blocker appeared while waiting: PR base is now eeeeeeee, the merge was evaluated on/);
  assert.match(r.json.reason, /auto-merge disabled/);
  assert.equal(r.json.autoMergeDisabled, true);
  assert.equal(r.json.behind.baseTip, tip);
  assert.equal(s.mergeCalls().length, 1, 'the (queued) merge command ran');
  assert.ok(s.fake.lines().some((l) => /^pr merge 12 --disable-auto/.test(l)), s.fake.lines().join('\n'));
});

test('--owner-go (UP TO DATE): main moving while the queued merge waits is abandoned too, not merged', (t) => {
  const s = fresh();
  s.fake.setScript(script(s, { extra: pollOpen(s, 'd'.repeat(40)) }));
  withRecord(t, s);
  const r = goMerge(s, QUICK);
  assertExit(r, 1);
  assert.match(r.json.reason, /a blocker appeared while waiting: PR base is now dddddddd/);
  assert.equal(r.json.autoMergeDisabled, true);
  assert.equal(r.json.behind, null);
});

test('--owner-go: the wait keeps going while GitHub\'s baseRefOid is still the evaluated one (timeout, not blocked)', (t) => {
  const s = fresh();
  s.fake.setScript(script(s, { extra: pollOpen(s, s.baseTip) }));
  withRecord(t, s);
  const r = goMerge(s, QUICK);
  assertExit(r, 1);
  assert.match(r.json.reason, /not merged in time/);
});

// ---- the pieces in-process ---------------------------------------------------------------------------------------------------------------

test('waitBlockers: with a base it asks for baseRefOid and blocks on any other (or missing) one; without it nothing changes', async () => {
  const gh = { listIssues: () => [] };
  const view = { labels: [], baseRefOid: 'a'.repeat(40) };
  assert.deepEqual(waitBlockers(gh).fields, []);
  assert.deepEqual(await waitBlockers(gh)({ labels: [] }), []);
  const guarded = waitBlockers(gh, { base: 'a'.repeat(40) });
  assert.deepEqual(guarded.fields, ['baseRefOid']);
  assert.deepEqual(await guarded(view), []);
  assert.match((await guarded({ ...view, baseRefOid: 'b'.repeat(40) })).join(), /PR base is now bbbbbbbb/);
  assert.match((await guarded({ labels: [] })).join(), /PR base is now/);
  const seen = [];
  const out = await waitForMerge({
    gh: { prView: (_pr, fields) => { seen.push(fields); return { state: 'OPEN', labels: [], baseRefOid: 'c'.repeat(40) }; } },
    pr: 1, waitMs: 1000, pollMs: 10, blockers: guarded,
  });
  assert.equal(out.state, 'blocked');
  assert.deepEqual(seen[0], ['state', 'mergeCommit', 'labels', 'baseRefOid']);
});

test('behindFreshEnough never throws and never returns null: a missing base sha is { ok: false }', () => {
  const diff = () => ({ ok: false, error: 'boom' });
  for (const baseSha of [undefined, null, 'main', '', 'a'.repeat(39)]) {
    const r = behindFreshEnough({ root: '.', config: { default_branch: 'main' }, diff, baseSha, info: {} });
    assert.equal(r.ok, false);
    assert.equal(typeof r.reason, 'string');
  }
});

// Codex code review R1: the case above returns before the diff is ever taken. Here the base is a real opted-in commit and GitHub's state is
// readable, so the diff IS read: a failed PR diff, and a failed read of main's side, are each a refusal with its reason (never a throw or null).
test('behindFreshEnough: with an opted-in base and a readable state, a failed PR diff or an unreadable main side is { ok: false }', () => {
  const s = fresh();
  const tip = mainMoves(s, (repo) => repo.write('other.txt', 'x\n'));
  const args = { root: s.repo.dir, config: { default_branch: 'main' }, baseSha: tip, info: { mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE' } };
  let calls = 0;
  const failed = behindFreshEnough({ ...args, diff: () => { calls += 1; return { ok: false, error: 'boom' }; } });
  assert.equal(calls, 1, 'the PR diff was read');
  assert.deepEqual(failed, { ok: false, reason: "the PR's diff could not be taken (boom)" });

  const missing = 'f'.repeat(40); // a well-formed merge base that is not in the repository: main's side cannot be diffed
  const mainSide = behindFreshEnough({ ...args, diff: () => ({ ok: true, mb: missing, files: [] }) });
  assert.equal(mainSide.ok, false);
  assert.match(mainSide.reason, /could not (compare|count)/);
});

// ---- merge queue: the queue merges on a fresh base, so a behind PR is no problem there -------------------------------------------------

test('owner-go evaluator on a behind PR: queue on => no behind-base problem; queue off => behind-base; unreadable => queue-state (fail closed)', async () => {
  const s = fresh({ yml: goYml() }); // the base does not opt in to `disjoint`: only the queue can lift the behind refusal
  const tip = mainMoves(s, (repo) => repo.write('other.txt', 'x\n'));
  const { config } = await loadConfig(s.repo.dir);
  const evaluate = (o) => {
    behindScript(s, tip, o);
    const gh = createGitHub({ cwd: s.repo.dir, env: s.fake.env });
    return evaluateOwnerGo({ root: s.repo.dir, config, pr: PR, gh, env: {} });
  };
  const detail = (live, name) => live.checks.find((c) => c.name === name)?.detail ?? '';

  const off = await evaluate({ queue: false });
  assert.match(detail(off, 'pr-open'), /behind-base/);
  assert.equal(off.behind, null);
  assert.ok(!off.failed.includes('queue-state'));

  const on = await evaluate({ queue: true });
  assert.doesNotMatch(detail(on, 'pr-open'), /behind-base/);
  assert.ok(!on.failed.includes('pr-open'), JSON.stringify(on.checks.filter((c) => !c.ok)));
  assert.equal(on.behind, null, 'the disjoint report is for the direct path only');

  const unreadable = await evaluate({ queue: 'error' });
  assert.equal(unreadable.ok, false);
  assert.ok(unreadable.failed.includes('queue-state'), unreadable.failed.join());
  assert.match(detail(unreadable, 'pr-open'), /behind-base/, 'an unreadable queue never lifts the behind refusal');

  // A PR that is not behind never needs the queue read (no extra GraphQL call, no new failure mode).
  const calls = s.fake.calls().length;
  s.fake.setScript(script(s, { baseOid: s.baseTip, queue: 'error' }));
  const current = await evaluateOwnerGo({ root: s.repo.dir, config, pr: PR, gh: createGitHub({ cwd: s.repo.dir, env: s.fake.env }), env: {} });
  assert.ok(!current.failed.includes('queue-state'));
  assert.ok(!s.fake.calls().slice(calls).some((c) => c.argv[0] === 'api' && c.argv[1] === 'graphql'));
});

// ---- #625: GitHub's baseRefOid does not follow main, so behind-ness comes from the compare API (its base tip), not from baseRefOid ----------------------
// Every fixture above keeps baseRefOid at the fork point (what GitHub really answers) and says "behind" through the compare reply only.

const cmpReply = (base, behindBy = 1) => ({ status: behindBy > 0 ? 'diverged' : 'ahead', behind_by: behindBy, ahead_by: 1, base });
const COMPARE = 'repos/acme/widgets/compare/';
const A_PARENT = 'a'.repeat(40);
const VIEW_OPEN = (s, extra = {}) => ({ state: 'OPEN', headRefOid: s.head, labels: [], isDraft: false, baseRefOid: s.baseTip, body: '', baseRefName: 'main', ...extra });
const diffFiles = (s, base, head) => s.repo.git(['diff', '-M', '--name-status', base, head]).trim().split('\n').filter(Boolean).map((line) => {
  const [status, a, b] = line.split('\t');
  return b === undefined ? { filename: a, status } : { filename: b, previous_filename: a, status };
});
// main moves twice (M, then T = the tip); the PR branch merges M in, so its own merge base with T is M, not the fork point. -> { m, tip, head }
function branchMergedMain(s) {
  s.repo.git(['checkout', '-q', 'main']);
  s.repo.write('m.txt', 'm\n');
  const m = s.repo.commit('main m');
  s.repo.write('t.txt', 't\n');
  const tip = s.repo.commit('main t');
  s.repo.git(['checkout', '-q', 'agent/feature']);
  s.repo.git(['merge', '-q', '--no-ff', '-m', 'merge main m', m]);
  return { m, tip, head: s.repo.git(['rev-parse', 'HEAD']).trim() };
}

test('#623: baseRefOid stays at the fork point while main moved one unrelated test file -> owner-go merges; behind.baseTip is main\'s tip (was: behind null, then a bare refusal)', (t) => {
  const s = fresh();
  const tip = mainMoves(s, (repo) => repo.write('test/other.test.js', 'x\n'));
  behindScript(s, tip);
  withRecord(t, s);
  const r = goMerge(s);
  assertExit(r, 0);
  assert.equal(r.json.merged, true);
  assert.equal(r.json.behind.baseTip, tip);
  assert.equal(r.json.behind.baseRefOid, s.baseTip, "baseRefOid keeps GitHub's PR field");
  assert.equal(s.mergeCalls().length, 1);
});

test('compare API: main\'s tip is not a local object -> refused, the reason says to fetch it (a gate never fetches)', (t) => {
  const s = fresh();
  mainMoves(s, (repo) => repo.write('other.txt', 'x\n'));
  behindScript(s, 'e'.repeat(40));
  withRecord(t, s);
  refusedBehind(goMerge(s), s, /main's tip eeeeeeee is not in this repository: run `git fetch origin main`/);
});

test('compare API: the PR\'s fork point against main\'s tip differs from the scanned one -> refused with the fork-point reason (the PR side and the main side must share one ancestor)', (t) => {
  const s = fresh();
  const { tip, head } = branchMergedMain(s);
  s.repo.git(['checkout', '-q', 'main']);
  s.repo.git(['checkout', '-q', '-b', 'side', s.baseTip]); // GitHub names a base commit that is on neither main's tip line nor the PR branch
  s.repo.write('side.txt', 's\n');
  const x = s.repo.commit('side');
  s.repo.git(['checkout', '-q', 'agent/feature']);
  behindScript(s, tip, { prHead: head, baseOid: x, prFiles: diffFiles(s, s.repo.git(['merge-base', x, head]).trim(), head) });
  ownerSays(t, 'merge', mergeRequest(PR, head, 'none'));
  const r = goMerge(s);
  refusedBehind(r, s, /fork point against main's tip \w{8} differs from the scanned one \w{8}/);
});

test('F6: the branch merged main in but GitHub\'s baseRefOid still names the old fork point -> the reason says to push / update the branch so GitHub refreshes it', (t) => {
  const s = fresh();
  const { tip, head } = branchMergedMain(s);
  behindScript(s, tip, { prHead: head, baseOid: s.baseTip, prFiles: diffFiles(s, s.baseTip, head) });
  ownerSays(t, 'merge', mergeRequest(PR, head, 'none'));
  refusedBehind(goMerge(s), s, /the PR's base on GitHub \(\w{8}\) predates the branch's own merge of main: push or update the branch \(P update-branch\) so GitHub refreshes it/);
});

// ---- main moves after the check ----------------------------------------------------------------------------------------------------

test('main moves between the live check and the last look -> pre-merge refusal "moved since the check", no merge command', (t) => {
  const s = fresh();
  const tip = mainMoves(s, (repo) => repo.write('other.txt', 'x\n'));
  const moved = 'b'.repeat(40);
  behindScript(s, tip, { extra: [{ match: COMPARE, stdoutJsonSeq: [cmpReply(tip), cmpReply(moved)] }] });
  withRecord(t, s);
  const r = goMerge(s);
  assertExit(r, 1);
  assert.match(reasons(r), /main moved since the check \(\w{8} → bbbbbbbb\): scan again/);
  assert.deepEqual(s.mergeCalls(), []);
});

test('the base retargeted to another branch at the same SHA before the last look -> refused', (t) => {
  const s = fresh();
  s.fake.setScript(script(s, { extra: [{ match: '^pr view 12 --json state,headRefOid,labels,isDraft', stdoutJson: VIEW_OPEN(s, { baseRefName: 'develop' }) }] }));
  withRecord(t, s);
  const r = goMerge(s);
  assertExit(r, 1);
  assert.match(reasons(r), /the PR's base is now develop at \w{8}, the check was of main at \w{8}: scan again/);
  assert.deepEqual(s.mergeCalls(), []);
});

test('main moves while the queued merge waits (baseRefOid unchanged, compare tip moved) -> auto-merge disabled, exit 1, not merged', (t) => {
  const s = fresh();
  const tip = mainMoves(s, (repo) => repo.write('other.txt', 'x\n'));
  const moved = 'b'.repeat(40);
  behindScript(s, tip, { extra: [...pollOpen(s, s.baseTip), { match: COMPARE, stdoutJsonSeq: [cmpReply(tip), cmpReply(tip), cmpReply(moved)] }] });
  withRecord(t, s);
  const r = goMerge(s, QUICK);
  assertExit(r, 1);
  assert.equal(r.json.merged, false);
  assert.match(r.json.reason, /a blocker appeared while waiting: main moved since the check/);
  assert.equal(r.json.autoMergeDisabled, true);
  assert.ok(s.fake.lines().some((l) => /^pr merge 12 --disable-auto/.test(l)));
});

test('main moves during the wait but the cancellation re-read says MERGED -> the merged outcome is kept, with baseMoved from the merge commit\'s parent', (t) => {
  const s = fresh();
  const tip = mainMoves(s, (repo) => repo.write('other.txt', 'x\n'));
  const moved = 'b'.repeat(40);
  behindScript(s, tip, { commitParents: { [MERGE_SHA]: [A_PARENT] }, extra: [pollOpen(s, s.baseTip)[0], { match: COMPARE, stdoutJsonSeq: [cmpReply(tip), cmpReply(tip), cmpReply(moved)] }] });
  withRecord(t, s);
  const r = goMerge(s, QUICK);
  assertExit(r, 0);
  assert.equal(r.json.merged, true);
  assert.match(r.json.note, /merged while auto-merge was being disabled/);
  assert.deepEqual(r.json.baseMoved, { from: tip, to: A_PARENT });
  assert.match(r.json.warning, /main's tip moved from \w{8} to aaaaaaaa/);
});

test('F3: a clean squash merge (first parent = the evaluated tip) reports no baseMoved; a first parent other than the evaluated tip does', (t) => {
  const clean = fresh();
  const tipA = mainMoves(clean, (repo) => repo.write('other.txt', 'x\n'));
  behindScript(clean, tipA, { commitParents: { [MERGE_SHA]: [tipA] } });
  withRecord(t, clean);
  const a = goMerge(clean);
  assertExit(a, 0);
  assert.equal('baseMoved' in a.json, false, JSON.stringify(a.json));

  const moved = fresh();
  const tipB = mainMoves(moved, (repo) => repo.write('other.txt', 'x\n'));
  behindScript(moved, tipB, { commitParents: { [MERGE_SHA]: [A_PARENT] } });
  withRecord(t, moved);
  const b = goMerge(moved);
  assertExit(b, 0);
  assert.equal(b.json.merged, true, 'a merge that happened stays a success');
  assert.deepEqual(b.json.baseMoved, { from: tipB, to: A_PARENT });
});

test('baseMovedAfterMerge: a rebase merge says the base was not checked (no baseMoved); an unreadable merge commit is a note, never a throw', async () => {
  const evaluated = { branch: 'main', tip: 'c'.repeat(40), behind: true, accepted: true, reason: null };
  const gh = (parents) => ({ commitParents: () => { if (parents instanceof Error) throw parents; return parents; } });
  const rebase = await gate.baseMovedAfterMerge({ gh: gh([A_PARENT]), mergeSha: MERGE_SHA, evaluated, command: 'gh pr merge 1 --rebase --auto' });
  assert.deepEqual(Object.keys(rebase), ['baseNote']);
  assert.match(rebase.baseNote, /not checked after a rebase merge/);
  const unreadable = await gate.baseMovedAfterMerge({ gh: gh(new Error('HTTP 502')), mergeSha: MERGE_SHA, evaluated, command: 'gh pr merge 1 --squash' });
  assert.deepEqual(Object.keys(unreadable), ['baseNote']);
  assert.match(unreadable.baseNote, /could not read/);
  assert.deepEqual(await gate.baseMovedAfterMerge({ gh: gh(['c'.repeat(40), A_PARENT]), mergeSha: MERGE_SHA, evaluated, command: 'gh pr merge 1 --merge' }), {}, 'a merge commit: the first parent is main\'s tip');
});

// ---- the queue decision is passed, not re-read -----------------------------------------------------------------------------------------

test('direct route: a second merge-queue read that answers "queue" cannot waive the behind rule (the queue decision is the first read)', (t) => {
  const s = scenario({ yml: goYml(), report: null, state: null, change: unique() }); // the base does not opt in: only a queue could lift the refusal
  const tip = mainMoves(s, (repo) => repo.write('other.txt', 'x\n'));
  const queueReply = (on) => ({ data: { repository: { pullRequest: { id: 'PR_node12', state: 'OPEN', headRefOid: s.head, isMergeQueueEnabled: on, mergeCommit: null, mergeQueueEntry: null } } } });
  behindScript(s, tip, { extra: [{ match: 'QueueState', stdoutJsonSeq: [queueReply(false), queueReply(true)] }] });
  withRecord(t, s);
  refusedBehind(goMerge(s), s, /merge\.behind_base is "update"/);
});

// ---- fail closed: a missing observation is a refusal, never "not behind" -------------------------------------------------------------------

test('F1: ownerGoBaseProblem refuses a non-queue live result with no evaluated tip or branch; queue mode needs none', () => {
  const base = 'a'.repeat(40);
  const evaluated = { branch: 'main', tip: 'b'.repeat(40), behind: false, accepted: null, reason: null };
  assert.equal(gate.ownerGoBaseProblem({ baseRefOid: base, evaluated }), null);
  assert.match(gate.ownerGoBaseProblem({ baseRefOid: base, evaluated: null }), /base tip .* was not recorded/);
  assert.match(gate.ownerGoBaseProblem({ baseRefOid: base, evaluated: { ...evaluated, tip: 'main' } }), /base tip .* was not recorded/);
  assert.match(gate.ownerGoBaseProblem({ baseRefOid: base, evaluated: { ...evaluated, branch: '' } }), /base tip .* was not recorded/);
  assert.equal(gate.ownerGoBaseProblem({ baseRefOid: base, evaluated: null }, { queueMode: true }), null);
  assert.match(gate.ownerGoBaseProblem({ baseRefOid: null, evaluated }), /baseRefOid/);
});

test('F2: the compare failing in the live check refuses the real merge (pr-open), never "not behind"', (t) => {
  const s = fresh();
  s.fake.setScript(script(s, { extra: [{ match: COMPARE, code: 1, stderr: 'gh: Server Error (HTTP 502)' }] }));
  withRecord(t, s);
  const r = goMerge(s);
  assertExit(r, 1);
  assert.match(reasons(r), /pr-open: .*could not compare the head with its base/);
  assert.deepEqual(s.mergeCalls(), []);
});

test('F2: preMergeProblems / waitBlockers with a tip to hold: an unreadable compare is a problem; without one nothing is read (the gated route and the queue)', async () => {
  const evaluated = { branch: 'main', tip: 'c'.repeat(40), behind: false, accepted: null, reason: null };
  const view = { state: 'OPEN', headRefOid: 'h'.repeat(40), labels: [], isDraft: false, baseRefName: 'main', body: '' };
  const down = { prView: () => view, listIssues: () => [], compare: () => { throw new Error('HTTP 502'); } };
  const steady = { ...down, compare: () => ({ behindBy: 0, aheadBy: 1, status: 'ahead', baseSha: evaluated.tip }) };
  const asked = [];
  const quiet = { prView: (_pr, fields) => { asked.push(fields); return view; }, listIssues: () => [], compare: () => { throw new Error('must not be read'); } };
  const look = (gh, extra = {}) => gate.preMergeProblems({ gh, pr: 1, head: view.headRefOid, ...extra });
  assert.match((await look(down, { evaluated })).join(), /could not re-read main's tip/);
  assert.deepEqual(await look(steady, { evaluated }), []);
  assert.deepEqual(await look(quiet), [], 'no tip given: no compare, today\'s behaviour');
  assert.ok(!asked[0].includes('baseRefName'));

  const blockers = (gh) => gate.waitBlockers(gh, { evaluated, head: view.headRefOid });
  assert.deepEqual(blockers(steady).fields, ['baseRefName']);
  assert.match((await blockers(down)(view)).join(), /could not re-read main's tip/);
  assert.deepEqual(await blockers(steady)(view), []);
  assert.deepEqual(gate.waitBlockers(quiet).fields, []);
  assert.deepEqual(await gate.waitBlockers(quiet)(view), []);
});
