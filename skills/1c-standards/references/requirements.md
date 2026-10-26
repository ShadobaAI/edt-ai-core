# Requirements workflow

Verify substantive applicability and exact normative text through v8std; bundled
policy supplies a baseline and assessment-consistency checks, not source analysis.
The full function set is available in live schemas. Retain sufficient facts and
text within the task, refreshing only what changed.
Bind confirmed contracts, applicable requirements and check results to their
source/authority, target, context and confirmed revision/binding.
Reuse current facts and sufficient normative text across phases when their
conditions and boundaries are unchanged. For each new phase state what they
confirm: baseline checks do not prove changed results, and selection/ledger and
session refs do not transfer as completed conclusions. Apply corpus reuse rules
from the [MCP contract](mcp.md#повторное-использование-evidence), without a new full
search for an already confirmed contract.
On revision, binding/identity, affected-code, publication/corpus changes, errors
or contradictions, establish which facts depend on them. Refresh only those:
unchanged normative text does not need retrieval after a local edit, and changed
platform context does not invalidate unrelated facts of another artifact.
Renew expired session refs in the current session; do not repeat the whole
investigation for that reason. Do not retain stale target verification as
economy; mandatory readiness, guards and post-validation remain.
Keep bounded evidence in task context and native session refs, without a separate
persistent reasoning database, transcript or normative-corpus copy. Accepted
decisions may be recorded in existing owning SDD/ADR under project rules;
these are work results, not duplicate normative or search-history storage.
Do not treat native technical state receipts as proof of reasoning or normative
assessment truth.

| Assignment | Policy operation | Phases |
| --- | --- | --- |
| Design without writes | design | proposal |
| Creation/change | create/change | proposal before writing, result afterward |
| Exact revision review | review | result |
| Test execution/report only | run/report | authoring workflow not needed |

Review/execution requests do not authorize fixes. Proposal is a specific
in-memory proposal with authorized baseline facts, not a completed EDT write.
Result is the actual outcome or exact reviewed revision. Target includes the
owning project/component; sourceRef binds baseline, phase and revision/hash.
The current model does not replace historical revision. Read protected source
through assigned authorities, not generic filesystem.

1. Obtain minimal sufficient source/context evidence. Assess baseline →
   proposal/result transition mechanisms, including additions, deletions and
   enclosing invariants. The first planned query already means query_text: present;
   deletion and rename remain transition mechanisms after writing. Exclude
   unrelated module code.
2. Perform [v8std selection](discovery.md) for affected code/context.
   Check exact conditions of discovered requirements, corporate rules and framework
   patterns. Pass applicable requirements beyond baseline in additionalRequirements
   [{selector,strength,basis}]. The registry does not prove corpus completeness;
   agent assessment does not replace normative text. Do not reread sufficient text
   already obtained.
3. Prefer **policy.assess_1c_requirements**: one call with target, artifact
   (bsl/query/metadata), operation, mechanisms, sourceRef and assessments of all
   critical mechanisms from the live schema. Present/absent require evidence;
   unchecked facts remain unknown and block selection. Comments/names/strings do
   not prove semantics. The response contains selection, selectionRef and detectionRef
   of the current MCP session. Clients without this tool may use
   detect_1c_mechanisms → full compact-v1 detection → select_1c_requirements.
   Do not truncate coverage.
4. Obtain each unread selector's exact text (document#heading means the exact section)
   through v8std. Check found, identity, truncation and necessary exceptions.
   Check each selector once; mandatory takes priority.
   Additional requirements do not weaken baseline or close missing mappings.
5. Assess proposal/result and pass **policy.validate_compliance_ref**:
   selectionRef, phase, explicit current {target,artifact,operation,sourceRef,
   mechanisms,detectionRef,additionalRequirements} and rows
   [[selector,status,evidence,reason?]]. Each row binds a specific requirement
   condition to the current target. Passed requires substantive verification;
   failed/unverified are allowed, while deviated with reason is allowed only for
   recommended. Missing rows, contradictions, different target/mechanisms/registry/
   sourceRef are rejected. The full equivalent validate_compliance remains
   available; formats are defined in schema.

**Blocked** (including isError:false), unknown, unavailable/missing registry
coverage, incomplete mandatory text, unavailable policy or violated mandatory
requirements block dependent writes/full compliance conclusions.
A partial read-only report with exact limits is allowed. Ledger_valid confirms
only assessment-record consistency; it does not prove evidence true or authorize
writing. Do not invent passed to satisfy validation.

After writing, perform a separate result check on the current actual outcome.
For M/H reassess detection; L may reuse applicability after verifying unchanged
mechanisms and context. A new sourceRef requires current detection evidence and
new row assessments. For new mechanisms, additions, artifact/operation changes,
registry/corpus changes, relevant exceptions or contradictions, revise selection
and obtain only new/invalidated text with a reason. References work only in their
creating session and may expire; they are not proof tokens.

Proposal does not replace result. If a new mandatory condition appears after
writing, verify it and, if needed, perform a new guarded correction.
EDT diagnostics, query validation and behavioral tests remain independent gates;
L/M/H does not reduce normative strength. Do not repeat equivalent successful
calls within a phase unless facts are invalidated.
Reducing investigation does not merge proposal/result or remove the full set of
applicable mandatory conditions. A new sourceRef, incompatible session ref or
changed applicability requires current detection/selection/rows under the live
policy contract; reuse unchanged confirmed contracts and text.
Do not repeat full MCP/corpus traversal without a new basis.

## YaXUnit

For YaXUnit authoring also use select_yaxunit_requirements with actual test
mechanisms and applicable additions → exact v8std patterns → the same ledger/phase
contract through full validate_compliance. This selection is separate from general
1C requirements. Run/report returns not_applicable without digest and does not
authorize authoring; debug/migrate that fixes BSL uses general operation: change.

The [detailed protocol](requirements-details.md) serves applicability conflicts,
phase transitions and full API integration. It preserves the same guarantees.
