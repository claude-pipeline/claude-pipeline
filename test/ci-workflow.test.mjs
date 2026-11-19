// Structure of .github/workflows/ci.yml, parsed with the vendored YAML reader. What it pins: the required check names in
// .claude/pipeline.yml are real job names, and both suites are split behind an aggregate (Windows: three shards behind "test (windows)";
// Ubuntu: Node 20 and 24 jobs behind "test (ubuntu)") that is red (never green or skipped) unless every part succeeded, except on a
// draft PR, where the suite is skipped as a whole (ci.draft_while_iterating). Only a real CI run proves the matrix expands
// and the runners schedule; this guards the wiring that would silently weaken the required check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml } from '../pipeline/lib/yaml.mjs';

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

// The check names GitHub shows: a matrix job's name has its ${{ matrix.* }} expressions expanded, one per combination.
const expandedNames = (job) => {
  const keys = Object.keys(job.strategy?.matrix ?? {});
  if (keys.length === 0) return [job.name];
  assert.equal(keys.length, 1, 'one matrix dimension: the Windows shard or the Ubuntu Node version');
  assert.ok(['shard', 'node'].includes(keys[0]), keys[0]);
  return job.strategy.matrix[keys[0]].map((v) => job.name.replace(`\${{ matrix.${keys[0]} }}`, String(v)));
};

test('every ci.required_checks name in .claude/pipeline.yml is the name of a job in ci.yml', () => {
  const names = Object.values(jobs).flatMap(expandedNames);
  assert.deepEqual(config.ci.required_checks, ['test (ubuntu)', 'test (windows)'], 'branch protection uses these exact names');
  for (const required of config.ci.required_checks) assert.ok(names.includes(required), `no job is named ${JSON.stringify(required)}`);
});

test('job names are unique and no shard is named like a required check', () => {
  const live = Object.entries(jobs).filter(([, j]) => j.if !== '${{ false }}'); // proof-anchor never runs and has no name
  const names = live.flatMap(([, j]) => expandedNames(j));
  assert.equal(new Set(names).size, names.length, names.join(' | '));
  assert.deepEqual(expandedNames(shardJob), ['test (windows 1/3)', 'test (windows 2/3)', 'test (windows 3/3)']);
  assert.deepEqual(expandedNames(nodeJob), ['test (ubuntu node 20)', 'test (ubuntu node 24)']);
  for (const required of config.ci.required_checks) assert.ok(!expandedNames(shardJob).includes(required) && !expandedNames(nodeJob).includes(required), required);
});

test('the shard job runs shards 1..3 of 3 on Windows with Node 24 and does not cancel its siblings', () => {
  assert.equal(shardJob['runs-on'], 'windows-latest');
  assert.equal(shardJob.strategy['fail-fast'], false);
  assert.deepEqual(shardJob.strategy.matrix.shard, [1, 2, 3]);
  const runs = shardJob.steps.map((s) => s.run).filter(Boolean);
  assert.ok(runs.includes('node scripts/test.mjs --shard ${{ matrix.shard }}/3'), runs.join('\n'));
  const node = shardJob.steps.filter((s) => String(s.uses).startsWith('actions/setup-node@'));
  assert.equal(node.length, 1);
  assert.equal(node[0].with['node-version'], 24);
});

test('each Windows shard records per-file times and prints them between marker lines even when the tests failed', () => {
  const tests = shardJob.steps.find((s) => s.run === 'node scripts/test.mjs --shard ${{ matrix.shard }}/3');
  assert.equal(tests.env.CP_TEST_TIMES, '${{ runner.temp }}/cp-file-times.json');
  const print = shardJob.steps.find((s) => String(s.run).includes('CP-FILE-TIMES-BEGIN'));
  assert.ok(print, 'a step prints the times');
  assert.equal(print.env.CP_TEST_TIMES, tests.env.CP_TEST_TIMES, 'it reads the file the tests wrote');
  assert.match(print.if, /^always\(\) && /, 'a red shard still reports its times');
  assert.ok(shardJob.steps.indexOf(print) > shardJob.steps.indexOf(tests));
  assert.ok(print.run.indexOf('CP-FILE-TIMES-BEGIN') < print.run.indexOf('CP-FILE-TIMES-END'));
  assert.equal(print.shell, undefined, 'no step overrides the workflow-wide bash default (self-verify)');
});

test('the installer round trip runs on Windows in shard 3 only', () => {
  const installer = shardJob.steps.filter((s) => String(s.run).includes('installer-round-trip.sh'));
  assert.equal(installer.length, 1);
  assert.match(installer[0].if, /^matrix\.shard == 3 && \(/);
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

test('the Ubuntu Node job runs the whole suite on Node 20 and 24 in parallel, does not cancel its sibling, and each runs the installer round trip', () => {
  assert.equal(nodeJob['runs-on'], 'ubuntu-latest');
  assert.equal(nodeJob['timeout-minutes'], 45);
  assert.equal(nodeJob.strategy['fail-fast'], false);
  assert.deepEqual(nodeJob.strategy.matrix.node, [20, 24]);
  const node = nodeJob.steps.filter((s) => String(s.uses).startsWith('actions/setup-node@'));
  assert.equal(node.length, 1);
  assert.equal(node[0].with['node-version'], '${{ matrix.node }}');
  assert.equal(nodeJob.steps.filter((s) => s.run === 'node scripts/test.mjs').length, 1, 'the full suite, no shard');
  const installer = nodeJob.steps.filter((s) => String(s.run).includes('installer-round-trip.sh'));
  assert.equal(installer.length, 1);
  assert.ok(installer[0].run.includes('claude home ${{ matrix.node }}'), 'a home per Node version');
  assert.ok(!installer[0].if || !/matrix\./.test(installer[0].if), 'it runs for every Node version');
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

test('the CI proof for `tests` still points at the ubuntu aggregate (green only when both Node jobs passed)', () => {
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
