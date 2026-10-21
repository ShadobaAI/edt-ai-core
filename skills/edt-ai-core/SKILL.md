---
name: edt-ai-core
description: Guide users through 1C AI Core setup in chat, configure connections, initialize or transfer project profiles, and diagnose managed MCP runtimes.
---

# 1C AI Core setup

## Start with one snapshot

Use settings.inspect as the primary chat setup interface. Native/manual settings
use the same backend. Do not require a form, YAML knowledge or a technical questionnaire.
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
2. Read project AGENTS.md and .ai/PROJECT.md once when present. Reuse the snapshot's
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
- Detection never overrides an explicit URL. If inspect reports a conflicting
  EDT port, verify the assigned endpoint/projects before proposing an override.
  Do not guess endpoints. OpenViking is reserved configuration, not a connection.
- Inspect once after the final save to verify effective values and sources.
  Do not reload after apply/update unless the response identifies a real need.

## Verify without repeated probes

- Call settings.probe_connections once for configured EDT/v8std. It verifies
  protocol connections and, when exposed, exact EDT names/paths/open/readiness.
  A connected server with unverified/mismatched projects is not ready for writes.
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
  Settings-form selection does not bind other MCP sessions. Do not spawn shell
  relays, change global selection or recommend new chats/restarts for empty roots.
- Preserve native server instructions/capabilities returned by a new binding and
  reuse them. A project still building needs a later readiness check, not a new
  installation. Distinguish saved settings, preparation, external acceptance and
  the current chat's actual binding. Never claim full readiness from URL presence.

## Manual settings

Call settings.open when requested. Its “Настройки 1C AI Core” global app entrypoint
also opens from the host's plugin apps/navigation without a chat. The separate
openai/settings native layout contributes fields and that App action to plugin
details when rendered by the host. If it is absent, check discovery; do not claim
that chat is the only interface or that a successful tool call proves rendering.
Both interfaces share scope and backend. Skill switches belong to Codex.

For advanced runtime, CLI, authority or project-binding questions, read only the
relevant part of [the runtime contract](references/runtime-contract.md).
For user commands see [the usage guide](../../docs/USAGE.md).
