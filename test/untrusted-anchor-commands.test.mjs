// #456: under an UNTRUSTED anchor (an origin remote that names no default branch: no refs/remotes/origin/HEAD and `git ls-remote --symref origin HEAD` fails) the content hash is measured from
// the working tree's default_branch, which the PR can edit. The merge gate already refuses (finalgate "default branch not anchored"); the commands that VOUCH for or RECORD from a hash must too,
// or review-complete would post "review valid for the current content" for content no round saw. review-complete, state mark-implemented and state fable-refresh refuse before they write
// anything; state outcome is informational and only warns. The real CLI against a throwaway repo, a fake gh and a scripted fake Codex (setup as test/review-round-untrusted-anchor.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roundWorld, findingsOf, low } from './helpers/round-world.mjs';
import { assertExit } from './helpers/assert-exit.mjs';

const NO_ORIGIN = '/nonexistent/cp-no-such-origin-456';
const UNANCHORED = /the default branch could not be anchored on the remote .*git remote set-head origin -a/;

// A PR with round 1 recorded (clean unless `suggestions`); the origin remote is added AFTER, so the rounds ran under a trusted anchor and only the later command sees the broken one.
function world(t, { suggestions = [] } = {}) {
  const w = roundWorld(t, { max: 3 });
  const one = w.codex(1, findingsOf([], suggestions));
  assertExit(one, 0, one.stderr + one.stdout);
  return { w, addOrigin: () => w.repo.git(['remote', 'add', 'origin', NO_ORIGIN]) };
}
const wrote = (w) => w.fake.lines().filter((l) => /remove-label|add-label|-X POST|-X PATCH|--method/.test(l));

test('review-complete: GitHub names the base branch, the anchor is untrusted: refuses (exit 1, untrusted-anchor) and posts nothing', (t) => {
  const { w, addOrigin } = world(t);
  const control = w.cli(['review-complete', '--pr', '7']);
  assert.notEqual(control.json?.error, 'untrusted-anchor', 'with no origin remote the anchor is trusted (control)');
  addOrigin();
  const before = [w.fake.comments().length, wrote(w).length];
  const r = w.cli(['review-complete', '--pr', '7']);
  assertExit(r, 1, r.stdout + r.stderr);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error, 'untrusted-anchor');
  assert.match(r.json.reason, UNANCHORED);
  assert.deepEqual([w.fake.comments().length, wrote(w).length], before, 'nothing was posted, labelled or published');
});

test('state mark-implemented: an untrusted anchor fails closed (exit 3, reason untrusted-anchor) and marks nothing', (t) => {
  const { w, addOrigin } = world(t, { suggestions: [low()] });
  assertExit(w.judge(1, { 'R1-S1': ['ACCEPT'] }), 0);
  w.repo.write('src/fix1.js', 'export const fix1 = 1;\n');
  w.repo.commit('fix 1');
  addOrigin();
  const before = w.stateText();
  const r = w.cli(['state', 'mark-implemented', '--ids', 'R1-S1']);
  assertExit(r, 3, r.stdout + r.stderr);
  assert.deepEqual([r.json.ok, r.json.unavailable, r.json.reason], [false, true, 'untrusted-anchor']);
  assert.match(r.json.message, UNANCHORED);
  assert.match(r.json.message, /nothing was marked/);
  assert.equal(w.stateText(), before, 'the state is untouched');
});

// A proven Fable round 1 recorded with an old Fable: the one state `fable-refresh` acts on.
function staleFableWorld(t) {
  const { w, addOrigin } = world(t);
  w.edit((s) => {
    Object.assign(s.rounds[0], { fableRequired: true, arbiter: { proofOk: true, scope: 'whole-pr' }, modelProof: { transcript: '/t', models: { 'claude-fable-5-1': 1 } } });
  });
  return { w, addOrigin };
}

test('state fable-refresh: an untrusted anchor refuses (error untrusted-anchor) and records no round', (t) => {
  const { w: ok } = staleFableWorld(t);
  const control = ok.cli(['state', 'fable-refresh', '--pr', '7']);
  assertExit(control, 0, control.stdout + control.stderr); // the fixture is sound: with a trusted anchor the refresh round is recorded
  const { w: w2, addOrigin } = staleFableWorld(t);
  addOrigin();
  const before = w2.stateText();
  const r = w2.cli(['state', 'fable-refresh', '--pr', '7']);
  assert.notEqual(r.code, 0, r.stdout);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error, 'untrusted-anchor');
  assert.match(r.json.message, UNANCHORED);
  assert.equal(w2.stateText(), before, 'no round was recorded');
});

test('state outcome: an untrusted anchor still answers (exit 0) but carries the untrusted sentence in warnings', (t) => {
  const { w, addOrigin } = world(t);
  const control = w.cli(['state', 'outcome']);
  assertExit(control, 0, control.stdout + control.stderr);
  assert.equal(control.json.warnings, undefined, 'a trusted anchor adds no warning (control)');
  addOrigin();
  const r = w.cli(['state', 'outcome']);
  assertExit(r, 0, r.stdout + r.stderr);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.warnings.length, 1);
  assert.match(r.json.warnings[0], UNANCHORED);
});

// triage defer-fixes records a deferral after comparing the content hash with the reviewed one: it fails closed like mark-implemented.
test('triage defer-fixes: an untrusted anchor fails closed (exit 3, untrusted-anchor, nothing deferred) and changes no state', (t) => {
  const w = roundWorld(t); // max 1: round 2 is the automatic extra round, its fix is then taken out as the skill does
  const { h2 } = w.atCap();
  w.revert(h2);
  w.repo.git(['remote', 'add', 'origin', NO_ORIGIN]);
  const before = w.stateText();
  const r = w.cli(['triage', 'defer-fixes', '--pr', '7', '--ids', 'R2-S1', '--fix-head', h2, '--reason', 'minor, file it']);
  assertExit(r, 3, r.stdout + r.stderr);
  assert.deepEqual([r.json.ok, r.json.unavailable, r.json.reason, r.json.error], [false, true, 'untrusted-anchor', 'untrusted-anchor']);
  assert.match(r.json.message, UNANCHORED);
  assert.match(r.json.message, /nothing was deferred$/);
  assert.equal(w.stateText(), before, 'the state is untouched');
});
