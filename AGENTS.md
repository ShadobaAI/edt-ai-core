# Working on 1C AI Core

This repository contains one universal `1c-ai-core` plugin for Codex.
The repository root is the plugin root. This is Node.js ESM, not a 1C configuration:
ordinary plugin code changes and local tests do not require EDT.

## Navigation

- `plugin.json`, `mcp.json`, `hooks/hooks.json` — Codex entrypoints.
- `scripts/` — profiles, directory selection, settings, runtime and diagnostics.
- `mcp/`, `ui/` — settings MCP server, form and BSL LS proxy.
- `policy/`, `hooks/` — normative protocol, action policy and source protection.
- `skills/` — agent instructions; `schemas/` — data contracts.
- `profiles/generic-1c/`, `settings/`, `runtime/`, `knowledge/` — defaults and templates.
- `vanessa/` — Vanessa integration; `tests/` — regressions.
- `tools/`, `packaging/`, `.github/` — building and releases.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — architecture;
  [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — developer commands.

## Change boundaries

Verify claims against current code, schemas and tests, accounting for existing
uncommitted changes. A “planned” documentation status does not prove implementation.
OpenViking and infobase MCP are described in [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md).

The plugin is project-independent. Only `generic-1c` is bundled.
Real profiles, endpoints, credentials, local paths and instance bindings belong
to projects or user state. Do not restore CRM/Kafka profiles or local exports
to the distribution.

Before migrating behavior from source environments, read
`skills/catalog.yaml` (`migration_decisions`) and `skills/README.md`.
Sources are listed in [docs/SOURCES.md](docs/SOURCES.md).
`1c-docs-mcp` (HelpSearchServer) and `1c-ssl-mcp` are excluded, including optional
and fallback connections. Assess EDT/code-index route sufficiency and knowledge
base readiness separately from these servers' absence.

Preserve directory, instance and MCP session isolation. Profile history and
`active_project` do not confirm project selection in another chat. Do not weaken
path checks, schema validation, source protection or the shared action policy.
Do not pin an external MCP tool catalogue instead of checking its live API.

## Verification

Initial setup requires Node.js 22+ and dev dependencies:

```sh
npm ci --ignore-scripts
node tools/vendor.mjs
```

Run checks for the changed area, for example
`node --test tests/test-profiles.mjs`. The full suite is `node tools/test.mjs`.
For documentation, check links, examples and consistency with implementation.
Local tests do not prove live acceptance of EDT, v8std, 1C tests or Codex UI;
distinguish verified facts from limitations in reports.

**Do not automatically build the plugin at the end of every task.** Build only
on user request or to verify packaging/distribution changes. In that case run
`node tools/package-plugin.mjs` and
`node tools/check-plugin.mjs .build/marketplace/plugins/1c-ai-core`.
When paths or contents change, align `scripts/package_layout.mjs`, package checks,
CI, tests and documentation. Local state and dev tools must not enter the ZIP.
Do not publish anything on your own.

Python, PowerShell and Bash are not runtime, test or CI dependencies.
`tools/build-plugin.sh` is an optional dev wrapper around the Node builder.
JS dependencies and prebuilt Windows Koffi modules are bundled;
users do not run npm install.

Code, skills and documentation are distributed under MPL 2.0: preserve `LICENSE`,
`NOTICE.md`, `UNICODE-LICENSE.txt` and borrowed component licenses.
