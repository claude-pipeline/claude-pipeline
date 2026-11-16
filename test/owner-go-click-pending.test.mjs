// #472 (click-to-approve, part A): a click whose tool_result entry Claude Code 2.1.323 writes only AFTER the PostToolUse hooks return is kept as a PENDING pointer at PostToolUse and verified from
// the transcript later, when a consumer reads the owner-go records (settlePendingClicks). Plan: claude-notes/plans/2026-11-16-click-pending-472.md (Rev 4). Temp homes only: accountHome() reads the
// OS account database, so HOME= isolates nothing. Every reader call passes `settle` explicitly, so none of these tests depends on the PIPELINE_CLICK_SETTLE switch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MAX_AGE_MS, approvalGap, ownerGoDir, settleEnabled } from '../pipeline/hooks/lib/owner-go.mjs';
import { CLICK_BUILDS, MIN_ANSWER_MS, asksDir, issueAsk, mergeAsk, recordClick, roundAsk, rulingAsk } from '../pipeline/hooks/lib/owner-go-click.mjs';
import { mergeRequest, roundRequest, rulingRequest } from './helpers/owner-go.mjs';

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
  merge: () => mergeAsk({ repo: REPO, pr: 58, closing: mergeRequest(58, HEAD, ITEMS, REPO) }),
  round: () => roundAsk({ repo: REPO, pr: 58, line: roundRequest(58, 4, GHEAD, REPO) }),
  ruling: () => rulingAsk({ repo: REPO, pr: 58, ids: ['R1-B1', 'R2-S3'], line: rulingRequest(58, ['R1-B1', 'R2-S3'], REPO, 'c0ffee000000') }),
};

// A pending world: a temp home, an issued ask and a transcript that holds the prompt and the tool_use ONLY (the 2.1.323 write order: Claude Code writes the answer's tool_result entry after the
// PostToolUse hooks return). `await w.hook()` runs the recorder to completion; `w.flush()` then appends the result, the way Claude Code does once the hooks are done. `w.t` is the clock.
function pw(t, { kind = 'merge', answer = null, build = BUILD, fixture = 'genuine-click', hookLayersSha256 = null, issueBeforeUseMs = 10000 } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'owner-go-click-pending-'));
  const parts = PARTS[kind]();
  const [prompt, use, result] = loadFixture(fixture, build);
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
  const file = join(cfg, 'projects', '-repo', 't.jsonl');
  const text = (es) => `${es.map((e) => JSON.stringify(e)).join('\n')}\n`;
  writeFileSync(file, text([prompt, use]));
  const answeredAt = Date.parse(result.timestamp);
  const w = {
    home, file, issued, askId: issued.askId, dialog, parts, prompt, use, result, session: use.sessionId, toolUseId: block.id, answeredAt, issuedAt, text, t: answeredAt + 1000,
    now: () => w.t,
    input: { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', session_id: use.sessionId, transcript_path: file, cwd: '/work/app', tool_use_id: block.id, tool_input: { questions: [dialog] }, tool_response: {} },
  };
  w.clickId = clickIdOf(w.session, w.toolUseId, w.askId);
  w.slept = 0;
  w.hook = (over = {}, input = {}) => recordClick({ ...w.input, ...input }, { home, now: w.now, sleep: async (ms) => { w.slept += ms; }, hookCheck: OK, ...over });
  w.flush = () => appendFileSync(file, text([result]));
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

test('capture refuses a tool_input with keys beyond questions/metadata (answers, annotations, anything else): no pending; metadata alone is fine', async (t) => {
  for (const extra of [{ answers: { x: 'Merge' } }, { annotations: {} }, { anything: 1 }]) {
    const w = pw(t);
    assert.deepEqual(await w.hook({}, { tool_input: { questions: [w.dialog], ...extra } }), { refused: 'tool-use-shape' }, JSON.stringify(extra));
    assert.deepEqual(w.pendings(), []);
  }
  const two = pw(t);
  assert.deepEqual(await two.hook({}, { tool_input: { questions: [two.dialog, two.dialog] } }), { refused: 'tool-use-shape' }, 'one question only');
  const ok = pw(t);
  assert.deepEqual(await ok.hook({}, { tool_input: { questions: [ok.dialog], metadata: { source: 'x' } } }), { pending: ok.expectedPending });
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
