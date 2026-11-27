# Auto-apply merged migrations Implementation Plan

> **For agentic workers:** built through the `review` skill (this repo has `.claude/pipeline.yml`): one implementer per task or one
> for all five, then the pipeline's review rounds. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision 2 (2026-11-27)** after the Codex plan review R1 (7 × P1, 3 × P2, 1 × P3): go-first claim with two attempt markers and a
freshness rule (P1-1), one time budget through the hook (P1-2), pinned host and repository identity (P1-3), merged-PR-added proof
(P1-4), a private marker writer behind fixed-destination claims (P1-5), complete writes and fail-closed history reads (P1-6), and the
owner's pick for after-deploy files: they keep the go (P1-7; the deploy-checked variant is idea #882). P2/P3 folded into Tasks 1, 4, 5.

**Goal:** a migration file that a merged PR added to the registered repo's default branch is applied to that repo's live Supabase
project with no owner go, when the owner switched auto-apply on for that project.

**Architecture:** an owner-only flag on the db-refs registry entry; a new hook library `live-db-auto.mjs` that owns every live-db
marker (a private writer; fixed-destination claims), checks the call against the file on GitHub (one GraphQL call) and records each
attempt under two keys; `evaluateSupabaseMcp` tries the owner's go first, then auto, inside one time budget; a read-only
`live-db auto-log`; the review skill applies after the merge.

**Tech Stack:** Node ESM, `node:test`, the pipeline's `gh` runner (`pipeline/lib/proc.mjs`).

**Spec:** `docs/specs/2026-11-27-auto-apply-migrations-design.md` (Revision 2; read it first; this plan does not repeat its reasons).

**Size:** about 1,000 lines with tests, one subsystem (the live-database guard and its registry). One PR: the owner asked for one
(11-27). At the review-round cap, carve out the disputed part (rule 5), not another round.

## Global Constraints

- Default off; only the owner's terminal turns it on (`insideClaudeCode` refusal + the existing agent-line `db-refs` rule).
- `apply_migration` only. `execute_sql`, every other tool and dev projects behave exactly as today, except that on every live
  project (switch on or off) a go-claimed `apply_migration` now also takes the attempt markers, and its go is refused when an attempt
  for that name or that SQL is recorded at or after the go's own time (Task 2).
- Any doubt (GitHub error, partial answer, timeout, bad shape, unreadable history, marker write failure, no time left) = no allow.
- Files: `supabase/migrations/<name>.sql` at the repo root; `name` matches `STEM_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/`.
- Bytes: `Buffer.from(query, 'utf8')` equals `Buffer.from(blob.text, 'utf8')` exactly (no trimming, no BOM or newline normalising).
- After-deploy: `AFTER_DEPLOY_RE = /^--[ \t]*pipeline:[ \t]*apply-after-deploy\b/im` anywhere in the query ⇒ never auto.
- Age: exactly one commit on the default branch touched the path; its `committedDate` matches
  `/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/`, parses finite, is at most `AUTO_MAX_AGE_MS = 7 * 24 * 3600 * 1000`
  before `now()` and not after `now() + FUTURE_SKEW_MS` (owner-go.mjs).
- Proof of the merge: that commit is the `mergeCommit.oid` of an associated PR with `merged: true`, `baseRefName` = the default branch
  name, and the path in its files with `changeType: 'ADDED'`.
- GitHub: `gh api --hostname github.com graphql …` always (an ambient `GH_HOST` is ignored by construction); the answer's
  `repository.nameWithOwner` equals the entry's `repo` case-insensitively; an answer with an `errors` key is a failure even with `data`.
- Time: `leftMs()` = what is left of the hook's wall cap (`wallLeftMs` of the evaluation budget, `script-candidates.mjs`). gh timeout
  = `min(AUTO_GH_TIMEOUT_MS = 6000, leftMs())`; a gh call is not started under `AUTO_MIN_START_MS = 1500`; every git read on the go
  path is clamped to `leftMs()` (the `boundedTimeout` pattern of `git-wiring.mjs:15`). No time ⇒ deny "try the call again".
- Markers: attempts in `~/.claude/pipeline-state/owner-go/live-db-attempts/`, `name-<id>.json` (id = first 32 hex of
  sha256(`name|${ref}|${name}`)) and `sql-<id>.json` (sha256(`sql|${ref}|${sqlSha256}`)); the go's consumed marker stays in
  `live-db-consumed/` with its id unchanged. Exclusive create (`O_EXCL|O_NOFOLLOW`), every byte written (loop on `writeSync`'s count;
  a 0-byte write = error), fsync file, close, fsync folder (POSIX: any error = error; win32: EISDIR/EPERM/EINVAL on opening the folder
  tolerated and documented) before the allow.
- `docs/cli.md` must contain each changed command's `meta.usage` verbatim (`test/cli.test.mjs`).
- Tests follow owner rule 6: each test names the failure it catches; extend the existing test files.

## Review Focus

1. Every path to `allow()` for a live `apply_migration` passes through exactly one successful exclusive create that no earlier attempt
   or other process could have made (go: the consumed marker + the attempt freshness rule; auto: both attempt markers). Test: Task 2/3
   two-process cases.
2. No blocking step can carry the hook past its 15 s host timeout (Claude Code allows a hook that times out). Test: the real-hook test
   in Task 3.
3. An answer from GitHub proves "a merged PR added these exact bytes to this repo on github.com" or the call is not eligible: no
   partial answer, other host, other repo, rename, direct push or non-squash merge passes. Tests: Task 3.
4. The module exports no generic writer; every marker it can create only withholds an allow. Test: Task 2 API-surface case.
5. A registry written by an older install (no key), and an older install reading a newer file (the PC lags a `pipeline update`):
   off on both, never invalid. New reads old: Task 1. Old reads new holds by construction (the old `validEntry` checks only its named
   fields and `readDbRefs` drops the rest): say so in the PR body.
6. GitHub answers with `repository: null` (the registry's `repo` was renamed or moved, as DRMed's was): not eligible with a reason
   naming the repo, never a throw. Test: Task 3.

---

### Task 1: The owner's switch

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
- Produces: `pipeline db-refs auto-migrations on|off --ref <ref>` → `{ ok, file, refs, servers, note? }` like `set`; `on` adds `note`:
  "auto-apply trusts every PR merged by squash into <repo>'s default branch on github.com: migrations there must need your merge (a
  hard stop on supabase/migrations/**)".

- [ ] **Step 1: Write the failing tests** in `test/db-refs.test.mjs` (owner runs through `runOwnerCli`, seeds through `seedRegistry`):
  - `auto-migrations on|off: the owner turns it on and off for a live ref with a repo; show prints it; on says what it trusts` —
    after `on`, `readDbRefs(home).refs[0].autoMigrations === true` and `output.note` names the repo; after `off`, `false` and the file
    has no `autoMigrations` key. *(the switch works; the owner is told the trust premise)*
  - `auto-migrations refuses inside Claude Code; an unknown ref, a dev ref, an entry without repo and a second ref of the same repo
    are usage errors; nothing is written` — inside: exit 2 `refused`; the four bad cases: direct `run()` rejects with `UsageError`
    (`assert.rejects`), the CLI form exits 2; file bytes unchanged. Second ref: `o/R` vs an enabled `O/r`. *(owner-only; one target)*
  - `set keeps auto-migrations for a label-only edit; a new repo or --dev clears it` — `on`; `set` same ref, same repo, new name ⇒
    true; `set` with `--repo other/x` ⇒ false; `on` again, `set --dev` ⇒ false. *(a repo reassignment does not carry the trust)*
  - `readDbRefs: autoMigrations absent reads false; a non-boolean, or true on a dev entry or one without repo, is invalid` —
    `{ ok:false, reason:'invalid' }` for `"yes"`, `{kind:'dev', autoMigrations:true}`, `{repo:null, autoMigrations:true}`.
  - `autoEntry: two enabled entries with the same repo (hand-written registry) answer ambiguous for both` — seed two, both null with
    `reason` /ambiguous/. *(the wrong database cannot be picked)*
  - Update the existing exact `show` expectation (`test/db-refs.test.mjs:41`) to carry `autoMigrations: false`.
  - In the existing `guard: an agent line running pipeline db-refs set|remove|server is refused` test add
    `node ~/.claude/pipeline/bin/pipeline.mjs db-refs auto-migrations on --ref ${REF}` to the refused lines.
- [ ] **Step 2: Run them** `node --test test/db-refs.test.mjs` → the new tests FAIL (unknown subcommand, key not returned).
- [ ] **Step 3: Implement.** `validEntry`: `autoMigrations` absent or boolean; true requires `kind === 'live'` and a non-null `repo`.
  `readDbRefs` maps it to a boolean. `writeDbRefs` maps entries to `{ ref, name, repo, kind, ...(e.autoMigrations === true ?
  { autoMigrations: true } : {}) }`. New subcommand (positionals `auto-migrations on|off`, only `--ref`), refused inside Claude Code
  by the same `inside` check as `set`; `on` checks the four refusals against the current state. `set` copies the flag from the entry it
  replaces only when the new entry is live and its repo equals the old one case-insensitively. Update `meta.usage` (also the `show`
  line: `refs: [{ref, name, repo, kind, autoMigrations}]`) and paste it into `docs/cli.md`.
- [ ] **Step 4: Run** `node --test test/db-refs.test.mjs test/cli.test.mjs` → PASS.
- [ ] **Step 5: Commit** `feat(db-refs): owner-only auto-migrations switch per live project`.

### Task 2: The marker module, the go path's attempt record, the time budget

**Files:**
- Create: `pipeline/hooks/lib/live-db-auto.mjs` (this task: the writer, the claims, the readers; Task 3 adds the auto check)
- Modify: `pipeline/hooks/lib/live-db-guard.mjs` (`takeMarker` removed in favour of `claimGoMarker`; `claimLiveDbGo` attempt rules
  and bounded git; `evaluateSupabaseMcp` takes `ctx.leftMs`; `LIVE_DB_CONSUMED_REL` re-exported from the new module)
- Modify: `pipeline/hooks/lib/files-policy.mjs` (`OWNER_GO_LIBS` gains `live-db-auto`; `evaluateMcp` passes `leftMs`)
- Test: `test/live-db-guard.test.mjs`

**Interfaces (all in `live-db-auto.mjs`; nothing else is exported):**
- `LIVE_DB_CONSUMED_REL`, `LIVE_DB_ATTEMPTS_REL = '.claude/pipeline-state/owner-go/live-db-attempts'`.
- Private `createMarker(dir, id, body, io) -> 'claimed' | 'spent' | 'error'`: `realDirChain`, the exclusive create and the complete
  write/fsync/close/fsync-folder sequence (Global Constraints). `io` seam names unchanged (`openSync`, `writeSync`, `fsyncSync`,
  `closeSync`), so the existing fault tests keep passing.
- `claimGoMarker({ home, session, promptId, click, op, projectRef, name, sqlSha256, now, io }) -> 'claimed' | 'spent' | 'error'`: the old
  `takeMarker` (same id derivation; the body gains `name`).
- `attemptState({ home, ref, name, sqlSha256, io }) -> { status: 'none' } | { status: 'seen', at, path } | { status: 'error', path,
  reason }`: `lstat` of the two exact paths; ENOENT on the folder or file = none; a regular file = seen at its body's `at` (a finite ISO
  time), or at its mtime when the body has none (empty, unparsable, partial); a folder, a symlink or any other error = error. (Tests
  that seed markers at fixture times set the mtime with `utimesSync` where the empty-body rule is exercised.) The later of the two markers wins.
- `claimAttempt({ home, via, session, now, facts, notBefore, io }) -> { status: 'claimed' } | { status: 'spent', at, path } | { status:
  'error', reason }`: validates `via` ('auto' | 'go'), `facts.ref` (`REF_RE`), `facts.sqlSha256` (64 hex), `facts.name` (a string);
  builds the body itself; creates `name-<id>.json` then `sql-<id>.json`. `auto`: either one existing = spent. `go`: an existing one
  is fine when its time (as in `attemptState`) is before `notBefore` (the go's own time), else spent.
- `readAttemptLog({ home, sinceMs, io }) -> { entries, unreadable }` (Task 4 uses it; best-effort parsing lives only here).

**`claimLiveDbGo` change** (op `migration` only; data is unchanged): for each verified, unexpired record with go time `at`:
(a) `attemptState` — error ⇒ return `{ status: 'error', reason: 'the attempt history <path> cannot be read …' }`; seen with
`seen.at >= at` ⇒ skip as spent ("an attempt at this migration (this name or this exact SQL) was recorded at <time>, after this go:
check the live state read-only, then ask for a new go"), nothing consumed; (b) `claimGoMarker` as today; (c) `claimAttempt({ via:
'go', notBefore: at })` — spent ⇒ return spent ("another session attempted it meanwhile"), error ⇒ error. Every git read under
`verifyBlock` gets an `io.git` that clamps `timeoutMs` to `leftMs()` and throws when under 1 ms (caught there, so the record is
unverified: a deny). The builder greps `claimLiveDbGo`'s callees (`live-db-go.mjs`, `owner-go.mjs`, `owner-go-click.mjs`) for any
other child process and bounds it the same way.

**`evaluateMcp` change** (`files-policy.mjs:930`): `const budget = opts._budget ?? newEvalBudget(opts.now, opts.cpu, opts.wall0)` and
`leftMs: () => wallLeftMs(budget)` in the `evaluateSupabaseMcp` ctx (with `HOOK_CLOCK` the cap counts from the hook process start).

- [ ] **Step 1: Write the failing tests** in `test/live-db-guard.test.mjs` (existing `scene` helper; `seedRegistry` for the flag):
  - `go: a go-claimed apply records the attempt under its name and its SQL` — `apply(s)` allow; `live-db-attempts/` holds `name-*` and
    `sql-*` with `via: 'go'`, the name and the sha. *(a migration applied by go is known to auto)*
  - `go: an old go cannot apply after a later attempt (another session)` — seed an attempt marker for NAME at `NOW - 30_000` (via
    `claimAttempt` as session B); session A's go typed at `NOW - 60_000` ⇒ deny /after this go/, and no new file in
    `live-db-consumed/` (the go is not burnt); a second scene whose go is typed at `NOW - 10_000` ⇒ allow. *(P1-1: stale go)*
  - `go: an empty attempt marker counts at its mtime; an unreadable history refuses the go naming the path` — empty `name-<id>.json`
    with mtime `NOW - 30_000` ⇒ a go typed before it is refused, after it allowed; the attempts folder replaced by a file, or the marker
    a directory or a symlink ⇒ deny naming the path. *(P1-6)*
  - `markers are complete or the call is denied` — `io.writeSync` that writes 3 bytes then returns 0 ⇒ deny; extend the existing
    fault test for the attempts folder (EIO on open). The existing consumed-marker fault tests stay unchanged. *(P1-6: short write)*
  - `the module exports only fixed-destination claims; hostile names stay inside their folders` — `Object.keys(await import(…))`
    equals the list above; `claimAttempt` with name `../../db-refs` and `claimGoMarker` with promptId `../../x` create only
    `name-<32 hex>.json` / `<32 hex>.json` in their folders; `db-refs.json` is absent afterwards. *(P1-5)*
  - `out of time: a go whose git reads find no time left is unverified (deny), never an allow` — `ctx.leftMs: () => 0` with a valid
    go ⇒ deny, go not consumed. *(P1-2, go path)*
  - Two processes (extend the existing two-process test): `a go claim and an auto-style attempt claim of the same migration: one wins`
    — one child runs `claimAttempt({ via: 'auto' })`, the other the full go claim; exactly one of them ends claimed. *(P1-1 race)*
  - Coexistence: in the existing previous-owner-go test, assert `live-db-attempts/` exists after the apply and the old readers still
    report nothing unreadable. *(rollback to the previous release)*
  - In the existing `OWNER_GO_LIBS` assertion (grep `live-db-go.mjs` in `test/guard-files.test.mjs`), add
    `node ~/.claude/pipeline/hooks/lib/live-db-auto.mjs` to the refused lines. *(an agent runs the marker library by hand)*
- [ ] **Step 2: Run** `node --test test/live-db-guard.test.mjs test/guard-files.test.mjs` → the new tests FAIL; the existing PASS.
- [ ] **Step 3: Implement** per the Interfaces and the two change blocks above.
- [ ] **Step 4: Run** `node --test test/live-db-guard.test.mjs test/live-db-go.test.mjs test/live-db-click.test.mjs test/guard-files.test.mjs` → PASS.
- [ ] **Step 5: Commit** `feat(live-db): attempt record for go-claimed migrations; one time budget through the guard`.

### Task 3: The auto path

**Files:**
- Modify: `pipeline/hooks/lib/live-db-auto.mjs` (the auto check)
- Modify: `pipeline/hooks/lib/live-db-go.mjs` (export `sqlCharProblem`; `migrationSqlProblem` calls it first)
- Modify: `pipeline/hooks/lib/live-db-guard.mjs` (`evaluateSupabaseMcp`: auto after the go)
- Test: `test/live-db-guard.test.mjs`

**Interfaces:**
- Consumes: `autoEntry` (Task 1); `attemptState`, `claimAttempt` (Task 2); `gh(args, opts) -> { code, stdout, stderr, timedOut,
  overBuffer }` from `pipeline/lib/proc.mjs` (through `io.gh ?? gh`, `env` from ctx); `FUTURE_SKEW_MS`; `sha256Of`.
- Produces in `live-db-auto.mjs`: `AUTO_MAX_AGE_MS`, `AUTO_GH_TIMEOUT_MS`, `AUTO_MIN_START_MS`, `STEM_RE`, `AFTER_DEPLOY_RE`, and
  `autoApply({ home, entry, name, query, session, now, leftMs, env, io }) -> { status: 'claimed', facts } | { status: 'not-eligible' |
  'spent' | 'error' | 'no-time', reason }` = the checks below, then `claimAttempt({ via: 'auto' })`.

Check order (stop at the first failure; `reason` is one plain sentence):
1. `AFTER_DEPLOY_RE` ⇒ not eligible ("marked apply-after-deploy: it takes the owner's go after the deploy"). 2. `STEM_RE.test(name)`.
3. `sqlCharProblem(query) === null`. 4. `attemptState` none (seen ⇒ spent with its time; error ⇒ error). 5. No `live-db-consumed/*.json`
whose body has `op: 'migration'`, `projectRef` = ref and `sqlSha256` = sha256(query) (spent); ENOENT on the folder = none; an
unreadable folder or entry, or an empty or unparsable body ⇒ error naming the file; `leftMs()` checked between entries. 6. `leftMs() >=
AUTO_MIN_START_MS` else no-time. 7. The GraphQL call and the answer rules (Global Constraints), paging PR files while
`hasNextPage` and time is left (at most 30 pages). 8. `claimAttempt({ via: 'auto', facts })`.

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
then ask for the owner's go"; `no-time` ⇒ "not enough time was left to ask GitHub: try the call again").

- [ ] **Step 1: Write the failing tests** in `test/live-db-guard.test.mjs`. A new `autoScene(t, over)` helper: scratch home,
  `seedRegistry` with `{ ref: REF, name: 'EagleWatch prod', repo: 'acme/widgets', kind: 'live', autoMigrations: true }`, a fake
  `io.gh` that records its args and answers from `ghAnswer(over)` (defaults: `nameWithOwner: 'acme/widgets'`, branch `main`, head H,
  `text: SQL`, one history node `{ oid: C, committedDate: NOW - 3_600_000 as ISO Z }` whose PR 42 is merged into `main` with
  `mergeCommit.oid = C` and `files: [{ path: FILE, changeType: 'ADDED' }]`). No transcript go. Each test asserts the decision, the
  markers and the gh call count:
  - `auto: a merged, identical, recent file applies with no go, once; the markers name the PR and commit` — allow; `name-*` and
    `sql-*` with `via: 'auto'`, `pr: 42`, `commit: C`; a second identical call ⇒ deny /already attempted/ with no second gh call.
    *(the feature works; no double apply)*
  - `auto off (flag absent) and execute_sql with the switch on: the go is needed and GitHub is asked nothing` — data SQL and
    `begin; … rollback;` too. *(default off; scope stays migrations)*
  - `auto: one byte different (trailing newline, BOM, CRLF) needs the go and burns nothing`. *(an edited copy)*
  - `auto: GitHub's answer does not prove the file is on github.com's default branch of this repo` — `file: null`, `repository:
    null` (reason names the repo), `errors` with partial `data`, `nameWithOwner: 'other/widgets'`, `defaultBranchRef: null`, a binary
    blob, a truncated blob ⇒ deny each, no marker, no throw. *(unmerged file; moved repo; partial answer; another repo)*
  - `auto: an old, edited or re-added file needs the go; the date is read strictly` — two history nodes; 7 d + 1 ms; 6 min in the
    future; `committedDate` without a zone or not a date ⇒ deny; exactly 7 d, and an in-window time written with `+08:00` ⇒ allow.
  - `auto: only a file a merged PR ADDED by squash counts` — no associated PR (a direct push), `merged: false`, base `release`,
    `mergeCommit.oid` ≠ the commit (a merge-commit or rebase merge), `changeType: 'RENAMED'`, the path missing from the files ⇒ deny
    each; a PR whose first 100 files lack the path with `hasNextPage` ⇒ a second gh call (args name the PR number and the cursor)
    answering `ADDED` ⇒ allow, answering without it ⇒ deny. *(P1-4: direct add, rename, re-add)*
  - `auto: the GitHub question is pinned to github.com and names the registry repo and the migration path` — args start
    `['api', '--hostname', 'github.com', 'graphql']` and carry `o=acme`, `n=widgets`, `p=${FILE}`, also with `env: { GH_HOST:
    'ghe.example' }` in ctx. *(P1-3: another host's same-named repo)*
  - `auto: a bad name or an after-deploy line needs the go and asks GitHub nothing` — a slash, a space, a leading dot, 201 characters;
    the marker on line 1, on line 3, in upper case. *(paths; the owner's after-deploy pick)*
  - `auto: gh fails (exit 1), times out, overflows or prints non-JSON: deny, never allow`. *(fail closed)*
  - `auto: little time left: no gh call under 1.5 s (deny "try the call again"); the gh timeout never exceeds what is left` —
    `ctx.leftMs: () => 1000` ⇒ 0 calls; `() => 4000` ⇒ `timeoutMs <= 4000`. *(P1-2 unit)*
  - `auto: a go is used first; after it, auto never applies the same migration again` — `scene` with a go + the flag on + an eligible
    answer: first `apply` allow with `via: 'go'` markers and 0 gh calls; second identical `apply` deny. *(P1-1: stale go, one session)*
  - `auto: the same SQL under a second name is refused` — auto `NAME` allow; auto `NAME2` with the same query ⇒ deny /already
    attempted/ (the `sql-*` marker). *(P1-1: two names)*
  - `auto: a consumed go marker from before this change (no name) for this ref and SQL blocks it; an empty or unparsable one, or an
    unreadable folder, refuses naming the file` — write into `live-db-consumed/`. *(legacy goes; P1-6)*
  - `auto: two enabled entries with the same repo: auto is off for both and GitHub is asked nothing`. *(P2: the wrong database)*
  - Two processes (extend the existing two-process test; children build the fake gh inline): two auto claims of the same file, and two
    auto claims of the same SQL under two names ⇒ exactly one allow each. *(P1-1 races)*
  - `through the real hook entry: GitHub that never answers is a deny within the host timeout` — spawn
    `pipeline/hooks/guard-files.mjs` (the `spawnHook` pattern of `test/guard-deny-log.test.mjs:195`) with `HOME` = the scratch home,
    `PIPELINE_GH` = `node <scratch>/slow-gh.mjs` (sleeps 30 s), the flag on, no go: the process ends in under 14 s with a deny whose
    reason says GitHub did not answer in time. *(P1-2 end to end: a killed hook counts as an allow)*
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
- Produces: `pipeline live-db auto-log [--days N]` → `{ ok, entries: [{ at, via, ref, label, name, file, pr, commit, repo, session }],
  unreadable: [<path>] }`: ATTEMPTS (auto and go), one per `name-*` marker, newest first, default 30 days, read-only, runs anywhere
  (not an owner command). The usage line says "attempted, not necessarily applied: the session's effect check says applied".

- [ ] **Step 1: Write the failing test** `auto-log lists attempts newest first within --days and lists an unreadable record` — seed
  three attempt markers (one 40 days old) and one empty one, `run(['auto-log'], ctx)` → two entries + the empty one in `unreadable`;
  `--days 60` → three, newest first; `--days 0` and `--days x` → `UsageError`. *(the owner can read what auto-apply attempted, and
  what blocks it)*
- [ ] **Step 2: Run** `node --test test/live-db-go.test.mjs` → FAIL (unknown subcommand).
- [ ] **Step 3: Implement** the subcommand; update `meta.usage` and `docs/cli.md`.
- [ ] **Step 4: Run** `node --test test/live-db-go.test.mjs test/cli.test.mjs` → PASS.
- [ ] **Step 5: Commit** `feat(live-db): auto-log lists the migration attempts`.

### Task 5: The review skill and the guard docs

**Files:**
- Modify: `skills/review/reference/owner-merge.md` § "Live-database go" (new "Auto-apply after the merge" part; step 7 unchanged in
  meaning: a `\uXXXX` file is applied by the owner)
- Modify: `skills/review/reference/ready-and-handoff.md:44` (the one-line rule names the auto path)
- Modify: `docs/cli.md` § "Live database guard" (the switch, the go-first order, the two checks families, the attempt markers, the
  time budget, the Windows durability note, the residuals from the spec)

- [ ] **Step 1: Write the skill text** from spec section 5, as numbered steps:
  - The merge-request sentence: only when `P db-refs show` has exactly ONE entry with `autoMigrations: true` whose `repo` equals this
    repo case-insensitively, and the PR adds `supabase/migrations/*.sql`. Name the after-deploy files (they wait for the deploy and one
    click). An after-deploy file that sorts before an unmarked one: fix the numbering before the merge request.
  - When: the merge job's `merged: true` (`mergeSha`), or `error: hold-recovery` with `prMerged: true` (`gh pr view N --json
    mergeCommit`). A merge reported under a veto (`merge-queue.mjs:594`'s warning, or the queue sweep's report): apply nothing, tell the
    owner, then the go path on their word.
  - Which files and bytes: `git fetch origin <mergeSha>`, then `git diff --name-status <mergeSha>^ <mergeSha> -- supabase/migrations/`
    `A` lines in filename order (an `R` line: tell the owner, the go path), bytes from `git show <mergeSha>:<file>` (never
    `origin/main`). Acceptance cases written into the text: a default branch not called `main`; a recovered merge; a vetoed merge.
  - Per file: after-deploy ⇒ stop the automatic sequence, wait for the production deployment of `mergeSha` (read `P config`
    `production`: its watch, at most `deploy_timeout_minutes`, waits in the background with `--interval 60`), failure, rollback or
    timeout ⇒ tell the owner and apply nothing; then `P live-db present … --ask` for that file; then the next files. Otherwise: state
    the expected effect (every object; for a policy its roles, command, predicate and the table's RLS state); read-only "is it live?"
    (`P live-db catalog …`, `list_migrations` by name is not proof: the ledger holds `apply_migration` stamps); `apply_migration`; the
    full effect check; "applied" only when every part matches, else stop and tell the owner.
  - A refusal or failure stops that PR's remaining files: 🚨 tell the owner (the code is live without that schema), read-only live
    look, then the go path; rolling the code back and repairing the database are separate owner decisions.
  - Before-code migrations that cannot take the gap: the go before the merge, or their own PR. DO-wrap a top-level DROP in the file.
    A literal `\uXXXX`: the owner applies it. The report names the machine that applied.
- [ ] **Step 2: Run** `node --test test/docs-facts.test.mjs test/cli.test.mjs` → PASS (fix any fact the docs test pins).
- [ ] **Step 3: Commit** `docs(review): apply merged migrations after the merge when auto-apply is on`.

### After the build (not code; carried items)

- Full verify + the review loop per the `review` skill; owner "merge"; `pipeline update` on the Mac (the PC when online).
- Owner, own terminal, on the Mac only: `pipeline db-refs set --ref qhptbmafrosgibooelpp --name "EagleWatch live" --repo
  eaglewatch-ph/eaglewatch`, then `pipeline db-refs auto-migrations on --ref qhptbmafrosgibooelpp`.
- Then Claude rewrites `~/Claude/eaglewatch/AGENTS.md` step 3 and the `eaglewatch-db-changes` skill (container root
  `.claude/skills/`) per spec section 6.
- Live check: the next merged EagleWatch migration is applied with no go, `pipeline live-db auto-log` lists the attempt, and the
  effect check matches the file.
