# v8std: connection, response selection and budget

## Live contract and shared server

The selected directory's profile and instance/environment overrides determine the
assigned endpoint. Do not embed addresses, checkouts, server versions or operation
catalogues in the skill. For a new binding read `core_runtime_status`:
`binding` identifies project/instance/endpoint; `serverContract` supplies negotiated
connection instructions and capabilities. This establishes MCP availability, not
article presence or corpus completeness. Choose capabilities by purpose, description
and live schema; do not guess names. The server's read contract does not replace
project instructions or user authority.
Inspect `nativeCatalog` and, on failure, `failure.stage`/`failure.category` and
`detail`: connection, catalogue, schema validation, actual reading and policy are
separate checks. An empty catalogue or a connected status does not establish that
the needed read or workflow is usable. Report the failing operation and binding;
do not treat setup readiness as proof of this session's relay.

Reuse discovery in the current binding. Refresh after endpoint changes,
reconnection, capability-change notifications, incompatible responses or explicit
update audits. The proxy forwards new schemas without static allowlists;
ordinary reads do not repeat discovery. Do not request undeclared resources/prompts
or poll empty catalogues every turn. Check only the needed route; do not call
every operation to demonstrate integration completeness.

One read-only reference server may serve multiple projects concurrently: it does
not select their configurations, read repositories or execute analyzers.
No server per project is required. Client connection, selected root, instance
and task context remain separate; do not switch another project's settings or
restart the shared service for a local query. Client termination releases only
its own MCP session if issued; stateless connections create no server session
and send no DELETE.

## Smallest sufficient response

Read known canonical IDs/refs directly, without searching again. Pass internal
references from responses intact to compatible MCP operations; do not convert them
to website URLs or treat code-example URLs as navigation. When ambiguous, use
returned candidates/headings and resolve only the missing fact; the first hit
does not automatically become the selected document.

For short documents choose compact text; for exact conditions choose sections;
for framework methods choose the needed API member card. Use pattern cards only
for corpus/type combinations supported by the live contract. Read unsupported
collections as ordinary documents/sections, without repeated failed calls.
Full articles are needed when conditions require their context or separate sections
would cost more volume and calls. Prefer compact IDs for relationship traversal;
obtain descriptions only for ambiguous choices. Reuse returned explicit
relationships rather than requesting them again.

For unknown topics start with a small candidate set and bound types/collections
to the task. For known diagnostic IDs use batch decoding; for code use semantic
fragment selection; for design/Gherkin use context. These are different inputs,
not a mandatory chain of all search methods.
Context responses may already contain sufficient full normative text: do not reread
when identity, completeness and applicability are confirmed. Set candidate body
budget separately from count when supported; small shortlists do not require
full articles for every row.

Start with ordinary ranking. Choose exact/lexical/semantic search for a reason:
an identifier, specific terms or semantic reformulation. Do not run every mode for
one question. Empty results, low scores or `unknown_codes` describe the corpus,
not code correctness. For substantial gaps refine input or choose another suitable
capability while retaining the gap.

Follow search cursors only for needed missing facts. Preserve all original filters,
mode and page size. A rejected cursor after ranking changes requires a new bounded
search rather than mixed pages. Do not traverse the entire corpus or increase
top-N as proof of coverage.

Check `found`, canonical identity, exact heading/member, `body_truncated` and
incompleteness markers in the actual object: body may be inside `page`, a section
or a `requirements` item. Search descriptions and metadata are not normative text.
Finish truncated text through targeted sections or larger bodies within the current
limit. Do not repeat the same truncated answer or exceed server clamps;
schema, descriptions and targeted errors outweigh old skill numbers.
Not all limits are declared in JSON Schema: no maximum does not mean unlimited
output. If complete text cannot be obtained, retain unverified status.

<a id="повторное-использование-evidence"></a>
## Evidence reuse

Within the task retain a compact record: endpoint and available corpus identity,
canonical ID/heading/member, text completeness and conditions used.
Do not substitute SDK version for corpus revision. If the server does not report
document/corpus revision, mark it unknown; a text hash confirms specific bytes,
not server freshness. Reuse is then limited to the current task with unchanged
connection and no contradictions; a new task or reconnection requires current
reads of needed selectors. Confirmed corpus changes require refreshing dependent
selection and text.

Shared unchanged text may be reused across scopes only with confirmed endpoint,
corpus identity and revision. Snippet/context responses, sourceRef, project
exceptions, selection/digest and ledger belong to a specific project, target,
phase and revision. Matching object names, aliases or standard IDs do not authorize
cross-project assessment transfer. New sourceRef needs its own compliance evidence
even when normative text is unchanged. The relay has no cross-client call-result cache.

Use one result representation: structured data, or text JSON when no structured
response exists. Do not repeat both copies or copy whole bodies into ledgers/user
responses. Selector, checked condition, artifact fact and result suffice.
Responses may contain normalized source; submit only the needed fragment without
secrets and retain it in the current project's context.
This saves reading and context; payload size does not equal model limit consumption.
