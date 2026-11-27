# Auto-apply merged migrations: design

Status: design, owner approach pick 2026-11-27 ("After the merge only"). Plan: `docs/plans/2026-11-27-auto-apply-migrations.md`.

## Why

The live-database guard (#262) refuses every `apply_migration` on a live Supabase project until the owner gives a go for exactly that
file: a click on the `live-db present --ask` dialog or the typed `go migration <name>`. On 11-27 the owner was asked to type
`go migration 20261223100100_guard_soundoffs_session_write_policies` after already saying "merge" on the PR (#2582) that carries it, and
said: "go with auto apply already do it now disregard the pause". For a migration file in a PR the owner approved, the owner's
"merge" IS the go. The freeze (cp shrink pilot) does not block this one PR (owner, 11-27).

## Goals

- A migration file that is on the default branch of the repo the owner registered for a live project is applied by Claude
  (Supabase MCP `apply_migration`) with no further owner word, when the owner switched auto-apply on for that project.
- The switch is the owner's alone (own terminal), per project, default off.
- Each auto-apply leaves a record the owner can read (what, where, which PR, when).
- Claude says in the merge request that merging also applies the PR's migrations, and reports each apply afterwards.

## Non-goals

- Data SQL (`execute_sql` writes), including a live dry run (`begin; … rollback;`), keeps the go.
- A migration applied BEFORE its PR merges keeps the go (the existing `live-db present --ask` path, unchanged).
- `supabase db push` stays owner-only. DRMed is not covered: its rule is the owner's `db push` before the merge, never MCP
  `apply_migration`; its switch stays off.
- No change to how the guard handles any other Supabase tool or any dev project.

## Anti-goals (a failure even if it "works")

- An agent applies SQL the owner never approved through a merge (a PR branch, a local file, an edited copy, another repo's file).
- An agent turns the switch on, or makes the guard believe it is on.
- The migration reaches the wrong project (an EagleWatch file applied to DRMed's database).
- The pipeline applies the same migration twice (a retry, a second session, an edited file with the same name).
- A GitHub outage or an unreadable answer becomes an allow.
- A failed apply goes unreported.

## Approaches

1. **After the merge only; GitHub's default branch is the proof (picked by the owner, 11-27).** The guard asks GitHub for the file on
   the registered repo's default branch and allows the call only when the query is byte-identical. Simple, self-contained, works from
   any session. Cost: a migration that fails on the live database no longer stops the merge; the code is already merged and going
   live, so Claude flags it at once (revert or fix forward).
2. **Also at the owner's "merge", before merging.** "Before" migrations apply when the owner says merge, and a failed one blocks the
   merge. Rejected for now: the guard would also have to verify the owner's recorded merge word (transcript proof, clicks, queue),
   more code in the most sensitive part, more review rounds, later ship. Can be added later if a post-merge failure ever happens.
3. **Local `origin/main` as the proof.** Rejected: an agent can rewrite local refs (`git update-ref`), so a local ref proves nothing.

## Facts checked (2026-11-27)

- One GitHub GraphQL call returns, for `eaglewatch-ph/eaglewatch`: the default branch and its head, the file's text byte-identical to
  `git show origin/main:<file>` (checked on a 3,939-byte and a 100,008-byte migration; `isTruncated: false`), and the last commit that
  touched the file with its date and PR number (#2582). 0.8 s and 1.5 s. The guard hook's timeout is 15 s.
- EagleWatch makes migrations a hard stop (`supabase/migrations/**`), so a migration reaches main only through the owner's "merge".
- The owner's registry `~/.claude/pipeline-state/db-refs.json` does not exist yet on the Mac (every project counts as live, unnamed).
  EagleWatch's live ref is `qhptbmafrosgibooelpp`.
- EagleWatch applies migrations at two moments: before the code deploys (schema the new code needs) and after the deploy (tightening
  the old code would trip over; #2582's second migration). Its prod ledger holds `apply_migration` stamps, so "is it live?" is
  answered by the effect (column, policy, function body), not the ledger.
- A top-level `DROP` sent through MCP asks for a Supabase confirmation that never reaches the owner; the workaround (`DO`-wrapping the
  DROP) changes the bytes, so with auto-apply the wrap must be in the file itself.

## Design

### 1. The switch (owner-only)

- A registry entry may carry `autoMigrations: true`, only on a `kind: live` entry that has a `repo`. `readDbRefs` returns it; a value
  that is present but not a boolean makes the registry invalid (fail closed, as for any bad field).
- New owner command: `pipeline db-refs auto-migrations on|off --ref <ref>`. Refused inside Claude Code (same `insideClaudeCode` check
  as `set`) and refused to an agent's Bash line by the existing `db-refs` rule (anything but `show`). Refuses an unknown ref, a dev
  ref and an entry without `repo`. `show` prints the flag.
- `set` on an existing ref keeps its flag; `set --dev` drops it (a dev project needs no go at all).
- Default off: nothing changes until the owner runs it.

### 2. The guard's auto path (`apply_migration` only)

Inside `evaluateSupabaseMcp`, after every existing check (registry readable, well-formed project id, trusted server, not dev, a query
and a name). Only when the ref's entry has `autoMigrations: true`; otherwise the existing go claim runs unchanged.

Local checks first, in this order (no network until they pass):
1. `name` is a plain file stem (`^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$`); the file is `supabase/migrations/<name>.sql`.
2. The query passes the character rules of the typed go (not empty, no CR or NUL, no control or bidirectional-text characters) but
   NOT its display rules (300-line cap, fence lines): nobody has to read it on screen.
3. No earlier attempt on this machine: no auto marker for (ref, name) (step 7), and no auto or consumed go marker for this ref with
   this sha256 (the exact SQL was already applied, under this name or another).

Then ONE GitHub call (`gh api graphql`, through the pipeline's `gh` runner, ≤ 8 s) on the entry's `repo`: default branch name and
head; the file at that head (text, binary, truncated); the last two commits on that branch that touched the path (oid, date, first PR).
4. The file exists there, is text, not truncated, and its bytes equal the query's bytes exactly.
5. Exactly ONE commit on that branch touched the path (the file was added and never edited: a later edit of an old, already-applied
   migration must not make it "recent" again), and that commit is at most 7 days old (not in the future past the usual skew). An
   older or edited file is a deliberate act: it takes the owner's go. This also bounds a session that "catches up" on old files.
6. Any GitHub failure (no `gh`, non-zero exit, timeout, bad JSON, no such repo or branch) makes the call not eligible.

Claim:
7. Exclusive-create marker `~/.claude/pipeline-state/owner-go/live-db-auto/<sha256(ref|name), 32 hex>.json`, written durably before the
   allow (same open/fsync pattern as the go marker), holding: time, session, ref, label, name, file, sha256, repo, branch, head,
   commit, commit date, PR. `EEXIST` means already attempted. The folder is inside the protected `owner-go` tree, so an agent cannot
   delete a marker to retry.

Outcomes:
- Eligible and claimed: allow. Consumed at the attempt, like a go: a failed or interrupted auto-apply is never retried
  automatically; the next attempt needs the owner's go, after a read-only check of the live state.
- Not eligible: fall through to the existing go claim. If no go is recorded, the deny says why auto-apply did not apply, then the
  existing go guidance.
- Every `apply_migration` allowed through a go also takes the (ref, name) marker (best effort; `EEXIST` ignored), so a migration the
  owner applied with a go is never auto-applied again.

### 3. What the owner can see

- The markers are the record. `pipeline live-db auto-log [--days N]` (read-only, runs anywhere) lists them, newest first.
- The session reports each apply in plain English (section 4).

### 4. The review skill (`skills/review/reference/owner-merge.md` "Live-database go", `ready-and-handoff.md`, `docs/cli.md`)

- **Merge request:** when `P db-refs show` has auto-apply on for the repo's project and the PR adds migration files, say in plain
  English above the closing lines that merging also applies them to the live database right after the merge (naming any that wait
  for the deploy).
- **After the merge job reports merged,** for each migration file the PR added, in filename order:
  1. A file whose first line is `-- pipeline: apply-after-deploy` waits until the production deployment of the merge commit is live
     (the repo's production watch: its workflow run on the merge commit, or GitHub's deployment status for that sha). The others apply
     right away: the new version is usually still building, so the schema lands first.
  2. Is it already live? A read-only check of its effect (and `list_migrations` by name). Live ⇒ skip it and say so.
  3. `apply_migration` with `name` = the file stem and `query` = the bytes of `git show origin/main:<file>` after a fetch.
  4. Read-only check of the effect. Report it.
  - A refusal or failure stops the remaining files of that PR: 🚨 tell the owner (the code is live without that schema), read-only
    look at the live state, then the go path.
- A migration that must be live before its code deploys and cannot take the build-time gap or a failed apply after the merge: apply
  it before the merge with the go (unchanged), or split it into its own PR first.
- With auto-apply, DO-wrap a top-level `DROP` in the file itself; a file the tool cannot pass byte-for-byte (a literal `\uXXXX`) still
  takes the owner's go.

### 5. EagleWatch's local rules (outside the PR, when the owner turns the switch on)

`~/Claude/eaglewatch/AGENTS.md` step 3 ("Prod gets a migration only with the owner's explicit go") and the `eaglewatch-db-changes`
skill (prod dry run, DROP wrap, the after-deploy header) are rewritten to match, in the same session that confirms the switch is on.
Before that they would contradict the guard.

## Tests (at the seams; each names the failure it catches)

Guard (`test/live-db-guard.test.mjs`, GitHub faked through the `liveDbIo` seam):
- allow: switch on, file on the default branch, identical bytes, recent; the marker holds the PR and commit. *(the feature works)*
- switch off: same call needs the go and makes no GitHub call. *(default off really is off)*
- one byte different (trailing newline): needs the go. *(an edited copy is not the merged file)*
- file absent on the default branch (only on a PR branch): needs the go. *(an unmerged file is not applied)*
- last commit older than 7 days: needs the go. *(old files take a deliberate go)*
- two commits touched the file (added, later edited): needs the go. *(an edited old migration is not re-applied)*
- second attempt, same ref and name, even with other bytes: needs the go. *(no double apply, no edited re-apply)*
- a consumed go marker for this ref and sha: needs the go. *(already applied with a go)*
- GitHub fails or times out: deny, not allow. *(fail closed)*
- the GitHub question names the entry's `repo`. *(no cross-project apply)*
- `execute_sql` data SQL with the switch on: still needs the go. *(scope stays migrations)*
- a go-claimed apply takes the (ref, name) marker; a later auto attempt is refused. *(go then auto = twice)*

Registry (`test/db-refs.test.mjs`): `auto-migrations on` refused inside Claude Code, refused for dev / no repo / unknown ref; `set`
keeps the flag, `set --dev` drops it; a non-boolean flag makes the registry invalid. The agent-line refusal of
`pipeline db-refs auto-migrations on` (existing rule): one assertion.

## Residual risks (accepted)

- Deliberate subversion (a replaced `gh` or `git` binary, an edited gh config that reroutes its requests) is outside the threat model,
  as for the guard's existing git reads: a tripwire, not a boundary.
- Markers are per machine: the Mac and the PC could each auto-apply once. The skill's "is it live?" check covers it.
- A migration the owner applied outside the guard (`!` in a terminal) leaves no marker: the skill's "is it live?" check covers it.
- A failed apply after the merge leaves the new code live without its schema until fixed (the owner's accepted trade-off).

## Left to the builder

The exact GraphQL text and timeout; the marker and `auto-log` output formats; how the character rules are factored out of
`migrationSqlProblem`; the deny wording.

## Rollout

PR → owner "merge" → `pipeline update` (Mac; the PC when it is online) → owner, own terminal:
`pipeline db-refs set --ref qhptbmafrosgibooelpp --name "EagleWatch live" --repo eaglewatch-ph/eaglewatch`, then
`pipeline db-refs auto-migrations on --ref qhptbmafrosgibooelpp` → Claude updates EagleWatch's local rules (section 5) → the next
merged EagleWatch migration is the live check (applied with no go, marker present, `auto-log` lists it).
