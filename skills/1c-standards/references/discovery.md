# Selecting requirements through v8std

For design/change/review, this is the primary way to discover requirements beyond
the baseline registry. There is no need to check every word or read the whole corpus.
The search unit is an affected method, query or described change mechanism.
Obtain source through authorized EDT/index/revision-aware routes; retain target,
sourceRef and each fragment's boundaries. Do not load an entire large project.

## By code

Use the live contract to select BSL/SDBL requirements for each affected fragment
of the assessed phase, including enclosing conditions that affect the change's
meaning. For proposal submit specific proposed code; for review use the exact
revision. Baseline is also needed when deletion/replacement affects the checked
requirement. Do not substitute a diff description when relevant code is available.

First check live schema and restriction descriptions. The recommendation budget
may be shared between diagnostics and standards. If a method exceeds the limit,
split it semantically using authorized structural facts, preserving signature and
needed conditions/transaction boundaries in corresponding fragments or a context
request. Do not truncate the method to the first allowed characters; record covered
parts and remaining gaps. Account for the limit including added context.
Replace secrets with safe values while preserving significant operations; if this
hides a substantial fact, retain the verification limit.

Combine `standards`, signals and useful diagnostic references from the response.
`confidence`, even `1.0`, is a ranking heuristic, not violation probability.
A signal may originate from a comment, literal or a different receiver's method.
No signal/candidate also does not mean compliance. Language remains a hint unless
the contract confirms a separate analyzer.

Returned diagnostic IDs are not EDT/BSL LS execution results. If they concern an
affected mechanism, obtain related requirements through batch decoding with exact
IDs and analyzer namespace, without duplicates. Retain actual finding frequencies
separately if needed for reporting; repeating an ID for identical normative text
is unnecessary. Reuse returned relationships.
Check this route especially when the shortlist contains only diagnostics: related
standards may not fit the shared recommendation budget.
Decoding real analyzer findings uses the same tool; validity assessment follows
the [diagnostics contract](../../1c-routing/references/diagnostics.md).

## By context

For design without specific code, metadata, deletion/rename and facts outside a
snippet, use context-based requirement selection: brief change subject, verified
mechanisms and suitable collections. Determine input size from the live contract;
describe mechanisms plainly rather than assuming internal policy tags are understood.
Choose collections by task subject:

| Collection | Purpose |
| --- | --- |
| `v8std` | General BSL/SDBL and metadata standards |
| `corporate` | Applicable work rules, including documents of type `rule` |
| `yaxunit` | Unit-test design/authoring, patterns and reference API cards |
| `vanessa` | Gherkin/UI scenarios, patterns and reference tool cards |

Check which types and collections code-based selection covers under the live
contract. Do not treat it as sufficient for corporate `rule` and framework
`reference` if the route does not return them. Context selection is also needed
for requirements and reference conditions not inferable from a code fragment.
For task-related corporate/framework requirements, use a separate context query
against the relevant corpus, supplementing BSL/SDBL selection. One general top-N
across collections does not guarantee each is represented.
Do not load framework corpora the task does not affect.

Do not submit Gherkin for BSL/SDBL selection: use context with scenario goal/structure
and affected mechanisms, then exact page/section. Use specialized pattern/API cards
only in supported collections; otherwise read the exact document/section.
An API/tool card supplies contract facts but does not become mandatory merely by
appearing in selection.

Start with a compact set, for example five context candidates. Response coverage
is `ranked_candidates_not_exhaustive` unless the server explicitly guarantees
otherwise. If a known substantial mechanism is missing, refine context, decode a
diagnostic relationship or search narrowly; increasing top-N without a reason
does not prove completeness. Do not keep expanding all background corpus relationships.

## From candidate to verifiable requirement

Merge results by canonical ID/heading with the policy baseline. Retain a brief
candidate record: selector, search source/fragment, decision and basis.
For clearly unrelated results, explain the context mismatch; for potentially
applicable results, obtain complete exact text and necessary conditions.
If context/candidates already contain sufficient complete text with confirmed
identity, no reread is needed. Budget, pagination, truncation and reuse follow
the [MCP contract](mcp.md).

- `applicable`: the requirement condition concerns the assessed target/transition.
  State normative strength from exact text and project conditions. Add new selectors
  to `additionalRequirements` even if that mechanism/ID is absent from the registry.
  In `mechanisms`, pass only names from the live policy schema; retain subjects
  outside that vocabulary in context/basis, without inventing arbitrary tags.
- `not_applicable`: retain the specific reason — for example, comment-only text,
  a different receiver contract or an absent requirement condition. Ranking is
  not a reason.
- `unresolved`: retain the missing fact/text and its impact. Substantial uncertainty
  prevents a full compliance conclusion and dependent writes; review may give a
  partial report.

In `additionalRequirements`, pass only confirmed normative selectors,
`strength: mandatory|recommended` and `basis`: exact source/revision, applicability
condition and scope. Do not copy diagnostic IDs there by themselves.
Retain conditions of individual document clauses in evidence; if strength differs,
separate exact headings or retain the stronger level and explicitly distinguish
conditions. Additions cannot downgrade a baseline mandatory requirement.

Policy binds additions to the digest and requires their rows in the same ledger,
but does not retrieve v8std responses or prove honest candidate selection.
An omitted or unjustifiably rejected candidate remains a possible agent-work defect.
Distinguish changed-code coverage, returned-candidate assessment and fulfillment of
selected requirements in reports; do not claim exhaustive corpus search.

Existing policy selections target oneC/YaXUnit. Vanessa patterns may enter additions
if their condition applies to that target. For a standalone Gherkin artifact, do
not invent `artifact: bsl` or YaXUnit mechanisms to get a digest: retain requirements,
applicability and results in the Vanessa workflow's static report.
Bundled policy has no separate Gherkin selector/validator yet; do not call that
report a `validate_compliance` result.

Reuse selection while scope, code/context and corpus are unchanged. Before writing,
refresh it for substantial proposal changes; after writing repeat for differences
between actual result and the checked proposal. A new sourceRef always needs current
compliance evidence even when selection and normative text are retained.
