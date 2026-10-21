// A saved preference is never evidence of this connection's selected project.
import { ROOT, resolve, select_root, ConfigError } from "./project_paths.mjs";
export function launch_selection(cwd = process.cwd(), explicit = process.env.EDT_AI_PROJECT_ROOT) {
  const directory = explicit ? resolve(explicit) : resolve(cwd);
  return { directory: directory === ROOT ? null : directory,
    source: explicit ? "environment" : directory === ROOT ? "unselected" : "launch_directory" };
}
export function roots_selection(message, cwd = process.cwd()) {
  if (message.error?.code === -32601) return launch_selection(cwd, "");
  if (message.error || !Array.isArray(message.result?.roots))
    throw new ConfigError("Host could not supply the selected directory");
  if (!message.result.roots.length) return { directory: null, source: "roots" };
  const directory = select_root(message.result.roots, cwd);
  return { directory: directory === ROOT ? null : directory, source: "roots" };
}
