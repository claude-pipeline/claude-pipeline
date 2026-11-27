# #882 rev 2.2: after-deploy auto-apply without the registration time cutoff

Status: owner OK on rev 2 (2026-11-28, s8). Rev 2.1 = Codex plan review (high) fixes; rev 2.2 = Codex recheck (medium) +
Fable plan pass fixes, see "Review log". Next: owner go (incl. decisions D1 + D2) → build in #907. Replaces the cutoff part of
`2026-11-28-auto-apply-after-deploy.md`.

## In plain English
The switch-on for "apply after the deploy" stops recording a start time. Rounds 2–5 of #907 found ever new ways a frozen or
wrong clock could move that time, and each fix added more machinery. What decides now is the state when Claude asks to apply:
a marked migration applies only while its own merge is the newest commit of the main branch AND the live, successful
production deploy.
- **Decision D1 (owner):** eligibility is checked at apply time, not frozen at switch-on. A marked migration whose merge is live
  when the owner switches on, or was still deploying then and goes live later, applies without a click. To keep the click for
  everything already merged, run `auto-migrations on` again right after `after-deploy on` (it resets `autoSince`; N2 then
  covers every earlier merge).
- **Decision D2 (owner):** if any later commit lands on the main branch before Claude's apply call (even a docs-only PR, a
  merge-queue batch, or a merge during the Vercel build), the marked migration takes the click. Fail closed, routine but rare.

## What has to hold for a marked file (all checks at apply time)
Unchanged from #907 HEAD 39e28449 (verified in rounds 1–5):
- added by exactly one commit on the default branch, by one merged PR into that branch, ≤ 7 days old, never attempted before
  on this machine (attempt history: a file is tried once, ever);
- the environment's `latestCompletedDeployment` AND its newest-created deployment are that PR's merge commit, ACTIVE, SUCCESS,
  original/latest environment = the registered one, deployment and status creator = the registered Bot, zoned status times,
  and the success-time credibility check (`live-db-auto.mjs` ~:395) stays;
- default-branch name and head unchanged across the reads; registry re-read under the registry lock right before the claim.
New in rev 2.x (replace what the cutoff did, no clock involved):
- **N1 head = merge commit:** the default branch's head (`branch.target.oid`, already read and pinned) must BE the PR's merge
  commit (`commit.oid`). Checked in `autoCheck` right after the PR is found and BEFORE the deploy query, with its own final
  wording ("a later commit is on the default branch: this file takes the owner's go"), never the "wait and call again" one.
  While a later commit is the head, a redeploy or rollback of an older merge cannot qualify; at any time at most one merge can.
  (Two reads cannot see a branch rewound before the first read; a rewind of main needs a force-push, outside this threat model.)
- **N2 merge time:** the PR's zoned `mergedAt` must be ≥ `autoSince` (besides the commit-date check the base keeps).
- **N3 leftovers from unreleased #907 commits:** an entry carrying any cutoff-era key (`deploySince`, `deployClock` incl. the
  value `'pending'` written by 7ac5c1d3, `deployProof`, `deployPending`) is valid but NOT registered: `readDbRefs` reports it
  with `deployEnv`/`deployBot` = null and `deployLegacy: true` (so `db-refs show` and the merge workflow never see a
  registration), the guard treats it as off, and EVERY write (`set`, `remove`, `server`, `auto-migrations`, `after-deploy off`)
  serializes it with all deploy keys removed. Only `after-deploy on` writes a pair. A half pair stays invalid (as today). The
  live Mac registry was checked 11-28: it holds no deploy keys at all.

## Changes (net removal)
1. `pipeline/commands/db-refs.mjs`: `after-deploy on` writes `deployEnv` + `deployBot` only, offline again (no `gh` call);
   drop `githubNow`, the two-phase write, `GITHUB_TIME_*`, and their errors. `off` clears all deploy keys. Rewrite `DEPLOY_NOTE`
   and the `meta.usage` lines (no "from NOW ON", no cut-off restart; D1 with its `auto-migrations on` lever, D2/N1 in one line).
2. `pipeline/hooks/lib/db-refs.mjs`: `validEntry`: pair both-or-none (with auto on); cutoff-era keys accepted in every shape any
   #907 commit wrote (incl. `deployClock: 'pending'`). `readDbRefs`/`shown`: legacy → pair null + `deployLegacy`. `writeDbRefs`:
   writes the pair whenever both are set (no longer keyed on `deploySince`), never a cutoff-era key.
3. `pipeline/hooks/lib/live-db-auto.mjs`: drop the `deploySince` comparison and the clock/proof checks (keep the status-time
   checks); legacy → not registered; add N1 (in `autoCheck`, before `deployProof`) and N2; the locked re-read compares repo,
   autoSince, deployEnv, deployBot (current values: an `off` then `on` with the same env + bot during the GitHub reads lets
   that call proceed: same registration, accepted).
4. `docs/cli.md`: the `db-refs` usage copy (verbatim-help test) and the "Live database guard" after-deploy paragraph: no cutoff,
   D1 (+ lever), D2/N1 with its costs (merge-queue batches: only the last PR qualifies; a merge during the build; a repo with
   automation committing after each merge never qualifies), N2, N3; residuals unchanged.
5. Tests (extend `test/live-db-guard.test.mjs` / `test/db-refs.test.mjs`; remove the cutoff/clock/two-phase cases):
   - fixtures: marked-file success cases use a clean two-key registration and head = merge commit in BOTH GitHub answers; the
     unmarked baseline keeps head ≠ commit (proves N1 is marked-only);
   - D1: registry before registration → real owner CLI `after-deploy on` on the scratch registry → guard claims the live merge;
   - N1: deploy proof would pass but head is a later commit → not eligible, final wording, no deploy query made;
   - N2: `mergedAt` before `autoSince` with a commit date after it → not eligible;
   - N3: the legacy fixtures (7ac5c1d3 shape with `deployClock:'pending'`, and the `deployPending` shape) → registry valid,
     another ref readable, claims nothing; after a label `set` and a `server add` → still claims nothing; after a fresh
     `after-deploy on` → only that ref registered;
   - `after-deploy on` makes zero GitHub calls (the stub fails the test if called).
   The existing pending-then-success test stays (the "deploying at switch-on, live later" case of D1).

## Rollback
Released installs before #907 do not know the deploy keys, strip them and refuse every marked file. 39e28449 was never
released or installed, so no rollback lands on it; nothing to do beyond the existing "run `auto-migrations on` again after any
rollback of the pipeline install".

## Review path
Rework #907 in place (same branch; its verified proof code stays). Codex (high) + recheck (medium) + one Fable pass done →
owner go → build → the pipeline's review rounds (round rule: still disputed after round 3 → carve out, no more rounds).

## Review log
- Codex plan review 11-28 (session 01a21ee3, high): P1 pre-switch merge can qualify later → D1 + N1; P1 legacy
  half-registration could activate → N3 (live registry has no deploy keys: no exposure); P2 autoSince measures commit time → N2;
  P2 rollback to 39e28449 → never released (Rollback); P2 both help copies → change 1 + 4; P3 re-read semantics → change 3.
- Codex recheck 11-28 (medium): P1 an unrelated write could activate a legacy entry → N3 rewritten (pair hidden on read, deploy
  keys dropped on every write); P2 `deployClock:'pending'` shape would invalidate the registry → accepted as legacy; P2 N1's
  routine cost → D2 for the owner; P2 fixtures → change 5. Others resolved.
- Fable plan pass 11-28: no BLOCKING. SHOULD-FIX `writeDbRefs` keyed on `deploySince` → change 2; SHOULD-FIX N1 refusal said
  "call again" → own wording, before the deploy query; NITs: N1 costs in docs, D1 lever, fixture heads, keep :395 check.
