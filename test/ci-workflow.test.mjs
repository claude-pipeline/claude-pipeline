// Structure of .github/workflows/ci.yml, parsed with the vendored YAML reader. What it pins: the required check names in
// .claude/pipeline.yml are real job names, and both suites are split behind an aggregate (Windows: shards behind "test (windows)";
// Ubuntu: Node 20 and 24 jobs, each in shards, behind "test (ubuntu)") that is red (never green or skipped) unless every part succeeded, except on a
// draft PR, where the suite is skipped as a whole (ci.draft_while_iterating). Only a real CI run proves the matrix expands
// and the runners schedule; this guards the wiring that would silently weaken the required check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml } from '../pipeline/lib/yaml.mjs';
import { selectTestFiles } from '../scripts/lib/select-tests.mjs';
import { shardFiles } from '../scripts/lib/shard.mjs';
import { expandJob, stepRuns } from './helpers/ci-matrix.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (rel) => parseYaml(readFileSync(join(root, rel), 'utf8'));
const ci = load('.github/workflows/ci.yml');
const config = load('.claude/pipeline.yml');
const jobs = ci.jobs;
const shardJob = jobs['test-windows-shard'];
const aggregate = jobs['test-windows'];
const nodeJob = jobs['test-ubuntu-node'];
const ubuntuAggregate = jobs['test-ubuntu'];
// The draft skip of the suite (ci.draft_while_iterating): the same condition on both real jobs and, behind always(), on the aggregate.
const NOT_DRAFT = "github.event_name != 'pull_request' || !github.event.pull_request.draft";
// Evaluates one of the `if:` expressions above for an event (no other construct is allowed in them).
const runsOn = (cond, { event, draft = false }) => {
  assert.match(cond, /^[\w.()'!=&| ]+$/, cond);
  // eslint-disable-next-line no-new-func
  return new Function('always', 'github', `return Boolean(${cond.replaceAll('github.event.pull_request.draft', 'github.draft').replaceAll('github.event_name', 'github.event')});`)(() => true, { event, draft });
};

// The check names GitHub shows: a matrix job's name has its ${{ matrix.* }} expressions expanded, one per combination of every matrix key.
const expandedNames = (job) => expandJob(job).map((row) => row.name);
const testsStepOf = (row) => row.steps.find((st) => /node scripts\/test\.mjs/.test(st.run ?? ''));
const nodeOf = (row) => String(row.steps.find((st) => String(st.uses).startsWith('actions/setup-node@')).with['node-version']);

test('every ci.required_checks name in .claude/pipeline.yml is the name of a job in ci.yml', () => {
  const names = Object.values(jobs).flatMap(expandedNames);
  assert.deepEqual(config.ci.required_checks, ['test (ubuntu)', 'test (windows)'], 'branch protection uses these exact names');
  for (const required of config.ci.required_checks) assert.ok(names.includes(required), `no job is named ${JSON.stringify(required)}`);
});

test('job names are unique and no matrix row is named like a required check', () => {
  const live = Object.entries(jobs).filter(([, j]) => j.if !== '${{ false }}'); // proof-anchor never runs and has no name
  const names = live.flatMap(([, j]) => expandedNames(j));
  assert.equal(new Set(names).size, names.length, names.join(' | '));
  assert.equal(expandedNames(shardJob).length, shardJob.strategy.matrix.shard.length, 'a Windows row per shard');
  assert.equal(expandedNames(nodeJob).length, nodeJob.strategy.matrix.node.length * nodeJob.strategy.matrix.shard.length, 'an Ubuntu row per Node version x shard');
  for (const required of config.ci.required_checks) assert.ok(!expandedNames(shardJob).includes(required) && !expandedNames(nodeJob).includes(required), required);
});

// Failure caught: an `exclude`/`include` matrix key makes GitHub drop or add a row the expander would still run (or miss), so the aggregate
// stays green over a shard that never ran.
test('the matrix expander refuses include and exclude keys instead of misreading them as a dimension', () => {
  for (const key of ['include', 'exclude']) {
    assert.throws(() => expandJob({ strategy: { matrix: { shard: [1, 2], [key]: [{ shard: 2 }] } } }), new RegExp(`matrix\\.${key}`));
  }
});

// Failure caught: a matrix row renamed (or a second matrix key added) without its push-skip JOB_NAME following. tested-tree.mjs looks the job
// up by that exact name in the PR run, finds none, and every push to main re-runs the suite (or the skip silently never applies).
test('each expanded row display name equals its push-skip JOB_NAME', () => {
  for (const job of [shardJob, nodeJob]) {
    for (const row of expandJob(job)) {
      const skip = row.steps.find((st) => String(st.run).includes('tested-tree.mjs'));
      assert.ok(skip, `${row.name}: has the push-skip step`);
      assert.equal(skip.env.JOB_NAME, row.name);
    }
  }
});

test('the shard job runs on Windows with Node 24 and does not cancel its siblings', () => {
  assert.equal(shardJob['runs-on'], 'windows-latest');
  assert.equal(shardJob['timeout-minutes'], 45);
  assert.equal(shardJob.strategy['fail-fast'], false);
  const node = shardJob.steps.filter((s) => String(s.uses).startsWith('actions/setup-node@'));
  assert.equal(node.length, 1);
  assert.equal(node[0].with['node-version'], 24);
});

// The `--shard I/N` each expanded row actually runs, per OS and Node version: one N, and I = 1..N exactly once.
const shardsOf = (job) => {
  const byNode = new Map();
  for (const row of expandJob(job)) {
    const step = testsStepOf(row);
    assert.ok(step, `${row.name}: runs the suite`);
    const m = /--shard (\d+)\/(\d+)\b/.exec(step.run);
    assert.ok(m, `${row.name}: ${step.run} has no --shard I/N`);
    const node = nodeOf(row);
    if (!byNode.has(node)) byNode.set(node, []);
    byNode.get(node).push({ name: row.name, i: Number(m[1]), n: Number(m[2]) });
  }
  return byNode;
};
const allTestFiles = () => {
  const dir = join(root, 'test');
  return selectTestFiles(readdirSync(dir), []).names.map((name) => ({ name, size: statSync(join(dir, name)).size }));
};

// Failures caught: a 4-row matrix whose command says I/5 (bin 5 is never run: its files are untested, the aggregate is still green), and a
// duplicated row (a bin runs twice, another is missing).
for (const [what, job] of [['Windows', shardJob], ['Ubuntu', nodeJob]]) {
  test(`${what}: for every Node version the rows' --shard I/N commands use one N and cover I = 1..N exactly once`, () => {
    const byNode = shardsOf(job);
    assert.ok(byNode.size >= 1);
    for (const [node, rows] of byNode) {
      const n = rows[0].n;
      assert.ok(n >= 2, `Node ${node}: sharded`);
      assert.ok(rows.every((r) => r.n === n), `Node ${node}: one N: ${rows.map((r) => r.name + ' ' + r.i + '/' + r.n).join(', ')}`);
      assert.deepEqual(rows.map((r) => r.i).sort((a, b) => a - b), Array.from({ length: n }, (_, k) => k + 1), `Node ${node}`);
    }
  });

  // Failure caught: the bins computed with the real file list overlap or leave a file out, so a test file is run by no shard (or twice).
  test(`${what}: the bins of the real test file list are disjoint and together are every test file`, () => {
    const files = allTestFiles();
    const weights = JSON.parse(readFileSync(join(root, 'scripts', 'lib', 'test-weights.json'), 'utf8'));
    for (const [node, rows] of shardsOf(job)) {
      const seen = new Map();
      for (const r of rows) for (const name of shardFiles(files, r.i, r.n, weights)) {
        assert.ok(!seen.has(name), `Node ${node}: ${name} runs in ${seen.get(name)} and ${r.name}`);
        seen.set(name, r.name);
      }
      assert.deepEqual([...seen.keys()].sort(), files.map((f) => f.name).sort(), `Node ${node}: a file no shard runs`);
    }
  });
}

test('each Windows shard records per-file times and prints them between marker lines even when the tests failed', () => {
  const tests = testsStepOf({ steps: shardJob.steps });
  assert.equal(tests.env.CP_TEST_TIMES, '${{ runner.temp }}/cp-file-times.json');
  const print = shardJob.steps.find((s) => String(s.run).includes('CP-FILE-TIMES-BEGIN'));
  assert.ok(print, 'a step prints the times');
  assert.equal(print.env.CP_TEST_TIMES, tests.env.CP_TEST_TIMES, 'it reads the file the tests wrote');
  assert.match(print.if, /^always\(\) && /, 'a red shard still reports its times');
  assert.ok(shardJob.steps.indexOf(print) > shardJob.steps.indexOf(tests));
  assert.ok(print.run.indexOf('CP-FILE-TIMES-BEGIN') < print.run.indexOf('CP-FILE-TIMES-END'));
  assert.equal(print.shell, undefined, 'no step overrides the workflow-wide bash default (self-verify)');
});

// Failure caught: the round trip's `if` matching no row (the installer is never checked) or several (it runs twice into the same
// claude-home path on one runner). Evaluated against every expanded row, on a pull_request and on a push that did not skip.
const installerRows = (job, event, tested) => expandJob(job).filter((row) => {
  const installer = row.steps.filter((s) => String(s.run).includes('installer-round-trip.sh'));
  assert.equal(installer.length, 1, row.name);
  return stepRuns(installer[0].if, row.combo, { event, tested });
});
test('the installer round trip runs on exactly one Windows row, and on exactly one row per Ubuntu Node version', () => {
  for (const [event, tested] of [['pull_request', ''], ['merge_group', ''], ['push', ''], ['push', 'true']]) {
    assert.equal(installerRows(shardJob, event, tested).length, 1, `Windows ${event}`);
    const rows = installerRows(nodeJob, event, tested);
    assert.deepEqual(rows.map((r) => r.combo.node).sort((a, b) => a - b), [...nodeJob.strategy.matrix.node].sort((a, b) => a - b), `Ubuntu ${event}: one row per Node version`);
  }
  // a push whose tree already passed (the skip step answers 'false') skips the round trip with the rest of the job
  assert.equal(installerRows(shardJob, 'push', 'false').length, 0);
  assert.equal(installerRows(nodeJob, 'push', 'false').length, 0);
  for (const row of expandJob(nodeJob)) {
    const installer = row.steps.find((s) => String(s.run).includes('installer-round-trip.sh'));
    assert.ok(installer.run.includes(`claude home ${row.combo.node}`), `${row.name}: a claude-home path per Node version`);
  }
});

test('test (windows) aggregates the shard job: needs it, runs always (but on a draft PR), on ubuntu', () => {
  assert.equal(aggregate.name, 'test (windows)');
  assert.equal(aggregate.needs, 'test-windows-shard');
  assert.equal(aggregate.if, `always() && (${NOT_DRAFT})`, 'without always() a failed shard would skip the aggregate, and a skipped required check can pass; the only other condition is the draft skip of the shards');
  assert.equal(aggregate['runs-on'], 'ubuntu-latest');
  assert.equal(aggregate.steps.length, 1, 'one step: nothing can succeed independently of the shard result');
  assert.ok(!aggregate.steps[0].if, 'the step has no condition of its own that could skip it');
  assert.equal(aggregate.steps[0].env.SHARDS_RESULT, '${{ needs.test-windows-shard.result }}');
  assert.match(aggregate.steps[0].run, /"\$SHARDS_RESULT" = "success"/);
});

test('the aggregate step exits 0 only for a result of exactly "success"', () => {
  const script = aggregate.steps[0].run;
  for (const [result, want] of [['success', 0], ['failure', 1], ['cancelled', 1], ['skipped', 1], ['', 1]]) {
    const r = spawnSync('bash', ['-c', script], { env: { ...process.env, SHARDS_RESULT: result }, encoding: 'utf8' });
    assert.equal(r.status, want, `result ${JSON.stringify(result)}: exit ${r.status} ${r.stderr}`);
  }
});

test('the Ubuntu Node job runs Node 20 and 24, each sharded, in parallel and does not cancel its siblings', () => {
  assert.equal(nodeJob['runs-on'], 'ubuntu-latest');
  assert.equal(nodeJob['timeout-minutes'], 45);
  assert.equal(nodeJob.strategy['fail-fast'], false);
  assert.deepEqual(nodeJob.strategy.matrix.node, [20, 24]);
  const node = nodeJob.steps.filter((s) => String(s.uses).startsWith('actions/setup-node@'));
  assert.equal(node.length, 1);
  assert.equal(node[0].with['node-version'], '${{ matrix.node }}');
  assert.equal(nodeJob.steps.filter((s) => /node scripts\/test\.mjs/.test(s.run ?? '')).length, 1, 'one suite step');
});

// Failure caught: an aggregate that needs another job (or none) goes green without the matrix having run.
test('each aggregate needs exactly its own matrix job and reads the result of that job', () => {
  for (const [agg, matrixId] of [[aggregate, 'test-windows-shard'], [ubuntuAggregate, 'test-ubuntu-node']]) {
    assert.equal(agg.needs, matrixId);
    assert.ok(Object.keys(jobs[agg.needs].strategy.matrix).length >= 1, `${agg.name}: ${matrixId} is a matrix job`);
    assert.ok(JSON.stringify(agg.steps[0].env).includes(`needs.${matrixId}.result`), agg.name);
  }
});

test('test (ubuntu) aggregates the Node job: needs it, runs always (but on a draft PR), on ubuntu, one unconditional step', () => {
  assert.equal(ubuntuAggregate.name, 'test (ubuntu)');
  assert.equal(ubuntuAggregate.needs, 'test-ubuntu-node');
  assert.equal(ubuntuAggregate.if, `always() && (${NOT_DRAFT})`, 'without always() a failed Node job would skip the aggregate, and a skipped required check can pass; the only other condition is the draft skip');
  assert.equal(ubuntuAggregate['runs-on'], 'ubuntu-latest');
  assert.equal(ubuntuAggregate['timeout-minutes'], 5);
  assert.equal(ubuntuAggregate.steps.length, 1, 'one step: nothing can succeed independently of the Node jobs result');
  assert.ok(!ubuntuAggregate.steps[0].if, 'the step has no condition of its own that could skip it');
  assert.equal(ubuntuAggregate.steps[0].env.NODES_RESULT, '${{ needs.test-ubuntu-node.result }}');
  assert.match(ubuntuAggregate.steps[0].run, /"\$NODES_RESULT" = "success"/);
});

test('the test (ubuntu) step exits 0 only for a result of exactly "success"', () => {
  const script = ubuntuAggregate.steps[0].run;
  for (const [result, want] of [['success', 0], ['failure', 1], ['cancelled', 1], ['skipped', 1], ['', 1]]) {
    const r = spawnSync('bash', ['-c', script], { env: { ...process.env, NODES_RESULT: result }, encoding: 'utf8' });
    assert.equal(r.status, want, `result ${JSON.stringify(result)}: exit ${r.status} ${r.stderr}`);
  }
});

test('the CI proof for `tests` still points at the ubuntu aggregate (green only when every Node job and shard passed)', () => {
  assert.equal(config.verify.ci_proof.tests.job, 'test (ubuntu)');
  assert.equal(jobs['test-ubuntu'].name, 'test (ubuntu)');
  assert.equal(jobs['test-ubuntu'].needs, 'test-ubuntu-node');
});

test('ci.yml listens to ready_for_review and converted_to_draft, and one PR\'s runs share one cancelling group', () => {
  // a bare `pull_request:` has neither: the default types are opened, synchronize, reopened
  assert.deepEqual(ci.on.pull_request.types, ['opened', 'synchronize', 'reopened', 'ready_for_review', 'converted_to_draft']);
  assert.deepEqual(ci.on.push.branches, ['main']);
  assert.deepEqual(ci.on.merge_group.types, ['checks_requested'], 'without this trigger the merge queue never gets a result for the required checks');
  assert.equal(ci.concurrency.group, 'ci-${{ github.ref }}', 'every event of one PR has the same ref, so converted_to_draft cancels a running suite');
  assert.equal(ci.concurrency['cancel-in-progress'], "${{ github.event_name == 'pull_request' }}", 'push to main never cancels');
});

test('a draft PR skips the whole suite (both required checks read skipped); a ready PR and a push to main run it', () => {
  assert.equal(nodeJob.if, NOT_DRAFT);
  assert.equal(shardJob.if, NOT_DRAFT);
  for (const [name, cond] of [['ubuntu node', nodeJob.if], ['ubuntu aggregate', ubuntuAggregate.if], ['shard', shardJob.if], ['windows aggregate', aggregate.if]]) {
    assert.equal(runsOn(cond, { event: 'pull_request', draft: true }), false, `${name}: a draft PR (also the converted_to_draft run) is skipped`);
    assert.equal(runsOn(cond, { event: 'pull_request', draft: false }), true, `${name}: a ready PR (also the ready_for_review run) runs`);
    assert.equal(runsOn(cond, { event: 'push' }), true, `${name}: push to main is unchanged`);
    assert.equal(runsOn(cond, { event: 'merge_group' }), true, `${name}: a queue commit runs the suite, never skipped (a skipped required check counts as passing)`);
  }
});
