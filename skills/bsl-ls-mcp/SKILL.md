---
name: bsl-ls-mcp
description: Run repository-local BSL LS diagnostics or semantic navigation for a specific file or symbol. Use focused diagnostics for changed BSL when enabled and prepared; never replace EDT primary validation or platform authority.
---

# BSL Language Server MCP

Interpret findings through the shared
[diagnostic assessment](../1c-routing/references/diagnostics.md): relate them to
the task, applicable requirements and the benefit/cost of a correction.

Use the [relay controls](../1c-routing/references/toolsets.md#calling-the-relay)
for schemas and calls in the prepared managed or configured external binding.
If a connection fails, inspect its detail and use `settings.inspect` for missing
setup evidence. An initially absent native tool does not require a form or
new preparation. Registration and analysis belong to the same BSL LS session.
Batch them only if analysis can proceed without inspecting registration first.

Reuse verified configuration names and paths from the assigned EDT-MCP.
For a missing path, use its `list_projects` with structured output when available.
`list_configurations` describes launch configurations, not source folders.
Do not scan for EDT projects or copy EDT discovery into the proxy.

Reuse a verified workspace registration in the selected BSL LS session. When
registration is unknown, call `list_workspace_folders`. If the target is absent,
register its configuration project directory with `register_workspace_folder`.
Use the configuration project root that owns the sources. A local config file
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

Analyze the target symbol or changed BSL files. Re-analyze after a relevant
correction and stop at a sufficient result or a repeated unchanged failure.
Use code-index or EDT only for a distinct missing fact or a separately required
check. Report material diagnostics, classification, configuration effects and
coverage limits under the shared assessment contract.
