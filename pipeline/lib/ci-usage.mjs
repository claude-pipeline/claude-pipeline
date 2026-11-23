// The classifier of CI runs: which class every workflow run of a PR falls in (opening, push-while-ready, catch-up, ...), what its jobs cost, and which heads were pushed while the PR was READY (a missed redraft).
// Pure: no I/O, a reader hands GitHub's answers in. Shared by the repo report and the `pushedWhileReady` warning of `pipeline summary`; neither exists yet, this is the library alone.
// Display only: nothing here decides anything. Bump `classifierVersion` whenever a rule below changes, so two reports can be compared.
//
// Shapes in (GitHub's own, untouched):
//   timeline  [{ event: 'ready_for_review' | 'converted_to_draft' | 'committed' | 'head_ref_force_pushed' | ..., created_at, actor: { login } }]
//   pr        { createdAt, draft, baseRef, baseRepo }  (`draft` is the PR's CURRENT draft flag: with no draft/ready event on the timeline it is also what the PR always was; `baseRef` its base branch, which a catch-up must merge; `baseRepo` its owner/name, which a merge "of <url>" must name)
//   commits   normalised by normalizeCommit: { sha, parents (count), committer (login), message }
//   runs      workflow runs: { id, name, path, event, head_sha, run_attempt, conclusion, created_at, run_started_at, updated_at }
//   jobs      actions/runs/{id}/jobs?filter=all (every attempt): { run_attempt, conclusion, started_at, completed_at, labels }

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
//   other             not a pull_request run (push to main, schedule, workflow_dispatch, a guards run on `labeled` ...): kept apart, by event; or a pull_request run created more than 120 s after the first run of its head (a reopened PR, a converted_to_draft run on the old head), which is no push
//   unclassified      a pull_request run of a PR whose timeline could not be read
//   converted-cancel  cancelled within 120 s after a converted_to_draft: the redraft stopped it
//   rerun             run_attempt > 1 (the whole run, all its attempts, is charged to this class)
//   ready-for-review  created within 120 s after a ready_for_review, on the head of the earliest run of that window: the one suite the redraft flow plans for
//                     (one ready event exempts ONE head; any other head first seen in the window is a push)
//   opening           its head is the one the PR was opened with (headPushes kind 'opening'): the first suite of any PR, not a push
//   catch-up          its head is an update-branch merge of the base
//   push-while-ready  created within 120 s of the first run of a head pushed while the PR was ready
//   push-while-draft  the same while it was a draft
// `jobsByRun`: Map run id -> jobs for the runs whose jobs were read (a list the reader had to cut carries `cut: true`: priced as far as read, but not counted as fully read). -> one row per run, same order.
export function classifyRuns({ pr = null, timeline = null, commits = [], runs, jobsByRun = new Map(), rates = DEFAULT_RATES }) {
  const readable = Array.isArray(timeline);
  const events = toggles(timeline);
  const catchups = catchUpShas(commits, pr?.baseRef, pr?.baseRepo);
  const readyBy = readyHeads(events, runs);
  const firstOf = firstRuns(runs);
  const openingHeads = pr && readable ? new Set(headPushes({ pr, timeline, commits, runs }).filter((h) => h.kind === 'opening').map((h) => h.sha)) : new Set();
  return (runs ?? []).map((run) => {
    const created = ms(run.created_at);
    const updated = ms(run.updated_at);
    let cls;
    if (run.event !== 'pull_request') cls = 'other';
    else if (!pr || !readable) cls = 'unclassified';
    else if (run.conclusion === 'cancelled' && updated !== null && events.some((e) => e.to === 'draft' && updated - e.t >= 0 && updated - e.t <= WINDOW_MS)) cls = 'converted-cancel';
    else if (Number(run.run_attempt) > 1) cls = 'rerun';
    else if (isReadyRun(events, readyBy, created, run.head_sha)) cls = 'ready-for-review';
    else if (openingHeads.has(run.head_sha)) cls = 'opening';
    else if (catchups.has(run.head_sha)) cls = 'catch-up';
    // a run created well after its head's first run is no push (a reopened PR, a converted_to_draft run on the old head)
    else if (created !== null && created - (firstOf.get(run.head_sha)?.t ?? created) > WINDOW_MS) cls = 'other';
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
      usd: cost ? cost.usd : null, heavy, heavyFromElapsed: heavy && !read,
    };
  });
}

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
// time `t` is within 120 s after the ready event `e` and before the next converted_to_draft (a PR sent back to draft ends what the ready event started)
const inReadyWindow = (events, e, t) => t - e.t >= 0 && t - e.t <= WINDOW_MS && !events.some((d) => d.to === 'draft' && d.t > e.t && d.t <= t);
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
