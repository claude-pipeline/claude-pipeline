// The pure classifier of CI runs (lib/ci-usage.mjs): run classes, pushes while ready, catch-up detection, the cost quantities, and the per-PR and repository totals. Fixture timelines, commits, runs and jobs; no GitHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_RATES, aggregateUsage, analysePrUsage, classifierVersion, classifyRuns, costOfJobs, headPushes, isCatchUpCommit, normalizeCommit,
  prPhaseAt, pushedWhileReady, renderUsageTable, runnerOs, wastedRedrafts,
} from '../pipeline/lib/ci-usage.mjs';

// ---- fixtures: a PR opened as a draft at 09:00, ready 10:00, back to draft 11:00 (by "me"), ready again 12:00 ----
const T = (hhmm, sec = 0) => `2026-11-10T${hhmm}:${String(sec).padStart(2, '0')}Z`;
const PR_DRAFT = { createdAt: T('09:00'), draft: false };
const ev = (event, at, login = 'me') => ({ event, created_at: at, actor: { login } });
const TIMELINE = [ev('ready_for_review', T('10:00')), ev('converted_to_draft', T('11:00')), ev('ready_for_review', T('12:00'))];
const sha = (c) => c.repeat(40);
let nextId = 1;
const run = (head, created, over = {}) => ({
  id: nextId++, name: 'ci', path: '.github/workflows/ci.yml', event: 'pull_request', head_sha: head, run_attempt: 1, conclusion: 'success',
  created_at: created, run_started_at: created, updated_at: created, ...over,
});
// a run that lasted `min` minutes
const longRun = (head, created, min, over = {}) => {
  const end = new Date(Date.parse(created) + min * 60_000).toISOString();
  return run(head, created, { updated_at: end, ...over });
};
const job = (startedAt, minutes, labels = ['ubuntu-latest'], over = {}) => ({
  run_attempt: 1, conclusion: 'success', labels, started_at: startedAt, completed_at: new Date(Date.parse(startedAt) + minutes * 60_000).toISOString(), ...over,
});
const commit = (c, over = {}) => ({ sha: sha(c), parents: [{ sha: 'p' }], committer: { login: 'me' }, commit: { message: 'work' }, ...over });

test('classifierVersion starts at 1', () => assert.equal(classifierVersion, 1));

test('prPhaseAt: opened as draft, toggled by the timeline; a PR opened ready; a PR with no events follows its flag', () => {
  const draftPr = { createdAt: T('09:00'), draft: false }; // now ready (it was ready at 12:00)
  assert.equal(prPhaseAt(TIMELINE, draftPr, T('09:30')), 'draft', 'the first event is ready_for_review, so it was opened as a draft');
  assert.equal(prPhaseAt(TIMELINE, draftPr, T('10:00')), 'ready');
  assert.equal(prPhaseAt(TIMELINE, draftPr, T('11:30')), 'draft');
  assert.equal(prPhaseAt(TIMELINE, draftPr, T('12:00', 1)), 'ready');
  const openedReady = [ev('converted_to_draft', T('11:00'))];
  assert.equal(prPhaseAt(openedReady, { createdAt: T('09:00'), draft: true }, T('10:00')), 'ready', 'the first event is converted_to_draft, so it was opened ready');
  assert.equal(prPhaseAt([], { createdAt: T('09:00'), draft: true }, T('10:00')), 'draft');
  assert.equal(prPhaseAt([], { createdAt: T('09:00'), draft: false }, T('10:00')), 'ready');
});

test('isCatchUpCommit: a web-flow 2-parent commit, or GitHub\'s update-branch message; not a one-parent or an unrelated merge', () => {
  assert.equal(isCatchUpCommit({ sha: 'a', parents: [{}, {}], committer: { login: 'web-flow' }, commit: { message: 'anything' } }), true);
  assert.equal(isCatchUpCommit({ sha: 'a', parents: [{}, {}], committer: { login: 'me' }, commit: { message: "Merge branch 'main' into agent/feat\n\nbody" } }), true);
  assert.equal(isCatchUpCommit({ sha: 'a', parents: [{}], committer: { login: 'web-flow' }, commit: { message: "Merge branch 'main' into x" } }), false, 'one parent is not a merge');
  assert.equal(isCatchUpCommit({ sha: 'a', parents: [{}, {}], committer: { login: 'me' }, commit: { message: 'Merge pull request #3 from x/y' } }), false);
  assert.deepEqual(normalizeCommit({ sha: 'a', parents: [{}, {}], committer: { login: 'web-flow' }, commit: { message: 'm' } }), { sha: 'a', parents: 2, committer: 'web-flow', message: 'm' });
  assert.equal(isCatchUpCommit({ sha: 'a', parents: 2, committer: 'web-flow', message: 'm' }), true, 'an already normalised commit works too');
});

test('classifyRuns: every class, one per run, and non-PR runs by event', () => {
  const caught = sha('c');
  const commits = [commit('a'), { ...commit('c'), parents: [{}, {}], committer: { login: 'web-flow' } }];
  const runs = [
    run(sha('1'), T('09:30')), // pushed while the PR was a draft
    run(sha('2'), T('10:01')), // 60 s after ready_for_review
    run(sha('3'), T('10:30')), // pushed while ready
    longRun(sha('3'), T('11:00', 20), 0.5, { conclusion: 'cancelled' }), // cancelled 50 s after converted_to_draft (updated_at = 11:00:50)
    run(sha('4'), T('10:40'), { run_attempt: 2 }),
    run(caught, T('10:50')),
    run(sha('5'), T('10:20'), { event: 'push' }),
    run(sha('5'), T('10:20'), { event: 'schedule' }),
  ];
  const rows = classifyRuns({ pr: PR_DRAFT, timeline: TIMELINE, commits, runs });
  assert.deepEqual(rows.map((r) => r.class), ['push-while-draft', 'ready-for-review', 'push-while-ready', 'converted-cancel', 'rerun', 'catch-up', 'other', 'other']);
  assert.deepEqual(rows.filter((r) => r.class === 'other').map((r) => r.event), ['push', 'schedule']);
  // a run 3 minutes after ready_for_review is no longer "the ready run"
  assert.equal(classifyRuns({ pr: PR_DRAFT, timeline: TIMELINE, commits: [], runs: [run(sha('9'), T('10:03'))] })[0].class, 'push-while-ready');
  // a PR whose timeline could not be read
  assert.equal(classifyRuns({ pr: null, timeline: null, runs: [run(sha('9'), T('10:03'))] })[0].class, 'unclassified');
});

test('pushedWhileReady: three workflows on one pushed head count once; the opening head, a catch-up head and a re-run are excluded', () => {
  const opening = sha('0');
  const pushed = sha('3');
  const caught = sha('c');
  const draftHead = sha('1');
  const commits = [{ ...commit('c'), parents: [{}, {}], committer: { login: 'web-flow' } }];
  const runs = [
    run(opening, T('09:00', 20)), // the PR opened with this head (a draft: not ready anyway), within 120 s of creation
    run(draftHead, T('09:30')),
    run(draftHead, T('10:00', 30), { id: 900 }), // the ready_for_review run of a head pushed in draft: not a push
    run(pushed, T('10:30', 10)), run(pushed, T('10:30', 11), { name: 'guards' }), run(pushed, T('10:30', 12), { name: 'e2e' }), // one push, three workflows
    run(caught, T('10:45')), // catch-up while ready
    // a head pushed in draft whose run was re-run (attempt 2) while the PR was ready: created_at is the original, so it is not "new"
    run(sha('r'), T('11:30'), { run_attempt: 2, run_started_at: T('12:10'), updated_at: T('12:20') }),
  ];
  const r = pushedWhileReady({ pr: PR_DRAFT, timeline: TIMELINE, commits, runs });
  assert.equal(r.count, 1);
  assert.deepEqual(r.heads.map((h) => h.sha), [pushed]);
  // a PR opened READY: its opening head is still no push
  const ready = pushedWhileReady({ pr: { createdAt: T('09:00'), draft: false }, timeline: [], commits: [], runs: [run(sha('o'), T('09:00', 30)), run(sha('p'), T('09:30'))] });
  assert.deepEqual(ready.heads.map((h) => h.sha), [sha('p')]);
  assert.equal(pushedWhileReady({ pr: PR_DRAFT, timeline: TIMELINE, runs: [] }).count, 0);
});

test('R1-B4: one ready_for_review exempts ONE head: a second head pushed within 120 s of it is a push (and its run is not the ready-for-review suite)', () => {
  const runs = [run(sha('1'), T('10:00', 30)), run(sha('1'), T('10:00', 31), { name: 'guards' }), run(sha('2'), T('10:01'))];
  const r = pushedWhileReady({ pr: PR_DRAFT, timeline: TIMELINE, commits: [], runs });
  assert.deepEqual(r.heads.map((h) => h.sha), [sha('2')]);
  assert.deepEqual(classifyRuns({ pr: PR_DRAFT, timeline: TIMELINE, commits: [], runs }).map((x) => x.class), ['ready-for-review', 'ready-for-review', 'push-while-ready']);
});

test('R1-B6: a PR opened ready with only its opening head: that run is class "opening", not push-while-ready, and nothing counts as pushed while ready', () => {
  const pr = { createdAt: T('09:00'), draft: false };
  const runs = [longRun(sha('o'), T('09:00', 30), 5)];
  assert.deepEqual(classifyRuns({ pr, timeline: [], commits: [], runs }).map((x) => x.class), ['opening']);
  assert.equal(pushedWhileReady({ pr, timeline: [], commits: [], runs }).count, 0);
});

test('headPushes: a head whose first run is the ready_for_review one is not a push (workflows that skip drafts leave no earlier run)', () => {
  const rows = headPushes({ pr: PR_DRAFT, timeline: TIMELINE, commits: [], runs: [run(sha('1'), T('10:00', 30))] });
  assert.deepEqual(rows.map((h) => [h.kind, h.phase]), [['ready-run', 'ready']]);
});

test("R1-B5: a catch-up is a merge of the PR's BASE branch (update-branch, or a local merge of origin/<base>); a merge of another branch is a push", () => {
  const merge = (message, committer = 'web-flow') => ({ sha: 'a', parents: [{}, {}], committer: { login: committer }, commit: { message } });
  assert.equal(isCatchUpCommit(merge("Merge branch 'feature-x' into topic"), 'main'), false, 'web-flow does not make a feature merge a catch-up');
  assert.equal(isCatchUpCommit(merge("Merge branch 'main' into topic"), 'main'), true);
  assert.equal(isCatchUpCommit(merge("Merge remote-tracking branch 'origin/main' into topic", 'me'), 'main'), true);
  assert.equal(isCatchUpCommit(merge("Merge remote-tracking branch 'origin/release/1' into topic", 'me'), 'release/1'), true);
  assert.equal(isCatchUpCommit(merge("Merge remote-tracking branch 'origin/feature-x' into topic", 'me'), 'main'), false);
  assert.equal(isCatchUpCommit(merge("Merge remote-tracking branch 'origin/main' into topic", 'me')), true, 'no base known: any merge of a branch');
  assert.equal(isCatchUpCommit(merge("Merge branch 'main' of github.com:acme/widgets into topic", 'me'), 'main'), true, 'R2-F1: git pull origin main');
  assert.equal(isCatchUpCommit(merge("Merge branch 'owner:main' into topic"), 'main'), true, 'R2-F1: update-branch on a fork PR');
  assert.equal(isCatchUpCommit(merge("Merge branch 'owner:feature-x' of https://github.com/owner/widgets into topic", 'me'), 'main'), false, 'R2-F1: still the base only');
  assert.equal(isCatchUpCommit(merge("Merge branch 'main' of https://github.com/Acme/widgets.git into topic", 'me'), 'main', 'acme/widgets'), true, 'R3-B2: a pull from the base repository (https, any case, .git)');
  assert.equal(isCatchUpCommit(merge("Merge branch 'main' of git@github.com:acme/widgets into topic", 'me'), 'main', 'acme/widgets'), true, 'R3-B2: the ssh form');
  assert.equal(isCatchUpCommit(merge("Merge branch 'main' of https://github.com/contributor/widgets into topic", 'me'), 'main', 'acme/widgets'), false, "R3-B2: another fork's main is not the base");
  assert.equal(isCatchUpCommit(merge("Merge branch 'main' into topic", 'me'), 'main', 'acme/widgets'), true, 'R3-B2: no URL, unchanged');
  assert.equal(isCatchUpCommit(merge("Merge branch 'main' of https://gitlab.com/acme/widgets.git into topic", 'me'), 'main', 'acme/widgets'), false, 'R4-B2: the same owner/name on another host is not the base');
  assert.equal(isCatchUpCommit(merge("Merge branch 'contributor:main' into topic", 'me'), 'main', 'acme/widgets'), false, "R4-B2: another owner's main is not the base");
  assert.equal(isCatchUpCommit(merge("Merge branch 'ACME:main' into topic", 'me'), 'main', 'acme/widgets'), true, 'R4-B2: the base owner, any case');
  assert.equal(isCatchUpCommit(merge("Merge branch 'main' of ssh://git@github.com/acme/widgets.git into topic", 'me'), 'main', 'acme/widgets'), true, 'R4-B2: ssh:// on github.com');
  assert.equal(isCatchUpCommit(merge("Merge branch 'main' of ssh://git@ssh.github.com:443/acme/widgets.git into topic", 'me'), 'main', 'acme/widgets'), true, 'R5-B3: ssh over 443 (ssh.github.com)');
  // the head of a feature merge pushed while ready is a push, not a catch-up
  const pr = { ...PR_DRAFT, baseRef: 'main' };
  const commits = [{ ...commit('c'), parents: [{}, {}], committer: { login: 'web-flow' }, commit: { message: "Merge branch 'feature-x' into topic" } }];
  assert.equal(pushedWhileReady({ pr, timeline: TIMELINE, commits, runs: [run(sha('c'), T('10:30'))] }).count, 1);
});

test('costOfJobs: three parallel shards plus one job are summed; an attempt-2 job counts on its own; the OS split puts self-hosted at 0 USD; each job rounds up', () => {
  const t0 = T('10:00');
  const jobs = [
    job(t0, 4.2), job(t0, 4.2), job(t0, 4.2), job(t0, 1), // 3 shards + 1 job on ubuntu
    job(t0, 2, ['windows-latest']),
    job(t0, 1.5, ['macos-14']),
    job(t0, 10, ['self-hosted', 'linux']),
    job(t0, 3, ['ubicloud-standard-2']),
    job(t0, 2, ['ubuntu-latest'], { run_attempt: 2 }), // the re-run's job
    job(t0, 0, ['ubuntu-latest'], { conclusion: 'skipped' }),
    { run_attempt: 1, labels: ['ubuntu-latest'], started_at: t0, completed_at: null }, // never finished
  ];
  const c = costOfJobs(jobs, DEFAULT_RATES);
  assert.deepEqual([c.minutes.windows, c.minutes.macos], [2, 1.5]);
  assert.equal(Math.round(c.minutes.linux * 100) / 100, 15.6);
  assert.equal(c.minutes['self-hosted'], 13);
  assert.equal(c.rerunMinutes, 2);
  // 3 x ceil(4.2)=5 + 1 + ceil(2)=2 on linux; 2 on windows; ceil(1.5)=2 on macos
  assert.equal(Math.round(c.usd * 1e6) / 1e6, Math.round((18 * 0.006 + 2 * 0.010 + 2 * 0.062) * 1e6) / 1e6);
  assert.deepEqual(['ubuntu-22.04', 'windows-2022', 'macos-latest', 'self-hosted', 'ubicloud-standard-4', 'custom-box'].map((l) => runnerOs([l])), ['linux', 'windows', 'macos', 'self-hosted', 'self-hosted', 'self-hosted']);
  assert.equal(runnerOs(['self-hosted', 'linux', 'x64']), 'self-hosted');
  assert.equal(costOfJobs(jobs, { ...DEFAULT_RATES, linux: 0.01 }).usd > c.usd, true, 'a rate override is used');
});

test('review round 1 B2: an unreadable timeline gives an unknown pushedWhileReady (count null), not the PR current draft flag applied to every historical push', () => {
  // a fix pushed in draft; the PR is ready now; the timeline read failed. Without the timeline the push cannot be called a missed redraft.
  const pr = { createdAt: T('09:00'), draft: false };
  const runs = [run(sha('o'), T('09:00', 30)), run(sha('f'), T('10:30'))];
  assert.deepEqual(pushedWhileReady({ pr, timeline: null, commits: [], runs }), { count: null, heads: [] });
  assert.equal(headPushes({ pr, timeline: null, commits: [], runs }).every((h) => h.phase === 'unknown'), true);
  assert.deepEqual(classifyRuns({ pr, timeline: {}, commits: [], runs }).map((x) => x.class), ['unclassified', 'unclassified'], 'a non-array timeline is unreadable too');
  // a timeline read successfully and empty is still a known history
  assert.equal(pushedWhileReady({ pr, timeline: [], commits: [], runs }).count, 1);
});

test('review round 1 B3: a run created well after its head\'s first run (a reopen, a converted_to_draft run) is class "other", not another push', () => {
  const pr = { createdAt: T('09:00'), draft: false };
  const runs = [run(sha('o'), T('09:00', 30)), run(sha('p'), T('09:30')), run(sha('p'), T('09:30', 5), { name: 'guards' }), run(sha('p'), T('10:30'))];
  // the three workflows of the push share a class; the run an hour later (reopened PR, same SHA) is not a push
  assert.deepEqual(classifyRuns({ pr, timeline: [], commits: [], runs }).map((x) => x.class), ['opening', 'push-while-ready', 'push-while-ready', 'other']);
  assert.equal(pushedWhileReady({ pr, timeline: [], commits: [], runs }).count, 1);
});

test('review round 1 B4: the ready window ends at the next converted_to_draft: a draft push or the redraft run after it is not the ready-for-review suite', () => {
  const pr = { createdAt: T('09:00'), draft: false };
  // ready at 10:00:00 started no run; the PR went back to draft at 10:00:30; a push in draft at 10:00:40 is inside 120 s of the ready event
  const tl = [ev('ready_for_review', T('10:00')), ev('converted_to_draft', T('10:00', 30))];
  const pushed = [run(sha('d'), T('10:00', 40))];
  assert.deepEqual(classifyRuns({ pr, timeline: tl, commits: [], runs: pushed }).map((x) => x.class), ['push-while-draft']);
  assert.deepEqual(headPushes({ pr, timeline: tl, commits: [], runs: pushed }).map((h) => [h.kind, h.phase]), [['push', 'draft']]);
  // ready run on sha 1 at 10:00:05; the redraft's own run on the same head at 10:00:40 is not part of the ready suite, and no push (the head did not change): other
  const redraft = [run(sha('1'), T('10:00', 5)), run(sha('1'), T('10:00', 40), { conclusion: 'skipped' })];
  const classes = classifyRuns({ pr, timeline: tl, commits: [], runs: redraft }).map((x) => x.class);
  assert.deepEqual(classes, ['ready-for-review', 'other']);
});

test('review round 1 B5: two heads first seen in the same second: the opening head is the lower run id whatever the input order', () => {
  const pr = { createdAt: T('09:00'), draft: false };
  const a = run(sha('a'), T('09:00', 10)); // the opening head (lower id)
  const b = run(sha('b'), T('09:00', 10)); // a fix pushed in the same second
  for (const runs of [[a, b], [b, a]]) assert.deepEqual(pushedWhileReady({ pr, timeline: [], commits: [], runs }).heads.map((h) => h.sha), [sha('b')]);
});

test('review round 2 B1: a reopen on the opening head or a catch-up head, long after its first run, is class "other", not another opening / catch-up', () => {
  const pr = { createdAt: T('09:00'), draft: false };
  // the PR opens on head o; it is reopened an hour later on the same head: charging that run to `opening` hides the reopen
  const opening = [run(sha('o'), T('09:00', 30)), run(sha('o'), T('10:30'))];
  assert.deepEqual(classifyRuns({ pr, timeline: [], commits: [], runs: opening }).map((x) => x.class), ['opening', 'other']);
  // the same on an update-branch head
  const merge = commit('m', { parents: [{ sha: 'a' }, { sha: 'b' }], committer: { login: 'web-flow' }, commit: { message: "Merge branch 'main' into feature" } });
  const catchup = [run(sha('o'), T('09:00', 30)), run(sha('m'), T('09:30')), run(sha('m'), T('10:30'))];
  assert.deepEqual(classifyRuns({ pr, timeline: [], commits: [merge], runs: catchup }).map((x) => x.class), ['opening', 'catch-up', 'other']);
});


test('review round 2 B3: a converted_to_draft in the same second as ready_for_review (listed after it) closes the ready window; a draft-then-ready pair does not', () => {
  const pr = { createdAt: T('09:00'), draft: false };
  const runs = [run(sha('d'), T('10:00', 10))];
  // ready, then draft, one second: the PR is a draft when the head is first seen
  const readyThenDraft = [ev('ready_for_review', T('10:00')), ev('converted_to_draft', T('10:00'))];
  assert.deepEqual(classifyRuns({ pr, timeline: readyThenDraft, commits: [], runs }).map((x) => x.class), ['push-while-draft']);
  assert.deepEqual(headPushes({ pr, timeline: readyThenDraft, commits: [], runs }).map((h) => [h.kind, h.phase]), [['push', 'draft']]);
  // draft, then ready, one second: the PR is ready, the head is the ready-for-review suite
  const draftThenReady = [ev('converted_to_draft', T('10:00')), ev('ready_for_review', T('10:00'))];
  assert.deepEqual(classifyRuns({ pr, timeline: draftThenReady, commits: [], runs }).map((x) => x.class), ['ready-for-review']);
});

test('R1-B6: the opening head of a PR opened ready is class "opening", not push-while-ready, and the PR row agrees with the repository totals', () => {
  // failure caught: the PR row and the aggregate classifying the same run differently (the row counting a push the totals call an opening)
  const pr = { createdAt: T('09:00'), draft: false };
  const runs = [longRun(sha('o'), T('09:00', 30), 5), longRun(sha('p'), T('09:30'), 5)];
  const jobsByRun = new Map(runs.map((r) => [r.id, [job(r.run_started_at, 5)]]));
  const p = analysePrUsage({ number: 4, pr, timeline: [], commits: [commit('o'), commit('p')], runs, jobsByRun });
  assert.deepEqual(p.classified.map((x) => x.class), ['opening', 'push-while-ready']);
  assert.equal(p.pushesWhileReady, 1);
  const agg = aggregateUsage({ classified: p.classified, prRows: [p], isPrivate: true });
  assert.deepEqual([agg.totals.byClass.opening.heavyRuns, agg.totals.byClass['push-while-ready'].heavyRuns], [1, 1]);
});

test('R1-B12: with sinceMs only the redrafts, ready cycles and catch-ups of the period count; the older timeline still sets the phase', () => {
  const caught = { ...commit('c'), parents: [{}, {}], committer: { login: 'web-flow' } };
  const old = { ...caught, sha: sha('d'), commit: { message: 'm', committer: { date: T('08:00') } } };
  const recent = { ...caught, commit: { message: 'm', committer: { date: T('13:30') } } };
  const runs = [run(sha('2'), T('10:30'))];
  const all = analysePrUsage({ number: 7, pr: PR_DRAFT, timeline: TIMELINE, commits: [old, recent, commit('2')], runs, viewer: 'me' });
  assert.deepEqual([all.readyCycles, all.wastedRedrafts, all.catchups], [2, 1, 2]);
  const since = analysePrUsage({ number: 7, pr: PR_DRAFT, timeline: TIMELINE, commits: [old, recent, commit('2')], runs, viewer: 'me', sinceMs: Date.parse(T('13:00')) });
  assert.deepEqual([since.readyCycles, since.wastedRedrafts, since.catchups], [0, 0, 1]);
  assert.equal(since.pushesWhileReady, 1, 'the phase at the run still comes from the whole timeline');
});

test('wastedRedrafts: draft then ready with no new head in between; a push in between or someone else\'s redraft does not count', () => {
  const none = wastedRedrafts({ pr: PR_DRAFT, timeline: TIMELINE, commits: [], runs: [run(sha('1'), T('09:30')), run(sha('2'), T('10:30'))], viewer: 'me' });
  assert.equal(none, 1, '11:00 draft -> 12:00 ready: no head created in between');
  const pushed = wastedRedrafts({ pr: PR_DRAFT, timeline: TIMELINE, commits: [], runs: [run(sha('1'), T('09:30')), run(sha('2'), T('11:30'))], viewer: 'me' });
  assert.equal(pushed, 0, 'a head was pushed while the PR was a draft');
  assert.equal(wastedRedrafts({ pr: PR_DRAFT, timeline: TIMELINE, commits: [], runs: [], viewer: 'someone-else' }), 0, 'the viewer did not convert it');
  const forced = [...TIMELINE, { event: 'head_ref_force_pushed', created_at: T('11:30') }];
  assert.equal(wastedRedrafts({ pr: PR_DRAFT, timeline: forced, commits: [], runs: [], viewer: 'me' }), 0, 'a force push is a new head');
  const committed = [...TIMELINE, { event: 'committed', sha: sha('9'), committer: { date: T('11:20') } }];
  assert.equal(wastedRedrafts({ pr: PR_DRAFT, timeline: committed, commits: [], runs: [], viewer: 'me' }), 0, 'a commit made in between is a new head');
  assert.equal(wastedRedrafts({ pr: PR_DRAFT, timeline: TIMELINE.slice(0, 2), commits: [], runs: [], viewer: 'me' }), 0, 'still a draft: nothing wasted yet');
});

test('base churn: heavy runs on a catch-up head other than the ready-for-review suite are churn, with their job minutes', () => {
  const caught = sha('c');
  const commits = [{ ...commit('c'), parents: [{}, {}], committer: { login: 'web-flow' } }];
  const runs = [
    longRun(caught, T('12:00', 30), 5), // the ready_for_review suite, on a catch-up head: intended
    longRun(caught, T('13:30'), 6, { id: 777 }), // churn
    longRun(caught, T('12:30'), 3, { id: 778 }), // churn
  ];
  const jobsByRun = new Map(runs.map((r) => [r.id, [job(r.run_started_at, (Date.parse(r.updated_at) - Date.parse(r.run_started_at)) / 60_000)]]));
  const p = analysePrUsage({ number: 7, pr: PR_DRAFT, timeline: TIMELINE, commits, runs, jobsByRun, viewer: 'me' });
  assert.equal(p.heavyRuns, 3);
  assert.equal(p.churnRuns, 2);
  assert.equal(p.churnMinutes, 9);
  assert.equal(p.catchups, 1);
  const agg = aggregateUsage({ classified: p.classified, prRows: [p], isPrivate: true });
  assert.deepEqual([agg.totals.churnRuns, agg.totals.churnMinutes, agg.totals.catchupsPerPr], [2, 9, 1]);
});

test('aggregateUsage: private estimate with coverage and assumptions; public is free; jobs not read lower the coverage; byClass/byEvent; missed redrafts by the flag', () => {
  const runs = [
    longRun(sha('3'), T('10:30'), 10), // read
    longRun(sha('4'), T('10:40'), 8), // jobs NOT read: heavy by elapsed
    run(sha('5'), T('10:20'), { event: 'push', updated_at: T('10:25') }),
    run(sha('6'), T('10:20'), { event: 'schedule' }), // tiny: not heavy
  ];
  const jobsByRun = new Map([[runs[0].id, [job(runs[0].run_started_at, 6), job(runs[0].run_started_at, 3.5, ['macos-latest'])]], [runs[2].id, [job(runs[2].run_started_at, 5)]]]);
  const p = analysePrUsage({ number: 7, pr: PR_DRAFT, timeline: TIMELINE, commits: [commit('3'), commit('4')], runs: runs.slice(0, 2), jobsByRun, viewer: 'me' });
  const classified = [...p.classified, ...classifyRuns({ runs: runs.slice(2), jobsByRun })];
  const priv = aggregateUsage({ classified, prRows: [p], isPrivate: true, draftWhileIterating: true });
  assert.equal(priv.billing, 'estimate-private');
  assert.equal(priv.totals.heavyRuns, 3);
  assert.equal(priv.totals.coverage, 67, '2 of the 3 heavy runs had their jobs read');
  assert.equal(priv.totals.estimatedUsd, Math.round((6 * 0.006 + 4 * 0.062 + 5 * 0.006) * 1e4) / 1e4);
  assert.equal(priv.totals.workflowElapsedMin, 10 + 8 + 5, 'measured elapsed is a separate quantity');
  assert.equal(priv.totals.jobMinutes.linux, 11);
  assert.equal(priv.totals.jobMinutes.macos, 3.5);
  assert.deepEqual([priv.totals.byClass.other.runs, priv.totals.byClass.other.heavyRuns], [2, 1]);
  assert.deepEqual([priv.totals.byEvent.push.heavyRuns, priv.totals.byEvent.schedule.heavyRuns], [1, 0]);
  assert.equal(priv.assumptions.rates['self-hosted'], 0);
  assert.equal(priv.assumptions.rates.linux, 0.006);
  assert.equal(priv.totals.pushesWhileReady, 2, 'both PR runs are on heads pushed while ready');
  assert.equal(priv.totals.missedRedrafts, 2, 'the flag is true: a push while ready is a missed redraft');
  assert.equal(aggregateUsage({ classified, prRows: [p], isPrivate: true, draftWhileIterating: false }).totals.missedRedrafts, 0);
  assert.equal(aggregateUsage({ classified, prRows: [p], isPrivate: true, draftWhileIterating: 'unknown' }).totals.missedRedrafts, null);
  const pub = aggregateUsage({ classified, prRows: [p], isPrivate: false });
  assert.deepEqual([pub.billing, pub.totals.estimatedUsd], ['free-public', 0]);
  // R1-B8: the PR row of a public repository is 0 too (a consumer summing the rows must get the total)
  assert.ok(p.estimatedUsd > 0);
  assert.equal(analysePrUsage({ number: 7, pr: PR_DRAFT, timeline: TIMELINE, commits: [], runs: runs.slice(0, 2), jobsByRun, viewer: 'me', isPrivate: false }).estimatedUsd, 0);
  // self-hosted jobs cost nothing
  const sh = analysePrUsage({ number: 8, pr: PR_DRAFT, timeline: TIMELINE, commits: [], runs: [runs[0]], jobsByRun: new Map([[runs[0].id, [job(runs[0].run_started_at, 9, ['self-hosted'])]]]) });
  assert.equal(aggregateUsage({ classified: sh.classified, prRows: [sh], isPrivate: true }).totals.estimatedUsd, 0);
  assert.equal(aggregateUsage({ classified: sh.classified, prRows: [sh], isPrivate: true }).totals.jobMinutes['self-hosted'], 9);
});

test('renderUsageTable: prints the PRs, the classes, the cost lines and the unexcludable note', () => {
  const runs = [longRun(sha('3'), T('10:30'), 10)];
  const jobsByRun = new Map([[runs[0].id, [job(runs[0].run_started_at, 6)]]]);
  const p = analysePrUsage({ number: 7, pr: PR_DRAFT, timeline: TIMELINE, commits: [commit('3')], runs, jobsByRun, viewer: 'me' });
  const agg = aggregateUsage({ classified: p.classified, prRows: [p], isPrivate: true, draftWhileIterating: true });
  const { classified, ...row } = p;
  const text = renderUsageTable({ since: '2026-11-06', repos: [{ slug: 'acme/widgets', private: true, classifierVersion, partial: false, draftWhileIterating: true, prs: [row], calls: 5, rateLimit: { remaining: 4000 }, skipped: {}, unexcludable: ['a note'], ...agg }] });
  assert.match(text, /CI usage since 2026-11-06 in acme\/widgets \(private; classifier v1\)/);
  assert.match(text, /#7 +2 +1 +0 +1 +/);
  assert.match(text, /push-while-ready +1 +1 +10\.0 +linux 6\.0/);
  assert.match(text, /Estimated cost \$0\.04 \(an estimate, not a bill/);
  assert.match(text, /Pushed while ready 1 · missed redrafts 1/);
  assert.match(text, /Note: a note/);
  assert.doesNotMatch(text, /[\u001b\r]/);
});

test('classifyRuns unlinked: a pull_request run with an empty link is "other" and flagged, a linked run of an unread PR stays "unclassified", and attribution counts only the unlinked', () => {
  // failure caught: the reader's last pass calling a linked run of an unread PR "other" (hiding that its PR was not read), or an unlinked run left as "unclassified" / counted twice
  const linked = longRun(sha('1'), T('10:30'), 5, { pull_requests: [{ number: 7 }] });
  const loose = longRun(sha('2'), T('10:40'), 5, { pull_requests: [] });
  const short = run(sha('3'), T('10:50'), { pull_requests: [], updated_at: T('10:50', 30) });
  const rows = classifyRuns({ runs: [linked, loose, short], unlinked: true });
  assert.deepEqual(rows.map((x) => [x.class, x.unlinked === true]), [['unclassified', false], ['other', true], ['other', true]]);
  assert.equal(classifyRuns({ runs: [loose] })[0].class, 'unclassified', 'without the option an unlinked run is unclassified, as before');
  const { totals } = aggregateUsage({ classified: rows, prRows: [], isPrivate: true });
  assert.deepEqual(totals.attribution, { unlinkedRuns: 2, linkedHeavyRuns: 1, linkedHeavyElapsedMin: 5, unlinkedHeavyRuns: 1, unlinkedHeavyElapsedMin: 5 });
  assert.equal(totals.byEvent.pull_request.runs, 2, 'each unlinked run lands in byEvent.pull_request exactly once');
});

test('analysePrUsage ambiguousHeads: a head that also has an unlinked run is left out of pushedHeads and counted in uncheckedHeads; its runs stay in the cost', () => {
  // failure caught: a head whose first run may be the unlinked draft-era one reported as pushed while ready
  const runs = [run(sha('1'), T('09:30')), longRun(sha('3'), T('10:30'), 10)];
  const jobsByRun = new Map([[runs[1].id, [job(runs[1].run_started_at, 10)]]]);
  const open = analysePrUsage({ number: 7, pr: PR_DRAFT, timeline: TIMELINE, commits: [commit('3')], runs, jobsByRun });
  assert.deepEqual([open.pushesWhileReady, open.pushedHeads, open.uncheckedHeads], [1, [sha('3').slice(0, 12)], 0]);
  const guarded = analysePrUsage({ number: 7, pr: PR_DRAFT, timeline: TIMELINE, commits: [commit('3')], runs, jobsByRun, ambiguousHeads: [sha('3')] });
  assert.deepEqual([guarded.pushesWhileReady, guarded.pushedHeads, guarded.uncheckedHeads], [0, [], 1]);
  assert.deepEqual([guarded.heavyRuns, guarded.jobMinutes.linux], [open.heavyRuns, open.jobMinutes.linux]);
  const agg = aggregateUsage({ classified: guarded.classified, prRows: [guarded], isPrivate: true, draftWhileIterating: true });
  assert.deepEqual([agg.totals.pushesWhileReady, agg.totals.missedRedrafts, agg.totals.uncheckedHeads], [0, 0, 1]);
});

test('PR #823 round 1 B3/F3/B5: a ready-phase head with no commit record, or whose commit predates the evidence window, is unchecked, not a push', () => {
  // failure caught: a catch-up merge dropped by a force push (run still linked, commit gone) named as a missed redraft; a reopened old head counted as a new push
  const runs = [run(sha('1'), T('09:30')), run(sha('3'), T('10:30'))];
  const row = (commits, evidenceFromMs) => analysePrUsage({ number: 7, pr: PR_DRAFT, timeline: TIMELINE, commits, runs, evidenceFromMs });
  const dated = (d) => commit('3', { commit: { message: 'work', committer: { date: d } } });
  assert.deepEqual([row([commit('3')]).pushesWhileReady, row([commit('3')]).uncheckedHeads], [1, 0]);
  assert.deepEqual([row([]).pushesWhileReady, row([]).uncheckedHeads], [0, 1], 'no commit record');
  assert.deepEqual([row([dated(T('11:30'))], Date.parse(T('10:00'))).pushesWhileReady, row([dated(T('11:30'))], Date.parse(T('10:00'))).uncheckedHeads], [1, 0]);
  assert.deepEqual([row([dated(T('10:30'))], Date.parse(T('10:00'))).pushesWhileReady, row([dated(T('10:30'))], Date.parse(T('10:00'))).uncheckedHeads], [0, 1], 'a commit dated within an hour after the start: its clock may be fast (PR #823 round 2 B1)');
  assert.deepEqual([row([dated(T('08:00'))], Date.parse(T('10:00'))).pushesWhileReady, row([dated(T('08:00'))], Date.parse(T('10:00'))).uncheckedHeads], [0, 1], 'older than the evidence window');
  assert.deepEqual([row([commit('3')], Date.parse(T('10:00'))).pushesWhileReady, row([commit('3')], Date.parse(T('10:00'))).uncheckedHeads], [0, 1], 'no commit date: not provable');
  // PR #823 round 3 B2: a PR created after the period start has no earlier run; the one-hour allowance is for older PRs only (failure caught: a short --since window losing most of its pushes to "unchecked")
  const fresh = analysePrUsage({ number: 7, pr: { createdAt: T('08:05'), draft: false }, timeline: TIMELINE, commits: [dated(T('08:10'))], runs, evidenceFromMs: Date.parse(T('08:00')) });
  assert.deepEqual([fresh.pushesWhileReady, fresh.uncheckedHeads], [1, 0], 'created after the start, commit 10 minutes after it: counted');
});

test('PR #823 round 1 B5: evidenceRuns (the runs of every workflow) say which run came first on a head, while the cost stays with the kept runs', () => {
  // failure caught: --workflow cutting away the draft-era run of another workflow, so the kept run looks like the first of its head
  const early = run(sha('3'), T('09:45'), { name: 'guards' });
  const late = longRun(sha('3'), T('10:30'), 10);
  const only = analysePrUsage({ number: 7, pr: PR_DRAFT, timeline: TIMELINE, commits: [commit('3')], runs: [late] });
  assert.deepEqual([only.pushesWhileReady, only.classified[0].class], [1, 'push-while-ready']);
  const seen = analysePrUsage({ number: 7, pr: PR_DRAFT, timeline: TIMELINE, commits: [commit('3')], runs: [late], evidenceRuns: [early, late] });
  assert.deepEqual([seen.pushesWhileReady, seen.classified.length, seen.classified[0].class], [0, 1, 'other']);
});

test('PR #823 round 1 B6: a heavy linked run classed "other" (a reopen on an old head) stays in the linked heavy attribution', () => {
  // failure caught: linked + unlinked heavy minutes not adding up to the pull_request heavy total
  const first = run(sha('3'), T('09:30'));
  const reopen = longRun(sha('3'), T('10:30'), 10);
  const p = analysePrUsage({ number: 7, pr: PR_DRAFT, timeline: TIMELINE, commits: [commit('3')], runs: [first, reopen] });
  assert.equal(p.classified[1].class, 'other');
  const { totals } = aggregateUsage({ classified: p.classified, prRows: [p], isPrivate: true });
  assert.deepEqual([totals.attribution.linkedHeavyRuns, totals.attribution.linkedHeavyElapsedMin], [1, 10]);
});

test('PR #823 round 1 B9: a PR row with an unknown wasted-redraft count makes the total null, and the table says unknown', () => {
  // failure caught: a null (viewer unknown) summed as 0 or printed as a number
  const p = analysePrUsage({ number: 7, pr: PR_DRAFT, timeline: TIMELINE, commits: [], runs: [], viewer: null });
  const agg = aggregateUsage({ classified: [], prRows: [{ ...p, wastedRedrafts: null }], isPrivate: true });
  assert.equal(agg.totals.wastedRedrafts, null);
  const { classified, ...row } = p;
  const text = renderUsageTable({ since: '2026-11-06', repos: [{ slug: 'acme/widgets', private: true, classifierVersion, partial: false, draftWhileIterating: true, prs: [{ ...row, wastedRedrafts: null }], calls: 1, rateLimit: null, skipped: {}, unexcludable: [], ...agg }] });
  assert.match(text, /wasted redrafts unknown/);
});

test('PR #823 round 2 B2: with a workflow filter, a head none of the kept runs belongs to is not counted (pushed, draft or unchecked)', () => {
  // failure caught: a push that only ran another workflow named in pushedHeads / pushesWhileReady for which the report holds no run
  const kept = longRun(sha('3'), T('10:30'), 10, { name: 'ci' });
  const other = run(sha('4'), T('10:40'), { name: 'docs' });
  const p = analysePrUsage({ number: 7, pr: PR_DRAFT, timeline: TIMELINE, commits: [commit('3'), commit('4')], runs: [kept], evidenceRuns: [kept, other] });
  assert.deepEqual([p.pushesWhileReady, p.pushedHeads, p.uncheckedHeads, p.pushesWhileDraft], [1, [sha('3').slice(0, 12)], 0, 0]);
});
