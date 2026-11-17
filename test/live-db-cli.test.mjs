// #262 (live-database guard, Task 5 / B1a): agent-run supabase CLI lines and Management API calls that can reach a non-local database. The psql family ships in B1b.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run as runDbRefs } from '../pipeline/commands/db-refs.mjs';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';

const DEV = 'zyxwvutsrq9876543210';
const LIVE = 'abcdefghij0123456789';
const home = mkdtempSync(join(tmpdir(), 'cp-live-db-cli-'));
after(() => rmSync(home, { recursive: true, force: true }));
const own = { home, env: {}, hasClaudeCodeAncestor: () => false };
await runDbRefs(['set', '--ref', DEV, '--name', 'Scratch', '--repo', 'acme/widgets', '--dev'], own);
await runDbRefs(['set', '--ref', LIVE, '--name', 'Prod', '--repo', 'acme/widgets'], own);

const OPTS = { home, env: {}, platform: 'linux', realpath: (p) => p, existsSync: () => false, cwd: '/repo' };
const verdict = (line, opts = {}) => evaluateBashForFiles(line, { ...OPTS, ...opts });
const LOCAL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

const ALLOWED = [
  'supabase db push --dry-run',
  'supabase migration list',
  'supabase db diff',
  'supabase db reset',
  'supabase migration up',
  'supabase start',
  'supabase status',
  'supabase test db',
  'npx supabase@1 db reset --local',
  'npx supabase db reset',
  'pnpm dlx supabase db reset',
  'bunx supabase db diff',
  `supabase functions deploy x --project-ref ${DEV}`,
  `supabase functions deploy x --project-ref=${DEV}`,
  'git commit -m "supabase db push"',
  'supabase db push --local',
  `supabase db dump --db-url ${LOCAL}`,
  'supabase db push --db-url=postgresql://u:p@localhost:54322/postgres',
  'supabase db push --db-url postgresql://u:p@[::1]:54322/postgres',
  'supabase gen types typescript --local',
  `curl -X POST https://api.supabase.com/v1/projects/${DEV}/database/query -d x`,
  'echo hello',
];

const DENIED = [
  'supabase db reset --db-url postgresql://x@db.abc.supabase.co/postgres',
  'supabase migration up --db-url postgresql://x@db.abc.supabase.co/postgres',
  'supabase db push --db-url a --db-url b',
  `supabase db push --db-url ${LOCAL} --db-url=${LOCAL}`,
  'supabase db reset --local --linked',
  'supabase db reset --local --db-url postgresql://x@127.0.0.1/p',
  `supabase db push --local --project-ref ${DEV}`,
  'supabase frobnicate',
  'supabase db frobnicate',
  'supabase --debug db push --local',
  `supabase functions deploy x --project-ref ${LIVE}`,
  'supabase functions deploy x --project-ref abcdefghij9999999999',
  `supabase functions deploy x --project-ref ${DEV} --project-ref ${DEV}`,
  `curl -X POST https://api.supabase.com/v1/projects/${LIVE}/database/query`,
  'curl https://api.supabase.com/v1/projects',
  `curl https://api.supabase.com/v1/projects/${DEV}/x https://api.supabase.com/v1/projects/${LIVE}/x`,
  'pnpm supabase db push',
  'yarn supabase db push',
  'supabase db push --dry-run=false',
  'supabase db push --dry-run=x',
  'U=https://api.supabase.com/v1/projects/x/database/query; curl "$U"',
  'supabase db push --db-url "$URL"',
  'supabase db push --db-url `cat u`',
  'supabase db push --db-url $(cat u)',
  'supabase db push --db-url postgresql://u:p@127.0.0.1:54322/post*',
  'supabase db push --db-url postgresql://u@evil.com@127.0.0.1:54322/postgres',
  'supabase db push --db-url postgresql://u:p@db.x.supabase.co:5432/postgres',
  'supabase db push --db-url postgresql://u:p@127.0.0.2:54322/postgres',
  `supabase db dump --db-url ${LOCAL}?host=db.x.supabase.co`,
  'supabase db push',
  'supabase db push --linked',
  'supabase db reset --linked',
  `supabase db diff --linked --db-url ${LOCAL}`,
  'supabase functions deploy x',
  'supabase secrets set A=b',
  'supabase gen types typescript --linked',
];

for (const line of ALLOWED) test(`allowed: ${line}`, () => {
  const v = verdict(line);
  assert.equal(v.decision, 'allow', v.reason);
});

for (const line of DENIED) test(`denied: ${line}`, () => {
  const v = verdict(line);
  assert.equal(v.decision, 'deny', `${line} was allowed`);
  assert.match(v.reason, /live database/);
  assert.match(v.reason, /owner runs this/);
});

test('an unknown subcommand names itself', () => {
  assert.match(verdict('supabase frobnicate').reason, /not a subcommand the guard knows/);
});

test('the admin switch bypasses the rule', () => {
  assert.equal(verdict('supabase db push', { env: { [['PIPELINE', 'ADMIN'].join('_')]: '1' } }).decision, 'allow');
});

test('without a registry file no project ref counts as dev', () => {
  const empty = mkdtempSync(join(tmpdir(), 'cp-live-db-cli-empty-'));
  try {
    assert.equal(verdict(`supabase functions deploy x --project-ref ${DEV}`, { home: empty }).decision, 'deny');
    assert.equal(verdict('supabase db reset', { home: empty }).decision, 'allow');
  } finally { rmSync(empty, { recursive: true, force: true }); }
});

test('an unreadable registry still lets local-only lines run and refuses remote ones', () => {
  const bad = mkdtempSync(join(tmpdir(), 'cp-live-db-cli-bad-'));
  try {
    mkdirSync(join(bad, '.claude', 'pipeline-state'), { recursive: true });
    writeFileSync(join(bad, '.claude', 'pipeline-state', 'db-refs.json'), '{not json');
    const o = { home: bad };
    assert.equal(verdict('supabase db reset', o).decision, 'allow');
    assert.equal(verdict('supabase db push', o).decision, 'deny');
  } finally { rmSync(bad, { recursive: true, force: true }); }
});
