// #472 (click-to-approve, part A): a click whose tool_result entry Claude Code 2.1.323 writes only AFTER the PostToolUse hooks return is kept as a PENDING pointer at PostToolUse and verified from
// the transcript later, when a consumer reads the owner-go records (settlePendingClicks). Plan: claude-notes/plans/2026-11-16-click-pending-472.md (Rev 4). Temp homes only: accountHome() reads the
// OS account database, so HOME= isolates nothing. Every reader call passes `settle` explicitly, so none of these tests depends on the PIPELINE_CLICK_SETTLE switch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { MAX_AGE_MS, accountHome, appendRecord, approvalGap, ownerGoDir, readRecords, settleEnabled } from '../pipeline/hooks/lib/owner-go.mjs';
import { CAPTURE_SKEW_MS, CLICK_BUILDS, MIN_ANSWER_MS, SETTLE_SCAN_BUDGET, WAIT_GRACE_MS, asksDir, clickProvenance, issueAsk, mergeAsk, readAsk, recordClick, roundAsk, rulingAsk, settlePendingClicks } from '../pipeline/hooks/lib/owner-go-click.mjs';
import { OWNER_GO_TIMEOUT_S } from '../pipeline/lib/installer.mjs';
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
  merge: (pr = 58) => mergeAsk({ repo: REPO, pr, closing: mergeRequest(pr, HEAD, ITEMS, REPO) }),
  round: () => roundAsk({ repo: REPO, pr: 58, line: roundRequest(58, 4, GHEAD, REPO) }),
  ruling: () => rulingAsk({ repo: REPO, pr: 58, ids: ['R1-B1', 'R2-S3'], line: rulingRequest(58, ['R1-B1', 'R2-S3'], REPO, 'c0ffee000000') }),
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
    home, file, issued, askId: issued.askId, dialog, parts, prompt, use, result, session: use.sessionId, toolUseId: block.id, answeredAt, issuedAt, text, t: answeredAt + 1000,
    now: () => w.t,
    input: { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', session_id: use.sessionId, transcript_path: file, cwd: '/work/app', tool_use_id: block.id, tool_input: { questions: [dialog] }, tool_response: {} },
  };
  w.clickId = clickIdOf(w.session, w.toolUseId, w.askId);
  w.slept = 0;
  w.hook = (over = {}, input = {}) => recordClick({ ...w.input, ...input }, { home, now: w.now, sleep: async (ms) => { w.slept += ms; }, hookCheck: OK, ...over });
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
  const norm = (rec, x) => JSON.parse(JSON.stringify(rec).replaceAll(x.askId, 'ASK').replaceAll(x.clickId, 'CLICK').replaceAll(x.file, 'FILE'));
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
