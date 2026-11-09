# Skills and workflow contracts

The plugin provides one set of workflows for every project. The selected profile
supplies repositories, aliases, EDT projects and optional test capabilities.
Only the universal `generic-1c` profile is bundled; project profiles, endpoints,
credentials and local exports belong to project repositories or user state.

The [skill catalog](catalog.yaml) lists active skills, source repositories and
accepted decisions. Before bringing behavior from a source environment, consult
`migration_decisions` and the source identified in [SOURCES.md](../docs/SOURCES.md).
Project-specific profiles and bindings are not part of the distribution.
HelpSearchServer (`1c-docs-mcp`) and `1c-ssl-mcp` are excluded, including optional
and fallback connections. Evaluate EDT documentation coverage and the selected
knowledge integration independently; absence of those servers does not establish
coverage or readiness.

## Responsibilities

| Skill or component | Responsibility |
| --- | --- |
| [1c-routing](1c-routing/SKILL.md) | Select the assigned authority and apply source, knowledge and action gates. |
| [1c-code-index](1c-code-index/SKILL.md) | Discover source and evaluate reuse within the selected index scope. |
| [1c-code-change](1c-code-change/SKILL.md) | Scope implementation, validate before and after writes, and handle unknown outcomes. |
| [1c-platform-docs](1c-platform-docs/SKILL.md) | Check platform APIs through the assigned EDT and installed library contracts through the index. |
| [1c-standards](1c-standards/SKILL.md) | Select applicable requirements and retrieve exact normative text. |
| [bsl-ls-mcp](bsl-ls-mcp/SKILL.md) | Run focused diagnostics and navigation through the configured analyzer. |
| [1c-branch-review](1c-branch-review/SKILL.md) | Review exact revisions with baseline attribution and scoped checks. |
| [task-orchestration](task-orchestration/SKILL.md) | Coordinate bounded workstreams and independent review where applicable. |
| [yaxunit-tests](yaxunit-tests/SKILL.md) | Author, review, run and debug YaXUnit tests in the authorized scope. |
| [vanessa-ui-tests](vanessa-ui-tests/SKILL.md) | Research, author, review and execute Vanessa UI scenarios. |
| [edt-ai-core](edt-ai-core/SKILL.md) | Configure profiles, connections and managed runtimes. |

Effective enabled, managed and external settings select the route; a profile
mapping alone does not enable a component. Check the live contract of the
assigned authority before relying on a capability. Missing capabilities block
their dependent actions without implicit substitution. Design, review,
implementation and runtime work have distinct effects and acceptance criteria.
Static test authoring does not require a running manager; running tests does not
implicitly authorize source fixes.

The [action policy](1c-routing/references/action-policy.md) defines scope and
agreement for effects. Its evidence is not user authentication or a replacement
for host approvals. The [EDT editing contract](1c-code-change/references/edt-editing.md)
defines available write preconditions; [recovery](1c-code-change/references/edt-recovery.md)
requires the exact pre-write refusal and applicable authorization. Confirm recovery
against the installed server contract; a timeout does not authorize a retry.
Project instructions define supplier ownership, prefixes and maintenance rules.

The [normative contract](1c-standards/references/requirements.md) and
[policy protocol](../policy/README.md) select requirements and check assessments
and evidence. A valid ledger checks consistency; it does not establish the truth
of the evidence. A shared v8std endpoint does not merge task or revision context.
Knowledge modes and their gates are described in
[INTEGRATIONS.md](../docs/INTEGRATIONS.md).

Local checks and their limits are listed in [ACCEPTANCE.md](../docs/ACCEPTANCE.md).
They do not establish live acceptance of EDT, v8std, test runtimes or the Codex host.
