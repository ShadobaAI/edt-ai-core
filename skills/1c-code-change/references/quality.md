# Engineering quality criteria

Apply these shared criteria to the affected mechanisms at design and actual-result
review. Read the relevant sections; a local task does not require a project-wide
audit. The result must fulfill the assignment and necessary guarantees, meet
applicable mandatory standards and checks, and remain readable and maintainable.
Diagnostic counts, code size, a completed checklist or an agent's opinion do not
establish quality. Additional investigation or implementation must have concrete
decision value proportionate to its complexity and maintenance cost.

## Task and technical choice

- Establish the goal, acceptance criteria, current requirements and clarifications,
  scope, ownership, source revision and significant dirty changes. Existing code
  and obsolete specifications do not define the required behavior by themselves.
- Verify facts that can change the choice: platform/library versions, API contracts
  and consumers, execution context, permissions, workload and data volumes. Obtain
  missing material facts narrowly; state unavailable evidence rather than guess.
- Use the reuse gate. Compare applicable reuse, local adaptation and new code by
  semantics, effects, cost and supportability. Compare realistic alternatives only
  for substantial choices; stop once a suitable approach and checks are known.
  Retain significant decisions and limits briefly in existing task records.
- Prefer a clear, sufficient implementation. New branches, abstractions, metadata,
  dependencies or compatibility paths need a current requirement or reachable
  substantial consequence. Avoid unrelated legacy modernization, artificial
  alternatives and hypothetical future consumers. Resolve material design changes
  within the assignment's actual authorization.

## Standards and diagnostics

- Select requirements for all affected mechanisms, retrieve exact normative text,
  and verify conditions, exceptions and the proposal/result revision through the
  existing standards workflow. Recommended guidance does not override mandatory
  conditions. Unsupported applicability or exceptions cannot be marked `passed`.
- Run the project's required applicable diagnostic families using their actual
  executors. EDT, BSL LS and ACC coverage are distinct; a catalogue or relationship
  between rules does not prove execution or equivalence. Retain tool/settings,
  scope, revision and actual check outcomes; compare against the task baseline.
- Assess findings using source/context facts. Keep mandatory violations, material
  defects, advisory tradeoffs, false positives and coverage gaps distinct. Group
  equivalent occurrences when their basis matches. Preserve required per-check
  outcomes without a separate document for every warning. A retained advisory
  can be justified; readability does not waive a mandatory violation.
- Ledger consistency, successful diagnostics and passing tests prove different
  things. None alone proves complete normative compliance or a sound design.

## Code and queries

- Choose algorithms and collections for actual operations and expected volumes.
  Account for repeated work, search/copy/serialization cost, memory, server calls
  and transferred data. Avoid unnecessary intermediate collections and wrappers;
  divide methods by coherent responsibilities without artificial fragmentation.
- Verify query semantics and data access cost: required fields/rows, N+1 and repeated
  queries, filters, usable indexes, virtual-table parameters, joins/cardinality,
  duplication, grouping and aggregation. Use temporary tables, their reuse and
  indexes only when warranted. Preserve `NULL`, empty references, periods, balances,
  totals and permissions/RLS semantics.
- Allocate work sensibly between queries and BSL. For DCS/reports assess datasets,
  parameters, links, variants, settings and result size; for dynamic lists assess
  data sources, filters, sorting, refresh and interaction cost.
- Separate a static performance risk from measured degradation. For material
  performance choices establish the workload and cost hypothesis; compare variants
  on representative data when useful, available and authorized. Small tests do not
  prove load behavior. Do not invent speedups, universal SLAs or caches for
  hypothetical growth, or complicate code for an unsupported gain.

## Metadata, UI and other artifacts

- Choose metadata and storage by domain meaning, operations and lifecycle. Verify
  register dimensions, resources, attributes, periodicity and totals. Avoid
  redundant stored state; necessary denormalization needs an authoritative source
  and a consistency mechanism.
- Preserve posting, reposting, cancellation, repeated-event and exchange/loading
  invariants across relevant write paths. Schema changes require assessment of
  existing data, conversion, infobase updates, consumers and compatibility.
  Respect supplier ownership, supported extension routes and update cost.
- Place form logic by responsibility, execution context and lifecycle. Assess
  round trips, transferred state, long operations, repeated opening, user settings,
  localization and applicable accessibility/client-mode requirements.
- For processes/tasks assess routes, transitions, actors and repeated events;
  for print layouts and external reports/processors assess formats, user changes,
  permissions, dependencies and connection compatibility. Check feature options,
  session parameters and configuration variants when they alter behavior.
- For XML/XDTO, files and exchange schemas verify exact contracts, validation,
  versions, size and consumer compatibility. Preserve relevant language, units,
  precision, rounding, date/time formats and time zones.

## State, integrations and security

- Set transaction and compensation boundaries by invariants and partial-failure
  consequences. Assess shared-state races, locks and deadlocks where relevant;
  preserve required atomicity, ordering and idempotency across repeat events,
  restarts and message delivery.
- Handle reachable failures honestly. Do not swallow failed writes or report
  success after loss of required work. Retries need an applicable transient-failure
  contract, bounded scope and outcome verification; account for retries at multiple
  layers. Add backoff, circuit breakers or compensation only for an actual need.
- For APIs, exchanges and background jobs assess timeouts, limits, batching,
  message versions, concurrency, duration, resource bounds and safe resumption.
  Reuse existing operational diagnostics rather than add telemetry without purpose.
- Verify trust boundaries, access checks, permissions/RLS and the need for
  privileged execution. Validate relevant untrusted formats and parameterize
  queries. Do not expose secrets or confidential data in output, logs or fixtures.
  New components need justified use, compatibility, provenance and licensing.

## Verification, review and knowledge

- Verify observable behavior with meaningful assertions at suitable granularity.
  Use focused unit, integration or UI checks for the contract they can establish;
  preserve test isolation and cleanup within the authorized data scope. Cover
  material negative, boundary, repeat, concurrent and migration cases. Before risky
  refactoring use available characterization of existing behavior. Tests should
  detect consequential failures, not merely calls or prepared mock answers.
- Check the actual final diff and affected consumers/guarantees. Respect required
  independent review; implementation statements and self-review are not independent
  evidence. Findings need a location, verifiable basis, consequence and a practical
  proportionate remedy. A sound result may require no changes or further checks.
- Keep diagnostic, behavioral and normative outcomes separate. Report verified
  scope and material gaps as `accepted`, `rework_required` or `unverified` under the
  diagnostics contract. Missing mandatory evidence prevents the dependent positive
  conclusion; an omitted optional check alone does not. Acceptance is scoped and
  does not claim global optimality. Update affected public contracts/documentation.
- Use confirmed project knowledge and patterns within their provenance, revision
  and applicability limits; verify current APIs and effects. Captured experience
  needs its context, rationale, alternatives, evidence and limits. Patterns such
  as GRASP, SOLID, GoF, DRY, KISS and YAGNI guide choices; they do not require OO
  structures or templates in 1C. Share stable semantics, not coincidentally similar
  lines; the Rule of Three is not a mandatory numerical threshold.
