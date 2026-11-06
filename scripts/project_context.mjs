import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { edt_connection } from "./directory_context.mjs";
import {
  check_schema,
  deep_merge,
  inside,
  load,
  validate_url,
  validate_openviking_url,
} from "./common.mjs";
import {
  locate_project,
  resolve,
  exists,
  is_file,
  ConfigError,
  path_identity,
  contained,
} from "./project_paths.mjs";
export { locate_project };
function check_external_override(data) {
  check_schema(data, "project-local.schema.json");
  if (Object.keys(data).some(key => !["schema_version", "connections", "components"].includes(key)))
    throw new ConfigError("Внешний файл переопределений поддерживает только connections и components");
}
export function local_overrides(root) {
  const file = inside(root, ".ai/project.local.yaml");
  if (!exists(file)) return {};
  const data = load(file);
  check_schema(data, "project-local.schema.json");
  return data;
}
export function external_override_files() {
  const paths = [];
  if (process.env.EDT_AI_CONNECTIONS_FILE) {
    const file = resolve(process.env.EDT_AI_CONNECTIONS_FILE);
    if (!is_file(file))
      throw new ConfigError(
        "EDT_AI_CONNECTIONS_FILE должен указывать на существующий файл переопределений",
      );
    paths.push(file);
  }
  return paths;
}
export function assert_settings_paths(config, root, data, state = null, settingsFile = process.env.EDT_AI_SETTINGS) {
  if (!data?.roots) return;
  const protectedPaths = [...new Set([...(data.roots.source || []), ...(data.roots.protected || [])])]
    .map(relative => inside(root, relative));
  const files = [path.join(root, ".ai/project.yaml"), path.join(root, ".ai/project.local.yaml")];
  if (state || process.env.EDT_AI_STATE_DIR) files.push(state || process.env.EDT_AI_STATE_DIR);
  if (settingsFile) files.push(settingsFile);
  if (process.env.EDT_AI_CONNECTIONS_FILE) files.push(process.env.EDT_AI_CONNECTIONS_FILE);
  for (const file of files) {
    const nominal = path.resolve(file), actual = resolve(file);
    if (protectedPaths.some(source => contained(source, actual) && !contained(source, nominal)))
      throw new ConfigError("Путь настроек перенаправляется в защищённые исходники проекта: " + nominal);
  }
}
export function resolved_settings(
  config,
  root,
  data = null,
  local_candidate = null,
  state = null,
  local_override = null,
) {
  assert_settings_paths(config, root, data, state);
  let overrides = { connections: data?.connections || {}, components: data?.components || {} };
  const fieldSources = {
    connections: {},
    connectionVariables: {},
    openviking: Object.fromEntries(Object.keys(config.mcp.optional.openviking).map(key => [key, "settings"])),
    components: Object.fromEntries(Object.entries(config.mcp.managed).map(([name, item]) =>
      [name, Object.fromEntries(Object.keys(item).map(key => [key, "settings"]))])),
  };
  const record_sources = (connections, source, components = {}) => {
    for (const [name, item] of Object.entries(connections || {})) {
      fieldSources.connections[name] ||= {};
      for (const key of Object.keys(item)) fieldSources.connections[name][key] = source;
    }
    for (const key of Object.keys(connections?.openviking || {})) fieldSources.openviking[key] = source;
    for (const [name, item] of Object.entries(components || {})) {
      fieldSources.components[name] ||= {};
      for (const key of Object.keys(item)) fieldSources.components[name][key] = source;
    }
  };
  record_sources(data?.connections, "profile", data?.components);
  // A credential map is one identity configuration. An explicit empty map
  // clears inherited headers rather than retaining credentials from old layers.
  const merge_overrides = extra => {
    overrides = deep_merge(overrides, extra);
    for (const section of ["connections", "components"])
      for (const [name, entry] of Object.entries(extra[section] || {}))
        if (Object.hasOwn(entry, "headers_env"))
          overrides[section][name].headers_env = structuredClone(entry.headers_env);
  };
  const sources = Object.fromEntries(
    Object.entries(overrides.connections).filter(([, entry]) => Object.hasOwn(entry, "url")).map(([name]) => [name, "profile"]),
  );
  const local = local_override ?? local_candidate ?? local_overrides(root);
  if (local_override !== null || local_candidate !== null) check_schema(local, "project-local.schema.json");
  merge_overrides(local);
  record_sources(local.connections, "project_local", local.components);
  for (const [name, entry] of Object.entries(local.connections || {}))
    if (Object.hasOwn(entry, "url")) sources[name] = "project_local";
  for (const file of external_override_files()) {
    const extra = load(file);
    if (extra !== null) {
      check_external_override(extra);
      merge_overrides(extra);
      const source = "connections_file";
      record_sources(extra.connections, source, extra.components);
      for (const [name, entry] of Object.entries(extra.connections || {}))
        if (Object.hasOwn(entry, "url")) sources[name] = source;
    }
  }
  const connections = overrides.connections,
    overlay = { edt: { url: "" } };
  for (const [name, entry] of Object.entries(connections))
    overlay[name] = { ...overlay[name], ...entry };
  // Explicit URL fields (including an empty local override) always win.
  if (!Object.hasOwn(connections.edt || {}, "url")) {
    const detected = edt_connection(root);
    if (detected.url) {
      overlay.edt = { ...overlay.edt, url: detected.url };
      sources.edt = "edt_workspace";
    }
  }
  for (const name of ["edt", "v8std", "openviking"]) {
    const defaults = name === "openviking" ? config.mcp.optional[name] : config.mcp.required[name];
    const variable = name === "openviking" ? null : connections[name]?.url_env || `EDT_AI_${name.toUpperCase()}_URL`;
    if (variable && Object.hasOwn(process.env, variable)) {
      overlay[name] = { ...overlay[name], url: process.env[variable] };
      sources[name] = "environment:" + variable;
    } else
      sources[name] ||=
        defaults?.url && name !== "edt"
          ? "settings"
          : "unconfigured";
  }
  for (const [name, entry] of Object.entries(overlay)) {
    if (entry.url) name === "openviking" ? validate_openviking_url(entry.url) : validate_url(entry.url, name);
    if (Object.hasOwn(entry, "url_env")) fieldSources.connectionVariables[name] = entry.url_env;
    delete entry.url_env; // Resolution metadata is not part of the transport contract.
  }
  const openviking = overlay.openviking;
  delete overlay.openviking;
  const effective = deep_merge(config, {
      active_project: resolve(root),
      mcp: { required: overlay, managed: overrides.components || {},
        ...(openviking ? { optional: { openviking } } : {}) },
    });
  for (const [name, entry] of Object.entries(overrides.components || {}))
    if (Object.hasOwn(entry, "headers_env")) effective.mcp.managed[name].headers_env = structuredClone(entry.headers_env);
  for (const [name, entry] of Object.entries(overlay))
    if (Object.hasOwn(entry, "headers_env")) effective.mcp.required[name].headers_env = structuredClone(entry.headers_env);
  return [effective, sources, fieldSources];
}
export const effective_settings = (...args) => resolved_settings(...args)[0];
export function context_revision(selected) {
  const root = locate_project(selected),
    digest = createHash("sha256").update(path_identity(root));
  for (const name of ["project.yaml", "project.local.yaml"]) {
    const file = inside(root, ".ai/" + name);
    digest.update(exists(file) ? fs.readFileSync(file) : "");
  }
  return [root, digest.digest("hex")];
}
