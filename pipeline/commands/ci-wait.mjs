// `pipeline ci-wait --pr N`: wait until the PR's required CI is really done, so the hand-off after `gh pr ready` is never
// early. Replaces the review skill's "poll until checks exist, then `gh pr checks --watch --required`" loop, which passed on
// the draft-era SKIPPED run of a required check (Phase 6, EW #1631). The decisions live in lib/ci-wait.mjs (a pure state
// machine); this file wires GitHub, the clock and stderr progress into it. Run it through `P job start` (it can outlast a
// tool call).
import { existsSync } from 'node:fs';
import { EXIT, intOption, parseCommandArgs } from '../lib/cli.mjs';
import { Fail, guarded, resolveRepo } from '../lib/cmd-common.mjs';
import { loadConfig, requiredChecks } from '../lib/config.mjs';
import { createGitHub } from '../lib/github.mjs';
import { waitForCi } from '../lib/ci-wait.mjs';
import { readClassicRequired } from '../lib/protection.mjs';

export const meta = {
  summary: 'wait until the required CI of a ready PR is really done (ignores a draft-era skipped run), then report the verdict',
  usage: 'pipeline ci-wait --pr N [--repo DIR] [--appear-timeout SEC=300] [--timeout SEC=3600] [--interval SEC=15] [--wait-all] [--wait-others (kept for compatibility: waiting for running non-required checks is the default)]   -> {ok, verdict, head, readyAt, requiredSource, checks:[{name, appId, state, url, predatesReady? (true | null; true: a passing run or status dated before readyAt; null: the Actions run behind the status could not be read, unresolved; absent: not flagged; report only, the verdict is unchanged)}], message?, failures?, statusEvidence?, heldBy?, configChecks?, mergeState? (conflicting), others? (passed, every PR: [{name, status, url}] non-required checks still running or red; a running one is waited for until --timeout, then reported: the message says to start ci-wait again up to the restart cap in the hand-off guide, then name it to the owner; a red e2e suite is treated as failed, any other red check is named to the owner), notOwed? (passed, or failed under --wait-all: ci.merge_checks names with no producer at all, not owed)}; checks entries of ci.merge_checks carry source merge_checks; verdict passed (exit 0) | failed | timeout | missing | stale-skipped | conflicting (the PR conflicts with its base: no workflow ran; mergeState {mergeable, state}) | unverified | no-required-checks | head-moved | base-changed | draft (exit 1; a draft at the start: exit 2) | github (exit 3, 5 GitHub reads in a row failed)',
};

export const DEFAULT_APPEAR_SECONDS = 300;
export const DEFAULT_TIMEOUT_SECONDS = 3600;
export const DEFAULT_INTERVAL_SECONDS = 15;

const realClock = () => ({ now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) });

export const run = guarded(async (argv, ctx) => {
  const { values } = parseCommandArgs(argv, {
    pr: { type: 'string' }, repo: { type: 'string' }, 'appear-timeout': { type: 'string' }, timeout: { type: 'string' },
    interval: { type: 'string' }, 'wait-all': { type: 'boolean' }, 'wait-others': { type: 'boolean' },
  }, { allowPositionals: false });
  const pr = intOption(values, 'pr', { required: true, min: 1 });
  const appear = intOption(values, 'appear-timeout', { min: 0, max: 86_400 }) ?? DEFAULT_APPEAR_SECONDS;
  const timeout = intOption(values, 'timeout', { min: 1, max: 86_400 }) ?? DEFAULT_TIMEOUT_SECONDS;
  const interval = intOption(values, 'interval', { min: 1, max: 600 }) ?? DEFAULT_INTERVAL_SECONDS;
  const root = resolveRepo(values, ctx);

  // The check names the pipeline itself requires (config + the implicit guard / review contexts): diagnostics only, for a
  // verdict `unverified`. A missing pipeline.yml is allowed (nothing configured); one that exists but does not load is an error: the
  // config decides what is waited on (ci.merge_checks), so a typo must not silently switch those waits off.
  const loaded = await loadConfig(root);
  if (!loaded.ok && existsSync(loaded.path)) throw new Fail(EXIT.USAGE, { ok: false, error: 'config', errors: loaded.errors, path: loaded.path });
  const configChecks = loaded.ok ? [...new Set([...requiredChecks(loaded.config.ci), ...loaded.config.ci.merge_checks])] : [];
  // ci.merge_checks: judged like required checks once they report; one with no producer is notOwed (not part of
  // branch protection). Non-required checks that are still running or red are reported as `others` on every PR (#743), no label needed.
  const mergeChecks = loaded.ok ? loaded.config.ci.merge_checks : [];

  // `ctx.ciWait` is the test seam: a scripted gh and a simulated clock.
  const seam = ctx.ciWait ?? {};
  const gh = seam.gh ?? createGitHub({ cwd: root, env: ctx.env });
  const readers = {
    async pr() {
      const v = gh.prView(pr, ['headRefOid', 'isDraft', 'createdAt', 'baseRefName']);
      return { head: v.headRefOid, isDraft: v.isDraft === true, createdAt: v.createdAt, base: v.baseRefName };
    },
    mergeable: async () => gh.prView(pr, ['mergeable', 'mergeStateStatus']), // only read when a required check never appeared: a conflicting PR runs no workflow (#471)
    classic: async (base) => readClassicRequired(gh, base),
    rules: async (base) => gh.branchRules(base),
    checkRuns: async (head) => gh.checkRunsOf(head),
    statuses: async (head) => gh.statusesOf(head),
    timeline: async () => gh.timelineOf(pr),
    reviewMarkers: async () => gh.listComments(pr), // the PR's issue comments (paginated); only read to date a `Cross-model review` failure
    workflowRun: async (id) => gh.workflowRunOf(id), // one Actions run (run_started_at); read to date a `Cross-model review` failure and a passing status posted at/after ready (an unreadable run reports predatesReady: null)
    suiteRuns: async (suiteId) => gh.workflowRunsOfSuite(suiteId),
    headRuns: async (head) => gh.workflowRunsOfHead(head), // no fallback: a gh without it must fail the read, not silently end the late-aggregate hold
  };
  const result = await waitForCi({
    readers,
    options: { appearTimeoutMs: appear * 1000, timeoutMs: timeout * 1000, intervalMs: interval * 1000, waitAll: values['wait-all'] === true, configChecks, mergeChecks },
    clock: seam.clock ?? realClock(),
    onProgress: seam.onProgress ?? ((line) => process.stderr.write(`ci-wait: ${line}\n`)),
  });
  return result;
});
