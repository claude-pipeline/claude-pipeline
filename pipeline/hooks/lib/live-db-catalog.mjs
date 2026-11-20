// #262 (live-database guard): the catalog look-up templates. This is the ONLY SQL execute_sql may run on a live project without the owner's go.
// Why fixed text and not a "read-only" classifier: spelling cannot prove that SQL is read-only (user operators, domain casts, overloads, a role-level
// search_path with pg_catalog late would all run user code). So every template is reviewed text in this file:
//   * every relation comes from pg_catalog, every function call is pg_catalog-qualified, the only operator is OPERATOR(pg_catalog.=),
//     every literal is cast to a pg_catalog type, no comments, no trailing `;`, no WITH / EXPLAIN / `*`;
//   * matchCatalogQuery admits a query only when it is BYTE-IDENTICAL to the template rebuilt from the arguments it parsed out, so a regex that is
//     a little too loose can never widen what a template allows.
// pg_catalog can only be changed by a superuser, which the Supabase `postgres` role is not: nothing is left for search_path or a user overload to resolve.

const EQ = 'OPERATOR(pg_catalog.=)';
const NAME = (v) => `'${v}'::pg_catalog.name`;
const TRUE = 'true::pg_catalog.bool';
const FALSE = 'false::pg_catalog.bool';

// built-in, dot-free settings only: custom settings (app.settings.*) can hold secrets (Fable F4)
export const GUC_NAMES = ['server_version', 'server_version_num', 'search_path', 'statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout', 'max_connections', 'timezone', 'default_transaction_isolation', 'row_security', 'shared_preload_libraries'];

const ARG = /^[a-z_][a-z0-9_]{0,62}$/;

// "<alias> in <schema>.<relation>" joins shared by the per-table kinds
const inRelation = (a, schema, rel, alias = 'c') => `join pg_catalog.pg_namespace n on ${alias}.relnamespace ${EQ} n.oid where n.nspname ${EQ} ${NAME(schema)} and ${alias}.relname ${EQ} ${NAME(rel)}`;

export const CATALOG_TEMPLATES = {
  tables: {
    args: ['schema'],
    sql: (s) => `select c.relname, c.relkind from pg_catalog.pg_class c join pg_catalog.pg_namespace n on c.relnamespace ${EQ} n.oid where n.nspname ${EQ} ${NAME(s)} order by c.relname`,
  },
  columns: {
    args: ['schema', 'table'],
    sql: (s, t) => `select a.attnum, a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod) as data_type, a.attnotnull from pg_catalog.pg_attribute a join pg_catalog.pg_class c on a.attrelid ${EQ} c.oid ${inRelation('c', s, t)} and a.attisdropped ${EQ} ${FALSE} order by a.attnum`,
  },
  'function-def': {
    args: ['schema', 'name'],
    sql: (s, f) => `select pg_catalog.pg_get_functiondef(p.oid) as definition from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on p.pronamespace ${EQ} n.oid where n.nspname ${EQ} ${NAME(s)} and p.proname ${EQ} ${NAME(f)} order by p.oid`,
  },
  'view-def': {
    args: ['schema', 'view'],
    sql: (s, v) => `select pg_catalog.pg_get_viewdef(c.oid, ${TRUE}) as definition from pg_catalog.pg_class c ${inRelation('c', s, v)} order by c.oid`,
  },
  policies: {
    args: ['schema', 'table'],
    sql: (s, t) => `select p.polname, p.polcmd, p.polpermissive, pg_catalog.pg_get_expr(p.polqual, p.polrelid) as using_expr, pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) as check_expr from pg_catalog.pg_policy p join pg_catalog.pg_class c on p.polrelid ${EQ} c.oid ${inRelation('c', s, t)} order by p.polname`,
  },
  indexes: {
    args: ['schema', 'table'],
    sql: (s, t) => `select pg_catalog.pg_get_indexdef(i.indexrelid) as definition from pg_catalog.pg_index i join pg_catalog.pg_class c on i.indrelid ${EQ} c.oid ${inRelation('c', s, t)} order by i.indexrelid`,
  },
  triggers: {
    args: ['schema', 'table'],
    sql: (s, t) => `select r.tgname, pg_catalog.pg_get_triggerdef(r.oid) as definition from pg_catalog.pg_trigger r join pg_catalog.pg_class c on r.tgrelid ${EQ} c.oid ${inRelation('c', s, t)} and r.tgisinternal ${EQ} ${FALSE} order by r.tgname`,
  },
  'table-grants': {
    args: ['schema', 'table'],
    sql: (s, t) => `select c.relname, c.relowner, c.relacl from pg_catalog.pg_class c ${inRelation('c', s, t)} order by c.oid`,
  },
  constraints: {
    args: ['schema', 'table'],
    sql: (s, t) => `select k.conname, k.contype, pg_catalog.pg_get_constraintdef(k.oid) as definition from pg_catalog.pg_constraint k join pg_catalog.pg_class c on k.conrelid ${EQ} c.oid ${inRelation('c', s, t)} order by k.conname`,
  },
  extensions: {
    args: [],
    sql: () => 'select e.extname, e.extversion from pg_catalog.pg_extension e order by e.extname',
  },
  setting: {
    args: ['guc'],
    sql: (g) => `select pg_catalog.current_setting('${g}'::pg_catalog.text)`,
  },
};

const validArg = (kind, slot, value) => (kind === 'setting' ? GUC_NAMES.includes(value) : typeof value === 'string' && ARG.test(value));

// the SQL for one kind and its arguments; throws when the kind is unknown or an argument is outside the safe shape
export function buildCatalogQuery(kind, args = []) {
  const tpl = Object.hasOwn(CATALOG_TEMPLATES, kind) ? CATALOG_TEMPLATES[kind] : null;
  if (!tpl) throw new Error(`unknown catalog kind: ${String(kind)}`);
  if (!Array.isArray(args) || args.length !== tpl.args.length) throw new Error(`catalog ${kind} takes ${tpl.args.length} argument(s): ${tpl.args.join(' ')}`);
  tpl.args.forEach((slot, k) => {
    if (!validArg(kind, slot, args[k])) throw new Error(`catalog ${kind}: argument ${slot} must be ${kind === 'setting' ? `one of ${GUC_NAMES.join(' ')}` : '1-63 chars of a-z 0-9 _, not starting with a digit'}`);
  });
  return tpl.sql(...args);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// one regex per kind: the template with a loose capture group in each argument slot (the rebuild below is what decides)
const MATCHERS = Object.entries(CATALOG_TEMPLATES).map(([kind, tpl]) => {
  const marks = tpl.args.map((_, k) => `\u0001${k}\u0001`);
  const re = new RegExp(`^${escapeRe(tpl.sql(...marks)).replace(/\u0001\d\u0001/g, '([a-z_][a-z0-9_.]{0,62})')}$`);
  return { kind, re };
});

// { kind, args } when `sql` is byte-identical to a template rebuilt from its own arguments, else null
export function matchCatalogQuery(sql) {
  if (typeof sql !== 'string' || sql.length === 0 || sql.length > 4000) return null;
  for (const { kind, re } of MATCHERS) {
    const m = re.exec(sql);
    if (!m) continue;
    const args = m.slice(1);
    try {
      if (buildCatalogQuery(kind, args) === sql) return { kind, args };
    } catch { /* not a valid argument: not a template */ }
  }
  return null;
}
