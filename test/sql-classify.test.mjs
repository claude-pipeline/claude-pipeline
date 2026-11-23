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
});

test('describeSql: unterminated SQL is unparsed', () => {
  assert.deepEqual(describeSql("select 'abc"), { unparsed: true });
});
