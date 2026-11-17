# EDT editing contracts

Read only the section for the current artifact. Verify parameters and capabilities
against the assigned EDT's live schemas and `get_tool_guide`. The examples below
do not establish support for a particular mode in every version. The parent skill
defines baseline, applicable preconditions, job handling and result checks.

## BSL

- Prefer `read_method_source` for known methods. Use `methodNames` for several
  in the same module when supported. Check `methodsNotFound` before using the
  batch as evidence. Use module structure for unknown boundaries and a bounded
  `read_module_source` range for code outside known methods.
  Pass the returned `contentHash` unchanged as `expectedHash` when supported.
  It can cover the whole module and be read separately from the excerpt.
  If a concurrent edit is observed, reconcile the method and its token before
  writing. For a fragment change, use the exact unique `oldSource` precondition
  where supported. Refresh the token after changes. New modules have no
  existing-content token.
- When method modes are supported, choose `replaceMethod` for one method,
  `insertBefore`/`insertAfter` beside an established `methodName`, and
  `searchReplace` for a unique fragment. Follow the live preconditions for
  method modes, which can require `expectedHash`. For a justified whole-module
  replacement on versions with only `expectedSource`, pass the exact baseline.
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

- Check the changed query through `validate_query` in its owning `projectName`.
  Where supported, use `modulePath` and `method` for saved query literals. Verify
  that each changed query appears in `queries` with a complete valid verdict.
  For skipped or unmatched queries, validate the complete resolved `queryText`
  or report the gap if that text is unknown. Use supported `dcsMode` for DCS
  queries. Rows, totals, rights and performance need runtime evidence.
- For DCS, variants, dynamic lists and conditional appearance, start with `dcs get`
  for the exact root, then read only needed returned nodes/pointers. A root summary
  is not the full query or all settings. Resolve unknown writable vocabulary
  through supported `options`/guide.
- When the live contract provides a `hash` and accepts `expectedHash`, retain
  and pass it. Follow the live operation's requirements for `replace`, `remove`
  and index-addressed changes. Copy real pointers rather than guessing indices;
  refresh addresses and applicable preconditions after writing.
- Prefer `update` for existing nodes and `upsert` for intentional creation.
  `replace` may reset omitted values and collections: the entire replacement
  must be in scope. `remove` requires deletion scope.
- Establish typed chart and other construct support from the current guide;
  do not turn older-version limits into universal bans. An unavailable mode
  does not authorize generic metadata or file writes in place of DCS.
- For authorized whole-schema XML transfer, read every `nextOffset` page and pass
  one complete document. When page hashes are provided, do not mix pages with
  different hashes; pass an available destination precondition as specified by the
  guide. Do not send a single page or mix XML and structured members.
- Check affected nodes, preserved settings and the final query when changed.
  This supplements mandatory focused EDT post-validation.

## Metadata and forms

Read `get_metadata_details` of the minimal owning node; `full=true` is needed
only for actual collection members. Use `assignable` when the needed facts are
supported property values. For collections, use type/name filters and supported
paging in `get_metadata_objects`. Use the programmatic Name with supported
Russian or English structural tokens. For rename/delete,
assess affected data, references, permissions and integrations; do not expand
the operation through cascading changes without the corresponding scope.
Check the live operation's support for the exact nested object and rename mode;
changing a `name` property is not necessarily a supported rename. If unavailable,
report the specific limitation and affected operation rather than inventing a
file-write or delete/recreate workaround. Use the
[write precondition rules](../SKILL.md#before-writing). A creation precondition
asserting that the new node does not exist does not check the parent's version
or protect later changes to the object or its rights.
Verify the changed properties, membership or rights and any relevant preserved
state under the live result contract.

Use structured clone/adopt/sort and route-map operations when supported for
the exact source, destination and object type. Where preview and confirmation
are supported, check the destination and references in the preview. For forms, use
`validate_form_model` for model issues and a focused `get_form_layout_snapshot`
for layout. A rendered screenshot requires separate capability and EDT render
readiness.

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
