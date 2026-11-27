// Read-only CI baseline: node scripts/ci-baseline.mjs [K] [--json]
// For the last K PRs merged in this repo (default 20, newest merge first), from reads only (nothing is written, nothing is re-run): `gh` REST GETs, plus the
// pipeline's queueEvents reader (pipeline/lib/github.mjs), which reads the queue history with a GraphQL query (a POST that only reads):
//   ready -> both required checks green on the PR   (first ready_for_review, else PR creation; latest passing "test (ubuntu)" and "test (windows)" on the final head)
//   queue entry -> queue run green                  (the last queue entry to when an attempt of the ci.yml merge_group run of that entry finished green, before the merge)
//   ready -> merged
//   runner wait                                     (per job: created_at -> started_at, over the PR's ci.yml pull_request runs on the final head and its queue run, skipped jobs left out, nothing after the merge; the table shows the longest)
//   re-runs                                         (per run, its highest attempt before the merge minus 1, summed over those runs)
//   queue bounces                                   (queue removals whose reason is not "merged")
// All times are UTC (ISO strings in --json); the table shows minutes. Run it from a clone of the repo (gh uses its remote).
import { spawnSync } from 'node:child_process';
import { createGitHub } from '../pipeline/lib/github.mjs';

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

const SEARCH_CAP = 1000; // GitHub search (PR lists, filtered workflow-run lists) returns at most 1000 results across all pages
const WORKFLOW = 'ci.yml'; // the one workflow whose runs are measured (as .github/scripts/tested-tree.mjs reads it)
const gh_ = createGitHub({ cwd: process.cwd() });

// The last K PRs by MERGE time. `gh pr list` cannot sort by merge time, so list by last update (a PR is never updated before it merged, so every PR
// merged after the K-th newest merge has been updated after it too), sort by mergedAt, and widen the list until its tail is older than that cutoff.
function lastMerged(count) {
  for (let limit = Math.max(count * 3, 30); ; limit *= 2) {
    const list = ghJson(['pr', 'list', '--state', 'merged', '--limit', String(limit), '--search', 'sort:updated-desc', '--json', 'number,title,createdAt,mergedAt,updatedAt,headRefOid']);
    const byMerge = [...list].sort((a, b) => (a.mergedAt < b.mergedAt ? 1 : a.mergedAt > b.mergedAt ? -1 : 0));
    const top = byMerge.slice(0, count);
    const cutoff = top.at(-1)?.mergedAt;
    // complete when its least recently updated PR was updated before the cutoff (nothing further down can have merged after it), or the list ran out
    if (top.length === count && list.at(-1).updatedAt < cutoff) return top;
    // a search lists at most 1000 PRs: a list that long may be cut, so "ran out" is not proven and the cutoff is not either
    if (list.length >= SEARCH_CAP) throw new Error(`the ${SEARCH_CAP} most recently updated merged PRs do not reach back past the ${count}th newest merge: GitHub search lists at most ${SEARCH_CAP} results, so use a smaller K`);
    if (list.length < limit) return top;
  }
}

// Every page of a runs/checks/jobs GET, never just the first. GitHub caps a filtered list at 1000 results and says so only in total_count:
// fewer rows than that count means the list was cut, and a baseline built on it would be silently short, so fail instead.
function ghAll(path, key) {
  const pages = ghJson(['api', '--paginate', '--slurp', path]);
  const rows = pages.flatMap((page) => page[key] ?? []);
  const total = pages[0]?.total_count;
  if (Number.isFinite(total) && total > rows.length) throw new Error(`GitHub lists ${total} ${key} for ${path} but returned ${rows.length} (it caps a search at ${SEARCH_CAP} results): use a smaller K`);
  return rows;
}

const merged = lastMerged(k);
// the merge-queue runs of the whole sample in one read, bounded to the days the sample covers
const since = merged.map((pr) => pr.createdAt).sort()[0]?.slice(0, 10);
const queueRuns = ghAll(`repos/${repo}/actions/workflows/${WORKFLOW}/runs?event=merge_group&created=%3E%3D${since}&per_page=100`, 'workflow_runs');

const rows = merged.map((pr) => {
  const timeline = ghPages(`repos/${repo}/issues/${pr.number}/timeline?per_page=100`);
  const readyAt = timeline.filter((e) => e.event === 'ready_for_review').map((e) => e.created_at).sort()[0] ?? pr.createdAt;
  // the queue history comes from the pipeline's own reader (order and removal reason): the removal GitHub records at the merge itself has reason "merged" and is not a bounce
  const queue = gh_.queueEvents(pr.number);
  const lastEntry = queue.filter((e) => e.type === 'added').map((e) => e.at).sort().at(-1) ?? null;
  const bounces = queue.filter((e) => e.type === 'removed' && e.reason !== 'merged').length;
  // Everything below ignores activity after the merge (a re-run started later, for instance, is not part of how long this PR took).
  const before = (iso) => Boolean(iso) && iso <= pr.mergedAt;
  const checks = ghAll(`repos/${repo}/commits/${pr.headRefOid}/check-runs?filter=all&per_page=100`, 'check_runs');
  // the latest passing run of each required check on the final head (filter=all: a check re-run after the merge must not hide the one before it); both must exist
  const greenAt = REQUIRED.map((name) => checks.filter((c) => c.name === name && c.conclusion === 'success' && before(c.completed_at)).map((c) => c.completed_at).sort().pop() ?? null);
  const bothGreen = greenAt.every(Boolean) ? greenAt.sort().pop() : null;
  // the pull_request runs of ci.yml on the final head, and the merge_group run of this PR's last queue entry that passed
  const headRuns = ghAll(`repos/${repo}/actions/workflows/${WORKFLOW}/runs?head_sha=${pr.headRefOid}&event=pull_request&per_page=100`, 'workflow_runs').filter((r) => before(r.created_at)); // created_at never changes across attempts (run_started_at does); the per-job cutoff below drops a later attempt
  // the queue runs of this PR's last entry; a run's current conclusion and updated_at belong to its latest attempt, so when it went green is read from its jobs below
  const queueCandidates = queueRuns.filter((r) => new RegExp(`/pr-${pr.number}-`).test(r.head_branch ?? '') && lastEntry && r.created_at >= lastEntry && before(r.created_at));
  const jobWaits = [];
  let reruns = 0;
  let queueGreenAt = null;
  for (const run of [...headRuns, ...queueCandidates]) {
    // filter=all: the jobs of every attempt, so a re-run's wait counts too; a job that started after the merge belongs to a later re-run
    const jobs = ghAll(`repos/${repo}/actions/runs/${run.id}/jobs?filter=all&per_page=100`, 'jobs').filter((j) => before(j.started_at));
    reruns += Math.max(1, ...jobs.map((j) => j.run_attempt ?? 1)) - 1;
    if (run.event === 'merge_group') {
      // an attempt is green when every one of its jobs finished (before the merge) as success or skipped; it went green when its last job ended
      for (const attempt of new Set(jobs.map((j) => j.run_attempt ?? 1))) {
        const mine = jobs.filter((j) => (j.run_attempt ?? 1) === attempt);
        if (!mine.every((j) => (j.conclusion === 'success' || j.conclusion === 'skipped') && before(j.completed_at))) continue;
        const end = mine.map((j) => j.completed_at).sort().pop();
        if (!queueGreenAt || end > queueGreenAt) queueGreenAt = end;
      }
    }
    for (const job of jobs) {
      if (job.conclusion === 'skipped') continue; // never asked for a runner (proof-anchor, the draft-era run): not a wait
      jobWaits.push({ run: run.id, job: job.name, queuedAt: job.created_at, startedAt: job.started_at, waitMin: minutes(job.created_at, job.started_at) });
    }
  }
  return {
    pr: pr.number, title: pr.title, readyAt, mergedAt: pr.mergedAt,
    readyToChecksGreenMin: minutes(readyAt, bothGreen),
    queueEnteredAt: lastEntry, queueRunGreenAt: queueGreenAt,
    queueToGreenMin: minutes(lastEntry, queueGreenAt),
    readyToMergedMin: minutes(readyAt, pr.mergedAt),
    maxRunnerWaitMin: jobWaits.every((j) => j.waitMin === null) ? null : Math.max(...jobWaits.map((j) => j.waitMin ?? 0)),
    reruns,
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
