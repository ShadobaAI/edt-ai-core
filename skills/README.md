# Skill consolidation

Active skills expose one workflow for every project type. Profile fields choose
the repositories, aliases, EDT projects and optional test capabilities.
The shared capability rules in [routing](1c-routing/SKILL.md) apply to all modes:
use effective enabled/managed/external settings and the current live contract of
only the required authorities. A profile mapping alone does not enable a route;
missing capabilities stop their dependent actions without implicit substitution.

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
as an optional or fallback provider. The current knowledge integration contract
is described in [INTEGRATIONS.md](../docs/INTEGRATIONS.md).
Neither server's absence is a migration defect or a reason to restore it.
Review EDT documentation coverage and the planned BSP knowledge/OpenViking
replacement separately; excluding legacy servers does not establish replacement
readiness or complete the remaining reconciliation.

## Локальная сверка принятых решений

Сверка универсального поведения ограничена принятыми `migration_decisions`.
Она подтверждает текущие исходники и изолированные проверки клиента, не полную
историческую паритетность исходных окружений, реальные JAR/EDT/v8std и развёртывание.
Поэтому `migration_acceptance` сохраняет отдельный незакрытый detailed-parity scope,
а `accepted_decisions_local_acceptance` относится только к следующей таблице.

| Принятое решение | Текущий механизм и локальные проверки |
| --- | --- |
| project-profiles-outside-plugin | Только generic-профиль; `profile.mjs`, package allowlist; tests/test-profiles.mjs |
| bsl-native-multi-workspace | Native workspace API, session JVM/registrations, optional config; tests/test-bsl-ls-proxy.mjs |
| platform-documentation-edt-only | Назначенный EDT и platform-docs, Help исключён из registry/схем/маршрутов |
| bsp-documentation-without-ssl-mcp | SSL-MCP исключён; selected knowledge и index/live roles, tests/test-knowledge.mjs |
| project-defined-supplier-maintenance | Общий ownership workflow и project instructions без фиксированных префиксов; tests/test-profiles.mjs |
| edt-model-gate-recovery | Exact pre-write refusal, bounded recovery и отдельный cleanup scope; ревью инструкций edt-recovery.md, без заявления fixture/live-проверки самого recovery |
| selected-directory-and-instance-profile | Независимые root/instance/session и overrides; tests/test-profile-settings.mjs, tests/test-setup.mjs |
| edt-capability-driven-efficiency | Live schemas, toolsets и core_runtime bridge без pinned catalogue; tests/test-remote.mjs |
| v8std-capability-driven-efficiency | Общий read-only сервер, bounded retrieval, отдельные contexts/ledgers; tests/test-setup.mjs, tests/test-policy.mjs |

Точные правила принадлежат связанным навыкам и runtime, таблица их не дублирует.
Routing владеет knowledge/source gates, code-index — reuse, code-change — risk,
sufficiency и writer lifecycle, standards — нормативными фазами, action policy —
effects/авторизацией. Остальные сценарии применяют эти правила по необходимости,
а не требуют загрузить все связанные skills/references заново.
Пути `tests/` указаны от корня dev-checkout; эти dev-проверки не входят в ZIP.
Проектные mappings, endpoints, credentials, формат маркировки и local exports
не переносятся из исходных окружений в ядро. Состав готовой поставки и live
приёмка проверяются отдельно; отсутствие исключённых серверов не является пробелом.

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

