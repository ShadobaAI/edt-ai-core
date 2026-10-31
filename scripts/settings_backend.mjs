import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  ConfigError,
  atomic_write,
  check_schema,
  deep_merge,
  dump,
  inside,
  load,
  operation_lock,
  settings,
  validate_settings,
  validate_url,
  validate_openviking_url,
  parse,
  object,
  stable,
  entrypoint,
} from "./common.mjs";
import {
  backup,
  profile_target,
  project_profile,
  validate,
  validate_at,
  create_profile,
  profile_state,
  scoped_paths,
} from "./profile.mjs";
import { effective_policy } from "./action_policy.mjs";
import {
  configuration_root,
  ProfileNotFound,
  ProfileAmbiguous,
  reconnect_file,
  instance_name,
  resolve,
  exists,
  is_dir,
  sha256,
  locate_project,
  legacy_project_state,
  record_project_owner,
  path_identity,
  contained,
} from "./project_paths.mjs";
import {
  legacy_edt_matches,
  resolved_settings,
  effective_settings,
  instance_file,
  instance_files,
  assert_settings_paths,
} from "./project_context.mjs";
import { managed_components, component_enabled, grant_preparation, require_preparation, component_settings } from "./components.mjs";
import { directory_context, edt_connection, edt_port_suggestion, edt_project_descriptors } from "./directory_context.mjs";
import { profile_history, profile_hidden, remember_profile, profile_summary } from "./profile_history.mjs";
import { read_readiness, save_readiness } from "./setup_readiness.mjs";
import { knowledge_status } from "./knowledge.mjs";
import { environment_compatibility, safe_error_message, sanitize_setup_result } from "./diagnostics.mjs";

export const FIELDS = {
  projectRoot: ["active_project"],
  edtUrl: ["mcp", "required", "edt", "url"],
  v8stdUrl: ["mcp", "required", "v8std", "url"],
  codeIndexEnabled: ["mcp", "managed", "code-index", "enabled"],
  bslLsEnabled: ["mcp", "managed", "bsl-ls", "enabled"],
  codeIndexVersion: ["mcp", "managed", "code-index", "version"],
  codeIndexAllowPrerelease: ["mcp", "managed", "code-index", "allow_prerelease"],
  bslLsVersion: ["mcp", "managed", "bsl-ls", "version"],
  bslLsAllowPrerelease: ["mcp", "managed", "bsl-ls", "allow_prerelease"],
  bslLsJava: ["mcp", "managed", "bsl-ls", "java"],
  openvikingEnabled: ["mcp", "optional", "openviking", "enabled"],
  openvikingUrl: ["mcp", "optional", "openviking", "url"],
  openvikingTimeout: ["mcp", "optional", "openviking", "timeout_seconds"],
  openvikingMaxResponseBytes: ["mcp", "optional", "openviking", "max_response_bytes"],
  openvikingHeadersEnv: ["mcp", "optional", "openviking", "headers_env"],
};
const bytes = (file) => (file && exists(file) ? fs.readFileSync(file) : null);
const restore = (file, previous) => {
  if (previous === null) fs.rmSync(file, { force: true });
  else atomic_write(file, previous);
};
function layer_changes(before, after) {
  const changes = [];
  let truncated = false;
  const visit = (oldValue, newValue, keys, present = true) => {
    if (stable(oldValue) === stable(newValue) && present) return;
    if (object(oldValue) && object(newValue) && present) {
      for (const key of [...new Set([...Object.keys(oldValue), ...Object.keys(newValue)])].sort())
        visit(oldValue[key], newValue[key], [...keys, key], Object.hasOwn(newValue, key));
    } else if (changes.length < 100) changes.push({ path: keys.join("."), ...(present ? { value: newValue } : { removed: true }) });
    else truncated = true;
  };
  visit(before, after, []);
  return { changes, truncated };
}
function validate_override_urls(document) {
  // Validate the document itself: a higher-priority override can hide an
  // invalid or credential-bearing URL from effective-settings validation.
  for (const [name, entry] of Object.entries(document.connections || {}))
    if (entry.url) name === "openviking" ? validate_openviking_url(entry.url) : validate_url(entry.url, name);
  for (const [name, entry] of Object.entries(document.components || {}))
    if (entry.url) validate_url(entry.url, name);
}
function connection_url(name, value) {
  if (!value) return "";
  return name === "openviking" ? validate_openviking_url(value) : validate_url(value, name);
}
function import_compatibility(profile, root) {
  if (!profile || !root) return { missingPaths: [], edtMappings: [] };
  const missingPaths = [...new Set(scoped_paths(profile))].filter(relative => !exists(inside(root, relative)));
  const repositories = profile.repositories.filter(repo => repo.edt_project);
  const detected = repositories.length ? edt_project_descriptors(root) : [];
  const edtMappings = repositories.map(repo => ({
    repository: repo.id, project: repo.edt_project,
    status: detected === null ? "unavailable" : detected.some(project =>
      project.name === repo.edt_project && contained(inside(root, repo.path), project.directory)) ? "detected" : "not_detected",
  }));
  return { missingPaths, edtMappings };
}
export const preparation_scope = (root) =>
  root ? `${root}#${instance_name()}` : null;
export const session_guidance = "Профиль определяется по папке текущего чата. Если подключения не видят проект, сообщите агенту путь к его папке в этом чате. Привязка подключений к проекту действует только в текущем чате. Для подготовки сервисов нажмите «Проверить готовность».";
export function authorize_preparation(request, root) {
  const auth = request.authorization;
  if (
    !object(auth) ||
    Object.keys(auth).sort().join(",") !== "effects,evidence,scope" ||
    stable(auth.effects) !== '["launch"]' ||
    typeof auth.evidence !== "string" ||
    !auth.evidence.trim()
  )
    throw new ConfigError(
      "Подготовка MCP требует разрешения запуска сервисов.",
    );
  if (auth.scope !== preparation_scope(root))
    throw new ConfigError(
      "Разрешение подготовки относится к другой папке или экземпляру.",
    );
}
export class SettingsBackend {
  constructor(
    state = process.env.EDT_AI_STATE_DIR,
    config = process.env.EDT_AI_SETTINGS,
  ) {
    this.STATE = state;
    this.CONFIG = config;
    if (!state || !config)
      throw new ConfigError(
        "Settings backend requires state and settings paths",
      );
  }
  current(allowAmbiguous = false) {
    const config = settings(this.CONFIG);
    config.state_dir = this.STATE;
    const normalize = directory => {
      try { return configuration_root(directory); }
      catch (error) {
        if (allowAmbiguous && error instanceof ProfileAmbiguous) return resolve(directory);
        throw error;
      }
    };
    if (process.env.EDT_AI_PROJECT_ROOT) {
      const selected = normalize(process.env.EDT_AI_PROJECT_ROOT);
      if (!config.active_project || !legacy_edt_matches(config, selected))
        config.mcp.required.edt.url = "";
      config.active_project = selected;
    } else if (Object.hasOwn(process.env, "EDT_AI_PROJECT_ROOT")) {
      config.active_project = null;
      config.mcp.required.edt.url = "";
    } else if (config.active_project && is_dir(config.active_project))
      config.active_project = normalize(config.active_project);
    return config;
  }
  effective(config, override = null, profile = null, with_sources = false) {
    let fieldSources = {};
    let sources = Object.fromEntries(
      Object.entries(config.mcp.required).map(([name, item]) => [
        name,
        item.url ? "legacy" : "unconfigured",
      ]),
    );
    if (config.active_project) {
      let root,
        data = profile;
      try {
        root = locate_project(config.active_project);
        if (data === null)
          data = validate_at(root, load(path.join(root, ".ai/project.yaml")));
      } catch (error) {
        if (!(error instanceof ProfileNotFound)) throw error;
        root = configuration_root(config.active_project);
      }
      [config, sources, fieldSources] = resolved_settings(config, root, data, override);
    }
    return with_sources ? [config, sources, fieldSources] : config;
  }
  values(config, applyEffective = true) {
    if (applyEffective) config = this.effective(config);
    return Object.fromEntries(
      Object.entries(FIELDS).map(([name, parts]) => {
        let item = config;
        for (const part of parts) item = object(item) ? item[part] : null;
        return [name, item == null ? "" : structuredClone(item)];
      }),
    );
  }
  checked(config) {
    validate_settings(config);
    if (config.active_project && !is_dir(config.active_project))
      throw new ConfigError(
        "Папка проекта не найдена. Укажите папку на этом компьютере.",
      );
    return config;
  }
  setting_layers(config, profile) {
    const root = config.active_project;
    if (!root || profile.status !== "loaded") return {};
    const files = { profile: profile_target(root), project_local: inside(root, ".ai/project.local.yaml"), instance: instance_file(config, root) };
    const layers = {};
    for (const [scope, file] of Object.entries(files)) {
      const document = exists(file) ? load(file) : {}, fields = {};
      if (scope !== "profile" && exists(file)) {
        check_schema(document, "project-local.schema.json");
        validate_override_urls(document);
      }
      for (const [key, parts] of Object.entries(FIELDS)) {
        const name = key.startsWith("openviking") ? "openviking" : key === "edtUrl" ? "edt" : key === "v8stdUrl" ? "v8std" : null;
        const entry = name ? document.connections?.[name] : parts[1] === "managed" ? document.components?.[parts[2]] : null;
        if (entry && Object.hasOwn(entry, parts.at(-1))) fields[key] = structuredClone(entry[parts.at(-1)]);
      }
      layers[scope] = fields;
    }
    layers.global = Object.fromEntries(Object.entries(FIELDS).filter(([, parts]) => parts[1] === "managed").map(([key, parts]) => [key, structuredClone(config.mcp.managed[parts[2]]?.[parts.at(-1)])]).filter(([, value]) => value !== undefined));
    return layers;
  }
  store_shared_settings(config) {
    const saved = settings(this.CONFIG);
    saved.state_dir = this.STATE;
    // Persist the resolved sections exactly: merging into the old values would
    // resurrect overrides removed by the manual editor.
    saved.mcp.managed = structuredClone(config.mcp.managed);
    saved.mcp.optional = structuredClone(config.mcp.optional);
    atomic_write(this.CONFIG, JSON.stringify(saved, null, 2) + "\n");
  }
  edit_revision() {
    const config = this.current();
    return this.revision(config, config.active_project ? profile_target(config.active_project) : null);
  }
  revision(config, target = null, payload = "") {
    if (config.active_project) {
      // A valid current profile defines the source boundary even when a
      // candidate profile would remove it. Invalid profiles remain repairable.
      let profile;
      try { profile = project_profile(config.active_project); } catch { /* No usable profile yet. */ }
      if (profile) assert_settings_paths(config, config.active_project, profile, this.STATE, this.CONFIG);
    }
    const chunks = [
      Buffer.from(stable(config)),
      Buffer.from(payload),
      bytes(this.CONFIG) || Buffer.alloc(0),
    ];
    if (target)
      chunks.push(
        Buffer.from(resolve(target)),
        bytes(target) || Buffer.alloc(0),
      );
    if (config.active_project) {
      // Track source revisions even when a higher-priority value masks them or
      // the imported document does not replace the current profile.
      for (const name of [".ai/project.yaml", ".ai/project.local.yaml"]) {
        const file = inside(config.active_project, name);
        chunks.push(Buffer.from(file), bytes(file) || Buffer.alloc(0));
      }
      for (const file of instance_files(config, config.active_project))
        chunks.push(Buffer.from(file), bytes(file) || Buffer.alloc(0));
    }
    if (config.active_project)
      chunks.push(Buffer.from(stable(edt_connection(config.active_project))));
    return sha256(Buffer.concat(chunks));
  }
  lockedRoot() {
    return process.env.EDT_AI_SETTINGS_ROOT_LOCKED !== "0"
      ? process.env.EDT_AI_PROJECT_ROOT
      : null;
  }
  parse_import(request) {
    const text = request.text || "";
    if (typeof text !== "string" || Buffer.byteLength(text) > 2 * 1024 * 1024)
      throw new ConfigError("Допустим файл настроек размером до 2 МиБ.");
    const data = parse(text);
    const editing = request.mode === "edit";
    let omittedTestingCommands = [];
    if (request.layerScope !== undefined) throw new ConfigError("Выбор локального файла доступен только в режиме layer.");
    // The app explicitly opts in before importing machine-specific addresses
    // and executable paths. Calls predating this option retain their behavior.
    if (!editing && request.includeMachineSettings === false) {
      const omitProfileMachineSettings = profile => {
        if (!object(profile)) return;
        delete profile.connections;
        // Command arguments have no reliable portable/machine-specific type:
        // they can embed paths, addresses, or other machine-local data.
        // Require an explicit opt-in for the whole command instead of guessing.
        if (Array.isArray(profile.testing?.commands)) {
          omittedTestingCommands = profile.testing.commands.map(command => command?.id).filter(id => typeof id === "string");
          profile.testing.commands = [];
        }
      };
      if (data.format === "1c-ai-core-settings") {
        omitProfileMachineSettings(data.profile);
        const mcp = data.settings?.mcp;
        for (const entry of Object.values(mcp?.required || {})) if (object(entry)) { delete entry.url; delete entry.headers_env; }
        for (const entry of Object.values(mcp?.managed || {})) if (object(entry))
          for (const field of ["java", "node", "configuration", "mode", "url", "headers_env"]) delete entry[field];
        if (object(mcp?.optional?.openviking)) { delete mcp.optional.openviking.url; delete mcp.optional.openviking.headers_env; }
      } else omitProfileMachineSettings(data);
    }
    if (request.mode !== undefined && !["import", "edit"].includes(request.mode))
      throw new ConfigError("Неизвестный режим сохранения настроек.");
    if (editing && request.baseRevision !== this.edit_revision())
      throw new ConfigError("Настройки изменились после загрузки в редактор. Загрузите их заново.");
    if (!editing && request.baseRevision !== undefined)
      throw new ConfigError("Проверка версии документа доступна только при сохранении из редактора.");
    let config = this.current(),
      imported = null;
    const previous = config.active_project,
      connections = {};
    if (data.format === "1c-ai-core-settings") {
      if (
        data.version !== 1 ||
        Object.keys(data).some(
          (key) => !["format", "version", "settings", "profile"].includes(key),
        )
      )
        throw new ConfigError("Неизвестный формат или версия файла настроек.");
      const changes = structuredClone(data.settings || {});
      if (
        !object(changes) ||
        Object.keys(changes).some(
          (key) => !["active_project", "mcp"].includes(key),
        )
      )
        throw new ConfigError("Недопустимые поля настроек.");
      if (editing) {
        if (Object.keys(changes).some(key => key !== "mcp") || !object(changes.mcp) ||
            Object.keys(changes.mcp).some(key => !["managed", "optional"].includes(key)) ||
            !object(changes.mcp.managed) || !object(changes.mcp.optional) ||
            !Object.hasOwn(data, "profile"))
          throw new ConfigError("Документ должен содержать профиль и полные настройки управляемых и дополнительных компонентов. Адреса подключений изменяются на вкладке «Подключения».");
        if (request.projectRoot !== undefined &&
            (!request.projectRoot || configuration_root(request.projectRoot) !== config.active_project))
          throw new ConfigError("Редактор относится к другой папке. Загрузите настройки заново.");
        const defaults = load(new URL("../settings/defaults.json", import.meta.url));
        config.mcp.managed = deep_merge(defaults.mcp.managed, changes.mcp.managed);
        config.mcp.optional = deep_merge(defaults.mcp.optional, changes.mcp.optional);
        this.checked(config);
      }
      check_schema(deep_merge(config, changes), "plugin-settings.schema.json");
      for (const [name, entry] of Object.entries(changes.mcp?.required || {}))
        if (Object.hasOwn(entry, "url")) {
          const value = entry.url;
          delete entry.url;
          connections[name] = { url: value ? validate_url(value, name) : "" };
        }
      imported = data.profile == null ? null : structuredClone(data.profile);
      if (!editing) config = deep_merge(config, changes);
    } else if (!editing && Object.hasOwn(data, "schema_version")) imported = data;
    else
      throw new ConfigError(
        "Это не экспорт настроек 1C AI Core и не профиль проекта.",
      );
    const selected = this.lockedRoot();
    if (Object.hasOwn(request, "projectRoot")) {
      const proposed = request.projectRoot
        ? configuration_root(request.projectRoot)
        : null;
      if (selected && proposed !== configuration_root(selected))
        throw new ConfigError(
          "Импорт относится к другому каталогу. Сначала выберите этот проект в Codex.",
        );
      config.active_project = proposed;
    } else if (config.active_project)
      config.active_project = configuration_root(config.active_project);
    if (config.active_project !== previous) config.mcp.required.edt.url = "";
    if (
      selected &&
      (!config.active_project ||
        resolve(config.active_project) !== configuration_root(selected))
    )
      throw new ConfigError(
        "Импорт относится к другому каталогу. Сначала выберите этот проект в Codex.",
      );
    config.state_dir = this.STATE;
    this.checked(config);
    const root = config.active_project ? resolve(config.active_project) : null;
    let target = null,
      overrides = null;
    if (imported !== null) {
      validate(imported);
      if (!root)
        throw new ConfigError("Для импорта профиля выберите папку проекта.");
      target = profile_target(root);
      validate_at(root, imported);
      for (const repo of imported.repositories)
        if (!is_dir(inside(root, repo.path)))
          throw new ConfigError(
            "В выбранной папке отсутствует репозиторий: " + repo.path,
          );
      effective_settings(config, root, imported);
      // The editor loads the complete document; unrelated runtime edits must
      // preserve profile comments, formatting and modification time.
      if (editing && exists(target) && stable(load(target)) === stable(imported)) target = null;
    } else if (editing && root && exists(profile_target(root))) {
      throw new ConfigError("Удаление существующего профиля через редактор не поддерживается.");
    }
    if (Object.keys(connections).length) {
      if (!root)
        throw new ConfigError(
          "Для импорта подключений выберите папку проекта.",
        );
      const file = instance_file(config, root);
      overrides = deep_merge(exists(file) ? load(file) : { connections: {} }, {
        connections,
      });
      check_schema(overrides, "project-local.schema.json");
    }
    return [config, imported, target, overrides, omittedTestingCommands];
  }
  async update_scoped(changes, scope, expectedRevision) {
    if (!["profile", "project_local", "instance", "global"].includes(scope))
      throw new ConfigError("Неизвестная область сохранения.");
    const connectionFields = ["edtUrl", "v8stdUrl", "openvikingEnabled", "openvikingUrl", "openvikingTimeout", "openvikingMaxResponseBytes", "openvikingHeadersEnv"];
    const componentFields = ["codeIndexEnabled", "bslLsEnabled", "bslLsJava", "codeIndexVersion", "bslLsVersion"];
    const allowed = scope === "profile" ? connectionFields : scope === "global" ? ["bslLsJava", "codeIndexVersion", "bslLsVersion"] : [...connectionFields, ...componentFields];
    if (Object.keys(changes).some(key => !allowed.includes(key)))
      throw new ConfigError("Эти настройки нельзя сохранить в выбранную область.");
    return operation_lock(this.STATE, () => {
      const config = this.current(), root = config.active_project;
      if (!root) throw new ConfigError("Выберите папку проекта.");
      let profile;
      try { profile = project_profile(root); } catch (error) { if (!(error instanceof ProfileNotFound)) throw error; }
      if (profile) assert_settings_paths(config, root, profile, this.STATE, this.CONFIG);
      const target = scope === "profile" ? profile_target(root) : scope === "project_local" ? inside(root, ".ai/project.local.yaml") : scope === "instance" ? instance_file(config, root) : this.CONFIG;
      if (expectedRevision && expectedRevision !== this.revision(config, profile_target(root)))
        throw new ConfigError("Настройки изменились после загрузки. Обновите сведения и повторите сохранение.");
      let document;
      if (scope === "profile") document = project_profile(root);
      else if (scope === "global") document = config;
      else {
        document = exists(target) ? load(target) : {};
        if (exists(target)) check_schema(document, "project-local.schema.json");
      }
      for (const [key, value] of Object.entries(changes)) {
        const member = FIELDS[key].at(-1);
        if (connectionFields.includes(key)) {
          const name = key.startsWith("openviking") ? "openviking" : key === "edtUrl" ? "edt" : "v8std";
          const connection = ((document.connections ||= {})[name] ||= {});
          connection[member] = member === "url" ? connection_url(name, value) : structuredClone(value);
        } else if (scope === "global") {
          const parts = FIELDS[key]; let item = document;
          for (const part of parts.slice(0, -1)) item = item[part];
          item[parts.at(-1)] = value;
        } else {
          const name = key.startsWith("codeIndex") ? "code-index" : "bsl-ls";
          ((document.components ||= {})[name] ||= {})[member] = value;
        }
      }
      if (scope === "profile") validate_at(root, document);
      else if (scope === "global") this.checked(document);
      else { check_schema(document, "project-local.schema.json"); validate_override_urls(document); }
      const previous = bytes(target), savedBackup = scope === "profile" ? backup(target) : null;
      try {
        if (scope === "instance") record_project_owner(this.STATE, root);
        if (scope === "global") this.store_shared_settings(document);
        else dump(document, target, previous !== null);
        const persisted = load(target);
        if (scope === "global") {
          if (stable(persisted.mcp.managed) !== stable(document.mcp.managed) || stable(persisted.mcp.optional) !== stable(document.mcp.optional))
            throw new ConfigError("Не удалось подтвердить сохранение настроек.");
        } else if (stable(persisted) !== stable(document)) throw new ConfigError("Не удалось подтвердить сохранение настроек.");
        const savedConfig = this.current(), effective = this.effective(savedConfig);
        return { values: this.values(effective, false), savedTo: target, scope, backup: savedBackup,
          settingsRevision: this.revision(savedConfig, profile_target(root)) };
      } catch (error) { restore(target, previous); throw error; }
    });
  }
  prepare_layer(request) {
    if (!["project_local", "instance"].includes(request.layerScope)) throw new ConfigError("Выберите локальный файл проекта или экземпляра.");
    if (request.includeMachineSettings !== undefined) throw new ConfigError("Параметры импорта не относятся к редактору локальных настроек.");
    if (typeof request.text !== "string" || Buffer.byteLength(request.text) > 2 * 1024 * 1024) throw new ConfigError("Документ превышает 2 МиБ.");
    const config = this.current(), root = config.active_project;
    if (!root) throw new ConfigError("Выберите папку проекта.");
    if (request.projectRoot !== undefined && configuration_root(request.projectRoot) !== root) throw new ConfigError("Редактор относится к другой папке.");
    if (!request.baseRevision || request.baseRevision !== this.edit_revision()) throw new ConfigError("Настройки изменились после загрузки. Загрузите документ заново.");
    const document = parse(request.text);
    check_schema(document, "project-local.schema.json");
    validate_override_urls(document);
    const profile = project_profile(root), target = request.layerScope === "project_local" ? inside(root, ".ai/project.local.yaml") : instance_file(config, root);
    const [effective] = resolved_settings(config, root, profile, request.layerScope === "instance" ? document : null, this.STATE, request.layerScope === "project_local" ? document : null);
    validate_settings(effective);
    const payload = stable({ text: request.text, mode: "layer", baseRevision: request.baseRevision, layerScope: request.layerScope });
    let previous = {};
    try { if (exists(target)) previous = load(target); } catch { previous = null; }
    const diff = previous === null ? { changes: [{ path: "Документ", replacedInvalid: true }], truncated: false } : layer_changes(previous, document);
    const summary = { projectRoot: root, profileId: profile.profile_id,
      repositories: profile.repositories.map(({ id, path, alias }) => ({ id, path, alias })), missingPaths: [], replacesProfile: false,
      connectionUrls: Object.fromEntries(Object.entries(effective.mcp.required).map(([name, item]) => [name, item.url])),
      openviking: structuredClone(effective.mcp.optional.openviking), writesInstanceConnections: false,
      sharedRuntimeChanges: {}, sharedOptionalChanges: {}, layerPath: target, layerScope: request.layerScope, layerChanges: diff.changes, layerChangesTruncated: diff.truncated,
      revision: this.revision(effective, target, payload) };
    return { config, root, document, target, summary, payload };
  }
  async prepare_document_layer(request) {
    if (!["profile", "global"].includes(request.layerScope)) throw new ConfigError("Неизвестный документ настроек.");
    if (request.includeMachineSettings !== undefined) throw new ConfigError("Параметры импорта не относятся к редактору настроек.");
    if (typeof request.text !== "string" || Buffer.byteLength(request.text) > 2 * 1024 * 1024) throw new ConfigError("Документ превышает 2 МиБ.");
    const edit = await this.main({ action: "edit" });
    if (!request.baseRevision || request.baseRevision !== edit.baseRevision) throw new ConfigError("Настройки изменились после загрузки. Загрузите документ заново.");
    const envelope = JSON.parse(edit.text), document = parse(request.text);
    const previous = request.layerScope === "profile" ? envelope.profile : envelope.settings;
    if (request.layerScope === "profile") envelope.profile = document; else envelope.settings = document;
    const input = { mode: "edit", baseRevision: request.baseRevision, text: JSON.stringify(envelope),
      ...(request.projectRoot !== undefined ? { projectRoot: request.projectRoot } : {}) };
    const preview = await this.main({ action: "preview", ...input });
    const diff = layer_changes(previous, document), root = this.current().active_project;
    const target = request.layerScope === "profile" ? profile_target(root) : this.CONFIG;
    const revision = sha256(stable({ scope: request.layerScope, text: request.text, baseRevision: request.baseRevision,
      projectRoot: request.projectRoot ?? null, preview: preview.revision }));
    return { input, previewRevision: preview.revision, summary: { ...preview, layerScope: request.layerScope, layerPath: target,
      layerChanges: diff.changes, layerChangesTruncated: diff.truncated, revision } };
  }
  async main(request, { profileDocumentOnly = false } = {}) {
    const action = request.action;
    if (action === "edit" && ["profile", "global"].includes(request.layerScope)) {
      const edit = await this.main({ action: "edit" }), config = this.current();
      if (!config.active_project) throw new ConfigError("Выберите папку проекта.");
      const envelope = JSON.parse(edit.text), document = request.layerScope === "profile" ? envelope.profile : envelope.settings;
      return { text: JSON.stringify(document, null, 2), baseRevision: edit.baseRevision, layerScope: request.layerScope,
        path: request.layerScope === "profile" ? profile_target(config.active_project) : this.CONFIG };
    }
    if (action === "edit" && request.layerScope !== undefined) {
      if (!["project_local", "instance"].includes(request.layerScope)) throw new ConfigError("Неизвестный файл настроек.");
      const config = this.current(), root = config.active_project;
      if (!root) throw new ConfigError("Выберите папку проекта.");
      project_profile(root);
      const baseRevision = this.edit_revision(), target = request.layerScope === "project_local" ? inside(root, ".ai/project.local.yaml") : instance_file(config, root);
      let text;
      if (!exists(target)) text = JSON.stringify({ schema_version: "0.1" }, null, 2);
      else {
        const stat = fs.statSync(target);
        if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new ConfigError("Документ недоступен или превышает 2 МиБ.");
        const original = fs.readFileSync(target, "utf8");
        try { const document = parse(original); check_schema(document, "project-local.schema.json"); text = JSON.stringify(document, null, 2); }
        catch { text = original; } // A broken overlay must remain repairable.
      }
      if (baseRevision !== this.edit_revision()) throw new ConfigError("Настройки изменились во время загрузки. Загрузите документ заново.");
      return { text, baseRevision, layerScope: request.layerScope, path: target };
    }
    if (["preview", "apply"].includes(action) && request.mode === "layer") {
      if (["profile", "global"].includes(request.layerScope)) {
        const prepared = await this.prepare_document_layer(request);
        if (action === "preview") return prepared.summary;
        if (request.revision !== prepared.summary.revision) throw new ConfigError("Настройки изменились после предпросмотра. Проверьте документ заново.");
        const result = await this.main({ action: "apply", ...prepared.input, revision: prepared.previewRevision, replace: request.replace }, { profileDocumentOnly: request.layerScope === "profile" });
        return { ...result, status: "saved", summary: prepared.summary, savedTo: prepared.summary.layerPath };
      }
      if (action === "preview") return this.prepare_layer(request).summary;
      return operation_lock(this.STATE, () => {
        const { config, root, document, target, summary } = this.prepare_layer(request);
        if (request.revision !== summary.revision) throw new ConfigError("Настройки изменились после предпросмотра. Проверьте документ заново.");
        const previous = bytes(target);
        try {
          if (request.layerScope === "instance") record_project_owner(this.STATE, root);
          dump(document, target, previous !== null);
          if (stable(load(target)) !== stable(document)) throw new ConfigError("Не удалось подтвердить сохранение настроек.");
          const effective = this.effective(this.current()); validate_settings(effective);
          return { status: "saved", summary, savedTo: target, values: this.values(effective, false), sessionGuidance: session_guidance };
        } catch (error) { restore(target, previous); throw error; }
      });
    }
    if (action === "java_probe") {
      const { java_info, java_in_directory } = await import("./runtime.mjs");
      return request.directory ? java_in_directory(request.directory) : java_info(request.command || "java");
    }
    if (action === "repair_document") {
      const config = this.current(), root = config.active_project;
      if (!root) throw new ConfigError("Выберите папку проекта.");
      const file = profile_target(root), stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new ConfigError("Профиль недоступен или превышает 2 МиБ.");
      return { text: fs.readFileSync(file, "utf8") };
    }
    if (action === "profile_source") {
      const config = this.current(), target = config.active_project;
      if (!target || typeof request.sourceRoot !== "string") throw new ConfigError("Выберите исходный и целевой профиль.");
      const identity = path_identity(request.sourceRoot);
      const source = profile_history(this.STATE, target).find(item => item.projectRoot === identity && item.status === "loaded");
      if (!source || identity === path_identity(target)) throw new ConfigError("Выберите другой доступный профиль из списка.");
      const profile = structuredClone(project_profile(identity));
      assert_settings_paths(config, identity, profile, this.STATE, this.CONFIG);
      if (request.includeConnections !== true) delete profile.connections;
      const missingPaths = [...new Set(scoped_paths(profile))].filter(relative => !exists(inside(target, relative)));
      return { text: JSON.stringify(profile, null, 2), sourceRoot: identity, missingPaths,
        includesConnections: request.includeConnections === true, localOverridesIncluded: false };
    }
    if (action === "rename_profile") {
      return operation_lock(this.STATE, () => {
        const config = this.current(), root = config.active_project;
        if (!root) throw new ConfigError("Выберите папку проекта.");
        const target = profile_target(root), profile = project_profile(root);
        if (request.expectedRevision !== this.revision(config, target)) throw new ConfigError("Профиль изменился. Обновите сведения перед переименованием.");
        if (typeof request.projectId !== "string" || !request.projectId.trim()) throw new ConfigError("Укажите идентификатор проекта.");
        const previousId = profile.project.id;
        profile.project.id = request.projectId.trim();
        validate_at(root, profile);
        if (previousId === profile.project.id) return { status: "unchanged", profile: profile_state(root) };
        const previous = bytes(target), savedBackup = backup(target);
        try {
          dump(profile, target);
          if (stable(load(target)) !== stable(profile)) throw new ConfigError("Не удалось подтвердить переименование профиля.");
          project_profile(root);
        } catch (error) { restore(target, previous); throw error; }
        remember_profile(this.STATE, root, profile_state(root));
        return { status: "renamed", profile: profile_state(root), backup: savedBackup,
          detail: "Разрешения Vanessa, привязанные к прежнему идентификатору проекта, потребуется получить заново." };
      });
    }
    if (action === "probe") {
      const config = this.effective(this.current()), root = config.active_project;
      if (!root) throw new ConfigError("Выберите папку проекта.");
      if (request.connections !== undefined) {
        if (!object(request.connections) || Object.keys(request.connections).some(name => !["edt", "v8std", "openviking"].includes(name)))
          throw new ConfigError("Некорректные подключения для проверки.");
        for (const [name, url] of Object.entries(request.connections)) {
          if (name === "openviking") {
            check_schema({ connections: { openviking: url } }, "project-local.schema.json");
            config.mcp.optional.openviking = { ...config.mcp.optional.openviking, ...structuredClone(url) };
            validate_settings(config);
            continue;
          }
          if (typeof url !== "string") throw new ConfigError("Адрес подключения должен быть строкой.");
          config.mcp.required[name].url = url ? validate_url(url, name) : "";
        }
      }
      const { probe_connections } = await import("./setup_probe.mjs");
      return probe_connections(config, root, project_profile(root));
    }
    if (action === "read" || action === "status") {
      const { installed_versions } = await import("./runtime.mjs");
      const config = this.current(true), profile = profile_state(config.active_project);
      // A broken profile must not prevent opening its repair/import screen.
      const [effective, sources, fieldSources = {}] = ["invalid", "ambiguous"].includes(profile.status)
        ? [config, {}] : this.effective(config, null, null, true);
      const actual = this.values(effective, false);
      if (request.remember) remember_profile(this.STATE, config.active_project, profile);
      const legacy = config.active_project ? legacy_project_state(this.STATE, config.active_project) : null;
      if (legacy?.status === "owner_unknown" && !exists(instance_file(config, config.active_project, this.STATE))) {
        const file = path.join(legacy.directory, "instances", instance_name() + ".yaml");
        try { const data = load(file); check_schema(data, "project-local.schema.json"); legacy.connections = data.connections || {}; }
        catch { legacy.connections = {}; }
      }
      const directoryContext = directory_context(process.env.EDT_AI_PROJECT_ROOT || config.active_project);
      const profileDirectoryContext = config.active_project && directoryContext?.directory !== config.active_project
        ? directory_context(config.active_project) : directoryContext;
      const readiness = await read_readiness(this.STATE, effective, profile);
      const knowledge = profile.status === "loaded" ? knowledge_status(project_profile(config.active_project), effective) : null;
      return {
        values: actual,
        installedVersions: installed_versions(this.STATE, config.active_project),
        profile,
        directoryContext,
        profileDirectoryContext,
        edtPortSuggestion: edt_port_suggestion(actual.edtUrl, profileDirectoryContext?.edt?.connection),
        readiness,
        knowledge,
        environmentCompatibility: environment_compatibility({ projectRoot: config.active_project }),
        sessionGuidance: session_guidance,
        instance: instance_name(),
        connectionSources: sources,
        valueSources: Object.fromEntries(Object.entries(FIELDS).filter(([key]) => key.startsWith("openviking"))
          .map(([key, parts]) => [key, fieldSources.openviking?.[parts.at(-1)] || "settings"])),
        managedValueSources: Object.fromEntries(Object.entries(FIELDS).filter(([key]) => key.startsWith("codeIndex") || key.startsWith("bslLs"))
          .map(([key, parts]) => [key, fieldSources.components?.[parts.at(-2)]?.[parts.at(-1)] || "settings"])),
        settingsRevision: config.active_project && profile.status === "loaded" ? this.revision(config, profile_target(config.active_project)) : null,
        writePaths: config.active_project ? { profile: profile_target(config.active_project), project_local: inside(config.active_project, ".ai/project.local.yaml"), instance: instance_file(config, config.active_project), global: this.CONFIG } : {},
        layerValues: this.setting_layers(config, profile),
        preparationScope: preparation_scope(actual.projectRoot),
        legacyState: legacy,
        profileHistory: profile_history(this.STATE, actual.projectRoot),
        profileHistoryHidden: profile_hidden(this.STATE, actual.projectRoot),
        summary: await profile_summary(this.STATE, effective, profile, readiness, knowledge),
      };
    }
    if (["create", "load"].includes(action)) {
      return operation_lock(this.STATE, () => {
        const config = this.current(), selected = this.lockedRoot();
        if (request.projectRoot !== undefined) {
          const proposed = request.projectRoot ? configuration_root(request.projectRoot) : null;
          if (selected && proposed !== configuration_root(selected))
            throw new ConfigError("Каталог задаётся текущим чатом. Выберите другой проект в Codex.");
          if (config.active_project !== proposed) config.mcp.required.edt.url = "";
          config.active_project = proposed;
        }
        this.checked(config);
        if (!config.active_project) throw new ConfigError("Выберите папку проекта в Codex.");
        const root = configuration_root(config.active_project);
        const creation = action === "create" ? create_profile(root) : null;
        project_profile(root); // Validate before signalling any bound session.
        record_project_owner(this.STATE, root);
        remember_profile(this.STATE, root, profile_state(root));
        const actual = this.values(config);
        atomic_write(reconnect_file(this.STATE, root), JSON.stringify({ id: randomUUID() }));
        return { values: actual, profile: profile_state(root), instance: instance_name(),
          ...(creation ? { projectInstructions: creation.projectInstructions } : {}),
          sessionGuidance: session_guidance, reload: "requested", readiness: "not_checked" };
      });
    }
    if (action === "reset_connection") {
      if (!["edt", "v8std", "openviking"].includes(request.connection)) throw new ConfigError("Неизвестное подключение.");
      return operation_lock(this.STATE, () => {
        const config = this.current(), root = config.active_project;
        if (!root) throw new ConfigError("Выберите папку проекта.");
        let profile;
        try { profile = project_profile(root); } catch (error) { if (!(error instanceof ProfileNotFound)) throw error; }
        if (profile) assert_settings_paths(config, root, profile, this.STATE, this.CONFIG);
        if (request.expectedRevision && request.expectedRevision !== this.revision(config, profile_target(root)))
          throw new ConfigError("Настройки изменились после загрузки. Обновите сведения и повторите сохранение.");
        const file = instance_file(config, root);
        if (exists(file)) {
          const local = load(file);
          check_schema(local, "project-local.schema.json");
          if (local.connections?.[request.connection]) {
            delete local.connections[request.connection].url;
            if (!Object.keys(local.connections[request.connection]).length) delete local.connections[request.connection];
          }
          check_schema(local, "project-local.schema.json");
          this.effective(config, local);
          const previous = bytes(file);
          try {
            dump(local, file);
            if (stable(load(file)) !== stable(local)) throw new ConfigError("Не удалось подтвердить восстановление наследования.");
            this.effective(this.current());
          } catch (error) { restore(file, previous); throw error; }
        }
        return { values: this.values(config), settingsRevision: this.revision(config, profile_target(root)) };
      });
    }
    if (action === "update") {
      const changes = request.set || {};
      if (
        !object(changes) ||
        !Object.keys(changes).length ||
        Object.keys(changes).some((key) => !Object.hasOwn(FIELDS, key))
      )
        throw new ConfigError("Некорректное изменение настроек.");
      for (const [key, value] of Object.entries(changes))
        if (
          typeof value !== (key.endsWith("Enabled") || key.endsWith("AllowPrerelease") ? "boolean"
            : ["openvikingTimeout", "openvikingMaxResponseBytes"].includes(key) ? "number"
            : key === "openvikingHeadersEnv" ? "object" : "string")
        )
          throw new ConfigError("Некорректный тип настройки: " + key);
      if (request.scope !== undefined) return this.update_scoped(changes, request.scope, request.expectedRevision);
      if (request.expectedRevision !== undefined) throw new ConfigError("Для проверки ревизии укажите область сохранения.");
      const selected = this.lockedRoot();
      if (
        selected &&
        Object.hasOwn(changes, "projectRoot") &&
        (!changes.projectRoot ||
          configuration_root(changes.projectRoot) !==
            configuration_root(selected))
      )
        throw new ConfigError(
          "Каталог задаётся текущей сессией; выберите другой проект в Codex.",
        );
      const config = await operation_lock(this.STATE, () => {
        const config = this.current(),
          instanceChanges = {};
        let globalChanged = false,
          root;
        for (const key of Object.keys(changes).sort(
          (a, b) => Number(b === "projectRoot") - Number(a === "projectRoot"),
        )) {
          let value = changes[key];
          if (key === "projectRoot") {
            value = value ? configuration_root(value) : null;
            if (config.active_project !== value)
              config.mcp.required.edt.url = "";
            config.active_project = value;
            continue;
          }
          if (["edtUrl", "v8stdUrl"].includes(key) || key.startsWith("openviking")) {
            if (!config.active_project)
              throw new ConfigError(
                "Для настройки подключений выберите папку проекта.",
              );
            root = configuration_root(config.active_project);
            const name = key.startsWith("openviking") ? "openviking" : key === "edtUrl" ? "edt" : "v8std";
            const connections = instanceChanges.connections ||= {};
            const member = FIELDS[key].at(-1);
            connections[name] = { ...connections[name],
              [member]: member === "url" ? connection_url(name, value) : value };
            continue;
          }
          if (["codeIndexEnabled", "bslLsEnabled"].includes(key)) {
            if (!config.active_project) throw new ConfigError("Выберите папку проекта.");
            root = configuration_root(config.active_project);
            (instanceChanges.components ||= {})[key === "codeIndexEnabled" ? "code-index" : "bsl-ls"] = { enabled: value };
            continue;
          }
          globalChanged = true;
          let target = config;
          const parts = FIELDS[key];
          for (const part of parts.slice(0, -1)) target = target[part] ||= {};
          target[parts.at(-1)] = value;
        }
        this.checked(config);
        if (config.active_project) {
          let profile;
          try { profile = project_profile(config.active_project); } catch { /* No usable profile yet. */ }
          if (profile) assert_settings_paths(config, config.active_project, profile, this.STATE, this.CONFIG);
        }
        let file = null,
          overrides;
        if (instanceChanges.connections || instanceChanges.components) {
          file = instance_file(config, root);
          overrides = exists(file) ? load(file) : { connections: {} };
          check_schema(overrides, "project-local.schema.json");
          overrides = deep_merge(overrides, instanceChanges);
          if (Object.hasOwn(changes, "openvikingHeadersEnv"))
            overrides.connections.openviking.headers_env = structuredClone(changes.openvikingHeadersEnv);
          check_schema(overrides, "project-local.schema.json");
          validate_override_urls(overrides);
          effective_settings(
            config,
            root,
            exists(path.join(root, ".ai/project.yaml"))
              ? project_profile(root)
              : null,
            overrides,
          );
        }
        const previousOverride = bytes(file),
          previousConfig = bytes(this.CONFIG);
        try {
          if (file) { record_project_owner(this.STATE, root); dump(overrides, file); }
          if (globalChanged) this.store_shared_settings(config);
        } catch (error) {
          if (file) restore(file, previousOverride);
          restore(this.CONFIG, previousConfig);
          throw error;
        }
        return config;
      });
      return { values: this.values(config) };
    }
    if (["preview", "apply"].includes(action)) {
      const payload = stable({ text: request.text, mode: request.mode || "import", baseRevision: request.baseRevision || null, includeMachineSettings: request.includeMachineSettings ?? null });
      let [config, profile, target, overrides, omittedTestingCommands] = this.parse_import(request);
      let applied = this.effective(config, overrides, profile);
      const shared = settings(this.CONFIG);
      const compatibility = import_compatibility(profile, config.active_project);
      const summary = {
        projectRoot: config.active_project || "",
        profileId: profile?.profile_id || null,
        projectId: profile?.project?.id || null,
        repositories: (profile?.repositories || []).map(
          ({ id, path, alias }) => ({ id, path, alias }),
        ),
        missingPaths: compatibility.missingPaths,
        omittedTestingCommands,
        projectSpecific: profile ? { roots: profile.roots, edtRepositoryIds: profile.policy.edt_repository_ids || [],
          unboundEdtRepositories: profile.policy.unbound_edt_repositories || [], edtMappings: compatibility.edtMappings,
          testing: { yaxunit: profile.testing.yaxunit, vanessa: profile.testing.vanessa, commands: profile.testing.commands.length,
            ...(profile.testing.yaxunit_config?.launch_configuration ? { yaxunitLaunchConfiguration: profile.testing.yaxunit_config.launch_configuration } : {}),
            ...(profile.testing.vanessa_config ? { vanessaRuntimeProfile: profile.testing.vanessa_config.runtime_profile, vanessaServer: profile.testing.vanessa_config.server_name } : {}) },
          knowledge: { mode: profile.knowledge.mode, provider: profile.knowledge.provider, manifest: profile.knowledge.manifest, collections: profile.knowledge.collections } } : null,
        edtConfigured: !!applied.mcp.required.edt.url,
        v8stdConfigured: !!applied.mcp.required.v8std.url,
        openviking: structuredClone(applied.mcp.optional.openviking),
        replacesProfile: !!(target && exists(target)),
        connectionUrls: Object.fromEntries(
          Object.entries(applied.mcp.required).map(([name, item]) => [
            name,
            item.url,
          ]),
        ),
        writesInstanceConnections: overrides !== null,
        sharedRuntimeChanges: Object.fromEntries(
          Object.entries(config.mcp.managed).filter(
            ([name, item]) => stable(item) !== stable(shared.mcp.managed[name]),
          ),
        ),
        sharedOptionalChanges: stable(config.mcp.optional) === stable(shared.mcp.optional) ? {} : config.mcp.optional,
        revision: this.revision(applied, target, stable({ payload, compatibility })),
      };
      if (action === "preview") return summary;
      const saved = await operation_lock(this.STATE, () => {
        [config, profile, target, overrides] = this.parse_import(request);
        applied = this.effective(config, overrides, profile);
        if (request.revision !== this.revision(applied, target, stable({ payload, compatibility: import_compatibility(profile, config.active_project) })))
          throw new ConfigError(
            "Настройки изменились после предпросмотра. Проверьте файл заново.",
          );
        if (target && exists(target) && request.replace !== true)
          throw new ConfigError("Подтвердите замену существующего профиля.");
        const overridePath =
          overrides !== null
            ? instance_file(config, config.active_project)
            : null;
        const previousConfig = bytes(this.CONFIG),
          previousProfile = bytes(target),
          previousOverride = bytes(overridePath);
        const shared = settings(this.CONFIG), persistShared = !profileDocumentOnly;
        if (profileDocumentOnly && (stable(shared.mcp.managed) !== stable(config.mcp.managed) || stable(shared.mcp.optional) !== stable(config.mcp.optional)))
          throw new ConfigError("Общие настройки изменились. Загрузите профиль заново.");
        const saved = target && exists(target) ? backup(target) : null;
        try {
          if (target) dump(profile, target, exists(target));
          if (overridePath) { record_project_owner(this.STATE, config.active_project); dump(overrides, overridePath); }
          if (persistShared) this.store_shared_settings(config);
          // Confirm every written document before reporting success. If a
          // write or subsequent read fails, restore the previous documents.
          if (target && stable(load(target)) !== stable(profile)) throw new ConfigError("Не удалось подтвердить сохранение профиля.");
          if (overridePath && stable(load(overridePath)) !== stable(overrides)) throw new ConfigError("Не удалось подтвердить сохранение настроек экземпляра.");
          if (persistShared) {
            const persisted = load(this.CONFIG);
            if (stable(persisted.mcp.managed) !== stable(config.mcp.managed) || stable(persisted.mcp.optional) !== stable(config.mcp.optional))
              throw new ConfigError("Не удалось подтвердить сохранение общих настроек.");
          }
        } catch (error) {
          if (overridePath) restore(overridePath, previousOverride);
          if (target) restore(target, previousProfile);
          if (persistShared) restore(this.CONFIG, previousConfig);
          throw error;
        }
        return saved;
      });
      remember_profile(this.STATE, config.active_project, profile_state(config.active_project));
      return {
        status: "imported",
        summary,
        backup: saved,
        values: this.values(config),
        profile: profile_state(config.active_project),
        sessionGuidance: session_guidance,
      };
    }
    if (action === "export" || action === "edit") {
      const baseRevision = action === "edit" ? this.edit_revision() : null;
      const config = this.current();
      let profile = null;
      if (config.active_project) {
        const file = path.join(config.active_project, ".ai/project.yaml");
        if (exists(file))
          // Repairing a parsed old/incompatible profile must be possible in the
          // editor. Preview/apply still validate the complete candidate.
          profile = action === "edit" ? load(file) : validate_at(config.active_project, load(file));
        if (profile && action === "export") assert_settings_paths(config, config.active_project, profile, this.STATE, this.CONFIG);
      }
      if (action === "edit" && baseRevision !== this.edit_revision())
        throw new ConfigError("Настройки изменились во время загрузки. Загрузите их заново.");
      return {
        ...(action === "edit" ? { baseRevision } : {}),
        filename: "1c-ai-core-settings.json",
        text: JSON.stringify(
          {
            format: "1c-ai-core-settings",
            version: 1,
            settings: {
              mcp: {
                managed: config.mcp.managed,
                optional: config.mcp.optional,
              },
            },
            profile,
          },
          null,
          2,
        ),
      };
    }
    if (action === "updates") {
      const runtime = await import("./runtime.mjs"), config = this.effective(this.current());
      const component = request.component;
      if (component !== undefined && !managed_components.includes(component)) throw new ConfigError("Выберите компонент.");
      if (Object.hasOwn(request, "version") && request.operation !== "install") throw new ConfigError("Версия задаётся только для установки.");
      if (request.operation === "check") return { components: await Promise.all((component ? [component] : managed_components).map(async id => {
        try { return await runtime.check_updates(this.STATE, config, id); }
        catch (error) { return { component: id, state: "error", detail: safe_error_message(error) }; }
      })), projectRoot: config.active_project };
      if (!managed_components.includes(component)) throw new ConfigError("Выберите компонент.");
      let projectRoot;
      const result = await runtime.update_component(this.STATE, null, null, null, component, request.operation, {
        load_context: () => {
          const shared = this.current();
          if (Object.hasOwn(request, "version")) {
            shared.mcp.managed[component].version = request.version;
            shared.mcp.managed[component].allow_prerelease = false;
            this.checked(shared);
          }
          const config = this.effective(shared);
          if (Object.hasOwn(request, "version") && config.mcp.managed[component].version !== request.version)
            throw new ConfigError("Версия компонента закреплена локальными настройками проекта или экземпляра. Измените локальную версию перед установкой.");
          const [root, data] = runtime.project(config.active_project, config, component === "code-index");
          authorize_preparation(request, root);
          if (["install", "apply", "rollback"].includes(request.operation)) grant_preparation(this.STATE, root, [component]);
          projectRoot = root;
          return { config, root, data };
        },
        commit: release => {
          if (request.operation !== "rollback" && !Object.hasOwn(request, "version")) return;
          const shared = this.current(), version = request.operation === "rollback" ? release : request.version;
          shared.mcp.managed[component].version = version;
          shared.mcp.managed[component].allow_prerelease = false;
          this.checked(shared);
          if (this.effective(shared).mcp.managed[component].version !== version)
            throw new ConfigError("Локальные настройки версии изменились во время установки. Рабочая версия сохранена.");
          const previousConfig = bytes(this.CONFIG);
          this.store_shared_settings(shared);
          return () => restore(this.CONFIG, previousConfig);
        },
      });
      return { ...result, projectRoot };
    }
    if (action === "rebuild_index") {
      const runtime = await import("./runtime.mjs"), config = this.effective(this.current()), [root, data] = runtime.project(config.active_project, config, true);
      authorize_preparation(request, root);
      grant_preparation(this.STATE, root, ["code-index"]);
      return runtime.rebuild_index(this.STATE, config, root, data, request.repository);
    }
    if (action === "check" || action === "refresh_readiness") {
      const runtime = await import("./runtime.mjs"),
        policy = await import("./policy_runtime.mjs");
      const config = this.effective(this.current()),
        [root, data] = runtime.project(config.active_project, config, component_enabled(config, "code-index"));
      const automatic = action === "refresh_readiness";
      if (automatic) {
        if (request.scope !== preparation_scope(root)) throw new ConfigError("Проверка относится к другой папке или экземпляру.");
      } else {
        authorize_preparation(request, root);
        grant_preparation(this.STATE, root, managed_components.filter(component => component_enabled(config, component)));
      }
      const check_component = async component => {
        if (!component_enabled(config, component)) return { name: component, ready: true, state: "disabled", detail: "Компонент отключён; установка и запуск пропущены." };
        try {
          // Opening a profile reuses the launch permission for this exact
          // project and instance; it never grants one or installs a runtime.
          if (automatic && component_settings(config, component).mode !== "external") require_preparation(this.STATE, root, component);
          const item = await runtime.smoke(
              this.STATE,
              config,
              root,
              data,
              component,
              90,
              request.refresh === true,
              null,
              !automatic,
            ),
            ready = item.index_ready !== false;
          return {
            name: component,
            ready,
            state: ready ? "ready" : item.index_state || "not_checked",
            ...(item.index ? { repositories: item.index.repositories, ...(item.index.retryable ? { retryable: true, detail: "Индекс найден; сервис ещё не подтвердил актуальность данных." } : {}) } : {}),
            version: item.server?.version,
          };
        } catch (error) {
          const busy = error.remote !== true && error.message.includes("Another runtime operation");
          return {
            name: component,
            ready: false,
            state: busy ? "preparing" : "error",
            detail: busy ? "Подготовка окружения выполняется…" : safe_error_message(error),
          };
        }
      };
      const check_policy = async () => { try {
        const item = await policy.smoke(config);
        return {
          name: "policy",
          ready: true,
          state: "ready",
          version: item.server.version,
        };
      } catch (error) {
        return {
          name: "policy",
          ready: false,
          state: "error",
          detail: safe_error_message(error),
        };
      } };
      const { probe_connections } = await import("./setup_probe.mjs");
      let managed, external;
      if (automatic) {
        // Independent observations run together; opening a profile must not
        // wait for each managed process and then every external connection.
        const [checks, probes] = await Promise.all([
          Promise.all([...managed_components.map(check_component), check_policy()]),
          probe_connections(config, root, data),
        ]);
        managed = checks; external = probes.external;
      } else {
        managed = [];
        for (const component of managed_components) managed.push(await check_component(component));
        managed.push(await check_policy());
        atomic_write(reconnect_file(this.STATE, root), JSON.stringify({ id: randomUUID() }));
        ({ external } = await probe_connections(config, root, data));
      }
      const readiness = save_readiness(this.STATE, config, data, managed, external);
      return sanitize_setup_result({
        managed,
        projectRoot: root,
        instance: instance_name(),
        actionPolicy: effective_policy(data.policy),
        external,
        readiness,
        fullReadiness: readiness.state === "ready" ? "verified" : "not_ready",
        readinessScope: "setup",
        workflowReadiness: readiness.workflowReadiness,
      });
    }
    throw new ConfigError("Неизвестная операция.");
  }
}
if (entrypoint(import.meta.url)) {
  try {
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 4 * 1024 * 1024)
        throw new Error("Request too large");
    }
    const result = await new SettingsBackend().main(JSON.parse(input));
    console.log(JSON.stringify({ ok: true, result }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: safe_error_message(error), ...(error.code ? { errorCode: error.code } : {}), ...(error.outcomeUnknown ? { outcomeUnknown: true } : {}) }));
    process.exitCode = 1;
  }
}
