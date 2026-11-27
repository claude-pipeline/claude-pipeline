// Why (#261): the PostToolUse half of hooks/owner-go.mjs, kept here so a test can hand it a home and a recorder (the hook script itself always runs, takes the account's real home
// and exits 0). One AskUserQuestion hook input -> the one line the agent is told, or null (nothing printed). Never throws.
import { recordClick } from './owner-go-click.mjs';
import { replyBeforeToolUse } from './owner-go.mjs';

const HEAD = '[claude-pipeline owner-go]';

// #741 (B1b): a live-database click is claimed only when the reply right before its dialog ends with the block (live-db-guard.mjs). The guard says why it refuses only when Claude calls the Supabase write; this says it
// at the click, so the agent presents again at once instead of failing at the write. Only the reply rules that need no block rebuild are checked here (no text, a progress note only, a hidden turn, another turn's block);
// silent when the dialog's tool_use entry is not in the transcript yet (no false refusal before the write lands) and for every click that is not a live-database one. null | the line.
function liveDbDialogRefusal(input, result) {
  if (result?.pending?.kind !== 'live-db' && result?.recorded?.kind !== 'live-db-go') return null;
  let shown;
  try { shown = replyBeforeToolUse(String(input?.transcript_path ?? ''), input?.tool_use_id); } catch { return null; }
  if (shown.reason === undefined || shown.missing === true) return null;
  // a pending click does not say which label the owner chose (the answer is not in the transcript yet), so the recovery is conditional on an approval; a recorded click is a Yes
  const again = 'run live-db present again, end the reply with its block as text (the last thing before the dialog) and show the dialog again, or ask the owner to type the go';
  if (result?.pending) return `${HEAD} the owner's click on the live-database dialog is received, and if it approves the guard will not accept it: ${shown.reason}. Nothing is applied. If the owner chose to apply, ${again}; if they chose not to, stop: nothing is applied`;
  return `${HEAD} the owner's click on the live-database dialog will not be accepted: ${shown.reason}. Nothing is applied; ${again}`;
}

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
  if (p?.kind === 'live-db') return `${said} (live-database go): if the owner chose to apply, call the Supabase write (apply_migration or execute_sql) with exactly the SQL shown now, the guard verifies the click then; if they chose not to, stop: nothing is applied`;
  if (p?.kind === 'round' && p.variant === 'round-v2-follow-up') {
    // Follow up grants nothing: the session first asks the CLI whether the click was verified, BEFORE it reverts anything (defer-fixes refuses "tree is not back" on that probe and prints followUpClick.state)
    return where ? `${said} (extra round or follow-up for ${where}): if the owner chose "Yes, one more round", run P codex-review --pr ${prs[0]} --round <the n from round-request> now; if they chose "Follow up (Recommended)", that is NOT a grant and approves no merge: FIRST run P triage defer-fixes once (before reverting anything) and continue only if its followUpClick.state is "instructed"; otherwise stop and ask the owner to type "follow up"; if they chose "No", stop: nothing is approved` : said;
  }
  if (p?.kind === 'round' && p.variant === 'round-v2-chosen') return where ? `${said} (extra round for ${where}): if the owner chose "Yes, one more round (your choice)", run P codex-review --pr ${prs[0]} --round <the n from round-request> now; if they chose "No, stop and park", stop and park the PR: nothing is approved` : said;
  if (p?.kind === 'round' && p.variant === 'round-v2-park') return where ? `${said} (extra round for ${where}): if the owner chose "Yes, one more round", run P codex-review --pr ${prs[0]} --round <the n from round-request> now; if they chose "No, stop and park (Recommended)", stop and park the PR: nothing is approved` : said;
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
  if (result?.instruction === 'follow-up') {
    const n = Array.isArray(result.prs) ? result.prs.find(Number.isInteger) : undefined;
    const where = result.repo && n !== undefined ? ` for ${result.repo} #${n}` : '';
    const steps = `This is an instruction, not a grant: it admits no round and approves no merge. Do "Follow up instead of a round" (owner-merge.md): take the unreviewed commits out, push, verify.quick, ci-wait, then P triage defer-fixes --pr ${n ?? '<N>'} --ids <the open ids from round-request> --fix-head <the head the line named> --reason "<why they are low severity>". It re-checks everything and can refuse; if it does, say why and ask again with P triage round-request --pr ${n ?? '<N>'} --ask.`;
    return result.replay ? `${HEAD} the owner's click was already received (follow up${where}); do not redo steps already done. ${steps}` : `${HEAD} the owner's click is recorded: follow up${where}. ${steps}`;
  }
  if (result?.recorded) {
    const r = result.recorded;
    if (r.kind === 'live-db-go') return `${HEAD} the owner's click is recorded: live-database go for ${r.op} ${r.op === 'migration' ? r.name : String(r.sqlSha256).slice(0, 12)} on ${r.projectRef}: call the Supabase write with exactly the SQL shown now`;
    if (r.kind === 'ruling') return `${HEAD} the owner's click is recorded: ruling recorded for ${r.repo} #${r.pr}: ${(r.ids ?? []).join(', ')} (pass --owner-quote ${JSON.stringify(String(r.prompt ?? ''))})`;
    if (r.kind === 'extra-round') return `${HEAD} the owner's click is recorded: extra round for ${r.repo} #${r.pr} counted round ${r.k} head ${String(r.head).slice(0, 12)}: run P codex-review --pr ${r.pr} --round <the n from round-request>`;
    const reqs = Array.isArray(r.requests) ? r.requests : [];
    const runs = reqs.filter((q) => q.repo).map((q) => `P merge --pr ${q.pr} --owner-go`);
    // (#585) "recorded" only when the record is usable: a request with a repo is the only kind `P merge --owner-go` accepts. (Defensive: bindAnswer refuses an empty or repo-less request before a click is recorded.)
    if (runs.length === 0) {
      const prs = Array.isArray(r.prs) ? r.prs.filter(Number.isInteger).map((n) => `#${n}`).join(', ') : '';
      return `${HEAD} the owner's click binds nothing: no ${prs ? 'Head/items/repo request was bound in the ask' : 'merge request was bound in the ask'}${prs ? ` (PRs ${prs})` : ''}: run the dry run again (P merge --pr N --dry-run --owner-go) and end a reply with its closing lines, then ask the owner to type "merge"`;
    }
    const shown = reqs.map((q) => `${q.repo ?? '(no repo: approves nothing)'} #${q.pr} head ${String(q.head).slice(0, 12)} items ${q.items}`);
    return `${HEAD} the owner's click is recorded: "merge" for ${shown.join('; ')} — run ${runs.join(' and ')} now`;
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
    const result = await record(input, { ...opts, hookCheck: check });
    return liveDbDialogRefusal(input, result) ?? clickLine(result);
  } catch {
    return null;
  }
}
