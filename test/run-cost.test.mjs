// Cost attribution (#57 item 1): the pure ledger in lib/run-cost.mjs, its place in the run record, `P cost` and the
// cost / guard-block lines of `P summary`. The CLI tests run the real CLI against the scripted gh fake (gate-env).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cli, scenario, ghEntries, PR } from './helpers/gate-env.mjs';
import { assertExit } from './helpers/assert-exit.mjs';
import { MARKERS } from '../pipeline/lib/render.mjs';
import {
  PHASES, PRICE_TABLE_DATE, ROLES, addCostEntry, deductBookedTranscript, costShapeProblem, listPriceUsd, priceMessage, modelFamily, addRetries, addSessions, costLines, costReport, emptyCost, readGuardLog, setGuardBlocks, usageFromTranscript,
} from '../pipeline/lib/run-cost.mjs';
import {
  STEPS, applyCheckpoint, decodeRecord, emptyRecord, encodeRecord, recordForOutcome, renderStatusBlock,
} from '../pipeline/lib/run-record.mjs';
import { writeSummaryComment } from '../pipeline/lib/summary-comment.mjs';
import { transcriptUsage } from '../pipeline/commands/cost.mjs';
import { UsageError } from '../pipeline/lib/cli.mjs';

const NOW = Date.parse('2026-10-14T10:00:00Z');
const rec = () => emptyRecord({ repo: 'acme/widgets', pr: PR, branch: 'agent/feature', baseRef: 'main' });
const entry = (o = {}) => ({ phase: 'build', role: 'implementer', input: 100, output: 50, cacheRead: 10, cacheWrite: 5, usd: 0.25, ...o });

// ---- the pure ledger -------------------------------------------------------------------------------------------------

test('PHASES is the record steps plus other (the lib cannot import STEPS: run-record imports it)', () => {
  assert.deepEqual([...PHASES], [...STEPS, 'other']);
});

test('addCostEntry: several entries are summed in the total, per phase and per role', () => {
  let c = addCostEntry(null, entry());
  c = addCostEntry(c, entry({ phase: 'review', role: 'judge', input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, usd: 1.5 }));
  c = addCostEntry(c, entry({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1, usd: 0.1 }));
  assert.deepEqual(c.total, { input: 1101, output: 251, cacheRead: 11, cacheWrite: 6, usd: 1.85, calls: 3 });
  assert.deepEqual(c.byPhase.build, { input: 101, output: 51, cacheRead: 11, cacheWrite: 6, usd: 0.35, calls: 2 });
  assert.equal(c.byPhase.review.usd, 1.5);
  assert.equal(c.byRole.implementer.calls, 2);
  assert.equal(c.byRole.judge.input, 1000);
});

test('addCostEntry: an unknown role or phase is booked as other, and the input is not mutated', () => {
  const before = emptyCost();
  const c = addCostEntry(before, entry({ role: 'wizard', phase: 'lunch' }));
  assert.ok(c.byRole.other && !c.byRole.wizard);
  assert.ok(c.byPhase.other && !c.byPhase.lunch);
  assert.ok(ROLES.includes('other') && ROLES.includes('controller'));
  assert.deepEqual(before, emptyCost());
});

test('addCostEntry: a negative or non-numeric amount is refused', () => {
  assert.throws(() => addCostEntry(null, entry({ input: -1 })), /input tokens/);
  assert.throws(() => addCostEntry(null, entry({ usd: 'lots' })), /usd/);
  assert.throws(() => addCostEntry(null, entry({ output: 1.5 })), /whole number/);
});

test('retries, sessions and guard blocks: counted, de-duplicated, and null stays null', () => {
  let c = addRetries(null);
  c = addRetries(c, 2);
  assert.equal(c.retries, 3);
  c = addSessions(addSessions(c, ['s1', 's2']), ['s2']);
  assert.deepEqual(c.sessions, ['s1', 's2']);
  assert.throws(() => addSessions(c, ['has space']), /plain id/);
  assert.equal(emptyCost().guardBlocks, null);
  assert.equal(setGuardBlocks(c, 4).guardBlocks, 4);
});

// ---- the run record ---------------------------------------------------------------------------------------------------

test('a record from before cost attribution (no cost section) still decodes, renders and checkpoints', () => {
  const old = rec();
  assert.equal(old.cost, undefined);
  const decoded = decodeRecord(`${MARKERS.summary}\n\n${encodeRecord(old)}`);
  assert.equal(decoded.status, 'ok');
  assert.ok(!renderStatusBlock(old).includes('Cost'));
  assert.equal(applyCheckpoint(old, { step: 'verify' }, { host: 'h', now: NOW }).cost, undefined);
});

test('applyCheckpoint: cost patches add up across checkpoints and survive the comment round trip', () => {
  let r = applyCheckpoint(rec(), { cost: { entry: entry(), sessions: ['sess-1'] } }, { host: 'h', now: NOW });
  r = applyCheckpoint(r, { cost: { entry: entry({ role: 'verifier', phase: 'verify', usd: 0.05 }), retries: 1 } }, { host: 'h', now: NOW });
  const back = decodeRecord(`${MARKERS.summary}\n\n${encodeRecord(r)}`);
  assert.equal(back.status, 'ok');
  assert.equal(back.record.cost.total.usd, 0.3);
  assert.equal(back.record.cost.retries, 1);
  assert.deepEqual(back.record.cost.sessions, ['sess-1']);
  assert.throws(() => applyCheckpoint(rec(), { cost: 'free' }, { host: 'h', now: NOW }), /cost must be an object/);
});

test('a malformed cost section makes the record invalid instead of throwing in a reader', () => {
  const bad = { ...rec(), cost: 'free' };
  assert.equal(decodeRecord(`${MARKERS.summary}\n\n${encodeRecord(bad)}`).status, 'invalid');
});

test('status block: shows totals, retries, guard blocks and the per-phase / per-role breakdown', () => {
  let r = applyCheckpoint(rec(), { cost: { entry: entry({ usd: 1.234 }), retries: 2, guardBlocks: 3 } }, { host: 'h', now: NOW });
  r = applyCheckpoint(r, { cost: { entry: entry({ role: 'judge', phase: 'review', input: 900, usd: 2 }) } }, { host: 'h', now: NOW });
  const block = renderStatusBlock(r);
  assert.match(block, /\*\*Cost:\*\* \$3\.23 · in 1,000 · out 100 · cache read 20 · cache write 10 · 2 calls/);
  assert.match(block, /\*\*Retries:\*\* 2 · \*\*Guard blocks:\*\* 3/);
  assert.match(block, /\*\*By phase:\*\* build \$1\.23 \(150 tok\) · review \$2\.00 \(950 tok\)/);
  assert.match(block, /\*\*By role:\*\* implementer \$1\.23 \(150 tok\) · judge \$2\.00 \(950 tok\)/);
});

// Issue #501: a plan review's cost folded into `other` (no phase fit it) and never showed ahead of build, so risky PRs looked cheaper than they were.
test('plan phase: a plan-review / plan-codex entry is booked under plan (not other), shown ahead of build and counted in the total', () => {
  let r = applyCheckpoint(rec(), { cost: { entry: entry({ usd: 1 }) } }, { host: 'h', now: NOW });
  r = applyCheckpoint(r, { cost: { entry: entry({ phase: 'plan', role: 'plan-review', input: 400, output: 100, usd: 3 }) } }, { host: 'h', now: NOW });
  r = applyCheckpoint(r, { cost: { entry: entry({ phase: 'plan', role: 'plan-codex', input: 50, output: 5, cacheRead: 0, cacheWrite: 0, usd: 0 }) } }, { host: 'h', now: NOW });
  assert.equal(r.cost.byPhase.other, undefined);
  assert.equal(r.cost.byRole.other, undefined);
  assert.equal(r.cost.byPhase.plan.calls, 2);
  assert.equal(r.cost.byRole['plan-review'].usd, 3);
  assert.equal(r.cost.total.usd, 4);
  const block = renderStatusBlock(r);
  assert.match(block, /\*\*Cost:\*\* \$4\.00 .* 3 calls/);
  assert.match(block, /\*\*By phase:\*\* plan \$3\.00 \(555 tok\) · build \$1\.00 \(150 tok\)/);
  assert.match(block, /\*\*By role:\*\* implementer \$1\.00 \(150 tok\) · plan-review \$3\.00 \(500 tok\) · plan-codex \$0\.00 \(55 tok\)/);
});

test('costLines: an unknown guard count shows a dash; a cost section with nothing in it shows nothing', () => {
  assert.deepEqual(costLines(emptyCost()), []);
  assert.match(costLines(addRetries(null)).join('\n'), /Guard blocks:\*\* —/);
  assert.deepEqual(costLines(undefined), []);
});

test('recordForOutcome: sessions join the recorded ones; guardBlocks replaces the count; absent keeps both', () => {
  const start = applyCheckpoint(rec(), { cost: { sessions: ['a'], guardBlocks: 1 } }, { host: 'h', now: NOW });
  const same = recordForOutcome(start, { repo: 'acme/widgets', pr: PR, branch: 'agent/feature', baseRef: 'main', outcome: 'merged', host: 'h', now: NOW });
  assert.deepEqual([same.record.cost.sessions, same.record.cost.guardBlocks], [['a'], 1]);
  const more = recordForOutcome(start, { repo: 'acme/widgets', pr: PR, branch: 'agent/feature', baseRef: 'main', outcome: 'merged', host: 'h', now: NOW, sessions: ['b'], guardBlocks: 5 });
  assert.deepEqual([more.record.cost.sessions, more.record.cost.guardBlocks], [['a', 'b'], 5]);
});

// ---- guard log + transcripts ---------------------------------------------------------------------------------------

const tmp = () => mkdtempSync(join(tmpdir(), 'run-cost-'));
const logLine = (session, extra = {}) => JSON.stringify({ ts: '2026-10-14T01:00:00Z', session, hook: 'guard-git', reason_code: 'x', cmd_hash: 'abc', ...extra });

test('readGuardLog: absent file counts nothing and says so', () => {
  assert.deepEqual(readGuardLog(join(tmp(), 'nope.jsonl'), ['s1']), { present: false, blocks: 0, bySession: {}, skipped: 0 });
});

test('readGuardLog: counts only the named sessions, per session', () => {
  const file = join(tmp(), 'guard-log.jsonl');
  writeFileSync(file, [logLine('s1'), logLine('s2'), logLine('s1'), logLine('other')].join('\n') + '\n');
  const r = readGuardLog(file, ['s1', 's2']);
  assert.deepEqual([r.present, r.blocks, r.bySession, r.skipped], [true, 3, { s1: 2, s2: 1 }, 0]);
  assert.equal(readGuardLog(file, []).blocks, 0);
});

test('readGuardLog: malformed lines are skipped and counted, never trusted or thrown', () => {
  const file = join(tmp(), 'guard-log.jsonl');
  writeFileSync(file, [logLine('s1'), '{not json', '', JSON.stringify({ session: 42 }), '[]', 'null', logLine('s1')].join('\n'));
  const r = readGuardLog(file, ['s1']);
  assert.deepEqual([r.blocks, r.skipped], [2, 4]);
});

// Failure caught: `P cost --from-transcript` run right after an agent returns exited 2 (cannot read ... ENOENT) because the transcript was not on disk yet; one more look a moment later finds it.
test('transcriptUsage: a transcript that is not on disk yet is read again a few times before the read fails, and the failure names the likely cause', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-transcript-'));
  const file = join(dir, 'agent.jsonl');
  const line = JSON.stringify({ message: { id: 'm1', model: 'claude-sonnet-5-5', usage: { input_tokens: 7, output_tokens: 3 } } });
  const sleeps = [];
  const late = transcriptUsage(file, dir, undefined, { sleep: (ms) => { sleeps.push(ms); if (sleeps.length === 2) writeFileSync(file, `${line}\n{"message":{"id":"m2","usa`); }, tries: 5, delayMs: 500 });
  assert.equal(sleeps.length, 2, 'two waits, then it was there');
  assert.deepEqual([late.input, late.output, late.messages], [7, 3, 1], 'a half-written last line is skipped, the rest counts');

  const never = [];
  assert.throws(
    () => transcriptUsage(join(dir, 'missing.jsonl'), dir, undefined, { sleep: (ms) => never.push(ms), tries: 4, delayMs: 500 }),
    (err) => err instanceof UsageError && /cannot read .*missing\.jsonl \(ENOENT\)/.test(err.message) && /not be on disk yet/.test(err.message) && /4 tries/.test(err.message),
  );
  assert.equal(never.length, 3, 'tries - 1 waits, never after the last look');
});

test('usageFromTranscript: sums message.usage, counting a streamed message id once', () => {
  const line = (id, u) => JSON.stringify({ type: 'assistant', message: { id, usage: u } });
  const text = [
    line('m1', { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 }),
    line('m1', { input_tokens: 3, output_tokens: 9, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 }),
    line('m2', { input_tokens: 1, output_tokens: 2 }),
    'garbage', JSON.stringify({ type: 'user', message: { content: 'hi' } }),
  ].join('\n');
  assert.deepEqual(usageFromTranscript(text), {
    input: 4, output: 11, cacheRead: 100, cacheWrite: 10, usd: 0, messages: 2, unpricedMessages: 2,
    byPrice: { 'unknown|std|std': { input: 4, output: 11, cacheRead: 100, cacheWrite5m: 10, cacheWrite1h: 0, messages: 2 } },
  });
});

test('list prices: each transcript message at its own model, unknown models add tokens and no USD', () => {
  const line = (id, model, u) => JSON.stringify({ type: 'assistant', message: { id, model, usage: u } });
  const text = [
    line('a', 'claude-sonnet-5-5', { input_tokens: 1e6 }), // $2
    line('b', 'claude-opus-5-5', { output_tokens: 1e6, cache_read_input_tokens: 1e6 }), // $20 + $0.2
    line('c', 'claude-haiku-5-5', { cache_creation_input_tokens: 1e6 }), // $0.625 (a prompt over 100K: the higher Haiku 5.5 row)
    line('d', 'some-other-model', { input_tokens: 1e6 }),
  ].join('\n');
  const u = usageFromTranscript(text);
  assert.equal(u.usd, 22.825);
  assert.equal(u.unpricedMessages, 1);
  assert.equal(u.input, 2e6);
  assert.equal(listPriceUsd('fable', { input: 1e6, output: 1e6 }), 48, 'a bare family name is its newest row (Fable 5.2: 8 + 40)');
  assert.equal(listPriceUsd('gpt-5', { input: 1 }), null);
  assert.equal(modelFamily('Claude-Sonnet-5-5[1m]'), 'sonnet');
});

// ---- the CLI -------------------------------------------------------------------------------------------------------

const PATCH_77 = { match: '-X PATCH repos/acme/widgets/issues/comments/77', stdoutJson: { id: 77, html_url: 'https://github.com/acme/widgets/pull/12#issuecomment-77' } };
function existing(record, sections = '') {
  let body = '';
  writeSummaryComment({ viewer: () => 'me', listComments: () => [], upsertComment: (n, m, b) => { body = b; return { id: 77, url: 'u', action: 'created' }; } }, PR, { record, sections });
  return { id: 77, user: { login: 'me' }, body, html_url: 'https://github.com/acme/widgets/pull/12#issuecomment-77' };
}
const withComment = (s, comment, extra = []) => s.fake.setScript(ghEntries({ prHead: s.head, comments: comment ? [comment] : [], extra: [PATCH_77, { match: '^pr view 12 --json title', stdoutJson: { title: 'T' } }, ...extra] }));
const written = (s) => {
  const w = s.fake.calls().filter((c) => c.argv[0] === 'api' && c.argv.includes('-X') && /issues\/(?:\d+\/comments|comments\/\d+)$/.test(c.argv.at(-3)));
  return decodeRecord(JSON.parse(w.at(-1).stdin).body).record;
};
const costCli = (s, args, env = {}) => cli(['cost', '--pr', String(PR), ...args], { dir: s.repo.dir, fake: s.fake, env: { ...s.env, ...env } });

test('P cost: books an entry into a fresh record, then adds to it', () => {
  const s = scenario();
  const r = costCli(s, ['--phase', 'build', '--role', 'implementer', '--input', '100', '--output', '50', '--cache-read', '7', '--cache-write', '3', '--usd', '0.4', '--session', 'sess-1']);
  assertExit(r, 0);
  assert.equal(r.json.recorded, true);
  assert.equal(r.json.cost.total.usd, 0.4);
  assert.deepEqual(r.json.cost.sessions, ['sess-1']);
  const first = written(s);
  withComment(s, existing(first));
  const r2 = costCli(s, ['--phase', 'review', '--role', 'wizard', '--input', '1', '--usd', '0.1', '--retry']);
  assertExit(r2, 0);
  assert.deepEqual([r2.json.cost.total.input, r2.json.cost.total.usd, r2.json.cost.retries], [101, 0.5, 1]);
  assert.ok(r2.json.cost.byRole.other, 'unknown role -> other');
  assert.equal(written(s).cost.byPhase.review.input, 1);
});

test('P cost: refuses nothing-to-record and bad amounts with exit 2 and writes no comment', () => {
  const s = scenario();
  const before = s.fake.calls().length;
  assertExit(costCli(s, ['--phase', 'build', '--role', 'judge']), 2);
  assertExit(costCli(s, ['--phase', 'build', '--role', 'judge', '--input', '-5']), 2);
  assertExit(costCli(s, ['--phase', 'build', '--role', 'judge', '--usd', 'abc']), 2);
  assert.equal(s.fake.calls().length, before);
});

test('P cost --from-transcript: the transcript usage is booked, explicit amounts add on top', () => {
  const s = scenario();
  s.repo.write('.review/t.jsonl', `${JSON.stringify({ message: { id: 'm', usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 } } })}\n`);
  const r = costCli(s, ['--phase', 'build', '--role', 'implementer', '--from-transcript', '.review/t.jsonl', '--output', '5']);
  assertExit(r, 0);
  assert.deepEqual([r.json.cost.total.input, r.json.cost.total.output, r.json.cost.total.cacheRead, r.json.cost.total.cacheWrite], [10, 25, 30, 40]);
  assertExit(costCli(s, ['--phase', 'build', '--role', 'implementer', '--from-transcript', '.review/missing.jsonl']), 2);
});

// A transcript read while still empty (size 0, no usage lines, or only a half-written line) booked zeros with ok:true and no warning, so nobody noticed the call went unbooked.
test('P cost --from-transcript: a transcript with no messages with usage warns (with or without --usd); a normal one does not', () => {
  const warns = (content, extra = []) => {
    const s = scenario();
    s.repo.write('.review/t.jsonl', content);
    const r = costCli(s, ['--phase', 'build', '--role', 'implementer', '--from-transcript', '.review/t.jsonl', ...extra]);
    assertExit(r, 0);
    assert.equal(r.json.ok, true);
    return r.json.warnings.filter((w) => /no messages with usage found/.test(w));
  };
  assert.equal(warns('').length, 1, 'empty file');
  assert.equal(warns('{"message":{"id":"m","usage":{"input_tok').length, 1, 'only a half-written line');
  assert.equal(warns(`${JSON.stringify({ type: 'user', message: { content: 'hi' } })}\n`).length, 1, 'lines without usage');
  assert.equal(warns('', ['--usd', '1']).length, 1, 'still warns with --usd');
  assert.deepEqual(warns(`${JSON.stringify({ message: { id: 'm', usage: { input_tokens: 1, output_tokens: 1 } } })}\n`), [], 'a normal transcript');
});

// Issue #501: a plan review books under plan / plan-review|plan-codex instead of falling into `other`.
test('P cost --phase plan --role plan-review --from-transcript: books and prices under plan / plan-review, not other', () => {
  const s = scenario();
  s.repo.write('.review/plan.jsonl', `${JSON.stringify({ message: { id: 'm', model: 'claude-sonnet-5-5', usage: { input_tokens: 1000000, output_tokens: 1000000 } } })}\n`);
  const r = costCli(s, ['--phase', 'plan', '--role', 'plan-review', '--from-transcript', '.review/plan.jsonl']);
  assertExit(r, 0);
  assert.equal(r.json.cost.byPhase.plan.usd, 12);
  assert.equal(r.json.cost.byRole['plan-review'].calls, 1);
  assert.equal(r.json.cost.byPhase.other, undefined);
  assert.equal(r.json.cost.byRole.other, undefined);
  const hand = costCli(scenario(), ['--phase', 'plan', '--role', 'plan-codex', '--input', '5000']);
  assertExit(hand, 0);
  assert.deepEqual([hand.json.cost.byRole['plan-codex'].input, hand.json.cost.byRole['plan-codex'].usd], [5000, 0]);
});

// Issue #820: the empty-transcript booking still wrote a zero entry (calls +1) and a retry, so the re-run the warning invites showed one agent call as 2 calls and 2 retries.
test('P cost --from-transcript: an empty transcript with no hand amounts books nothing (no call, no retry, no write); the re-run then books exactly 1 call and 1 retry', () => {
  const s = scenario();
  s.repo.write('.review/t.jsonl', '');
  const args = ['--phase', 'review', '--role', 'judge', '--round', '1', '--retry', '--from-transcript', '.review/t.jsonl'];
  const before = s.fake.calls().length;
  const first = costCli(s, args);
  assertExit(first, 0);
  assert.equal(first.json.ok, true);
  assert.equal(first.json.recorded, false);
  assert.equal(first.json.skipped, 'empty-transcript');
  assert.match(first.json.warnings.join('\n'), /nothing was booked; run this same command again in a few seconds/);
  assert.equal(s.fake.calls().length, before, 'no GitHub read or write when there is nothing to book');
  s.repo.write('.review/t.jsonl', `${JSON.stringify({ message: { id: 'm', usage: { input_tokens: 10, output_tokens: 20 } } })}\n`);
  const second = costCli(s, args);
  assertExit(second, 0);
  assert.equal(second.json.recorded, true);
  assert.equal(second.json.skipped, undefined);
  assert.deepEqual([second.json.cost.total.calls, second.json.cost.retries, second.json.cost.byRound['1'].calls], [1, 1, 1]);
  assert.ok(written(s).cost.transcripts, 'the transcript key is booked only by the real booking');
});

test('P cost --from-transcript: an empty transcript with --session still records the session only; with a hand amount it still books it', () => {
  const s = scenario();
  s.repo.write('.review/t.jsonl', '');
  const withSession = costCli(s, ['--phase', 'review', '--role', 'judge', '--retry', '--from-transcript', '.review/t.jsonl', '--session', 'sess-9']);
  assertExit(withSession, 0);
  assert.equal(withSession.json.recorded, false);
  assert.equal(withSession.json.skipped, 'empty-transcript');
  assert.deepEqual(withSession.json.cost.sessions, ['sess-9']);
  assert.deepEqual([withSession.json.cost.total.calls, withSession.json.cost.retries], [0, 0]);
  const hand = scenario();
  hand.repo.write('.review/t.jsonl', '');
  const r = costCli(hand, ['--phase', 'build', '--role', 'implementer', '--from-transcript', '.review/t.jsonl', '--input', '10']);
  assertExit(r, 0);
  assert.equal(r.json.skipped, undefined);
  assert.deepEqual([r.json.cost.total.calls, r.json.cost.total.input], [1, 10]);
  assert.ok(r.json.warnings.some((w) => /no messages with usage found/.test(w)));
});

// A continued implementer (SendMessage) is booked after its first leg and again after its last: the second booking re-counted leg 1 (about $0.92 on EagleWatch #2366).
test('P cost --from-transcript: booking a continued agent\'s transcript again books only the new usage (total = the whole transcript once)', () => {
  const s = scenario();
  const msg = (id, n) => `${JSON.stringify({ message: { id, model: 'claude-sonnet-4-5', usage: { input_tokens: n, output_tokens: 2 * n, cache_read_input_tokens: 3 * n, cache_creation_input_tokens: 4 * n } } })}\n`;
  s.repo.write('.review/agent-a1.jsonl', msg('m1', 10));
  const first = costCli(s, ['--phase', 'build', '--role', 'implementer', '--from-transcript', '.review/agent-a1.jsonl']);
  assertExit(first, 0);
  withComment(s, existing(written(s)));
  s.repo.write('.review/agent-a1.jsonl', msg('m1', 10) + msg('m2', 5));
  const second = costCli(s, ['--phase', 'build', '--role', 'implementer', '--from-transcript', '.review/agent-a1.jsonl', '--output', '1']);
  assertExit(second, 0);
  const t = second.json.cost.total;
  assert.deepEqual([t.input, t.output, t.cacheRead, t.cacheWrite, t.calls], [15, 31, 45, 60, 2], 'the whole transcript once, plus the hand output');
  assert.equal(t.usd, (() => { const sc = scenario(); sc.repo.write('.review/agent-a1.jsonl', msg('m1', 10) + msg('m2', 5)); return costCli(sc, ['--phase', 'build', '--role', 'implementer', '--from-transcript', '.review/agent-a1.jsonl']).json.cost.total.usd; })(), 'USD too');
  // a third booking with nothing new adds no tokens
  withComment(s, existing(written(s)));
  const third = costCli(s, ['--phase', 'build', '--role', 'implementer', '--from-transcript', '.review/agent-a1.jsonl']);
  assert.deepEqual([third.json.cost.total.input, third.json.cost.total.output], [15, 31]);
});

// R4-B1: two overlapping bookings of one growing transcript: the one that read the smaller snapshot finished last and lowered the ledger, so the next booking of the larger transcript re-booked the difference.
test('deductBookedTranscript: a stale smaller snapshot does not lower the ledger, so the larger one booked again adds nothing', () => {
  const snap = (n) => ({ input: n, output: 2 * n, cacheRead: 3 * n, cacheWrite: 4 * n, usd: n / 100, byPrice: { p1: { input: n, output: 2 * n, cacheRead: 3 * n, cacheWrite5m: 4 * n, cacheWrite1h: 0, messages: n } } });
  const book = (cost, n) => deductBookedTranscript(cost, { ...snap(n) }, { key: 'agent-a1.jsonl', usage: snap(n) });
  const big = book(emptyCost(), 200);
  const stale = book(big.cost, 100);
  assert.deepEqual([stale.entry.input, stale.entry.usd], [0, 0], 'the stale snapshot adds nothing');
  const again = book(stale.cost, 200);
  assert.deepEqual([again.entry.input, again.entry.output, again.entry.cacheRead, again.entry.cacheWrite, again.entry.usd], [0, 0, 0, 0, 0], 'the larger snapshot again adds nothing');
  assert.equal(again.entry.byPrice.p1, undefined, 'price buckets add nothing either');
});

// R1-B1 / R1-F2: the ledger key was the bare file name, so two different transcripts both called transcript.jsonl shared one entry (the second under-booked), and a name with a space or bracket made the booking fail.
test('P cost --from-transcript: same-named transcripts from different folders both book; an odd file name still books', () => {
  const s = scenario();
  const one = (n) => `${JSON.stringify({ message: { id: `m${n}`, model: 'claude-sonnet-4-5', usage: { input_tokens: n, output_tokens: 1 } } })}\n`;
  s.repo.write('.review/a/transcript.jsonl', one(100));
  s.repo.write('.review/b/transcript.jsonl', one(50));
  const first = costCli(s, ['--phase', 'build', '--role', 'implementer', '--from-transcript', '.review/a/transcript.jsonl']);
  assertExit(first, 0);
  withComment(s, existing(written(s)));
  const second = costCli(s, ['--phase', 'build', '--role', 'implementer', '--from-transcript', '.review/b/transcript.jsonl']);
  assertExit(second, 0);
  assert.equal(second.json.cost.total.input, 150, 'both transcripts booked in full');
  withComment(s, existing(written(s)));
  const again = costCli(s, ['--phase', 'build', '--role', 'implementer', '--from-transcript', '.review/b/transcript.jsonl']);
  assert.equal(again.json.cost.total.input, 150, 'the same file again books nothing new');
  assert.doesNotMatch(JSON.stringify(written(s).cost.transcripts), /\.review|\/Users|\/tmp/, 'no folder path in the ledger');
  const odd = scenario();
  odd.repo.write('.review/agent copy (1) \u00e9.jsonl', one(7));
  const r = costCli(odd, ['--phase', 'build', '--role', 'implementer', '--from-transcript', '.review/agent copy (1) \u00e9.jsonl']);
  assertExit(r, 0);
  assert.equal(r.json.cost.total.input, 7);
  odd.repo.write(`.review/${'x'.repeat(200)}.jsonl`, one(3));
  assertExit(costCli(odd, ['--phase', 'build', '--role', 'implementer', '--from-transcript', `.review/${'x'.repeat(200)}.jsonl`]), 0);
});

test('P cost: USD from list prices (--model, transcript models); --usd wins; tokens with no price warn', () => {
  const s = scenario();
  const r = costCli(s, ['--phase', 'review', '--role', 'judge', '--input', '1000000', '--model', 'sonnet']);
  assertExit(r, 0);
  assert.equal(r.json.cost.total.usd, 2);
  assert.deepEqual(r.json.warnings, []);
  s.repo.write('.review/t.jsonl', `${JSON.stringify({ message: { id: 'm', model: 'claude-opus-5-5', usage: { output_tokens: 1000000 } } })}\n`);
  const t = costCli(scenario(), ['--phase', 'build', '--role', 'implementer', '--input', '10']);
  assertExit(t, 0);
  assert.equal(t.json.cost.total.usd, 0);
  assert.match(t.json.warnings.join('\n'), /without --model or --usd/);
  const s3 = scenario();
  s3.repo.write('.review/t.jsonl', `${JSON.stringify({ message: { id: 'm', model: 'claude-opus-5-5', usage: { output_tokens: 1000000 } } })}\n`);
  const w = costCli(s3, ['--phase', 'build', '--role', 'implementer', '--from-transcript', '.review/t.jsonl']);
  assertExit(w, 0);
  assert.equal(w.json.cost.total.usd, 20);
  const x = costCli(scenario(), ['--phase', 'build', '--role', 'judge', '--input', '1000000', '--model', 'sonnet', '--usd', '0.5']);
  assert.equal(x.json.cost.total.usd, 0.5);
  assertExit(costCli(scenario(), ['--phase', 'build', '--role', 'judge', '--input', '1', '--model', 'gpt']), 2);
});

const summary = (s, args, env = {}) => cli(['summary', '--pr', String(PR), '--outcome', 'merged', ...args], { dir: s.repo.dir, fake: s.fake, env: { ...s.env, ...env } });
const withCost = (patch) => applyCheckpoint(rec(), { cost: patch }, { host: 'h', now: NOW });

test('P summary: an old record with no cost section works; the output cost is null and no cost line is written', () => {
  const s = scenario();
  withComment(s, existing(rec()));
  const r = summary(s, []);
  assertExit(r, 0);
  assert.equal(r.json.cost, null);
  assert.ok(!JSON.stringify(s.fake.calls()).includes('Cost:'));
  assert.equal(written(s).cost, undefined);
});

test('P summary: shows the totals and the breakdown in the output and in the comment', () => {
  const s = scenario();
  const record = withCost({ entry: entry({ usd: 2 }), retries: 1 });
  withComment(s, existing(record));
  const r = summary(s, []);
  assertExit(r, 0);
  assert.equal(r.json.cost.total.usd, 2);
  assert.equal(r.json.cost.byPhase.build.calls, 1);
  assert.equal(r.json.cost.byRole.implementer.output, 50);
  const w = s.fake.calls().filter((c) => c.argv.includes('PATCH')).at(-1);
  const body = JSON.parse(w.stdin).body;
  assert.match(body, /\*\*Cost:\*\* \$2\.00/);
  assert.match(body, /\*\*By role:\*\* implementer \$2\.00/);
});

test('P summary: guard log absent -> no failure, the count stays unknown', () => {
  const s = scenario();
  withComment(s, existing(withCost({ entry: entry(), sessions: ['s1'] })));
  const r = summary(s, [], { PIPELINE_GUARD_LOG_FILE: join(tmp(), 'nope.jsonl') });
  assertExit(r, 0);
  assert.equal(r.json.cost.guardBlocks, null);
  assert.deepEqual(r.json.warnings, []);
});

test('P summary: guard log present -> counts the denies of the recorded sessions plus --session; malformed lines only warn', () => {
  const s = scenario();
  const file = join(tmp(), 'guard-log.jsonl');
  writeFileSync(file, [logLine('s1'), logLine('s1'), logLine('s2'), logLine('stranger'), 'oops{'].join('\n') + '\n');
  withComment(s, existing(withCost({ entry: entry(), sessions: ['s1'] })));
  const r = summary(s, ['--session', 's2'], { PIPELINE_GUARD_LOG_FILE: file });
  assertExit(r, 0);
  assert.equal(r.json.cost.guardBlocks, 3);
  assert.deepEqual(r.json.cost.sessions, ['s1', 's2']);
  assert.ok(r.json.warnings.some((w) => /1 unreadable line/.test(w)));
  assert.equal(written(s).cost.guardBlocks, 3);
});

test('P summary: with no session known the guard log is not read at all', () => {
  const s = scenario();
  const file = join(tmp(), 'guard-log.jsonl');
  writeFileSync(file, `${logLine('s1')}\n`);
  withComment(s, existing(withCost({ entry: entry() })));
  const r = summary(s, [], { PIPELINE_GUARD_LOG_FILE: file });
  assertExit(r, 0);
  assert.equal(r.json.cost.guardBlocks, null);
});

// Codex review (#57) finding 6: --model is the default for transcript messages that carry no model
test('usageFromTranscript: a message with no model is priced at the default model; its own model still wins', () => {
  const line = (id, model, u) => JSON.stringify({ type: 'assistant', message: { id, ...(model ? { model } : {}), usage: u } });
  const text = [line('a', undefined, { input_tokens: 1e6 }), line('b', 'claude-opus-5-5', { output_tokens: 1e6 }), line('c', 'some-other-model', { input_tokens: 1e6 })].join('\n');
  const none = usageFromTranscript(text);
  assert.deepEqual([none.usd, none.unpricedMessages], [20, 2]);
  const dflt = usageFromTranscript(text, { defaultModel: 'sonnet' });
  assert.deepEqual([dflt.usd, dflt.unpricedMessages], [22, 1], 'a: $2 at sonnet; b: $20 at its own opus; c: an unknown model of its own stays unpriced');
});

test('P cost --from-transcript --model: transcript messages without model metadata are priced at --model; --usd still overrides', () => {
  const s = scenario();
  s.repo.write('.review/t.jsonl', `${JSON.stringify({ message: { id: 'm', usage: { input_tokens: 1000000 } } })}\n${JSON.stringify({ message: { id: 'n', model: 'claude-opus-5-5', usage: { output_tokens: 1000000 } } })}\n`);
  const r = costCli(s, ['--phase', 'build', '--role', 'implementer', '--from-transcript', '.review/t.jsonl', '--model', 'sonnet']);
  assertExit(r, 0);
  assert.equal(r.json.cost.total.usd, 22);
  assert.deepEqual(r.json.warnings, []);
  const u = costCli(scenario(), ['--phase', 'build', '--role', 'implementer', '--input', '10', '--usd', '0.5', '--model', 'sonnet']);
  assert.equal(u.json.cost.total.usd, 0.5);
  const s2 = scenario();
  s2.repo.write('.review/t.jsonl', `${JSON.stringify({ message: { id: 'm', usage: { input_tokens: 1000000 } } })}\n`);
  assert.equal(costCli(s2, ['--phase', 'build', '--role', 'implementer', '--from-transcript', '.review/t.jsonl', '--usd', '0.5', '--model', 'sonnet']).json.cost.total.usd, 0.5);
  const noModel = costCli(scenario(), ['--phase', 'build', '--role', 'implementer', '--input', '10']);
  assert.match(noModel.json.warnings.join('\n'), /without --model or --usd/);
});

// Codex review (#57) finding 7: the per-session guard counts are kept, not just their total
test('guard blocks by session: stored with the total, replaced on the next count, shown in the lines and the report, null on old records', () => {
  assert.equal(emptyCost().guardBySession ?? null, null);
  const c = setGuardBlocks(addRetries(null), 3, { s1: 2, s2: 1 });
  assert.deepEqual(c.guardBySession, { s1: 2, s2: 1 });
  assert.deepEqual(setGuardBlocks(c, 4, { s1: 4 }).guardBySession, { s1: 4 }, 'the new count replaces the old');
  assert.equal(setGuardBlocks(c, 3).guardBySession.s1, 2, 'a total alone leaves the per-session counts');
  assert.throws(() => setGuardBlocks(c, 1, { 'has space': 1 }), /plain id/);
  assert.throws(() => setGuardBlocks(c, 1, { s1: -1 }), /non-negative/);
  assert.match(costLines(c).join('\n'), /\*\*Guard blocks:\*\* 3 \(s1 2 · s2 1\)/);
  assert.deepEqual(costReport(c).guardBySession, { s1: 2, s2: 1 });
  assert.equal(costReport(addRetries(null)).guardBySession, null);
  const r = applyCheckpoint(rec(), { cost: { sessions: ['s1', 's2'], guardBlocks: 3, guardBySession: { s1: 2, s2: 1 } } }, { host: 'h', now: NOW });
  assert.deepEqual(r.cost.guardBySession, { s1: 2, s2: 1 });
  const kept = recordForOutcome(r, { repo: 'acme/widgets', pr: PR, branch: 'agent/feature', baseRef: 'main', outcome: 'merged', host: 'h', now: NOW });
  assert.deepEqual(kept.record.cost.guardBySession, { s1: 2, s2: 1 });
  const next = recordForOutcome(r, { repo: 'acme/widgets', pr: PR, branch: 'agent/feature', baseRef: 'main', outcome: 'merged', host: 'h', now: NOW, guardBlocks: 1, guardBySession: { s1: 1, s2: 0 } });
  assert.deepEqual(next.record.cost.guardBySession, { s1: 1, s2: 0 });
});

test('P summary: the per-session guard denies are recorded and reported', () => {
  const s = scenario();
  const file = join(tmp(), 'guard-log.jsonl');
  writeFileSync(file, [logLine('s1'), logLine('s1'), logLine('s2'), logLine('stranger')].join('\n') + '\n');
  withComment(s, existing(withCost({ entry: entry(), sessions: ['s1', 's3'] })));
  const r = summary(s, ['--session', 's2'], { PIPELINE_GUARD_LOG_FILE: file });
  assertExit(r, 0);
  assert.deepEqual(r.json.cost.guardBySession, { s1: 2, s3: 0, s2: 1 });
  assert.deepEqual(written(s).cost.guardBySession, { s1: 2, s3: 0, s2: 1 });
  assert.match(JSON.parse(s.fake.calls().filter((c) => c.argv.includes('PATCH')).at(-1).stdin).body, /Guard blocks:\*\* 3 \(s1 2 · s2 1 · s3 0\)/);
  const absent = scenario();
  withComment(absent, existing(withCost({ entry: entry(), sessions: ['s1'] })));
  assert.equal(summary(absent, [], { PIPELINE_GUARD_LOG_FILE: join(tmp(), 'nope.jsonl') }).json.cost.guardBySession, null);
});

// ---- per-version prices (fable floor + prices, A5) -----------------------------------------------------------------

const MTOK = (id, t, o) => listPriceUsd(id, t, o);
const PRICE_ROWS = [
  ['claude-fable-5-2', [8, 40, 0.2, 10, 16]], ['claude-fable-5-1', [10, 50, 0.25, 12.5, 20]], ['claude-fable-5', [10, 50, 1, 12.5, 20]],
  ['claude-opus-5-5', [4, 20, 0.2, 5, 8]], ['claude-opus-5', [5, 25, 0.5, 6.25, 10]], ['claude-opus-4-8', [5, 25, 0.5, 6.25, 10]],
  ['claude-opus-4-7', [5, 25, 0.5, 6.25, 10]], ['claude-opus-4-6', [5, 25, 0.5, 6.25, 10]],
  ['claude-sonnet-5-5', [2, 10, 0.1, 2.5, 4]], ['claude-sonnet-5', [2, 10, 0.2, 2.5, 4]], ['claude-sonnet-4-6', [3, 15, 0.3, 3.75, 6]],
  ['claude-haiku-5-5', [0.1, 0.5, 0.01, 0.125, 0.2]], ['claude-haiku-4-5', [1, 5, 0.1, 1.25, 2]],
];
const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'];

test('price table: every row prices each of the five token kinds (1 MTok of one kind = the table figure)', () => {
  assert.equal(PRICE_TABLE_DATE, '2026-11-03');
  for (const [id, row] of PRICE_ROWS) {
    FIELDS.forEach((f, i) => {
      // (a Haiku 5.5 prompt of exactly 1 MTok of one kind is over 100K, so its std row is checked with 100K tokens instead)
      const std = id === 'claude-haiku-5-5';
      const n = std ? 1e5 : 1e6;
      const usd = MTOK(id, { [f]: n });
      assert.equal(usd, Math.round(((row[i] * n) / 1e6) * 1e6) / 1e6, `${id} ${f}`);
    });
  }
  // dated ids price as the undated row
  assert.equal(MTOK('claude-opus-4-8-20260101', { input: 1e6 }), 5);
  assert.equal(MTOK('claude-sonnet-5-5[1m]', { input: 1e6 }), 2);
});

test('price table: Haiku 5.5 above 100K prompt tokens uses the higher row; exactly 100,000 is standard', () => {
  assert.equal(MTOK('claude-haiku-5-5', { input: 100000 }), 0.01);
  assert.equal(MTOK('claude-haiku-5-5', { input: 100001 }), 0.050001);
  assert.equal(priceMessage('claude-haiku-5-5', { input: 100000 }).tier, 'std');
  assert.equal(priceMessage('claude-haiku-5-5', { input: 100001 }).tier, '>100k');
  // the prompt counts input + cache read + cache write (5 m + 1 h), not output
  assert.equal(priceMessage('claude-haiku-5-5', { input: 50000, cacheRead: 30000, cacheWrite5m: 10000, cacheWrite1h: 10000 }).tier, 'std');
  assert.equal(priceMessage('claude-haiku-5-5', { input: 50000, cacheRead: 30000, cacheWrite5m: 10000, cacheWrite1h: 10001 }).tier, '>100k');
  assert.equal(priceMessage('claude-haiku-5-5', { input: 100000, output: 1e6 }).tier, 'std');
  assert.equal(priceMessage('claude-haiku-4-5', { input: 500000 }).tier, 'std', 'only Haiku 5.5 is tiered');
});

test('price table: an unknown newer id prices as its family newest row; an unknown family is unpriced', () => {
  assert.equal(MTOK('claude-fable-5-3', { input: 1e6, output: 1e6 }), 48);
  assert.equal(MTOK('claude-opus-5-6', { input: 1e6 }), 4);
  assert.equal(MTOK('claude-sonnet-5-9', { input: 1e6 }), 2);
  assert.equal(MTOK('claude-haiku-5-6', { input: 1e6 }), 0.5, 'a newer Haiku keeps the 100K tiering of the newest row');
  assert.equal(MTOK('claude-mystery-1', { input: 1e6 }), null);
  assert.equal(MTOK('', { input: 1e6 }), null);
  assert.equal(MTOK(undefined, { input: 1e6 }), null);
});

test('usageFromTranscript: cache writes are split by cache_creation ephemeral_1h / ephemeral_5m; no split means all 5 m', () => {
  const line = (id, usage) => JSON.stringify({ type: 'assistant', message: { id, model: 'claude-fable-5-2', usage } });
  const split = usageFromTranscript(line('a', { cache_creation_input_tokens: 3e6, cache_creation: { ephemeral_5m_input_tokens: 1e6, ephemeral_1h_input_tokens: 2e6 } }));
  assert.equal(split.usd, 10 + 32);
  assert.equal(split.cacheWrite, 3e6, 'cacheWrite stays the 5 m + 1 h total');
  assert.deepEqual(split.byPrice['claude-fable-5-2|std|std'], { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 1e6, cacheWrite1h: 2e6, messages: 1 });
  const flat = usageFromTranscript(line('a', { cache_creation_input_tokens: 3e6 }));
  assert.equal(flat.usd, 30);
  assert.equal(flat.byPrice['claude-fable-5-2|std|std'].cacheWrite5m, 3e6);
  // a total larger than its two parts: the rest is 5 m
  const over = usageFromTranscript(line('a', { cache_creation_input_tokens: 4e6, cache_creation: { ephemeral_5m_input_tokens: 1e6, ephemeral_1h_input_tokens: 2e6 } }));
  assert.deepEqual([over.byPrice['claude-fable-5-2|std|std'].cacheWrite5m, over.byPrice['claude-fable-5-2|std|std'].cacheWrite1h, over.cacheWrite], [2e6, 2e6, 4e6]);
});

test('usageFromTranscript: Haiku 5.5 tier boundary is per message and lands in its own byPrice bucket', () => {
  const line = (id, usage) => JSON.stringify({ type: 'assistant', message: { id, model: 'claude-haiku-5-5', usage } });
  const u = usageFromTranscript([line('a', { input_tokens: 100000 }), line('b', { input_tokens: 100001 }), line('c', { input_tokens: 1 })].join('\n'));
  assert.deepEqual(Object.keys(u.byPrice).sort(), ['claude-haiku-5-5|>100k|std', 'claude-haiku-5-5|std|std']);
  assert.equal(u.byPrice['claude-haiku-5-5|std|std'].messages, 2);
  assert.equal(u.byPrice['claude-haiku-5-5|>100k|std'].input, 100001);
  assert.equal(u.usd, 0.060001, "0.01 + 0.050001 + 1e-7, rounded to 6 places");
});

test('fast mode: input and output re-priced for Fable 5.2 and Opus 5.5; cache tokens make a fast message unpriced', () => {
  assert.equal(MTOK('claude-fable-5-2', { input: 1e6, output: 1e6 }, { speed: 'fast' }), 96);
  assert.equal(MTOK('claude-opus-5-5', { input: 1e6, output: 1e6 }, { speed: 'fast' }), 48);
  for (const t of [{ input: 1, cacheRead: 1 }, { input: 1, cacheWrite: 1 }, { input: 1, cacheWrite1h: 1 }]) assert.equal(MTOK('claude-fable-5-2', t, { speed: 'fast' }), null);
  assert.equal(MTOK('claude-sonnet-5-5', { input: 1e6 }, { speed: 'fast' }), null, 'no fast price known for this model');
  assert.equal(MTOK('claude-fable-5-3', { input: 1e6 }, { speed: 'fast' }), 16, 'a newer Fable uses the Fable 5.2 fast row');
  const line = (id, usage) => JSON.stringify({ type: 'assistant', message: { id, model: 'claude-fable-5-2', usage } });
  const u = usageFromTranscript([
    line('a', { input_tokens: 1e6, output_tokens: 1e6, speed: 'fast' }),
    line('b', { input_tokens: 1e6, cache_read_input_tokens: 5, speed: 'fast' }),
    line('c', { input_tokens: 1e6 }),
  ].join('\n'));
  assert.equal(u.usd, 96 + 8);
  assert.equal(u.unpricedMessages, 1);
  assert.deepEqual(Object.keys(u.byPrice).sort(), ['claude-fable-5-2|std|fast', 'claude-fable-5-2|std|std']);
  assert.equal(u.byPrice['claude-fable-5-2|std|fast'].messages, 2, 'the unpriced fast message is still bucketed, so a later table can price it');
});

test('byPrice: addCostEntry sums buckets per key and counts price tables; costShapeProblem tolerates old records and rejects a bad byPrice', () => {
  const b = (n) => ({ 'claude-fable-5-2|std|std': { input: n, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, messages: 1 } });
  let c = addCostEntry(null, entry({ byPrice: b(5), priceTable: '2026-11-03' }));
  c = addCostEntry(c, entry({ byPrice: { ...b(7), 'claude-haiku-5-5|>100k|std': { input: 1, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, messages: 1 } }, priceTable: '2026-11-03' }));
  c = addCostEntry(c, entry({ byPrice: b(1), priceTable: '2027-01-01' }));
  c = addCostEntry(c, entry()); // a hand entry: no byPrice, no table
  assert.equal(c.byPrice['claude-fable-5-2|std|std'].input, 13);
  assert.equal(c.byPrice['claude-fable-5-2|std|std'].messages, 3);
  assert.deepEqual(c.priceTables, { '2026-11-03': 2, '2027-01-01': 1 });
  assert.equal(costShapeProblem(c), null);
  assert.equal(costShapeProblem(addCostEntry(null, entry())), null);
  assert.equal(addCostEntry(null, entry()).byPrice, undefined);
  assert.equal(costShapeProblem({ ...c, byPrice: [] }), 'bad cost');
  assert.equal(costShapeProblem({ ...c, byPrice: 'x' }), 'bad cost');
  assert.equal(costShapeProblem({ ...c, priceTables: 3 }), 'bad cost');
  assert.throws(() => addCostEntry(null, entry({ byPrice: 'x' })), /byPrice/);
  assert.throws(() => addCostEntry(null, entry({ byPrice: { 'no-tier': {} } })), /byPrice key/);
  assert.throws(() => addCostEntry(null, entry({ byPrice: { 'm|std|std': { input: -1 } } })), /byPrice input/);
  assert.throws(() => addCostEntry(null, entry({ priceTable: 'yesterday' })), /priceTable/);
});

test('costReport / costLines: byPrice and priceTables are reported when present; an old cost is unchanged', () => {
  const old = addCostEntry(null, entry());
  assert.deepEqual(Object.keys(costReport(old)).sort(), ['byPhase', 'byRole', 'guardBlocks', 'guardBySession', 'retries', 'sessions', 'total']);
  assert.ok(!costLines(old).some((l) => /table/.test(l)));
  const priced = addCostEntry(old, entry({ byPrice: { 'claude-fable-5-2|std|std': { input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, messages: 1 } }, priceTable: '2026-11-03' }));
  const report = costReport(priced);
  assert.equal(report.byPrice['claude-fable-5-2|std|std'].messages, 1);
  assert.deepEqual(report.priceTables, { '2026-11-03': 1 });
  assert.ok(costLines(priced).includes('- **Priced with table:** 2026-11-03 (1)'));
  assert.equal(costLines(old).length, costLines(priced).length - 1);
});

const transcriptLine = (id, model, usage) => JSON.stringify({ type: 'assistant', message: { id, model, usage } });

test('byPrice round trip: P cost --from-transcript -> run record comment -> P summary JSON', () => {
  const s = scenario();
  s.repo.write('.review/t.jsonl', `${[
    transcriptLine('a', 'claude-fable-5-2', { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 300, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 } }),
    transcriptLine('b', 'claude-haiku-5-5', { input_tokens: 200000 }),
  ].join('\n')}\n`);
  const r = costCli(s, ['--phase', 'build', '--role', 'implementer', '--from-transcript', '.review/t.jsonl']);
  assertExit(r, 0);
  assert.equal(r.json.bucketed, true);
  assert.deepEqual(r.json.cost.priceTables, { '2026-11-03': 1 });
  const stored = written(s).cost;
  assert.deepEqual(stored.byPrice['claude-fable-5-2|std|std'], { input: 1000, output: 200, cacheRead: 0, cacheWrite5m: 100, cacheWrite1h: 200, messages: 1 });
  assert.equal(stored.byPrice['claude-haiku-5-5|>100k|std'].input, 200000);
  withComment(s, existing(written(s)));
  const sum = summary(s, []);
  assertExit(sum, 0);
  assert.deepEqual(sum.json.cost.byPrice, stored.byPrice);
  assert.deepEqual(sum.json.cost.priceTables, { '2026-11-03': 1 });
  assert.equal(sum.json.cost.total.usd, 0.1202);
});

test('byPrice: a hand entry is not bucketed; --model hand tokens are; --usd overrides bucketing; a second entry adds to the buckets', () => {
  const hand = costCli(scenario(), ['--phase', 'build', '--role', 'judge', '--input', '10', '--usd', '0.5']);
  assertExit(hand, 0);
  assert.equal(hand.json.bucketed, false);
  assert.equal(hand.json.cost.byPrice, undefined);
  assert.equal(hand.json.cost.priceTables, undefined);
  const noModel = costCli(scenario(), ['--phase', 'build', '--role', 'judge', '--input', '10']);
  assert.equal(noModel.json.bucketed, false);
  const retry = costCli(scenario(), ['--phase', 'build', '--role', 'judge', '--retry']);
  assert.equal(retry.json.bucketed, false);
  const s = scenario();
  const m = costCli(s, ['--phase', 'build', '--role', 'judge', '--input', '1000000', '--cache-write', '10', '--model', 'sonnet']);
  assert.equal(m.json.bucketed, true);
  assert.deepEqual(m.json.cost.byPrice['sonnet|std|std'], { input: 1e6, output: 0, cacheRead: 0, cacheWrite5m: 10, cacheWrite1h: 0, messages: 1 });
  withComment(s, existing(written(s)));
  const m2 = costCli(s, ['--phase', 'review', '--role', 'judge', '--input', '5', '--model', 'sonnet']);
  assert.equal(m2.json.cost.byPrice['sonnet|std|std'].input, 1e6 + 5);
  assert.deepEqual(m2.json.cost.priceTables, { '2026-11-03': 2 });
  const withUsd = costCli(scenario(), ['--phase', 'build', '--role', 'judge', '--input', '10', '--model', 'sonnet', '--usd', '0.5']);
  assert.equal(withUsd.json.bucketed, false);
  assert.equal(withUsd.json.cost.byPrice, undefined);
});

test('priceTables provenance: entries priced under two table dates show both; an old record without byPrice still renders and reports unchanged', () => {
  const bucket = { 'claude-opus-5-5|std|std': { input: 1, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, messages: 1 } };
  let r = applyCheckpoint(rec(), { cost: { entry: entry({ byPrice: bucket, priceTable: '2026-11-03' }) } }, { host: 'h', now: NOW });
  r = applyCheckpoint(r, { cost: { entry: entry({ byPrice: bucket, priceTable: '2027-02-01' }) } }, { host: 'h', now: NOW });
  const back = decodeRecord(`${MARKERS.summary}\n\n${encodeRecord(r)}`).record;
  assert.deepEqual(back.cost.priceTables, { '2026-11-03': 1, '2027-02-01': 1 });
  assert.equal(back.cost.byPrice['claude-opus-5-5|std|std'].input, 2);
  assert.ok(renderStatusBlock(back).includes('Priced with table:** 2026-11-03 (1) · 2027-02-01 (1)'));
  // an old record (cost without byPrice / priceTables) survives encode / decode and renders its old lines only
  const oldRec = withCost({ entry: entry({ usd: 2 }), retries: 1 });
  const oldBack = decodeRecord(`${MARKERS.summary}\n\n${encodeRecord(oldRec)}`).record;
  assert.equal(oldBack.cost.byPrice, undefined);
  assert.deepEqual(costReport(oldBack.cost).total, { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, usd: 2, calls: 1 });
  assert.ok(!renderStatusBlock(oldBack).includes('table'));
  // a record whose byPrice is not an object is refused by the shape check
  const bad = structuredClone(back);
  bad.cost.byPrice = [];
  assert.equal(decodeRecord(`${MARKERS.summary}\n\n${encodeRecord(bad)}`).status, 'invalid');
});

test('a trip-wire stop is the existing outcome blocked with detail process-review: the record is valid and carries it (no new outcome)', () => {
  const { record, warnings } = recordForOutcome(null, { repo: 'acme/widgets', pr: PR, branch: 'agent/feature', baseRef: 'main', outcome: 'blocked', detail: 'process-review: Process review before round 4: 2 past-limit round(s) accepted at least as many new items', host: 'h', now: NOW });
  assert.deepEqual(warnings, []);
  assert.equal(record.outcome, 'blocked');
  assert.match(record.detail, /^process-review: /);
  const decoded = decodeRecord(`${MARKERS.summary}\n\n${encodeRecord(record)}`);
  assert.equal(decoded.status, 'ok');
  assert.equal(decoded.record.outcome, 'blocked');
});

// Issue #820 (round 1): a message whose usage is `{}` counted as one usage-bearing message, so the first --retry booking of a not-yet-filled transcript wrote a transcript key + a retry and the real booking later made 2 calls and 2 retries.
test('P cost --from-transcript: a transcript whose only usage is {} is empty (skipped); explicit zero token fields still count as a real call', () => {
  const s = scenario();
  s.repo.write('.review/t.jsonl', `${JSON.stringify({ message: { id: 'm', usage: {} } })}\n`);
  const args = ['--phase', 'review', '--role', 'judge', '--retry', '--from-transcript', '.review/t.jsonl'];
  const first = costCli(s, args);
  assertExit(first, 0);
  assert.equal(first.json.skipped, 'empty-transcript');
  assert.equal(first.json.recorded, false);
  s.repo.write('.review/t.jsonl', `${JSON.stringify({ message: { id: 'm', usage: { input_tokens: 10, output_tokens: 20 } } })}\n`);
  const second = costCli(s, args);
  assertExit(second, 0);
  assert.deepEqual([second.json.cost.total.calls, second.json.cost.retries], [1, 1]);
  const zero = scenario();
  zero.repo.write('.review/t.jsonl', `${JSON.stringify({ message: { id: 'm', usage: { input_tokens: 0, output_tokens: 0 } } })}\n`);
  const z = costCli(zero, ['--phase', 'review', '--role', 'judge', '--from-transcript', '.review/t.jsonl']);
  assertExit(z, 0);
  assert.equal(z.json.skipped, undefined);
  assert.equal(z.json.cost.total.calls, 1);
});

// Issue #501 (round 1): the CLI promises plan-codex is tokens only unless --usd is given, but --model priced the tokens and added a Sonnet charge to the PR total.
test('P cost --role plan-codex --model sonnet: tokens only, no USD and no price bucket; an explicit --usd still sets the amount', () => {
  const r = costCli(scenario(), ['--phase', 'plan', '--role', 'plan-codex', '--input', '1000000', '--output', '1000000', '--model', 'sonnet']);
  assertExit(r, 0);
  assert.deepEqual([r.json.cost.byRole['plan-codex'].input, r.json.cost.byRole['plan-codex'].usd, r.json.cost.total.usd], [1000000, 0, 0]);
  assert.equal(r.json.bucketed, false);
  const usd = costCli(scenario(), ['--phase', 'plan', '--role', 'plan-codex', '--input', '1000', '--model', 'sonnet', '--usd', '0.5']);
  assertExit(usd, 0);
  assert.equal(usd.json.cost.byRole['plan-codex'].usd, 0.5);
});
