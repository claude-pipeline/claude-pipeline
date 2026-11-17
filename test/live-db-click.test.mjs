// #262 (live-database guard) x #261 (click-to-approve): the owner's go for a live Supabase change as a CLICK on the dialog `live-db present --ask` returns (ask kind `live-db`). Scratch home, real git, a real
// 2.1.323 click transcript (test/fixtures/click). The typed go (test/live-db-guard.test.mjs) is the fallback and stays unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { ymlFor } from './helpers/gate-env.mjs';
import { run as runDbRefs } from '../pipeline/commands/db-refs.mjs';
import { run as runLiveDb } from '../pipeline/commands/live-db.mjs';
import { buildBlock, sha256Of } from '../pipeline/hooks/lib/live-db-go.mjs';
import { claimLiveDbGo, evaluateSupabaseMcp } from '../pipeline/hooks/lib/live-db-guard.mjs';
import { asksDir, clickProvenance, liveDbAsk, issueAsk, matchesInstalledDialog, readAsk, recordClick } from '../pipeline/hooks/lib/owner-go-click.mjs';
import { readRecords } from '../pipeline/hooks/lib/owner-go.mjs';

const REF = 'abcdefghij0123456789';
const OTHER = 'klmnopqrst0123456789';
const NAME = '20261117000000_add_col';
const FILE = `supabase/migrations/${NAME}.sql`;
const SQL = 'alter table t add column c int;\n';
const LABEL = 'EagleWatch prod';
const TOOL = 'mcp__plugin_supabase_supabase__';
const OK = () => ({ ok: true, hookLayersSha256: null });
const noSleep = async () => {};
const fixture = () => readFileSync(new URL('./fixtures/click/2.1.323/genuine-click.jsonl', import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const text = (es) => `${es.map((e) => JSON.stringify(e)).join('\n')}\n`;

// One world: registry, a repo with the migration, the block `present` prints, the issued ask and a 2.1.323 transcript (prompt + tool_use; the answer's entry is appended by w.flush()).
// `reply`: the assistant texts printed before the dialog, one transcript entry each, or a function (block, dir) -> texts (default: the block `present` printed, pasted last).
const dir0 = (repo) => repo.dir;
async function world(t, { op = 'migration', answer = null, flush = false, modelAnswers = false, reply = null } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'cp-live-db-click-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.claude'), { recursive: true });
  const own = { home, env: {}, hasClaudeCodeAncestor: () => false };
  await runDbRefs(['set', '--ref', REF, '--name', LABEL, '--repo', 'acme/widgets'], own);
  await runDbRefs(['set', '--ref', OTHER, '--name', 'Other live', '--repo', 'acme/widgets'], own);
  const repo = createTmpRepo();
  repo.git(['remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);
  repo.write(FILE, SQL);
  const head = repo.commit('init');
  const dataSql = 'update t set a = 1 where id = 7';
  const block = (op === 'migration'
    ? buildBlock({ op, ref: REF, label: LABEL, name: NAME, file: FILE, head, repo: 'acme/widgets', dir: repo.dir, sql: SQL, summary: 'adds c' })
    : buildBlock({ op, ref: REF, label: LABEL, repo: 'acme/widgets', dir: repo.dir, sql: dataSql, summary: 'fix' })).join('\n');
  const arg = op === 'migration' ? NAME : sha256Of(dataSql).slice(0, 12);
  const parts = liveDbAsk({ repo: 'acme/widgets', pr: op === 'migration' ? 7 : null, block, op, arg, label: LABEL, ref: REF });
  const [prompt, use, result] = fixture();
  const issuedAt = Date.parse(use.timestamp) - 10000;
  const issued = issueAsk({ ...parts, home, now: () => issuedAt });
  assert.ok(issued.askId, JSON.stringify(issued));
  const dialog = issued.questions[0];
  const chosen = answer ?? Object.keys(parts.actions).find((l) => parts.actions[l] !== null);
  const tu = use.message.content.find((b) => b.type === 'tool_use');
  tu.input = modelAnswers ? { questions: [dialog], answers: { [dialog.question]: chosen } } : { questions: [dialog] };
  result.toolUseResult = { ...result.toolUseResult, questions: [structuredClone(dialog)], answers: { [dialog.question]: chosen } };
  result.message.content[0].content = `Your questions have been answered: "${dialog.question}"="${chosen}". You can now continue with these answers in mind.`;
  mkdirSync(join(home, '.claude-t', 'projects', '-repo'), { recursive: true });
  const file = join(home, '.claude-t', 'projects', '-repo', `${use.sessionId}.jsonl`);
  const said = (typeof reply === 'function' ? reply(block, dir0(repo)) : reply ?? [block]).map((txt, i) => ({ ...structuredClone(use), uuid: `11111111-0000-4000-8000-00000000000${i}`, message: { role: 'assistant', content: [{ type: 'text', text: txt }] }, timestamp: new Date(Date.parse(use.timestamp) - 5000 + i).toISOString() }));
  said.forEach((e, i) => { e.parentUuid = i === 0 ? prompt.uuid : said[i - 1].uuid; });
  use.parentUuid = said.length ? said[said.length - 1].uuid : prompt.uuid;
  writeFileSync(file, text(flush ? [prompt, ...said, use, result] : [prompt, ...said, use]));
  const answeredAt = Date.parse(result.timestamp);
  const w = {
    home, repo, head, file, session: use.sessionId, dialog, parts, askId: issued.askId, issued, answeredAt, block, dataSql, op, arg,
    t: answeredAt + 1000,
    input: { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', session_id: use.sessionId, transcript_path: file, cwd: repo.dir, tool_use_id: tu.id, tool_input: { questions: [dialog], answers: { [dialog.question]: chosen }, annotations: {} }, tool_response: {} },
  };
  w.hook = () => recordClick(w.input, { home, now: () => w.t, sleep: noSleep, pollMs: 0, hookCheck: OK });
  w.flush = () => appendFileSync(file, text([result]));
  w.claim = (over = {}) => claimLiveDbGo({ home, sessionId: w.session, transcriptPath: file, op, projectRef: REF, name: op === 'migration' ? NAME : null, sqlSha256: sha256Of(op === 'migration' ? SQL : dataSql), now: () => w.t, ...over });
  w.apply = (over = {}) => evaluateSupabaseMcp(`${TOOL}apply_migration`, { project_id: REF, name: NAME, query: SQL, ...over }, { home, sessionId: w.session, transcriptPath: file, now: () => w.t });
  w.records = () => readRecords({ home, session: w.session, now: () => w.t, maxAgeMs: Infinity, settle: false });
  return w;
}

test('a click on the dialog records the typed go\'s record plus via ask, and the guard lets exactly that apply through once (a second apply is refused)', async (t) => {
  const w = await world(t, { flush: true });
  assert.equal(w.dialog.question, `Apply migration ${NAME} (#7) to ${LABEL} (${REF})? (${w.askId})\n\n${w.block}`);
  assert.deepEqual(w.dialog.options.map((o) => o.label), [`Yes, apply ${NAME}`, 'Not yet']);
  const r = await w.hook();
  assert.equal(r.recorded?.via, 'ask', JSON.stringify(r));
  assert.equal(r.kind, 'live-db');
  const rec = w.records()[0];
  assert.deepEqual({ kind: rec.kind, op: rec.op, projectRef: rec.projectRef, sqlSha256: rec.sqlSha256, name: rec.name, head: rec.head, file: rec.file, repo: rec.repo, prompt: rec.prompt, via: rec.via }, { kind: 'live-db-go', op: 'migration', projectRef: REF, sqlSha256: sha256Of(SQL), name: NAME, head: w.head, file: FILE, repo: 'acme/widgets', prompt: `go migration ${NAME}`, via: 'ask' });
  assert.equal(clickProvenance(rec, { home: w.home }), 'owner');
  assert.equal(w.apply().decision, 'allow');
  const again = w.apply();
  assert.equal(again.decision, 'deny');
  assert.match(again.reason, /already used/);
  assert.equal(readdirSync(join(w.home, '.claude', 'pipeline-state', 'owner-go', 'live-db-consumed')).length, 1);
});

test('a click counts only when the reply right before the dialog ends with the block the dialog carries (R6-F1): no block, an abridged or another block, or text after it is not claimed', async (t) => {
  const other = (dir) => buildBlock({ op: 'data', ref: REF, label: LABEL, repo: 'acme/widgets', dir, sql: 'update t set a = 2 where id = 7', summary: 'fix' }).join('\n');
  const cases = [
    ['no block in the reply', () => ['I will now ask you.']],
    ['no text at all', () => []],
    ['an abridged block', (b) => ['Apply the migration?', b.split('\n').slice(-4).join('\n')]],
    ['another valid block', (b, dir) => [other(dir)]],
    ['text after the block', (b) => [b, 'Here is the dialog.']],
  ];
  for (const [what, reply] of cases) {
    const w = await world(t, { flush: true, reply });
    assert.ok((await w.hook()).recorded, what);
    const c = w.claim();
    assert.equal(c.status, 'unverified', what);
    assert.match(c.reason, /paste its block as the last thing/, what);
    assert.equal(w.apply().decision, 'deny', what);
  }
  const ok = await world(t, { flush: true, reply: (b) => ['Some narrative first.', b] });
  assert.ok((await ok.hook()).recorded);
  assert.equal(ok.claim().status, 'claimed', 'the exact block pasted last');
});

test('the click binds only the exact block: another query, name or project is not claimed; an expired click (2 h after the answer) is refused', async (t) => {
  const w = await world(t, { flush: true });
  assert.ok((await w.hook()).recorded);
  assert.equal(w.claim({ sqlSha256: sha256Of('drop table t;') }).status, 'none');
  assert.equal(w.claim({ name: '20261117000001_other' }).status, 'none');
  assert.equal(w.claim({ projectRef: OTHER }).status, 'none');
  assert.equal(w.claim({ op: 'data', name: null }).status, 'none');
  assert.equal(w.claim({ now: () => w.answeredAt + 2 * 3600 * 1000 + 1000 }).status, 'expired');
  assert.equal(w.claim({ transcriptPath: `${w.file}.other` }).status, 'unverified');
  assert.equal(w.claim().status, 'claimed');
});

test('a data fix is a click too: title with the sha, no PR, claimed once', async (t) => {
  const w = await world(t, { op: 'data', flush: true });
  assert.equal(w.dialog.question.split('\n\n')[0], `Run data SQL ${w.arg} on ${LABEL} (${REF})? (${w.askId})`);
  assert.deepEqual(readAsk(w.askId, { home: w.home }).ask.prs, []);
  assert.ok((await w.hook()).recorded);
  assert.equal(w.claim().status, 'claimed');
  assert.equal(w.claim().status, 'spent');
});

test('2.1.323 write order: the click is pending at the hook, the claim says unverified (type the go) until the entry lands, then settles it and claims', async (t) => {
  const w = await world(t);
  const r = await w.hook();
  assert.ok(r.pending, JSON.stringify(r));
  assert.equal(w.records().length, 0);
  const early = w.claim();
  assert.equal(early.status, 'unverified');
  assert.match(early.reason, /type the go/);
  w.flush();
  assert.equal(w.claim().status, 'claimed', 'the claim settled the pending click first');
  assert.equal(w.records().length, 1);
  assert.equal(w.claim().status, 'spent');
});

test('declining records nothing; a dialog the model prefilled with answers is refused; a click is spent once (the ask itself)', async (t) => {
  const no = await world(t, { answer: 'Not yet', flush: true });
  assert.deepEqual(await no.hook(), { declined: 'Not yet' });
  assert.equal(no.records().length, 0);
  assert.equal(no.claim().status, 'none');
  const prefilled = await world(t, { flush: true, modelAnswers: true });
  assert.deepEqual(await prefilled.hook(), { refused: 'tool-use-shape' });
  assert.equal(prefilled.records().length, 0);
  const one = await world(t, { flush: true });
  assert.ok((await one.hook()).recorded);
  assert.equal((await one.hook()).replay, true, 'the same click again is a replay, not a second record');
  assert.equal(one.records().length, 1);
});

test('matchesInstalledDialog is false for a tampered title, block, label, options or PRs, true for the issued ask', async (t) => {
  const w = await world(t);
  const ask = readAsk(w.askId, { home: w.home }).ask;
  assert.equal(matchesInstalledDialog(ask, w.home), true);
  const mut = (f) => { const c = structuredClone(ask); f(c); return matchesInstalledDialog(c, w.home); };
  const q = ask.dialog.question;
  assert.equal(mut((c) => { c.dialog.question = q.replace(`to ${LABEL}`, 'to Other'); }), false, 'title label');
  assert.equal(mut((c) => { c.dialog.question = q.replace(`(${REF})?`, `(${OTHER})?`); }), false, 'title ref');
  assert.equal(mut((c) => { c.dialog.question = q.replace(NAME, '20261117000009_other'); }), false, 'title name');
  assert.equal(mut((c) => { c.dialog.question = q.replace('add column c int', 'drop table t'); }), false, 'block sql');
  assert.equal(mut((c) => { c.dialog.question = q.replace(sha256Of(SQL), sha256Of('x')); }), false, 'block sha');
  assert.equal(mut((c) => { c.dialog.options[1].label = 'Yes'; }), false, 'options');
  assert.equal(mut((c) => { c.prs = [8]; }), false, 'prs');
  assert.equal(mut((c) => { c.actions[`Yes, apply ${NAME}`] = 'go migration other'; }), false, 'actions');
  assert.equal(mut((c) => { c.repo = 'acme/other'; }), false, 'repo');
});

test('live-db present --ask: prints the block as before plus ask = title + blank line + block; label mode or no origin -> ask null and askSkipped', async (t) => {
  const w = await world(t);
  mkdirSync(join(w.repo.dir, '.claude'), { recursive: true });
  const yml = (extra) => writeFileSync(join(w.repo.dir, '.claude', 'pipeline.yml'), `${ymlFor()}${extra}`);
  const args = ['present', '--op', 'migration', '--pr', '7', '--file', FILE, '--project', REF, '--summary', 'adds c'];
  const ctx = { home: w.home, cwd: w.repo.dir, env: {}, gh: { prView: () => ({ headRefOid: w.head }) }, managedPaths: [] };
  const plain = await runLiveDb(args, ctx);
  assert.equal(plain.output.ok, true, JSON.stringify(plain.output));
  assert.equal('ask' in plain.output, false, 'no --ask, no ask fields');
  yml('owner_approval: chat\n');
  const r = await runLiveDb([...args, '--ask'], ctx);
  assert.equal(r.output.block, plain.output.block);
  assert.equal(r.output.ask?.questions[0].question, `Apply migration ${NAME} (#7) to ${LABEL} (${REF})? (${r.output.ask.askId})\n\n${plain.output.block}`, JSON.stringify(r.output.askSkipped));
  assert.equal(readAsk(r.output.ask.askId, { home: w.home }).ok, true);
  assert.ok(readdirSync(asksDir(w.home)).includes(`${r.output.ask.askId}.json`));
  yml('owner_approval: label\n');
  const skipped = await runLiveDb([...args, '--ask'], ctx);
  assert.equal(skipped.output.ok, true);
  assert.equal(skipped.output.ask, null);
  assert.match(skipped.output.askSkipped, /owner_approval is not chat/);
  // a data fix in the same repository
  yml('owner_approval: chat\n');
  writeFileSync(join(w.repo.dir, 'fix.sql'), `${w.dataSql}\n`);
  const data = await runLiveDb(['present', '--op', 'data', '--project', REF, '--sql-file', 'fix.sql', '--summary', 'fix', '--ask'], ctx);
  assert.equal(data.output.ask?.questions[0].question.split('\n\n')[0], `Run data SQL ${sha256Of(w.dataSql).slice(0, 12)} on ${LABEL} (${REF})? (${data.output.ask.askId})`, JSON.stringify(data.output));
});
