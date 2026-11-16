// The review's status as the owner reads it: how many rounds ran, what they cost, which items are open and how serious, why the review is not clean. One gatherer
// feeds both the extra-round ask (`triage round-request`) and the park comment (`comment --kind needs-human`), so the two cannot drift. Display only: nothing here decides
// anything. Untrusted text (titles, categories) goes through asciiLine inside round-ask.mjs.
import { diffFiles, git, isAncestor, mergeBase, mergeTree, resolutionReviewBase, revParse } from './git.mjs';
import { trustedBase } from './risk.mjs';
import { diffStats } from './diff.mjs';
import { costFrom, notCleanReasons, openItems, roundsFrom, statusLines } from './round-ask.mjs';
const plural = (n, one) => `${n} ${n === 1 ? one : `${one}s`}`;
import { currentContentHash, refreshBaseRef, reviewBaseRef } from './review-context.mjs';
import { readSummaryComment } from './summary-comment.mjs';
import { asciiLine, roundOutcome } from './triage.mjs';
import { classifyReview, requiredBase } from './review-round.mjs';
import { wholePrOwed } from './review-route.mjs';

// The config committed at the default branch's fork point (the trusted one rateBranch also reads: risk.mjs#trustedBase, anchored on the remote's default branch, not the
// working-tree config), for the union of the sensitive-path lists: a PR must not shrink its own list.
// -> { config, problem }: unreadable gives config null (its lists count as empty, nothing is loosened) and says why.
export function trustedBaseConfig(root, config) {
  try {
    const { trusted, mismatch } = trustedBase({ root, head: 'HEAD', config });
    if (!trusted.ok) return { config: null, problem: trusted.reason };
    // a readable committed config that names another default_branch still counts for the union (its lists are kept); the mismatch is the problem
    return { config: trusted.config, problem: mismatch };
  } catch (err) {
    return { config: null, problem: String(err?.message ?? err).split('\n')[0].slice(0, 160) };
  }
}

// The files of the PR's reviewed diff (the last round's head against where the branch forked from the default branch): what a finding's location must resolve to.
// null (and a warning from the caller) when it cannot be read. Throws on nothing the caller needs to handle.
export function reviewedDiff(root, config, state) {
  const toHead = state.rounds.at(-1)?.toHead;
  if (typeof toHead !== 'string' || toHead === '') return { files: null, problem: 'the last round records no head' };
  try {
    return { files: diffFiles(reviewBaseRef(root, config), revParse(toHead, { cwd: root }), { cwd: root }), problem: null };
  } catch (err) {
    return { files: null, problem: asciiLine(err?.message, 160) };
  }
}

// The commits since the last reviewed head (what deferring would take out), and, when nothing explains them as fixes, how much changed.
export function sinceLastReview(root, config, state, { withChanges }) {
  const anchor = state.rounds.at(-1)?.toHead;
  const none = { anchor: null, count: 0, commits: [], changed: null };
  if (typeof anchor !== 'string' || anchor === '') return none;
  const o = { cwd: root };
  const full = revParse(anchor, o);
  const log = git(['log', '--format=%h %s', `${full}..HEAD`], o).split('\n').filter(Boolean);
  let changed = null;
  if (withChanges && log.length > 0) {
    const files = diffFiles(full, 'HEAD', o).filter((f) => f.path !== config.agent_log && f.newPath !== config.agent_log);
    changed = { commits: log.length, files: files.length, lines: diffStats(files).changedLines };
  }
  return { anchor: full.slice(0, 12), count: log.length, commits: log.slice(0, 20).map((l) => asciiLine(l, 100)), changed };
}

// Everything the ask and the park comment both show: { outcome, rounds, cost, diff, since, open, notClean, trusted } (trusted: trustedBaseConfig, read once here). A cost, diff, listing or severity problem becomes a warning (pushed to
// `warnings`) and a degraded value, never a throw; only the base-ref refresh and the content hash can throw, and the callers decide what that means.
export function gatherRoundStatus({ root, config, state, pr, gh, warnings }) {
  refreshBaseRef(root, config);
  const hash = currentContentHash(root, config);
  const outcome = roundOutcome({ ...state, currentContentHash: hash });
  const rounds = roundsFrom(state);
  let cost = null;
  try {
    const found = readSummaryComment(gh, pr);
    cost = found.status === 'ok' ? costFrom(found.record, rounds.reviewed, state) : null;
    if (cost === null) warnings.push(found.status === 'ok' ? 'the run record holds no booked cost yet' : `no usable run record on the PR (${found.status}): cost not shown`);
  } catch (err) {
    warnings.push(`the booked cost could not be read (${asciiLine(err?.message, 120)})`);
  }
  const diff = reviewedDiff(root, config, state);
  let since = { anchor: null, count: 0, commits: [], changed: null };
  try {
    since = sinceLastReview(root, config, state, { withChanges: !outcome.coverageValid && outcome.newAccepted.length === 0 });
  } catch (err) {
    warnings.push(`the commits since the last review could not be listed (${asciiLine(err?.message, 120)})`);
  }
  const trusted = trustedBaseConfig(root, config);
  const open = openItems(state, outcome, { config, files: diff.files, baseConfig: trusted.config, baseProblem: trusted.problem }, warnings);
  // Only while an item is open (round-ask.mjs warns the same way): with nothing open there is no severity to guess (#368).
  if (diff.problem && open.length > 0) warnings.push(`the reviewed diff could not be read (${diff.problem}): every open item is shown as high`);
  const notClean = notCleanReasons(outcome, since.changed);
  return { outcome, rounds, cost, diff, since, open, notClean, trusted };
}

// What the next review round would be, so the owner sees what the extra round buys BEFORE asking for it (display only: it decides nothing, `codex-review` decides the real
// round). It uses the same classification admitRound makes (review-round.mjs#classifyReview: the review base and kind, the resolution-only proof) without the cap, without
// writing a review artifact and without touching a grant; git writes at most the trial merge's objects. A judge-to-Fable escalation and a PR that targets another branch than the
// default are not modelled, so the free kinds (base-only, resolution) are worded as conditional (the real round is a counted one then: whole-PR for the escalation).
// -> { nextRound: { prediction: true, previousClean, sinceReviewed: {merges, ownCommits} | {rewritten: true, commits}, kind, resolutionIneligible?, alternative? }, lines: ['Prediction: ...'] }. Throws on a git failure:
// the caller turns that into a warning.
export function predictNextRound({ root, config, state, head }) {
  const o = { cwd: root };
  const last = state.rounds.at(-1);
  if (last === undefined || typeof last.toHead !== 'string' || last.toHead === '') throw new Error('no round to predict from');
  const anchor = revParse(last.toHead, o);
  const headFull = revParse(head, o);
  const previousClean = roundOutcome({ ...state, currentContentHash: last.contentHashAtToHead }).clean;
  let merges = 0;
  let ownCommits = 0;
  const mergeCommits = []; // [sha, ...parents] of every merge on the first-parent chain
  const chain = git(['rev-list', '--first-parent', '--parents', headFull, `^${anchor}`], o).split('\n').filter(Boolean);
  // The last reviewed head is on HEAD's first-parent chain exactly when the oldest listed commit's first parent is the anchor (the walk resolutionReviewBase's history rule makes,
  // history-not-first-parent). After a rewritten history the list holds the default branch's commits too, so nothing below may be read as "the PR's own commits".
  const anchorOnChain = chain.length > 0 && chain.at(-1).split(' ')[1] === anchor;
  const rewritten = chain.length > 0 && !anchorOnChain;
  for (const line of chain) {
    const parents = line.split(' ');
    if (parents.length > 2) {
      merges += 1;
      mergeCommits.push(parents);
    } else ownCommits += 1;
  }
  const baseRef = reviewBaseRef(root, config);
  const forkPoint = mergeBase(baseRef, headFull, o);
  const base = requiredBase(state, forkPoint);
  const { review, resolutionIneligible } = classifyReview({
    state, wholePr: wholePrOwed(state), base, forkPoint, trusted: true,
    tryResolution: () => resolutionReviewBase({ from: base, forkPoint, head: headFull, baseRef }, o),
  }, o);
  const baseOnly = review.kind === 'synthetic' && git(['diff', '--name-only', `${review.base}..${headFull}`], o) === '';
  const kind = baseOnly ? 'base-only' : review.kind;
  const nextRound = { prediction: true, previousClean, sinceReviewed: rewritten ? { rewritten: true, commits: chain.length } : { merges, ownCommits }, kind };
  if (resolutionIneligible !== undefined) nextRound.resolutionIneligible = asciiLine(resolutionIneligible, 160);
  // The free kinds are conditional: a judge-to-Fable escalation and a PR that does not target the default branch are not modelled above, and either makes the real round counted (whole-PR for the escalation, the range since the last reviewed head for another base branch).
  const unlessCounted = ' (unless the reviewer escalates from judge to Fable, or the PR does not target the default branch: then it is a counted round, whole-PR when the reviewer escalates)';
  // Nothing to revert once the range is already free (base-only), or, with no merge in it, once the content is back to what the last round reviewed (a revert was already made).
  let contentRestored = false;
  if (merges === 0 && anchorOnChain) {
    try {
      contentRestored = currentContentHash(root, config) === last.contentHashAtToHead;
    } catch { /* an unreadable hash leaves the hint shown */ }
  }
  if (previousClean && ownCommits > 0 && anchorOnChain && kind !== 'base-only' && !contentRestored) {
    const revert = `revert the ${plural(ownCommits, 'own commit')} since the last reviewed head (newest first)`;
    // With a merge in the range, nothing is promised after the revert: the filter below only decides WHICH wording shows, and the owner confirms by running round-request again
    // (the revert's result is the only proof: identical edits on both sides, for one, are removed by the revert but kept by the synthetic base). The filter: a clean trial merge
    // (kind 'synthetic') AND every merge in the range is a clean, unedited, two-parent merge of the default branch: exactly two parents, the second on the default-branch ref (the
    // check resolutionReviewBase's history rule makes), and the merge commit's tree equal to the clean trial merge of its parents. A conflicting merge keeps the PR whole-PR (the
    // reverted commits stay in the history, so the resolution-only proof refuses too), and a merge of a topic branch or an edited merge leaves its changes in the range.
    const cleanDefaultMerge = ([sha, p1, p2, ...more]) => {
      if (more.length > 0 || !isAncestor(p2, baseRef, o)) return false;
      try {
        const trial = mergeTree(p1, p2, o);
        return trial.clean && trial.tree === revParse(`${sha}^{tree}`, o);
      } catch {
        return false; // a merge that cannot be proven is not promised
      }
    };
    nextRound.alternative = merges === 0
      ? `${revert}; that restores the reviewed content and needs no round`
      : review.kind === 'synthetic' && mergeCommits.every(cleanDefaultMerge)
        ? `${revert}; a free base-only recording may then follow (the default branch merges cleanly; run round-request again after the revert to confirm)${unlessCounted}`
        : `${revert}; that does not make the next round free here: a merge since the last reviewed head is not a clean, unedited merge of the default branch, so a counted round would still follow`;
  }
  const words = {
    'base-only': `base-only: only the default branch was merged in, free, no Codex, not counted${unlessCounted}`,
    resolution: `resolution-only: a real review of the conflict resolution, not counted, no owner grant${unlessCounted}`,
    previous: 'a counted round on the commits since the last reviewed head',
    synthetic: 'a counted round on the changes since the last reviewed head (the new default branch merged into it)',
    'merge-base': 'a counted whole-PR round',
    'whole-pr': 'a counted whole-PR round',
  }[kind] ?? `a ${kind} round`;
  const lines = [
    `Prediction: the previous round was ${previousClean ? '' : 'not '}clean.`,
    rewritten
      ? `Prediction: the last reviewed head is not in HEAD's first-parent history (rewritten history); ${plural(chain.length, 'commit')} since it.`
      : `Prediction: ${plural(merges, 'merge commit')} and ${plural(ownCommits, 'own commit')} since the last reviewed head.`,
    `Prediction: the next round would be ${words}${nextRound.resolutionIneligible ? `; the conflict resolution could not be reviewed alone (${nextRound.resolutionIneligible})` : ''}.`,
    ...(nextRound.alternative ? [`Prediction: No-round alternative: ${nextRound.alternative}.`] : []),
  ];
  return { nextRound, lines: lines.map((l) => asciiLine(l, 500)) };
}

const SEVERITY_WARNING = /^(severity could not be judged|the reviewed diff could not be read)/;

// The status lines of the park comment (`comment --kind needs-human`): the ask's rounds / cost / open / not-clean lines without its recommendation (the park is the owner's
// decision). [] when the state is not this PR's or no round ran yet (nothing to report). NEVER throws: a failure drops the lines it touches and says so, so the park
// comment is always written. Every line is plain ASCII and one line.
export function parkStatusLines({ root, config, state, pr, gh }) {
  if (!state || state.pr !== pr || !Array.isArray(state.rounds) || state.rounds.length === 0) return [];
  const warnings = [];
  try {
    if (!config) throw new Error('pipeline.yml could not be read');
    const g = gatherRoundStatus({ root, config, state, pr, gh, warnings });
    const lines = statusLines({ rounds: g.rounds, cost: g.cost, open: g.open, notClean: g.notClean, asking: false });
    // Severity is what the Open line adds: when it could not be judged the line is dropped rather than shown as a guess.
    const openAt = lines.findIndex((l) => l.startsWith('Open:'));
    if (openAt >= 0 && warnings.some((w) => SEVERITY_WARNING.test(w))) lines[openAt] = 'Open: not available (severity could not be judged).';
    return lines.map((l) => asciiLine(l, 500));
  } catch (err) {
    let rounds = null;
    try {
      rounds = statusLines({ rounds: roundsFrom(state), cost: null, open: [], notClean: [], asking: false })[0];
    } catch { /* the rounds line is the one that needs only the state */ }
    return [...(rounds ? [asciiLine(rounds, 500)] : []), asciiLine(`Cost and open items: not available (${asciiLine(err?.message, 120)}).`, 500)];
  }
}
