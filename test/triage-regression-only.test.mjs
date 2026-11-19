// #559 A2, the pure side: `scope: "same-on-base"` on a ruling or a Fable finding (review.regression_only_paths), the marker `final.sameOnBase`, the needsHuman waiver for a
// BLOCKING security FOLLOW-UP (only for a plain modification of a matched file, F4), the deterministic Rulings row + filing gate for EVERY arbiter dismissal on a matched file (F2),
// the inventory label and the owner-item rows (F3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyRulings, fableFindingItems, reviewEligibilityProblems, roundOutcome, rulingsBlock, rulingsDigest, rulingsInventory, sameOnBaseRows, validateRulings,
} from '../pipeline/lib/triage.mjs';
import { rulingsBlockDigest } from '../pipeline/hooks/lib/owner-go.mjs';

const GLOBS = ['pipeline/hooks/**', 'docs/**'];
const entry = (path, over = {}) => ({ path, oldPath: path, newPath: path, status: 'M', binary: false, added: [], removed: [], ...over });
const FILES = [entry('pipeline/hooks/a.mjs'), entry('src/outside.mjs'), entry('docs/x.md')];
const REGRESSION = { globs: GLOBS, files: FILES };

let seq = 0;
const item = (over = {}) => {
  seq += 1;
  return {
    id: `R1-B${seq}`, round: 1, bucket: 'BLOCKING', category: 'security', title: `finding ${seq}`, file: 'pipeline/hooks/a.mjs', line: 4,
    detail: 'd', codexReasoning: 'c', testable: false, fingerprint: `fp-${seq}`, judge: null, test: { status: 'none', evidence: '' },
    arbiter: null, final: null, implemented: false, followupIssue: null, ...over,
  };
};
const rule = (it, over = {}) => ({ id: it.id, ruling: 'FOLLOW-UP', confidence: 'high', reasoning: 'the same code is on the base', scope: 'same-on-base', ...over });
const apply = (items, rulings, opts = {}) => applyRulings(items, { rulings }, { proofOk: true, transcript: 't', regression: REGRESSION, ...opts });
const stateOf = (items) => ({ version: 1, repo: 'a/b', pr: 7, branch: 'x', risk: 'high', lightLane: false, maxRounds: 3, currentContentHash: 'h', rounds: [{ n: 1, toHead: 'h', contentHashAtToHead: 'h', items }] });
const parked = (out) => [out.final.needsHuman, out.final.cause];
const HUMAN = [true, 'security-dismissal'];

// ---- validation ------------------------------------------------------------------------------------------------------------------------------------

test('validateRulings: scope same-on-base is accepted with FOLLOW-UP only, on a ruling and on a Fable finding; another value is still refused naming both', () => {
  const ok = { rulings: [{ id: 'R1-B1', ruling: 'FOLLOW-UP', confidence: 'high', reasoning: 'r', scope: 'same-on-base' }] };
  assert.equal(validateRulings(ok, ['R1-B1']).ok, true);
  for (const ruling of ['REJECT', 'ACCEPT']) {
    const r = validateRulings({ rulings: [{ ...ok.rulings[0], ruling }] }, ['R1-B1']);
    assert.match(r.errors.join(';'), /R1-B1: scope is only allowed with ruling FOLLOW-UP/, ruling);
  }
  const bad = validateRulings({ rulings: [{ ...ok.rulings[0], scope: 'same-as-base' }] }, ['R1-B1']);
  assert.match(bad.errors.join(';'), /R1-B1: scope must be "out-of-model" or "same-on-base" when given/);
  const finding = { bucket: 'SUGGESTION', category: 'security', title: 't', file: 'a', line: 1, detail: 'd', ruling: 'FOLLOW-UP', confidence: 'high', reasoning: 'r', scope: 'same-on-base' };
  assert.equal(validateRulings({ rulings: [], findings: [finding] }, [], { review: true }).ok, true);
  assert.match(validateRulings({ rulings: [], findings: [{ ...finding, ruling: 'ACCEPT' }] }, [], { review: true }).errors.join(';'), /findings\[0\]\.scope is only allowed with ruling FOLLOW-UP/);
  assert.match(validateRulings({ rulings: [], findings: [{ ...finding, scope: 'nope' }] }, [], { review: true }).errors.join(';'), /findings\[0\]\.scope must be "out-of-model" or "same-on-base"/);
});

// ---- the waiver ------------------------------------------------------------------------------------------------------------------------------------

test('applyRulings: a BLOCKING security FOLLOW-UP with scope same-on-base on a matched, plainly modified file is final, marked with the glob, no human', () => {
  const it = item();
  const [out] = apply([it], [rule(it)]);
  assert.deepEqual(out.final, { decision: 'FOLLOW-UP', by: 'arbiter', needsHuman: false, reason: 'the same code is on the base', sameOnBase: 'pipeline/hooks/**', scope: 'same-on-base' });
});

test('applyRulings: no regression list, a file outside the globs, or no scope: the same ruling parks for a human as security-dismissal; there is no category restriction when the scope is given', () => {
  const it = item();
  for (const opts of [{ regression: null }, { regression: undefined }, { regression: { globs: [], files: FILES } }, { regression: { globs: GLOBS, files: null } }]) {
    const [out] = apply([it], [rule(it)], opts);
    assert.deepEqual(parked(out), HUMAN, JSON.stringify(opts));
    assert.equal(out.final.sameOnBase, undefined);
  }
  const elsewhere = item({ file: 'src/outside.mjs' });
  assert.deepEqual(parked(apply([elsewhere], [rule(elsewhere)])[0]), HUMAN);
  const noScope = item();
  assert.deepEqual(parked(apply([noScope], [rule(noScope, { scope: undefined })])[0]), HUMAN, 'without the explicit scope a dismissed BLOCKING security item still waits for a human');
  const outOfModelScope = item();
  assert.deepEqual(parked(apply([outOfModelScope], [rule(outOfModelScope, { scope: 'out-of-model' })])[0]), HUMAN, 'another scope does not waive on this ground');
  for (const category of ['auth', 'permissions', 'data-integrity', 'data-loss']) {
    const x = item({ category });
    assert.deepEqual([apply([x], [rule(x)])[0].final.needsHuman, apply([x], [rule(x)])[0].final.sameOnBase], [false, 'pipeline/hooks/**'], category);
  }
});

// F4: "same on base" compares the file with its merge-base version, which exists only for a plainly modified file. Failure caught: a file the PR adds or renames INTO a matched path
// (new code, or a move that hides what the base never held there) ruled "same as base" and merged without a human.
test('F4 applyRulings: an added file, a rename (into or inside the matched paths), a file under two entries, a binary or unclean path is never waived', () => {
  const cases = {
    'added file': [{ file: 'pipeline/hooks/new.mjs' }, [entry('pipeline/hooks/new.mjs', { oldPath: null, status: 'A' })]],
    'rename into a matched path': [{ file: 'pipeline/hooks/moved.mjs' }, [entry('pipeline/hooks/moved.mjs', { oldPath: 'src/old.mjs', newPath: 'pipeline/hooks/moved.mjs', status: 'R' })]],
    'rename inside the matched paths': [{ file: 'pipeline/hooks/new.mjs' }, [entry('pipeline/hooks/new.mjs', { oldPath: 'pipeline/hooks/old.mjs', newPath: 'pipeline/hooks/new.mjs', status: 'R' })]],
    'finding at the old name of a rename': [{ file: 'pipeline/hooks/old.mjs' }, [entry('pipeline/hooks/new.mjs', { oldPath: 'pipeline/hooks/old.mjs', newPath: 'pipeline/hooks/new.mjs', status: 'R' })]],
    'a file matching two entries': [{ file: 'pipeline/hooks/a.mjs' }, [...FILES, entry('pipeline/hooks/b.mjs', { oldPath: 'pipeline/hooks/a.mjs' })]],
    'file not in the diff': [{ file: 'pipeline/hooks/ghost.mjs' }, FILES],
    'binary entry': [{ file: 'pipeline/hooks/a.mjs' }, [entry('pipeline/hooks/a.mjs', { binary: true })]],
    // R1-B2: --text prints a binary file as text, so `binary` stays false; git's numstat verdict (`gitBinary`) and the entry kind decide
    'binary by git numstat (shown as text by --text)': [{ file: 'pipeline/hooks/a.mjs' }, [entry('pipeline/hooks/a.mjs', { gitBinary: true })]],
    'line the PR itself adds (R1-F1 backstop)': [{ file: 'pipeline/hooks/a.mjs', line: 4 }, [entry('pipeline/hooks/a.mjs', { added: [{ line: 4, text: 'x' }] })]],
    'symlink entry': [{ file: 'pipeline/hooks/a.mjs' }, [entry('pipeline/hooks/a.mjs', { symlink: true })]],
    'submodule entry': [{ file: 'pipeline/hooks/a.mjs' }, [entry('pipeline/hooks/a.mjs', { gitlink: true })]],
    'climbs out': [{ file: 'pipeline/hooks/../../etc/passwd' }, FILES],
    'absolute': [{ file: '/pipeline/hooks/a.mjs' }, FILES],
  };
  for (const [name, [over, files]] of Object.entries(cases)) {
    const it = item(over);
    const [out] = apply([it], [rule(it)], { regression: { globs: GLOBS, files } });
    assert.deepEqual(parked(out), HUMAN, name);
    assert.equal(out.final.sameOnBase, undefined, name);
  }
});

// R6-F1. Failure caught: a SUGGESTION (or a non-security BLOCKING) Codex item ruled FOLLOW-UP "same on base" on a file the PR adds, stored as same-on-base with no human.
test('R6-F1 applyRulings: a SUGGESTION or non-security BLOCKING FOLLOW-UP with the scope on an added file or a PR-added line parks for a human with no scope; a plain modification is unchanged', () => {
  const added = { globs: GLOBS, files: [entry('pipeline/hooks/new.mjs', { oldPath: null, status: 'A' }), entry('pipeline/hooks/a.mjs', { added: [{ line: 4, text: 'x' }] })] };
  for (const over of [{ bucket: 'SUGGESTION', file: 'pipeline/hooks/new.mjs' }, { bucket: 'BLOCKING', category: 'bug', file: 'pipeline/hooks/new.mjs' }, { bucket: 'SUGGESTION', category: 'design', file: 'pipeline/hooks/a.mjs', line: 4 }]) {
    const it = item(over);
    const [out] = apply([it], [rule(it)], { regression: added });
    assert.equal(out.final.needsHuman, true, JSON.stringify(over));
    assert.equal(out.final.scope, undefined, JSON.stringify(over));
  }
  const plain = item({ bucket: 'SUGGESTION' });
  assert.deepEqual([apply([plain], [rule(plain)])[0].final.needsHuman, apply([plain], [rule(plain)])[0].final.scope], [false, 'same-on-base']);
});

test('applyRulings: low confidence and an unproven answer still park for a human; a REJECT of a BLOCKING security item is never waived', () => {
  const low = item();
  assert.equal(apply([low], [rule(low, { confidence: 'low' })])[0].final.needsHuman, true);
  const unproven = item();
  const [u] = apply([unproven], [rule(unproven)], { proofOk: false });
  assert.deepEqual([u.final.needsHuman, u.final.cause, u.final.sameOnBase], [true, 'model-proof', undefined]);
  const rejected = item();
  assert.deepEqual(parked(apply([rejected], [rule(rejected, { ruling: 'REJECT', scope: undefined })])[0]), HUMAN);
});

// ---- F2: every arbiter dismissal on a matched file is marked, whatever its scope or bucket -----------------------------------------------------------------
// Failure caught: a SUGGESTION FOLLOW-UP the arbiter rules without the scope, on a file the owner wants watched, would be neither in the Rulings block nor held by the filing gate.

test('F2 applyRulings: a SUGGESTION FOLLOW-UP without scope on a matched file is marked, listed in the Rulings block and held by the filing gate; so is a REJECT (listed, no filing owed)', () => {
  const sug = item({ id: 'R1-S1', bucket: 'SUGGESTION', category: 'maintainability' });
  const rej = item({ id: 'R1-S2', bucket: 'WORTH_CONSIDERING', category: 'design' });
  const out = apply([sug, rej], [rule(sug, { scope: undefined }), rule(rej, { ruling: 'REJECT', scope: undefined })]);
  assert.deepEqual(out.map((i) => [i.final.decision, i.final.needsHuman, i.final.sameOnBase]), [['FOLLOW-UP', false, 'pipeline/hooks/**'], ['REJECT', false, 'pipeline/hooks/**']]);
  const s = stateOf(out);
  assert.deepEqual(rulingsInventory(s).rows.map((r) => r.split(' · ').slice(0, 5)), [
    ['R1-S1', 'FOLLOW-UP', 'SUGGESTION', 'maintainability', 'by arbiter (regression-only path)'],
    ['R1-S2', 'REJECT', 'WORTH_CONSIDERING', 'design', 'by arbiter (regression-only path)'],
  ]);
  assert.match(reviewEligibilityProblems(s).join(';'), /same-on-base follow-up\(s\) without a filed issue: R1-S1 \(run followups create\)/);
  assert.doesNotMatch(reviewEligibilityProblems(s).join(';'), /R1-S2/, 'a REJECT owes no issue');
  assert.deepEqual(reviewEligibilityProblems(stateOf([{ ...out[0], followupIssue: 'https://github.com/a/b/issues/9' }])), []);
});

test('F2 applyRulings: nothing is marked for an ACCEPT, a file outside the globs, a needs-human item or when the list is empty: an ordinary arbiter ruling is unchanged', () => {
  const acc = item({ bucket: 'SUGGESTION', category: 'design' });
  const other = item({ bucket: 'SUGGESTION', category: 'design', file: 'src/outside.mjs' });
  const plain = item({ bucket: 'SUGGESTION', category: 'design' });
  const low = item({ bucket: 'SUGGESTION', category: 'design' });
  const out = apply([acc, other, plain, low], [rule(acc, { ruling: 'ACCEPT', scope: undefined }), rule(other, { scope: undefined }), rule(plain, { scope: undefined }), rule(low, { scope: undefined, confidence: 'low' })],
    {});
  assert.deepEqual(out.map((i) => i.final.sameOnBase), [undefined, undefined, 'pipeline/hooks/**', undefined]);
  const [none] = apply([plain], [rule(plain, { scope: undefined })], { regression: null });
  assert.deepEqual(none.final, { decision: 'FOLLOW-UP', by: 'arbiter', needsHuman: false, reason: 'the same code is on the base' });
  assert.deepEqual(reviewEligibilityProblems(stateOf([none])), []);
});

test('the first glob (config order) that matches names the marker; the mark makes the item a Rulings row and moves the digest; the stored glob text can never add a column', () => {
  const it = item({ bucket: 'SUGGESTION', category: 'design' });
  const [a] = apply([it], [rule(it, { scope: undefined })], { regression: { globs: ['pipeline/**', ...GLOBS], files: FILES } });
  assert.equal(a.final.sameOnBase, 'pipeline/**');
  const [plain] = apply([it], [rule(it, { scope: undefined })], { regression: null });
  assert.equal(rulingsInventory(stateOf([plain])).count, 0, 'an ordinary non-critical arbiter FOLLOW-UP is not a Rulings row');
  assert.equal(rulingsInventory(stateOf([a])).count, 1, 'the marked one is');
  assert.notEqual(rulingsDigest(stateOf([a])), rulingsDigest(stateOf([plain])), 'the mark moves the digest the owner merge is bound to');
  assert.equal(rulingsInventory(stateOf([{ ...a, final: { ...a.final, sameOnBase: 'a · b\n"x"' } }])).rows[0].split(' · ').length, 8);
});

// ---- Fable's own findings ------------------------------------------------------------------------------------------------------------------------------

const finding = (over = {}) => ({
  bucket: 'BLOCKING', category: 'security', title: 'unchecked path', file: 'pipeline/hooks/a.mjs', line: 3, detail: 'd', ruling: 'FOLLOW-UP', confidence: 'high', reasoning: 'same on the base', scope: 'same-on-base', ...over,
});
const findingItems = (list, opts = {}) => fableFindingItems(list, 1, { regression: REGRESSION, ...opts });

test('fableFindingItems: a same-on-base BLOCKING security finding is final with the marker; without the list, scope, a matched file or a plain modification it is security-dismissal', () => {
  const [a] = findingItems([finding()]);
  assert.deepEqual(a.final, { decision: 'FOLLOW-UP', by: 'arbiter', needsHuman: false, reason: 'same on the base', sameOnBase: 'pipeline/hooks/**', scope: 'same-on-base' });
  assert.deepEqual(parked(findingItems([finding()], { regression: null })[0]), HUMAN);
  assert.deepEqual(parked(findingItems([finding({ scope: undefined })])[0]), HUMAN);
  assert.deepEqual(parked(findingItems([finding({ file: 'src/outside.mjs' })])[0]), HUMAN);
  const added = { globs: GLOBS, files: [entry('pipeline/hooks/a.mjs', { oldPath: null, status: 'A' })] };
  assert.deepEqual(parked(findingItems([finding()], { regression: added })[0]), HUMAN, 'F4: an added file');
  assert.deepEqual(parked(findingItems([finding({ confidence: 'low' })])[0]), [true, 'low-confidence'], 'low confidence stays human');
});

test('R6-F1 fableFindingItems: a SUGGESTION same-on-base finding on an added file or a PR-added line parks for a human with no scope', () => {
  const added = { globs: GLOBS, files: [entry('pipeline/hooks/a.mjs', { added: [{ line: 3, text: 'x' }] }), entry('pipeline/hooks/new.mjs', { oldPath: null, status: 'A' })] };
  for (const over of [{}, { file: 'pipeline/hooks/new.mjs' }]) {
    const [out] = findingItems([finding({ bucket: 'SUGGESTION', ...over })], { regression: added });
    assert.deepEqual([out.final.needsHuman, out.final.scope], [true, undefined], JSON.stringify(over));
  }
});

test('F2 fableFindingItems: a SUGGESTION FOLLOW-UP without scope on a matched file is marked (Rulings row + filing gate); an ACCEPT or another file is not', () => {
  const items = findingItems([finding({ bucket: 'SUGGESTION', category: 'design', scope: undefined }), finding({ bucket: 'SUGGESTION', category: 'design', scope: undefined, ruling: 'ACCEPT' }), finding({ bucket: 'SUGGESTION', category: 'design', scope: undefined, file: 'src/outside.mjs' })]);
  assert.deepEqual(items.map((i) => i.final.sameOnBase), ['pipeline/hooks/**', undefined, undefined]);
  assert.match(reviewEligibilityProblems(stateOf(items)).join(';'), /same-on-base follow-up\(s\) without a filed issue: R1-F1 /);
});

// ---- the merge gate --------------------------------------------------------------------------------------------------------------------------------------

test('F3 sameOnBaseRows: every marked dismissal is one owner row (waived or not, a REJECT too); an unmarked arbiter ruling and a legacy state add none; the Rulings block digest follows the mark', () => {
  const waived = item({ id: 'R1-B1' });
  const sug = item({ id: 'R1-S1', bucket: 'SUGGESTION', category: 'design' });
  const out = apply([waived, sug], [rule(waived), rule(sug, { scope: undefined })]);
  const s = stateOf(out);
  assert.deepEqual(sameOnBaseRows(s).map((r) => r.id), ['R1-B1', 'R1-S1']);
  assert.match(sameOnBaseRows(s)[1].row, /by arbiter \(regression-only path\)/, 'a ruling without the scope never claims a merge-base comparison (R1-F2)');
  assert.match(sameOnBaseRows(s)[0].row, /^R1-B1 · FOLLOW-UP · BLOCKING · security · by arbiter \(same as merge-base\) · content [0-9a-f]{12} · /);
  assert.deepEqual(sameOnBaseRows(stateOf([item({ id: 'R1-B9', final: { decision: 'FOLLOW-UP', by: 'arbiter', needsHuman: false, reason: 'x' } })])), []);
  assert.deepEqual(sameOnBaseRows(stateOf([])), []);
  const block = rulingsBlock(s);
  assert.match(block, /by arbiter \(same as merge-base\)/);
  const unmarked = stateOf(out.map((i) => { const { sameOnBase, ...final } = i.final; return { ...i, final: { ...final, outOfModel: 'guards' } }; }));
  assert.notEqual(rulingsBlockDigest(block), rulingsBlockDigest(rulingsBlock(unmarked)), 'a changed attribution is a different block: a prior "merge" no longer binds');
});

test('roundOutcome is untouched by the filing: reachedMax / extraRound / newAccepted do not move', () => {
  const it = item({ bucket: 'SUGGESTION', category: 'design' });
  const [marked] = apply([it], [rule(it, { scope: undefined })]);
  assert.deepEqual(roundOutcome(stateOf([marked])), roundOutcome(stateOf([{ ...marked, followupIssue: 'https://github.com/a/b/issues/9' }])));
});
