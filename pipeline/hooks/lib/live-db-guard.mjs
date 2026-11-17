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
// not know is refused ("the owner runs it"). The psql family (psql, pg_dump…, usql, the pg utilities, PG* env) ships in B1b.
const OWNER_RUNS = 'the owner runs this; hand them the exact line';
const SB_WORD = /^supabase(?:@[^/\\]*)?$/;
const LAUNCHERS = new Set(['npx', 'bunx', 'pnpx', 'pnpm', 'yarn', 'npm', 'bun', 'corepack', 'xargs', 'env', 'nice', 'time', 'command', 'exec', 'nohup', 'sudo', 'timeout', 'watch']);
// subcommand prefixes (the words before the first flag): LOCAL_ONLY lines pass with no target flag or with `--local`; REMOTE_CAPABLE ones only with a local or `dev` target proof
const LOCAL_ONLY = [['start'], ['stop'], ['status'], ['init'], ['link'], ['unlink'], ['login'], ['logout'], ['db', 'reset'], ['db', 'diff'], ['db', 'lint'], ['migration', 'new'], ['migration', 'list'], ['migration', 'up'], ['test', 'db'], ['functions', 'serve'], ['functions', 'new'], ['projects', 'list'], ['orgs', 'list'], ['help']];
const REMOTE_CAPABLE = [['db', 'push'], ['db', 'pull'], ['db', 'dump'], ['migration', 'repair'], ['migration', 'squash'], ['migration', 'fetch'], ['functions', 'deploy'], ['functions', 'delete'], ['functions', 'download'], ['secrets'], ['storage'], ['branches'], ['config', 'push'], ['postgres-config'], ['sso'], ['domains'], ['vanity-subdomains'], ['ssl-enforcement'], ['inspect', 'db'], ['gen', 'types'], ['seed', 'buckets'], ['backups'], ['encryption'], ['snippets']];
// package-manager verbs that only name the package (they do not run a binary), and `command -v|-V`
const PM_HEADS = new Set(['pnpm', 'yarn', 'npm', 'bun', 'corepack']);
const NON_RUN_VERBS = new Set(['install', 'i', 'add', 'remove', 'rm', 'uninstall', 'update', 'upgrade', 'ls', 'list', 'why', 'view', 'info', 'outdated']);
const startsWith = (tokens, prefix) => prefix.every((w, i) => tokens[i] === w);
const BOOL_FLAGS = new Set(['yes', 'debug', 'help', 'experimental', 'include-all', 'include-roles', 'include-seed', 'data-only', 'role-only', 'use-copy', 'keep-comments', 'no-verify-jwt', 'use-api', 'use-docker', 'legacy-bundle', 'prune', 'no-seed', 'use-migra', 'use-pgadmin', 'use-pg-schema', 'no-backup']);
const NON_LITERAL = /[\s$`*?[\]{}()~\\<>|;&'"!#]/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// a literal postgres URI whose host (after WHATWG parsing) is exactly localhost / 127.0.0.1 / ::1, with no query string
function localDbUrl(v) {
  if (v.includes('?') || (v.match(/@/g) ?? []).length > 1) return false;
  let u;
  try { u = new URL(v); } catch { return false; }
  return (u.protocol === 'postgresql:' || u.protocol === 'postgres:') && LOCAL_HOSTS.has(u.hostname) && u.search === '' && u.hash === '';
}

// -> { rest } (the argv after the supabase word) | { refuse } | null (not a supabase line)
function supabaseCall(argv) {
  const head = commandName(argv[0]);
  if (SB_WORD.test(head)) return { rest: argv.slice(1) };
  if (!LAUNCHERS.has(head)) return null;
  if (head === 'npx' || head === 'bunx' || head === 'pnpx') {
    const i = argv.findIndex((w, k) => k > 0 && !w.startsWith('-'));
    if (i > 0 && SB_WORD.test(commandName(argv[i]))) return { rest: argv.slice(i + 1) };
  } else if (['pnpm', 'yarn', 'npm'].includes(head) && (argv[1] === 'dlx' || argv[1] === 'exec') && argv[2] !== undefined && SB_WORD.test(commandName(argv[2]))) {
    return { rest: argv.slice(3) };
  }
  if (PM_HEADS.has(head) && NON_RUN_VERBS.has(argv[1])) return null;
  if (head === 'command' && (argv[1] === '-v' || argv[1] === '-V')) return null;
  if (argv.slice(1).some((w) => SB_WORD.test(commandName(w)))) return { refuse: `\`${argv[0]}\` runs supabase in a shape the guard does not read (only \`supabase\`, \`npx\`, \`pnpm dlx|exec\`, \`bunx\`, \`yarn dlx|exec\` are)` };
  return null;
}

function supabaseRefusal(rest, state) {
  const first = rest[0];
  if (first === undefined) return null; // bare `supabase` prints help
  const sub = [];
  for (const w of rest) { if (w.startsWith('-')) break; sub.push(w); }
  if (!sub.length) return ['--version', '--help', '-h', '-v'].includes(first) ? null : `\`supabase ${first}\` leads with a flag, which is not a shape the guard knows`;
  const local = LOCAL_ONLY.some((p) => startsWith(sub, p));
  const remote = REMOTE_CAPABLE.some((p) => startsWith(sub, p)) || /^network-/.test(sub[0]);
  if (!local && !remote) return `\`supabase ${sub.join(' ')}\` is not a subcommand the guard knows`;
  // flag hygiene: each target flag once, in one form, with a literal value
  // `--local` / `--dry-run` / `--db-url` / `--project-ref` prove a safe target only when they are real flags: before a `--`, and not the value of another option (an option the guard does not know may take the next word as its value)
  const seen = { 'db-url': [], 'project-ref': [], linked: [], local: [], 'dry-run': [] };
  const real = { local: 0, 'dry-run': 0, 'db-url': 0, 'project-ref': 0 };
  let terminated = false;
  let swallowed = false;
  for (let i = sub.length; i < rest.length; i += 1) {
    const w = rest[i];
    if (w === '--') { terminated = true; continue; }
    const isValue = swallowed;
    swallowed = false;
    const m = /^--([a-z-]+)(=(.*))?$/s.exec(w);
    if (m?.[1] === 'remote') return '`--remote` selects a remote database';
    if (!m || !(m[1] in seen)) {
      if (w.startsWith('-') && !w.includes('=') && !(m && BOOL_FLAGS.has(m[1]))) swallowed = true;
      continue;
    }
    if (m[1] === 'linked' || m[1] === 'local' || m[1] === 'dry-run') {
      if (m[2] !== undefined) return `\`${w}\` is not the bare \`--${m[1]}\` flag`;
      seen[m[1]].push(true);
      if (m[1] !== 'linked' && !terminated && !isValue) real[m[1]] += 1;
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
  const isLocal = seen.local.length === 1 && real.local === 1;
  const linked = seen.linked.length === 1;
  if (isLocal && (linked || dbUrl !== undefined || projectRef !== undefined)) return '`--local` is combined with a remote target flag';
  if (linked && (dbUrl !== undefined || projectRef !== undefined)) return '`--linked` is combined with another target flag';
  if (dbUrl !== undefined && projectRef !== undefined) return '`--db-url` is combined with `--project-ref`';
  for (const v of [dbUrl, projectRef]) if (v !== undefined && NON_LITERAL.test(v.replace('@[::1]:', '@:'))) return `the target value \`${v}\` is not a literal`;
  const hasTarget = linked || dbUrl !== undefined || projectRef !== undefined;
  if (local && !hasTarget) return null;
  if (isLocal) return null;
  if (dbUrl !== undefined && real['db-url'] === 1 && localDbUrl(dbUrl)) return null;
  if (projectRef !== undefined && real['project-ref'] === 1 && isDevRef(projectRef, state)) return null;
  if (sub[0] === 'db' && sub[1] === 'push' && seen['dry-run'].length === 1 && real['dry-run'] === 1) return null;
  for (const name of ['db-url', 'project-ref']) if (seen[name].length === 1 && real[name] === 0) return `the \`--${name}\` follows \`--\` or an option that may take it as its value; put the target flag first`;
  const what = dbUrl !== undefined ? 'a `--db-url` that is not a plain localhost URI'
    : projectRef !== undefined ? `\`--project-ref ${projectRef}\`, which the owner has not declared dev`
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

// `scanRaw` is the line with the prose flags (commit message, PR body) masked; `wordsOf(cmd)` the words of one command without those prose values (a command inside `$(…)` or backticks in a prose value is its own command, so its words are still read)
export function findLiveDbCli(cmds, scanRaw, state, wordsOf = (c) => c.argv) {
  const refuse = (why) => `live database: ${why}; ${OWNER_RUNS}.`;
  for (const c of cmds) {
    if (!c.argv?.length) continue;
    const call = supabaseCall(c.argv);
    if (!call) continue;
    const why = call.refuse ?? supabaseRefusal(call.rest, state);
    if (why) return refuse(why);
  }
  // the Management API: every mention on the line (prose flags of a commit or PR already masked; a variable holding the URL is still caught) must name a dev project's own routes, by a clean path
  const texts = [String(scanRaw ?? ''), ...cmds.map((c) => [...wordsOf(c), ...Object.values(c.env ?? {})].join(' '))];
  for (const text of texts) for (const m of text.matchAll(/api\.supabase\.com/gi)) {
    const after = text.slice(m.index + m[0].length);
    const ref = /^\/v1\/projects\/([a-z0-9]{20})\//.exec(after)?.[1];
    if (!ref || !isDevRef(ref, state) || !cleanApiPath(after)) return refuse('the line names the Supabase Management API (api.supabase.com) for something other than a dev project\'s own routes');
  }
  return null;
}
