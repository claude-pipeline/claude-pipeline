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
