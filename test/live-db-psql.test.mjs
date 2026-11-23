// #262 (live-database guard, B1b): the psql family. A tripwire: an agent-run line that runs psql or another Postgres client cannot, by its own command line, point the client at a non-local
// database. Two psql shapes pass (a strict host psql to a literal localhost URI; psql inside a local Supabase container through `docker exec`); every other family line is refused.
// All rows go through evaluateBashForFiles with the production options (the real reparse); the SQL files and the Docker config are real files in a temp folder.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedRegistry } from './helpers/db-refs-owner.mjs';
import { evaluateBashForFiles, evaluateFileTool } from '../pipeline/hooks/lib/files-policy.mjs';

const home = mkdtempSync(join(tmpdir(), 'cp-live-db-psql-home-'));
const work = mkdtempSync(join(tmpdir(), 'cp-live-db-psql-work-'));
after(() => { rmSync(home, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); });
seedRegistry(home, { refs: [{ ref: 'zyxwvutsrq9876543210', name: 'Scratch', repo: 'acme/widgets', kind: 'dev' }] });

const OPTS = { home, env: {}, platform: 'linux', realpath: (p) => p, existsSync: () => false, cwd: work };
const run = (line, o = {}) => evaluateBashForFiles(line, { ...OPTS, ...o });
const URI = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const sql = (text) => writeFileSync(join(work, 't.sql'), text);
const dockerDir = join(home, '.docker');
const clearDocker = () => rmSync(dockerDir, { recursive: true, force: true });
const dockerConfig = (text) => { clearDocker(); mkdirSync(dockerDir, { recursive: true }); if (text !== null) writeFileSync(join(dockerDir, 'config.json'), text); };
const dockerMeta = (name, host) => {
  const dir = join(dockerDir, 'contexts', 'meta', createHash('sha256').update(name).digest('hex'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ Name: name, Endpoints: { docker: { Host: host } } }));
};
const GOOD_FILE = "\\set uid 'abc'\nselect :'uid';\n\\echo done\n\\if true\nselect 1::int;\n\\endif\n";
const DOCKER_FILE = 'docker exec -i supabase_db_e2e-ci psql -X -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < t.sql';

const mustAllow = (line, o = {}) => { const v = run(line, o); assert.equal(v.decision, 'allow', `${line}: ${v.reason}`); };
const mustRefuse = (line, o = {}, why = /live database:/) => {
  const v = run(line, o);
  assert.equal(v.decision, 'deny', `${line}: allowed`);
  assert.match(v.reason ?? '', why, line);
};

// Catches: the guard refusing the two shapes the owner's daily database work uses (a host psql to the local stack, psql inside the local Supabase container), or failing to refuse them differently.
test('the two allowed psql shapes pass (host to a literal localhost URI, docker exec into a local supabase_db container)', () => {
  dockerConfig(null);
  sql(GOOD_FILE);
  for (const line of [
    `psql -X "${URI}" -c 'select 1'`,
    'psql -X -d postgresql://postgres:postgres@localhost:54322/postgres -tAc \'select 1\'',
    `timeout 30 psql -X ${URI} -c 'select 1'`,
    'psql --version',
    "psql '-?'",
    'which psql',
    'rg -n psql docs',
    'git commit -m "psql guard"',
    'pg_config --version',
    DOCKER_FILE,
    'docker exec -i supabase_db_DRMed psql -X -U postgres -d postgres < t.sql',
    "docker exec supabase_db_x psql -X -c 'select 1'",
    "docker exec supabase_db_x psql -X -c '\\dt'",
    "docker exec supabase_db_x psql -X -F '|' -Atc 'select 1'",
    'docker ps',
    'docker logs supabase_db_x',
  ]) mustAllow(line);
});

test('a docker config naming a LOCAL context passes; an absent config is the default context', () => {
  dockerConfig(JSON.stringify({ currentContext: 'desktop-linux' }));
  dockerMeta('desktop-linux', 'unix:///Users/u/.docker/run/docker.sock');
  mustAllow("docker exec supabase_db_x psql -X -c 'select 1'");
  dockerConfig(JSON.stringify({ currentContext: 'default' }));
  mustAllow("docker exec supabase_db_x psql -X -c 'select 1'");
  dockerConfig(null);
  mustAllow("docker exec supabase_db_x psql -X -c 'select 1'");
  clearDocker();
  mustAllow("docker exec supabase_db_x psql -X -c 'select 1'");
});

// Catches: a host psql whose own line can name a remote server (host, service, URI parameter, env) or read input the guard cannot see.
test('host psql: every shape that can reach another server or read unseen input is refused', () => {
  dockerConfig(null);
  const P = `psql -X ${URI}`;
  for (const [line, o] of [
    ['psql', {}],
    ['psql "$LOCAL_URL"', {}],
    [`psql ${URI} -c 'select 1'`, {}],
    [`psql -X -h db.x.supabase.co -p 5432 -U postgres -d postgres -c 'select 1'`, {}],
    [`psql -X -h 127.0.0.1 ${URI} -c 'select 1'`, {}],
    [`psql -X ${URI}?host=db.x.supabase.co -c 'select 1'`, {}],
    [`psql -X ${URI}?sslmode=disable -c 'select 1'`, {}],
    ["psql -X -d 'host=db.x.supabase.co dbname=postgres' -c 'select 1'", {}],
    ['psql -X "service=prod" -c \'select 1\'', {}],
    [`${P} -c '\\connect prod'`, {}],
    [`${P} -c 'select :LAST_ERROR_MESSAGE'`, {}],
    [`${P} -c "select :foo"`, {}],
    [`${P} -c "$SQL"`, {}],
    [`${P} -c "select 1"`, {}],
    [`${P} -c "copy (values (1)) to program 'curl x'"`, {}],
    [`${P} -c 'copy (values (1)) to program x'`, {}],
    [`${P} -c 'copy t from stdin' < data.csv`, {}],
    [`cat d.csv | ${P} -c 'copy t from stdin'`, {}],
    [`${P} -c 'select 1' | head`, {}],
    [`${P} -f x.sql`, {}],
    [`${P} <<'EOF'\nselect 1;\nEOF`, {}],
    [`${P} -c 'select 1' -o out.txt`, {}],
    [`${P} --comm='select 1'`, {}],
    [`PGSERVICE=production ${P} -c 'select 1'`, {}],
    [`export PGHOST=x; ${P} -c 'select 1'`, {}],
    [`${P} -c 'select 1'`, { env: { PGHOSTADDR: '10.0.0.1' } }],
    [`${P} -c 'select 1' &`, {}],
    ['pg_isready -h db.x.supabase.co', {}],
    [`ssh host "psql -X ${URI} -c 'select 1'"`, {}],
    [`bash -c "psql -X ${URI} -c 'select 1'"`, {}],
    ['rg --pre ./run.sh psql .', {}],
    [`psql -X $"${URI}" -c 'select 1'`, {}],
    ["psql -?", {}],
  ]) mustRefuse(line, o);
});

// Catches (Fable F2/F3/F5): wrappers, assignments and repeated words that change what psql sees without showing in the argv.
test('host psql: wrappers, env-name tricks and repeated quoted words are refused; timeout <duration> alone passes', () => {
  dockerConfig(null);
  const P = `psql -X ${URI} -c 'show server_version'`;
  mustAllow(`timeout 30 ${P}`);
  for (const line of [
    `timeout -s KILL 30 ${P}`,
    `npx ${P}`,
    `sudo -u postgres ${P}`,
    `wsl ${P}`,
    `env HOME=/tmp ${P}`,
    `export PGHOSTADDR+=10.0.0.1; ${P}`,
    `read PGHOST <<< x; ${P}`,
    `printf -v PGHOST x; ${P}`,
    `${P} -c 'show server_version'`,
    `${P}; echo done`,
    `echo x && ${P}`,
  ]) mustRefuse(line);
});

test('docker psql: a repeated plain word (-U postgres -d postgres) still passes', () => {
  dockerConfig(null);
  mustAllow("docker exec supabase_db_x psql -X -U postgres -d postgres -c 'select 1'");
});

// Catches: the SQL a docker psql reads (a file or -c) carrying a meta-command, an interpolation or a word that reaches out of the container.
test('docker psql: a SQL file with any meta-command outside the allow-list, raw interpolation or unreadable encoding is refused', () => {
  dockerConfig(null);
  const bad = [
    '\\c other\n', '\\connect other\n', '\\i x.sql\n', '\\ir x.sql\n', '\\! id\n', '\\o out.txt\n', '\\copy t from x\n', '\\gset\n', '\\setenv X 1\n', '\\encoding SJIS\n',
    "\\set x '\\\\c y'\n", "\\set x ':y'\n", "\\set X 1\n", '\\set ON_ERROR_STOP :foo\n', "\\set ON_ERROR_STOP 'x y'\n", '\\set ON_ERROR_STOP on now\n', '\\set ON_ERROR_STOP ON\n', '\\echo `id`\n', 'select :uid;\n', 'select :LAST_ERROR_MESSAGE;\n', 'select 1;\rselect 2;\n', 'select 1;\0\n',
    '\\pset pager on\n', '\\g out.txt\n', "copy t from program 'x';\n", 'create extension dblink;\n', '/* a\n-- */ \\c x\n', '$$ a\n-- $$ \\c x\n',
    'select 1:::uid;\n', "\\set x 'a' b\n", 'select 1; \\if \\c x\n',
    Buffer.from([0x73, 0xff, 0x0a]), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('select 1;\n')]),
  ];
  for (const text of bad) {
    sql(text);
    mustRefuse(DOCKER_FILE);
  }
  sql('-- \uFFFD a real replacement character\nselect 1;\n');
  mustAllow(DOCKER_FILE);
  sql(GOOD_FILE);
  mustAllow(DOCKER_FILE);
  sql('select 1::int;\n');
  mustAllow(DOCKER_FILE);
  for (const v of ['on', 'off', '1', '0', 'true', 'false']) { sql(`\\set ON_ERROR_STOP ${v}\nselect 1;\n`); mustAllow(DOCKER_FILE); }
  // the same checks apply to -c
  mustRefuse("docker exec supabase_db_x psql -X -c '\\c other'");
  mustRefuse("docker exec supabase_db_x psql -X -c 'select :uid'");
});

// Catches: the file the guard reads not being the file psql reads (missing, a directory, too big, a path the shell rewrites), or stdin arriving some other way.
test('docker psql: the file read is bounded and the redirect must be the one literal file', () => {
  dockerConfig(null);
  sql(GOOD_FILE);
  rmSync(join(work, 'gone.sql'), { force: true });
  mkdirSync(join(work, 'adir'), { recursive: true });
  writeFileSync(join(work, 'big.sql'), Buffer.alloc(1_000_001, 0x20));
  const D = 'docker exec -i supabase_db_x psql -X';
  for (const line of [
    `${D} < gone.sql`,
    `${D} < adir`,
    `${D} < big.sql`,
    `${D} < "$F"`,
    `${D} < ~/t.sql`,
    `${D} -f /tmp/t.sql`,
    `${D} <<'EOF'\nselect 1;\nEOF`,
    `${D} <<< 'select 1'`,
    `cat t.sql | ${D}`,
    'docker exec supabase_db_x psql -X -f - < t.sql',
    "docker exec -it supabase_db_x psql -X -c 'select 1'",
    D,
    `echo x >> t.sql; ${D} < t.sql`,
    `cd sub && ${D} < t.sql`,
    `> t.sql; ${D} < t.sql`,
    `${D} < t.sql 2> t.sql`,
    `${D} < t.sql > t.sql`,
    `${D} -f - < t.sql | head`,
  ]) mustRefuse(line);
});

// Catches: a docker psql that is pointed anywhere but the local container's own server, or that changes what runs in the container.
test('docker psql: container name, options and program are pinned; tampering with a supabase_db container is refused', () => {
  dockerConfig(null);
  sql(GOOD_FILE);
  for (const line of [
    'docker exec -i -e PGPASSWORD=postgres supabase_db_x psql -X -U postgres -d postgres < t.sql',
    'docker exec -i supabase_db_x psql -X -h 127.0.0.1 < t.sql',
    "docker exec -i supabase_db_x psql -X -d 'host=db.x dbname=postgres' < t.sql",
    "docker exec -i supabase_db_x psql -X -c \"$SQL\"",
    'docker exec -i "$DB_CONTAINER" psql -X < t.sql',
    'docker exec -i drm-guard-pg psql -X < t.sql',
    'docker exec -i supabase_db_x psql < t.sql',
    'docker --context prod exec -i supabase_db_x psql -X < t.sql',
    'DOCKER_HOST=ssh://x docker exec -i supabase_db_x psql -X < t.sql',
    'docker exec -u root supabase_db_x psql -X -c \'select 1\'',
    'docker exec supabase_db_x pg_dumpall',
    "docker exec supabase_db_x sh -c 'echo hi'",
    'docker cp w supabase_db_x:/usr/local/bin/psql',
    'docker run --name supabase_db_y postgres',
    'docker rename a supabase_db_y',
    "docker exec supabase_db_x psql -X -c $\"select 1\"",
    "docker exec supabase_db_x psql -X -c $'select 1'",
    "docker exec supabase_db_x psql -X -c 'select 1' -c 'select 1'",
    "docker context use prod; docker exec supabase_db_x psql -X -c 'select 1'",
    "sudo docker exec supabase_db_x psql -X -c 'select 1'",
    "env HOME=/tmp/h docker exec supabase_db_x psql -X -c 'select 1'",
    "docker exec supabase_db_x psql -X -c 'select 1' | head -1",
    'kubectl exec db -- psql -c \'select 1\'',
    'podman exec x psql -X',
    'docker run img psql',
    'docker compose exec db psql -X',
  ]) mustRefuse(line);
  mustRefuse("docker exec supabase_db_x psql -X -c 'select 1'", { env: { DOCKER_HOST: 'ssh://x' } });
  mustRefuse("docker exec supabase_db_x psql -X -c 'select 1'", { env: { DOCKER_CONTEXT: 'prod' } });
  mustRefuse("docker exec supabase_db_x psql -X -c 'select 1'", { env: { DOCKER_CONFIG: '/tmp/x' } });
});

// Catches (Codex R1 P1-1, R2-1): a saved Docker context or config the agent cannot see on the line sending the exec to a remote daemon.
test('docker psql: the Docker endpoint must be proven local from the config file; unreadable, invalid or remote refuses', () => {
  const Q = "docker exec supabase_db_x psql -X -c 'select 1'";
  dockerConfig(JSON.stringify({ currentContext: 'prod' }));
  dockerMeta('prod', 'ssh://x');
  mustRefuse(Q);
  dockerConfig(JSON.stringify({ currentContext: 'missing' }));
  mustRefuse(Q);
  dockerConfig('{not json');
  mustRefuse(Q);
  dockerConfig(JSON.stringify({ currentContext: 7 }));
  mustRefuse(Q);
  dockerConfig(null);
  mkdirSync(join(dockerDir, 'config.json'));
  mustRefuse(Q); // present but not a regular file: unreadable, not absent
  // a Windows named pipe: only the local form
  dockerConfig(JSON.stringify({ currentContext: 'win' }));
  dockerMeta('win', 'npipe://otherhost/pipe/docker_engine');
  mustRefuse(Q, { platform: 'win32' });
  dockerMeta('win', 'npipe:////./pipe/docker_engine');
  mustAllow(Q, { platform: 'win32' });
});

// Catches (Fable F1): the lines the guard reads again (a piped shell, a script, eval, a held command line) hiding a psql line behind the outer line's other commands.
test('a psql family word inside script text the guard reads again is refused, whatever the shape', () => {
  dockerConfig(null);
  writeFileSync(join(work, 'x.sh'), "docker exec supabase_db_x psql -X -c 'select 1'\n");
  mustRefuse("bash -s <<'EOF'\ndocker exec supabase_db_x psql -X -c 'select 1'\nEOF");
  mustRefuse('bash x.sh', { existsSync: (p) => p.startsWith(work) });
  mustRefuse(`eval "psql -X ${URI} -c 'select 1'"`);
  mustRefuse(`L="psql -X ${URI} -c 'select 1'"; $L`);
});

// Catches: every other member of the family (dump, restore, other clients, the pg_* utilities) and every launcher that runs psql with arguments the guard cannot read.
test('the other family programs and psql behind launchers or variables are refused', () => {
  dockerConfig(null);
  for (const line of [
    'pg_dump -h 127.0.0.1 postgres', 'pg_restore x.dump', 'pg_dumpall', 'pgcli', 'usql pg://x',
    'dropdb x', 'createdb x', 'vacuumdb x', 'reindexdb x', 'clusterdb x', 'pgbench x', 'pg_basebackup -D x', 'pg_receivewal -D x',
    'createuser x', 'dropuser x', 'pg_amcheck x', 'pg_isready', 'vacuumlo x', 'oid2name', 'pg_upgrade --version',
    "kubectl exec db -- psql -c 'select 1'",
    'kubectl exec db -- pg_repack -h prod',
    'kubectl exec db -- pg_repack --version',
    'pgloader x.load', 'pgbadger log', 'pgcopydb clone', 'pgbackrest backup', 'pgcenter top', 'kubectl exec db -- pgloader x.load', // listed clients without a pg_ prefix
    "doppler run --command 'psql -c 1'",
    "$PSQL -c 'select 1'",
    'DB=(docker exec -i "$C" psql); "${DB[@]}" -c \'select 1\'',
    'ls | xargs psql',
    `git -c core.pager='psql -X ${URI} -c "select 1"' grep -O x`,
    `git -C /repo -c core.pager='psql -X ${URI} -c "select 1"' grep -O x`,
    'git --config-env=core.pager=X log psql',
    "rg --pre ./x psql",
    'echo psql > run.sh',
  ]) mustRefuse(line);
  // a data-only mention passes (the command cannot run psql)
  for (const line of ['echo psql', 'grep -rn pg_dump docs', 'git log --grep=psql', 'cat psql.md', 'ls psql']) mustAllow(line);
});

// Catches: a family name split by empty quotes (`p''sql`) missing from the raw line text but present in the parsed words, so the psql rule (and the supabase_db_ docker rule) was skipped altogether.
test('a psql family or supabase_db_ name split by empty quotes is refused like the plain name', () => {
  dockerConfig(null);
  for (const line of [
    "p''sql -h prod.example.com -c 'select 1'",
    'p"s"ql -h prod.example.com -c \'select 1\'',
    "pg''_dump -h prod.example.com x",
    "docker exec supa''base_db_x sh -c 'echo hi'",
  ]) mustRefuse(line);
});

// Catches (round 1, R1-B1): `sub/../t.sql` collapsed by the guard's path.resolve while the shell lets the kernel follow a symlink `sub` first, so the guard scans one file and psql reads another.
test('docker psql: an input path with a `..` component is refused; a plain ./ path passes', () => {
  dockerConfig(null);
  sql(GOOD_FILE);
  mkdirSync(join(work, 'sub'), { recursive: true });
  const D = 'docker exec -i supabase_db_x psql -X -f -';
  mustRefuse(`${D} < sub/../t.sql`);
  mustRefuse(`${D} < ../t.sql`);
  mustAllow(`${D} < ./t.sql`);
});

// Catches (round 1, R1-B2): a `pg_*` client that is not in the fixed name list (pg_repack, pg_prove) skipping the family check because the line text holds no listed name.
test('any pg_* program (but pg_config) run as a command is refused, also spelled with empty quotes; catalog names in data pass', () => {
  dockerConfig(null);
  for (const line of ['pg_repack -h db.x.supabase.co -d postgres', 'pg_prove -h db.x.supabase.co -d postgres tests/a.sql', "pg''_repack -h db.x.supabase.co", 'timeout 30 pg_prove -d postgres t.sql']) mustRefuse(line);
  for (const line of ['echo pg_class', 'grep -rn pg_repack docs', 'pg_config --version', 'psql_x --help', "node scripts/q.mjs 'select * from pg_class'"]) mustAllow(line);
  for (const line of ['kubectl exec db -- /usr/bin/pg_repack -h prod', "ssh db-host 'pg_repack -h prod -d postgres'", "doppler run --command 'pg_repack -h prod'", "kubectl exec db -- sh -c 'pg_repack -h prod'"]) mustRefuse(line);
});

// Catches (round 1, R1-B4): Docker's Go decoder reads `CurrentContext` / `host` as the same field as `currentContext` / `Host`; an exact-key lookup saw no context and approved the default (local) endpoint.
test('docker psql: a Docker config or context file spelling a key with other letter case is refused', () => {
  const Q = "docker exec supabase_db_x psql -X -c 'select 1'";
  for (const key of ['CurrentContext', 'currentcontext', 'CURRENTCONTEXT']) {
    dockerConfig(JSON.stringify({ [key]: 'staging' }));
    dockerMeta('staging', 'ssh://x');
    mustRefuse(Q);
  }
  dockerConfig(JSON.stringify({ currentContext: 'staging' }));
  const dir = join(dockerDir, 'contexts', 'meta', createHash('sha256').update('staging').digest('hex'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ Name: 'staging', Endpoints: { docker: { host: 'unix:///var/run/docker.sock' } } }));
  mustRefuse(Q);
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ Name: 'staging', endpoints: { docker: { Host: 'unix:///var/run/docker.sock' } } }));
  mustRefuse(Q);
  dockerMeta('staging', 'unix:///var/run/docker.sock');
  mustAllow(Q);
});

// Catches (round 1, R1-B5, R1-F2, R1-F1): a read-only search, a PR body / commit message or `command -v` that merely NAMES psql and PGHOST being refused, while a line that sets those names next to a client still is.
test('lines that run no client pass even when they name psql and PG* variables; setting a name next to a client is still refused', () => {
  dockerConfig(null);
  const P = `psql -X ${URI} -c 'select 1'`;
  for (const line of [
    "rg -n 'psql|PGHOST' docs",
    "rg -l 'psql|PGHOST' docs | sort",
    "cd docs && rg -n 'psql|PGHOST' .",
    "rg -n 'psql|PGHOST' docs | cut -c1-80",
    "rg -l 'psql|DATABASE_URL' docs | sort | uniq",
    "rg -l 'psql|PGHOST' docs | uniq --skip-fields 1 -",
    'git add supabase/migrations/pg_cron.sql',
    'git add db/pg_partman',
    'git checkout -b pg_cron_fix',
    'mkdir pg_dumps',
    'rm -rf pg_data',
    'grep -rn \'psql "$DATABASE_URL"\' scripts',
    'gh pr create --title t --body "Runs psql against the local stack; DATABASE_URL is no longer read"',
    'git -C /repo commit -m "psql guard: refuse PGHOST lines"',
    'command -v psql',
    'command -v pg_dump >/dev/null && echo ok',
    'if command -v psql; then echo ok; fi',
  ]) mustAllow(line);
  for (const line of [
    `export PGHOST+=x; ${P}`,
    `read PGHOST <<< x; ${P}`,
    `: "\${PGHOST:=x}"; ${P}`,
    `PG''HOST=x ${P}`,
    `export PGHOST=x; rg -n psql docs`,
    "rg -l 'psql|PGHOST' docs | sort -o out.sh",
    "rg -l 'psql|PGHOST' docs | uniq - out.sh",
    "rg -l 'psql|PGHOST' docs | uniq -- - -report",
    "rg -l 'psql|PGHOST' docs | uniq - -report",
    'git switch pg_repack', // a listed client name as an operand of a non-data git subcommand fails closed, as `git switch psql` does
    'rg --pre pg_repack x docs',
    'sort --compress-program pg_repack f',
    'ack --pager pg_repack x',
    'rg --pre=pg_repack x docs',
    'sort --compress-program=pg_repack f',
    'ack --pager=pg_repack x',
    `rg -n psql docs; ${P}`,
    `gh pr create --title t --body "$(PGHOST=db.x.supabase.co psql -c 'select 1')"`,
    `gh pr create --title t --body "$(export PGHOST=x; ${P})"`,
    'command psql -h db.x.supabase.co',
  ]) mustRefuse(line);
});

// Catches (round 1, R1-F4, R1-F3): a SQL file with a time of day, a JSON number or a slice bound refused for `:<digit>` (never a psql variable); `\pset` with extra spaces before `pager` slipping through.
test('docker psql: a colon followed by a digit passes; a colon followed by a name stays refused; \\pset with spaces before a pager setting is refused', () => {
  dockerConfig(null);
  sql("select '2026-11-23 08:00:00+08'::timestamptz, '08:30', 'http://localhost:54321', '{\"count\":5}'::jsonb, (a)[1:3];\n");
  mustAllow(DOCKER_FILE);
  for (const text of ['select :a1;\n', 'select :_x;\n', 'select :{?x};\n', '\\pset   \t PAGER on\n', 'select 1;\n\\pset x\n\\pset  pager\n']) { sql(text); mustRefuse(DOCKER_FILE); }
});

// Catches (round 1, R1-B3): an MCP tool that runs a shell line on ANOTHER host (ssh, a remote shell) getting the local approval of the docker psql shapes, proven from THIS machine's Docker config and SQL file.
test('a shell line handed to an MCP command tool is a psql family line the local proofs cannot clear; the same line through Bash still passes', () => {
  dockerConfig(null);
  sql(GOOD_FILE);
  const mcp = (command) => evaluateFileTool({ tool_name: 'mcp__ssh__exec', tool_input: { command }, cwd: work }, { ...OPTS });
  for (const line of ["docker exec supabase_db_x psql -X -c 'select 1'", DOCKER_FILE, `psql -X "${URI}" -c 'select 1'`]) {
    mustAllow(line);
    const v = mcp(line);
    assert.equal(v.decision, 'deny', `${line}: allowed through MCP`);
    assert.match(v.reason ?? '', /live database:/, line);
  }
  assert.equal(mcp('docker ps').decision, 'allow');
});
