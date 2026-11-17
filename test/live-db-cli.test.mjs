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
  `supabase functions deploy x --no-verify-jwt --project-ref ${DEV}`,
  `supabase functions deploy x --use-api --project-ref ${DEV}`,
  `supabase functions deploy x --prune --project-ref ${DEV}`,
  `supabase db reset --no-seed --db-url ${LOCAL}`,
  `supabase db diff --use-migra --db-url ${LOCAL}`,
  'git commit -m "supabase db push"',
  'supabase db push --local',
  `supabase db dump --db-url ${LOCAL}`,
  'supabase db push --db-url=postgresql://u:p@localhost:54322/postgres',
  'supabase db push --db-url postgresql://u:p@[::1]:54322/postgres',
  'supabase gen types typescript --local',
  `curl -X POST https://api.supabase.com/v1/projects/${DEV}/database/query -d x`,
  'echo hello',
  'supabase db push --yes --dry-run',
  'supabase db push --dry-run --yes',
  'supabase db push --password x --dry-run',
  'npm install -D supabase',
  'npm i supabase@latest',
  'pnpm add -D supabase',
  'yarn add supabase',
  'bun add supabase',
  'npm ls supabase',
  'npm view supabase version',
  'pnpm why supabase',
  'command -v supabase',
  'git commit -m "refuse api.supabase.com lines"',
  `curl -X POST https://api.supabase.com/v1/projects/${DEV}/database/query?x=1`,
  // R8-B1: a mention in a command that makes no request (a search, an echo) passes
  "rg -n 'api.supabase.com' pipeline",
  'git grep api.supabase.com',
  'git log -S api.supabase.com',
  "rg -n 'api.supabase.com' pipeline > /dev/null",
  'echo api.supabase.com',
  "grep -rn 'api.supabase.com' pipeline | head",
  // R8-F1: a path or directory argument named supabase after a launcher is not the binary
  'npx vitest run lib/supabase',
  'npx eslint lib/supabase',
  'pnpm lint lib/supabase',
  'npm run lint -- lib/supabase',
  'yarn test lib/supabase',
  'timeout 120 npx vitest run lib/supabase',
  'yarn workspace web lint lib/supabase',
  // R8-F2: a help look-up reaches no database
  // R10-B1: a directory or package name that merely ends in supabase, with no subcommand after it, is no call
  'npx prettier --check supabase',
  'npx eslint lib/supabase --fix',
  'npx prettier --write supabase',
  'pnpm lint supabase --fix',
  'timeout 5 npx eslint ./supabase --fix',
  'git commit -m x && npx vitest run lib/supabase',
  // R10-F2: an install / look-up of the package behind a wrapper or a manager option names it but runs nothing
  'timeout 300 npm install supabase',
  'sudo npm i -g supabase',
  'env CI=1 npm install supabase',
  'time pnpm add -D supabase',
  'nice npm ls supabase',
  'npm --prefix web install supabase',
  'pnpm --filter web add supabase',
  'yarn workspace web add supabase',
  'npm --prefix web view supabase config',
  'which supabase',
  'brew install supabase/tap/supabase',
  'npm run supabase',
  'ls nixpkgs#supabase',
  // package selectors are not calls; the executable word is still judged
  'pnpm --filter supabase test',
  'pnpm --filter @repo/supabase test',
  'yarn workspace supabase test',
  'npm exec --package supabase -- supabase db push --help',
  'npx --package supabase supabase db reset --local',
  // a comment is not a command
  'npx prettier --check supabase # db formatting',
  'rg api.supabase.com # supabase db push',
  // prose in a quoted string or a heredoc stays one word
  "git commit -m \"$(cat <<'EOF'\nfix: say \"the owner runs supabase db push\" instead\nEOF\n)\"",
  "gh pr create --title t --body \"$(cat <<'EOF'\nOwner runs \"supabase db push\" after merge.\nEOF\n)\"",
  // read tools that make no request may name the hostname
  'ack -n api.supabase.com pipeline',
  'ag api.supabase.com',
  'git log -S api.supabase.com --oneline',
  'git grep -n api.supabase.com -- pipeline',
  'git diff --no-ext-diff api.supabase.com',
  'cd /repo && rg -n api.supabase.com pipeline',
  'rg -n api.supabase.com pipeline | sort',
  'git grep -n api.supabase.com | cut -c1-200',
  'supabase db push --help',
  'supabase db push -h',
  'supabase db --help',
  'supabase migration --help',
  'supabase functions --help',
  'supabase functions deploy --help',
];

const DENIED = [
  // R8-B1: a hostname mention is still refused when the line can make the request
  "echo x | xargs curl api.supabase.com/v1/projects",
  "rg x | sh -c 'curl https://api.supabase.com/v1/projects'",
  'echo $(curl https://api.supabase.com/v1/projects)',
  // security-scan follow-up to R8: the exemption is for a bare command word, and not for a line that writes a file
  `/tmp/x/rg https://api.supabase.com/v1/projects/${LIVE}/database/query`,
  `./rg https://api.supabase.com/v1/projects/${LIVE}/database/query`,
  `echo 'curl https://api.supabase.com/v1/projects/${LIVE}/database/query' > run.sh`,
  `echo 'curl https://api.supabase.com/v1/projects/${LIVE}/database/query' >> run.sh`,
  `echo 'curl https://api.supabase.com/v1/projects/${LIVE}/database/query' | tee x.sh`,
  // security-scan follow-up to R8: package-manager workspace verbs before the command word
  'yarn workspace web supabase db push',
  'yarn workspaces foreach run supabase db push',
  'yarn workspaces foreach -A exec supabase db push',
  'pnpm recursive exec supabase db push',
  'pnpm -r exec supabase db push',
  // R8-F1: a launcher that really runs the binary stays refused
  'npx --yes supabase db push',
  'sudo -u root supabase db push',
  'timeout 120 supabase db push',
  'pnpm -C app supabase db push',
  'pnpm run supabase db push',
  'npm run supabase -- db push',
  'env FOO=1 supabase db push',
  'xargs -I{} supabase db push {}',
  // R8-F2: --help in a value slot or after -- is not a help flag
  'supabase db push --password --help',
  'supabase db push -- --help',
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
  'supabase db reset --remote --yes',
  'supabase migration up --remote',
  'supabase db push --remote=true --dry-run',
  'supabase db push --yes -- --dry-run',
  'supabase db push -p --dry-run',
  'supabase db push --password --dry-run',
  'supabase db push --foo --dry-run',
  'supabase db push -- --local',
  `supabase db push -- --db-url ${LOCAL}`,
  'supabase db push -- --db-url postgres://localhost/postgres',
  'supabase db push --password --db-url postgres://localhost/postgres',
  `supabase functions deploy x -- --project-ref ${DEV}`,
  `supabase functions deploy x --password --project-ref ${DEV}`,
  'supabase db push --linked -- --local',
  `curl -X POST https://api.supabase.com/v1/projects/${DEV}/../${LIVE}/database/query`,
  `curl -X POST https://api.supabase.com/v1/projects/${DEV}/%2e%2e/${LIVE}/database/query`,
  `curl -X POST https://api.supabase.com/v1/projects/${DEV}/%2E%2E/${LIVE}/database/query`,
  `curl -X POST https://api.supabase.com/v1/projects/${DEV}/.%2e/${LIVE}/database/query`,
  `curl -X POST https://api.supabase.com/v1/projects/${DEV}/..%2f${LIVE}/database/query`,
  `curl -X POST https://api.supabase.com/v1/projects/${DEV}/x%2F..%2F${LIVE}/database/query`,
  `curl -X POST 'https://api.supabase.com/v1/projects/${DEV}/..\\${LIVE}/database/query'`,
  `curl -X POST https://api.supabase.com/v1/projects/${DEV}/database/${LIVE}/query`,
  `git commit -m "$(curl -X POST https://api.supabase.com/v1/projects/${LIVE}/database/query)"`,
  `gh pr create --body "\`curl https://api.supabase.com/v1/projects\`"`,
  'git commit -m "x" && U=https://api.supabase.com/v1/projects/x/database/query; curl "$U"',
  // R9-F1: a wrapper after a launcher runs the rest, so a bare supabase word anywhere after a launcher is refused (a path argument like lib/supabase is not)
  'npx dotenv -- supabase db push',
  'npx dotenv -e .env.production -- supabase db push',
  'npx dotenv-cli -e .env.prod -- supabase migration repair --status reverted 2026',
  'npx cross-env SUPABASE_DB_PASSWORD=x supabase db push',
  'npx env-cmd -f .env.prod supabase db push',
  'pnpm exec dotenv -- supabase db push',
  'yarn dlx dotenv-cli -- supabase db push',
  'timeout 120 npx dotenv -- supabase db push',
  'pnpm --filter workspace supabase db push',
  'timeout 5 npx dotenv -- ./node_modules/.bin/supabase db push',
  'timeout 5 npx dotenv -- /usr/local/bin/supabase --workdir . db push',
  'timeout 5 npx dotenv -- tools/supabase db push',
  // R9-B1 / R9-F2: a search or git read that runs a program, or runs under an env assignment, is not a no-request line
  `GIT_EXTERNAL_DIFF='curl -X DELETE https://api.supabase.com/v1/projects/${LIVE} #' git diff`,
  `git grep --open-files-in-pager='curl -X POST https://api.supabase.com/v1/projects/${LIVE}/database/query #' pattern`,
  `git grep -O'curl https://api.supabase.com/v1/projects/${LIVE}/database/query #' pattern`,
  `ack --pager='curl https://api.supabase.com/v1/projects/${LIVE}/database/query' x`,
  `ag --pager 'curl https://api.supabase.com/v1/projects/${LIVE}/database/query' x`,
  `rg --pre ./x.sh https://api.supabase.com/v1/projects/${LIVE}/database/query`,
  `rg --pre=./x.sh https://api.supabase.com/v1/projects/${LIVE}/database/query`,
  'rg --hostname-bin=./x api.supabase.com',
  'rg --hostname-bin ./x api.supabase.com',
  `git log --output=run.sh --format='curl https://api.supabase.com/v1/projects/${LIVE}/database/query'`,
  `git log --ext-diff -p api.supabase.com`,
  `git diff --textconv api.supabase.com`,
  `git log --output-directory=d api.supabase.com`,
  `git log -o d api.supabase.com`,
  'PAGER=./x git log api.supabase.com',
  // security-scan follow-up to the R9 fix: env-loader wrappers called directly, path words followed by flags, option abbreviations
  'dotenv -- supabase db push',
  'dotenv -e .env.prod -- supabase db push',
  'dotenv-cli -- supabase db push',
  'cross-env FOO=1 supabase db push',
  'env-cmd -f .env.prod supabase db push',
  'with-env supabase db push',
  'timeout 60 dotenv -- supabase db push',
  'timeout 60 cross-env FOO=1 supabase db push',
  'doas supabase db push',
  'caffeinate supabase db push',
  'npx dotenv -- ./node_modules/supabase/bin/supabase --workdir . db push',
  'npx dotenv -- ./node_modules/supabase/bin/supabase --debug db push',
  'npx dotenv -- vendor/supabase --debug db push',
  'npx dotenv -- vendor/supabase --workdir . db push',
  `ack --pag='curl https://api.supabase.com/v1/projects/${LIVE}/database/query' x`,
  `ack --pa='curl https://api.supabase.com/v1/projects/${LIVE}/database/query' x`,
  `ag --page 'curl https://api.supabase.com/v1/projects/${LIVE}/database/query' x`,
  `ag --pa 'curl https://api.supabase.com/v1/projects/${LIVE}/database/query' x`,
  // #602: a secret-manager or environment runner that starts the binary
  'doppler run -- supabase db push',
  'op run -- supabase db push',
  'infisical run -- supabase db push',
  'direnv exec . supabase db push',
  'mise exec -- supabase db push',
  'aws-vault exec p -- supabase db push',
  'dotenvx run -- supabase db push',
  'dotenvx run -f .env.production -- supabase db push',
  'doppler run --project p -- npx supabase db push',
  'op run --env-file=.env -- supabase migration repair --status reverted 2026',
  'chamber exec prod -- supabase db push',
  'sops exec-env f -- supabase db push',
  'dotenvx run -- supabase bootstrap',
  'doppler run -- ./node_modules/.bin/supabase --workdir . db push',
  'mise exec -- vendor/supabase --debug db push',
  // R10-F1: xargs / parallel build the command from stdin
  "printf 'db push\\n' | xargs supabase",
  "echo 'migration repair --status reverted 2026' | xargs npx supabase",
  "printf 'db push\\n' | xargs -n1 supabase",
  'echo x | xargs /usr/local/bin/supabase',
  'xargs -a args.txt ./node_modules/.bin/supabase',
  'printf x | parallel supabase',
  "parallel supabase ::: 'db push'",
  'echo x | env xargs supabase',
  'cat a | xargs dotenv -- supabase',
  'echo x | xargs supabase db push --help',
  "echo 'supabase db push' | xargs npx",
  "echo 'supabase db push' | xargs env",
  "echo 'supabase db push' | xargs -n3 doppler run --",
  "echo 'supabase db push' | parallel",
  `echo "-O'curl -X DELETE https://api.supabase.com/v1/projects/${LIVE} #' pattern" | xargs git grep`,
  "echo '--pre=./x' | xargs rg api.supabase.com",
  'echo x | xargs ack api.supabase.com',
  'echo x | parallel git grep api.supabase.com',
  // git global options and ack / ag option spellings that run a program
  `git -c core.pager='curl https://api.supabase.com/v1/projects/${LIVE}' grep -O x`,
  'git --no-pager log api.supabase.com',
  `ack +pager='curl https://api.supabase.com/v1/projects/${LIVE}' x`,
  `ack -pager='curl https://api.supabase.com/v1/projects/${LIVE}' x`,
  `ag +pa 'curl https://api.supabase.com/v1/projects/${LIVE}' x`,
  `ag --pager='curl https://api.supabase.com/v1/projects/${LIVE}' x`,
  `ACK_PAGER='curl https://api.supabase.com/v1/projects/${LIVE}' ack x`,
  // plan review: an option the guard does not know before the verb, a package selector is not the executable, a quoted # is no comment
  'npm --loglevel info exec -- supabase db push',
  'npx --package supabase supabase db push',
  'npx doppler run -- time -p supabase db push',
  'echo "a # b" && supabase db push',
  'npx dotenv -- supabase migrations repair --status reverted 20261117',
  'doppler run -- supabase migrations repair --status reverted 20261117',
  'npx dotenv -- supabase $SUB',
  'npx dotenv -- supabase "$@"',
  'nix run nixpkgs#supabase-cli -- db push',
  'deno run -A npm:supabase db push',
  'gtime -p supabase db push',
  'pnpm -w supabase db push',
  'npx dotenv -- supabase whoami',
  'rg -n api.supabase.com | sort -o /tmp/x',
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

test('a target flag after `--` or in an option value slot is refused with its own reason', () => {
  for (const line of [`supabase db push -- --db-url ${LOCAL}`, `supabase functions deploy x --password --project-ref ${DEV}`]) {
    const v = verdict(line);
    assert.equal(v.decision, 'deny', line);
    assert.match(v.reason, /follows `--` or an option that may take it as its value; put the target flag first/);
  }
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
