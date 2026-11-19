// Round discipline 2, PR B1: the verifier half of the round dialog's variants (plan claude-notes/plans/2026-11-17-round-discipline-2-pr-b.md, REV 2). Nothing issues a new variant yet; these tests pin what the
// installed code UNDERSTANDS so that a later release may issue them: the fixed variant table, the ask-file schema (v1 legacy / v2 variant), the click that grants nothing ("Follow up"), the read-only
// followUpClickState, and the click records' variant. Every case names the production failure it catches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { claimGrantMarkers, grantIdOf, ownerGrantLookups, ownerGrantedRounds, verifyOwnerGrant } from '../pipeline/hooks/lib/owner-go.mjs';
import { CAPTURE_SKEW_MS, HUMAN_DECISION, ROUND_VARIANT_IDS, asksDir, clickNotes, clickProvenance, dialogSha256, followUpClickState, issueAsk, mergeAsk, mergeManyAsk, readAsk, roundAsk, rulingAsk, settlePendingClicks } from '../pipeline/hooks/lib/owner-go-click.mjs';
import { mergeRequest, roundRequest, rulingRequest } from './helpers/owner-go.mjs';
import { HEAD, ITEMS, REPO, world } from './helpers/click-world.mjs';
import { verifyOwnerGrants } from '../pipeline/lib/owner-grants.mjs';
import { STATE_VERSION_CLICK_DIALOG, SUPPORTED_STATE_VERSION, requiredStateVersion, withStateVersion } from '../pipeline/lib/state.mjs';
import { clickLine } from '../pipeline/hooks/lib/owner-go-click-hook.mjs';
import { issuedRoundVariant, roundDialogVariant } from '../pipeline/lib/round-ask.mjs';

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

// ---- 4 the click that grants nothing (Follow up) -------------------------------------------------------------------------------------------------

const FOLLOW = 'Follow up (Recommended)';
const followWorld = (t, over = {}) => world(t, { parts: parts('round-v2-follow-up'), answer: FOLLOW, ...over });
// 2.1.323 write order: the answer's entry is not in the transcript when the hook runs; `w.flush()` appends it, `w.settle()` verifies the pointer.
const pendingWorld = (t, over = {}) => {
  const w = followWorld(t, { build: '2.1.323', write: false, ...over });
  w.flush = () => appendFileSync(w.file, w.text([w.result]));
  w.settle = () => settlePendingClicks({ home: w.home, now: w.now });
  w.state = (over2 = {}) => followUpClickState({ repo: REPO, pr: 58, home: w.home, now: w.now, ...over2 });
  return w;
};
const files = (home) => readdirSync(asksDir(home)).sort();
const markerOf = (w) => JSON.parse(readFileSync(join(asksDir(w.home), `${w.askId}.spent`), 'utf8'));
const clickIdOf = (w) => sha(`${w.session}|${w.toolUseId}|${w.askId}`).slice(0, 16);

test('a verified click on Follow up is an instruction: only the spent marker is written (declined + instruction), no record, no grant; the same click again repeats it; a Yes on the spent ask is refused', async (t) => {
  // failure caught: the Follow-up click admitting a round or approving a merge, leaving the ask answerable (a later Yes granting after the owner chose to follow up), or being lost on a retry
  const w = followWorld(t);
  assert.deepEqual(await w.click(), { instruction: 'follow-up', kind: 'round', repo: REPO, prs: [58] });
  assert.deepEqual(files(w.home), [`${w.askId}.json`, `${w.askId}.spent`]);
  const m = markerOf(w);
  assert.deepEqual([m.declined, m.instruction, m.clickId], [true, 'follow-up', clickIdOf(w)]);
  assert.deepEqual(w.records(), []);
  assert.deepEqual(ownerGrantedRounds({ repo: REPO, pr: 58, k: 4, head: GHEAD, home: w.home, now: w.now }), []);
  assert.deepEqual(await w.click(), { instruction: 'follow-up', kind: 'round', repo: REPO, prs: [58], replay: true });
  assert.deepEqual(w.records(), [], 'a replay writes no record either');
  // another dialog call on the same ask, this time answering Yes: the ask is spent
  const [use2, result2] = structuredClone([w.use, w.result]);
  use2.uuid = 'u-second-use'; use2.message.content[0].id = 'toolu_second';
  result2.uuid = 'u-second-result'; result2.parentUuid = 'u-second-use'; result2.sourceToolAssistantUUID = 'u-second-use'; result2.message.content[0].tool_use_id = 'toolu_second';
  result2.toolUseResult.answers = { [w.dialog.question]: 'Yes, one more round' };
  appendFileSync(w.file, w.text([use2, result2]));
  assert.deepEqual(await w.click({}, { tool_use_id: 'toolu_second' }), { refused: 'spent' });
  assert.deepEqual(w.records(), []);
});

test('Follow-up click, stale or superseded: an answer after the 24 h window is expired and a newer ask supersedes it; neither writes anything', async (t) => {
  // failure caught: a Follow-up click on a dialog the owner could no longer be looking at (a day old, or replaced by a newer ask) still counting
  const old = followWorld(t, { issueBeforeUseMs: 25 * 3600 * 1000 });
  assert.deepEqual(await old.click(), { refused: 'expired' });
  assert.deepEqual(files(old.home), [`${old.askId}.json`]);
  const w = followWorld(t);
  assert.ok(issueAsk({ ...parts('round-v2-follow-up'), home: w.home, now: () => w.issuedAt + 1000 }).askId);
  assert.deepEqual(await w.click(), { refused: 'superseded' });
  assert.equal(files(w.home).some((n) => n.endsWith('.spent')), false);
});

test('fail-safe marker: a spent marker with no `instruction` for a Follow-up answer is `spent` (no record, no decline line); one whose answer is not that instruction is `spent`; an unknown instruction is `spent`', async (t) => {
  // failure caught: a marker written by a reader that did not know `instruction` (or tampered) being finished as a grant record or as a plain decline
  const w = followWorld(t);
  await w.click();
  const file = join(asksDir(w.home), `${w.askId}.spent`);
  const { instruction: _i, ...bare } = markerOf(w);
  writeFileSync(file, `${JSON.stringify(bare)}\n`);
  assert.deepEqual(await w.click(), { refused: 'spent' });
  assert.deepEqual(w.records(), []);
  writeFileSync(file, `${JSON.stringify({ ...bare, instruction: 'park' })}\n`);
  assert.deepEqual(await w.click(), { refused: 'spent' });
  // a marker that says follow-up for a click whose answer is the Yes label (the transcript shows Yes): not an instruction replay, and never a record
  const yes = world(t, { parts: parts('round-v2-follow-up'), answer: 'Yes, one more round' });
  writeFileSync(join(asksDir(yes.home), `${yes.askId}.spent`), `${JSON.stringify({ v: 1, askId: yes.askId, clickId: clickIdOf(yes), toolUseId: yes.toolUseId, answeredAt: new Date(yes.answeredAt).toISOString(), dialogSha256: yes.issued.questions[0] && dialogSha256(yes.dialog), declined: true, instruction: 'follow-up' })}\n`);
  assert.deepEqual(await yes.click(), { refused: 'spent' });
  assert.deepEqual(yes.records(), []);
});

test('a round record that points at a Follow-up click is not the owner (the click admits nothing, even with its marker edited to look like a grant)', async (t) => {
  // failure caught: a forged extra-round record made from a Follow-up click being consumed as a grant
  const w = followWorld(t);
  await w.click();
  const forgedRecord = {
    v: 1, kind: 'extra-round', ts: new Date(w.answeredAt).toISOString(), session: w.session, prompt: 'extra round', via: 'ask', repo: REPO, pr: 58, k: 4, head: GHEAD, transcript_path: w.file,
    ask: { askId: w.askId, toolUseId: w.toolUseId, clickId: clickIdOf(w), variant: 'round-v2-follow-up' },
  };
  assert.equal(clickProvenance(forgedRecord, { home: w.home }), 'synthetic', 'the marker says declined');
  writeFileSync(join(asksDir(w.home), `${w.askId}.spent`), `${JSON.stringify({ ...markerOf(w), declined: false })}\n`);
  assert.equal(clickProvenance(forgedRecord, { home: w.home }), 'synthetic', 'declined edited away: the answer still maps to an instruction');
});

test('pending Follow-up click (2.1.323): the pointer carries the variant, settles as `instructed` with no record, and a strict grant lookup stops refusing once it is settled', async (t) => {
  // failure caught: a Follow-up click left pending for ever (every strict lookup refusing), settled as a grant, or lost its variant (the hook could not tell the session what to do)
  const w = pendingWorld(t);
  const r = await w.click();
  assert.equal(r.pending?.variant, 'round-v2-follow-up', JSON.stringify(r));
  assert.deepEqual([r.pending.kind, r.pending.prs], ['round', [58]]);
  assert.throws(() => ownerGrantLookups({ repo: REPO, pr: 58, home: w.home, now: w.now }).grants(4), /not verified yet/, 'unverified while the entry is missing');
  w.flush();
  assert.deepEqual(w.settle().outcomes.map((o) => o.outcome), ['instructed']);
  assert.deepEqual(w.records(), []);
  const settled = JSON.parse(readFileSync(join(asksDir(w.home), `${w.askId}.${clickIdOf(w)}.settled`), 'utf8'));
  assert.equal(settled.outcome, 'instructed');
  assert.deepEqual(ownerGrantLookups({ repo: REPO, pr: 58, home: w.home, now: w.now }).grants(4), []);
  assert.match(clickNotes({ repo: REPO, prs: [58], home: w.home, now: w.now })[0], /was Follow up: it admits no round and approves no merge; do the follow-up steps.*not codex-review/);
  // a legacy ask's pending result carries no variant key
  const legacy = pendingWorld(t, { parts: parts('round-v1'), answer: 'Yes, one more round' });
  assert.equal(Object.hasOwn((await legacy.click()).pending, 'variant'), false);
});

// ---- 5 followUpClickState ------------------------------------------------------------------------------------------------------------------------

test('followUpClickState: every state of the newest round ask, read-only (instructed twice over, recorded, declined, waiting, refused, unverified, none, superseded, other variant, outside the window)', async (t) => {
  // failure caught: defer-fixes reading "no click" over a Follow-up click that was refused / unreadable / still pending, or an old click standing for a new dialog
  const none = followUpClickState({ repo: REPO, pr: 58, home: tmpHome(), now: () => 1 });
  assert.deepEqual([none.state, none.askId], ['none', null]);
  for (const bad of [{ repo: null }, { pr: 'x' }, { repo: undefined }]) assert.equal(followUpClickState({ repo: REPO, pr: 58, home: tmpHome(), ...bad }).state, 'none');

  const imm = followWorld(t); // immediate path: the spent marker says instructed
  assert.equal(followUpClickState({ repo: REPO, pr: 58, home: imm.home, now: imm.now }).state, 'none', 'issued, not answered');
  await imm.click();
  const st = followUpClickState({ repo: REPO, pr: 58, home: imm.home, now: imm.now });
  assert.deepEqual([st.state, st.askId], ['instructed', imm.askId]);
  assert.match(st.note, /grants no round and approves no merge/);
  const before = files(imm.home);
  followUpClickState({ repo: REPO, pr: 58, home: imm.home, now: imm.now });
  assert.deepEqual(files(imm.home), before, 'read-only');
  assert.equal(followUpClickState({ repo: REPO, pr: 58, home: imm.home, now: () => imm.answeredAt + 24 * 3600 * 1000 + CAPTURE_SKEW_MS + 1 }).state, 'none', 'outside the window');
  assert.equal(followUpClickState({ repo: 'other/repo', pr: 58, home: imm.home, now: imm.now }).state, 'none', 'another repository');
  assert.equal(followUpClickState({ repo: REPO, pr: 59, home: imm.home, now: imm.now }).state, 'none', 'another PR');
  // a newer ask supersedes it: the old click is ignored, the new ask has no click
  const next = issueAsk({ ...parts('round-v2-follow-up'), home: imm.home, now: () => imm.answeredAt + 5000 });
  assert.deepEqual(followUpClickState({ repo: REPO, pr: 58, home: imm.home, now: imm.now }), { state: 'none', askId: next.askId, note: followUpClickState({ repo: REPO, pr: 58, home: imm.home, now: imm.now }).note });
  // ... and a newer ask of another variant (or the legacy one) hides it too
  issueAsk({ ...parts('round-v2-extra-round'), home: imm.home, now: () => imm.answeredAt + 6000 });
  assert.equal(followUpClickState({ repo: REPO, pr: 58, home: imm.home, now: imm.now }).state, 'none', 'newest ask is another variant');

  const pend = pendingWorld(t); // pending path: waiting, then instructed through `.settled` alone (the spent marker removed)
  await pend.click();
  assert.equal(pend.state().state, 'waiting');
  pend.flush();
  pend.settle();
  assert.equal(pend.state().state, 'instructed');
  unlinkSync(join(asksDir(pend.home), `${pend.askId}.spent`));
  assert.equal(pend.state().state, 'instructed', 'the settled outcome stands on its own');

  const yes = pendingWorld(t, { answer: 'Yes, one more round' });
  await yes.click(); yes.flush(); yes.settle();
  assert.equal(yes.state().state, 'recorded');
  const no = pendingWorld(t, { answer: 'No' });
  await no.click(); no.flush(); no.settle();
  assert.equal(no.state().state, 'declined');

  // refused: the settled outcome's reason is carried, for each way a click fails verification
  const cases = {
    'not-a-human-answer': { mutate: ({ result }) => { result.permissionDecision = { ...HUMAN_DECISION, reasonCode: 'hook:PreToolUse' }; } },
    'capture-skew': { hookAt: 60000 }, // the hook ran a minute after the answer: the pointer's capture time and the answer disagree
    'too-fast': { mutate: ({ use, result }) => { result.timestamp = new Date(Date.parse(use.timestamp) + 500).toISOString(); } },
  };
  for (const [reason, over] of Object.entries(cases)) {
    const { hookAt, ...worldOver } = over;
    const w = pendingWorld(t, worldOver);
    const r = await w.click(hookAt === undefined ? {} : { now: () => w.answeredAt + hookAt });
    assert.ok(r.pending, `${reason}: ${JSON.stringify(r)}`);
    w.flush(); w.settle();
    const s = w.state();
    assert.deepEqual([s.state, s.reason], ['refused', reason]);
    assert.match(s.note, new RegExp(`could not be verified \\(${reason}\\)`));
  }

  // unverified: an unreadable spent marker, an unreadable pointer with no outcome, an unreadable outcome
  const bad = followWorld(t);
  await bad.click();
  writeFileSync(join(asksDir(bad.home), `${bad.askId}.spent`), 'not json');
  assert.equal(followUpClickState({ repo: REPO, pr: 58, home: bad.home, now: bad.now }).state, 'unverified');
  const ptr = pendingWorld(t);
  await ptr.click();
  const pointer = join(asksDir(ptr.home), `${ptr.askId}.${clickIdOf(ptr)}.pending`);
  writeFileSync(pointer, 'not json');
  assert.equal(ptr.state({ now: () => ptr.answeredAt + 1000 }).state, 'unverified');
  const out = pendingWorld(t);
  await out.click(); out.flush(); out.settle();
  unlinkSync(join(asksDir(out.home), `${out.askId}.spent`));
  writeFileSync(join(asksDir(out.home), `${out.askId}.${clickIdOf(out)}.settled`), '{"outcome":"made-up"}');
  assert.equal(out.state().state, 'unverified');
});

// ---- 6 the grant sees a v2 Yes click; 7 / 8 the state version and the askVariant cross-check ------------------------------------------------------------

test('a Yes click on any variant is a grant the defer-fixes / codex-review lookups see; the state it lands in is version 8 and its askVariant is cross-checked', async (t) => {
  // failure caught: a new-variant grant invisible to the grant lookups (a deferral would go past it), or a saved round whose grant an older pipeline would misread because the state kept its old version
  assert.equal(SUPPORTED_STATE_VERSION, 8);
  assert.equal(STATE_VERSION_CLICK_DIALOG, 8);
  for (const id of V2) {
    const w = world(t, { parts: parts(id), answer: YES[id] });
    const r = await w.click();
    const q = { repo: REPO, pr: 58, k: 4, head: GHEAD, home: w.home, now: w.now };
    assert.equal(ownerGrantedRounds(q).length, 1, `${id}: the grant is visible`);
    assert.equal(claimGrantMarkers(ownerGrantedRounds(q), { repo: REPO, pr: 58, k: 4, head: GHEAD, checkout: '/work/app' }, { home: w.home, now: w.now }).ok, true);
    const grant = { grantId: grantIdOf(r.recorded), k: 4, quote: 'extra round', ownerTs: r.recorded.ts };
    const round = (ownerGrant) => ({ n: 4, toHead: GHEAD, ...(ownerGrant ? { ownerGrant } : {}) });
    const state = (ownerGrant) => ({ maxRounds: 3, rounds: [{ n: 1, toHead: HEAD }, { n: 2, toHead: HEAD }, { n: 3, toHead: HEAD }, round(ownerGrant)] });
    const later = { repo: REPO, pr: 58, maxRounds: 3, home: w.home, now: () => w.answeredAt + 30 * 3600 * 1000 };
    const withVariant = state({ ...grant, askVariant: id });
    assert.equal(verifyOwnerGrants(withVariant, later).ok, true, id);
    assert.equal(requiredStateVersion(withVariant), 8, `${id}: the marker lifts the state to 8`);
    assert.equal(withStateVersion({ ...withVariant, version: 8 }, 3).version, 8, 'a writer never lowers it');
    for (const bad of [grant, { ...grant, askVariant: V2.find((x) => x !== id) }, { ...grant, askVariant: 7 }]) {
      const v = verifyOwnerGrants(state(bad), later);
      assert.equal(v.ok, false, `${id}: ${JSON.stringify(bad.askVariant)}`);
      assert.match(v.problems.join(' '), /its grant came from a click dialog variant the state does not record/);
    }
  }
  // a legacy click and a typed grant need no marker and keep their version
  const w = world(t, { parts: parts('round-v1'), answer: 'Yes, one more round' });
  const r = await w.click();
  claimGrantMarkers(ownerGrantedRounds({ repo: REPO, pr: 58, k: 4, head: GHEAD, home: w.home, now: w.now }), { repo: REPO, pr: 58, k: 4, head: GHEAD, checkout: '/work/app' }, { home: w.home, now: w.now });
  const legacy = { maxRounds: 3, rounds: [{ n: 1, toHead: HEAD }, { n: 2, toHead: HEAD }, { n: 3, toHead: HEAD }, { n: 4, toHead: GHEAD, ownerGrant: { grantId: grantIdOf(r.recorded), k: 4, quote: 'extra round' } }] };
  assert.equal(verifyOwnerGrants(legacy, { repo: REPO, pr: 58, maxRounds: 3, home: w.home, now: w.now }).ok, true);
  assert.equal(requiredStateVersion(legacy), 1);
});

// ---- 9 hook text, 10 the lever ---------------------------------------------------------------------------------------------------------------------

test('hook lines: a Follow-up instruction says it is no grant and names defer-fixes, its replay says not to redo steps; the pending line per variant carries the probe clause only for round-v2-follow-up', () => {
  // failure caught: a session told "recorded: run codex-review" for a Follow-up click (paying for a round the owner did not grant), or told to revert before the click was checked
  const line = clickLine({ instruction: 'follow-up', kind: 'round', repo: REPO, prs: [58] });
  assert.match(line, /follow up for acme\/app #58\. This is an instruction, not a grant: it admits no round and approves no merge.*P triage defer-fixes --pr 58 --ids/s);
  assert.doesNotMatch(line, /codex-review --pr/);
  assert.match(clickLine({ instruction: 'follow-up', kind: 'round', repo: REPO, prs: [58], replay: true }), /already received.*do not redo steps already done/);
  const pend = (variant) => clickLine({ pending: { askId: 'ask-000000000000', clickId: 'c', kind: 'round', repo: REPO, prs: [58], ...(variant ? { variant } : {}) } });
  assert.match(pend('round-v2-follow-up'), /FIRST run P triage defer-fixes once \(before reverting anything\).*followUpClick\.state is "instructed"/);
  assert.doesNotMatch(pend('round-v2-extra-round'), /defer-fixes/);
  assert.doesNotMatch(pend('round-v2-park'), /defer-fixes/);
  assert.match(pend('round-v2-park'), /No, stop and park \(Recommended\)/);
  assert.equal(pend(undefined), pend('round-v2-extra-round'), 'legacy and the extra-round variant keep today\'s wording');
});

test('roundDialogVariant and the lever: the first option follows the summary\'s recommendation (a blocking loop wins, no recommendation and no loop is legacy); only the exact value "legacy" narrows', () => {
  // failure caught: a dialog whose "(Recommended)" label disagrees with the summary's Recommended: line (e.g. a grant-first dialog after a display failure), or a lever that does not narrow / narrows on a near-miss
  const loop = { blockingLoop: true };
  const calm = { blockingLoop: false };
  assert.equal(roundDialogVariant('follow-up', calm), 'round-v2-follow-up');
  assert.equal(roundDialogVariant('follow-up', null), 'round-v2-follow-up');
  assert.equal(roundDialogVariant('extra-round', calm), 'round-v2-extra-round');
  assert.equal(roundDialogVariant('follow-up', loop), 'round-v2-park');
  assert.equal(roundDialogVariant('extra-round', loop), 'round-v2-park');
  assert.equal(roundDialogVariant(undefined, loop), 'round-v2-park', 'a display failure with a blocking loop still recommends stopping');
  assert.equal(roundDialogVariant(undefined, calm), 'round-v1');
  assert.equal(roundDialogVariant(undefined, null), 'round-v1', 'a display failure with no loop: the legacy dialog, no recommendation');
  assert.equal(roundDialogVariant('park', calm), 'round-v1', 'an unknown recommendation is no recommendation');
  assert.equal(issuedRoundVariant({ env: { PIPELINE_ROUND_DIALOG: 'legacy' }, recommend: 'follow-up', longReview: loop }), 'round-v1');
  for (const env of [{}, { PIPELINE_ROUND_DIALOG: 'LEGACY' }, { PIPELINE_ROUND_DIALOG: '1' }, { PIPELINE_ROUND_DIALOG: '' }, undefined]) assert.equal(issuedRoundVariant({ env, recommend: 'follow-up' }), 'round-v2-follow-up');
});

test('followUpClickState: an older unreadable ask with a click stays unverified until a newer follow-up ask of the PR has a verified click after it, then the newer click decides', async (t) => {
  // failure caught: a refused-and-corrupted first click leaves `triage defer-fixes` refusing for the whole window, although the owner was asked again and clicked Follow up (the refusal's own advice cannot work)
  for (const badSpent of [false, true]) {
    const w = followWorld(t);
    await w.click();
    writeFileSync(join(asksDir(w.home), `${w.askId}.json`), 'not json');
    if (badSpent) writeFileSync(join(asksDir(w.home), `${w.askId}.spent`), 'not json');
    assert.equal(followUpClickState({ repo: REPO, pr: 58, home: w.home, now: w.now }).state, 'unverified', `${badSpent}: no newer click yet`);
    const next = issueAsk({ ...parts('round-v2-follow-up'), home: w.home, now: () => w.answeredAt + 5000 });
    assert.equal(followUpClickState({ repo: REPO, pr: 58, home: w.home, now: w.now }).state, 'unverified', `${badSpent}: the newer ask has no click`);
    // a verified click on the newer ask that is not AFTER the unreadable ask's click (earlier, or equal in time) cannot stand in for it
    const marker = (ms) => writeFileSync(join(asksDir(w.home), `${next.askId}.spent`), `${JSON.stringify({ v: 1, askId: next.askId, clickId: 'c0ffee0000000000', toolUseId: 'toolu_next', dialogSha256: sha('next'), answeredAt: new Date(ms).toISOString(), declined: true, instruction: 'follow-up' })}\n`);
    const readState = () => followUpClickState({ repo: REPO, pr: 58, home: w.home, now: () => w.answeredAt + 5000 });
    for (const [label, ms] of [['earlier', w.answeredAt - 1000], ...(badSpent ? [] : [['equal', w.answeredAt]])]) {
      marker(ms);
      const old = readState();
      assert.deepEqual([old.state, old.askId], ['unverified', w.askId], `${badSpent}: a verified click ${label} (vs the unreadable ask's click) does not override it`);
    }
    const later = (badSpent ? Date.now() : w.answeredAt) + 60000; // a marker that cannot be read is dated by its mtime (real time)
    marker(later);
    const s = followUpClickState({ repo: REPO, pr: 58, home: w.home, now: () => later + 1000 });
    assert.deepEqual([s.state, s.askId], ['instructed', next.askId], `${badSpent}: the newer verified click wins`);
  }
});

test('followUpClickState: a follow-up click whose ask file became unreadable before settlement answers unverified, not none; an unreadable ask nobody clicked on, or one that plainly belongs to another kind or PR, stays out of it', async (t) => {
  // failure caught: settlement refuses the click as ask-invalid (which removes it from pendingClickProblems), the state check skips the unreadable ask and says `none`, and `triage defer-fixes` proceeds without a typed follow-up; or the reverse, every merge or other-PR ask the installed builders no longer reproduce (clicked yesterday) making `triage defer-fixes` refuse on every PR
  const w = pendingWorld(t);
  await w.click();
  writeFileSync(join(asksDir(w.home), `${w.askId}.json`), 'not json');
  w.settle();
  assert.equal(readFileSync(join(asksDir(w.home), `${w.askId}.${clickIdOf(w)}.settled`), 'utf8').includes('ask-invalid'), true, 'settled as refused: ask-invalid');
  const s = w.state();
  assert.deepEqual([s.state, s.askId], ['unverified', w.askId]);
  assert.equal(w.state({ pr: 59 }).state, 'unverified', 'an unreadable ask cannot be told to be another PR\'s with no readable prs: it counts');
  // outside the window the click no longer matters
  assert.equal(w.state({ now: () => w.answeredAt + 24 * 3600 * 1000 + CAPTURE_SKEW_MS + 60000 }).state, 'none');
  // the same for a spent marker that cannot be read (dated by its mtime), whether its ask is unreadable or readable: an expired one must not answer unverified for ever (it would refuse `triage defer-fixes` for good)
  for (const askReadable of [false, true]) {
    const b = followWorld(t);
    await b.click();
    if (!askReadable) writeFileSync(join(asksDir(b.home), `${b.askId}.json`), 'not json');
    const spentFile = join(asksDir(b.home), `${b.askId}.spent`);
    writeFileSync(spentFile, 'not json');
    const clickedAt = new Date(b.answeredAt);
    utimesSync(spentFile, clickedAt, clickedAt);
    const inside = followUpClickState({ repo: REPO, pr: 58, home: b.home, now: () => b.answeredAt + 3600 * 1000 });
    assert.equal(inside.state, 'unverified', `${askReadable}: inside the window the unreadable marker still counts`);
    const outside = followUpClickState({ repo: REPO, pr: 58, home: b.home, now: () => b.answeredAt + 24 * 3600 * 1000 + CAPTURE_SKEW_MS + 60000 });
    assert.equal(outside.state, 'none', `${askReadable}: outside the window an unreadable spent marker no longer matters`);
  }
  // an unreadable ask nobody clicked on is not a click
  const quiet = pendingWorld(t);
  writeFileSync(join(asksDir(quiet.home), `${quiet.askId}.json`), 'not json');
  assert.equal(quiet.state().state, 'none');
  // a clicked ask that is valid JSON but fails readAsk, and names another kind or another PR, is not a follow-up click for this PR
  for (const over of [{ kind: 'merge' }, { kind: 'round', prs: [59] }]) {
    const other = followWorld(t);
    await other.click();
    const file = join(asksDir(other.home), `${other.askId}.json`);
    writeFileSync(file, `${JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), ...over })}\n`);
    assert.equal(readAsk(other.askId, { home: other.home }).reason, 'invalid', JSON.stringify(over));
    assert.equal(followUpClickState({ repo: REPO, pr: 58, home: other.home, now: other.now }).state, 'none', `pr 58 is not blocked by an ask of ${JSON.stringify(over)}`);
  }
});
