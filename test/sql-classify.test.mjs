// #262 (live-database guard, Task 1): the statement summary shown in the owner's block. Display only, never a permission.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenizeSql, describeSql } from '../pipeline/hooks/lib/sql-classify.mjs';

const flags = (sql) => describeSql(sql).destructive;
const kinds = (sql) => describeSql(sql).kinds;

test('tokenizeSql: comments, strings, identifiers and dollar quotes never leak keywords; statements split on ;', () => {
  const r = tokenizeSql(`-- drop table x;\nselect 'a;b', "we;ird", $$ drop $$, $t$ ;; $t$ /* a /* nested */ ; */ from t; select 2;`);
  assert.equal(r.ok, true);
  assert.equal(r.statements.length, 2);
  assert.deepEqual(r.statements[0].filter((t) => t.t === 'word').map((t) => t.v.toLowerCase()), ['select', 'from', 't']);
  assert.equal(tokenizeSql('select 1;  \n').statements.length, 1);
  assert.equal(tokenizeSql('select E\'it\\\'s ; fine\'').statements.length, 1);
  assert.equal(tokenizeSql("select 'it''s'").statements.length, 1);
});

test('tokenizeSql: any unterminated token is unparsed', () => {
  for (const sql of ["select 'abc", 'select "abc', 'select $$abc', 'select $a$ x $b$', '/* open', "select E'abc\\'"]) {
    assert.deepEqual(tokenizeSql(sql), { ok: false, reason: 'unparsed' }, sql);
  }
});

test('describeSql: leading keyword per statement', () => {
  assert.deepEqual(kinds('select 1; insert into t values (1); create table x(a int)'), ['SELECT', 'INSERT', 'CREATE']);
});

test('describeSql: destructive flags', () => {
  // #655: a change with no WHERE of its own touches every row; failing to show it leaves the owner's go uninformed
  assert.deepEqual(flags('delete from t'), ['DELETE-NO-WHERE']);
  assert.deepEqual(flags('delete from t where id=1'), []);
  assert.deepEqual(flags('update t set a=1'), ['UPDATE-NO-WHERE']);
  assert.deepEqual(flags('update t set a=1 where true'), ['UPDATE-WHERE-TRUE']);
  assert.deepEqual(flags('update t set a=1 where 1 = 1'), ['UPDATE-WHERE-TRUE']);
  assert.deepEqual(flags('update t set a=1 where (true)'), ['UPDATE-WHERE-TRUE']);
  assert.deepEqual(flags('delete from t where true'), ['DELETE-NO-WHERE']);
  assert.deepEqual(flags('update t set a=1 where id=2'), []);
  assert.deepEqual(flags('alter table t drop column c'), ['ALTER-DROP']);
  assert.deepEqual(flags('alter table t disable row level security'), ['RLS-DISABLE']);
  assert.deepEqual(flags('create function f() returns int language sql security definer as $$ select 1 $$'), ['SECURITY-DEFINER']);
  assert.deepEqual(flags('grant select on t to anon'), ['GRANT']);
  assert.deepEqual(flags('revoke all on t from anon'), ['REVOKE']);
  assert.deepEqual(flags('do $$ begin perform 1; end $$'), ['DO-BLOCK']);
  assert.deepEqual(flags('drop table t'), ['DROP']);
  assert.deepEqual(flags('truncate t'), ['TRUNCATE']);
  assert.deepEqual(flags('select 1'), []);
  // keywords inside strings, comments and dollar bodies are not statements
  assert.deepEqual(flags("select 'drop table t', $$ delete from t $$ -- truncate t"), []);
  // several statements: each flag once, in the fixed order
  assert.deepEqual(flags('delete from a; delete from b; drop table c'), ['DROP', 'DELETE-NO-WHERE']);
});

test('describeSql: #655 only the own WHERE of a statement counts, not one in a sub-select or a later query', () => {
  // a WHERE in a sub-select must not hide a whole-table change
  assert.deepEqual(flags("update accounts set status = (select status from defaults where name = 'account')"), ['UPDATE-NO-WHERE']);
  assert.deepEqual(flags('update t set a = 1 from (select id from u where u.x = 1) s'), ['UPDATE-NO-WHERE']);
  assert.deepEqual(flags('delete from t using (select id from u where u.x = 1) s'), ['DELETE-NO-WHERE']);
  // a WHERE after the CTE group closed belongs to the outer SELECT
  assert.deepEqual(flags('with d as (delete from t returning id) select * from d where id > 5'), ['DELETE-NO-WHERE']);
  assert.deepEqual(flags('with d as (update t set a = 1 returning id) select * from d where id > 5'), ['UPDATE-NO-WHERE']);
  // a WHERE inside the CTE's own group counts
  assert.deepEqual(flags('with d as (delete from t where id = 1 returning id) select * from d'), []);
  assert.deepEqual(flags('with d as (update t set a = 1 where true returning id) select * from d'), ['UPDATE-WHERE-TRUE']);
  // an own WHERE that holds a sub-select stays unwarned
  assert.deepEqual(flags('delete from t where id in (select id from u where u.x = 1)'), []);
  assert.deepEqual(flags('with s as (select 1 as id) update t set a = 1 where id in (select id from s)'), []);
  // scope that cannot be determined (unbalanced parentheses) warns rather than stays silent
  assert.deepEqual(flags('update t set a = (select 1 where true'), ['UPDATE-NO-WHERE']);
  // WHERE as an output label (after AS) or a qualified column name (after a dot) is not a filter; nor is anything after RETURNING
  assert.deepEqual(flags('delete from t returning 1 as where'), ['DELETE-NO-WHERE']);
  assert.deepEqual(flags('update t set x = t.where'), ['UPDATE-NO-WHERE']);
  assert.deepEqual(flags('update t set a = 1 returning 1 as where'), ['UPDATE-NO-WHERE']);
  // a qualified column named returning is not the RETURNING clause
  assert.deepEqual(flags('update t set v = t.returning where id = 1'), []);
  // an empty condition is no condition
  assert.deepEqual(flags('delete from t where'), ['DELETE-NO-WHERE']);
  // matched outer parentheses around an always-true condition do not hide it
  assert.deepEqual(flags('update t set a = 1 where (1 = 1)'), ['UPDATE-WHERE-TRUE']);
  assert.deepEqual(flags('update t set a = 1 where ((true))'), ['UPDATE-WHERE-TRUE']);
  assert.deepEqual(flags('delete from t where (1 = 1)'), ['DELETE-NO-WHERE']);
  assert.deepEqual(flags('delete from t where ((true))'), ['DELETE-NO-WHERE']);
  // parentheses that do not wrap the whole condition are still an ordinary condition
  assert.deepEqual(flags('update t set a = 1 where (id = 1) or (true)'), []);
});

test('describeSql: #655 a change that runs behind EXPLAIN, COPY or a leading parenthesis is scanned like WITH', () => {
  assert.deepEqual(flags('explain analyze delete from t'), ['DELETE-NO-WHERE']);
  assert.deepEqual(flags('explain (analyze) update t set a = 1'), ['UPDATE-NO-WHERE']);
  assert.deepEqual(flags('copy (delete from t returning *) to stdout'), ['DELETE-NO-WHERE']);
  assert.deepEqual(flags('(with d as (delete from t returning *) select * from d)'), ['DELETE-NO-WHERE']);
  assert.deepEqual(flags('explain analyze delete from t where id = 1'), []);
  // a locking clause behind EXPLAIN is not a change
  assert.deepEqual(flags('explain select 1 from t for update'), []);
});

test('describeSql: #655 inside WITH every UPDATE/DELETE word warns unless the whole run proves it is something else', () => {
  // a DELETE that follows a closing parenthesis (or any single word) is still a DML start
  assert.deepEqual(flags('with x as (select 1) delete from t'), ['DELETE-NO-WHERE']);
  assert.deepEqual(flags('with x as (select 1) update t set a = 1'), ['UPDATE-NO-WHERE']);
  // locking clause: exactly FOR UPDATE / FOR NO KEY UPDATE
  assert.deepEqual(flags('with p as (select id from t where id = 1 for update) select * from p'), []);
  assert.deepEqual(flags('with p as (select id from t where id = 1 for no key update) select * from p'), []);
  // a lone KEY (or NO KEY) before UPDATE is not a locking clause: single-previous-word skip would stay silent here
  assert.deepEqual(flags('with s as (select 1) key update t set a = 1'), ['UPDATE-NO-WHERE']);
  assert.deepEqual(flags('with s as (select 1) no key update t set a = 1'), ['UPDATE-NO-WHERE']);
  // upsert action: DO UPDATE SET with ON CONFLICT before it at the same depth
  assert.deepEqual(flags('with s as (select id from u where x = 1) insert into t select id from s on conflict (id) do update set a = 1'), []);
  assert.deepEqual(flags('with s as (select 1) insert into t values (1) on conflict do update set a = 1'), []);
  assert.deepEqual(flags('with s as (insert into t values (1) on conflict do update set a = 1 returning id) select * from s'), []);
  // DO UPDATE without ON CONFLICT, or without SET, is not an upsert
  assert.deepEqual(flags('with s as (select 1) do update t set a = 1'), ['UPDATE-NO-WHERE']);
  assert.deepEqual(flags('with s as (select 1) insert into t values (1) on conflict do update t set a = 1'), ['UPDATE-NO-WHERE']);
  // ON CONFLICT in another group does not vouch for the DO UPDATE
  assert.deepEqual(flags('with s as (insert into t values (1) on conflict do nothing) select 1 do update set a = 1'), ['UPDATE-NO-WHERE']);
  // THEN DELETE / THEN UPDATE with no MERGE is a plain DML start
  assert.deepEqual(flags('with s as (select 1) then delete from t'), ['DELETE-NO-WHERE']);
  assert.deepEqual(flags('with s as (select 1) then update t set a = 1'), ['UPDATE-NO-WHERE']);
  // a data-modifying CTE next to a locking select: the DELETE still warns
  assert.deepEqual(flags('with p as (select id from t for update), d as (delete from t returning id) select * from d'), ['DELETE-NO-WHERE']);
});

test('describeSql: #655 MERGE actions are shown, plain and inside WITH', () => {
  assert.deepEqual(flags('merge into t using s on t.id = s.id when matched then update set a = 1'), ['MERGE-UPDATE']);
  assert.deepEqual(flags('merge into t using s on t.id = s.id when matched then delete'), ['MERGE-DELETE']);
  assert.deepEqual(flags('merge into t using s on t.id = s.id when matched and s.x then update set a = 1 when not matched then insert values (1)'), ['MERGE-UPDATE']);
  assert.deepEqual(flags('merge into t using s on t.id = s.id when matched and s.x then delete when matched then update set a = 2'), ['MERGE-UPDATE', 'MERGE-DELETE']);
  assert.deepEqual(flags('merge into t using s on t.id = s.id when not matched then insert values (1)'), []);
  assert.deepEqual(flags('with s as (select id from u where x = 1) merge into t using s on t.id = s.id when matched then update set a = 1'), ['MERGE-UPDATE']);
  assert.deepEqual(flags('with s as (select id from u where x = 1) merge into t using s on t.id = s.id when matched then delete'), ['MERGE-DELETE']);
  // flags keep the fixed order: after UPDATE-WHERE-TRUE, before ALTER-DROP
  assert.deepEqual(flags('merge into t using s on true when matched then delete; update t set a = 1; truncate t'), ['TRUNCATE', 'UPDATE-NO-WHERE', 'MERGE-DELETE']);
});

test('describeSql: #655 UPDATE/DELETE words outside UPDATE/DELETE/WITH/MERGE statements give no hint', () => {
  assert.deepEqual(flags('create policy p on t for update using (true)'), []);
  assert.deepEqual(flags('alter table t add constraint f foreign key (a) references u on delete cascade'), []);
  assert.deepEqual(flags('grant update, delete on t to r'), ['GRANT']);
  // CREATE TABLE ... AS runs a data-modifying CTE; only the words after its AS count, so a plain CREATE TABLE stays quiet
  assert.deepEqual(flags('create table archived_events as with moved as (delete from events returning *) select * from moved'), ['DELETE-NO-WHERE']);
  assert.deepEqual(flags('create temp table a as with m as (update t set a = 1 returning *) select * from m'), ['UPDATE-NO-WHERE']);
  assert.deepEqual(flags('create table a as with m as (delete from events where id = 1 returning *) select * from m'), []);
  assert.deepEqual(flags('create table c (id int references u on delete cascade, x int generated always as (id + 1) stored)'), []);
  assert.deepEqual(flags('create temp table c (id int) on commit delete rows'), []);
  assert.deepEqual(flags('create temp table c on commit delete rows as select id from u'), []);
  // PREPARE ... AS runs the statement at EXECUTE
  assert.deepEqual(flags('prepare p as delete from t; execute p'), ['DELETE-NO-WHERE']);
  assert.deepEqual(flags('prepare p as update t set a = 1'), ['UPDATE-NO-WHERE']);
  assert.deepEqual(flags('prepare p (int) as delete from t where id = $1'), []);
  assert.deepEqual(flags('prepare p as select * from t for update'), []);
});

test('describeSql: unterminated SQL is unparsed', () => {
  assert.deepEqual(describeSql("select 'abc"), { unparsed: true });
});
