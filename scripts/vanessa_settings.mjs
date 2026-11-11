import fs from "node:fs";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { ConfigError, ROOT, check_schema, inside, operation_lock, stable } from "./common.mjs";
import { private_atomic_write } from "./openviking_store.mjs";
import { project_profile } from "./profile.mjs";
import { contained, instance_name, resolve, sha256 } from "./project_paths.mjs";
import { read_regular_file } from "./bounded_file.mjs";
import { parseProfile } from "../vanessa/profile.mjs";

const exec = promisify(execFile);
const maxBytes = 65536;
const relative = (from, to) => path.relative(from, to).replaceAll("\\", "/") || ".";

function target(root) {
  const project = project_profile(root), config = project.testing?.vanessa_config;
  if (!config?.runtime_profile) throw new ConfigError("Сначала укажите путь к runtime-профилю в конфигурации Vanessa и сохраните её.");
  const file = inside(root, config.runtime_profile);
  if (path.extname(file).toLowerCase() !== ".json") throw new ConfigError("Runtime-профиль Vanessa должен быть файлом JSON.");
  if (path.relative(resolve(root), file).split(path.sep).some(part => part.toLowerCase() === ".git") ||
      [...project.roots.source, ...project.roots.protected].some(relative => contained(inside(root, relative), file)))
    throw new ConfigError("Runtime-профиль Vanessa не может находиться в защищённых исходниках или служебном каталоге Git.");
  return { project, config, file };
}

function snapshot(root) {
  const { project, config, file } = target(root);
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > maxBytes))
    throw new ConfigError("Runtime-профиль должен быть обычным файлом размером до 64 КиБ.");
  const read = stat ? read_regular_file(file, maxBytes) : null;
  if (stat && !read) throw new ConfigError("Не удалось безопасно прочитать runtime-профиль.");
  const bytes = read?.bytes ?? null;
  const revision = sha256(stable({ root: resolve(root), instance: instance_name(), project: project.project.id, config, file, content: bytes ? sha256(bytes) : null }));
  return { project, config, file, bytes, revision };
}

function initial(root, { config, file }) {
  const base = path.dirname(file), user = () => ({ name: "", password: "", interface: "taxi" });
  return { version: 1, id: "ui-tests", projectRoot: relative(base, root), platform: "", runtime: { epf: "" },
    manager: { infobase: { type: "server", server: "localhost", database: "" }, user: user() },
    infobase: { type: "server", server: "localhost", database: "" }, users: { TestClient: user() },
    mcp: { serverName: config.server_name, url: "http://127.0.0.1:19876/mcp", port: 19876 },
    features: relative(base, inside(root, config.features)), results: relative(base, inside(root, config.results)) };
}

function decode_profile(bytes) {
  let profile;
  try { profile = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "")); }
  catch { throw new ConfigError("Runtime-профиль должен содержать корректный JSON в UTF-8."); }
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) throw new ConfigError("Runtime-профиль должен быть объектом JSON.");
  return profile;
}

export function read_vanessa_profile(root) {
  const item = snapshot(root), profile = item.bytes ? decode_profile(item.bytes) : initial(root, item);
  return { profile, revision: item.revision, path: item.file, exists: Boolean(item.bytes) };
}

// Never write credentials into tracked or unignored files. Respect nested Git
// repositories and existing ignore rules, including later negations.
function ensure_git_ignored(file) {
  let directory = path.dirname(file);
  while (!fs.existsSync(directory) && path.dirname(directory) !== directory) directory = path.dirname(directory);
  let ancestor = directory;
  const repositories = [];
  while (true) {
    if (fs.existsSync(path.join(ancestor, ".git"))) repositories.push(ancestor);
    if (path.dirname(ancestor) === ancestor) break;
    ancestor = path.dirname(ancestor);
  }
  if (!repositories.length) return;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  const git = (repo, args, literal = false, files = [file]) => spawnSync("git", ["--no-optional-locks", ...(literal ? ["--literal-pathspecs"] : []), "-C", repo, ...args, "--", ...files], { env, windowsHide: true, shell: false, timeout: 3000, maxBuffer: 32 * 1024 * 1024 });
  for (const repo of repositories) {
    let tracked;
    if (process.platform === "win32") {
      // Git's literal and icase pathspecs do not implement Windows filesystem
      // identity (including Unicode case aliases). Read bounded, NUL-delimited
      // index names instead; an incomplete/undecodable index must fail closed.
      const listing = git(repo, ["ls-files", "--cached", "-z"], false, []);
      if (listing.error || listing.status !== 0) throw new ConfigError("Не удалось проверить индекс Git для runtime-профиля.");
      let names;
      try { names = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(listing.stdout); }
      catch { throw new ConfigError("Не удалось прочитать имена файлов из индекса Git."); }
      if (names && !names.endsWith("\0")) throw new ConfigError("Не удалось полностью прочитать индекс Git.");
      const expected = relative(repo, file), folded = expected.toUpperCase();
      tracked = names.split("\0").some(name => {
        if (!name) return false;
        if (name === expected) return true;
        // Folding selects candidates only. Confirm existing files through the
        // filesystem so distinct files in case-sensitive directories stay distinct.
        if (name.toUpperCase() !== folded) return false;
        const indexedFile = resolve(path.join(repo, name));
        // Two missing spellings cannot be distinguished through realpath.
        // Refuse the ambiguous alias before creating a file with credentials.
        return indexedFile === file || !fs.existsSync(indexedFile) && !fs.existsSync(file);
      });
    } else {
      const result = git(repo, ["ls-files", "--error-unmatch"], true);
      if (result.error || ![0, 1].includes(result.status)) throw new ConfigError("Не удалось проверить индекс Git для runtime-профиля.");
      tracked = result.status === 0;
    }
    if (tracked) throw new ConfigError("Runtime-профиль отслеживается Git. Уберите его из индекса перед сохранением.");
  }
  if (git(repositories[0], ["check-ignore", "-q"]).status !== 0) throw new ConfigError("Исключите runtime-профиль из Git перед сохранением: он содержит пароли.");
}

export async function save_vanessa_profile(state, root, profile, expectedRevision) {
  return operation_lock(state, () => {
    const item = snapshot(root);
    if (item.revision !== expectedRevision) throw new ConfigError("Профиль или привязка проекта изменились. Загрузите профиль Vanessa заново.");
    if (Buffer.byteLength(JSON.stringify(profile)) > maxBytes) throw new ConfigError("Runtime-профиль превышает 64 КиБ.");
    check_schema(profile, "vanessa-runtime.schema.json");
    const parsed = parseProfile(profile, item.file);
    for (const [actual, expected, field] of [[parsed.projectRoot, root, "projectRoot"], [parsed.features, inside(root, item.config.features), "features"], [parsed.results, inside(root, item.config.results), "results"]])
      if (resolve(actual) !== resolve(expected)) throw new ConfigError(`Поле ${field} отличается от привязки проекта Vanessa.`);
    if (parsed.mcp.serverName !== item.config.server_name) throw new ConfigError("Имя MCP-сервера отличается от привязки проекта Vanessa.");
    ensure_git_ignored(item.file);
    if (snapshot(root).revision !== item.revision) throw new ConfigError("Профиль изменился во время сохранения.");
    const content = JSON.stringify(profile, null, 2) + "\n";
    if (Buffer.byteLength(content) > maxBytes) throw new ConfigError("Runtime-профиль превышает 64 КиБ.");
    private_atomic_write(item.file, content, Boolean(item.bytes));
    return { status: "saved", path: item.file, revision: snapshot(root).revision };
  });
}

async function command(root, settings, args) {
  try {
    return await exec(process.execPath, [path.join(ROOT, "scripts", "vanessa.mjs"), ...args, "--project-root", root, "--settings", settings],
      { cwd: root, windowsHide: true, shell: false, maxBuffer: 1024 * 1024, env: { ...process.env, EDT_AI_PROJECT_ROOT: root } });
  } catch (error) {
    let detail;
    for (const output of [error.stderr, error.stdout]) try { detail = JSON.parse(output); if (detail?.error || detail?.message || detail?.status === "unverified") break; } catch {}
    if (detail?.status === "unverified") return { stdout: JSON.stringify(detail) };
    const failure = new ConfigError(detail?.error || detail?.message || "Не удалось выполнить команду Vanessa. Проверьте состояние менеджера перед повтором.");
    if (detail?.outcome === "indeterminate" || !detail) failure.outcomeUnknown = true;
    throw failure;
  }
}

export async function prepare_vanessa_start(root, settings) {
  const before = snapshot(root);
  if (!before.bytes) throw new ConfigError("Сначала создайте и сохраните runtime-профиль Vanessa.");
  const profile = decode_profile(before.bytes);
  const { stdout } = await command(root, settings, ["describe", "--for-action", "start"]);
  let description, scope;
  try { description = JSON.parse(stdout); scope = JSON.parse(description.scope); } catch { throw new ConfigError("Не удалось определить область запуска Vanessa."); }
  if (snapshot(root).revision !== before.revision || description.effects?.join(",") !== "launch" ||
      scope.runtime !== sha256(before.bytes) || scope.runtimeProfile !== resolve(before.file) || scope.projectRoot !== resolve(root) ||
      scope.project !== before.project.project.id || scope.repository !== before.config.repository_id || scope.command !== "start")
    throw new ConfigError("Профиль изменился во время подготовки запуска. Повторите действие.");
  return { scope: description.scope, revision: before.revision, path: before.file,
    target: { project: before.project.project.id, profile: profile.id, platform: profile.platform, manager: profile.manager.infobase, runtime: profile.runtime, mcp: profile.mcp } };
}

export async function start_vanessa(state, root, settings, authorization, expectedRevision) {
  const before = snapshot(root);
  if (before.revision !== expectedRevision) throw new ConfigError("Профиль изменился после подготовки запуска. Повторите действие.");
  if (!authorization || authorization.effects?.join(",") !== "launch" || typeof authorization.scope !== "string" || !authorization.scope || typeof authorization.evidence !== "string" || !authorization.evidence.trim())
    throw new ConfigError("Для запуска менеджера требуется разрешение для выбранного профиля.");
  fs.mkdirSync(state, { recursive: true });
  const directory = fs.mkdtempSync(path.join(state, ".vanessa-authorization-")), file = path.join(directory, "authorization.json");
  let dispatched = false;
  try {
    fs.writeFileSync(file, JSON.stringify({ scope: authorization.scope, effects: ["launch"], authorizations: [authorization] }), { flag: "wx", mode: 0o600 });
    dispatched = true;
    const { stdout } = await command(root, settings, ["start", "--authorization-file", file]);
    try { return JSON.parse(stdout); } catch { throw Object.assign(new ConfigError("Результат запуска менеджера не подтверждён. Проверьте состояние перед повтором."), { outcomeUnknown: true }); }
  } finally {
    try {
      try { fs.unlinkSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
      fs.rmdirSync(directory);
    } catch (error) {
      throw Object.assign(new ConfigError("Не удалось удалить временную запись разрешения. Проверьте состояние менеджера и каталог состояния перед повтором."), { outcomeUnknown: dispatched, cause: error });
    }
  }
}
