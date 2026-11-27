// Shared helpers of cli-review-part1..4.test.mjs (split from cli-review.test.mjs), moved verbatim;
// `here` still names the test/ directory, so `bin` and `fakeCodex` resolve as before.
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createTmpRepo } from './tmprepo.mjs';
import { createFakeGh, fakeGhPath, pipelineYml, REPO_VIEW } from './fakegh-env.mjs';
import { contentHash } from '../../pipeline/lib/git.mjs';
import { loadConfig } from '../../pipeline/lib/config.mjs';
import { currentContentHash, excerptWindow, reviewBaseRef } from '../../pipeline/lib/review-context.mjs';
import { MARKERS, triageComment } from '../../pipeline/lib/render.mjs';
import { reviewContentHash } from '../../pipeline/lib/review-publish.mjs';
import { assertExit } from './assert-exit.mjs';
import { SHARED_FLOOR_DIR, floorEnv, scratchFloorDir } from './floor-env.mjs';
import { resetFloor } from '../../pipeline/lib/model-floor.mjs';
import { leasesDir } from '../../pipeline/lib/review-lease.mjs';
import { cleanupAtExit, cleanupRoundClaims, ownerApprovesPast, ownerGrants, ownerRules, pastRoundRequest, roundRequest, rulingRequest } from './owner-go.mjs';
import { grantIdOf, markerPath, presentedRoundRequest, readGrantMarker } from '../../pipeline/hooks/lib/owner-go.mjs';
import { fableFindingItems, rulingContentDigest } from '../../pipeline/lib/triage.mjs';
import { reviewCheck } from '../../pipeline/lib/finalgate.mjs';
import { noClaudeSession } from './no-claude-session.mjs';

export const here = join(dirname(fileURLToPath(import.meta.url)), '..');
export const bin = join(here, '..', 'pipeline', 'bin', 'pipeline.mjs');
export const fakeCodex = join(here, 'fixtures', 'fake-codex.mjs');
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// ---- fixtures -------------------------------------------------------------------------------

export const aFile = (changed) => Array.from({ length: 30 }, (_, i) => {
  const n = i + 1;
  return n === 12 && changed ? 'export const v12 = compute(x.y);' : `export const v${n} = ${n};`;
}).join('\n') + '\n';
export const bFile = Array.from({ length: 8 }, (_, i) => `export const w${i + 1} = ${i + 1};`).join('\n') + '\n';

export const finding = (over = {}) => ({
  title: 'Missing null check', file: 'src/a.js', line: 12, category: 'bug',
  detail: 'x is dereferenced before it is checked', reasoning: 'compute(x.y) throws when x is undefined', testable: true, ...over,
});
export const findingsOf = (blocking = [], suggestions = [], worth = []) => ({
  summary: 'Reviewed.', blocking, suggestions, worth_considering: worth,
});
// B1 + S1 + S2 + W1: the set most tests triage.
export const standardFindings = () => findingsOf(
  [finding()],
  [finding({ title: 'Rename helper', file: 'src/b.js', line: 3, category: 'maintainability' }), finding({ title: 'Extract constant', file: 'src/b.js', line: 5, category: 'design' })],
  [finding({ title: 'Consider caching', file: 'src/a.js', line: 20, category: 'performance', testable: false })],
);

// What `followups create` asks before it files anything: who we are and which issues of ours exist (none).
export const noIssues = (slug) => [
  { match: '^api user', stdout: 'me\n' },
  { match: `^api repos/${slug}/issues\\?creator=me&state=all&per_page=100 --paginate`, stdout: '[]' },
];
export const NO_ISSUES = noIssues('acme/widgets');
export const SEQ_GH = `node "${join(dirname(fakeGhPath), 'fake-gh-seq.mjs')}"`;

// codex-review reads the PR's triage comment before it admits a counted round (published history): a world answers "no comment" unless a test
// scripts the comments itself (these entries come LAST, so a test's own entries win).
export const NO_COMMENTS = [
  { match: '^api user', stdout: 'me\n' },
  { match: '^api repos/\\S+/issues/\\d+/comments --paginate', stdoutJson: [] },
];

export const GH = [
  { match: '^pr view 7', stdoutJson: { title: 'Add compute', body: 'Adds compute() to a.js', headRefName: 'feat/x' } },
  { match: '^repo view', stdoutJson: REPO_VIEW },
];

export function transcript({ prompt, text, model = 'claude-fable-5-2', effort = 'high' }) {
  const lines = [
    { type: 'user', isSidechain: true, agentId: 'a1', message: { role: 'user', content: prompt }, uuid: 'u-1', timestamp: '2026-10-01T09:00:00.000Z' },
    {
      type: 'assistant', isSidechain: true, agentId: 'a1', requestId: 'req_1', effort, perTurnEffort: effort,
      message: { model, id: 'msg_1', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] },
      uuid: 'a-1', timestamp: '2026-10-01T09:00:06.000Z',
    },
  ];
  return `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
}
// `triage settle` runs the proving test itself: commit a tiny test file that exits with `code` (bug-disproved passes, bug-confirmed
// fails by default) and return the CLI args that run it.
export function settleArgs(w, id, result, { code = result === 'bug-confirmed' ? 1 : 0, file = 'src/proof.test.js', cmd, output = 'proof output' } = {}) {
  w.repo.write(file, `console.log(${JSON.stringify(output)});\nprocess.exit(${code});\n`);
  w.repo.git(['add', '-A']);
  if (w.repo.git(['status', '--porcelain=v1', '--', file]).trim() !== '') w.repo.git(['commit', '-q', '-m', `proof for ${id}`]);
  return ['triage', 'settle', '--id', id, '--result', result, '--test-cmd', cmd ?? `node ${file}`, '--test-file', file];
}
export const fenced = (obj) => `Done.\n\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;

// ---- a world: repo on a feature branch, scratch dir, fake gh, fake codex ---------------------

// By default the feature commit is big enough (>= 50 changed lines) to be off the light lane, so the arbiter rules apply in
// full; `light: true` keeps the change tiny.
// baseFiles / featFiles: extra { path: content } committed in the base commit / the feature commit.
// slug: the repository name the fake gh reports (`repo view`). Tests that record the owner's chat words use ownerWorld (below).
export function world(t, { gh = GH, light = false, yml = pipelineYml(), baseFiles = {}, featFiles = {}, slug = 'acme/widgets' } = {}) {
  const repo = createTmpRepo({ highEffort: true });
  t.after(() => repo.cleanup());
  repo.write('.claude/pipeline.yml', yml);
  // As pipeline-setup leaves a real repo: the review's own files are never part of a commit (a fix commit would
  // otherwise carry .review/ and look like a big, medium-risk change).
  repo.write('.gitignore', '.review/\n');
  repo.write('src/a.js', aFile(false));
  repo.write('src/b.js', bFile);
  for (const [p, c] of Object.entries(baseFiles)) repo.write(p, c);
  const base = repo.commit('init');
  repo.branch('feat/x');
  repo.write('src/a.js', aFile(true));
  if (!light) repo.write('src/big.js', Array.from({ length: 60 }, (_, i) => `export const big${i} = ${i};`).join('\n') + '\n');
  for (const [p, c] of Object.entries(featFiles)) repo.write(p, c);
  const head = repo.commit('feature');
  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-review-')));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  // The PR as GitHub reports it: its base branch and the head commit it holds (what review-complete compares to).
  // (a world with its own slug: every API path the scripts match on names that repository instead of acme/widgets)
  const forSlug = (e) => (slug === 'acme/widgets' || e.match.includes(slug) ? e : { ...e, match: e.match.split('acme/widgets').join(slug) });
  const withPr = (sha, list = gh) => [...list, ...NO_COMMENTS].map((e) => {
    if (e.match === '^pr view 7') return { ...e, stdoutJson: { baseRefName: 'main', headRefOid: sha, ...e.stdoutJson } };
    if (e.match === '^repo view' && slug !== 'acme/widgets') return { ...e, stdoutJson: { ...e.stdoutJson, nameWithOwner: slug, url: `https://github.com/${slug}` } };
    return forSlug(e);
  });
  const fake = createFakeGh(withPr(head));
  const capture = join(scratch, 'codex-capture.jsonl');
  const lockDir = join(scratch, 'locks');

  const w = {
    repo, base, head, scratch, fake, capture, lockDir, slug,
    // Tell the fake GitHub the PR's head moved (after a new commit).
    prHead: (sha) => fake.setScript(withPr(sha)),
    // Swap the scripted gh entries (e.g. the PR's comments) for the rest of the test; the PR head stays where the world put it.
    setGh: (list, sha = head) => fake.setScript(withPr(sha, list)),
    cli(args, env = {}) {
      const merged = {
        ...process.env, ...fake.env, PIPELINE_CODEX: `node "${fakeCodex}"`, FAKE_CODEX_CAPTURE: capture,
        PIPELINE_LOCK_DIR: lockDir, ...floorEnv(), ...env,
      };
      for (const k of [
        'PIPELINE_TEST_FORCE_ARBITER', 'PIPELINE_ARBITER_MODEL_OVERRIDE', 'PIPELINE_TEST_MODE', 'PIPELINE_CODEX_TIMEOUT_MS',
        'PIPELINE_LOCK_WAIT_MS', 'FAKE_CODEX_EXIT', 'FAKE_CODEX_STDERR', 'FAKE_CODEX_NO_WRITE', 'FAKE_CODEX_OUTPUT',
        'FAKE_CODEX_HANG', 'FAKE_CODEX_DURING', 'FAKE_CODEX_DURING_OUTPUT', 'FAKE_CODEX_TURN_FAILED',
        // the suite runs inside Claude Code: a real terminal's versions must not decide whether a Fable round is stopped as stale (cli-stale-terminal pins that)
        'AI_AGENT', 'CLAUDE_CODE_EXECPATH',
      ]) {
        if (!(k in env)) delete merged[k];
      }
      // TEST_BIN: run another copy of the CLI (an installed one) instead of the checkout.
      const useBin = merged.TEST_BIN ?? bin;
      delete merged.TEST_BIN;
      const r = spawnSync(process.execPath, [useBin, ...args], { cwd: repo.dir, env: merged, encoding: 'utf8' });
      let json = null;
      try { json = r.stdout ? JSON.parse(r.stdout) : null; } catch { /* leave null: the assertion on json will say so */ }
      return { code: r.status, json, stdout: r.stdout, stderr: r.stderr, pid: r.pid };
    },
    file(name, content) {
      const p = join(scratch, name);
      writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
      return p;
    },
    codex(round, findings, { from = base, to = head, env = {}, extra = [] } = {}) {
      const out = w.file(`findings-${round}.json`, findings);
      return w.cli(
        ['codex-review', '--pr', '7', '--round', String(round), '--base', from, '--head', to, '--effort', 'high', ...extra],
        { FAKE_CODEX_OUTPUT: out, ...env },
      );
    },
    state: () => JSON.parse(readFileSync(join(repo.dir, '.review', 'state.json'), 'utf8')),
    stateText: () => readFileSync(join(repo.dir, '.review', 'state.json'), 'utf8'),
    item: (id) => w.state().rounds.flatMap((r) => r.items).find((i) => i.id === id),
    roundFile: (n, name) => join(repo.dir, '.review', `round-${n}`, name),
    captured: () => (existsSync(capture) ? readFileSync(capture, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    // Judge answer for round n; `decisions` maps id -> [decision, confidence, extra].
    judge(n, decisions) {
      const items = Object.entries(decisions).map(([id, [decision, confidence = 'high', extra = {}]]) => ({
        id, decision, confidence, reason: `judge: ${decision} ${id}`, disputedBug: false, settleTest: { possible: false, plan: '' }, ...extra,
      }));
      return w.cli(['triage', 'validate', '--round', String(n), '--file', w.file(`judge-${n}.json`, { items })]);
    },
  };
  return w;
}

// #122: the owner's recorded chat words live in the account's real owner-go folder (production reads the real home, never $HOME), so
// every test and every concurrent run of the suite shares that folder. A ruling or grant matches on repository, PR and item, so a world
// that records any gets a repository name of its own (lower-case hex: repoKey lower-cases) and never matches another test's record.
export const uniqueSlug = () => `acme/widgets-${randomUUID()}`;
export const ownerWorld = (t, opts = {}) => world(t, { slug: uniqueSlug(), ...opts });

// <tmp>/p/<encoded-cwd>/<session>/subagents/agent-<id>.{jsonl,meta.json}: the layout Claude Code writes.
export function installTranscript(w, { jsonl, meta, agentId = 'a1' }) {
  const root = join(w.scratch, `projects-${agentId}-${Math.random().toString(36).slice(2, 8)}`);
  const dir = join(root, '-tmp-work', 'session-1', 'subagents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `agent-${agentId}.jsonl`), jsonl);
  writeFileSync(join(dir, `agent-${agentId}.meta.json`), JSON.stringify({ toolUseId: 'toolu_01', spawnDepth: 1, ...meta }));
  return root;
}

// #389: the model is the TRUSTED config's (the one committed at the default branch's fork point), so --model may only name it; the working-tree value is the PR's to edit.
export const withModel = (m) => `${pipelineYml()}review:\n  codex_model: ${m}\n`;

// The weekly Codex figure: every real run (answered or failed) adds one line to the usage ledger (PIPELINE_CODEX_USAGE_FILE moves it into the scratch dir).
export const ledgerOf = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// ---- codex-review reads the published history before it admits a counted round (plan 2026-11-12-legacy-round-grants.md, A) -------------

export const commentsEntry = (comments) => ({ match: '^api repos/\\S+/issues/\\d+/comments --paginate', stdoutJson: comments });
export const triageNote = (state, over = {}) => ({ id: 9, user: { login: 'me' }, body: triageComment(state), created_at: '2026-11-05T10:00:00Z', updated_at: '2026-11-05T10:00:00Z', ...over });
export const noRoundWritten = (w, n) => !existsSync(join(w.repo.dir, '.review', `round-${n}`));

// ---- review range across an update-branch (main merged into the PR branch) ---------------------

// Main moves on (a commit touching `files`), then the PR branch merges it in, the way "Update branch" does. A conflict
// is resolved with `resolve` (path -> content). `branch` merges another branch instead; `evil` is written into the merge
// commit itself (an "evil merge": changes that are in neither parent). -> the merge commit.
export function mergeMainInto(w, files, { resolve = {}, branch = 'main', evil = {} } = {}) {
  w.repo.checkout(branch);
  for (const [file, content] of Object.entries(files)) w.repo.write(file, content);
  w.repo.commit('main moves on');
  w.repo.checkout('feat/x');
  try {
    w.repo.git(['merge', '--no-ff', ...(Object.keys(evil).length > 0 ? ['--no-commit'] : []), '-m', 'Merge main into feat/x', branch]);
    if (Object.keys(evil).length > 0) {
      for (const [file, content] of Object.entries(evil)) w.repo.write(file, content);
      w.repo.git(['add', '-A']);
      w.repo.git(['commit', '-q', '--no-edit']);
    }
  } catch (err) {
    if (Object.keys(resolve).length === 0) throw err;
    for (const [file, content] of Object.entries(resolve)) w.repo.write(file, content);
    w.repo.git(['add', '-A']);
    w.repo.git(['commit', '-q', '--no-edit']);
  }
  return w.repo.git(['rev-parse', 'HEAD']).trim();
}
// The real repo ignores .review/; the throwaway one commits everything with add -A, which would put round files into the diffs under test.
export function worldIgnoringReview(t, opts) {
  const w = world(t, opts);
  writeFileSync(join(w.repo.dir, '.git', 'info', 'exclude'), '.review/\n');
  return w;
}
export const patchOf = (w, n) => readFileSync(w.roundFile(n, 'diff.patch'), 'utf8');

// ---- triage validate / settle / light-lane ----------------------------------------------------

export const JUDGE_TAG = 'pipeline-judge R1 abcd1234';

export function judgeTranscript(w, decisions, { model = 'claude-sonnet-5-5', effort = 'medium', agentType = 'judge' } = {}) {
  const items = Object.entries(decisions).map(([id, [decision, confidence = 'high']]) => ({
    id, decision, confidence, reason: `judge: ${decision} ${id}`, disputedBug: false, settleTest: { possible: false, plan: '' },
  }));
  return installTranscript(w, {
    jsonl: transcript({ prompt: 'Triage round 1.', text: fenced({ items }), model, effort }),
    meta: { agentType, description: JUDGE_TAG },
  });
}
export const STANDARD_JUDGE = {
  'R1-B1': ['ACCEPT'], 'R1-S1': ['REJECT', 'high'], 'R1-S2': ['REJECT', 'low'], 'R1-W1': ['FOLLOW-UP'],
};

// ---- arbiter needed / apply -------------------------------------------------------------------

export function readyForArbiter(t, opts, decisions = STANDARD_JUDGE) {
  const w = world(t, opts);
  assertExit(w.codex(1, standardFindings()), 0);
  assertExit(w.judge(1, decisions), 0);
  return w;
}

export const SORT_RULINGS = {
  rulings: [
    { id: 'R1-S1', ruling: 'REJECT', confidence: 'high', reasoning: 'src/b.js:3 already covers this.' },
    { id: 'R1-S2', ruling: 'ACCEPT', confidence: 'high', reasoning: 'src/b.js:5 really is duplicated.' },
  ],
};
export const promptFor = (digest, round = 1) => `ROUND: ${round}\nINPUT-DIGEST: ${digest}\nRead the input file and rule on every item.`;

export function arbiterRun(w, { text, prompt, model, effort, meta = {}, env = {}, agentId = 'a1', extraArgs = [], jsonl } = {}) {
  const needed = w.state().rounds[0].arbiter;
  const projects = installTranscript(w, {
    agentId,
    jsonl: jsonl ?? transcript({ prompt: prompt ?? promptFor(needed.inputDigest), text: text ?? fenced(SORT_RULINGS), model, effort }),
    meta: { agentType: 'arbiter', description: needed.tag, ...meta },
  });
  return w.cli(['arbiter', 'apply', '--round', '1', '--projects-dir', projects, ...extraArgs], env);
}

// What the unproven paths must all do: exit 1, every arbitrated item needsHuman, the judge's decision kept as the
// fallback, model-proof.json recording the failure.
export function assertAllNeedHuman(w, r, errorPattern) {
  assertExit(r, 1, r.stderr + JSON.stringify(r.json));
  assert.equal(r.json.ok, false);
  assert.ok(r.json.errors.some((e) => errorPattern.test(e)), `errors ${JSON.stringify(r.json.errors)} should match ${errorPattern}`);
  for (const id of ['R1-S1', 'R1-S2']) {
    const item = w.item(id);
    assert.equal(item.final.needsHuman, true, id);
    assert.equal(item.final.by, 'arbiter');
    assert.equal(item.final.decision, 'REJECT', 'falls back to the judge\'s decision, never the unproven ruling');
    assert.match(item.final.reason, /model-proof failed/);
    assert.equal(item.arbiter.ruling, null);
    assert.equal(item.arbiter.reasoning, 'unverified');
  }
  assert.equal(w.item('R1-B1').final.needsHuman, false, 'items that never went to the arbiter are unaffected');
  const proof = JSON.parse(readFileSync(w.roundFile(1, 'model-proof.json'), 'utf8'));
  assert.equal(proof.ok, false);
  assert.ok(proof.errors.length > 0);
  assert.equal(JSON.parse(readFileSync(w.roundFile(1, 'rulings.json'), 'utf8')).proofOk, false);
  assert.equal(w.state().rounds[0].modelProof, undefined, 'a failed proof is not recorded as one');
}

// cp #151: git's paths are decoded as UTF-8, so two different non-UTF-8 file names would collapse to the same U+FFFD string and
// ownAuthored could count a merge-only file as ordinarily authored. A path that does not round-trip is refused (base-unresolved).
export const BAD_NAME = Buffer.from([0x73, 0x72, 0x63, 0x2f, 0x80, 0x2e, 0x6a, 0x73]); // 'src/' + a lone 0x80 byte + '.js'
export const fixSrcA = (w) => w.repo.write('src/a.js', aFile(true).replace('compute(x.y)', 'compute(x?.y)'));
export const refusedUnresolved = (w) => {
  const before = w.stateText();
  const refused = w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']);
  assertExit(refused, 2, refused.stderr + refused.stdout);
  assert.equal(refused.json.error, 'base-unresolved');
  assert.equal(w.stateText(), before, 'nothing was marked');
};

// A conflicting base merge cannot be separated from the PR's own change by a trial merge, so the PR's work since round N is
// measured from the merge commit that resolved the conflict (the latest one on the PR's first-parent history whose other parent
// is the default branch carrying the current fork point).
export const conflictMerge = (w, extra = {}) =>
  mergeMainInto(w, { 'src/a.js': aFile(false).replace('v12 = 12', 'v12 = 1200'), 'src/from-main.js': 'export const other = 1;\n', ...extra }, { resolve: { 'src/a.js': aFile(true) } });
export const acceptedWorld = (t) => {
  const w = worldIgnoringReview(t);
  assertExit(w.codex(1, findingsOf([finding()])), 0);
  assertExit(w.judge(1, { 'R1-B1': ['ACCEPT'] }), 0);
  return w;
};
export const fixA = (w) => {
  w.repo.write('src/a.js', aFile(true).replace('compute(x.y)', 'compute(x?.y)'));
  return w.repo.commit('fix');
};

// ---- cp #120: a file counts as the fix only when an ordinary (non-merge) commit of the PR wrote its current content --------------

// A hand edit typed into a merge commit (an "evil merge": a tree that differs from the automatic merge of its parents) is not the PR's
// fix, whichever merge it is in and whichever base the measurement starts from.
export const NOT_WRITTEN = /was not written by an ordinary commit of this PR/;
export const markA = (w) => w.cli(['state', 'mark-implemented', '--ids', 'R1-B1']);
export const refusedAs = (w, named) => {
  const r = markA(w);
  assertExit(r, 2, r.stderr + r.stdout);
  assert.equal(r.json.error, 'no-code-change');
  assert.match(r.json.message, NOT_WRITTEN);
  assert.match(r.json.message, named);
  assert.equal(w.item('R1-B1').implemented, undefined);
  return r;
};
export const countedAs = (w) => {
  const r = markA(w);
  assertExit(r, 0, r.stderr + r.stdout);
  assert.equal(w.item('R1-B1').implemented, true);
};
export const SMUGGLED = { 'src/smuggled.js': 'export const evil = true;\n' };
export const FROM_MAIN = { 'src/from-main2.js': 'export const other2 = 1;\n' };

// ---- review-complete --------------------------------------------------------------------------

export const REMOVE_LABEL = { match: '^pr edit 7 --remove-label awaiting-review', code: 0 };
// What review-complete asks and posts: who we are, our earlier comments (none), then the new marker comment.
export const REVIEW_COMMENT = [
  { match: '^api user', stdout: 'me\n' },
  { match: 'issues/7/comments --paginate', stdoutJson: [] },
  { match: '^api -X POST repos/acme/widgets/issues/7/comments ', stdoutJson: { id: 77, html_url: 'https://github.com/acme/widgets/pull/7#issuecomment-77' } },
];
// review-complete now publishes the triage state first, so the bodies posted include a triage comment: these are the review-complete markers.
export const postedBodies = (w) => w.fake.calls().filter((c) => c.argv.join(' ').startsWith(`api -X POST repos/${w.slug}/issues/7/comments `)).map((c) => JSON.parse(c.stdin).body).filter((b) => b.startsWith('<!-- claude-pipeline:review-complete'));
export const reviewJson = (body) => JSON.parse(/```json\n(.*)\n```/.exec(body)[1]);

// The recheck nudge: a ready PR gets no event from a comment, so review-complete adds and removes `pipeline-recheck`.
export const RECHECK_ADD = 'pr edit 7 --add-label pipeline-recheck';
export const RECHECK_REMOVE = 'pr edit 7 --remove-label pipeline-recheck';
export const RECHECK_OK = [{ match: '^pr edit 7 --add-label pipeline-recheck', code: 0 }, { match: '^pr edit 7 --remove-label pipeline-recheck', code: 0 }];
// The PR as the first look (headRefOid, isDraft, labels) sees it; the read-back after removing awaiting-review is a later, separate look.
export const PR_VIEW_AFTER = { match: '^pr view 7 --json labels', stdoutJson: { labels: [] } };
export const gotPr = (view) => GH.map((e) => (e.match === '^pr view 7' ? { ...e, stdoutJson: { ...e.stdoutJson, ...view } } : e));

// A world whose only change is to a path the config sends to Fable every round, at low risk.
export const SENSITIVE_YML = `${pipelineYml()}review:\n  arbiter_always_paths: [src/a.js]\n`;
export const FABLE_CLEAN = { rulings: [], findings: [] };

// Round 1: a proven Fable pass raises finding1 (FOLLOW-UP). Round 2 (an unrelated change): Fable raises it again as ACCEPT.
export function twoFableRounds(t) {
  const w = world(t, { yml: SENSITIVE_YML });
  assertExit(w.codex(1, findingsOf()), 0);
  assertExit(w.cli(['arbiter', 'needed', '--round', '1']), 0);
  const finding1 = {
    bucket: 'SUGGESTION', category: 'maintainability', title: 'Name w3 better', file: 'src/b.js', line: 3, detail: 'w3 says nothing',
    ruling: 'FOLLOW-UP', confidence: 'high', reasoning: 'src/b.js:3 is a vague name',
  };
  assertExit(arbiterRun(w, { text: fenced({ rulings: [], findings: [finding1] }) }), 0);
  w.repo.write('src/a.js', aFile(true).replace('compute(x.y)', 'compute(x?.y)'));
  const head2 = w.repo.commit('unrelated change');
  assertExit(w.codex(2, findingsOf(), { from: w.head, to: head2 }), 0);
  const needed2 = w.cli(['arbiter', 'needed', '--round', '2']);
  assert.deepEqual([needed2.json.mode, needed2.json.scope], ['review', 'round']);
  const applyRound2 = (agentId) => w.cli(['arbiter', 'apply', '--round', '2', '--projects-dir', installTranscript(w, {
    agentId,
    jsonl: transcript({ prompt: promptFor(needed2.json.digest, 2), text: fenced({ rulings: [], findings: [{ ...finding1, ruling: 'ACCEPT' }] }) }),
    meta: { agentType: 'arbiter', description: needed2.json.tag },
  })]);
  return { w, applyRound2 };
}

// ---- review fixes: bind the range, guard cache reuse and settle, lock the state ----------------

// Add `edit(fn)` to a world: change the state file the way an earlier (hypothetical) step would have left it.
export const editState = (w, fn) => {
  const s = w.state();
  fn(s);
  writeFileSync(join(w.repo.dir, '.review', 'state.json'), JSON.stringify(s, null, 2));
};
export const noState = (w) => !existsSync(join(w.repo.dir, '.review', 'state.json'));
export const DISPUTED = { disputedBug: true, settleTest: { possible: true, plan: 'write a failing test' } };

// -- triage settle: the pipeline runs the proving test itself

// A world whose R1-B1 is a disputed BLOCKING bug (or security item) a test can decide.
export function disputedWorld(t, category = 'bug') {
  const w = world(t);
  assertExit(w.codex(1, findingsOf([finding({ category })])), 0);
  assertExit(w.judge(1, { 'R1-B1': ['REJECT', 'high', DISPUTED] }), 0);
  return w;
}

// ---- review replay: published state wins (state show --pr, discard-round) ---------------------------------

export const ISSUES_URL = '^api repos/acme/widgets/issues\\?creator=me&state=all&per_page=100 --paginate';
export const COMMENTS = (...comments) => [
  { match: '^api user', stdout: 'me\n' },
  { match: 'issues/7/comments --paginate', stdoutJson: comments },
];
export const mine = (state, id = 9) => ({ id, user: { login: 'me' }, body: triageComment(state) });

// A local one-round review (codex + judge) whose triage comment is already on the PR: the fake GitHub is scripted with the
// state this very world produced, so heads and hashes agree whatever the clock did.
export function publishedWorld(t) {
  const w = world(t);
  assertExit(w.codex(1, standardFindings()), 0);
  assertExit(w.judge(1, STANDARD_JUDGE), 0);
  const published = w.state();
  const script = JSON.parse(readFileSync(join(w.fake.dir, 'script.json'), 'utf8'));
  // (the comments come FIRST: the world's own script ends with the empty-comments fallback, and the first match wins)
  w.fake.setScript([...COMMENTS(mine(published)), ...script]);
  return { w, published };
}
export const staleDirs = (w) => readdirSync(join(w.repo.dir, '.review')).filter((n) => n.startsWith('stale-'));

// ---- followups create: marker dedupe ----------------------------------------------------------------------

export const FP_ISSUE = (w) => `${'<!-- claude-pipeline:followup pr=7 fp='}${w.item('R1-W1').fingerprint} -->`;
export const issue = (number, body, over = {}) => ({ number, html_url: `https://github.com/acme/widgets/issues/${number}`, state: 'open', body, user: { login: 'me' }, ...over });

export function followupWorld(t, issues, { post = { number: 50, html_url: 'https://github.com/acme/widgets/issues/50' } } = {}) {
  const w = world(t, {
    gh: [...GH, { match: '^api user', stdout: 'me\n' }, { match: ISSUES_URL, stdoutJson: issues }, { match: '^api -X POST repos/acme/widgets/issues ', stdoutJson: post }],
  });
  assertExit(w.codex(1, findingsOf([], [], [finding({ title: 'Idea', category: 'other', testable: false })])), 0);
  assertExit(w.judge(1, { 'R1-W1': ['FOLLOW-UP'] }), 0);
  return w;
}
export const posts = (w) => w.fake.calls().filter((c) => c.argv.join(' ').startsWith('api -X POST repos/acme/widgets/issues '));

// #268: the creator scan is bounded by the PR's creation time (minus an hour) when it can be read.
export const GH_CREATED = (createdAt) => [{ match: '^pr view 7', stdoutJson: { title: 'Add compute', body: 'Adds compute() to a.js', headRefName: 'feat/x', createdAt } }, GH[1]];
export function sinceWorld(t, createdAt, issues, { issuesReply } = {}) {
  const w = world(t, {
    gh: [...GH_CREATED(createdAt), { match: '^api user', stdout: 'me\n' }, { match: '^api repos/acme/widgets/issues\\?creator=me&state=all&per_page=100', ...(issuesReply ?? { stdoutJson: issues }) },
      { match: '^api -X POST repos/acme/widgets/issues ', stdoutJson: { number: 50, html_url: 'https://github.com/acme/widgets/issues/50' } }],
  });
  assertExit(w.codex(1, findingsOf([], [], [finding({ title: 'Idea', category: 'other', testable: false })])), 0);
  assertExit(w.judge(1, { 'R1-W1': ['FOLLOW-UP'] }), 0);
  return w;
}
export const scanLines = (w) => w.fake.lines().filter((l) => /issues\?creator=me/.test(l));

// ---- triage owner-ruling (owner_approval: chat) -----------------------------------------------

export const CHAT_YML = `${pipelineYml()}owner_approval: chat\n`;
// (an owner answer to a ruling request is only the decisions: hooks/lib/owner-go.mjs rulingsIn)
export const QUOTE = 'R1-B1: follow-up.';
export const REJECT_QUOTE = 'R1-S1: reject';
export const ACCEPT_QUOTE = 'R1-B1: accept';

// A round whose listed items an arbiter left waiting for a human (what `arbiter apply` does on a failed model proof).
export function waitingForHuman(w, decisions) {
  const state = w.state();
  for (const item of state.rounds[0].items) {
    if (decisions[item.id]) item.final = { decision: decisions[item.id], by: 'arbiter', needsHuman: true, reason: 'model-proof failed' };
  }
  writeFileSync(join(w.repo.dir, '.review', 'state.json'), JSON.stringify(state));
}
// Phase 3b: the owner's answer to a ruling request for PR #7's items, as the owner-go recorder writes it down.
// #110: the line carries the digest `triage ruling-request` prints for the CURRENT state (ids the state does not have get a placeholder).
export const askedContent = (w, ids) => {
  const r = w.cli(['triage', 'ruling-request', '--pr', '7', '--ids', ids.join(',')]);
  return r.code === 0 ? / · content ([0-9a-f]{12}) · /.exec(r.json.line)[1] : '0'.repeat(12);
};
export const ownerAnswers = (w, t, { prompt = QUOTE, ids = ['R1-B1'], pr = 7, repo = w.slug, content } = {}) =>
  ownerRules(t, prompt, rulingRequest(pr, ids, repo, content === undefined ? askedContent(w, ids) : content));
export const rule = (id, decision, { quote = QUOTE, reason = 'owner confirmed in chat', extra = [] } = {}) =>
  ['triage', 'owner-ruling', '--round', '1', '--id', id, '--decision', decision, '--reason', reason, '--owner-quote', quote, ...extra];

// A Fable item that waits for a human (low confidence), as the arbiter pass leaves it.
export const addFableItem = (w) => editState(w, (s) => {
  s.rounds[0].items.push(...fableFindingItems([{
    bucket: 'BLOCKING', category: 'auth', title: 'role check skipped', file: 'lib/auth.ts', line: 3, detail: 'a guest reaches it',
    ruling: 'ACCEPT', confidence: 'low', reasoning: 'lib/auth.ts:3 returns early',
  }], 1));
});

// The same id, a different finding: the owner's recorded ruling must not carry over.
export const CHANGES = [
  ['detail', (i) => { i.detail = 'a different explanation of the problem'; }, 'R1-B1'],
  ['title', (i) => { i.title = 'Something else entirely'; }, 'R1-B1'],
  ['codexReasoning', (i) => { i.codexReasoning = 'new reasoning'; }, 'R1-B1'],
  ['file', (i) => { i.file = 'src/z.js'; }, 'R1-B1'],
  ['line', (i) => { i.line = 99; }, 'R1-B1'],
  ['category', (i) => { i.category = 'security'; }, 'R1-B1'],
  ['bucket', (i) => { i.bucket = 'SUGGESTION'; }, 'R1-B1'],
  ['a Fable item\'s detail', (i) => { i.detail = 'nobody reaches it'; }, 'R1-F1'],
  ['a Fable item\'s arbiter.reasoning', (i) => { i.arbiter.reasoning = 'a different reason'; }, 'R1-F1'],
];

// ---- a conflict with main resolved by choosing lines: a resolution-only round --------------------------------

// Main edits the very line (src/a.js 12) the PR changed, so the merge conflicts; the resolver keeps the PR's side. Whatever is in
// src/a.js on the branch right now is what the resolver keeps. -> the merge commit.
export const MAIN_EDITS_V12 = () => aFile(false).replace('v12 = 12', 'v12 = 1200');
export function conflictKeepingOurs(w, extra = {}) {
  const ours = readFileSync(join(w.repo.dir, 'src/a.js'), 'utf8');
  return mergeMainInto(w, { 'src/a.js': MAIN_EDITS_V12(), 'src/from-main.js': 'export const other = 1;\n', ...extra }, { resolve: { 'src/a.js': ours } });
}
export const MAX1 = `${pipelineYml()}review:\n  max_rounds: 1\n`;

// ---- Fable's slice of a 'conflict' round (#423) -------------------------------------------------------------------------------------------------------------------

// A Fable PR (src/a.js is an arbiter path, src/guard.js carries a threat model) after a proven round-1 pass: main edits a.js (text conflict), a text file whose PR side is shaped like a section
// heading, and a binary the PR also changed; the resolver keeps the PR's side of all three, then the PR commits src/c.js. -> { w, needed2, head2 } (`arbiter needed --round 2`).
export const FRAMED = '## Conflicted path: not-a-real-heading\nRecord: not a record\n';
export function conflictFableWorld(t) {
  const yml = `${SENSITIVE_YML}  threat_models:\n    - name: guards\n      paths: [src/guard.js]\n      text: "Attackers are other repo users, not the owner."\n`;
  const w = worldIgnoringReview(t, { yml, baseFiles: { 'docs/n.txt': 'base\n', 'assets/x.bin': 'BASE\0data\n' }, featFiles: { 'src/guard.js': 'export const guard = 1;\n', 'docs/n.txt': FRAMED, 'assets/x.bin': 'PR\0data\n' } });
  assertExit(w.codex(1, findingsOf()), 0);
  assertExit(w.cli(['arbiter', 'needed', '--round', '1']), 0);
  assertExit(arbiterRun(w, { text: fenced(FABLE_CLEAN) }), 0);
  const ours = (p) => readFileSync(join(w.repo.dir, p), 'utf8');
  mergeMainInto(w, { 'src/a.js': MAIN_EDITS_V12(), 'src/from-main.js': 'export const other = 1;\n', 'docs/n.txt': 'main side\n', 'assets/x.bin': 'MAIN\0data\n' },
    { resolve: { 'src/a.js': ours('src/a.js'), 'docs/n.txt': FRAMED, 'assets/x.bin': 'PR\0data\n' } });
  w.repo.write('src/c.js', 'export const c = 1;\n');
  const head2 = w.repo.commit('later pr commit');
  w.prHead(head2);
  assertExit(w.codex(2, findingsOf(), { from: w.head, to: head2 }), 0);
  const needed2 = w.cli(['arbiter', 'needed', '--round', '2']);
  assertExit(needed2, 0, needed2.stderr + needed2.stdout);
  return { w, needed2, head2 };
}
export const applyRound2 = (w, needed) => w.cli(['arbiter', 'apply', '--round', '2', '--projects-dir', installTranscript(w, {
  agentId: 'a2', jsonl: transcript({ prompt: promptFor(needed.json.digest, 2), text: fenced(FABLE_CLEAN) }), meta: { agentType: 'arbiter', description: needed.json.tag },
})]);

// ---- owner-granted extra round (owner_approval: chat) ------------------------------------------------------------
// The owner's `extra round` is recorded by the owner-go hook after a reply ending with `triage round-request`'s line; codex-review claims it
// AFTER Codex answered, under the final lock, by exclusively creating a machine-global marker (claimGrantMarkers).

export const CAP1_CHAT = `${pipelineYml()}review:\n  max_rounds: 1\nowner_approval: chat\n`;
export const CAP1_LABEL = `${pipelineYml()}review:\n  max_rounds: 1\n`;
export const CAP2_CHAT = `${pipelineYml()}review:\n  max_rounds: 2\nowner_approval: chat\n`;

// Round n finds one blocking item, the judge accepts it and the fix is committed and marked implemented. -> the fix commit.
export function reviewAndFix(w, n, from, to) {
  const found = w.codex(n, findingsOf([finding({ title: `Issue ${n}`, file: 'src/b.js', line: 2 })]), { from, to });
  assertExit(found, 0, found.stderr + found.stdout);
  assertExit(w.judge(n, { [`R${n}-B1`]: ['ACCEPT'] }), 0);
  w.repo.write(`src/fix${n}.js`, `export const fix${n} = ${n};\n`);
  const fixed = w.repo.commit(`fix ${n}`);
  assertExit(w.cli(['state', 'mark-implemented', '--ids', `R${n}-B1`]), 0);
  return fixed;
}
// max_rounds 1: round 1, then the one automatic extra round (2); both only accepted fixes. Round 3 now needs the owner.
export function atCap(t, yml = CAP1_CHAT, gh = GH) {
  const w = ownerWorld(t, { yml, gh });
  const h1 = reviewAndFix(w, 1, w.base, w.head);
  const h2 = reviewAndFix(w, 2, w.head, h1);
  return { w, h1, h2 };
}
// The owner types `extra round` after a reply ending with the request line. The marker its use leaves is removed afterwards.
export function ownerGrantsRound(w, t, { pr = 7, k, head, prompt = 'extra round', repo = w.slug }) {
  const record = ownerGrants(t, prompt, roundRequest(pr, k, head, repo));
  assert.ok(record, 'the recorder wrote the grant');
  cleanupAtExit(markerPath(grantIdOf(record)));
  t.after(() => rmSync(markerPath(grantIdOf(record)), { force: true }));
  // #472 (F4): the codex-review that claims the grant also writes a round ticket and sweeps the markers of the round's other grants into the account home: remove exactly those (w.slug is unique to the test).
  cleanupRoundClaims({ slug: w.slug, pr, k, grantIds: [grantIdOf(record)], t });
  return record;
}
export const codexThree = (w, from, to, extra = {}) => w.codex(3, findingsOf(), { from, to, ...extra });

// ---- old Fable proofs are re-reviewed: state fable-refresh, review-complete and the final gate (plan 2026-11-10 A4b) -------------------

export const OLD_FABLE = 'claude-fable-5-1';
// Round 1 of a Fable PR, proven by a real 5.2 transcript, then rewritten so the state records the OLD Fable (a proof made before this pipeline knew the floor).
export function oldProofWorld(t, { models = { [OLD_FABLE]: 1 }, yml = SENSITIVE_YML, baseFiles = {} } = {}) {
  const w = world(t, { gh: [...GH, REMOVE_LABEL, ...REVIEW_COMMENT], yml, baseFiles });
  assertExit(w.codex(1, findingsOf()), 0);
  assertExit(w.cli(['arbiter', 'needed', '--round', '1']), 0);
  assertExit(arbiterRun(w, { text: fenced(FABLE_CLEAN) }), 0);
  editState(w, (s) => { s.rounds[0].modelProof.models = models; });
  return w;
}
export const refreshOf = (w) => w.cli(['state', 'fable-refresh', '--pr', '7']);
// `arbiter needed` + a proving transcript for round n (the model the transcript names decides what is recorded).
export function proveRound(w, n, { model, text = fenced(FABLE_CLEAN), env = {} } = {}) {
  const needed = w.cli(['arbiter', 'needed', '--round', String(n)], env);
  assertExit(needed, 0, needed.stdout + needed.stderr);
  const projects = installTranscript(w, {
    agentId: `a${n}`, jsonl: transcript({ prompt: promptFor(needed.json.digest, n), text, model }), meta: { agentType: 'arbiter', description: needed.json.tag },
  });
  return { needed, applied: w.cli(['arbiter', 'apply', '--round', String(n), '--projects-dir', projects], env) };
}
export async function gateReview(w, floor = SHARED_FLOOR_DIR) {
  const { config } = await loadConfig(w.repo.dir);
  return reviewCheck({
    root: w.repo.dir, config, pr: 7, repo: w.slug, readOnly: true, hash: currentContentHash(w.repo.dir, config), hashError: null, floorOpts: { dir: floor },
    diff: () => ({ ok: true, files: [{ path: 'src/a.js', oldPath: 'src/a.js', newPath: 'src/a.js', status: 'M', binary: false, added: [{ line: 1, text: 'x' }], removed: [] }] }),
  });
}