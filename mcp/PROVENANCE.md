# Component provenance and contracts

The source repositories and revisions for shared skills and adapters are listed
in [SOURCES.md](../docs/SOURCES.md) and [skills/catalog.yaml](../skills/catalog.yaml).
The normative policy incorporates material from CRM AI at
`706d678b8cf321602716ab80c1020a3b4d28bdf8` and Kafka tools at
`2552aa7ddcc0cbe6fa41080c791a60d56bef55ad`. The Vanessa adapter and sanitized
wire fixtures incorporate material from the same Kafka revision. Copyright and
license information is in [NOTICE.md](../NOTICE.md) and the bundled dependency
notices.

## BSL Language Server

`bsl-ls-proxy.mjs` uses the native multi-workspace API. The assigned EDT-MCP
provides configuration paths, BSL LS owns workspace registration, and each stdio
connection owns its JVM. The proxy confines paths to the selected directory,
serializes calls across workspace changes, separates bidirectional request IDs
and bounds shutdown. Configuration is optional and reaches the global and
workspace loaders. See [architecture](../docs/ARCHITECTURE.md#managed-runtime)
and [local verification limits](../docs/ACCEPTANCE.md).

## Normative and action policy

The bundled [policy](../policy/README.md) validates explicit assessments against
its registry and schema. It checks target, artifact, operation, source references
and ledger consistency; these checks do not authenticate caller assertions or
establish normative truth. Additional v8std references cannot weaken registered
requirements. Exact normative text remains in its source.

The policy MCP reads its bundled registry and schema, uses Node built-ins, and
neither reads project source nor contacts external services. Action tools share
`policy/default.json` with profile, doctor and settings checks. Their evidence of
user agreement is not a signed grant or host approval override. Local tests do
not establish availability of the external v8std corpus.

## Vanessa and source protection

The Vanessa adapter requires the user's platform and Vanessa runtime. Its
supported wire contract is Vanessa Single `1.2.043.45` / MCP `1.31`; unknown
versions or response formats fail closed. Portable bindings, action policy and
run receipts do not by themselves establish a live business outcome.

The profile-driven source guard checks protected paths and permitted index
aliases. A registered hook and local tests do not establish host activation or
complete isolation of arbitrary programs. The EDT recovery procedure is limited
to the exact refusal and authorization conditions in
[edt-recovery.md](../skills/1c-code-change/references/edt-recovery.md); its
applicability to an installed EDT must be verified.

## Runtime dependencies

Process ownership uses Job Objects on Windows and process groups on POSIX;
shared index daemons have separate ownership. The Windows daemon uses explicit
breakaway and an inherited-handle allowlist. An ancestor Job that forbids
breakaway causes an error. The bundle includes YAML, Ajv, fflate and Koffi with
their notices. Supported code-index assets and runtime requirements are specified
in [runtime-manifest.yaml](../runtime/runtime-manifest.yaml).

Sources: [code-index releases](https://github.com/Regsorm/code-index-mcp/releases),
[Koffi](https://github.com/Koromix/koffi),
[Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).
