# cp #944: every ruling dialog can show a recommended button (BLOCKING items and Reject included)

## In plain English
When the pipeline asks the owner to rule on a review finding, the click dialog should always put Claude's
recommendation first as "<button> (Recommended)", so the owner clicks it and never has to type. Today the pipeline
refuses to recommend for a BLOCKING finding and has no way to recommend Reject, so Claude either shows a neutral
dialog or edits it by hand, and an edited dialog is refused when clicked (the owner then has to type the ruling).

## What a click may record does not change
A ruling click records exactly what the owner could already record by clicking the same label on the neutral
`ruling-v1` dialog (`Reject all` is on every ruling dialog today) or by typing `ID: reject`. This change only adds
dialogs whose button ORDER and "(Recommended)" label differ, plus one fixed recommendation row. `owner-ruling`'s
guards (`ownerRulingRefusal`, `applyOwnerRuling`, the content digest, provenance) still decide every recorded ruling.
No guard is relaxed; the only owner-ruling change is that the click-time recheck, today only for the dialog that
claims low severity, now also covers the new recommended-dismissal dialogs (3c): it can only refuse more.

## Design

### 1. Why texts stay fixed codes (no free text)
The #944 issue asks for a free-text `--why`. Rejected: the hook rebuilds each ruling dialog from installed text and
refuses anything else (`dialog-differs` / `unknown-dialog`); a free-text row would let controller prose argue for
another button inside a hook-trusted dialog (the cp #771 reason for fixed codes). Instead the code set grows so every
decision has a fitting code. Claude's longer reasoning still goes in the reply above the dialog.

New codes in `RULING_WHY` (existing texts byte-identical; a pinned text is never edited):
(Worded to read right for one item or several, since one row covers the whole batch.)
- `follow-up`/`fix-separately`: "Claude rates each item worth fixing, but not in this PR (it was there before, or
  lies outside this change); its own issue keeps it tracked. This is Claude's rating, not the pipeline's severity
  check."
- `reject`/`not-a-bug`: "Claude checked the code for each item: what it describes does not happen, so there is
  nothing to fix."
- `reject`/`already-handled`: "Claude checked the code for each item: another part of the code already prevents
  what it describes, so a change here adds nothing."
- `reject`/`no-user-impact`: "Claude checked the code for each item: what it describes can only happen in a case
  users never reach (for example while an update is being installed), so it is not worth changing."
`RULING_DECISION_WORD` gains `reject: 'Reject'` (row: `Claude recommends Reject all (when asked): …`).

### 2. Dialog variants (`pipeline/hooks/lib/owner-go-click.mjs`)
Each variant now names the codes whose row it may carry (`codes`), so the hook checks the row per VARIANT, not per
decision:
- `ruling-v1`: unchanged (no row).
- `ruling-v2-accept`: unchanged; codes `real-problem`, `unclear-safe`.
- `ruling-v2-follow-up`: unchanged; codes `minor-later` only (the one row that claims "the pipeline rates it low").
- NEW `ruling-v2-follow-up-any`: same order and labels as `ruling-v2-follow-up`; codes `fix-separately` only.
- NEW `ruling-v2-reject`: order reject, accept, followUp, notNow; `Reject all (Recommended)`; answer words unchanged
  (`ID: reject` per asked id); codes `not-a-bug`, `already-handled`, `no-user-impact`.
`installedParts` accepts a v2 ask only when its one row is `rulingWhyRow(decision, code)` for a code of THAT
variant (so a `minor-later` row under `-any`, a `fix-separately` row under `ruling-v2-follow-up`, or any accept /
follow-up row under `ruling-v2-reject` is an unknown dialog). Export `rulingVariantFor(decision, code)` -> variant id
or null, the CLI's only way to pick a variant. The comment "Reject is never recommended" is replaced.

Why a second follow-up id instead of one id with two codes: a click record keeps the ask's `variant`, not its row,
and `owner-ruling` rechecks low severity for answers on the dialog that CLAIMED low severity. Keying that on a
separate id keeps the claim checkable without reading the (possibly expired) ask file.

### 3. Who may be recommended what (`pipeline/lib/triage.mjs#rulingRecommendationRefusal`)
New signature `(items, decision, ctx, code)`; `decision` ACCEPT | FOLLOW-UP | REJECT; `code` is required for
FOLLOW-UP (no default: a missing code is a refusal, so an old caller cannot silently skip the severity rules).
1. Every id passes `ownerRulingRefusal(item, id, null, decision)` (unchanged: the click could record it).
2. ACCEPT: rule 1 only (unchanged).
3. FOLLOW-UP `minor-later`: the existing rules, unchanged (implemented refused, low severity, low-confidence cause or
   open deferrable ACCEPT).
4. FOLLOW-UP `fix-separately` and REJECT (the "Claude's own rating" dismissals), refuse unless EVERY item is either
   waiting for a human (`final.needsHuman === true`, whatever its final decision: a low-confidence arbiter ACCEPT
   waiting for a human is the main case) or, for `fix-separately` only, an open deferrable ACCEPT (`isDeferrableAccept`:
   the owner-raised deferral; the skill's "only when the OWNER raised it" rule guards initiation, exactly as it does
   for `minor-later` today). So a settled Claude / second-review / forced final, a round-cap deferral
   (`isRoundCapDeferral`) and any non-waiting final are refused, and Reject of any ACCEPT that is not waiting is
   refused. Then also refuse an item that:
   a. is `implemented` (a built fix would be dropped; R1-B3 extended);
   b. waits because of a malfunction cause (`MALFUNCTION_CAUSES`: re-run the judge/arbiter first, as
      `claudeRulingRefusal` says);
   c. has a second review whose decision is ACCEPT (a contrary verdict: the owner may still rule on the neutral
      dialog, Claude does not recommend against it);
   d. (`fix-separately` only) waits because its "same on base" scope was contradicted by the PR diff (the final's
      reason, `triage.mjs` ~196 / ~436: the pipeline has evidence it IS this PR's change, which the row would deny).
   No severity gate otherwise: BLOCKING, security and sensitive-path items waiting for a human may be recommended.
5. Fail closed: an unknown decision, or a FOLLOW-UP code other than `minor-later` / `fix-separately` (including
   undefined or a reject code), is a refusal; an unknown code never falls into a weaker branch.

### 3b. What the owner sees (disclosure)
Every ruling dialog's item summary row (`commands/triage.mjs` rulingRequest; unverified rows, the hook reads only the
last line and the one recommendation row) gains fields, additively: `ID · bucket · category · title · file:line`, then
the existing `deferNote` when it applies (kept: "ACCEPTED by …, NOT fixed; follow-up = defer the fix…"), then, only
when `final.needsHuman === true`, ` · waits: <needsHumanCause>: <final.reason>`, and when a second review exists
` · second review: <decision> (<confidence>)`. So a recommended dismissal of a `SUGGESTION` in `data-loss`, or of an
item waiting for an unknown cause, shows why the pipeline escalated it. EVERY new field goes through `oneLine` (a
stored value with a newline would otherwise break the question's line structure and kill the click). The `notes`
output is unchanged. (The question stays far below the ask-file size limit `issueAsk` enforces.)

### 3c. Recheck when the click is applied (`commands/triage.mjs` owner-ruling)
The existing recheck generalises from one variant to every recommended-dismissal variant. A matching answer record
carries a claim ONLY when the decision being recorded equals its variant's recommended decision (FOLLOW-UP on
`ruling-v2-follow-up` / `-follow-up-any`, REJECT on `ruling-v2-reject`); an answer choosing another option (a click on
the non-recommended Accept, or other words typed into "Other") is independent evidence, like a neutral click, and is
never rechecked (as today: the existing test that allows Accept on a stale `ruling-v2-follow-up` dialog stays). For a
claiming record, by its own `ask.variant`: `ruling-v2-follow-up` ⇒ `recommendationRefusal(…, 'follow-up',
'minor-later')` (explicit code; unchanged behaviour and refusal message byte-identical);
`ruling-v2-follow-up-any` ⇒ (…, 'follow-up', 'fix-separately'); `ruling-v2-reject` ⇒ (…, 'reject', 'not-a-bug')
(rule 4 does not depend on which reject code). Each over that record's own batch of still-waiting items (same
`itemsFor` selection as today). Refuse only when EVERY matching answer is a claiming record and every one is stale (a
typed answer, a neutral click, a non-recommended choice, or one still-valid record keeps the ruling). The new variants
get their own refusal message. Refusal leaves the state untouched and says to ask again.

### 4. CLI (`pipeline/commands/triage.mjs` ruling-request)
`--recommend accept|follow-up|reject --why CODE`; usage errors list the codes of that decision. The command helper
`recommendationRefusal({…, recommend, code})` maps three ways (accept→ACCEPT, follow-up→FOLLOW-UP,
reject→REJECT) and reads the reviewed diff and trusted base config ONLY for `follow-up`/`minor-later` (so an
unreadable diff never refuses a reject or `fix-separately`). `dialogVariant = rulingVariantFor(recommend, why)` when
shown. Output fields unchanged in shape. Usage text and `docs/cli.md` updated verbatim (a test keeps them in sync).

### 5. Several items needing different rulings (#944 item 4)
No new mechanism: one `--recommend` still covers all asked ids. When the items need different rulings, the skill
asks ONE id per dialog, in sequence (ask, click, `owner-ruling`, next id). A new ask for the same PR supersedes an
unanswered older one, so the next ask is issued only after the previous one was answered and applied.

### 6. round-request (#944 item 5): confirm only
`issuedRoundVariant` gives `round-v1` only when no recommendation was computed or the `PIPELINE_ROUND_DIALOG=legacy`
lever is set; every other round dialog has its recommended first option, except `round-v2-chosen` (after a trip-wire
process review the owner already chose one more round: `Yes, one more round (your choice)`, deliberately no
"(Recommended)"). No change.

### 7. Skill text (ships with cp)
`skills/review/reference/owner-merge.md` (Recommend first paragraph) and any "no reject" line in
`park-and-rulings.md`. The skill decides BEFORE issuing a dialog: probe with `ruling-request --recommend … --why …`
WITHOUT `--ask` (it reports `recommendRefused` and issues nothing), then issue once with `--ask` and pass
`ask.questions` to AskUserQuestion unchanged. Never edit the dialog (an
edited dialog is refused and the owner has to type). On `recommendRefused`, the ask is not shown; choose by the reason:
- `minor-later` refused for severity ⇒ `fix-separately` when Claude's research supports it;
- a malfunction cause ⇒ re-run the judge/arbiter (`arbiter needed`), not an owner ask;
- an implemented item, an ACCEPT final, a contrary second review, or a decision owner-ruling cannot record ⇒
  recommend a decision that IS allowed when Claude's research supports it; otherwise run it with no `--recommend`
  (neutral dialog) and say in the question's lead-in reply line that no recommendation is allowed and why.
Never re-ask the same id with a different recommendation Claude does not actually hold. Codes listed with one line
each. Mixed rulings ⇒ one id per dialog in sequence (5).

### 8. Rollout and rollback
Issuer and verifier ship in the same installed tree (`pipeline update` installs both), so a new variant is never
issued by a build that cannot verify it. Downgrading after asks were issued: an outstanding `ruling-v2-reject` /
`-follow-up-any` ask becomes invalid (the click is refused, the owner types the ruling); a click already recorded but
not yet applied by `owner-ruling` fails its provenance reread (re-ask on the old build). Rulings already applied to
the review state are unaffected. Old dialog and row pins stay byte-identical.

## Tests (each names its failure; extend existing files)
- `test/click-ask-commands.test.mjs`:
  (a) a BLOCKING waiting-for-human item with `--recommend reject --why not-a-bug` gets `ruling-v2-reject`, first
      option `Reject all (Recommended)`, row before the closing line, action `R6-B1: reject` — fails today
      (usage error: no reject).
  (b) a BLOCKING item with `--recommend follow-up --why fix-separately` gets `ruling-v2-follow-up-any` — fails today
      (recommendRefused: not low severity); `minor-later` on it is still refused, and the refusal names
      `fix-separately`.
  (c) `--recommend reject` on a deferrable arbiter ACCEPT is refused (rule 1) with the `ruling-v1` dialog.
  (d) usage errors: a reject code under follow-up, `fix-separately` under accept.
  Items for (a) and (b): a BLOCKING item with `final: {decision: 'ACCEPT', by: 'arbiter', needsHuman: true, cause:
  'low-confidence'}` (the #2720 shape), and one with cause `security-dismissal`.
  (e) refusals (each with `ruling-v1` and `recommendRefused`), for reject AND `fix-separately` where both apply:
      an implemented waiting item; a protected (forced) ACCEPT that is not waiting; a round-cap deferral; an item
      whose second review says ACCEPT; a malfunction-cause item; `fix-separately` on a contradicted-scope item;
      reject on an open deferrable arbiter ACCEPT. Allowed twins: `fix-separately` AND `minor-later` (low severity)
      on an open deferrable ACCEPT; `fix-separately` on a BLOCKING open deferrable ACCEPT (the owner-raised deferral).
  (e2) `rulingRecommendationRefusal(items, 'FOLLOW-UP', ctx, code)` with code undefined, `not-a-bug` or unknown refuses.
  (f) an unreadable reviewed diff / base config does not refuse `reject` or `fix-separately` (it still refuses
      `minor-later`).
  (g) the summary row shows category, waiting cause and second-review verdict for a non-BLOCKING `data-loss` item.
- End to end (`test/cli-triage-claude.test.mjs`, a real CLI-issued ask through the hook fixture, not `typedFor`):
  for `ruling-v2-reject` (BLOCKING item) and `ruling-v2-follow-up-any` (BLOCKING item): issue with
  `ruling-request --ask`, pass the returned dialog unchanged to the PostToolUse fixture clicking the recommended
  label, then `owner-ruling` records the same decision and owner quote a typed answer records — the "button should
  work" failure (today the follow-up one is refused by the low-severity recheck, the reject one cannot be issued).
  Same with an edited dialog: nothing recorded, item untouched.
  One of the two (reject) also runs through the PENDING path (`test/owner-go-click-pending.test.mjs` fixture: pending
  pointer with variant and quotes, transcript arrives, settlement, then `owner-ruling`).
- Drift (`test/cli-triage-claude.test.mjs`, next to the existing batch-drift test): a click on `ruling-v2-reject`,
  then the item is marked implemented (still `needsHuman`) ⇒ `owner-ruling` refuses and the state is byte-identical;
  a typed `ID: reject` for the same item is still recorded; the old `ruling-v2-follow-up` stale refusal still fires
  with its message unchanged; a click on the non-recommended `Accept all` of a stale `ruling-v2-reject` dialog is
  recorded (twin of the existing follow-up-dialog test).
- Batch: a two-id `ruling-v2-reject` click where the sibling becomes a forced ACCEPT ⇒ id 1 refused, state unchanged;
  allow twin: after id 1 is applied (`by: 'owner'`), id 2 still records (the one-id-at-a-time path).
- Mixed records: a stale `ruling-v2-reject` record plus a neutral `ruling-v1` click with the same quote ⇒ recorded;
  two stale records on different recommended variants ⇒ refused.
- Disclosure (g) includes a multi-line stored reason: the question stays one line per item and the click verifies.
- The RULING_WHY policy asserts updated (codes per decision), existing texts pinned per code.
- `test/owner-go-click.test.mjs` / `owner-go-click-round-variants.test.mjs`: v2-reject and v2-follow-up-any dialogs
  pinned by sha256; a click on `Reject all (Recommended)` records `R1-B1: reject, …`; an edited v2-reject dialog
  (other row, free prose, a `minor-later` row under `-any`, a `fix-separately` row under `ruling-v2-follow-up`) is
  an unknown dialog / `dialog-differs`; `ruling-v2-reject` leaves the "bad ids" list.

Intended changes to pinned tests (the integrity check may flag them; the owner adds `test-change-approved` if so):
`RULING_VARIANT_IDS`, the `RULING_WHY` keys and whole-table pin (replaced by per-code pins, old texts unchanged), the
"no reject" asserts, `'ruling-v2-reject'` leaving the bad-ids list; the per-variant hash test's "all distinct" assert
(`owner-go-click-round-variants.test.mjs` ~654-657): `ruling-v2-follow-up-any` has the same options and actions as
`ruling-v2-follow-up` on purpose (only its row differs), so the test asserts that pair equal and the rest distinct,
and the hashed tuple stays `{header, options, actions}` (old pins unchanged); the whole-question pins in
`click-ask-commands.test.mjs` (~399, ~426) gain the category field.

## Out of scope
Free-text why; per-item recommendations in one dialog (file an issue only if one-id-per-dialog proves too slow).
