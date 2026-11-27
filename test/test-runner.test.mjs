// scripts/test.mjs --shard I/N: the Windows CI job runs the suite in N shards. The assignment is a pure function
// (scripts/lib/shard.mjs) so these tests need no child suite: bins must be disjoint, cover every file, and be the
// same on every call (each CI shard computes its own bin independently).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { shardFiles } from '../scripts/lib/shard.mjs';
import { buildManifest, collectFileTimes, extractManifest, extractTimes, fileListHash, medianWeights, validateRun, MANIFEST_BEGIN, MANIFEST_END, MARK_BEGIN, MARK_END } from '../scripts/lib/file-times.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const runner = join(root, 'scripts', 'test.mjs');
// A nested `node --test` inside a test must not think it is a child of the outer run (it would speak the child protocol).
// It also must not inherit the timing variables of a CI shard (a nested scripts/test.mjs would overwrite the shard's times file): a test that wants them passes its own in `extra`.
const nestedEnv = (extra = {}) => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.CP_TEST_TIMES;
  delete env.CP_TEST_TIMES_LINES;
  return { ...env, ...extra };
};
const preload = join(root, 'scripts', 'lib', 'file-times-preload.mjs');

const sample = () => [
  { name: 'a.test.mjs', size: 900 }, { name: 'b.test.mjs', size: 100 }, { name: 'c.test.mjs', size: 500 },
  { name: 'd.test.mjs', size: 500 }, { name: 'e.test.mjs', size: 40 }, { name: 'f.test.mjs', size: 4000 },
  { name: 'g.test.mjs', size: 4000 }, { name: 'h.test.mjs', size: 7 }, { name: 'i.test.mjs', size: 300 },
  { name: 'j.test.mjs', size: 300 },
];

test('shardFiles: for N in 1..4 the bins are disjoint, cover every file, and are identical across calls', () => {
  const files = sample();
  for (let n = 1; n <= 4; n++) {
    const bins = [];
    for (let i = 1; i <= n; i++) bins.push(shardFiles(files, i, n));
    const all = bins.flat();
    assert.equal(new Set(all).size, all.length, `n=${n}: no file in two bins`);
    assert.deepEqual([...all].sort(), files.map((f) => f.name).sort(), `n=${n}: every file in some bin`);
    for (let i = 1; i <= n; i++) assert.deepEqual(shardFiles(files, i, n), bins[i - 1], `n=${n} i=${i}: stable`);
    for (const bin of bins) assert.ok(bin.length > 0, `n=${n}: no empty bin when files >= n`);
  }
});

test('shardFiles: the input order does not change the assignment (the runner lists files in directory order)', () => {
  const files = sample();
  const shuffled = [...files].reverse();
  for (let i = 1; i <= 3; i++) assert.deepEqual(shardFiles(shuffled, i, 3), shardFiles(files, i, 3));
});

test('shardFiles: longest-first greedy balances the bins by bytes, ties broken by name', () => {
  const files = [
    { name: 'big1', size: 100 }, { name: 'big2', size: 100 }, { name: 'mid', size: 60 },
    { name: 'small1', size: 50 }, { name: 'small2', size: 50 },
  ];
  // 100 -> bin1, 100 -> bin2, 60 -> bin1 (100/100 tie goes to the lowest bin), 50 -> bin2 (100 < 160), 50 -> bin2 (150 < 160)
  assert.deepEqual(shardFiles(files, 1, 2), ['big1', 'mid']);
  assert.deepEqual(shardFiles(files, 2, 2), ['big2', 'small1', 'small2']);
});

test('shardFiles: a bin is returned in sorted name order', () => {
  const bin = shardFiles(sample(), 1, 2);
  assert.deepEqual(bin, [...bin].sort());
});

test('shardFiles: fewer files than shards leaves the extra bins empty, never throws', () => {
  const files = [{ name: 'only.test.mjs', size: 1 }];
  assert.deepEqual(shardFiles(files, 1, 3), ['only.test.mjs']);
  assert.deepEqual(shardFiles(files, 2, 3), []);
  assert.deepEqual(shardFiles(files, 3, 3), []);
});

test('scripts/test.mjs --shard: an invalid spec is exit 2 with a message on stderr, before any test runs', () => {
  for (const spec of ['0/3', '4/3', '1/9', 'x/3', '1/x', '1.5/3', '2', '', '1/0', '-1/3', '1/3/4']) {
    const r = spawnSync(process.execPath, [runner, '--shard', spec, 'test-runner'], { encoding: 'utf8' });
    assert.equal(r.status, 2, `--shard ${JSON.stringify(spec)}: exit ${r.status}, stderr ${r.stderr}`);
    assert.match(r.stderr, /shard/i, spec);
  }
  const missing = spawnSync(process.execPath, [runner, '--shard'], { encoding: 'utf8' });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /shard/i);
});

// ---- time-weighted shards -------------------------------------------------------------------------------------------

test('shardFiles: a measured weight overrides the size in bytes', () => {
  const files = [{ name: 'a', size: 1000 }, { name: 'b', size: 10 }, { name: 'c', size: 10 }];
  // By bytes a is alone; with b measured as the slow one the bins swap.
  assert.deepEqual(shardFiles(files, 1, 2), ['a']);
  const weights = { a: 5, b: 900, c: 800 };
  assert.deepEqual(shardFiles(files, 1, 2, weights), ['b']);
  assert.deepEqual(shardFiles(files, 2, 2, weights), ['a', 'c']);
});

test('shardFiles: a file with no measured weight is estimated as bytes x the median ms/byte of the measured files', () => {
  // measured: x 10 ms/B, y 30 ms/B, z 20 ms/B -> median 20 ms/B -> u (5 B) weighs 100, v (1 B) weighs 20
  const files = [
    { name: 'x', size: 100 }, { name: 'y', size: 100 }, { name: 'z', size: 100 }, { name: 'u', size: 5 }, { name: 'v', size: 1 },
  ];
  const weights = { x: 1000, y: 3000, z: 2000 };
  // y 3000 -> bin1, z 2000 -> bin2, x 1000 -> bin2, u 100 -> bin2 (3000 vs 3000 ties to the lowest bin: bin1)
  assert.deepEqual(shardFiles(files, 1, 2, weights), ['u', 'y']);
  assert.deepEqual(shardFiles(files, 2, 2, weights), ['v', 'x', 'z']);
  // with NO measured file the estimate is the plain size (the bytes fallback)
  assert.deepEqual(shardFiles(files, 1, 2, {}), shardFiles(files, 1, 2));
  // weights for files that no longer exist, and junk values, are ignored
  assert.deepEqual(shardFiles(files, 1, 2, { gone: 99999, x: -4, y: 'slow', z: NaN }), shardFiles(files, 1, 2));
});

test('shardFiles with weights: bins partition the files, are deterministic and ignore input order', () => {
  const files = sample();
  const weights = { 'a.test.mjs': 700, 'f.test.mjs': 90, 'c.test.mjs': 400, 'j.test.mjs': 1200 };
  for (let n = 1; n <= 4; n++) {
    const seen = [];
    for (let i = 1; i <= n; i++) {
      const bin = shardFiles(files, i, n, weights);
      assert.deepEqual(shardFiles([...files].reverse(), i, n, weights), bin, `n=${n} i=${i}: input order`);
      assert.deepEqual(shardFiles(files, i, n, weights), bin, `n=${n} i=${i}: stable`);
      seen.push(...bin);
    }
    assert.deepEqual([...seen].sort(), files.map((f) => f.name).sort(), `n=${n}: disjoint and complete`);
  }
});

test('the committed scripts/lib/test-weights.json is a plain { file: ms } object', () => {
  const w = JSON.parse(readFileSync(join(root, 'scripts', 'lib', 'test-weights.json'), 'utf8'));
  assert.ok(w && typeof w === 'object' && !Array.isArray(w));
  for (const [k, v] of Object.entries(w)) {
    assert.match(k, /\.test\.mjs$/, k);
    assert.ok(Number.isFinite(v) && v > 0, `${k}: ${v}`);
  }
});

// The span method of the plan (parent clock at the first/last event of data.file) was checked against this fixture and does NOT
// hold: Node replays the events of a later file only after the earlier file finished, so a quick file behind a slow one gets the
// slow one's end time, and a file waiting for a free slot looks started. The preload times the child process itself instead.
test('file-times preload: each file of a two-file run gets its own wall-clock span, covering setup, tests and the after-hook', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-times-'));
  try {
    const out = join(dir, 'times.json');
    const fx = (n) => join(root, 'test', 'fixtures', 'file-times', n);
    const r = spawnSync(process.execPath, ['--test', '--import', pathToFileURL(preload).href, fx('slow.mjs'), fx('quick.mjs')], {
      encoding: 'utf8', env: nestedEnv({ CP_TEST_TIMES_LINES: out }),
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const lines = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const times = collectFileTimes(lines);
    assert.deepEqual(Object.keys(times).sort(), ['quick.mjs', 'slow.mjs']);
    // 300 setup + 200 + 100 + 50 after-hook = 650 ms of work in slow.mjs; the quick file is not given the slow file's time
    assert.ok(times['slow.mjs'].spanMs >= 600, `slow.mjs span ${times['slow.mjs'].spanMs}`);
    assert.ok(times['quick.mjs'].spanMs >= 140, `quick.mjs span ${times['quick.mjs'].spanMs}`);
    assert.ok(times['quick.mjs'].spanMs < times['slow.mjs'].spanMs, 'two files are two entries, not one overwritten');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('file-times preload does nothing unless CP_TEST_TIMES_LINES is set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-times-'));
  try {
    const env = nestedEnv({ CP_TEST_TIMES: join(dir, 'times.json') }); // the caller's CP_TEST_TIMES alone is not enough
    const r = spawnSync(process.execPath, ['--test', '--import', pathToFileURL(preload).href, join(root, 'test', 'fixtures', 'file-times', 'quick.mjs')], { encoding: 'utf8', env, cwd: dir });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(readdirSync(dir), [], 'no file written');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('collectFileTimes: one entry per file by base name (Windows and POSIX paths), the longest span wins, junk lines are skipped', () => {
  const t = collectFileTimes([
    { file: 'D:\\a\\p\\test\\one.test.mjs', ms: 1234.4 }, { file: '/x/test/two.test.mjs', ms: 90 },
    { file: '/x/test/two.test.mjs', ms: 70 }, { file: '', ms: 5 }, { file: 'bad.mjs', ms: 'x' }, null, { file: 'neg.mjs', ms: -1 },
  ]);
  assert.deepEqual(t, { 'one.test.mjs': { spanMs: 1234 }, 'two.test.mjs': { spanMs: 90 } });
});

test('scripts/test.mjs with CP_TEST_TIMES writes { file: { spanMs } } and a manifest for the files it ran, then removes its scratch file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-times-'));
  try {
    const out = join(dir, 'times.json');
    const r = spawnSync(process.execPath, [runner, 'glob.test'], { encoding: 'utf8', env: nestedEnv({ CP_TEST_TIMES: out }) });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const t = JSON.parse(readFileSync(out, 'utf8'));
    assert.deepEqual(Object.keys(t), ['glob.test.mjs']);
    assert.ok(t['glob.test.mjs'].spanMs > 0);
    assert.deepEqual(readdirSync(dir).sort(), ['times.json', 'times.json.manifest'], 'the lines scratch file is gone');
    // the manifest names this run's files, no shard, and the full list (here the same single file)
    assert.deepEqual(JSON.parse(readFileSync(`${out}.manifest`, 'utf8')), { shard: null, files: ['glob.test.mjs'], fullCount: 1, fullHash: fileListHash(['glob.test.mjs']) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A test file that runs its own scripts/test.mjs (this very file does) inherits what the outer runner gave it. If that included the shard's
// CP_TEST_TIMES, the nested runner deleted and overwrote the shard's timing files and the weights refresh saw a handful of entries.
test('a nested runner probe wipes the shard\'s timing file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-times-'));
  try {
    const out = join(dir, 'times.json');
    const r = spawnSync(process.execPath, [runner, 'glob.test.mjs', 'runner-env-probe.test.mjs'], {
      encoding: 'utf8', env: nestedEnv({ CP_TEST_TIMES: out, CP_PROBE_NEST: '1' }),
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    // glob.test.mjs finished long before the probe started its nested runner; its entry must survive that
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(out, 'utf8'))), ['glob.test.mjs', 'runner-env-probe.test.mjs']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- scripts/shard-weights.mjs -------------------------------------------------------------------------------------------

const logOf = (json, job = 'test (windows 1/3)') => [
  `${job}\tUNKNOWN STEP\t2026-11-04T10:16:42.4516937Z ✔ something (12.5ms)`,
  `${job}\tUNKNOWN STEP\t2026-11-04T10:36:07.0000000Z ${MARK_BEGIN}`,
  `${job}\tUNKNOWN STEP\t2026-11-04T10:36:07.0000001Z ${json}`,
  `${job}\tUNKNOWN STEP\t2026-11-04T10:36:07.0000002Z ${MARK_END}`,
  `${job}\tUNKNOWN STEP\t2026-11-04T10:36:08.1946673Z ℹ pass 2005`,
].join('\r\n');

test('extractTimes: reads the JSON between the marker lines of a Windows job log (CRLF, step prefix and timestamp stripped)', () => {
  const t = extractTimes(logOf(JSON.stringify({ 'a.test.mjs': { spanMs: 1500 }, 'b.test.mjs': { spanMs: 20 } })));
  assert.deepEqual(t, { 'a.test.mjs': { spanMs: 1500 }, 'b.test.mjs': { spanMs: 20 } });
});

test('extractTimes: no markers, an unterminated block or invalid JSON is null, never a throw', () => {
  assert.equal(extractTimes('just a log\nwith lines'), null);
  assert.equal(extractTimes(`2026-11-04T10:36:07Z ${MARK_BEGIN}\n2026-11-04T10:36:08Z {"a":`), null);
  assert.equal(extractTimes(logOf('{not json')), null);
});

test('medianWeights: median ms per file over the runs that measured it, rounded, sorted by name', () => {
  const w = medianWeights([
    { 'b.test.mjs': { spanMs: 100 }, 'a.test.mjs': { spanMs: 10 } },
    { 'b.test.mjs': { spanMs: 300 } },
    { 'b.test.mjs': { spanMs: 200 }, 'a.test.mjs': { spanMs: 31 } },
    { 'junk.test.mjs': { spanMs: 0 }, 'worse.test.mjs': null },
  ]);
  assert.deepEqual(w, { 'a.test.mjs': 21, 'b.test.mjs': 200 });
  assert.deepEqual(Object.keys(w), ['a.test.mjs', 'b.test.mjs']);
});

test('scripts/shard-weights.mjs: no run id, or a non-numeric one, is a usage error (exit 2) and leaves the weights file alone', () => {
  const file = join(root, 'scripts', 'lib', 'test-weights.json');
  const before = readFileSync(file, 'utf8');
  for (const argv of [[], ['abc'], ['123', '--x']]) {
    const r = spawnSync(process.execPath, [join(root, 'scripts', 'shard-weights.mjs'), ...argv], { encoding: 'utf8' });
    assert.equal(r.status, 2, `${JSON.stringify(argv)}: ${r.stderr}`);
    assert.match(r.stderr, /usage/);
  }
  assert.equal(readFileSync(file, 'utf8'), before);
});

// One CI run of three Windows shards over six files, as shard-weights.mjs hands it to validateRun (times and manifest as parsed from each job log).
const fullList = ['a.test.mjs', 'b.test.mjs', 'c.test.mjs', 'd.test.mjs', 'e.test.mjs', 'f.test.mjs'];
const wjob = (i, files, over = {}) => ({
  name: `test (windows ${i}/3)`, conclusion: 'success',
  times: Object.fromEntries(files.map((f) => [f, { spanMs: 1000 }])),
  manifest: buildManifest({ shard: `${i}/3`, files, full: fullList }),
  ...over,
});
const wholeRun = () => [wjob(1, ['a.test.mjs', 'd.test.mjs']), wjob(2, ['b.test.mjs', 'e.test.mjs']), wjob(3, ['c.test.mjs', 'f.test.mjs'])];

test('extractManifest: reads the manifest block of a job log, and the times block is not mistaken for it', () => {
  const m = buildManifest({ shard: '2/3', files: ['b.test.mjs', 'a.test.mjs'], full: fullList });
  const log = [`2026-11-04T10:00:00.0Z ${MARK_BEGIN}`, '2026-11-04T10:00:00.1Z {"a.test.mjs":{"spanMs":5}}', `2026-11-04T10:00:00.2Z ${MARK_END}`,
    `2026-11-04T10:00:00.3Z ${MANIFEST_BEGIN}`, `2026-11-04T10:00:00.4Z ${JSON.stringify(m)}`, `2026-11-04T10:00:00.5Z ${MANIFEST_END}`].join('\r\n');
  assert.deepEqual(extractManifest(log), { shard: '2/3', files: ['a.test.mjs', 'b.test.mjs'], fullCount: 6, fullHash: fileListHash(fullList) });
  assert.deepEqual(extractTimes(log), { 'a.test.mjs': { spanMs: 5 } });
  assert.equal(extractManifest('no markers here'), null);
});

// The failure: scripts/shard-weights.mjs merged whatever blocks it found, so a run with a missing, failed or half-measured shard
// overwrote test-weights.json with a handful of entries and every later shard was balanced by (almost) bytes again.
test('a partial timing sample overwrites weights: validateRun takes a whole run and rejects every partial one', () => {
  const ok = validateRun(wholeRun());
  assert.equal(ok.ok, true);
  assert.deepEqual(Object.keys(ok.times), ['a.test.mjs', 'd.test.mjs', 'b.test.mjs', 'e.test.mjs', 'c.test.mjs', 'f.test.mjs']);

  const reject = (jobs, why) => {
    const v = validateRun(jobs);
    assert.equal(v.ok, false, why);
    assert.match(v.reason, new RegExp(why), JSON.stringify(v));
  };
  reject(wholeRun().slice(0, 2), 'shard 3/3 is missing'); // a whole job absent
  reject([...wholeRun(), wjob(2, ['b.test.mjs', 'e.test.mjs'])], 'shard 2/3 appears more than once'); // duplicate shard index
  reject(wholeRun().map((j, k) => (k === 1 ? { ...j, conclusion: 'failure' } : j)), 'concluded "failure"'); // failed job
  reject(wholeRun().map((j, k) => (k === 2 ? { ...j, conclusion: null } : j)), 'concluded null');
  for (const bad of [0, NaN, -5, undefined]) { // invalid span for a listed file
    const jobs = wholeRun();
    jobs[0].times['d.test.mjs'] = bad === undefined ? {} : { spanMs: bad };
    reject(jobs, 'd.test.mjs has no valid spanMs');
  }
  const noTimes = wholeRun();
  noTimes[1].times = null;
  reject(noTimes, 'b.test.mjs has no valid spanMs');
  const noManifest = wholeRun();
  noManifest[2].manifest = null;
  reject(noManifest, 'has no manifest');
  reject([wjob(1, []), wjob(2, []), { ...wjob(3, []), name: 'test (windows 3/4)' }], 'disagree on the shard count');
  reject([], 'no Windows shard jobs');
  // manifests of different lists, overlapping shards, a shard that lost files
  const other = wholeRun();
  other[1].manifest = buildManifest({ shard: '2/3', files: ['b.test.mjs', 'e.test.mjs'], full: [...fullList, 'g.test.mjs'] });
  reject(other, 'disagree on the full file list');
  const overlap = wholeRun();
  overlap[1] = wjob(2, ['b.test.mjs', 'a.test.mjs']);
  reject(overlap, 'a.test.mjs is listed by more than one shard');
  const short = wholeRun();
  short[2] = wjob(3, ['c.test.mjs']);
  reject(short, 'the shards list 5 files, the full list has 6');
  const wrongLabel = wholeRun();
  wrongLabel[0].manifest = buildManifest({ shard: '3/3', files: ['a.test.mjs', 'd.test.mjs'], full: fullList });
  reject(wrongLabel, 'manifest says shard "3/3"');
});

// ---- name selection ------------------------------------------------------------------------------------------------
// The quick check lists `cli.test.mjs`: an argument ending in .test.mjs names exactly one file (a substring `cli` would
// also pick every *-cli test), other arguments stay substring filters.

const pool = ['cli.test.mjs', 'ci-wait-cli.test.mjs', 'cli-review.test.mjs', 'config.test.mjs', 'docs-facts.test.mjs'];

test('selectTestFiles: an argument ending in .test.mjs selects exactly that file, not the files that contain it', async () => {
  const { selectTestFiles } = await import('../scripts/lib/select-tests.mjs');
  assert.deepEqual(selectTestFiles(pool, ['cli.test.mjs']), { names: ['cli.test.mjs'], missing: [] });
  assert.deepEqual(selectTestFiles(pool, ['ci-wait-cli.test.mjs']).names, ['ci-wait-cli.test.mjs']);
});

test('selectTestFiles: other arguments keep the substring match, and exact and substring arguments combine', async () => {
  const { selectTestFiles } = await import('../scripts/lib/select-tests.mjs');
  assert.deepEqual(selectTestFiles(pool, ['cli']).names, ['cli.test.mjs', 'ci-wait-cli.test.mjs', 'cli-review.test.mjs']);
  assert.deepEqual(selectTestFiles(pool, ['config', 'cli.test.mjs']).names, ['cli.test.mjs', 'config.test.mjs']);
  assert.deepEqual(selectTestFiles(pool, []).names, pool);
});

test('selectTestFiles: an exact .test.mjs argument that names no file is reported as missing', async () => {
  const { selectTestFiles } = await import('../scripts/lib/select-tests.mjs');
  assert.deepEqual(selectTestFiles(pool, ['config', 'clii.test.mjs']), { names: ['config.test.mjs'], missing: ['clii.test.mjs'] });
  // a .test.mjs argument is never a substring: `ci.test.mjs` does not match ci-wait-cli.test.mjs
  assert.deepEqual(selectTestFiles(pool, ['ci.test.mjs']), { names: [], missing: ['ci.test.mjs'] });
});

test('selectTestFiles: a substring argument that matches no file is reported as missing; a matching one is not', async () => {
  const { selectTestFiles } = await import('../scripts/lib/select-tests.mjs');
  assert.deepEqual(selectTestFiles(pool, ['config', 'no-such-substring']), { names: ['config.test.mjs'], missing: ['no-such-substring'] });
  assert.deepEqual(selectTestFiles(pool, ['config', 'docs']), { names: ['config.test.mjs', 'docs-facts.test.mjs'], missing: [] });
  // both kinds at once, in argument order
  assert.deepEqual(selectTestFiles(pool, ['nope', 'clii.test.mjs']).missing, ['nope', 'clii.test.mjs']);
});

test('scripts/test.mjs: an unknown exact .test.mjs name is exit 2 naming it, even when other arguments match', () => {
  for (const argv of [['no-such-file.test.mjs'], ['test-runner', 'no-such-file.test.mjs']]) {
    const r = spawnSync(process.execPath, [runner, ...argv], { encoding: 'utf8', env: nestedEnv() });
    assert.equal(r.status, 2, `${argv}: exit ${r.status}, stderr ${r.stderr}`);
    assert.match(r.stderr, /no-such-file\.test\.mjs \(exact file name\)/);
    assert.doesNotMatch(r.stdout, /^# tests/m, 'no test ran');
  }
});

test('scripts/test.mjs: a substring that matches nothing is exit 2 naming it, even when other arguments match', () => {
  for (const [argv, label] of [
    [['zzz-no-such-substring'], /zzz-no-such-substring \(substring filter\)/],
    [['config.test.mjs', 'no-such-substring-xyz'], /no-such-substring-xyz \(substring filter\)/],
  ]) {
    const r = spawnSync(process.execPath, [runner, ...argv], { encoding: 'utf8', env: nestedEnv() });
    assert.equal(r.status, 2, `${argv}: exit ${r.status}, stderr ${r.stderr}`);
    assert.match(r.stderr, label);
    assert.doesNotMatch(r.stdout, /^# tests/m, 'no test ran');
  }
});

test('verify --quick lists exact .test.mjs files only, each present in test/ (a renamed file must not quietly drop out)', () => {
  const src = readFileSync(join(root, 'scripts', 'verify.mjs'), 'utf8');
  const quick = /quickCmd: '([^']*)'/.exec(src)?.[1] ?? '';
  const all = quick.split(/\s+/).slice(quick.split(/\s+/).indexOf('scripts/test.mjs') + 1).filter(Boolean);
  assert.ok(all.includes('--related'), 'quick also runs the tests related to the branch changes');
  const args = all.filter((a) => a !== '--related'); // the flag; every other argument is a named file
  assert.ok(args.length > 0, `no arguments after scripts/test.mjs in "${quick}"`);
  for (const a of args) {
    assert.ok(a.endsWith('.test.mjs'), `${a} must be an exact .test.mjs name, not a substring`);
    assert.ok(existsSync(join(root, 'test', a)), `test/${a} does not exist`);
  }
  assert.ok(args.includes('cli.test.mjs'), 'a bare `cli` would also run every *-cli test');
  assert.ok(args.includes('test-runner.test.mjs'), 'the quick check must test its own file selection');
  assert.ok(!args.includes('worktree-prune-config-fallback.test.mjs'), 'the slow prune fallback test is not a quick check');
});

// ---- #472 Task 1: pending clicks are settled by the readers, so a test must never settle the owner's real ones ------------------------------
// Already recorded clicks still count; PIPELINE_CLICK_SETTLE=off only stops pending clicks from becoming records through the readers. Strict lookups still see unresolved round clicks,
// so setting it never widens what is approved.

test('the test runner gives every test file PIPELINE_CLICK_SETTLE=off, whatever the caller had set', () => {
  for (const before of [undefined, 'on', '']) {
    const env = nestedEnv();
    if (before === undefined) delete env.PIPELINE_CLICK_SETTLE; else env.PIPELINE_CLICK_SETTLE = before;
    const r = spawnSync(process.execPath, [runner, 'runner-env-probe.test.mjs'], { encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /PROBE PIPELINE_CLICK_SETTLE=off\b/, `caller had ${JSON.stringify(before)}`);
  }
});

test('test/helpers/owner-go.mjs sets PIPELINE_CLICK_SETTLE=off when it is imported', () => {
  const helper = join(root, 'test', 'helpers', 'owner-go.mjs');
  const child = join(root, 'test', 'helpers', 'print-settle-env.mjs');
  for (const before of [undefined, 'on']) {
    const env = nestedEnv();
    if (before === undefined) delete env.PIPELINE_CLICK_SETTLE; else env.PIPELINE_CLICK_SETTLE = before;
    const r = spawnSync(process.execPath, [child, helper], { encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stdout.trim(), 'SETTLE=off', `caller had ${JSON.stringify(before)}`);
  }
  const control = spawnSync(process.execPath, [child, join(root, 'pipeline', 'hooks', 'lib', 'owner-go.mjs')], { encoding: 'utf8', env: (() => { const e = nestedEnv(); delete e.PIPELINE_CLICK_SETTLE; return e; })() });
  assert.equal(control.stdout.trim(), 'SETTLE=(unset)', 'the library itself never sets it: only tests do');
});
