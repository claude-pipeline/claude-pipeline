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
// `links` is a set of paths that are directory entries without existing (dangling symlinks): lexists sees them, pathExists does not.
const gitRun = (command, files = {}, branches = {}, links = new Set()) => evaluateGitCommand(command, {
  cwd: '/work/repo',
  home: HOME,
  currentBranch: (dir) => ({ [resolve('/work/repo')]: 'agent/x', [resolve('/other')]: 'agent/y', [resolve('/work/repo/sub')]: 'agent/s', ...branches })[dir] ?? null,
  pushDestination: () => null,
  issueLabels: () => [],
  readText: (p) => files[resolve(p)] ?? null,
  pathExists: (p) => resolve(p) in files,
  lexists: (p) => resolve(p) in files || links.has(resolve(p)),
});
const expect = (decision, command, files, branches, links) => {
  const v = gitRun(command, files, branches, links);
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
  // (PR #362, the owner's rule "a script's state change never carries over to its caller": what the child switched is unknown to the caller, even a switch that is certain inside it; main allowed it)
  test('a child that switches with certainty does not hand the caller the branch it switched to (denied: never carry over)', () => {
    expect('deny', 'bash s.sh; git push', { [S]: 'git checkout agent/y\nmake\n' }, MAIN);
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
    expect('deny', 'source env.sh; git checkout agent/y; cd /other; git push', { [resolve('/work/repo/env.sh')]: 'X=1\n' });
  });
  test('a branch recorded after the mark is known again (a checkout of the directory the push runs in)', () => {
    expect('allow', 'source env.sh; cd /work/repo; git checkout agent/y; git push', { [resolve('/work/repo/env.sh')]: 'X=1\n' });
  });
  test('reference: a build script whose failure group is a plain echo keeps the caller branch (allowed)', () => {
    expect('allow', 'bash build.sh; git push', { [BUILD]: 'make\ncd dist || { echo no; exit 1; }\n' });
  });
});

describe('#554: a mark set inside a failure group survives when the nested text goes on after the group', () => {
  // production failure: `bash build.sh; git push` on agent/x was allowed although the group's script switched the repository to main (the next line of the text restored the mark to false)
  // (a plain trailing line: the issue's `npm run build` is denied for a package-script reason of its own)
  const GROUP = 'cd dist || { bash /work/repo/cleanup.sh; exit 1; }\n';
  const FILES = { [CLEAN]: 'git checkout main\n' };
  test('a line after the group in the script (the #505 fixture plus a trailing line): denied', () => {
    expect('deny', 'bash build.sh; git push', { ...FILES, [BUILD]: `make\n${GROUP}echo built\n` });
  });
  test('#506 shape: a failure group that writes .git/HEAD, then any line: denied', () => {
    expect('deny', 'bash build.sh; git push', { [BUILD]: "cd dist || { echo 'ref: refs/heads/main' > /work/repo/.git/HEAD; exit 1; }\nmake\n" });
  });
  test('reference: an inert group followed by a line keeps the caller branch (allowed)', () => {
    expect('allow', 'bash build.sh; git push', { [BUILD]: 'make\ncd dist || { echo no; exit 1; }\necho built\n' });
  });
});

// ---- #609 (+ pins #607 #608) ----
describe('#609: a literal, unwrapped exit of a failure group ends the text, so the commands after it are judged with the exact branch', () => {
  // production failure: `cd /work/repo || { echo missing >> err.log; exit 1; }` then `git push` in the same script was refused ("cannot determine the current branch") although the push is never reached when the group ran
  const GROUP = (exit) => `cd /work/repo || { echo missing >> err.log; ${exit}; }\n`;
  const V1 = `${GROUP('exit 1')}git push\n`;
  const V2 = `cd /work/repo || { bash /work/repo/fix.sh; exit 1; }\ngit push\n`;
  const FIX = { '/work/repo/fix.sh': 'git checkout main\n' };
  const verdict = (command, files) => gitRun(command, files);
  for (const [vname, script, extra] of [['V1 (echo in the group)', V1, {}], ['V2 (the group runs a helper that switches branch)', V2, FIX]]) {
    for (const run of ['bash s.sh', 'source s.sh']) {
      // (a SOURCED text runs in the caller's shell: a function named exit defined by the caller would make the written exit not leave it, which the walk cannot see, so only a child-run text defers)
      test(`${vname}: \`${run}\` with the push INSIDE the script after a literal exit is ${run === 'bash s.sh' ? 'allowed' : 'still denied (sourced)'}`, () => {
        expect(run === 'bash s.sh' ? 'allow' : 'deny', run, { ...extra, '/work/repo/s.sh': script });
      });
      test(`${vname}: \`${run}; git -C /work/repo push\` stays denied, on the CALLER's push`, () => {
        const v = verdict(`${run}; git -C /work/repo push`, { ...extra, '/work/repo/s.sh': script });
        assert.equal(v.decision, 'deny', v.reason);
        assert.match(v.reason, /cannot determine the current branch/);
        // (a sourced script is denied inside itself, as before this change: only the child-run one reaches the caller's push)
        if (run === 'bash s.sh') assert.doesNotMatch(v.reason, /the script s\.sh/);
      });
    }
  }
  // (an exit that is not verifiably the shell's own keeps today's immediate uncertainty: a wrapper's child-local exit, an external time, a quoted word)
  for (const exit of ['/usr/bin/time exit 1', 'time exit 1', 'nohup exit 1', 'env exit 1', 'command exit 1']) {
    test(`\`${exit}\` in the group keeps the push inside the script denied`, () => {
      const v = verdict('bash s.sh', { '/work/repo/s.sh': `${GROUP(exit)}git push\n` });
      assert.equal(v.decision, 'deny', v.reason);
      assert.match(v.reason, /the script s\.sh would run a blocked command/);
    });
  }
  test('a function named exit defined by the caller: sourcing the script is denied (the written exit may not leave the shell; the reason a sourced text does not defer)', () => {
    expect('deny', 'exit() { :; }; source /work/repo/s.sh', { '/work/repo/s.sh': V1 });
  });
  // R1-B1 / R1-F1: the written exit may not be the shell's real exit: the caller's function, an exported one, an eval (this shell), a startup file, or a sourced helper redefines it; the cd failing then switches to main and the push runs there
  const S = V2;
  const REDEF = { '/work/repo/s.sh': S, ...FIX };
  const SUB = { '/work/repo/s.sh': 'cd /work/repo/sub || { bash /work/repo/fix.sh; exit 1; }\ngit push\n', ...FIX };
  for (const [why, line, files] of [
    ['eval-fed text with a caller function exit', 'exit() { :; }; eval "$(cat /work/repo/s.sh)"', REDEF],
    ['an exported function exit into the child shell', 'exit() { :; }; export -f exit; bash /work/repo/s.sh', REDEF],
    ['BASH_ENV startup file that defines exit', 'BASH_ENV=/work/repo/rc.sh bash /work/repo/s.sh', { ...REDEF, '/work/repo/rc.sh': 'exit() { :; }\n' }],
    ['a sourced helper inside the group that defines exit', 'bash /work/repo/s.sh', { '/work/repo/s.sh': 'cd /work/repo/sub || { source /work/repo/h.sh; exit 1; }\ngit push\n', '/work/repo/h.sh': 'exit() { :; }\ngit checkout main\n' }],
    // R2-F1: an implicit home startup file (zsh reads ~/.zshenv, bash -l ~/.bash_profile) is judged on a copy of the state; the mark that exit may be redefined must still reach the script
    ['a home .zshenv that defines exit (zsh reads it implicitly)', 'zsh /work/repo/s.sh', { ...SUB, [HOME + '/.zshenv']: 'exit() { :; }\n' }],
    ['a home .zshenv that aliases exit', 'zsh /work/repo/s.sh', { ...SUB, [HOME + '/.zshenv']: 'alias exit=true\n' }],
    ['a home .bash_profile that defines exit (bash -l reads it implicitly)', 'bash -l /work/repo/s.sh', { ...SUB, [HOME + '/.bash_profile']: 'exit() { :; }\n' }],
    ['a plain eval of the script (this shell, so a function of the caller may stand for exit)', 'eval "$(cat /work/repo/s.sh)"', REDEF],
  ]) {
    test(`${why}: denied`, () => {
      expect('deny', line, files);
    });
  }
  test('intended tightening: a git switch after the group no longer re-establishes a known branch for the caller', () => {
    const v = verdict('bash s.sh; git -C /work/repo push', { '/work/repo/s.sh': `${GROUP('exit 1')}git switch agent/x\n` });
    assert.equal(v.decision, 'deny', v.reason);
    assert.match(v.reason, /cannot determine the current branch/);
  });
  // #607 does not reproduce (no failure group is recorded inside a subshell): pinned so a later change cannot open it
  test('#607 pin: a failure group in a subshell whose helper switches branch keeps the caller push denied', () => {
    const v = verdict('(cd dist || { bash /work/repo/cleanup.sh; exit 1; }; make); git push', { '/work/repo/cleanup.sh': 'git checkout main\n' });
    assert.equal(v.decision, 'deny', v.reason);
    assert.match(v.reason, /cannot determine the current branch/);
  });
  // #608 does not need a source change (the candidate walk already covers a literal PATH prefix); the three rows fail if PATH-setting lines are excluded or `sourceGone` hides the walked case
  test('#608 pin: a dynamic PATH prefix on source keeps the push denied', () => {
    expect('deny', 'PATH="$(tooldir):$PATH" source env.sh; git -C /work/repo push', {});
  });
  test('#608 pin: a literal PATH prefix whose env.sh switches branch is walked and denied; a harmless one is allowed', () => {
    const v = verdict('PATH="/opt/tools:$PATH" source env.sh; git -C /work/repo push', { '/opt/tools/env.sh': 'git checkout main\n' });
    assert.equal(v.decision, 'deny', v.reason);
    assert.match(v.reason, /cannot determine the current branch/);
    expect('allow', 'PATH="/opt/tools:$PATH" source env.sh; git -C /work/repo push', { '/opt/tools/env.sh': 'echo hi\n' });
  });
  test('#608 pin: the everyday `export PATH=...; [ -f .env.local ] && source .env.local; git push` stays allowed', () => {
    expect('allow', 'export PATH="$HOME/bin:$PATH"; [ -f .env.local ] && source .env.local; git -C /work/repo push', {});
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

// R1-B3: only a write that can move a branch (HEAD, a linked worktree's HEAD, config, refs, packed-refs, or the .git directory itself) makes the branches unknown
describe('R1-B3: a write below .git that cannot move a branch stays allowed', () => {
  for (const [why, line] of [
    ['an exclude file', 'echo dist/ >> .git/info/exclude; git push'],
    ['a hook copy', 'cp pre-commit.sample .git/hooks/pre-commit; git push'],
    ['a commit message file', 'echo msg > .git/COMMIT_EDITMSG; git push'],
  ]) test(`allowed: ${why}`, () => expect('allow', line));
  for (const [why, line] of [
    ['packed-refs', 'echo x > .git/packed-refs; git push'],
    ['a linked worktree HEAD', 'echo ref > .git/worktrees/w/HEAD; git push'],
    ['config', 'echo x >> .git/config; git push'],
    ['a ref', 'echo abc > .git/refs/heads/agent/x; git push'],
    ['a copy onto the .git directory', 'cp -r other/.git .git; git push'],
    ['rsync onto .git/', 'rsync -a other/.git/ .git/; git push'],
    ['tar into .git', 'tar -xf a.tar -C .git; git push'],
  ]) test(`denied: ${why}`, () => expect('deny', line));
});

// #556: production failure: `cp backup/HEAD .git/worktrees/w/; git -C /work/w push` switched the linked worktree to main (the copy lands on HEAD) and was allowed, because only a destination spelled `.../HEAD` was matched;
// a spelling of the same file that the text does not show (`.git//HEAD`, `.git/./HEAD`, `.git/refs/../HEAD`, and on a case-insensitive filesystem `.git/head`) was allowed too
describe('#556: a directory destination under .git/worktrees, and a differently spelled HEAD, make the branches unknown', () => {
  const CI = process.platform === 'win32' || process.platform === 'darwin'; // (the guard matches case-insensitively only where the filesystem is)
  for (const [why, line] of [
    ['a copy into a linked worktree directory (trailing slash)', 'cp backup/HEAD .git/worktrees/w/; git push'],
    ['a copy into a linked worktree directory', 'cp backup/HEAD .git/worktrees/w; git push'],
    ['tar into a linked worktree directory', 'tar -xf a.tar -C .git/worktrees/w; git push'],
    ['a doubled slash', 'echo ref > .git//HEAD; git push'],
    ['a dot segment', 'echo ref > .git/./HEAD; git push'],
    ['a dot-dot segment', 'echo ref > .git/refs/../HEAD; git push'],
    ['a linked worktree HEAD with a dot-dot', 'echo ref > .git/worktrees/w/x/../HEAD; git push'],
  ]) test(`denied: ${why}`, () => expect('deny', line));
  test(`${CI ? 'denied' : 'allowed'}: a lower-case .git/head (${CI ? 'case-insensitive' : 'case-sensitive'} filesystem)`, () => expect(CI ? 'deny' : 'allow', 'echo ref > .git/head; git push'));
  for (const [why, line] of [
    ['a file in a worktree directory that cannot move a branch is not a directory destination of a copy', 'echo x > .git/worktrees/w/gitdir; git push'],
    ['a dot segment elsewhere', 'echo x > .git/./info/exclude; git push'],
  ]) test(`allowed: ${why}`, () => expect('allow', line));
});

// R1-B2: a function / trap / alias / shopt in a walked script forgets the names already recorded, but marks no unrelated branch unknown
describe('R1-B2: a state hazard in a child script or sourced file leaves the caller\'s on-disk branch known', () => {
  const FN = { [resolve('/work/repo/nvm.sh')]: 'nvm() { echo x; }\nnvm\n', [BUILD]: 'build() { make; }\nbuild\n' };
  test('a sourced file that defines a function, then a push from another directory', () => expect('allow', 'source ./nvm.sh; cd /work/repo/sub; git push', FN));
  test('a build script that defines a function, then the push', () => expect('allow', 'bash build.sh; git push', FN));
  for (const [why, body] of [['a trap', 'trap \'rm -f x\' EXIT\nmake\n'], ['an alias', 'alias ll=\'ls -l\'\nmake\n'], ['a shopt', 'shopt -s nullglob\nmake\n']]) {
    test(`a build script with ${why}, then the push`, () => expect('allow', 'bash build.sh; git push', { [BUILD]: body }));
  }
  test('control: a function that switches the branch still denies', () => expect('deny', 'bash build.sh; git push', { [BUILD]: 'build() { git checkout main; }\nbuild\n' }));
});

// R1-F1: a git READ (symbolic-ref --short, config --get, branch -r, worktree list) raises no branch doubt, in the line or in a child script; only a command that can move a branch does
describe('R1-F1: a git read leaves the on-disk branch known (cwd on agent/x, no checkout on the line)', () => {
  for (const line of [
    'git push origin "$(git symbolic-ref --short HEAD)"',
    'git push origin HEAD:$(git symbolic-ref --short HEAD)',
    'URL=$(git config --get remote.origin.url); git push',
    'echo "$(git config user.name)"; git push -u origin HEAD',
    'N=$(git branch -r | wc -l); git push',
    'W=$(git worktree list | head -1); git push',
  ]) test(`allowed: ${line}`, () => expect('allow', line));
  for (const body of [
    'git config --get user.name || git config user.name ci\nmake\n',
    'git branch | grep x\nmake\n',
    'V=$(git config --get x)\nmake\n',
  ]) test(`allowed: bash build.sh holding ${JSON.stringify(body)}`, () => expect('allow', 'bash build.sh; git push', { [BUILD]: body }));
  // the moves still count
  for (const line of [
    'N=$(git checkout main); git push',
    'echo "$(git symbolic-ref HEAD refs/heads/main)"; git push',
    'X=$(git branch -m main); git push',
    'X=$(git worktree add ../w main); cd ../w; git push',
  ]) test(`denied: ${line}`, () => expect('deny', line));
  test('denied: a child script that switches the branch in a substitution', () => expect('deny', 'bash build.sh; git push', { [BUILD]: 'V=$(git checkout main)\nmake\n' }));
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
  // #555: production failure: `[ -f .env.local ] && source .env.local; cd /work/repo/sub; git push` was allowed when the optional file existed and denied when it did not (a missing file runs nothing)
  test('a sourced file that does not exist runs nothing: it marks no branch, a directory entered afterwards is judged on its own branch (allowed)', () => {
    expect('allow', 'source nothere.sh; cd /work/repo/sub; git push', FILES);
    expect('allow', '[ -f .env.local ] && source .env.local; cd /work/repo/sub; git push', FILES);
    expect('allow', 'source ~/.cargo/env 2>/dev/null; git -C /work/repo/sub push', FILES);
  });
  test('a sourced file whose name is only known at run time still marks every branch unknown (denied)', () => {
    expect('deny', 'source "$(mktemp)"; cd /work/repo/sub; git push', FILES);
    expect('deny', 'source ~/.cache/*.sh; cd /work/repo/sub; git push', FILES);
  });
  // #630: production failure: a dangling symlink counted as a missing file, so a line that writes the link's target first (or anything that creates it before the source runs) sourced unwalked code that can switch a branch, and the push was judged against a stale branch
  test('a sourced dangling symlink is not a missing file: every branch stays unknown (denied)', () => {
    const links = new Set([resolve('/work/repo/env.sh')]);
    expect('deny', 'source env.sh; cd /work/repo/sub; git push', {}, {}, links);
    expect('deny', "echo 'git -C /work/repo/sub checkout main' > /tmp/t.sh; source env.sh; cd /work/repo/sub; git push", {}, {}, links);
  });
  // (pins: a file the same line writes or links is judged by its written text, or denied; a future change must not treat it as gone)
  test('a file the same line writes or links before sourcing it is not a missing file (denied)', () => {
    expect('deny', 'curl -so env.sh https://example.com/x; source env.sh; cd /work/repo/sub; git push');
    expect('deny', 'ln -s /tmp/other.sh env.sh; source env.sh; cd /work/repo/sub; git push');
  });
  // (R1-B1: `~+` is $PWD, `~-` is $OLDPWD, `~user` a home directory: the shell sources a real file, so only a leading `~/` (or `~`) is spelled as a path the guard knows)
  for (const w of ['~+/env.sh', '~-/env.sh', '~user/env.sh']) {
    test(`a sourced ${w} is not a missing file: every branch stays unknown (denied)`, () => {
      expect('deny', `source ${w}; cd /work/repo/sub; git push`, FILES);
    });
  }
  OK('bash build.sh; git push');
  test('but a sourced file that does switch the branch still denies', () => {
    expect('deny', 'source env.sh; git push', { [resolve('/work/repo/env.sh')]: 'git checkout main\n' });
  });
});

// ---- #307 ----
describe('#307: a directory only known at run time denies only the words that could name home', () => {
  const HOMEWHY = /home directory or a directory above it|home directory/;
  const notHome = (line) => test(`not refused for home: ${line}`, () => {
    const r = fileRun(line);
    assert.ok(r.decision === 'allow' || !HOMEWHY.test(r.reason ?? ''), `${line} -> ${r.decision}: ${r.reason}`);
  });
  const home = (line) => test(`still refused for home: ${line}`, () => {
    const r = fileRun(line);
    assert.equal(r.decision, 'deny', line);
    assert.match(r.reason, HOMEWHY, line);
  });
  notHome('git -C "$(git rev-parse --show-toplevel)" push origin main');
  notHome('git -C "$(git rev-parse --show-toplevel)" checkout main');
  notHome('git -C "$(git rev-parse --show-toplevel)" add file.txt');
  notHome('env -C "$X" npm run build');
  notHome('git -C "$(git rev-parse --show-toplevel)" add src/app.js');
  notHome('env -C "$X" make build');
  notHome('env -C "$X" rm -rf dist');
  // (a git write command is no home hit on its own; the env wrapper's commands are)
  home('env -C "$X" rm -rf .');
  home('env -C "$X" rm -rf ..');
  home('env -C "$X" rm -rf ../x');
  home('env -C "$X" rm -rf *');
  home('env -C "$X" rm -rf u');
  home('env -C "$X" rm -rf home/u');
  home('env -C "$X" rm -rf "$Y"');
  // R1-B1: a symlinked home (/home/u -> /data/alice): a word that is a segment of the RESOLVED path names home from a run-time directory too
  test('symlinked home: a relative word equal to a segment of the resolved home is refused', () => {
    const real = (p) => (p === HOME ? '/data/alice' : p.startsWith(HOME + '/') ? '/data/alice' + p.slice(HOME.length) : p);
    const r = evaluateBashForFiles('env -C "$BASE" rm -rf alice', { ...FBASE, realpath: real, existsSync: (p) => p === HOME });
    assert.equal(r.decision, 'deny', r.reason);
    assert.match(r.reason, HOMEWHY);
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

// #558: production failure: a -C / --git-dir / --work-tree value spelled like a git subcommand (`git -C worktree checkout main`) was read as that subcommand, so the checkout inside the parentheses raised
// no branch doubt and the push after it was judged on the branch the directory had on disk
describe('#558: movesBranch takes the subcommand, not the first mover word (a global option value is skipped)', () => {
  for (const word of ['worktree', 'branch', 'rebase', 'symbolic-ref']) {
    test(`denied: (git -C ${word} checkout main); a push after it`, () => expect('deny', `(git -C ${word} checkout main); git push`));
  }
  test('denied: --git-dir with a value spelled like a subcommand', () => expect('deny', '(git --git-dir branch checkout main); git push'));
  test('reference: the same checkout without the odd -C value was already denied', () => expect('deny', '(git -C sub checkout main); git push'));
});

// #557: production failure: a child script ending with a git READ and an exit (`git config --get user.email >/dev/null || exit 1`) opened a failure group, which at the end of the text marked every branch
// unknown, so the caller's `git push` on agent/x was refused although nothing moved a branch
describe('#557: a git read that ends a nested text with an exit opens no failure group', () => {
  for (const body of [
    'make\ngit config --get user.email >/dev/null || exit 1\n',
    'make\ngit symbolic-ref -q HEAD || { echo detached; exit 1; }\n',
    'make\ngit branch -r | grep -q origin/main || exit 1\n',
  ]) {
    test(`allowed: bash build.sh ending ${JSON.stringify(body.split('\n')[1])}`, () => expect('allow', 'bash build.sh; git push', { [BUILD]: body }));
  }
  test('denied (a mover still opens the group): a script ending with a checkout that may fail and an exit, a branch it may have switched', () => {
    expect('deny', 'bash build.sh; git push', { [BUILD]: 'make\ngit checkout agent/missing || { echo no; exit 1; }\n' }, MAIN);
  });
  test('denied (a directory change still opens the group): the #505 shape at the end of the text', () => {
    expect('deny', 'bash build.sh; git push', { [BUILD]: 'make\ncd dist || { bash /work/repo/cleanup.sh; exit 1; }\n', [CLEAN]: 'git checkout main\n' });
  });
});
