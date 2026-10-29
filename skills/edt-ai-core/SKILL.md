---
name: edt-ai-core
description: Guide users through 1C AI Core setup in chat, create or review project AGENTS.md, configure connections, initialize or transfer project profiles, and diagnose managed MCP runtimes.
---

# 1C AI Core setup

## Start with one snapshot

Use settings.inspect as the primary chat setup interface. Native/manual settings
use the same backend. Do not require a form, YAML knowledge or a technical questionnaire.
Open a settings form only when the user asks to open/show the form or chooses
the plugin's settings UI. A request to configure settings in chat stays in chat.
A request to analyze code,
test BSL LS or diagnose a runtime does not authorize opening settings UI.
settings.inspect/check and settings.operation return data without a form.
Discover this installed plugin's tools first; a loaded skill alone does not prove
its MCP is connected. If inspect is unavailable but settings.read exists, read once.
If both are absent, diagnose the local executor/settings-server startup evidence;
do not ask for endpoints, create a profile, inspect product source or suggest
another chat before correcting the actual connection problem.

1. Call settings.inspect once. If this chat's local directory is already known,
   include projectRoot immediately; never borrow another chat's directory or use
   the plugin source repository as a 1C project. Ask for a folder only when the
   current chat's directory is genuinely unknown. Ambiguous/error host roots
   must be resolved in Codex; they cannot be overridden by an argument.
2. Reuse project instructions already supplied in this chat; read missing relevant
   context from .ai/PROJECT.md and linked rules once. Before editing, obtain the
   current text of each target file; do not reread whole documents just for preflight.
   Check applicable AGENTS.override.md and nested instructions as described in
   [project instructions](references/project-instructions.md). Reuse the snapshot's
   profile status, coreVersion/compatibility, mappings, detected EDT names/port,
   effective connection sources, preparation authorization and nextSteps.
   An already loaded profile needs no settings.profile or settings.load preflight.
3. Address only unresolved facts. Reuse prior intent/authorization and known
   settings. Ask one plain-language question only for a missing decision. Do not
   search OpenAI docs, other chats, plugin source or global configuration merely
   to run this documented setup flow. Read a route reference only when needed.

## Save only actual changes

- Create a missing generic profile with settings.create under the user's setup
  request. Never replace an existing profile to repair it. A template still needs
  explicit repository mappings before development.
- When creating a profile or asked to create/review project AGENTS.md, follow
  [project instructions](references/project-instructions.md). Creation returns
  projectInstructions.created/preserved with contentValidated=false; finish the
  project-specific rules from confirmed facts and preserve existing instructions.
  A valid profile or ready environment does not prove those rules are complete.
- For an invalid existing profile, settings.edit returns its repairable document
  and baseRevision. Use that document and the validation detail from inspect;
  do not reverse-engineer scripts or export/read the profile repeatedly.
- For edits use settings.preview/apply with mode=edit and the same baseRevision.
  This is a full document: omitted runtime fields reset to defaults. Keep other
  values intact. Explain shared runtime changes; replacing an existing profile
  requires explicit agreement, reviewed preview and backup. A stale revision
  requires a fresh document and reconciliation, never an automatic retry.
- For supplied portable files use preview/apply import semantics. settings.import
  only opens the form. For a simple connection/component change use settings.update
  with changed fields only; respect read-only/environment/connection-file sources.
  Both form entrypoints, chat tools and the Node CLI use SettingsBackend with
  the same selected root, instance and precedence. OpenViking transport fields
  are openvikingEnabled/Url/Timeout/MaxResponseBytes/HeadersEnv; HeadersEnv is a
  complete map of header names to environment variable names, never secrets.
  OpenViking is optional and disabled by default. Its enabled flag is independent
  of the URL: to connect under the user's request, explicitly set
  openvikingEnabled=true. Changing a URL does not enable a disabled transport.
  Disabling it preserves the URL, knowledge mode and requirements; mandatory
  knowledge and KORA gates still block their dependent work.
  Read valueSources per field: a URL source does not describe all transport fields.
- Detection never overrides an explicit URL. If inspect reports a conflicting
  EDT port, verify the assigned endpoint/projects before proposing an override.
  Do not guess endpoints. OpenViking uses the dedicated knowledge adapter;
  changing transport never changes profile knowledge mode or requirements.
- Inspect once after the final save to verify effective values and sources.
  Do not reload after apply/update unless the response identifies a real need.

For an analyzer configuration task, read only the configuration paragraph in
[$bsl-ls-mcp](../bsl-ls-mcp/SKILL.md). Shared workspace settings use one explicit
file; do not duplicate identical JSON files across configuration directories.

## Connect existing knowledge

Keep the profile's explicit knowledge choice: disabled (`provider: none`),
transitional with selected collections, or KORA with mandatory knowledge for
the whole workflow. Change that choice only under the user's settings request.
Use inspect.knowledge/knowledgeSetup and valueSources. For OpenViking obtain
the assigned MCP endpoint, collection IDs/URIs, environment variable names for
search credentials and external access/publication confirmations from the team.
Connect that existing server; do not install OpenViking, create a corpus, index,
publish, guess a URL or substitute another authority when readiness fails.
Use edit/preview/apply to set the project knowledge contract and update for
instance transport. Preserve unrelated fields and existing overrides. Missing
inputs remain explicit blockers; an empty endpoint never disables requirements.
If knowledge stays disabled, do not probe OpenViking or claim corpus coverage.

## Verify without repeated probes

- Call settings.probe_connections once for configured EDT/v8std and enabled
  OpenViking. It verifies
  protocol connections and, when exposed, exact EDT names/paths/open/readiness.
  A connected server with unverified/mismatched projects is not ready for writes.
  OpenViking setup acceptance covers the selected collections and snapshot;
  each workflow must establish readiness in its own bound knowledge session.
- Preparation may download and launch managed services. Use settings.run_check
  only with the user's actual authorization and current preparationScope. Prior
  scoped permission persists; do not ask again. Profile inspection never launches
  managed services. Do not repeat preparation to check an index still building.
- For any returned operation ID use settings.operation with waitMs=10000 (or a
  shorter bounded wait). Reuse its eventual result; do not repeat the operation,
  run doctor again, poll immediately in a loop or dump full native schemas.
- Check only necessary chat relays. If their selectedDirectory is empty, pass this
  chat's known projectRoot to each relay's core_runtime_status once. This binds
  only that MCP session and preserves host/environment locks and other chats.
  For prepared managed services, this call connects the scoped process and
  makes its native API available under the existing preparation permission. It does
  not require a prior tool-list refresh or another full settings.run_check.
  Settings-form selection does not bind other MCP sessions. Use core_runtime_tools for
  live schemas and core_runtime_call for a bounded sequential calls batch.
  Supply the same chat projectRoot when host roots are empty. Native permissions,
  source workflow and action policy apply to every call; group BSL registration
  and file analysis when the host uses separate connections. Do not spawn shell
  relays, change global selection or recommend new chats/restarts for empty roots.
- Preserve native server instructions/capabilities returned by a new binding and
  reuse them. A project still building needs a later readiness check, not a new
  installation. Distinguish saved settings, preparation, external acceptance and
  the current chat's actual binding. Never claim full readiness from URL presence.

## Manual settings

When asked to open settings from a chat, call settings.profile with the known
directory of this chat as projectRoot, even if settings.inspect already ran.
This carries scope into the form when its app calls use a separate MCP connection.
Never use the latest history/log entry as evidence of the current chat's directory.
It opens the same
form scoped to this project, without a profile chooser; its thread entrypoint
is “Настройки проекта”. The app-only settings.open global entrypoint opens the
full “Настройки” workspace with the user's profile list through Open plugin or
app navigation. This is the full settings interface; there is no separate
structured-settings section on the plugin-details page. Removing that section
does not remove the global entrypoint or the chat's project settings.
If the app is absent, check discovery; do not claim
that chat is the only interface or that a successful tool call proves rendering.
Both interfaces share scope and backend. Skill switches belong to Codex.

For advanced runtime, CLI, authority or project-binding questions, read only the
relevant part of [the runtime contract](references/runtime-contract.md).
For user commands see [the usage guide](../../docs/USAGE.md).
