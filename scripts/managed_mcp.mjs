import { argumentsOf, settings, state_path, entrypoint } from "./common.mjs";
import { serve_managed as serve } from "./runtime.mjs";
import { create_diagnostic_logger } from "./diagnostics.mjs";
export { serve };
export async function main() {
  const a = argumentsOf(
    undefined,
    ["direct"],
    ["component", "project_root", "state_dir", "settings", "node"],
  );
  if (!["code-index", "bsl-ls"].includes(a.component))
    throw new Error("Select --component code-index or bsl-ls");
  const config = settings(a.settings);
  return serve(
    a.component,
    a.project_root,
    state_path(config, a.state_dir),
    config,
  );
}
if (entrypoint(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (error) {
    create_diagnostic_logger("managed").event("launch_failed", { error }, "error");
    process.stderr.write("1c-ai-core: " + error.message + "\n");
    process.exitCode = 1;
  }
}
