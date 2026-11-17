// #262 (live-database guard, Task 3): the typed go. The owner's `go migration <name>` / `go data <sha12>` is recorded only when the reply right before it ends with a block the recorder
// REBUILDS byte for byte from git and the owner's registry. Everything runs in a scratch home; the hook case spawns the real hook script (the account's real records folder, cleaned up as
// the other hook tests do) with a made-up project that no real registry names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { OWNER_ENTRY, linesOf, runHook } from './helpers/owner-go.mjs';
import { run } from '../pipeline/commands/live-db.mjs';
import { run as runDbRefs } from '../pipeline/commands/db-refs.mjs';
import { UsageError } from '../pipeline/lib/cli.mjs';
import { buildBlock, canonicalDataSql, migrationSqlProblem, liveDbGoOutcome, liveDbRecords, parseGo, sha256Of, recordLiveDbGo } from '../pipeline/hooks/lib/live-db-go.mjs';
import { queuedNudge } from '../pipeline/hooks/lib/owner-go.mjs';
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
  await runDbRefs(['set', '--ref', REF, '--name', 'EagleWatch prod', '--repo', 'acme/widgets'], w.ownerCtx);
  await runDbRefs(['set', '--ref', DEV, '--name', 'Scratch', '--repo', 'acme/widgets', '--dev'], w.ownerCtx);
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
  ]) assert.equal(bash(cmd), 'deny', cmd);
  for (const cmd of [`cat ${LIB}`, 'node ~/.claude/pipeline/bin/pipeline.mjs live-db catalog tables public', 'git add pipeline/hooks/lib/live-db-go.mjs']) assert.equal(bash(cmd), 'allow', cmd);
});
