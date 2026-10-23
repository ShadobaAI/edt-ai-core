import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  ROOT,
  ConfigError,
  atomic_write,
  check_schema,
  cli,
  deep_merge,
  dump,
  inside,
  load,
  validate_url,
  settings,
  operation_lock,
  state_path,
  entrypoint,
  argumentsOf,
} from "./common.mjs";
import {
  resolve,
  contained,
  exists,
  is_file,
  is_dir,
  locate_project,
  configuration_root,
  ProfileAmbiguous,
} from "./project_paths.mjs";
import { effective_policy } from "./action_policy.mjs";
import { core_version, satisfies_core } from "./compatibility.mjs";
import { load_manifest } from "./knowledge.mjs";
export function validate(data) {
  check_schema(data, "project-profile.schema.json");
  if (!satisfies_core(data.compatibility.core)) throw new ConfigError(`Profile requires core ${data.compatibility.core}; running ${core_version}. Review the profile contract before changing compatibility.core.`);
  for (const [name, entry] of Object.entries(data.connections || {}))
    validate_url(entry.url, name);
  const repos = new Map(data.repositories.map((repo) => [repo.id, repo]));
  if (
    repos.size !== data.repositories.length ||
    new Set(data.repositories.map((repo) => repo.alias)).size !== repos.size
  )
    throw new ConfigError("Repository ids and index aliases must be unique");
  function known(values, label) {
    const missing = values.filter((id) => !repos.has(id));
    if (missing.length)
      throw new ConfigError(
        `Unknown repository ids in ${label}: ${missing.sort().join(", ")}`,
      );
  }
  const policy = data.policy,
    assigned = policy.edt_repository_ids || [],
    unbound = policy.unbound_edt_repositories || [];
  known([...assigned, ...unbound], "policy");
  if (assigned.some((id) => unbound.includes(id)))
    throw new ConfigError("EDT assigned and unbound repository groups overlap");
  effective_policy(policy);
  const exceptions = policy.exceptions || [];
  for (const exception of exceptions) {
    known(exception.repository_ids, "policy exception");
    if (!exception.repository_ids.length)
      throw new ConfigError(
        "A policy exception needs an explicit repository scope",
      );
  }
  if (new Set(exceptions.map((item) => item.id)).size !== exceptions.length)
    throw new ConfigError("Policy exception ids must be unique");
  const testing = data.testing;
  for (const kind of ["yaxunit", "vanessa"]) {
    const config = testing[kind + "_config"];
    if (!config) continue;
    const owner = config.repository_id;
    known([owner], kind);
    if (kind === "yaxunit") {
      const framework = config.framework_repository_id;
      known(
        [
          ...(config.product_repository_ids || []),
          ...(framework ? [framework] : []),
        ],
        kind,
      );
      if (framework === owner)
        throw new ConfigError(
          "YaXUnit framework and test owner must be different repositories",
        );
      if (
        testing[kind] &&
        (!repos.get(owner).edt_project || unbound.includes(owner))
      )
        throw new ConfigError(
          "Enabled YaXUnit needs a bound EDT project for its test owner",
        );
    }
  }
  for (const command of testing.commands) {
    known([command.repository_id], "test command");
    if (/[\\/:\s]/.test(command.argv[0]))
      throw new ConfigError(
        "Test command program must be a portable executable name, not a shell expression/path",
      );
  }
  if (
    new Set(testing.commands.map((item) => item.id)).size !==
    testing.commands.length
  )
    throw new ConfigError("Test command ids must be unique");
  function walk(value) {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object")
      for (const [key, child] of Object.entries(value)) {
        if (
          /(password|secret|credential|private.?key|api.?key|access.?token|authorization)/i.test(
            key,
          )
        )
          throw new ConfigError(
            "Credentials do not belong in portable profiles: " + key,
          );
        if (key !== "headers_env") walk(child); // Schema only allows environment variable references here.
      }
  }
  walk(data);
  return data;
}
export function scoped_paths(data) {
  const paths = [
    ...data.roots.source,
    ...data.roots.protected,
    ...data.repositories.map((repo) => repo.path),
  ];
  for (const kind of ["yaxunit", "vanessa"]) {
    const config = data.testing[kind + "_config"] || {};
    for (const key of ["results", "features", "runtime_profile"])
      if (key in config) paths.push(config[key]);
  }
  if (data.knowledge.manifest) paths.push(data.knowledge.manifest);
  return paths;
}
export function validate_at(root, data) {
  validate(data);
  scoped_paths(data).forEach((relative) => inside(root, relative));
  if (data.knowledge.manifest) load_manifest(root, data.knowledge.manifest, data.knowledge.collections);
  const config = data.testing.vanessa_config;
  if (
    config &&
    !contained(
      inside(
        root,
        data.repositories.find((repo) => repo.id === config.repository_id).path,
      ),
      inside(root, config.features),
    )
  )
    throw new ConfigError(
      "Vanessa features must remain inside their owning repository",
    );
  return data;
}
export function project_profile(selected) {
  const root = locate_project(selected);
  return validate_at(root, load(path.join(root, ".ai/project.yaml")));
}
export function profile_target(root) {
  const target = path.join(resolve(root), ".ai/project.yaml");
  if (!contained(resolve(root), resolve(target)))
    throw new ConfigError(".ai must remain inside the project");
  return target;
}
export function backup(target) {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const file = path.join(
    path.dirname(target),
    `project.${stamp}.${randomUUID().slice(0, 8)}.bak.yaml`,
  );
  atomic_write(file, fs.readFileSync(target), false);
  return file;
}
export function profile_state(selected) {
  if (!selected) return { status: "unselected", path: null };
  let target = profile_target(selected);
  try {
    const root = configuration_root(selected);
    target = profile_target(root);
    const data = project_profile(root);
    return { status: "loaded", path: target, profileId: data.profile_id,
      projectId: data.project.id, repositories: data.repositories.map(({ id, path, alias, edt_project }) => ({ id, path, alias, edt_project })) };
  } catch (error) {
    if (error instanceof ProfileAmbiguous)
      return { status: "ambiguous", path: null, candidates: error.candidates.map(root => profile_target(root)), detail: error.message };
    return { status: exists(target) ? "invalid" : "missing", path: target, detail: error.message, ...(error.code ? { errorCode: error.code } : {}) };
  }
}
export function create_profile(selected) {
  const root = configuration_root(selected), target = profile_target(root);
  if (!is_dir(root)) throw new ConfigError("Project directory does not exist");
  if (exists(target)) throw new ConfigError("Profile already exists: " + target);
  const data = load(path.join(ROOT, "profiles/generic-1c/profile.yaml"));
  data.project.id = path.basename(root).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "") || "project";
  validate_at(root, data);
  // Resolve every supporting path before the first write (including junctions).
  for (const name of [".ai/PROJECT.md", ".ai/.gitignore", "AGENTS.md", "AGENTS.override.md"]) {
    const file = inside(root, name);
    if (fs.lstatSync(path.join(root, name), { throwIfNoEntry: false }) && !is_file(file))
      throw new ConfigError("Project instructions path must be a regular file: " + name);
  }
  const projectInstructions = { created: [], preserved: [], contentValidated: false };
  const override = inside(root, "AGENTS.override.md");
  if (exists(override)) {
    projectInstructions.preserved.push("AGENTS.override.md");
    if (fs.readFileSync(override, "utf8").trim()) projectInstructions.overrideFile = "AGENTS.override.md";
  }
  dump(data, target, false);
  for (const [name, text] of Object.entries({
    ".ai/PROJECT.md": "# Контекст проекта\n\nНазначение, архитектура и источники истины ещё не описаны.\nПри настройке заполни подтверждённые сведения; неизвестное отметь явно.\nМашинные сопоставления хранятся в project.yaml, правила работы — в ../AGENTS.md.\n",
    ".ai/.gitignore": "project.local.yaml\ninstances/*.local.yaml\n",
    "AGENTS.md": "# Работа с проектом 1С\n\nИспользуй 1c-ai-core. Прочитай .ai/project.yaml и .ai/PROJECT.md.\nПеред операциями с конфигурацией используй $1c-routing и общую action policy.\nДля защищённых исходников используй назначенные профилем инструменты.\nРанее выданные пользователем разрешения применяй только в согласованной области.\n\n## Правила проекта требуют заполнения\n\nПри настройке опиши подтверждённые правила владения объектами, префиксы,\nизменение поставки и маркировку доработок; укажи проверки и тестовый контур.\nНеизвестные правила не придумывай; уточняй их перед зависимой операцией.\nНазначение и архитектуру храни в .ai/PROJECT.md, сопоставления — в профиле.\nНе копируй сюда навыки плагина, endpoints, секреты и статус текущей сессии.\n",
  })) {
    const file = inside(root, name);
    const preserved = exists(file);
    if (!preserved) atomic_write(file, text, false);
    if (name.endsWith(".md")) projectInstructions[preserved ? "preserved" : "created"].push(name);
  }
  return { status: "created", path: target, profile_id: data.profile_id, projectInstructions };
}
export async function main() {
  const a = argumentsOf(
      undefined,
      ["merge", "replace"],
      [
        "profile",
        "output",
        "input",
        "settings",
        "instance",
        "edt_url",
        "v8std_url",
      ],
    ),
    [command, selected] = a._;
  if (command === "validate") {
    validate(load(selected));
    console.log(JSON.stringify({ status: "valid", readiness: "not_checked" }));
    return;
  }
  if (["effective", "configure-instance"].includes(command)) {
    const { instance_file, effective_settings } =
      await import("./project_context.mjs");
    const { instance_name } = await import("./project_paths.mjs");
    if (a.instance) process.env.EDT_AI_INSTANCE = a.instance;
    const root = locate_project(selected),
      data = project_profile(root),
      config = settings(a.settings),
      target = instance_file(config, root);
    if (command === "configure-instance") {
      const updates = Object.fromEntries(
        ["edt", "v8std"]
          .filter((name) => a[name + "_url"] !== undefined)
          .map((name) => [name, { url: validate_url(a[name + "_url"], name) }]),
      );
      if (!Object.keys(updates).length)
        throw new ConfigError("Specify --edt-url or --v8std-url");
      await operation_lock(state_path(config), () => {
        const override = exists(target) ? load(target) : { connections: {} };
        check_schema(override, "project-local.schema.json");
        const candidate = deep_merge(override, { connections: updates });
        check_schema(candidate, "project-local.schema.json");
        effective_settings(config, root, data, candidate);
        dump(candidate, target);
      });
    }
    const effective = effective_settings(config, root, data);
    console.log(
      JSON.stringify(
        {
          projectRoot: root,
          instance: instance_name(),
          instanceFile: target,
          profile: {
            ...data,
            connections: Object.fromEntries(
              Object.entries(effective.mcp.required)
                .filter(([, value]) => value.url)
                .map(([name, value]) => [name, { url: value.url }]),
            ),
          },
        },
        null,
        2,
      ),
    );
    return;
  }
  if (!selected || !is_dir(selected))
    throw new ConfigError("Project directory does not exist");
  let root = resolve(selected);
  if (["import", "export"].includes(command)) root = configuration_root(root);
  const target = profile_target(root);
  let result;
  if (command === "init") {
    if (a.profile && a.profile !== "generic-1c")
      throw new ConfigError("Unknown profile");
    result = create_profile(root);
  } else if (command === "export") {
    if (!a.output) throw new ConfigError("export requires --output");
    const output = resolve(a.output);
    if (output === resolve(target))
      throw new ConfigError(
        "Export destination must differ from the active profile",
      );
    dump(project_profile(root), output, a.replace || false);
    result = { status: "exported", path: output };
  } else if (command === "import") {
    if (!a.input || (a.merge && a.replace))
      throw new ConfigError("Specify --input and choose --merge or --replace");
    let incoming = validate(load(a.input));
    if (exists(target) && !(a.merge || a.replace))
      throw new ConfigError(
        "Profile exists: choose --merge or --replace (a backup will be saved)",
      );
    if (a.merge && exists(target)) {
      const current = project_profile(root);
      if (incoming.profile_id !== current.profile_id)
        throw new ConfigError(
          "Cannot merge different profile types; use --replace",
        );
      incoming = validate(deep_merge(current, incoming));
    }
    validate_at(root, incoming);
    const saved = exists(target) ? backup(target) : null;
    dump(incoming, target, exists(target));
    result = {
      status: "imported",
      path: target,
      backup: saved,
      profile_id: incoming.profile_id,
    };
  } else throw new ConfigError("Unknown profile command");
  console.log(JSON.stringify(result));
}
if (entrypoint(import.meta.url)) await cli(main);
