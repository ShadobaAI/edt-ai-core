# Policy 2.1 contract

Policy is a local read-only checker. It normalizes mechanism assessments, selects
a baseline from the bundled registry, combines it with additional v8std requirements
and checks ledger consistency. Primary code/context selection uses
[v8std discovery](../skills/1c-standards/references/discovery.md);
the agent assesses source and normative text through authorized sources.
Policy does not read project files, call EDT/v8std or authorize writing.
The shared workflow is in
[requirements](../skills/1c-standards/references/requirements.md).

## Facts and applicability

Optional session tools serve ordinary tasks:
`assess_1c_requirements` combines detection/selection and returns full selection
with `selectionRef`/`detectionRef`. `validate_compliance_ref` accepts these refs,
explicit current/phase and compact `[selector,status,evidence,reason?]` rows.
The backend reconstructs the full request and runs the same `validateCompliance`;
sourceRef, target, mechanisms, coverage, phase and mandatory checks are not weakened.
Refs work only in their creating MCP session, are not permissions and may expire
after 64 stored entries. Changed sourceRef needs new detection; new evidence and
a separate result ledger are mandatory. Original full-protocol tools remain.

`detect_1c_mechanisms` retains its name for stable skill routing but actually checks
and normalizes the calling agent's assessments.
`sourceText` is excluded from the API: regex cannot establish receiver type,
variable scope, export contract or the meaning of a string containing `SELECT`.
Supply `present|absent|unknown` and evidence from assigned EDT/index/analyzer.
Unspecified assessments remain `unknown`; policy does not turn them into facts.
Nonempty evidence is a caller claim, not verification of its truth.

Assessments belong to a specific phase/operation and affected context.
Changes account for baseline and assessed state; deletion mechanisms do not vanish
from result assessments after objects are deleted successfully.
Design assesses a specific proposal; review assesses a fixed revision.

Ambiguous mechanisms have these meanings:

| Mechanism | What must be established |
| --- | --- |
| `query_text` | Query text is affected in the assessed scope/transition; method names or obtaining ready results do not prove this. |
| `query_result_processing` | An actual query result is processed; receiver type/contract is confirmed by authorized facts. |
| `module_variable` | The variable belongs to the module; local `Перем` inside a method is insufficient. |
| `export_contract` | An exported interface is affected, rather than a literal/comment containing “Экспорт”. |
| `changed_signature` | Signature changes in the baseline → proposal/result transition. |
| `metadata_rename`, `metadata_delete` | Metadata identity changes or an object is deleted, rather than merely its mention. |
| `transactional_test` | The test uses transactional mode; persistent-data presence is established separately. |
| `nontrivial_predicate` | A nontrivial test predicate is affected; this does not automatically imply database assertions. |

The selector unions explicit, classified and confirmed detection mechanisms.
Derived relationships are limited to conceptual relations, for example
`changed_signature → method_contract`, `persistent_data → test_data`.
They do not infer missing source facts. Query mechanisms alone do not add
`query_text`; ready-result handlers may have none.
Complete critical assessments are mandatory for oneC selection; unknown critical
facts or contradictions block it. YaXUnit has its own mechanism vocabulary;
oneC detection is not passed to that selector.

## Registry coverage

`registry.json` stores applicability and exact selectors without normative text.
A rule's `any` specifies selection conditions. `covers` merely marks a mechanism
covered by an unconditional rule for a given artifact/operation; it is not a match
condition. For example, authoring baseline covers `test_behavior` for design/create.
Combining `any` and `covers` is forbidden to avoid conflating these roles.

Every effective mechanism must be covered by actually selected rows.
General baseline rows do not hide mechanisms lacking suitable rules. Missing rows
or incomplete coverage return `unavailable` with
`reason: registry_coverage_missing` and `uncoveredMechanisms`, without digest.
This checks **declared mechanism coverage by the bundled registry**; it does not
prove complete mechanism lists, corpus or normative relationship tables.

YaXUnit `run/report` returns `not_applicable` with
`authoring_not_requested`. This is neither selection nor proof of successful tests.
Authoring mechanisms, including unknown ones, do not create authoring gates in
these modes. Supplied mechanism names are still checked against the vocabulary.

## Requirements beyond baseline

Both `select_*_requirements` accept `additionalRequirements`:

```json
[{"selector":"std740","strength":"mandatory","basis":"Точный источник/редакция, условие нормы и применимость к target"}]
```

These are not raw search hits: the agent first reads exact normative text and
establishes applicability/strength. Exact std, corporate work, YaXUnit and Vanessa
pattern selectors are allowed, including headings. Diagnostic IDs, scores and
confidence do not replace normative selectors or basis.
The registry need not know a particular ID: for example, discovered v8std std740
can be included without a new registry row.
Additions do not remove `registry_coverage_missing` for declared mechanisms,
turn unknown assessments into facts or downgrade baseline.

Additions sort by selector; duplicates within the array are rejected.
If a selector matches baseline, the ledger contains one row and mandatory wins.
The additions set with strength/basis is bound to the digest and retained in
selection. Pass the current array in `validate_compliance.current`;
removing/changing it requires new selection. All added requirements use the same
ledger and return `blocked` for `failed/unverified`.
YaXUnit `run/report` rejects nonempty additions because it is not authoring selection.

Empty/absent arrays preserve protocol 2.0 selections/digests.
Policy does not call v8std, authenticate basis or independently discover omitted
candidates. The workflow tracks found/rejected/unresolved candidates; this API
does not create technical interception of EDT writers.
Vanessa additions apply within existing oneC/YaXUnit targets when their context
requires them. Policy has no separate Gherkin selector;
feature normative checks remain in Vanessa workflow reports.

## Ledger binding and results

Selection belongs to one `target`: a stable scope with project/component.
Target enters the digest with kind, artifact, operation, mechanisms, selected
requirements and nonempty additionalRequirements.
`current.target/artifact/operation` must match selection.
Use separate selections for independent scopes; a specific scope's enclosing
context may be referenced in evidence.

`current.sourceRef` identifies the assessed phase's specific state.
For oneC it matches `current.detection.sourceRef`.
Each ledger row contains `selector`, `selection_digest`, `target`, `source_ref`,
`status`, `evidence` and, for deviation, `reason`.
`target` and `source_ref` must match current.
`selector` is a normative reference; `matchedRows` contains internal registry IDs.

After source-revision changes selection may be reused if scope/applicability are
unchanged. Recheck the ledger for the new state with current `source_ref` and
substantive evidence. Merely replacing the reference without verification does
not make old assessments true. Policy checks claim consistency, not provenance,
authenticity or EDT freshness.

| Result | Meaning |
| --- | --- |
| `ledger_valid` | Ledger contains all selection selectors and agrees with current; mandatory rows are `passed`, recommended rows `passed` or justified `deviated`. This does not imply complete requirement selection, true evidence or writer permission. |
| `blocked` | Structurally correct ledger contains `failed` or `unverified`; `unresolved` lists selectors, strength and statuses. Workflow permits read-only reports and prohibits dependent writes/full compliance conclusions. MCP does not itself intercept writers. |
| MCP `isError` | Invalid request, stale/changed selection, context mismatch, incomplete ledger or forbidden mandatory deviation. |

`counts` counts ledger rows and deviations, not independently checked requirements.
Design allows only `phase: proposal`; review only `phase: result`.
Create/change uses both phases; the server does not retain their execution history.
Normative-text accuracy, completeness/revision, project exceptions, EDT diagnostics
and behavioral results are checked separately under the workflow.
EDT primary validation and BSL LS are not unconditional proof of defects:
apply the shared [diagnostics contract](../skills/1c-routing/references/diagnostics.md)
with rule, settings, revision and context completeness.

Shared action tools check only declared effects/scope and caller evidence of
actual user assignments. They do not authenticate people, compute arbitrary
tool effects or replace host approvals.

## Migration from 1.1

Protocol version is `2.1.0`, registry schema `2`,
registry `2026-10-20.1`.
Migration from 1.1 is incompatible: recreate selections and ledgers.
The 2.1 addition preserves 2.0 format/digest without additions.

- Replace `sourceText` with explicit assessments from authorized facts.
- Both selectors add mandatory `target`.
- Current requires `target`, `artifact`, `operation`, `sourceRef`, `mechanisms`.
- Ledger replaces `rule_id` with `selector` and adds `source_ref`.
- Validator response `status: passed` becomes `ledger_valid|blocked`; counters
  use `counts`. Individual ledger-row `passed` is retained.
- `run/report` no longer create empty selections with passing digests.

## Recommendations for further development

1. Maintain selector/exact-heading reconciliation against corpus revision.
   Structural registry tests check the bundled contract and declared coverage;
   see [local verification limits](../docs/ACCEPTANCE.md).
   They do not verify the published v8std corpus, complete normative relationships
   or live runtime acceptance.
2. For stronger evidence obtain receipts from source/normative authorities:
   artifact identity, revision/hash, exact selector, text completeness/revision.
   Verify them through a trusted party; another self-reported field alone creates
   no proof.
3. Use existing v8std code/context retrieval for candidates and EDT/analyzer for
   verifiable source facts. Do not maintain a second partial BSL parser or duplicate
   search index within policy. Do not turn v8std heuristic confidence into confirmed
   defects or complete requirement selection.
4. Introduce machine-applied project exceptions together with verifiable scope,
   source, condition and revision. Until then the agent explicitly resolves profile
   exceptions/conflicts; the checker does not interpret them automatically.
