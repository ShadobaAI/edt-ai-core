---
name: vanessa-ui-tests
description: Design, review, author, research, record, run or debug Vanessa Gherkin UI scenarios when enabled by the project profile. Choose static or runtime work from the request; not product source changes or unit tests.
---

# Vanessa UI tests

## Binding and knowledge

Apply knowledge mode and source roles from $1c-routing; apply shared reuse/sufficiency
checks when selecting new steps/mechanisms and checking diffs.
Authoring, review and execution are not interchangeable. Permission to change UI
tests does not authorize product source or framework changes; failed runs do not
authorize fixing them.

Check `testing.vanessa` and `testing.vanessa_config`: test `repository_id`,
`features`, `results`, `runtime_profile` and `server_name`.
For runtime operations read local runtime JSON: it defines actual manager/TestClient
bases, platform, Vanessa and endpoint; its machine-specific settings are not
portable project-profile content. Do not infer bases from server names or use
another project's client. Product source changes use a separate EDT workflow;
UI tests do not authorize them.

Obtain Vanessa facts, syntax, recipes and version limits from `v8std`, not copied
upstream prompts. Read known IDs directly as documents/sections; check `found`,
ID and complete body. For selected design/review/authoring use context selection
in supported `vanessa` with a brief goal, scenario structure and affected mechanisms.
Select applicable corporate rules separately in `collections=[corporate]`;
general top-N may hide a corpus.
The [shared discovery contract](../1c-standards/references/discovery.md) defines
candidate, exact-text and exception assessment.
Do not submit Gherkin for BSL/SDBL selection. Another framework's specialized card
does not replace exact Vanessa documents; choose by the
[live contract](../1c-standards/references/mcp.md).
Additionally search unfamiliar topics boundedly in `collections=[vanessa]`.
`vanessa:patterns:catalog` helps choose only needed recipes:

- setup: `vanessa:patterns:environment-readiness`;
- research/recording: `vanessa:patterns:exploration-recording`;
- structure/authoring: `project-layout`, `feature-sections`, `steps-assertions`;
- reuse/data: `subscenarios-and-libraries`, `scenario-outlines`, `test-data-strategies`;
- execution: `execution-debugging`; failure: `failure-classification`, `modal-dialogs`.

Short names above share the `vanessa:patterns:` prefix. Tool cards
`vanessa:mcp:<tool>` explain semantics; current full `tools/list` defines schema.
Do not guess another version's parameters. Unconfirmed mandatory contracts block
dependent operations. Database structure/reset examples are not universal
requirements. Retain sufficient facts already obtained.
In static reports bind applicable requirements to feature/revision/scenario,
condition, strength and verification result (`passed`, `failed`, `unverified`;
justified `deviated` only for recommended conditions). Proposal and actual-result
evidence differ; retain findings/unchecked conditions.
Policy has no Gherkin selector: do not substitute BSL/YaXUnit artifacts for a feature
to obtain `ledger_valid`. This records normative verification, separately from
runtime run receipts.

## Work mode

- **Design/review**: investigate the scenario and business result; report the
  solution/findings. No feature writes, manager connection, launch, recording or receipt.
- **Author/change**: modify authorized UTF-8 features, preserving conventions.
  Reuse standard steps, subscenarios and data. Navigation without business-result
  verification is an insufficient assertion. Static authoring needs neither local
  runtime JSON nor running 1C; explicitly state unchecked runtime syntax/runs.
- **Research/record**: use live sessions only for needed research and authorized
  UI effects. Recording observations alone does not authorize feature changes.
- **Run/report-only**: execute a selected existing scenario or analyze an existing
  report. Report-only does not launch new tests. Failure does not authorize
  feature/product fixes.
- **Debug**: classify failure first. Change tests only when the assignment includes
  fixes; otherwise report the cause and verified evidence.

Read needed recipes for the selected mode. Static verification and executed runtime
tests have separate results; authoring does not promise runtime pass.

## Runtime work cycle

These steps apply only to selected runtime operations, not as mandatory setup for
design/review/offline authoring.

1. Read the feature and expected business result. Check actual manager environment,
   exact TestClient base, VanessaExt/VAExtension, versions, idle/execution/recording
   state and session ownership. Do not interrupt others' work. Apply shared
   [action policy](../1c-routing/references/action-policy.md) to launch and data effects.
2. For research/recording investigate needed UI/fixtures through form analysis and
   internal element names. Start recording before target actions only with
   established ownership; retain observed steps/assertions. Do not create unagreed
   fixtures or modify arbitrary existing records.
3. Before run open/load the exact file, perform `check_syntax`, independently confirm
   exact file, scenario and executable text. Run only the needed scenario from
   the beginning; run-from-step is allowed only for diagnostics.
4. After actual execution read `get_test_results` and bind it to the same
   file/hash/scenario/run. On failure investigate the actual form and screenshot
   of the verified TestClient window. If PID is unknown, do not repeat discovery
   indefinitely: use an available UI tool only with independent window confirmation;
   ambiguity blocks visual diagnosis. For `paused_modal_dialog`, handle the observed
   dialog only within authorized UI/data scope, then continue remaining chain actions.
5. In fix-authorized mode update stale tests from evidence; do not weaken expectations
   to accommodate product defects. Rerun only with a reason.
   Do not repeat an identical unchanged failure. Mutation timeouts require actual
   state verification before another attempt. Separate test/product/data/
   infrastructure failures.

## Acceptance

Prefer configured native MCP. If unavailable in chat, bundled CLI and Single/MCP
editor transition are described in [CLI workflow](references/cli-workflow.md).
No Kafka or upstream Vanessa checkout is required, but users separately provide
actual runtime and platform. CLI does not authorize side effects.

For actual execution retain a run receipt in `results` under the
[receipt contract](references/receipts.md); static mode creates none.
A `completed` control chain does not mean a `passed` test.
Syntax-only checks, mid-scenario runs, skipped/old/incomplete results do not confirm
test pass. Reports distinguish selected-mode results, syntax/run outcomes and
unchecked parts; reference receipts only for actual execution.
Leave manager/TestClient available unless closing them is part of the task.
