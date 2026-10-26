# Branch review modes

## Read-only — default mode

1. Establish the repository and existing base/target refs from the task and profile.
   Obtain their exact SHAs through the assigned EDT; use SHAs for subsequent diff,
   log and reads rather than movable branch names. A remote is needed only when
   the requested action actually contacts it. Dirty working trees and detached
   HEAD do not themselves prevent comparing saved revisions.
2. Read the revision-aware Git interface and `baseSHA...targetSHA` diff with file
   names and `log baseSHA..targetSHA`. Record the merge-base SHA: three-dot compares
   its tree against target, not final base/target trees. If the user explicitly
   requests tree differences, use two-dot and state the chosen semantics.
   Complete truncated output with targeted reads of the same SHAs.
3. Read target code and dependencies through the same EDT's revision-aware
   interface. Live model and code-index may evidence that revision only with
   confirmed revision/content correspondence, including no relevant unsaved/
   working-tree changes. Static analysis of saved revisions does not require
   artificial checkout or model readiness when the Git interface is model-independent.
   Unsupported exact-revision reads limit conclusions; they do not authorize shell
   reads of protected source.
4. Apply “Analysis and completion” to available evidence. Do not attribute another
   revision's live diagnostics to target or baseline. Without a corresponding model,
   mark diagnostics/tests unperformed and continue supported analysis.
   Do not save the model, stage/commit, fetch/pull, switch HEAD or delete refs merely
   for ordinary review.

If a required ref is missing or the user requires an unavailable live check,
perform the independent available portion first. Prepare a concrete plan for the
remainder and obtain only missing permission under the shared action policy.
Do not make optional remote refresh a prerequisite for local review.

## Prepared review — only necessary authorized steps

The preparation sections below apply to authorized Git preparation. Updating base,
fetching target and checkout are separate actions: skip unnecessary, completed or
unassigned steps. If exact revisions are already local, no new fetch is needed.
Incomplete preparation does not cancel available read-only review, but do not claim
the requested live check was performed.

## Scope and preserving work

Establish repository, exact review branch, base branch/ref and needed remote from
the task and project instructions; do not guess `develop`/`origin`. Check remote
URLs without credentials. Git/source operations on serialized 1C artifacts use
only the assigned EDT's current schema/guide. Ordinary scripts/docs use their own tools.

An explicit full-workflow request may already authorize commit/checkout/fetch/pull;
do not seek agreement again. Simple review requests use read-only mode above.
Agree only actually needed additional effects under shared policy.
Push, merge, rebase, reset, clean, stash, database launch and publication are not
automatic review continuations. Findings do not authorize fixes.

1. Confirm health and exact repository binding. For model-dependent work confirm
   project name/path/open/EDT nature and readiness; Git-only actions do not require
   this when model-independent under the live guide. Record branch/HEAD, needed
   remote and staged/unstaged/untracked status. Detached HEAD and unfinished
   merge/cherry-pick/rebase block switching/saving work, but not comparing saved SHAs.
2. Git reads disk, not unsaved EDT models. Saving the model is a source write:
   use supported scoped save only within authorized work preservation; if no safe
   method is known, dependent preparation is blocked.
3. For authorized work preservation, inspect both diffs and included untracked
   files. Exclude unchecked files, secrets and generated artifacts. Do not combine
   changes from separate tasks without corresponding scope. Project rules and
   saved-work facts determine task ID/message format, not the review branch name.
4. If changes are only trailing whitespace and the user has not assigned saving
   them, prepare an exact rollback preview and agree reversal. Without permission,
   preserve changes and do not switch branches; clean status needs no such question.
5. Skip stage/commit when clean. Otherwise stage only listed verified paths;
   check the entire final staged diff, including previously staged changes.
   Commit without bypassing hooks; confirm SHA and clean status. Failure or unsaved
   data prohibits checkout.

## Base and target

6. If live base diagnostics or an authorized base update is needed, switch to the
   exact local base branch after preserving work. If absent, create it only from a
   confirmed remote ref. Do not pass a remote ref as a local branch name or guess
   the starting point.
7. Before authorized update, check branch and clean status; use fast-forward-only
   pull. Divergence does not authorize merge/rebase/reset. Retain the updated base
   SHA. Before every HEAD change stop the old readiness poller; afterward invalidate
   source/hash/diagnostics/readiness and start a new stage.
8. Treat the review branch as data: check validity and quoting under the live Git
   contract. When refresh is necessary and authorized, fetch exact
   `refs/heads/<branch>:refs/remotes/<remote>/<branch>`; otherwise use an existing
   exact local ref. Narrow fetch mappings must not hide target.
   Confirm SHA; failed ref updates do not authorize force.
9. Retain name-status diff `baseSHA...targetSHA` and log `baseSHA..targetSHA`.
   Three-dot diff concerns merge base rather than final-tree differences.
   If live diagnostic comparison is requested, wait for base readiness and obtain
   a focused baseline before target checkout. Skip for diff-only review.
   Current-base diagnostics are not common-ancestor diagnostics.
10. For authorized live target checks, create a new local review branch only at
    exact target SHA. If a local branch exists and needs refresh, compare both
    directions of local/target history: local-only commits block automatic update.
    Only a behind-only branch permits fast-forward to target without a merge commit.
    Confirm HEAD == target SHA, branch and clean status. Keep HEAD unchanged
    throughout analysis.

## EDT serialization and recovery

For unexpected dirty status after checkout, compare the complete staged/unstaged
diff with the initial snapshot. Only proven changes from this workflow, including
EDT serialization, may be reverted within already authorized scope.
Preserve original user and concurrent changes. Mixed/unknown provenance stops
checkout; do not use blanket `add -A`, force-checkout, reset/clean or delete
untracked/ignored files. Scoped restore targets only verified paths and requires
actual-result checks. One checkout retry is allowed after proven repeated
serialization and scoped restoration; another refusal is a blocker.

## Analysis and completion

Apply knowledge mode and shared reuse/sufficiency checks to the actual diff of
your exact revisions. Bound conclusions when evidence is partial; do not substitute
the current working copy or change code to “check” a historical decision.

For live checks, wait for the required stage's readiness and confirm model/target
correspondence; for read-only use saved SHAs without requiring checkout.
Check the actual complete diff; finish truncation with needed objects from the
same revision. Apply $1c-code-change/$1c-standards for review, requirements and
enclosing contracts. A missing proposal does not need an invented proposal ledger.
H needs impact and a fresh reviewer; SDD/ADR are mandatory only under applicable
project gates. With valid baseline/target diagnostics, compare code/message/object
and location accounting for shifts; account for base changes in attribution too.
Scoped revalidation is allowed when needed after readiness; whole-project is not.

Run tests only with the needed scope/permission. Read-only review creates neither
tests nor fixes. Confirm defects with scenarios and code; CRLF `diff --check` and
comments do not prove errors. Git refs do not prove MR/CI/discussion presence:
API facts are required; do not invent MR IDs or automatically publish comments.

Clean local review branch/tracking refs only within authorized completion of a
prepared workflow, after retaining findings/evidence. Read-only mode does not
change refs/HEAD/worktree or create cleanup.
Check clean status and that both exact refs still equal the retained target SHA;
do not delete the base/active branch. Switch to base and delete only agreed local
refs. Unmerged branches need corresponding force-delete scope; remote deletion
is not authorized. On partial failure report each actual outcome; on cancellation,
infrastructure blockers or unfinished review preserve refs.

Report findings by priority with target SHA/file/line, original/base/target SHAs,
checked diff, diagnostic/test outcomes, normative completeness and phase statuses,
blockers, final branch/working tree and authorized cleanup outcome.
