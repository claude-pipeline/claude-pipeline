import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { repoRoot, gitCommonDir, pipelineStateDir, repoSlug, pushRemoteSlugs } from '../pipeline/lib/repo.mjs';

test('repoRoot and gitCommonDir resolve for a repo and its worktree', () => {
  const r = createTmpRepo();
  try {
    r.write('a.txt', 'a\n'); r.commit('init');
    assert.equal(realpathSync.native(repoRoot(r.dir)), realpathSync.native(r.dir));
    const wt = join(r.dir, '..', `${r.dir.split(/[\\/]/).pop()}-wt`);
    r.git(['worktree', 'add', '-q', '-b', 'side', wt]);
    assert.equal(realpathSync.native(gitCommonDir(wt)), realpathSync.native(join(r.dir, '.git')));
    assert.equal(pipelineStateDir(wt), join(gitCommonDir(wt), 'claude-pipeline'));
    r.git(['worktree', 'remove', '--force', wt]);
  } finally { r.cleanup(); }
});

test('repoSlug parses nameWithOwner and default branch', () => {
  const s = repoSlug('.', { ghJsonFn: () => ({ nameWithOwner: 'o/r', defaultBranchRef: { name: 'trunk' } }) });
  assert.deepEqual(s, { owner: 'o', name: 'r', slug: 'o/r', host: null, defaultBranch: 'trunk' });
  // (Phase 3b) the host gh resolved the repository on, from its url
  const at = (url) => repoSlug('.', { ghJsonFn: () => ({ nameWithOwner: 'o/r', url }) }).host;
  assert.equal(at('https://GitHub.com/o/r'), 'github.com');
  assert.equal(at('https://ghe.corp/o/r'), 'ghe.corp');
  assert.equal(at('github.com/o/r'), null);
  assert.throws(() => repoSlug('.', { ghJsonFn: () => ({}) }), /could not resolve/);
});

// Failure caught: `get-url --push` alone prints only the first push URL, so a listed second destination of the same `git push origin` went unchecked.
test('pushRemoteSlugs returns every push URL of the remote, not only the first', () => {
  const r = createTmpRepo();
  try {
    r.git(['remote', 'add', 'origin', 'https://example.test/private/Repo.git']);
    r.git(['remote', 'set-url', '--push', 'origin', 'https://example.test/private/Repo.git']);
    r.git(['remote', 'set-url', '--add', '--push', 'origin', 'git@example.test:Listed/Mirror.git']);
    assert.deepEqual(pushRemoteSlugs(r.dir), ['private/Repo', 'Listed/Mirror']);
  } finally { r.cleanup(); }
});

// Failure caught: a git that did not run (here a missing directory) read as "no push destination", so the check failed open and the push went out unscanned.
test('pushRemoteSlugs: no such remote is []; a git that could not run throws instead of reading as no destination', () => {
  const r = createTmpRepo();
  try {
    assert.deepEqual(pushRemoteSlugs(r.dir), []);
    assert.throws(() => pushRemoteSlugs(join(r.dir, 'no-such-dir')));
  } finally { r.cleanup(); }
});
