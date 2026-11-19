#!/usr/bin/env node
// Why (#58): global UserPromptSubmit hook (~/.claude/settings.json) that records the owner's chat "merge", and (Phase 3b) the owner's
// answer to a review-item ruling request, and the owner's `extra round` for one more review round past the cap (lib/owner-go.mjs has
// the rules and the residual). The owner's typed prompts reach this event, and (#128) so do harness-injected turns (task notices, peer and
// scheduled messages), which the recorders therefore screen out. It must never
// block a prompt: it always exits 0, and it is started WITHOUT the guards' fail-closed loader (an exit 2 here would swallow
// the owner's message). On UserPromptSubmit, stdout is added to the model's context: one line says what was recorded, so the
// agent can run `P merge` with the matching flags; nothing is printed otherwise, except (#128) one line when the owner's prompt reads as a ruling
// answer that nothing was recorded for (the agent must ask again), and (#191) one line when the owner's "merge", "extra round" or ruling answer was typed
// while the agent was still working (a queued prompt records nothing).
// (#261) The SAME script is also registered on PostToolUse for AskUserQuestion (click-to-approve, lib/owner-go-click.mjs): the owner's click on a dialog the pipeline
// issued is verified against the transcript and recorded like the typed words (lib/owner-go-click-hook.mjs). PostToolUse plain stdout does NOT reach the model, so the line goes out as JSON hookSpecificOutput.additionalContext (R1-F1): one line says the
// click is recorded, declined (nothing approved), received and verified when used (#472: Claude Code 2.1.323 writes the answer to the transcript only after this hook returns, so the
// click is kept pending and the consumer verifies it) or could not be verified (the owner types the closing words instead); nothing is printed for an AskUserQuestion that is
// not one of ours. The dialog-hook check (lib/dialog-hooks.mjs) is loaded lazily: if it cannot load, no click is admitted.
// (#472) This script and the click libraries (lib/owner-go-click.mjs, lib/owner-go-click-hook.mjs) are not meant to be run by hand: a pending click keeps the capture-time hook result this hook passes
// in, so the guard (lib/files-policy.mjs OWNER_GO_RECORDER) refuses a runtime that runs them in the direct shapes: a path, program text, or a program read from stdin (a heredoc, a here-string, a pipe).
// Not closed: a hand-written script FILE that imports a click library can write a pending click with a made-up capture-time hook result, which skips only the dialog-hook check (see lib/owner-go-click.mjs).
async function onPrompt(input) {
  const { recordApproval, recordRuling, recordRoundGrant, recordPastRoundGrant, rulingNudge, queuedNudge } = await import('./lib/owner-go.mjs');
  const record = recordApproval(input);
  const ruling = recordRuling(input);
  const round = recordRoundGrant(input);
  const past = recordPastRoundGrant(input); // (the 🔂 line and the 🔁 line are exclusive: at most one of round / past records)
  // (#191 F3) a queued answer records nothing; its nudge takes precedence over the ruling nudge
  const nudge = ruling || round || past ? null : (queuedNudge(input) ?? rulingNudge(input));
  if (ruling) process.stdout.write(`[claude-pipeline owner-go] the owner's ruling is recorded for ${ruling.repo} #${ruling.pr}: ${ruling.ids.join(', ')} (pass words from it as --owner-quote).\n`);
  if (round) process.stdout.write(`[claude-pipeline owner-go] the owner's extra round is recorded for ${round.repo} #${round.pr} counted round ${round.k} head ${round.head.slice(0, 12)}: run P codex-review --pr ${round.pr} --round <the n from round-request>\n`);
  else if (past) process.stdout.write(`[claude-pipeline owner-go] the owner's past-round approval is recorded for ${past.repo} #${past.pr} counted round ${past.k} head ${past.head.slice(0, 12)}: run P state past-round-grant --pr ${past.pr} --round <the n from round-request --past>\n`);
  else if (nudge) process.stdout.write(`${nudge}\n`);
  if (record) {
    const shown = record.requests.map((q) => `${q.repo ?? '(no repo: approves nothing)'} #${q.pr} head ${q.head} items ${q.items}`);
    const prs = record.prs.map((n) => `#${n}`).join(', ');
    // (#585) "is recorded" only when the record is usable: a request with a repo is the only kind `P merge --owner-go` accepts. Otherwise say it binds nothing and how to continue (the stored record is the same either way).
    if (record.requests.some((q) => q.repo)) process.stdout.write(`[claude-pipeline owner-go] the owner's "merge" is recorded: ${shown.join('; ')}${prs ? `; PRs ${prs}` : ''}.\n`);
    else process.stdout.write(`[claude-pipeline owner-go] the owner's "merge" binds nothing: ${prs ? `no Head/items/repo request was bound in the last reply (PRs ${prs})` : 'no merge request was shown in the last reply'}: if a merge request is open, show its closing lines again as the reply's last lines (in an owner_approval: chat repo, from P merge --pr N --dry-run --owner-go), then ask the owner to type "merge"\n`);
  }
}

try {
  const { readHookInput } = await import('./lib/hook-io.mjs');
  const input = await readHookInput();
  if (input?.hook_event_name === 'PostToolUse') {
    const { clickHookLine, clickHookOutput } = await import('./lib/owner-go-click-hook.mjs');
    const line = await clickHookLine(input);
    process.stdout.write(clickHookOutput(line));
  } else {
    await onPrompt(input);
  }
} catch { /* never block or break a prompt */ }
process.exitCode = 0;
