// The "pushed while ready" check of ONE PR, for `pipeline summary`: the same classifier `pipeline ci-usage` uses (lib/ci-usage.mjs#pushedWhileReady) over this PR's timeline,
// commits and pull_request runs. Only for a repository that iterates in draft (ci.draft_while_iterating: true), where a push to a ready PR means `pipeline redraft` was skipped
// (and the push starts the full CI suite). Report only: it never redrafts and never fails the caller; any read error becomes one warning. Bounded like `stats` (MAX_PAGES per list).
import { loadConfig } from './config.mjs';
import { MAX_PAGES, PAGE, pages } from './gh-pages.mjs';
import { pushedWhileReady } from './ci-usage.mjs';
import { asciiLine } from './triage.mjs';

const sameRepo = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

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
    if (Number.isInteger(pull?.commits) && pull.commits > commits.length) warnings.push(`pushed-while-ready check: GitHub lists ${pull.commits} commits for this PR but returned ${commits.length} (it caps the commits of a PR at 250): the count may be short`);
    const branch = pull?.head?.ref;
    if (typeof branch !== 'string' || branch === '' || typeof pull?.created_at !== 'string') throw new Error('the PR has no branch or creation time');
    const created = Date.parse(pull.created_at);
    const runs = pages(gh, `repos/${slug}/actions/runs?event=pull_request&branch=${encodeURIComponent(branch)}`, undefined, cut('workflow runs'), { key: 'workflow_runs' })
      // a branch name can have been used by an earlier PR, or by a PR from another fork: only the runs since this one was created, those linked to this PR, and the unlinked ones
      // whose head repository is this PR's (an unlinked run of an unknown or other repository stays unattributed)
      .filter((r) => Date.parse(r.created_at) >= created && ((r.pull_requests ?? []).length === 0 ? sameRepo(r.head_repository?.full_name, pull.head?.repo?.full_name) : r.pull_requests.some((p) => p?.number === pr)));
    const found = pushedWhileReady({ pr: { createdAt: pull.created_at, draft: pull.draft === true, baseRef: pull.base?.ref, baseRepo: pull.base?.repo?.full_name }, timeline, commits, runs });
    if (found.count === 0) return { warnings };
    const heads = found.heads.map((h) => h.sha.slice(0, 12));
    const times = found.count === 1 ? 'once' : `${found.count} times`;
    warnings.push(`pushed to the ready PR without \`P redraft\` first ${found.count} time(s): ${heads.join(', ')}; a push to a ready PR starts the full CI suite`);
    return { warnings, field: { count: found.count, heads }, note: `Pushed to the ready PR without \`pipeline redraft\` first ${times}: ${heads.join(', ')} (a push to a ready PR starts the full CI suite).` };
  } catch (err) {
    warnings.push(`pushed-while-ready check skipped: GitHub could not be read (${asciiLine(err?.message, 120)})`);
    return { warnings };
  }
}
