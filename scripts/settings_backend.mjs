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
} from "./project_paths.mjs";
import {
  legacy_edt_matches,
  resolved_settings,
  effective_settings,
  instance_file,
  instance_files,
} from "./project_context.mjs";
import { managed_components, component_enabled, grant_preparation, require_preparation, component_settings } from "./components.mjs";
import { directory_context, edt_connection, edt_port_suggestion } from "./directory_context.mjs";
import { profile_history, remember_profile, profile_summary } from "./profile_history.mjs";
import { read_readiness, save_readiness } from "./setup_readiness.mjs";
import { knowledge_status } from "./knowledge.mjs";

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
          if (value) connections[name] = { url: validate_url(value, name) };
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
    return [config, imported, target, overrides];
  }
  async main(request) {
    const action = request.action;
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
      return {
        values: actual,
        installedVersions: installed_versions(this.STATE, config.active_project),
        profile,
        directoryContext,
        profileDirectoryContext,
        edtPortSuggestion: edt_port_suggestion(actual.edtUrl, profileDirectoryContext?.edt?.connection),
        readiness,
        knowledge: profile.status === "loaded" ? knowledge_status(project_profile(config.active_project), effective) : null,
        sessionGuidance: session_guidance,
        instance: instance_name(),
        connectionSources: sources,
        valueSources: Object.fromEntries(Object.entries(FIELDS).filter(([key]) => key.startsWith("openviking"))
          .map(([key, parts]) => [key, fieldSources.openviking?.[parts.at(-1)] || "settings"])),
        preparationScope: preparation_scope(actual.projectRoot),
        legacyState: legacy,
        profileHistory: profile_history(this.STATE, actual.projectRoot),
        summary: await profile_summary(this.STATE, effective, profile, readiness),
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
          dump(local, file);
        }
        return { values: this.values(config) };
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
              [member]: member === "url" ? value ? validate_url(value) : "" : value };
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
      const payload = stable({ text: request.text, mode: request.mode || "import", baseRevision: request.baseRevision || null });
      let [config, profile, target, overrides] = this.parse_import(request);
      let applied = this.effective(config, overrides, profile);
      const shared = settings(this.CONFIG);
      const summary = {
        projectRoot: config.active_project || "",
        profileId: profile?.profile_id || null,
        repositories: (profile?.repositories || []).map(
          ({ id, path, alias }) => ({ id, path, alias }),
        ),
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
        revision: this.revision(applied, target, payload),
      };
      if (action === "preview") return summary;
      const saved = await operation_lock(this.STATE, () => {
        [config, profile, target, overrides] = this.parse_import(request);
        applied = this.effective(config, overrides, profile);
        if (request.revision !== this.revision(applied, target, payload))
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
          previousOverride = bytes(overridePath),
          saved = target && exists(target) ? backup(target) : null;
        try {
          if (target) dump(profile, target, exists(target));
          if (overridePath) { record_project_owner(this.STATE, config.active_project); dump(overrides, overridePath); }
          this.store_shared_settings(config);
        } catch (error) {
          if (overridePath) restore(overridePath, previousOverride);
          if (target) restore(target, previousProfile);
          restore(this.CONFIG, previousConfig);
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
        catch (error) { return { component: id, state: "error", detail: error.message }; }
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
          const busy = error.message.includes("Another runtime operation");
          return {
            name: component,
            ready: false,
            state: busy ? "preparing" : "error",
            detail: busy ? "Подготовка окружения выполняется…" : error.message,
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
          detail: error.message,
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
      return {
        managed,
        projectRoot: root,
        instance: instance_name(),
        actionPolicy: effective_policy(data.policy),
        external,
        readiness,
        fullReadiness: readiness.state === "ready" ? "verified" : "not_ready",
        readinessScope: "setup",
        workflowReadiness: readiness.workflowReadiness,
      };
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
    console.log(JSON.stringify({ ok: false, error: error.message, ...(error.code ? { errorCode: error.code } : {}), ...(error.outcomeUnknown ? { outcomeUnknown: true } : {}) }));
    process.exitCode = 1;
  }
}
