// End-to-end tests for the review-loop commands (codex-review, triage, arbiter, state, review-complete, followups).
// They spawn the real CLI against a real throwaway git repo, a scripted fake gh and a scripted fake codex, because the
// contract the ship skill depends on is the pair (stdout JSON, exit code) plus the .review/ files left behind.
// Part 1 of 4, split from cli-review.test.mjs to balance the CI shards; shared helpers: helpers/cli-review-world.mjs.
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

// ---- review-context ---------------------------------------------------------------------------

test('excerptWindow: +/-20 lines around a line, clamped; line 0 means the whole file (or its head for display)', () => {
  const text = Array.from({ length: 100 }, (_, i) => `l${i + 1}`).join('\n') + '\n';
  const mid = excerptWindow(text, 50);
  assert.deepEqual([mid.start, mid.end, mid.lines.length], [30, 70, 41]);
  assert.deepEqual([excerptWindow(text, 3).start, excerptWindow(text, 3).end], [1, 23]);
  assert.equal(excerptWindow(text, 100).end, 100);
  assert.equal(excerptWindow(text, 0).lines.length, 100);
  assert.equal(excerptWindow(text, 0, { maxLines: 41 }).lines.length, 41);
  assert.equal(excerptWindow(text, 500), null, 'a line past the end of the file has no excerpt');
  assert.equal(excerptWindow(null, 5), null);
  assert.equal(excerptWindow('', 5), null);
});

test('currentContentHash: hashes against origin/<default> when that ref exists, else the local default branch', async (t) => {
  const w = world(t);
  const { config } = await loadConfig(w.repo.dir);
  assert.equal(reviewBaseRef(w.repo.dir, config), 'refs/heads/main');
  const local = currentContentHash(w.repo.dir, config);
  assert.equal(local, contentHash('main', 'HEAD', { cwd: w.repo.dir, exclude: ['docs/agent-log.md'] }));

  // origin/main one commit behind the base the branch forked from: the hash must now include that extra commit.
  w.repo.checkout('main');
  w.repo.write('src/c.js', 'export const c = 1;\n');
  const ahead = w.repo.commit('main moves on');
  w.repo.checkout('feat/x');
  w.repo.git(['rebase', '-q', 'main']);
  w.repo.git(['update-ref', 'refs/remotes/origin/main', w.base]);
  assert.equal(reviewBaseRef(w.repo.dir, config), 'refs/remotes/origin/main');
  const viaOrigin = currentContentHash(w.repo.dir, config);
  assert.equal(viaOrigin, contentHash('origin/main', 'HEAD', { cwd: w.repo.dir, exclude: ['docs/agent-log.md'] }));
  assert.notEqual(viaOrigin, contentHash('main', 'HEAD', { cwd: w.repo.dir, exclude: ['docs/agent-log.md'] }));
  assert.ok(ahead);
});

// ---- codex-review -----------------------------------------------------------------------------

test('codex-review: a valid findings file becomes round 1 with ids, state, codex.json and codex.md', async (t) => {
  const w = world(t);
  const r = w.codex(1, standardFindings());
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.round, 1);
  assert.deepEqual(r.json.counts, { blocking: 1, suggestions: 2, worth_considering: 1 });
  assert.equal(r.json.preRuled, 0);
  assert.equal(r.json.lightLane, false, 'a 60+ line change is off the light lane');
  assert.equal(r.json.path, join(w.repo.dir, '.review', 'round-1'));

  const state = w.state();
  assert.deepEqual([state.pr, state.repo, state.branch, state.risk, state.lightLane, state.maxRounds], [7, 'acme/widgets', 'feat/x', 'low', false, 2]);
  assert.equal(r.json.reviewer, 'judge', 'a low-risk PR with no sensitive path is triaged by the judge');
  assert.equal(state.reviewer, 'judge');
  assert.deepEqual([state.rounds[0].fableRequired, state.rounds[0].codexModel, state.rounds[0].forkPoint], [undefined, 'gpt-6.2-astra', w.base]);
  const round = state.rounds[0];
  assert.deepEqual([round.n, round.fromHead, round.toHead], [1, w.base, w.head]);
  assert.equal(round.contentHashAtToHead, contentHash('main', 'HEAD', { cwd: w.repo.dir, exclude: ['docs/agent-log.md'] }));
  assert.deepEqual(round.items.map((i) => i.id), ['R1-B1', 'R1-S1', 'R1-S2', 'R1-W1']);
  assert.ok(round.items.every((i) => /^[0-9a-f]{40}$/.test(i.fingerprint) && !i.final));

  const codexJson = JSON.parse(readFileSync(w.roundFile(1, 'codex.json'), 'utf8'));
  assert.equal(codexJson.findings.blocking[0].title, 'Missing null check');
  assert.equal(codexJson.items.length, 4);
  const md = readFileSync(w.roundFile(1, 'codex.md'), 'utf8');
  assert.match(md, /# Codex review — round 1/);
  assert.match(md, /R1-B1/);
  const patch = readFileSync(w.roundFile(1, 'diff.patch'), 'utf8');
  assert.match(patch, /\+export const v12 = compute\(x\.y\);/);
  assert.ok(existsSync(w.roundFile(1, 'codex-raw.json')));

  // Codex was invoked read-only on the repo, with the schema, the pinned model/effort, and the prompt on stdin.
  const [call] = w.captured();
  const at = (flag) => call.argv[call.argv.indexOf(flag) + 1];
  assert.equal(call.argv[0], 'exec');
  assert.match(at('-o'), /[\\/]round-1[\\/]attempt-[0-9a-f]{16}[\\/]codex-raw\.json$/, 'Codex writes into the attempt\'s own folder; the winner\'s copy is round-1/codex-raw.json');
  assert.equal(at('-C'), w.repo.dir);
  assert.match(at('--output-schema'), /codex-findings\.schema\.json$/);
  assert.ok(call.argv.includes('model="gpt-6.2-astra"') && call.argv.includes('model_reasoning_effort="high"'));
  assert.equal(call.argv.at(-1), '-');
  assert.match(call.stdin, /PR: #7/);
  assert.match(call.stdin, /Title: Add compute/);
  assert.match(call.stdin, new RegExp(`git diff ${w.base}\\.\\.${w.head}`));
  assert.match(call.stdin, /Review round: 1/);
  assert.match(call.stdin, /Risk level: low/);
  assert.doesNotMatch(call.stdin, /Prior rulings/);
});

test('codex-review: a large binary document in the range is left out of diff.patch and named in it and in the prompt', (t) => {
  const w = world(t, { light: true });
  const { repo } = w;
  // the sheet lands on main first, so this PR (merged with main) DELETES it, as the 234 MB spreadsheet PR did
  repo.checkout('main');
  repo.write('data/old.xlsx', randomBytes(5 * 1024 * 1024));
  const fork = repo.commit('the sheet lands on main');
  repo.checkout('feat/x');
  repo.git(['merge', '-q', '--no-edit', 'main']);
  repo.rm('data/old.xlsx');
  const head = repo.commit('drop the sheet');
  w.prHead(head);

  const r = w.codex(1, findingsOf(), { from: fork, to: head });
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual([w.state().rounds[0].fromHead, w.state().rounds[0].toHead], [fork, head]);
  const patch = readFileSync(w.roundFile(1, 'diff.patch'), 'utf8');
  assert.ok(patch.length < 20_000, `diff.patch is ${patch.length} bytes`);
  assert.match(patch, /\+export const v12 = compute\(x\.y\);/, 'the rest of the diff is there');
  assert.doesNotMatch(patch, /GIT binary patch/);
  const note = 'data/old.xlsx — large binary (5.0 MiB), deleted, content not shown';
  assert.ok(patch.includes(note), 'the patch names the skipped file');
  const [call] = w.captured();
  assert.match(call.stdin, /## Large binary files/);
  assert.ok(call.stdin.includes(`- ${note}`), 'and so does the prompt');
  assert.equal(w.state().rounds[0].contentHashAtToHead, contentHash('main', 'HEAD', { cwd: repo.dir, exclude: ['docs/agent-log.md'] }));
});
test('codex-review: --model must be the configured (trusted) model; a bad effort or model is a usage error before anything runs', (t) => {
  const w = world(t, { yml: withModel('gpt-test-1') });
  const ok = w.codex(1, findingsOf(), { extra: ['--model', 'gpt-test-1'] });
  assertExit(ok, 0);
  assert.ok(w.captured()[0].argv.includes('model="gpt-test-1"'));
  assert.equal(w.state().rounds[0].items.length, 0, 'an empty review is a valid round with no items');

  const w2 = world(t, { yml: withModel('gpt-test-1') });
  const badEffort = w2.cli(['codex-review', '--pr', '7', '--round', '1', '--base', w2.base, '--head', w2.head, '--effort', 'ultra']);
  assertExit(badEffort, 2);
  const badModel = w2.cli(['codex-review', '--pr', '7', '--round', '1', '--base', w2.base, '--head', w2.head, '--effort', 'high', '--model', 'x"; rm']);
  assertExit(badModel, 2);
  assert.match(badModel.stderr + badModel.stdout, /invalid model/, 'a malformed --model is a usage error about its shape, not a model-mismatch');
  assert.equal(w2.captured().length, 0);
  assert.ok(!existsSync(join(w2.repo.dir, '.review', 'state.json')));
});

test('codex-review: a well-formed --model that is not the trusted model is refused with model-mismatch (exit 2), before anything runs (#389)', (t) => {
  const w = world(t, { yml: withModel('gpt-test-1') });
  const r = w.codex(1, findingsOf(), { extra: ['--model', 'gpt-other-9'] });
  assertExit(r, 2);
  assert.equal(r.json.error, 'model-mismatch');
  assert.equal(r.json.expected, 'gpt-test-1');
  assert.equal(w.captured().length, 0);
  assert.ok(!existsSync(join(w.repo.dir, '.review', 'state.json')));
});

test('codex-review: a working-tree review.codex_model change is ignored: Codex runs with the base config\'s model, and --model naming the edited one is refused (#389)', (t) => {
  const w = world(t, { yml: withModel('gpt-test-1') });
  writeFileSync(join(w.repo.dir, '.claude', 'pipeline.yml'), withModel('gpt-evil-2'));
  const refused = w.codex(1, findingsOf(), { extra: ['--model', 'gpt-evil-2'] });
  assertExit(refused, 2);
  assert.deepEqual([refused.json.error, refused.json.expected], ['model-mismatch', 'gpt-test-1']);
  const ok = w.codex(1, findingsOf());
  assertExit(ok, 0, ok.stderr + ok.stdout);
  assert.ok(w.captured()[0].argv.includes('model="gpt-test-1"'), 'the trusted model ran');
  assert.equal(w.state().rounds[0].codexModel, 'gpt-test-1');
});

test('codex-review: quota, auth and a missing binary are exit 3 with unavailable:true and a reason; no state is written', (t) => {
  const w = world(t);
  const quota = w.codex(1, findingsOf(), { env: { FAKE_CODEX_EXIT: '1', FAKE_CODEX_TURN_FAILED: 'You hit your usage limit. Try again later.' } });
  assertExit(quota, 3);
  assert.equal(quota.json.ok, false);
  assert.equal(quota.json.unavailable, true);
  assert.equal(quota.json.reason, 'quota');
  assert.match(quota.json.detail, /usage limit/);

  const auth = w.codex(1, findingsOf(), { env: { FAKE_CODEX_EXIT: '1', FAKE_CODEX_TURN_FAILED: 'Not logged in. Run codex login.' } });
  assertExit(auth, 3);
  assert.equal(auth.json.reason, 'auth');

  const other = w.codex(1, findingsOf(), { env: { FAKE_CODEX_EXIT: '2', FAKE_CODEX_STDERR: 'segfault' } });
  assertExit(other, 3);
  assert.equal(other.json.reason, 'error');

  const missing = w.cli(
    ['codex-review', '--pr', '7', '--round', '1', '--base', w.base, '--head', w.head, '--effort', 'high'],
    { PIPELINE_CODEX: join(w.scratch, 'no-such-codex-binary') },
  );
  assertExit(missing, 3);
  assert.equal(missing.json.unavailable, true);
  assert.equal(missing.json.reason, 'unavailable');

  assert.ok(!existsSync(join(w.repo.dir, '.review', 'state.json')), 'a failed Codex run must not leave a round behind');
});

test('codex-review: each real Codex run, answered or failed, is logged in the usage ledger; a ledger that cannot be written only warns', (t) => {
  const w = world(t);
  const file = join(w.scratch, 'usage', 'codex-usage.jsonl');
  const env = { PIPELINE_CODEX_USAGE_FILE: file };
  assert.deepEqual(ledgerOf(file), []);

  const failed = w.codex(1, findingsOf(), { env: { ...env, FAKE_CODEX_EXIT: '1', FAKE_CODEX_STDERR: 'ERROR: You hit your usage limit.' } });
  assertExit(failed, 3);
  assert.equal(failed.json.warnings, undefined, 'a written ledger adds no warning');
  const ok = w.codex(1, standardFindings(), { env });
  assertExit(ok, 0, ok.stderr + ok.stdout);

  const lines = ledgerOf(file);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((l) => l.ok), [false, true]);
  for (const l of lines) {
    assert.deepEqual([l.v, l.kind, l.repo, l.pr, l.round, l.effort, l.model], [1, 'review', 'acme/widgets', 7, 1, 'high', 'gpt-6.2-astra']);
    assert.ok(Math.abs(Date.parse(l.ts) - Date.now()) < 60_000, 'ts is the run time');
    assert.equal('resolutionOnly' in l, false);
  }
});

test('codex-review: an unwritable usage ledger never fails the round: a warning in the reply (also when Codex fails)', (t) => {
  const w = world(t);
  const blocked = join(w.scratch, 'plain-file');
  writeFileSync(blocked, 'x'); // the ledger's folder is a regular file
  const env = { PIPELINE_CODEX_USAGE_FILE: join(blocked, 'codex-usage.jsonl') };
  const failed = w.codex(1, findingsOf(), { env: { ...env, FAKE_CODEX_EXIT: '1', FAKE_CODEX_STDERR: 'segfault' } });
  assertExit(failed, 3);
  assert.equal(failed.json.reason, 'error');
  assert.match(failed.json.warnings[0], /^codex usage ledger not written/);
  const ok = w.codex(1, standardFindings(), { env });
  assertExit(ok, 0, ok.stderr + ok.stdout);
  assert.equal(ok.json.round, 1);
  assert.match(ok.json.warnings[0], /^codex usage ledger not written/);
  assert.equal(w.state().rounds.length, 1, 'the round is recorded all the same');
});

test('codex-review: output that is not valid findings is exit 3 reason malformed, never "no findings"', (t) => {
  const w = world(t);
  const garbage = w.file('garbage.json', 'this is not json {');
  const a = w.cli(['codex-review', '--pr', '7', '--round', '1', '--base', w.base, '--head', w.head, '--effort', 'high'], { FAKE_CODEX_OUTPUT: garbage });
  assertExit(a, 3);
  assert.equal(a.json.unavailable, true);
  assert.equal(a.json.reason, 'malformed');

  const wrongShape = w.codex(1, { summary: 'ok', blocking: [{ title: 'x' }], suggestions: [], worth_considering: [] });
  assertExit(wrongShape, 3);
  assert.equal(wrongShape.json.reason, 'malformed');
  assert.ok(wrongShape.json.errors.length > 0);

  const missingKeys = w.codex(1, { summary: 'ok' });
  assertExit(missingKeys, 3);
  assert.equal(missingKeys.json.reason, 'malformed');
  assert.ok(!existsSync(join(w.repo.dir, '.review', 'state.json')));
});

test('codex-review: a leftover raw file from an earlier run is never read as this run\'s answer', (t) => {
  const w = world(t);
  const stale = w.roundFile(1, 'codex-raw.json');
  mkdirSync(dirname(stale), { recursive: true });
  writeFileSync(stale, JSON.stringify(findingsOf([finding()])));
  const old = new Date(Date.now() - 3600e3);
  utimesSync(stale, old, old);
  const r = w.cli(['codex-review', '--pr', '7', '--round', '1', '--base', w.base, '--head', w.head, '--effort', 'high'], { FAKE_CODEX_NO_WRITE: '1' });
  assertExit(r, 3);
  assert.equal(r.json.reason, 'malformed');
  assert.ok(!existsSync(join(w.repo.dir, '.review', 'state.json')));
  // Codex now writes into the attempt's own folder (cp #256), so a file left at round-1/codex-raw.json is never even the output path: it is not read, and an
  // attempt that fails publishes nothing over it. The remove-before-run guard for the attempt's own output path is pinned in codex-exec.test.mjs.
  const attempt = readdirSync(join(w.repo.dir, '.review', 'round-1')).find((n) => n.startsWith('attempt-'));
  assert.ok(!existsSync(join(w.repo.dir, '.review', 'round-1', attempt, 'codex-raw.json')), 'nothing was read from, or written to, the attempt folder');
});

test('codex-review: an answer Codex writes during the run is read even when its source bytes are old (fake writes fresh, not a Windows copy)', (t) => {
  // windows-latest flake: the fake copied a findings file written before a slow CLI start, CopyFileW kept that old
  // mtime, and the freshness check rejected the run as "codex output file predates this run".
  const w = world(t);
  const src = w.file('findings-old.json', findingsOf([finding()]));
  const old = new Date(Date.now() - 3600e3);
  utimesSync(src, old, old);
  const r = w.cli(['codex-review', '--pr', '7', '--round', '1', '--base', w.base, '--head', w.head, '--effort', 'high'], { FAKE_CODEX_OUTPUT: src });
  assertExit(r, 0);
});

test('codex-review: rounds must arrive in order; an existing round, a skipped round and another PR\'s state are exit 2', (t) => {
  const w = world(t);
  const skipped = w.codex(2, findingsOf());
  assertExit(skipped, 2);
  assert.equal(skipped.json.error, 'round-order');
  assert.equal(w.captured().length, 0, 'Codex is not even started');
  assert.ok(!existsSync(join(w.repo.dir, '.review')), 'a refused round leaves nothing behind');

  assertExit(w.codex(1, findingsOf()), 0);
  const again = w.codex(1, findingsOf());
  assertExit(again, 2);
  assert.match(again.json.message, /already exists/);
  assertExit(w.codex(3, findingsOf()), 2);
  assert.equal(w.captured().length, 1);

  const otherPr = w.cli(['codex-review', '--pr', '8', '--round', '2', '--base', w.base, '--head', w.head, '--effort', 'high'], { FAKE_CODEX_OUTPUT: w.file('x.json', findingsOf()) });
  assertExit(otherPr, 2);
  assert.equal(otherPr.json.error, 'state-pr-mismatch');
});

test('codex-review: --head must be the checked-out HEAD (the content hash is of HEAD); a moved base ref resolves to full SHAs', (t) => {
  const w = world(t);
  const wrong = w.codex(1, findingsOf(), { to: w.base });
  assertExit(wrong, 2);
  assert.equal(wrong.json.error, 'head-mismatch');
  assert.equal(w.captured().length, 0);

  const short = w.codex(1, findingsOf(), { from: w.base.slice(0, 10), to: w.head.slice(0, 10) });
  assertExit(short, 0, short.stderr + short.stdout);
  assert.deepEqual([w.state().rounds[0].fromHead, w.state().rounds[0].toHead], [w.base, w.head]);
});

test('codex-review: GitHub being unreachable is exit 3 with unavailable:true, reason github', (t) => {
  const w = world(t, { gh: [{ match: '.', code: 1, stderr: 'HTTP 502' }] });
  const r = w.codex(1, findingsOf());
  assertExit(r, 3);
  assert.equal(r.json.unavailable, true);
  assert.equal(r.json.reason, 'github');
  assert.equal(w.captured().length, 0);
});

test('codex-review: a counted round needs the local history to match the published one (stale-history, unpublished-history, unreadable); no comment passes', (t) => {
  const w = worldIgnoringReview(t, { yml: `${pipelineYml()}review:\n  max_rounds: 5\n` });
  const advance = (n) => {
    w.repo.write(`src/h${n}.js`, `export const h${n} = ${n};\n`);
    return w.repo.commit(`more ${n}`);
  };
  const refuse = (n, from, to, error, re) => {
    const stateBefore = w.stateText();
    const calls = w.captured().length;
    const r = w.codex(n, findingsOf(), { from, to });
    assertExit(r, 2, r.stdout + r.stderr);
    assert.equal(r.json.error, error);
    assert.match(r.json.message, re);
    assert.equal(w.stateText(), stateBefore, 'the state is unchanged');
    assert.equal(w.captured().length, calls, 'Codex was not started');
    assert.ok(noRoundWritten(w, n), 'no round folder was left behind');
  };

  // no triage comment (a new PR): round 1 runs
  assertExit(w.codex(1, findingsOf()), 0);
  const s1 = w.state();
  const head2 = advance(2);
  // the PR holds exactly what this copy has: in sync, the round runs
  w.setGh([...GH, commentsEntry([triageNote(s1)])]);
  assertExit(w.codex(2, findingsOf(), { from: w.head, to: head2 }), 0);
  const s2 = w.state();
  const head3 = advance(3);

  // an earlier publish failed: local holds round 2, the PR only round 1
  refuse(3, head2, head3, 'unpublished-history', /pipeline comment --pr 7 --kind triage/);
  // the PR holds a grant on round 2 that this copy lacks / another round 1 / a longer history
  const withGrant = { ...s2, rounds: s2.rounds.map((r) => (r.n === 2 ? { ...r, admission: 'owner', ownerGrant: { grantId: 'g', k: 2, quote: 'extra round', ownerTs: '2026-11-05T10:00:00.000Z' } } : r)) };
  w.setGh([...GH, commentsEntry([triageNote(withGrant)])]);
  refuse(3, head2, head3, 'stale-history', /owner grant on round 2.*pipeline state show --pr 7/);
  const other = { ...s2, rounds: s2.rounds.map((r) => (r.n === 1 ? { ...r, toHead: 'e'.repeat(40) } : r)) };
  w.setGh([...GH, commentsEntry([triageNote(other)])]);
  refuse(3, head2, head3, 'stale-history', /pipeline state show --pr 7/);
  const longer = { ...s2, rounds: [...s2.rounds, { ...s2.rounds[1], n: 3 }] };
  w.setGh([...GH, commentsEntry([triageNote(longer)])]);
  refuse(3, head2, head3, 'stale-history', /round 3.*pipeline state show --pr 7/);
  // a comment with no readable state
  w.setGh([...GH, commentsEntry([triageNote(s2, { body: `${MARKERS.triage}\nnot a state` })])]);
  refuse(3, head2, head3, 'history-unreadable', /pipeline comment --pr 7 --kind triage/);
  // somebody else's triage comment is no history
  w.setGh([...GH, commentsEntry([triageNote(longer, { user: { login: 'mallory' } })])]);
  const ok = w.codex(3, findingsOf(), { from: head2, to: head3 });
  assertExit(ok, 0, ok.stdout + ok.stderr);
  assert.equal(w.state().rounds.length, 3);
});

test('codex-review: a fresh worktree (no local state) cannot start round 1 over a published history', (t) => {
  const donor = worldIgnoringReview(t);
  assertExit(donor.codex(1, findingsOf()), 0);
  const published = donor.state();
  const w = worldIgnoringReview(t, { gh: [...GH, commentsEntry([triageNote(published)])] });
  const r = w.codex(1, findingsOf());
  assertExit(r, 2, r.stdout + r.stderr);
  assert.equal(r.json.error, 'stale-history');
  assert.match(r.json.message, /round 1.*pipeline state show --pr 7/);
  assert.equal(w.captured().length, 0, 'Codex was not started');
  assert.ok(!existsSync(join(w.repo.dir, '.review')), 'a refused round leaves nothing behind');
});

test('codex-review: rulings from earlier rounds go into the next prompt and pre-rule an unchanged finding (cache)', (t) => {
  const w = world(t);
  assertExit(w.codex(1, standardFindings()), 0);
  assertExit(w.judge(1, { ...STANDARD_JUDGE, 'R1-B1': ['REJECT', 'high', DISPUTED] }), 0, 'the judge disputes the bug and a test can decide');
  const settled = w.cli(settleArgs(w, 'R1-B1', 'bug-disproved', { file: 'src/a.test.js', output: 'compute(undefined) returns 0' }));
  assertExit(settled, 0);

  // A second commit that leaves a.js (lines 1-32 around the finding) and b.js alone.
  w.repo.write('src/c.js', 'export const c = 1;\n');
  const head2 = w.repo.commit('more');
  const r = w.codex(2, findingsOf([finding(), finding({ title: 'A brand new problem', file: 'src/c.js', line: 1 })]), { from: w.head, to: head2 });
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.preRuled, 1);
  assert.deepEqual(r.json.counts, { blocking: 2, suggestions: 0, worth_considering: 0 });

  const prompt = w.captured()[1].stdin;
  assert.match(prompt, /## Prior rulings/);
  assert.match(prompt, /- R1-B1: Missing null check — REJECT: test disproved: src\/a\.test\.js \(exit 0\): compute\(undefined\) returns 0/);
  assert.match(prompt, /Review round: 2/);
  assert.match(prompt, new RegExp(`git diff ${w.head}\\.\\.${head2}`));

  const same = w.item('R2-B1');
  assert.equal(same.final.by, 'cache');
  assert.equal(same.final.decision, 'REJECT');
  assert.equal(w.item('R2-B2').final ?? null, null);
  assert.equal(w.state().rounds[1].toHead, head2);
});

test('codex-review: a round after no merge reviews previous toHead..head, recorded as the previous head', (t) => {
  const w = worldIgnoringReview(t);
  assertExit(w.codex(1, findingsOf()), 0);
  w.repo.write('src/c.js', 'export const c = 1;\n');
  const head2 = w.repo.commit('more');
  const r = w.codex(2, findingsOf(), { from: w.head, to: head2 });
  assertExit(r, 0, r.stderr + r.stdout);
  const round = w.state().rounds[1];
  assert.deepEqual([round.fromHead, round.reviewBase, round.reviewBaseKind], [w.head, w.head, 'previous']);
  assert.match(patchOf(w, 2), /src\/c\.js/);
  assert.doesNotMatch(patchOf(w, 2), /src\/a\.js/);
  assert.doesNotMatch(w.captured()[1].stdin, /merged in from the base branch/);
  assert.equal(w.state().rounds[0].reviewBase, w.base, 'round 1 is reviewed against the merge base');
});

test('codex-review: commits merged in from the base branch are not in the next round\'s diff, the prompt or the record', (t) => {
  const w = worldIgnoringReview(t);
  assertExit(w.codex(1, findingsOf()), 0);
  mergeMainInto(w, { 'src/from-main.js': 'export const other = "someone else\'s PR";\n' });
  w.repo.write('src/c.js', 'export const c = 1;\n');
  const head2 = w.repo.commit('later pr commit');
  const r = w.codex(2, findingsOf(), { from: w.head, to: head2 });
  assertExit(r, 0, r.stderr + r.stdout);

  const patch = patchOf(w, 2);
  assert.doesNotMatch(patch, /from-main\.js/, 'main\'s file is not shown to Codex');
  assert.match(patch, /src\/c\.js/, 'the PR\'s own later commit is');
  const round = w.state().rounds[1];
  assert.equal(round.reviewBaseKind, 'synthetic');
  assert.equal(round.fromHead, w.head);
  assert.equal(round.toHead, head2);
  assert.match(round.reviewBase, /^[0-9a-f]{40,64}$/);
  const prompt = w.captured()[1].stdin;
  assert.match(prompt, new RegExp(`git diff ${round.reviewBase}\\.\\.${head2}`));
  assert.match(prompt, /merged in from the base branch are excluded/);
});

test('codex-review: a round that only merged the base branch in is recorded as baseOnly and Codex is not run', (t) => {
  const w = worldIgnoringReview(t);
  assertExit(w.codex(1, findingsOf()), 0);
  const merged = mergeMainInto(w, { 'src/from-main.js': 'export const other = 1;\n' });
  const calls = w.captured().length;
  const r = w.codex(2, findingsOf([finding()]), { from: w.head, to: merged });
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.baseOnly, true);
  assert.deepEqual(r.json.counts, { blocking: 0, suggestions: 0, worth_considering: 0 });
  assert.equal(w.captured().length, calls, 'the Codex stub was not called');
  const round = w.state().rounds[1];
  assert.deepEqual([round.n, round.baseOnly, round.items, round.toHead, round.reviewBaseKind], [2, true, [], merged, 'synthetic']);

  // Nothing pending and the content is what round 1 reviewed: the outcome treats it like a clean round.
  const outcome = w.cli(['state', 'outcome']);
  assertExit(outcome, 0);
  assert.equal(outcome.json.clean, true, JSON.stringify(outcome.json));
  assert.equal(outcome.json.coverageValid, true);
});

// ---- the redraft advice moved to `comment --kind triage` (test/review-publish.test.mjs): a review round with nothing to fix must not advise a redraft ----------

test('codex-review: no redraft advice and no extra PR read, even for a READY PR of a repo that iterates in draft (the advice is the triage publication\'s)', (t) => {
  const yml = pipelineYml().replace('  guard_checks: false\n', '  guard_checks: false\n  draft_while_iterating: true\n');
  const w = worldIgnoringReview(t, { yml, gh: [{ match: '^pr view 7 --json isDraft$', stdoutJson: { isDraft: false } }, ...GH] });
  const r = w.codex(1, findingsOf());
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.ok, true);
  assert.equal('redraftAdvice' in r.json, false);
  assert.equal('warnings' in r.json, false);
  assert.deepEqual(w.fake.lines().filter((l) => /^pr view 7 --json isDraft$/.test(l)), []);
});

test('codex-review: a base-only round past review.max_rounds is recorded (it does not count), a round with PR changes is still capped', (t) => {
  const w = worldIgnoringReview(t, { yml: `${pipelineYml()}review:\n  max_rounds: 1\n` });
  assertExit(w.codex(1, findingsOf()), 0);
  const merged = mergeMainInto(w, { 'src/from-main.js': 'export const other = 1;\n' });
  const calls = w.captured().length;
  const r = w.codex(2, findingsOf(), { from: w.head, to: merged });
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.baseOnly, true);
  assert.equal(w.captured().length, calls, 'Codex did not run');
  assert.deepEqual([w.state().rounds[1].n, w.state().rounds[1].baseOnly], [2, true]);
  const outcome = w.cli(['state', 'outcome']);
  assert.deepEqual([outcome.json.clean, outcome.json.coverageValid, outcome.json.reachedMax, outcome.json.rounds, outcome.json.reviewedRounds], [true, true, false, 2, 1]);

  // a second update-branch is still not a reviewed round
  const merged2 = mergeMainInto(w, { 'src/from-main2.js': 'export const other2 = 1;\n' });
  const again = w.codex(3, findingsOf(), { from: merged, to: merged2 });
  assertExit(again, 0, again.stderr + again.stdout);
  assert.equal(again.json.baseOnly, true);

  // the PR's own change on top of main's is a real round: past the cap, refused, and nothing is written for it
  w.repo.write('src/c.js', 'export const c = 1;\n');
  const head4 = w.repo.commit('own change');
  const capped = w.codex(4, findingsOf(), { from: merged2, to: head4 });
  assertExit(capped, 2, capped.stdout);
  assert.equal(capped.json.error, 'round-cap');
  assert.equal(w.captured().length, calls, 'Codex never ran for the capped round');
  assert.equal(existsSync(w.roundFile(4, 'diff.patch')), false, 'a refused round leaves no files');
  assert.equal(w.state().rounds.length, 3);
});

test('codex-review: main merged in before an accepted fix is made does not strand the confirm round', (t) => {
  const w = worldIgnoringReview(t, { yml: `${pipelineYml()}review:\n  max_rounds: 1\n` });
  assertExit(w.codex(1, findingsOf([finding()])), 0);
  assertExit(w.judge(1, { 'R1-B1': ['ACCEPT'] }), 0);
  // "Update branch" with a change next to the PR's lines: the content hash moves, the PR's own patch is empty
  const merged = mergeMainInto(w, { 'src/a.js': aFile(false).replace('export const v9 = 9;', 'export const v9 = 90;') });
  const r2 = w.codex(2, findingsOf(), { from: w.head, to: merged });
  assertExit(r2, 0, r2.stderr + r2.stdout);
  assert.equal(r2.json.baseOnly, true);

  w.repo.write('src/a.js', readFileSync(join(w.repo.dir, 'src/a.js'), 'utf8').replace('compute(x.y)', 'compute(x?.y)'));
  const head3 = w.repo.commit('fix');
  assertExit(w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']), 0);
  const outcome = w.cli(['state', 'outcome']);
  assert.deepEqual([outcome.json.extraRound, outcome.json.reachedMax, outcome.json.reviewedRounds, outcome.json.rounds], [true, false, 1, 2], JSON.stringify(outcome.json));
  const r3 = w.codex(3, findingsOf(), { from: merged, to: head3 });
  assertExit(r3, 0, r3.stderr + r3.stdout);
  assert.equal(w.state().rounds.length, 3);
});

// Failure caught: a conflicting merge plus an own commit made Codex review the whole PR against the new base (the #1901 round 16 shape), main's own changes drowning the resolution.
test('codex-review: a conflicting merge plus an own commit is a counted conflict round on the PR\'s own changes, never main\'s own changes', (t) => {
  const w = worldIgnoringReview(t);
  assertExit(w.codex(1, findingsOf()), 0);
  // Main edits the very line (src/a.js 12) that round 1 reviewed the PR changing, so merging what was reviewed with the new
  // base conflicts; the real merge resolves it by hand.
  const mainA = aFile(false).replace('v12 = 12', 'v12 = 1200');
  const merged = mergeMainInto(w, { 'src/a.js': mainA, 'src/from-main.js': 'export const other = 1;\n' }, { resolve: { 'src/a.js': aFile(true) } });
  w.repo.write('src/c.js', 'export const c = 1;\n');
  const head2 = w.repo.commit('later pr commit');
  const r = w.codex(2, findingsOf(), { from: w.head, to: head2 });
  assertExit(r, 0, r.stderr + r.stdout);
  const round = w.state().rounds[1];
  assert.equal(round.reviewBaseKind, 'conflict');
  assert.notEqual(round.reviewBase, w.repo.git(['merge-base', 'main', head2]).trim(), 'the base is the marker tree, not the fork point');
  const patch = patchOf(w, 2);
  assert.doesNotMatch(patch, /from-main\.js/);
  assert.match(patch, /src\/a\.js/, 'the resolution of the conflict is in the patch');
  assert.match(patch, /src\/c\.js/);
  assert.doesNotMatch(patch, /src\/big\.js/, 'the PR\'s earlier, already reviewed files are not re-sent');
  assert.ok(merged);
});

test('codex-review: a PR that targets a branch other than the default branch excludes nothing, and a merge-only round still runs Codex', (t) => {
  const gh = GH.map((e) => (e.match === '^pr view 7' ? { ...e, stdoutJson: { ...e.stdoutJson, baseRefName: 'release' } } : e));
  const w = worldIgnoringReview(t, { gh });
  w.repo.git(['branch', 'release', w.base]);
  assertExit(w.codex(1, findingsOf()), 0);
  const merged = mergeMainInto(w, { 'src/from-release.js': 'export const x = 1;\n' }, { branch: 'release' });
  const r = w.codex(2, findingsOf(), { from: w.head, to: merged });
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.baseOnly, undefined);
  assert.equal(w.captured().length, 2, 'Codex ran');
  assert.match(patchOf(w, 2), /from-release\.js/, 'the author-chosen base branch\'s code is reviewed');
  assert.equal(w.state().rounds[1].reviewBaseKind, 'previous');
});

// #398: "is this PR's base the default branch" is answered by the trusted default branch (origin/HEAD), never by the working-tree config's default_branch, which the PR
// can edit: naming its own base branch there must not make that branch's merged-in commits count as "from the default branch" and drop out of the next round.
test('codex-review: a PR whose own pipeline.yml names its base branch as default_branch still has that branch\'s merged-in commits reviewed (#398)', (t) => {
  const gh = GH.map((e) => (e.match === '^pr view 7' ? { ...e, stdoutJson: { ...e.stdoutJson, baseRefName: 'release' } } : e));
  const w = worldIgnoringReview(t, { gh, featFiles: { '.claude/pipeline.yml': `${pipelineYml()}default_branch: release\n` } });
  w.repo.git(['branch', 'release', w.base]);
  // the remote's own default branch (what origin/HEAD names) is main: the anchor the PR cannot edit
  w.repo.git(['update-ref', 'refs/remotes/origin/main', w.base]);
  w.repo.git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  assertExit(w.codex(1, findingsOf()), 0);
  const merged = mergeMainInto(w, { 'src/from-release.js': 'export const x = 1;\n' }, { branch: 'release' });
  const r = w.codex(2, findingsOf(), { from: w.head, to: merged });
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.baseOnly, undefined, 'not a base-only round');
  assert.equal(w.captured().length, 2, 'Codex ran');
  assert.match(patchOf(w, 2), /from-release\.js/, 'the PR-chosen base branch\'s code is reviewed');
  assert.equal(w.state().rounds[1].reviewBaseKind, 'previous');
});

test('codex-review: code merged in from a branch other than the PR\'s base is reviewed (only the default branch is left out)', (t) => {
  const w = worldIgnoringReview(t);
  w.repo.git(['branch', 'side', w.base]);
  assertExit(w.codex(1, findingsOf()), 0);
  const merged = mergeMainInto(w, { 'src/from-side.js': 'export const x = 1;\n' }, { branch: 'side' });
  const r = w.codex(2, findingsOf(), { from: w.head, to: merged });
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.baseOnly, undefined, 'not a base-only round');
  assert.equal(w.captured().length, 2, 'Codex ran');
  assert.match(patchOf(w, 2), /from-side\.js/);
});

test('codex-review: an evil merge (extra changes inside the merge commit) is in the diff, and is not a base-only round', (t) => {
  const w = worldIgnoringReview(t);
  assertExit(w.codex(1, findingsOf()), 0);
  const merged = mergeMainInto(w, { 'src/from-main.js': 'export const other = 1;\n' }, { evil: { 'src/smuggled.js': 'export const evil = true;\n' } });
  const r = w.codex(2, findingsOf(), { from: w.head, to: merged });
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.baseOnly, undefined);
  assert.equal(w.captured().length, 2, 'Codex ran');
  const patch = patchOf(w, 2);
  assert.match(patch, /smuggled\.js/, 'what the merge commit itself adds is reviewed');
  assert.doesNotMatch(patch, /from-main\.js/, 'what really came from main is not');
  assert.equal(w.state().rounds[1].reviewBaseKind, 'synthetic');
});

test('codex-review: a stale origin/<default> can only widen the reviewed range', (t) => {
  const w = worldIgnoringReview(t);
  assertExit(w.codex(1, findingsOf()), 0);
  // origin/main still points at the old fork point (no fetch could update it) although main was merged in.
  w.repo.git(['update-ref', 'refs/remotes/origin/main', w.base]);
  const merged = mergeMainInto(w, { 'src/from-main.js': 'export const other = 1;\n' });
  const r = w.codex(2, findingsOf(), { from: w.head, to: merged });
  assertExit(r, 0, r.stderr + r.stdout);
  assert.match(patchOf(w, 2), /from-main\.js/, 'the merged-in commits are not known to be main\'s, so they are shown');
  assert.equal(r.json.baseOnly, undefined);
});

test('codex-review: when the code around a ruled finding changed, the ruling is not reused', (t) => {
  const w = world(t);
  assertExit(w.codex(1, findingsOf([finding()])), 0);
  assertExit(w.judge(1, { 'R1-B1': ['REJECT', 'high', DISPUTED] }), 0);
  assertExit(w.cli(settleArgs(w, 'R1-B1', 'bug-disproved')), 0);
  w.repo.write('src/a.js', aFile(true).replace('v13 = 13', 'v13 = 13 + 1'));
  const head2 = w.repo.commit('touch the excerpt');
  const r = w.codex(2, findingsOf([finding()]), { from: w.head, to: head2 });
  assertExit(r, 0);
  assert.equal(r.json.preRuled, 0, 'the excerpt changed, so the fingerprint differs and the item is reopened');
});

test('triage validate --from-tag: the judge JSON is read from the transcript and the decisions are applied', (t) => {
  const w = world(t);
  assertExit(w.codex(1, standardFindings()), 0);
  const projects = judgeTranscript(w, STANDARD_JUDGE);
  const r = w.cli(['triage', 'validate', '--round', '1', '--from-tag', JUDGE_TAG, '--projects-dir', projects]);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.deepEqual(r.json.counts, { ACCEPT: 1, 'FOLLOW-UP': 1, REJECT: 2 });
  assert.equal(r.json.judgeProof.ok, true, JSON.stringify(r.json.judgeProof));
  assert.deepEqual(r.json.settled.sort(), ['R1-B1', 'R1-W1']);
  assert.deepEqual(r.json.unsettled.sort(), ['R1-S1', 'R1-S2'], 'dismissed SUGGESTIONs wait for the arbiter');

  assert.deepEqual(w.item('R1-B1').final, { decision: 'ACCEPT', by: 'judge', needsHuman: false, reason: 'judge: ACCEPT R1-B1' });
  assert.equal(w.item('R1-W1').final.decision, 'FOLLOW-UP');
  assert.equal(w.item('R1-S1').final ?? null, null);
  assert.equal(w.item('R1-S1').judge.decision, 'REJECT');
  assert.equal(w.item('R1-S2').judge.confidence, 'low');
  assert.ok(existsSync(w.roundFile(1, 'triage.json')));
});

test('triage validate: a judge transcript on the wrong model is only a recorded warning, the decisions still apply', (t) => {
  const w = world(t);
  assertExit(w.codex(1, standardFindings()), 0);
  const projects = judgeTranscript(w, STANDARD_JUDGE, { model: 'claude-opus-5-5' });
  const r = w.cli(['triage', 'validate', '--round', '1', '--from-tag', JUDGE_TAG, '--projects-dir', projects]);
  assertExit(r, 0);
  assert.equal(r.json.judgeProof.ok, false);
  assert.ok(r.json.judgeProof.errors.some((e) => /unexpected model claude-opus-5-5/.test(e)));
  assert.equal(w.item('R1-B1').final.decision, 'ACCEPT');
});

test('triage validate: unknown, duplicate or missing ids are exit 1 with the errors and the state is untouched', (t) => {
  const w = world(t);
  assertExit(w.codex(1, standardFindings()), 0);
  const before = w.stateText();
  const bad = w.judge(1, { 'R1-B1': ['ACCEPT'], 'R1-S1': ['REJECT'], 'R1-S2': ['REJECT'], 'R1-W9': ['ACCEPT'] });
  assertExit(bad, 1);
  assert.equal(bad.json.ok, false);
  assert.ok(bad.json.errors.includes('unknown id R1-W9'));
  assert.ok(bad.json.errors.includes('missing id R1-W1'));
  assert.equal(w.stateText(), before);
  assert.ok(!existsSync(w.roundFile(1, 'triage.json')));

  const notJson = w.cli(['triage', 'validate', '--round', '1', '--file', w.file('nope.txt', 'I think everything is fine.')]);
  assertExit(notJson, 1);
  assert.match(notJson.json.errors[0], /no JSON found/);
  assert.equal(w.stateText(), before);

  const badDecision = w.judge(1, { 'R1-B1': ['MAYBE'], 'R1-S1': ['REJECT'], 'R1-S2': ['REJECT'], 'R1-W1': ['ACCEPT'] });
  assertExit(badDecision, 1);
  assert.ok(badDecision.json.errors.some((e) => /R1-B1: decision must be one of/.test(e)));
});

test('triage validate: usage and environment errors (no locator, both locators, missing round, unknown tag)', (t) => {
  const w = world(t);
  assertExit(w.cli(['triage', 'validate', '--round', '1']), 2, 'no state yet');
  assertExit(w.codex(1, standardFindings()), 0);
  assertExit(w.cli(['triage', 'validate', '--round', '1']), 2);
  assertExit(w.cli(['triage', 'validate', '--round', '1', '--file', 'a', '--from-tag', 'b']), 2);
  assertExit(w.cli(['triage', 'validate', '--round', '5', '--file', w.file('j.json', { items: [] })]), 2);
  assertExit(w.cli(['triage', 'validate', '--round', '1', '--from-tag', 'pipeline-judge R1 deadbeef', '--projects-dir', join(w.scratch, 'none')]), 2);
  assertExit(w.cli(['triage', 'bogus']), 2);
  assertExit(w.cli(['triage']), 2);
});

test('triage validate: items already ruled (cache, test) are not the judge\'s to decide', (t) => {
  const w = world(t);
  assertExit(w.codex(1, findingsOf([finding()], [finding({ title: 'Rename helper', file: 'src/b.js', line: 3 })])), 0);
  editState(w, (st) => { st.rounds[0].items[0].final = { decision: 'ACCEPT', by: 'test', needsHuman: false, reason: 'test confirmed: a.test.js fails' }; });
  const wholeRound = w.judge(1, { 'R1-B1': ['REJECT'], 'R1-S1': ['ACCEPT'] });
  assertExit(wholeRound, 1, 'R1-B1 already has a final, so judging it is an unknown id');
  const ok = w.judge(1, { 'R1-S1': ['ACCEPT'] });
  assertExit(ok, 0);
  assert.equal(w.item('R1-B1').final.by, 'test');
});

test('triage validate: PIPELINE_TEST_FORCE_ARBITER=1 keeps every judged item for the arbiter', (t) => {
  const w = world(t);
  assertExit(w.codex(1, standardFindings()), 0);
  const items = Object.entries(STANDARD_JUDGE).map(([id, [decision, confidence = 'high']]) => ({
    id, decision, confidence, reason: 'r', disputedBug: false, settleTest: { possible: false, plan: '' },
  }));
  const r = w.cli(['triage', 'validate', '--round', '1', '--file', w.file('j.json', { items })], { PIPELINE_TEST_FORCE_ARBITER: '1' });
  assertExit(r, 0);
  assert.deepEqual(r.json.settled, []);
  assert.deepEqual(r.json.unsettled.sort(), ['R1-B1', 'R1-S1', 'R1-S2', 'R1-W1']);
});

test('triage settle: a test result settles the item and outranks the judge; bad input is exit 2', (t) => {
  const w = world(t);
  assertExit(w.codex(1, standardFindings()), 0);
  // S1 and S2 are the judge's REJECTs that a test can decide: disputed bugs with a possible settle test
  assertExit(w.judge(1, { ...STANDARD_JUDGE, 'R1-S1': ['REJECT', 'high', DISPUTED], 'R1-S2': ['REJECT', 'low', DISPUTED] }), 0);

  const r = w.cli(settleArgs(w, 'R1-S1', 'bug-confirmed', { file: 'src/b.test.js', output: 'expected 3 got 4' }));
  assertExit(r, 0);
  assert.equal(r.json.final.decision, 'ACCEPT');
  assert.equal(r.json.final.by, 'test');
  assert.equal(w.item('R1-S1').test.status, 'bug-confirmed');
  assert.match(w.item('R1-S1').final.reason, /b\.test\.js \(exit 1\): expected 3 got 4/);

  assert.equal(w.cli(settleArgs(w, 'R1-S2', 'bug-disproved')).json.final.decision, 'REJECT');
  assertExit(w.cli(['triage', 'settle', '--id', 'R1-S2', '--result', 'maybe', '--test-cmd', 'node src/proof.test.js', '--test-file', 'src/proof.test.js']), 2);
  assertExit(w.cli(settleArgs(w, 'R1-B1', 'bug-confirmed')), 1, 'not a disputed bug');
  assertExit(w.cli(settleArgs(w, 'R9-B1', 'bug-confirmed')), 2);
  assertExit(w.cli(['triage', 'settle', '--id', 'R1-S2', '--result', 'bug-confirmed']), 2, 'a result needs a test to run');
  assertExit(w.cli(['triage', 'settle', '--id', 'R1-S2', '--result', 'bug-confirmed', '--evidence', 'trust me']), 2, 'free-text evidence is no longer accepted');
  assertExit(w.cli(['triage', 'settle', '--result', 'bug-confirmed', '--test-cmd', 'x', '--test-file', 'y']), 2);
});

test('triage light-lane: closes untriaged WORTH CONSIDERING items; refused unless the review is on the light lane', (t) => {
  const w = world(t, { light: true });
  assertExit(w.codex(1, findingsOf([], [], [finding({ title: 'Idea', category: 'other' })])), 0);
  const r = w.cli(['triage', 'light-lane', '--round', '1']);
  assertExit(r, 0);
  assert.deepEqual(r.json.marked, ['R1-W1']);
  assert.deepEqual(w.item('R1-W1').final, { decision: 'REJECT', by: 'light-lane', needsHuman: false, reason: 'light lane — not triaged' });
  assert.equal(w.state().lightLane, true);

  const w2 = world(t);
  assertExit(w2.codex(1, findingsOf([], [], [finding({ title: 'Idea', category: 'other' })])), 0);
  const refused = w2.cli(['triage', 'light-lane', '--round', '1']);
  assertExit(refused, 1);
  assert.equal(refused.json.ok, false);
  assert.equal(w2.item('R1-W1').final ?? null, null);
});

test('arbiter needed: nothing to arbitrate is {needed:false}; otherwise writes the digest-stamped input with excerpts', (t) => {
  const w = world(t);
  assertExit(w.codex(1, standardFindings()), 0);
  const untriaged = w.cli(['arbiter', 'needed', '--round', '1']);
  assertExit(untriaged, 0);
  assert.deepEqual(untriaged.json, { needed: false, items: [], mode: 'dispute' });
  assert.ok(!existsSync(w.roundFile(1, 'arbiter-input.md')));

  assertExit(w.judge(1, STANDARD_JUDGE), 0);
  const r = w.cli(['arbiter', 'needed', '--round', '1']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(r.json.needed, true);
  assert.deepEqual(r.json.items, ['R1-S1', 'R1-S2']);
  assert.equal(r.json.inputPath, w.roundFile(1, 'arbiter-input.md'));
  assert.match(r.json.digest, /^[0-9a-f]{64}$/);
  assert.equal(r.json.digest8, r.json.digest.slice(0, 8));
  assert.equal(r.json.tag, `pipeline-arbiter R1 ${r.json.digest8}`);

  const text = readFileSync(r.json.inputPath, 'utf8');
  const m = /^ROUND: 1\nINPUT-DIGEST: ([0-9a-f]{64})\n\n([\s\S]*)$/.exec(text);
  assert.ok(m, 'header, blank line, body');
  assert.equal(m[1], r.json.digest);
  assert.equal(sha256(m[2]), r.json.digest, 'the digest is the sha256 of the body');
  for (const needle of [
    '## R1-S1', '## R1-S2', 'SUGGESTION', 'maintainability', 'Rename helper', 'src/b.js:3',
    'Codex detail:', 'x is dereferenced before it is checked', 'Codex reasoning:', 'compute(x.y) throws',
    'REJECT (confidence high) - judge: REJECT R1-S1', 'REJECT (confidence low)', 'Test result: none',
    `Code at the reviewed head ${w.head.slice(0, 12)}, src/b.js lines 1-8:`, 'export const w3 = 3;',
  ]) assert.ok(text.includes(needle), `missing ${needle}`);
  assert.ok(!text.includes('## R1-B1') && !text.includes('## R1-W1'), 'only items that need the arbiter are in the input');

  const stored = w.state().rounds[0].arbiter;
  assert.deepEqual(stored, { inputDigest: r.json.digest, items: ['R1-S1', 'R1-S2'], tag: r.json.tag, mode: 'dispute' });
  assert.equal(w.cli(['arbiter', 'needed', '--round', '1']).json.digest, r.json.digest, 'deterministic for unchanged state');
});

test('arbiter needed on a dispute round whose recorded toHead this clone lacks: an error, no input written (never "the file does not exist at the reviewed head")', (t) => {
  const w = world(t);
  assertExit(w.codex(1, standardFindings()), 0);
  assertExit(w.judge(1, STANDARD_JUDGE), 0);
  const st = w.state();
  st.rounds[0].toHead = 'f'.repeat(40);
  writeFileSync(join(w.repo.dir, '.review', 'state.json'), JSON.stringify(st));
  const before = w.stateText();
  const r = w.cli(['arbiter', 'needed', '--round', '1']);
  assertExit(r, 2, r.stderr + r.stdout);
  assert.equal(r.json.error, 'head-unavailable');
  assert.ok(!existsSync(w.roundFile(1, 'arbiter-input.md')), 'no input without evidence');
  assert.equal(w.stateText(), before);

  // A retry after a failed model proof clears that ruling only once the commit is there: a refused retry must not lose the recorded failure.
  const w2 = world(t);
  assertExit(w2.codex(1, standardFindings()), 0);
  assertExit(w2.judge(1, { ...STANDARD_JUDGE, 'R1-B1': ['REJECT'] }), 0);
  const st2 = w2.state();
  st2.rounds[0].toHead = 'f'.repeat(40);
  st2.rounds[0].items.find((i) => i.id === 'R1-B1').final = { decision: 'REJECT', by: 'arbiter', needsHuman: true, reason: 'model-proof failed' };
  writeFileSync(join(w2.repo.dir, '.review', 'state.json'), JSON.stringify(st2));
  const before2 = w2.stateText();
  const r2 = w2.cli(['arbiter', 'needed', '--round', '1']);
  assertExit(r2, 2, r2.stderr + r2.stdout);
  assert.equal(r2.json.error, 'head-unavailable');
  assert.equal(w2.stateText(), before2, 'the cleared model-proof final is not saved when the retry is refused');

  // The same retry with the commit present but the input file unwritable (a directory sits where it goes): the failed write must not have erased the prior final.
  const w3 = world(t);
  assertExit(w3.codex(1, standardFindings()), 0);
  assertExit(w3.judge(1, { ...STANDARD_JUDGE, 'R1-B1': ['REJECT'] }), 0);
  const st3 = w3.state();
  st3.rounds[0].items.find((i) => i.id === 'R1-B1').final = { decision: 'REJECT', by: 'arbiter', needsHuman: true, reason: 'model-proof failed' };
  writeFileSync(join(w3.repo.dir, '.review', 'state.json'), JSON.stringify(st3));
  mkdirSync(w3.roundFile(1, 'arbiter-input.md'), { recursive: true });
  const before3 = w3.stateText();
  const r3 = w3.cli(['arbiter', 'needed', '--round', '1']);
  assert.notEqual(r3.status, 0, 'the input write fails: ' + r3.stderr + r3.stdout);
  assert.equal(w3.stateText(), before3, 'the cleared model-proof final is saved only after the arbiter input is written');
});

test('arbiter needed: the excerpt is +/-20 lines of the file at the reviewed head, numbered, and cannot break out of its fence', (t) => {
  const w = world(t);
  w.repo.write('src/f.js', Array.from({ length: 60 }, (_, i) => (i === 29 ? '// ``` closes a naive fence' : `const f${i + 1} = ${i + 1};`)).join('\n') + '\n');
  const head2 = w.repo.commit('add f');
  assertExit(w.codex(1, findingsOf([finding({ title: 'Look at f', file: 'src/f.js', line: 30 })]), { to: head2 }), 0);
  assertExit(w.judge(1, { 'R1-B1': ['REJECT'] }), 0);
  const r = w.cli(['arbiter', 'needed', '--round', '1']);
  const text = readFileSync(r.json.inputPath, 'utf8');
  assert.match(text, /Code at the reviewed head [0-9a-f]{12}, src\/f\.js lines 10-50:/);
  assert.match(text, /^10 \| const f10 = 10;$/m);
  assert.match(text, /^50 \| const f50 = 50;$/m);
  assert.doesNotMatch(text, /const f9 = 9;/);
  assert.doesNotMatch(text, /const f51 = 51;/);
  assert.match(text, /\n````\n10 \| /, 'the fence is longer than the backticks inside the excerpt');
});

test('arbiter needed on the light lane: a dismissed SUGGESTION is settled by the judge, only a dismissed BLOCKING item goes to the arbiter', (t) => {
  const w = world(t, { light: true });
  assertExit(w.codex(1, standardFindings()), 0);
  assert.equal(w.state().lightLane, true);
  assertExit(w.judge(1, STANDARD_JUDGE), 0);
  assert.equal(w.item('R1-S1').final.by, 'judge');
  assert.equal(w.cli(['arbiter', 'needed', '--round', '1']).json.needed, false);

  const w2 = world(t, { light: true });
  assertExit(w2.codex(1, standardFindings()), 0);
  assertExit(w2.judge(1, { ...STANDARD_JUDGE, 'R1-B1': ['REJECT'] }), 0);
  assert.deepEqual(w2.cli(['arbiter', 'needed', '--round', '1']).json.items, ['R1-B1']);
});

test('arbiter needed --force (and PIPELINE_TEST_FORCE_ARBITER=1) sends every judged-but-unsettled item', (t) => {
  const w = world(t);
  assertExit(w.codex(1, standardFindings()), 0);
  assert.deepEqual(w.cli(['arbiter', 'needed', '--round', '1', '--force']).json.items, ['R1-B1', 'R1-S1', 'R1-S2', 'R1-W1']);
  assert.deepEqual(w.cli(['arbiter', 'needed', '--round', '1'], { PIPELINE_TEST_FORCE_ARBITER: '1' }).json.items, ['R1-B1', 'R1-S1', 'R1-S2', 'R1-W1']);
});

test('arbiter apply: a Fable transcript for this round and digest is proven, its rulings applied, proof files written', (t) => {
  const w = readyForArbiter(t);
  const needed = w.cli(['arbiter', 'needed', '--round', '1']);
  const r = arbiterRun(w);
  assertExit(r, 0, r.stderr + JSON.stringify(r.json));
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.errors, []);
  assert.equal(r.json.tag, needed.json.tag);
  assert.deepEqual(r.json.items.map((i) => [i.id, i.ruling, i.needsHuman]), [['R1-S1', 'REJECT', false], ['R1-S2', 'ACCEPT', false]]);

  const s1 = w.item('R1-S1');
  assert.equal(s1.final.by, 'arbiter');
  assert.equal(s1.final.decision, 'REJECT');
  assert.equal(s1.final.needsHuman, false);
  assert.equal(s1.arbiter.confidence, 'high');
  assert.match(s1.arbiter.transcript, /agent-a1\.jsonl$/);
  assert.equal(w.item('R1-S2').final.decision, 'ACCEPT');
  assert.equal(w.item('R1-B1').final.by, 'judge', 'items the arbiter never saw keep the judge\'s decision');

  const rulings = JSON.parse(readFileSync(w.roundFile(1, 'rulings.json'), 'utf8'));
  assert.equal(rulings.proofOk, true);
  assert.equal(rulings.rulings.length, 2);
  const proof = JSON.parse(readFileSync(w.roundFile(1, 'model-proof.json'), 'utf8'));
  assert.equal(proof.ok, true);
  assert.equal(proof.round, 1);
  assert.equal(proof.tag, needed.json.tag);
  assert.deepEqual(proof.models, { 'claude-fable-5-2': 1 });
  assert.deepEqual(proof.efforts, { high: 1 });
  assert.deepEqual(proof.errors, []);
  assert.match(proof.transcript, /agent-a1\.jsonl$/);
  assert.equal(w.state().rounds[0].arbiter.proofOk, true);
  assert.deepEqual(w.state().rounds[0].modelProof, { transcript: proof.transcript, models: { 'claude-fable-5-2': 1 }, effort: 'high' }, 'the proof summary travels in the state');

});

test('arbiter apply: the agent id can be given instead of the tag', (t) => {
  const w = readyForArbiter(t);
  w.cli(['arbiter', 'needed', '--round', '1']);
  const needed = w.state().rounds[0].arbiter;
  const projects = installTranscript(w, {
    agentId: 'abc123', jsonl: transcript({ prompt: promptFor(needed.inputDigest), text: fenced(SORT_RULINGS) }),
    meta: { agentType: 'arbiter', description: 'some other description' },
  });
  const r = w.cli(['arbiter', 'apply', '--round', '1', '--agent-id', 'abc123', '--projects-dir', projects]);
  assertExit(r, 0, r.stderr + JSON.stringify(r.json));
  assertExit(w.cli(['arbiter', 'apply', '--round', '1', '--agent-id', 'abc123', '--tag', 'x']), 2, 'only one locator');
});

test('arbiter apply: a <synthetic> (API error) transcript is exit 1 and every arbitrated item needsHuman', (t) => {
  const w = readyForArbiter(t);
  const needed = w.cli(['arbiter', 'needed', '--round', '1']).json;
  const jsonl = readFileSync(join(here, 'fixtures', 'transcripts', 'synthetic-error.jsonl'), 'utf8')
    .replace('abc123def456abc123def456abc123def456abc123def456abc123def456abcd', needed.digest);
  const r = arbiterRun(w, { jsonl });
  assertAllNeedHuman(w, r, /unexpected model <synthetic>/);
  assert.ok(r.json.errors.some((e) => /API error/.test(e)));
});

test('arbiter apply: a non-Fable model, or the wrong effort, is exit 1 needsHuman', (t) => {
  const w = readyForArbiter(t);
  w.cli(['arbiter', 'needed', '--round', '1']);
  assertAllNeedHuman(w, arbiterRun(w, { model: 'claude-opus-5-1' }), /unexpected model claude-opus-5-1/);
  const w2 = readyForArbiter(t);
  w2.cli(['arbiter', 'needed', '--round', '1']);
  assertAllNeedHuman(w2, arbiterRun(w2, { effort: 'low' }), /unexpected effort low/);
});

test('arbiter apply: a correct Fable transcript that answered a different digest or round is exit 1 needsHuman', (t) => {
  const w = readyForArbiter(t);
  w.cli(['arbiter', 'needed', '--round', '1']);
  const wrongDigest = arbiterRun(w, { prompt: promptFor('0'.repeat(64)) });
  assertAllNeedHuman(w, wrongDigest, /INPUT-DIGEST/);

  const w2 = readyForArbiter(t);
  const needed = w2.cli(['arbiter', 'needed', '--round', '1']).json;
  assertAllNeedHuman(w2, arbiterRun(w2, { prompt: promptFor(needed.digest, 2) }), /ROUND: 1/);

  // "ROUND: 1" must not be satisfied by "ROUND: 12", nor the digest by a longer line that merely starts with it
  const w3 = readyForArbiter(t);
  const n3 = w3.cli(['arbiter', 'needed', '--round', '1']).json;
  assertAllNeedHuman(w3, arbiterRun(w3, { prompt: `ROUND: 12\nINPUT-DIGEST: ${n3.digest}\nrule` }), /ROUND: 1/);
  const w4 = readyForArbiter(t);
  const n4 = w4.cli(['arbiter', 'needed', '--round', '1']).json;
  assertAllNeedHuman(w4, arbiterRun(w4, { prompt: `ROUND: 1\nINPUT-DIGEST: ${n4.digest}ff\nrule` }), /INPUT-DIGEST/);
});

test('arbiter apply: arbiter-input.md edited after `arbiter needed` no longer matches the stored digest', (t) => {
  const w = readyForArbiter(t);
  const needed = w.cli(['arbiter', 'needed', '--round', '1']).json;
  writeFileSync(needed.inputPath, readFileSync(needed.inputPath, 'utf8').replace('Rename helper', 'Rename helper (edited)'));
  assertAllNeedHuman(w, arbiterRun(w), /body no longer matches/);

  const w2 = readyForArbiter(t);
  const n2 = w2.cli(['arbiter', 'needed', '--round', '1']).json;
  rmSync(n2.inputPath);
  assertAllNeedHuman(w2, arbiterRun(w2), /arbiter-input\.md is missing/);
});

test('arbiter apply: rulings that do not cover exactly the needed ids, or are not JSON, are exit 1 needsHuman', (t) => {
  const w = readyForArbiter(t);
  w.cli(['arbiter', 'needed', '--round', '1']);
  const missing = fenced({ rulings: [SORT_RULINGS.rulings[0]] });
  assertAllNeedHuman(w, arbiterRun(w, { text: missing }), /rulings: missing id R1-S2/);

  const w2 = readyForArbiter(t);
  w2.cli(['arbiter', 'needed', '--round', '1']);
  assertAllNeedHuman(w2, arbiterRun(w2, { text: 'I rule: accept both.' }), /no JSON found/);

  const w3 = readyForArbiter(t);
  w3.cli(['arbiter', 'needed', '--round', '1']);
  const bad = fenced({ rulings: [{ ...SORT_RULINGS.rulings[0], ruling: 'maybe' }, SORT_RULINGS.rulings[1]] });
  assertAllNeedHuman(w3, arbiterRun(w3, { text: bad }), /R1-S1: ruling must be one of/);
  const unverified = JSON.parse(readFileSync(w3.roundFile(1, 'rulings.json'), 'utf8'));
  assert.equal(unverified.rulings[0].reasoning, 'unverified');
});

test('arbiter apply: a per-call model override fails the proof (proof 6), with or without PIPELINE_ARBITER_MODEL_OVERRIDE', (t) => {
  // proof switch #6: the override model does not exist; the agent errors; nothing may be trusted
  const synthetic = (digest) => readFileSync(join(here, 'fixtures', 'transcripts', 'synthetic-error.jsonl'), 'utf8')
    .replace('abc123def456abc123def456abc123def456abc123def456abc123def456abcd', digest);

  const w = readyForArbiter(t);
  const needed = w.cli(['arbiter', 'needed', '--round', '1']).json;
  const withEnv = arbiterRun(w, {
    jsonl: synthetic(needed.digest), meta: { model: 'claude-nonexistent-0' }, env: { PIPELINE_ARBITER_MODEL_OVERRIDE: 'claude-nonexistent-0' },
  });
  assertAllNeedHuman(w, withEnv, /unexpected model <synthetic>/);
  assert.ok(withEnv.json.errors.some((e) => /per-call model override present/.test(e)), 'the switch never excuses an override: the proof fails for it as well');

  const w2 = readyForArbiter(t);
  const n2 = w2.cli(['arbiter', 'needed', '--round', '1']).json;
  const withoutEnv = arbiterRun(w2, { jsonl: synthetic(n2.digest), meta: { model: 'claude-nonexistent-0' } });
  assertAllNeedHuman(w2, withoutEnv, /per-call model override present: claude-nonexistent-0/);

  // an override that silently swapped a GOOD-looking model in without the switch is also refused
  const w3 = readyForArbiter(t);
  w3.cli(['arbiter', 'needed', '--round', '1']);
  assertAllNeedHuman(w3, arbiterRun(w3, { meta: { model: 'claude-fable-5-1' } }), /per-call model override present/);
});

test('arbiter apply: no transcript is exit 2 and leaves the state untouched; no `arbiter needed` yet is exit 2', (t) => {
  const w = readyForArbiter(t);
  assertExit(w.cli(['arbiter', 'apply', '--round', '1']), 2, 'needed has not run');
  w.cli(['arbiter', 'needed', '--round', '1']);
  const before = w.stateText();
  const r = w.cli(['arbiter', 'apply', '--round', '1', '--projects-dir', join(w.scratch, 'none')]);
  assertExit(r, 2);
  assert.equal(r.json.error, 'not-found');
  assert.equal(w.stateText(), before);
});

test('arbiter apply: an arbiter that wants a human (low confidence) is final but needsHuman, and a test result is never overridden', (t) => {
  const w = readyForArbiter(t, undefined, { ...STANDARD_JUDGE, 'R1-S1': ['REJECT', 'high', DISPUTED] });
  w.cli(['arbiter', 'needed', '--round', '1']);
  assertExit(w.cli(settleArgs(w, 'R1-S1', 'bug-confirmed')), 0);
  const text = fenced({
    rulings: [
      { id: 'R1-S1', ruling: 'REJECT', confidence: 'high', reasoning: 'covered' },
      { id: 'R1-S2', ruling: 'ACCEPT', confidence: 'low', reasoning: 'depends on product intent' },
    ],
  });
  const r = arbiterRun(w, { text });
  assertExit(r, 0);
  assert.equal(w.item('R1-S1').final.by, 'test', 'a test outranks the arbiter');
  assert.equal(w.item('R1-S2').final.needsHuman, true);
  assert.equal(w.item('R1-S2').final.decision, 'ACCEPT');
});

// ---- state ------------------------------------------------------------------------------------

test('state show: filters by round, accepted, disputed and needs-human; mark-implemented drops an item from accepted', (t) => {
  const w = world(t);
  assertExit(w.codex(1, standardFindings()), 0);
  const noState = world(t);
  assertExit(noState.cli(['state', 'show']), 2);

  const disputed = { disputedBug: true, settleTest: { possible: true, plan: 'a.test.js: expect compute(undefined) to throw' } };
  assertExit(w.judge(1, { ...STANDARD_JUDGE, 'R1-S1': ['REJECT', 'high', disputed] }), 0);
  const all = w.cli(['state', 'show']);
  assert.equal(all.json.count, 4);
  assert.equal(all.json.recovered, false);
  assert.equal(all.json.pr, 7);
  assert.deepEqual(w.cli(['state', 'show', '--accepted']).json.items.map((i) => i.id), ['R1-B1']);
  assert.deepEqual(w.cli(['state', 'show', '--disputed']).json.items.map((i) => i.id), ['R1-S1']);
  assert.deepEqual(w.cli(['state', 'show', '--needs-human']).json.items, []);
  assert.deepEqual(w.cli(['state', 'show', '--round', '1']).json.items.length, 4);
  assertExit(w.cli(['state', 'show', '--round', '2']), 2);

  // settling the disputed bug removes it from --disputed
  assertExit(w.cli(settleArgs(w, 'R1-S1', 'bug-confirmed')), 0);
  assert.deepEqual(w.cli(['state', 'show', '--disputed']).json.items, []);
  assert.deepEqual(w.cli(['state', 'show', '--accepted']).json.items.map((i) => i.id), ['R1-B1', 'R1-S1']);

  w.repo.write('src/a.js', aFile(true).replace('compute(x.y)', 'compute(x?.y)'));
  w.repo.commit('fix');
  // --pr N (like discard-round): a PR the state does not belong to is refused before anything is marked; the right one (or none) marks
  const beforeMark = w.stateText();
  const wrongPr = w.cli(['state', 'mark-implemented', '--ids', 'R1-B1,R1-S1', '--pr', '8']);
  assertExit(wrongPr, 2);
  assert.equal(wrongPr.json.error, 'state-pr-mismatch');
  assert.equal(w.stateText(), beforeMark, 'a mismatched --pr marks nothing');
  const marked = w.cli(['state', 'mark-implemented', '--ids', 'R1-B1,R1-S1', '--pr', '7']);
  assertExit(marked, 0);
  assert.deepEqual(w.cli(['state', 'show', '--accepted']).json.items, []);
  assert.equal(w.item('R1-B1').implemented, true);

  const before = w.stateText();
  assertExit(w.cli(['state', 'mark-implemented', '--ids', 'R1-W1']), 2, 'only an ACCEPTED item can be implemented');
  assertExit(w.cli(['state', 'mark-implemented', '--ids', 'R1-B1,R9-B9']), 2);
  assertExit(w.cli(['state', 'mark-implemented', '--ids', '']), 2);
  assert.equal(w.stateText(), before, 'a bad id list changes nothing');
});

test('state mark-implemented: files that came in from merging the base branch do not count as the fix', (t) => {
  const w = worldIgnoringReview(t);
  assertExit(w.codex(1, findingsOf([finding()])), 0);
  assertExit(w.judge(1, { 'R1-B1': ['ACCEPT'] }), 0);
  mergeMainInto(w, { 'src/from-main.js': 'export const other = 1;\n' });
  w.repo.write('src/a.test.js', 'console.log("only a test");\n');
  w.repo.commit('add a test');
  const refused = w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']);
  assertExit(refused, 2, refused.stderr + refused.stdout);
  assert.match(refused.json.message, /only test files changed \(src\/a\.test\.js\)/, 'main\'s src/from-main.js is not the PR\'s change');

  w.repo.write('src/a.js', aFile(true).replace('compute(x.y)', 'compute(x?.y)'));
  w.repo.commit('fix');
  assertExit(w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']), 0);
});

test('state mark-implemented (#151): a changed path that is not valid UTF-8 refuses the mark (base-unresolved), whatever else was fixed', (t) => {
  const w = worldIgnoringReview(t);
  assertExit(w.codex(1, findingsOf([finding()])), 0);
  assertExit(w.judge(1, { 'R1-B1': ['ACCEPT'] }), 0);
  fixSrcA(w);
  // Straight into the index, so no filesystem has to be able to hold the name (APFS and others reject invalid UTF-8).
  const gitRaw = (args, input) => {
    const env = { ...process.env };
    for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k];
    const r = spawnSync('git', args, { cwd: w.repo.dir, env, input });
    assert.equal(r.status, 0, String(r.stderr));
    return r.stdout.toString('utf8').trim();
  };
  const blob = gitRaw(['hash-object', '-w', '--stdin'], 'export const odd = 1;\n');
  gitRaw(['update-index', '-z', '--index-info'], Buffer.concat([Buffer.from(`100644 ${blob}\t`), BAD_NAME, Buffer.from([0])]));
  w.repo.git(['add', 'src/a.js']);
  w.repo.git(['commit', '-q', '-m', 'fix, plus a file whose name is not UTF-8']);
  refusedUnresolved(w);
});

test('state mark-implemented (#151): the same through a real file on disk (skipped where the filesystem refuses the name)', (t) => {
  const w = worldIgnoringReview(t);
  assertExit(w.codex(1, findingsOf([finding()])), 0);
  assertExit(w.judge(1, { 'R1-B1': ['ACCEPT'] }), 0);
  fixSrcA(w);
  try {
    writeFileSync(Buffer.concat([Buffer.from(`${w.repo.dir}/`), BAD_NAME.subarray(0)]), 'export const odd = 1;\n');
  } catch (err) { t.skip(`this filesystem cannot create a non-UTF-8 file name (${err.code})`); return; }
  w.repo.commit('fix, plus a file whose name is not UTF-8');
  refusedUnresolved(w);
});

test('state mark-implemented: a signed fix commit still counts when the user\'s git config has log.showSignature=true', (t) => {
  const w = worldIgnoringReview(t);
  const key = join(w.scratch, 'sign-key');
  const gen = spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-q', '-f', key], { encoding: 'utf8' });
  if (gen.error || gen.status !== 0) { t.skip('ssh-keygen is unavailable, so a signed commit cannot be made without gpg'); return; }
  assertExit(w.codex(1, findingsOf([finding()])), 0);
  assertExit(w.judge(1, { 'R1-B1': ['ACCEPT'] }), 0);
  const pub = readFileSync(`${key}.pub`, 'utf8').trim();
  writeFileSync(join(w.scratch, 'allowed-signers'), `fixer@example.test ${pub}\n`);
  w.repo.git(['config', 'log.showSignature', 'true']);
  w.repo.git(['config', 'gpg.format', 'ssh']);
  w.repo.git(['config', 'user.signingkey', `${key}.pub`]);
  w.repo.git(['config', 'gpg.ssh.allowedSignersFile', join(w.scratch, 'allowed-signers')]);
  w.repo.write('src/a.js', aFile(true).replace('compute(x.y)', 'compute(x?.y)'));
  w.repo.git(['add', '-A']);
  w.repo.git(['commit', '-q', '-S', '-m', 'signed fix']);
  const shown = w.repo.git(['log', '-1', '--format=']);
  assert.match(shown, /signature|Good|Good "git" signature/i, 'git prints signature text for this commit under log.showSignature');
  const r = w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(w.item('R1-B1').implemented !== undefined, true);
});

test('state mark-implemented fails closed: a conflicting base merge, or a state whose toHead git cannot resolve, refuses the mark', (t) => {
  const w = worldIgnoringReview(t);
  assertExit(w.codex(1, findingsOf([finding()])), 0);
  assertExit(w.judge(1, { 'R1-B1': ['ACCEPT'] }), 0);
  // The default branch edits the line round 1 reviewed the PR changing: the trial merge conflicts, so the PR's own change
  // since round 1 cannot be separated from main's, and no fix is accepted on a guess.
  // The PR is then rebuilt on top of main (a rebase): no merge commit records how the conflict was resolved, so nothing
  // marks where the PR's own work since round 1 starts.
  w.repo.checkout('main');
  w.repo.write('src/a.js', aFile(false).replace('v12 = 12', 'v12 = 1200'));
  w.repo.write('src/from-main.js', 'export const other = 1;\n');
  w.repo.commit('main moves on');
  w.repo.git(['checkout', '-q', '-B', 'feat/x', 'main']);
  w.repo.write('src/a.js', aFile(true));
  w.repo.commit('feature, rebuilt on main');
  w.repo.write('src/a.test.js', 'console.log("test");\n');
  w.repo.commit('add a test');
  const before = w.stateText();
  const refused = w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']);
  assertExit(refused, 2, refused.stderr + refused.stdout);
  assert.equal(refused.json.error, 'base-unresolved');
  assert.equal(w.stateText(), before, 'nothing was marked');

  // An unresolvable toHead is an error, never "a non-test file changed".
  const w2 = worldIgnoringReview(t);
  assertExit(w2.codex(1, findingsOf([finding()])), 0);
  assertExit(w2.judge(1, { 'R1-B1': ['ACCEPT'] }), 0);
  w2.repo.write('src/a.js', aFile(true).replace('compute(x.y)', 'compute(x?.y)'));
  w2.repo.commit('fix');
  const st = JSON.parse(w2.stateText());
  st.rounds[0].toHead = 'f'.repeat(40);
  writeFileSync(join(w2.repo.dir, '.review', 'state.json'), JSON.stringify(st));
  const bad = w2.cli(['state', 'mark-implemented', '--ids', 'R1-B1']);
  assertExit(bad, 2, bad.stderr + bad.stdout);
  assert.equal(bad.json.error, 'base-unresolved');
  assert.equal(w2.item('R1-B1').implemented, undefined);
});

test('state mark-implemented: after a conflicting base merge is resolved, a real fix committed after the resolution counts', (t) => {
  const w = acceptedWorld(t);
  conflictMerge(w);
  fixA(w);
  const r = w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(w.item('R1-B1').implemented, true);
});

test('state mark-implemented: after a resolved conflicting merge, only a test file committed since is still refused', (t) => {
  const w = acceptedWorld(t);
  conflictMerge(w);
  w.repo.write('src/a.test.js', 'console.log("test");\n');
  w.repo.commit('add a test');
  const refused = w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']);
  assertExit(refused, 2, refused.stderr + refused.stdout);
  assert.equal(refused.json.error, 'no-code-change');
  assert.match(refused.json.message, /only test files changed \(src\/a\.test\.js\)/);
  assert.equal(w.item('R1-B1').implemented, undefined);
});

test('state mark-implemented: a resolved conflicting merge with no later commit is refused', (t) => {
  const w = acceptedWorld(t);
  conflictMerge(w);
  const refused = w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']);
  assertExit(refused, 2, refused.stderr + refused.stdout);
  assert.equal(refused.json.error, 'no-code-change');
  assert.equal(w.item('R1-B1').implemented, undefined);
});

test('state mark-implemented: files main brings in after the resolving merge do not count as the fix', (t) => {
  const w = acceptedWorld(t);
  conflictMerge(w);
  w.repo.write('src/a.test.js', 'console.log("test");\n');
  w.repo.commit('add a test');
  mergeMainInto(w, { 'src/more-from-main.js': 'export const more = 1;\n' }); // a clean second update-branch
  const refused = w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']);
  assertExit(refused, 2, refused.stderr + refused.stdout);
  assert.equal(refused.json.error, 'no-code-change', 'main\'s new file is not the PR\'s change');
  assert.doesNotMatch(refused.json.message, /more-from-main/);
});

test('state mark-implemented: a fix committed before a later clean base merge still counts, and the later merge alone does not', (t) => {
  const w = acceptedWorld(t);
  conflictMerge(w);
  fixA(w);
  mergeMainInto(w, { 'src/more-from-main.js': 'export const more = 1;\n' }); // update-branch again, no conflict
  const r = w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(w.item('R1-B1').implemented, true);

  const w2 = acceptedWorld(t);
  conflictMerge(w2);
  mergeMainInto(w2, { 'src/more-from-main.js': 'export const more = 1;\n' });
  const refused = w2.cli(['state', 'mark-implemented', '--ids', 'R1-B1']);
  assertExit(refused, 2, refused.stderr + refused.stdout);
  assert.equal(refused.json.error, 'no-code-change');
  assert.equal(w2.item('R1-B1').implemented, undefined);
});

test('state mark-implemented: a conflict resolved by merging a branch other than the default branch stays unresolved', (t) => {
  const w = acceptedWorld(t);
  // main gets the conflicting change; a side branch (containing it plus more) is what the PR merges, so no merge commit
  // brings in the default branch itself.
  w.repo.checkout('main');
  w.repo.write('src/a.js', aFile(false).replace('v12 = 12', 'v12 = 1200'));
  w.repo.commit('main moves on');
  w.repo.git(['checkout', '-q', '-b', 'side', 'main']);
  w.repo.write('src/side.js', 'export const side = 1;\n');
  w.repo.commit('side work');
  w.repo.checkout('feat/x');
  try { w.repo.git(['merge', '--no-ff', '-m', 'merge side', 'side']); } catch {
    w.repo.write('src/a.js', aFile(true));
    w.repo.git(['add', '-A']);
    w.repo.git(['commit', '-q', '--no-edit']);
  }
  fixA(w);
  const refused = w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']);
  assertExit(refused, 2, refused.stderr + refused.stdout);
  assert.equal(refused.json.error, 'base-unresolved');
  assert.doesNotMatch(refused.json.message, /resolve the base branch merge and try again/);
});

test('state mark-implemented (#120): a hand-written file in a clean main merge after the conflict-resolving merge is not the fix', (t) => {
  const w = acceptedWorld(t);
  conflictMerge(w);
  mergeMainInto(w, FROM_MAIN, { evil: SMUGGLED });
  refusedAs(w, /smuggled\.js/);
});

test('state mark-implemented (#120): an extra line typed into a clean main merge, in a file the PR never changed, is not the fix', (t) => {
  const w = acceptedWorld(t);
  conflictMerge(w);
  mergeMainInto(w, FROM_MAIN, { evil: { 'src/b.js': `${bFile}export const extra = 1;\n` } });
  refusedAs(w, /src\/b\.js/);
});
