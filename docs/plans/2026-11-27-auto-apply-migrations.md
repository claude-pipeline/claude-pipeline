# Auto-apply merged migrations Implementation Plan

> **For agentic workers:** built through the `review` skill (this repo has `.claude/pipeline.yml`): one implementer per task or one
> for all four, then the pipeline's review rounds. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a migration file merged to the registered repo's default branch is applied to that repo's live Supabase project with no
owner go, when the owner switched auto-apply on for that project.

**Architecture:** an owner-only flag on the db-refs registry entry; a new hook library `live-db-auto.mjs` that checks the call against
the file on GitHub's default branch (one GraphQL call) and takes a durable once-only marker; `evaluateSupabaseMcp` tries it before the
existing go claim for `apply_migration`; a read-only `live-db auto-log`; the review skill applies after the merge.

**Tech Stack:** Node ESM, `node:test`, the pipeline's `gh` runner (`pipeline/lib/proc.mjs`).

**Spec:** `docs/specs/2026-11-27-auto-apply-migrations-design.md` (read it first; this plan does not repeat its reasons).

## Global Constraints

- Default off; only the owner's terminal turns it on (`insideClaudeCode` refusal + the existing agent-line `db-refs` rule).
- `apply_migration` only. `execute_sql`, every other tool and dev projects behave exactly as today.
- Any doubt (GitHub error, timeout, bad shape, marker write failure) = not eligible ⇒ the existing go path. Never an allow.
- Files: `supabase/migrations/<name>.sql` at the repo root; `name` matches `^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$`.
- Bytes: `Buffer.from(query, 'utf8')` equals `Buffer.from(blob.text, 'utf8')` exactly (no trimming, no BOM or newline normalising).
- Age: exactly one commit on the default branch touched the path, `committedDate` within 7 days (`7 * 24 * 3600 * 1000` ms) of
  `now()`, not later than `now() + FUTURE_SKEW_MS` (owner-go.mjs).
- GitHub call timeout 8000 ms (the guard hook's whole budget is `HOOK_TIMEOUT_S` = 15 s).
- Markers: `~/.claude/pipeline-state/owner-go/live-db-auto/<id>.json`, id = first 32 hex of sha256(`${ref}|${name}`), exclusive
  create + fsync file + fsync folder before the allow; inside the protected `owner-go` tree.
- `docs/cli.md` must contain each changed command's `meta.usage` verbatim (`test/cli.test.mjs`).
- Tests follow owner rule 6: each test names the failure it catches; extend the existing test files.

## Review Focus

1. GitHub answers with `errors` and `data: null`, or `repository: null` (the registry's `repo` was renamed or moved, as DRMed's was):
   expected not eligible with a reason naming the repo, never a throw out of the hook. Test in Task 2.
2. A file too big for GraphQL (`isTruncated: true`) or binary (`isBinary: true`, `text: null`): expected not eligible. Test in Task 2.
3. A registry written by an older install (no `autoMigrations` key), and an older install reading a newer file (the PC lags a
   `pipeline update`): expected off on both, never invalid. Test in Task 1 (new reads old); old reads new holds by construction (the
   base `validEntry` checks only its named fields and `readDbRefs` drops the rest): say so in the PR body.
4. A `name` with `/`, `..`-only, spaces or a leading dot: expected not eligible before any GitHub call. Test in Task 2.
5. Two sessions (two processes) auto-applying the same file at once: expected exactly one allow. Test in Task 2.

---

### Task 1: The owner's switch

**Files:**
- Modify: `pipeline/hooks/lib/db-refs.mjs` (`validEntry`, `readDbRefs`, new export)
- Modify: `pipeline/commands/db-refs.mjs` (new subcommand, `set` keeps the flag, `meta.usage`)
- Modify: `docs/cli.md` § `db-refs` (paste the new `meta.usage`)
- Test: `test/db-refs.test.mjs`

**Interfaces:**
- Produces: `readDbRefs(home)` entries are `{ ref, name, repo, kind, autoMigrations }` with `autoMigrations` always a boolean (false
  when absent). `writeDbRefs` writes the key only when true. `autoEntry(ref, state) -> entry | null` (the entry when it is live, has a
  repo and `autoMigrations === true`).
- Produces: `pipeline db-refs auto-migrations on|off --ref <ref>` → `{ ok, file, refs, servers }` like `set`.

- [ ] **Step 1: Write the failing tests** in `test/db-refs.test.mjs` (owner runs through `runOwnerCli`, reads through `seedRegistry`):
  - `auto-migrations on|off: the owner turns it on and off for a live ref with a repo; show prints it` — after `on`, `readDbRefs(home).refs[0].autoMigrations === true`; after `off`, `false` and the file has no `autoMigrations` key.
  - `auto-migrations refuses inside Claude Code, and for an unknown ref, a dev ref and an entry without repo; nothing is written` — `run(['auto-migrations','on','--ref',REF], ownerCtx(home, { env: { CLAUDECODE: '1' } }))` → exit 2 `refused`; the three bad refs → exit 2 usage error; file bytes unchanged.
  - `set keeps auto-migrations; set --dev drops it` — `on`, then `set` same ref with a new name → still true; `set --dev` → false.
  - `readDbRefs: autoMigrations absent reads false; a non-boolean, or true on a dev entry or one without repo, is invalid` — `{ ok:false, reason:'invalid' }` for `"yes"`, for `{kind:'dev', autoMigrations:true}`, for `{repo:null, autoMigrations:true}`.
  - In the existing `guard: an agent line running pipeline db-refs set|remove|server is refused` test add `node ~/.claude/pipeline/bin/pipeline.mjs db-refs auto-migrations on --ref ${REF}` to the refused lines.
- [ ] **Step 2: Run them** `node --test test/db-refs.test.mjs` → the new tests FAIL (unknown subcommand, key not returned).
- [ ] **Step 3: Implement.** `validEntry`: `autoMigrations` absent or boolean; true requires `kind === 'live'` and a non-null `repo`.
  `readDbRefs` maps it to a boolean. `writeDbRefs` writes `autoMigrations: true` only on entries where it is true. New subcommand in
  `commands/db-refs.mjs` (positionals `auto-migrations on|off`, only `--ref`), refused inside Claude Code by the same `inside` check
  as `set`; `set` copies the flag from the entry it replaces unless `--dev`. Update `meta.usage` and paste it into `docs/cli.md`.
- [ ] **Step 4: Run** `node --test test/db-refs.test.mjs test/cli.test.mjs` → PASS.
- [ ] **Step 5: Commit** `feat(db-refs): owner-only auto-migrations switch per live project`.

### Task 2: The guard's auto path

**Files:**
- Create: `pipeline/hooks/lib/live-db-auto.mjs`
- Modify: `pipeline/hooks/lib/live-db-go.mjs` (export `sqlCharProblem`; `migrationSqlProblem` calls it)
- Modify: `pipeline/hooks/lib/live-db-guard.mjs` (`takeMarker` uses the shared writer and records `name`; `evaluateSupabaseMcp`)
- Modify: `pipeline/hooks/lib/files-policy.mjs` (`OWNER_GO_LIBS` gains `live-db-auto`: it writes into the owner-go tree)
- Test: `test/live-db-guard.test.mjs`

**Interfaces:**
- Consumes: `autoEntry(ref, state)` (Task 1); `gh(args, opts) -> { code, stdout, stderr, timedOut }` from `pipeline/lib/proc.mjs`;
  `FUTURE_SKEW_MS`, `realDirChain` from `owner-go.mjs`; `sha256Of` from `live-db-go.mjs`.
- Produces (all in `live-db-auto.mjs`):
  - `AUTO_REL = '.claude/pipeline-state/owner-go/live-db-auto'`, `AUTO_MAX_AGE_MS`, `AUTO_GH_TIMEOUT_MS = 8000`, `STEM_RE`.
  - `durableCreate({ home, rel, id, body, io }) -> 'claimed' | 'spent' | 'error'`: the open(O_EXCL|O_NOFOLLOW)/write/fsync/close/fsync-folder
    sequence `takeMarker` has today, moved here unchanged (same `io` seam names, so the existing fault tests keep passing).
  - `githubMigration({ repo, file, io }) -> { ok:true, branch, head, text, isBinary, isTruncated, commits:[{ oid, date, pr }] } | { ok:false, reason }`.
    One `gh api graphql` call (query below), `timeoutMs: AUTO_GH_TIMEOUT_MS`, through `io.gh ?? gh`.
  - `checkAutoApply({ home, entry, name, query, now, io }) -> { eligible:true, facts } | { eligible:false, spent:boolean, reason }`. No writes.
  - `takeAutoMarker({ home, ref, name, facts, via:'auto'|'go', session, now, io }) -> 'claimed' | 'spent' | 'error'`. For `via:'go'`
    `facts` is `{ ref, label, name, file, sqlSha256 }` (no GitHub facts: the owner's go is the approval).
  - `readAutoLog({ home, sinceMs }) -> entry[]` (newest first; unreadable files skipped) — used by Task 3.

GraphQL (verified 2026-11-27 against eaglewatch-ph/eaglewatch, byte-identical to git):
```graphql
query($o:String!,$n:String!,$p:String!){ repository(owner:$o,name:$n){ defaultBranchRef { name target { ... on Commit { oid
  file(path:$p){ object { ... on Blob { text isBinary isTruncated } } }
  history(path:$p, first:2){ nodes { oid committedDate associatedPullRequests(first:1){ nodes { number } } } } } } } } }
```

`checkAutoApply` order (stop at the first failure; `reason` is one plain sentence):
1. `STEM_RE.test(name)`. 2. `sqlCharProblem(query) === null`. 3. no marker file `<AUTO_REL>/<id>.json`; no auto marker and no
`live-db-consumed/*.json` with this `projectRef`/`ref` and (`sqlSha256` = sha256(query) or `name` = name) ⇒ else `spent: true`.
4. `githubMigration` ok, the file exists, `!isBinary && !isTruncated`, bytes equal. 5. `commits.length === 1`, age rule (Global
Constraints). `facts` = `{ ref, label, name, file, sqlSha256, repo, branch, head, commit, commitDate, pr }`.

`evaluateSupabaseMcp` change (inside the existing `execute_sql || apply_migration` branch, after the `migName` check):
- op `migration` and `autoEntry(target.ref, state)`: `checkAutoApply`; eligible ⇒ `takeAutoMarker(via 'auto')`; `claimed` ⇒ `allow()`.
  Otherwise keep the reason (`spent` ⇒ "auto-apply was already attempted for <name> on this machine at <time>: check the live state
  read-only, then ask for the owner's go"; `error` ⇒ "the auto-apply record could not be written").
- Then the existing `claimLiveDbGo`. `claimed` and op `migration` ⇒ `takeAutoMarker(via 'go')` best effort (result ignored), then `allow()`.
- A deny that had an auto reason adds ` Auto-apply did not apply: <reason>.` before the existing go guidance.

- [ ] **Step 1: Write the failing tests** in `test/live-db-guard.test.mjs`. A new `autoScene(t, over)` helper: scratch home,
  `seedRegistry` with `{ ref: REF, name: 'EagleWatch prod', repo: 'acme/widgets', kind: 'live', autoMigrations: true }`, a fake
  `io.gh` that records its args and answers the GraphQL JSON for `FILE` with `text: SQL`, one commit dated `NOW - 3600_000`, PR 42.
  No transcript and no go (auto must not need one). Tests (each asserts the decision, the marker file and the gh call count):
  - `auto: a merged, identical, recent file applies with no go, once; the marker names the PR and commit` — first `apply` allow, marker has `pr: 42`, `via: 'auto'`; second identical `apply` deny with /already attempted/.
  - `auto off (flag absent): the same call needs the go and asks GitHub nothing` — deny /needs the owner's go/, `gh` calls 0.
  - `auto: one byte different (trailing newline, BOM, CRLF): needs the go and burns nothing` — deny /Auto-apply did not apply/, no marker.
  - `auto: a file not on the default branch (file: null), a repo GitHub does not show (repository: null), an errors answer: needs the go` — three denies, no marker, no throw.
  - `auto: a binary or truncated blob needs the go`.
  - `auto: two commits touched the file, or the one commit is 7 days + 1 ms old, or 6 min in the future: needs the go`; exactly 7 days allows.
  - `auto: a name with a slash, a space, a leading dot or 201 characters needs the go and asks GitHub nothing`.
  - `auto: gh fails (exit 1), times out (timedOut) or prints non-JSON: deny, never allow`.
  - `auto: the GitHub question names the registry repo and the migration path` — `gh` args hold `o=acme`, `n=widgets`, `p=supabase/migrations/${NAME}.sql`.
  - `auto: a consumed go marker for this ref and sha (or this name) blocks it` — write one into `live-db-consumed`, deny /already attempted/.
  - `auto: a go-claimed apply takes the auto marker, so a later auto attempt is refused` — use `scene` + flag on; go apply allow; marker `via: 'go'`; a second call deny.
  - `auto: execute_sql with the switch on still needs the go` (data SQL and a `begin; … rollback;` text).
  - `auto: two processes auto-applying the same file on one home: exactly one allow` — extend the existing two-process test pattern.
  - `auto: a marker write failure denies` — `io.openSync` throws EIO for the auto folder.
- [ ] **Step 2: Run** `node --test test/live-db-guard.test.mjs` → the new tests FAIL; the existing ones PASS.
- [ ] **Step 3: Implement** `live-db-auto.mjs` per the Interfaces block; move the marker writer into `durableCreate` and make
  `takeMarker` call it (body gains `name`); export `sqlCharProblem` from `live-db-go.mjs` (empty, U+FFFD, CR/NUL, `HIDING_CHARS`)
  and have `migrationSqlProblem` call it first; wire `evaluateSupabaseMcp`; add `live-db-auto` to `OWNER_GO_LIBS`. `githubMigration`
  parses with try/catch and turns every unexpected shape into `{ ok:false }`.
- [ ] **Step 4: Run** `node --test test/live-db-guard.test.mjs test/live-db-go.test.mjs test/live-db-click.test.mjs test/db-refs.test.mjs` → PASS.
- [ ] **Step 5: Commit** `feat(live-db): auto-apply a merged migration with no go when the owner switched it on`.

### Task 3: `pipeline live-db auto-log`

**Files:**
- Modify: `pipeline/commands/live-db.mjs` (subcommand, `meta.usage`)
- Modify: `docs/cli.md` § `live-db` (paste `meta.usage`)
- Test: `test/live-db-go.test.mjs`

**Interfaces:**
- Consumes: `readAutoLog({ home, sinceMs })` (Task 2).
- Produces: `pipeline live-db auto-log [--days N]` → `{ ok, entries:[{ at, via, ref, label, name, pr, commit, repo, session }] }`,
  newest first, default 30 days, read-only, runs anywhere (it is not an owner command).

- [ ] **Step 1: Write the failing test** `auto-log lists what ran, newest first, within --days, and skips a broken marker` — seed three
  marker files (one 40 days old, one unparsable), `run(['auto-log'], ctx)` → one entry; `--days 60` → two, newest first.
- [ ] **Step 2: Run** `node --test test/live-db-go.test.mjs` → FAIL (unknown subcommand).
- [ ] **Step 3: Implement** the subcommand (`--days` a positive integer, else a usage error); update `meta.usage` and `docs/cli.md`.
- [ ] **Step 4: Run** `node --test test/live-db-go.test.mjs test/cli.test.mjs` → PASS.
- [ ] **Step 5: Commit** `feat(live-db): auto-log lists the auto-applied migrations`.

### Task 4: The review skill and the guard docs

**Files:**
- Modify: `skills/review/reference/owner-merge.md` § "Live-database go" (new "Auto-apply after the merge" part)
- Modify: `skills/review/reference/ready-and-handoff.md:44` (the one-line rule names the auto path)
- Modify: `docs/cli.md` § "Live database guard" (one paragraph: the switch, the checks, the marker, the residuals from the spec)

- [ ] **Step 1: Write the skill text** from spec section 4, as numbered steps: the merge-request sentence (when `P db-refs show` has
  `autoMigrations: true` on the entry whose `repo` is this repo and the PR adds `supabase/migrations/*.sql`); after `merged: true`,
  per added file in filename order: the `-- pipeline: apply-after-deploy` first-line wait (read `pipeline/lib/config.mjs` for the
  `production` keys: with `watch: workflow` wait on that workflow's run for the merge commit with
  `gh run watch <id> --interval 60 --exit-status` in the background, else the GitHub deployment status of the merge sha for
  `production.environment`); the read-only "is it live?" check; `apply_migration` with name = stem and query = `git show origin/main:<file>`
  after `git fetch origin <default_branch>`; the read-only effect check; the report; on a refusal or failure stop that PR's remaining
  files, 🚨 the owner, read-only live look, then the go path. Plus: before-code migrations that cannot take the gap use the go before
  the merge or their own PR; DO-wrap a top-level DROP in the file itself; `\uXXXX` still takes the go.
- [ ] **Step 2: Run** `node --test test/docs-facts.test.mjs test/cli.test.mjs` → PASS (fix any fact the docs test pins).
- [ ] **Step 3: Commit** `docs(review): apply merged migrations after the merge when auto-apply is on`.

### After the build (not code; carried items)

- Full verify + the review loop per the `review` skill; owner "merge"; `pipeline update` on the Mac (the PC when online).
- Owner, own terminal: `pipeline db-refs set --ref qhptbmafrosgibooelpp --name "EagleWatch live" --repo eaglewatch-ph/eaglewatch`,
  then `pipeline db-refs auto-migrations on --ref qhptbmafrosgibooelpp`.
- Then Claude rewrites `~/Claude/eaglewatch/AGENTS.md` step 3 and the `eaglewatch-db-changes` skill (container root
  `.claude/skills/`) per spec section 5.
- Live check: the next merged EagleWatch migration is applied with no go and `pipeline live-db auto-log` lists it.
