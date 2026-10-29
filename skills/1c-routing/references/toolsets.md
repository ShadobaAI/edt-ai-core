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

For a new binding, establish the required EDT project's exact name, canonical
path, type and open/ready state against the profile repository; check root
properties and compatibility only when the action depends on them. Do not choose
the first project or default configuration. Historical reading preserves the exact
revision and needs no current-model readiness unless it depends on that model.

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

## Exposing needed tools

Once `core_runtime_status` confirms connection, obtain live schemas through
`core_runtime_tools` (exact names in
`names`), then use `core_runtime_call` with `calls: [{name, arguments}]`.
With empty host roots, pass this chat's directory as `projectRoot` in every control
call. A short sequential group preserves workspace registration and analysis in
one process despite separate host connections.
Permissions, source workflow and action policy apply to each native operation.
Errors stop the group; completed operations are not rolled back, and the whole
group must not be retried without outcome verification. This is a live API without
a built-in external tool catalogue or bypass of project restrictions.

1. Establish the live native catalogue through `core_runtime_tools` and
   `list_toolsets` when their state is unknown. Use `detail: "names"` before
   requesting the needed full schemas when names are unknown.
   Start with management/core/read and only task-required groups. Use live schemas
   and `get_tool_guide`: group enabling varies by version. Do not invent enable
   tools, parameters or server preferences from old examples.
2. If the needed operation is not visible, distinguish a disabled group,
   unsupported progressive disclosure, a broad initial list and a truly absent
   capability. Use supported enable for the needed group when available, then
   refresh the native definitions via core_runtime_tools. The relay exposes the
   current native schemas but does not enable groups on its own.
   Do not replace server-disabled capabilities with neighboring authorities.
   If the server initially exposes a broad surface, do not claim progressive
   disclosure schema savings or emulate them with local name filters. Changing
   the user's server mode is a separate setting, not task preflight.
3. Reuse successfully exposed groups and sufficient schemas/guides in the same
   session. Reconnect/restart, binding/URL changes, relevant errors or contradictions
   invalidate affected facts; recheck only the needed portion.
   Do not edit user settings to change disclosure mode. core_runtime_tools refreshes
   the native catalogue without push notifications; ordinary reads/writes must not reload
   all schemas. After the scenario, hide an unneeded group only when supported by
   the live guide and ownership of that state is proven; server-wide reset is not
   session cleanup.
4. For EDT retain management access and all authorized operations. Do not add
   `enabled_tools`/`disabled_tools`, blanket allowlists or name filters in the hook;
   a new name alone does not require agreement. Check actual effects under the
   shared [action policy](action-policy.md).

This EDT disclosure rule does not apply to OpenViking. Knowledge is accessible
only through separate `knowledge_status`, `knowledge_search`, `knowledge_read`.
Do not expose upstream tools through native relay, `core_runtime_call` or direct
connections to bypass restrictions. New/changed knowledge tools require external
confirmation of authorized capabilities and rights; `readOnlyHint` does not grant
permission. Writes, deletion, publication, ACL, session takeover and personal areas
are forbidden regardless of shared action policy or EDT disclosure mode.

Read structuredContent and embedded guide resources; text acks do not prove
successful enabling, project readiness or operation completion. A `jobId` belongs
to one execution: follow it through supported status calls; do not repeat a writer
after timeout. State unavailable groups and dependent-route stopping reasons explicitly.

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
