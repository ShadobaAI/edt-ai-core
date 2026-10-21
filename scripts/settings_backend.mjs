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
} from "./profile.mjs";
import { effective_policy } from "./action_policy.mjs";
import {
  configuration_root,
  ProfileNotFound,
  reconnect_file,
  instance_name,
  resolve,
  exists,
  is_dir,
  sha256,
  locate_project,
} from "./project_paths.mjs";
import {
  legacy_edt_matches,
  resolved_settings,
  effective_settings,
  instance_file,
  instance_files,
} from "./project_context.mjs";

export const FIELDS = {
  projectRoot: ["active_project"],
  edtUrl: ["mcp", "required", "edt", "url"],
  v8stdUrl: ["mcp", "required", "v8std", "url"],
  openvikingEnabled: ["mcp", "optional", "openviking", "enabled"],
  openvikingUrl: ["mcp", "optional", "openviking", "url"],
};
const bytes = (file) => (file && exists(file) ? fs.readFileSync(file) : null);
const restore = (file, previous) => {
  if (previous === null) fs.rmSync(file, { force: true });
  else atomic_write(file, previous);
};
export const preparation_scope = (root) =>
  root ? `${root}#${instance_name()}` : null;
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
  current() {
    const config = settings(this.CONFIG);
    config.state_dir = this.STATE;
    if (process.env.EDT_AI_PROJECT_ROOT) {
      const selected = configuration_root(process.env.EDT_AI_PROJECT_ROOT);
      if (!config.active_project || !legacy_edt_matches(config, selected))
        config.mcp.required.edt.url = "";
      config.active_project = selected;
    } else if (Object.hasOwn(process.env, "EDT_AI_PROJECT_ROOT")) {
      config.active_project = null;
      config.mcp.required.edt.url = "";
    } else if (config.active_project && is_dir(config.active_project))
      config.active_project = configuration_root(config.active_project);
    return config;
  }
  effective(config, override = null, profile = null, with_sources = false) {
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
      [config, sources] = resolved_settings(config, root, data, override);
    }
    return with_sources ? [config, sources] : config;
  }
  values(config) {
    config = this.effective(config);
    return Object.fromEntries(
      Object.entries(FIELDS).map(([name, parts]) => {
        let item = config;
        for (const part of parts) item = object(item) ? item[part] : null;
        return [name, ["string", "boolean"].includes(typeof item) ? item : ""];
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
    const saved = deep_merge(settings(this.CONFIG), {
      state_dir: this.STATE,
      mcp: { managed: config.mcp.managed, optional: config.mcp.optional },
    });
    atomic_write(this.CONFIG, JSON.stringify(saved, null, 2) + "\n");
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
    if (config.active_project)
      for (const file of instance_files(config, config.active_project))
        chunks.push(Buffer.from(file), bytes(file) || Buffer.alloc(0));
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
      check_schema(deep_merge(config, changes), "plugin-settings.schema.json");
      for (const [name, entry] of Object.entries(changes.mcp?.required || {}))
        if (Object.hasOwn(entry, "url")) {
          const value = entry.url;
          delete entry.url;
          if (value) connections[name] = { url: validate_url(value, name) };
        }
      imported = data.profile == null ? null : structuredClone(data.profile);
      config = deep_merge(config, changes);
    } else if (Object.hasOwn(data, "schema_version")) imported = data;
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
    if (action === "read") {
      const config = this.current(),
        [, sources] = this.effective(config, null, null, true),
        actual = this.values(config);
      return {
        values: actual,
        instance: instance_name(),
        connectionSources: sources,
        preparationScope: preparation_scope(actual.projectRoot),
      };
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
          typeof value !== (key === "openvikingEnabled" ? "boolean" : "string")
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
          if (["edtUrl", "v8stdUrl"].includes(key)) {
            if (!config.active_project)
              throw new ConfigError(
                "Для настройки подключений выберите папку проекта.",
              );
            root = configuration_root(config.active_project);
            (instanceChanges.connections ||= {})[
              key === "edtUrl" ? "edt" : "v8std"
            ] = { url: value ? validate_url(value) : "" };
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
        if (instanceChanges.connections) {
          file = instance_file(config, root);
          overrides = exists(file) ? load(file) : { connections: {} };
          check_schema(overrides, "project-local.schema.json");
          overrides = deep_merge(overrides, instanceChanges);
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
          if (file) dump(overrides, file);
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
        revision: this.revision(applied, target, request.text),
      };
      if (action === "preview") return summary;
      const saved = await operation_lock(this.STATE, () => {
        [config, profile, target, overrides] = this.parse_import(request);
        applied = this.effective(config, overrides, profile);
        if (request.revision !== this.revision(applied, target, request.text))
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
          if (overridePath) dump(overrides, overridePath);
          this.store_shared_settings(config);
        } catch (error) {
          if (overridePath) restore(overridePath, previousOverride);
          if (target) restore(target, previousProfile);
          restore(this.CONFIG, previousConfig);
          throw error;
        }
        return saved;
      });
      return {
        status: "imported",
        summary,
        backup: saved,
        values: this.values(config),
      };
    }
    if (action === "export") {
      const config = this.current();
      let profile = null;
      if (config.active_project) {
        const file = path.join(config.active_project, ".ai/project.yaml");
        if (exists(file))
          profile = validate_at(config.active_project, load(file));
      }
      return {
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
    if (action === "check") {
      const runtime = await import("./runtime.mjs"),
        policy = await import("./policy_runtime.mjs");
      const config = this.effective(this.current()),
        [root, data] = runtime.project(config.active_project, config);
      authorize_preparation(request, root);
      const managed = [];
      for (const component of ["code-index", "bsl-ls"]) {
        try {
          const item = await runtime.smoke(
              this.STATE,
              config,
              root,
              data,
              component,
              90,
              request.refresh === true,
            ),
            ready = item.index_ready !== false;
          managed.push({
            name: component,
            ready,
            state: ready ? "ready" : "indexing",
            version: item.server?.version,
          });
        } catch (error) {
          const busy = error.message.includes("Another runtime operation");
          managed.push({
            name: component,
            ready: false,
            state: busy ? "preparing" : "error",
            detail: busy ? "Подготовка окружения выполняется…" : error.message,
          });
        }
      }
      try {
        const item = await policy.smoke(config);
        managed.push({
          name: "policy",
          ready: true,
          state: "ready",
          version: item.server.version,
        });
      } catch (error) {
        managed.push({
          name: "policy",
          ready: false,
          state: "error",
          detail: error.message,
        });
      }
      atomic_write(
        reconnect_file(this.STATE, root),
        JSON.stringify({ id: randomUUID() }),
      );
      return {
        managed,
        projectRoot: root,
        instance: instance_name(),
        actionPolicy: effective_policy(data.policy),
        external: Object.fromEntries(
          Object.entries(config.mcp.required).map(([name, item]) => [
            name,
            { configured: !!item.url, liveVerified: false },
          ]),
        ),
        fullReadiness: "not_verified",
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
    console.log(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  }
}
