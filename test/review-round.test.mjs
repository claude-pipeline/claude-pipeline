// The shared round-recording module (pipeline/lib/review-round.mjs), called directly: the refusals and the record that `P codex-review`
// and any other reviewer's command both go through. The CLI-level behaviour is pinned by cli-review.test.mjs; this file proves the rules
// live in the module (a reviewer that is not Codex gets them by calling it) against a real throwaway git repo and a scripted fake gh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { createFakeGh, NO_COMMENTS, pipelineYml, REPO_VIEW } from './helpers/fakegh-env.mjs';
import { loadConfig } from '../pipeline/lib/config.mjs';
import { Fail } from '../pipeline/lib/cmd-common.mjs';
import { EXIT } from '../pipeline/lib/cli.mjs';
import { admitRound, classifyReview, planRange, recordRound, requiredBase, roundPrompt } from '../pipeline/lib/review-round.mjs';

const GH = [
  { match: '^pr view 7', stdoutJson: { title: 'Add compute', body: 'Adds compute()', headRefName: 'feat/x', baseRefName: 'main' } },
  { match: '^repo view', stdoutJson: REPO_VIEW },
  ...NO_COMMENTS,
];
const file = (n) => Array.from({ length: 30 }, (_, i) => `export const v${i + 1} = ${i + 1 === 12 ? n : i + 1};`).join('\n') + '\n';
const finding = {
  title: 'Missing null check', file: 'src/a.js', line: 12, category: 'bug',
  detail: 'x is dereferenced before it is checked', reasoning: 'compute(x.y) throws when x is undefined', testable: true,
};
const findings = (blocking = []) => ({ summary: 'Reviewed.', blocking, suggestions: [], worth_considering: [] });

// A repo on feat/x with one commit past `main` (base .. head), a fake gh, and the ctx a command would hand over.
async function world(t, { yml = pipelineYml() } = {}) {
  const repo = createTmpRepo();
  t.after(() => repo.cleanup());
  repo.write('.claude/pipeline.yml', yml);
  repo.write('.gitignore', '.review/\n');
  repo.write('src/a.js', file(0));
  const base = repo.commit('init');
  repo.branch('feat/x');
  repo.write('src/a.js', file(1));
  const head = repo.commit('feature');
  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-review-round-')));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const fake = createFakeGh(GH);
  const ctx = { env: { ...process.env, ...fake.env, PIPELINE_LOCK_DIR: join(scratch, 'locks') } };
  const { config } = await loadConfig(repo.dir);
  const root = repo.dir;
  const w = {
    repo, base, head, root, config, ctx,
    admit: (over = {}) => admitRound({ root, config, ctx, pr: 7, round: 1, base, head, ...over }),
    state: () => JSON.parse(readFileSync(join(root, '.review', 'state.json'), 'utf8')),
  };
  return w;
}

// What a caller gets when it is refused: an exit-2 Fail naming the error.
const refusal = async (fn, error) => {
  await assert.rejects(fn, (err) => {
    assert.ok(err instanceof Fail, `expected a Fail, got ${err?.stack ?? err}`);
    assert.equal(err.exitCode, EXIT.USAGE);
    assert.equal(err.output.error, error, err.output.message);
    return true;
  });
};

test('admitRound refuses a round that is not the next one (round-order)', async (t) => {
  const w = await world(t);
  await refusal(() => w.admit({ round: 2 }), 'round-order');
  assert.ok(!existsSync(join(w.root, '.review', 'round-2')), 'nothing is written for a refused round');
});

test('admitRound refuses a base that is not the PR merge base (base-mismatch)', async (t) => {
  const w = await world(t);
  await refusal(() => w.admit({ base: w.head }), 'base-mismatch');
});

test('admitRound refuses a round past the cap (round-cap); recordRound is what moved the count', async (t) => {
  const w = await world(t, { yml: `${pipelineYml()}review:\n  max_rounds: 1\n` });
  const adm = await w.admit();
  await recordRound({ adm, findings: findings() });
  w.repo.write('src/a.js', file(2));
  const head2 = w.repo.commit('more');
  await refusal(() => w.admit({ round: 2, base: w.head, head: head2 }), 'round-cap');
});

test('recordRound refuses when HEAD moved after admission (head-moved) and saves nothing', async (t) => {
  const w = await world(t);
  const adm = await w.admit();
  w.repo.write('src/a.js', file(3));
  w.repo.commit('moved');
  await refusal(() => recordRound({ adm, findings: findings() }), 'head-moved');
  assert.ok(!existsSync(join(w.root, '.review', 'state.json')), 'a refused record leaves no state');
});

test('admitRound + recordRound record a round: roundFields as given, files written, items returned', async (t) => {
  const w = await world(t);
  const adm = await w.admit();
  assert.equal(adm.review.kind, 'merge-base');
  assert.equal(adm.baseOnly, false);
  assert.match(roundPrompt(adm), /Add compute/);
  assert.ok(existsSync(join(w.root, '.review', 'round-1', 'diff.patch')), 'admission writes diff.patch');

  const done = await recordRound({ adm, findings: findings([finding]), roundFields: { codexModel: 'gpt-test', promptSha256: 'abc123' } });
  assert.deepEqual(done.items.map((i) => i.id), ['R1-B1']);
  assert.equal(done.grantUsed, undefined);

  const round = w.state().rounds[0];
  assert.equal(round.n, 1);
  assert.equal(round.fromHead, w.base);
  assert.equal(round.toHead, w.head);
  assert.equal(round.codexModel, 'gpt-test');
  assert.equal(round.promptSha256, 'abc123');
  assert.equal(done.state.rounds.at(-1).n, 1);
  assert.ok(existsSync(join(w.root, '.review', 'round-1', 'codex.json')));
  assert.match(readFileSync(join(w.root, '.review', 'round-1', 'codex.md'), 'utf8'), /Missing null check/);

  // The next round is now round 2 only.
  await refusal(() => w.admit(), 'round-order');
});

// ---- planRange: what `--plan` prints as the base (Item 3, PR A1) ------------------------------------------------------------------------------------------------

test('planRange: base is the base a round must use (the previous round\'s toHead, else the fork point) and reviewBase / reviewBaseKind say what range is reviewed', () => {
  const round = (toHead) => ({ n: 1, toHead, items: [] });
  // two rounds, a non-free merge from main: the REVIEWED range starts at the fork point (whole-pr) while the next round must still start at round 1's toHead
  const adm = { state: { rounds: [round('r1head')] }, forkPoint: 'fork0', review: { base: 'fork0', kind: 'whole-pr' } };
  assert.deepEqual(planRange(adm), { base: 'r1head', reviewBase: 'fork0', reviewBaseKind: 'whole-pr' });
  assert.equal(planRange(adm).base, requiredBase(adm.state, adm.forkPoint), 'the same rule checkBase enforces');
  // round 1: no state, the fork point
  assert.deepEqual(planRange({ state: null, forkPoint: 'fork0', review: { base: 'fork0', kind: 'whole-pr' } }), { base: 'fork0', reviewBase: 'fork0', reviewBaseKind: 'whole-pr' });
  // a synthetic range (merge-tree id) is only the reviewed range, never the admitted base
  const synthetic = planRange({ state: { rounds: [round('r1head')] }, forkPoint: 'fork0', review: { base: 'treeid', kind: 'synthetic' } });
  assert.equal(synthetic.base, 'r1head');
  assert.equal(synthetic.reviewBase, 'treeid');
});

// ---- classifyReview: where the counted 'conflict' kind may and may not appear (#423) ------------------------------------------------------------------------------

// Failure caught: the conflict base replacing a range the caller owes whole (an owed whole-PR round starts at the merge base; an escalated judge-to-Fable round reads the whole PR), which would
// hand Fable or the owed round only the slice since the last review.
test('classifyReview: a conflicting merge gives the conflict kind, except where a whole PR is owed (merge-base, nothing tried) or the reviewer escalated (whole-pr, conflict cleared)', async (t) => {
  const w = await world(t);
  w.repo.checkout('main');
  w.repo.write('src/a.js', file(2)); // main edits the line the PR changed: the trial merge of head with main conflicts
  const main = w.repo.commit('main edits line 12');
  const o = { cwd: w.root };
  const tried = [];
  const common = {
    state: { rounds: [{ toHead: w.head, items: [] }] }, base: w.head, forkPoint: main, trusted: true,
    tryResolution: () => { tried.push('resolution'); return { ineligible: 'history-nonmerge' }; },
    tryConflict: () => { tried.push('conflict'); return { base: 'tree0', conflicted: ['src/a.js'], conflictedCount: 1, records: [] }; },
  };
  const counted = classifyReview(common, o);
  assert.deepEqual([counted.review, counted.conflict, counted.resolutionIneligible], [{ base: 'tree0', kind: 'conflict' }, { conflicted: ['src/a.js'], conflictedCount: 1, records: [] }, 'history-nonmerge']);

  tried.length = 0;
  const owed = classifyReview({ ...common, wholePr: true }, o);
  assert.deepEqual([owed.review, owed.conflict, tried], [{ base: main, kind: 'merge-base' }, null, []]);

  const escalated = classifyReview({ ...common, escalated: true }, o);
  assert.deepEqual([escalated.review, escalated.conflict, escalated.resolution], [{ base: main, kind: 'whole-pr' }, null, null]);

  const refused = classifyReview({ ...common, tryConflict: () => ({ unavailable: 'evidence: x' }) }, o);
  assert.deepEqual([refused.review, refused.conflict], [{ base: main, kind: 'whole-pr' }, null]);
});
