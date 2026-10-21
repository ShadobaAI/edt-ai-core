import { argumentsOf, settings, state_path, entrypoint } from "./common.mjs";
import { launch_command, project, acquire_reader } from "./runtime.mjs";
import fs from "node:fs";
import { require_preparation } from "./components.mjs";
import { effective_settings } from "./project_context.mjs";
import { launch, stop_child } from "./processes.mjs";
import { once } from "node:events";
export async function serve(component, selected, state, config) {
  const [root, data] = project(selected, config, component === "code-index");
  config = effective_settings(config, root, data, null, state);
  require_preparation(state, root, component);
  const lease = component === "code-index" ? await acquire_reader(state, root) : null;
  try {
    const [command, cwd, env] = await launch_command(state, config, component, root, data);
    const child = launch(command[0], command.slice(1), {
      cwd,
      env: env || process.env,
      stdio: ["pipe", "pipe", "inherit"],
    });
    const terminate = () => { void stop_child(child, 0); };
    process.once("SIGTERM", terminate);
    process.once("SIGINT", terminate);
    child.stdin.on("error", () => {});
    process.stdin.pipe(child.stdin);
    child.stdout.pipe(process.stdout, { end: false });
    try {
      const [code] = await once(child, "close");
      return code ?? 1;
    } finally {
      process.stdin.unpipe(child.stdin);
      process.stdin.pause();
      await stop_child(child);
      process.removeListener("SIGTERM", terminate);
      process.removeListener("SIGINT", terminate);
    }
  } finally {
    if (lease) fs.rmSync(lease, { force: true });
  }
}
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
    process.stderr.write("1c-ai-core: " + error.message + "\n");
    process.exitCode = 1;
  }
}
