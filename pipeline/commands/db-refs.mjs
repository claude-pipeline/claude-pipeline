// `pipeline db-refs show | set | remove | server | auto-migrations`: the owner's registry of Supabase projects for the live-database guard (#262; the library is
// hooks/lib/db-refs.mjs, the file `~/.claude/pipeline-state/db-refs.json`). `show` is read-only and runs anywhere. Everything that changes the file is the owner's:
// refused inside Claude Code with the same check `pipeline update` uses (lib/owner-only.mjs), and the guard also refuses the command line to an agent.
import { EXIT, UsageError, parseCommandArgs } from '../lib/cli.mjs';
import { dirname, join } from 'node:path';
import { accountHome } from '../lib/paths.mjs';
import { LockLostError, LockTimeoutError, readMachineId, withLock } from '../lib/locks.mjs';
import { insideClaudeCode } from '../lib/owner-only.mjs';
import { BUILTIN_SERVERS, DEPLOY_ENV_MAX, REF_RE, dbRefsFile, readDbRefs, validDeployBot, validDeployEnv, writeDbRefs } from '../hooks/lib/db-refs.mjs';
import { importGoHistory } from '../hooks/lib/live-db-auto.mjs';

// the entries as `show` and the owner's commands print them: the switch's time only while it is on, the after-deploy registration only while it is set (an entry with cutoff-era keys shows `deployLegacy: true` and no registration: run `after-deploy on` again)
const shown = (refs) => refs.map((e) => ({ ref: e.ref, name: e.name, repo: e.repo, kind: e.kind, autoMigrations: e.autoMigrations === true, ...(e.autoMigrations === true ? { autoSince: e.autoSince } : {}), ...(e.autoMigrations === true && e.deployEnv ? { deployEnv: e.deployEnv, deployBot: e.deployBot } : {}), ...(e.autoMigrations === true && e.deployLegacy === true ? { deployLegacy: true } : {}) }));
// a write response prints what was written: every write drops the cutoff-era keys, so the flag read from the old file is not shown again
const wrote = (refs) => shown(refs.map(({ deployLegacy, ...e }) => e));

export const meta = {
  summary: 'the owner\'s registry of Supabase projects for the live-database guard: show it; set / remove a project, add / remove a trusted MCP server, switch auto-apply of merged migrations on / off for a project, register / unregister the GitHub deployment after which a marked migration applies (owner only, own terminal)',
  usage: [
    'pipeline db-refs show   -> {ok, file, refs: [{ref, name, repo, kind, autoMigrations}], servers, missing?} : READ-ONLY, runs anywhere; exit 0, or 1 when the file is unreadable or invalid (every Supabase write is then refused)',
    'pipeline db-refs set --ref <20 lowercase letters/digits> --name "<label>" --repo <owner/name> [--dev]   (a duplicate ref replaces its entry)',
    'pipeline db-refs remove --ref <ref>',
    'pipeline db-refs auto-migrations on|off --ref <ref> [--accept-unmatched]   (owner only; default off) ON: a migration file a merged PR added to the default branch of the project\'s registered repo is applied to that live project with no further go (docs/cli.md "Live database guard"). It first imports this machine\'s earlier go applies of the project into the attempt history; an apply whose go record is gone is listed and refused until --accept-unmatched. Refused for an unknown or dev ref, an entry without --repo, or a repo another enabled ref already has. OFF clears the switch and keeps the history. A repo or --dev change by `set` clears it. Run ON again after any rollback of the pipeline install.',
    'pipeline db-refs after-deploy on --ref <ref> --env "<environment>" --bot <app>   (owner only; needs auto-migrations on) Registers which GitHub deployment means "production" for the project: <environment> is the deployment environment name (exact, case-sensitive; 1-100 characters), <app> the GitHub App that makes those deployments (its login without [bot], e.g. vercel; never github-actions). A migration file marked `-- pipeline: apply-after-deploy` that a merged PR added after auto-apply was switched on is then applied with no go once the merge commit is the newest commit of the default branch and GitHub shows that the newest <environment> deployment of the repo, and GitHub\'s latest completed one, are both that commit, made by <app>[bot], and succeeded. This is checked when Claude asks to apply, not frozen now: a marked file whose merge is live already, or goes live later, applies without a click; to keep the click for everything merged so far, run `auto-migrations on` again FIRST (it resets the auto-apply start time, taken from this machine\'s clock: a merge within that clock\'s error of the reset can still pass, and a clock running ahead refuses later merges), then run this; the other order leaves a gap in which a call can apply a merge that is already live. If any later commit lands on the default branch first, that file takes the owner\'s click. Without this registration a marked file keeps the owner\'s click. Running it again replaces the environment and bot. Runs offline (no GitHub call). Residuals: docs/cli.md "Live database guard".',
    'pipeline db-refs after-deploy off --ref <ref>   (owner only) Removes the registration: marked files take the owner\'s click again. Run it while production is rolled back or not auto-promoted. auto-migrations off, and a repo or --dev change by set, remove it too.',
    'pipeline db-refs server add <segment> | server remove <segment>   (an MCP server name the owner trusts for Supabase: the part between mcp__ and the tool name)',
    '  Every hosted project is LIVE unless declared --dev here; a project that is not listed is live too, with the name `unregistered project <ref>`.',
    '  Only a server on the built-in list (plugin_supabase_supabase, supabase) or one added with `server add` may carry a go-bound write; a --dev declaration exempts a call only on a server the owner added.',
    '  Owner only: the changing subcommands are refused inside Claude Code (exit 2 `refused`); run them in your own terminal (`node ~/.claude/pipeline/bin/pipeline.mjs db-refs set …`).',
  ].join('\n'),
};

const LOCK_NAME = 'db-refs';
const LOCK_WAIT_MS = 15_000;
const SEGMENT = /^[A-Za-z0-9_.-]{1,80}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const sameRepo = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const DEPLOY_NOTE = (repo, env, bot, ref) =>`after-deploy registered (environment "${env}", bot ${bot}[bot]), no start time recorded: a marked migration that a merged PR added after auto-apply was switched on is applied, when Claude asks, once its merge commit is the newest commit of ${repo}'s default branch and the newest "${env}" deployment (by ANY creator) and GitHub's latest completed one are both that commit, made by ${bot}[bot], and succeeded. A marked migration already live, or still deploying, is applied too: run \`pipeline db-refs auto-migrations on --ref ${ref}\` again now to keep the click for everything merged so far (it resets the start time from this machine's clock: a merge within that clock's error of the reset can still pass; until it runs, a call can apply a merge that is already live, so next time run it BEFORE after-deploy on). If any later commit lands on the default branch before the apply, that migration takes your click. Not seen: a rollback or promote done outside GitHub (the host's dashboard makes no GitHub deployment or status; Vercel's instant rollback is one), and a SUCCESS status only means the host built and assigned the deploy, not that it serves now. Run \`pipeline db-refs after-deploy off --ref ${ref}\` while production is rolled back or auto-promotion is off. Your own GitHub token can also mark a newer deployment inactive or delete it. Details: docs/cli.md "Live database guard".`;
const TRUST_NOTE = (repo) => `auto-apply trusts every PR merged into ${repo}'s default branch on github.com: migrations there must need your merge (a hard stop on supabase/migrations/**). Run this command again after any rollback of the pipeline install.`;

export async function run(argv, ctx = {}) {
  const env = ctx.env ?? process.env;
  const home = ctx.home ?? accountHome();
  const { values, positionals } = parseCommandArgs(argv, { ref: { type: 'string' }, name: { type: 'string' }, repo: { type: 'string' }, env: { type: 'string' }, bot: { type: 'string' }, dev: { type: 'boolean' }, 'accept-unmatched': { type: 'boolean' } });
  const sub = positionals[0];
  const only = (extra) => {
    for (const k of ['ref', 'name', 'repo', 'env', 'bot', 'dev', 'accept-unmatched']) if (values[k] !== undefined && !extra.includes(k)) throw new UsageError(`${sub} does not take --${k}`);
  };

  if (sub === 'show') {
    if (positionals.length > 1) throw new UsageError('usage: pipeline db-refs show');
    only([]);
    const r = readDbRefs(home);
    const file = dbRefsFile(home);
    return r.ok
      ? { exitCode: EXIT.OK, output: { ok: true, file, refs: shown(r.refs), servers: r.servers, builtinServers: BUILTIN_SERVERS, ...(r.missing ? { missing: true } : {}) } }
      : { exitCode: EXIT.FAILED, output: { ok: false, file, error: `db-refs-${r.reason}`, message: `${file} is ${r.reason}: every Supabase write is refused until the owner fixes it (\`pipeline db-refs set …\` rewrites it from a valid state; delete the file to start again)` } };
  }

  let change;
  let autoAction = null;
  let deployAction = null;
  let deploy = null;
  if (sub === 'set') {
    if (positionals.length > 1) throw new UsageError('usage: pipeline db-refs set --ref <ref> --name "<label>" --repo <owner/name> [--dev]');
    only(['ref', 'name', 'repo', 'dev']);
    if (!values.ref || !REF_RE.test(values.ref)) throw new UsageError('--ref must be the 20 lowercase letters and digits of the project reference');
    if (!values.name || values.name.length > 120 || /[\r\n\u0000]/.test(values.name)) throw new UsageError('--name must be a one-line label (at most 120 characters)');
    if (!values.repo || !REPO.test(values.repo)) throw new UsageError('--repo must be <owner>/<name>');
    const entry = { ref: values.ref, name: values.name, repo: values.repo, kind: values.dev ? 'dev' : 'live' };
    // (the auto-apply switch survives a label-only edit; a new repo or --dev does not carry the trust)
    change = (s) => {
      const old = s.refs.find((e) => e.ref === entry.ref);
      const keep = old?.autoMigrations === true && entry.kind === 'live' && sameRepo(old.repo, entry.repo);
      const kept = keep ? { ...entry, autoMigrations: true, autoSince: old.autoSince, ...(old.deployEnv ? { deployEnv: old.deployEnv, deployBot: old.deployBot } : {}) } : entry;
      return { ...s, refs: [...s.refs.filter((e) => e.ref !== entry.ref), kept] };
    };
  } else if (sub === 'remove') {
    if (positionals.length > 1) throw new UsageError('usage: pipeline db-refs remove --ref <ref>');
    only(['ref']);
    if (!values.ref || !REF_RE.test(values.ref)) throw new UsageError('--ref must be the 20 lowercase letters and digits of the project reference');
    change = (s) => ({ ...s, refs: s.refs.filter((e) => e.ref !== values.ref) });
  } else if (sub === 'auto-migrations') {
    const [, action, ...extra] = positionals;
    if ((action !== 'on' && action !== 'off') || extra.length) throw new UsageError('usage: pipeline db-refs auto-migrations on|off --ref <ref> [--accept-unmatched]');
    only(['ref', 'accept-unmatched']);
    if (action === 'off' && values['accept-unmatched'] !== undefined) throw new UsageError('off does not take --accept-unmatched');
    if (!values.ref || !REF_RE.test(values.ref)) throw new UsageError('--ref must be the 20 lowercase letters and digits of the project reference');
    autoAction = action;
  } else if (sub === 'after-deploy') {
    const [, action, ...extra] = positionals;
    if ((action !== 'on' && action !== 'off') || extra.length) throw new UsageError('usage: pipeline db-refs after-deploy on --ref <ref> --env "<environment>" --bot <app> | after-deploy off --ref <ref>');
    only(action === 'on' ? ['ref', 'env', 'bot'] : ['ref']);
    if (!values.ref || !REF_RE.test(values.ref)) throw new UsageError('--ref must be the 20 lowercase letters and digits of the project reference');
    if (action === 'on') {
      if (!validDeployEnv(values.env)) throw new UsageError(`--env must be the GitHub deployment environment name: 1-${DEPLOY_ENV_MAX} characters, no control characters`);
      const bot = typeof values.bot === 'string' ? values.bot.replace(/\[bot\]$/i, '').toLowerCase() : null;
      if (bot === 'github-actions') throw new UsageError('--bot github-actions is refused: an agent can make a workflow run create a deployment for any commit. Name a GitHub App the agent cannot drive (Vercel\'s is vercel)');
      if (!validDeployBot(bot)) throw new UsageError('--bot must be the login of the GitHub App that makes the deployments, without [bot] (lower-case letters, digits and hyphens, at most 39 characters), e.g. vercel');
      deploy = { env: values.env, bot };
    }
    deployAction = action;
  } else if (sub === 'server') {
    only([]);
    const [, action, segment, ...extra] = positionals;
    if ((action !== 'add' && action !== 'remove') || !segment || extra.length) throw new UsageError('usage: pipeline db-refs server add|remove <segment>');
    if (!SEGMENT.test(segment)) throw new UsageError('the server segment must be 1-80 letters, digits, . _ - (the part between mcp__ and the tool name)');
    change = (s) => ({ ...s, servers: action === 'add' ? [...new Set([...s.servers, segment])] : s.servers.filter((x) => x !== segment) });
  } else {
    throw new UsageError('usage: pipeline db-refs show | set | remove | server | auto-migrations | after-deploy');
  }

  const inside = insideClaudeCode(env, ctx);
  if (inside) {
    const message = `pipeline db-refs ${sub} refuses to run inside a Claude Code session (${inside}): the registry decides which databases count as live. Run it in your own terminal (\`node ~/.claude/pipeline/bin/pipeline.mjs db-refs ${sub} …\`); \`db-refs show\` is allowed anywhere.`;
    return { exitCode: EXIT.USAGE, output: { ok: false, error: 'refused', message } };
  }
  // every writer holds the registry lock from the read to the write, so two owner terminals never both pass their comparison and then replace each other's result (the registry's own folder, like the model floor's lock: processes with different $HOME share nothing else)
  const stateDir = dirname(dbRefsFile(home));
  const busy = (message) => ({ exitCode: EXIT.FAILED, output: { ok: false, error: 'db-refs-busy', message } });
  try {
    return await withLock(LOCK_NAME, () => apply(), { dir: join(stateDir, 'locks'), waitMs: ctx.lockWaitMs ?? LOCK_WAIT_MS, machineId: readMachineId({ stateDir }) });
  } catch (err) {
    if (err instanceof LockTimeoutError) return busy(`another db-refs command is running (${err.message.replace(/ To clear it by hand.*$/, '')}); nothing was written. Run this again once it has finished`);
    if (err instanceof LockLostError) return busy(`the registry lock was taken over while this command ran, so its result may not stand; run \`pipeline db-refs show\` to see the file, then run this again`);
    throw err;
  }

  async function apply() {
    const current = readDbRefs(home);
    // an invalid file is replaced from an empty state (the owner is the one fixing it); an unreadable one (a folder, a permission) is not touched
    if (!current.ok && current.reason === 'unreadable') {
      return { exitCode: EXIT.FAILED, output: { ok: false, error: 'db-refs-unreadable', message: `${dbRefsFile(home)} cannot be read; fix its permissions or remove it, then run this again` } };
    }
    if (deployAction !== null) return afterDeploy({ action: deployAction, ref: values.ref, deploy, current, home });
    if (autoAction !== null) return autoMigrations({ action: autoAction, ref: values.ref, accept: values['accept-unmatched'] === true, current, home, ctx });
    const next = change(current.ok ? current : { refs: [], servers: [] });
    try {
      const file = writeDbRefs(home, next);
      return { exitCode: EXIT.OK, output: { ok: true, file, refs: wrote(next.refs), servers: next.servers } };
    } catch (err) {
      return { exitCode: EXIT.FAILED, output: { ok: false, error: 'db-refs-unwritable', message: `cannot write ${dbRefsFile(home)}: ${err?.code ?? err?.message}` } };
    }
  }
}

// `auto-migrations on|off` (the owner's terminal; the caller has checked insideClaudeCode and that the registry is readable). On: the four refusals, then the import of this project's earlier go applies,
// then the switch with its time. Nothing is written until every check has passed.
function autoMigrations({ action, ref, accept, current, home, ctx }) {
  const state = current.ok ? current : { refs: [], servers: [] };
  const entry = state.refs.find((e) => e.ref === ref);
  if (!entry) throw new UsageError(`${ref} is not in the registry: add it with \`pipeline db-refs set --ref ${ref} --name "<label>" --repo <owner/name>\` first`);
  const write = (refs, extra = {}) => writeSnapshot({ home, current, state, refs, extra });
  // off also clears the after-deploy registration: it is valid only with the switch on
  if (action === 'off') return write(state.refs.map((e) => (e.ref === ref ? { ...e, autoMigrations: false, autoSince: null, deployEnv: null, deployBot: null } : e)));
  if (entry.kind !== 'live') throw new UsageError(`${ref} is declared dev: auto-apply covers live projects only`);
  if (!entry.repo) throw new UsageError(`${ref} has no repo: set it with \`pipeline db-refs set --ref ${ref} --name "${entry.name}" --repo <owner/name>\` first (auto-apply needs to know which repository's merges to trust)`);
  const other = state.refs.find((e) => e.ref !== ref && e.autoMigrations === true && sameRepo(e.repo, entry.repo));
  if (other) throw new UsageError(`${other.ref} (${other.name}) already has auto-apply on for ${other.repo}: one project per repository; turn that one off first`);
  const now = ctx.now ?? Date.now;
  const imported = importGoHistory({ home, ref, now, acceptUnmatched: accept });
  if (!imported.ok) return { exitCode: EXIT.FAILED, output: { ok: false, error: 'history-unreadable', message: `the earlier go applies of this project cannot be imported: ${imported.path ?? 'the history'} ${imported.reason}. Auto-apply was not switched on, but part of the history may already be imported (a failed write can leave earlier files behind; running this again is safe). Fix the file, then run this again. Do NOT just delete a consumed-go marker (a file in live-db-consumed): it is the record that a go-applied migration is already live, and without it that migration could be applied a second time when its PR merges; if it cannot be repaired, check the live state of that migration first (list_migrations or a live-db catalog query) and decide with that in hand` } };
  const list = imported.unmatched.map((u) => ({ sqlSha256: u.sqlSha256.slice(0, 12), consumedAt: u.consumedAt }));
  if (imported.unmatched.length > 0 && !accept) {
    return { exitCode: EXIT.USAGE, output: { ok: false, error: 'unmatched-applies', unmatched: list, message: `${list.length} earlier go apply(ies) of this project have no record left, so their migration name is unknown: ${list.map((u) => `sql ${u.sqlSha256} consumed ${u.consumedAt}`).join('; ')}. If one of these was a migration whose file was changed in its PR after the go, auto-apply would apply the new version too: compare the times with your merged PRs, then run again with --accept-unmatched. Nothing was changed.` } };
  }
  const since = new Date(now()).toISOString();
  return write(state.refs.map((e) => (e.ref === ref ? { ...e, autoMigrations: true, autoSince: since } : e)), {
    note: TRUST_NOTE(entry.repo),
    imported: imported.imported.map((i) => ({ name: i.name, sqlSha256: i.sqlSha256.slice(0, 12), consumedAt: i.consumedAt })),
    unmatched: list,
  });
}

// Writes `refs` only when the registry still is the snapshot this command read: another owner terminal may have changed it meanwhile (the auto-migrations import takes a moment), and writing the old snapshot back would undo that change.
function writeSnapshot({ home, current, state, refs, extra }) {
  if (JSON.stringify(readDbRefs(home)) !== JSON.stringify(current)) return { exitCode: EXIT.FAILED, output: { ok: false, error: 'db-refs-changed', message: `${dbRefsFile(home)} was changed by another command while this one ran; nothing was written to it. Run this again (what was imported is kept, and importing again is safe)` } };
  try {
    const file = writeDbRefs(home, { ...state, refs });
    return { exitCode: EXIT.OK, output: { ok: true, file, refs: wrote(refs), servers: state.servers, ...extra } };
  } catch (err) {
    return { exitCode: EXIT.FAILED, output: { ok: false, error: 'db-refs-unwritable', message: `cannot write ${dbRefsFile(home)}: ${err?.code ?? err?.message}` } };
  }
}

// `after-deploy on|off` (the owner's terminal; the caller has checked insideClaudeCode, the arguments and that the registry is readable). On needs a live entry whose auto-apply is already on and writes the environment and the bot only:
// no time, no GitHub call (the guard decides at apply time: the merge commit must be the default branch's head, N1, and be merged after autoSince, N2). Running it again replaces them; a legacy cutoff-era entry (N3) is replaced by the pair alone.
function afterDeploy({ action, ref, deploy, current, home }) {
  const state = current.ok ? current : { refs: [], servers: [] };
  const entry = state.refs.find((e) => e.ref === ref);
  if (!entry) throw new UsageError(`${ref} is not in the registry: add it with \`pipeline db-refs set --ref ${ref} --name "<label>" --repo <owner/name>\` first`);
  if (action === 'off') return writeSnapshot({ home, current, state, extra: {}, refs: state.refs.map((e) => (e.ref === ref ? { ...e, deployEnv: null, deployBot: null } : e)) });
  if (entry.autoMigrations !== true) throw new UsageError(`${ref} has auto-apply off: switch auto-migrations on first with \`pipeline db-refs auto-migrations on --ref ${ref}\``);
  return writeSnapshot({ home, current, state, refs: state.refs.map((e) => (e.ref === ref ? { ...e, deployEnv: deploy.env, deployBot: deploy.bot } : e)), extra: { note: DEPLOY_NOTE(entry.repo, deploy.env, deploy.bot, ref) } });
}
