// The world builder of the click tests (moved out of owner-go-click.test.mjs so a second file can use it; no other change): a temp home, an issued ask and a spike transcript rewritten to the ask's dialog.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { approvalGap, ownerGoDir } from '../../pipeline/hooks/lib/owner-go.mjs';
import { MIN_ANSWER_MS, asksDir, canonicalDialog, dialogSha256, issueAsk, mergeAsk, recordClick } from '../../pipeline/hooks/lib/owner-go-click.mjs';
import { mergeRequest } from './owner-go.mjs';

export const REPO = 'acme/app';
export const HEAD = '0123456789abcdef0123456789abcdef01234567';
export const ITEMS = 'abcdef012345';
export const OLDEST = '2.1.322'; // the build the builds-agnostic click tests run on
const FIX = new URL('../fixtures/click/', import.meta.url);
export const loadFixture = (name, build = OLDEST) => readFileSync(new URL(`${build}/${name}.jsonl`, FIX), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
export const OK = () => ({ ok: true, hookLayersSha256: null });
export const noSleep = async () => {};
export const mergeParts = (pr = 58, head = HEAD) => mergeAsk({ repo: REPO, pr, closing: mergeRequest(pr, head, ITEMS, REPO) });

// An ask file written by hand the way a copy of the lib minted outside the three commands would (R1-F4): any title, options and actions, a consistent dialog hash.
// `v` / `variant` (the round-variant schema) are for tests that forge a v2 ask or a legacy one that carries a variant key; `variant` present (even null) is written.
export function forgeAsk({ kind, repo, prs, header, title, block, options, actions, hookLayersSha256, home, issuedAt, v = 1, variant }) {
  const askId = `ask-${'a1b2c3d4e5f6'}`;
  mkdirSync(asksDir(home), { recursive: true });
  const dialog = canonicalDialog({ question: `${title} (${askId})\n\n${block}`, header, multiSelect: kind === 'merge-many', options });
  writeFileSync(join(asksDir(home), `${askId}.json`), `${JSON.stringify({ v, askId, kind, ...(variant === undefined ? {} : { variant }), repo, prs, dialog, dialogSha256: dialogSha256(dialog), actions, issuedAt: new Date(issuedAt).toISOString(), hookLayersSha256 })}\n`);
  return { askId, questions: [dialog] };
}

// A world: a temp home, an issued ask and a transcript holding the fixture's entries rewritten to the ask's dialog and `answer` (default: the approving label). `tamper(dialog)` returns the dialog the
// transcript shows instead of the issued one; `mutate({ prompt, use, result })` edits the entries (a metadata case); `fixture` picks the spike transcript; `write: false` leaves the transcript with
// the prompt and the tool_use only (poll tests append the result themselves). `issuedAsk` ({ home, askId, questions }, cp #944): the ask a command already issued (e.g. `ruling-request --ask`) in that home;
// `parts` is then only the dialog's label -> answer map, nothing is issued here, and the transcript's entries are moved to just after the ask's own issue time.
export function world(t, { parts = mergeParts(), answer = null, fixture = 'genuine-click', build = OLDEST, tamper = null, mutate = null, hookLayersSha256 = null, issueBeforeUseMs = 10000, write = true, forge = false, issuedAsk = null } = {}) {
  const home = issuedAsk === null ? mkdtempSync(join(tmpdir(), 'owner-go-click-')) : issuedAsk.home;
  const entries = loadFixture(fixture, build);
  const [prompt, use, result] = entries;
  if (issuedAsk !== null) {
    const issuedMs = Date.parse(JSON.parse(readFileSync(join(asksDir(home), `${issuedAsk.askId}.json`), 'utf8')).issuedAt);
    const shift = issuedMs + issueBeforeUseMs - Date.parse(use.timestamp);
    for (const e of entries) e.timestamp = new Date(Date.parse(e.timestamp) + shift).toISOString();
  }
  // a recording the script made by keys or a hook was answered in under 2 s: move the answer to 30 s so that the 2 s floor is never what a case proves (mutate may still set its own time)
  if (Date.parse(result.timestamp) - Date.parse(use.timestamp) < MIN_ANSWER_MS) result.timestamp = new Date(Date.parse(use.timestamp) + 30000).toISOString();
  const issuedAt = Date.parse(use.timestamp) - issueBeforeUseMs;
  const issued = issuedAsk !== null ? { askId: issuedAsk.askId, questions: issuedAsk.questions } : forge ? forgeAsk({ ...parts, ...(forge === true ? {} : forge), hookLayersSha256, home, issuedAt }) : issueAsk({ ...parts, hookLayersSha256, home, now: () => issuedAt });
  assert.ok(issued.askId, `issue failed: ${JSON.stringify(issued)}`);
  const dialog = tamper ? tamper(structuredClone(issued.questions[0])) : issued.questions[0];
  const chosen = answer ?? Object.keys(parts.actions).find((l) => parts.actions[l] !== null);
  const block = use.message.content.find((b) => b.type === 'tool_use');
  block.input = { questions: [dialog] };
  const stamped = typeof result.toolUseResult === 'object' && result.toolUseResult !== null ? result.toolUseResult : {}; // (the rejected spike's result is a string)
  result.toolUseResult = { ...stamped, questions: [structuredClone(dialog)], answers: { [dialog.question]: chosen } };
  if (!('annotations' in stamped)) delete result.toolUseResult.annotations;
  result.message.content[0].content = `Your questions have been answered: "${dialog.question}"="${chosen}". You can now continue with these answers in mind.`;
  mutate?.({ prompt, use, result, dialog });
  const cfg = join(home, '.claude-click-test');
  mkdirSync(join(cfg, 'projects', '-repo'), { recursive: true });
  const file = join(cfg, 'projects', '-repo', 't.jsonl');
  const text = (es) => `${es.map((e) => JSON.stringify(e)).join('\n')}\n`;
  writeFileSync(file, text(write ? [prompt, use, result] : [prompt, use]));
  const answeredAt = Date.parse(result.timestamp);
  const w = {
    home, file, issued, askId: issued.askId, dialog, prompt, use, result, session: use.sessionId, toolUseId: block.id, answeredAt, issuedAt, text,
    now: () => answeredAt + 1000,
    input: { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', session_id: use.sessionId, transcript_path: file, cwd: '/work/app', tool_use_id: block.id, tool_input: { questions: [dialog] }, tool_response: {} },
  };
  w.click = (over = {}, input = {}) => recordClick({ ...w.input, ...input }, { home, now: w.now, sleep: noSleep, hookCheck: OK, ...over });
  w.records = () => { try { return readFileSync(join(ownerGoDir(home), `${w.session}.jsonl`), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  w.gap = (over = {}) => approvalGap({ repo: REPO, pr: 58, head: HEAD, items: ITEMS, areas: [], home, now: w.now, ...over });
  return w;
}
