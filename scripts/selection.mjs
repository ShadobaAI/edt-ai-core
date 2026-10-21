// A saved preference is never evidence of this connection's selected project.
import { ROOT, resolve, select_root, ConfigError, configuration_root, is_dir } from "./project_paths.mjs";
import path from "node:path";
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

// Some desktop connections start in the plugin directory and supply empty
// roots. An explicit directory belongs only to this connection; never persist
// it as the selection of other chats or override a host-owned selection.
export function explicit_selection(current, requested, error = null) {
  if (requested === undefined) return current;
  if (error) throw new ConfigError(error);
  if (typeof requested !== "string" || !path.isAbsolute(requested) || !is_dir(requested))
    throw new ConfigError("Укажите существующую локальную папку текущего чата.");
  const directory = configuration_root(requested);
  if (directory === ROOT) throw new ConfigError("Каталог плагина не является проектом 1С.");
  if (current.directory && configuration_root(current.directory) !== directory)
    throw new ConfigError("Каталог закреплён этой MCP-сессией. Смените папку проекта в Codex.");
  return current.directory ? current : { directory, source: "argument" };
}
