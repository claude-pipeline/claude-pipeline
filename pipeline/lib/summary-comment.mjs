// The ONE writer of the PR's summary comment: marker + status block + summary sections + record marker.
// `P summary`, `P comment --kind summary` and `P checkpoint` all go through it, so whichever part the caller does not
// supply (the run record, or the summary sections) is kept from the comment already on the PR instead of being lost.
import { readRepoMoves, sameRepo } from '../hooks/lib/repo-moves.mjs';
import { MARKERS } from './render.mjs';
import { effectiveCost } from './run-cost.mjs';
import { readCostBookings } from './run-events.mjs';
import { STATUS_END, STATUS_START, decodeRecord, encodeRecord, renderStatusBlock } from './run-record.mjs';

const RECORD_MARKER_ANY = /<!-- claude-pipeline:record:[A-Za-z0-9+/=]+ -->/g;

// What is left of a summary body once the marker, the status block and the record marker are cut out.
export function sectionsOf(body) {
  let rest = String(body).slice(MARKERS.summary.length).replace(RECORD_MARKER_ANY, '').trimStart();
  if (rest.startsWith(STATUS_START)) {
    const end = rest.indexOf(STATUS_END);
    if (end >= 0) rest = rest.slice(end + STATUS_END.length);
  }
  return rest.trim();
}

// The ONE rule for whether a run record's cost may be a base of this PR's cost (the summary reader, the record writers through it, and `P stats rounds`): the record is bound to this PR number and, when `repo`
// is given (left out: only the PR number is checked), to this repository: the same name (case-insensitive), or one the owner's repo-moves record links (sameRepo, judged from the record's last heartbeat;
// `moves` is read from the owner's file only when the names differ).
export function recordBelongs(record, { pr, repo, moves } = {}) {
  if (record.pr !== pr) return false;
  if (repo === undefined || String(record.repo ?? '').toLowerCase() === String(repo).toLowerCase()) return true;
  return sameRepo({ recorded: record.repo, recordedAt: record.heartbeat?.at, current: repo, moves: moves ?? readRepoMoves().moves });
}

// The newest summary comment the viewer wrote that STARTS with the marker: the same one upsertComment edits.
// -> {status: ok|absent|legacy|unsupported|invalid, record?, sections, url, id, costBookings, effectiveCost}
// `summaryFromComments(comments, viewerLogin, pr, { repo, moves })` works on a comment list the caller already holds. `repo` (the PR's slug) binds the record's cost base to this repository too (recordBelongs):
// a summary copied from another repository's PR of the same number is no base, and its cost is cut from the returned `record` as well, so a writer that rebuilds the record from it (checkpoint, summary) never restores it.
// `effectiveCost` is the PR's cost as the append-only cost bookings (`P cost`, one comment each) say it on top of the record's own cost section, a SIBLING of `record` (also when there is no
// summary comment yet): the record keeps only the legacy base, so the two are never added twice. -> run-cost.mjs#effectiveCost ({ cost, contributions, any } or { unavailable }).
// `costBookings` is what it was built from (readCostBookings), for a writer that replays the same bookings over a different base (costOver).
export function summaryFromComments(comments, viewerLogin, pr, { repo, moves } = {}) {
  const costBookings = readCostBookings({ comments, viewer: viewerLogin });
  const mine = comments
    .filter((c) => typeof c.body === 'string' && c.body.startsWith(MARKERS.summary) && c.user?.login === viewerLogin)
    .sort((a, b) => Number(a.id) - Number(b.id));
  const found = mine.at(-1);
  if (!found) return { status: 'absent', sections: '', url: null, id: null, costBookings, effectiveCost: effectiveCost({ baseStatus: 'absent', ...costBookings }) };
  const decoded = decodeRecord(found.body);
  // A record bound to another PR or repository (a summary copied over by hand) is no base: its cost is neither counted here nor carried by the record this returns (the writers adopt a record whose only mismatch is the repo).
  const ours = decoded.status === 'ok' && recordBelongs(decoded.record, { pr, repo, moves });
  const base = ours ? decoded.record.cost : undefined;
  const foreign = decoded.status === 'ok' && !ours ? { record: Object.fromEntries(Object.entries(decoded.record).filter(([k]) => k !== 'cost')) } : {};
  return { ...decoded, ...foreign, sections: sectionsOf(found.body), url: found.html_url ?? null, id: found.id, costBookings, effectiveCost: effectiveCost({ base, baseStatus: decoded.status, ...costBookings }) };
}

// The cost to show for a record about to be written: `base` (that record's own cost section) with the bookings of a summary read (`summaryFromComments` result) on top.
export const costOver = (summary, base) => effectiveCost({ base, baseStatus: 'ok', ...(summary?.costBookings ?? {}) });

export function readSummaryComment(gh, pr) {
  const me = gh.viewer(); // asked first: without a viewer there is nothing to match, so the comments are not even read
  return summaryFromComments(gh.listComments(pr), me, pr, { repo: typeof gh.repo === 'function' ? gh.repo().slug : undefined });
}

// `record` / `sections` left undefined are kept from the existing comment; pass `existing` (a readSummaryComment result)
// to avoid reading it twice. An existing record this CLI cannot read (`unsupported`, newer version) is never dropped
// silently: omit `record` and the write is refused.
// `retry`: wait out a rate limit (the run recorder leaves it off; the comment, summary and checkpoint commands opt in).
// The status block shows the cost as of THIS read: the record's cost section plus the cost bookings the read holds (`cost` overrides, an effectiveCost result); the encoded record keeps only its own cost
// section, so a later write never counts a booking twice. Returns { id, url, action, record, effectiveCost }.
export function writeSummaryComment(gh, pr, { record, sections, existing, retry = false, cost } = {}) {
  const current = existing ?? readSummaryComment(gh, pr);
  if (record === undefined && current.status === 'unsupported') {
    throw new Error('the summary comment carries a run record from a newer pipeline version: update the pipeline CLI before rewriting it');
  }
  const useRecord = record !== undefined ? record : (current.status === 'ok' ? current.record : null);
  const useSections = sections !== undefined ? sections : current.sections;
  const parts = [MARKERS.summary, ''];
  const shownCost = useRecord ? (cost ?? costOver(current, useRecord.cost)) : undefined;
  if (useRecord) parts.push(renderStatusBlock(useRecord, { cost: shownCost }), '');
  if (String(useSections).trim()) parts.push(String(useSections).trim(), '');
  if (useRecord) parts.push(encodeRecord(useRecord));
  const body = parts.join('\n').trimEnd();
  // `current` is a fresh read of the newest own marker comment: edit that id instead of listing every comment again (#396); no comment yet (or a gh without updateComment): the upsert creates it.
  // `retry` reaches the write only (both are safe to re-run: the PATCH is idempotent, the upsert re-lists before it writes).
  const opts = retry ? [{ retry: true }] : [];
  const posted = current.id != null && typeof gh.updateComment === 'function'
    ? gh.updateComment(current.id, MARKERS.summary, body, ...opts)
    : gh.upsertComment(pr, MARKERS.summary, body, ...opts);
  return { ...posted, record: useRecord, effectiveCost: shownCost };
}
