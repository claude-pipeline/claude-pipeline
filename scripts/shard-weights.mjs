// Refreshes scripts/lib/test-weights.json from CI: node scripts/shard-weights.mjs <run-id> [<run-id> ...]
// Each run's Windows shard jobs ("test (windows I/N)") print their per-file times between CP-FILE-TIMES-BEGIN/END marker lines
// (.github/workflows/ci.yml, set up by CP_TEST_TIMES in scripts/test.mjs), with a manifest block of the files the job was given.
// This reads those blocks with `gh`, accepts each run only if validateRun (scripts/lib/file-times.mjs) says the whole run is
// there (every shard concluded success, every file measured once), takes the median ms per file over the accepted runs and writes
// the weights file that scripts/test.mjs --shard balances by. A run that fails any check is rejected as a whole (the reason goes
// to stderr), never merged in part. Only the Windows jobs feed the weights; the Ubuntu jobs print times too, for measurement only.
// Run it from a clone of the repo (gh uses its remote); nothing is pushed.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractManifest, extractTimes, medianWeights, validateRun } from './lib/file-times.mjs';

const out = join(dirname(fileURLToPath(import.meta.url)), 'lib', 'test-weights.json');
const gh = (args) => {
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`gh ${args.join(' ')} failed: ${(r.stderr || r.error?.message || '').trim().split('\n')[0]}`);
  return r.stdout;
};

const runs = process.argv.slice(2);
if (runs.length === 0 || runs.some((r) => !/^\d+$/.test(r))) {
  console.error('usage: node scripts/shard-weights.mjs <run-id> [<run-id> ...]');
  process.exit(2);
}
const measured = [];
for (const run of runs) {
  const listed = JSON.parse(gh(['run', 'view', run, '--json', 'jobs'])).jobs.filter((j) => /^test \(windows \d+\/\d+\)$/.test(j.name));
  const jobs = listed.map((job) => {
    // a job that did not succeed is passed on without its log: validateRun rejects the run for it
    if (job.conclusion !== 'success') return { name: job.name, conclusion: job.conclusion, times: null, manifest: null };
    const log = gh(['run', 'view', run, '--log', '--job', String(job.databaseId)]);
    return { name: job.name, conclusion: job.conclusion, times: extractTimes(log), manifest: extractManifest(log) };
  });
  const verdict = validateRun(jobs);
  if (!verdict.ok) { console.error(`run ${run}: rejected, ${verdict.reason}`); continue; }
  console.log(`run ${run}: ${Object.keys(verdict.times).length} files`);
  measured.push(verdict.times);
}
if (measured.length === 0) {
  console.error('nothing measured; the weights file is unchanged');
  process.exit(1);
}
const weights = medianWeights(measured);
writeFileSync(out, `${JSON.stringify(weights, null, 2)}\n`);
console.log(`wrote ${Object.keys(weights).length} weights (median of ${measured.length} run${measured.length === 1 ? '' : 's'}) to ${out}`);
