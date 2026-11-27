// #262 (live-database guard, Task 3): the typed go. The owner's `go migration <name>` / `go data <sha12>` is recorded only when the reply right before it ends with a block the recorder
// REBUILDS byte for byte from git and the owner's registry. Everything runs in a scratch home; the hook case spawns the real hook script (the account's real records folder, cleaned up as
// the other hook tests do) with a made-up project that no real registry names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { OWNER_ENTRY, linesOf, runHook } from './helpers/owner-go.mjs';
import { run } from '../pipeline/commands/live-db.mjs';
import { runOwnerCli, seedRegistry } from './helpers/db-refs-owner.mjs';
import { UsageError } from '../pipeline/lib/cli.mjs';
import { buildBlock, canonicalDataSql, checkedTopLevel, summaryProblem, migrationSqlProblem, migrationVersionOf, liveDbGoOutcome, liveDbRecords, parseGo, sha256Of, recordLiveDbGo } from '../pipeline/hooks/lib/live-db-go.mjs';
import { lastReply, queuedNudge } from '../pipeline/hooks/lib/owner-go.mjs';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';
import { matchCatalogQuery } from '../pipeline/hooks/lib/live-db-catalog.mjs';

const REF = 'abcdefghij0123456789';
const DEV = 'zyxwvutsrq9876543210';
const NAME = '20261117000000_add_col';
const FILE = `supabase/migrations/${NAME}.sql`;
const SQL = 'alter table t add column c int;\n';

function world(t, { sql = SQL, file = FILE } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'cp-live-db-go-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const ownerCtx = { home, env: {}, hasClaudeCodeAncestor: () => false };
  const repo = createTmpRepo();
  repo.git(['remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);
  repo.write(file, sql);
  const head = repo.commit('init');
  return { home, repo, head, ownerCtx, session: `test-${randomUUID()}` };
}
const setup = async (w) => {
  seedRegistry(w.home, { refs: [{ ref: REF, name: 'EagleWatch prod', repo: 'acme/widgets', kind: 'live' }, { ref: DEV, name: 'Scratch', repo: 'acme/widgets', kind: 'dev' }] });
};
const migBlock = (w, over = {}) => buildBlock({ op: 'migration', ref: REF, label: 'EagleWatch prod', name: NAME, file: FILE, head: w.head, repo: 'acme/widgets', dir: w.repo.dir, sql: SQL, summary: 'adds column c', ...over });
const dataSql = "update t set a = 1 where id = 7";
const dataBlock = (w, over = {}) => buildBlock({ op: 'data', ref: REF, label: 'EagleWatch prod', repo: 'acme/widgets', dir: w.repo.dir, sql: dataSql, summary: 'fix one row', ...over });
const say = (w, t, prompt, replyLines, { entry = OWNER_ENTRY, input = {}, cwd } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-live-db-go-tr-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const transcript = join(dir, 'projects', '-repo', 't.jsonl');
  mkdirSync(join(dir, 'projects', '-repo'), { recursive: true });
  const promptId = `pid-${randomUUID()}`;
  writeFileSync(transcript, linesOf([
    { type: 'user', message: { content: 'apply it' }, promptId: `pid-${randomUUID()}`, ...OWNER_ENTRY },
    { type: 'assistant', message: { content: [{ type: 'text', text: Array.isArray(replyLines) ? replyLines.join('\n') : replyLines }] } },
    { type: 'user', message: { content: prompt }, promptId, ...entry },
  ]));
  return liveDbGoOutcome({ hook_event_name: 'UserPromptSubmit', session_id: w.session, transcript_path: transcript, cwd: cwd ?? w.repo.dir, prompt, prompt_id: promptId, ...input }, { home: w.home });
};
const GO = `go migration ${NAME}`;

test('parseGo: only the two shapes, case-insensitive on the two words, nothing else', () => {
  assert.deepEqual(parseGo('go migration abc_1'), { op: 'migration', arg: 'abc_1' });
  assert.deepEqual(parseGo('  GO Data 0123456789ab.'), { op: 'data', arg: '0123456789ab' });
  for (const bad of ['go migration x?', 'go migration', 'go migration a b', 'please go data abc', 'go migrate x', 'go data ' + 'a'.repeat(121), '', 'go\nmigration x', null, 'go data x; rm']) assert.equal(parseGo(bad), null, String(bad));
});

test('a presented migration block + the typed go records once, with every field; the hook cwd need not be a repo', async (t) => {
  const w = world(t);
  await setup(w);
  const out = say(w, t, GO, ['Here is the plan.', ...migBlock(w)], { cwd: w.home });
  assert.ok(out.record, JSON.stringify(out));
  const r = out.record;
  assert.equal(r.kind, 'live-db-go');
  assert.deepEqual([r.op, r.projectRef, r.sqlSha256, r.name, r.head, r.file, r.repo], ['migration', REF, sha256Of(SQL), NAME, w.head, FILE, 'acme/widgets']);
  assert.equal(r.session, w.session);
  assert.ok(r.prompt_id && r.transcript_path && r.prompt === GO && r.prompt_sha256);
  assert.equal(out.label, 'EagleWatch prod');
  assert.equal(liveDbRecords({ home: w.home, session: w.session }).length, 1);
});

test('a data block + `go data <sha12>` records; the wrong sha or op does not', async (t) => {
  const w = world(t);
  await setup(w);
  const sha12 = sha256Of(dataSql).slice(0, 12);
  assert.ok(say(w, t, `go data ${sha12}`, dataBlock(w)).record);
  for (const prompt of [`go data ${'0'.repeat(12)}`, `go migration ${sha12}`]) assert.equal(say(w, t, prompt, dataBlock(w)).record, undefined, prompt);
});

test('a hand-written block of a local unpushed commit records when the WHOLE sql is shown (no present needed); a trailing space on a line is fine', async (t) => {
  const w = world(t);
  await setup(w);
  const lines = migBlock(w).map((l, i) => (i === 6 ? `${l}   ` : l));
  assert.ok(say(w, t, GO, lines).record);
});

test('forged or drifted blocks record nothing: harmless preview with the right hash, wrong flags, wrong label, extra line, missing file, typed name', async (t) => {
  const w = world(t);
  await setup(w);
  const good = migBlock(w);
  const no = (why, lines, prompt = GO) => assert.equal(say(w, t, prompt, lines).record, undefined, why);
  no('preview swapped, hash kept', good.map((l) => (l === SQL.trimEnd() ? 'select 1;' : l)));
  no('statement flags wrong', good.map((l) => (l.startsWith('Statements:') ? 'Statements: SELECT' : l)));
  no('statement flags hide a destructive one', migBlock(w, { sql: 'drop table t;\n' }).map((l) => (l.startsWith('Statements:') ? 'Statements: DROP' : l)));
  no('label differs from the registry', migBlock(w, { label: 'Scratch prod' }));
  no('a line after the block', [...good, 'ok?']);
  no('file missing at that head', migBlock(w, { file: 'supabase/migrations/20261117000001_nope.sql', name: '20261117000001_nope' }), 'go migration 20261117000001_nope');
  no('typed another name', good, 'go migration other');
  no('summary line missing', good.filter((l) => !l.startsWith("Claude's summary")));
  no('repo not the origin', migBlock(w, { repo: 'evil/other' }));
  no('data fence edited', dataBlock(w).map((l) => (l === dataSql ? 'delete from t' : l)), `go data ${sha256Of(dataSql).slice(0, 12)}`);
  no('dev ref', buildBlock({ op: 'migration', ref: DEV, label: 'Scratch', name: NAME, file: FILE, head: w.head, repo: 'acme/widgets', dir: w.repo.dir, sql: SQL, summary: 'x' }));
});

test('dir must be an absolute real top-level directory: relative, a subfolder, a symlink -> nothing', async (t) => {
  const w = world(t);
  await setup(w);
  const link = join(w.home, 'link');
  symlinkSync(w.repo.dir, link);
  for (const dir of ['supabase', join(w.repo.dir, 'supabase'), link, `${w.repo.dir}/../${w.repo.dir.split('/').pop()}`]) {
    mkdirSync(join(w.repo.dir, 'supabase'), { recursive: true });
    assert.equal(say(w, t, GO, migBlock(w, { dir })).record, undefined, dir);
  }
});

test('a 301-line migration: present refuses and a hand-written block records nothing', async (t) => {
  const big = `${Array.from({ length: 301 }, (_, i) => `-- line ${i}`).join('\n')}\nselect 1;\n`;
  const w = world(t, { sql: big });
  await setup(w);
  assert.equal(say(w, t, GO, migBlock(w, { sql: big })).record, undefined);
  const gh = { prView: () => ({ headRefOid: w.head }) };
  const r = await run(['present', '--op', 'migration', '--pr', '5', '--file', FILE, '--project', REF, '--summary', 'big'], { ...w.ownerCtx, cwd: w.repo.dir, gh });
  assert.equal(r.exitCode, 1);
  assert.match(r.output.message, /too long to show in full/);
});

test('not the owner: a subagent, a queued prompt (with its nudge), a synthetic entry, a prompt over the cap', async (t) => {
  const w = world(t);
  await setup(w);
  const lines = migBlock(w);
  assert.equal(say(w, t, GO, lines, { input: { agent_id: 'sub-1' } }).record, undefined);
  assert.equal(say(w, t, GO, lines, { entry: { ...OWNER_ENTRY, promptSource: 'queued' } }).record, undefined);
  assert.equal(say(w, t, GO, lines, { entry: { origin: { kind: 'task-notification' }, promptSource: 'system', entrypoint: 'cli' } }).record, undefined);
  assert.equal(say(w, t, `${GO} ${'x'.repeat(400)}`, lines), null); // (over the cap it is no go at all)
  assert.equal(say(w, t, 'go migration x?', lines), null);
  // the queued nudge also fires for a go
  const dir = mkdtempSync(join(tmpdir(), 'cp-live-db-go-q-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const transcript = join(dir, 'projects', '-repo', 't.jsonl');
  mkdirSync(join(dir, 'projects', '-repo'), { recursive: true });
  writeFileSync(transcript, linesOf([{ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } }, { type: 'user', message: { content: GO }, promptId: 'p1', ...OWNER_ENTRY, promptSource: 'queued' }]));
  assert.match(queuedNudge({ hook_event_name: 'UserPromptSubmit', session_id: w.session, transcript_path: transcript, prompt: GO }) ?? '', /typed while the agent was still working/);
});

test('the same hook input delivered twice writes two lines but liveDbRecords returns one', async (t) => {
  const w = world(t);
  await setup(w);
  const dir = mkdtempSync(join(tmpdir(), 'cp-live-db-go-d-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const transcript = join(dir, 'projects', '-repo', 't.jsonl');
  mkdirSync(join(dir, 'projects', '-repo'), { recursive: true });
  writeFileSync(transcript, linesOf([
    { type: 'user', message: { content: 'apply' }, promptId: 'p0', ...OWNER_ENTRY },
    { type: 'assistant', message: { content: [{ type: 'text', text: migBlock(w).join('\n') }] } },
    { type: 'user', message: { content: GO }, promptId: 'p1', ...OWNER_ENTRY },
  ]));
  const input = { hook_event_name: 'UserPromptSubmit', session_id: w.session, transcript_path: transcript, cwd: w.repo.dir, prompt: GO, prompt_id: 'p1' };
  assert.ok(recordLiveDbGo(input, { home: w.home }));
  assert.ok(recordLiveDbGo(input, { home: w.home }));
  assert.equal(liveDbRecords({ home: w.home, session: w.session }).length, 1);
  assert.equal(liveDbRecords({ home: w.home, session: 'another' }).length, 0);
});

test('present: refuses a dirty file, a CRLF file, a 61-line data fix, trailing whitespace, a dev ref, a PR head that is not HEAD; accepts the good case', async (t) => {
  const w = world(t);
  await setup(w);
  const ctx = (head = w.head) => ({ ...w.ownerCtx, cwd: w.repo.dir, gh: { prView: () => ({ headRefOid: head }) } });
  const mig = (project = REF, head) => run(['present', '--op', 'migration', '--pr', '5', '--file', FILE, '--project', project, '--summary', 'adds c'], ctx(head));
  const ok = await mig();
  assert.equal(ok.exitCode, 0, JSON.stringify(ok.output));
  assert.equal(ok.output.name, NAME);
  assert.equal(ok.output.sqlSha256, sha256Of(SQL));
  assert.ok(say(w, t, GO, ok.output.block.split('\n')).record, 'what present prints is what the recorder accepts');
  assert.match((await mig(REF, 'f'.repeat(40))).output.message, /not the head of PR #5/);
  assert.match((await mig(DEV)).output.message, /not a live project/);
  writeFileSync(join(w.repo.dir, FILE), `${SQL}-- edit\n`);
  assert.match((await mig()).output.message, /differs from HEAD/);
  w.repo.write(FILE, 'select 1;\r\nselect 2;\r\n');
  const crlfHead = w.repo.commit('crlf');
  assert.match((await mig(REF, crlfHead)).output.message, /carriage return/);
  const sqlFile = join(w.home, 'fix.sql');
  const data = (text) => { writeFileSync(sqlFile, text); return run(['present', '--op', 'data', '--project', REF, '--sql-file', sqlFile, '--summary', 'fix'], ctx()); };
  const d = await data(`﻿${dataSql}\n\n`);
  assert.equal(d.exitCode, 0);
  assert.equal(d.output.sql, dataSql);
  assert.ok(say(w, t, `go data ${d.output.sqlSha256.slice(0, 12)}`, d.output.block.split('\n')).record);
  assert.match((await data(Array.from({ length: 61 }, (_, i) => `select ${i};`).join('\n'))).output.message, /make it a migration/);
  assert.match((await data('select 1; \nselect 2;')).output.message, /ends with whitespace/);
  assert.match((await data('select 1;\r\nselect 2;')).output.message, /carriage return/);
  assert.match((await data('select 1;\n```\nselect 2;')).output.message, /three backticks/);
  await assert.rejects(() => run(['present', '--op', 'data', '--project', REF, '--summary', 'a\nb', '--sql-file', sqlFile], ctx()), UsageError);
});

test('SQL the block could not show in full is refused: an indented closing fence, control characters, bidi controls', () => {
  const bad = ['a;\n  ```\n[x]: <> (hidden)\nb;', 'a;\n```\nb;', 'a;\n\t```sql\nb;', 'a;\u001b[2Kb;', 'a;\u0008b;', 'a;\u007fb;', 'a;\u0085b;', 'a;\u009bb;', 'a;\u202eb;', 'a;\u2066b;', 'a;\u2069b;', 'a;\u000cb;'];
  for (const q of bad) {
    assert.ok(migrationSqlProblem(q), `migration: ${JSON.stringify(q)}`);
    assert.ok(canonicalDataSql(q).problem, `data: ${JSON.stringify(q)}`);
  }
  for (const q of ['select 1;\n\tfrom t;\n', 'select \'``` in a string\';\nselect 2;', 'select 1; -- ünï ✓']) {
    assert.equal(migrationSqlProblem(q), null, q);
    assert.ok(canonicalDataSql(q).sql, q);
  }
});

test('a summary that could hide or reorder text on screen is refused: DEL, C1 controls, bidi controls', () => {
  for (const s of ['a\u007fb', 'a\u0085b', 'a\u009b3A\u009bJ', 'a\u202eb', 'a\u2066b', 'a\u2069b', 'a\u001b[2Kb', 'a\nb']) assert.ok(summaryProblem(s), JSON.stringify(s));
  for (const s of ['adds column c', 'ünï ✓ fix']) assert.equal(summaryProblem(s), null, s);
});

test('catalog prints the template; an argument with a quote or semicolon is a usage error', async () => {
  const r = await run(['catalog', 'function-def', 'public', 'f'], { env: {} });
  assert.equal(r.exitCode, 0);
  assert.deepEqual(matchCatalogQuery(r.output.sql), { kind: 'function-def', args: ['public', 'f'] });
  await assert.rejects(() => run(['catalog', 'tables', 'a;b'], { env: {} }), UsageError);
  await assert.rejects(() => run(['catalog', 'nope'], { env: {} }), UsageError);
});

test('the real hook script records the go and prints one line; a go it cannot record prints the reason', async (t) => {
  const w = world(t);
  const ref = 'q'.repeat(20); // no real registry names it: `unregistered project <ref>`
  const sql = SQL;
  const block = buildBlock({ op: 'migration', ref, label: `unregistered project ${ref}`, name: NAME, file: FILE, head: w.head, repo: 'acme/widgets', dir: w.repo.dir, sql, summary: 'adds c' }).join('\n');
  const entries = [{ type: 'user', message: { content: 'apply' }, promptId: `pid-${randomUUID()}`, ...OWNER_ENTRY }, { type: 'assistant', message: { content: [{ type: 'text', text: block }] } }];
  const ok = runHook(t, { entries, prompt: GO, input: { cwd: w.home } });
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /the owner's live-database go is recorded: migration 20261117000000_add_col on unregistered project q+ \(q+\)/);
  assert.equal(ok.record?.kind, 'live-db-go');
  const bad = runHook(t, { entries, prompt: 'go migration other' });
  assert.equal(bad.record, null);
  assert.match(bad.stdout, /NOT recorded: the typed "other" is not/);
});

// ---- #741 (B1a): a turn the harness started that ends with the block ----------------------------------------------------------------------

const NOTICE = { origin: { kind: 'task-notification' }, promptSource: 'system', entrypoint: 'cli' };
const notice = (over = {}) => ({ type: 'user', message: { content: '<task-notification>background job finished</task-notification>' }, ...NOTICE, ...over });
const textOf = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const toolUse = (id, name, input, over = {}) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] }, ...over });
const toolResult = (id, content, over = {}) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] }, ...over });
// the owner's turn, `middle`, then the owner's typed `prompt`; the outcome of the recorder, and the transcript for a reader
function goAfter(w, t, prompt, middle) {
  const dir = mkdtempSync(join(tmpdir(), 'cp-live-db-go-n-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const transcript = join(dir, 'projects', '-repo', 't.jsonl');
  mkdirSync(join(dir, 'projects', '-repo'), { recursive: true });
  const promptId = `pid-${randomUUID()}`;
  writeFileSync(transcript, linesOf([
    { type: 'user', message: { content: 'start the job' }, promptId: `pid-${randomUUID()}`, ...OWNER_ENTRY },
    textOf('Started it.'),
    ...middle,
    { type: 'user', message: { content: prompt }, promptId, ...OWNER_ENTRY },
  ]));
  const input = { hook_event_name: 'UserPromptSubmit', session_id: w.session, transcript_path: transcript, cwd: w.repo.dir, prompt, prompt_id: promptId };
  return { out: liveDbGoOutcome(input, { home: w.home }), transcript, input };
}
const otherSql = 'update t set a = 2 where id = 7';
const goData = (sql) => `go data ${sha256Of(sql).slice(0, 12)}`;
// the dialog `present --ask` returns for a data fix, as the model passes it to AskUserQuestion
const dataDialog = (block, sql) => {
  const arg = sha256Of(sql).slice(0, 12);
  return { questions: [{ question: `Run data SQL ${arg} on EagleWatch prod (${REF})? (ask-0123456789ab)\n\n${block.join('\n')}`, header: 'Live DB', multiSelect: false, options: [{ label: `Yes, run ${arg}`, description: `Apply exactly the SQL shown above to EagleWatch prod (${REF}), the same as typing "go data ${arg}". One go, used once.` }, { label: 'Not yet', description: 'Do not apply now.' }] }] };
};

test('B1a: a turn the interactive UI started (a task notice) that ends with the block counts, so the owner\'s typed go is recorded', async (t) => {
  // Failure caught (transcript 9f16c301): the block was shown in a turn a task notice started; skipSynthetic read the whole reply as '', so the owner's go was refused and the block had to be shown again.
  const w = world(t);
  await setup(w);
  const { out } = goAfter(w, t, goData(dataSql), [notice(), textOf(dataBlock(w).join('\n'))]);
  assert.ok(out?.record, JSON.stringify(out));
  assert.equal(out.record.sqlSha256, sha256Of(dataSql));
});

test('B1a: a headless turn (entrypoint sdk-cli) that ends with the block never counts', async (t) => {
  // Failure caught: a `claude -p --resume` process writing a block into the owner's transcript, where the owner sees nothing, and a typed go binding to it.
  const w = world(t);
  await setup(w);
  const { out } = goAfter(w, t, goData(dataSql), [notice({ entrypoint: 'sdk-cli' }), textOf(dataBlock(w).join('\n'))]);
  assert.equal(out?.record, undefined);
});

test('B1a: block A as text, then block B only in a tool result of the same notice turn: neither go records', async (t) => {
  // Failure caught: the owner was last shown block B in a tool box, but the reply text still ended with block A, so a go for A (or B) was recorded against what the owner did not last see.
  const w = world(t);
  await setup(w);
  const shownB = JSON.stringify({ ok: true, block: dataBlock(w, { sql: otherSql }).join('\n') });
  const middle = [notice(), textOf(dataBlock(w).join('\n')), toolUse('tu1', 'Bash', { command: 'node x present' }), toolResult('tu1', shownB)];
  assert.equal(goAfter(w, t, goData(dataSql), middle).out?.record, undefined, 'a go for A');
  assert.equal(goAfter(w, t, goData(otherSql), middle).out?.record, undefined, 'a go for B');
});

test('B1a: a notice turn shows block A while another visible turn shows block B only in a tool result: neither go records', async (t) => {
  // Failure caught: the owner's other open turn printed a second block after the notice turn's text, and the reader still used the notice turn's block A.
  const w = world(t);
  await setup(w);
  const shownB = JSON.stringify({ ok: true, block: dataBlock(w, { sql: otherSql }).join('\n') });
  const middle = [
    { type: 'user', message: { content: 'status?' }, promptId: 'pid-p1', uuid: 'u-p1', ...OWNER_ENTRY },
    notice(), textOf(dataBlock(w).join('\n')),
    toolUse('tu2', 'Bash', { command: 'node x present' }, { parentUuid: 'u-p1', uuid: 'u-tu2' }), toolResult('tu2', shownB, { parentUuid: 'u-tu2' }),
  ];
  assert.equal(goAfter(w, t, goData(dataSql), middle).out?.record, undefined, 'a go for A');
  assert.equal(goAfter(w, t, goData(otherSql), middle).out?.record, undefined, 'a go for B');
});

test('B1a: the notice turn\'s own dialog (the same block and go words in AskUserQuestion) still counts; a dialog carrying another block does not', async (t) => {
  // Failure caught: the standard --ask flow (block, then AskUserQuestion repeating the block) read as "another block shown", so no typed go ever worked in a notice turn; the opposite failure: any dialog text accepted.
  const w = world(t);
  await setup(w);
  const own = [notice(), textOf(dataBlock(w).join('\n')), toolUse('ask1', 'AskUserQuestion', dataDialog(dataBlock(w), dataSql)), toolResult('ask1', 'User declined to answer questions')];
  assert.ok(goAfter(w, t, goData(dataSql), own).out?.record, 'own dialog');
  const swapped = [notice(), textOf(dataBlock(w).join('\n')), toolUse('ask1', 'AskUserQuestion', dataDialog(dataBlock(w, { sql: otherSql }), otherSql)), toolResult('ask1', 'User declined to answer questions')];
  assert.equal(goAfter(w, t, goData(dataSql), swapped).out?.record, undefined, 'another block in the dialog');
  assert.equal(goAfter(w, t, goData(otherSql), swapped).out?.record, undefined, 'a go for the dialog\'s block');
});

test('B1a: the owner saw block A in their own turn and a notice turn then re-presents the same migration name with other SQL: the typed go is refused', async (t) => {
  // Failure caught: `go migration <name>` binds the name only, so a notice turn swapping the SQL under the same name was recorded as the go for the block the owner last read in their own turn.
  const w = world(t);
  await setup(w);
  const blockA = migBlock(w);
  w.repo.write(FILE, `${SQL}-- changed\n`);
  const head2 = w.repo.commit('changed');
  const blockB = migBlock(w, { head: head2, sql: `${SQL}-- changed\n` });
  const swapped = goAfter(w, t, GO, [textOf(blockA.join('\n')), { type: 'user', message: { content: 'ok' }, promptId: 'pid-ok', ...OWNER_ENTRY }, textOf(blockA.join('\n')), notice(), textOf(blockB.join('\n'))]);
  assert.match(swapped.out?.reason ?? '', /the block changed in a turn you did not start/);
  const same = goAfter(w, t, GO, [{ type: 'user', message: { content: 'ok' }, promptId: 'pid-ok', ...OWNER_ENTRY }, textOf(blockB.join('\n')), notice(), textOf(blockB.join('\n'))]);
  assert.ok(same.out?.record, 'the same block again is no change');
});

const REF2 = 'klmnopqrst0123456789';
const swapRefused = (out) => assert.match(out?.reason ?? '', /the block changed in a turn you did not start/, JSON.stringify(out));
const changedMig = (w) => {
  w.repo.write(FILE, `${SQL}-- changed\n`);
  return migBlock(w, { head: w.repo.commit('changed'), sql: `${SQL}-- changed\n` });
};
const ownerOk = { type: 'user', message: { content: 'ok' }, promptId: 'pid-ok', ...OWNER_ENTRY };

test('R1-B1: a notice turn shows the same migration, or the same data fix, for ANOTHER live project: the typed go (which names no project) is refused', async (t) => {
  // Failure caught: neither typed go carries the project ref, so a notice turn re-presenting the owner's block for another live project was recorded with that notice's project, and the go ran the SQL there.
  const w = world(t);
  seedRegistry(w.home, { refs: [{ ref: REF, name: 'EagleWatch prod', repo: 'acme/widgets', kind: 'live' }, { ref: REF2, name: 'Other prod', repo: 'acme/widgets', kind: 'live' }] });
  const mig = goAfter(w, t, GO, [ownerOk, textOf(migBlock(w).join('\n')), notice(), textOf(migBlock(w, { ref: REF2, label: 'Other prod' }).join('\n'))]);
  swapRefused(mig.out);
  const data = goAfter(w, t, goData(dataSql), [ownerOk, textOf(dataBlock(w).join('\n')), notice(), textOf(dataBlock(w, { ref: REF2, label: 'Other prod' }).join('\n'))]);
  swapRefused(data.out);
});

test('R1-B2: the owner read block A, then TWO notice turns show a changed block B under the same name: the second notice is still compared with what the owner read', async (t) => {
  // Failure caught: the comparison used the slot right before the notice, which was the first notice's B, so B against B passed and the go was recorded for SQL the owner never read.
  const w = world(t);
  await setup(w);
  const a = migBlock(w).join('\n');
  const b = changedMig(w).join('\n');
  swapRefused(goAfter(w, t, GO, [ownerOk, textOf(a), notice(), textOf(b), notice(), textOf(b)]).out);
});

test('R1-B3: the owner\'s earlier block cannot be rebuilt (its checkout is gone) and a notice shows a changed block under the same name: refused, not waved through', async (t) => {
  // Failure caught: the swap check rebuilt the earlier block from git, and a removed worktree made that fail, which switched the check off.
  const w = world(t);
  await setup(w);
  const gone = migBlock(w, { dir: join(w.home, 'removed-worktree') }).join('\n');
  swapRefused(goAfter(w, t, GO, [ownerOk, textOf(gone), notice(), textOf(changedMig(w).join('\n'))]).out);
});

test('R1-F1: the owner\'s turn printed block A and then a closing sentence; a notice shows a changed block B under the same name: refused', async (t) => {
  // Failure caught: the check only knew a block that ENDS the earlier reply, so one line of text after block A (which the agent controls) switched it off.
  const w = world(t);
  await setup(w);
  const a = migBlock(w).join('\n');
  swapRefused(goAfter(w, t, GO, [ownerOk, textOf(a), textOf('I will apply it once you confirm.'), notice(), textOf(changedMig(w).join('\n'))]).out);
});

test('R1-B4: the notice turn\'s own dialog must repeat the WHOLE block: the same binding, apply and go lines around different SQL are not the reply\'s own dialog', async (t) => {
  // Failure caught: ownDialogInput compared only the binding, apply and go lines, so a dialog showing other SQL under the reply's lines was accepted and the owner's go ran the reply's SQL.
  const w = world(t);
  await setup(w);
  const block = dataBlock(w);
  const shownOther = block.map((l) => (l === dataSql ? otherSql : l));
  assert.notDeepEqual(shownOther, block);
  const out = goAfter(w, t, goData(dataSql), [notice(), textOf(block.join('\n')), toolUse('ask1', 'AskUserQuestion', dataDialog(shownOther, dataSql)), toolResult('ask1', 'User declined to answer questions')]).out;
  assert.equal(out?.record, undefined, JSON.stringify(out));
});

const ownerSays = (text, id) => ({ type: 'user', message: { content: text }, promptId: id, ...OWNER_ENTRY });

test('R2-F1: the owner read block A, then sent another message whose reply has no block, then a notice shows a changed block B under the same name: refused', async (t) => {
  // Failure caught: the reference was the newest owner-started slot only, so one unrelated owner message (or an empty slot the harness opens) switched the swap check off and the go was recorded for B.
  const w = world(t);
  await setup(w);
  const a = migBlock(w).join('\n');
  const empty = goAfter(w, t, GO, [ownerOk, textOf(a), ownerSays('what does it do?', 'pid-q'), textOf('It adds a column.'), notice(), textOf(changedMig(w).join('\n'))]);
  swapRefused(empty.out);
});

test('R2-B1: the owner\'s turn shows no block, a first notice shows the migration and a second notice shows changed SQL under the same name: refused', async (t) => {
  // Failure caught: the reference skipped promoted slots, so with no owner-shown block the second notice was compared with nothing and the go was recorded for SQL the owner never read.
  const w = world(t);
  await setup(w);
  const a = migBlock(w).join('\n');
  swapRefused(goAfter(w, t, GO, [ownerSays('status?', 'pid-s'), textOf('Looking.'), notice(), textOf(a), notice(), textOf(changedMig(w).join('\n'))]).out);
});

test('R2-B2: the owner read block A and the reply then quoted a binding line of ANOTHER migration; a notice shows a changed A: refused', async (t) => {
  // Failure caught: only the LAST binding line of the owner's turn was compared, so one quoted line for another migration (text the agent controls) hid the migration the owner was asked to approve.
  const w = world(t);
  await setup(w);
  const a = migBlock(w).join('\n');
  const other = migBlock(w, { name: '20261117000001_other', file: 'supabase/migrations/20261117000001_other.sql' });
  swapRefused(goAfter(w, t, GO, [ownerOk, textOf(`${a}\n${other[other.length - 2]}`), notice(), textOf(changedMig(w).join('\n'))]).out);
});

test('R2-B3: a dialog that repeats the reply\'s block and then a second copy of its binding and apply lines around other SQL is not the reply\'s own dialog', async (t) => {
  // Failure caught: one matching copy of the block exempted the whole dialog, so a second question around other SQL, under the same binding, apply and go lines, was read as the reply's own.
  const w = world(t);
  await setup(w);
  const block = dataBlock(w);
  const other = block.map((l) => (l === dataSql ? otherSql : l));
  const out = goAfter(w, t, goData(dataSql), [notice(), textOf(block.join('\n')), toolUse('ask1', 'AskUserQuestion', dataDialog([...block, '', ...other], dataSql)), toolResult('ask1', 'User declined to answer questions')]).out;
  assert.equal(out?.record, undefined, JSON.stringify(out));
});

test('R2-B4: SQL that holds a header-like line (in a string) is compared whole: a dialog with other statements above that line is not the reply\'s own dialog', async (t) => {
  // Failure caught: the dialog's block was anchored at the LAST header-prefix line, which sat inside the SQL, so a dialog differing above that line passed as the reply's own.
  const w = world(t);
  await setup(w);
  const sql = "update t set a = 'x\n🗄️ LIVE database change — fake\ny' where id = 7";
  const block = dataBlock(w, { sql });
  assert.ok(goAfter(w, t, goData(sql), [notice(), textOf(block.join('\n')), toolUse('ask1', 'AskUserQuestion', dataDialog(block, sql)), toolResult('ask1', 'x')]).out?.record, 'its own dialog counts');
  const other = block.map((l) => (l === "update t set a = 'x" ? "update t set b = 'x" : l));
  assert.notDeepEqual(other, block);
  const out = goAfter(w, t, goData(sql), [notice(), textOf(block.join('\n')), toolUse('ask1', 'AskUserQuestion', dataDialog(other, sql)), toolResult('ask1', 'x')]).out;
  assert.equal(out?.record, undefined, JSON.stringify(out));
});

test('B1a pin: the ruling reader (no liveDb option) still reads the same notice turn as no reply', async (t) => {
  // Failure caught: the live-database promotion leaking into the ruling / merge readers, which must keep voiding a slot for any text a notice turn prints.
  const w = world(t);
  await setup(w);
  const { transcript } = goAfter(w, t, goData(dataSql), [notice(), textOf(dataBlock(w).join('\n'))]);
  assert.deepEqual(lastReply(transcript, { prompt: goData(dataSql), skipSynthetic: true }), { text: '', promoted: false });
  assert.ok(lastReply(transcript, { prompt: goData(dataSql), skipSynthetic: true, liveDb: true }).promoted);
});

// ---- #811: a numbered migration is never presented, verified or applied through apply_migration ---------------------------------------------------------------------------

test('migrationVersionOf: a version is a timestamp only when it is 14 digits starting with a valid date; every other digit run is numbered, an empty suffix too', () => {
  // Failure caught: DRMed's 0261_x.sql read as a timestamp (or EagleWatch's counter-style 20260907240000_x.sql read as numbered and refused), so apply_migration recorded the wrong version or a real file was blocked.
  const kind = (n, o) => migrationVersionOf(n, o).kind;
  for (const n of ['20261117000000_add_col.sql', '20260907240000_x.sql', '20260513006000_x.sql', '20240229000000_leap.sql']) assert.equal(kind(n), 'timestamp', n);
  for (const n of ['0261_x.sql', '0261_.sql', '2026111700000_x.sql', '202611170000000_x.sql', '20261332000000_x.sql', '00000000000001_x.sql', '20230229000000_not_leap.sql']) assert.equal(kind(n), 'numbered', n);
  for (const n of ['abc.sql', 'add_col.sql', '_x.sql', '0261.sql']) assert.equal(kind(n), 'none', n);
  assert.equal(migrationVersionOf('0261_x.sql').version, '0261');
  assert.equal(kind('0261_', { stem: true }), 'numbered');
  assert.equal(kind('20261117000000_add_col', { stem: true }), 'timestamp');
  assert.equal(kind('add_col', { stem: true }), 'none');
});

test('#811: present refuses a numbered migration (also with an empty suffix) with reason numbered-migration, and an old block for one fails verification', async (t) => {
  // Failure caught: a numbered file presented, clicked or typed, then applied by apply_migration under a generated timestamp version, leaving 0261 pending and breaking every later db push.
  for (const stem of ['0261_x', '0261_']) {
    const file = `supabase/migrations/${stem}.sql`;
    const w = world(t, { file });
    await setup(w);
    const r = await run(['present', '--op', 'migration', '--pr', '5', '--file', file, '--project', REF, '--summary', 'adds c'], { ...w.ownerCtx, cwd: w.repo.dir, gh: { prView: () => ({ headRefOid: w.head }) } });
    assert.equal(r.exitCode, 1, stem);
    assert.equal(r.output.reason, 'numbered-migration');
    assert.match(r.output.message, /numbered migration.*The owner runs `supabase db push` by hand/s);
    const old = say(w, t, `go migration ${stem}`, migBlock(w, { name: stem, file }));
    assert.equal(old.record, undefined, `an old block for ${stem}`);
    assert.match(old.reason, /numbered migration/);
  }
});

// ---- the guard keeps the recorder out of an agent's hands ----------------------------------------------------------------------------

const LINUX = { home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, existsSync: () => false, cwd: '/repo' };
const bash = (command) => evaluateBashForFiles(command, LINUX).decision;
const LIB = '/home/u/.claude/pipeline/hooks/lib/live-db-go.mjs';

test('guard: running or importing live-db-go.mjs by hand is refused at every check site; reading it and the pipeline command stay open', () => {
  for (const cmd of [
    `node ${LIB}`,
    `${LIB}`,
    `node -e "import('${LIB}').then((m) => m.recordLiveDbGo({}))"`,
    `node --input-type=module <<'EOF'\nimport { recordLiveDbGo } from '${LIB}';\nEOF`,
    `node --input-type=module <<< "import '${LIB}'"`,
    `echo "import '${LIB}'" | node --input-type=module`,
    `node ./pipeline/hooks/lib/live-db-go.mjs`,
    `node ${LIB.replace('live-db-go', 'live-db-auto')}`, // (the attempt-history writer: run by hand it would write markers in the protected tree)
    `node -e "import('${LIB.replace('live-db-go', 'live-db-auto')}')"`,
  ]) assert.equal(bash(cmd), 'deny', cmd);
  for (const cmd of [`cat ${LIB}`, 'node ~/.claude/pipeline/bin/pipeline.mjs live-db catalog tables public', 'git add pipeline/hooks/lib/live-db-go.mjs']) assert.equal(bash(cmd), 'allow', cmd);
});

test('checkedTopLevel: POSIX needs the exact string; the Windows branch accepts git\'s differently-written form of the same real directory only', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-live-db-top-'));
  const other = mkdtempSync(join(tmpdir(), 'cp-live-db-other-'));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); });
  const gitSays = (top) => () => `${top}\n`;
  // what git prints on Windows differs from the dir in case (and slashes); the injected realpath stands in for the native one
  const winTop = dir.toUpperCase();
  const realpath = (p) => p;
  assert.equal(checkedTopLevel(dir, { git: gitSays(dir), platform: 'linux' }), dir);
  assert.equal(checkedTopLevel(dir, { git: gitSays(winTop), platform: 'linux', realpath }), null, 'off Windows the strings must be identical');
  assert.equal(checkedTopLevel(dir, { git: gitSays(winTop), platform: 'win32', realpath }), dir, 'on Windows the canonical forms match: the dir is returned as shown');
  assert.equal(checkedTopLevel(dir, { git: gitSays(other), platform: 'win32', realpath }), null, 'a different directory never matches');
  assert.equal(checkedTopLevel(dir, { git: gitSays(winTop), platform: 'win32', realpath: () => { throw new Error('gone'); } }), null, 'an unresolvable path fails closed');
  assert.equal(checkedTopLevel('relative/dir', { git: gitSays(dir), platform: 'win32', realpath }), null, 'still absolute only');
  assert.equal(checkedTopLevel(join(dir, 'nope'), { git: gitSays(dir), platform: 'win32', realpath }), null, 'still a real directory only');
});

test('auto-log lists each allowed call once, a lost reservation as reserved, an imported go as imported, and an unreadable record', async (t) => {
  // Failure caught: an allowed call missing from the log (or counted twice for its two files), a lost race shown as an apply, or one unreadable file hiding the rest.
  const home = mkdtempSync(join(tmpdir(), 'cp-live-db-autolog-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const dir = join(home, '.claude', 'pipeline-state', 'owner-go', 'live-db-attempts');
  mkdirSync(dir, { recursive: true });
  const NOW = Date.parse('2026-11-27T12:00:00Z');
  const id = (kind, key) => createHash('sha256').update(`${kind}|${REF}|${kind === 'name' ? key : sha256Of(key)}`).digest('hex').slice(0, 32);
  const put = (kind, key, n, body) => writeFileSync(join(dir, `${kind}-${id(kind, key)}-${n}.json`), body === '' ? '' : `${JSON.stringify(body)}\n`);
  const both = (key, name, n, event, ageMs, extra) => { for (const kind of ['name', 'sql']) put(kind, kind === 'name' ? name : `${SQL}-- ${name}`, n, { v: 1, event, at: new Date(NOW - ageMs).toISOString(), ref: REF, name, ...extra }); };
  const H = 3_600_000;
  both(null, NAME, 1, 'e-auto', 3 * H, { via: 'auto', pr: 42, commit: 'c'.repeat(40), file: FILE, repo: 'acme/widgets', label: 'EagleWatch prod', session: 's1' });
  both(null, NAME, 2, 'e-go', 1 * H, { via: 'go', session: 's2' });
  put('name', '20261117000009_lost', 1, { v: 1, event: 'e-lost', at: new Date(NOW - 4 * H).toISOString(), via: 'auto', ref: REF, name: '20261117000009_lost' });
  both(null, '20261117000008_imp', 1, 'e-imp', 5 * H, { via: 'go-import' });
  both(null, '20261101000000_old', 1, 'e-old', 40 * 24 * H, { via: 'auto' });
  writeFileSync(join(dir, `name-${'0'.repeat(32)}-1.json`), '');
  const ctx = { home, now: () => NOW };
  const r = (await run(['auto-log'], ctx)).output;
  assert.equal(r.ok, true);
  assert.deepEqual(r.events.map((e) => [e.name, e.via, e.outcome, e.generation]), [
    [NAME, 'go', 'attempted', 2],
    [NAME, 'auto', 'attempted', 1],
    ['20261117000009_lost', 'auto', 'reserved', 1],
    ['20261117000008_imp', 'go-import', 'imported', 1],
  ]);
  assert.deepEqual([r.events[1].pr, r.events[1].commit, r.events[1].repo, r.events[1].session], [42, 'c'.repeat(40), 'acme/widgets', 's1']);
  assert.deepEqual(r.unreadable, [join(dir, `name-${'0'.repeat(32)}-1.json`)]);
  const wide = (await run(['auto-log', '--days', '60'], ctx)).output;
  assert.equal(wide.events.length, 5);
  assert.equal(wide.events[4].name, '20261101000000_old');
  for (const days of ['0', 'x', '1.5']) await assert.rejects(() => run(['auto-log', '--days', days], ctx), UsageError, days);
  await assert.rejects(() => run(['auto-log', '--op', 'data'], ctx), UsageError);
});
