# Requirements workflow

Shared contract for design, change and change-focused review. Primary selection
uses v8std code/context capabilities. Bundled `policy/registry.json` defines a
baseline, not a closed list of applicable requirements. Use MCP `policy`, not a
manual copy of its table. It does not read files or make changes.
The current [policy 2.1 contract](../../../policy/README.md) separates agent
assessments, registry coverage and ledger consistency checks from proven compliance.

## Verification mode and subject

Choose the assigned mode first, then applicable phases. A review or test-run request
alone does not authorize fixes.

| Mode | Assessment subject | `phase` |
| --- | --- | --- |
| Design | Specific proposed solution and known context | `proposal` |
| Create/change | Baseline → proposal before writing; baseline → actual result afterward | `proposal`, then `result` |
| Review | Exact reviewed revision and its change relative to baseline | `result` |
| Run/report-only | Actual execution/report without authoring | Normative authoring workflow not required |

Baseline is the initial state obtained through assigned authorities.
Proposal is the designed state with specific changes, not a claim of completed
writing. It may be prepared in memory from authorized baseline facts; creating a temporary EDT object merely for detection is unnecessary. Result is the confirmed post-operation
state or exact reviewed revision.
In `sourceRef`, distinguish baseline, proposal and result and bind them to target,
revision/hash and authorized context. A nonexistent create target does not cancel
verification of the proposed object and its owner.

Detection describes mechanisms of **the assessed operation and affected context**.
Before writing account for added/deleted mechanisms using baseline and proposal;
afterward use the same baseline and actual result. For example, a planned first
query already requires `query_text: present` in proposal assessment.
`metadata_delete`, `metadata_rename` and `changed_signature` remain transition
facts after writing: absence of a deleted object does not make deletion absent.
Do not include unrelated code mechanisms merely because they share a module.

## Discovery, detection and selection

1. Establish artifact (`bsl`, `query`, `metadata`), operation (`design`, `create`,
   `change`, `review`), target and owning scope. Obtain minimal authorized
   baseline/result evidence from assigned EDT/code-index/BSL LS, including
   substantial enclosing context. Review sources must match the reviewed revision;
   the current model or another indexed revision does not replace it.
   Proposal evidence includes the specific proposal and verified baseline facts.
   Do not read protected source through generic filesystem.
2. Perform [v8std selection](discovery.md) for affected methods/queries; use context
   for design, metadata and conditions outside snippets. Decode useful
   diagnostic → standard relationships, assess candidates against exact text and
   retain exclusion reasons/uncertainty. Separately select applicable corporate
   rules and framework patterns in their collections if code-based selection lacks
   their types. The discovery contract defines corpus choice and Gherkin boundaries.
   Pass applicable requirements beyond baseline in `additionalRequirements`.
   Selection does not replace source assessment and is not a violation list.
3. Call `policy.detect_1c_mechanisms` with `sourceRef`, assessments and
   `format: compact`. All critical mechanisms come from the live tool schema.
   Each assessment needs `status: present|absent|unknown` and nonempty evidence.
   Policy does not accept `sourceText` or classify source independently.
   Comments, strings and method names do not prove mechanism semantics.
   `present` and `absent` require substantive artifact/transition assessment;
   unchecked facts remain `unknown`.
4. Pass the complete `compact-v1` response to `policy.select_1c_requirements` as
   `detection`, with target, artifact, operation, the union of explicit/classified
   mechanisms and `additionalRequirements`: an array of `{selector, strength, basis}`
   from applicable v8std results. Do not truncate coverage. Unknown facts,
   contradictions and incomplete assessments block selection. For metadata account
   for permissions, write/delete events, migration, rename/delete and other actually
   affected mechanisms rather than text alone.
5. Retain the full selection: registry schema/version, kind, target, artifact,
   operation, effective mechanisms, `mandatory`, `recommended`, `digest`,
   `matchedRows`, source reference and `additionalRequirements`.
   Baseline strength comes from the registry; addition strength is justified by
   text and bound to the digest. If multiple rules select one selector, read/check
   it once; mandatory takes priority over recommended. Target is the stable owning
   scope identity with project/component; `sourceRef` identifies the assessed
   phase's revision. Query-result processing does not imply query text in scope.
   Another target or design → create/change/review transition needs its own
   selection even with identical requirements. Reuse sufficient normative text.

With `status: unavailable, reason: registry_coverage_missing`, no selection or
digest exists for compliance. Do not pass that response to `validate_compliance`,
invent a digest or treat missing coverage as exemption from requirements.
`uncoveredMechanisms` lists mechanisms without suitable rows; general baseline
rules do not hide this gap. Existing rows do not prove complete registry coverage
of the corpus. Unavailable policy, unknown applicability or missing registry
coverage block dependent writes/compliance conclusions.
Additions expand selected requirements but do not close mapping gaps for declared
registry mechanisms. Bounded v8std search for missing requirements and partial
read-only reports of confirmed facts are allowed, but do not constitute successful
completion of the mandatory workflow.

## Exact text and proposal

6. Obtain every unread exact ID/heading through v8std. For
   `document-id#heading`, retrieve that exact section; for a general ID, obtain
   sufficient full text. Choose specialized pattern/API cards only when the live
   contract supports that collection. Do not reread sufficient text already
   obtained in context responses. Check `found=true`, selector correspondence
   and no truncation; finish necessary conditions/exceptions. Incomplete or
   conflicting mandatory evidence blocks dependent verification.
   Registry metadata does not replace normative text.
7. Compare the proposal, enclosing structure and caller impact against retrieved
   requirements. Before writing call `policy.validate_compliance` with explicit
   `phase: proposal`, retained `selection`, full `ledger` and `current`.
   `current` means the current assessment of **this phase**: baseline → proposed
   state for proposal, baseline → actual result for result.
   Pass `current.target`, `artifact`, `operation`, `sourceRef`, `mechanisms`,
   and for oneC a complete `detection` with the same `sourceRef`, plus current
   `additionalRequirements` (including basis). Target/artifact/operation must match
   selection. Do not substitute pre-change source detection for proposal detection.
   Resolve planned-mechanism conflicts with baseline `absent` by assessing the
   proposal, not removing the new mechanism from selection. Substantial proposal
   edits require updated assessments and, if applicability changes, selection
   and proposal ledger before the writer.

Each ledger row belongs to one selected selector and contains only:
`selector` (exact normative selector, not registry row ID), `selection_digest`
(selection `digest`), `target`, `source_ref`, `status`, `evidence` and, for
deviations, `reason`. `target` matches selection/current; `source_ref` matches
`current.sourceRef`. Text fields are nonempty. Row statuses are `passed`, `failed`,
`unverified`; only recommended also permits `deviated` with a substantive reason.
`compliant`, `satisfied`, unverified `passed`, duplicates, extra fields and omitted
requirements are forbidden.
Evidence binds a specific requirement condition to a verified target rather than
merely repeating a document ID. `failed` and `unverified` return structured
`status: blocked` with `unresolved`, not an MCP error. MCP errors mean invalid or
inconsistent requests. `blocked` prohibits dependent writes/full compliance
conclusions; read-only reporting of violations and gaps is allowed.
Mandatory `passed` and recommended `passed`/justified `deviated` return
`ledger_valid`: a consistent assessment record, not proof of evidence truth or
write permission. Do not invent `passed` to obtain that response.

## Result and freshness

8. After changing, assess the actual result and enclosing invariants. For M/H
   repeat detection using current evidence. L may reuse assessments only after
   verifying actual mechanisms and context are unchanged; references and ledger
   always update to the actual result snapshot. Added/deleted mechanisms,
   artifact/operation, registry version, corpus revision, relevant exceptions or
   contradictions require explicit applicability review. If code/context differs
   from the checked proposal, refresh v8std selection under the discovery contract.
   Changed additions also require new selection. When selection changes, retain
   the reason and obtain only new/invalidated requirements.
9. Check the result against retained full text and submit a new ledger with
   `phase: result` and actual `current`. With a new revision, update `source_ref`
   and substantive evidence in every row; old ledgers are rejected. Applicability
   may be reused with the same target/mechanisms. Proposal does not replace result.
   If a new mandatory condition is discovered after writing, do not claim
   completion: verify it and, if needed, perform a corrective change through a new
   proposal and guarded EDT workflow.

Do not repeat successful equivalent selection/retrieval/compliance within one phase
without invalidated evidence. Different phases always have separate verification.
EDT diagnostics, query validation and behavioral tests remain independent gates;
L/M/H does not reduce normative strength.

Read-only design verifies the proposed solution without mutation/launch; review
checks a fixed revision with `operation: review`, `phase: result`.
Review has no proposal; design has no executed result. Unavailable runtime does
not block available static conclusions or count as a passed check.
For partial verification explicitly list unchecked requirements and do not present
the report as a full compliance conclusion.

## YaXUnit

For authoring/design/review/debug/migrate also use
`policy.select_yaxunit_requirements` with target, operation, the union of actual
test mechanisms and additional applicable patterns from v8std selection.
Take mechanism names from schema rather than pattern IDs. Obtain exact patterns
through v8std and apply the same ledger/phase contract. BSL changes need both
general oneC requirements and test patterns; these are different selections, not
duplicate search. Run/report-only needs no authoring patterns and does not authorize
test changes. For `run/report`, the selector returns `not_applicable` with
`authoring_not_requested`, without digest; do not pass it to compliance.
This does not assess run results. The full YaXUnit authoring/runtime workflow remains
in $yaxunit-tests.
For general oneC selection use a supported operation: `design`, `create`,
`change` or `review`. Diagnostics without fixes use `review`; test fixes during
debug/migrate use `change`. Choose phases by the table above, not the skill name.

`validate_compliance` checks consistency of the declared ledger, digest, current
applicability and coverage. It does not read v8std or source or prove supplied
assessments true. The agent performs actual text/code verification; retain evidence
references and verification boundaries in the result.
