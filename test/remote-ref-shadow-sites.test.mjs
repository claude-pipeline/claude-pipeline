// Issue #454: git resolves an abbreviated `origin/<b>` through refs/tags and refs/heads BEFORE refs/remotes, so a local branch or tag
// of that name shadows the remote-tracking ref. Every place that READS the remote's default branch, and the artifacts publisher that
// starts from the remote's artifacts branch, names it fully qualified (refs/remotes/origin/<b>, as lib/git.mjs#reviewBaseRef does).
// Each test builds a real repo where a branch AND a tag named `origin/<b>` point at a different commit than the remote-tracking ref
// and proves the remote ref's answer wins.
// (The base-ref sites of lib/git.mjs are covered by test/remote-ref-shadow.test.mjs; this file covers the default-branch readers
// elsewhere (guard, identity, agent log, verify report) and the artifacts branch, issue #454.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pipelineYml } from './helpers/fakegh-env.mjs';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { addOrigin } from './helpers/origin.mjs';
import { project, scratchDir } from './helpers/project.mjs';
import { AGENT_LOG } from './helpers/gate-env.mjs';
import { ARTIFACTS_BRANCH, publishArtifacts } from '../pipeline/commands/artifacts.mjs';
import { ownerGoWiring } from '../pipeline/hooks/lib/git-wiring.mjs';
import { draftBehindBase } from '../pipeline/commands/review-complete.mjs';
import { loadRepo } from '../pipeline/lib/worktree-prune/run.mjs';
import { headOnMain } from '../pipeline/lib/identity.mjs';
import { AGENT_LOG_BRANCH, AGENT_LOG_HEADER, originLogLines, publishLines } from '../pipeline/lib/agentlog.mjs';

// A branch (refs/heads/origin/<b>) and a tag (refs/tags/origin/<b>) both named like the remote-tracking ref, pointing at `sha`.
const shadow = (repo, name, sha) => {
  repo.git(['update-ref', `refs/heads/origin/${name}`, sha]);
  repo.git(['update-ref', `refs/tags/origin/${name}`, sha]);
};
const CHAT = 'owner_approval: chat\nmerge:\n  command: npm run merge -- {pr} --expect-head {sha}\n';
const LABEL = 'owner_approval: label\n';

// ---- a. the merge guard's chat-repo check (hooks/lib/git-wiring.mjs COMMITTED_REFS) ------------------------------------------

for (const name of ['main', 'master', 'HEAD']) {
  test(`#454 guard: a shadow branch/tag named origin/${name} cannot hide owner_approval: chat on the remote's copy`, () => {
    const repo = createTmpRepo();
    repo.write('.claude/pipeline.yml', CHAT);
    const chatSha = repo.commit('chat config');
    // origin/HEAD is a symref: point it at a remote-tracking branch that holds the chat copy, with no origin/main of its own
    if (name === 'HEAD') {
      repo.git(['update-ref', 'refs/remotes/origin/trunk', chatSha]);
      repo.git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk']);
    } else {
      repo.git(['update-ref', `refs/remotes/origin/${name}`, chatSha]);
    }
    repo.write('.claude/pipeline.yml', LABEL);
    const labelSha = repo.commit('drop chat');
    shadow(repo, name, labelSha);
    const w = ownerGoWiring('sess'); // the real `git show`: no injected seam
    assert.equal(w.mode(repo.dir), 'chat', `refs/remotes/origin/${name} still says chat (HEAD, the working tree and the shadow refs say label)`);
    assert.deepEqual(w.mergeTemplates(repo.dir).map((t) => t.prefix[0]), ['npm']);
  });
}

test('#454 guard: without any remote ref the committed copy alone decides (the shadow refs are not read)', () => {
  const repo = createTmpRepo();
  repo.write('.claude/pipeline.yml', CHAT);
  const chatSha = repo.commit('chat config');
  repo.write('.claude/pipeline.yml', LABEL);
  repo.commit('drop chat');
  for (const name of ['main', 'master', 'HEAD']) shadow(repo, name, chatSha);
  assert.equal(ownerGoWiring('sess').mode(repo.dir), 'label');
});

// ---- b. identity: is HEAD on the remote's main (lib/identity.mjs headOnMain) -----------------------------------------------

test('#454 identity: headOnMain reads refs/remotes/origin/main, not a shadow branch or tag', () => {
  const repo = createTmpRepo();
  repo.write('a.txt', '1\n');
  const first = repo.commit('first');
  repo.write('a.txt', '2\n');
  const second = repo.commit('second'); // HEAD
  // the remote main is behind HEAD (HEAD is not on main) while the shadow refs claim it is
  repo.git(['update-ref', 'refs/remotes/origin/main', first]);
  shadow(repo, 'main', second);
  assert.equal(headOnMain(repo.dir), false);
  // and the other way: the remote main contains HEAD while the shadow refs are behind it
  repo.git(['update-ref', 'refs/remotes/origin/main', second]);
  shadow(repo, 'main', first);
  assert.equal(headOnMain(repo.dir), true);
});

test('#454 identity: no remote-tracking origin/main means false, whatever a shadow ref says', () => {
  const repo = createTmpRepo();
  repo.write('a.txt', '1\n');
  const sha = repo.commit('first');
  shadow(repo, 'main', sha);
  assert.equal(headOnMain(repo.dir), false);
});

// ---- c. the agent log's reads of the default branch (lib/agentlog.mjs) -----------------------------------------------------

const logOf = (line) => `${AGENT_LOG_HEADER}\n${line}\n`;
const REMOTE_LINE = '- 2026-09-01 · #1 · from the remote main · risk low · rounds 1 · arbiter 0 · merged';
const SHADOW_LINE = '- 2026-09-02 · #2 · from a shadow ref · risk low · rounds 1 · arbiter 0 · merged';

// main carries the REMOTE log; a side commit carries the SHADOW log. -> { repo, shadowSha }
function logWorld(t) {
  const repo = createTmpRepo();
  repo.write(AGENT_LOG, logOf(REMOTE_LINE));
  repo.commit('main with the remote log');
  addOrigin(t, repo);
  repo.branch('side');
  repo.write(AGENT_LOG, logOf(SHADOW_LINE));
  const shadowSha = repo.commit('a log only a shadow ref has');
  shadow(repo, 'main', shadowSha);
  repo.checkout('main');
  return { repo, shadowSha };
}

test('#454 agent log: originLogLines reads refs/remotes/origin/<default>, not a shadow branch or tag', (t) => {
  const { repo } = logWorld(t);
  const { lines } = originLogLines(repo.dir, { logFile: join(repo.dir, AGENT_LOG), defaultBranch: 'main' });
  assert.ok(lines, 'readable');
  assert.ok(lines.has(REMOTE_LINE), 'the remote main\'s line is there');
  assert.ok(!lines.has(SHADOW_LINE), 'the shadow ref\'s line is not');
});

test('#454 agent log: a new log branch is seeded from refs/remotes/origin/<default>, not a shadow branch or tag', (t) => {
  const { repo } = logWorld(t);
  const NEW = '- 2026-09-03 · #3 · new · risk low · rounds 1 · arbiter 0 · merged';
  const r = publishLines({ root: repo.dir, logRel: AGENT_LOG, lines: [NEW], defaultBranch: 'main' });
  assert.equal(r.pushed, true);
  const published = repo.git(['show', `${r.commit}:${AGENT_LOG}`]);
  assert.ok(published.includes(REMOTE_LINE), 'seeded from the remote main');
  assert.ok(!published.includes(SHADOW_LINE), 'not from the shadow ref');
  assert.ok(published.includes(NEW));
});

// ---- d. the verify report's base (templates/scripts/verify.mjs gitInfo) --------------------------------------------------

test('#454 verify: the report\'s base and mergeBase come from refs/remotes/origin/<default>, not a shadow branch or tag', async () => {
  const template = join(dirname(fileURLToPath(import.meta.url)), '..', 'pipeline', 'templates', 'scripts', 'verify.mjs');
  const repo = await project();
  copyFileSync(template, join(repo.dir, 'scripts', 'verify.mjs'));
  const remoteBase = repo.commit('verify runner');
  repo.git(['update-ref', 'refs/remotes/origin/main', remoteBase]);
  repo.branch('feature');
  repo.write('src/new.js', 'x\n');
  const featureSha = repo.commit('feature work');
  shadow(repo, 'main', featureSha); // a shadow claiming the feature tip is the base
  const { runVerify } = await import(pathToFileURL(join(repo.dir, 'scripts', 'verify.mjs')).href);
  const sink = { write: () => true };
  // a stand-in step that succeeds: this test asserts the report's git base, not what the step does
  await runVerify({ argv: [], cwd: repo.dir, steps: [{ name: 'a', cmd: 'node --version', quick: false }], lockDir: scratchDir(), out: sink, err: sink });
  const g = JSON.parse(readFileSync(join(repo.dir, '.verify', 'report.json'), 'utf8')).git;
  assert.equal(g.base, remoteBase);
  assert.equal(g.mergeBase, remoteBase);
});

// ---- e. the artifacts publisher's start point (commands/artifacts.mjs publishArtifacts) -------------------------------------

test('#454 artifacts: the publish starts from the fetched refs/remotes/origin/<artifacts branch>, not a shadow branch or tag', (t) => {
  const repo = createTmpRepo();
  repo.write('app.txt', 'v1\n');
  repo.commit('init');
  const bare = addOrigin(t, repo);
  // the remote's artifacts branch: one commit holding pr-1/old.png
  repo.write('pr-1/old.png', 'old\n');
  repo.git(['add', '--', 'pr-1']);
  repo.git(['commit', '-q', '-m', 'remote artifacts']);
  const remoteTip = repo.git(['rev-parse', 'HEAD']).trim();
  repo.git(['push', '-q', 'origin', `HEAD:refs/heads/${ARTIFACTS_BRANCH}`]);
  // a different commit that only the shadow branch and tag point at; it adds shadow.txt
  repo.write('shadow.txt', 'shadow\n');
  repo.git(['add', '--', 'shadow.txt']);
  repo.git(['commit', '-q', '-m', 'shadow']);
  const shadowSha = repo.git(['rev-parse', 'HEAD']).trim();
  shadow(repo, ARTIFACTS_BRANCH, shadowSha);
  repo.git(['reset', '-q', '--hard', 'main']);
  const img = join(scratchDir(), 'new.png');
  writeFileSync(img, 'new\n');
  const r = publishArtifacts({ root: repo.dir, pr: 2, files: [{ abs: img, name: 'new.png' }] });
  assert.equal(r.pushed, true);
  assert.equal(repo.git(['--git-dir', bare, 'rev-parse', `${r.commit}^`]).trim(), remoteTip, 'the new commit sits on the remote tip');
  const files = repo.git(['--git-dir', bare, 'ls-tree', '-r', '--name-only', ARTIFACTS_BRANCH]).split('\n').filter(Boolean);
  assert.ok(files.includes('pr-1/old.png') && files.includes('pr-2/new.png'), 'the remote\'s file and the new one are published');
  assert.ok(!files.includes('shadow.txt'), 'the shadow commit\'s file is not on the published branch');
});

// ---- f. #455: a MISSING remote-tracking ref must not be answered by a branch or tag literally named refs/remotes/origin/<b> --------
// `git show|rev-parse|merge-base refs/remotes/origin/<b>` finds the exact ref first, but with it missing falls through to refs/tags/<name> and refs/heads/<name>.
// (lib/git.mjs#reviewBaseRef and #remoteDefaultBranch are covered by test/remote-ref-shadow.test.mjs.)
const shadowFull = (repo, name, sha) => {
  repo.git(['update-ref', `refs/heads/refs/remotes/origin/${name}`, sha]);
  repo.git(['update-ref', `refs/tags/refs/remotes/origin/${name}`, sha]);
};

test('#455 identity: with refs/remotes/origin/main missing, a branch or tag named refs/remotes/origin/main does not make headOnMain true', () => {
  const repo = createTmpRepo();
  repo.write('a.txt', '1\n');
  const sha = repo.commit('first'); // HEAD
  shadowFull(repo, 'main', sha);
  assert.equal(headOnMain(repo.dir), false);
});

test('#455 guard: with origin/main missing, the copy a branch or tag named refs/remotes/origin/main holds is not read as the remote\'s', () => {
  const repo = createTmpRepo();
  repo.write('.claude/pipeline.yml', CHAT);
  const chatSha = repo.commit('chat config');
  repo.write('.claude/pipeline.yml', LABEL);
  repo.commit('drop chat');
  for (const name of ['main', 'master']) shadowFull(repo, name, chatSha);
  assert.equal(ownerGoWiring('sess').mode(repo.dir), 'label');
});

test('#455 agent log: with origin/<default> missing, originLogLines is unreadable (null), not the log of a branch or tag named refs/remotes/origin/<default>', (t) => {
  const { repo, shadowSha } = logWorld(t);
  repo.git(['update-ref', '-d', 'refs/remotes/origin/main']);
  repo.git(['update-ref', '-d', `refs/heads/origin/main`]);
  repo.git(['update-ref', '-d', `refs/tags/origin/main`]);
  shadowFull(repo, 'main', shadowSha);
  const { lines } = originLogLines(repo.dir, { logFile: join(repo.dir, AGENT_LOG), defaultBranch: 'main' });
  assert.equal(lines, null);
});

test('#455 worktree prune: a missing origin/main is skipped for origin/master even when a branch or tag named refs/remotes/origin/main exists', async () => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-wtcfg455-')));
  const repo = createTmpRepo();
  try {
    const origin = join(base, 'origin.git');
    repo.git(['init', '--bare', '-q', '-b', 'main', origin]);
    repo.write('.claude/pipeline.yml', pipelineYml());
    const sha = repo.commit('init');
    repo.git(['remote', 'add', 'origin', origin]);
    repo.git(['push', '-q', 'origin', 'main']);
    repo.git(['checkout', '-q', '-b', 'local/root-scratch']);
    repo.rm('.claude/pipeline.yml');
    repo.commit('scratch', { allowEmpty: true });
    repo.git(['update-ref', 'refs/remotes/origin/master', 'refs/remotes/origin/main']);
    repo.git(['update-ref', '-d', 'refs/remotes/origin/main']);
    shadowFull(repo, 'main', sha);
    const r = await loadRepo({}, { cwd: repo.dir });
    assert.equal(r.configSource, 'origin/master');
  } finally {
    rmSync(base, { recursive: true, force: true });
    repo.cleanup();
  }
});

test('#455 review-complete: draftBehindBase skips the behind-base check (warning) when refs/remotes/origin/<b> is missing, whatever a branch or tag of that full name says', (t) => {
  const repo = createTmpRepo();
  t.after(() => repo.cleanup());
  repo.write('a.txt', '1\n');
  repo.commit('base');
  addOrigin(t, repo);
  repo.branch('feat/x');
  repo.write('b.txt', '2\n');
  const head = repo.commit('feature');
  repo.git(['update-ref', '-d', 'refs/remotes/origin/main']);
  shadowFull(repo, 'main', head); // an ancestor of HEAD: the old code read it as the base and answered "not behind"
  const r = draftBehindBase({ root: repo.dir, config: { default_branch: 'main' }, gh: null, pr: 7, view: { isDraft: true }, refresh: { refreshed: true } });
  assert.match(r.warning ?? '', /behind-base check skipped/);
});
