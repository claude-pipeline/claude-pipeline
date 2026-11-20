// Where am I? One place that answers "which repo, which root, which GitHub slug" so every
// command resolves them the same way (worktrees included) and tests can inject answers.
import { join, resolve } from 'node:path';
import { git, GitError } from './git.mjs';
import { ghJson } from './proc.mjs';

// resolve(): git prints C:/forward/slashes on Windows; callers join() and compare native paths.
export function repoRoot(cwd = process.cwd()) {
  return resolve(git(['rev-parse', '--show-toplevel'], { cwd }).trim());
}

// Upper bound for the one git call every per-repo state path starts from: a hung git (a stalled mount) must not block a synchronous scan for ever.
// Same bound as the live-work scan's own git call (live-work-scan.mjs GIT_TIMEOUT_MS).
const GIT_TIMEOUT_MS = 20_000;

// The common git dir is shared by all worktrees of a repo: right place for per-repo,
// cross-worktree state such as the agent-log queue.
export function gitCommonDir(cwd = process.cwd()) {
  const out = git(['rev-parse', '--git-common-dir'], { cwd, timeoutMs: GIT_TIMEOUT_MS }).trim();
  return resolve(cwd, out);
}

export function pipelineStateDir(cwd = process.cwd()) {
  return join(gitCommonDir(cwd), 'claude-pipeline');
}

// owner/name from GitHub (gh resolves the right remote, including forks and SSH remotes).
// host (Phase 3b): the server gh resolved it on, from the repo's url (lower-case; null when gh gives none): GH_HOST, an ssh host
// alias or a sole logged-in enterprise host can point gh at a server other than github.com, where owner/name is another repository.
export function repoSlug(cwd = process.cwd(), { ghJsonFn = ghJson } = {}) {
  const r = ghJsonFn(['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef,url'], { cwd });
  const [owner, name] = String(r.nameWithOwner || '').split('/');
  if (!owner || !name) throw new Error(`could not resolve GitHub repo for ${cwd}`);
  const host = /^https?:\/\/([^/]+)\//i.exec(String(r.url ?? ''))?.[1]?.toLowerCase() ?? null;
  return { owner, name, slug: `${owner}/${name}`, host, defaultBranch: r.defaultBranchRef?.name || 'main' };
}

// owner/name of every place `git push origin` really goes (each push URL, with url.<base>.pushInsteadOf rewrites applied: git pushes to all of
// them), which gh need not agree with (GH_REPO, `gh repo set-default`, another remote). The last two path segments, so an ssh host alias still
// yields a name. [] only when git cleanly says there is no such remote (exit 2: the push would fail too); a git that was killed, timed out or did
// not run throws, so the destination check never fails open.
export function pushRemoteSlugs(cwd = process.cwd(), remote = 'origin') {
  let out;
  try {
    out = git(['remote', 'get-url', '--push', '--all', remote], { cwd, timeoutMs: GIT_TIMEOUT_MS });
  } catch (err) {
    if (err instanceof GitError && !err.abnormal && err.code === 2) return [];
    throw err;
  }
  const slugs = [];
  for (const url of out.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const parts = url.replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:]/).filter(Boolean);
    if (parts.length >= 2) slugs.push(`${parts.at(-2)}/${parts.at(-1)}`);
  }
  return slugs;
}
