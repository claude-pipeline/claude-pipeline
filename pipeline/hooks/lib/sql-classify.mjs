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

const ORDER = ['DROP', 'TRUNCATE', 'DELETE-NO-WHERE', 'UPDATE-NO-WHERE', 'UPDATE-WHERE-TRUE', 'ALTER-DROP', 'RLS-DISABLE', 'SECURITY-DEFINER', 'GRANT', 'REVOKE', 'DO-BLOCK', 'UNPARSED'];

// the words of one statement, upper-cased, with every other token kept as a placeholder so positions stay meaningful
const wordsOf = (stmt) => stmt.map((t) => (t.t === 'word' ? t.v.toUpperCase() : `\u0000${t.t}`));

const hasRun = (words, ...run) => {
  for (let i = 0; i + run.length <= words.length; i += 1) if (run.every((w, k) => words[i + k] === w)) return true;
  return false;
};

// The WHERE of the UPDATE/DELETE keyword at `from`: only one at the keyword's own parenthesis depth and inside its own group counts (a WHERE in a
// sub-select, or after the CTE group closed, belongs to another query). Returns 'none' (no own WHERE, or the scope cannot be determined: unbalanced
// parentheses), 'true' (the condition is always true: `true`, `1 = 1`, up to the end, the group's end or a RETURNING) or 'ok'.
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
    } else if (depth === 0 && t.t === 'word' && t.v.toUpperCase() === 'WHERE') { at = k; break; }
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
  const text = rest.join(' ');
  return text === 'TRUE' || /^(\d+) = \1$/.test(text) || text === '( TRUE )' ? 'true' : 'ok';
}

// every UPDATE/DELETE keyword of a statement that starts with it, or (WITH ...) found anywhere in it; a word after FOR / KEY (locking clause),
// DO (upsert action) or THEN (MERGE action) is part of a statement, not the start of one
const dmlStarts = (words, kw) => (words[0] === kw ? [0] : words[0] === 'WITH' ? words.flatMap((w, i) => (w === kw && !['FOR', 'KEY', 'DO', 'THEN'].includes(words[i - 1]) ? [i] : [])) : []);

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
    for (const at of dmlStarts(words, 'DELETE')) {
      const w = ownWhere(stmt, at);
      if (w !== 'ok') found.add('DELETE-NO-WHERE');
    }
    for (const at of dmlStarts(words, 'UPDATE')) {
      const w = ownWhere(stmt, at);
      if (w === 'none') found.add('UPDATE-NO-WHERE');
      else if (w === 'true') found.add('UPDATE-WHERE-TRUE');
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
