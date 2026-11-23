// #261 (click-to-approve, T3): the PostToolUse entry of hooks/owner-go.mjs. The line the agent is told for a click that is recorded, declined or refused, nothing for an AskUserQuestion that is not
// ours, and an exit code that is always 0. The transcripts are the trimmed spike fixtures of owner-go-click.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { issueAsk, mergeAsk, roundAsk, rulingAsk } from '../pipeline/hooks/lib/owner-go-click.mjs';
import { clickHookLine, clickHookOutput, clickLine, dialogHookCheck } from '../pipeline/hooks/lib/owner-go-click-hook.mjs';
import { mergeRequest, roundRequest, rulingRequest } from './helpers/owner-go.mjs';

const HOOK = fileURLToPath(new URL('../pipeline/hooks/owner-go.mjs', import.meta.url));
const REPO = 'acme/app';
const HEAD = '0123456789abcdef0123456789abcdef01234567';
const ITEMS = 'abcdef012345';
const GHEAD = 'abcdef0123456789abcdef0123456789abcdef01';
const FIX = new URL('./fixtures/click/2.1.322/genuine-click.jsonl', import.meta.url);
const OK = () => ({ ok: true, hookLayersSha256: null });
const noSleep = async () => {};

const PARTS = {
  merge: () => mergeAsk({ repo: REPO, pr: 58, closing: mergeRequest(58, HEAD, ITEMS, REPO) }),
  round: () => roundAsk({ repo: REPO, pr: 58, line: roundRequest(58, 4, GHEAD, REPO) }),
  ruling: () => rulingAsk({ repo: REPO, pr: 58, ids: ['R1-B1', 'R2-S3'], line: rulingRequest(58, ['R1-B1', 'R2-S3'], REPO, 'c0ffee000000') }),
};

// A temp home holding an issued ask and a transcript with the genuine-click spike entries rewritten to that ask's dialog and `answer`.
function world(kind, answer) {
  const home = mkdtempSync(join(tmpdir(), 'owner-go-click-hook-'));
  const [prompt, use, result] = readFileSync(FIX, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const parts = PARTS[kind]();
  const issued = issueAsk({ ...parts, home, now: () => Date.parse(use.timestamp) - 10000 });
  assert.ok(issued.askId, JSON.stringify(issued));
  const dialog = issued.questions[0];
  const block = use.message.content.find((b) => b.type === 'tool_use');
  block.input = { questions: [dialog] };
  result.toolUseResult = { ...result.toolUseResult, questions: [structuredClone(dialog)], answers: { [dialog.question]: answer } };
  result.message.content[0].content = `Your questions have been answered: "${dialog.question}"="${answer}". You can now continue with these answers in mind.`;
  const cfg = join(home, '.claude-click-test');
  mkdirSync(join(cfg, 'projects', '-repo'), { recursive: true });
  const file = join(cfg, 'projects', '-repo', 't.jsonl');
  writeFileSync(file, `${[prompt, use, result].map((e) => JSON.stringify(e)).join('\n')}\n`);
  const answeredAt = Date.parse(result.timestamp);
  const input = { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', session_id: use.sessionId, transcript_path: file, cwd: '/work/app', tool_use_id: block.id, tool_input: { questions: [dialog] }, tool_response: {} };
  return { home, input, opts: { home, now: () => answeredAt + 1000, sleep: noSleep, check: OK } };
}

test('a recorded merge click: one line naming the repo, PR, head, items and the P merge command', async () => {
  const w = world('merge', 'Merge');
  const line = await clickHookLine(w.input, w.opts);
  assert.equal(line, `[claude-pipeline owner-go] the owner's click is recorded: "merge" for ${REPO} #58 head ${HEAD.slice(0, 12)} items ${ITEMS} — run P merge --pr 58 --owner-go now`);
  assert.equal(line.includes('\n'), false);
});

test('a recorded extra-round click and a recorded ruling click: the typed lines\' wording, the ruling carries the quote to pass', async () => {
  const round = await clickHookLine(world('round', 'Yes, one more round').input, world('round', 'Yes, one more round').opts);
  assert.equal(round, null, 'another home never issued that ask: not ours');
  const w = world('round', 'Yes, one more round');
  assert.equal(await clickHookLine(w.input, w.opts), `[claude-pipeline owner-go] the owner's click is recorded: extra round for ${REPO} #58 counted round 4 head ${GHEAD.slice(0, 12)}: run P codex-review --pr 58 --round <the n from round-request>`);
  const r = world('ruling', 'Accept all');
  assert.equal(await clickHookLine(r.input, r.opts), `[claude-pipeline owner-go] the owner's click is recorded: ruling recorded for ${REPO} #58: R1-B1, R2-S3 (pass --owner-quote "R1-B1: accept, R2-S3: accept")`);
});

test('a declined click ("Not yet"): nothing is approved, the agent stops and says what stays open', async () => {
  const w = world('merge', 'Not yet');
  assert.equal(await clickHookLine(w.input, w.opts), '[claude-pipeline owner-go] the owner chose "Not yet": nothing is approved; stop and say what stays open');
});

test('a refused click: the reason and the typed fallback, one line', async () => {
  const w = world('merge', 'Merge');
  // the dialog-hook check refuses
  const hooks = await clickHookLine(w.input, { ...w.opts, check: () => ({ ok: false, reason: 'unlisted handler x' }) });
  assert.equal(hooks, '[claude-pipeline owner-go] the click could not be verified (unlisted handler x): ask the owner to type the closing words instead');
  // a click answered too soon after the dialog opened is a typed-ahead key
  const soon = await clickHookLine(w.input, { ...w.opts, now: () => 0 });
  assert.match(soon, /^\[claude-pipeline owner-go\] the click could not be verified \(.+\): ask the owner to type the closing words instead$/);
});

test('an AskUserQuestion that is not ours prints nothing: no ask id, an unknown ask id, another tool, another event', async () => {
  const w = world('merge', 'Merge');
  const plain = { ...w.input, tool_input: { questions: [{ question: 'Which colour?', header: 'Colour', multiSelect: false, options: [{ label: 'a', description: 'a' }, { label: 'b', description: 'b' }] }] } };
  assert.equal(await clickHookLine(plain, w.opts), null);
  const unknown = { ...w.input, tool_input: { questions: [{ ...w.input.tool_input.questions[0], question: 'Merge it? (ask-0123456789ab)\n\nx' }] } };
  assert.equal(await clickHookLine(unknown, w.opts), null);
  assert.equal(await clickHookLine({ ...w.input, tool_name: 'Bash' }, w.opts), null);
  assert.equal(await clickHookLine({ ...w.input, hook_event_name: 'PreToolUse' }, w.opts), null);
  assert.equal(await clickHookLine(null, w.opts), null);
});

test('a recorder that throws prints nothing and the entry still returns', async () => {
  assert.equal(await clickHookLine({ hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion' }, { record: async () => { throw new Error('boom'); } }), null);
  assert.equal(await clickHookLine({ hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion' }, { record: () => { throw new Error('boom'); } }), null);
});

// #472: on 2.1.323 the answer reaches the transcript after this hook returns, so the click is only RECEIVED here and verified by the consumer. The line must never say "is recorded" or
// "could not be verified" (neither is true yet), and it names the consumer command to run now.
test('clickLine for a pending click: "received, verified when used" with the command to run now, one line per kind; never "is recorded" or "could not be verified"', () => {
  const HEADS = '[claude-pipeline owner-go] the owner\'s click is received and is verified when it is used';
  const base = { askId: 'ask-0123456789ab', clickId: '0123456789abcdef', repo: REPO };
  assert.equal(clickLine({ pending: { ...base, kind: 'merge', prs: [58] } }), `${HEADS}: if the owner chose to approve, run P merge --pr 58 --owner-go now; if they chose not to, stop: nothing is approved`);
  assert.equal(clickLine({ pending: { ...base, kind: 'merge-many', prs: [58, 61, 62] } }), `${HEADS}: if the owner chose to approve, run P merge --pr 58 --owner-go, P merge --pr 61 --owner-go and P merge --pr 62 --owner-go now (one per PR the owner ticked; a PR that was not ticked is refused); if they chose not to, stop: nothing is approved`);
  assert.equal(clickLine({ pending: { ...base, kind: 'round', prs: [58] } }), `${HEADS} (extra round for ${REPO} #58): if the owner chose to approve, run P codex-review --pr 58 --round <the n from round-request> now; if they chose not to, stop: nothing is approved`);
  const ruling = clickLine({ pending: { ...base, kind: 'ruling', prs: [58], quotes: { 'Accept all': 'R1-B1: accept, R2-S3: accept', 'Reject all': 'R1-B1: reject, R2-S3: reject' } } });
  assert.equal(ruling, `${HEADS} (ruling for ${REPO} #58): if the owner chose one of these labels, run P triage owner-ruling now with its --owner-quote: "Accept all" -> --owner-quote "R1-B1: accept, R2-S3: accept"; "Reject all" -> --owner-quote "R1-B1: reject, R2-S3: reject"; if they chose Not now, stop: nothing is ruled`);
  const mergeLine = clickLine({ pending: { ...base, kind: 'merge', prs: [58] } });
  for (const line of [ruling, mergeLine]) {
    assert.doesNotMatch(line, /is recorded|could not be verified/);
    assert.equal(line.includes('\n'), false);
  }
  assert.match(mergeLine, /if they chose not to, stop: nothing is approved/);
  // #541: only the declining label stops a ruling; Reject all / Follow-up all still run the ruling command, so the line must not read "approve" = run, "not" = stop
  assert.match(ruling, /if they chose Not now, stop: nothing is ruled/);
  assert.doesNotMatch(ruling, /chose to approve|chose not to/);
  // the literal "Not now" is the ONE label of rulingAsk with a null action (the declining one); a rename there must fail here
  const rask = rulingAsk({ repo: REPO, pr: 58, ids: ['R1-B1'], line: 'x' });
  assert.deepEqual(Object.entries(rask.actions).filter(([, v]) => v === null).map(([k]) => k), ['Not now']);
  // no deciding quotes to list: still says which label stops and which runs
  const bare = clickLine({ pending: { ...base, kind: 'ruling', prs: [58], quotes: {} } });
  assert.equal(bare, `${HEADS} (ruling for ${REPO} #58): if the owner chose any label other than Not now, run P triage owner-ruling now; if they chose Not now, stop: nothing is ruled`);
  for (const kind of ['merge', 'merge-many', 'round']) {
    assert.ok(clickLine({ pending: { ...base, kind, prs: [58] } }).includes('if they chose not to, stop'), kind);
  }
  // a repo-less or garbled pending still prints a safe line, never a throw
  assert.match(clickLine({ pending: { askId: 'ask-0123456789ab', clickId: '0123456789abcdef', kind: 'merge', prs: [] } }), /received and is verified when it is used/);
  assert.match(clickLine({ pending: {} }), /received and is verified when it is used/);
});

test('clickHookLine on the 2.1.323 write order (the answer is not in the transcript yet) prints the "received" line, writes a pending and nothing else', async () => {
  const w = world('merge', 'Merge');
  const file = w.input.transcript_path;
  const entries = readFileSync(file, 'utf8').trim().split('\n');
  writeFileSync(file, `${entries.slice(0, 2).join('\n')}\n`); // prompt + tool_use only: the result is written after the hooks return
  const line = await clickHookLine(w.input, w.opts);
  assert.equal(line, "[claude-pipeline owner-go] the owner's click is received and is verified when it is used: if the owner chose to approve, run P merge --pr 58 --owner-go now; if they chose not to, stop: nothing is approved");
});

test('clickHookLine with the tool_input Claude Code 2.1.323 hands the hook (the model input plus answers and annotations, #585): the "received" line, a pending, no record; another key shows in the refusal line', async () => {
  const w = world('merge', 'Merge');
  const file = w.input.transcript_path;
  const entries = readFileSync(file, 'utf8').trim().split('\n');
  writeFileSync(file, `${entries.slice(0, 2).join('\n')}\n`); // prompt + tool_use only (the 2.1.323 write order)
  const [q] = w.input.tool_input.questions;
  const shaped = { ...w.input, tool_input: { questions: [q], answers: { [q.question]: 'Merge' }, annotations: {} } };
  assert.equal(await clickHookLine(shaped, w.opts), "[claude-pipeline owner-go] the owner's click is received and is verified when it is used: if the owner chose to approve, run P merge --pr 58 --owner-go now; if they chose not to, stop: nothing is approved");
  const other = world('merge', 'Merge');
  writeFileSync(other.input.transcript_path, `${readFileSync(other.input.transcript_path, 'utf8').trim().split('\n').slice(0, 2).join('\n')}\n`);
  const odd = { ...other.input, tool_input: { questions: [other.input.tool_input.questions[0]], answers: {}, updatedInput: {} } };
  assert.equal(await clickHookLine(odd, other.opts), '[claude-pipeline owner-go] the click could not be verified (tool-use-shape: keys updatedInput): ask the owner to type the closing words instead');
});

// #585: "is recorded" only when the record can be used (a request with a repo: the only kind `P merge --owner-go` accepts). The "binds nothing" branch is defensive (bindAnswer refuses an empty or
// repo-less request before a click is ever recorded), so these use synthetic records.
test('clickLine for a recorded merge click that binds nothing (no request, or only repo-less ones) says so and how to continue; with at least one repo request it keeps the recorded wording (#585)', () => {
  const NOTHING = (prs) => `[claude-pipeline owner-go] the owner's click binds nothing: no Head/items/repo request was bound in the ask${prs}: run the dry run again (P merge --pr N --dry-run --owner-go) and end a reply with its closing lines, then ask the owner to type "merge"`;
  const rec = (requests, prs) => ({ recorded: { v: 1, via: 'ask', requests, prs } });
  assert.equal(clickLine(rec([], [58])), NOTHING(' (PRs #58)'));
  assert.equal(clickLine(rec([], [])), "[claude-pipeline owner-go] the owner's click binds nothing: no merge request was bound in the ask: run the dry run again (P merge --pr N --dry-run --owner-go) and end a reply with its closing lines, then ask the owner to type \"merge\"");
  assert.equal(clickLine(rec([{ pr: 58, head: HEAD.slice(0, 12), items: ITEMS, repo: null }], [58])), NOTHING(' (PRs #58)'));
  assert.equal(clickLine(rec([{ pr: 58, head: HEAD.slice(0, 12), items: ITEMS, repo: null }, { pr: 59, head: HEAD.slice(0, 12), items: ITEMS, repo: null }], [58, 59])), NOTHING(' (PRs #58, #59)'));
  const mixed = clickLine(rec([{ pr: 58, head: HEAD.slice(0, 12), items: ITEMS, repo: REPO }, { pr: 59, head: HEAD.slice(0, 12), items: ITEMS, repo: null }], [58, 59]));
  assert.equal(mixed, `[claude-pipeline owner-go] the owner's click is recorded: "merge" for ${REPO} #58 head ${HEAD.slice(0, 12)} items ${ITEMS}; (no repo: approves nothing) #59 head ${HEAD.slice(0, 12)} items ${ITEMS} — run P merge --pr 58 --owner-go now`);
  assert.match(clickLine(rec([{ pr: 58, head: HEAD.slice(0, 12), items: ITEMS, repo: REPO }], [58])), /the owner's click is recorded: "merge" for acme\/app #58/);
});

test('clickLine: null for anything it does not know', () => {
  assert.equal(clickLine(null), null);
  assert.equal(clickLine({}), null);
  assert.equal(clickLine({ refused: '' }), null);
});

test('dialogHookCheck: a dialog-hooks lib that will not load refuses the click (dialog-hooks-unavailable); a loaded one answers', async () => {
  assert.deepEqual(await dialogHookCheck({ home: '/h', input: {} }, async () => { throw new Error('no such module'); }), { ok: false, reason: 'dialog-hooks-unavailable' });
  assert.deepEqual(await dialogHookCheck({ home: '/h', input: { cwd: '/w' } }, async () => ({ checkDialogHooks: ({ home, cwd }) => ({ ok: true, hookLayersSha256: `${home}${cwd}` }) })), { ok: true, hookLayersSha256: '/h/w' });
  assert.deepEqual(await dialogHookCheck({ home: '/h', input: {} }, async () => ({ checkDialogHooks: () => { throw new Error('bad'); } })), { ok: false, reason: 'dialog-hooks-unavailable' });
});

// R1-F1: PostToolUse plain stdout is not model context; the documented channel is JSON hookSpecificOutput.additionalContext.
test('clickHookOutput: the line goes out as one JSON object with hookSpecificOutput.additionalContext on PostToolUse; no line, no output', async () => {
  const w = world('merge', 'Merge');
  const line = await clickHookLine(w.input, w.opts);
  const out = clickHookOutput(line);
  assert.equal(out.endsWith('\n'), true);
  assert.deepEqual(JSON.parse(out), { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: line } });
  assert.equal(clickHookOutput(null), '');
  assert.equal(clickHookOutput(''), '');
});

test('the hook script prints the click line only through clickHookOutput (never plain stdout on PostToolUse)', () => {
  const src = readFileSync(HOOK, 'utf8');
  assert.match(src, /clickHookOutput\(line\)/);
  assert.doesNotMatch(src, /stdout\.write\(`\$\{line\}\\n`\)/);
});

// R1-F5: the docs and the skill quote the line the hook really prints.
test('docs/cli.md and the review skill quote the refusal line clickLine prints', () => {
  const printed = clickLine({ refused: 'REASON' });
  const [head, tail] = printed.split('REASON');
  const prefix = head.replace('[claude-pipeline owner-go] ', '');
  assert.equal(prefix, 'the click could not be verified (');
  for (const rel of ['../docs/cli.md', '../skills/review/reference/owner-merge.md']) {
    const text = readFileSync(new URL(rel, import.meta.url), 'utf8');
    assert.ok(text.includes(prefix), `${rel} quotes the stable prefix`);
    assert.ok(text.includes(tail), `${rel} quotes the printed ending`);
  }
});

// ---- the script itself ------------------------------------------------------------------------------------------------------------------

const runHook = (stdin) => spawnSync(process.execPath, [HOOK], { input: stdin, encoding: 'utf8', timeout: 30000 });

test('the hook script on PostToolUse: a plain AskUserQuestion prints nothing and exits 0; so do garbage input and an ask this machine never issued', () => {
  const plain = { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', session_id: '11111111-2222-3333-4444-555555555555', tool_use_id: 'toolu_1', transcript_path: '/nowhere/t.jsonl', tool_input: { questions: [{ question: 'Which colour?', header: 'c', multiSelect: false, options: [] }] } };
  for (const stdin of [JSON.stringify(plain), JSON.stringify({ ...plain, tool_input: { questions: [{ question: 'Merge? (ask-ffffffffffff)\n\nx' }] } }), '{not json', '', JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }), 'null']) {
    const r = runHook(stdin);
    assert.equal(r.status, 0, `${stdin}: ${r.stderr}`);
    assert.equal(r.stdout, '', stdin);
  }
});

test('the hook script on UserPromptSubmit is unchanged: an ordinary prompt prints nothing and exits 0', () => {
  const r = runHook(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: '11111111-2222-3333-4444-555555555555', prompt: 'hello', transcript_path: '/nowhere/t.jsonl' }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
});
