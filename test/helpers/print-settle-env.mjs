// Child for test/test-runner.test.mjs (#472 Task 1): imports the module named by argv[2] (a file path) and prints PIPELINE_CLICK_SETTLE as it is afterwards.
import { pathToFileURL } from 'node:url';

await import(pathToFileURL(process.argv[2]).href);
console.log(`SETTLE=${process.env.PIPELINE_CLICK_SETTLE ?? '(unset)'}`);
