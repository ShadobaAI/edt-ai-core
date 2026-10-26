# Readiness after changing HEAD

This is bounded read-only waiting for consequences of your own authorized
checkout/pull/fast-forward. An initial infrastructure failure does not become a
build wait. The route must already be checked before Git preparation.

For each stage retain a unique stage, HEAD SHA, exact repository/EDT URL of the
current instance and a `{projectName, expectedPath}` list containing only affected
projects. One managed poller per stage; stop the old one before the next HEAD
change. Use the existing MCP, live `list_projects` schema and structured results;
do not launch another EDT or alternative HTTP process merely to wait.

Every successful complete response must confirm a unique name match, normalized
absolute path, `open=true` and EDT nature. `building` and transitional `unknown`
allow only continuing this poll, not source reads. Only all projects being
`ready` for the current stage/HEAD allows dependent analysis.
Missing/duplicate projects, path/nature mismatches, closed projects, transport
errors, incomplete responses or other unusable states immediately block the stage.

Set a finite deadline (15 minutes by default unless the project specifies another).
Poll at most once every 10 seconds; report state changes and retain the last
complete response. Resume running exec cells with the same `wait`/ID, without new
pollers; short waits allow user updates. Timeout/cancellation is not ready;
do not reuse old readiness after HEAD, instance URL or stage changes.
For blockers report tool, route/stage/HEAD, last state and reason.

Independent read-only work may continue during building if it needs no new model.
Ready does not prove write readiness or authorize writes.
