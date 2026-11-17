---
name: 1c-branch-review
description: Review exact 1C branch revisions through the assigned Git read route, with EDT validation when a corresponding live model is available.
---

# 1C branch review

Use the selected repository and $1c-routing knowledge gates, including for
historical work. Establish exact base/target refs and use the
[branch workflow](references/workflow.md) for revision and scope checks.

- **Read-only** by default. Compare saved SHAs and report limits where the model
  or diagnostics cannot be tied to them.
- **Prepared review** when the requested outcome needs a remote update or live
  checkout. Apply the [action policy](../1c-routing/references/action-policy.md)
  to the assigned effects. For post-checkout checks use
  [EDT readiness](references/edt-ready.md).

Use $1c-code-change for the actual diff, reuse, sufficiency and impact and
$1c-standards for the review result assessment. Follow the workflow's independent
review and validation conditions. Report actionable findings and evidence gaps.
Findings give no permission to fix, switch refs or publish results.
