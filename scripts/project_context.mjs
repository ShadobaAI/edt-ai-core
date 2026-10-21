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
export function resolved_settings(
  config,
  root,
  data = null,
  instance_override = null,
  state = null,
) {
  let overrides = { connections: data?.connections || {} };
  const sources = Object.fromEntries(
    Object.keys(overrides.connections).map((name) => [name, "profile"]),
  );
  const local = local_overrides(root);
  overrides = deep_merge(overrides, local);
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
      overrides = deep_merge(overrides, extra);
      const source =
        file === stateOverride
          ? "instance"
          : process.env.EDT_AI_CONNECTIONS_FILE &&
              file === resolve(process.env.EDT_AI_CONNECTIONS_FILE)
            ? "connections_file"
            : "repository_instance";
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
  for (const name of ["edt", "v8std"]) {
    const variable =
      connections[name]?.url_env || `EDT_AI_${name.toUpperCase()}_URL`;
    if (Object.hasOwn(process.env, variable)) {
      overlay[name] = { ...overlay[name], url: process.env[variable] };
      sources[name] = "environment:" + variable;
    } else
      sources[name] ||=
        config.mcp.required[name].url &&
        (name !== "edt" || legacy_edt_matches(config, root))
          ? "legacy"
          : "unconfigured";
  }
  for (const [name, entry] of Object.entries(overlay))
    if (entry.url) validate_url(entry.url, name);
  return [
    deep_merge(config, {
      active_project: resolve(root),
      mcp: { required: overlay, managed: overrides.components || {} },
    }),
    sources,
  ];
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
