# Recovery from a pre-write EDT model-gate refusal

Apply only while performing an authorized change through the assigned EDT.
The workflow is shared across projects and determined by the actual refusal,
not the server version. Confirm the same pre-mutation refusal against the live
contract. This is a bounded exception to the single-correction rule,
not a retry of any unsuccessful write.

## Entry conditions

All conditions must hold simultaneously:

- The failed operation is exactly `create_metadata` or `modify_metadata`.
- The response contains `isError: true`, `structuredContent.success: false`
  and the exact message:
  `Project is building: the model or the reference index is still being computed. Please wait and retry.`
- The installed contract confirms that this refusal occurs before writing.
  There is no running write job, `mutationCommitted`, `mutationOutcomeUnknown`
  marker or other uncertain outcome.
- The authorized repository, EDT instance/URL, project and task scope remain unchanged.

Timeouts, connection loss, ambiguous responses, pending write jobs, other error
text and unconfirmed refusal timing do not qualify. Apply the main unknown-outcome
verification workflow; do not retry the writer under this exception.
`list_projects: ready` allows this recovery but does not prove model readiness
for writing. Read-only review does not authorize recovery that retries a writer.

## Targeted recovery

1. Retain the failed tool, complete original arguments, guards and attempt count
   for the specific intended operation. Confirm the same project's exact
   name/path/open/EDT nature and unchanged binding. A changed binding or lost
   readiness stops dependent actions until mandatory prerequisites are restored.
2. Establish the top-level owner from the already resolved FQN:
   for `Catalog.X.Form.F.Group.G` it is `Catalog.X`. When creating a top-level
   object that does not yet exist, the owner of the immediately preceding
   successful saved write is allowed only if that write is confirmed in this
   session, belongs to the same project and authorized task scope, and its owner
   still resolves in EDT. Without such an owner, stop recovery.
   Do not guess a neighboring object.
3. Run the assigned EDT's `revalidate_objects` once per attempt, passing the exact
   project and a nonempty `objects` containing only this owner. Do not omit
   `objects` or pass an empty list. Check completed success and that the owner
   is marked Validated rather than Not found/Skipped. If a job is returned,
   follow that same job to a confirmed outcome; an ack is insufficient.
   On timeout, do not start a new revalidation or writer while the prior outcome
   remains unknown.
4. Through the same EDT, check the exact target: absence for create, current values
   for modify and applicability of all retained guards. Refresh the required
   focused diagnostic baseline. If the effect already exists, verify the result
   without writing again. Changed state/guards terminate this recovery and require
   reconciliation under the main workflow; do not change failed arguments within
   recovery. Counter rules for this transition are defined below.
5. Retry the unchanged write once, retaining all guards. Confirmed saving and
   ordinary post-diagnostics/result compliance complete this operation's recovery
   and allow the task to continue. If the same proven pre-write refusal recurs,
   repeat steps 1–5 within **three recovery attempts total**: at most three writer
   retries after the original refusal. Preserve the counter across turns;
   renaming or restating the same operation does not reset it.
   A distinct independent operation has its own budget.

A different refusal, unknown outcome, failed revalidation/diagnostics or loss of
a mandatory prerequisite terminates recovery. For async revalidation, observing
the existing job is allowed; a new writer requires confirmed completion.
Do not revalidate preventively after every successful write.

## After three identical refusals

6. Stop writes. Prepare a concrete `clean_project` scope: project/path, failed
   operation and results of three attempts; state that clean resets build results
   and starts a rebuild. Under the shared
   [action policy](../../1c-routing/references/action-policy.md), check the user's
   actual permission to clean this project. Reuse permission already given for the
   same scope; otherwise request only the missing agreement. A code-change assignment
   or this workflow's existence does not authorize clean.
   Do not clean before permission is obtained.
7. With permission, run `clean_project` for the exact project **once**, using the
   live schema/guide. Confirm the final rebuild/job outcome and readiness of the
   same project. A clean/rebuild timeout requires checking the existing operation;
   another clean is forbidden. Invalidate affected facts and recheck target,
   guards and focused baseline. If the effect is absent and original
   arguments/guards still apply, allow **one final writer retry**. Changed guards
   require reconciliation rather than automatic payload replacement.
   Further refusal or uncertainty stops recovery; neither clean nor the budget
   repeats. If the effect already exists, verify it without another writer.

This stage is available only after three qualifying recovery attempts with the
same refusal, not after a timeout, unknown owner or diagnostic error.
The maximum writer calls are the original, three retries before clean and one
after authorized clean. Cascading rename/delete, database/launch and other effects
retain their own readiness and scope requirements.

Reconciliation follows the main workflow with current source/guards, requirement
applicability and proposal. Writing a changed payload is not an authorized retry
under this exception. If reconciliation continues the same intended operation,
retain its writer count and clean history: a changed hash, new proposal or
reworded task does not create a new operation. Any subsequent writer consumes
the remaining overall limit; after clean, at most one writer remains regardless
of workflow transitions. If the final writer already ran, reconciliation does
not grant another retry or clean.

Do not restart EDT, run whole-project revalidation, bypass the model gate or edit
serialized files. Retain the counter, owner, revalidation/write/clean outcomes,
check results and stopping reason in the report.
