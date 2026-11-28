// Why (#58): with owner_approval: chat a head the final gate leaves items for the owner on (hard-stop paths, test changes,
// owner-ruled review items), and any resumed run, merges only after the owner says "merge" in chat. `--owner-approved-head`
// alone was the agent's own word: nothing proved the owner had said it (Codex + Fable design reviews, 2026-10-14). So the
// owner-go recorder (the UserPromptSubmit hook hooks/owner-go.mjs, which fires for the owner's typed prompts and for harness turns, which #128 screens out) writes
// down each owner prompt that STARTS with "merge", bound to what the reply right before it asked for:
//   `Head <sha12> · items <digest> · repo <owner/name>` lines + `🔀 Ready to merge #N — say "merge"` (skills/ship, Owner-merge approval). The block may also carry an
//   `Areas …` line (protected areas), a `Hold … by … at …` line with the lift wording on the 🔀 line (the needs-human hold the "merge" lifts) and, for one PR, a `Rulings <digest12>` header with
//   its rows (the dismissals Claude or the arbiter made on BLOCKING / security items). The order, top to bottom: Rulings, Areas, Hold, Head, 🔀. See presentedRequests.
// `P merge` then needs a record for exactly that repository, PR, head and owner-item set; the guard needs one (for that repository and
// PR, in that session) before a direct `gh pr merge` / the repo's merge command in an owner_approval: chat repo. Phase 3b: the repository
// is part of the request, so a "merge" said for #N of one repository never approves #N of another (a fork, a mirror, a vendored copy
// that shares the commit). A request line without it approves nothing. guard-files keeps
// agents from writing the folder or running the recorder.
// #128 (harness messages are not the owner's words): UserPromptSubmit also fires for background-task notices, other sessions' and
// subagents' messages, plugin and scheduled (/loop) turns and headless `claude -p` runs, and its input carries no field that says which.
// Two defences, both "record less": (1) the recorders skip a prompt that is evidently not typed (notOwnerWords: hook-input provenance, the
// transcript entry once it exists, a text envelope), and the ruling look-back skips turns the TRANSCRIPT METADATA marks synthetic
// (entrySource: never text); (2) at USE time, when the transcript has caught up, `P merge`, the guard, `P triage owner-ruling` and the
// owner-granted extra round (ownerGrantedRounds, the final gate's verifyOwnerGrant) accept a record only when its prompt entry (found by the hook's prompt_id, else by text and time) is the owner's (promptProvenance).
// A record whose entry cannot be found or is not the owner's approves nothing. Records written before #128 carry no prompt_id (nor transcript_path):
// a "merge" or a ruling from then is refused for its last day at most (it ages out, MAX_AGE_MS). An owner-granted extra round is different: it is read
// at any age (verifyOwnerGrant), so a pre-#128 grant on a PR still in flight would block its review-complete and final gate for good. The grant readers
// therefore find such a record's transcript from its session (legacyTranscriptOf: exactly one real file under the ROOTS THE GUARD PROTECTS, else missing: the folders
// directly under the account's home named like ~/.claude, ~/.claude-eaglewatch (HOME_CONFIG_DIR_RE, the shape the guard stops a tool from creating or replacing), the file's real
// path inside its root's; never $CLAUDE_CONFIG_DIR, which the grant readers take from the agent's shell, never ~/.claude.forged, which nothing stops) and prove
// the prompt by its words and time like any record without a prompt_id; the derived path is never written back. Nothing else gets this.
// Residual (#128): the model could still write a transcript entry itself (files-policy refuses a tool write to ~/.claude*/projects/**/*.jsonl)
// or type into an interactive `claude --resume` through a pty, which types as the owner; GitHub-side separation (issue #65) is the backstop.
// Residual (owner ruling 2026-10-14, the "cheap step"): the agent runs as the same OS user, so a program the guards cannot
// see into can still write the folder; the transcript the recorder reads is a file of that user; and the agent's GitHub
// token is the owner's. A second GitHub identity + a ruleset is the server-side backstop (issue #65).
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, writeSync } from 'node:fs';
import path from 'node:path';
import { REPO_NAME, readRepoMoves, sameRepo } from './repo-moves.mjs';
import { clickProvenance, pendingClickProblems, settlePendingClicks } from './owner-go-click.mjs';
import { accountHome, isInside, isTranscriptFile, TRANSCRIPT_PROJECT_RE, transcriptConfigDirs } from '../../lib/paths.mjs';

export const OWNER_GO_REL = '.claude/pipeline-state/owner-go';
export const MAX_AGE_MS = 24 * 60 * 60 * 1000; // a "merge" older than a day approves nothing
export const FUTURE_SKEW_MS = 5 * 60 * 1000;
const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;
const PROVENANCE_CHUNK_BYTES = 4 * 1024 * 1024; // promptProvenance reads the transcript backwards in chunks this big …
const PROVENANCE_CAP_BYTES = 64 * 1024 * 1024; // … and gives up (missing) this far back
const FALLBACK_WINDOW_MS = 120 * 1000; // a record with no prompt_id is matched to a transcript entry by its text within this much time
const MAX_RECORD_BYTES = 1024 * 1024; // one session file; a bigger one is not read
export const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export const HEAD_CHARS = 12; // the head is shown (and matched) by its first 12 characters at least

// The account's home from the OS user database, NOT $HOME: `HOME=/tmp/x P merge …` must not point the check at a folder the agent
// can write. (The `home` options below are for the unit tests, which call these functions in-process.) Defined in lib/paths.mjs, where isTranscriptFile needs the same home.
// (The guard itself, hooks/lib/files-policy.mjs, builds its home from os.homedir(): where $HOME differs from the passwd home it protects the $HOME one, so a genuine transcript under the passwd home
// is refused here. Fail closed, accepted.)
export { accountHome };

export const ownerGoDir = (home = accountHome()) => path.join(home, ...OWNER_GO_REL.split('/'));

// #190.3b: the owner copies an answer out of a terminal and the prompt glyph comes with it ("❯ R4-B1: reject", "> merge"). answerBody is the words every answer parser reads: the prompt
// trimmed, with at most ONE leading glyph from ❯ › > $ removed when at least one space follows it, and only on a single-line prompt. `>merge` and `$5 …` keep their first character, two glyphs
// leave one (so the parser refuses it), a glyph mid-line is never touched, and the words after the glyph must still be the whole answer. promptProvenance still proves the owner typed the
// entry, and the glyph adds no word, so it grants no authority the bare words did not have. Callers: parseApproval, parseRoundGrant, rulingsIn and the PAIRS_ONLY nudge sites. The stored
// prompt and the --owner-quote comparison stay verbatim (the record is the audit trail); a length cap applies to the body, after the strip.
export const answerBody = (s) => {
  const t = String(s ?? '').trim();
  return /[\r\n]/.test(t) ? t : t.replace(/^[❯›>$][ \t ]+/, '').trim();
};

// Why (#472): readRecords settles pending clicks (owner-go-click.mjs settlePendingClicks) unless the caller says `settle: false` (the read-only paths: the merge dry run's gate, click replay).
// `settle: true` forces it. Otherwise the environment switch PIPELINE_CLICK_SETTLE=off, which the test runner and the test helpers set, turns it off, so a test can never settle the owner's real
// pending clicks. Already recorded clicks still count: the switch only stops pending clicks from becoming records through the readers. Strict lookups still see unresolved round clicks, so
// setting it never widens what is approved. The environment is the agent's own word (lib/paths.mjs), so it gates NOTHING but this: a consumption write (a spent marker, a round-claim sweep or
// repair) is never gated by it.
export const settleEnabled = (settle, env = process.env) => settle === true || (settle !== false && env.PIPELINE_CLICK_SETTLE !== 'off');

// The words that may follow "merge" in an approval besides its targets (#N, N, a head prefix).
const FILLER = /^(?:and|it|both|all|them|these|those|please|pls|now|go|ok|okay|thanks|thank|you|thx|ty)$/i;

// A prompt that approves: "merge", "merge #58", "merge 1318 1319", "Merge it.", "merge a1b2c3d4e5f6". Anything else is not an
// approval: "do not merge", "merge?", "merge later", "merge after CI", "why merge". Returns null or { prs, shas }.
export function parseApproval(prompt) {
  const t = answerBody(prompt);
  const m = /^merge(?![A-Za-z0-9_-])([\s\S]*)$/i.exec(t);
  if (!m) return null;
  const rest = m[1];
  if (rest.includes('?')) return null;
  const prs = [];
  const shas = [];
  for (const tok of rest.replace(/[.,!;:]+/g, ' ').split(/\s+/).filter(Boolean)) {
    let x;
    if ((x = /^#?(\d{1,6})$/.exec(tok))) prs.push(Number(x[1]));
    else if (/^[0-9a-f]{7,40}$/i.test(tok)) shas.push(tok.toLowerCase());
    else if (!FILLER.test(tok)) return null;
  }
  return { prs: [...new Set(prs)], shas: [...new Set(shas)] };
}

// The merge request a reply ENDS with. The reply's last lines are the request (skills/ship): optional `Head <sha12> · items <digest> · repo <owner/name>`
// lines (or, for several PRs, `#N head <sha12> · items <digest> · repo <owner/name>`) directly above the 🔀 line, which is the last non-blank line. Blank (whitespace-only) lines
// anywhere in the reply are transparent ("directly above" = the next non-blank line above; EW #1659: a blank line before the 🔀 line voided the owner's "merge"); prose is not.
// Only that terminal block binds: an earlier block in the same reply, a Head line with prose between it and the 🔀 line, or any
// text after the 🔀 line binds nothing, and a PR bound twice (two heads, or the same line twice) is ambiguous, so it binds nothing.
// Protected areas (plan 2026-11-05-chat-merge-protected, rev 4 item 2b): a PR whose diff has owner items is shown with one more line DIRECTLY above its
// Head line (or directly above the Hold line that sits directly above its Head line), `Areas <area ids, sorted, one space apart>` (areasBlock: the hard-stop rule ids / integrity kinds
// P merge --dry-run prints), and the record keeps sha256 of that block (areasDigest). In the several-PR form it is `#N areas <ids>` above `#N head …`. Exactly that shape binds: an Areas
// line that is not directly above its own Head line or Hold line (two in a row, one against the 🔀 line, another PR's number) makes the whole block bind nothing. An Areas line with
// prose between it and the Head line is no part of the block: the request then binds WITHOUT areas, which approves no diff that has any.
// The needs-human hold (rev 4 items 2a, 5; review note 6): a PR whose hold the owner's "merge" lifts has the Head line carry ONE `· hold <event id>` field between
// `items …` and `repo …`, and a canonical `Hold <id> by <login> at <ISO>` line (holdBlock) DIRECTLY above that Head line. Block order, top to bottom: Areas (optional),
// Hold, Head; Areas binds above Head or above a Hold that sits above its Head. UNLIKE Areas, a Hold-shaped line (the canonical prefix `Hold <id> by `, HOLD_START; prose such as
// "Hold on, …" is none) anywhere in the reply that is not consumed exactly so (prose between it and its Head, two in a row, against the 🔀 line, ahead of Areas, another PR's, an id
// other than its Head's `hold` field, a malformed rest) makes the WHOLE reply bind nothing (one exception, #585: an earlier line that is an identical copy of a Hold line the block consumed, see below), and so does a Head line with `hold X` and no Hold line right above it; a hold field repeated
// or after `repo` is no Head line at all. The record keeps the hold id and sha256 of the block (holdDigest). And a request with a hold binds only when the 🔀 line says it lifts the hold
// (readyLine, LIFT_PHRASE) AND every request bound carries one (singular: the one PR; plural: all listed): the phrase with no hold in the bound requests, or a hold with no phrase, binds nothing.
// Returns { prs: [N…] (every PR on the 🔀 line; [] when the reply does not end with it), requests: [{ pr, head, items, repo, areas?, hold?, holdBlock? }] } (repo: the
// lower-cased owner/name, or null when the line names none: such a request approves nothing; areas: the block's digest, absent = no areas shown; hold: the event id,
// holdBlock: the Hold block's digest, both absent = no hold).
const READY_LINE = /🔀\s*Ready to merge\s+([^\n]*)/;
// The request's LAST line is anchored: nothing but spaces before the 🔀 (prose such as `Do not 🔀 Ready to merge …` is no request). READY_LINE stays unanchored: SURFACED_ASK and
// lastRequestText only ask "does the reply mention a request anywhere".
const READY_FULL_LINE = new RegExp(`^\\s*${READY_LINE.source}$`);
const HOLD_ID = '[A-Za-z0-9_=+/-]{1,128}';
const HEAD_LINE = new RegExp(`^\\s*(?:#(\\d+)\\s+)?head\\s+([0-9a-f]{${HEAD_CHARS},40})\\s*(?:·|\\|)\\s*items\\s+([0-9a-f]{12}|none)(?:\\s*(?:·|\\|)\\s*hold\\s+(${HOLD_ID}))?(?:\\s*(?:·|\\|)\\s*repo\\s+(${REPO_NAME}))?\\s*$`, 'i');
const AREAS_START = /^\s*(?:#\d+\s+)?areas\b/i;
const AREA_ID = '[A-Za-z0-9_.-]{1,64}';
const AREAS_LINE = new RegExp(`^\\s*(?:#(\\d+)\\s+)?areas((?:\\s+${AREA_ID})+)\\s*$`, 'i');
// "Hold-shaped" is the canonical PREFIX only (`Hold <id> by `, an optional `#N ` before it, any case): prose that merely starts with the word ("Hold on, a second.") is no Hold line.
const HOLD_START = /^\s*(?:#\d+\s+)?hold\s+\S+\s+by\s+/i;
// (GitHub logins: letters, digits, hyphens, an optional `[bot]`. A `_` (an EMU login) is rejected on purpose: such a hold has no showable block, so the request fails closed.)
const HOLD_LOGIN = '[A-Za-z0-9-]{1,39}(?:\\[bot\\])?';
const HOLD_AT = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z';
const HOLD_LINE = new RegExp(`^\\s*(?:#(\\d+)\\s+)?hold\\s+(${HOLD_ID})\\s+by\\s+(${HOLD_LOGIN})\\s+at\\s+(${HOLD_AT})\\s*$`, 'i');
// The canonical block the owner is shown for the areas of a diff: `Areas <sorted distinct ids>`; '' when there are none.
export const areasBlock = (ids) => {
  const list = [...new Set((ids ?? []).map(String))].sort();
  return list.length === 0 ? '' : `Areas ${list.join(' ')}`;
};
// What the record stores for it and P merge compares: sha256 of the block, 'none' without areas.
export const areasDigest = (ids) => {
  const block = areasBlock(ids);
  return block === '' ? 'none' : createHash('sha256').update(block).digest('hex');
};
// The canonical block the owner is shown for the needs-human hold their "merge" lifts: `Hold <event node id> by <actor login> at <created_at>` (the id and login as GitHub
// spells them, the time exactly as GitHub's created_at: ISO-8601 UTC, whole seconds). '' for input of another shape: a caller treats '' as "no showable hold" and fails closed.
export const holdBlock = (hold) => {
  const { id, login, at } = hold ?? {};
  return typeof id === 'string' && typeof login === 'string' && typeof at === 'string'
    && new RegExp(`^${HOLD_ID}$`).test(id) && new RegExp(`^${HOLD_LOGIN}$`).test(login) && new RegExp(`^${HOLD_AT}$`).test(at)
    ? `Hold ${id} by ${login} at ${at}` : '';
};
// What the record stores for it and P merge compares: sha256 of the block; 'none' for no hold (null / absent); 'invalid' for a hold with no showable block (it equals no record's value).
export const holdDigest = (hold) => {
  if (hold === null || hold === undefined) return 'none';
  const block = holdBlock(hold);
  return block === '' ? 'invalid' : createHash('sha256').update(block).digest('hex');
};
// The 🔀 line a request ends with. A request whose Head line has a hold ends with the lift phrase (rev 4 item 2a), exactly: `🔀 Ready to merge #N and lift its needs-human hold — say "merge"`,
// or for several PRs `🔀 Ready to merge #1, #2 and lift their needs-human holds — say "merge"`. presentedRequests binds a hold only under that wording (a dash as `-` / `--` or a final full stop also read).
export const LIFT_PHRASE = Object.freeze({ one: 'and lift its needs-human hold', many: 'and lift their needs-human holds' });
export const readyLine = (prs, { lift = false } = {}) => `🔀 Ready to merge ${prs.map((n) => `#${n}`).join(', ')}${lift ? ` ${prs.length === 1 ? LIFT_PHRASE.one : LIFT_PHRASE.many}` : ''} — say "merge"`;
const LIFT_LINE = new RegExp(`^(#\\d{1,6}(?:\\s*,\\s*#\\d{1,6})*)\\s+(${LIFT_PHRASE.one}|${LIFT_PHRASE.many})\\s*(?:—|\\s--?\\s)\\s*say\\s+"merge"\\.?\\s*$`);
const liftsHold = (rest, prs) => {
  const m = LIFT_LINE.exec(rest.trim());
  return m !== null && m[2] === (prs.length === 1 ? LIFT_PHRASE.one : LIFT_PHRASE.many); // (the PR numbers in m[1] are the text `prs` was read from)
};
// The rulings block (plan 2026-11-05-claude-rulings, E11): `Rulings <digest12>` then one `<item id> · …` row per dismissed BLOCKING / security item (P merge --dry-run --owner-go prints it).
// presentedRequests binds it only as ONE contiguous run of rows directly under the header and directly above the Areas / Hold / Head lines. Every other shape binds no rulings
// (the record then carries none, which fails closed against a live digest): header-less rows, a header with no rows, prose between, a second header or run of rows above it.
const RULINGS_HEADER = /^\s*Rulings\s+[0-9a-f]{12}\s*$/;
const RULINGS_ROW = /^\s*R\d+-[A-Za-z]\d+\s+·\s+.+$/;
// What the record stores for the block and P merge compares: sha256 of its non-blank lines (each trimmed, runs of white space as one space) joined by a newline; 'none' for no block.
export const rulingsBlockDigest = (text) => {
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trim().replace(/\s+/g, ' ')).filter((l) => l !== '');
  return lines.length === 0 ? 'none' : createHash('sha256').update(lines.join('\n')).digest('hex');
};
export function presentedRequests(text) {
  const none = (prs) => ({ prs, requests: [] });
  // A whitespace-only line carries no content, so it is transparent: "directly above" means the next NON-BLANK line above (owner-reported miss, EW #1659: a blank line between the
  // Head line and the 🔀 line made the owner's "merge" record nothing). Prose still ends the block, and every rule below is unchanged.
  const lines = String(text ?? '').split(/\r?\n/).filter((l) => l.trim() !== '');
  const r = READY_FULL_LINE.exec(lines[lines.length - 1] ?? '');
  if (!r) return { prs: [], requests: [] };
  const prs = [...new Set([...r[1].split(/—|\s--?\s|\bsay\b/)[0].matchAll(/#(\d{1,6})\b/g)].map((x) => Number(x[1])))];
  const block = [];
  let i = lines.length - 2;
  for (; i >= 0; i--) {
    if (lines[i].includes('\r')) break; // a lone \r (CRLF was split off above) redraws the line on a terminal: what the owner sees is not what the parser would read, so it is prose
    const h = HEAD_LINE.exec(lines[i]);
    const a = h ? null : AREAS_LINE.exec(lines[i]);
    const o = h || a ? null : HOLD_LINE.exec(lines[i]);
    if (!h && !a && !o) break;
    block.unshift({ h, a, o });
  }
  const blockStart = i + 1; // (lines[blockStart + j] is block[j])
  // The rulings block, if any, sits directly above the Areas / Hold / Head lines: rows walked up while contiguous, then exactly one header. A run of rows with no header directly above, a
  // header with no rows, prose in between, or a second header / run above the one found binds nothing (rulings stay absent; the lines are then plain prose to every rule below).
  let rulings = null;
  {
    const lineOk = (l) => l !== undefined && !l.includes('\r');
    let k = i;
    while (k >= 0 && lineOk(lines[k]) && RULINGS_ROW.test(lines[k])) k--;
    if (k < i && k >= 0 && lineOk(lines[k]) && RULINGS_HEADER.test(lines[k])) {
      const above = lines[k - 1];
      const stacked = lineOk(above) && (RULINGS_ROW.test(above) || RULINGS_HEADER.test(above)); // a duplicate header, or rows apart from this block
      if (!stacked) {
        rulings = rulingsBlockDigest(lines.slice(k, i + 1).join('\n'));
        i = k - 1;
      }
    }
  }
  if (rulings !== null && prs.length !== 1) return none(prs); // a rulings block belongs to ONE PR: with several on the 🔀 line the whole reply binds nothing
  if (i >= 0 && AREAS_START.test(lines[i])) return none(prs); // an Areas line of any other shape against the block: malformed
  // a canonical-prefix Hold line outside the block (prose between it and its Head, an earlier block's) voids the reply (review note 6), unless it is an identical copy of a Hold line the block consumed (#585, below)
  const earlierHolds = lines.slice(0, i + 1).filter((l) => HOLD_START.test(l));
  const holdsOf = []; // [{ pr, text }]: the Hold line above each Head line that carries one
  const bound = new Map();
  for (let j = 0; j < block.length; j++) {
    const { h } = block[j];
    if (!h) continue;
    const hold = h[4] ?? null;
    const o = block[j - 1]?.o ?? null; // the Hold line right above (null: none)
    if ((hold === null) !== (o === null)) return none(prs); // a hold field with no Hold line right above, or a Hold line above a Head line without the field
    let hasHold = null;
    if (o) {
      if ((o[1] ?? null) !== (h[1] ?? null) || o[2] !== hold) return none(prs); // another PR's Hold line, or another hold's id
      const rebuilt = { id: o[2], login: o[3], at: o[4] };
      if (holdBlock(rebuilt) === '') return none(prs); // (the regex reads T / Z in any case; the block is canonical only in upper case)
      hasHold = rebuilt;
    }
    const holdText = o ? lines[blockStart + j - 1] : null;
    const above = o ? block[j - 2]?.a ?? null : block[j - 1]?.a ?? null;
    if (above && (above[1] ?? null) !== (h[1] ?? null)) return none(prs); // another PR's Areas line
    const pr = h[1] ? Number(h[1]) : prs.length === 1 ? prs[0] : null;
    if (pr === null || !prs.includes(pr)) continue;
    if (holdText !== null) holdsOf.push({ pr, text: holdText });
    const areas = above ? createHash('sha256').update(`Areas ${above[2].trim().split(/\s+/).join(' ')}`).digest('hex') : null;
    bound.set(pr, bound.has(pr) ? null : { pr, head: h[2].toLowerCase(), items: h[3].toLowerCase(), repo: h[5] ? h[5].toLowerCase() : null, ...(areas ? { areas } : {}), ...(rulings !== null ? { rulings } : {}), ...(hasHold ? { hold: hasHold.id, holdBlock: holdDigest(hasHold) } : {}) });
  }
  // An Areas line that no Head line below it takes (a second one in a row, one against the 🔀 line) is a malformed block; so is a Hold line no Head line right below takes.
  const takesHead = (j) => block[j + 1]?.h || (block[j + 1]?.o && block[j + 2]?.h);
  if (block.some((b, j) => (b.a && !takesHead(j)) || (b.o && !block[j + 1]?.h))) return none(prs);
  // #585: a re-shown request (the closing lines written again, in the same turn) holds the Hold line twice. A Hold line names one GitHub event (node id, actor, time), so an earlier copy that is the SAME text as a Hold line
  // the terminal block CONSUMED shows the owner the same event and changes nothing about what is approved; it binds nothing itself (only the terminal block binds). Consumed = the Hold line of a request that survives binding:
  // its Head's PR is on the 🔀 line and bound exactly once (a Hold line next to an unlisted or duplicate PR's Head is not). Compared as exact text after stripping spaces and tabs at the ends (never trim(): a non-breaking
  // space is not stripped), and a line with a lone \r (it redraws on a terminal) is never tolerated. Anything else above the block (another id, actor, time, prefix, case, spacing; a copy of nothing consumed) still voids the reply.
  const trimmed = (l) => l.replace(/^[ \t]+|[ \t]+$/g, '');
  const consumed = new Set(holdsOf.filter((x) => bound.get(x.pr)).map((x) => trimmed(x.text)));
  if (earlierHolds.some((l) => l.includes('\r') || !consumed.has(trimmed(l)))) return none(prs);
  // rev 4 item 2a: a hold binds only under the lift wording, and the wording only when EVERY request bound carries a hold (singular: the one PR; plural: all listed). A Hold-bearing
  // Head line that binds nothing itself (a PR not on the 🔀 line, an unprefixed Head in the several-PR form, a duplicate) neither makes the wording legitimate nor forbids it.
  const requests = [...bound.values()].filter(Boolean);
  if (liftsHold(r[1], prs) ? !prs.every((p) => bound.get(p)?.hold) : requests.some((x) => x.hold)) return none(prs);
  return { prs, requests };
}

// Phase 3b: an owner ruling in chat (`P triage owner-ruling`) was the agent's word too: --owner-quote could be any text. A reply that
// asks the owner to rule ENDS with `⚖️ Owner ruling needed #N: R1-B1, R2-S3 · content <digest12> · repo owner/name` (`P triage ruling-request`
// writes it; skills/ship reference/review-loop.md), and the owner's next prompt is recorded with those ids; owner-ruling then needs a
// recorded prompt for that repository, PR and id whose words hold the quote. #110: the digest (rulingContentDigest, lib/triage.mjs) binds
// the request to the finding text the owner was shown; owner-ruling recomputes it. A line without one (the shape before #110) is
// still read, with content null, and owner-ruling refuses it. Returns { pr, repo (lower case), ids, content (lower case hex, or null) }
// or null when the reply does not end with that line.
const RULING_LINE = new RegExp(`^\\s*⚖️?\\s*Owner ruling needed\\s+#(\\d{1,6})\\s*:\\s*([^\\n·|]+?)\\s*(?:(?:·|\\|)\\s*content\\s+([0-9a-f]{12})\\s*)?(?:·|\\|)\\s*repo\\s+(${REPO_NAME})\\s*$`, 'i');
const ITEM_ID = /^R\d{1,4}-[A-Za-z]{1,8}\d{1,4}$/;
export function presentedRuling(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const m = RULING_LINE.exec(lines[lines.length - 1] ?? '');
  if (!m) return null;
  const ids = [...new Set(m[2].split(/[\s,]+/).filter(Boolean))];
  if (ids.length === 0 || !ids.every((id) => ITEM_ID.test(id))) return null;
  return { pr: Number(m[1]), repo: m[4].toLowerCase(), ids, content: m[3] ? m[3].toLowerCase() : null };
}

// ---- the transcript: what a prompt entry is, who it came from ---------------------------------------------------------------------

const plain = (t) => String(t ?? '').replace(/\r\n/g, '\n').trim();
// (round 4: a user message is a prompt unless it carries a tool_result: an image-only message is one too, with no text)
const isPromptEntry = (e) => e?.type === 'user' && (typeof e.message?.content === 'string' || (Array.isArray(e.message?.content) && !e.message.content.some((b) => b?.type === 'tool_result')));
export const promptTextOf = (e) => {
  const c = e?.message?.content;
  return plain(typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n') : '');
};

// Where a transcript PROMPT entry came from, from its metadata only, never its text (#128; Claude Code 2.1.314 writes origin {kind},
// promptSource, turnOrigin and entrypoint on a prompt entry, probed 2026-11-03):
//   'synthetic': promptSource system (task notices, peers, plugins, scheduled turns) or sdk (headless `claude -p`, also `--resume` of this
//     session), entrypoint sdk-cli, or an origin.kind that is not human;
//   'owner': origin.kind human or promptSource typed / queued, and none of the above;
//   'unknown': no such field (an older Claude Code; `!` blocks). `isMeta` alone decides nothing: an owner prompt with an attachment may carry it.
// A user entry that carries a tool_result is no prompt, so never the owner's.
export function entrySource(e) {
  if (!isPromptEntry(e)) return 'synthetic';
  const kind = typeof e.origin?.kind === 'string' ? e.origin.kind : '';
  if (e.promptSource === 'system' || e.promptSource === 'sdk' || e.entrypoint === 'sdk-cli' || (kind !== '' && kind !== 'human')) return 'synthetic';
  if (kind === 'human' || e.promptSource === 'typed' || e.promptSource === 'queued') return 'owner';
  return 'unknown';
}
// Does the entry carry any of the fields entrySource reads? A transcript with such a field on some prompt is a modern one; an entry
// of 'unknown' source in it is not trusted (an interrupt marker, a compaction summary, a source this list does not know).
const hasProvenanceField = (e) => e.promptSource !== undefined || e.origin !== undefined || e.entrypoint !== undefined || e.turnOrigin !== undefined;

// #191 (A2/F1/F2): which prompt entries start a turn the owner SEES. A synthetic prompt with promptSource 'system' AND entrypoint 'cli' is a turn the interactive UI starts itself (a task
// notice, an Agent hand-back, a peer or plugin message, a scheduled wake-up, auto-continuation) and renders: isMeta hides the PROMPT, never the assistant text of the reply. The agent
// can cause each of these and fill it with a request line; that is no bypass, because what it prints is on the owner's screen when they answer (the premise of #189's promotion of a
// ruling ask, written down here for every reader). A headless `claude -p --resume <session>` turn (promptSource sdk / entrypoint sdk-cli), any other non-human origin and anything else
// that is not the owner's writes into the owner's transcript and shows NOTHING on screen.
const visibleSynthetic = (e) => entrySource(e) === 'synthetic' && e.promptSource === 'system' && e.entrypoint === 'cli';
// An INVISIBLE turn: a prompt entry that is not the owner's and not visibleSynthetic, with provenance to say so. F1: an entry carrying a provenance field whose source entrySource
// cannot place ('unknown': a value Claude Code adds later) counts as invisible too (fail closed); a 'unknown' entry with no such provenance (an interrupt marker, a harness note of the interactive
// process, a legacy transcript; unplacedProvenance below says what counts) is a plain boundary as before. Only prompt entries are turns: a tool_result user entry is never one (F7). A compaction-summary entry (it carries isCompactSummary or isVisibleInTranscriptOnly; only the
// fully flagged one is hidden, isHiddenSummary) is no turn the agent started: a half-flagged one of unknown source stays the plain boundary #189 pinned, in every mode.
// R4-F1: does an entry of unknown source carry provenance that says "not the owner's"? Claude Code writes `entrypoint: "cli"` (and userType) on EVERY line of an interactive transcript, and a
// harness line inside the owner's own visible turn (an isMeta skill body or system-reminder note, a `!` block's output, an interrupt marker) has promptSource / origin / turnOrigin null or
// absent: none of that is provenance, so such a line is a plain boundary as before #191 and the request printed after it still binds. What counts: a promptSource, origin or turnOrigin that is
// set (a value this list does not know stays invisible, fail closed) or an entrypoint other than "cli" (a headless sdk-cli is synthetic already, so that is an unknown future one).
// #897: the one exception is the `<bash-stdout>` entry of an owner `!` command: Claude Code now writes turnOrigin "human" (with turnPromptId / turnPosition) on it, and none of promptSource / origin
// (the `<bash-input>` entry before it carries no turnOrigin at all). turnOrigin "human" alone, entrypoint cli or unset, is a plain note: it walks its parentUuid chain like any other, so under an
// invisible headless turn it stays invisible (R5-F1 / #246) and the turns chained through it under the owner's turn are no longer muted. Any other turnOrigin value stays fail-closed.
// R1-B1 (#898): a real stdout entry always has a string parentUuid (its `<bash-input>` entry), and invisibleNote leaves a note with no parentUuid to its own fields (visible), so the exception needs one:
// a turnOrigin-human entry with a null or missing parentUuid has no chain to place it and stays unplaced provenance (invisible).
const isSet = (v) => v !== undefined && v !== null;
const unplacedProvenance = (e) => isSet(e.promptSource) || isSet(e.origin) || isSet(e.turnOrigin) || (isSet(e.entrypoint) && e.entrypoint !== 'cli');
const bangStdout = (e) => e.turnOrigin === 'human' && typeof e.parentUuid === 'string' && !isSet(e.promptSource) && !isSet(e.origin) && (!isSet(e.entrypoint) || e.entrypoint === 'cli');
// What the turn / note classification below uses: unplacedProvenance without the `!` stdout shape. (promptEntryOf's #418 twin check keeps the strict one, so a forged twin of the owner's prompt written with turnOrigin human still reads as two.)
const unplacedTurnProvenance = (e) => unplacedProvenance(e) && !bangStdout(e);
// #253, NOT SUPPORTED: a pre-provenance transcript (Claude Code older than 2.1.258: no prompt carries promptSource, origin, entrypoint or turnOrigin) has nothing to say who wrote a prompt, so
// every one of its prompts is an unplaced note below, and the chain walk of invisibleNote ends at the first prompt, whose parentUuid (the SessionStart attachment, or an entry older than the tail
// window) resolves to no prompt: all of them are hidden and no merge, extra-round or ruling request binds. That is deliberate and fails closed: "no provenance field" must never become authority
// (a hidden headless run is the case it would let through), and no machine here runs such a client. The readers do not exempt such a file; the owner is asked again after upgrading
// (promptProvenance's legacy branch for a stored record predates this and is unchanged). Pinned by test/owner-go-visible-turns.test.mjs (#253).
const unplacedNote = (e) => isPromptEntry(e) && entrySource(e) === 'unknown' && !unplacedTurnProvenance(e) && e.isCompactSummary === undefined && e.isVisibleInTranscriptOnly === undefined;
// #905: a non-owner PLAIN boundary: a prompt entry of unknown source that is neither an unplaced note nor an invisible turn (a half-flagged compaction summary, the #189 boundary). R2-F1: whatever its
// provenance fields (a set but unknown promptSource / turnOrigin does not make a flagged summary an invisible turn, the invisibleTurn exemption needs both flags undefined).
const plainBoundary = (e) => isPromptEntry(e) && entrySource(e) === 'unknown' && (e.isCompactSummary !== undefined || e.isVisibleInTranscriptOnly !== undefined);
const invisibleTurn = (e) => {
  if (!isPromptEntry(e) || visibleSynthetic(e)) return false;
  const source = entrySource(e);
  return source === 'synthetic' || (source === 'unknown' && unplacedTurnProvenance(e) && e.isCompactSummary === undefined && e.isVisibleInTranscriptOnly === undefined);
};
// R5-F1 (Fable): a note of unknown source WITHOUT unplaced provenance (unplacedNote) is visible or not as the turn it ORIGINATES from, the principle of R1-B1 below: a headless run (top prompt
// promptSource sdk, invisible) can write a skill body or system-reminder note whose own fields look interactive (isMeta, null provenance, entrypoint cli), and what it prints after it must not bind.
// Probe, Claude Code 2.1.322, 2026-11-11: `CLAUDE_CODE_ENTRYPOINT=cli claude -p "..."` still wrote entrypoint "sdk-cli" (promptSource "sdk") on all 20 lines, so that override is NOT honoured today;
// the chain rule is defence in depth, so the guarantee does not rest on a field the writing process sets. Machine-wide transcripts carry only entrypoint cli / sdk-cli / sdk-py.
// parent[i] (originsOf): the index of the prompt entry that prompt entry i's parentUuid chain resolves to (-1: it does not). A string parentUuid that resolves nowhere in the window fails closed
// (invisible), and so does a chain that ends at a non-prompt root (e.g. the SessionStart attachment above the /clear caveat and command notes: they sit before the first owner prompt and carry no
// assistant text, so what they mute is never an ask; pinned by R6-F1); only an entry with no parentUuid at all (a legacy transcript) leaves its own fields to decide (visible); a chain of notes
// resolves transitively, a cycle fails closed.
// #246: a visibleSynthetic turn (a task notice, a peer or plugin message: system + cli) is no exception. Its own fields say the interactive UI renders it, but a headless process that was
// started under an invisible turn (an sdk prompt) can write one under ITS prompt, and nothing of that is on the owner's screen. So it follows parent[] like an unplaced note: to a typed owner
// prompt (or any other visible boundary): visible; to an invisible turn: invisible; and ancestry that does not resolve (a parent outside the window, a duplicate uuid, a cycle, a chain that ends
// at a non-prompt root such as a SessionStart attachment with no typed prompt behind it) fails closed. Compaction and `--resume` need nothing here: resolve() in originsOf already steps over
// a compact_boundary / hidden summary by logicalParentUuid, and a resumed session continues the SAME chain through its SessionStart attachments (probed on 2.1.3xx transcripts), so both reach
// the typed prompt behind them. An entry with no parentUuid at all (not even null) leaves its own fields to decide, as an unplaced note does. The walk keeps a visited set and `memo` (index ->
// verdict, shared across the calls of one lastReply), so n chained notes cost O(n), not O(n^2).
// R2-B1 / R3-B1 (#898): a chain that passes through a `!` stdout entry (bangStdout: it carries turnOrigin) must end at a known turn (the owner's typed prompt: entrySource 'owner'), never at the parentless fallback
// or a plain boundary: the memo keeps { hidden, bare } (bare: the verdict is visible, but the walk did not end at an owner prompt), and every entry of a walk from the stdout entry down to it is hidden when its end is bare. The bare note itself (an ancestor) keeps its verdict.
// #905: a NON-owner plain boundary (a prompt entry of unknown source that is no unplaced note: e.g. a half-flagged compaction summary, the #189 boundary) is no known turn either, so it no longer ends the walk visible
// on its own fields: it walks its parentUuid chain like an unplaced note. A string parentUuid that resolves continues to the parent; no string parentUuid, a parent outside the window / unresolved, or a cycle is
// hidden (fail closed), and so is a parent that does not precede the entry (R1-B3). Only the owner's own prompt (entrySource 'owner') ends the walk as a known turn, so a request under a parentless half-flagged summary binds nothing; the #189 rule that such a summary stays a
// boundary (a request ABOVE it never survives it) is unchanged: replyOf keeps such a boundary a reply slot in every mode, blank when hidden (nothing under it binds), and a walk that ends bare cuts it like a `!` stdout entry (it is no known turn).
function invisibleNote(entries, parent, first, memo = new Map()) {
  const path = [];
  const seen = new Set();
  let verdict;
  let bare = false;
  for (let i = first; verdict === undefined; ) {
    if (memo.has(i)) { ({ hidden: verdict, bare } = memo.get(i)); break; }
    const e = entries[i];
    path.push(i);
    seen.add(i);
    if (invisibleTurn(e)) verdict = true;
    else if (entrySource(e) === 'owner') verdict = false; // the owner's own prompt: the one known turn (R3-B1)
    else if (typeof e.parentUuid !== 'string') { if (unplacedNote(e) || visibleSynthetic(e)) { verdict = false; bare = true; } else verdict = true; } // no chain: only an unplaced note / visibleSynthetic turn keeps the legacy parentless rule; a plain boundary fails closed (#905)
    else if (parent[i] < 0 || parent[i] >= i || seen.has(parent[i])) verdict = true; // a parent outside the window / unresolved, one that does not PRECEDE the entry (R1-B3: the owner's later answer is no ancestor), or a cycle
    else i = parent[i];
  }
  let cut = -1; // the deepest `!` stdout entry on the path: it and everything chained through it is hidden when the walk ended bare
  if (bare) path.forEach((i, k) => { if (bangStdout(entries[i]) || plainBoundary(entries[i])) cut = k; });
  path.forEach((i, k) => memo.set(i, k <= cut ? { hidden: true, bare: false } : { hidden: verdict, bare }));
  return cut >= 0 ? true : verdict;
}

// The parsed entries of the transcript's last `tailBytes` (a cut first line dropped) and whether the read reached the file's start (#191 A3, F7: callers read `.entries`);
// no entries when it cannot be read as a regular file.
function tailEntries(transcriptPath, tailBytes) {
  let raw = '';
  let reachedStart = true;
  try {
    if (!lstatSync(transcriptPath).isFile()) return { entries: [], reachedStart: false };
    const fd = openSync(transcriptPath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    try {
      const size = fstatSync(fd).size;
      const len = Math.min(size, tailBytes);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      raw = buf.toString('utf8');
      if (len < size) { raw = raw.slice(raw.indexOf('\n') + 1); reachedStart = false; } // drop the cut first line
    } finally {
      closeSync(fd);
    }
  } catch {
    return { entries: [], reachedStart: false };
  }
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* a torn line */ }
  }
  return { entries, reachedStart };
}

// The text of the last assistant reply in the transcript when it holds a 🔀 merge request ('' when none). Only the
// transcript's last 4 MB are read. A reply is every assistant text block between two prompts.
// `prompt` is the text being submitted (the UserPromptSubmit hook's input.prompt). Why (#58 round 3): the hook may run before or after the
// transcript gets that prompt, so the newest prompt entry is "the current one" (its empty slot skipped) only when its text IS that prompt;
// any other newest prompt is an older, unanswered one, and the empty reply slot after it is the reply to use: no request, the one before is stale.
// Without `prompt` the newest prompt entry is taken to be the current one.
export function lastRequestText(transcriptPath, opts = {}) {
  const text = lastReplyText(transcriptPath, opts);
  return READY_LINE.test(text) ? text : '';
}
// The same reply, whatever it ends with ('' when there is none).
// #128 skipSynthetic (rulings only; a merge request stays strict): a prompt entry whose METADATA says synthetic (entrySource, never its
// text) opens no reply slot, and every assistant text after it up to the next other prompt is dropped, so the owner can answer a ruling
// ask after a background notice the agent answered without text, and nothing the agent prints in such a reply binds. An owner prompt
// or one of unknown source is a boundary as before, so a pasted `<task-notification>` typed by the owner keeps its boundary.
// R1-F3 / R2-F2 / R3-B2 (the limit, owner decision 2026-11-03): a dropped reply may itself have shown a NEWER ask (the agent can start a synthetic turn at will, with a background
// task), and the owner answers the ask they last saw. The agent is the untrusted party and picks its wording ("For #59, what is your ruling on the first blocker?", "Tell me
// what to do about it"), so no test of WHAT the reply says can be complete: ANY non-empty text in a dropped reply voids the pending slot: '' (the owner is asked again, the nudge
// fires). The cost is one re-ask; a harness turn the agent answers with tool calls only (no text) leaves the ask standing, which is what skipSynthetic is for.
// R4-F3 (owner decision 2026-11-03): a tool-only reply can still SURFACE a newer ask, in the tool call (a Bash `ruling-request` command, an echoed
// ruling line) or in its result (a user entry with a tool_result block, which the owner sees in the tool box): a tool_use input or a tool_result that contains a ruling line,
// a merge line or a `head <sha> · items` line, or the command name `ruling-request`, voids the slot like text does.
// R5-B2 (owner decision 2026-11-04, option b): those canonical lines are NOT all the agent can show. It writes a tool_use input itself (`echo 'For PR #59, please answer R1-B1: accept or reject'`),
// so no fixed wording test is complete there either (the premise of R4-F3, that the lines are machine-printed, holds only for a result). A middle ground between voiding every tool-only reply
// (which would end skipSynthetic) and a wording test: tool input or result that ALSO holds a finding id, a PR reference, a decision word or a question mark voids the slot. The cost is one
// re-ask; a tool-only reply without any of them (`ls` and `file.txt`) still leaves the ask standing.
const showsText = (text) => text.trim() !== '';
const SURFACED_ASK = new RegExp(`Owner ruling needed\\s+#\\d|ruling-request|${READY_LINE.source}`, 'iu'); // (case-insensitive like RULING_LINE and HEAD_LINE: a detector narrower than the parsers lets a differently-cased ask through)
const ASK_WORDS = /(?<![\w])R\d{1,4}-[A-Za-z]{1,8}\d{1,4}(?![\w])|#\d|(?<![\w])PR\s*#?\d|(?<![\w])(?:accept|reject|follow-?up)(?![\w])|\?/iu; // (a finding id as ITEM_ID spells it, #N / PR N, a decision word, a question mark)
const surfacesAsk = (text) => SURFACED_ASK.test(text) || ASK_WORDS.test(text) || text.split(/\r?\n/).some((l) => HEAD_LINE.test(l));
// The text of a tool_result block's content (a string, or text blocks), or of a tool_use block's input.
const toolResultText = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (typeof x === 'string' ? x : typeof x?.text === 'string' ? x.text : '')).join('\n') : '');
// A tool_use input as the owner reads it: the DECODED string values, one per line (JSON.stringify would re-escape a tab or a newline in a command to `\t` / `\n`, so a ruling
// line with a tab, or a `head … · items …` line inside a heredoc, would not be seen). Depth and total length are bounded; an input past either bound cannot be searched
// whole, and the agent writes it, so it fails closed: null, which voids the slot like a surfaced ask (padding must not hide a ruling line past the bound).
const TOOL_INPUT_MAX_DEPTH = 8;
const toolUseText = (input) => {
  const out = [];
  let size = 0;
  let over = false;
  const walk = (v, depth) => {
    if (over || v === null || v === undefined) return;
    if (size > MAX_RECORD_BYTES || depth > TOOL_INPUT_MAX_DEPTH) { over = true; return; }
    if (typeof v === 'string') { out.push(v); size += v.length; if (size > MAX_RECORD_BYTES) over = true; return; }
    if (typeof v !== 'object') return;
    for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x, depth + 1);
  };
  try { walk(input, 0); } catch { return null; }
  return over ? null : out.join('\n');
};
const inputSurfacesAsk = (input) => { const text = toolUseText(input); return text === null || surfacesAsk(text); };

// #741 (B1b): what the live-database readers (the typed go's recorder and claim, and the click claim) add to the ruling reader's rules: a tool block of another visible turn that shows a block counts as shown.
// A tool input or result that shows a live-database block, its binding or apply line, or a go word: what the owner may have answered instead of the block in the reply text (a stale-ask detector, like surfacesAsk).
const LIVE_SURFACED = /Live-DB (?:migration|data) · project |🗄️ Apply to LIVE |go (?:migration|data) /iu;
export const liveDbSurfaced = (text) => LIVE_SURFACED.test(String(text ?? ''));
const liveInputSurfaces = (input) => { const text = toolUseText(input); return text === null || liveDbSurfaced(text); };
const liveResultSurfaces = (b) => b?.type === 'tool_result' && liveDbSurfaced(toolResultText(b.content));
const blockSurfaces = (b) => (b?.type === 'tool_use' && liveInputSurfaces(b.input)) || liveResultSurfaces(b);
// #189 (owner decision, plan docs/plans/2026-11-06-followups-185-188-ruling-compaction.md section 3): a context compaction is transparent. Claude Code writes the summary of the
// earlier conversation as a `user` entry (string content, no promptSource / origin) after a `compact_boundary`; it is a prompt entry to isPromptEntry and of source 'unknown', so
// it used to open a new, empty reply slot between an ask and the owner's answer, and the ask was lost. Such an entry is skipped by every reader: it opens no slot, adds no text and
// changes neither `skipping` nor `lastIsPrompt`. Its text is model text (it may quote an old ruling line or 🔀 line), so counting it as a reply would revive an ask that was already answered.
// Fable plan pass finding 3: skipped only when BOTH `isCompactSummary` and `isVisibleInTranscriptOnly` are exactly true (the owner never sees it as a turn); a summary missing either flag
// is a prompt like any other (a boundary), which is today's behaviour. Nothing here lets a compaction ADD an owner word: the answer is still the typed prompt the hook records.
const isHiddenSummary = (e) => e?.type === 'user' && e.isCompactSummary === true && e.isVisibleInTranscriptOnly === true;
// The newest user/assistant entry when it is a prompt whose text is `prompt` (the submission being recorded, already in the transcript), else null.
function currentPromptEntry(transcriptPath, prompt) {
  const { entries } = tailEntries(transcriptPath, TRANSCRIPT_TAIL_BYTES);
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if ((e?.type !== 'user' && e?.type !== 'assistant') || isHiddenSummary(e)) continue;
    return isPromptEntry(e) && promptTextOf(e) === plain(prompt) ? e : null;
  }
  return null;
}
// The same reply as lastReplyText, with whether it is a PROMOTED synthetic-turn ask (see below): { text, promoted }.
// #189 (Fable plan pass finding 1) synthetic-turn promotion, rulings only (skipSynthetic): the agent can write its ask inside a turn the harness started (a subagent hand-back, a task
// notice): then the owner SAW the ask, since the interactive UI renders those turns, and answers it. R1-F3 ("any text in a dropped reply voids the slot") made that answer unrecordable.
// The ordered rule, per synthetic turn, entries in transcript order (Codex plan review P1): state `text` (the turn's assistant text), `surfacedAfterText`, `anything`; an assistant text
// block adds to `text` and clears `surfacedAfterText`; a tool_use input or tool_result that surfaces an ask (inputSurfacesAsk / surfacesAsk, unchanged) sets `surfacedAfterText`; either sets
// `anything`. The turn ends at the next prompt entry of ANY source and at the end of the entries (so an answer not yet appended sees what an appended one does). At its end: when
// presentedRuling(text) is not null and nothing surfaced after that text, the turn becomes a new reply slot holding the text, exactly as if the owner had started it; else when anything
// was shown the slot before it is voided (R1-F3, R4-F3, R5-B2 unchanged); else (tool-only, nothing surfaced) the slot stands. So a `ruling-request` call, its result and then the canonical
// line is promoted (the line came last), the line followed by a tool output asking about another PR is voided (the last thing shown was not the line), and a later synthetic turn
// with text voids an earlier promoted slot while a tool-only one leaves it. Why this is no weaker: the ask was agent-written in either kind of turn; what binds is the owner's TYPED answer
// (entrySource 'owner', promptProvenance at use time), the ids on the last line and the content digest owner-ruling recomputes. The slot binds only its own PR / ids / digest.
// This narrows R1-F3; the PR calls it out for the owner.
// Only a visibleSynthetic prompt entry (promptSource 'system' AND entrypoint 'cli': a notice the interactive UI renders) promotes. An 'sdk' / 'sdk-cli' turn (a headless `claude -p --resume` of this
// session writes into the owner's transcript and shows nothing on screen), any other non-human origin and an unknown source keep R1-F3: ANY text voids the slot.
// #191 A2 (every other reader, skipSynthetic false: merge, extra round): an invisible turn is a boundary as before (it opens a new EMPTY slot, so an older request stays stale) but its
// assistant text is never added to that slot, so nothing an invisible turn prints can be bound by the owner's next "merge" / "extra round" (the owner never saw it); the owner is asked again.
// #191 A3 (cut-off origin, all modes): the tail read starts at an arbitrary byte, so the text before the window's first prompt entry (slot 0) belongs to a turn whose prompt was cut off
// and whose origin is unknown; slot 0 is never a reply (in a whole file it is text before any prompt, which a real transcript does not hold). Accepted cost: an ask turn longer than
// the window is refused once and the re-ask recovers.
// Queued answers (#189 finding 2, widened by #191 Part B): the result says which slot is a promoted ask (recordRuling stamps `ask_turn: 'synthetic'` on its record). An owner prompt typed while the
// agent was busy (promptSource 'queued') is delivered after a promoted ask the owner never saw, or after an owner-turn ask newer than what was on screen: the recorders refuse it (queuedAnswer) and
// promptProvenance refuses its record at use time, for every kind of ask.
// #191 R1-B1 (Codex round 1, arbiter ACCEPT): attribution by ORIGINATING PROMPT, not by position. A headless `claude -p --resume <session>` process (invisible) can still be running when
// the owner types: what it appends AFTER the owner's prompt (or between the owner's interactive reply entries) used to join the owner's slot, and the LAST 🔀 / ⚖️ / 🔁 line won, so an
// invisible request beat the one the owner was shown. Claude Code writes `uuid` and `parentUuid` on every entry (confirmed on test/fixtures/transcripts/*.jsonl, 8 of 8 files carry both),
// and each process chains its entries to its own prompt, so originsOf walks parentUuid back from an assistant entry (or a tool_result user entry, which the ruling reader inspects) to the
// first prompt entry and the text joins THAT prompt's slot:
//  - the slot read is still the positional one: the newest slot before the owner's current prompt (older slots are never revived), but a slot is its prompt's own text wherever it sits
//    (interleaving 1: an sdk prompt BEFORE the owner's, its text after the interactive reply; interleaving 2: an sdk prompt written during the interactive reply);
//  - an invisible turn's text (merge / round mode) is never any slot's; in ruling mode it is that synthetic turn's content (it voids the slot before ITS prompt when it shows anything,
//    never promotes unless it is a visibleSynthetic turn) and never the owner slot's;
//  - an invisible turn that opens AFTER the last activity of the slot being read makes it stale (the strict A2 rule, unchanged: an older ask is not revived across a hidden turn); one that
//    opened while the slot was still being written (interleaved) does not, because the owner's turn went on after it;
//  - late text from an older VISIBLE turn that arrives after a newer prompt joins that older slot: it is not the slot right before the owner's prompt, so it binds nothing. R2-B1 (Codex
//    round 2, arbiter ACCEPT): but the owner SAW it, and when it lands after the selected slot's last entry (and before the owner's prompt) the last thing displayed was not the selected
//    request, so the selected slot is stale and the reply is '' (fail closed, like a mute). Text from any visible slot other than the selected one counts (assistant text only: a tool-only
//    entry shows nothing); text that landed BEFORE the selected slot's last entry (interleaved) does not. A single interactive session cannot produce this order, so normal use is unchanged;
//    R3-B1: "the selected slot's last entry" is its last SHOWN one (its last assistant text), so its own trailing tool-only entry cannot hide a later request; #241: a tool block of another visible slot
//    that surfaces an ask counts as shown too; R3-F1: so does a visibleSynthetic skip turn's text or surfaced ask (ruling reader), whenever its prompt opened;
//  - (a void by a synthetic turn that shows something after the slot's last activity is the separate ruling-mode rule above);
//  - an entry whose chain does not resolve to a prompt entry inside the window (no parentUuid, a uuid not in the window, a cycle, a duplicate uuid on the way, a chain that ends at no prompt)
//    is DROPPED in a modern transcript (fail closed; subsumes A3 for assistant text, whose prompt was cut off by the window). A compaction is transparent to the walk: a hidden summary and
//    a `compact_boundary` system entry are stepped over (the boundary has parentUuid null and logicalParentUuid the entry before it); a boundary whose past is outside the window drops.
//  - a LEGACY transcript, no entry of which has a uuid, keeps the positional attribution (text belongs to the newest prompt before it). The fallback is keyed on that absence only, never on
//    anything the agent can print: one entry with a uuid anywhere in the window makes it modern.
// Residual: a process that chains its entries to the owner's prompt on purpose would still be attributed to it; that takes writing the transcript file itself (guard-files refuses a tool write).
function originsOf(entries) {
  const origin = new Array(entries.length).fill(-1); // entry index -> index of its originating prompt entry (-1: none)
  const forward = new Array(entries.length).fill(false); // R3-B1: entry index -> its chain was rejected by the order rule (a forward link): unbindable, but what it shows still counts as shown
  const parent = new Array(entries.length).fill(-1); // prompt entry index -> index of the prompt its parentUuid chain resolves to (-1: none; R5-F1)
  const isPrompt = (e) => isPromptEntry(e) && !isHiddenSummary(e);
  if (!entries.some((e) => typeof e?.uuid === 'string')) {
    let latest = -1;
    entries.forEach((e, i) => { if (isPrompt(e)) latest = i; origin[i] = latest; });
    return { origin, parent, forward };
  }
  const at = new Map(); // uuid -> entry index
  const twice = new Set(); // a uuid two entries claim: any chain through it is ambiguous
  entries.forEach((e, i) => { if (typeof e?.uuid === 'string') { if (at.has(e.uuid)) twice.add(e.uuid); else at.set(e.uuid, i); } });
  const memo = new Map(); // uuid -> origin found from there (-1: none, FORWARD: rejected by the order rule)
  const FORWARD = -2;
  // R2-B2: the order rule holds at every hop: a parent must PRECEDE the entry that names it (a transcript never links forward), through non-prompt entries too; a forward link fails closed (-1).
  // R3-B1: it denies ANCESTRY only: the walk reports FORWARD (-2) for that class (memoised along the path, so an entry chained through a forward-linked one is in it too), which the caller keeps unbindable (-1)
  // and flags in `forward`; the other unplaceable kinds (no parent, outside the window, a cycle, a duplicate uuid) stay -1 and flagged nowhere.
  const resolve = (first, child) => {
    const path = [];
    const seen = new Set();
    let id = first;
    let found = -1;
    let from = child;
    while (typeof id === 'string') {
      if (at.has(id) && at.get(id) >= from) { if (at.get(id) > from) found = FORWARD; break; } // (an entry naming itself is a cycle, not a forward link)
      if (memo.has(id)) { found = memo.get(id); break; }
      if (seen.has(id) || twice.has(id) || !at.has(id)) break;
      seen.add(id);
      path.push(id);
      const j = at.get(id);
      const n = entries[j];
      from = j;
      if (isPrompt(n)) { found = j; break; }
      const compaction = isHiddenSummary(n) || (n?.type === 'system' && n.subtype === 'compact_boundary');
      id = typeof n?.parentUuid === 'string' ? n.parentUuid : compaction && typeof n?.logicalParentUuid === 'string' ? n.logicalParentUuid : null;
    }
    for (const u of path) memo.set(u, found);
    return found;
  };
  entries.forEach((e, i) => {
    const found = resolve(e?.parentUuid, i);
    const placed = found === FORWARD ? -1 : found;
    if (isPrompt(e)) { origin[i] = i; parent[i] = placed; } else { origin[i] = placed; forward[i] = found === FORWARD; }
  });
  return { origin, parent, forward };
}

// #741 (B1b) `liveDb` (the live-database readers only; the ruling reader and every other caller are unchanged): a tool input or result of any OTHER visible turn that shows a live-database block, its binding or apply
// line or a go word counts as shown (liveDbSurfaced), so a later request of the selected turn is stale.
export function lastReply(transcriptPath, { tailBytes = TRANSCRIPT_TAIL_BYTES, prompt, skipSynthetic = false, liveDb = false } = {}) {
  return replyOf(tailEntries(transcriptPath, tailBytes).entries, { prompt, skipSynthetic, liveDb });
}
function replyOf(entries, { prompt, skipSynthetic = false, liveDb = false } = {}) {
  const { origin, parent, forward } = originsOf(entries);
  const verdicts = new Map(); // memoised hidden(i), shared by every chain walk (#246)
  const hidden = (i) => invisibleNote(entries, parent, i, verdicts);
  // The turns, one per prompt entry (a hidden compaction summary is none), each with the entries attributed to it, in transcript order. pos / lastPos: the entry index of its prompt / of its last entry.
  const turns = [];
  const turnAt = new Map(); // prompt entry index -> turn
  const strays = []; // R3-B1: positions of forward-linked entries (order rule) that show text or an ask: never bound to a turn, but shown to the owner
  entries.forEach((e, i) => {
    const content = e?.message?.content;
    if (e?.type === 'user' && isHiddenSummary(e)) return;
    if (e?.type === 'user' && isPromptEntry(e)) {
      // skip (ruling reader): a turn whose prompt the owner did not type; mute (every other reader): an invisible turn, a boundary whose text is never added (#191 A2); slot: everything else
      // #905: a hidden plain boundary stays a slot (it ends the slot before it, as on the base) but a blank one: nothing printed under it is a request
      const blank = plainBoundary(e) && hidden(i);
      const kind = plainBoundary(e) ? 'slot' : skipSynthetic ? (entrySource(e) === 'synthetic' || hidden(i) ? 'skip' : 'slot') : hidden(i) ? 'mute' : 'slot';
      const t = { pos: i, e, kind, blank, content: [], lastPos: i, textPos: -1, shownPos: -1 };
      turns.push(t);
      turnAt.set(i, t);
    } else if ((e?.type === 'user' || e?.type === 'assistant') && Array.isArray(content)) {
      const t = turnAt.get(origin[i]);
      if (!t && forward[i] && content.some((b) => (e.type === 'assistant' && b?.type === 'text' && typeof b.text === 'string' && showsText(b.text)) || (b?.type === 'tool_use' && inputSurfacesAsk(b.input)) || (b?.type === 'tool_result' && surfacesAsk(toolResultText(b.content))) || (liveDb && blockSurfaces(b)))) strays.push(i);
      if (t) { // (no turn: an unresolved chain, or text before the window's first prompt: dropped)
        t.content.push(e);
        t.lastPos = i;
        const text = e.type === 'assistant' && content.some((b) => b?.type === 'text' && typeof b.text === 'string' && showsText(b.text));
        if (text) t.textPos = i;
        // #241: what the owner can read is the text AND a tool block that surfaces an ask (the detectors the ruling reader uses below)
        if (text || content.some((b) => (b?.type === 'tool_use' && inputSurfacesAsk(b.input)) || (b?.type === 'tool_result' && surfacesAsk(toolResultText(b.content))) || (liveDb && blockSurfaces(b)))) t.shownPos = i;
      }
    }
  });
  // The reply slots: what the owner's "merge" / "extra round" / ruling can answer, in prompt order. A skipped turn (ruling reader) is promoted into one (#189) or voids the slot before it (R1-F3..R5-B2, below).
  const slots = [];
  const mutes = []; // positions of the invisible prompts (merge / round readers)
  const shownSkips = []; // R3-F1: the last shown position of each visibleSynthetic skip turn that was not promoted
  for (const t of turns) {
    if (t.kind === 'mute') { mutes.push(t.pos); continue; }
    if (t.kind === 'slot') {
      let text = '';
      if (!t.blank) for (const e of t.content) if (e.type === 'assistant') for (const b of e.message.content) if (b?.type === 'text' && typeof b.text === 'string') text += `${b.text}\n`;
      slots.push({ turn: t, lastPos: t.lastPos, text, promoted: false, voided: false });
      continue;
    }
    // a skipped turn: the order of its entries decides (see the promotion rule above)
    let text = '';
    let surfacedAfterText = false;
    let anything = false;
    for (const e of t.content) {
      if (e.type === 'user') {
        if (e.message.content.some((b) => b?.type === 'tool_result' && (surfacesAsk(toolResultText(b.content)) || (liveDb && blockSurfaces(b))))) { surfacedAfterText = true; anything = true; }
        continue;
      }
      for (const b of e.message.content) {
        if (b?.type === 'text' && typeof b.text === 'string' && showsText(b.text)) { text += `${b.text}\n`; surfacedAfterText = false; anything = true; }
        else if (b?.type === 'tool_use' && (inputSurfacesAsk(b.input) || (liveDb && blockSurfaces(b)))) { surfacedAfterText = true; anything = true; }
      }
    }
    const visible = visibleSynthetic(t.e) && !hidden(t.pos); // (#246: a system turn written under an invisible one is on nobody's screen)
    if (visible && !surfacedAfterText && presentedRuling(text) !== null) slots.push({ turn: t, lastPos: t.lastPos, text, promoted: true, voided: false });
    else if (anything) {
      const before = slots[slots.length - 1];
      if (before && before.lastPos < t.pos) before.voided = true; // (a slot still being written when this turn opened was not replaced by it: interleaved, not later)
      // R3-F1: ... but a VISIBLE synthetic turn's text or surfaced ask is on the owner's screen wherever its prompt opened: when it lands after the selected slot's last shown entry (checked below),
      // that request is stale. An invisible turn (sdk, non-human origin, unknown source) is never shown, so the interleaved exemption above stays for it.
      if (visible) shownSkips.push(t.shownPos);
    }
  }
  // Only the reply slot right before the owner's prompt: when the newest prompt IS that prompt (and nothing answered it yet), its own (empty) slot is skipped, and that is the ONLY slot that
  // may be. A later prompt plus a text-less assistant turn (tool calls only) leaves the old request stale, and an older request is never revived by a later "merge": the agent shows it again.
  const newest = [...turns].reverse().find((t) => t.kind !== 'skip');
  // R2-B1: a flagged summary (plainBoundary) is never the current submission, whatever its text: a hidden one whose text equals the answer must not hide the request above it. (A legacy typed prompt of unknown source still is one.)
  const current = newest?.kind === 'slot' && !plainBoundary(newest.e) && newest.content.length === 0 && (prompt === undefined || plain(prompt) === promptTextOf(newest.e));
  const candidates = current ? slots.filter((x) => x.turn !== newest) : slots;
  const last = candidates[candidates.length - 1]; // (none: only text before the window's first prompt, which has no known origin, A3)
  // R2-B1: assistant text of ANY other visible slot after the selected slot's last SHOWN entry was the last thing the owner was shown: the selected request is stale, exactly like a mute.
  // R3-B1: the selected slot's last shown entry is its last assistant text (textPos), not lastPos: a tool-only entry or a tool result of the selected slot shows nothing and must not hide
  // a later request of another slot. #241: a tool block of another visible slot that surfaces an ask (shownPos) counts as shown too, not the selected slot's own. R3-F1: so does a visibleSynthetic skip turn's.
  const shownAfter = !last || candidates.some((x) => x !== last && x.turn.shownPos > last.turn.textPos) || shownSkips.some((pos) => pos > last.turn.textPos) || strays.some((pos) => pos > last.turn.textPos);
  if (!last || last.voided || shownAfter || mutes.some((pos) => pos > last.lastPos)) return { text: '', promoted: false };
  return { text: last.text, promoted: last.promoted };
}
export const lastReplyText = (transcriptPath, opts = {}) => lastReply(transcriptPath, opts).text;

// #262 (Fable F5): the reply slot right BEFORE the prompt entry with that promptId, read as it stood when the owner typed (the ruling reader's rules: skipSynthetic), whatever came after:
// the live-database claim rebuilds the block the owner was shown from it, so a record a script appended with a different hash than that block fails. { text } | { reason }.
// (A bigger window than the recorders': the claim can come up to two hours after the prompt.)
const REPLY_BEFORE_TAIL_BYTES = 16 * 1024 * 1024;
export function replyBefore(transcriptPath, promptId, { tailBytes = REPLY_BEFORE_TAIL_BYTES } = {}) {
  if (typeof promptId !== 'string' || promptId === '') return { reason: 'the record has no prompt id' };
  const entries = tailEntries(transcriptPath, tailBytes).entries;
  const at = [];
  entries.forEach((e, i) => { if (isPromptEntry(e) && e.promptId === promptId) at.push(i); });
  if (at.length === 0) return { reason: 'the owner\'s prompt is not in the transcript window' };
  if (at.length > 1) return { reason: 'two prompt entries carry that prompt id' };
  return { text: replyOf(entries.slice(0, at[0] + 1), { prompt: promptTextOf(entries[at[0]]), skipSynthetic: true, liveDb: true }).text };
}

// #262 (R6-F1): what the owner could read right BEFORE an AskUserQuestion call: the assistant text of the call's own turn (the entries that chain to the same prompt as the tool_use entry, in transcript
// order, plus the text blocks of the tool_use entry itself that come before the tool_use block). The live-database click claim requires it to end with the block the dialog carries, as the typed
// go does. A text another turn printed between that text and the call (an interleaved process the owner may have seen) is a refusal, never skipped. { text } | { reason }.
// #741 (B1b): only the text AFTER the turn's last tool_result before the dialog counts (an older block earlier in the turn is not what the owner was last shown); the dialog's turn must be one the owner sees
// (the typed reader's own test: invisibleNote, ancestry fails closed); another visible turn's tool input or result that shows a live-database block between the reply and the dialog is a refusal too; and no text at
// all says so, naming the case where Claude Code recorded only a progress note (a `thinking` block). `missing`: the call is not in the transcript (yet): a caller that checks early stays silent then.
export function replyBeforeToolUse(transcriptPath, toolUseId, { tailBytes = REPLY_BEFORE_TAIL_BYTES } = {}) {
  if (typeof toolUseId !== 'string' || toolUseId === '') return { reason: 'the click has no tool use id' };
  const entries = tailEntries(transcriptPath, tailBytes).entries;
  const blocksOf = (e) => (Array.isArray(e?.message?.content) ? e.message.content : []);
  const at = [];
  entries.forEach((e, i) => { if (e?.type === 'assistant' && blocksOf(e).some((b) => b?.type === 'tool_use' && b.id === toolUseId)) at.push(i); });
  if (at.length === 0) return { reason: 'the AskUserQuestion call is not in the transcript window', missing: true };
  if (at.length > 1) return { reason: 'two entries carry that tool use id' };
  const { origin, parent } = originsOf(entries);
  const useAt = at[0];
  if (origin[useAt] < 0) return { reason: 'the AskUserQuestion call does not chain to a prompt in the transcript window' };
  const verdicts = new Map();
  if (invisibleNote(entries, parent, origin[useAt], verdicts)) return { reason: 'the dialog\'s turn is not one the owner sees (a headless or hidden turn, or one whose origin cannot be resolved)' };
  const textOf = (e, until = Infinity) => {
    let t = '';
    for (const b of blocksOf(e).slice(0, until)) if (b?.type === 'text' && typeof b.text === 'string') t += `${b.text}\n`;
    return t;
  };
  let resultAt = origin[useAt]; // the turn's last tool_result before the dialog: what came before it is not the reply
  for (let i = origin[useAt] + 1; i < useAt; i++) if (entries[i]?.type === 'user' && origin[i] === origin[useAt] && blocksOf(entries[i]).some((b) => b?.type === 'tool_result')) resultAt = i;
  let text = '';
  let lastTextAt = -1;
  let progressNote = false;
  for (let i = resultAt + 1; i <= useAt; i++) {
    const e = entries[i];
    if (origin[i] !== origin[useAt]) {
      // R1-B5: another turn's text, or a live-database block it showed, inside the window: what was printed before it is not what the owner was last shown, so the pieces on either side are never joined
      const visible = origin[i] < 0 || !invisibleNote(entries, parent, origin[i], verdicts);
      if ((e?.type === 'assistant' && showsText(textOf(e))) || (visible && blocksOf(e).some(blockSurfaces))) { text = ''; lastTextAt = -1; }
      continue;
    }
    if (e?.type !== 'assistant') continue;
    const t = i === useAt ? textOf(e, blocksOf(e).findIndex((b) => b?.type === 'tool_use' && b.id === toolUseId)) : textOf(e);
    if (showsText(t)) lastTextAt = i;
    // R1-B1 / R2-F1: a real progress note is a NON-EMPTY `thinking` block, before the target call, on an entry Claude Code marks staysIfReplyIsCut. (`thinkingDisplay: "updates"` is also on ordinary hidden
    // reasoning, whose `thinking` is empty, so it proves nothing.) Hidden or redacted reasoning is not a note.
    const before = i === useAt ? blocksOf(e).slice(0, blocksOf(e).findIndex((b) => b?.type === 'tool_use' && b.id === toolUseId)) : blocksOf(e);
    if (e.staysIfReplyIsCut === true && before.some((b) => b?.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim() !== '')) progressNote = true;
    text += t;
  }
  for (let i = Math.max(lastTextAt, origin[useAt]) + 1; i < useAt; i++) {
    const e = entries[i];
    if (origin[i] === origin[useAt]) continue;
    if (e?.type === 'assistant' && showsText(textOf(e))) return { reason: 'another turn printed text between the reply and the dialog' };
    const visible = origin[i] < 0 || !invisibleNote(entries, parent, origin[i], verdicts); // (an entry that chains to no prompt fails closed: it counts)
    if (visible && blocksOf(e).some(blockSurfaces)) return { reason: 'another turn showed a live-database block between the reply and the dialog' };
  }
  // (#983: `progressNote` lets the live-database claim accept the click on the dialog's own block when only a progress note was recorded before the call; every other caller treats it as a refusal)
  if (!showsText(text)) return progressNote ? { reason: 'no reply text before the dialog (Claude Code recorded only a progress note)', progressNote: true } : { reason: 'no reply text before the dialog' };
  return { text };
}

// ---- #128: is this prompt the owner's words? --------------------------------------------------------------------------------------

// The openings of a prompt the harness (or another model) writes: a background-task notice, a system reminder, another session's or
// subagent's message, a plugin's. (The hook may run before the transcript has the entry, so the text is read too: a prompt the owner pastes
// that opens this way is not recorded either, and the owner is asked again.) And the blocks Claude Code writes for `!` commands and slash commands.
const ENVELOPE_START = /^(?:<task-notification>|<system-reminder>|Another Claude session sent a message:|The [\w.-]{1,64} plugin sent a message:)/;
const SHELL_BLOCK_OPEN = /^<(bash-input|bash-stdout|bash-stderr|local-command-stdout|local-command-stderr|local-command-caveat|command-name|command-message|command-args)>/;
function onlyShellBlocks(text) {
  let rest = text.trim();
  if (rest === '') return false;
  while (rest !== '') {
    const m = SHELL_BLOCK_OPEN.exec(rest);
    const end = m ? rest.indexOf(`</${m[1]}>`, m[0].length) : -1;
    if (end < 0) return false;
    rest = rest.slice(end + m[1].length + 3).trimStart();
  }
  return true;
}
const textEnvelope = (prompt) => {
  const t = String(prompt ?? '').trim();
  return ENVELOPE_START.test(t) || onlyShellBlocks(t);
};

// Is the CURRENT submission already in the transcript as a synthetic entry? The newest user/assistant entry must be a prompt (no reply after
// it: lastReplyText's `current`) whose text is this prompt. An older entry with the same text that has been answered lends nothing.
function currentEntryIsSynthetic(transcriptPath, prompt) {
  const e = currentPromptEntry(transcriptPath, prompt); // (#189: a compaction summary in between is skipped, as in lastReply)
  return e !== null && entrySource(e) === 'synthetic';
}

// "Never record this prompt" (both recorders; the safe side is to record less). True when the hook input itself says it is not typed
// (no such field is known to exist, so this is future-proofing), when the transcript already holds this submission as a synthetic entry, or
// when the text is a harness envelope. A genuine owner answer lost to a false match is asked again (the hook's nudge), never silently taken.
export function notOwnerWords(input, transcriptPath) {
  const kind = input?.origin?.kind;
  if ((typeof kind === 'string' && kind !== '' && kind !== 'human') || input?.promptSource === 'system' || input?.promptSource === 'sdk' || input?.isMeta === true) return true;
  if (textEnvelope(input?.prompt)) return true;
  return currentEntryIsSynthetic(transcriptPath, input?.prompt);
}

// #191 Part B: the owner typed this answer while the agent was still working (promptSource 'queued'). Claude Code delivers such a prompt after everything the agent printed meanwhile, so it
// is read as the answer to the LAST ask of that reply, which may be newer than what the owner had on screen when typing; the transcript cannot tell (the queue-operation entries are no
// record of when the owner typed). So it records nothing and approves nothing, for a "merge", an "extra round" and a ruling alike: the agent shows the request again, the owner answers once more.
// True only when the transcript already holds the entry; for a hook that runs before it does, promptProvenance refuses the record at use time.
export const queuedAnswer = (input) => currentPromptEntry(String(input?.transcript_path ?? ''), input?.prompt)?.promptSource === 'queued';

// Is this hook input a subagent's (or not a prompt at all)? Those never approve anything.
export function notOwnerPrompt(input) {
  if (input?.hook_event_name !== undefined && input.hook_event_name !== 'UserPromptSubmit') return true;
  if (input?.agent_id !== undefined && input.agent_id !== null && input.agent_id !== '') return true;
  const tp = String(input?.transcript_path ?? '').replaceAll('\\', '/');
  return /\/subagents\//.test(tp);
}

const OPEN_APPEND = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const OPEN_EXCL = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);

// Each folder from <home>/.claude down must be a real directory (a symlink would move the records elsewhere).
export function realDirChain(home, rel) {
  let p = home;
  for (const part of rel.split('/')) {
    p = path.join(p, part);
    try {
      if (!lstatSync(p).isDirectory()) return false;
    } catch (err) {
      if (err?.code !== 'ENOENT') return false;
      // (#472: two claimers creating the folder at once: the loser's mkdir says EEXIST, which is fine when what is there is a real directory, checked just below)
      try { mkdirSync(p, { mode: 0o700 }); } catch (e) { if (e?.code !== 'EEXIST') return false; }
      try { if (!lstatSync(p).isDirectory()) return false; } catch { return false; }
    }
  }
  return true;
}

// The binding a "merge" answer makes, as one pure function of the answer and the text it answers (#261: the typed recorder runs it on the owner's prompt and the reply's last request; the
// click recorder, owner-go-click.mjs, on the chosen answer and the dialog's question, which carries the same closing lines). Returns { prs, requests } or null (the answer is no approval).
export function approvalBinding(answer, shownText) {
  const a = parseApproval(answer);
  if (!a) return null;
  const shown = presentedRequests(shownText);
  const wanted = (pr) => a.prs.length === 0 || a.prs.includes(pr);
  const shaOk = (head) => a.shas.length === 0 || a.shas.some((s) => head.startsWith(s) || s.startsWith(head));
  const requests = shown.requests.filter((r) => wanted(r.pr) && shaOk(r.head));
  // PRs the owner approved for a direct merge: those the reply asked about (narrowed by the prompt), plus any the prompt names
  const prs = [...new Set([...shown.prs.filter(wanted), ...a.prs])];
  return { prs, requests };
}

// The recorder. Writes one line to <home>/.claude/pipeline-state/owner-go/<session>.jsonl for an owner prompt that approves;
// returns the record, or null (not an approval, a subagent, no session, or the write failed). Never throws.
export function recordApproval(input, { home = accountHome(), now = Date.now } = {}) {
  try {
    if (notOwnerPrompt(input)) return null;
    const session = String(input?.session_id ?? '');
    if (!SESSION_RE.test(session)) return null;
    const a = parseApproval(input?.prompt);
    if (!a) return null;
    if (notOwnerWords(input, String(input?.transcript_path ?? ''))) return null; // (#128: a notice, a peer's or a scheduled turn's "merge")
    if (queuedAnswer(input)) return null; // (#191 B1)
    const { prs, requests } = approvalBinding(String(input.prompt), lastRequestText(String(input?.transcript_path ?? ''), { prompt: String(input.prompt) }));
    const record = {
      v: 1,
      ts: new Date(now()).toISOString(),
      session,
      prompt_sha256: createHash('sha256').update(String(input.prompt)).digest('hex'),
      cwd: typeof input.cwd === 'string' ? input.cwd : null,
      ...promptRefs(input),
      prs,
      requests,
    };
    return appendRecord(home, session, record);
  } catch {
    return null;
  }
}

// What lets the USE side find this prompt's transcript entry again (#128): the hook's prompt_id (the entry's promptId), the transcript, and the
// words themselves (the fallback for a hook that sends no prompt_id; a "merge" is short, a ruling answer is capped by RULING_PROMPT_MAX).
const promptRefs = (input) => ({
  prompt_id: typeof input?.prompt_id === 'string' && input.prompt_id !== '' ? input.prompt_id : null,
  transcript_path: typeof input?.transcript_path === 'string' && input.transcript_path !== '' ? input.transcript_path : null,
  prompt: typeof input?.prompt === 'string' && answerBody(input.prompt).length <= RULING_PROMPT_MAX ? input.prompt : null, // (the cap is on the words after a pasted glyph, #190.3b)
});

// Appends one record to <home>/.claude/pipeline-state/owner-go/<session>.jsonl; the record, or null when it cannot be written safely.
export function appendRecord(home, session, record) {
  if (!realDirChain(home, OWNER_GO_REL)) return null;
  const file = path.join(ownerGoDir(home), `${session}.jsonl`);
  try {
    if (!lstatSync(file).isFile()) return null;
  } catch (err) {
    if (err?.code !== 'ENOENT') return null;
  }
  const fd = openSync(file, OPEN_APPEND, 0o600);
  try {
    if (!fstatSync(fd).isFile()) return null;
    writeSync(fd, `${JSON.stringify(record)}\n`);
  } finally {
    closeSync(fd);
  }
  return record;
}

export const RULING_PROMPT_MAX = 1000; // a ruling answer is only decisions (rulingsIn); a longer prompt is no answer and is not recorded (never cut)

// The binding a ruling answer makes: the ruling line the text ENDS with (presentedRuling) when the answer is a plausible one (non-empty, at most RULING_PROMPT_MAX; what it decides per item is
// rulingsIn's job at use time). Pure, shared with the click recorder (#261). Returns { repo, pr, ids, content } or null.
export function rulingBinding(answer, shownText) {
  if (typeof answer !== 'string' || answer.trim() === '' || answerBody(answer).length > RULING_PROMPT_MAX) return null;
  return presentedRuling(shownText);
}

// Phase 3b, the ruling recorder (same hook, same folder): when the reply right before the owner's prompt ends with the ruling line
// (presentedRuling), writes the prompt's words, bound to that repository, PR and those item ids. Returns the record, or null. Never throws.
export function recordRuling(input, { home = accountHome(), now = Date.now } = {}) {
  try {
    if (notOwnerPrompt(input)) return null;
    const session = String(input?.session_id ?? '');
    if (!SESSION_RE.test(session) || typeof input?.prompt !== 'string' || input.prompt.trim() === '' || answerBody(input.prompt).length > RULING_PROMPT_MAX) return null; // (#190.3b: the cap applies after the glyph strip, as the nudges' does)
    if (notOwnerWords(input, String(input?.transcript_path ?? ''))) return null; // (#128: a notice, a peer's or a scheduled turn's words)
    if (queuedAnswer(input)) return null; // (#191 B1)
    const reply = lastReply(String(input?.transcript_path ?? ''), { prompt: input.prompt, skipSynthetic: true });
    const asked = rulingBinding(input.prompt, reply.text);
    if (!asked) return null;
    // (#189 finding 2 refused a queued answer to a PROMOTED ask only; #191 B1 refuses every queued answer above. The record still says which kind of ask it answers: ask_turn is the audit trail.)
    return appendRecord(home, session, {
      v: 1, kind: 'ruling', ts: new Date(now()).toISOString(), session,
      prompt_sha256: createHash('sha256').update(input.prompt).digest('hex'),
      cwd: typeof input.cwd === 'string' ? input.cwd : null,
      repo: asked.repo, pr: asked.pr, ids: asked.ids, content: asked.content, ...(reply.promoted ? { ask_turn: 'synthetic' } : {}), ...promptRefs(input), prompt: input.prompt,
    });
  } catch {
    return null;
  }
}

// #128, the hook's nudge: the owner's prompt reads as a ruling answer (only `<id>: <decision>` pairs, rulingsIn's form) but recordRuling wrote
// nothing, because the reply before it did not end with the ⚖️ line (a notice, a `!` command or a tool-only turn came between, or the agent never
// asked). Said once to the agent, never blocking: it must ask again with a fresh `P triage ruling-request`. Not said for a prompt that is evidently
// not the owner's (notOwnerWords), so a notification loop cannot make the agent ask itself.
export const RULING_NUDGE = '[claude-pipeline owner-go] this reads as a ruling answer, but no ruling was recorded for it. A ruling is recorded only when the reply right before it ends with the "⚖️ Owner ruling needed" line: run `P triage ruling-request` again and ask once more.';
export function rulingNudge(input) {
  try {
    if (notOwnerPrompt(input) || !SESSION_RE.test(String(input?.session_id ?? ''))) return null;
    const answer = input?.prompt;
    if (typeof answer !== 'string' || answerBody(answer).length > RULING_PROMPT_MAX || !PAIRS_ONLY.test(answerBody(answer).replace(/\s+/g, ' ').trim())) return null;
    return notOwnerWords(input, String(input?.transcript_path ?? '')) ? null : RULING_NUDGE;
  } catch {
    return null;
  }
}

// #191 F3/F6, the hook's second nudge: the owner's prompt reads as a "merge", an "extra round" or a ruling answer but its transcript entry is queued, so nothing was recorded. Said once to the
// agent (plain text on stdout, never blocking): re-run the request command so the closing lines are FRESH (a stale Head line re-shown by hand would bind a stale head) and ask again. Said
// whether or not an ask was shown (over-nudging is harmless); not for a prompt that is evidently not the owner's. Takes precedence over the ruling nudge.
export const QUEUED_NUDGE = '[claude-pipeline owner-go] the owner\'s answer was typed while the agent was still working, so it was not recorded: re-run the dry run (`P merge --pr N --dry-run --owner-go`), `P triage round-request` or `P triage ruling-request`, show the FRESH closing lines, and ask the owner once more after the reply ends.';
// #262: the owner's typed go for a live-database change: `go migration <name>` or `go data <sha12>` and nothing else. (Here, not in live-db-go.mjs, so queuedNudge can read it without an import cycle.)
export const GO_PROMPT_MAX = 300;
// #681 (extend): a prompt copied out of a terminal can arrive wrapped in ONE pair of double quotes (straight or curly) or backticks, and line-wrapped between the op and the name
// ("go migration\n  <name>"). Both are read; the words, the charset and the length cap are unchanged, and nothing else may share the prompt. (A newline is read after the op, never between "go" and the op.)
const GO_QUOTES = { '"': '"', '“': '”', '`': '`' };
export function parseGo(prompt) {
  if (typeof prompt !== 'string' || prompt.length > GO_PROMPT_MAX) return null;
  let t = prompt.trim();
  if (t.length >= 2 && GO_QUOTES[t[0]] === t[t.length - 1]) t = t.slice(1, -1);
  const m = /^\s*go[ \t]+(migration|data)\s+([A-Za-z0-9_.-]{0,119}[A-Za-z0-9_-])[.!]?\s*$/i.exec(t);
  return m ? { op: m[1].toLowerCase(), arg: m[2] } : null;
}
export function queuedNudge(input) {
  try {
    if (notOwnerPrompt(input)) return null;
    const answer = input?.prompt;
    if (typeof answer !== 'string') return null;
    const body = answerBody(answer); // (#190.3b: the caps apply to the words after a pasted glyph)
    const readsAsAnswer = parseApproval(answer) !== null
      || parseGo(answer) !== null
      || (body.length <= ROUND_GRANT_PROMPT_MAX && (parseRoundGrant(answer) !== null || parsePastRoundGrant(answer) !== null))
      || (body.length <= RULING_PROMPT_MAX && PAIRS_ONLY.test(body.replace(/\s+/g, ' ').trim()));
    if (!readsAsAnswer || notOwnerWords(input, String(input?.transcript_path ?? ''))) return null;
    return queuedAnswer(input) ? QUEUED_NUDGE : null;
  } catch {
    return null;
  }
}

// Every valid "merge" record younger than maxAgeMs, from one session's file or (session null) from all of them. Never throws.
export function readApprovals(opts = {}) {
  return readRecords(opts).filter((r) => r.kind === undefined).map((r) => ({
    ts: r.ts,
    session: r.session,
    prompt_id: typeof r.prompt_id === 'string' ? r.prompt_id : null,
    transcript_path: typeof r.transcript_path === 'string' ? r.transcript_path : null,
    prompt: typeof r.prompt === 'string' ? r.prompt : null,
    ...(r.via === 'ask' ? { via: 'ask', ask: r.ask } : {}),
    prs: Array.isArray(r.prs) ? r.prs.filter(Number.isInteger) : [],
    requests: Array.isArray(r.requests) ? r.requests.filter((q) => Number.isInteger(q?.pr) && typeof q.head === 'string' && typeof q.items === 'string').map((q) => ({ ...q, repo: typeof q.repo === 'string' ? q.repo : null })) : [],
  }));
}

// Every valid record (any kind) younger than maxAgeMs, as written. Never throws.
// `problems` (an array; the strict lookup ownerGrantLookups passes one): each read that was skipped is described in it (the folder or a file that cannot be read, a
// file that is not a regular file or is over maxBytes); an absent folder or a file that vanished is no problem. Without it a skipped read is silent, as before.
// Why (#472) `settle`: on Claude Code 2.1.323 a click is only a PENDING pointer when its hook runs (the answer's transcript entry is written after the hooks return), so the readers verify pending
// clicks first (settlePendingClicks, with the caller's `session`) and then read the records. `settle: false` is for the read-only paths (the merge dry run's gate, click replay), which must write
// nothing; `settle: true` forces it; otherwise settleEnabled decides (the test switch PIPELINE_CLICK_SETTLE=off). A settle that fails never breaks the read: the fault is a problem, the records already
// written still count, and strict lookups report it.
export function readRecords({ home = accountHome(), session = null, now = Date.now, maxAgeMs = MAX_AGE_MS, maxBytes = MAX_RECORD_BYTES, problems = null, settle } = {}) {
  const dir = ownerGoDir(home);
  const out = [];
  let names = [];
  const note = (why) => { if (Array.isArray(problems)) problems.push(why); };
  if (settleEnabled(settle)) {
    try {
      for (const why of settlePendingClicks({ home, now, session }).problems) note(why);
    } catch {
      note('pending clicks could not be settled');
    }
  }
  try {
    if (!lstatSync(dir).isDirectory()) {
      note(`${dir} is not a real folder`);
      return out;
    }
    names = session === null ? readdirSync(dir).filter((n) => n.endsWith('.jsonl')) : SESSION_RE.test(String(session)) ? [`${session}.jsonl`] : [];
  } catch (err) {
    if (err?.code !== 'ENOENT') note(`${dir} cannot be read (${err?.code ?? 'error'})`);
    return out;
  }
  const t = now();
  const clicks = new Set(); // #261: a click's record is written after its marker, so a crash-and-retry can leave two of one click: readers keep the first (the click id is the identity)
  for (const name of names) {
    const file = path.join(dir, name);
    let text = '';
    try {
      const st = lstatSync(file);
      if (!st.isFile() || st.size > maxBytes) {
        note(`${file} is ${st.isFile() ? 'over the size limit' : 'not a regular file'}`);
        continue;
      }
      const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      try {
        const buf = Buffer.alloc(st.size);
        readSync(fd, buf, 0, st.size, 0);
        text = buf.toString('utf8');
      } finally {
        closeSync(fd);
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') note(`${file} cannot be read (${err?.code ?? 'error'})`);
      continue;
    }
    for (const line of text.split('\n')) {
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (r?.v !== 1 || `${r.session}.jsonl` !== name) continue;
      const at = Date.parse(r.ts);
      if (!Number.isFinite(at) || at > t + FUTURE_SKEW_MS || t - at > maxAgeMs) continue;
      if (r.via === 'ask' && typeof r.ask?.clickId === 'string') { if (clicks.has(r.ask.clickId)) continue; clicks.add(r.ask.clickId); }
      out.push(r);
    }
  }
  return out;
}

// The owner's recorded repo moves (repo-moves.mjs), read once per call: opts.repoMoves (an array; tests) or the file under opts.home.
// A record naming the old name counts for the new one only when it predates the move (sameRepo); nothing recorded changes.
const movesOf = (opts) => (Array.isArray(opts?.repoMoves) ? opts.repoMoves : readRepoMoves({ home: opts?.home }).moves);

// The repository as the records hold it (owner/name, lower case; GitHub names are case-insensitive), or null when `repo` is none.
export const repoKey = (repo) => (typeof repo === 'string' && new RegExp(`^${REPO_NAME}$`).test(repo) ? repo.toLowerCase() : null);

// ---- #128: use-time provenance ------------------------------------------------------------------------------------------------------
// The recorder cannot always tell who wrote a prompt (the hook input has no such field and the transcript may lag), so every consumer asks
// again when it uses a record: is the transcript entry of that prompt the owner's? Found by the hook's prompt_id (the entry's promptId) among
// PROMPT entries only (a tool_result sharing the id is no prompt); two prompt entries with one id is a replayed or forged id: synthetic.
// A record without prompt_id (a hook that sends none) is matched by its stored words within FALLBACK_WINDOW_MS of the record, same rule.
// Returns 'owner', 'synthetic', or 'missing' (no such entry within PROVENANCE_CAP_BYTES of the end, or the transcript is not a readable regular
// file, or one of a shape the guard does not write-protect: R1-B2, lib/paths.mjs isTranscriptFile: a file the guard leaves writable is not evidence of who typed anything,
// so a transcript_path elsewhere is refused here). Codex #145 P1: "protected" means under a config ROOT the guard protects as one AND this check can trust: a folder directly under the account's
// home with the HOME_CONFIG_DIR_RE shape, NOT under any .claude* folder (a folder-level cp/tar/rsync into /tmp/.claude-x or ~/.claude.personal is not refused, so a forged transcript there would
// otherwise pass for the owner's words) and NOT $CLAUDE_CONFIG_DIR (this runs in the agent's shell: `CLAUDE_CONFIG_DIR=/tmp/.claude-x P merge`). `home` is the account's home (accountHome, never $HOME); tests pass a temp one.
// An entry of unknown source (no provenance field) counts as the owner's ONLY when no prompt in the scanned transcript carries any
// such field (a genuinely old Claude Code); in a modern transcript it is untrusted, and so is an unknown one when the scan fell short of the start.
export function promptProvenance(record, opts = {}) {
  return promptEntryOf(record, opts).source;
}
// The same lookup, with the entry it found: { source: 'owner'|'synthetic'|'missing', entry } (entry only when one was found). #262: the live-database claim reads the entry's text and timestamp.
export function promptEntryOf(record, { chunkBytes = PROVENANCE_CHUNK_BYTES, capBytes = PROVENANCE_CAP_BYTES, home = accountHome() } = {}) {
  const missing = { source: 'missing' };
  const file = record?.transcript_path;
  if (typeof file !== 'string' || file === '' || !path.isAbsolute(file) || /(?:^|[\\/])subagents[\\/]/.test(file) || !isTranscriptFile(file, { home })) return missing;
  let match;
  if (typeof record.prompt_id === 'string' && record.prompt_id !== '') {
    const id = record.prompt_id;
    match = { wants: (line) => line.includes(id), is: (e) => isPromptEntry(e) && e.promptId === id };
  } else if (typeof record.prompt === 'string' && record.prompt.trim() !== '') {
    const at = Date.parse(record.ts);
    const words = plain(record.prompt);
    if (!Number.isFinite(at)) return missing;
    match = { wants: (line) => line.includes('"user"'), is: (e) => isPromptEntry(e) && promptTextOf(e) === words && Math.abs(Date.parse(e.timestamp) - at) <= FALLBACK_WINDOW_MS };
  } else {
    return missing;
  }
  // #418: the harness writes a hidden note (isMeta, entrypoint cli and no promptSource / origin / turnOrigin: an opened image, an attachment) under the prompt's own id; it is no second prompt.
  // An entry with unplaced provenance (unplacedProvenance) counts, so a forged twin of the owner's prompt still reads as two. (When every match is such a note, they are judged as before.)
  const found = [];
  const real = [];
  const scan = scanBackwards(file, (e) => { if (match.is(e)) { found.push(e); if (!(e.isMeta === true && !unplacedProvenance(e))) real.push(e); } return real.length >= 2; }, match.wants, { chunkBytes, capBytes });
  if (scan === null || found.length === 0) return missing;
  if (real.length > 0) found.splice(0, found.length, ...real);
  if (found.length > 1) return { source: 'synthetic' };
  if (found[0].promptSource === 'queued') return { source: 'synthetic', entry: found[0] }; // (#191 B2, every record kind: a queued answer may land on an ask newer than what the owner had on screen; #189 refused only a promoted ask's)
  const source = entrySource(found[0]);
  if (source !== 'unknown') return { source, entry: found[0] };
  // unknown: legacy only if the whole transcript is free of provenance fields
  let modern = false;
  const whole = scanBackwards(file, (e) => { if (isPromptEntry(e) && hasProvenanceField(e)) modern = true; return modern; }, (line) => line.includes('"user"'), { chunkBytes, capBytes });
  return { source: whole !== null && whole.reachedStart && !modern ? 'owner' : 'synthetic', entry: found[0] };
}

// Visits the parsed lines of a file newest first, in chunk-sized reads, at most capBytes back from the end; `wants(line)` filters before the
// parse and `visit(entry)` returns true to stop. Returns { reachedStart } (did the scan cover the whole file?) or null when it cannot be read.
export function scanBackwards(file, visit, wants, { chunkBytes, capBytes }) {
  let fd;
  try {
    if (!lstatSync(file).isFile()) return null;
    fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    let pos = fstatSync(fd).size;
    let scanned = 0;
    let carry = Buffer.alloc(0); // the front of the line that continues into the chunk before
    while (pos > 0 && scanned < capBytes) {
      const len = Math.min(chunkBytes, pos, capBytes - scanned);
      pos -= len;
      scanned += len;
      const chunk = Buffer.alloc(len);
      for (let got = 0; got < len;) {
        const n = readSync(fd, chunk, got, len - got, pos + got);
        if (n <= 0) return null;
        got += n;
      }
      const data = carry.length ? Buffer.concat([chunk, carry]) : chunk;
      let from = 0;
      carry = Buffer.alloc(0);
      if (pos > 0) {
        const nl = data.indexOf(10);
        if (nl < 0) { carry = data; continue; }
        carry = data.subarray(0, nl);
        from = nl + 1;
      }
      const lines = data.subarray(from).toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].trim() || !wants(lines[i])) continue;
        let e;
        try { e = JSON.parse(lines[i]); } catch { continue; }
        if (visit(e) === true) return { reachedStart: false };
      }
    }
    return { reachedStart: pos === 0 };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* nothing to do */ } }
  }
}

// A record written before #128 has no transcript_path: the one transcript of its session, or null. <config dir>/projects/<project>/<session>.jsonl, where the
// config dirs are ONLY the folders directly under the account's home with the guard's own shape (paths.mjs transcriptConfigDirs / HOME_CONFIG_DIR_RE: the names the guard
// refuses to let a tool create or replace, so what lies in them is the guard's). Why those and nothing else: the grant readers run in the agent's shell, so the
// environment is the agent's word. CLAUDE_CONFIG_DIR is ignored here (it would point the lookup at a file the agent wrote, and no guard reads that prefix), exactly as $HOME is
// (accountHome). A home-level name outside the shape (~/.claude.forged: `ln -s` creates it unguarded) is no root either. The candidate must be a regular file (not a link) of
// the shape isTranscriptFile accepts, not a subagent's, and its REAL path must lie inside the real path of one of those roots (a link inside a root that points out of
// them is not the guard's file; ~/.claude-eaglewatch/projects linked to ~/.claude/projects is), and taken relative to that root's real path it must be exactly
// projects/<project>/<session>.jsonl with <project> in the guard's project-folder shape (R2-B1: below ~/.claude the guard protects only projects/ and a project-shaped folder in it by NAME,
// so `ln -s ~/.claude/forged ~/.claude/projects/evil`, or a copy of it, is the agent's own file; the scan below lists only project-shaped names too, so the two agree).
// De-duplicated by real path (one account's projects/ can be a link to the other's). None, or two different files, is null.
// (A hook-written transcript_path record is judged the same way: isTranscriptFile / promptProvenance ignore $CLAUDE_CONFIG_DIR too, since the process that checks is the agent's shell.)
// Codex #145 P1: the isTranscriptFile test below gets the SAME `home` as the scan, so it accepts exactly these roots and no more: every dir transcriptConfigDirs lists is
// directly under that home with the HOME_CONFIG_DIR_RE shape, a root the guard protects (its home is the hook process's, the same account's).
const protectedShape = (rel, session) => { // rel: a real path relative to a root's real path
  const parts = rel.split(/[\\/]/);
  return parts.length === 3 && parts[0] === 'projects' && TRANSCRIPT_PROJECT_RE.test(parts[1]) && parts[2] === `${session}.jsonl`;
};
export function legacyTranscriptOf(session, { home = accountHome() } = {}) {
  if (typeof session !== 'string' || !SESSION_RE.test(session)) return null;
  const found = new Map(); // real path -> the path it was first seen by
  const dirs = transcriptConfigDirs({ home });
  const roots = []; // the roots' real paths
  for (const dir of dirs) { try { roots.push(realpathSync(dir)); } catch { /* gone */ } }
  for (const dir of dirs) {
    let projects;
    try { projects = readdirSync(path.join(dir, 'projects')); } catch { continue; }
    for (const project of projects) {
      if (!TRANSCRIPT_PROJECT_RE.test(project)) continue;
      const file = path.join(dir, 'projects', project, `${session}.jsonl`);
      try {
        if (!lstatSync(file).isFile() || /(?:^|[\\/])subagents[\\/]/.test(file) || !isTranscriptFile(file, { home })) continue;
        const real = realpathSync(file);
        if (!roots.some((r) => isInside(real, r) && protectedShape(path.relative(r, real), session))) continue;
        if (!found.has(real)) found.set(real, file);
      } catch { /* not there */ }
    }
  }
  return found.size === 1 ? [...found.values()][0] : null;
}

// The records of `list` whose prompt is the owner's (each distinct prompt is looked up once). grant: true (the extra-round readers) finds a pre-#128
// record's transcript by its session (legacyTranscriptOf) when it names none, under `home` only (the environment never says where).
function ownedBy(list, { grant = false, home } = {}) {
  const memo = new Map();
  return list.filter((r) => {
    const key = `${r.transcript_path}\0${r.prompt_id}\0${r.prompt}\0${r.ts}\0${r.ask_turn}\0${grant ? r.session : ''}\0${r.via}\0${r.ask?.clickId}`;
    if (!memo.has(key)) {
      if (r.via === 'ask') { // #261: the answer to a click dialog, not a typed prompt: its proof is the dialog's tool_result entry (clickProvenance)
        memo.set(key, clickProvenance(r, { home }));
        return memo.get(key) === 'owner';
      }
      const derive = grant && (typeof r.transcript_path !== 'string' || r.transcript_path === '');
      const file = derive ? legacyTranscriptOf(r.session, { home }) : r.transcript_path;
      memo.set(key, derive && file === null ? 'missing' : promptProvenance(derive ? { ...r, transcript_path: file } : r, { home }));
    }
    return memo.get(key) === 'owner';
  });
}

// P merge: did the owner say "merge" for exactly this repository (owner/name), PR, full head and owner-item set (any session, last 24 h),
// and is that prompt the owner's (promptProvenance)? approvalGap says why not: 'provenance' (a matching record exists but no owner prompt
// stands behind it), 'none' (no matching record), 'ok'.
// `areas` (the ids of the protected areas the live scan found; --owner-go passes it, always): the record must carry exactly the digest of the Areas block
// the owner was shown for them (areasDigest). A record without the field (shown before Areas lines, or none shown) means "no areas": it still approves a
// diff without areas, exactly as before, and never one with areas. `areas: null` (only the gated route, bound by the gate's ownerItems) says "this route does
// not bind areas" and compares nothing; `undefined` (a caller that forgot) compares as no areas, so it fails closed.
// `hold` (rev 4 items 2a, 5; the same rule for the needs-human hold): `{ id, login, at }`, the LIVE hold P merge read from the PR timeline (null: no hold); the record must name exactly
// that hold id AND carry the digest of the Hold block the owner was shown (holdDigest), compared both ways: an old record without them (shown before Hold lines) never lifts a hold, a
// record for hold X never covers hold Y, a record with a hold never approves a PR that has none now. `hold: null` (only the gated route, which lifts no hold) compares nothing;
// `undefined` (absent, a caller that forgot) means "no hold" and fails closed.
// `rulings` (plan 2026-11-05-claude-rulings E11): the sha256 the live scan holds for the Rulings block (rulingsBlockDigest, 'none' without one); the record's `rulings` must equal it, an absent
// field reading as 'none', so a record without a block never covers a PR with rulings and the other way round. `rulings: null` (only the gated route) compares nothing.
const approvalsFor = ({ repo, pr, head, items, areas, hold, rulings, ...opts }) => {
  const key = repoKey(repo);
  if (key === null || !/^[0-9a-f]{40}$/.test(String(head)) || typeof items !== 'string') return [];
  const wantAreas = areas === null ? null : areasDigest(areas);
  const wantRulings = rulings === null ? null : (rulings ?? 'none'); // null = this route does not bind the rulings block; absent / undefined = 'none' (fails closed against a live digest)
  const wantHold = hold === null ? null : { id: hold ? hold.id : 'none', digest: holdDigest(hold) }; // (undefined = no hold)
  const moves = movesOf(opts);
  return readApprovals(opts).filter((r) => r.requests.some((q) => sameRepo({ recorded: q.repo, recordedAt: r.ts, current: key, moves }) && q.pr === pr && q.head.length >= HEAD_CHARS && head.startsWith(q.head) && q.items === items
    && (wantAreas === null || (typeof q.areas === 'string' ? q.areas : 'none') === wantAreas)
    && (wantRulings === null || (typeof q.rulings === 'string' ? q.rulings : 'none') === wantRulings)
    && (wantHold === null || ((typeof q.hold === 'string' ? q.hold : 'none') === wantHold.id && (typeof q.holdBlock === 'string' ? q.holdBlock : 'none') === wantHold.digest))));
};
export function approvalGap(q) {
  const matching = approvalsFor(q);
  if (matching.length === 0) return 'none';
  return ownedBy(matching, { home: q.home }).length > 0 ? 'ok' : 'provenance';
}
export const approvedRequest = (q) => approvalGap(q) === 'ok';
// #740: when approvalGap is not 'ok', was the reason that the owner's word WAS recorded for this request but typed while the agent was still working (its transcript entry is promptSource
// 'queued', #191 B2)? -> the ISO ts of the newest such matching record, else null. Read-only: it changes nothing about what approves (the same `q`, incl. maxAgeMs, as approvalGap / approvalGapSince).
export function queuedApprovalAt(q) {
  const queued = approvalsFor({ ...q, settle: false }).filter((r) => r.via !== 'ask' && promptEntryOf(r, { home: q.home }).entry?.promptSource === 'queued');
  return queued.length === 0 ? null : queued.map((r) => r.ts).sort().at(-1);
}

// R2-F3 (fix round): promptProvenance trusts a transcript only under a `.claude*` folder directly under the account's home (isTranscriptFile; $CLAUDE_CONFIG_DIR names no root: it is the agent's
// word). So a genuine record refused for "missing" may only mean the owner's Claude Code config dir is somewhere else. That is likely when the record's transcript has the shape of a session
// transcript (<dir>/projects/<project>/<session>.jsonl) yet is under no such folder; a record whose transcript is simply gone, or is no transcript at all, gets no hint. The hint says what is
// required (it cannot be satisfied by setting the variable). Returns text to append to the refusal ('' when it does not apply).
export const CONFIG_DIR_HINT = 'the transcript of that prompt is not under a Claude Code config dir this check trusts: only a .claude* folder directly under the account\'s home (~/.claude, ~/.claude-work) counts, and CLAUDE_CONFIG_DIR is not consulted, so a config dir anywhere else cannot confirm the owner\'s words; move the owner\'s config dir to a .claude* folder directly under the home';
const TRANSCRIPT_SHAPE = /[\\/]projects[\\/][^\\/]+[\\/][^\\/]+\.jsonl$/;
export function configDirHint(records, { home = accountHome() } = {}) {
  const plausible = (r) => {
    const file = r?.transcript_path;
    return typeof file === 'string' && path.isAbsolute(file) && TRANSCRIPT_SHAPE.test(file) && !/(?:^|[\\/])subagents[\\/]/.test(file) && !isTranscriptFile(file, { home });
  };
  return (records ?? []).some(plausible) ? CONFIG_DIR_HINT : '';
}
export const approvalConfigDirHint = (q) => configDirHint(approvalsFor(q), { home: q.home });
export const rulingConfigDirHint = (q) => configDirHint(rulingsFor(q), { home: q.home });

// The guard, before a direct merge: did the owner say "merge" in this session (last 24 h) for a request about this repository and PR
// whose head is this full head? (A PR merely named in the prompt, `merge #7`, is recorded in `prs` for the audit trail but approves no head.)
export function approvedPr({ repo, pr, head, session, ...opts }) {
  const key = repoKey(repo);
  if (key === null || !Number.isInteger(pr) || !/^[0-9a-f]{40}$/.test(String(head)) || !SESSION_RE.test(String(session ?? ''))) return false;
  const moves = movesOf(opts);
  return ownedBy(readApprovals({ ...opts, session }).filter((r) => r.requests.some((q) => sameRepo({ recorded: q.repo, recordedAt: r.ts, current: key, moves }) && q.pr === pr && q.head.length >= HEAD_CHARS && head.startsWith(q.head))), { home: opts.home }).length > 0;
}

// What an owner's answer to a ruling request decides, per item. Security reviews of f17b251, ff8090f and 009d435: reading decisions
// out of free text (a fragment, a word read for the wrong item, "don't accept", a contradicting word left over) always left a way to
// pass words for a ruling the owner did not give, so the answer is now ONLY the decisions, nothing else: `R1-B1: accept, R2-S3: reject`
// (each asked id at most once; `:` `-` `=` or a space between id and decision; commas, semicolons, full stops, `and` between pairs).
// The id is always written (Fable attacker pass: the ruling line is the agent's, so a bare "accept" answering an unrelated question
// under it would rule). Any other word, an id not asked, or an id twice, and the answer decides nothing (the owner's reasons go in
// another message). Returns Map(ID upper case → ACCEPT | FOLLOW-UP | REJECT).
const DECISION = '(accept|follow[- ]?up|reject)';
const ITEM = '(r\\d{1,4}-[a-z]{1,8}\\d{1,4})';
const decisionOf = (w) => (/^accept/i.test(w) ? 'ACCEPT' : /^reject/i.test(w) ? 'REJECT' : 'FOLLOW-UP');
const SEP = '(?:\\s*[,;.]\\s*|\\s+and\\s+|\\s+)';
const PAIR = `${ITEM}\\s*[:=–—-]?\\s*${DECISION}`;
const PAIRS_ONLY = new RegExp(`^${PAIR}(?:${SEP}${PAIR})*[.!]?$`, 'i');
export function rulingsIn(answer, askedIds) {
  const a = answerBody(answer).replace(/\s+/g, ' ').trim();
  const asked = (askedIds ?? []).map((x) => String(x).toUpperCase());
  const out = new Map();
  if (!PAIRS_ONLY.test(a)) return out;
  for (const [, id, d] of a.matchAll(new RegExp(PAIR, 'gi'))) {
    const k = id.toUpperCase();
    if (!asked.includes(k) || out.has(k)) return new Map();
    out.set(k, decisionOf(d));
  }
  return out;
}

// Every ruling record (any session, last 24 h) that answers a ruling request for this repository, PR and item with exactly `quote` (the
// WHOLE answer; runs of white space as one space, case-insensitive: it is copied from the chat) and decides `decision` for the item (rulingsIn).
function rulingsFor({ repo, pr, id, quote, decision, ...opts }) {
  const key = repoKey(repo);
  const words = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const q = words(quote);
  if (key === null || !Number.isInteger(pr) || q === '') return [];
  const moves = movesOf(opts);
  return readRecords(opts).filter((r) => r.kind === 'ruling' && sameRepo({ recorded: r.repo, recordedAt: r.ts, current: key, moves }) && r.pr === pr && Array.isArray(r.ids) && r.ids.includes(id)
    && typeof r.prompt === 'string' && words(r.prompt) === q && rulingsIn(r.prompt, r.ids).get(String(id).toUpperCase()) === decision);
}

// triage owner-ruling: did the owner answer a ruling request for this repository, PR and item (rulingsFor), and is the finding text the
// owner was shown (the request's `content`) still the current one? #110: `contentOf(ids)` is the caller's digest of those items in the
// current review state (null when any is gone); it is called with the record's FULL id list, and a record with no content (the line
// shape before #110) or no `contentOf` approves nothing.
// #128: only a record whose prompt is the owner's (promptProvenance) counts.
// R1-B1/B2 (cp #771): ownerRulingRecords returns those records (a click's record carries `ask.variant`), ownerRuled says whether there is one.
export function ownerRulingRecords({ contentOf, ...q }) {
  return typeof contentOf === 'function' ? ownedBy(rulingsFor(q), { home: q.home }).filter((r) => typeof r.content === 'string' && r.content === contentOf(r.ids)) : [];
}
export const ownerRuled = (q) => ownerRulingRecords(q).length > 0;

// Why ownerRuled said no, for the message: 'none' (no such answer recorded), 'provenance' (answers exist but none is confirmed as typed by
// the owner: checked first), 'no-content' (every one is in the old line shape) or 'changed' (the finding text differs from the one the owner
// was asked about).
export function ownerRulingGap(q) {
  const found = rulingsFor(q);
  if (found.length === 0) return 'none';
  const owned = ownedBy(found, { home: q.home });
  if (owned.length === 0) return 'provenance';
  return owned.every((r) => typeof r.content !== 'string') ? 'no-content' : 'changed';
}

// The owner-item set as one short digest: each item is one line (kind, rule or id, file); 'none' when there are none.
export function ownerItemsDigest(items) {
  const list = [...new Set((items ?? []).map(String))].sort();
  if (list.length === 0) return 'none';
  return createHash('sha256').update(list.join('\n')).digest('hex').slice(0, 12);
}

// ---- Owner-granted extra review round ---------------------------------------------------------------------------------------------
// cp #104 caps counted review rounds at review.max_rounds (+ one automatic extra round). The owner can grant ONE more by typing
// `extra round` in chat after a reply that ENDS with the line `P triage round-request` prints:
//   `🔁 Extra review round needed #N: round <k> · head <sha12> · repo <owner/name>`   (k = the counted ordinal; reviewed + 1)
// The recorder (same hook, same folder) stores the owner's words verbatim as a kind 'extra-round' record bound to that repository, PR, k
// and head. codex-review then needs such a record (< 24 h) for the head under review, and consumes it AFTER Codex ran by exclusively
// creating a machine-global marker `consumed/<grantId>.json` (claimGrantMarkers): one grant admits one run, wherever the checkout is. The
// final gate recomputes the grant from record + marker (verifyOwnerGrant), so a forged `ownerGrant` in review state proves nothing.
// #128: the grant is as strict as a "merge": a harness-injected turn is never recorded (notOwnerWords), and a record counts only while its prompt
// is still the owner's in the transcript (promptProvenance, ownedBy) — at the cap lookup (ownerGrantedRounds) and at the final gate (verifyOwnerGrant).
// Residual: as for "merge" and rulings (see the top of this file), plus a nested `claude -p --resume` the guards do not name (cp issue).
// A second, distinct line approves a round that ALREADY RAN (before cp #104, so it carries no grant): `P triage round-request --past` prints
//   `🔂 Approve past review round #N: round <k> · head <sha12> · repo <owner/name>`
// and the same recorder stores the owner's words as a kind 'past-round' record. The two kinds never cross: a past-round record is invisible to
// every extra-round reader (isRoundRecord: codex-review, ownerGrantedRounds, round-request), an extra-round record to the past-round readers
// (isPastRoundRecord, pastRoundGrantsFor), and verifyOwnerGrant takes a past-round record only for an `ownerGrant` with `past: true`.
const ROUND_LINE = new RegExp(`^\\s*(?:🔁)?\\s*Extra review round needed\\s+#(\\d{1,6})\\s*:\\s*round\\s+(\\d{1,3})\\s*(?:·|\\|)\\s*head\\s+([0-9a-f]{${HEAD_CHARS},40})\\s*(?:·|\\|)\\s*repo\\s+(${REPO_NAME})\\s*$`, 'i');
export const ROUND_GRANT_PROMPT_MAX = 300; // a grant is a few words; a longer prompt is not one and is not recorded (never cut)

// The extra-round request a reply ENDS with (its last non-blank line). Returns { pr, k, head (lower case, 12..40), repo (lower case) } or null.
export function presentedRoundRequest(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const m = ROUND_LINE.exec(lines[lines.length - 1] ?? '');
  if (!m) return null;
  return { pr: Number(m[1]), k: Number(m[2]), head: m[3].toLowerCase(), repo: m[4].toLowerCase() };
}

// The past-round line (same head / repo rules as ROUND_LINE; a different sentence, so neither parser accepts the other's line).
const PAST_ROUND_LINE = new RegExp(`^\\s*(?:🔂)?\\s*Approve past review round\\s+#(\\d{1,6})\\s*:\\s*round\\s+(\\d{1,3})\\s*(?:·|\\|)\\s*head\\s+([0-9a-f]{${HEAD_CHARS},40})\\s*(?:·|\\|)\\s*repo\\s+(${REPO_NAME})\\s*$`, 'i');

// The past-round request a reply ENDS with (its last non-blank line). Returns { pr, k, head (lower case, 12..40), repo (lower case) } or null.
export function presentedPastRoundRequest(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const m = PAST_ROUND_LINE.exec(lines[lines.length - 1] ?? '');
  if (!m) return null;
  return { pr: Number(m[1]), k: Number(m[2]), head: m[3].toLowerCase(), repo: m[4].toLowerCase() };
}

// A prompt that grants: "extra round", "grant round 4 #1544", "extra review round, please". Same strictness as parseApproval: the words
// after the opener are targets (#N = a PR, a bare integer = the PR or the round, resolved against the request line by the recorder) and
// filler only; "extra round?", "no extra round", "grant round 4 after CI", "why extra round" grant nothing. Returns null or { prs, numbers }.
export function parseRoundGrant(prompt) {
  return parseRoundWords(prompt, /^(?:extra|grant)\s+(?:review\s+)?round(?![A-Za-z0-9_-])([\s\S]*)$/i);
}

// The owner's words for a past round: the same openers plus "approve" ("approve round", "approve past round 5 #1448"), same target rules.
export function parsePastRoundGrant(prompt) {
  return parseRoundWords(prompt, /^(?:extra|grant|approve)\s+(?:past\s+)?(?:review\s+)?round(?![A-Za-z0-9_-])([\s\S]*)$/i);
}

function parseRoundWords(prompt, opener) {
  const t = answerBody(prompt); // (#190.3b: a pasted prompt glyph is stripped)
  const m = opener.exec(t);
  if (!m) return null;
  const rest = m[1];
  if (rest.includes('?')) return null;
  const prs = [];
  const numbers = [];
  for (const tok of rest.replace(/[.,!;:]+/g, ' ').split(/\s+/).filter(Boolean)) {
    let x;
    if ((x = /^#(\d{1,6})$/.exec(tok))) prs.push(Number(x[1]));
    else if ((x = /^(\d{1,6})$/.exec(tok))) numbers.push(Number(x[1]));
    else if (!FILLER.test(tok)) return null;
  }
  return { prs: [...new Set(prs)], numbers: [...new Set(numbers)] };
}

// The binding an "extra round" answer makes (pure, shared with the click recorder, #261): the request line the text ENDS with, when the answer is a grant (parseRoundGrant, at most
// ROUND_GRANT_PROMPT_MAX) and every PR or round it names is the line's. Returns { pr, k, head, repo } or null.
export function roundBinding(answer, shownText, { parse = parseRoundGrant, present = presentedRoundRequest } = {}) {
  if (typeof answer !== 'string' || answer.trim() === '' || answerBody(answer).length > ROUND_GRANT_PROMPT_MAX) return null;
  const g = parse(answer);
  if (!g) return null;
  const asked = present(shownText);
  if (!asked) return null;
  if (!g.prs.every((n) => n === asked.pr) || !g.numbers.every((n) => n === asked.pr || n === asked.k)) return null;
  return asked;
}

// The extra-round recorder (same hook, same folder): when the reply right before the owner's prompt ends with the request line, writes the
// prompt verbatim, bound to that repository, PR, counted round and head. A PR or round the prompt names must be the line's; anything else
// records nothing. Returns the record, or null. Never throws.
export function recordRoundGrant(input, opts = {}) {
  return recordRoundKind(input, opts, { kind: 'extra-round', parse: parseRoundGrant, present: presentedRoundRequest });
}

// The past-round recorder: the same checks, for a reply that ends with the 🔂 line; writes a kind 'past-round' record. Returns the record, or null. Never throws.
export function recordPastRoundGrant(input, opts = {}) {
  return recordRoundKind(input, opts, { kind: 'past-round', parse: parsePastRoundGrant, present: presentedPastRoundRequest });
}

function recordRoundKind(input, { home = accountHome(), now = Date.now } = {}, { kind, parse, present }) {
  try {
    if (notOwnerPrompt(input)) return null;
    const session = String(input?.session_id ?? '');
    if (!SESSION_RE.test(session) || typeof input?.prompt !== 'string' || input.prompt.trim() === '' || answerBody(input.prompt).length > ROUND_GRANT_PROMPT_MAX) return null; // (#190.3b: after the glyph strip)
    if (!parse(input.prompt)) return null;
    if (notOwnerWords(input, String(input?.transcript_path ?? ''))) return null; // (#128: strict like a "merge" — a notice, a peer's or a scheduled turn's "extra round")
    if (queuedAnswer(input)) return null; // (#191 B1)
    const asked = roundBinding(input.prompt, lastReplyText(String(input?.transcript_path ?? ''), { prompt: input.prompt }), { parse, present });
    if (!asked) return null;
    return appendRecord(home, session, {
      v: 1, kind, ts: new Date(now()).toISOString(), session,
      prompt_sha256: createHash('sha256').update(input.prompt).digest('hex'),
      cwd: typeof input.cwd === 'string' ? input.cwd : null,
      repo: asked.repo, pr: asked.pr, k: asked.k, head: asked.head, ...promptRefs(input), prompt: input.prompt,
    });
  } catch {
    return null;
  }
}

const FULL_HEAD = /^[0-9a-f]{40}$/;
// Is this a well-formed record of that kind (the hook's own shape)? A hand-edited prompt no longer hashes to prompt_sha256.
const isRoundRecord = (r) => isGrantRecord(r, 'extra-round');
const isPastRoundRecord = (r) => isGrantRecord(r, 'past-round');
function isGrantRecord(r, kind) {
  return r?.kind === kind && typeof r.session === 'string' && typeof r.ts === 'string' && typeof r.prompt_sha256 === 'string'
    && repoKey(r.repo) === r.repo && Number.isInteger(r.pr) && Number.isInteger(r.k) && /^[0-9a-f]{12,40}$/.test(String(r.head))
    && typeof r.prompt === 'string' && r.prompt.trim() !== '' && answerBody(r.prompt).length <= ROUND_GRANT_PROMPT_MAX
    && createHash('sha256').update(r.prompt).digest('hex') === r.prompt_sha256;
}

// The id a grant's marker is named by: the record's session, time and prompt hash (16 hex); null for a record without them.
export function grantIdOf(record) {
  if (typeof record?.session !== 'string' || typeof record.ts !== 'string' || typeof record.prompt_sha256 !== 'string') return null;
  return createHash('sha256').update(`${record.session}|${record.ts}|${record.prompt_sha256}`).digest('hex').slice(0, 16);
}

const CONSUMED_REL = `${OWNER_GO_REL}/consumed`;
const GRANT_ID = /^[0-9a-f]{16}$/;
export const markerPath = (grantId, { home = accountHome() } = {}) => (GRANT_ID.test(String(grantId)) ? path.join(home, ...CONSUMED_REL.split('/'), `${grantId}.json`) : null);

// 'ok' (every folder from <home>/.claude down is a real directory), 'missing' (one is absent) or 'unsafe' (a link, a file, unreadable).
function chainState(home, rel) {
  let p = home;
  for (const part of rel.split('/')) {
    p = path.join(p, part);
    try {
      if (!lstatSync(p).isDirectory()) return 'unsafe';
    } catch (err) {
      return err?.code === 'ENOENT' ? 'missing' : 'unsafe';
    }
  }
  return 'ok';
}

// Is this record's marker spent? A marker lookup that fails for a reason other than "not there" still counts as spent (the tolerant lookups), but the strict one
// (opts.problems) records it, so a consumed folder that cannot be searched does not hide an unspent grant (R3-B1).
function spentMarker(record, { home, problems = null } = {}) {
  const marker = readGrantMarker(grantIdOf(record), { home });
  if (marker.lookupError && Array.isArray(problems)) problems.push(`a grant's marker cannot be checked (${marker.lookupError})`);
  return marker.spent;
}

// ---- #472: round tickets, coverage and the per-grant marker every covered grant ends up with ------------------------------------------------------
// Why: a click is verified late on Claude Code 2.1.323 (settlePendingClicks), so a round grant can become a record AFTER an extra-round claim of its round was made, and two claimers with disjoint
// snapshots (one holds the typed word, the other the late click) would each claim a "different" grant: two runs for one round. So every extra-round claim first creates ONE O_EXCL ticket
// `round-claims/<key16>.<n>.json` for (repository, PR, counted round k) (claimGrantMarkers, `ticket: true`): the claims of a round are totally ordered by their tickets, and a claim may only take
// ticket n+1 while it holds a grant answered after ticket n. A grant answered at or before a ticket is COVERED by it: spent for every new reader (roundCoverage), and, so that readers that know
// nothing about tickets (an older checkout's `pipeline.mjs`, a downgrade) see it spent too, it gets its own ordinary per-grant marker (the claim's sweep, settlePendingClicks, or the reader repair in
// grantRecordsFor). Coverage governs the availability of a grant for another claim ONLY: verifyOwnerGrant keeps judging historical proof by record + own marker, at any age.
export const ROUND_CLAIMS_REL = `${OWNER_GO_REL}/round-claims`;
const TICKET_NAME = /^([0-9a-f]{16})\.([1-9]\d{0,5})\.json$/;
const CONSUMED_NAME = /^([0-9a-f]{16})\.json$/;
const SOURCE_MAX_BYTES = 64 * 1024;

// Why (#472): the key one round's tickets are named by, sha256(repoKey|pr|k)[:16]; null for a repository that is none.
export const roundTicketKey = (repo, pr, k) => {
  const key = repoKey(repo);
  return key === null ? null : createHash('sha256').update(`${key}|${pr}|${k}`).digest('hex').slice(0, 16);
};

// A ticket or marker file read for coverage: { state: 'ok', value, mtimeMs } | { state: 'bad', mtimeMs } (there, but not JSON, too big or unreadable: UNPARSEABLE) | { state: 'error' } (it cannot even be
// looked at, or it is no plain file: a link, a folder). `io.lstatSync` is a test seam.
function readSourceFile(file, io) {
  let st;
  try {
    st = (io.lstatSync ?? lstatSync)(file);
    if (!st.isFile()) return { state: 'error' };
  } catch {
    return { state: 'error' };
  }
  try {
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const got = fstatSync(fd);
      if (!got.isFile() || got.size > SOURCE_MAX_BYTES) return { state: 'bad', mtimeMs: st.mtimeMs };
      const buf = Buffer.alloc(got.size);
      readSync(fd, buf, 0, got.size, 0);
      return { state: 'ok', value: JSON.parse(buf.toString('utf8')), mtimeMs: st.mtimeMs };
    } finally {
      closeSync(fd);
    }
  } catch {
    return { state: 'bad', mtimeMs: st.mtimeMs };
  }
}
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const validTicket = (v, key, n) => isPlainObject(v) && v.v === 1 && repoKey(v.repo) === v.repo && Number.isInteger(v.pr) && Number.isInteger(v.k) && v.n === n && roundTicketKey(v.repo, v.pr, v.k) === key
  && FULL_HEAD.test(String(v.head)) && typeof v.consumedAt === 'string' && Number.isFinite(Date.parse(v.consumedAt)) && Array.isArray(v.grantIds) && v.grantIds.every((g) => GRANT_ID.test(String(g)));
const validMarker = (v, id) => isPlainObject(v) && v.v === 1 && v.grantId === id && repoKey(v.repo) === v.repo && Number.isInteger(v.pr) && Number.isInteger(v.k) && FULL_HEAD.test(String(v.head))
  && typeof v.consumedAt === 'string' && Number.isFinite(Date.parse(v.consumedAt));
const indeterminate = (why) => ({ state: 'indeterminate', why });

// Why (#472): the round tickets of (repo, pr, k) (and of the names the recorded repository moves map them to), read for coverage and for the claim's ticket number. -> { state: 'ok', tickets: [{ id:
// '<key16>.<n>', n, parseable, repo, pr, k, head, consumedAt, grantIds, checkout: null, mtimeMs }] sorted by n } | { state: 'indeterminate', why }. A missing folder is no ticket; an unsafe folder, a listing that
// fails, a name that is no ticket name, and a ticket that cannot be looked at or is no plain file make it INDETERMINATE (fail closed). A ticket that is there but unparseable is kept with its mtime and no
// head: it covers by time only and is never a repair source (it has no head to copy). `io.readdirSync` / `io.lstatSync` are test seams.
export function readRoundTickets({ home = accountHome(), repo, pr, k, moves = [], io = {} } = {}) {
  const chain = chainState(home, ROUND_CLAIMS_REL);
  if (chain === 'missing') return { state: 'ok', tickets: [] };
  if (chain === 'unsafe') return indeterminate('the round-claims folder is not a real folder');
  const names = [repo, ...moves.flatMap((m) => [m?.from, m?.to])].map((r) => roundTicketKey(r, pr, k)).filter((x) => x !== null);
  const wanted = new Set(names);
  let listing;
  try {
    listing = (io.readdirSync ?? readdirSync)(path.join(home, ...ROUND_CLAIMS_REL.split('/')));
  } catch (err) {
    return indeterminate(`the round-claims folder cannot be listed (${err?.code ?? 'error'})`);
  }
  const tickets = [];
  for (const name of listing) {
    const m = TICKET_NAME.exec(name);
    if (m === null) return indeterminate(`the round-claims folder holds ${name}, which is no ticket`);
    if (!wanted.has(m[1])) continue;
    const n = Number(m[2]);
    const r = readSourceFile(path.join(home, ...ROUND_CLAIMS_REL.split('/'), name), io);
    if (r.state === 'error') return indeterminate(`the ticket ${name} cannot be checked`);
    const id = `${m[1]}.${n}`;
    tickets.push(r.state === 'ok' && validTicket(r.value, m[1], n)
      ? { id, n, parseable: true, repo: r.value.repo, pr: r.value.pr, k: r.value.k, head: r.value.head, consumedAt: r.value.consumedAt, grantIds: r.value.grantIds, checkout: null, mtimeMs: r.mtimeMs }
      : { id, n, parseable: false, mtimeMs: r.mtimeMs });
  }
  return { state: 'ok', tickets: tickets.sort((a, b) => a.n - b.n) };
}

// The ordinary consumed markers as coverage sources (a claim by ticket-less code leaves nothing else, F1). A verifiable marker WITHOUT `coveredBy` is a source with its own fields; one WITH `coveredBy`
// is derived (its source is present) and skipped; an unparseable one is a source by mtime. Same indeterminate rules as the tickets (names must be `<16 hex>.json`).
function readConsumedSources({ home, io }) {
  const chain = chainState(home, CONSUMED_REL);
  if (chain === 'missing') return { state: 'ok', sources: [] };
  if (chain === 'unsafe') return indeterminate('the consumed-grants folder is not a real folder');
  const dir = path.join(home, ...CONSUMED_REL.split('/'));
  let listing;
  try {
    listing = (io.readdirSync ?? readdirSync)(dir);
  } catch (err) {
    return indeterminate(`the consumed-grants folder cannot be listed (${err?.code ?? 'error'})`);
  }
  const sources = [];
  for (const name of listing) {
    const m = CONSUMED_NAME.exec(name);
    if (m === null) return indeterminate(`the consumed-grants folder holds ${name}, which is no marker`);
    const r = readSourceFile(path.join(dir, name), io);
    if (r.state === 'error') return indeterminate(`the marker ${name} cannot be checked`);
    if (r.state === 'ok' && validMarker(r.value, m[1])) {
      if (typeof r.value.coveredBy === 'string') continue;
      sources.push({ id: m[1], parseable: true, repo: r.value.repo, pr: r.value.pr, k: r.value.k, head: r.value.head, consumedAt: r.value.consumedAt, checkout: typeof r.value.checkout === 'string' ? r.value.checkout : null, mtimeMs: r.mtimeMs });
    } else {
      sources.push({ id: m[1], parseable: false, mtimeMs: r.mtimeMs });
    }
  }
  return { state: 'ok', sources };
}

// Tickets + consumed markers for one round. -> { state: 'ok', tickets, sources } | { state: 'indeterminate', why }.
function coverageSources({ home, repo, pr, k, moves, io }) {
  const t = readRoundTickets({ home, repo, pr, k, moves, io });
  if (t.state !== 'ok') return t;
  const c = readConsumedSources({ home, io });
  if (c.state !== 'ok') return c;
  return { state: 'ok', tickets: t.tickets, sources: [...t.tickets, ...c.sources] };
}

// The sources that cover `record` (answered at or before the source's consumedAt, or before an unparseable source's mtime; same PR and round, the source's head starting with the record's, the source's
// repository the current one or moved to it after the claim), parseable ones in front.
function coveringSources(record, sources, key, moves) {
  const at = Date.parse(record.ts);
  const hits = sources.filter((s) => (s.parseable
    ? s.pr === record.pr && s.k === record.k && sameRepo({ recorded: s.repo, recordedAt: s.consumedAt, current: key, moves }) && s.head.startsWith(record.head) && Date.parse(s.consumedAt) >= at
    : s.mtimeMs >= at));
  return [...hits.filter((s) => s.parseable), ...hits.filter((s) => !s.parseable)];
}

// Why (#472): is this extra-round grant spent by a claim of its round that was made after it was answered? 'covered' | 'absent' | 'indeterminate' (a folder that is unsafe or cannot be listed, a stray name, an
// lstat that fails: the grant then counts as spent, strict lookups report it, and a claim is refused `unsafe`). Extra-round records only (a past-round record, which shares the readers, is always 'absent': F6).
// `repo` is the repository the caller asks about (default the record's own); `moves` the recorded repository moves. Sources: the round tickets and every ordinary consumed marker (see readConsumedSources).
export function roundCoverage(record, { home = accountHome(), moves = [], repo, io = {} } = {}) {
  if (!isRoundRecord(record)) return 'absent';
  const key = repoKey(repo ?? record.repo);
  if (key === null) return 'absent';
  const s = coverageSources({ home, repo: key, pr: record.pr, k: record.k, moves, io });
  if (s.state !== 'ok') return 'indeterminate';
  return coveringSources(record, s.sources, key, moves).length > 0 ? 'covered' : 'absent';
}

// The first covering source with a parseable body, as { id, repo, pr, k, head, consumedAt, checkout }: what the sweep and the repair copy into the grant's own marker (its head and consumedAt, never `now`).
// null when nothing parseable covers it (an unparseable source covers by time but has no head to copy: F3) or coverage is indeterminate.
export function roundCoverageSource(record, { home = accountHome(), moves = [], repo, io = {} } = {}) {
  if (!isRoundRecord(record)) return null;
  const key = repoKey(repo ?? record.repo);
  if (key === null) return null;
  const s = coverageSources({ home, repo: key, pr: record.pr, k: record.k, moves, io });
  if (s.state !== 'ok') return null;
  const hit = coveringSources(record, s.sources, key, moves).find((x) => x.parseable);
  return hit === undefined ? null : sourceCopy(hit);
}
const sourceCopy = (s) => ({ id: s.id, repo: s.repo, pr: s.pr, k: s.k, head: s.head, consumedAt: s.consumedAt, checkout: s.checkout });

// Exclusively creates consumed/<grantId>.json holding `body` (written and fsynced; the folder too). 'ok' | 'exists' | 'error'. Any error AFTER the file exists leaves it behind: it reads as SPENT (and
// unverifiable), as everywhere. `io.writeSync` / `io.fsyncSync` are the tests' fault seams.
function writeMarkerFile(grantId, body, { home, io = {} }) {
  const file = markerPath(grantId, { home });
  if (file === null) return 'error';
  let fd;
  try {
    fd = openSync(file, OPEN_EXCL, 0o600);
  } catch (err) {
    return err?.code === 'EEXIST' ? 'exists' : 'error';
  }
  try {
    (io.writeSync ?? writeSync)(fd, `${JSON.stringify(body)}\n`);
    (io.fsyncSync ?? fsyncSync)(fd);
  } catch {
    try { closeSync(fd); } catch { /* spent either way */ }
    return 'error';
  }
  try { closeSync(fd); } catch { return 'error'; }
  return 'ok';
}
const derivedMarker = (grantId, source) => ({ v: 1, grantId, repo: source.repo, pr: source.pr, k: source.k, head: source.head, consumedAt: source.consumedAt, checkout: source.checkout ?? null, coveredBy: source.id });

// Why (#472): a covered grant's OWN per-grant marker, copied from the parseable source that covers it (head and consumedAt of the source, `coveredBy` = its id). Called by settlePendingClicks (before and
// after it appends a click's record), and by the reader repair. Never gated by the environment (F8). -> { coverage: 'absent' | 'covered' | 'indeterminate', marked: 'none' | 'written' | 'exists' | 'error' }
// ('none': nothing to write, no parseable source covers it or it is not covered).
export function markCoveredGrant(record, { home = accountHome(), moves, repo, io = {} } = {}) {
  if (!isRoundRecord(record)) return { coverage: 'absent', marked: 'none' };
  const key = repoKey(repo ?? record.repo);
  const id = grantIdOf(record);
  if (key === null || id === null) return { coverage: 'absent', marked: 'none' };
  const m = moves ?? readRepoMoves({ home }).moves;
  const s = coverageSources({ home, repo: key, pr: record.pr, k: record.k, moves: m, io });
  if (s.state !== 'ok') return { coverage: 'indeterminate', marked: 'none' };
  const hits = coveringSources(record, s.sources, key, m);
  if (hits.length === 0) return { coverage: 'absent', marked: 'none' };
  const source = hits.find((x) => x.parseable);
  if (source === undefined) return { coverage: 'covered', marked: 'none' };
  if (!realDirChain(home, CONSUMED_REL)) return { coverage: 'covered', marked: 'error' };
  const made = writeMarkerFile(id, derivedMarker(id, sourceCopy(source)), { home, io });
  return { coverage: 'covered', marked: made === 'ok' ? 'written' : made };
}

// The unspent records (before the provenance check) for this repository, PR, counted round k, newest first (see ownerGrantedRounds).
// #472: an extra-round record is also spent when a claim of its round covers it (roundCoverage: indeterminate counts as spent and, in strict mode, is a problem), and a covered one whose own marker is
// missing gets it written here (the repair; `settle: false` is the read-only paths' opt-out; the environment never gates it). Past-round records are never covered (F6).
// `opts.io.afterSpentCheck(record)` (tests): runs once for each record this call keeps, after its spent and coverage checks.
const grantsFor = (q = {}) => grantRecordsFor(isRoundRecord, q);
function grantRecordsFor(isKind, { repo, pr, k, head, anyHead = false, ...opts } = {}) {
  const key = repoKey(repo);
  if (key === null || !Number.isInteger(pr) || !Number.isInteger(k) || (!anyHead && !FULL_HEAD.test(String(head)))) return [];
  const moves = movesOf(opts);
  const extra = isKind === isRoundRecord;
  let sources = null; // read once, and only when a record gets this far
  return readRecords(opts)
    .filter((r) => {
      if (!(isKind(r) && sameRepo({ recorded: r.repo, recordedAt: r.ts, current: key, moves }) && r.pr === pr && r.k === k && r.head.length >= HEAD_CHARS && (anyHead || head.startsWith(r.head)))) return false;
      if (spentMarker(r, opts)) return false;
      if (extra) {
        sources ??= coverageSources({ home: opts.home ?? accountHome(), repo: key, pr, k, moves, io: opts.io ?? {} });
        if (sources.state !== 'ok') {
          if (Array.isArray(opts.problems) && !opts.problems.some((p) => p.startsWith("a grant's round claims"))) opts.problems.push(`a grant's round claims cannot be checked (${sources.why})`);
          return false;
        }
        const hits = coveringSources(r, sources.sources, key, moves);
        if (hits.length > 0) {
          const source = hits.find((x) => x.parseable);
          if (source !== undefined && opts.settle !== false) repairMarker(r, source, { home: opts.home ?? accountHome(), io: opts.io });
          return false;
        }
      }
      opts.io?.afterSpentCheck?.(r);
      return true;
    })
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
}
// The reader repair: the covered grant's own marker, if it is still missing. A failure is ignored (the grant stays spent for new readers; the next read tries again).
function repairMarker(record, source, { home, io }) {
  try {
    const id = grantIdOf(record);
    if (id === null || !realDirChain(home, CONSUMED_REL)) return;
    writeMarkerFile(id, derivedMarker(id, sourceCopy(source)), { home, io });
  } catch { /* spent for new readers either way */ }
}

// Every record for this repository, PR, counted round k whose recorded head starts the full head under review, younger than 24 h, with NO
// marker (a consumed, partial or unreadable marker is spent), newest first. All of them: a duplicate "extra round" must not outlive a claim.
// anyHead: true drops the head test (head is then ignored): the caller compares the head itself, to tell a stale grant from none.
// #128: only a record whose prompt is the owner's (promptProvenance) counts, as for a "merge".
export const ownerGrantedRounds = (q = {}) => ownedBy(grantsFor(q), { grant: true, home: q.home });

// The same lookup for the owner's approval of a PAST round (kind 'past-round'): unspent, < 24 h, bound to (repo, pr, k, head); pastRoundGrantsFor is before the provenance check,
// ownerPastRoundRecords after it (the owner's own prompts only). Nothing in the extra-round path reads these.
export const pastRoundGrantsFor = (q = {}) => grantRecordsFor(isPastRoundRecord, q);
export const ownerPastRoundRecords = (q = {}) => ownedBy(pastRoundGrantsFor(q), { grant: true, home: q.home });
// Every past-round record the owner typed for (repo, pr, k, full head), at ANY age and whatever its marker says, newest first: `state past-round-grant` resumes from a
// record whose marker an earlier, interrupted run already spent (the lookups above skip spent records).
export function ownerPastRoundHistory({ repo, pr, k, head, ...opts } = {}) {
  const key = repoKey(repo);
  if (key === null || !Number.isInteger(pr) || !Number.isInteger(k) || !FULL_HEAD.test(String(head))) return [];
  const moves = movesOf(opts);
  const found = readRecords({ ...opts, maxAgeMs: Infinity, maxBytes: VERIFY_MAX_BYTES })
    .filter((r) => isPastRoundRecord(r) && sameRepo({ recorded: r.repo, recordedAt: r.ts, current: key, moves }) && r.pr === pr && r.k === k && r.head.length >= HEAD_CHARS && head.startsWith(r.head))
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  return ownedBy(found, { grant: true, home: opts.home });
}

// Why ownerGrantedRounds found nothing, for the message: 'none' (no such record), 'provenance' (records exist but none is confirmed as typed
// by the owner) or 'ok' (at least one is the owner's).
export function ownerGrantGap(q = {}) {
  const found = grantsFor(q);
  if (found.length === 0) return 'none';
  return ownedBy(found, { grant: true, home: q.home }).length > 0 ? 'ok' : 'provenance';
}

// STRICT lookups for `triage defer-fixes` (and the follow-up recommendation of `triage round-request`), which must not defer past a grant it could not see: ownerGrantedRounds and
// ownerGrantGap answer [] / 'none' when the records cannot be read (readRecords never throws), so here every skipped read makes a lookup THROW instead: the records folder present but
// unreadable or not a real folder, a session file that cannot be read, is not a regular file or is over the size limit, a repo-moves file that is present but unreadable, and a
// consumed-grants folder that is not a real folder (readGrantMarker would call every grant spent), and a marker whose lookup fails for any reason but "not there" (a consumed folder that cannot be searched). An absent folder (nothing was ever recorded) is no grant, as before.
// Returns { grants(k), grantGap(k) } for the repository and PR at counted round k and ANY head: grants -> the records the owner typed (provenance confirmed), grantGap -> 'none' | 'provenance' | 'ok'.
export function ownerGrantLookups({ repo, pr, home = accountHome(), now = Date.now } = {}) {
  const base = [];
  const moves = readRepoMoves({ home });
  if (moves.error) base.push(`the recorded repository moves cannot be read (${moves.error})`);
  if (chainState(home, CONSUMED_REL) === 'unsafe') base.push('the consumed-grants folder is not a real folder');
  const read = (k) => {
    const problems = [...base];
    const found = grantsFor({ repo, pr, k, anyHead: true, home, now, repoMoves: moves.moves, problems });
    // #472: a round click that is still unverified (read AFTER the grants, so one this read just settled is no longer in it; computed in every read, never cached in `base`, so a lookup made after the
    // grace still sees it) is a grant this lookup could not see: defer-fixes / round-request must not read "no grant" over it. It stays a problem until its evidence could no longer matter.
    problems.push(...pendingClickProblems({ home, repo, pr, kinds: ['round'], now, moves: moves.moves }));
    if (problems.length > 0) throw new Error(problems.slice(0, 3).join('; '));
    return found;
  };
  return {
    grants: (k) => ownedBy(read(k), { grant: true, home }),
    grantGap(k) {
      const found = read(k);
      if (found.length === 0) return 'none';
      return ownedBy(found, { grant: true, home }).length > 0 ? 'ok' : 'provenance';
    },
  };
}

// R2-F3 for a grant: text to append to a refusal when the unconfirmed records' transcripts are under a config dir this process does not know ('' otherwise).
export const ownerGrantConfigDirHint = (q = {}) => configDirHint(grantsFor(q), { home: q.home });

// Consumes the grants: exclusively creates one marker per record (sorted by id, so two claimers meet on the same first marker). body =
// { repo, pr, k, head (40 hex), checkout }; each marker holds { v:1, grantId, repo, pr, k, head, consumedAt, checkout }. The file is written
// and fsynced (the folder too, except on Windows), and any error after the marker exists leaves it SPENT. Returns { ok:true, claimed:[{ grantId,
// file }] } or { ok:false, reason: 'used' (a marker was there) | 'spent' (we created it, then failed) | 'unsafe' | 'invalid' | 'none' }.
// `io` replaces writeSync / fsyncSync (tests).
// Why (#472) `ticket: true` (the extra-round claim of review-round.mjs; the past-round claim in state.mjs stays ticket-less): the claim first takes ONE O_EXCL round ticket for (repo, pr, k), so claims of a
// round are totally ordered and two claimers with disjoint snapshots cannot both win (see the block above grantRecordsFor). 1. read the tickets (indeterminate -> `unsafe`; n = the highest ticket); 2. re-run
// roundCoverage on every record: at least ONE must be `absent` (head-aware, the predicate admission applies), else `used` (indeterminate -> `unsafe`); 3. create ticket n + 1 (EEXIST -> `used`; an error
// after it exists -> `spent`, the ticket stands); 4. write the per-grant markers (as without a ticket, but with `coveredBy`, the ticket's head and consumedAt; an EEXIST marker that is verifiable, for
// this repo / PR / round / head and `coveredBy` this very ticket was written by a reader's repair between steps 3 and 4 and counts as ours: F2); 5. sweep: every extra-round grant of the round
// covering `body.head` that was answered at or before the ticket gets the missing marker too (a failed write -> `spent`; the ticket stands and readers repair the rest). Returns the same shapes, plus
// `ticket` ('<key16>.<n>') on success. Test seams in `io`: writeSync / fsyncSync (every write of the claim), readdirSync / lstatSync (coverage), afterTicket (between steps 3 and 4).
export function claimGrantMarkers(records, body, { home = accountHome(), now = Date.now, io = {}, ticket = false, repoMoves } = {}) {
  const ids = [...new Set((records ?? []).map(grantIdOf))];
  if ((records ?? []).length === 0) return { ok: false, reason: 'none' };
  const key = repoKey(body?.repo);
  if (ids.includes(null) || key === null || !Number.isInteger(body?.pr) || !Number.isInteger(body?.k) || !FULL_HEAD.test(String(body?.head))) return { ok: false, reason: 'invalid' };
  if (!realDirChain(home, CONSUMED_REL)) return { ok: false, reason: 'unsafe' };
  const sync = io.fsyncSync ?? fsyncSync;
  const claimed = [];
  let round = null; // the ticket this claim holds: { id, head, consumedAt }
  if (ticket) {
    const moves = movesOf({ home, repoMoves });
    const read = coverageSources({ home, repo: key, pr: body.pr, k: body.k, moves, io });
    if (read.state !== 'ok') return { ok: false, reason: 'unsafe' };
    const coverage = records.map((r) => (coveringSources(r, read.sources, key, moves).length > 0 ? 'covered' : 'absent'));
    if (!coverage.includes('absent')) return { ok: false, reason: 'used' };
    const n = read.tickets.reduce((most, t) => Math.max(most, t.n), 0) + 1;
    const id = `${roundTicketKey(key, body.pr, body.k)}.${n}`;
    const consumedAt = new Date(now()).toISOString();
    if (!realDirChain(home, ROUND_CLAIMS_REL)) return { ok: false, reason: 'unsafe' };
    const file = path.join(home, ...ROUND_CLAIMS_REL.split('/'), `${id}.json`);
    let fd;
    try {
      fd = openSync(file, OPEN_EXCL, 0o600);
    } catch (err) {
      return { ok: false, reason: err?.code === 'EEXIST' ? 'used' : 'unsafe', claimed };
    }
    try {
      (io.writeSync ?? writeSync)(fd, `${JSON.stringify({ v: 1, repo: key, pr: body.pr, k: body.k, n, head: body.head, consumedAt, grantIds: [...ids].sort() })}\n`);
      sync(fd);
    } catch {
      try { closeSync(fd); } catch { /* the ticket stands either way */ }
      return { ok: false, reason: 'spent', claimed };
    }
    try { closeSync(fd); } catch { return { ok: false, reason: 'spent', claimed }; }
    if (process.platform !== 'win32') {
      try {
        const dfd = openSync(path.dirname(file), constants.O_RDONLY);
        try { sync(dfd); } finally { closeSync(dfd); }
      } catch {
        return { ok: false, reason: 'spent', claimed };
      }
    }
    round = { id, head: body.head, consumedAt };
    io.afterTicket?.({ id });
  }
  const write = io.writeSync ?? writeSync;
  for (const grantId of ids.sort()) {
    const file = markerPath(grantId, { home });
    let fd;
    try {
      fd = openSync(file, OPEN_EXCL, 0o600);
    } catch (err) {
      if (err?.code === 'EEXIST' && round !== null && repairedByThisTicket(grantId, { home, key, body, ticket: round })) { claimed.push({ grantId, file }); continue; }
      return { ok: false, reason: err?.code === 'EEXIST' ? 'used' : 'unsafe', grantId, claimed };
    }
    try {
      write(fd, `${JSON.stringify({ v: 1, grantId, repo: key, pr: body.pr, k: body.k, head: body.head, consumedAt: round === null ? new Date(now()).toISOString() : round.consumedAt, checkout: typeof body.checkout === 'string' ? body.checkout : null, ...(round === null ? {} : { coveredBy: round.id }) })}\n`);
      sync(fd);
    } catch {
      try { closeSync(fd); } catch { /* spent either way */ }
      return { ok: false, reason: 'spent', grantId, claimed };
    }
    try { closeSync(fd); } catch { return { ok: false, reason: 'spent', grantId, claimed }; }
    claimed.push({ grantId, file });
  }
  if (process.platform !== 'win32') {
    try {
      const dfd = openSync(path.dirname(markerPath(ids[0], { home })), constants.O_RDONLY);
      try { sync(dfd); } finally { closeSync(dfd); }
    } catch {
      return { ok: false, reason: 'spent', claimed };
    }
  }
  if (round !== null && !sweepCovered({ home, now, io, key, body, ticket: round, repoMoves, held: new Set(ids) })) return { ok: false, reason: 'spent', claimed };
  return { ok: true, claimed, ...(round === null ? {} : { ticket: round.id }) };
}

// F2: a marker that already stands for this grant is OUR claim's when it is verifiable, for this repository / PR / round / head, and `coveredBy` this very ticket (a reader's repair wrote it between the ticket
// and the marker step).
function repairedByThisTicket(grantId, { home, key, body, ticket }) {
  const m = readGrantMarker(grantId, { home });
  return m.verifiable && m.marker.repo === key && m.marker.pr === body.pr && m.marker.k === body.k && m.marker.head === body.head && m.marker.coveredBy === ticket.id;
}

// The claim's sweep (step 5): every extra-round grant of (repo, pr, k) covering the claimed head that was answered at or before the ticket, settled records included, gets its own marker from this ticket
// when it has none (a marker that already stands is fine: that grant is spent). false when a write failed.
function sweepCovered({ home, now, io, key, body, ticket, repoMoves, held }) {
  const moves = movesOf({ home, repoMoves });
  const upTo = Date.parse(ticket.consumedAt);
  const source = { id: ticket.id, repo: key, pr: body.pr, k: body.k, head: ticket.head, consumedAt: ticket.consumedAt, checkout: typeof body.checkout === 'string' ? body.checkout : null };
  for (const r of readRecords({ home, now })) {
    if (!isRoundRecord(r) || !sameRepo({ recorded: r.repo, recordedAt: r.ts, current: key, moves }) || r.pr !== body.pr || r.k !== body.k || !body.head.startsWith(r.head) || Date.parse(r.ts) > upTo) continue;
    const id = grantIdOf(r);
    if (id === null || held.has(id)) continue;
    const made = writeMarkerFile(id, derivedMarker(id, source), { home, io });
    if (made === 'error') return false;
  }
  return true;
}

// What is on disk for a grant id: { spent: false, verifiable: false } (no marker), { spent: true, verifiable: true, marker } or
// { spent: true, verifiable: false } (a partial, unparseable, linked or otherwise odd marker, or an unsafe folder: spent, never trusted); the last also
// carries lookupError (an error code) when the marker could not even be looked up (not ENOENT), which is not proof it exists.
export function readGrantMarker(grantId, { home = accountHome() } = {}) {
  const file = markerPath(grantId, { home });
  if (file === null) return { spent: true, verifiable: false };
  const chain = chainState(home, CONSUMED_REL);
  if (chain === 'missing') return { spent: false, verifiable: false };
  if (chain === 'unsafe') return { spent: true, verifiable: false };
  try {
    if (!lstatSync(file).isFile()) return { spent: true, verifiable: false };
  } catch (err) {
    return err?.code === 'ENOENT' ? { spent: false, verifiable: false } : { spent: true, verifiable: false, lookupError: err?.code ?? 'unknown' };
  }
  try {
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    let text;
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.size > 64 * 1024) return { spent: true, verifiable: false };
      const buf = Buffer.alloc(st.size);
      readSync(fd, buf, 0, st.size, 0);
      text = buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
    const m = JSON.parse(text);
    if (m?.v === 1 && m.grantId === grantId && repoKey(m.repo) === m.repo && Number.isInteger(m.pr) && Number.isInteger(m.k) && FULL_HEAD.test(String(m.head)) && typeof m.consumedAt === 'string') {
      return { spent: true, verifiable: true, marker: m };
    }
  } catch { /* partial or unreadable: spent, not verifiable */ }
  return { spent: true, verifiable: false };
}

const VERIFY_MAX_BYTES = 64 * 1024 * 1024; // the gate's read of the records: a big session file must not hide one

// The final gate / review-complete: is `ownerGrant` ({ grantId, quote, k? }) on a counted round k of this repository's PR, whose head under
// review is `toHead` (full), backed by an owner record (read at any age) AND a verifiable marker? The grant id is recomputed from the
// record, repo / PR / k must equal, the marker's full head must be `toHead`, and the quote must be the record's prompt byte for byte.
// Returns { ok: true, quote, record } or { ok: false, reason }.
export function verifyOwnerGrant({ repo, pr, k, toHead, ownerGrant } = {}, opts = {}) {
  const key = repoKey(repo);
  const id = ownerGrant?.grantId;
  if (key === null || !Number.isInteger(pr) || !Number.isInteger(k) || !FULL_HEAD.test(String(toHead))) return { ok: false, reason: 'malformed' };
  if (!GRANT_ID.test(String(id)) || typeof ownerGrant.quote !== 'string' || (ownerGrant.k !== undefined && ownerGrant.k !== k)) return { ok: false, reason: 'malformed' };
  if (ownerGrant.past !== undefined && typeof ownerGrant.past !== 'boolean') return { ok: false, reason: 'malformed' };
  const isKind = ownerGrant.past === true ? isPastRoundRecord : isRoundRecord; // a past-round approval backs only a `past` grant, an extra-round grant only a non-past one
  const record = readRecords({ ...opts, maxAgeMs: Infinity, maxBytes: VERIFY_MAX_BYTES }).find((r) => isKind(r) && grantIdOf(r) === id);
  if (!record) return { ok: false, reason: 'no-record' };
  const moves = movesOf(opts);
  if (!sameRepo({ recorded: record.repo, recordedAt: record.ts, current: key, moves }) || record.pr !== pr || record.k !== k || !toHead.startsWith(record.head)) return { ok: false, reason: 'mismatch' };
  if (ownedBy([record], { grant: true, home: opts.home }).length === 0) return { ok: false, reason: 'provenance' }; // (#128: the prompt is not the owner's, or is gone from the transcript)
  const m = readGrantMarker(id, { home: opts.home });
  if (!m.spent) return { ok: false, reason: 'no-marker' };
  if (!m.verifiable) return { ok: false, reason: 'unverifiable-marker' };
  if (!sameRepo({ recorded: m.marker.repo, recordedAt: m.marker.consumedAt, current: key, moves }) || m.marker.pr !== pr || m.marker.k !== k || m.marker.head !== toHead) return { ok: false, reason: 'mismatch' };
  if (ownerGrant.quote !== record.prompt) return { ok: false, reason: 'quote' };
  return { ok: true, quote: record.prompt, record };
}
