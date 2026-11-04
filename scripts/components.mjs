// Trusted providers live in the plugin, never in imported project commands.
import path from "node:path";
import { stable, atomic_write, ConfigError, inside } from "./common.mjs";
import { instance_directory, instance_name, exists, resolve, record_project_owner, sha256, state_root, reconnect_file } from "./project_paths.mjs";
import fs from "node:fs";
import { access_revision, persisted_access_revision, access_receipt_epoch } from "./openviking_access.mjs";
import { publication_revision, publication_receipt_epoch } from "./openviking_publication.mjs";
import { index_repositories } from "./directory_context.mjs";
// The CLI's JSON bindings list these names and the profile's chosen credential
// name for translation into host configuration. Portable mcp.json does not
// support the Codex config.toml env_vars field.
export const OPENVIKING_ENV_VARS = Object.freeze([
  "OPENVIKING_SEARCH_TOKEN",
  "EDT_AI_OPENVIKING_ACCESS_BINDING_KEY",
  "EDT_AI_OPENVIKING_ACCESS_PUBLIC_KEY",
  "EDT_AI_OPENVIKING_ACCESS_RECEIPTS",
  "EDT_AI_OPENVIKING_PUBLICATION_PUBLIC_KEY",
  "EDT_AI_OPENVIKING_PUBLICATION_RECEIPTS",
]);
export function knowledge_env_vars(config) {
  return [...new Set([...OPENVIKING_ENV_VARS, ...Object.values(config?.mcp?.optional?.openviking?.headers_env || {})])];
}
// Native runtimes need system and JVM configuration, not the host's arbitrary
// environment. A denylist alone misses credentials from another project or an
// earlier binding after the selected header variable changes.
const NATIVE_ENV_VARS = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "HOME", "USERPROFILE",
  "APPDATA", "LOCALAPPDATA", "TMP", "TEMP", "TMPDIR", "LANG", "LANGUAGE", "LC_ALL",
  "LC_CTYPE", "TZ", "JAVA_HOME", "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS",
  "CODEX_HOME", "EDT_AI_INSTANCE", "EDT_AI_STATE_DIR", "EDT_AI_SETTINGS", "EDT_AI_PROJECT_ROOT",
  "EDT_AI_CONNECTIONS_FILE",
]);
export function native_environment(config, environment = process.env) {
  const names = new Set(knowledge_env_vars(config).map(name => process.platform === "win32" ? name.toUpperCase() : name));
  return Object.fromEntries(Object.entries(environment).filter(([name]) => {
    const key = process.platform === "win32" ? name.toUpperCase() : name;
    return NATIVE_ENV_VARS.has(key) && !names.has(key);
  }));
}
export const COMPONENTS = Object.freeze({
  edt: { kind: "remote", title: "EDT" },
  v8std: { kind: "remote", title: "Стандарты" },
  openviking: { kind: "remote", optional: true, adapter: "mcp/openviking.mjs", title: "Знания" },
  "code-index": { kind: "managed", repository: "Regsorm/code-index-mcp", title: "Индекс кода" },
  "bsl-ls": { kind: "managed", repository: "1c-syntax/bsl-language-server", title: "BSL LS" },
});
export const managed_components = Object.keys(COMPONENTS).filter(id => COMPONENTS[id].kind === "managed");
export const component_settings = (config, id) => config.mcp[COMPONENTS[id].optional ? "optional" : COMPONENTS[id].kind === "managed" ? "managed" : "required"][id];
export const component_enabled = (config, id) => component_settings(config, id).enabled !== false;
export function binding_fingerprint(config, id, root, profile, reconnect = "") {
  return stable([root, instance_name(), component_settings(config, id),
    id === "code-index" ? index_repositories(root, profile) : id === "openviking" ? [profile.knowledge,
      profile.knowledge.manifest ? sha256(fs.readFileSync(inside(root, profile.knowledge.manifest))) : null,
      access_revision(component_settings(config, id)), publication_revision(component_settings(config, id))] : null, reconnect]);
}
export function knowledge_binding_fingerprint(config, root, profile, state = state_root()) {
  const file = reconnect_file(state, root), reconnect = exists(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  return binding_fingerprint(config, "openviking", root, profile, reconnect.openviking || reconnect.id || "");
}
export function knowledge_evidence_revision(config, root, profile) {
  if (profile.knowledge.provider === "none") return "disabled";
  const options = component_settings(config, "openviking");
  return sha256(stable([root, instance_name(), profile.knowledge, options,
    profile.knowledge.manifest ? sha256(fs.readFileSync(inside(root, profile.knowledge.manifest))) : null,
    persisted_access_revision(options), access_receipt_epoch(options), publication_revision(options), publication_receipt_epoch(options)]));
}
const preparation_file = (state, root) => path.join(instance_directory(state, root), instance_name() + ".preparation.json");
export function grant_preparation(state, root, components) {
  record_project_owner(state, root);
  const file = preparation_file(state, root);
  const old = exists(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  atomic_write(file, JSON.stringify({ root: resolve(root), components: [...new Set([...(old.root === resolve(root) ? old.components || [] : []), ...components])] }));
}
export function require_preparation(state, root, component) {
  const file = preparation_file(state, root), record = exists(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  if (record.root !== resolve(root) || !record.components?.includes(component))
    throw new ConfigError("Компонент не подготовлен. Один раз выполните «Подготовить и проверить MCP» в настройках для этой папки и экземпляра.");
}
