// Tests for .github/scripts/queue-reuse.mjs (the merge-queue "this tree already passed on the PR run" decision) and for the
// way ci.yml wires it in. The script runs in a real tmp git repo (base commit, then the queue commit on top: its HEAD is the "queue
// commit") against the scripted fake `gh` (test/fixtures/fake-gh.mjs); the decision is read from the $GITHUB_OUTPUT file.
// Every case below is a way a queue run could skip tests that were never run on this tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml } from '../pipeline/lib/yaml.mjs';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { runNode, scratchDir } from './helpers/project.mjs';
import { expandJob, stepRuns } from './helpers/ci-matrix.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, '.github', 'scripts', 'queue-reuse.mjs');
const fakeGh = join(root, 'test', 'fixtures', 'fake-gh.mjs');

const REPO = 'acme/app';
const NUM = 7;
const HEAD = 'c'.repeat(40);
const MERGE = 'd'.repeat(40); // the merge commit the PR run tested (refs/pull/7/merge)
const RUN_ID = 555;
const JOB = 'test (ubuntu node 24 2/2)';
const TEST_STEP = 'Tests (Node 24, shard 2/2)';
const INSTALLER_STEP = 'Installer round trip (Node 24)';

const step = (name, conclusion = 'success') => ({ name, status: 'completed', conclusion });
const jobOf = (over = {}) => ({
  name: JOB, run_id: RUN_ID, run_attempt: 1, head_sha: HEAD, status: 'completed', conclusion: 'success',
  steps: [step('Set up job'), step('Already tested on the PR run?', 'skipped'), step(TEST_STEP), step(INSTALLER_STEP)],
  ...over,
});
const runOf = (over = {}) => ({
  id: RUN_ID, run_number: 5, run_attempt: 1, status: 'completed', conclusion: 'success', event: 'pull_request', head_sha: HEAD,
  head_repository: { full_name: REPO }, pull_requests: [{ number: NUM }], html_url: `https://github.example/runs/${RUN_ID}`, ...over,
});
const attemptOf = (over = {}) => ({
  id: RUN_ID, run_attempt: 1, status: 'completed', conclusion: 'success', event: 'pull_request', head_sha: HEAD,
  referenced_workflows: [{ path: 'acme/app/.github/workflows/proof-anchor.yml@refs/pull/7/merge', sha: MERGE, ref: `refs/pull/${NUM}/merge` }], ...over,
});
const queueEntry = (base, queueSha, over = {}) => ({ id: 'E1', state: 'AWAITING_CHECKS', headCommit: { oid: queueSha }, baseCommit: { oid: base }, pullRequest: { number: NUM, headRefOid: HEAD, baseRefName: 'main' }, ...over });
const pullOf = (over = {}) => ({ number: NUM, state: 'open', base: { ref: 'main' }, head: { sha: HEAD, repo: { full_name: REPO } }, ...over });

// The happy-path GitHub for one queue (base commit, queue commit): `over` replaces whole entries by key; 'fail' makes that call exit 1.
function gh({ base, queueSha, tree }, over = {}, extra = []) {
  const e = {
    graphql: { stdoutJson: { data: { repository: { mergeQueue: { entries: { pageInfo: { hasNextPage: false }, nodes: [queueEntry(base, queueSha)] } } } } } },
    onMain: { stdout: 'identical' },
    compare: { stdout: JSON.stringify({ total: 1, commits: [{ sha: queueSha, parents: 1, subject: `Do the thing (#${NUM})` }] }) },
    pull: { stdoutJson: pullOf() },
    runs: { stdoutJson: { total_count: 1, workflow_runs: [runOf()] } },
    attempt: { stdoutJson: attemptOf() },
    mergeCommit: { stdoutJson: { tree: { sha: tree } } },
    jobs: { stdoutJson: { jobs: [{ ...jobOf(), name: 'test (ubuntu node 24 1/2)' }, jobOf()] } },
    ...over,
  };
  const entry = (match, key) => (e[key] === 'fail' ? { match, code: 1, stderr: 'HTTP 500' } : { match, ...e[key] });
  return [
    ...extra,
    entry('^api graphql ', 'graphql'),
    entry(`^api repos/${REPO}/compare/${base}\\.\\.\\.main --jq`, 'onMain'),
    entry(`^api repos/${REPO}/compare/${base}\\.\\.\\.${queueSha}\\?per_page=100 --jq`, 'compare'),
    entry(`^api repos/${REPO}/pulls/${NUM}$`, 'pull'),
    entry(`^api repos/${REPO}/actions/workflows/ci\\.yml/runs\\?head_sha=${HEAD}&event=pull_request`, 'runs'),
    entry(`^api repos/${REPO}/actions/runs/${RUN_ID}/attempts/\\d+$`, 'attempt'),
    entry(`^api repos/${REPO}/git/commits/${MERGE}$`, 'mergeCommit'),
    entry(`^api repos/${REPO}/actions/runs/${RUN_ID}/attempts/\\d+/jobs\\?per_page=100&page=1$`, 'jobs'),
  ];
}

// `over` / `extra` may be a function of { base, queueSha }. `touch`: a path the queue commit changes besides b.txt. `treeOf`: the tree GitHub reports for the PR run's merge commit (default: the queue tree).
async function decide({ over = {}, extra = [], touch, treeOf, env = {}, noHeadMatch = false } = {}) {
  const repo = createTmpRepo();
  repo.write('a.txt', 'one\n');
  const base = repo.commit('base');
  repo.write('b.txt', 'two\n');
  if (touch) repo.write(touch, 'x\n');
  const queueSha = repo.commit(`Do the thing (#${NUM})`);
  const tree = repo.git(['rev-parse', 'HEAD^{tree}']).trim();
  const dir = scratchDir();
  const scriptFile = join(dir, 'script.json');
  const out = join(dir, 'output');
  const log = join(dir, 'log.jsonl');
  const known = (x) => (typeof x === 'function' ? x({ base, queueSha }) : x);
  writeFileSync(scriptFile, JSON.stringify(gh({ base, queueSha, tree: treeOf ?? tree }, known(over), known(extra))));
  writeFileSync(out, '');
  const r = await runNode([script], {
    cwd: repo.dir,
    env: {
      REPO, SHA: noHeadMatch ? 'e'.repeat(40) : queueSha, BASE_SHA: base, QUEUE_REF: `refs/heads/gh-readonly-queue/main/pr-${NUM}-${base}`,
      JOB_NAME: JOB, TEST_STEP, SHARD: '2', INSTALLER_STEP, INSTALLER_SHARD: '2', GITHUB_OUTPUT: out, GH_TOKEN: 'test-token',
      TESTED_TREE_GH_ARGV: JSON.stringify([process.execPath, fakeGh]),
      PIPELINE_FAKE_GH_SCRIPT: scriptFile, PIPELINE_FAKE_GH_LOG: log,
      ...env,
    },
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).argv.join(' ')) : [];
  return { ...r, tree, base, queueSha, calls, output: readFileSync(out, 'utf8').trim() };
}

// Every "must run" case: exit 0, run=true, and the reason line the log closes with.
async function mustRun(opts, reason) {
  const r = await decide(opts);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.output, 'run=true', r.stdout);
  assert.match(r.stdout, reason);
  return r;
}

test('the one queued PR whose newest PR run passed this job on the identical tree -> skip, with every check logged', async () => {
  const r = await decide();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.output, 'run=false', r.stdout);
  assert.match(r.stdout, new RegExp(`queue: single member PR #${NUM}, head ${HEAD}`));
  assert.match(r.stdout, new RegExp(`PR #${NUM}: open, into main, head ${HEAD} from ${REPO}`));
  assert.match(r.stdout, /none of them workflow, test runner or proof logic/);
  assert.match(r.stdout, new RegExp(`evidence: run ${RUN_ID} .* attempt 1 is the newest pull_request run on ${HEAD}`));
  assert.match(r.stdout, new RegExp(`merge commit ${MERGE} of refs/pull/${NUM}/merge has tree ${r.tree}, identical`));
  assert.match(r.stdout, /evidence: job "test \(ubuntu node 24 2\/2\)" concluded success, step "Tests \(Node 24, shard 2\/2\)" succeeded, step "Installer round trip \(Node 24\)" succeeded/);
  assert.match(r.stdout, /SKIP: this exact tree already passed this job on the PR/);
  assert.doesNotMatch(r.stdout, /RUN: /);
});

// Failure caught: a batch queue commit holds other PRs' changes that no single PR run ever tested together. Here the queue
// is two entries (PR 6 below PR 7), a chain queueManifest accepts: the single-member rule is what refuses it.
test('a queue commit made of two PRs (a batch) -> run', async () => {
  const OLDER = 'f'.repeat(40);
  const batch = ({ base, queueSha }) => ({
    graphql: { stdoutJson: { data: { repository: { mergeQueue: { entries: { pageInfo: { hasNextPage: false }, nodes: [
      queueEntry(OLDER, base, { id: 'E0', pullRequest: { number: 6, headRefOid: 'b'.repeat(40), baseRefName: 'main' } }),
      queueEntry(base, queueSha),
    ] } } } } } },
  });
  const chainBelow = ({ base, queueSha }) => [
    { match: `^api repos/${REPO}/compare/${OLDER}\\.\\.\\.main --jq`, stdout: 'identical' },
    { match: `^api repos/${REPO}/compare/${OLDER}\\.\\.\\.${queueSha}\\?per_page=100 --jq`, stdout: JSON.stringify({ total: 2, commits: [{ sha: base, parents: 1, subject: 'Other (#6)' }, { sha: queueSha, parents: 1, subject: `Do the thing (#${NUM})` }] }) },
  ];
  await mustRun({ over: batch, extra: chainBelow }, /RUN: queue commit holds 2 PRs \(a batch is never reused\)/);
});

// Failure caught: the queue entry still names an older PR head than the PR now has (a stale entry): the PR run on the new head says nothing about it.
test('a queue member whose head is not the PR head now -> run', async () => {
  await mustRun({ over: { pull: { stdoutJson: pullOf({ head: { sha: 'e'.repeat(40), repo: { full_name: REPO } } }) } } }, /RUN: PR #7 head is e{40}, the queue entry has c{40}/);
});

test('a PR that is closed, into another base, or from a fork -> run', async () => {
  await mustRun({ over: { pull: { stdoutJson: pullOf({ state: 'closed' }) } } }, /RUN: PR #7 is closed/);
  await mustRun({ over: { pull: { stdoutJson: pullOf({ base: { ref: 'dev' } }) } } }, /RUN: PR #7 base is dev/);
  await mustRun({ over: { pull: { stdoutJson: pullOf({ head: { sha: HEAD, repo: { full_name: 'fork/app' } } }) } } }, /RUN: PR #7 head is from fork\/app/);
});

// Failure caught: main moved after the PR run, so refs/pull/N/merge (the tree the PR run tested) is no longer the queue commit's tree.
test('the PR run tested a merge commit with another tree than the queue commit -> run', async () => {
  await mustRun({ treeOf: 'f'.repeat(40) }, /RUN: the PR run tested merge commit d{40}, tree f{40}; the queue commit's tree is/);
});

// Failure caught: skipping over a newer failed run to an older green one ("it passed once").
test('a newer run or attempt that failed, was cancelled or is still running is never skipped over to an older passing run -> run', async () => {
  const cases = {
    'newer run failed': [runOf(), runOf({ id: 556, run_number: 6, conclusion: 'failure' })],
    'newer run cancelled': [runOf(), runOf({ id: 556, run_number: 6, conclusion: 'cancelled' })],
    'newer run in progress': [runOf(), runOf({ id: 556, run_number: 6, status: 'in_progress', conclusion: null })],
    'newer attempt of the run failed': [runOf({ run_attempt: 2, conclusion: 'failure' })],
    'newest run was skipped (draft toggled)': [runOf(), runOf({ id: 556, run_number: 6, conclusion: 'skipped' })],
  };
  for (const [name, workflow_runs] of Object.entries(cases)) {
    const r = await mustRun({ over: { runs: { stdoutJson: { total_count: workflow_runs.length, workflow_runs } } } }, /RUN: the newest run \d+ \(#\d+\) is (failure|cancelled|in_progress|skipped), not a green completed run/);
    assert.ok(!r.calls.some((c) => c.includes(`/runs/${RUN_ID}/attempts/`)), `${name}: the older green run is never read`);
  }
});

// Failure caught: the listing's run says attempt 2 but the attempt object (or its jobs) is attempt 1's, or the attempt turned out red.
test('the latest attempt is the one read, and it must be green and its own', async () => {
  const two = { runs: { stdoutJson: { total_count: 1, workflow_runs: [runOf({ run_attempt: 2 })] } } };
  const ok = await decide({ over: { ...two, attempt: { stdoutJson: attemptOf({ run_attempt: 2 }) }, jobs: { stdoutJson: { jobs: [jobOf({ run_attempt: 2 })] } } } });
  assert.equal(ok.output, 'run=false', ok.stdout);
  assert.ok(ok.calls.some((c) => c.includes(`/runs/${RUN_ID}/attempts/2/jobs`)) && !ok.calls.some((c) => c.includes('/attempts/1')), 'attempt 2 only');
  await mustRun({ over: { ...two, attempt: { stdoutJson: attemptOf({ run_attempt: 1 }) } } }, /is not that run's attempt/);
  await mustRun({ over: { ...two, attempt: { stdoutJson: attemptOf({ run_attempt: 2, conclusion: 'failure' }) } } }, /attempt 2 of run 555 is failure, not green/);
  await mustRun({ over: { ...two, attempt: { stdoutJson: attemptOf({ run_attempt: 2 }) } } }, /is not from attempt 2 of run 555/); // job carried over from attempt 1
});

test('no PR run of this head from this repository for this PR -> run', async () => {
  await mustRun({ over: { runs: { stdoutJson: { total_count: 0, workflow_runs: [] } } } }, /RUN: no ci\.yml pull_request run of PR #7/);
  await mustRun({ over: { runs: { stdoutJson: { total_count: 1, workflow_runs: [runOf({ head_repository: { full_name: 'fork/app' } })] } } } }, /RUN: the newest run 555 \(#5\) is not bound to PR #7 from acme\/app/);
  await mustRun({ over: { runs: { stdoutJson: { total_count: 1, workflow_runs: [runOf({ pull_requests: [{ number: 99 }] })] } } } }, /RUN: the newest run 555 \(#5\) is not bound to PR #7 from acme\/app/);
});

// Failure caught: the newest run (failed or still running) lists no pull request yet; filtering by PR before picking the newest
// skipped over it to an older green run bound to PR 7, and the queue reused a result the newest run had already contradicted.
test('a newer run with no pull_requests binding is still the newest: never skipped over to an older bound green run -> run', async () => {
  for (const newer of [{ conclusion: 'failure' }, { status: 'in_progress', conclusion: null }, { conclusion: 'success' }]) {
    const workflow_runs = [runOf(), runOf({ id: 556, run_number: 6, pull_requests: [], ...newer })];
    const r = await mustRun({ over: { runs: { stdoutJson: { total_count: 2, workflow_runs } } } }, /RUN: the newest run 556 \(#6\) is /);
    assert.ok(!r.calls.some((c) => c.includes(`/runs/${RUN_ID}/attempts/`)), 'the older green run is never read');
  }
});

// Failure caught: no recorded merge commit means nothing says which tree the run tested; two entries mean it cannot be told which.
test('the attempt has no proof anchor, two of them, or another PR\'s -> run', async () => {
  const anchor = (n, sha) => ({ path: `acme/app/.github/workflows/proof-anchor.yml@refs/pull/${n}/merge`, sha, ref: `refs/pull/${n}/merge` });
  await mustRun({ over: { attempt: { stdoutJson: attemptOf({ referenced_workflows: [] }) } } }, /has 0 refs\/pull\/\*\/merge entries/);
  await mustRun({ over: { attempt: { stdoutJson: attemptOf({ referenced_workflows: undefined }) } } }, /has no referenced_workflows/);
  await mustRun({ over: { attempt: { stdoutJson: attemptOf({ referenced_workflows: [anchor(NUM, MERGE), anchor(NUM, 'e'.repeat(40))] }) } } }, /has 2 refs\/pull\/\*\/merge entries, expected exactly one/);
  await mustRun({ over: { attempt: { stdoutJson: attemptOf({ referenced_workflows: [anchor(NUM, MERGE), anchor(NUM, MERGE)] }) } } }, /has 2 refs\/pull\/\*\/merge entries/);
  await mustRun({ over: { attempt: { stdoutJson: attemptOf({ referenced_workflows: [anchor(99, MERGE)] }) } } }, /executed refs\/pull\/99\/merge, not refs\/pull\/7\/merge/);
});

// Failure caught: a job that is "success" because its test step was skipped (or the PR run never ran this shard's tests) counts as proof.
test('the job is green but its test step was skipped, failed or missing -> run', async () => {
  for (const steps of [
    [step('Set up job'), step(TEST_STEP, 'skipped'), step(INSTALLER_STEP)],
    [step('Set up job'), step(TEST_STEP, 'failure'), step(INSTALLER_STEP)],
    [step('Set up job'), step(INSTALLER_STEP)],
    [step('Set up job'), step(TEST_STEP), step(TEST_STEP), step(INSTALLER_STEP)],
  ]) {
    await mustRun({ over: { jobs: { stdoutJson: { jobs: [jobOf({ steps })] } } } }, /RUN: step "Tests \(Node 24, shard 2\/2\)" /);
  }
});

// Failure caught: the installer round trip is skipped on its designated shard in the PR run (never checked), yet that shard's job reads green.
test('the installer step is skipped on its designated shard -> run; on another shard it is not required', async () => {
  const noInstaller = [step('Set up job'), step(TEST_STEP), step(INSTALLER_STEP, 'skipped')];
  await mustRun({ over: { jobs: { stdoutJson: { jobs: [jobOf({ steps: noInstaller })] } } } }, /RUN: step "Installer round trip \(Node 24\)" of the PR run did not succeed \(skipped\)/);
  const other = await decide({ env: { SHARD: '1' }, over: { jobs: { stdoutJson: { jobs: [jobOf({ steps: noInstaller })] } } } });
  assert.equal(other.output, 'run=false', other.stdout);
});

test('the job itself failed, was cancelled, is missing or appears twice in that attempt -> run', async () => {
  for (const jobs of [[jobOf({ conclusion: 'failure' })], [jobOf({ conclusion: 'cancelled' })], [jobOf({ conclusion: 'skipped' })], [{ ...jobOf(), name: 'test (ubuntu node 20 2/2)' }], [], [jobOf(), jobOf()]]) {
    await mustRun({ over: { jobs: { stdoutJson: { jobs } } } }, /RUN: (job "test \(ubuntu node 24 2\/2\)" of the PR run is |attempt 1 of run 555 has \d jobs named)/);
  }
});

// Failure caught: the PR changed the workflow, the test runner or the proof code: the PR run's evidence was produced by that very code.
// Failure caught: scripts/test.mjs imports registry-snapshot.mjs -> pipeline/lib/paths.mjs + model-floor.mjs (and their imports) before it launches
// the shard; a PR that changes one of them changes what the PR run's green proves, and the queue reused it unrun.
const importedByTestRunner = ['pipeline/lib/queue-members.mjs', 'pipeline/lib/ci-proof.mjs', 'pipeline/lib/proc.mjs', 'pipeline/lib/shell-words.mjs', 'pipeline/lib/paths.mjs', 'pipeline/lib/model-floor.mjs', 'pipeline/lib/locks.mjs', 'pipeline/lib/seams.mjs', 'pipeline/hooks/lib/owner-go.mjs', 'pipeline/hooks/lib/repo-moves.mjs', 'pipeline/hooks/lib/owner-go-click.mjs', 'pipeline/hooks/lib/live-db-go.mjs', 'pipeline/hooks/lib/db-refs.mjs', 'pipeline/hooks/lib/sql-classify.mjs', 'pipeline/lib/git.mjs', 'pipeline/lib/diff.mjs', 'pipeline/lib/glob.mjs', 'pipeline/lib/resolution.mjs', 'pipeline/lib/remote-url.mjs', 'pipeline/lib/owner-only.mjs', 'pipeline/lib/claude-ancestry.mjs'];
test('the queue commit changes workflow, test runner or proof logic -> run (untouched files are fine)', async () => {
  for (const file of ['.github/workflows/ci.yml', '.github/scripts/queue-reuse.mjs', 'scripts/test.mjs', 'scripts/verify.mjs', 'scripts/lib/shard.mjs', 'package.json', 'package-lock.json', '.gitattributes', ...importedByTestRunner]) {
    await mustRun({ touch: file }, new RegExp(`RUN: the queue commit changes proof logic \\(${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  }
  const unrelated = await decide({ touch: 'pipeline/lib/other.mjs' });
  assert.equal(unrelated.output, 'run=false', unrelated.stdout);
});

test('any API failure or garbled reply -> run, exit 0', async () => {
  for (const key of ['graphql', 'onMain', 'compare', 'pull', 'runs', 'attempt', 'mergeCommit', 'jobs']) {
    const r = await decide({ over: { [key]: 'fail' } });
    assert.equal(r.code, 0, key);
    assert.equal(r.output, 'run=true', `${key}: ${r.stdout}`);
    assert.match(r.stdout, /RUN: /, key);
  }
  assert.equal((await decide({ over: { pull: { stdout: 'not json' } } })).output, 'run=true');
  assert.equal((await decide({ over: { mergeCommit: { stdoutJson: {} } } })).output, 'run=true');
  assert.equal((await decide({ over: { runs: { stdoutJson: {} } } })).output, 'run=true');
  assert.equal((await decide({ env: { TESTED_TREE_GH_ARGV: JSON.stringify(['no-such-gh-binary-xyz']) } })).output, 'run=true');
});

test('missing inputs, a checkout that is not the queue commit, or a queue ref of another branch -> run', async () => {
  await mustRun({ env: { JOB_NAME: '' } }, /RUN: REPO, SHA, BASE_SHA, QUEUE_REF, JOB_NAME and TEST_STEP are required/);
  await mustRun({ noHeadMatch: true }, /RUN: checkout is [0-9a-f]{40}, not the queue commit e{40}/);
  await mustRun({ env: { QUEUE_REF: 'refs/heads/gh-readonly-queue/dev/pr-7-' + 'a'.repeat(40) } }, /RUN: refs\/heads\/gh-readonly-queue\/dev\/.* is not a queue ref of main/);
});

// ---- the step in ci.yml: the BASE copy of the decider runs, never the PR's own ----
const ciText = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
const ci = parseYaml(ciText);
const reuseStep = (job) => job.steps.find((st) => st.id === 'reused');

// Runs the real `run:` text of the step with bash in a clone whose origin has a base commit (with or without the decider) and a
// queue commit whose own queue-reuse.mjs differs: which copy ran shows in the output.
function runReuseStep({ baseHasDecider, staleBase = false, depth = 2 }) {
  const origin = createTmpRepo();
  const decider = (name) => `import { appendFileSync } from 'node:fs';\nconsole.log('decider: ${name}');\nappendFileSync(process.env.GITHUB_OUTPUT, 'run=false\\n');\n`;
  origin.write('pipeline/lib/queue-members.mjs', '// base lib\n');
  origin.write('.github/scripts/tested-tree.mjs', '// push decider\n');
  if (baseHasDecider) origin.write('.github/scripts/queue-reuse.mjs', decider('BASE copy'));
  const older = origin.commit('older than the base');
  origin.write('c.txt', 'base\n');
  const base = origin.commit('base');
  origin.write('.github/scripts/queue-reuse.mjs', decider('PR copy (the queue checkout)'));
  const queue = origin.commit('queue commit with the PR changes');
  const dir = scratchDir();
  const clone = join(dir, 'checkout');
  const git = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  // As actions/checkout does on merge_group (fetch-depth 2): the queue commit and its first parent, and no way back to origin.
  assert.equal(git(['clone', '-q', ...(depth > 0 ? ['--depth', String(depth)] : []), `file://${origin.dir}`, clone], dir).status, 0);
  assert.equal(git(['checkout', '-q', queue], clone).status, 0);
  assert.equal(git(['remote', 'remove', 'origin'], clone).status, 0);
  const temp = join(dir, 'runner temp');
  mkdirSync(temp);
  const out = join(dir, 'output');
  writeFileSync(out, '');
  const r = spawnSync('bash', ['-c', reuseStep(ci.jobs['test-ubuntu-node']).run], {
    cwd: clone, encoding: 'utf8', env: { ...process.env, RUNNER_TEMP: temp, GITHUB_OUTPUT: out, BASE_SHA: staleBase ? older : base },
  });
  return { ...r, output: readFileSync(out, 'utf8').trim() };
}

test('the reuse step runs the decider extracted from the BASE commit, not the queue checkout\'s copy', () => {
  const r = runReuseStep({ baseHasDecider: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /decider: BASE copy/);
  assert.doesNotMatch(r.stdout, /PR copy/);
  assert.equal(r.output, 'run=false');
});

// Failure caught: the very PR that introduces the decider (or any base without it) would run its own copy, or fail the step: it must just run the suite.
test('a base without the decider -> run=true, and the PR\'s own copy is not used', () => {
  const r = runReuseStep({ baseHasDecider: false });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.output, 'run=true');
  assert.match(r.stdout, /RUN: base [0-9a-f]{40} has no queue-reuse decider/);
  assert.doesNotMatch(r.stdout, /PR copy/);
});

// Failure caught: a base_sha that is not the queue commit's first parent (an older main commit, or a parent the checkout lacks)
// would run a decider the queue commit was never built on; the step must answer run, not read it.
test('merge_group base_sha that is not HEAD^1, or a checkout without the parent -> run=true with a reason, no decider run', () => {
  for (const opts of [{ baseHasDecider: true, staleBase: true, depth: 0 }, { baseHasDecider: true, depth: 1 }]) {
    const r = runReuseStep(opts);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.output, 'run=true', JSON.stringify(opts));
    assert.match(r.stdout, /RUN: merge_group base [0-9a-f]{40} is not the first parent of the queue commit/);
    assert.doesNotMatch(r.stdout, /decider: /);
  }
});

// ---- the wiring, for every expanded matrix row ----
const rows = [['test-ubuntu-node', 2], ['test-windows-shard', 7]].flatMap(([id, designated]) => expandJob(ci.jobs[id]).map((row) => ({ ...row, id, designated })));
const GATE_NEW = "github.event_name != 'merge_group' || steps.reused.outputs.run != 'false'";

test('every matrix row has the reuse step: merge_group only, soft-failing, its own job name, the BASE copy under $RUNNER_TEMP/base', () => {
  assert.equal(rows.length, 4 + 7);
  for (const row of rows) {
    const reuse = row.steps.find((st) => st.id === 'reused');
    assert.ok(reuse, `${row.name}: has the reuse step`);
    assert.equal(reuse.if, "github.event_name == 'merge_group'", row.name);
    assert.equal(reuse['continue-on-error'], true, `${row.name}: a crashed decider must not fail the job (the gate then reads run != false)`);
    assert.equal(reuse.env.JOB_NAME, row.name, `${row.name}: JOB_NAME is the job's own display name`);
    assert.equal(reuse.env.QUEUE_REF, '${{ github.event.merge_group.head_ref }}');
    assert.equal(reuse.env.BASE_SHA, '${{ github.event.merge_group.base_sha }}');
    assert.equal(reuse.env.SHA, '${{ github.sha }}');
    assert.equal(reuse.env.REPO, '${{ github.repository }}');
    assert.equal(reuse.env.GH_TOKEN, '${{ github.token }}');
    // the step names it checks are the real step names of this row, and the installer shard is the row the installer really runs on
    const tests = row.steps.find((st) => /node scripts\/test\.mjs/.test(st.run ?? ''));
    assert.equal(reuse.env.TEST_STEP, tests.name, `${row.name}: TEST_STEP`);
    const installer = row.steps.find((st) => String(st.run).includes('installer-round-trip.sh'));
    assert.equal(reuse.env.INSTALLER_STEP, installer.name, `${row.name}: INSTALLER_STEP`);
    assert.equal(Number(reuse.env.INSTALLER_SHARD), row.designated);
    assert.equal(installer.if.startsWith(`matrix.shard == ${row.designated} && `), true, `${row.name}: the installer runs on shard ${row.designated}`);
    assert.equal(reuse.env.SHARD, row.combo.shard === undefined ? undefined : String(row.combo.shard));
    // the decider that runs is the base copy, never a path of the checkout
    assert.match(reuse.run, /git archive "\$BASE_SHA" \.github\/scripts pipeline\/lib \| \(cd "\$base" && tar -x\)/);
    assert.doesNotMatch(reuse.run, /git fetch/, `${row.name}: the base comes from the local checkout, no unauthenticated fetch`);
    assert.match(reuse.run, /git rev-parse -q --verify 'HEAD\^1'.*!= "\$BASE_SHA"/, `${row.name}: base_sha must be HEAD^1`);
    assert.match(reuse.run, /node "\$base\/\.github\/scripts\/queue-reuse\.mjs"/);
    assert.match(reuse.run, /base="\$RUNNER_TEMP\/base"/);
    assert.doesNotMatch(reuse.run, /node \.github\/scripts|node \.\/\.github/, `${row.name}: never the checkout's copy`);
    // it precedes every step it gates, after the checkout that provides HEAD and git
    const at = row.steps.indexOf(reuse);
    const checkout = row.steps.slice(0, at).find((st) => String(st.uses).startsWith('actions/checkout@'));
    assert.ok(checkout, row.name);
    assert.equal(checkout.with['fetch-depth'], "${{ github.event_name == 'merge_group' && 2 || 1 }}", `${row.name}: the queue checkout holds the base commit`);
    assert.ok(row.steps.slice(at + 1).every((st) => !String(st.uses).startsWith('actions/checkout@')));
  }
});

// Failure caught: a test, installer or file-times step that keeps running after a proven reuse (no saving), or one that is skipped when the
// decider said run / was never asked (a skipped suite on a pull_request or an unproven queue commit).
test('merge_group skips the test, installer and file-times steps only on reused == false; pull_request and push never skip on it', () => {
  for (const row of rows) {
    const gated = row.steps.filter((st) => /node scripts\/test\.mjs|installer-round-trip\.sh|CP-FILE-TIMES-BEGIN/.test(st.run ?? '') || String(st.uses).startsWith('actions/setup-node@'));
    assert.equal(gated.length, 4, `${row.name}: Node setup, tests, file times, installer`);
    for (const st of gated) {
      assert.ok(st.if.includes(`(${GATE_NEW})`), `${row.name}: ${st.name}: ${st.if}`);
      // pull_request runs whatever the reuse step output (it never ran there; even a stray 'false' must not skip a PR run)
      const prRuns = stepRuns(st.if, row.combo, { event: 'pull_request' });
      for (const reused of ['true', 'false']) assert.equal(stepRuns(st.if, row.combo, { event: 'pull_request', reused }), prRuns, `${row.name}: ${st.name}: pull_request, reused=${reused}`);
      // merge_group runs it unless the decider proved the reuse (an unset or 'true' answer, e.g. a crashed decider, runs)
      for (const reused of ['', 'true']) assert.equal(stepRuns(st.if, row.combo, { event: 'merge_group', reused }), prRuns, `${row.name}: ${st.name}: merge_group, reused=${JSON.stringify(reused)}`);
      assert.equal(stepRuns(st.if, row.combo, { event: 'merge_group', reused: 'false' }), false, `${row.name}: ${st.name}: a proven reuse skips it`);
      // push keeps its own gate: a stray reuse answer changes nothing there
      assert.equal(stepRuns(st.if, row.combo, { event: 'push', reused: 'false' }), prRuns, `${row.name}: ${st.name}: push`);
      assert.equal(stepRuns(st.if, row.combo, { event: 'push', tested: 'false' }), false, `${row.name}: ${st.name}: the push skip is unchanged`);
    }
  }
});

test('the aggregates keep their names and fail-closed meaning: no reuse step, one step reading the matrix result', () => {
  for (const [id, name, needs] of [['test-ubuntu', 'test (ubuntu)', 'test-ubuntu-node'], ['test-windows', 'test (windows)', 'test-windows-shard']]) {
    const job = ci.jobs[id];
    assert.equal(job.name, name);
    assert.equal(job.needs, needs);
    assert.equal(job.steps.length, 1);
    assert.ok(!JSON.stringify(job).includes('reused'), `${name}: nothing there can be skipped by a reuse answer`);
  }
  const perms = ci.permissions;
  assert.deepEqual(perms, { contents: 'read', actions: 'read', 'pull-requests': 'read' }, 'read-only token');
});

test('the header comment says the queue reuse is proven, from the base copy, with the tree', () => {
  const header = ciText.split(/^name: CI/m)[0];
  assert.match(header, /queue-reuse\.mjs/);
  assert.match(header, /BASE commit's copy/);
  assert.match(header, /equals the queue commit's tree/);
});
