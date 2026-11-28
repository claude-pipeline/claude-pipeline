// Expands a ci.yml job's strategy.matrix the way GitHub does (every combination of every matrix key), so the CI contract tests
// check the rows that really run: their display names, their push-skip JOB_NAME, their `--shard I/N` command and their `if:`.
import assert from 'node:assert/strict';

// One row per combination: { combo, name, steps } with every ${{ matrix.<key> }} in the job name and the steps filled in.
export function expandJob(job) {
  const matrix = job.strategy?.matrix ?? {};
  let combos = [{}];
  for (const key of Object.keys(matrix)) {
    assert.ok(key !== 'include' && key !== 'exclude', `matrix.${key} changes which rows GitHub runs; this expander does not model it`);
    assert.ok(Array.isArray(matrix[key]), `matrix.${key} is a list`);
    combos = combos.flatMap((combo) => matrix[key].map((value) => ({ ...combo, [key]: value })));
  }
  const fill = (text, combo) => text.replace(/\$\{\{ matrix\.(\w+) \}\}/g, (whole, key) => {
    assert.ok(key in combo, `${whole} names a matrix key the job does not have`);
    return String(combo[key]);
  });
  return combos.map((combo) => ({
    combo,
    name: job.name === undefined ? undefined : fill(job.name, combo), // a job that only `uses:` a reusable workflow has neither name nor steps
    steps: JSON.parse(fill(JSON.stringify(job.steps ?? []), combo)),
  }));
}

// Evaluates a step's `if:` for one row: only matrix.<key>, github.event_name, steps.tested.outputs.run (the push-skip answer) and
// steps.reused.outputs.run (the merge-queue reuse answer) are allowed.
export function stepRuns(cond, combo, { event = 'pull_request', tested = '', reused = '' } = {}) {
  if (cond === undefined) return true;
  const expr = cond
    .replace(/matrix\.(\w+)/g, (whole, key) => {
      assert.ok(key in combo, `${whole} in "${cond}"`);
      return JSON.stringify(combo[key]);
    })
    .replaceAll('github.event_name', JSON.stringify(event))
    .replaceAll('steps.tested.outputs.run', JSON.stringify(tested))
    .replaceAll('steps.reused.outputs.run', JSON.stringify(reused));
  assert.match(expr, /^[\w"'.()!=&| ]+$/, cond);
  // eslint-disable-next-line no-new-func
  return Boolean(new Function('always', `return (${expr});`)(() => true)); // always() is true here: only the event and step outputs are modelled
}
