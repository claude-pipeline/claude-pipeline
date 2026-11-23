// Follow-ups from PR #478: #483 (the rsync dry-run name walk re-walks every repeated dependency: exponential work, no deadline poll), #481 (the git guard's flat `cd X || echo ...; git push`
// read the next command from the flat list, where a substitution's inner command comes first), #482 (a failure group that ends the text is never restored).
// Home is /home/u and the cwd is /home/u/proj for the files guard; the filesystem is faked. Protected paths are built from parts so this file does not spell them either.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
import { cpuTimed } from './helpers/timing.mjs';

const HOME = '/home/u';
const BASE = { home: HOME, env: {}, platform: 'linux', cwd: `${HOME}/proj`, realpath: (p) => p, existsSync: () => false, readText: () => null };
const run = (command, extra = {}) => evaluateBashForFiles(command, { ...BASE, ...extra });

// ---- #483 ----
// N0=; then `levels` assignments, each of `width` concatenated ${N<previous>} references (every value stays empty, so no size limit stops it), then a dry-run rsync that uses the last name.
const chain = (levels, width) => {
  const parts = ['N0='];
  for (let i = 1; i <= levels; i++) parts.push(`N${i}=${`\${N${i - 1}}`.repeat(width)}`);
  return `${parts.join('; ')}; rsync -a --delete -n $N${levels} /tmp/x/ ~/`;
};
const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
// Generous CI headroom as in guard-hidden-assignments: the memoised walk takes a few ms; the old one took 6 s at 20^5 visits and never finished at 20^8.
const EARLY_MS = process.env.CI ? 4500 : 3000;

describe('#483: the rsync dry-run walk visits each name once and polls the deadline', () => {
  test('eight levels of twenty repeated references (the issue shape) are answered at once and denied (as the same shape with width 2 always was)', () => {
    const { r, ms } = cpuTimed(() => run(chain(8, 20), { now: cpu }));
    assert.ok(ms < EARLY_MS, `took ${Math.round(ms)} ms of CPU`);
    assert.equal(r.decision, 'deny', r.reason);
    assert.doesNotMatch(r.reason, /took too long/, r.reason); // (the answer of the walk itself, not the deadline)
  });
  test('five levels of twenty repeated references: answered at once, allowed (every name is given once, before the rsync, with an empty value)', () => {
    const { r, ms } = cpuTimed(() => run(chain(5, 20), { now: cpu }));
    assert.ok(ms < EARLY_MS / 3, `took ${Math.round(ms)} ms of CPU`); // (before the fix: 20^5 visits, past the 5 s deadline)
    assert.equal(r.decision, 'allow', r.reason);
  });
  test('a deadline in the walk fails closed (deny), never open', () => {
    // a clock that reads "expired" whenever it is asked from inside the name walk: the walk must ask
    const now = () => (/nameSure/i.test(new Error().stack ?? '') ? Number.MAX_SAFE_INTEGER : 0);
    const r = run(chain(3, 2), { now });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /took too long/, r.reason);
  });
  describe('the memo gives the verdict the plain walk gave on ordinary lines with repeated names', () => {
    const decide = (decision, name, line) => test(`${decision}: ${name}`, () => {
      const r = run(line);
      assert.equal(r.decision, decision, `${JSON.stringify(line)} -> ${r.decision}: ${r.reason}`);
    });
    decide('allow', 'one name used twice', 'N=-n; rsync -a --delete $N $N /tmp/x/ ~/');
    decide('allow', 'a diamond of sure names', 'A=-n; B="$A $A"; C="$A $B"; rsync -a --delete $C $B /tmp/x/ ~/');
    decide('allow', 'a name built from a name', "A=-n; B=$A; rsync -a --delete $B /tmp/x/ ~/");
    decide('deny', 'a repeated name that may not have run', '[ -n "$DRY" ] && N=-n; rsync -a --delete $N $N /tmp/x/ ~/');
    decide('deny', 'a diamond with one name set conditionally', '[ -n "$DRY" ] && A=-n; B="$A $A"; C="$B $A"; rsync -a --delete $C /tmp/x/ ~/');
    decide('deny', 'a repeated name assigned twice', 'N=-n; N=; rsync -a --delete $N $N /tmp/x/ ~/');
  });
});

// ---- #481 / #482: the git guard ----
// cwd /work/repo is on agent/x, /other on agent/y; the files in `files` are fake script files.
const gitRun = (command, files = {}) => evaluateGitCommand(command, {
  cwd: '/work/repo',
  home: HOME,
  currentBranch: (dir) => ({ [resolve('/work/repo')]: 'agent/x', [resolve('/other')]: 'agent/y' })[dir] ?? null,
  pushDestination: () => null,
  issueLabels: () => [],
  readText: (p) => files[resolve(p)] ?? null,
  pathExists: (p) => resolve(p) in files,
});

describe('#481: a substitution in the command after the cd does not hide the || from the git guard', () => {
  const NOT = (name, line) => test(`not narrowed: ${name}`, () => {
    const v = gitRun(line);
    assert.equal(v.decision, 'deny', line);
    assert.match(v.reason, /cannot tell which directory/);
  });
  const NARROWED = (name, line) => test(`narrowed: ${name}`, () => assert.equal(gitRun(line).decision, 'allow', line));
  NOT('the plain form (the reference)', 'cd /other || echo "failed in the old dir"; git push');
  NOT('the same with a substitution in the echo', 'cd /other || echo "failed in $(pwd)"; git push');
  NOT('a substitution in a backtick form', 'cd /other || echo "failed in `pwd`"; git push');
  NARROWED('cd || exit, then a command holding a substitution, then the push', 'cd /other || exit 1; echo "now in $(pwd)"; git push');
  NARROWED('the group form with a substitution inside (existing reading)', 'cd /other || { echo "no dir $(pwd)" >&2; exit 1; }; git push');
});

describe('#482: a failure group that ends the text is restored when the text ends', () => {
  const BUILD = resolve('/work/repo/build.sh');
  test('the caller keeps its branch after a script that ends with `cd dist || { ...; exit 1; }`', () => {
    const v = gitRun('git checkout agent/y || exit 1; bash build.sh; git push', { [BUILD]: 'make\ncd dist || { echo no; exit 1; }\n' });
    assert.equal(v.decision, 'allow', v.reason);
  });
  test('the script alone still judges its own text', () => {
    assert.equal(gitRun('bash build.sh', { [BUILD]: 'cd dist || { echo no; exit 1; }\n' }).decision, 'allow');
  });
  test('a group in the middle of the text was already restored (the reference)', () => {
    const v = gitRun('git checkout agent/y || exit 1; bash build.sh; git push', { [BUILD]: 'cd dist || { echo no; exit 1; }\nmake\n' });
    assert.equal(v.decision, 'allow', v.reason);
  });
  // #491 R1: the end-of-text restore only when the group was opened by a directory change and nothing in it changes git state (the caller shares ctx.branches: origin/main left the names forgotten)
  test('R1-B1: a checkout that may fail, then a group that exits: the caller\'s push is not judged on the optimistic branch (denied, as on main)', () => {
    const v = gitRun('bash build.sh; git push', { [BUILD]: 'git checkout agent/missing || { echo no; exit 1; }\n' });
    assert.equal(v.decision, 'deny', v.reason);
  });
  test('R1-F1: a git checkout inside the group (its directory unknown there) is not hidden by the restore (denied, as on main)', () => {
    const v = gitRun('git checkout agent/y || exit 1; bash build.sh; git push', { [BUILD]: 'cd dist || { git checkout main; exit 1; }\n' });
    assert.equal(v.decision, 'deny', v.reason);
  });
  // #491 R2: the restore is an allow-list (a directory change opened the group and every command in it is inert), not a deny-list of literal `git <state word>`
  const CLEAN = resolve('/work/repo/cleanup.sh');
  test('R2-F1: a script the group runs that switches the branch (`bash /abs/cleanup.sh`) is not hidden by the restore (denied, as on main)', () => {
    const v = gitRun('git checkout agent/y || exit 1; bash build.sh; git push', { [BUILD]: 'make\ncd dist || { bash /work/repo/cleanup.sh; exit 1; }\n', [CLEAN]: 'git checkout main\n' });
    assert.equal(v.decision, 'deny', v.reason);
  });
  test('R2-F1: the same with `source /abs/cleanup.sh` (denied, as on main)', () => {
    const v = gitRun('git checkout agent/y || exit 1; bash build.sh; git push', { [BUILD]: 'make\ncd dist || { source /work/repo/cleanup.sh; exit 1; }\n', [CLEAN]: 'git checkout main\n' });
    assert.equal(v.decision, 'deny', v.reason);
  });
  test('R2-F1: a nested `cd /work/repo && git checkout main` in a script the group runs (denied, as on main)', () => {
    const v = gitRun('git checkout agent/y || exit 1; bash build.sh; git push', { [BUILD]: 'make\ncd dist || { bash /work/repo/cleanup.sh; exit 1; }\n', [CLEAN]: 'cd /work/repo && git checkout main\n' });
    assert.equal(v.decision, 'deny', v.reason);
  });
  test('R2-B1: a `git -C /work/repo checkout agent/y` in the group does not leave the recorded agent/y to the caller (push not allowed)', () => {
    const v = gitRun('bash build.sh; git push', { [BUILD]: 'git checkout main || { echo no; git -C /work/repo checkout agent/y; exit 1; }\n' });
    assert.equal(v.decision, 'deny', v.reason);
  });
  test('the #482 case with a data command in the group (echo, exit) is still restored (allowed)', () => {
    const v = gitRun('git checkout agent/y || exit 1; bash build.sh; git push', { [BUILD]: 'make\ncd dist || { echo no; exit 1; }\n' });
    assert.equal(v.decision, 'allow', v.reason);
  });
  // (a git command in the group, read-only looking or not, is not inert any more: the push is denied, exactly as on main -- see the R4 rows below)
  test('R4: a `git status` in the group is not inert (denied, as on main)', () => {
    const v = gitRun('git checkout agent/y || exit 1; bash build.sh; git push', { [BUILD]: 'make\ncd dist || { echo no; git status; exit 1; }\n' });
    assert.equal(v.decision, 'deny', v.reason);
  });
  // #491 R3: the inert test is an allow-list of the BARE builtin word (or a system-bin path) only: no git command is inert (see the R4 rows)
  const LAST = (x) => gitRun('git checkout agent/y || exit 1; bash build.sh; git push', { [BUILD]: `make\ncd dist || { ${x}; exit 1; }\n` });
  for (const [why, x] of [
    ['R3-B1: an echo run by an absolute path (any program)', '/work/repo/echo hi'],
    ['R3-F1: a git run by a relative path (any program)', './git status'],
    ['R3-F1: an echo a package runner resolves from node_modules/.bin', 'npx echo hi'],
    ['R3-F1: a git a package runner resolves', 'npm exec git status'],
    ['R3-F2: an alias on disk or on the line (`git co main`)', 'git config alias.co "checkout"; git co main'],
    ['R3-F2: git submodule foreach runs a command', "git submodule foreach 'git -C /work/repo checkout main'"],
    ['R3-F2: git bisect moves HEAD', 'git bisect reset'],
    ['R3-F2: a config handed in through the prefix environment', "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.st GIT_CONFIG_VALUE_0='!git checkout main' git st"],
    ['R3: an output redirection of an echo writes a file (.git/HEAD)', 'echo x > /work/repo/.git/HEAD'],
    ['R3: an appended one', 'echo x >> /work/repo/.git/HEAD'],
  ]) {
    test(`${why} is not inert: the push is denied, as on main`, () => {
      const v = LAST(x);
      assert.equal(v.decision, 'deny', `${x}: ${v.reason}`);
    });
  }
  test('R3-F2: an alias defined on disk (ctx.gitAliases) is not inert', () => {
    const v = gitRun('git config alias.st "checkout main" && git checkout agent/y || exit 1; bash build.sh; git push', { [BUILD]: 'make\ncd dist || { git st; exit 1; }\n' });
    assert.equal(v.decision, 'deny', v.reason);
  });
  // #491 R4: the git half of the allow-list is gone. A read-only-looking git command can still run a program or write HEAD (`git log --output=.git/HEAD`, a PATH change, a
  // package-script bin dir, letter case ...), so ANY git command in a text-ending group leaves the names forgotten, exactly as on main (main denies every one of these too).
  for (const x of ['git status', 'git log -1', 'git diff', 'git rev-parse HEAD', 'git branch --show-current', '/usr/bin/git status', 'git -C /work/repo status', 'echo no; git status', 'git log --output=/work/repo/.git/HEAD']) {
    test(`R4: ${x} is not inert (denied, as on main)`, () => {
      const v = LAST(x);
      assert.equal(v.decision, 'deny', `${x}: ${v.reason}`);
    });
  }
  // the data half: a PATH the group can change, or a redirect target that is not a descriptor duplicate, makes even an echo not inert
  for (const x of ['PATH=/work/repo/bin echo hi', 'export PATH=/work/repo/bin:$PATH; echo hi', 'echo hi >&/work/repo/x', 'echo hi >& /work/repo/x', 'echo hi 2>&/work/repo/x']) {
    test(`R4: ${x} is not inert (denied)`, () => {
      const v = LAST(x);
      assert.equal(v.decision, 'deny', `${x}: ${v.reason}`);
    });
  }
  test('R4-F1: an earlier line of the group that sets PATH, then an echo on a later line, is not inert', () => {
    const v = gitRun('git checkout agent/y || exit 1; bash build.sh; git push', { [BUILD]: 'make\ncd dist || {\n  export PATH=/work/repo/bin:$PATH\n  echo hi\n  exit 1\n}\n' });
    assert.equal(v.decision, 'deny', v.reason);
  });
  test('R4-F1: an echo in a package script (the manager puts node_modules/.bin on its PATH) is not inert', () => {
    const files = { [resolve('/work/repo/package.json')]: JSON.stringify({ name: 'x', version: '1.0.0', scripts: { build: 'make\ncd dist || { echo no; exit 1; }' } }) };
    const v = gitRun('git checkout agent/y || exit 1; npm run build; git push', files);
    assert.equal(v.decision, 'deny', v.reason);
  });
  for (const x of ['echo no >&2', 'echo no 2>&1', 'echo no >&-', '/bin/echo no', 'true', 'printf x']) {
    test(`R3: ${x} stays inert (allowed)`, () => {
      const v = LAST(x);
      assert.equal(v.decision, 'allow', `${x}: ${v.reason}`);
    });
  }
});
