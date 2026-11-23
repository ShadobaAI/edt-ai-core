# 1C analysis and response budget

Use the current MCP schemas for availability and parameters. The tool names
below identify candidates for targeted schema lookup. Keep bulk modes and server
settings under their owner's control.

## From question to sufficient answer

| Question | Preferred route and boundary |
| --- | --- |
| Where functionality is implemented | `find_symbol` for a known identifier with uncertain location, `search_function` for a likely name or comment, scoped grep for a code/text clue. `search_terms` ranks FTS matches in the procedure enrichment layer. Check coverage and evaluate candidate bodies before attributing purpose. |
| What a known module/procedure does | `get_function` with the bare exact name and a file filter (`path_glob` or advertised `path`), or `read_file` for a known range. Use `get_file_summary`, `get_node_structure` or `get_line_context` when coordinates or surrounding blocks are needed. |
| How an object is structured | `get_object_structure` for its fields or `get_object_profile` with only the needed sections for overview. Select the exact metadata type/name and applicable extension. |
| How a call executes | `get_callers`/`get_callees` for immediate name-based relations. `get_callers.path_glob` filters caller files. For a BSL path between known definitions, use `find_path_bsl` with `<relative_path>::<name>` keys. `query_call_sites` locates calls in blocks such as loops or handlers. Expand a tree only to answer a remaining execution question. |
| What a change affects | Start with `find_references` for metadata impact across structural links, code usages and roles. Read the affected section if samples are insufficient. Use `get_data_links` or `find_data_path` for object relationships and a call graph for execution. |
| What launches a handler | Use specific form bindings and subscriptions. Check extension interceptors and platform conventions when relevant. Classify explicit, statically resolved and heuristic links. Verify plausible dynamic paths when they affect the conclusion. |
| Which register movements posting produces | Use a posting map or register writers, distinguishing declared registers, reachable writes and code mentions. Dynamic writes can fall outside the index. |
| How permissions or DCS are defined | Request scoped role rights or the parsed DCS schema. Include query text when needed. Effective access, RLS and user privileges require separate evidence. |
| Exact text is needed | Choose `grep_body` for procedure bodies, `grep_code` for stored code and `grep_text` for text/XML. Use one criterion, a narrow file filter and minimal context. Oversize files can have an AST without stored text. |
| Necessary join or aggregation is uncovered | Use `bsl_sql` only if bounded search, reads and specialized tools cannot answer the question. Verify the live read-only contract and use exact scope, selected columns and a limit. |

Do not apply this table as a checklist to every task. One sufficient specialized
answer is preferable to overlapping overviews. If the schema supports a small
batch of exact targets, use it only instead of already necessary independent
calls, without expanding scope or bulk discovery.

## Completeness and freshness

A running process, ready base text and ready metadata/relationship enrichment are
distinct facts. Use the status of each required repository/layer and response;
incomplete enrichment does not prohibit independent reads of ready text.
Leave short-batch waiting to the server; do not loop broad requests while indexing
continues. Reuse the [shared daemon](../../edt-ai-core/references/runtime-contract.md#project-and-runtime-contract)
across tasks. Close only the current reader on disconnect or root switch.
A capability check needs neither a rebuild nor a new enrichment job.

Verify alias/path correspondence on first use or a binding change through an
applicable settings observation or native health evidence. Reuse a verified
mapping within that binding. `core_runtime_status.ready` confirms transport only.
For external or federated repositories, confirm the expected mapping on the
serving node. Treat checkout and file changes, including serialized EDT writes,
as reasons to recheck affected evidence after the watcher applies updates. Use
revision or file evidence for claims about a particular snapshot. A negative
conclusion requires the right scope, layer, freshness and coverage of relevant
files. Account for extensions, exclusions and parse failures when they matter.

Check responses for truncation, omitted sections, incomplete prefilter/coverage,
file/node/depth/time limits, heuristics and continuation. Counts may be partial.
Establish exact definitions before attributing name-based hits to same-named
procedures. A negative path result is bounded by the covered edges and limits.

Inspect warnings in the response envelope and each selected repository's payload.

- `data_version_stale` (or a stale version in health) limits extracted facts even
  on successful reads. Distinguish format compatibility from watcher freshness.
  Assess affected layers before using a documented, authorized rebuild action.
- `unknown_params` means the advertised result may lack a requested filter.
  `search_param_conflict` identifies which competing keys were used and ignored.
  Correct the request before treating its intended scope as verified.
- `other_category` describes a bounded probe, including lower-bound counts when
  incomplete. Run the suggested matching-category query only when locations or
  fuller coverage are needed.
- `file_annotations` describes indexed headers. Treat `derived_status: "unknown"`
  as unverified. Check provenance and the existing source protections before EDT
  writes regardless of the annotation.

Use brief fields, path/type/direction filters, section limits and server budgets
on the first request. Ask for summary counts only when they resolve a scope or
paging question. Follow a returned continuation/offset only for missing evidence.
Increase only the limit preventing that answer. Keep the overall cap and read
full bodies only for targets that need them.

## Repository sets and history

Use an explicit `repo` for a known repository. For a search that genuinely spans
projects, pass exact profile aliases in `repos` only when the live schema offers
it. Read each `result.repos` group's `status`, payload and warnings, including
partial, skipped and failed groups. Shared result, byte, file and time limits can
leave later groups unsearched. If a necessary group remains unresolved, query
that alias directly with a narrower scope. A federation route or matching alias
does not establish the same repository, revision or enrichment across servers.

Use the Git layer for authorized committed reads it covers under the
[branch workflow](../../1c-branch-review/references/workflow.md#read-only-mode).
Retain exact SHAs and use its
[comparison rules](../../1c-branch-review/references/workflow.md#comparing-saved-revisions).
Choose a bounded log, changed files or object
summary for scope, or a file diff or historical line range for evidence. Use the
live contract's revision semantics, and verify the resolved hash and time zone
for date inputs. Git reads need no checkout. `git_changes_by_object` can group
historical paths using today's indexed metadata. Verify historical object identity
against committed files when it matters. Apply other indexed facts to a historical
revision only after establishing content correspondence.

## Repeated results and evidence

Where the transport supports session deduplication, `rows_elided_already_delivered`
identifies rows already delivered in that MCP session. Reuse prior matching evidence.
After compaction retain alias, path/revision, locator, conclusion and substantial
limits. If data is lost, reopen only the current MCP session or use a reset with confirmed
session scope. The HTTP reset can affect other readers' histories.

Built-in caching and change tracking do not ensure indefinite freshness:
do not assume results remain current after profile changes, checkout or relevant
writes. Do not add an external cache over MCP without a separate invalidation
contract. Do not transfer another configuration's readiness, result history or aliases.

Retain a concise answer with specific locators and coverage limits.
Stop searching when evidence is sufficient; full MCP utilization means being able
to choose all suitable capabilities, not calling each one.
