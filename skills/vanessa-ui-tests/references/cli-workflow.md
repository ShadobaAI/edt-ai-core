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
For generic `call`, establish effects from live schema/guide and actual arguments.

`run` holds the shared endpoint/TestClient lock from full readiness through reload,
syntax, independent selection/content checks, selected-scenario execution and
results retrieval. Timeout does not repeat mutation. Executed content is checked
against file hash. Automatic receipts remain unverified until actual test-outcome
assessment.

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
