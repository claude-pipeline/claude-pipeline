# Auto-apply merged migrations: design

Status: design, owner approach pick 2026-11-27 ("After the merge only"), approved as written 11-27. **Revision 2 (11-27):** the Codex
plan review R1 (7 × P1) hardened the claim, the time budget, the GitHub proof and the marker files; the owner chose (11-27) that a
migration marked `-- pipeline: apply-after-deploy` keeps the go (one click after the deploy; the deploy-checked variant is idea #882).
**Revision 3 (11-27)** after the Codex recheck: a generation history (every allowed apply advances it), the time budget through click
settling, the marker found anywhere, `on` imports the earlier go applies, durable folders, switch-off unchanged. **Revision 3.1**
after the Fable plan pass (no double allow found): one git deadline at the choke point covering every route to the go check; full
generation probing; auto also refuses a consumed go of this name or SQL (a rollback); a click's go time is its dialog's issue time;
the PR's base repository must match; only files merged after the switch-on time auto-apply. Sections 1–5 below are Revision 3; where
the plan is more detailed (Revision 3.1), the plan governs.
Plan: `docs/plans/2026-11-27-auto-apply-migrations.md`.

## Why

The live-database guard (#262) refuses every `apply_migration` on a live Supabase project until the owner gives a go for exactly that
file: a click on the `live-db present --ask` dialog or the typed `go migration <name>`. On 11-27 the owner was asked to type
`go migration 20261223100100_guard_soundoffs_session_write_policies` after already saying "merge" on the PR (#2582) that carries it, and
said: "go with auto apply already do it now disregard the pause". For a migration file in a PR the owner approved, the owner's
"merge" IS the go. The freeze (cp shrink pilot) does not block this one PR (owner, 11-27).

## Goals

- A migration file that a merged PR added to the default branch of the repo the owner registered for a live project is applied by
  Claude (Supabase MCP `apply_migration`) with no further owner word, when the owner switched auto-apply on for that project.
- The switch is the owner's alone (own terminal), per project, default off.
- Each attempt leaves a record the owner can read (what, where, which PR, when).
- Claude says in the merge request that merging also applies the PR's migrations, and reports each apply afterwards.

## Non-goals

- Data SQL (`execute_sql` writes), including a live dry run (`begin; … rollback;`), keeps the go.
- A migration applied BEFORE its PR merges keeps the go (the existing `live-db present --ask` path, unchanged).
- A migration marked `-- pipeline: apply-after-deploy` keeps the go (owner, 11-27): the guard has no deploy evidence it can trust
  without new owner setup (#882).
- `supabase db push` stays owner-only. DRMed is not covered: its rule is the owner's `db push` before the merge, never MCP
  `apply_migration`; its switch stays off.
- No change to how the guard handles any other Supabase tool or any dev project.

## Anti-goals (a failure even if it "works")

- An agent applies SQL the owner never approved through a merge (a PR branch, a local file, an edited copy, another repo's file, a
  direct push, an old migration renamed into a new name).
- An agent turns the switch on, or makes the guard believe it is on.
- The migration reaches the wrong project (an EagleWatch file applied to DRMed's database) or is read from the wrong GitHub host.
- The pipeline applies the same migration twice (a retry, a second session, an old go, an edited file with the same name, the same
  SQL under a second name).
- A GitHub outage, an unreadable answer, an unreadable record or a hook that runs out of time becomes an allow.
- A failed apply goes unreported.

## Approaches

1. **After the merge only; GitHub's default branch is the proof (picked by the owner, 11-27).** The guard asks GitHub for the file on
   the registered repo's default branch and allows the call only when the query is byte-identical and a merged PR added the file.
   Simple, self-contained, works from any session. Cost: a migration that fails on the live database no longer stops the merge; the
   code is already merged and going live, so Claude flags it at once (revert or fix forward).
2. **Also at the owner's "merge", before merging.** Rejected for now: the guard would also have to verify the owner's recorded merge
   word (transcript proof, clicks, queue), more code in the most sensitive part, more review rounds, later ship.
3. **Local `origin/main` as the proof.** Rejected: an agent can rewrite local refs (`git update-ref`), so a local ref proves nothing.

## Facts checked (2026-11-27)

- One GitHub GraphQL call (`gh api --hostname github.com graphql`) returns, for `eaglewatch-ph/eaglewatch`: the repository's
  `nameWithOwner`, the default branch and its head, the file's text byte-identical to `git show origin/main:<file>` (a 3,939-byte and a
  100,008-byte migration; `isTruncated: false`; 0.8 s and 1.5 s), and the commits on that branch that touched the path. For #2582's
  migration: exactly one commit `5ce2dd82d904`, which is the PR's `mergeCommit`; the PR is `merged: true`, base `main`, 53 files, and the
  file's `changeType` in it is `ADDED` (EagleWatch merges by squash through its merge queue).
- The guard hook's host timeout is 15 s (`HOOK_TIMEOUT_S`); the guard's own hard wall cap is 10 s from the hook process start
  (`EVAL_WALL_CAP_MS`, `HOOK_CLOCK`), and a child process is bounded by what is left of it (`wallLeftMs`, the `git-wiring.mjs` pattern).
  Claude Code ALLOWS a hook that outruns its timeout, so every blocking step must fit the cap.
- EagleWatch makes migrations a hard stop (`supabase/migrations/**`), so a migration reaches main only through the owner's "merge".
- The owner's registry `~/.claude/pipeline-state/db-refs.json` does not exist yet on the Mac (every project counts as live, unnamed).
  EagleWatch's live ref is `qhptbmafrosgibooelpp`. The Mac holds 44 consumed go markers, none empty.
- EagleWatch applies migrations at two moments: before the code deploys (schema the new code needs) and after the deploy (tightening
  the old code would trip over; #2582's second migration). Its prod ledger holds `apply_migration` stamps, so "is it live?" is
  answered by the effect (column, policy, function body), not the ledger.
- A top-level `DROP` sent through MCP asks for a Supabase confirmation that never reaches the owner; the workaround (`DO`-wrapping the
  DROP) changes the bytes, so with auto-apply the wrap must be in the file itself.

## Design

### 1. The switch (owner-only)

- A registry entry may carry `autoMigrations: true`, only on a `kind: live` entry that has a `repo`. `readDbRefs` returns it as a
  boolean (false when absent); a value that is present but not a boolean, or true on a dev entry or one without a repo, makes the
  registry invalid (fail closed, as for any bad field). The writer writes the key only when it is true.
- New owner command: `pipeline db-refs auto-migrations on|off --ref <ref>`. Refused inside Claude Code (same `insideClaudeCode` check
  as `set`) and refused to an agent's Bash line by the existing `db-refs` rule (anything but `show`). `on` refuses an unknown ref, a
  dev ref, an entry without `repo`, and a repo another enabled entry already has (one unambiguous target per repo). `on` prints what it
  trusts: every PR merged by squash into that repo's default branch; migrations there must need the owner's merge (a hard stop on
  `supabase/migrations/**`). `show` prints the flag.
- `set` on an existing ref keeps the flag only when it stays live with the same repo (a label-only edit); a changed repo or `--dev`
  clears it.
- `on` first IMPORTS the project's earlier go applies on this machine into the history (section 2): every consumed migration go of
  that ref whose go record is still there gives its name and SQL; one whose record is gone gives its SQL only and is listed, and `on`
  refuses until the owner re-runs it with `--accept-unmatched` (such an apply, of a file later changed in its PR under the same name,
  would not be recognised). It then creates the history folder durably and sets the flag. `off` keeps the history.
- Default off, and off means today's behaviour exactly: for a ref without the flag the guard reads and writes no history and asks
  GitHub nothing. Rollout default: on ONE machine (the Mac), so markers, which are per machine,
  are on the machine that applies.

### 2. The attempt history (flagged projects, both paths)

- Per migration two keys, each a GENERATION sequence of exclusive-create files in
  `~/.claude/pipeline-state/owner-go/live-db-attempts/` (inside the protected `owner-go` tree): `name-<id>-<n>.json`, id = first 32
  hex of sha256(`name|<ref>|<name>`), and `sql-<id>-<n>.json`, id = first 32 hex of sha256(`sql|<ref>|<sha256 of the query>`),
  `n` = 1, 2, … Every allowed apply (auto or go) creates the NEXT generation of BOTH keys; an existing one means another call got there
  first (the repo's ticket pattern, `claimGrantMarkers`). The body: time, `via` (`auto` | `go` | `go-import`), an event id, the partner
  file, session, ref, label, name, file, sha256, and for `auto` the GitHub facts (repo, branch, head, commit, commit date, PR). A lone
  file (its partner missing) is a reservation from a lost race or a failed write: it counts as an attempt.
- Lookups probe exact filenames (`-1`, `-2`, … until missing), never a search: a missing folder = no history; a key's time is the
  latest over its generations (a body's time, else the file's mtime: empty, unparsable, a partial write); a folder, a symlink, a read
  error, a gap or more than 64 generations = the history is unreadable, which refuses the call, naming the path.
- Written completely (every `writeSync` byte counted), fsynced, closed, the folder fsynced, and a folder the writer creates fsynced in
  its parent (POSIX; Windows cannot fsync a folder and relies on NTFS metadata journaling: documented) before the allow.
- One private writer in the new module; it exports only fixed-destination claims that derive the folder, the id and the body
  themselves (an attempt claim, the go's consumed marker), so no caller can create the registry or any other protected file through
  it. Every marker it can create only ever withholds an allow.

### 3. The guard (`apply_migration` only)

Inside `evaluateSupabaseMcp`, after every existing check (registry readable, well-formed project id, trusted server, not dev, a query
and a name). One time budget for the call: what is left of the hook's wall cap (`leftMs`), passed through every child process on the
decision path (the go path's git reads, including those under click settling, and the GitHub calls) and checked between the entries
of every scan; a step that cannot start in time is not run and the call is denied ("try again").

**The go first** (local, fast when no go is recorded). On a flagged project, for each verified, unexpired go record:
1. If the history has any attempt for this name or this SQL at or after the go's own time, or the go is stamped ahead of the clock,
   the go is not used (a retry needs a go given after the latest attempt, after a read-only check of the live state).
2. Consume the go (its existing exclusive marker), then create the next generation of both keys (`via: go`). Either one already there
   means another session attempted meanwhile: deny (the go is used). A write failure: deny.
3. Allow.
On a project without the flag the go path is today's, unchanged.

**Then auto**, only when no go was claimed, the call's ref has `autoMigrations: true` and no other enabled entry has the same repo.
Local checks first (no network until they pass):
1. The query has no `pipeline: apply-after-deploy` anywhere (any case, after a BOM, indented, in any comment; detection only, the
   bytes stay exact): those keep the go.
2. `name` is a plain file stem (`^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$`); the file is `supabase/migrations/<name>.sql`.
3. The query passes the character rules of the typed go (not empty, valid UTF-8, no CR or NUL, no control or bidirectional-text
   characters) but NOT its display rules (300-line cap, fence lines): nobody has to read it on screen.
4. No history for this name or this SQL (any generation, imported ones included).

Then ONE GitHub GraphQL call, `gh api --hostname github.com graphql` (pinned host), timeout min(6 s, time left): the repository's
`nameWithOwner`, default branch and head, the file at that head, the commits on that branch that touched the path (at most two), and
for that commit its associated PRs (merged, base, merge commit, files with change type). Eligible only when ALL hold:
5. The answer has no `errors` (a partial answer counts as a failure); `nameWithOwner` equals the registry `repo` (case-insensitive).
6. The file exists at the head, is text, not truncated, and its bytes equal the query's bytes exactly.
7. Exactly ONE commit on the branch touched the path, committed (strict ISO time with a zone) at most 7 days ago and not past the
   future skew.
8. That commit is the `mergeCommit` of a PR that is `merged`, whose base is the default branch, and whose files list the path as
   `ADDED` (this is the whole provenance predicate: a squash or one-commit rebase merge passes; a merge commit, a rebase in which
   another commit touched the path, a rename, a direct push, a delete and re-add do not). A PR with more than 100
   files is paged while time is left; not found = not eligible.
9. Any GitHub failure (no `gh`, non-zero exit, timeout, bad JSON, no such repo or branch) = not eligible.

Claim (only with at least 0.5 s left): create generation 1 of both keys (`via: auto`); either one already there = already
attempted. Both created: allow.

Outcomes:
- A failed or interrupted auto-apply is never retried automatically; the next attempt needs the owner's go given after the attempt,
  after a read-only check of the live state.
- Not eligible: the deny gives the existing go guidance plus why auto-apply did not apply.

### 4. What the owner can see

- The history is the record. `pipeline live-db auto-log [--days N]` (read-only, runs anywhere) lists one line per event, newest
  first: `attempted` (both files: an allowed call, auto or go, or one denied after the second file was written: its sync failed, time ran out, a consumed-go
  record could not be read, or a go was consumed meanwhile; it counts as an attempt and the live state is checked) or `reserved` (one file: nothing was allowed), and any unreadable record
  (which is what refuses calls). "Applied" is only what the session's effect check confirms.
- The session reports each apply in plain English (section 5).

### 5. The review skill (`skills/review/reference/owner-merge.md` "Live-database go", `ready-and-handoff.md`, `docs/cli.md`)

- **Merge request:** when `P db-refs show` has exactly one enabled live entry whose `repo` is this repo and the PR adds migration files,
  say in plain English above the closing lines that merging also applies them to that project right after the merge, naming any marked
  apply-after-deploy (they wait for the deploy and one click). A file marked after-deploy that sorts BEFORE an unmarked one is fixed
  (renumbered) before the merge request.
- **After the merge:** only on a non-vetoed merged outcome with a full merge sha: the merge job's `mergeSha`, else (also for
  `error: hold-recovery` with `prMerged: true`) `gh pr view N --json state,mergeCommit`; no sha ⇒ stop and tell the owner. A merge reported under a veto (the queue's "merged while it was being dequeued
  for a stop condition", or the sweep's report) applies nothing: tell the owner, then the go path on their word. The files are those
  `git diff --name-status <mergeSha>^ <mergeSha> -- supabase/migrations/` lists as added, in filename order, read with
  `git show <mergeSha>:<file>` after `git fetch origin <mergeSha>` (never `origin/main`: the default branch may have another name).
  Every file goes through steps 2–5; step 4 differs for a marked file:
  1. Marked apply-after-deploy: stop the automatic sequence here; wait for the production deployment of `mergeSha` (the repo's
     production watch, at most `deploy_timeout_minutes`; a failed or rolled-back deploy, or a timeout: tell the owner, apply nothing).
     Its step 4 is the go path, run in the PR's worktree (kept until every marked file is applied) at the PR head, after checking that
     the file there equals the merge-sha bytes exactly (different ⇒ stop). Then carry on with the next files.
  2. State the expected effect (every object the file creates or changes; for a policy: its roles, command and predicate, and the
     table's RLS state).
  3. Is it already live? A read-only check of that effect. Live ⇒ skip it and say so.
  4. `apply_migration` with `name` = the file stem and `query` = those bytes.
  5. Read-only check of the full effect. Report "applied" only when every part matches; an inconclusive check stops the sequence.
  - A refusal or failure stops the remaining files of that PR: 🚨 tell the owner (the code is live without that schema), read-only
    look at the live state, then the go path. Rolling the code back and repairing the database are separate owner decisions.
- A migration that must be live before its code deploys and cannot take the build-time gap or a failed apply after the merge: apply
  it before the merge with the go (unchanged), or split it into its own PR first.
- With auto-apply, DO-wrap a top-level `DROP` in the file itself. A file the tool cannot pass byte-for-byte (a literal `\uXXXX`) is
  refused by both paths: the owner applies it in their own terminal.
- The report names the machine that applied (markers are per machine).

### 6. EagleWatch's local rules (outside the PR, when the owner turns the switch on)

`~/Claude/eaglewatch/AGENTS.md` step 3 ("Prod gets a migration only with the owner's explicit go") and the `eaglewatch-db-changes`
skill (prod dry run, DROP wrap, the after-deploy header) are rewritten to match, in the same session that confirms the switch is on.
Before that they would contradict the guard.

## Tests (at the seams; each names the failure it catches)

Listed per task in the plan. In short: the feature works once; switch off asks GitHub nothing; edited bytes, an unmerged file, an old
or edited file, a rename, a direct push, a non-squash merge, a partial GitHub answer, another repo's answer and another host are not
eligible; an old go cannot apply a second time after an auto attempt (one session and across sessions); auto and go, two processes,
and the same SQL under two names give one allow; short writes and unreadable history refuse; a slow GitHub answer through the real hook
entry is a deny within the host timeout; `execute_sql` keeps the go; the switch's owner-only rules and repo-change rules hold.

## Residual risks (accepted)

- Deliberate subversion (a replaced `gh` or `git` binary, an edited gh config, a script that writes or deletes protected files
  directly) is outside the threat model, as for the guard's existing reads: a tripwire, not a boundary.
- A stalled local filesystem call (a hung fsync or read) is the one blocking step the time budget cannot bound; it would stall the
  host's own writes too. Considered and not taken: running the decision in a worker thread with a watchdog.
- Ordering a retry go after an attempt uses the machine's wall clock: a backward clock step larger than the gap between an attempt
  and an older go could admit that go once (a go stamped ahead of the clock is refused).
- History is per machine: with the switch on two machines, each could attempt once. Mitigation: switch on one machine; the skill's
  "is it live?" check.
- A migration the owner applied outside the guard (`!` in a terminal) leaves no marker: the skill's "is it live?" check covers it.
- A failed apply after the merge leaves the new code live without its schema until fixed (the owner's accepted trade-off).
- Auto-apply trusts the repo's merge rules: a PR that merges without the owner (a repo with no hard stop on migrations) would apply.
  `auto-migrations on` says so; the owner enables it only for such a repo.
- The MCP server must honor the call's `project_id` (the existing guard's assumption: only trusted servers).

## Left to the builder

The exact GraphQL text; the marker and `auto-log` output formats; how the character rules are factored out of `migrationSqlProblem`;
the deny wording.

## Rollout

PR → owner "merge" → `pipeline update` (Mac; the PC when it is online) → owner, own terminal, on the Mac only:
`pipeline db-refs set --ref qhptbmafrosgibooelpp --name "EagleWatch live" --repo eaglewatch-ph/eaglewatch`, then
`pipeline db-refs auto-migrations on --ref qhptbmafrosgibooelpp` → Claude updates EagleWatch's local rules (section 6) → the next
merged EagleWatch migration is the live check (applied with no go, its attempt in `auto-log`, the effect check matches).
