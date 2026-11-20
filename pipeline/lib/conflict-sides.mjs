// The files a reviewer WITHOUT a shell needs to judge a 'conflict' round (git.mjs#conflictReviewBase): every stage blob git recorded for the
// conflicted paths, read by OID (never `ref:path`: a renamed file's stage blob can live at another path), and the records as one text file.
// Shared by the substitute packet (commands/substitute.mjs) and Fable's input (commands/arbiter.mjs conflict-sides.md), so both read the same bytes.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { conflictRecordsSection } from './codex.mjs';
import { mergeTreeDetailed, revParse } from './git.mjs';

export const STAGE_NAMES = { 1: 'ancestor', 2: 'ours', 3: 'theirs' };
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// -> [{ path, stage, name, mode, oid, size, sha256, text: string | null (null: binary or not valid UTF-8) }] for every stage of every path in `conflicted`.
// The trial merge is made again from the round's own commits (full shas, the forced merge config), so this is a pure function of the round.
export function conflictBlobs({ from, forkPoint, conflicted }, o) {
  const want = new Set(conflicted);
  const merged = mergeTreeDetailed(revParse(`${from}^{commit}`, o), revParse(`${forkPoint}^{commit}`, o), o);
  const out = [];
  for (const c of merged.conflicts) {
    if (!want.has(c.path)) continue;
    for (const stage of [1, 2, 3]) {
      const e = c.stages[stage];
      if (!e) continue;
      const r = spawnSync('git', ['cat-file', 'blob', e.oid], { cwd: o?.cwd, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, GIT_NO_REPLACE_OBJECTS: '1' } });
      if (r.status !== 0) throw new Error(`could not read blob ${e.oid} of ${c.path}: ${String(r.stderr ?? '').trim()}`);
      let text = null;
      try { text = r.stdout.includes(0) ? null : new TextDecoder('utf-8', { fatal: true }).decode(r.stdout); } catch { text = null; }
      out.push({ path: c.path, stage, name: STAGE_NAMES[stage], mode: e.mode, oid: e.oid, size: r.stdout.length, sha256: sha256(r.stdout), text });
    }
  }
  return out;
}

// The records (one line each, data) plus the stage blobs that are not shown as text (binary): oid, size and sha256 in place of their bytes.
export function conflictRecordsText(records, blobs) {
  const binary = blobs.filter((b) => b.text === null);
  return [
    '# Conflict records',
    ...(conflictRecordsSection(records).length > 0 ? conflictRecordsSection(records) : ['', '(no conflict that is not plain text)']),
    '',
    '## Binary stage blobs (shown by oid, size and sha256, not as text)',
    ...(binary.length > 0 ? binary.map((b) => `${b.path} | stage ${b.stage} (${b.name}) | oid ${b.oid} | ${b.size} bytes | sha256 ${b.sha256}`) : ['(none)']),
    '',
  ].join('\n');
}
