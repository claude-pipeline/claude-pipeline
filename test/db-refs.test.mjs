// #262 (live-database guard, Task 2): the owner's registry of Supabase projects (hooks/lib/db-refs.mjs, commands/db-refs.mjs), the guard that keeps agents out of it,
// and the preflight hint. Every test uses a scratch home; the account's real file is never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageError } from '../pipeline/lib/cli.mjs';
import { run } from '../pipeline/commands/db-refs.mjs';
import { DB_REFS_REL, autoEntry, dbRefsFile, isDevRef, readDbRefs, targetOf, trustedServer } from '../pipeline/hooks/lib/db-refs.mjs';
import { evaluateBashForFiles, evaluateFileTool } from '../pipeline/hooks/lib/files-policy.mjs';
import { history } from '../pipeline/hooks/lib/live-db-auto.mjs';
import { runPreflight } from '../pipeline/lib/preflight.mjs';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { createFakeGh, createFakeCodex, fullProtection, pipelineYml, REPO_VIEW } from './helpers/fakegh-env.mjs';
import { floorEnv } from './helpers/floor-env.mjs';
import { noClaudeSession } from './helpers/no-claude-session.mjs';
import { runOwnerCli, seedRegistry } from './helpers/db-refs-owner.mjs';

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
  const set = (args) => runOwnerCli(home, ['set', ...args]);
  let r = await set(['--ref', REF, '--name', 'EagleWatch prod', '--repo', 'eaglewatch-ph/eaglewatch']);
  assert.equal(r.exitCode, 0);
  r = await set(['--ref', REF2, '--name', 'Scratch', '--repo', 'o/r', '--dev']);
  assert.equal(r.exitCode, 0);
  const shown = await run(['show'], ownerCtx(home));
  assert.equal(shown.exitCode, 0);
  assert.deepEqual(shown.output.refs, [
    { ref: REF, name: 'EagleWatch prod', repo: 'eaglewatch-ph/eaglewatch', kind: 'live', autoMigrations: false },
    { ref: REF2, name: 'Scratch', repo: 'o/r', kind: 'dev', autoMigrations: false },
  ]);
  if (process.platform !== 'win32') assert.equal(statSync(dbRefsFile(home)).mode & 0o777, 0o600);
  await set(['--ref', REF2, '--name', 'Renamed', '--repo', 'o/r']);
  assert.deepEqual((await run(['show'], ownerCtx(home))).output.refs.map((e) => [e.ref, e.name, e.kind]), [[REF, 'EagleWatch prod', 'live'], [REF2, 'Renamed', 'live']]);
  r = runOwnerCli(home, ['remove', '--ref', REF]);
  assert.equal(r.exitCode, 0);
  assert.deepEqual((await run(['show'], ownerCtx(home))).output.refs.map((e) => e.ref), [REF2]);
  assert.equal(existsSync(`${dbRefsFile(home)}.tmp`), false);
});

test('server add / remove keeps a de-duplicated list; show names the built-in servers', async (t) => {
  const home = scratchHome(t);
  runOwnerCli(home, ['server', 'add', 'my_db']);
  runOwnerCli(home, ['server', 'add', 'my_db']);
  assert.deepEqual((await run(['show'], ownerCtx(home))).output.servers, ['my_db']);
  assert.ok((await run(['show'], ownerCtx(home))).output.builtinServers.includes('plugin_supabase_supabase'));
  runOwnerCli(home, ['server', 'remove', 'my_db']);
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
  // the owner's admin switch lifts the refusal (same as every owner-only command); the write runs in a child as the owner (the writer checks the real environment)
  assert.equal(runOwnerCli(home, args, { CLAUDECODE: '1' }).exitCode, 0);
});

// R1-B2: the owner helper holds the admin switch, so a home that only LOOKS like it is under the temp folder (a `..` behind a missing folder) must be refused, not written to
test('owner helper: a home that escapes the temp folder through a missing folder is refused, and nothing is written there', () => {
  const escape = `${realpathSync(tmpdir())}/db-refs-missing-${process.pid}/../../db-refs-escape-${process.pid}`;
  assert.throws(() => runOwnerCli(escape, ['server', 'add', 'x']), /exited 3.*refusing a home outside/s);
  assert.equal(existsSync(dbRefsFile(escape)), false);
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
    `${PIPE} db-refs auto-migrations on --ref ${REF}`,
    `${PIPE} db-refs auto-migrations off --ref ${REF}`,
    'pipeline db-refs set --ref x',
    `${PIPE} db-refs`,
    `cd /tmp && ${PIPE} db-refs set --ref ${REF} --name x --repo o/r`,
  ]) assert.equal(bash(cmd), 'deny', cmd);
  for (const cmd of [`${PIPE} db-refs show`, `${PIPE} preflight`, 'git commit -m "pipeline db-refs set"']) assert.equal(bash(cmd), 'allow', cmd);
});

// #683: the registry writer library gets the recorders' run / import protection. Catches: an agent running `node -e "import('…/db-refs.mjs')…writeDbRefs(…)"` and
// rewriting which databases count as live, while the same shapes for live-db-go.mjs are already refused.
const WLIB = '/home/u/.claude/pipeline/hooks/lib/db-refs.mjs';
test('guard (#683): running or importing db-refs.mjs by hand is refused at every check site; reading it, `db-refs show`, committing it and its own test stay open', () => {
  for (const cmd of [
    `node ${WLIB}`,
    `${WLIB}`,
    `node -e "import('${WLIB}').then((m) => m.writeDbRefs(require('os').homedir(), {refs: []}))"`,
    `node --input-type=module <<'EOF'\nimport { writeDbRefs } from '${WLIB}';\nEOF`,
    `node --input-type=module <<< "import '${WLIB}'"`,
    `echo "import '${WLIB}'" | node --input-type=module`,
    'node ./pipeline/commands/db-refs.mjs',
    'node ./pipeline/hooks/lib/db-refs.mjs',
    'node /repo/pipeline/hooks/lib/db-refs.mjs',
  ]) assert.equal(bash(cmd), 'deny', cmd);
  for (const cmd of [`cat ${WLIB}`, `${PIPE} db-refs show`, 'git add pipeline/hooks/lib/db-refs.mjs', 'node --test test/db-refs.test.mjs']) assert.equal(bash(cmd), 'allow', cmd);
});

// #683: the writer itself refuses inside Claude Code (real environment, real process tree): the hook cannot see a scratch file that imports the library.
// Catches: `node scratch.mjs` importing writeDbRefs and replacing the registry (the hook allows it by design). Real child processes, disposable home.
const WRITER_LIB = fileURLToPath(new URL('../pipeline/hooks/lib/db-refs.mjs', import.meta.url));
const SESSION = ['CLAUDE', 'CODE'].join('');
function writerScene(t) {
  const home = realpathSync.native(scratchHome(t));
  const scratch = join(home, 'scratch.mjs');
  writeFileSync(scratch, [
    `import { writeDbRefs } from ${JSON.stringify(pathToFileURL(WRITER_LIB).href)};`,
    `writeDbRefs(${JSON.stringify(join(home, 'disk-home'))}, { refs: [{ ref: ${JSON.stringify(REF)}, name: 'n', repo: 'o/r', kind: 'live' }] });`,
  ].join('\n'));
  const diskHome = join(home, 'disk-home');
  return { home, scratch, diskHome, folder: join(diskHome, '.claude', 'pipeline-state'), file: dbRefsFile(diskHome) };
}
const childRun = (scene, env, parent) => spawnSync(process.execPath, parent ? [parent, scene.scratch] : [scene.scratch], { env, encoding: 'utf8' });
const withoutSession = () => { const e = { ...process.env }; delete e[SESSION]; delete e[SWITCH]; return e; };
const inSession = () => { const e = { ...process.env, [SESSION]: '1' }; delete e[SWITCH]; return e; };

test('writeDbRefs (#683): CLAUDECODE=1 refuses, naming the owner\'s terminal, and creates no registry folder or file', { skip: process.platform === 'win32' }, (t) => {
  const s = writerScene(t);
  const r = childRun(s, inSession());
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /owner's own terminal/);
  assert.equal(existsSync(s.folder), false);
});

test('writeDbRefs (#683): CLAUDECODE=1 with an existing registry refuses and leaves the bytes identical', { skip: process.platform === 'win32' }, (t) => {
  const s = writerScene(t);
  seedRegistry(s.diskHome, { refs: [{ ref: REF2, name: 'keep', repo: 'o/r', kind: 'live' }] });
  const before = readFileSync(s.file);
  assert.notEqual(childRun(s, inSession()).status, 0);
  assert.deepEqual(readFileSync(s.file), before);
});

test('writeDbRefs (#683): with the session marker removed, a Claude Code process among the ancestors still refuses (ancestry only)', { skip: process.platform === 'win32' }, (t) => {
  const s = writerScene(t);
  const dir = join(s.home, 'claude-code');
  mkdirSync(dir, { recursive: true });
  const parent = join(dir, 'cli.js');
  writeFileSync(parent, "const { spawnSync } = require('node:child_process');\nconst r = spawnSync(process.execPath, [process.argv[2]], { stdio: 'inherit' });\nprocess.exit(r.status ?? 1);\n");
  const r = childRun(s, withoutSession(), parent);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /owner's own terminal/);
  assert.equal(existsSync(s.folder), false);
});

test('writeDbRefs (#683): no Claude Code ancestor and no marker writes, including first creation of the folder', { skip: process.platform === 'win32' }, (t) => {
  const s = writerScene(t);
  const env = { ...process.env, ...noClaudeSession() };
  delete env[SESSION];
  delete env[SWITCH];
  const r = childRun(s, env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readDbRefs(s.diskHome).refs[0].ref, REF);
});

test('writeDbRefs (#683): the owner\'s admin switch writes even inside a session, including first creation of the folder', { skip: process.platform === 'win32' }, (t) => {
  const s = writerScene(t);
  const r = childRun(s, { ...process.env, [SESSION]: '1', [SWITCH]: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readDbRefs(s.diskHome).refs[0].ref, REF);
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
  seedRegistry(home, { refs: [{ ref: REF, name: 'x', repo: 'o/r', kind: 'live' }] });
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

// ---- auto-apply (Task 1): the registry's autoMigrations flag -------------------------------------------------------------------------------------------------------------

const ON = { autoMigrations: true, autoSince: '2026-11-27T01:00:00Z' };
const LIVE = (over = {}) => ({ ref: REF, name: 'EagleWatch live', repo: 'acme/widgets', kind: 'live', ...over });

test('readDbRefs: autoMigrations absent reads false; a non-boolean, or true on a dev entry, one without repo or one without a valid autoSince, is invalid', (t) => {
  // Failure caught: a hand-edited or half-written registry that the guard still believes, turning auto-apply on for a project it should not cover.
  const home = scratchHome(t);
  seedRegistry(home, { refs: [LIVE()] });
  assert.deepEqual(readDbRefs(home).refs[0], { ...LIVE(), autoMigrations: false, autoSince: null });
  seedRegistry(home, { refs: [LIVE(ON)] });
  assert.deepEqual(readDbRefs(home).refs[0], { ...LIVE(), autoMigrations: true, autoSince: '2026-11-27T01:00:00Z' });
  seedRegistry(home, { refs: [LIVE({ autoMigrations: false })] });
  assert.equal(readDbRefs(home).refs[0].autoMigrations, false);
  for (const bad of [LIVE({ autoMigrations: 'true' }), LIVE({ autoMigrations: 1 }), LIVE({ autoMigrations: null }), LIVE({ ...ON, kind: 'dev' }), LIVE({ ...ON, repo: null }), LIVE({ autoMigrations: true }), LIVE({ autoMigrations: true, autoSince: '2026-11-27' }), LIVE({ autoMigrations: true, autoSince: 'yesterday' }), LIVE({ autoMigrations: true, autoSince: '2026-11-27T01:00:00' })]) {
    seedRegistry(home, { refs: [bad] });
    assert.deepEqual(readDbRefs(home), { ok: false, reason: 'invalid' }, JSON.stringify(bad));
  }
});

test('autoEntry: two enabled entries with the same repo (hand-written registry) answer ambiguous for both; off and dev answer off', (t) => {
  // Failure caught: auto-apply choosing one of two projects that share a repo, applying an EagleWatch file to the wrong database.
  const home = scratchHome(t);
  seedRegistry(home, { refs: [LIVE({ repo: 'o/R', ...ON }), LIVE({ ref: REF2, repo: 'O/r', ...ON })] });
  const state = readDbRefs(home);
  for (const ref of [REF, REF2]) {
    const r = autoEntry(ref, state);
    assert.equal(r.entry, null);
    assert.match(r.reason, /^ambiguous: [a-z0-9]{20} has the same repo$/);
  }
  seedRegistry(home, { refs: [LIVE({ repo: 'o/R', ...ON }), LIVE({ ref: REF2, repo: 'o/r' })] });
  assert.equal(autoEntry(REF, readDbRefs(home)).entry.ref, REF);
  assert.deepEqual(autoEntry(REF2, readDbRefs(home)), { entry: null, reason: 'off' });
  assert.deepEqual(autoEntry('nnnnnnnnnnnnnnnnnnnn', readDbRefs(home)), { entry: null, reason: 'off' });
});

const OTHER_REF = 'klmnopqrst0123456789';
const NO_REPO_REF = 'nnnnnnnnnnnnnnnnnnnn';
const GO_DIR = (home) => join(home, '.claude', 'pipeline-state', 'owner-go');
const attemptsDir = (home) => join(GO_DIR(home), 'live-db-attempts');
const writeText = (file, text) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text); };
const jsonl = (v) => `${JSON.stringify(v)}\n`;

test('auto-migrations on|off: the owner turns it on and off for a live ref with a repo; show prints it; on says what it trusts and makes the history folder', async (t) => {
  // Failure caught: a switch that does not stick, or that gives no hint of the trust it grants (every PR merged into the repo).
  const home = scratchHome(t);
  seedRegistry(home, { refs: [LIVE()] });
  const on = runOwnerCli(home, ['auto-migrations', 'on', '--ref', REF]);
  assert.equal(on.exitCode, 0, JSON.stringify(on.output));
  assert.match(on.output.note, /acme\/widgets/);
  assert.match(on.output.note, /again after any rollback/);
  assert.equal(readDbRefs(home).refs[0].autoMigrations, true);
  assert.ok(existsSync(attemptsDir(home)), 'the history folder exists');
  assert.equal(on.output.refs[0].autoMigrations, true);
  assert.equal((await run(['show'], ownerCtx(home))).output.refs[0].autoMigrations, true);
  const off = runOwnerCli(home, ['auto-migrations', 'off', '--ref', REF]);
  assert.equal(off.exitCode, 0);
  assert.equal(readDbRefs(home).refs[0].autoMigrations, false);
  assert.doesNotMatch(readFileSync(dbRefsFile(home), 'utf8'), /autoMigrations|autoSince/);
  assert.ok(existsSync(attemptsDir(home)), 'off keeps the history');
});

test('auto-migrations refuses inside Claude Code; an unknown ref, a dev ref, an entry without repo and a second ref of the same repo are usage errors; nothing is written', async (t) => {
  // Failure caught: an agent switching the trust on for itself, or the switch landing on a project it cannot safely name (dev, no repo, two projects for one repo).
  const home = scratchHome(t);
  seedRegistry(home, { refs: [LIVE({ ref: REF, repo: 'o/R', ...ON }), LIVE({ ref: REF2, repo: 'O/r' }), { ref: OTHER_REF, name: 'Dev', repo: 'x/y', kind: 'dev' }, { ref: NO_REPO_REF, name: 'No repo', repo: null, kind: 'live' }] });
  const before = readFileSync(dbRefsFile(home), 'utf8');
  const inside = await run(['auto-migrations', 'on', '--ref', REF2], ownerCtx(home, { env: { CLAUDECODE: '1' } }));
  assert.equal(inside.exitCode, 2);
  assert.equal(inside.output.error, 'refused');
  assert.equal((await run(['auto-migrations', 'off', '--ref', REF], ownerCtx(home, { env: { CLAUDECODE: '1' } }))).exitCode, 2);
  for (const ref of ['qqqqqqqqqqqqqqqqqqqq', OTHER_REF, NO_REPO_REF, REF2]) await assert.rejects(() => run(['auto-migrations', 'on', '--ref', ref], ownerCtx(home)), UsageError, ref);
  for (const bad of [['auto-migrations'], ['auto-migrations', 'maybe', '--ref', REF], ['auto-migrations', 'on'], ['auto-migrations', 'on', '--ref', 'bad'], ['auto-migrations', 'on', '--ref', REF, '--name', 'x'], ['auto-migrations', 'off', '--ref', REF, '--accept-unmatched']]) await assert.rejects(() => run(bad, ownerCtx(home)), UsageError, bad.join(' '));
  assert.equal(readFileSync(dbRefsFile(home), 'utf8'), before, 'nothing written');
  assert.equal(existsSync(attemptsDir(home)), false);
});

test('auto-migrations on imports this project\'s earlier go applies; an apply with no recoverable name refuses until accepted', async (t) => {
  // Failure caught: an apply made before the switch, of a file later changed in its PR under the same name, being auto-applied again because the history never heard of the earlier apply.
  const home = scratchHome(t);
  seedRegistry(home, { refs: [LIVE()] });
  const sha = (q) => createHash('sha256').update(q).digest('hex');
  const go = GO_DIR(home);
  const marker = (id, body) => writeText(join(go, 'live-db-consumed', `${id}.json`), jsonl({ v: 1, op: 'migration', projectRef: REF, ...body }));
  const idOf = (kind, session, key) => createHash('sha256').update(`${kind}|${session}|${key}`).digest('hex').slice(0, 32);
  const rec = (session, extra) => ({ v: 1, kind: 'live-db-go', ts: '2026-11-10T09:59:00.000Z', session, op: 'migration', projectRef: REF, head: 'a'.repeat(40), file: 'f', repo: 'acme/widgets', prompt: 'go', ...extra });
  const A = { name: '20261110000000_a', sql: 'select 1;\n', session: 'sess-a' };
  const B = { name: '20261112000000_b', sql: 'select 2;\n', session: 'sess-b' };
  writeText(join(go, 'sess-a.jsonl'), jsonl(rec(A.session, { sqlSha256: sha(A.sql), name: A.name, prompt_id: 'p-a' })));
  writeText(join(go, 'sess-b.jsonl'), jsonl(rec(B.session, { sqlSha256: sha(B.sql), name: B.name, prompt_id: null, via: 'ask', ask: { askId: 'ask-000000000001', toolUseId: 'tu1', clickId: 'c1c1c1c1c1c1c1c1' } })));
  marker(idOf('live-db', A.session, 'p-a'), { consumedAt: '2026-11-10T10:00:00.000Z', sqlSha256: sha(A.sql) });
  marker(idOf('live-db-click', B.session, 'c1c1c1c1c1c1c1c1'), { consumedAt: '2026-11-12T10:00:00.000Z', sqlSha256: sha(B.sql) });
  const gone = 'select 3;\n';
  marker('f'.repeat(32), { consumedAt: '2026-11-14T10:00:00.000Z', sqlSha256: sha(gone) });
  writeText(join(go, 'live-db-consumed', `${'e'.repeat(32)}.json`), jsonl({ v: 1, op: 'migration', projectRef: OTHER_REF, consumedAt: '2026-11-15T10:00:00.000Z', sqlSha256: sha('select 4;\n') }));
  const before = readFileSync(dbRefsFile(home), 'utf8');
  const refused = runOwnerCli(home, ['auto-migrations', 'on', '--ref', REF]);
  assert.equal(refused.exitCode, 2);
  assert.equal(refused.output.error, 'unmatched-applies');
  assert.deepEqual(refused.output.unmatched, [{ sqlSha256: sha(gone).slice(0, 12), consumedAt: '2026-11-14T10:00:00.000Z' }]);
  assert.match(refused.output.message, /--accept-unmatched/);
  assert.equal(readFileSync(dbRefsFile(home), 'utf8'), before, 'nothing written');
  assert.equal(existsSync(attemptsDir(home)), false);
  const ok = runOwnerCli(home, ['auto-migrations', 'on', '--ref', REF, '--accept-unmatched']);
  assert.equal(ok.exitCode, 0, JSON.stringify(ok.output));
  assert.deepEqual(ok.output.imported.map((i) => i.name), [A.name, B.name]);
  for (const x of [A, B]) {
    const h = history({ home, ref: REF, name: x.name, sqlSha256: sha(x.sql) });
    assert.deepEqual([h.name.n, h.sql.n], [1, 1], x.name);
  }
  const g = history({ home, ref: REF, name: 'unknown', sqlSha256: sha(gone) });
  assert.deepEqual([g.name.n, g.sql.n], [0, 1], 'the unmatched apply gives the SQL key only');
  assert.equal(history({ home, ref: REF, name: 'unknown', sqlSha256: sha('select 4;\n') }).sql.n, 0, 'another project\'s apply is not imported');
  const files = readdirSync(attemptsDir(home)).sort();
  assert.equal(files.length, 5);
  assert.equal(JSON.parse(readFileSync(join(attemptsDir(home), files.find((n) => n.startsWith('name-'))), 'utf8')).via, 'go-import');
  runOwnerCli(home, ['auto-migrations', 'on', '--ref', REF, '--accept-unmatched']);
  assert.deepEqual(readdirSync(attemptsDir(home)).sort(), files, 'running it again adds nothing');
});

test('auto-migrations on refuses naming an unreadable consumed marker (of any project) and writes nothing', async (t) => {
  // Failure caught: an empty or garbled marker hiding an earlier apply from the history, so the same migration is applied again.
  const home = scratchHome(t);
  seedRegistry(home, { refs: [LIVE()] });
  const marker = join(GO_DIR(home), 'live-db-consumed', `${'a'.repeat(32)}.json`);
  writeText(marker, '');
  const before = readFileSync(dbRefsFile(home), 'utf8');
  const r = runOwnerCli(home, ['auto-migrations', 'on', '--ref', REF]);
  assert.equal(r.exitCode, 1);
  assert.ok(r.output.message.includes(marker), r.output.message);
  assert.equal(readFileSync(dbRefsFile(home), 'utf8'), before);
});

test('auto-migrations on: a registry change made by another terminal during the import is not overwritten; the command refuses and says to run it again', async (t) => {
  // Failure caught: switching project A on writes back the registry as it was read before the import, restoring the auto-apply permission the owner has just turned off for project B.
  const home = scratchHome(t);
  seedRegistry(home, { refs: [LIVE({ ref: REF, repo: 'acme/widgets' }), LIVE({ ref: REF2, repo: 'acme/other', ...ON })] });
  const changed = { v: 1, refs: [LIVE({ ref: REF, repo: 'acme/widgets' }), LIVE({ ref: REF2, repo: 'acme/other' })], servers: [] };
  const r = runOwnerCli(home, ['auto-migrations', 'on', '--ref', REF], {}, changed);
  assert.equal(r.exitCode, 1, JSON.stringify(r.output));
  assert.match(r.output.message, /run this again/i);
  const after = readDbRefs(home).refs;
  assert.deepEqual(after.map((e) => e.autoMigrations), [false, false], 'B stays off and A was not switched on');
  const again = runOwnerCli(home, ['auto-migrations', 'on', '--ref', REF]);
  assert.equal(again.exitCode, 0, JSON.stringify(again.output));
});

test('auto-migrations on: a consumed marker that carries its migration name is imported under that name with no session record left, and is not listed as unmatched', async (t) => {
  // Failure caught: the importer dropping the marker's own name, so only the SQL key is imported and an older go for the same name with different SQL still passes the freshness rule.
  const home = scratchHome(t);
  seedRegistry(home, { refs: [LIVE()] });
  const sha = (q) => createHash('sha256').update(q).digest('hex');
  const NAMED = '20261120000000_named';
  writeText(join(GO_DIR(home), 'live-db-consumed', `${'c'.repeat(32)}.json`), jsonl({ v: 1, op: 'migration', projectRef: REF, consumedAt: '2026-11-20T10:00:00.000Z', sqlSha256: sha('select 5;\n'), name: NAMED }));
  const r = runOwnerCli(home, ['auto-migrations', 'on', '--ref', REF]);
  assert.equal(r.exitCode, 0, JSON.stringify(r.output));
  assert.deepEqual(r.output.imported.map((i) => i.name), [NAMED]);
  assert.deepEqual(r.output.unmatched, []);
  const h = history({ home, ref: REF, name: NAMED, sqlSha256: sha('select 6;\n') });
  assert.deepEqual([h.name.n, h.sql.n], [1, 0], 'another SQL under the same name now finds an attempt on the name key');
});

test('set keeps auto-migrations for a label-only edit; a new repo or --dev clears it', async (t) => {
  // Failure caught: reassigning a project to another repository (or to dev) that carries the old repository's trust along.
  const home = scratchHome(t);
  seedRegistry(home, { refs: [LIVE(ON)] });
  runOwnerCli(home, ['set', '--ref', REF, '--name', 'Renamed', '--repo', 'ACME/widgets']);
  const kept = readDbRefs(home).refs[0];
  assert.deepEqual([kept.autoMigrations, kept.autoSince, kept.name], [true, '2026-11-27T01:00:00Z', 'Renamed']);
  runOwnerCli(home, ['set', '--ref', REF, '--name', 'Renamed', '--repo', 'other/x']);
  assert.equal(readDbRefs(home).refs[0].autoMigrations, false);
  seedRegistry(home, { refs: [LIVE(ON)] });
  runOwnerCli(home, ['set', '--ref', REF, '--name', 'x', '--repo', 'acme/widgets', '--dev']);
  assert.equal(readDbRefs(home).refs[0].autoMigrations, false);
});
