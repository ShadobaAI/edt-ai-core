---
name: 1c-standards
description: Select and verify normative requirements for 1C design, change or review; retrieve exact standards, work policy and diagnostic explanations. Not source discovery or platform API lookup.
---

# 1C standards

`policy` is a bundled read-only MCP that normalizes agent assessments, selects
applicability and checks ledger consistency. It does not analyze sourceText or
prove evidence true. `ledger_valid` does not mean full normative compliance;
`blocked` retains violated/unverified requirements.
`v8std` is the normative corpus and primary code/context selection mechanism.
The registry defines the mandatory baseline; discovered applicable requirements
enter the same selection/ledger through `additionalRequirements`. The registry
contains no normative text and does not exhaust the corpus. EDT, code-index and
BSL LS supply artifact facts; platform reference follows $1c-platform-docs.

To choose a solution or assess a specific artifact, follow the shared
[requirements workflow](references/requirements.md): facts →
[v8std selection](references/discovery.md) → baseline and additional requirements →
exact normative text → applicable phase verification: design — proposal,
review — result, implementation — both. $1c-code-change uses the same workflow;
do not select again if scope and applicability are unchanged.
An ordinary question about a known standard's text does not require inventing an
artifact, diagnostic baseline or change proposal. Pure source discovery requires
no normative preload and provides no compliance conclusion.

## Retrieving normative text

For a new binding or unknown contract, read
[connection, response selection and budget](references/mcp.md). Live MCP determines
names, parameters, restrictions and supported collections; no local operation
catalogue or checkout/version binding is needed. Different projects may share a
server; their applicability and compliance evidence remain independent.

Read known IDs/headings directly: the smallest sufficient full text, exact
section, pattern or API member card for the task. For new code/context follow
[discovery](references/discovery.md); decode useful diagnostic relationships in
batches, search unknown topics narrowly, and retrieve relationships compactly when
descriptions are unnecessary. Do not load the entire document after each candidate
when sufficient full text is already available. Check identity, `found`, heading
and absence of truncation; finish reading conditions, exceptions and substantial
related sections.

Limit collections and types to the task subject; general top-N and code-based
selection do not guarantee coverage of work rules and framework references.
The discovery contract defines corpus choice, candidate applicability checks and
Gherkin boundaries.
Reuse sufficient text until relevant corpus/condition changes. Do not invent an
unknown revision; it limits reuse to the current task and connection.

## Project conditions and conclusions

Account for explicit user instructions and project restrictions. Selection defines
baseline requirement strength; justify addition strength with exact text and
project conditions. A recommended work rule does not override a mandatory standard
merely by belonging to the corporate corpus.
Confirm project conditions and exceptions with exact selectors, repository scope,
basis and profile/instruction sources. Check exceptions provided by the requirement
itself as its conditions and explain them in evidence. Current policy does not
automatically apply `policy.exceptions` or support mandatory waivers:
if a project cancels a mandatory requirement, retain the conflict separately;
do not remove the selector or present cancellation as `passed`. Dependent formal
verification remains incomplete until the conflict is resolved. Do not transfer
CRM/Kafka naming, prefixes, line lengths or conventions to another project.

Assess the changed portion and affected enclosing invariants; do not modernize
unrelated legacy. Reports must distinguish selected requirements, retrieved full
text and actually verified fulfillment. State compliance phase statuses, coverage
gaps, violations and justified recommended deviations separately. No findings or
passing tests do not prove full normative verification.
