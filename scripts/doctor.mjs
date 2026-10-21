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
  const report = {
    status: "configured",
    project_root: root,
    errors: [],
    warnings: [],
    managed: [],
    external: {},
    full_development_readiness: "not_verified",
    profile_id: data.profile_id,
    action_policy: effective_policy(data.policy),
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
  if (
    data.knowledge.provider === "openviking" &&
    (!config.mcp.optional.openviking?.enabled ||
      !config.mcp.optional.openviking?.url)
  )
    report.warnings.push(
      "Profile requests optional OpenViking, but no enabled URL is configured",
    );
  if (live && !report.errors.length) {
    project(root, config);
    try {
      report.policy = await policySmoke(config);
    } catch (error) {
      report.errors.push("policy: " + error.message);
    }
    for (const component of ["code-index", "bsl-ls"]) {
      try {
        const probe = await smoke(state, config, root, data, component);
        report.managed.push(probe);
        if (component === "code-index" && probe.index_ready !== true)
          report.errors.push(
            "code-index: repository index readiness was not confirmed; check index health and repository coverage",
          );
      } catch (error) {
        report.errors.push(component + ": " + error.message);
      }
    }
    report.status = "managed_mcp_ready";
  } else
    for (const component of ["code-index", "bsl-ls"])
      report.managed.push({
        component,
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
