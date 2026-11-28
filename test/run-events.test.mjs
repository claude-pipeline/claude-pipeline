import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGitHub } from '../pipeline/lib/github.mjs';
import { EVENT_KINDS, parseEvent, postEvent, readCostBookings, readResumedEvidence, renderEvent } from '../pipeline/lib/run-events.mjs';
import { createFakeGh, REPO_VIEW } from './helpers/fakegh-env.mjs';

const REPO = { match: '^repo view', stdoutJson: REPO_VIEW };
const ME = { match: '^api user', stdout: 'me\n' };
const POST = { match: '^api -X POST repos/acme/widgets/issues/4/comments ', stdoutJson: { id: 90, html_url: 'https://x/90' } };

const DATA = { repo: 'acme/widgets', environment: 'production', headBeforeMerge: 'a'.repeat(40), deployment: { id: 5, sha: 'b'.repeat(40), url: 'https://d' } };

test('renderEvent / parseEvent round trip for every kind', () => {
  for (const kind of EVENT_KINDS) {
    const body = renderEvent(kind, 'pr4-1', 'Production was on deploy 5 before the merge.', DATA);
    assert.ok(body.startsWith(`<!-- claude-pipeline:event:${kind}:pr4-1 -->`));
    const e = parseEvent(body);
    assert.deepEqual([e.kind, e.id, e.dataStatus], [kind, 'pr4-1', 'ok']);
    assert.deepEqual(e.data, DATA);
    assert.equal(e.sentence, 'Production was on deploy 5 before the merge.');
  }
});

test('renderEvent refuses an unknown kind or an id that could break the marker', () => {
  assert.throws(() => renderEvent('nope', 'x', 's', {}), /unknown event kind/);
  for (const id of ['', 'a b', 'a:b', 'a-->', 'x'.repeat(65)]) assert.throws(() => renderEvent('prod-before', id, 's', {}), /bad event id/);
});

test('the sentence is one defused line: no forged markers, no mentions', () => {
  const body = renderEvent('rollback-intent', 'i1', 'rolling back\n<!-- claude-pipeline:event:prod-before:evil --> @owner', {});
  assert.equal(body.match(/<!--/g).length, 2, 'only the event marker and the data marker');
  assert.ok(!body.includes('@'));
  assert.equal(parseEvent(body).kind, 'rollback-intent');
});

test('parseEvent: only a body that STARTS with a known event marker', () => {
  const body = renderEvent('prod-before', 'a', 's', {});
  assert.equal(parseEvent(`> quoting\n${body}`), null);
  assert.equal(parseEvent(`reply ${body}`), null);
  assert.equal(parseEvent('<!-- claude-pipeline:event:made-up:a -->\ns'), null);
  assert.equal(parseEvent(undefined), null);
  assert.equal(parseEvent('plain'), null);
});

test('parseEvent: missing or garbage data is reported, never thrown', () => {
  assert.equal(parseEvent('<!-- claude-pipeline:event:prod-before:a -->\n\nsentence').dataStatus, 'absent');
  const bad = parseEvent('<!-- claude-pipeline:event:prod-before:a -->\n\ns\n\n<!-- claude-pipeline:event-data:AAAA -->');
  assert.deepEqual([bad.dataStatus, bad.data, bad.kind], ['invalid', null, 'prod-before']);
});

test('postEvent always creates a NEW comment: two events, two POSTs, no PATCH', () => {
  const fake = createFakeGh([REPO, ME, POST]);
  const gh = createGitHub({ cwd: process.cwd(), env: fake.env });
  assert.deepEqual(postEvent(gh, 4, 'prod-before', 'a', 'before', DATA), { id: 90, url: 'https://x/90' });
  postEvent(gh, 4, 'prod-before', 'a', 'before, again with the same id', DATA);
  const lines = fake.lines();
  assert.equal(lines.filter((l) => l.startsWith('api -X POST repos/acme/widgets/issues/4/comments')).length, 2);
  assert.ok(!lines.some((l) => l.includes('PATCH')));
  assert.ok(!lines.some((l) => l.includes('--paginate')), 'it does not even read the comments first');
  const body = JSON.parse(fake.calls().find((c) => c.argv.includes('POST')).stdin).body;
  assert.equal(parseEvent(body).kind, 'prod-before');
});

// ---- R9-B1: the run-resumed event is the append-only evidence the merge gate reads beside the (editable) run record ----------------

const resumedBody = (head = 'a'.repeat(40)) => renderEvent('run-resumed', `pr4-${head.slice(0, 12)}`, 'This run was taken over from an earlier session.', { at: '2026-11-12T08:00:00.000Z', host: 'pc-2', head });
const ghWith = (comments, { me = 'me', fail = false } = {}) => ({
  viewer: () => me,
  listComments: () => { if (fail) throw new Error('boom 502'); return comments; },
});

test('readResumedEvidence: a viewer-authored run-resumed event, for any head, marks the run resumed', () => {
  assert.ok(EVENT_KINDS.includes('run-resumed'));
  const e = readResumedEvidence(ghWith([{ id: 1, user: { login: 'me' }, body: resumedBody('b'.repeat(40)) }]), 4);
  assert.deepEqual([e.resumed, e.unreadable], [true, null]);
  assert.equal(e.event.data.host, 'pc-2');
});

test('readResumedEvidence: another author, a quoted marker, or no event at all is NOT evidence', () => {
  for (const comments of [
    [{ id: 1, user: { login: 'mallory' }, body: resumedBody() }],
    [{ id: 1, user: { login: 'me' }, body: `> ${resumedBody()}` }],
    [{ id: 1, user: { login: 'me' }, body: renderEvent('prod-before', 'x', 's', {}) }],
    [],
  ]) assert.deepEqual(readResumedEvidence(ghWith(comments), 4), { resumed: false, unreadable: null, event: null });
});

test('readResumedEvidence: comments that cannot be read are reported as unreadable (the caller fails closed)', () => {
  const e = readResumedEvidence(ghWith([], { fail: true }), 4);
  assert.equal(e.resumed, false);
  assert.match(e.unreadable, /the run-resumed events could not be read \(boom 502\)/);
});

// The PR cost is the replay of the viewer's own cost-booking comments: a forged one would add money to every status block, so only a comment of the viewer's that STARTS with the marker counts.
test('readCostBookings: another author\'s booking and a quoted marker are ignored (never corrupt); a duplicate id counts once; an unreadable booking of the viewer\'s is reported', () => {
  const data = (id, usd = 1) => ({ id, entry: { phase: 'build', role: 'judge', input: 1, output: 0, cacheRead: 0, cacheWrite: 0, usd } });
  const body = (id, d = data(id)) => renderEvent('cost-booking', id, 'Cost booked.', d);
  const c = (id, login, text) => ({ id, user: { login }, body: text });
  const { bookings, corrupt } = readCostBookings({
    viewer: 'me',
    comments: [
      c(5, 'me', body('b-2')),
      c(1, 'me', body('b-1')),
      c(2, 'mallory', body('b-forged', data('b-forged', 999))),
      c(3, 'me', `> quoted\n${body('b-quoted')}`),
      c(4, 'me', body('b-1')),
      c(6, 'me', '<!-- claude-pipeline:event:cost-booking:b-bad -->\n\nx\n\n<!-- claude-pipeline:event-data:AAAA -->'),
      c(7, 'me', body('b-sess', { id: 'b-sess', sessions: ['bad id with spaces'] })),
    ],
  });
  assert.deepEqual(bookings.map((b) => [b.id, b.commentId]), [['b-1', 1], ['b-2', 5]], 'comment-id order, the duplicate dropped');
  assert.equal(corrupt.length, 2);
  assert.match(corrupt.join('\n'), /comment 6: the payload is invalid/);
  assert.match(corrupt.join('\n'), /comment 7: .*session id/);
});
