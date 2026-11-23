// Why (issue #21 + audit): a guard that runs out of time is a guard that allows (Claude Code treats a hook with no
// decision as allow), so every evaluation has hard budgets and every internal failure is a denial:
//   - one budget of script judgments for EVERY script file read (named or candidate), shared through the recursion;
//   - a wall-clock deadline well under the 15 s hook timeout (the clock is injected here, so no test depends on timing);
//   - a variable chain (`B=$A$A$A...; C=$B$B$B...`) or one huge value repeated many times must not expand without bound;
//   - an exception inside a policy (a readText that throws) is a denial, not a thrown error.
// The file system is faked like test/guard-script-expansion.test.mjs; guarded text never appears (these scripts are harmless).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, basename } from 'node:path';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';
import { runHook } from '../pipeline/hooks/lib/hook-io.mjs';
import { MAX_SCRIPT_JUDGMENTS, EVAL_DEADLINE_MS, EVAL_WALL_CAP_MS, HOOK_CLOCK, newEvalBudget, wallLeftMs, checkDeadline, budgetExpired, GuardLimit } from '../pipeline/hooks/lib/script-candidates.mjs';
import { HOOK_TIMEOUT_S } from '../pipeline/lib/installer.mjs';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function fakeFs(root, files, dirs = []) {
  const abs = (p) => resolve(root, p);
  const F = Object.fromEntries(Object.entries(files).map(([k, v]) => [abs(k), v]));
  const D = new Set([root, ...dirs.map(abs)].map((p) => resolve(p)));
  const names = (d) => {
    const out = new Set();
    for (const p of [...Object.keys(F), ...D]) if (p !== d && dirname(p) === d) out.add(basename(p));
    return [...out];
  };
  return {
    readText: (p) => (typeof F[resolve(p)] === 'string' ? F[resolve(p)] : null),
    pathExists: (p) => resolve(p) in F || D.has(resolve(p)),
    readDir: (p) => (D.has(resolve(p)) ? names(resolve(p)) : null),
  };
}

const GIT_ROOT = resolve('/work/repo');
const git = (command, fsOpts, o = {}) => evaluateGitCommand(command, {
  cwd: GIT_ROOT, home: '/home/u', currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], ...fsOpts, ...o,
});
const PROJ = '/home/u/proj';
const files = (command, fsOpts, o = {}) => evaluateBashForFiles(command, {
  home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, cwd: PROJ, ...fsOpts, existsSync: fsOpts.pathExists, ...o,
});
const gitFs = (f) => fakeFs(GIT_ROOT, f);
const filesFs = (f) => fakeFs(PROJ, f);

// A script tree generated on demand: n<level>_<i>.sh runs n<level+1>_0.sh ... n<level+1>_<lines-1>.sh (distinct names: the same
// word repeated more than 32 times in one text is already refused as ambiguous), the last level is harmless.
// Each file is a different script, so the guard has to read all of them: lines^(levels-1) reads.
const lazyFs = (root, lines, levels) => {
  const gen = (p) => {
    const m = /^n(\d+)_(\d+)\.sh$/.exec(basename(p));
    if (!m || dirname(resolve(p)) !== resolve(root) || +m[1] > levels || +m[2] >= lines) return null;
    return +m[1] === levels ? 'echo hi' : Array.from({ length: lines }, (_, i) => `bash n${+m[1] + 1}_${i}.sh`).join('\n');
  };
  return { readText: gen, pathExists: (p) => gen(p) !== null || resolve(p) === resolve(root), readDir: () => null, root };
};
const tree = (lines, levels) => ({ lazy: { lines, levels } });
const asFs = (mk, root, f) => (f.lazy ? lazyFs(root, f.lazy.lines, f.lazy.levels) : mk(f));
const both = [
  ['guard-git', (c, f, o) => git(c, asFs(gitFs, GIT_ROOT, f), o), gitFs],
  ['guard-files', (c, f, o) => files(c, asFs(filesFs, PROJ, f), o), filesFs],
];
const timed = cpuTimed; // CPU ms, not wall: a loaded machine must not trip a cap

// ---- one budget for every script file read -----------------------------------------------------------------------

for (const [name, run] of both) {
  test(`${name}: a tree of 500 plain 'bash next.sh' lines, 4 levels deep, is denied quickly (budget on every script read)`, () => {
    const { r, ms } = timed(() => run('bash n1_0.sh', tree(500, 4)));
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /too many script files/);
    assert.ok(ms < 3000, `took ${Math.round(ms)} ms of CPU`);
  });

  test(`${name}: a smaller tree (20 lines, 3 levels = 421 reads) is denied: the budget counts named scripts, not only candidates`, () => {
    const r = run('bash n1_0.sh', tree(20, 3));
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /too many script files/);
  });

  test(`${name}: the budget is exactly MAX_SCRIPT_JUDGMENTS script reads`, () => {
    // a chain is limited by nesting depth, so use a flat script that runs N different harmless scripts
    const flat = (n) => ({ 'main.sh': Array.from({ length: n }, (_, i) => `bash s${i}.sh`).join('\n'), ...Object.fromEntries(Array.from({ length: n }, (_, i) => [`s${i}.sh`, 'echo hi'])) });
    assert.equal(run('bash main.sh', flat(MAX_SCRIPT_JUDGMENTS - 1)).decision, 'allow'); // main.sh itself is one read
    assert.equal(run('bash main.sh', flat(MAX_SCRIPT_JUDGMENTS)).decision, 'deny');
  });

  test(`${name}: a normal line with a few variables and a couple of scripts is still allowed`, () => {
    const f = { 'build.sh': 'bash lint.sh\nbash test.sh', 'lint.sh': 'echo lint', 'test.sh': 'echo test' };
    assert.equal(run('V=1; W=two; echo $V $W; bash build.sh', f).decision, 'allow');
  });
}

// ---- wall-clock deadline (injected clock) --------------------------------------------------------------------------

for (const [name, run] of both) {
  test(`${name}: an evaluation past its deadline is denied ("took too long"), judged by the injected clock`, () => {
    let t = 1_000_000;
    const f = { 'a.sh': 'bash b.sh', 'b.sh': 'echo hi' };
    const inner = name === 'guard-git' ? gitFs(f) : filesFs(f);
    const slow = { ...inner, readText: (p) => { const text = inner.readText(p); t += 2 * EVAL_DEADLINE_MS; return text; } };
    const o = { now: () => t };
    const r = name === 'guard-git' ? git('bash a.sh', slow, o) : files('bash a.sh', slow, o);
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /took too long/);
    // the same chain on a clock that stands still is fine
    const fast = name === 'guard-git' ? git('bash a.sh', inner, { now: () => 5 }) : files('bash a.sh', inner, { now: () => 5 });
    assert.equal(fast.decision, 'allow');
  });
}

// ---- CPU limit + hard wall cap (#627) -------------------------------------------------------------------------------
// Why: the limit counts the hook's CPU time, so a loaded machine (wall runs ahead of the work) no longer refuses ordinary commands; a hook that
// runs past the host timeout (HOOK_TIMEOUT_S) is ALLOWED by Claude Code, so a hard wall cap below it still refuses whatever the CPU says.

test('the hard wall cap leaves margin under the host hook timeout (a hook past its timeout is allowed)', () => {
  assert.ok(EVAL_WALL_CAP_MS > EVAL_DEADLINE_MS, 'the wall cap is above the CPU limit');
  assert.ok(EVAL_WALL_CAP_MS <= HOOK_TIMEOUT_S * 1000 - 3000, `wall cap ${EVAL_WALL_CAP_MS} ms must leave >= 3 s of the ${HOOK_TIMEOUT_S} s hook timeout for startup and output`);
});

// wall and cpu are two fake clocks that start at 0 (ms)
const clocks = (wall = 0, cpu = 0) => { const c = { wall, cpu }; return { c, budget: newEvalBudget(() => c.wall, () => c.cpu) }; };

test('budget: wall 6 s but CPU 1 s is not expired; CPU past the limit and wall past the cap each are, and the scanners agree with checkDeadline', () => {
  const cases = [
    ['busy machine: wall 6 s, cpu 1 s', 6000, 1000, 'ok'],
    ['at the CPU limit exactly', 5000, 5000, 'ok'],
    ['real blow-up: cpu past 5 s', 5600, 5600, 'cpu'],
    ['cpu cannot exceed wall: a clock that over-reports cpu never refuses early', 3000, 9000, 'ok'],
    ['little cpu but wall past the hard cap', EVAL_WALL_CAP_MS + 1, 100, 'wall'],
    ['wall at the cap exactly, little cpu', EVAL_WALL_CAP_MS, 100, 'ok'],
  ];
  for (const [label, wall, cpu, want] of cases) {
    const { c, budget } = clocks();
    Object.assign(c, { wall, cpu });
    assert.equal(budgetExpired(budget), want !== 'ok', label);
    if (want === 'ok') assert.doesNotThrow(() => checkDeadline(budget), label);
    else assert.throws(() => checkDeadline(budget), (e) => e instanceof GuardLimit && (want === 'wall' ? /too busy/ : /script chain or a command line too large/).test(e.message), label);
  }
});

test('budget: the limit counts from the start of the evaluation, not from the process start', () => {
  const { c, budget } = clocks(1_000_000, 900_000);
  Object.assign(c, { wall: 1_004_000, cpu: 903_000 });
  assert.equal(budgetExpired(budget), false);
  Object.assign(c, { wall: 1_007_000, cpu: 906_000 });
  assert.equal(budgetExpired(budget), true);
});

// the same through both policies: script reads advance the fake clocks (a chain of four scripts, so several checkpoints see them)
const CHAIN4 = { 'a.sh': 'bash b.sh', 'b.sh': 'bash c.sh', 'c.sh': 'bash d.sh', 'd.sh': 'echo hi' };
for (const [name] of both) {
  const slowBy = (dWall, dCpu) => {
    const c = { wall: 0, cpu: 0 };
    const inner = name === 'guard-git' ? gitFs(CHAIN4) : filesFs(CHAIN4);
    const fs = { ...inner, readText: (p) => { c.wall += dWall; c.cpu += dCpu; return inner.readText(p); } };
    const o = { now: () => c.wall, cpu: () => c.cpu };
    return name === 'guard-git' ? git('bash a.sh', fs, o) : files('bash a.sh', fs, o);
  };
  test(`${name}: a busy machine (wall 8 s, CPU 1 s over the evaluation) still allows an ordinary chain`, () => {
    const r = slowBy(2000, 250);
    assert.equal(r.decision, 'allow', `${r.decision}: ${r.reason}`);
  });
  test(`${name}: CPU past the limit is still denied with the "took too long" reason`, () => {
    const r = slowBy(2000, 2000);
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /took too long \(a script chain/);
  });
  test(`${name}: little CPU but wall past the hard cap is denied (a hook past the host timeout is allowed)`, () => {
    const r = slowBy(4000, 10);
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /too busy/);
  });
}

// ---- one wall cap per hook process (#627 review) ----------------------------------------------------------------------
// Why: the host timeout (HOOK_TIMEOUT_S) covers the whole hook PROCESS, and Claude Code ALLOWS a hook that runs past it. A per-evaluation wall cap let an MCP
// call with several command fields (guard-git runs one evaluation per field) take 2 x 10 s, and node startup was not counted at all. The hooks therefore pass
// HOOK_CLOCK: the wall cap counts from process start (origin 0) and is shared by every evaluation of the process. Long-lived CLI callers (command-guard,
// preflight) do not, and keep the cap per evaluation.
for (const [name] of both) {
  const evaluate = name === 'guard-git' ? git : files;
  // each script read advances the fake clock by 1 s (the first evaluation reads a.sh once)
  const ticking = (clock) => { const fs = (name === 'guard-git' ? gitFs : filesFs)({ 'a.sh': 'echo hi' }); return { ...fs, readText: (p) => { clock.t += 1000; return fs.readText(p); } }; };
  const one = (clock) => evaluate('bash a.sh', ticking(clock), { now: () => clock.t, cpu: () => 0, wall0: 0 });
  test(`${name}: two evaluations in one hook process share one wall cap (a hook past HOOK_TIMEOUT_S is allowed by Claude Code)`, () => {
    const clock = { t: 5000 };
    // the first evaluation ends at about 6 s: under the cap on its own
    assert.equal(one(clock).decision, 'allow');
    assert.ok(clock.t >= 6000 && clock.t < EVAL_WALL_CAP_MS, `first ends at ${clock.t}`);
    // the second starts there and runs to about 10.5 s: under the cap on its own, over it counted from process start
    clock.t = 9500;
    const r = one(clock);
    assert.equal(r.decision, 'deny', `${r.decision}: ${r.reason}`);
    assert.match(r.reason, /too busy/);
  });
  test(`${name}: startup counts (an evaluation starting 9.5 s after process start that runs 1 s is denied)`, () => {
    const r = one({ t: 9500 });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /too busy/);
  });
  test(`${name}: without the hook origin an evaluation counts from its own start (a long-lived CLI process is not refused)`, () => {
    const clock = { t: 60_000 };
    const r = evaluate('bash a.sh', ticking(clock), { now: () => clock.t, cpu: () => 0 });
    assert.equal(r.decision, 'allow', `${r.decision}: ${r.reason}`);
  });
}

test('budget: HOOK_CLOCK is only the epoch origin of the wall cap (process start); the default counts from the evaluation start', () => {
  assert.deepEqual(Object.keys(HOOK_CLOCK), ['wall0'], 'no `now` or `cpu` override: the owner-go records are judged by the real epoch clock');
  assert.equal(HOOK_CLOCK.wall0, performance.timeOrigin);
  const c = { t: 60_000 };
  assert.equal(budgetExpired(newEvalBudget(() => c.t, () => 0)), false, 'default budget created at 60 s');
  c.t += 1000;
  assert.equal(budgetExpired(newEvalBudget(() => c.t, () => 0)), false);
  c.t = HOOK_CLOCK.wall0 + 11_000;
  assert.equal(budgetExpired(newEvalBudget(() => c.t, () => 0, HOOK_CLOCK.wall0)), true, 'a hook budget created 11 s after process start');
});

test('budget (hook origin): the CPU limit counts from the evaluation start, not from process start (a later command field is not refused for the time before it)', () => {
  // Failure caught: the CPU clamp used the wall since process start, so an evaluation that began 2 s in was refused after 5 s of CPU although only 4 s of its own wall had passed.
  const c = { wall: 2000, cpu: 0 };
  const budget = newEvalBudget(() => c.wall, () => c.cpu, 0);
  Object.assign(c, { wall: 6000, cpu: 5200 });
  assert.equal(budgetExpired(budget), false, '4 s of own wall bounds the 5.2 s of CPU');
  Object.assign(c, { wall: 8000, cpu: 5200 });
  assert.equal(budgetExpired(budget), true, '6 s of own wall and 5.2 s of CPU is past the CPU limit');
  assert.equal(wallLeftMs(budget), 2000, 'the wall cap is 10 s from process start');
});

test('guard-git: a bare push does not start its second lookup once the wall cap is gone, and the first one is bounded by what is left (a hook past HOOK_TIMEOUT_S is allowed)', () => {
  // Failure caught: the branch (5 s) and push-destination (3 s) lookups ran back to back after the last deadline check; at 9 s that could end past the host timeout.
  const clock = { t: 9000 };
  const seen = { branchLeft: null, destStarted: false };
  const r = git('git push', gitFs({}), {
    now: () => clock.t, cpu: () => 0, wall0: 0,
    currentBranch: (dir, o) => { seen.branchLeft = o?.leftMs?.(); clock.t = 10_500; return 'agent/x'; },
    pushDestination: () => { seen.destStarted = true; return 'origin/agent/x'; },
  });
  assert.equal(seen.branchLeft, 1000, 'the branch lookup is told what the cap has left');
  assert.equal(r.decision, 'deny');
  assert.equal(seen.destStarted, false);
});

test('the wiring lookups start nothing when no wall time is left (a throw: unknown, which the policy denies)', async () => {
  const { realGitWiring } = await import('../pipeline/hooks/lib/git-wiring.mjs');
  const w = realGitWiring();
  assert.throws(() => w.currentBranch(process.cwd(), { leftMs: () => 0 }));
  assert.throws(() => w.pushDestination(process.cwd(), { leftMs: () => 0 }));
  assert.throws(() => w.issueLabels(1, [], process.cwd(), { leftMs: () => 0 }));
});

test('a fractional wall remainder still starts a lookup (spawnSync takes whole milliseconds only); less than one whole millisecond starts none', async () => {
  // Failure caught: 4000.25 ms left (the hook's origin is a fractional epoch) passed straight to spawnSync, which throws, so an ordinary `git push` was refused with time to spare.
  const { realGitWiring } = await import('../pipeline/hooks/lib/git-wiring.mjs');
  const w = realGitWiring();
  assert.doesNotThrow(() => w.currentBranch(process.cwd(), { leftMs: () => 4000.25 }));
  assert.doesNotThrow(() => w.pushDestination(process.cwd(), { leftMs: () => 4000.25 }));
  assert.throws(() => w.currentBranch(process.cwd(), { leftMs: () => 0.5 }), GuardLimit);
});

test('a config read cut off by its timeout is a time failure (GuardLimit), not "no config" that lets the owner-approval check pass', async () => {
  // Failure caught: `git show` killed at its timeout returned null, the chat config was dropped, mode() answered none and a direct `gh pr merge` ran with no owner record.
  const { ownerGoWiring } = await import('../pipeline/hooks/lib/git-wiring.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'cfg-cut-'));
  writeFileSync(join(dir, '.git'), 'gitdir: x\n');
  const w = ownerGoWiring('sess');
  assert.throws(() => w.mode(dir, { leftMs: () => 1 }), GuardLimit);
  assert.throws(() => w.mergeTemplates(dir, { leftMs: () => 1 }), GuardLimit);
});

test('defaultGitShow: a timed-out show-ref and a timed-out show are each a GuardLimit; a git that never started is unknown, not "no config"; a plain missing ref or file is null', async () => {
  // Failure caught: (1) the show-ref check or the show check dropped, and a cut-off read answering null, which switches the owner-approval check off;
  // (2) a git child that never started (spawn EAGAIN: code 1, pid 0) read as "no config" for the same effect.
  const { defaultGitShow } = await import('../pipeline/hooks/lib/git-wiring.mjs');
  const ok = { code: 0, stdout: '', stderr: '', timedOut: false, overBuffer: false, signal: null, pid: 4242 };
  const ref = 'refs/remotes/origin/main';
  const runner = (byVerb) => (cmd, args) => ({ ...ok, ...byVerb[args.includes('show-ref') ? 'show-ref' : 'show'] });
  const cut = { code: 124, timedOut: true };
  const neverStarted = { code: 1, stderr: 'spawn git EAGAIN', pid: 0 };

  assert.throws(() => defaultGitShow('/x', ref, undefined, runner({ 'show-ref': cut, show: {} })), GuardLimit, 'show-ref cut off');
  assert.throws(() => defaultGitShow('/x', ref, undefined, runner({ 'show-ref': {}, show: cut })), GuardLimit, 'show cut off');
  assert.throws(() => defaultGitShow('/x', ref, undefined, runner({ 'show-ref': neverStarted, show: {} })), GuardLimit, 'show-ref never started');
  assert.throws(() => defaultGitShow('/x', ref, undefined, runner({ 'show-ref': {}, show: neverStarted })), GuardLimit, 'show never started');
  assert.throws(() => defaultGitShow('/x', 'HEAD', undefined, runner({ show: neverStarted })), GuardLimit, 'HEAD: show never started');

  assert.equal(defaultGitShow('/x', ref, undefined, runner({ 'show-ref': { code: 1 }, show: {} })), null, 'ref missing');
  assert.equal(defaultGitShow('/x', ref, undefined, runner({ 'show-ref': {}, show: { code: 128, stderr: 'path not in tree' } })), null, 'file missing');
  assert.equal(defaultGitShow('/x', ref, undefined, runner({ 'show-ref': {}, show: { stdout: 'owner_approval: chat\n' } })), 'owner_approval: chat\n');
});

for (const hook of ['guard-git.mjs', 'guard-files.mjs']) {
  test(`${hook} passes HOOK_CLOCK to the evaluators (the shared wall cap is opt-in by the hook entry points)`, () => {
    const src = readFileSync(new URL(`../pipeline/hooks/${hook}`, import.meta.url), 'utf8');
    assert.ok(src.includes('...HOOK_CLOCK'), `${hook} does not spread HOOK_CLOCK`);
  });
}

// ---- an exception is a denial ----------------------------------------------------------------------------------------

for (const [name, run] of both) {
  test(`${name}: a readText that throws is a denial with the error in the reason`, () => {
    const r = run('bash a.sh', { 'a.sh': 'echo hi' }, { readText: () => { throw new Error('disk gone'); } });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /disk gone/);
  });
}

// ---- variable expansion is capped ----------------------------------------------------------------------------------

const chainLine = (levels) => {
  let s = 'A=xxxxxxxxxx';
  let prev = 'A';
  for (let i = 0; i < levels; i++) {
    const n = String.fromCharCode(66 + i);
    s += `; ${n}=${`$${prev}`.repeat(10)}`;
    prev = n;
  }
  return s;
};

test('guard-files: a x10-per-level variable chain is denied quickly instead of growing without bound', () => {
  const { r, ms } = timed(() => files(`${chainLine(7)}; echo ok`, filesFs({})));
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /expand to more text/);
  assert.ok(ms < 3000, `took ${Math.round(ms)} ms of CPU`);
});

test('guard-files: a short chain that stays small is still allowed', () => {
  assert.equal(files(`${chainLine(3)}; echo ok`, filesFs({})).decision, 'allow');
});

test('guard-git: a 60k-character value repeated 1000 times in one word is denied quickly', () => {
  const line = `A=${'x'.repeat(60_000)}; git push origin ${'$A'.repeat(1000)}`;
  const { r, ms } = timed(() => git(line, gitFs({})));
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /expand to more text/);
  assert.ok(ms < 3000, `took ${Math.round(ms)} ms of CPU`);
});

test('guard-git: a 60k-character value passed as 5000 separate arguments is denied quickly (total across the line)', () => {
  const line = `A=${'x'.repeat(60_000)}; git push origin${' $A'.repeat(5000)}`;
  const { r, ms } = timed(() => git(line, gitFs({})));
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /expand to more text/);
  assert.ok(ms < 3000, `took ${Math.round(ms)} ms of CPU`);
});

test('guard-files: the same 60k value repeated is denied quickly', () => {
  const line = `A=${'x'.repeat(60_000)}; cat ${'$A'.repeat(1000)}`;
  const { r, ms } = timed(() => files(line, filesFs({})));
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /expand to more text/);
  assert.ok(ms < 3000, `took ${Math.round(ms)} ms of CPU`);
});

test('guard-git: a few small variables on a git line are still judged normally', () => {
  assert.equal(git('B=agent/x; git push origin $B', gitFs({})).decision, 'allow');
  assert.equal(git('B=main; git push origin $B', gitFs({})).decision, 'deny');
});

// ---- the hook entry points turn every failure into a denial -----------------------------------------------------------

test('runHook + guard-git policy: a readText that throws ends as a deny JSON, not an allow', async () => {
  const stdout = { out: '', write(s) { this.out += s; } };
  const evaluate = (input) => evaluateGitCommand(input.tool_input.command, {
    cwd: GIT_ROOT, home: '/home/u', currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [],
    pathExists: () => true, readDir: () => null, readText: () => { throw new Error('disk gone'); },
  });
  const result = await runHook(evaluate, { stdin: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'bash a.sh' } }), stdout });
  assert.equal(result, 'deny');
  assert.match(JSON.parse(stdout.out).hookSpecificOutput.permissionDecisionReason, /disk gone/);
});

test('runHook: an evaluator that throws on a command with no guarded word is a deny too', async () => {
  const stdout = { out: '', write(s) { this.out += s; } };
  const result = await runHook(() => { throw new Error('boom'); }, { stdin: '{"tool_name":"Bash","tool_input":{"command":"ls"}}', stdout });
  assert.equal(result, 'deny');
});

// ---- exception paths that used to read as "missing" or "no match" ------------------------------------------------------

test('guard-files: an existsSync that throws is a denial, not "the script is missing"', () => {
  const inner = filesFs({ 'a.sh': 'echo hi' });
  const r = files('bash a.sh', { ...inner, pathExists: (p) => { if (p.endsWith('a.sh')) throw new Error('stat exploded'); return inner.pathExists(p); } }); // only the script lookup breaks
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /stat exploded/);
});

// ---- regressions found replaying real commands: no false positives from the two new mechanisms ---------------------------------

// A glob word whose bracket expression does not compile (`[z-a]`, `[\w-.]`) matches NOTHING in a shell and stays literal
// (there is no nullglob), so it is judged as the literal path it is: denied when that literally names a protected path,
// otherwise left alone. It used to compile to null (nothing reachable) and, in the first version of this file, to "anything".
test('guard-files: a glob that does not compile is judged as the literal word', () => {
  const d = (c) => files(c, filesFs({})).decision;
  assert.equal(d('rm ~/.claude/pipeline/[z-a]x'), 'deny'); // literally inside a protected root
  assert.equal(d('rm ~/.cl[z-a]ude/pi*'), 'deny'); // a bracket always matches ONE character, so the word can still line up with a protected root (a superset of what the shell matches)
  assert.equal(d('rm ~/.cl[z-a]ude/zzz*'), 'allow'); // ... but only if the rest lines up
  assert.equal(d('rm src/[z-a]/page.tsx'), 'allow');
  assert.equal(d('mv a.txt out/[z-a].txt'), 'allow');
});

test('guard-files: everyday words with brackets are not "reaching" a protected root', () => {
  for (const c of [
    `node -e "console.log([...new Date(0).toISOString()].join(''))"`,
    `python3 -c "print([print(c[0]) for c in 'ab'])"`,
    `python3 -c "import re; print(re.findall(r'[\\w-.]+', 'a-b'))"`,
    `node -e "console.log('x'.match(/[\\w-.]+/))"`,
    'rm src/app/[id]/page.tsx',
    'git add src/app/[id]/page.tsx',
  ]) assert.equal(files(c, filesFs({})).decision, 'allow', c);
});

// A judged file can be up to 1 MB. The expansion cap counts text ADDED by expansion, not the size of the text it is applied
// to, or `node $S/extract.mjs $S/run/index.html` with a 700 KB report beside it was denied as "variables expand ...".
test('guard-files: a big file judged as program text is not an expansion (PATH=...:$PATH and $S lines stay allowed)', () => {
  const big = `<html>\n${'<p>some report text for the page, a few words more</p>\n'.repeat(12_000)}<p>$S \${X} $PATH</p></html>`;
  assert.ok(big.length > 600_000);
  const f = filesFs({ 's/run2/report/index.html': big, 'ctx/context.md': big, 'wt/plan.md': big, 's/scripts/extract.mjs': "console.log('x')", 'x/review.mjs': "console.log('x')" });
  const lines = [
    'export PATH="/opt/bin:$PATH"; S=/home/u/proj/s; mkdir -p $S/run2 && cd $S/run2 && node $S/scripts/extract.mjs $S/run2/report/index.html $S/run2/x >/dev/null && node -e \'console.log(1)\' $S/run2/x/report.json',
    'export PATH="$HOME/.local/bin:/opt/bin:$PATH"; node "$HOME/x/review.mjs" --worktree "/home/u/proj/wt" --plan-file "/home/u/proj/wt/plan.md" --context-file "/home/u/proj/ctx/context.md" --model m > /home/u/proj/ctx/run.log 2>&1; echo "exit $?" >> /home/u/proj/ctx/run.log',
  ];
  for (const c of lines) {
    const r = files(c, f);
    assert.equal(r.decision, 'allow', `${r.reason} <- ${c.slice(0, 60)}`);
  }
});

// ---- review R1-B1: the parameter-expansion scan is one linear pass and obeys the deadline -------------------------------------------
// `: ${x:-` + 150,000 `(` + `}` used to rescan the rest of the body for every `(` (quadratic: ~21 s, past the hook timeout, which Claude Code
// reads as allow). The text after it is a push to the protected branch, built at run time so this file holds no guarded text.
import { assertLinear, cpuTime, cpuTimed } from './helpers/timing.mjs';

const parenBomb = (n, tail) => `: \${x:-${'('.repeat(n)}}; ${tail}`;
const MAIN_PUSH = `git push origin ${'ma'}${'in'}`;
const PROTECTED_WRITE = `echo x > ~/.claude/${'sett'}${'ings.json'}`; // what guard-files refuses

for (const [name, run] of both) {
  const decide = (cmd, o) => run(cmd, {}, o);
  const BAD = name === 'guard-git' ? MAIN_PUSH : PROTECTED_WRITE;
  // 100,000 parentheses against 25,000 (linear 4x, quadratic 16x), ratio 8 is 2x from each, as in guard-r10-288 B1; a span of 2x (20,000 vs 40,000) had only 1.5x of margin and flaked under load. The line cap is 200,000 characters (MAX_LINE_CHARS): past it the guard refuses the line by its size, which costs nothing and would read as "fast", so the test below pins that 100,000 is still scanned (allowed on a frozen clock), not refused.
  // One call is only 1-20 ms there, so a sample repeats it (the baseline is tens of ms, well above the helper's slack, and a quadratic cannot hide in it).
  test(`${name}: the parenthesis scan inside \${...} is linear (CPU time at 4n vs n)`, () => {
    // both sizes are scanned, not refused by size: a frozen clock lets the harmless line through, a refusal would deny it
    for (const n of [25_000, 100_000]) assert.equal(decide(parenBomb(n, 'echo hi'), { now: () => 5 }).decision, 'allow', `${n} parentheses`);
    const REPS = 20;
    const sample = (n) => () => cpuTime(() => { for (let i = 0; i < REPS; i++) decide(parenBomb(n, 'echo hi')); });
    assertLinear(sample(25_000), sample(100_000), { label: `${name} paren scan`, factor: 4, ratio: 8 });
  });

  test(`${name}: 150,000 open parentheses in \${...} then a guarded command is denied, and fast`, () => {
    const { r, ms } = timed(() => decide(parenBomb(150_000, BAD)));
    assert.equal(r.decision, 'deny');
    assert.ok(ms < 3000, `took ${Math.round(ms)} ms of CPU`);
  });

  test(`${name}: the parenthesis scan checks the evaluation's deadline (injected clock): past it is a denial, not an allow`, () => {
    // 400 ms per clock read: the reads before the parse are few (under the 5 s deadline), the scan's periodic reads (one per 1024 characters) push it past
    const ticking = () => { let t = 1_000_000; return { now: () => (t += 400) }; };
    const r = decide(parenBomb(40_000, 'echo hi'), ticking());
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /took too long|too complex/);
    // a clock that stands still allows the same harmless line
    assert.equal(decide(parenBomb(40_000, 'echo hi'), { now: () => 5 }).decision, 'allow');
  });

  test(`${name}: balanced groups inside \${...} are still judged (\${x:-(bash f.sh)} runs nothing, but its body is read)`, () => {
    assert.equal(decide('echo ${x:-(echo hi)}').decision, 'allow');
    assert.equal(decide(`echo \${x:-(${BAD})}`).decision, 'deny');
    assert.equal(decide(`echo \${x:-((${BAD}))}`).decision, 'deny');
  });
}

// ---- the glob-qualifier scan is bounded in time and size ------------------------------------------------------------
// Work in the qualifier scan (`*(e{...})`) used to grow with the square of the group's length and ignore the evaluation deadline, so
// one long line could outlast the hook timeout (which Claude Code reads as allow). The scan is one pass, polls the deadline, stops
// collecting past MAX_QUALIFIER_CODES, and the parse is then `truncated`, which both policies deny when a guarded operation is named.
import { simpleCommands } from '../pipeline/hooks/lib/shell-parse.mjs';

const nestedQualifier = (n) => `echo *(${'e{'.repeat(n)}x${'}'.repeat(n)})`;

for (const [name, run] of both) {
  const BAD = name === 'guard-git' ? MAIN_PUSH : PROTECTED_WRITE;
  test(`${name}: a guarded command followed by a 120,000-character nested qualifier group is denied, and fast`, () => {
    const { r, ms } = timed(() => run(`${BAD}\n${nestedQualifier(40_000)}`, {}));
    assert.equal(r.decision, 'deny');
    assert.ok(ms < 2000, `took ${Math.round(ms)} ms of CPU`);
  });
}

test('qualifier scan: a deeply nested group is parsed fast and the parse is truncated', () => {
  const { r, ms } = timed(() => simpleCommands(nestedQualifier(40_000)));
  assert.equal(r.truncated, true);
  assert.ok(ms < 2000, `took ${Math.round(ms)} ms of CPU`);
});

test('qualifier scan: the scan is linear (CPU time: one parse of 16n vs 16 parses of n)', () => {
  // Equal total input, so the baseline is large: a Windows CPU clock ticks every ~15 ms and a baseline under ~30 ms is unreliable
  // (the old 2n-vs-n form read 3.0-3.8x there). A linear scan reads ~1x, a per-byte cost that climbs with input size (cache) ~2x
  // (measured on a Mac: 65 ms for 16 x n = 4,000 against 125 ms for n = 64,000), a quadratic one ~16x: 4x margin on that side.
  // n = 64,000 is a 192,009-character line, just under the 200,000-character MAX_LINE_CHARS the guards parse at all; above ~240k
  // characters the parse cost climbs steeply, which is unreachable because the guards never parse such a line.
  const parse = (n) => simpleCommands(`echo *(${'e{'.repeat(n)}x${'}'.repeat(n)})`, { maxDepth: 1 });
  const small = () => cpuTime(() => { for (let i = 0; i < 16; i++) parse(4_000); });
  const large = () => cpuTime(() => parse(64_000));
  assertLinear(small, large, { label: 'qualifier scan', factor: 1, ratio: 4 });
});

test('qualifier scan: more than MAX_QUALIFIER_CODES distinct codes is truncated, 32 or fewer is not', () => {
  const group = (n) => `ls *(${Array.from({ length: n }, (_, i) => `e{echo c${i}}`).join('')})`;
  assert.equal(simpleCommands(group(40)).truncated, true);
  assert.equal(simpleCommands(group(5)).truncated, false);
});

test('qualifier scan: an expired deadline mid-scan stops it and marks the parse truncated', () => {
  const line = `ls *(${Array.from({ length: 5000 }, () => 'e{echo hi}').join('')})`;
  let polls = 0;
  const r = simpleCommands(line, { expired: () => ++polls > 3 });
  assert.equal(r.truncated, true);
  assert.ok(polls < 100, `${polls} polls`);
  assert.equal(simpleCommands(line, { expired: () => false }).truncated, false);
});
