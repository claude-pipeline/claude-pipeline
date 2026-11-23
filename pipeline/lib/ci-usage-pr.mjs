// The "pushed while ready" check of ONE PR, for `pipeline summary`: the same classifier `pipeline ci-usage` uses (lib/ci-usage.mjs#pushedWhileReady) over this PR's timeline,
// commits and pull_request runs. Only for a repository that iterates in draft (ci.draft_while_iterating: true), where a push to a ready PR means `pipeline redraft` was skipped
// (and the push starts the full CI suite). Only runs GitHub linked to this PR count; a head that also has an unlinked pull_request run is not judged (its first run may be the unlinked one). Report only: it never redrafts and never fails the caller; any read error becomes one warning. Bounded like `stats` (MAX_PAGES per list).
import { loadConfig } from './config.mjs';
import { MAX_PAGES, PAGE, pages } from './gh-pages.mjs';
import { pushedWhileReady } from './ci-usage.mjs';
import { asciiLine } from './triage.mjs';

// -> { warnings: [], field?: { count, heads: [sha12, ...] }, note?: string }. Nothing is read from GitHub unless the config says true.
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
    const cut = (what) => () => warnings.push(`pushed-while-ready check: the ${what} were cut after ${MAX_PAGES} pages (${MAX_PAGES * PAGE}): the count may be short`);
    const pull = gh.api('GET', `repos/${slug}/pulls/${pr}`);
    const timeline = pages(gh, `repos/${slug}/issues/${pr}/timeline`, undefined, cut('timeline events'));
    const commits = pages(gh, `repos/${slug}/pulls/${pr}/commits`, undefined, cut('commits'));
    // GitHub returns the OLDEST 250 commits, so the heads it left out are the newest; with no commit record the classifier would call an update-branch merge there a push, so such a head stays out of the count
    const capped = Number.isInteger(pull?.commits) && pull.commits > commits.length;
    if (capped) warnings.push(`pushed-while-ready check: GitHub lists ${pull.commits} commits for this PR but returned ${commits.length} (it caps the commits of a PR at 250): the heads of the commits it left out could not be checked`);
    const branch = pull?.head?.ref;
    if (typeof branch !== 'string' || branch === '' || typeof pull?.created_at !== 'string') throw new Error('the PR has no branch or creation time');
    const created = Date.parse(pull.created_at);
    const listing = pages(gh, `repos/${slug}/actions/runs?event=pull_request&branch=${encodeURIComponent(branch)}`, undefined, cut('workflow runs'), { key: 'workflow_runs' });
    // a branch name can have been used by an earlier PR, or by a PR from another fork: only the runs since this one was created count, and of those only the ones GitHub linked to this PR
    const sinceCreated = listing.filter((r) => Date.parse(r.created_at) >= created);
    const runs = sinceCreated.filter((r) => (r.pull_requests ?? []).some((p) => p?.number === pr));
    // an unlinked run on a head makes "the first run of that head came while the PR was ready" unprovable (that run may be the first): such heads are left out and counted
    const unlinkedHeads = new Set(listing.filter((r) => (r.pull_requests ?? []).length === 0 && r.head_sha).map((r) => r.head_sha));
    const found = pushedWhileReady({ pr: { createdAt: pull.created_at, draft: pull.draft === true, baseRef: pull.base?.ref, baseRepo: pull.base?.repo?.full_name }, timeline, commits, runs });
    const listed = new Set(commits.map((c) => c?.sha));
    const judgeable = found.heads.filter((h) => !unlinkedHeads.has(h.sha));
    if (judgeable.length < found.heads.length) warnings.push(`pushed-while-ready check: ${found.heads.length - judgeable.length} head(s) pushed while the PR was ready also have a pull_request run GitHub did not link to a PR, so they could not be checked and are left out`);
    const checked = capped ? judgeable.filter((h) => listed.has(h.sha)) : judgeable;
    if (checked.length === 0) return { warnings };
    const count = checked.length;
    const heads = checked.map((h) => h.sha.slice(0, 12));
    const times = count === 1 ? 'once' : `${count} times`;
    warnings.push(`pushed to the ready PR without \`P redraft\` first ${count} time(s): ${heads.join(', ')}; a push to a ready PR starts the full CI suite`);
    return { warnings, field: { count, heads }, note: `Pushed to the ready PR without \`pipeline redraft\` first ${times}: ${heads.join(', ')} (a push to a ready PR starts the full CI suite).` };
  } catch (err) {
    warnings.push(`pushed-while-ready check skipped: GitHub could not be read (${asciiLine(err?.message, 120)})`);
    return { warnings };
  }
}
