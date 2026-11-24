// The ONE writer of the PR's summary comment: marker + status block + summary sections + record marker.
// `P summary`, `P comment --kind summary` and `P checkpoint` all go through it, so whichever part the caller does not
// supply (the run record, or the summary sections) is kept from the comment already on the PR instead of being lost.
import { retrying } from './gh-retry.mjs';
import { MARKERS } from './render.mjs';
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

// The newest summary comment the viewer wrote that STARTS with the marker: the same one upsertComment edits.
// -> {status: ok|absent|legacy|unsupported|invalid, record?, sections, url, id}
// `summaryFromComments` works on a comment list the caller already holds.
export function summaryFromComments(comments, viewerLogin) {
  const mine = comments
    .filter((c) => typeof c.body === 'string' && c.body.startsWith(MARKERS.summary) && c.user?.login === viewerLogin)
    .sort((a, b) => Number(a.id) - Number(b.id));
  const found = mine.at(-1);
  if (!found) return { status: 'absent', sections: '', url: null, id: null };
  const decoded = decodeRecord(found.body);
  return { ...decoded, sections: sectionsOf(found.body), url: found.html_url ?? null, id: found.id };
}

export function readSummaryComment(gh, pr) {
  const me = gh.viewer(); // asked first: without a viewer there is nothing to match, so the comments are not even read
  return summaryFromComments(gh.listComments(pr), me);
}

// `record` / `sections` left undefined are kept from the existing comment; pass `existing` (a readSummaryComment result)
// to avoid reading it twice. `sections` may be a function of that comment (the read this write rests on): it returns the sections to write (the closed-PR summary carries a line from it). An existing record this CLI cannot read (`unsupported`, newer version) is never dropped
// silently: omit `record` and the write is refused.
// `retry`: wait out a rate limit (the run recorder leaves it off; the comment, summary and checkpoint commands opt in).
export function writeSummaryComment(gh, pr, { record, sections, existing, retry = false } = {}) {
  const once = (current, retryWrite, attempt = 1) => {
    // a read made after a wait (attempt > 1) is refused whatever `record` is: a newer CLI may have written during it
    if (current.status === 'unsupported' && (record === undefined || attempt > 1)) {
      throw new Error('the summary comment carries a run record from a newer pipeline version: update the pipeline CLI before rewriting it');
    }
    const useRecord = record !== undefined ? record : (current.status === 'ok' ? current.record : null);
    const useSections = typeof sections === 'function' ? sections(current) : (sections !== undefined ? sections : current.sections);
    const parts = [MARKERS.summary, ''];
    if (useRecord) parts.push(renderStatusBlock(useRecord), '');
    if (String(useSections).trim()) parts.push(String(useSections).trim(), '');
    if (useRecord) parts.push(encodeRecord(useRecord));
    const body = parts.join('\n').trimEnd();
    // `current` is a fresh read of the newest own marker comment: edit that id instead of listing every comment again (#396); no comment yet (or a gh without updateComment): the upsert creates it.
    // `retry` reaches the write only (both are safe to re-run: the PATCH is idempotent, the upsert re-lists before it writes).
    const opts = retryWrite ? [{ retry: true }] : [];
    const posted = current.id != null && typeof gh.updateComment === 'function'
      ? gh.updateComment(current.id, MARKERS.summary, body, ...opts)
      : gh.upsertComment(pr, MARKERS.summary, body, ...opts);
    return { ...posted, record: useRecord };
  };
  if (!(retry && typeof sections === 'function')) return once(existing ?? readSummaryComment(gh, pr), retry);
  // Sections that are a function of the comment (the closed-PR summary) must be rendered from what is on the PR when they are SENT: a wait out of a rate limit
  // can let another summary post a line, which the body rendered before the wait would erase. So the retry is of the whole step (re-read, re-render, write), not of the PATCH alone.
  const step = typeof gh.retrying === 'function' ? gh.retrying : retrying; // the gh's own retrier carries the env cap, the rate-limit probe and the shared budget
  return step((attempt) => once(attempt === 1 && existing ? existing : readSummaryComment(gh, pr), false, attempt));
}
