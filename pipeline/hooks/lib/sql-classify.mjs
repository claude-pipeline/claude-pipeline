// #262 (live-database guard): a small SQL tokenizer and a statement summary.
// The summary is for the owner's block ("Statements: ... ⚠ ...") only. It is DISPLAY, never a permission: the guard never decides that SQL is safe
// from its spelling (the owner decided 11-17: a go for everything but the fixed catalog templates, live-db-catalog.mjs).
//
// tokenizeSql understands what changes where a statement ends or what a word is: line and nested block comments, '...' with '' (and E'...' with
// backslash escapes), "..." identifiers, $tag$...$tag$ bodies, `;`. Any unterminated token means the text is not understood: { ok:false, reason:'unparsed' }.

const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD_PART = /[A-Za-z0-9_$\u0080-￿]/;
const DIGIT = /[0-9]/;
// string prefixes: E'..' takes backslash escapes; the others (b, x, n, u&) behave as plain strings
const STRING_PREFIX = /^(?:[eE]|[bBxXnN]|[uU]&)$/;

export function tokenizeSql(sql) {
  if (typeof sql !== 'string') return { ok: false, reason: 'unparsed' };
  const statements = [];
  let cur = [];
  let i = 0;
  const n = sql.length;
  const fail = { ok: false, reason: 'unparsed' };
  const endStatement = () => { if (cur.length) statements.push(cur); cur = []; };
  while (i < n) {
    const c = sql[i];
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth += 1; i += 2; } else if (sql[i] === '*' && sql[i + 1] === '/') { depth -= 1; i += 2; } else i += 1;
      }
      if (depth > 0) return fail;
      continue;
    }
    if (c === ';') { endStatement(); i += 1; continue; }
    if (c === "'" || c === '"') {
      const end = readQuoted(sql, i, c, false);
      if (end < 0) return fail;
      cur.push({ t: c === "'" ? 'string' : 'ident', v: sql.slice(i, end) });
      i = end;
      continue;
    }
    if (c === '$') {
      const tag = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.exec(sql.slice(i, i + 80));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        if (close < 0) return fail;
        cur.push({ t: 'dollar', v: sql.slice(i, close + tag[0].length) });
        i = close + tag[0].length;
        continue;
      }
      cur.push({ t: 'punct', v: c });
      i += 1;
      continue;
    }
    if (WORD_START.test(c)) {
      let j = i + 1;
      while (j < n && WORD_PART.test(sql[j])) j += 1;
      let word = sql.slice(i, j);
      // u&'..' : the prefix carries the ampersand
      if ((word === 'u' || word === 'U') && sql[j] === '&' && sql[j + 1] === "'") { word += '&'; j += 1; }
      if (sql[j] === "'" && STRING_PREFIX.test(word)) {
        const end = readQuoted(sql, j, "'", /^[eE]$/.test(word));
        if (end < 0) return fail;
        cur.push({ t: 'string', v: sql.slice(i, end) });
        i = end;
        continue;
      }
      cur.push({ t: 'word', v: word });
      i = j;
      continue;
    }
    if (DIGIT.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(sql[j])) j += 1;
      cur.push({ t: 'number', v: sql.slice(i, j) });
      i = j;
      continue;
    }
    cur.push({ t: 'punct', v: c });
    i += 1;
  }
  endStatement();
  return { ok: true, statements };
}

// index just past the closing quote, or -1 when unterminated; a doubled quote is an escaped one; with `escapes` a backslash takes the next character
function readQuoted(sql, start, quote, escapes) {
  let i = start + 1;
  while (i < sql.length) {
    const c = sql[i];
    if (escapes && c === '\\') { i += 2; continue; }
    if (c === quote) {
      if (sql[i + 1] === quote) { i += 2; continue; }
      return i + 1;
    }
    i += 1;
  }
  return -1;
}

const ORDER = ['DROP', 'TRUNCATE', 'DELETE-NO-WHERE', 'UPDATE-NO-WHERE', 'UPDATE-WHERE-TRUE', 'MERGE-UPDATE', 'MERGE-DELETE', 'ALTER-DROP', 'RLS-DISABLE', 'SECURITY-DEFINER', 'GRANT', 'REVOKE', 'DO-BLOCK', 'UNPARSED'];

// the words of one statement, upper-cased, with every other token kept as a placeholder so positions stay meaningful
const wordsOf = (stmt) => stmt.map((t) => (t.t === 'word' ? t.v.toUpperCase() : `\u0000${t.t}`));

const hasRun = (words, ...run) => {
  for (let i = 0; i + run.length <= words.length; i += 1) if (run.every((w, k) => words[i + k] === w)) return true;
  return false;
};

// #655 (the "changes every row" hint). FAIL CLOSED, no precise walk: when in doubt the warning shows. The hint may over-warn; it must never stay
// silent on an UPDATE/DELETE without a WHERE of its own. In a statement that starts with WITH, EXPLAIN, COPY, PREPARE or a parenthesis, or that is a CREATE TABLE ... AS (after its AS) (they run or wrap the
// change) every UPDATE/DELETE word is a DML start unless the full run around it proves otherwise (dmlKind); a statement starting with UPDATE/DELETE
// is scanned at its first word, MERGE for its actions, and anything else (policies, foreign keys, GRANT) gives no hint.

// true when the first of `toks` (a '(') closes at the last one
const wraps = (toks) => {
  let depth = 0;
  for (let k = 0; k < toks.length; k += 1) {
    if (toks[k] === '(') depth += 1;
    else if (toks[k] === ')') { depth -= 1; if (depth === 0 && k < toks.length - 1) return false; }
  }
  return depth === 0;
};

// The WHERE of the UPDATE/DELETE keyword at `from`: only one at the keyword's own parenthesis depth and inside its own group counts (a WHERE in a
// sub-select, or after the CTE group closed, belongs to another query). Returns 'none' (no own WHERE, or the scope cannot be determined: unbalanced
// parentheses), 'true' (the condition is always true: `true`, `1 = 1`, up to the end, the group's end or a RETURNING; matched outer parentheses are ignored) or 'ok'. A WHERE after RETURNING, AS or a dot is not a filter.
function ownWhere(stmt, from) {
  let depth = 0;
  let at = -1;
  let closed = false;
  for (let k = from + 1; k < stmt.length; k += 1) {
    const t = stmt[k];
    if (t.t === 'punct' && t.v === '(') depth += 1;
    else if (t.t === 'punct' && t.v === ')') {
      depth -= 1;
      if (depth < 0) { closed = true; break; }
    } else if (depth === 0 && t.t === 'word') {
      const w = t.v.toUpperCase();
      const prev = stmt[k - 1];
      // a qualified column named returning (t.returning) is not the clause
      if (w === 'RETURNING' && !(prev.t === 'punct' && prev.v === '.')) break; // nothing after it is a filter
      // WHERE as an output label (AS where) or a qualified name (t.where) is not a filter
      if (w === 'WHERE' && !(prev.t === 'punct' && prev.v === '.') && !(prev.t === 'word' && prev.v.toUpperCase() === 'AS')) { at = k; break; }
    }
  }
  if (at < 0) return 'none';
  const rest = [];
  depth = 0;
  for (const t of stmt.slice(at + 1)) {
    if (t.t === 'punct' && t.v === '(') depth += 1;
    else if (t.t === 'punct' && t.v === ')') { depth -= 1; if (depth < 0) { closed = true; break; } }
    if (depth === 0 && t.t === 'word' && t.v.toUpperCase() === 'RETURNING') break;
    rest.push(t.v.toUpperCase());
  }
  // a depth left open at the end of the statement (outside a closed group) means the parentheses do not balance: scope unknown
  if (depth > 0 && !closed) return 'none';
  // matched outer parentheses around the whole condition do not change it: strip them (no evaluation)
  while (rest.length > 1 && rest[0] === '(' && rest[rest.length - 1] === ')' && wraps(rest)) { rest.shift(); rest.pop(); }
  if (!rest.length) return 'none';
  const text = rest.join(' ');
  return text === 'TRUE' || /^(\d+) = \1$/.test(text) ? 'true' : 'ok';
}

// What the UPDATE/DELETE word at `i` of a WITH or MERGE statement is: 'skip' (a locking clause or an upsert action: proven by the whole run, not
// one previous word), 'merge' (a MERGE action) or 'dml' (anything else, including everything unproven).
function dmlKind(words, depths, i) {
  const merged = words.slice(0, i).some((w, j) => w === 'MERGE' && depths[j] <= depths[i]);
  if (words[i - 1] === 'THEN' && merged) return 'merge';
  if (words[i] === 'UPDATE') {
    if (words[i - 1] === 'FOR' || (words[i - 3] === 'FOR' && words[i - 2] === 'NO' && words[i - 1] === 'KEY')) return 'skip';
    const upsert = words[i - 1] === 'DO' && words[i + 1] === 'SET' && words.slice(0, i).some((w, j) => w === 'ON' && words[j + 1] === 'CONFLICT' && depths[j] === depths[i]);
    if (upsert) return 'skip';
  }
  return 'dml';
}

export function describeSql(sql) {
  const tok = tokenizeSql(sql);
  if (!tok.ok) return { unparsed: true };
  const kinds = [];
  const found = new Set();
  for (const stmt of tok.statements) {
    const words = wordsOf(stmt);
    const first = words[0] ?? '';
    kinds.push(/^[A-Z_]/.test(first) ? first : '?');
    const has = (w) => words.includes(w);
    if (first === 'DROP') found.add('DROP');
    if (first === 'TRUNCATE') found.add('TRUNCATE');
    const starts = []; // [index, 'UPDATE' | 'DELETE'] of every UPDATE/DELETE that begins a change
    if (first === 'UPDATE' || first === 'DELETE') starts.push([0, first]);
    let depth = 0;
    const depths = stmt.map((t) => { if (t.t === 'punct' && t.v === ')') depth -= 1; const d = depth; if (t.t === 'punct' && t.v === '(') depth += 1; return d; });
    // CREATE [..] TABLE ... AS runs what follows its AS (a data-modifying CTE): scan only the words after that AS; PREPARE ... AS runs it at EXECUTE
    const tableAt = words.indexOf('TABLE');
    const createAs = first === 'CREATE' && tableAt > 0 && tableAt <= 3 ? words.findIndex((w, i) => w === 'AS' && depths[i] === 0) : -1;
    const scanned = first === 'WITH' || first === 'EXPLAIN' || first === 'COPY' || first === 'PREPARE' || createAs >= 0 || (stmt[0]?.t === 'punct' && stmt[0].v === '(');
    if (scanned || first === 'MERGE') {
      words.forEach((w, i) => {
        if (w !== 'UPDATE' && w !== 'DELETE') return;
        if (i < createAs) return;
        const kind = dmlKind(words, depths, i);
        if (kind === 'merge') found.add(`MERGE-${w}`);
        else if (kind === 'dml' && scanned) starts.push([i, w]);
      });
    }
    for (const [at, kw] of starts) {
      const w = ownWhere(stmt, at);
      if (kw === 'DELETE' && w !== 'ok') found.add('DELETE-NO-WHERE');
      if (kw === 'UPDATE' && w === 'none') found.add('UPDATE-NO-WHERE');
      if (kw === 'UPDATE' && w === 'true') found.add('UPDATE-WHERE-TRUE');
    }
    if (first === 'ALTER' && has('DROP')) found.add('ALTER-DROP');
    if (first === 'ALTER' && hasRun(words, 'DISABLE', 'ROW', 'LEVEL', 'SECURITY')) found.add('RLS-DISABLE');
    if (hasRun(words, 'SECURITY', 'DEFINER')) found.add('SECURITY-DEFINER');
    if (first === 'GRANT') found.add('GRANT');
    if (first === 'REVOKE') found.add('REVOKE');
    if (first === 'DO') found.add('DO-BLOCK');
  }
  return { kinds, destructive: ORDER.filter((f) => found.has(f)) };
}
