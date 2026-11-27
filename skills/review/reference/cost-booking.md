# Booking agent costs

Book every agent call right after it returns.

Book every agent call (implementer, judge, arbiter, substitute; an `arbiter-fix` call is booked as role `arbiter`) right after it returns:
`P cost --pr N --phase <build|review> --role <implementer|judge|arbiter|substitute-opus|substitute-fable> --from-transcript <the agent's transcript>` (add `--retry` on a fix retry). Every review-round call carries `--round R`, the round it served: the judge and arbiter of round R, and the implementer that fixes round R's accepts (a build-phase call has no `--round`); the extra-round ask and `P stats rounds` read it. An implementer you continued (SendMessage) is booked after EACH leg like any call, with that leg's `--round`, because `P cost` remembers per transcript what it already booked and books only what the transcript gained since. The transcript is
`~/.claude/projects/<encoded-cwd>/<session-id>/subagents/agent-<agentId>.jsonl`; the `agentId` is in the Agent tool's result. Calls made before the PR exists (no `N` yet)
are noted (role, phase, transcript) and all booked right after `gh pr create`. A failed `P cost` is a warning, never a reason to stop. The warning "no messages with usage found" (a transcript still empty) means nothing was booked for that call (`skipped: "empty-transcript"`, no retry counted either): run the same command once more after a few seconds.
