import fs from "node:fs";
import path from "node:path";
import {
  ROOT,
  ConfigError,
  cli,
  deep_merge,
  load,
  validate_settings,
  argumentsOf,
  entrypoint,
} from "./common.mjs";
import {
  resolve,
  exists,
  is_dir,
  is_file,
  contained,
} from "./project_paths.mjs";
import { save_json } from "./runtime.mjs";
import { source_files } from "./package_layout.mjs";
export function build(
  destination,
  state,
  node = process.execPath,
  project_root = null,
) {
  destination = resolve(destination);
  state = resolve(state);
  node = resolve(node);
  if (!is_file(node))
    throw new ConfigError("Исполняемый файл Node.js не найден: " + node);
  if (exists(destination))
    throw new ConfigError("Каталог назначения сборки должен быть новым");
  let config = load(path.join(ROOT, "settings/defaults.json"));
  const configPath = path.join(state, "settings.json");
  if (!exists(configPath) && exists(path.join(state, "settings.yaml")))
    throw new ConfigError("Прежний settings.yaml не поддерживается; сохраните его или перенесите в архив и явно настройте текущий settings.json");
  if (exists(configPath)) config = deep_merge(config, load(configPath));
  config.state_dir = state;
  if (project_root) {
    const root = resolve(project_root);
    if (!is_dir(root))
      throw new ConfigError("Каталог проекта не существует");
    config.active_project = root;
  }
  validate_settings(config);
  const plugin = path.join(destination, "plugins/1c-ai-core");
  const excluded = new Set([
    ".git",
    ".github",
    ".agents",
    ".venv",
    ".work",
    ".build",
    "node_modules",
    "tools",
    "tests",
    "packaging",
    "examples",
    "AGENTS.md",
    ".gitignore",
    ".gitattributes",
    "package-lock.json",
    "local.yaml",
    "runtime.local.json",
  ]);
  if (
    contained(ROOT, destination) &&
    !excluded.has(path.relative(ROOT, destination).split(path.sep)[0])
  )
    throw new ConfigError(
      "Каталог назначения должен находиться вне плагина или в исключённом каталоге разработки",
    );
  // Share the release allowlist; checkout state and credentials stay outside.
  const files = source_files(ROOT);
  for (const name of files) {
    const target = path.join(plugin, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(ROOT, name), target);
  }
  save_json(path.join(plugin, "hooks/runtime.local.json"), {
    node,
    state,
    settings: configPath,
  });
  const hooks = load(path.join(plugin, "hooks/hooks.json"));
  for (const groups of Object.values(hooks.hooks))
    for (const group of groups)
      for (const handler of group.hooks)
        handler.command = handler.command.replace(/^node /, '"' + node + '" ');
  save_json(path.join(plugin, "hooks/hooks.json"), hooks);
  const mcp = load(path.join(plugin, "mcp.json"));
  for (const entry of Object.values(mcp.mcpServers)) {
    if (entry.command === "node") entry.command = node;
    entry.env = {
      ...entry.env,
      EDT_AI_SETTINGS: configPath,
      EDT_AI_STATE_DIR: state,
    };
  }
  save_json(path.join(plugin, "mcp.json"), mcp);
  const manifest = load(path.join(plugin, "plugin.json")),
    codex = Object.fromEntries(
      Object.entries(manifest).filter(
        ([key]) => !["$schema", "extensions"].includes(key),
      ),
    );
  save_json(path.join(plugin, ".codex-plugin/plugin.json"), {
    ...codex,
    ...manifest.extensions["com.openai"],
    skills: "./skills/",
    mcpServers: "./mcp.json",
  });
  save_json(path.join(destination, ".agents/plugins/marketplace.json"), {
    name: "edt-ai-local",
    interface: { displayName: "EDT AI Local" },
    plugins: [
      {
        name: "1c-ai-core",
        source: { source: "local", path: "./plugins/1c-ai-core" },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Developer tools",
      },
    ],
  });
  save_json(configPath, config);
  return {
    marketplace: destination,
    settings: configPath,
    plugin_id: "1c-ai-core@edt-ai-local",
    node,
  };
}
if (entrypoint(import.meta.url))
  await cli(() => {
    const a = argumentsOf(undefined, [], ["destination", "state_dir", "node", "project_root"]);
    if (!a.destination || !a.state_dir)
      throw new ConfigError("Укажите --destination и --state-dir");
    console.log(
      JSON.stringify(
        build(
          a.destination,
          a.state_dir,
          a.node,
          a.project_root,
        ),
        null,
        2,
      ),
    );
  });
