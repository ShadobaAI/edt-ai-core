// Trusted providers live in the plugin, never in imported project commands.
import path from "node:path";
import { stable, atomic_write, ConfigError, inside } from "./common.mjs";
import { instance_directory, instance_name, exists, resolve, record_project_owner, sha256, state_root, reconnect_file } from "./project_paths.mjs";
import fs from "node:fs";
import { access_revision, persisted_access_revision, access_receipt_epoch } from "./openviking_access.mjs";
import { publication_revision, publication_receipt_epoch } from "./openviking_publication.mjs";
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
    id === "code-index" ? profile.repositories : id === "openviking" ? [profile.knowledge,
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
