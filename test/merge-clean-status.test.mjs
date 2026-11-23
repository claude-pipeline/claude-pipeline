// #567: `gh pr merge --squash --auto` answered `GraphQL: Pull request Pull request is in clean status (enablePullRequestAutoMerge)` on an already-green PR: nothing merged,
// auto-merge was off, and a plain re-run worked. `P merge` classifies exactly that refusal as `retryable: 'clean-status'` on both routes (gated and --owner-go) and runs the
// command ONCE: the retry is a fresh `P merge` run (every gate, hold and recovery step again), never a second command inside one run. The classification needs a PROVEN clean state:
// auto-merge confirmed disabled, the PR state readable, no hold change. Everything else is the old failure, unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mergeRequest, ownerSays } from './helpers/owner-go.mjs';
import { bump, cli, ghEntries, scenario, ymlFor, PR } from './helpers/gate-env.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { cleanStatusRetry, isCleanStatusRefusal } from '../pipeline/lib/merge-cleanup.mjs';

// What a real `gh pr merge --auto` printed (an earlier session's raw capture: the doubled "Pull request" is gh's own).
const OBSERVED = 'GraphQL: Pull request Pull request is in clean status (enablePullRequestAutoMerge)';
const SINGLE = 'GraphQL: Pull request is in clean status (enablePullRequestAutoMerge)';

// The merge command: prints STUB_OUT on stdout and STUB_ERR on stderr, then exits (or kills itself) as the env says; exit 0 prints a success line.
const STUB = [
  "import { appendFileSync, mkdirSync } from 'node:fs';",
  "mkdirSync('.review', { recursive: true });",
  "appendFileSync('.review/merge-calls.log', `${process.argv.slice(2).join(' ')}\\n`);",
  "if (process.env.STUB_OUT) process.stdout.write(`${process.env.STUB_OUT}\\n`);",
  "if (process.env.STUB_ERR) process.stderr.write(`${process.env.STUB_ERR}\\n`);",
  "if (process.env.STUB_SIGNAL) process.kill(process.pid, process.env.STUB_SIGNAL);",
  "if (process.env.STUB_EXIT === '0') console.log('Merged pull request #12');",
  "process.exit(Number(process.env.STUB_EXIT ?? 1));",
  '',
].join('\n');

const unique = (repo) => { bump(repo); repo.write('.salt', randomUUID()); };
const OPEN = { mergeView: { state: 'OPEN', mergeCommit: null } };
const gatedWorld = (gh) => scenario({ yml: ymlFor().replace('fake-merge', 'stub-merge'), baseFiles: { 'scripts/stub-merge.mjs': STUB }, gh: { ...OPEN, ...gh } });
const goWorld = (gh) => scenario({
  yml: ymlFor().replace('fake-merge.mjs {pr} {sha}', 'stub-merge.mjs {pr} --match-head-commit {sha}'),
  report: null, state: null, change: unique, baseFiles: { 'scripts/stub-merge.mjs': STUB }, gh: { ...OPEN, ...gh },
});
const ROUTES = {
  gated: (t, env, gh) => {
    const s = gatedWorld(gh);
    assertExit(s.gate(), 0);
    return { s, r: s.merge(env) };
  },
  'owner-go': (t, env, gh) => {
    const s = goWorld(gh);
    ownerSays(t, 'merge', mergeRequest(PR, s.head, 'none'));
    return { s, r: cli(['merge', '--pr', String(PR), '--owner-go'], { dir: s.repo.dir, fake: s.fake, env: { ...s.env, ...env } }) };
  },
};

for (const [route, go] of Object.entries(ROUTES)) {
  test(`${route}: the exact clean-status refusal: one command run, not merged, retryable clean-status with a next step`, (t) => {
    for (const env of [{ STUB_ERR: OBSERVED }, { STUB_OUT: SINGLE }]) {
      const { s, r } = go(t, env);
      assertExit(r, 1);
      assert.equal(r.json.ok, false);
      assert.equal(r.json.merged, false);
      assert.equal(r.json.autoMergeDisabled, true);
      assert.equal(r.json.commandExitCode, 1);
      assert.equal(r.json.retryable, 'clean-status');
      assert.match(r.json.next, /run this same merge once more/);
      assert.match(r.json.reason, /merge command failed \(exit 1\) and the PR is not merged/);
      assert.equal(s.mergeCalls().length, 1, 'exactly one merge command run, no retry inside the run');
    }
  });

  test(`${route}: anything but the exact line is the old failure: a second diagnostic, a suffix, a prefix, exit 2, a signal`, (t) => {
    const cases = [
      [{ STUB_ERR: `${OBSERVED}\nGraphQL: Resource not accessible by integration` }, 'a second diagnostic'],
      [{ STUB_ERR: `${OBSERVED} (retry later)` }, 'a same-line suffix'],
      [{ STUB_ERR: `error: ${OBSERVED}` }, 'a same-line prefix'],
      [{ STUB_ERR: OBSERVED, STUB_EXIT: '2' }, 'exit 2'],
      [{ STUB_OUT: 'Merged pull request #12', STUB_ERR: OBSERVED }, 'a success line next to it'],
      ...(process.platform === 'win32' ? [] : [[{ STUB_ERR: OBSERVED, STUB_SIGNAL: 'SIGKILL' }, 'a signal']]), // (Windows has no signals; the unit test covers the rule everywhere)
    ];
    for (const [env, why] of cases) {
      const { r } = go(t, env);
      assert.equal(r.json.ok, false, why);
      assert.equal(r.json.retryable, undefined, why);
      assert.equal(r.json.next, undefined, why);
    }
  });

  test(`${route}: the zero-wait read of the PR failed (exit 1 never waits): no retryable, though the read after the disable works`, (t) => {
    // Failure caught: a wait whose only read failed (so the blockers were never checked) still told the caller a fresh run was safe.
    const { r } = go(t, { STUB_ERR: OBSERVED }, { extra: [{ match: '^pr view 12 --json state,mergeCommit,labels', code: 1, stderr: 'gh: Server Error (HTTP 502)' }] });
    assertExit(r, 1);
    assert.equal(r.json.merged, false);
    assert.equal(r.json.autoMergeDisabled, true);
    assert.equal(r.json.retryable, undefined, 'the wait never read the PR');
    assert.equal(r.json.next, undefined);
  });

  // Failure caught (#672): a zero-wait read that SAW a blocker or a closed PR still said "run this same merge once more" and dropped the blocker's reason, so the caller spent a dry run and a merge job on a merge the gate refuses.
  test(`${route}: the zero-wait read found a blocker or a closed PR: no retryable, and the reason says why`, (t) => {
    const blocked = go(t, { STUB_ERR: OBSERVED }, { extra: [{ match: '^pr view 12 --json state,mergeCommit,labels', stdoutJson: { state: 'OPEN', mergeCommit: null, labels: [{ name: 'pipeline-blocked' }] } }] });
    assertExit(blocked.r, 1);
    assert.equal(blocked.r.json.autoMergeDisabled, true);
    assert.equal(blocked.r.json.retryable, undefined, 'a blocked outcome is a real refusal');
    assert.equal(blocked.r.json.next, undefined);
    assert.match(blocked.r.json.reason, /merge command failed \(exit 1\) and the PR is not merged; a blocker appeared while waiting: .*blocking label\(s\): pipeline-blocked/);
    const closed = go(t, { STUB_ERR: OBSERVED }, { extra: [{ match: '^pr view 12 --json state,mergeCommit,labels', stdoutJson: { state: 'CLOSED', mergeCommit: null, labels: [] } }] });
    assertExit(closed.r, 1);
    assert.equal(closed.r.json.retryable, undefined, 'a closed PR is not retryable');
    assert.match(closed.r.json.reason, /and the PR is not merged; the PR was closed without merging/);
  });

  test(`${route}: auto-merge not proven off, or the state unreadable: no retryable (armed; unreadable; disable failed but GitHub confirms nothing is armed = retryable)`, (t) => {
    const armed = go(t, { STUB_ERR: OBSERVED }, { disableAutoCode: 1, autoMergeRequest: { enabledAt: '2026-11-17T00:00:00Z' } });
    assert.equal(armed.r.json.autoMergeDisabled, false);
    assert.equal(armed.r.json.retryable, undefined, 'still armed');
    const unreadable = go(t, { STUB_ERR: OBSERVED }, { extra: [{ match: '^pr view 12 --json state,mergeCommit$', code: 1, stderr: 'gh: Server Error (HTTP 502)' }] });
    assert.equal(unreadable.r.json.retryable, undefined, 'the state after the disable could not be read');
    const confirmed = go(t, { STUB_ERR: OBSERVED }, { disableAutoCode: 1, autoMergeRequest: null });
    assert.equal(confirmed.r.json.autoMergeDisabled, true);
    assert.equal(confirmed.r.json.retryable, 'clean-status', 'the existing code reports it disarmed: follow it');
  });
}

test('owner-go: a second `P merge --owner-go` for the same head and the same typed record merges: the first failure did not consume the owner\'s word', (t) => {
  const s = goWorld();
  ownerSays(t, 'merge', mergeRequest(PR, s.head, 'none'));
  const run = (env) => cli(['merge', '--pr', String(PR), '--owner-go'], { dir: s.repo.dir, fake: s.fake, env: { ...s.env, ...env } });
  const first = run({ STUB_ERR: OBSERVED });
  assertExit(first, 1);
  assert.equal(first.json.retryable, 'clean-status');
  s.fake.setScript(ghEntries({ prHead: s.head, baseOid: s.baseTip, prFiles: s.prFiles })); // GitHub now accepts it: MERGED
  const second = run({ STUB_EXIT: '0' });
  assertExit(second, 0, `${second.stderr}${second.stdout}`);
  assert.equal(second.json.merged, true);
  assert.equal(second.json.retryable, undefined);
  assert.equal(s.mergeCalls().length, 2, 'one command run per P merge run');
});

// ---- the matcher and the clean-state rule, unit level (what a subprocess cannot reach: a timeout, an unreadable wait) -----------------

const ran = (over = {}) => ({ code: 1, timedOut: false, signal: null, stdout: '', stderr: `${OBSERVED}\n`, ...over });

test('isCleanStatusRefusal: only the two whole-line forms, at least one, nothing else', () => {
  assert.equal(isCleanStatusRefusal(ran()), true, 'the observed doubled form');
  assert.equal(isCleanStatusRefusal(ran({ stderr: `${SINGLE}\n` })), true, 'the single form');
  assert.equal(isCleanStatusRefusal(ran({ stderr: `\n  ${OBSERVED}  \r\n\r\n` })), true, 'blank lines and surrounding space are ignored');
  assert.equal(isCleanStatusRefusal(ran({ stdout: `${SINGLE}\n`, stderr: `${OBSERVED}\n` })), true, 'both streams, each line exact');
  for (const [name, over] of Object.entries({
    'an extra line': { stderr: `${OBSERVED}\nsomething else\n` },
    'a GraphQL second diagnostic': { stderr: `${OBSERVED}\nGraphQL: Could not resolve to a PullRequest\n` },
    'a suffix': { stderr: `${OBSERVED} (x)\n` },
    'a prefix': { stderr: `npm error ${OBSERVED}\n` },
    'a wrapped command banner': { stdout: '> merge\n', stderr: `${OBSERVED}\n` },
    'exit 2': { code: 2 },
    'exit 0': { code: 0 },
    'a timeout': { timedOut: true },
    'a signal': { signal: 'SIGTERM' },
    'empty output': { stderr: '' },
    'whitespace-only output': { stdout: ' \n\t\n', stderr: '\r\n' },
  })) assert.equal(isCleanStatusRefusal(ran(over)), false, name);
});

test('cleanStatusRetry: needs the exact refusal AND a proven clean state (disarmed, no read error, the wait did not fail to read)', () => {
  const clean = { autoMergeDisabled: true };
  const got = cleanStatusRetry(ran(), { state: 'timeout', readOk: true }, clean);
  assert.equal(got.retryable, 'clean-status');
  assert.match(got.next, /run this same merge once more/);
  assert.deepEqual(cleanStatusRetry(ran({ stderr: 'nope\n' }), { state: 'timeout', readOk: true }, clean), {});
  assert.deepEqual(cleanStatusRetry(ran(), { state: 'timeout', readOk: true }, { autoMergeDisabled: false }), {}, 'not disarmed');
  assert.deepEqual(cleanStatusRetry(ran(), { state: 'timeout', readOk: true }, { autoMergeDisabled: undefined }), {}, 'absence of a flag is not proof');
  assert.deepEqual(cleanStatusRetry(ran(), { state: 'timeout', readOk: true }, { autoMergeDisabled: true, readError: 'HTTP 502' }), {}, 'the state after the disable was not read');
  assert.deepEqual(cleanStatusRetry(ran(), { state: 'error', error: 'HTTP 502' }, clean), {}, 'the wait could not read the PR');
  assert.deepEqual(cleanStatusRetry(ran(), { state: 'timeout', readOk: false }, clean), {}, 'a zero wait whose one read failed ends as a timeout');
  assert.deepEqual(cleanStatusRetry(ran(), { state: 'timeout' }, clean), {}, 'a timeout that does not say the read worked is no proof');
  assert.deepEqual(cleanStatusRetry(ran(), { state: 'blocked', problems: ['blocking label(s): pipeline-blocked'] }, clean), {}, 'a blocked outcome');
  assert.deepEqual(cleanStatusRetry(ran(), { state: 'closed' }, clean), {}, 'a closed outcome');
});
