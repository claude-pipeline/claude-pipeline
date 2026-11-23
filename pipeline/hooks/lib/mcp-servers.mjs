// #687: what the ACTIVE Claude Code session's MCP configuration says a server name is (read only; asked only by live-db-guard.mjs supabaseMatch when a generic write name arrives on a server no other rule judged,
// so ordinary MCP traffic reads nothing here). Sources, and no others (not another account, not an unrelated `projects[*]` key):
//   user    the session's account file (`$CLAUDE_CONFIG_DIR/<account file>`, else `<home>/<account file>`), top-level `mcpServers`
//   local   the same file's `projects[k].mcpServers` for k = P and each ancestor of P (the key is the git root or the launch directory)
//   project `k/.mcp.json` for k = P and each ancestor of P
// P = `$CLAUDE_PROJECT_DIR` of the hook's environment. Unset (or not absolute) => the local and project layers are UNKNOWN. A file that exists but cannot be read, parsed, is not a regular file (no symlink follow) or is
// over 8 MB makes its layer UNKNOWN; so does a legacy `.config.json` next to the account file (its content is never read). Server names are compared normalised: every character outside [A-Za-z0-9_-] becomes `_`.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 8 * 1024 * 1024;
const ACCOUNT_FILE = '.claude.json';
const LEGACY_FILE = '.config.json';
const normalise = (name) => String(name).replace(/[^A-Za-z0-9_-]/g, '_');
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// -> { state: 'absent' } | { state: 'ok', value } | { state: 'unknown' }
// One open, then every check on that descriptor: a FIFO cannot block, only a regular file of at most MAX_BYTES is read. No symlink follow: O_NOFOLLOW where the platform has it, an lstat first where it does not (Windows);
// that lstat/open gap can only yield a file Claude Code itself would load.
function readJsonFile(file) {
  let fd;
  try {
    if (constants.O_NOFOLLOW === undefined && lstatSync(file).isSymbolicLink()) return { state: 'unknown' };
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (err) {
    return { state: err?.code === 'ENOENT' || err?.code === 'ENOTDIR' ? 'absent' : 'unknown' };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_BYTES) return { state: 'unknown' };
    const buf = Buffer.alloc(st.size + 1); // one byte more than the size: a file that grew since fstat is seen as over the limit
    let n = 0;
    while (n < buf.length) {
      const r = readSync(fd, buf, n, buf.length - n, null);
      if (r === 0) break;
      n += r;
    }
    if (n > st.size) return { state: 'unknown' };
    return { state: 'ok', value: JSON.parse(buf.toString('utf8', 0, n)) };
  } catch {
    return { state: 'unknown' };
  } finally {
    closeSync(fd);
  }
}

const exists = (file) => {
  try { lstatSync(file); return true; } catch (err) { return err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR'; }
};

const ancestorsOf = (dir) => {
  const out = [];
  for (let d = dir; ; d = path.dirname(d)) {
    out.push(d);
    if (path.dirname(d) === d) return out;
  }
};

// -> { layers: [{ layer: 'user'|'local'|'project', state: 'absent'|'found'|'unknown', entry? }] }; one record per matching entry.
export function activeBinding(segment, { home, env = {}, readFile = readJsonFile } = {}) {
  const layers = [];
  const matches = (servers) => (isObject(servers) ? Object.keys(servers).filter((k) => normalise(k) === segment).map((k) => servers[k]) : []);
  const add = (layer, servers) => {
    const found = matches(servers);
    if (found.length === 0) layers.push({ layer, state: 'absent' });
    for (const entry of found) layers.push({ layer, state: 'found', entry });
  };
  const unknown = (...names) => { for (const layer of names) layers.push({ layer, state: 'unknown' }); };

  const configDir = typeof env.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR !== '' ? env.CLAUDE_CONFIG_DIR : null;
  const accountFile = configDir ? path.join(configDir, ACCOUNT_FILE) : path.join(home, ACCOUNT_FILE);
  const legacy = [path.join(path.dirname(accountFile), LEGACY_FILE), ...(configDir ? [] : [path.join(home, '.claude', LEGACY_FILE)])].some(exists);
  const proj = typeof env.CLAUDE_PROJECT_DIR === 'string' && path.isAbsolute(env.CLAUDE_PROJECT_DIR) ? path.resolve(env.CLAUDE_PROJECT_DIR) : null;
  const dirs = proj ? ancestorsOf(proj) : [];

  const account = legacy ? { state: 'unknown' } : readFile(accountFile);
  if (account.state === 'unknown' || (account.state === 'ok' && !isObject(account.value))) {
    unknown('user', 'local');
  } else if (account.state === 'absent') {
    layers.push({ layer: 'user', state: 'absent' }, { layer: 'local', state: 'absent' });
  } else {
    add('user', account.value.mcpServers);
    if (!proj) unknown('local');
    else {
      const projects = isObject(account.value.projects) ? account.value.projects : {};
      const keyed = Object.keys(projects).filter((k) => path.isAbsolute(k) && dirs.includes(path.resolve(k)));
      if (keyed.length === 0) layers.push({ layer: 'local', state: 'absent' });
      for (const k of keyed) add('local', isObject(projects[k]) ? projects[k].mcpServers : undefined);
    }
  }
  if (!proj) {
    unknown('project');
    return { layers };
  }
  for (const d of dirs) {
    const f = readFile(path.join(d, '.mcp.json'));
    if (f.state === 'unknown' || (f.state === 'ok' && !isObject(f.value))) unknown('project');
    else if (f.state === 'absent') layers.push({ layer: 'project', state: 'absent' });
    else add('project', f.value.mcpServers);
  }
  return { layers };
}

const SUPABASE_HOSTS = new Set(['mcp.supabase.com', 'api.supabase.com']);
const PACKAGE = '@supabase/mcp-server-supabase';
const hostOf = (s) => { try { return new URL(s).hostname; } catch { return ''; } };
// `pkg@1.2.3` -> `pkg` (the leading `@` of a scope is not a version separator)
const withoutVersion = (s) => { const i = s.lastIndexOf('@'); return i > 0 && !s.slice(i).includes('/') ? s.slice(0, i) : s; };
// a Windows npm shim is `mcp-server-supabase.cmd` (also .exe, .ps1, .bat)
const isPackage = (s) => { const p = withoutVersion(s); return p === PACKAGE || p.split(/[\\/]/).some((c) => c.replace(/\.(cmd|exe|ps1|bat)$/i, '') === 'mcp-server-supabase'); };
// `mcp/supabase:tag`, `registry:5000/mcp/supabase@sha256:…`
const isImage = (s) => { const i = s.replace(/@.*$/, '').replace(/:[^/:]*$/, ''); return i === 'mcp/supabase' || i.endsWith('/mcp/supabase'); };

// a one-string launcher (`bash -lc "npx -y …"`, `cmd /c "…"`) carries the marker inside one word: test each whitespace- or quote-delimited token too
const tokensOf = (w) => [w, ...w.split(/[\s"'`;&|()]+/).filter(Boolean)];

// -> 'supabase' | 'other' | 'unresolved'
export function identify(entry) {
  if (!isObject(entry)) return 'unresolved';
  const url = entry.url;
  const command = entry.command;
  const args = entry.args === undefined ? [] : entry.args;
  if ((url !== undefined && typeof url !== 'string') || (command !== undefined && typeof command !== 'string') || !Array.isArray(args) || !args.every((a) => typeof a === 'string')) return 'unresolved';
  const words = [command, ...args].filter((w) => typeof w === 'string');
  const tokens = words.flatMap(tokensOf);
  if ([url, ...tokens].some((u) => typeof u === 'string' && SUPABASE_HOSTS.has(hostOf(u)))
    || tokens.some((w) => isPackage(w) || isImage(w))
    || (isObject(entry.env) && Object.hasOwn(entry.env, 'SUPABASE_ACCESS_TOKEN'))) return 'supabase';
  if (url === undefined && command === undefined) return 'unresolved';
  return [url, ...words].some((w) => typeof w === 'string' && w.includes('$')) ? 'unresolved' : 'other';
}
