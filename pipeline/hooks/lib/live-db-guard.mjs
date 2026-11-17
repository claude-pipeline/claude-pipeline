// #262 (live-database guard): what the PreToolUse guard decides for a Supabase MCP call (files-policy.mjs evaluateMcp calls evaluateSupabaseMcp, LAST: after every other rule that could deny the same
// call, so no later deny burns a go). Every hosted project is LIVE unless the owner declared it `dev` (db-refs.mjs). On a live project the read tools pass; execute_sql passes only as a fixed
// catalog template (live-db-catalog.mjs); every other execute_sql and every apply_migration passes only with an owner go bound to the sha256 of the call's exact `query` (and the project, and for a
// migration the name), consumed AT THE ATTEMPT with an exclusive-create marker (a failed or interrupted apply needs a new go, and the live state must be checked read-only first).
//
// A tripwire, not a boundary: the boundary is the agent not holding prod credentials.
import { createHash } from 'node:crypto';
import { closeSync, constants, fsyncSync, openSync, writeSync } from 'node:fs';
import path from 'node:path';
import { FUTURE_SKEW_MS, promptEntryOf, promptTextOf, realDirChain, replyBefore } from './owner-go.mjs';
import { readDbRefs, targetOf } from './db-refs.mjs';
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
// a server whose name has `supabase` in it, or ANY server's tool with a Supabase write name (a renamed server in an unprotected .mcp.json: Fable F2)
export const isSupabaseTool = (tool) => typeof tool === 'string' && tool.startsWith('mcp__') && (/supabase/i.test(serverSegment(tool)) || SUPABASE_WRITE_NAMES.includes(lastSegment(tool)));

const deny = (reason) => ({ decision: 'deny', reason: `${PREFIX} ${reason}` });
const allow = () => ({ decision: 'allow', reason: '' });
const plain = (t) => String(t ?? '').replace(/\r\n/g, '\n').trim();

// ---- the claim ----------------------------------------------------------------------------------------------------------------------

// Exclusive-create marker, durable before it answers `claimed`: write, fsync the file, close, fsync the folder. Any failure -> 'error' (the leftover marker stays spent). EEXIST -> 'spent'.
// `io` ({openSync, writeSync, fsyncSync, closeSync}) are the fault seams of the tests.
function takeMarker({ home, session, promptId, op, projectRef, sqlSha256, now, io = {} }) {
  const id = createHash('sha256').update(`live-db|${session}|${promptId}`).digest('hex').slice(0, 32);
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
  const records = liveDbRecords({ home, session: sessionId, now })
    .filter((r) => r.op === op && r.projectRef === projectRef && r.sqlSha256 === sqlSha256 && (op !== 'migration' || r.name === name))
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  if (records.length === 0) return { status: 'none', reason: 'no go from the owner is recorded for this exact SQL, project and name in this session' };
  let first = null;
  let spent = false;
  for (const r of records) {
    const skip = (status, reason) => { first ??= { status, reason }; };
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
    const age = now() - Date.parse(found.entry.timestamp);
    if (!Number.isFinite(age) || age > LIVE_DB_MAX_AGE_MS || age < -FUTURE_SKEW_MS) { skip('expired', `the owner's go is older than ${LIVE_DB_MAX_AGE_MS / 3600000} hours (or from the future)`); continue; }
    const m = takeMarker({ home, session: sessionId, promptId: r.prompt_id, op, projectRef, sqlSha256, now, io });
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
    const ask = `Run \`${presentHint(op, target.ref)}\`, end the reply with its block and wait for the owner's typed go.`;
    const after = c.status === 'spent' || c.status === 'error' ? ' A used go is never reused: check the live state read-only (list_migrations or a catalog query) before asking for a new one.' : '';
    return deny(`${name} on ${where} needs the owner's go for exactly this query (${show(query)}${op === 'migration' ? `, name ${migName}` : ''}): ${c.reason}.${lookup} ${ask}${after}`);
  }
  return deny(`${name} is not allowed on the live database ${where}; the owner does this in the dashboard`);
}

