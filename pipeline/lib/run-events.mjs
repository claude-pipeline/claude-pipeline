// Run events: append-only evidence that must outlive the editable run record (the rollback target, a rollback that
// began, the incident it opened, and that a run was taken over from an earlier session: `run-resumed`, which the merge gate reads beside the run record). Each event is its OWN PR comment, created once and never edited, so no later writer
// can erase it. Only comments the viewer wrote that START with an event marker count; a quoted marker is not an event.
import { line } from './render.mjs';
import { applyCostPatch, costShapeProblem, emptyCost } from './run-cost.mjs';
import { packJson, unpackJson } from './run-record.mjs';

export const EVENT_KINDS = Object.freeze(['prod-before', 'rollback-intent', 'rollback-result', 'recovery-reported', 'ci-proof-used', 'hold-lifted', 'hold-lift-deleted', 'hold-lift-aborted', 'run-resumed', 'cost-booking']);

const EVENT_ID = /^[A-Za-z0-9._-]{1,64}$/;
const EVENT_START = /^<!-- claude-pipeline:event:([a-z-]+):([A-Za-z0-9._-]{1,64}) -->/;
const EVENT_DATA = /<!-- claude-pipeline:event-data:([A-Za-z0-9+/=]+) -->/g;

export function renderEvent(kind, id, sentence, data) {
  if (!EVENT_KINDS.includes(kind)) throw new Error(`unknown event kind ${JSON.stringify(kind)}`);
  if (!EVENT_ID.test(String(id))) throw new Error(`bad event id ${JSON.stringify(id)}: letters, digits, . _ - only`);
  return [
    `<!-- claude-pipeline:event:${kind}:${id} -->`,
    '',
    line(sentence, 300),
    '',
    `<!-- claude-pipeline:event-data:${packJson(data ?? {})} -->`,
  ].join('\n');
}

// null unless the body STARTS with an event marker of a known kind. dataStatus says whether the payload could be read.
export function parseEvent(body) {
  if (typeof body !== 'string') return null;
  const m = EVENT_START.exec(body);
  if (!m || !EVENT_KINDS.includes(m[1])) return null;
  const [kind, id] = [m[1], m[2]];
  const rest = body.slice(m[0].length);
  const cut = rest.indexOf('<!-- claude-pipeline:event-data:');
  const sentence = (cut < 0 ? rest : rest.slice(0, cut)).trim();
  const matches = [...body.matchAll(EVENT_DATA)];
  if (matches.length === 0) return { kind, id, sentence, data: null, dataStatus: 'absent' };
  try {
    return { kind, id, sentence, data: unpackJson(matches.at(-1)[1]), dataStatus: 'ok' };
  } catch {
    return { kind, id, sentence, data: null, dataStatus: 'invalid' };
  }
}

// ---- cost bookings (`P cost`): one never-edited comment per booking; the PR's cost is the replay of them (run-cost.mjs#effectiveCost) ----------------------------------

// Why `data` (a cost-booking event's payload: `P cost`'s cost patch {entry?, transcript?, retries?, sessions?} plus the booking's own `id`) is no booking, or null when it is one. The one
// shape check is a dry run through the replay's own arithmetic, so a payload that passes here can never fail later in a replay. Never carries `guardBlocks` or a top-level `hold` (hold.mjs reads any event with a string `hold`).
export function costBookingProblem(data, id) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return 'the payload is not an object';
  if (typeof data.id !== 'string' || !EVENT_ID.test(data.id)) return 'the payload has no usable id';
  if (id !== undefined && data.id !== id) return 'the payload id is not the comment id';
  if ('hold' in data) return 'the payload carries a hold';
  if (data.entry !== undefined && (data.entry === null || typeof data.entry !== 'object' || Array.isArray(data.entry))) return 'the entry is not an object';
  try {
    const bad = costShapeProblem(applyCostPatch(emptyCost(), data, { evict: false }));
    if (bad) return `the booking makes a cost section nothing can read (${bad})`;
  } catch (err) {
    return String(err?.message ?? err).slice(0, 120);
  }
  return null;
}

// The bookings among a PR's comments: the viewer's own comments that START with the cost-booking marker (another author's comment, or a quoted marker, is ignored and never corrupt), deduplicated by
// booking id (the lowest comment id wins), in GitHub comment-id order. -> { bookings: [{ id, commentId, data }], corrupt: [reason] }: `corrupt` lists the viewer's own bookings that cannot be used (unreadable
// payload); the replay then reports the cost as unavailable instead of a wrong total. Never throws.
export function readCostBookings({ comments, viewer }) {
  const bookings = [];
  const corrupt = [];
  const seen = new Set();
  const mine = (Array.isArray(comments) ? comments : [])
    .filter((c) => c?.user?.login === viewer && typeof c.body === 'string')
    .sort((a, b) => Number(a.id) - Number(b.id));
  for (const c of mine) {
    const ev = parseEvent(c.body);
    if (ev?.kind !== 'cost-booking') continue;
    if (seen.has(ev.id)) continue;
    const problem = ev.dataStatus === 'ok' ? costBookingProblem(ev.data, ev.id) : `the payload is ${ev.dataStatus}`;
    if (problem !== null) {
      corrupt.push(`comment ${c.id}: ${problem}`);
      continue;
    }
    seen.add(ev.id);
    bookings.push({ id: ev.id, commentId: c.id, data: ev.data });
  }
  return { bookings, corrupt };
}

// Always a new comment: this never calls upsertComment, so a second event can never rewrite a first one.
export function postEvent(gh, pr, kind, id, sentence, data) {
  return gh.createComment(pr, renderEvent(kind, id, sentence, data));
}

// The merge gate's read of "this run was resumed" from the append-only side: a run-resumed event THE VIEWER wrote (any head: a resumed run stays
// resumed) counts; another author's comment, or a quoted marker, does not (parseEvent wants the marker at the very start). Never throws:
// { resumed, event, unreadable }. `unreadable` (a reason) means the answer is unknown and the caller must fail CLOSED, like an unreadable run record.
export function readResumedEvidence(gh, pr) {
  try {
    const me = gh.viewer();
    const found = gh.listComments(pr).map((c) => ({ c, ev: parseEvent(c.body) })).find(({ c, ev }) => ev?.kind === 'run-resumed' && c.user?.login === me);
    return { resumed: found !== undefined, event: found?.ev ?? null, unreadable: null };
  } catch (err) {
    return { resumed: false, event: null, unreadable: `the run-resumed events could not be read (${String(err?.message ?? err).slice(0, 200)})` };
  }
}
