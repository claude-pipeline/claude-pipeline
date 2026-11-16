// Issue #454: git resolves an abbreviated `origin/<b>` through refs/tags and refs/heads BEFORE refs/remotes, so a local branch or tag
// of that name shadows the remote-tracking ref. Every place that READS the remote's default branch names it fully qualified
// (refs/remotes/origin/<b>, as lib/git.mjs#reviewBaseRef does). Each test builds a real repo where a branch AND a tag named
// `origin/<b>` point at a different commit than the remote-tracking ref and proves the remote ref's answer wins.
// (The base-ref sites of lib/git.mjs are covered by test/remote-ref-shadow.test.mjs; this file covers the remaining readers, issue #454.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { addOrigin } from './helpers/origin.mjs';
import { project, scratchDir } from './helpers/project.mjs';
import { AGENT_LOG } from './helpers/gate-env.mjs';
import { ownerGoWiring } from '../pipeline/hooks/lib/git-wiring.mjs';
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
