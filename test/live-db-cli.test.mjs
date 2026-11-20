// #262 (live-database guard, Task 5 / B1a): agent-run supabase CLI lines and Management API calls that can reach a non-local database. The psql family ships in B1b.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run as runDbRefs } from '../pipeline/commands/db-refs.mjs';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';
import { findLiveDbCli, localDbUrl } from '../pipeline/hooks/lib/live-db-guard.mjs';

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
  // R11-B1 / R11-F1: a supabase directory, package or search word under a command that does not start a program is no call, whatever follows it
  'rg supabase db',
  "rg supabase -g '*.ts'",
  "rg -n supabase --glob '!*.lock'",
  "git grep -n supabase -- '*.mjs'",
  "find . -type d -name supabase -not -path '*/node_modules/*'",
  'git add supabase "$f"',
  'git diff main -- supabase test',
  "git log -p -- supabase ':(exclude)*.snap'",
  'cp -r supabase backups',
  "npx prettier --check supabase 'src/**/*.ts'",
  "pip install supabase 'httpx[http2]'",
  'npm --prefix supabase test',
  'pnpm -C supabase test',
  'make -C supabase test',
  'git -C supabase pull',
  'npm -w supabase test',
  "gh pr create --title \"Move client into lib/supabase\" --body \"$(cat <<'EOF'\nMoves the client; the owner runs it.\nEOF\n)\"",
  // R11-B2 / R11-F2: xargs / parallel count only when they are the command that runs, and it can become the binary or a launcher of it
  'rg --files supabase | xargs wc -l',
  "find supabase/migrations -name '*.sql' | xargs grep -l x",
  "rg -l supabase | xargs sed -i 's/a/b/'",
  'rg -n parallel supabase/functions',
  'git grep -n xargs -- supabase',
  'cd supabase && which parallel',
  'rg -n xargs docs | rg api.supabase.com',
  // Part B: each row is an everyday command the guard would refuse wrongly (a false refusal makes an agent stop and hand the owner a line that was never dangerous)
  // B6/B7: xargs / parallel are refused only when a real supabase TOKEN is on the line, not a path or package name that holds the word
  'grep -l x supabase/migrations/*.sql | xargs -n1 basename',
  'git ls-tree -r origin/main --name-only supabase/migrations | xargs -n1 basename',
  "ls supabase/migrations | xargs -I{} sh -c 'grep -l x supabase/migrations/{}'",
  'rg -l "@supabase/supabase-js" src | xargs npx prettier --write',
  // B4: global flags before the subcommand
  'supabase --workdir /x db reset',
  'supabase --debug --workdir /x migration list --local',
  'supabase --debug db push --local',
  // B5: db query (CLI 2.x and 3.x), a real --read-only passes whatever the target (owner 2026-11-20), --remote forms
  'supabase db query --linked --read-only "select 1"',
  'supabase db query --remote --read-only -f q.sql',
  'supabase db query --local "select 1"',
  'supabase db query --db-url "$DATABASE_URL" --read-only "select 1"',
  'supabase db query --linked -f q.sql --read-only',
  `supabase db push --remote=${DEV}`,
  'supabase db push --remote=postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  'supabase db advisors --local',
  'supabase test new foo',
  // B6: a local URI with sslmode only
  './node_modules/.bin/supabase gen types typescript --db-url "postgresql://postgres:postgres@127.0.0.1:56182/postgres?sslmode=disable"',
  // B1 (Rev 2): the wrapper words the parser strips are not the data command's operands
  'env rg supabase db',
  'timeout 30 git diff -- supabase db',
  'sudo -u x rg -n supabase db',
  // B2: sed stays plain data unless the line holds a supabase token + a head
  "sed -i '' 's/supabase db push/supabase db reset/' README.md",
  // B9 (F3): a variable-held PATH to a program is not a supabase call
  '$GIT status',
  '"$HOME/.cargo/bin/cargo" test',
  '$HOME/.bun/bin/bun test',
  // B8 (F5): a glob that names no head
  "npx eslint 'src/**/*.ts' supabase",
  "npx eslint supabase 'src/**/*.ts'",
  "uv pip install supabase 'httpx[http2]'",
  // B10 (F1/F4): a quoted argument with parentheses, commas or prose is not a command
  'node -e "console.log(foo(a, b))"',
  'python3 -c "print(max(1, 2))"',
  "jq 'map(select(.a == 1))' x.json",
  'claude -p "call foo(a, b) twice"',
  'node ~/.claude/pipeline/bin/pipeline.mjs summary --pr 1 --built "Added helper parse(a, b) and tests"',
  'node ~/.claude/pipeline/bin/pipeline.mjs summary --pr 1 --built "Owner runs supabase db push after merge"',
  // B1 (F2): find's own prefix is data
  'find supabase -type d -name functions -exec ls {} \\;',
  "find supabase -name '*.sql' -exec grep -l storage {} +",
  // B9/B10: a substitution word is its own command (judged once), a variable head with no subcommand or a non-subcommand word after `db` is no supabase call
  "eval \"$(supabase status -o env | grep -E '^(API_URL|SERVICE_ROLE_KEY)=')\"",
  '$NPM test',
  "Q=sqlite3; $Q db '.shell x'",
  // B10 (owner 2026-11-20): the program text of node -e / python -c is code, not a shell line; an agent editing a note with a program that mentions a supabase command would be refused
  "node -e 'const fs=require(\"fs\"); let t=fs.readFileSync(\"n.md\",\"utf8\"); t=t.replace(\"x\", \"owner runs supabase db push after merge\"); fs.writeFileSync(\"n.md\", t)'",
  'node --eval="console.log(\'run supabase db reset; then supabase start\')"',
  "node -p 'JSON.stringify({ step: \"supabase test db\" })'",
  'python3 -c "print(\'owner step: supabase db push --linked\')"',
  // B3: git is data only for a known subcommand
  'git status supabase db',
  'git -C supabase log --oneline',
  // R1-B2: a repository search with git's -C / --no-pager before the subcommand makes no request (same as `cd /repo && git grep …`)
  'git -C /repo grep -n api.supabase.com -- .',
  'git --no-pager log -S api.supabase.com --oneline',
  'git --no-pager log api.supabase.com',
  // R1-F2: the builtins that run nothing keep a search on the no-request list (`|| true` after a grep is the common idiom)
  'rg -n api.supabase.com pipeline || true',
  'grep -c api.supabase.com f || :',
  '[ -f x ] && grep -q api.supabase.com x',
  'test -f x && rg -n api.supabase.com x',
  // R1-F1: the pipeline CLI as the program that runs takes prose (bare bin, or node and its script)
  'pipeline summary --pr 1 --built "Owner runs supabase db push after merge"',
  // R3-F3: prose that starts with the word Supabase and has a subcommand name (test, status, logs, start) later is not a call: a token followed only by blanks and a plain word is prose (the gate reads the raw text)
  'claude -p "Supabase must be running before the test"',
  'cnotify "supabase stack failed to start"',
  "osascript -e 'display notification \"Supabase is ready for the test\"'",
  "sh -c 'claude -p \"Supabase must be running before the test\"'",
  'claude -p "Notes for the owner\nSupabase output is noisy in the logs"',
  // R4-F3: a wrapped search inside a quoted command string is a search (the typed reading judges word 0 only; the data-command test stays on the parsed words)
  "sh -c 'sudo rg -n \"supabase db push\" docs'",
  "bash -c 'timeout 10 grep -rn \"supabase db push\" docs'",
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
  // R1-B2: -c, --exec-path and --config-env run programs or move the config, so they stay refused (only -C and --no-pager are skipped)
  `git -C /repo -c core.pager='curl https://api.supabase.com/v1/projects/${LIVE}' grep -O x`,
  'git --exec-path=/tmp/x log api.supabase.com',
  'git --config-env=core.pager=X log api.supabase.com',
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
  // Part B: each row is a way an agent could run a live-database command past the guard (or a refusal the plan documents as accepted)
  // B2: sed runs programs (its e command), so xargs sed fed a supabase line is a program builder
  "printf -- '-e\\ne supabase db push\\n' | xargs sed -n x",
  "echo 'supabase.exe db push' | xargs env",
  // B3: git runs a command through bisect run / rebase -x
  'git bisect run supabase db push',
  'git rebase -x "supabase db push" main',
  // B10: a runner that takes the command as one quoted string
  'doppler run --command "supabase db push"',
  'doppler run --command="supabase db push"',
  'infisical run --command "supabase db push"',
  "nix-shell --run 'supabase db push'",
  'doppler run --command "pnpm supabase db push"',
  "ssh ci 'cd app && yarn supabase db push'",
  `doppler run --command "${'true; '.repeat(501)}supabase db push"`,
  // R1-B1: a global flag between the token and the head of a quoted command string (both reparse sites: the outer word and a nested one)
  'doppler run --command "supabase --workdir /app db push"',
  'doppler run --command "supabase --debug db push"',
  'doppler run --command="supabase --workdir=/app db push"',
  'git rebase -x "supabase --debug db push" main',
  'git rebase -x "supabase --workdir . db push" main',
  'doppler run --command "supabase -o json --debug db push"',
  "nix-shell --run 'supabase --workdir \"/my app\" db push'",
  "sh -c 'doppler run --command \"supabase --workdir /app db push\"'",
  // R2-B1 / R2-F1: the gate reads any run of words between the token and the head (flag spellings, an escaped space, a quoted head), the reparse judges
  'doppler run --command "supabase --yes=true db push --linked"',
  'doppler run --command "supabase --linked=true db push"',
  'doppler run --command "supabase --db-url=postgres://u@db.x.supabase.co/postgres db push"',
  'doppler run --command "supabase -ojson db push"',
  "doppler run --command 'supabase --workdir /my\\ app db push'",
  'ssh ci "supabase \'db\' push"',
  "doppler run --command 'supabase \"db\" push'",
  'doppler run --command "supabase --create-ticket db push"',
  // R1-F1: a container, namespace, session or project NAMED pipeline is not the pipeline CLI
  'docker exec pipeline sh -c "supabase db push"',
  'kubectl exec deploy/pipeline -- sh -c "supabase db push"',
  "tmux send-keys -t pipeline 'supabase db push' Enter",
  'doppler run --project pipeline --command "supabase db push"',
  'node ./pipeline/run.mjs --built "x" && sh -c "supabase db push"',
  // E7 (accepted false refusals): prose with a separator or a substitution followed by a supabase command
  'claude -p "Check migrations; supabase db push is forbidden"',
  "claude -p 'Owner step: run `supabase db push --linked` after merge'",
  "claude -p 'run (supabase db push) later'",
  // B10: a shell's -c is a real call and stays read (only node / python program text is skipped)
  "sh -c 'cd x && supabase db push'",
  'zsh -c "supabase db push --linked"',
  'bash -c "supabase db push"',
  // B8: a glob in the head slot can be any subcommand
  'npx dotenv -- supabase d? push',
  "npx prettier --check supabase '*'",
  // B9: the binary run through a variable
  '$SB db push',
  '"$(command -v supabase)" db push',
  '$SB --workdir /x db push',
  // B4: a global flag does not make the line safe
  'supabase --workdir /x db push',
  'supabase --debug db push',
  // B5: db query (a real --read-only is the only pass without a local proof) and --remote
  'supabase db query "delete from t"',
  'supabase db query --linked "select 1"',
  'supabase db query --linked --read-only=false "x"',
  'supabase db query --linked -- --read-only',
  'supabase db query --linked --read-only --read-only "x"',
  'supabase db query --linked --file --read-only "x"',
  `supabase db query --linked --read-only --db-url ${LOCAL} "x"`,
  'supabase db query --linked --read-only --remote "x"',
  'supabase db query --db-url "$A" --db-url "$B" --read-only "x"',
  'supabase db push --linked --read-only',
  'supabase db reset --linked --read-only',
  'supabase db push --remote',
  'supabase db push --remote=${LIVE}',
  `supabase db push --remote=${LIVE}`,
  `supabase db reset --remote=${LIVE}`,
  `supabase db push --remote=${DEV} --linked`,
  'supabase migration up --remote=postgresql://u@db.x.supabase.co/postgres',
  'supabase db advisors --linked',
  'supabase logs --linked',
  // B6: a libpq parameter other than sslmode can move the host
  'supabase db push --db-url "postgresql://u@127.0.0.1:5432/p?host=db.x.supabase.co"',
  'supabase db push --db-url "postgresql://u@127.0.0.1:5432/p?sslmode=disable&host=x"',
  'supabase db push --db-url "postgresql://u@127.0.0.1:5432/p?sslmode=disable&sslmode=require"',
  // R3-F1: a word after the token that can become a subcommand (an expansion, a glob, a brace group) inside a quoted command string
  "doppler run --command 'supabase $SUB'",
  "doppler run --command 'SUB=db; supabase $SUB push'",
  "nix-shell --run 'supabase {db,push}'",
  "doppler run --command 'supabase d? push'",
  'doppler run --command "supabase \\"\\$@\\""',
  // R3-F2: a redirect between the token and the head is not a command end; nor is a separator inside a substitution
  "doppler run --command 'supabase 2>&1 db push'",
  "doppler run --command 'supabase &>/dev/null db push'",
  "doppler run --command 'supabase > out.log db push'",
  "doppler run --command 'supabase --workdir $(git rev-parse --show-toplevel || pwd) db push'",
  "nix-shell --run 'supabase --workdir `pwd | cat` db push'",
  // the escaped space of a value, one quote level down, stays one value
  'sh -c \'doppler run --command "supabase --workdir /my\\ app db push"\'',
  // R3 hardening: the token as the inner shell reads it (a quote pair or a backslash inside the word) is still a token
  "doppler run --command 'supa\\base db push'",
  'sh -c "su\'\'pabase db push"',
  'doppler run --command "su\'\'pabase db push"',
  // R4-B1 / R4-F2: a backslash-newline is deleted by the shell, inside a word, inside double quotes, and inside the token itself
  "doppler run --command 'supabase --workdir /t\\\nmp db push'",
  "doppler run --command 'supabase \"d\\\nb\" push'",
  "doppler run --command 'supa\\\nbase db push'",
  // R4-F1: a here-string or a `<<-` heredoc between the token and the head
  "doppler run --command 'supabase <<< y db push'",
  'supabase <<- EOF db push\nEOF',
  // security scan: the other redirect and process-substitution shapes
  "doppler run --command 'supabase <>f db push'",
  "doppler run --command 'supabase 2>>&1 db push'",
  "doppler run --command 'supabase <(true) db push'",
  "doppler run --command 'supabase >(cat) db push'",
  // the prose rule cannot hide a call: a tab then a flag is no prose word, and a second token is judged on its own
  "doppler run --command 'supabase\t--workdir x db push'",
  'doppler run --command "Supabase is ready; supabase db push"',
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

// R2 backtracking: a long run of flags between the token and its words must not hang the guard past the hook timeout (the old flag regex took 8 s at 28 pairs and hit the deadline)
test('a long flag run in a quoted command string is decided fast, not by the deadline', () => {
  const line = `doppler run --command "supabase ${"-o 'a' ".repeat(40)}zzz"`;
  const t0 = Date.now();
  const v = verdict(line);
  const ms = Date.now() - t0;
  assert.equal(v.decision, 'allow', v.reason);
  assert.doesNotMatch(v.reason ?? '', /took too long/);
  assert.ok(ms < 2000, `took ${ms} ms`);
});

// R5-F1: a word of many stars (each became \`.*\`) backtracked past the 15 s hook limit on a literal no head contains, and a hook past the limit is ALLOWED, so the db push after it ran
test('a word of many stars after a supabase token is refused fast, not by the hook deadline', () => {
  for (const line of [
    `doppler run --command 'supabase ${'*'.repeat(60)}z; supabase db push'`,
    `x supabase '${'*'.repeat(60)}z'; supabase db push`,
  ]) {
    const t0 = Date.now();
    const v = verdict(line);
    const ms = Date.now() - t0;
    assert.equal(v.decision, 'deny', line.slice(0, 60));
    assert.doesNotMatch(v.reason ?? '', /took too long/);
    assert.ok(ms < 2000, `took ${ms} ms`);
  }
});

// R5-F2: the prose rule's lookahead made the greedy @-tail of the token backtrack at every start of \`;supabase@;supabase@...\` (about 7 s at 190 kB, 19 s with the call inside the same quoted string)
test('a 190 kB word of repeated supabase@ tokens is decided fast, not by the hook deadline', () => {
  const word = ';supabase@'.repeat(19000);
  for (const line of [
    `doppler run --command '${word}' 'supabase db push'`,
    `doppler run --command 'supabase db push ${word}'`,
  ]) {
    const t0 = Date.now();
    const v = verdict(line);
    const ms = Date.now() - t0;
    assert.equal(v.decision, 'deny');
    assert.doesNotMatch(v.reason ?? '', /took too long/);
    assert.ok(ms < 2000, `took ${ms} ms`);
  }
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

// B6: an agent could point a "local" URI at a remote host through a libpq parameter; sslmode alone is safe
test('localDbUrl accepts a query made only of one sslmode and nothing else', () => {
  const base = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
  assert.equal(localDbUrl(base), true);
  assert.equal(localDbUrl(`${base}?sslmode=disable`), true);
  assert.equal(localDbUrl(`${base}?sslmode=verify-full`), true);
  for (const bad of ['?host=db.x.supabase.co', '?sslmode=disable&host=x', '?sslmode=disable&sslmode=require', '?hostaddr=1.2.3.4', '?service=x', '?options=-c', '?sslmode=', '?sslmode=dis%61ble', '?SSLMODE=disable&host=x', '?']) {
    assert.equal(localDbUrl(`${base}${bad}`), false, bad);
  }
  assert.equal(localDbUrl('postgresql://u@db.x.supabase.co/postgres?sslmode=disable'), false);
});

// B1: the parsed argv judged as data must not silence a typed reading whose own words are not the argv's (an agent could hide a launcher in words the parser rewrote)
test('a typed reading that does not end with the parsed argv is judged as non-data', () => {
  const state = { ok: true, refs: [] };
  const cmd = (argv, typed) => { const c = { argv, raw: typed.join(' '), env: {}, redirects: [] }; Object.defineProperty(c, 'typed', { value: typed, enumerable: false }); return c; };
  // the parser reads `rg supabase db push` (data), the words typed were something that rewrote into it
  assert.match(String(findLiveDbCli([cmd(['rg', 'supabase', 'db', 'push'], ['runit', '--as', 'rg', 'x', 'supabase', 'db', 'push'])], '', state)), /live database/);
  // a plain stripped wrapper prefix (`env`) is not a reason to refuse an operand of the data command
  assert.equal(findLiveDbCli([cmd(['rg', 'supabase', 'db'], ['env', 'rg', 'supabase', 'db'])], '', state), null);
  // a stripped prefix that itself carries a call is refused
  assert.match(String(findLiveDbCli([cmd(['rg', 'x'], ['supabase', 'db', 'push', 'rg', 'x'])], '', state)), /live database/);
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
