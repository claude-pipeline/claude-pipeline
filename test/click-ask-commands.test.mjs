// #261 (click-to-approve, PR A, plan Rev 6 B6): `--ask` on `merge --dry-run --owner-go`, the merge-many form (`--prs`), `triage round-request` and `triage ruling-request`. The commands run IN PROCESS
// (run(argv, ctx)) with a temp account home (ctx.home, the same seam `pipeline owner-go` has) so the asks, the dialog-hook list and the owner-go folder are never the developer's real ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cli, ghEntries, PR, REPO, scenario, ymlFor } from './helpers/gate-env.mjs';
import { addRound, emptyState, saveState } from '../pipeline/lib/state.mjs';
import { loadConfig } from '../pipeline/lib/config.mjs';
import { toPosix } from '../pipeline/lib/paths.mjs';
import { presentedRequests, presentedRoundRequest, presentedRuling, readyLine } from '../pipeline/hooks/lib/owner-go.mjs';
import { asksDir, issueAsk, readAsk, roundAsk } from '../pipeline/hooks/lib/owner-go-click.mjs';
import { run as mergeRun, dryRunMany, withAsk } from '../pipeline/commands/merge.mjs';
import { run as triageRun } from '../pipeline/commands/triage.mjs';

const homes = [];
process.on('exit', () => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });
// A temp account home with an empty ~/.claude: no dialog hook at all, so the hook check passes.
function newHome() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'click-ask-')));
  mkdirSync(join(home, '.claude'), { recursive: true });
  homes.push(home);
  return home;
}
const asks = (home) => (existsSync(asksDir(home)) ? readdirSync(asksDir(home)) : []);
// A dialog hook (PreToolUse on AskUserQuestion, or PermissionRequest) that the owner has not listed.
function addDialogHook(home, event = 'PreToolUse') {
  const dir = join(home, '.claude', 'hooks');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'notify.mjs'), 'process.exit(0)\n');
  const entry = { ...(event === 'PreToolUse' ? { matcher: 'AskUserQuestion' } : {}), hooks: [{ type: 'command', command: `node ${toPosix(join(dir, 'notify.mjs'))}` }] };
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { [event]: [entry] } }));
}

const CHAT = (extra = '') => `${ymlFor()}owner_approval: chat\n${extra}`;
// #713: a click is only asked on a Claude Code build the recorder accepts (CLICK_BUILDS), read from AI_AGENT: every test here runs as one of them unless it sets another.
const baseEnv = (s) => ({ ...process.env, AI_AGENT: 'claude-code_2-1-323_agent', PIPELINE_MERGEABLE_PAUSE_MS: '1', PIPELINE_MACHINE_ID: 'click-ask-test', ...s.fake.env, ...s.env });
// What GitHub says about the PR for the dry run (see merge-dry-run.test.mjs).
const prView = (s) => ({ match: '^pr view 12 --json state,headRefOid.*baseRefOid', stdoutJson: { state: 'OPEN', headRefOid: s.head, baseRefName: 'main', isDraft: false, labels: [], mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', baseRefOid: s.baseTip } });
const script = (s, gh = {}) => [REPO, prView(s), ...ghEntries({ prHead: s.head, prFiles: s.prFiles, baseOid: s.baseTip, mergeStateStatus: 'CLEAN', ...gh })]; // (baseOid: an up-to-date PR's compare names its base commit as the tip)
const mergeArgs = (...more) => ['--pr', String(PR), '--dry-run', '--owner-go', ...more];
const mergeCtx = (s, home) => ({ cwd: s.repo.dir, env: baseEnv(s), home, managedPaths: [] });
async function dry(s, { home, args = ['--ask'], gh } = {}) {
  s.fake.setScript(script(s, gh));
  return mergeRun(mergeArgs(...args), mergeCtx(s, home));
}
const chatWorld = (yml = CHAT()) => scenario({ yml, report: null, state: null, gh: { mergeStateStatus: 'CLEAN' } });

// ---- merge --pr N --dry-run --owner-go --ask --------------------------------------------------------------------------------------------------

test('merge --ask: a say-merge issues the ask; the question is the title and EXACTLY ownerStep.closing; the ask file is written and binds this PR', async () => {
  const s = chatWorld();
  const home = newHome();
  const r = await dry(s, { home });
  assert.equal(r.exitCode, 0, JSON.stringify(r.output));
  const { ownerStep, ask } = r.output;
  assert.equal(ownerStep.kind, 'say-merge');
  assert.match(ask.askId, /^ask-[0-9a-f]{12}$/);
  assert.equal(ask.questions.length, 1);
  const q = ask.questions[0];
  assert.equal(q.question, `Merge #${PR}? (${ask.askId})\n\n${ownerStep.closing}`);
  assert.equal(q.multiSelect, false);
  assert.deepEqual(q.options.map((o) => o.label), ['Not yet', 'Merge']);
  assert.ok(q.options.every((o) => !('preview' in o)));
  // what the owner-go hook reads from the question is the request this dry run printed
  const { requests } = presentedRequests(q.question);
  assert.deepEqual(requests.map((x) => [x.pr, x.head, x.repo]), [[PR, s.head.slice(0, 12), 'acme/widgets']]);
  const file = readAsk(ask.askId, { home });
  assert.equal(file.ok, true);
  assert.deepEqual(file.ask.prs, [PR]);
  assert.equal(file.ask.kind, 'merge');
  assert.match(file.ask.hookLayersSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(asks(home), [`${ask.askId}.json`]);
});

test('merge --ask: a second ask for the same PR supersedes the first', async () => {
  const s = chatWorld();
  const home = newHome();
  const a = (await dry(s, { home })).output.ask.askId;
  const b = (await dry(s, { home })).output.ask.askId;
  assert.notEqual(a, b);
  assert.deepEqual(asks(home).sort(), [`${a}.json`, `${a}.superseded`, `${b}.json`].sort());
});

test('merge --dry-run --owner-go WITHOUT --ask writes no ask and prints no ask fields (C7: the plain dry run writes nothing)', async () => {
  const s = chatWorld();
  const home = newHome();
  const r = await dry(s, { home, args: [] });
  assert.equal(r.exitCode, 0);
  assert.equal('ask' in r.output, false);
  assert.equal('askSkipped' in r.output, false);
  assert.deepEqual(asks(home), []);
  assert.deepEqual(readdirSync(join(home, '.claude')), [], 'nothing at all was written under the account home');
});

test('merge --ask: label mode -> ask null, askSkipped names owner_approval; nothing is written', async () => {
  const s = chatWorld(ymlFor());
  const home = newHome();
  const r = await dry(s, { home });
  assert.equal(r.output.ask, null);
  assert.match(r.output.askSkipped, /owner_approval is not chat/);
  assert.deepEqual(asks(home), []);
});

// #713: the recorder refuses a click from a build outside CLICK_BUILDS (build-not-allowlisted), so no ask is issued there: the owner would get a button that is then refused.
test('merge --ask: an allowlisted build issues the ask; another build or an unknown one gets ask null and askSkipped, nothing written (#713)', async () => {
  const s = chatWorld();
  const askedAs = async (home, AI_AGENT) => {
    s.fake.setScript(script(s));
    const env = { ...baseEnv(s), AI_AGENT };
    if (AI_AGENT === undefined) delete env.AI_AGENT;
    return mergeRun(mergeArgs('--ask'), { ...mergeCtx(s, home), env });
  };
  for (const build of ['claude-code_2-1-322_agent', 'claude-code_2-1-323_agent', 'claude-code_2-1-332_agent']) {
    const r = await askedAs(newHome(), build);
    assert.match(r.output.ask?.askId ?? '', /^ask-[0-9a-f]{12}$/, build);
  }
  const other = newHome();
  const o = await askedAs(other, 'claude-code_2-1-330_agent');
  assert.equal(o.output.ask, null);
  assert.equal(o.output.askSkipped, 'build 2.1.330 not allowlisted for clicks (verified builds: 2.1.322, 2.1.323, 2.1.332; the owner types instead)');
  assert.deepEqual(asks(other), []);
  for (const agent of [undefined, 'something-else']) {
    const unknown = newHome();
    const u = await askedAs(unknown, agent);
    assert.equal(u.output.ask, null);
    assert.equal(u.output.askSkipped, 'the running Claude Code build is unknown, so a click cannot be verified (the owner types instead)');
    assert.deepEqual(asks(unknown), []);
  }
});

test('merge --ask: owner_go.click off -> ask null, askSkipped says so', async () => {
  const s = chatWorld(CHAT('owner_go:\n  click: off\n'));
  const home = newHome();
  const r = await dry(s, { home });
  assert.equal(r.output.ask, null);
  assert.match(r.output.askSkipped, /owner_go\.click is off/);
  assert.deepEqual(asks(home), []);
});

test('merge --ask: a dialog hook the owner has not approved -> ask null, askSkipped carries the hook check\'s reason and the fix', async () => {
  const s = chatWorld();
  const home = newHome();
  addDialogHook(home);
  const r = await dry(s, { home });
  assert.equal(r.output.ask, null);
  assert.match(r.output.askSkipped, /^dialog hooks not approved: unlisted dialog hook ~\/\.claude\/hooks\/notify\.mjs[\s\S]*approve-dialog-hooks/);
  assert.deepEqual(asks(home), []);
});

test('merge --ask: blockers (a failing required check) -> no ask even though ownerStep is a say-merge', async () => {
  const s = chatWorld();
  const home = newHome();
  const r = await dry(s, { home, gh: { ci: [{ name: 'ci', state: 'FAILURE', bucket: 'fail' }] } });
  assert.equal(r.exitCode, 1);
  assert.equal(r.output.ownerStep.kind, 'say-merge');
  assert.equal(r.output.ask, null);
  assert.equal(r.output.askSkipped, 'blockers');
  assert.deepEqual(asks(home), []);
});

const OK_CONFIG = { owner_approval: 'chat', owner_go: { click: 'on' } };
const stepOf = (over = {}) => ({ kind: 'say-merge', line: `Head ${'a'.repeat(12)} · items none · repo acme/widgets`, closing: `Head ${'a'.repeat(12)} · items none · repo acme/widgets\n${readyLine([5])}`, ...over });

test('withAsk: an ownerStep that is not a say-merge, or a closing that binds nothing, is not asked (the reason is named)', () => {
  const home = newHome();
  const args = { root: tmpdir(), config: OK_CONFIG, pr: 5, slug: 'acme/widgets', ctx: { home, env: { AI_AGENT: 'claude-code_2-1-323_agent' }, managedPaths: [] } };
  for (const ownerStep of [null, { kind: 'owner-runs', command: 'x' }, { kind: 'owner-approval-flags', reason: 'x' }]) {
    const r = withAsk({ exitCode: 0, output: { ownerStep, blockers: [] } }, args);
    assert.equal(r.output.ask, null);
    assert.equal(r.output.askSkipped, 'not-say-merge');
  }
  const bad = withAsk({ exitCode: 0, output: { ownerStep: stepOf({ closing: 'nothing the hook could read' }), blockers: [] } }, args);
  assert.equal(bad.output.ask, null);
  assert.match(bad.output.askSkipped, /^the ask could not be issued: unbindable/);
  const other = withAsk({ exitCode: 0, output: { ownerStep: stepOf({ closing: `Head ${'a'.repeat(12)} · items none · repo acme/widgets\n${readyLine([6])}` }), blockers: [] } }, args);
  assert.match(other.output.askSkipped, /^the ask could not be issued/, 'a closing for another PR is never issued');
  assert.deepEqual(asks(home), []);
});

test('merge: --ask and --prs are usage errors without --dry-run --owner-go, and --prs excludes --pr and needs 2-4 distinct PRs', () => {
  const s = chatWorld();
  const run = (...args) => cli(['merge', ...args], { dir: s.repo.dir, fake: s.fake, env: s.env });
  const bad = [['--pr', '12', '--ask'], ['--pr', '12', '--dry-run', '--ask'], ['--pr', '12', '--owner-go', '--ask'], ['--prs', '12,13', '--dry-run', '--owner-go'], ['--pr', '12', '--prs', '12,13', '--dry-run', '--owner-go', '--ask'],
    ['--prs', '12', '--dry-run', '--owner-go', '--ask'], ['--prs', '12,12', '--dry-run', '--owner-go', '--ask'], ['--prs', '1,2,3,4,5', '--dry-run', '--owner-go', '--ask'], ['--prs', '12,x', '--dry-run', '--owner-go', '--ask']];
  for (const args of bad) {
    const r = run(...args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
  }
});

// ---- merge-many ----------------------------------------------------------------------------------------------------------------------------------

const manyStep = (pr, over = {}) => {
  const line = `Head ${String(pr).padStart(12, 'c')} · items none · repo acme/widgets`;
  return { kind: 'say-merge', line, ...over, closing: [over.rulings, over.areas, over.hold, line, readyLine([pr])].filter(Boolean).join('\n') };
};
const canned = (steps) => async (pr) => {
  const step = steps[pr];
  return { pr, wouldMerge: step?.kind === 'say-merge' && !step.blocked, blockers: step?.blocked ? [{ kind: 'live-check', detail: 'ci: red' }] : [], ownerStep: step ?? null, config: step?.config };
};
// The repo's config and `gh repo view` come from a real scenario (root is its worktree); the dry runs themselves are the canned seam.
async function many(prs, steps, { yml = CHAT(), home = newHome() } = {}) {
  const s = scenario({ yml, report: null, state: null });
  s.fake.setScript([REPO]);
  const { config } = await loadConfig(s.repo.dir);
  const r = await dryRunMany({ root: s.repo.dir, config, prs, ctx: { env: baseEnv(s), home, managedPaths: [] }, dryRunOf: canned(steps) });
  return { r, home };
}

test('merge-many: two ready PRs -> one multi-select question; each PR\'s Areas / Head lines are #N-prefixed, ONE 🔀 line; the hook reads both requests', async () => {
  const { r, home } = await many([12, 13], { 12: manyStep(12, { areas: 'Areas auth rls' }), 13: manyStep(13) });
  assert.equal(r.exitCode, 0);
  assert.equal(r.output.ok, true);
  assert.deepEqual(r.output.prs.map((p) => [p.pr, p.included]), [[12, true], [13, true]]);
  const q = r.output.ask.questions[0];
  assert.equal(q.multiSelect, true);
  assert.deepEqual(q.options.map((o) => o.label), ['Merge #12', 'Merge #13']);
  const block = ['#12 Areas auth rls', `#12 ${manyStep(12).line}`, `#13 ${manyStep(13).line}`, readyLine([12, 13])].join('\n');
  assert.ok(q.question.endsWith(`\n\n${block}`), q.question);
  assert.equal(q.question.split('\n').filter((l) => l.includes('🔀')).length, 1);
  const read = presentedRequests(q.question);
  assert.deepEqual(read.prs, [12, 13]);
  assert.deepEqual(read.requests.map((x) => [x.pr, x.head, x.repo, x.areas !== undefined]), [[12, `${'c'.repeat(10)}12`, 'acme/widgets', true], [13, `${'c'.repeat(10)}13`, 'acme/widgets', false]]);
  assert.deepEqual(readAsk(r.output.ask.askId, { home }).ask.prs, [12, 13]);
});

test('merge-many: a PR with a Rulings block, a Hold, a blocker or another ending is excluded with its reason; the rest are asked', async () => {
  const rulings = 'Rulings 0123456789ab\nR1-B1 · REJECT · BLOCKING · security · by claude · content 0123456789ab · "x" · why: y';
  const hold = 'Hold LE_1 by jamila at 2026-11-05T09:00:00Z';
  const steps = { 12: manyStep(12), 13: manyStep(13), 14: manyStep(14, { rulings, rulingCount: 1 }), 15: manyStep(15, { hold, ready: readyLine([15], { lift: true }) }) };
  const { r } = await many([12, 13, 14, 15], steps);
  assert.deepEqual(r.output.prs.map((p) => [p.pr, p.included, p.excludedReason]), [[12, true, undefined], [13, true, undefined], [14, false, 'rulings'], [15, false, 'hold']]);
  assert.deepEqual(r.output.ask.questions[0].options.map((o) => o.label), ['Merge #12', 'Merge #13']);
  assert.ok(r.output.ask.questions[0].question.endsWith(readyLine([12, 13])));
  const b = await many([12, 13, 14], { 12: manyStep(12), 13: manyStep(13, { blocked: true }), 14: { kind: 'owner-runs', command: 'x' } });
  assert.deepEqual(b.r.output.prs.map((p) => [p.included, p.excludedReason]), [[true, undefined], [false, 'blockers'], [false, 'not-say-merge']]);
  assert.equal(b.r.output.ask, null);
  assert.equal(b.r.output.askSkipped, 'fewer-than-two-ready');
  assert.deepEqual(asks(b.home), []);
});

test('merge-many: fewer than two ready -> ask null, askSkipped fewer-than-two-ready (the skill asks per PR)', async () => {
  const { r, home } = await many([12, 13], { 12: manyStep(12) });
  assert.equal(r.output.ask, null);
  assert.equal(r.output.askSkipped, 'fewer-than-two-ready');
  assert.equal(r.output.prs.find((p) => p.pr === 13).excludedReason, 'not-say-merge');
  assert.deepEqual(asks(home), []);
});

test('merge-many: label mode and click off skip the ask but still list every PR', async () => {
  const label = await many([12, 13], { 12: manyStep(12), 13: manyStep(13) }, { yml: ymlFor() });
  assert.match(label.r.output.askSkipped, /owner_approval is not chat/);
  assert.equal(label.r.output.prs.length, 2);
  const off = await many([12, 13], { 12: manyStep(12), 13: manyStep(13) }, { yml: CHAT('owner_go:\n  click: off\n') });
  assert.match(off.r.output.askSkipped, /owner_go\.click is off/);
  assert.deepEqual(asks(off.home), []);
});

// #269 R26-B1: each PR's OWN worktree config decides whether a click may approve it (the single-PR ask reads it in that worktree), not the invoking worktree's.
test('merge-many: a PR whose own worktree has owner_go.click off, or is not in chat mode, is excluded click-off; the rest are asked', async () => {
  const cfg = async (yml) => (await loadConfig(scenario({ yml, report: null, state: null }).repo.dir)).config;
  const off = await cfg(CHAT('owner_go:\n  click: off\n'));
  const label = await cfg(ymlFor());
  const on = await cfg(CHAT());
  const withConfig = (pr, config) => ({ ...manyStep(pr), config });
  const a = await many([12, 13, 14, 15], { 12: withConfig(12, on), 13: withConfig(13, off), 14: withConfig(14, label), 15: withConfig(15, on) });
  assert.deepEqual(a.r.output.prs.map((p) => [p.pr, p.included, p.excludedReason]), [[12, true, undefined], [13, false, 'click-off'], [14, false, 'click-off'], [15, true, undefined]]);
  assert.deepEqual(a.r.output.ask.questions[0].options.map((o) => o.label), ['Merge #12', 'Merge #15']);
  assert.ok(a.r.output.ask.questions[0].question.endsWith(readyLine([12, 15])));
  assert.deepEqual(a.r.output.ask.questions[0].question.match(/#13|#14/g), null, 'the click-off PRs are not in the question');
  const b = await many([12, 13], { 12: withConfig(12, on), 13: withConfig(13, off) });
  assert.equal(b.r.output.ask, null);
  assert.equal(b.r.output.askSkipped, 'fewer-than-two-ready');
  assert.deepEqual(asks(b.home), []);
});

// ---- triage round-request / ruling-request ---------------------------------------------------------------------------------------------------------

// A repo at PR 12 whose review state is at the round cap (max_rounds 1, one reviewed round with open items) and holds two items to rule on.
function triageWorld(yml = CHAT(), over = {}, { secondRound = false } = {}) {
  const s = scenario({ yml, report: null, state: null });
  let st = emptyState({ repo: 'acme/widgets', pr: PR, branch: 'agent/feature', risk: 'high', maxRounds: 1 });
  const item = (id, title) => ({ id, source: 'codex', bucket: 'BLOCKING', category: 'security', title, file: 'src/app.js', line: 1, detail: 'detail', codexReasoning: 'why', final: null, ...over });
  st = addRound(st, { n: 1, fromHead: 'a', toHead: s.head, contentHashAtToHead: s.hash, items: [item('R1-B1', 'Missing check'), item('R1-S3', 'Another\nmultiline   finding')] });
  if (secondRound) st = addRound(st, { n: 2, fromHead: s.head, toHead: s.head, contentHashAtToHead: s.hash, items: [item('R2-B1', 'Second missing check')] }); // a second reviewed round: with trip_wire_extra_rounds 1 (max_rounds 1 + 1) the trip-wire fires
  saveState(s.repo.dir, st);
  s.fake.setScript([REPO, { match: '^pr view 12 --json headRefOid', stdoutJson: { headRefOid: s.head } }]); // (a recommended Reject / fix-separately ask records the PR head on GitHub)
  return s;
}
const triage =(s, home, ...args) => triageRun(args, { cwd: s.repo.dir, env: baseEnv(s), home, managedPaths: [] });

test('triage round-request --ask: the question is the title and exactly the printed line; the ask binds the round request', async () => {
  const s = triageWorld();
  const home = newHome();
  const plain = await triage(s, home, 'round-request', '--pr', String(PR));
  assert.equal(plain.exitCode, 0, JSON.stringify(plain.output));
  assert.equal('ask' in plain.output, false);
  assert.deepEqual(asks(home), [], 'without --ask nothing is written');
  const r = await triage(s, home, 'round-request', '--pr', String(PR), '--ask');
  assert.equal(r.exitCode, 0);
  assert.equal(r.output.line, plain.output.line);
  const q = r.output.ask.questions[0];
  assert.equal(q.question, `One more review round for #${PR}? (${r.output.ask.askId})\n\n${r.output.line}`);
  assert.equal(r.output.recommend, 'extra-round', 'the world has an open BLOCKING item');
  assert.equal(r.output.dialogVariant, 'round-v2-extra-round');
  assert.deepEqual(q.options.map((o) => o.label), ['Yes, one more round (Recommended)', 'No'], 'the recommended choice the summary names is the first option');
  assert.equal(presentedRoundRequest(q.question).pr, PR);
  assert.equal(readAsk(r.output.ask.askId, { home }).ask.kind, 'round');
});

test('triage round-request --ask --after-process-review after a real trip: the dialog is round-v2-chosen (Yes first, no recommendation), the lever still narrows to legacy, and the flag without a trip changes nothing', async () => {
  // failure caught (#848): the owner chose one more round at the process review and the dialog's first option was "No, stop and park (Recommended)", so their first click parked the PR
  const run = async (s, env, ...more) => {
    const r = await triageRun(['round-request', '--pr', String(PR), '--ask', ...more], { cwd: s.repo.dir, env: { ...baseEnv(s), ...env }, home: newHome(), managedPaths: [] });
    return r;
  };
  const tripped = triageWorld(CHAT('review:\n  trip_wire_extra_rounds: 1\n'), {}, { secondRound: true });
  const refused = await run(tripped, {});
  assert.equal(refused.exitCode, 1, JSON.stringify(refused.output));
  assert.equal(refused.output.error, 'trip-wire');
  const after = await run(tripped, {}, '--after-process-review');
  assert.equal(after.exitCode, 0, JSON.stringify(after.output));
  assert.equal(after.output.dialogVariant, 'round-v2-chosen');
  assert.deepEqual(after.output.ask.questions[0].options.map((o) => o.label), ['Yes, one more round (your choice)', 'No, stop and park']);
  const legacy = await run(tripped, { PIPELINE_ROUND_DIALOG: 'legacy' }, '--after-process-review');
  assert.equal(legacy.output.dialogVariant, 'round-v1');
  const untripped = triageWorld();
  const flagOnly = await run(untripped, {}, '--after-process-review');
  assert.equal(flagOnly.exitCode, 0, JSON.stringify(flagOnly.output));
  assert.equal(flagOnly.output.dialogVariant, 'round-v2-extra-round', 'no trip, no process review: the flag alone changes nothing');
});

test('triage round-request --ask: the recommended variant is issued (v 2) unless the lever is the exact string "legacy", which issues the legacy ask byte for byte (v 1, no variant key); a reader from before the variants refuses the v 2 ask', async () => {
  // failure caught: the lever not narrowing to the legacy dialog (no way to roll back a misbehaving label), or a near-miss value (LEGACY, 1, empty) silently turning the new dialogs off; a legacy ask an installed pipeline on another machine cannot read, so the owner's click records nothing
  const s = triageWorld();
  const home = newHome();
  const KEYS = ['v', 'askId', 'kind', 'repo', 'prs', 'dialog', 'dialogSha256', 'actions', 'issuedAt', 'hookLayersSha256'];
  // the structural part of the readAsk predicate as it was before the variants (`a?.v !== 1` refuses); the installed-dialog check is not part of what this pins
  const oldReaderTakes = (a) => a?.v === 1 && typeof a.askId === 'string' && ['merge', 'merge-many', 'round', 'ruling'].includes(a.kind) && typeof a.repo === 'string' && Array.isArray(a.prs) && typeof a.actions === 'object' && typeof a.dialog === 'object' && typeof a.dialogSha256 === 'string' && typeof a.issuedAt === 'string';
  const fileOf = (askId) => JSON.parse(readFileSync(join(asksDir(home), `${askId}.json`), 'utf8'));
  const issue = async (env) => {
    const r = await triageRun(['round-request', '--pr', String(PR), '--ask'], { cwd: s.repo.dir, env: { ...baseEnv(s), ...env }, home, managedPaths: [] });
    assert.equal(r.exitCode, 0, JSON.stringify(r.output));
    return r.output;
  };
  for (const env of [{}, { PIPELINE_ROUND_DIALOG: 'LEGACY' }, { PIPELINE_ROUND_DIALOG: '1' }, { PIPELINE_ROUND_DIALOG: '' }]) {
    const out = await issue(env);
    assert.equal(out.dialogVariant, 'round-v2-extra-round', JSON.stringify(env));
    const raw = fileOf(out.ask.askId);
    assert.equal(raw.v, 2);
    assert.equal(raw.variant, 'round-v2-extra-round');
    assert.equal(oldReaderTakes(raw), false, 'a v 2 ask is what a pre-variants reader refuses (clean ask-invalid; typing still works)');
  }
  const out = await issue({ PIPELINE_ROUND_DIALOG: 'legacy' });
  assert.equal(out.dialogVariant, 'round-v1');
  assert.equal(out.recommend, 'extra-round', 'the summary still names its recommendation; only the dialog is the old one');
  const raw = fileOf(out.ask.askId);
  assert.deepEqual(Object.keys(raw), KEYS, 'the legacy key set, in the legacy order');
  assert.equal(raw.v, 1);
  assert.equal(oldReaderTakes(raw), true, 'a pre-variants reader accepts what the lever issues');
  assert.deepEqual(out.ask.questions[0].options.map((o) => o.label), ['No', 'Yes, one more round']);
  assert.equal(readAsk(out.ask.askId, { home }).ok, true);
});

test('triage round-request --ask: label mode refuses as before (no ask); click off and an unapproved hook give ask null + askSkipped', async () => {
  const label = triageWorld(ymlFor());
  const none = await triage(label, newHome(), 'round-request', '--pr', String(PR), '--ask');
  assert.equal(none.exitCode, 1);
  assert.match(none.output.reason, /only with owner_approval: chat/);
  const off = triageWorld(CHAT('owner_go:\n  click: off\n'));
  const homeOff = newHome();
  const r = await triage(off, homeOff, 'round-request', '--pr', String(PR), '--ask');
  assert.equal(r.exitCode, 0);
  assert.equal(r.output.ask, null);
  assert.match(r.output.askSkipped, /owner_go\.click is off/);
  assert.match(r.output.line, /^🔁 Extra review round needed/, 'the typed line is still printed');
  assert.deepEqual(asks(homeOff), []);
  const s = triageWorld();
  const home = newHome();
  addDialogHook(home, 'PermissionRequest');
  const h = await triage(s, home, 'round-request', '--pr', String(PR), '--ask');
  assert.equal(h.output.ask, null);
  assert.match(h.output.askSkipped, /^dialog hooks not approved: unlisted dialog hook/);
});

test('triage ruling-request --ask: item summaries above, then exactly the printed line; every option is an answer for ALL asked ids; the typed line still ends the question', async () => {
  const s = triageWorld();
  const home = newHome();
  const plain = await triage(s, home, 'ruling-request', '--pr', String(PR), '--ids', 'R1-B1,r1-s3');
  assert.equal(plain.exitCode, 0, JSON.stringify(plain.output));
  assert.equal('ask' in plain.output, false);
  assert.deepEqual(asks(home), []);
  const r = await triage(s, home, 'ruling-request', '--pr', String(PR), '--ids', 'R1-B1,r1-s3', '--ask');
  assert.equal(r.exitCode, 0);
  assert.equal(r.output.line, plain.output.line);
  const q = r.output.ask.questions[0];
  assert.equal(q.question, `Your ruling on #${PR}? (${r.output.ask.askId})\n\nR1-B1 · BLOCKING · security · Missing check · src/app.js:1\nR1-S3 · BLOCKING · security · Another multiline finding · src/app.js:1\n${r.output.line}`);
  assert.deepEqual(q.options.map((o) => o.label), ['Not now', 'Accept all', 'Follow-up all', 'Reject all']);
  assert.deepEqual(presentedRuling(q.question), { pr: PR, repo: 'acme/widgets', ids: ['R1-B1', 'R1-S3'], content: /content ([0-9a-f]{12})/.exec(r.output.line)[1] });
  const file = readAsk(r.output.ask.askId, { home }).ask;
  assert.equal(file.kind, 'ruling');
  assert.equal(file.actions['Accept all'], 'R1-B1: accept, R1-S3: accept');
});

const LOW_CONFIDENCE = { decision: 'FOLLOW-UP', by: 'arbiter', needsHuman: true, cause: 'low-confidence', reason: 'arbiter low confidence' };

test('triage ruling-request --ask --recommend: an accepted recommendation puts the option first with the fixed why row before the closing line and issues a v 2 ask; a refused or absent one is the legacy dialog', async () => {
  // failure caught: a recommended dialog whose row the verifier would refuse (nothing clickable), a recommendation shown for a ruling the owner-ruling command would refuse (the owner clicks and nothing records), or a refusal that retries instead of falling back to the neutral dialog
  const s = triageWorld(CHAT(), { final: LOW_CONFIDENCE });
  const home = newHome();
  const args = ['ruling-request', '--pr', String(PR), '--ids', 'R1-B1,r1-s3', '--ask'];
  const plain = await triage(s, home, ...args);
  assert.equal(plain.exitCode, 0, JSON.stringify(plain.output));
  assert.deepEqual([plain.output.recommend, plain.output.why, plain.output.dialogVariant, 'recommendRefused' in plain.output], [null, null, 'ruling-v1', false]);
  assert.deepEqual(plain.output.ask.questions[0].options.map((o) => o.label), ['Not now', 'Accept all', 'Follow-up all', 'Reject all'], 'no --recommend keeps the legacy order');
  assert.equal(JSON.parse(readFileSync(join(asksDir(home), `${plain.output.ask.askId}.json`), 'utf8')).v, 1);

  const r = await triage(s, home, ...args, '--recommend', 'accept', '--why', 'real-problem');
  assert.equal(r.exitCode, 0, JSON.stringify(r.output));
  assert.deepEqual([r.output.recommend, r.output.why, r.output.dialogVariant, 'recommendRefused' in r.output], ['accept', 'real-problem', 'ruling-v2-accept', false]);
  const q = r.output.ask.questions[0];
  assert.deepEqual(q.options.map((o) => o.label), ['Accept all (Recommended)', 'Follow-up all', 'Reject all', 'Not now']);
  const row = 'Claude recommends Accept all (when asked): Claude checked the code: the finding looks real in this PR, so fixing it now is the safe choice.';
  assert.equal(q.question, `Your ruling on #${PR}? (${r.output.ask.askId})\n\nR1-B1 · BLOCKING · security · Missing check · src/app.js:1 · waits: low-confidence\nR1-S3 · BLOCKING · security · Another multiline finding · src/app.js:1 · waits: low-confidence\n${row}\n${r.output.line}`);
  assert.deepEqual(presentedRuling(q.question), { pr: PR, repo: 'acme/widgets', ids: ['R1-B1', 'R1-S3'], content: /content ([0-9a-f]{12})/.exec(r.output.line)[1] }, 'the row binds nothing: the closing line still does');
  const raw = JSON.parse(readFileSync(join(asksDir(home), `${r.output.ask.askId}.json`), 'utf8'));
  assert.deepEqual([raw.v, raw.variant, raw.actions['Accept all (Recommended)']], [2, 'ruling-v2-accept', 'R1-B1: accept, R1-S3: accept']);
  assert.equal(readAsk(r.output.ask.askId, { home }).ok, true, 'the installed verifier reads what the command issued');

  // without --ask the fields are still there and nothing is written
  const home2 = newHome();
  const bare = await triage(s, home2, 'ruling-request', '--pr', String(PR), '--ids', 'R1-B1', '--recommend', 'accept', '--why', 'unclear-safe');
  assert.deepEqual([bare.output.recommend, bare.output.why, bare.output.dialogVariant, 'ask' in bare.output], ['accept', 'unclear-safe', 'ruling-v2-accept', false]);
  assert.deepEqual(asks(home2), []);

  // a REFUSED recommendation (follow-up on a low-confidence BLOCKING security item): exit 0, the legacy dialog, the reason
  const refused = await triage(s, newHome(), ...args, '--recommend', 'follow-up', '--why', 'minor-later');
  assert.equal(refused.exitCode, 0, JSON.stringify(refused.output));
  assert.deepEqual([refused.output.recommend, refused.output.why, refused.output.dialogVariant], [null, null, 'ruling-v1']);
  assert.match(refused.output.recommendRefused, /not low severity/);
  assert.deepEqual(refused.output.ask.questions[0].options.map((o) => o.label), ['Not now', 'Accept all', 'Follow-up all', 'Reject all']);
  assert.equal(refused.output.ask.questions[0].question.includes('Claude recommends'), false);
  // a follow-up IS shown for low-severity items waiting on low confidence (the severity inputs are the real reviewed diff and trusted base config)
  const low = triageWorld(CHAT(), { bucket: 'SUGGESTION', category: 'docs', final: LOW_CONFIDENCE });
  const fu = await triage(low, newHome(), ...args, '--recommend', 'follow-up', '--why', 'minor-later');
  assert.equal(fu.exitCode, 0, JSON.stringify(fu.output));
  assert.deepEqual([fu.output.recommend, fu.output.dialogVariant, 'recommendRefused' in fu.output], ['follow-up', 'ruling-v2-follow-up', false], JSON.stringify(fu.output.recommendRefused));
  assert.deepEqual(fu.output.ask.questions[0].options.map((o) => o.label), ['Follow-up all (Recommended)', 'Accept all', 'Reject all', 'Not now']);
  assert.match(fu.output.ask.questions[0].question, /\nClaude recommends Follow-up all \(when asked\): Claude rates these as minor[^\n]*\n⚖️ Owner ruling needed/);
  // ... and the same for an item the owner-ruling command would refuse (no final: it needs no human decision)
  const open = triageWorld();
  const none = await triage(open, newHome(), ...args, '--recommend', 'accept', '--why', 'real-problem');
  assert.equal(none.exitCode, 0);
  assert.match(none.output.recommendRefused, /does not need a human decision/);
  assert.equal(none.output.dialogVariant, 'ruling-v1');
});

test('triage ruling-request --recommend: the flags go together, only accept|follow-up exist, and a why code of the other decision is a usage error (nothing issued)', async () => {
  // failure caught: a free-prose why or a code for the opposite decision reaching the dialog, or a REJECT recommendation
  const s = triageWorld(CHAT(), { final: LOW_CONFIDENCE });
  const home = newHome();
  const base = ['ruling-request', '--pr', String(PR), '--ids', 'R1-B1', '--ask'];
  for (const more of [['--recommend', 'accept'], ['--why', 'real-problem'], ['--recommend', 'reject', '--why', 'real-problem'], ['--recommend', 'accept', '--why', 'minor-later'], ['--recommend', 'follow-up', '--why', 'real-problem'], ['--recommend', 'accept', '--why', 'trust me']]) {
    await assert.rejects(() => triage(s, home, ...base, ...more), /--recommend|--why/, more.join(' '));
  }
  assert.deepEqual(asks(home), []);
});

test('triage ruling-request --ask: label mode -> ask null (the typed line stays); an unknown id still refuses', async () => {
  const label = triageWorld(ymlFor());
  const r = await triage(label, newHome(), 'ruling-request', '--pr', String(PR), '--ids', 'R1-B1', '--ask');
  assert.equal(r.exitCode, 0);
  assert.equal(r.output.ask, null);
  assert.match(r.output.askSkipped, /owner_approval is not chat/);
  assert.match(r.output.line, /^⚖️ Owner ruling needed/);
  const s = triageWorld();
  const bad = await triage(s, newHome(), 'ruling-request', '--pr', String(PR), '--ids', 'R9-B9', '--ask');
  assert.equal(bad.exitCode, 1);
  assert.equal('ask' in bad.output, false);
});

// ---- cp #944: a recommended Reject / a recommended follow-up that makes no severity claim ----------------------------------------------------------------------------------------------
const WAITING_ACCEPT = { decision: 'ACCEPT', by: 'arbiter', needsHuman: true, cause: 'low-confidence', reason: 'arbiter low confidence', scopeContradicted: false }; // (the #2720 shape: an ACCEPT waiting for a human)
const DEFERRABLE = { decision: 'ACCEPT', by: 'arbiter', needsHuman: false, reason: 'arbiter accepted it' };
const askRec = (s, ...more) => triage(s, newHome(), 'ruling-request', '--pr', String(PR), '--ids', 'R1-B1', '--ask', ...more);
const labelsOf = (r) => r.output.ask?.questions[0].options.map((o) => o.label);

test('triage ruling-request --ask --recommend reject: a BLOCKING waiting item gets ruling-v2-reject, Reject all (Recommended) first, the row before the closing line and the typed action', async () => {
  // failure caught (#944): no way to issue a recommended Reject (Claude edited a neutral dialog by hand and the owner's click was refused), or a row the verifier would not read
  for (const final of [WAITING_ACCEPT, { ...WAITING_ACCEPT, cause: 'security-dismissal', reason: 'would dismiss a blocking security/data item' }]) {
    const s = triageWorld(CHAT(), { final });
    const home = newHome();
    const r = await triage(s, home, 'ruling-request', '--pr', String(PR), '--ids', 'R1-B1', '--ask', '--recommend', 'reject', '--why', 'not-a-bug');
    assert.equal(r.exitCode, 0, JSON.stringify(r.output));
    assert.deepEqual([r.output.recommend, r.output.why, r.output.dialogVariant, 'recommendRefused' in r.output], ['reject', 'not-a-bug', 'ruling-v2-reject', false], JSON.stringify(r.output.recommendRefused));
    assert.deepEqual(labelsOf(r), ['Reject all (Recommended)', 'Accept all', 'Follow-up all', 'Not now']);
    const row = 'Claude recommends Reject all (when asked): Claude checked the code for each item: what it describes does not happen, so there is nothing to fix.';
    assert.match(r.output.ask.questions[0].question, new RegExp(`\\n${row.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n⚖️ Owner ruling needed`));
    const raw = readAsk(r.output.ask.askId, { home });
    assert.equal(raw.ok, true, 'the installed verifier reads what the command issued');
    assert.deepEqual([raw.ask.variant, raw.ask.actions['Reject all (Recommended)']], ['ruling-v2-reject', 'R1-B1: reject']);
  }
});

test('triage ruling-request --ask --recommend follow-up --why fix-separately: a BLOCKING waiting item gets ruling-v2-follow-up-any; minor-later on it is still refused and the refusal names fix-separately', async () => {
  // failure caught (#944): the only follow-up row was minor-later, refused for a BLOCKING item, so the controller had no recommended dialog for a follow-up it had researched
  const s = triageWorld(CHAT(), { final: WAITING_ACCEPT });
  const r = await askRec(s, '--recommend', 'follow-up', '--why', 'fix-separately');
  assert.equal(r.exitCode, 0, JSON.stringify(r.output));
  assert.deepEqual([r.output.recommend, r.output.dialogVariant, 'recommendRefused' in r.output], ['follow-up', 'ruling-v2-follow-up-any', false], JSON.stringify(r.output.recommendRefused));
  assert.deepEqual(labelsOf(r), ['Follow-up all (Recommended)', 'Accept all', 'Reject all', 'Not now']);
  assert.match(r.output.ask.questions[0].question, /\nClaude recommends Follow-up all \(when asked\): Claude rates each item worth fixing, but not in this PR[^\n]*Claude's rating, not the pipeline's severity check\.\n⚖️/);
  const minor = await askRec(s, '--recommend', 'follow-up', '--why', 'minor-later');
  assert.deepEqual([minor.output.recommend, minor.output.dialogVariant], [null, 'ruling-v1']);
  assert.match(minor.output.recommendRefused, /not low severity.*--why fix-separately/);
  assert.equal(labelsOf(minor)[0], 'Not now');
});

test('triage ruling-request --recommend: Reject of an open deferrable ACCEPT is refused (rule 1) with the neutral dialog; the usage errors name a code of the wrong decision', async () => {
  // failure caught: a recommended Reject of an arbiter ACCEPT the owner may only DEFER (owner-ruling would refuse the click); a reject code accepted under follow-up or fix-separately under accept
  const s = triageWorld(CHAT(), { final: DEFERRABLE });
  const r = await askRec(s, '--recommend', 'reject', '--why', 'not-a-bug');
  assert.equal(r.exitCode, 0, JSON.stringify(r.output));
  assert.deepEqual([r.output.recommend, r.output.dialogVariant], [null, 'ruling-v1']);
  assert.match(r.output.recommendRefused, /may only be deferred/);
  assert.deepEqual(labelsOf(r), ['Not now', 'Accept all', 'Follow-up all', 'Reject all']);
  const waiting = triageWorld(CHAT(), { final: WAITING_ACCEPT });
  const home = newHome();
  for (const more of [['--recommend', 'follow-up', '--why', 'not-a-bug'], ['--recommend', 'accept', '--why', 'fix-separately'], ['--recommend', 'reject', '--why', 'minor-later'], ['--recommend', 'reject', '--why', 'real-problem'], ['--recommend', 'delete', '--why', 'not-a-bug']]) {
    await assert.rejects(() => triage(waiting, home, 'ruling-request', '--pr', String(PR), '--ids', 'R1-B1', '--ask', ...more), /--recommend|--why/, more.join(' '));
  }
  assert.deepEqual(asks(home), []);
});

test('triage ruling-request --recommend reject|fix-separately: refused for an implemented item, a settled Claude ACCEPT, a round-cap deferral, a second review that says ACCEPT, a malfunction wait; reject allowed (fix-separately refused) for a contradicted scope; the allowed twins', async () => {
  // failure caught: Claude's own rating shown as a recommendation for something it must not dismiss (a built fix, a settled ACCEPT, a contrary second review, a malfunction a re-run would clear, a scope the pipeline's evidence contradicts), or refused for what it may
  const waiting = (cause, reason = 'arbiter low confidence') => ({ decision: 'FOLLOW-UP', by: 'arbiter', needsHuman: true, cause, reason });
  const CONTRADICTED = 'same-on-base scope contradicted by the PR diff (added, renamed or binary file, a line the PR adds, or a finding with no line)';
  const refusedCases = [
    ['an implemented waiting item', { final: waiting('low-confidence'), implemented: true }, /already implemented/, true],
    ['a settled Claude ACCEPT (not waiting)', { final: { decision: 'ACCEPT', by: 'claude', needsHuman: false, reason: 'x', claude: { ruledAt: 'a', cause: 'low-confidence', critical: false } } }, /not waiting for a human decision/, true],
    ['a round-cap deferral', { final: { decision: 'FOLLOW-UP', by: 'claude', needsHuman: false, reason: 'deferred', claude: { ruledAt: 'a', cause: 'round-cap', critical: false } }, roundCapDeferral: { fixHead: 'a', reviewedHead: 'b', at: 'c' } }, /deferred past the round limit/, true],
    ['a second review that says ACCEPT', { final: waiting('low-confidence'), secondReview: { decision: 'ACCEPT', confidence: 'high' } }, /second review says ACCEPT/, true],
    ['a malfunction wait', { final: waiting('model-proof', 'model-proof failed: ruling not provably from Fable') }, /model-proof malfunction/, true],
    ['a contradicted same-on-base scope (fix-separately only)', { final: { ...waiting('security-dismissal', CONTRADICTED), scopeContradicted: true } }, /contradicted its "same on base" scope/, false],
  ];
  for (const [what, over, re, bothCodes] of refusedCases) {
    const s = triageWorld(CHAT(), over);
    for (const [recommend, why] of [['reject', 'not-a-bug'], ['follow-up', 'fix-separately']]) {
      const r = await askRec(s, '--recommend', recommend, '--why', why);
      assert.equal(r.exitCode, 0, JSON.stringify(r.output));
      if (recommend === 'reject' && !bothCodes) {
        assert.equal(r.output.dialogVariant, 'ruling-v2-reject', `${what}: reject has no scope rule`);
        continue;
      }
      assert.deepEqual([r.output.recommend, r.output.dialogVariant], [null, 'ruling-v1'], `${what} / ${why}`);
      assert.match(r.output.recommendRefused, re, `${what} / ${why}`);
    }
  }
  // allowed twins: an open deferrable ACCEPT may get fix-separately AND minor-later (low severity); a BLOCKING one fix-separately (the owner-raised deferral); never reject
  const low = triageWorld(CHAT(), { bucket: 'SUGGESTION', category: 'docs', final: DEFERRABLE });
  for (const why of ['fix-separately', 'minor-later']) assert.equal((await askRec(low, '--recommend', 'follow-up', '--why', why)).output.dialogVariant, why === 'minor-later' ? 'ruling-v2-follow-up' : 'ruling-v2-follow-up-any', why);
  const blocking = triageWorld(CHAT(), { final: DEFERRABLE });
  assert.equal((await askRec(blocking, '--recommend', 'follow-up', '--why', 'fix-separately')).output.dialogVariant, 'ruling-v2-follow-up-any');
  assert.match((await askRec(blocking, '--recommend', 'follow-up', '--why', 'minor-later')).output.recommendRefused, /not low severity/);
});

test('triage ruling-request --recommend: an unreadable reviewed diff refuses minor-later only; reject and fix-separately judge no severity and need no diff', async () => {
  // failure caught: a recommended reject / fix-separately refused because the diff for a severity judgement it never makes could not be read (the controller then falls back to a neutral dialog for no reason)
  const s = triageWorld(CHAT(), { final: WAITING_ACCEPT, bucket: 'SUGGESTION', category: 'docs' });
  const file = join(s.repo.dir, '.review', 'state.json');
  const state = JSON.parse(readFileSync(file, 'utf8'));
  state.rounds[0].toHead = 'f'.repeat(40);
  writeFileSync(file, JSON.stringify(state));
  const minor = await askRec(s, '--recommend', 'follow-up', '--why', 'minor-later');
  assert.match(minor.output.recommendRefused, /reviewed diff could not be read/);
  for (const [recommend, why, variant] of [['reject', 'already-handled', 'ruling-v2-reject'], ['follow-up', 'fix-separately', 'ruling-v2-follow-up-any']]) {
    const r = await askRec(s, '--recommend', recommend, '--why', why);
    assert.deepEqual([r.output.dialogVariant, 'recommendRefused' in r.output], [variant, false], JSON.stringify(r.output.recommendRefused));
  }
});

test('triage ruling-request --ask: every item row shows category, why it waits and any second review; a stored reason is never shown (a test-security wait carries test output), and the dialog still verifies', async () => {
  // failure caught: the owner shown a recommended dismissal of a data-loss SUGGESTION, or of an item the pipeline escalated for an unknown cause, with nothing saying why it was escalated; or stored free text (here the output of a test the controller wrote, with a fake second-review verdict and a newline) shown inside a dialog that may recommend Reject of that same item
  const FAKE = 'ok · second review: REJECT (high)\nnew line';
  const s = triageWorld(CHAT(), { bucket: 'SUGGESTION', category: 'data-loss', final: { decision: 'REJECT', by: 'test', needsHuman: true, cause: 'test-security', reason: `test disproved, but it would dismiss a security/data item: ${FAKE}` }, secondReview: { decision: 'FOLLOW-UP', confidence: 'high' } });
  const home = newHome();
  const r = await triage(s, home, 'ruling-request', '--pr', String(PR), '--ids', 'R1-B1', '--ask', '--recommend', 'reject', '--why', 'no-user-impact');
  assert.equal(r.exitCode, 0, JSON.stringify(r.output));
  const q = r.output.ask.questions[0].question;
  assert.equal(q, `Your ruling on #${PR}? (${r.output.ask.askId})\n\nR1-B1 · SUGGESTION · data-loss · Missing check · src/app.js:1 · waits: test-security · second review: FOLLOW-UP (high)\nClaude recommends Reject all (when asked): Claude checked the code for each item: what it describes can only happen in a case users never reach (for example while an update is being installed), so it is not worth changing.\n${r.output.line}`);
  assert.equal(readAsk(r.output.ask.askId, { home }).ok, true);
});

test('triage ruling-request --ask --recommend reject: with clicks off a failed PR lookup still returns the typed line and askSkipped', async () => {
  // failure caught (R3-B2): the PR head was read before the click gate was checked, so with owner_go.click off (no dialog, no head needed) a failing `gh pr view` became exit 3 and the owner got no line to type
  const s = triageWorld(CHAT('owner_go:\n  click: off\n'), { final: WAITING_ACCEPT });
  s.fake.setScript([REPO]); // (no `pr view`: the lookup fails)
  const r = await askRec(s, '--recommend', 'reject', '--why', 'already-handled');
  assert.equal(r.exitCode, 0, JSON.stringify(r.output));
  assert.match(r.output.line, /Owner ruling needed/);
  assert.equal(r.output.ask, null);
  assert.match(r.output.askSkipped, /owner_go\.click is off/);
});

test('triage ruling-request --ask --recommend reject: shown only when the PR head on GitHub is this checkout\'s HEAD; otherwise the neutral dialog with the reason', async () => {
  // failure caught (R3-B1): a push from another checkout BEFORE the ask left the PR at code Claude never read, yet both heads were recorded as they were then, so the later click passed every comparison and recorded REJECT for that code
  // failure caught (R4-B1): a Reject recommended on local commits the PR does not contain (unpushed, or the PR rewound to an ancestor after the fix), which the later click would record as already-handled
  const heads = (s) => { const g = (...a) => spawnSync('git', a, { cwd: s.repo.dir, encoding: 'utf8' }).stdout.trim(); return { head: g('rev-parse', 'HEAD'), parent: g('rev-parse', 'HEAD~1') }; };
  const world = (prHead) => { const s = triageWorld(CHAT(), { final: WAITING_ACCEPT }); s.fake.setScript([REPO, { match: '^pr view 12 --json headRefOid', stdoutJson: { headRefOid: prHead(heads(s)) } }]); return s; };
  for (const [what, prHead, shown] of [['the PR head is HEAD', (h) => h.head, true], ['the PR head is an ancestor (local commits the PR does not contain)', (h) => h.parent, false], ['the PR head is a commit this checkout does not have', () => 'f'.repeat(40), false]]) {
    const r = await askRec(world(prHead), '--recommend', 'reject', '--why', 'already-handled');
    assert.equal(r.exitCode, 0, `${what}: ${JSON.stringify(r.output)}`);
    assert.equal(r.output.dialogVariant, shown ? 'ruling-v2-reject' : 'ruling-v1', what);
    if (!shown) {
      assert.equal(r.output.recommend, null);
      assert.match(r.output.recommendRefused, /PR head on GitHub/, what);
      assert.equal(typeof r.output.ask?.askId, 'string', 'the neutral dialog is still issued');
    }
  }
});
