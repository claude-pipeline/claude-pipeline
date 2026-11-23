// What a non-zero exit of the merge command means once GitHub says the PR is MERGED (used by both routes of commands/merge.mjs).
//
// `pipeline merge` runs the project's merge command with cwd = the PR's worktree, where the PR branch is checked out. gh
// `pr merge --delete-branch` merges, then tries to check out the base branch there: git refuses because the base is checked out in
// another worktree, and gh exits 1 AFTER the merge without deleting the local branch. gh returns on that error BEFORE it deletes the
// remote branch, so the remote branch is left too unless the repository deletes branches on merge (delete_branch_on_merge). That one case
// is named (localCleanup); anything else keeps the old note and now carries the command's output so the next unknown cause has evidence.
//
// This never decides merged / not merged: GitHub's state does. It only words a merge that already happened.
import { tailLines } from './cmd-io.mjs';

export const OLD_NOTE = 'the merge command exited non-zero but the PR is MERGED';
export const WORKTREE_NOTE = 'merged; gh could not switch away from or delete the local branch because a worktree holds it, and it returns there before deleting the remote branch, so that is left too unless the repository deletes branches on merge (delete_branch_on_merge); remove the worktree as usual and delete the remote branch if it is still there';

// git's own messages (C locale; a translated one falls to the unknown-cause path).
const GIT_DIAGNOSTIC = "(?:fatal: '[^']+' is already (?:checked out at|used by worktree at) '[^']+'|error: Cannot delete branch '[^']+' (?:checked out|used by worktree) at '[^']+')\\.?";
// A whole line that is one such diagnostic, optionally wrapped by gh on the same line.
const DIAGNOSTIC_LINE = new RegExp(`^\\s*(?:(?:failed to run git|failed to delete local branch \\S+):\\s*)*${GIT_DIAGNOSTIC}\\s*$`);
const ERROR_LIKE = /\b(?:error|fatal|failed|denied|cannot|could not|unable)\b/i;

export const commandTail = (ran) => tailLines(`${ran.stdout}${ran.stderr ? `\n${ran.stderr}` : ''}`, 30);

// The worktree case needs ALL of: exit code exactly 1, not timed out, no signal, at least one git worktree diagnostic, and every
// error-looking line of the FULL output (not the 30-line tail) is such a diagnostic.
function isWorktreeCase(ran) {
  if (ran.code !== 1 || ran.timedOut || ran.signal) return false;
  const lines = `${ran.stdout ?? ''}\n${ran.stderr ?? ''}`.split(/\r?\n/);
  let found = false;
  for (const line of lines) {
    if (DIAGNOSTIC_LINE.test(line)) { found = true; continue; }
    if (ERROR_LIKE.test(line)) return false;
  }
  return found;
}

// #567: gh's auto-merge request sometimes refuses an already-green PR with this GraphQL error, nothing merged and auto-merge off; a plain re-run works. The matcher accepts EXACTLY two whole lines
// (the doubled "Pull request" is what gh printed in a real capture), needs at least one, ignores blank lines, and any other line (a second diagnostic, a prefix or suffix, a wrapper's banner) means false:
// a command wrapped by another tool (an npm banner) never matches, a false negative by design. Exit code exactly 1, no timeout, no signal.
const CLEAN_STATUS_LINES = new Set([
  'GraphQL: Pull request Pull request is in clean status (enablePullRequestAutoMerge)',
  'GraphQL: Pull request is in clean status (enablePullRequestAutoMerge)',
]);
export function isCleanStatusRefusal(ran) {
  if (ran.code !== 1 || ran.timedOut || ran.signal) return false;
  let found = false;
  for (const raw of `${ran.stdout ?? ''}\n${ran.stderr ?? ''}`.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    if (!CLEAN_STATUS_LINES.has(line)) return false;
    found = true;
  }
  return found;
}

// The fields a NOT-merged failure gets when that refusal is the whole story AND the state is proven clean: auto-merge confirmed disabled (absence of a flag is not proof), the PR state after the disable
// was read and is still OPEN (a PR closed meanwhile is a real reason, not a retry), and the wait itself read the PR. A zero wait (every non-zero exit) that fails its one read ends as a 'timeout', not an 'error', so the proof is the outcome's `readOk`: ONLY a 'timeout' with `readOk: true` is proof (a 'timeout' without it, an 'error', a 'blocked' or a 'closed' outcome is not: those are real reasons the merge was refused, see waitFailureNote). Then a fresh run of the merge command (every gate, hold and recovery step again) is safe; this never retries anything itself.
export function cleanStatusRetry(ran, outcome, abandoned) {
  if (!isCleanStatusRefusal(ran) || !(outcome?.state === 'timeout' && outcome.readOk === true) || abandoned?.autoMergeDisabled !== true || abandoned.readError || abandoned.state !== 'OPEN') return {};
  return {
    retryable: 'clean-status',
    next: "GitHub refused to arm auto-merge on a PR it already sees as mergeable; run this same merge once more (a fresh run re-checks everything); the owner's approval still applies when the dry run shows the same closing lines",
  };
}

// What a zero-wait read found when the merge command failed: a 'blocked' outcome's problems or a 'closed' PR, as a sentence for the failure reason (null for any other outcome).
export function waitFailureNote(outcome) {
  if (outcome?.state === 'blocked') return `a blocker appeared while waiting: ${(outcome.problems ?? []).join('; ')}`;
  if (outcome?.state === 'closed') return 'the PR was closed without merging';
  return null;
}

// The fields to add to a MERGED result. Exit 0 adds nothing.
export function classifyMergeCommand(ran) {
  if (ran.code === 0) return {};
  const commandOutput = commandTail(ran);
  if (isWorktreeCase(ran)) return { commandExitCode: ran.code, localCleanup: { skipped: true, reason: 'worktree' }, commandOutput, note: WORKTREE_NOTE };
  return { commandExitCode: ran.code, commandOutput, note: OLD_NOTE };
}
