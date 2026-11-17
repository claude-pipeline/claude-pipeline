// #261 (click-to-approve, PR A): the owner's "merge", "extra round" and rulings as a click on a choice dialog (Claude Code's AskUserQuestion) instead of a typed prompt.
// Plan: claude-notes/plans/2026-11-11-click-to-approve.md, Rev 6 (B1-B4). What this file is: the issued ask (a one-time, expiring, supersedable note of the dialog the agent MAY show), the
// recorder that turns a verified click into the SAME record the typed path writes (owner-go.mjs: approval / ruling / extra-round, plus `via: 'ask'`), and the one verifier every consumer
// uses (clickProvenance, called by ownedBy where promptProvenance is for typed prompts).
//
// The trust argument, in one paragraph. A human click leaves a user entry in the session transcript whose permissionDecision is EXACTLY HUMAN_DECISION (decision accept, source user_temporary,
// grantScope once, reasonCode unknown: the whole object, no other key) and whose toolUseResult carries `annotations: {}`; an answer given by a hook (updatedInput / PermissionRequest), by the
// model's own `answers` input, or by a non-interactive run lacks that stamp (spikes s07, s08, s10 of 2026-11-11, test/fixtures/click). The stamp is the whole object, not decision + source,
// because a hook-filled answer could carry source user_temporary and annotations {} like a click, with only its reasonCode (hook:PreToolUse, a person's is unknown) telling them apart. On 2.1.323
// a dialog that comes with prefilled answers (the model's own `answers`, or a PreToolUse hook answering "ask" or returning only updatedInput) is not submitted by Claude Code: it waits for a
// person (the owner's 2026-11-16T13:42Z full run: open 56-59 s until the recording script cancelled it, an error result with no answer and no stamp). The whole-object check stays as defence in depth, and the
// model's own `answers` is refused by the tool-use shape check below. The transcript is the evidence, never the PostToolUse hook input (which the recorder only polls the transcript for: the entry lands 100-200 ms after the
// hook starts). Hooks that could still answer the dialog are the dialog-hook check's business (B5, hookCheck below, T2): this file takes it as an injected function.
// What binds is the question TEXT: it is the typed path's closing block, so the answer goes through the SAME parsers the typed prompt does (approvalBinding, roundBinding, rulingBinding in
// owner-go.mjs), and the ask file supplies only what a typed prompt cannot: one-time use, supersession, expiry, the dialog hash and the issue-time hook fingerprint.
// Write order (#472). On 2.1.322 the answer's entry is in the transcript within 100-200 ms of the PostToolUse hook starting, so recordClick finds it by polling and records at once. On 2.1.323 it is written
// only AFTER the PostToolUse hooks return, so every click fails `not-in-transcript` there. recordClick then keeps the click PENDING: it runs every check that needs no transcript and writes
// `asks/<askId>.<clickId>.pending`, a pointer that admits nothing. settlePendingClicks (called by the readers in owner-go.mjs, never by the read-only paths) verifies it later, through the same clickEvidence /
// admitClick core, writes the same spent marker and record plus a `.settled` outcome, and clickNotes tells a refusal what became of a click. The pointer's capture-time fields (the hook fingerprint,
// `capturedAt`) are taken on the hook's word: guard-files refuses tool writes to owner-go/** and refuses running this library by hand in its direct shapes (a path, program text, a program read from stdin). It is a
// guard, not a sole-writer guarantee.
// Residuals: (unchanged from the typed path, owner-go.mjs) keystrokes injected into the owner's terminal look human; and a hand-written script FILE that imports this library is not refused (the test runs are such files), so it can
// write a pointer with a made-up capture-time hook result. That skips only the dialog-hook check: everything else is re-derived from the protected transcript when the click is settled.
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readdirSync, readSync, writeSync } from 'node:fs';
import path from 'node:path';
import { isTranscriptFile } from '../../lib/paths.mjs';
import {
  MAX_AGE_MS, SESSION_RE, accountHome, appendRecord, approvalBinding, grantIdOf, markCoveredGrant, ownerGoDir, readGrantMarker, readRecords, realDirChain, repoKey, roundBinding, rulingBinding, rulingsIn, scanBackwards,
} from './owner-go.mjs';
import { readRepoMoves, sameRepo } from './repo-moves.mjs';

// The Claude Code builds whose click transcripts were recorded and checked. Each build needs its fixture set under test/fixtures/click/<build>/, recorded by scripts/click-spike.mjs (the tests
// run the whole matrix for every build listed here). Installed (protected) code, never pipeline.yml: a repo may switch clicks OFF, never widen this.
export const CLICK_BUILDS = Object.freeze(['2.1.322', '2.1.323']);
export const HUMAN_DECISION = Object.freeze({ decision: 'accept', source: 'user_temporary', grantScope: 'once', reasonCode: 'unknown' });
// owner-go.mjs <-> this file import each other (ownedBy calls clickProvenance), so nothing here may read an owner-go.mjs binding while the module loads: the literal is pinned to
// OWNER_GO_REL + '/asks' by a test.
export const ASKS_REL = '.claude/pipeline-state/owner-go/asks';
export const ASK_ID_RE = /^ask-[0-9a-f]{12}$/;
const ASK_ID_IN_LINE = /\bask-[0-9a-f]{12}\b/g;
export const MIN_ANSWER_MS = 2000; // F3: an answer sooner than this after the dialog opened is a keystroke typed ahead, not a reading owner
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const POLL_STEP_MS = 100;
const SMALL_FILE_BYTES = 64 * 1024;
const KINDS = Object.freeze(['merge', 'merge-many', 'round', 'ruling']);
const SCAN = { chunkBytes: 4 * 1024 * 1024, capBytes: 64 * 1024 * 1024 };
const OPEN_EXCL = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sortedJson = (v) => JSON.stringify(v, (_k, x) => (isObj(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));

// ---- the dialog -----------------------------------------------------------------------------------------------------------------------

const QUESTION_KEYS = new Set(['question', 'header', 'multiSelect', 'options']);
const OPTION_KEYS = new Set(['label', 'description']);
// The one canonical form of a dialog question: fixed key order question, header, multiSelect (boolean, false when absent), options [{ label, description }]. Null for anything else: an unknown key, an
// option with `preview` (S8: the preview is truncated on screen and copied into annotations, so it is never a binding surface) or a field of another type.
export function canonicalDialog(q) {
  if (!isObj(q) || !Object.keys(q).every((k) => QUESTION_KEYS.has(k))) return null;
  if (typeof q.question !== 'string' || q.question.trim() === '' || typeof q.header !== 'string') return null;
  const multiSelect = q.multiSelect === undefined ? false : q.multiSelect;
  if (typeof multiSelect !== 'boolean' || !Array.isArray(q.options) || q.options.length === 0) return null;
  const options = [];
  for (const o of q.options) {
    if (!isObj(o) || !Object.keys(o).every((k) => OPTION_KEYS.has(k)) || typeof o.label !== 'string' || o.label === '' || typeof o.description !== 'string') return null;
    options.push({ label: o.label, description: o.description });
  }
  return { question: q.question, header: q.header, multiSelect, options };
}
export const dialogSha256 = (q) => { const c = canonicalDialog(q); return c === null ? null : sha256(JSON.stringify(c)); };

// ---- the four dialogs (B1) ------------------------------------------------------------------------------------------------------------
// Each builder returns the parts issueAsk takes: { kind, repo, prs, header, title, block, options, actions }. `block` is the EXACT closing text the typed path binds (the merge dry run's
// ownerStep.closing, the round request's line, the ruling request's line). actions maps option label -> the answer text the typed parsers read; a decline maps to null.

export function mergeAsk({ repo, pr, closing }) {
  return {
    kind: 'merge', repo, prs: [pr], header: 'Merge', title: `Merge #${pr}?`, block: closing,
    options: [
      { label: 'Not yet', description: 'Do not merge now. Nothing is recorded; I will ask again when it is ready.' },
      { label: 'Merge', description: `Approve exactly what is shown above for #${pr}, the same as typing "merge".` },
    ],
    actions: { 'Not yet': null, Merge: 'merge' },
  };
}
// The round dialog's fixed variant set. Each variant is a frozen { options, actions } pair, immutable once shipped: a text change is a NEW id, never an edit (a test pins the sha256 of each). The ask
// file names its variant, the verifier REBUILDS the dialog from this table (never from the file's own words), and a variant it does not know is an invalid ask. `round-v1` is the legacy
// dialog, exactly as it always was (no recommendation); the `round-v2-*` ids put the recommended choice first, labelled "(Recommended)". An action is null (a decline), a string (the answer text the typed
// parsers read) or { instruction: 'follow-up' }: a click that grants and approves nothing (admitClick). Only round-v2-follow-up has a Follow up option (the park variant deliberately has none).
const NO_ROUND = { label: 'No', description: 'No more rounds now. Nothing is recorded.' };
const YES_ROUND = { label: 'Yes, one more round', description: 'Grant exactly the one extra counted round shown above, the same as typing "extra round".' };
const recommended = (o) => ({ label: `${o.label} (Recommended)`, description: o.description });
const ROUND_VARIANTS = Object.freeze({
  'round-v1': { options: [NO_ROUND, YES_ROUND], actions: { No: null, 'Yes, one more round': 'extra round' } },
  'round-v2-follow-up': {
    options: [
      { label: 'Follow up (Recommended)', description: 'Take the unreviewed fixes out and file them as follow-up issues. No review round is granted and nothing is merged.' },
      YES_ROUND, NO_ROUND,
    ],
    actions: { 'Follow up (Recommended)': { instruction: 'follow-up' }, 'Yes, one more round': 'extra round', No: null },
  },
  'round-v2-extra-round': { options: [recommended(YES_ROUND), NO_ROUND], actions: { 'Yes, one more round (Recommended)': 'extra round', No: null } },
  'round-v2-park': {
    options: [
      { label: 'No, stop and park (Recommended)', description: 'No more rounds now. Park the PR for a person to decide what stays open. Nothing is recorded.' },
      YES_ROUND,
    ],
    actions: { 'No, stop and park (Recommended)': null, 'Yes, one more round': 'extra round' },
  },
});
export const ROUND_VARIANT_IDS = Object.freeze(Object.keys(ROUND_VARIANTS));
export const ROUND_VARIANT_LEGACY = 'round-v1';
// The ids an ask file may name (never the legacy one: a legacy ask is `v: 1` with no `variant` key, its one canonical encoding).
const ROUND_V2_IDS = Object.freeze(ROUND_VARIANT_IDS.filter((id) => id !== ROUND_VARIANT_LEGACY));
// `variant` omitted = the legacy dialog; an id outside the table (or any non-string) -> null. The parts of a legacy dialog carry no `variant` key, so an ask built from them is byte-identical to today's.
export function roundAsk({ repo, pr, line, variant = ROUND_VARIANT_LEGACY }) {
  if (typeof variant !== 'string' || !Object.hasOwn(ROUND_VARIANTS, variant)) return null;
  const v = ROUND_VARIANTS[variant];
  return {
    kind: 'round', repo, prs: [pr], header: 'Extra round', title: `One more review round for #${pr}?`, block: line,
    ...structuredClone({ options: v.options, actions: v.actions }), // (a copy: nothing a caller does to the parts may reach the table)
    ...(variant === ROUND_VARIANT_LEGACY ? {} : { variant }),
  };
}
export function rulingAsk({ repo, pr, ids, line }) {
  const all = (word) => ids.map((id) => `${id}: ${word}`).join(', ');
  return {
    kind: 'ruling', repo, prs: [pr], header: 'Ruling', title: `Your ruling on #${pr}?`, block: line,
    options: [
      { label: 'Not now', description: 'Rule on nothing now. Nothing is recorded.' },
      { label: 'Accept all', description: `Accept every item asked (${ids.join(', ')}).` },
      { label: 'Follow-up all', description: `Move every item asked (${ids.join(', ')}) to a follow-up.` },
      { label: 'Reject all', description: `Reject every item asked (${ids.join(', ')}).` },
    ],
    actions: { 'Not now': null, 'Accept all': all('accept'), 'Follow-up all': all('follow-up'), 'Reject all': all('reject') },
  };
}
// merge-many (fold-in): `entries` = [{ pr, lines: [that PR's Areas / Head lines, '#N'-prefixed] }] for 2-4 PRs; `ready` = the ONE `🔀 Ready to merge #a, #b — say "merge"` line.
// multiSelect: the owner ticks the PRs to merge; there is no decline option (a dialog dismissed records nothing). Null when the count is out of range.
export function mergeManyAsk({ repo, entries, ready }) {
  if (!Array.isArray(entries) || entries.length < 2 || entries.length > 4) return null;
  return {
    kind: 'merge-many', repo, prs: entries.map((e) => e.pr), header: 'Merge', title: `Which of these ${entries.length} PRs should merge?`, block: `${entries.flatMap((e) => e.lines).join('\n')}\n${ready}`,
    options: entries.map((e) => ({ label: `Merge #${e.pr}`, description: `Approve exactly what is shown above for #${e.pr}.` })),
    actions: Object.fromEntries(entries.map((e) => [`Merge #${e.pr}`, `merge #${e.pr}`])),
    multiSelect: true,
  };
}

// (R1-F4, Rev 6 B1: the ask file never supplies binding fields.) The dialog an ask MUST show is a function of installed code: the kind, the PR(s) / item ids the question itself names, and the
// builders above. -> the parts a builder returns for this ask, or null when the ask's question is not a dialog one of them would build (an unknown title, a PR or ids the text does not carry).
function installedParts(ask) {
  const q = ask.dialog.question;
  const cut = q.indexOf('\n\n');
  if (cut < 0) return null;
  const suffix = ` (${ask.askId})`;
  const head = q.slice(0, cut);
  if (!head.endsWith(suffix)) return null;
  const title = head.slice(0, -suffix.length);
  const block = q.slice(cut + 2);
  const one = (re) => { const m = re.exec(title); return m ? Number(m[1]) : null; };
  if (ask.kind === 'merge') { const pr = one(/^Merge #(\d{1,6})\?$/); return pr === null ? null : mergeAsk({ repo: ask.repo, pr, closing: block }); }
  if (ask.kind === 'round') { const pr = one(/^One more review round for #(\d{1,6})\?$/); return pr === null ? null : roundAsk({ repo: ask.repo, pr, line: block, variant: ask.variant ?? ROUND_VARIANT_LEGACY }); }
  if (ask.kind === 'ruling') {
    const pr = one(/^Your ruling on #(\d{1,6})\?$/);
    const asked = pr === null ? null : rulingBinding('x', q);
    return asked === null || asked.pr !== pr ? null : rulingAsk({ repo: ask.repo, pr, ids: asked.ids, line: block });
  }
  const ready = /^🔀 Ready to merge (#\d{1,6}(?:, #\d{1,6}){1,3}) — say "merge"$/.exec(block.split('\n').at(-1));
  if (ready === null) return null;
  const entries = ready[1].split(', ').map((p) => ({ pr: Number(p.slice(1)), lines: [] }));
  const parts = mergeManyAsk({ repo: ask.repo, entries, ready: '' });
  return parts === null || title !== parts.title ? null : parts;
}
// True when the ask's dialog (header, multiSelect, options with their descriptions), its label -> answer map and its PRs are exactly what the installed builders make from its kind and question.
export function matchesInstalledDialog(ask) {
  try {
    const parts = installedParts(ask);
    if (parts === null || parts.kind !== ask.kind || (parts.variant ?? null) !== (ask.variant ?? null)) return false;
    const want = canonicalDialog({ question: ask.dialog.question, header: parts.header, multiSelect: parts.multiSelect ?? false, options: parts.options });
    return want !== null && sortedJson(want) === sortedJson(ask.dialog) && sortedJson(parts.actions) === sortedJson(ask.actions)
      && sortedJson([...parts.prs].sort((x, y) => x - y)) === sortedJson([...ask.prs].sort((x, y) => x - y));
  } catch {
    return false;
  }
}

// ---- files ----------------------------------------------------------------------------------------------------------------------------

export const asksDir = (home = accountHome()) => path.join(ownerGoDir(home), 'asks');
const askFile = (askId, ext, home) => (ASK_ID_RE.test(String(askId)) ? path.join(asksDir(home), `${askId}.${ext}`) : null);

// Exclusive create + fsync of `<file>`; 'ok' | 'exists' | 'error' (an error AFTER the file exists leaves it behind: the readers treat an unparseable marker as spent, fail closed).
function writeExclusive(file, body, home) {
  let fd;
  try { fd = openSync(file, OPEN_EXCL, 0o600); } catch (err) { return err?.code === 'EEXIST' ? 'exists' : 'error'; }
  try {
    writeSync(fd, `${JSON.stringify(body)}\n`);
    fsyncSync(fd);
  } catch {
    try { closeSync(fd); } catch { /* the file exists either way */ }
    return 'error';
  }
  try { closeSync(fd); } catch { return 'error'; }
  if (process.platform !== 'win32') {
    try {
      const dfd = openSync(asksDir(home), constants.O_RDONLY);
      try { fsyncSync(dfd); } finally { closeSync(dfd); }
    } catch { return 'error'; }
  }
  return 'ok';
}

// A small JSON file: { state: 'none' } (absent), { state: 'bad' } (present but not a plain regular file or not JSON), { state: 'ok', value }.
function readSmallJson(file) {
  if (file === null) return { state: 'bad' };
  try {
    if (!lstatSync(file).isFile()) return { state: 'bad' };
  } catch (err) {
    return { state: err?.code === 'ENOENT' ? 'none' : 'bad' };
  }
  try {
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.size > SMALL_FILE_BYTES) return { state: 'bad' };
      const buf = Buffer.alloc(st.size);
      readSync(fd, buf, 0, st.size, 0);
      return { state: 'ok', value: JSON.parse(buf.toString('utf8')) };
    } finally {
      closeSync(fd);
    }
  } catch {
    return { state: 'bad' };
  }
}
const marked = (askId, ext, home) => { const f = askFile(askId, ext, home); try { lstatSync(f); return true; } catch (err) { return err?.code !== 'ENOENT'; } }; // (any error but "absent" counts as present: fail closed)

// An ask file's version rule: `v: 1` with NO `variant` key (the legacy encoding; `variant: null` is invalid), or `v: 2` on a round ask naming one of the round-v2 ids.
const askVersionOk = (a) => isObj(a) && ((a.v === 1 && !Object.hasOwn(a, 'variant')) || (a.v === 2 && a.kind === 'round' && Object.hasOwn(a, 'variant') && ROUND_V2_IDS.includes(a.variant)));

// The issued ask on disk, validated (its dialog and answer map must be the installed builders' own, R1-F4): { ok: true, ask } | { ok: false, reason: 'none' | 'invalid' }.
export function readAsk(askId, { home = accountHome() } = {}) {
  const r = readSmallJson(askFile(askId, 'json', home));
  if (r.state === 'none') return { ok: false, reason: 'none' };
  const a = r.value;
  if (r.state !== 'ok' || !askVersionOk(a) || a.askId !== askId || !KINDS.includes(a.kind) || typeof a.repo !== 'string' || !Array.isArray(a.prs) || !isObj(a.actions) || !isObj(a.dialog)
    || typeof a.dialogSha256 !== 'string' || a.dialogSha256 !== dialogSha256(a.dialog) || typeof a.issuedAt !== 'string' || !Number.isFinite(Date.parse(a.issuedAt))
    || (a.hookLayersSha256 !== null && typeof a.hookLayersSha256 !== 'string') || !matchesInstalledDialog(a)) return { ok: false, reason: 'invalid' };
  return { ok: true, ask: a };
}

// The marker of a consumed ask: { state: 'none' } | { state: 'bad' } (spent, never trusted) | { state: 'ok', marker }.
function readSpent(askId, home) {
  const r = readSmallJson(askFile(askId, 'spent', home));
  if (r.state !== 'ok') return r;
  const m = r.value;
  return m?.v === 1 && m.askId === askId && typeof m.clickId === 'string' && typeof m.toolUseId === 'string' && typeof m.answeredAt === 'string' && typeof m.dialogSha256 === 'string'
    ? { state: 'ok', marker: m } : { state: 'bad' };
}

// ---- issuing --------------------------------------------------------------------------------------------------------------------------

// Writes `asks/<askId>.json` and returns { askId, questions: [dialog] } (the dialog the agent passes to AskUserQuestion VERBATIM), or { error } when the dialog could not bind or be written. The question
// text is `<title> (<askId>)` + blank line + `block`; before writing, the SAME binding cores the recorder uses are run on it with every option's answer, so an ask whose closing lines would bind
// nothing (or another PR / repository than `prs` / `repo`) is never issued. An older ask of the same kind, repository and PRs that is neither spent nor superseded is marked superseded.
export function issueAsk({ kind, repo, prs, header, title, block, options, actions, variant, multiSelect = kind === 'merge-many', hookLayersSha256 = null, home = accountHome(), now = Date.now } = {}) {
  try {
    const key = repoKey(repo);
    if (!KINDS.includes(kind) || key === null || !Array.isArray(prs) || prs.length === 0 || !prs.every(Number.isInteger) || typeof title !== 'string' || typeof block !== 'string' || !isObj(actions)) return { error: 'invalid' };
    if (variant !== undefined && (kind !== 'round' || !ROUND_V2_IDS.includes(variant))) return { error: 'invalid' };
    // an action is a decline (null), the answer text a typed parser reads (a string) or a follow-up instruction (round asks only)
    if (!Object.values(actions).every((a) => a === null || typeof a === 'string' || (kind === 'round' && isInstruction(a)))) return { error: 'invalid-actions' };
    const labels = (options ?? []).map((o) => o?.label);
    if (labels.length === 0 || new Set(labels).size !== labels.length || !Object.keys(actions).every((l) => labels.includes(l)) || !labels.every((l) => Object.hasOwn(actions, l))) return { error: 'invalid-options' };
    if (!realDirChain(home, ASKS_REL)) return { error: 'unsafe-folder' };
    let askId = null;
    for (let i = 0; i < 5 && askId === null; i++) {
      const id = `ask-${randomBytes(6).toString('hex')}`;
      if (!marked(id, 'json', home)) askId = id;
    }
    if (askId === null) return { error: 'no-id' };
    const dialog = canonicalDialog({ question: `${title} (${askId})\n\n${block}`, header: header ?? 'Merge', multiSelect, options });
    if (dialog === null) return { error: 'invalid-dialog' };
    const ask = { v: variant === undefined ? 1 : 2, askId, kind, ...(variant === undefined ? {} : { variant }), repo: key, prs: [...prs], dialog, dialogSha256: dialogSha256(dialog), actions, issuedAt: new Date(now()).toISOString(), hookLayersSha256 };
    // every approving answer must bind exactly this repository and these PRs, or the ask is useless (a typo in the block, a closing line of another PR)
    for (const label of labels) {
      if (actions[label] === null || isInstruction(actions[label])) continue; // (a decline and an instruction bind nothing: neither can reach a record)
      const bound = bindAnswer(ask, actions[label], dialog.question);
      if (bound.error) return { error: `unbindable: ${bound.error}` };
    }
    if (!matchesInstalledDialog(ask)) return { error: 'unknown-dialog' }; // (R1-F4: readers refuse an ask the installed builders would not make, so never write one)
    const file = askFile(askId, 'json', home);
    if (writeExclusive(file, ask, home) !== 'ok') return { error: 'write-failed' };
    supersedeOlder(ask, home);
    return { askId, questions: [dialog] };
  } catch {
    return { error: 'failed' };
  }
}

const isInstruction = (a) => isObj(a) && Object.keys(a).length === 1 && a.instruction === 'follow-up';

// An older ask of the same kind + repository + PRs that is still answerable no longer is (a fresh dry run's ask replaces the one before it).
function supersedeOlder(ask, home) {
  let names = [];
  try { names = readdirSync(asksDir(home)).filter((n) => /^ask-[0-9a-f]{12}\.json$/.test(n)); } catch { return; }
  for (const n of names) {
    const id = n.slice(0, -5);
    if (id === ask.askId) continue;
    const old = readAsk(id, { home });
    if (!old.ok || old.ask.kind !== ask.kind || old.ask.repo !== ask.repo || sortedJson([...old.ask.prs].sort()) !== sortedJson([...ask.prs].sort())) continue;
    if (Date.parse(old.ask.issuedAt) > Date.parse(ask.issuedAt) || marked(id, 'spent', home) || marked(id, 'superseded', home)) continue;
    writeExclusive(askFile(id, 'superseded', home), { v: 1, askId: id, supersededBy: ask.askId }, home);
  }
}

// ---- answer -> binding (B1): the same cores as the typed path ---------------------------------------------------------------------------

// What the chosen answer says, per the ask's action map: { declined: label } | { instruction, label } | { text } | { error }. An exact label maps by `actions`; several labels (multiSelect) joined by ', ' must each
// be an exact label; any other text (the dialog's "Other") is the owner's own words and goes through the strict parser as typed.
function answerText(ask, raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return { error: 'empty-answer' };
  if (ask.dialog.multiSelect) {
    const pieces = raw.split(', ');
    if (new Set(pieces).size !== pieces.length || !pieces.every((p) => Object.hasOwn(ask.actions, p))) return { error: 'answer-not-a-label' };
    const texts = pieces.map((p) => ask.actions[p]);
    if (texts.some((t) => typeof t !== 'string' || !/^merge #\d{1,6}$/.test(t))) return { error: 'answer-not-a-label' };
    return { text: `merge ${texts.map((t) => t.slice(6)).join(' ')}` };
  }
  if (Object.hasOwn(ask.actions, raw)) {
    const act = ask.actions[raw];
    return act === null ? { declined: raw } : isInstruction(act) ? { instruction: act.instruction, label: raw } : { text: act };
  }
  return { text: raw }; // (also the label of ANOTHER variant's button typed into "Other": it is the owner's own words and dies in bindAnswer)
}

// The record body (without the click fields) a text answers a question with, using the typed recorders' cores: { kind, body } | { error }. `kind` is the record kind ('approval' has none on disk).
function bindAnswer(ask, text, question) {
  if (ask.kind === 'merge' || ask.kind === 'merge-many') {
    const b = approvalBinding(text, question);
    if (b === null || b.requests.length === 0) return { error: 'nothing-bound' };
    const want = [...ask.prs].sort((x, y) => x - y);
    const got = [...new Set(b.requests.map((r) => r.pr))].sort((x, y) => x - y);
    if (ask.kind === 'merge' && (sortedJson(got) !== sortedJson(want) || b.requests.some((r) => r.repo !== ask.repo))) return { error: 'other-pr-or-repo' };
    if (ask.kind === 'merge-many' && (got.length === 0 || !got.every((p) => want.includes(p)) || b.requests.some((r) => r.repo !== ask.repo))) return { error: 'other-pr-or-repo' };
    return { body: { prs: b.prs, requests: b.requests } };
  }
  if (ask.kind === 'round') {
    const b = roundBinding(text, question);
    if (b === null) return { error: 'nothing-bound' };
    if (b.repo !== ask.repo || sortedJson([b.pr]) !== sortedJson(ask.prs)) return { error: 'other-pr-or-repo' };
    return { body: { kind: 'extra-round', repo: b.repo, pr: b.pr, k: b.k, head: b.head } };
  }
  const b = rulingBinding(text, question);
  if (b === null) return { error: 'nothing-bound' };
  if (b.repo !== ask.repo || sortedJson([b.pr]) !== sortedJson(ask.prs)) return { error: 'other-pr-or-repo' };
  if (rulingsIn(text, b.ids).size === 0) return { error: 'no-decision' }; // (the typed recorder keeps any words; a click that decides nothing is not worth a record)
  return { body: { kind: 'ruling', repo: b.repo, pr: b.pr, ids: b.ids, content: b.content } };
}

// The record a click writes: the typed record's shape, `ts` = the answer's own time (C3), `via: 'ask'` and the click's identity.
function clickRecordOf({ body, session, text, cwd, transcriptPath, answeredAt, ask }) {
  const { kind, ...rest } = body;
  const prompt_sha256 = sha256(text);
  return {
    v: 1, ...(kind ? { kind } : {}), ts: new Date(Date.parse(answeredAt)).toISOString(), session, prompt_sha256, cwd,
    prompt_id: null, transcript_path: transcriptPath, prompt: text, via: 'ask', ask, ...rest,
  };
}
// The record's pointer to its click. `variant` only when the ask is not the legacy dialog: a legacy click's record is byte-identical to what the code before the variants wrote.
const askRefOf = (ask, toolUseId, clickId) => ({ askId: ask.askId, toolUseId, clickId, ...(ask.variant === undefined ? {} : { variant: ask.variant }) });
const clickIdOf = (session, toolUseId, askId) => sha256(`${session}|${toolUseId}|${askId}`).slice(0, 16);

// ---- the transcript evidence (B3 entry checks) --------------------------------------------------------------------------------------------

// The whole permissionDecision, key for key and value for value (an extra or missing key, another grantScope or reasonCode is not a person's click).
const isHumanDecision = (pd) => isObj(pd) && Object.keys(pd).length === Object.keys(HUMAN_DECISION).length && Object.entries(HUMAN_DECISION).every(([k, v]) => Object.hasOwn(pd, k) && pd[k] === v);
const blocksOf = (e) => (Array.isArray(e?.message?.content) ? e.message.content : []);
const isoMs = (s) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(s) ? Date.parse(s) : NaN);

// Finds the AskUserQuestion tool_use entry and its tool_result entry by id in `transcriptPath` and runs every check on them that needs no clock, ask or hook configuration (the build allowlist,
// supersession and the hook check are the recorder's). { ok: true, use, result, question, answer, answeredAt, useAt, version, session, dialogSha256 } or { ok: false, reason }. 'not-in-transcript'
// means an entry is not (yet) there: the recorder polls on that reason only.
export function clickEvidence(transcriptPath, toolUseId, { home = accountHome() } = {}) {
  try {
    if (typeof transcriptPath !== 'string' || !path.isAbsolute(transcriptPath) || /(?:^|[\\/])subagents[\\/]/.test(transcriptPath) || !isTranscriptFile(transcriptPath, { home })) return { ok: false, reason: 'transcript-not-protected' };
    if (typeof toolUseId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(toolUseId)) return { ok: false, reason: 'bad-tool-use-id' };
    const uses = [];
    const results = [];
    const scan = scanBackwards(transcriptPath, (e) => {
      if (e?.type === 'assistant' && blocksOf(e).some((b) => b?.type === 'tool_use' && b.id === toolUseId)) uses.push(e);
      else if (e?.type === 'user' && blocksOf(e).some((b) => b?.type === 'tool_result' && b.tool_use_id === toolUseId)) results.push(e);
      return false;
    }, (line) => line.includes(toolUseId), SCAN);
    if (scan === null) return { ok: false, reason: 'transcript-unreadable' };
    if (uses.length > 1 || results.length > 1) return { ok: false, reason: 'ambiguous' };
    if (uses.length === 0 || results.length === 0) return { ok: false, reason: 'not-in-transcript' };
    const [use] = uses;
    const [result] = results;
    const block = blocksOf(use).find((b) => b?.type === 'tool_use' && b.id === toolUseId);
    if (block.name !== 'AskUserQuestion' || !isObj(block.input) || !Object.keys(block.input).every((k) => k === 'questions' || k === 'metadata') || !Array.isArray(block.input.questions) || block.input.questions.length !== 1) return { ok: false, reason: 'tool-use-shape' };
    const dialog = canonicalDialog(block.input.questions[0]);
    if (dialog === null) return { ok: false, reason: 'dialog-not-canonical' }; // (also: an option `preview`)
    const content = blocksOf(result);
    const res = result.toolUseResult;
    const pd = result.permissionDecision;
    if (content.length !== 1 || content[0]?.type !== 'tool_result' || content[0].tool_use_id !== toolUseId || content[0].is_error === true || result.message?.content?.length !== 1) return { ok: false, reason: 'tool-result-shape' };
    if (typeof use.uuid !== 'string' || use.uuid === '' || result.sourceToolAssistantUUID !== use.uuid || result.parentUuid !== use.uuid) return { ok: false, reason: 'chain' };
    if (use.isSidechain !== false || result.isSidechain !== false) return { ok: false, reason: 'sidechain' };
    if (!isHumanDecision(pd)) return { ok: false, reason: 'not-a-human-answer' };
    if (!isObj(res) || !Array.isArray(res.questions) || res.questions.length !== 1 || sortedJson(canonicalDialog(res.questions[0])) !== sortedJson(dialog)) return { ok: false, reason: 'result-dialog-differs' };
    if (!isObj(res.answers) || Object.keys(res.answers).length !== 1 || !Object.hasOwn(res.answers, dialog.question) || typeof res.answers[dialog.question] !== 'string') return { ok: false, reason: 'answers-shape' };
    if (!isObj(res.annotations) || Object.keys(res.annotations).length !== 0) return { ok: false, reason: 'annotations' };
    if (typeof use.sessionId !== 'string' || use.sessionId !== result.sessionId || !SESSION_RE.test(use.sessionId)) return { ok: false, reason: 'session' };
    if (use.entrypoint !== 'cli' || result.entrypoint !== 'cli') return { ok: false, reason: 'entrypoint' };
    if (typeof use.version !== 'string' || use.version === '' || use.version !== result.version) return { ok: false, reason: 'version' };
    const useAt = isoMs(use.timestamp);
    const answeredAt = isoMs(result.timestamp);
    if (!Number.isFinite(useAt) || !Number.isFinite(answeredAt)) return { ok: false, reason: 'timestamp' };
    if (answeredAt - useAt < MIN_ANSWER_MS) return { ok: false, reason: 'too-fast' };
    return { ok: true, use, result, question: dialog.question, answer: res.answers[dialog.question], answeredAt: result.timestamp, useAt: use.timestamp, version: use.version, session: use.sessionId, dialogSha256: sha256(JSON.stringify(dialog)) };
  } catch {
    return { ok: false, reason: 'transcript-unreadable' };
  }
}

// ---- the recorder (PostToolUse) ---------------------------------------------------------------------------------------------------------

// The dialog-hook check (B5, T2) is injected: ({ home, input }) -> { ok, hookLayersSha256, reason }. Until it is supplied nothing is admitted.
const UNCHECKED = () => ({ ok: false, reason: 'dialog-hooks-unchecked' });
const realSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// A PostToolUse hook input for AskUserQuestion -> the record the click makes. Returns { recorded: record, kind, replay? } | { declined: label, replay? } | { instruction, kind, repo, prs, replay? } (a click on an instruction label: it grants and approves nothing) | { pending: { askId, clickId, kind, repo, prs, variant?, quotes? } }
// | { refused: reason } | null (not ours: not AskUserQuestion, a subagent, no session, no ask id in the question's first line, an ask this machine never issued). Never throws. Async: on 2.1.322 the
// transcript entry lands 100-200 ms after the hook starts (spike S6), so the evidence is polled for up to `pollMs` (500 ms) in 100 ms steps (`sleep` is injectable). On 2.1.323 it lands only after the
// hooks have returned (#472): an entry still missing after the poll leaves the click PENDING (captureClick), verified when a consumer reads.
export async function recordClick(input, { home = accountHome(), now = Date.now, sleep = realSleep, pollMs = 500, hookCheck = UNCHECKED } = {}) {
  try {
    if (input?.tool_name !== 'AskUserQuestion' || (input.hook_event_name !== undefined && input.hook_event_name !== 'PostToolUse')) return null;
    if (input.agent_id !== undefined && input.agent_id !== null && input.agent_id !== '') return null;
    const transcriptPath = String(input.transcript_path ?? '');
    const session = String(input.session_id ?? '');
    if (!SESSION_RE.test(session) || /(?:^|[\\/])subagents[\\/]/.test(transcriptPath.replaceAll('\\', '/'))) return null;
    const asked = input.tool_input?.questions?.[0]?.question;
    const ids = typeof asked === 'string' ? [...new Set(asked.split('\n')[0].match(ASK_ID_IN_LINE) ?? [])] : [];
    if (ids.length === 0) return null;
    if (ids.length > 1) return { refused: 'ambiguous-ask-id' };
    const [askId] = ids;
    const loaded = readAsk(askId, { home });
    if (!loaded.ok) return loaded.reason === 'none' ? null : { refused: 'ask-invalid' };
    const { ask } = loaded;
    const toolUseId = input.tool_use_id;
    if (typeof toolUseId !== 'string') return { refused: 'no-tool-use-id' };

    let ev = clickEvidence(transcriptPath, toolUseId, { home });
    for (let waited = 0; !ev.ok && ev.reason === 'not-in-transcript' && waited < pollMs; waited += POLL_STEP_MS) {
      await sleep(POLL_STEP_MS);
      ev = clickEvidence(transcriptPath, toolUseId, { home });
    }
    const cwd = typeof input.cwd === 'string' ? input.cwd : null;
    // #472: the entry is not there yet (2.1.323 writes the answer's tool_result only AFTER the PostToolUse hooks return): keep the click as a pending pointer, verified later.
    if (!ev.ok && ev.reason === 'not-in-transcript') return await captureClick({ input, ask, askId, session, toolUseId, transcriptPath, cwd, home, now, hookCheck });
    if (!ev.ok) return { refused: ev.reason };
    const bad = evidenceRefusal({ ask, ev, session, now });
    if (bad !== null) return { refused: bad };

    // the dialog-hook check only runs when it can matter: a replay (the marker exists) and a superseded ask never need it, as before
    const spent = readSpent(askId, home);
    if (spent.state === 'bad') return { refused: 'spent' };
    const hc = spent.state === 'none' && !supersededBefore(askId, Date.parse(ev.answeredAt), { home }) ? await hookCheck({ home, input }) : null;
    const { retry: _retry, ...out } = admitClick({ ask, ev, session, toolUseId, transcriptPath, cwd, hc, home });
    return out;
  } catch {
    return null;
  }
}

// Why (#472): the checks on a verified transcript entry that both recorders share, the immediate one above and the deferred one (settlePendingClicks): the session, the dialog, the build allowlist, the
// ask's own window (answered after it was issued and within MAX_AGE_MS of it) and a future-dated answer. They need no marker and no hook result, so they run first, in this order. -> the refusal reason, or null.
function evidenceRefusal({ ask, ev, session, now }) {
  if (ev.session !== session) return 'session';
  if (ev.dialogSha256 !== ask.dialogSha256) return 'dialog-differs';
  if (!CLICK_BUILDS.includes(ev.version)) return 'build-not-allowlisted';
  const answeredAt = Date.parse(ev.answeredAt);
  const issuedAt = Date.parse(ask.issuedAt);
  if (answeredAt < issuedAt || answeredAt > issuedAt + MAX_AGE_MS) return answeredAt < issuedAt ? 'answered-before-issue' : 'expired';
  if (answeredAt > now() + FUTURE_SKEW_MS) return 'answer-in-the-future';
  return null;
}

// Why (#472): the tail of the recorder, the part that consumes the ask and writes the record, so the immediate path and settlePendingClicks admit a click through ONE core. `ev` is a transcript entry
// that passed clickEvidence and evidenceRefusal; `hc` is the dialog-hook check's result (taken now by the immediate path, at capture time for a pending one: the fingerprint must equal the ask's
// either way; it is not needed, and may be null, for a replay or a superseded ask). -> { recorded, kind, replay? } | { declined, replay? } | { instruction, kind, repo, prs, replay? } | { refused, retry? }; `retry: true` marks a refusal that
// is a state to try again later (an unreadable spent marker, a failed write), not a verdict: the deferred recorder leaves such a click pending. `io` (tests only) replaces the two writes.
function admitClick({ ask, ev, session, toolUseId, transcriptPath, cwd, hc, home, io = {} }) {
  const askId = ask.askId;
  const clickId = clickIdOf(session, toolUseId, askId);
  const write = io.writeExclusive ?? writeExclusive;
  const append = io.appendRecord ?? appendRecord;
  const spent = readSpent(askId, home);
  if (spent.state === 'bad') return { refused: 'spent', retry: true };
  if (spent.state === 'ok') return finishReplay({ spent: spent.marker, ask, clickId, ev, session, cwd, home, transcriptPath, io });
  if (supersededBefore(askId, Date.parse(ev.answeredAt), { home })) return { refused: 'superseded' };
  if (!hc?.ok) return { refused: hc?.reason ?? 'dialog-hooks' };
  if (ask.hookLayersSha256 !== null && hc.hookLayersSha256 !== ask.hookLayersSha256) return { refused: 'dialog-hooks-changed' };

  const mapped = answerText(ask, ev.answer);
  if (mapped.error) return { refused: mapped.error };
  // A decline and an instruction both write only the marker (no record, no grant marker, no round ticket). The instruction's marker also says `declined: true`, so a reader that does not know
  // `instruction` reads "declined, nothing approved": fail-safe.
  const marker = { v: 1, askId, clickId, toolUseId, answeredAt: ev.answeredAt, dialogSha256: ask.dialogSha256, producerVersion: ev.version, hookLayersSha256: hc.hookLayersSha256 ?? null, session, declined: mapped.declined !== undefined || mapped.instruction !== undefined, ...(mapped.instruction === undefined ? {} : { instruction: mapped.instruction }) };
  // The exclusive create decides who consumes the ask. Losing it to the SAME click (a hook retried, a second settler) is a replay: the winner's marker is read back and the click is finished from it.
  const lost = () => {
    const again = readSpent(askId, home);
    return again.state === 'ok' ? finishReplay({ spent: again.marker, ask, clickId, ev, session, cwd, home, transcriptPath, io }) : { refused: 'spent', ...(again.state === 'bad' ? { retry: true } : {}) };
  };
  if (mapped.declined !== undefined || mapped.instruction !== undefined) {
    const made = write(askFile(askId, 'spent', home), marker, home);
    return made === 'ok' ? (mapped.instruction === undefined ? { declined: mapped.declined } : instructionResult(ask, mapped.instruction)) : made === 'exists' ? lost() : { refused: 'write-failed', retry: true };
  }
  const bound = bindAnswer(ask, mapped.text, ev.question);
  if (bound.error) return { refused: bound.error }; // (nothing consumed: the owner can answer the same dialog again, or type)
  const made = write(askFile(askId, 'spent', home), marker, home);
  if (made === 'exists') return lost();
  if (made !== 'ok') return { refused: 'write-failed', retry: true };
  const record = append(home, session, clickRecordOf({ body: bound.body, session, text: mapped.text, cwd, transcriptPath, answeredAt: ev.answeredAt, ask: askRefOf(ask, toolUseId, clickId) }));
  return record === null ? { refused: 'record-write-failed', retry: true } : { recorded: record, kind: ask.kind };
}

const instructionResult = (ask, instruction) => ({ instruction, kind: ask.kind, repo: ask.repo, prs: [...ask.prs] });

// The same click again (a hook retried, a crash between the marker and the record): never consumes twice. Same click id and a verifiable marker -> the record exists (returned) or is written now
// from the marker's own answeredAt; anything else -> refused.
function finishReplay({ spent, ask, clickId, ev, session, cwd, home, transcriptPath, io = {} }) {
  if (spent.clickId !== clickId || spent.answeredAt !== ev.answeredAt || spent.dialogSha256 !== ask.dialogSha256) return { refused: 'spent' };
  // The marker's `instruction` is tested BEFORE `declined` (an instruction's marker says both). The same instruction is repeated only while the answer still maps to it.
  const again = answerText(ask, ev.answer);
  if (Object.hasOwn(spent, 'instruction')) return again.instruction !== undefined && again.instruction === spent.instruction ? { ...instructionResult(ask, spent.instruction), replay: true } : { refused: 'spent' };
  if (again.instruction !== undefined) return { refused: 'spent' }; // (a marker without `instruction` for an answer that maps to one: never a record, never a decline line)
  if (spent.declined === true) return { declined: ev.answer, replay: true };
  const existing = readRecords({ home, session, maxAgeMs: Infinity, settle: false }).find((r) => r.via === 'ask' && r.ask?.clickId === clickId);
  if (existing) return { recorded: existing, kind: ask.kind, replay: true };
  const mapped = answerText(ask, ev.answer);
  if (mapped.error) return { refused: mapped.error };
  const bound = bindAnswer(ask, mapped.text, ev.question);
  if (bound.error) return { refused: bound.error };
  const record = (io.appendRecord ?? appendRecord)(home, session, clickRecordOf({ body: bound.body, session, text: mapped.text, cwd, transcriptPath, answeredAt: spent.answeredAt, ask: askRefOf(ask, spent.toolUseId, clickId) }));
  return record === null ? { refused: 'record-write-failed', retry: true } : { recorded: record, kind: ask.kind, replay: true };
}

// ---- pending clicks (#472) ------------------------------------------------------------------------------------------------------------------

export const PENDING_RE = /^(ask-[0-9a-f]{12})\.([0-9a-f]{16})\.pending$/;
export const PENDING_MAX_PER_ASK = 8; // UNSETTLED pendings one ask may hold (a settled one never counts: settled junk must not block a genuine click)
const CLICK_ID_RE = /^[0-9a-f]{16}$/;
const clickFile = (askId, clickId, ext, home) => (ASK_ID_RE.test(String(askId)) && CLICK_ID_RE.test(String(clickId)) ? path.join(asksDir(home), `${askId}.${clickId}.${ext}`) : null);

// Why (#472, the 2.1.323 write order): the click's tool_result entry is not in the transcript when the PostToolUse hook runs, so the transcript cannot be checked yet. Everything that needs no transcript
// is checked NOW, while the click is fresh, and then only a POINTER is kept: `asks/<askId>.<clickId>.pending`. The pointer admits nothing: settlePendingClicks re-derives everything from the transcript
// and the ask file when a consumer reads, through the same clickEvidence and admitClick core. The one thing the pointer carries that the transcript cannot is the dialog-hook check's result
// (`hookLayersSha256`, taken at the click: hooks that could answer the dialog are checked when the dialog is answered, not when someone reads), plus `capturedAt` for the time rules; both are taken
// on the PostToolUse hook's word (guard-files refuses a tool write to owner-go/** and a direct hand-run of the click libraries: a path, program text, a stdin program; a script file that imports them is the residual named at the top of this file,
// and it skips only this dialog-hook result). What is refused here, no pointer: a tool_input that is
// not one canonical question of this ask (keys beyond questions / metadata, another dialog: only ever an EARLIER refusal, the tool_response is never read), an expired, superseded or already spent ask, and hooks that
// are unchecked, offending or changed since the ask.
async function captureClick({ input, ask, askId, session, toolUseId, transcriptPath, cwd, home, now, hookCheck }) {
  const shown = input.tool_input;
  if (!isObj(shown) || !Object.keys(shown).every((k) => k === 'questions' || k === 'metadata') || !Array.isArray(shown.questions) || shown.questions.length !== 1) return { refused: 'tool-use-shape' };
  const dialog = canonicalDialog(shown.questions[0]);
  if (dialog === null) return { refused: 'dialog-not-canonical' };
  if (sha256(JSON.stringify(dialog)) !== ask.dialogSha256) return { refused: 'dialog-differs' };
  if (now() > Date.parse(ask.issuedAt) + MAX_AGE_MS) return { refused: 'expired' };
  if (readSpent(askId, home).state !== 'none') return { refused: 'spent' };
  if (marked(askId, 'superseded', home)) return { refused: 'superseded' };
  const hc = await hookCheck({ home, input });
  if (!hc?.ok) return { refused: hc?.reason ?? 'dialog-hooks' };
  if (ask.hookLayersSha256 !== null && hc.hookLayersSha256 !== ask.hookLayersSha256) return { refused: 'dialog-hooks-changed' };
  return capturePending({ ask, askId, session, toolUseId, transcriptPath, cwd, hc, home, now });
}

// Why (#472): writes the pending pointer (exclusive create, 0600, fsync) and answers `{ pending: { askId, clickId, kind, repo, prs, variant?, quotes? } }` for the line the agent is told. `capturedAt` is taken
// AFTER the hook check, just before the write (the time rules measure the answer against it). A retried hook finds its own pointer and answers with it without rewriting it; the per-ask cap counts
// UNSETTLED pointers only (Fable F9) and never refuses the pointer a retry already has. `quotes` (a ruling ask only) is the answer text of each deciding label, the `--owner-quote` the consumer needs.
function capturePending({ ask, askId, session, toolUseId, transcriptPath, cwd, hc, home, now }) {
  const clickId = clickIdOf(session, toolUseId, askId);
  const file = clickFile(askId, clickId, 'pending', home);
  const result = { pending: { askId, clickId, kind: ask.kind, repo: ask.repo, prs: [...ask.prs], ...(ask.variant === undefined ? {} : { variant: ask.variant }), ...(ask.kind === 'ruling' ? { quotes: Object.fromEntries(Object.entries(ask.actions).filter(([, v]) => typeof v === 'string')) } : {}) } };
  const mine = readSmallJson(file);
  if (mine.state === 'ok') return mine.value?.clickId === clickId && mine.value.askId === askId ? result : { refused: 'write-failed' };
  if (mine.state === 'bad') return { refused: 'write-failed' }; // (a half-written pointer is no pointer: the owner types)
  let unsettled = 0;
  try {
    const names = readdirSync(asksDir(home));
    for (const n of names) {
      const m = PENDING_RE.exec(n);
      if (m && m[1] === askId && !names.includes(`${askId}.${m[2]}.settled`)) unsettled++;
    }
  } catch { return { refused: 'write-failed' }; }
  if (unsettled >= PENDING_MAX_PER_ASK) return { refused: 'too-many-pending' };
  const marker = { v: 1, askId, clickId, session, toolUseId, transcriptPath, cwd, hookLayersSha256: hc.hookLayersSha256 ?? null, capturedAt: new Date(now()).toISOString() };
  const made = writeExclusive(file, marker, home);
  return made === 'ok' || made === 'exists' ? result : { refused: 'write-failed' };
}

// ---- settling (#472) ------------------------------------------------------------------------------------------------------------------------

// The click hook is installed with `timeout: OWNER_GO_TIMEOUT_S` = 10 s (installer.mjs), and the #472 trace stamps the answer's result and the hook's attachments with the same millisecond, so the
// hook runs within seconds of the answer: 15 s covers the installed timeout. A test pins it. The check is capturedAt - 15 s <= answeredAt <= capturedAt + 15 s; its upper half is what the
// evidence expiry (capturedAt + CAPTURE_SKEW_MS + MAX_AGE_MS) relies on: no admitted answer is later than that bound minus 24 h, so no grant it could become is usable after the expiry.
export const CAPTURE_SKEW_MS = 15 * 1000;
// Scheduling only, never evidence: a unit captured longer ago than this is RETIRED: it is scanned after the active ones, newest first (#528), so the click the owner just made is reached before old stuck ones. Nothing is refused or settled on time alone but the evidence expiry.
export const WAIT_GRACE_MS = 10 * 60 * 1000;
export const SETTLE_SCAN_BUDGET = 32; // transcript scans (clickEvidence calls) one settlePendingClicks call makes
const SETTLED_OUTCOMES = Object.freeze(['recorded', 'declined', 'instructed', 'refused']); // 'instructed': a click on an instruction label (Follow up): verified, grants nothing

// Why (#472): whether the ask was superseded BEFORE the answer, which is what the answer is judged by. A click settled long after it was made must not be refused because a newer dry run issued a
// fresh ask afterwards (the owner had answered the then-current dialog), and must not be admitted because nobody settled it before the supersession. No marker -> false. A marker whose superseding ask
// was issued at or before the answer, an unreadable marker, or a superseding ask that cannot be read -> true (equal timestamps and unreadable metadata count as superseded: prefer a false refusal).
export function supersededBefore(askId, answeredAtMs, { home = accountHome() } = {}) {
  const r = readSmallJson(askFile(askId, 'superseded', home));
  if (r.state === 'none') return false;
  const by = r.value?.supersededBy;
  if (r.state !== 'ok' || r.value?.v !== 1 || r.value.askId !== askId || !ASK_ID_RE.test(String(by)) || !Number.isFinite(answeredAtMs)) return true;
  const next = readAsk(by, { home });
  return !next.ok || Date.parse(next.ask.issuedAt) <= answeredAtMs;
}

// A pending pointer read back and validated: { pending } with `capturedMs` added, or { bad: true }. The clickId must be the hash of the pointer's own fields and the name's (T3), and `capturedAt`
// a finite UTC time not in the future beyond the skew the readers allow.
function readPending(name, home, nowMs) {
  const m = PENDING_RE.exec(name);
  const r = readSmallJson(path.join(asksDir(home), name));
  const v = r.value;
  if (m === null || r.state !== 'ok' || !isObj(v) || v.v !== 1 || v.askId !== m[1] || v.clickId !== m[2] || typeof v.session !== 'string' || !SESSION_RE.test(v.session)
    || typeof v.toolUseId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(v.toolUseId) || clickIdOf(v.session, v.toolUseId, v.askId) !== v.clickId || typeof v.transcriptPath !== 'string'
    || (v.cwd !== null && typeof v.cwd !== 'string') || (v.hookLayersSha256 !== null && typeof v.hookLayersSha256 !== 'string')) return { bad: true };
  const capturedMs = isoMs(v.capturedAt);
  return Number.isFinite(capturedMs) && capturedMs <= nowMs + FUTURE_SKEW_MS ? { pending: { ...v, capturedMs } } : { bad: true };
}

let settling = false;

// Why (#472, the deferred half of the click recorder): verifies pending clicks from the transcript NOW, when a consumer is about to look for owner-go records, and turns each into exactly the record
// the immediate path writes (the same clickEvidence, evidenceRefusal and admitClick core, with the dialog-hook result the pointer carried), or settles it as declined or refused. Synchronous, never
// throws, and guarded against re-entry (a reader called from inside a settle returns at once). It writes only through writeExclusive (spent marker, `.settled`) and appendRecord, both replaceable
// by `io` for fault injection, and reads only through readSmallJson / readAsk / clickEvidence.
//
// Scheduling is not evidence. Pointers are grouped into UNITS, one per ask across every session; a unit is included as soon as any member matches the `session` / `askId` filter (the guard's
// session-scoped read), with all its members. Units captured less than WAIT_GRACE_MS ago are ACTIVE and go first, FIFO; the rest are RETIRED, go NEWEST first (#528: the click the owner just made is reached before old stuck ones; the mirror case, an old valid click behind 32 newer unverifiable ones, is left to the 24 h evidence expiry) and get what is left of the budget (SETTLE_SCAN_BUDGET
// transcript scans per call; a unit is started only below it, then looked at whole). A unit's members go in capturedAt order and the walk STOPS at the first one that is not terminal, so a later click is
// never admitted ahead of an earlier, still-unverified one (Fable F7). Nothing is refused or settled on time alone but the evidence expiry capturedAt + CAPTURE_SKEW_MS + MAX_AGE_MS: after that even a
// verified grant would be past its 24 h use window. A missing or unreadable transcript is `waiting`; an unreadable spent marker, a failed write and the like are `retry` (no `.settled`); every
// verdict (recorded, declined, instructed, refused) writes `<askId>.<clickId>.settled`, and a click that loses that race reports the winner's outcome. Garbled pointers are skipped (`skipped`, no budget).
// -> { outcomes: [{ askId, clickId, outcome: 'recorded' | 'declined' | 'instructed' | 'refused' | 'waiting' | 'retry' | 'skipped', reason? }], problems }.
export function settlePendingClicks({ home = accountHome(), now = Date.now, askId = null, session = null, io = {} } = {}) {
  const out = { outcomes: [], problems: [] };
  if (settling) return out;
  settling = true;
  try {
    const nowMs = now();
    let names;
    try {
      names = readdirSync(asksDir(home));
    } catch (err) {
      if (err?.code !== 'ENOENT') out.problems.push(`the asks folder cannot be read (${err?.code ?? 'error'})`);
      return out;
    }
    const have = new Set(names);
    const byAsk = new Map();
    for (const name of names) {
      const m = PENDING_RE.exec(name);
      if (m === null || have.has(`${m[1]}.${m[2]}.settled`)) continue;
      const r = readPending(name, home, nowMs);
      if (r.bad) { out.outcomes.push({ askId: m[1], clickId: m[2], outcome: 'skipped', reason: 'pending-invalid' }); continue; }
      if (!byAsk.has(m[1])) byAsk.set(m[1], []);
      byAsk.get(m[1]).push(r.pending);
    }
    const filtered = askId !== null || session !== null;
    const units = [...byAsk.values()]
      .filter((u) => !filtered || u.some((p) => (session !== null && p.session === session) || (askId !== null && p.askId === askId)))
      .map((u) => ({ members: u.sort((a, b) => a.capturedMs - b.capturedMs || a.clickId.localeCompare(b.clickId)) }))
      .map((u) => ({ ...u, oldest: u.members[0].capturedMs, askId: u.members[0].askId }));
    const fifo = (a, b) => a.oldest - b.oldest || a.askId.localeCompare(b.askId);
    const active = units.filter((u) => nowMs - u.oldest < WAIT_GRACE_MS).sort(fifo);
    const retired = units.filter((u) => nowMs - u.oldest >= WAIT_GRACE_MS).sort((a, b) => fifo(b, a));
    let scans = 0;
    for (const unit of [...active, ...retired]) {
      if (scans >= SETTLE_SCAN_BUDGET) break;
      for (const p of unit.members) {
        const o = settleOne(p, { home, now, nowMs, io, scanned: () => { scans++; } });
        out.outcomes.push({ askId: p.askId, clickId: p.clickId, ...o });
        if (o.outcome === 'waiting' || o.outcome === 'retry') break; // a later click never goes ahead of an earlier one that is not terminal
      }
    }
  } catch {
    out.problems.push('pending clicks could not be settled');
  } finally {
    settling = false;
  }
  return out;
}

// One pointer -> { outcome, reason? }. See settlePendingClicks.
function settleOne(p, { home, now, nowMs, io, scanned }) {
  const { askId, clickId } = p;
  const finish = (outcome, reason = null) => {
    const file = clickFile(askId, clickId, 'settled', home);
    const made = (io.writeExclusive ?? writeExclusive)(file, { v: 1, askId, clickId, outcome, reason, settledAt: new Date(now()).toISOString() }, home);
    if (made === 'ok') return { outcome, ...(reason === null ? {} : { reason }) };
    if (made !== 'exists') return { outcome: 'retry', reason: 'settled-write-failed' };
    const won = readSmallJson(file); // the other settler's verdict stands
    return won.state === 'ok' && SETTLED_OUTCOMES.includes(won.value?.outcome) ? { outcome: won.value.outcome, ...(typeof won.value.reason === 'string' ? { reason: won.value.reason } : {}) } : { outcome: 'retry', reason: 'settled-unreadable' };
  };
  const loaded = readAsk(askId, { home });
  if (!loaded.ok) return finish('refused', loaded.reason === 'none' ? 'ask-gone' : 'ask-invalid');
  const { ask } = loaded;
  if (nowMs > p.capturedMs + CAPTURE_SKEW_MS + MAX_AGE_MS) return finish('refused', 'evidence-expired');
  const taken = readSpent(askId, home);
  if (taken.state === 'ok' && taken.marker.clickId !== clickId) return finish('refused', 'spent'); // one ask, one use: another click has it, nothing here can change that
  scanned();
  const ev = clickEvidence(p.transcriptPath, p.toolUseId, { home });
  if (!ev.ok) return ev.reason === 'not-in-transcript' || ev.reason === 'transcript-unreadable' ? { outcome: 'waiting', reason: ev.reason } : finish('refused', ev.reason);
  const answeredAt = Date.parse(ev.answeredAt);
  const bad = evidenceRefusal({ ask, ev, session: p.session, now }) ?? (nowMs - answeredAt > MAX_AGE_MS ? 'stale' : null) ?? (Math.abs(answeredAt - p.capturedMs) > CAPTURE_SKEW_MS ? 'capture-skew' : null);
  if (bad !== null) return finish('refused', bad);
  // Why (#472): a late-settled EXTRA-ROUND click may already be covered by a round ticket (or an old claim's marker): it then needs its OWN per-grant marker, which readers that know nothing of tickets check.
  // Written BEFORE the record is appended (append -> check order: the claimer creates its ticket first and sweeps second, so one side always sees the other) and AGAIN after, to catch a ticket created in
  // between. The first attempt is best effort; the second must succeed, else the click stays `retry` (no `.settled`) and the next settle finishes it from the spent marker. Never gated by the environment.
  const mark = (record) => { try { return markCoveredGrant(record, { home }).marked; } catch { return 'error'; } };
  const append = io.appendRecord ?? appendRecord;
  const marking = { ...io, appendRecord: (h, s, record) => { if (record?.kind === 'extra-round') mark(record); return append(h, s, record); } };
  const r = admitClick({ ask, ev, session: p.session, toolUseId: p.toolUseId, transcriptPath: p.transcriptPath, cwd: p.cwd, hc: { ok: true, hookLayersSha256: p.hookLayersSha256 }, home, io: marking });
  if (r.recorded) {
    if (r.recorded.kind === 'extra-round' && mark(r.recorded) === 'error') return { outcome: 'retry', reason: 'marker-write-failed' };
    return finish('recorded');
  }
  if (r.declined !== undefined) return finish('declined');
  if (r.instruction !== undefined) return finish('instructed');
  return r.retry ? { outcome: 'retry', reason: r.refused } : finish('refused', r.refused);
}

// Why (#472): the unresolved round clicks of one repository (repository moves followed) and PR, for the STRICT grant lookups (ownerGrantLookups: `triage defer-fixes`, `round-request`), which must not read
// "no grant" over an owner click they could not verify. Every pointer of a round ask for that repository / PR with no `.settled` is a problem until its evidence could no longer matter
// (now > capturedAt + CAPTURE_SKEW_MS + MAX_AGE_MS: even a verified grant would be past its 24 h window): waiting, retried, retired after the grace (the grace is scheduling only, never evidence), garbled
// (its age is then its file's mtime) or with an ask that cannot be read (it cannot be told whose it is, so it counts). Plus an asks folder that cannot be read. Never settles, never writes, never throws.
// -> [string]. `moves` replaces the recorded repository moves (tests).
export function pendingClickProblems({ home = accountHome(), repo, pr, kinds = ['round'], now = Date.now, moves } = {}) {
  const out = [];
  try {
    const key = repoKey(repo);
    if (key === null || !Number.isInteger(pr)) return out;
    const nowMs = now();
    let names;
    try {
      names = readdirSync(asksDir(home));
    } catch (err) {
      if (err?.code !== 'ENOENT') out.push(`the asks folder cannot be read (${err?.code ?? 'error'}), so an unresolved owner click cannot be ruled out`);
      return out;
    }
    const have = new Set(names);
    const recorded = moves ?? readRepoMoves({ home }).moves;
    for (const name of names) {
      const m = PENDING_RE.exec(name);
      if (m === null || have.has(`${m[1]}.${m[2]}.settled`)) continue;
      const loaded = readAsk(m[1], { home });
      if (loaded.ok) {
        const a = loaded.ask;
        if (!kinds.includes(a.kind) || !a.prs.includes(pr) || !sameRepo({ recorded: a.repo, recordedAt: a.issuedAt, current: key, moves: recorded })) continue;
      }
      const r = readPending(name, home, nowMs);
      let capturedMs = r.pending?.capturedMs;
      if (capturedMs === undefined) { try { capturedMs = lstatSync(path.join(asksDir(home), name)).mtimeMs; } catch { capturedMs = nowMs; } }
      if (nowMs > capturedMs + CAPTURE_SKEW_MS + MAX_AGE_MS) continue;
      out.push(`an owner click on a round ask for #${pr} (${m[1]}) is not verified yet, so a grant it carries cannot be ruled out`);
    }
  } catch {
    out.push('pending owner clicks cannot be checked');
  }
  return out;
}

// Why (#472): a refusal that comes from "no approval yet" is misleading when the owner HAS clicked and the click is not usable (still waiting for its transcript entry, refused, declined, or a round already
// used). clickNotes reads the click pointers of a repository (repository moves followed) / PRs / kinds and answers up to three plain notes (newest first) for the merge, owner-ruling and round-cap refusals
// to append. Only clicks whose evidence could still matter are reported (now <= capturedAt + CAPTURE_SKEW_MS + MAX_AGE_MS). A merge or ruling click that was recorded says nothing (the refusal gives its own
// reason); a recorded ROUND click says so only when its round was already used. Never settles, never writes, never throws; no repo / PR / folder -> [].
// #538 / #542: only the ask the owner was shown LAST for a PR is reported (the newest issuedAt among the asks of this repository and kinds that display it; ties keep every tied ask), so a stale decline or refusal of an older ask
// is not printed after a newer click. Display freshness, not authorization: spent and supersession markers are not consulted. If the newest ask has no click of its own for the PR, nothing is said (the refusal the notes
// are appended to already tells the agent to show the request again).
const KIND_WORD = { merge: 'merge', 'merge-many': 'merge', round: 'round', ruling: 'ruling' };
export function clickNotes({ home = accountHome(), repo, prs, kinds = ['merge', 'merge-many', 'round', 'ruling'], now = Date.now, moves } = {}) {
  try {
    const key = repoKey(repo);
    if (key === null || !Array.isArray(prs) || !prs.every(Number.isInteger) || prs.length === 0) return [];
    const nowMs = now();
    const names = readdirSync(asksDir(home));
    const recorded = moves ?? readRepoMoves({ home }).moves;
    const newest = new Map(); // PR -> issue time of the newest ask (of this repository and kinds) that displays it; an unreadable ask file is ignored
    for (const name of names) {
      if (!/^ask-[0-9a-f]{12}\.json$/.test(name)) continue;
      const loaded = readAsk(name.slice(0, -5), { home });
      if (!loaded.ok || !kinds.includes(loaded.ask.kind) || !sameRepo({ recorded: loaded.ask.repo, recordedAt: loaded.ask.issuedAt, current: key, moves: recorded })) continue;
      for (const n of prs.filter((x) => loaded.ask.prs.includes(x))) newest.set(n, Math.max(newest.get(n) ?? 0, Date.parse(loaded.ask.issuedAt)));
    }
    const found = [];
    let records = null;
    for (const name of names) {
      const m = PENDING_RE.exec(name);
      if (m === null) continue;
      const loaded = readAsk(m[1], { home });
      if (!loaded.ok) continue;
      const a = loaded.ask;
      const pr = prs.find((n) => a.prs.includes(n));
      if (!kinds.includes(a.kind) || pr === undefined || !sameRepo({ recorded: a.repo, recordedAt: a.issuedAt, current: key, moves: recorded })) continue;
      if (Date.parse(a.issuedAt) < newest.get(pr)) continue; // an older ask than the one the owner last saw for this PR
      const r = readPending(name, home, nowMs);
      let capturedMs = r.pending?.capturedMs;
      if (capturedMs === undefined) { try { capturedMs = lstatSync(path.join(asksDir(home), name)).mtimeMs; } catch { capturedMs = nowMs; } }
      if (nowMs > capturedMs + CAPTURE_SKEW_MS + MAX_AGE_MS) continue;
      const who = `an owner click on the ${KIND_WORD[a.kind]} dialog for #${pr} (${m[1]})`;
      const typed = 'ask the owner to type the closing words instead';
      let note = null;
      if (r.bad) note = `${who} could not be read: ${typed}`;
      else {
        const s = readSmallJson(clickFile(m[1], m[2], 'settled', home));
        if (s.state === 'ok' && isObj(s.value)) {
          if (s.value.outcome === 'refused') note = `${who} was received but could not be verified (${String(s.value.reason ?? 'unknown')}): ${typed}`;
          else if (s.value.outcome === 'declined') note = `${who} was declined (the owner chose not now): nothing is approved`;
          else if (s.value.outcome === 'instructed' && a.kind === 'round') note = `the click on the round dialog for #${pr} (${m[1]}) was Follow up: it admits no round and approves no merge; do the follow-up steps (P triage defer-fixes), not codex-review`;
          else if (s.value.outcome === 'recorded' && a.kind === 'round') {
            records ??= readRecords({ home, now, settle: false, maxAgeMs: Infinity });
            const rec = records.find((x) => x?.via === 'ask' && x.ask?.clickId === m[2] && x.kind === 'extra-round');
            const id = rec ? grantIdOf(rec) : null;
            if (id !== null && readGrantMarker(id, { home }).spent) note = `${who} was recorded, but round ${rec.k} of #${rec.pr} is already used: each extra round is used once, ask the owner for another`;
          }
        } else if (s.state === 'none') {
          note = nowMs - capturedMs >= WAIT_GRACE_MS
            ? `${who} is still unverified after 10 minutes (its transcript entry has not appeared or cannot be read): ${typed}`
            : `${who} was received and is waiting to be verified (Claude Code writes the answer to the transcript a moment later): run the command again in a moment`;
        } else note = `${who} could not be read: ${typed}`;
      }
      if (note !== null) found.push({ capturedMs, note });
    }
    return found.sort((x, y) => y.capturedMs - x.capturedMs).slice(0, 3).map((x) => x.note);
  } catch {
    return [];
  }
}

// What became of the owner's click on the follow-up round dialog (round-v2-follow-up), for `triage defer-fixes`: a Follow up click grants nothing, so nothing else refuses a deferral whose click was never verified.
// Read-only (never settles, never writes) and never throws: call it AFTER a strict lookup, which settles pending clicks. It looks at the NEWEST round ask for the repository (repository moves followed) and PR that
// is not superseded; any other variant, or no such ask, is 'none'. Then: a spent marker (the immediate path) or a `.settled` outcome (a pending click) with `instruction` -> 'instructed'; a `.settled` 'refused' -> 'refused'
// (+ reason); a pointer with no `.settled` -> 'waiting'; an unreadable spent marker, pointer or outcome -> 'unverified'; a click on the Yes label -> 'recorded', a decline -> 'declined'; no click, or only clicks whose evidence
// could no longer matter (now > answeredAt / capturedAt + CAPTURE_SKEW_MS + MAX_AGE_MS, as in clickNotes) -> 'none' (the owner typed, or has not answered). -> { state, askId, reason?, note }; `moves` replaces the recorded repository moves (tests).
export function followUpClickState({ home = accountHome(), repo, pr, now = Date.now, moves } = {}) {
  const note = {
    none: 'no verified click on a Follow up button for this PR (the owner typed, or has not answered)',
    instructed: 'the owner\'s click on "Follow up" is verified: it grants no round and approves no merge',
    refused: 'the owner\'s click on the follow-up dialog was received but could not be verified',
    unverified: 'the owner\'s click on the follow-up dialog could not be read',
    waiting: 'the owner\'s click on the follow-up dialog is received and not verified yet',
    recorded: 'the owner clicked "Yes, one more round" on the follow-up dialog (a grant, not a follow-up)',
    declined: 'the owner declined the follow-up dialog: nothing is approved',
  };
  const say = (state, askId, reason) => ({ state, askId, ...(reason === undefined ? {} : { reason }), note: `${note[state]}${reason === undefined ? '' : ` (${reason})`}` });
  try {
    const key = repoKey(repo);
    if (key === null || !Number.isInteger(pr)) return say('none', null);
    const nowMs = now();
    let names;
    try {
      names = readdirSync(asksDir(home));
    } catch (err) {
      return err?.code === 'ENOENT' ? say('none', null) : say('unverified', null, `the asks folder cannot be read (${err?.code ?? 'error'})`);
    }
    const recorded = moves ?? readRepoMoves({ home }).moves;
    let newest = null;
    for (const name of names) {
      if (!/^ask-[0-9a-f]{12}\.json$/.test(name)) continue;
      const loaded = readAsk(name.slice(0, -5), { home });
      if (!loaded.ok || loaded.ask.kind !== 'round' || !loaded.ask.prs.includes(pr) || !sameRepo({ recorded: loaded.ask.repo, recordedAt: loaded.ask.issuedAt, current: key, moves: recorded }) || marked(loaded.ask.askId, 'superseded', home)) continue;
      if (newest === null || Date.parse(loaded.ask.issuedAt) > Date.parse(newest.issuedAt)) newest = loaded.ask;
    }
    if (newest === null || newest.variant !== 'round-v2-follow-up') return say('none', newest?.askId ?? null);
    const id = newest.askId;
    const live = (ms) => nowMs <= ms + CAPTURE_SKEW_MS + MAX_AGE_MS;
    const spent = readSpent(id, home);
    if (spent.state === 'bad') return say('unverified', id, 'its spent marker cannot be read');
    if (spent.state === 'ok') {
      const m = spent.marker;
      const answeredMs = Date.parse(m.answeredAt);
      if (!Number.isFinite(answeredMs)) return say('unverified', id, 'its spent marker has no usable time');
      if (!live(answeredMs)) return say('none', id);
      if (Object.hasOwn(m, 'instruction')) return m.instruction === 'follow-up' ? say('instructed', id) : say('unverified', id, 'its spent marker names an instruction this install does not know');
      return say(m.declined === true ? 'declined' : 'recorded', id);
    }
    // no spent marker: the pending pointers of this ask; the newest one inside its window decides
    let latest = null;
    for (const name of names) {
      const m = PENDING_RE.exec(name);
      if (m === null || m[1] !== id) continue;
      const r = readPending(name, home, nowMs);
      let capturedMs = r.pending?.capturedMs;
      if (capturedMs === undefined) { try { capturedMs = lstatSync(path.join(asksDir(home), name)).mtimeMs; } catch { capturedMs = nowMs; } }
      if (live(capturedMs) && (latest === null || capturedMs > latest.capturedMs)) latest = { clickId: m[2], capturedMs, bad: r.bad === true };
    }
    if (latest === null) return say('none', id);
    const settled = readSmallJson(clickFile(id, latest.clickId, 'settled', home));
    if (settled.state === 'none') return latest.bad ? say('unverified', id, 'its pending pointer cannot be read') : say('waiting', id);
    const outcome = settled.state === 'ok' && isObj(settled.value) ? settled.value.outcome : undefined;
    if (outcome === 'instructed') return say('instructed', id);
    if (outcome === 'refused') return say('refused', id, typeof settled.value.reason === 'string' ? settled.value.reason : 'unknown');
    if (outcome === 'declined' || outcome === 'recorded') return say(outcome, id);
    return say('unverified', id, 'its outcome cannot be read');
  } catch {
    return say('unverified', null, 'the click state could not be checked');
  }
}

// ---- the proof every consumer asks (B4) ---------------------------------------------------------------------------------------------------

// 'kind' is compared for every kind (absent for a merge click, so a merge click's record cannot be relabelled as a round grant or ruling): R26-F2.
const BINDING_KEYS = { approval: ['prs', 'requests'], 'extra-round': ['kind', 'repo', 'pr', 'k', 'head'], ruling: ['kind', 'repo', 'pr', 'ids', 'content'] };
// 'owner' | 'synthetic' | 'missing' for a record with `via: 'ask'`, read at ANY age (a consumed extra-round grant is read by the final gate days later): the transcript entries are found again by the tool
// use id and must still pass the entry checks, the ask file and spent marker must agree with the record, and the record's binding must be what the question and answer in the transcript say. Not
// re-checked, by design (R4b): the build allowlist, supersession, today's hook configuration, the ask's expiry against now. A transcript entry that is gone is 'missing', like a typed prompt's.
export function clickProvenance(record, { home = accountHome() } = {}) {
  try {
    const a = record?.ask;
    if (record?.via !== 'ask' || !isObj(a) || !ASK_ID_RE.test(String(a.askId)) || typeof a.toolUseId !== 'string' || typeof a.clickId !== 'string') return 'synthetic';
    const file = record.transcript_path;
    if (typeof file !== 'string' || file === '' || !path.isAbsolute(file) || /(?:^|[\\/])subagents[\\/]/.test(file) || !isTranscriptFile(file, { home })) return 'missing';
    const loaded = readAsk(a.askId, { home });
    if (!loaded.ok) return loaded.reason === 'none' ? 'missing' : 'synthetic';
    const { ask } = loaded;
    if ((Object.hasOwn(a, 'variant') ? a.variant : undefined) !== ask.variant) return 'synthetic'; // (the record names the dialog variant the ask file names, absent = legacy: a record cannot be re-pointed at another dialog)
    const spent = readSpent(a.askId, home);
    if (spent.state === 'none') return 'missing';
    if (spent.state !== 'ok') return 'synthetic';
    const m = spent.marker;
    if (m.declined === true || m.clickId !== a.clickId || m.toolUseId !== a.toolUseId || m.dialogSha256 !== ask.dialogSha256 || typeof record.session !== 'string' || clickIdOf(record.session, a.toolUseId, a.askId) !== a.clickId) return 'synthetic';
    const ev = clickEvidence(file, a.toolUseId, { home });
    if (!ev.ok) return ev.reason === 'not-in-transcript' || ev.reason === 'transcript-not-protected' || ev.reason === 'transcript-unreadable' ? 'missing' : 'synthetic';
    const answeredAt = Date.parse(ev.answeredAt);
    const issuedAt = Date.parse(ask.issuedAt);
    if (ev.session !== record.session || ev.dialogSha256 !== ask.dialogSha256 || m.answeredAt !== ev.answeredAt || Date.parse(record.ts) !== answeredAt || answeredAt < issuedAt || answeredAt > issuedAt + MAX_AGE_MS) return 'synthetic';
    const mapped = answerText(ask, ev.answer);
    if (mapped.error || mapped.declined !== undefined || mapped.instruction !== undefined) return 'synthetic'; // (a round record pointing at a Follow-up click is forged: that click admits nothing)
    const bound = bindAnswer(ask, mapped.text, ev.question);
    if (bound.error) return 'synthetic';
    const expected = clickRecordOf({ body: bound.body, session: record.session, text: mapped.text, cwd: null, transcriptPath: file, answeredAt: ev.answeredAt, ask: a });
    const keys = ['ts', 'session', 'prompt', 'via', 'ask', 'kind', ...BINDING_KEYS[expected.kind ?? 'approval']];
    const same = keys.every((k) => sortedJson(expected[k]) === sortedJson(record[k]));
    return same && (record.prompt_sha256 === undefined || record.prompt_sha256 === expected.prompt_sha256) ? 'owner' : 'synthetic';
  } catch {
    return 'synthetic';
  }
}
