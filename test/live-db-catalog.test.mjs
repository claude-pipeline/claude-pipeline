// #262 (live-database guard, Task 1): the catalog look-up templates, the ONLY SQL that may run on a live project without a go.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG_TEMPLATES, GUC_NAMES, buildCatalogQuery, matchCatalogQuery } from '../pipeline/hooks/lib/live-db-catalog.mjs';

const SAMPLE = { schema: 'public', table: 'my_table', name: 'my_fn', view: 'v_x', guc: 'search_path' };
const argsFor = (kind) => CATALOG_TEMPLATES[kind].args.map((a) => SAMPLE[a]);

test('every kind round-trips through build and match', () => {
  for (const kind of Object.keys(CATALOG_TEMPLATES)) {
    const args = argsFor(kind);
    const sql = buildCatalogQuery(kind, args);
    assert.deepEqual(matchCatalogQuery(sql), { kind, args }, kind);
  }
  assert.deepEqual(Object.keys(CATALOG_TEMPLATES).sort(), ['columns', 'constraints', 'extensions', 'function-def', 'indexes', 'policies', 'setting', 'table-grants', 'tables', 'triggers', 'view-def']);
});

test('every template is closed: pg_catalog-qualified calls, one operator form, pg_catalog casts, nothing else', () => {
  for (const kind of Object.keys(CATALOG_TEMPLATES)) {
    const sql = buildCatalogQuery(kind, argsFor(kind));
    assert.ok(!/;|--|\/\*|\*|\n|\$/.test(sql), `${kind}: no ; comment * newline $`);
    for (const m of sql.matchAll(/([A-Za-z_][A-Za-z0-9_.]*)\s*\(/g)) {
      assert.ok(m[1] === 'OPERATOR' || m[1].startsWith('pg_catalog.'), `${kind}: unqualified call ${m[1]}`);
    }
    for (const m of sql.matchAll(/::\s*([A-Za-z_"][A-Za-z0-9_."]*)/g)) assert.ok(m[1].startsWith('pg_catalog.'), `${kind}: cast to ${m[1]}`);
    const rest = sql.replaceAll('OPERATOR(pg_catalog.=)', '').replaceAll('::', '');
    assert.ok(!/[=<>!+\-/%^|&~@#]/.test(rest), `${kind}: stray operator in ${rest}`);
    // every quoted literal is cast
    assert.ok(!sql.replace(/'[^']*'::pg_catalog\.[a-z]+/g, '').includes("'"), `${kind}: uncast literal`);
    assert.ok(!/\b(with|explain)\b/i.test(sql), kind);
    // relations only from pg_catalog
    for (const m of sql.matchAll(/\b(?:from|join)\s+([A-Za-z_.]+)/gi)) assert.ok(m[1].startsWith('pg_catalog.'), `${kind}: relation ${m[1]}`);
  }
});

test('the plan examples build the expected text', () => {
  assert.equal(buildCatalogQuery('setting', ['server_version']), "select pg_catalog.current_setting('server_version'::pg_catalog.text)");
  assert.ok(buildCatalogQuery('function-def', ['public', 'f']).includes("'f'::pg_catalog.name"));
});

test('no match: a template changed, extended or dressed up', () => {
  for (const kind of Object.keys(CATALOG_TEMPLATES)) {
    const sql = buildCatalogQuery(kind, argsFor(kind));
    for (const bad of [sql + ' ', sql + ';', sql + '\n', ' ' + sql, sql.slice(0, -1), sql + 'x', sql.replace('select', 'select  '), `explain ${sql}`, `${sql}; drop table t`, sql.toUpperCase(), sql.replace('pg_catalog.', '')]) {
      assert.equal(matchCatalogQuery(bad), null, `${kind}: ${bad.slice(0, 60)}`);
    }
  }
});

test('no match: arguments outside the safe shape', () => {
  for (const a of ["a'b", 'a$b', 'A', 'x'.repeat(64), 'a b', '1a', 'a;b', 'a.b', '']) {
    assert.throws(() => buildCatalogQuery('tables', [a]), /argument/, a);
  }
  const ok = buildCatalogQuery('tables', ['public']);
  assert.equal(matchCatalogQuery(ok.replace("'public'", "'pub'lic'")), null);
  assert.equal(matchCatalogQuery(ok.replace("'public'", "'pub$lic'")), null);
  assert.equal(matchCatalogQuery(ok.replace("'public'", "'Public'")), null);
  assert.equal(matchCatalogQuery(ok.replace("'public'", `'${'x'.repeat(64)}'`)), null);
  assert.equal(matchCatalogQuery(ok.replace("'public'", "'a.b'")), null);
});

test('setting only takes the fixed list of built-in GUCs', () => {
  assert.ok(GUC_NAMES.includes('server_version') && GUC_NAMES.includes('search_path'));
  for (const g of GUC_NAMES) assert.ok(!g.includes('.'), g);
  assert.throws(() => buildCatalogQuery('setting', ['app.settings.service_role_key']), /argument/);
  assert.throws(() => buildCatalogQuery('setting', ['work_mem']), /argument/);
  assert.equal(matchCatalogQuery("select pg_catalog.current_setting('app.settings.service_role_key'::pg_catalog.text)"), null);
  assert.equal(matchCatalogQuery("select pg_catalog.current_setting('work_mem'::pg_catalog.text)"), null);
});

test('arbitrary SQL is not a template', () => {
  for (const sql of ['select 1 === 2 from pg_catalog.pg_class', 'select 1::public.d', "select public.lower('x')", 'select relname from pg_catalog.pg_class', 'select * from public.t', '', ' ', 'select 1', 'delete from t']) {
    assert.equal(matchCatalogQuery(sql), null, sql);
  }
  assert.equal(matchCatalogQuery(undefined), null);
  assert.equal(matchCatalogQuery(null), null);
  assert.equal(matchCatalogQuery({}), null);
});
