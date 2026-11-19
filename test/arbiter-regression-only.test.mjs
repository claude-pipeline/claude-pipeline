// #559 A2 end to end (the real CLI against a throwaway repo): the Regression-only bar section of the Fable review input and of the Codex prompt, read from the TRUSTED default-branch config
// (never the PR's own copy), the stored globs and merge base, the same-on-base finding that needs no human (only for a plainly modified file), the Rulings row for every dismissal on a matched file,
// and state version 9.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertExit } from './helpers/assert-exit.mjs';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { SHARED_FLOOR_DIR, floorEnv } from './helpers/floor-env.mjs';
import { createFakeGh, NO_COMMENTS, pipelineYml, REPO_VIEW } from './helpers/fakegh-env.mjs';
import { reviewEligibilityProblems, rulingsInventory } from '../pipeline/lib/triage.mjs';
import { buildReviewPrompt, buildSecondReviewPrompt } from '../pipeline/lib/codex.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'pipeline', 'bin', 'pipeline.mjs');
const fakeCodex = join(here, 'fixtures', 'fake-codex.mjs');
const GH = [
  { match: '^pr view 7', stdoutJson: { title: 'Add compute', body: 'b', headRefName: 'feat/x' } },
  { match: '^repo view', stdoutJson: REPO_VIEW },
  ...NO_COMMENTS,
];
const fenced = (obj) => `Done.\n\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;
const aFile = (changed) => Array.from({ length: 30 }, (_, i) => (i === 11 && changed ? 'export const v12 = compute(x.y);' : `export const v${i + 1} = ${i + 1};`)).join('\n') + '\n';
const yml = (globs = '[src/**]', always = '[src/**]') => `${pipelineYml()}review:\n  arbiter_always_paths: ${always}\n  regression_only_paths: ${globs}\n`;

function world(t, { baseYml = yml(), prYml, parentYml, prBase = 'main' } = {}) {
  const repo = createTmpRepo({ highEffort: true });
  t.after(() => repo.cleanup());
  repo.write('.claude/pipeline.yml', baseYml);
  repo.write('.gitignore', '.review/\n');
  repo.write('src/a.js', aFile(false));
  const base = repo.commit('init');
  repo.git(['branch', 'develop', base]);
  let reviewBase = base;
  if (parentYml !== undefined) {
    // a stacked PR: an unmerged parent branch (not the default branch) carries its own copy of pipeline.yml
    repo.branch('parent');
    repo.write('.claude/pipeline.yml', parentYml);
    const parentHead = repo.commit('parent');
    if (prBase !== 'main') reviewBase = parentHead; // a PR retargeted to main reviews the whole range from the default branch again
  }
  repo.branch('feat/x');
  repo.write('src/a.js', aFile(true));
  repo.write('src/new.js', 'export const added = 1;\n'); // a file the PR adds: it has no merge-base version
  if (prYml !== undefined) repo.write('.claude/pipeline.yml', prYml);
  const head = repo.commit('feature');
  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-regress-')));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const fake = createFakeGh(GH.map((e) => (e.match === '^pr view 7' ? { ...e, stdoutJson: { baseRefName: prBase, headRefOid: head, ...e.stdoutJson } } : e)));
  const stateFile = join(repo.dir, '.review', 'state.json');
  const w = {
    repo, base, head, reviewBase,
    cli(args, env = {}) {
      const merged = { ...process.env, ...fake.env, PIPELINE_CODEX: `node "${fakeCodex}"`, PIPELINE_LOCK_DIR: join(scratch, 'locks'), ...floorEnv(SHARED_FLOOR_DIR), ...env };
      for (const k of ['PIPELINE_TEST_MODE', 'FAKE_CODEX_OUTPUT', 'AI_AGENT', 'CLAUDE_CODE_EXECPATH']) if (!(k in env)) delete merged[k];
      const r = spawnSync(process.execPath, [bin, ...args], { cwd: repo.dir, env: merged, encoding: 'utf8' });
      let json = null;
      try { json = r.stdout ? JSON.parse(r.stdout) : null; } catch { /* asserted by the caller */ }
      return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
    },
    state: () => JSON.parse(readFileSync(stateFile, 'utf8')),
    edit(fn) { const s = w.state(); fn(s); writeFileSync(stateFile, JSON.stringify(s, null, 2)); },
    input: (n = 1) => readFileSync(join(repo.dir, '.review', `round-${n}`, 'arbiter-input.md'), 'utf8'),
    round1() {
      const out = join(scratch, 'f1.json');
      writeFileSync(out, JSON.stringify({ summary: 'ok', blocking: [], suggestions: [], worth_considering: [] }));
      assertExit(w.cli(['codex-review', '--pr', '7', '--round', '1', '--base', reviewBase, '--head', head, '--effort', 'high'], { FAKE_CODEX_OUTPUT: out }), 0);
      const needed = w.cli(['arbiter', 'needed', '--round', '1']);
      assertExit(needed, 0, needed.stdout + needed.stderr);
      return needed.json;
    },
    apply(needed, answer) {
      const root = join(scratch, 'projects');
      const dir = join(root, '-tmp-work', 'session-1', 'subagents');
      mkdirSync(dir, { recursive: true });
      const lines = [
        { type: 'user', isSidechain: true, agentId: 'a1', message: { role: 'user', content: `ROUND: 1\nINPUT-DIGEST: ${needed.digest}\nRead the input file.` }, uuid: 'u-1' },
        { type: 'assistant', isSidechain: true, agentId: 'a1', requestId: 'req_1', effort: 'high', perTurnEffort: 'high', uuid: 'a-1', message: { model: 'claude-fable-5-2', id: 'msg_1', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: fenced(answer) }] } },
      ];
      writeFileSync(join(dir, 'agent-a1.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
      writeFileSync(join(dir, 'agent-a1.meta.json'), JSON.stringify({ toolUseId: 'toolu_01', spawnDepth: 1, agentType: 'arbiter', description: needed.tag }));
      return w.cli(['arbiter', 'apply', '--round', '1', '--projects-dir', root]);
    },
  };
  return w;
}
const finding = (over = {}) => ({ bucket: 'BLOCKING', category: 'security', title: 'unchecked path', file: 'src/a.js', line: 5, detail: 'the same unchecked path is on the base', ruling: 'FOLLOW-UP', confidence: 'high', reasoning: 'same on base', scope: 'same-on-base', ...over });
const prompt = (w) => readFileSync(join(w.repo.dir, '.review', ['round', 1].join('-'), 'prompt.md'), 'utf8');

test('review input: a listed path touched by the diff adds a standing-alone Regression-only bar section (before the review section) naming the merge base, and stores the globs and the merge base', (t) => {
  const w = world(t);
  w.round1();
  const text = w.input();
  assert.match(text, /\n# Regression-only bar \(from \.claude\/pipeline\.yml on the base branch\)\n/);
  assert.ok(text.indexOf('# Regression-only bar') < text.indexOf('# Fable review, round 1'));
  assert.match(text, /OVERRIDES "Review as an attacker", "prefer ACCEPT"/);
  // R1-F1: the arbiter has no shell, so the merge-base view is a file in the round directory, named with its digest in the digest-bound input
  assert.doesNotMatch(text, /git show/);
  const regressionOnly = w.state().rounds[0].arbiter.regressionOnly;
  const { basePath, baseDigest } = regressionOnly;
  assert.ok(text.includes(`${basePath} (sha256 ${baseDigest})`), 'the merge-base view is named with its digest');
  const view = readFileSync(basePath, 'utf8');
  assert.match(view, new RegExp(`${w.base}\\.\\.${w.head}`));
  assert.match(view, /## src\/a\.js \(status M\)[^]*-12: export const v12 = 12;[^]*\+12: export const v12 = compute\(x\.y\);/);
  assert.match(view, /## src\/new\.js \(status A/);
  assert.match(text, /"scope": "same-on-base"/);
  assert.match(text, /Paths: src\/\*\*/);
  assert.deepEqual([regressionOnly.globs, regressionOnly.forkPoint], [['src/**'], w.base]);
});

// Failure caught: an empty key changing every arbiter input (and so every digest) of a repo that never turned the bar on.
test('review input: no listed path touched, an empty list, or no key at all => no section, nothing stored, and the input digest is the same with the key empty or absent', (t) => {
  const none = world(t, { baseYml: yml('[other/**]', '[src/**, other/**]') });
  none.round1();
  assert.doesNotMatch(none.input(), /# Regression-only bar/);
  assert.equal(none.state().rounds[0].arbiter.regressionOnly, undefined);
  // (the two repos hold different commits, so the commit ids, digests and temp directory are blanked before the inputs are compared)
  const text = (w) => { w.round1(); return w.input().replace(/[0-9a-f]{40,64}/g, '<sha>').replace(/cp-git-\w+/g, '<dir>'); };
  const empty = text(world(t, { baseYml: yml('[]') }));
  const absent = text(world(t, { baseYml: `${pipelineYml()}review:\n  arbiter_always_paths: [src/**]\n` }));
  assert.equal(empty, absent, 'an empty key leaves the arbiter input byte-identical');
  assert.notEqual(text(world(t)), empty, 'the section is part of the digest-bound input');
});

// Failure caught: a PR editing pipeline.yml to add its own file to the bar (or to move default_branch) lowering its own review.
test('R2 trusted config only: the PR adding a path to the bar in its own pipeline.yml changes nothing; a trusted config that is unavailable shows no bar', (t) => {
  const w = world(t, { baseYml: yml('[other/**]', '[src/**, other/**]'), prYml: yml('[src/**]') });
  w.round1();
  assert.doesNotMatch(w.input(), /# Regression-only bar/);
  const m = world(t, { prYml: `${yml()}default_branch: develop\n` });
  m.round1();
  assert.doesNotMatch(m.input(), /# Regression-only bar/);
});

test('apply: a same-on-base BLOCKING security finding on a plainly modified file needs no human, is marked, lifts the state to version 9, is a Rulings row and blocks review-complete until filed', (t) => {
  const w = world(t);
  const needed = w.round1();
  const applied = w.apply(needed, { rulings: [], findings: [finding()] });
  assertExit(applied, 0, applied.stdout);
  const s = w.state();
  const item = s.rounds[0].items.find((i) => i.id === 'R1-F1');
  assert.deepEqual([item.final.decision, item.final.needsHuman, item.final.sameOnBase], ['FOLLOW-UP', false, 'src/**']);
  assert.equal(s.version, 9);
  assert.equal(rulingsInventory(s).rows[0].split(' · ')[4], 'by arbiter (same as merge-base)');
  assert.match(reviewEligibilityProblems(s).join(';'), /same-on-base follow-up\(s\) without a filed issue: R1-F1/);
  const filed = structuredClone(s);
  filed.rounds[0].items[0].followupIssue = 'https://github.com/o/r/issues/5';
  assert.deepEqual(reviewEligibilityProblems(filed), []);
});

// R1-F1. Failure caught: a weakness this PR itself added (line 12 is a line the PR changed) ruled "same on base" by an arbiter that could not see the merge base, and merged without a human.
test('apply: a same-on-base ruling on a line the PR itself adds is never waived; the merge-base view file is bound to the input (edited -> the proof fails)', (t) => {
  const w = world(t);
  const needed = w.round1();
  const applied = w.apply(needed, { rulings: [], findings: [finding({ line: 12 })] });
  assertExit(applied, 0, applied.stdout);
  const item = w.state().rounds[0].items.find((i) => i.id === 'R1-F1');
  assert.deepEqual([item.final.needsHuman, item.final.cause], [true, 'security-dismissal']);
  const w2 = world(t);
  const n2 = w2.round1();
  writeFileSync(w2.state().rounds[0].arbiter.regressionOnly.basePath, '# edited\n');
  const bad = w2.apply(n2, { rulings: [], findings: [finding()] });
  assert.notEqual(bad.code, 0);
  assert.match(bad.stdout, /regression-base\.md no longer matches the digest/);
});

// F4. Failure caught: new code in a file the PR adds, ruled "same as base" (the base never held it), merged without a human.
test('F4 apply: the same ruling on a file the PR ADDS, without the scope, or on a file outside the globs still waits for a human; the state stays version 1', (t) => {
  const w = world(t, { baseYml: yml('[src/**]', '[src/**]') });
  const needed = w.round1();
  assertExit(w.apply(needed, { rulings: [], findings: [finding({ file: 'src/new.js', line: 1 }), finding({ scope: undefined }), finding({ file: 'lib/x.js' })] }), 0);
  const s = w.state();
  assert.deepEqual(s.rounds[0].items.map((i) => [i.final.needsHuman, i.final.cause, i.final.sameOnBase]), [[true, 'security-dismissal', undefined], [true, 'security-dismissal', undefined], [true, 'security-dismissal', undefined]]);
  assert.equal(s.version, 1);
});

// R6-F1. Failure caught: the arbiter's own finding, filed as SUGGESTION as the bar section instructs, ruled "same on base" on a line the PR adds or in a file it adds, stored as same-on-base with no human.
test('R6-F1 apply: a SUGGESTION same-on-base finding on a PR-added line or an added file waits for a human and stores no same-on-base scope', (t) => {
  const w = world(t);
  const needed = w.round1();
  assertExit(w.apply(needed, { rulings: [], findings: [finding({ bucket: 'SUGGESTION', line: 12 }), finding({ bucket: 'SUGGESTION', file: 'src/new.js', line: 1 }), finding({ bucket: 'SUGGESTION', line: 5 })] }), 0);
  const items = w.state().rounds[0].items;
  assert.deepEqual(items.map((i) => [i.final.needsHuman, i.final.scope]), [[true, undefined], [true, undefined], [false, 'same-on-base']]);
});

// F2. Failure caught: a SUGGESTION FOLLOW-UP the arbiter rules on a matched file WITHOUT the scope is neither in the Rulings block nor held by the filing gate.
test('F2 apply: a SUGGESTION FOLLOW-UP without scope on a matched file is marked, listed and filing-gated; the same on an unmatched file is not', (t) => {
  const w = world(t, { baseYml: yml('[src/a.js]', '[src/**]') });
  const needed = w.round1();
  assertExit(w.apply(needed, { rulings: [], findings: [finding({ bucket: 'SUGGESTION', category: 'design', scope: undefined }), finding({ bucket: 'SUGGESTION', category: 'design', scope: undefined, file: 'src/new.js', line: 1 })] }), 0);
  const s = w.state();
  assert.deepEqual(s.rounds[0].items.map((i) => i.final.sameOnBase), ['src/a.js', undefined]);
  assert.equal(rulingsInventory(s).count, 1);
  assert.match(reviewEligibilityProblems(s).join(';'), /same-on-base follow-up\(s\) without a filed issue: R1-F1/);
  assert.doesNotMatch(reviewEligibilityProblems(s).join(';'), /R1-F2/);
});

test('apply: scope "same-on-base" is validated like out-of-model: with ACCEPT it fails the proof', (t) => {
  const w = world(t);
  const needed = w.round1();
  const bad = w.apply(needed, { rulings: [], findings: [finding({ ruling: 'ACCEPT' })] });
  assert.notEqual(bad.code, 0);
  assert.match(bad.stdout, /scope is only allowed with ruling FOLLOW-UP/);
});

// F2: Codex and the substitute keep the bucket; only the arbiter applies the bar.
test('Codex prompt: the Regression-only bar block is present only when globs are given, tells the reviewer to KEEP the bucket, and a Fable-lane round on a listed path carries it', (t) => {
  const args = { pr: 7, title: 't', body: 'b', base: 'a'.repeat(40), head: 'b'.repeat(40), risk: 'high', round: 1, lightLane: false };
  const plain = buildReviewPrompt(args);
  assert.equal(buildReviewPrompt({ ...args, regressionOnly: null }), plain);
  assert.equal(buildReviewPrompt({ ...args, regressionOnly: { globs: [], forkPoint: 'c'.repeat(40) } }), plain, 'byte-identical when the key is empty');
  const p = buildReviewPrompt({ ...args, regressionOnly: { globs: ['src/**'], forkPoint: 'c'.repeat(40) } });
  assert.match(p, /## Regression-only bar\n.*WORSE than the merge base.*"same on base".*"regression"/s);
  assert.match(p, /Do NOT change the bucket or category because a finding is the same on base/);
  assert.match(p, /Paths: src\/\*\*/);
  assert.throws(() => buildReviewPrompt({ ...args, regressionOnly: { globs: ['src/**'], forkPoint: '--x' } }), /invalid regressionOnly.forkPoint/);
  const fable = world(t);
  fable.round1();
  assert.match(prompt(fable), /## Regression-only bar\n/);
  assert.ok(prompt(fable).includes(`git show ${fable.base}:<path>`));
  const off = world(t, { baseYml: yml('[]') });
  off.round1();
  assert.doesNotMatch(prompt(off), /Regression-only bar/);
});

test('second review prompt: the bar block only with regressionOnly, the decision instructions unchanged; byte-identical otherwise', () => {
  const args = { pr: 7, title: 't', risk: 'high', head: 'b'.repeat(40), items: [{ id: 'R1-B1', bucket: 'BLOCKING', category: 'security', title: 'x', file: 'src/a.js', line: 1, detail: 'd' }] };
  const plain = buildSecondReviewPrompt(args);
  assert.equal(buildSecondReviewPrompt({ ...args, regressionOnly: null }), plain);
  assert.equal(buildSecondReviewPrompt({ ...args, regressionOnly: { globs: [], forkPoint: 'c'.repeat(40) } }), plain);
  const p = buildSecondReviewPrompt({ ...args, regressionOnly: { globs: ['src/**'], forkPoint: 'c'.repeat(40) } });
  assert.ok(p.indexOf('## Regression-only bar') > p.indexOf('## Findings to verify') && p.indexOf('## Regression-only bar') < p.indexOf('## How to answer'));
  assert.match(p, /Do NOT change the bucket or category/);
  assert.ok(p.endsWith(plain.slice(plain.indexOf('## How to answer') - 1)), 'the answer instructions are untouched');
});
