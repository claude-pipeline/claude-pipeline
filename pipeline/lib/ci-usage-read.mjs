// The reading half of `pipeline ci-usage`: what to ask GitHub, in what order, and within which budget. Everything is read through the injected `gh` (createGitHub: `gh.api(method, path)`),
// by repository slug (so --repo-slug may name a repository other than the one gh resolves from the current directory), and handed to the pure classifier (lib/ci-usage.mjs).
// A run goes to a PR only through its own `pull_requests` link; a pull_request run GitHub did not link is counted on its own (`classifyRuns` with `unlinked: true`), never matched to a PR by its branch.
// Read-only. The call budget is `--max-calls` GitHub calls (one per page) plus a stop when the rate limit is nearly spent; running out is `partial: true` with the skipped
// counts, never a failure. Only the first list (repository, workflow runs) failing is a failure (GhError: the caller maps it to exit 3).
import { MAX_PAGES, PAGE, pages } from './gh-pages.mjs';
import {
  HEAVY_ELAPSED_MS, UNEXCLUDABLE, aggregateUsage, analysePrUsage, classifierVersion, classifyRuns, elapsedMs,
} from './ci-usage.mjs';
import { parseYaml } from './yaml.mjs';
import { asciiLine } from './triage.mjs';

// Below this many calls left of the hourly limit nothing more is read (the limit is shared by every session of the machine).
export const MIN_REMAINING = 1000;
export const RATE_CHECK_EVERY = 50;
// The reads of the PRs stop at this share of --max-calls, so the jobs of the biggest runs (the cost) are always read too.
export const PR_SHARE = 0.6;

class BudgetStop extends Error {}

// Counts GitHub calls and decides when to stop. `tick()` is called before every page read; it throws BudgetStop once `limit` (default: all of --max-calls) is used or the rate limit is low.
export function makeBudget(gh, { maxCalls, warnings, label }) {
  let calls = 0;
  let rate = null;
  let rateWarned = false;
  let reason = null;
  const readRate = () => {
    try {
      const r = gh.api('GET', 'rate_limit');
      const core = r?.resources?.core ?? r?.rate;
      if (core && Number.isFinite(core.remaining)) rate = { remaining: core.remaining, limit: core.limit ?? null, reset: core.reset ?? null };
    } catch (err) {
      if (!rateWarned) warnings.push(`${label}: the rate limit could not be read (${asciiLine(err?.message, 100)}): reading on without it`);
      rateWarned = true;
    }
  };
  readRate();
  return {
    get calls() { return calls; },
    get rate() { return rate; },
    get reason() { return reason; },
    lowRate: () => rate !== null && rate.remaining < MIN_REMAINING,
    // `limit`: stop at this many calls instead of maxCalls (the PR reads).
    tick(limit = maxCalls) {
      if (calls >= Math.min(limit, maxCalls)) { reason ??= 'max-calls'; throw new BudgetStop('max-calls'); }
      if (rate !== null && rate.remaining < MIN_REMAINING) { reason ??= 'rate-limit'; throw new BudgetStop('rate-limit'); }
      calls += 1;
      if (calls % RATE_CHECK_EVERY === 0) readRate();
    },
    // A read that must happen (the first list): counted, never stopped.
    count() { calls += 1; },
    stop: BudgetStop,
  };
}

// ci.draft_while_iterating of the repository's own .claude/pipeline.yml on its default branch: true | false | 'unknown'. A config without the setting is false (its default).
function readDraftFlag(gh, slug, budget, warnings) {
  try {
    budget.count();
    const file = gh.api('GET', `repos/${slug}/contents/.claude/pipeline.yml`);
    const text = Buffer.from(String(file?.content ?? ''), file?.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
    const flag = parseYaml(text)?.ci?.draft_while_iterating;
    if (flag === undefined) return false;
    if (typeof flag === 'boolean') return flag;
    warnings.push(`${slug}: ci.draft_while_iterating in .claude/pipeline.yml is not a boolean: missed redrafts are unknown`);
  } catch (err) {
    warnings.push(`${slug}: .claude/pipeline.yml could not be read (${asciiLine(err?.message, 100)}): ci.draft_while_iterating is unknown, so missed redrafts are not reported (pushes while ready still are)`);
  }
  return 'unknown';
}

// -> the repository's result (see docs/cli.md#ci-usage). `sinceMs`: UTC ms; `workflows`: names or file paths to keep (empty = all); `rates`: per-OS USD per minute overrides.
export function readRepoUsage({ gh, slug, sinceMs, workflows = [], maxCalls, rates = {}, viewer = null, warnings }) {
  const sinceIso = `${new Date(sinceMs).toISOString().slice(0, 19)}Z`;
  const warn = (m) => warnings.push(`${slug}: ${m}`);
  const budget = makeBudget(gh, { maxCalls, warnings, label: slug });
  const skipped = { prs: 0, jobs: 0 };

  // the first list: if GitHub cannot be reached for these, the whole command is "unavailable"
  budget.count();
  const repo = gh.api('GET', `repos/${slug}`);
  const isPrivate = repo?.private === true;
  const draftWhileIterating = readDraftFlag(gh, slug, budget, warnings);
  let totalCount = null;
  let truncated = false; // a list was cut or capped (runs, timeline, commits, jobs): the report is partial
  let runsCut = false; // the run list was cut or capped: its oldest runs are missing
  const raw = pages(gh, `repos/${slug}/actions/runs?created=${encodeURIComponent(`>=${sinceIso}`)}`, undefined,
    () => { truncated = true; runsCut = true; warn(`the list of workflow runs was cut after ${MAX_PAGES} pages (${MAX_PAGES * PAGE} runs): runs further back are missing, so the totals are short (use a later --since)`); },
    { key: 'workflow_runs', onCall: () => budget.count(), onPage: (r) => { totalCount ??= Number.isFinite(r?.total_count) ? r.total_count : null; } });
  // a run created while the pages are read pushes one run onto the next page: it is listed twice and must be charged once
  const seenRuns = new Set();
  const listed = raw.filter((r) => r?.id === undefined || (!seenRuns.has(r.id) && seenRuns.add(r.id)));
  if (totalCount !== null && totalCount > listed.length && listed.length < MAX_PAGES * PAGE) { truncated = true; runsCut = true; warn(`GitHub lists ${totalCount} runs for this period but returned ${listed.length}: it caps a created= search at 1000 results, so the totals are short (use a later --since)`); }
  const keep = new Set(workflows);
  const runs = keep.size === 0 ? listed : listed.filter((r) => keep.has(r.name) || keep.has(r.path) || keep.has(String(r.path ?? '').split('/').pop()));

  const kept = new Set(runs);

  // PRs: only the run's own pull_requests link
  // a re-run measures only its last attempt (elapsedMs): a short retry of a long run must still have its jobs read, which cover every attempt
  const isCandidate = (r) => elapsedMs(r) >= HEAVY_ELAPSED_MS || Number(r.run_attempt) > 1;
  const candidates = runs.filter(isCandidate);
  const prOfRun = new Map();
  const prGroups = new Map(); // PR number -> { runs (the kept ones: the cost), all (of every workflow: which run came first on a head), candidateMs }
  for (const run of listed) {
    if (run.event !== 'pull_request') continue;
    const n = run.pull_requests?.[0]?.number;
    if (!Number.isInteger(n)) continue;
    const g = prGroups.get(n) ?? { runs: [], all: [], candidateMs: 0 };
    g.all.push(run);
    if (kept.has(run)) {
      prOfRun.set(run.id, n);
      g.runs.push(run);
      if (isCandidate(run)) g.candidateMs += Math.max(elapsedMs(run), 1);
    }
    prGroups.set(n, g);
  }

  // per PR with at least one heavy-candidate run, the biggest first: the PR itself, its timeline and its commits
  const readPr = new Map();
  const order = [...prGroups.entries()].filter(([, g]) => g.candidateMs > 0).sort((a, b) => b[1].candidateMs - a[1].candidateMs);
  for (const [n] of order) {
    let incomplete = false; // a list of this PR was cut: its phases or commits are missing, so none of its heads is judged
    const cut = (what) => () => { truncated = true; incomplete = true; warn(`#${n}: the ${what} were cut after ${MAX_PAGES} pages: the classification of this PR is short and none of its heads could be checked`); };
    try {
      budget.tick(maxCalls * PR_SHARE);
      const pr = gh.api('GET', `repos/${slug}/pulls/${n}`);
      const timeline = pages(gh, `repos/${slug}/issues/${n}/timeline`, undefined, cut('timeline events'), { onCall: () => budget.tick(maxCalls * PR_SHARE) });
      const commits = pages(gh, `repos/${slug}/pulls/${n}/commits`, undefined, cut('commits'), { onCall: () => budget.tick(maxCalls * PR_SHARE) });
      // GitHub returns at most 250 commits of a PR whatever the pages: a PR with more is short here, with no cut page to show it
      if (Number.isInteger(pr?.commits) && pr.commits > commits.length) { truncated = true; warn(`#${n}: GitHub lists ${pr.commits} commits for this PR but returned ${commits.length} (it caps the commits of a PR at 250): the heads of the commits it left out could not be checked`); }
      readPr.set(n, { pr: { createdAt: pr?.created_at, draft: pr?.draft === true, baseRef: pr?.base?.ref, baseRepo: pr?.base?.repo?.full_name }, timeline, commits, incomplete });
    } catch (err) {
      if (err instanceof budget.stop) { skipped.prs += 1; continue; }
      warn(`#${n}: could not be read (${asciiLine(err?.message, 120)}): its runs stay unclassified`);
      skipped.prs += 1;
    }
  }
  // the PRs that were never tried because the budget ran out are skipped too
  skipped.prs = order.length - readPr.size;

  // the jobs of the biggest candidate runs first (the cost is there), one call each
  const jobsByRun = new Map();
  let jobsCut = 0;
  const bySize = [...candidates].sort((a, b) => elapsedMs(b) - elapsedMs(a));
  for (const run of bySize) {
    try {
      let cut = false;
      const jobs = pages(gh, `repos/${slug}/actions/runs/${encodeURIComponent(run.id)}/jobs?filter=all`, undefined,
        () => { cut = true; truncated = true; warn(`run ${run.id}: the jobs were cut after ${MAX_PAGES} pages: its job minutes are short`); }, { key: 'jobs', onCall: () => budget.tick() });
      if (cut) { jobs.cut = true; jobsCut += 1; }
      jobsByRun.set(run.id, jobs);
    } catch (err) {
      if (err instanceof budget.stop) break;
      warn(`run ${run.id}: the jobs could not be read (${asciiLine(err?.message, 100)})`);
    }
  }
  skipped.jobs = candidates.length - jobsByRun.size + jobsCut; // a run whose list was cut is not fully read

  // classify
  const prRows = [];
  const classified = [];
  let predating = 0; // kept pull_request runs linked to a PR that was opened after them
  // a head that also has a pull_request run GitHub did not link to any PR: which run came first on it cannot be proven, so it is not judged (see analysePrUsage)
  const unlinkedPrRuns = listed.filter((r) => r.event === 'pull_request' && (r.pull_requests ?? []).length === 0 && r.head_sha);
  // the runs before the oldest one kept were not read when the run list was cut: a head whose commit is older may have had its first run there
  const oldest = Math.min(...listed.map((r) => Date.parse(r.created_at)).filter(Number.isFinite));
  const evidenceFromMs = runsCut && Number.isFinite(oldest) ? Math.max(sinceMs, oldest) : sinceMs;
  for (const [n, { incomplete, ...data }] of readPr) {
    const group = prGroups.get(n);
    // GitHub links a run to the PRs that are OPEN now on its branch or head, so a run of an earlier (closed) PR on a reused branch name carries this PR: a run created before the PR existed is not its own
    // (as in the summary). It falls into the last pass below, where a linked run of no PR row is unclassified; it stays in the totals.
    const created = Date.parse(data.pr.createdAt);
    const own = (r) => !Number.isFinite(created) || Date.parse(r.created_at) >= created;
    const prRuns = group.runs.filter(own);
    const all = group.all.filter(own);
    for (const r of group.runs) if (!own(r)) { prOfRun.delete(r.id); predating += 1; }
    // the PR was read for a heavy run that turned out not to be its own: with none left it is no PR of this report (no row), and its remaining runs go to the last pass like those of any PR without a heavy run
    if (!prRuns.some(isCandidate)) { readPr.delete(n); continue; }
    // like the summary: only an unlinked run created since this PR was created can have been the first run of one of its heads
    const ambiguousHeads = incomplete ? all.map((r) => r.head_sha) : unlinkedPrRuns.filter((r) => !(Date.parse(r.created_at) < Date.parse(data.pr.createdAt))).map((r) => r.head_sha);
    const row = analysePrUsage({ number: n, ...data, runs: prRuns, evidenceRuns: all, jobsByRun, rates, viewer, sinceMs, evidenceFromMs, isPrivate, ambiguousHeads });
    if (viewer === null) row.wastedRedrafts = null; // whose redraft it was cannot be told
    classified.push(...row.classified);
    const { classified: _omit, ...plain } = row;
    prRows.push(plain);
  }
  const unread = runs.filter((r) => !(r.event === 'pull_request' && readPr.has(prOfRun.get(r.id))));
  classified.push(...classifyRuns({ runs: unread, jobsByRun, rates, unlinked: true }));
  if (predating > 0) warn(`${predating} pull_request run(s) were linked by GitHub to a PR opened after them (a branch name reused by an earlier PR): left unclassified, not given to that PR`);
  const agg = aggregateUsage({ classified, prRows, isPrivate, rates, draftWhileIterating });
  if (viewer === null) agg.totals.wastedRedrafts = null; // also with no PR row: whose redraft it was cannot be told

  const partial = budget.reason !== null || skipped.prs > 0 || skipped.jobs > 0 || truncated;
  if (budget.reason === 'rate-limit') warn(`the rate limit is low (${budget.rate?.remaining} calls left, stopping below ${MIN_REMAINING}): the report is partial`);
  if (budget.reason === 'max-calls') warn(`--max-calls ${maxCalls} reached: the report is partial`);
  if (skipped.prs > 0) warn(`${skipped.prs} PR(s) with heavy runs were not read: their runs are unclassified`);
  const unchecked = agg.totals.uncheckedHeads;
  if (unchecked > 0) warn(`${unchecked} head(s) pushed while the PR was ready also have a pull_request run GitHub did not link to a PR, are missing from the PR's commit list (a force push dropped them, or GitHub's 250-commit cap), or may have had an earlier run before the period: they could not be checked, so they are left out of the pushed-while-ready and missed-redraft counts (their runs stay in the totals)`);
  const { unlinkedRuns } = agg.totals.attribution;
  if (unlinkedRuns > 0) warn(`${unlinkedRuns} pull_request run(s) were not linked to a PR by GitHub (a PR from a fork, or a PR merged or closed before this report: GitHub unlinks the runs of a PR that is no longer open): counted under class other, event pull_request, not given to any PR, so the per-PR rows and the pushed-while-ready and missed-redraft counts cover the PRs still open`);
  if (skipped.jobs > 0) warn(`${skipped.jobs} run(s) of a minute or more, or re-run, had their jobs unread: job minutes and the estimate cover ${agg.totals.coverage}% of the heavy runs`);
  return {
    slug, private: isPrivate, billing: agg.billing, draftWhileIterating, classifierVersion, since: sinceIso, partial, calls: budget.calls, rateLimit: budget.rate, skipped,
    runsListed: listed.length, runsRead: runs.length,
    totals: agg.totals, assumptions: agg.assumptions,
    prs: prRows.sort((a, b) => a.pr - b.pr),
    unexcludable: [UNEXCLUDABLE],
  };
}
