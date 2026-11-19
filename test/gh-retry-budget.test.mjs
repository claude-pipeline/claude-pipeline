// PR #266 round 1: R1-F1 the run recorder (merge, update-branch, cost) must never retry or sleep on a rate limit, so upsertComment retries only when the caller opts in;
// R1-F2 the 100 s retry cap is ONE budget per createGitHub instance, not one per operation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGitHub } from '../pipeline/lib/github.mjs';
import { createRunRecorder } from '../pipeline/lib/run-progress.mjs';
import { writeSummaryComment } from '../pipeline/lib/summary-comment.mjs';
import { REPO_VIEW } from './helpers/fakegh-env.mjs';

const LIMIT = 'gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)';
const limitedReply = { code: 1, stdout: '', stderr: LIMIT };
const okJson = (v) => ({ code: 0, stdout: JSON.stringify(v), stderr: '' });
const MARKER = '<!-- claude-pipeline:triage -->';

// every write (POST / PATCH) is rate limited; reads answer normally
const mk = () => {
  const calls = [];
  const waits = [];
  const ghFn = (args) => {
    const line = args.join(' ');
    calls.push(line);
    if (args[0] === 'repo') return okJson(REPO_VIEW);
    if (line === 'api user -q .login') return { code: 0, stdout: 'me\n', stderr: '' };
    if (line.includes('comments --paginate')) return okJson([]);
    if (line.startsWith('pr view')) return okJson({ headRefName: 'feat/x', baseRefName: 'main', headRefOid: 'a'.repeat(40) });
    if (line.startsWith('api -X')) return limitedReply;
    throw new Error(`unexpected ${line}`);
  };
  const gh = createGitHub({ cwd: '/tmp/x', env: {}, ghFn, retry: { sleep: (ms) => waits.push(ms), log: () => {}, now: () => 0 } });
  const writes = () => calls.filter((c) => c.startsWith('api -X')).length;
  return { gh, calls, waits, writes };
};

for (const where of ['merge', 'update-branch']) {
  test(`R1-F1: a rate-limited recorder.update during ${where} makes one attempt and never sleeps`, () => {
    const { gh, waits, writes } = mk();
    const recorder = createRunRecorder({ gh, pr: 4 });
    const out = recorder.update({ inFlight: { kind: where, host: 'h', startedAt: new Date(0).toISOString(), maxMinutes: 30 } }, { initialStep: 'gate' });
    assert.equal(out, null, 'the record is display: a failed write is a warning');
    assert.equal(writes(), 1, 'exactly one write attempt');
    assert.deepEqual(waits, []);
    assert.match(recorder.warnings.join('\n'), /run record not updated/);
  });
}

test('R1-F1: upsertComment retries only with { retry: true }', () => {
  const off = mk();
  assert.throws(() => off.gh.upsertComment(4, MARKER, `${MARKER}\nx`));
  assert.equal(off.writes(), 1);
  assert.deepEqual(off.waits, []);
  const on = mk();
  assert.throws(() => on.gh.upsertComment(4, MARKER, `${MARKER}\nx`, { retry: true }));
  assert.ok(on.writes() > 1, 'opted in: waits and tries again');
  assert.ok(on.waits.length > 0);
});

test('R1-F1: writeSummaryComment passes its retry option on to upsertComment', () => {
  const seen = [];
  const gh = { viewer: () => 'me', listComments: () => [], upsertComment: (n, m, b, opts) => { seen.push(opts); return { id: 1, url: 'u', action: 'created' }; } };
  writeSummaryComment(gh, 4, { sections: 'x', retry: true });
  writeSummaryComment(gh, 4, { sections: 'x' });
  assert.deepEqual(seen, [{ retry: true }, undefined]);
});

test('R1-F2: two rate-limited operations on one gh instance never sleep more than 100 s together', () => {
  const { gh, waits } = mk();
  assert.throws(() => gh.upsertComment(4, MARKER, `${MARKER}\nx`, { retry: true }));
  const first = waits.reduce((a, b) => a + b, 0);
  assert.ok(first <= 100_000);
  assert.throws(() => gh.upsertComment(4, MARKER, `${MARKER}\ny`, { retry: true }));
  const total = waits.reduce((a, b) => a + b, 0);
  assert.ok(total <= 100_000, `slept ${total} ms in total`);
});

// After main's #396 the summary writer edits the comment it just read (updateComment) instead of upserting: the retry choice must reach that path too,
// or `P summary` / `comment --kind summary` / `checkpoint` stop waiting out a limit once the comment exists, and the recorder must still never sleep on it.
const SUMMARY = '<!-- claude-pipeline:summary -->';
const mkExisting = () => {
  const calls = [];
  const waits = [];
  const ghFn = (args) => {
    const line = args.join(' ');
    calls.push(line);
    if (args[0] === 'repo') return okJson(REPO_VIEW);
    if (line === 'api user -q .login') return { code: 0, stdout: 'me\n', stderr: '' };
    if (line.includes('comments --paginate')) return okJson([{ id: 12, body: `${SUMMARY}\n\nold`, user: { login: 'me' }, html_url: 'u12' }]);
    if (line.startsWith('pr view')) return okJson({ headRefName: 'feat/x', baseRefName: 'main', headRefOid: 'a'.repeat(40) });
    if (line.startsWith('api -X')) return limitedReply;
    throw new Error(`unexpected ${line}`);
  };
  const gh = createGitHub({ cwd: '/tmp/x', env: {}, ghFn, retry: { sleep: (ms) => waits.push(ms), log: () => {}, now: () => 0 } });
  const patches = () => calls.filter((c) => c.startsWith('api -X PATCH')).length;
  return { gh, waits, patches };
};

test('updateComment retries only with { retry: true }', () => {
  const off = mkExisting();
  assert.throws(() => off.gh.updateComment(12, SUMMARY, `${SUMMARY}\nx`));
  assert.equal(off.patches(), 1);
  assert.deepEqual(off.waits, []);
  const on = mkExisting();
  assert.throws(() => on.gh.updateComment(12, SUMMARY, `${SUMMARY}\nx`, { retry: true }));
  assert.ok(on.patches() > 1, 'opted in: waits and tries again');
  assert.ok(on.waits.reduce((a, b) => a + b, 0) <= 100_000);
});

test('writeRunRecord (via writeSummaryComment) passes retry to updateComment when the comment exists; the run recorder never sleeps on it', () => {
  const seen = [];
  const existing = { viewer: () => 'me', listComments: () => [{ id: 7, body: `${SUMMARY}\n\nold`, user: { login: 'me' } }] };
  const gh = { ...existing, updateComment: (id, m, b, opts) => { seen.push([id, opts]); return { id, url: 'u', action: 'updated' }; } };
  writeSummaryComment(gh, 4, { sections: 'x', retry: true });
  writeSummaryComment(gh, 4, { sections: 'x' });
  assert.deepEqual(seen, [[7, { retry: true }], [7, undefined]]);

  const { gh: real, waits, patches } = mkExisting();
  const recorder = createRunRecorder({ gh: real, pr: 4 });
  assert.equal(recorder.update({ inFlight: { kind: 'merge', host: 'h', startedAt: new Date(0).toISOString(), maxMinutes: 30 } }, { initialStep: 'gate' }), null);
  assert.equal(patches(), 1, 'one edit attempt');
  assert.deepEqual(waits, []);
});
