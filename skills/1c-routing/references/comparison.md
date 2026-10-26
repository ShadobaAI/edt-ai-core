# Comparison and decision files

Check guides for `compare_configurations`, `get_comparison_node`, `merge_rules`.
Comparison/rules authoring does not perform a merge. Establish exact project,
other/ancestor revisions and bounded scope; the current side includes the
uncommitted model.

Start comparison once, retain job/comparison IDs, wait for the finished tree and
read only needed nodes. An incomplete tree does not prove no differences.
Reading rules does not authorize writing them. Pass a finished comparison ID
for validation; `NOT VALIDATED` is not an accepted plan. Preserve prior decisions
through `basedOn`; overwrite requires scope for the same file. Follow the current
guide for ZIP addressing; matching entry names do not allow transferring decisions
to other revisions.

EDT has a shared comparison slot: release only this task's finished comparison
by retained ID after required validation. Do not close another session.
Report comparison, rules validation and any actually performed merge separately,
provided the merge was separately authorized and performed.
