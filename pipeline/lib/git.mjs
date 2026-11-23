// The only way the pipeline reads git. Three jobs: PR diffs for hard-stop/integrity checks, a content hash that proves
// the code that was reviewed is the code being merged, and a working-tree fingerprint that binds a verify report to
// one exact tree. Because those outputs feed trust decisions, git() pins everything that could change them: the config
// that shapes diff output (a user's diff.noprefix or core.quotePath must not change what the parser sees), LC_ALL=C
// (stderr is matched by text), and the GIT_* variables that would silently point git at a different repository.
// Fail closed: a git that did not run, was killed or timed out is an error, never an answer ("no match", "no such
// file", "detached"). Only git's own documented answers (see gitOrNull, showFile) are mapped to false/null/'HEAD'.
// Reads go through proc.run, so output is decoded as UTF-8: invalid UTF-8 inside a diffed text-looking file is not
// byte-exact (binary files are: --binary emits ASCII).
import { createHash } from 'node:crypto';
import { openSync, readSync, closeSync, lstatSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { planSpawn, run } from './proc.mjs';
import { parseUnifiedDiff } from './diff.mjs';
import { MAX_BLOCKS, SearchCap, checkSelection, committedBlock, isMarkerLine, makeBudget, parseConflictBlocks, splitLines } from './resolution.mjs';

// Upper bound for a git call that talks to a remote (fetch, push, ls-remote): a hung one inside a lock cannot be reclaimed.
export const NETWORK_TIMEOUT_MS = 120_000;

// `abnormal: true` = the child did not finish on its own (timed out, killed by a signal, or its output went past the buffer limit): its
// `code` is not git's answer (a SIGKILLed git reports 1, git's own "no match"), so a catch that maps a code to an answer must test it.
export class GitError extends Error {
  constructor({ args, code, stderr, abnormal = false }) {
    super(`git ${args.join(' ')} failed (exit ${code})${stderr && stderr.trim() ? `: ${stderr.trim()}` : ''}`);
    this.name = 'GitError';
    this.args = args;
    this.code = code;
    this.stderr = stderr;
    this.abnormal = abnormal === true;
  }
}

// interHunkContext/algorithm/indentHeuristic decide where git cuts hunks and which of several equal diffs it prints, so
// leaving them to user config would let the same change hash differently on two machines. log.showSignature=false keeps
// a signature verdict out of `git log` / `git show` output we parse.
const FORCED_CONFIG = [
  '-c', 'core.quotePath=true', '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false',
  '-c', 'diff.renames=true', '-c', 'color.ui=false',
  '-c', 'diff.interHunkContext=0', '-c', 'diff.algorithm=myers', '-c', 'diff.indentHeuristic=true',
  '-c', 'log.showSignature=false',
];
// core.autocrlf is deliberately NOT forced for status / working-tree reads / `diff HEAD`: with Git for Windows' default
// (autocrlf=true) a CRLF working file is the same content as its LF blob, and forcing false would make isClean() false
// and move treeFingerprint after merely touching such a file. Commit-to-commit diffs read blobs only, but pin it there
// anyway so their bytes cannot depend on a user's setting.
const STABLE_CONFIG = ['-c', 'core.autocrlf=false'];
// GIT_OPTIONAL_LOCKS=0: these are reads; they must never fight a concurrent git for the index lock.
// GIT_NO_REPLACE_OBJECTS=1: a refs/replace/* ref swaps one object for another everywhere git reads it, so a diff, a hash or a hard-stop
// scan would judge the replacement instead of the commit GitHub has; every read here sees the real objects.
const GIT_ENV = { LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' };
// Variables that make git operate on some other repository than `cwd` (a hook or wrapper leaves them behind).
// An undefined value removes the variable from the child's environment (proc.run merges over process.env).
// GIT_GRAFT_FILE / GIT_SHALLOW_FILE point git at some other grafts / shallow list than the repository's own: an inherited one would show a
// history other than GitHub's (the --owner-go scan-range check only looks at the repository's info/grafts and shallow file).
const SCRUBBED_ENV = Object.fromEntries([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES', 'GIT_GRAFT_FILE', 'GIT_SHALLOW_FILE',
].map((k) => [k, undefined]));

// Runs git with forced config; returns the raw result unless the process did not finish on its own. `env` is the
// one way to point git elsewhere on purpose (e.g. GIT_CEILING_DIRECTORIES in a test).
// `timeoutMs` bounds a call that can hang on the network (fetch, push); a timeout is a GitError like any other.
function exec(args, { cwd, run: runFn = run, input, env, timeoutMs, maxBuffer } = {}) {
  const r = runFn('git', [...FORCED_CONFIG, ...args], { cwd, env: { ...SCRUBBED_ENV, ...GIT_ENV, ...env }, input, ...(timeoutMs ? { timeoutMs } : {}), ...(maxBuffer ? { maxBuffer } : {}) });
  // overBuffer (ENOBUFS): stdout was cut, so exit 0 / 1 and an empty stderr no longer mean what git meant by them.
  const abnormal = r.timedOut ? 'timed out' : r.signal ? `terminated by signal ${r.signal}` : r.overBuffer ? 'output over the buffer limit' : null;
  if (abnormal) {
    throw new GitError({ args, code: r.code, stderr: [abnormal, (r.stderr ?? '').trim()].filter(Boolean).join(': '), abnormal: true });
  }
  return r;
}

// Returns stdout untouched (callers trim what they need to); throws GitError on any non-zero exit.
// `o.maxBuffer` raises the 64 MiB cap on what one call may print (see contentHash).
export function git(args, o) {
  const r = exec(args, o);
  if (r.code !== 0) throw new GitError({ args, code: r.code, stderr: r.stderr });
  return r.stdout;
}

// A ref that starts with `-` would be read by git as an option (`--output=<file>` writes files), and an empty ref
// turns `<ref>:<path>` into "the index". Refuse both before git sees them. 129 is git's own usage-error code.
function assertRef(ref, args) {
  if (typeof ref !== 'string' || ref === '' || ref.startsWith('-')) {
    throw new GitError({ args, code: 129, stderr: `refusing unsafe ref ${JSON.stringify(ref)}` });
  }
  return ref;
}

// Runs git and maps git's own "no" to `null` (grep found nothing, HEAD is not a symbolic ref, no merge base). That
// answer is exactly `expectedCode` with NOTHING on stderr. proc.run reports a spawn failure (missing git, missing cwd)
// as code 1 with the error text on stderr, and a killed child as code 1 and an empty stderr plus `signal`; both are
// told apart here, so only a real answer from a git that ran is ever swallowed. Everything else throws.
function gitOrNull(args, expectedCode, o) {
  const r = exec(args, o); // throws for signals and timeouts
  if (r.code === 0) return r.stdout;
  if (r.code === expectedCode && (r.stderr ?? '').trim() === '') return null;
  throw new GitError({ args, code: r.code, stderr: r.stderr });
}

export function mergeBase(a, b, o) {
  const args = ['merge-base', assertRef(a, ['merge-base', a, b]), assertRef(b, ['merge-base', a, b])];
  const out = gitOrNull(args, 1, o); // exit 1 and no stderr: the two histories share no commit
  if (out === null) throw new GitError({ args, code: 1, stderr: `no common ancestor between ${a} and ${b}` });
  return out.trim();
}

// Is `a` an ancestor of (or equal to) `b`? git's exit 1 (with nothing on stderr) is the answer "no"; a commit git does
// not know (exit 128) still throws, so a missing object can never read as "no".
export const isAncestor = (a, b, o) => gitOrNull(['merge-base', '--is-ancestor', assertRef(a, ['merge-base', a, b]), assertRef(b, ['merge-base', a, b])], 1, o) !== null;

// The installed git as [major, minor], or null when it prints something else. `merge-tree --write-tree` needs 2.38.
export function gitVersion(o) {
  const m = /^git version (\d+)\.(\d+)/.exec(git(['--version'], o).trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}
export const supportsMergeTreeWrite = (o) => {
  const v = gitVersion(o);
  return v !== null && (v[0] > 2 || (v[0] === 2 && v[1] >= 38));
};

// A trial merge must give the SAME tree id on every machine: a user's merge.conflictStyle (zdiff3 / diff3 write other marker
// text) or merge.renormalize would change the tree, and the tree id is what a review round records as its base. So would the
// settings merge-ort reads for rename detection (merge.renames, merge.directoryRenames, merge.renameLimit / diff.renameLimit):
// they are pinned to git's own documented defaults, so a default-config machine gets the same tree id as before.
// core.autocrlf=false and merge.default=text are reproducibility pins of the same kind (git's defaults, so default-config
// tree ids are unchanged): with merge.renormalize off the in-core merge never calls the conversion code that reads
// core.autocrlf (nor the text / eol attributes), so no test can show that pin biting; merge.default names the driver git
// uses for a path whose `merge` attribute is unspecified, the only case attributeProblem lets through, and a user's
// merge.default=union would otherwise change the tree.
const MERGE_CONFIG = [
  '-c', 'merge.conflictStyle=merge', '-c', 'merge.renormalize=false',
  '-c', 'merge.renames=true', '-c', 'merge.directoryRenames=conflict', '-c', 'merge.renameLimit=7000',
  '-c', 'core.autocrlf=false', '-c', 'merge.default=text',
];

// A trial merge of `head` into `base` that touches no ref, index or working tree (it only writes tree objects).
// -> { clean: true, tree } | { clean: false, tree } (exit 1: conflicts). Any other exit (a missing object, an old git) throws.
// Always run with MERGE_CONFIG, so the 'synthetic' base of effectiveReviewBase is reproducible too.
export function mergeTree(base, head, o) {
  const args = [...MERGE_CONFIG, 'merge-tree', '--write-tree', assertRef(base, ['merge-tree', base, head]), assertRef(head, ['merge-tree', base, head])];
  const r = exec(args, o);
  if (r.code !== 0 && r.code !== 1) throw new GitError({ args, code: r.code, stderr: r.stderr });
  const tree = String(r.stdout).split('\n')[0].trim();
  if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new GitError({ args, code: r.code, stderr: `merge-tree printed no tree id: ${String(r.stdout).slice(0, 200)}` });
  return { clean: r.code === 0, tree };
}

// mergeTree with the conflict detail, from `merge-tree --write-tree -z` (NUL-delimited, so a path may hold any character):
//   <tree>\0 { <mode> <oid> <stage>\t<path>\0 }* \0 { <n>\0 <path>\0 x n  <type>\0 <message>\0 }*
// Pass FULL commit ids when the marker text matters: the labels git writes into the files are the arguments as given.
// -> { clean, tree, conflicts: [{ path, stages: { 1?, 2?, 3?: { mode, oid } }, types: [...], messages: [...] }],
//      messages: [{ paths, type, text }] } (conflicts sorted as git lists them; types / messages are those naming the path).
// A git too old, a missing object or output that does not parse throws GitError.
export function mergeTreeDetailed(base, head, o) {
  const args = [...MERGE_CONFIG, 'merge-tree', '--write-tree', '-z', assertRef(base, ['merge-tree', base, head]), assertRef(head, ['merge-tree', base, head])];
  const r = exec(args, o);
  if (r.code !== 0 && r.code !== 1) throw new GitError({ args, code: r.code, stderr: r.stderr });
  const bad = (why) => new GitError({ args, code: r.code, stderr: `unparseable merge-tree -z output: ${why}` });
  const parts = String(r.stdout).split('\0');
  const tree = parts[0];
  if (!/^[0-9a-f]{40,64}$/.test(tree)) throw bad(`no tree id in ${String(r.stdout).slice(0, 80)}`);
  let i = 1;
  const byPath = new Map();
  for (; i < parts.length && parts[i] !== ''; i++) {
    const m = /^(\d{6}) ([0-9a-f]{40,64}) ([123])\t([^]+)$/.exec(parts[i]);
    if (!m) throw bad(`conflicted-file entry ${JSON.stringify(parts[i].slice(0, 80))}`);
    if (!byPath.has(m[4])) byPath.set(m[4], { path: m[4], stages: {}, types: [], messages: [] });
    byPath.get(m[4]).stages[m[3]] = { mode: m[1], oid: m[2] };
  }
  const messages = [];
  if (i < parts.length) i++; // the empty entry that ends the file list
  while (i < parts.length && !(i === parts.length - 1 && parts[i] === '')) {
    const n = parts[i];
    if (!/^\d+$/.test(n)) throw bad(`message path count ${JSON.stringify(n.slice(0, 40))}`);
    const paths = parts.slice(i + 1, i + 1 + Number(n));
    const type = parts[i + 1 + Number(n)];
    const text = parts[i + 2 + Number(n)];
    if (paths.length !== Number(n) || type === undefined || text === undefined) throw bad('truncated message');
    messages.push({ paths, type, text });
    i += 3 + Number(n);
  }
  for (const msg of messages) {
    for (const p of msg.paths) {
      const c = byPath.get(p);
      if (c) { c.types.push(msg.type); c.messages.push(msg.text); }
    }
  }
  return { clean: r.code === 0, tree, conflicts: [...byPath.values()], messages };
}

// What a later review round (or a "did a non-test file change since round N" check) should diff the branch head against.
// `from` is where the previous round ended, `forkPoint` the PR's CURRENT merge base with the branch it targets. When the
// base branch was merged into the PR since `from`, from..head would contain the base branch's own commits (other PRs'
// work). So:
//   - `from` already contains `forkPoint`: nothing was merged in, `from` it is (kind 'previous');
//   - otherwise a trial merge of forkPoint into `from` ("what was reviewed, plus the new base") is the base; the head differs
//     from it only by the PR's own later changes (kind 'synthetic', a tree id; `git diff <tree>..<commit>` accepts one);
//   - a conflicting merge, or a git without merge-tree --write-tree, falls back to `forkPoint`: the whole PR against the new
//     base, which still never shows the base branch's code (kind 'whole-pr'). (Review rounds try resolutionReviewBase and
//     conflictReviewBase before accepting this fallback; the callers that only measure keep it.)
// -> { base, kind }
export function effectiveReviewBase({ from, forkPoint }, o) {
  if (isAncestor(forkPoint, from, o)) return { base: from, kind: 'previous' };
  try {
    if (supportsMergeTreeWrite(o)) {
      const merged = mergeTree(from, forkPoint, o);
      if (merged.clean) return { base: merged.tree, kind: 'synthetic' };
    }
  } catch (err) {
    if (!(err instanceof GitError)) throw err; // a merge-tree that cannot run is the same answer as a conflict
  }
  return { base: forkPoint, kind: 'whole-pr' };
}

// ---------- review round that is only a conflict resolution ----------

class Ineligible extends Error {}
const fail = (code, detail) => new Ineligible(detail ? `${code}: ${detail}` : code);
const shortList = (xs) => (xs.length > 5 ? `${xs.slice(0, 5).join(', ')} (+${xs.length - 5} more)` : xs.join(', '));

const MAX_RESOLUTION_HISTORY = 100;
const TEXT_MODES = new Set(['100644', '100755']);
// Attributes that change what a trial merge writes: the merge driver and marker size (the only two the in-core merge's
// ll_merge reads) and `diff` (rename detection reads it). Any value other than unspecified makes the round ineligible.
// `binary` is the macro -diff -merge -text, so a binary-marked path is refused through merge / diff.
// `text` and `eol` are deliberately NOT here: they act only through renormalization (forced off) and through check-in /
// checkout conversion, which merge-tree never does. Every blob compared afterwards is read raw with cat-file, so a conversion
// in the user's real merge commit (CRLF where the trial merge has LF) shows up as a line nobody selected and fails closed.
const STRICT_MERGE_ATTRS = ['merge', 'conflict-marker-size', 'diff'];

// merge-tree reads attributes from the checkout (and the user's global ones), so a trial merge is only reproducible while
// none of STRICT_MERGE_ATTRS is set on the conflicted paths. -> null, or a sentence naming the first attribute that is set.
function attributeProblem(paths, o) {
  if (paths.length === 0) return null;
  const top = git(['rev-parse', '--show-toplevel'], o).trim();
  const out = git(['check-attr', '-z', '--stdin', ...STRICT_MERGE_ATTRS], { ...o, cwd: top, input: paths.map((p) => `${p}\0`).join('') });
  const parts = out.split('\0');
  if (parts.at(-1) === '') parts.pop();
  if (parts.length !== paths.length * STRICT_MERGE_ATTRS.length * 3) return 'git check-attr output did not parse';
  for (let i = 0; i < parts.length; i += 3) {
    if (parts[i + 2] !== 'unspecified') return `${parts[i]} has attribute ${parts[i + 1]}=${parts[i + 2]}`;
  }
  return null;
}

// `git diff --raw -z --no-renames` between a tree and a commit. -> Map path -> { oldMode, newMode, status }
function rawDiffNoRenames(tree, commit, o) {
  const parts = git([
    ...STABLE_CONFIG, 'diff', '--raw', '-z', '--no-renames', '--no-abbrev', '--no-color', '--no-ext-diff', '--no-textconv', '--no-relative',
    '--ignore-submodules=none', assertRef(tree, ['diff', tree]), assertRef(commit, ['diff', commit]),
  ], o).split('\0');
  const out = new Map();
  for (let i = 0; i < parts.length; i += 2) {
    if (parts[i] === '') continue;
    const m = /^:(\d+) (\d+) [0-9a-f]+ [0-9a-f]+ ([A-Z])$/.exec(parts[i]);
    if (!m || parts[i + 1] === undefined) throw new GitError({ args: ['diff', '--raw', '-z'], code: 0, stderr: `unexpected raw diff entry: ${parts[i]}` });
    out.set(parts[i + 1], { oldMode: m[1], newMode: m[2], status: m[3] });
  }
  return out;
}

// 2a: head's first-parent history back to `from` is nothing but merges of the protected branch. All shas are full.
function historyProblem({ from, head, baseRef }, o) {
  const entries = new Map();
  for (const line of git(['rev-list', '--first-parent', '--parents', head, `^${from}`], o).split('\n')) {
    if (line === '') continue;
    const [sha, ...parents] = line.split(' ');
    entries.set(sha, parents);
  }
  if (entries.size === 0) return fail('history-empty', 'no commits since the last reviewed head');
  if (entries.size > MAX_RESOLUTION_HISTORY) return fail('history-too-long', `${entries.size} commits since the last reviewed head`);
  for (let cur = head; cur !== from; ) {
    const parents = entries.get(cur);
    if (!parents) return fail('history-not-first-parent', 'the last reviewed head is not on the first-parent chain of HEAD');
    if (parents.length === 1) return fail('history-nonmerge', `${cur} is not a merge commit`);
    if (parents.length > 2) return fail('history-octopus', `${cur} merges ${parents.length} parents`);
    if (parents.length === 0) return fail('history-not-first-parent', `${cur} is a root commit`);
    if (!isAncestor(parents[1], baseRef, o)) return fail('history-foreign-merge', `${cur} merges ${parents[1]}, which is not on ${displayRef(baseRef)}`);
    cur = parents[0];
  }
  return null;
}

// A blob's bytes exactly (git() decodes UTF-8, which would turn a binary blob's bytes into U+FFFD), run the way git() runs git: the trusted executable lookup
// of proc.planSpawn (a git.exe in the checkout never wins on Windows), the same forced config and scrubbed environment, and an over-buffer read is an error.
export function catBlobBytes(oid, o) {
  const args = [...FORCED_CONFIG, 'cat-file', 'blob', assertRef(oid, ['cat-file', 'blob', oid])];
  const plan = planSpawn('git', args);
  const r = spawnSync(plan.file, plan.args, {
    cwd: o?.cwd, env: { ...process.env, ...SCRUBBED_ENV, ...GIT_ENV, ...o?.env }, maxBuffer: 256 * 1024 * 1024, killSignal: 'SIGKILL', windowsHide: true, windowsVerbatimArguments: plan.windowsVerbatimArguments,
  });
  if (r.error || r.status !== 0) {
    throw new GitError({ args: ['cat-file', 'blob', oid], code: r.status ?? 1, stderr: r.error ? r.error.message : String(r.stderr ?? ''), abnormal: r.error !== undefined });
  }
  return r.stdout;
}

const catBlob = (ref, o) => git(['cat-file', 'blob', assertRef(ref, ['cat-file', 'blob', ref])], o);

function resolutionChecks({ from, forkPoint, head, baseRef }, o) {
  if (!supportsMergeTreeWrite(o)) throw fail('unsupported-git', 'merge-tree --write-tree needs git 2.38');
  assertRef(baseRef, ['rev-list', baseRef]);
  const [fromSha, forkSha, headFull] = [from, forkPoint, head].map((x) => revParse(`${assertRef(x, ['rev-parse', x])}^{commit}`, o));

  const history = historyProblem({ from: fromSha, head: headFull, baseRef }, o);
  if (history) throw history;

  // 2b2: full shas (they become the marker labels), forced merge config (inside mergeTreeDetailed).
  const merged = mergeTreeDetailed(fromSha, forkSha, o);
  if (merged.clean) throw fail('not-conflicted', 'the trial merge is clean');
  if (merged.conflicts.length === 0) throw fail('not-conflicted', 'merge-tree reported a conflict but listed no conflicted file');

  // 2b: text content conflicts only.
  const known = new Set(merged.conflicts.map((c) => c.path));
  for (const m of merged.messages) {
    if (/Cannot merge binary files/.test(m.text) || m.type === 'CONFLICT (binary)') throw fail('conflict-binary', shortList(m.paths));
    if (m.type !== 'Auto-merging' && m.type !== 'CONFLICT (contents)') throw fail('conflict-type', `${m.type} ${shortList(m.paths)}`);
    if (m.type === 'CONFLICT (contents)' && m.paths.some((p) => !known.has(p))) throw fail('conflict-mismatch', shortList(m.paths));
  }
  for (const c of merged.conflicts) {
    if (!c.stages[1] || !c.stages[2] || !c.stages[3]) throw fail('conflict-stages', `${c.path} is missing a merge stage (add/add or delete)`);
    if (!c.types.includes('CONFLICT (contents)')) throw fail('conflict-type', `${c.path} is not reported as a content conflict`);
    const mode = c.stages[2].mode;
    if (c.stages[1].mode !== mode || c.stages[3].mode !== mode || !TEXT_MODES.has(mode)) throw fail('conflict-mode', `${c.path}: ${c.stages[1].mode}/${mode}/${c.stages[3].mode}`);
  }
  const conflicted = merged.conflicts.map((c) => c.path);

  const attr = attributeProblem(conflicted, o);
  if (attr) throw fail('attributes', attr);

  // 2c: head differs from the marker tree in conflicted files only.
  const changes = rawDiffNoRenames(merged.tree, headFull, o);
  if (changes.size === 0) throw fail('no-changes', 'head equals the marker tree');
  const extra = [...changes.keys()].filter((p) => !known.has(p));
  if (extra.length > 0) throw fail('extra-files', shortList(extra));
  for (const c of merged.conflicts) {
    const ch = changes.get(c.path);
    if (!ch) throw fail('unresolved', `${c.path} still has its conflict markers`);
    if (ch.status !== 'M') throw fail('not-modified', `${c.path} changed as ${ch.status}`);
    if (ch.newMode !== c.stages[2].mode || ch.oldMode !== c.stages[2].mode) throw fail('conflict-mode', `${c.path} is ${ch.newMode} in head`);
  }

  // 2d: per file, every block resolved by selecting lines of its two sides. The marker blob may hold clean hunks git auto-merged
  // from one side next to its conflict blocks; parseConflictBlocks (resolution.mjs) proves each block's sides are runs of the
  // stage blobs and checkSelection holds the resolution to the marker blob's own lines outside the blocks.
  const tick = makeBudget(o?.resolutionSearchBudget);
  const blocks = [];
  for (const c of merged.conflicts) {
    const [s1, s2, s3] = [1, 2, 3].map((n) => catBlob(c.stages[n].oid, o));
    const marker = catBlob(`${merged.tree}:${c.path}`, o);
    const resolved = catBlob(`${headFull}:${c.path}`, o);
    for (const [name, text] of [['base', s1], ['ours', s2], ['theirs', s3], ['marker', marker], ['head', resolved]]) {
      if (text.includes('\0')) throw fail('conflict-nul', `${c.path} (${name}) contains a NUL byte`);
      // proc.run decodes UTF-8: invalid bytes would compare equal after the decode, so they are not byte-exact.
      if (text.includes('\uFFFD')) throw fail('non-utf8', `${c.path} (${name}) is not valid UTF-8`);
    }
    // The labels are what makes the parser's fast path legal; without them it falls back to the exact parser (#1598).
    const parsed = parseConflictBlocks(splitLines(marker), splitLines(s2), splitLines(s3), tick, { ours: fromSha, theirs: forkSha });
    if (parsed.reason === 'too-many-blocks') throw fail('too-many-blocks', `${c.path} has more than ${MAX_BLOCKS} conflict blocks`);
    if (parsed.reason) throw fail(parsed.reason === 'ambiguous' ? 'parse-ambiguous' : 'parse', c.path);
    if (parsed.blocks.length === 0) throw fail('no-blocks', `${c.path} has no conflict block`);
    const sel = checkSelection(parsed, splitLines(resolved), tick);
    if (!sel.ok) throw fail(sel.reason, c.path);
    sel.droppedTheirs.forEach((droppedTheirs, i) => blocks.push({ path: c.path, block: i + 1, droppedTheirs }));
    if (blocks.length > MAX_BLOCKS) throw fail('too-many-blocks', `more than ${MAX_BLOCKS} conflict blocks in all`);
  }
  // Totals over EVERY block: a caller that shows or stores only some of them must not derive "dropped nothing" from its slice.
  const withDrops = blocks.filter((b) => b.droppedTheirs > 0);
  return {
    base: merged.tree, conflicted, conflictedCount: conflicted.length, blocks,
    blockCount: blocks.length, blocksWithDrops: withDrops.length, droppedTheirsTotal: withDrops.reduce((n, b) => n + b.droppedTheirs, 0),
  };
}

// Was the branch's merge of the base branch (since the last reviewed head `from`) a conflict that was resolved only by choosing,
// per conflict block, lines the two sides already had? If so the review base is the trial merge WITH its conflict markers, and
// head differs from it by exactly the resolution; the round need not count toward the round cap (see the plan
// docs/plans/2026-10-29-conflict-resolution-round.md for every rule). Any failed rule, or any doubt, is `ineligible` and the
// caller falls back to the whole-PR range. `baseRef` is the protected branch ref (origin/<default>) merges must come from.
// `o.resolutionSearchBudget` overrides the search cap (tests).
// -> { base: <marker tree id>, conflicted: [every conflicted path], conflictedCount, blocks: [{ path, block, droppedTheirs }],
//      blockCount, blocksWithDrops, droppedTheirsTotal (over all blocks) }
//  | { ineligible: '<code>' | '<code>: <detail>' }
export function resolutionReviewBase({ from, forkPoint, head, baseRef }, o) {
  try {
    return resolutionChecks({ from, forkPoint, head, baseRef }, o);
  } catch (err) {
    if (err instanceof Ineligible) return { ineligible: err.message };
    if (err instanceof SearchCap) return { ineligible: 'search-cap: the block check exceeded its step budget' };
    // Last line of defence: a stack overflow on some unforeseen input must fall back to the counted whole-PR round, never crash.
    if (err instanceof RangeError) return { ineligible: 'too-many-blocks: the block check ran out of stack' };
    if (err instanceof GitError) return { ineligible: `git-error: ${err.message.slice(0, 300)}` };
    throw err;
  }
}

// ---------- 'conflict' round: the PR's own changes after a conflicting merge, plus evidence of each conflict's resolution (#423) ----------

const MAX_OWN_HISTORY = 200;
const MAX_DISPLAY_CONFLICTS = 50;
const MAX_RECORD_MESSAGE = 300;
// Modes that are never judged by a text diff: a link target, a submodule commit, or a directory where a file was.
const NON_FILE_MODES = new Set(['120000', '160000', '040000']);

// H: head's first-parent chain back to `from` holds only ordinary (one-parent) commits and two-parent merges whose second parent is on
// `baseRef`. The WHOLE chain is walked: a foreign merge, an octopus merge or a rewrite anywhere in it could carry changes the "own
// changes" slice would then hide. All shas are full. -> { commits, merges } or throws Ineligible.
function walkOwnHistory({ from, head, baseRef }, o) {
  const entries = new Map();
  for (const line of git(['rev-list', '--first-parent', '--parents', head, `^${from}`], o).split('\n')) {
    if (line === '') continue;
    const [sha, ...parents] = line.split(' ');
    entries.set(sha, parents);
  }
  if (entries.size > MAX_OWN_HISTORY) throw fail('history', `${entries.size} commits since the last reviewed head`);
  const merges = [];
  for (let cur = head; cur !== from; ) {
    const parents = entries.get(cur);
    if (!parents) throw fail('history', 'the last reviewed head is not on the first-parent chain of HEAD');
    if (parents.length === 0) throw fail('history', `${cur} is a root commit`);
    if (parents.length > 2) throw fail('history', `${cur} merges ${parents.length} parents`);
    if (parents.length === 2) {
      if (!isAncestor(parents[1], baseRef, o)) throw fail('history', `${cur} merges ${parents[1]}, which is not on ${displayRef(baseRef)}`);
      merges.push({ sha: cur, parents });
    }
    cur = parents[0];
  }
  return { commits: entries.size, merges };
}

// null, or why head's history since `from` is not "the PR's own commits plus merges of the protected branch" (rule H; also used by
// round-status to decide whether a count of own changes can be trusted). from / head / baseRef are any revs.
export function ownHistoryProblem({ from, head, baseRef }, o) {
  try {
    assertRef(baseRef, ['rev-list', baseRef]);
    walkOwnHistory({ from: revParse(`${assertRef(from, ['rev-parse', from])}^{commit}`, o), head: revParse(`${assertRef(head, ['rev-parse', head])}^{commit}`, o), baseRef }, o);
    return null;
  } catch (err) {
    if (err instanceof Ineligible) return err.message;
    if (err instanceof GitError) return `git-error: ${err.message.slice(0, 300)}`;
    throw err;
  }
}

// `git diff --raw -z -M` from the merge base to one side: Map <merge-base path> -> [destination paths], so a renamed file is the same
// key on both sides. A hit rename limit (git says so on stderr) throws: a rename it skipped could hide a destination from rule A.
function changesByBasePath(baseCommit, side, o) {
  const args = [
    ...STABLE_CONFIG, '-c', 'diff.renameLimit=7000', 'diff', '--raw', '-z', '-M', '--no-abbrev', '--no-color', '--no-ext-diff', '--no-textconv', '--no-relative',
    '--ignore-submodules=none', assertRef(baseCommit, ['diff', baseCommit]), assertRef(side, ['diff', side]),
  ];
  const r = exec(args, o);
  if (r.code !== 0) throw new GitError({ args, code: r.code, stderr: r.stderr });
  if (/rename/i.test(r.stderr ?? '')) throw fail('attribute', 'git reported that rename detection hit its limit');
  const parts = r.stdout.split('\0');
  const out = new Map();
  for (let i = 0; i < parts.length; ) {
    if (parts[i] === '') { i++; continue; }
    const m = /^:(\d+) (\d+) [0-9a-f]+ [0-9a-f]+ ([A-Z])(\d*)$/.exec(parts[i]);
    if (!m) throw new GitError({ args, code: 0, stderr: `unexpected raw diff entry: ${parts[i]}` });
    const renamed = m[3] === 'R' || m[3] === 'C';
    const [a, b] = renamed ? [parts[i + 1], parts[i + 2]] : [parts[i + 1], parts[i + 1]];
    if (a === undefined || b === undefined) throw new GitError({ args, code: 0, stderr: 'truncated raw diff entry' });
    const key = m[3] === 'C' ? b : a;
    out.set(key, [...(out.get(key) ?? []), b]);
    i += renamed ? 3 : 2;
  }
  return out;
}

// `git ls-tree -z --full-tree <tree> -- <paths>` -> Map path -> { mode, oid } (a path that is not in the tree is not in the map).
function treeEntries(tree, paths, o) {
  const out = new Map();
  for (let i = 0; i < paths.length; i += 200) {
    const chunk = paths.slice(i, i + 200);
    const parts = git(['--literal-pathspecs', 'ls-tree', '-z', '--full-tree', assertRef(tree, ['ls-tree', tree]), '--', ...chunk], o).split('\0');
    for (const part of parts) {
      if (part === '') continue;
      const m = /^(\d{6}) \w+ ([0-9a-f]{40,64})\t([^]+)$/.exec(part);
      if (!m) throw new GitError({ args: ['ls-tree', '-z'], code: 0, stderr: `unexpected ls-tree entry: ${part.slice(0, 80)}` });
      out.set(m[3], { mode: m[1], oid: m[2] });
    }
  }
  return out;
}

const sameEntry = (a, b) => (a === undefined || b === undefined ? a === b : a.mode === b.mode && a.oid === b.oid);
const entryOf = (e) => (e === undefined ? { absent: true } : { mode: e.mode, oid: e.oid });

function conflictChecks({ from, forkPoint, head, baseRef }, o) {
  if (!supportsMergeTreeWrite(o)) throw fail('git-too-old', 'merge-tree --write-tree needs git 2.38');
  assertRef(baseRef, ['rev-list', baseRef]);
  const [fromSha, forkSha, headFull] = [from, forkPoint, head].map((x) => revParse(`${assertRef(x, ['rev-parse', x])}^{commit}`, o));

  const { merges } = walkOwnHistory({ from: fromSha, head: headFull, baseRef }, o);
  if (merges.length === 0) throw fail('history', 'no merge of the base branch since the last reviewed head');

  const merged = mergeTreeDetailed(fromSha, forkSha, o);
  if (merged.clean || merged.conflicts.length === 0) throw fail('no-conflict', merged.clean ? 'the trial merge is clean' : 'merge-tree reported a conflict but listed no conflicted file');
  if (merged.conflicts.length > MAX_DISPLAY_CONFLICTS) throw fail('too-many-conflicts', `${merged.conflicts.length} conflicted paths`);
  const conflicted = merged.conflicts.map((c) => c.path);
  const known = new Set(conflicted);
  // The trial merge uses the last reviewed head as its first parent, but an own commit may come before the real merge: a file that commit edited
  // can conflict in the real merge and be absent from the trial list, with no evidence and no marker check. Any conflict a merge commit of the
  // chain has outside the trial list is refused (the whole PR is then reviewed).
  // Per conflicted path, in chain order (oldest merge first; `merges` is newest first). A merge with a conflict entry for the path must have the
  // trial's stage 2 (an own commit that edited the file before the merge changes it: a resolver restoring the reviewed blob would hide the edit from
  // every review), and only ONE merge of the chain may conflict on a path: the trial merge shows only the last main commit's side, so an earlier
  // merge's conflict would reach no reviewer. A merge with NO entry for the path is fine when an earlier merge already conflicted there with the
  // trial's stage 2, or when the path's entry in its first parent is unchanged since the last reviewed head; otherwise an own commit changed it.
  const conflictedIn = new Set();
  for (const m of [...merges].reverse()) {
    if (m.parents[0] === fromSha && m.parents[1] === forkSha) { for (const p of conflicted) conflictedIn.add(p); continue; }
    const actual = mergeTreeDetailed(m.parents[0], m.parents[1], o);
    const extra = actual.conflicts.map((c) => c.path).filter((p) => !known.has(p));
    if (extra.length > 0) throw fail('evidence', `the merge ${m.sha} also conflicts in ${shortList(extra)}, which the trial merge of the last reviewed head does not`);
    const noEntry = merged.conflicts.filter((c) => !actual.conflicts.some((a) => a.path === c.path));
    const parentEntries = noEntry.length > 0 ? treeEntries(m.parents[0], noEntry.map((c) => c.path), o) : new Map();
    const fromEntries = noEntry.length > 0 ? treeEntries(fromSha, noEntry.map((c) => c.path), o) : new Map();
    const changed = [];
    const twice = [];
    for (const c of merged.conflicts) {
      const entry = actual.conflicts.find((a) => a.path === c.path);
      if (entry) {
        if (conflictedIn.has(c.path)) twice.push(c.path);
        else if (!sameEntry(c.stages[2], entry.stages[2])) changed.push(c.path);
        conflictedIn.add(c.path);
      } else if (!conflictedIn.has(c.path) && !sameEntry(parentEntries.get(c.path), fromEntries.get(c.path))) changed.push(c.path);
    }
    if (twice.length > 0) throw fail('evidence', `more than one merge of the chain conflicts in ${shortList(twice)} (at ${m.sha}); the earlier merge's conflict is in no record`);
    if (changed.length > 0) throw fail('evidence', `an own commit before the merge ${m.sha} changed ${shortList(changed)}, which the trial merge of the last reviewed head conflicts in`);
  }

  // A: no merge-affecting attribute on any path a driver could have resolved silently: every merge-base path BOTH sides changed (with
  // each side's rename destination), every conflicted path and every path an ort message names.
  const baseCommit = mergeBase(fromSha, forkSha, o);
  const ours = changesByBasePath(baseCommit, fromSha, o);
  const theirs = changesByBasePath(baseCommit, forkSha, o);
  const attrPaths = new Set([...conflicted, ...merged.messages.flatMap((m) => m.paths)]);
  for (const [key, dests] of ours) {
    if (!theirs.has(key)) continue;
    attrPaths.add(key);
    for (const d of [...dests, ...theirs.get(key)]) attrPaths.add(d);
  }
  const attr = attributeProblem([...attrPaths], o);
  if (attr) throw fail('attribute', attr);

  // E: what ort wrote into the marker tree must be visible to the reviewer. Observed on git 2.39 (real repos, not assumed):
  //  - a text conflict stages 1, 2 and 3 and its resolution shows in the patch (marker tree..head);
  //  - a PR-added file inside a directory main RENAMED is staged (stage 2 only) at its new path with the type 'CONFLICT (directory rename
  //    suggested)' and a message naming the new and the old path: a record, whose `heads` show where head put it;
  //  - a directory SPLIT stages nothing for the PR's file: one message of type 'CONFLICT(directory rename unclear split)' (no space) naming
  //    the directory; a file in the way of an implicit directory rename is 'CONFLICT (file in way of directory rename)' naming two clean
  //    paths. Neither names a staged path, so both fail E instead of passing as information (only 'Auto-merging' is informational);
  //  - a file/directory conflict stages the file as `<path>~<sha>` and the message names the directory path (mode 040000 in head: refused).
  for (const m of merged.messages) {
    if (m.type === 'Auto-merging') continue;
    if (!m.paths.some((p) => known.has(p))) throw fail('evidence', `${m.type} names no conflicted file: ${shortList(m.paths)}`);
  }
  const named = new Set([...conflicted, ...merged.messages.filter((m) => m.type !== 'Auto-merging').flatMap((m) => m.paths)]);
  const headEntries = treeEntries(headFull, [...named], o);
  const treeEntriesAt = treeEntries(merged.tree, conflicted, o);
  const tick = makeBudget(o?.resolutionSearchBudget);
  const labels = { ours: fromSha, theirs: forkSha };
  const records = [];
  for (const c of merged.conflicts) {
    const types = c.types.filter((t) => t !== 'Auto-merging');
    if (types.length === 0) throw fail('evidence', `no message names the conflict at ${c.path}`);
    const headEntry = headEntries.get(c.path);
    for (const e of [c.stages[1], c.stages[2], c.stages[3], headEntry]) {
      if (e && NON_FILE_MODES.has(e.mode)) throw fail('evidence', `${c.path} is a ${e.mode} entry (link, submodule or directory)`);
    }
    const [s1, s2, s3] = [1, 2, 3].map((n) => c.stages[n]);
    const textMode = (e) => e !== undefined && TEXT_MODES.has(e.mode);
    const isText = types.length === 1 && types[0] === 'CONFLICT (contents)' && textMode(s1) && textMode(s2) && textMode(s3);

    // The block rule: no conflict block of the marker blob may survive in head's blob, whatever label its markers carry (a real merge
    // writes HEAD / the branch name, the trial tree writes full commit ids). A text conflict must have blocks and every one resolved;
    // any other path whose marker blob has blocks (add/add, a rename collision) is held to the same rule.
    const treeEntry = treeEntriesAt.get(c.path);
    let blocks = null;
    let marked = false;
    if (treeEntry && textMode(treeEntry)) {
      const marker = catBlob(treeEntry.oid, o);
      marked = splitLines(marker).some((l) => l.startsWith('<') && isMarkerLine(l));
      if ((isText || marked) && s2 && s3 && textMode(s2) && textMode(s3) && !marker.includes('\0')) {
        const [t2, t3] = [s2, s3].map((e) => catBlob(e.oid, o));
        if (![marker, t2, t3].some((t) => t.includes('\0') || t.includes('\uFFFD'))) {
          const parsed = parseConflictBlocks(splitLines(marker), splitLines(t2), splitLines(t3), tick, labels);
          if (parsed.reason === 'too-many-blocks') throw fail('evidence', `${c.path} has more than ${MAX_BLOCKS} conflict blocks`);
          if (!parsed.reason) blocks = parsed.blocks;
        }
      }
    }
    if (isText && (blocks === null || blocks.length === 0)) throw fail('evidence', `the conflict blocks of ${c.path} could not be read`);
    if (!isText && marked && blocks === null) throw fail('evidence', `the conflict markers of ${c.path} could not be read`);
    if (blocks && blocks.length > 0 && !headEntry) throw fail('evidence', `${c.path} has conflict blocks but is not at that path in head (renamed or moved), so its markers cannot be checked`);
    if (headEntry && textMode(headEntry)) {
      const text = catBlob(headEntry.oid, o);
      if (text.includes('\0') && blocks && blocks.length > 0) throw fail('evidence', `${c.path} (head) holds a NUL byte, so its conflict blocks cannot be checked`);
      if (!text.includes('\0')) {
        if (text.includes('\uFFFD')) throw fail('evidence', `${c.path} (head) is not valid UTF-8`);
        const headLines = splitLines(text);
        if (blocks && blocks.length > 0) {
          const left = committedBlock(headLines, blocks);
          if (left >= 0) throw fail('evidence', `${c.path} still has conflict block ${left + 1} with its markers`);
        }
        // Style-independent: a marker-shaped line of head that no stage blob holds is a conflict marker of a real merge (merge, diff3 or zdiff3 style),
        // whatever its labels and whatever its block looks like; a file whose own content has such a line keeps it in a stage blob.
        const stageLines = new Set();
        for (const e of [s1, s2, s3]) {
          if (!e || !textMode(e)) continue;
          for (const l of splitLines(catBlob(e.oid, o))) if (isMarkerLine(l)) stageLines.add(l.replace(/\r?\n$/, ''));
        }
        const stray = headLines.find((l) => isMarkerLine(l) && !stageLines.has(l.replace(/\r?\n$/, '')));
        if (stray !== undefined) throw fail('evidence', `${c.path} (head) holds a conflict marker line that no side of the conflict has`);
      }
    }
    if (isText) continue;

    const heads = [];
    const seen = new Set();
    for (const p of [c.path, ...merged.messages.filter((m) => m.type !== 'Auto-merging' && m.paths.includes(c.path)).flatMap((m) => m.paths)]) {
      if (seen.has(p)) continue;
      seen.add(p);
      const e = headEntries.get(p);
      if (e && e.mode === '040000') throw fail('evidence', `${p} is a directory in head`);
      heads.push(e ? { path: p, mode: e.mode, oid: e.oid } : { path: p, absent: true });
    }
    const candidates = [['ours', s2], ['theirs', s3], ['base', s1], ['tree', treeEntry]];
    const headEquals = candidates.find(([, e]) => sameEntry(headEntry, e))?.[0] ?? 'none';
    if (blocks && blocks.length > 0 && headEquals === 'tree') throw fail('evidence', `${c.path} is left as the trial merge wrote it, markers included`);
    const stages = {};
    for (const n of [1, 2, 3]) if (c.stages[n]) stages[n] = { ...c.stages[n] };
    for (const e of Object.values(stages)) {
      if (gitOrNull(['cat-file', '-e', assertRef(e.oid, ['cat-file', '-e', e.oid])], 1, o) === null) throw fail('export', `${e.oid} (${c.path}) is not readable in this clone`);
    }
    // messages: cut only after every path was read from the structured fields above
    const messages = merged.messages.filter((m) => m.type !== 'Auto-merging' && m.paths.includes(c.path))
      .map((m) => m.text.replace(/\s+/g, ' ').trim().slice(0, MAX_RECORD_MESSAGE));
    records.push({ path: c.path, types, messages, stages, head: entryOf(headEntry), headEquals, heads });
  }
  if (revParse(`${headFull}^{tree}`, o) === merged.tree) throw fail('evidence', 'records-only: head equals the marker tree, so there is no patch to review');
  return { base: merged.tree, conflicted, conflictedCount: conflicted.length, records };
}

// The base for a counted 'conflict' round (the free resolution proof refused): the marker tree of a trial merge of the last reviewed
// head `from` with the base branch `forkPoint`, which `head` differs from by the PR's own changes plus how each text conflict was
// resolved. Admitted only where the evidence is complete (rules H, A, E, X in docs/plans/2026-11-20-round-diff-after-conflicting-merge.md):
// every conflicted text file's resolution is in the patch, every other conflict has a record of what git staged and what head kept.
// -> { base: <marker tree id>, conflicted: [<= 50 paths], conflictedCount, records: [{ path, types, messages, stages, head, headEquals, heads }] }
//  | { unavailable: 'git-too-old' | 'no-conflict' | 'too-many-conflicts: …' | 'history: …' | 'attribute: …' | 'evidence: …' | 'export: …' | 'git-error: …' }
// The caller falls back to the whole-PR range on `unavailable`.
export function conflictReviewBase({ from, forkPoint, head, baseRef }, o) {
  try {
    return conflictChecks({ from, forkPoint, head, baseRef }, o);
  } catch (err) {
    if (err instanceof Ineligible) return { unavailable: err.message };
    if (err instanceof SearchCap) return { unavailable: 'evidence: the block check exceeded its step budget' };
    if (err instanceof RangeError) return { unavailable: 'evidence: the block check ran out of stack' };
    if (err instanceof GitError) return { unavailable: `git-error: ${err.message.slice(0, 300)}` };
    throw err;
  }
}

export class ReviewBaseUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReviewBaseUnavailable';
    this.code = 'review-base-unavailable';
  }
}

// The tree a 'synthetic', 'resolution' or 'conflict' round was diffed against exists only where it was made. On another clone it is
// rebuilt with the same forced merge config from the round's own commits, and only the SAME tree id is accepted: a different
// id means this checkout merges differently (conflict style, attributes), and quietly diffing against another tree would be a
// different review. A tree that IS in this clone is returned as it is: the admission rules (a 'conflict' round's attribute and evidence
// rules too) re-run only when the tree object is missing, i.e. past the early return below.
// -> the base to diff from. Other kinds, and rounds without a recorded base, are returned as they are.
export function ensureReviewBase(round, o) {
  const id = round.reviewBase;
  if (id === undefined) return round.fromHead;
  const kind = round.reviewBaseKind;
  if (kind !== 'synthetic' && kind !== 'resolution' && kind !== 'conflict') return id;
  if (gitOrNull(['cat-file', '-e', assertRef(id, ['cat-file', '-e', id])], 1, o) !== null) return id;
  const unavailable = (why) => new ReviewBaseUnavailable(
    `review-base-unavailable: the ${kind} review base ${id} is not in this clone and could not be rebuilt (${why}). `
    + 'A trial merge depends on merge.conflictStyle / merge.renormalize / core.autocrlf / merge.default (forced here) and on .gitattributes merge, conflict-marker-size, diff attributes of the conflicted paths.',
  );
  let rebuilt;
  try {
    if (!supportsMergeTreeWrite(o)) throw unavailable('git is older than 2.38');
    const fromFull = revParse(`${round.fromHead}^{commit}`, o);
    const forkFull = revParse(`${round.forkPoint}^{commit}`, o);
    if (kind === 'resolution') {
      const attr = attributeProblem(round.conflicted ?? [], o);
      if (attr) throw unavailable(attr);
      rebuilt = mergeTreeDetailed(fromFull, forkFull, o).tree;
    } else if (kind === 'conflict') {
      // The full admission again, on the recomputed complete conflict set (not the stored display list); the ancestor test for the
      // merges' second parents uses the round's own fork point.
      const found = conflictReviewBase({ from: fromFull, forkPoint: forkFull, head: round.toHead, baseRef: forkFull }, o);
      if (found.unavailable) throw unavailable(found.unavailable);
      rebuilt = found.base;
    } else {
      rebuilt = mergeTree(fromFull, forkFull, o).tree;
    }
  } catch (err) {
    if (err instanceof ReviewBaseUnavailable) throw err;
    if (err instanceof GitError || err instanceof TypeError) throw unavailable(err.message.slice(0, 300));
    throw err;
  }
  if (rebuilt !== id) throw unavailable(`rebuilding gave tree ${rebuilt}`);
  return id;
}

export const headSha = (o) => git(['rev-parse', 'HEAD'], o).trim();

// `HEAD` when detached. Reads the full ref instead of using --short/--abbrev-ref, which print `heads/x` when a tag
// has the same name as the branch.
export function currentBranch(o) {
  const ref = gitOrNull(['symbolic-ref', '-q', 'HEAD'], 1, o); // exit 1 with -q: HEAD is not a symbolic ref
  return ref === null ? 'HEAD' : ref.trim().replace(/^refs\/heads\//, '');
}

export const isClean = (o) => git(['status', '--porcelain=v1', '-uall'], o) === '';

export const revParse = (ref, o) => git(['rev-parse', '--verify', assertRef(ref, ['rev-parse', '--verify', ref])], o).trim();

// A binary change is left out of the --text diff (see diffFiles) only when it is BOTH big and in a document/media/archive
// format from this list. The size alone must not decide: a source file with one NUL byte is "binary" to git too, and
// skipping it would hide its lines from every check. Matched on the extension (lower case) of every path of the change.
export const LARGE_BINARY_BYTES = 4 * 1024 * 1024; // the larger blob of the change; diffFiles' option largeBinaryBytes overrides it (tests)
// Many files each under that limit can still add up past proc.run's buffer. So the listed-format binary changes LEFT in the
// text diff are also capped in total (bytes git could print for them: old blob + new blob each); beyond it the largest go
// first. Option largeBinaryTotalBytes overrides it (tests).
export const LARGE_BINARY_TOTAL_BYTES = 32 * 1024 * 1024;
const BINARY_FORMAT_EXTENSIONS = new Set([
  'xls', 'xlsx', 'xlsm', 'xlsb', 'ods', 'numbers', 'pdf', 'doc', 'docx', 'ppt', 'pptx',
  'zip', '7z', 'rar', 'gz', 'tgz', 'bz2', 'xz', 'tar',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'tif', 'tiff', 'heic', 'ico',
  'mp3', 'mp4', 'm4a', 'mov', 'webm', 'wav', 'ogg', 'avi', 'mkv',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'sqlite', 'sqlite3', 'db', 'mdb', 'accdb', 'parquet',
]);
const isBinaryFormat = (p) => {
  const name = p.slice(p.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 && BINARY_FORMAT_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
};
// A change between plain files only: a symlink or submodule entry is never skipped, whatever it is called.
const PLAIN_MODES = new Set(['000000', '100644', '100755']);

// Which changes of from..to to keep OUT of a text diff (--text, or --binary in contentHash / reviewPatch), plus git's own order
// of every change (path -> position) so the result can be put back in that order. Asks git, WITHOUT --text, which changes it calls binary (--numstat -z prints "-\t-"
// for them; a rename is "-\t-\t\0old\0new\0"), then keeps those that are big and in a listed document format. A byte-identical
// move prints no content either way, so it is never skipped. Blob sizes come from one cat-file call. Entries come back as
// rawChanges plus `size` (the larger blob) and `printed` (old + new blob, what the text diff would print for the change). Anything unclear (a blob
// git cannot size) leaves the change in the diff: today's behaviour, never a hidden file.
function largeBinaryChanges(from, to, o) {
  const numstat = git([
    ...STABLE_CONFIG, 'diff', '-M', '--numstat', '-z', '--no-color', '--no-ext-diff', '--no-textconv',
    `${from}..${assertRef(to, ['diff', to])}`,
  ], o).split('\0');
  const binary = new Set();
  for (let i = 0; i < numstat.length; ) {
    const m = /^(-|\d+)\t(-|\d+)\t([^]*)$/.exec(numstat[i]);
    if (!m) {
      if (numstat[i] === '') { i++; continue; }
      throw new GitError({ args: ['diff', '--numstat', '-z'], code: 0, stderr: `unexpected numstat entry: ${numstat[i]}` });
    }
    const renamed = m[3] === '';
    const key = renamed ? numstat[i + 2] : m[3]; // where the change lives: the new path for a rename
    if (key === undefined) throw new GitError({ args: ['diff', '--numstat', '-z'], code: 0, stderr: 'truncated numstat' });
    if (m[1] === '-' && m[2] === '-') binary.add(key);
    i += renamed ? 3 : 1;
  }
  if (binary.size === 0) return { skipped: [], order: new Map(), binary };

  const changes = rawChanges(from, to, o);
  const order = new Map(changes.map((c, i) => [c.newPath ?? c.oldPath, i]));
  // A literal exclude pathspec also matches everything UNDER the path, so a change whose path becomes (or was) a directory of
  // another change in the range is never skipped: skipping "data.xlsx" would hide "data.xlsx/payload.js" with it.
  const everyPath = changes.flatMap((c) => [c.oldPath, c.newPath]).filter(Boolean);
  const hasDescendant = (c) => [c.oldPath, c.newPath].filter(Boolean).some((p) => everyPath.some((q) => q.startsWith(`${p}/`)));
  const candidates = changes.filter((c) => binary.has(c.newPath ?? c.oldPath)
    && ['A', 'D', 'M', 'R'].includes(c.status) && PLAIN_MODES.has(c.oldMode) && PLAIN_MODES.has(c.newMode)
    && c.oldId !== c.newId
    && [c.oldPath, c.newPath].filter(Boolean).every(isBinaryFormat)
    && !hasDescendant(c));
  if (candidates.length === 0) return { skipped: [], order, binary };

  const ids = [...new Set(candidates.flatMap((c) => [c.oldId, c.newId]).filter((id) => !/^0+$/.test(id)))];
  const sizes = new Map();
  for (const line of git(['cat-file', '--batch-check'], { ...o, input: `${ids.join('\n')}\n` }).split('\n')) {
    const m = /^([0-9a-f]+) blob (\d+)$/.exec(line);
    if (m) sizes.set(m[1], Number(m[2]));
  }
  const limit = o?.largeBinaryBytes ?? LARGE_BINARY_BYTES;
  const budget = o?.largeBinaryTotalBytes ?? LARGE_BINARY_TOTAL_BYTES;
  const sized = candidates.map((c) => {
    const [before, after] = [sizes.get(c.oldId) ?? 0, sizes.get(c.newId) ?? 0];
    return { ...c, size: Math.max(before, after), printed: before + after };
  });
  const skipped = sized.filter((c) => c.size > limit);
  // What is left may still add up to too much: take the largest out first (name order breaks ties) until it fits.
  const rest = sized.filter((c) => c.size <= limit).sort((a, b) => b.printed - a.printed || ((a.newPath ?? a.oldPath) < (b.newPath ?? b.oldPath) ? -1 : 1));
  let total = rest.reduce((n, c) => n + c.printed, 0);
  for (const c of rest) {
    if (total <= budget) break;
    skipped.push(c);
    total -= c.printed;
  }
  return { skipped, order, binary };
}

// Literal, repo-root pathspecs that leave the given changes (old and new path) out of a diff, as in contentHash: a name like
// "a*.xlsx", or the cwd, cannot change what is excluded.
const excludeSpecs = (changes) => changes.flatMap((c) => [c.oldPath, c.newPath]).filter(Boolean).map((p) => `:(top,exclude,literal)${p}`);

// What the branch changes relative to where it forked: the diff is taken from the merge-base, not from `base`'s tip,
// so commits that landed on base after the fork never show up as the branch deleting them.
// --text: a NUL byte in a comment, or a `*.ts -diff` line in .gitattributes, makes git print "Binary files differ" and
// no lines at all, which would hide an added `.skip` or a deleted test from every check built on this. --no-textconv /
// --no-ext-diff: a repo-configured converter or external diff tool must not rewrite what we parse (or run at all).
// The price of --text is that a binary file is printed byte for byte: a PR deleting a few hundred MB of spreadsheets made a
// diff bigger than proc.run's buffer (ENOBUFS) and every check built on it crashed. So a change git calls binary whose
// larger blob is over LARGE_BINARY_BYTES, and whose paths (both, for a rename) all have a listed binary-format extension,
// is not printed: it comes back path-only, in the shape parseUnifiedDiff gives a binary change plus `skippedLargeBinary:
// true`. The path rules still see its paths; there are simply no lines to read. Everything else keeps --text however big it
// is, so a NUL byte in a source file cannot be used to hide it.
// A 'synthetic' review base (effectiveReviewBase) is a tree id, which has no merge base: it is already the exact base. Only a caller that passes `{ treeBase: true }` (the third argument) diffs against
// it as it is (fix-verify.mjs#fixRoundFiles); every other caller keeps the old behaviour, a throw, which the threat-model and out-of-model-waiver paths read as "no readable range" and fail closed on.
export function diffFiles(base, head, o, { treeBase = false } = {}) {
  let mb;
  try {
    mb = mergeBase(base, head, o);
  } catch (err) {
    if (!treeBase || !(err instanceof GitError) || git(['cat-file', '-t', assertRef(base, ['cat-file', '-t', base])], o).trim() !== 'tree') throw err;
    mb = base;
  }
  const range = `${mb}..${assertRef(head, ['diff', head])}`;
  const { skipped, order, binary } = largeBinaryChanges(mb, head, o);
  const exclude = excludeSpecs(skipped);
  const text = git([
    ...STABLE_CONFIG, 'diff', '-M', '--unified=0', '--no-color', '--no-ext-diff', '--no-textconv', '--text', '--src-prefix=a/', '--dst-prefix=b/',
    range, ...(exclude.length > 0 ? ['--', ':/', ...exclude] : []),
  ], o);
  const files = parseUnifiedDiff(text);
  // --text prints a binary file as text (binary: false); git's own numstat verdict is kept as `gitBinary` (only when true) for a caller that must not treat such a file as text.
  for (const f of files) if (binary.has(f.path)) f.gitBinary = true;
  if (skipped.length === 0) return files;
  for (const c of skipped) {
    files.push({
      oldPath: c.oldPath, newPath: c.newPath, path: c.status === 'D' ? c.oldPath : c.newPath, status: c.status,
      similarity: c.status === 'R' ? c.score : null, binary: true, added: [], removed: [], skippedLargeBinary: true,
    });
  }
  // Back into git's own order, so adding the entries never moves the others. A finite rank: a path git did not list sorts
  // last instead of putting NaN into the comparator.
  const rank = (f) => order.get(f.path) ?? order.size;
  return files.sort((a, b) => rank(a) - rank(b));
}

// One entry per change of `git diff -M --raw -z --no-abbrev` for from..to, with the SAME options as diffFiles.
// -> [{ oldMode, newMode, oldId, newId, status, score, oldPath, newPath }] (a path is null on the side that does not exist;
// score is a rename's similarity, null for the rest).
function rawChanges(from, to, o) {
  const text = git([
    ...STABLE_CONFIG, 'diff', '-M', '--raw', '-z', '--no-abbrev', '--no-color', '--no-ext-diff', '--no-textconv',
    `${from}..${assertRef(to, ['diff', to])}`,
  ], o);
  const parts = text.split('\0');
  const out = [];
  for (let i = 0; i < parts.length; ) {
    const m = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])(\d*)$/.exec(parts[i]);
    if (!m) {
      if (parts[i] === '') { i++; continue; }
      throw new GitError({ args: ['diff', '--raw', '-z'], code: 0, stderr: `unexpected raw diff entry: ${parts[i]}` });
    }
    const two = m[5] === 'R' || m[5] === 'C';
    const first = parts[i + 1];
    const second = two ? parts[i + 2] : first;
    if (first === undefined || second === undefined) throw new GitError({ args: ['diff', '--raw', '-z'], code: 0, stderr: 'truncated raw diff' });
    out.push({
      oldMode: m[1], newMode: m[2], oldId: m[3], newId: m[4], status: m[5], score: m[6] === '' ? null : Number(m[6]),
      oldPath: m[5] === 'A' ? null : first, newPath: m[5] === 'D' ? null : second,
    });
    i += two ? 3 : 2;
  }
  return out;
}

// Tree modes of every change diffFiles reports, from `git diff --raw -z` with the SAME options, base and head: a 100% rename
// has no `mode` line in the unified diff, so a symlink (120000) or submodule (160000) that merely MOVES is invisible there.
// -> [{ oldMode, newMode, status, oldPath, newPath }] (a path is null on the side that does not exist).
export function diffModes(base, head, o) {
  const mb = mergeBase(base, head, o);
  return rawChanges(mb, head, o).map(({ oldMode, newMode, status, oldPath, newPath }) => ({ oldMode, newMode, status, oldPath, newPath }));
}

const MISSING_PATH = /does not exist|exists on disk, but not in/;

// File content at a ref, or null when the path is not in that tree. A bad ref still throws: treating a typo'd ref as
// "file absent" would let an integrity check pass vacuously.
export function showFile(ref, path, o) {
  try {
    return git(['show', `${assertRef(ref, ['show', ref])}:${path}`], o);
  } catch (e) {
    if (e instanceof GitError && !e.abnormal && e.code === 128 && MISSING_PATH.test(e.stderr)) return null;
    throw e;
  }
}

// Does `fixedString` occur anywhere in the tree at `ref`? (-F: literal text, never a regex.)
export function grepAtRef(ref, fixedString, o) {
  // git splits a -F pattern on newlines and ORs the pieces, which would turn "a\nb" into "a or b" without a word.
  if (fixedString.includes('\n')) throw new TypeError('grepAtRef: fixedString must be a single line');
  const hit = gitOrNull(['grep', '-F', '-q', '-e', fixedString, assertRef(ref, ['grep', ref]), '--'], 1, o);
  return hit !== null;
}

// Committer time in epoch ms. `^{commit}` peels annotated tags, which `git show` would otherwise print as a tag first.
export function commitTime(sha, o) {
  const out = git(['show', '-s', '--no-show-signature', '--format=%ct', `${assertRef(sha, ['show', sha])}^{commit}`], o).trim();
  const seconds = Number(out);
  if (!/^\d+$/.test(out)) throw new GitError({ args: ['show', '-s', '--format=%ct', sha], code: 0, stderr: `unexpected commit time: ${out}` });
  return seconds * 1000;
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;
// `index <old>..<new> [mode]`. Content lines start with + - or space and binary payload lines cannot contain a space,
// so a line starting `index ` is always this header.
const INDEX_LINE = /^index [0-9a-f]+\.\.[0-9a-f]+(?: \d+)?$/;

// Makes a diff independent of where in the file, and on top of which base, the change sits:
// `@@ -a,b +c,d @@ <function context>` becomes `@@`, and the `index` blob ids are dropped. Both move whenever the base
// edits the same file (verified: hunk header AND index line change), so keeping either would defeat the point.
// What is left per hunk is the change plus its context lines, which is what pins an edit to its location.
// Split on \n by hand: a regex `^` with /m also matches after U+2028/U+2029/\r inside content, which would let a
// crafted content line be rewritten.
function normaliseDiff(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (HUNK_HEADER.test(line)) out.push('@@');
    else if (!INDEX_LINE.test(line)) out.push(line);
  }
  return out.join('\n');
}

// sha256 proving "the code that was reviewed is the code being merged" without breaking on a routine base update.
// The input is `git diff --unified=3 --binary <merge-base>..<head>`, normalised, so the hash COVERS:
//   - every added/removed line, byte for byte (whitespace and CRLF included), and 3 unchanged lines of context on each
//     side of every change (nearby changes merge into one hunk, as git does);
//   - file paths, add/delete/rename/mode changes, and the full content of binary files (--binary: ASCII base85).
// and does NOT cover (so these never move the hash): line numbers, the function name git prints after `@@`, and the
// `index <blob>..<blob>` ids. Hence:
//   - an identical edit moved to a different place changes the hash, because its context changes;
//   - a base update that edits the same file MORE than 3 lines from every hunk leaves the hash alone (the line shift is
//     invisible), while one that edits a line WITHIN 3 lines of a hunk changes it. That is accepted on purpose: the
//     reviewed hunk now sits in different surroundings, so the safe answer is "re-review";
//   - blind spots: moving a change between two places with identical 3-line context, and invalid UTF-8 inside a
//     text-looking file (proc.run decodes UTF-8) both go unnoticed.
// No --text here, unlike diffFiles: --text turns binary files into raw bytes, which the UTF-8 decode would collapse
// (0xFE and 0xFD both become U+FFFD), whereas --binary alone keeps NUL and `-diff` files byte-exact.
// The one exception is a large binary document (see diffFiles): --binary would print its whole content again (base85, a
// quarter bigger) and overflow the buffer, so it is left out of the diff and one line stands in for it, carrying the
// status, both paths, both modes and both blob ids. A blob id IS a hash of the content, so the hash still moves whenever such a file's
// bytes change. Without any such file the input is exactly the normalised diff, as before.
// `exclude` paths (e.g. an agent log the pipeline itself appends to) are left out: each is a literal repo-root-relative
// path (`:(top,exclude,literal)`), so `*.js` is not a glob and `docs/x.md` does not match `sub/docs/x.md`. Pathspecs
// are anchored at the repo root so cwd cannot narrow what is hashed.
// The diff is read as ONE string, so the cap is what a JS string can hold (V8: 2^29-24 chars, and a char is at least one
// byte): 512 MiB. The default 64 MiB cap killed git with SIGKILL on a real 174 MB PR diff (a regenerated data file), which
// made the gate fail for exactly the PRs that most need a look. Past 512 MiB it fails loudly, never truncates.
export const DIFF_MAX_BYTES = 512 * 1024 * 1024;

export function contentHash(base, head, { exclude = [], maxBuffer = DIFF_MAX_BYTES, ...o } = {}) {
  const mb = mergeBase(base, head, o);
  const { skipped } = largeBinaryChanges(mb, head, o);
  const text = git([
    ...STABLE_CONFIG, 'diff', '--unified=3', '--binary', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/',
    `${mb}..${assertRef(head, ['diff', head])}`, '--', ':/', ...exclude.map((p) => `:(top,exclude,literal)${p}`), ...excludeSpecs(skipped),
  ], { ...o, maxBuffer });
  const diff = normaliseDiff(text);
  const stoodIn = skipped.filter((c) => !exclude.includes(c.newPath ?? c.oldPath)); // an excluded path never counts
  if (stoodIn.length === 0) return createHash('sha256').update(diff).digest('hex');
  // One JSON array per change (a path may hold any character but NUL), sorted. The modes are in it: a chmod +x alone changes
  // nothing else about a skipped file. The diff's length prefix and the NUL tag make
  // this input impossible to mistake for a plain diff (those start with "diff --git"), whatever the diff contains.
  const lines = stoodIn.map((c) => JSON.stringify([c.status, c.oldPath, c.newPath, c.oldMode, c.newMode, c.oldId, c.newId])).sort();
  return createHash('sha256').update(`large-binary\0${diff.length}\0${diff}\n${lines.join('\n')}\n`).digest('hex');
}

// The patch a review packet carries: `git diff --binary from..to`, minus the large binary documents (see diffFiles), which
// would overflow the buffer; the caller names them in the packet instead. -> { patch, skipped: [{ status, oldPath, newPath,
// size }] } (size = the larger blob, in bytes), sorted by path.
export function reviewPatch(from, to, o) {
  const { skipped } = largeBinaryChanges(from, to, o);
  const patch = git([
    'diff', '--binary', '--no-color', '--no-ext-diff', '--no-textconv', `${from}..${assertRef(to, ['diff', to])}`,
    ...(skipped.length > 0 ? ['--', ':/', ...excludeSpecs(skipped)] : []),
  ], o);
  const names = skipped.map(({ status, oldPath, newPath, size }) => ({ status, oldPath, newPath, size }));
  names.sort((a, b) => ((a.newPath ?? a.oldPath) < (b.newPath ?? b.oldPath) ? -1 : 1));
  return { patch, skipped: names };
}

// Does this EXACT ref exist? `git rev-parse --verify refs/remotes/origin/<b>` resolves the exact ref first, but with it MISSING it falls through to refs/tags/<name> and refs/heads/<name> (and
// refs/<name>): a local branch or tag literally named `refs/remotes/origin/<b>` would then read as the remote ref (#455). `git show-ref --verify` looks up the one name only: exit 1 with
// nothing on stderr is 'missing'; anything else (not a repository, a broken ref store) is a real failure and throws.
export const refExists = (ref, o) => gitOrNull(['show-ref', '--verify', '--quiet', assertRef(ref, ['show-ref', '--verify', ref])], 1, o) !== null;

// Is the remote-tracking ref refs/remotes/origin/<branch> there, by exact name (see refExists)?
export const remoteRefExists = (branch, o) => refExists(`refs/remotes/origin/${branch}`, o);

// `refs/remotes/origin/<branch>` is what a PR will be merged into; a repo without that remote ref (a fresh clone of a local fixture,
// a test) falls back to `refs/heads/<branch>`. Both are returned FULLY QUALIFIED: git resolves an abbreviated `origin/<b>` (or a bare `<b>`) through refs/tags and refs/heads
// first, so a PR that pushes a branch or a tag named `origin/main` would otherwise move the base every hash and fork point measures from (Fable F1, #448). The remote ref is looked up by exact name (remoteRefExists): a local branch or tag literally named `refs/remotes/origin/<branch>` is not it (#455). Any other git failure
// is not swallowed.
export function reviewBaseRef(branch, o) {
  return remoteRefExists(branch, o) ? `refs/remotes/origin/${branch}` : `refs/heads/${branch}`;
}

// The short, human-facing form of a ref reviewBaseRef returned (refs/remotes/origin/main -> origin/main).
export const displayRef = (ref) => String(ref).replace(/^refs\/remotes\//, '');

// The branch the remote itself calls its default (what refs/remotes/origin/HEAD points at), or null when the clone has none or it is not a plain
// origin/<branch>, or that ref does not resolve (a dangling symref after a rename fetched with prune: git symbolic-ref does not need the target to exist). A
// source a PR cannot edit: unlike .claude/pipeline.yml it is not part of the tree under review. The target is looked up by exact name (remoteRefExists), like the symref was read.
export function remoteDefaultBranch(o) {
  const out = gitOrNull(['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'], 1, o);
  const m = /^refs\/remotes\/origin\/(.+)\n?$/.exec(out ?? '');
  if (!m) return null;
  return remoteRefExists(m[1], o) ? m[1] : null;
}

// Is an `origin` remote configured at all? (`git config --get` answers exit 1 with nothing on stderr for a missing key.) A repo without one (a local-only clone, a fixture)
// has no remote to anchor the default branch on.
export const hasOriginRemote = (o) => gitOrNull(['config', '--get', 'remote.origin.url'], 1, o) !== null;

// What the remote says its default branch is, asked over the wire (`git ls-remote --symref origin HEAD`), for a clone that has no refs/remotes/origin/HEAD (#377). The
// answer of the remote is a source a PR cannot edit, like origin/HEAD. Read-only (no ref is written), best effort (a network failure, a timeout or a remote that names no
// branch is null, never a throw) and bounded by NETWORK_TIMEOUT_MS. Asked once per repository per process: the callers (trustedBase) run many times and must not each
// wait on the network, and a failure is remembered too. GIT_TERMINAL_PROMPT=0: a remote that wants credentials fails instead of waiting for a person.
const lsRemoteAnswers = new Map();
export function lsRemoteDefaultBranch(o) {
  const key = o?.cwd ?? process.cwd();
  if (lsRemoteAnswers.has(key)) return lsRemoteAnswers.get(key);
  let branch = null;
  try {
    const out = git(['ls-remote', '--symref', 'origin', 'HEAD'], { ...o, timeoutMs: NETWORK_TIMEOUT_MS, env: { ...o?.env, GIT_TERMINAL_PROMPT: '0' } });
    branch = /^ref: refs\/heads\/(?!-)(\S+)\tHEAD$/m.exec(out)?.[1] ?? null;
  } catch (err) {
    if (!(err instanceof GitError)) throw err;
  }
  lsRemoteAnswers.set(key, branch);
  return branch;
}
// For tests that change a repository's remote inside one process.
export const forgetLsRemoteAnswers = () => lsRemoteAnswers.clear();

// THE content hash of "the code that was reviewed": what HEAD changes relative to where it forked from the PR base,
// minus the agent log the pipeline itself appends to. The review loop (round coverage, review-complete) and the final
// gate / merge both call this, so they cannot disagree about whether a review is current.
//
// `head` (default 'HEAD') and `baseSha` (default: the resolved review base ref) let a caller hash an arbitrary commit
// that is only present as objects (a PR head fetched, not checked out) against an explicit base; this stays the one
// definition, so every caller agrees byte for byte with the review loop and the final gate.
export function reviewContentHash({ branch, agentLog, head = 'HEAD', baseSha } = {}, o) {
  return contentHash(baseSha ?? reviewBaseRef(branch, o), head, { ...o, exclude: agentLog ? [agentLog] : [] });
}

// Streams the file so a large untracked artifact does not have to fit in memory.
function sha256OfFile(abs) {
  const h = createHash('sha256');
  const fd = openSync(abs, 'r');
  const buf = Buffer.allocUnsafe(1 << 20);
  try {
    for (let n = readSync(fd, buf, 0, buf.length, null); n > 0; n = readSync(fd, buf, 0, buf.length, null)) {
      h.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return h.digest('hex');
}

// Untracked entries are normally files; `ls-files --others` also reports symlinks (which may dangle) and nested repos
// (as `dir/`), neither of which readFile would survive. Tagged so they cannot collide with a plain file digest.
function digestEntry(abs) {
  const st = lstatSync(abs);
  if (st.isSymbolicLink()) return `symlink:${createHash('sha256').update(readlinkSync(abs)).digest('hex')}`;
  if (st.isDirectory()) return 'dir:';
  return sha256OfFile(abs);
}

// The precondition of `asHead`: a real commit (a tree or blob id would also satisfy `<id>^{tree}`) whose tree is HEAD's. Without it
// the result would bind a verify report to bytes it never saw, so refuse here whatever the caller checked before.
function assertSameTree(asHead, o) {
  const treeOf = (rev) => revParse(`${rev}^{tree}`, o); // revParse refuses a rev that starts with `-`
  revParse(`${asHead}^{commit}`, o);
  if (treeOf(asHead) !== treeOf('HEAD')) {
    throw new GitError({ args: ['treeFingerprint', asHead], code: 1, stderr: `${asHead} has a different tree than HEAD; asHead needs an equal-tree commit` });
  }
}

// sha256 of HEAD + every tracked change vs HEAD (staged or not) + every untracked, non-ignored file with its bytes.
// Equal fingerprints mean the same tree; a verify report that carries one is bound to exactly that tree.
// `asHead` (the final gate only): the fingerprint this same working tree would have had with HEAD at that commit instead. It is
// only meaningful when `<asHead>^{tree}` is HEAD's tree: then `git diff <asHead>` and `git diff HEAD` are byte-identical (same
// blobs, same ids), so the result is exactly what verify recorded on a clean checkout of asHead with these untracked files.
export function treeFingerprint(o, { asHead = null } = {}) {
  if (asHead !== null) assertSameTree(asHead, o);
  const hash = createHash('sha256');
  hash.update(asHead ?? headSha(o));
  hash.update('\0');
  // No --text: --binary already makes NUL and `-diff` files exact and compact (the `index` blob ids stay in this diff, so
  // even a lossy decode could not hide a change), where --text would dump whole binaries as raw text. --no-textconv:
  // a configured converter must not decide what counts as a change.
  hash.update(git(['diff', 'HEAD', '--binary', '--no-color', '--no-ext-diff', '--no-textconv'], o));
  hash.update('\0');
  const top = git(['rev-parse', '--show-toplevel'], o).trim();
  // `-- :/` + --full-name: every untracked file in the repo, named from the root, whatever the cwd.
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z', '--full-name', '--', ':/'], o)
    .split('\0')
    .filter(Boolean)
    .sort();
  for (const rel of untracked) {
    hash.update(rel);
    hash.update('\0');
    hash.update(digestEntry(join(top, rel)));
    hash.update('\0');
  }
  return hash.digest('hex');
}
