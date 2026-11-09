---
name: bsl-ls-mcp
description: Run repository-local BSL LS diagnostics or semantic navigation for a specific file or symbol. Use focused diagnostics for changed BSL when enabled and prepared; never replace EDT primary validation or platform authority.
---

# BSL Language Server MCP

Read core_runtime_status once for this chat's binding; supply its known
projectRoot when the host supplied no directory. With existing project/instance
preparation permission, this connects BSL LS for native operations.
Use its returned detail for a connection failure. Do not open settings forms or
repeat full environment preparation merely because native tools were initially
absent; settings.inspect provides setup evidence without UI when needed.

Once status is connected, call
`core_runtime_tools` for the needed live schemas (`names` limits the response),
then `core_runtime_call` with `calls: [{name, arguments}]`. These controls are in
the initial catalogue and do not require a host tools/list refresh. Use
`detail: "names"` first if the needed native names are unknown. Supply this
chat's projectRoot on each control when host roots are empty. A short sequential
batch keeps registration and file analysis in one process even if the host uses
separate connections, but use it only when it is safe to proceed without inspecting
an earlier native result. Otherwise check the result before the dependent call and
retain the same bound relay session; if that is unavailable, report the limitation.
The relay stops on dispatch, transport or workflow failures and native top-level
`isError`, not on arbitrary per-item errors in a successful envelope. Interpret
results using the live contract; never repeat a failed batch blindly. Apply native
annotations and action policy to every call; the envelope grants no permissions.

Use the assigned mandatory EDT-MCP to discover exact configuration project names
and filesystem paths (`list_projects` with structured output when available).
`list_configurations` describes launch configurations, not source folders.
Do not scan for EDT projects or copy EDT discovery into the proxy.

Within the selected project directory, call BSL LS `list_workspace_folders` and
register the target configuration's project directory with
`register_workspace_folder` if missing. Register the configuration project directory
that holds sources, not an inner `src` or an individual module. A local config file
is optional and does not determine the registration root. Reuse the
returned URI as `workspaceFolder` for tools that require it; file tools select
their context from the exact file path. Several configurations can remain
registered and be used alternately without restarting the server. There is no
shared active-configuration setting or persistent repository selection.
Release an unneeded index through native `unregister_workspace_folder`.

The stdio connection owns its own BSL LS process and registrations. Another Codex
session can work on a different EDT project or the same directory independently.
Changing the outer selected directory/EDT binding invalidates dependent evidence
and starts a new scoped connection. Paths outside that directory are rejected;
select the correct project binding rather than widening it implicitly.
Require the native workspace-management API; a roots-only server is unsupported.

BSL LS reads optional `.bsl-language-server.json` using its own precedence.
In local managed mode an explicit `mcp.managed.bsl-ls.configuration` (including a
file named `bsl-language-server.json`) is supplied to the process and its registered
workspaces via both --configuration and -Dapp.configuration.path. For identical
settings across workspaces, keep one project file and set this path explicitly.
A relative path resolves from the selected profile root. External BSL LS does not
receive this local path; check its configuration on the external server. A
project-local override uses components.bsl-ls.configuration in
.ai/project.local.yaml; preserve other
settings. To inspect the resolved saved path and its source for this project and
instance, use `settings.read` in the selected settings session: read
`configurationValues.components["bsl-ls"].configuration` and
`configurationSources['["components","bsl-ls","configuration"]']` from
`structuredContent`. If host roots are empty, first bind that settings session with
`settings.inspect` and this chat's `projectRoot`; do not borrow another selection.
The saved path and source do not prove that the running analyzer applied the file.
Do not copy identical JSON into every configuration folder or change
user-wide defaults for one project. Per-workspace files are for actual independent
settings; verify the selected server's precedence before mixing both strategies.
configurationRoot locates 1C metadata; it does not select the analyzer JSON file.
Absence of an explicit file creates no configuration and does not disable native
workspace defaults. In managed mode changing the startup path reconnects this binding.
Read only relevant analyzer settings; change them only in a separately authorized
configuration task, never to hide findings or bypass source boundaries.
After a change, verify its effect through this chat's native API on the target
workspace/file. General service readiness or JSON syntax alone is insufficient.
If that API is unavailable, report the limit; do not add fallback copies of the
configuration. Read the relevant source paragraphs once, not whole manuals.

Analyze only the target symbol or changed BSL files. When a baseline exists,
classify findings as new, pre-existing, resolved, not applicable, or coverage-limited.
Re-analyze after a relevant correction; stop repeated unchanged failures and
report their cause. This skill does not itself authorize a source correction.

Stop when BSL LS answers the semantic/diagnostic question. Do not duplicate it in code-index. Use EDT only for a different authority: live state, metadata, platform truth, mutation, or primary validation.

Report only material diagnostics, classification, configuration effects, and coverage limits.
Use the shared [diagnostic assessment](../1c-routing/references/diagnostics.md)
to distinguish a confirmed defect, false positive, configuration/coverage issue,
and unresolved finding. BSL LS is not an unconditional correctness oracle;
neither its silence nor another analyzer's disagreement settles the finding.
