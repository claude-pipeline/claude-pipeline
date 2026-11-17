// Round discipline 2, PR B1: the verifier half of the round dialog's variants (plan claude-notes/plans/2026-11-17-round-discipline-2-pr-b.md, REV 2). Nothing issues a new variant yet; these tests pin what the
// installed code UNDERSTANDS so that a later release may issue them: the fixed variant table, the ask-file schema (v1 legacy / v2 variant), the click that grants nothing ("Follow up"), the read-only
// followUpClickState, and the click records' variant. Every case names the production failure it catches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { claimGrantMarkers, grantIdOf, ownerGrantedRounds, verifyOwnerGrant } from '../pipeline/hooks/lib/owner-go.mjs';
import { ROUND_VARIANT_IDS, asksDir, clickProvenance, dialogSha256, issueAsk, mergeAsk, mergeManyAsk, readAsk, roundAsk, rulingAsk } from '../pipeline/hooks/lib/owner-go-click.mjs';
import { mergeRequest, roundRequest, rulingRequest } from './helpers/owner-go.mjs';
import { HEAD, ITEMS, REPO, world } from './helpers/click-world.mjs';

const GHEAD = 'abcdef0123456789abcdef0123456789abcdef01';
const LINE = roundRequest(58, 4, GHEAD, REPO);
const V2 = ROUND_VARIANT_IDS.filter((id) => id !== 'round-v1');
const parts = (variant) => roundAsk({ repo: REPO, pr: 58, line: LINE, variant });
const sha = (s) => createHash('sha256').update(s).digest('hex');
const tmpHome = () => mkdtempSync(join(tmpdir(), 'owner-go-click-variants-'));
const YES = { 'round-v1': 'Yes, one more round', 'round-v2-follow-up': 'Yes, one more round', 'round-v2-extra-round': 'Yes, one more round (Recommended)', 'round-v2-park': 'Yes, one more round' };

// ---- 1 the table ----------------------------------------------------------------------------------------------------------------------------

test('variant table: a v2 dialog shows its recommended choice FIRST with the suffix, has exactly one grant label and at most one instruction; the legacy dialog has no recommendation and no variant key', () => {
  // failure caught: a shipped variant whose first button is not the one the summary recommends, or two buttons that grant a round
  assert.deepEqual(ROUND_VARIANT_IDS, ['round-v1', 'round-v2-follow-up', 'round-v2-extra-round', 'round-v2-park']);
  for (const id of V2) {
    const p = parts(id);
    assert.equal(p.variant, id);
    assert.match(p.options[0].label, / \(Recommended\)$/, id);
    assert.equal(p.options.filter((o) => o.label.endsWith('(Recommended)')).length, 1, `${id}: one recommended label`);
    const acts = Object.values(p.actions);
    assert.equal(acts.filter((a) => typeof a === 'string').length, 1, `${id}: exactly one grant label`);
    assert.ok(acts.filter((a) => a !== null && typeof a === 'object').length <= 1, `${id}: at most one instruction`);
    assert.deepEqual(p.options.map((o) => o.label).sort(), Object.keys(p.actions).sort(), `${id}: every label has an action and no action lacks a label`);
  }
  const legacy = parts('round-v1');
  assert.equal(Object.hasOwn(legacy, 'variant'), false);
  assert.deepEqual(legacy.options.map((o) => o.label), ['No', 'Yes, one more round']);
  assert.deepEqual(parts(undefined), legacy, 'no variant = the legacy dialog');
  // Follow up only in the follow-up variant; the park variant has none (owner decision 4)
  assert.deepEqual(ROUND_VARIANT_IDS.filter((id) => parts(id).options.some((o) => /^Follow up/.test(o.label))), ['round-v2-follow-up']);
  assert.deepEqual(parts('round-v2-follow-up').actions['Follow up (Recommended)'], { instruction: 'follow-up' });
});

test('roundAsk: an unknown variant id (or a non-string) builds nothing, and the parts are a copy of the table', () => {
  // failure caught: an ask naming an id this install does not know being built as some default dialog
  for (const bad of ['round-v3', 'ROUND-V1', '', null, 1, {}, '__proto__', 'constructor']) assert.equal(roundAsk({ repo: REPO, pr: 58, line: LINE, variant: bad }), null, String(bad));
  const a = parts('round-v2-follow-up');
  a.actions['Follow up (Recommended)'].instruction = 'x';
  a.options[0].label = 'changed';
  assert.equal(parts('round-v2-follow-up').actions['Follow up (Recommended)'].instruction, 'follow-up', 'a caller cannot edit the shipped table through the parts');
  assert.equal(parts('round-v2-follow-up').options[0].label, 'Follow up (Recommended)');
});

// ---- 2 immutability ---------------------------------------------------------------------------------------------------------------------------

// sha256 of the variant's header, options (labels + descriptions) and action map. Shipped text never changes: a different text is a NEW id. (Regenerate only when adding an id, never for an existing one.)
const PINNED = {
  'round-v1': 'cd5470d033e8eb9e6a8685633b6d5e4ddf1ebfefe92786271300a3824548d678',
  'round-v2-follow-up': '61ab87edc7cb6cdf1077f6868ffb98a9f87a3056c22f9e54df9c161b5d79e20d',
  'round-v2-extra-round': '8219888dba1ac84da6e097b121c2c2add8ed2195aeff1667e0a5f4301a458bfb',
  'round-v2-park': '3c217adface77b46f45245433ae59a6b387789a459886a900944feb214e9747e',
};
test('the variants are immutable: a pinned sha256 per id (legacy included) fails when shipped text is edited, and no two ids build the same dialog', () => {
  // failure caught: a reworded label or description under an id that asks and grants already carry (the verifier would call every issued ask of that id invalid)
  const got = Object.fromEntries(ROUND_VARIANT_IDS.map((id) => { const p = parts(id); return [id, sha(JSON.stringify({ header: p.header, options: p.options, actions: p.actions }))]; }));
  assert.deepEqual(got, PINNED);
  assert.equal(new Set(Object.values(got)).size, ROUND_VARIANT_IDS.length);
  const dialogs = ROUND_VARIANT_IDS.map((id) => { const p = parts(id); return dialogSha256({ question: `${p.title} (ask-000000000000)\n\n${p.block}`, header: p.header, options: p.options }); });
  assert.equal(new Set(dialogs).size, ROUND_VARIANT_IDS.length, 'the canonical dialogs differ, so a dialog hash names one variant');
});

test('a legacy round ask, its click record and spent marker are byte-compatible with what the code before the variants wrote (v 1, no variant key anywhere) and still verify as the owner 30 h later', async (t) => {
  // failure caught: a legacy-only change to the ask / record shape that makes every ask and grant already issued fail after `pipeline update`
  const w = world(t, { parts: parts('round-v1'), answer: 'Yes, one more round' });
  const askFile = JSON.parse(readFileSync(join(asksDir(w.home), `${w.askId}.json`), 'utf8'));
  assert.deepEqual(Object.keys(askFile), ['v', 'askId', 'kind', 'repo', 'prs', 'dialog', 'dialogSha256', 'actions', 'issuedAt', 'hookLayersSha256']);
  assert.equal(askFile.v, 1);
  const r = await w.click();
  assert.equal(r.recorded?.kind, 'extra-round', JSON.stringify(r));
  assert.deepEqual(Object.keys(r.recorded.ask), ['askId', 'toolUseId', 'clickId']);
  const marker = JSON.parse(readFileSync(join(asksDir(w.home), `${w.askId}.spent`), 'utf8'));
  assert.deepEqual(Object.keys(marker), ['v', 'askId', 'clickId', 'toolUseId', 'answeredAt', 'dialogSha256', 'producerVersion', 'hookLayersSha256', 'session', 'declined']);
  assert.equal(marker.declined, false);
  const q = { repo: REPO, pr: 58, k: 4, head: GHEAD, home: w.home, now: w.now };
  assert.equal(claimGrantMarkers(ownerGrantedRounds(q), { repo: REPO, pr: 58, k: 4, head: GHEAD, checkout: '/work/app' }, { home: w.home, now: w.now }).ok, true);
  const later = { home: w.home, now: () => w.answeredAt + 30 * 3600 * 1000 };
  assert.equal(verifyOwnerGrant({ repo: REPO, pr: 58, k: 4, toHead: GHEAD, ownerGrant: { grantId: grantIdOf(r.recorded), quote: 'extra round', k: 4 } }, later).ok, true);
  assert.equal(clickProvenance(r.recorded, later), 'owner');
});

// ---- 3 tampered asks ---------------------------------------------------------------------------------------------------------------------------

const forged = (t, p, forge, answer) => world(t, { parts: p, forge, answer });
const invalid = (w) => readAsk(w.askId, { home: w.home });

test('ask schema: v 1 carries NO variant key (any value incl. null is invalid), v 2 names one of the three round-v2 ids on a round ask only', (t) => {
  // failure caught: an ask file whose version / variant combination a verifier would read as the legacy dialog (or as a variant it does not know)
  assert.equal(invalid(forged(t, parts('round-v1'), true)).ok, true, 'the plain legacy ask reads');
  for (const variant of [null, 'round-v1', 'round-v2-follow-up', 'x']) assert.equal(invalid(forged(t, parts('round-v1'), { v: 1, variant })).ok, false, `v 1 with variant ${JSON.stringify(variant)}`);
  for (const id of V2) assert.equal(invalid(forged(t, parts(id), { v: 2, variant: id })).ok, true, `v 2 ${id}`);
  for (const variant of ['round-v1', 'round-v3', null, 5]) assert.equal(invalid(forged(t, parts('round-v2-extra-round'), { v: 2, variant })).reason, 'invalid', `v 2 with ${JSON.stringify(variant)}`);
  assert.equal(invalid(forged(t, parts('round-v2-extra-round'), { v: 2, variant: undefined })).ok, false, 'v 2 without a variant');
  assert.equal(invalid(forged(t, parts('round-v2-extra-round'), { v: 3, variant: 'round-v2-extra-round' })).ok, false, 'an unknown version');
  // v 2 on the other kinds
  const others = [mergeAsk({ repo: REPO, pr: 58, closing: mergeRequest(58, HEAD, ITEMS, REPO) }), rulingAsk({ repo: REPO, pr: 58, ids: ['R1-B1'], line: rulingRequest(58, ['R1-B1'], REPO, 'c0ffee000000') })];
  for (const p of others) assert.equal(invalid(forged(t, p, { v: 2, variant: 'round-v2-follow-up' })).ok, false, `v 2 on a ${p.kind} ask`);
});

test('ask schema: the variant id cannot be paired with another variant\'s dialog or action map (a moved "(Recommended)", Follow up relabelled to a grant, the legacy dialog under a v2 id)', (t) => {
  // failure caught: the verifier trusting the file's own dialog / actions: a forged ask that makes a Follow-up button grant a round, or a decline button look recommended
  assert.equal(invalid(forged(t, parts('round-v2-follow-up'), { v: 2, variant: 'round-v2-extra-round' })).ok, false, 'follow-up dialog under the extra-round id');
  assert.equal(invalid(forged(t, parts('round-v2-extra-round'), { v: 2, variant: 'round-v2-follow-up' })).ok, false, 'extra-round dialog under the follow-up id');
  assert.equal(invalid(forged(t, parts('round-v1'), { v: 2, variant: 'round-v2-park' })).ok, false, 'legacy dialog under a v2 id');
  assert.equal(invalid(forged(t, parts('round-v2-follow-up'), { v: 1 })).ok, false, 'a v2 dialog as a legacy ask');
  const fu = parts('round-v2-follow-up');
  const asGrant = { ...fu, actions: { ...fu.actions, 'Follow up (Recommended)': 'extra round' } };
  assert.equal(invalid(forged(t, asGrant, { v: 2, variant: 'round-v2-follow-up' })).ok, false, 'the Follow up label mapped to extra round');
  const ex = parts('round-v2-extra-round');
  const moved = { ...ex, options: [{ ...ex.options[0], label: 'Yes, one more round' }, { ...ex.options[1], label: 'No (Recommended)' }], actions: { 'Yes, one more round': 'extra round', 'No (Recommended)': null } };
  assert.equal(invalid(forged(t, moved, { v: 2, variant: 'round-v2-extra-round' })).ok, false, '"(Recommended)" moved to the decline');
  const swapped = { ...ex, actions: { 'Yes, one more round (Recommended)': null, No: 'extra round' } };
  assert.equal(invalid(forged(t, swapped, { v: 2, variant: 'round-v2-extra-round' })).ok, false, 'grant and decline swapped');
});

test('issueAsk: a variant is written as v 2 (variant key after kind); a legacy ask is not; an instruction action on any kind but round, an unknown action value or a variant on a merge ask is never issued', (t) => {
  // failure caught: an issuer that writes a v 2 ask the verifier would refuse, or a Follow-up instruction on a merge / ruling dialog
  const home = tmpHome();
  const ok = issueAsk({ ...parts('round-v2-follow-up'), home, now: () => 1 });
  assert.ok(ok.askId, JSON.stringify(ok));
  const file = JSON.parse(readFileSync(join(asksDir(home), `${ok.askId}.json`), 'utf8'));
  assert.deepEqual([file.v, file.variant, Object.keys(file).slice(0, 4)], [2, 'round-v2-follow-up', ['v', 'askId', 'kind', 'variant']]);
  assert.equal(readAsk(ok.askId, { home }).ok, true);
  const merge = mergeAsk({ repo: REPO, pr: 58, closing: mergeRequest(58, HEAD, ITEMS, REPO) });
  assert.equal(issueAsk({ ...merge, actions: { 'Not yet': null, Merge: { instruction: 'follow-up' } }, home }).error, 'invalid-actions');
  assert.equal(issueAsk({ ...merge, variant: 'round-v2-follow-up', home }).error, 'invalid');
  assert.equal(issueAsk({ ...parts('round-v2-extra-round'), actions: { 'Yes, one more round (Recommended)': { instruction: 'other' }, No: null }, home }).error, 'invalid-actions');
  assert.equal(issueAsk({ ...parts('round-v2-extra-round'), actions: { 'Yes, one more round (Recommended)': 7, No: null }, home }).error, 'invalid-actions');
  assert.equal(issueAsk({ ...parts('round-v1'), variant: 'round-v1', home }).error, 'invalid', 'the legacy id is never written as a variant');
  assert.equal(issueAsk({ ...parts('round-v2-extra-round'), variant: 'round-v2-follow-up', home }).error, 'unknown-dialog', 'a variant id with another variant\'s dialog');
  assert.equal(issueAsk({ ...parts('round-v2-park'), variant: 'nope', home }).error, 'invalid');
  assert.deepEqual(readdirSync(asksDir(home)).filter((n) => n.endsWith('.json')), [`${ok.askId}.json`], 'nothing else was written');
  const legacy = issueAsk({ ...parts('round-v1'), home, now: () => 2 });
  assert.equal(JSON.parse(readFileSync(join(asksDir(home), `${legacy.askId}.json`), 'utf8')).v, 1);
  const merged = issueAsk({ ...mergeManyAsk({ repo: REPO, entries: [58, 59].map((pr) => ({ pr, lines: [`#${pr} head ${HEAD.slice(0, 12)} · items ${ITEMS} · repo ${REPO}`] })), ready: '🔀 Ready to merge #58, #59 — say "merge"' }), home });
  assert.ok(merged.askId, 'merge-many stays v 1');
});

test('a v2 Yes click is recorded with the variant on its record; the verifier takes the record only for the ask file\'s own variant', async (t) => {
  // failure caught: a grant record that does not say which dialog it came from (no way to tell, later, what the owner was shown), or one re-pointed at another dialog and still verified
  for (const id of V2) {
    const w = world(t, { parts: parts(id), answer: YES[id] });
    const r = await w.click();
    assert.equal(r.recorded?.kind, 'extra-round', `${id} ${JSON.stringify(r)}`);
    assert.equal(r.recorded.ask.variant, id);
    assert.equal(r.recorded.prompt, 'extra round');
    assert.equal(clickProvenance(r.recorded, { home: w.home }), 'owner', id);
    // the record names another variant, drops the key, or carries a null: not the owner
    for (const ask of [{ ...r.recorded.ask, variant: V2.find((x) => x !== id) }, { ...r.recorded.ask, variant: 'round-v1' }, { ...r.recorded.ask, variant: null }, (({ variant: _v, ...rest }) => rest)(r.recorded.ask)]) {
      assert.equal(clickProvenance({ ...r.recorded, ask }, { home: w.home }), 'synthetic', `${id}: ${JSON.stringify(ask.variant)}`);
    }
  }
});

test('"Other" text that is the label of ANOTHER variant\'s button binds nothing: a Follow-up label typed into the extra-round dialog records nothing and consumes nothing', async (t) => {
  // failure caught: typed words that look like a button of a variant this ask does not have being read as that button's action
  const w = world(t, { parts: parts('round-v2-extra-round'), answer: 'Follow up (Recommended)' });
  assert.deepEqual(await w.click(), { refused: 'nothing-bound' });
  assert.deepEqual(w.records(), []);
  assert.equal(readdirSync(asksDir(w.home)).includes(`${w.askId}.spent`), false, 'nothing consumed: the owner can answer again');
  const legacyYes = world(t, { parts: parts('round-v2-extra-round'), answer: 'No, stop and park (Recommended)' });
  assert.deepEqual(await legacyYes.click(), { refused: 'nothing-bound' });
});

test('a v2 ask whose transcript dialog was edited after issue is refused dialog-differs (the dialog hash names the variant)', async (t) => {
  // failure caught: a dialog shown to the owner that differs from the issued variant (a moved "(Recommended)") still being accepted on a label match
  const w = world(t, {
    parts: parts('round-v2-extra-round'), answer: 'Yes, one more round (Recommended)',
    tamper: (d) => { d.options[0].label = 'Yes, one more round'; d.options[1].label = 'No (Recommended)'; return d; },
  });
  assert.deepEqual(await w.click(), { refused: 'dialog-differs' });
  assert.deepEqual(w.records(), []);
});
