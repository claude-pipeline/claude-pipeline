// Follow-ups from PR #491: #493 (ranInSubshell and the files guard's rsync name walk read the next command from the flat list, where a substitution's inner command comes first),
// #492 (doubt carried out of a nested text), #505 (a ctx-level "every branch unknown" mark), #506 (a write that may land under .git), #508 (the PATH clause of the inert test).
// Home is /home/u; the git guard's cwd /work/repo is on agent/x, /other on agent/y, /work/repo/sub on agent/s; the filesystem is faked.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';

const HOME = '/home/u';
const FBASE = { home: HOME, env: {}, platform: 'linux', cwd: `${HOME}/proj`, realpath: (p) => p, existsSync: () => false, readText: () => null };
const fileRun = (command) => evaluateBashForFiles(command, FBASE);

// `branches` maps a directory to its on-disk branch; the default is a repository on agent/x at /work/repo.
const gitRun = (command, files = {}, branches = {}) => evaluateGitCommand(command, {
  cwd: '/work/repo',
  home: HOME,
  currentBranch: (dir) => ({ [resolve('/work/repo')]: 'agent/x', [resolve('/other')]: 'agent/y', [resolve('/work/repo/sub')]: 'agent/s', ...branches })[dir] ?? null,
  pushDestination: () => null,
  issueLabels: () => [],
  readText: (p) => files[resolve(p)] ?? null,
  pathExists: (p) => resolve(p) in files,
});
const expect = (decision, command, files, branches) => {
  const v = gitRun(command, files, branches);
  assert.equal(v.decision, decision, `${JSON.stringify(command)} -> ${v.decision}: ${v.reason}`);
};

const BUILD = resolve('/work/repo/build.sh');

describe('#493: a substitution after a cd / assignment that is a pipe stage or background job', () => {
  // the cd ran in a subshell (a pipe stage / a background job): the push is judged in an unknown directory (denied), whether or not a substitution follows
  const NOT = (name, line) => test(`not trusted: ${name}`, () => {
    const v = gitRun(line);
    assert.equal(v.decision, 'deny', line);
    assert.match(v.reason, /cannot tell which directory/);
  });
  NOT('a cd as a pipe stage (the reference)', 'cd /other | tee x.log; git push');
  NOT('a cd as a pipe stage, a substitution in the next command', 'cd /other | tee "$(date +%F).log"; git push');
  NOT('a cd as a background job, a substitution in the next command', 'cd /other & echo "started $(date)"; git push');
  test('reference: a cd that did run in this shell is still judged in the new directory (agent/y: allowed)', () => {
    expect('allow', 'cd /other; echo "now in $(pwd)"; git push');
  });
  test('files guard: a name set as a pipe stage before a substitution is not surely set', () => {
    const r = fileRun('N=-n | cat "$(x)"; rsync -a --delete $N /tmp/x/ ~/');
    assert.equal(r.decision, 'deny', r.reason);
  });
  test('files guard reference: the name set once and used (allowed)', () => {
    const r = fileRun('N=-n; cat "$(x)"; rsync -a --delete $N /tmp/x/ ~/');
    assert.equal(r.decision, 'allow', r.reason);
  });
});

// ---- #492 ----
const S = resolve('/work/repo/s.sh');
const MAIN = { [resolve('/work/repo')]: 'main' }; // the repository really is on main when the line starts
describe('#492: doubt carried out of a nested text', () => {
  const SHAPES = [
    ['(1) a plain exit after a checkout that may fail', 'git checkout agent/missing || exit 1\n'],
    ['(2) a failure group that exits, then another line', 'git checkout agent/missing || { echo no; exit 1; }\nmake\n'],
    ['(3) a checkout that may not run on the last line', '[ -n "$CI" ] && git checkout agent/y\n'],
  ];
  for (const [why, body] of SHAPES) {
    test(`${why}: the caller's push is denied (the real branch is main), bash s.sh`, () => expect('deny', 'bash s.sh; git push', { [S]: body }, MAIN));
    test(`${why}: the same with source`, () => expect('deny', 'source s.sh; git push', { [S]: body }, MAIN));
  }
  // the top level (level 0) keeps today's verdicts: an exit there ends the whole line, a conditional checkout is judged by the next command
  test('level 0: (1) and (2) narrowed by the exit stay allowed, (3) stays denied', () => {
    expect('allow', 'git checkout agent/missing || exit 1\ngit push', {}, MAIN);
    expect('allow', 'git checkout agent/missing || { echo no; exit 1; }\nmake\ngit push', {}, MAIN);
    expect('deny', '[ -n "$CI" ] && git checkout agent/y\ngit push', {}, MAIN);
  });
  test('inside the child itself the exit narrowing still holds (the script pushes the branch it switched to: allowed)', () => {
    expect('allow', 'bash s.sh', { [S]: 'git checkout agent/y || exit 1\ngit push\n' }, MAIN);
  });
  test('a child that switches with certainty hands the caller the branch it switched to (allowed)', () => {
    expect('allow', 'bash s.sh; git push', { [S]: 'git checkout agent/y\nmake\n' }, MAIN);
  });
});

// ---- #505 ----
const CLEAN = resolve('/work/repo/cleanup.sh');
describe('#505: every branch is unknown, also the ones no entry was made for', () => {
  const FILES = { [BUILD]: 'make\ncd dist || { bash /work/repo/cleanup.sh; exit 1; }\n', [CLEAN]: 'git checkout main\n' };
  test('the issue example: the caller is on agent/x (no checkout earlier on the line), the failure group runs a script that switches to main: denied', () => {
    expect('deny', 'bash build.sh; git push', FILES);
  });
  test('the same with a source in the group', () => {
    expect('deny', 'bash build.sh; git push', { ...FILES, [BUILD]: 'make\ncd dist || { source /work/repo/cleanup.sh; exit 1; }\n' });
  });
  test('a git checkout in an unknown directory (after a source) marks every branch unknown, even a directory entered later', () => {
    expect('deny', 'source env.sh; cd /work/repo; git checkout agent/y; cd /other; git push', { [resolve('env.sh')]: 'X=1\n' });
  });
  test('a branch recorded after the mark is known again (a checkout of the directory the push runs in)', () => {
    expect('allow', 'source env.sh; cd /work/repo; git checkout agent/y; git push', { [resolve('env.sh')]: 'X=1\n' });
  });
  test('reference: a build script whose failure group is a plain echo keeps the caller branch (allowed)', () => {
    expect('allow', 'bash build.sh; git push', { [BUILD]: 'make\ncd dist || { echo no; exit 1; }\n' });
  });
});

// ---- #506 ----
describe('#506: a write that may land under a repository\'s .git makes its branch unknown', () => {
  const GIT_HEAD = '/work/repo/.git/HEAD';
  const FIRST = 'git checkout agent/y && '; // (an entry for the directory, as in the R2 rows)
  test('(1) exec 3>.git/HEAD on an earlier line, a group that writes through descriptor 3', () => {
    expect('deny', `${FIRST}bash build.sh; git push`, { [BUILD]: `exec 3>${GIT_HEAD}\ncd dist || { echo 'ref: refs/heads/main' >&3; exit 1; }\n` });
  });
  test('(2) exec >.git/HEAD earlier, then a plain echo in the group', () => {
    expect('deny', `${FIRST}bash build.sh; git push`, { [BUILD]: `exec >${GIT_HEAD}\ncd dist || { echo hi; exit 1; }\n` });
  });
  test('(3) the caller\'s own redirect of the script', () => {
    expect('deny', `${FIRST}bash build.sh > ${GIT_HEAD}; git push`, { [BUILD]: 'make\n' });
  });
  test('(3) with no entry for the directory yet (the caller is on agent/x)', () => {
    expect('deny', `bash build.sh > ${GIT_HEAD}; git push`, { [BUILD]: 'make\n' });
  });
  for (const [why, line] of [
    ['a typed git --output', `git log --output=.git/HEAD; git push`],
    ['a typed git --output, absolute', `git log --output=${GIT_HEAD}; git push`],
    ['a typed redirect', `echo ref > ${GIT_HEAD}; git push`],
    ['a typed append', `echo ref >> .git/HEAD; git push`],
    ['a tee', `echo ref | tee .git/HEAD; git push`],
    ['a cp', `cp main.ref .git/HEAD; git push`],
    ['a mv', `mv main.ref ${GIT_HEAD}; git push`],
    ['an install', `install -m 644 main.ref .git/HEAD; git push`],
    ['an exec redirect', `exec 3>.git/HEAD; git push`],
  ]) test(`typed on the line: ${why}`, () => expect('deny', line));
  for (const [why, line] of [
    ['a log in /tmp', 'git log --oneline > /tmp/log.txt; git push'],
    ['a .gitignore edit', 'echo node_modules >> .gitignore; git push'],
    ['a .github file', 'cp a.yml .github/a.yml; git push'],
    ['a .gitkeep', 'echo > docs/.gitkeep; git push'],
    ['a git --output to /tmp', 'git log --output=/tmp/log.txt; git push'],
    ['a tee to a log', 'npm test | tee out.log; git push'],
  ]) test(`not under .git: ${why} stays allowed`, () => expect('allow', line));
});

// ---- #508 ----
describe('#508: a PATH set before the failure group makes even an echo not inert', () => {
  // (the clause `assignedNames(ctx)` of inertInFailGroup: the PATH is set BEFORE the group, so the group's own words (`echo`, `exit`) are all plain data commands)
  test('the script sets PATH on an earlier line, then a group that only echoes and exits', () => {
    expect('deny', 'git checkout agent/y && bash build.sh; git push', { [BUILD]: 'export PATH=/work/repo/bin:$PATH\ncd dist || { echo no; exit 1; }\n' });
  });
  test('the caller sets PATH on its own line', () => {
    expect('deny', 'export PATH=/work/repo/bin:$PATH; git checkout agent/y && bash build.sh; git push', { [BUILD]: 'cd dist || { echo no; exit 1; }\n' });
  });
  test('control: no PATH set anywhere, the same group is inert (allowed)', () => {
    expect('allow', 'git checkout agent/y && bash build.sh; git push', { [BUILD]: 'cd dist || { echo no; exit 1; }\n' });
  });
});

// ---- the #505 mark must not over-deny everyday sourcing (cwd on agent/x, no checkout earlier on the line) ----
describe('#505 over-denial check: a readable sourced file with no git / .git write in it leaves the branch known', () => {
  const home = (p) => resolve(HOME, p);
  const FILES = {
    [resolve('/work/repo/venv/bin/activate')]: 'export VIRTUAL_ENV=/work/repo/venv\nexport PATH="$VIRTUAL_ENV/bin:$PATH"\n',
    [resolve('/work/repo/env.sh')]: 'export FOO=1\nexport BAR=2\n',
    [home('.nvm/nvm.sh')]: 'export NVM_DIR=/home/u/.nvm\nnvm_ls() { echo x; }\n',
    [BUILD]: 'make\ncd dist || { echo no; exit 1; }\n',
  };
  const OK = (line) => test(`allowed: ${line}`, () => expect('allow', line, FILES));
  // A `source` makes the DIRECTORY unknown (a sourced file may cd and the guard does not follow it): a bare push right after it is refused, as on origin/main (unchanged by the mark, which is about branches).
  const KEPT = (line) => test(`denied as on main (the directory, not the mark): ${line}`, () => {
    const v = gitRun(line, FILES);
    assert.equal(v.decision, 'deny', line);
    assert.doesNotMatch(v.reason, /cannot determine the current branch/, v.reason);
  });
  KEPT('source venv/bin/activate && git push');
  KEPT('. ./env.sh; git push');
  OK('source env.sh; cd /work/repo/sub; git push');
  test('a sourced file that is never read (missing) marks every branch unknown: a directory entered afterwards is denied', () => {
    expect('deny', 'source nothere.sh; cd /work/repo/sub; git push', FILES);
  });
  OK('bash build.sh; git push');
  test('but a sourced file that does switch the branch still denies', () => {
    expect('deny', 'source env.sh; git push', { [resolve('/work/repo/env.sh')]: 'git checkout main\n' });
  });
});

// Over-denial guard: ordinary work stays allowed after every change above.
describe('ordinary work stays allowed', () => {
  const OK = (name, line, files) => test(`allowed: ${name}`, () => expect('allow', line, files));
  OK('a new agent branch, then its push', 'git checkout -b agent/x && git push -u origin agent/x');
  OK('a build script that only runs make / npm', 'bash build.sh; git push', { [BUILD]: 'make\nnpm run build\n' });
  OK('a test run with an output file', 'npm test > out.log; git push');
  OK('a log written to a temp file', 'git log --oneline > /tmp/log.txt');
  OK('a log written to a temp file, then the push', 'git log --oneline > /tmp/log.txt; git push');
  OK('a build in a sub directory, then the push', 'cd sub && make; git push');
  OK('a tee into the work tree, then the push', 'npm test | tee out.log; git push');
  OK('a copy into the work tree, then the push', 'cp a.txt b.txt; git push');
});
