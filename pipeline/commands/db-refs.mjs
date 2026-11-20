// `pipeline db-refs show | set | remove | server`: the owner's registry of Supabase projects for the live-database guard (#262; the library is
// hooks/lib/db-refs.mjs, the file `~/.claude/pipeline-state/db-refs.json`). `show` is read-only and runs anywhere. Everything that changes the file is the owner's:
// refused inside Claude Code with the same check `pipeline update` uses (lib/owner-only.mjs), and the guard also refuses the command line to an agent.
import { EXIT, UsageError, parseCommandArgs } from '../lib/cli.mjs';
import { accountHome } from '../lib/paths.mjs';
import { insideClaudeCode } from '../lib/owner-only.mjs';
import { BUILTIN_SERVERS, REF_RE, dbRefsFile, readDbRefs, writeDbRefs } from '../hooks/lib/db-refs.mjs';

export const meta = {
  summary: 'the owner\'s registry of Supabase projects for the live-database guard: show it; set / remove a project, add / remove a trusted MCP server (owner only, own terminal)',
  usage: [
    'pipeline db-refs show   -> {ok, file, refs: [{ref, name, repo, kind}], servers, missing?} : READ-ONLY, runs anywhere; exit 0, or 1 when the file is unreadable or invalid (every Supabase write is then refused)',
    'pipeline db-refs set --ref <20 lowercase letters/digits> --name "<label>" --repo <owner/name> [--dev]   (a duplicate ref replaces its entry)',
    'pipeline db-refs remove --ref <ref>',
    'pipeline db-refs server add <segment> | server remove <segment>   (an MCP server name the owner trusts for Supabase: the part between mcp__ and the tool name)',
    '  Every hosted project is LIVE unless declared --dev here; a project that is not listed is live too, with the name `unregistered project <ref>`.',
    '  Only a server on the built-in list (plugin_supabase_supabase, supabase) or one added with `server add` may carry a go-bound write; a --dev declaration exempts a call only on a server the owner added.',
    '  Owner only: the changing subcommands are refused inside Claude Code (exit 2 `refused`); run them in your own terminal (`node ~/.claude/pipeline/bin/pipeline.mjs db-refs set …`).',
  ].join('\n'),
};

const SEGMENT = /^[A-Za-z0-9_.-]{1,80}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export async function run(argv, ctx = {}) {
  const env = ctx.env ?? process.env;
  const home = ctx.home ?? accountHome();
  const { values, positionals } = parseCommandArgs(argv, { ref: { type: 'string' }, name: { type: 'string' }, repo: { type: 'string' }, dev: { type: 'boolean' } });
  const sub = positionals[0];
  const only = (extra) => {
    for (const k of ['ref', 'name', 'repo', 'dev']) if (values[k] !== undefined && !extra.includes(k)) throw new UsageError(`${sub} does not take --${k}`);
  };

  if (sub === 'show') {
    if (positionals.length > 1) throw new UsageError('usage: pipeline db-refs show');
    only([]);
    const r = readDbRefs(home);
    const file = dbRefsFile(home);
    return r.ok
      ? { exitCode: EXIT.OK, output: { ok: true, file, refs: r.refs, servers: r.servers, builtinServers: BUILTIN_SERVERS, ...(r.missing ? { missing: true } : {}) } }
      : { exitCode: EXIT.FAILED, output: { ok: false, file, error: `db-refs-${r.reason}`, message: `${file} is ${r.reason}: every Supabase write is refused until the owner fixes it (\`pipeline db-refs set …\` rewrites it from a valid state; delete the file to start again)` } };
  }

  let change;
  if (sub === 'set') {
    if (positionals.length > 1) throw new UsageError('usage: pipeline db-refs set --ref <ref> --name "<label>" --repo <owner/name> [--dev]');
    only(['ref', 'name', 'repo', 'dev']);
    if (!values.ref || !REF_RE.test(values.ref)) throw new UsageError('--ref must be the 20 lowercase letters and digits of the project reference');
    if (!values.name || values.name.length > 120 || /[\r\n\u0000]/.test(values.name)) throw new UsageError('--name must be a one-line label (at most 120 characters)');
    if (!values.repo || !REPO.test(values.repo)) throw new UsageError('--repo must be <owner>/<name>');
    const entry = { ref: values.ref, name: values.name, repo: values.repo, kind: values.dev ? 'dev' : 'live' };
    change = (s) => ({ ...s, refs: [...s.refs.filter((e) => e.ref !== entry.ref), entry] });
  } else if (sub === 'remove') {
    if (positionals.length > 1) throw new UsageError('usage: pipeline db-refs remove --ref <ref>');
    only(['ref']);
    if (!values.ref || !REF_RE.test(values.ref)) throw new UsageError('--ref must be the 20 lowercase letters and digits of the project reference');
    change = (s) => ({ ...s, refs: s.refs.filter((e) => e.ref !== values.ref) });
  } else if (sub === 'server') {
    only([]);
    const [, action, segment, ...extra] = positionals;
    if ((action !== 'add' && action !== 'remove') || !segment || extra.length) throw new UsageError('usage: pipeline db-refs server add|remove <segment>');
    if (!SEGMENT.test(segment)) throw new UsageError('the server segment must be 1-80 letters, digits, . _ - (the part between mcp__ and the tool name)');
    change = (s) => ({ ...s, servers: action === 'add' ? [...new Set([...s.servers, segment])] : s.servers.filter((x) => x !== segment) });
  } else {
    throw new UsageError('usage: pipeline db-refs show | set | remove | server');
  }

  const inside = insideClaudeCode(env, ctx);
  if (inside) {
    const message = `pipeline db-refs ${sub} refuses to run inside a Claude Code session (${inside}): the registry decides which databases count as live. Run it in your own terminal (\`node ~/.claude/pipeline/bin/pipeline.mjs db-refs ${sub} …\`); \`db-refs show\` is allowed anywhere.`;
    return { exitCode: EXIT.USAGE, output: { ok: false, error: 'refused', message } };
  }
  const current = readDbRefs(home);
  // an invalid file is replaced from an empty state (the owner is the one fixing it); an unreadable one (a folder, a permission) is not touched
  if (!current.ok && current.reason === 'unreadable') {
    return { exitCode: EXIT.FAILED, output: { ok: false, error: 'db-refs-unreadable', message: `${dbRefsFile(home)} cannot be read; fix its permissions or remove it, then run this again` } };
  }
  const next = change(current.ok ? current : { refs: [], servers: [] });
  try {
    const file = writeDbRefs(home, next);
    return { exitCode: EXIT.OK, output: { ok: true, file, refs: next.refs, servers: next.servers } };
  } catch (err) {
    return { exitCode: EXIT.FAILED, output: { ok: false, error: 'db-refs-unwritable', message: `cannot write ${dbRefsFile(home)}: ${err?.code ?? err?.message}` } };
  }
}
