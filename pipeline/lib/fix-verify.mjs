// The two briefs a Fable review round can carry (arbiter needed picks one, arbiter apply proves against it).
//   full        today's brief: the whole review job, agent `arbiter`, proven at effort `high`.
//   fix-verify  a FIX ROUND: the previous counted round had ACCEPT items, so this round's diff is mostly their fixes. Fable still
//               reviews it (same model pin, same JSON contract, same proof-required rule) but with a narrow "verify these fixes" brief,
//               agent `arbiter-fix`, proven at effort `medium` or higher.
// The choice never decides WHETHER Fable runs (every Fable round still needs a proven pass: triage.mjs#fablePendingRounds), only how much
// exploration it is asked for. Anything that is not clearly a fix round is `full`.
import { applyPostMaxDefault, countsTowardCap, postMaxPolicy } from './triage.mjs';
import { DEFAULTS, baseConfigAt, loadConfig } from './config.mjs';
import { GitError, diffFiles, effectiveReviewBase, mergeBase } from './git.mjs';
import { matchAny } from './glob.mjs';
import { isDocPath } from './doc-paths.mjs';
import { prBaseBranch, trustedDefaultBranch } from './risk.mjs';

export const BRIEF_FULL = 'full';
export const BRIEF_FIX_VERIFY = 'fix-verify';

export const BRIEFS = Object.freeze({
  [BRIEF_FULL]: Object.freeze({ brief: BRIEF_FULL, effort: 'high', agent: 'arbiter' }),
  [BRIEF_FIX_VERIFY]: Object.freeze({ brief: BRIEF_FIX_VERIFY, effort: 'medium', agent: 'arbiter-fix' }),
});

// Claude Code's effort levels, lowest first. A fix-verify pass is accepted at its own effort or any higher one (more effort is never a weaker review).
export const EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
export const effortsAtLeast = (min) => (EFFORT_LEVELS.includes(min) ? EFFORT_LEVELS.slice(EFFORT_LEVELS.indexOf(min)) : [min]);

// What a round's stored arbiter data expects. Legacy state (no `brief`), an unknown value a brief on a dispute-mode input or a forced --full (arbiter.forcedFull) is `full`.
export function expectationOf(arbiter) {
  return arbiter?.brief === BRIEF_FIX_VERIFY && arbiter.mode === 'review' && arbiter.forcedFull !== true ? BRIEFS[BRIEF_FIX_VERIFY] : BRIEFS[BRIEF_FULL];
}

// The effort(s) the proof accepts for an expectation: `high` exactly for full; `medium` or higher for fix-verify.
export const acceptedEfforts = (expectation) => (expectation.brief === BRIEF_FIX_VERIFY ? effortsAtLeast(expectation.effort) : expectation.effort);

// The ACCEPT items of the previous COUNTED round (baseOnly / resolutionOnly / fableRefresh rounds are skipped: countsTowardCap), or null
// when there is no such round. An ACCEPT that still waits for a human is not a fix anyone is making, so it does not count.
export function previousAccepts(state, n) {
  const previous = (state?.rounds ?? []).filter((r) => r.n < n && countsTowardCap(r)).at(-1);
  if (!previous) return null;
  const accepted = (previous.items ?? []).filter((i) => i?.final?.decision === 'ACCEPT' && i.final.needsHuman !== true);
  return { round: previous.n, accepted };
}

// The state-only part of the decision. -> { ok: true, previous } | { ok: false, reason }. The caller adds the git part (hard stops, paths).
export function fixRoundCandidate(state, round, { scope }) {
  if (scope !== 'round') return { ok: false, reason: 'whole-pr scope' };
  // The scope label only says an earlier proven pass exists; what the round was diffed against is its review base kind. Allow-list: 'previous'
  // (the plain from..head slice) and a round stored before the kind existed. 'whole-pr' (a conflicting base merge: the whole PR against the new
  // base) is a broad review; 'synthetic' is a tree id (the base branch was merged in cleanly): a hard-stop scan, which walks a commit range, cannot take it;
  // 'resolution' and anything unknown are not a plain fix slice either.
  const kind = round.reviewBaseKind;
  if (kind === 'synthetic') return { ok: false, reason: 'synthetic review base (the base branch was merged in since the previous round: its range cannot be hard-stop scanned against a tree)' };
  if (kind !== undefined && kind !== 'previous') return { ok: false, reason: `review base kind ${JSON.stringify(kind)} (only a plain previous-round slice can be a fix round)` };
  if (round.fableRefresh === true) return { ok: false, reason: 'fable refresh round' };
  if (round.resolutionOnly === true) return { ok: false, reason: 'resolution-only round' };
  const previous = previousAccepts(state, round.n);
  if (previous === null || previous.accepted.length === 0) return { ok: false, reason: 'no accepted item in the previous counted round' };
  return { ok: true, previous };
}

// Whether the next review round leaves what the default branch brought in out of its range (review-round.mjs: only when the PR targets the TRUSTED default branch AND that anchor is trusted: a stacked PR, or an
// anchor the PR could have chosen, reviews the plain previous-head range). -> undefined when it does, else { reason, exact }: a sentence saying why not, and whether the round-head measure is then exactly what the review round does (a stack, an untrusted anchor) or only a guess that may over-count (GitHub could not be read). The PR's base branch is read from GitHub (`gh`: the client of the caller),
// as the review round reads it; a base that cannot be read is no reason to leave anything out (the measure then over-counts, never under-counts).
export function mergeInIneligible({ pr, gh, root, config }) {
  let view;
  try {
    view = gh.prView(pr, ['baseRefName']);
  } catch (err) {
    return { reason: `the PR's base branch could not be read from GitHub (${String(err?.message ?? err).split('\n')[0].slice(0, 160)})`, exact: false };
  }
  const { branch: prBase, untrusted: prBaseUntrusted } = prBaseBranch(view, root, config);
  const { branch: defaultBranch, untrusted } = trustedDefaultBranch(root, config);
  if (prBaseUntrusted !== null || untrusted !== null) return { reason: prBaseUntrusted ?? untrusted, exact: true };
  if (prBase !== defaultBranch) return { reason: `the PR targets ${prBase}, not the default branch ${defaultBranch}`, exact: true };
  return undefined;
}

// The PR's own change growth since round R (#742), for a base merge that conflicted: the added lines of the PR's diff against the default branch now (merge-base(baseRef, head)..head) that its diff at the round
// (merge-base(baseRef, from)..from) did not have, per file, as a multiset of line texts (a range-diff-like measure). Lines main brought in are in neither diff; lines a conflict resolution adds are only in the first. A file
// that did not exist in the PR at the round keeps its status (a new file), one that did becomes 'M'. -> diffFiles-shaped entries (fixRoundScope reads path/status/added). Throws GitError when either diff cannot be read.
function ownChangeFiles({ from, head, baseRef }, o) {
  const then = new Map();
  for (const f of diffFiles(baseRef, from, o)) {
    const counts = new Map();
    for (const l of f.added) counts.set(l.text, (counts.get(l.text) ?? 0) + 1);
    then.set(f.path, counts);
  }
  const out = [];
  for (const f of diffFiles(baseRef, head, o)) {
    const earlier = then.get(f.path) ?? then.get(f.oldPath);
    if (earlier === undefined) { out.push(f); continue; }
    const viaOldPath = !then.has(f.path); // the destination was not in the PR's diff at the round: a fix-round rename of a file the round only edited is still a new file
    const left = new Map(earlier);
    const added = f.added.filter((l) => {
      const n = left.get(l.text) ?? 0;
      if (n > 0) { left.set(l.text, n - 1); return false; }
      return true;
    });
    if (viaOldPath) out.push({ ...f, added });
    else if (added.length > 0) out.push({ ...f, added, status: f.status === 'A' || f.status === 'R' || f.status === 'C' ? 'M' : f.status });
  }
  return out;
}

// The files the fix commits since round R's reviewed head (`from`) changed, measured against the base the NEXT review round would diff from (git.mjs#effectiveReviewBase): what the
// default branch brought in with a clean merge since `from` is left out (#490), as the review packet leaves it out. `baseRef`: the default branch's ref (review-context.mjs#reviewBaseRef).
// `ineligible` (mergeInIneligible's { reason, exact }): the plain from..head measure is kept, with the reason as baseNote; exact (a stack, an untrusted anchor: the review round leaves nothing out either) says so, else (GitHub unreadable) it may over-count.
// A merge that conflicted has no synthetic base: the fix is measured as the PR's OWN change growth (ownChangeFiles, baseKind 'own-change', #742). A base that cannot be worked out (or that measure failing) keeps the plain
// from..head measure and says so in baseNote. A synthetic base is a tree id, which only this caller diffs against (diffFiles' treeBase opt-in).
// -> { files, baseKind: 'previous' | 'synthetic' | 'own-change' | 'round-head', baseNote? }
export function fixRoundFiles({ from, head, baseRef, ineligible }, o) {
  if (ineligible !== undefined) {
    const tail = ineligible.exact
      ? 'which is what its next review round does too (nothing the default branch brought in is left out)'
      : 'it may over-count (once GitHub answers, the next review round leaves out what the default branch brought in); retry when GitHub answers';
    return { files: diffFiles(from, head, o), baseKind: 'round-head', baseNote: `${ineligible.reason}: measured from the round's reviewed head, ${tail}` };
  }
  let note;
  try {
    const since = effectiveReviewBase({ from, forkPoint: mergeBase(baseRef, head, o) }, o);
    if (since.kind === 'previous' || since.kind === 'synthetic') return { files: diffFiles(since.base, head, o, { treeBase: true }), baseKind: since.kind };
    try {
      return { files: ownChangeFiles({ from, head, baseRef }, o), baseKind: 'own-change', baseNote: 'the default branch was merged in with a conflict since this round, so it was measured as the PR\'s own change (its diff against the default branch now, minus its diff at the round): what the default branch brought in is left out, what the conflict resolution added is counted' };
    } catch (err) {
      if (!(err instanceof GitError)) throw err;
      note = `the default branch was merged in with a conflict since this round and the PR's own change could not be measured (${String(err.message).split('\n')[0]}): measured from the round's reviewed head, it may over-count`;
    }
  } catch (err) {
    if (!(err instanceof GitError)) throw err;
    note = `the review base could not be worked out (${String(err.message).split('\n')[0]}): measured from the round's reviewed head, it may over-count`;
  }
  return { files: diffFiles(from, head, o), baseKind: 'round-head', baseNote: note };
}

// ---- #374: the late lane and the fix-round scope ---------------------------------------------------------------------------------------------------------

// The 1-based ordinal of counted round n: how many counted rounds (triage.mjs#countsTowardCap) have a number up to and including n.
export const countedOrdinal = (state, n) => (state?.rounds ?? []).filter((r) => countsTowardCap(r) && r.n <= n).length;

// review.post_max_suggestions for the items of round `round` (#374 PR B): lib/triage.mjs#applyPostMaxDefault with the policy of the working-tree, the fork-point AND the trusted default-branch config
// (round.trustedConfigSha, pinned on every round; 'review' in any, or a config that cannot be read, a missing or null pin included, is off: for a stacked PR the fork point is the unmerged parent's, which
// the author controls) and the round's counted ordinal. `severity` carries what itemSeverity needs (the reviewed diff's files, the working-tree and the trusted config); a diff that cannot be read is null,
// which keeps every ACCEPT. Reads no config at all unless the round is past max + 1. Callers: `arbiter apply` and `triage validate` (the judge); nobody else.
export async function postMaxSettings({ state, round, root }) {
  const max = state?.maxRounds;
  if (!Number.isInteger(max)) return { policy: 'review' };
  const ordinal = countedOrdinal(state, round.n);
  if (ordinal <= max + 1) return { policy: 'review' };
  let configs;
  let severity = null;
  try {
    const loaded = await loadConfig(root);
    const fork = baseConfigAt(round.forkPoint, root);
    const trusted = typeof round.trustedConfigSha === 'string' && round.trustedConfigSha !== '' ? baseConfigAt(round.trustedConfigSha, root) : { ok: false };
    configs = [loaded.ok ? loaded.config : null, fork.ok ? fork.config : null, trusted.ok ? trusted.config : null];
    if (postMaxPolicy(configs) === 'follow-up') {
      let files = null;
      try {
        files = diffFiles(round.forkPoint, round.toHead, { cwd: root });
      } catch { /* an unreadable diff: itemSeverity rates every item high, so nothing is converted */ }
      severity = { state, round: round.n, config: configs[0], files, baseConfig: configs[2] };
    }
  } catch {
    configs = [null];
  }
  return { policy: postMaxPolicy(configs), ordinal, max, severity };
}
export async function postMaxApply(items, ctx) {
  return applyPostMaxDefault(items, await postMaxSettings(ctx));
}

const NEW_EXPORT = /^\s*export\s+(async\s+)?(function|class|const|let)\b/;

// What a FIX round adds, from the round's diffFiles entries: -> { nonTestLines, newFiles, newExports, limit, flagged, reasons }. Pure and total over valid input
// (a bad `files` or a missing config is a TypeError, so a mistake never reads as "not flagged").
// A file is a test only when EVERY config given (the working-tree and the trusted one: a fix round must not widen integrity.test_globs and then add code there) classifies
// it as one; a rename counts as a new file unless both its paths are test paths under every config. Flagged = more non-test added lines than the smallest
// review.fix_round_max_lines, or a new non-test SOURCE file (a document or a review.docs_exempt_paths file is not one). New exports are counted for the text only.
export function fixRoundScope({ files, config, configs }) {
  if (!Array.isArray(files)) throw new TypeError('fixRoundScope: files must be an array');
  const all = configs ?? (config ? [config] : []);
  if (all.length === 0 || all.some((c) => c === null || typeof c !== 'object')) throw new TypeError('fixRoundScope: a config is required');
  const isTest = (p) => all.every((c) => matchAny(p, c.integrity?.test_globs ?? DEFAULTS.integrity.test_globs, { nocase: true }));
  const isDocument = (p) => isDocPath(p) || all.some((c) => (c.review?.docs_exempt_paths ?? []).includes(p));
  const limit = Math.min(...all.map((c) => (Number.isInteger(c.review?.fix_round_max_lines) ? c.review.fix_round_max_lines : DEFAULTS.review.fix_round_max_lines)));
  let nonTestLines = 0;
  let newExports = 0;
  const newFiles = [];
  for (const f of files) {
    const paths = [...new Set([f.oldPath, f.newPath, f.path].filter(Boolean))];
    if (paths.every(isTest)) continue;
    const shown = f.path ?? f.newPath ?? f.oldPath;
    const added = Array.isArray(f.added) ? f.added : [];
    nonTestLines += added.length;
    newExports += added.filter((l) => NEW_EXPORT.test(String(l?.text ?? ''))).length;
    const isNew = f.status === 'A' || f.status === 'R' || f.status === 'C';
    if (isNew && !isDocument(shown)) newFiles.push(shown);
  }
  const reasons = [];
  if (nonTestLines > limit) reasons.push(`${nonTestLines} non-test added lines > ${limit} (review.fix_round_max_lines)`);
  if (newFiles.length > 0) reasons.push(`new non-test file${newFiles.length === 1 ? '' : 's'}: ${newFiles.slice(0, 5).join(', ')}${newFiles.length > 5 ? ` (+${newFiles.length - 5} more)` : ''}`);
  return { nonTestLines, newFiles, newExports, limit, flagged: reasons.length > 0, reasons };
}
