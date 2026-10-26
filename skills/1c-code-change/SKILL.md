---
name: 1c-code-change
description: Implement or review a scoped 1C source or metadata change through the profile-selected EDT, with guarded writes and diagnostics before and after mutation. Not standalone discovery or API lookup.
---

# 1C code change

## Scope and risk

Read the project's `AGENTS.md`, `.ai/project.yaml` and `.ai/PROJECT.md`.
The shared [action policy](../1c-routing/references/action-policy.md), not a local
copy of its rules, governs agreement for actual effects.
Establish the goal, acceptance criteria, repository, assigned EDT project and
change boundaries. Confirm the exact project name, path and readiness through EDT
before model-dependent operations. For historical code, read the exact revision
with revision-aware tools; do not attribute the current model/diagnostics to it.
Do not infer routing from directory proximity. Do not read or modify protected
source through shell/file tools; `code-index` and BSL LS are for authorized
read-only analysis only. EDT is the sole writer and primary validation authority.

Choose the mode from the assignment. **Review** checks exact source/diff,
contracts and applicable requirements with `operation: review`, `phase: result`;
proposal, write guards, pre-mutation diagnostic baseline and test execution are
not prerequisites for ordinary review. Use relevant available diagnostics and
state their limits; the write sections below apply only to implementation.
Findings do not authorize fixes. **Implementation** follows proposal → guarded
write → result and applicable checks. Do not affect others' changes or another
component without the corresponding scope.

Classify by mechanisms, not diff size:

- **L** — a proven local edit without changes to contracts, permissions, schema,
  external interaction or transactions, including test-only wrappers/helpers.
  Queries, persistent state, transactions, privileges, client/server boundaries
  and any H mechanism exclude L; placement in a test file alone does not establish L.
- **M** — a new semantic operation or local logic, ordinary behavior changes
  including queries, without H mechanisms. A project-owned module and unchanged
  public API do not make a new operation L.
- **H** — public API, data schema, permissions/RLS, destructive operations,
  nontrivial migration, architecture or cross-component behavior. Follow project
  SDD/ADR gates, assess impact and obtain independent read-only review through
  $task-orchestration. Self-review is not independent.

Raise the level when uncertain. All levels retain the write checks below.
The depth of specification, SDD, planning and verification depends on consequences:
L needs a goal and completion criterion as a brief SDD, with an internal plan
if needed; M needs a brief SDD with boundaries and a verifiable result, and a
compact plan when several substantial decisions exist; H needs a separate agreed
SDD and a plan of substantial stages, with an ADR if needed.
Reuse existing project documents and decisions; a full template and new file
are not required for each local edit.
Stop decomposition when substantial decisions, constraints and checks are known.
Do not plan individual statements or confirmed APIs; resolve new technical
questions locally within the existing task boundaries.
SDD, risk level and plans do not expand authorized effects. Preserve the shared
action policy and actual authorization for the same target/scope:
do not seek renewed agreement for every step or ordinary local decision. For a
public contract, schema, security, integration, dangerous migration or substantial
SDD deviation, obtain missing agreement if it has not already been given.
A new target, effect or scope expansion requires a separate authorization check.
The minimum L result is a verified local diff, completion criterion and actual
focused checks with gaps; M also presents behavior changes and applicable
requirements; H presents consumer/data/permission impact, substantial risks,
independent review and necessary user decisions. In every class, unperformed
checks remain explicit.
Raise the class on discovering a shared contract, external effect, permissions,
data, transactions, migration, unknown ownership with substantial risk or new
cross-component impact. A small diff and a test file do not prove low risk.

## Origin and supplier maintenance

Before choosing how to make a change, establish the distribution boundary and
target object's ownership from project `AGENTS.md` and its referenced sources.
This is a common mechanism for projects using BSP, other libraries, supplier
solutions and custom modifications. Interpret prefixes, namespaces and location
under project rules; treat them as sufficient evidence when the project defines
an unambiguous mapping. An unknown mapping or missing prefix does not prove
ownership; resolve only the needed fact through authorized reads when ambiguous.

Treat the supplier product as an entire distribution: bundled libraries and
objects added by the vendor with its prefix belong to it. A vendor prefix alone
does not make an object a custom modification owned by the current project.
Retain task-relevant library/version facts within the distribution and a separate
boundary for the project's own changes.

Project `AGENTS.md` defines rules for changing the supplier distribution, using
extensions/subscriptions, naming project-owned objects and marking modifications.
Apply these when choosing a solution and verifying the result; derive required
attribution and task numbers from facts. Reuse sufficiently established ownership.
Do not hardcode specific prefixes or comment formats in the core.

## Sufficiency check

For nontrivial protection, `Попытка/Исключение`, fallback, wrappers,
parameterization, new branches or API expansion, establish a specific basis:
a requirement, contract, invariant or actually reachable substantial consequence.
Explain added complexity briefly and concretely, without separately proving
every imagined failure impossible. Low probability does not negate a reachable
critical failure. Do not swallow exceptions without correct recovery, a contextual
message or necessary compensation; fallback must not present failure as success
or violate integrity and idempotency.
Apply the check when choosing a solution and again against the actual diff:
check every added nontrivial branch and abstraction against its basis.
Do not turn a local task into a general framework; remove excess complexity
introduced during implementation while retaining required guarantees.
Do not duplicate type/value checks and backup algorithms when the current contract
and call paths already establish the guarantee and no other substantial basis
exists. Missing contract facts are not a guarantee: verify the needed fact instead
of chaining invented fallbacks. Do not add generality, parameters or API expansion
for hypothetical future consumers; one local consumer usually needs a direct call
or small local composition, subject to mandatory project APIs from the reuse check.
Sufficiency does not cancel mandatory checks for permissions/RLS, untrusted inputs,
transaction boundaries and actually reachable substantial failures. Preserve
client/server boundaries, lifecycle and data integrity. External HTTP/file input
requires validation of the relevant format before use in writes; infrequent errors
do not make it trusted. When substantial guarantees are unknown, verify the
contract or retain necessary protection; do not remove it to reduce the diff.

## Before writing

1. Read the minimal live target and directly affected contracts.
   For a new semantic operation, regardless of line count, perform the
   [reuse check](../1c-code-index/SKILL.md#reuse-gate).
   Syntactic composition of already confirmed operations requires no separate search.
   Verify unknown platform APIs and restrictions through $1c-platform-docs.
   Reuse already sufficient facts without searching again.
2. Follow the shared [requirements workflow](../1c-standards/references/requirements.md)
   from $1c-standards: full detection, `policy` selection, exact `v8std` requirements,
   project conditions and `validate_compliance` with `phase: proposal` before writing.
   Detection assesses baseline → specific proposal, including new mechanisms and
   delete/rename effects, rather than only the old source. Retain baseline/proposal
   references, selection/digest and normative text for the result.
   Check specifically for `status: ledger_valid`; `blocked` blocks dependent writes
   even with `isError: false`. Missing policy/coverage, unknown applicability or a
   violated mandatory requirement block dependent writes; do not replace the
   workflow with general standards search.
3. Obtain focused EDT diagnostics of affected objects before the change; for
   creation use the available owning scope. Failure to obtain or incompleteness of
   the required baseline blocks writing. Existing findings alone do not prohibit
   an authorized fix: assess their impact on the target and required guarantees.
   If the current API lacks a needed check, state the coverage limit; stop writing
   when the required guarantee cannot be ensured without it.
   Metadata-only changes do not require BSL checks but retain applicable EDT
   metadata checks. Assess finding validity under the shared
   [diagnostics contract](../1c-routing/references/diagnostics.md): primary validation
   does not make EDT infallible, and BSL LS messages depend on the rule, settings
   and context completeness.
4. Retain the hash/version from the EDT read and pass it to the write guard
   provided by the live contract. A version conflict requires a new read and
   reconciliation with the current state; do not bypass it by overwriting or
   disabling checks. Without a guard, rereading does not provide atomic protection
   against lost updates. Stop high-risk writing if the necessary compare-and-write
   guarantee is unavailable. HEAD changes, relevant mutations or contradictions
   invalidate affected source/hash/readiness facts; refresh only those facts.

## Writing and unknown outcomes

Read the applicable section of [EDT editing contracts](references/edt-editing.md).
Use the live schema/guide of the needed operation. Make one logically atomic
change in the verified scope; prefer method/region/fragment operations.
Do not replace a whole module for a local edit or bypass an unavailable operation
by editing serialized files.

Check `isError`, the structured result and the actual operation outcome. An ack or
`jobId` does not mean completion: retain the ID and follow the same job with a
supported status call.
After timeout, connection loss or an ambiguous response, do not repeat the writer.
Establish the target and existing job state through EDT. If the effect exists,
verify it; if the outcome remains unknown, stop dependent writes and report the
uncertainty. Confirmed absence of an effect does not allow retry while the old job
may still run. A new call is allowed only after resolving the outcome, checking
the target and refreshing guards.

For a proven pre-write refusal, allow one correction based on the live schema/guide
or explicit diagnostics, rechecking prerequisites without expanding scope.
A repeated refusal stops automatic recovery.
The bounded exception is [EDT model-gate recovery](references/edt-recovery.md)
for the exact proven pre-write refusal of `create_metadata`/`modify_metadata`,
confirmed against the current server contract. Read the reference for this refusal:
targeted revalidation and at most three recovery attempts apply to one operation;
subsequent clean requires permission for the same project under the shared action policy.
Timeouts and unknown write outcomes do not qualify for this exception.
Do not run `clean_project`, resync or whole-project revalidation as post-write
cleanup or universal recovery. For additional effects, apply the shared action
policy and existing permission for the same scope.

## After writing and completion

After each confirmed change, including recovery, perform the same focused EDT
diagnostics and applicable artifact checks.
Compare against the baseline by code, message, object and location, accounting
for line shifts. Distinguish new, existing, resolved, proven false-positive,
infrastructure and uncertain findings. Do not hide diagnostics; a false positive
requires confirmation from current source/metadata context. New unresolved defects
and unreliable mandatory post-validation block confirmation of completion.

Verify the actual result against retained requirements and task criteria;
compare the diff against the reuse and sufficiency checks above.
Under the shared requirements workflow, run `validate_compliance` with
`phase: result` and current mechanisms/evidence. Proposal, diagnostics and tests
do not replace this check. Changed applicability requires revising selection
with a reason.
Run the minimum necessary existing tests from the profile in the authorized
environment. If an additional runtime effect is unauthorized, finish available
checks and mark the dependent check unperformed; do not invent permission from
a requirement to “verify the change.” Diagnostics, syntax/query validation and
behavioral tests are distinct results. A successful write needs no further read
if its response and validation already contain sufficient facts; ambiguity
requires verification.

Before accepting an M change, submit the actual result for review. Diagnostics,
tests and result validation do not replace that review; H requires the independent
read-only review established above.

Keep the report proportionate: changes or review findings, risk level and
substantial findings, reused APIs/settings, why new code/adaptation was needed,
actual checks with their kind and scope, remaining gaps and truly necessary user
decisions. Do not list every statement or present a procedure log as the result;
honor the user's requested brevity.
Do not present partial validation, an unknown outcome or an unperformed check as
confirmed completion.
Offer useful repeatable experience for separate team review/publish, without
automatically writing to OpenViking or publishing. Reporting incorrect material
needs only its ID/URI, revision/snapshot, verifiable discrepancy and evidence
boundaries without secrets; knowledge write access is unnecessary. Drafting a
proposal in chat does not authorize sending it to the team.
