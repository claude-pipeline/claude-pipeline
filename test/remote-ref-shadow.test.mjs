// Fable F1 (#448): a decision site must read the remote's default branch through the FULL ref refs/remotes/origin/<b>. git resolves an abbreviated `origin/<b>` through refs/tags and
// refs/heads BEFORE refs/remotes, so a PR that pushes a branch or a tag named `origin/main` would otherwise move the base every hash, fork point and behind-base check measures from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { contentHash, remoteDefaultBranch, remoteRefExists, reviewBaseRef } from '../pipeline/lib/git.mjs';
import * as risk from '../pipeline/lib/risk.mjs';
import { currentContentHash } from '../pipeline/lib/review-context.mjs';
import { createTmpRepo } from './helpers/tmprepo.mjs';

const config = { default_branch: 'main' };

// main at M (pushed to a bare origin, origin/HEAD -> main), a feature branch one commit past it, and a LATER commit on the feature branch to shadow with.
function world(t) {
  const repo = createTmpRepo();
  t.after(() => repo.cleanup());
  const bare = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cp-origin-')));
  t.after(() => fs.rmSync(bare, { recursive: true, force: true }));
  repo.write('src/a.js', 'one\ntwo\nthree\n');
  const m = repo.commit('base');
  repo.git(['init', '-q', '--bare', '-b', 'main', bare]);
  repo.git(['remote', 'add', 'origin', bare]);
  repo.git(['push', '-q', 'origin', 'main']);
  repo.git(['fetch', '-q', 'origin']);
  repo.git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  repo.branch('feat/x');
  repo.write('src/a.js', 'one\ntwo\nTHREE\n');
  const f1 = repo.commit('edit');
  repo.write('src/b.js', 'b\n');
  const f2 = repo.commit('later');
  return { repo, m, f1, f2 };
}

const snapshot = (repo) => ({
  base: reviewBaseRef('main', { cwd: repo.dir }),
  hash: currentContentHash(repo.dir, config),
  fork: risk.trustedBase({ root: repo.dir, head: 'HEAD', config }).trustedFork,
});

for (const [kind, shadow] of [['branch', (repo, sha) => repo.git(['branch', 'origin/main', sha])], ['tag', (repo, sha) => repo.git(['tag', 'origin/main', sha])]]) {
  test(`a local ${kind} named origin/main does not move reviewBaseRef, the hash or the trusted fork point`, (t) => {
    const { repo, m, f2 } = world(t);
    const before = snapshot(repo);
    assert.equal(before.base, 'refs/remotes/origin/main');
    assert.equal(before.fork, m);
    shadow(repo, f2);
    const after = snapshot(repo);
    assert.equal(after.base, 'refs/remotes/origin/main');
    assert.equal(after.hash, before.hash);
    assert.equal(after.fork, before.fork);
  });
}

test('remoteDefaultBranch ignores a local branch shadowing origin/<m>', (t) => {
  const { repo, f1 } = world(t);
  assert.equal(remoteDefaultBranch({ cwd: repo.dir }), 'main');
  repo.git(['update-ref', '-d', 'refs/remotes/origin/main']);
  repo.git(['branch', 'origin/main', f1]);
  assert.equal(remoteDefaultBranch({ cwd: repo.dir }), null);
});

test('the old short-ref hash equals the new full-ref hash in a normal repo', (t) => {
  const { repo } = world(t);
  const o = { cwd: repo.dir, exclude: [] };
  assert.equal(contentHash('origin/main', 'HEAD', o), currentContentHash(repo.dir, config));
});

test('hashBranch(root, null) returns the default branch name in a repo with no origin remote (no throw)', (t) => {
  const repo = createTmpRepo();
  t.after(() => repo.cleanup());
  repo.write('a.txt', 'a\n');
  repo.commit('base');
  assert.equal(risk.hashBranch(repo.dir, null), 'main');
  assert.equal(risk.hashBranch(repo.dir, { default_branch: 'trunk' }), 'trunk');
});

// #455: `git rev-parse --verify refs/remotes/origin/<b>` finds the exact ref first, but with the real ref MISSING it falls through to refs/tags/<name> and refs/heads/<name> (and
// refs/<name>), i.e. a branch or tag literally named `refs/remotes/origin/<b>`. An existence test must therefore be exact (git show-ref --verify).
// Branch and tag are made with update-ref: `git branch refs/remotes/origin/main` would be refused by git as an ambiguous name.
const shadowFullName = (repo, name, sha) => {
  repo.git(['update-ref', `refs/heads/refs/remotes/origin/${name}`, sha]);
  repo.git(['update-ref', `refs/tags/refs/remotes/origin/${name}`, sha]);
};

test('#455 reviewBaseRef: with refs/remotes/origin/<b> missing, a branch or tag named refs/remotes/origin/<b> is not the remote ref', (t) => {
  const { repo, f2 } = world(t);
  repo.git(['update-ref', '-d', 'refs/remotes/origin/main']);
  assert.equal(reviewBaseRef('main', { cwd: repo.dir }), 'refs/heads/main', 'no shadow: the local branch');
  shadowFullName(repo, 'main', f2);
  assert.equal(repo.git(['rev-parse', '--verify', 'refs/remotes/origin/main']).trim(), f2, 'precondition: rev-parse is fooled by the shadow');
  assert.equal(reviewBaseRef('main', { cwd: repo.dir }), 'refs/heads/main');
});

test('#455 remoteDefaultBranch: a dangling origin/HEAD stays null when a branch or tag named refs/remotes/origin/<old> exists', (t) => {
  const { repo, f2 } = world(t);
  repo.git(['update-ref', '--no-deref', '-d', 'refs/remotes/origin/main']); // the rename + prune: origin/HEAD -> a missing origin/main
  assert.equal(remoteDefaultBranch({ cwd: repo.dir }), null, 'no shadow');
  shadowFullName(repo, 'main', f2);
  assert.equal(remoteDefaultBranch({ cwd: repo.dir }), null);
});

test('#455 remoteRefExists is exact: true for the remote-tracking ref, false when only a shadow of that name exists', (t) => {
  const { repo, f2 } = world(t);
  assert.equal(remoteRefExists('main', { cwd: repo.dir }), true);
  assert.equal(remoteRefExists('nope', { cwd: repo.dir }), false);
  repo.git(['update-ref', '-d', 'refs/remotes/origin/main']);
  shadowFullName(repo, 'main', f2);
  assert.equal(remoteRefExists('main', { cwd: repo.dir }), false);
  assert.throws(() => remoteRefExists('main', { cwd: path.join(repo.dir, 'missing-dir') }), 'a real git failure still throws, never "missing"');
});
