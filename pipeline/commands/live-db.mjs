// `pipeline live-db present | catalog`: the Claude side of the live-database guard (#262; the rules are in hooks/lib/live-db-guard.mjs, the block and the recorder in hooks/lib/live-db-go.mjs).
// `present` builds the block the owner must be shown before a live Supabase change (a migration file, or a data fix); the owner's typed go is recorded only when the reply ends with exactly that block.
// `--ask` (click-to-approve, #261): also prints the choice dialog the owner may answer with a click instead of typing the go (the typed go stays as the fallback).
// `catalog` prints the fixed catalog look-up SQL that execute_sql may run on a live project without a go (hooks/lib/live-db-catalog.mjs). Both only read: neither applies anything.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { EXIT, UsageError, parseCommandArgs } from '../lib/cli.mjs';
import { git } from '../lib/git.mjs';
import { createGitHub } from '../lib/github.mjs';
import { requireConfig } from '../lib/cmd-common.mjs';
import { askFields, clickGate } from '../lib/click-ask.mjs';
import { accountHome } from '../lib/paths.mjs';
import { CATALOG_TEMPLATES, GUC_NAMES, buildCatalogQuery } from '../hooks/lib/live-db-catalog.mjs';
import { readDbRefs } from '../hooks/lib/db-refs.mjs';
import { liveDbAsk } from '../hooks/lib/owner-go-click.mjs';
import { blobAt, buildBlock, canonicalDataSql, liveLabel, migrationSqlProblem, repoOf, sha256Of, summaryProblem } from '../hooks/lib/live-db-go.mjs';

export const meta = {
  summary: 'live-database guard: build the block the owner is shown before a live Supabase change (present), print the catalog look-up SQL that needs no go (catalog)',
  usage: [
    'pipeline live-db present --op migration --pr <N> --file supabase/migrations/<f>.sql --project <ref> --summary "<one line>"',
    '  -> {ok, block, sqlSha256, name} : refuses unless the working-tree file equals HEAD:<file>, HEAD is the PR head on GitHub, the bytes are valid (UTF-8, no CR/NUL, no fence line, at most 300 lines) and the project is live.',
    '     End your reply with `block` (its last line is the ask) and wait for the owner to type `go migration <name>`; then call apply_migration with name = <name> and query = the file text, unchanged.',
    '  -> --ask (click-to-approve): also {ask: {askId, questions}}: a choice question (Yes, apply <name> | Not yet) whose text is the title and then exactly `block`, written as an ask file (one-time use, expires after 24 h); after the block, pass `ask.questions` to AskUserQuestion verbatim and the owner-go hook records a human click on Yes as the same go the typed `go migration <name>` records; otherwise ask: null and askSkipped (owner_approval is not chat | owner_go.click is off | dialog hooks not approved: the owner runs `pipeline owner-go approve-dialog-hooks` once | the ask could not be issued): the owner types the go as before',
    'pipeline live-db present --op data --project <ref> --sql-file <path> --summary "<one line>"',
    '  -> {ok, block, sqlSha256, sql} : the SQL is canonicalised (BOM and trailing whitespace stripped; CR, NUL, a fence line, a line with trailing spaces, over 60 lines or 4000 characters are refused: make it a migration). Pass `sql` verbatim as execute_sql query; the owner types `go data <sha12>`.',
    '  -> --ask on a data fix: the same dialog (Yes, run <sha12> | Not yet), when the checkout has an origin remote; otherwise ask: null and askSkipped.',
    `pipeline live-db catalog <kind> [args…]   -> {ok, sql} : the only execute_sql text a live project takes without a go; pass sql verbatim. kinds: ${Object.entries(CATALOG_TEMPLATES).map(([k, t]) => [k, ...t.args.map((a) => `<${a}>`)].join(' ')).join(' · ')}`,
    `  arguments are lower-case names (a-z 0-9 _, up to 63 characters); setting takes one of: ${GUC_NAMES.join(' ')}`,
  ].join('\n'),
};

const FAIL = (message, extra = {}) => ({ exitCode: EXIT.FAILED, output: { ok: false, error: 'refused', message, ...extra } });

export async function run(argv, ctx = {}) {
  const env = ctx.env ?? process.env;
  const home = ctx.home ?? accountHome();
  const { values, positionals } = parseCommandArgs(argv, {
    ask: { type: 'boolean' }, op: { type: 'string' }, pr: { type: 'string' }, file: { type: 'string' }, project: { type: 'string' }, summary: { type: 'string' }, 'sql-file': { type: 'string' },
  });
  const sub = positionals[0];

  if (sub === 'catalog') {
    for (const k of Object.keys(values)) throw new UsageError(`catalog takes no --${k}`);
    const [, kind, ...args] = positionals;
    try {
      return { exitCode: EXIT.OK, output: { ok: true, sql: buildCatalogQuery(kind, args) } };
    } catch (err) {
      throw new UsageError(`${err.message}\nusage: pipeline live-db catalog <kind> [args…]`);
    }
  }

  if (sub !== 'present' || positionals.length > 1) throw new UsageError('usage: pipeline live-db present … | catalog <kind> [args…]');
  const op = values.op;
  if (op !== 'migration' && op !== 'data') throw new UsageError('--op must be migration or data');
  if (!values.project) throw new UsageError('missing --project <20-character project ref>');
  if (values.summary === undefined) throw new UsageError('missing --summary "<one line>"');
  const bad = summaryProblem(values.summary);
  if (bad) throw new UsageError(bad);
  if (op === 'migration' && (values['sql-file'] !== undefined || !values.file || !values.pr)) throw new UsageError('--op migration takes --pr, --file and --project (no --sql-file)');
  if (op === 'data' && (values.file !== undefined || values.pr !== undefined || !values['sql-file'])) throw new UsageError('--op data takes --sql-file and --project (no --pr, no --file)');

  const state = readDbRefs(home);
  if (!state.ok) return FAIL(`the owner's database registry (~/.claude/pipeline-state/db-refs.json) is ${state.reason}; the owner fixes it with \`pipeline db-refs …\``);
  const label = liveLabel(values.project, state);
  if (label === null) return FAIL(`project ${values.project} is not a live project (a dev project needs no go, a malformed ref is no project)`);

  const cwd = ctx.cwd ?? process.cwd();
  let dir = null;
  try { dir = git(['rev-parse', '--show-toplevel'], { cwd }).trim() || null; } catch { /* not in a repository */ }
  const repo = dir ? repoOf(dir) : null;
  // --ask: the click dialog beside the typed go (the same gate and fields as `triage round-request --ask`)
  const asked = async (parts, unaskable) => {
    if (values.ask !== true) return {};
    const where = { ...ctx, home };
    let gate;
    try {
      gate = clickGate({ config: (await requireConfig(dir ?? cwd)).config, root: dir ?? cwd, ctx: where });
    } catch {
      gate = { ok: false, reason: 'no readable .claude/pipeline.yml in this repository, so a click cannot count' };
    }
    return askFields({ gate, parts, unaskable, ctx: where });
  };

  if (op === 'data') {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path.resolve(cwd, values['sql-file']))); } catch { return FAIL(`${values['sql-file']} cannot be read as UTF-8 text`); }
    const canon = canonicalDataSql(text);
    if (canon.problem) return FAIL(canon.problem);
    const block = buildBlock({ op, ref: values.project, label, repo, dir, sql: canon.sql, summary: values.summary });
    const sha = sha256Of(canon.sql);
    const parts = repo === null ? null : liveDbAsk({ repo, block: block.join('\n'), op, arg: sha.slice(0, 12), label, ref: values.project });
    return { exitCode: EXIT.OK, output: { ok: true, block: block.join('\n'), sqlSha256: sha, sql: canon.sql, label, ...await asked(parts, 'the block names no repository (no origin remote here), so a click cannot be bound: the owner types the go') } };
  }

  // migration
  if (!dir) return FAIL('run this inside the repository that holds the migration');
  const pr = Number(values.pr);
  if (!Number.isInteger(pr) || pr < 1) throw new UsageError('--pr must be a pull request number');
  const file = values.file.replaceAll('\\', '/');
  if (!/^supabase\/migrations\/[^/]+\.sql$/.test(file)) throw new UsageError('--file must be supabase/migrations/<name>.sql, relative to the repository root');
  let head;
  try { head = git(['rev-parse', '--verify', 'HEAD'], { cwd: dir }).trim(); } catch { return FAIL('cannot read HEAD'); }
  const committed = blobAt(dir, head, file);
  if (committed === null) return FAIL(`${file} is not committed at HEAD ${head.slice(0, 12)}`);
  let working;
  try { working = readFileSync(path.join(dir, file), 'utf8'); } catch { return FAIL(`${file} cannot be read in the working tree`); }
  if (working !== committed) return FAIL(`${file} in the working tree differs from HEAD:${file}: commit it (or restore it) so what the owner approves is what is committed`);
  const problem = migrationSqlProblem(committed);
  if (problem) return FAIL(problem);
  let prHead;
  try {
    const gh = ctx.gh ?? createGitHub({ cwd: dir, env });
    prHead = gh.prView(pr, ['headRefOid'])?.headRefOid;
  } catch (err) {
    return FAIL(`cannot read PR #${pr} from GitHub: ${String(err?.message ?? err).split('\n')[0]}`);
  }
  if (prHead !== head) return FAIL(`HEAD ${head.slice(0, 12)} is not the head of PR #${pr} on GitHub (${String(prHead).slice(0, 12)}): push, or check out the PR head, and run this again`);
  const name = path.posix.basename(file, '.sql');
  const block = buildBlock({ op, ref: values.project, label, name, file, head, repo, dir, sql: committed, summary: values.summary });
  const parts = repo === null ? null : liveDbAsk({ repo, pr, block: block.join('\n'), op, arg: name, label, ref: values.project });
  return { exitCode: EXIT.OK, output: { ok: true, block: block.join('\n'), sqlSha256: sha256Of(committed), name, label, ...await asked(parts, 'the block names no repository (no origin remote here), so a click cannot be bound: the owner types the go') } };
}
