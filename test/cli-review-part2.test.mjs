// End-to-end tests for the review-loop commands (codex-review, triage, arbiter, state, review-complete, followups).
// They spawn the real CLI against a real throwaway git repo, a scripted fake gh and a scripted fake codex, because the
// contract the ship skill depends on is the pair (stdout JSON, exit code) plus the .review/ files left behind.
// Part 2 of 4, split from cli-review.test.mjs to balance the CI shards; shared helpers: helpers/cli-review-world.mjs.
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

test('state mark-implemented (#120): the same without a conflict (the synthetic base): a clean main merge with a hand edit is not the fix', (t) => {
  const w = acceptedWorld(t);
  mergeMainInto(w, { 'src/from-main.js': 'export const other = 1;\n' }, { evil: SMUGGLED });
  refusedAs(w, /smuggled\.js/);
});

test('state mark-implemented (#120): an octopus merge (main and a side branch) with a hand edit is not the fix', (t) => {
  const w = acceptedWorld(t);
  // side branches from the fork point, not from main, so git keeps all three parents; its own commit changes only a test file
  w.repo.git(['checkout', '-q', '-b', 'side', w.base]);
  w.repo.write('src/side.test.js', 'console.log("side");\n');
  w.repo.commit('side work');
  w.repo.checkout('main');
  w.repo.write('src/from-main.js', 'export const other = 1;\n');
  w.repo.commit('main moves on');
  w.repo.checkout('feat/x');
  w.repo.git(['merge', '--no-ff', '--no-commit', '-m', 'octopus', 'main', 'side']);
  w.repo.write('src/smuggled.js', SMUGGLED['src/smuggled.js']);
  w.repo.git(['add', '-A']);
  w.repo.git(['commit', '-q', '--no-edit']);
  assert.equal(w.repo.git(['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(/\s+/).length, 4, 'the merge has three parents');
  refusedAs(w, /smuggled\.js/);
});

test('state mark-implemented (#120): a merge of a branch other than the default branch brings that branch\'s own commits, which are PR work', (t) => {
  const w = acceptedWorld(t);
  w.repo.git(['checkout', '-q', '-b', 'topic', w.base]);
  w.repo.write('src/topic.js', 'export const topic = 1;\n');
  w.repo.commit('topic work');
  w.repo.checkout('feat/x');
  w.repo.git(['merge', '--no-ff', '-m', 'Merge topic into feat/x', 'topic']);
  countedAs(w);
});

test('state mark-implemented (#120): a fix committed before a hand-edited main merge still counts; so does one committed after it', (t) => {
  const w = acceptedWorld(t);
  fixA(w);
  mergeMainInto(w, FROM_MAIN, { evil: SMUGGLED });
  countedAs(w);

  const w2 = acceptedWorld(t);
  mergeMainInto(w2, FROM_MAIN, { evil: SMUGGLED });
  fixA(w2);
  countedAs(w2);
});

test('state mark-implemented (#120): a change reverted by a second commit and then hand-edited inside a merge is not the fix', (t) => {
  const w = acceptedWorld(t);
  w.repo.write('src/b.js', `${bFile}export const changed = 1;\n`);
  w.repo.commit('change b');
  w.repo.write('src/b.js', bFile);
  w.repo.commit('revert b');
  mergeMainInto(w, FROM_MAIN, { evil: { 'src/b.js': `${bFile}export const typed = 1;\n` } });
  refusedAs(w, /src\/b\.js/);
});

test('state mark-implemented (#120): a merge that discards an earlier change to a file leaves that file uncounted', (t) => {
  const w = acceptedWorld(t);
  w.repo.write('src/b.js', `${bFile}export const changed = 1;\n`);
  w.repo.commit('change b');
  mergeMainInto(w, FROM_MAIN, { evil: { 'src/b.js': `${bFile}export const somethingElse = 2;\n` } });
  refusedAs(w, /src\/b\.js/);
});

test('state mark-implemented (#120): main\'s own change merged cleanly into the fixed file leaves it uncounted until a commit finishes the fix there', (t) => {
  const w = acceptedWorld(t);
  w.repo.write('src/b.js', bFile.replace('w1 = 1', 'w1 = 100'));
  w.repo.commit('fix b');
  mergeMainInto(w, { 'src/b.js': bFile.replace('w8 = 8', 'w8 = 800') });
  assert.match(readFileSync(join(w.repo.dir, 'src/b.js'), 'utf8'), /w1 = 100[\s\S]*w8 = 800/, 'a clean merge holding both edits');
  refusedAs(w, /src\/b\.js/);
  w.repo.write('src/b.js', bFile.replace('w1 = 1', 'w1 = 101').replace('w8 = 8', 'w8 = 800'));
  w.repo.commit('finish the fix in b');
  countedAs(w);
});

test('state mark-implemented (#120): deleting a code file is a fix', (t) => {
  const w = acceptedWorld(t);
  w.repo.rm('src/b.js');
  w.repo.commit('delete b');
  countedAs(w);
});

test('state mark-implemented (#120): a file name with non-ASCII characters is counted when a commit wrote it and refused when a merge did', (t) => {
  const w = acceptedWorld(t);
  w.repo.write('src/café.js', 'export const cafe = 1;\n');
  w.repo.commit('add cafe');
  countedAs(w);

  const w2 = acceptedWorld(t);
  mergeMainInto(w2, FROM_MAIN, { evil: { 'src/café.js': 'export const cafe = 1;\n' } });
  refusedAs(w2, /café\.js/);
});

test('state mark-implemented (#120): a test file hand-edited inside a merge cannot satisfy a testing finding', (t) => {
  const mk = () => {
    const w = worldIgnoringReview(t);
    assertExit(w.codex(1, findingsOf([finding({ category: 'testing', file: 'src/a.test.js', line: 1 })])), 0);
    assertExit(w.judge(1, { 'R1-B1': ['ACCEPT'] }), 0);
    return w;
  };
  const w = mk();
  mergeMainInto(w, FROM_MAIN, { evil: { 'src/a.test.js': 'console.log("typed into the merge");\n' } });
  refusedAs(w, /a\.test\.js/);

  const w2 = mk();
  w2.repo.write('src/a.test.js', 'console.log("a real test fix");\n');
  w2.repo.commit('test fix');
  countedAs(w2);
});

test('state mark-implemented (#120): a merge that sets a file to main\'s earlier content is not the fix (commits of the default branch never count)', (t) => {
  const w = acceptedWorld(t);
  w.repo.checkout('main');
  w.repo.write('src/p.js', 'export const p = "z1";\n');
  w.repo.commit('main: p z1');
  w.repo.checkout('feat/x');
  // main moves on again; the merge brings p = z2 and a hand edit puts it back to z1, a blob only main's first commit wrote
  mergeMainInto(w, { 'src/p.js': 'export const p = "z2";\n' }, { evil: { 'src/p.js': 'export const p = "z1";\n' } });
  refusedAs(w, /src\/p\.js/);
});

test('state record-followup and set-outcome', (t) => {
  const w = world(t);
  assertExit(w.codex(1, standardFindings()), 0);
  assertExit(w.cli(['state', 'record-followup', '--id', 'R1-W1', '--url', 'https://github.com/acme/widgets/issues/3']), 0);
  assert.equal(w.item('R1-W1').followupIssue, 'https://github.com/acme/widgets/issues/3');
  assertExit(w.cli(['state', 'record-followup', '--id', 'R1-W1', '--url', 'not a url']), 2);
  assertExit(w.cli(['state', 'record-followup', '--id', 'R7-W1', '--url', 'https://x.test/1']), 2);
  assertExit(w.cli(['state', 'set-outcome', '--outcome', 'needs-human']), 0);
  assert.equal(w.state().outcome, 'needs-human');
  assertExit(w.cli(['state', 'set-outcome', '--outcome', '']), 2);
  assertExit(w.cli(['state', 'set-outcome']), 2);
  assertExit(w.cli(['state', 'nope']), 2);
});

test('state outcome: a round with nothing to fix is clean; coverage follows the content hash; a new ACCEPT is not clean', (t) => {
  const w = world(t);
  assertExit(w.cli(['state', 'outcome']), 2, 'no state at all');
  assertExit(w.codex(1, findingsOf()), 0);
  const clean = w.cli(['state', 'outcome']);
  assertExit(clean, 0);
  assert.equal(clean.json.clean, true);
  assert.equal(clean.json.coverageValid, true);
  assert.equal(clean.json.currentContentHash, w.state().rounds[0].contentHashAtToHead);
  assert.deepEqual([clean.json.rounds, clean.json.maxRounds, clean.json.reachedMax], [1, 2, false]);
  assert.deepEqual([clean.json.extraRound, clean.json.effectiveMaxRounds], [false, 2]);

  // content changed after the review: exit stays 0, clean turns false
  w.repo.write('src/b.js', `${bFile}export const extra = 1;\n`);
  w.repo.commit('after review');
  const stale = w.cli(['state', 'outcome']);
  assertExit(stale, 0);
  assert.equal(stale.json.clean, false);
  assert.equal(stale.json.coverageValid, false);

  // a different world: a finding that the judge ACCEPTs
  const w2 = world(t);
  assertExit(w2.codex(1, findingsOf([finding()])), 0);
  assertExit(w2.judge(1, { 'R1-B1': ['ACCEPT'] }), 0);
  const accepted = w2.cli(['state', 'outcome']);
  assertExit(accepted, 0);
  assert.equal(accepted.json.clean, false);
  assert.deepEqual(accepted.json.newAccepted, ['R1-B1']);
  assert.deepEqual(accepted.json.openBlocking, ['R1-B1']);

  // fixed and implemented: still not clean until a later round reviews the fix
  w2.repo.write('src/a.js', aFile(true).replace('compute(x.y)', 'compute(x?.y)'));
  const head2 = w2.repo.commit('fix');
  assertExit(w2.cli(['state', 'mark-implemented', '--ids', 'R1-B1']), 0);
  assert.equal(w2.cli(['state', 'outcome']).json.clean, false);
  assertExit(w2.codex(2, findingsOf(), { from: w2.head, to: head2 }), 0);
  const round2 = w2.cli(['state', 'outcome']);
  assert.equal(round2.json.clean, true, JSON.stringify(round2.json));
  assert.deepEqual(round2.json.newAccepted, []);
});

test('state show --pr rebuilds a lost state from the newest triage comment of ours', (t) => {
  const w0 = world(t);
  assertExit(w0.codex(1, standardFindings()), 0);
  assertExit(w0.judge(1, STANDARD_JUDGE), 0);
  const real = w0.state();
  const forged = { ...real, rounds: [], risk: 'forged' };
  const gh = [
    ...GH,
    { match: '^api user', stdout: 'me\n' },
    {
      match: 'issues/(7|8)/comments --paginate', // PR 8 gets the same comments: their embedded state says PR 7
      stdoutJson: [
        { id: 3, user: { login: 'me' }, body: triageComment({ ...real, risk: 'older' }) },
        { id: 9, user: { login: 'me' }, body: triageComment(real) },
        { id: 12, user: { login: 'mallory' }, body: triageComment(forged) },
        { id: 13, user: { login: 'me' }, body: `quoting ${MARKERS.triage}\n${triageComment(forged)}` },
      ],
    },
  ];
  const w = world(t, { gh });
  const r = w.cli(['state', 'show', '--pr', '7']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.recovered, true);
  assert.equal(r.json.count, 4);
  assert.deepEqual(w.state(), real, 'the recovered state is saved byte-for-byte as the comment carried it');
  assert.equal(w.cli(['state', 'show', '--pr', '7']).json.recovered, false, 'second call reads the local copy');

  const wrongPr = world(t, { gh });
  const mismatch = wrongPr.cli(['state', 'show', '--pr', '8']);
  assertExit(mismatch, 2);
  assert.ok(!existsSync(join(wrongPr.repo.dir, '.review', 'state.json')));
  assertExit(w.cli(['state', 'show', '--pr', '8']), 2, 'a local state of another PR is not served');

  const noComment = world(t, { gh: [...GH, { match: '^api user', stdout: 'me\n' }, { match: 'issues/7/comments --paginate', stdoutJson: [] }] });
  assertExit(noComment.cli(['state', 'show', '--pr', '7']), 2);
  const ghDown = world(t, { gh: [{ match: '.', code: 1, stderr: 'HTTP 502' }] });
  assertExit(ghDown.cli(['state', 'show', '--pr', '7']), 3);
});

test('review-complete: removes awaiting-review only when the review is valid for the current content', (t) => {
  const w = world(t, { gh: [...GH, REMOVE_LABEL, ...REVIEW_COMMENT] });
  assertExit(w.cli(['review-complete', '--pr', '7']), 1, 'no state: no review has run');
  assertExit(w.codex(1, findingsOf()), 0);

  const ok = w.cli(['review-complete', '--pr', '7']);
  assertExit(ok, 0, ok.stderr + ok.stdout);
  assert.deepEqual([ok.json.ok, ok.json.removed], [true, true]);
  assert.ok(w.fake.lines().includes('pr edit 7 --remove-label awaiting-review'));

  // the branch moved on after the review: the label stays
  const calls = w.fake.lines().filter((l) => l.startsWith('pr edit')).length;
  w.repo.write('src/b.js', `${bFile}export const extra = 1;\n`);
  w.prHead(w.repo.commit('unreviewed change'));
  const stale = w.cli(['review-complete', '--pr', '7']);
  assertExit(stale, 1);
  assert.equal(stale.json.ok, false);
  assert.match(stale.json.reason, /no review round covers the current content/);
  assert.equal(w.fake.lines().filter((l) => l.startsWith('pr edit')).length, calls, 'no label call when not valid');

  assertExit(w.cli(['review-complete', '--pr', '8']), 1, 'state of another PR');
});

test('review-complete: unresolved items or an unimplemented ACCEPT keep the label', (t) => {
  const w = world(t, { gh: [...GH, REMOVE_LABEL, ...REVIEW_COMMENT] });
  assertExit(w.codex(1, findingsOf([finding()])), 0);
  const pending = w.cli(['review-complete', '--pr', '7']);
  assertExit(pending, 1);
  assert.match(pending.json.reason, /waiting for a decision: R1-B1/);

  assertExit(w.judge(1, { 'R1-B1': ['ACCEPT'] }), 0);
  const accepted = w.cli(['review-complete', '--pr', '7']);
  assertExit(accepted, 1);
  assert.match(accepted.json.reason, /not implemented: R1-B1/);
  assert.ok(!w.fake.lines().some((l) => l.startsWith('pr edit')));
});

test('review-complete: Codex outage then recovery (exit 3, then a clean review, then the label comes off)', (t) => {
  const w = world(t, { gh: [...GH, REMOVE_LABEL, ...REVIEW_COMMENT] });
  const outage = w.codex(1, findingsOf(), { env: { FAKE_CODEX_EXIT: '1', FAKE_CODEX_TURN_FAILED: 'usage limit reached' } });
  assertExit(outage, 3);
  assertExit(w.cli(['review-complete', '--pr', '7']), 1, 'nothing was reviewed yet');

  assertExit(w.codex(1, findingsOf()), 0, 'Codex is back: the same round can be run again');
  assertExit(w.cli(['review-complete', '--pr', '7']), 0);
  assert.ok(w.fake.lines().includes('pr edit 7 --remove-label awaiting-review'));
});

test('review-complete: a gh failure while removing the label is exit 3, not success', (t) => {
  const w = world(t, { gh: [...GH, ...REVIEW_COMMENT, { match: '^pr edit', code: 1, stderr: 'HTTP 502' }] });
  assertExit(w.codex(1, findingsOf()), 0);
  assertExit(w.cli(['review-complete', '--pr', '7']), 3);
});

test('review-complete: the marker\'s fallback codexModel (a newest round that recorded none) is the trusted model, not a working-tree review.codex_model edit (#389, R1-F2)', (t) => {
  const w = world(t, { yml: withModel('gpt-test-1'), gh: [...GH, REMOVE_LABEL, ...REVIEW_COMMENT] });
  assertExit(w.codex(1, findingsOf()), 0);
  const s = w.state();
  delete s.rounds[0].codexModel; // a round that never recorded its model: only the configured default can name it
  writeFileSync(join(w.repo.dir, '.review', 'state.json'), JSON.stringify(s, null, 2));
  writeFileSync(join(w.repo.dir, '.claude', 'pipeline.yml'), withModel('gpt-evil-2'));
  const r = w.cli(['review-complete', '--pr', '7']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.review.codexModel, 'gpt-test-1');
  assert.equal(reviewJson(postedBodies(w)[0]).codexModel, 'gpt-test-1');
});

test('review-complete: posts the marker comment with {contentHash, base, head, rounds, codexModel, modelProofDigest, stateHash}; an identical one is reused', (t) => {
  const w = world(t, { gh: [...GH, REMOVE_LABEL, ...REVIEW_COMMENT] });
  assertExit(w.codex(1, findingsOf()), 0);
  const r = w.cli(['review-complete', '--pr', '7']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.posted, true);
  assert.deepEqual(r.json.comment, { id: 77, url: 'https://github.com/acme/widgets/pull/7#issuecomment-77' });
  const [body] = postedBodies(w);
  assert.ok(body.startsWith('<!-- claude-pipeline:review-complete v1 -->\n'), body);
  const record = reviewJson(body);
  assert.deepEqual(Object.keys(record), ['contentHash', 'base', 'head', 'rounds', 'codexModel', 'modelProofDigest', 'stateHash']);
  assert.deepEqual(record, {
    contentHash: w.state().rounds[0].contentHashAtToHead, base: w.base, head: w.head, rounds: 1, codexModel: 'gpt-6.2-astra', modelProofDigest: null,
    stateHash: reviewContentHash(w.state()), // the state review-complete published: the owner-go check binds the marker to it
  });
  assert.deepEqual(r.json.review, record);
  // The hash is the one a guard can recompute from git alone: contentHash(base, head) minus the agent log.
  assert.equal(record.contentHash, contentHash(record.base, record.head, { cwd: w.repo.dir, exclude: ['docs/agent-log.md'] }));

  // A retry finds our own identical latest comment and posts nothing new; someone else's copy does not count.
  w.fake.setScript([
    ...GH.map((e) => (e.match === '^pr view 7' ? { ...e, stdoutJson: { baseRefName: 'main', headRefOid: w.head, ...e.stdoutJson } } : e)),
    REMOVE_LABEL,
    { match: '^api user', stdout: 'me\n' },
    { match: 'issues/7/comments --paginate', stdoutJson: [{ id: 76, user: { login: 'mallory' }, body: 'x' }, { id: 77, user: { login: 'me' }, body, html_url: 'u77' }] },
    { match: '^api -X POST repos/acme/widgets/issues/7/comments ', stdoutJson: { id: 91, html_url: 'u91' } }, // the triage state is published first: postedBodies counts markers only
  ]);
  const again = w.cli(['review-complete', '--pr', '7']);
  assertExit(again, 0, again.stdout);
  assert.deepEqual([again.json.reused, again.json.comment], [true, { id: 77, url: 'u77' }]);
  assert.equal(postedBodies(w).length, 1);

  // Codex review of 4c595df: only what the guard workflow would judge is reused. Our identical comment that was edited (even back
  // to this text), or one with a newer marker comment of anyone after it, is not: a new comment is posted.
  const view = GH.map((e) => (e.match === '^pr view 7' ? { ...e, stdoutJson: { baseRefName: 'main', headRefOid: w.head, ...e.stdoutJson } } : e));
  const POST = { match: '^api -X POST repos/acme/widgets/issues/7/comments ', stdoutJson: { id: 90, html_url: 'u90' } };
  for (const comments of [
    [{ id: 77, user: { login: 'me' }, body, html_url: 'u77', created_at: '2026-10-29T00:00:00Z', updated_at: '2026-10-29T01:00:00Z' }],
    [{ id: 77, user: { login: 'me' }, body, html_url: 'u77' }, { id: 78, user: { login: 'mallory' }, body: `${body}\nx`, html_url: 'u78' }],
  ]) {
    const before = postedBodies(w).length;
    w.fake.setScript([...view, REMOVE_LABEL, { match: '^api user', stdout: 'me\n' }, { match: 'issues/7/comments --paginate', stdoutJson: comments }, POST]);
    const fresh = w.cli(['review-complete', '--pr', '7']);
    assertExit(fresh, 0, fresh.stdout);
    assert.deepEqual([fresh.json.posted, fresh.json.reused, fresh.json.comment], [true, undefined, { id: 90, url: 'u90' }], JSON.stringify(comments));
    assert.equal(postedBodies(w).length, before + 1);
  }
});

test('review-complete recheck: a ready PR without awaiting-review gets pipeline-recheck added, then removed (recheck triggered)', (t) => {
  const w = world(t, { gh: [PR_VIEW_AFTER, ...gotPr({ isDraft: false, labels: [{ name: 'agent-build' }] }), REMOVE_LABEL, ...RECHECK_OK, ...REVIEW_COMMENT] });
  assertExit(w.codex(1, findingsOf()), 0);
  const r = w.cli(['review-complete', '--pr', '7']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.recheck, 'triggered');
  assert.equal(r.json.recheckError, undefined);
  const edits = w.fake.lines().filter((l) => l.startsWith('pr edit'));
  assert.deepEqual(edits, ['pr edit 7 --remove-label awaiting-review', RECHECK_ADD, RECHECK_REMOVE]);
});

test('review-complete recheck: a ready PR that had awaiting-review needs no nudge (the unlabel fired the event): recheck label-removed', (t) => {
  const w = world(t, { gh: [PR_VIEW_AFTER, ...gotPr({ isDraft: false, labels: [{ name: 'awaiting-review' }] }), REMOVE_LABEL, ...RECHECK_OK, ...REVIEW_COMMENT] });
  assertExit(w.codex(1, findingsOf()), 0);
  const r = w.cli(['review-complete', '--pr', '7']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.recheck, 'label-removed');
  const edits = w.fake.lines().filter((l) => l.startsWith('pr edit'));
  assert.deepEqual(edits, ['pr edit 7 --remove-label awaiting-review']);
});

test('review-complete recheck: a draft gets its run when it is marked ready (recheck on-ready), no pipeline-recheck label', (t) => {
  for (const labels of [[], [{ name: 'awaiting-review' }]]) {
    const w = world(t, { gh: [PR_VIEW_AFTER, ...gotPr({ isDraft: true, labels }), REMOVE_LABEL, ...RECHECK_OK, ...REVIEW_COMMENT] });
    assertExit(w.codex(1, findingsOf()), 0);
    const r = w.cli(['review-complete', '--pr', '7']);
    assertExit(r, 0, r.stderr + r.stdout);
    assert.equal(r.json.recheck, 'on-ready');
    assert.ok(!w.fake.lines().includes(RECHECK_ADD), 'no label added to a draft');
  }
});

test('review-complete recheck: a failed nudge never undoes the posted comment: exit 0, recheck failed, recheckError names `P labels`', (t) => {
  const w = world(t, {
    gh: [PR_VIEW_AFTER, ...gotPr({ isDraft: false, labels: [] }), REMOVE_LABEL, { match: '^pr edit 7 --add-label pipeline-recheck', code: 1, stderr: "could not add label: 'pipeline-recheck' not found" }, ...RECHECK_OK, ...REVIEW_COMMENT],
  });
  assertExit(w.codex(1, findingsOf()), 0);
  const r = w.cli(['review-complete', '--pr', '7']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.posted, true);
  assert.equal(r.json.removed, true);
  assert.equal(r.json.recheck, 'failed');
  assert.match(r.json.recheckError, /P labels/);
  // Only labels the guards act on start a run now, so the hand fallback names pipeline-recheck, never "any label".
  assert.match(r.json.recheckError, /add and remove pipeline-recheck by hand/);
  assert.doesNotMatch(r.json.recheckError, /any label/);
  assert.ok(w.fake.lines().includes(RECHECK_ADD));
  assert.ok(!w.fake.lines().includes(RECHECK_REMOVE), 'no remove after a failed add');
  assert.equal(postedBodies(w).length, 1, 'the review-complete comment stays');
});

test('a sensitive PR with ZERO Codex findings still requires the Fable pass: not clean, no review-complete, until a proven pass', (t) => {
  const w = world(t, { gh: [...GH, REMOVE_LABEL, ...REVIEW_COMMENT], yml: SENSITIVE_YML });
  const r = w.codex(1, findingsOf());
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual([r.json.reviewer, r.json.reviewerReasons, r.json.lightLane], ['fable', ['sensitive path: src/a.js'], false]);
  assert.equal(w.state().risk, 'low', 'the lane, not the risk level, sends it to Fable');
  assert.deepEqual(w.state().rounds[0].sensitivePaths, ['src/a.js']);
  // Codex was given the attacker's brief for the sensitive file.
  assert.match(w.captured()[0].stdin, /## Attacker's brief[\s\S]*```sensitive paths\nsrc\/a\.js\n```/);

  const pending = w.cli(['state', 'outcome']).json;
  assert.deepEqual([pending.clean, pending.fablePending], [false, [1]]);
  const early = w.cli(['review-complete', '--pr', '7']);
  assertExit(early, 1);
  assert.match(early.json.reason, /Fable review pass has not been proven for round 1/);
  assert.equal(postedBodies(w).length, 0);
  const judged = w.judge(1, {});
  assertExit(judged, 2);
  assert.equal(judged.json.error, 'fable-round', 'one reviewer layer: no judge on a Fable round');

  const needed = w.cli(['arbiter', 'needed', '--round', '1']);
  assertExit(needed, 0, needed.stdout);
  assert.deepEqual([needed.json.needed, needed.json.mode, needed.json.items, needed.json.scope], [true, 'review', [], 'whole-pr']);
  const input = readFileSync(needed.json.inputPath, 'utf8');
  assert.match(input, /Mode: REVIEW/);
  assert.match(input, /your own review is the whole job/);
  assert.match(input, /Sensitive files \(attack them[^\n]*\n```sensitive paths\nsrc\/a\.js\n```/, 'paths are data in a fence');
  assert.match(input, /untrusted data written by the change author/);
  assert.match(input, /Why Fable reviews this PR: sensitive path\./, 'no author-chosen path outside the fence');
  assert.doesNotMatch(input, /Conflict resolution|trial-merged/, 'an ordinary round carries no conflict-resolution block');
  const diff = readFileSync(needed.json.diffPath, 'utf8');
  assert.match(diff, /compute\(x\.y\)/, 'the whole PR diff is what Fable reviews');
  assert.ok(input.includes(`Diff sha256: ${sha256(diff)}`));

  // An answer without its own review (no findings list) does not count: the round stays pending.
  assertExit(arbiterRun(w, { text: fenced({ rulings: [] }) }), 1);
  assert.deepEqual(w.cli(['state', 'outcome']).json.fablePending, [1]);
  // A diff edited after needed fails the proof too.
  assertExit(w.cli(['arbiter', 'needed', '--round', '1']), 0);
  writeFileSync(w.state().rounds[0].arbiter.diffPath, 'nothing to see\n');
  const tampered = arbiterRun(w, { text: fenced(FABLE_CLEAN) });
  assertExit(tampered, 1);
  assert.ok(tampered.json.errors.some((e) => /no longer matches the digest/.test(e)), JSON.stringify(tampered.json.errors));

  // needed again (rewrites the diff), then a proven, clean Fable pass: clean, and review-complete carries the proof digest.
  assertExit(w.cli(['arbiter', 'needed', '--round', '1']), 0);
  const proven = arbiterRun(w, { text: fenced(FABLE_CLEAN) });
  assertExit(proven, 0, proven.stdout);
  assert.deepEqual([proven.json.mode, proven.json.findings], ['review', []]);
  assert.equal(w.cli(['state', 'outcome']).json.clean, true);
  assert.deepEqual(w.cli(['arbiter', 'needed', '--round', '1']).json, { needed: false, items: [], mode: 'review', done: true });
  const done = w.cli(['review-complete', '--pr', '7']);
  assertExit(done, 0, done.stdout);
  assert.match(reviewJson(postedBodies(w).at(-1)).modelProofDigest, /^[0-9a-f]{64}$/);
});

test('Fable review: its own findings become items R<n>-F<k>; Codex items are ruled in the same pass; an ACCEPT reopens the loop', (t) => {
  const w = world(t, { yml: SENSITIVE_YML });
  assertExit(w.codex(1, findingsOf([], [finding({ title: 'Rename helper', file: 'src/b.js', line: 3, category: 'maintainability' })])), 0);
  const needed = w.cli(['arbiter', 'needed', '--round', '1']);
  assert.deepEqual([needed.json.mode, needed.json.items], ['review', ['R1-S1']], 'an untriaged Codex item goes straight to Fable');
  const answer = {
    rulings: [{ id: 'R1-S1', ruling: 'REJECT', confidence: 'high', reasoning: 'src/b.js:3 is fine' }],
    findings: [{
      bucket: 'BLOCKING', category: 'bug', title: 'x can be undefined', file: 'src/a.js', line: 12, detail: 'compute(x.y) with x undefined throws',
      ruling: 'ACCEPT', confidence: 'high', reasoning: 'src/a.js:12 dereferences x',
    }],
  };
  const r = arbiterRun(w, { text: fenced(answer) });
  assertExit(r, 0, r.stdout);
  assert.deepEqual(r.json.findings, [{ id: 'R1-F1', bucket: 'BLOCKING', ruling: 'ACCEPT', needsHuman: false }]);
  assert.equal(w.item('R1-S1').final.decision, 'REJECT');
  const f1 = w.item('R1-F1');
  assert.deepEqual([f1.source, f1.final.by, f1.file, f1.line], ['fable', 'arbiter', 'src/a.js', 12]);
  assert.match(f1.fingerprint, /^[0-9a-f]{40}$/);
  const o = w.cli(['state', 'outcome']).json;
  assert.deepEqual([o.clean, o.openBlocking, o.newAccepted], [false, ['R1-F1'], ['R1-F1']]);
  assert.deepEqual(JSON.parse(readFileSync(w.roundFile(1, 'rulings.json'), 'utf8')).findings, answer.findings);

  // A proven review is final: another transcript cannot re-add (or soften) its findings.
  const softer = { ...answer, findings: [{ ...answer.findings[0], bucket: 'WORTH_CONSIDERING', ruling: 'FOLLOW-UP' }] };
  const again = arbiterRun(w, { text: fenced(softer), agentId: 'a2' });
  assertExit(again, 2, again.stdout);
  assert.equal(again.json.error, 'already-applied');
  assert.deepEqual([w.item('R1-F1').bucket, w.item('R1-F1').final.decision], ['BLOCKING', 'ACCEPT']);
  assert.equal(w.state().rounds[0].items.filter((i) => i.id === 'R1-F1').length, 1);
});

test('Fable review: a finding an earlier Fable pass settled, raised again unchanged, takes the cached ruling (no fresh ACCEPT)', (t) => {
  const { w, applyRound2 } = twoFableRounds(t);
  const r2 = applyRound2('a3');
  assertExit(r2, 0, r2.stdout);
  assert.deepEqual([w.item('R2-F1').final.by, w.item('R2-F1').final.decision], ['cache', 'FOLLOW-UP']);
  assert.deepEqual(w.cli(['state', 'outcome']).json.newAccepted, []);
});

test('Fable review: a weaker earlier ruling (the judge) never overrules a finding a proven Fable pass raises', (t) => {
  const { w, applyRound2 } = twoFableRounds(t);
  editState(w, (s) => { s.rounds[0].items[0].final.by = 'judge'; }); // as if the Sonnet judge had ruled it in round 1
  const r2 = applyRound2('a4');
  assertExit(r2, 0, r2.stdout);
  assert.deepEqual([w.item('R2-F1').final.by, w.item('R2-F1').final.decision], ['arbiter', 'ACCEPT']);
});

test('arbiter apply: a Fable round whose input was not written in review mode is refused (stale-input), never proven', (t) => {
  const w = world(t, { yml: SENSITIVE_YML });
  assertExit(w.codex(1, findingsOf()), 0);
  assertExit(w.cli(['arbiter', 'needed', '--round', '1']), 0);
  editState(w, (s) => { delete s.rounds[0].arbiter.mode; }); // an older install, a restored or edited state
  const r = arbiterRun(w, { text: fenced({ rulings: [] }) });
  assertExit(r, 2, r.stdout);
  assert.equal(r.json.error, 'stale-input');
  assert.deepEqual(w.cli(['state', 'outcome']).json.fablePending, [1]);
});

test('codex-review: rounds stop at review.max_rounds plus ONE extra confirm round (exit 2 round-cap)', (t) => {
  const w = world(t, { yml: `${pipelineYml()}review:\n  max_rounds: 1\n` });
  assertExit(w.codex(1, findingsOf([finding()])), 0);
  assertExit(w.judge(1, { 'R1-B1': ['ACCEPT'] }), 0);
  w.repo.write('src/a.js', aFile(true).replace('compute(x.y)', 'compute(x?.y)'));
  const head2 = w.repo.commit('fix');
  assertExit(w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']), 0);
  const extra = w.codex(2, findingsOf([finding({ title: 'Another', file: 'src/b.js', line: 2 })]), { from: w.head, to: head2 });
  assertExit(extra, 0, 'the one confirm round: round 1 only accepted a fix');
  assertExit(w.judge(2, { 'R2-B1': ['ACCEPT'] }), 0);
  w.repo.write('src/b.js', bFile.replace('w2 = 2', 'w2 = 22'));
  const head3 = w.repo.commit('fix 2');
  assertExit(w.cli(['state', 'mark-implemented', '--ids', 'R2-B1']), 0);
  const capped = w.codex(3, findingsOf(), { from: head2, to: head3 });
  assertExit(capped, 2, capped.stdout);
  assert.equal(capped.json.error, 'round-cap');
  assert.match(capped.json.message, /review\.max_rounds \(1\) and its one extra round/);
  assert.equal(w.captured().length, 2, 'Codex never ran for the capped round');
});

// ---- followups create -------------------------------------------------------------------------

test('followups create: one agent-suggestion issue per FOLLOW-UP item, URL recorded, never filed twice', (t) => {
  const url = 'https://github.com/acme/widgets/issues/11';
  const w = world(t, { gh: [...GH, ...NO_ISSUES, { match: '^api -X POST repos/acme/widgets/issues ', stdoutJson: { number: 11, html_url: url } }] });
  const longTitle = `Consider caching ${'very '.repeat(40)}hard`;
  assertExit(w.codex(1, findingsOf(
    [],
    [finding({ title: 'Rename helper', file: 'src/b.js', line: 3 })],
    [finding({ title: longTitle, file: 'src/a.js', line: 20, detail: 'cache it @someone <!-- x -->', category: 'performance' })],
  )), 0);
  assertExit(w.judge(1, { 'R1-S1': ['ACCEPT'], 'R1-W1': ['FOLLOW-UP'] }), 0);

  const r = w.cli(['followups', 'create', '--round', '1']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual(r.json.created, [{ id: 'R1-W1', number: 11, url }]);
  assert.deepEqual(r.json.skipped, []);
  const posts = w.fake.calls().filter((c) => c.argv.join(' ').startsWith('api -X POST repos/acme/widgets/issues '));
  assert.equal(posts.length, 1, 'only the FOLLOW-UP item gets an issue');
  const body = JSON.parse(posts[0].stdin);
  assert.ok(body.title.startsWith('[agent-suggestion] Consider caching'));
  assert.ok(Array.from(body.title).length <= 120);
  assert.deepEqual(body.labels, ['agent-suggestion']);
  for (const needle of ['cache it', 'Codex reasoning:', 'judge: FOLLOW-UP R1-W1', 'From PR #7, item R1-W1', 'src/a.js:20']) {
    assert.ok(body.body.includes(needle), `issue body should include ${needle}: ${body.body}`);
  }
  assert.equal(body.body.split('\n')[0], '<!-- claude-pipeline:followup pr=7 fp=' + w.item('R1-W1').fingerprint + ' -->', 'the marker is the first line');
  const modelText = body.body.split('\n').slice(1).join('\n');
  assert.ok(!modelText.includes('@someone') && !modelText.includes('<!--'), 'model text is defused');
  assert.equal(w.item('R1-W1').followupIssue, url);

  const again = w.cli(['followups', 'create', '--round', '1']);
  assertExit(again, 0);
  assert.deepEqual(again.json.created, []);
  assert.deepEqual(again.json.skipped, ['R1-W1']);
  assert.equal(w.fake.calls().filter((c) => c.argv.join(' ').startsWith('api -X POST repos/acme/widgets/issues ')).length, 1);
  assertExit(w.cli(['followups', 'create', '--round', '4']), 2);
  assertExit(w.cli(['followups']), 2);
});

test('followups create: a gh failure is exit 3 and nothing is recorded as filed', (t) => {
  const w = world(t, { gh: [...GH, ...NO_ISSUES, { match: '^api -X POST', code: 1, stderr: 'HTTP 502' }] });
  assertExit(w.codex(1, findingsOf([], [], [finding({ title: 'Idea', category: 'other' })])), 0);
  assertExit(w.judge(1, { 'R1-W1': ['FOLLOW-UP'] }), 0);
  const r = w.cli(['followups', 'create', '--round', '1']);
  assertExit(r, 3);
  assert.equal(w.item('R1-W1').followupIssue ?? null, null);
});

test('followups create: a rate limit on the issue POST that DID land is retried with a fresh lookup, so no duplicate issue is filed (#190)', (t) => {
  const url = 'https://github.com/acme/widgets/issues/11';
  const w = world(t);
  assertExit(w.codex(1, findingsOf([], [], [finding({ title: 'Idea', category: 'other' })])), 0);
  assertExit(w.judge(1, { 'R1-W1': ['FOLLOW-UP'] }), 0);
  const marker = `<!-- claude-pipeline:followup pr=7 fp=${w.item('R1-W1').fingerprint} -->`;
  const limited = { code: 1, stderr: 'gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)' };
  w.fake.setScript([
    { match: '^repo view', stdoutJson: REPO_VIEW },
    { match: '^api user', stdout: 'me\n' },
    // the lookup: empty the first time; the second time the issue the limited POST had actually created is there
    { match: '^api repos/acme/widgets/issues\\?creator=me&state=all&per_page=100 --paginate', sequence: [
      { stdout: '[]' },
      { stdoutJson: [{ number: 11, html_url: url, state: 'open', body: `${marker}\nbody`, user: { login: 'me' } }] },
    ] },
    { match: '^api -X POST repos/acme/widgets/issues ', sequence: [limited, { stdoutJson: { number: 12, html_url: 'https://github.com/acme/widgets/issues/12' } }] },
  ]);
  const r = w.cli(['followups', 'create', '--round', '1'], { PIPELINE_GH: SEQ_GH, PIPELINE_GH_RETRY_MS: '50' });
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual(r.json.created, []);
  assert.deepEqual(r.json.reused.map((x) => x.number), [11]);
  assert.equal(w.fake.calls().filter((c) => c.argv.join(' ').startsWith('api -X POST repos/acme/widgets/issues ')).length, 1, 'one POST only');
  assert.match(r.stderr, /secondary rate limit; retrying in/);
  assert.equal(w.item('R1-W1').followupIssue, url);
});

// ---- a whole round, end to end ----------------------------------------------------------------

test('a full round: codex -> judge -> arbiter -> implement -> follow-ups -> clean second round -> label off', (t) => {
  const url = 'https://github.com/acme/widgets/issues/21';
  const w = world(t, {
    gh: [
      ...GH, REMOVE_LABEL,
      { match: '^api -X POST repos/acme/widgets/issues ', stdoutJson: { number: 21, html_url: url } },
      { match: '^api repos/acme/widgets/issues\\?creator=me&state=all&per_page=100 --paginate', stdout: '[]' },
      { match: '^api user', stdout: 'me\n' },
      { match: 'issues/7/comments --paginate', stdoutJson: [] },
      { match: '^api -X POST repos/acme/widgets/issues/7/comments ', stdoutJson: { id: 5, html_url: 'https://github.com/acme/widgets/pull/7#issuecomment-5' } },
    ],
  });
  assertExit(w.codex(1, standardFindings()), 0);
  assertExit(w.judge(1, STANDARD_JUDGE), 0);
  assert.equal(w.cli(['arbiter', 'needed', '--round', '1']).json.needed, true);
  assertExit(arbiterRun(w), 0);
  assert.equal(w.item('R1-S1').final.decision, 'REJECT');

  // implement the accepted items (B1 from the judge, S2 from the arbiter)
  assert.deepEqual(w.cli(['state', 'show', '--accepted']).json.items.map((i) => i.id), ['R1-B1', 'R1-S2']);
  w.repo.write('src/a.js', aFile(true).replace('compute(x.y)', 'compute(x?.y)'));
  w.repo.write('src/b.js', bFile.replace('w5 = 5', 'FIVE = 5'));
  const head2 = w.repo.commit('implement accepted items');
  w.prHead(head2);
  assertExit(w.cli(['state', 'mark-implemented', '--ids', 'R1-B1,R1-S2']), 0);
  assert.equal(w.cli(['followups', 'create', '--round', '1']).json.created[0].id, 'R1-W1');
  assert.equal(w.cli(['state', 'outcome']).json.clean, false, 'round 1 accepted things: a later round must review the fixes');
  assertExit(w.cli(['review-complete', '--pr', '7']), 1);

  // round 2 reviews the fix commit only and finds nothing
  const r2 = w.codex(2, findingsOf(), { from: w.head, to: head2 });
  assertExit(r2, 0, r2.stderr + r2.stdout);
  const outcome = w.cli(['state', 'outcome']);
  assert.equal(outcome.json.clean, true, JSON.stringify(outcome.json));
  assertExit(w.cli(['state', 'set-outcome', '--outcome', 'merged']), 0);
  assertExit(w.cli(['review-complete', '--pr', '7']), 0);

  // the comments the loop posts are rendered from the files these commands left behind
  const posted = () => w.fake.calls().filter((c) => /^api -X POST repos\/acme\/widgets\/issues\/7\/comments /.test(c.argv.join(' '))).map((c) => JSON.parse(c.stdin).body);
  assertExit(w.cli(['comment', '--pr', '7', '--kind', 'triage']), 0);
  const triage = posted().at(-1);
  assert.ok(triage.startsWith(MARKERS.triage));
  assert.match(triage, /R1-S1/);
  assertExit(w.cli(['comment', '--pr', '7', '--kind', 'summary', '--outcome', 'merged']), 0);
  const summary = posted().at(-1);
  assert.ok(summary.startsWith(MARKERS.summary));
  assert.match(summary, /Fable proof: .*agent-a1\.jsonl, models claude-fable-5-2×1, effort high/);
  assert.ok(summary.includes(url), 'the follow-up issue recorded by followups create is listed');
});

test('codex-review: round 1 must review exactly mergeBase..head; base == head, or any other base, is exit 2 and Codex never runs', (t) => {
  // Reviewer repro R1: --base == --head recorded an EMPTY review as full coverage (lightLane forced on, hard stops
  // hidden), and review-complete then removed awaiting-review.
  const w = world(t);
  const same = w.codex(1, findingsOf(), { from: w.head, to: w.head });
  assertExit(same, 2, same.stdout);
  assert.equal(same.json.error, 'base-mismatch');
  assert.match(same.json.message, new RegExp(w.base));
  w.repo.write('src/c.js', 'export const c = 1;\n');
  const head2 = w.repo.commit('more');
  const narrow = w.codex(1, findingsOf(), { from: w.head, to: head2 });
  assertExit(narrow, 2);
  assert.equal(narrow.json.error, 'base-mismatch');
  assert.equal(w.captured().length, 0, 'Codex is not even started');
  assert.ok(noState(w), 'nothing recorded');
  assertExit(w.cli(['review-complete', '--pr', '7']), 1);

  // the real merge base is accepted, by SHA or by an abbreviation of it
  const ok = w.codex(1, findingsOf(), { from: w.base.slice(0, 12), to: head2 });
  assertExit(ok, 0, ok.stderr + ok.stdout);
  assert.equal(w.state().rounds[0].fromHead, w.base);
});

test('codex-review: round N > 1 must start at the previous round\'s toHead; any other base is exit 2', (t) => {
  const w = world(t);
  assertExit(w.codex(1, findingsOf()), 0);
  w.repo.write('src/c.js', 'export const c = 1;\n');
  const head2 = w.repo.commit('fix');
  for (const from of [w.base, head2]) {
    const r = w.codex(2, findingsOf(), { from, to: head2 });
    assertExit(r, 2, `base ${from}`);
    assert.equal(r.json.error, 'base-mismatch');
    assert.match(r.json.message, new RegExp(w.head));
  }
  assert.equal(w.captured().length, 1);
  assertExit(w.codex(2, findingsOf(), { from: w.head, to: head2 }), 0);
});

test('codex-review: risk and light lane come from the whole PR on every round, and a growing PR leaves the light lane', (t) => {
  const w = world(t, { light: true });
  assert.equal(w.codex(1, findingsOf()).json.lightLane, true);
  assert.equal(w.state().lightLane, true);
  w.repo.write('src/big.js', Array.from({ length: 80 }, (_, i) => `export const big${i} = ${i};`).join('\n') + '\n');
  const head2 = w.repo.commit('grow');
  // round 2 reviews only the 80-line commit, but the PR as a whole is now over the cap; a fix round can never
  // turn the light lane on, and a PR that outgrew it must stop using it
  const r = w.codex(2, findingsOf(), { from: w.head, to: head2 });
  assertExit(r, 0);
  assert.equal(r.json.lightLane, false);
  assert.equal(w.state().lightLane, false);
  assert.ok(/Risk level: (low|medium|high)/.test(w.captured()[1].stdin));
});

test('codex-review: a hard-stop file anywhere in the PR makes the risk high (computed from mergeBase..head, not --base)', (t) => {
  const w = world(t);
  w.repo.write('.github/workflows/ci.yml', 'name: x\n');
  const head2 = w.repo.commit('workflow');
  const r = w.codex(1, findingsOf(), { from: w.base, to: head2 });
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(w.state().risk, 'high');
  assert.equal(r.json.lightLane, false);
});

test('codex-review: a finding path that tries to leave the repository reads nothing outside the git tree (reviewer repro R3)', (t) => {
  const w = world(t);
  const f = (file) => finding({ title: `T ${file}`, file });
  assertExit(w.codex(1, findingsOf([f('../../../../../../etc/passwd'), f('/etc/passwd'), f(':/src/a.js'), f('src/../src/a.js')])), 0);
  const needed = w.cli(['arbiter', 'needed', '--round', '1', '--force']);
  assertExit(needed, 0);
  const input = readFileSync(needed.json.inputPath, 'utf8');
  assert.ok(!input.includes('root:') && !input.includes('/bin/'), 'no file outside the repository is quoted');
  assert.equal((input.match(/does not exist at the reviewed head/g) ?? []).length >= 2, true);
});

// -- the ruled cache

test('codex-review cache: a dismissal is never reused for a finding that came back higher-severity or as a security category', (t) => {
  // Reviewer repro 2: a WORTH CONSIDERING performance FOLLOW-UP was reused for the same text escalated to a
  // BLOCKING security finding, which then looked "ruled" and let the review go clean.
  const w = world(t);
  const idea = (over = {}) => finding({ title: 'Cache grows', file: 'src/a.js', line: 20, category: 'performance', testable: false, ...over });
  assertExit(w.codex(1, findingsOf([], [], [idea()])), 0);
  assertExit(w.judge(1, { 'R1-W1': ['FOLLOW-UP'] }), 0);
  w.repo.write('src/c.js', 'export const c = 1;\n');
  const head2 = w.repo.commit('more');

  const escalated = w.codex(2, findingsOf([idea({ category: 'security' })]), { from: w.head, to: head2 });
  assertExit(escalated, 0, escalated.stderr + escalated.stdout);
  assert.equal(escalated.json.preRuled, 0);
  assert.equal(w.item('R2-B1').final ?? null, null, 'still pending: it must be triaged like a new finding');
  assert.equal(w.cli(['state', 'outcome']).json.clean, false);
  assert.equal(w.cli(['state', 'outcome']).json.openBlocking[0], 'R2-B1');
});

test('codex-review cache: same fingerprint but another bucket or category is reopened; the same bucket and category is reused', (t) => {
  const w = world(t);
  const idea = (over = {}) => finding({ title: 'Cache grows', file: 'src/a.js', line: 20, category: 'performance', testable: false, ...over });
  assertExit(w.codex(1, findingsOf([], [], [idea()])), 0);
  assertExit(w.judge(1, { 'R1-W1': ['REJECT'] }), 0);
  w.repo.write('src/c.js', 'export const c = 1;\n');
  const head2 = w.repo.commit('more');

  const r = w.codex(2, findingsOf([], [idea({ category: 'design' }), idea({ title: 'Cache grows' })], [idea()]), { from: w.head, to: head2 });
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(w.item('R2-S1').final ?? null, null, 'other category');
  assert.equal(w.item('R2-S2').final ?? null, null, 'other bucket (SUGGESTION, was WORTH CONSIDERING)');
  assert.equal(w.item('R2-W1').final.by, 'cache', 'identical bucket and category');
});

// -- triage settle

test('triage settle: a needsHuman item stays with the human (reviewer repro R2: a settle used to override it)', (t) => {
  const w = world(t);
  assertExit(w.codex(1, findingsOf([finding({ title: 'sec', category: 'security', file: 'src/a.js' })])), 0);
  editState(w, (s) => {
    s.rounds[0].items[0].judge = { decision: 'REJECT', confidence: 'high', reason: 'r', ...DISPUTED };
    s.rounds[0].items[0].final = { decision: 'REJECT', by: 'arbiter', needsHuman: true, reason: 'would dismiss a blocking security/data item' };
  });
  const before = w.stateText();
  const s = w.cli(settleArgs(w, 'R1-B1', 'bug-disproved'));
  assertExit(s, 1, s.stdout);
  assert.equal(s.json.ok, false);
  assert.match(s.json.reason, /needs a human/);
  assert.equal(w.stateText(), before, 'state untouched');
  assert.equal(w.cli(['state', 'outcome']).json.needsHuman[0], 'R1-B1');
});

test('triage settle: only a disputed bug with a possible settle test and no test result yet can be settled', (t) => {
  const w = world(t);
  assertExit(w.codex(1, findingsOf([finding(), finding({ title: 'Second' }), finding({ title: 'Third' }), finding({ title: 'Fourth' }), finding({ title: 'Fifth' })])), 0);
  const judged = (id, extra) => ({ id, decision: 'REJECT', confidence: 'high', reason: 'no', disputedBug: false, settleTest: { possible: false, plan: '' }, ...extra });
  const j = w.file('j.json', { items: [
    judged('R1-B1', DISPUTED), judged('R1-B2', {}), judged('R1-B3', { disputedBug: true }), judged('R1-B4', DISPUTED), judged('R1-B5', DISPUTED),
  ] });
  assertExit(w.cli(['triage', 'validate', '--round', '1', '--file', j]), 0);
  const settle = (id) => w.cli(settleArgs(w, id, 'bug-confirmed'));

  assertExit(settle('R1-B2'), 1, 'the judge did not dispute it as a bug');
  assertExit(settle('R1-B3'), 1, 'disputed, but no settle test is possible');
  editState(w, (s) => { s.rounds[0].items[3].final = { decision: 'ACCEPT', by: 'arbiter', needsHuman: false, reason: 'x' }; });
  assertExit(settle('R1-B4'), 1, 'the arbiter already ruled');
  editState(w, (s) => { s.rounds[0].items[4].final = { decision: 'ACCEPT', by: 'judge', needsHuman: false, reason: 'x' }; s.rounds[0].items[4].implemented = true; });
  assertExit(settle('R1-B5'), 1, 'already implemented');
  for (const id of ['R1-B2', 'R1-B3', 'R1-B4', 'R1-B5']) assert.equal(w.item(id).test?.status ?? 'none', 'none', id);

  const ok = settle('R1-B1');
  assertExit(ok, 0, ok.stdout);
  assert.equal(w.item('R1-B1').final.by, 'test');
  assertExit(settle('R1-B1'), 1, 'a second result for an item that already has one');
});

// -- follow-ups

test('followups create: a finding already filed (any round, cache reuse or not) is never filed again; needsHuman items wait', (t) => {
  const url = 'https://github.com/acme/widgets/issues/31';
  const w = world(t, { gh: [...GH, ...NO_ISSUES, { match: '^api -X POST repos/acme/widgets/issues ', stdoutJson: { number: 31, html_url: url } }] });
  const posts = () => w.fake.calls().filter((c) => c.argv.join(' ').startsWith('api -X POST repos/acme/widgets/issues ')).length;
  const idea = (over = {}) => finding({ title: 'Cache grows', file: 'src/a.js', line: 20, category: 'performance', testable: false, ...over });
  assertExit(w.codex(1, findingsOf([], [], [idea()])), 0);
  assertExit(w.judge(1, { 'R1-W1': ['FOLLOW-UP'] }), 0);
  assert.equal(w.cli(['followups', 'create', '--round', '1']).json.created.length, 1);
  w.repo.write('src/c.js', 'export const c = 1;\n');
  const head2 = w.repo.commit('more');

  // round 2 raises it again: once as the identical finding (cache), once under another category that the judge also
  // sends to a follow-up (so its ruling does not come from the cache)
  assertExit(w.codex(2, findingsOf([], [], [idea({ category: 'design' }), idea()]), { from: w.head, to: head2 }), 0);
  assert.equal(w.item('R2-W2').final.by, 'cache');
  assert.equal(w.item('R2-W2').followupIssue, url, 'the issue number travels with the cached ruling');
  assertExit(w.judge(2, { 'R2-W1': ['FOLLOW-UP', 'high'] }), 0);
  const r = w.cli(['followups', 'create', '--round', '2']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual(r.json.created, []);
  assert.deepEqual([...r.json.skipped].sort(), ['R2-W1', 'R2-W2']);
  assert.equal(posts(), 1, 'one issue for one fingerprint, across the whole review');
  assert.equal(w.item('R2-W1').followupIssue, url, 'the existing issue is recorded on the item');

  // a follow-up that needs a human is not filed
  editState(w, (s) => {
    s.rounds[1].items.push({ ...s.rounds[1].items[0], id: 'R2-W9', fingerprint: 'other-fp', followupIssue: null, final: { decision: 'FOLLOW-UP', by: 'arbiter', needsHuman: true, reason: 'low confidence' } });
  });
  const held = w.cli(['followups', 'create', '--round', '2']);
  assertExit(held, 0);
  assert.deepEqual(held.json.created, []);
  assert.deepEqual(held.json.held, ['R2-W9']);
  assert.equal(posts(), 1);
  assert.equal(w.item('R2-W9').followupIssue ?? null, null);
});

// -- review-complete

test('review-complete: refuses when the local HEAD is not the head GitHub holds for the PR', (t) => {
  const w = world(t, { gh: [...GH, REMOVE_LABEL, ...REVIEW_COMMENT] });
  assertExit(w.codex(1, findingsOf()), 0);
  w.prHead('0'.repeat(40));
  const r = w.cli(['review-complete', '--pr', '7']);
  assertExit(r, 1, r.stdout);
  assert.equal(r.json.ok, false);
  assert.match(r.json.reason, /HEAD .* is not the head of PR #7/);
  assert.ok(!w.fake.lines().some((l) => l.startsWith('pr edit')), 'no label call');
  w.prHead(w.head);
  assertExit(w.cli(['review-complete', '--pr', '7']), 0);
});

test('review-complete: reads the labels back and exits 3 when awaiting-review is still on the PR', (t) => {
  const w = world(t, { gh: [{ match: '^pr view 7 --json labels', stdoutJson: { labels: [{ name: 'awaiting-review' }, { name: 'agent-build' }] } }, ...GH, REMOVE_LABEL, ...REVIEW_COMMENT] });
  assertExit(w.codex(1, findingsOf()), 0);
  const r = w.cli(['review-complete', '--pr', '7']);
  assertExit(r, 3, r.stdout);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.unavailable, true);
  assert.match(r.json.message ?? r.json.reason, /awaiting-review is still/);
  assert.ok(w.fake.lines().includes('pr edit 7 --remove-label awaiting-review'));
});

test('review-complete: a clean first round does not count once a later round accepted something (R3\')', (t) => {
  const w = world(t, { gh: [...GH, REMOVE_LABEL, ...REVIEW_COMMENT] });
  const head1 = w.head; // the world already ignores .review/, so the content hash is only the code
  assertExit(w.codex(1, findingsOf(), { to: head1 }), 0);
  w.repo.write('src/c.js', 'export const c = 1;\n');
  const head2 = w.repo.commit('more');
  w.prHead(head2);
  assertExit(w.codex(2, findingsOf([finding({ title: 'late bug', file: 'src/c.js', line: 1 })]), { from: head1, to: head2 }), 0);
  assertExit(w.judge(2, { 'R2-B1': ['ACCEPT'] }), 0);
  // the "fix" removes the file again: the branch now has exactly the content round 1 reviewed, and nothing is unresolved
  w.repo.rm('src/c.js');
  const head3 = w.repo.commit('drop it');
  assertExit(w.cli(['state', 'mark-implemented', '--ids', 'R2-B1']), 0);
  w.prHead(head3);
  const outcome = w.cli(['state', 'outcome']).json;
  assert.deepEqual([outcome.pending, outcome.needsHuman, outcome.unimplemented], [[], [], []]);
  assert.equal(outcome.currentContentHash, w.state().rounds[0].contentHashAtToHead, 'same content as round 1');
  const r = w.cli(['review-complete', '--pr', '7']);
  assertExit(r, 1, r.stdout);
  assert.ok(!w.fake.lines().some((l) => l.startsWith('pr edit')));
});

// -- Codex run: timeout, late writes, empty answers

test('codex-review: a timeout kills Codex AND what it started; a late write from that run is never read', async (t) => {
  const w = world(t);
  const pidFile = join(w.scratch, 'helper.pid');
  const r = w.cli(
    ['codex-review', '--pr', '7', '--round', '1', '--base', w.base, '--head', w.head, '--effort', 'high'],
    { PIPELINE_CODEX_TIMEOUT_MS: '700', FAKE_CODEX_HANG: pidFile, FAKE_CODEX_OUTPUT: w.file('late.json', findingsOf([finding()])) },
  );
  assertExit(r, 3, r.stdout);
  assert.equal(r.json.unavailable, true);
  assert.equal(r.json.timedOut, true);
  assert.equal(r.json.reason, 'unavailable');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  await new Promise((resolve) => setTimeout(resolve, 3000)); // the helper would have written its answer at 2 s
  if (process.platform === 'win32') {
    // #116: on Windows a killed process can keep answering kill(pid, 0) for a while (the handle outlives the process, or
    // the PID is not yet reaped), so poll up to 10 s. If it still answers, the observable effect below (no late write
    // from that run) is what proves the kill; the strict ESRCH check stays on every other platform.
    const alive = () => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
    for (let waited = 0; alive() && waited < 10000; waited += 250) await new Promise((resolve) => setTimeout(resolve, 250));
  } else {
    assert.throws(() => process.kill(pid, 0), (e) => e.code === 'ESRCH', 'the helper process is gone');
  }
  assert.ok(!existsSync(w.roundFile(1, 'codex-raw.json')), 'nothing was written after the timeout');
  assert.ok(noState(w));
});

test('codex-review: an answer whose summary is empty or whitespace is exit 3 malformed', (t) => {
  const w = world(t);
  for (const summary of ['', '   \n\t']) {
    const r = w.codex(1, { summary, blocking: [], suggestions: [], worth_considering: [] });
    assertExit(r, 3, JSON.stringify(summary));
    assert.equal(r.json.reason, 'malformed');
    assert.ok(r.json.errors.some((e) => /summary/.test(e)));
  }
  assert.ok(noState(w));
});

// -- concurrency

test('codex-review: a round recorded while Codex was running is not overwritten (exit 2, the recorded round stays)', (t) => {
  const w = world(t);
  const mine = w.file('mine.json', findingsOf());
  const theirs = w.file('theirs.json', findingsOf([finding()]));
  const during = `node "${bin}" codex-review --pr 7 --round 1 --base ${w.base} --head ${w.head} --effort high`;
  const r = w.cli(
    ['codex-review', '--pr', '7', '--round', '1', '--base', w.base, '--head', w.head, '--effort', 'high'],
    { FAKE_CODEX_OUTPUT: mine, FAKE_CODEX_DURING: during, FAKE_CODEX_DURING_OUTPUT: theirs },
  );
  assertExit(r, 2, r.stdout);
  assert.equal(r.json.error, 'round-order');
  assert.match(r.json.message, /already exists/);
  assert.equal(w.state().rounds.length, 1);
  assert.deepEqual(w.state().rounds[0].items.map((i) => i.id), ['R1-B1'], 'the round that got there first is intact');
});

test('every command that changes the review state waits for the per-PR lock (and gives up with exit 2 lock-timeout)', async (t) => {
  const w = world(t, { gh: [...GH, REMOVE_LABEL, ...REVIEW_COMMENT] });
  assertExit(w.codex(1, standardFindings()), 0);
  assertExit(w.judge(1, STANDARD_JUDGE), 0);
  assert.equal(w.cli(['arbiter', 'needed', '--round', '1']).json.needed, true);
  const judgeFile = w.file('j2.json', { items: [] });
  const { tryAcquire, release } = await import('../pipeline/lib/locks.mjs');
  const { repoRoot } = await import('../pipeline/lib/repo.mjs');
  const { reviewLockName } = await import('../pipeline/lib/review-context.mjs');
  const name = reviewLockName(repoRoot(w.repo.dir), 7);
  assert.match(name, /^review-[0-9a-f]{12}-pr7$/);
  const held = tryAcquire(name, { dir: w.lockDir });
  assert.equal(held.acquired, true);
  const before = w.stateText();
  const env = { PIPELINE_LOCK_WAIT_MS: '250' };
  const mutating = [
    ['triage', 'validate', '--round', '1', '--file', judgeFile],
    ['triage', 'settle', '--id', 'R1-B1', '--result', 'bug-confirmed', '--test-cmd', 'node src/p.test.js', '--test-file', 'src/p.test.js'],
    ['triage', 'light-lane', '--round', '1'],
    ['arbiter', 'needed', '--round', '1'],
    ['arbiter', 'apply', '--round', '1', '--tag', 'whatever'],
    ['state', 'show'],
    ['state', 'mark-implemented', '--ids', 'R1-B1'],
    ['state', 'record-followup', '--id', 'R1-W1', '--url', 'https://example.com/1'],
    ['state', 'set-outcome', '--outcome', 'x'],
    ['followups', 'create', '--round', '1'],
    ['review-complete', '--pr', '7'],
  ];
  try {
    for (const args of mutating) {
      const r = w.cli(args, env);
      assertExit(r, 2, `${args.join(' ')}: ${r.stdout}`);
      assert.equal(r.json.error, 'lock-timeout', args.join(' '));
      assert.equal(w.stateText(), before, `${args.join(' ')} changed the state while the lock was held`);
    }
    const calls = w.captured().length;
    w.repo.write('src/a.js', aFile(true).replace('compute(x.y)', 'compute(x?.y)'));
    const head2 = w.repo.commit('fix');
    const cr = w.cli(['codex-review', '--pr', '7', '--round', '2', '--base', w.head, '--head', head2, '--effort', 'high'], { ...env, FAKE_CODEX_OUTPUT: w.file('r2.json', findingsOf()) });
    assertExit(cr, 2, cr.stdout);
    assert.equal(cr.json.error, 'lock-timeout');
    assert.equal(w.captured().length, calls + 1, 'Codex ran without the lock; only recording the round needs it');
    const readOnly = w.cli(['state', 'outcome'], env);
    assertExit(readOnly, 0, 'a read-only command does not need the lock');
  } finally {
    release(held.lock);
  }
  assertExit(w.cli(['state', 'set-outcome', '--outcome', 'done']), 0, 'free again once released');
});

test('codex-review: takes the lock only AFTER Codex answered, and gives up with lock-timeout when it is held then', async (t) => {
  const w = world(t);
  const { tryAcquire, release } = await import('../pipeline/lib/locks.mjs');
  const { repoRoot } = await import('../pipeline/lib/repo.mjs');
  const { reviewLockName } = await import('../pipeline/lib/review-context.mjs');
  const held = tryAcquire(reviewLockName(repoRoot(w.repo.dir), 7), { dir: w.lockDir });
  try {
    const r = w.codex(1, findingsOf(), { env: { PIPELINE_LOCK_WAIT_MS: '250' } });
    assert.equal(w.captured().length, 1, 'Codex ran without waiting for the lock');
    assertExit(r, 2, r.stdout);
    assert.equal(r.json.error, 'lock-timeout');
    assert.ok(noState(w));
  } finally {
    release(held.lock);
  }
});

// -- the arbiter proof stays pinned

test('arbiter apply: --expect-model / --expect-effort are test switches; a normal run is always pinned to claude-fable- at effort high', (t) => {
  const w = readyForArbiter(t);
  w.cli(['arbiter', 'needed', '--round', '1']);
  const asked = ['--expect-model', 'claude-opus-', '--expect-effort', 'low'];
  assertAllNeedHuman(w, arbiterRun(w, { model: 'claude-opus-5-1', effort: 'low', extraArgs: asked }), /unexpected model claude-opus-5-1/);

  const w2 = readyForArbiter(t);
  w2.cli(['arbiter', 'needed', '--round', '1']);
  const honoured = arbiterRun(w2, { model: 'claude-opus-5-1', effort: 'low', extraArgs: asked, env: { PIPELINE_TEST_MODE: '1' } });
  assertExit(honoured, 0, honoured.stdout);
  assert.equal(honoured.json.ok, true);
});

test('arbiter apply: an installed copy ignores PIPELINE_TEST_MODE (with a warning); the proof stays pinned', (t) => {
  const installed = join(realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-installed-'))), 'pipeline');
  t.after(() => rmSync(join(installed, '..'), { recursive: true, force: true }));
  cpSync(join(here, '..', 'pipeline'), installed, { recursive: true });
  writeFileSync(join(installed, 'INSTALLED.json'), '{}');
  const w = readyForArbiter(t);
  w.cli(['arbiter', 'needed', '--round', '1']);
  const asked = ['--expect-model', 'claude-opus-', '--expect-effort', 'low'];
  const run = () => arbiterRun(w, { model: 'claude-opus-5-1', effort: 'low', extraArgs: asked, env: { PIPELINE_TEST_MODE: '1', TEST_BIN: join(installed, 'bin', 'pipeline.mjs'), ...noClaudeSession() } });
  // #589: the installed copy takes REAL admission in the account's folder (no seam points it elsewhere, by design) and waits up to 20 s for it. Under load, or while a real
  // `pipeline update` or another suite's installed-copy child holds it, that wait can run out: the CLI then refuses BEFORE it reads anything (error update-in-progress, state
  // untouched), so the same call can safely be made once more. Only that one refusal is retried; any other result, or a second refusal, is asserted below as before.
  let r = run();
  if (r.json?.error === 'update-in-progress') r = run();
  assertAllNeedHuman(w, r, /unexpected model claude-opus-5-1/);
  assert.match(r.stderr, /ignoring PIPELINE_TEST_MODE/);
  // R4-6: an installed copy ignores PIPELINE_REVIEW_LEASE_DIR, so this child (a plain process: noClaudeSession) took a REAL, momentary process lease and real admission in the
  // account's folder - no opt-out is wanted here, it is the path the owner's terminal takes. It must have closed it: no proc-* file of that child's pid is left. (If a real
  // update holds admission while this runs, the child waits up to 20 s and then refuses with update-in-progress; the call is made once more, and a second refusal fails the assertions above loudly rather than hanging.)
  const leaseFolder = leasesDir();
  const left = existsSync(leaseFolder) ? readdirSync(leaseFolder).filter((n) => n.startsWith(`proc-${r.pid}-`)) : [];
  assert.deepEqual(left, [], `the child's process lease was closed (${leaseFolder})`);
});

test('arbiter apply: PIPELINE_ARBITER_MODEL_OVERRIDE never relaxes the proof, not even for a model that looks right', (t) => {
  const w = readyForArbiter(t);
  w.cli(['arbiter', 'needed', '--round', '1']);
  const r = arbiterRun(w, { meta: { model: 'claude-fable-5-1' }, env: { PIPELINE_ARBITER_MODEL_OVERRIDE: 'claude-fable-5-1' } });
  assertAllNeedHuman(w, r, /per-call model override present: claude-fable-5-1/);
  assert.match(w.item('R1-S1').final.reason, /model-proof/);
});

// -- an accepted BLOCKING item cannot be "resolved" without a code change

test('an accepted BLOCKING item cannot be marked implemented with no code change, nor cleared by an empty review round', (t) => {
  const w = world(t);
  assertExit(w.codex(1, findingsOf([finding()])), 0);
  assertExit(w.judge(1, { 'R1-B1': ['ACCEPT'] }), 0);

  const marked = w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']);
  assertExit(marked, 2, marked.stdout);
  assert.equal(marked.json.error, 'no-code-change');
  assert.ok(!w.item('R1-B1').implemented);

  // Even if it were marked, a round over the empty range would review nothing.
  const empty = w.codex(2, findingsOf(), { from: w.head, to: w.head });
  assertExit(empty, 2, empty.stdout);
  assert.equal(empty.json.error, 'empty-range');
  assert.equal(w.state().rounds.length, 1, 'no round was recorded');
  assert.equal(w.captured().length, 1, 'Codex was not even run for the empty range');
  assert.equal(w.cli(['state', 'outcome']).json.clean, false);
});

test('codex-review: a later round whose content is unchanged since the last round is refused when items were accepted; a real fix passes', (t) => {
  const w = world(t);
  assertExit(w.codex(1, findingsOf([finding()])), 0);
  assertExit(w.judge(1, { 'R1-B1': ['ACCEPT'] }), 0);
  // An empty commit moves HEAD but not the content.
  w.repo.git(['commit', '-q', '--allow-empty', '-m', 'nothing']);
  const head2 = w.repo.git(['rev-parse', 'HEAD']).trim();
  const r = w.codex(2, findingsOf(), { from: w.head, to: head2 });
  assertExit(r, 2, r.stdout);
  assert.equal(r.json.error, 'empty-range');

  w.repo.write('src/a.js', aFile(true).replace('compute(x.y)', 'compute(x?.y)'));
  const head3 = w.repo.commit('fix');
  assertExit(w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']), 0);
  assertExit(w.codex(2, findingsOf(), { from: w.head, to: head3 }), 0);
});

// ---- a pure main merge after accepted items (#1658): baseOnly, never empty-range -------------------------------

test('codex-review: an accepted item fixed and re-reviewed clean, then a pure main merge: the next round is baseOnly (not empty-range)', (t) => {
  const w = worldIgnoringReview(t);
  assertExit(w.codex(1, findingsOf([finding()])), 0);
  assertExit(w.judge(1, { 'R1-B1': ['ACCEPT'] }), 0);
  const head2 = fixA(w);
  assertExit(w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']), 0);
  assertExit(w.codex(2, findingsOf(), { from: w.head, to: head2 }), 0);
  const calls = w.captured().length;

  const merged = mergeMainInto(w, { 'src/from-main.js': 'export const other = 1;\n' }); // clean merge, no PR hunk touched
  const r = w.codex(3, findingsOf([finding()]), { from: head2, to: merged });
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.baseOnly, true);
  assert.equal(w.captured().length, calls, 'Codex was not run');
  assert.deepEqual([w.state().rounds[2].n, w.state().rounds[2].baseOnly, w.state().rounds[2].toHead], [3, true, merged]);
  const outcome = w.cli(['state', 'outcome']);
  assert.deepEqual([outcome.json.clean, outcome.json.coverageValid, outcome.json.reviewedRounds], [true, true, 2], JSON.stringify(outcome.json));
});

test('codex-review: an accepted item NOT fixed, then a pure main merge: the round is baseOnly, the accept stays open, the fix round runs normally', (t) => {
  const w = worldIgnoringReview(t);
  assertExit(w.codex(1, findingsOf([finding()])), 0);
  assertExit(w.judge(1, { 'R1-B1': ['ACCEPT'] }), 0);
  const merged = mergeMainInto(w, { 'src/from-main.js': 'export const other = 1;\n' });
  const calls = w.captured().length;
  const r = w.codex(2, findingsOf(), { from: w.head, to: merged });
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.baseOnly, true, 'not refused as empty-range');
  assert.equal(w.captured().length, calls);

  const open = w.cli(['state', 'outcome']);
  assertExit(open, 0);
  assert.equal(open.json.clean, false);
  assert.deepEqual(open.json.newAccepted, ['R1-B1']);
  assert.deepEqual(open.json.unimplemented, ['R1-B1']);
  // main's commit is not a fix
  const nope = w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']);
  assertExit(nope, 2, nope.stdout);
  assert.equal(nope.json.error, 'no-code-change');

  const head3 = fixA(w);
  assertExit(w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']), 0);
  const r3 = w.codex(3, findingsOf(), { from: merged, to: head3 });
  assertExit(r3, 0, r3.stderr + r3.stdout);
  assert.equal(r3.json.baseOnly, undefined);
  assert.equal(w.captured().length, calls + 1, 'Codex ran for the fix round');
  const outcome = w.cli(['state', 'outcome']);
  assert.deepEqual([outcome.json.clean, outcome.json.reviewedRounds, outcome.json.rounds], [true, 2, 3]);
});
