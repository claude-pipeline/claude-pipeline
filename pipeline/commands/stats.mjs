// `pipeline stats rounds`: how many review rounds merged PRs used, how many went past review.max_rounds, what those found and what they cost. Reads each PR's own
// comments (run record, triage state); read-only, display only. Replaces the ad-hoc audit scripts of 2026-11-11.
import { EXIT, UsageError, intOption, parseCommandArgs } from '../lib/cli.mjs';
import { guarded, resolveRepo } from '../lib/cmd-common.mjs';
import { createGitHub, guardGh } from '../lib/github.mjs';
import { MAX_PAGES, PAGE, pages } from '../lib/gh-pages.mjs';
import { adoptRecord, decodeRecord } from '../lib/run-record.mjs';
import { decodeFromComment } from '../lib/state.mjs';
import { aggregate, analysePr, isReadableState, renderTable } from '../lib/round-stats.mjs';
import { MARKERS } from '../lib/render.mjs';
import { asciiLine } from '../lib/triage.mjs';

export const meta = {
  summary: 'review rounds of merged PRs: how many went past the limit, what they found and cost',
  usage: [
    'pipeline stats rounds [--repo-slug owner/name]... [--since YYYY-MM-DD] [--pr N]... [--json] [--repo DIR]',
    '  -> {ok, since, repos, totals, prs, warnings}: for the PRs merged since the date (default 7 days ago) in each --repo-slug (default: the repository gh resolves from the current directory), the PR\'s comments are',
    '     read (run record, triage state) and counted: totals {prs, prsPastCap, countedRounds, pastCapRounds, pastCapShare, admission {auto-extra|owner-granted|unknown}, previous (what the round before a past-limit round had',
    '     to re-check: no-accepts | only-low-fixes = non-BLOCKING non-security accepts | blocking-or-security), found (new-blocking | accepts | deferred = its accepts were all deferred past the cap | nothing-accepted), blockingLoopPrs, capDeferredPrs, capDeferredItems, capDeferReopened, capLowNotDeferred, usd, pastCapUsd}; prs [{repo, pr, id, maxRounds,',
    '     countedRounds, pastCapRounds, usd, blockingLoop, capDeferredItems, capDeferReopened, capLowNotDeferred, rounds: [{n, k, pastCap, usd (cost.byRound, `cost --round R`), reviewKind, resolutionIneligible, acceptedBlocking, capDeferred? (on the row of the last allowed round), admission?, previous?, found?}]}]. The cap-low numbers (review.cap_low_accepts) count over EVERY round of the state, one per item id and not a cached copy: capDeferredItems = accepts `triage cap-defer` turned into follow-ups unapplied, capDeferReopened = of those, tightened back to ACCEPT by Claude (the floor was wrong), capLowNotDeferred = 1 when the last allowed round\'s accepts were all low by this stats rule, nothing was deferred and an automatic extra round followed. --pr N limits it to those PRs (merged or not listed by date).',
    '     Without --json the same numbers print as a plain-text table. Only the viewer\'s own comments count (the pipeline\'s comments posted under another login are ignored, with a warning); a pipeline comment that is skipped (other author, bound to another PR, unreadable) is named in `warnings`; a run record of this PR that names another repository (the repo was renamed or moved) still counts, with a warning, when its branch is the live branch of the PR (one extra read of the PR); a pull request reached through two slugs counts once, with a warning. A PR whose comments cannot be read is skipped with a warning; a PR with no review state is counted in `withoutState`. Exit 3 when GitHub cannot be reached for the list.',
    '     Read-only. Severity is judged from the recorded item (BLOCKING, a security category or a security word is not low), since a PR comment does not carry the reviewed diff `itemSeverity` needs.',
  ].join('\n'),
};

const SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DAY_MS = 86_400_000;

async function rounds(rest, ctx) {
  const { values } = parseCommandArgs(rest, { 'repo-slug': { type: 'string', multiple: true }, since: { type: 'string' }, pr: { type: 'string', multiple: true }, json: { type: 'boolean' }, repo: { type: 'string' } }, { allowPositionals: false });
  const since = values.since ?? new Date((ctx.now ?? Date.now()) - 7 * DAY_MS).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || Number.isNaN(Date.parse(`${since}T00:00:00Z`))) throw new UsageError('--since must be a date, YYYY-MM-DD');
  const only = (values.pr ?? []).map((p) => intOption({ pr: p }, 'pr', { min: 1 }));
  for (const s of values['repo-slug'] ?? []) if (!SLUG_RE.test(s)) throw new UsageError(`--repo-slug ${asciiLine(s, 60)}: expected owner/name`);
  const root = resolveRepo(values, ctx);
  const gh = createGitHub({ cwd: root, env: ctx.env });
  return guardGh(() => {
    const me = gh.viewer(); // asked first: only the viewer's own comments are the pipeline's (summary-comment.mjs, review-publish.mjs)
    const repos = (values['repo-slug'] ?? []).length > 0 ? [...new Set(values['repo-slug'])] : [gh.repo().slug];
    const warnings = [];
    const analysed = [];
    const seen = new Map();
    let withoutState = 0;
    for (const slug of repos) {
      let numbers;
      if (only.length > 0) numbers = only.map((number) => ({ number }));
      else {
        // newest-updated first: stop once a whole page is older than the date (a merged PR was updated at its merge, so nothing later in the list merged since)
        const closed = pages(gh, `repos/${slug}/pulls?state=closed&sort=updated&direction=desc`, (l) => l.every((p) => String(p.updated_at ?? '') < since), () => warnings.push(`${slug}: the list of closed PRs was cut after ${MAX_PAGES} pages (${MAX_PAGES * PAGE} PRs): merged PRs further back are missing, so the totals are short (use a later --since)`));
        numbers = closed.filter((p) => typeof p.merged_at === 'string' && p.merged_at >= since).map((p) => ({ number: p.number, nodeId: p.node_id }));
      }
      for (const { number, nodeId } of numbers) {
        try {
          // The PR itself, read at most once and only when needed (a record naming another repository: its branch; two slugs: its identity). null = could not be read.
          let pull;
          const livePull = () => {
            if (pull === undefined) {
              try { pull = gh.api('GET', `repos/${slug}/pulls/${number}`) ?? null; } catch { pull = null; }
            }
            return pull;
          };
          const comments = pages(gh, `repos/${slug}/issues/${number}/comments`, undefined, () => warnings.push(`${slug}#${number}: the comments were cut after ${MAX_PAGES} pages (${MAX_PAGES * PAGE} comments): the record or state may be missing or old`));
          let record = null; // the record of THIS repository slug: it wins over an adopted one whatever the comment order
          let adopted = null; // a record of the repository the PR moved from, adopted only when its branch is the live one: { record, from }
          let state = null;
          const slugLower = slug.toLowerCase();
          const skip = (what, why) => warnings.push(`${slug}#${number}: ignored ${what}${why}`);
          for (const c of comments) {
            if (typeof c?.body !== 'string') continue;
            const isState = c.body.startsWith(MARKERS.triage);
            const isRecord = c.body.startsWith(MARKERS.summary);
            // only our own comment that STARTS with the marker, for this repository and PR: a quote, a copy or someone else's comment is never the state.
            // A comment that does start with a marker but is skipped says why, so the totals are not silently short.
            if (c.user?.login !== me) {
              if (isState || isRecord) skip(`a ${isState ? 'review state' : 'run record'} comment by ${asciiLine(c.user?.login, 60) || 'an unknown author'}`, ": only the viewer's own comments count");
              continue;
            }
            if (isRecord) {
              const r = decodeRecord(c.body);
              if (r.status === 'ok') {
                // The repo is the only mismatch ⇒ the PR was merged before a rename/transfer and this is still its own record (adoptRecord, #671); a slug that differs only in case is the same repository.
                const sameRepo = String(r.record.repo ?? '').toLowerCase() === slugLower;
                // a record naming another repository is adopted only when its branch is the PR's live one (else a copied record of another PR with the same number would be taken)
                const branch = sameRepo ? undefined : livePull()?.head?.ref;
                const lookupFailed = !sameRepo && typeof branch !== 'string';
                const bound = lookupFailed ? { record: null } : adoptRecord(r.record, { repo: sameRepo ? r.record.repo : slug, pr: number, branch });
                if (bound.record) {
                  if (sameRepo) record = bound.record;
                  else adopted = { record: bound.record, from: r.record.repo };
                } else skip(`a run record bound to ${asciiLine(r.record.repo, 80)}#${asciiLine(r.record.pr, 20)}`, `: not this PR or repository${lookupFailed ? ' (its branch could not be read)' : ''}`);
              } else if (r.status === 'invalid' || r.status === 'unsupported') skip('a run record', `: unreadable (${r.status})`);
            }
            if (isState) {
              const decoded = decodeFromComment(c.body);
              if (isReadableState(decoded, number)) state = decoded;
              else if (decoded && Number.isInteger(decoded.pr) && decoded.pr !== number) skip(`a review state bound to PR ${decoded.pr}`, ': not this PR');
              else skip('a review state', ': unreadable');
            }
          }
          const movedFrom = record === null && adopted !== null ? adopted.from : null;
          const p = analysePr({ repo: slug, pr: number, state, record: record ?? adopted?.record ?? null });
          if (p === null) withoutState += 1;
          else {
            // The same pull request reached through two slugs (a renamed repository, the old name redirects) counts once: the listing's node id, or with --pr a lookup (only when several repositories are asked).
            const identity = nodeId ?? (repos.length > 1 ? livePull()?.node_id : undefined);
            const first = typeof identity === 'string' ? seen.get(identity) : undefined;
            if (first !== undefined) warnings.push(`${slug}#${number}: the same pull request as ${first}: counted once`);
            else {
              if (typeof identity === 'string') seen.set(identity, `${slug}#${number}`);
              analysed.push(p);
              // only for the record finally selected, and only when the PR counts
              if (movedFrom !== null) warnings.push(`${slug}#${number}: counted a run record bound to ${asciiLine(movedFrom, 80)} (the repo moved)`);
            }
          }
        } catch (err) {
          warnings.push(`${slug}#${number}: comments could not be read (${asciiLine(err?.message, 120)}): skipped`);
        }
      }
    }
    const result = { ok: true, since, repos, totals: aggregate(analysed), prs: analysed, withoutState, warnings };
    if (values.json) return { exitCode: EXIT.OK, output: result };
    (ctx.stdout ?? process.stdout).write(`${renderTable(result)}${warnings.length ? `\n\nWarnings:\n${warnings.map((w) => `- ${asciiLine(w, 300)}`).join('\n')}` : ''}\n`);
    return { exitCode: EXIT.OK, output: {}, silent: true };
  });
}

const SUBCOMMANDS = { rounds };

export const run = guarded(async (argv, ctx) => {
  const [sub, ...rest] = argv;
  if (!sub || !Object.hasOwn(SUBCOMMANDS, sub)) throw new UsageError(`usage: pipeline stats ${Object.keys(SUBCOMMANDS).join('|')} ...`);
  return SUBCOMMANDS[sub](rest, ctx);
});
