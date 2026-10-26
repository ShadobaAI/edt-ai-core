# Assessing diagnostic findings

EDT remains primary validation and the source of live model/metadata. This assigns
authority, not guaranteed truth to every finding. BSL LS serves focused analyzer
questions, including disputed EDT findings when the required rule/context is
supported. Neither source has a blanket status of “100% proven error” or
“complete guarantee of no errors.”

## Context and settings

For substantial findings retain source and rule code, severity/type,
repository/EDT project, checked artifact revision or hash and relevant analysis
context. When environment-dependent, establish analyzer version,
platform/compatibility, metadata/type-information availability and effective
settings for the specific rule. Do not assume code-style warnings mean runtime
errors or that type `error` excludes false positives.

BSL LS depends on enabled rules, their parameters, root and available project
information. Configuration failure/incomplete context is a separate cause of a
result. Change settings only under an authorized configuration task; do not disable
rules or alter thresholds merely to pass checks.

## Classification

| Assessment status | Basis |
| --- | --- |
| Confirmed defect/violation | The specific rule condition is checked against current code/metadata and applies to this scope. For behavioral defects, state the scenario and consequence. |
| False positive / not applicable | The rule condition does not hold or an analyzer limitation in this context is proven; retain a specific explanation and evidence. |
| Configuration/coverage problem | Wrong root/version/settings or unavailable required metadata, types, revision or completed analysis result. |
| Uncertain | Insufficient data for the preceding conclusions; retain the gap and stop only the dependent conclusion/action. |

Novelty relative to baseline is a separate property, not a confidence level.
Compare results for comparable scope/settings/versions, accounting for line shifts.
Changed settings or models alone do not prove a code regression.

For large projects assess the changed scope and directly affected enclosing
contracts. The project's full findings list is not an acceptance criterion for a
local change. Unaffected legacy and out-of-scope noise do not require mass fixes
or project-wide revalidation. A stale/incomplete model limits coverage; project
size alone does not prove an individual finding false.

Absence of the same message from another analyzer does not refute a finding:
rule coverage and available context differ. Choose additional checks by missing
fact: exact normative text through v8std, source/types through assigned
EDT/index/analyzer, focused tests if required and authorized.
Do not automatically run both analyzers for every finding.

A proven false positive does not require pointless changes to working code.
Do not hide it from the report or present it as a fixed defect. A new unresolved
substantial finding in affected scope or unreliable mandatory verification
prevents confirmation of full completion. An EDT/BSL LS message alone does not
automatically populate the normative ledger with `failed`; rule applicability
must be assessed. If exact mandatory text literally prohibits every new message
without a false-positive exception, retain the discrepancy with this workflow and
resolve it under $1c-standards. Do not independently rewrite the requirement as
`passed`.

## Documented BSL LS limitations

Official descriptions explicitly allow false positives, including
[LogicalOrInTheWhereSectionOfQuery](https://1c-syntax.github.io/bsl-language-server/diagnostics/LogicalOrInTheWhereSectionOfQuery/)
and [DenyIncompleteValues](https://1c-syntax.github.io/bsl-language-server/diagnostics/DenyIncompleteValues/).
Check description applicability to the installed version. Strong confirmation of
one finding does not become a universal guarantee for every rule.
