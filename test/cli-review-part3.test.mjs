// End-to-end tests for the review-loop commands (codex-review, triage, arbiter, state, review-complete, followups).
// They spawn the real CLI against a real throwaway git repo, a scripted fake gh and a scripted fake codex, because the
// contract the ship skill depends on is the pair (stdout JSON, exit code) plus the .review/ files left behind.
// Part 3 of 4, split from cli-review.test.mjs to balance the CI shards; shared helpers: helpers/cli-review-world.mjs.
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { createFakeGh, fakeGhPath, pipelineYml, REPO_VIEW } from './helpers/fakegh-env.mjs';
import { contentHash } from '../pipeline/lib/git.mjs';
import { loadConfig } from '../pipeline/lib/config.mjs';
import { currentContentHash, excerptWindow, reviewBaseRef } from '../pipeline/lib/review-context.mjs';
import { MARKERS, triageComment } from '../pipeline/lib/render.mjs';
import { reviewContentHash } from '../pipeline/lib/review-publish.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { SHARED_FLOOR_DIR, floorEnv, scratchFloorDir } from './helpers/floor-env.mjs';
import { resetFloor } from '../pipeline/lib/model-floor.mjs';
import { leasesDir } from '../pipeline/lib/review-lease.mjs';
import { cleanupAtExit, cleanupRoundClaims, ownerApprovesPast, ownerGrants, ownerRules, pastRoundRequest, roundRequest, rulingRequest } from './helpers/owner-go.mjs';
import { grantIdOf, markerPath, presentedRoundRequest, readGrantMarker } from '../pipeline/hooks/lib/owner-go.mjs';
import { fableFindingItems, rulingContentDigest } from '../pipeline/lib/triage.mjs';
import { reviewCheck } from '../pipeline/lib/finalgate.mjs';
import { noClaudeSession } from './helpers/no-claude-session.mjs';
import { ACCEPT_QUOTE, BAD_NAME, CAP1_CHAT, CAP1_LABEL, CAP2_CHAT, CHANGES, CHAT_YML, COMMENTS, DISPUTED, FABLE_CLEAN, FP_ISSUE, FRAMED, FROM_MAIN, GH, GH_CREATED, ISSUES_URL, JUDGE_TAG, MAIN_EDITS_V12, MAX1, NOT_WRITTEN, NO_COMMENTS, NO_ISSUES, OLD_FABLE, PR_VIEW_AFTER, QUOTE, RECHECK_ADD, RECHECK_OK, RECHECK_REMOVE, REJECT_QUOTE, REMOVE_LABEL, REVIEW_COMMENT, SENSITIVE_YML, SEQ_GH, SMUGGLED, SORT_RULINGS, STANDARD_JUDGE, aFile, acceptedWorld, addFableItem, applyRound2, arbiterRun, askedContent, assertAllNeedHuman, atCap, bFile, bin, codexThree, commentsEntry, conflictFableWorld, conflictKeepingOurs, conflictMerge, countedAs, disputedWorld, editState, fakeCodex, fenced, finding, findingsOf, fixA, fixSrcA, followupWorld, gateReview, gotPr, here, installTranscript, issue, judgeTranscript, ledgerOf, markA, mergeMainInto, mine, noIssues, noRoundWritten, noState, oldProofWorld, ownerAnswers, ownerGrantsRound, ownerWorld, patchOf, postedBodies, posts, promptFor, proveRound, publishedWorld, readyForArbiter, refreshOf, refusedAs, refusedUnresolved, reviewAndFix, reviewJson, rule, scanLines, settleArgs, sha256, sinceWorld, staleDirs, standardFindings, transcript, triageNote, twoFableRounds, uniqueSlug, waitingForHuman, withModel, world, worldIgnoringReview } from './helpers/cli-review-world.mjs';

test('codex-review: a clean main merge that edits lines next to the PR hunk changes the content hash; the round is baseOnly and the PR still completes', (t) => {
  const w = worldIgnoringReview(t, { gh: [...GH, REMOVE_LABEL, ...REVIEW_COMMENT] });
  assertExit(w.codex(1, findingsOf([finding()])), 0);
  assertExit(w.judge(1, { 'R1-B1': ['ACCEPT'] }), 0);
  const head2 = fixA(w);
  assertExit(w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']), 0);
  assertExit(w.codex(2, findingsOf(), { from: w.head, to: head2 }), 0);
  const hashBefore = w.cli(['state', 'outcome']).json.currentContentHash;

  const merged = mergeMainInto(w, { 'src/a.js': aFile(false).replace('export const v9 = 9;', 'export const v9 = 90;') });
  assert.notEqual(w.cli(['state', 'outcome']).json.currentContentHash, hashBefore, 'the merge moved the hash (context lines)');
  const r = w.codex(3, findingsOf(), { from: head2, to: merged });
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.baseOnly, true);
  const outcome = w.cli(['state', 'outcome']);
  assert.deepEqual([outcome.json.clean, outcome.json.coverageValid], [true, true], JSON.stringify(outcome.json));
  w.prHead(merged);
  const done = w.cli(['review-complete', '--pr', '7']);
  assertExit(done, 0, done.stderr + done.stdout);
  assert.equal(done.json.ok, true);
});

test('codex-review: a conflicting main merge resolved by choosing lines, after an accept: Codex reviews the resolution (not empty-range) and the accept still needs its fix round', (t) => {
  const w = worldIgnoringReview(t);
  assertExit(w.codex(1, findingsOf([finding()])), 0);
  assertExit(w.judge(1, { 'R1-B1': ['ACCEPT'] }), 0);
  const merged = conflictKeepingOurs(w);
  const r = w.codex(2, findingsOf(), { from: w.head, to: merged });
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.resolutionOnly, true);
  assert.equal(r.json.baseOnly, undefined);
  assert.equal(w.captured().length, 2, 'Codex ran over the resolution');
  const outcome = w.cli(['state', 'outcome']);
  assert.equal(outcome.json.clean, false);
  assert.deepEqual(outcome.json.unimplemented, ['R1-B1']);
});

test('codex-review: empty-range after an accept names the accepts still waiting for their fix; with none waiting it says what round the content is', (t) => {
  const w = world(t);
  assertExit(w.codex(1, findingsOf([finding()])), 0);
  assertExit(w.judge(1, { 'R1-B1': ['ACCEPT'] }), 0);
  const same = w.codex(2, findingsOf(), { from: w.head, to: w.head }); // base == head
  assertExit(same, 2, same.stdout);
  assert.equal(same.json.error, 'empty-range');
  assert.match(same.json.message, /commit the fix for R1-B1 first/);
  w.repo.git(['commit', '-q', '--allow-empty', '-m', 'nothing']);
  const head2 = w.repo.git(['rev-parse', 'HEAD']).trim();
  const empty = w.codex(2, findingsOf(), { from: w.head, to: head2 });
  assertExit(empty, 2, empty.stdout);
  assert.match(empty.json.message, /commit the fix for R1-B1 first/);
  assert.equal(w.state().rounds.length, 1, 'nothing was recorded');
  assert.equal(existsSync(w.roundFile(2, 'diff.patch')), false, 'and nothing was written for the round');

  // fixed and re-reviewed clean: an amend-like empty commit has no accept waiting any more
  const head3 = fixA(w);
  assertExit(w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']), 0);
  assertExit(w.codex(2, findingsOf(), { from: w.head, to: head3 }), 0);
  w.repo.git(['commit', '-q', '--allow-empty', '-m', 'nothing again']);
  const head4 = w.repo.git(['rev-parse', 'HEAD']).trim();
  const none = w.codex(3, findingsOf(), { from: head3, to: head4 });
  assertExit(none, 2, none.stdout);
  assert.equal(none.json.error, 'empty-range');
  assert.match(none.json.message, /nothing new to review: the content is what round 2 reviewed; if that round was clean, review-complete uses it/);
  assert.doesNotMatch(none.json.message, /commit the fix/);
});

test('mark-implemented: a commit that only adds or edits tests is not a fix; a source change is', (t) => {
  const w = world(t);
  assertExit(w.codex(1, findingsOf([finding()])), 0);
  assertExit(w.judge(1, { 'R1-B1': ['ACCEPT'] }), 0);
  w.repo.write('src/a.test.js', "test('null x', () => {});\n");
  w.repo.git(['add', 'src/a.test.js']); // just the test: the untracked .review/ state stays out
  w.repo.git(['commit', '-q', '-m', 'test only']);
  const testOnly = w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']);
  assertExit(testOnly, 2, testOnly.stdout);
  assert.equal(testOnly.json.error, 'no-code-change');
  assert.match(testOnly.json.message, /only test files/);
  assert.ok(!w.item('R1-B1').implemented);

  w.repo.write('src/a.js', aFile(true).replace('compute(x.y)', 'compute(x?.y)'));
  w.repo.commit('fix');
  assertExit(w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']), 0);
  assert.ok(w.item('R1-B1').implemented);
});

test('mark-implemented: a testing finding is fixed by a test-only commit; a bug finding still is not (#53)', (t) => {
  const w = world(t);
  const testing = finding({ title: 'Cover the old-code path', file: 'src/a.js', category: 'testing' });
  assertExit(w.codex(1, findingsOf([finding()], [testing])), 0);
  assertExit(w.judge(1, { 'R1-B1': ['ACCEPT'], 'R1-S1': ['ACCEPT'] }), 0);
  w.repo.write('src/a.test.js', "test('old path', () => {});\n");
  w.repo.git(['add', 'src/a.test.js']);
  w.repo.git(['commit', '-q', '-m', 'test only']);

  const marked = w.cli(['state', 'mark-implemented', '--ids', 'R1-S1']);
  assertExit(marked, 0, marked.stderr + marked.stdout);
  assert.ok(w.item('R1-S1').implemented);
  const bug = w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']);
  assertExit(bug, 2, bug.stdout);
  assert.equal(bug.json.error, 'no-code-change', 'the same test-only commit never clears a bug finding');
  assert.ok(!w.item('R1-B1').implemented);
});

test('mark-implemented: a fix to the finding\'s own file counts even under a test glob; another test file does not (#53)', (t) => {
  const w = world(t);
  w.repo.write('e2e/fixtures/env.ts', 'export const env = {};\n');
  const head = w.repo.commit('add a launch helper');
  assertExit(w.codex(1, findingsOf([finding({ file: 'e2e/fixtures/env.ts' })]), { to: head }), 0);
  assertExit(w.judge(1, { 'R1-B1': ['ACCEPT'] }), 0);

  w.repo.write('e2e/other.spec.ts', "test('x', () => {});\n");
  w.repo.git(['add', 'e2e/other.spec.ts']);
  w.repo.git(['commit', '-q', '-m', 'another test']);
  const other = w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']);
  assertExit(other, 2, other.stdout);
  assert.equal(other.json.error, 'no-code-change');

  w.repo.write('e2e/fixtures/env.ts', 'export const env = { TZ: "UTC" };\n');
  w.repo.git(['add', 'e2e/fixtures/env.ts']);
  w.repo.git(['commit', '-q', '-m', 'fix the helper']);
  const marked = w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']);
  assertExit(marked, 0, marked.stderr + marked.stdout);
  assert.ok(w.item('R1-B1').implemented);
});

test('codex-review: with nothing accepted, a later round over an unchanged tree is still allowed', (t) => {
  const w = world(t);
  assertExit(w.codex(1, findingsOf([finding()])), 0);
  assertExit(w.judge(1, { 'R1-B1': ['REJECT'] }), 0);
  assertExit(w.codex(2, findingsOf(), { from: w.head, to: w.head }), 0);
});

test('triage settle: the CLI runs the test; the command, file, exit code and head are recorded with the output', (t) => {
  const w = disputedWorld(t);
  const r = w.cli(settleArgs(w, 'R1-B1', 'bug-disproved', { output: 'compute(undefined) is 0' }));
  assertExit(r, 0, r.stdout + r.stderr);
  const rec = w.item('R1-B1').test;
  assert.equal(rec.status, 'bug-disproved');
  assert.equal(rec.cmd, 'node src/proof.test.js');
  assert.equal(rec.file, 'src/proof.test.js');
  assert.equal(rec.exitCode, 0);
  assert.equal(rec.head, w.repo.git(['rev-parse', 'HEAD']).trim());
  assert.match(rec.evidence, /compute\(undefined\) is 0/);
  assert.equal(w.item('R1-B1').final.needsHuman, false, 'a non-security dismissal by test is final');
});

test('triage settle: production code changed after the round\'s reviewed head refuses before the test runs (settle-head-moved), nothing recorded', (t) => {
  const w = disputedWorld(t);
  w.repo.write('src/b.js', `${bFile}export const later = 1;\n`); // a later fix: it could make the settle test pass and give round 1's finding a REJECT
  w.repo.commit('fix after the reviewed head');
  const snapshot = w.stateText();
  const r = w.cli(settleArgs(w, 'R1-B1', 'bug-disproved'));
  assertExit(r, 1, r.stdout + r.stderr);
  assert.equal(r.json.error, 'settle-head-moved');
  assert.match(r.json.next, /^arbiter needed --pr 7 --round 1/);
  assert.equal(w.stateText(), snapshot, 'nothing recorded, nothing run');
  assert.equal(w.item('R1-B1').test, undefined);
});

test('triage settle: a HEAD that is not a descendant of the reviewed head and lacks its production change refuses (settle-head-moved), though only a test differs from the merge base', (t) => {
  const w = disputedWorld(t);
  w.repo.git(['reset', '-q', '--hard', w.base]); // HEAD forks from round 1's reviewed head: the reviewed fix (src/a.js, src/big.js) is not in it
  const args = settleArgs(w, 'R1-B1', 'bug-disproved'); // the only change from the merge base is the proving test
  const snapshot = w.stateText();
  const r = w.cli(args);
  assertExit(r, 1, r.stdout + r.stderr);
  assert.equal(r.json.error, 'settle-head-moved');
  assert.equal(w.stateText(), snapshot, 'nothing recorded');
  assert.equal(w.item('R1-B1').test, undefined);
});

test('triage settle: an uncommitted change to a tracked production file refuses (settle-head-moved): the run would read code the reviewed head does not have', (t) => {
  const w = disputedWorld(t);
  const args = settleArgs(w, 'R1-B1', 'bug-disproved'); // the proving test is committed
  w.repo.write('src/b.js', `${bFile}export const wip = 1;\n`); // a fix in the file the test imports, not committed
  const snapshot = w.stateText();
  const r = w.cli(args);
  assertExit(r, 1, r.stdout + r.stderr);
  assert.equal(r.json.error, 'settle-head-moved');
  assert.match(r.json.reason, /src\/b\.js/);
  assert.equal(w.stateText(), snapshot, 'nothing recorded');
  assert.equal(w.item('R1-B1').test, undefined);
});

test('triage settle: a passing test cannot confirm a bug, a failing test cannot disprove one (state untouched)', (t) => {
  const w = disputedWorld(t);
  const before = () => w.stateText();
  const snapshot = before();
  const disproveFail = w.cli(settleArgs(w, 'R1-B1', 'bug-disproved', { code: 1 }));
  assertExit(disproveFail, 1, disproveFail.stdout);
  assert.match(disproveFail.json.reason, /needs the test to pass/);
  const confirmPass = w.cli(settleArgs(w, 'R1-B1', 'bug-confirmed', { code: 0 }));
  assertExit(confirmPass, 1, confirmPass.stdout);
  assert.match(confirmPass.json.reason, /needs the test to fail/);
  assert.equal(before(), snapshot);
  assert.equal(w.item('R1-B1').test, undefined);
});

test('triage settle: a test that cannot be trusted as proof is refused before anything runs', (t) => {
  const w = disputedWorld(t);
  const snapshot = w.stateText();
  const base = ['triage', 'settle', '--id', 'R1-B1', '--result', 'bug-disproved'];
  // Not in the PR head.
  w.repo.write('src/x.test.js', 'process.exit(0);\n');
  const notCommitted = w.cli([...base, '--test-cmd', 'node src/x.test.js', '--test-file', 'src/x.test.js']);
  assertExit(notCommitted, 1, notCommitted.stdout);
  assert.match(notCommitted.json.reason, /not in the PR head/);
  // Committed, then edited: the run would not prove the head.
  w.repo.commit('add x test');
  w.repo.write('src/x.test.js', 'process.exit(1);\n');
  const dirty = w.cli([...base, '--test-cmd', 'node src/x.test.js', '--test-file', 'src/x.test.js']);
  assert.match(dirty.json.reason, /uncommitted changes/);
  w.repo.write('src/x.test.js', 'process.exit(0);\n');
  // Not a test file, command that does not run it, file that does not exist.
  const notTest = w.cli([...base, '--test-cmd', 'node src/a.js', '--test-file', 'src/a.js']);
  assert.match(notTest.json.reason, /not a test file/);
  const notNamed = w.cli([...base, '--test-cmd', 'true', '--test-file', 'src/x.test.js']);
  assert.match(notNamed.json.reason, /must run --test-file/);
  const missing = w.cli([...base, '--test-cmd', 'node src/none.test.js', '--test-file', 'src/none.test.js']);
  assert.match(missing.json.reason, /not in the PR head/);
  for (const r of [notCommitted, dirty, notTest, notNamed, missing]) assertExit(r, 1);
  w.repo.rm('src/x.test.js');
  assert.equal(w.item('R1-B1').test, undefined);
  assert.equal(w.stateText(), snapshot);
});

test('triage settle: a command that cannot run (127) is not a failing test and confirms nothing', (t) => {
  const w = disputedWorld(t);
  const r = w.cli(settleArgs(w, 'R1-B1', 'bug-confirmed', { cmd: 'definitely-not-a-command-xyz src/proof.test.js' }));
  assertExit(r, 1, r.stdout);
  assert.match(r.json.reason, /could not be run/);
  assert.equal(w.item('R1-B1').test, undefined);
});

test('triage settle: a passing test that dismisses a security item still goes to a human (needsHuman), never skipping that rule', (t) => {
  const w = disputedWorld(t, 'security');
  const r = w.cli(settleArgs(w, 'R1-B1', 'bug-disproved'));
  assertExit(r, 0, r.stdout + r.stderr);
  const final = w.item('R1-B1').final;
  assert.equal(final.decision, 'REJECT');
  assert.equal(final.by, 'test');
  assert.equal(final.needsHuman, true);
  assert.deepEqual(w.cli(['state', 'outcome']).json.needsHuman, ['R1-B1']);
  assert.equal(w.cli(['state', 'outcome']).json.clean, false);
  // Confirming a security bug by a failing test is the safe direction and stays automatic.
  const w2 = disputedWorld(t, 'auth');
  assertExit(w2.cli(settleArgs(w2, 'R1-B1', 'bug-confirmed')), 0);
  assert.equal(w2.item('R1-B1').final.needsHuman, false);
  assert.equal(w2.item('R1-B1').final.decision, 'ACCEPT');
});

test('state show --pr: equal local and published state is served from local, nothing moved', (t) => {
  const { w, published } = publishedWorld(t);
  assert.deepEqual(w.state(), published, 'precondition: the two worlds produced the same state');
  const r = w.cli(['state', 'show', '--pr', '7']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual([r.json.source, r.json.recovered, r.json.quarantinedTo], ['local', false, undefined]);
  assert.deepEqual(staleDirs(w), []);
});

test('state show --pr: a lost local state is rebuilt with source published', (t) => {
  const { w: src, published } = publishedWorld(t);
  const w = world(t, { gh: [...GH, ...COMMENTS(mine(published))] });
  assert.ok(src);
  const r = w.cli(['state', 'show', '--pr', '7']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual([r.json.source, r.json.recovered], ['published', true]);
});

test('state show (no --pr) never asks GitHub and reports source local', (t) => {
  const { w } = publishedWorld(t);
  const before = w.fake.calls().length;
  const r = w.cli(['state', 'show']);
  assertExit(r, 0);
  assert.equal(r.json.source, 'local');
  assert.equal(w.fake.calls().length, before);
});

test('state show --pr: GitHub unavailable with a local state serves it as local-unverified with a warning; with no local state it stays exit 3', (t) => {
  const { w, published } = publishedWorld(t);
  const down = [{ match: '.', code: 1, stderr: 'HTTP 502' }];
  w.fake.setScript(down);
  const r = w.cli(['state', 'show', '--pr', '7']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.source, 'local-unverified');
  assert.equal(r.json.recovered, false);
  assert.equal(r.json.pr, 7);
  assert.equal(r.json.count, 4);
  assert.equal(r.json.warnings.length, 1);
  assert.match(r.json.warnings[0], /GitHub unavailable/);
  assert.deepEqual(w.state(), published, 'the local state is served, never rewritten or moved');
  assert.deepEqual(staleDirs(w), []);
  // nothing local to fall back to: still unavailable
  const none = world(t, { gh: down });
  assertExit(none.cli(['state', 'show', '--pr', '7']), 3);
});

test('state show --pr: local that strictly extends the published state (an unpublished round 2) is kept', (t) => {
  const { w, published } = publishedWorld(t);
  editState(w, (s) => {
    s.rounds.push({ n: 2, fromHead: s.rounds[0].toHead, toHead: 'f'.repeat(40), contentHashAtToHead: 'h2', items: [] });
  });
  const r = w.cli(['state', 'show', '--pr', '7']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.source, 'local');
  assert.equal(w.state().rounds.length, 2);
  assert.deepEqual(w.state().rounds[0], published.rounds[0]);
  assert.deepEqual(staleDirs(w), []);
});

test('state show --pr: same head and hash but different decisions is quarantined and the published state restored', (t) => {
  const { w, published } = publishedWorld(t);
  assert.equal(w.item('R1-W1').final.decision, 'FOLLOW-UP');
  editState(w, (s) => { s.rounds[0].items.find((i) => i.id === 'R1-W1').final.decision = 'REJECT'; }); // same toHead + contentHash
  const r = w.cli(['state', 'show', '--pr', '7']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.source, 'quarantined');
  assert.match(r.json.quarantinedTo, /^\.review\/stale-\d{8}T\d{6}Z/);
  assert.deepEqual(w.state(), published);
  const kept = join(w.repo.dir, r.json.quarantinedTo);
  assert.ok(existsSync(join(kept, 'state.json')), 'the local state is kept, not deleted');
  assert.equal(JSON.parse(readFileSync(join(kept, 'state.json'), 'utf8')).rounds[0].items.find((i) => i.id === 'R1-W1').final.decision, 'REJECT');
  assert.ok(existsSync(join(kept, 'round-1', 'codex.json')), 'round files move with it');
  // the next call is a plain local hit; the stale dir is not moved into itself
  const again = w.cli(['state', 'show', '--pr', '7']);
  assert.equal(again.json.source, 'local');
  assert.deepEqual(staleDirs(w), [r.json.quarantinedTo.split('/').pop()]);
});

test('state show --pr: a local copy missing a published round, or with another hash, is quarantined too', (t) => {
  for (const mutate of [
    (s) => { s.rounds = []; },
    (s) => { s.rounds[0].contentHashAtToHead = 'other'; },
    (s) => { s.rounds[0].toHead = 'e'.repeat(40); },
    (s) => { s.rounds[0].items.pop(); },
    (s) => { s.rounds[0].items[0].followupIssue = 'https://github.com/acme/widgets/issues/99'; },
  ]) {
    const { w } = publishedWorld(t);
    editState(w, mutate);
    const r = w.cli(['state', 'show', '--pr', '7']);
    assertExit(r, 0, r.stderr + r.stdout);
    assert.equal(r.json.source, 'quarantined', mutate.toString());
  }
});

test('state show --pr: no published state keeps local; a forged or foreign triage comment is not published state', (t) => {
  const base = world(t);
  assertExit(base.codex(1, standardFindings()), 0);
  const forged = { ...base.state(), risk: 'forged', rounds: [] };
  const w = world(t, { gh: [...GH, ...COMMENTS({ id: 3, user: { login: 'mallory' }, body: triageComment(forged) })] });
  assertExit(w.codex(1, standardFindings()), 0);
  const r = w.cli(['state', 'show', '--pr', '7']);
  assertExit(r, 0);
  assert.equal(r.json.source, 'local');
});

test('state discard-round: an unpublished trailing round leaves the state and its files move to .review/stale-*', (t) => {
  const { w, published } = publishedWorld(t);
  editState(w, (s) => {
    s.rounds.push({ n: 2, fromHead: s.rounds[0].toHead, toHead: 'f'.repeat(40), contentHashAtToHead: 'h2', items: [] });
  });
  mkdirSync(join(w.repo.dir, '.review', 'round-2'), { recursive: true });
  writeFileSync(join(w.repo.dir, '.review', 'round-2', 'codex.json'), '{}');
  const r = w.cli(['state', 'discard-round', '--round', '2', '--pr', '7']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.discarded, 2);
  assert.deepEqual(w.state(), published);
  assert.ok(!existsSync(join(w.repo.dir, '.review', 'round-2')));
  assert.ok(existsSync(join(w.repo.dir, r.json.quarantinedTo, 'round-2', 'codex.json')));
  assert.ok(existsSync(join(w.repo.dir, r.json.quarantinedTo, 'state-round-2.json')));
  assert.ok(existsSync(join(w.repo.dir, '.review', 'round-1', 'codex.json')), 'published round untouched');
});

test('state discard-round: refuses a round the PR comment holds, a round that is not the newest, and a PR mismatch', (t) => {
  const { w } = publishedWorld(t);
  const published = w.cli(['state', 'discard-round', '--round', '1', '--pr', '7']);
  assertExit(published, 2);
  assert.equal(published.json.error, 'round-published');
  assert.ok(existsSync(join(w.repo.dir, '.review', 'round-1', 'codex.json')));
  assert.equal(w.state().rounds.length, 1);
  assert.deepEqual(staleDirs(w), []);

  editState(w, (s) => {
    s.rounds.push({ n: 2, fromHead: s.rounds[0].toHead, toHead: 'f'.repeat(40), contentHashAtToHead: 'h2', items: [] });
  });
  assertExit(w.cli(['state', 'discard-round', '--round', '1', '--pr', '7']), 2);
  assert.equal(w.cli(['state', 'discard-round', '--round', '9', '--pr', '7']).json.error, 'no-round');
  assert.equal(w.cli(['state', 'discard-round', '--round', '2', '--pr', '8']).json.error, 'state-pr-mismatch');
  assertExit(w.cli(['state', 'discard-round']), 2);
  assert.match(w.cli(['state', 'bogus']).stdout + w.cli(['state', 'bogus']).stderr, /discard-round/);
});

// A newer pipeline's triage comment decodes to no state here; that must not read as "round not published" (the round would be discarded from the local copy).
test('state discard-round / state show: a newer-format triage comment refuses the discard and serves the local state as local-unverified', (t) => {
  const { w, published } = publishedWorld(t);
  const script = JSON.parse(readFileSync(join(w.fake.dir, 'script.json'), 'utf8'));
  w.fake.setScript([...COMMENTS(mine({ ...published, version: 99 })), ...script]);
  const d = w.cli(['state', 'discard-round', '--round', '1', '--pr', '7']);
  assertExit(d, 2);
  assert.equal(d.json.error, 'history-unreadable');
  assert.match(d.json.message, /pipeline update/);
  assert.equal(w.state().rounds.length, 1);
  assert.deepEqual(staleDirs(w), []);
  const show = w.cli(['state', 'show', '--pr', '7']);
  assertExit(show, 0, show.stderr + show.stdout);
  assert.equal(show.json.source, 'local-unverified');
  assert.match(show.json.warnings.join(' '), /pipeline update/);
});

test('state discard-round: a gh outage is exit 3 and nothing is moved', (t) => {
  const { w } = publishedWorld(t);
  editState(w, (s) => {
    s.rounds.push({ n: 2, fromHead: s.rounds[0].toHead, toHead: 'f'.repeat(40), contentHashAtToHead: 'h2', items: [] });
  });
  w.fake.setScript([{ match: '.', code: 1, stderr: 'HTTP 502' }]);
  assertExit(w.cli(['state', 'discard-round', '--round', '2', '--pr', '7']), 3);
  assert.equal(w.state().rounds.length, 2);
  assert.deepEqual(staleDirs(w), []);
});

// ---- followupsPending (state outcome) ----------------------------------------------------------------------

test('state outcome: followupsPending is true until every ready FOLLOW-UP has an issue; a held one never counts', (t) => {
  const url = 'https://github.com/acme/widgets/issues/11';
  const w = world(t, { gh: [...GH, ...NO_ISSUES, { match: '^api -X POST repos/acme/widgets/issues ', stdoutJson: { number: 11, html_url: url } }] });
  assertExit(w.codex(1, findingsOf([], [], [finding({ title: 'Idea', category: 'other', testable: false })])), 0);
  assert.equal(w.cli(['state', 'outcome']).json.followupsPending, false, 'undecided is not a pending follow-up');
  assertExit(w.judge(1, { 'R1-W1': ['FOLLOW-UP'] }), 0);
  assert.equal(w.cli(['state', 'outcome']).json.followupsPending, true);
  assertExit(w.cli(['followups', 'create', '--round', '1']), 0);
  assert.equal(w.cli(['state', 'outcome']).json.followupsPending, false);
  editState(w, (s) => { s.rounds[0].items[0].followupIssue = null; s.rounds[0].items[0].final.needsHuman = true; });
  assert.equal(w.cli(['state', 'outcome']).json.followupsPending, false, 'needsHuman follow-ups are held, not pending');
});

test('followups create: no marker issue yet creates one whose body starts with the marker', (t) => {
  const w = followupWorld(t, [issue(3, 'unrelated suggestion')]);
  const r = w.cli(['followups', 'create', '--round', '1']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.created.length, 1);
  assert.deepEqual([r.json.reused, r.json.duplicates], [[], []]);
  assert.ok(JSON.parse(posts(w)[0].stdin).body.startsWith(`${FP_ISSUE(w)}\n`));
});

test('followups create: one existing issue of ours with the marker is reused, even when it is closed', (t) => {
  const w0 = followupWorld(t, []);
  const marker = FP_ISSUE(w0);
  for (const state of ['open', 'closed']) {
    const w = followupWorld(t, [issue(41, `${marker}\nbody`, { state })]);
    // same fingerprint in a fresh world: the finding text is identical
    const r = w.cli(['followups', 'create', '--round', '1']);
    assertExit(r, 0, r.stderr + r.stdout);
    assert.deepEqual(r.json.created, [], state);
    assert.deepEqual(r.json.reused, [{ id: 'R1-W1', number: 41, url: 'https://github.com/acme/widgets/issues/41' }]);
    assert.equal(posts(w).length, 0);
    assert.equal(w.item('R1-W1').followupIssue, 'https://github.com/acme/widgets/issues/41', 'recorded like a created one');
    assert.equal(w.cli(['state', 'outcome']).json.followupsPending, false);
  }
});

test('followups create: several marker issues: the lowest number is canonical, the rest are listed and never closed', (t) => {
  const marker = FP_ISSUE(followupWorld(t, []));
  const w = followupWorld(t, [issue(60, `${marker}\nb`), issue(44, `${marker}\na`, { state: 'closed' }), issue(52, `${marker}\nc`)]);
  const r = w.cli(['followups', 'create', '--round', '1']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.reused[0].number, 44);
  assert.deepEqual(r.json.duplicates, [{
    id: 'R1-W1', canonical: 'https://github.com/acme/widgets/issues/44',
    others: ['https://github.com/acme/widgets/issues/52', 'https://github.com/acme/widgets/issues/60'],
  }]);
  assert.equal(posts(w).length, 0);
  assert.ok(!w.fake.lines().some((l) => /PATCH|close|--state/.test(l) && /issues\/(44|52|60)/.test(l)), 'duplicates are never touched');
});

test('followups create: an issue the owner PROMOTED (agent-suggestion -> agent-build) or relabelled is still found by its marker, never filed twice', (t) => {
  const marker = FP_ISSUE(followupWorld(t, []));
  const gh = [...GH, { match: '^api user', stdout: 'me\n' },
    // GitHub: the label query no longer lists the promoted issue; the creator query does.
    { match: '^api repos/acme/widgets/issues\\?labels=agent-suggestion&state=all&per_page=30 --paginate', stdoutJson: [] },
    { match: ISSUES_URL, stdoutJson: [issue(90, `${marker}\nbody`, { labels: [{ name: 'agent-build' }] })] },
    { match: '^api -X POST repos/acme/widgets/issues ', stdoutJson: { number: 91, html_url: 'https://github.com/acme/widgets/issues/91' } }];
  const w = world(t, { gh });
  assertExit(w.codex(1, findingsOf([], [], [finding({ title: 'Idea', category: 'other', testable: false })])), 0);
  assertExit(w.judge(1, { 'R1-W1': ['FOLLOW-UP'] }), 0);
  const r = w.cli(['followups', 'create', '--round', '1']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual(r.json.created, []);
  assert.deepEqual(r.json.reused, [{ id: 'R1-W1', number: 90, url: 'https://github.com/acme/widgets/issues/90' }]);
  assert.equal(posts(w).length, 0);
  assert.ok(w.fake.lines().some((l) => /issues\?creator=me/.test(l)));
});

test('followups create: a marker quoted later in a body, in a foreign-author issue, or for another PR or fingerprint is ignored', (t) => {
  const marker = FP_ISSUE(followupWorld(t, []));
  const w = followupWorld(t, [
    issue(70, `see also\n${marker}`),
    issue(71, `${marker}\nforged`, { user: { login: 'mallory' } }),
    issue(72, marker.replace('pr=7', 'pr=8')),
    issue(73, marker.replace('fp=', 'fp=zz')),
    issue(74, `${marker.replace(' -->', 'x -->')}`),
    { number: 75, html_url: 'https://github.com/acme/widgets/pull/75', state: 'open', body: marker, user: { login: 'me' }, pull_request: {} },
  ]);
  const r = w.cli(['followups', 'create', '--round', '1']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.created.length, 1);
  assert.deepEqual([r.json.reused, r.json.duplicates], [[], []]);
});

test('followups create crash scenarios: re-running creates only the missing issues', (t) => {
  const gh = (issues, post) => [...GH, { match: '^api user', stdout: 'me\n' }, { match: ISSUES_URL, stdoutJson: issues }, { match: '^api -X POST repos/acme/widgets/issues ', ...post }];
  const w = world(t, { gh: gh([], { code: 1, stderr: 'HTTP 502' }) });
  assertExit(w.codex(1, findingsOf([], [], [
    finding({ title: 'Idea one', category: 'other', testable: false, line: 20 }),
    finding({ title: 'Idea two', category: 'other', testable: false, line: 21 }),
  ])), 0);
  assertExit(w.judge(1, { 'R1-W1': ['FOLLOW-UP'], 'R1-W2': ['FOLLOW-UP'] }), 0);
  const script = (...args) => w.fake.setScript((() => {
    const base = JSON.parse(readFileSync(join(w.fake.dir, 'script.json'), 'utf8')).filter((e) => !e.match.startsWith('^api user') && e.match !== ISSUES_URL && !e.match.startsWith('^api -X POST'));
    return [...base, ...gh(...args).slice(GH.length)];
  })());

  // 1) the very first create fails: nothing is recorded, nothing exists
  assertExit(w.cli(['followups', 'create', '--round', '1']), 3);
  assert.equal(w.item('R1-W1').followupIssue ?? null, null);

  // 2) issue 81 was made by a run that died before its URL reached the state: only the marker ties it to R1-W1
  const marker = `<!-- claude-pipeline:followup pr=7 fp=${w.item('R1-W1').fingerprint} -->`;
  script([issue(81, `${marker}\nx`)], { stdoutJson: { number: 82, html_url: 'https://github.com/acme/widgets/issues/82' } });
  const before = posts(w).length;
  const r = w.cli(['followups', 'create', '--round', '1']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual(r.json.reused.map((x) => x.id), ['R1-W1']);
  assert.deepEqual(r.json.created.map((x) => x.id), ['R1-W2'], 'only the missing one is created');
  assert.equal(posts(w).length - before, 1);
  assert.equal(w.item('R1-W1').followupIssue, 'https://github.com/acme/widgets/issues/81');
  assert.equal(w.item('R1-W2').followupIssue, 'https://github.com/acme/widgets/issues/82');

  // 3) state published, then the first issue created and the second create dies: the recorded one is not filed twice
  editState(w, (st) => { st.rounds[0].items.find((i) => i.id === 'R1-W2').followupIssue = null; });
  script([issue(81, `${marker}\nx`)], { code: 1, stderr: 'HTTP 502' });
  assertExit(w.cli(['followups', 'create', '--round', '1']), 3);
  assert.equal(w.item('R1-W1').followupIssue, 'https://github.com/acme/widgets/issues/81', 'the first stays recorded');
  assert.equal(w.item('R1-W2').followupIssue ?? null, null);

  // 4) everything filed: a further run is a no-op
  script([], { stdoutJson: { number: 83, html_url: 'https://github.com/acme/widgets/issues/83' } });
  const done = w.cli(['followups', 'create', '--round', '1']);
  assert.deepEqual(done.json.created.map((x) => x.id), ['R1-W2']);
  const again = w.cli(['followups', 'create', '--round', '1']);
  assert.deepEqual([again.json.created, again.json.reused, again.json.skipped.sort()], [[], [], ['R1-W1', 'R1-W2']]);
});

test('followups create: an issue-list outage is exit 3 and nothing is filed', (t) => {
  const w = world(t, { gh: [...GH, { match: '^api user', stdout: 'me\n' }, { match: ISSUES_URL, code: 1, stderr: 'HTTP 502' }, { match: '^api -X POST repos/acme/widgets/issues ', stdoutJson: { number: 1, html_url: 'https://x.test/1' } }] });
  assertExit(w.codex(1, findingsOf([], [], [finding({ title: 'Idea', category: 'other', testable: false })])), 0);
  assertExit(w.judge(1, { 'R1-W1': ['FOLLOW-UP'] }), 0);
  assertExit(w.cli(['followups', 'create', '--round', '1']), 3);
  assert.equal(posts(w).length, 0, 'never create blind when the duplicate check could not run');
});

test('followups create: the creator scan asks for 100 per page and only issues updated since the PR was created, minus an hour (UTC)', (t) => {
  const w = sinceWorld(t, '2026-11-10T09:30:00+08:00', []);
  const r = w.cli(['followups', 'create', '--round', '1']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual(scanLines(w), ['api repos/acme/widgets/issues?creator=me&state=all&per_page=100&since=2026-11-10T00%3A30%3A00Z --paginate']);
  assert.ok(w.fake.lines().includes('pr view 7 --json createdAt'), 'one call reads the PR creation time');
  assert.equal(r.json.created.length, 1);
});

test('followups create: a missing, unparsable, future or unreadable createdAt means the full scan (no since), never a failure', (t) => {
  const future = new Date(Date.now() + 86_400_000).toISOString();
  for (const createdAt of [undefined, null, '', 'not a date', '2', '2026-11-10', 12345, future]) {
    const w = sinceWorld(t, createdAt, []);
    const r = w.cli(['followups', 'create', '--round', '1']);
    assertExit(r, 0, String(createdAt) + r.stderr + r.stdout);
    assert.deepEqual(scanLines(w), ['api repos/acme/widgets/issues?creator=me&state=all&per_page=100 --paginate'], String(createdAt));
    assert.equal(r.json.created.length, 1);
  }
  // the lookup itself failing
  const w = world(t, { gh: [{ match: '^pr view 7 --json createdAt', code: 1, stderr: 'HTTP 502' }, ...GH, { match: '^api user', stdout: 'me\n' },
    { match: ISSUES_URL, stdoutJson: [] }, { match: '^api -X POST repos/acme/widgets/issues ', stdoutJson: { number: 50, html_url: 'https://github.com/acme/widgets/issues/50' } }] });
  assertExit(w.codex(1, findingsOf([], [], [finding({ title: 'Idea', category: 'other', testable: false })])), 0);
  assertExit(w.judge(1, { 'R1-W1': ['FOLLOW-UP'] }), 0);
  const r = w.cli(['followups', 'create', '--round', '1']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual(scanLines(w), ['api repos/acme/widgets/issues?creator=me&state=all&per_page=100 --paginate']);
  assert.equal(r.json.created.length, 1);
});

test('followups create: with a since bound an earlier issue for this PR (even promoted and closed) is still found, never filed twice', (t) => {
  const marker = FP_ISSUE(followupWorld(t, []));
  const w = sinceWorld(t, '2026-11-10T09:30:00Z', [issue(90, `${marker}\nbody`, { state: 'closed', labels: [{ name: 'agent-build' }] })]);
  const r = w.cli(['followups', 'create', '--round', '1']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual(r.json.reused, [{ id: 'R1-W1', number: 90, url: 'https://github.com/acme/widgets/issues/90' }]);
  assert.equal(posts(w).length, 0);
  assert.match(scanLines(w)[0], /&since=2026-11-10T08%3A30%3A00Z /);
});

test('followups create: a page failing mid-pagination is the existing exit 3 and nothing is filed', (t) => {
  const w = sinceWorld(t, '2026-11-10T09:30:00Z', null, { issuesReply: { code: 1, stdout: '[{"number":1,"user":{"login":"me"},"body":"x"}]', stderr: 'gh: HTTP 502 (page 3)' } });
  const r = w.cli(['followups', 'create', '--round', '1']);
  assertExit(r, 3, r.stderr + r.stdout);
  assert.match(r.stderr + r.stdout, /HTTP 502/);
  assert.equal(posts(w).length, 0, 'never create blind when the duplicate check could not finish');
  assert.equal(w.item('R1-W1').followupIssue ?? null, null);
});

// ---- model proofs travel in the state ---------------------------------------------------------------------

test('summary reads model proofs from the state rounds, the files only as a fallback', (t) => {
  const url = 'https://github.com/acme/widgets/pull/7#issuecomment-5';
  const w = ownerWorld(t, {
    gh: [...GH, { match: '^api user', stdout: 'me\n' }, { match: 'issues/7/comments --paginate', stdoutJson: [] },
      { match: '^api -X POST repos/acme/widgets/issues/7/comments ', stdoutJson: { id: 5, html_url: url } }],
  });
  assertExit(w.codex(1, findingsOf()), 0);
  editState(w, (s) => { s.rounds[0].modelProof = { transcript: '/t/from-state.jsonl', models: { 'claude-fable-5-1': 2 }, effort: 'high' }; });
  const body = () => JSON.parse(w.fake.calls().filter((c) => c.argv.join(' ').includes('/comments ')).at(-1).stdin).body;
  assertExit(w.cli(['summary', '--pr', '7', '--outcome', 'merged']), 0);
  assert.ok(body().includes('from-state.jsonl'), 'proof comes from the state although no model-proof.json exists');

  // a state without the proof falls back to the file
  editState(w, (s) => { delete s.rounds[0].modelProof; });
  writeFileSync(w.roundFile(1, 'model-proof.json'), JSON.stringify({ ok: true, transcript: '/t/from-file.jsonl', models: { 'claude-fable-5-1': 1 }, efforts: { high: 1 } }));
  assertExit(w.cli(['summary', '--pr', '7', '--outcome', 'merged']), 0);
  assert.ok(body().includes('from-file.jsonl'));
});

test('triage owner-ruling: refused in label mode, for an item that needs no human, a missing item, an empty quote or reason', (t) => {
  const label = world(t);
  assertExit(label.codex(1, findingsOf([finding()])), 0);
  waitingForHuman(label, { 'R1-B1': 'FOLLOW-UP' });
  const refused = label.cli(rule('R1-B1', 'FOLLOW-UP'));
  assertExit(refused, 1);
  assert.match(refused.json.reason, /owner_approval: chat/);
  assert.equal(label.item('R1-B1').final.by, 'arbiter', 'state untouched');

  const w = world(t, { yml: CHAT_YML });
  assertExit(w.codex(1, findingsOf([finding()], [finding({ title: 'Rename helper', file: 'src/b.js', line: 3 })])), 0);
  assertExit(w.judge(1, { 'R1-B1': ['ACCEPT'], 'R1-S1': ['ACCEPT'] }), 0);
  waitingForHuman(w, { 'R1-B1': 'FOLLOW-UP' });
  const settledItem = w.cli(rule('R1-S1', 'ACCEPT'));
  assertExit(settledItem, 1);
  assert.match(settledItem.json.reason, /does not need a human/);
  assert.equal(w.item('R1-S1').final.by, 'judge');
  const missing = w.cli(rule('R1-X9', 'REJECT'));
  assertExit(missing, 1);
  assert.match(missing.json.reason, /no item R1-X9 in round 1/);
  assertExit(w.cli(rule('R1-B1', 'FOLLOW-UP', { quote: '   ' })), 1);
  assertExit(w.cli(rule('R1-B1', 'FOLLOW-UP', { reason: ' ' })), 1);
  assertExit(w.cli(rule('R1-B1', 'FOLLOW-UP', { quote: 'x'.repeat(1001) })), 1);
  assertExit(w.cli(rule('R1-B1', 'FOLLOW-UP', { extra: ['--pr', '99'] })), 1, 'a PR number that is not the review state\'s');
  assertExit(w.cli(rule('R1-B1', 'MAYBE')), 2);
  assertExit(w.cli(['triage', 'owner-ruling', '--round', '1', '--id', 'R1-B1', '--decision', 'REJECT', '--reason', 'r']), 2, 'no --owner-quote at all');
  assertExit(w.cli(['triage', 'owner-ruling', '--round', '9', '--id', 'R1-B1', '--decision', 'REJECT', '--reason', 'r', '--owner-quote', 'q']), 2);
  assert.equal(w.item('R1-B1').final.by, 'arbiter', 'every refusal left the state untouched');
});

// Phase 3b: --owner-quote was the agent's own word. It now has to come from the owner's prompt that answered a ruling request for this
// repository, PR and item (the owner-go recorder); white space and case aside, the words must be in it.
test('triage owner-ruling: needs the owner\'s recorded answer to a ruling request for this repository, PR and item, holding the quote', (t) => {
  const w = ownerWorld(t, { yml: CHAT_YML });
  assertExit(w.codex(1, findingsOf([finding()])), 0);
  waitingForHuman(w, { 'R1-B1': 'FOLLOW-UP' });
  const none = w.cli(rule('R1-B1', 'FOLLOW-UP'));
  assertExit(none, 1);
  assert.match(none.json.reason, new RegExp(`no owner ruling is recorded for ${w.slug.replace('/', '\\/')} #7 R1-B1 .*triage ruling-request --pr 7 --ids R1-B1`));
  ownerAnswers(w, t, { pr: 8 }); // another PR
  ownerAnswers(w, t, { repo: 'acme/gadgets' }); // another repository
  ownerAnswers(w, t, { ids: ['R1-S1'] }); // another item
  ownerAnswers(w, t, { prompt: 'No, keep it in this PR.' }); // other words
  ownerAnswers(w, t, { prompt: `ok. ${QUOTE} Thanks` }); // (security review of f17b251) the quote is only a part of the answer
  assertExit(w.cli(rule('R1-B1', 'FOLLOW-UP')), 1);
  // the whole answer must name the decision: an answer that says another one, or none, records nothing
  ownerAnswers(w, t, { prompt: REJECT_QUOTE });
  assertExit(w.cli(rule('R1-B1', 'FOLLOW-UP', { quote: REJECT_QUOTE })), 1, 'the answer says reject');
  ownerAnswers(w, t, { prompt: 'ok' });
  for (const d of ['ACCEPT', 'FOLLOW-UP', 'REJECT']) assertExit(w.cli(rule('R1-B1', d, { quote: 'ok' })), 1, `"ok" says no ${d}`);
  // an answer naming several decisions must name the item it is read for
  const both = 'Accept the first one and reject the other.';
  ownerAnswers(w, t, { prompt: both });
  assertExit(w.cli(rule('R1-B1', 'ACCEPT', { quote: both })), 1, 'which item is accepted is not said');
  // (security review of ff8090f) a negated decision decides nothing; nor does a bare answer when several items were asked
  const negated = "Don't accept it, file a follow-up.";
  ownerAnswers(w, t, { prompt: negated });
  for (const d of ['ACCEPT', 'FOLLOW-UP']) assertExit(w.cli(rule('R1-B1', d, { quote: negated })), 1, `negated: no ${d}`);
  const loose = 'Follow-up for this one.';
  ownerAnswers(w, t, { prompt: loose, ids: ['R1-B1', 'R1-S1'] });
  assertExit(w.cli(rule('R1-B1', 'FOLLOW-UP', { quote: loose })), 1, 'two items asked: the answer must name R1-B1');
  assert.equal(ownerRules(t, QUOTE, `${rulingRequest(7, ['R1-B1'])}\nmore text after the line`), null, 'only a reply that ENDS with the line asks');
  assert.equal(ownerRules(t, QUOTE, rulingRequest(7, ['R1-B1', 'not-an-id'])), null, 'a line naming something that is no item id asks nothing');
  assertExit(w.cli(rule('R1-B1', 'FOLLOW-UP')), 1);
  assert.equal(w.item('R1-B1').final.by, 'arbiter', 'state untouched');
  ownerAnswers(w, t, { prompt: `\n  ${QUOTE.toUpperCase()}  ` }); // (white space and case aside)
  assertExit(w.cli(rule('R1-B1', 'FOLLOW-UP')), 0);
  assert.equal(w.item('R1-B1').final.ownerQuote, QUOTE);
});

test('triage owner-ruling: an answer whose prompt is synthetic or missing from the transcript is refused with the provenance reason (#128)', (t) => {
  for (const after of [{ promptSource: 'system', isMeta: true, entrypoint: 'cli' }, { origin: { kind: 'peer' }, promptSource: 'system', entrypoint: 'cli' }, 'missing']) {
    const w = ownerWorld(t, { yml: CHAT_YML });
    assertExit(w.codex(1, findingsOf([finding()])), 0);
    waitingForHuman(w, { 'R1-B1': 'FOLLOW-UP' });
    ownerRules(t, QUOTE, rulingRequest(7, ['R1-B1'], w.slug, askedContent(w, ['R1-B1'])), undefined, after);
    const r = w.cli(rule('R1-B1', 'FOLLOW-UP'));
    assertExit(r, 1);
    assert.match(r.json.reason, /an answer is recorded for acme\/widgets-[0-9a-f-]+ #7 R1-B1, but it cannot be confirmed as typed by the owner[\s\S]*ask again[\s\S]*ask the owner to answer again/);
    assert.match(r.json.reason, /or was typed while the agent was still working[\s\S]*FRESH closing line[\s\S]*ruling-request/, '#191: a queued answer is named, with what to do');
    assert.equal(w.item('R1-B1').final.by, 'arbiter', 'state untouched');
  }
});

// R2-F3: the same for a ruling answer whose transcript is in a config dir the process does not know.
test('triage owner-ruling: an answer whose transcript is outside a .claude* folder under the home says so in the refusal (R2-F3); a missing one does not', (t) => {
  const refusal = (after) => {
    const w = ownerWorld(t, { yml: CHAT_YML });
    assertExit(w.codex(1, findingsOf([finding()])), 0);
    waitingForHuman(w, { 'R1-B1': 'FOLLOW-UP' });
    ownerRules(t, QUOTE, rulingRequest(7, ['R1-B1'], w.slug, askedContent(w, ['R1-B1'])), undefined, after);
    const r = w.cli(rule('R1-B1', 'FOLLOW-UP'));
    assertExit(r, 1);
    return r.json.reason;
  };
  // The missing case first: both write a record for the same repo, PR, item and answer (records stay until the test ends), and the hint looks at every matching one.
  const missing = refusal('missing');
  assert.match(missing, /cannot be confirmed as typed by the owner/);
  assert.doesNotMatch(missing, /CLAUDE_CONFIG_DIR/);
  const elsewhere = refusal('elsewhere');
  assert.match(elsewhere, /cannot be confirmed as typed by the owner[\s\S]*\.claude\* folder directly under the (?:account's )?home/);
  assert.doesNotMatch(elsewhere, /run this command with CLAUDE_CONFIG_DIR/);
});

test('triage owner-ruling: one world\'s recorded answer never satisfies another world (#122: a repository name per test)', (t) => {
  // Two worlds built from identical fixtures: the same needsHuman state and the same content digests, so the only thing telling their
  // records apart is the repository name. The records live in the account's real owner-go folder, shared by every test and every
  // concurrent run of the suite.
  const build = () => {
    const w = ownerWorld(t, { yml: CHAT_YML });
    assertExit(w.codex(1, findingsOf([finding()])), 0);
    waitingForHuman(w, { 'R1-B1': 'FOLLOW-UP' });
    return w;
  };
  const a = build();
  const b = build();
  ownerAnswers(a, t);
  assertExit(a.cli(rule('R1-B1', 'FOLLOW-UP')), 0, 'the world that was answered');
  assertExit(b.cli(rule('R1-B1', 'FOLLOW-UP')), 1, 'another world must not see that answer');
});

// ---- #110: a ruling request is bound to the finding text, not just the item id ----------------------------

test('triage ruling-request: prints the ruling line with the content digest of exactly the asked ids', (t) => {
  const w = ownerWorld(t, { yml: CHAT_YML });
  assertExit(w.codex(1, findingsOf([finding()], [finding({ title: 'Rename helper', file: 'src/b.js', line: 3 })])), 0);
  waitingForHuman(w, { 'R1-B1': 'FOLLOW-UP', 'R1-S1': 'REJECT' });
  const items = w.state().rounds[0].items;
  const ask = (...ids) => w.cli(['triage', 'ruling-request', '--pr', '7', '--ids', ids.join(',')]);
  const both = ask('R1-B1', 'R1-S1');
  assertExit(both, 0, both.stderr + both.stdout);
  assert.deepEqual(both.json, { ok: true, line: `⚖️ Owner ruling needed #7: R1-B1, R1-S1 · content ${rulingContentDigest(items)} · repo ${w.slug}`, recommend: null, why: null, dialogVariant: 'ruling-v1' });
  assert.equal(ask('R1-B1').json.line, `⚖️ Owner ruling needed #7: R1-B1 · content ${rulingContentDigest([items[0]])} · repo ${w.slug}`, 'only the asked ids');
  assert.notEqual(ask('R1-B1').json.line.split(' · ')[1], ask('R1-S1').json.line.split(' · ')[1]);
  assert.equal(ask('R1-B1', 'r1-b1').json.line, ask('R1-B1').json.line, 'ids differing only in case are one id');
  assertExit(ask('R1-B1', 'R1-X9'), 1, 'an unknown id');
  assert.match(ask('R1-B1', 'R1-X9').json.reason, /R1-X9/);
  assertExit(w.cli(['triage', 'ruling-request', '--pr', '99', '--ids', 'R1-B1']), 1, 'a PR that is not the review state\'s');
  assertExit(w.cli(['triage', 'ruling-request', '--pr', '7']), 2, 'no --ids');
  assertExit(w.cli(['triage', 'ruling-request', '--ids', 'R1-B1']), 2, 'no --pr');
  assertExit(w.cli(['triage', 'ruling-request', '--pr', '7', '--ids', ' , ']), 2, 'no id at all');
  // what it prints is what the recorder reads back
  assert.equal(ownerRules(t, 'R1-B1: reject', `Waiting.\n${both.json.line}`).content, rulingContentDigest(items));
});
for (const [what, change, id] of CHANGES) {
  test(`triage owner-ruling: refused when only ${what} of ${id} changed after the owner was asked (#110)`, (t) => {
    const w = ownerWorld(t, { yml: CHAT_YML });
    assertExit(w.codex(1, findingsOf([finding()])), 0);
    addFableItem(w);
    waitingForHuman(w, { 'R1-B1': 'FOLLOW-UP', 'R1-F1': 'ACCEPT' });
    const quote = `${id}: follow-up`;
    ownerAnswers(w, t, { prompt: quote, ids: [id] });
    editState(w, (s) => change(s.rounds[0].items.find((i) => i.id === id)));
    const before = w.stateText();
    const r = w.cli(rule(id, 'FOLLOW-UP', { quote }));
    assertExit(r, 1, r.stdout);
    assert.match(r.json.reason, /changed since the owner was asked/);
    assert.match(r.json.reason, /ruling-request/);
    assert.equal(w.stateText(), before, 'state untouched');
  });
}

test('triage owner-ruling: unchanged content is accepted (#110)', (t) => {
  const w = ownerWorld(t, { yml: CHAT_YML });
  assertExit(w.codex(1, findingsOf([finding()])), 0);
  addFableItem(w);
  waitingForHuman(w, { 'R1-B1': 'FOLLOW-UP', 'R1-F1': 'ACCEPT' });
  ownerAnswers(w, t, { prompt: 'R1-B1: follow-up', ids: ['R1-B1'] });
  ownerAnswers(w, t, { prompt: 'R1-F1: accept', ids: ['R1-F1'] });
  assertExit(w.cli(rule('R1-B1', 'FOLLOW-UP', { quote: 'R1-B1: follow-up' })), 0);
  assertExit(w.cli(rule('R1-F1', 'ACCEPT', { quote: 'R1-F1: accept' })), 0);
});

test('triage owner-ruling: one changed item of a two-item request refuses the ruling on the other too; applying one first does not (#110)', (t) => {
  const asked = ['R1-B1', 'R1-S1'];
  const answer = 'R1-B1: follow-up; R1-S1: reject.';
  const make = () => {
    const w = ownerWorld(t, { yml: CHAT_YML });
    assertExit(w.codex(1, findingsOf([finding()], [finding({ title: 'Rename helper', file: 'src/b.js', line: 3 })])), 0);
    waitingForHuman(w, { 'R1-B1': 'FOLLOW-UP', 'R1-S1': 'REJECT' });
    ownerAnswers(w, t, { prompt: answer, ids: asked });
    return w;
  };
  const changed = make();
  editState(changed, (s) => { s.rounds[0].items[1].detail = 'the other finding now says something else'; });
  const r = changed.cli(rule('R1-B1', 'FOLLOW-UP', { quote: answer }));
  assertExit(r, 1, r.stdout);
  assert.match(r.json.reason, /changed since the owner was asked/);
  assertExit(changed.cli(rule('R1-S1', 'REJECT', { quote: answer })), 1);
  // (c2) both answered, nothing changed: the first ruling is recorded into the state and the second is still accepted
  const fine = make();
  assertExit(fine.cli(rule('R1-B1', 'FOLLOW-UP', { quote: answer })), 0);
  assert.equal(fine.item('R1-B1').final.by, 'owner');
  assertExit(fine.cli(rule('R1-S1', 'REJECT', { quote: answer })), 0);
});

test('triage owner-ruling: a request whose item is gone is refused (#110)', (t) => {
  const w = ownerWorld(t, { yml: CHAT_YML });
  assertExit(w.codex(1, findingsOf([finding()], [finding({ title: 'Rename helper', file: 'src/b.js', line: 3 })])), 0);
  waitingForHuman(w, { 'R1-B1': 'FOLLOW-UP' });
  const answer = 'R1-B1: follow-up';
  ownerAnswers(w, t, { prompt: answer, ids: ['R1-B1', 'R1-S1'] });
  editState(w, (s) => { s.rounds[0].items = s.rounds[0].items.filter((i) => i.id !== 'R1-S1'); });
  const r = w.cli(rule('R1-B1', 'FOLLOW-UP', { quote: answer }));
  assertExit(r, 1, r.stdout);
  assert.match(r.json.reason, /changed since the owner was asked/);
});

test('triage owner-ruling: a ruling asked in the old line shape (no content) approves nothing (#110)', (t) => {
  const w = ownerWorld(t, { yml: CHAT_YML });
  assertExit(w.codex(1, findingsOf([finding()])), 0);
  waitingForHuman(w, { 'R1-B1': 'FOLLOW-UP' });
  assert.equal(ownerAnswers(w, t, { content: null }).content, null);
  const r = w.cli(rule('R1-B1', 'FOLLOW-UP'));
  assertExit(r, 1, r.stdout);
  assert.match(r.json.reason, /no content digest|old line/);
  assert.match(r.json.reason, /ruling-request/);
  assert.equal(w.item('R1-B1').final.by, 'arbiter', 'state untouched');
});

test('triage owner-ruling: an answer that rules on several items names each one it is read for', (t) => {
  const w = ownerWorld(t, { yml: CHAT_YML });
  assertExit(w.codex(1, findingsOf([finding()], [finding({ title: 'Rename helper', file: 'src/b.js', line: 3 })])), 0);
  waitingForHuman(w, { 'R1-B1': 'FOLLOW-UP', 'R1-S1': 'REJECT' });
  const both = 'R1-B1: follow-up; R1-S1: reject.';
  ownerAnswers(w, t, { prompt: both, ids: ['R1-B1', 'R1-S1'] });
  assertExit(w.cli(rule('R1-S1', 'FOLLOW-UP', { quote: both })), 1, 'the decision written for the other item');
  assertExit(w.cli(rule('R1-B1', 'FOLLOW-UP', { quote: both })), 0);
  assertExit(w.cli(rule('R1-S1', 'REJECT', { quote: both })), 0);
  assert.deepEqual(w.cli(['state', 'outcome']).json.needsHuman, []);
});

test('triage owner-ruling: records the owner ruling, keeps the overruled final, and clears the needs-human block', (t) => {
  const w = ownerWorld(t, { yml: CHAT_YML });
  assertExit(w.codex(1, findingsOf([finding()], [finding({ title: 'Rename helper', file: 'src/b.js', line: 3 })])), 0);
  waitingForHuman(w, { 'R1-B1': 'FOLLOW-UP', 'R1-S1': 'REJECT' });
  ownerAnswers(w, t);
  assert.deepEqual(w.cli(['state', 'outcome']).json.needsHuman, ['R1-B1', 'R1-S1']);

  const r = w.cli(rule('R1-B1', 'FOLLOW-UP', { extra: ['--pr', '7'] }));
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.ok, true);
  const final = w.item('R1-B1').final;
  assert.deepEqual({ ...final, ruledAt: undefined }, {
    decision: 'FOLLOW-UP', by: 'owner', needsHuman: false, reason: 'owner confirmed in chat', ownerQuote: QUOTE, ruledAt: undefined,
    overruled: { decision: 'FOLLOW-UP', by: 'arbiter', needsHuman: true, reason: 'model-proof failed' },
  });
  assert.ok(!Number.isNaN(Date.parse(final.ruledAt)));
  assert.deepEqual(r.json.final, final);
  assert.equal(w.cli(['state', 'outcome']).json.clean, false, 'one item still waits');
  ownerAnswers(w, t, { prompt: REJECT_QUOTE, ids: ['R1-S1'] });
  assertExit(w.cli(rule('R1-S1', 'REJECT', { quote: REJECT_QUOTE })), 0);
  const outcome = w.cli(['state', 'outcome']).json;
  assert.deepEqual(outcome.needsHuman, []);
  assert.equal(outcome.clean, true, JSON.stringify(outcome));
  ownerAnswers(w, t, { prompt: ACCEPT_QUOTE, ids: ['R1-S1'] });
  assertExit(w.cli(rule('R1-S1', 'ACCEPT', { quote: ACCEPT_QUOTE })), 1, 'an item the owner already ruled is settled: no second ruling');
});

test('triage owner-ruling: ACCEPT stays unclean until the fix is built and a later round reviews it', (t) => {
  const w = ownerWorld(t, { yml: CHAT_YML });
  assertExit(w.codex(1, findingsOf([finding()])), 0);
  waitingForHuman(w, { 'R1-B1': 'REJECT' });
  ownerAnswers(w, t, { prompt: ACCEPT_QUOTE });
  assertExit(w.cli(rule('R1-B1', 'ACCEPT', { quote: ACCEPT_QUOTE })), 0);
  assert.notEqual(w.item('R1-B1').implemented, true, 'ACCEPT still has to be built');
  const open = w.cli(['state', 'outcome']).json;
  assert.equal(open.clean, false);
  assert.deepEqual(open.unimplemented, ['R1-B1']);
  w.repo.write('src/a.js', aFile(true).replace('compute(x.y)', 'compute(x?.y)'));
  const head2 = w.repo.commit('fix');
  assertExit(w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']), 0);
  assert.equal(w.cli(['state', 'outcome']).json.clean, false, 'built but not yet re-reviewed');
  assertExit(w.codex(2, findingsOf(), { from: w.head, to: head2 }), 0);
  assert.equal(w.cli(['state', 'outcome']).json.clean, true);
});

test('triage owner-ruling: works on a published round, and a state rebuilt from the triage comment keeps the ruling', (t) => {
  const w0 = ownerWorld(t, { yml: CHAT_YML });
  assertExit(w0.codex(1, findingsOf([finding()])), 0);
  waitingForHuman(w0, { 'R1-B1': 'FOLLOW-UP' });
  ownerAnswers(w0, t);
  assertExit(w0.cli(rule('R1-B1', 'FOLLOW-UP')), 0);
  const ruled = w0.state();
  const gh = [
    ...GH,
    { match: '^api user', stdout: 'me\n' },
    { match: 'issues/7/comments --paginate', stdoutJson: [{ id: 9, user: { login: 'me' }, body: triageComment(ruled) }] },
    { match: '^api -X PATCH repos/acme/widgets/issues/comments/9 ', stdoutJson: { id: 9, html_url: 'u9' } }, // review-complete publishes the state first
  ];
  const w = ownerWorld(t, { gh, yml: CHAT_YML });
  const shown = w.cli(['state', 'show', '--pr', '7']);
  assertExit(shown, 0, shown.stderr + shown.stdout);
  assert.equal(shown.json.recovered, true);
  assert.deepEqual(w.item('R1-B1').final, ruled.rounds[0].items[0].final);
  assert.ok(triageComment(w.state()).includes(`owner (chat): ${QUOTE}`));
});

// ---- the review skill's loop, end to end (skills/review/SKILL.md section 2 and 3): the commands in the order it lists them ------

test('review skill scenario: Codex ACCEPT item, fixed, state mark-implemented, clean round 2, review-complete succeeds (and is refused without mark-implemented)', (t) => {
  for (const marked of [false, true]) {
    const w = world(t, { gh: [...GH, REMOVE_LABEL, ...REVIEW_COMMENT] });
    assertExit(w.codex(1, findingsOf([finding()])), 0); // 1. Codex round 1
    assertExit(w.judge(1, { 'R1-B1': ['ACCEPT'] }), 0); // 3. judge, triage validate
    assertExit(w.cli(['comment', '--pr', '7', '--kind', 'triage']), 0); // 5. publish the triage first
    w.repo.write('src/a.js', aFile(true).replace('compute(x.y)', 'compute(x?.y)')); // 5. the implementer's fix
    const head2 = w.repo.commit('fix R1-B1');
    w.prHead(head2);
    if (marked) assertExit(w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']), 0); // 5. mark each fixed ACCEPT item
    assertExit(w.codex(2, findingsOf(), { from: w.head, to: head2 }), 0); // round 2: the Codex fix check, clean
    const outcome = w.cli(['state', 'outcome']); // 6. outcome
    const done = w.cli(['review-complete', '--pr', '7']); // section 3.1
    if (marked) {
      assert.equal(outcome.json.clean, true, JSON.stringify(outcome.json));
      assertExit(done, 0, done.stderr + done.stdout);
      assert.ok(w.fake.lines().some((l) => l.startsWith('pr edit 7 ') && l.endsWith(' awaiting-review')), 'awaiting-review comes off');
      assert.ok(postedBodies(w).some((b) => b.includes('claude-pipeline:review-complete')), 'the marker comment is posted');
    } else {
      assert.equal(outcome.json.clean, false, 'an unmarked ACCEPT is not clean');
      assertExit(done, 1, done.stdout);
      assert.match(done.json.reason, /not implemented: R1-B1/);
    }
  }
});

test('review skill scenario: owner ruling via ruling-request, the owner\'s recorded answer, owner-ruling, triage re-posted, review-complete succeeds', (t) => {
  const w = ownerWorld(t, { yml: CHAT_YML, gh: [...GH, REMOVE_LABEL, ...REVIEW_COMMENT] });
  assertExit(w.codex(1, findingsOf([finding()])), 0);
  waitingForHuman(w, { 'R1-B1': 'REJECT' }); // what a failed arbiter model proof leaves behind
  assertExit(w.cli(['comment', '--pr', '7', '--kind', 'triage']), 0);
  const before = w.cli(['review-complete', '--pr', '7']);
  assertExit(before, 1, before.stdout); // an item waiting for a human blocks it
  const req = w.cli(['triage', 'ruling-request', '--pr', '7', '--ids', 'R1-B1']);
  assertExit(req, 0, req.stderr + req.stdout);
  // the reply ends with exactly this line; the owner answers with only the decisions
  const answer = 'R1-B1: reject';
  const recorded = ownerRules(t, answer, `Answer with only \`<id>: accept | follow-up | reject\`.\n${req.json.line}`);
  assert.ok(recorded, 'the owner-go recorder wrote the owner\'s answer down against the line ruling-request printed');
  const ruled = w.cli(rule('R1-B1', 'REJECT', { quote: answer, extra: ['--pr', '7'] }));
  assertExit(ruled, 0, ruled.stderr + ruled.stdout);
  assertExit(w.cli(['comment', '--pr', '7', '--kind', 'triage']), 0); // re-post so the ruling is published
  assert.equal(w.cli(['state', 'outcome']).json.clean, true);
  const done = w.cli(['review-complete', '--pr', '7']);
  assertExit(done, 0, done.stderr + done.stdout);
  assert.ok(postedBodies(w).at(-1).includes('claude-pipeline:review-complete'));
});

test('followups create: a FOLLOW-UP ruled by the owner is filed, one that is still waiting for a human is held', (t) => {
  const slug = uniqueSlug();
  const url = `https://github.com/${slug}/issues/31`;
  const w = ownerWorld(t, { slug, yml: CHAT_YML, gh: [...GH, ...noIssues(slug), { match: `^api -X POST repos/${slug}/issues `, stdoutJson: { number: 31, html_url: url } }] });
  assertExit(w.codex(1, findingsOf([finding()])), 0);
  waitingForHuman(w, { 'R1-B1': 'FOLLOW-UP' });
  ownerAnswers(w, t);
  const held = w.cli(['followups', 'create', '--round', '1']);
  assert.deepEqual([held.json.held, held.json.created], [['R1-B1'], []]);
  assertExit(w.cli(rule('R1-B1', 'FOLLOW-UP')), 0);
  const r = w.cli(['followups', 'create', '--round', '1']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual(r.json.created, [{ id: 'R1-B1', number: 31, url }]);
  const post = w.fake.calls().find((c) => c.argv.join(' ').startsWith(`api -X POST repos/${slug}/issues `));
  assert.ok(JSON.parse(post.stdin).body.includes('**Owner (why this is a follow-up, not part of the PR):** owner confirmed in chat'));
});

test('arbiter needed: returns promptHeader, exactly the ROUND / INPUT-DIGEST header of the input file', (t) => {
  const w = readyForArbiter(t);
  const r = w.cli(['arbiter', 'needed', '--round', '1']);
  assertExit(r, 0);
  assert.equal(r.json.promptHeader, `ROUND: 1\nINPUT-DIGEST: ${r.json.digest}`);
  assert.ok(readFileSync(r.json.inputPath, 'utf8').startsWith(`${r.json.promptHeader}\n\n`));
  assert.equal(arbiterRun(w, { prompt: `${r.json.promptHeader}\nRule on every item.` }).code, 0, 'a prompt that starts with the header passes the proof');
});

test('triage settle: a cached copy of an owner ruling (by cache, ownerQuote kept) is still the owner\'s word', (t) => {
  const w = world(t);
  assertExit(w.codex(1, findingsOf([finding()])), 0);
  editState(w, (s) => {
    s.rounds[0].items[0].judge = { decision: 'REJECT', confidence: 'high', reason: 'r', ...DISPUTED };
    s.rounds[0].items[0].final = { decision: 'REJECT', by: 'cache', needsHuman: false, reason: 'ok', ownerQuote: 'reject it', ruledAt: '2026-10-14T00:00:00.000Z' };
  });
  const before = w.stateText();
  const s = w.cli(settleArgs(w, 'R1-B1', 'bug-disproved'));
  assertExit(s, 1, s.stdout);
  assert.match(s.json.reason, /already ruled by the owner/);
  assert.equal(w.stateText(), before, 'state untouched');
});

test('triage owner-ruling: says the ruling is not published yet and that state show would restore the published state without it', (t) => {
  const w = ownerWorld(t, { yml: CHAT_YML });
  assertExit(w.codex(1, findingsOf([finding()])), 0);
  waitingForHuman(w, { 'R1-B1': 'FOLLOW-UP' });
  ownerAnswers(w, t);
  const r = w.cli(rule('R1-B1', 'FOLLOW-UP', { extra: ['--pr', '7'] }));
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.published, false);
  assert.match(r.json.next, /comment --pr 7 --kind triage/);
  assert.match(r.json.next, /state show/);
});

test('codex-review: a conflict resolved by choosing lines is a resolution-only round: Codex sees only the resolution, and the cap is not charged', (t) => {
  const w = worldIgnoringReview(t, { yml: MAX1 });
  assertExit(w.codex(1, findingsOf()), 0);
  const merged = conflictKeepingOurs(w);
  const r = w.codex(2, findingsOf(), { from: w.head, to: merged });
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.resolutionOnly, true);
  assert.deepEqual([r.json.conflicted, r.json.conflictedCount, r.json.baseOnly, r.json.resolutionIneligible], [['src/a.js'], 1, undefined, undefined]);
  assert.equal(w.captured().length, 2, 'Codex ran: a resolution round is a real review');
  const round = w.state().rounds[1];
  assert.equal(round.reviewBaseKind, 'resolution');
  assert.equal(round.resolutionOnly, true);
  assert.deepEqual([round.conflicted, round.conflictedCount, round.baseOnly], [['src/a.js'], 1, undefined]);
  assert.deepEqual(round.blocks, [{ path: 'src/a.js', block: 1, droppedTheirs: 1 }]);
  const patch = patchOf(w, 2);
  assert.equal((patch.match(/^diff --git /gm) ?? []).length, 1, 'one file');
  assert.match(patch, /^diff --git a\/src\/a\.js b\/src\/a\.js$/m);
  assert.match(patch, /^-<<<<<<< /m, 'the marker lines are what the resolution removed');
  assert.match(patch, /^-export const v12 = 1200;$/m, 'main\'s dropped line is shown');
  assert.doesNotMatch(patch, /from-main\.js/);
  assert.deepEqual(patch.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')), [], 'nothing is added');

  const prompt = w.captured()[1].stdin;
  assert.match(prompt, /trial-merged with the base branch/);
  assert.match(prompt, /```conflicted paths\nsrc\/a\.js\n```/);
  assert.match(prompt, /```dropped base-branch lines\nsrc\/a\.js block 1: 1 line\(s\) dropped\n```/);
  assert.match(prompt, /justify EVERY dropped base-branch line/);
  assert.ok(prompt.includes(`git show ${w.head}:<path>`) && prompt.includes('git show '), 'both sides can be read');
  const outcome = w.cli(['state', 'outcome']).json;
  assert.deepEqual([outcome.rounds, outcome.reviewedRounds, outcome.clean, outcome.reachedMax], [2, 1, true, false]);
});
