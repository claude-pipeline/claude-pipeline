// Why: the git policy (git-policy.mjs) is pure and asks its caller for three real-world answers: which branch HEAD is
// on, where a bare `git push` would go, and which labels an issue carries. The guard-git hook and `pipeline job start`
// must ask them the same way, or a command the hook denies could slip through the job runner (or the reverse), so the
// lookups live here once. Every lookup fails toward "unknown" (null / throw), which the policy turns into a denial.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { run, gh } from '../../lib/proc.mjs';
import { parseYaml } from '../../lib/yaml.mjs';
import { approvedPr } from './owner-go.mjs';

const LOOKUP_TIMEOUT_MS = 5000;
const PUSH_LOOKUP_TIMEOUT_MS = 3000;

// The timeout of one lookup process: its own, or what is left of the evaluation's wall cap when that is less (`leftMs`, from the policy; absent for a caller with no cap). Nothing left:
// the lookup does not start and throws, which every caller below turns into "unknown" (a denial), so a slow lookup can never carry a hook past its host timeout (which Claude Code allows).
const boundedTimeout = (own, leftMs) => {
  if (!leftMs) return own;
  const left = leftMs();
  if (!(left > 0)) throw new Error('no time is left to look this up');
  return Math.min(own, left);
};

export function realGitWiring() {
  // null (unknown) when HEAD is detached, the directory is not a repository, or git is unavailable
  const currentBranch = (dir, { gitDir, leftMs } = {}) => {
    const args = ['-C', dir, ...(gitDir ? ['--git-dir', gitDir] : []), 'symbolic-ref', '--short', '-q', 'HEAD'];
    const r = run('git', args, { timeoutMs: boundedTimeout(LOOKUP_TIMEOUT_MS, leftMs) });
    const branch = r.stdout.trim();
    return r.code === 0 && branch ? branch : null;
  };

  // Where git would send a bare `git push` (e.g. "origin/main"); null when it cannot say (no upstream, detached, error).
  // With `branch` it answers for that branch instead of HEAD (a branch the command line switches to first).
  const pushDestination = (dir, { gitDir, branch, leftMs } = {}) => {
    if (branch !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)) return null; // never feed odd text to rev-parse
    const rev = branch === undefined ? '@{push}' : `${branch}@{push}`;
    const args = ['-C', dir, ...(gitDir ? ['--git-dir', gitDir] : []), 'rev-parse', '--abbrev-ref', '--symbolic-full-name', rev];
    const r = run('git', args, { timeoutMs: boundedTimeout(PUSH_LOOKUP_TIMEOUT_MS, leftMs) });
    const dest = r.stdout.trim();
    return r.code === 0 && dest ? dest : null;
  };

  // throws when the lookup fails, so the policy denies instead of guessing
  const issueLabels = (n, repoArgs = [], cwd, { leftMs } = {}) => {
    const r = gh(['issue', 'view', String(n), ...repoArgs, '--json', 'labels', '-q', '.labels[].name'], { cwd, timeoutMs: boundedTimeout(LOOKUP_TIMEOUT_MS, leftMs) });
    if (r.timedOut) throw new Error(`gh issue view ${n} timed out`);
    if (r.code !== 0) throw new Error(`gh issue view ${n} failed (exit ${r.code})${r.stderr ? `: ${r.stderr.trim().slice(0, 200)}` : ''}`);
    return r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  };

  return { currentBranch, pushDestination, issueLabels };
}

// #58: what the git policy asks before a direct merge (`gh pr merge`, the repo's merge command, auto-merge through the API).
// The repo's owner_approval mode and merge commands come from .claude/pipeline.yml at the REPOSITORY ROOT (a copy in a subfolder
// is never read), in every version at hand: the working tree, HEAD and the remote's default branch. Any one of them saying chat
// makes it a chat repo, so a local edit or an uncommitted file cannot switch the check off (a rewritten local ref still can:
// the documented residual). A pipeline.yml that cannot be parsed throws: the policy then treats the repo as chat (fail closed).
// Whether the owner said "merge" comes from the owner-go records of THIS session, for the exact repository, PR and head (lib/owner-go.mjs).
// Phase 3b: the repository a bare gh command in a checkout acts on is read from its remotes (`git remote -v`, no network). gh may pick
// any of them (upstream, a `gh repo set-default`), so the answer is a repository only when every remote names the same one; none, or
// several, is unknown (the policy then refuses the merge and asks for -R owner/name).
// (the remote's refs FULLY QUALIFIED: git resolves an abbreviated `origin/main` through refs/tags and refs/heads before refs/remotes, so a local branch or tag of that name would
// otherwise stand in for the remote's copy and hide a chat config, #454)
const COMMITTED_REFS = ['HEAD', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main', 'refs/remotes/origin/master'];
const defaultGitShow = (root, ref, leftMs) => {
  // a missing remote-tracking ref must read as missing: `git show` would fall through to a branch or tag literally named `refs/remotes/origin/<b>` (#455)
  if (ref.startsWith('refs/') && run('git', ['-C', root, 'show-ref', '--verify', '--quiet', ref], { timeoutMs: boundedTimeout(LOOKUP_TIMEOUT_MS, leftMs) }).code !== 0) return null;
  const r = run('git', ['-C', root, 'show', `${ref}:.claude/pipeline.yml`], { timeoutMs: boundedTimeout(LOOKUP_TIMEOUT_MS, leftMs) });
  return r.code === 0 ? r.stdout : null;
};
const defaultRemotes = (dir, leftMs) => {
  const r = run('git', ['-C', dir, 'remote', '-v'], { timeoutMs: boundedTimeout(LOOKUP_TIMEOUT_MS, leftMs) });
  return r.code === 0 ? r.stdout : null;
};
// (Fable attacker pass) gh's own choice of repository among the remotes: `gh repo set-default` writes remote.<name>.gh-resolved, which
// is `base` or an owner/name gh then uses instead. '' when none is set (git config exits 1), null when it cannot be read.
export const defaultResolved = (dir, runFn = run, leftMs) => { // runFn: a test seam
  const r = runFn('git', ['-C', dir, 'config', '--get-regexp', '^remote\\..*\\.gh-resolved$'], { timeoutMs: boundedTimeout(LOOKUP_TIMEOUT_MS, leftMs) });
  // exit 1 is git's "nothing set"; a killed (signal) or cut-off (overBuffer) git also reports 1 but said nothing: unknown, not "no override"
  if (r.signal || r.timedOut || r.overBuffer) return null;
  return r.code === 0 ? r.stdout : r.code === 1 ? '' : null;
};
// owner/name from a github.com remote URL (git@github.com:owner/name.git, https://github.com/owner/name, ssh://git@github.com/owner/name.git),
// or null. (security review of 26cfb30: a remote on another host — GitHub Enterprise, a mirror, a local path — holds another repository
// with the same owner/name, and the owner's "merge" names one on github.com)
export function remoteSlug(url) {
  const s = String(url ?? '').trim();
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:@]+)(?::\d*)?\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(s)
    ?? /^(?:[^@/:]*@)?([^/:@]+):(?!\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(s);
  return m && m[1].toLowerCase() === 'github.com' ? `${m[2]}/${m[3]}` : null;
}
export function repoOfRemotes(text, resolved = '') {
  if (typeof text !== 'string' || typeof resolved !== 'string') return null;
  const urls = text.split(/\r?\n/).map((l) => l.trim().split(/\s+/)[1]).filter(Boolean);
  const slugs = urls.map(remoteSlug);
  if (slugs.length === 0 || slugs.includes(null)) return null;
  const keys = new Set(slugs.map((s) => s.toLowerCase()));
  if (keys.size !== 1) return null;
  // (a gh-resolved naming another owner/name: gh merges there, not in the remotes' repository)
  const chosen = resolved.split(/\r?\n/).map((l) => l.trim().split(/\s+/)[1]).filter(Boolean);
  return chosen.every((v) => v === 'base' || v.toLowerCase() === [...keys][0]) ? slugs[0] : null;
}
export function ownerGoWiring(session, { readText = (p) => readFileSync(p, 'utf8'), exists = existsSync, gitShow = defaultGitShow, remotes = defaultRemotes, resolved = defaultResolved } = {}) {
  const rootOf = (dir) => {
    let d = path.resolve(dir);
    for (;;) {
      if (exists(path.join(d, '.git'))) return d;
      const up = path.dirname(d);
      if (up === d) return null;
      d = up;
    }
  };
  // (one hook run judges before anything runs, so a repository's files cannot change mid-check: read them once per root, not once per
  // simple command, or a long script spends its deadline on git spawns. A read that throws is not remembered: the next question fails closed again)
  const configsByRoot = new Map();
  const configsOf = (dir, leftMs) => {
    const root = rootOf(dir);
    if (root === null) return [];
    if (!configsByRoot.has(root)) configsByRoot.set(root, readConfigs(root, leftMs));
    return configsByRoot.get(root);
  };
  const readConfigs = (root, leftMs) => {
    const texts = [];
    const yml = path.join(root, '.claude', 'pipeline.yml');
    if (exists(yml)) texts.push(readText(yml));
    for (const ref of COMMITTED_REFS) {
      const t = gitShow(root, ref, leftMs);
      if (typeof t === 'string') texts.push(t);
    }
    return texts.map((t) => parseYaml(t) ?? {});
  };
  return {
    mode: (dir, { leftMs } = {}) => {
      const all = configsOf(dir, leftMs);
      if (all.length === 0) return 'none';
      return all.some((c) => c.owner_approval === 'chat') ? 'chat' : 'label';
    },
    // each distinct merge command as { prefix: the literal words before {pr}, shaFlag: the word before {sha} (null when it pins no head) }
    mergeTemplates: (dir, { leftMs } = {}) => {
      const out = [];
      for (const cmd of new Set(configsOf(dir, leftMs).map((c) => c?.merge?.command).filter((c) => typeof c === 'string'))) {
        const words = cmd.trim().split(/\s+/);
        const at = words.indexOf('{pr}');
        const prefix = at > 0 ? words.slice(0, at) : [];
        if (!prefix.length || !prefix.every((w) => /^[A-Za-z0-9_@%+=:,./-]+$/.test(w))) continue;
        const sa = words.indexOf('{sha}');
        out.push({ prefix, shaFlag: sa > 0 && /^-{1,2}[A-Za-z][A-Za-z0-9-]*$/.test(words[sa - 1]) ? words[sa - 1] : null });
      }
      return out;
    },
    repoOf: (dir, { leftMs } = {}) => repoOfRemotes(remotes(dir, leftMs), resolved(dir, undefined, leftMs)),
    approvedHead: (pr, head, repo) => approvedPr({ repo, pr, head, session }),
  };
}
