# Runtime launch and breakpoints

Apply knowledge mode and capability availability from [routing](../SKILL.md).
Use the relevant section and the selected operation's live schema/guide.
Apply the shared [action policy](action-policy.md) to the exact target and effects.

Choose the exact launch configuration or established project/application pair.
Set `mode=run|debug` per guide; Attach supports debug. `updateBeforeLaunch` may
update the database by default; `externalInfobaseChanges=override` may overwrite
external changes. Without corresponding permission, use supported
`updateBeforeLaunch=false`, `externalInfobaseChanges=cancel`.
Refusal/modal dialogs do not authorize update/import. Retain
`standaloneServerPortConflict=cancel` unless port changes are authorized;
`restartIfRunning=true` terminates the client and requires restart scope.

For `launching` or a bare acknowledgement, check the original startup or attachment
using the returned application/configuration, or the original request's exact
target when the acknowledgement omits it. `alreadyRunning` identifies a
pre-existing launch. Use a finite deadline and stop at the required state or
a correlated failure such as `abandoned` or `debug_status.recentLaunchFailures`.
If a `jobId` is returned, follow the [original job](#background-jobs-and-infobases).
Wait while `starting` or `synchronizing`; do not terminate or relaunch. An application
filter can hide failures with no resolved application. When wider status is in
scope, correlate by configuration and time. Apply the
[outcome contract](toolsets.md#calling-the-relay) if startup remains unverified.

Preserve branch/infobase binding. `ignoreBranchBinding` requires permission
for the specific pair. Missing binding does not prove the correct database.
Binary import/export may also launch the platform and modify/read the infobase;
account for effects, retained jobs and unknown sync. Do not allow outdated export
without the required scope.

## Background jobs and infobases

Keep the returned `jobId` with its originating operation, instance, endpoint
and target. Use the supported `get_job_status` and `waitSeconds` below the
transport timeout. Stop at a terminal state or the verification deadline.
Report failure or cancellation and verify any partial effects. For `done`,
inspect the native operation's result, including Markdown and item errors, before relying on its
effect. If no status is available or the job is missing/expired, verify the exact
target state. Report an unverified effect when neither source settles it, and
apply the [relay retry rule](toolsets.md#calling-the-relay). Use cancellation
preview only for an in-scope owned job.

For `update_database`, preview the exact infobase and account for client
termination, branch binding and database scope before confirmation. A server
that returns a pending update needs confirmed completion of the update before a
dependent launch or test.
For session, extension and standalone server tools, use read modes for
investigation and verify permission for the specific state-changing action.

## Breakpoint configuration

Before temporarily changing breakpoints, read prior IDs/settings. Omitted
`condition`/`hitCount` for a line breakpoint may clear them: verify applied
conditions and degradation; a marker does not prove a runtime stop.
An error breakpoint may affect the entire EDT workspace; single-project scope
does not authorize it. Its omitted message filter may persist; an empty string
may clear it. Restore the actual prior state and all returned IDs; do not enable
previously disabled entries or delete user breakpoints as cleanup.

## Investigating a running application

Start with minimal runtime state or a bounded log window for the required
application, rather than a new launch. With multiple debug targets, pass the
supported exact selector; one selected `projectName` does not prove workspace-wide
debugger isolation. After each new stop/step refresh frame/thread and read only
needed variables, depth and collection volume. Old frame IDs do not transfer to
the next stop. Evaluation may execute arbitrary code, and variable changes may
modify data: these are separate actual effects even within read-only investigation.
Resume only execution suspended by this task; do not terminate another client or
restore an assumed state.

## Performance measurement

For performance questions, choose one reproducible operation, data volume and exact
application/debug target. Launch, infobase changes and the scenario itself retain
shared action-policy requirements. Check how the live contract addresses the
slot and binds its results. A shared slot can hold only the last result even
when state is filtered by application.

Leave a known active window alone. If starting can replace an active window,
confirm the slot is free before calling start. Use the exact debug target.
Run the scenario only after the response confirms that this call opened a measurement (for example,
`started: true`). An already active measurement confers no ownership. Finish your
own window on success, error or interruption and read its result before the next
measurement. Attribute rows only when you can tie them to your window. Report
unfinished cleanup separately.

Start with compact results and module/frequency filters; detailed timing/source
rows are needed only for candidates. Match them to the exact revision and launch
conditions. Truncation does not prove complete hot-spot coverage, and measurement
does not authorize refactoring. Before/after repetition is allowed under comparable
conditions and an authorized scenario, without parallel use of the shared result slot.

When profiling returns a measurement ID, use it to select the summary and
subsequent filtered pages. Use a comparison only for attributable measurements
under equivalent conditions.

For a technological journal, start with an existing authorized capture when
available. Use a bounded `get_tech_log` summary, then request details for one
group or occurrence using the same time window and filters. Check coverage and
budget exhaustion before drawing conclusions. When a new capture is authorized,
preview through `manage_tech_log` and check scope, ownership and restoration
before starting. A capture may change user-wide platform configuration and
collect events from several processes. Stop the capture you started and verify
restoration before closing the task.
