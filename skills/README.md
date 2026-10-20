# Skill consolidation

Active skills expose one workflow for every project type. Profile fields choose
the repositories, aliases, EDT projects and optional test capabilities.

Only the universal `generic-1c` profile is bundled. The user's 2026-10-20
`project-profiles-outside-plugin` decision removes CRM/Kafka profiles and local
exports from this repository and defers their development to a separate task.
Real profiles belong to the consuming project repositories or local settings.

The requested operation selects the workflow mode before any preparation:
design/review, implementation, and runtime execution have distinct effects and
acceptance criteria. Read-only branch review compares existing exact revisions;
Git preparation is conditional. Static Vanessa authoring/review does not require
a running manager, and run/report-only does not authorize source fixes.

Original CRM and Kafka skills belong to their own repositories, identified in
`catalog.yaml` and [SOURCES.md](../docs/SOURCES.md). Read those repositories when
reconciling workflows; do not keep source snapshots or project-specific skill
trees in the plugin repository. Installed core skills must be self-contained.

Before judging migration parity, apply the accepted `migration_decisions` in
[catalog.yaml](catalog.yaml). In particular, `platform-documentation-edt-only`
records the user's decision of 2026-10-19 to exclude HelpSearchServer, including
as an optional core provider, because of installation and paid-service costs.
`bsp-documentation-without-ssl-mcp` records the exclusion of `1c-ssl-mcp`, including
as an optional or fallback provider, following KORA D-01 and section 7.3.
Neither server's absence is a migration defect or a reason to restore it.
Review EDT documentation coverage and the planned BSP knowledge/OpenViking
replacement separately; excluding legacy servers does not establish replacement
readiness or complete the remaining reconciliation.

Shared mutation safety is maintained in [1c-code-change](1c-code-change/SKILL.md)
and its [EDT editing contracts](1c-code-change/references/edt-editing.md):
scoped pre/post EDT diagnostics, source guards,
bounded mutation, indeterminate-outcome handling and artifact-specific checks.
These are adapted common contracts, not archived source-environment snapshots.
The shared [EDT model-gate recovery](1c-code-change/references/edt-recovery.md)
preserves the workflow for the exact pre-mutation refusal confirmed against the
installed server contract: bounded owner revalidation, three guarded retries and
one cleanup escalation only with the required authorization. Its applicability
is checked against the installed contract; timeout is never a retry trigger.
`edt-model-gate-recovery` in the catalog records the user's required transfer.

Supplier/product ownership assessment is also shared in `1c-code-change`;
`project-defined-supplier-maintenance` records this accepted scope. Concrete
prefix mappings and maintenance conventions belong to each project's `AGENTS.md`
or the instructions it references, rather than a CRM-specific core workflow.

The normative workflow is maintained once in
[1c-standards](1c-standards/SKILL.md) and its
[requirements contract](1c-standards/references/requirements.md). Bundled `policy`
normalizes caller assessments, selects baseline and additional requirements and
checks phase-specific ledger consistency under [protocol 2.1](../policy/README.md).
v8std code/context retrieval is the primary discovery route; applicable candidates
outside the registry enter the same selection/ledger through `additionalRequirements`.
Its heuristic matches require applicability checks and exact normative text.
The [v8std MCP contract](1c-standards/references/mcp.md) selects compact operations
from negotiated instructions and live schemas, without a server-version pin or
static catalogue. A read-only endpoint may serve multiple projects; source/context
retrieval and compliance assessments remain scoped to their task and revision.
Code changes and YaXUnit normative
checks reuse this contract. Missing coverage is not a passing selection, and a
valid ledger does not prove the truth of its source/normative evidence.
Assessments distinguish authorized baseline, projected transition and actual
result/reviewed revision. Added mechanisms are checked before writes; deletion
and rename remain transition facts after them. Design uses proposal, review uses
result, and implementation uses both phases with snapshot-specific evidence.

YaXUnit authoring, review, execution and debug follow
[yaxunit-tests](yaxunit-tests/SKILL.md), with explicit test/framework/product
ownership, data/mock strategy, registration and focused run acceptance.
[vanessa-ui-tests](vanessa-ui-tests/SKILL.md) covers research/recording, authoring,
session readiness, selected execution and receipts. Its bundled CLI uses the
same profile binding and preserves unknown mutation outcomes without retry.

Shared agreement rules live once in `policy/default.json` and the
[action policy](1c-routing/references/action-policy.md). Routing, code change,
review, runtime setup and both testing skills use this contract. Policy checks
declared scope/effect evidence; it does not authenticate a user or replace host
approvals. The profile schema and import checks enforce typed capabilities,
repository references, containment and non-weakening of these defaults.

Branch review now preserves preparation, exact refs, baseline attribution,
post-checkout readiness and scoped completion through its own references. Bounded
reuse and the independent reviewer/handoff contract are shared skills. The source
guard is bundled and registered; host trust and actual activation are separate.
EDT binding, token economy, progressive disclosure and bounded update audit live in
[the routing toolsets contract](1c-routing/references/toolsets.md), adapted from
both environments without project tool-name allowlists.
Runtime/profiling and specialized artifact workflows are read only when needed;
capability coverage is not a requirement to call every available operation.

Profiles are loaded from the selected repository, not a fixed CRM/Kafka registry.
Tracked connections are defaults; process/instance overrides allow parallel CRM
instances and distinct Kafka contours without editing the shared template.
This accepted scope is recorded in `migration_decisions`.

Local regression and independent fixture checks do not prove live migration
acceptance. Live EDT/v8std/YaXUnit/Vanessa acceptance remains open. Local checkout
paths, aliases and endpoints belong to profiles/settings, not skill source code.

