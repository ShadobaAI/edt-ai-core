# Bundled CLI and editor transition

For `call --arguments-file`, Node.js resolves the path relative to the invocation
directory once, retains its byte hash in scope and passes Node the absolute path
and expected hash. Node checks the same read buffer's hash before dispatch and
uses its parsed arguments without rereading. Changed files require new describe
and agreement verification; changed cwd must not change executed payload.

The plugin root contains `scripts/vanessa.mjs`; it checks enabled capability,
local runtime schema, project/features/results/server binding correspondence and
shared action policy before dispatch. Obtain the plugin root from the installed
package; do not search for toolkits in Kafka checkouts.

```text
node <PLUGIN_ROOT>/scripts/vanessa.mjs describe --project-root PROJECT --feature RELATIVE_FEATURE --scenario EXACT_NAME
node <PLUGIN_ROOT>/scripts/vanessa.mjs doctor --project-root PROJECT
node <PLUGIN_ROOT>/scripts/vanessa.mjs list --project-root PROJECT
node <PLUGIN_ROOT>/scripts/vanessa.mjs run --project-root PROJECT --feature RELATIVE_FEATURE --scenario EXACT_NAME --authorization-file APPROVAL_JSON
```

Relative `--feature` is based on `projectRoot`. Files in configured `features`
and explicitly selected temporary copies within the project, for example
`.local/repair.feature`, are allowed. `describe` and `run` check the same scope:
after resolving links, the path stays inside the project and has a `.feature`
extension.

`describe` does not launch applications and prints exact scope/effects for the
authorization record; for other actions use
`describe --for-action start|setup|connect|call`.
`APPROVAL_JSON` contains `effects`, `scope`, `authorizations` under
`policy.check_action`; evidence references real human permission for this scope.
Do not create it as a substitute for agreement or expand old permission.
`configure` only displays settings; `start/setup/connect` may launch clients/
manager and modify runtime, so require corresponding effects.
`start` replaces a missing or reused non-1C PID after checking ownership, locks
and the port. An existing 1C process is never adopted by PID alone. It waits up
to five minutes for MCP and checks the actual connection, manager identity and
infobase. A newly launched manager's PID is saved before the wait; timeout never
triggers another launch. If the 1C process is not verified or MCP remains
unavailable, ask the user whether to restart the manager or start MCP themselves.
An unknown launch outcome or unverified ownership remains blocked.
Select an initial TestClient with `--client NAME` on both `describe` and the
action; without it the first entry in JavaScript property enumeration order is used
(integer keys precede other keys in ascending order). All named users share the
configured application `infobase`. `setup` creates or updates the selected
Vanessa client profile using its stored credentials, then connects it; `connect`
uses an existing profile. `setup` requires a manager owned by the local profile
and verifies each MCP socket before sending credentials. It sets the client to
thin; `connect` accepts thin or thick clients. The manager can use a different
infobase.
An already connected different client is not disconnected automatically.
Scenario steps can switch between prepared Vanessa profile names; readiness
checks the selected initial client, so inspect actual state again after a run.
For local profile fields and credential ownership, see `docs/PROFILES.md`.
For generic `call`, establish effects from live schema/guide and actual arguments;
do not supply logins or passwords through the plugin or its argument files.

`run` holds the shared endpoint/TestClient lock from full readiness through reload,
syntax, independent selection/content checks, selected-scenario execution and
results retrieval. Timeout does not repeat mutation. Executed content is checked
against file hash. Automatic receipts remain unverified until actual test-outcome
assessment.

The bundled connected-client verification currently requires Windows process
identity and reciprocal TCP ownership for this MCP session, manager and
TestClient. On Linux and macOS this CLI returns unverified for a connected
client; this does not describe upstream Vanessa's platform support. It also
blocks execution if a full idle/connection state is unavailable after the
editor transition or immediately before running the selected scenario.
The CLI does not confirm the authenticated 1C session user: `authenticatedUser`
is unverified even when the named client and its connection are verified. Do
not infer the user from a saved profile or launch parameter.

The bundled wire adapter was initially verified on Vanessa Single 1.2.043.45 /
MCP 1.31. Versions are retained as provenance. Compatibility depends on current
tools, schemas and recognized response fields; tools/list alone is insufficient.
Changed/incomplete responses remain unverified regardless of release number.

If the manager is in tree mode, use `run ... --editor-transition` with open stdin.
The same lock/session waits at most 60 seconds:

1. Receive `awaiting_editor_enable` and check manager/profile/PID.
2. With an available UI tool, observe this exact manager and its actual
   “Перейти в Vanessa Editor” element; perform only that transition.
3. Send one line `{"action":"continue"}`. Successful `open_feature_file` confirms
   editor availability; cached content does not prove it.
4. Check syntax, selection, actual content and results. After run restore tree
   mode through an observed control and obtain complete state before a new chain.

Do not continue after unrelated UI actions, ambiguous windows, expired waits or
unknown outcomes. Without UI capability stop transition; do not restart the manager
instead or invent readiness.
