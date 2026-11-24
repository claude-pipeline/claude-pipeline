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
    'git switch pg_repack',
    'rg -l pg_foo docs | xargs wc -l',
    'git switch pgloader', 'rg pgbadger docs', 'gh issue create --title pg_repack',
    'git add db/pg_partman',
    'git checkout -b pg_cron_fix',
    'mkdir pg_dumps',
    'rg -n psql docs; git add supabase/migrations/pg_cron.sql', // a listed name in a search does not make a data operand of the next command a client
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
    'rg --pre pg_repack x docs',
    'sort --compress-program pg_repack f',
    'ack --pager pg_repack x',
    'rg --pre=pg_repack x docs',
    'sort --compress-program=pg_repack f',
    'ack --pager=pg_repack x',
    "printf '%s\\n' pg_repack | xargs -n1 env", // R7-B2: a data-only producer names the program a stdin launcher runs
    "printf 'true\\npg_repack\\n' | xargs -n1 env", // R8-B1: one producer word holding two programs (backslash-n spelling)
    "printf 'true\npg_repack\n' | xargs -n1 env", // R8-B1: the same with a real newline inside the quotes
    "printf 'true\\012pg_repack' | xargs -n1 env", // R9: octal escape as the separator
    "printf 'true\\x0apg_repack' | xargs env", // R9: hex escape as the separator
    'pgloader x.load', 'kubectl exec db -- pgloader x.load', // R7-B1: non-pg_ clients as a command word
    'gh codespace ssh -- pg_repack', 'gh cs ssh -c x -- pg_dump db', 'gh extension exec pg_repack', 'gh ext exec pg_repack', // R7-B3: gh subcommands that run a program
    'ack +pager=pg_repack needle', // R7-B4: ack's `+` option spelling
    "kubectl exec db -- '/opt/Postgres Tools/pg_repack' --version", // R7-B5: a quoted path with a space
    'rg --pre=pg_autoctl x docs', 'rg --pre pg_autoctl x docs', 'sort --compress-program=pg_foo f', // an UNLISTED pg_* name as an executable-option value, both spellings
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

// Catches (Fable sweep of PR #807, 2026-11-24): a psql family program reached through a spelling the guard did not read as a name, so a client ran against a remote database with the line allowed:
// escapes or quotes in produced text, a name assembled under xargs / parallel, a name built from a substitution, a glob, a NAME=value or env value that runs a program, and a quoted command string of a launcher the parser does not unwrap.
test('sweep bypass classes 1-3 and 6-8: decoded, assembled, globbed, valued and quoted family names are refused; the harmless neighbours pass', () => {
  dockerConfig(null);
  for (const line of [
    // 1 / 2: escapes and quotes in text a shell or xargs receives
    "printf 'pg\\x5frepack' | xargs env", "printf 'ps\\x71l -h prod' | sh", "xargs env <<< $'ps\\x71l'", "echo 'ps\"q\"l' | xargs env", "echo 'p\\sql' | xargs env",
    // 3: a name assembled from pieces under xargs / parallel
    "printf '%s%s' ps ql | xargs env", "echo ps ql | tr -d ' ' | xargs env", 'echo sql | xargs -I{} env p{} -h prod', 'parallel env {1}{2} ::: ps ::: ql',
    "printf '%s' ps ql | xargs env", "{ printf ps; echo ql -h prod; } | xargs env", '(echo -n ps; echo ql) | xargs env', 'echo sql | xargs -I@ env p@ -h prod', 'echo sql | xargs -J @ env p@ -h prod', 'echo sql | xargs --replace=@ env p@ -h prod',
    // a launcher that reads a file or a variable the line built earlier is judged against the whole line
    "printf 'ps%s' ql > f; xargs env < f", "{ printf ps; echo -n ql; } > f; xargs env < f", 'exec > f; printf ps; echo ql; xargs env < f', 'for i in 1; do printf ps; echo -n ql; done > f; xargs env < f', 'f() { printf ps; echo -n ql; }; f > g; xargs env < g', 'echo sql | xargs -I@ env p@ -h prod {a,b}', 'echo sql | xargs {-I@,-n1} env p@ -h prod', "printf '%s%s' ps ql > /tmp/x; xargs -a /tmp/x env", "v=$(printf %s%s ps ql); xargs env <<< \"$v\"", "v=$(printf '%s%s' ps ql); echo $v | xargs env",
    'x=ps; y=ql; echo $x$y | xargs env', "printf 'ps\\\\\\\\x71l' | xargs printf | xargs env",
    // 4: a command built from a substitution
    '$(echo ps)ql -h prod', 'eval ps$(echo ql) -h prod', `bash -c "$(printf 'ps\\x71l -h x')"`, "ssh host '$(echo ps)ql -h x'",
    // 6: globs in the program position
    '/usr/bin/psq? -h prod', '/usr/bin/p[s]ql -h prod', '/usr/bin/pg?repack -h prod', '/opt/pg/bin/* -h prod', 'find . -exec /usr/bin/psq? -h x \;',
    // 7: NAME=value and env values that run a program
    'alias x=pg_repack\nx -h prod', 'PAGER=pg_repack man ls', "GIT_SSH_COMMAND='pg_repack -h x' git fetch", 'make SHELL=pgloader', 'ssh -oProxyCommand=pgloader host',
    'tar --use-compress-program=pg_repack -cf x.tar .', 'rsync --rsh=pg_repack a b:', 'docker run --rm --entrypoint=pg_repack img -h x', "ssh -o 'ProxyCommand pg_repack -h x' host", 'nix run nixpkgs#pgloader -- x',
    // 8: a quoted command string of a launcher the parser does not unwrap
    "kubectl exec pod -- sh -c 'pg\"\"_repack -h x'", "gh codespace ssh 'cd x && pgloader y'", "gh codespace ssh -c name -- -t 'ps\"\"ql -h prod'",
  ]) mustRefuse(line);
  for (const line of [
    'git ls-files | xargs npx prettier --check', "printf '%s\\n' a.mjs b.mjs | xargs -n1 node --check", "printf '%s\\0' a.mjs b.mjs | xargs -0 -n1 node --check", "printf '%s\\n' b.mjs a.mjs | sort | xargs -n1 node --check",
    'echo "$FILES" | xargs npx eslint', 'git ls-files | xargs npx prettier --check; echo "exit $?"', 'rg -l foo src | xargs npx eslint && echo ok', "git diff --name-only | xargs node --check; printf 'done\\n'",
    'echo "checking v$VERSION"; git ls-files | xargs npx eslint', "printf '%s\\n' a.c b.c | xargs cc -Iinclude -fsyntax-only", 'echo checking; xargs -a files.txt -n1 node --check; echo done', "printf 'Checking batch %02d\\n' 1; xargs -n1 node --check < files.txt", "printf '%s:\\n' lint; xargs -a f -n1 node --check", "printf 'Checking batch %02d\\n' 1; parallel node --check ::: a b", 'echo checking; echo -n x; xargs -n1 node --check < f', 'echo a; echo b; xargs -n1 node --check <<< "$FILES"', 'echo a; echo b; parallel echo ::: a b', 'echo "n $X"; xargs -a f x; echo done',
    "git ls-files | sed 's/a/b/' | xargs node x.mjs", 'parallel gzip {}.log ::: a b', 'cat cmds.txt | parallel',
    "bash -c 'for f in *.md; do n=$(echo \"$f\" | cut -d. -f1); mv \"$f\" \"$n.txt\"; done'", "sh -c 'echo \"count: $(printf %s \"$x\" | wc -c)\"'", '$(which node) x.js', 'eval "$(brew shellenv)"', "git commit -m \"$(printf 'a\\nb')\"",
    'ls /usr/bin/psq?', 'node scripts/*.mjs', 'npx eslint src/*', './scripts/*.sh', 'git add src/pg*',
    'git log --grep=pg_repack', 'node x.js --file=supabase/migrations/pg_cron.sql', 'supabase db query "select * from pg_stat_activity" --local',
    "kubectl exec pod -- sh -c 'ls /tmp; cat /etc/hosts'", 'kubectl logs deploy/pgbouncer', 'echo pgloader | pbcopy',
    // system schema and catalog names as option or env values are no programs (owner 2026-11-24)
    'node x.js --schema=pg_catalog', 'supabase gen types --local --schema=pg_catalog', 'SCHEMA=pg_catalog node x.js', 'node x.js --schema=pg_toast', 'SCHEMA=pg_temp_3 node x.js', 'X=pg_stat_activity node x.js', 'node x.js --table=pg_class',
  ]) mustAllow(line);
});

// Catches (Fable sweep of PR #807, 2026-11-24): a psql family program run through a zsh-only or glued expansion in word 0 (`${:-psql}`, `$1$2`), a name built in a variable from a substitution, text given to a deferred runner
// (`crontab -`, `at`, `batch`), or sed's `e` command, so a client ran against a remote database with the line allowed.
test('sweep bypass classes 4-5 and 9-10: expansion-built command names, deferred runners and sed `e` are refused; plain reads of them pass', () => {
  dockerConfig(null);
  for (const line of [
    'x=$(echo ps)ql; $x -h prod', 'y=$a$b; $y x', // 4: a variable built from a substitution or glued expansions, then run
    '${:-psql} -h prod', 'x=PGLOADER; ${(L)x} a.load', 'a=(ps ql); ${(j::)a} -h prod', 'f() { $1$2 -h prod; }; f ps ql', // 5
    "echo '* * * * * psql -h prod' | crontab -", "at now <<< 'psql -h prod'", "batch <<< 'pg_dump -h x'", // 9
    "sed -n '1e psql -h prod' f", "sed --expression='e psql -h x' f", // 10
    "sed 's|marker|psql -h prod|e' f", "sed -e'e psql -h prod' f", "sed '\\%x%e psql -h prod' f", "sed e <<< 'psql -h prod'", "echo 'psql -h prod' | sed e", "sed -n '1s/.*/&/ep' f; echo psql", "echo 'psql --version' | sed -n '1s/.*/&/ep'", "sed '1s/x/psql -h prod/ge' f",
    "sed -l 5 'e psql -h prod' f", "sed -n -l 5 '1e psql -h prod' f", "sed --expr='e psql -h prod' f", "sed --ex 'e psql -h prod' f", "sed --line-length 5 'e psql -h prod' f",
  ]) mustRefuse(line);
  for (const line of [
    'crontab -l | grep psql', 'at -l', "sed -n '/psql/p' f", "sed 's/psql/pg/' f", "sed -e 's/psql/x/' f",
    '${HOME}/bin/tool x', '$HOME/bin/tool x', '"$npm_execpath" run x',
  ]) mustAllow(line);
});
