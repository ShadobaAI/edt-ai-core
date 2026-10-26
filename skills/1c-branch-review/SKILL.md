---
name: 1c-branch-review
description: Review a 1C branch diff with the assigned EDT authority and profile-specific validation.
---

# 1C branch review

Resolve repository and exact base/target refs from the task and selected profile.
Read [the branch workflow](references/workflow.md), then choose its mode:
Apply `$1c-routing` knowledge gates and source roles to this review, including
historical revisions. A current API card/index/live model does not establish
the reviewed revision; use evidence tied to its exact SHA and context.

- **Read-only** by default: compare existing revisions without changing HEAD,
  saving the model, committing, fetching or deleting refs. No remote is required
  for existing local revisions. Report unavailable live checks separately.
- **Prepared review** when the requested outcome needs an updated remote or a
  checkout for live validation: use only the authorized preparation steps.
  For post-checkout building, use [EDT readiness](references/edt-ready.md).

Apply the shared [action policy](../1c-routing/references/action-policy.md) to
actual effects, reusing authorization for the same scope. Protected source/Git
reads use the assigned EDT's revision-aware interfaces; live model readiness is
required only for model-dependent calls. Record exact SHAs and evidence limits.

Use $1c-code-change for change-focused analysis and $1c-standards for applicable
norms. Inspect contracts and affected callers using the profile's index alias.
Assess reuse and sufficient complexity on the actual diff through the shared
controls; findings do not authorize modernization or implementation.
Report actionable defects with precise targets and verification gaps.
Do not infer that passing tests proves standards compliance.

Committing, switching branches, fetching/pulling, discarding changes or deleting
refs require the relevant user authorization. A finding does not authorize a fix.
Do not hardcode a base branch, remote, prefix, line limit or test extension.

