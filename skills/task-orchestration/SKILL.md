---
name: task-orchestration
description: Use for bounded independent workstreams and read-only review on complex 1C tasks.
---

# Task orchestration

Apply for independent research/work, complex, architectural or H changes and
substantial benefit from a fresh reviewer. Respect the user's delegation choice;
a simple scoped change needs no workers.
Independent review and workers are separate decisions: risky results need separate
read-only assessment, without requiring delegated implementation.
Use workers when tasks are truly independent and splitting work is beneficial,
subject to host permissions and user choice; reviewer roles do not authorize fixes.
Change planning reuses established L/M/H and the stopping criterion from
$1c-code-change without rereading known rules. Delegate only independent unresolved
questions; a known approach needs no new subtask or recreated SDD.

Give each worker only `goal`, `scope`, `known_facts`, `constraints`,
`authoritative_sources`, `expected_output`, the selected directory's profile and
exact repository/authority bindings. Request `conclusion`, `evidence`, `risks`,
`unknowns`. Do not import full transcripts or expand mutation scope through
discovered dependencies. Production/tests in one repository retain separate
ownership; different repositories have separately authorized write boundaries.

H/public API, schema, complex logic and cross-component changes need a fresh
read-only reviewer under the [result contract](references/reviewer.md).
The reviewer does not fix findings or treat runtime pass as normative proof.
Fixes occur in implementation with rechecking of affected results.
Retain durable conclusions in owning SDD/ADR/docs under project instructions;
handoffs between tasks/developers contain only bounded evidence.

If delegation is unavailable or forbidden by the user, do not substitute self-review
for independent review: perform available checks and mark this gate unperformed.
This does not cancel authorized independent work or permit claiming full H acceptance.
