// #262 (live-database guard, Task 4): the decision for a Supabase MCP call on a live project, and the claim that spends the owner's go. Scratch home, real git, real transcripts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { OWNER_ENTRY, linesOf } from './helpers/owner-go.mjs';
import { runOwnerCli, seedRegistry } from './helpers/db-refs-owner.mjs';
import { buildBlock, liveDbGoOutcome, sha256Of } from '../pipeline/hooks/lib/live-db-go.mjs';
import { LIVE_DB_CONSUMED_REL, claimLiveDbGo, evaluateSupabaseMcp, isSupabaseTool } from '../pipeline/hooks/lib/live-db-guard.mjs';
import { buildCatalogQuery } from '../pipeline/hooks/lib/live-db-catalog.mjs';
import { evaluateFileTool } from '../pipeline/hooks/lib/files-policy.mjs';
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
async function scene(t, { typedAt = NOW - 60_000, op = 'migration', shownSql = SQL } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'cp-live-db-guard-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  seedRegistry(home, { refs: [{ ref: REF, name: 'EagleWatch prod', repo: 'acme/widgets', kind: 'live' }, { ref: DEV, name: 'Scratch', repo: 'acme/widgets', kind: 'dev' }] });
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
  const file = (query) => evaluateFileTool({ tool_name: `${TOOL}apply_migration`, tool_input: { project_id: REF, name: NAME, query }, cwd: s.repo.dir, session_id: s.session, transcript_path: s.transcript }, { home: s.home, env: {}, platform: process.platform, ...HOOK_CLOCK }).decision;
  assert.equal(file('drop table t'), 'deny', 'a call the go does not name is refused');
  assert.equal(file(SQL), 'allow', 'the go the owner typed allows the exact call');
  assert.equal(file(SQL), 'deny', 'and is spent');
});

test('two processes claiming the same go on one home: exactly one claims, the other sees it spent', async (t) => {
  const s = await scene(t);
  const guardUrl = new URL('../pipeline/hooks/lib/live-db-guard.mjs', import.meta.url).href;
  const args = JSON.stringify({ home: s.home, sessionId: s.session, transcriptPath: s.transcript, op: 'migration', projectRef: REF, name: NAME, sqlSha256: sha256Of(SQL), at: Date.now() + 1500, now: NOW });
  // each child waits for the same wall-clock instant, then claims once
  const child = `const { claimLiveDbGo } = await import(${JSON.stringify(guardUrl)});
const a = JSON.parse(process.argv[1]);
while (Date.now() < a.at) { /* start together */ }
const r = claimLiveDbGo({ home: a.home, sessionId: a.sessionId, transcriptPath: a.transcriptPath, op: a.op, projectRef: a.projectRef, name: a.name, sqlSha256: a.sqlSha256, now: () => a.now });
process.stdout.write(r.status);`;
  const runChild = () => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', child, args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`child exit ${code}: ${err}`))));
  });
  const outcomes = (await Promise.all([runChild(), runChild()])).sort();
  assert.deepEqual(outcomes, ['claimed', 'spent']);
  assert.equal(readdirSync(consumed(s)).length, 1);
});

// rollback safety: the previous release's owner-go.mjs (the commit before the live-db records existed) reads a home that holds live-db go records and markers
const OLD_OWNER_GO = 'bd202a3e';
const haveOld = (() => { try { execFileSync('git', ['cat-file', '-e', `${OLD_OWNER_GO}^{commit}`], { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'ignore' }); return true; } catch { return false; } })();

// (a shallow CI checkout does not hold that commit: only then is the test not run, and it says why)
test('coexistence: the previous owner-go.mjs still reads a home that holds live-db go records and markers', { skip: haveOld ? false : `commit ${OLD_OWNER_GO} is not in this checkout (shallow clone)` }, async (t) => {
  const s = await scene(t);
  assert.equal(apply(s).decision, 'allow'); // a go record in owner-go/<session>.jsonl and a marker in live-db-consumed/
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
  assert.equal(a.run('mcp__db__delete_branch', { branch_id: 'b' }).decision, 'allow', 'vendor db, collision elsewhere');
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
  assert.equal(d.run('mcp__db__delete_branch', { branch_id: 'b' }).decision, 'allow', 'same config, project dir set: a configured vendor');
});

test('#687 identity: bridges, docker, a local build and the access-token env are Supabase; an incidental path and the owner\'s own function URL are not; an expanded URL or a legacy config file leaves the server unidentified', async (t) => {
  const supa = {
    'mcp-remote bridge': { command: 'npx', args: ['-y', 'mcp-remote', 'https://mcp.supabase.com/mcp'] },
    docker: { command: 'docker', args: ['run', '-i', '--rm', 'mcp/supabase:latest'] },
    'local build': { command: 'node', args: ['/x/mcp-server-supabase/dist/transports/stdio.js'] },
    'access token env': { command: 'node', args: ['vendor.js'], env: { SUPABASE_ACCESS_TOKEN: 'synthetic' } },
  };
  for (const [label, entry] of Object.entries(supa)) {
    const s = mcpScene(t);
    s.user({ mine: entry });
    denied(s.run('mcp__mine__merge_branch', { branch_id: 'b', note: 'x' }), CONFIG_HINT, label);
  }
  const other = {
    'incidental path': { command: 'node', args: ['/work/supabase-tools/vendor.js'] },
    'own edge function': { type: 'http', url: 'https://myref.supabase.co/functions/v1/my-mcp' },
  };
  for (const [label, entry] of Object.entries(other)) {
    const s = mcpScene(t);
    s.user({ mine: entry });
    assert.equal(s.run('mcp__mine__merge_branch', { branch_id: 'b', note: 'x' }).decision, 'allow', label);
    assert.equal(s.run('mcp__mine__merge_branch', { branch_id: 'b' }).decision, 'allow', `${label}: a configured vendor is not judged by shape`);
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
