// Decides whether a merge-queue (merge_group) CI job can skip its test steps because a pull_request run of the SAME job already
// passed on a byte-identical tree. Prints one evidence line per check and writes `run=true|false` to $GITHUB_OUTPUT. It only ever
// answers `false` when every check below holds; any doubt or error answers `true` (fail open toward running), exit code always 0.
//
// TRUST: this file runs from the BASE commit of the queue (ci.yml extracts .github/scripts + pipeline/lib of merge_group.base_sha
// into $RUNNER_TEMP/base and runs that copy), never from the queue checkout, which contains the PR's own changes. The git commands
// below still run in the queue checkout (cwd): its HEAD is the queue commit. They go through pipeline/lib/proc.mjs (the BASE copy,
// next to this file), which on Windows looks `git` / `gh` up from the temp dir, never the checkout: a git.exe or gh.exe the PR
// plants in its own tree is not run.
//
// Every check must hold:
//   1. QUEUE_REF is a queue ref of the default branch for PR N on BASE_SHA, and `queueManifest` (pipeline/lib/queue-members.mjs,
//      GitHub's own queue-entry records) shows exactly ONE member, PR N, with head H (a batch or an unreadable queue means run);
//   2. PR N is open, into the default branch, its head is H and comes from this repository (no fork);
//   3. the diff BASE_SHA..SHA (the queue commit) touches none of PROOF_LOGIC: the workflow, test runner and proof code that
//      produced the PR run's evidence must be the ones this base trusts;
//   4. the NEWEST pull_request run of the workflow on H (this repository, PR N) is completed and green, and its LATEST attempt is
//      the one read (a newer failed / cancelled / running run or attempt is never skipped over for an older passing one);
//   5. that attempt's referenced_workflows has exactly one entry, refs/pull/N/merge, naming merge commit M, and M's tree equals the
//      queue commit's tree (a moved merge ref or an advanced main shows up as a different tree);
//   6. in that attempt the job named JOB_NAME succeeded, its test step (TEST_STEP) succeeded (not skipped), and on the installer's
//      designated shard (SHARD == INSTALLER_SHARD) the installer step (INSTALLER_STEP) succeeded too.
//
// Env: REPO (owner/name), SHA (queue commit), BASE_SHA, QUEUE_REF, JOB_NAME (this job's display name), TEST_STEP, SHARD,
//      INSTALLER_STEP + INSTALLER_SHARD (both optional), GH_TOKEN (read by gh), GITHUB_OUTPUT (optional),
//      WORKFLOW_FILE (default ci.yml), BASE_BRANCH (default main),
//      TESTED_TREE_GH_ARGV (tests only: JSON array standing in for ["gh"], e.g. ["node","fake-gh.mjs"]).
import { appendFileSync } from 'node:fs';
import { run as runCommand } from '../../pipeline/lib/proc.mjs';
import { parseQueueRef, queueManifest } from '../../pipeline/lib/queue-members.mjs';

const { REPO, SHA, BASE_SHA, QUEUE_REF, JOB_NAME, TEST_STEP, SHARD, INSTALLER_STEP, INSTALLER_SHARD, GITHUB_OUTPUT } = process.env;
const WORKFLOW_FILE = process.env.WORKFLOW_FILE || 'ci.yml';
const BASE_BRANCH = process.env.BASE_BRANCH || 'main';
const ghArgv = process.env.TESTED_TREE_GH_ARGV ? JSON.parse(process.env.TESTED_TREE_GH_ARGV) : ['gh'];
const SHA40 = /^[0-9a-f]{40}$/;

// What the PR run's evidence depends on besides the tree: any change here and the queue run must produce its own evidence.
const PROOF_LOGIC = {
  prefixes: ['.github/', 'scripts/lib/'],
  // Plus the static import closure of scripts/test.mjs outside scripts/lib/ (traced: test.mjs -> scripts/lib/registry-snapshot.mjs ->
  // pipeline/lib/paths.mjs + model-floor.mjs -> ...): code that runs before the shard launches, so a change there changes what a
  // green PR run proves. Each entry says who imports it.
  files: [
    'scripts/test.mjs', 'scripts/verify.mjs', 'package.json', 'package-lock.json', '.gitattributes',
    'pipeline/lib/queue-members.mjs', // the queue-entry reader this decider itself imports
    'pipeline/lib/ci-proof.mjs', // the proof checks the PR run is judged by
    'pipeline/lib/proc.mjs', // this decider imports it (git / gh launcher), and git.mjs below imports it
    'pipeline/lib/shell-words.mjs', // imported by proc.mjs
    'pipeline/lib/paths.mjs', // scripts/lib/registry-snapshot.mjs imports it, and scripts/test.mjs imports that before it launches the shard
    'pipeline/lib/model-floor.mjs', // scripts/lib/registry-snapshot.mjs imports it (same chain as paths.mjs)
    'pipeline/lib/locks.mjs', // imported by model-floor.mjs
    'pipeline/lib/seams.mjs', // imported by model-floor.mjs and proc.mjs
    'pipeline/hooks/lib/owner-go.mjs', // imported by model-floor.mjs
    'pipeline/hooks/lib/repo-moves.mjs', // imported by owner-go.mjs
    'pipeline/hooks/lib/owner-go-click.mjs', // imported by owner-go.mjs
    'pipeline/hooks/lib/live-db-go.mjs', // imported by owner-go-click.mjs
    'pipeline/hooks/lib/db-refs.mjs', // imported by live-db-go.mjs
    'pipeline/hooks/lib/sql-classify.mjs', // imported by live-db-go.mjs
    'pipeline/lib/git.mjs', // imported by live-db-go.mjs
    'pipeline/lib/diff.mjs', // imported by git.mjs
    'pipeline/lib/glob.mjs', // imported by diff.mjs
    'pipeline/lib/resolution.mjs', // imported by git.mjs
    'pipeline/lib/remote-url.mjs', // imported by live-db-go.mjs
    'pipeline/lib/owner-only.mjs', // imported by db-refs.mjs
    'pipeline/lib/claude-ancestry.mjs', // imported by owner-only.mjs
  ],
};

class Run extends Error {}
const mustRun = (why) => { throw new Run(why); };

function capture(argv) {
  const r = runCommand(argv[0], argv.slice(1), { maxBuffer: 64 * 1024 * 1024 });
  if (r.code !== 0) mustRun(`${argv.join(' ')} exited ${r.code}: ${r.stderr.trim().slice(0, 200)}`);
  return r.stdout.trim();
}

function api(endpoint) {
  const out = capture([...ghArgv, 'api', endpoint]);
  try { return JSON.parse(out); } catch { return mustRun(`${endpoint}: reply is not JSON`); }
}

// The two readers queueManifest takes (as the vendored queue poster builds them): REST text through --jq, and GraphQL.
const read = (endpoint, jq) => capture([...ghArgv, 'api', endpoint, '--jq', jq]);
const graphql = (query, variables = {}) => JSON.parse(capture([...ghArgv, 'api', 'graphql', '-f', `query=${query}`, ...Object.entries(variables).flatMap(([k, v]) => ['-f', `${k}=${v}`])]));

const JOBS_PER_PAGE = 100;
const MAX_JOB_PAGES = 20;
function attemptJobs(runId, attempt) {
  const all = [];
  for (let page = 1; page <= MAX_JOB_PAGES; page++) {
    const jobs = api(`repos/${REPO}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=${JOBS_PER_PAGE}&page=${page}`).jobs;
    if (!Array.isArray(jobs)) mustRun(`run ${runId} attempt ${attempt}: no jobs list`);
    all.push(...jobs);
    if (jobs.length < JOBS_PER_PAGE) return all;
  }
  return mustRun(`run ${runId} attempt ${attempt}: more than ${MAX_JOB_PAGES * JOBS_PER_PAGE} jobs`);
}

const isTouched = (file) => PROOF_LOGIC.files.includes(file) || PROOF_LOGIC.prefixes.some((p) => file.startsWith(p));

function stepOnce(job, name) {
  const hits = (Array.isArray(job.steps) ? job.steps : []).filter((s) => s?.name === name);
  if (hits.length !== 1) mustRun(`step "${name}" is ${hits.length === 0 ? 'not in' : `listed ${hits.length} times in`} job "${job.name}" of the PR run`);
  if (hits[0].status !== 'completed' || hits[0].conclusion !== 'success') mustRun(`step "${name}" of the PR run did not succeed (${hits[0].conclusion ?? hits[0].status ?? 'no conclusion'})`);
  return hits[0];
}

// Returns when every check holds (evidence logged); throws Run with the reason otherwise.
function decide() {
  if (!REPO || !SHA40.test(SHA || '') || !SHA40.test(BASE_SHA || '') || !QUEUE_REF || !JOB_NAME || !TEST_STEP) mustRun('REPO, SHA, BASE_SHA, QUEUE_REF, JOB_NAME and TEST_STEP are required');
  const head = capture(['git', 'rev-parse', 'HEAD']);
  if (head !== SHA) mustRun(`checkout is ${head}, not the queue commit ${SHA}`);

  // 1. exactly one queued PR
  const parsed = parseQueueRef(QUEUE_REF, BASE_BRANCH);
  if (!parsed) mustRun(`${QUEUE_REF} is not a queue ref of ${BASE_BRANCH}`);
  if (parsed.baseSha !== BASE_SHA) mustRun(`queue ref names base ${parsed.baseSha}, the event says ${BASE_SHA}`);
  const q = queueManifest({ read, graphql, repo: REPO, defaultBranch: BASE_BRANCH, queueSha: SHA, queueRef: QUEUE_REF });
  if (!q.ok) mustRun(`queue: ${q.reason}`);
  const { members, base } = q.manifest;
  if (members.length !== 1) mustRun(`queue commit holds ${members.length} PRs (a batch is never reused)`);
  const [member] = members;
  if (member.pr !== parsed.pr || base !== BASE_SHA) mustRun(`queue member #${member.pr} on ${base} is not #${parsed.pr} on ${BASE_SHA}`);
  const prNumber = member.pr;
  const headSha = member.head;
  console.log(`queue: single member PR #${prNumber}, head ${headSha}, base ${BASE_SHA}`);

  // 2. the PR itself
  const pr = api(`repos/${REPO}/pulls/${prNumber}`);
  if (pr.state !== 'open') mustRun(`PR #${prNumber} is ${pr.state}, not open`);
  if (pr.base?.ref !== BASE_BRANCH) mustRun(`PR #${prNumber} base is ${pr.base?.ref}, not ${BASE_BRANCH}`);
  if (pr.head?.sha !== headSha) mustRun(`PR #${prNumber} head is ${pr.head?.sha}, the queue entry has ${headSha}`);
  if (pr.head?.repo?.full_name !== REPO) mustRun(`PR #${prNumber} head is from ${pr.head?.repo?.full_name ?? 'an unknown repository'}, not ${REPO}`);
  console.log(`PR #${prNumber}: open, into ${BASE_BRANCH}, head ${headSha} from ${REPO}`);

  // 3. proof logic unchanged
  const changed = capture(['git', 'diff', '--name-only', '-z', '--no-renames', BASE_SHA, SHA]).split('\0').filter(Boolean);
  const touched = changed.filter(isTouched);
  if (touched.length > 0) mustRun(`the queue commit changes proof logic (${touched.slice(0, 5).join(', ')}): the PR run's evidence came from that code`);
  console.log(`diff ${BASE_SHA.slice(0, 7)}..${SHA.slice(0, 7)}: ${changed.length} file(s), none of them workflow, test runner or proof logic`);

  // 4. newest PR run, latest attempt
  const listing = api(`repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?head_sha=${headSha}&event=pull_request&per_page=100`);
  const all = listing.workflow_runs;
  if (!Array.isArray(all)) mustRun('no workflow_runs list');
  if (Number.isInteger(listing.total_count) && listing.total_count > all.length) mustRun(`the run listing is incomplete (${all.length} of ${listing.total_count})`);
  // The newest run on the head is picked FIRST; only then must that run be bound to PR N and this repository (a newer run whose
  // pull_requests is empty is the newest, never skipped over for an older bound one).
  const candidates = all.filter((r) => r?.head_sha === headSha && r.event === 'pull_request');
  if (candidates.length === 0) mustRun(`no ${WORKFLOW_FILE} pull_request run of PR #${prNumber} on ${headSha}`);
  if (candidates.some((r) => !Number.isInteger(r.id) || !Number.isInteger(r.run_number) || !Number.isInteger(r.run_attempt) || r.run_attempt < 1)) mustRun('a listed run lacks id, run_number or run_attempt');
  const top = Math.max(...candidates.map((r) => r.run_number));
  const tops = candidates.filter((r) => r.run_number === top);
  if (tops.length !== 1) mustRun(`runs ${tops.map((r) => r.id).join(' and ')} share run number ${top}`);
  const [newest] = tops;
  if (!newest.pull_requests?.some?.((p) => p?.number === prNumber) || newest.head_repository?.full_name !== REPO) mustRun(`the newest run ${newest.id} (#${newest.run_number}) is not bound to PR #${prNumber} from ${REPO}`);
  if (newest.status !== 'completed' || newest.conclusion !== 'success') mustRun(`the newest run ${newest.id} (#${newest.run_number}) is ${newest.status === 'completed' ? newest.conclusion : newest.status}, not a green completed run`);
  const attempt = api(`repos/${REPO}/actions/runs/${newest.id}/attempts/${newest.run_attempt}`);
  if (attempt.id !== newest.id || attempt.run_attempt !== newest.run_attempt || attempt.head_sha !== headSha || attempt.event !== 'pull_request') mustRun(`attempt ${newest.run_attempt} of run ${newest.id} is not that run's attempt on ${headSha}`);
  if (attempt.status !== 'completed' || attempt.conclusion !== 'success') mustRun(`attempt ${newest.run_attempt} of run ${newest.id} is ${attempt.status === 'completed' ? attempt.conclusion : attempt.status}, not green`);
  console.log(`evidence: run ${newest.id} (${newest.html_url ?? 'no url'}) attempt ${newest.run_attempt} is the newest pull_request run on ${headSha} and concluded success`);

  // 5. the tree that attempt tested
  if (!Array.isArray(attempt.referenced_workflows)) mustRun(`attempt ${newest.run_attempt} of run ${newest.id} has no referenced_workflows`);
  const anchors = attempt.referenced_workflows.filter((w) => typeof w?.ref === 'string' && /^refs\/pull\/[^/]+\/merge$/.test(w.ref));
  if (anchors.length !== 1) mustRun(`attempt ${newest.run_attempt} of run ${newest.id} has ${anchors.length} refs/pull/*/merge entries, expected exactly one`);
  if (anchors[0].ref !== `refs/pull/${prNumber}/merge`) mustRun(`attempt ${newest.run_attempt} of run ${newest.id} executed ${anchors[0].ref}, not refs/pull/${prNumber}/merge`);
  const mergeCommit = anchors[0].sha;
  if (!SHA40.test(mergeCommit || '')) mustRun(`attempt ${newest.run_attempt} of run ${newest.id} names no merge commit`);
  const theirs = api(`repos/${REPO}/git/commits/${mergeCommit}`).tree?.sha;
  const queueTree = capture(['git', 'rev-parse', 'HEAD^{tree}']);
  if (!SHA40.test(theirs || '')) mustRun(`GitHub did not return the tree of merge commit ${mergeCommit}`);
  if (theirs !== queueTree) mustRun(`the PR run tested merge commit ${mergeCommit}, tree ${theirs}; the queue commit's tree is ${queueTree}`);
  console.log(`evidence: merge commit ${mergeCommit} of refs/pull/${prNumber}/merge has tree ${theirs}, identical to the queue commit's tree`);

  // 6. this job, its test step (and the installer on its shard), in that exact attempt
  const named = attemptJobs(newest.id, newest.run_attempt).filter((j) => j?.name === JOB_NAME);
  if (named.length !== 1) mustRun(`attempt ${newest.run_attempt} of run ${newest.id} has ${named.length} jobs named "${JOB_NAME}", expected exactly one`);
  const [job] = named;
  if (job.run_id !== newest.id || job.run_attempt !== newest.run_attempt || job.head_sha !== headSha) mustRun(`job "${JOB_NAME}" is not from attempt ${newest.run_attempt} of run ${newest.id} on ${headSha}`);
  if (job.status !== 'completed' || job.conclusion !== 'success') mustRun(`job "${JOB_NAME}" of the PR run is ${job.status === 'completed' ? job.conclusion : job.status}, not success`);
  stepOnce(job, TEST_STEP);
  const installer = Boolean(INSTALLER_STEP) && INSTALLER_SHARD !== undefined && INSTALLER_SHARD !== '' && SHARD === INSTALLER_SHARD;
  if (installer) stepOnce(job, INSTALLER_STEP);
  console.log(`evidence: job "${JOB_NAME}" concluded success, step "${TEST_STEP}" succeeded${installer ? `, step "${INSTALLER_STEP}" succeeded` : ''}`);
}

let run = true;
try {
  decide();
  run = false;
  console.log('SKIP: this exact tree already passed this job on the PR');
} catch (e) {
  console.log(`RUN: ${e instanceof Run ? e.message : `unexpected error: ${e?.message ?? e}`}`);
}
if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `run=${run}\n`);
process.exitCode = 0;
