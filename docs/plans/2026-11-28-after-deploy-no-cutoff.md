# #882 rev 2: after-deploy auto-apply without the registration time cutoff

Status: owner OK 2026-11-28 (s8) → Codex plan review (high) + one Fable pass → owner go → build in #907. Replaces the cutoff part of `2026-11-28-auto-apply-after-deploy.md`.

## In plain English
The switch-on for "apply after the deploy" stops recording a start time. Rounds 2–5 of #907 found ever new ways a frozen or
wrong clock could move that time, and each fix added more machinery. The deploy proof that remains is strict on its own: a
marked migration applies only while its own merge is the live, successful production deploy. The one behaviour change: if, at
the moment the owner switches on, the newest production deploy is a merge that added a marked migration (which the owner
merged), that migration applies after the switch-on instead of waiting for a click.

## Why the cutoff can go
What still has to hold for a marked file (all unchanged from #907 HEAD 39e28449, verified in rounds 1–5):
- added by exactly one commit on the default branch, by one merged PR into that branch, within 7 days, after `autoSince`;
- the environment's `latestCompletedDeployment` AND its newest-created deployment are that PR's merge commit, ACTIVE, SUCCESS,
  original/latest environment = the registered one, creator = the registered Bot;
- default-branch name and head unchanged across the reads; registry re-read under the registry lock right before the claim.
So at most ONE merge (the one that is live now) can ever qualify, and only a PR the owner merged (migrations are a hard stop).
The cutoff only protected "a marked file merged before switch-on keeps its click" for that single live merge.

## Changes (net removal)
1. `pipeline/commands/db-refs.mjs`: `after-deploy on` writes `deployEnv` + `deployBot` only, offline again (no `gh` call); drop
   `githubNow`, the two-phase write, `deployPending`, `deployProof`, `deployClock`, `deploySince` and their errors. The
   registration note states the behaviour change above. `off` clears both keys.
2. `pipeline/hooks/lib/db-refs.mjs`: validator back to `deployEnv`/`deployBot` (both or none, only with auto on); unknown keys
   from intermediate commits of #907 are ignored as before (they were never released; an entry without both keys is simply
   not registered).
3. `pipeline/hooks/lib/live-db-auto.mjs`: drop the `deploySince` comparison and the clock/proof checks; keep everything listed
   above, including the lock and the re-read (now comparing repo, autoSince, deployEnv, deployBot).
4. `docs/cli.md`: rewrite the after-deploy paragraph (no cutoff; the switch-on behaviour change; residuals unchanged).
5. Tests: remove the cutoff/clock/two-phase cases; add ONE case: a marked file whose merge is the live deploy at switch-on
   applies after `after-deploy on` (the named behaviour change).

## Review path
Rework #907 in place (same branch, so its verified proof code stays; the round count continues, or a fresh PR if the owner
prefers a clean round budget). Plan review per the owner's rules: Codex plan review (high: guard/DB) + one Fable pass, then
the owner's go before the build.
