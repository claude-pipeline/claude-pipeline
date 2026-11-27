# Plan: tell a queued guard re-run from a workflow that never re-runs (#866)

Rev 4 (Codex plan review, medium: 3 P1 + 2 P2 + 1 P3, taken in Rev 2; the one recheck: all six resolved, 2 new P2, taken in Rev 3;
Fable plan pass: 0 P0/P1, 2 P2 + 2 P3, taken here; owner chose the 5-min queued cap 2026-11-27. No further plan review.)

## In plain English
When the owner's "merge" lifts a `needs-human` hold, GitHub re-runs the guard checks. The merge waits up to 120 seconds to see that
re-run start. If no runner picks the run up within those 120 seconds, the old green results look exactly like a repository whose guards
never re-run, and the merge goes ahead on the old results instead of waiting for the new ones. This change asks GitHub whether any guard
run for this head is still queued or running, and does not accept a "settled" verdict while one is (inside the existing merge deadline).

## Problem (from PR #865 R1-B4)
`settleGuardStatuses` (`pipeline/lib/merge-queue.mjs` ~979-1030) first polls `gh.checks(pr)` for up to `graceMs`
(`guardRerunGraceMs`, 120 s capped by `waitMs`) for a guard row that is `pending` or carries a run link not in `before`. If none shows,
`rerun` stays false and the main loop judges the OLD rows (`stale = []`): green ⇒ `[]` ⇒ merge / enqueue.
`pipeline-guards.yml` posts `pending` only from its first step ("Mark pending", template ~106-111), so a run still QUEUED (no runner
yet), or `in_progress` before that step, is invisible in the statuses. Effect today: the pre-#865 race (direct mode: GitHub refuses
"required checks pending" once the re-run posts, the hold goes back and the owner's word is spent; queue mode: the poster may read
`pending` and spend its one re-queue). Not a wrong merge: the old rows are genuine for this head.

## Design
Principle: the runs list only ever EXTENDS the wait; every verdict still comes from a checks sample through the existing pending /
stale / mixed-link / provenance logic, and approval stays with the existing provenance check.

1. **Runs lookup** `guardRunsInFlight({ gh, slug, head })` in `pipeline/lib/merge-queue.mjs`:
   - Reads EVERY page of `repos/<slug>/actions/workflows/pipeline-guards.yml/runs?head_sha=<head>&event=pull_request_target`
     through the existing complete-pagination reader `listAll` of `pipeline/lib/ci-proof.mjs` (export it and its `PER_PAGE` for test 6; no new pagination helper;
     it calls `gh.api('GET', path)`, the signature of `pipeline/lib/github.mjs:131`, and fails closed on a short or changing listing).
   - Keeps runs whose `path` (`@ref` suffix dropped, as `workflowOf` in ci-proof) is `GUARD_WORKFLOW_PATH` (imported from `pipeline/lib/guard-provenance.mjs`; merge-queue does not import it today; no cycle) and whose `status` is not
     `completed` (queued, in_progress, waiting, requested, pending all count).
   - No creation-time cutoff and no `liftedAt` (Codex P2: a skewed local clock or an older still-active run for the same head would
     be missed; any in-flight guards run on this head will re-post the statuses, so waiting for it is right; the deadline bounds it).
   - Bound to the head sha, not the PR (statuses are per head; `pull_requests` is empty for fork runs).
   - Validates each row before classifying it, as ci-proof's `candidateRuns` does (~97-104): `id` a positive integer, `path` and
     `status` non-empty strings. Any malformed row ⇒ `ok: false` (Codex recheck P2: a row without `status` would otherwise count as
     in flight and hold the wait to the deadline).
   - Returns `{ ok: true, runs: [{ id, status }] }`, or `{ ok: false, error }` on any throw (read failure, unexpected shape, the
     `listAll` fail-closed refusals) or malformed row.
2. **settleGuardStatuses** gains an optional `slug` (merge.mjs passes `gh.repo().slug`, the form used throughout merge.mjs). Without
   `slug`, or when not `watching`, behaviour is exactly today's. With it, in the main loop, at BOTH points where today it would
   return a verdict once nothing is pending: the failing-guard refusal (`bad.length > 0`, ~1013) and the settled return (no stale,
   not mixed, before the provenance call) — Codex recheck P2: a red row from another same-head run C must not end the wait while B
   is still in flight:
   - **One rule (Fable P2-1):** a verdict is returned only from a checks sample read AFTER a runs lookup that found nothing in
     flight. So at a verdict point: call `guardRunsInFlight`; if it finds nothing in flight AND the sample being judged was read
     after the previous lookup of this call that found nothing, return the verdict; if it finds nothing but the sample predates that
     lookup, `continue` ONCE to a fresh `gh.checks` sample at once (no sleep) and evaluate it through the whole existing logic (Codex
     P1 / Fable P2-1: B can run and post between the checks read and the runs read, with or without an earlier in-flight report). A
     flag `clearAfter` (the lookup sequence number) makes "once" exact: the fresh sample is read after the clear lookup, so its own
     verdict point re-checks and can return; no unbounded no-sleep loop (the fake clock only moves on sleep).
   - **In flight** (`ok` with ≥ 1 run) ⇒ do NOT return; `why` = `the guards' re-run has not finished: run <id> is <status>` (first
     run, its observed status — Codex P3), sleep `pollMs`, keep polling to the existing `deadline`. Covers the queued-after-grace
     case and both A/B/C variants (C's green or red rows never release a still-in-flight B).
   - **Own run done posting (Fable P3-3):** ignore an in-flight run whose id is the run every settled guard row links to (no row
     pending, none stale, one link, rows not `before`'s): its Publish step was its last status write and its later steps only
     touch pending rows; a manual re-run of it is still refused by provenance (first attempt only). Run id from the link
     (`.../actions/runs/<id>`, a job suffix ignored, as ci-wait reads it).
   - **Queued cap (owner 2026-11-27, Fable P2-2):** a run that has only ever been seen `queued` (never another status) extends the
     wait by at most `QUEUED_EXTENSION_MS` = 5 min from the first lookup that saw it queued (still capped by `deadline`). Past the
     cap, queued-only runs are treated as not in flight and the verdict is today's (old rows, after the fresh-sample rule). A run
     seen `in_progress` (or any non-queued, non-completed status) is waited for to the normal `deadline`. Rationale: on a runner
     backlog today's code merges on the old (genuine) rows after the grace; a full-window wait would refuse, restore the hold and
     spend the owner's word. The env seam may only shorten the cap (as `PIPELINE_GUARD_RERUN_GRACE_MS`).
   - `ok: false` ⇒ return the current rows' verdict as today (the red refusal, or provenance then return), also after an earlier
     successful in-flight observation (no sticky state: Codex note). The arbiter on #865 ruled this the pre-PR behaviour, not a
     wrong merge. The try wraps the WHOLE lookup, so a fake `gh` without `api` (`gh.api is not a function`, existing merge-level
     stubs in the test file ~492) is a lookup failure, not a crash (Fable P3-4).
   - deadline reached ⇒ the existing timeout refusal with that `why`.
   - The grace loop is unchanged (it only decides `rerun`); the gate applies whether or not a re-run was seen.
3. **merge.mjs** (~620-623): pass `slug: gh.repo().slug` to `settleGuardStatuses`. Nothing else in the merge path changes; queue mode
   and direct mode share `settleGuards`.
4. **Time bound:** the bound is the existing polling `deadline` (`waitMs`), checked between reads as today; a `gh` call has its own
   60 s timeout (`github.mjs:17`), as the checks reads already do. No new timer. (Codex note: not a hard wall clock including calls.)
5. **Docs:** the `docs/cli.md` text that describes the hold-lift guard wait (grep `re-run` / `grace` / `F7` near the owner-go
   hold-lift paragraph): add that a settled verdict also needs no `pipeline-guards.yml` run for the head still queued or running
   (all pages read; the run every settled row already links to is ignored); a verdict always comes from a statuses read taken after
   a lookup that found none; a run seen only `queued` extends the wait by at most 5 minutes (runner backlog: then the old
   statuses are judged as before); an unreadable runs list falls back to judging the statuses as before.

## Out of scope
- No change to `pipeline-guards.yml`, `guardRerunGraceMs`, `waitMs`, or the provenance checks.
- No change to the final gate (`finalgate.mjs`); it does not repeat guard settlement, which is why the fresh sample above is needed.

## Tests (rule 6: each names its failure) — extend `test/owner-go-hold-queue.test.mjs` (existing fake `gh` / clock / sleep seams; add
a `gh.api(method, path)` fake that asserts `method === 'GET'` and that the path names `pipeline-guards.yml`, the head sha and
`event=pull_request_target`, with `total_count` pages)
1. **Queued past the grace** (the bug, failing first): `before` = run A; checks show A green through the whole grace AND the first
   verdict read (so today's code returns `[]` on A — Codex note); runs list reports B `queued`, later B completed; checks then show B
   green, one link. Expect `[]` only after B's rows; never on a sample showing only A.
2. **A/B/C:** runs list reports B `queued`; checks show C green (one link, provenance ok) while B is still queued ⇒ keeps waiting;
   B completes and checks show B ⇒ judged on B. Second variant: C's rows are RED while B is queued, then B green ⇒ `[]` on B (no
   refusal on C). Catches a different run (green or red) ending the wait.
3. **Completion race:** sample shows A green; then the runs read reports nothing in flight after an earlier in-flight report, and the
   next checks read shows B red ⇒ refusal names B's failing guard (from the fresh sample, not A's rows). Catches a verdict from a
   sample taken before B finished.
4. **Skipped run:** runs list reports B `queued` once, then nothing in flight; checks stay on A green ⇒ `[]` before the deadline.
   Catches a wait that never ends for a run that re-posts nothing.
5. **Runs read fails:** throws on the first call ⇒ `[]` on A as today; and a throw AFTER an in-flight report ⇒ also `[]` on the
   current rows, not a timeout; and a reply whose matching-path row has no `status` ⇒ `[]` on A at grace expiry. Catches a lookup
   failure or a malformed reply turning into a refusal or a hang.
6. **Second page:** page 1 = a full page (`PER_PAGE` of ci-proof) of completed runs (`total_count` = `PER_PAGE` + 1), page 2 = one `in_progress` guards run ⇒ keeps waiting. Catches
   absence decided from the first page.
7. **Deadline while in flight:** runs list keeps reporting `in_progress`; checks stay on A ⇒ the timeout refusal naming the run and
   `in_progress`. Catches a merge on old rows when the re-run never posts in time.
8. **Race with no earlier report** (Fable P2-1): the first lookup finds nothing in flight, but between the sample (A green) and that
   lookup B ran and posted red ⇒ refusal names B's guard from the fresh sample. Also asserts the test ends (no no-sleep loop).
9. **Queued cap** (owner 2026-11-27): runs list reports B `queued` on every lookup, checks stay on A green ⇒ `[]` on A once the
   (env-shortened) queued cap passes, before `deadline`; a variant where B is seen `in_progress` once keeps waiting past the cap to
   the deadline refusal. Catches a runner backlog spending the owner's word, and the cap releasing a run that already started.
10. **Own run still in_progress after posting** (Fable P3-3): checks show B green (one link, all rows new), runs list reports that
   same B `in_progress` ⇒ `[]` at that poll, not a wait. Catches a needless wait/timeout on the run that already posted.

## Risk
High (merge path, timing). Verify: `node scripts/test.mjs owner-go-hold-queue.test.mjs` + quick verify. Plan reviews done (Codex +
one recheck, Fable pass); the owner's go on this plan is the build trigger.
