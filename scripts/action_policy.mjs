import path from "node:path";
import {
  ROOT,
  ConfigError,
  load,
  cli,
  entrypoint,
  argumentsOf,
} from "./common.mjs";
export function effective_policy(overlay = {}) {
  const defaults = load(path.join(ROOT, "policy/default.json"));
  if (
    overlay.allow_shell_source_read !== undefined &&
    overlay.allow_shell_source_read !== false
  )
    throw new ConfigError(
      "Project policy cannot permit shell access to protected source",
    );
  const required = defaults.require_explicit_confirmation;
  if (
    overlay.require_explicit_confirmation &&
    required.some(
      (value) => !overlay.require_explicit_confirmation.includes(value),
    )
  )
    throw new ConfigError(
      "Project policy cannot remove shared agreement groups",
    );
  return {
    ...defaults,
    ...overlay,
    require_explicit_confirmation: required,
    workflow: "skills/1c-routing/references/action-policy.md",
  };
}
if (entrypoint(import.meta.url))
  await cli(async () => {
    const a = argumentsOf();
    const policy = a._[0]
      ? (await import("./profile.mjs")).project_profile(a._[0]).policy
      : {};
    console.log(JSON.stringify(effective_policy(policy), null, 2));
  });
