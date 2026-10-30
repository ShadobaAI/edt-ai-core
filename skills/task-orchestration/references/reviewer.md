# Independent result review

Give a fresh reviewer acceptance criteria and SDD/ADR if required by the project,
the final diff with base/target SHAs for saved revisions or baseline/result hashes
for uncommitted results. No commit is required for review. Supply authorized source
evidence, selections and exact requirements, ledgers only for applicable phases,
actual diagnostic/test outcomes and substantial gaps. Do not supply an expected
verdict or implementation reasoning as correctness evidence.
Include the current requirements and later clarifications, accepted risks and
rejected alternatives with their sources and conditions for reconsideration,
including known write-path limitations. These decisions constrain the review but
do not establish that implementation satisfies them.

Assign explicit read-only work and, when supported by the host, a read-only
sandbox/agent configuration. Role names do not prove technical access restriction;
if no sandbox is available, state the enforcement boundary explicitly.
The plugin does not silently register CRM/Kafka agent names or user agent settings.

The reviewer checks changed behavior and reachable failure paths, authority/scope,
concurrency, normative applicability, enclosing invariants and actual-result
consistency with criteria. Passing tests and implementation-agent statements do
not prove correctness. Missing authority stops dependent conclusions rather than
authorizing another authority or generic filesystem source access.
For change results check the actual final diff against requirements and criteria,
not just implementation descriptions. Assess reuse/local-adaptation/new-code
choices, candidate contracts and added-complexity justification under shared
$1c-code-change / $1c-code-index checks. Bound review to affected scope and
substantial dependencies; a green test does not resolve an unverified decision.
For affected mechanisms check permissions/RLS, untrusted inputs, transactions and
compensation, client/server boundaries, event order and lifecycle. Account for
supplier updatability and actual shared-contract consumers, not just local callers.
Check reachable partial implementations and error paths for unintended writes,
and assess invariants across relevant ordinary and exchange/loading paths, including
whether conversion hides duplicates. Compare behavior and specified error text to
current criteria; identify contradictory or obsolete requirements explicitly.
Separate line-ending/format churn from semantic changes in the reviewed diff.
Use authorized source/metadata facts of the required revision; unknown significant
consumers or context remain gaps rather than assumed safety.
Distinguish successful diagnostics, behavioral verification and normative compliance:
these are independent results. Name actual checks and coverage for each;
protocol/ledger_valid proves assessment consistency, not evidence truth, behavior
correctness or other passed gates.
Author self-review is not independent review. If independent assessment is required
but no separate reviewer is available, mark the open gate. Formal skill compliance,
a filled ledger and no findings do not themselves prove correctness;
conclusions rely on actual diff and verified conditions.

Source/metadata writes, runtime evaluation, database launch/update, branch switching,
deployment and cutover are forbidden. Do not fix findings during review.
Provide actionable findings: location, priority, scenario, consequence and evidence;
list material unknowns/unperformed checks separately. State no findings within
actual verification boundaries, not as full acceptance of unavailable gates.
