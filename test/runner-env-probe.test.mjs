// Probe for test/test-runner.test.mjs (#472 Task 1): the runner must hand every test file PIPELINE_CLICK_SETTLE=off. It prints what it was given and always passes; the assertion is the runner test's.
// With CP_PROBE_NEST=1 it also plays a test that runs a nested scripts/test.mjs with the environment it was given (as test-runner.test.mjs does), after a pause that lets
// the other files of the outer run finish first, so the runner test can check that the nested run leaves the outer run's timing data alone.
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

test('prints the PIPELINE_CLICK_SETTLE the runner gave this file', () => {
  console.log(`PROBE PIPELINE_CLICK_SETTLE=${process.env.PIPELINE_CLICK_SETTLE ?? '(unset)'}`);
});

test('CP_PROBE_NEST=1: runs a nested scripts/test.mjs with the inherited environment', async () => {
  if (process.env.CP_PROBE_NEST !== '1') return;
  await sleep(2000);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.CP_PROBE_NEST;
  const runner = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'test.mjs');
  const r = spawnSync(process.execPath, [runner, 'glob.test.mjs'], { encoding: 'utf8', env });
  if (r.status !== 0) throw new Error(r.stdout + r.stderr);
});
