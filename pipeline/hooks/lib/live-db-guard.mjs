// #262 (live-database guard): what the PreToolUse guard decides for a Supabase MCP call (files-policy.mjs evaluateMcp calls evaluateSupabaseMcp, LAST: after every other rule that could deny the same
// call, so no later deny burns a go). Every hosted project is LIVE unless the owner declared it `dev` (db-refs.mjs). On a live project the read tools pass; execute_sql passes only as a fixed
// catalog template (live-db-catalog.mjs); every other execute_sql and every apply_migration passes only with an owner go bound to the sha256 of the call's exact `query` (and the project, and for a
// migration the name), consumed AT THE ATTEMPT with an exclusive-create marker (a failed or interrupted apply needs a new go, and the live state must be checked read-only first).
//
// A tripwire, not a boundary: the boundary is the agent not holding prod credentials.
import { createHash } from 'node:crypto';
import { closeSync, constants, fsyncSync, openSync, writeSync } from 'node:fs';
import path from 'node:path';
import { FUTURE_SKEW_MS, promptEntryOf, promptTextOf, realDirChain, replyBefore, replyBeforeToolUse } from './owner-go.mjs';
import { clickProvenance, readAsk, settlePendingClicks } from './owner-go-click.mjs';
import { isDevRef, readDbRefs, targetOf } from './db-refs.mjs';
import { commandName } from './shell-parse.mjs';
import { matchCatalogQuery } from './live-db-catalog.mjs';
import { LIVE_DB_MAX_AGE_MS, liveDbRecords, parseGo, sha256Of, verifyBlock } from './live-db-go.mjs';

export const LIVE_DB_CONSUMED_REL = '.claude/pipeline-state/owner-go/live-db-consumed';
const PREFIX = '[claude-pipeline guard-files] live database:';
const OPEN_EXCL = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
const CLI = 'node ~/.claude/pipeline/bin/pipeline.mjs';

export const SUPABASE_WRITE_NAMES = ['apply_migration', 'execute_sql', 'run_notebook', 'deploy_edge_function', 'create_edge_function_secret', 'create_branch', 'delete_branch', 'merge_branch', 'reset_branch', 'rebase_branch', 'create_project', 'pause_project', 'restore_project', 'create_notebook', 'delete_notebook'];
export const SUPABASE_READ_NAMES = ['list_tables', 'list_extensions', 'list_migrations', 'list_edge_functions', 'list_branches', 'list_projects', 'list_organizations', 'list_notebooks', 'get_project', 'get_organization', 'get_project_url', 'get_publishable_keys', 'get_advisors', 'get_edge_function', 'get_notebook', 'get_logs', 'query_logs', 'search_docs', 'generate_typescript_types'];

const parts = (tool) => String(tool).split('__');
export const lastSegment = (tool) => parts(tool).pop();
export const serverSegment = (tool) => parts(tool)[1] ?? '';
// the write names only a Supabase server has: any server's tool with one of them is judged (a renamed server in an unprotected .mcp.json: Fable F2). The generic names (create_branch, create_project, run_notebook …) are judged only on a server whose name has `supabase` in it, so another vendor's tool of that name is untouched.
const SUPABASE_ONLY_NAMES = ['apply_migration', 'execute_sql', 'deploy_edge_function', 'create_edge_function_secret'];
// `state` (the owner's db-refs registry): a server the owner listed there is a Supabase server for every tool name. A registry that cannot be read or is invalid (`ok` false) hides that list, so every write name is judged on any server (evaluateSupabaseMcp then denies with the registry error); a missing file is `ok` with an empty list.
export const isSupabaseTool = (tool, state) => typeof tool === 'string' && tool.startsWith('mcp__') && (/supabase/i.test(serverSegment(tool)) || SUPABASE_ONLY_NAMES.includes(lastSegment(tool)) || (state?.servers ?? []).includes(serverSegment(tool)) || (state?.ok === false && SUPABASE_WRITE_NAMES.includes(lastSegment(tool))));

const deny = (reason) => ({ decision: 'deny', reason: `${PREFIX} ${reason}` });
const allow = () => ({ decision: 'allow', reason: '' });
const plain = (t) => String(t ?? '').replace(/\r\n/g, '\n').trim();

// ---- the claim ----------------------------------------------------------------------------------------------------------------------

// Exclusive-create marker, durable before it answers `claimed`: write, fsync the file, close, fsync the folder. Any failure -> 'error' (the leftover marker stays spent). EEXIST -> 'spent'.
// `io` ({openSync, writeSync, fsyncSync, closeSync}) are the fault seams of the tests. `promptId` is the typed go's prompt id, or (`click`) the click's id: one go, one apply either way, and
// the two key spaces ('live-db' vs 'live-db-click') cannot collide.
function takeMarker({ home, session, promptId, click = false, op, projectRef, sqlSha256, now, io = {} }) {
  const id = createHash('sha256').update(`${click ? 'live-db-click' : 'live-db'}|${session}|${promptId}`).digest('hex').slice(0, 32);
  const open = io.openSync ?? openSync;
  const write = io.writeSync ?? writeSync;
  const sync = io.fsyncSync ?? fsyncSync;
  const close = io.closeSync ?? closeSync;
  try {
    if (!realDirChain(home, LIVE_DB_CONSUMED_REL)) return 'error';
    const dir = path.join(home, ...LIVE_DB_CONSUMED_REL.split('/'));
    let fd;
    try {
      fd = open(path.join(dir, `${id}.json`), OPEN_EXCL, 0o600);
    } catch (err) {
      return err?.code === 'EEXIST' ? 'spent' : 'error';
    }
    try {
      write(fd, `${JSON.stringify({ v: 1, consumedAt: new Date(now()).toISOString(), op, projectRef, sqlSha256 })}\n`);
      sync(fd);
    } finally {
      close(fd);
    }
    try {
      const dfd = open(dir, constants.O_RDONLY);
      try { sync(dfd); } catch (err) { if (!['EISDIR', 'EINVAL', 'EPERM'].includes(err?.code)) throw err; } finally { close(dfd); }
    } catch (err) {
      if (!['EISDIR', 'EINVAL', 'EPERM'].includes(err?.code)) return 'error';
    }
    return 'claimed';
  } catch {
    return 'error';
  }
}

// -> { status: 'claimed'|'none'|'spent'|'unverified'|'expired'|'error', reason }
export function claimLiveDbGo({ home, sessionId, transcriptPath, op, projectRef, name = null, sqlSha256, now = Date.now, io = {} }) {
  if (typeof sessionId !== 'string' || sessionId === '') return { status: 'none', reason: 'the call carries no session id' };
  // A click the owner has just made may still be a pending pointer (Claude Code 2.1.323 writes the answer to the transcript only after the PostToolUse hook returns): verify it now, before the read below.
  // `waiting`: a live-database click of this session that could not be settled yet.
  const settled = settlePendingClicks({ home, now, session: sessionId });
  const waiting = settled.outcomes.some((o) => (o.outcome === 'waiting' || o.outcome === 'retry') && readAsk(o.askId, { home }).ask?.kind === 'live-db');
  const records = liveDbRecords({ home, session: sessionId, now })
    .filter((r) => r.op === op && r.projectRef === projectRef && r.sqlSha256 === sqlSha256 && (op !== 'migration' || r.name === name))
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  if (records.length === 0 && waiting) return { status: 'unverified', reason: 'the owner\'s click on the live-database dialog is received but cannot be verified yet (Claude Code writes the answer to the transcript a moment later): try the call again in a moment, and if it is still refused ask the owner to type the go instead' };
  if (records.length === 0) return { status: 'none', reason: 'no go from the owner is recorded for this exact SQL, project and name in this session' };
  let first = null;
  let spent = false;
  for (const r of records) {
    const skip = (status, reason) => { first ??= { status, reason }; };
    let at;
    let click = false;
    if (r.via === 'ask') {
      // The owner's click. clickProvenance re-reads the transcript: the question the dialog showed (its block re-passes verifyBlock in bindAnswer), the answer and the ask's own file must give exactly this
      // record, whose kind (live-db-go) only a live-db ask can bind. It is the same transcript as this call's, and the go's age runs from the answer's own time.
      click = true;
      if (clickProvenance(r, { home }) !== 'owner') { skip('unverified', 'the owner\'s click on the live-database dialog cannot be verified from the transcript: ask the owner to type the go instead'); continue; }
      if (r.transcript_path !== transcriptPath) { skip('unverified', 'the recorded click is from another transcript than this call\'s'); continue; }
      // R6-F1: as for the typed go, the owner must have been shown the whole block in the reply: the text right before the AskUserQuestion call ends with the block the dialog carries.
      const shown = replyBeforeToolUse(transcriptPath, r.ask.toolUseId);
      const sv = shown.text === undefined ? null : verifyBlock(shown.text, { home, io });
      const sf = sv?.fields;
      if (!sv?.ok || sf.op !== r.op || sf.ref !== r.projectRef || sf.sqlSha256 !== r.sqlSha256 || sf.head !== r.head || sf.file !== r.file || sf.repo !== r.repo || sf.name !== r.name) {
        skip('unverified', `the owner's click is not claimed: the reply right before the dialog does not end with the block the dialog carries (${shown.reason ?? sv.reason ?? 'a different block'}); run live-db present again and paste its block as the last thing in the reply, right before showing the dialog`);
        continue;
      }
      at = Date.parse(r.ts);
    } else {
      if (typeof r.prompt_id !== 'string' || r.prompt_id === '') { skip('unverified', 'the recorded go has no prompt id, so it cannot be tied to the owner\'s prompt'); continue; }
      const found = promptEntryOf(r, { home });
      if (found.source !== 'owner' || !found.entry) { skip('unverified', `the recorded go's prompt is ${found.source === 'missing' ? 'not in a transcript the guard trusts' : 'not the owner\'s typed prompt'}`); continue; }
      const typed = parseGo(promptTextOf(found.entry));
      if (promptTextOf(found.entry) !== plain(r.prompt) || !typed || typed.op !== r.op || typed.arg !== (r.op === 'migration' ? r.name : r.sqlSha256.slice(0, 12))) { skip('unverified', 'the transcript entry of that prompt does not say what the record says'); continue; }
      if (r.transcript_path !== transcriptPath) { skip('unverified', 'the recorded go is from another transcript than this call\'s'); continue; }
      const before = replyBefore(transcriptPath, r.prompt_id);
      if (before.text === undefined) { skip('unverified', before.reason); continue; }
      const v = verifyBlock(before.text, { home, io });
      const f = v.fields;
      if (!v.ok || f.op !== r.op || f.ref !== r.projectRef || f.sqlSha256 !== r.sqlSha256 || f.head !== r.head || f.file !== r.file || f.repo !== r.repo || f.name !== r.name) { skip('unverified', `the block the owner was shown before that go does not match the record${v.ok ? '' : ` (${v.reason})`}`); continue; }
      at = Date.parse(found.entry.timestamp);
    }
    const age = now() - at;
    if (!Number.isFinite(age) || age > LIVE_DB_MAX_AGE_MS || age < -FUTURE_SKEW_MS) { skip('expired', `the owner's go is older than ${LIVE_DB_MAX_AGE_MS / 3600000} hours (or from the future)`); continue; }
    const m = takeMarker({ home, session: sessionId, promptId: click ? r.ask.clickId : r.prompt_id, click, op, projectRef, sqlSha256, now, io });
    if (m === 'claimed') return { status: 'claimed', reason: '' };
    if (m === 'spent') { spent = true; continue; }
    return { status: 'error', reason: 'the go could not be marked as used (the folder is not a real directory, or a write failed), so nothing is applied' };
  }
  if (spent && first === null) return { status: 'spent', reason: 'that go was already used' };
  return first ?? { status: 'spent', reason: 'that go was already used' };
}

// ---- the decision ---------------------------------------------------------------------------------------------------------------------

const presentHint = (op, ref) => (op === 'migration'
  ? `${CLI} live-db present --op migration --pr <N> --file supabase/migrations/<file>.sql --project ${ref} --summary "…"`
  : `${CLI} live-db present --op data --sql-file <file> --project ${ref} --summary "…"`);
const show = (query) => `sha256 ${sha256Of(query)} over ${Buffer.byteLength(query, 'utf8')} bytes`;

// -> { decision, reason }. `ctx`: { home, sessionId, transcriptPath, now, io }
export function evaluateSupabaseMcp(tool, ti, ctx) {
  const name = lastSegment(tool);
  if (SUPABASE_READ_NAMES.includes(name)) return allow();
  const home = ctx.home;
  const state = readDbRefs(home);
  if (!state.ok) return deny(`the owner's database registry (~/.claude/pipeline-state/db-refs.json) is ${state.reason}, so no Supabase write is allowed; the owner fixes it with \`pipeline db-refs …\` in their own terminal`);
  const seg = serverSegment(tool);
  const target = targetOf(ti?.project_id, state, seg);
  if (target.kind === 'unknown') return deny(`${name} has no well-formed project_id, so its target is unknown (treated as live and unbindable); use an account-scoped Supabase MCP server, or the owner applies it`);
  if (!target.trusted) return deny(`the MCP server "${seg}" is not one the owner trusts for Supabase; the owner adds it with \`pipeline db-refs server add ${seg}\` in their own terminal`);
  if (target.kind === 'dev') return allow();
  if (isDevRef(target.ref, state)) return deny(`${name} targets ${target.label} (${target.ref}), which the owner declared dev, but the MCP server "${seg}" is not one the owner listed for dev projects, so it counts as live and no go can be recorded for it; the owner lists the server with \`pipeline db-refs server add ${seg}\` in their own terminal`);
  const where = `${target.label} (${target.ref})`;
  const query = typeof ti?.query === 'string' ? ti.query : null;
  if (name === 'execute_sql' || name === 'apply_migration') {
    if (query === null) return deny(`${name} on ${where} has no query text to bind a go to`);
    if (name === 'execute_sql' && matchCatalogQuery(query)) return allow();
    const op = name === 'apply_migration' ? 'migration' : 'data';
    const migName = name === 'apply_migration' && typeof ti?.name === 'string' ? ti.name : null;
    if (op === 'migration' && migName === null) return deny(`apply_migration on ${where} has no name to bind a go to`);
    const c = claimLiveDbGo({ home, sessionId: ctx.sessionId, transcriptPath: ctx.transcriptPath, op, projectRef: target.ref, name: migName, sqlSha256: sha256Of(query), now: ctx.now ?? Date.now, io: ctx.io });
    if (c.status === 'claimed') return allow();
    const lookup = name === 'execute_sql' ? ` For a schema look-up use \`${CLI} live-db catalog <kind> …\` and pass its sql verbatim.` : '';
    const ask = `Run \`${presentHint(op, target.ref)} --ask\`, end the reply with its block, then call AskUserQuestion with its ask.questions verbatim (when ask is null, wait for the owner's typed go instead).`;
    const after = c.status === 'spent' || c.status === 'error' ? ' A used go is never reused: check the live state read-only (list_migrations or a catalog query) before asking for a new one.' : '';
    return deny(`${name} on ${where} needs the owner's go for exactly this query (${show(query)}${op === 'migration' ? `, name ${migName}` : ''}): ${c.reason}.${lookup} ${ask}${after}`);
  }
  return deny(`${name} is not allowed on the live database ${where}; the owner does this in the dashboard`);
}


// ---- Task 5 (B1a): agent-run supabase CLI lines and Management API calls that can reach a non-local database ----
// findLiveDbCli(cmds, raw, state) -> reason | null (null = nothing to refuse). A line passes only when the line itself proves a LOCAL target (or the owner's `dev` project); everything the guard does
// not know is refused ("the owner runs it"). The psql family (psql, pg_dump…, usql, the pg utilities, PG* env) is judged by pgFamilyRefusal below (B1b).
//
// One SHAPE rule, no list of launchers (rounds 8-10 each found a new wrapper or an over-refusal in one). Per command, two readings are judged and a refusal from either wins: the parsed argv (the parser
// unwraps npx / timeout / xargs / sudo …) and the words as typed (`c.typed`, the parser's own words of the command: a quoted string, a substitution and a heredoc body stay one word, a comment is not a word).
// A supabase word (SB_WORD: the binary by any spelling) makes a CALL when it is word 0, or when it is later, the command that runs is not a data command (rg, git, find, cp, gh, make …: its supabase word is an operand), and a later
// non-flag word is a subcommand head or an expansion (`$SUB`, a substitution); `supabaseRefusal` then judges the words after it. So a doppler / op / direnv / mise / timeout / npx-dotenv wrapper is read without being named, and a directory or package name that merely ends in supabase (`npx eslint lib/supabase --fix`,
// `npm i supabase`) has no subcommand after it and is no call. A package manager's own install / look-up verb and a `--package` / `--filter` / `workspace` selector name the package without running it.
// xargs / parallel as the command that runs build the command from stdin: on a line that names supabase they are refused unless the command they name is plain data (`xargs wc -l`).
const OWNER_RUNS = 'the owner runs this; hand them the exact line';
const SB_WORD = /^(?:npm:|nixpkgs#)?supabase(?:-cli)?(?:@[^/\\]*)?$/;
const isSbWord = (w) => typeof w === 'string' && SB_WORD.test(commandName(w));
// subcommand prefixes (the words before the first flag): LOCAL_ONLY lines pass with no target flag or with `--local`; REMOTE_CAPABLE ones only with a local or `dev` target proof
const LOCAL_ONLY = [['start'], ['stop'], ['status'], ['init'], ['link'], ['unlink'], ['login'], ['logout'], ['db', 'reset'], ['db', 'diff'], ['db', 'lint'], ['migration', 'new'], ['migration', 'list'], ['migration', 'up'], ['test', 'db'], ['functions', 'serve'], ['functions', 'new'], ['projects', 'list'], ['orgs', 'list'], ['help'], ['db', 'start'], ['test', 'new'], ['gen', 'signing-key'], ['gen', 'bearer-jwt'], ['services'], ['completion']];
const REMOTE_CAPABLE = [['db', 'push'], ['db', 'pull'], ['db', 'dump'], ['migration', 'repair'], ['migration', 'squash'], ['migration', 'fetch'], ['functions', 'deploy'], ['functions', 'delete'], ['functions', 'download'], ['secrets'], ['storage'], ['branches'], ['config', 'push'], ['postgres-config'], ['sso'], ['domains'], ['vanity-subdomains'], ['ssl-enforcement'], ['inspect', 'db'], ['gen', 'types'], ['seed', 'buckets'], ['backups'], ['encryption'], ['snippets'], ['db', 'query'], ['db', 'advisors'], ['db', 'schema'], ['migration', 'down'], ['inspect', 'report'], ['functions', 'list'], ['logs'], ['pull'], ['notebooks'], ['projects'], ['orgs'], ['bootstrap'], ['telemetry'], ['whoami']];
// package managers: their non-run verbs only name the package (`npm install supabase`); `command -v` needs no entry (nothing follows the word)
const PM_HEADS = new Set(['pnpm', 'yarn', 'npm', 'bun', 'corepack']);
const NON_RUN_VERBS = new Set(['install', 'i', 'add', 'remove', 'rm', 'uninstall', 'update', 'upgrade', 'ls', 'list', 'why', 'view', 'info', 'outdated']);
// the options a manager takes before its verb, per manager (arity differs); any other option before the verb ends the exemption
const PM_SKIP = {
  npm: { bool: ['-g', '--global', '-D', '--save-dev', '-E', '--save-exact', '-O', '--save-optional', '-s', '--silent'], val: ['--prefix', '--workspace', '-w'] },
  pnpm: { bool: ['-g', '--global', '-D', '--save-dev', '-E', '--save-exact', '-O', '--save-optional', '-r', '--recursive', '-s', '--silent', '-w', '--workspace-root'], val: ['--filter', '-F', '-C', '--dir'] },
  yarn: { bool: [], val: ['--cwd'], workspace: true },
};
const startsWith = (tokens, prefix) => prefix.every((w, i) => tokens[i] === w);
const BOOL_FLAGS = new Set(['yes', 'debug', 'help', 'experimental', 'include-all', 'include-roles', 'include-seed', 'data-only', 'role-only', 'use-copy', 'keep-comments', 'no-verify-jwt', 'use-api', 'use-docker', 'legacy-bundle', 'prune', 'no-seed', 'use-migra', 'use-pgadmin', 'use-pg-schema', 'no-backup', 'read-only', 'skip-vault', 'with-migration-history', 'force', 'wizard', 'skip-pooler']);
const NON_LITERAL = /[\s$`*?[\]{}()~\\<>|;&'"!#]/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// a literal postgres URI whose host (after WHATWG parsing) is exactly localhost / 127.0.0.1 / ::1, with no query string but one `sslmode=<letters/->` (any other parameter, libpq's host= / hostaddr= / service= / options=, can move the host)
const SSLMODE_ONLY = /\?sslmode=[a-z-]+$/;
export function localDbUrl(v) {
  const bare = v.replace(SSLMODE_ONLY, '');
  if (bare.includes('?') || (bare.match(/@/g) ?? []).length > 1) return false;
  let u;
  try { u = new URL(bare); } catch { return false; }
  return (u.protocol === 'postgresql:' || u.protocol === 'postgres:') && LOCAL_HOSTS.has(u.hostname) && u.search === '' && u.hash === '';
}

// commands that only read or print their arguments: a Management API hostname mentioned on a line made of these alone (a search, an echo) makes no request
const NO_REQUEST = new Set(['rg', 'grep', 'egrep', 'fgrep', 'ag', 'ack', 'echo', 'printf', 'cat', 'head', 'tail', 'wc', 'ls', 'cd', 'pwd', 'cut', 'tr', 'sort', 'true', 'false', ':', 'test', '[']);
const NO_REQUEST_GIT = new Set(['grep', 'log', 'diff', 'show', 'blame', 'status', 'ls-files', 'shortlog', 'rev-list', 'describe']);
// (a bare command word only: `/tmp/x/rg` and `./rg` are scripts that may be named anything; and a line that writes a file, `echo '…' > run.sh`, is not a mention that goes nowhere)
const WRITE_OPS = new Set(['>', '>>', '>|', '>&', '&>', '&>>', '<>']);
const writesFile = (c) => (c.redirects ?? []).some((r) => WRITE_OPS.has(r.op) && r.target !== '/dev/null' && !/^&(?:\d+|-)$/.test(r.target ?? ''));
// a search or git read that runs a program (rg --pre, ack/ag --pager, git --ext-diff / --textconv / --output / -o / -O / --open-files-in-pager) or that runs under an env assignment (GIT_EXTERNAL_DIFF, PAGER…) can make a request
// (git takes any unambiguous abbreviation of a long option, so a two-letter prefix of one is refused too)
const PROGRAM_OPTION_GIT = ['output', 'output-directory', 'ext-diff', 'textconv', 'open-files-in-pager'];
const runsProgram = (c) => {
  const n = commandName(c.argv[0]);
  const args = c.argv.slice(1);
  if (n === 'rg') return args.some((a) => /^--(?:pre|hostname-bin)(?:=|$)/.test(a));
  // (ack's Getopt::Long and ag's getopt_long take unique prefixes, and ack also `-pager` and `+pager`: every spelling of p…pager is refused, `-p` too)
  if (n === 'ack' || n === 'ag') return args.some((a) => /^(?:--|-|\+)p(?:a(?:g(?:er?)?)?)?(?:=|$)/.test(a));
  // (sort writes with -o / --output and runs --compress-program; a cluster holding o is refused too)
  if (n === 'sort') return args.some((a) => (a.startsWith('--') ? a.length > 2 && ['output', 'compress-program'].some((o) => o.startsWith(a.slice(2).split('=')[0])) : /^-[A-Za-z0-9]*o/.test(a)));
  if (n === 'git') return args.some((a) => (a.startsWith('--') ? a.length > 3 && PROGRAM_OPTION_GIT.some((o) => o.startsWith(a.slice(2).split('=')[0])) : /^-[A-Za-z0-9]*[oO]/.test(a)));
  return false;
};
// the git subcommand after the global options that only move or quiet it (`-C dir`, `--no-pager`); `-c`, `--exec-path`, `--config-env` and any other option stay unread (null: not a read)
const gitReadSub = (argv) => {
  let i = 1;
  while (argv[i] === '--no-pager' || argv[i] === '-C') i += argv[i] === '-C' ? 2 : 1;
  return argv[i];
};
const makesNoRequest = (c) => {
  if (c.argv[0].includes('/') || writesFile(c) || stdinFed(c) || Object.keys(c.env ?? {}).length || runsProgram(c)) return false;
  const n = commandName(c.argv[0]);
  return NO_REQUEST.has(n) || (n === 'git' && NO_REQUEST_GIT.has(gitReadSub(c.argv)));
};

// the first words of every supabase subcommand and alias (`supabase --help` of CLI 2.122; re-check on a CLI update), plus those the tables below do not carry
const SUB_HEADS = new Set([...[...LOCAL_ONLY, ...REMOTE_CAPABLE].map((p) => p[0]), 'migrations', 'experimental', 'issue', 'feedback']);
const isSubcommandHead = (w) => SUB_HEADS.has(w) || /^network-/.test(w);
// the longest head a glob word could stand for, the `network-*` family by its real names (`supabase --help` of CLI 2.122; `network-restrictions` is the longest, 20): a pattern that must consume more characters than that is no head
const GLOB_HEAD_MAX = Math.max(...[...SUB_HEADS, 'network-bans', 'network-restrictions'].map((h) => h.length));
// B7: a supabase TOKEN in a line's text = `supabase` (optionally `npm:` / `nixpkgs#` before, `-cli` / `@version` / .exe .cmd .bat after) as the LAST path component of a word: not followed by `/ . _ -` or a word character
// (`supabase/migrations/x.sql`, `SUPABASE_URL`, `supabase.from(`, `supabase.com`, `@supabase/supabase-js` are not tokens; `supabase`, `./node_modules/.bin/supabase`, `'supabase db push'` are)
const SB_TOKEN_SRC = String.raw`(?<![\w.@-])(?:npm:|nixpkgs#)?supabase(?:-cli)?(?:@[^/\\\s'"]*)?(?:\.(?:exe|cmd|bat))?(?![\w/.\-_])`;
const SB_TOKEN = new RegExp(SB_TOKEN_SRC, 'i');
// The gate that decides whether a quoted command string is read again as a command line, a simple fail-closed rule (owner 2026-11-20; rounds 3 and 4 tried a word walk to spare prose and each found new holes):
// normalise the text in one pass, then say yes when ANY word after the first supabase token is a subcommand head or could become one (an expansion, a backtick, a brace, a glob).
// Normalising: every backslash-newline pair is deleted (the shell joins the lines), then every quote and backslash character; ( ) < > & | ; } become spaces, and a $ ` { becomes a space that also marks the word after it as a possible head.
// So no redirect, substitution, separator or quote shape can hide the head from the gate.
// One narrow prose rule (R3-F3, owner 2026-11-20), read on the RAW text before normalising: a token followed only by spaces or tabs and then a word of letters that is no head (`Supabase must be running`, `supabase stack failed to start`) is prose, not a call.
// A special character between the token and the word (`<<< y`, `"db"`, a backslash-newline, `2>&1`) or a later token makes it a call again; `supabase y db push` is harmless prose-shaped input (the CLI rejects the unknown command `y`).
// The reparse still judges: reparsedRefusal only refuses when a parsed command really starts with the binary. Linear: one regex pass, one split, one scan; never a regex over flag shapes (those backtracked, #688).
const MARK = '\x02';
const possibleHead = (w) => {
  const head = /^[a-z][a-z0-9-]*(?![\w-])/i.exec(w)?.[0].toLowerCase();
  return Boolean(head && isSubcommandHead(head)) || w.includes(MARK) || globMatchesHead(w);
};
// the prose rule's tail is tested apart from the token (R5-F2): a lookahead appended to SB_TOKEN made its greedy `@...` tail backtrack through the whole word at every token start, quadratic on `;supabase@;supabase@...`
const SB_TOKEN_ALL = new RegExp(SB_TOKEN_SRC, 'gi');
const PROSE_TAIL = /[ \t]+([A-Za-z]+)(?!\S)/y;
function sbTokenHead(text) {
  const words = text
    .replace(SB_TOKEN_ALL, (token, offset) => {
      PROSE_TAIL.lastIndex = offset + token.length;
      const word = PROSE_TAIL.exec(text)?.[1];
      return word !== undefined && !possibleHead(word) ? '\x03' : token;
    })
    .replace(/\\\n/g, '')
    .replace(/['"\\]/g, '')
    .replace(/[$`{]/g, ' ' + MARK)
    .replace(/[}()<>&|;]/g, ' ')
    .split(/\s+/);
  const first = words.findIndex((w) => SB_TOKEN.test(w));
  return first >= 0 && words.slice(first + 1).some(possibleHead);
}
// B8: a word with glob characters (`d?`, `*`, `[d]b`) may become a subcommand head, a simple fail-closed rule (owner 2026-11-20: rounds 5 to 7 each found a hole in a glob-to-regex translator, so no pattern is matched at all).
// A glob word is a possible head unless it must consume more characters than the longest head, so every short glob is refused (`'src/**/*.ts'`, `httpx[http2]` too: a false refusal costs "the owner runs it") and a long path, URL or SQL operand stays allowed (R6-F1).
// Whitespace is not a reason to skip a word: `[' 'd]b` is one glob word that can name a file `db`.
// Linear in the word, no backtracking (R5-F1, R6-F2); supabaseCalls and findLiveDbCli judge each word and the line once (R7-F1).
function globMatchesHead(w) {
  if (!/[*?[]/.test(w)) return false;
  // `need` is a STRICT LOWER BOUND on the characters the pattern consumes, so it never overestimates and no head can hide behind it:
  // a backslash is dropped (an escaped character counts once at most), a `*` counts 0 (it may match nothing), everything between the first `[` and the last `]` counts 1
  // (that region is at least one bracket class; POSIX classes, a leading `]` and nested brackets are never parsed), and every other character, `?` included, counts 1.
  w = w.replace(/\\/g, '');
  const open = w.indexOf('[');
  const close = w.lastIndexOf(']');
  if (open >= 0 && close > open) w = `${w.slice(0, open)}x${w.slice(close + 1)}`;
  return w.replace(/\*/g, '').length <= GLOB_HEAD_MAX;
}
// an expansion after the supabase word (`supabase $SUB`, `supabase "$@"`) can become a subcommand; a glob (`'src/**/*.ts'`, `'httpx[http2]'`) is a file or package pattern
const NON_LITERAL_WORD = /[$`]/;
const nonLiteralHead = (words) => words.length > 0 && NON_LITERAL_WORD.test(commandName(words[0]));
// commands whose operands are data (a pattern, a path, a package, a message), not a program: a supabase word after one is a name, never the binary (git / make / gh can start a program only through an option or a word the line quotes, which stays one word)
// (`sed` stays here as a plain-data program behind xargs, but is NOT a data command as an operand head: its `e` command / `s///e` flag run programs, see buildsProgram)
const STDIN_DATA = ['grep', 'egrep', 'fgrep', 'cat', 'head', 'tail', 'wc', 'ls', 'cut', 'tr', 'uniq', 'sed', 'cp', 'mv', 'rm', 'mkdir', 'touch', 'diff', 'echo', 'printf', 'which', 'pip', 'pip3', 'basename', 'dirname', 'realpath', 'stat', 'file', 'du'];
const DATA_COMMANDS = new Set([...STDIN_DATA.filter((n) => n !== 'sed'), 'rg', 'ag', 'ack', 'gh', 'find', 'make', 'sort', 'cd', 'pwd']);
// git is data only for a subcommand that cannot run a command word (bisect run, rebase -x, submodule foreach, an alias or an unknown one can)
const GIT_DATA_SUBS = new Set(['add', 'apply', 'blame', 'branch', 'checkout', 'cherry-pick', 'clone', 'commit', 'config', 'describe', 'diff', 'fetch', 'grep', 'init', 'log', 'ls-files', 'ls-remote', 'ls-tree', 'merge', 'merge-base', 'mv', 'notes', 'pull', 'push', 'remote', 'reset', 'restore', 'rev-list', 'rev-parse', 'revert', 'rm', 'shortlog', 'show', 'show-ref', 'stash', 'status', 'switch', 'tag', 'worktree']);
const GIT_BOOL_GLOBALS = new Set(['--no-pager', '-P', '--bare', '--no-optional-locks', '--literal-pathspecs']);
function gitSub(words) {
  for (let i = 1; i < words.length; i += 1) {
    const w = words[i];
    if (GIT_BOOL_GLOBALS.has(w)) continue;
    if (w === '-C' || w === '-c' || w === '--git-dir' || w === '--work-tree') { i += 1; continue; }
    if (/^--(?:git-dir|work-tree)=/.test(w)) continue;
    return w.startsWith('-') ? null : w;
  }
  return null;
}
// the command that RUNS (word 0 of one reading) is a data command: its supabase words are operands
const isDataWords = (words) => {
  const n = commandName(words[0]);
  return n === 'git' ? GIT_DATA_SUBS.has(gitSub(words)) : DATA_COMMANDS.has(n);
};
const typedWords = (c) => (Array.isArray(c.typed) ? c.typed : c.argv);
const nearestHead = (words, i, heads) => { let j = i - 1; while (j >= 0 && !heads.has(commandName(words[j]))) j -= 1; return j; };

// words[i] sits right after a manager's own verb (`npm install supabase`, `pnpm --filter web add supabase`): the nearest manager head, then only that manager's listed options, then a non-run verb
function pmNonRun(words, i) {
  const j = nearestHead(words, i, PM_HEADS);
  if (j < 0) return false;
  const rules = PM_SKIP[commandName(words[j])];
  let k = j + 1;
  while (rules && k < i) {
    const w = words[k];
    if (rules.bool.includes(w)) k += 1;
    else if (rules.val.includes(w)) k += 2;
    else if (rules.val.some((o) => o.startsWith('--') && w.startsWith(`${o}=`))) k += 1;
    else if (rules.workspace && w === 'workspace') k += 2;
    else break;
  }
  return k < i && NON_RUN_VERBS.has(words[k]);
}

// words[i] is the value of a selector, not the executable: `--package X` / `-p X` of a runner (only before its first non-option word), `--filter X` / `-F X` (pnpm), `--workspace X` (npm), `workspace X` (yarn)
const RUNNERS = new Set(['npx', 'bunx', 'pnpx']);
function isSelector(words, i) {
  const j = nearestHead(words, i, new Set([...RUNNERS, ...PM_HEADS]));
  if (j < 0) return false;
  const head = commandName(words[j]);
  const prev = words[i - 1];
  // (a directory option's value is no executable either: `npm --prefix supabase test`, `pnpm -C supabase test`)
  if ((head === 'pnpm' && ['--filter', '-F', '-C', '--dir'].includes(prev)) || (head === 'npm' && ['--workspace', '-w', '--prefix'].includes(prev)) || (head === 'yarn' && ['workspace', '--cwd'].includes(prev))) return true;
  if (!RUNNERS.has(head) && !(PM_HEADS.has(head) && ['exec', 'dlx', 'x'].includes(words[j + 1]))) return false;
  for (let k = RUNNERS.has(head) ? j + 1 : j + 2; k < i;) {
    const w = words[k];
    if (!w.startsWith('-') || w === '--') return false;
    if (w === '-p' || w === '--package') { if (k + 1 === i) return true; k += 2; } else k += 1;
  }
  return false;
}

// every supabase call among the words -> [{ rest }] (the words after the supabase word, for supabaseRefusal). `data`: the command that runs is a data command, so a later supabase word is an operand
function supabaseCalls(words, data) {
  const calls = [];
  // R7-F1: each word is judged for "could be a head" once, then a suffix-any answers every supabase word (one scan per command, not one per supabase word)
  let headFrom = null; // headFrom[i]: some word at index >= i could be a subcommand head
  const anyHeadAfter = (i) => {
    if (!headFrom) {
      headFrom = new Array(words.length + 1).fill(false);
      for (let k = words.length - 1; k >= 0; k -= 1) {
        const x = words[k];
        headFrom[k] = headFrom[k + 1] || (!x.startsWith('-') && (isSubcommandHead(x) || NON_LITERAL_WORD.test(x) || globMatchesHead(x)));
      }
    }
    return headFrom[i + 1];
  };
  words.forEach((w, i) => {
    if (!isSbWord(w)) return;
    const rest = words.slice(i + 1);
    if (i === 0) { calls.push({ rest }); return; }
    if (data || isSelector(words, i) || pmNonRun(words, i)) return;
    if (anyHeadAfter(i)) calls.push({ rest });
  });
  return calls;
}

// xargs / parallel is the command that runs (the parser's `fan`): it builds the command from stdin text the line does not show. As an operand (`rg -n parallel supabase`) it is just a word
const stdinFed = (c) => c.fan === true;
// ... and what it builds can be the binary or a launcher of it unless the command it names is plain data (`xargs wc -l`; none named, or a search that can run a program from its options, is not)
// (B2: `sed` runs programs with its `e` command, so it is plain data here only while the line shows no supabase token followed by a subcommand head)
// (`lineHead` is a function that reads the line once: it is asked per command, and a line of hundreds of `xargs sed` commands must not scan its text each time, R7-F1)
const buildsProgram = (c, lineHead) => {
  const n = commandName(c.argv[0]);
  return n === 'sed' ? lineHead() : !STDIN_DATA.includes(n);
};

// the global flags (every subcommand accepts them, CLI 3.1 `GLOBAL FLAGS`; 2.x has the same set minus the 3.x-only ones, which 2.x rejects itself): one that takes a value (two-word or `=` form) and the booleans
const GLOBAL_VALUE = new Set(['--workdir', '--profile', '--network-id', '--dns-resolver', '--output', '-o', '--output-format', '--log-level', '--agent', '--completions']);
const GLOBAL_BOOL = new Set(['--debug', '--experimental', '--yes', '--wizard']);
// words after the supabase word -> { rest: the words after the leading global flags, error }
function skipGlobals(words) {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (GLOBAL_BOOL.has(w)) { i += 1; continue; }
    if (GLOBAL_VALUE.has(w)) {
      if (words[i + 1] === undefined) return { rest: words, error: `\`${w}\` has no value` };
      i += 2;
      continue;
    }
    if (/^--[a-z-]+=/.test(w) && GLOBAL_VALUE.has(w.slice(0, w.indexOf('=')))) { i += 1; continue; }
    break;
  }
  return { rest: words.slice(i), error: null };
}

function supabaseRefusal(words, state) {
  const skipped = skipGlobals(words);
  if (skipped.error) return skipped.error;
  const rest = skipped.rest;
  const first = rest[0];
  if (first === undefined) return null; // bare `supabase` (or only global flags) prints help
  const sub = [];
  for (const w of rest) { if (w.startsWith('-')) break; sub.push(w); }
  // a real `--help` / `-h` (before a `--`, not the value of an option that may take the next word) only prints help
  let ended = false;
  let takesNext = false;
  for (const w of rest.slice(sub.length)) {
    if (w === '--') { ended = true; continue; }
    const isValue = takesNext;
    takesNext = false;
    if (!ended && !isValue && (w === '--help' || w === '-h')) return null;
    const m = /^--([a-z-]+)(=.*)?$/s.exec(w);
    if (w.startsWith('-') && !w.includes('=') && !(m && (BOOL_FLAGS.has(m[1]) || ['local', 'linked', 'dry-run', 'remote'].includes(m[1])))) takesNext = true;
  }
  if (!sub.length) return ['--version', '--help', '-h', '-v'].includes(first) ? null : `\`supabase ${first}\` leads with a flag, which is not a shape the guard knows`;
  const local = LOCAL_ONLY.some((p) => startsWith(sub, p));
  const remote = REMOTE_CAPABLE.some((p) => startsWith(sub, p)) || /^network-/.test(sub[0]);
  if (!local && !remote) return `\`supabase ${sub.join(' ')}\` is not a subcommand the guard knows`;
  // flag hygiene: each target flag once, in one form, with a literal value
  // `--local` / `--dry-run` / `--db-url` / `--project-ref` / `--read-only` prove what they say only when they are real flags: before a `--`, and not the value of another option (an option the guard does not know may take the next word as its value)
  // `--remote` takes an OPTIONAL value (3.1): `--remote=<ref|branch|url>` is a target like `--db-url`; a bare `--remote` is the linked project (`--remote X` leaves X a positional)
  const seen = { 'db-url': [], 'project-ref': [], linked: [], local: [], 'dry-run': [], remote: [], 'read-only': [] };
  const real = { local: 0, 'dry-run': 0, 'db-url': 0, 'project-ref': 0, remote: 0, 'read-only': 0 };
  let terminated = false;
  let swallowed = false;
  for (let i = sub.length; i < rest.length; i += 1) {
    const w = rest[i];
    if (w === '--') { terminated = true; continue; }
    const isValue = swallowed;
    swallowed = false;
    const m = /^--([a-z-]+)(=(.*))?$/s.exec(w);
    if (!m || !(m[1] in seen)) {
      if (w.startsWith('-') && !w.includes('=') && !(m && BOOL_FLAGS.has(m[1]))) swallowed = true;
      continue;
    }
    if (m[1] === 'remote') {
      seen.remote.push(m[2] === undefined ? true : m[3]);
      if (!terminated && !isValue) real.remote += 1;
      continue;
    }
    if (m[1] === 'linked' || m[1] === 'local' || m[1] === 'dry-run' || m[1] === 'read-only') {
      // (a valued `--read-only=x` is counted, so a second `--read-only` is "given more than once", but it is never the bare flag)
      if (m[2] !== undefined && m[1] !== 'read-only') return `\`${w}\` is not the bare \`--${m[1]}\` flag`;
      seen[m[1]].push(m[2] === undefined ? true : w);
      if (m[2] === undefined && m[1] !== 'linked' && !terminated && !isValue) real[m[1]] += 1;
      continue;
    }
    let value = m[3];
    if (m[2] === undefined) { value = rest[i + 1]; i += 1; }
    if (value === undefined) return `\`--${m[1]}\` has no value`;
    seen[m[1]].push(value);
    if (!terminated && !isValue) real[m[1]] += 1;
  }
  for (const [name, list] of Object.entries(seen)) if (list.length > 1) return `\`--${name}\` is given more than once`;
  const [dbUrl] = seen['db-url'];
  const [projectRef] = seen['project-ref'];
  const [remoteFlag] = seen.remote;
  const remoteValue = typeof remoteFlag === 'string' ? remoteFlag : undefined;
  const isLocal = seen.local.length === 1 && real.local === 1;
  const linked = seen.linked.length === 1;
  const hasRemote = remoteFlag !== undefined;
  // a real bare `--read-only` on `db query` runs the statement in a read-only transaction (owner 2026-11-20: it passes for any target; the other subcommands ignore the flag)
  const readOnly = sub[0] === 'db' && sub[1] === 'query' && seen['read-only'].length === 1 && seen['read-only'][0] === true && real['read-only'] === 1;
  if (isLocal && (linked || dbUrl !== undefined || projectRef !== undefined || hasRemote)) return '`--local` is combined with a remote target flag';
  if (hasRemote && (linked || dbUrl !== undefined || projectRef !== undefined)) return '`--remote` is combined with another target flag';
  if (linked && (dbUrl !== undefined || projectRef !== undefined)) return '`--linked` is combined with another target flag';
  if (dbUrl !== undefined && projectRef !== undefined) return '`--db-url` is combined with `--project-ref`';
  // (a read-only `db query` lets a non-literal target value through too; a repeated or conflicting target flag, above, is refused with it)
  for (const v of [dbUrl, projectRef, remoteValue]) if (v !== undefined && !readOnly && NON_LITERAL.test(v.replace(SSLMODE_ONLY, '').replace('@[::1]:', '@:'))) return `the target value \`${v}\` is not a literal`;
  const hasTarget = linked || dbUrl !== undefined || projectRef !== undefined || hasRemote;
  if (local && !hasTarget) return null;
  if (isLocal) return null;
  if (dbUrl !== undefined && real['db-url'] === 1 && localDbUrl(dbUrl)) return null;
  if (remoteValue !== undefined && real.remote === 1 && (localDbUrl(remoteValue) || isDevRef(remoteValue, state))) return null;
  if (projectRef !== undefined && real['project-ref'] === 1 && isDevRef(projectRef, state)) return null;
  if (readOnly) return null;
  if (sub[0] === 'db' && sub[1] === 'push' && seen['dry-run'].length === 1 && real['dry-run'] === 1 && !hasRemote) return null;
  for (const name of ['db-url', 'project-ref']) if (seen[name].length === 1 && real[name] === 0) return `the \`--${name}\` follows \`--\` or an option that may take it as its value; put the target flag first`;
  const what = dbUrl !== undefined ? 'a `--db-url` that is not a plain localhost URI'
    : projectRef !== undefined ? `\`--project-ref ${projectRef}\`, which the owner has not declared dev`
      : hasRemote ? (remoteValue !== undefined ? `\`--remote=${remoteValue}\`, which is neither a plain localhost URI nor a dev project` : '`--remote`, the linked project')
        : linked ? '`--linked`' : 'no `--local` or other target flag (it defaults to the linked project)';
  return `\`supabase ${sub.join(' ')}\` can reach a non-local database: ${what}`;
}

// the path of the URL that starts `after` (the text after the host) names only its own project: no dot segment, encoded slash, backslash or second project ref (curl resolves `/../` before it sends)
function cleanApiPath(after) {
  const p = (/^[^\s'"?#]*/.exec(after) ?? [''])[0];
  if (/%2f|%5c|\\/i.test(p)) return false;
  const segs = p.split('/').slice(1);
  if (segs.some((g) => /^(?:\.|%2e){1,2}$/i.test(g))) return false;
  return !segs.slice(3).some((g) => /^[a-z0-9]{20}$/i.test(g));
}

// B10: a word that holds a whole command line (a quoted string given to doppler / nix-shell / ssh / docker exec / git rebase -x): the text of the word, or of the value of `--opt=value`
const commandText = (w) => (w.startsWith('--') && w.includes('=') ? w.slice(w.indexOf('=') + 1) : w);
// the pipeline's own CLI takes prose in --built / --summary / --reason / --owner-quote / --line / --body (copied verbatim, F4); sed's script text is a residual (F7)
const PIPELINE_BINS = new Set(['pipeline.mjs', 'pipeline']);
// (only when the pipeline CLI is the program that runs: word 0 is the bin, or node's first non-option word is the script; a container, session or project NAMED pipeline is not)
const isPipelineBin = (argv) => {
  const n = commandName(argv[0]);
  if (PIPELINE_BINS.has(n)) return true;
  const script = argv.slice(1).find((a) => !a.startsWith('-'));
  return n === 'node' && script !== undefined && PIPELINE_BINS.has(commandName(script));
};
// the word that IS the program of an inline interpreter (`node -e|--eval|-p|--print CODE`, `--eval=CODE`, `python|python3|pythonX.Y -c CODE`): JavaScript / Python source, not a shell line, so it is not reparsed (owner 2026-11-20; a shell's `-c` stays read). Its residual is in docs/cli.md
const isInlineProgram = (words, i) => {
  const n = commandName(words[0]);
  if (n === 'node') return ['-e', '--eval', '-p', '--print'].includes(words[i - 1]) || /^--(?:eval|print)=/.test(words[i]);
  return /^python(?:\d+(?:\.\d+)?)?$/.test(n) && words[i - 1] === '-c';
};
const NESTED_UNREAD = 'a quoted command string the guard could not read whole';
const MAX_REPARSE_DEPTH = 2;

// the supabase calls of one command read from a quoted string: word 0 (after the parser's own unwrapping of npx / timeout / env …) is the binary; a package manager head keeps the later-word rule (F8); a variable head is B9
function reparsedRefusal(text, state, reparse, depth) {
  // (zsh's `>>&` appends both streams to the next word; the parser reads it as `>>` then a `&` separator and would split the command, so it is read as the plain `>>` here)
  const inner = reparse(text.replace(/>>&/g, '>>'));
  if (!inner || inner.truncated || inner.undecidable) return NESTED_UNREAD;
  for (const c of inner) {
    const argv = c.argv ?? [];
    const typed = typedWords(c);
    // (the words as typed too, for the word-0 judgement only: the parser keeps the backslash of `supa\base` in argv, the typed words read it as the shell does)
    for (const words of typed !== argv && typed.join('\0') !== argv.join('\0') ? [argv, typed] : [argv]) {
      if (!words.length) continue;
      let why = null;
      if (isSbWord(words[0])) why = supabaseRefusal(words.slice(1), state);
      else if (PM_HEADS.has(commandName(words[0]))) {
        for (const call of supabaseCalls(words, false)) why ??= supabaseRefusal(call.rest, state);
      } else why = variableHeadRefusal(words, state);
      if (why) return why;
    }
    // (R4-F3: the data-command test and the inner words stay on argv, so `sudo rg -n "supabase db push" docs` is a search, as at the top level)
    if (!argv.length || isDataWords(argv) || commandName(argv[0]) === 'sed') continue;
    for (const [i, w] of argv.entries()) {
      if (isInlineProgram(argv, i)) continue;
      // (a word that is the whole text just read -- the parser lists a `$(…)` word as its own command -- reads the same again: its commands are already judged)
      if (!sbTokenHead(w) || commandText(w) === text) continue;
      if (depth >= MAX_REPARSE_DEPTH) return NESTED_UNREAD;
      const why = reparsedRefusal(commandText(w), state, reparse, depth + 1);
      if (why) return why;
    }
  }
  return null;
}

// B9: the command is run through a variable (`$SB db push`, `"$(command -v supabase)" db push`): when word 0 itself is non-literal (a literal last component, `"$HOME/.cargo/bin/cargo"`, is a program) and the first later non-flag word is a subcommand head, the words after word 0 are judged
function variableHeadRefusal(words, state) {
  if (!nonLiteralHead(words)) return null;
  const { rest } = skipGlobals(words.slice(1));
  const at = rest.findIndex((w) => !w.startsWith('-'));
  if (at < 0 || !isSubcommandHead(rest[at])) return null;
  const why = supabaseRefusal(words.slice(1), state);
  // (the group name alone prints help, and a word after the head that no subcommand is named like -- a quoted `'.shell echo hi'`, a path -- makes the line a sqlite / psql file argument, not a supabase subcommand: `Q=sqlite3; $Q db '.shell x'`, `$Q db < q.sql`)
  const next = rest[at + 1];
  if (why && /is not a subcommand the guard knows/.test(why) && (next === undefined || (!next.startsWith('-') && !/^[a-z][a-z0-9-]*$/.test(next) && !NON_LITERAL_WORD.test(next)))) return null;
  return why;
}

// ---- Task 5 (B1b): the psql family -----------------------------------------------------------------------------------------------------
// A tripwire, not a boundary: an agent-run line that runs psql or another Postgres client cannot, BY ITS OWN COMMAND LINE, point the client at a non-local database. Two psql shapes pass
// (a strict host psql to one literal localhost URI; psql inside a local Supabase container through `docker exec`); every other family line is refused ("the owner runs this").
// Fail closed, a false refusal over any bypass; every scan is one linear pass, no regex over flag shapes (#688), no quote / comment / dollar-quote tracking in the SQL text.
// What the local server or a container does once connected, container configuration and a daemon behind a local socket are named residuals (docs/cli.md "Live database guard").
const PG_NAMES = ['psql', 'pg_dump', 'pg_restore', 'pg_dumpall', 'pgcli', 'usql', 'dropdb', 'createdb', 'vacuumdb', 'reindexdb', 'clusterdb', 'pgbench', 'pg_basebackup', 'pg_receivewal', 'createuser', 'dropuser', 'pg_amcheck', 'pg_recvlogical', 'pg_isready', 'vacuumlo', 'oid2name',
  'pg_upgrade', 'pg_ctl', 'pg_resetwal', 'pg_rewind', 'pg_controldata', 'pg_waldump', 'pg_verifybackup', 'pg_archivecleanup', 'pg_checksums', 'pg_test_fsync', 'pg_test_timing', 'pg_createsubscriber', 'pg_combinebackup', 'pg_walsummary', 'pg_ctlcluster', 'pg_lsclusters', 'pg_createcluster', 'pg_dropcluster', 'pg_upgradecluster', 'pg_conftool'];
const PG_SET = new Set(PG_NAMES);
// a family WORD (word 0 or a later word): psql, the always-refused tools and any other `pg_*` program but pg_config (some work offline; refusing them costs little)
const pgWord = (w) => { const n = commandName(w); return PG_SET.has(n) || (n.startsWith('pg_') && n !== 'pg_config'); };
// a family TOKEN in a line's text: the name as the LAST path component of a word (same shape as SB_TOKEN_SRC); `pg_class`, `psql_x`, `psql.md`, `@scope/psql-x` are not tokens
const PG_TOKEN = new RegExp(String.raw`(?<![\w.@-])(?:${PG_NAMES.join('|')})(?:\.(?:exe|cmd|bat))?(?![\w/.\-_])`, 'i');
const SDB_TEXT = /supabase_db_/i;
const PG_ENV_NAME = /\b(?:PG[A-Z_]+|DATABASE_URL|DOCKER_[A-Z_]+)\b/;
const DOCKER_HINT = 'the shape that passes is `docker exec -i supabase_db_<name> psql -X -U postgres -d postgres -f - < file.sql`';

// ---- the SQL text scan (host -c, docker -c, the docker file): every rule over-reads, nothing is skipped ----
const DESCRIBE_BASE = ['d', 'da', 'dA', 'dAc', 'dAf', 'dAo', 'dAp', 'db', 'dc', 'dC', 'dconfig', 'dd', 'dD', 'ddp', 'dE', 'des', 'det', 'deu', 'dew', 'df', 'dF', 'dFd', 'dFp', 'dFt', 'dg', 'di', 'dl', 'dL', 'dm', 'dn', 'do', 'dO', 'dp', 'dP', 'drds', 'drg', 'dRp', 'dRs', 'ds', 'dt', 'dT', 'du', 'dv', 'dx', 'dX', 'dy'];
// exact meta-command names (`\` + the run up to a space, a tab or the next backslash): the separator ('') and `\.`, display and variable commands, the conditional family, the describe family
const META_OK = new Set(['', '.', 'set', 'unset', 'echo', 'qecho', 'warn', 'pset', 'timing', 'x', 'a', 't', 'f', 'H', 'C', 'q', 'quit', 'if', 'elif', 'else', 'endif', 'conninfo', 'errverbose', 'gdesc', 'l', 'l+', 'list', 'list+', 'g', 'gx',
  ...DESCRIBE_BASE.flatMap((n) => [n, `${n}+`, `${n}S`, `${n}S+`, `${n}+S`])]);
const SET_LINE = /^[ \t]*\\set[ \t]+[a-z][a-z0-9_]*(?:[ \t]+(?:[A-Za-z0-9_.-]+|'[A-Za-z0-9_ .,@/-]*'))?[ \t]*$/;
// (the one upper-case name allowed, as `-v ON_ERROR_STOP` is: exactly this line and nothing else)
const SET_ON_ERROR_STOP = /^[ \t]*\\set[ \t]+ON_ERROR_STOP[ \t]+(?:on|off|1|0|true|false)[ \t]*$/;
const SQL_WORDS = ['program', 'dblink', 'fdw', 'plpython', 'plperlu', 'pltclu', 'plsh'];
const isMetaSpace = (ch) => ch === ' ' || ch === '\t' || ch === '\f' || ch === '\v';
const isAlpha = (ch) => (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
const isNameChar = (ch) => isAlpha(ch) || (ch >= '0' && ch <= '9') || ch === '_';
// `:'name'` / `:"name"` at t[j] (the quote), name `^[a-z][a-z0-9_]*$`
function quotedVariable(t, j) {
  const q = t[j];
  let k = j + 1;
  if (!(t[k] >= 'a' && t[k] <= 'z')) return false;
  while (k < t.length && ((t[k] >= 'a' && t[k] <= 'z') || (t[k] >= '0' && t[k] <= '9') || t[k] === '_')) k += 1;
  return t[k] === q;
}
/** @returns {string|null} why the text may not be run through a local-only psql, or null */
export function psqlTextRefusal(text, { host = false } = {}) {
  const t = String(text).replace(/\r\n/g, '\n');
  if (t.includes('\r')) return 'a carriage return that is not part of a CRLF line end';
  if (t.includes('\0')) return 'a NUL byte';
  const lines = t.split('\n');
  for (let n = 0; n < lines.length; n += 1) {
    const line = lines[n];
    let bs = line.indexOf('\\');
    if (bs < 0) continue;
    if (host) return `a backslash on line ${n + 1} (a meta-command or an escape)`;
    if (line.includes('`')) return `a backtick on line ${n + 1}, which also holds a backslash`;
    while (bs >= 0) {
      let j = bs + 1;
      while (j < line.length && line[j] !== '\\' && !isMetaSpace(line[j])) j += 1;
      const name = line.slice(bs + 1, j);
      if (!META_OK.has(name)) return `the meta-command \`\\${name}\` on line ${n + 1} is not on the allow-list`;
      if ((name === 'g' || name === 'gx') && line.slice(j).trim() !== '') return `\`\\${name}\` with text after it on line ${n + 1}`;
      if (name === 'pset' && line.slice(j).trimStart().toLowerCase().startsWith('p')) return `\`\\pset\` of a pager setting on line ${n + 1}`;
      if (name === 'set' && !SET_LINE.test(line) && !SET_ON_ERROR_STOP.test(line)) return `a \`\\set\` on line ${n + 1} that is not \`\\set <name> [<plain value>]\``;
      bs = line.indexOf('\\', j);
    }
  }
  // interpolation: only the quoted forms; a run of three or more colons, or any other colon followed by a name, a digit, a quote, `{` or a non-ASCII byte, is refused (unquoted `:name` inserts raw text and psql's own variables carry server text)
  for (let i = 0; i < t.length;) {
    if (t[i] !== ':') { i += 1; continue; }
    let j = i;
    while (t[j] === ':') j += 1;
    const run = j - i;
    if (run >= 3) return 'a run of three or more colons';
    const ch = t[j];
    if (ch !== undefined && (isNameChar(ch) || ch === "'" || ch === '"' || ch === '{' || ch.charCodeAt(0) >= 0x80)) {
      const ok = (run === 1 && (ch === "'" || ch === '"') && quotedVariable(t, j)) || (run === 2 && isAlpha(ch));
      if (!ok) return `a \`:${ch}\` interpolation or colon form the guard does not read`;
    }
    i = j;
  }
  const lower = t.toLowerCase();
  for (const w of SQL_WORDS) if (lower.includes(w)) return `the SQL word \`${w}\``;
  if (/alter\s+system/.test(lower)) return 'the SQL words `alter system`';
  return null;
}

// ---- psql's own command line: exact option names, every word a proven literal ----
const PSQL_BOOL_SHORT = 'XAtqxaebEnw1Hz0';
const PSQL_VALUE_SHORT = new Map([['c', 'command'], ['f', 'file'], ['d', 'dbname'], ['U', 'username'], ['v', 'set'], ['F', 'fsep'], ['R', 'rsep'], ['T', 'tattr'], ['P', 'pset']]);
const PSQL_BOOL_LONG = new Set(['no-psqlrc', 'tuples-only', 'no-align', 'quiet', 'csv', 'html', 'expanded', 'echo-all', 'echo-errors', 'echo-queries', 'single-transaction', 'no-password', 'field-separator-zero', 'record-separator-zero']);
const PSQL_VALUE_LONG = new Map([['command', 'command'], ['file', 'file'], ['dbname', 'dbname'], ['username', 'username'], ['set', 'set'], ['variable', 'set'], ['field-separator', 'fsep'], ['record-separator', 'rsep'], ['table-attr', 'tattr'], ['pset', 'pset']]);
const IDENT = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;
const SET_NAME = /^[a-z][a-z0-9_]*$/;
const SET_VALUE = /^[A-Za-z0-9_.-]*$/;
const UNQUOTED_CHANGES = /[*?[\]{}$~\\`\s]/;

// -> { why } | { norc, command: [], file: [], dbname: [], username: [], set: [], pos: [] }; `lit`: the command's litWords
function parsePsqlArgs(args, lit) {
  const r = { norc: false, command: [], file: [], dbname: [], username: [], set: [], fsep: [], rsep: [], tattr: [], pset: [], pos: [] };
  const bad = (why) => ({ why });
  for (let i = 0; i < args.length; i += 1) {
    const w = args[i];
    if (!lit.has(w)) return bad(`\`${w}\` is not a plain literal word`);
    const take = (inline) => {
      if (inline !== undefined) return inline;
      i += 1;
      return i < args.length && lit.has(args[i]) ? args[i] : null;
    };
    if (w === '--' || w === '-') return bad(`\`${w}\``);
    if (w.startsWith('--')) {
      const eq = w.indexOf('=');
      const name = eq < 0 ? w.slice(2) : w.slice(2, eq);
      if (PSQL_BOOL_LONG.has(name)) {
        if (eq >= 0) return bad(`\`${w}\``);
        if (name === 'no-psqlrc') r.norc = true;
        continue;
      }
      const kind = PSQL_VALUE_LONG.get(name);
      if (!kind) return bad(`the option \`--${name}\` is not one the guard reads`);
      const value = take(eq >= 0 ? w.slice(eq + 1) : undefined);
      if (value === null) return bad(`\`--${name}\` has no literal value`);
      r[kind].push(value);
      continue;
    }
    if (w.startsWith('-')) {
      for (let k = 1; k < w.length; k += 1) {
        const ch = w[k];
        if (PSQL_BOOL_SHORT.includes(ch)) { if (ch === 'X') r.norc = true; continue; }
        const kind = PSQL_VALUE_SHORT.get(ch);
        if (!kind) return bad(`the option \`-${ch}\` is not one the guard reads`);
        const rest = w.slice(k + 1);
        const value = take(rest === '' ? undefined : rest);
        if (value === null) return bad(`\`-${ch}\` has no literal value`);
        r[kind].push(value);
        break;
      }
      continue;
    }
    r.pos.push(w);
  }
  return r;
}

// the text appears in the raw command between plain single quotes (`$'…'` is decoded by the parser's own reader, which may differ from the shell's)
function singleQuotedIn(raw, t) {
  const q = `'${t}'`;
  for (let at = raw.indexOf(q); at >= 0; at = raw.indexOf(q, at + 1)) if (raw[at - 1] !== '$') return true;
  return false;
}

// the checks both shapes share on a parsed command line; `host` picks the text rules
function psqlArgsRefusal(r, c, host) {
  for (const v of r.set) {
    const eq = v.indexOf('=');
    if (eq < 0 || !(SET_NAME.test(v.slice(0, eq)) || v.slice(0, eq) === 'ON_ERROR_STOP') || !SET_VALUE.test(v.slice(eq + 1))) return `the variable \`-v ${v}\` is not \`name=plain value\``;
  }
  if (r.pset.some((v) => v.toLowerCase().startsWith('p'))) return 'a `-P` pager setting';
  for (const t of r.command) {
    // written single-quoted in the raw command: no `$`, backtick or quote can change it between what the guard read and what runs
    if (/['$`]/.test(t) || !singleQuotedIn(String(c.raw), t)) return `a \`-c\` text that is not written single-quoted without \`$\`, a backtick or a quote (\`${t.slice(0, 40)}\`)`;
    const why = psqlTextRefusal(t, { host });
    if (why) return `the \`-c\` text holds ${why}`;
  }
  return null;
}

// the strict host URI: `postgresql://user[:pw]@127.0.0.1|localhost|[::1]:port/db`, no query, no percent-encoding, one host
function strictLocalUri(v) {
  if (!v.startsWith('postgresql://')) return false;
  for (const ch of v) if (!(isNameChar(ch) || ch === '.' || ch === ':' || ch === '@' || ch === '/' || ch === '[' || ch === ']' || ch === '-')) return false;
  if (!localDbUrl(v)) return false;
  const u = new URL(v);
  return u.port !== '' && u.pathname.length > 1;
}

// `&` that is not part of `2>&1` / `&>`: a background job or `&&` (the parser drops a trailing `&`)
const hasBareAmp = (text) => { for (let i = 0; i < text.length; i += 1) if (text[i] === '&' && text[i - 1] !== '>' && text[i + 1] !== '>') return true; return false; };

// rule 0: the command is the only one on the line, at depth 0, with nothing around it
function aloneRefusal(c, x) {
  if (x.depth > 0) return 'psql inside script text the guard reads again (a here-doc or piped shell, a script, eval, a held command line) cannot be judged';
  if (x.cmds.length !== 1) return 'the psql command is not the only command on the line (a separator, pipe, substitution or redirect-only command is around it)';
  if (c.pipe === true || stdinFed(c)) return 'the psql command is in a pipe';
  if (hasBareAmp(String(x.scanRaw ?? ''))) return 'the psql command is run in the background or joined with `&&`';
  if (Object.keys(c.env ?? {}).length) return 'the psql command carries an environment assignment';
  return null;
}

// the same string twice in a guarded argv, one copy quoted and one not, shares one literal verdict: refused when the string needs quoting to be literal
function repeatRefusal(argv) {
  const seen = new Set();
  for (const w of argv) {
    if (seen.has(w) && UNQUOTED_CHANGES.test(w)) return `the word \`${w.slice(0, 40)}\` appears twice`;
    seen.add(w);
  }
  return null;
}
const hasInputRedirect = (c) => (c.redirects ?? []).some((r) => String(r.op).startsWith('<') || r.fd === 0);

// -> reason | null. `p`: { aligned, cut, typed }
function hostPsqlRefusal(c, x, p) {
  const argv = c.argv;
  const lit = c.litWords ?? new Set();
  if (!lit.has(argv[0]) || !(argv[0] === 'psql' || argv[0].startsWith('/'))) return 'the psql program is not a plain literal `psql` or an absolute path';
  const prefixOk = p.aligned && (p.cut === 0 || (p.cut === 2 && p.typed[0] === 'timeout' && /^[0-9]+[smhd]?$/.test(p.typed[1])));
  if (!prefixOk) return 'psql is run through a wrapper or launcher (only a bare `timeout <seconds>` in front is read)';
  const args = argv.slice(1);
  if (args.length === 1 && ['--version', '-V', '--help', '-?'].includes(args[0]) && lit.has(args[0])) return null;
  const alone = aloneRefusal(c, x);
  if (alone) return alone;
  const dup = repeatRefusal(argv);
  if (dup) return dup;
  const r = parsePsqlArgs(args, lit);
  if (r.why) return `psql ${r.why}`;
  if (!r.norc) return 'psql is run without `-X` (a psqlrc can run `\\c` or shell escapes)';
  if (r.command.length === 0) return 'psql has no `-c` text for the guard to read';
  if (r.file.length || r.username.length) return 'psql reads a file or names a user outside the URI';
  const sources = [...r.dbname, ...r.pos];
  if (sources.length !== 1 || !strictLocalUri(sources[0])) return 'psql names no single plain localhost URI (`postgresql://user:pw@127.0.0.1:<port>/<db>`, no `?`, no `-h` / `-p` / `-U`, no `host=` word)';
  if (hasInputRedirect(c)) return 'psql reads input from a redirect or here-doc';
  const env = x.io.env ?? {};
  for (const n of ['PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE', 'PGSYSCONFDIR', 'PGOPTIONS']) if (Object.hasOwn(env, n)) return `the hook's environment sets ${n}, which can move the host`;
  return psqlArgsRefusal(r, c, true);
}

// ---- docker psql: the Docker endpoint is proven local from the files Docker itself reads ----
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function dockerEndpointRefusal(io) {
  const env = io.env ?? {};
  for (const n of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG']) if (Object.hasOwn(env, n)) return `the hook's environment sets ${n}, which can point docker at another daemon`;
  if (typeof io.readBytes !== 'function' || typeof io.home !== 'string' || io.home === '') return 'the guard cannot read the Docker config';
  const readJson = (file) => {
    const r = io.readBytes(file);
    if (r?.absent) return { absent: true };
    if (!r?.ok) return { why: `the guard could not read ${file}` };
    try { return { json: JSON.parse(strictUtf8.decode(r.ok)) }; } catch { return { why: `${file} is not valid UTF-8 JSON` }; }
  };
  const cfg = readJson(path.join(io.home, '.docker', 'config.json'));
  if (cfg.why) return cfg.why;
  if (cfg.absent) return null; // no config: the default context
  if (cfg.json === null || typeof cfg.json !== 'object' || Array.isArray(cfg.json)) return 'the Docker config is not a JSON object';
  const cur = cfg.json.currentContext;
  if (cur === undefined || cur === '' || cur === 'default') return null;
  if (typeof cur !== 'string') return 'the Docker config\'s currentContext is not a string';
  const meta = readJson(path.join(io.home, '.docker', 'contexts', 'meta', createHash('sha256').update(cur).digest('hex'), 'meta.json'));
  if (meta.why) return meta.why;
  if (meta.absent) return `the Docker context \`${cur}\` has no meta file the guard can read`;
  const hostName = meta.json?.Endpoints?.docker?.Host;
  const local = io.platform === 'win32' ? 'npipe:////./pipe/' : 'unix:///';
  if (typeof hostName !== 'string' || !hostName.startsWith(local)) return `the Docker context \`${cur}\` does not use a local socket`;
  return null;
}

function dockerPsqlRefusal(c, x, p) {
  const argv = c.argv;
  const lit = c.litWords ?? new Set();
  const alone = aloneRefusal(c, x);
  if (alone) return alone;
  if (argv[0] !== 'docker' || !p.aligned || p.cut !== 0) return 'docker is run through a wrapper or is not the plain `docker` command';
  if (!argv.every((w) => lit.has(w))) return 'a word of the docker line is not a plain literal';
  const dup = repeatRefusal(argv);
  if (dup) return dup;
  let i = 1;
  if (argv[i] === 'container') i += 1;
  if (argv[i] !== 'exec') return 'the docker subcommand is not `exec`';
  i += 1;
  let interactive = false;
  while (argv[i]?.startsWith('-')) {
    if (argv[i] !== '-i' && argv[i] !== '--interactive') return `the docker exec option \`${argv[i]}\` is not allowed (only \`-i\`)`;
    interactive = true;
    i += 1;
  }
  const container = argv[i];
  if (typeof container !== 'string' || !/^supabase_db_[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(container)) return 'the container is not a literal `supabase_db_<name>`';
  if (argv[i + 1] !== 'psql') return 'the program run in the container is not `psql`';
  const r = parsePsqlArgs(argv.slice(i + 2), lit);
  if (r.why) return `psql ${r.why}`;
  if (!r.norc) return 'psql is run without `-X` (a psqlrc inside the container can run `\\c`)';
  for (const v of [...r.dbname, ...r.username, ...r.pos]) if (!IDENT.test(v)) return `\`${v}\` is not a plain identifier`;
  if (r.dbname.length > 1 || r.username.length > 1 || r.pos.length > 2) return 'psql names a database or user more than once';
  if (r.file.length > 1 || (r.file.length === 1 && r.file[0] !== '-')) return 'psql reads a file other than stdin (`-f -`); a path would be inside the container';
  const bad = psqlArgsRefusal(r, c, false);
  if (bad) return bad;
  const endpoint = dockerEndpointRefusal(x.io);
  if (endpoint) return endpoint;
  const stdin = r.file.length === 1 || r.command.length === 0;
  const redirects = c.redirects ?? [];
  if (!stdin) {
    if (hasInputRedirect(c)) return 'psql is given input that it never reads (`-c` only); remove the redirect';
    return null;
  }
  if (!interactive) return 'psql reads stdin, so `docker exec` needs `-i` (without it nothing is forwarded)';
  const only = redirects[0];
  if (redirects.length !== 1 || only.op !== '<' || (only.fd !== null && only.fd !== undefined && only.fd !== 0) || typeof only.target !== 'string') return 'the line must hold exactly one redirect, a plain `<` from a literal file';
  if (only.target === '' || !/^[A-Za-z0-9_./@+=,-]+$/.test(only.target)) return `the input file \`${only.target}\` is not a plain literal path`;
  const file = path.resolve(x.io.cwd ?? process.cwd(), only.target);
  const got = typeof x.io.readBytes === 'function' ? x.io.readBytes(file) : null;
  if (!got?.ok) return `the guard could not read \`${only.target}\``;
  const bytes = got.ok;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return `\`${only.target}\` starts with a byte-order mark`;
  let text;
  try { text = strictUtf8.decode(bytes); } catch { return `\`${only.target}\` is not valid UTF-8`; }
  const why = psqlTextRefusal(text, { host: false });
  return why ? `\`${only.target}\` holds ${why}` : null;
}

// data-only commands (a small positive list): a family word after them is an operand, never a program. A bare word 0, nothing that runs a program, writes a file, reads stdin as the command line or sets env; git only with no global option
const PG_DATA = new Set(['rg', 'grep', 'egrep', 'fgrep', 'ag', 'ack', 'which', 'type', 'echo', 'printf', 'cat', 'head', 'tail', 'wc', 'ls']);
const PG_DATA_GIT = new Set(['commit', 'grep', 'log', 'show', 'diff', 'status', 'blame', 'ls-files']);
const pgDataOnly = (c, plain) => {
  if (!plain || runsProgram(c) || writesFile(c) || stdinFed(c) || Object.keys(c.env ?? {}).length) return false;
  const w = c.argv[0];
  return PG_DATA.has(w) || (w === 'git' && PG_DATA_GIT.has(c.argv[1]));
};
const F4_VERBS = new Set(['exec', 'cp', 'run', 'create', 'rename', 'commit']);

// -> reason | null
function pgFamilyRefusal(cmds, reading, scanRaw, lineText, wordsOf, io) {
  const token = PG_TOKEN.test(lineText);
  const sdb = SDB_TEXT.test(lineText);
  if (!token && !sdb) return null;
  const x = { cmds, scanRaw, io, depth: io.depth ?? 0 };
  if (token) {
    if (cmds.dqTrans === true) return 'the line holds a `$"…"` string the parser reads untranslated, next to a psql family word';
    if (reading.some((c) => stdinFed(c) && buildsProgram(c, () => true))) return '`xargs` / `parallel` builds a command from stdin and the line names a psql family program';
  }
  const infos = reading.map((c) => {
    const typed = typedWords(c);
    const cut = typed.length - c.argv.length;
    const aligned = cut >= 0 && c.argv.every((w, i) => typed[cut + i] === w);
    return { c, typed, cut, aligned, data: token && pgDataOnly(c, aligned && cut === 0) };
  });
  if (token) {
    // any NAME that can move a client (PGHOST …, DATABASE_URL, DOCKER_*) anywhere on a line with a family word, however it is set (`export PGHOST+=x`, `read PGHOST`, `${PGHOST:=x}`)
    const text = [String(scanRaw ?? ''), ...infos.filter((i) => !i.data).map((i) => i.c.raw)].join('\n');
    if (PG_ENV_NAME.test(text) || cmds.some((c) => Object.keys(c.env ?? {}).some((k) => PG_ENV_NAME.test(k)))) return 'the line names PG* / DATABASE_URL / DOCKER_* variables next to a psql family word';
  }
  for (const { c, typed, cut, aligned, data } of infos) {
    if (data) continue;
    const argv = c.argv;
    const own = wordsOf(c);
    if (token && (nonLiteralHead(argv) || nonLiteralHead(typed))) return 'the command is run through a variable on a line that names a psql family program';
    const p = { aligned, cut, typed };
    const name = commandName(argv[0]);
    if (name === 'psql') {
      const why = hostPsqlRefusal(c, x, p);
      if (why) return why;
      continue;
    }
    if (name === 'docker' && own.some(pgWord)) {
      const why = dockerPsqlRefusal(c, x, p);
      if (why) return `${why}; ${DOCKER_HINT}`;
      continue;
    }
    if (sdb && [...argv, ...typed].some((w) => commandName(w) === 'docker') && [...argv, ...typed].some((w) => F4_VERBS.has(w)) && [...argv, ...typed].some((w) => SDB_TEXT.test(w))) return `a docker line that runs, copies into or changes a \`supabase_db_*\` container (${DOCKER_HINT})`;
    if (!token || name === 'sed' || isPipelineBin(argv)) continue;
    const words = [...own, ...(aligned ? typed.slice(0, cut) : typed)];
    for (const [i, w] of words.entries()) {
      if (i < own.length && isInlineProgram(own, i)) continue;
      if (pgWord(w) || PG_TOKEN.test(w)) return `\`${w.slice(0, 40)}\` is a psql family program the guard does not know how to read here (a launcher, a quoted command string, or a client other than the two allowed psql shapes)`;
    }
  }
  return null;
}

// `scanRaw` is the line with the prose flags (commit message, PR body) masked; `wordsOf(cmd)` the words of one command without those prose values (a command inside `$(…)` or backticks in a prose value is its own command, so its words are still read)
// `reparse(text)` parses a quoted command string with the guard's own parser (same env and deadline as the outer parse, its own `bashState`); null = none given
// `io` ({ cwd, env, home, readBytes, platform, depth }): what the psql family reads from the world (the docker config, the SQL file); an absent seam refuses
export function findLiveDbCli(cmds, scanRaw, state, wordsOf = (c) => c.argv, reparse = null, io = {}) {
  const refuse = (why) => `live database: ${why}; ${OWNER_RUNS}.`;
  const reading = cmds.filter((c) => c.argv?.length);
  const lineText = [scanRaw, ...cmds.map((c) => c.raw)].join('\n');
  const pg = pgFamilyRefusal(cmds, reading, scanRaw, lineText, wordsOf, io);
  if (pg) return refuse(pg);
  // R10-F1: xargs / parallel append words from stdin that no reading shows; with a supabase token on the line the call cannot be judged
  let lineHead; // sbTokenHead(lineText), computed at most once
  const lineHeadOnce = () => (lineHead ??= sbTokenHead(lineText));
  if (reading.some((c) => stdinFed(c) && buildsProgram(c, lineHeadOnce)) && SB_TOKEN.test(lineText)) return refuse('`xargs` / `parallel` builds a command from stdin and the line names supabase');
  for (const c of reading) {
    const typed = typedWords(c);
    // B1: each reading carries its own data flag. The argv (the parser unwrapped npx / timeout / env …) is judged by its own word 0. The words as typed: when they end with the argv, only the stripped PREFIX is judged here (`env`, `timeout 30`, by its own word 0, F2); when the parser rewrote words, the whole typed reading is, by its word 0
    const data = isDataWords(c.argv);
    const readings = [[c.argv, data]];
    const cut = typed.length - c.argv.length;
    if (cut >= 0 && c.argv.every((w, i) => typed[cut + i] === w)) { if (cut > 0) readings.push([typed.slice(0, cut), isDataWords(typed)]); } else readings.push([typed, isDataWords(typed)]);
    for (const [words, isData] of readings) {
      for (const call of supabaseCalls(words, isData)) {
        const why = supabaseRefusal(call.rest, state);
        if (why) return refuse(why);
      }
    }
    for (const words of [c.argv, typed]) {
      const why = variableHeadRefusal(words, state);
      if (why) return refuse(why);
    }
    // B10: a quoted word that holds a command line is read again (a data command, sed and the pipeline's own CLI take prose)
    if (data || commandName(c.argv[0]) === 'sed' || isPipelineBin(c.argv)) continue;
    const own = wordsOf(c);
    for (const [i, w] of own.entries()) {
      if (!sbTokenHead(w) || isInlineProgram(own, i)) continue;
      const why = reparse ? reparsedRefusal(commandText(w), state, reparse, 1) : NESTED_UNREAD;
      if (why) return refuse(why);
    }
  }
  // the Management API: every mention on the line (prose flags of a commit or PR already masked; a variable holding the URL is still caught) must name a dev project's own routes, by a clean path
  const texts = [String(scanRaw ?? ''), ...cmds.map((c) => [...wordsOf(c), ...Object.values(c.env ?? {})].join(' '))];
  // a line made only of commands that make no request (a search, an echo) may mention the hostname; a substitution or pipe into anything else is its own command and keeps the line checked
  if (reading.length && reading.every(makesNoRequest)) return null;
  for (const text of texts) for (const m of text.matchAll(/api\.supabase\.com/gi)) {
    const after = text.slice(m.index + m[0].length);
    const ref = /^\/v1\/projects\/([a-z0-9]{20})\//.exec(after)?.[1];
    if (!ref || !isDevRef(ref, state) || !cleanApiPath(after)) return refuse('the line names the Supabase Management API (api.supabase.com) for something other than a dev project\'s own routes');
  }
  return null;
}
