# Round diff after a conflicting main merge: review the PR's own changes, not the whole PR (#423)

> **For agentic workers:** build through the `review` skill (implementer agent, task by task). Steps use checkbox (`- [ ]`) syntax.

**Goal:** When the branch merged the default branch since the last round and that merge CONFLICTED, the next counted round reviews the PR's own changes since the last round plus visible evidence of how each conflict was resolved, instead of the whole PR against the new base, but only where that evidence can be complete; everywhere else it stays whole-PR.

**Architecture:** Today `classifyReview` (pipeline/lib/review-round.mjs) tries, after a conflicting trial merge, the free resolution-only proof (`resolutionReviewBase`), and on any refusal falls back to `{ base: forkPoint, kind: 'whole-pr' }`. This plan adds one step before that fallback: a new counted review kind `'conflict'`. Its base is the marker tree the resolution round uses (`mergeTreeDetailed(from, forkPoint).tree`). Admission requires a history rule, an attribute rule over every path both sides changed, and a per-conflict evidence rule (Task 1). Each conflicted path is then either a text conflict whose resolution appears in the patch, or a non-text conflict described by a record. Codex, the Opus substitute and Fable all get the same note and records (Tasks 2–3).
Second part: round-request's "changed since the last review: N commits, N files, N lines" counts only the PR's own changes, when that can be established (Task 4). EW #1901 round 16 reported "11 commits, 232 files, 13405 lines" for one function and three test files.

**Tech Stack:** Node ESM, `node:test`, git ≥ 2.38 (`merge-tree --write-tree`).

**Spec:** issue claude-pipeline#423 (EW #1901 rounds 13/16; EW #2395 round 5: a directory-rename + content-conflict catch-up cost a counted whole-PR round). Related: EW #2001, #2039. Codex plan review 2026-11-20 (session 01a1f83a, medium): 3 P1 + 4 P2 + 1 P3; one recheck: 3 P1 (per-block evidence, rename-aware attributes, Fable evidence) + 2 partial rows; all folded in below. No third Codex pass (owner rule); the Fable plan pass is the adversarial check.

## Global Constraints

- `'conflict'` is tried ONLY where `'whole-pr'` comes from a conflicting trial merge today: the PR targets the trusted default branch with a trusted anchor, it is not `wholePrOwed` (that keeps kind `'merge-base'`), it is not `escalated` (keeps `'whole-pr'`), and the resolution proof refused.
- Any doubt means `'whole-pr'` exactly as today. That covers every failed admission rule, a git error, git < 2.38, and zero conflicted paths.
- `'conflict'` rounds COUNT toward the round cap. No change to cap, grants or `resolutionOnly`. A new protected kind `'conflict-merge'` keeps them off the small-fix lane.
- The base must be rebuildable on another clone and must fail closed otherwise. `ensureReviewBase` re-runs the full admission (attribute and evidence rules on the recomputed complete conflict set, not the stored display list) and requires the same tree id. A missing `fromHead` / `forkPoint` commit gives `review-base-unavailable`.
- Display lists (conflicted paths, records) are capped at 50 entries. More than 50 conflicted paths means `'whole-pr'`, so the evidence is never truncated.
- Fable's first proven pass of a PR still reads the whole PR (`writeFableDiff` scope rules unchanged). A `'conflict'` round is never a fix-verify round (`fixRoundCandidate` refuses every kind but `'previous'`; no change).
- `pipeline/lib/git.mjs` is vendored (`commands/vendor.mjs` LIBS): run the vendor drift test after changing it.
- Rollback note for the PR body: an older pipeline reading a recorded `'conflict'` round does NOT fail closed on its own (`ensureReviewBase` returns the cached marker tree id when it exists, and its input carries no records or sides file), so a state holding such a round is written as state version 11 and an older pipeline refuses it.

## Admission rules for `'conflict'` (Task 1 implements; all must hold)

- **H (history).** `from` is on HEAD's first-parent chain. Walk the WHOLE chain `from..head`, not stopping at the first ordinary commit. Ordinary (one-parent) commits are allowed. Every merge has exactly two parents, and its second parent is an ancestor of `baseRef` (`origin/<trusted default>`). A rewritten branch whose old head still resolves locally fails H. So do a foreign merge anywhere in the chain and an octopus merge.
- **A (attributes), rename-aware.** For each side, diff `merge-base(from, forkPoint)` to that side with rename detection under `MERGE_CONFIG`'s forced rename settings. Map every changed entry to its merge-base path. Then, for every merge-base path that BOTH sides changed, none of `STRICT_MERGE_ATTRS` (`merge`, `conflict-marker-size`, `diff`) may be set on the merge-base path or on either side's destination path. The same goes for every conflicted path and every path ort's messages name. This catches a driver that silently resolves a path the conflict list never names, including a rename destination (Codex recheck P1-2: PR renames old→new and edits it, main edits old, `merge=union` on new). If git reports the rename limit was hit, A fails.
- **E (evidence).** Classify each conflicted path (from `mergeTreeDetailed(...).conflicts`) after dropping informational types (`Auto-merging` and any other non-`CONFLICT (…)` type). Reuse the type/stage classifier `resolutionReviewBase` already applies (~git.mjs:299) rather than a new string test (Codex recheck P1-1).
  - **Text conflict.** The only remaining type is `CONFLICT (contents)`; stages 1, 2 and 3 are all present in `TEXT_MODES` (no stage 1 means add/add, which is a record); the marker-tree blob is not binary. Parse the marker-tree blob's conflict blocks with the parser the resolution proof uses (`parseConflictBlocks`). EVERY block must be edited in HEAD: its full marker text (`<<<<<<<` line through `>>>>>>>` line) must not occur verbatim in HEAD's blob at that path. So each block's resolution is in the patch, and one block resolved cannot hide another left as committed markers. A block found verbatim fails E. If the parser gives up, E fails.
  - **Record.** Any other conflict type: modify/delete, rename/delete, file location, add/add, binary contents. It gets a record: `{ path, types, messages (ort's text, one line each, ≤ 300 chars), stages: { 1|2|3: { mode, oid } | absent }, head: { mode, oid } | absent, headEquals: 'ours'|'theirs'|'base'|'tree'|'none' }`. For a file-location / rename record, `head` is also read at every path ort's message names.
  - A symlink (120000) or gitlink (160000) mode on any stage or on HEAD fails E.
- **X (exportable evidence).** Every record's stage blobs must be readable by OID (`git cat-file -e <oid>`), so the reviewers without a shell (Fable, the Opus substitute) can be handed them (Tasks 2–3). A missing object fails X.

---

### Task 1: `conflictReviewBase` and its rebuild

**Files:**
- Modify: `pipeline/lib/git.mjs` (new export after `resolutionReviewBase` ~380; `ensureReviewBase` ~391-425; the comment above `effectiveReviewBase` ~193-201)
- Test: `test/git-resolution.test.mjs` (reuse `conflictRepo`, `resolveMerge`, the fresh-clone fixture ~825, the attribute loop ~324, the union-driver control ~934)

**Interfaces:**
- Produces: `conflictReviewBase({ from, forkPoint, head, baseRef }, o) -> { base: string, conflicted: string[], conflictedCount: number, records: ConflictRecord[] } | { unavailable: string }`. The `unavailable` codes are: `git-too-old`, `no-conflict`, `history: …`, `attribute: …`, `evidence: …`, `export: …`, `too-many-conflicts`, `git-error: …`.
- Produces: `ensureReviewBase(round, o)` handles `reviewBaseKind === 'conflict'` by re-running `conflictReviewBase({ from: round.fromHead, forkPoint: round.forkPoint, head: round.toHead, baseRef: <round.forkPoint itself, for the ancestor test> })` and requiring `base === round.reviewBase`.

- [ ] **Step 1: Failing tests**, each naming the hiding it prevents:
  - `conflictReviewBase: content conflict resolved with a typed line, plus an own commit after the merge: base is the marker tree; tree..head shows the typed line and the own commit; a file only main changed is absent`.
  - `conflictReviewBase: the #2395 shape, with NO own commit (PR adds dir/x, main renames dir→new/, plus a content conflict in another file): the content resolution is in the patch and dir/x has a file-location record whose head entry names new/x` (Codex P1-1: an empty or near-empty patch must still carry evidence).
  - `conflictReviewBase: modify/delete where head keeps the PR's modified file: a record with headEquals 'ours' (main deleted it); binary conflict keeping ours: a record` (Codex P1-1).
  - `conflictReviewBase: head keeps the conflict markers of a text conflict → evidence: … (whole-pr)` (Codex P1-1).
  - `conflictReviewBase: one file with two separated conflict blocks, the first resolved and the second committed verbatim with its markers → evidence: … (whole-pr); both resolved → admitted`. The fixture asserts the parsed `types` really include `Auto-merging` and are still classified as a text conflict (Codex recheck P1-1).
  - `conflictReviewBase: add/add text conflict → a record, not a text conflict`.
  - `conflictReviewBase: two paths both sides changed, one conflicted, the other resolved by a union merge driver in .gitattributes → attribute: … naming the driver-resolved path` (Codex P1-2).
  - `conflictReviewBase: PR renames old→new and edits it, main edits old, merge=union on new, another file conflicts → attribute: … naming new` (Codex recheck P1-2).
  - `conflictReviewBase: zero conflicted paths (clean trial merge) → no-conflict`; `51 conflicted paths → too-many-conflicts`.
  - `conflictReviewBase: history: a foreign-branch merge followed by an ordinary commit → history: …; a rewritten branch whose old reviewed head still resolves locally → history: …; an octopus merge → history: …` (Codex P2-4).
  - `conflictReviewBase: a symlink conflict → evidence: …`.
  - `ensureReviewBase (conflict): a fresh clone rebuilds the same tree id; a recorded id that differs → review-base-unavailable; a fresh clone missing fromHead → review-base-unavailable; a disallowed attribute on a path not in the stored 50-path list (path 51 of the both-sides set) → review-base-unavailable` (Codex P2 rebuild).
- [ ] **Step 2:** `node --test test/git-resolution.test.mjs`: the new tests FAIL (no export).
- [ ] **Step 3: Implement** `conflictReviewBase` as the rules above (H, then the trial merge, then A, then E). Reuse `attributeProblem`, `TEXT_MODES`, `mergeTreeDetailed`, `rawDiffNoRenames`, and the history-walk primitives `resolutionReviewBase` uses. H needs its own walk (Codex P2-4: the existing one stops at the first ordinary commit). Errors: `GitError` gives `git-error`; anything else rethrows. Extend `ensureReviewBase`.
- [ ] **Step 4:** the file passes; the vendor drift test passes (refresh the vendored copy as that test instructs).
- [ ] **Step 5: Commit** `feat(review-range): conflictReviewBase: a counted conflict-round base with complete resolution evidence (#423)`

### Task 2: Classify, route, record and prompt a `'conflict'` round (Codex + substitute)

**Files:**
- Modify: `pipeline/lib/review-round.mjs` (`classifyReview` ~213; admission/prompt inputs ~297-371; threat-model lookup ~346; `recordRound` ~595-600)
- Modify: `pipeline/lib/review-route.mjs` (`PROTECTED_KINDS` ~15, `protectedKindsFor` ~100)
- Modify: `pipeline/lib/state.mjs` (`addRound` ~265-300 keeps `conflicted`, `conflictedCount`, `records` for `reviewBaseKind === 'conflict'`; header comment ~235)
- Modify: `pipeline/lib/codex.mjs` (`buildReviewPrompt` ~190-215; new `conflictBaseNote`, `conflictRecordsSection`; factor the "Conflicted files" fence out of `resolutionSection`)
- Modify: `pipeline/commands/substitute.mjs` (packet ~207-245: export `sides/ours|theirs/<path>` and the records for a `'conflict'` round as for `resolutionOnly`)
- Modify: `pipeline/lib/round-status.mjs` (`words` ~161; comment ~142)
- Test: `test/cli-review.test.mjs` (admission ~3978, `--plan` ~4009), `test/cli-triage-round-request.test.mjs` (~386-415), `test/codex.test.mjs`, the substitute test file (grep `sides/ours` in `test/`)

**Interfaces:**
- Consumes: `conflictReviewBase` (Task 1).
- Produces: `classifyReview(...)` may return `review = { base, kind: 'conflict' }` and `conflict: { conflicted, conflictedCount, records }` (with `resolutionIneligible` still set). It produces round records with `reviewBaseKind: 'conflict'` and those three fields, and no `resolutionOnly`. Prompt helpers: `buildReviewPrompt({ baseKind: 'conflict', conflict: { from, forkPoint, conflicted, conflictedCount, records } })`, `conflictBaseNote({ from, forkPoint }) -> string[]` and `conflictRecordsSection(records) -> string[]` (records as one line each in a fence; they are data). It also adds the protected kind `'conflict-merge'`.

- [ ] **Step 1: Failing tests**
  - `cli-review` admission (~3978) and `--plan` (~4009): the existing "later own commit after a conflicting merge ⇒ whole-pr" expectations become `'conflict'`. Add the controls as separate tests (Codex P2-acceptance): `wholePrOwed` ⇒ `'merge-base'`; escalated judge→Fable ⇒ `'whole-pr'`; PR targeting a non-default branch ⇒ `'previous'`; a case Task 1 refuses (markers left in) ⇒ `'whole-pr'` with the `resolutionIneligible` code. The `'conflict'` test asserts: `countsTowardCap`, the recorded `conflicted` / `records`, `diff.patch` without the main-only file, and the protected kind `'conflict-merge'` in the plan output.
  - `cli-review` threat model: `a Fable-lane conflict round still gets the threat-model and regression-only sections the whole-PR round would (file list from forkPoint..head)` (Codex P3).
  - `cli-triage-round-request` (~386-400): the counted case predicts `'conflict'`. The summary keeps the formatter's reason suffix: match `/^Prediction: the next round would be a counted round on the PR's own changes since the last reviewed head and its conflict resolutions \(the default branch's commits left out\)[^\n]*\.$/m`, and `resolutionIneligible` is still present (Codex P2-acceptance). Read ~415 first: change it only if it is the same shape.
  - `codex.test.mjs`: `buildReviewPrompt baseKind conflict: states the marker-tree base, excludes the base branch's commits, asks to justify dropped base-branch lines, fences the conflicted paths and one line per record`; `a missing conflict.from throws`.
  - substitute, reached through the quota / model-refusal route (the protected kind keeps it off the small-fix route): `a conflict round whose modify/delete and rename paths are absent from the patch: the packet carries each record's stage blobs exported BY OID (sides/<stage>/<path>), the records and the evidence-map lines for them; prepare and apply agree on the packet digest`. Export is by recorded stage OID, never `ref:path`: a rename's stage blob can live at another path (Codex recheck, substitute row).
- [ ] **Step 2:** run those files: the new and changed tests FAIL.
- [ ] **Step 3: Implement**
  - `classifyReview`: in the `found.ineligible` branch, call `conflictReviewBase({ from: base, forkPoint, head, baseRef })` (pass `head` / `baseRef` in from the callers: `admitRound` has them, `predictNextRound` has them). `escalated` still overrides to `'whole-pr'` and clears `conflict`.
  - Threat model / regression-only lookup (~346): for kind `'conflict'` use `diffFiles(c.forkPoint, head, o)`, the commit range a whole-PR round uses, never the tree base.
  - `protectedKindsFor`: add `'conflict-merge'` when the round's kind is `'conflict'`, the way `'resolution-only'` is added. Check `review-route.mjs` and its tests for the protected-kind list (grep `PROTECTED_KINDS`) and extend them.
  - `buildReviewPrompt`: `baseKind === 'conflict'` asserts `conflict.from` / `conflict.forkPoint`, then adds `conflictBaseNote`, the conflicted-paths fence and `conflictRecordsSection`. `conflictBaseNote` text (exact):
    `The base of this range is NOT a commit of the branch: it is the last reviewed head (<from>) trial-merged with the base branch as it is now (<forkPoint>), with git's conflict markers left in the conflicted text files. So this diff is the PR's own changes since the last review plus how each text conflict was resolved; the base branch's own commits are excluded because they were reviewed in their own pull requests. In a conflicted file a '-' line is a marker or a side of the conflict that was not kept: check that each resolution keeps the intent of both sides, and report as BLOCKING a dropped base-branch line that removes a fix, a check or a feature without a reason in the code. Conflicts that are not plain text (a file one side deleted or moved, a binary) are listed under "Conflict records" with what the head kept: judge each one, e.g. a file the base branch deleted that the head keeps. Both sides: \`git show <from>:<path>\` (reviewed branch), \`git show <forkPoint>:<path>\` (base branch).`
  - `substitute.mjs`: for `adm.review.kind === 'conflict'`, export every record's stage blobs by OID (`git cat-file blob <oid>`; a binary blob is listed by OID, size and sha256 instead of its bytes), plus the conflicted text files' ours/theirs sides by OID. Add the records file to the packet and the evidence map. The `resolutionOnly` branch is unchanged.
  - `round-status.mjs` `words.conflict`: `a counted round on the PR's own changes since the last reviewed head and its conflict resolutions (the default branch's commits left out)`.
- [ ] **Step 4:** those files pass; `node scripts/verify.mjs --quick` PASS.
- [ ] **Step 5: Commit** `feat(review-range): a conflicting main merge gives a counted 'conflict' round on the PR's own changes, not the whole PR (#423)`

### Task 3: Fable reads the same slice

**Files:**
- Modify: `pipeline/commands/arbiter.mjs` (`reviewSection` ~283-289; the threat-model file list ~423/506/653 uses `forkPoint..toHead` for a `'conflict'` round, as in Task 2)
- Test: the arbiter test file that asserts the resolution note (grep `trial-merged` in `test/arbiter*.test.mjs`; extend it)

**Interfaces:** consumes the Task 2 round fields and `conflictBaseNote` / `conflictRecordsSection`.

- [ ] **Step 1: Failing tests**
  - `arbiter needed on a 'conflict' round after an earlier proven Fable pass: fable-diff.patch is the marker-tree..head slice (no default-branch-only file), the input says "only what changed in round N" and carries the Fable form of the conflict note, the paths and the records; the PR's first Fable pass is still whole-pr`.
  - `arbiter needed, conflict round, binary keep-ours path absent from the patch: the input names conflict-sides.md (sha256 pinned) whose text Fable can Read: each record with its stage blobs' text (by OID) or, for a binary, OID + size + sha256; apply refuses when that file was edited since needed` (Codex recheck P1-3).
  - `arbiter needed + apply on a Fable-lane conflict round: the threat-model section is present, and apply's waiver lookup reads forkPoint..toHead (stored tmFrom), not the tree base` (Codex recheck P3).
- [ ] **Step 2:** run them: FAIL.
- [ ] **Step 3:** in `writeFableDiff`'s caller, for a round-scope `'conflict'` round, write `conflict-sides.md` next to the input: per record, stage blobs as text by OID (binary: OID, size, sha256), and per conflicted text file, its ours/theirs blobs by OID. Pin it by digest the way `writeRegressionBase` / `checkRegressionBase` pin the merge-base view. If any blob cannot be read, that pass uses whole-pr scope. In `reviewSection`, when `round.reviewBaseKind === 'conflict' && diff.scope === 'round'`, push the paths and the records (same fenced form as the resolution case), plus a Fable form of the note: the same text, but its last sentence points at `conflict-sides.md` instead of `git show`. Store `tmFrom: round.forkPoint` for a conflict round and use it wherever `diffFiles(diff.from, …)` / `stored.diffFrom` feeds threat models or the regression bar (`needed` ~423/506 and `apply` ~653).
- [ ] **Step 4:** arbiter tests pass.
- [ ] **Step 5: Commit** `feat(arbiter): Fable's round slice after a conflicting merge carries the conflict note and records (#423)`

### Task 4: round-request's "changed since the last review" counts the PR's own changes

**Files:**
- Modify: `pipeline/lib/round-status.mjs` (`sinceLastReview` ~42-55; `notCleanReasons` wording in `pipeline/lib/round-ask.mjs` ~87-92)
- Modify: `skills/review/SKILL.md`, `skills/review/reference/special-rounds.md`, `docs/cli.md`: wherever a conflicting merge is said to give a whole-PR round (grep `whole-PR` / `whole PR` near "conflict"), describe the new kind and when it falls back
- Test: `test/cli-triage-round-request.test.mjs`

**Interfaces:**
- Produces: `sinceLastReview(...).changed = { commits, files, lines, own: boolean, resolution: boolean }`. It measures the increment since the last reviewed head, whatever round is owed next. An owed whole-PR round changes nothing here (it decides the next round's range, not what changed) (Codex P2-5). Own counts need BOTH conditions:
  - `mergeInIneligible(...)` (fix-verify.mjs) returns `undefined` (target and anchor trusted);
  - rule H from Task 1 holds on `anchor..HEAD` (export it as `ownHistoryProblem({ from, head, baseRef }, o) -> string | null`), so a foreign or octopus merge or a rewrite gives raw counts (Codex recheck, counts row).

  The base is then `effectiveReviewBase({ from: anchor, forkPoint })`, and when that returns `'whole-pr'`, the Task 1 `'conflict'` base. If that is refused too, raw counts. `commits` = one-parent commits on the first-parent chain `anchor..HEAD`. `files` / `lines` = `diffFiles(<base>, 'HEAD', o, { treeBase: true })`, agent log excluded. `resolution` = the base is a `'conflict'` (or `'resolution'`) one. Any failure gives raw counts with `own: false`. The `count` / `commits` deferral list is unchanged.
- Wording (`round-ask.mjs`): with `own: true`, `changed since the last review (the PR's own changes, default-branch merges left out): N commit(s), N file(s), N line(s) that fix no item`. With 0 own commits and `resolution: true`: `0 own commits (a default-branch merge and its conflict resolution), N file(s), N line(s) …`. With 0 own commits and `resolution: false`: `0 own commits (default-branch merges only), …`. With `own: false`, the wording is today's.

- [ ] **Step 1: Failing tests** (each asserts the summary line):
  - a clean main merge bringing 3 files plus one own commit touching 1 file says `1 commit, 1 file` (today it counts main's commits and files);
  - the Task 2 conflict case counts the own commit plus the resolved file;
  - a merge-only conflict catch-up says `0 own commits (a default-branch merge and its conflict resolution)`;
  - an owed whole-PR state with one new own commit still says `1 commit` (the increment, not the whole PR);
  - controls keep the raw wording: a stacked PR (non-default base), an untrusted anchor, and a trusted PR whose only merge since the last review is a foreign topic branch (Codex recheck).
- [ ] **Step 2:** run: FAIL.
- [ ] **Step 3:** implement as in Interfaces. `gatherRoundStatus` already has `gh`; pass it on for `mergeInIneligible`.
- [ ] **Step 4:** file passes; docs updated; `node scripts/verify.mjs --quick` PASS.
- [ ] **Step 5: Commit** `fix(round-request): count only the PR's own changes since the last review (#423)`

## Review Focus

1. **The #2395 shape with no own commit**: the patch is only the content resolution, plus a record for the moved file. Task 1 and Task 2 tests.
2. **A side kept that ort already wrote** (modify/delete, binary): a record makes the choice visible. Task 1 and substitute tests.
3. **A driver-resolved path that is not in the conflict list**: whole-pr. Task 1.
4. **A rewritten branch or a foreign merge**: whole-pr. Task 1.
5. **Owed / escalated / stacked / untrusted**: unchanged kinds and raw counts. Tasks 2 and 4.

## Out of scope

- Making a `'conflict'` round free (uncounted): a cap-policy change, the owner's call; not proposed.
- `effectiveReviewBase` callers outside review rounds (`commands/state.mjs` since-merge checks, `fix-verify.mjs#filesSince`) keep `'whole-pr'`: they measure, they do not show a reviewer a diff.

## Fable plan pass 2026-11-20 (verdict: sound with changes): binding changes to the tasks above

These override the task text where they differ.

1. **(P1, Task 1 rule E) Informational allowlist is exactly `Auto-merging`.**
   - Every other message type (including git 2.39's space-less `CONFLICT(directory rename unclear split)` / `CONFLICT(directory rename collision)`) joins the record of each conflicted path it names.
   - A message that names no staged conflicted path fails `evidence:` (whole-pr).
   - Tests: a directory split (PR adds `lib/new.js`, main splits `lib/` into `a/` + `b/`, another file content-conflicts) and a directory-rename collision. Each asserts whole-pr or a record naming the file. Run real fixtures; do not assume what ort stages.
2. **(P2, rule E) Block rule is label-independent.**
   - Trial-tree labels are full SHAs; a real merge writes `<<<<<<< HEAD` / `>>>>>>> main`. Fail E when any block's ours / `=======` / theirs body survives between marker lines of ANY label in HEAD's blob. Reuse resolution.mjs's `marker-line` detection (~334).
   - Extend `parseConflictBlocks` (resolution.mjs ~145) to return block spans; resolution.mjs is vendored too.
   - Test both a real `git merge` fixture (`resolveMerge`, kept markers) and a pasted-trial-blob fixture.
3. **(P2, rule E) The block rule also covers record paths.** Apply it to EVERY conflicted path whose tree blob parses to ≥ 1 block (add/add, rename-involved collisions). `headEquals: 'tree'` on such a path fails E.
4. **(P2, Task 3 `conflict-sides.md`) Framing and cap.**
   - Prefix every blob line with side + line number, as `writeRegressionBase` does (arbiter.mjs ~196).
   - Byte cap (reuse the regression-base cap if one exists, else 200 KB); over it, the Fable pass uses whole-pr scope.
   - At `apply`, regenerate the file from the recorded OIDs and compare, not only the on-disk digest.
   - Test: a stage blob containing text shaped like a record header stays visibly framed as blob content.
5. **(P2) Records-only round with an empty patch** (a lone modify/delete where head keeps ours, so tree == head): decision: **whole-pr** (`evidence: records-only`). That matches the free proof's `no-changes` refusal and keeps an empty-patch counted round impossible. Test it through admission.
6. **(P3)**
   - **Rebuild shortcut.** `ensureReviewBase` re-runs admission only when the tree object is missing (past the early return ~git.mjs:400). Say so in its comment.
   - **Path-51 test.** Use `conflict-marker-size` on a cleanly merged both-sides path, so the tree id is unchanged, and assert the reason names that path.
   - **File/directory conflict.** HEAD or a stage of mode 040000 at the path fails E, like symlinks.
   - **Record shape.** Add `heads: [{ path, mode, oid } | { path, absent: true }]` for every path the messages name; cut messages at 300 chars only after the paths are extracted.
   - **`conflictBaseNote`.** Point at `git cat-file -p <oid>` from the record for a renamed stage, not `git show <from>:<path>`.
   - **Text consumers to update.** Help text in commands/round.mjs ~29, codex-review.mjs ~50/~64, triage.mjs ~74; agents/arbiter.md ~21 and agents/arbiter-fix.md ~21 (Fable's inputs). Agent files are pipeline-installed: the change ships via this PR + `pipeline update`.
   - **Task 4 wording.** 0 own commits, not a resolution, files > 0 reads: `0 own commits (edits inside a default-branch merge commit), N file(s), N line(s) …`.
