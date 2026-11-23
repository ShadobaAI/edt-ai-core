---
name: 1c-code-change
description: Implement or review a scoped 1C source or metadata change through the profile-selected EDT, using available write preconditions and diagnostics before and after mutation. Not standalone discovery or API lookup.
---

# 1C code change

## Scope and risk

Use the effective profile from $1c-routing and the applicable [project instructions](../edt-ai-core/references/project-instructions.md).
Reuse supplied context and read missing relevant project rules. Apply the
[action policy](../1c-routing/references/action-policy.md) to actual effects.
Establish the goal, acceptance criteria, repository, assigned EDT project and
change boundaries. Confirm the exact project name, path and readiness through EDT
before model-dependent operations. For historical code, read the exact revision
with revision-aware tools; do not attribute the current model/diagnostics to it.
Do not infer routing from directory proximity. Do not read or modify protected
source through shell/file tools; `code-index` and BSL LS are for authorized
read-only analysis only. EDT is the sole writer and primary validation authority.

Apply the shared [engineering quality criteria](references/quality.md) to the
affected mechanisms and task criteria; read only the relevant sections. Prefer
a readable, maintainable solution that meets the assignment and its necessary
guarantees.

Choose the mode from the assignment. **Review** checks the exact diff or source,
contracts and applicable requirements with `operation: review`, `phase: result`.
Use relevant available diagnostics and existing SDD/ADR where applicable.
Report a missing project-required artifact as a gap. Apply the impact and
independent review conditions below. Findings give no authority to implement.
**Implementation** follows proposal → EDT write → result and applicable checks.
Preserve unrelated and concurrent changes. The planning and write steps below
apply to this mode.

Classify by mechanisms, not diff size:

- **L** — a proven local edit without changes to contracts, permissions, schema,
  external interaction or transactions, including test-only wrappers/helpers.
  Changes to query behavior, persistent state, transactions, privileges,
  client/server boundaries or any H mechanism exclude L. A test-file location
  does not establish L.
- **M** — a new semantic operation or local logic, ordinary behavior changes
  including queries, without H mechanisms. A project-owned module and unchanged
  public API do not make a new operation L.
- **H** — public API, data schema, permissions/RLS, destructive operations,
  nontrivial migration, architecture or cross-component behavior. Assess impact,
  apply project gates and obtain independent read-only result review through
  $task-orchestration. Self-review is not independent.

Treat an unresolved mechanism at its higher plausible level until evidence
settles it. Classify again if the scope or affected mechanisms change.
For implementation, scale specification and planning to consequences. L needs
a goal and completion criterion as a brief SDD. M needs a brief SDD with
boundaries and a verifiable result, plus a compact plan when several substantial
decisions exist. H needs an agreed task-level SDD and a plan of substantial
stages, with an ADR when the project requires it or a substantial architecture
decision needs recording. Seek independent design assessment for H or a
substantially disputed architecture decision when available.
Reuse existing project documents and decisions; a full template and new file
are not required for each local edit.
For a substantial change, identify affected objects and entry points, candidate
existing mechanisms, execution context and concrete acceptance checks before
writing. Reconcile SDD and requirements with later user clarifications and current
code; identify material contradictions and resolve them within authorized scope.
Do not silently treat an outdated document or an implementation as the requirement.
Keep a compact task record of accepted risks, rejected alternatives, limitations,
their sources and conditions for reconsideration; pass the relevant facts to review.
An ordering chosen in a plan does not itself create an authorization or safety gate:
perform independent authorized work while respecting actual project requirements.
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

When choosing the solution and reviewing its diff, require a current requirement,
contract, invariant or reachable substantial failure for each added nontrivial
guard, exception handler, fallback, wrapper or API option. Reuse proven
type/value guarantees. Verify material unknowns or retain needed protection.
For one local consumer, prefer a direct call or small composition under the
reuse check. Remove abstractions whose only basis is a hypothetical consumer.

Preserve authorization/RLS, transaction and client/server boundaries, lifecycle
and integrity. Validate relevant untrusted HTTP/file input before writes. Handle
reachable critical failures even when rare. On failure, preserve integrity and
idempotency and report the actual outcome. Recover or compensate where required.

Choose optional reads, tests and refactoring only when they can change a material
decision or verify a needed guarantee at proportionate cost. Stop at sufficient
evidence, retaining all applicable mandatory checks.

## Before writing

1. Read the minimal live target and directly affected contracts.
   For a new semantic operation, regardless of line count, perform the
   [reuse check](../1c-code-index/SKILL.md#reuse-gate).
   Verify unknown platform APIs and restrictions through $1c-platform-docs.
   Before creating forms, roles or rights, check the actual execution context,
   standard capabilities and suitable existing objects/permissions. Create only
   what the accepted behavior requires; do not assume privileged execution.
2. Apply the shared [requirements workflow](../1c-standards/references/requirements.md)
   to baseline → proposal. The policy check for `phase: proposal` must return
   `ledger_valid` before the write. Retain the proposal evidence, applicable
   selection and exact normative text for the result.
3. Obtain focused EDT diagnostics of affected objects before the change; for
   creation use the available owning scope. Failure to obtain or incompleteness of
   the required baseline blocks writing. Existing findings alone do not prohibit
   an authorized fix: assess their impact on the target and required guarantees.
   If the current API lacks a needed diagnostic check, state the coverage limit;
   stop writing when a required diagnostic guarantee cannot be ensured without it.
   Availability of a write precondition is handled separately in step 4.
   For changed BSL, use enabled and prepared BSL LS for focused complementary
   diagnostics before and after the change. Metadata-only changes retain
   applicable EDT metadata checks. Record unavailable checks and assess findings
   under the [diagnostics contract](../1c-routing/references/diagnostics.md).
4. Use the preconditions supported by the live contract for the actual write,
   target and mode. When a relevant hash/version is available, pass the current
   token if the check applies; use other preconditions according to their actual
   scope. A parameter accepted but ignored for this target is not a protection.
   If the operation supports no compare-and-write check, or its token is unavailable,
   proceed without it when the live contract permits, at every risk level. Do not
   require a different EDT-MCP, invent a token or ask for separate approval solely
   because that check is unavailable. If the operation itself requires a token and
   none can be obtained, report the actual tool limitation.
   Read the relevant current target or owning context for creation, keep the write
   scoped and verify its result.
   Without a compare-and-write check, a reread or post-write verification does not
   prevent concurrent updates from being overwritten; briefly report that limit in
   the completion report without treating the absent check as a write error. A
   reported conflict requires a new read and reconciliation;
   do not bypass a failed precondition by overwriting or disabling checks. HEAD
   changes, relevant mutations or contradictions invalidate affected source,
   precondition and readiness facts; refresh only those facts.

## Writing and unknown outcomes

Read the applicable section of [EDT editing contracts](references/edt-editing.md).
Use the live schema/guide of the needed operation. Make one logically atomic
change in the verified scope; prefer method/region/fragment operations.
Do not replace a whole module for a local edit or bypass an unavailable operation
by editing serialized files.

Apply the [relay outcome and retry rules](../1c-routing/references/toolsets.md#calling-the-relay)
to each writer. Resolve the original operation through assigned EDT before any
dependent write. Verify confirmed effects and refresh applicable preconditions
before any justified retry.

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

After each confirmed change, including recovery, repeat the applicable focused
diagnostics and artifact checks. Compare with the task-start baseline under
the [diagnostics contract](../1c-routing/references/diagnostics.md).

Verify the actual result against retained requirements and task criteria;
compare the diff against the reuse and sufficiency checks above.
Check observable behavior and specified error text, including intermediate or
unfinished entry points: they must not change data before reporting an unsupported
operation unless that effect is explicitly required. For affected invariants,
check each relevant write path, including exchange/loading where applicable, and
whether conversion can conceal duplicates. Record accepted path limitations and
their consequences for review. Inspect the diff for unintended line-ending or
format churn and distinguish it from semantic changes.
Under the shared requirements workflow, run the policy check with `phase: result`
and current mechanisms/evidence. Proposal, diagnostics and tests
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
State `accepted`, `rework_required` or `unverified` under the shared diagnostic
and quality criteria, with material remaining findings and verification limits.
Do not present an unknown outcome, a missing mandatory check or a material
unverified requirement as confirmed completion.
Offer useful repeatable experience for separate team review/publish, without
automatically writing to OpenViking or publishing. Reporting incorrect material
needs only its ID/URI, revision/snapshot, verifiable discrepancy and evidence
boundaries without secrets; knowledge write access is unnecessary. Drafting a
proposal in chat does not authorize sending it to the team.
