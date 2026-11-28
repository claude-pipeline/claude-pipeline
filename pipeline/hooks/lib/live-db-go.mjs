// #262 (live-database guard, typed go): the block Claude shows the owner before a live Supabase change, the recorder that turns the owner's typed
// `go migration <name>` / `go data <sha12>` into a record, and the reader the guard claims from (lib/live-db-guard.mjs).
//
// The block is the LAST lines of the reply, nothing after (the closing line is the ask):
//   🗄️ LIVE database change — <label> (<ref>)
//   Migration <name> · <file> @ <head12>        |   Data fix
//   Statements: <kinds>   ⚠ <destructive>        (the ⚠ part only when there is one)
//   ```sql  <the WHOLE sql, always: no hidden lines>  ```
//   Claude's summary: <one line>
//   Live-DB <migration|data> · project <ref> · sql <sha256> · head <head40|-> · file <path|-> · repo <owner/name|-> · dir <abs top-level|->
//   🗄️ Apply to LIVE <label> — say "go migration <name>"      (data: say "go data <sha12>")
//
// Why a rebuild and not a parse: the assistant's text is the agent's own, so a harmless preview with the CORRECT hash of a destructive file would pass a parser. The recorder
// takes from the reply only the binding line and the summary, REBUILDS everything else (the SQL from git at the bound commit for a migration, the label from the owner's registry, the
// statement summary, the repo from the checkout's origin) with the one builder `present` uses, and compares it line by line (right-trimmed) with what the owner was shown.
// The claim (live-db-guard.mjs) runs the same rebuild again on the reply slot right before the verified prompt entry. The recorder never reads git in the hook's cwd (an owner session
// starts anywhere): only in the block's `dir`, after checking that it is an absolute real directory equal to its own top-level.
//
// The records live beside the merge records (owner-go/<session>.jsonl) as kind 'live-db-go'; the merge readers filter on kind, so nothing else sees them.
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { git } from '../../lib/git.mjs';
import { parseRemote } from '../../lib/remote-url.mjs';
import { REF_RE, isDevRef, readDbRefs } from './db-refs.mjs';
import { describeSql } from './sql-classify.mjs';
import {
  GO_PROMPT_MAX, SESSION_RE, accountHome, appendRecord, lastReply, notOwnerPrompt, notOwnerWords, parseGo, queuedAnswer, readRecords,
} from './owner-go.mjs';

export { parseGo };

export const LIVE_DB_KIND = 'live-db-go';
export const LIVE_DB_MAX_AGE_MS = 2 * 60 * 60 * 1000; // a go is used right after it is typed; a day-old one is more likely a mistake
export const MIGRATION_MAX_LINES = 300;
export const DATA_MAX_LINES = 60;
export const DATA_MAX_CHARS = 4000;
export const SUMMARY_MAX = 300;
const GIT_TIMEOUT_MS = 5000;
// The git reads of the block (checkedTopLevel, repoOf, blobAt) are the one choke point of every route to verifyBlock (the typed go, a click's block, click settling). A caller that has a time
// budget sets it for the whole decision: each read then gets min(5 s, what is left) and is not started under 1 ms (it throws, which every reader here turns into "unverified": a deny).
// Without a deadline the per-call 5 s is today's behaviour.
let gitLeftMs = null;
export function withGitDeadline(leftMs, fn) {
  const prev = gitLeftMs;
  gitLeftMs = typeof leftMs === 'function' ? leftMs : null;
  try {
    return fn();
  } finally {
    gitLeftMs = prev;
  }
}
function gitTimeout() {
  if (gitLeftMs === null) return GIT_TIMEOUT_MS;
  const left = Math.floor(Math.min(GIT_TIMEOUT_MS, gitLeftMs()));
  if (!(left > 0)) throw new Error('no time is left for a git read');
  return left;
}
const READ_WINDOW_MS = 24 * 60 * 60 * 1000;
const MIGRATION_FILE = /^supabase\/migrations\/[^/\u0000\n]+\.sql$/;
const MARK = '🗄️';

export const sha256Of = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const right = (l) => l.replace(/\s+$/, '');

// ---- the byte contract ------------------------------------------------------------------------------------------------------------

// control characters (other than tab and newline) and bidirectional-text controls: they can hide or reorder what the owner is shown
const HIDING_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

// The character rules of a migration file's text, shared with the auto-apply check (live-db-auto.mjs): empty, not valid UTF-8, a carriage return or NUL, a hiding character. -> a reason | null
export function sqlCharProblem(sql) {
  if (typeof sql !== 'string' || sql.trim() === '') return 'the file is empty';
  if (sql.includes('�')) return 'the file is not valid UTF-8';
  if (/[\r\u0000]/.test(sql)) return 'the file holds a carriage return or NUL (CRLF line ends): the owner applies it';
  if (HIDING_CHARS.test(sql)) return 'the file holds a control or bidirectional-text character (it could hide lines on screen): the owner applies it';
  return null;
}

// The SQL of a migration file as the guard hashes it: the text unchanged. Refused (a reason) when it is not valid UTF-8 (U+FFFD from the decode), holds \r or NUL, has a line starting
// with three backticks, indented or not (it would close the block's fence early), is empty or is longer than MIGRATION_MAX_LINES lines (the owner sees every line).
export function migrationSqlProblem(sql) {
  const chars = sqlCharProblem(sql);
  if (chars !== null) return chars;
  if (sql.split('\n').some((l) => /^\s*```/.test(l))) return 'a line of the file starts with three backticks (indented or not)';
  if (displayLines(sql).length > MIGRATION_MAX_LINES) return `the file is over ${MIGRATION_MAX_LINES} lines: too long to show in full; the owner applies it`;
  return null;
}

// Data SQL as `present` canonicalises it: one BOM stripped, trailing whitespace and newlines stripped. Returns { sql } or { problem }.
export function canonicalDataSql(text) {
  if (typeof text !== 'string') return { problem: 'the SQL is not text' };
  if (text.includes('�')) return { problem: 'the SQL is not valid UTF-8' };
  let sql = text.startsWith('﻿') ? text.slice(1) : text;
  sql = sql.replace(/\s+$/, '');
  if (sql === '') return { problem: 'the SQL is empty' };
  if (/[\r\u0000]/.test(sql)) return { problem: 'the SQL holds a carriage return or NUL' };
  const lines = sql.split('\n');
  if (lines.some((l) => /^\s*```/.test(l))) return { problem: 'a line of the SQL starts with three backticks (indented or not)' };
  if (HIDING_CHARS.test(sql)) return { problem: 'the SQL holds a control or bidirectional-text character (it could hide lines on screen)' };
  if (lines.some((l) => /\s$/.test(l))) return { problem: 'a line of the SQL ends with whitespace (it could not be copied byte for byte): remove it' };
  if (lines.length > DATA_MAX_LINES || sql.length > DATA_MAX_CHARS) return { problem: `a data fix is at most ${DATA_MAX_LINES} lines and ${DATA_MAX_CHARS} characters: make it a migration` };
  return { sql };
}

// the lines the fence shows: the file's lines, one trailing empty line (the final newline) dropped
function displayLines(sql) {
  const lines = sql.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// ---- #811: which migration names apply_migration may carry ------------------------------------------------------------------------------

// The CLI's own filename rule (`MigrationList.local`: `^([0-9]+)_(.*)\.sql$`; an EMPTY suffix like `0261_.sql` is still version 0261) decides what `supabase db push` reads as a version. `stem`: the name of an
// apply_migration call (no `.sql`). kind: `timestamp` = exactly 14 digits whose first 8 are a valid date YYYYMMDD (HHMMSS is not checked: EagleWatch uses it as a counter, `20260907240000_…`);
// `numbered` = any other digit run (DRMed's `0261_x.sql`); `none` = no digit run then `_`. `version` keeps leading zeros as text. -> { kind, version, name }
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const validDate = (d) => {
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(4, 6));
  const day = Number(d.slice(6, 8));
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return y >= 1 && m >= 1 && m <= 12 && day >= 1 && day <= (m === 2 && leap ? 29 : DAYS[m - 1]);
};
export function migrationVersionOf(basename, { stem = false } = {}) {
  const m = (stem ? /^([0-9]+)_(.*)$/s : /^([0-9]+)_(.*)\.sql$/s).exec(String(basename ?? ''));
  if (!m) return { kind: 'none', version: null, name: null };
  return { kind: m[1].length === 14 && validDate(m[1]) ? 'timestamp' : 'numbered', version: m[1], name: m[2] };
}
// the refusal text for a numbered migration (present, verifyBlock, the guard): `what` names the file or the migration
export const numberedMigrationReason = (what) => `${what} is a numbered migration: \`apply_migration\` would record a timestamp version and break \`supabase db push\`. The owner runs \`supabase db push\` by hand.`;

// ---- the block --------------------------------------------------------------------------------------------------------------------

export function statementsLine(sql) {
  const d = describeSql(sql);
  if (d.unparsed) return 'Statements: (not understood)   ⚠ UNPARSED';
  return `Statements: ${d.kinds.join(', ')}${d.destructive.length ? `   ⚠ ${d.destructive.join(', ')}` : ''}`;
}

// The single builder `present` and the recorder (and the claim) share. Returns the block as an array of lines.
export function buildBlock({ op, ref, label, name = null, file = null, head = null, repo = null, dir = null, sql, summary }) {
  const sha = sha256Of(sql);
  return [
    `${MARK} LIVE database change — ${label} (${ref})`,
    op === 'migration' ? `Migration ${name} · ${file} @ ${head.slice(0, 12)}` : 'Data fix',
    statementsLine(sql),
    '```sql',
    ...displayLines(sql),
    '```',
    `Claude's summary: ${summary}`,
    `Live-DB ${op} · project ${ref} · sql ${sha} · head ${head ?? '-'} · file ${file ?? '-'} · repo ${repo ?? '-'} · dir ${dir ?? '-'}`,
    op === 'migration' ? `${MARK} Apply to LIVE ${label} — say "go migration ${name}"` : `${MARK} Apply to LIVE ${label} — say "go data ${sha.slice(0, 12)}"`,
  ];
}

const BINDING = /^Live-DB (migration|data) · project ([a-z0-9]{20}) · sql ([0-9a-f]{64}) · head ([0-9a-f]{40}|-) · file (.+?) · repo ([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|-) · dir (.+)$/;
const SUMMARY_LINE = /^Claude's summary: (\S.*)$/;

// The label for a project the owner may be asked to apply to: its registered name, or `unregistered project <ref>`; null for a dev ref or a bad one.
export function liveLabel(ref, state) {
  if (typeof ref !== 'string' || !REF_RE.test(ref) || isDevRef(ref, state)) return null;
  return state.refs.find((e) => e.ref === ref)?.name ?? `unregistered project ${ref}`;
}

export const summaryProblem = (s) => (typeof s !== 'string' || s.trim() === '' ? 'the summary is empty' : /[\r\n\u0000-\u001f]/.test(s) || HIDING_CHARS.test(s) ? 'the summary must be one line without control characters' : s.length > SUMMARY_MAX ? `the summary is over ${SUMMARY_MAX} characters` : s !== s.trim() ? 'the summary has leading or trailing spaces' : null);

// ---- git, only in the block's dir --------------------------------------------------------------------------------------------------

// `dir` must be an absolute path to a real directory (not a symlink) equal to its own `git rev-parse --show-toplevel`. Returns the dir as given, or null.
// POSIX: the two strings must be identical. Windows: git prints `D:/a/x` while the dir may be `d:\a\x` or an 8.3 short name, so both are compared in their canonical (real,
// case-folded) form; the dir is still lstat-checked as given, and what the caller gets back (and rebuilds the block from) is the dir as shown.
export function checkedTopLevel(dir, io = {}) {
  try {
    if (typeof dir !== 'string' || !path.isAbsolute(dir) || dir.includes('\u0000')) return null;
    if (!lstatSync(dir).isDirectory()) return null;
    const top = (io.git ?? git)(['rev-parse', '--show-toplevel'], { cwd: dir, timeoutMs: gitTimeout() }).trim();
    if (top === dir) return dir;
    if ((io.platform ?? process.platform) !== 'win32') return null;
    const canon = (p) => (io.realpath ?? realpathSync.native)(path.resolve(p)).replaceAll('\\', '/').toLowerCase();
    return canon(top) === canon(dir) ? dir : null;
  } catch {
    return null;
  }
}

// owner/name of the checkout's origin remote, or null (the block then says `-`)
export function repoOf(dir, io = {}) {
  try {
    const url = (io.git ?? git)(['remote', 'get-url', 'origin'], { cwd: dir, timeoutMs: gitTimeout() }).trim();
    return parseRemote(url)?.slug ?? null;
  } catch {
    return null;
  }
}

// the file's text at `head`, or null when the commit or the file is missing
export function blobAt(dir, head, file, io = {}) {
  try {
    const g = io.git ?? git;
    g(['cat-file', '-e', `${head}:${file}`], { cwd: dir, timeoutMs: gitTimeout() });
    return g(['cat-file', 'blob', `${head}:${file}`], { cwd: dir, timeoutMs: gitTimeout() });
  } catch {
    return null;
  }
}

// ---- the shared rebuild ---------------------------------------------------------------------------------------------------------------

const NO_BLOCK_REASON = 'the reply does not end with a live-database block';
// What the typed go's reader says when it found no block (#916): the reply it reads is Claude's reply to the owner's OWN message; a block shown in a turn a background notice started is skipped.
const NO_BLOCK_GO_REASON = `${NO_BLOCK_REASON}: only a block in Claude's reply to the owner's own message is read, and a block shown in a turn started by a background notice, a task notification or a subagent hand-back does not count, so present it again at the end of this reply (the reply to the owner's go)`;

// Reads the block at the END of a reply and rebuilds it. { ok:true, fields } | { ok:false, reason }. `fields`: op, ref, label, name, sqlSha256, head, file, repo, dir, summary, sql.
// `home` is where the registry lives. `io.git` is a test seam.
export function verifyBlock(replyText, { home = accountHome(), io = {} } = {}) {
  const fail = (reason) => ({ ok: false, reason });
  const lines = String(replyText ?? '').replace(/\r\n/g, '\n').split('\n');
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.length < 9) return fail(NO_BLOCK_REASON);
  const n = lines.length;
  const bind = BINDING.exec(right(lines[n - 2]));
  if (!bind) return fail('the line before the closing line is not a Live-DB binding line');
  const sm = SUMMARY_LINE.exec(right(lines[n - 3]));
  if (!sm) return fail('the line before the binding line is not "Claude\'s summary: …"');
  const summary = sm[1];
  if (summaryProblem(summary)) return fail(summaryProblem(summary));
  if (right(lines[n - 4]) !== '```') return fail('the SQL fence is not closed right above the summary');
  let open = -1;
  for (let i = n - 5; i >= 0; i--) if (lines[i].startsWith('```')) { open = i; break; }
  if (open < 3 || right(lines[open]) !== '```sql') return fail('no ```sql fence opens the SQL');
  const shown = lines.slice(open + 1, n - 4);
  const [, op, ref, sha, headRaw, fileRaw, repoRaw, dirRaw] = bind;

  const state = readDbRefs(home);
  if (!state.ok) return fail(`the owner's database registry is ${state.reason}`);
  const label = liveLabel(ref, state);
  if (label === null) return fail(`project ${ref} is declared dev: no go is needed or recorded for it`);

  let sql;
  let name = null;
  let head = null;
  let file = null;
  let repo = null;
  let dir = null;
  if (dirRaw !== '-') {
    dir = checkedTopLevel(dirRaw, io);
    if (dir === null) return fail('the dir in the binding line is not an absolute real top-level directory of a repository');
    repo = repoOf(dir, io);
  }
  if ((repoRaw === '-' ? null : repoRaw) !== repo) return fail('the repo in the binding line is not the checkout\'s origin');
  if (op === 'migration') {
    if (dir === null || headRaw === '-' || !MIGRATION_FILE.test(fileRaw)) return fail('a migration block needs a dir, a full head commit and a supabase/migrations/*.sql file');
    if (migrationVersionOf(path.posix.basename(fileRaw)).kind === 'numbered') return fail(numberedMigrationReason(fileRaw));
    head = headRaw;
    file = fileRaw;
    name = path.posix.basename(file, '.sql');
    sql = blobAt(dir, head, file, io);
    if (sql === null) return fail(`${file} does not exist at commit ${head.slice(0, 12)} in ${dir}`);
    const problem = migrationSqlProblem(sql);
    if (problem) return fail(problem);
    if (sha256Of(sql) !== sha) return fail('the bound hash is not the hash of the file at that commit');
  } else {
    if (headRaw !== '-' || fileRaw !== '-') return fail('a data block names no head and no file');
    sql = shown.join('\n');
    const canon = canonicalDataSql(sql);
    if (canon.problem) return fail(canon.problem);
    if (canon.sql !== sql) return fail('the fenced SQL is not in canonical form');
    if (sha256Of(sql) !== sha) return fail('the fenced SQL does not hash to the bound sha');
  }

  const built = buildBlock({ op, ref, label, name, file, head, repo, dir, sql, summary });
  const got = lines.slice(open - 3);
  if (got.length !== built.length) return fail('the block is not the block the pipeline builds (a different number of lines)');
  for (let i = 0; i < built.length; i++) {
    if (right(got[i]) !== right(built[i])) return fail(`block line ${i + 1} is not what the pipeline builds ("${right(got[i]).slice(0, 80)}")`);
  }
  return { ok: true, fields: { op, ref, label, name, sqlSha256: sha, head, file, repo, dir, summary, sql } };
}

// ---- the recorder -------------------------------------------------------------------------------------------------------------------

// What the hook's input amounts to: null (the prompt is no go), { record } (written) or { reason } (it reads as a go and nothing was recorded; the hook prints it so Claude presents again).
export function liveDbGoOutcome(input, { home = accountHome(), now = Date.now, io = {} } = {}) {
  try {
    const go = parseGo(input?.prompt);
    if (!go) return null;
    if (notOwnerPrompt(input)) return { reason: 'not the owner\'s prompt' };
    const session = String(input?.session_id ?? '');
    if (!SESSION_RE.test(session)) return { reason: 'no session id' };
    const transcript = String(input?.transcript_path ?? '');
    if (notOwnerWords(input, transcript)) return { reason: 'the prompt is not the owner\'s own words (a notice, a peer or a scheduled turn)' };
    if (queuedAnswer(input)) return { reason: 'the owner typed it while the agent was still working' };
    const prompt = String(input.prompt);
    if (prompt.length > GO_PROMPT_MAX) return { reason: 'the prompt is too long for a go' };
    const reply = lastReply(transcript, { prompt, skipSynthetic: true, liveDb: true }).text;
    const v = verifyBlock(reply, { home, io });
    if (!v.ok) return { reason: v.reason === NO_BLOCK_REASON ? NO_BLOCK_GO_REASON : v.reason };
    const f = v.fields;
    if (go.op !== f.op) return { reason: `the owner typed a ${go.op} go but the block asks for a ${f.op}` };
    const want = f.op === 'migration' ? f.name : f.sqlSha256.slice(0, 12);
    if (go.arg !== want) return { reason: `the typed "${go.arg}" is not "${want}"` };
    const record = {
      v: 1,
      kind: LIVE_DB_KIND,
      ts: new Date(now()).toISOString(),
      session,
      cwd: typeof input.cwd === 'string' ? input.cwd : null,
      op: f.op,
      projectRef: f.ref,
      sqlSha256: f.sqlSha256,
      name: f.name,
      head: f.head,
      file: f.file,
      repo: f.repo,
      prompt_sha256: createHash('sha256').update(prompt).digest('hex'),
      prompt_id: typeof input.prompt_id === 'string' && input.prompt_id !== '' ? input.prompt_id : null,
      transcript_path: transcript !== '' ? transcript : null,
      prompt,
    };
    const written = appendRecord(home, session, record);
    return written ? { record: written, label: f.label } : { reason: 'the record could not be written' };
  } catch {
    return { reason: 'the recorder failed' };
  }
}

export const recordLiveDbGo = (input, opts) => liveDbGoOutcome(input, opts)?.record ?? null;

// The session's recorded go records the guard may claim from: kind live-db-go, whose prompt_sha256 matches its prompt, deduplicated by prompt_id (a re-delivered hook writes the same
// prompt twice: first wins). `settle: false`: the guard must not write anything while reading. The 2 h age is judged by the claim from the transcript entry's own timestamp, not here.
export function liveDbRecords({ home = accountHome(), session, now = Date.now } = {}) {
  const seen = new Set();
  const out = [];
  for (const r of readRecords({ home, session, now, maxAgeMs: READ_WINDOW_MS, settle: false })) {
    if (r.kind !== LIVE_DB_KIND || typeof r.prompt !== 'string') continue;
    if (createHash('sha256').update(r.prompt).digest('hex') !== r.prompt_sha256) continue;
    if (typeof r.prompt_id === 'string' && r.prompt_id !== '') { if (seen.has(r.prompt_id)) continue; seen.add(r.prompt_id); }
    out.push(r);
  }
  return out;
}
