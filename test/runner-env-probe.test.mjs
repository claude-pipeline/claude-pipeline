// Probe for test/test-runner.test.mjs (#472 Task 1): the runner must hand every test file PIPELINE_CLICK_SETTLE=off. It prints what it was given and always passes; the assertion is the runner test's.
import { test } from 'node:test';

test('prints the PIPELINE_CLICK_SETTLE the runner gave this file', () => {
  console.log(`PROBE PIPELINE_CLICK_SETTLE=${process.env.PIPELINE_CLICK_SETTLE ?? '(unset)'}`);
});
