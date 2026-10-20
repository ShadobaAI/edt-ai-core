# Adapter provenance

`bsl-ls-proxy.mjs` was brought over from the existing CRM toolkit MCP transport.
It now uses native multi-workspace registration rather than manufacturing MCP
roots. Codex obtains configuration paths from its assigned EDT-MCP. BSL LS owns
the folder registry and per-request context; each stdio connection owns its JVM.
The relay bounds file/folder arguments to the canonical selected directory,
serializes tool calls across index changes, separates bidirectional request IDs,
and bounds EOF shutdown. UTF-8 and URI-to-path conversion preserve Unicode Windows
paths without 8.3 aliases. Explicit analyzer configuration is optional and reaches
both the global and workspace loaders. No fallback API or component-version pin
is introduced. See [review and validation](BSL_LS_REVIEW.md) for the native API
evidence, installed-artifact mismatch and limits of live acceptance.

## Bundled normative policy

The generic policy implementation is adapted from the CRM AI repository at
`706d678b8cf321602716ab80c1020a3b4d28bdf8`, reconciled with Kafka tools at
`2552aa7ddcc0cbe6fa41080c791a60d56bef55ad` (repositories in
[SOURCES.md](../docs/SOURCES.md)). The initial import contained 48 shared oneC rules
and 16 YaXUnit rules matching both source registries. Nine additional CRM rows refer to general
metadata/extension standards; they are retained with project-neutral row IDs.
Project prefixes, naming conventions and installed paths are not imported.

The core now owns [protocol `2.1.0`](../policy/README.md), registry schema `2`,
and registry `2026-10-20.1`. This is a maintained change from the source behavior:
regex source inference was removed in favor of explicit assessments; YaXUnit
run/report return not_applicable; scoped registry gaps cannot be hidden by
baseline rows. Invalid requests remain errors, while declared violations produce
a structured blocked result. A valid ledger is called ledger_valid, not a proof
of normative compliance. Exact target/artifact/operation and current source
references are checked; a target-bound selection can survive a revision change
only with updated assessments and ledger evidence. Design/review use only their
applicable phase. These are consistency checks over caller assertions, not signed
receipts from source authorities. Project-local profile/skill hash manifests are
not imported; package integrity/atomic rollout remains separate work.
Protocol 2.1 merges caller-selected additional normative references from native
v8std code/context retrieval into the baseline selection and the same ledger.
Their strength/basis are digest-bound and cannot weaken registered requirements.
Empty additions preserve 2.0 selections; retrieval completeness and the truth of
applicability judgments remain outside this consistency checker.

The MCP reads only its bundled registry/schema, uses built-in Node modules,
returns structured results for all six tools, and does not read project source
or contact external services. Exact normative text is never copied into the
registry. Local tests establish protocol and applicability/ledger behavior;
they do not establish v8std corpus availability or normative truth of evidence.

The two action tools use the core-owned `policy/default.json`, shared with the
Python profile/doctor/settings checks. They validate explicit scope/effects and
caller evidence of actual user agreement. This evidence is not a signed grant,
user authentication, host approval override or permission for another target.

## Bundled Vanessa adapter

`vanessa/*.mjs`, `mcp/http-client.mjs`, the local runtime schema and sanitized
wire fixtures are adapted from Kafka tools at
`2552aa7ddcc0cbe6fa41080c791a60d56bef55ad`. Project paths, aliases and credentials
are not imported. This is maintained active implementation, not an archived
source-environment tree. It uses built-in Node modules and requires the actual
platform/Vanessa runtime separately.

The observed wire contract is Vanessa Single `1.2.043.45` / MCP `1.31`; unknown
versions or response formats fail closed. The core adds typed portable binding,
an explicit action-policy entrypoint, unverified run receipts and dispatch
evidence outside the HTTP deadline race. The fixture suite exercises HTTP,
readiness/isolation, selection/content checks, recording ownership, timeout and
editor transition. It does not establish live business outcomes or compatibility
with another Vanessa version.

## Directory profiles, source guard and review workflows

The CRM branch-review preparation and readiness contracts are adapted into
`skills/1c-branch-review/references/`, without its fixed base branch, remote or
task naming. The shared bounded
reuse gate is maintained in `1c-code-index`; the fresh read-only reviewer
contract lives once in `task-orchestration/references/reviewer.md`.

The source `1c-code-change/references/edt-editing.md` model-gate workaround is
adapted separately into `skills/1c-code-change/references/edt-recovery.md` by the
user's accepted `edt-model-gate-recovery` decision. It retains the exact
pre-mutation refusal conditions, scoped owner validation, three retries and
authorized single-clean escalation without CRM bindings. The source records a
live observation on 2026-09-30 with EDT-MCP 2.17.1; this transfer does not establish
recovery on the current external EDT or a different installed contract.

`hooks/guard.mjs` and `scripts/guard.py` are the core's profile-driven adaptation
of the source-environment routing guard: protected-source boundaries and allowed
index aliases come from the selected repository. The manifest registers a
PreToolUse hook using the [documented plugin extension](https://developers.openai.com/plugins/build/plugins).
Local invocation verifies decisions, not host trust, actual event delivery or
complete isolation of arbitrary programs. These remain explicit host boundaries.

`project_paths.py`, `project_context.py` and the lazy/settings entrypoints implement
the user's accepted directory/instance decision in `skills/catalog.yaml`.
Tracked defaults, local and Codex instance overrides, and process environment
are separate inputs to one effective binding. `settings/defaults.json` is the
single bundled defaults source; no parallel YAML copy is maintained.

The shared EDT progressive-disclosure and update-audit workflow from both
source routing skills is maintained in `skills/1c-routing/references/toolsets.md`.
Native settings use the Python JSON/YAML loader instead of a second Node overlay
parser. BSL LS configurations are session-local native workspace folders.
Prepared install copies carry `hooks/runtime.local.json` because host
hooks do not inherit MCP entry env; this generated file belongs only to the
installed copy and contains runtime paths, not credentials.

