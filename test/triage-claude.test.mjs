// The pure rules of Claude's own rulings (plan 2026-11-05-claude-rulings.md section 10 + E1-E11): the cause of a needs-human final,
// what may be dismissed by Claude alone, what a second review (Codex) must also dismiss, which finals no writer may overwrite, and
// the state version gate. Nothing here runs a command: test/cli-triage-claude.test.mjs does that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { issueBody } from '../pipeline/commands/followups.mjs';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFERRABLE_ACCEPT_BY,
  MALFUNCTION_CAUSES,
  applyClaudeRuling,
  applyJudge,
  applyOwnerRuling,
  applyRulings,
  applyTestResult,
  claudeRulingRefusal,
  fableFindingItems,
  isClaudeRuled,
  isCriticalDismissal,
  isDeferrableAccept,
  isOwnerDeferral,
  isOwnerRuled,
  isProtectedFinal,
  needsHumanCause,
  reviewEligibilityProblems,
  reuseRuled,
  ruledCacheFrom,
  rulingContentDigest,
  rulingsInventory,
  settleSecondReview,
} from '../pipeline/lib/triage.mjs';
import { SUPPORTED_STATE_VERSION, decodeFromComment, emptyState, encodeForComment, loadState, saveState, withStateVersion } from '../pipeline/lib/state.mjs';

// ---- fixtures -------------------------------------------------------------------------------

let seq = 0;
function item(over = {}) {
  seq += 1;
  return {
    id: `R1-S${seq}`, round: 1, bucket: 'SUGGESTION', category: 'maintainability', title: `finding ${seq}`, file: 'src/a.js', line: 10,
    detail: 'detail', codexReasoning: 'codex reasoning', testable: false, fingerprint: `fp-${seq}`,
    judge: null, test: { status: 'none', evidence: '' }, arbiter: null, final: null, implemented: false, followupIssue: null, ...over,
  };
}
const waiting = (cause, over = {}) => item({ final: { decision: 'REJECT', by: 'arbiter', needsHuman: true, reason: 'x', ...(cause ? { cause } : {}) }, ...over });
const verdict = (decision, confidence = 'high', over = {}) => ({
  decision, confidence, reasoning: `codex says ${decision}`, model: 'gpt-x', effort: 'high', inputDigest: 'd'.repeat(64), ranAt: '2026-11-05T10:00:00.000Z', ...over,
});
const RULED_AT = '2026-11-05T11:00:00.000Z';
const rule = (it, decision, reason = 'because') => applyClaudeRuling(it, { decision, reason, ruledAt: RULED_AT });
const throwsWith = (fn, re) => assert.throws(fn, (e) => { assert.match(e.message, re); return true; });

// ---- final.cause at the six sites -------------------------------------------------------------

test('every needs-human site records its cause', () => {
  const f = (over) => ({ bucket: 'BLOCKING', category: 'bug', title: 't', file: 'a.js', line: 1, detail: 'd', ruling: 'ACCEPT', confidence: 'high', reasoning: 'r', ...over });
  const fable = (over) => fableFindingItems([f(over)], 1)[0].final;
  assert.equal(fable({ confidence: 'low' }).cause, 'low-confidence');
  assert.equal(fable({ category: 'security', ruling: 'FOLLOW-UP' }).cause, 'security-dismissal');
  assert.equal(fable({}).cause, undefined, 'a settled finding has no cause');

  const j = item({ id: 'R1-X1' });
  assert.equal(applyJudge([j], { items: [{ id: j.id, decision: 'maybe', confidence: 'high', reason: '' }] })[0].final.cause, 'invalid-judge');

  const sec = applyTestResult(item({ category: 'security', bucket: 'BLOCKING' }), 'bug-disproved', 'ok');
  assert.equal(sec.final.cause, 'test-security');
  assert.equal(applyTestResult(item(), 'bug-disproved', 'ok').final.cause, undefined);

  const base = item({ id: 'R1-A1', bucket: 'BLOCKING', category: 'logic' });
  const ruled = (r, opts, it = base) => applyRulings([it], [{ id: it.id, ...r }], opts)[0].final;
  assert.equal(ruled({ ruling: 'ACCEPT', confidence: 'high', reasoning: 'r' }, { proofOk: false }).cause, 'model-proof');
  assert.equal(ruled({ ruling: 'ACCEPT', confidence: 'high', reasoning: 'r' }, { proofOk: false, proofCause: 'stale-model' }).cause, 'stale-model', 'a proof that failed on the Fable floor alone');
  assert.equal(ruled({ ruling: 'nonsense', confidence: 'high', reasoning: 'r' }, { proofOk: true }).cause, 'invalid-arbiter');
  assert.equal(ruled({ ruling: 'ACCEPT', confidence: 'low', reasoning: 'r' }, { proofOk: true }).cause, 'low-confidence');
  const sb = item({ id: 'R1-A2', bucket: 'BLOCKING', category: 'security' });
  assert.equal(ruled({ ruling: 'REJECT', confidence: 'high', reasoning: 'r' }, { proofOk: true }, sb).cause, 'security-dismissal');
  assert.equal(ruled({ ruling: 'ACCEPT', confidence: 'high', reasoning: 'r' }, { proofOk: true }).cause, undefined);
});

test('needsHumanCause: the stored cause, else the legacy reason strings, else unknown', () => {
  const legacy = (reason, over = {}) => item({ final: { decision: 'REJECT', by: 'arbiter', needsHuman: true, reason, ...over } });
  const table = [
    ['model-proof failed: ruling not provably from Fable', 'model-proof'],
    ['stale-model: the ruling came from a Fable older than this machine\'s floor', 'stale-model'],
    ['invalid arbiter output', 'invalid-arbiter'],
    ['invalid judge output', 'invalid-judge'],
    ['arbiter low confidence', 'low-confidence'],
    ['would dismiss a blocking security/data item', 'security-dismissal'],
    ['would defer a blocking security/data finding', 'security-dismissal'],
    ['test disproved, but it would dismiss a security/data item: ev', 'test-security'],
    ['something somebody typed', 'unknown'],
  ];
  for (const [reason, cause] of table) assert.equal(needsHumanCause(legacy(reason)), cause, reason);
  assert.equal(needsHumanCause(legacy('invalid arbiter output', { cause: 'low-confidence' })), 'low-confidence', 'the stored cause wins');
  assert.equal(needsHumanCause(item({ final: null })), 'unknown');
  const ruled = rule(waiting('low-confidence'), 'ACCEPT');
  assert.equal(needsHumanCause(ruled), 'low-confidence', 'kept in final.claude after the ruling');
  assert.deepEqual(MALFUNCTION_CAUSES, ['model-proof', 'invalid-arbiter', 'invalid-judge', 'stale-model', 'stale-terminal']);
  for (const cause of ['stale-model', 'stale-terminal']) assert.equal(needsHumanCause(item({ final: { decision: 'ACCEPT', by: 'arbiter', needsHuman: true, reason: 'r', cause } })), cause, `${cause} is a needs-human cause`);
});

// ---- critical dismissal -----------------------------------------------------------------------

test('isCriticalDismissal: REJECT, BLOCKING, security categories and an unknown cause are critical; ACCEPT never', () => {
  const sug = waiting('low-confidence');
  assert.equal(isCriticalDismissal(sug, 'FOLLOW-UP'), false, 'a non-BLOCKING non-security follow-up is the only non-critical dismissal');
  assert.equal(isCriticalDismissal(sug, 'REJECT'), true);
  assert.equal(isCriticalDismissal(sug, 'ACCEPT'), false);
  assert.equal(isCriticalDismissal(waiting('low-confidence', { bucket: 'BLOCKING' }), 'FOLLOW-UP'), true);
  for (const category of ['security', 'auth', 'permissions', 'data-integrity', 'data-loss']) {
    assert.equal(isCriticalDismissal(waiting('low-confidence', { category }), 'FOLLOW-UP'), true, category);
  }
  assert.equal(isCriticalDismissal(waiting(undefined), 'FOLLOW-UP'), true, 'no cause on a reason nobody recognises: conservative');
  assert.equal(isCriticalDismissal(waiting(undefined, { final: { decision: 'REJECT', by: 'arbiter', needsHuman: true, reason: 'arbiter low confidence' } }), 'FOLLOW-UP'), false, 'a legacy reason that maps is not unknown');
  assert.equal(isCriticalDismissal(waiting(undefined, { bucket: 'BLOCKING' }), 'ACCEPT'), false);
});

// ---- who owns a final -------------------------------------------------------------------------

test('isClaudeRuled / isProtectedFinal: Claude finals, forced finals and their cached copies', () => {
  const claude = rule(waiting('low-confidence'), 'FOLLOW-UP');
  assert.equal(isClaudeRuled(claude), true);
  assert.equal(isProtectedFinal(claude), true);
  const forced = settleSecondReview(waiting('low-confidence'), verdict('ACCEPT'));
  assert.equal(isProtectedFinal(forced), true);
  const copy = item({ final: { ...claude.final, by: 'cache' } });
  assert.equal(isClaudeRuled(copy), true, 'a cached copy still carries final.claude');
  assert.equal(isProtectedFinal(copy), true);
  const onlyForced = item({ final: { decision: 'ACCEPT', by: 'cache', needsHuman: false, reason: 'r', forcedBy: 'second-review' } });
  assert.equal(isProtectedFinal(onlyForced), true);
  for (const final of [null, { decision: 'ACCEPT', by: 'arbiter', needsHuman: false, reason: 'r' }, { decision: 'ACCEPT', by: 'judge', needsHuman: false, reason: 'r' },
    { decision: 'ACCEPT', by: 'test', needsHuman: false, reason: 'r' }, { decision: 'FOLLOW-UP', by: 'owner', needsHuman: false, reason: 'r', ownerQuote: 'q' }]) {
    assert.equal(isProtectedFinal(item({ final })), false);
    assert.equal(isClaudeRuled(item({ final })), false);
  }
});

// ---- the refusal table ------------------------------------------------------------------------

test('claudeRulingRefusal: the table of what Claude alone may not do', () => {
  const refusal = (it, decision, opts) => claudeRulingRefusal(it, decision, opts);
  const sug = () => waiting('low-confidence');
  const blocking = (over = {}) => waiting('low-confidence', { bucket: 'BLOCKING', category: 'logic', ...over });

  // allowed
  assert.equal(refusal(sug(), 'ACCEPT'), null, 'ACCEPT on a needs-human item');
  assert.equal(refusal(sug(), 'FOLLOW-UP'), null, 'a non-critical follow-up needs nobody else');
  assert.equal(refusal(waiting('model-proof'), 'ACCEPT'), null, 'ACCEPT is allowed on a malfunction cause');
  assert.equal(refusal(waiting('invalid-arbiter'), 'ACCEPT'), null);
  assert.equal(refusal(waiting('invalid-judge'), 'ACCEPT'), null);
  assert.equal(refusal(rule(sug(), 'FOLLOW-UP'), 'ACCEPT'), null, 'a Claude dismissal may tighten to ACCEPT');
  assert.equal(refusal(blocking({ secondReview: verdict('REJECT') }), 'REJECT'), null, 'a critical dismissal with Codex dismissing at high confidence');
  assert.equal(refusal(blocking({ secondReview: verdict('FOLLOW-UP') }), 'FOLLOW-UP'), null);
  assert.equal(refusal(blocking({ secondReview: verdict('REJECT') }), 'ACCEPT'), null, 'ACCEPT needs no verdict');

  // implemented
  assert.match(refusal(waiting('low-confidence', { implemented: true }), 'ACCEPT'), /implemented/);
  assert.match(refusal({ ...rule(sug(), 'FOLLOW-UP'), implemented: true }, 'ACCEPT'), /implemented/);

  // loosening an ACCEPT, Claude or forced
  const claudeAccept = rule(sug(), 'ACCEPT');
  for (const d of ['FOLLOW-UP', 'REJECT']) assert.match(refusal(claudeAccept, d), /loosen|owner/, `Claude ACCEPT -> ${d}`);
  const forced = settleSecondReview(sug(), verdict('ACCEPT'));
  for (const d of ['FOLLOW-UP', 'REJECT']) assert.match(refusal(forced, d), /loosen|owner/, `forced ACCEPT -> ${d}`);
  assert.match(refusal(claudeAccept, 'ACCEPT'), /already/, 'ACCEPT over an ACCEPT is a no-op, refused');

  // malfunction causes: dismissal refused, with the way out
  for (const cause of MALFUNCTION_CAUSES) {
    assert.match(refusal(waiting(cause, { secondReview: verdict('REJECT') }), 'FOLLOW-UP'), /re-run the judge\/arbiter.*ACCEPT/, cause);
    assert.match(refusal(waiting(cause), 'REJECT'), /re-run the judge\/arbiter/, cause);
  }

  // critical dismissals need a Codex dismissal at high confidence
  assert.match(refusal(sug(), 'REJECT'), /second review/, 'REJECT without a verdict');
  assert.match(refusal(blocking(), 'FOLLOW-UP'), /second review/, 'BLOCKING without a verdict');
  assert.match(refusal(waiting('low-confidence', { category: 'security' }), 'FOLLOW-UP'), /second review/, 'security without a verdict');
  assert.match(refusal(waiting(undefined), 'FOLLOW-UP'), /second review/, 'unknown cause without a verdict');
  assert.match(refusal(blocking({ secondReview: verdict('ACCEPT') }), 'REJECT'), /ACCEPT/, 'Codex says ACCEPT');
  assert.match(refusal(blocking({ secondReview: verdict('REJECT', 'medium') }), 'REJECT'), /high/, 'medium confidence');
  assert.match(refusal(blocking({ secondReview: verdict('REJECT', 'low') }), 'REJECT'), /high/, 'low confidence');
  assert.equal(refusal(blocking(), 'REJECT', { secondReview: verdict('REJECT') }), null, 'a verdict passed in counts');

  // not reopened: settled finals, items with no final, owner rulings
  for (const final of [null, { decision: 'REJECT', by: 'judge', needsHuman: false, reason: 'r' }, { decision: 'ACCEPT', by: 'arbiter', needsHuman: false, reason: 'r' },
    { decision: 'REJECT', by: 'test', needsHuman: false, reason: 'r' }, { decision: 'ACCEPT', by: 'cache', needsHuman: false, reason: 'r' },
    { decision: 'REJECT', by: 'owner', needsHuman: false, reason: 'r', ownerQuote: 'q' }]) {
    assert.match(refusal(item({ final }), 'ACCEPT'), /not .*(waiting|reopen)|settled/, JSON.stringify(final));
  }
  assert.match(refusal(undefined, 'ACCEPT'), /no item/);
  assert.match(refusal(sug(), 'MAYBE'), /decision/);
});

test('applyClaudeRuling throws exactly what claudeRulingRefusal refuses', () => {
  const blocked = [
    [waiting('low-confidence', { implemented: true }), 'ACCEPT'],
    [rule(waiting('low-confidence'), 'ACCEPT'), 'REJECT'],
    [waiting('model-proof'), 'FOLLOW-UP'],
    [waiting('low-confidence', { bucket: 'BLOCKING' }), 'REJECT'],
    [item({ final: { decision: 'ACCEPT', by: 'judge', needsHuman: false, reason: 'r' } }), 'ACCEPT'],
  ];
  for (const [it, decision] of blocked) {
    const why = claudeRulingRefusal(it, decision);
    assert.ok(why);
    throwsWith(() => rule(it, decision), new RegExp(why.slice(0, 20).replace(/[^a-z0-9 ]/gi, '.')));
  }
  const before = JSON.stringify(waiting('low-confidence'));
  const it = JSON.parse(before);
  rule(it, 'ACCEPT');
  assert.equal(JSON.stringify(it), before, 'the input is not mutated');
});

// ---- the result: stricter of the two ----------------------------------------------------------

test('applyClaudeRuling: the final records who ruled, why, the cause and what it overruled', () => {
  const start = waiting('low-confidence');
  const out = rule(start, 'FOLLOW-UP', 'tracked in an issue');
  assert.deepEqual(out.final, {
    decision: 'FOLLOW-UP', by: 'claude', needsHuman: false, reason: 'tracked in an issue',
    claude: { ruledAt: RULED_AT, cause: 'low-confidence', critical: false, overruled: start.final },
  });
  const crit = applyClaudeRuling(waiting('security-dismissal', { bucket: 'BLOCKING', category: 'security', secondReview: verdict('REJECT') }), { decision: 'REJECT', reason: 'r', ruledAt: RULED_AT });
  assert.equal(crit.final.claude.critical, true);
  assert.equal(crit.final.claude.cause, 'security-dismissal');
  const tightened = rule(out, 'ACCEPT');
  assert.equal(tightened.final.decision, 'ACCEPT');
  assert.equal(tightened.final.claude.cause, 'low-confidence', 'the original cause is kept through a re-ruling');
  assert.equal(tightened.final.claude.overruled.by, 'claude');
});

test('stricter of Claude and Codex: ACCEPT > FOLLOW-UP > REJECT (truth table)', () => {
  const rank = { ACCEPT: 3, 'FOLLOW-UP': 2, REJECT: 1 };
  for (const claude of ['ACCEPT', 'FOLLOW-UP', 'REJECT']) {
    for (const codex of ['ACCEPT', 'FOLLOW-UP', 'REJECT']) {
      const it = waiting('low-confidence', { bucket: 'BLOCKING', category: 'logic', secondReview: verdict(codex) });
      const refused = claudeRulingRefusal(it, claude);
      // ACCEPT from Codex is already a forced final in real life; here the item is hand-built to show the rule.
      if (codex === 'ACCEPT' && claude !== 'ACCEPT') {
        assert.ok(refused, `Codex ACCEPT blocks Claude ${claude}`);
        continue;
      }
      assert.equal(refused, null, `${claude} with Codex ${codex}`);
      const want = rank[claude] >= rank[codex] ? claude : codex;
      assert.equal(rule(it, claude).final.decision, want, `Claude ${claude} + Codex ${codex}`);
    }
  }
  const noVerdict = rule(waiting('low-confidence'), 'FOLLOW-UP');
  assert.equal(noVerdict.final.decision, 'FOLLOW-UP', 'no verdict: Claude alone, only where non-critical');
});

// ---- the second review ------------------------------------------------------------------------

test('settleSecondReview: stores the verdict; ACCEPT forces the final at once; a dismissal leaves the final alone', () => {
  const start = waiting('security-dismissal', { bucket: 'BLOCKING', category: 'security' });
  const dismiss = settleSecondReview(start, verdict('REJECT'));
  assert.deepEqual(dismiss.secondReview, verdict('REJECT'));
  assert.deepEqual(dismiss.final, start.final, 'still waiting for a human');
  const forced = settleSecondReview(start, verdict('ACCEPT'));
  assert.deepEqual(forced.final, {
    decision: 'ACCEPT', by: 'claude', forcedBy: 'second-review', needsHuman: false, reason: 'codex says ACCEPT',
    claude: { ruledAt: '2026-11-05T10:00:00.000Z', cause: 'security-dismissal', critical: false, overruled: start.final },
  });
  assert.deepEqual(forced.secondReview, verdict('ACCEPT'));
  assert.equal(start.secondReview, undefined, 'the input is not mutated');
  // a Claude dismissal tightened by Codex ACCEPT
  const claudeDismissed = rule(waiting('low-confidence'), 'FOLLOW-UP');
  assert.equal(settleSecondReview(claudeDismissed, verdict('ACCEPT')).final.forcedBy, 'second-review');
  // refusals
  throwsWith(() => settleSecondReview(dismiss, verdict('REJECT')), /already/);
  throwsWith(() => settleSecondReview(waiting('model-proof'), verdict('REJECT')), /re-run/);
  throwsWith(() => settleSecondReview(item({ final: { decision: 'ACCEPT', by: 'judge', needsHuman: false, reason: 'r' } }), verdict('REJECT')), /waiting|settled/);
  throwsWith(() => settleSecondReview(waiting('low-confidence', { implemented: true }), verdict('REJECT')), /implemented/);
  throwsWith(() => settleSecondReview(start, { ...verdict('REJECT'), decision: 'MAYBE' }), /decision/);
});

// ---- writers leave Claude and forced finals alone ---------------------------------------------

test('applyRulings never overwrites a Claude, forced or cached-Claude final (E10)', () => {
  const claude = rule(waiting('low-confidence'), 'FOLLOW-UP');
  const forced = settleSecondReview(waiting('low-confidence'), verdict('ACCEPT'));
  const copy = item({ final: { ...claude.final, by: 'cache' } });
  for (const it of [claude, forced, copy]) {
    const out = applyRulings([it], [{ id: it.id, ruling: 'REJECT', confidence: 'high', reasoning: 'arbiter' }], { proofOk: true })[0];
    assert.deepEqual(out.final, it.final);
    assert.equal(out.arbiter, it.arbiter, 'the arbiter opinion is not even recorded on it');
    const unproven = applyRulings([it], [{ id: it.id, ruling: null, confidence: 'low', reasoning: 'unverified' }], { proofOk: false })[0];
    assert.deepEqual(unproven.final, it.final);
  }
});

test('ruledCacheFrom: a Claude or forced dismissal of a BLOCKING or security item is never reused; a non-critical one is, and stays visible', () => {
  const crit = (over) => rule(waiting('low-confidence', { bucket: 'BLOCKING', category: 'logic', secondReview: verdict('REJECT'), ...over }), 'REJECT');
  const blocking = crit({});
  const security = rule(waiting('low-confidence', { bucket: 'SUGGESTION', category: 'security', secondReview: verdict('REJECT') }), 'REJECT');
  const unknownCause = rule(waiting(undefined, { secondReview: verdict('FOLLOW-UP') }), 'FOLLOW-UP');
  const plain = rule(waiting('low-confidence'), 'FOLLOW-UP', 'later');
  const accept = rule(waiting('low-confidence', { bucket: 'BLOCKING' }), 'ACCEPT');
  const cache = ruledCacheFrom([blocking, security, unknownCause, plain, accept]);
  assert.deepEqual(Object.keys(cache).sort(), [plain.fingerprint, accept.fingerprint].sort(), 'only the non-critical dismissal and the ACCEPT are cached');

  const fresh = item({ fingerprint: plain.fingerprint });
  const [reused] = reuseRuled([fresh], cache);
  assert.equal(reused.final.by, 'cache');
  assert.deepEqual(reused.final.claude, plain.final.claude, 'the Claude ruling stays visible on the cached copy');
  assert.equal(isClaudeRuled(reused), true);
  // ...and a final already on the item is never replaced by a cache entry
  const [kept] = reuseRuled([{ ...fresh, final: forcedFinal() }], cache);
  assert.deepEqual(kept.final, forcedFinal());
  function forcedFinal() { return settleSecondReview(waiting('low-confidence'), verdict('ACCEPT')).final; }
});

// ---- owner override ---------------------------------------------------------------------------

test('applyOwnerRuling: a needs-human item or a Claude/forced final that is not implemented; the overruled final is kept', () => {
  const args = { decision: 'REJECT', reason: 'owner says', ownerQuote: 'R1-S1: reject', ruledAt: RULED_AT };
  const claude = rule(waiting('low-confidence'), 'ACCEPT');
  const forced = settleSecondReview(waiting('security-dismissal'), verdict('ACCEPT'));
  for (const it of [waiting('low-confidence'), claude, forced]) {
    const out = applyOwnerRuling(it, args);
    assert.equal(out.final.by, 'owner');
    assert.equal(out.final.decision, 'REJECT');
    assert.deepEqual(out.final.overruled, it.final);
    assert.equal(out.final.claude, undefined, 'the owner final carries no Claude marker');
  }
  throwsWith(() => applyOwnerRuling({ ...claude, implemented: true }, args), /implemented/);
  throwsWith(() => applyOwnerRuling({ ...forced, implemented: true }, args), /implemented/);
  throwsWith(() => applyOwnerRuling(item({ final: { decision: 'ACCEPT', by: 'judge', needsHuman: false, reason: 'r' } }), args), /needs no human/);
});

// ---- the state format version -----------------------------------------------------------------

test('withStateVersion raises the version and never lowers it', () => {
  const base = emptyState({ repo: 'a/b', pr: 7, branch: 'x' });
  assert.equal(withStateVersion(base, 2).version, 2);
  assert.equal(withStateVersion({ ...base, version: 3 }, 2).version, 3, 'a deferral state stays at 3 through a Claude ruling');
  assert.equal(withStateVersion({ ...base, version: undefined }, 2).version, 2);
  assert.equal(base.version, 1, 'the argument is not changed');
});

test('SUPPORTED_STATE_VERSION 8: a newer state is refused by loadState and decodeFromComment; 1, 2 (Claude ruling), 3 (deferral), 4 (substitute) 5 (out-of-model final), 6 (post-max final), 7 (owner deferral) and 8 (same-on-base) load', () => {
  assert.equal(SUPPORTED_STATE_VERSION, 8);
  const dir = mkdtempSync(join(tmpdir(), 'cp-state-version-'));
  try {
    const base = emptyState({ repo: 'a/b', pr: 7, branch: 'x' });
    assert.equal(base.version, 1, 'ordinary states stay at 1');
    for (const version of [1, 2, 3, 4, 5, 6, 7, 8]) {
      saveState(dir, { ...base, version });
      assert.equal(loadState(dir).version, version);
      assert.equal(decodeFromComment(encodeForComment({ ...base, version })).version, version);
    }
    saveState(dir, { ...base, version: 9 });
    assert.throws(() => loadState(dir), /version 9.*supports.*8/);
    assert.equal(decodeFromComment(encodeForComment({ ...base, version: 9 })), null);
    mkdirSync(join(dir, '.review'), { recursive: true });
    writeFileSync(join(dir, '.review', 'state.json'), JSON.stringify({ ...base, version: 99 }));
    assert.throws(() => loadState(dir), /newer/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- owner deferral of an unimplemented arbiter / judge / cache ACCEPT (plan 2026-11-17 PR A1, Item 1a + F1, F6, F12) ------------------------------------

const accepted = (by = 'arbiter', over = {}) => item({ bucket: 'BLOCKING', category: 'security', final: { decision: 'ACCEPT', by, needsHuman: false, reason: `${by} accepted` }, ...over });
const DEFER = { decision: 'FOLLOW-UP', reason: 'owner defers it', ownerQuote: 'R1-S1: follow-up', ruledAt: RULED_AT };

test('isDeferrableAccept / isOwnerDeferral: only an unimplemented ACCEPT of the arbiter, judge or cache that nobody protected, tested or owner-ruled', () => {
  for (const by of ['arbiter', 'judge', 'cache']) assert.equal(isDeferrableAccept(accepted(by)), true, by);
  assert.deepEqual(DEFERRABLE_ACCEPT_BY, ['arbiter', 'judge', 'cache']);
  const no = (why, it) => assert.equal(isDeferrableAccept(it), false, why);
  no('implemented', accepted('arbiter', { implemented: true }));
  no('by test', accepted('test'));
  no('a cached copy of a test result (F12)', accepted('cache', { final: { decision: 'ACCEPT', by: 'cache', needsHuman: false, reason: 'r', evidence: 'test' } }));
  no('Claude ruled', rule(waiting('low-confidence'), 'ACCEPT'));
  no('second review forced', settleSecondReview(waiting('security-dismissal'), verdict('ACCEPT')));
  no('waiting for a human', waiting('low-confidence'));
  no('a FOLLOW-UP', accepted('arbiter', { final: { decision: 'FOLLOW-UP', by: 'arbiter', needsHuman: false, reason: 'r' } }));
  no('a REJECT', accepted('arbiter', { final: { decision: 'REJECT', by: 'arbiter', needsHuman: false, reason: 'r' } }));
  no('owner ruled', accepted('cache', { final: { decision: 'ACCEPT', by: 'cache', needsHuman: false, reason: 'r', ownerQuote: 'q' } }));
  no('round-cap deferral', accepted('arbiter', { roundCapDeferral: { fixHead: 'a', reviewedHead: 'b', at: RULED_AT } }));
  no('no final', item());
  assert.equal(isOwnerDeferral(accepted()), false);
});

test('applyOwnerRuling: an unimplemented arbiter ACCEPT may be deferred (FOLLOW-UP) only; the final records ownerDeferral and keeps the ACCEPT as overruled', () => {
  for (const by of ['arbiter', 'judge', 'cache']) {
    const it = accepted(by);
    const out = applyOwnerRuling(it, DEFER);
    assert.equal(out.final.by, 'owner');
    assert.equal(out.final.decision, 'FOLLOW-UP');
    assert.equal(out.final.needsHuman, false);
    assert.deepEqual(out.final.ownerDeferral, { accepted: by, ruledAt: RULED_AT });
    assert.deepEqual(out.final.overruled, it.final, 'the ACCEPT it deferred is kept');
    assert.equal(out.final.ownerQuote, DEFER.ownerQuote);
    assert.equal(out.implemented, false);
    assert.equal(isOwnerDeferral(out), true);
    assert.equal(isOwnerRuled(out), true);
    assert.equal(isDeferrableAccept(out), false, 'once deferred it is no longer an open ACCEPT');
  }
  for (const decision of ['REJECT', 'ACCEPT']) throwsWith(() => applyOwnerRuling(accepted(), { ...DEFER, decision }), /needs no human/);
  throwsWith(() => applyOwnerRuling(accepted('arbiter', { implemented: true }), DEFER), /needs no human/);
  throwsWith(() => applyOwnerRuling(accepted('test'), DEFER), /needs no human/);
  throwsWith(() => applyOwnerRuling(accepted('cache', { final: { decision: 'ACCEPT', by: 'cache', needsHuman: false, reason: 'r', evidence: 'test' } }), DEFER), /needs no human/);
  // the old paths are as before: a needs-human item takes any decision, an owner-ruled ACCEPT is not reopened
  assert.equal(applyOwnerRuling(waiting('low-confidence'), { ...DEFER, decision: 'REJECT' }).final.ownerDeferral, undefined);
  throwsWith(() => applyOwnerRuling(applyOwnerRuling(waiting('low-confidence'), { ...DEFER, decision: 'ACCEPT' }), DEFER), /needs no human/);
});

test('F1: rulingContentDigest is unchanged for every ordinary item and carries a marker only for a deferrable ACCEPT or an owner deferral (stable once applied)', () => {
  const plain = waiting('low-confidence', { id: 'R1-S1', bucket: 'SUGGESTION', title: 'same text' });
  const tuple = [plain.id.toUpperCase(), plain.source, plain.bucket, plain.category, plain.title, plain.file, plain.line, plain.detail, plain.codexReasoning, plain.arbiter?.reasoning].map((v) => v ?? null);
  assert.equal(rulingContentDigest([plain]), createHash('sha256').update(JSON.stringify([tuple])).digest('hex').slice(0, 12), 'the existing digest is byte-identical');
  const same = { ...plain, final: { decision: 'ACCEPT', by: 'arbiter', needsHuman: false, reason: 'r' } };
  assert.notEqual(rulingContentDigest([same]), rulingContentDigest([plain]), 'the same text asked while it was ACCEPTED is another question');
  const claudeOne = rule(plain, 'ACCEPT');
  assert.equal(rulingContentDigest([claudeOne]), rulingContentDigest([plain]), 'a Claude final is not a deferral: unchanged');
  assert.equal(rulingContentDigest([applyOwnerRuling(same, { ...DEFER, ownerQuote: 'x' })]), rulingContentDigest([same]), 'applying the ruling leaves the request\'s digest alone');
  assert.equal(rulingContentDigest([{ ...same, final: { ...same.final, by: 'test' } }]), rulingContentDigest([plain]), 'a test ACCEPT is not deferrable: unchanged');
});

test('F12 / F6: the result cache carries a test mark, and an owner deferral survives it as a deferral', () => {
  const tested = applyTestResult(item({ bucket: 'BLOCKING', category: 'bug', testable: true }), 'bug-confirmed', 'it fails');
  assert.equal(tested.final.by, 'test');
  const cache = ruledCacheFrom([tested]);
  const [copy] = reuseRuled([item({ bucket: 'BLOCKING', category: 'bug', fingerprint: tested.fingerprint })], cache);
  assert.equal(copy.final.by, 'cache');
  assert.equal(copy.final.evidence, 'test');
  assert.equal(isDeferrableAccept(copy), false, 'a test ACCEPT stays undeferrable through the cache');

  const deferred = applyOwnerRuling(accepted('arbiter'), DEFER);
  const [carried] = reuseRuled([item({ bucket: 'BLOCKING', category: 'security', fingerprint: deferred.fingerprint })], ruledCacheFrom([deferred]));
  assert.equal(carried.final.by, 'cache', 'the cache rewrites by');
  assert.equal(isOwnerDeferral(carried), true, '...but the deferral is keyed on final.ownerDeferral');
  assert.equal(isOwnerRuled(carried), true);
});

// R1-B2: a cached test ACCEPT written before the cache kept final.evidence has only the reason prefix of applyTestResult to tell it from an arbiter ACCEPT.
test('R1-B2: a legacy cached copy of a test ACCEPT (no evidence mark, reason "test confirmed: ...") is not deferrable and stays a test result through the cache', () => {
  const legacy = accepted('cache', { final: { decision: 'ACCEPT', by: 'cache', needsHuman: false, reason: 'test confirmed: it fails' } });
  assert.equal(isDeferrableAccept(legacy), false);
  throwsWith(() => applyOwnerRuling(legacy, DEFER), /needs no human/);
  const tested = applyTestResult(item({ bucket: 'BLOCKING', category: 'security', testable: true }), 'bug-confirmed', 'it fails');
  const later = { ...legacy, fingerprint: tested.fingerprint };
  assert.equal(ruledCacheFrom([later])[tested.fingerprint].evidence, 'test', 'the cache stamps the legacy copy');
  assert.equal(ruledCacheFrom([tested, later])[tested.fingerprint].evidence, 'test', 'a later legacy copy does not erase the mark');
  assert.equal(isDeferrableAccept(accepted('cache', { final: { decision: 'ACCEPT', by: 'cache', needsHuman: false, reason: 'arbiter says test confirmed: no' } })), true, 'only the prefix counts');
});

test('the Rulings block lists an owner deferral (BLOCKING or not), once for a cached copy; the filing gate holds until the issue is filed', () => {
  const deferred = applyOwnerRuling(accepted('arbiter', { bucket: 'SUGGESTION', category: 'maintainability', id: 'R1-S1', title: 'Rename helper' }), DEFER);
  const state = { rounds: [{ n: 1, items: [deferred] }] };
  const { rows } = rulingsInventory(state);
  assert.equal(rows.length, 1);
  assert.match(rows[0], /^R1-S1 · FOLLOW-UP · SUGGESTION · maintainability · by owner deferral \(accepted by arbiter\) · content [0-9a-f]{12} · "Rename helper" · why: owner deferral of arbiter ACCEPT; NOT fixed in this merge; issue not filed yet$/);
  assert.match(reviewEligibilityProblems(state).join('\n'), /owner-deferred follow-up\(s\) without a filed issue: R1-S1 \(run followups create\)/);
  // a later round's cached copy: still gated (F6), listed once, and the issue clears both
  const copy = reuseRuled([item({ id: 'R2-S1', bucket: 'SUGGESTION', category: 'maintainability', fingerprint: deferred.fingerprint })], ruledCacheFrom([deferred]), { round: 2 })[0];
  const two = { rounds: [{ n: 1, items: [deferred] }, { n: 2, items: [copy] }] };
  assert.equal(rulingsInventory(two).count, 1, 'one deferral, not two');
  assert.match(reviewEligibilityProblems(two).join('\n'), /R1-S1, R2-S1/);
  const filed = { rounds: two.rounds.map((r) => ({ ...r, items: r.items.map((i) => ({ ...i, followupIssue: 'https://github.com/acme/widgets/issues/9' })) })) };
  assert.deepEqual(reviewEligibilityProblems(filed), []);
  assert.match(rulingsInventory(filed).rows[0], /issue #9$/);
  // an ordinary owner-ruled non-critical FOLLOW-UP is as before: no row, no gate
  const ordinary = applyOwnerRuling(waiting('low-confidence', { bucket: 'SUGGESTION' }), DEFER);
  assert.equal(rulingsInventory({ rounds: [{ items: [ordinary] }] }).count, 0);
  assert.deepEqual(reviewEligibilityProblems({ rounds: [{ items: [ordinary] }] }), []);
});

test('F7: the follow-up issue of an owner deferral says a fix was ACCEPTED and deferred by the owner (also for a cached copy); an ordinary owner follow-up reads as before', () => {
  const deferred = applyOwnerRuling(accepted('arbiter', { bucket: 'SUGGESTION', category: 'maintainability', file: 'src/b.js' }), DEFER);
  const body = issueBody(deferred, 7);
  assert.match(body, /\*\*Owner \(why this is a follow-up, not part of the PR\):\*\*/);
  assert.match(body, /The arbiter ACCEPTED a fix for this finding and the owner deferred it to this issue \(typed ruling\); it is NOT in PR #7/);
  const copy = { ...deferred, final: { ...deferred.final, by: 'cache' } };
  assert.match(issueBody(copy, 7), /\*\*Owner \(why/);
  assert.match(issueBody(copy, 7), /ACCEPTED a fix/);
  const ordinary = applyOwnerRuling(waiting('low-confidence', { bucket: 'SUGGESTION' }), DEFER);
  assert.doesNotMatch(issueBody(ordinary, 7), /ACCEPTED a fix/);
});
