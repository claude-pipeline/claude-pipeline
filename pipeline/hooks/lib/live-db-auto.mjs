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
import { REF_RE, autoEntry, dbRefsFile, readDbRefs } from './db-refs.mjs';
import { readMachineId, release, tryAcquire } from '../../lib/locks.mjs';
import { gh } from '../../lib/proc.mjs';
import { LIVE_DB_KIND, sha256Of, sqlCharProblem } from './live-db-go.mjs';
import { FUTURE_SKEW_MS, readRecords } from './owner-go.mjs';

export const LIVE_DB_CONSUMED_REL = '.claude/pipeline-state/owner-go/live-db-consumed';
export const LIVE_DB_ATTEMPTS_REL = '.claude/pipeline-state/owner-go/live-db-attempts';
const OWNER_GO_DIR_REL = '.claude/pipeline-state/owner-go';
export const MAX_GENERATIONS = 64;
export const AUTO_MIN_CLAIM_MS = 500; // the first create of a claim is not started with less than this left
export const AUTO_MAX_AGE_MS = 7 * 24 * 3600 * 1000; // a file merged longer ago than this needs the owner's go
export const AUTO_GH_TIMEOUT_MS = 6000;
export const AUTO_MIN_START_MS = 1500; // a GitHub call is not started with less than this left
const REGISTRY_LOCK_WAIT_MS = 1000; // the longest the final registry check waits for the owner's db-refs command (it holds the lock for a write, or for its GitHub call)
const REGISTRY_LOCK_POLL_MS = 25;
export const STEM_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;
export const AFTER_DEPLOY_RE = /pipeline:[ \t]*apply-after-deploy/i; // anywhere in the query: detection only, the bytes stay exact
const MAX_PR_FILE_PAGES = 30;
const GH_MAX_BUFFER = 8 * 1024 * 1024;
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

// ---- the auto check -----------------------------------------------------------------------------------------------------------------------

const GRAPHQL = `query($o:String!,$n:String!,$p:String!){ repository(owner:$o,name:$n){ nameWithOwner defaultBranchRef { name target { ... on Commit {
  oid file(path:$p){ object { ... on Blob { text isBinary isTruncated } } }
  history(path:$p, first:2){ nodes { oid committedDate associatedPullRequests(first:5){ nodes { number merged baseRefName
    baseRepository { nameWithOwner } mergeCommit { oid }
    files(first:100){ pageInfo { hasNextPage endCursor } nodes { path changeType } } } } } } } } } } }`;
const GRAPHQL_PAGE = `query($o:String!,$n:String!,$num:Int!,$after:String){ repository(owner:$o,name:$n){ pullRequest(number:$num){ files(first:100, after:$after){ pageInfo { hasNextPage endCursor }
  nodes { path changeType } } } } }`;

// The deploy proof for a file marked apply-after-deploy (#882), one call made as the last GitHub read before the claim. `D`: the fields of one deployment the proof reads.
const GRAPHQL_DEPLOY = `query($o:String!,$n:String!,$env:String!,$num:Int!){ repository(owner:$o,name:$n){ nameWithOwner
  defaultBranchRef { name target { oid } }
  environment(name:$env){ name latestCompletedDeployment { ...D } }
  deployments(environments:[$env], first:1, orderBy:{field:CREATED_AT, direction:DESC}){ nodes { ...D } }
  pullRequest(number:$num){ number merged mergedAt mergeCommit { oid } } } }
fragment D on Deployment { commitOid createdAt environment originalEnvironment latestEnvironment state creator { __typename login }
  latestStatus { state createdAt creator { __typename login } } }`;

const notEligible = (reason) => ({ status: 'not-eligible', reason });
const NO_TIME = { status: 'no-time', reason: 'not enough time was left to check: try the call again' };
const sameRepo = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Every consumed go of this ref that names this SQL or this name, whatever wrote it: a go consumed by a guard that wrote no history (a rollback to the previous release, or a go that landed
// while `on` imported) also means the migration was attempted. -> { spent: consumedAt } | { error: { path, reason } } | { noTime: true } | {}
function consumedAttempt({ home, ref, name, sqlSha256, leftMs, io = {} }) {
  const dir = dirOf(home, LIVE_DB_CONSUMED_REL);
  const lstat = io.lstatSync ?? lstatSync;
  const read = io.readFileSync ?? readFileSync;
  let names;
  try {
    if (!lstat(dir).isDirectory()) return { error: { path: dir, reason: 'is not a real folder' } };
    names = (io.readdirSync ?? readdirSync)(dir).filter((n) => n.endsWith('.json')).sort();
  } catch (err) {
    if (err?.code === 'ENOENT') return {};
    return { error: { path: dir, reason: `cannot be read (${err?.code ?? 'error'})` } };
  }
  for (const n of names) {
    if (outOfTime(leftMs)) return { noTime: true };
    const file = path.join(dir, n);
    let b;
    try {
      const st = lstat(file);
      if (!st.isFile() || st.size > MAX_BODY_READ) return { error: { path: file, reason: 'is not a regular file of a usable size' } };
      b = JSON.parse(read(file, 'utf8'));
    } catch (err) {
      return { error: { path: file, reason: err instanceof SyntaxError ? 'is empty or not valid JSON' : `cannot be read (${err?.code ?? 'error'})` } };
    }
    if (!isObj(b) || typeof b.op !== 'string' || typeof b.projectRef !== 'string') return { error: { path: file, reason: 'does not hold a consumed go' } };
    // (as the importer: a migration marker of this project with no usable SQL hash may be the only record of an earlier apply)
    if (b.op === 'migration' && b.projectRef === ref && (typeof b.sqlSha256 !== 'string' || !SHA_RE.test(b.sqlSha256))) return { error: { path: file, reason: 'does not hold a consumed migration go (no usable SQL hash)' } };
    if (b.op === 'migration' && b.projectRef === ref && (b.sqlSha256 === sqlSha256 || b.name === name)) return { spent: typeof b.consumedAt === 'string' ? b.consumedAt : 'an unknown time' };
  }
  return {};
}

// One gh call, bounded by what is left. -> { json } | { stop: <result of autoApply> }
function ask(args, { env, io, leftMs }) {
  const left = typeof leftMs === 'function' ? leftMs() : Infinity;
  if (!(left >= AUTO_MIN_START_MS)) return { stop: NO_TIME };
  let r;
  try {
    r = (io.gh ?? gh)(['api', '--hostname', 'github.com', 'graphql', ...args], { env, timeoutMs: Math.floor(Math.min(AUTO_GH_TIMEOUT_MS, left)), maxBuffer: GH_MAX_BUFFER });
  } catch {
    return { stop: notEligible('GitHub could not be asked (gh did not run)') };
  }
  if (r?.timedOut) return { stop: notEligible('GitHub did not answer in time') };
  if (r?.overBuffer) return { stop: notEligible('GitHub\'s answer was larger than the guard reads') };
  if (r?.code !== 0) return { stop: notEligible(`GitHub could not be asked (gh exit ${r?.code})`) };
  let json;
  try { json = JSON.parse(r.stdout); } catch { return { stop: notEligible('GitHub\'s answer is not JSON') }; }
  if (!isObj(json) || 'errors' in json || !isObj(json.data)) return { stop: notEligible('GitHub\'s answer holds errors or no data') };
  return { json };
}

// The change a PR made to `file`, from the first answer's files and, while `hasNextPage`, further pages. -> 'ADDED' | 'other' | 'absent' | { stop }
function prFileChange(pr, file, { owner, repoName, env, io, leftMs }) {
  let page = pr.files;
  for (let i = 0; i < MAX_PR_FILE_PAGES; i += 1) {
    if (!isObj(page) || !Array.isArray(page.nodes) || !isObj(page.pageInfo)) return 'absent';
    const hit = page.nodes.find((f) => isObj(f) && f.path === file);
    if (hit) return hit.changeType === 'ADDED' ? 'ADDED' : 'other';
    if (page.pageInfo.hasNextPage !== true || typeof page.pageInfo.endCursor !== 'string') return 'absent';
    const got = ask(['-f', `query=${GRAPHQL_PAGE}`, '-f', `o=${owner}`, '-f', `n=${repoName}`, '-F', `num=${pr.number}`, '-f', `after=${page.pageInfo.endCursor}`], { env, io, leftMs });
    if (got.stop) return { stop: got.stop };
    page = got.json.data?.repository?.pullRequest?.files;
  }
  return 'absent';
}

// Has GitHub shown that the production deploy of the merge commit succeeded? Both the newest deployment of the environment (by any creator) and GitHub's latest COMPLETED one must be the merge
// commit, made by the registered bot, ACTIVE with a SUCCESS status by the same bot; the PR of the answer must be the matched one, merged after the registration. Every refusal claims nothing, so the call can be
// made again once the deploy has finished. -> { facts } | { stop: <result of autoApply> }
function deployProof({ entry, pr, commit, committed, head, branchName, owner, repoName, env, io, leftMs, now }) {
  const got = ask(['-f', `query=${GRAPHQL_DEPLOY}`, '-f', `o=${owner}`, '-f', `n=${repoName}`, '-f', `env=${entry.deployEnv}`, '-F', `num=${pr.number}`], { env, io, leftMs });
  if (got.stop) return got;
  const no = (why) => ({ stop: notEligible(`the production deploy is not confirmed (${why}): wait for the deploy to finish and call again, or ask for the owner's go`) });
  const repo = got.json.data.repository;
  const e = entry.deployEnv;
  const short = (s) => (typeof s === 'string' && s !== '' ? s.slice(0, 12) : 'unknown');
  if (!isObj(repo) || !sameRepo(repo.nameWithOwner, entry.repo)) return no(`GitHub answered for ${isObj(repo) ? repo.nameWithOwner : 'no repository'} instead of ${entry.repo}`);
  // the file was read from this head of this branch: a default branch that moved since (a corrective merge), or another branch made the default at the same commit (the PR's base no longer matches), so the call is made again
  if (typeof head !== 'string' || repo.defaultBranchRef?.target?.oid !== head || repo.defaultBranchRef?.name !== branchName) return no('the default branch moved during the check: call again');
  const p = repo.pullRequest;
  if (!isObj(p) || p.number !== pr.number || p.merged !== true || p.mergeCommit?.oid !== commit.oid) return no('GitHub does not show the pull request as merged at this commit');
  const mergedAt = typeof p.mergedAt === 'string' && ISO_RE.test(p.mergedAt) ? Date.parse(p.mergedAt) : NaN;
  if (!Number.isFinite(mergedAt)) return no('the pull request has no readable merge time');
  // the registration time is GitHub's own clock (the Date of its answer when the owner registered); the command writes it first as pending and finishes it only when GitHub's clock, read after that write, is within a minute of it, so every merge before the write is before deploySince + 1 minute and the margin covers that and the rounding of both times to the second: a merge that close to it keeps the owner's go too
  if (!(mergedAt >= Date.parse(entry.deploySince) + FUTURE_SKEW_MS)) return no(`the pull request was merged before the after-deploy registration of ${entry.deploySince} (or within ${FUTURE_SKEW_MS / 60000} minutes after it), so it keeps the owner's go`);
  if (!isObj(repo.environment) || repo.environment.name !== e) return no(`GitHub shows no deployment environment named "${e}"`);
  const newest = Array.isArray(repo.deployments?.nodes) && repo.deployments.nodes.length === 1 ? repo.deployments.nodes[0] : null;
  const live = repo.environment.latestCompletedDeployment;
  if (!isObj(newest) && !isObj(live)) return no(`GitHub shows no deployment in "${e}" yet`);
  const judge = (d, what) => {
    if (!isObj(d)) return `${what} is missing`;
    if (d.environment !== e || d.originalEnvironment !== e || d.latestEnvironment !== e) return `${what} is for another environment`;
    if (d.commitOid !== commit.oid) return `${what} is commit ${short(d.commitOid)}, not the merge commit ${short(commit.oid)}`;
    if (d.state !== 'ACTIVE') return `${what} is ${typeof d.state === 'string' ? d.state.toLowerCase() : 'in an unknown state'}, not active`;
    const bot = (c) => isObj(c) && c.__typename === 'Bot' && typeof c.login === 'string' && c.login.toLowerCase() === entry.deployBot;
    if (!bot(d.creator)) return `${what} was not made by ${entry.deployBot}[bot]`;
    const s = d.latestStatus;
    if (!isObj(s) || s.state !== 'SUCCESS') return `${what} has not succeeded (status ${isObj(s) && typeof s.state === 'string' ? s.state.toLowerCase() : 'none'})`;
    if (!bot(s.creator)) return `the status of ${what} was not set by ${entry.deployBot}[bot]`;
    const at = typeof s.createdAt === 'string' && ISO_RE.test(s.createdAt) ? Date.parse(s.createdAt) : NaN;
    if (!Number.isFinite(at) || at < committed || at > now() + FUTURE_SKEW_MS) return `the success time of ${what} is not credible`;
    return null;
  };
  const bad = judge(newest, 'the newest deployment') ?? judge(live, 'the deployment GitHub shows as live');
  if (bad !== null) return no(bad);
  return { facts: { afterDeploy: true, deployEnv: e, deployedAt: newest.latestStatus.createdAt } };
}

// The registry lock the owner's db-refs writes take (commands/db-refs.mjs: name `db-refs`, the registry's own `locks` folder), waited for at most REGISTRY_LOCK_WAIT_MS and never past the call's time. -> the lock | null
function takeRegistryLock({ home, leftMs, io = {} }) {
  const stateDir = path.dirname(dbRefsFile(home));
  const wait = Math.min(io.registryLockWaitMs ?? REGISTRY_LOCK_WAIT_MS, typeof leftMs === 'function' ? leftMs() - AUTO_MIN_CLAIM_MS : Infinity);
  if (!(wait > 0)) return null;
  const started = performance.now();
  for (;;) {
    try {
      const r = tryAcquire('db-refs', { dir: path.join(stateDir, 'locks'), machineId: readMachineId({ stateDir }) });
      if (r.acquired) return r.lock;
    } catch {
      return null;
    }
    if (performance.now() - started >= wait) return null;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, REGISTRY_LOCK_POLL_MS);
  }
}

// Is this migration a file a merged PR added to the registered repo's default branch, identical to the call, recent, and not attempted before? Then the next attempt generation of both keys is claimed.
// -> { status: 'claimed', facts } | { status: 'not-eligible' | 'spent' | 'error' | 'no-time', reason } (`reason` is one plain sentence; never a throw)
export function autoApply({ home, entry, name, query, session, now, leftMs, env, io = {} }) {
  try {
    return autoCheck({ home, entry, name, query, session, now, leftMs, env, io });
  } catch {
    return { status: 'error', reason: 'the auto-apply check failed unexpectedly' };
  }
}

function autoCheck({ home, entry, name, query, session, now, leftMs, env, io }) {
  // a marked file waits for the production deploy when the owner registered it (`pipeline db-refs after-deploy on`: all three keys); otherwise it keeps the owner's click after the deploy
  const marked = AFTER_DEPLOY_RE.test(query);
  const keyed = typeof entry.deployEnv === 'string' && typeof entry.deployBot === 'string' && typeof entry.deploySince === 'string';
  const registered = keyed && entry.deployClock === 'github';
  if (marked && keyed && entry.deployClock === 'pending') return notEligible('the after-deploy registration did not finish (the owner\'s `pipeline db-refs after-deploy on` was cut off or GitHub could not be asked): the owner runs it again; until then a marked file takes the owner\'s go');
  if (marked && keyed && !registered) return notEligible('the after-deploy registration was made by an earlier version of the pipeline, with this machine\'s clock: the owner runs `pipeline db-refs after-deploy on` again (GitHub\'s clock is used now); until then a marked file takes the owner\'s go');
  if (marked && !registered) return notEligible('the file is marked apply-after-deploy: it takes the owner\'s go after the deploy (the owner can register the production deploy with `pipeline db-refs after-deploy on`, and marked files then apply once GitHub shows it succeeded)');
  if (typeof name !== 'string' || !STEM_RE.test(name)) return notEligible('the migration name is not a plain file name');
  const charProblem = sqlCharProblem(query);
  if (charProblem !== null) return notEligible(charProblem);
  const sqlSha256 = sha256Of(query);
  const h = history({ home, ref: entry.ref, name, sqlSha256, leftMs, io });
  if (h.status === 'no-time') return NO_TIME;
  if (h.status === 'error') return { status: 'error', reason: `the attempt history ${h.path} cannot be read (${h.reason}), so nothing is applied; the owner looks at it` };
  const spent = (at) => ({ status: 'spent', reason: `auto-apply was already attempted for ${name} on this machine at ${at}: check the live state read-only, then ask for the owner's go` });
  if (h.name.n > 0 || h.sql.n > 0) return spent(new Date(Math.max(h.name.at, h.sql.at)).toISOString());
  const c = consumedAttempt({ home, ref: entry.ref, name, sqlSha256, leftMs, io });
  if (c.noTime) return NO_TIME;
  if (c.error) return { status: 'error', reason: `the consumed-go record ${c.error.path} cannot be read (${c.error.reason}), so nothing is applied; the owner looks at it` };
  if (c.spent) return spent(c.spent);
  const [owner, repoName, ...extra] = String(entry.repo).split('/');
  if (!owner || !repoName || extra.length > 0) return notEligible(`the registry's repo "${entry.repo}" is not owner/name`);
  const file = `supabase/migrations/${name}.sql`;
  const first = ask(['-f', `query=${GRAPHQL}`, '-f', `o=${owner}`, '-f', `n=${repoName}`, '-f', `p=${file}`], { env, io, leftMs });
  if (first.stop) return first.stop;
  const repo = first.json.data.repository;
  if (!isObj(repo)) return notEligible(`GitHub does not know the repository ${entry.repo} (renamed or moved? the owner updates the registry)`);
  if (!sameRepo(repo.nameWithOwner, entry.repo)) return notEligible(`GitHub answered for ${repo.nameWithOwner} instead of ${entry.repo}`);
  const branch = repo.defaultBranchRef;
  if (!isObj(branch) || typeof branch.name !== 'string' || !isObj(branch.target)) return notEligible('GitHub shows no default branch for the repository');
  const blob = branch.target.file?.object;
  if (!isObj(blob) || typeof blob.text !== 'string' || blob.isBinary !== false || blob.isTruncated !== false) return notEligible(`${file} is not on the default branch of ${entry.repo} as a whole text file`);
  if (!Buffer.from(query, 'utf8').equals(Buffer.from(blob.text, 'utf8'))) return notEligible(`the query is not byte for byte the file ${file} on the default branch`);
  const nodes = branch.target.history?.nodes;
  if (!Array.isArray(nodes) || nodes.length !== 1 || !isObj(nodes[0])) return notEligible(`${file} was not added by exactly one commit on the default branch (it was edited, or re-added)`);
  const commit = nodes[0];
  const committed = typeof commit.committedDate === 'string' && ISO_RE.test(commit.committedDate) ? Date.parse(commit.committedDate) : NaN;
  if (typeof commit.oid !== 'string' || commit.oid === '' || !Number.isFinite(committed)) return notEligible('the commit that added the file has no readable date');
  const t = now();
  if (committed > t + FUTURE_SKEW_MS) return notEligible('the commit that added the file is dated in the future');
  if (t - committed > AUTO_MAX_AGE_MS) return notEligible('the file was merged more than 7 days ago: it takes the owner\'s go');
  if (!(committed >= Date.parse(entry.autoSince))) return notEligible('the file was merged before auto-apply was switched on for this project: it takes the owner\'s go');
  const prs = commit.associatedPullRequests?.nodes;
  let pr = null;
  for (const p of Array.isArray(prs) ? prs : []) {
    if (!isObj(p) || p.merged !== true || p.baseRefName !== branch.name || !sameRepo(p.baseRepository?.nameWithOwner, entry.repo) || p.mergeCommit?.oid !== commit.oid || !Number.isInteger(p.number)) continue;
    const change = prFileChange(p, file, { owner, repoName, env, io, leftMs });
    if (change.stop) return change.stop;
    if (change === 'ADDED') { pr = p; break; }
  }
  if (pr === null) return notEligible(`no merged pull request of ${entry.repo} into ${branch.name} added ${file} (a direct push, a rename, a merge commit?)`);
  // the deploy proof is the LAST GitHub read before the claim: a rollback GitHub shows while the file pages above were read is seen
  let proven = {};
  if (marked) {
    const proof = deployProof({ entry, pr, commit, committed, head: branch.target.oid, branchName: branch.name, owner, repoName, env, io, leftMs, now });
    if (proof.stop) return proof.stop;
    proven = proof.facts;
  }
  const facts = { ref: entry.ref, name, sqlSha256, label: entry.name, file, repo: entry.repo, pr: pr.number, commit: commit.oid, head: typeof branch.target.oid === 'string' ? branch.target.oid : null, ...proven };
  // A marked file: the owner can switch the registration off while GitHub was asked, or just before the claim. The registry is read again under the registry lock the owner's db-refs writes take, and the lock is held until the claim is made,
  // so an `off` that finished earlier is seen and a later one waits (no GitHub call is made under the lock).
  let lock = null;
  let next;
  try {
    if (marked) {
      lock = takeRegistryLock({ home, leftMs, io });
      if (lock === null) return notEligible('the owner\'s db-refs command is changing the registry (or no time was left to wait for it): call again, or ask for the owner\'s go');
      const fresh = autoEntry(entry.ref, readDbRefs(home, io)).entry;
      if (!fresh || fresh.repo !== entry.repo || fresh.autoSince !== entry.autoSince || fresh.deployEnv !== entry.deployEnv || fresh.deployBot !== entry.deployBot || fresh.deploySince !== entry.deploySince || fresh.deployClock !== entry.deployClock) return notEligible('the owner changed the after-deploy registration during the check: call again, or ask for the owner\'s go');
    }
    next = claimNext({ home, via: 'auto', session, now, facts, seen: h, leftMs, io });
  } finally {
    if (lock !== null) { try { release(lock); } catch { /* a failed release must not turn an allow into a throw; the lock goes stale with this process */ } }
  }
  if (next.status === 'claimed') {
    // The go path claims its marker and then re-reads the history; this side claims the generations and then re-reads the markers: in every interleaving one of the two sees the other.
    // The generations just created stay (they count as an attempt). A go consumed in the gap since the first scan: when the go's own claim wins it owns the apply; in one interleaving the go loses the generation claim too, both deny and the owner gives a new go (fail-safe).
    const late = consumedAttempt({ home, ref: entry.ref, name, sqlSha256, leftMs, io });
    // both generations exist from here: a denial says the attempt is used (a retry would only find it spent), never "try the call again"
    if (late.noTime) return { status: 'spent', reason: `auto-apply recorded its attempt at ${name} but ran out of time checking for a go consumed meanwhile, so nothing is applied: the attempt is used; check the live state read-only, then ask for the owner's go` };
    if (late.error) return { status: 'error', reason: `the consumed-go record ${late.error.path} cannot be read (${late.error.reason}), so nothing is applied; the attempt is used (it was recorded before this read): check the live state read-only, then ask for the owner's go; the owner looks at the record` };
    if (late.spent) return spent(late.spent);
    return { status: 'claimed', facts };
  }
  if (next.status === 'no-time') return NO_TIME;
  if (next.status === 'spent') return { status: 'spent', reason: `auto-apply was already attempted for ${name} on this machine just now (another call got there first): check the live state read-only, then ask for the owner's go` };
  return { status: 'error', reason: `the attempt could not be recorded (${next.reason}), so nothing is applied` };
}

// ---- the import of earlier go applies (the owner's terminal, `db-refs auto-migrations on`) --------------------------------------------------

// Reads every consumed marker of `dir` -> { markers: [{ id, consumedAt, consumedMs, sqlSha256, name }] of op migration and this ref } | { problem: { path, reason } }. An unreadable marker of ANY ref refuses.
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
    if (consumedMs === null || typeof body.sqlSha256 !== 'string' || !SHA_RE.test(body.sqlSha256)) return { problem: { path: file, reason: 'does not hold a consumed migration go (time or sha)' } };
    markers.push({ id: n.slice(0, -'.json'.length), consumedAt: body.consumedAt, consumedMs, sqlSha256: body.sqlSha256, name: typeof body.name === 'string' && body.name !== '' ? body.name : null });
  }
  return { markers };
}

// Every migration go of `ref` ever consumed on this machine becomes generation history: a go whose marker carries its name, or whose record is still there (matched by the marker's id), gives its name and SQL keys, one with
// neither gives the SQL key only and is listed in `unmatched`. A key is only advanced when its latest time is earlier than the apply's own, so running it again adds nothing.
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
      // the marker's own name (written by the claim) first; the session's record only for a marker from before it carried one
      const known = m.name ?? (rec && rec.sqlSha256 === m.sqlSha256 ? rec.name : null);
      if (known !== null) {
        imported.push({ name: known, sqlSha256: m.sqlSha256, consumedAt: m.consumedAt });
        applies.push({ ...m, name: known });
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
// `outcome`: 'attempted' when both files of the event exist (an allowed call, or one denied after the second file was written: its sync failed, time ran out, a consumed-go record could not be read, or a go was consumed meanwhile; the live state says whether it applied), 'reserved' when only one does (a lost race or a failed
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
    const row = { at, atIso: new Date(at).toISOString(), via: String(body.via ?? ''), ref: body.ref ?? null, label: body.label ?? null, name: body.name ?? null, file: body.file ?? null, pr: body.pr ?? null, commit: body.commit ?? null, repo: body.repo ?? null, session: body.session ?? null, generation: Number(m[3]), afterDeploy: body.afterDeploy === true ? true : null, deployEnv: typeof body.deployEnv === 'string' ? body.deployEnv : null, deployedAt: typeof body.deployedAt === 'string' ? body.deployedAt : null };
    if (ev.first === null || (m[1] === 'name' && ev.first.key !== 'name')) ev.first = { key: m[1], row };
    events.set(body.event, ev);
  }
  for (const ev of events.values()) {
    const { row } = ev.first;
    if (row.at < sinceMs) continue;
    out.events.push({ at: row.atIso, via: row.via, outcome: row.via === 'go-import' ? 'imported' : ev.files.size === 2 ? 'attempted' : 'reserved', ref: row.ref, label: row.label, name: row.name, file: row.file, pr: row.pr, commit: row.commit, repo: row.repo, session: row.session, generation: row.generation, afterDeploy: row.afterDeploy, deployEnv: row.deployEnv, deployedAt: row.deployedAt, _ms: row.at });
  }
  out.events.sort((a, b) => b._ms - a._ms);
  for (const e of out.events) delete e._ms;
  return out;
}
