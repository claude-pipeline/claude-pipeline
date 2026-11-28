// #262 (live-database guard) x #261 (click-to-approve): the owner's go for a live Supabase change as a CLICK on the dialog `live-db present --ask` returns (ask kind `live-db`). Scratch home, real git, a real
// 2.1.323 click transcript (test/fixtures/click). The typed go (test/live-db-guard.test.mjs) is the fallback and stays unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { git as realGit } from '../pipeline/lib/git.mjs';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { ymlFor } from './helpers/gate-env.mjs';
import { seedRegistry } from './helpers/db-refs-owner.mjs';
import { run as runLiveDb } from '../pipeline/commands/live-db.mjs';
import { buildBlock, sha256Of } from '../pipeline/hooks/lib/live-db-go.mjs';
import { claimLiveDbGo, evaluateSupabaseMcp } from '../pipeline/hooks/lib/live-db-guard.mjs';
import { asksDir, clickProvenance, liveDbAsk, issueAsk, matchesInstalledDialog, readAsk, recordClick } from '../pipeline/hooks/lib/owner-go-click.mjs';
import { readRecords } from '../pipeline/hooks/lib/owner-go.mjs';
import { clickHookLine } from '../pipeline/hooks/lib/owner-go-click-hook.mjs';

const realGitPath = '/usr/bin/git';
const REF = 'abcdefghij0123456789';
const OTHER = 'klmnopqrst0123456789';
const NAME = '20261117000000_add_col';
const FILE = `supabase/migrations/${NAME}.sql`;
const SQL = 'alter table t add column c int;\n';
const LABEL = 'EagleWatch prod';
const TOOL = 'mcp__plugin_supabase_supabase__';
const OK = () => ({ ok: true, hookLayersSha256: null });
const noSleep = async () => {};
const fixture = () => readFileSync(new URL('./fixtures/click/2.1.323/genuine-click.jsonl', import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const text = (es) => `${es.map((e) => JSON.stringify(e)).join('\n')}\n`;

// One world: registry, a repo with the migration, the block `present` prints, the issued ask and a 2.1.323 transcript (prompt + tool_use; the answer's entry is appended by w.flush()).
// `rebase`: shift every fixture timestamp so the answer lands seconds before the real clock (for a test that spawns the real hook, which reads Date.now()).
// `reply`: the entries printed before the dialog, or a function (block, dir) -> items (default: the block `present` printed, pasted last). An item is a text (an assistant entry), `{ blocks }` (an assistant entry with
// these content blocks), `{ result }` (a tool_result user entry) or `{ prompt }` (another owner prompt); `own: false` keeps it out of the dialog's own chain, `uuid` / `parent` set its place in the chain.
// `promptOver`: fields written over the fixture's prompt entry (its provenance).
const dir0 = (repo) => repo.dir;
async function world(t, { op = 'migration', answer = null, flush = false, modelAnswers = false, reply = null, flag = false, rebase = false, promptOver = null, dataText = 'update t set a = 1 where id = 7' } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'cp-live-db-click-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.claude'), { recursive: true });
  seedRegistry(home, { refs: [{ ref: REF, name: LABEL, repo: 'acme/widgets', kind: 'live', ...(flag ? { autoMigrations: true, autoSince: '2026-11-01T00:00:00Z' } : {}) }, { ref: OTHER, name: 'Other live', repo: 'acme/widgets', kind: 'live' }] });
  const repo = createTmpRepo();
  repo.git(['remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);
  repo.write(FILE, SQL);
  const head = repo.commit('init');
  const dataSql = dataText;
  const block = (op === 'migration'
    ? buildBlock({ op, ref: REF, label: LABEL, name: NAME, file: FILE, head, repo: 'acme/widgets', dir: repo.dir, sql: SQL, summary: 'adds c' })
    : buildBlock({ op, ref: REF, label: LABEL, repo: 'acme/widgets', dir: repo.dir, sql: dataSql, summary: 'fix' })).join('\n');
  const arg = op === 'migration' ? NAME : sha256Of(dataSql).slice(0, 12);
  const parts = liveDbAsk({ repo: 'acme/widgets', pr: op === 'migration' ? 7 : null, block, op, arg, label: LABEL, ref: REF });
  const [prompt, use, result] = fixture();
  if (rebase) {
    const shift = Date.now() - 3000 - Date.parse(result.timestamp);
    for (const e of [prompt, use, result]) e.timestamp = new Date(Date.parse(e.timestamp) + shift).toISOString();
  }
  const issuedAt = Date.parse(use.timestamp) - 10000;
  const issued = issueAsk({ ...parts, home, now: () => issuedAt });
  assert.ok(issued.askId, JSON.stringify(issued));
  const dialog = issued.questions[0];
  const chosen = answer ?? Object.keys(parts.actions).find((l) => parts.actions[l] !== null);
  const tu = use.message.content.find((b) => b.type === 'tool_use');
  tu.input = modelAnswers ? { questions: [dialog], answers: { [dialog.question]: chosen } } : { questions: [dialog] };
  result.toolUseResult = { ...result.toolUseResult, questions: [structuredClone(dialog)], answers: { [dialog.question]: chosen } };
  result.message.content[0].content = `Your questions have been answered: "${dialog.question}"="${chosen}". You can now continue with these answers in mind.`;
  mkdirSync(join(home, '.claude-t', 'projects', '-repo'), { recursive: true });
  const file = join(home, '.claude-t', 'projects', '-repo', `${use.sessionId}.jsonl`);
  if (promptOver !== null) Object.assign(prompt, promptOver);
  let ownPrev = prompt.uuid; // the last entry of the dialog's own chain
  let prev = prompt.uuid;
  const said = (typeof reply === 'function' ? reply(block, dir0(repo)) : reply ?? [block]).map((it, i) => {
    const item = typeof it === 'string' ? { blocks: [{ type: 'text', text: it }] } : it;
    const uuid = item.uuid ?? `11111111-0000-4000-8000-00000000000${i}`;
    const timestamp = new Date(Date.parse(use.timestamp) - 5000 + i).toISOString();
    const parentUuid = item.parent ?? (item.own === false ? prev : ownPrev);
    const e = item.result !== undefined
      ? { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_fix${i}`, content: item.result }] }, uuid, parentUuid, timestamp, sessionId: use.sessionId }
      : item.prompt !== undefined
        ? { type: 'user', message: { role: 'user', content: item.prompt }, promptId: `pid-fix${i}`, uuid, parentUuid, timestamp, origin: { kind: 'human' }, promptSource: 'typed', entrypoint: 'cli', sessionId: use.sessionId }
        : { ...structuredClone(use), uuid, parentUuid, timestamp, ...(item.extra ?? {}), message: { role: 'assistant', content: item.blocks } };
    if (item.own !== false) ownPrev = uuid;
    prev = uuid;
    return e;
  });
  use.parentUuid = ownPrev;
  writeFileSync(file, text(flush ? [prompt, ...said, use, result] : [prompt, ...said, use]));
  const answeredAt = Date.parse(result.timestamp);
  const w = {
    home, repo, head, file, session: use.sessionId, dialog, parts, askId: issued.askId, issued, answeredAt, block, dataSql, op, arg,
    t: answeredAt + 1000,
    input: { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', session_id: use.sessionId, transcript_path: file, cwd: repo.dir, tool_use_id: tu.id, tool_input: { questions: [dialog], answers: { [dialog.question]: chosen }, annotations: {} }, tool_response: {} },
  };
  w.hook = () => recordClick(w.input, { home, now: () => w.t, sleep: noSleep, pollMs: 0, hookCheck: OK });
  w.flush = () => appendFileSync(file, text([result]));
  w.claim = (over = {}) => claimLiveDbGo({ home, sessionId: w.session, transcriptPath: file, op, projectRef: REF, name: op === 'migration' ? NAME : null, sqlSha256: sha256Of(op === 'migration' ? SQL : dataSql), now: () => w.t, ...over });
  w.apply = (over = {}, ctx = {}) => evaluateSupabaseMcp(`${TOOL}apply_migration`, { project_id: REF, name: NAME, query: SQL, ...over }, { home, sessionId: w.session, transcriptPath: file, now: () => w.t, ...ctx });
  w.records = () => readRecords({ home, session: w.session, now: () => w.t, maxAgeMs: Infinity, settle: false });
  return w;
}

test('a click on the dialog records the typed go\'s record plus via ask, and the guard lets exactly that apply through once (a second apply is refused)', async (t) => {
  const w = await world(t, { flush: true });
  assert.equal(w.dialog.question, `Apply migration ${NAME} (#7) to ${LABEL} (${REF})? (${w.askId})\n\n${w.block}`);
  assert.deepEqual(w.dialog.options.map((o) => o.label), [`Yes, apply ${NAME}`, 'Not yet']);
  const r = await w.hook();
  assert.equal(r.recorded?.via, 'ask', JSON.stringify(r));
  assert.equal(r.kind, 'live-db');
  const rec = w.records()[0];
  assert.deepEqual({ kind: rec.kind, op: rec.op, projectRef: rec.projectRef, sqlSha256: rec.sqlSha256, name: rec.name, head: rec.head, file: rec.file, repo: rec.repo, prompt: rec.prompt, via: rec.via }, { kind: 'live-db-go', op: 'migration', projectRef: REF, sqlSha256: sha256Of(SQL), name: NAME, head: w.head, file: FILE, repo: 'acme/widgets', prompt: `go migration ${NAME}`, via: 'ask' });
  assert.equal(clickProvenance(rec, { home: w.home }), 'owner');
  assert.equal(w.apply().decision, 'allow');
  const again = w.apply();
  assert.equal(again.decision, 'deny');
  assert.match(again.reason, /already used/);
  assert.equal(readdirSync(join(w.home, '.claude', 'pipeline-state', 'owner-go', 'live-db-consumed')).length, 1);
});

test('a click counts only when the reply right before the dialog ends with the block the dialog carries (R6-F1): no block, an abridged or another block, or text after it is not claimed', async (t) => {
  const other = (dir) => buildBlock({ op: 'data', ref: REF, label: LABEL, repo: 'acme/widgets', dir, sql: 'update t set a = 2 where id = 7', summary: 'fix' }).join('\n');
  const cases = [
    ['no block in the reply', () => ['I will now ask you.']],
    ['no text at all', () => []],
    ['an abridged block', (b) => ['Apply the migration?', b.split('\n').slice(-4).join('\n')]],
    ['another valid block', (b, dir) => [other(dir)]],
    ['text after the block', (b) => [b, 'Here is the dialog.']],
  ];
  for (const [what, reply] of cases) {
    const w = await world(t, { flush: true, reply });
    assert.ok((await w.hook()).recorded, what);
    const c = w.claim();
    assert.equal(c.status, 'unverified', what);
    assert.match(c.reason, /paste its block as the last thing/, what);
    assert.equal(w.apply().decision, 'deny', what);
  }
  const ok = await world(t, { flush: true, reply: (b) => ['Some narrative first.', b] });
  assert.ok((await ok.hook()).recorded);
  assert.equal(ok.claim().status, 'claimed', 'the exact block pasted last');
});

test('the click binds only the exact block: another query, name or project is not claimed; an expired click (2 h after the answer) is refused', async (t) => {
  const w = await world(t, { flush: true });
  assert.ok((await w.hook()).recorded);
  assert.equal(w.claim({ sqlSha256: sha256Of('drop table t;') }).status, 'none');
  assert.equal(w.claim({ name: '20261117000001_other' }).status, 'none');
  assert.equal(w.claim({ projectRef: OTHER }).status, 'none');
  assert.equal(w.claim({ op: 'data', name: null }).status, 'none');
  assert.equal(w.claim({ now: () => w.answeredAt + 2 * 3600 * 1000 + 1000 }).status, 'expired');
  assert.equal(w.claim({ transcriptPath: `${w.file}.other` }).status, 'unverified');
  assert.equal(w.claim().status, 'claimed');
});

test('a data fix is a click too: title with the sha, no PR, claimed once', async (t) => {
  const w = await world(t, { op: 'data', flush: true });
  assert.equal(w.dialog.question.split('\n\n')[0], `Run data SQL ${w.arg} on ${LABEL} (${REF})? (${w.askId})`);
  assert.deepEqual(readAsk(w.askId, { home: w.home }).ask.prs, []);
  assert.ok((await w.hook()).recorded);
  assert.equal(w.claim().status, 'claimed');
  assert.equal(w.claim().status, 'spent');
});

test('2.1.323 write order: the click is pending at the hook, the claim says unverified (type the go) until the entry lands, then settles it and claims', async (t) => {
  const w = await world(t);
  const r = await w.hook();
  assert.ok(r.pending, JSON.stringify(r));
  assert.equal(w.records().length, 0);
  const early = w.claim();
  assert.equal(early.status, 'unverified');
  assert.match(early.reason, /type the go/);
  w.flush();
  assert.equal(w.claim().status, 'claimed', 'the claim settled the pending click first');
  assert.equal(w.records().length, 1);
  assert.equal(w.claim().status, 'spent');
  // B1b: the click-time check names no refusal for a valid reply (a tool result earlier in the turn, then the block as text), nor while the dialog's tool_use entry is not in the transcript yet
  const valid = await world(t, { reply: (b) => [{ blocks: [{ type: 'tool_use', id: 'toolu_present', name: 'Bash', input: { command: 'present' } }] }, { result: JSON.stringify({ ok: true, block: b }) }, b] });
  const asLine = (x) => clickHookLine(x.input, { home: x.home, now: () => x.t, sleep: noSleep, pollMs: 0, check: OK });
  assert.match(await asLine(valid), /the owner's click is received and is verified when it is used/);
  const unwritten = await world(t, { reply: [{ blocks: [{ type: 'thinking', thinking: 'a note', signature: 'x' }] }] });
  writeFileSync(unwritten.file, text([fixture()[0]])); // the transcript before the dialog's entry landed
  assert.match(await asLine(unwritten), /the owner's click is received and is verified when it is used/, 'silent, never a false refusal before the write lands');
});

test('declining records nothing; a dialog the model prefilled with answers is refused; a click is spent once (the ask itself)', async (t) => {
  const no = await world(t, { answer: 'Not yet', flush: true });
  assert.deepEqual(await no.hook(), { declined: 'Not yet' });
  assert.equal(no.records().length, 0);
  assert.equal(no.claim().status, 'none');
  const prefilled = await world(t, { flush: true, modelAnswers: true });
  assert.deepEqual(await prefilled.hook(), { refused: 'tool-use-shape' });
  assert.equal(prefilled.records().length, 0);
  const one = await world(t, { flush: true });
  assert.ok((await one.hook()).recorded);
  assert.equal((await one.hook()).replay, true, 'the same click again is a replay, not a second record');
  assert.equal(one.records().length, 1);
});

test('matchesInstalledDialog is false for a tampered title, block, label, options or PRs, true for the issued ask', async (t) => {
  const w = await world(t);
  const ask = readAsk(w.askId, { home: w.home }).ask;
  assert.equal(matchesInstalledDialog(ask, w.home), true);
  const mut = (f) => { const c = structuredClone(ask); f(c); return matchesInstalledDialog(c, w.home); };
  const q = ask.dialog.question;
  assert.equal(mut((c) => { c.dialog.question = q.replace(`to ${LABEL}`, 'to Other'); }), false, 'title label');
  assert.equal(mut((c) => { c.dialog.question = q.replace(`(${REF})?`, `(${OTHER})?`); }), false, 'title ref');
  assert.equal(mut((c) => { c.dialog.question = q.replace(NAME, '20261117000009_other'); }), false, 'title name');
  assert.equal(mut((c) => { c.dialog.question = q.replace('add column c int', 'drop table t'); }), false, 'block sql');
  assert.equal(mut((c) => { c.dialog.question = q.replace(sha256Of(SQL), sha256Of('x')); }), false, 'block sha');
  assert.equal(mut((c) => { c.dialog.options[1].label = 'Yes'; }), false, 'options');
  assert.equal(mut((c) => { c.prs = [8]; }), false, 'prs');
  assert.equal(mut((c) => { c.actions[`Yes, apply ${NAME}`] = 'go migration other'; }), false, 'actions');
  assert.equal(mut((c) => { c.repo = 'acme/other'; }), false, 'repo');
});

test('live-db present --ask: prints the block as before plus ask = title + blank line + block; label mode or no origin -> ask null and askSkipped', async (t) => {
  const w = await world(t);
  mkdirSync(join(w.repo.dir, '.claude'), { recursive: true });
  const yml = (extra) => writeFileSync(join(w.repo.dir, '.claude', 'pipeline.yml'), `${ymlFor()}${extra}`);
  const args = ['present', '--op', 'migration', '--pr', '7', '--file', FILE, '--project', REF, '--summary', 'adds c'];
  const ctx = { home: w.home, cwd: w.repo.dir, env: { AI_AGENT: 'claude-code_2-1-323_agent' }, gh: { prView: () => ({ headRefOid: w.head }) }, managedPaths: [] };
  const plain = await runLiveDb(args, ctx);
  assert.equal(plain.output.ok, true, JSON.stringify(plain.output));
  assert.equal('ask' in plain.output, false, 'no --ask, no ask fields');
  yml('owner_approval: chat\n');
  const r = await runLiveDb([...args, '--ask'], ctx);
  assert.equal(r.output.block, plain.output.block);
  assert.equal(r.output.ask?.questions[0].question, `Apply migration ${NAME} (#7) to ${LABEL} (${REF})? (${r.output.ask.askId})\n\n${plain.output.block}`, JSON.stringify(r.output.askSkipped));
  assert.equal(readAsk(r.output.ask.askId, { home: w.home }).ok, true);
  assert.ok(readdirSync(asksDir(w.home)).includes(`${r.output.ask.askId}.json`));
  yml('owner_approval: label\n');
  const skipped = await runLiveDb([...args, '--ask'], ctx);
  assert.equal(skipped.output.ok, true);
  assert.equal(skipped.output.ask, null);
  assert.match(skipped.output.askSkipped, /owner_approval is not chat/);
  // a data fix in the same repository
  yml('owner_approval: chat\n');
  writeFileSync(join(w.repo.dir, 'fix.sql'), `${w.dataSql}\n`);
  const data = await runLiveDb(['present', '--op', 'data', '--project', REF, '--sql-file', 'fix.sql', '--summary', 'fix', '--ask'], ctx);
  assert.equal(data.output.ask?.questions[0].question.split('\n\n')[0], `Run data SQL ${sha256Of(w.dataSql).slice(0, 12)} on ${LABEL} (${REF})? (${data.output.ask.askId})`, JSON.stringify(data.output));
});

test('live-db present --ask: a migration whose ask file would be over the 64 KB readers accept gets no ask (askSkipped names the size), so the owner types the go (R6-F2)', async (t) => {
  const w = await world(t);
  mkdirSync(join(w.repo.dir, '.claude'), { recursive: true });
  writeFileSync(join(w.repo.dir, '.claude', 'pipeline.yml'), `${ymlFor()}owner_approval: chat\n`);
  const bigName = '20261117000002_big';
  const bigFile = `supabase/migrations/${bigName}.sql`;
  w.repo.write(bigFile, `${Array.from({ length: 250 }, (_, i) => `-- ${i} ${'x'.repeat(280)}`).join('\n')}\nalter table t add column d int;\n`);
  const head = w.repo.commit('big');
  const ctx = { home: w.home, cwd: w.repo.dir, env: { AI_AGENT: 'claude-code_2-1-323_agent' }, gh: { prView: () => ({ headRefOid: head }) }, managedPaths: [] };
  const before = readdirSync(asksDir(w.home)).length;
  const r = await runLiveDb(['present', '--op', 'migration', '--pr', '7', '--file', bigFile, '--project', REF, '--summary', 'big', '--ask'], ctx);
  assert.equal(r.output.ok, true, JSON.stringify(r.output));
  assert.ok(r.output.block.includes(bigName), 'the block is still printed for the typed go');
  assert.equal(r.output.ask, null);
  assert.match(r.output.askSkipped, /too-large: \d+ bytes/);
  assert.equal(readdirSync(asksDir(w.home)).length, before, 'no ask file written');
});

// ---- auto-apply, Task 2: the click's go time on a project whose owner switched auto-apply on ---------------------------------------------------------------------------------

test('flag on: a click dialog issued before an attempt and answered after it is not a later go', async (t) => {
  // Failure caught: ordering a click by its answer time, so a dialog shown before a failed attempt but answered after it applied the migration a second time.
  const w = await world(t, { flush: true, flag: true });
  assert.ok((await w.hook()).recorded);
  const issued = Date.parse(readAsk(w.askId, { home: w.home }).ask.issuedAt);
  assert.ok(w.answeredAt - issued > 2000, 'the fixture answers well after the dialog was issued');
  const attempts = join(w.home, '.claude', 'pipeline-state', 'owner-go', 'live-db-attempts');
  mkdirSync(attempts, { recursive: true });
  const id = (kind, key) => createHash('sha256').update(`${kind}|${REF}|${key}`).digest('hex').slice(0, 32);
  for (const [kind, key] of [['name', NAME], ['sql', sha256Of(SQL)]]) writeFileSync(join(attempts, `${kind}-${id(kind, key)}-1.json`), `${JSON.stringify({ v: 1, event: 'seed', at: new Date(issued + 1000).toISOString(), via: 'go' })}\n`);
  const r = w.apply();
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /after this go/);
});

test('out of time: a click go whose pending click must still be settled is a deny that burns nothing; with time, the same click applies', async (t) => {
  // Failure caught: the click-settling route (pending pointer, ask file, transcript, block rebuild with git) running past the hook's budget, or an out-of-time call consuming the click.
  const w = await world(t, { flush: false, flag: true });
  assert.equal((await w.hook()).pending?.askId, w.askId, 'the click is only a pending pointer');
  w.flush();
  let spawns = 0;
  const r = w.apply({}, { leftMs: () => 0, io: { git: (args, opts) => { spawns += 1; return realGit(args, opts); } } });
  assert.equal(r.decision, 'deny');
  assert.equal(spawns, 0, 'no git process was started');
  assert.equal(existsSync(join(w.home, '.claude', 'pipeline-state', 'owner-go', 'live-db-consumed')), false, 'nothing consumed');
  assert.equal(w.apply().decision, 'allow', 'with time left the click settles and applies');
});

// Skipped on Windows: the test puts a POSIX sh git shim on PATH.
test('out of time in the middle of settling: the valid click stays pending (no .settled, nothing consumed) and settles with a full budget', { skip: process.platform === 'win32' }, async (t) => {
  // Failure caught: the budget running out between two git reads of the settling turned the block rebuild into "ask invalid" and wrote a terminal `refused` marker, so a retry with time left skipped the owner's click.
  const w = await world(t, { flush: false, flag: true });
  assert.equal((await w.hook()).pending?.askId, w.askId, 'the click is only a pending pointer');
  w.flush();
  const shim = join(w.home, 'shim-git');
  mkdirSync(shim);
  const marker = join(w.home, 'git-ran');
  writeFileSync(join(shim, 'git'), `#!/bin/sh\ntouch '${marker}'\nexec ${realGitPath} "$@"\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim}${delimiter}${oldPath}`;
  let r;
  try {
    r = w.apply({}, { leftMs: () => (existsSync(marker) ? 0 : 60_000) }); // time is up right after the first git read
  } finally {
    process.env.PATH = oldPath;
  }
  assert.ok(existsSync(marker), 'a git read ran before the budget ended');
  assert.equal(r.decision, 'deny');
  assert.deepEqual(readdirSync(asksDir(w.home)).filter((n) => n.endsWith('.settled')), [], 'no terminal verdict was written');
  assert.equal(existsSync(join(w.home, '.claude', 'pipeline-state', 'owner-go', 'live-db-consumed')), false, 'nothing consumed');
  assert.equal(w.apply().decision, 'allow', 'with time left the same click settles and applies');
});

// The hook entry as the host starts it: the real clock, the real PreToolUse input, a git shim first on PATH and a gh that never answers.
function spawnHook(w, shim) {
  const slowGh = join(w.home, 'slow-gh.mjs');
  writeFileSync(slowGh, 'setTimeout(() => {}, 30000);\n');
  const env = { ...process.env, HOME: w.home, USERPROFILE: w.home, PATH: `${shim}${delimiter}${process.env.PATH}`, PIPELINE_GH: `${process.execPath} ${slowGh}` };
  delete env[['PIPELINE', 'ADMIN'].join('_')];
  delete env.PIPELINE_GUARD_LOG;
  const input = { hook_event_name: 'PreToolUse', tool_name: `${TOOL}apply_migration`, tool_input: { project_id: REF, name: NAME, query: SQL }, session_id: w.session, transcript_path: w.file, cwd: w.repo.dir };
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../pipeline/hooks/guard-files.mjs', import.meta.url))], { input: JSON.stringify(input), encoding: 'utf8', env, timeout: 30_000 });
  return { r, ms: Date.now() - t0 };
}

// Skipped on Windows: the two tests below put a POSIX sh git shim on PATH.
test('through the real hook entry, control: with a responsive git the same pending click settles and the apply is allowed (the fixture reaches the settling route)', { skip: process.platform === 'win32' }, async (t) => {
  // Failure caught: the hung-git test below passing for the wrong reason (an expired click, or a fixture the settling route never reaches), so a settling route that runs past the host timeout would go unseen.
  const w = await world(t, { flush: false, flag: true, rebase: true });
  assert.equal((await w.hook()).pending?.askId, w.askId, 'the click is only a pending pointer');
  w.flush();
  const shim = join(w.home, 'shim');
  mkdirSync(shim);
  const marker = join(w.home, 'git-ran');
  writeFileSync(join(shim, 'git'), `#!/bin/sh\ntouch '${marker}'\nexec ${realGitPath} "$@"\n`, { mode: 0o755 });
  const { r } = spawnHook(w, shim);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '', 'an allow prints nothing (a deny prints its reason)');
  assert.ok(existsSync(marker), 'the settling route ran a git read');
  assert.equal(readdirSync(join(w.home, '.claude', 'pipeline-state', 'owner-go', 'live-db-consumed')).length, 1, 'the click was consumed by the allow');
});

test('through the real hook entry: a pending click of this session and a git that never answers is a deny within the host timeout, with nothing consumed', { skip: process.platform === 'win32' }, async (t) => {
  // Failure caught: the click-settling route (pending click -> ask file -> block rebuild with git) running past the hook's 15 s host timeout when git hangs; Claude Code then ALLOWS the call.
  const w = await world(t, { flush: false, flag: true, rebase: true });
  assert.equal((await w.hook()).pending?.askId, w.askId, 'the click is only a pending pointer');
  w.flush();
  const shim = join(w.home, 'shim');
  mkdirSync(shim);
  const argvLog = join(w.home, 'git-argv');
  writeFileSync(join(shim, 'git'), `#!/bin/sh\necho "$@" >> '${argvLog}'\nsleep 30\n`, { mode: 0o755 });
  const { r, ms } = spawnHook(w, shim);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny', r.stdout);
  assert.ok(ms < 14_000, `${ms} ms`);
  assert.ok(existsSync(argvLog), 'the settling route reached a git read');
  assert.match(readFileSync(argvLog, 'utf8').split('\n')[0], /rev-parse --show-toplevel$/, 'the hung call is the first git read of the block verification');
  assert.equal(existsSync(join(w.home, '.claude', 'pipeline-state', 'owner-go', 'live-db-consumed')), false, 'nothing consumed');
});

// ---- #741 (B1b): the reply right before the dialog -------------------------------------------------------------------------------------------------------------------------

const present = (b) => [{ blocks: [{ type: 'tool_use', id: 'toolu_present', name: 'Bash', input: { command: 'node pipeline.mjs live-db present --ask' } }] }, { result: JSON.stringify({ ok: true, block: b }) }];
// Claude Code 2.1.332's progress note: the entry shape of the real transcript (a one-sentence `thinking` summary, no reply text).
const progress = { blocks: [{ type: 'thinking', thinking: 'I am applying the migration the owner approved', signature: 'sig' }], extra: { thinkingDisplay: 'updates', staysIfReplyIsCut: true, apiBlockIndex: 1 } };

test('#983: a dialog whose message holds only a progress note is accepted when the dialog\'s own question carries the block: the click hook is silent and the guard allows the apply once', async (t) => {
  // Failure caught (owner clicked "Yes, apply" twice on 2026-11-28): Claude Code recorded only a progress note before AskUserQuestion, the owner read the block in the dialog's question, and the claim refused the click as "no reply text".
  const w = await world(t, { flush: true, reply: [progress] });
  const line = await clickHookLine(w.input, { home: w.home, now: () => w.t, sleep: noSleep, pollMs: 0, check: OK });
  assert.doesNotMatch(line ?? '', /will not be accepted|progress note/);
  assert.equal(w.claim().status, 'claimed');
  assert.equal(w.apply().decision, 'deny', 'the go is used by the claim above: a second apply is refused');
  const w2 = await world(t, { flush: true, reply: [progress] });
  assert.ok((await w2.hook()).recorded);
  assert.equal(w2.apply().decision, 'allow');
});

test('#983: a progress note stands in for the reply only when the question carries the block: a question without it is not claimed; no progress note and no text is still refused', async (t) => {
  // Failure caught: the progress-note exception accepting any click without checking the block, or widening to a turn with no text at all.
  const w = await world(t, { flush: true, reply: [progress] });
  assert.ok((await w.hook()).recorded);
  const strip = (v) => (typeof v === 'string' ? v.split(w.block).join('(block removed)') : Array.isArray(v) ? v.map(strip) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [strip(k), strip(x)])) : v);
  writeFileSync(w.file, text(readFileSync(w.file, 'utf8').trim().split('\n').map((l) => strip(JSON.parse(l)))));
  const c = w.claim();
  assert.equal(c.status, 'unverified');
  assert.equal(w.apply().decision, 'deny');
  const none = await world(t, { flush: true, reply: [] });
  assert.ok((await none.hook()).recorded);
  const nc = none.claim();
  assert.equal(nc.status, 'unverified');
  assert.match(nc.reason, /no reply text before the dialog/);
  assert.doesNotMatch(nc.reason, /progress note/);
});

test('R1-B1: hidden reasoning is not a progress note: redacted_thinking, or a thinking block on an entry Claude Code does not mark as shown, leaves the click refused', async (t) => {
  // Failure caught: any thinking / redacted_thinking block letting a click through on the dialog's body alone, so a turn whose reasoning the owner never saw replaced the reply text.
  for (const [what, note] of [['redacted_thinking', { blocks: [{ type: 'redacted_thinking', data: 'x' }] }], ['an unmarked thinking block', { blocks: progress.blocks }],
    // R2-F1: ordinary hidden reasoning as Claude Code records it: empty `thinking`, thinkingDisplay "updates", no staysIfReplyIsCut
    ['hidden reasoning with thinkingDisplay updates', { blocks: [{ type: 'thinking', thinking: '', signature: 'x' }], extra: { thinkingDisplay: 'updates', thinkingDurationMs: 3000, apiBlockIndex: 0 } }],
    // R3-S1: a whitespace-only `thinking` text on a marked entry is not a note either
    ['whitespace-only thinking on a marked entry', { blocks: [{ type: 'thinking', thinking: '  ', signature: 'x' }], extra: { thinkingDisplay: 'updates', staysIfReplyIsCut: true } }]]) {
    const w = await world(t, { flush: true, reply: [note] });
    assert.ok((await w.hook()).recorded, what);
    const c = w.claim();
    assert.equal(c.status, 'unverified', what);
    assert.match(c.reason, /no reply text before the dialog/, what);
    assert.equal(w.apply().decision, 'deny', what);
  }
});

test('R1-B2: a dialog question with prose or other SQL before the block is never issued or bound, so no click path can carry it', async (t) => {
  // Failure caught: verifyBlock reads the block as a suffix, so an ask whose question opened with a second description or another SQL block passed as the block the owner approved.
  const w = await world(t);
  const forged = liveDbAsk({ repo: 'acme/widgets', pr: 7, block: `This only adds a harmless column.\n\n${w.block}`, op: 'migration', arg: NAME, label: LABEL, ref: REF });
  const issued = issueAsk({ ...forged, home: w.home, now: () => w.answeredAt - 20000 });
  assert.equal(issued.askId, undefined, JSON.stringify(issued));
  assert.ok(issued.error);
});

test('R1-F1: a block longer than the fallback bound is not claimed on a progress note; the same block shown as reply text still is', async (t) => {
  // Failure caught: a long block (up to the line cap) approved on a dialog that may clip a tall question, so the owner never read all of the SQL.
  const dataText = Array.from({ length: 45 }, (_, i) => `update t set a = ${i} where id = 7;`).join('\n');
  const long = await world(t, { op: 'data', flush: true, reply: [progress], dataText });
  assert.ok(long.block.split('\n').length > 40);
  assert.ok((await long.hook()).recorded);
  const c = long.claim();
  assert.equal(c.status, 'unverified');
  assert.match(c.reason, /at most 40 screen rows/);
  const shown = await world(t, { op: 'data', flush: true, dataText });
  assert.ok((await shown.hook()).recorded);
  assert.equal(shown.claim().status, 'claimed');
  // R2-B1: few newlines but one very wide line (about 43 rows in an 80-column terminal) is just as tall
  const wide = `update t set a = 1 where id = 7 and b in (${'1,'.repeat(1700)}1)`;
  const tall = await world(t, { op: 'data', flush: true, reply: [progress], dataText: wide });
  assert.ok(tall.block.split('\n').length < 40);
  assert.ok((await tall.hook()).recorded);
  const tc = tall.claim();
  assert.equal(tc.status, 'unverified');
  assert.match(tc.reason, /at most 40 screen rows/);
  // R3-B1 / R3-F1: a wide-glyph line (2 columns each) and a line of 44-character words (one per row once word-wrapped) are as tall as the dialog may render them, though a plain 80-column hard wrap says fewer rows
  for (const [what, sql] of [['wide glyphs', `update t set n = '${'界'.repeat(1800)}'`], ['44-character words', Array.from({ length: 53 }, () => 'a'.repeat(44)).join(' ')],
    // R4-B1: a 2-column glyph cannot straddle column 80, so each of these lines is 3 rows, not 2
    ['a wide glyph at column 80', Array.from({ length: 13 }, () => `${'a'.repeat(79)}界${'a'.repeat(79)}`).join('\n')],
    // R4-B2: leading whitespace counts: 70 spaces then two 41-character words is 3 rows when word-wrapped, not 2
    ['indented words', Array.from({ length: 13 }, () => `${' '.repeat(70)}${'a'.repeat(41)} ${'b'.repeat(41)}`).join('\n')],
    // R5-B1: a no-break space is no break point for a wrapper that splits at ordinary spaces only; any whitespace or control character but a plain space and newline keeps the fallback closed
    ['a no-break space', Array.from({ length: 41 }, () => `${'a'.repeat(20)} ${'b'.repeat(20)}`).join(' ')],
    ['a tab in a short block', 'update t set a = 1,\tb = 2 where id = 7']]) {
    const x = await world(t, { op: 'data', flush: true, reply: [progress], dataText: sql });
    assert.ok((await x.hook()).recorded, what);
    const xc = x.claim();
    assert.equal(xc.status, 'unverified', what);
    assert.match(xc.reason, /at most 40 screen rows/, what);
  }
});

test('#983: a progress note followed by another turn\'s text before the dialog is still refused', async (t) => {
  // Failure caught: the progress-note exception hiding that another visible turn printed text between the note and the dialog.
  const w = await world(t, { flush: true, reply: [progress, { prompt: 'status?', own: false, uuid: 'u-p1' }, { blocks: [{ type: 'text', text: 'Still working on it.' }], own: false, uuid: 'u-tx', parent: 'u-p1' }] });
  assert.ok((await w.hook()).recorded);
  const c = w.claim();
  assert.equal(c.status, 'unverified');
  assert.match(c.reason, /another turn printed text between the reply and the dialog/);
});

test('R1-B7: a PENDING click (the label is not known yet) on a dialog with no reply text tells the agent to recover only if the owner chose to apply, and to stop otherwise', async (t) => {
  // Failure caught: the pending click line told the agent unconditionally to show the dialog again, so after the owner's "Not yet" the agent asked for the same approval at once.
  const w = await world(t, { reply: [] });
  const line = await clickHookLine(w.input, { home: w.home, now: () => w.t, sleep: noSleep, pollMs: 0, check: OK });
  assert.match(line, /no reply text before the dialog/);
  assert.match(line, /If the owner chose to apply, run live-db present again/);
  assert.match(line, /if they chose not to, stop: nothing is applied/);
});

test('B1b: an older valid block, then a tool result, then no text before the dialog is refused; present, a tool result, then the block as text and the dialog is claimed', async (t) => {
  // Failure caught: the block printed earlier in the turn (before another tool call) counted as the reply right before the dialog, so a click bound to text the owner was no longer shown last.
  const old = await world(t, { flush: true, reply: (b) => [b, ...present(b)] });
  assert.ok((await old.hook()).recorded);
  const c = old.claim();
  assert.equal(c.status, 'unverified');
  assert.match(c.reason, /no reply text before the dialog/);
  const ok = await world(t, { flush: true, reply: (b) => [...present(b), b] });
  assert.ok((await ok.hook()).recorded);
  assert.equal(ok.claim().status, 'claimed');
});

test('B1b: a dialog whose turn chains to a headless (sdk) prompt is refused as a turn the owner does not see', async (t) => {
  // Failure caught: a `claude -p --resume` process writing the block and the dialog into the owner's transcript, where the owner sees neither, and a click answer being bound to it.
  const w = await world(t, { flush: true, promptOver: { promptSource: 'sdk', entrypoint: 'sdk-cli', origin: { kind: 'sdk' } } });
  await w.hook();
  const c = w.claim();
  assert.notEqual(c.status, 'claimed');
  const line = await clickHookLine(w.input, { home: w.home, now: () => w.t, sleep: noSleep, pollMs: 0, check: OK });
  assert.match(line ?? '', /not one the owner sees/);
});

test('R1-B5: the first half of block A, another visible turn showing block B, then the rest of block A and the dialog: the pieces are not joined, the click is not claimed', async (t) => {
  // Failure caught: the reader skipped other turns' entries while joining the reply's text pieces and looked for an interleaved block only after the LAST piece, so A's two halves around B passed as the block the owner last saw.
  const w = await world(t, {
    flush: true,
    reply: (b, dir) => {
      const lines = b.split('\n');
      return [lines.slice(0, 5).join('\n'), { prompt: 'status?', own: false, uuid: 'u-p1' }, { blocks: [{ type: 'tool_use', id: 'toolu_other', name: 'Bash', input: { command: 'present' } }], own: false, uuid: 'u-tu', parent: 'u-p1' },
        { result: JSON.stringify({ ok: true, block: buildBlock({ op: 'data', ref: REF, label: LABEL, repo: 'acme/widgets', dir, sql: 'update t set a = 2 where id = 7', summary: 'fix' }).join('\n') }), own: false, parent: 'u-tu' },
        lines.slice(5).join('\n')];
    },
  });
  await w.hook();
  assert.equal(w.claim().status, 'unverified');
  assert.equal(w.apply().decision, 'deny');
});

test('B1b: reply A, then another visible turn shows block B only in a tool result, then the dialog for A: refused', async (t) => {
  // Failure caught: an interleaved visible turn printed a different block in a tool box after the reply, so the owner clicked a dialog for A while last looking at B.
  const w = await world(t, {
    flush: true,
    reply: (b, dir) => [b, { prompt: 'status?', own: false, uuid: 'u-p1' }, { blocks: [{ type: 'tool_use', id: 'toolu_other', name: 'Bash', input: { command: 'present' } }], own: false, uuid: 'u-tu', parent: 'u-p1' },
      { result: JSON.stringify({ ok: true, block: buildBlock({ op: 'data', ref: REF, label: LABEL, repo: 'acme/widgets', dir, sql: 'update t set a = 2 where id = 7', summary: 'fix' }).join('\n') }), own: false, parent: 'u-tu' }],
  });
  await w.hook();
  const c = w.claim();
  assert.equal(c.status, 'unverified');
  assert.match(c.reason, /another turn showed a live-database block between the reply and the dialog/);
});
