# Auto-apply "after deploy" migrations once GitHub shows the production deploy succeeded (#882) + #894 + #896

Owner 2026-11-28: all three optional items in ONE PR, the cp freeze overridden for it. Risk: high (`pipeline/hooks/**`, live-database guard).

## Goal

Today (PR #883) the guard auto-applies a migration file a merged PR added, with no owner go, when the owner switched auto-apply on for
that project; a file marked `-- pipeline: apply-after-deploy` is refused (`live-db-auto.mjs:360`) and keeps the owner's click after the
deploy. #882: when the owner ALSO registered which GitHub deployment means "production" for that project, the guard auto-applies a
marked file too, once GitHub shows that the newest deployment in that environment is the file's merge commit, succeeded, and was made
by the GitHub App the owner named. Everything else (no registration, any doubt) keeps today's behaviour: the click.

#894: make the hook-entry "hung git" click test reach the route it names. #896: fix one false comment on the go-vs-auto race.

## Design (#882)

### Registry (owner only, own terminal)

- Three new optional keys on an entry: `deploySince` (strict ISO time with a zone: when the owner registered this env + bot), `deployEnv` (GitHub deployment environment name, `^[A-Za-z0-9][A-Za-z0-9 _.-]{0,99}$`) and
  `deployBot` (a GitHub App's bot login without the `[bot]` suffix, `^[a-z0-9][a-z0-9-]{0,38}$`, compared lower-case). All three or none;
  valid only on an entry with `autoMigrations: true`, and `deployBot` must not be `github-actions` (`validEntry` in
  `pipeline/hooks/lib/db-refs.mjs` refuses it, so a hand-written or restored registry with it is INVALID, denying every write, as any
  invalid registry does; R1 P2). `readDbRefs` returns
  `deployEnv` / `deployBot` / `deploySince` (null when absent); `writeDbRefs` writes them only when all are set and auto is on.
- An older install reading a newer file ignores the keys (it refuses every marked file, as today); an older install's write drops them
  (the feature is then off: fail closed).
- New subcommand `pipeline db-refs after-deploy on --ref <ref> --env "<environment>" --bot <app>` and `after-deploy off --ref <ref>`,
  under the same lock, `insideClaudeCode` refusal and snapshot re-read as `auto-migrations`. `on` refuses: an unknown ref, an entry
  with auto-apply off ("switch auto-migrations on first"), a malformed env or bot, and the bot `github-actions` (an agent can make a
  workflow run create a deployment for any sha: the bot must be an App the agent cannot drive, e.g. Vercel's `vercel`). A trailing
  `[bot]` in `--bot` is stripped. `on` sets `deploySince` = now, also when it replaces an earlier env or bot (prospective, R1 P2:
  a marked file merged before the registration was promised a click and keeps it). It prints a trust note: "a marked migration merged from now on is applied once the newest `<env>` deployment of
  `<repo>` (by ANY creator) and GitHub's latest completed one are both the merge commit, made by `<bot>[bot]`, succeeded; a rollback done outside GitHub (the host's dashboard) is not seen".
- `auto-migrations off` and a `set` that clears the auto switch (repo change, `--dev`) also clear all three keys (`deployEnv`, `deployBot`, `deploySince`); a label-only `set` keeps them. `show` lists them.

### Guard (`pipeline/hooks/lib/live-db-auto.mjs`)

- Line 360: a marked file with `entry.deployEnv` null ⇒ not eligible as today (the reason adds: the owner can register the deploy with
  `pipeline db-refs after-deploy on`). With `deployEnv` set ⇒ the check runs as for an unmarked file, plus the deploy proof.
- The deploy proof is ONE extra GraphQL call, made only for a marked file, as the LAST GitHub read right before `claimNext` (after the
  PR-file pages, so a rollback GitHub shows while the pages are read is seen; R1 P1), through the existing `ask` (same timeout and
  minimum-time rules: too little time left ⇒ `no-time`, nothing claimed). `GRAPHQL_DEPLOY`, variables `$o $n $env $num`:
  `repository(owner,name){ nameWithOwner
     environment(name:$env){ name latestCompletedDeployment { ...D } }
     deployments(environments:[$env], first:1, orderBy:{field:CREATED_AT, direction:DESC}) { nodes { ...D } }
     pullRequest(number:$num){ number merged mergedAt mergeCommit { oid } } }`
  with `D` = `commitOid createdAt environment state creator { __typename login } latestStatus { state createdAt creator { __typename
  login } }`. The unmarked path keeps the exact query and arguments it sends today.
- Why two deployment reads (R2 P1): `environment.latestCompletedDeployment` is GitHub's own "what is live" signal (the latest deployment
  in that environment whose status completed: success, failure or error), so a rollback GitHub records on ANY older deployment, however
  old, makes that deployment the latest completed one and the proof fails; checked on EagleWatch 2026-11-28 (it returns the current
  Production deploy, Bot `vercel`, SUCCESS). `deployments(first:1)` (newest by creation, any creator) must be the same commit, so a newer
  deploy that is still building, or one made by any other creator, also needs the go.
- After every existing check has passed (bytes, one adding commit, merged PR that ADDED it, 7 days, `autoSince`), the marked file needs
  ALL of: `nameWithOwner` equals `entry.repo`; `environment` present with `name === entry.deployEnv`; the PR of the answer is the matched
  PR (same number, `merged: true`, `mergeCommit.oid === commit.oid`) and its `mergedAt` (strict ISO with zone) is not before
  `entry.deploySince` (the prospective cutoff is the MERGE time, not the commit date; R2 P2); for BOTH `L` = latestCompletedDeployment and
  `N0` = the one node: an object, `environment === entry.deployEnv`, `commitOid === commit.oid`, `state === 'ACTIVE'`,
  `creator.__typename === 'Bot'` and `creator.login` (lower-case) `=== entry.deployBot`, `latestStatus.state === 'SUCCESS'` with the same
  Bot as creator, `latestStatus.createdAt` a strict ISO time with a zone, not before the commit's date and not after now +
  `FUTURE_SKEW_MS`. Anything else ⇒ `not-eligible` with one plain sentence naming what GitHub showed (no deployment yet / live is
  `<sha12>` / newest is `<sha12>` / state / creator), and "wait for the deploy, then call again, or the owner's go".
- Not eligible claims nothing, so a call made before the deploy finished can be made again after it (no generation is spent).
- `facts` gain `afterDeploy: true`, `deployEnv`, `deployedAt` (the status time); `readAttemptLog` rows carry `afterDeploy` and
  `deployEnv` (null for others), so `pipeline live-db auto-log` shows which applies waited for a deploy.

Cases settled (the issue's list): no deployment yet ⇒ go (or call again later); success for another sha (older or newer, including a
newer one that contains the commit) ⇒ go; success for the merge sha by the named Bot ⇒ auto; failure / error / in progress / inactive
⇒ go; deploy skipped for that sha (ignored build step) ⇒ no deployment ⇒ go; a GitHub timeout ⇒ the existing "did not answer in
time" not-eligible. Residuals (documented, in the trust note and docs/cli.md): a rollback or promote done in the host's dashboard
makes no GitHub deployment or status, so the guard cannot see it (Vercel's instant rollback is such a case; Vercel leaves older
Production deployments ACTIVE, observed 2026-11-28); the window
is between the guard's last read and the apply, which the skill runs straight after the deploy watch.

### Skill and docs

- `skills/review/reference/owner-merge.md` step 1: a marked file "waits for the deploy" (and one click only when `P db-refs show` has
  no `deployEnv` for that entry). Step 5: marked file and the entry has `deployEnv` ⇒ after the deploy watch succeeds and the byte
  check, call `apply_migration` directly; a deny naming the deploy ⇒ the `present --ask` dialog path as today; without `deployEnv` ⇒
  today's dialog path unchanged.
- `docs/cli.md` "Live database guard": the after-deploy registration, the proof, the cases and the residual. `db-refs` usage text.

## Tests (each names the failure it catches; extend existing files)

`test/db-refs.test.mjs`:
1. registry: `deployEnv` without `deployBot` (or with auto off) is invalid — catches a half registration letting a marked file through
   without a creator check.
2. CLI `after-deploy on`: refused inside Claude Code; refused with auto off; refused for `github-actions` (and `github-actions[bot]`);
   `[bot]` stripped; `off`, `auto-migrations off`, a repo-changing `set` and `--dev` clear all three keys (asserted absent in the file on disk), a label-only `set` keeps them — catches
   the trust surviving a change of repo or being set by an agent.

`test/live-db-guard.test.mjs` (the auto section's gh stub):
3. marked file, entry without `deployEnv` ⇒ deny, GitHub not asked (existing test stays, still passes).
4. marked file with `deployEnv`: newest deployment is the merge commit, ACTIVE, SUCCESS, Bot `vercel` ⇒ allow, generations claimed,
   facts carry `afterDeploy` — catches the feature not working.
5. each refusal, nothing claimed: no node; no environment; latestCompleted another sha (an older deployment re-completed after the
   merge sha's: a rollback GitHub saw, on a deployment of any age); newest-created another sha, or by an untrusted creator, ahead of a
   trusted latestCompleted; state not ACTIVE; status FAILURE / IN_PROGRESS / INACTIVE; creator a `User` named `vercel`; status
   creator another bot; env mismatch; status time before the commit, without a zone, or past the future skew; `mergedAt` before
   `deploySince` while the commit date is after it (and the reverse ordering allowed); a raw registry with `deployBot:
   "github-actions"` is invalid — catches a forged, stale or rolled-back deploy counting as live, and a registration reaching back to
   earlier merges.
5b. pages then deploy: a PR whose file list needs a second page; the deploy query is the last call (stub call order) — catches the
   proof being read before the pages.
6. denied before the deploy, then the same call after the stub shows success ⇒ allow — catches an early call spending the attempt.
7. unmarked file sends the same GraphQL query as before (no `deployments`, no extra call); the marked call's deploy query carries
   `env=<deployEnv>`, `num=<pr>`, `latestCompletedDeployment`, `first:1`, `direction:DESC` and the creator/status fields (pinned in the stub) — catches the unmarked path
   changing and a stub that answers success whatever was asked.
8. legacy: a registry without the new keys reads as before; an attempt-log row without `afterDeploy` reads with null — catches a
   compat break.

## #894 (`test/live-db-click.test.mjs:287`)

The spawned hook uses the real clock while `world()` dates the click from the 2026-11-16 fixture. Diagnosis corrected (R1 P2):
`settleOne` calls `readAsk` (`owner-go-click.mjs:873`, which rebuilds the block with git) BEFORE the expiry check (:875), so with a
hung git the deny may come from the git route, from expiry, or from the slow-gh fallback; the test cannot tell which. Fix: a `world()`
option that shifts every fixture timestamp (and `issuedAt`) so the answer lands seconds before `Date.now()` (expiry ruled out); a
CONTROL run through the same real hook entry, own fresh world, with a responsive git (shim that touches a marker then execs the real
git) must SETTLE and ALLOW (as the flush test at `live-db-click.test.mjs:142` does), proving the fresh fixture reaches the settling
route; the hung case (own fresh world) uses a shim that logs its argv to a marker file before it sleeps: the test asserts the logged
call is the block-verification git read (its argv), the deny comes within 14 s, nothing is consumed, and the settling outcome on disk
is not `evidence-expired` (an `ask-invalid` from the 5 s per-git limit or a no-time deny are both the route the test names; R2 P2).
Skipped on win32 like the
adjacent shim test (`live-db-click.test.mjs:262`). Failure caught: the click-settling route running past the 15 s host timeout when
git hangs.

## #896 (`pipeline/hooks/lib/live-db-auto.mjs:408-409`)

Comment-only: in one interleaving the go loses the generation claim too, both deny and the owner gives a new go (fail-safe, matching
`test/live-db-guard.test.mjs:1110`); "that go owns the apply" holds only when the go's claim wins. No behaviour change. Also
rename the test at `test/live-db-guard.test.mjs:970` ("…the go keeps its apply" → "…auto is refused, leaving the apply to the go's
own claim"): it only proves auto denies (R1 P3).

## After the build (carried)

(Codex R1 P1-3 disputed: `rpsofnajoxtapqclvfyp` IS the EagleWatch live ref; `qhptbmafrosgibooelpp` in the 11-27 plan was DRMed's, the
incident closed 11-28 with `db-refs show` verified.) Owner, own terminal, Mac, after `pipeline update`: `pipeline db-refs after-deploy on --ref rpsofnajoxtapqclvfyp --env Production --bot
vercel` (EagleWatch's Production deployments are made by Bot `vercel`, checked 2026-11-28). Then Claude updates the EW container skill
`eaglewatch-db-changes` and `AGENTS.md` step 3 (marked files auto-apply after the deploy).

## Fable plan pass (2026-11-28): no P0/P1; folded in (these override the text above where they differ)

- F-P2-1 `D` also reads `originalEnvironment latestEnvironment`; both must equal `deployEnv` for L and N0 (an agent-posted status
  cannot move a Preview deployment of the merge sha into Production). Test 5 adds: original `Preview`, latest `Production`.
- F-P2-2 `latestCompletedDeployment` semantics are NOT verified for a status posted later on an older deployment. The plan keeps the
  check (it costs nothing and is GitHub's own "live" field) but makes no claim that it catches a GitHub-recorded rollback on an older
  deployment: docs/cli.md and the trust note list it as a residual. Test 5's "older re-completed" case asserts only that a
  latestCompleted of another sha denies (stub-level), worded as such.
- F-P2-3 Residual wording: a SUCCESS status means "built and assigned by the host", not "serving now". After a dashboard rollback (or
  with auto-promotion off) later merges may still show Production SUCCESS while old code serves: the trust note, docs/cli.md and
  owner-merge step 5 tell the owner to run `pipeline db-refs after-deploy off --ref <ref>` while production is rolled back or not
  auto-promoted. Also a residual: the owner's token can mark a newer deployment inactive and delete it.
- F-P3 env name: `deployEnv` is any 1-100 characters without control characters (Vercel's `Production – <project>` has an en dash),
  compared exactly (case-sensitive; docs say so). `after-deploy on` prints the registered env and bot in its note.
- F-P3 code fit: `readAttemptLog` row and event lists (`live-db-auto.mjs:551`, `:558`) gain `afterDeploy` / `deployEnv`, and test 4
  asserts them through `readAttemptLog`; `only()` (`commands/db-refs.mjs:42`) gains `env` and `bot` so other subcommands refuse them;
  `nameWithOwner` uses `sameRepo`.
- F-P3 #894: the control keeps the stubbed `PIPELINE_GH` and asserts the consumed marker exists after the allow; the hung case's real
  assertion is the argv marker of the block-verification git read (the "not evidence-expired" check is dropped: it is vacuous there).
