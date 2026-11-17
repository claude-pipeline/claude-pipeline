// Why (#261): the PostToolUse half of hooks/owner-go.mjs, kept here so a test can hand it a home and a recorder (the hook script itself always runs, takes the account's real home
// and exits 0). One AskUserQuestion hook input -> the one line the agent is told, or null (nothing printed). Never throws.
import { recordClick } from './owner-go-click.mjs';

const HEAD = '[claude-pipeline owner-go]';

// Why (#472): on Claude Code 2.1.323 the answer's transcript entry is written after the PostToolUse hooks return, so the click is only kept PENDING here (recordClick `{ pending }`) and is verified by
// the consumer that looks for it (`P merge --owner-go` and the others settle first, in the same turn). The line says exactly that: the click is RECEIVED, it is verified when used, and which command to
// run now, one line per kind. It never says "is recorded" (nothing is yet) or "could not be verified" (nothing was tried), and it never says which label the owner chose (that is in the tool_response,
// which is never read), so each command line is conditional in words: the agent runs it only if the answer the dialog returned approves: a ruling lists the `--owner-quote` of each deciding label, the consumer takes the one that matches the transcript.
function pendingLine(p) {
  const prs = Array.isArray(p?.prs) ? p.prs.filter(Number.isInteger) : [];
  const said = `${HEAD} the owner's click is received and is verified when it is used`;
  const where = p?.repo && prs.length ? `${p.repo} #${prs[0]}` : null;
  if (p?.kind === 'merge-many') {
    const runs = prs.map((n) => `P merge --pr ${n} --owner-go`);
    const all = runs.length > 1 ? `${runs.slice(0, -1).join(', ')} and ${runs[runs.length - 1]}` : runs[0];
    return all ? `${said}: if the owner chose to approve, run ${all} now (one per PR the owner ticked; a PR that was not ticked is refused); if they chose not to, stop: nothing is approved` : said;
  }
  if (p?.kind === 'merge') return prs.length ? `${said}: if the owner chose to approve, run P merge --pr ${prs[0]} --owner-go now; if they chose not to, stop: nothing is approved` : said;
  if (p?.kind === 'round') return where ? `${said} (extra round for ${where}): if the owner chose to approve, run P codex-review --pr ${prs[0]} --round <the n from round-request> now; if they chose not to, stop: nothing is approved` : said;
  if (p?.kind === 'ruling') {
    const quotes = Object.entries(p.quotes ?? {}).filter(([, v]) => typeof v === 'string').map(([label, text]) => `${JSON.stringify(label)} -> --owner-quote ${JSON.stringify(text)}`);
    // #541: only the declining label (rulingAsk's null action, "Not now") stops; Reject all and Follow-up all are rulings too and run the command, so the line is worded by label, never approve / not approve
    const run = quotes.length ? `if the owner chose one of these labels, run P triage owner-ruling now with its --owner-quote: ${quotes.join('; ')}` : 'if the owner chose any label other than Not now, run P triage owner-ruling now';
    return `${said}${where ? ` (ruling for ${where})` : ''}: ${run}; if they chose Not now, stop: nothing is ruled`;
  }
  return said;
}

// The line for one click result, in the style of the typed lines (hooks/owner-go.mjs). null prints nothing.
export function clickLine(result) {
  if (result?.pending) return pendingLine(result.pending);
  if (result?.recorded) {
    const r = result.recorded;
    if (r.kind === 'ruling') return `${HEAD} the owner's click is recorded: ruling recorded for ${r.repo} #${r.pr}: ${(r.ids ?? []).join(', ')} (pass --owner-quote ${JSON.stringify(String(r.prompt ?? ''))})`;
    if (r.kind === 'extra-round') return `${HEAD} the owner's click is recorded: extra round for ${r.repo} #${r.pr} counted round ${r.k} head ${String(r.head).slice(0, 12)}: run P codex-review --pr ${r.pr} --round <the n from round-request>`;
    const reqs = Array.isArray(r.requests) ? r.requests : [];
    const shown = reqs.map((q) => `${q.repo ?? '(no repo: approves nothing)'} #${q.pr} head ${String(q.head).slice(0, 12)} items ${q.items}`);
    const runs = reqs.filter((q) => q.repo).map((q) => `P merge --pr ${q.pr} --owner-go`);
    return `${HEAD} the owner's click is recorded: "merge" for ${shown.length ? shown.join('; ') : 'no Head/items/repo request in the ask'}${runs.length ? ` — run ${runs.join(' and ')} now` : ''}`;
  }
  if (result?.declined !== undefined) return `${HEAD} the owner chose ${JSON.stringify(String(result.declined))}: nothing is approved; stop and say what stays open`;
  if (result?.refused) return `${HEAD} the click could not be verified (${result.refused}): ask the owner to type the closing words instead`;
  return null;
}

// (R1-F1) What the hook script writes to stdout for that line. Claude Code adds plain exit-0 stdout to the model's context only on UserPromptSubmit / SessionStart; on PostToolUse the
// channel is JSON `hookSpecificOutput.additionalContext`. '' (print nothing) when there is no line.
export function clickHookOutput(line) {
  if (typeof line !== 'string' || line === '') return '';
  return `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: line } })}\n`;
}

// The dialog-hook check handed to the recorder, loaded lazily: a lib that will not load refuses the click ('dialog-hooks-unavailable') and breaks nothing else.
export async function dialogHookCheck({ home, input }, load = () => import('./dialog-hooks.mjs')) {
  try {
    const { checkDialogHooks } = await load();
    return await checkDialogHooks({ home, cwd: input?.cwd, projectDirs: [process.env.CLAUDE_PROJECT_DIR] }); // (R1-F2: the hook's own environment names the folder the session was launched in)
  } catch {
    return { ok: false, reason: 'dialog-hooks-unavailable' };
  }
}

// `record` and `check` are injectable for tests; the options go to recordClick (home, now, sleep, pollMs).
export async function clickHookLine(input, { record = recordClick, check = dialogHookCheck, ...opts } = {}) {
  try {
    if (input?.hook_event_name !== 'PostToolUse' || input.tool_name !== 'AskUserQuestion') return null;
    return clickLine(await record(input, { ...opts, hookCheck: check }));
  } catch {
    return null;
  }
}
