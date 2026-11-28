// #472 (click-to-approve, part A): a click whose tool_result entry Claude Code 2.1.323 writes only AFTER the PostToolUse hooks return is kept as a PENDING pointer at PostToolUse and verified from
// the transcript later, when a consumer reads the owner-go records (settlePendingClicks). Plan: claude-notes/plans/2026-11-16-click-pending-472.md (Rev 4). Temp homes only: accountHome() reads the
// OS account database, so HOME= isolates nothing. Every reader call passes `settle` explicitly, so none of these tests depends on the PIPELINE_CLICK_SETTLE switch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  MAX_AGE_MS, accountHome, appendRecord, approvalGap, approvedPr, claimGrantMarkers, grantIdOf, ownerGoDir, ownerGrantLookups, ownerGrantedRounds, ownerRuled, queuedApprovalAt, readApprovals, readGrantMarker, readRecords, recordRoundGrant, roundTicketKey,
  settleEnabled, verifyOwnerGrant,
} from '../pipeline/hooks/lib/owner-go.mjs';
import { CAPTURE_SKEW_MS, CLICK_BUILDS, MIN_ANSWER_MS, SETTLE_SCAN_BUDGET, WAIT_GRACE_MS, asksDir, clickNotes, clickProvenance, issueAsk, mergeAsk, mergeManyAsk, readAsk, recordClick, roundAsk, rulingAsk, rulingWhyRow, settlePendingClicks } from '../pipeline/hooks/lib/owner-go-click.mjs';
import { OWNER_GO_TIMEOUT_S } from '../pipeline/lib/installer.mjs';
import { deferEligibility } from '../pipeline/lib/triage.mjs';
import { OWNER_ENTRY, cleanupRoundClaims, linesOf, mergeRequest, roundRequest, rulingRequest, rulingRequestWithRow } from './helpers/owner-go.mjs';

const REPO = 'acme/app';
const HEAD = '0123456789abcdef0123456789abcdef01234567';
const ITEMS = 'abcdef012345';
const GHEAD = 'abcdef0123456789abcdef0123456789abcdef01';
const BUILD = '2.1.323'; // the build whose write order this file is about
const FIX = new URL('./fixtures/click/', import.meta.url);
const loadFixture = (name, build = BUILD) => readFileSync(new URL(`${build}/${name}.jsonl`, FIX), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const OK = () => ({ ok: true, hookLayersSha256: null });
const noSleep = async () => {};
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const clickIdOf = (session, toolUseId, askId) => sha256(`${session}|${toolUseId}|${askId}`).slice(0, 16);

const PARTS = {
  merge: (pr = 58) => mergeAsk({ repo: REPO, pr, closing: mergeRequest(pr, HEAD, ITEMS, REPO) }),
  round: () => roundAsk({ repo: REPO, pr: 58, line: roundRequest(58, 4, GHEAD, REPO) }),
  ruling: () => rulingAsk({ repo: REPO, pr: 58, ids: ['R1-B1', 'R2-S3'], line: rulingRequest(58, ['R1-B1', 'R2-S3'], REPO, 'c0ffee000000') }),
  'ruling-v2': () => rulingAsk({ repo: REPO, pr: 58, ids: ['R1-B1', 'R2-S3'], line: rulingRequestWithRow(rulingWhyRow('accept', 'real-problem'), 58, ['R1-B1', 'R2-S3'], REPO, 'c0ffee000000'), variant: 'ruling-v2-accept' }),
  'ruling-v2-reject': () => rulingAsk({ repo: REPO, pr: 58, ids: ['R1-B1', 'R2-S3'], line: rulingRequestWithRow(rulingWhyRow('reject', 'not-a-bug'), 58, ['R1-B1', 'R2-S3'], REPO, 'c0ffee000000'), variant: 'ruling-v2-reject' }),
  many: () => mergeManyAsk({ repo: REPO, entries: [58, 59].map((n) => ({ pr: n, lines: [`#${n} head ${HEAD.slice(0, 12)} · items ${ITEMS} · repo ${REPO}`] })), ready: '🔀 Ready to merge #58, #59 — say "merge"' }),
};

// A pending world: a temp home, an issued ask and a transcript that holds the prompt and the tool_use ONLY (the 2.1.323 write order: Claude Code writes the answer's tool_result entry after the
// PostToolUse hooks return). `await w.hook()` runs the recorder to completion; `w.flush()` then appends the result, the way Claude Code does once the hooks are done. `w.t` is the clock.
// `home` + `slot` + `pr` put several asks (one per PR, so none supersedes another) into one home; `shiftMs` moves the whole transcript in time; `w.extra(id)` adds another click on the same ask.
function pw(t, { kind = 'merge', answer = null, build = BUILD, fixture = 'genuine-click', hookLayersSha256 = null, issueBeforeUseMs = 10000, home = mkdtempSync(join(tmpdir(), 'owner-go-click-pending-')), slot = 0, pr = 58, shiftMs = 0 } = {}) {
  const parts = PARTS[kind](pr);
  const [prompt, use, result] = loadFixture(fixture, build);
  for (const e of [prompt, use, result]) e.timestamp = new Date(Date.parse(e.timestamp) + shiftMs).toISOString();
  if (Date.parse(result.timestamp) - Date.parse(use.timestamp) < MIN_ANSWER_MS) result.timestamp = new Date(Date.parse(use.timestamp) + 30000).toISOString();
  const issuedAt = Date.parse(use.timestamp) - issueBeforeUseMs;
  const issued = issueAsk({ ...parts, hookLayersSha256, home, now: () => issuedAt });
  assert.ok(issued.askId, `issue failed: ${JSON.stringify(issued)}`);
  const dialog = issued.questions[0];
  const chosen = answer ?? Object.keys(parts.actions).find((l) => parts.actions[l] !== null);
  const block = use.message.content.find((b) => b.type === 'tool_use');
  block.input = { questions: [dialog] };
  const stamped = typeof result.toolUseResult === 'object' && result.toolUseResult !== null ? result.toolUseResult : {};
  result.toolUseResult = { ...stamped, questions: [structuredClone(dialog)], answers: { [dialog.question]: chosen } };
  result.message.content[0].content = `Your questions have been answered: "${dialog.question}"="${chosen}". You can now continue with these answers in mind.`;
  const cfg = join(home, '.claude-click-test');
  mkdirSync(join(cfg, 'projects', '-repo'), { recursive: true });
  const file = join(cfg, 'projects', '-repo', `t${slot}.jsonl`);
  const text = (es) => `${es.map((e) => JSON.stringify(e)).join('\n')}\n`;
  writeFileSync(file, text([prompt, use]));
  const answeredAt = Date.parse(result.timestamp);
  const w = {
    home, file, issued, askId: issued.askId, dialog, parts, prompt, use, result, session: use.sessionId, toolUseId: block.id, answeredAt, issuedAt, text, chosen, t: answeredAt + 1000,
    now: () => w.t,
    input: { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', session_id: use.sessionId, transcript_path: file, cwd: '/work/app', tool_use_id: block.id, tool_input: { questions: [dialog] }, tool_response: {} },
  };
  w.clickId = clickIdOf(w.session, w.toolUseId, w.askId);
  w.slept = 0;
  // (#585) the PostToolUse tool_input as Claude Code 2.1.323 is inferred to hand it over: the model's input plus the permission component's `answers` and `annotations`
  w.shaped = (answers = { [dialog.question]: chosen }, annotations = {}) => ({ tool_input: { questions: [dialog], answers, annotations } });
  w.hook =(over = {}, input = {}) => recordClick({ ...w.input, ...input }, { home, now: w.now, sleep: async (ms) => { w.slept += ms; }, hookCheck: OK, ...over });
  w.flush = () => appendFileSync(file, text([result]));
  w.settle = (over = {}) => settlePendingClicks({ home, now: w.now, ...over });
  // another click on the SAME ask (another tool use id): the tool_use is written now, its result by .flush()
  w.extra = (id, atMs = answeredAt) => {
    const [u, r] = structuredClone([use, result]);
    u.uuid = `u-${id}-use`; u.message.content[0].id = id;
    r.uuid = `u-${id}-result`; r.parentUuid = u.uuid; r.sourceToolAssistantUUID = u.uuid; r.message.content[0].tool_use_id = id; r.timestamp = new Date(atMs).toISOString();
    appendFileSync(file, text([u]));
    return { id, clickId: clickIdOf(use.sessionId, id, issued.askId), flush: () => appendFileSync(file, text([r])) };
  };
  w.records = () => { try { return readFileSync(join(ownerGoDir(home), `${w.session}.jsonl`), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  w.gap = (over = {}) => approvalGap({ repo: REPO, pr: 58, head: HEAD, items: ITEMS, areas: [], home, now: w.now, settle: false, ...over });
  w.pendingFile = (clickId = w.clickId, askId = w.askId) => join(asksDir(home), `${askId}.${clickId}.pending`);
  w.names = () => { try { return readdirSync(asksDir(home)).sort(); } catch { return []; } };
  w.pendings = () => w.names().filter((n) => n.endsWith('.pending'));
  w.spentFile = join(asksDir(home), `${w.askId}.spent`);
  w.expectedPending = { askId: w.askId, clickId: w.clickId, kind: parts.kind, repo: REPO, prs: parts.prs };
  return w;
}

// ---- Task 1: the test switch --------------------------------------------------------------------------------------------------------------

test('settleEnabled truth table: an explicit option wins; otherwise the environment switch decides', () => {
  const on = {};
  const off = { PIPELINE_CLICK_SETTLE: 'off' };
  assert.equal(settleEnabled(true, off), true, 'settle: true overrides the switch');
  assert.equal(settleEnabled(false, on), false, 'settle: false is read-only');
  assert.equal(settleEnabled(false, off), false);
  assert.equal(settleEnabled(undefined, on), true, 'default: settle');
  assert.equal(settleEnabled(undefined, off), false, 'the test switch');
  assert.equal(settleEnabled(undefined, { PIPELINE_CLICK_SETTLE: 'on' }), true, 'only the exact word off turns it off');
  assert.equal(settleEnabled(undefined, { PIPELINE_CLICK_SETTLE: 'OFF' }), true);
  assert.equal(settleEnabled(null, on), true, 'null is not an explicit option');
  assert.equal(settleEnabled('yes', off), false, 'a non-boolean option is not an opt-in');
});

// ---- Task 2: pending capture at PostToolUse (the 2.1.323 write order) ---------------------------------------------------------------------

test('write order of 2.1.323 (hook returns, THEN the result lands) -> a pending click, nothing recorded, nothing spent', async (t) => {
  assert.ok(CLICK_BUILDS.includes(BUILD));
  const w = pw(t);
  const r = await w.hook();
  assert.deepEqual(r, { pending: w.expectedPending });
  assert.equal(w.clickId, clickIdOf(w.session, w.toolUseId, w.askId));
  assert.equal(w.slept, 500, 'the short poll ran in full before the click was kept pending');
  assert.deepEqual(w.pendings(), [`${w.askId}.${w.clickId}.pending`]);
  const marker = JSON.parse(readFileSync(w.pendingFile(), 'utf8'));
  assert.deepEqual(Object.keys(marker).sort(), ['askId', 'capturedAt', 'clickId', 'cwd', 'hookLayersSha256', 'session', 'toolUseId', 'transcriptPath', 'v']);
  assert.deepEqual({ ...marker, capturedAt: null }, { v: 1, askId: w.askId, clickId: w.clickId, session: w.session, toolUseId: w.toolUseId, transcriptPath: w.file, cwd: '/work/app', hookLayersSha256: null, capturedAt: null });
  assert.equal(marker.capturedAt, new Date(w.t).toISOString());
  assert.ok(Number.isFinite(Date.parse(marker.capturedAt)));
  if (process.platform !== 'win32') assert.equal(statSync(w.pendingFile()).mode & 0o777, 0o600);
  assert.equal(existsSync(w.spentFile), false, 'no spent marker');
  assert.equal(w.records().length, 0, 'nothing recorded');
  assert.equal(w.gap(), 'none', 'a pending click approves nothing');
  // the entry lands afterwards, and the SAME retried hook (same click id) now takes the immediate path
  w.flush();
  const again = await w.hook();
  assert.equal(again.recorded?.via, 'ask', JSON.stringify(again));
});

test('the pending marker carries the hook fingerprint the hook check returned, and a ruling click names the quote of each deciding label', async (t) => {
  const fp = 'a'.repeat(64);
  const w = pw(t, { hookLayersSha256: fp, kind: 'ruling', answer: 'Accept all' });
  const r = await w.hook({ hookCheck: () => ({ ok: true, hookLayersSha256: fp }) });
  assert.deepEqual(r.pending, { ...w.expectedPending, quotes: { 'Accept all': 'R1-B1: accept, R2-S3: accept', 'Follow-up all': 'R1-B1: follow-up, R2-S3: follow-up', 'Reject all': 'R1-B1: reject, R2-S3: reject' } });
  assert.equal(JSON.parse(readFileSync(w.pendingFile(), 'utf8')).hookLayersSha256, fp);
});

test('a pending click on a v2 ruling ask names the quote of each deciding label (the recommended one too) and settles through ownerRuled like a v1 one', async (t) => {
  // failure caught: the pending path dropping the variant, so a click on "Accept all (Recommended)" is captured with no quote or settles as ask-invalid and the ruling is never recorded
  const w = pw(t, { kind: 'ruling-v2', answer: 'Accept all (Recommended)' });
  const r = await w.hook();
  assert.deepEqual(r.pending, { ...w.expectedPending, variant: 'ruling-v2-accept', quotes: { 'Accept all (Recommended)': 'R1-B1: accept, R2-S3: accept', 'Follow-up all': 'R1-B1: follow-up, R2-S3: follow-up', 'Reject all': 'R1-B1: reject, R2-S3: reject' } });
  w.flush();
  assert.equal(w.settle().outcomes[0]?.outcome, 'recorded');
  const q = { repo: REPO, pr: 58, quote: 'R1-B1: accept, R2-S3: accept', decision: 'ACCEPT', contentOf: () => 'c0ffee000000', home: w.home, now: w.now };
  assert.equal(ownerRuled({ ...q, id: 'R1-B1' }), true);
  assert.equal(ownerRuled({ ...q, id: 'R2-S3' }), true);
});

test('a pending click on a ruling-v2-reject ask names the quote of each deciding label (Reject all (Recommended) too) and settles through ownerRuled as a typed reject would', async (t) => {
  // failure caught (#944): the pending path not knowing the reject variant, so a click on "Reject all (Recommended)" captured while the answer entry was still being written never settles into a ruling
  const w = pw(t, { kind: 'ruling-v2-reject', answer: 'Reject all (Recommended)' });
  const r = await w.hook();
  assert.deepEqual(r.pending, { ...w.expectedPending, variant: 'ruling-v2-reject', quotes: { 'Reject all (Recommended)': 'R1-B1: reject, R2-S3: reject', 'Accept all': 'R1-B1: accept, R2-S3: accept', 'Follow-up all': 'R1-B1: follow-up, R2-S3: follow-up' } });
  w.flush();
  assert.equal(w.settle().outcomes[0]?.outcome, 'recorded');
  const q = { repo: REPO, pr: 58, quote: 'R1-B1: reject, R2-S3: reject', decision: 'REJECT', contentOf: () => 'c0ffee000000', home: w.home, now: w.now };
  assert.equal(ownerRuled({ ...q, id: 'R1-B1' }), true);
  assert.equal(ownerRuled({ ...q, id: 'R2-S3' }), true);
  assert.equal(ownerRuled({ ...q, id: 'R1-B1', decision: 'ACCEPT', quote: 'R1-B1: accept, R2-S3: accept' }), false, 'only the clicked answer is a ruling');
});

test('the immediate path stays: an entry already there is recorded at once, no pending file, no extra wait', async (t) => {
  const w = pw(t);
  w.flush();
  const r = await w.hook();
  assert.equal(r.recorded?.via, 'ask', JSON.stringify(r));
  assert.equal(w.slept, 0);
  assert.deepEqual(w.pendings(), []);
  assert.equal(w.records().length, 1);
});

test('capture refuses what needs no transcript: hooks unchecked, offending or changed; superseded or expired now; spent by another click; a tool_input dialog that is not the ask\'s', async (t) => {
  const cases = [
    ['dialog-hooks-unchecked', {}, (w) => w.hook({ hookCheck: undefined })],
    ['dialog-hook-unlisted: x', {}, (w) => w.hook({ hookCheck: () => ({ ok: false, reason: 'dialog-hook-unlisted: x' }) })],
    ['dialog-hooks-changed', { hookLayersSha256: 'a'.repeat(64) }, (w) => w.hook({ hookCheck: () => ({ ok: true, hookLayersSha256: 'b'.repeat(64) }) })],
    ['superseded', {}, (w) => { issueAsk({ ...w.parts, home: w.home, now: () => w.issuedAt + 1000 }); return w.hook(); }],
    ['expired', {}, (w) => { w.t = w.issuedAt + MAX_AGE_MS + 1; return w.hook(); }],
    ['spent', {}, (w) => {
      writeFileSync(w.spentFile, `${JSON.stringify({ v: 1, askId: w.askId, clickId: 'f'.repeat(16), toolUseId: 'toolu_other', answeredAt: new Date(w.answeredAt).toISOString(), dialogSha256: JSON.parse(readFileSync(join(asksDir(w.home), `${w.askId}.json`), 'utf8')).dialogSha256, session: w.session, declined: false })}\n`);
      return w.hook();
    }],
    ['dialog-differs', {}, (w) => w.hook({}, { tool_input: { questions: [{ ...w.dialog, options: w.dialog.options.map((o, i) => (i === 0 ? { ...o, description: `${o.description}!` } : o)) }] } })],
    ['dialog-not-canonical', {}, (w) => w.hook({}, { tool_input: { questions: [{ ...w.dialog, preview: 'x' }] } })],
  ];
  for (const [reason, opts, run] of cases) {
    const w = pw(t, opts);
    assert.deepEqual(await run(w), { refused: reason }, reason);
    assert.deepEqual(w.pendings(), [], `${reason}: no pending written`);
    assert.equal(w.records().length, 0, reason);
  }
});

test('a retried hook leaves one pending; a 9th UNSETTLED pending is refused too-many-pending, but settled ones do not count (8 settled junk pendings, then a genuine click is still captured)', async (t) => {
  const w = pw(t);
  const first = await w.hook();
  const before = readFileSync(w.pendingFile(), 'utf8');
  w.t += 5000;
  assert.deepEqual(await w.hook(), first, 'the same click again: the same pending');
  assert.equal(readFileSync(w.pendingFile(), 'utf8'), before, 'the marker is not rewritten (capturedAt stays the first one)');
  assert.equal(w.pendings().length, 1);
  // fill the ask with 7 more unsettled pendings (other tool use ids = other clicks), then the 9th is refused
  for (let i = 0; i < 7; i++) {
    const id = `toolu_junk${i}`;
    assert.equal((await w.hook({}, { tool_use_id: id })).pending?.clickId, clickIdOf(w.session, id, w.askId), `click ${i}`);
  }
  assert.equal(w.pendings().length, 8);
  assert.deepEqual(await w.hook({}, { tool_use_id: 'toolu_ninth' }), { refused: 'too-many-pending' });
  assert.equal(w.pendings().length, 8);
  assert.deepEqual(await w.hook(), first, 'an existing pending is still answered with itself at the cap');
  // settled junk does not count: a fresh ask, 8 pendings each with its .settled, then a genuine click
  const w2 = pw(t);
  for (let i = 0; i < 8; i++) {
    const clickId = clickIdOf(w2.session, `toolu_old${i}`, w2.askId);
    writeFileSync(w2.pendingFile(clickId), '{}\n');
    writeFileSync(join(asksDir(w2.home), `${w2.askId}.${clickId}.settled`), `${JSON.stringify({ v: 1, askId: w2.askId, clickId, outcome: 'refused', reason: 'x', settledAt: new Date(w2.t).toISOString() })}\n`);
  }
  assert.deepEqual(await w2.hook(), { pending: w2.expectedPending });
});

test('capture admits the keys Claude Code 2.1.323 adds to the PostToolUse tool_input (answers, annotations): a pending is written whatever their values say; metadata alone is fine (#585)', async (t) => {
  const q = (w) => w.dialog.question;
  const shapes = [
    ['answers + annotations of a real click', (w) => w.shaped()],
    ['answers that say "Not yet" (never read)', (w) => w.shaped({ [q(w)]: 'Not yet' })],
    ['annotations with notes (never read)', (w) => w.shaped({ [q(w)]: 'Merge' }, { [q(w)]: { notes: 'x' } })],
    ['empty answers', (w) => w.shaped({}, {})],
    ['answers only', (w) => ({ tool_input: { questions: [w.dialog], answers: { [q(w)]: 'Merge' } } })],
    ['annotations only', (w) => ({ tool_input: { questions: [w.dialog], annotations: {} } })],
    ['metadata', (w) => ({ tool_input: { questions: [w.dialog], metadata: { source: 'x' } } })],
  ];
  for (const [label, make] of shapes) {
    const w = pw(t);
    assert.deepEqual(await w.hook({}, make(w)), { pending: w.expectedPending }, label);
    assert.equal(w.pendings().length, 1, label);
    assert.equal(w.records().length, 0, label);
  }
});

test('capture refuses a tool_input with any other key, or a malformed answers / annotations, with a reason that says which (#585): no pending', async (t) => {
  const cases = [
    [{ anything: 1 }, 'tool-use-shape: keys anything'],
    [{ zeta: 1, alpha: 2 }, 'tool-use-shape: keys zeta,alpha'],
    [{ a: 1, b: 1, c: 1, d: 1, e: 1, f: 1 }, 'tool-use-shape: keys a,b,c,d'],
    [{ 'not a name!': 1, ok_1: 1 }, 'tool-use-shape: keys ?,ok_1'],
    [{ ['x'.repeat(33)]: 1 }, 'tool-use-shape: keys ?'],
    [{ answers: { x: 'Merge' }, extra: 1 }, 'tool-use-shape: keys extra'],
    [{ answers: ['Merge'] }, 'tool-use-shape: answers'],
    [{ answers: 'Merge' }, 'tool-use-shape: answers'],
    [{ answers: null }, 'tool-use-shape: answers'],
    [{ answers: { 'another question': 'Merge' } }, 'tool-use-shape: answers'],
    [(w) => ({ answers: { [w.dialog.question]: 'Merge', second: 'x' } }), 'tool-use-shape: answers'],
    [(w) => ({ answers: { [w.dialog.question]: ['Merge'] } }), 'tool-use-shape: answers'],
    [(w) => ({ answers: { [w.dialog.question]: 1 } }), 'tool-use-shape: answers'],
    [{ annotations: [] }, 'tool-use-shape: annotations'],
    [{ annotations: null }, 'tool-use-shape: annotations'],
    [{ annotations: 'x' }, 'tool-use-shape: annotations'],
  ];
  for (const [extra, reason] of cases) {
    const w = pw(t);
    const add = typeof extra === 'function' ? extra(w) : extra;
    assert.deepEqual(await w.hook({}, { tool_input: { questions: [w.dialog], ...add } }), { refused: reason }, JSON.stringify(add));
    assert.deepEqual(w.pendings(), []);
  }
  const two = pw(t);
  assert.deepEqual(await two.hook({}, { tool_input: { questions: [two.dialog, two.dialog] } }), { refused: 'tool-use-shape' }, 'one question only');
  const none = pw(t);
  assert.equal(await none.hook({}, { tool_input: { answers: {} } }), null, 'no question: not an ask of ours at all');
});

test('capture, then the transcript decides (#585): a real 2.1.323-shaped hook input settles every genuine fixture as before; a hook input that DISAGREES with the transcript changes nothing', async (t) => {
  const settled = async (w, hookInput) => {
    assert.ok((await w.hook({}, hookInput)).pending, 'captured');
    w.flush();
    return only(w.settle(), w)[0];
  };
  // genuine click, each kind, the multiselect recording
  for (const [kind, extra] of [['merge', {}], ['round', {}], ['ruling', {}], ['many', { fixture: 'multiselect-click', answer: 'Merge #58, Merge #59' }]]) {
    const w = pw(t, { kind, ...extra });
    const o = await settled(w, w.shaped());
    assert.equal(o.outcome, 'recorded', `${kind}: ${JSON.stringify(o)}`);
    assert.equal(w.records().length, 1, kind);
    assert.equal(clickProvenance(w.records()[0], { home: w.home }), 'owner', kind);
  }
  // the preview recording: the transcript's annotations are what refuses it
  const preview = pw(t, { fixture: 'preview-annotations' });
  const p = await settled(preview, preview.shaped());
  assert.deepEqual([p.outcome, p.reason], ['refused', 'annotations']);
  // the hook says "Merge", the owner's click in the transcript says "Not yet": declined
  const declined = pw(t, { answer: 'Not yet' });
  assert.equal((await settled(declined, declined.shaped({ [declined.dialog.question]: 'Merge' }))).outcome, 'declined');
  assert.equal(declined.records().length, 0);
  // hook annotations non-empty but the transcript's are {}: admitted (the hook's values are never read)
  const noisy = pw(t);
  assert.equal((await settled(noisy, noisy.shaped({ [noisy.dialog.question]: 'Merge' }, { [noisy.dialog.question]: { notes: 'x' } }))).outcome, 'recorded');
  // hook annotations {} but the transcript's non-empty: refused
  const notes = pw(t);
  notes.result.toolUseResult.annotations = { [notes.dialog.question]: { notes: 'but only after lunch' } };
  const n = await settled(notes, notes.shaped());
  assert.deepEqual([n.outcome, n.reason], ['refused', 'annotations']);
  assert.equal(notes.records().length, 0);
});

test('a model-prefilled dialog whose tool_use is already in the transcript at capture gets NO pointer (early refusal, #585); one whose tool_use is not there yet is refused when it settles', async (t) => {
  for (const extra of [{ answers: { x: 'Merge' } }, { annotations: {} }, { other: 1 }]) {
    const w = pw(t);
    w.use.message.content.find((b) => b.type === 'tool_use').input = { questions: [w.dialog], ...extra };
    writeFileSync(w.file, w.text([w.prompt, w.use]));
    assert.deepEqual(await w.hook({}, w.shaped()), { refused: 'tool-use-shape' }, JSON.stringify(extra));
    assert.deepEqual(w.pendings(), [], 'no pointer');
  }
  const two = pw(t);
  two.use.message.content.find((b) => b.type === 'tool_use').input = { questions: [two.dialog, two.dialog] };
  writeFileSync(two.file, two.text([two.prompt, two.use]));
  assert.deepEqual(await two.hook(), { refused: 'tool-use-shape' });
  const later = pw(t);
  writeFileSync(later.file, later.text([later.prompt]));
  assert.ok((await later.hook({}, later.shaped())).pending, 'the entry is not there yet: captured');
  later.use.message.content.find((b) => b.type === 'tool_use').input = { questions: [later.dialog], answers: { [later.dialog.question]: 'Merge' } };
  writeFileSync(later.file, later.text([later.prompt, later.use, later.result]));
  later.t = later.answeredAt + 1000;
  const o = only(later.settle(), later)[0];
  assert.deepEqual([o.outcome, o.reason], ['refused', 'tool-use-shape']);
  assert.equal(later.records().length, 0);
});

test('junk pointers settle as refused and do not block a later genuine click (#585): the cap counts unsettled pointers only, the newest genuine click still settles', async (t) => {
  const w = pw(t);
  const junk = [];
  for (let i = 0; i < 8; i++) {
    const id = `toolu_junk${i}`;
    assert.ok((await w.hook({}, { tool_use_id: id, ...w.shaped() })).pending, `captured ${id}`); // (no tool_use in the transcript yet: nothing to refuse early)
    junk.push(id);
  }
  assert.equal(w.pendings().length, 8, 'the cap is full of unsettled pointers');
  assert.deepEqual(await w.hook({}, { tool_use_id: 'toolu_junk8', ...w.shaped() }), { refused: 'too-many-pending' });
  // now the model-prefilled entries land: each pointer settles as refused
  const entries = junk.flatMap((id) => {
    const [u, r] = structuredClone([w.use, w.result]);
    u.uuid = `u-${id}-use`;
    u.message.content[0].id = id;
    u.message.content[0].input = { questions: [w.dialog], answers: { [w.dialog.question]: 'Merge' } };
    r.uuid = `u-${id}-result`; r.parentUuid = u.uuid; r.sourceToolAssistantUUID = u.uuid; r.message.content[0].tool_use_id = id;
    return [u, r];
  });
  appendFileSync(w.file, w.text(entries));
  const o = w.settle().outcomes;
  assert.equal(o.length, 8);
  assert.ok(o.every((x) => x.outcome === 'refused' && x.reason === 'tool-use-shape'), JSON.stringify(o));
  assert.equal(w.records().length, 0);
  // the genuine click (its tool_use is in the transcript, clean) is still captured and settles
  assert.deepEqual(await w.hook({}, w.shaped()), { pending: w.expectedPending });
  w.flush();
  assert.equal(only(w.settle(), w)[0].outcome, 'recorded');
});

test('the hook never reads tool_response: it neither decides nor admits anything', async (t) => {
  const w = pw(t);
  let touched = 0;
  const input = { ...w.input };
  Object.defineProperty(input, 'tool_response', { enumerable: true, get() { touched++; return { answers: { [w.dialog.question]: 'Merge' } }; } });
  const r = await recordClick(input, { home: w.home, now: w.now, sleep: noSleep, hookCheck: OK });
  assert.deepEqual(r, { pending: w.expectedPending });
  assert.equal(touched, 0, 'tool_response was never read');
  assert.equal(w.records().length, 0);
});

test('a pending needs a write that works: a pending that cannot be written is refused write-failed, nothing is left', async (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) return;
  const w = pw(t);
  chmodSync(asksDir(w.home), 0o500);
  try {
    assert.deepEqual(await w.hook(), { refused: 'write-failed' });
  } finally {
    chmodSync(asksDir(w.home), 0o700);
  }
  assert.deepEqual(w.pendings(), []);
});

// ---- Task 3: settlePendingClicks ---------------------------------------------------------------------------------------------------------

const settledFile = (w, clickId = w.clickId, askId = w.askId) => join(asksDir(w.home), `${askId}.${clickId}.settled`);
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const settledOf = (w, clickId = w.clickId) => (existsSync(settledFile(w, clickId)) ? readJson(settledFile(w, clickId)) : null);
const allSettled = (home) => readdirSync(asksDir(home)).filter((n) => n.endsWith('.settled'));
// the rival's write in a race: a plain exclusive create (the real writeExclusive is not exported)
const plainWrite = (file, body) => { try { writeFileSync(file, `${JSON.stringify(body)}\n`, { flag: 'wx', mode: 0o600 }); return 'ok'; } catch (e) { return e.code === 'EEXIST' ? 'exists' : 'error'; } };
const only = (r, w, clickId = w.clickId) => r.outcomes.filter((o) => o.clickId === clickId);

test('flush then settle = the record the immediate path writes: same record, provenance owner, .settled recorded, the pending\'s hook fingerprint in .spent', async (t) => {
  const fp = 'a'.repeat(64);
  const check = () => ({ ok: true, hookLayersSha256: fp });
  const w = pw(t, { hookLayersSha256: fp });
  assert.ok((await w.hook({ hookCheck: check })).pending);
  w.flush();
  const r = w.settle({ io: {} });
  assert.deepEqual(r, { outcomes: [{ askId: w.askId, clickId: w.clickId, outcome: 'recorded' }], problems: [] });
  const twin = pw(t, { hookLayersSha256: fp });
  twin.flush();
  const immediate = await twin.hook({ hookCheck: check });
  assert.equal(immediate.recorded?.via, 'ask', JSON.stringify(immediate));
  const norm = (rec, x) => JSON.parse(JSON.stringify(rec).replaceAll(x.askId, 'ASK').replaceAll(x.clickId, 'CLICK').replaceAll(JSON.stringify(x.file).slice(1, -1), 'FILE')); // the path as JSON writes it (Windows backslashes are escaped)
  assert.deepEqual(norm(w.records()[0], w), norm(immediate.recorded, twin), 'the deferred record is the immediate one');
  assert.equal(w.records().length, 1);
  assert.equal(clickProvenance(w.records()[0], { home: w.home }), 'owner');
  assert.deepEqual(Object.keys(settledOf(w)).sort(), ['askId', 'clickId', 'outcome', 'reason', 'settledAt', 'v']);
  assert.equal(settledOf(w).outcome, 'recorded');
  assert.equal(readJson(w.spentFile).hookLayersSha256, fp, 'the spent marker holds the fingerprint taken at the click');
  assert.equal(w.records()[0].ts, new Date(w.answeredAt).toISOString(), 'ts = the answer time, not the settle time');
  assert.equal(w.gap({ settle: false }), 'ok');
  // settled once: another settle has nothing to do
  assert.deepEqual(w.settle(), { outcomes: [], problems: [] });
  assert.equal(w.records().length, 1);
});

test('not flushed: waiting; past the grace it is retried after the active units and STILL not settled; it settles when the entry appears; after capturedAt + skew + 24 h it is refused evidence-expired', async (t) => {
  const w = pw(t);
  assert.ok((await w.hook()).pending);
  assert.deepEqual(w.settle().outcomes, [{ askId: w.askId, clickId: w.clickId, outcome: 'waiting', reason: 'not-in-transcript' }]);
  assert.equal(settledOf(w), null);
  w.t += WAIT_GRACE_MS + 1000; // the grace only changes the retry order
  assert.equal(only(w.settle(), w)[0].outcome, 'waiting');
  assert.equal(settledOf(w), null, 'no .settled on time alone');
  assert.equal(w.records().length, 0);
  w.flush();
  assert.equal(only(w.settle(), w)[0].outcome, 'recorded', 'it still settles once the evidence appears');
  // another world: never flushed, the evidence expires
  const x = pw(t);
  assert.ok((await x.hook()).pending);
  const capturedAt = Date.parse(readJson(x.pendingFile()).capturedAt);
  x.t = capturedAt + CAPTURE_SKEW_MS + MAX_AGE_MS; // exactly the bound: still waiting
  assert.equal(only(x.settle(), x)[0].outcome, 'waiting');
  x.t += 1;
  assert.deepEqual(only(x.settle(), x), [{ askId: x.askId, clickId: x.clickId, outcome: 'refused', reason: 'evidence-expired' }]);
  assert.equal(settledOf(x).reason, 'evidence-expired');
  x.flush();
  assert.deepEqual(x.settle().outcomes, [], 'a refused click stays refused');
  assert.equal(x.records().length, 0);
});

test('"Not yet": declined, spent, no record', async (t) => {
  const w = pw(t, { answer: 'Not yet' });
  assert.ok((await w.hook()).pending);
  w.flush();
  assert.deepEqual(w.settle().outcomes, [{ askId: w.askId, clickId: w.clickId, outcome: 'declined' }]);
  assert.equal(readJson(w.spentFile).declined, true);
  assert.equal(w.records().length, 0);
  assert.equal(settledOf(w).outcome, 'declined');
  assert.equal(w.gap(), 'none');
});

test('answer order inside a unit: a later click is never admitted ahead of an earlier one that is still unverified; the first verified answer spends the ask', async (t) => {
  const w = pw(t);
  assert.ok((await w.hook()).pending); // click A (the fixture's own tool use)
  w.t += 1000;
  const b = w.extra('toolu_second');
  assert.equal((await w.hook({}, { tool_use_id: b.id })).pending?.clickId, b.clickId);
  b.flush(); // B's result is in the transcript, A's is not
  const first = w.settle();
  assert.deepEqual(first.outcomes, [{ askId: w.askId, clickId: w.clickId, outcome: 'waiting', reason: 'not-in-transcript' }], 'the walk stops at A: B is not looked at');
  assert.equal(w.records().length, 0);
  assert.equal(existsSync(w.spentFile), false);
  w.flush();
  const second = w.settle();
  assert.deepEqual(second.outcomes, [
    { askId: w.askId, clickId: w.clickId, outcome: 'recorded' },
    { askId: w.askId, clickId: b.clickId, outcome: 'refused', reason: 'spent' },
  ]);
  assert.deepEqual(w.records().map((r) => r.ask.clickId), [w.clickId], 'one ask, one use: the earlier click');
  assert.equal(allSettled(w.home).length, 2);
});

test('out of time inside a unit: the deadline is checked before EACH member, so a click behind a settled one stays pending (no .settled) and settles with time', async (t) => {
  // Failure caught: the budget checked once per ask lets every later pointer of the same ask run settleOne and write a durable .settled after the hook's time is gone.
  const w = pw(t);
  assert.ok((await w.hook()).pending); // click A
  w.t += 1000;
  const b = w.extra('toolu_second');
  assert.equal((await w.hook({}, { tool_use_id: b.id })).pending?.clickId, b.clickId);
  b.flush();
  w.flush();
  const first = w.settle({ leftMs: () => (w.records().length === 0 ? 60_000 : 0) }); // time is up once A is recorded
  assert.deepEqual(first.outcomes, [{ askId: w.askId, clickId: w.clickId, outcome: 'recorded' }]);
  assert.deepEqual(first.problems, ['no-time']);
  assert.equal(allSettled(w.home).length, 1, 'B has no .settled');
  assert.deepEqual(w.settle().outcomes, [{ askId: w.askId, clickId: b.clickId, outcome: 'refused', reason: 'spent' }], 'with time, B settles as before');
});

test('supersession at the answer: before -> superseded; equal -> superseded; after -> recorded; a garbled marker or an unreadable superseding ask -> superseded', async (t) => {
  const supersede = (w, issuedAtMs) => { const next = issueAsk({ ...w.parts, home: w.home, now: () => issuedAtMs }); assert.ok(next.askId); return next.askId; };
  for (const [label, delta, want] of [['before', -1000, 'superseded'], ['equal', 0, 'superseded'], ['after', 1, 'recorded']]) {
    const w = pw(t);
    assert.ok((await w.hook()).pending);
    supersede(w, w.answeredAt + delta);
    assert.ok(existsSync(join(asksDir(w.home), `${w.askId}.superseded`)), label);
    w.flush();
    const o = only(w.settle(), w)[0];
    assert.equal(o.outcome === 'recorded' ? 'recorded' : o.reason, want, label);
    assert.equal(w.records().length, want === 'recorded' ? 1 : 0, label);
  }
  const garbled = pw(t);
  assert.ok((await garbled.hook()).pending);
  writeFileSync(join(asksDir(garbled.home), `${garbled.askId}.superseded`), '{not json');
  garbled.flush();
  assert.deepEqual(only(garbled.settle(), garbled)[0], { askId: garbled.askId, clickId: garbled.clickId, outcome: 'refused', reason: 'superseded' });
  const orphan = pw(t);
  assert.ok((await orphan.hook()).pending);
  writeFileSync(join(asksDir(orphan.home), `${orphan.askId}.superseded`), `${JSON.stringify({ v: 1, askId: orphan.askId, supersededBy: 'ask-ffffffffffff' })}\n`);
  orphan.flush();
  assert.equal(only(orphan.settle(), orphan)[0].reason, 'superseded', 'the superseding ask cannot be read');
  assert.equal(orphan.records().length, 0);
});

test('times: expired, answered-before-issue, future, stale and capture-skew are refused; ts is the answer time', async (t) => {
  const refusal = async ({ opts = {}, capture = (w) => w.answeredAt + 1000, settleAt = (w) => w.answeredAt + 1000 }) => {
    const w = pw(t, opts);
    w.t = capture(w);
    assert.ok((await w.hook()).pending, 'captured');
    w.flush();
    w.t = settleAt(w);
    const o = only(w.settle(), w)[0];
    assert.equal(w.records().length, o.outcome === 'recorded' ? 1 : 0);
    return o.outcome === 'recorded' ? 'recorded' : o.reason;
  };
  assert.equal(await refusal({ opts: { issueBeforeUseMs: MAX_AGE_MS + 10000 }, capture: (w) => w.issuedAt + MAX_AGE_MS - 1000 }), 'expired');
  assert.equal(await refusal({ opts: { issueBeforeUseMs: -60000 } }), 'answered-before-issue');
  assert.equal(await refusal({ capture: (w) => w.answeredAt - 10 * 60000, settleAt: (w) => w.answeredAt - 6 * 60000 }), 'answer-in-the-future');
  assert.equal(await refusal({ settleAt: (w) => w.answeredAt + MAX_AGE_MS + 5000 }), 'stale');
  assert.equal(await refusal({ capture: (w) => w.answeredAt + CAPTURE_SKEW_MS, settleAt: (w) => w.answeredAt + CAPTURE_SKEW_MS }), 'recorded', 'exactly the skew passes');
  assert.equal(await refusal({ capture: (w) => w.answeredAt - CAPTURE_SKEW_MS, settleAt: (w) => w.answeredAt }), 'recorded');
  assert.equal(await refusal({ capture: (w) => w.answeredAt + CAPTURE_SKEW_MS + 1, settleAt: (w) => w.answeredAt + CAPTURE_SKEW_MS + 1 }), 'capture-skew');
  assert.equal(await refusal({ capture: (w) => w.answeredAt - CAPTURE_SKEW_MS - 1, settleAt: (w) => w.answeredAt }), 'capture-skew');
  // a pending whose capturedAt is not a finite UTC time, or is in the future, is skipped: no outcome but `skipped`, no .settled
  for (const bad of ['garbage', '2026-11-14T17:28:45+00:00', 'yesterday', null, 12345]) {
    const w = pw(t);
    assert.ok((await w.hook()).pending);
    writeFileSync(w.pendingFile(), `${JSON.stringify({ ...readJson(w.pendingFile()), capturedAt: bad })}\n`);
    w.flush();
    assert.deepEqual(w.settle().outcomes, [{ askId: w.askId, clickId: w.clickId, outcome: 'skipped', reason: 'pending-invalid' }], JSON.stringify(bad));
    assert.equal(w.records().length, 0);
    assert.equal(settledOf(w), null);
  }
  const future = pw(t);
  assert.ok((await future.hook()).pending);
  future.flush();
  future.t -= 6 * 60000; // the pointer was captured 5 min 1 s "after" now
  assert.deepEqual(future.settle().outcomes.map((o) => o.outcome), ['skipped']);
});

test('CAPTURE_SKEW_MS covers the installed hook timeout (the click hook is installed with timeout OWNER_GO_TIMEOUT_S)', () => {
  assert.ok(CAPTURE_SKEW_MS >= OWNER_GO_TIMEOUT_S * 1000, `${CAPTURE_SKEW_MS} < ${OWNER_GO_TIMEOUT_S} s`);
  assert.equal(CAPTURE_SKEW_MS, 15000);
  assert.equal(WAIT_GRACE_MS, 10 * 60 * 1000);
  assert.equal(SETTLE_SCAN_BUDGET, 32);
});

test('a pointer to an ask that is gone or no longer valid is refused ask-gone / ask-invalid; a pointer to a click that never was one is refused by the evidence', async (t) => {
  const gone = pw(t);
  assert.ok((await gone.hook()).pending);
  rmSync(join(asksDir(gone.home), `${gone.askId}.json`));
  assert.deepEqual(only(gone.settle(), gone, gone.clickId)[0], { askId: gone.askId, clickId: gone.clickId, outcome: 'refused', reason: 'ask-gone' });
  const invalid = pw(t);
  assert.ok((await invalid.hook()).pending);
  writeFileSync(join(asksDir(invalid.home), `${invalid.askId}.json`), '{"v":1}\n');
  assert.equal(only(invalid.settle(), invalid)[0].reason, 'ask-invalid');
  assert.equal(readAsk(invalid.askId, { home: invalid.home }).reason, 'invalid');
});

test('a hook answer in the transcript (no human stamp) is refused by the same evidence checks at settle time', async (t) => {
  const w = pw(t, { fixture: 'pretooluse-hook-answer' });
  assert.ok((await w.hook()).pending);
  w.flush();
  assert.equal(only(w.settle(), w)[0].reason, 'not-a-human-answer');
  assert.equal(w.records().length, 0);
});

test('fault injection: a crash between spent and record is finished from the marker; the click is retried, never lost, never recorded twice', async (t) => {
  const w = pw(t);
  assert.ok((await w.hook()).pending);
  w.flush();
  const crashed = w.settle({ io: { appendRecord: () => null } });
  assert.deepEqual(crashed.outcomes, [{ askId: w.askId, clickId: w.clickId, outcome: 'retry', reason: 'record-write-failed' }]);
  assert.ok(existsSync(w.spentFile), 'the marker was written');
  assert.equal(settledOf(w), null);
  assert.equal(w.records().length, 0);
  assert.equal(only(w.settle(), w)[0].outcome, 'recorded');
  assert.equal(w.records().length, 1);
  assert.equal(w.records()[0].ts, new Date(w.answeredAt).toISOString(), 'the finish keeps the answer time');
});

test('fault injection: io.appendRecord failing three times then working -> recorded on the 4th call, one record', async (t) => {
  const w = pw(t);
  assert.ok((await w.hook()).pending);
  w.flush();
  let calls = 0;
  const io = { appendRecord: (...a) => (++calls <= 3 ? null : appendRecord(...a)) };
  const outcomes = [1, 2, 3, 4].map(() => only(w.settle({ io }), w)[0].outcome);
  assert.deepEqual(outcomes, ['retry', 'retry', 'retry', 'recorded']);
  assert.equal(calls, 4);
  assert.equal(w.records().length, 1);
});

test('fault injection: a half-written .spent is retried, never settled; an O_EXCL collision on .spent (same click: the winner\'s record counts; another click: refused spent) and on .settled (the winner\'s outcome is reported)', async (t) => {
  const half = pw(t);
  assert.ok((await half.hook()).pending);
  half.flush();
  writeFileSync(half.spentFile, '{half');
  assert.deepEqual(only(half.settle(), half)[0], { askId: half.askId, clickId: half.clickId, outcome: 'retry', reason: 'spent' });
  assert.equal(settledOf(half), null);

  const same = pw(t);
  assert.ok((await same.hook()).pending);
  same.flush();
  const rival = { writeExclusive: (file, body) => { if (file.endsWith('.spent')) plainWrite(file, body); return plainWrite(file, body); } };
  assert.deepEqual(only(same.settle({ io: rival }), same)[0], { askId: same.askId, clickId: same.clickId, outcome: 'recorded' });
  assert.equal(same.records().length, 1);

  const other = pw(t);
  assert.ok((await other.hook()).pending);
  other.flush();
  const thief = { writeExclusive: (file, body) => (file.endsWith('.spent') ? (plainWrite(file, { ...body, clickId: 'f'.repeat(16), toolUseId: 'toolu_other' }), 'exists') : plainWrite(file, body)) };
  assert.deepEqual(only(other.settle({ io: thief }), other)[0], { askId: other.askId, clickId: other.clickId, outcome: 'refused', reason: 'spent' });
  assert.equal(other.records().length, 0);

  const loser = pw(t);
  assert.ok((await loser.hook()).pending);
  loser.flush();
  const winner = { writeExclusive: (file, body) => (file.endsWith('.settled') ? (plainWrite(file, { ...body, outcome: 'recorded', reason: null }), 'exists') : plainWrite(file, body)) };
  assert.deepEqual(only(loser.settle({ io: winner }), loser)[0], { askId: loser.askId, clickId: loser.clickId, outcome: 'recorded' });
  assert.equal(allSettled(loser.home).length, 1, 'one .settled, the winner\'s');
});

test('no re-entry: a settle started from inside a settle (a reader called by a write) returns at once and touches nothing', async (t) => {
  const w = pw(t);
  assert.ok((await w.hook()).pending);
  w.flush();
  let inner = null;
  const io = { writeExclusive: (file, body) => { inner ??= settlePendingClicks({ home: w.home, now: w.now }); return plainWrite(file, body); } };
  assert.equal(only(w.settle({ io }), w)[0].outcome, 'recorded');
  assert.deepEqual(inner, { outcomes: [], problems: [] });
  assert.equal(w.records().length, 1);
});

test('garbled pending skipped: unreadable JSON, a clickId that is not the hash of its own fields, a wrong name: no outcome but `skipped` (or none), no budget, the valid one still settles; settle never throws', async (t) => {
  const w = pw(t);
  assert.ok((await w.hook()).pending);
  w.flush();
  const dir = asksDir(w.home);
  writeFileSync(join(dir, `${w.askId}.${'0'.repeat(16)}.pending`), '{not json');
  const lie = clickIdOf('some-session', 'toolu_x', w.askId);
  writeFileSync(join(dir, `${w.askId}.${'1'.repeat(16)}.pending`), `${JSON.stringify({ ...readJson(w.pendingFile()), clickId: '1'.repeat(16) })}\n`);
  writeFileSync(join(dir, `${w.askId}.${lie}.pending`), `${JSON.stringify({ ...readJson(w.pendingFile()), clickId: lie })}\n`);
  writeFileSync(join(dir, `${w.askId}.pending`), '{}\n'); // not a pending name at all
  const r = w.settle();
  assert.deepEqual(r.outcomes.filter((o) => o.outcome === 'skipped').map((o) => o.clickId).sort(), ['0'.repeat(16), '1'.repeat(16), lie].sort());
  assert.equal(only(r, w)[0].outcome, 'recorded');
  assert.equal(allSettled(w.home).length, 1, 'only the valid one is settled');
  assert.deepEqual(settlePendingClicks({ home: join(tmpdir(), 'owner-go-click-pending-no-such-home') }), { outcomes: [], problems: [] });
  assert.equal(settlePendingClicks({ home: 42 }).problems.length, 1, 'a settle that cannot run reports a problem and does not throw');
});

// #528: the RETIRED list goes newest first, so the click the owner just made is reached before old stuck ones. Residual (stateless, no rotation): an old valid click behind 32 NEWER unverifiable ones is the mirror case;
// the 24 h evidence expiry still retires those without a scan.
test('retired units go newest first: a valid click made after 32 old unverifiable ones is still reached once all 33 are retired', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'owner-go-click-pending-'));
  const old = [];
  for (let i = 0; i < SETTLE_SCAN_BUDGET; i++) {
    const x = pw(t, { home, slot: i, pr: 100 + i });
    x.t += i; // distinct capture times; never flushed, so every one is `waiting`
    assert.ok((await x.hook()).pending, `unit ${i}`);
    old.push(x);
  }
  const A0 = old[0].answeredAt;
  const ready = pw(t, { home, slot: 40, pr: 140, shiftMs: 100000 });
  assert.ok((await ready.hook()).pending);
  ready.flush();
  const nowMs = A0 + 100000 + WAIT_GRACE_MS + 60000; // all 33 are past the grace (retired)
  const one = settlePendingClicks({ home, now: () => nowMs });
  assert.deepEqual(one.outcomes[0], { askId: ready.askId, clickId: ready.clickId, outcome: 'recorded' }, 'the newest retired unit goes first');
  assert.deepEqual(allSettled(home), [`${ready.askId}.${ready.clickId}.settled`], 'only the valid one is settled');
  assert.equal(one.outcomes.length, SETTLE_SCAN_BUDGET);
  assert.ok(one.outcomes.slice(1).every((o) => o.outcome === 'waiting'));
  const two = settlePendingClicks({ home, now: () => nowMs });
  assert.equal(two.outcomes.length, SETTLE_SCAN_BUDGET, 'a second settle still scans only the budget');
  assert.ok(two.outcomes.every((o) => o.outcome === 'waiting'), 'the 32 old units are still pending');
  assert.equal(allSettled(home).length, 1);
});

test('fair progress across retryable units: 40 retryable units ahead of 1 ready unit (15 missing transcripts, 15 half-written .spent, 10 failing record writes); a unit is never split by the budget', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'owner-go-click-pending-'));
  const worlds = [];
  for (let i = 0; i < 40; i++) {
    const x = pw(t, { home, slot: i, pr: 100 + i });
    x.t += i; // distinct capture times: FIFO order is the index
    assert.ok((await x.hook()).pending, `unit ${i}`);
    worlds.push(x);
  }
  const A0 = worlds[0].answeredAt;
  const ready = pw(t, { home, slot: 40, pr: 140, shiftMs: 100000 });
  assert.ok((await ready.hook()).pending);
  ready.flush();
  for (let i = 15; i < 40; i++) worlds[i].flush();
  for (let i = 15; i < 30; i++) writeFileSync(worlds[i].spentFile, '{half');
  const failing = new Set(worlds.slice(30).map((x) => x.askId));
  const io = { appendRecord: (h, s, rec) => (failing.has(rec.ask.askId) ? null : appendRecord(h, s, rec)) };
  const settleAt = (nowMs) => settlePendingClicks({ home, now: () => nowMs, io });

  const one = settleAt(A0 + 101000); // every unit is active (captured < 10 min ago)
  assert.equal(one.outcomes.length, SETTLE_SCAN_BUDGET);
  assert.deepEqual(one.outcomes.map((o) => o.askId), worlds.slice(0, SETTLE_SCAN_BUDGET).map((x) => x.askId), 'FIFO');
  assert.ok(one.outcomes.every((o) => o.outcome === 'waiting' || o.outcome === 'retry'));
  assert.ok(!one.outcomes.some((o) => o.askId === ready.askId), 'the ready unit is not reached');
  assert.deepEqual(allSettled(home), [], 'nothing settled for the 40');

  const two = settleAt(A0 + 650000); // the 40 are past the grace (retired), the ready unit is not
  assert.deepEqual(two.outcomes[0], { askId: ready.askId, clickId: ready.clickId, outcome: 'recorded' }, 'active before retired');
  assert.equal(two.outcomes.length, SETTLE_SCAN_BUDGET);
  assert.deepEqual(allSettled(home), [`${ready.askId}.${ready.clickId}.settled`], 'the 40 are still pending');

  for (let i = 0; i < 15; i++) worlds[i].flush(); // the faults clear
  for (let i = 15; i < 30; i++) rmSync(worlds[i].spentFile);
  failing.clear();
  assert.equal(settleAt(A0 + 650000).outcomes.filter((o) => o.outcome === 'recorded').length, SETTLE_SCAN_BUDGET);
  assert.equal(settleAt(A0 + 650000).outcomes.filter((o) => o.outcome === 'recorded').length, 40 - SETTLE_SCAN_BUDGET);
  assert.equal(allSettled(home).length, 41);
  assert.equal(readRecords({ home, settle: false, now: () => A0 + 650000, maxAgeMs: Infinity }).length, 41);

  // a unit is never split across the budget boundary: it starts only below the budget, and then every member is looked at
  const unitHome = (singles) => async () => {
    const h = mkdtempSync(join(tmpdir(), 'owner-go-click-pending-'));
    for (let i = 0; i < singles; i++) { const x = pw(t, { home: h, slot: i, pr: 200 + i }); x.t += i; assert.ok((await x.hook()).pending); }
    const u = pw(t, { home: h, slot: 90, pr: 290 });
    u.t += 1000;
    assert.ok((await u.hook()).pending);
    const [b, c] = [u.extra('toolu_b'), u.extra('toolu_c')];
    for (const x of [b, c]) { u.t += 1; assert.ok((await u.hook({}, { tool_use_id: x.id })).pending); x.flush(); }
    u.flush();
    return { h, u, ids: [u.clickId, b.clickId, c.clickId] };
  };
  const below = await unitHome(SETTLE_SCAN_BUDGET - 1)();
  const seen = settlePendingClicks({ home: below.h, now: () => below.u.t }).outcomes.filter((o) => o.askId === below.u.askId);
  assert.deepEqual(seen.map((o) => o.clickId).sort(), [...below.ids].sort(), 'started below the budget: all three members visited');
  const at = await unitHome(SETTLE_SCAN_BUDGET)();
  assert.equal(settlePendingClicks({ home: at.h, now: () => at.u.t }).outcomes.filter((o) => o.askId === at.u.askId).length, 0, 'the budget is spent: the unit is not started');
});

test('two settler processes (click-race.mjs role=settle, one barrier, 20 runs) -> one spent, readRecords returns one record', async (t) => {
  const child = fileURLToPath(new URL('./helpers/click-race.mjs', import.meta.url));
  const libDir = fileURLToPath(new URL('../pipeline/hooks/lib/', import.meta.url));
  for (let run = 0; run < 20; run++) {
    const w = pw(t);
    assert.ok((await w.hook()).pending);
    w.flush();
    const barrier = join(w.home, 'barrier');
    const procs = [0, 1].map(() => {
      const c = spawn(process.execPath, [child, 'settle', libDir, w.home, barrier, String(w.t)], { stdio: ['ignore', 'pipe', 'pipe'] });
      const p = { out: '', err: '' };
      p.ready = new Promise((resolve) => { c.stdout.on('data', (d) => { p.out += d; if (p.out.includes('ready')) resolve(); }); c.on('close', resolve); });
      p.done = new Promise((resolve) => { c.on('close', resolve); });
      c.stderr.on('data', (d) => { p.err += d; });
      return p;
    });
    await Promise.all(procs.map((p) => p.ready));
    writeFileSync(barrier, '');
    const codes = await Promise.all(procs.map((p) => p.done));
    assert.deepEqual(codes, [0, 0], `run ${run}: ${procs.map((p) => p.err).join('|')}`);
    assert.equal(readdirSync(asksDir(w.home)).filter((n) => n.endsWith('.spent')).length, 1, `run ${run}: one spent`);
    assert.equal(readRecords({ home: w.home, settle: false, now: w.now, maxAgeMs: Infinity }).length, 1, `run ${run}: one record`);
    assert.ok(allSettled(w.home).length >= 1 && settledOf(w).outcome === 'recorded', `run ${run}`);
  }
});

test('click-race.mjs refuses (exit code 2, never 0) to run on the account home', () => {
  const child = fileURLToPath(new URL('./helpers/click-race.mjs', import.meta.url));
  const libDir = fileURLToPath(new URL('../pipeline/hooks/lib/', import.meta.url));
  const r = spawnSync(process.execPath, [child, 'settle', libDir, accountHome(), join(tmpdir(), 'never-opened-barrier'), '0'], { encoding: 'utf8' });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal(r.stdout.includes('ready'), false);
});

// ---- Task 4: readers settle; read-only paths never do -------------------------------------------------------------------------------------

// A world whose click has been captured at the hook and whose result entry has since landed: everything is ready for a reader to settle it.
const flushedWorld = async (t, opts = {}) => { const w = pw(t, opts); assert.ok((await w.hook()).pending); w.flush(); return w; };
const withSwitch = (value, fn) => {
  const before = process.env.PIPELINE_CLICK_SETTLE;
  if (value === undefined) delete process.env.PIPELINE_CLICK_SETTLE; else process.env.PIPELINE_CLICK_SETTLE = value;
  try { return fn(); } finally { if (before === undefined) delete process.env.PIPELINE_CLICK_SETTLE; else process.env.PIPELINE_CLICK_SETTLE = before; }
};

test('every consumer verifies a pending click by itself (settle: true): approvalGap, approvedPr (only its session), readApprovals, ownerRuled, ownerGrantedRounds', async (t) => {
  const merge = await flushedWorld(t);
  assert.equal(merge.gap({ settle: true }), 'ok');
  assert.equal(merge.records().length, 1);
  const guarded = await flushedWorld(t);
  const ask = { repo: REPO, pr: 58, head: HEAD, home: guarded.home, now: guarded.now, settle: true };
  assert.equal(approvedPr({ ...ask, session: 'some-other-session' }), false, 'the guard reads one session: another session\'s read settles nothing of this one');
  assert.deepEqual(allSettled(guarded.home), []);
  assert.equal(approvedPr({ ...ask, session: guarded.session }), true);
  assert.equal(allSettled(guarded.home).length, 1);
  const approvals = await flushedWorld(t);
  const list = readApprovals({ home: approvals.home, now: approvals.now, settle: true });
  assert.equal(list[0]?.via, 'ask');
  assert.equal(list[0].ask.askId, approvals.askId);
  const ruling = await flushedWorld(t, { kind: 'ruling', answer: 'Accept all' });
  const q = { repo: REPO, pr: 58, quote: 'R1-B1: accept, R2-S3: accept', decision: 'ACCEPT', contentOf: () => 'c0ffee000000', home: ruling.home, now: ruling.now, settle: true };
  assert.equal(ownerRuled({ ...q, id: 'R1-B1' }), true);
  const round = await flushedWorld(t, { kind: 'round', answer: 'Yes, one more round' });
  const granted = ownerGrantedRounds({ repo: REPO, pr: 58, k: 4, head: GHEAD, home: round.home, now: round.now, settle: true });
  assert.equal(granted.length, 1, JSON.stringify(granted));
  assert.equal(granted[0].via, 'ask');
});

test('settle: false and the environment switch leave the pending alone; settle: true overrides the switch', async (t) => {
  const w = await flushedWorld(t);
  assert.equal(w.gap({ settle: false }), 'none');
  assert.equal(withSwitch(undefined, () => w.gap({ settle: false })), 'none');
  assert.equal(withSwitch('off', () => w.gap({ settle: undefined })), 'none', 'the test switch');
  assert.deepEqual(allSettled(w.home), []);
  assert.equal(existsSync(w.spentFile), false);
  assert.equal(w.records().length, 0);
  assert.equal(withSwitch('off', () => w.gap({ settle: true })), 'ok', 'an explicit settle: true wins');
  assert.equal(allSettled(w.home).length, 1);
  const d = await flushedWorld(t);
  assert.equal(withSwitch(undefined, () => d.gap({ settle: undefined })), 'ok', 'by default a reader settles');
});

// #740 / R1-B2: queuedApprovalAt only EXPLAINS a refusal, so it must not spend a pending click (settle with the switch on would write the .settled marker and the record while the command refuses).
test('queuedApprovalAt never settles a pending click, even with settling on by default (#740)', async (t) => {
  const w = await flushedWorld(t);
  const q = { repo: REPO, pr: 58, head: HEAD, items: ITEMS, areas: [], home: w.home, now: w.now };
  assert.equal(withSwitch(undefined, () => queuedApprovalAt(q)), null);
  assert.deepEqual(allSettled(w.home), []);
  assert.equal(existsSync(w.spentFile), false);
  assert.equal(w.records().length, 0);
  assert.equal(withSwitch(undefined, () => w.gap({ settle: undefined })), 'ok', 'the click was still ready: an ordinary read settles it');
});

test('a settle that cannot run never breaks readRecords: the typed records still count and the fault is a problem', async (t) => {
  const w = await flushedWorld(t);
  const typed = { v: 1, ts: new Date(w.answeredAt + 2000).toISOString(), session: w.session, prompt: 'merge', prs: [58], requests: [{ pr: 58, head: HEAD.slice(0, 12), items: ITEMS, repo: REPO }] };
  assert.ok(appendRecord(w.home, w.session, typed));
  rmSync(asksDir(w.home), { recursive: true });
  writeFileSync(asksDir(w.home), 'not a folder');
  const problems = [];
  const records = readRecords({ home: w.home, now: w.now, settle: true, problems });
  assert.deepEqual(records.map((r) => r.prompt), ['merge']);
  assert.ok(problems.some((p) => /asks folder cannot be read/.test(p)), JSON.stringify(problems));
});

test('a typed word after a pending click: both stand', async (t) => {
  const w = await flushedWorld(t);
  const typed = { v: 1, ts: new Date(w.answeredAt + 5000).toISOString(), session: w.session, prompt: 'merge', prs: [58], requests: [{ pr: 58, head: HEAD.slice(0, 12), items: ITEMS, repo: REPO }] };
  assert.ok(appendRecord(w.home, w.session, typed));
  const records = readRecords({ home: w.home, now: w.now, settle: true });
  assert.deepEqual(records.map((r) => r.via ?? 'typed').sort(), ['ask', 'typed']);
});

// ---- Task 1 (F4): a test that claims a round cleans up exactly what it created --------------------------------------------------------------

test('cleanupRoundClaims refuses a repository name that is not unique to the test, and removes exactly the ticket and markers of its own round', () => {
  for (const slug of ['acme/widgets', 'acme/app', 'acme/widgets-1234', REPO]) assert.throws(() => cleanupRoundClaims({ slug, pr: 7, k: 3, grantIds: [], home: mkdtempSync(join(tmpdir(), 'owner-go-cleanup-')) }), /not unique to the test/, slug);
  const home = mkdtempSync(join(tmpdir(), 'owner-go-cleanup-'));
  const slug = `acme/widgets-${randomUUID()}`;
  const mine = roundTicketKey(slug, 7, 3);
  const theirs = roundTicketKey(`acme/widgets-${randomUUID()}`, 7, 3);
  const dir = join(ownerGoDir(home), 'round-claims');
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(ownerGoDir(home), 'consumed'), { recursive: true });
  const consumed = (id) => join(ownerGoDir(home), 'consumed', `${id}.json`);
  const ids = { named: 'a'.repeat(16), given: 'b'.repeat(16), other: 'c'.repeat(16) };
  writeFileSync(join(dir, `${mine}.1.json`), JSON.stringify({ v: 1, grantIds: [ids.named] }));
  writeFileSync(join(dir, `${mine}.2.json`), '{"v":1'); // an unparseable one of its own: removed, names nothing
  writeFileSync(join(dir, `${theirs}.1.json`), '{}');
  for (const id of Object.values(ids)) writeFileSync(consumed(id), '{}');
  const run = cleanupRoundClaims({ slug, pr: 7, k: 3, grantIds: [ids.given], home });
  run();
  assert.deepEqual(readdirSync(dir), [`${theirs}.1.json`], 'only the tickets of its own key');
  assert.deepEqual(readdirSync(join(ownerGoDir(home), 'consumed')), [`${ids.other}.json`], 'the markers named by its tickets and the ones it was given; nobody else\'s');
  run(); // twice is harmless
});

// ---- Task 5: round grants: tickets, sweep, coverage, strict lookups --------------------------------------------------------------------------

const CBODY = { repo: REPO, pr: 58, k: 4, head: GHEAD, checkout: '/work/app' };
const TICKET_KEY = roundTicketKey(REPO, 58, 4);
const ticketsOf = (home) => { try { return readdirSync(join(ownerGoDir(home), 'round-claims')).sort(); } catch { return []; } };
const openGrants = (home, now, over = {}) => ownerGrantedRounds({ repo: REPO, pr: 58, k: 4, head: GHEAD, home, now, settle: false, ...over });
const allRecords = (home, now) => readRecords({ home, now, settle: false, maxAgeMs: Infinity });
const isoOf = (ms) => new Date(ms).toISOString();
const spentVerifiable = (home, record) => { const m = readGrantMarker(grantIdOf(record), { home }); return m.spent && m.verifiable ? m.marker : null; };
// A round click, captured at the hook and flushed to the transcript, not yet settled.
const roundClick = async (t, opts = {}) => {
  const w = pw(t, { kind: 'round', answer: 'Yes, one more round', ...opts });
  assert.ok((await w.hook()).pending);
  w.flush();
  return w;
};
// The owner TYPED "extra round" (a record the typed recorder writes) at `atMs`, into the click world's home (a transcript root the checks accept).
function typedGrant(home, { atMs, session = `typed-${randomUUID().slice(0, 8)}`, head = GHEAD }) {
  const folder = join(home, '.claude-click-test', 'projects', '-repo');
  mkdirSync(folder, { recursive: true });
  const promptId = `pid-${randomUUID()}`;
  const file = join(folder, `${session}.jsonl`);
  writeFileSync(file, linesOf([
    { type: 'user', message: { content: 'go' }, promptId: `pid-${randomUUID()}`, ...OWNER_ENTRY },
    { type: 'assistant', message: { content: [{ type: 'text', text: roundRequest(58, 4, head, REPO) }] } },
    { type: 'user', message: { content: 'extra round' }, promptId, ...OWNER_ENTRY },
  ]));
  const rec = recordRoundGrant({ hook_event_name: 'UserPromptSubmit', session_id: session, transcript_path: file, cwd: '/work/app', prompt: 'extra round', prompt_id: promptId }, { home, now: () => atMs });
  assert.ok(rec, 'the typed grant was recorded');
  return rec;
}

test('two claimers with disjoint snapshots (deterministic, both orders): claimer A runs inside B\'s filtering; exactly one claim wins, the other is refused used, nothing stays open, every covered grant has its own marker', async (t) => {
  for (const trigger of ['click', 'typed']) {
    const w = await roundClick(t);
    typedGrant(w.home, { atMs: w.answeredAt - 5000 });
    assert.equal(only(w.settle(), w)[0].outcome, 'recorded');
    const all = openGrants(w.home, w.now);
    assert.equal(all.length, 2, 'a typed word and a click, both open');
    let ran = false;
    let a = null;
    const io = {
      afterSpentCheck: (r) => {
        if (ran || (r.via === 'ask') !== (trigger === 'click')) return;
        ran = true;
        a = claimGrantMarkers(all.filter((x) => grantIdOf(x) !== grantIdOf(r)), CBODY, { home: w.home, now: w.now, ticket: true }); // the OTHER grant: B's snapshot never meets it
      },
    };
    const snapshot = openGrants(w.home, w.now, { io });
    assert.equal(ran, true, `${trigger}: the seam ran`);
    assert.ok(snapshot.length >= 1, `${trigger}: B kept the grant it had seen`);
    const b = claimGrantMarkers(snapshot, CBODY, { home: w.home, now: () => w.t + 1, ticket: true });
    assert.deepEqual([a.ok, b.ok, b.reason], [true, false, 'used'], `${trigger}: ${JSON.stringify({ a, b })}`);
    assert.deepEqual(openGrants(w.home, w.now), [], `${trigger}: nothing is open`);
    assert.deepEqual(ticketsOf(w.home), [`${TICKET_KEY}.1.json`], `${trigger}: one ticket`);
    for (const r of all) assert.ok(spentVerifiable(w.home, r), `${trigger}: ${r.via ?? 'typed'} grant has its own verifiable marker`);
  }
});

// Spawns one click-race.mjs process; `ready` resolves when it printed `ready` (or ended), `mid` when it printed `mid` (a claimer inside its filtering).
const raceChild = (args) => {
  const c = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const p = { out: '', err: '' };
  const seen = (word) => new Promise((resolve) => { c.stdout.on('data', (d) => { p.out += d; if (p.out.includes(word)) resolve(); }); c.on('close', resolve); });
  p.ready = seen('ready');
  p.mid = seen('mid');
  p.done = new Promise((resolve) => { c.on('close', resolve); });
  c.stderr.on('data', (d) => { p.err += d; });
  return p;
};

test('two claimer processes (click-race.mjs role=claim, a barrier inside their filtering) and a settler: exactly one claim wins, nothing stays open, every covered grant has its own marker (20 runs)', async (t) => {
  const child = fileURLToPath(new URL('./helpers/click-race.mjs', import.meta.url));
  const libDir = fileURLToPath(new URL('../pipeline/hooks/lib/', import.meta.url));
  for (let run = 0; run < 20; run++) {
    const w = await roundClick(t);
    typedGrant(w.home, { atMs: w.answeredAt - 5000 });
    const barrier = join(w.home, 'barrier');
    const claimers = [0, 1].map(() => raceChild([child, 'claim', libDir, w.home, barrier, String(w.t), REPO, '58', '4', GHEAD]));
    const settler = raceChild([child, 'settle', libDir, w.home, barrier, String(w.t)]);
    await Promise.all([...claimers, settler].map((p) => p.ready));
    await Promise.all(claimers.map((p) => p.mid));
    writeFileSync(barrier, '');
    const codes = await Promise.all([...claimers, settler].map((p) => p.done));
    assert.deepEqual(codes, [0, 0, 0], `run ${run}: ${[...claimers, settler].map((p) => p.err).join('|')}`);
    const claims = claimers.map((p) => JSON.parse(p.out.trim().split('\n').at(-1)));
    assert.equal(claims.filter((c) => c.ok).length, 1, `run ${run}: exactly one claim wins: ${JSON.stringify(claims)}`);
    for (const c of claims.filter((x) => !x.ok)) assert.ok(['used', 'none'].includes(c.reason), `run ${run}: ${JSON.stringify(c)}`);
    assert.deepEqual(openGrants(w.home, w.now), [], `run ${run}: nothing is open`);
    assert.deepEqual(ticketsOf(w.home), [`${TICKET_KEY}.1.json`], `run ${run}: one ticket`);
    const records = allRecords(w.home, w.now).filter((r) => r.kind === 'extra-round');
    assert.equal(records.length, 2, `run ${run}: the click was recorded too`);
    for (const r of records) assert.ok(spentVerifiable(w.home, r), `run ${run}: ${r.via ?? 'typed'} grant has its own marker (no reader repaired it: settle was false)`);
  }
});

test('an old ticket-less claim made while a click was pending, then a re-upgrade (F1): the click is covered by the old claim\'s consumed marker and gets a repair marker copying it; a click answered after the claim is admitted', async (t) => {
  const w = await roundClick(t);
  const a = w.answeredAt;
  const typed = typedGrant(w.home, { atMs: a + 5000 });
  const claimedAt = a + 10_000;
  const old = claimGrantMarkers([typed], CBODY, { home: w.home, now: () => claimedAt }); // today's code path: no ticket
  assert.equal(old.ok, true);
  assert.deepEqual(ticketsOf(w.home), []);
  w.t = claimedAt + 1000;
  assert.equal(only(w.settle(), w)[0].outcome, 'recorded');
  assert.deepEqual(openGrants(w.home, w.now), [], 'covered by the old claim\'s marker: spent for new readers');
  const click = w.records().find((r) => r.via === 'ask');
  const m = spentVerifiable(w.home, click);
  assert.ok(m, 'the click has its own marker');
  assert.deepEqual([m.head, m.consumedAt, m.coveredBy, m.repo, m.pr, m.k], [GHEAD, isoOf(claimedAt), grantIdOf(typed), REPO, 58, 4], 'copied from the claim, never now');
  // a click answered after the claim is a new grant
  const later = pw(t, { home: w.home, slot: 1, kind: 'round', answer: 'Yes, one more round', shiftMs: 3_600_000 });
  assert.ok((await later.hook()).pending);
  later.flush();
  assert.equal(only(later.settle(), later)[0].outcome, 'recorded');
  assert.deepEqual(openGrants(w.home, later.now).map((r) => r.via), ['ask'], 'admitted');
});

test('settle vs claim interleavings: a late click is spent for new readers AND has its own verifiable marker, whichever side goes first', async (t) => {
  const claimAt = (w) => w.answeredAt + 500;
  const claim = (w, records, io) => claimGrantMarkers(records, CBODY, { home: w.home, now: () => claimAt(w), ticket: true, io });
  const variants = {
    'settled before the snapshot': (w) => { w.settle(); return claim(w, openGrants(w.home, w.now)); },
    'settled between the snapshot and the claim': (w, typed) => { const snapshot = [typed]; w.settle(); return claim(w, snapshot); },
    'settled between the ticket and the grant markers': (w, typed) => claim(w, [typed], { afterTicket: () => { w.settle(); } }),
    'settled after the claim': (w, typed) => { const c = claim(w, [typed]); w.settle(); return c; },
  };
  for (const [label, run] of Object.entries(variants)) {
    const w = await roundClick(t);
    const typed = typedGrant(w.home, { atMs: w.answeredAt - 5000 });
    const claimed = run(w, typed);
    assert.equal(claimed.ok, true, `${label}: ${JSON.stringify(claimed)}`);
    assert.equal(w.records().filter((r) => r.via === 'ask').length, 1, `${label}: the click was recorded`);
    assert.deepEqual(openGrants(w.home, w.now), [], `${label}: spent for new readers`);
    for (const r of allRecords(w.home, w.now)) {
      const m = spentVerifiable(w.home, r);
      assert.ok(m, `${label}: ${r.via ?? 'typed'} grant has its own verifiable marker`);
      assert.deepEqual([m.head, m.coveredBy], [GHEAD, `${TICKET_KEY}.1`], label);
    }
  }
});

test('old-reader compatibility: a covered late click has a spent, verifiable per-grant marker (all the pre-#472 reader checks); with it deleted the next extra-round read repairs it, settle: false does not', async (t) => {
  const w = await roundClick(t);
  const typed = typedGrant(w.home, { atMs: w.answeredAt - 5000 });
  assert.equal(claimGrantMarkers([typed], CBODY, { home: w.home, now: () => w.answeredAt + 500, ticket: true }).ok, true);
  assert.equal(only(w.settle(), w)[0].outcome, 'recorded');
  const click = w.records().find((r) => r.via === 'ask');
  const id = grantIdOf(click);
  const m = readGrantMarker(id, { home: w.home });
  assert.equal(m.spent === true && m.verifiable === true, true);
  const file = join(ownerGoDir(w.home), 'consumed', `${id}.json`);
  rmSync(file);
  assert.deepEqual(openGrants(w.home, w.now), [], 'still spent for new readers');
  assert.equal(existsSync(file), false, 'settle: false repairs nothing');
  assert.deepEqual(ownerGrantedRounds({ repo: REPO, pr: 58, k: 4, head: GHEAD, home: w.home, now: w.now }), [], 'the default read');
  assert.ok(spentVerifiable(w.home, click), 'repaired by the read');
  assert.equal(readGrantMarker(id, { home: w.home }).marker.coveredBy, `${TICKET_KEY}.1`);
});

test('a click grant consumed with a ticket verifies 30 hours later (coverage is never applied in verifyOwnerGrant)', async (t) => {
  const w = await roundClick(t);
  assert.equal(only(w.settle(), w)[0].outcome, 'recorded');
  const [click] = openGrants(w.home, w.now);
  const claimed = claimGrantMarkers([click], CBODY, { home: w.home, now: w.now, ticket: true });
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  const q = { repo: REPO, pr: 58, k: 4, toHead: GHEAD, ownerGrant: { grantId: grantIdOf(click), quote: click.prompt } };
  const v = verifyOwnerGrant(q, { home: w.home, now: () => w.t + 30 * 3600_000 });
  assert.equal(v.ok, true, JSON.stringify(v));
});

test('strict lookups keep an unresolved round click until its evidence expires (no .settled on time alone): after the grace, after the next settle, with a NEW lookup; another repository or PR never refuses; the switch does not matter', async (t) => {
  const w = pw(t, { kind: 'round', answer: 'Yes, one more round' });
  assert.ok((await w.hook()).pending); // never flushed: the transcript has no answer
  const capturedMs = w.t;
  const lookups = (ms, over = {}) => ownerGrantLookups({ repo: REPO, pr: 58, home: w.home, now: () => ms, ...over });
  const state = () => {
    const item = (id, over = {}) => ({ id, round: 2, bucket: 'SUGGESTION', category: 'docs', title: 'x', file: 'src/a.js', line: 1, detail: 'd', codexReasoning: 'c', testable: false, fingerprint: `fp-${id}`, judge: null, test: { status: 'none', evidence: '' }, arbiter: null, final: { decision: 'ACCEPT', by: 'judge', needsHuman: false, reason: 'r' }, implemented: true, implementedAfterRound: 1, followupIssue: null, ...over });
    const hash = 'a'.repeat(64);
    const round = (n, items, over = {}) => ({ n, fromHead: 'f'.repeat(40), toHead: 'e'.repeat(40), contentHashAtToHead: hash, items, ...over });
    return { pr: 7, maxRounds: 1, currentContentHash: hash, rounds: [round(1, [item('R1-S0', { round: 1, file: 'src/a.js' })]), round(2, [item('R2-S1')], { admission: 'auto-extra' })] };
  };
  const config = { risk: { high_risk_paths: [] }, review: { arbiter_always_paths: [] } };
  const files = [{ oldPath: 'src/a.js', newPath: 'src/a.js', path: 'src/a.js' }];
  const refusal = (ms, over) => { const l = lookups(ms, over); return deferEligibility(state(), config, files, { grants: l.grants, grantGap: l.grantGap }); };
  const CLICK = /round ask for #58/;
  for (const sw of ['off', undefined]) {
    const run = (fn) => withSwitch(sw, fn);
    assert.throws(() => run(() => lookups(capturedMs + 1000).grants(3)), CLICK, `fresh (${sw})`);
    const grace = capturedMs + WAIT_GRACE_MS + 1000;
    run(() => w.settle({ now: () => grace }));
    assert.equal(allSettled(w.home).length, 0, 'the grace settles nothing');
    const refused = run(() => refusal(grace));
    assert.equal(refused.eligible, false);
    assert.match(refused.refusals.join(';'), /could not be read[\s\S]*round ask for #58/, `after the grace (${sw})`);
    assert.deepEqual(run(() => ownerGrantedRounds({ repo: REPO, pr: 58, k: 4, head: GHEAD, home: w.home, now: () => grace })), [], 'and no grant is open');
    assert.doesNotThrow(() => run(() => lookups(grace, { repo: 'acme/other' }).grants(3)), 'another repository');
    assert.doesNotThrow(() => run(() => lookups(grace, { pr: 59 }).grants(3)), 'another PR');
  }
  const expired = capturedMs + CAPTURE_SKEW_MS + MAX_AGE_MS + 1000;
  withSwitch('off', () => assert.equal(refusal(expired - 3000).eligible, false, 'with the switch off and nothing settled it still refuses right up to the expiry'));
  withSwitch('off', () => assert.equal(refusal(expired).eligible, true, 'and not after it, settled or not'));
  withSwitch(undefined, () => w.settle({ now: () => expired }));
  assert.deepEqual([settledOf(w)?.outcome, settledOf(w)?.reason], ['refused', 'evidence-expired']);
  assert.equal(refusal(expired).eligible, true, 'a NEW lookup no longer refuses for it');
});

// ---- Task 6: a pending marker is only a pointer (the forgery net) ---------------------------------------------------------------------------
// Each forged pointer below is settled through the SAME checks the immediate path applies, so it records nothing and spends nothing; the refusal is the one named.

const forged = async (t, { opts = {}, hook = {}, prepare = () => {}, settleAt = (w) => w.t, label }) => {
  const w = pw(t, opts);
  assert.ok((await w.hook(hook)).pending, `${label}: captured`);
  prepare(w);
  w.flush();
  w.t = settleAt(w);
  const o = only(w.settle(), w)[0];
  assert.equal(w.records().length, 0, `${label}: nothing recorded`);
  assert.equal(existsSync(w.spentFile), false, `${label}: nothing spent`);
  return o;
};
const repoint = (w, patch) => writeFileSync(w.pendingFile(), `${JSON.stringify({ ...readJson(w.pendingFile()), ...patch })}\n`);

test('a forged pending is settled by the transcript, not believed: hook-answered fixtures, a model-prefilled dialog, another session\'s transcript, a subagent or /tmp copy, another hook fingerprint, an ask that is gone, a stale answer', async (t) => {
  for (const fixture of ['pretooluse-hook-answer', 'permissionrequest-hook-answer']) {
    const o = await forged(t, { opts: { fixture }, label: fixture });
    assert.deepEqual([o.outcome, o.reason], ['refused', 'not-a-human-answer'], fixture);
  }
  const prefilled = await forged(t, { label: 'model-prefilled', prepare: (w) => {
    w.use.message.content.find((b) => b.type === 'tool_use').input = { questions: [w.dialog], answers: { [w.dialog.question]: 'Merge' } };
    writeFileSync(w.file, w.text([w.prompt, w.use]));
  } });
  assert.deepEqual([prefilled.outcome, prefilled.reason], ['refused', 'tool-use-shape']);
  const other = await forged(t, { label: 'another session', prepare: (w) => {
    const session = 'some-other-session';
    const clickId = clickIdOf(session, w.toolUseId, w.askId);
    rmSync(w.pendingFile());
    writeFileSync(w.pendingFile(clickId), `${JSON.stringify({ v: 1, askId: w.askId, clickId, session, toolUseId: w.toolUseId, transcriptPath: w.file, cwd: null, hookLayersSha256: null, capturedAt: new Date(w.t).toISOString() })}\n`);
    w.clickId = clickId;
  } });
  assert.deepEqual([other.outcome, other.reason], ['refused', 'session']);
  for (const [label, where] of [['a copy in /tmp', (w) => join(tmpdir(), `forged-${w.askId}.jsonl`)], ['a subagent transcript', (w) => join(w.home, '.claude-click-test', 'projects', '-repo', 'subagents', 'agent-1.jsonl')]]) {
    const o = await forged(t, { label, prepare: (w) => {
      const copy = where(w);
      mkdirSync(join(copy, '..'), { recursive: true });
      writeFileSync(copy, readFileSync(w.file));
      repoint(w, { transcriptPath: copy });
    } });
    assert.deepEqual([o.outcome, o.reason], ['refused', 'transcript-not-protected'], label);
  }
  const fp = 'a'.repeat(64);
  const changed = await forged(t, { opts: { hookLayersSha256: fp }, hook: { hookCheck: () => ({ ok: true, hookLayersSha256: fp }) }, label: 'another fingerprint', prepare: (w) => repoint(w, { hookLayersSha256: 'b'.repeat(64) }) });
  assert.deepEqual([changed.outcome, changed.reason], ['refused', 'dialog-hooks-changed']);
  const gone = await forged(t, { label: 'ask gone', prepare: (w) => rmSync(join(asksDir(w.home), `${w.askId}.json`)) });
  assert.deepEqual([gone.outcome, gone.reason], ['refused', 'ask-gone']);
  const stale = await forged(t, { label: 'stale', settleAt: (w) => w.answeredAt + MAX_AGE_MS + 5000 });
  assert.deepEqual([stale.outcome, stale.reason], ['refused', 'stale']);
});

test('a pointer with a clickId that is not the hash of its own fields is skipped; a second pointer on a spent ask is refused spent and the ask yields one record', async (t) => {
  const w = pw(t);
  assert.ok((await w.hook()).pending);
  const bad = 'f'.repeat(16);
  rmSync(w.pendingFile());
  writeFileSync(w.pendingFile(bad), `${JSON.stringify({ v: 1, askId: w.askId, clickId: bad, session: w.session, toolUseId: w.toolUseId, transcriptPath: w.file, cwd: null, hookLayersSha256: null, capturedAt: new Date(w.t).toISOString() })}\n`);
  w.flush();
  assert.deepEqual(w.settle().outcomes, [{ askId: w.askId, clickId: bad, outcome: 'skipped', reason: 'pending-invalid' }]);
  assert.equal(w.records().length, 0);
  // replay: a second click on the same ask after the first one was settled
  const r = pw(t);
  assert.ok((await r.hook()).pending);
  const second = r.extra('toolu_second');
  assert.ok((await r.hook({}, { tool_use_id: 'toolu_second' })).pending);
  r.flush();
  second.flush();
  const outcomes = r.settle().outcomes.map((o) => [o.outcome, o.reason ?? null]);
  assert.deepEqual(outcomes.sort(), [['recorded', null], ['refused', 'spent']].sort());
  assert.equal(r.records().length, 1, 'one record, one spent');
  assert.equal(readdirSync(asksDir(r.home)).filter((n) => n.endsWith('.spent')).length, 1);
});

// ---- Task 8: what the agent and the owner are told when a consumer refuses ------------------------------------------------------------------

const treeOf = (home) => {
  const out = [];
  const walk = (d) => {
    try {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else out.push(`${p}:${statSync(p).mtimeMs}:${statSync(p).size}`);
      }
    } catch { /* none */ }
  };
  walk(join(home, '.claude'));
  return out.sort();
};

test('clickNotes: a click that is waiting, then one still unverified after the grace, then (the evidence expired) nothing; it never writes', async (t) => {
  const w = pw(t, { kind: 'round', answer: 'Yes, one more round' });
  assert.ok((await w.hook()).pending); // never flushed
  const before = treeOf(w.home);
  const notes = (ms, over = {}) => clickNotes({ home: w.home, repo: REPO, prs: [58], kinds: ['round'], now: () => ms, ...over });
  const fresh = notes(w.t + 1000);
  assert.equal(fresh.length, 1);
  assert.match(fresh[0], /owner click on the round dialog for #58 .*was received and is waiting to be verified/);
  assert.match(fresh[0], /run the command again/);
  const late = notes(w.t + WAIT_GRACE_MS + 1000);
  assert.equal(late.length, 1);
  assert.match(late[0], /still unverified after 10 minutes/);
  assert.match(late[0], /type the closing words/);
  assert.deepEqual(notes(w.t + CAPTURE_SKEW_MS + MAX_AGE_MS + 1000), [], 'the evidence expired: nothing to say');
  assert.deepEqual(treeOf(w.home), before, 'no write of any kind');
});

test('clickNotes: a refused click says why and points to the typed words; "Not yet" says nothing is approved; other kinds, PRs and repositories are not mentioned', async (t) => {
  const bad = pw(t, { fixture: 'pretooluse-hook-answer' });
  assert.ok((await bad.hook()).pending);
  bad.flush();
  bad.settle();
  const refused = clickNotes({ home: bad.home, repo: REPO, prs: [58], kinds: ['merge', 'merge-many'], now: bad.now });
  assert.equal(refused.length, 1);
  assert.match(refused[0], /owner click on the merge dialog for #58 .*could not be verified \(not-a-human-answer\)/);
  assert.match(refused[0], /type the closing words/);
  const no = pw(t, { answer: 'Not yet' });
  assert.ok((await no.hook()).pending);
  no.flush();
  no.settle();
  const declined = clickNotes({ home: no.home, repo: REPO, prs: [58], kinds: ['merge'], now: no.now });
  assert.equal(declined.length, 1);
  assert.match(declined[0], /declined|chose "Not yet"/);
  assert.match(declined[0], /nothing is approved/);
  assert.deepEqual(clickNotes({ home: no.home, repo: REPO, prs: [59], kinds: ['merge'], now: no.now }), [], 'another PR');
  assert.deepEqual(clickNotes({ home: no.home, repo: REPO, prs: [58], kinds: ['round'], now: no.now }), [], 'another kind');
  assert.deepEqual(clickNotes({ home: no.home, repo: 'acme/other', prs: [58], kinds: ['merge'], now: no.now }), [], 'another repository');
});

// #538 / #542: the notes follow the ask the owner was shown LAST for this PR; every pointer of an older ask is dropped, whatever its outcome. Spent and replay semantics are untouched.
test('clickNotes: only the newest issued ask that shows the PR is reported; an older ask\'s decline, refusal or waiting note is not printed once a newer ask exists', async (t) => {
  const A = pw(t, { answer: 'Not yet' });
  assert.ok((await A.hook()).pending);
  A.flush();
  A.settle();
  const read = (w, over = {}) => clickNotes({ home: w.home, repo: REPO, prs: [58], kinds: ['merge', 'merge-many'], now: w.now, ...over });
  assert.equal(read(A).length, 1, 'alone, the decline of A is reported (unchanged)');
  assert.match(read(A)[0], /was declined/);
  // B is issued after A was declined and never clicked: A's decline is stale, the owner last saw B
  const B = pw(t, { home: A.home, slot: 1, shiftMs: 3_600_000 });
  B.t = Math.max(A.t, B.t);
  assert.deepEqual(read(B), [], 'a stale decline is not printed after a newer ask');
  // B answered Merge and recorded: nothing to say either
  assert.ok((await B.hook()).pending);
  B.flush();
  B.settle();
  assert.equal(B.records().filter((r) => r.via === 'ask').length, 1);
  assert.deepEqual(read(B), []);
  // a refused older ask and a waiting older ask are dropped the same way
  const C = pw(t, { fixture: 'pretooluse-hook-answer' });
  assert.ok((await C.hook()).pending);
  C.flush();
  C.settle();
  assert.equal(read(C).length, 1, 'alone, the refusal of C is reported');
  const D = pw(t, { home: C.home, slot: 1, shiftMs: 3_600_000 });
  assert.ok((await D.hook()).pending); // waiting (never flushed)
  D.t = Math.max(C.t, D.t);
  const notes = read(D);
  assert.equal(notes.length, 1);
  assert.match(notes[0], new RegExp(D.askId));
  assert.doesNotMatch(notes[0], new RegExp(C.askId));
});

test('clickNotes: partial selection: when the newest ask shows #12 and #13, an older ask\'s note for #12 is not printed and #13 says nothing', async (t) => {
  const A = pw(t, { pr: 12 });
  assert.ok((await A.hook()).pending); // waiting for #12
  const read = (pr) => clickNotes({ home: A.home, repo: REPO, prs: [pr], kinds: ['merge', 'merge-many'], now: () => A.t + 3_600_000 + 1000 });
  assert.equal(read(12).length, 1, 'alone, A is waiting');
  const many = mergeManyAsk({ repo: REPO, entries: [12, 13].map((pr) => ({ pr, lines: [`#${pr} head ${HEAD.slice(0, 12)} · items ${ITEMS} · repo ${REPO}`] })), ready: '🔀 Ready to merge #12, #13 — say "merge"' });
  const issued = issueAsk({ ...many, hookLayersSha256: null, home: A.home, now: () => A.t + 3_600_000 });
  assert.ok(issued.askId, JSON.stringify(issued));
  assert.deepEqual(read(12), [], 'B is the ask the owner last saw for #12: no older note, and B has no click of its own');
  assert.deepEqual(read(13), []);
});

test('clickNotes: a recorded round click whose round is already used says so; a recorded merge click says nothing; bad input never throws', async (t) => {
  const w = await roundClick(t);
  w.settle();
  assert.equal(w.records().filter((r) => r.via === 'ask').length, 1);
  const read = () => clickNotes({ home: w.home, repo: REPO, prs: [58], kinds: ['round'], now: w.now });
  assert.deepEqual(read(), [], 'recorded and still open: nothing to say');
  const claimed = claimGrantMarkers(openGrants(w.home, w.now), CBODY, { home: w.home, now: w.now, ticket: true });
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  const used = read();
  assert.equal(used.length, 1);
  assert.match(used[0], /recorded, but round 4 of #58 is already used/);
  const m = pw(t);
  assert.ok((await m.hook()).pending);
  m.flush();
  m.settle();
  assert.deepEqual(clickNotes({ home: m.home, repo: REPO, prs: [58], kinds: ['merge'], now: m.now }), []);
  for (const bad of [undefined, {}, { home: m.home }, { home: '/nonexistent-home', repo: REPO, prs: [58] }, { home: m.home, repo: 'not a repo', prs: ['x'] }]) assert.deepEqual(clickNotes(bad), []);
});

// The refusals that carry the notes (wiring pin; the notes themselves are tested above): merge (--owner-go), the owner-ruling refusal and the round-cap refusal of review-round.
test('clickNotes is appended by the merge, owner-ruling and round-cap refusals, each with its own kinds', () => {
  const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
  assert.match(src('../pipeline/commands/merge.mjs'), /clickNotes\(\{ repo, prs: \[pr\], kinds: \['merge', 'merge-many'\] \}\)/);
  assert.match(src('../pipeline/commands/triage.mjs'), /clickNotes\(\{ repo, prs: \[pr\], kinds: \['ruling'\] \}\)/);
  assert.match(src('../pipeline/commands/triage.mjs'), /\$\{again\}\$\{clickNotesText\(slug, prNum\)\}/);
  assert.match(src('../pipeline/lib/review-round.mjs'), /clickNotes\(\{ repo: c\.ghRepo\.slug, prs: \[c\.pr\], kinds: \['round'\] \}\)/);
  assert.match(src('../pipeline/lib/review-round.mjs'), /unconfirmedGrant\(c, st\) \+ pendingClickNotes\(c\)/);
});

test('clickNotes: at most 3 notes; a garbled pointer of an ask of this PR is reported, never thrown', async (t) => {
  const w = pw(t, { kind: 'round', answer: 'Yes, one more round' });
  assert.ok((await w.hook()).pending);
  for (let i = 0; i < 4; i++) {
    const id = `toolu_more_${i}`;
    w.extra(id);
    w.t += 1000;
    assert.ok((await w.hook({}, { tool_use_id: id })).pending);
  }
  const read = () => clickNotes({ home: w.home, repo: REPO, prs: [58], kinds: ['round'], now: () => w.t + 1000 });
  assert.equal(read().length, 3);
  writeFileSync(w.pendingFile('f'.repeat(16)), '{not json');
  const withBad = read();
  assert.equal(withBad.length, 3);
  assert.ok(withBad.some((n) => /could not be read/.test(n)), 'the garbled pointer is one of them');
});
