# Assessing diagnostic findings

EDT remains primary validation and the source of live model/metadata. This assigns
authority, not guaranteed truth to every finding. BSL LS serves focused analyzer
questions, including disputed EDT findings when the required rule/context is
supported. Neither source has a blanket status of “100% proven error” or
“complete guarantee of no errors.”

Assess findings against the task and the applicable
[engineering quality criteria](../../1c-code-change/references/quality.md). The objective is
correct required behavior, readability and maintainability. Diagnostic reduction
is useful when it improves those properties or fulfills a mandatory condition;
it is not a separate cleanup assignment.

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
| Applicable advisory | The rule condition holds, but a mandatory violation or substantial defect is not established. Assess the benefit and cost of changing the implementation; retaining it can be justified. |
| False positive / not applicable | The rule condition does not hold or an analyzer limitation in this context is proven; retain a specific explanation and evidence. |
| Configuration/coverage problem | Wrong root/version/settings or unavailable required metadata, types, revision or completed analysis result. |
| Uncertain | Insufficient data for the preceding conclusions; retain the gap and stop only the dependent conclusion/action. |

Novelty relative to baseline is a separate property, not a confidence level.
When before/after diagnostics are required, retain the task-start baseline for
the assessed target across iterations and context compaction. Compare rule,
message, object and location for comparable scope/settings/versions, accounting
for line shifts. A last-iteration comparison can show progress but cannot relabel
a task-new finding as pre-existing. Code copied into a new or changed target is
assessed in that target; its age elsewhere does not make the finding legacy there.
Changed settings or models limit comparability rather than prove a regression.

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
Choose optional checks to resolve a material uncertainty that can change the
implementation or acceptance decision. Expected benefit must justify their cost;
do not require benchmarks or exhaustive investigation merely because an advisory
exists. Retain applicable mandatory checks and necessary task guarantees.

## Decision and acceptance

For material disputed findings keep a concise rule/location, assessment, decision
and supporting facts in the existing task context or report. Equivalent occurrences
may share an explanation when their relevant conditions are the same; a separate
document or checklist entry for every warning is unnecessary. Retain the actual
diagnostic check outcome separately from the decision to keep or change code.

A proven false positive or an inapplicable rule needs no source correction.
An applicable advisory may remain when a readable, maintainable implementation
meets task requirements and a proposed rewrite has no supported proportional
benefit. Keep a material remaining warning visible; do not call it fixed or false
merely because changing it is costly. Do not hide findings by changing analyzer
settings.

Diagnostic-to-standard relationships do not make their conditions identical.
Assess the exact normative condition and any permitted exception against the
specific source/context. Generic appeals to preserving behavior or small inputs
do not establish that the particular exception applies. A diagnostic alone does
not set a normative row to `failed`, and a general explanation does not justify
`passed` for an unresolved mandatory
condition. Readability and implementation cost do not waive mandatory violations;
resolve actual conflicts under $1c-standards.

Within an authorized implementation, correct confirmed substantial defects and
mandatory violations in scope, then recheck the affected result. Review/analysis
alone does not authorize fixes or broader legacy modernization.

Conclude proportionately to the verified scope:

| Outcome | Basis |
| --- | --- |
| `accepted` | Task criteria and necessary guarantees are verified, required applicable checks are fulfilled, and no unresolved substantial defect or mandatory violation remains. Assessed advisory tradeoffs may remain; this does not prove global optimality. |
| `rework_required` | A confirmed substantial defect or applicable mandatory violation requires correction, or a supported alternative resolves a substantial engineering shortcoming without disproportionate cost. |
| `unverified` | A missing mandatory check or unresolved material fact prevents the relevant acceptance conclusion. Name that gap rather than claim pass. |

An optional unperformed check or a remaining advisory alone does not make an
otherwise verified scoped result unverified. Do not claim performance gains or
other guarantees beyond actual evidence.

## Documented BSL LS limitations

Official descriptions explicitly allow false positives, including
[LogicalOrInTheWhereSectionOfQuery](https://1c-syntax.github.io/bsl-language-server/diagnostics/LogicalOrInTheWhereSectionOfQuery/)
and [DenyIncompleteValues](https://1c-syntax.github.io/bsl-language-server/diagnostics/DenyIncompleteValues/).
Check description applicability to the installed version. Strong confirmation of
one finding does not become a universal guarantee for every rule.
