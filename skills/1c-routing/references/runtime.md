# Runtime launch and breakpoints

Apply knowledge mode and capability availability from [routing](../SKILL.md).
Read only the needed launch/debug/profiling section and the selected operation's
live guide; full traversal of runtime and specialized EDT routes is unnecessary.

Check the chosen action's live guide: `launch` for startup, `set_breakpoint` or
`set_error_breakpoint` only for the corresponding configuration. Under the shared
[action policy](action-policy.md), use the already agreed target and actual effects;
source editing does not authorize infobase launch/modification.

Choose the exact launch configuration or established project/application pair.
Set `mode=run|debug` per guide; Attach supports debug. `updateBeforeLaunch` may
update the database by default; `externalInfobaseChanges=override` may overwrite
external changes. Without corresponding permission, use supported
`updateBeforeLaunch=false`, `externalInfobaseChanges=cancel`.
Refusal/modal dialogs do not authorize update/import. Retain
`standaloneServerPortConflict=cancel` unless port changes are authorized;
`restartIfRunning=true` terminates the client and requires restart scope.

`alreadyRunning` does not mean a new launch; request ID/ack does not prove startup,
attachment or successful update. Follow the same job/state; do not relaunch to
check. Preserve branch/infobase binding; `ignoreBranchBinding` requires permission
for the specific pair. Missing binding does not prove the correct database.
Binary import/export may also launch the platform and modify/read the infobase;
account for effects, retained jobs and unknown sync. Do not allow outdated export
without the required scope.

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

<a id="замер-производительности"></a>
## Performance measurement

For performance questions, choose one reproducible operation, data volume and exact
application/debug target. Launch, infobase changes and the scenario itself retain
shared action-policy requirements. From the current guide establish whether
collection is free and how results bind to a measurement: results may be shared
across EDT and contain only the last measurement even when state is filtered by
application.

Start collection only when the response confirms ownership of a new window.
Do not stop or replace someone else's active collection. For your window, finish
collection on success, error or interruption and read the result before the next
measurement. If the shared slot cannot be retained and attribution proven, do not
attribute rows to your task. Report unfinished cleanup separately.

Start with compact results and module/frequency filters; detailed timing/source
rows are needed only for candidates. Match them to the exact revision and launch
conditions. Truncation does not prove complete hot-spot coverage, and measurement
does not authorize refactoring. Before/after repetition is allowed under comparable
conditions and an authorized scenario, without parallel use of the shared result slot.
