// `pipeline cost --pr N --phase P --role R [--input N] [--output N] [--cache-read N] [--cache-write N] [--usd X]`: books
// one spend (an agent dispatch, a review call) in the run record's cost section, so `P summary` can show tokens and USD
// by phase and role. `--retry` counts a retry; `--session ID` names a Claude session of this run (its guard denies are
// counted at `P summary`). Display only: like every run-record write, a failure is a warning, never a decision.
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { EXIT, UsageError, intOption, parseCommandArgs, requireOption } from '../lib/cli.mjs';
import { guarded, resolveRepo } from '../lib/cmd-common.mjs';
import { createGitHub, guardGh } from '../lib/github.mjs';
import { createRunRecorder } from '../lib/run-progress.mjs';
import { PRICE_TABLE_DATE, costReport, modelFamily, normalisePhase, normaliseRole, priceMessage, usageFromTranscript } from '../lib/run-cost.mjs';

export const meta = {
  summary: 'book tokens / USD / retries of one agent call in the run record (shown by `P summary`)',
  usage: [
    'pipeline cost --pr N --phase build|verify|pr|review|gate|merge|... --role implementer|judge|arbiter|substitute-opus|substitute-fable|verifier|controller|other',
    '              [--input N] [--output N] [--cache-read N] [--cache-write N] [--usd X | --model M] [--from-transcript FILE] [--round R] [--retry] [--session ID]... [--repo DIR]',
    '  -> {ok, recorded, cost, warnings}; exit 2 usage (a negative or non-numeric amount, a --round that is not a whole number >= 1 or comes without an amount), 3 GitHub unavailable',
    '  An unknown --role is booked as `other`, an unknown --phase as `other`. --from-transcript FILE: sum the message.usage of a Claude transcript (JSONL, at most 50 MB; a file that is not there yet is looked for 5 times over ~2 s, and a half-written last line is skipped);',
    '  explicit --input/--output/--cache-* then add to it. --retry alone (no amounts) only counts a retry.',
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

  const spent = ['input', 'output', 'cache-read', 'cache-write', 'usd', 'from-transcript'].some((k) => values[k] !== undefined);
  if (!spent && !values.retry && !values.session?.length) throw new UsageError('nothing to record: pass amounts (--input … --usd), --retry or --session');

  if (round !== undefined && !spent) throw new UsageError('--round books an amount: pass amounts (--input … --usd) with it');
  if (values.model !== undefined && modelFamily(values.model) === null) throw new UsageError(`--model ${values.model}: not one of opus, sonnet, haiku, fable`);
  const fromFile = values['from-transcript'] ? transcriptUsage(values['from-transcript'], root, values.model) : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0, unpricedMessages: 0, byPrice: {} };
  const num = (flag) => {
    if (values[flag] === undefined) return 0;
    const n = Number(values[flag]);
    if (!Number.isFinite(n) || n < 0) throw new UsageError(`--${flag} must be a non-negative number`);
    return n;
  };
  const patch = { cost: {} };
  const notes = [];
  // A file that appears before its lines are flushed reads as empty or partial: still booked, but the caller is told it may be low.
  // The replay advice (what to repeat, what not to) is added after the write and only when it succeeded: after a failed write nothing was booked, so the whole command is run again.
  const emptyTranscript = Boolean(values['from-transcript']) && fromFile.messages === 0;
  let bucketed = false;
  if (spent) {
    const own = { input: num('input'), output: num('output'), cacheRead: num('cache-read'), cacheWrite: num('cache-write') };
    const ownTokens = own.input + own.output + own.cacheRead + own.cacheWrite > 0;
    let usd = num('usd');
    let byPrice = {};
    let complete = false;
    if (values.usd === undefined) {
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
  if (values.retry) patch.cost.retries = 1;
  if (values.session?.length) patch.cost.sessions = values.session;

  const gh = createGitHub({ cwd: root, env: ctx.env });
  return guardGh(() => {
    const recorder = createRunRecorder({ gh, pr });
    const record = recorder.update(patch);
    const ok = record !== null;
    if (emptyTranscript) {
      notes.push('the transcript held no messages (it may not be flushed yet): the booking may be low');
      notes.push(ok
        ? `later book the rest by running again with the same --phase, --role and --round and only --from-transcript: leave out --retry and hand token amounts (already booked, they would count twice)${values.usd !== undefined ? ', and pass --usd 0 (the --usd amount is already booked)' : ''}`
        : 'the booking was not recorded: once the transcript is flushed, run the whole command again');
    }
    return {
      exitCode: ok ? EXIT.OK : EXIT.FAILED,
      output: { ok, recorded: ok, bucketed: ok && bucketed, cost: ok ? costReport(record.cost) : null, warnings: [...notes, ...recorder.warnings] },
    };
  });
});
