# Auto-apply merged migrations Implementation Plan

> **For agentic workers:** built through the `review` skill (this repo has `.claude/pipeline.yml`): one implementer per task or one
> for all five, then the pipeline's review rounds. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision 3 (2026-11-27)** after the Codex plan recheck (R1 session resumed; the one recheck the owner's Codex rule allows): attempt
GENERATIONS so every allowed apply advances one durable record per name and per SQL (R2-1); the time budget also covers the click
settling and its nested git reads, and the final claim needs time left (R2-2); the after-deploy marker is found anywhere, BOM or indent
or not (R2-3); `auto-migrations on` imports the earlier go applies of that project (R2-4); new folders are created durably (R2-5);
switch-off projects keep today's behaviour exactly (R2 P2); the log groups markers into events (R2 P2); the after-deploy workflow shares
the checks and binds the presented file to the merge (R2 P2); a merged result without a sha is recovered or stops (R2 P2).
Revision 2 had fixed R1 (7 × P1). The after-deploy files keep the go (owner, 11-27); the deploy-checked variant is idea #882.

**Goal:** a migration file that a merged PR added to the registered repo's default branch is applied to that repo's live Supabase
project with no owner go, when the owner switched auto-apply on for that project.

**Architecture:** an owner-only flag on the db-refs registry entry, whose `on` also imports the project's earlier go applies; a new
hook library `live-db-auto.mjs` that owns every live-db marker (a private writer; fixed-destination claims), keeps a generation history
per migration name and per SQL, and checks the call against the file on GitHub (one GraphQL call); `evaluateSupabaseMcp` tries the
owner's go first, then auto, inside one time budget; a read-only `live-db auto-log`; the review skill applies after the merge.

**Tech Stack:** Node ESM, `node:test`, the pipeline's `gh` runner (`pipeline/lib/proc.mjs`).

**Spec:** `docs/specs/2026-11-27-auto-apply-migrations-design.md` (Revision 3; read it first; this plan does not repeat its reasons).

**Size:** about 1,200 lines with tests, one subsystem (the live-database guard and its registry). One PR: the owner asked for one
(11-27). At the review-round cap, carve out the disputed part (rule 5), not another round.

## Global Constraints

- Default off; only the owner's terminal turns it on (`insideClaudeCode` refusal + the existing agent-line `db-refs` rule).
- **Switch off = today's behaviour, byte for byte:** for a ref without `autoMigrations: true` the guard reads and writes no attempt
  history and asks GitHub nothing. The go-path attempt rules (Task 2) apply only to a ref whose raw flag is true (even when `autoEntry`
  calls it ambiguous).
- `apply_migration` only. `execute_sql`, every other tool and dev projects behave exactly as today.
- Any doubt (GitHub error, partial answer, timeout, bad shape, unreadable history, marker write failure, no time left) = no allow.
- Files: `supabase/migrations/<name>.sql` at the repo root; `name` matches `STEM_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/`.
- Bytes: `Buffer.from(query, 'utf8')` equals `Buffer.from(blob.text, 'utf8')` exactly (no trimming, no BOM or newline normalising).
- After-deploy: `AFTER_DEPLOY_RE = /pipeline:[ \t]*apply-after-deploy/i` anywhere in the query (any position, after a BOM, indented,
  inside any comment) ⇒ never auto. Detection only; the bytes stay exact for hashing and comparison.
- Age: exactly one commit on the default branch touched the path; its `committedDate` matches
  `/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/`, parses finite, is at most `AUTO_MAX_AGE_MS = 7 * 24 * 3600 * 1000`
  before `now()` and not after `now() + FUTURE_SKEW_MS` (owner-go.mjs).
- Provenance predicate (exactly what the guard verifies; no claim about merge methods): the single commit is the `mergeCommit.oid` of
  an associated PR with `merged: true` and `baseRefName` = the default branch name, whose files list the path with `changeType:
  'ADDED'`. (A squash merge and a one-commit rebase merge pass; a merge commit, a multi-commit rebase in which another commit touched
  the path, a direct push, a rename and a delete + re-add do not.)
- GitHub: `gh api --hostname github.com graphql …` always; the answer's `repository.nameWithOwner` equals the entry's `repo`
  case-insensitively; an answer with an `errors` key is a failure even with `data`.
- Time: `leftMs()` = what is left of the hook's wall cap (`wallLeftMs` of the evaluation budget, `script-candidates.mjs`; with
  `HOOK_CLOCK` it counts from the hook process start). Every child process on the decision path (the go path's git reads, including
  those under click settling, and every gh call) gets `timeoutMs = min(own, leftMs())` and is not started under 1 ms (the
  `boundedTimeout` pattern, `git-wiring.mjs:15`); a gh call is not started under `AUTO_MIN_START_MS = 1500`; file scans (pending clicks,
  generations) check `leftMs()` between entries; the final claim is not started under `AUTO_MIN_CLAIM_MS = 500`. Out of time ⇒ deny
  "try the call again". A stalled local filesystem call (a hung fsync) is the one blocking step not bounded: residual (spec).
- History (only for a ref with the flag): `~/.claude/pipeline-state/owner-go/live-db-attempts/`, generation files
  `name-<id>-<n>.json` (id = first 32 hex of sha256(`name|${ref}|${name}`)) and `sql-<id>-<n>.json` (sha256(`sql|${ref}|${sqlSha256}`)),
  `n` = 1, 2, … contiguous, at most `MAX_GENERATIONS = 64` per key (more = unreadable history). The go's consumed marker stays in
  `live-db-consumed/` with its id unchanged.
- Durability: exclusive create (`O_EXCL|O_NOFOLLOW`), every byte written (loop on `writeSync`'s count; a 0-byte write = error), fsync
  file, close, fsync folder; a folder the writer creates is fsynced in its parent too (POSIX: any fsync error = error; win32: opening a
  folder fails with EISDIR/EPERM/EINVAL and is tolerated, documented: NTFS journals metadata).
- `docs/cli.md` must contain each changed command's `meta.usage` verbatim (`test/cli.test.mjs`).
- Tests follow owner rule 6: each test names the failure it catches; extend the existing test files.

## Review Focus

1. Every path to `allow()` for a live `apply_migration` on a flagged ref passes through successful exclusive creates of the NEXT
   generation for both the name key and the SQL key, after which no earlier go can pass the freshness rule. Tests: Task 2/3 sequential
   and two-process cases.
2. No blocking child process or scan can carry the hook past its 15 s host timeout (Claude Code allows a hook that times out). Test:
   the real-hook tests in Task 3.
3. An answer from GitHub proves the provenance predicate (Global Constraints) or the call is not eligible. Tests: Task 3.
4. The module exports no generic writer; every marker it can create only withholds an allow. Test: Task 3 API-surface case.
5. Switch off is today's behaviour: no history read or written, no GitHub call, no new refusal. Test: Task 2.
6. A registry written by an older install (no key), and an older install reading a newer file (the PC lags a `pipeline update`):
   off on both, never invalid. New reads old: Task 1. Old reads new holds by construction (the old `validEntry` checks only its named
   fields and `readDbRefs` drops the rest): say so in the PR body.
7. GitHub answers with `repository: null` (the registry's `repo` was renamed or moved, as DRMed's was): not eligible with a reason
   naming the repo, never a throw. Test: Task 3.

---

### Task 1: The owner's switch and the import of earlier applies

**Files:**
- Modify: `pipeline/hooks/lib/db-refs.mjs` (`validEntry`, `readDbRefs`, `writeDbRefs`, new `autoEntry`)
- Modify: `pipeline/commands/db-refs.mjs` (new subcommand, `set` rules, `meta.usage`)
- Modify: `docs/cli.md` § `db-refs` (paste the new `meta.usage`)
- Test: `test/db-refs.test.mjs`

**Interfaces:**
- Produces: `readDbRefs(home)` entries are `{ ref, name, repo, kind, autoMigrations }`, `autoMigrations` always a boolean (false when
  absent). `writeDbRefs` writes the key only on entries where it is true.
- Produces: `autoEntry(ref, state) -> { entry } | { entry: null, reason }`: the entry when it is live, has a repo, `autoMigrations ===
  true`, and no OTHER entry with `autoMigrations === true` has the same repo (case-insensitive); else `reason` ('off' |
  'ambiguous: <other ref> has the same repo').
- Produces: `pipeline db-refs auto-migrations on|off --ref <ref> [--accept-unmatched]` → `{ ok, file, refs, servers, note?, imported?,
  unmatched? }`. `on`, in this order, writing nothing until all checks pass: the four refusals (unknown ref, dev ref, no repo, another
  enabled ref of the same repo); then the IMPORT (Task 2's `importGoHistory`, run in the owner's terminal with no time limit): every
  migration go of this ref ever consumed on this machine becomes generation history (name and SQL keys); a consumed migration marker of
  this ref whose go record is gone (no name) becomes SQL-key history and is listed in `unmatched` (`sqlSha256` first 12, `consumedAt`);
  an unreadable consumed marker or record file refuses `on` naming it. With `unmatched` non-empty and no `--accept-unmatched`, `on`
  refuses (exit 2) with the list and why ("if one of these was a migration whose file was changed in its PR after the go, auto-apply
  would apply the new version too: compare the times with your merged PRs, then run again with --accept-unmatched"). Then it creates the
  history folder durably and sets the flag. `note`: "auto-apply trusts every PR merged into <repo>'s default branch on github.com:
  migrations there must need your merge (a hard stop on supabase/migrations/**)". `off` clears the flag and keeps the history.

- [ ] **Step 1: Write the failing tests** in `test/db-refs.test.mjs` (owner runs through `runOwnerCli`, seeds through `seedRegistry`):
  - `auto-migrations on|off: the owner turns it on and off for a live ref with a repo; show prints it; on says what it trusts and makes
    the history folder` — after `on`, `readDbRefs(home).refs[0].autoMigrations === true`, `output.note` names the repo, the folder
    exists; after `off`, `false`, no key in the file, the history kept. *(the switch works; the owner is told the trust premise)*
  - `auto-migrations refuses inside Claude Code; an unknown ref, a dev ref, an entry without repo and a second ref of the same repo
    are usage errors; nothing is written` — inside: exit 2 `refused`; the four bad cases: direct `run()` rejects with `UsageError`
    (`assert.rejects`), the CLI form exits 2; file bytes unchanged. Second ref: `o/R` vs an enabled `O/r`. *(owner-only; one target)*
  - `auto-migrations on imports this project's earlier go applies; an apply with no recoverable name refuses until accepted` — seed
    one go record + its consumed marker (typed) and one click record + its consumed marker for REF, one consumed marker for REF with no
    record, one for another ref: `on` exits 2 listing the unmatched one, nothing written; `on --accept-unmatched` ⇒ generation 1 for
    both keys of the two matched applies (`via: 'go-import'`, their `consumedAt`), SQL key only for the unmatched, nothing for the other
    ref; running `on` again adds nothing. An unparsable consumed marker of any ref refuses `on` naming it. *(R2-4: an apply made before
    the switch, of a file later changed under the same name, is not auto-applied again)*
  - `set keeps auto-migrations for a label-only edit; a new repo or --dev clears it` — `on`; `set` same ref, same repo, new name ⇒
    true; `set` with `--repo other/x` ⇒ false; `on` again, `set --dev` ⇒ false. *(a repo reassignment does not carry the trust)*
  - `readDbRefs: autoMigrations absent reads false; a non-boolean, or true on a dev entry or one without repo, is invalid`.
  - `autoEntry: two enabled entries with the same repo (hand-written registry) answer ambiguous for both`. *(the wrong database)*
  - Update the existing exact `show` expectation (`test/db-refs.test.mjs:41`) to carry `autoMigrations: false`.
  - In the existing `guard: an agent line running pipeline db-refs set|remove|server is refused` test add
    `node ~/.claude/pipeline/bin/pipeline.mjs db-refs auto-migrations on --ref ${REF}` to the refused lines.
- [ ] **Step 2: Run them** `node --test test/db-refs.test.mjs` → the new tests FAIL.
- [ ] **Step 3: Implement.** `validEntry`: `autoMigrations` absent or boolean; true requires `kind === 'live'` and a non-null `repo`.
  `readDbRefs` maps it to a boolean. `writeDbRefs` maps entries to `{ ref, name, repo, kind, ...(e.autoMigrations === true ?
  { autoMigrations: true } : {}) }`. The subcommand per the Interfaces (the import needs Task 2's `importGoHistory`: build Task 2's
  module first or stub the call until then). `set` copies the flag only when the new entry is live and its repo equals the old one
  case-insensitively. Update `meta.usage` (also `show`: `refs: [{ref, name, repo, kind, autoMigrations}]`) and `docs/cli.md`.
- [ ] **Step 4: Run** `node --test test/db-refs.test.mjs test/cli.test.mjs` → PASS.
- [ ] **Step 5: Commit** `feat(db-refs): owner-only auto-migrations switch; on imports the project's earlier go applies`.

### Task 2: The history module, the go path on flagged refs, the time budget

**Files:**
- Create: `pipeline/hooks/lib/live-db-auto.mjs` (this task: the writer, the generations, the claims, the import, the log reader;
  Task 3 adds the auto check)
- Modify: `pipeline/hooks/lib/live-db-guard.mjs` (`takeMarker` replaced by `claimGoMarker`; `claimLiveDbGo` generation rules on a
  flagged ref and bounded git; `evaluateSupabaseMcp` takes `ctx.leftMs`; `LIVE_DB_CONSUMED_REL` re-exported from the new module)
- Modify: `pipeline/hooks/lib/owner-go-click.mjs` (`settlePendingClicks` and `bindAnswer` take an optional `{ leftMs, io }` and pass
  the bounded `io` to `verifyBlock`; the pending scan checks `leftMs()` between files and stops with a `no-time` problem)
- Modify: `pipeline/hooks/lib/files-policy.mjs` (`OWNER_GO_LIBS` gains `live-db-auto`; `evaluateMcp` passes `leftMs`)
- Test: `test/live-db-guard.test.mjs`, `test/guard-files.test.mjs`

**Interfaces (all in `live-db-auto.mjs`; nothing else is exported):**
- `LIVE_DB_CONSUMED_REL`, `LIVE_DB_ATTEMPTS_REL = '.claude/pipeline-state/owner-go/live-db-attempts'`, `MAX_GENERATIONS`.
- Private `durableDir(home, rel, io)` (the `realDirChain` walk; each folder it creates is fsynced in its parent) and
  `createMarker(dir, file, body, io) -> 'claimed' | 'spent' | 'error'` (the exclusive create and the complete write/fsync/close/
  fsync-folder sequence). `io` seam names unchanged (`openSync`, `writeSync`, `fsyncSync`, `closeSync`, plus `lstatSync`,
  `readFileSync`, `mkdirSync`), so the existing fault tests keep passing.
- `claimGoMarker({ home, session, promptId, click, op, projectRef, name, sqlSha256, now, io }) -> 'claimed' | 'spent' | 'error'`: the old
  `takeMarker` (same id derivation; the body gains `name`).
- `history({ home, ref, name, sqlSha256, leftMs, io }) -> { status: 'ok', name: { n, at }, sql: { n, at } } | { status: 'error', path,
  reason } | { status: 'no-time' }`: for each key, `lstat` `-1`, `-2`, … until ENOENT (ENOENT on the folder = `n: 0`); `n` = the last
  generation, `at` = the LATEST time over all its generations (a body's finite ISO `at`, else the file's mtime: empty, unparsable,
  partial); a folder, a symlink, a read error, a gap, or more than `MAX_GENERATIONS` = error.
- `claimNext({ home, via, session, now, facts, seen, leftMs, io }) -> { status: 'claimed', event } | { status: 'spent', path } | { status:
  'error' | 'no-time', reason }`: validates `via` ('auto' | 'go'), `facts.ref` (`REF_RE`), `facts.sqlSha256` (64 hex), `facts.name` (a
  string); builds the body itself (`v`, `event` = 16 random hex, `pair` = the partner file, `at`, `via`, session, the facts); creates
  `name-<id>-<seen.name.n + 1>.json` then `sql-<id>-<seen.sql.n + 1>.json`; EEXIST on either = spent (the one created stays: it is a
  reservation, counted as an attempt); needs `AUTO_MIN_CLAIM_MS` left before the first create.
- `importGoHistory({ home, ref, now }) -> { ok, imported: [{ name, sqlSha256, consumedAt }], unmatched: [{ sqlSha256, consumedAt }] } |
  { ok: false, path, reason }` (owner terminal only, called by Task 1's `on`; refuses inside Claude Code like `writeDbRefs`): reads
  every `live-db-consumed/*.json` (op `migration`, this ref) and every `live-db-go` record of every `owner-go/*.jsonl` (no age limit,
  `settle: false`), matches a record to its consumed marker by the same id derivation as `claimGoMarker`, and for each consumed apply
  appends a generation (`via: 'go-import'`, `at` = its `consumedAt`) to each known key whose latest time is earlier.
- `readAttemptLog({ home, sinceMs, io }) -> { events, unreadable }` (Task 4; best-effort parsing lives only here).

**`claimLiveDbGo` change** (op `migration` AND the ref's raw flag true; everything else unchanged): for each verified, unexpired record
with go time `goAt`: (a) `history` — error ⇒ return `{ status: 'error', reason: 'the attempt history <path> cannot be read …' }`,
no-time ⇒ deny "try the call again"; (b) when either key has `n > 0`: the go is not used (skip as spent, nothing consumed) if
`max(name.at, sql.at) >= goAt` ("an attempt at this migration (this name or this exact SQL) was recorded at <time>, after this go:
check the live state read-only, then ask for a new go") or `goAt > now()` (a go stamped ahead of the clock cannot be ordered after an
attempt); (c) `claimGoMarker` as today; (d) `claimNext({ via: 'go', seen })` — spent ⇒ return spent ("another session attempted it
meanwhile; this go is used"), error/no-time ⇒ deny. Every git read under `verifyBlock`, direct or through `settlePendingClicks` →
`bindAnswer`, gets an `io.git` that clamps `timeoutMs` to `leftMs()` and throws under 1 ms (caught there: the record is unverified, a
deny). The builder greps every callee of `claimLiveDbGo` for other child processes and bounds them the same way.

**`evaluateMcp` change** (`files-policy.mjs:930`): `const budget = opts._budget ?? newEvalBudget(opts.now, opts.cpu, opts.wall0)` and
`leftMs: () => wallLeftMs(budget)` in the `evaluateSupabaseMcp` ctx.

- [ ] **Step 1: Write the failing tests** in `test/live-db-guard.test.mjs` (existing `scene` helper; `seedRegistry` for the flag):
  - `switch off: a go apply reads and writes no history and refuses nothing new` — no flag, the history folder replaced by a FILE:
    `apply(s)` allow, the file untouched, no `live-db-attempts` content. *(R2 P2: off is today's behaviour)*
  - `flag on: a go-claimed apply records generation 1 under its name and its SQL; a second go typed after it records generation 2` —
    files `name-*-1`, `sql-*-1` (`via: 'go'`, one `event`, each `pair` names the other); a new scene whose go is typed after that ⇒ `-2`.
    *(every allowed apply advances the history)*
  - `flag on: a failed attempt, then two gos in two sessions: only the first go applies` — seed generation 1 at `NOW - 600_000`;
    session A's go at `NOW - 300_000` ⇒ allow (generation 2 at NOW - 120_000 via the ctx clock); session B's go at `NOW - 240_000` ⇒
    deny /after this go/, B's go not consumed. *(R2-1: the sequential second-generation retry)*
  - `flag on: an old go cannot apply after a later attempt; a go typed after it can; a go stamped in the future cannot retry` — seed
    generation 1 at `NOW - 30_000`; go at `NOW - 60_000` ⇒ deny, not consumed; go at `NOW - 10_000` ⇒ allow; go at `NOW + 60_000`
    (inside the verifier's skew) ⇒ deny. *(R1-1 stale go; R2-1 clock skew)*
  - `flag on: an empty generation counts at its mtime; a gap, a folder, a symlink or an unreadable folder refuses naming the path` —
    seed with `utimesSync` at the fixture clock. *(R1-6)*
  - `markers and folders are durable or the call is denied` — `io.writeSync` that writes 3 bytes then returns 0 ⇒ deny; EIO on
    opening the history folder ⇒ deny; the history folder missing and `fsyncSync` failing on its parent ⇒ deny. The existing
    consumed-marker fault tests stay unchanged. *(R1-6 short write; R2-5 first-use folder)*
  - `out of time: a go whose git reads, or whose pending-click settling, find no time left is unverified (deny), never an allow` —
    `ctx.leftMs: () => 0` with a valid typed go ⇒ deny, go not consumed; 500 pending click files of other sessions in `asks/` with a
    `leftMs` that runs out after 10 reads ⇒ deny, not every file read. *(R2-2: unbounded local work before the decision)*
  - Two processes (extend the existing two-process test): `two gos of the same migration in two sessions after one failed attempt:
    exactly one allow` (children run the full go claim; both see generation 1). *(R2-1 concurrent)*
  - Coexistence: in the existing previous-owner-go test (flag on), assert `live-db-attempts/` exists after the apply and the old
    readers still report nothing unreadable. *(rollback to the previous release)*
  - In the existing `OWNER_GO_LIBS` assertion in `test/guard-files.test.mjs` (grep `live-db-go.mjs`), add
    `node ~/.claude/pipeline/hooks/lib/live-db-auto.mjs` to the refused lines. *(an agent runs the history library by hand)*
- [ ] **Step 2: Run** `node --test test/live-db-guard.test.mjs test/guard-files.test.mjs` → the new tests FAIL; the existing PASS.
- [ ] **Step 3: Implement** per the Interfaces and the change blocks above.
- [ ] **Step 4: Run** `node --test test/live-db-guard.test.mjs test/live-db-go.test.mjs test/live-db-click.test.mjs test/owner-go-click.test.mjs test/guard-files.test.mjs` → PASS (drop a file the repo does not have).
- [ ] **Step 5: Commit** `feat(live-db): generation history for go-claimed migrations on flagged projects; one time budget`.

### Task 3: The auto path

**Files:**
- Modify: `pipeline/hooks/lib/live-db-auto.mjs` (the auto check)
- Modify: `pipeline/hooks/lib/live-db-go.mjs` (export `sqlCharProblem`; `migrationSqlProblem` calls it first)
- Modify: `pipeline/hooks/lib/live-db-guard.mjs` (`evaluateSupabaseMcp`: auto after the go)
- Test: `test/live-db-guard.test.mjs`

**Interfaces:**
- Consumes: `autoEntry` (Task 1); `history`, `claimNext` (Task 2); `gh(args, opts) -> { code, stdout, stderr, timedOut, overBuffer }`
  from `pipeline/lib/proc.mjs` (through `io.gh ?? gh`, `env` from ctx); `FUTURE_SKEW_MS`; `sha256Of`.
- Produces in `live-db-auto.mjs`: `AUTO_MAX_AGE_MS`, `AUTO_GH_TIMEOUT_MS = 6000`, `AUTO_MIN_START_MS`, `AUTO_MIN_CLAIM_MS`, `STEM_RE`,
  `AFTER_DEPLOY_RE`, and `autoApply({ home, entry, name, query, session, now, leftMs, env, io }) -> { status: 'claimed', facts } |
  { status: 'not-eligible' | 'spent' | 'error' | 'no-time', reason }` = the checks below, then `claimNext({ via: 'auto' })`.

Check order (stop at the first failure; `reason` is one plain sentence):
1. `AFTER_DEPLOY_RE` ⇒ not eligible ("marked apply-after-deploy: it takes the owner's go after the deploy"). 2. `STEM_RE.test(name)`.
3. `sqlCharProblem(query) === null`. 4. `history`: error ⇒ error; either key `n > 0` ⇒ spent (with the latest time). 5. `leftMs() >=
AUTO_MIN_START_MS` else no-time. 6. The GraphQL call and the answer rules (Global Constraints), paging PR files while `hasNextPage`
and time is left (at most 30 pages). 7. `claimNext({ via: 'auto', seen })` (both keys at generation 1).

GraphQL (shape verified 2026-11-27 against eaglewatch-ph/eaglewatch #2582: one history node = the PR's `mergeCommit`, `ADDED`):
```graphql
query($o:String!,$n:String!,$p:String!){ repository(owner:$o,name:$n){ nameWithOwner defaultBranchRef { name target { ... on Commit {
  oid file(path:$p){ object { ... on Blob { text isBinary isTruncated } } }
  history(path:$p, first:2){ nodes { oid committedDate associatedPullRequests(first:5){ nodes { number merged baseRefName
    mergeCommit { oid } files(first:100){ pageInfo { hasNextPage endCursor } nodes { path changeType } } } } } } } } } } }
```
Page: `repository(owner:$o,name:$n){ pullRequest(number:$num){ files(first:100, after:$after){ pageInfo { hasNextPage endCursor }
nodes { path changeType } } } }` (`-F num=<n>`). Args: `['api', '--hostname', 'github.com', 'graphql', '-f', 'query=…', '-f', 'o=…',
'-f', 'n=…', '-f', 'p=…']`, `{ env, timeoutMs, maxBuffer: 8 MiB }`; `timedOut`, `overBuffer`, a non-zero exit or unparsable JSON = not
eligible. Parsing is inside try/catch: every unexpected shape is `{ status: 'not-eligible' }`, never a throw out of the hook.

**`evaluateSupabaseMcp` change** (inside the existing `execute_sql || apply_migration` branch, after the `migName` check): the go claim
runs first (Task 2). `claimed` ⇒ allow. Otherwise, for op `migration` when `c.status !== 'error'` and `autoEntry(target.ref, state)`
gives an entry: `autoApply`; `claimed` ⇒ allow. A deny that had an auto result adds ` Auto-apply did not apply: <reason>.` before the
existing go guidance (`spent` ⇒ "auto-apply was already attempted for <name> on this machine at <time>: check the live state read-only,
then ask for the owner's go"; `no-time` ⇒ "not enough time was left to check: try the call again").

- [ ] **Step 1: Write the failing tests** in `test/live-db-guard.test.mjs`. A new `autoScene(t, over)` helper: scratch home,
  `seedRegistry` with `{ ref: REF, name: 'EagleWatch prod', repo: 'acme/widgets', kind: 'live', autoMigrations: true }`, the history
  folder created, a fake `io.gh` that records its args and answers from `ghAnswer(over)` (defaults: `nameWithOwner: 'acme/widgets'`,
  branch `main`, head H, `text: SQL`, one history node `{ oid: C, committedDate: NOW - 3_600_000 as ISO Z }` whose PR 42 is merged into
  `main` with `mergeCommit.oid = C` and `files: [{ path: FILE, changeType: 'ADDED' }]`). No transcript go. Each test asserts the
  decision, the history files and the gh call count:
  - `auto: a merged, identical, recent file applies with no go, once; the history names the PR and commit` — allow; `name-*-1` and
    `sql-*-1` with `via: 'auto'`, `pr: 42`, `commit: C`; a second identical call ⇒ deny /already attempted/, no second gh call.
  - `auto off (flag absent) and execute_sql with the switch on: the go is needed and GitHub is asked nothing` — data SQL and
    `begin; … rollback;` too. *(default off; scope stays migrations)*
  - `auto: one byte different (trailing newline, BOM, CRLF) needs the go and burns nothing`. *(an edited copy)*
  - `auto: GitHub's answer does not prove the file is on github.com's default branch of this repo` — `file: null`, `repository:
    null` (reason names the repo), `errors` with partial `data`, `nameWithOwner: 'other/widgets'`, `defaultBranchRef: null`, a binary
    blob, a truncated blob ⇒ deny each, no history, no throw. *(unmerged file; moved repo; partial answer; another repo)*
  - `auto: an old, edited or re-added file needs the go; the date is read strictly` — two history nodes; 7 d + 1 ms; 6 min in the
    future; `committedDate` without a zone or not a date ⇒ deny; exactly 7 d, and an in-window time written with `+08:00` ⇒ allow.
  - `auto: only a file a merged PR ADDED counts` — no associated PR (a direct push), `merged: false`, base `release`,
    `mergeCommit.oid` ≠ the commit, `changeType: 'RENAMED'`, the path missing from the files ⇒ deny each; a PR whose first 100 files
    lack the path with `hasNextPage` ⇒ a second gh call (args name the PR number and the cursor) answering `ADDED` ⇒ allow, answering
    without it ⇒ deny. *(R1-4: direct add, rename, re-add)*
  - `auto: the GitHub question is pinned to github.com and names the registry repo and the migration path` — args start
    `['api', '--hostname', 'github.com', 'graphql']` and carry `o=acme`, `n=widgets`, `p=${FILE}`, also with `env: { GH_HOST:
    'ghe.example' }` in ctx. *(R1-3)*
  - `auto: a bad name or an after-deploy marker needs the go and asks GitHub nothing` — a slash, a space, a leading dot, 201
    characters; the marker on line 1, after a BOM, indented by a space and a tab, on line 3, in upper case, inside `/* … */`: 0 gh calls,
    no history. *(R2-3: a policy-tightening file runs before the deploy)*
  - `auto: gh fails (exit 1), times out, overflows or prints non-JSON: deny, never allow`. *(fail closed)*
  - `auto: little time left: no gh call under 1.5 s, no claim under 0.5 s; the gh timeout never exceeds what is left` —
    `ctx.leftMs: () => 1000` ⇒ 0 calls, deny /try the call again/; a `leftMs` that drops to 400 after the gh call ⇒ deny, no history;
    `() => 4000` ⇒ `timeoutMs <= 4000`. *(R1-2, R2-2 unit)*
  - `auto: a go is used first; after it, auto never applies the same migration again` — `scene` with a go + the flag on + an eligible
    answer: first `apply` allow with `via: 'go'` history and 0 gh calls; second identical `apply` deny. *(R1-1: one session)*
  - `auto: the same SQL under a second name is refused` — auto `NAME` allow; auto `NAME2` with the same query ⇒ deny /already
    attempted/ (the `sql-*` history). *(R1-1: two names)*
  - `auto: an imported earlier go apply (generation via go-import) blocks it` — seed `name-*-1` only, then `sql-*-1` only ⇒ deny both
    times, 0 gh calls. *(R2-4 in the guard)*
  - `auto: two enabled entries with the same repo: auto is off for both and GitHub is asked nothing`. *(R1 P2: the wrong database)*
  - `the module exports only fixed-destination claims; hostile names stay inside their folders` — the export list equals the final
    surface (Tasks 2 + 3); `claimNext` with name `../../db-refs` and `claimGoMarker` with promptId `../../x` create only hashed files in
    their folders; `db-refs.json` absent afterwards. *(R1-5)*
  - Two processes (extend the existing two-process test; children build the fake gh inline): two auto claims of the same file; two auto
    claims of the same SQL under two names; an auto claim and a go claim of the same migration ⇒ exactly one allow each. *(races)*
  - `through the real hook entry: GitHub that never answers, and a populated pending-click folder, are a deny within the host timeout`
    — spawn `pipeline/hooks/guard-files.mjs` (the `spawnHook` pattern of `test/guard-deny-log.test.mjs:195`) with `HOME` = the scratch
    home, the flag on, no go: (1) `PIPELINE_GH` = `node <scratch>/slow-gh.mjs` (sleeps 30 s) ⇒ deny in under 14 s, reason says GitHub
    did not answer in time; (2) 5,000 pending click files of other sessions + the slow gh ⇒ deny in under 14 s. *(R1-2/R2-2 end to end:
    a killed hook counts as an allow)*
- [ ] **Step 2: Run** `node --test test/live-db-guard.test.mjs` → the new tests FAIL; the existing PASS.
- [ ] **Step 3: Implement** `autoApply` per the check order; export `sqlCharProblem` from `live-db-go.mjs` (empty, U+FFFD, CR/NUL,
  `HIDING_CHARS`) and have `migrationSqlProblem` call it first; wire `evaluateSupabaseMcp`.
- [ ] **Step 4: Run** `node --test test/live-db-guard.test.mjs test/live-db-go.test.mjs test/live-db-click.test.mjs test/db-refs.test.mjs` → PASS.
- [ ] **Step 5: Commit** `feat(live-db): auto-apply a migration a merged PR added, with no go, when the owner switched it on`.

### Task 4: `pipeline live-db auto-log`

**Files:**
- Modify: `pipeline/commands/live-db.mjs` (subcommand, `meta.usage`)
- Modify: `docs/cli.md` § `live-db` (paste `meta.usage`)
- Test: `test/live-db-go.test.mjs`

**Interfaces:**
- Consumes: `readAttemptLog({ home, sinceMs })` (Task 2).
- Produces: `pipeline live-db auto-log [--days N]` → `{ ok, events: [{ at, via, outcome, ref, label, name, file, pr, commit, repo,
  session, generation }], unreadable: [<path>] }`, newest first, default 30 days, read-only, runs anywhere (not an owner command).
  One entry per `event`: `outcome: 'attempted'` when both files of the event exist (an allowed call: "attempted, not necessarily
  applied: the session's effect check says applied"), `'reserved'` when only one does (a lost race or a failed write: nothing allowed).

- [ ] **Step 1: Write the failing test** `auto-log lists each allowed call once, a lost reservation as reserved, and an unreadable
  record` — seed: an auto event (generation 1), a go retry event (generation 2), a lone `name-*` from a lost race, one 40 days old,
  one empty file; `run(['auto-log'], ctx)` ⇒ the retry, the auto event, the reservation, newest first, the empty one in `unreadable`;
  `--days 60` adds the old one; `--days 0` and `--days x` ⇒ `UsageError`. *(R2 P2: the log accounts for every allowed call)*
- [ ] **Step 2: Run** `node --test test/live-db-go.test.mjs` → FAIL (unknown subcommand).
- [ ] **Step 3: Implement** the subcommand; update `meta.usage` and `docs/cli.md`.
- [ ] **Step 4: Run** `node --test test/live-db-go.test.mjs test/cli.test.mjs` → PASS.
- [ ] **Step 5: Commit** `feat(live-db): auto-log lists the migration attempts`.

### Task 5: The review skill and the guard docs

**Files:**
- Modify: `skills/review/reference/owner-merge.md` § "Live-database go" (new "Auto-apply after the merge" part; step 7 unchanged in
  meaning: a `\uXXXX` file is applied by the owner)
- Modify: `skills/review/reference/ready-and-handoff.md:44` (the one-line rule names the auto path)
- Modify: `docs/cli.md` § "Live database guard" (the switch and its import, switch-off behaviour, the go-first order, the generation
  history, the provenance predicate, the time budget and its one unbounded step, the Windows durability note, the residuals)

- [ ] **Step 1: Write the skill text** from spec section 5, as numbered steps:
  - The merge-request sentence: only when `P db-refs show` has exactly ONE entry with `autoMigrations: true` whose `repo` equals this
    repo case-insensitively, and the PR adds `supabase/migrations/*.sql`: name EVERY migration file, and say which are marked
    apply-after-deploy (they wait for the deploy and one click). An after-deploy file that sorts before an unmarked one: fix the
    numbering before the merge request.
  - When, and which commit: every non-vetoed merged outcome needs a full 40-hex merge sha: the merge job's `mergeSha`; when it is
    missing (or for `error: hold-recovery` with `prMerged: true`), `gh pr view N --json state,mergeCommit` with `state: MERGED`; not
    recoverable ⇒ stop and tell the owner (nothing applied). A merge reported under a veto (`merge-queue.mjs:594`'s warning, or the queue
    sweep's report): apply nothing, tell the owner, then the go path on their word.
  - Which files and bytes: `git fetch origin <mergeSha>`, then `git diff --name-status <mergeSha>^ <mergeSha> -- supabase/migrations/`
    `A` lines in filename order (an `R` line: tell the owner, the go path), bytes from `git show <mergeSha>:<file>` (never
    `origin/main`). Acceptance cases written into the text: a default branch not called `main`; a recovered merge; a vetoed merge; a
    merged result without a sha.
  - Every file goes through the same checks: (1) state the expected effect (every object; for a policy its roles, command, predicate
    and the table's RLS state); (2) read-only "is it live?" (`P live-db catalog …`; `list_migrations` by name is no proof: the ledger
    holds `apply_migration` stamps); live ⇒ skip and say so; (3) apply; (4) the full effect check: "applied" only when every part
    matches; inconclusive or different ⇒ stop and tell the owner.
  - Step (3) per file: unmarked ⇒ `apply_migration` (name = stem, query = the merge-sha bytes). Marked apply-after-deploy ⇒ stop the
    automatic sequence; wait for the production deployment of `mergeSha` (read `P config` `production`: its watch, at most
    `deploy_timeout_minutes`, in the background with `--interval 60`; failure, rollback or timeout ⇒ tell the owner, apply nothing);
    then, in the PR's worktree (KEEP it until every marked file is applied: the post-merge worktree clean-up skips it) at the PR head,
    check that `git show <head>:<file>` equals `git show <mergeSha>:<file>` byte for byte (different ⇒ stop and tell the owner), run
    `P live-db present --op migration --pr N --file <file> --project <ref> --summary "…" --ask` and the dialog; on the go,
    `apply_migration`; then the next files.
  - A refusal or failure stops that PR's remaining files: 🚨 tell the owner (the code is live without that schema), read-only live
    look, then the go path; rolling the code back and repairing the database are separate owner decisions.
  - Before-code migrations that cannot take the gap: the go before the merge, or their own PR. DO-wrap a top-level DROP in the file.
    A literal `\uXXXX`: the owner applies it. The report names the machine that applied (history is per machine).
- [ ] **Step 2: Run** `node --test test/docs-facts.test.mjs test/cli.test.mjs` → PASS (fix any fact the docs test pins).
- [ ] **Step 3: Commit** `docs(review): apply merged migrations after the merge when auto-apply is on`.

### After the build (not code; carried items)

- Full verify + the review loop per the `review` skill; owner "merge"; `pipeline update` on the Mac (the PC when online).
- Owner, own terminal, on the Mac only: `pipeline db-refs set --ref qhptbmafrosgibooelpp --name "EagleWatch live" --repo
  eaglewatch-ph/eaglewatch`, then `pipeline db-refs auto-migrations on --ref qhptbmafrosgibooelpp` (it lists any earlier apply it
  cannot name; `--accept-unmatched` after checking).
- Then Claude rewrites `~/Claude/eaglewatch/AGENTS.md` step 3 and the `eaglewatch-db-changes` skill (container root
  `.claude/skills/`) per spec section 6.
- Live check: the next merged EagleWatch migration is applied with no go, `pipeline live-db auto-log` lists the attempt, and the
  effect check matches the file.
