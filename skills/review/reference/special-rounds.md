# Special rounds and the one-command-at-a-time flow

The old, still valid way to run a round one command at a time (what `P round codex` / `P round publish` chain), and the special cases: an interrupted round (discard-round), `baseOnly`, `resolutionOnly`, `empty-range`, base/head moves, a job that is `lost`, `replaced` or `missing` (reconcile: never discard a round because of `replaced` alone, another session may own it).



## Old rule 5 (jobs by hand)

5. Anything over 2 minutes runs as `P job start <name> -- <command>`, then `P job wait <name> --run-id <runId> --timeout 540`
   until `state` is `done` (`replaced`/`lost` ⇒ start it again once). Read `exitCode` (the command's own code) and the JSON in `tail`.

## Old 2.1 Codex (one command at a time; the substitute path is in substitute.md)

1. **Codex.** base: round 1 `git merge-base origin/<default_branch> HEAD`, later the previous round's `toHead` (`.review/state.json`);
   head: the pushed HEAD; `P state outcome` `nextRound.base` is the base (the merge base when `wholePrOwed`: that round reviews the whole PR). BEFORE every codex-review call run it with `--plan` (same `--pr --round --base --head`) and pass its `expectedEffort` as `--effort`: codex-review refuses any other.
   `P job start codex-rR -- node ~/.claude/pipeline/bin/pipeline.mjs codex-review --pr N --round R --base <base> --head <head> --effort <effort>`,
   then `P job wait codex-rR --run-id <runId> --timeout 540` until `state` is `done` (Old rule 5), and read `exitCode` and the JSON in `tail`. Exit 2 `empty-range`: the "fix" changed no code, go back to step 5. Exit 2 `base-mismatch`: the base is not the one codex-review admits (the previous round's `toHead`, or the merge base for round 1 / a whole-PR round): recompute and rerun. Exit 2 `head-moved`: the PR head moved while Codex ran: recompute the head and rerun. Exit 3 with `substitute.eligible` (a real quota stop, a refused model (`reason: model`), or `reason: withheld`) ⇒ `reference/substitute.md`; not eligible ⇒ rule 2 of SKILL.md.
   An interrupted round (no triage comment yet): `P state discard-round --round R --pr N` before rerunning it.
   `baseOnly: true` (only main merged in): Codex did not run, no items, not counted; it carries the last reviewed result forward.
   `resolutionOnly: true` (a main conflict resolved by choosing lines): a real review of just the resolution, triaged as usual
   (an ACCEPT still needs its fix round) but not counted; `resolutionIneligible: "<reason>"` ⇒ a counted round: `reviewBaseKind: conflict` when the PR's own changes since the last review plus the conflict resolutions can be shown (typed lines or own commits after a conflicting main merge; the diff leaves main's commits out, and the prompt carries the conflict records), else the whole PR. Read the records: a file main deleted or moved that the head keeps is judged there, not in the patch.

## Conflict with the base (merge commit alone, a pre-push hook that refuses it)

In a repo whose base branch has a merge queue, main is merged into a PR branch only when GitHub reports the PR as CONFLICTING (`P ci-wait` ends `conflicting`; `gh pr view N --json mergeable`), as ONE hand-made merge commit with nothing else in it, pushed and reviewed in its own round BEFORE any other commit: that is what lets the round be `resolutionOnly` (free, uncounted). The code enforces the shape: `resolutionReviewBase` (`lib/git.mjs`) accepts a range only when every first-parent commit between the last reviewed head and the head is a merge of the base (`history-nonmerge` otherwise), and a round reviews the checked-out HEAD (`head-moved` if it is not).

**A repo hook can refuse the lone merge.** EagleWatch's `.githooks/pre-push` runs `check-migration-versions`: when main brought a migration whose version stamp clashes with one of the branch's, the hook refuses the push of the merge commit, and the fix (renaming the branch's migration) is a SECOND commit. The pipeline does NOT support "merge commit, then fix commit" pushed together as a resolution-only round: that range fails `history-nonmerge`, so it is an ordinary counted whole-PR round (`resolutionIneligible: "history-nonmerge: ..."`). Not changed in code on purpose: reviewing an intermediate commit would break the rule that a round reviews the pushed, checked-out HEAD (`head-moved`, the round state, the Fable proof and `review-complete` all key on it). So, when the hook refuses the lone merge:

1. Make the merge commit alone, locally; do not add the fix yet. `P redraft --pr N` (Rule 8) before anything is pushed.
2. The session NEVER bypasses a hook; the bypass is the owner's. Ask the owner (AskUserQuestion, one click), first option: the owner pushes the lone merge commit with the hook's documented bypass (`git push` with its no-verify flag), so the round stays free; second option: push the merge and the migration rename together and accept a counted whole-PR round. The question names the PR, the clash and what each costs (correctness before the free round).
3. First answer: the owner pushes the merge commit from the PR's worktree with the bypass. Run the resolution round on that head (`resolutionOnly`, free). Then commit the rename and push it normally (the hook passes: the clash is gone); the next round is an ordinary fix check of just that commit (its base is the merge head, which already contains main, so `reviewBaseKind` is `previous`). The PR stays a draft until the rename is pushed, so no ready-era CI runs on the clashing head.
4. Second answer: one push of both commits, a normal counted round (a `conflict` round when the merge conflicted and the evidence is complete, else the whole PR), nothing special.

## Old 2.5 and 2.6 (publish, fix, outcome)

5. **Publish and fix.** `P triage cap-defer --pr N --round R` FIRST (what `round publish` runs: at the last allowed round, accepts that are all low become follow-ups unapplied; `applied: false` is the normal answer, it never stops the flow; then `followups create` for EACH round in its `rounds`), then `P comment --pr N --kind triage`, then `P followups create --round R` for FOLLOW-UP items, then the triage comment again
   (issue links). ACCEPT items: one `implementer` dispatch with `P state show --round R --accepted`; it fixes (a test only when the accepted item is a behaviour bug or a database / permission item, per the implementer's test rules), runs `verify.quick`, commits (same line: return immediately when done; no background work; waits only via `job wait`, max 3).
   Tell it: "fix only the accepted items; no new mechanism, option or helper module". Past ~60 tool calls the previous implementer is not continued: dispatch a fresh one with only the accepted items (the output of that `P state show --round R --accepted`) and the worktree. An empty leg (no summary / diff stat AND `git rev-parse HEAD` unchanged) is `stalled`, not done (`build.md` step 2): extend once or dispatch fresh; never push or mark-implemented on it. BEFORE the push run `P state fix-scope --round R` (read-only: what the fix commits since round R's head add): `flagged: true` (more non-test lines than `review.fix_round_max_lines`, or a new non-test source file; new exports are advisory text only) ⇒ AskUserQuestion with the `reasons`: "its own PR" / "plan first" / "push as is", and NO push until the owner has answered (a prompt, never a gate: an unflagged or unmeasurable result pushes as usual). Then push (Rule 8). Then **`P state mark-implemented --ids <ids>`** for each fixed ACCEPT item: `review-complete` refuses an ACCEPT that is not marked, from ANY round,
   and exit 2 `no-code-change` means the fix changed no code (back to the implementer; marking never replaces a fix).
6. **Outcome.** `P state outcome`: `clean` ⇒ leave the loop; `needsHuman` non-empty ⇒ see Rulings; more rounds left ⇒ round R+1 (the Codex fix
   check reviews only what changed since this round's head); none left ⇒ park, cause `unresolved: <ids>`, except one case: `reachedMax`, no
   `extraRound`, `owner_approval: chat`, and the fixes are pushed and `verify.quick` is green ⇒ ask the owner for one more round (Extra round, below): the ask shows rounds, booked cost and open-item severity, and when only low-severity fixes are left it recommends filing them as follow-ups instead (`reference/owner-merge.md`, Follow up instead of a round). Label mode ⇒ park.
