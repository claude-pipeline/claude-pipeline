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
  assert.deepEqual(flags('delete from t'), ['DELETE-NO-WHERE']);
  assert.deepEqual(flags('delete from t where id=1'), []);
  assert.deepEqual(flags('update t set a=1'), ['UPDATE-NO-WHERE']);
  assert.deepEqual(flags('update t set a=1 where true'), ['UPDATE-WHERE-TRUE']);
  assert.deepEqual(flags('update t set a=1 where 1 = 1'), ['UPDATE-WHERE-TRUE']);
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

test('describeSql: unterminated SQL is unparsed', () => {
  assert.deepEqual(describeSql("select 'abc"), { unparsed: true });
});
