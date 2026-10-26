---
name: yaxunit-tests
description: Design, author, review, run and debug YaXUnit tests, registration, assertions, fixtures and mocks when enabled by the project profile. Not product changes or UI tests.
---

# YaXUnit tests

## Binding and authority

Apply knowledge mode/source roles from $1c-routing and shared reuse/sufficiency
checks. Choose design/review, authoring or execution from the assignment:
run results do not authorize product, test or framework changes. Check ownership
of these three areas and authorized effects separately.

Check `testing.yaxunit` and `testing.yaxunit_config`. `repository_id` identifies
the test extension owner and its `edt_project`; aliases come from `repositories`.
`framework_repository_id` is read-only YaXUnit core; `product_repository_ids`
identifies dependencies available for research, not permission to modify production.
Do not infer ownership from directory names; missing binding blocks the dependent
route. Do not enable capabilities or change production/core for test convenience.

`code-index` finds definitions and real usages; EDT confirms live state, unknown
installed signatures, performs all writes, primary diagnostics and
`run_yaxunit_tests`. BSL LS is needed only for a separate focused analyzer question.
`v8std` supplies known pattern/API contracts; do not duplicate sufficient reference
by checking every signature in EDT. Resolve version contradictions first.

## Normative and authoring gates

For design/create/change/review and test-code analysis during debug/migrate follow
the shared [requirements workflow](../1c-standards/references/requirements.md#yaxunit):
`select_yaxunit_requirements`, exact complete patterns and the applicable phase's
ledger: design — proposal, review — result, change — both.

Select test patterns by context in `yaxunit`, and applicable work rules separately
in `corporate`, when supported by the assigned v8std. BSL snippets supplement this
route; reference API cards require contract reading and do not automatically become
requirements. For known modules/members choose targeted API cards under the
[live contract](../1c-standards/references/mcp.md), reusing full text from selection;
verify unknown installed APIs through index/EDT. Environment/runner-only diagnostics
need no authoring patterns. BSL changes also pass the general oneC gate through
$1c-code-change. Do not reload requirements without changed applicability.
Run/report-only needs no authoring patterns and does not authorize code changes.

Before writing establish observable behavior, test owner, client/server context,
setup/cleanup, data strategy, isolation, assertions and mock boundary. Tests verify
behavior rather than implementation internals. Prefer reusing suitable semantic
fixtures; otherwise use the narrow public `ЮТест.Данные()` API.
Choose values by field meaning, formats, units and relationships; a suitable
`ЮТПодражатель`/platform generator is preferable to random literals.
Mocks isolate external boundaries rather than the behavior under test.

Check declarative registration, registered method export/context, placement/naming,
deterministic setup and assertion correspondence to the full pattern.
Data must not depend on or damage arbitrary existing records.
Preserve cleanup/isolation on test failure under the applicable contract.

## Fluent chains

Multiline-chain indentation follows logical ownership under pattern/API rather
than identical return types or physical receivers:

- siblings start in the same column;
- children and their settings are one tab deeper than the owner;
- returning to an ancestor/next sibling restores its corresponding level.

For registration: module → set → test → test settings; the next test is a sibling.
Do not guess hierarchy from method names; resolve unknown ownership in the pattern.

## Execution and acceptance

Read [workflows](references/workflows.md) for the current operation;
read [testability](references/testability.md) only for a specific obstacle.
Agreement for actual effects follows the shared
[action policy](../1c-routing/references/action-policy.md).
Retain existing permission for the same test environment; source editing does not
authorize infobase launch.

Changes require focused EDT diagnostics, result compliance and the authoring gate;
verify behavior with the narrowest necessary run under authorized runtime effects.
If runtime is unavailable/unauthorized, report authoring results and unperformed
verification separately, without claiming test pass.
Unexpected `0` discovered/executed tests is failure, not pass.
Read-only design/review needs no runtime merely for a conclusion and authorizes
no fixes. Reports bind scope, job/run, counts and results; do not present
syntax-only checks, incomplete/unrelated reports or skipped checks as passing tests.
