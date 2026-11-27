// #262 (live-database guard, Task 4): the decision for a Supabase MCP call on a live project, and the claim that spends the owner's go. Scratch home, real git, real transcripts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { git as realGit } from '../pipeline/lib/git.mjs';
import { release, tryAcquire } from '../pipeline/lib/locks.mjs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { OWNER_ENTRY, linesOf } from './helpers/owner-go.mjs';
import { runOwnerCli, seedRegistry } from './helpers/db-refs-owner.mjs';
import { buildBlock, liveDbGoOutcome, sha256Of } from '../pipeline/hooks/lib/live-db-go.mjs';
import { LIVE_DB_CONSUMED_REL, claimLiveDbGo, evaluateSupabaseMcp, isSupabaseTool } from '../pipeline/hooks/lib/live-db-guard.mjs';
import { readDbRefs } from '../pipeline/hooks/lib/db-refs.mjs';
import { buildCatalogQuery } from '../pipeline/hooks/lib/live-db-catalog.mjs';
import { evaluateBashForFiles, evaluateFileTool } from '../pipeline/hooks/lib/files-policy.mjs';
import { HOOK_CLOCK } from '../pipeline/hooks/lib/script-candidates.mjs';

const REF = 'abcdefghij0123456789';
const DEV = 'zyxwvutsrq9876543210';
const NAME = '20261117000000_add_col';
const FILE = `supabase/migrations/${NAME}.sql`;
const SQL = 'alter table t add column c int;\n';
const TOOL = 'mcp__plugin_supabase_supabase__';
const NOW = Date.parse('2026-11-17T12:00:00Z');
const STATE = (home) => join(home, '.claude', 'pipeline-state');

// one session: registry, repo, a transcript under the scratch home's config dir, the block shown, and the owner's go typed at `typedAt`
// `flag`: the owner switched auto-apply on for REF (the attempt history applies); `home`: a second session in a home that already exists (its registry is the first scene's).
async function scene(t, { typedAt = NOW - 60_000, op = 'migration', shownSql = SQL, flag = false, home: shared = null } = {}) {
  const home = shared ?? mkdtempSync(join(tmpdir(), 'cp-live-db-guard-'));
  if (shared === null) {
    t.after(() => rmSync(home, { recursive: true, force: true }));
    seedRegistry(home, { refs: [{ ref: REF, name: 'EagleWatch prod', repo: 'acme/widgets', kind: 'live', ...(flag ? { autoMigrations: true, autoSince: '2026-11-01T00:00:00Z' } : {}) }, { ref: DEV, name: 'Scratch', repo: 'acme/widgets', kind: 'dev' }] });
  }
  const repo = createTmpRepo();
  repo.git(['remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);
  repo.write(FILE, SQL);
  const head = repo.commit('init');
  const session = `test-${randomUUID()}`;
  const transcript = join(home, '.claude-t', 'projects', '-repo', `${session}.jsonl`);
  mkdirSync(join(home, '.claude-t', 'projects', '-repo'), { recursive: true });
  const dataSql = 'update t set a = 1 where id = 7';
  const block = (op === 'migration'
    ? buildBlock({ op, ref: REF, label: 'EagleWatch prod', name: NAME, file: FILE, head, repo: 'acme/widgets', dir: repo.dir, sql: shownSql, summary: 'adds c' })
    : buildBlock({ op, ref: REF, label: 'EagleWatch prod', repo: 'acme/widgets', dir: repo.dir, sql: dataSql, summary: 'fix' })).join('\n');
  const prompt = op === 'migration' ? `go migration ${NAME}` : `go data ${sha256Of(dataSql).slice(0, 12)}`;
  const promptId = `pid-${randomUUID()}`;
  const entries = [
    { type: 'user', message: { content: 'apply' }, promptId: `pid-${randomUUID()}`, ...OWNER_ENTRY, timestamp: new Date(typedAt - 5000).toISOString() },
    { type: 'assistant', message: { content: [{ type: 'text', text: block }] } },
    { type: 'user', message: { content: prompt }, promptId, ...OWNER_ENTRY, timestamp: new Date(typedAt).toISOString() },
  ];
  writeFileSync(transcript, linesOf(entries));
  const input = { hook_event_name: 'UserPromptSubmit', session_id: session, transcript_path: transcript, cwd: repo.dir, prompt, prompt_id: promptId };
  const out = liveDbGoOutcome(input, { home, now: () => typedAt });
  assert.ok(out?.record, JSON.stringify(out));
  const ctx = { home, sessionId: session, transcriptPath: transcript, now: () => NOW };
  return { home, repo, head, session, transcript, input, ctx, dataSql, entries };
}
const apply = (s, over = {}, ctx = {}) => evaluateSupabaseMcp(`${TOOL}apply_migration`, { project_id: REF, name: NAME, query: SQL, ...over }, { ...s.ctx, ...ctx });
const sql = (s, query, ctx = {}) => evaluateSupabaseMcp(`${TOOL}execute_sql`, { project_id: REF, query }, { ...s.ctx, ...ctx });
const consumed = (s) => join(STATE(s.home), 'owner-go', 'live-db-consumed');
const attempts = (s) => join(STATE(s.home), 'owner-go', 'live-db-attempts');
// the history files of a migration: kind 'name' | 'sql', generation n (ids as the module derives them: first 32 hex of sha256(`<kind>|<ref>|<name or sql sha>`))
const gfile = (s, kind, n, { name = NAME, sql: q = SQL } = {}) => join(attempts(s), `${kind}-${createHash('sha256').update(`${kind}|${REF}|${kind === 'name' ? name : sha256Of(q)}`).digest('hex').slice(0, 32)}-${n}.json`);
const seedGen = (s, n, atMs, keys = ['name', 'sql']) => {
  mkdirSync(attempts(s), { recursive: true });
  for (const kind of keys) writeFileSync(gfile(s, kind, n), `${JSON.stringify({ v: 1, event: `seed${n}`, at: new Date(atMs).toISOString(), via: 'go' })}\n`);
};
const body = (file) => JSON.parse(readFileSync(file, 'utf8'));
const markers = (s) => (existsSync(consumed(s)) ? readdirSync(consumed(s)) : []);

test('a matching go allows the apply once; the second identical apply is spent', async (t) => {
  const s = await scene(t);
  assert.equal(apply(s).decision, 'allow');
  const again = apply(s);
  assert.equal(again.decision, 'deny');
  assert.match(again.reason, /already used/);
  assert.match(again.reason, /check the live state read-only/);
  assert.equal(readdirSync(consumed(s)).length, 1);
});

test('one byte different, CRLF, trailing newline, BOM, another name, another project: refused, and the go is NOT burnt', async (t) => {
  const s = await scene(t);
  for (const query of [`${SQL}\n`, SQL.trimEnd(), SQL.replace(/\n/g, '\r\n'), `﻿${SQL}`, 'select 1;']) {
    const r = apply(s, { query });
    assert.equal(r.decision, 'deny', JSON.stringify(query));
    assert.match(r.reason, /sha256 [0-9a-f]{64} over \d+ bytes/);
  }
  assert.equal(apply(s, { name: 'other' }).decision, 'deny');
  assert.equal(apply(s, { project_id: 'qqqqqqqqqqqqqqqqqqqq' }).decision, 'deny');
  assert.equal(apply(s).decision, 'allow', 'the go still works for the exact call');
});

test('a go from another session, another transcript or the same prompt recorded twice: one apply at most', async (t) => {
  const s = await scene(t);
  assert.equal(apply(s, {}, { sessionId: 'someone-else' }).decision, 'deny');
  assert.equal(apply(s, {}, { transcriptPath: `${s.transcript}.other` }).decision, 'deny');
  liveDbGoOutcome(s.input, { home: s.home, now: () => NOW - 59_000 }); // a re-delivered hook: a second line for the same prompt
  assert.equal(apply(s).decision, 'allow');
  assert.equal(apply(s).decision, 'deny');
});

test('expiry is measured from the owner\'s prompt entry: exactly 2 h allows, 2 h + 1 ms denies, 6 min in the future denies; a re-recorded old go stays expired', async (t) => {
  const two = 2 * 60 * 60 * 1000;
  assert.equal(apply(await scene(t, { typedAt: NOW - two })).decision, 'allow');
  const late = await scene(t, { typedAt: NOW - two - 1 });
  assert.equal(apply(late).decision, 'deny');
  assert.match(apply(late).reason, /older than 2 hours/);
  assert.equal(apply(await scene(t, { typedAt: NOW + 6 * 60_000 })).decision, 'deny');
  const old = await scene(t, { typedAt: NOW - two - 5000 });
  liveDbGoOutcome(old.input, { home: old.home, now: () => NOW }); // re-delivered with a fresh record time but the old entry
  assert.equal(apply(old).decision, 'deny');
});

test('forgeries: made-up go text on a genuine prompt id, a prompt that is not the owner\'s, a block shown that differs from the record', async (t) => {
  const s = await scene(t);
  writeFileSync(s.transcript, linesOf(s.entries.map((e, i) => (i === 2 ? { ...e, message: { content: `go migration ${NAME}!` } } : e))));
  assert.equal(apply(s).decision, 'deny');
  writeFileSync(s.transcript, linesOf(s.entries.map((e, i) => (i === 2 ? { ...e, origin: { kind: 'task-notification' }, promptSource: 'system' } : e))));
  assert.equal(apply(s).decision, 'deny');
  // the record binds SQL A, but the block shown before the typed go was for SQL B
  const other = await scene(t);
  const shown = buildBlock({ op: 'migration', ref: REF, label: 'EagleWatch prod', name: NAME, file: FILE, head: other.head, repo: 'acme/widgets', dir: other.repo.dir, sql: SQL.replace('c int', 'd int'), summary: 'x' }).join('\n');
  writeFileSync(other.transcript, linesOf(other.entries.map((e, i) => (i === 1 ? { ...e, message: { content: [{ type: 'text', text: shown }] } } : e))));
  assert.equal(apply(other).decision, 'deny');
});

test('data: `go data` allows one execute_sql of exactly the fenced SQL; a different statement or whitespace is refused', async (t) => {
  const s = await scene(t, { op: 'data' });
  assert.equal(sql(s, `${s.dataSql}\n`).decision, 'deny');
  assert.equal(sql(s, s.dataSql.replace('7', '8')).decision, 'deny');
  assert.equal(sql(s, s.dataSql).decision, 'allow');
  assert.equal(sql(s, s.dataSql).decision, 'deny');
});

test('catalog templates need no go; other SQL does; unknown targets, untrusted servers and other writes are refused', async (t) => {
  const s = await scene(t);
  assert.equal(sql(s, buildCatalogQuery('tables', ['public'])).decision, 'allow');
  for (const q of ['select relname from pg_catalog.pg_class', 'select * from public.t', 'delete from t']) assert.equal(sql(s, q).decision, 'deny', q);
  for (const project_id of [undefined, null, 'ABC']) {
    assert.equal(evaluateSupabaseMcp(`${TOOL}apply_migration`, { project_id, name: NAME, query: SQL }, s.ctx).decision, 'deny', String(project_id));
    assert.equal(evaluateSupabaseMcp(`${TOOL}execute_sql`, { project_id, query: buildCatalogQuery('tables', ['public']) }, s.ctx).decision, 'deny');
    assert.equal(evaluateSupabaseMcp(`${TOOL}list_tables`, { project_id }, s.ctx).decision, 'allow');
  }
  assert.equal(evaluateSupabaseMcp('mcp__db__apply_migration', { project_id: REF, name: NAME, query: SQL }, s.ctx).decision, 'deny', 'a renamed server is not trusted, go or no go');
  assert.equal(evaluateSupabaseMcp('mcp__db__list_tables', { project_id: REF }, s.ctx).decision, 'allow');
  assert.equal(isSupabaseTool('mcp__db__apply_migration'), true);
  assert.equal(isSupabaseTool('mcp__notes__create_note'), false);
  for (const tool of ['mcp__github__create_branch', 'mcp__sentry__create_project', 'mcp__linear__create_project', 'mcp__neon__delete_branch', 'mcp__jupyter__run_notebook', 'mcp__gitlab__merge_branch']) assert.equal(isSupabaseTool(tool), false, tool);
  for (const tool of ['mcp__db__execute_sql', 'mcp__db__deploy_edge_function', 'mcp__my_supabase_x__create_branch', 'mcp__supabase__pause_project']) assert.equal(isSupabaseTool(tool), true, tool);
  for (const n of ['merge_branch', 'deploy_edge_function', 'run_notebook', 'pause_project']) assert.equal(evaluateSupabaseMcp(`${TOOL}${n}`, { project_id: REF }, s.ctx).decision, 'deny', n);
  assert.equal(evaluateSupabaseMcp(`${TOOL}query_logs`, { project_id: REF }, s.ctx).decision, 'allow');
  assert.equal(evaluateSupabaseMcp('mcp__supabase__apply_migration', { project_id: REF, name: NAME, query: SQL }, s.ctx).decision, 'allow', 'the bare `supabase` server is trusted too');
});

// #701 / #746: the refusal of a plain read points at the read-only CLI form, and the guard itself allows that form (file only: an inline form lets the shell rewrite the SQL)
test('an execute_sql refusal for a read hints a db query command the Bash guard allows', async (t) => {
  const s = await scene(t);
  const query = 'select count(*) from public.t';
  const d = sql(s, query);
  assert.equal(d.decision, 'deny');
  const m = d.reason.match(new RegExp(`\`(supabase db query --read-only --remote=${REF} -f <file\\.sql>)\``));
  assert.ok(m, d.reason);
  const opts = { home: s.home, env: {}, platform: 'linux', realpath: (p) => p, existsSync: () => false, cwd: '/repo' };
  const fileForm = m[1].replace('<file.sql>', '/tmp/q.sql');
  assert.equal(evaluateBashForFiles(fileForm, opts).decision, 'allow', fileForm);
  assert.doesNotMatch(d.reason, /inline/, 'no inline form: the shell expands $ and backticks inside double quotes');
});

test('dev refs are exempt only on a server the owner listed', async (t) => {
  const s = await scene(t);
  const call = (tool) => evaluateSupabaseMcp(tool, { project_id: DEV, name: 'x', query: 'drop table t' }, s.ctx).decision;
  assert.equal(call(`${TOOL}apply_migration`), 'deny');
  runOwnerCli(s.home, ['server', 'add', 'mine']);
  assert.equal(call('mcp__mine__apply_migration'), 'allow');
});

test('a server the owner listed is a Supabase server for every tool name; another vendor\'s tools stay untouched', async (t) => {
  const s = await scene(t);
  runOwnerCli(s.home, ['server', 'add', 'mine']);
  const state = { servers: ['mine'] };
  assert.equal(isSupabaseTool('mcp__mine__merge_branch', state), true);
  assert.equal(isSupabaseTool('mcp__mine__merge_branch'), false);
  assert.equal(isSupabaseTool('mcp__github__create_branch', state), false);
  const file = (tool_name, tool_input) => evaluateFileTool({ tool_name, tool_input, cwd: s.repo.dir, session_id: s.session, transcript_path: s.transcript }, { home: s.home, env: {}, platform: process.platform, now: () => NOW }).decision;
  assert.equal(file('mcp__mine__merge_branch', { project_id: REF, branch_id: 'x' }), 'deny');
  assert.equal(file('mcp__mine__pause_project', { project_id: REF }), 'deny');
  assert.equal(file('mcp__github__create_branch', { branch: 'x' }), 'allow');
});

test('a declared-dev project on a server the owner has not listed is told to list the server, not to ask for a go', async (t) => {
  const s = await scene(t);
  for (const name of ['apply_migration', 'execute_sql', 'pause_project']) {
    const v = evaluateSupabaseMcp(`${TOOL}${name}`, { project_id: DEV, name: 'x', query: 'drop table t' }, s.ctx);
    assert.equal(v.decision, 'deny', name);
    assert.match(v.reason, /declared dev/);
    assert.match(v.reason, /db-refs server add plugin_supabase_supabase/);
    assert.doesNotMatch(v.reason, /live-db present/);
  }
});

test('through the real guard entry: another server\'s create_branch / create_project is not a Supabase write', async (t) => {
  const s = await scene(t);
  const file = (tool_name, tool_input) => evaluateFileTool({ tool_name, tool_input, cwd: s.repo.dir, session_id: s.session, transcript_path: s.transcript }, { home: s.home, env: {}, platform: process.platform, now: () => NOW }).decision;
  assert.equal(file('mcp__github__create_branch', { branch: 'x' }), 'allow');
  assert.equal(file('mcp__sentry__create_project', { name: 'x' }), 'allow');
  assert.equal(file('mcp__supabase__create_branch', { name: 'x' }), 'deny');
});

test('a registry that cannot be read denies every write and still allows reads', async (t) => {
  const s = await scene(t);
  writeFileSync(join(STATE(s.home), 'db-refs.json'), '{bad');
  assert.equal(apply(s).decision, 'deny');
  assert.equal(evaluateSupabaseMcp(`${TOOL}list_tables`, { project_id: REF }, s.ctx).decision, 'allow');
});

test('a registry that cannot be read or is invalid denies a generic write on any server; a missing registry leaves other vendors alone', async (t) => {
  const s = await scene(t);
  runOwnerCli(s.home, ['server', 'add', 'mine']);
  const file = (tool_name, tool_input) => evaluateFileTool({ tool_name, tool_input, cwd: s.repo.dir, session_id: s.session, transcript_path: s.transcript }, { home: s.home, env: {}, platform: process.platform, now: () => NOW });
  const registry = join(STATE(s.home), 'db-refs.json');
  writeFileSync(registry, JSON.stringify({ v: 1, refs: [{ ref: 'bad', name: 'x', kind: 'dev' }], servers: ['mine'] }));
  const invalid = file('mcp__mine__merge_branch', { project_id: REF, branch_id: 'x' });
  assert.equal(invalid.decision, 'deny');
  assert.match(invalid.reason, /registry/);
  assert.equal(file('mcp__mine__list_tables', { project_id: REF }).decision, 'allow');
  rmSync(registry);
  mkdirSync(registry); // a directory where the file should be: unreadable
  const unreadable = file('mcp__mine__merge_branch', { project_id: REF, branch_id: 'x' });
  assert.equal(unreadable.decision, 'deny');
  assert.match(unreadable.reason, /unreadable/);
  rmSync(registry, { recursive: true });
  assert.equal(file('mcp__github__create_branch', { branch: 'x' }).decision, 'allow', 'no registry file: as today');
});

test('the marker is durable or the call is denied: write, fsync and close failures deny and the leftover marker stays spent', async (t) => {
  for (const [fault, io] of [
    ['write', { writeSync: () => { throw new Error('disk'); } }],
    ['fsync', { fsyncSync: () => { throw new Error('disk'); } }],
    ['close', { closeSync: () => { throw new Error('disk'); } }],
  ]) {
    const s = await scene(t);
    assert.equal(apply(s, {}, { io }).decision, 'deny', fault);
    assert.equal(apply(s).decision, 'deny', `${fault}: spent afterwards`);
  }
});

test('a symlinked consumed folder denies; an empty marker file counts as spent', async (t) => {
  const s = await scene(t);
  mkdirSync(join(STATE(s.home), 'owner-go'), { recursive: true });
  symlinkSync(s.home, consumed(s));
  assert.equal(apply(s).decision, 'deny');
  rmSync(consumed(s));
  assert.equal(apply(s).decision, 'allow');
  const [marker] = readdirSync(consumed(s));
  writeFileSync(join(consumed(s), marker), '');
  assert.equal(claimLiveDbGo({ home: s.home, sessionId: s.session, transcriptPath: s.transcript, op: 'migration', projectRef: REF, name: NAME, sqlSha256: sha256Of(SQL), now: () => NOW }).status, 'spent');
});

test('coexistence: the live-db markers sit in their own folder, never in consumed/ (the round-grant readers read it)', async (t) => {
  const s = await scene(t);
  assert.equal(apply(s).decision, 'allow');
  assert.ok(!existsSync(join(STATE(s.home), 'owner-go', 'consumed')));
  assert.equal(LIVE_DB_CONSUMED_REL, '.claude/pipeline-state/owner-go/live-db-consumed');
  assert.ok(readdirSync(consumed(s)).every((n) => /^[0-9a-f]{32}\.json$/.test(n)));
});

test('through the real guard entry: a call another rule denies leaves the go unclaimed; the admin switch allows', async (t) => {
  const s = await scene(t);
  const file = (tool_name, tool_input, env = {}) => evaluateFileTool({ tool_name, tool_input, cwd: s.repo.dir, session_id: s.session, transcript_path: s.transcript }, { home: s.home, env, platform: process.platform, now: () => NOW }).decision;
  const refersToProtected = `${SQL}-- ${s.home}/.claude/pipeline/hooks/guard-files.mjs`;
  assert.equal(file(`${TOOL}apply_migration`, { project_id: REF, name: NAME, query: refersToProtected }), 'deny');
  assert.equal(file(`${TOOL}apply_migration`, { project_id: REF, name: NAME, query: SQL }), 'allow');
  assert.equal(file(`${TOOL}apply_migration`, { project_id: REF, name: NAME, query: SQL }), 'deny');
  assert.equal(file(`${TOOL}apply_migration`, { project_id: REF, name: NAME, query: 'drop table t' }, { [['PIPELINE', 'ADMIN'].join('_')]: '1' }), 'allow');
});

test('with the hook\'s real options (HOOK_CLOCK): a recorded go allows the apply once, no go denies (the go is judged by the epoch clock, not the process clock)', async (t) => {
  // Failure caught: the hooks passed a process-start clock as `now`, so every owner go looked years old and was refused (and pending clicks were settled as refused).
  const s = await scene(t, { typedAt: Date.now() - 60_000 });
  // (HOOK_CLOCK's origin is this process's start; the guard's time budget counts from it, and this test file outlives the 10 s cap, so the origin is taken at the test's own start: still an epoch time, still no injected `now`)
  const CLOCK = { ...HOOK_CLOCK, wall0: Date.now() };
  const file = (query) => evaluateFileTool({ tool_name: `${TOOL}apply_migration`, tool_input: { project_id: REF, name: NAME, query }, cwd: s.repo.dir, session_id: s.session, transcript_path: s.transcript }, { home: s.home, env: {}, platform: process.platform, ...CLOCK }).decision;
  assert.equal(file('drop table t'), 'deny', 'a call the go does not name is refused');
  assert.equal(file(SQL), 'allow', 'the go the owner typed allows the exact call');
  assert.equal(file(SQL), 'deny', 'and is spent');
});

// each child waits for the same wall-clock instant, then runs the full go claim once; -> the claims' statuses
function claimInChildren(home, scenes, now = NOW - 120_000) {
  const guardUrl = new URL('../pipeline/hooks/lib/live-db-guard.mjs', import.meta.url).href;
  const at = Date.now() + 1500;
  const child = `const { claimLiveDbGo } = await import(${JSON.stringify(guardUrl)});
const a = JSON.parse(process.argv[1]);
while (Date.now() < a.at) { /* start together */ }
const r = claimLiveDbGo({ home: a.home, sessionId: a.sessionId, transcriptPath: a.transcriptPath, op: a.op, projectRef: a.projectRef, name: a.name, sqlSha256: a.sqlSha256, now: () => a.now });
process.stdout.write(r.status);`;
  const runChild = (s) => new Promise((resolve, reject) => {
    const args = JSON.stringify({ home, sessionId: s.session, transcriptPath: s.transcript, op: 'migration', projectRef: REF, name: NAME, sqlSha256: sha256Of(SQL), at, now });
    const p = spawn(process.execPath, ['--input-type=module', '-e', child, args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`child exit ${code}: ${err}`))));
  });
  return Promise.all(scenes.map(runChild));
}

test('two processes claiming the same go on one home: exactly one claims, the other sees it spent', async (t) => {
  const s = await scene(t);
  const outcomes = (await claimInChildren(s.home, [s, s], NOW)).sort();
  assert.deepEqual(outcomes, ['claimed', 'spent']);
  assert.equal(readdirSync(consumed(s)).length, 1);
});

// rollback safety: the previous release's owner-go.mjs (the commit before the live-db records existed) reads a home that holds live-db go records and markers
const OLD_OWNER_GO = 'bd202a3e';
const haveOld = (() => { try { execFileSync('git', ['cat-file', '-e', `${OLD_OWNER_GO}^{commit}`], { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'ignore' }); return true; } catch { return false; } })();

// (a shallow CI checkout does not hold that commit: only then is the test not run, and it says why)
test('coexistence: the previous owner-go.mjs still reads a home that holds live-db go records, markers and attempt history', { skip: haveOld ? false : `commit ${OLD_OWNER_GO} is not in this checkout (shallow clone)` }, async (t) => {
  const s = await scene(t, { flag: true });
  assert.equal(apply(s).decision, 'allow'); // a go record in owner-go/<session>.jsonl, a marker in live-db-consumed/ and the generation files of live-db-attempts/
  assert.ok(readdirSync(attempts(s)).length === 2);
  assert.ok(readdirSync(consumed(s)).length === 1);
  // the old module with everything it imports, from git history, in its own folder
  const old = mkdtempSync(join(tmpdir(), 'cp-old-owner-go-'));
  t.after(() => rmSync(old, { recursive: true, force: true }));
  const tar = execFileSync('git', ['archive', OLD_OWNER_GO, 'pipeline'], { cwd: fileURLToPath(new URL('..', import.meta.url)), maxBuffer: 256 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', old], { input: tar });
  const prior = await import(pathToFileURL(join(old, 'pipeline', 'hooks', 'lib', 'owner-go.mjs')).href);
  const grant = () => {
    const prompt = 'extra round';
    return { kind: 'extra-round', session: s.session, ts: new Date(NOW).toISOString(), prompt_sha256: createHash('sha256').update(prompt).digest('hex'), repo: 'acme/widgets', pr: 7, k: 1, head: 'a'.repeat(40), prompt };
  };
  const problems = [];
  assert.deepEqual(prior.readApprovals({ home: s.home, now: () => NOW, settle: false }), [], 'a live-db go is no merge approval');
  prior.readRecords({ home: s.home, now: () => NOW, problems, settle: false });
  assert.deepEqual(problems, [], 'the old reader finds nothing unreadable');
  assert.equal(prior.roundCoverage(grant(), { home: s.home, repo: 'acme/widgets', moves: [] }), 'absent', 'the round-grant coverage reader still answers ok (not indeterminate)');
});

// ---- #687: a Supabase MCP server added under another name ----------------------------------------------------------------------------------
// Failure caught: the real Supabase MCP server configured under an innocent name (`mine`) lets merge_branch / reset_branch / pause_project / run_notebook / create_project through as ordinary tools (they are
// judged only on a server named supabase or one the owner registered), so migrations merge into production or the live app pauses with no owner go. No registered server anywhere in these fixtures.
const ACCOUNT_FILE = ['', 'claude.json'].join('.'); // the session's account file name
const SUPA_HTTP = { type: 'http', url: 'https://mcp.supabase.com/mcp?project_ref=x' };
const SUPA_STDIO = { command: 'npx', args: ['-y', '@supabase/mcp-server-supabase@0.19.0', '--project-ref=x'] };
const VENDOR = { command: 'node', args: ['vendor-mcp.js'] };
const CONFIG_HINT = /recognised as Supabase from this session's MCP configuration of server mine/;
const SHAPE_HINT = /recognised as Supabase by its input only/;
const GENERIC_CALLS = {
  create_branch: [{ project_id: REF }, { project_id: REF, name: 'x', confirm_cost_id: 'c' }],
  delete_branch: [{ branch_id: 'b' }],
  merge_branch: [{ branch_id: 'b' }],
  rebase_branch: [{ branch_id: 'b' }],
  reset_branch: [{ branch_id: 'b' }, { branch_id: 'b', migration_version: '1' }],
  create_project: [{ name: 'n', region: 'us-east-1', organization_id: 'o' }, { name: 'n', region: 'us-east-1', organization_id: 'o', confirm_cost_id: 'c' }],
  pause_project: [{ project_id: REF }],
  restore_project: [{ project_id: REF }],
  run_notebook: [{ project_id: REF, notebook_id: 'n', expected_updated_at: 'x' }, { project_id: REF, notebook_id: 'n', expected_updated_at: 'x', cells: ['select 1'] }],
  create_notebook: [{ project_id: REF, name: 'n', content: 'c' }, { project_id: REF, name: 'n', content: 'c', description: 'd' }],
  delete_notebook: [{ project_id: REF, notebook_id: 'n' }],
};

function mcpScene(t) {
  const root = mkdtempSync(join(tmpdir(), 'cp-mcp-alias-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const parent = join(root, 'repo');
  const proj = join(parent, 'pkg');
  const cwd = join(root, 'cwd'); // the hook's cwd is NOT the session's project dir
  const acct = join(root, 'acct');
  for (const d of [home, proj, cwd, acct]) mkdirSync(d, { recursive: true });
  const put = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
  const env = (extra = {}) => ({ CLAUDE_PROJECT_DIR: proj, ...extra });
  const run = (tool, input, e = env()) => evaluateFileTool({ tool_name: tool, tool_input: input, cwd, session_id: 's-mcp', transcript_path: join(root, 't.jsonl') }, { home, env: e, platform: process.platform, now: () => NOW });
  const user = (servers) => put(join(home, ACCOUNT_FILE), { mcpServers: servers });
  return { root, home, parent, proj, cwd, acct, put, env, run, user };
}
const denied = (r, hint, label) => {
  assert.equal(r.decision, 'deny', label);
  assert.match(r.reason, hint, label);
};

test('#687 config, user layer: every generic write on a server the session\'s configuration points at Supabase is refused, by the config route and not by input shape', async (t) => {
  const s = mcpScene(t);
  s.user({ mine: SUPA_HTTP });
  for (const [name, inputs] of Object.entries(GENERIC_CALLS)) {
    for (const input of inputs) {
      const r = s.run(`mcp__mine__${name}`, input);
      denied(r, CONFIG_HINT, `${name} ${JSON.stringify(input)}`);
      assert.match(r.reason, 'project_id' in input ? /db-refs server add mine/ : /target is unknown/, name);
    }
  }
  // an extra benign key is a call input shape would decline: only the configuration can still recognise it
  denied(s.run('mcp__mine__merge_branch', { branch_id: 'b', note: 'x' }), CONFIG_HINT, 'merge_branch + extra key');
});

test('#687 config, local and project layers (the project and its parent directory), and CLAUDE_CONFIG_DIR picks the account file', async (t) => {
  const projectScoped = [['create_branch', {}], ['create_branch', { name: 'x' }], ['run_notebook', { notebook_id: 'n', expected_updated_at: 'x' }], ['delete_notebook', { notebook_id: 'n' }], ['create_notebook', { name: 'n', content: 'c' }], ['merge_branch', { branch_id: 'b', note: 'x' }]];
  const layers = {
    'local, project dir': (s) => s.put(join(s.home, ACCOUNT_FILE), { projects: { [s.proj]: { mcpServers: { mine: SUPA_STDIO } } } }),
    'local, parent dir (git-root keying)': (s) => s.put(join(s.home, ACCOUNT_FILE), { projects: { [s.parent]: { mcpServers: { mine: SUPA_STDIO } } } }),
    'project .mcp.json': (s) => s.put(join(s.proj, '.mcp.json'), { mcpServers: { mine: SUPA_STDIO } }),
    'parent .mcp.json': (s) => s.put(join(s.parent, '.mcp.json'), { mcpServers: { mine: SUPA_STDIO } }),
  };
  for (const [layer, setup] of Object.entries(layers)) {
    const s = mcpScene(t);
    setup(s);
    for (const [name, input] of projectScoped) denied(s.run(`mcp__mine__${name}`, input), CONFIG_HINT, `${layer}: ${name} ${JSON.stringify(input)}`);
  }
  // a config key with a dot is the tool segment with an underscore
  const dotted = mcpScene(t);
  dotted.user({ 'db.prod': SUPA_HTTP });
  denied(dotted.run('mcp__db_prod__merge_branch', { branch_id: 'b', note: 'x' }), /server db_prod/, 'db.prod -> db_prod');
  // CLAUDE_CONFIG_DIR: the account dir's file is the session's, the home file is not
  const a = mcpScene(t);
  a.user({ mine: VENDOR });
  a.put(join(a.acct, ACCOUNT_FILE), { mcpServers: { mine: SUPA_HTTP } });
  denied(a.run('mcp__mine__merge_branch', { branch_id: 'b', note: 'x' }, a.env({ CLAUDE_CONFIG_DIR: a.acct })), CONFIG_HINT, 'account dir Supabase, home vendor');
  const b = mcpScene(t);
  b.user({ mine: SUPA_HTTP });
  b.put(join(b.acct, ACCOUNT_FILE), { mcpServers: { mine: VENDOR } });
  assert.equal(b.run('mcp__mine__merge_branch', { branch_id: 'b', note: 'x' }, b.env({ CLAUDE_CONFIG_DIR: b.acct })).decision, 'allow', 'account dir vendor, home Supabase');
});

test('#687 collisions: another project\'s or account\'s same-named server is not this session\'s; a positive match wins; an unset project dir is unknown, not absent', async (t) => {
  // (a) an unrelated directory's Supabase `db` does not turn the session's vendor `db` into Supabase
  const a = mcpScene(t);
  a.put(join(a.home, ACCOUNT_FILE), { mcpServers: { db: VENDOR }, projects: { [join(a.root, 'unrelated')]: { mcpServers: { db: SUPA_STDIO } } } });
  assert.equal(a.run('mcp__db__delete_branch', { branch_id: 'b', strategy: 'x' }).decision, 'allow', 'vendor db, collision elsewhere: a foreign key is not Supabase-shaped');
  denied(a.run('mcp__db__delete_branch', { branch_id: 'b' }), SHAPE_HINT, 'vendor db, collision elsewhere: the unrelated Supabase entry is not this session\'s, so shape decides');
  // (b) another account dir's Supabase `db`; the session has none: the shape fallback decides
  const b = mcpScene(t);
  b.put(join(b.acct, ACCOUNT_FILE), { mcpServers: { db: SUPA_HTTP } });
  denied(b.run('mcp__db__delete_branch', { branch_id: 'b' }), SHAPE_HINT, 'unlocated, Supabase-shaped');
  assert.equal(b.run('mcp__db__delete_branch', { branch_id: 'b', strategy: 'x' }).decision, 'allow', 'unlocated, foreign key');
  // (c) a project vendor `db` beside a user-layer Supabase `db`: the Supabase entry wins
  const c = mcpScene(t);
  c.user({ db: SUPA_HTTP });
  c.put(join(c.proj, '.mcp.json'), { mcpServers: { db: VENDOR } });
  denied(c.run('mcp__db__delete_branch', { branch_id: 'b', note: 'x' }), /configuration of server db/, 'positive match wins');
  // (d) no CLAUDE_PROJECT_DIR: the local and project layers are unknown, so a user-layer vendor does not clear the call
  const d = mcpScene(t);
  d.user({ db: VENDOR });
  denied(d.run('mcp__db__delete_branch', { branch_id: 'b' }, {}), SHAPE_HINT, 'project dir unset');
  denied(d.run('mcp__db__delete_branch', { branch_id: 'b' }), SHAPE_HINT, 'same config, project dir set: a configured vendor still gets the shape check');
});

test('#687 identity: bridges, docker, a local build and the access-token env are Supabase; an incidental path and the owner\'s own function URL are not; an expanded URL or a legacy config file leaves the server unidentified', async (t) => {
  const supa = {
    'mcp-remote bridge': { command: 'npx', args: ['-y', 'mcp-remote', 'https://mcp.supabase.com/mcp'] },
    docker: { command: 'docker', args: ['run', '-i', '--rm', 'mcp/supabase:latest'] },
    'local build': { command: 'node', args: ['/x/mcp-server-supabase/dist/transports/stdio.js'] },
    'access token env': { command: 'node', args: ['vendor.js'], env: { SUPABASE_ACCESS_TOKEN: 'synthetic' } },
    'windows npm shim': { command: 'cmd.exe', args: ['/c', 'C:\\Users\\x\\AppData\\Roaming\\npm\\mcp-server-supabase.cmd', '--read-only'] },
    'windows exe shim': { command: 'C:\\tools\\mcp-server-supabase.exe' },
    'bash one-string launcher': { command: 'bash', args: ['-lc', 'npx -y @supabase/mcp-server-supabase --read-only'] },
    'cmd one-string launcher': { command: 'cmd', args: ['/c', '"npx -y @supabase/mcp-server-supabase@latest"'] },
    'sh one-string bridge': { command: 'sh', args: ['-c', 'npx -y mcp-remote https://mcp.supabase.com/mcp'] },
  };
  for (const [label, entry] of Object.entries(supa)) {
    const s = mcpScene(t);
    s.user({ mine: entry });
    denied(s.run('mcp__mine__merge_branch', { branch_id: 'b', note: 'x' }), CONFIG_HINT, label);
  }
  const other = {
    'incidental path': { command: 'node', args: ['/work/supabase-tools/vendor.js'] },
    'other vendor one-string launcher': { command: 'bash', args: ['-lc', 'npx -y @vendor/mcp-server --read-only'] },
    'own edge function': { type: 'http', url: 'https://myref.supabase.co/functions/v1/my-mcp' },
  };
  for (const [label, entry] of Object.entries(other)) {
    const s = mcpScene(t);
    s.user({ mine: entry });
    assert.equal(s.run('mcp__mine__merge_branch', { branch_id: 'b', note: 'x' }).decision, 'allow', label);
    denied(s.run('mcp__mine__merge_branch', { branch_id: 'b' }), SHAPE_HINT, `${label}: a configured vendor does not vouch for the server (launch-time bindings are invisible): judged by shape`);
  }
  // a launch-time server (--mcp-config / managed file) can reuse a configured vendor's name: the config never switches the shape check off
  const acme = mcpScene(t);
  acme.user({ mine: { command: 'npx', args: ['-y', '@acme/mcp'] } });
  denied(acme.run('mcp__mine__pause_project', { project_id: 'p' }), SHAPE_HINT, 'configured acme, pause_project');
  denied(acme.run('mcp__mine__merge_branch', { branch_id: 'b' }), SHAPE_HINT, 'configured acme, merge_branch');
  for (const [tool, input] of [['mcp__mine__create_branch', { owner: 'o', repo: 'r', branch: 'b' }], ['mcp__mine__create_branch', { project_id: '1', branch: 'b', ref: 'main' }], ['mcp__mine__delete_branch', { projectId: 'p', branchId: 'b' }]]) {
    assert.equal(acme.run(tool, input).decision, 'allow', `configured acme: ${tool} ${JSON.stringify(input)}`);
  }
  const expanded = mcpScene(t);
  expanded.user({ mine: { type: 'http', url: '${MCP_URL}' } });
  assert.equal(expanded.run('mcp__mine__merge_branch', { branch_id: 'b', note: 'x' }).decision, 'allow');
  denied(expanded.run('mcp__mine__merge_branch', { branch_id: 'b' }), SHAPE_HINT, 'unresolved URL falls to the shape check');
  const legacy = mcpScene(t);
  legacy.put(join(legacy.acct, ACCOUNT_FILE), { mcpServers: { mine: VENDOR } });
  legacy.put(join(legacy.acct, '.config.json'), {});
  denied(legacy.run('mcp__mine__merge_branch', { branch_id: 'b' }, legacy.env({ CLAUDE_CONFIG_DIR: legacy.acct })), SHAPE_HINT, 'legacy config file: the vendor entry is not trusted');
});

test('#687 shape fallback: an unlocated server with a Supabase-identical input is refused, other vendors\' inputs and Sentry\'s create_project are not; an unreadable file never lets a call through', async (t) => {
  const s = mcpScene(t);
  denied(s.run('mcp__plugin_x_db__merge_branch', { branch_id: 'b' }), SHAPE_HINT, 'plugin server');
  for (const [tool, input] of [['mcp__github__create_branch', { owner: 'o', repo: 'r', branch: 'b' }], ['mcp__neon__delete_branch', { projectId: 'p', branchId: 'b' }], ['mcp__gitlab__create_branch', { project_id: '1', branch: 'b', ref: 'main' }], ['mcp__sentry__create_project', { name: 'x' }], ['mcp__github__create_branch', { branch: 'x' }]]) {
    assert.equal(s.run(tool, input).decision, 'allow', tool);
  }
  const corrupt = mcpScene(t);
  corrupt.put(join(corrupt.home, ACCOUNT_FILE), '{not json');
  denied(corrupt.run('mcp__vendor__delete_branch', { branch_id: 'b' }), SHAPE_HINT, 'corrupt account file');
  const badProject = mcpScene(t);
  badProject.user({ mine: SUPA_HTTP });
  badProject.put(join(badProject.proj, '.mcp.json'), '{not json');
  denied(badProject.run('mcp__mine__merge_branch', { branch_id: 'b', note: 'x' }), CONFIG_HINT, 'corrupt project file, Supabase user entry');
});

test('#687 units: no ctx keeps today\'s answers; a non-object input is never Supabase-shaped; a symlinked or 9 MB account file is an unknown layer', async (t) => {
  const { supabaseMatch } = await import('../pipeline/hooks/lib/live-db-guard.mjs');
  const { activeBinding } = await import('../pipeline/hooks/lib/mcp-servers.mjs');
  assert.equal(isSupabaseTool('mcp__mine__merge_branch', { ok: true, servers: [] }), false, 'no ctx: rule 5 skipped');
  assert.equal(isSupabaseTool('mcp__mine__merge_branch', undefined), false);
  const s = mcpScene(t);
  const ctx = { home: s.home, env: s.env() };
  for (const ti of [null, undefined, [], 'branch_id', 7]) assert.equal(supabaseMatch('mcp__plugin_x_db__merge_branch', { ok: true, servers: [] }, ti, ctx), null, JSON.stringify(ti));
  assert.equal(supabaseMatch('mcp__plugin_x_db__merge_branch', { ok: true, servers: [] }, { branch_id: 'b' }, ctx), 'shape');
  assert.equal(supabaseMatch('mcp__mine__merge_branch', { ok: true, servers: ['mine'] }, {}, ctx), 'registry');
  const stateOf = (binding, layer) => binding.layers.find((l) => l.layer === layer)?.state;
  s.put(join(s.home, ACCOUNT_FILE), ' '.repeat(9 * 1024 * 1024) + '{}');
  assert.equal(stateOf(activeBinding('mine', ctx), 'user'), 'unknown', '9 MB');
  rmSync(join(s.home, ACCOUNT_FILE));
  s.put(join(s.root, 'real.json'), { mcpServers: { mine: SUPA_HTTP } });
  symlinkSync(join(s.root, 'real.json'), join(s.home, ACCOUNT_FILE));
  assert.equal(stateOf(activeBinding('mine', ctx), 'user'), 'unknown', 'symlink');
});

// ---- auto-apply, Task 2: the attempt history of a go-claimed migration on a project whose owner switched auto-apply on ----------------------------------------------------------

test('switch off: a go apply reads and writes no history and refuses nothing new', async (t) => {
  // Failure caught: the history rules leaking into a project without the flag (a broken or hostile history folder would then refuse every owner go).
  const s = await scene(t);
  mkdirSync(join(STATE(s.home), 'owner-go'), { recursive: true });
  writeFileSync(attempts(s), 'not a folder');
  assert.equal(apply(s).decision, 'allow');
  assert.equal(readFileSync(attempts(s), 'utf8'), 'not a folder');
});

test('flag on: a go-claimed apply records generation 1 under its name and its SQL; a second go typed after it records generation 2', async (t) => {
  // Failure caught: an allowed apply that leaves no durable record, so a later call cannot tell the migration was attempted.
  const s = await scene(t, { flag: true });
  assert.equal(apply(s).decision, 'allow');
  const [n1, q1] = [body(gfile(s, 'name', 1)), body(gfile(s, 'sql', 1))];
  assert.equal(n1.via, 'go');
  assert.equal(n1.event, q1.event);
  assert.equal(n1.pair, basename(gfile(s, 'sql', 1)));
  assert.equal(q1.pair, basename(gfile(s, 'name', 1)));
  assert.equal(n1.name, NAME);
  assert.equal(n1.ref, REF);
  const later = await scene(t, { flag: true, home: s.home, typedAt: NOW + 30_000 });
  assert.equal(apply(later, {}, { now: () => NOW + 60_000 }).decision, 'allow');
  assert.ok(existsSync(gfile(s, 'name', 2)) && existsSync(gfile(s, 'sql', 2)));
  assert.notEqual(body(gfile(s, 'name', 2)).event, n1.event);
});

test('flag on: a failed attempt, then two gos in two sessions: only the first go applies', async (t) => {
  // Failure caught: two sessions each holding a fresh go after one failed attempt both applying (a double apply).
  const a = await scene(t, { flag: true, typedAt: NOW - 300_000 });
  const b = await scene(t, { home: a.home, typedAt: NOW - 240_000 });
  seedGen(a, 1, NOW - 600_000);
  const clock = { now: () => NOW - 120_000 };
  assert.equal(apply(a, {}, clock).decision, 'allow');
  assert.equal(body(gfile(a, 'name', 2)).at, new Date(NOW - 120_000).toISOString());
  const denied = apply(b, {}, clock);
  assert.equal(denied.decision, 'deny');
  assert.match(denied.reason, /after this go/);
  assert.equal(markers(a).length, 1, 'the second go is not consumed');
});

test('flag on: an old go cannot apply after a later attempt; a go typed after it can; a go stamped in the future cannot retry', async (t) => {
  // Failure caught: a go given before a failed attempt (or stamped ahead of the clock) applying again once the owner has not looked at the live state.
  const old = await scene(t, { flag: true, typedAt: NOW - 60_000 });
  seedGen(old, 1, NOW - 30_000);
  assert.equal(apply(old).decision, 'deny');
  assert.equal(markers(old).length, 0, 'the old go is not consumed');
  const fresh = await scene(t, { home: old.home, typedAt: NOW - 10_000 });
  assert.equal(apply(fresh).decision, 'allow');
  const ahead = await scene(t, { flag: true, typedAt: NOW + 60_000 });
  seedGen(ahead, 1, NOW - 30_000);
  assert.equal(apply(ahead).decision, 'deny');
  assert.equal(markers(ahead).length, 0);
});

test('flag on: an empty generation counts at its mtime; a gap, a folder, a symlink or an unreadable folder refuses naming the path', async (t) => {
  // Failure caught: a half-written or tampered history read as "no attempt" (a retry allowed) instead of refusing.
  const empty = await scene(t, { flag: true, typedAt: NOW - 60_000 });
  mkdirSync(attempts(empty), { recursive: true });
  writeFileSync(gfile(empty, 'name', 1), '');
  utimesSync(gfile(empty, 'name', 1), new Date(NOW - 30_000), new Date(NOW - 30_000));
  const recent = apply(empty);
  assert.equal(recent.decision, 'deny');
  assert.match(recent.reason, /after this go/);
  const older = await scene(t, { flag: true, typedAt: NOW - 10_000 });
  mkdirSync(attempts(older), { recursive: true });
  writeFileSync(gfile(older, 'sql', 1), '{"v":1,"at":');
  utimesSync(gfile(older, 'sql', 1), new Date(NOW - 30_000), new Date(NOW - 30_000));
  assert.equal(apply(older).decision, 'allow', 'a partial file older than the go does not block it');
  const gap = await scene(t, { flag: true });
  seedGen(gap, 2, NOW - 90_000, ['name']);
  const g = apply(gap);
  assert.equal(g.decision, 'deny');
  assert.ok(g.reason.includes(gfile(gap, 'name', 1)), g.reason);
  const dir = await scene(t, { flag: true });
  mkdirSync(gfile(dir, 'sql', 1), { recursive: true });
  assert.ok(apply(dir).reason.includes(gfile(dir, 'sql', 1)));
  const link = await scene(t, { flag: true });
  mkdirSync(attempts(link), { recursive: true });
  writeFileSync(join(link.home, 'target'), '{}');
  symlinkSync(join(link.home, 'target'), gfile(link, 'name', 1));
  assert.ok(apply(link).reason.includes(gfile(link, 'name', 1)));
  const full = await scene(t, { flag: true });
  seedGen(full, 1, NOW - 90_000);
  for (let n = 2; n <= 65; n += 1) seedGen(full, n, NOW - 90_000, ['name']);
  assert.ok(apply(full).reason.includes(gfile(full, 'name', 65)), 'generation 65 is more than the guard keeps');
  const folderFile = await scene(t, { flag: true });
  mkdirSync(join(STATE(folderFile.home), 'owner-go'), { recursive: true });
  writeFileSync(attempts(folderFile), 'x');
  assert.ok(apply(folderFile).reason.includes(attempts(folderFile)));
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const locked = await scene(t, { flag: true });
    seedGen(locked, 1, NOW - 90_000);
    chmodSync(attempts(locked), 0o000);
    let r;
    try { r = apply(locked); } finally { chmodSync(attempts(locked), 0o700); }
    assert.equal(r.decision, 'deny');
    assert.ok(r.reason.includes('live-db-attempts'), r.reason);
    assert.equal(markers(locked).length, 0);
  }
});

test('markers and folders are durable or the call is denied', async (t) => {
  // Failure caught: an allow whose marker was only partly written or whose folder entry was never made durable (a crash then forgets the attempt).
  for (const after of [0, 1]) {
    const s = await scene(t, { flag: true });
    // (a first call that writes 3 bytes of the consumed marker and then 0; or a first complete marker and a short history file)
    const calls = { n: 0 };
    const io = { writeSync: (fd, buf, off, len) => { calls.n += 1; if (calls.n <= after) return writeSync(fd, buf, off, len); return calls.n === after + 1 ? writeSync(fd, buf, off, Math.min(3, len)) : 0; } };
    assert.equal(apply(s, {}, { io }).decision, 'deny', `short write after ${after}`);
    assert.equal(apply(s).decision, 'deny', 'the leftover marker is spent');
  }
  const eio = await scene(t, { flag: true });
  const opened = { eio: (p, flags, mode) => { if (flags === 0 && String(p).endsWith('live-db-attempts')) throw Object.assign(new Error('eio'), { code: 'EIO' }); return openSync(p, flags, mode); } };
  assert.equal(apply(eio, {}, { io: { openSync: opened.eio } }).decision, 'deny', 'folder cannot be opened for its fsync');
  const first = await scene(t, { flag: true });
  mkdirSync(consumed(first), { recursive: true }); // (so only the history folder is created by the call)
  const paths = new Map();
  const io = {
    openSync: (p, flags, mode) => { const fd = openSync(p, flags, mode); paths.set(fd, String(p)); return fd; },
    fsyncSync: (fd) => { if (paths.get(fd)?.endsWith(`${join('pipeline-state', 'owner-go')}`)) throw Object.assign(new Error('eio'), { code: 'EIO' }); },
    closeSync: (fd) => { paths.delete(fd); closeSync(fd); },
  };
  assert.equal(apply(first, {}, { io }).decision, 'deny', 'the new history folder could not be made durable in its parent');
});

test('out of time: a go whose git reads find no time left is unverified (deny), never an allow; a scan of pending clicks stops when time runs out; too little time after verification does not burn the go', async (t) => {
  // Failure caught: a slow git or a folder of thousands of pending clicks carrying the hook past its 15 s host timeout (Claude Code then ALLOWS the call), or a slow call consuming the go and then refusing.
  const s = await scene(t, { flag: true });
  let spawns = 0;
  const counting = { git: (args, opts) => { spawns += 1; return realGit(args, opts); } };
  const r = apply(s, {}, { leftMs: () => 0, io: counting });
  assert.equal(r.decision, 'deny');
  assert.equal(spawns, 0, 'no git process was started');
  assert.equal(markers(s).length, 0);
  // 500 pending click pointers of other sessions: the scan stops after the time is gone
  const asks = join(STATE(s.home), 'owner-go', 'asks');
  mkdirSync(asks, { recursive: true });
  for (let i = 0; i < 500; i += 1) writeFileSync(join(asks, `ask-${i.toString(16).padStart(12, '0')}.${i.toString(16).padStart(16, '0')}.pending`), '{}');
  let asked = 0;
  const dying = apply(s, {}, { leftMs: () => (++asked <= 10 ? 5000 : 0) });
  assert.equal(dying.decision, 'deny');
  assert.ok(asked < 50, `${asked} time checks: the scan did not read every file`);
  assert.equal(markers(s).length, 0);
  rmSync(asks, { recursive: true, force: true });
  // verification done, 400 ms left: the go is not consumed
  let gits = 0;
  const slow = apply(s, {}, { leftMs: () => (gits >= 4 ? 400 : 5000), io: { git: (args, opts) => { gits += 1; return realGit(args, opts); } } });
  assert.equal(slow.decision, 'deny');
  assert.match(slow.reason, /try the call again/);
  assert.equal(markers(s).length, 0);
  assert.equal(apply(s).decision, 'allow', 'with time, the same go still works');
});

test('two gos of the same migration in two sessions after one failed attempt: exactly one allow (two processes)', async (t) => {
  // Failure caught: two sessions racing on fresh gos after a failed attempt both getting the allow.
  const a = await scene(t, { flag: true, typedAt: NOW - 300_000 });
  const b = await scene(t, { home: a.home, typedAt: NOW - 240_000 });
  seedGen(a, 1, NOW - 600_000);
  const outcomes = (await claimInChildren(a.home, [a, b])).sort();
  assert.deepEqual(outcomes, ['claimed', 'spent']);
  assert.ok(existsSync(gfile(a, 'name', 2)) && existsSync(gfile(a, 'sql', 2)));
  assert.ok(!existsSync(gfile(a, 'name', 3)));
});

// ---- auto-apply, Task 3: a migration a merged PR added is applied with no go when the owner switched it on ---------------------------------------------------------------------

const COMMIT = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const NAME2 = '20261117000001_add_col2';
const isoAt = (ms) => new Date(ms).toISOString();
const fileList = (nodes, next = null) => ({ pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes });
const prNode = (over = {}) => ({ number: 42, merged: true, baseRefName: 'main', baseRepository: { nameWithOwner: 'acme/widgets' }, mergeCommit: { oid: COMMIT }, files: fileList([{ path: FILE, changeType: 'ADDED' }]), ...over });
// GitHub's answer for an eligible file: on main, identical text, one history node (PR 42's merge commit, an hour old), the PR ADDED the file
const ghBase = ({ name = NAME, text = SQL, head = HEAD_SHA } = {}) => ({ data: { repository: { nameWithOwner: 'acme/widgets', defaultBranchRef: { name: 'main', target: { oid: head, file: { object: { text, isBinary: false, isTruncated: false } }, history: { nodes: [{ oid: COMMIT, committedDate: isoAt(NOW - 3_600_000), associatedPullRequests: { nodes: [prNode({ files: fileList([{ path: `supabase/migrations/${name}.sql`, changeType: 'ADDED' }]) })] } }] } } } } } });
const tip = (a) => a.data.repository.defaultBranchRef.target;
const firstCommit = (a) => tip(a).history.nodes[0];
const firstPr = (a) => firstCommit(a).associatedPullRequests.nodes[0];
const GH_OK = { code: 0, stdout: '', stderr: '', timedOut: false, overBuffer: false };

// No go anywhere: a scratch home with the registry (REF flagged unless `flag` is false), the history folder, and a fake gh that records its calls and answers from `s.answer()` (or `s.respond(args, opts)`: a partial gh result)
async function autoScene(t, { flag = true, since = '2026-11-01T00:00:00Z', refs = [], deploy = null } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'cp-live-db-auto-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  seedRegistry(home, { refs: [{ ref: REF, name: 'EagleWatch prod', repo: 'acme/widgets', kind: 'live', ...(flag ? { autoMigrations: true, autoSince: since, ...(deploy ?? {}) } : {}) }, ...refs] });
  mkdirSync(attempts({ home }), { recursive: true });
  const s = { home, calls: [], answer: () => ghBase(), respond: null };
  s.tweak = (fn, over) => { s.answer = () => { const a = ghBase(over); fn(a); return a; }; };
  s.gh = (args, opts) => { s.calls.push({ args, opts }); return { ...GH_OK, ...(s.respond ? s.respond(args, opts) : { stdout: JSON.stringify(s.answer()) }) }; };
  s.ctx = { home, sessionId: `auto-${randomUUID()}`, transcriptPath: join(home, 'none.jsonl'), now: () => NOW, io: { gh: s.gh } };
  return s;
}
const hist = (s) => (existsSync(attempts(s)) ? readdirSync(attempts(s)) : []);

test('auto: a merged, identical, recent file applies with no go, once; the history names the PR and commit', async (t) => {
  // Failure caught: a merged file applied twice (a double apply), or applied with no record of which PR and commit it came from.
  const s = await autoScene(t);
  assert.equal(apply(s).decision, 'allow');
  const [n, q] = [body(gfile(s, 'name', 1)), body(gfile(s, 'sql', 1))];
  assert.deepEqual([n.via, n.pr, n.commit, n.repo, n.file, n.head], ['auto', 42, COMMIT, 'acme/widgets', FILE, HEAD_SHA]);
  assert.equal(n.event, q.event);
  assert.equal(s.calls.length, 1);
  const again = apply(s);
  assert.equal(again.decision, 'deny');
  assert.match(again.reason, /already attempted/);
  assert.equal(s.calls.length, 1, 'the history answers before GitHub is asked');
});

test('auto off (flag absent) and execute_sql with the switch on: the go is needed and GitHub is asked nothing', async (t) => {
  // Failure caught: auto-apply reaching a project the owner did not switch on, or data SQL (execute_sql) applied with no go.
  const off = await autoScene(t, { flag: false });
  assert.equal(apply(off).decision, 'deny');
  assert.equal(off.calls.length, 0);
  assert.deepEqual(hist(off), []);
  const on = await autoScene(t);
  for (const query of ['update t set a = 1 where id = 7', 'begin;\ndrop table t;\nrollback;', SQL]) assert.equal(sql(on, query).decision, 'deny', query);
  assert.equal(on.calls.length, 0);
  assert.deepEqual(hist(on), []);
});

test('auto: one byte different (trailing newline, BOM, CRLF) needs the go and burns nothing', async (t) => {
  // Failure caught: an edited copy of a merged file (one extra byte) applied under the merged file's name.
  const s = await autoScene(t);
  for (const query of [`${SQL}\n`, SQL.trimEnd(), `﻿${SQL}`, SQL.replace(/\n/g, '\r\n')]) assert.equal(apply(s, { query }).decision, 'deny', JSON.stringify(query));
  assert.deepEqual(hist(s), []);
  assert.equal(apply(s).decision, 'allow', 'the exact file still applies');
});

test('auto: GitHub\'s answer does not prove the file is on github.com\'s default branch of this repo', async (t) => {
  // Failure caught: an unmerged file, a moved repository, a partial answer or another repository's file treated as the registered repo's merged file.
  const cases = [
    ['file missing', (a) => { tip(a).file = null; }, /whole text file/],
    ['repository null (renamed or moved)', (a) => { a.data.repository = null; }, /acme\/widgets/],
    ['errors with partial data', (a) => { a.errors = [{ message: 'partial' }]; }, /errors/],
    ['another repository', (a) => { a.data.repository.nameWithOwner = 'other/widgets'; }, /other\/widgets/],
    ['no default branch', (a) => { a.data.repository.defaultBranchRef = null; }, /default branch/],
    ['binary blob', (a) => { tip(a).file.object.isBinary = true; }, /whole text file/],
    ['truncated blob', (a) => { tip(a).file.object.isTruncated = true; }, /whole text file/],
  ];
  const s = await autoScene(t);
  for (const [what, tweak, reason] of cases) {
    s.tweak(tweak);
    const r = apply(s);
    assert.equal(r.decision, 'deny', what);
    assert.match(r.reason, reason, what);
  }
  assert.deepEqual(hist(s), []);
});

test('auto: an old, edited or re-added file needs the go; the date is read strictly', async (t) => {
  // Failure caught: a stale, edited or re-added file (or a date read loosely: no zone, not a date, from the future) applied with no go.
  const s = await autoScene(t);
  const day = 24 * 3600 * 1000;
  const cases = [
    ['two history nodes', (a) => { tip(a).history.nodes.push({ ...firstCommit(a), oid: 'c'.repeat(40) }); }],
    ['7 d + 1 ms old', (a) => { firstCommit(a).committedDate = isoAt(NOW - 7 * day - 1); }],
    ['6 min in the future', (a) => { firstCommit(a).committedDate = isoAt(NOW + 6 * 60_000); }],
    ['no zone', (a) => { firstCommit(a).committedDate = '2026-11-17T11:00:00'; }],
    ['not a date', (a) => { firstCommit(a).committedDate = 'yesterday'; }],
  ];
  for (const [what, tweak] of cases) {
    s.tweak(tweak);
    assert.equal(apply(s).decision, 'deny', what);
  }
  assert.deepEqual(hist(s), []);
  const edge = await autoScene(t);
  edge.tweak((a) => { firstCommit(a).committedDate = isoAt(NOW - 7 * day); });
  assert.equal(apply(edge).decision, 'allow', 'exactly 7 d');
  const zone = await autoScene(t);
  zone.tweak((a) => { firstCommit(a).committedDate = '2026-11-17T19:00:00+08:00'; });
  assert.equal(apply(zone).decision, 'allow', 'an in-window time written with an offset');
});

test('auto: only a file a merged PR ADDED counts', async (t) => {
  // Failure caught: a direct push, an unmerged or other-branch PR, a rename, or a PR that never touched the path accepted as "merged by a PR".
  const s = await autoScene(t);
  const cases = [
    ['direct push (no associated PR)', (a) => { firstCommit(a).associatedPullRequests.nodes = []; }],
    ['not merged', (a) => { firstPr(a).merged = false; }],
    ['merged into release', (a) => { firstPr(a).baseRefName = 'release'; }],
    ['merge commit of the PR is another commit', (a) => { firstPr(a).mergeCommit = { oid: 'd'.repeat(40) }; }],
    ['no merge commit', (a) => { firstPr(a).mergeCommit = null; }],
    ['renamed', (a) => { firstPr(a).files.nodes[0].changeType = 'RENAMED'; }],
    ['path missing from the files', (a) => { firstPr(a).files = fileList([{ path: 'supabase/migrations/other.sql', changeType: 'ADDED' }]); }],
  ];
  for (const [what, tweak] of cases) {
    s.tweak(tweak);
    assert.equal(apply(s).decision, 'deny', what);
  }
  assert.deepEqual(hist(s), []);
  // the first 100 files of the PR do not hold the path and there is a next page: the second call names the PR and the cursor
  const paged = (found) => async () => {
    const p = await autoScene(t);
    p.tweak((a) => { firstPr(a).files = fileList([{ path: 'supabase/migrations/other.sql', changeType: 'ADDED' }], 'CUR'); });
    const first = p.answer;
    p.respond = (args) => ({ stdout: JSON.stringify(args.includes('num=42') ? { data: { repository: { pullRequest: { files: fileList(found ? [{ path: FILE, changeType: 'ADDED' }] : [{ path: 'x.sql', changeType: 'ADDED' }]) } } } } : first()) });
    return p;
  };
  const yes = await paged(true)();
  assert.equal(apply(yes).decision, 'allow');
  assert.equal(yes.calls.length, 2);
  assert.ok(yes.calls[1].args.includes('num=42') && yes.calls[1].args.includes('after=CUR'), JSON.stringify(yes.calls[1].args));
  const no = await paged(false)();
  assert.equal(apply(no).decision, 'deny');
  assert.equal(no.calls.length, 2);
});

test('auto: the GitHub question is pinned to github.com and names the registry repo and the migration path', async (t) => {
  // Failure caught: a GH_HOST in the environment (or a look-alike repo) pointing the question at another server or repository.
  const s = await autoScene(t);
  assert.equal(apply(s, {}, { env: { GH_HOST: 'ghe.example' } }).decision, 'allow');
  const { args, opts } = s.calls[0];
  assert.deepEqual(args.slice(0, 4), ['api', '--hostname', 'github.com', 'graphql']);
  for (const a of ['o=acme', 'n=widgets', `p=${FILE}`]) assert.ok(args.includes(a), a);
  assert.equal(opts.env.GH_HOST, 'ghe.example', 'the call env reaches gh (the hostname flag wins over it)');
});

test('auto: a bad name or an after-deploy marker needs the go and asks GitHub nothing', async (t) => {
  // Failure caught: a policy-tightening file (marked apply-after-deploy) running before its code is deployed, or a hostile name building the GitHub path.
  const s = await autoScene(t);
  for (const name of ['a/b', 'a b', '.lead', 'x'.repeat(201), '../etc']) assert.equal(apply(s, { name }).decision, 'deny', name);
  const marked = [
    `-- pipeline: apply-after-deploy\n${SQL}`,
    `﻿-- pipeline: apply-after-deploy\n${SQL}`,
    ` -- pipeline: apply-after-deploy\n${SQL}`,
    `\t-- pipeline:\tapply-after-deploy\n${SQL}`,
    `-- one\n-- two\n-- pipeline: apply-after-deploy\n${SQL}`,
    `-- PIPELINE: APPLY-AFTER-DEPLOY\n${SQL}`,
    `/* pipeline: apply-after-deploy */\n${SQL}`,
  ];
  for (const query of marked) assert.equal(apply(s, { query }).decision, 'deny', JSON.stringify(query.slice(0, 40)));
  assert.equal(s.calls.length, 0);
  assert.deepEqual(hist(s), []);
});

test('auto: gh fails (exit 1), times out, overflows or prints non-JSON: deny, never allow', async (t) => {
  // Failure caught: a GitHub outage, timeout or garbled answer read as "eligible" (or thrown out of the hook, which Claude Code treats as an allow).
  const s = await autoScene(t);
  for (const respond of [() => ({ code: 1, stderr: 'boom' }), () => ({ code: null, timedOut: true }), () => ({ overBuffer: true, stdout: '{' }), () => ({ stdout: 'not json' }), () => ({ stdout: '[]' }), () => { throw new Error('spawn'); }]) {
    s.respond = respond;
    const r = apply(s);
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /Auto-apply did not apply/);
  }
  assert.deepEqual(hist(s), []);
});

test('auto: little time left: no gh call under 1.5 s, no claim under 0.5 s; the gh timeout never exceeds what is left', async (t) => {
  // Failure caught: a GitHub call or a claim started with no time left, carrying the hook past its host timeout (Claude Code then allows the call).
  const low = await autoScene(t);
  const r = apply(low, {}, { leftMs: () => 1000 });
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /try the call again/);
  assert.equal(low.calls.length, 0);
  const late = await autoScene(t);
  let asked = false;
  late.respond = () => { asked = true; return { stdout: JSON.stringify(ghBase()) }; };
  assert.equal(apply(late, {}, { leftMs: () => (asked ? 400 : 5000) }).decision, 'deny');
  assert.equal(late.calls.length, 1);
  assert.deepEqual(hist(late), []);
  const bounded = await autoScene(t);
  assert.equal(apply(bounded, {}, { leftMs: () => 4000 }).decision, 'allow');
  assert.ok(bounded.calls[0].opts.timeoutMs <= 4000 && bounded.calls[0].opts.timeoutMs > 0, String(bounded.calls[0].opts.timeoutMs));
});

test('auto: a go is used first; after it, auto never applies the same migration again', async (t) => {
  // Failure caught: the owner's go applying a migration and auto-apply then applying it a second time in the same session (a double apply).
  const s = await scene(t, { flag: true });
  const calls = [];
  const gh = (args) => { calls.push(args); return { ...GH_OK, stdout: JSON.stringify(ghBase()) }; };
  assert.equal(apply(s, {}, { io: { gh } }).decision, 'allow');
  assert.equal(body(gfile(s, 'name', 1)).via, 'go');
  assert.equal(calls.length, 0, 'the go path never asks GitHub');
  const again = apply(s, {}, { io: { gh } });
  assert.equal(again.decision, 'deny');
  assert.equal(calls.length, 0);
});

test('auto: the same SQL under a second name is refused', async (t) => {
  // Failure caught: one file applied twice by renaming it (the SQL key of the history is what stops it).
  const s = await autoScene(t);
  assert.equal(apply(s).decision, 'allow');
  const r = apply(s, { name: NAME2 });
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /already attempted/);
  assert.equal(s.calls.length, 1);
});

test('auto: an imported earlier go apply (generation via go-import) blocks it', async (t) => {
  // Failure caught: switching auto-apply on, and the migration the owner's go applied before that applying a second time.
  for (const keys of [['name'], ['sql']]) {
    const s = await autoScene(t);
    seedGen(s, 1, NOW - 100_000, keys);
    const r = apply(s);
    assert.equal(r.decision, 'deny', keys.join());
    assert.match(r.reason, /already attempted/);
    assert.equal(s.calls.length, 0);
  }
});

test('auto: a go consumed with no history (a rollback, a go during the import) blocks it; an unreadable consumed marker refuses', async (t) => {
  // Failure caught: a go consumed by an older guard (no history written) not counting as an attempt, so auto applies the same migration a second time.
  const marker = (s, name, o) => { mkdirSync(consumed(s), { recursive: true }); writeFileSync(join(consumed(s), `${name}.json`), o); };
  const bySql = await autoScene(t);
  marker(bySql, 'a', `${JSON.stringify({ v: 1, consumedAt: isoAt(NOW - 100_000), op: 'migration', projectRef: REF, sqlSha256: sha256Of(SQL), name: null })}\n`);
  assert.match(apply(bySql).reason, /already attempted/);
  const byName = await autoScene(t);
  marker(byName, 'a', `${JSON.stringify({ v: 1, consumedAt: isoAt(NOW - 100_000), op: 'migration', projectRef: REF, sqlSha256: sha256Of('select 2;'), name: NAME })}\n`);
  assert.match(apply(byName).reason, /already attempted/);
  const other = await autoScene(t);
  marker(other, 'a', `${JSON.stringify({ v: 1, consumedAt: isoAt(NOW - 100_000), op: 'migration', projectRef: 'zzzzzzzzzzzzzzzzzzzz', sqlSha256: sha256Of(SQL), name: NAME })}\n`);
  assert.equal(apply(other).decision, 'allow', 'another project\'s consumed go is not an attempt here');
  const empty = await autoScene(t);
  marker(empty, 'broken', '');
  const r = apply(empty);
  assert.equal(r.decision, 'deny');
  assert.ok(r.reason.includes(join(consumed(empty), 'broken.json')), r.reason);
  for (const s of [bySql, byName, empty]) assert.equal(s.calls.length, 0);
});

test('auto: a consumed marker with no op, no projectRef or no SQL hash cannot rule out an earlier apply: refuse naming it', async (t) => {
  // Failure caught: a `{}` marker silently skipped by the run-time scan (the importer refuses the same body), so a migration the marker may stand for is applied a second time.
  for (const body of [{}, { v: 1, projectRef: REF, sqlSha256: sha256Of(SQL) }, { v: 1, op: 'migration', sqlSha256: sha256Of(SQL) }, { v: 1, op: 'migration', projectRef: REF }, { v: 1, op: 'migration', projectRef: REF, sqlSha256: [sha256Of(SQL)] }]) {
    const s = await autoScene(t);
    mkdirSync(consumed(s), { recursive: true });
    writeFileSync(join(consumed(s), 'odd.json'), `${JSON.stringify(body)}\n`);
    const r = apply(s);
    assert.equal(r.decision, 'deny', JSON.stringify(body));
    assert.ok(r.reason.includes(join(consumed(s), 'odd.json')), r.reason);
    assert.equal(s.calls.length, 0);
  }
});

test('race: a go consumed after the auto check scanned the markers but before it claimed: auto is refused, leaving the apply to the go\'s own claim', async (t) => {
  // Failure caught: an auto apply and a go apply of the same migration both allowed (a double apply on a live database) when the go lands in the gap between auto's marker scan and its claim.
  const s = await autoScene(t);
  s.respond = () => {
    mkdirSync(consumed(s), { recursive: true });
    writeFileSync(join(consumed(s), 'late.json'), `${JSON.stringify({ v: 1, consumedAt: isoAt(NOW - 1000), op: 'migration', projectRef: REF, sqlSha256: sha256Of(SQL), name: NAME })}\n`);
    return { stdout: JSON.stringify(ghBase()) };
  };
  const r = apply(s);
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /already attempted|check the live state/);
  assert.ok(existsSync(gfile(s, 'name', 1)) && existsSync(gfile(s, 'sql', 1)), 'its generations stay: they count as an attempt');
});

test('race: a go that read the switch off, then auto claimed the same migration before the go\'s marker landed: the go is refused and spent', async (t) => {
  // Failure caught: the owner's switch-on landing between a go's registry read and its claim lets the go and an auto apply both be allowed (a double apply).
  const s = await scene(t);
  const real = openSync;
  let fired = 0;
  const io = {
    openSync: (p, flags, mode) => {
      if (String(p).includes('live-db-consumed') && fired === 0) {
        fired += 1;
        seedRegistry(s.home, { refs: [{ ref: REF, name: 'EagleWatch prod', repo: 'acme/widgets', kind: 'live', autoMigrations: true, autoSince: '2026-11-01T00:00:00Z' }] });
        seedGen(s, 1, NOW - 1000); // (auto's claim, made while the go was between its read and its marker)
      }
      return real(p, flags, mode);
    },
  };
  const r = apply(s, {}, { io });
  assert.equal(fired, 1);
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /check the live state/);
  assert.equal(markers(s).length, 1, 'the go is spent');
  // the same switch-on with no attempt recorded yet: the go keeps its apply (auto will find the go's marker and refuse itself)
  const quiet = await scene(t);
  const io2 = { openSync: (p, flags, mode) => { if (String(p).includes('live-db-consumed')) seedRegistry(quiet.home, { refs: [{ ref: REF, name: 'EagleWatch prod', repo: 'acme/widgets', kind: 'live', autoMigrations: true, autoSince: '2026-11-01T00:00:00Z' }] }); return real(p, flags, mode); } };
  assert.equal(apply(quiet, {}, { io: io2 }).decision, 'allow');
  // R2-B2 (failure caught: the go allowed with no generation recorded, so a second session's earlier go for the same migration is applied again): it claims the generations before allowing
  assert.ok(existsSync(gfile(quiet, 'name', 1)) && existsSync(gfile(quiet, 'sql', 1)), 'the go claimed the generations');
  assert.equal(JSON.parse(readFileSync(gfile(quiet, 'name', 1), 'utf8')).via, 'go');
  // R2-F1 (failure caught: "try the call again" for a go whose marker is already written): out of time during the re-read says the go is used
  const late = await scene(t);
  let marked = false;
  const io3 = { openSync: (p, flags, mode) => { if (String(p).includes('live-db-consumed')) { marked = true; seedRegistry(late.home, { refs: [{ ref: REF, name: 'EagleWatch prod', repo: 'acme/widgets', kind: 'live', autoMigrations: true, autoSince: '2026-11-01T00:00:00Z' }] }); } return real(p, flags, mode); } };
  const out = apply(late, {}, { io: io3, leftMs: () => (marked ? 0 : 5000) });
  assert.equal(out.decision, 'deny');
  assert.match(out.reason, /go is used/);
  assert.doesNotMatch(out.reason, /try the call again/);
  assert.equal(markers(late).length, 1);
});

test('auto: out of time after the claim wrote both generations says the attempt is used, never "try the call again"', async (t) => {
  // Failure caught: R2-B4, a spent attempt answered with "try the call again", so the retry only finds it already attempted and the owner is told the right step one call too late.
  const s = await autoScene(t);
  mkdirSync(consumed(s), { recursive: true });
  writeFileSync(join(consumed(s), 'a.json'), `${JSON.stringify({ v: 1, consumedAt: isoAt(NOW - 100_000), op: 'migration', projectRef: 'zzzzzzzzzzzzzzzzzzzz', sqlSha256: sha256Of('select 9;'), name: 'other' })}\n`);
  const r = apply(s, {}, { leftMs: () => (existsSync(gfile(s, 'sql', 1)) ? 0 : 5000) });
  assert.equal(r.decision, 'deny');
  assert.ok(existsSync(gfile(s, 'name', 1)) && existsSync(gfile(s, 'sql', 1)));
  assert.match(r.reason, /attempt is used/);
  assert.match(r.reason, /check the live state read-only/);
  assert.doesNotMatch(r.reason, /try the call again/);
});

test('auto: a file merged before the switch-on time, or a PR from another repository, needs the go', async (t) => {
  // Failure caught: migrations merged before the owner switched auto-apply on (possibly applied by hand) applied again, or a fork's PR of the same number accepted.
  const early = await autoScene(t, { since: isoAt(NOW - 3_600_000 + 60_000) });
  assert.equal(apply(early).decision, 'deny');
  assert.match(apply(early).reason, /before auto-apply was switched on/);
  const fork = await autoScene(t);
  fork.tweak((a) => { firstPr(a).baseRepository.nameWithOwner = 'fork/widgets'; });
  assert.equal(apply(fork).decision, 'deny');
  assert.deepEqual([...hist(early), ...hist(fork)], []);
});

test('auto: two enabled entries with the same repo: auto is off for both and GitHub is asked nothing', async (t) => {
  // Failure caught: one merged file applied to the wrong one of two databases registered for the same repository.
  const s = await autoScene(t, { refs: [{ ref: 'qqqqqqqqqqqqqqqqqqqq', name: 'Other prod', repo: 'Acme/Widgets', kind: 'live', autoMigrations: true, autoSince: '2026-11-01T00:00:00Z' }] });
  assert.equal(apply(s).decision, 'deny');
  assert.equal(apply(s, { project_id: 'qqqqqqqqqqqqqqqqqqqq' }).decision, 'deny');
  assert.equal(s.calls.length, 0);
});

test('the module exports only fixed-destination claims; hostile names stay inside their folders', async () => {
  // Failure caught: an export that lets a caller write an arbitrary protected file (the registry, a go record) through the history module.
  const auto = await import('../pipeline/hooks/lib/live-db-auto.mjs');
  assert.deepEqual(Object.keys(auto).sort(), ['AFTER_DEPLOY_RE', 'AUTO_GH_TIMEOUT_MS', 'AUTO_MAX_AGE_MS', 'AUTO_MIN_CLAIM_MS', 'AUTO_MIN_START_MS', 'LIVE_DB_ATTEMPTS_REL', 'LIVE_DB_CONSUMED_REL', 'MAX_GENERATIONS', 'STEM_RE', 'autoApply', 'claimGoMarker', 'claimNext', 'history', 'importGoHistory', 'readAttemptLog']);
  const home = mkdtempSync(join(tmpdir(), 'cp-live-db-hostile-'));
  try {
    const seen = { name: { n: 0, at: 0 }, sql: { n: 0, at: 0 } };
    assert.equal(auto.claimNext({ home, via: 'auto', session: 's', now: () => NOW, facts: { ref: REF, sqlSha256: sha256Of(SQL), name: '../../db-refs' }, seen }).status, 'claimed');
    assert.equal(auto.claimGoMarker({ home, session: 's', promptId: '../../x', op: 'migration', projectRef: REF, name: '../../db-refs', sqlSha256: sha256Of(SQL), now: () => NOW }), 'claimed');
    const state = join(home, '.claude', 'pipeline-state');
    assert.deepEqual(readdirSync(home), ['.claude']);
    assert.deepEqual(readdirSync(join(home, '.claude')), ['pipeline-state']);
    assert.deepEqual(readdirSync(state), ['owner-go']);
    assert.deepEqual(readdirSync(join(state, 'owner-go')).sort(), ['live-db-attempts', 'live-db-consumed']);
    const made = readdirSync(join(state, 'owner-go', 'live-db-attempts'));
    assert.equal(made.length, 2);
    assert.ok(made.every((f) => /^(name|sql)-[0-9a-f]{32}-1\.json$/.test(f)), made.join());
    assert.ok(readdirSync(join(state, 'owner-go', 'live-db-consumed')).every((f) => /^[0-9a-f]{32}\.json$/.test(f)));
    assert.ok(!existsSync(join(state, 'db-refs.json')));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// each child waits for the same instant, then runs the whole decision once with a fake gh that answers `answer`; -> the decisions
function decideInChildren(home, jobs) {
  const guardUrl = new URL('../pipeline/hooks/lib/live-db-guard.mjs', import.meta.url).href;
  const at = Date.now() + 1500;
  const child = `const { evaluateSupabaseMcp } = await import(${JSON.stringify(guardUrl)});
const a = JSON.parse(process.argv[1]);
while (Date.now() < a.at) { /* start together */ }
const gh = () => ({ code: 0, stdout: a.answer, stderr: '', timedOut: false, overBuffer: false });
const r = evaluateSupabaseMcp(a.tool, { project_id: a.ref, name: a.name, query: a.query }, { home: a.home, sessionId: a.session, transcriptPath: a.transcript, now: () => a.now, io: { gh } });
process.stdout.write(r.decision);`;
  return Promise.all(jobs.map((j) => new Promise((resolve, reject) => {
    const args = JSON.stringify({ home, tool: `${TOOL}apply_migration`, ref: REF, query: SQL, at, now: NOW, ...j });
    const p = spawn(process.execPath, ['--input-type=module', '-e', child, args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`child exit ${code}: ${err}`))));
  })));
}

test('auto races (two processes): the same file twice, the same SQL under two names, exactly one allow for two autos, never two allows for an auto and a go', async (t) => {
  // Failure caught: two calls that both read "no attempt yet" each getting an allow (a double apply on a live database).
  const same = await autoScene(t);
  const answer = JSON.stringify(ghBase());
  const mk = (session, name = NAME, ans = answer) => ({ session, transcript: join(same.home, 'none.jsonl'), name, answer: ans });
  assert.deepEqual((await decideInChildren(same.home, [mk('a'), mk('b')])).sort(), ['allow', 'deny']);
  const names = await autoScene(t);
  assert.deepEqual((await decideInChildren(names.home, [mk('a', NAME, answer), mk('b', NAME2, JSON.stringify(ghBase({ name: NAME2 })))])).sort(), ['allow', 'deny']);
  const withGo = await scene(t, { flag: true, typedAt: NOW - 60_000 });
  const jobs = [{ session: withGo.session, transcript: withGo.transcript, name: NAME, answer }, { session: 'someone-else', transcript: join(withGo.home, 'none.jsonl'), name: NAME, answer }];
  // Deny/deny is allowed here: when each side sees the other's marker both back off. A double apply (two allows) is what this catches.
  const goVsAuto = await decideInChildren(withGo.home, jobs);
  assert.ok(goVsAuto.every((d) => d === 'allow' || d === 'deny') && goVsAuto.filter((d) => d === 'allow').length <= 1, `go vs auto: ${goVsAuto}`);
  assert.ok(existsSync(gfile(withGo, 'name', 1)) && !existsSync(gfile(withGo, 'name', 2)));
});

// ---- the real hook entry: GitHub that never answers is a deny within the host timeout ----------------------------------------------------------------------------------------

const HOOK = fileURLToPath(new URL('../pipeline/hooks/guard-files.mjs', import.meta.url));
function runHook(home, sessionId, env) {
  const childEnv = { ...process.env, HOME: home, USERPROFILE: home, ...env };
  delete childEnv[['PIPELINE', 'ADMIN'].join('_')];
  delete childEnv.PIPELINE_GUARD_LOG;
  const input = { hook_event_name: 'PreToolUse', tool_name: `${TOOL}apply_migration`, tool_input: { project_id: REF, name: NAME, query: SQL }, session_id: sessionId, transcript_path: join(home, 'none.jsonl'), cwd: home };
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: 'utf8', env: childEnv, timeout: 30_000 });
  const out = r.stdout.trim() === '' ? { permissionDecision: 'allow' } : JSON.parse(r.stdout).hookSpecificOutput;
  return { ms: Date.now() - t0, decision: out.permissionDecision, reason: out.permissionDecisionReason ?? '' };
}

test('through the real hook entry: GitHub that never answers, even with 5,000 pending click files, is a deny within the host timeout', async (t) => {
  // Failure caught: a hung gh (or a scan of thousands of pending clicks first) carrying the hook past its 15 s host timeout, which Claude Code treats as an allow.
  const s = await autoScene(t);
  const slow = join(s.home, 'slow-gh.mjs');
  writeFileSync(slow, 'setTimeout(() => {}, 30000);\n');
  const env = { PIPELINE_GH: `${process.execPath} ${slow}` };
  const one = runHook(s.home, 'hook-1', env);
  assert.equal(one.decision, 'deny', one.reason);
  assert.match(one.reason, /GitHub did not answer in time/);
  assert.ok(one.ms < 14_000, `${one.ms} ms`);
  const asks = join(STATE(s.home), 'owner-go', 'asks');
  mkdirSync(asks, { recursive: true });
  for (let i = 0; i < 5000; i += 1) writeFileSync(join(asks, `ask-${i.toString(16).padStart(12, '0')}.${i.toString(16).padStart(16, '0')}.pending`), '{}');
  const many = runHook(s.home, 'hook-2', env);
  assert.equal(many.decision, 'deny', many.reason);
  assert.ok(many.ms < 14_000, `${many.ms} ms`);
  assert.deepEqual(hist(s), []);
});

// ---- auto-apply after the deploy (#882): a file marked apply-after-deploy applies once GitHub shows its production deploy succeeded ---------------------------------------------------------------

const MARKED = `-- pipeline: apply-after-deploy\n${SQL}`;
const OTHER_SHA = 'c'.repeat(40);
const DEPLOY_REG = { deployEnv: 'Production', deployBot: 'vercel' };
// the cutoff-era shapes of unreleased #907 commits (N3): 7ac5c1d3 (deployClock 'pending') and 39e28449 (the finished two-phase registration with its staging key)
const LEGACY_REGS = {
  'deployClock pending': { ...DEPLOY_REG, deploySince: isoAt(NOW - 7_200_000), deployClock: 'pending' },
  'two-phase proof with deployPending': { ...DEPLOY_REG, deploySince: isoAt(NOW - 7_200_000), deployClock: 'github', deployProof: 'two-phase', deployPending: { env: 'Production', bot: 'vercel', since: isoAt(NOW - 7_200_000) } },
};
const bot = (login = 'vercel') => ({ __typename: 'Bot', login });
const dnode = (over = {}) => ({ commitOid: COMMIT, createdAt: isoAt(NOW - 3_100_000), environment: 'Production', originalEnvironment: 'Production', latestEnvironment: 'Production', state: 'ACTIVE', creator: bot(), latestStatus: { state: 'SUCCESS', createdAt: isoAt(NOW - 3_000_000), creator: bot() }, ...over });
const withStatus = (over) => dnode({ latestStatus: { state: 'SUCCESS', createdAt: isoAt(NOW - 3_000_000), creator: bot(), ...over } });
// GitHub's answer to the deploy query
const deployAnswer = ({ live = dnode(), newest = dnode(), envName = 'Production', repoName = 'acme/widgets', pr = {}, head = COMMIT, branchName = 'main' } = {}) => ({ data: { repository: { nameWithOwner: repoName, environment: envName === null ? null : { name: envName, latestCompletedDeployment: live }, deployments: { nodes: newest === null ? [] : [newest] }, defaultBranchRef: head === null ? null : { name: branchName, target: { oid: head } }, pullRequest: { number: 42, merged: true, mergedAt: isoAt(NOW - 3_500_000), mergeCommit: { oid: COMMIT }, ...pr } } } });
const argOf = (args, key) => args.find((a) => a.startsWith(`${key}=`))?.slice(key.length + 1);
const queryOf = (call) => argOf(call.args, 'query');

// autoScene whose registry carries the after-deploy registration; its gh stub answers the file query, the file-list pages and the deploy query, each by what was asked: the deploy answer is the stub's `s.deploy()` only when the call asks for env=Production and pr 42
async function deployScene(t, { registration = DEPLOY_REG, ...opts } = {}) {
  const s = await autoScene(t, { deploy: registration, ...opts });
  s.deploy = () => deployAnswer();
  s.answer = () => ghBase({ text: MARKED, head: COMMIT });
  s.respond = (args) => {
    const q = queryOf({ args });
    if (q.includes('latestCompletedDeployment')) return { stdout: JSON.stringify(argOf(args, 'env') === 'Production' && argOf(args, 'num') === '42' ? s.deploy() : deployAnswer({ envName: null, newest: null })) };
    if (q.includes('after:$after')) return { stdout: JSON.stringify(s.page()) };
    return { stdout: JSON.stringify(s.answer()) };
  };
  return s;
}
const applyMarked = (s) => apply(s, { query: MARKED });
const { readAttemptLog } = await import('../pipeline/hooks/lib/live-db-auto.mjs');

test('after-deploy: a marked file whose newest and latest completed Production deployments are its merge commit, ACTIVE, SUCCESS by the registered bot applies with no go; the history and the log say it waited for a deploy', async (t) => {
  // Failure caught: the feature not working (a marked file still waiting for a click after a successful deploy), or an apply that leaves no trace of the deploy that allowed it.
  const s = await deployScene(t);
  assert.equal(applyMarked(s).decision, 'allow');
  assert.equal(s.calls.length, 2, 'the file query and the deploy query');
  const n = body(gfile(s, 'name', 1, { sql: MARKED }));
  assert.deepEqual([n.via, n.afterDeploy, n.deployEnv, n.deployedAt, n.commit, n.pr], ['auto', true, 'Production', isoAt(NOW - 3_000_000), COMMIT, 42]);
  const [ev] = readAttemptLog({ home: s.home }).events;
  assert.deepEqual([ev.via, ev.afterDeploy, ev.deployEnv, ev.deployedAt], ['auto', true, 'Production', isoAt(NOW - 3_000_000)]);
  // an unmarked apply on the same registry carries no deploy fields, and an attempt-log row without them (older install) reads null
  const plain = await deployScene(t);
  plain.answer = () => ghBase();
  assert.equal(apply(plain).decision, 'allow');
  assert.equal(plain.calls.length, 1, 'no deploy query for an unmarked file');
  const [old] = readAttemptLog({ home: plain.home }).events;
  assert.deepEqual([old.afterDeploy, old.deployEnv, old.deployedAt], [null, null, null]);
  assert.equal('afterDeploy' in body(gfile(plain, 'name', 1)), false);
});

test('after-deploy N3: an entry with cutoff-era keys keeps the registry valid and another ref readable, claims nothing, stays unregistered after a label set and a server add, and a fresh after-deploy on registers only that ref', async (t) => {
  // Failure caught: an unreleased #907 registration invalidating the registry, still letting a marked file apply (with no cutoff to compare), or an unrelated owner write turning it into a live registration.
  const other = { ref: 'zyxwvutsrq9876543210', name: 'Other', repo: 'acme/other', kind: 'live', autoMigrations: true, autoSince: '2026-11-01T00:00:00Z' };
  for (const [shape, keys] of Object.entries(LEGACY_REGS)) {
    const s = await deployScene(t, { registration: keys, refs: [other] });
    const read = readDbRefs(s.home);
    assert.equal(read.ok, true, shape);
    assert.deepEqual([read.refs.find((e) => e.ref === other.ref).name, read.refs[0].deployEnv, read.refs[0].deployLegacy], ['Other', null, true], shape);
    const r = applyMarked(s);
    assert.equal(r.decision, 'deny', shape);
    assert.match(r.reason, /after-deploy on/, shape);
    assert.equal(s.calls.length, 0, `${shape}: GitHub asked nothing`);
    assert.deepEqual(hist(s), [], shape);
    // a label-only set and a server add rewrite the registry: the legacy keys go, nothing becomes registered
    assert.equal(runOwnerCli(s.home, ['set', '--ref', REF, '--name', 'Renamed', '--repo', 'acme/widgets']).exitCode, 0, shape);
    assert.equal(runOwnerCli(s.home, ['server', 'add', 'mine']).exitCode, 0, shape);
    assert.equal(applyMarked(s).decision, 'deny', `${shape}: still not registered after unrelated writes`);
    assert.equal(s.calls.length, 0, shape);
    assert.deepEqual(hist(s), [], shape);
    // only the fresh registration writes a pair, and only for the ref given
    assert.equal(runOwnerCli(s.home, ['after-deploy', 'on', '--ref', REF, '--env', 'Production', '--bot', 'vercel']).exitCode, 0, shape);
    assert.deepEqual(Object.fromEntries(readDbRefs(s.home).refs.map((e) => [e.ref, e.deployEnv])), { [REF]: 'Production', [other.ref]: null }, shape);
    assert.equal(applyMarked(s).decision, 'allow', `${shape}: the fresh registration works`);
  }
});

test('after-deploy D1: a marked file whose merge is live when the owner switches after-deploy on (real owner CLI) applies with no click: the check is made at apply time', async (t) => {
  // Failure caught: eligibility frozen at switch-on (a time cutoff or a snapshot) refusing the merge that is live at that moment, or one still deploying then.
  const s = await deployScene(t, { registration: null });
  assert.equal(applyMarked(s).decision, 'deny', 'before the registration the click stays');
  assert.equal(runOwnerCli(s.home, ['after-deploy', 'on', '--ref', REF, '--env', 'Production', '--bot', 'vercel']).exitCode, 0);
  assert.equal(applyMarked(s).decision, 'allow');
  assert.ok(existsSync(gfile(s, 'name', 1, { sql: MARKED })));
});

test('after-deploy N1: a later commit on the default branch gives the file the click, with its own final wording and no deploy query, even when the deploy proof would pass', async (t) => {
  // Failure caught: a redeploy or rollback of an older merge, or a merge made after the file's own, still qualifying; and the refusal telling the caller to call again when waiting cannot help.
  const s = await deployScene(t);
  s.answer = () => ghBase({ text: MARKED, head: HEAD_SHA });
  s.deploy = () => deployAnswer({ head: HEAD_SHA });
  const r = applyMarked(s);
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /a later commit is on the default branch: this file takes the owner's go/);
  assert.doesNotMatch(r.reason, /call again/);
  assert.equal(s.calls.length, 1, 'the deploy query is never made');
  assert.deepEqual(hist(s), []);
  assert.equal(markers(s).length, 0);
});

test('after-deploy N2: a PR merged before auto-apply was switched on keeps the click even when the commit that added the file is dated after it', async (t) => {
  // Failure caught: a merge older than the switch (its commit re-dated, e.g. by a rebase merge) applying with no go because only the commit date was compared with autoSince.
  const s = await deployScene(t);
  s.deploy = () => deployAnswer({ pr: { mergedAt: '2026-10-30T00:00:00Z' } });
  const r = applyMarked(s);
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /merged before auto-apply was switched on/);
  assert.equal(s.calls.length, 2);
  assert.deepEqual(hist(s), []);
  const ok = await deployScene(t);
  ok.deploy = () => deployAnswer({ pr: { mergedAt: '2026-11-01T00:00:00Z' } });
  assert.equal(applyMarked(ok).decision, 'allow', 'merged at the switch time is not before it');
});

test('after-deploy: a marked file of an entry without the registration is refused with GitHub asked nothing (the owner\'s click stays)', async (t) => {
  // Failure caught: a marked file applying before its code is deployed on a project whose owner never registered the deploy.
  const s = await deployScene(t, { registration: null });
  const r = applyMarked(s);
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /after-deploy on/);
  assert.equal(s.calls.length, 0);
  assert.deepEqual(hist(s), []);
});

test('after-deploy: anything GitHub shows other than the one trusted, successful deploy of the merge commit is refused with a plain reason, nothing claimed, no go burnt', async (t) => {
  // Failure caught: a forged, stale, rolled-back or half-finished deploy counting as live (a marked migration applied before the code that needs it, or after it was rolled back).
  const other = { commitOid: OTHER_SHA };
  const cases = [
    ['no deployment at all', { live: null, newest: null }, /no deployment in "Production" yet/],
    ['no such environment', { envName: null }, /no deployment environment named "Production"/],
    ['another environment name', { envName: 'Staging' }, /no deployment environment named "Production"/],
    ['the latest completed one is another commit (stub-level: a rollback GitHub recorded)', { live: dnode(other) }, /the deployment GitHub shows as live is commit c+, not the merge commit/],
    ['the newest one is another commit, the live one is trusted', { newest: dnode(other) }, /the newest deployment is commit c+/],
    ['the newest one is by an untrusted creator ahead of a trusted live one', { newest: dnode({ creator: { __typename: 'User', login: 'vercel' } }) }, /not made by vercel\[bot\]/],
    ['the deployment is not ACTIVE', { newest: dnode({ state: 'INACTIVE' }) }, /not active/],
    ['status FAILURE', { newest: withStatus({ state: 'FAILURE' }), live: withStatus({ state: 'FAILURE' }) }, /has not succeeded/],
    ['status IN_PROGRESS', { newest: withStatus({ state: 'IN_PROGRESS' }) }, /has not succeeded/],
    ['status INACTIVE', { newest: withStatus({ state: 'INACTIVE' }) }, /has not succeeded/],
    ['creator a User named vercel', { live: dnode({ creator: { __typename: 'User', login: 'vercel' } }) }, /not made by vercel\[bot\]/],
    ['status set by another bot', { newest: withStatus({ creator: bot('github-actions') }) }, /status of the newest deployment was not set by vercel\[bot\]/],
    ['a Preview deployment an agent moved into Production by a status', { newest: dnode({ originalEnvironment: 'Preview' }) }, /another environment/],
    ['a deployment of another environment', { live: dnode({ environment: 'Preview', latestEnvironment: 'Preview' }) }, /another environment/],
    ['status time before the commit', { newest: withStatus({ createdAt: isoAt(NOW - 7_200_000) }) }, /not credible/],
    ['status time without a zone', { newest: withStatus({ createdAt: '2026-11-17T11:10:00' }) }, /not credible/],
    ['status time in the future', { newest: withStatus({ createdAt: isoAt(NOW + 3_600_000) }) }, /not credible/],
    ['another repository answered', { repoName: 'evil/widgets' }, /evil\/widgets instead of acme\/widgets/],
    ['another pull request', { pr: { number: 43 } }, /does not show the pull request as merged/],
    ['merged at another commit', { pr: { mergeCommit: { oid: OTHER_SHA } } }, /does not show the pull request as merged/],
    ['the default branch moved since the file was read', { head: OTHER_SHA }, /default branch moved during the check/],
    ['no default branch in the answer', { head: null }, /default branch moved during the check/],
    ['another branch made the default at the same commit (the PR\'s base no longer matches)', { branchName: 'release' }, /default branch moved during the check/],
  ];
  for (const [what, over, reason] of cases) {
    const s = await deployScene(t);
    s.deploy = () => deployAnswer(over);
    const r = applyMarked(s);
    assert.equal(r.decision, 'deny', what);
    assert.match(r.reason, reason, what);
    assert.match(r.reason, /wait for the deploy to finish and call again, or ask for the owner's go/, what);
    assert.equal(s.calls.length, 2, what);
    assert.equal(markers(s).length, 0, what);
    assert.deepEqual(hist(s), [], `${what}: nothing claimed`);
  }
  // a hand-written registry with the bot github-actions is invalid: every Supabase write is refused, GitHub is asked nothing
  const forged = await deployScene(t, { registration: { ...DEPLOY_REG, deployBot: 'github-actions' } });
  assert.equal(applyMarked(forged).decision, 'deny');
  assert.equal(forged.calls.length, 0);
});

test('after-deploy: the deploy query is the last GitHub read, after a second page of the PR\'s files', async (t) => {
  // Failure caught: the proof read before the file pages, so a rollback GitHub shows while the pages are read goes unseen.
  const s = await deployScene(t);
  s.answer = () => { const a = ghBase({ text: MARKED, head: COMMIT }); firstPr(a).files = fileList([{ path: 'README.md', changeType: 'MODIFIED' }], 'cursor-1'); return a; };
  s.page = () => ({ data: { repository: { pullRequest: { files: fileList([{ path: FILE, changeType: 'ADDED' }]) } } } });
  assert.equal(applyMarked(s).decision, 'allow');
  assert.deepEqual(s.calls.map((c) => (queryOf(c).includes('latestCompletedDeployment') ? 'deploy' : queryOf(c).includes('after:$after') ? 'page' : 'file')), ['file', 'page', 'deploy']);
});

test('after-deploy: a registration the owner switches off while GitHub is asked claims nothing', async (t) => {
  // Failure caught: the owner running `after-deploy off` (a rollback) while the deploy query is out, and the hook still applying the migration on the registration it read before.
  const s = await deployScene(t);
  s.deploy = () => {
    seedRegistry(s.home, { refs: [{ ref: REF, name: 'EagleWatch prod', repo: 'acme/widgets', kind: 'live', autoMigrations: true, autoSince: '2026-11-01T00:00:00Z' }] });
    return deployAnswer();
  };
  const r = applyMarked(s);
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /changed the after-deploy registration during the check/);
  assert.deepEqual(hist(s), [], 'nothing claimed');
  assert.equal(markers(s).length, 0);
});

test('after-deploy: the final registry check and the claim run under the registry lock the owner\'s db-refs writes take, released after; a lock the owner holds past the wait claims nothing', async (t) => {
  // Failure caught: the owner's `after-deploy off` finishing between the hook's last registry read and its claim, and the migration still being allowed.
  const s = await deployScene(t);
  const lockDir = join(STATE(s.home), 'locks', 'db-refs.lock');
  const heldAtCreate = [];
  s.ctx.io.openSync = (file, ...rest) => { if (String(file).includes('live-db-attempts')) heldAtCreate.push(existsSync(lockDir)); return openSync(file, ...rest); };
  assert.equal(applyMarked(s).decision, 'allow');
  assert.ok(heldAtCreate.length >= 2 && heldAtCreate.every(Boolean), 'both attempt records were created while the registry lock was held');
  assert.equal(existsSync(lockDir), false, 'released after the claim');
  // the owner's command holds the lock (an `off` mid-write): the hook waits a moment, then claims nothing and spends no attempt; once it is free the same call applies
  const busy = await deployScene(t);
  busy.ctx.io.registryLockWaitMs = 100;
  const owner = tryAcquire('db-refs', { dir: join(STATE(busy.home), 'locks') });
  assert.ok(owner.acquired);
  const denied = applyMarked(busy);
  assert.equal(denied.decision, 'deny');
  assert.match(denied.reason, /db-refs command is changing the registry/);
  assert.deepEqual(hist(busy), []);
  release(owner.lock);
  assert.equal(applyMarked(busy).decision, 'allow');
  // an unmarked file never touches the lock
  const plain = await deployScene(t);
  plain.answer = () => ghBase();
  const own = tryAcquire('db-refs', { dir: join(STATE(plain.home), 'locks') });
  assert.equal(apply(plain).decision, 'allow');
  release(own.lock);
});

test('after-deploy: denied before the deploy finished, the same call after GitHub shows success applies (no attempt was spent)', async (t) => {
  // Failure caught: an early call spending the attempt, so the owner needs a go for a migration whose deploy was only seconds late.
  const s = await deployScene(t);
  s.deploy = () => deployAnswer({ newest: withStatus({ state: 'PENDING' }) });
  assert.equal(applyMarked(s).decision, 'deny');
  assert.deepEqual(hist(s), []);
  s.deploy = () => deployAnswer();
  assert.equal(applyMarked(s).decision, 'allow');
  assert.ok(existsSync(gfile(s, 'name', 1, { sql: MARKED })));
});

test('after-deploy: the unmarked file sends the same file query as before and nothing more; the deploy query asks for this environment, this PR and every field the proof reads', async (t) => {
  // Failure caught: the unmarked path changing (an extra call or a different query), and a deploy query that does not ask what the proof reads (the stub answers success only for env=Production and pr 42).
  const plain = await deployScene(t);
  plain.answer = () => ghBase();
  assert.equal(apply(plain).decision, 'allow');
  assert.equal(plain.calls.length, 1);
  const q = queryOf(plain.calls[0]);
  assert.ok(!/deployments|environment\(|latestCompletedDeployment/.test(q), 'the file query is unchanged');
  assert.deepEqual(plain.calls[0].args.filter((a, i) => plain.calls[0].args[i - 1] === '-f').map((a) => a.split('=')[0]), ['query', 'o', 'n', 'p']);
  const s = await deployScene(t);
  assert.equal(applyMarked(s).decision, 'allow');
  const call = s.calls[1];
  const dq = queryOf(call);
  assert.deepEqual([argOf(call.args, 'env'), argOf(call.args, 'num'), argOf(call.args, 'o'), argOf(call.args, 'n')], ['Production', '42', 'acme', 'widgets']);
  for (const piece of ['latestCompletedDeployment', 'first:1', 'direction:DESC', 'field:CREATED_AT', 'environments:[$env]', 'creator { __typename login }', 'latestStatus { state createdAt creator { __typename login } }', 'commitOid', 'originalEnvironment', 'latestEnvironment', 'state', 'mergedAt', 'mergeCommit { oid }', 'nameWithOwner', 'defaultBranchRef { name target { oid } }']) assert.ok(dq.includes(piece), piece);
});
