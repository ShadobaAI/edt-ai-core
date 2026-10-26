import path from "node:path";
import {
  ROOT,
  settings,
  state_path,
  cli,
  argumentsOf,
  entrypoint,
} from "./common.mjs";
import { exists, locate_project } from "./project_paths.mjs";
import { project_profile } from "./profile.mjs";
import { artifact, project, smoke } from "./runtime.mjs";
import { effective_settings } from "./project_context.mjs";
import { effective_policy } from "./action_policy.mjs";
import { smoke as policySmoke } from "./policy_runtime.mjs";
import { managed_components, component_enabled } from "./components.mjs";
import { knowledge_status } from "./knowledge.mjs";
import { probe_connections } from "./setup_probe.mjs";
import { environment_compatibility, verification_limits, safe_error_message, register_diagnostic_secrets } from "./diagnostics.mjs";
export async function inspect(
  selected,
  config,
  state,
  live = false,
  managed_only = false,
) {
  const root = locate_project(selected),
    data = project_profile(root);
  config = effective_settings(config, root, data, null, state);
  register_diagnostic_secrets(config);
  const report = {
    status: "configured",
    project_root: root,
    errors: [],
    warnings: [],
    managed: [],
    external: {},
    full_development_readiness: "not_verified",
    profile_id: data.profile_id,
    knowledge: knowledge_status(data, config),
    action_policy: effective_policy(data.policy),
    environmentCompatibility: environment_compatibility({ projectRoot: root }),
    verificationLimits: verification_limits(),
    source_guard: {
      packaged: exists(path.join(ROOT, "hooks/hooks.json")),
      host_trust: "not_verified",
      host_activation: "not_verified",
    },
  };
  if (!data.repositories.length)
    report.errors.push("No repository mappings configured");
  for (const [name, entry] of Object.entries(config.mcp.required)) {
    const configured = !!entry.url;
    report.external[name] = { configured, mode: "user", live: "not_verified" };
    if (!configured)
      (managed_only ? report.warnings : report.errors).push(
        "Set user-started MCP URL: " + name,
      );
  }
  report.warnings.push(
    "EDT/v8std live acceptance requires the user's running servers",
  );
  if (live && !managed_only) {
    const probe = await probe_connections(config, root, data);
    report.external = probe.external;
    report.knowledge = probe.knowledge;
    report.verificationLimits = probe.verificationLimits;
    report.setup_scope = probe.scope;
    for (const [name, result] of Object.entries(probe.external))
      if (!result.ready) report.errors.push(name + ": " + (result.detail || "External readiness not verified"));
  }
  if (report.knowledge.state === "invalid" || report.knowledge.mode === "kora" && !report.knowledge.ready)
    report.errors.push("knowledge: " + report.knowledge.detail);
  else if (report.knowledge.provider === "openviking" && !report.knowledge.ready)
    report.warnings.push("knowledge: " + report.knowledge.detail);
  if (live && !report.errors.length) {
    project(root, config);
    try {
      report.policy = await policySmoke(config);
    } catch (error) {
      report.errors.push("policy: " + safe_error_message(error));
    }
    for (const component of managed_components.filter(id => component_enabled(config, id))) {
      try {
        const probe = await smoke(state, config, root, data, component);
        report.managed.push(probe);
        if (component === "code-index" && probe.index_ready !== true)
          report.errors.push(
            "code-index: repository index readiness was not confirmed; check index health and repository coverage",
          );
      } catch (error) {
        report.errors.push(component + ": " + safe_error_message(error));
      }
    }
    report.status = "managed_mcp_ready";
  } else
    for (const component of managed_components)
      report.managed.push({
        component,
        enabled: component_enabled(config, component),
        installed_and_hash_verified: !!artifact(state, component),
        live: "not_checked",
      });
  if (report.errors.length) report.status = "error";
  return report;
}
if (entrypoint(import.meta.url))
  await cli(async () => {
    const a = argumentsOf(undefined, ["live", "managed_only"]),
      config = settings(a.settings),
      result = await inspect(
        a._[0],
        config,
        state_path(config, a.state_dir),
        a.live,
        a.managed_only,
      );
    console.log(JSON.stringify(result, null, 2));
    return result.errors.length ? 1 : 0;
  });
