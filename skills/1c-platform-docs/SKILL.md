---
name: 1c-platform-docs
description: Verify 1C platform APIs and compatibility through the profile-selected EDT, or inspect installed BSP API contracts through code-index. Use for API reference and platform mechanisms, not standards or general source discovery.
---

# 1C platform and BSP documentation

## Platform reference

Use the assigned EDT project from the profile and establish its exact scope and
readiness before dependent calls. HelpSearchServer / `1c-docs-mcp` is excluded
from the core workflow, including as a supplementary provider in CRM.
Resolve capability availability through `$1c-routing`: profile authority names
do not enable a disabled transport or prove that a live documentation API exists.

Check the installed tool schema/guide before using the parameter examples below.
For member discovery use a narrow concise inventory first; when the question
already identifies the member, skip that inventory. For exact API contracts,
call EDT `get_platform_documentation` with
`projectName` and `responseFormat="detailed"`. Narrow by `memberName` and
`memberType` when the question concerns one member; use `category="builtin"`
for a global function. Language keywords are not global functions: use only an
applicable read interface exposed by the current EDT tool guide for them. An
unsupported parameter requires the documented equivalent or a reported gap,
not repeated speculative calls.

Inspect returned resource bodies and structured results. A signature alone does
not establish parameter meaning, defaults, notes or execution contexts. If such
a fact is missing, use EDT `get_content_assist` with
`extendedDocumentation=true` at a known, suitable position in an existing module
within the authorized scope. Narrow completion by name, context and limit using
the installed schema. Do not create or change source just to obtain help.

Retain available documentation version and project compatibility evidence when
the decision depends on them. Current documentation alone does not prove an API
existed in an older version or is allowed by every compatibility mode. An empty
filtered member list does not by itself prove that a method does not exist.

Stop at sufficient evidence and reuse it until the relevant platform/project
context changes. If the exposed EDT interfaces cannot supply a required fact or
guide, report the exact gap and stop only the dependent conclusion or change.
Do not invent an API or substitute standards, static analysis or memory for a
missing platform fact. Standards and work policy follow `$1c-standards`.

## Installed BSP contracts

`1c-ssl-mcp` is intentionally excluded, including as an optional or fallback
provider. Do not restore it because it exists in a source environment. Its target
replacement is published BSP knowledge in Git searched through OpenViking;
implementation and acceptance of that route remain separate from this exclusion.

BSP is a library, not the built-in platform. Use the profile's bounded
`code-index` route for installed definitions and real usages; EDT supplies missing
live-project facts. Enabled knowledge cards may help locate a candidate when
their provenance and version are known. Apply the profile's required knowledge
gate from `$1c-routing` before dependent work, including all workflow in KORA.
An unresolved installed-version or contract mismatch remains a reported gap.
If code-index is disabled or unavailable, do not install/enable it implicitly or
replace broad indexed discovery with EDT. Request only a necessary live fact
through an available assigned EDT; dependent indexed conclusions remain blocked.

Knowledge coverage is limited to the explicitly selected collections. The
recommended manifest does not require every collection. Missing coverage or an
empty/filtered search result does not prove that an API is absent; retain that
uncertainty and verify the relevant installed contract before making that claim.
Use the [source roles](../1c-routing/SKILL.md) consistently: an API card is a
candidate with declared applicability, an architecture document explains a
mechanism, and neither is platform reference or proof of the current source.

Changes follow `$1c-code-change`. Report the API fact, its source and material
coverage or compatibility limits.
