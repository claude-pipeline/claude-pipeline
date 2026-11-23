# Live-db guard: a Supabase MCP server under another name (#687)

Base: origin/main 236deb18. Branch: agent/mcp-alias-server-guard. One PR, one subsystem (the live-db part of the files guard): one new small lib,
two edited source files, the existing test file, one doc paragraph.
Risk: high (guard core, `pipeline/hooks/**`; security: an owner-go bypass). Plan only: nothing is built yet.
Revision 3. Codex plan review 1 (fresh, high) → rev 2; Codex recheck (resume, medium; the one allowed) → rev 3: Sentry regression in the fallback,
same-name collisions across config sources, incidental text as identity, positive tests that could pass with the config route broken, unbounded
reads, a promised message the code would not give. No further Codex plan pass (owner rule: one recheck); the Fable plan pass reviewed rev 3
→ rev 4 (FINAL): Supabase markers in bridges / docker / env (F-P1), no precedence: every scanned entry must be identified as non-Supabase to skip 5d,
P and its ancestors scanned, names normalised (F-P2), tests that pin the config route per layer and the unset-env case (F-P2), host list narrowed,
actionable hint, drift and legacy-file limits (F-P3). Fable agreed with the 5d decision.

## The gap (reproduced at 236deb18)

`isSupabaseTool(tool, state)` (pipeline/hooks/lib/live-db-guard.mjs:31) judges an MCP tool as Supabase when ONE of:
1. the server segment matches `/supabase/i`;
2. the tool name is in `SUPABASE_ONLY_NAMES` (apply_migration, execute_sql, deploy_edge_function, create_edge_function_secret), on any server;
3. the server is in the owner's registry (`state.servers`);
4. the registry is unreadable (`state.ok === false`) and the name is in `SUPABASE_WRITE_NAMES`.

A missing registry is a valid empty one (db-refs.mjs:36). The other eleven write names (GENERIC below: run_notebook, create_branch, delete_branch,
merge_branch, reset_branch, rebase_branch, create_project, pause_project, restore_project, create_notebook, delete_notebook) are judged only by 1, 3, 4.
So the real Supabase MCP server added under an innocent name passes those eleven as ordinary tools: files-policy.mjs:934 returns the generic decision,
which only looks for protected file paths.

Probe (scratch script calling `evaluateFileTool`, empty home, no registry):

| tool | input | today |
|---|---|---|
| mcp__mine__merge_branch | {branch_id} | **allow** (merges a branch's migrations into production) |
| mcp__mine__reset_branch | {branch_id, migration_version} | **allow** |
| mcp__mine__pause_project | {project_id} | **allow** (takes the live app down) |
| mcp__mine__run_notebook | {project_id, notebook_id, expected_updated_at} | **allow** (runs saved SQL cells, writes included) |
| mcp__mine__create_project | {name, region, organization_id} | **allow** (billing) |
| mcp__mine__execute_sql | {project_id, query} | deny (rule 2) |
| mcp__github__create_branch | {owner, repo, branch} | allow (must stay) |
| mcp__neon__delete_branch | {projectId, branchId} | allow (must stay) |
| mcp__gitlab__create_branch | {project_id, branch, ref} | allow (must stay) |

Existing acceptance rows that must stay (test/live-db-guard.test.mjs:177–182, through `evaluateFileTool`): `mcp__github__create_branch {branch}` allow,
`mcp__sentry__create_project {name}` allow, `mcp__supabase__create_branch {name}` deny; and :139's name-only rows.

## Supabase MCP schema evidence

Read from the server source, supabase-community/supabase-mcp (now served as supabase/mcp) main at 03afe8e7a021b13d1611c8b7dc77e1144fa044da
(2026-11-23; npm `@supabase/mcp-server-supabase` latest 0.19.0), packages/mcp-server-supabase/src/: tools/branching-tools.ts, account-tools.ts,
notebook-tools.ts, util.ts (`injectableTool`), tool-schemas.ts (`PROJECT_SCOPED_OVERRIDES`), server.ts; cross-checked against the live tool
definitions of the account-scoped server loaded in this session. (The files were read minutes before the SHA was taken; the implementer re-reads
the five tool files at that SHA and fixes the table if it differs.)

| name | account-scoped input (req; optional) | project-scoped (`--project-ref`) |
|---|---|---|
| create_branch | project_id; name (default 'develop'), confirm_cost_id* | project_id removed: {name?, confirm_cost_id*} (may be `{}`) |
| delete_branch, merge_branch, rebase_branch | branch_id | same |
| reset_branch | branch_id; migration_version | same |
| create_project | name, region, organization_id; confirm_cost_id* | not exposed (account tools only when unscoped) |
| pause_project, restore_project | project_id | not exposed |
| run_notebook | project_id, notebook_id, expected_updated_at; cells | project_id removed |
| create_notebook | project_id, name, content; description | project_id removed |
| delete_notebook | project_id, notebook_id | project_id removed |

\* `confirm_cost_id` is required in the base schema and omitted for clients that support confirmation forms (that is why the live schema lacks it).
The schemas are plain zod objects: **unknown keys are stripped, not rejected**. So an input's key set is evidence about a server, never proof.

## Fix: rule 5 — the active session's MCP configuration first, the input shape only when the server cannot be identified

Rule 5 in live-db-guard.mjs, asked only when the name is GENERIC and rules 1–4 did not match. Nothing is read or listed before that point (Codex
recheck P2: no work on ordinary MCP traffic).

**5a. The session's sources** (no other account, no unrelated `projects[*]` key: Codex recheck P1-2):
- the session's account file: `$CLAUDE_CONFIG_DIR/.claude.json` when that variable is set, else `<home>/.claude.json`; in it the top-level
  `mcpServers` (user layer) and `projects[k].mcpServers` (local layer) for k = `P` and each ancestor of `P` (the key may be the git root or the launch
  directory: F-P2);
- `k/.mcp.json` (project layer) for k = `P` and each ancestor of `P`, up to the filesystem root;
- `P` = `$CLAUDE_PROJECT_DIR` of the hook's environment (Claude Code sets it for hooks; already relied on in dialog-hooks.mjs:480). Unset ⇒ the
  local and project layers are UNKNOWN.

Server names are compared normalised: a config key with every character outside `[A-Za-z0-9_-]` replaced by `_` equals the tool's server segment
(F-P2). Each file: regular file only (`lstat`, no symlink follow), at most 8 MB, JSON parse; the account file is read once; at most 1 + depth(P)
`.mcp.json` stats (Codex recheck P2 bounds). A file that exists but cannot be read / parsed / is too big, or a legacy `$CLAUDE_CONFIG_DIR/.config.json`
next to the account file, makes that layer UNKNOWN (F-P3).

**5b. Identify each entry** (by transport; Codex recheck P2-3 and F-P1):
- SUPABASE when any of: `url`, or any `args` element that parses as a URL, has hostname `mcp.supabase.com` or `api.supabase.com` (covers the
  `mcp-remote` bridge); `command` or an `args` element, with any `@version` suffix removed, is the package `@supabase/mcp-server-supabase`, or a path
  segment of it is exactly `mcp-server-supabase` (bin, local build); an `args` element, tag removed, is the docker image `mcp/supabase`
  (or `<registry>/mcp/supabase`); `env` has the key `SUPABASE_ACCESS_TOKEN`.
- OTHER when: not SUPABASE, and `url`, `command` and every `args` element are literal (no `$`/`${…}` expansion).
- UNRESOLVED otherwise (an expanded endpoint or launcher).

**5c. Decide** (no precedence model: F-P2):
- Any scanned entry for the name is SUPABASE ⇒ Supabase (also when a layer is UNKNOWN: a positive match wins).
- At least one entry found, every one of them OTHER, and no layer UNKNOWN ⇒ not Supabase; the generic decision stands (a configured vendor is never
  judged by shape: Codex P1-2). An agent-added vendor entry cannot hide a Supabase one: the Supabase entry still triggers the first bullet.
- Otherwise (no entry: plugin servers `plugin_<p>_<s>`, claude.ai connectors `claude_ai_<x>`, `--mcp-config`; a layer UNKNOWN; an entry
  UNRESOLVED) ⇒ **5d**.

**5d. Shape fallback.** Supabase when `ti` is a plain object whose own keys are all within the name's key set AND include the required keys of at
least one of its modes:

| name | key set | required (account / project-scoped) |
|---|---|---|
| create_branch | project_id, name, confirm_cost_id | {project_id} / {} |
| delete_branch, merge_branch, rebase_branch | branch_id | {branch_id} |
| reset_branch | branch_id, migration_version | {branch_id} |
| create_project | name, region, organization_id, confirm_cost_id | {name, region, organization_id} / — |
| pause_project, restore_project | project_id | {project_id} / — |
| run_notebook | project_id, notebook_id, cells, expected_updated_at | {project_id, notebook_id, expected_updated_at} / {notebook_id, expected_updated_at} |
| create_notebook | project_id, name, content, description | {project_id, name, content} / {name, content} |
| delete_notebook | project_id, notebook_id | {project_id, notebook_id} / {notebook_id} |

Sentry's `create_project {name}` lacks region and organization_id ⇒ not Supabase (Codex recheck P1-1). A key outside the set ⇒ not Supabase
(GitHub, GitLab, Neon, Jupyter rows).

**Owner decision taken in this plan (Codex recheck P1-1, "incompatible outcomes"):** for a server the active configuration cannot identify (5d), an
input identical to a Supabase write (e.g. a plugin's `delete_branch {branch_id}`, a connector's `create_branch {name}`) is DENIED. Reason: the guard's
standing rule is that what it cannot identify is refused (live-db-guard.mjs Task 5 comment), a wrong allow here can merge migrations into
production or pause the live app, while a wrong deny costs one owner-run call. The deny says how it was recognised (below), so a false one is
visible. The Fable pass and the owner may overturn this; the alternative is allowing 5d entirely (no fallback), which leaves plugin / connector /
`--mcp-config` aliases open.

**What a recognised call then gets** (unchanged `evaluateSupabaseMcp`, live-db-guard.mjs:141): no `project_id` (branch tools, create_project,
project-scoped calls) ⇒ "no well-formed project_id, so its target is unknown"; a `project_id` on an unlisted server ⇒ "not one the owner trusts …
`db-refs server add <seg>`"; a registered server on an owner-declared dev ref ⇒ allow; registered on a live ref ⇒ "not allowed on the live database …
the owner does this in the dashboard". Order unchanged.

**Recognition hint (Codex P3).** `supabaseMatch(tool, state, ti, ctx)` returns `'name' | 'only-name' | 'registry' | 'registry-broken' | 'config' |
'shape' | null`; `isSupabaseTool` stays its boolean wrapper. files-policy appends to a deny from rule 5: for `config`: " (recognised as Supabase from
this session's MCP configuration of server <seg>)"; for `shape`: " (recognised as Supabase by its input only, because this session's MCP
configuration does not identify server <seg>; if it is not a Supabase server, the owner runs this call in a session started with the admin
switch, which skips this check)". files-policy.mjs:935 already allows every MCP call under the owner's admin switch (F-P3). The hint names the switch
in words only (a literal assignment of it in a written file is refused by the guard). Tested.

### Changes
1. New `pipeline/hooks/lib/mcp-servers.mjs` (~80 lines): `activeBinding(segment, { home, env, readFile })` → `{ layers: [{ layer, state:
   'absent'|'found'|'unknown', entry? }] }` and `identify(entry)` → `'supabase'|'other'|'unresolved'`. `readFile` is a seam for tests (default: lstat
   regular file ≤ 8 MB, read, parse).
2. `live-db-guard.mjs`: `GENERIC_SIGNATURES` (5d table), `supabaseMatch`, `isSupabaseTool` as `!!supabaseMatch(...)` with an optional 4th `ctx`
   (without ctx, rule 5 is skipped: existing `(tool)` / `(tool, state)` calls keep their answers); rewrite the comment above `SUPABASE_ONLY_NAMES`.
3. `files-policy.mjs:934`: `supabaseMatch(tool, readDbRefs(home), ti, { home, env: opts.env ?? process.env })`; the hint appended to a deny from
   `evaluateSupabaseMcp` when the match is `config` / `shape`. No account-dir enumeration (`accountConfigDirs` is not used).
4. `docs/cli.md` live-database section (:1393): one paragraph: a server not named supabase is recognised when this session's MCP configuration
   points it at Supabase (endpoint host or package), or, when the configuration cannot identify it, when a write tool's input has only Supabase's
   fields; recognised is not trusted (`db-refs server add`); the limits below.

### Alternatives rejected
- **Protect MCP configuration from agent writes** (issue's first suggestion): many surfaces (`.mcp.json`, every account's `.claude.json`, rewritten
  by Claude Code itself, `claude mcp add|add-json|remove`, plugins, `--mcp-config`), false-refusal risk on files Claude Code writes, and it misses a
  server configured before the protection. Recognition at the call covers every route that ends in a configured server.
- **Input shape alone** (rev 1): cannot tell two configured vendors with the same input apart; kept only as 5d.
- **All config files pooled** (rev 2): attributes a call to another project's / account's same-named server (Codex recheck P1-2).
- **Judge every GENERIC name on every server**: denies GitHub/GitLab/Neon/Sentry/Linear tools pinned as allowed (test :139, :177).

### Limits (in the code comment and the doc; not fixed here)
- A deliberately disguised server (a local proxy or wrapper script launched by a literal command with no Supabase marker, renamed parameters, a
  foreign key added to a 5d call) is out of the guard threat model (pipeline.yml `threat_models.guards`).
- A `--mcp-config` or managed server that shadows a same-named entry of the session's own files is identified by that entry.
- Schema drift: a new optional Supabase key makes a real call fail the 5d key-set test on an unidentified server (no worse than main). The
  implementer adds a comment by `GENERIC_SIGNATURES` naming the source SHA / package version to re-check on a bump (F-P3).
- An unidentified ancestor-directory Supabase entry of the same name over-denies a vendor server (positive match wins); rare and visible by its hint.
- 5d over-denial of an unidentifiable vendor tool with a Supabase-identical input (decision above); #598 tracks vendor collisions generally.
- #584 (registered alias with a broken registry, tools outside the write list) stays its own issue.

## Tests (bug fix ⇒ failing test first)

A NEW `test(...)` block (or two) in `test/live-db-guard.test.mjs`, own fixture: temp home, NO registered server, `env` with `CLAUDE_PROJECT_DIR` =
a temp project dir DIFFERENT from the hook `cwd` (Codex recheck validation), entry `evaluateFileTool`. "FAILS" = fails on main.

1. Config, user layer (FAILS): `<home>/.claude.json` `mcpServers.mine = {type:'http', url:'https://mcp.supabase.com/mcp?project_ref=x'}`. Every
   GENERIC name with minimal and full input (optional fields incl. `confirm_cost_id`) ⇒ deny; reason per target state (`target is unknown` /
   `db-refs server add mine`) plus the `config` hint. One input with an extra benign key (`merge_branch {branch_id, note}`, which 5d would decline)
   ⇒ still deny: proves the config route itself (Codex recheck validation).
2. Config, local + project layers (FAILS): `projects[<P>].mcpServers.mine` stdio `npx -y @supabase/mcp-server-supabase@0.19.0 --project-ref=x`;
   separately `projects[<parent of P>]` (git-root keying); separately `<P>/.mcp.json` and `<parent of P>/.mcp.json`. Per layer: project-scoped
   inputs `create_branch {}`, `create_branch {name}`, `run_notebook {notebook_id, expected_updated_at}`, `delete_notebook {notebook_id}`,
   `create_notebook {name, content}` ⇒ deny with the `config` hint, plus ONE extra-key row (`merge_branch {branch_id, note}`) ⇒ deny (F-P2: proves
   each layer's lookup, not 5d). Config key `db.prod` matches segment `db_prod`.
   `CLAUDE_CONFIG_DIR` opposing fixtures (F-P2): home `.claude.json` has a literal vendor `mine`, the account dir has Supabase `mine` ⇒
   `{branch_id, note}` deny; swapped ⇒ allow.
3. Collisions (Codex recheck P1-2): (a) `projects[<unrelated dir>].mcpServers.db` = Supabase, the session's `db` = a vendor `{command:'node',
   args:['vendor-mcp.js']}` ⇒ `mcp__db__delete_branch {branch_id}` allow; (b) another account dir's `.claude.json` with Supabase `db`, the session
   has no `db` ⇒ 5d: `{branch_id}` deny with the `shape` hint, `{branch_id, strategy}` allow; (c) project `.mcp.json` vendor `db` plus a user-layer
   Supabase `db` ⇒ deny (positive match wins); (d) `CLAUDE_PROJECT_DIR` unset, user-layer vendor `db`, `{branch_id}` ⇒ deny via shape (F-P2: unset
   is UNKNOWN, not absent).
4. Identity (Codex recheck P2-3, F-P1): SUPABASE rows: `npx -y mcp-remote https://mcp.supabase.com/mcp`; `docker run -i --rm mcp/supabase:latest`;
   `node /x/mcp-server-supabase/dist/transports/stdio.js`; a vendor-looking command with `env.SUPABASE_ACCESS_TOKEN` ⇒ each deny on `{branch_id, note}`.
   OTHER rows: `node /work/supabase-tools/vendor.js` (incidental path) and url `https://myref.supabase.co/functions/v1/my-mcp` (owner's own
   function, host not listed: F-P3) ⇒ allow. UNRESOLVED: url `${MCP_URL}` ⇒ 5d. A `.config.json` beside the account file ⇒ UNKNOWN ⇒ 5d.
5. Fallback 5d (FAILS where Supabase-shaped): unlocated `mcp__plugin_x_db__merge_branch {branch_id}` ⇒ deny + `shape` hint; probe-table vendor rows and
   `mcp__sentry__create_project {name}` ⇒ allow; corrupt `.claude.json` + `mcp__vendor__delete_branch {branch_id}` ⇒ deny; corrupt project
   `.mcp.json` + user-layer Supabase `mine` ⇒ deny (positive match with an unknown layer).
6. Unit rows: `isSupabaseTool` without ctx keeps today's answers (existing rows untouched); `ti` null / array / string ⇒ 5d says no; a 9 MB or
   symlinked `.claude.json` ⇒ UNKNOWN layer.
7. Controls unchanged: registered-server block (live deny, dev allow), the :177 vendor block, the go-consumption test (:245).

Run the focused file explicitly (`node --test test/live-db-guard.test.mjs`), then `node scripts/verify.mjs --quick`. The implementer runs the probe
table before and after: only the five **allow** rows of the gap may change.

## Review plan

Codex plan review (fresh, high), its one recheck, and the one Fable plan pass are done; rev 4 is FINAL. Next: build through the review skill
(Codex rounds + Fable arbiter per pipeline.yml, high risk).
