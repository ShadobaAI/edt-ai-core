# 1C AI Core: Senior+/Staff Engineering Audit and Remediation

**Repository:** `https://github.com/ShadobaAI/edt-ai-core`  
**Target branch:** `develop`  
**Required outcome:** Audit, implement fixes, update tests and documentation, and verify the result. **Do not stop at recommendations.**

## 1. Mission and engineering bar

Perform a comprehensive codebase review and remediate confirmed issues to a **Senior+/Staff software engineering standard**. Prioritize security, correctness, resource ownership, concurrency, reliability, maintainability, and architectural simplicity.

The plugin is under active development. **Backward compatibility with obsolete contracts, legacy data formats, previous internal APIs, migration helpers, compatibility shims, and transitional fallbacks is not required.** Breaking changes are allowed when they yield a cleaner current design. Preserve supported functionality and essential safety guarantees; remove old behavior only after tracing its actual consumers.

Favor the smallest correct and maintainable solution. Apply KISS, YAGNI, DRY, and SOLID pragmatically rather than as mandatory patterns. Do not add frameworks, dependencies, layers, settings, or recovery systems without a proven need.

## 2. Establish the actual system

1. Read `AGENTS.md`, root `README.md`, `docs/ARCHITECTURE.md`, `docs/DEVELOPMENT.md`, `docs/REQUIREMENTS.md`, and `docs/QUALITY_REQUIREMENTS.md`. The latter primarily governs the *solutions produced by the plugin*, not the Node.js plugin implementation itself; apply its relevant engineering principles, not its 1C-specific rules indiscriminately.
2. Inspect the current `develop` checkout, Git status, uncommitted work, entry points, imports, runtime flows, configuration schemas, state ownership, and tests. Do not overwrite unrelated local changes.
3. Map dependencies and trust boundaries across `scripts/`, `mcp/`, `policy/`, `hooks/`, `ui/`, `vanessa/`, `skills/`, `schemas/`, `settings/`, `runtime/`, `tools/`, `.github/`, and `tests/`.
4. Run appropriate baseline checks and record existing failures before editing.
5. Treat code and observed behavior as the primary evidence. Documentation and passing tests may be stale or encode a flawed design. Verify planned/documented features against implementations.

## 3. Mandatory review and remediation areas

### 3.1 Architecture, legacy, and engineering judgment

Find and remove, where unjustified:

- Dead code, unused exports, obsolete APIs, retired modes, configuration fields, schema branches, unused dependencies, and unreachable paths.
- Legacy migration/compatibility machinery and backward-compatibility fallbacks for unsupported versions.
- Workarounds, special cases, excessive conditionals, unneeded defensive branches, and swallowed errors.
- Duplicate business logic, repeated validation, competing sources of truth, and duplicated state.
- Needless adapters, wrappers, facades, indirection, generic frameworks, premature extensibility, and inappropriate abstractions.
- Circular dependencies, mixed responsibilities, hidden coupling, implicit contracts, and surprising side effects.
- Unnecessary transformations, copies, data retention, repeated work, expensive loops, and avoidable IO.

Challenge meaningful architectural decisions: establish the root cause, inspect existing reusable mechanisms, compare genuinely viable alternatives when needed, and implement the simplest solution with justified trade-offs. Do not rewrite healthy code for style alone. File length alone is not grounds for splitting a module, and tiny one-use wrappers are not an improvement.

### 3.2 Senior+ code quality

Require explicit invariants, clear module boundaries, unambiguous ownership, predictable state transitions, readable algorithms, reasonable complexity, scoped interfaces, and precise error propagation. Prefer Node.js native APIs and existing project dependencies. Make failure, cancellation, and partial-success semantics explicit. Address testability without inventing an abstraction layer for mocks.

Assess **change cost and failure probability**, not code size or the number of design patterns. Verify both the intended behavior and whether the overall design is worth maintaining.

### 3.3 Resource lifecycle and leaks

Audit all paths for:

- Child processes, managed services, MCP servers/clients, relays, proxies, JVM processes, and their descendants.
- HTTP connections, streams, sockets, file descriptors, temporary files/directories, and runtime locks.
- Event listeners, timers, subscriptions, `AbortController`, cancellation, timeouts, unresolved promises, and unbounded background tasks.
- Caches, buffers, retained closures/references, queues, and unbounded memory growth.
- Reconnects, repeated starts/stops, profile/project switches, session closure, process crashes, and startup failures.

For each significant resource, prove **creation, ownership, release conditions, failure cleanup, and repeated/concurrent behavior**. Detect leaks, double-close, premature shutdown, orphan processes, and cleanup races. **Do not terminate intentionally long-lived managed services merely because one chat or MCP session ended.** Fix confirmed lifecycle defects and add targeted regression tests.

### 3.4 Security and trust boundaries

Inspect and fix:

- Path traversal, symlink escape, directory containment, protected-source boundaries, normalization, and TOCTOU issues.
- Command injection, unsafe process execution and arguments, and unsafe filesystem operations.
- URL validation, redirects, attacker-controlled endpoints, SSRF where applicable, and transport trust.
- Secret storage/handling and disclosure through logs, diagnostics, settings, support bundles, exports, and error messages.
- Input validation for JSON, YAML, MCP requests, schemas, archives, remote responses, and limits on sizes/decompression.
- Project/profile/session isolation, approval scope, policy/guard bypasses, and least privilege.
- Artifact download integrity, provenance, packaged contents, and supply-chain/dependency risks.

Keep essential fail-closed checks. Simplifying code must **never** weaken authorization, validation at trust boundaries, protected-source handling, or safe error behavior. Add adversarial/negative tests for material security issues.

### 3.5 Concurrency, failure handling, and stability

Verify races across sessions, projects, profiles, UI operations, component checks, configuration updates, and connection changes. Check stale async responses, version/revision conflicts, atomic writes, state corruption, timeouts, partial failures, restart/reconnect behavior, queued operations, and idempotency.

A timed-out write with unknown outcome must **not** be blindly repeated. Never introduce generic retry/backoff/polling/mutex/recovery infrastructure without an actual contract and a demonstrated need. Prefer deterministic state and targeted handling of real failure modes.

### 3.6 Settings UI and backend

Review `ui/settings.html`, `mcp/settings.mjs`, and supporting backend for:

- Single sources of truth, correct component-scoped operations, accurate state synchronization, and proper revision/context binding.
- Modal/dialog lifecycle, cleanup of listeners and timers, cancellation, and stale-result isolation.
- Safe rendering/XSS prevention, validation, save/cancel behavior, unsaved changes, and access to profile-specific data.
- User-visible error handling, accessibility, and truthful status display.

Fix defects and structural problems. Avoid an unrelated visual redesign.

### 3.7 Build, dependencies, CI, and distribution

Check `package.json`, lockfile, vendored libraries, plugin/marketplace ZIP contents, manifests, hooks, entry points, package allowlists, licenses, notices, platform/Node.js 22+ support, and build/release workflows. Remove unused dependencies and unsupported assumptions. Investigate known dependency vulnerabilities where tooling is available. Ensure local secrets and development state cannot enter distributable artifacts. Do not publish anything.

### 3.8 Documentation accuracy

Align documentation, examples, schema descriptions, usage instructions, and tests with **current supported behavior**. Remove historical migration instructions and obsolete claims rather than retaining them as compatibility promises. Distinguish local tests, contract checks, and real live integration acceptance; never claim live validation without performing it.

## 4. Mandatory language and localization audit

The project has a **deliberate two-language policy**. Enforce it across the entire repository, not merely in files changed for other reasons.

### 4.1 English is the primary engineering language

Use **English** for:

- Source code identifiers, internal names, code comments, developer-facing logs, internal diagnostic labels, test names/descriptions, and engineering scripts.
- Agent/developer instructions, especially **all** `skills/**/SKILL.md`, `skills/**/references/**/*.md`, `skills/**/agents/*`, and other skill instruction or metadata files where the text is addressed to an AI agent rather than an end user.
- `AGENTS.md`, architectural directives intended for agents, internal policies, and machine-oriented instruction text.

**Audit every file under `skills/`**, including nested references and metadata. Find Russian or mixed-language instructions, translate them to concise, technically precise English, remove verbosity and duplication, and retain the original behavioral requirements, safeguards, tool names, exact contracts, and decision criteria.

Optimize skill instructions for **token efficiency**: eliminate repeated guidance and unnecessary narrative; use compact wording and references only when they preserve correctness and discoverability. Do not truncate important policy, security, workflow, or evidence requirements merely to save tokens. Avoid loading extensive instructions by default if an existing progressive-disclosure structure can keep context small.

### 4.2 Russian is mandatory for all user-facing content

Use **Russian, completely and consistently**, for:

- The **root `README.md`** and all documentation for users, including `docs/**/*.md`, user guides, setup/configuration help, FAQ-style material, and user-oriented example README files.
- Settings UI labels, buttons, tabs, section titles, field names, descriptions, tooltips, placeholders, hints, notifications, status messages, dialogs, and validation errors.
- Interactive onboarding/help, user-facing CLI output where intended for end users, user-facing MCP/settings responses, agent-generated user prompts, and explanations shown directly to the user.
- Other display strings presented to a Russian-speaking user, including error messages and dynamically generated UI states.

Preserve **exact technical strings** as needed: `API` names, code, commands, paths, identifiers, product names, configuration keys, schema properties, protocol names, and normative terminology. Translate explanations around them, not the machine contracts. Do not translate code samples or YAML keys.

### 4.3 Resolve files with mixed audiences explicitly

- If content instructs the **agent/developer**, write it in English, even if located under `skills/` or `AGENTS.md`.
- If content is **displayed to the user**, write it in Russian, even if the string lives in an English source file, JSON, YAML, or a skill definition.
- If a file has both, keep machine/agent instructions in English and user-visible string values in Russian. Do not duplicate whole instructions in both languages.
- All user-facing project documentation must be Russian. Keep developer-facing `AGENTS.md` and agent skill instructions in English as intentional exceptions to the documentation rule.

Audit **static and dynamically assembled strings**, templates, metadata, manifests, error paths, notifications, and tests. Identify untranslated English UI/user-help text, inconsistent terminology, and accidental Russian text in agent instruction files.

Update relevant tests so the language policy is verified where practical. Do not introduce a heavy localization framework or translation dependency merely to enforce a Russian-only UI.

## 5. Legacy removal policy

Breaking changes are explicitly authorized for obsolete internal contracts and unsupported data formats. You may remove old fields, code paths, migration helpers, format converters, compatibility shims, aliases, and their obsolete tests. Update all **current consumers**, schemas, skills, UI, examples, and docs together. Unsupported data should fail explicitly and safely; do not silently reinterpret it.

**Important distinction:** checks for the version of an *actively supported* contract are not automatically legacy. For example, investigate actual usage of `scripts/compatibility.mjs` and `compatibility.core` before deleting either. Similarly, preserve checks that prevent unsupported runtime or schema versions from being misread.

## 6. Execution sequence

1. **Inventory and baseline:** map components, dependencies, lifecycle ownership, trust boundaries, language placement, tests, and initial failures.
2. **Prioritize findings:** `P0` critical security/data loss/isolation; `P1` serious defect/leak/race/reliability issue; `P2` demonstrated technical debt/complexity; `P3` cosmetic only. Every finding needs code evidence and a concrete consequence.
3. **Fix in priority order:** security/data integrity, resource leaks, concurrency/stability, legacy removal, simplification, language consistency, performance, docs/tests.
4. **Make coherent changes:** eliminate root causes, update all active callers, contracts, tests and documentation. Avoid temporary compatibility layers. Preserve unrelated local work.
5. **Verify each area:** focused tests, negative tests, repeated lifecycle operations, concurrency/failure scenarios, then the full test suite; build/package verification if distribution-facing files changed.
6. **Report only what was verified:** failures, unavailable tools and untested live integrations must be explicit.

Do not ask for approval for ordinary local refactoring and tests. Never perform destructive live actions, external publication, remote project modifications, or operations requiring separate scope approval without authorization.

## 7. Verification commands

Use the project's documented commands as appropriate:

```bash
npm ci --ignore-scripts
node tools/vendor.mjs
node tools/test.mjs
```

For packaging/entrypoint/distribution changes:

```bash
node tools/package-plugin.mjs
node tools/check-plugin.mjs .build/marketplace/plugins/1c-ai-core
```

Verify schemas, YAML/JSON examples, internal references, documentation links, residual references to removed behavior, and the language policy across **all** skills and user-facing surfaces. Test on the environments actually available; distinguish local tests from real EDT/v8std/YaXUnit/Vanessa/Codex UI acceptance. Never change a valid test simply to make it pass.

## 8. Final deliverables and acceptance criteria

Provide a concise, evidence-based final report covering:

1. **Issues fixed:** priority, root cause, files changed, solution, and verification.
2. **Debt removed:** legacy paths, workarounds, dead code, duplication, and unnecessary abstractions.
3. **Language audit:** which skill instructions were converted/compressed into English; which user-facing documents/UI strings were corrected to Russian; any remaining violations.
4. **Checks run:** commands, outcomes, regressions, lifecycle/security/concurrency coverage, and unavailable live tests.
5. **Outstanding issues:** only confirmed unresolved problems, severity, and specific blockers.

Completion requires:

- No unresolved fixable `P0` or `P1` findings discovered within the reviewed scope.
- Confirmed material legacy and unjustified complexity removed, without introducing replacement scaffolding.
- Confirmed resource leaks and concurrency defects fixed, with appropriate regression coverage.
- Project/session isolation, security, and current functionality preserved.
- Current contracts, consumers, schemas, tests, and documentation consistent.
- **All `skills/` agent instruction content in concise English; all user-facing documentation, root `README.md`, UI and help text in Russian**, with technical identifiers unchanged.
- Available checks actually run; unverified behavior clearly identified.

If the audit cannot be completed in one pass, complete the highest-risk, coherent groups of fixes first and explicitly report remaining work. **Do not substitute an audit report for implemented fixes.**
