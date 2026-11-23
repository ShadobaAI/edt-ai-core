# Full-payload policy calls

Use this form when validation cannot use session refs or requires the full
YaXUnit ledger. Follow the shared [requirements workflow](requirements.md)
for subject, phases, evidence, discovery and selection freshness. Field details
come from the live schemas and [policy protocol](../../../policy/README.md).

## Detection and selection

1. For standalone detection call `policy.detect_1c_mechanisms` with `sourceRef`,
   assessments and
   `format: compact`. All critical mechanisms come from the live tool schema.
   Each assessment needs `status: present|absent|unknown` and nonempty evidence.
   Supply assessments instead of `sourceText`.
2. Pass the complete `compact-v1` response to `policy.select_1c_requirements` as
   `detection`, with target, artifact, operation, the union of explicit/classified
   mechanisms and `additionalRequirements`: an array of `{selector, strength, basis}`
   from applicable v8std results. For metadata include affected permissions,
   write/delete events, migration and rename/delete mechanisms.
3. Retain the full selection: registry schema/version, kind, target, artifact,
   operation, effective mechanisms, `mandatory`, `recommended`, `digest`,
   `matchedRows`, source reference and `additionalRequirements`. An existing
   full selection from `assess_1c_requirements` can serve the same scope and applicability.

With `status: unavailable, reason: registry_coverage_missing`, no selection or
digest exists for compliance. Do not pass that response to `validate_compliance`,
invent a digest or treat the missing rows as an exemption. Use
`uncoveredMechanisms` to explain the gap.

## Full ledger

After assessing the exact requirements, call `policy.validate_compliance` with
`phase`, retained `selection`, full `ledger` and the assessment for this phase
in `current`. Pass `current.target`, `artifact`, `operation`, `sourceRef`,
`mechanisms` and current `additionalRequirements` including basis. For oneC,
include the complete `detection` with the same `sourceRef`. Target, artifact and
operation must match the selection. For a change, bind proposal and result to
their respective state and the original baseline.

Each ledger row belongs to one selected selector and contains only:
`selector` (exact normative selector, not registry row ID), `selection_digest`
(selection `digest`), `target`, `source_ref`, `status`, `evidence` and, for
deviations, `reason`. `target` matches selection/current; `source_ref` matches
`current.sourceRef`. Text fields are nonempty. Row statuses are `passed`, `failed`,
`unverified`; only recommended also permits `deviated` with a substantive reason.
`compliant`, `satisfied`, unverified `passed`, duplicates, extra fields and omitted
requirements are forbidden.
Evidence binds a specific requirement condition to a verified target. A
structured `status: blocked` with `unresolved` can accompany `isError: false`.
MCP errors indicate invalid or inconsistent requests. Apply the shared workflow's
criteria to each response.

## YaXUnit

Pass the live schema's test mechanisms and applicable additions to
`policy.select_yaxunit_requirements`. Use the same full ledger contract for
the test patterns. A run/report-only `not_applicable` response with
`authoring_not_requested` has no digest and cannot be passed to ledger validation.
