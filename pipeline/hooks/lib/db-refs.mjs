// #262 (live-database guard): the owner's registry of Supabase projects, `<home>/.claude/pipeline-state/db-refs.json`.
// Shape { v:1, refs:[{ref, name, repo, kind:'live'|'dev', autoMigrations?, autoSince?, deployEnv?, deployBot?, deploySince?}], servers:[<MCP server segment>…] }. Written ONLY by the owner, from their own terminal
// (`pipeline db-refs set|remove|server …`, commands/db-refs.mjs); the guard protects the file (files-policy.mjs PROTECTED_REL) and refuses the command to an agent.
// Every hosted project counts as LIVE unless the owner declared it `dev` here. A project that is not listed is live too, so a MISSING file is the safe default
// and needs no test of where the agent stands. A file that cannot be read or is not valid denies every Supabase write (no go can help) until the owner fixes it.
// `servers` lists extra MCP server names the owner trusts for Supabase, and only on such a server does a `dev` declaration exempt a call (an untrusted
// or project-scoped server could ignore `project_id`).
import fs from 'node:fs';
import path from 'node:path';
import { insideClaudeCode } from '../../lib/owner-only.mjs';

export const DB_REFS_REL = '.claude/pipeline-state/db-refs.json';
export const REF_RE = /^[a-z0-9]{20}$/;
// MCP server segments (the part of `mcp__<segment>__<tool>`) trusted without being listed: the Supabase plugin's own and the bare name
export const BUILTIN_SERVERS = ['plugin_supabase_supabase', 'supabase'];
const SEGMENT_RE = /^[A-Za-z0-9_.-]{1,80}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const NAME_MAX = 120;
// a strict ISO time with a zone (the time `auto-migrations on` set the flag)
export const ISO_ZONE_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/;
// the owner's registration of which GitHub deployment means "production" (#882): the environment name (exact, case-sensitive; Vercel's own is "Production – <project>" with an en dash)
// and the bot login of the GitHub App that makes those deployments, without the [bot] suffix
export const DEPLOY_ENV_MAX = 100;
export const DEPLOY_BOT_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;
export const validDeployEnv = (v) => typeof v === 'string' && v.length >= 1 && v.length <= DEPLOY_ENV_MAX && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(v);
export const validDeployBot = (v) => typeof v === 'string' && DEPLOY_BOT_RE.test(v) && v !== 'github-actions';
const isoZone = (v) => typeof v === 'string' && ISO_ZONE_RE.test(v) && Number.isFinite(Date.parse(v));

export const dbRefsFile = (home) => path.join(home, ...DB_REFS_REL.split('/'));

const validEntry = (e) => e && typeof e === 'object' && !Array.isArray(e)
  && typeof e.ref === 'string' && REF_RE.test(e.ref)
  && typeof e.name === 'string' && e.name.length > 0 && e.name.length <= NAME_MAX && !/[\r\n\u0000]/.test(e.name)
  && (e.repo === undefined || e.repo === null || (typeof e.repo === 'string' && REPO_RE.test(e.repo)))
  && (e.kind === 'live' || e.kind === 'dev')
  // the owner's auto-apply switch: absent or a boolean; true only on a live entry with a repo and the time it was set. An older install reads a newer file by ignoring the keys it does not know.
  && (e.autoMigrations === undefined || typeof e.autoMigrations === 'boolean')
  && (e.autoMigrations !== true || (e.kind === 'live' && typeof e.repo === 'string' && isoZone(e.autoSince)))
  // the after-deploy registration: all three keys or none, only with the auto switch on; github-actions is no trusted deployer (an agent can make a workflow create a deployment for any commit). An older install ignores the keys.
  && ((e.deployEnv === undefined && e.deployBot === undefined && e.deploySince === undefined)
    || (e.autoMigrations === true && validDeployEnv(e.deployEnv) && validDeployBot(e.deployBot) && isoZone(e.deploySince)));

// { ok:true, refs, servers } | { ok:true, refs:[], servers:[], missing:true } | { ok:false, reason:'unreadable'|'invalid' }
// `io.readFileSync` is the test seam.
export function readDbRefs(home, io = {}) {
  const read = io.readFileSync ?? fs.readFileSync;
  let text;
  try {
    text = read(dbRefsFile(home), 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: true, refs: [], servers: [], missing: true };
    return { ok: false, reason: 'unreadable' };
  }
  let j;
  try { j = JSON.parse(text); } catch { return { ok: false, reason: 'invalid' }; }
  if (!j || typeof j !== 'object' || Array.isArray(j) || j.v !== 1 || !Array.isArray(j.refs)) return { ok: false, reason: 'invalid' };
  const servers = j.servers === undefined ? [] : j.servers;
  if (!Array.isArray(servers) || !servers.every((s) => typeof s === 'string' && SEGMENT_RE.test(s))) return { ok: false, reason: 'invalid' };
  if (!j.refs.every(validEntry) || new Set(j.refs.map((e) => e.ref)).size !== j.refs.length) return { ok: false, reason: 'invalid' };
  return { ok: true, refs: j.refs.map((e) => ({ ref: e.ref, name: e.name, repo: e.repo ?? null, kind: e.kind, autoMigrations: e.autoMigrations === true, autoSince: e.autoMigrations === true ? e.autoSince : null, deployEnv: e.deployEnv ?? null, deployBot: e.deployBot ?? null, deploySince: e.deploySince ?? null })), servers: [...servers] };
}

// The entry auto-apply may use for `ref`: live, with a repo, the flag on, and no OTHER enabled entry with the same repo (case-insensitive: one unambiguous target per repo).
// -> { entry } | { entry: null, reason: 'off' | 'ambiguous: <other ref> has the same repo' }
export function autoEntry(ref, state) {
  const refs = state?.refs ?? [];
  const entry = refs.find((e) => e.ref === ref);
  if (!entry || entry.kind !== 'live' || !entry.repo || entry.autoMigrations !== true) return { entry: null, reason: 'off' };
  const key = entry.repo.toLowerCase();
  const other = refs.find((e) => e.ref !== entry.ref && e.autoMigrations === true && typeof e.repo === 'string' && e.repo.toLowerCase() === key);
  return other ? { entry: null, reason: `ambiguous: ${other.ref} has the same repo` } : { entry };
}

export const isDevRef = (ref, state) => (state?.refs ?? []).some((e) => e.ref === ref && e.kind === 'dev');

export const trustedServer = (segment, state) => typeof segment === 'string' && (BUILTIN_SERVERS.includes(segment) || (state?.servers ?? []).includes(segment));

// What a call's `project_id` means. `unknown` = no well-formed ref (absent, null, malformed, a project-scoped server): live and unbindable.
// `dev` only when the owner declared the ref dev AND listed the server the call came through; everything else is `live`.
// -> { kind: 'live'|'dev'|'unknown', ref, label, trusted }
export function targetOf(projectId, state, serverSegment) {
  const trusted = trustedServer(serverSegment, state);
  if (typeof projectId !== 'string' || !REF_RE.test(projectId)) return { kind: 'unknown', ref: null, label: 'unknown project', trusted };
  const entry = (state?.refs ?? []).find((e) => e.ref === projectId);
  const listed = typeof serverSegment === 'string' && (state?.servers ?? []).includes(serverSegment);
  const label = entry ? entry.name : `unregistered project ${projectId}`;
  return { kind: entry?.kind === 'dev' && listed ? 'dev' : 'live', ref: projectId, label, trusted };
}

// Atomic write: tmp file + rename, 0600. Throws on any failure. Used by the owner's command only.
// #683: refuses inside Claude Code, on the REAL environment and process tree (owner-only.mjs), so a scratch script that imports this library cannot rewrite the registry (the hook cannot see a file's imports).
// commands/db-refs.mjs checks first and gives the friendly message; this is the backstop for every other caller.
export function writeDbRefs(home, state) {
  const inside = insideClaudeCode(process.env);
  if (inside) throw new Error(`the database registry is written only from the owner's own terminal (${inside}); run \`pipeline db-refs set|remove|server\` there`);
  const file = dbRefsFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const refs = state.refs.map((e) => {
    if (e.autoMigrations === true && !isoZone(e.autoSince)) throw new Error(`entry ${e.ref} has auto-migrations on without a valid autoSince`);
    const deploy = e.autoMigrations === true && e.deployEnv != null && e.deployBot != null && e.deploySince != null;
    if (deploy && !(validDeployEnv(e.deployEnv) && validDeployBot(e.deployBot) && isoZone(e.deploySince))) throw new Error(`entry ${e.ref} has an invalid after-deploy registration`);
    return { ref: e.ref, name: e.name, repo: e.repo ?? null, kind: e.kind, ...(e.autoMigrations === true ? { autoMigrations: true, autoSince: e.autoSince } : {}), ...(deploy ? { deployEnv: e.deployEnv, deployBot: e.deployBot, deploySince: e.deploySince } : {}) };
  });
  const body = `${JSON.stringify({ v: 1, refs, servers: state.servers ?? [] }, null, 2)}\n`;
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, body, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
  return file;
}
