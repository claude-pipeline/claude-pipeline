// The "pushed while ready" check of ONE PR, for `pipeline summary`: the same classifier `pipeline ci-usage` uses (lib/ci-usage.mjs#pushedWhileReady) over this PR's timeline,
// commits and pull_request runs. Only for a repository that iterates in draft (ci.draft_while_iterating: true), where a push to a ready PR means `pipeline redraft` was skipped
// (and the push starts the full CI suite). Only runs GitHub linked to this PR count; a head that also has an unlinked pull_request run is not judged (its first run may be the unlinked one), nor a head the PR's commit list does not hold, and a PR that is no longer open or a list that was cut is not judged at all (a warning says so). Report only: it never redrafts and never fails the caller; any read error becomes one warning. Bounded like `stats` (MAX_PAGES per list).
import { loadConfig } from './config.mjs';
import { MAX_PAGES, PAGE, pages } from './gh-pages.mjs';
import { headProvable, pushedWhileReady } from './ci-usage.mjs';
import { asciiLine } from './triage.mjs';

// The start of the summary comment's line about pushes to a ready PR: the note is built with it and an earlier line is found by it, so the two cannot drift.
export const PUSHED_READY_NOTE = 'Pushed to the ready PR without `pipeline redraft` first';
// The warning when a PR is no longer open and no earlier summary comment holds the line to carry over.
export const CLOSED_PR_WARNING = 'pushed-while-ready check: the PR is no longer open (merged or closed), so GitHub no longer links its workflow runs to it: its pushes could not be checked';
// -> the line of an earlier summary comment's sections that this module wrote, or undefined (a PR that is no longer open cannot be judged again: the caller carries the line over).
export function earlierPushedNote(sections) {
  return String(sections ?? '').split('\n').find((l) => l.startsWith(PUSHED_READY_NOTE));
}

// -> { warnings: [], field?: { count, heads: [sha12, ...] }, note?: string, closed?: true }. Nothing is read from GitHub unless the config says true.
// `closed: true`: the PR is no longer open, so nothing can be judged (GitHub unlinks its runs): no warning here, the caller carries the earlier line over from the summary comment or warns when there is none.
export async function pushedWhileReadyOf({ root, gh, pr }) {
  const none = { warnings: [] };
  try {
    const loaded = await loadConfig(root);
    if (!loaded.ok || loaded.config.ci?.draft_while_iterating !== true) return none;
  } catch {
    return none;
  }
  const warnings = [];
  try {
    const slug = gh.repo().slug;
    // a list that was cut or capped is missing events, commits or runs (the newest or the oldest): no head is named from it, the check says it could not be made
    let incomplete = false;
    const cut = (what) => () => { incomplete = true; warnings.push(`pushed-while-ready check: the ${what} were cut after ${MAX_PAGES} pages (${MAX_PAGES * PAGE}): the PR could not be checked, so no head is named`); };
    const pull = gh.api('GET', `repos/${slug}/pulls/${pr}`);
    // GitHub fills a run's pull_requests only from the OPEN PRs when it is read: after a merge or a close every run of this PR is unlinked, so nothing can be judged again; the re-rendered comment would drop an earlier line, so the caller carries it over (`closed`)
    if (pull?.state === 'closed') return { warnings: [], closed: true };
    const branch = pull?.head?.ref;
    if (typeof branch !== 'string' || branch === '' || typeof pull?.created_at !== 'string') throw new Error('the PR has no branch or creation time');
    const created = Date.parse(pull.created_at);
    // the run list is read BEFORE the timeline and the commits: every run in it is then older than the phases read after it (a redraft and a push in between are not judged against the earlier phase)
    let totalRuns = null;
    const listing = pages(gh, `repos/${slug}/actions/runs?event=pull_request&branch=${encodeURIComponent(branch)}`, undefined, cut('workflow runs'), { key: 'workflow_runs', onPage: (r) => { totalRuns ??= Number.isFinite(r?.total_count) ? r.total_count : null; } });
    if (totalRuns !== null && totalRuns > listing.length && listing.length < MAX_PAGES * PAGE) { incomplete = true; warnings.push(`pushed-while-ready check: GitHub lists ${totalRuns} workflow runs for this branch but returned ${listing.length} (it caps a search at 1000 results): the PR could not be checked, so no head is named`); }
    const timeline = pages(gh, `repos/${slug}/issues/${pr}/timeline`, undefined, cut('timeline events'));
    const commits = pages(gh, `repos/${slug}/pulls/${pr}/commits`, undefined, cut('commits'));
    if (incomplete) return { warnings };
    // GitHub returns the OLDEST 250 commits, so the heads it left out are the newest; with no commit record the classifier would call an update-branch merge there a push
    const capped = Number.isInteger(pull?.commits) && pull.commits > commits.length;
    if (capped) warnings.push(`pushed-while-ready check: GitHub lists ${pull.commits} commits for this PR but returned ${commits.length} (it caps the commits of a PR at 250): the heads of the commits it left out could not be checked`);
    // a branch name can have been used by an earlier PR, or by a PR from another fork: only the runs since this one was created count, and of those only the ones GitHub linked to this PR
    const sinceCreated = listing.filter((r) => Date.parse(r.created_at) >= created);
    const runs = sinceCreated.filter((r) => (r.pull_requests ?? []).some((p) => p?.number === pr));
    // an unlinked run on a head makes "the first run of that head came while the PR was ready" unprovable (that run may be the first): such heads are left out and counted
    const unlinkedHeads = new Set(sinceCreated.filter((r) => (r.pull_requests ?? []).length === 0 && r.head_sha).map((r) => r.head_sha));
    const found = pushedWhileReady({ pr: { createdAt: pull.created_at, draft: pull.draft === true, baseRef: pull.base?.ref, baseRepo: pull.base?.repo?.full_name }, timeline, commits, runs });
    const judgeable = found.heads.filter((h) => !unlinkedHeads.has(h.sha));
    if (judgeable.length < found.heads.length) warnings.push(`pushed-while-ready check: ${found.heads.length - judgeable.length} head(s) pushed while the PR was ready also have a pull_request run GitHub did not link to a PR, so they could not be checked and are left out`);
    // a head with no commit record (past the cap, or dropped by a force push: an update-branch merge there would look like a push) is not named
    const checked = judgeable.filter((h) => headProvable(h.sha, commits));
    if (checked.length < judgeable.length && !capped) warnings.push(`pushed-while-ready check: ${judgeable.length - checked.length} head(s) pushed while the PR was ready are not in its commit list (a force push dropped them), so they could not be checked and are left out`);
    if (checked.length === 0) return { warnings };
    const count = checked.length;
    const heads = checked.map((h) => h.sha.slice(0, 12));
    const times = count === 1 ? 'once' : `${count} times`;
    warnings.push(`pushed to the ready PR without \`P redraft\` first ${count} time(s): ${heads.join(', ')}; a push to a ready PR starts the full CI suite`);
    return { warnings, field: { count, heads }, note: `${PUSHED_READY_NOTE} ${times}: ${heads.join(', ')} (a push to a ready PR starts the full CI suite).` };
  } catch (err) {
    warnings.push(`pushed-while-ready check skipped: GitHub could not be read (${asciiLine(err?.message, 120)})`);
    return { warnings };
  }
}
