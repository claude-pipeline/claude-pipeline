// Decides whether a push-to-main CI job can be skipped because this exact code already passed the same job.
// Prints the evidence and writes `run=true|false` to $GITHUB_OUTPUT. It only ever answers `false` when one of the two paths
// below proves it; any doubt or error answers `true` (fail open toward running), and the exit code is always 0.
//
// Path A, tried first (merge queue): a completed, successful `merge_group` run of this workflow, from this repository, on the
//   pushed commit's own sha has a job with the SAME name as this one that concluded `success`. The queue fast-forwards main to the
//   exact commit its merge_group run tested, so the same sha means the same tree: no tree, PR or compare check is needed.
//   Any miss or error here is logged as `merge_group: <reason>` and path B runs.
//
// Path B (pull_request), every check must hold:
//   1. the pushed commit has exactly one associated PR, merged, with base `main`;
//   2. that PR head commit's tree is byte-identical to the pushed commit's tree;
//   3. the PR head contains the commit main was at just before this push, so the PR run's merge-ref checkout
//      (refs/pull/N/merge = head + base at the time) had the same tree as the head itself;
//   4. a completed run of this workflow (event pull_request) on the PR head sha has a job with the SAME name as
//      this one that concluded `success` (any attempt).
//
// Env: REPO (owner/name), SHA (pushed commit), JOB_NAME (this job's display name), GH_TOKEN (read by gh),
//      GITHUB_OUTPUT (optional), WORKFLOW_FILE (default ci.yml), BASE_BRANCH (default main),
//      TESTED_TREE_GH_ARGV (tests only: JSON array standing in for ["gh"], e.g. ["node","fake-gh.mjs"]).
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const { REPO, SHA, JOB_NAME, GITHUB_OUTPUT } = process.env;
const WORKFLOW_FILE = process.env.WORKFLOW_FILE || 'ci.yml';
const BASE_BRANCH = process.env.BASE_BRANCH || 'main';
const ghArgv = process.env.TESTED_TREE_GH_ARGV ? JSON.parse(process.env.TESTED_TREE_GH_ARGV) : ['gh'];

class Run extends Error {}
const mustRun = (why) => { throw new Run(why); };

function capture(argv) {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) mustRun(`${argv.join(' ')}: ${r.error.message}`);
  if (r.status !== 0) mustRun(`${argv.join(' ')} exited ${r.status}: ${(r.stderr || '').trim().slice(0, 200)}`);
  return r.stdout.trim();
}

function api(endpoint) {
  const out = capture([...ghArgv, 'api', endpoint]);
  try { return JSON.parse(out); } catch { return mustRun(`${endpoint}: reply is not JSON`); }
}

// Every job of a run, following the listing's pages: a run with many attempts (each attempt lists all of its jobs) spills past one
// page of 100, and a passed job that sat on a later page would be missed (the push-skip then re-runs the suite: safe but slow).
const JOBS_PER_PAGE = 100;
const MAX_JOB_PAGES = 20;
function runJobs(runId) {
  const all = [];
  for (let page = 1; page <= MAX_JOB_PAGES; page++) {
    const jobs = api(`repos/${REPO}/actions/runs/${runId}/jobs?filter=all&per_page=${JOBS_PER_PAGE}&page=${page}`).jobs;
    if (!Array.isArray(jobs)) mustRun(`run ${runId}: no jobs list`);
    all.push(...jobs);
    if (jobs.length < JOBS_PER_PAGE) return all;
  }
  return all;
}

// Path A. Returns the evidence line, or throws (a Run with the reason, or any other error) when it proves nothing.
function mergeGroupEvidence() {
  const runs = api(`repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?head_sha=${SHA}&event=merge_group&per_page=100`).workflow_runs;
  if (!Array.isArray(runs)) mustRun('no workflow_runs list');
  for (const wr of runs) {
    if (wr.status !== 'completed' || wr.conclusion !== 'success' || wr.event !== 'merge_group' || wr.head_sha !== SHA) continue;
    if (wr.head_repository?.full_name !== REPO) continue;
    const jobs = runJobs(wr.id);
    const ok = jobs.find((j) => j.name === JOB_NAME && j.conclusion === 'success');
    if (ok) return `evidence: run ${wr.id} (${wr.html_url ?? 'no url'}) job "${JOB_NAME}" concluded ${ok.conclusion} in the merge_group run on ${SHA}`;
  }
  return mustRun(`no completed successful ${WORKFLOW_FILE} merge_group run of ${SHA} from ${REPO} has a successful "${JOB_NAME}" job`);
}

// Returns which evidence proved the skip ('merge_group' or 'pull_request'); throws Run when none did.
function decide() {
  if (!REPO || !SHA || !JOB_NAME) mustRun('REPO, SHA and JOB_NAME are required');
  try {
    console.log(mergeGroupEvidence());
    return 'merge_group';
  } catch (e) {
    console.log(`merge_group: ${e instanceof Run ? e.message : `unexpected error: ${e?.message ?? e}`}`);
  }
  const tree = capture(['git', 'rev-parse', 'HEAD^{tree}']);
  console.log(`pushed commit ${SHA} tree ${tree}`);

  const pulls = api(`repos/${REPO}/commits/${SHA}/pulls`);
  if (!Array.isArray(pulls) || pulls.length !== 1) mustRun(`expected exactly one associated PR, got ${Array.isArray(pulls) ? pulls.length : 'a non-list'}`);
  const pr = pulls[0];
  if (!pr.merged_at) mustRun(`PR #${pr.number} is not merged`);
  if (pr.base?.ref !== BASE_BRANCH) mustRun(`PR #${pr.number} base is ${pr.base?.ref}, not ${BASE_BRANCH}`);
  const head = pr.head?.sha;
  if (!/^[0-9a-f]{40}$/.test(head || '')) mustRun(`PR #${pr.number} has no head sha`);

  const headTree = api(`repos/${REPO}/git/commits/${head}`).tree?.sha;
  console.log(`PR #${pr.number} head ${head} tree ${headTree}`);
  if (!headTree || headTree !== tree) mustRun('tree differs from the PR head tree (PR branch was not up to date at merge, or the merge changed content)');

  const parent = api(`repos/${REPO}/commits/${SHA}`).parents?.[0]?.sha;
  if (!parent) mustRun('pushed commit has no parent');
  const status = api(`repos/${REPO}/compare/${parent}...${head}`).status;
  console.log(`PR head vs previous main ${parent}: ${status}`);
  if (status !== 'ahead' && status !== 'identical') mustRun(`PR head does not contain previous main (compare status ${status})`);

  const runs = api(`repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?head_sha=${head}&event=pull_request&per_page=100`).workflow_runs;
  if (!Array.isArray(runs)) mustRun('no workflow_runs list');
  for (const wr of runs) {
    if (wr.status !== 'completed') continue;
    const jobs = runJobs(wr.id);
    const ok = jobs.find((j) => j.name === JOB_NAME && j.conclusion === 'success');
    if (ok) {
      console.log(`evidence: run ${wr.id} (${wr.html_url ?? 'no url'}) job "${JOB_NAME}" concluded ${ok.conclusion} on PR head ${head}`);
      return 'pull_request';
    }
  }
  return mustRun(`no completed ${WORKFLOW_FILE} pull_request run of ${head} has a successful "${JOB_NAME}" job`);
}

let run = true;
try {
  const via = decide();
  run = false;
  console.log(via === 'merge_group' ? 'SKIP: this exact commit already passed this job in the merge queue' : 'SKIP: this exact tree already passed this job on the PR');
} catch (e) {
  console.log(`RUN: ${e instanceof Run ? e.message : `unexpected error: ${e?.message ?? e}`}`);
}
if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `run=${run}\n`);
process.exitCode = 0;
