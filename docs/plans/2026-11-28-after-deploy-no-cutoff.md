# #882 rev 2.1: after-deploy auto-apply without the registration time cutoff

Status: owner OK on rev 2 (2026-11-28, s8). Rev 2.1 = Codex plan review (high) fixes, see "Review log". Next: one Fable pass →
owner go (incl. decision D1) → build in #907. Replaces the cutoff part of `2026-11-28-auto-apply-after-deploy.md`.

## In plain English
The switch-on for "apply after the deploy" stops recording a start time. Rounds 2–5 of #907 found ever new ways a frozen or
wrong clock could move that time, and each fix added more machinery. What decides now is the state when Claude asks to apply:
a marked migration applies only while its own merge is the newest commit of the main branch AND the live, successful
production deploy. **Decision D1 (owner):** eligibility is checked at apply time, not frozen at switch-on. So a marked migration
whose merge is live when the owner switches on, or whose merge was still deploying then and goes live later, applies without a
click. Everything else keeps the click.

## What has to hold for a marked file (all checks at apply time)
Unchanged from #907 HEAD 39e28449 (verified in rounds 1–5):
- added by exactly one commit on the default branch, by one merged PR into that branch, ≤ 7 days old, never attempted before
  on this machine (attempt history: a file is tried once, ever);
- the environment's `latestCompletedDeployment` AND its newest-created deployment are that PR's merge commit, ACTIVE, SUCCESS,
  original/latest environment = the registered one, deployment and status creator = the registered Bot, zoned status times;
- default-branch name and head unchanged across the reads; registry re-read under the registry lock right before the claim.
New in rev 2.1 (replace what the cutoff did, no clock involved):
- **N1 head = merge commit:** the default branch's head (already read and pinned) must BE the PR's merge commit. A redeploy or
  rollback to an older merge is never the head, so it can never qualify; a later merge on top takes the click (fail closed).
  So at any time at most one merge can qualify, and only while it is both the newest commit and the live deploy.
- **N2 merge time:** the PR's zoned `mergedAt` must be ≥ `autoSince` (besides the commit-date check the base auto-apply keeps), so a
  merge from before auto-apply was switched on keeps its click even if its commit carries a later date.
- **N3 leftovers from unreleased #907 commits:** an entry carrying any cutoff-era key (`deploySince`, `deployClock`,
  `deployProof`, `deployPending`) counts as NOT registered for after-deploy: marked files keep the click until the owner runs
  `after-deploy on` again (which rewrites the entry without them); `off` clears them too. The validator keeps accepting those
  keys so the registry stays valid. A half pair (`deployEnv` without `deployBot` or the reverse) stays invalid (every Supabase
  write refused, as today). The live Mac registry was checked 11-28: it holds no deploy keys at all.

## Changes (net removal)
1. `pipeline/commands/db-refs.mjs`: `after-deploy on` writes `deployEnv` + `deployBot` only and removes any cutoff-era key,
   offline again (no `gh` call); drop `githubNow`, the two-phase write, `GITHUB_TIME_*`, and their errors. `off` clears all
   deploy keys. Rewrite `DEPLOY_NOTE` and the `meta.usage` lines (no "from NOW ON", no cut-off restart; D1 and N1 in one line).
2. `pipeline/hooks/lib/db-refs.mjs`: validator: pair both-or-none (with auto on); cutoff-era keys still accepted (any shape
   that 39e28449 accepted), `readDbRefs` reports `deployLegacy: true` for such an entry.
3. `pipeline/hooks/lib/live-db-auto.mjs`: drop the `deploySince` comparison and the clock/proof checks; `deployLegacy` → not
   registered; add N1 and N2; the locked re-read compares repo, autoSince, deployEnv, deployBot, deployLegacy (current values: an
   `off` then `on` with the same env + bot during the GitHub reads lets that call proceed: same registration, accepted).
4. `docs/cli.md`: the `db-refs` usage copy (verbatim-help test) and the "Live database guard" after-deploy paragraph: no cutoff,
   D1, N1, N2, N3; residuals unchanged.
5. Tests (extend `test/live-db-guard.test.mjs` / `test/db-refs*.test.mjs`; remove the cutoff/clock/two-phase cases):
   - D1: marked file whose merge is the live deploy right after `after-deploy on` applies (the named behaviour change);
   - N1: deploy proof passes but the head is a later commit → not eligible (catches a rollback/redeploy auto-applying);
   - N2: `mergedAt` before `autoSince` with a commit date after it → not eligible;
   - N3: the existing legacy fixtures (pending + cutoff-era keys) → claims nothing; `after-deploy on` afterwards → registered;
   - `after-deploy on` makes zero GitHub calls (the stub fails the test if called).
   The existing pending-then-success test stays (it is the "deploying at switch-on, live later" case of D1).

## Rollback
Released installs before #907 do not know the deploy keys and ignore them (base `validEntry` comment). 39e28449 was never
released or installed, so no rollback lands on it; nothing to do beyond the existing "run `auto-migrations on` again after any
rollback of the pipeline install".

## Review path
Rework #907 in place (same branch; its verified proof code stays). Plan: Codex (high) done → rev 2.1; one Fable pass → owner go
→ build → the pipeline's review rounds.

## Review log
- Codex plan review 11-28 (session 01a21ee3, high): P1 pre-switch merge can qualify later → D1 made explicit + N1; P1 legacy
  half-registration could activate → N3 (live registry has no deploy keys: no exposure); P2 autoSince measures commit time → N2;
  P2 rollback to 39e28449 → never released (Rollback); P2 both help copies → change 1 + 4; P3 re-read semantics → change 3.
