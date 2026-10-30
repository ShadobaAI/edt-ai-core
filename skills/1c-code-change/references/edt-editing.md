# EDT editing contracts

Read only the section for the current artifact. Verify parameters and capabilities
against the assigned EDT's live schemas and `get_tool_guide`. The examples below
do not establish support for a particular mode in every version. The parent skill
defines baseline, guards, job handling and result checks.

## BSL

- Prefer `read_method_source` for a method. Its `contentHash` may cover the entire
  module: pass the unchanged token as the contract's `expectedHash`; do not
  calculate it from method text. Do not reuse the old token after a change.
- When method modes are supported, choose `replaceMethod` for one method,
  `insertBefore`/`insertAfter` beside an established `methodName`, and
  `searchReplace` for a unique fragment. Retain mandatory anchor and hash guards.
  For method replacement, account for documentation and annotations within the
  replaced span; preserve the name, procedure/function kind and required directives.
  Insertion must not split the adjacent method's annotations/documentation block.
- Ambiguous anchors, stale hashes, syntax errors and unsupported declarations
  require resolving the specific cause. Do not bypass refusal with whole-module
  rewrite, `overwrite=true` or `skipSyntaxCheck=true`.
- Choose one module addressing method from the guide: `modulePath` or
  `objectName` with the required selectors. Creating a module file does not prove
  extension metadata adoption. Write-time block-balance/syntax checks do not
  replace EDT diagnostics.

## Queries and DCS

- Check the complete changed query through `validate_query` in its owning
  `projectName`; use supported `dcsMode` for DCS queries. Check `valid`, not just
  call success. Static validation does not prove rows, totals, rights or performance.
- For DCS, variants, dynamic lists and conditional appearance, start with `dcs get`
  for the exact root, then read only needed returned nodes/pointers. A root summary
  is not the full query or all settings. Resolve unknown writable vocabulary
  through supported `options`/guide.
- Retain the returned `hash` and pass `expectedHash` under the contract;
  `replace`, `remove` and index-addressed changes require a hash guard.
  Copy real pointers rather than guessing indices; refresh addresses and guards
  after writing.
- Prefer `update` for existing nodes and `upsert` for intentional creation.
  `replace` may reset omitted values and collections: the entire replacement
  must be in scope. `remove` requires deletion scope.
- Establish typed chart and other construct support from the current guide;
  do not turn older-version limits into universal bans. An unavailable mode
  does not authorize generic metadata or file writes in place of DCS.
- For authorized whole-schema XML transfer, read every `nextOffset` page with an
  unchanged hash and pass one complete document with the destination hash as
  specified by the guide. Do not send a single page or mix XML and structured members.
- Check affected nodes, preserved settings and the final query when changed.
  This supplements mandatory focused EDT post-validation.

## Metadata and forms

Read `get_metadata_details` of the minimal owning node; `full=true` is needed
only for actual collection members. Establish the programmatic name before writing:
synonym search does not make a synonym a valid write identifier. For rename/delete,
assess affected data, references, permissions and integrations; do not expand
the operation through cascading changes without the corresponding scope.
Check the live operation's support for the exact nested object and rename mode;
changing a `name` property is not necessarily a supported rename. If unavailable,
report the specific limitation and affected operation rather than inventing a
file-write or delete/recreate workaround. Verify the actual compare-and-write
guard for metadata properties; a reread cannot make an unguarded write atomic.
When an authorized write can proceed without a guard, explicitly report the
affected operation and residual risk of overwriting concurrent changes; include
that limitation in the completion report. High-risk writes still require the
compare-and-write guarantee specified by the parent skill.

For command interfaces, establish the exact address first; after changing, check
saved visibility, role overrides and order. Do not edit serialized files.
An unfound role-rights target does not authorize deleting permissions.
`resync_to_disk` writes MODEL -> DISK even without cleanup flags: it is a separate
effect, not read-only diagnostics. Orphan-rights cleanup requires separate deletion
scope and proof that the target is absent; preserve uncertain targets.
Do not enable full export, overwrite or revalidation outside scope.

For visual form acceptance, use snapshots/screenshots together with model diagnostics.
An empty image does not prove an empty form. Startup render flags and
requested/forced state do not prove a buffer exists: check the renderer's actual
outcome before declaring a defect or changing settings.
