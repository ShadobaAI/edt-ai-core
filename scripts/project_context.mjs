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
  state_path,
} from "./common.mjs";
import {
  locate_project,
  instance_directory,
  instance_name,
  configuration_root,
  resolve,
  exists,
  is_file,
  is_dir,
  ConfigError,
  path_identity,
  contained,
} from "./project_paths.mjs";
export { locate_project };
export function local_overrides(root) {
  const file = inside(root, ".ai/project.local.yaml");
  if (!exists(file)) return {};
  const data = load(file);
  check_schema(data, "project-local.schema.json");
  return data;
}
export function legacy_edt_matches(config, root) {
  let owner = config.active_project;
  if (!owner) return false;
  owner = resolve(owner);
  if (is_dir(owner)) owner = configuration_root(owner, { recursive: false });
  return owner === resolve(root);
}
export const instance_file = (config, root, state) =>
  path.join(
    instance_directory(state_path(config, state), root),
    instance_name() + ".yaml",
  );
export function instance_files(config, root, state) {
  const paths = [
    inside(root, ".ai/instances/" + instance_name() + ".local.yaml"),
    instance_file(config, root, state),
  ];
  if (process.env.EDT_AI_CONNECTIONS_FILE) {
    const file = resolve(process.env.EDT_AI_CONNECTIONS_FILE);
    if (!is_file(file))
      throw new ConfigError(
        "EDT_AI_CONNECTIONS_FILE must identify an existing override file",
      );
    paths.push(file);
  }
  return paths;
}
export function assert_settings_paths(config, root, data, state = null, settingsFile = process.env.EDT_AI_SETTINGS) {
  if (!data?.roots) return;
  const protectedPaths = [...new Set([...(data.roots.source || []), ...(data.roots.protected || [])])]
    .map(relative => inside(root, relative));
  const files = [path.join(root, ".ai/project.yaml"), path.join(root, ".ai/project.local.yaml"),
    path.join(root, ".ai/instances", instance_name() + ".local.yaml"), instance_file(config, root, state)];
  if (state || process.env.EDT_AI_STATE_DIR) files.push(state || process.env.EDT_AI_STATE_DIR);
  if (settingsFile) files.push(settingsFile);
  if (process.env.EDT_AI_CONNECTIONS_FILE) files.push(process.env.EDT_AI_CONNECTIONS_FILE);
  for (const file of files) {
    const nominal = path.resolve(file), actual = resolve(file);
    if (protectedPaths.some(source => contained(source, actual) && !contained(source, nominal)))
      throw new ConfigError("Settings path redirects into protected project source: " + nominal);
  }
}
export function resolved_settings(
  config,
  root,
  data = null,
  instance_override = null,
  state = null,
  local_override = null,
) {
  assert_settings_paths(config, root, data, state);
  let overrides = { connections: data?.connections || {} };
  const fieldSources = {
    openviking: Object.fromEntries(Object.keys(config.mcp.optional.openviking).map(key => [key, "settings"])),
    components: Object.fromEntries(Object.entries(config.mcp.managed).map(([name, item]) =>
      [name, Object.fromEntries(Object.keys(item).map(key => [key, "settings"]))])),
  };
  const record_sources = (connections, source, components = {}) => {
    for (const key of Object.keys(connections?.openviking || {})) fieldSources.openviking[key] = source;
    for (const [name, item] of Object.entries(components || {})) {
      fieldSources.components[name] ||= {};
      for (const key of Object.keys(item)) fieldSources.components[name][key] = source;
    }
  };
  record_sources(data?.connections, "profile");
  // A credential map is one identity configuration. An explicit empty map
  // clears inherited headers rather than retaining credentials from old layers.
  const merge_overrides = extra => {
    overrides = deep_merge(overrides, extra);
    if (Object.hasOwn(extra.connections?.openviking || {}, "headers_env"))
      overrides.connections.openviking.headers_env = structuredClone(extra.connections.openviking.headers_env);
  };
  const sources = Object.fromEntries(
    Object.entries(overrides.connections).filter(([, entry]) => Object.hasOwn(entry, "url")).map(([name]) => [name, "profile"]),
  );
  const local = local_override === null ? local_overrides(root) : local_override;
  if (local_override !== null) check_schema(local, "project-local.schema.json");
  merge_overrides(local);
  record_sources(local.connections, "project_local", local.components);
  for (const [name, entry] of Object.entries(local.connections || {}))
    if (Object.hasOwn(entry, "url")) sources[name] = "project_local";
  const stateOverride = instance_file(config, root, state);
  for (const file of instance_files(config, root, state)) {
    let extra;
    if (instance_override !== null && file === stateOverride)
      extra = instance_override;
    else if (exists(file)) extra = load(file);
    else continue;
    if (extra !== null) {
      check_schema(extra, "project-local.schema.json");
      merge_overrides(extra);
      const source =
        file === stateOverride
          ? "instance"
          : process.env.EDT_AI_CONNECTIONS_FILE &&
              file === resolve(process.env.EDT_AI_CONNECTIONS_FILE)
            ? "connections_file"
            : "repository_instance";
      record_sources(extra.connections, source, extra.components);
      for (const [name, entry] of Object.entries(extra.connections || {}))
        if (Object.hasOwn(entry, "url")) sources[name] = source;
    }
  }
  const connections = overrides.connections,
    overlay = {};
  if (!legacy_edt_matches(config, root)) overlay.edt = { url: "" };
  for (const [name, entry] of Object.entries(connections))
    overlay[name] = { ...overlay[name], ...entry };
  // Explicit URL fields (including an empty local override) always win.
  if (!Object.hasOwn(connections.edt || {}, "url") &&
      !(legacy_edt_matches(config, root) && config.mcp.required.edt.url)) {
    const detected = edt_connection(root);
    if (detected.url) {
      overlay.edt = { ...overlay.edt, url: detected.url };
      sources.edt = "edt_workspace";
    }
  }
  for (const name of ["edt", "v8std", "openviking"]) {
    const defaults = name === "openviking" ? config.mcp.optional[name] : config.mcp.required[name];
    const variable =
      connections[name]?.url_env || `EDT_AI_${name.toUpperCase()}_URL`;
    if (Object.hasOwn(process.env, variable)) {
      overlay[name] = { ...overlay[name], url: process.env[variable] };
      sources[name] = "environment:" + variable;
      if (name === "openviking") fieldSources.openviking.url = sources[name];
    } else
      sources[name] ||=
        defaults?.url &&
        (name !== "edt" || legacy_edt_matches(config, root))
          ? name === "openviking" ? "settings" : "legacy"
          : "unconfigured";
  }
  for (const [name, entry] of Object.entries(overlay)) {
    if (entry.url) name === "openviking" ? validate_openviking_url(entry.url) : validate_url(entry.url, name);
    delete entry.url_env; // Resolution metadata is not part of the transport contract.
  }
  const openviking = overlay.openviking;
  delete overlay.openviking;
  const effective = deep_merge(config, {
      active_project: resolve(root),
      mcp: { required: overlay, managed: overrides.components || {},
        ...(openviking ? { optional: { openviking } } : {}) },
    });
  if (Object.hasOwn(openviking || {}, "headers_env"))
    effective.mcp.optional.openviking.headers_env = structuredClone(openviking.headers_env);
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
