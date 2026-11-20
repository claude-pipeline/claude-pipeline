// #262 (live-database guard, Task 2): the owner's registry of Supabase projects (hooks/lib/db-refs.mjs, commands/db-refs.mjs), the guard that keeps agents out of it,
// and the preflight hint. Every test uses a scratch home; the account's real file is never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageError } from '../pipeline/lib/cli.mjs';
import { run } from '../pipeline/commands/db-refs.mjs';
import { DB_REFS_REL, dbRefsFile, isDevRef, readDbRefs, targetOf, trustedServer } from '../pipeline/hooks/lib/db-refs.mjs';
import { evaluateBashForFiles, evaluateFileTool } from '../pipeline/hooks/lib/files-policy.mjs';
import { runPreflight } from '../pipeline/lib/preflight.mjs';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { createFakeGh, createFakeCodex, fullProtection, pipelineYml, REPO_VIEW } from './helpers/fakegh-env.mjs';
import { floorEnv } from './helpers/floor-env.mjs';

const REF = 'abcdefghij0123456789';
const REF2 = 'zyxwvutsrq9876543210';
const SWITCH = ['PIPELINE', 'ADMIN'].join('_');

const scratchHome = (t) => {
  const home = mkdtempSync(join(tmpdir(), 'cp-db-refs-'));
  t.after(() => { try { chmodSync(home, 0o700); } catch { /* gone */ } rmSync(home, { recursive: true, force: true }); });
  return home;
};
const ownerCtx = (home, over = {}) => ({ home, env: {}, hasClaudeCodeAncestor: () => false, ...over });

test('set / show / remove round-trip; a duplicate ref replaces its entry; the file is 0600', async (t) => {
  const home = scratchHome(t);
  const set = (args) => run(['set', ...args], ownerCtx(home));
  let r = await set(['--ref', REF, '--name', 'EagleWatch prod', '--repo', 'eaglewatch-ph/eaglewatch']);
  assert.equal(r.exitCode, 0);
  r = await set(['--ref', REF2, '--name', 'Scratch', '--repo', 'o/r', '--dev']);
  assert.equal(r.exitCode, 0);
  const shown = await run(['show'], ownerCtx(home));
  assert.equal(shown.exitCode, 0);
  assert.deepEqual(shown.output.refs, [
    { ref: REF, name: 'EagleWatch prod', repo: 'eaglewatch-ph/eaglewatch', kind: 'live' },
    { ref: REF2, name: 'Scratch', repo: 'o/r', kind: 'dev' },
  ]);
  if (process.platform !== 'win32') assert.equal(statSync(dbRefsFile(home)).mode & 0o777, 0o600);
  await set(['--ref', REF2, '--name', 'Renamed', '--repo', 'o/r']);
  assert.deepEqual((await run(['show'], ownerCtx(home))).output.refs.map((e) => [e.ref, e.name, e.kind]), [[REF, 'EagleWatch prod', 'live'], [REF2, 'Renamed', 'live']]);
  r = await run(['remove', '--ref', REF], ownerCtx(home));
  assert.equal(r.exitCode, 0);
  assert.deepEqual((await run(['show'], ownerCtx(home))).output.refs.map((e) => e.ref), [REF2]);
  assert.equal(existsSync(`${dbRefsFile(home)}.tmp`), false);
});

test('server add / remove keeps a de-duplicated list; show names the built-in servers', async (t) => {
  const home = scratchHome(t);
  await run(['server', 'add', 'my_db'], ownerCtx(home));
  await run(['server', 'add', 'my_db'], ownerCtx(home));
  assert.deepEqual((await run(['show'], ownerCtx(home))).output.servers, ['my_db']);
  assert.ok((await run(['show'], ownerCtx(home))).output.builtinServers.includes('plugin_supabase_supabase'));
  await run(['server', 'remove', 'my_db'], ownerCtx(home));
  assert.deepEqual((await run(['show'], ownerCtx(home))).output.servers, []);
  await assert.rejects(() => run(['server', 'add', 'bad name!'], ownerCtx(home)), UsageError);
  await assert.rejects(() => run(['server', 'add'], ownerCtx(home)), UsageError);
});

test('the changing subcommands refuse inside Claude Code (CLAUDECODE=1 and a Claude ancestor); show runs anywhere; nothing is written', async (t) => {
  const home = scratchHome(t);
  const args = ['set', '--ref', REF, '--name', 'x', '--repo', 'o/r'];
  let r = await run(args, ownerCtx(home, { env: { CLAUDECODE: '1' } }));
  assert.equal(r.exitCode, 2);
  assert.equal(r.output.error, 'refused');
  r = await run(args, ownerCtx(home, { hasClaudeCodeAncestor: () => true }));
  assert.equal(r.exitCode, 2);
  for (const a of [['remove', '--ref', REF], ['server', 'add', 'x']]) assert.equal((await run(a, ownerCtx(home, { env: { CLAUDECODE: '1' } }))).exitCode, 2, a.join(' '));
  assert.equal(existsSync(dbRefsFile(home)), false);
  assert.equal((await run(['show'], ownerCtx(home, { env: { CLAUDECODE: '1' } }))).exitCode, 0);
  // the owner's admin switch lifts the refusal (same as every owner-only command); it is only read here
  assert.equal((await run(args, ownerCtx(home, { env: { [SWITCH]: '1', CLAUDECODE: '1' } }))).exitCode, 0);
});

test('usage errors: a bad ref, name or repo, an option on the wrong subcommand, an unknown subcommand', async (t) => {
  const home = scratchHome(t);
  for (const a of [
    ['set', '--ref', 'ABC', '--name', 'x', '--repo', 'o/r'],
    ['set', '--ref', REF.toUpperCase(), '--name', 'x', '--repo', 'o/r'],
    ['set', '--ref', REF, '--repo', 'o/r'],
    ['set', '--ref', REF, '--name', 'a\nb', '--repo', 'o/r'],
    ['set', '--ref', REF, '--name', 'x', '--repo', 'nope'],
    ['remove'], ['remove', '--ref', 'x'], ['show', '--ref', REF], ['frobnicate'], [],
  ]) await assert.rejects(() => run(a, ownerCtx(home)), UsageError, a.join(' '));
});

test('readDbRefs: missing = ok with no refs, garbage = invalid, a folder = unreadable, wrong shapes = invalid', (t) => {
  const home = scratchHome(t);
  assert.deepEqual(readDbRefs(home), { ok: true, refs: [], servers: [], missing: true });
  mkdirSync(join(home, '.claude', 'pipeline-state'), { recursive: true });
  const file = dbRefsFile(home);
  writeFileSync(file, '{not json');
  assert.deepEqual(readDbRefs(home), { ok: false, reason: 'invalid' });
  for (const body of [
    '[]', '{"v":2,"refs":[]}', '{"v":1}', '{"v":1,"refs":[{"ref":"ABC","name":"x","kind":"live"}]}',
    `{"v":1,"refs":[{"ref":"${REF}","name":"x","kind":"prod"}]}`,
    `{"v":1,"refs":[{"ref":"${REF}","name":"x","kind":"live"},{"ref":"${REF}","name":"y","kind":"dev"}]}`,
    '{"v":1,"refs":[],"servers":"x"}', '{"v":1,"refs":[],"servers":["a b"]}',
  ]) { writeFileSync(file, body); assert.deepEqual(readDbRefs(home), { ok: false, reason: 'invalid' }, body); }
  rmSync(file);
  mkdirSync(file);
  assert.deepEqual(readDbRefs(home), { ok: false, reason: 'unreadable' });
});

test('targetOf: unregistered = live, dev only for a declared ref on an owner-listed server, malformed or absent = unknown, trusted servers', () => {
  const state = { ok: true, refs: [{ ref: REF, name: 'Prod', repo: null, kind: 'live' }, { ref: REF2, name: 'Scratch', repo: null, kind: 'dev' }], servers: ['mine'] };
  assert.deepEqual(targetOf(REF, state, 'supabase'), { kind: 'live', ref: REF, label: 'Prod', trusted: true });
  assert.equal(targetOf('qqqqqqqqqqqqqqqqqqqq', state, 'supabase').label, 'unregistered project qqqqqqqqqqqqqqqqqqqq');
  assert.equal(targetOf('qqqqqqqqqqqqqqqqqqqq', state, 'supabase').kind, 'live');
  // a dev declaration on the built-in server that the owner did not list is treated live
  assert.equal(targetOf(REF2, state, 'plugin_supabase_supabase').kind, 'live');
  assert.equal(targetOf(REF2, state, 'mine').kind, 'dev');
  assert.equal(targetOf(REF2, state, 'mine').trusted, true);
  assert.equal(targetOf(REF, state, 'other').trusted, false);
  for (const bad of [undefined, null, 'ABC', 42, '', `${REF}x`, {}]) assert.equal(targetOf(bad, state, 'supabase').kind, 'unknown', String(bad));
  assert.equal(isDevRef(REF2, state), true);
  assert.equal(isDevRef(REF, state), false);
  assert.equal(trustedServer('plugin_supabase_supabase', {}), true);
  assert.equal(trustedServer('mine', { servers: ['mine'] }), true);
  assert.equal(trustedServer('mine', {}), false);
});

// ---- the guard ----------------------------------------------------------------------------------------------------------------

const LINUX = { home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, existsSync: () => false, cwd: '/repo' };
const bash = (command) => evaluateBashForFiles(command, LINUX).decision;
const file = (tool_name, tool_input) => evaluateFileTool({ tool_name, tool_input, cwd: '/repo' }, LINUX).decision;
const PIPE = 'node ~/.claude/pipeline/bin/pipeline.mjs';

test('guard: the registry file is protected from file tools and shell writes; reading it and `db-refs show` stay open', () => {
  const F = `/home/u/${DB_REFS_REL}`;
  assert.equal(file('Write', { file_path: F, content: '{}' }), 'deny');
  assert.equal(file('Edit', { file_path: F, old_string: 'a', new_string: 'b' }), 'deny');
  assert.equal(file('Write', { file_path: `~/${DB_REFS_REL}`, content: '{}' }), 'deny');
  for (const cmd of [`echo x > ~/${DB_REFS_REL}`, `cp /tmp/x ~/${DB_REFS_REL}`, `rm ~/${DB_REFS_REL}`, `mv /tmp/x ${F}`, `tee ${F} < /tmp/x`, `sed -i s/a/b/ ${F}`]) {
    assert.equal(bash(cmd), 'deny', cmd);
  }
  for (const cmd of [`cat ~/${DB_REFS_REL}`, `grep ref ${F}`, `${PIPE} db-refs show`]) assert.equal(bash(cmd), 'allow', cmd);
});

test('guard: an agent line running `pipeline db-refs set|remove|server` is refused, `show` is allowed', () => {
  for (const cmd of [
    `${PIPE} db-refs set --ref ${REF} --name x --repo o/r`,
    `${PIPE} db-refs set --ref ${REF} --name x --repo o/r --dev`,
    `${PIPE} db-refs remove --ref ${REF}`,
    `${PIPE} db-refs server add evil`,
    'pipeline db-refs set --ref x',
    `${PIPE} db-refs`,
    `cd /tmp && ${PIPE} db-refs set --ref ${REF} --name x --repo o/r`,
  ]) assert.equal(bash(cmd), 'deny', cmd);
  for (const cmd of [`${PIPE} db-refs show`, `${PIPE} preflight`, 'git commit -m "pipeline db-refs set"']) assert.equal(bash(cmd), 'allow', cmd);
});

// ---- preflight hint -----------------------------------------------------------------------------------------------------------

function healthy(env = {}) {
  const fake = createFakeGh([
    { match: '^auth status', code: 0 },
    { match: '^api user', stdout: 'me\n' },
    { match: '^repo view', stdoutJson: REPO_VIEW },
    { match: 'branches/main/protection', stdoutJson: fullProtection(['ci']) },
    { match: '^issue list --label pipeline-pause', stdoutJson: [] },
    { match: '^issue list --label pipeline-rollback', stdoutJson: [] },
  ]);
  return { ...fake.env, ...createFakeCodex({}).env, ...floorEnv(), ...env };
}
const repoWith = (migrations) => {
  const repo = createTmpRepo();
  repo.write('.claude/pipeline.yml', pipelineYml('github'));
  if (migrations) repo.write('supabase/migrations/20260101000000_init.sql', 'select 1;\n');
  repo.commit('init');
  return repo;
};

test('preflight: a repo with supabase/migrations and no db-refs file gets the registry hint; with a valid file or without the folder, none', async (t) => {
  const home = scratchHome(t);
  const env = healthy({ HOME: home, USERPROFILE: home });
  const hint = (r) => r.warnings.filter((w) => /db-refs/.test(w));
  const repo = repoWith(true);
  const r1 = await runPreflight({ cwd: repo.dir, env });
  assert.equal(hint(r1).length, 1, JSON.stringify(r1.warnings));
  assert.match(hint(r1)[0], /pipeline db-refs set --ref/);
  await run(['set', '--ref', REF, '--name', 'x', '--repo', 'o/r'], ownerCtx(home));
  assert.equal(hint(await runPreflight({ cwd: repo.dir, env })).length, 0);
  const plain = repoWith(false);
  rmSync(dbRefsFile(home));
  assert.equal(hint(await runPreflight({ cwd: plain.dir, env })).length, 0);
});

test('preflight: an invalid registry file is reported when the repo has supabase/migrations', async (t) => {
  const home = scratchHome(t);
  mkdirSync(join(home, '.claude', 'pipeline-state'), { recursive: true });
  writeFileSync(dbRefsFile(home), '{garbage');
  const repo = repoWith(true);
  const r = await runPreflight({ cwd: repo.dir, env: healthy({ HOME: home, USERPROFILE: home }) });
  assert.ok(r.warnings.some((w) => /db-refs/.test(w) && /invalid/.test(w)), JSON.stringify(r.warnings));
});
