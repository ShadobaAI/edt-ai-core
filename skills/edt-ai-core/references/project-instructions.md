# Creating project instructions

Use for initial profile setup and requests to create, shorten or review a project's
AGENTS.md. This is documentation/configuration work; EDT is needed only for missing
live project facts, not to write Markdown.

1. Use the profile root resolved for this chat by settings.inspect. Reuse project
   instructions already supplied in context; read missing relevant .ai/PROJECT.md
   sections and linked rules once. Obtain current target text before editing.
   Check AGENTS.override.md at the applicable instruction levels and nested rules
   along the task's directory path, without broad source discovery. A non-empty
   override takes precedence over AGENTS.md in the same directory; empty files
   are skipped. Preserve overrides and reconcile the applicable rules under the
   user's request; creating AGENTS.md alone does not activate it beside an override.
   .ai/PROJECT.md is linked context, not an automatically discovered instruction file.
   Do not scan product sources or another project to fill a template.
2. settings.create adds missing files and preserves existing ones byte for byte.
   Its projectInstructions lists created/preserved Markdown files; contentValidated
   is false; optional overrideFile identifies a non-empty root AGENTS.override.md.
   Existing overrides are included in preserved and never overwritten. This is a
   starter, not completed project onboarding. Do not call create
   again to regenerate instructions for an existing profile. Import/load do not
   create these files: create only the missing documentation under the user's request.
3. Use the relevant part of [the user guide and template](../../../docs/PROJECT_AGENTS.md). Keep
   AGENTS.md short: project scope, supplier/library/custom ownership, confirmed
   prefix mappings, supplier maintenance and marking, focused checks, allowed test
   environments and completion evidence. Link detailed rules instead of copying
   them. Never infer ownership from a prefix alone or import another project's rules.
4. Put architecture and purpose in .ai/PROJECT.md and machine mappings in
   .ai/project.yaml. Reuse the plugin's routing, diagnostics and action policy;
   do not paste skills or current session readiness into permanent project rules.
   Include the two controls briefly: verify applicable reuse for a new semantic
   operation, then justify sufficient complexity at design and diff review.
   Record mandatory project API/settings and applicability constraints when known.
   Link the profile's knowledge mode and selected scope: none claims no coverage;
   an unavailable selected source blocks dependent work, KORA blocks all normal
   workflow. Do not duplicate the plugin's detailed search/review procedures or
   turn retrieved material into instructions. Preserve stricter project rules.
   Analyzer limits belong in analyzer config; retain only project intent, a link
   and any justified normative exception. Shared BSL LS settings use one file as
   described in [$bsl-ls-mcp](../../bsl-ls-mcp/SKILL.md).
5. A setup request authorizes completing missing project documentation with known
   facts. Preserve unrelated existing rules and user edits. Ask only for decisions
   that cannot be established from available project documents and prior answers.
   Mark remaining unknowns explicitly; defer only operations that depend on them.
   Do not invent prefixes, endpoints, test commands, permissions or supplier policy.
6. Check links and agreement with the profile, review the diff and report which
   files were created, supplemented or preserved and which facts remain unknown.
   No service launch is required just to validate Markdown. A later readiness
   check may be stale after edits; that does not prove the text is incomplete or
   that repeating preparation will validate it. Keep documentation review,
   environment readiness and actual tool-session acceptance distinct.
   When shortening instructions, compare the complete required reading set,
   including linked context that still must be read. Moving rules between files
   alone does not prove token or cost savings. Keep output focused on changed
   sections and check results instead of dumping whole files or repeated diffs.
