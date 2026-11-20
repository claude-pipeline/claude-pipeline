# Guard follow-up PR (#683 #610 #617 #618 #620 #624 #609 #607 #608 #605 #600; #627 split out)

Base: origin/main 3721d8c6. Branch: agent/guard-followups-683. One PR, one subsystem (the two guard hooks), ~270 non-generated lines
(about 60 source, 210 test and doc). Risk: high (guard core: fan-out rule, git branch tracking, the registry writer).
Plan only: nothing here is built yet. Line numbers are at 3721d8c6 (the issues quote older numbers).
Revision 3 (Codex recheck applied; owner decisions 2026-11-20: #627 is its own PR, #624 is fixed narrowly, #605 case 1 is documented only).

Threat model every fix is judged against (owner 2026-11-13): (a) no new hole, (b) no one-step disguise an agent would write,
(c) no over-denial of everyday commands, (d) a timeout fail-open on plausible input is merge-blocking. Past widenings of the fan-out allow-list each
reopened an (a) hole, so this plan adds NO general masking door: it removes only operands it can name exactly, and every fix lists the existing DENY rows
that must stay denied. The implementer runs those rows before and after.

Everything below was probed against the live code (scratch probes outside the repo) unless marked "by reading".

## Verification results that shaped the plan

- **#683 is real** (files guard, checkout copy of the lib): `node -e "import('<lib>').then(m => m.writeDbRefs(require('os').homedir(), {refs: []}))"`, a scratch
  `scratch.mjs` importing it, and `node <lib>` are all ALLOWED; the same shapes for `live-db-go.mjs` are DENIED. `writeDbRefs(home, state)` (hooks/lib/db-refs.mjs:64) has no caller
  check; only `commands/db-refs.mjs:68` calls `insideClaudeCode(env, ctx)` (lib/owner-only.mjs:8: null under the owner's admin switch; else CLAUDECODE=1 or a Claude Code ancestor).
  The CLI is the only production caller. The registry is seeded today by in-process `runDbRefs(['set', ...], { home, env: {}, hasClaudeCodeAncestor: () => false })` in
  test/live-db-guard.test.mjs:32-33, live-db-go.test.mjs and live-db-click.test.mjs (import at :13 / :10), and by 20 `ownerCtx(home)` calls in test/db-refs.test.mjs.
- **Fan-out, what is ALLOWED today** (protected path ONLY on the producer side of the pipe, probe): `find PP -type f | env -S 'xargs rm'`, `... | gtimeout 5 sh -c 'xargs rm'`,
  `... | /usr/bin/time -o out.txt -f 'xargs rm' cat x`, `... | env LESS=x rg --pre 'xargs rm' x`, `... | rg --pre 'xargs rm' x`, `... | bat --pager 'xargs rm' x`,
  `... | git -c core.pager='xargs rm' log`, `cat PP/VERSION | git -c core.pager='xargs rm' log`, `... | node PP/bin/pipeline.mjs summary 'ls; xargs rm'`,
  `... | node PP/bin/pipeline.mjs job start a -- 'xargs rm'`. (`... | LESSOPEN='|xargs rm %s' less x` is DENIED.) The pool check never sees these downstream commands (they do not name the
  protected path themselves); only the fan-out gate can stop them, and `FAN_OUT_RE` (files-policy.mjs:2523) cannot see `'xargs` because a quote is not in its leading class (#618).
- **#624**: `git -C PP log --grep="use workers"` is ALLOWED (git read-only accepts `--grep`); with `parallel` / `xargs` inside the pattern only the fan-out gate refuses it.
  `git -c core.pager='xargs rm' -C PP log --grep="use workers"` is DENIED by the pool check ("not a read-only command").
- **#617 (4)**: `"PP/bin/pipeline.mjs" summary --built "x parallel y"` and the unquoted form are DENIED today by the fan-out gate; `isReadOnly` trusts the installed pipeline executable by
  path (files-policy.mjs:3374, `isPipelineTool`), so once the prose value is recognised as data the pool check allows it.
- **#609 reproduces** (probe, relative and absolute helper paths): s.sh = `cd pkg || { echo missing >> err.log; exit 1; }` then `git push`: `bash s.sh` and `bash s.sh; git push` are DENIED
  with "the script s.sh would run a blocked command: cannot determine the current branch". `/usr/bin/time exit 1` and `time exit 1` in place of `exit 1` are DENIED too (`time` gives "cannot tell
  which directory this `git push` runs in"). A group that runs `bash /work/repo/fix.sh` (fix.sh = `git checkout main`) before `exit 1` is DENIED the same way.
- **#607 does not reproduce**: a logging copy of git-policy.mjs shows no failure group is ever recorded with a subshell level in `up` (shape analysis is off in subshells; groups are recorded only
  at the top level, in a brace group, and in nested texts). `(cd dist || { bash /work/repo/cleanup.sh; exit 1; }; make); git push` with cleanup.sh = `git checkout main` -> DENY
  ("cannot determine the current branch"). Pin only; no `inSub` branch (it would be dead code).
- **#608's own example is already denied** (candidate rule): `PATH="$(tooldir):$PATH" source env.sh; git -C /work/repo push` -> DENY. Literal PATH: `PATH="/opt/tools:$PATH" source env.sh;
  git -C /work/repo push` with `/opt/tools/env.sh` = `git checkout main` -> DENY ("cannot determine the current branch"); harmless file or no file -> ALLOW. The everyday
  `export PATH="$HOME/bin:$PATH"; [ -f .env.local ] && source .env.local; git -C /work/repo push` -> ALLOW.
- **#605**, all four cases traced and reproduced (table in section 4): decided as document-only.

## Task order (one implementer)

1. #683 2. fan-out cluster #610 #617 #618 #620 #624 3. #609 + pins #607 #608 4. docs: #605 cases 1-4 and #600.
Each task: failing tests first (confirm red), fix, confirm green, then the neighbour files named in the task.
Verify: `node scripts/verify.mjs --quick` after tasks 1, 2, 3 and at the end; targeted runs
`node --test test/guard-files.test.mjs test/guard-git.test.mjs test/guard-followups-492.test.mjs test/db-refs.test.mjs test/live-db-guard.test.mjs test/live-db-go.test.mjs test/live-db-click.test.mjs test/shell-parse.test.mjs test/guard-overdenials-373.test.mjs test/guard-corpus-everyday.test.mjs test/guard-false-positives.test.mjs test/claude-ancestry.test.mjs test/docs-facts.test.mjs test/vendor.test.mjs`.
Run the db-refs / live-db suites once with CLAUDECODE=1 in the environment (the owner's agents run them inside a session); they must pass there.
Note: the live guards refuse scratch files and test text that spell a protected path or a push to main; build such strings from parts in fixtures (the existing tests do) and write probe files with the Write tool.

---

## 1. #683 registry writer libraries lack the recorders' run/import protection (~125 lines: 14 source, 110 test)

Root cause: `OWNER_GO_LIBS` (files-policy.mjs:882) lists `owner-go(-click(-hook))?|live-db-go` only; `OWNER_GO_RECORDER` (:883, path) and `OWNER_GO_WORD` (:884, word / stdin) are built from it;
the run check (:5436-5470) refuses a runtime or a directly-run file that names one. `db-refs.mjs` is in neither, and `writeDbRefs` trusts its caller.

Which layer denies which acceptance case:

| Case | Layer that denies | Why |
|---|---|---|
| `node -e "import('.../db-refs.mjs').then(...)"`, `node <lib>`, `node ./pipeline/commands/db-refs.mjs`, `node - <<'EOF'` importing it | the hook: `OWNER_GO_WORD` / `OWNER_GO_RECORDER` (add `db-refs` to `OWNER_GO_LIBS`) | the lib name is in argv or in the stdin program text |
| a scratch `.mjs` file that imports the lib and calls `writeDbRefs` | the writer itself: it refuses inside Claude Code, on the real env + real ancestry | the interpreter-file scanner (files-policy.mjs:4303-4314) checks protected paths and write hints, not library names. Adding `OWNER_GO_WORD` there would refuse `node --test test/db-refs.test.mjs` (the repo's own tests import the lib, db-refs.test.mjs:9, as live-db-go.test.mjs does for its lib). So the hook ALLOWS the scratch file by design; the writer is the control. |

Fix (production code only, NO test exception, NO seam):
- files-policy.mjs:882: add `|db-refs`; reword the three deny strings (:5446 / :5465 / :5468) with one clause "or the database registry writer".
- hooks/lib/db-refs.mjs: `writeDbRefs(home, state)` keeps its two-argument signature and gains NO parameter. First statement, before any mkdir or write:
  `const inside = insideClaudeCode(process.env); if (inside) throw new Error(...)` naming the owner's terminal (real env, real ancestry walk; import from `../../lib/owner-only.mjs` as dialog-hooks.mjs:15 does).
  `commands/db-refs.mjs` is unchanged (its own ctx check at :68 stays the first layer and gives the friendly message).

Tests (the registry is written only by the owner: every test that WRITES runs the writer in a child process as the owner, in a disposable home, so the suites pass both inside and outside a Claude session; read-side fixtures write the JSON directly):
- New helper `test/helpers/db-refs-owner.mjs` (the only new test file besides its child entry; four suites need it) and a child entry `test/helpers/db-refs-owner-child.mjs` in the style of test/helpers/prune-archive-child.mjs (a JSON argv, one `run` call).
  `seedRegistry(home, { refs, servers })` writes `<home>/.claude/pipeline-state/db-refs.json` directly with the writer's exact body (`{ v: 1, refs, servers }`, mode 0600, creating the folder), for read-side fixtures.
  `runOwnerCli(home, args, env?)` spawns the child entry, which calls `run(args, { home })` from commands/db-refs.mjs with an EXPLICIT `home` and REFUSES to run when `home` is not under `os.tmpdir()`, so a mistake can never touch the account's real registry.
  It must NOT spawn bin/pipeline.mjs: that path passes no `home`, so commands/db-refs.mjs:27 falls back to `accountHome()`, which ignores HOME and would write the owner's REAL registry.
  Child env: the owner's admin switch set (name built from parts) and the session marker removed, so the owner-write path also works inside a Claude session; the child prints `{ exitCode, output }` as JSON.
- In-process writers to adapt (all fail under CLAUDECODE=1 once the writer refuses, because the throw becomes `db-refs-unwritable`, commands/db-refs.mjs:82-83): test/live-db-guard.test.mjs:32-33 (scene seeding), :151, :157, :196;
  live-db-go.test.mjs and live-db-click.test.mjs (their `runDbRefs(['set', ...], own)` seeding); test/db-refs.test.mjs:74 and the 20 `ownerCtx(home)` calls that write (`set`, `remove`, `server add|remove`).
  State fixtures go through `seedRegistry`; tests of the CLI's write behaviour go through `runOwnerCli`. `show`, the refusal-inside-a-session cases and the `assert.rejects(..., UsageError)` cases (parsing fails before any write) stay in process.
  The existing assertions (round trip, duplicate ref replaces, file mode 0600, refuses inside a session) are kept. The entry shape for `seedRegistry` is read from commands/db-refs.mjs `set`.
- Hook DENY (today ALLOW; red first), via `evaluateBashForFiles`, in test/db-refs.test.mjs next to the precedent test/live-db-go.test.mjs:244-256: the argv/stdin shapes in the table above, with the installed path and the checkout path.
  Hook ALLOW: `node PP/bin/pipeline.mjs db-refs show`, `cat <lib>`, `git add pipeline/hooks/lib/db-refs.mjs`, `node --test test/db-refs.test.mjs` (`db-refs.test.mjs` must not match `db-refs\.mjs`).
  Existing DENY rows stay: `pipeline db-refs set x` (DB_REFS_RAW, :3953) and every owner-go / live-db-go row.
- Writer, REAL child processes running a scratch `scratch.mjs` that imports the checkout lib and calls `writeDbRefs(diskHome, state)` (disposable `diskHome`; registry bytes read before and after):
  a. `CLAUDECODE=1`, no registry folder yet (first creation) -> non-zero exit, message names the owner's terminal, NO registry folder or file created.
  b. `CLAUDECODE=1`, an existing registry file -> refuses, bytes identical.
  c. `CLAUDECODE` removed but spawned UNDER a parent `node <tmp>/claude-code/cli.js` (matches the `isClaudeCodeProcess` args rule, claude-ancestry.mjs:102-106; claude-ancestry.test.mjs has the spawn pattern) -> refuses: the ancestry-only case; bytes / absence unchanged.
  d. no-ancestor positive: the child runs with `noClaudeSession()` from test/helpers/no-claude-session.mjs merged into its env (a fake `ps` that knows no Claude Code process, session marker dropped; not faked on Windows, so the row is skipped on win32) and NO admin switch -> writes, including first creation with no folder.
  e. the owner's admin switch set (inside a session) -> writes, including first creation with no folder.
Risk: the word check refuses ANY runtime run naming `db-refs.mjs` (as for the other recorders: `node --check pipeline/commands/db-refs.mjs` is refused; the owner uses the admin switch). It reads every argv word of the runtime, so a prose hit is refused too:
`node PP/bin/pipeline.mjs summary --built "... db-refs.mjs ..."` is denied; workaround: do not spell the file name in prose (say "the registry writer").
Documented limit: a text scan cannot see a name built at run time or a lib copy staged elsewhere (the recorder family's stated residual); a copy without the check is the same residual.

## 2. Fan-out cluster: #610 #617 #618 #620 #624 (~75 lines: 38 source, 37 test)

Where: files-policy.mjs:6053-6057 (`rawHead`, `knownNonRunner`, `runsText`, `fansOut`) and `FAN_OUT_RE` (:2523). Principle: keep today's decision of WHICH commands keep their quoted text, and for
those remove ONLY the exactly named data operands before the `FAN_OUT_RE` test. No wrapper list, no "known data head" door: wrapper options with side effects (`/usr/bin/time -f '...'`), assignments, pagers,
`-c` config and every other word stay in the scanned text.

Root causes (traced): quoted prose is scanned because the command is judged "may run its text" for reasons unrelated to that operand: a wrapper head (`env LC_ALL=C rg ' xargs '`, #610), a wrapper-named word
(`exec` in `rg -e exec`, #610), a quoted assignment or leading `if` that makes the raw head differ from argv[0] (#617 1, 2), an interpreter-named base in prose (`R2`, #620), git not being a non-runner (#624);
and `FAN_OUT_RE` lacks a quote in its leading class (#618), which hides the wrapped producer-only shapes above.

Fix:
1. `FAN_OUT_RE`: leading class `[\s;&|(\`'"]` (add the two quote characters). One more consumer, the installer feeder at :3944 (install-checkout context only; only stricter).
2. `knownNonRunner` / `runsText` (:6053-6055), three narrow changes:
   a. The `INLINE_RUNNERS` door is KEPT for exactly the trusted pipeline command and dropped for every other file program. `trustedCall(c) = isPipelineTool(argv[0], ctx) || (baseOf(argv[0]) === 'node' && isPipelineTool(argv[1], ctx))`; the door opens when
      `trustedCall(c)` and the written head equals argv[0] (today's `rawHead` test) and the command is not `triage settle` carrying `--test-cmd`. For a trusted call ALL its flags keep main's blanking: `comment --reason`, `triage --reason` / `--owner-quote`,
      `checkpoint --next` / `--detail`, `redraft` / `merge-hold --reason`, `live-db --summary`, `summary --built` (apostrophes included), `agent-log publish --line`. EXCEPTION: `triage settle --test-cmd` is run by a shell (commands/triage.mjs:281), so
      its quoted text stays scanned (today it is blanked: a pre-existing gap, closed here with a DENY row). Any other `node` / `python` file program loses the blanking (`node x.mjs 'ls; xargs rm'` was blanked today).
   b. One line: a head in `less more bat man`, or an argv word `--pre` / `--pre-glob` / `--pager` / `--preprocessor` (any `=value`), is not a known non-runner (pager / preprocessor options are command-valued; `rg --pre 'xargs rm'` and `bat --pager 'xargs rm'` were blanked today).
   c. #620: for a trusted call the word-wide clauses (a wrapper, shell or interpreter NAME among the argv words) skip the values of `--built` / `--line`, so a prose word ending in `/R2` does not make the command "run its text"; `job start a -- sh -c ...` still counts its `sh`.
3. New `withoutDataOperands(c, ctx)` (~25 lines) applied when `runsText(c)` is true: `FAN_OUT_RE.test(withoutDataOperands(c))` instead of `FAN_OUT_RE.test(c.raw)`. It removes only operands from this closed list, and only when the quoted value has no `$`, backtick,
   backslash or quote character and its needle occurs EXACTLY ONCE in `c.raw` (anything else: nothing is removed, the text is scanned whole):
   - #617 shapes that main already denies (a quoted assignment value with a blank, a leading `if` / `!`, a quoted head), trusted call only: the values of `--built` and `--line` (needles `--built "v"`, `--built 'v'`, `--built="v"`, `--built='v'`, same for `--line`).
   - `rg` / `grep` / `egrep` / `fgrep` and `git ... log`, ONLY when the raw text before the head word is empty, assignments (`NAME=value`, quoted values allowed), or `env` followed by assignments only (`^\s*(?:ASSIGN\s+)*(?:env\s+(?:ASSIGN\s+)*)?` then the head). Any other prefix
     (`wsl`, `sudo`, `ssh`, `timeout`, `/usr/bin/time -f ...`, `env -S ...`) leaves the text scanned: a wrapper can hand the rest of the line to a shell or write its own output file.
     - rg / grep: the values of `-e` and `--regexp` (needles `-e 'v'`, `-e "v"`, `--regexp 'v'`, `--regexp="v"`...); and the FIRST non-option operand as the pattern only when no `-e` / `--regexp` / `-f` / `--file` is present and every word before it is a boolean flag:
       a short cluster of letters from `inFwvlLcrRHhsqEPSUIaoxzu`, or one of `--ignore-case --line-number --fixed-strings --word-regexp --invert-match --files-with-matches --count --recursive --no-messages --quiet --hidden --no-ignore --smart-case --no-heading --with-filename --no-filename --only-matching`.
       Any other option before it (it may take a value) means no positional pattern is recognised. Fixes #610.
     - git: after zero or more `-C <dir>` pairs, the subcommand `log`: the values of `--grep`, `--author`, `--committer` (spaced or `=` form, same needles). Any other global option (`-c ...`, `--git-dir`), word, substitution, redirect or pipe stage stays scanned. Fixes #624. (`-S` / `-G` are NOT included.)
   Anything an issue needs beyond these operands is a documented limit (below).

Failing tests first (`test/guard-files.test.mjs` BASH_ALLOW / BASH_DENY tables; `PP` = installed pipeline folder; one line per row):
- ALLOW, denied today with "hands work to xargs or a shell": `env LC_ALL=C rg ' xargs ' PP` and `env LC_ALL=C grep -n ' parallel ' PP/VERSION` (#610); `rg -e ' xargs ' -e exec PP` (#610);
  `GH_TOKEN="$(gh auth token)" node PP/bin/pipeline.mjs summary --built "x parallel y"` (#617-1); `if node PP/bin/pipeline.mjs summary --pr 561 --built "x parallel y"; then echo ok; fi` (#617-2);
  `"PP/bin/pipeline.mjs" summary --built "x parallel y"` (#617-4, direct run of the trusted tool; pinned ALLOW); `node PP/bin/pipeline.mjs summary --pr 606 --outcome awaiting-owner-merge --built "Guard tests run in parallel jobs; fixes R1/R2"` (#620);
  `git -C PP log --grep="use parallel workers"` and `git -C PP log --grep "use parallel workers" --oneline` (#624).
- ALLOW, green today, must stay (they pin that keeping main's blanking for the trusted command covers every prose flag; copy a valid invocation of each command from its own test, with ` parallel ` or ` xargs ` inside the prose value):
  `comment --reason`, `triage ... --reason` and `--owner-quote`, `checkpoint --next` and `--detail`, `redraft --reason`, `merge-hold --reason`, `live-db ... --summary`, `agent-log publish --line '... parallel ...'`, `summary --built "don't run jobs in parallel"` (apostrophe),
  and the two existing #563 rows.
- DENY, the producer-only rows (today ALLOW; each goes red -> green, and they pair with the ALLOW rows above): `find PP -type f | env -S 'xargs rm'`; `... | gtimeout 5 sh -c 'xargs rm'`; `... | /usr/bin/time -o out.txt -f 'xargs rm' cat x` (wrapper with side-effect options);
  `... | env LESS=x rg --pre 'xargs rm' x`; `... | rg --pre 'xargs rm' x`; `... | bat --pager 'xargs rm' x`; `... | git -c core.pager='xargs rm' log`; `cat PP/VERSION | git -c core.pager='xargs rm' log`;
  `... | node /tmp/x.mjs 'ls; xargs rm'` (forwarded compound argument to a NON-trusted file program); `... | node PP/bin/pipeline.mjs triage settle --id 1 --result bug-confirmed --test-cmd 'xargs rm x' --test-file x` (the shell-run `--test-cmd`);
  `... | LESSOPEN='|xargs rm %s' less x` (already DENY: stays).
- DENY, paired with the #624 / #610 ALLOW rows (the same operand next to something that runs): `git -c core.pager='xargs rm' -C PP log --grep="use workers"` (DENY today by the pool: stays); `git -C PP log --grep="a parallel b" | xargs rm`;
  `git -C PP log --grep="a parallel b" --format='%s' | sh`; `env LC_ALL=C rg -e ' xargs ' PP 'q; xargs rm'` (a second quoted word is scanned); `wsl grep -e 'x; xargs rm' PP/VERSION` (green today; pins the prefix rule: a wrapper other than `env` + assignments keeps the text);
  `TITLE="a parallel b"; ls PP` (assignment-only stays DENY: pins the documented limit).
Existing DENY rows that must stay denied (guard-files.test.mjs:217-233; each gets its reason from this gate): `echo PP | xargs rm -rf`, `find PP -type f | xargs rm`, `... | env -S 'nice xargs rm'`, `... | flock f -c 'cat | xargs rm'`,
`... | noglob env -S 'nice xargs rm'`, `... | gtimeout 5 sh -c 'cat | xargs rm'`, `... | ash -c ...`, `... | gtimeout 5 mksh -c ...`, `... | rbash -c ...`, `... | gtimeout 5 yash -c ...`, `echo "$(find PP -type f | xargs rm)"`,
`find PP -type f -printf 'rm %p\n' | sh`, `eval "$(cat PP/VERSION)"`, `rg --pre ./evil.sh foo PP`, `git diff --output=...`, `node ...pipeline.mjs job start a -- sh -c 'echo x > ...settings.json'`.
Risk: the only place a mistake reopens an (a) hole. The ONLY new door is the closed operand list (needle exactly once, free of expansions, wrapper-free prefix); everything else widens the scanned text, never narrows it.
Accepted over-denial (rare): `node script.mjs "...xargs..."` (a non-trusted file program with a quoted fan-out word and a protected path on the line); `--built` / `--line` prose that contains a quote character on the #617 shapes (assignment prefix, `if`, quoted head) stays scanned.

## 3. #609 (fix, ~40 lines) and #607 / #608 (pins, ~13 lines)

**#609** git-policy.mjs:3452-3457: after a non-inert failure group in a nested text, `forgetBranches(ctx)` runs at the first command after the group, so later commands of the same text lose the exact
snapshot. Fix: defer to the END OF THE TEXT only when the group's exit is a verified literal, unwrapped exit of the shell that runs the text; otherwise forget immediately, exactly as today.
`literalExit = plainExit(e) && e.spawn !== true && /^\s*exit(?:[\s;}]|$)/.test(e.raw)` where `e = cmds[failGroup.to]`: argv is exactly `exit [n]` (plainExit), no child-launch flag, AND the WRITTEN first word is a bare `exit`.
The third term is needed because wrapper classification uses the basename (shell-parse.mjs:63, :565): an absolute external `/usr/bin/time exit 1` is read as the shell's own `time` (no `spawn` flag) and unwraps to argv `exit 1`, yet cannot end the
shell; `nohup`, `env`, `timeout`, `command`, `builtin`, `exec`, a quoted `'exit'` and `time exit` all fail the written-word test and keep today's immediate forget (the fail-closed direction; no parser change).
`if (!inert) { if (level > 0 && literalExit) pendingForget = true; else forgetBranches(ctx); }` with `let pendingForget = false` next to `failGroup` (:3354), and `if (pendingForget) forgetBranches(ctx)` in the end-of-text block (:3629-3632).
In a child-run text (`bash s.sh`) the exit ends the child, which IS the text, and in a sourced text (`source s.sh`) it ends the sourcing shell, also the end of the text: commands after the group in the same text do not run when the group did.
The caller keeps today's protection: at the end of the text every branch is marked unknown, so a push after `bash s.sh` / `source s.sh` is still judged unknown. No `inSub` term (dead code, probed).
A function named `exit` defined by the caller would make the written `exit` not leave the shell in a SOURCED text, which the literal-exit test cannot see: pinned below; if the pin turns ALLOW under the rule as written, restrict the deferral to child-run texts (`bash s.sh`:
a child shell does not inherit the caller's functions unless exported) and the `source s.sh` ALLOW rows become DENY pins.

Tests (the file where #554 lives, `test/guard-followups-492.test.mjs`; confirm with `grep -n 554`; scripts via `readText`; branch `agent/x`). Fixtures: every s.sh starts with an ABSOLUTE `cd /work/repo ||` (a relative cd leaves the directory unknown and denies early, proving nothing;
after `source` a bare push in the caller is refused for the same reason, so the caller pushes with `git -C /work/repo push`). V1 = `cd /work/repo || { echo missing >> err.log; exit 1; }\ngit push\n`; V2 = `cd /work/repo || { bash /work/repo/fix.sh; exit 1; }\ngit push\n`;
fix.sh = `git checkout main`. Re-record the base verdict of every row at the red step (the probes above used a relative `cd pkg`). Each denial asserts reason AND where it is:
- ALLOW (red today): `bash s.sh` and `source s.sh` for V1 and V2 (push INSIDE the text after a literal exit; in V2 the child switches branch only on the path that exits).
- DENY, in the CALLER (must stay; assert `reason` matches /cannot determine the current branch/ and does NOT match /the script s\.sh/, i.e. it is on the caller's push; today it is on the script): `bash s.sh; git -C /work/repo push` and `source s.sh; git -C /work/repo push`, for V1 and V2.
- DENY, inside the script (must stay; assert /the script s\.sh would run a blocked command/): s.sh = `cd /work/repo || { echo missing >> err.log; /usr/bin/time exit 1; }\ngit push\n`, the same with `time exit 1`, `nohup exit 1`, `env exit 1`, `command exit 1` for `bash s.sh`
  (immediate uncertainty kept: these cannot be told from a child-local exit). To prove the written-word term is what holds, the implementer checks that the `/usr/bin/time` fixture goes ALLOW if the check is reduced to `plainExit && !spawn`.
- Pin, redefined exit: `exit() { :; }; source /work/repo/s.sh` with V1 -> DENY expected (see the fallback above if it is ALLOW).
- Pin, intended tightening: s.sh = `cd /work/repo || { echo missing >> err.log; exit 1; }\ngit switch agent/x\n` and `bash s.sh; git -C /work/repo push` -> DENY /cannot determine the current branch/ in the caller. After a non-inert group the script's later `git switch agent/x`
  used to re-establish a known branch for the caller; with deferral the end-of-text forget wipes it, so the caller's push is now judged unknown. This is an intended tightening (the caller cannot rely on knowledge gained after a group that may have run something); record the base verdict at the red step.
- Pin #607 (green today): `(cd dist || { bash /work/repo/cleanup.sh; exit 1; }; make); git push`, cleanup.sh = `git checkout main` -> DENY /cannot determine the current branch/.
- Pin #608, three rows (green today): dynamic PATH DENY: `PATH="$(tooldir):$PATH" source env.sh; git -C /work/repo push`; literal PATH, local `env.sh` absent, `/opt/tools/env.sh` = `git checkout main` -> DENY
  /cannot determine the current branch/ (the candidate was walked); the same with a harmless `/opt/tools/env.sh` -> ALLOW; the everyday `export PATH="$HOME/bin:$PATH"; [ -f .env.local ] && source .env.local; git -C /work/repo push` ALLOW.
  They fail if someone fixes #608 by excluding PATH-setting lines (rule 4) or lets `sourceGone` hide the walked case. No source change for #608 (:3558, :3560 untouched).
Existing DENY rows that must stay: every #554 / #478 / #482 / #491 row in guard-followups-492 / -483 / guard-git; run those files whole.
Risk: loosens only commands AFTER a literal-exit failure group inside the same walked text; the caller-visible state is unchanged.

## 4. Document-only: #605 (all four cases) and #600 (~16 lines of docs)

#605 trace (each case traced to the exact rule and reproduced):

| Case | Rule that fires | Decision |
|---|---|---|
| 1. `node scratch.mjs`, the script FILE holds a comment `// ... <push to main>` | git guard `judgeScriptText`, kind `interp` (git-policy.mjs:1579-1584): `guardedCommandText(wholeFileText)` (guarded-text.mjs:27) splits on `[\n;&\|]`, so a comment line is its own segment and matches the push regex. File text, not `-e` text. | **Document only** (owner 11-20). Workaround: do not spell a guarded command in a script-file comment (paraphrase it, or put it in a Markdown note). Comment stripping needs the real interpreter family, a lexer for line terminators and string state; not worth the hole risk. |
| 2. `node -e` text holding "protect without --apply" | `catchAllReason` on the `-e` argument: exactly #563's deliberate scan (pinned at guard-git.test.mjs:1591-1597) | **Covered by #563, document only** |
| 3. `node -e "...$(( ... ))..."` refused as arithmetic | shell-parse `REFUSED_ARITH` (shell-parse.mjs:2260, #269 R18 "refuse, do not guess"), both guards; only in double quotes or an unquoted heredoc and only when the arithmetic holds a quote, `#`, backtick, backslash, `{` or `case` (probed: `node -e "xs.map($((x)=>x+1))"` DENY; single quotes or `<<'EOF'` ALLOW; `$((2 + 3))` ALLOW). The shell really expands that text. | **Document only**: single quotes or a quoted heredoc |
| 4. `${x:-(((` in a measurement script | not the arithmetic parser (that shape alone is ALLOW): files-policy.mjs:5999 `ARITH_CONTEXT` (`\(\(`, #266 R7-F3) on a line that ALSO names a protected path; probed DENY with `cat PP/VERSION; x=${y:-(((}` | **Document only**: put the path and the `((` on separate lines |

Docs: one short paragraph in docs/cli.md (guard section, next to the guard-files paragraph at :322) listing the four decided over-refusals with their workarounds (~10 lines). No code, no test (rule 6: no failure to name).

#600: docs/cli.md:1199 (the `--check` paragraph) gets one sentence: the ancestry is author-controlled (`git merge -s ours --allow-unrelated-histories` of the pipeline's history, or a non-squashed `git subtree add`), so together with
`ci.guard_checks: false` and a deleted `scripts/pipeline/` a consumer can make `--check` skip; no in-repo signal is unforgeable by whoever controls the tree and its history; no gate consumes `vendor --check`. The `guard_checks` flip and the deleted bundle show in
the PR's file diff, but forged ancestry is a history property and shows only in the commit graph (merge commits), not in a file diff. Stated limit, not hardened further. Also change the comment at pipeline/commands/vendor.mjs:114 ("cannot be
taken for the source by accident") to "by accident, not against an author who builds the history". Run `node --test test/docs-facts.test.mjs test/vendor.test.mjs`.

---

## Estimated non-generated changed lines

| Issue | Decision | Source | Test / docs | Total |
|---|---|---|---|---|
| #683 | fix (hook words + writer check); test helper and suite edits | ~14 | ~110 | ~124 |
| #610 #617 #618 #620 #624 | closed operand list + quote fix + pager heads | ~38 | ~37 | ~75 |
| #609 | fix (literal exit) | ~6 | ~34 | ~40 |
| #607 | pin only | 0 | ~3 | ~3 |
| #608 | pins only (3 rows incl. the literal-PATH fixture) | 0 | ~10 | ~10 |
| #605 | document only (cases 1-4) | 0 | ~10 docs | ~10 |
| #600 | docs only | 1 | ~5 | ~6 |
| **Total** | | **~59** | **~209** | **~270** |

Under the ~500-line / one-subsystem split bar (rule 5e).

## Out of scope / documented limits

- **#627 -> its own PR (owner 11-20).** Requirements from the Codex recheck for that PR (nothing of #627 is in this one):
  1. Arm the per-invocation deadline INSIDE the existing fail-closed boundary of each hook (guard-files.mjs's `try` around the policy import; guard-git's handler), never before it: a missing or broken budget module must still produce a valid DENY on stdout (test with the dependency unavailable at the real entry point).
  2. The lookup clamp must never pass 0 (Node treats `spawnSync` timeout 0 as unlimited) or a fractional number: when time is exhausted stop BEFORE spawning; otherwise pass a positive integer; keep the existing 3 s push-lookup limit; include the Windows `where` resolution (lib/proc.mjs:49) in the bound.
  3. Exhaustion must propagate distinctly from an absent config or ref: `defaultGitShow` returns null, `readConfigs` skips it, and `mode` can then return `none`, hiding a committed owner-approval config. Pin a timed-out lookup where the committed config is the only copy requiring owner approval.
  4. Shared-deadline tests where EARLIER fields SUCCEED after consuming time, a LATER field is reached, and a deadline DENY arrives before the external cutoff, through both real hooks; bounded parent harness; elapsed recorded through verdict and exit; an injectable monotonic clock for deterministic unit tests. A fake git that sleeps forever fails the first lookup and proves nothing about sharing.
  5. Design inputs: work limit 5 s of CPU from a default clock for BOTH guards (remove the `now = Date.now` default in `evaluateGitOnce`, git-policy.mjs:3693); one monotonic wall deadline per hook invocation (candidate 8 s of the 15 s hook timeout, pending measured evidence), shared across command fields and the diagnostic scan (files-policy.mjs:4331); process CPU can exceed wall (threads), so it is a work meter, never the safety bound.
- #624: only the `git log --grep` / `--author` / `--committer` values are data; `-S` / `-G` search patterns and every other quoted word on a git line naming a protected tree stay scanned.
- #617: the assignment-only form (`TITLE="...parallel..."; ls PP`) stays denied (a value may be run later); `npx` / `noglob` / `ssh` / package-runner lines with a quoted fan-out word stay denied; a quoted fan-out word in an argument to a NON-trusted file program (`node x.mjs "...xargs..."`) is now scanned; the trusted pipeline command keeps main's blanking for all its prose flags except `triage settle --test-cmd`.
- #610: a bare (unquoted) pattern word equal to `xargs` / `parallel`, and an `rg` / `grep` pattern after an option that may take a value, are not recognised.
- #620: a bare `R1/R2`-style argument is no longer read at all for the trusted command's `--built` / `--line`; for other commands it is scanned as text, not as a command name.
- #605: documented only. #608 and #607: not reproducible; pinned. #600: forged ancestry is a stated limit.
- #683: a text scan cannot see a name built at run time or a lib copy staged elsewhere; the scratch-file import is stopped by the writer, not by the hook (the repo's own tests import the lib).
- Pre-existing gaps closed incidentally by the quote fix and the pager-head line (listed so the owner sees the scope): `rg --pre` / `bat --pager` / `less` / `man` text on a line whose protected path is only on the producer side.

## What changed in revision 3 (recheck and owner decisions)

#627 removed (own PR; its recheck requirements kept above). #624 fixed narrowly (git log value options only, paired DENY rows). #605 case 1 document only; the comment-strip code and tests are gone. #683: no seam, no test exception;
authorized writes tested in child processes with the admin switch and a disposable HOME; first creation, unchanged bytes, ancestry-only denial; read-side fixtures write JSON directly and the three live-db suites plus db-refs.test.mjs are adapted to pass under CLAUDECODE=1.
Fan-out: PLAIN_WRAPPERS and the isReadOnly door are gone; only named operands are removed (pipeline `--built`/`--line`, rg/grep `-e` and leading pattern, git log `--grep`/`--author`/`--committer`); wrapper options, assignments and
forwarded arguments stay scanned; the INLINE_RUNNERS door is dropped; DENY rows for `/usr/bin/time -f`, forwarded compound arguments, pagers and producer-only git. #609: deferral only for a literal, unwrapped `exit` (written first word, `plainExit`, no spawn);
absolute helper paths; reason and location asserted; the external `time` fixture.

Revision 4 (Fable adversarial pass, "build after these edits"): #683 helper no longer spawns bin/pipeline.mjs (explicit tmp home, child entry, in-process writers listed, fake-ps positive); the trusted pipeline command keeps main's blanking for all its flags (only `triage settle --test-cmd` is scanned), needles only for the #617 shapes main denies; rg/grep/git operand rules only after a bare or `env`+assignments prefix (WSL DENY row); #609 caller rows use `git -C /work/repo push`, redefined-`exit` pin with a child-only fallback, intended-tightening pin; two useless fan-out DENY rows dropped; #683 prose-hit risk noted.
