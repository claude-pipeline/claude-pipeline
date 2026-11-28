// `pipeline cost --pr N --phase P --role R [--input N] [--output N] [--cache-read N] [--cache-write N] [--usd X]`: books
// one spend (an agent dispatch, a review call) as its OWN PR comment (a `cost-booking` event, never edited), so `P summary` can show tokens and USD
// by phase and role. The PR's cost is the replay of those comments on top of the run record's own cost section (run-cost.mjs#effectiveCost): no
// writer can overwrite another's booking, because nothing is ever edited. `--retry` counts a retry; `--session ID` names a Claude session of this run
// (its guard denies are counted at `P summary`). Display only: a failure is a warning or an exit code, never a decision of the pipeline.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { EXIT, UsageError, intOption, parseCommandArgs, requireOption } from '../lib/cli.mjs';
import { guarded, resolveRepo } from '../lib/cmd-common.mjs';
import { OutboundScanBlocked, createGitHub, guardGh } from '../lib/github.mjs';
import { GhError } from '../lib/proc.mjs';
import { VIEW_FIELDS } from '../lib/run-progress.mjs';
import { costBookingProblem, postEvent } from '../lib/run-events.mjs';
import { summaryFromComments } from '../lib/summary-comment.mjs';
import { PRICE_TABLE_DATE, costReport, modelFamily, normalisePhase, normaliseRole, priceMessage, usageFromTranscript } from '../lib/run-cost.mjs';

export const meta = {
  summary: 'book tokens / USD / retries of one agent call as its own PR comment (the PR cost shown by `P summary` is their sum)',
  usage: [
    'pipeline cost --pr N --phase plan|build|verify|pr|review|gate|merge|... --role implementer|judge|arbiter|substitute-opus|substitute-fable|plan-review|plan-codex|verifier|controller|other',
    '              [--input N] [--output N] [--cache-read N] [--cache-write N] [--usd X | --model M] [--from-transcript FILE] [--round R] [--retry] [--session ID]... [--repo DIR]',
    '  -> {ok, recorded, skipped?, confirmed, id, call, cost, warnings}; `call` = what THIS call added to the PR total ({usd, input, output, cacheRead, cacheWrite, phase, role, round?}, after the transcript dedupe: a transcript booked before books only what it gained since, unless --usd is given: then every call books the full tokens and USD); null when nothing was booked (an empty-transcript skip, a retry/session-only call, an unconfirmed booking). `cost` = the PR total so far (every call booked for the PR), never one call: read a call\'s own figure from `call`. Each booking is its OWN PR comment (a `cost-booking` event, never edited) and the PR total is those comments added up on top of the run record\'s cost section, so two bookings at the same moment cannot overwrite each other; the summary comment\'s cost line is the total as of its last render (every record write re-renders it). `confirmed: false` (with `call` and `cost` null) = the booking was posted (`id`) but the total could not be read back: do NOT book that call again. Exit 1 when nothing was booked (the PR is not a PR, the outbound scan refused, the amounts are malformed) or when posting failed and the booking may or may not exist (`outcome: "unknown"` and the `id`: look for that id on the PR before booking again), 2 usage (a negative or non-numeric amount, a --round that is not a whole number >= 1 or comes without an amount, an empty --from-transcript), 3 GitHub unavailable',
    '  An unknown --role is booked as `other`, an unknown --phase as `other`. --from-transcript FILE: sum the message.usage of a Claude transcript (JSONL, at most 50 MB; a file that is not there yet is looked for 5 times over ~2 s, and a half-written last line is skipped; a transcript with no usable messages gives a warning, and when no --input/--output/--cache-*/--usd came with it NOTHING is booked for that call (no entry, no retry; `recorded` false, `skipped: "empty-transcript"`; `--session` is still recorded): run the same command again in a few seconds);',
    '  explicit --input/--output/--cache-* then add to it. --retry alone (no amounts) only counts a retry.',
    '  --phase plan books a plan review (before the PR exists, like build calls): --role plan-review (a Fable/Opus/Sonnet plan reviewer, priced from its transcript) or plan-codex (a hand-run Codex plan review: tokens only, no USD unless --usd); `P summary` shows plan ahead of build.',
  '  --round R: the review round the call served (judge or arbiter of round R, and the implementer that fixes round R\'s accepts); the entry is also added to cost.byRound[R],',
  '  which the extra-round ask uses to name what the last round cost. Build-phase calls pass none.',
  '  USD: --usd X as given; otherwise the list price of each transcript message\'s own model version (--model M prices the messages that carry none)',
  '  plus the explicit tokens at --model M. Tokens with no known model add no USD (a warning says so). Priced tokens are also booked in',
  '  cost.byPrice (keyed model|tier|speed) so a later price table can re-price them; output `bucketed` says whether this entry carries them.',
  ].join('\n'),
};

const MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024;

const sleepSync = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

// Right after an agent returns its transcript file can lag a moment behind (not on disk yet): a missing file is looked for again a few times (5 looks, 0.5 s apart, ~2 s) before it fails.
// A last line still being written is skipped by usageFromTranscript (a half line is not JSON), never an error.
export function transcriptUsage(file, root, defaultModel, { sleep = sleepSync, tries = 5, delayMs = 500 } = {}) {
  const abs = resolve(root, file);
  let size;
  for (let attempt = 1; ; attempt++) {
    try {
      size = statSync(abs).size;
      break;
    } catch (err) {
      if (err.code === 'ENOENT' && attempt < tries) {
        sleep(delayMs);
        continue;
      }
      const cause = err.code === 'ENOENT' ? ` after ${attempt} tries over ~${Math.round(((attempt - 1) * delayMs) / 100) / 10} s: the agent's transcript may not be on disk yet (it can lag a moment behind the agent's return): run this again in a few seconds, or check the path` : '';
      throw new UsageError(`--from-transcript: cannot read ${file} (${err.code ?? err.message})${cause}`);
    }
  }
  if (size > MAX_TRANSCRIPT_BYTES) throw new UsageError(`--from-transcript: ${file} is ${size} bytes, at most ${MAX_TRANSCRIPT_BYTES} allowed`);
  return usageFromTranscript(readFileSync(abs, 'utf8'), { defaultModel });
}

// What this booking added to the total: its contribution to the replay (the total after it minus the total before it, in comment-id order: AFTER the transcript dedupe, so it can be less than the entry)
// plus what the entry names. null for a retry / session-only booking.
function callOf(entry, added) {
  if (entry === undefined || added === undefined) return null;
  return { ...added, phase: entry.phase, role: entry.role, ...(entry.round !== undefined ? { round: entry.round } : {}) };
}

const sayErr = (err) => String(err?.message ?? err).slice(0, 200);

export const run = guarded(async (argv, ctx) => {
  const { values } = parseCommandArgs(argv, {
    pr: { type: 'string' }, phase: { type: 'string' }, role: { type: 'string' },
    input: { type: 'string' }, output: { type: 'string' }, 'cache-read': { type: 'string' }, 'cache-write': { type: 'string' },
    usd: { type: 'string' }, model: { type: 'string' }, 'from-transcript': { type: 'string' }, retry: { type: 'boolean' }, session: { type: 'string', multiple: true },
    round: { type: 'string' }, repo: { type: 'string' },
  }, { allowPositionals: false });
  const pr = intOption(values, 'pr', { required: true, min: 1 });
  const phase = requireOption(values, 'phase');
  const role = requireOption(values, 'role');
  const round = intOption(values, 'round', { min: 1 });
  const root = resolveRepo(values, ctx);

  if (values['from-transcript'] !== undefined && values['from-transcript'].trim() === '') throw new UsageError('--from-transcript is empty (an unset shell variable?): pass the transcript path');
  const spent = ['input', 'output', 'cache-read', 'cache-write', 'usd', 'from-transcript'].some((k) => values[k] !== undefined);
  if (!spent && !values.retry && !values.session?.length) throw new UsageError('nothing to record: pass amounts (--input … --usd), --retry or --session');

  if (round !== undefined && !spent) throw new UsageError('--round books an amount: pass amounts (--input … --usd) with it');
  if (values.model !== undefined && modelFamily(values.model) === null) throw new UsageError(`--model ${values.model}: not one of opus, sonnet, haiku, fable`);
  const fromFile = values['from-transcript'] ? transcriptUsage(values['from-transcript'], root, values.model) : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0, unpricedMessages: 0, byPrice: {} };
  const num = (flag) => {
    if (values[flag] === undefined) return 0;
    if (values[flag].trim() === '') throw new UsageError(`--${flag} is empty (an unset shell variable?): pass a number`);
    const n = Number(values[flag]);
    if (!Number.isFinite(n) || n < 0) throw new UsageError(`--${flag} must be a non-negative number`);
    return n;
  };
  const patch = { cost: {} };
  const notes = [];
  let bucketed = false;
  // A transcript with no usable message and no hand amount books NOTHING for this call (no entry, no transcript key, no retry): the re-run the warning asks for must be the one booking, or the call counts twice (#820).
  const handAmounts = ['input', 'output', 'cache-read', 'cache-write', 'usd'].some((k) => values[k] !== undefined);
  const emptyTranscript = values['from-transcript'] !== undefined && fromFile.messages === 0 && !handAmounts;
  if (values['from-transcript'] && fromFile.messages === 0) notes.push(`--from-transcript ${values['from-transcript']}: no messages with usage found in it (empty, or not fully written yet): no tokens or USD were taken from it${emptyTranscript ? '; nothing was booked; run this same command again in a few seconds' : ''}`);
  if (spent && !emptyTranscript) {
    const own = { input: num('input'), output: num('output'), cacheRead: num('cache-read'), cacheWrite: num('cache-write') };
    const ownTokens = own.input + own.output + own.cacheRead + own.cacheWrite > 0;
    let usd = num('usd');
    let byPrice = {};
    let complete = false;
    // plan-codex is tokens only: its USD is never derived from --model or a transcript, only an explicit --usd sets it.
    const tokensOnly = normaliseRole(role) === 'plan-codex';
    if (values.usd === undefined && tokensOnly) {
      usd = 0;
    } else if (values.usd === undefined) {
      const ownPriced = ownTokens && values.model !== undefined ? priceMessage(values.model, own) : null;
      usd = fromFile.usd + (ownPriced?.usd ?? 0);
      // Buckets hold the tokens the table priced (a transcript's, and hand tokens given with --model); hand tokens without a model
      // stay out of them, and a --usd override is a hand figure that is not bucketed at all.
      byPrice = { ...fromFile.byPrice };
      if (ownPriced) {
        const key = `${values.model.replaceAll('|', '_')}|${ownPriced.tier}|${ownPriced.speed}`;
        const b = byPrice[key] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, messages: 0 };
        byPrice[key] = { input: b.input + own.input, output: b.output + own.output, cacheRead: b.cacheRead + own.cacheRead, cacheWrite5m: b.cacheWrite5m + own.cacheWrite, cacheWrite1h: b.cacheWrite1h, messages: b.messages + 1 };
      }
      complete = !ownTokens || ownPriced !== null;
      if (ownTokens && values.model === undefined) notes.push('tokens booked without --model or --usd: no USD added for them');
      if (fromFile.unpricedMessages > 0) notes.push(`${fromFile.unpricedMessages} transcript message(s) of a model with no list price: no USD added for them`);
    }
    patch.cost.entry = {
      phase: normalisePhase(phase), role: normaliseRole(role),
      input: fromFile.input + num('input'), output: fromFile.output + num('output'),
      cacheRead: fromFile.cacheRead + num('cache-read'), cacheWrite: fromFile.cacheWrite + num('cache-write'),
      usd: Math.round(usd * 1e6) / 1e6,
      ...(round !== undefined ? { round } : {}),
      ...(Object.keys(byPrice).length ? { byPrice, priceTable: PRICE_TABLE_DATE } : {}),
    };
    bucketed = complete && Object.keys(byPrice).length > 0;
    // A transcript booked before for this PR (an agent continued by SendMessage) books only what it gained since: the run record keeps what was booked per transcript. The key is a sanitised, clipped
    // file name plus a short hash of the resolved path (two different files of one name stay apart; never the raw path, which would put the home folder into the PR comment) and always passes run-cost's shape check.
    if (values['from-transcript'] && values.usd === undefined) {
      const file = resolve(root, values['from-transcript']);
      const hash = createHash('sha256').update(file).digest('hex').slice(0, 12);
      patch.cost.transcript = { key: `${basename(file).replace(/[^\w.-]/g, '_').slice(0, 100)}-${hash}`, usage: fromFile };
    }
  }
  if (values.retry && !emptyTranscript) patch.cost.retries = 1;
  if (values.session?.length) patch.cost.sessions = values.session;

  if (emptyTranscript && !values.session?.length) {
    return { exitCode: EXIT.OK, output: { ok: true, recorded: false, skipped: 'empty-transcript', bucketed: false, call: null, cost: null, warnings: notes } };
  }
  // One id per `P cost` run, kept in the booking: the way to find out whether a booking whose answer got lost reached the PR, and what a replay deduplicates by.
  const id = randomUUID();
  const data = { ...patch.cost, id };
  const problem = costBookingProblem(data);
  const sentence = patch.cost.entry
    ? `Cost booked: ${patch.cost.entry.phase} / ${patch.cost.entry.role}${patch.cost.entry.round !== undefined ? `, round ${patch.cost.entry.round}` : ''}, ${patch.cost.transcript ? `transcript total so far $${patch.cost.entry.usd} (the PR's cost adds only what it gained since its last booking)` : `$${patch.cost.entry.usd}`}. Never edited: the PR's cost adds these comments up.`
    : "Cost booking: a retry or a session. Never edited: the PR's cost adds these comments up.";
  const recorded = !emptyTranscript;

  const gh = createGitHub({ cwd: root, env: ctx.env });
  return guardGh(() => {
    const refused = (why) => ({ exitCode: EXIT.FAILED, output: { ok: false, recorded: false, bucketed: false, call: null, cost: null, warnings: [...notes, `not booked: ${why}`] } });
    if (problem !== null) return refused(problem);
    // Before the post: the PR must be one (createComment accepts a plain issue too), and the repo is looked up (the outbound scan needs it): a failure here means nothing was posted.
    try {
      gh.repo();
      gh.prView(pr, [...VIEW_FIELDS]);
    } catch (err) {
      return refused(sayErr(err));
    }
    let postError = null;
    try {
      postEvent(gh, pr, 'cost-booking', id, sentence, data);
    } catch (err) {
      // An outbound-scan refusal (or any error that is not gh's) is thrown BEFORE anything is sent: definitely not booked. A gh error may be a lost answer to a POST that landed.
      if (!(err instanceof GhError) || err instanceof OutboundScanBlocked) return refused(sayErr(err));
      postError = err;
    }
    // One listing: the booking's own contribution and the new total come from the same replay.
    let found = null;
    let listError = null;
    try {
      const me = gh.viewer();
      found = summaryFromComments(gh.listComments(pr), me, pr);
    } catch (err) {
      listError = err;
    }
    const visible = found?.costBookings.bookings.some((b) => b.id === id) === true;
    if (postError !== null && !visible) {
      return {
        exitCode: EXIT.FAILED,
        output: {
          ok: false, recorded: false, outcome: 'unknown', id, bucketed: false, call: null, cost: null,
          warnings: [...notes, `the booking may or may not exist (posting it failed: ${sayErr(postError)}${listError ? `; the PR's comments could not be read: ${sayErr(listError)}` : ''}): look for id ${id} on the PR before booking again`],
        },
      };
    }
    const base = { ok: true, recorded, ...(emptyTranscript ? { skipped: 'empty-transcript' } : {}), id, bucketed };
    if (!visible) {
      return {
        exitCode: EXIT.OK,
        output: { ...base, confirmed: false, call: null, cost: null, warnings: [...notes, `booked (id ${id}); total not confirmed${listError ? ` (the PR's comments could not be read: ${sayErr(listError)})` : ' (the booking is not in the PR comments yet)'}: do NOT book this call again`] },
      };
    }
    const eff = found.effectiveCost;
    const warnings = [...notes];
    if (postError !== null) warnings.push(`posting the booking reported an error (${sayErr(postError)}), but it is on the PR (id ${id})`);
    if (eff.unavailable !== undefined) {
      warnings.push(`booked (id ${id}); cost unavailable: ${eff.unavailable}`);
      return { exitCode: EXIT.OK, output: { ...base, confirmed: true, call: null, cost: null, warnings } };
    }
    return { exitCode: EXIT.OK, output: { ...base, confirmed: true, call: callOf(patch.cost.entry, eff.contributions.get(id)), cost: costReport(eff.cost), warnings } };
  });
});
