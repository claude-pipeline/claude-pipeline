// Pure helpers for the time-weighted Windows shards: folding the per-file lines the preload writes, the marker lines CI prints
// around the result, the manifest that says which files a job was given, and the median over several runs
// (scripts/shard-weights.mjs writes scripts/lib/test-weights.json).
import { createHash } from 'node:crypto';

export const MARK_BEGIN = 'CP-FILE-TIMES-BEGIN';
export const MARK_END = 'CP-FILE-TIMES-END';
export const MANIFEST_BEGIN = 'CP-FILE-MANIFEST-BEGIN';
export const MANIFEST_END = 'CP-FILE-MANIFEST-END';

const baseName = (p) => String(p).split(/[\\/]/).pop();
const validMs = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

// [{ file, ms }] (the preload's lines) -> { 'x.test.mjs': { spanMs } }, keyed by base name, the longest span per file.
export function collectFileTimes(lines) {
  const out = {};
  for (const l of lines) {
    if (!l || typeof l.file !== 'string' || !validMs(l.ms)) continue;
    const name = baseName(l.file);
    if (!name) continue;
    const spanMs = Math.round(l.ms);
    if (!(out[name]?.spanMs >= spanMs)) out[name] = { spanMs };
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

// A stable hash of a file list: sha256 of the sorted names, one per line (first 16 hex digits).
export function fileListHash(names) {
  return createHash('sha256').update([...names].sort().join('\n')).digest('hex').slice(0, 16);
}

// What one test run was given, printed in the job log next to its times: the files it ran (its shard's list), the shard label
// ('I/N', or null when unsharded) and the size and hash of the full unsharded list, so a reader can check that all shards of a
// run together covered one list exactly once.
export function buildManifest({ shard, files, full }) {
  return { shard: shard ?? null, files: [...files].sort(), fullCount: full.length, fullHash: fileListHash(full) };
}

// The JSON object that CI printed between two marker lines of a job log, or null when it is not there / not JSON.
// A GitHub log line is `<job>\t<step>\t<timestamp> <text>` with CRLF endings; only the text after the timestamp counts.
function extractBlock(logText, markBegin, markEnd) {
  const text = (line) => line.replace(/\r$/, '').replace(/^.*?\d{4}-\d\d-\d\dT[\d:.]+Z /, '').trim();
  const lines = String(logText).split('\n').map(text);
  const begin = lines.lastIndexOf(markBegin);
  if (begin < 0) return null;
  const end = lines.indexOf(markEnd, begin + 1);
  if (end < 0) return null;
  try {
    const j = JSON.parse(lines.slice(begin + 1, end).join(''));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
}

// The { file: { spanMs } } JSON that CI printed between the CP-FILE-TIMES marker lines, or null.
export const extractTimes = (logText) => extractBlock(logText, MARK_BEGIN, MARK_END);

// The manifest (buildManifest) that CI printed between the CP-FILE-MANIFEST marker lines, or null.
export const extractManifest = (logText) => extractBlock(logText, MANIFEST_BEGIN, MANIFEST_END);

// [{ file: { spanMs } }, ...] (one per run) -> { file: median ms } for the files measured, rounded, sorted by name.
export function medianWeights(runs) {
  const per = new Map();
  for (const run of runs) {
    for (const [name, v] of Object.entries(run ?? {})) {
      if (validMs(v?.spanMs)) per.set(name, [...(per.get(name) ?? []), v.spanMs]);
    }
  }
  const out = {};
  for (const name of [...per.keys()].sort()) {
    const xs = per.get(name).sort((a, b) => a - b);
    const mid = xs.length >> 1;
    out[name] = Math.round(xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2);
  }
  return out;
}
