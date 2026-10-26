# 1C analysis and response budget

These are capability selection rules, not a tool catalogue. Take names, parameters
and availability from current MCP descriptions/schemas. Do not reconstruct unknown
parameters from memory or enable bulk modes by changing user settings.
Unknown/ignored parameters mean the claimed filter is not yet confirmed:
correct the request before drawing scope or completeness conclusions.

## From question to sufficient answer

| Question | Preferred route and boundary |
| --- | --- |
| Where functionality is implemented | Short semantic search over names, owner synonyms and comments; then exact candidates. Literal grep does not replace this search; check verbose results against all required conditions. |
| What a known module/procedure does | Symbol map, block skeleton or context of a given line, then required bodies/ranges. A large truncated body is not complete source. |
| How an object is structured | Narrow structured overview of needed sections; names/counts before form, module and relationship details. Do not expand all sections by default. |
| How a call executes | Targeted callers/callees and BSL-aware qualifier resolution; for a known pair, path search. For loops/exceptions, read call-site context rather than every module. |
| What a change affects | Incoming reference summary across code, metadata and permissions; then only the affected section. Use a data graph for object relationships and a call graph for execution; they are not interchangeable. |
| What launches a handler | Form bindings, subscriptions, extension interceptors and platform conventions; absence of direct calls does not prove unreachability. Check dynamic dispatch when a specific basis exists. |
| Which register movements posting produces | Distinguish declared registers, reachable write sites and code mentions. No found write under heuristic/dynamic analysis does not prove no movements. |
| How permissions are assigned | Targeted object or role overview with needed rights. Static permissions do not prove effective runtime access, RLS or current user privileges. |
| How a report/DCS works | Parsed schema with needed datasets, relationships, parameters or settings; include query text only when the question needs it. |
| Exact text is needed | Distinguish procedure bodies, all file code and text/XML. Narrow path and lines; use a short anchor or suitable regex for multiline chains. Oversize files may have an AST without stored text. |
| No sufficient specialized answer | Narrow search/read first. Read-only SQL is the last route for a proven necessary join/aggregation: schema from the current contract, exact aliases/conditions, selected columns and LIMIT; no SELECT * or database dump. |

Do not apply this table as a checklist to every task. One sufficient specialized
answer is preferable to overlapping overviews. If the schema supports a small
batch of exact targets, use it only instead of already necessary independent
calls, without expanding scope or bulk discovery.

## Completeness and freshness

A running process, ready base text and ready metadata/relationship enrichment are
distinct facts. Use the status of each required repository/layer and response;
incomplete enrichment does not prohibit independent reads of ready text.
Leave short-batch waiting to the server; do not loop broad requests while indexing
continues. Do not trigger rebuild or enrichment merely to check capability availability.

Connection checks confirm alias-to-path correspondence and declared freshness.
They do not prove complete parsing, no exclusions, all templates/extensions or
historical revision correspondence. A negative conclusion requires the appropriate
layer, scope, freshness and absence of substantial omissions.
On conflict with live EDT, invalidate dependent indexed evidence.

Check responses for truncation, omitted sections, incomplete prefilter/coverage,
file/node/depth/time limits, heuristics and continuation. Counts may be partial;
a complete page does not mean complete traversal. Use exact definition locators
for same-named procedures. “No path found within the search” does not prove
absence of a path.

First use summary counts, brief fields, path/type/direction filters, section
limits and server budgets. Then follow returned continuation/offset if needed;
do not invent universal pagination for every response. Increase only the specific
blocking limit and only for an unresolved question. Do not remove the overall cap
or request every body to reduce call count.

## Repeated results and evidence

The server may omit rows already delivered in this MCP session. A suppression
marker does not mean zero matches. Reuse prior facts; after compaction retain
alias, path/revision, locator, conclusion and substantial limits. If the actual
data is lost, use a supported result-history reset or a new MCP session for only
the current binding; do not restart the shared daemon or repeat empty calls.

Built-in caching and change tracking do not ensure indefinite freshness:
do not assume results remain current after profile changes, checkout or relevant
writes. Do not add an external cache over MCP without a separate invalidation
contract. Do not transfer another configuration's readiness, result history or aliases.

Retain a concise answer with specific locators and coverage limits.
Stop searching when evidence is sufficient; full MCP utilization means being able
to choose all suitable capabilities, not calling each one.
