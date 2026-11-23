// What CI really costs per PR and per class of run, and how often an agent pushed to a READY PR without `pipeline redraft` first (a missed redraft).
// Pure: no I/O, the commands read GitHub and hand the answers in (`pipeline ci-usage`, and the `pushedWhileReady` warning of `pipeline summary`).
// Display only: nothing here decides anything. Bump `classifierVersion` whenever a rule below changes, so two reports can be compared.
//
// Shapes in (GitHub's own, untouched):
//   timeline  [{ event: 'ready_for_review' | 'converted_to_draft' | 'committed' | 'head_ref_force_pushed' | ..., created_at, actor: { login } }]
//   pr        { createdAt, draft, baseRef, baseRepo }  (`draft` is the PR's CURRENT draft flag: with no draft/ready event on the timeline it is also what the PR always was; `baseRef` its base branch, which a catch-up must merge; `baseRepo` its owner/name, which a merge "of <url>" must name)
//   commits   normalised by normalizeCommit: { sha, parents (count), committer (login), message }
//   runs      workflow runs: { id, name, path, event, head_sha, run_attempt, conclusion, created_at, run_started_at, updated_at }
//   jobs      actions/runs/{id}/jobs?filter=all (every attempt): { run_attempt, conclusion, started_at, completed_at, labels }
import { asciiLine } from './triage.mjs';

export const classifierVersion = 1;

// A run created this long after `ready_for_review` is the run that event started; a run cancelled this long after `converted_to_draft` was cancelled by it.
export const WINDOW_MS = 120_000;
// A run is HEAVY when its jobs add up to a minute or more; with no jobs read, when it ran for a minute or more (flagged `heavyFromElapsed`).
export const HEAVY_JOB_MINUTES = 1;
export const HEAVY_ELAPSED_MS = 60_000;
export const OS_KEYS = Object.freeze(['linux', 'windows', 'macos', 'self-hosted']);
// USD per minute of a GitHub-hosted runner (the standard rates of 2026-01-01; larger runners cost more, so they are underestimated). Overridable with `--rate os=usd`. Self-hosted runners cost nothing here.
export const DEFAULT_RATES = Object.freeze({ linux: 0.006, windows: 0.010, macos: 0.062 });
export const CLASSES = Object.freeze(['ready-for-review', 'opening', 'push-while-ready', 'push-while-draft', 'converted-cancel', 'catch-up', 'rerun', 'other', 'unclassified']);

const ms = (v) => {
  const t = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const round = (v, digits = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** digits) / 10 ** digits : null);
const sha12 = (s) => String(s ?? '').slice(0, 12);

// ---- the PR's phase -------------------------------------------------------------------------------------------------

// [{ t, to: 'ready' | 'draft', actor }] oldest first.
function toggles(timeline) {
  const out = [];
  for (const e of Array.isArray(timeline) ? timeline : []) {
    const t = ms(e?.created_at);
    if (t === null) continue;
    if (e.event === 'ready_for_review') out.push({ t, to: 'ready', actor: e.actor?.login ?? null });
    else if (e.event === 'converted_to_draft') out.push({ t, to: 'draft', actor: e.actor?.login ?? null });
  }
  return out.sort((a, b) => a.t - b.t);
}

// 'draft' | 'ready' when the PR was opened: the first event says what it was before (ready_for_review => it was a draft); no event at all => it never changed.
export function initialPhase(timeline, draftNow) {
  const first = toggles(timeline)[0];
  if (first) return first.to === 'ready' ? 'draft' : 'ready';
  return draftNow === true ? 'draft' : 'ready';
}

// 'draft' | 'ready' at time `t` (ms or ISO). `prCreated` = { createdAt, draft } (see the header).
export function prPhaseAt(timeline, prCreated, t) {
  const at = ms(t);
  let phase = initialPhase(timeline, prCreated?.draft);
  if (at === null) return phase;
  for (const e of toggles(timeline)) {
    if (e.t > at) break;
    phase = e.to;
  }
  return phase;
}

// ---- catch-ups (update-branch) --------------------------------------------------------------------------------------

// GitHub's "Update branch" (PUT pulls/{n}/update-branch, which `pipeline update-branch` calls, lib/updatebranch.mjs) makes a merge commit of the base into the
// PR branch: two parents, committed by GitHub itself (login `web-flow`), message "Merge branch '<base>' into <head-branch>". A local merge writes the same message
// ("Merge branch '<base>' into ..." or "Merge remote-tracking branch 'origin/<base>' into ..."): the same base churn. With the PR's base known (`baseRef`) the merged
// branch must BE the base (a merge of a feature branch is a push, whoever committed it); with it unknown any merge of a branch counts, or any web-flow merge.
// git pull adds " of <url>" after the name (the merge then counts only when that URL is the PR's base repository on github.com, when that is known: a fork's `main` is not the base); GitHub's update-branch on a fork PR may name the base "owner:<base>" (the owner must be the base repository's, when known).
const MERGE_MESSAGE = /^Merge (remote-tracking )?branch '([^'\n]+)'(?: of (\S+))? into \S+/;
const repoOfUrl = (url) => url.replace(/\.git$/, '').split(/[/:]/).filter(Boolean).slice(-2).join('/').toLowerCase();
// the host of a pulled URL (https://host/o/r, ssh://git@host/o/r, git@host:o/r, host:o/r); GitHub's own repositories are on github.com
const hostOfUrl = (url) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url.replace(/^[^/]*\/\//, '').replace(/^[^@/]*@/, '').split(/[/:]/)[0] : url.replace(/^[^@/]*@/, '').split(/[/:]/)[0]).toLowerCase();
// github.com, and ssh.github.com (git over ssh port 443)
const GITHUB_HOSTS = new Set(['github.com', 'ssh.github.com']);
const mergedBranch = (message, baseRepo = null) => {
  const m = MERGE_MESSAGE.exec(String(message).split('\n')[0]);
  if (m === null) return null;
  const known = typeof baseRepo === 'string' && baseRepo !== '';
  if (m[3] !== undefined && known && (repoOfUrl(m[3]) !== baseRepo.toLowerCase() || !GITHUB_HOSTS.has(hostOfUrl(m[3])))) return null;
  if (m[1]) return m[2].replace(/^[^/]+\//, '');
  const owner = /^([^:/]+):/.exec(m[2])?.[1];
  if (owner !== undefined && known && owner.toLowerCase() !== baseRepo.split('/')[0].toLowerCase()) return null;
  return m[2].replace(/^[^:/]+:/, '');
};
export function normalizeCommit(c) {
  const parents = typeof c?.parents === 'number' ? c.parents : Array.isArray(c?.parents) ? c.parents.length : 0;
  const committer = typeof c?.committer === 'string' ? c.committer : (c?.committer?.login ?? null);
  const message = typeof c?.message === 'string' ? c.message : String(c?.commit?.message ?? '');
  return { sha: String(c?.sha ?? ''), parents, committer, message };
}
export function isCatchUpCommit(c, baseRef = null, baseRepo = null) {
  const k = normalizeCommit(c);
  if (k.parents !== 2) return false;
  const merged = mergedBranch(k.message, baseRepo);
  if (typeof baseRef === 'string' && baseRef !== '') return merged === baseRef;
  return k.committer === 'web-flow' || merged !== null;
}
const catchUpShas = (commits, baseRef = null, baseRepo = null) => new Set((commits ?? []).filter((c) => isCatchUpCommit(c, baseRef, baseRepo)).map((c) => normalizeCommit(c).sha));

// ---- cost of one run ------------------------------------------------------------------------------------------------

// Provider runners (not GitHub-hosted) and anything we cannot recognise cost nothing here and are counted on their own.
const PROVIDER_LABEL = /^(self-hosted|ubicloud|blacksmith|buildjet|depot|warpbuild|namespace|runs-on|actuated|cirrus)/;
export function runnerOs(labels) {
  const list = (Array.isArray(labels) ? labels : []).map((l) => String(l?.name ?? l).toLowerCase());
  if (list.some((l) => PROVIDER_LABEL.test(l))) return 'self-hosted';
  if (list.some((l) => /^windows/.test(l))) return 'windows';
  if (list.some((l) => /^macos/.test(l))) return 'macos';
  if (list.some((l) => /^ubuntu|^linux/.test(l))) return 'linux';
  return 'self-hosted';
}

const zeroMinutes = () => Object.fromEntries(OS_KEYS.map((k) => [k, 0]));

// -> { minutes: { linux, windows, macos, 'self-hosted' } (the sum of the job durations, every attempt), rerunMinutes (the part from attempts after the first),
//      usd (each job rounded UP to a whole minute x the rate of its OS; self-hosted 0), jobs (counted) }. Jobs that never ran (no start or end time, skipped) add nothing.
export function costOfJobs(jobs, rates = DEFAULT_RATES) {
  const minutes = zeroMinutes();
  let rerunMinutes = 0;
  let usd = 0;
  let counted = 0;
  for (const j of Array.isArray(jobs) ? jobs : []) {
    const start = ms(j?.started_at);
    const end = ms(j?.completed_at);
    if (start === null || end === null || end < start || j.conclusion === 'skipped') continue;
    const min = (end - start) / 60_000;
    const os = runnerOs(j.labels);
    minutes[os] += min;
    if (Number(j.run_attempt) > 1) rerunMinutes += min;
    if (os !== 'self-hosted') usd += Math.ceil(min) * (rates[os] ?? DEFAULT_RATES[os]);
    counted += 1;
  }
  return { minutes, rerunMinutes, usd, jobs: counted };
}
const sumMinutes = (m) => OS_KEYS.reduce((s, k) => s + m[k], 0);

// updated_at - run_started_at, in ms (measured: for a re-run only its last attempt).
export function elapsedMs(run) {
  const start = ms(run?.run_started_at) ?? ms(run?.created_at);
  const end = ms(run?.updated_at);
  return start === null || end === null ? 0 : Math.max(0, end - start);
}

// ---- classification -------------------------------------------------------------------------------------------------

// Every run gets ONE class, the first that fits:
//   other             not a pull_request run (push to main, schedule, workflow_dispatch, a guards run on `labeled` ...): kept apart, by event; or a pull_request run created more than 120 s after the first run of its head (a reopened PR, a converted_to_draft run on the old head), which is no push;
//                     or, with `unlinked: true`, a pull_request run whose `pull_requests` is empty (GitHub did not link it to a PR: forks, sibling PRs on one branch): its row is flagged `unlinked: true`, never given to a PR
//   unclassified      a pull_request run of a PR whose timeline could not be read
//   converted-cancel  cancelled within 120 s after a converted_to_draft: the redraft stopped it
//   rerun             run_attempt > 1 (the whole run, all its attempts, is charged to this class)
//   ready-for-review  created within 120 s after a ready_for_review, on the head of the earliest run of that window: the one suite the redraft flow plans for
//                     (one ready event exempts ONE head; any other head first seen in the window is a push)
//   opening           its head is the one the PR was opened with (headPushes kind 'opening'): the first suite of any PR, not a push
//   catch-up          its head is an update-branch merge of the base
//   push-while-ready  created within 120 s of the first run of a head pushed while the PR was ready
//   push-while-draft  the same while it was a draft
// `evidenceRuns`: the runs that say which run came first on a head (default `runs`); the reader passes the PR's runs of every workflow when `runs` was cut down to --workflow.
// `jobsByRun`: Map run id -> jobs for the runs whose jobs were read (a list the reader had to cut carries `cut: true`: priced as far as read, but not counted as fully read). -> one row per run, same order.
// `unlinked: true` is for the reader's last pass over the runs no PR row holds (unlinked runs, and linked runs of PRs that were not read): each run's OWN link is checked, before the PR is. A linked run of an unread PR stays `unclassified`.
export function classifyRuns({ pr = null, timeline = null, commits = [], runs, evidenceRuns = runs, jobsByRun = new Map(), rates = DEFAULT_RATES, unlinked = false }) {
  const readable = Array.isArray(timeline);
  const events = toggles(timeline);
  const catchups = catchUpShas(commits, pr?.baseRef, pr?.baseRepo);
  const readyBy = readyHeads(events, evidenceRuns);
  const firstOf = firstRuns(evidenceRuns);
  const openingHeads = pr && readable ? new Set(headPushes({ pr, timeline, commits, runs: evidenceRuns }).filter((h) => h.kind === 'opening').map((h) => h.sha)) : new Set();
  return (runs ?? []).map((run) => {
    const created = ms(run.created_at);
    const updated = ms(run.updated_at);
    let cls;
    const noLink = unlinked && run.event === 'pull_request' && (run.pull_requests ?? []).length === 0;
    if (run.event !== 'pull_request') cls = 'other';
    else if (noLink) cls = 'other';
    else if (!pr || !readable) cls = 'unclassified';
    else if (run.conclusion === 'cancelled' && updated !== null && events.some((e) => e.to === 'draft' && updated - e.t >= 0 && updated - e.t <= WINDOW_MS)) cls = 'converted-cancel';
    else if (Number(run.run_attempt) > 1) cls = 'rerun';
    else if (isReadyRun(events, readyBy, created, run.head_sha)) cls = 'ready-for-review';
    // a run created well after its head's first run, or after a converted_to_draft that followed it, is no push (a reopened PR, the run of a redraft on the old head), and no opening or catch-up suite either
    else if (created !== null && staleHead(events, firstOf.get(run.head_sha)?.t ?? created, created)) cls = 'other';
    else if (openingHeads.has(run.head_sha)) cls = 'opening';
    else if (catchups.has(run.head_sha)) cls = 'catch-up';
    else cls = prPhaseAt(timeline, pr, created) === 'ready' ? 'push-while-ready' : 'push-while-draft';
    const read = jobsByRun.has(run.id);
    const cost = read ? costOfJobs(jobsByRun.get(run.id), rates) : null;
    const jobMinutes = cost ? sumMinutes(cost.minutes) : null;
    const elapsed = elapsedMs(run);
    // unread: the last attempt's time says nothing about the earlier attempts of a re-run, so a re-run is heavy (of unknown cost)
    const heavy = read ? jobMinutes >= HEAVY_JOB_MINUTES : elapsed >= HEAVY_ELAPSED_MS || Number(run.run_attempt) > 1;
    return {
      id: run.id, name: run.name ?? null, event: run.event, class: cls, headSha: run.head_sha ?? null, createdAt: run.created_at ?? null,
      catchupHead: catchups.has(run.head_sha), elapsedMin: elapsed / 60_000, jobsRead: read && jobsByRun.get(run.id)?.cut !== true, jobMinutes: cost ? cost.minutes : null, rerunJobMinutes: cost ? cost.rerunMinutes : 0,
      usd: cost ? cost.usd : null, heavy, heavyFromElapsed: heavy && !read, ...(noLink ? { unlinked: true } : {}),
    };
  });
}

// a run created at `t` on a head first seen at `first` did not come with a push of that head: 120 s have passed, or the PR was sent back to draft in between
const staleHead = (events, first, t) => t - first > WINDOW_MS || events.some((e) => e.to === 'draft' && e.t > first && e.t <= t);

// Per ready_for_review (by its time): the head of the earliest pull_request run created within 120 s after it, i.e. the head that event started. One ready event
// exempts one head; a second head first seen in the same window is a push.
function readyHeads(events, runs) {
  const prRuns = (runs ?? []).filter((r) => r.event === 'pull_request' && r.head_sha && ms(r.created_at) !== null);
  const heads = new Map();
  for (const e of events) {
    if (e.to !== 'ready') continue;
    let best = null;
    for (const r of prRuns) {
      const t = ms(r.created_at);
      if (!inReadyWindow(events, e, t)) continue;
      if (!best || t < best.t || (t === best.t && Number(r.id) < Number(best.run.id))) best = { t, run: r };
    }
    if (best) heads.set(e.t, best.run.head_sha);
  }
  return heads;
}
// time `t` is within 120 s after the ready event `e` and before the next converted_to_draft (a PR sent back to draft ends what the ready event started); "next" is by position in the sorted events, so a draft listed after `e` in the same second counts and one listed before it does not
const inReadyWindow = (events, e, t) => t - e.t >= 0 && t - e.t <= WINDOW_MS && !events.some((d, i) => d.to === 'draft' && i > events.indexOf(e) && d.t <= t);
const isReadyRun = (events, readyBy, t, headSha) => t !== null && events.some((e) => e.to === 'ready' && inReadyWindow(events, e, t) && readyBy.get(e.t) === headSha);

// ---- the pushes (heads) of one PR -----------------------------------------------------------------------------------

// head sha -> { t, run }: the earliest pull_request run created for each head (ties: the lower run id).
function firstRuns(runs) {
  const first = new Map();
  for (const run of runs ?? []) {
    if (run.event !== 'pull_request' || !run.head_sha) continue;
    const t = ms(run.created_at);
    if (t === null) continue;
    const seen = first.get(run.head_sha);
    if (!seen || t < seen.t || (t === seen.t && Number(run.id) < Number(seen.run.id))) first.set(run.head_sha, { t, run });
  }
  return first;
}

// One row per head commit that pull_request runs were created for, oldest first (all workflows of one push share a head: one row):
//   { sha, createdAt, phase, kind: 'opening' | 'catch-up' | 'ready-run' | 'push' }
// opening = the head the PR was opened with (its first run within 120 s of the PR's creation); catch-up = an update-branch merge; ready-run = the head's first run
// was the one `ready_for_review` started (nothing ran on it before: the workflow skips drafts); push = a push of the agent. `phase` is the PR's phase when the first run was
// created ('unknown' when the timeline is not an array: it could not be read). A re-run keeps its original created_at, so a re-run never makes a push look newer; only the first run of a head counts.
export function headPushes({ pr, timeline, commits = [], runs }) {
  const events = toggles(timeline);
  const catchups = catchUpShas(commits, pr?.baseRef, pr?.baseRepo);
  const first = firstRuns(runs);
  const readyBy = readyHeads(events, runs);
  const rows = [...first.entries()].sort((a, b) => a[1].t - b[1].t || Number(a[1].run.id) - Number(b[1].run.id));
  const opened = ms(pr?.createdAt);
  return rows.map(([sha, { t }], i) => {
    let kind = 'push';
    if (i === 0 && opened !== null && Math.abs(t - opened) <= WINDOW_MS) kind = 'opening';
    else if (catchups.has(sha)) kind = 'catch-up';
    else if (isReadyRun(events, readyBy, t, sha)) kind = 'ready-run';
    return { sha, createdAt: new Date(t).toISOString(), t, phase: Array.isArray(timeline) ? prPhaseAt(timeline, pr, t) : 'unknown', kind };
  });
}

// A head pushed while the PR was ready is named only when it can be proven: the PR's commit list holds it (a head a force push dropped, or one past GitHub's 250-commit cap, has no record, and an
// update-branch merge there would look like a push), and, when `fromMs` is given (the runs before it were not read), its commit is dated at least COMMIT_CLOCK_SKEW_MS after that (an older commit may have had its first run before it).
// Both callers (`pipeline summary`, `pipeline ci-usage`) leave a head that fails this out and say so.
// A committer clock can run fast: a commit dated less than this after `fromMs` may still have had its first run before it.
export const COMMIT_CLOCK_SKEW_MS = 3_600_000;
export function headProvable(sha, commits, fromMs = null) {
  const c = (commits ?? []).find((k) => normalizeCommit(k).sha === sha);
  if (c === undefined) return false;
  if (fromMs === null) return true;
  const d = commitDate(c);
  return d !== null && d >= fromMs + COMMIT_CLOCK_SKEW_MS;
}

// Heads pushed while the PR was READY: the missed redrafts (when the repository iterates in draft). Excluded: the opening head, catch-ups, heads whose first run was the
// ready one (ONE head per ready event), and re-runs (see headPushes). NOT excludable: a push after Rule 8's proven `convert-failed` rejection (GitHub refused the redraft, so the review skill pushes
// anyway) leaves no trace on GitHub; it counts here like any other push while ready.
export const UNEXCLUDABLE = 'A push made after a proven convert-failed rejection of `pipeline redraft` (Rule 8: push anyway) leaves no trace on GitHub and counts as pushed while ready.';
// -> { count, heads }; `count: null` (no heads) when the timeline could not be read: the phase of a push is then unknown, as classifyRuns' `unclassified`.
export function pushedWhileReady({ pr, timeline, commits = [], runs }) {
  if (!Array.isArray(timeline)) return { count: null, heads: [] };
  const heads = headPushes({ pr, timeline, commits, runs }).filter((h) => h.kind === 'push' && h.phase === 'ready');
  return { count: heads.length, heads: heads.map((h) => ({ sha: h.sha, createdAt: h.createdAt })) };
}

// A converted_to_draft (by `viewer`, else anybody) followed by a ready_for_review with no new head in between: the redraft bought nothing. A new head is a head with a first
// run, a force push, or a commit dated in between.
// `sinceMs`: only the cycles that ended (the ready_for_review) in the period count.
export function wastedRedrafts({ pr, timeline, commits = [], runs, viewer = null, sinceMs = null }) {
  const events = toggles(timeline);
  const pushes = headPushes({ pr, timeline, commits, runs }).filter((h) => h.kind !== 'opening').map((h) => h.t);
  for (const e of Array.isArray(timeline) ? timeline : []) {
    if (e?.event === 'head_ref_force_pushed' && ms(e.created_at) !== null) pushes.push(ms(e.created_at));
    if (e?.event === 'committed') {
      const d = ms(e.committer?.date ?? e.author?.date);
      if (d !== null) pushes.push(d);
    }
  }
  let wasted = 0;
  events.forEach((e, i) => {
    if (e.to !== 'draft' || (viewer !== null && e.actor !== viewer)) return;
    const next = events[i + 1];
    if (!next || next.to !== 'ready' || (sinceMs !== null && next.t < sinceMs)) return;
    if (!pushes.some((t) => t > e.t && t < next.t)) wasted += 1;
  });
  return wasted;
}

// ---- one PR ---------------------------------------------------------------------------------------------------------

const addTo = (acc, minutes) => { for (const k of OS_KEYS) acc[k] += minutes[k] ?? 0; };

const commitDate = (c) => ms(c?.commit?.committer?.date ?? c?.commit?.author?.date);

// -> the PR's row and its classified runs.
// `evidenceRuns`: the PR's linked runs of EVERY workflow (default `runs`, which --workflow may have cut down): the first run of a head, and so every push, is judged on them; the cost is of `runs`.
// `evidenceFromMs`: the runs before it were not read (default none; the reader passes the period start, later when the run list was cut): a head whose commit is older than that, or has no commit date, is not judged (headProvable).
// A ready-phase head that is not in `commits` is not judged either: both are counted in `uncheckedHeads` like an ambiguous head.
// `ambiguousHeads` (head SHAs): heads that ALSO have a pull_request run GitHub did not link to any PR. Which run came first on such a head cannot be proven (the unlinked run may have been the first, while the PR was a draft),
// so the head is left out of pushesWhileReady / pushedHeads and counted in `uncheckedHeads`; its runs stay in every class, elapsed, job and cost total.
// `sinceMs` (the report's period): the whole timeline and commit list still set the phase, but only the ready cycles, wasted redrafts and catch-ups dated in the period are counted.
// `isPrivate`: a public repository is free, so its PR rows are 0 too.
export function analysePrUsage({ number, pr, timeline, commits = [], runs, evidenceRuns = runs, jobsByRun = new Map(), rates = DEFAULT_RATES, viewer = null, sinceMs = null, evidenceFromMs = null, isPrivate = true, ambiguousHeads = [] }) {
  const classified = classifyRuns({ pr, timeline, commits, runs, evidenceRuns, jobsByRun, rates });
  // evidenceRuns only decide which run came first: a head none of the kept runs belongs to (a push that ran another workflow only) is not this report's
  const keptHeads = new Set(runs.map((r) => r.head_sha));
  const pushes = headPushes({ pr, timeline, commits, runs: evidenceRuns }).filter((h) => keptHeads.has(h.sha));
  const ambiguous = new Set(ambiguousHeads);
  const readyPushes = pushes.filter((h) => h.kind === 'push' && h.phase === 'ready');
  const pushedReady = readyPushes.filter((h) => !ambiguous.has(h.sha) && headProvable(h.sha, commits, evidenceFromMs));
  const jobMinutes = zeroMinutes();
  let usd = 0;
  let workflowElapsedMin = 0;
  let heavyRuns = 0;
  let churnRuns = 0;
  let churnMinutes = 0;
  let churnUnreadRuns = 0;
  for (const r of classified) {
    if (!r.heavy) continue;
    heavyRuns += 1;
    workflowElapsedMin += r.elapsedMin;
    if (r.jobMinutes) addTo(jobMinutes, r.jobMinutes);
    usd += r.usd ?? 0;
    // base churn: a heavy run on an update-branch head, other than the ready-for-review suite the flow plans for
    if (r.catchupHead && r.class !== 'ready-for-review') {
      churnRuns += 1;
      if (r.jobMinutes) churnMinutes += sumMinutes(r.jobMinutes);
      else churnUnreadRuns += 1;
    }
  }
  const toggled = toggles(timeline);
  return {
    pr: number,
    readyCycles: (initialPhase(timeline, pr?.draft) === 'ready' && (sinceMs === null || ms(pr?.createdAt) >= sinceMs) ? 1 : 0) + toggled.filter((e) => e.to === 'ready' && (sinceMs === null || e.t >= sinceMs)).length,
    pushesWhileReady: pushedReady.length,
    pushedHeads: pushedReady.map((h) => sha12(h.sha)),
    uncheckedHeads: readyPushes.length - pushedReady.length,
    pushesWhileDraft: pushes.filter((h) => h.kind === 'push' && h.phase === 'draft').length,
    wastedRedrafts: wastedRedrafts({ pr, timeline, commits, runs: evidenceRuns, viewer, sinceMs }),
    catchups: new Set((commits ?? []).filter((c) => isCatchUpCommit(c, pr?.baseRef, pr?.baseRepo) && (sinceMs === null || (commitDate(c) ?? sinceMs) >= sinceMs)).map((c) => normalizeCommit(c).sha)).size,
    heavyRuns, workflowElapsedMin: round(workflowElapsedMin), jobMinutes: roundMinutes(jobMinutes), estimatedUsd: isPrivate ? round(usd, 4) : 0,
    churnRuns, churnMinutes: round(churnMinutes), churnUnreadRuns,
    classified,
  };
}
const roundMinutes = (m) => Object.fromEntries(OS_KEYS.map((k) => [k, round(m[k])]));

// ---- totals ---------------------------------------------------------------------------------------------------------

// How much of the pull_request cost the report could not give to a PR: unlinkedRuns = every pull_request run GitHub did not link to a PR (any length); the *Heavy* fields count heavy runs only, the population the PR rows use
// (linked = a pull_request run that is not flagged unlinked, whatever its class (a linked run on an old head is `other`), which includes the linked runs of PRs that were not read; unlinked = the flagged rows of classifyRuns's `unlinked` pass).
function attributionOf(classified) {
  const linked = classified.filter((r) => r.event === 'pull_request' && !r.unlinked && r.heavy);
  const unlinkedAll = classified.filter((r) => r.unlinked);
  const unlinkedHeavy = unlinkedAll.filter((r) => r.heavy);
  const minutes = (rows) => round(rows.reduce((sum, r) => sum + r.elapsedMin, 0));
  return { unlinkedRuns: unlinkedAll.length, linkedHeavyRuns: linked.length, linkedHeavyElapsedMin: minutes(linked), unlinkedHeavyRuns: unlinkedHeavy.length, unlinkedHeavyElapsedMin: minutes(unlinkedHeavy) };
}

// `classified`: every run's row (all PRs and the non-PR runs). `prRows`: analysePrUsage results. `jobsWanted`: how many heavy-candidate runs jobs were wanted for (coverage = the share read).
// `isPrivate`: only a private repository is billed; a public one is free (estimatedUsd 0, billing 'free-public').
export function aggregateUsage({ classified, prRows, isPrivate, rates = DEFAULT_RATES, draftWhileIterating = 'unknown' }) {
  const heavy = classified.filter((r) => r.heavy);
  const jobMinutes = zeroMinutes();
  const byClass = {};
  const byEvent = {};
  let workflowElapsedMin = 0;
  let usd = 0;
  const bucket = (map, key) => (map[key] ??= { runs: 0, heavyRuns: 0, workflowElapsedMin: 0, jobMinutes: zeroMinutes() });
  for (const r of classified) {
    const slots = [bucket(byClass, r.class)];
    if (r.class === 'other') slots.push(bucket(byEvent, r.event ?? 'unknown'));
    for (const s of slots) {
      s.runs += 1;
      if (!r.heavy) continue;
      s.heavyRuns += 1;
      s.workflowElapsedMin += r.elapsedMin;
      if (r.jobMinutes) addTo(s.jobMinutes, r.jobMinutes);
    }
  }
  for (const r of heavy) {
    workflowElapsedMin += r.elapsedMin;
    if (r.jobMinutes) addTo(jobMinutes, r.jobMinutes);
    usd += r.usd ?? 0;
  }
  for (const map of [byClass, byEvent]) {
    for (const s of Object.values(map)) {
      s.workflowElapsedMin = round(s.workflowElapsedMin);
      s.jobMinutes = roundMinutes(s.jobMinutes);
    }
  }
  const read = heavy.filter((r) => r.jobsRead).length;
  const pushesWhileReady = prRows.reduce((s, p) => s + p.pushesWhileReady, 0);
  const totals = {
    prs: prRows.length,
    heavyRuns: heavy.length,
    workflowElapsedMin: round(workflowElapsedMin),
    jobMinutes: roundMinutes(jobMinutes),
    coverage: heavy.length === 0 ? 100 : Math.round((read / heavy.length) * 100),
    byClass, byEvent,
    attribution: attributionOf(classified),
    pushesWhileReady,
    // a push while ready is a MISSED redraft only where the repository iterates in draft (ci.draft_while_iterating: true); null = that setting could not be read
    missedRedrafts: draftWhileIterating === true ? pushesWhileReady : draftWhileIterating === false ? 0 : null,
    // null when a PR's count is unknown (the viewer login could not be read, so whose redraft it was cannot be told)
    wastedRedrafts: prRows.some((p) => p.wastedRedrafts === null) ? null : prRows.reduce((s, p) => s + p.wastedRedrafts, 0),
    catchupsPerPr: prRows.length === 0 ? null : round(prRows.reduce((s, p) => s + p.catchups, 0) / prRows.length),
    churnRuns: prRows.reduce((s, p) => s + p.churnRuns, 0),
    churnMinutes: round(prRows.reduce((s, p) => s + p.churnMinutes, 0)),
    churnUnreadRuns: prRows.reduce((s, p) => s + p.churnUnreadRuns, 0),
    uncheckedHeads: prRows.reduce((s, p) => s + (p.uncheckedHeads ?? 0), 0),
    estimatedUsd: isPrivate ? round(usd, 4) : 0,
  };
  return {
    totals,
    billing: isPrivate ? 'estimate-private' : 'free-public',
    assumptions: {
      estimate: true,
      rates: { ...DEFAULT_RATES, ...rates, 'self-hosted': 0 },
      note: isPrivate
        ? 'each job is rounded up to a whole minute and priced at its runner OS rate; larger runners, free included minutes and discounts are not modelled; jobs not read are not priced (see coverage)'
        : 'a public repository does not pay for Actions minutes: estimatedUsd is 0',
    },
  };
}

// ---- the plain-text table -------------------------------------------------------------------------------------------

const pad = (s, n) => asciiLine(s, 200).padEnd(n);
const cell = (s) => asciiLine(s, 200);
const usdText = (v) => (v === null || v === undefined ? '-' : `$${v.toFixed(2)}`);
const minText = (m) => (m === null || m === undefined ? '-' : m.toFixed(1));
const osText = (m) => OS_KEYS.filter((k) => m[k] > 0).map((k) => `${k} ${m[k].toFixed(1)}`).join(', ') || '0';

export function renderUsageTable({ since, repos }) {
  const out = [];
  for (const r of repos) {
    const t = r.totals;
    out.push(cell(`CI usage since ${since} in ${r.slug} (${r.private ? 'private' : 'public'}; classifier v${r.classifierVersion}${r.partial ? '; PARTIAL' : ''})`), '');
    out.push(`${pad('PR', 8)}${pad('ready', 7)}${pad('push-rdy', 10)}${pad('push-dft', 10)}${pad('wasted', 8)}${pad('catchups', 10)}${pad('heavy', 7)}${pad('job min', 9)}${pad('est $', 9)}pushed-while-ready heads`);
    for (const p of r.prs) {
      out.push(`${pad(`#${p.pr}`, 8)}${pad(p.readyCycles, 7)}${pad(p.pushesWhileReady, 10)}${pad(p.pushesWhileDraft, 10)}${pad(p.wastedRedrafts ?? '-', 8)}${pad(p.catchups, 10)}${pad(p.heavyRuns, 7)}${pad(minText(Object.values(p.jobMinutes).reduce((s, v) => s + (v ?? 0), 0)), 9)}${pad(r.private ? usdText(p.estimatedUsd) : '-', 9)}${cell(p.pushedHeads.join(' '))}`);
    }
    out.push('', 'Heavy runs by class (runs, heavy runs, workflow elapsed min, job minutes by OS):');
    for (const [name, s] of Object.entries(t.byClass)) {
      out.push(`  ${pad(name, 18)}${pad(s.runs, 6)}${pad(s.heavyRuns, 6)}${pad(minText(s.workflowElapsedMin), 9)}${osText(s.jobMinutes)}`);
      if (name === 'other') for (const [ev, e] of Object.entries(t.byEvent)) out.push(`    ${pad(`event ${ev}`, 16)}${pad(e.runs, 6)}${pad(e.heavyRuns, 6)}${pad(minText(e.workflowElapsedMin), 9)}${osText(e.jobMinutes)}`);
    }
    out.push('', `PRs ${t.prs} · heavy runs ${t.heavyRuns} · workflow elapsed ${minText(t.workflowElapsedMin)} min (measured) · job minutes ${osText(t.jobMinutes)} · jobs read for ${t.coverage}% of the heavy runs`);
    out.push(r.private ? `Estimated cost ${usdText(t.estimatedUsd)} (an estimate, not a bill: ${cell(r.assumptions.note)})` : 'Public repository: Actions minutes are free (estimated cost $0.00)');
    out.push(`Pushed while ready ${t.pushesWhileReady} · missed redrafts ${t.missedRedrafts === null ? 'unknown (ci.draft_while_iterating could not be read)' : t.missedRedrafts} (draft_while_iterating ${r.draftWhileIterating}) · wasted redrafts ${t.wastedRedrafts === null ? 'unknown (the viewer login could not be read)' : t.wastedRedrafts}`);
    out.push('Per-PR rows and the pushed-while-ready / missed-redraft counts cover the PRs still open when this report runs: GitHub unlinks the runs of a merged or closed PR (they stay in the totals as unlinked runs)');
    out.push(`Base churn: ${t.churnRuns} heavy run(s) on catch-up heads, ${minText(t.churnMinutes)} job min · ${t.catchupsPerPr ?? '-'} catch-ups per PR`);
    out.push(`Calls ${r.calls}${r.rateLimit ? ` · rate limit remaining ${r.rateLimit.remaining}` : ''}${r.partial ? ` · skipped: ${cell(JSON.stringify(r.skipped))}` : ''}`);
    for (const u of r.unexcludable) out.push(cell(`Note: ${u}`));
    out.push('');
  }
  return out.join('\n').trimEnd();
}
