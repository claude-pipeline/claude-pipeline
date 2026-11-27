// Auto-apply of merged migrations (docs/specs/2026-11-27-auto-apply-migrations-design.md): the attempt history of the live-database guard and the one writer of its markers.
//
// Two folders under ~/.claude/pipeline-state/owner-go/ (the protected tree):
//  - live-db-consumed/  one marker per consumed go (claimGoMarker): the go is spent, whatever happens next.
//  - live-db-attempts/  for a project whose owner switched auto-apply on: per migration two keys, each a GENERATION sequence of exclusive-create files,
//    `name-<id>-<n>.json` (id from the project and the migration name) and `sql-<id>-<n>.json` (id from the project and the sha256 of the SQL), n = 1, 2, ...
//    Every allowed apply (go or auto) creates the NEXT generation of BOTH keys, so one apply advances one durable record per name and per SQL: a second call that saw
//    the same generations loses the exclusive create, and an older go cannot pass the freshness rule after a later attempt. A lone file (its partner missing) is a
//    reservation from a lost race or a failed write; it counts as an attempt.
//
// This module is the only writer. It exports no generic writer: every export derives its folder, its file names (hashes) and its body itself, so no caller can create
// the registry or any other protected file through it, and every marker it can create only ever withholds an allow. A tripwire, not a boundary (the boundary is the
// agent not holding prod credentials).
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeSync } from 'node:fs';
import path from 'node:path';
import { insideClaudeCode } from '../../lib/owner-only.mjs';
import { REF_RE } from './db-refs.mjs';
import { LIVE_DB_KIND } from './live-db-go.mjs';
import { readRecords } from './owner-go.mjs';

export const LIVE_DB_CONSUMED_REL = '.claude/pipeline-state/owner-go/live-db-consumed';
export const LIVE_DB_ATTEMPTS_REL = '.claude/pipeline-state/owner-go/live-db-attempts';
const OWNER_GO_DIR_REL = '.claude/pipeline-state/owner-go';
export const MAX_GENERATIONS = 64;
export const AUTO_MIN_CLAIM_MS = 500; // the first create of a claim is not started with less than this left
const OPEN_EXCL = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
const WIN_FOLDER_FSYNC = ['EISDIR', 'EINVAL', 'EPERM'];
const MAX_BODY_READ = 64 * 1024;
const ISO_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const FILE_RE = /^(name|sql)-([0-9a-f]{32})-([1-9]\d*)\.json$/;
const FACT_MAX = 600;

const sha = (text) => createHash('sha256').update(text).digest('hex');
const nameId = (ref, name) => sha(`name|${ref}|${name}`).slice(0, 32);
const sqlId = (ref, sqlSha256) => sha(`sql|${ref}|${sqlSha256}`).slice(0, 32);
const dirOf = (home, rel) => path.join(home, ...rel.split('/'));
const isoOf = (v) => (typeof v === 'string' && ISO_RE.test(v) && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);
const outOfTime = (leftMs) => typeof leftMs === 'function' && !(leftMs() > 0);

// ---- the private writer -------------------------------------------------------------------------------------------------------------------

// fsync a folder. POSIX: any failure is false. win32: a folder cannot be opened for fsync (EISDIR / EPERM / EINVAL), tolerated: NTFS journals the metadata.
function syncDir(dir, io = {}) {
  const open = io.openSync ?? openSync;
  const sync = io.fsyncSync ?? fsyncSync;
  const close = io.closeSync ?? closeSync;
  const win = (io.platform ?? process.platform) === 'win32';
  let fd;
  try {
    fd = open(dir, constants.O_RDONLY);
  } catch (err) {
    return win && WIN_FOLDER_FSYNC.includes(err?.code);
  }
  try {
    sync(fd);
    return true;
  } catch (err) {
    return win && WIN_FOLDER_FSYNC.includes(err?.code);
  } finally {
    try { close(fd); } catch { /* the sync result stands */ }
  }
}

// Each folder from <home>/.claude down must be a real directory (a symlink would move the records elsewhere). -> { dir, parents } or null; `parents` are the folders that hold a folder this
// call created: createMarker fsyncs them after the file is created, so a failure there leaves the marker behind (spent), as any other failure after the exclusive create.
function durableDir(home, rel, io = {}) {
  const lstat = io.lstatSync ?? lstatSync;
  const mkdir = io.mkdirSync ?? mkdirSync;
  let p = home;
  const parents = [];
  for (const part of rel.split('/')) {
    const parent = p;
    p = path.join(p, part);
    let made = false;
    let st;
    try {
      st = lstat(p);
    } catch (err) {
      if (err?.code !== 'ENOENT') return null;
      // two claimers creating the folder at once: the loser's mkdir says EEXIST, fine when what is there is a real directory, checked just below
      try { mkdir(p, { mode: 0o700 }); } catch (e) { if (e?.code !== 'EEXIST') return null; }
      made = true;
      try { st = lstat(p); } catch { return null; }
    }
    if (!st.isDirectory()) return null;
    if (made) parents.push(parent);
  }
  return { dir: p, parents };
}

// Exclusive create, every byte written (a 0-byte write is an error), fsync the file, close, fsync the folder. -> 'claimed' | 'spent' (EEXIST) | 'error'. A leftover file after an error stays (it is spent).
// `io` ({openSync, writeSync, fsyncSync, closeSync, ...}) are the fault seams of the tests.
function createMarker({ dir, parents = [] }, file, body, io = {}) {
  const open = io.openSync ?? openSync;
  const write = io.writeSync ?? writeSync;
  const sync = io.fsyncSync ?? fsyncSync;
  const close = io.closeSync ?? closeSync;
  try {
    let fd;
    try {
      fd = open(path.join(dir, file), OPEN_EXCL, 0o600);
    } catch (err) {
      return err?.code === 'EEXIST' ? 'spent' : 'error';
    }
    try {
      const bytes = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
      let off = 0;
      while (off < bytes.length) {
        const n = write(fd, bytes, off, bytes.length - off);
        if (!(n > 0)) throw new Error('short write');
        off += n;
      }
      sync(fd);
    } finally {
      close(fd);
    }
    return [...parents, dir].every((d) => syncDir(d, io)) ? 'claimed' : 'error';
  } catch {
    return 'error';
  }
}

// ---- the go's consumed marker -------------------------------------------------------------------------------------------------------------

// `promptId` is the typed go's prompt id, or (`click`) the click's id: one go, one apply either way, and the two key spaces ('live-db' vs 'live-db-click') cannot collide.
const consumedId = (session, promptId, click) => sha(`${click ? 'live-db-click' : 'live-db'}|${session}|${promptId}`).slice(0, 32);

// -> 'claimed' | 'spent' | 'error'
export function claimGoMarker({ home, session, promptId, click = false, op, projectRef, name = null, sqlSha256, now, io = {} }) {
  try {
    const folder = durableDir(home, LIVE_DB_CONSUMED_REL, io);
    if (folder === null) return 'error';
    return createMarker(folder, `${consumedId(session, promptId, click)}.json`, { v: 1, consumedAt: new Date(now()).toISOString(), op, projectRef, sqlSha256, name }, io);
  } catch {
    return 'error';
  }
}

// ---- the generations ----------------------------------------------------------------------------------------------------------------------

// The attempts folder as a read finds it: 'missing' (no history), 'ok', or { path, reason }.
function attemptsFolder(home, io = {}) {
  const lstat = io.lstatSync ?? lstatSync;
  let p = home;
  for (const part of LIVE_DB_ATTEMPTS_REL.split('/')) {
    p = path.join(p, part);
    try {
      if (!lstat(p).isDirectory()) return { path: p, reason: 'is not a real folder' };
    } catch (err) {
      if (err?.code === 'ENOENT') return 'missing';
      return { path: p, reason: `cannot be read (${err?.code ?? 'error'})` };
    }
  }
  return 'ok';
}

// One key's generations: lstat `1 ... MAX_GENERATIONS + 1` (no directory search). -> { n, at } | { error: { path, reason } } | { noTime: true }.
// n = the highest present; `at` = the LATEST time over all its generations (a body's finite ISO `at`, else the file's mtime: empty, unparsable, partial). A folder, a symlink, a read
// error, a hole below n, or generation MAX_GENERATIONS + 1 is an error.
function probeKey(dir, prefix, id, { leftMs, io = {} }) {
  const lstat = io.lstatSync ?? lstatSync;
  const read = io.readFileSync ?? readFileSync;
  const present = [];
  let n = 0;
  let at = 0;
  for (let i = 1; i <= MAX_GENERATIONS + 1; i += 1) {
    if (outOfTime(leftMs)) return { noTime: true };
    const file = path.join(dir, `${prefix}-${id}-${i}.json`);
    let st;
    try {
      st = lstat(file);
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      return { error: { path: file, reason: `cannot be read (${err?.code ?? 'error'})` } };
    }
    if (!st.isFile()) return { error: { path: file, reason: 'is not a regular file' } };
    present[i] = true;
    n = i;
    let time = null;
    if (st.size > 0 && st.size <= MAX_BODY_READ) {
      let text;
      try { text = read(file, 'utf8'); } catch (err) { return { error: { path: file, reason: `cannot be read (${err?.code ?? 'error'})` } }; }
      try { time = isoOf(JSON.parse(text)?.at); } catch { /* unparsable: the file's own time */ }
    }
    at = Math.max(at, time ?? st.mtimeMs);
  }
  if (present[MAX_GENERATIONS + 1]) return { error: { path: path.join(dir, `${prefix}-${id}-${MAX_GENERATIONS + 1}.json`), reason: `is generation ${MAX_GENERATIONS + 1}: more attempts than the guard keeps` } };
  for (let i = 1; i < n; i += 1) if (!present[i]) return { error: { path: path.join(dir, `${prefix}-${id}-${i}.json`), reason: 'is missing below a later generation (a gap)' } };
  return { n, at };
}

// -> { status: 'ok', name: { n, at }, sql: { n, at } } | { status: 'error', path, reason } | { status: 'no-time' }
export function history({ home, ref, name, sqlSha256, leftMs, io = {} }) {
  try {
    if (!REF_RE.test(String(ref)) || typeof name !== 'string' || !SHA_RE.test(String(sqlSha256))) return { status: 'error', path: dirOf(home, LIVE_DB_ATTEMPTS_REL), reason: 'asked about a malformed migration' };
    if (outOfTime(leftMs)) return { status: 'no-time' };
    const folder = attemptsFolder(home, io);
    if (folder === 'missing') return { status: 'ok', name: { n: 0, at: 0 }, sql: { n: 0, at: 0 } };
    if (folder !== 'ok') return { status: 'error', path: folder.path, reason: folder.reason };
    const dir = dirOf(home, LIVE_DB_ATTEMPTS_REL);
    const out = {};
    for (const [key, prefix, id] of [['name', 'name', nameId(ref, name)], ['sql', 'sql', sqlId(ref, sqlSha256)]]) {
      const r = probeKey(dir, prefix, id, { leftMs, io });
      if (r.noTime) return { status: 'no-time' };
      if (r.error) return { status: 'error', path: r.error.path, reason: r.error.reason };
      out[key] = r;
    }
    return { status: 'ok', name: out.name, sql: out.sql };
  } catch (err) {
    return { status: 'error', path: dirOf(home, LIVE_DB_ATTEMPTS_REL), reason: `cannot be read (${err?.code ?? 'error'})` };
  }
}

// Only plain facts reach a body: short strings, numbers, booleans, null.
function plainFacts(facts) {
  const out = {};
  for (const [k, v] of Object.entries(facts)) {
    if (/^(v|event|pair|at|via|session)$/.test(k)) continue;
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[k] = v;
    else if (typeof v === 'string') out[k] = v.slice(0, FACT_MAX);
  }
  return out;
}

const generationFile = (prefix, id, n) => `${prefix}-${id}-${n}.json`;
const SEEN_OK = (s) => Number.isInteger(s?.name?.n) && s.name.n >= 0 && Number.isInteger(s?.sql?.n) && s.sql.n >= 0;

// Creates the NEXT generation of both keys for one allowed call. -> { status: 'claimed', event } | { status: 'spent', path } | { status: 'error' | 'no-time', reason }.
// `seen` is what `history` answered; an EEXIST on either file means another call got there first (the one already created stays: a reservation, counted as an attempt).
export function claimNext({ home, via, session, now, facts, seen, leftMs, io = {} }) {
  try {
    if (via !== 'auto' && via !== 'go') return { status: 'error', reason: 'unknown attempt kind' };
    if (facts === null || typeof facts !== 'object' || !REF_RE.test(String(facts.ref)) || !SHA_RE.test(String(facts.sqlSha256)) || typeof facts.name !== 'string' || facts.name.length > 1000) return { status: 'error', reason: 'the attempt facts are malformed' };
    if (!SEEN_OK(seen)) return { status: 'error', reason: 'the attempt history was not read' };
    if (seen.name.n + 1 > MAX_GENERATIONS || seen.sql.n + 1 > MAX_GENERATIONS) return { status: 'error', reason: `more than ${MAX_GENERATIONS} attempts are recorded for this migration` };
    if (typeof leftMs === 'function' && leftMs() < AUTO_MIN_CLAIM_MS) return { status: 'no-time', reason: 'not enough time was left to record the attempt' };
    const folder = durableDir(home, LIVE_DB_ATTEMPTS_REL, io);
    if (folder === null) return { status: 'error', reason: `the attempt history folder ${dirOf(home, LIVE_DB_ATTEMPTS_REL)} cannot be created or is not a real folder` };
    const { dir } = folder;
    const event = randomBytes(8).toString('hex');
    const nameFile = generationFile('name', nameId(facts.ref, facts.name), seen.name.n + 1);
    const sqlFile = generationFile('sql', sqlId(facts.ref, facts.sqlSha256), seen.sql.n + 1);
    const base = { ...plainFacts(facts), v: 1, event, at: new Date(now()).toISOString(), via, session: typeof session === 'string' ? session : null };
    let target = folder;
    for (const [file, pair] of [[nameFile, sqlFile], [sqlFile, nameFile]]) {
      const made = createMarker(target, file, { ...base, pair }, io);
      target = { dir };
      if (made === 'spent') return { status: 'spent', path: path.join(dir, file) };
      if (made !== 'claimed') return { status: 'error', reason: `the attempt record ${path.join(dir, file)} could not be written durably` };
    }
    return { status: 'claimed', event };
  } catch {
    return { status: 'error', reason: 'the attempt record could not be written' };
  }
}

// ---- the import of earlier go applies (the owner's terminal, `db-refs auto-migrations on`) --------------------------------------------------

// Reads every consumed marker of `dir` -> { markers: [{ id, consumedAt, consumedMs, sqlSha256 }] of op migration and this ref } | { problem: { path, reason } }. An unreadable marker of ANY ref refuses.
function consumedMarkers(home, ref) {
  const dir = dirOf(home, LIVE_DB_CONSUMED_REL);
  let names;
  try {
    if (!lstatSync(dir).isDirectory()) return { problem: { path: dir, reason: 'is not a real folder' } };
    names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
  } catch (err) {
    if (err?.code === 'ENOENT') return { markers: [] };
    return { problem: { path: dir, reason: `cannot be read (${err?.code ?? 'error'})` } };
  }
  const markers = [];
  for (const n of names) {
    const file = path.join(dir, n);
    let body;
    try {
      if (!lstatSync(file).isFile()) return { problem: { path: file, reason: 'is not a regular file' } };
      body = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      return { problem: { path: file, reason: err instanceof SyntaxError ? 'is empty or not valid JSON' : `cannot be read (${err?.code ?? 'error'})` } };
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body) || typeof body.op !== 'string' || typeof body.projectRef !== 'string') return { problem: { path: file, reason: 'does not hold a consumed go' } };
    if (body.op !== 'migration' || body.projectRef !== ref) continue;
    const consumedMs = isoOf(body.consumedAt);
    if (consumedMs === null || !SHA_RE.test(String(body.sqlSha256))) return { problem: { path: file, reason: 'does not hold a consumed migration go (time or sha)' } };
    markers.push({ id: n.slice(0, -'.json'.length), consumedAt: body.consumedAt, consumedMs, sqlSha256: body.sqlSha256 });
  }
  return { markers };
}

// Every migration go of `ref` ever consumed on this machine becomes generation history: a go whose record is still there (matched by the marker's id) gives its name and SQL keys, one whose
// record is gone gives the SQL key only and is listed in `unmatched`. A key is only advanced when its latest time is earlier than the apply's own, so running it again adds nothing.
// With `unmatched` non-empty and no `acceptUnmatched` nothing is written (`written: false`). Owner terminal only. -> { ok, written, imported: [{ name, sqlSha256, consumedAt }], unmatched: [{ sqlSha256, consumedAt }] } | { ok: false, path, reason }
export function importGoHistory({ home, ref, now = Date.now, acceptUnmatched = false, io = {} }) {
  const inside = insideClaudeCode(process.env);
  if (inside) return { ok: false, path: null, reason: `the history import is run only from the owner's own terminal (${inside})` };
  if (!REF_RE.test(String(ref))) return { ok: false, path: null, reason: 'the project reference is malformed' };
  try {
    const found = consumedMarkers(home, ref);
    if (found.problem) return { ok: false, ...found.problem };
    const problems = [];
    const records = readRecords({ home, session: null, now, maxAgeMs: Infinity, problems, settle: false });
    if (problems.length > 0) return { ok: false, path: dirOf(home, OWNER_GO_DIR_REL), reason: `a go record file cannot be read: ${problems[0]}` };
    const byId = new Map();
    for (const r of records) {
      if (r.kind !== LIVE_DB_KIND || r.op !== 'migration' || r.projectRef !== ref || typeof r.name !== 'string' || typeof r.session !== 'string') continue;
      if (r.via === 'ask' && typeof r.ask?.clickId === 'string') byId.set(consumedId(r.session, r.ask.clickId, true), r);
      else if (typeof r.prompt_id === 'string' && r.prompt_id !== '') byId.set(consumedId(r.session, r.prompt_id, false), r);
    }
    const imported = [];
    const unmatched = [];
    const applies = [];
    for (const m of found.markers.sort((a, b) => a.consumedMs - b.consumedMs || a.id.localeCompare(b.id))) {
      const rec = byId.get(m.id);
      if (rec && rec.sqlSha256 === m.sqlSha256) {
        imported.push({ name: rec.name, sqlSha256: m.sqlSha256, consumedAt: m.consumedAt });
        applies.push({ ...m, name: rec.name });
      } else {
        unmatched.push({ sqlSha256: m.sqlSha256, consumedAt: m.consumedAt });
        applies.push({ ...m, name: null });
      }
    }
    if (unmatched.length > 0 && !acceptUnmatched) return { ok: true, written: false, imported, unmatched };
    const folder = durableDir(home, LIVE_DB_ATTEMPTS_REL, io);
    const folderProblem = { ok: false, path: dirOf(home, LIVE_DB_ATTEMPTS_REL), reason: 'the attempt history folder cannot be created or is not a real folder' };
    if (folder === null) return folderProblem;
    const { dir } = folder;
    let target = folder; // (the first file written also syncs the parents of the folder this call created)
    for (const a of applies) {
      const keys = [['sql', sqlId(ref, a.sqlSha256)], ...(a.name === null ? [] : [['name', nameId(ref, a.name)]])];
      const event = randomBytes(8).toString('hex');
      const planned = [];
      for (const [prefix, id] of keys) {
        const r = probeKey(dir, prefix, id, { io });
        if (r.error) return { ok: false, ...r.error };
        if (r.at < a.consumedMs) planned.push({ prefix, id, n: r.n + 1 });
      }
      for (const p of planned) {
        if (p.n > MAX_GENERATIONS) return { ok: false, path: dir, reason: `more than ${MAX_GENERATIONS} attempts are recorded for one migration` };
        const pair = planned.find((q) => q !== p);
        const body = { v: 1, event, ...(pair ? { pair: generationFile(pair.prefix, pair.id, pair.n) } : {}), at: a.consumedAt, via: 'go-import', session: null, ref, name: a.name, sqlSha256: a.sqlSha256 };
        const written = createMarker(target, generationFile(p.prefix, p.id, p.n), body, io);
        target = { dir };
        if (written !== 'claimed') return { ok: false, path: path.join(dir, generationFile(p.prefix, p.id, p.n)), reason: written === 'spent' ? 'was created by another process during the import: run it again' : 'could not be written durably' };
      }
    }
    if (!folder.parents.every((d) => syncDir(d, io))) return folderProblem;
    return { ok: true, written: true, imported, unmatched };
  } catch (err) {
    return { ok: false, path: null, reason: `the import failed (${err?.code ?? err?.message ?? 'error'})` };
  }
}

// ---- the log reader -----------------------------------------------------------------------------------------------------------------------

// Every attempt file of the last `sinceMs` as EVENTS, newest first (best-effort parsing lives only here). -> { events, unreadable: [path] }
// `outcome`: 'attempted' when both files of the event exist (an allowed call: the session's effect check says whether it applied), 'reserved' when only one does (a lost race or a failed
// write: nothing was allowed), 'imported' for a go the owner's switch-on imported (nothing was allowed by it).
export function readAttemptLog({ home, sinceMs = 0, io = {} }) {
  const out = { events: [], unreadable: [] };
  const folder = attemptsFolder(home, io);
  if (folder === 'missing') return out;
  if (folder !== 'ok') { out.unreadable.push(folder.path); return out; }
  const dir = dirOf(home, LIVE_DB_ATTEMPTS_REL);
  const lstat = io.lstatSync ?? lstatSync;
  const read = io.readFileSync ?? readFileSync;
  let names;
  try { names = (io.readdirSync ?? readdirSync)(dir).sort(); } catch { out.unreadable.push(dir); return out; }
  const events = new Map();
  for (const n of names) {
    const m = FILE_RE.exec(n);
    if (!m) continue;
    const file = path.join(dir, n);
    let body = null;
    let mtime = 0;
    try {
      const st = lstat(file);
      if (!st.isFile()) { out.unreadable.push(file); continue; }
      mtime = st.mtimeMs;
      if (st.size > 0 && st.size <= MAX_BODY_READ) body = JSON.parse(read(file, 'utf8'));
    } catch { body = null; }
    if (body === null || typeof body !== 'object' || Array.isArray(body) || typeof body.event !== 'string' || body.event === '') { out.unreadable.push(file); continue; }
    const at = isoOf(body.at) ?? mtime;
    const ev = events.get(body.event) ?? { files: new Set(), first: null };
    ev.files.add(m[1]);
    const row = { at, atIso: new Date(at).toISOString(), via: String(body.via ?? ''), ref: body.ref ?? null, label: body.label ?? null, name: body.name ?? null, file: body.file ?? null, pr: body.pr ?? null, commit: body.commit ?? null, repo: body.repo ?? null, session: body.session ?? null, generation: Number(m[3]) };
    if (ev.first === null || (m[1] === 'name' && ev.first.key !== 'name')) ev.first = { key: m[1], row };
    events.set(body.event, ev);
  }
  for (const ev of events.values()) {
    const { row } = ev.first;
    if (row.at < sinceMs) continue;
    out.events.push({ at: row.atIso, via: row.via, outcome: row.via === 'go-import' ? 'imported' : ev.files.size === 2 ? 'attempted' : 'reserved', ref: row.ref, label: row.label, name: row.name, file: row.file, pr: row.pr, commit: row.commit, repo: row.repo, session: row.session, generation: row.generation, _ms: row.at });
  }
  out.events.sort((a, b) => b._ms - a._ms);
  for (const e of out.events) delete e._ms;
  return out;
}
