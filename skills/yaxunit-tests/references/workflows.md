# YaXUnit workflow

## Create/change

1. Establish expected behavior and minimal inputs/outcomes; choose related fixtures
   and isolation under the parent skill. Find tests through the profile-bound alias;
   investigate production dependencies only for specific unresolved facts.
2. Select general and YaXUnit requirements under the single normative workflow.
   Check proposal, declarative registration, export/context, fixture ownership,
   deterministic setup, assertion semantics and fluent hierarchy before writing.
3. Obtain a focused EDT baseline and use applicable write preconditions; change
   only the assigned test extension through EDT under $1c-code-change. Test-only
   files do not prove L: assess queries, state and production contracts by actual
   mechanisms.
4. On the actual result check affected authoring items, completed proposal/result
   compliance and the same EDT diagnostics. New mechanisms require selection
   review. Runtime pass does not replace normative verification.
5. When behavioral verification needs execution, use
   [Run and report](#run-and-report) within the authorized runtime scope.

## Design/review

Design checks a specific proposal with a proposal ledger, without writes/launch.
Review checks an existing test/revision with a result ledger, without proposal
or fixes. Missing runtime does not stop available static checks.
Apply general oneC workflow and test patterns to the same subject/phase;
do not send `debug` or `migrate` as operation to a oneC selector lacking those values.

## Run and report

For execution use the live `run_yaxunit_tests` guide. Choose the exact project,
launch configuration and the smallest filter that covers the needed tests.
Check database update, test-data writes and client launch/restart effects under
the shared [action policy](../../1c-routing/references/action-policy.md).
Run once and use a final report in the response directly. For a pending result,
follow the [original job](../../1c-routing/references/runtime.md#background-jobs-and-infobases).
For an unknown outcome, use the [relay rules](../../1c-routing/references/toolsets.md#calling-the-relay).

For report-only read the requested existing run report, using
`testing.yaxunit_config.results` to locate saved reports when applicable.

For any report, match the exact run, project, filter and completed assertions.
Report counts, time and run/job ID when available. Unexpected zero counts,
skipped or unfinished runs and missing reports cannot confirm a pass.

## Debug

Before changing code classify failure: test, product, data/environment or runner.
Debug without fix permission remains diagnostics. Restart and data modification
retain action policy regardless of mode name.
Read only source needed for that cause. Testability obstacles follow
[testability](testability.md); they do not expand production permission.
For debug use the live `run_yaxunit_tests` guide and `debug: true` when supported.
Use the debug launch handle from the response or the original pending job.
Pass that handle's target to the advertised `wait_for_break`. Verify test
acceptance from the final report of that run. Use the
[runtime contract](../../1c-routing/references/runtime.md).
Do not disable break-on-error globally as a routine prerequisite.
Preserve original breakpoints and restore the actual prior state of temporary changes.

Read-only review reports findings without fixes or mandatory runtime execution.
When a needed check is unavailable, state the exact reason and conclusion boundary.
