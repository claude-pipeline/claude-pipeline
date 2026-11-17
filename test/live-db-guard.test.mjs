// #262 (live-database guard, Task 4): the decision for a Supabase MCP call on a live project, and the claim that spends the owner's go. Scratch home, real git, real transcripts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { OWNER_ENTRY, linesOf } from './helpers/owner-go.mjs';
import { run as runDbRefs } from '../pipeline/commands/db-refs.mjs';
import { buildBlock, liveDbGoOutcome, sha256Of } from '../pipeline/hooks/lib/live-db-go.mjs';
import { LIVE_DB_CONSUMED_REL, claimLiveDbGo, evaluateSupabaseMcp, isSupabaseTool } from '../pipeline/hooks/lib/live-db-guard.mjs';
import { buildCatalogQuery } from '../pipeline/hooks/lib/live-db-catalog.mjs';
import { evaluateFileTool } from '../pipeline/hooks/lib/files-policy.mjs';

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
  const own = { home, env: {}, hasClaudeCodeAncestor: () => false };
  await runDbRefs(['set', '--ref', REF, '--name', 'EagleWatch prod', '--repo', 'acme/widgets'], own);
  await runDbRefs(['set', '--ref', DEV, '--name', 'Scratch', '--repo', 'acme/widgets', '--dev'], own);
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
  for (const n of ['merge_branch', 'deploy_edge_function', 'run_notebook', 'pause_project']) assert.equal(evaluateSupabaseMcp(`${TOOL}${n}`, { project_id: REF }, s.ctx).decision, 'deny', n);
  assert.equal(evaluateSupabaseMcp(`${TOOL}query_logs`, { project_id: REF }, s.ctx).decision, 'allow');
  assert.equal(evaluateSupabaseMcp('mcp__supabase__apply_migration', { project_id: REF, name: NAME, query: SQL }, s.ctx).decision, 'allow', 'the bare `supabase` server is trusted too');
});

test('dev refs are exempt only on a server the owner listed', async (t) => {
  const s = await scene(t);
  const call = (tool) => evaluateSupabaseMcp(tool, { project_id: DEV, name: 'x', query: 'drop table t' }, s.ctx).decision;
  assert.equal(call(`${TOOL}apply_migration`), 'deny');
  await runDbRefs(['server', 'add', 'mine'], { home: s.home, env: {}, hasClaudeCodeAncestor: () => false });
  assert.equal(call('mcp__mine__apply_migration'), 'allow');
});

test('a registry that cannot be read denies every write and still allows reads', async (t) => {
  const s = await scene(t);
  writeFileSync(join(STATE(s.home), 'db-refs.json'), '{bad');
  assert.equal(apply(s).decision, 'deny');
  assert.equal(evaluateSupabaseMcp(`${TOOL}list_tables`, { project_id: REF }, s.ctx).decision, 'allow');
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
