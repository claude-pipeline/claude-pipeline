// Read-only CI baseline: node scripts/ci-baseline.mjs [K] [--json]
// For the last K merged PRs of this repo (default 20), from `gh` GET calls only (nothing is written, nothing is re-run):
//   ready -> both required checks green on the PR   (first ready_for_review, else PR creation; latest passing "test (ubuntu)" and "test (windows)" on the final head)
//   queue entry -> queue run green                  (the last added_to_merge_queue event to the end of the merge_group run of that PR)
//   ready -> merged
//   runner wait                                     (per job: created_at -> started_at, over the PR's runs on the final head and its queue run; the table shows the longest)
//   re-runs                                         (sum of run_attempt - 1 over those runs)
//   queue bounces                                   (removed_from_merge_queue events before the merge)
// All times are UTC (ISO strings in --json); the table shows minutes. Run it from a clone of the repo (gh uses its remote).
import { spawnSync } from 'node:child_process';

// The only way this script talks to GitHub. `gh api` is a GET unless a method or a body flag turns it into a write, so those are refused here.
const gh = (args) => {
  const writes = args.some((a) => /^(-X|--method|-f|-F|--field|--raw-field|--input)$/.test(a) || /^--method=/.test(a));
  if (writes || !['api', 'pr', 'repo'].includes(args[0])) throw new Error(`refusing a non-read gh call: gh ${args.join(' ')}`);
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`gh ${args.join(' ')} failed: ${(r.stderr || r.error?.message || '').trim().split('\n')[0]}`);
  return r.stdout;
};
const ghJson = (args) => JSON.parse(gh(args));
// A paginated GET: --slurp wraps the pages in one array.
const ghPages = (path) => ghJson(['api', '--paginate', '--slurp', path]).flat();

const REQUIRED = ['test (ubuntu)', 'test (windows)'];
const ms = (iso) => (iso ? Date.parse(iso) : NaN);
const minutes = (from, to) => (Number.isFinite(ms(from)) && Number.isFinite(ms(to)) ? Math.round(((ms(to) - ms(from)) / 60000) * 10) / 10 : null);
const median = (xs) => {
  const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : Math.round(((v[mid - 1] + v[mid]) / 2) * 10) / 10;
};

const repo = ghJson(['repo', 'view', '--json', 'nameWithOwner']).nameWithOwner;
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const rest = args.filter((a) => a !== '--json');
const k = rest.length === 0 ? 20 : Number(rest[0]);
if (rest.length > 1 || !Number.isInteger(k) || k < 1) {
  console.error('usage: node scripts/ci-baseline.mjs [K] [--json]');
  process.exit(2);
}

// The workflow runs of one PR: the pull_request runs on its final head and its merge_group runs (the queue branch is gh-readonly-queue/<base>/pr-<N>-<sha>).
function runsOf(n, headSha, queueRuns) {
  const onHead = ghJson(['api', `repos/${repo}/actions/runs?head_sha=${headSha}&per_page=100`]).workflow_runs ?? [];
  return [...onHead, ...queueRuns.filter((r) => new RegExp(`/pr-${n}-`).test(r.head_branch ?? ''))];
}

const merged = ghJson(['pr', 'list', '--state', 'merged', '--limit', String(k), '--json', 'number,title,createdAt,mergedAt,headRefOid']);
const queueRuns = ghJson(['api', `repos/${repo}/actions/runs?event=merge_group&per_page=100`]).workflow_runs ?? [];

const rows = merged.map((pr) => {
  const timeline = ghPages(`repos/${repo}/issues/${pr.number}/timeline?per_page=100`);
  const at = (event) => timeline.filter((e) => e.event === event).map((e) => e.created_at).sort();
  const readyAt = at('ready_for_review')[0] ?? pr.createdAt;
  const added = at('added_to_merge_queue');
  // GitHub also records a removal at the moment the queue merges the PR; only a removal before that is a bounce
  const bounces = at('removed_from_merge_queue').filter((t) => t < pr.mergedAt).length;
  const checks = ghJson(['api', `repos/${repo}/commits/${pr.headRefOid}/check-runs?per_page=100`]).check_runs ?? [];
  // the latest passing run of each required check on the final head; both must exist
  const greenAt = REQUIRED.map((name) => checks.filter((c) => c.name === name && c.conclusion === 'success').map((c) => c.completed_at).sort().pop() ?? null);
  const bothGreen = greenAt.every(Boolean) ? greenAt.sort().pop() : null;
  const runs = runsOf(pr.number, pr.headRefOid, queueRuns);
  const queueRun = runs.filter((r) => r.event === 'merge_group' && r.conclusion === 'success').sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))[0];
  const jobWaits = [];
  for (const run of runs) {
    for (const job of (ghJson(['api', `repos/${repo}/actions/runs/${run.id}/jobs?filter=all&per_page=100`]).jobs ?? [])) {
      jobWaits.push({ run: run.id, job: job.name, queuedAt: job.created_at, startedAt: job.started_at, waitMin: minutes(job.created_at, job.started_at) });
    }
  }
  return {
    pr: pr.number, title: pr.title, readyAt, mergedAt: pr.mergedAt,
    readyToChecksGreenMin: minutes(readyAt, bothGreen),
    queueEnteredAt: added.at(-1) ?? null, queueRunGreenAt: queueRun?.updated_at ?? null,
    queueToGreenMin: minutes(added.at(-1), queueRun?.updated_at),
    readyToMergedMin: minutes(readyAt, pr.mergedAt),
    maxRunnerWaitMin: jobWaits.every((j) => j.waitMin === null) ? null : Math.max(...jobWaits.map((j) => j.waitMin ?? 0)),
    reruns: runs.reduce((sum, r) => sum + Math.max(0, (r.run_attempt ?? 1) - 1), 0),
    queueBounces: bounces,
    jobWaits,
  };
});

const medians = {
  readyToChecksGreenMin: median(rows.map((r) => r.readyToChecksGreenMin)),
  queueToGreenMin: median(rows.map((r) => r.queueToGreenMin)),
  readyToMergedMin: median(rows.map((r) => r.readyToMergedMin)),
  maxRunnerWaitMin: median(rows.map((r) => r.maxRunnerWaitMin)),
  jobRunnerWaitMin: median(rows.flatMap((r) => r.jobWaits.map((j) => j.waitMin))),
  reruns: median(rows.map((r) => r.reruns)),
  queueBounces: median(rows.map((r) => r.queueBounces)),
};

if (asJson) {
  console.log(JSON.stringify({ repo, count: rows.length, timesAreUtc: true, medians, prs: rows }, null, 2));
} else {
  const cell = (v) => (v === null || v === undefined ? '-' : String(v));
  const head = ['PR', 'ready UTC', 'ready>green', 'queue>green', 'ready>merged', 'max wait', 'reruns', 'bounces'];
  const table = rows.map((r) => [`#${r.pr}`, (r.readyAt ?? '').replace('T', ' ').replace(/:\d\dZ$/, 'Z'), r.readyToChecksGreenMin, r.queueToGreenMin, r.readyToMergedMin, r.maxRunnerWaitMin, r.reruns, r.queueBounces].map(cell));
  table.push(['median', '', medians.readyToChecksGreenMin, medians.queueToGreenMin, medians.readyToMergedMin, medians.maxRunnerWaitMin, medians.reruns, medians.queueBounces].map(cell));
  const widths = head.map((h, c) => Math.max(h.length, ...table.map((row) => row[c].length)));
  const line = (row) => row.map((v, c) => v.padEnd(widths[c])).join('  ').trimEnd();
  console.log(`${repo}: last ${rows.length} merged PRs (minutes; times UTC; "-" = not observed)`);
  console.log(line(head));
  for (const row of table) console.log(line(row));
  console.log(`median job runner wait over every job: ${cell(medians.jobRunnerWaitMin)} min`);
}
