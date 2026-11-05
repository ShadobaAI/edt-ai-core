import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { casefold } from "./casefold.mjs";

export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export class ConfigError extends Error {}
// Prepared copies record hook paths separately: hooks do not inherit MCP env.
// Read only this installed copy; project/instance selection stays with the host.
export function configure_hook_environment() {
  let runtime;
  try {
    runtime = JSON.parse(fs.readFileSync(path.join(ROOT, "hooks/runtime.local.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw new ConfigError("Некорректные локальные настройки запуска hooks");
  }
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime) ||
      [runtime.state, runtime.settings].some(value => typeof value !== "string" || !path.isAbsolute(value)))
    throw new ConfigError("Некорректные локальные настройки запуска hooks");
  process.env.EDT_AI_STATE_DIR ||= runtime.state;
  process.env.EDT_AI_SETTINGS ||= runtime.settings;
}
export class ProfileNotFound extends ConfigError {}
export class ProfileAmbiguous extends ConfigError {
  constructor(candidates) {
    super("В выбранном каталоге несколько профилей .ai/project.yaml; выберите конкретный проект: " + candidates.join(", "));
    this.candidates = candidates;
  }
}
export const exists = (file) => fs.existsSync(file);
export const is_file = (file) => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};
export const is_dir = (file) => {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
};
// realpath also resolves symlinks in the existing prefix of a not-yet-created path.
export function resolve(file) {
  let current = path.resolve(file),
    suffix = [];
  // existsSync follows links and treats a dangling link as absent. Never append
  // a missing suffix to such a link: it could later resolve outside the root.
  while (!fs.lstatSync(current, { throwIfNoEntry: false })) {
    const parent = path.dirname(current);
    if (parent === current) break;
    suffix.unshift(path.basename(current));
    current = parent;
  }
  return path.join(fs.realpathSync.native(current), ...suffix);
}
export function contained(root, target) {
  const relative = path.relative(root, target);
  return (
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
}
export const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");
// realpath preserves filesystem identity without linguistic transformations
// (Straße and STRASSE are different directories even on Windows).
export const path_identity = (file) => resolve(file).replace(/^\\\\\?\\UNC\\/, "\\\\").replace(/^\\\\\?\\/, "");
export function project_directory(state, root) {
  const identity = path_identity(root),
    home = path.join(state, "projects", sha256(identity).slice(0, 32));
  // Do not start a second daemon while an older namespace may still own one.
  // The old state is never read, reused, moved, or deleted automatically.
  const previous = path.join(state, "projects", sha256(casefold(identity)).slice(0, 16));
  if (exists(previous))
    throw new ConfigError("Обнаружено неподдерживаемое прежнее состояние проекта: " + previous + ". Проверьте владельца, остановите его сервисы и перенесите состояние в архив до работы с проектом.");
  const ownerFile = path.join(home, "project-owner.json");
  if (is_file(ownerFile) && JSON.parse(fs.readFileSync(ownerFile, "utf8")).root !== identity)
    throw new ConfigError("Владелец состояния проекта не совпадает: " + home);
  return home;
}
export function record_project_owner(state, root) {
  const home = project_directory(state, root), file = path.join(home, "project-owner.json");
  fs.mkdirSync(home, { recursive: true });
  try { fs.writeFileSync(file, JSON.stringify({ root: path_identity(root) }), { flag: "wx", mode: 0o600 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  if (JSON.parse(fs.readFileSync(file, "utf8")).root !== path_identity(root)) throw new ConfigError("Владелец состояния проекта не совпадает: " + home);
}
export function instance_name() {
  const name = process.env.EDT_AI_INSTANCE || "default";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name))
    throw new ConfigError("Некорректный идентификатор EDT_AI_INSTANCE");
  return name;
}
export function instance_directory(state, root) {
  return path.join(
    state,
    path.relative(state, project_directory(state, root)),
    "instances",
  );
}
export function reconnect_file(state, root) {
  return path.join(
    instance_directory(state, root),
    instance_name() + ".reconnect.json",
  );
}
// Inspect directory entries only; never follow junctions or scan generated state.
export function* project_directories(root, prune = () => false) {
  const ignored = new Set([".git", ".metadata", ".ai", ".settings", "node_modules", "vendor", ".work", ".build"]);
  const pending = [resolve(root)];
  let visited = 0;
  while (pending.length) {
    if (++visited > 20000)
      throw new ConfigError("Поиск проекта превысил 20000 каталогов; выберите более конкретную папку");
    const directory = pending.pop();
    yield directory;
    if (prune(directory)) continue;
    // Profile and project discovery inspect metadata beside an EDT source
    // tree. Descending into configuration objects can exhaust the budget
    // before a new project has any .ai/project.yaml to find.
    const descriptor = path.join(directory, ".project");
    const source = is_file(descriptor) && contained(directory, resolve(descriptor))
      ? resolve(path.join(directory, "src")) : null;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => b.name.localeCompare(a.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || ignored.has(entry.name)) continue;
      const child = resolve(path.join(directory, entry.name));
      if (child !== source && contained(root, child)) pending.push(child);
    }
  }
}
function has_profile(directory) {
  const file = path.join(directory, ".ai/project.yaml");
  if (!is_file(file)) return false;
  if (!contained(directory, resolve(file)))
    throw new ConfigError("Профиль проекта должен оставаться внутри своего репозитория");
  return true;
}
export function locate_project(selected, { recursive = true } = {}) {
  const directory = resolve(selected);
  if (!is_dir(directory))
    throw new ConfigError("Выбранный каталог проекта не существует");
  for (let candidate = directory; ; candidate = path.dirname(candidate)) {
    if (has_profile(candidate)) return candidate;
    if (
      exists(path.join(candidate, ".git")) ||
      path.dirname(candidate) === candidate
    )
      break;
  }
  const matches = [];
  for (const candidate of recursive ? project_directories(directory, has_profile) : []) {
    if (!has_profile(candidate)) continue;
    matches.push(candidate);
    if (matches.length > 1)
      throw new ProfileAmbiguous(matches);
  }
  if (matches.length) return matches[0];
  throw new ProfileNotFound("Профиль .ai/project.yaml не найден в выбранном репозитории или его подкаталогах");
}
export function configuration_root(selected, options) {
  try {
    return locate_project(selected, options);
  } catch (error) {
    if (!(error instanceof ProfileNotFound)) throw error;
  }
  let directory = resolve(selected);
  for (let candidate = directory; ; candidate = path.dirname(candidate)) {
    if (exists(path.join(candidate, ".git"))) return candidate;
    if (path.dirname(candidate) === candidate) return directory;
  }
}
export function select_root(roots, cwd) {
  const paths = [
    ...new Set(
      roots.map((item) => {
        const uri = new URL(item.uri);
        if (
          uri.protocol !== "file:" ||
          !["", "localhost"].includes(uri.hostname)
        )
          throw new ConfigError("Корни проекта должны быть локальными URI file");
        return resolve(fileURLToPath(uri));
      }),
    ),
  ];
  if (paths.length === 1) return paths[0];
  const matches = paths.filter((directory) =>
    contained(directory, resolve(cwd)),
  );
  if (matches.length === 1) return matches[0];
  throw new ConfigError(
    "Выберите ровно один каталог проекта; несколько корней создают неоднозначность",
  );
}
export function state_root() {
  return resolve(
    process.env.EDT_AI_STATE_DIR ||
      path.join(
        process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
        "1c-ai-core",
      ),
  );
}
