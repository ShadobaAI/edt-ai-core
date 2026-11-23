# EDT toolsets and MCP update checks

Apply when EDT capabilities are unknown, a needed group is unavailable, on reconnect
or an explicitly requested MCP update check. Ordinary tasks do not require auditing
all servers and tools. Binding comes from the selected directory and instance;
tool availability does not expand authorized scope or effects.

## Connections and parallel projects

Each independently selected profile/directory/configuration needs its own
user-launched EDT-MCP assigned by the effective URL. The plugin does not launch
EDT. A linked base and extensions of one profile may share a workspace only through
explicit repository mappings. A neighboring endpoint or shared `active_project`
does not replace a missing connection for the selected environment.

For model-dependent operations, confirm the required EDT project's exact name,
canonical path, type and open/ready state against the profile repository.
Check root properties and compatibility when the operation depends on them.
Do not choose the first project or default configuration. Model-independent
historical reads require the exact revision rather than a ready current model.

Bind evidence and opaque IDs to directory, instance, URL, EDT project and
revision/stage. Do not transfer jobs, launches, hashes, cursors or readiness between
environments when switching. Determine an already submitted operation's outcome
through its original endpoint; a new session does not authorize writer retries.
One connection's failure stops its dependent route, not other projects.

Separate HTTP sessions do not isolate toolsets, debugger, comparison slot or the
last profiling result within one EDT. With a shared endpoint, establish ownership
of shared state; do not disable others' groups/measurements or reset the workspace
for your task. Connection checks invalidate only the selected directory/instance
binding; they do not prove live EDT/v8std readiness.

## Request and context budget

Choose the cheapest response that directly resolves the question. Read known
methods directly without a mandatory map first; obtain structure or summaries for
unknown areas. Do not chain count → list → full text when the target is known.
Use available server filters, field selection, compact/concise modes and small
limits; do not dump workspaces for client-side filtering. Combine independent reads
in supported bounded batches.

Narrow diagnostics to affected owners and relevant problem classes; summaries
orient an unknown scope rather than serving as a second mandatory call.
An owning metadata node is initially sufficient; request full collections, XML,
images and expanded documentation only for missing facts. For layout start with a
compact model; screenshots serve visual acceptance.

Structured results and embedded resources are response data: a short text digest
does not replace them. Do not reread the same output in a different format.
Retain truncation/cursors and continue only until evidence is sufficient; a negative
conclusion about the whole scope requires complete relevant coverage. Do not mix
pages from one revision with the next snapshot.

Reuse schemas, guides and source evidence within the same binding while current.
After relevant mutation/checkout refresh only affected data; diagnostics, runtime
and render state require current state. Do not create a shared cross-project cache.
For long operations prefer supported async jobs and bounded waits shorter than
transport timeout; avoid frequent zero polling or rerunning for status.

## Calling the relay

Use `core_runtime_tools` with exact `names` to reuse the binding's live catalogue.
Use `detail: "names"` for unknown names. Unfiltered requests and misses normally
refresh it. With `refresh: false` a current snapshot can serve even a miss.
An observed list change or attempted EDT disclosure invalidates the snapshot.
Set `refresh: true` when a preference change, peer action or contradictory
schema evidence suggests a change HTTP may have missed.
After a failed refresh, the next lookup or call refreshes the upstream catalogue
before using it. Request only the definitions needed in the response.
With empty host roots, pass this chat's `projectRoot` in each control call.
The controls are in the initial host catalogue and bind on demand. Use
`core_runtime_status` when you need the binding, connection state or negotiated
instructions that are missing from current evidence.

Send authorized operations through `core_runtime_call` with
`calls: [{name, arguments}]`. Apply the action policy to each call and use
[v8std's configured scope](../../1c-standards/SKILL.md) for normative retrieval.
Dispatch, transport and workflow failures or top-level `isError` stop the group
without rollback. Use the one-based `actions` positions for repeated names.
`executionOutcome` distinguishes no dispatch (`not_executed`), an unconfirmed
outcome after dispatch (`outcome_unknown`), and a received native response
(`completed`, including errors).
`completed` and `stopped.completedActions` count or list responses without
top-level `isError`, including `response_ok_workflow_stopped` after a failed
workflow recheck.

The relay does not stop on item-level errors. Inspect native `content` and
`structuredContent` in `structuredContent.results`, including partial effects
after errors. Use `compact: true` when advertised and that field is readable by
the client.
Use normal mode for top-level media or resource rendering. Perform calls
separately when the next depends on inspecting the previous result. Keep tool
registrations in the same relay session. If the host cannot retain that session,
group only operations safe to continue without inspecting intermediate results.
For a mutation with only an acknowledgement, partial effects or an unknown
outcome, verify the original operation through its original binding. Use the
job or documented status and an exact read of the affected state if needed.
If the required effect remains unverified, stop dependent work and report the
gap. Verify confirmed effects as the result. Retry only for a missing effect
after resolving the original outcome, ruling out a still-running operation and
rechecking applicable prerequisites. Follow pending EDT jobs
under the [runtime contract](runtime.md#background-jobs-and-infobases).

## Exposing EDT toolsets

1. Try the exact schemas first. When names are unknown, use `detail: "names"`.
   Consult the relevant `get_tool_guide` only for a contract the schema leaves
   unclear. Where supported, request `mode: "summary"`, a known `section`
   or a focused `query`. The guide can arrive as an embedded resource.
2. For an unadvertised tool, use `list_toolsets` if available. A member of a
   hidden group is a candidate for disclosure if `progressiveDisclosure` is on.
   Use the live `enable_toolset` schema for just that group and fetch the needed
   definitions again. Inspect per-group results. If the group is visible and a
   known member is still missing from a fresh catalogue, check effective server
   enablement or the active preset. If neither the catalogue nor group data
   establishes membership, report the capability as unadvertised for this
   binding. A missing management tool leaves the cause unverified.
3. With Progressive Disclosure off, use the already advertised surface.
   Disclosure changes visibility only. Server preferences and presets control
   enablement. Preserve the owner's settings. Hide a group only when ownership
   of its visibility is confirmed and the live schema supports it. Treat a
   timed-out reveal as uncertain and reread visibility before deciding to repeat it.
4. For EDT retain management access and all authorized operations. Do not add
   `enabled_tools`/`disabled_tools`, blanket allowlists or name filters in the hook;
   a new name alone does not require agreement. Check actual effects under the
   shared [action policy](action-policy.md).

EDT disclosure applies only to EDT. Use the separate
[knowledge adapter routes](../SKILL.md#knowledge-dependency) for OpenViking.

Check actual visibility after disclosure. For `jobId` and pending outcomes, use
the [background job contract](runtime.md#background-jobs-and-infobases).

## MCP update check

For an explicitly requested toolkit/configuration update audit, check initialize,
`get_server_status`, complete tools/list, list_toolsets and guides only for changed
operations. Retain negotiated protocol/session ID; restart requires new initialize,
and old session facts/IDs are no longer current.

This is a read-only capability check. Do not change business source, launch
infobases, tests, import/export or cleanup merely to demonstrate tool availability.
Project-aware navigation, metadata, diagnostics and mutation smoke checks require
an exact ready test project and corresponding authorized scope. Distinguish
tool availability from actually performed checks.

For usage audits, use available server statistics only within a bounded window and
for relevant operations: metadata/counts and size aggregates suffice to locate
expensive responses. Do not dump raw history bodies; they may contain other tasks'
data from the same EDT. Payload size or token estimates do not equal actual limit
consumption. Such audits are not preflight for every task; compare equivalent scenarios.

Check v8std only for the needed route: general standards, `corporate:work:*` rules
or YaXUnit patterns through $1c-standards. Do not load all corpora to audit EDT.
Report unchecked runtime/normative gates separately.
