import fs from "node:fs";
import path from "node:path";
import { spawnSync, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  ROOT,
  ConfigError,
  atomic_write,
  cli,
  inside,
  operation_lock,
  settings,
  state_path,
  sleep,
  entrypoint,
  argumentsOf,
  stable,
} from "./common.mjs";
import {
  exists,
  is_file,
  is_dir,
  resolve,
  sha256,
  locate_project,
  path_identity,
  project_directory,
  reconnect_file,
  record_project_owner,
  configuration_root,
} from "./project_paths.mjs";
import { project_profile } from "./profile.mjs";
import { effective_settings } from "./project_context.mjs";
import { safe_error_message, create_diagnostic_logger } from "./diagnostics.mjs";
import { launch, stop_child, alive, which, run_sync } from "./processes.mjs";
import { extract_binary, zip_entries } from "./archives.mjs";
import { McpClient } from "./mcp_client.mjs";
import { all_pages } from "./mcp_pages.mjs";
import { COMPONENTS, managed_components, component_enabled, component_settings, grant_preparation, require_preparation, native_environment } from "./components.mjs";
import { RemoteMcp } from "./remote_client.mjs";
import { core_version } from "./compatibility.mjs";
import { spawn_detached_windows } from "./windows_process.mjs";
import { index_repositories, index_selection } from "./directory_context.mjs";
import { open_reader, reader_active } from "./reader_lease.mjs";

export const SPECS = Object.fromEntries(managed_components.map(id => [id, COMPONENTS[id].repository]));
// Workspace registration tools first appeared in 1.1.0-rc.4.
function supported_bsl_version(tag) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*))?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.exec(tag || "");
  if (!match) return false;
  const major = Number(match[1]), minor = Number(match[2]), patch = Number(match[3]);
  if (major !== 1) return major > 1;
  if (minor !== 1) return minor > 1;
  if (patch !== 0) return patch > 0;
  if (!match[4]) return true;
  const rc = /^rc\.(\d+)$/.exec(match[4]);
  return Boolean(rc && Number(rc[1]) >= 4);
}
function require_supported_version(component, tag) {
  if (component === "bsl-ls" && !supported_bsl_version(tag))
    throw new ConfigError("Для BSL LS требуется версия 1.1.0 или новее; также поддерживается 1.1.0-rc.4 и более новые RC. Установите подходящую версию в настройках.");
}
export async function list_versions(component, io = { fetch_json }, options = {}) {
  if (!Object.hasOwn(SPECS, component)) throw new ConfigError("Неизвестный компонент окружения");
  const releases = [], deadline = Date.now() + 90000;
  const base = `https://api.github.com/repos/${SPECS[component]}/releases`;
  const readPage = async (query, fresh) => {
    if (Date.now() >= deadline) throw new ConfigError("Истекло время загрузки каталога версий; повторите загрузку списка");
    let hasNext = null;
    const items = await io.fetch_json(base + query, Math.min(30000, deadline - Date.now()), {
      fresh, on_response: response => { hasNext = /;\s*rel="next"/.test(response.headers.get("link") || ""); },
    });
    if (!Array.isArray(items)) throw new ConfigError("Некорректный список выпусков компонента");
    return { items, hasNext };
  };
  let pageSize = 100, nextExpected = false;
  for (let page = 1; page <= 10000 / pageSize; page++) {
    let result = await readPage(page === 1 ? `?per_page=${pageSize}` : `?page=${page}&per_page=${pageSize}`, options.refresh === true);
    // Empty query variants occur even while equivalent queries return releases.
    // A Link-advertised page must not silently truncate the successful catalog.
    if (!result.items.length && (page === 1 || nextExpected)) {
      result = await readPage(page === 1 ? "?page=1&per_page=100" : `?per_page=${pageSize}&page=${page}`, true);
      if (page === 1 && !result.items.length) {
        pageSize = 50;
        result = await readPage("?page=1&per_page=50", true);
      }
      if (!result.items.length) throw new ConfigError("GitHub вернул пустую страницу каталога после повторных запросов. Обновите список позже; неполный результат не сохранён.");
    }
    const { items, hasNext } = result;
    for (const item of items) {
      if (!item || item.draft || typeof item.tag_name !== "string" || item.tag_name === "latest" || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(item.tag_name) || (component === "bsl-ls" && !supported_bsl_version(item.tag_name))) continue;
      const publishedAt = item.published_at || item.created_at || null;
      releases.push({ version: item.tag_name, prerelease: Boolean(item.prerelease), publishedAt });
    }
    if (hasNext === false || (hasNext === null && items.length < pageSize)) {
      releases.sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0));
      const seen = new Set();
      const versions = releases.filter(item => { if (seen.has(item.version)) return false;seen.add(item.version);return true; });
      if (!versions.length) throw new ConfigError("GitHub не вернул опубликованных тегов версий. Повторите загрузку списка.");
      return { component, versions };
    }
    nextExpected = hasNext === true;
  }
  throw new ConfigError("В каталоге больше 10000 выпусков; неполный список не возвращён");
}
export async function latest_version(component, io = { fetch_json }, options = {}) {
  if (!Object.hasOwn(SPECS, component)) throw new ConfigError("Неизвестный компонент окружения");
  const release = await runtime_release(component, { version: "latest", allow_prerelease: options.allowPrerelease === true }, {
    fetch_json: url => io.fetch_json(url, 30000, { fresh: options.refresh === true }),
  });
  return release.tag_name;
}
async function runtime_release(component, options, io) {
  const requested = options.version, automatic = requested === "latest";
  const tag = /^\d+\.\d+\.\d+/.test(requested) ? "v" + requested : requested;
  if (!automatic) require_supported_version(component, tag);
  const releaseURL = automatic ? (options.allow_prerelease ? "?per_page=100" : "/latest") : "/tags/" + tag;
  const base = `https://api.github.com/repos/${SPECS[component]}/releases`;
  let response;
  try { response = await io.fetch_json(base + releaseURL); }
  catch (error) {
    if (!(component === "bsl-ls" && automatic && !options.allow_prerelease && error.status === 404)) throw error;
  }
  if (component === "bsl-ls" && automatic && !options.allow_prerelease && (!response || !supported_bsl_version(response.tag_name))) {
    const releases = await io.fetch_json(base + "?per_page=100");
    response = Array.isArray(releases) ? releases.find(item => !item.draft && item.prerelease && /^v?1\.1\.0-rc\.\d+$/.test(item.tag_name || "") && supported_bsl_version(item.tag_name)) : null;
    if (!response) throw new ConfigError("Не найден поддерживаемый стабильный выпуск BSL LS или кандидат выпуска 1.1.0");
    require_supported_version(component, response.tag_name);
    return response;
  }
  // GitHub lists releases newest first. Drafts are never runnable candidates.
  const release = automatic && options.allow_prerelease
    ? (Array.isArray(response) ? response.find(item => !item.draft && (component !== "bsl-ls" || supported_bsl_version(item.tag_name))) : null) : response;
  if (!release || release.draft || (automatic && !options.allow_prerelease && release.prerelease))
    throw new ConfigError("Нет подходящего выпуска компонента; выберите стабильный выпуск, allow_prerelease или явную версию");
  if (!automatic && release.tag_name !== tag)
    throw new ConfigError("Ответ каталога выпусков не соответствует запрошенной версии");
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(release.tag_name || ""))
    throw new ConfigError("Неподдерживаемый тег выпуска: " + release.tag_name);
  require_supported_version(component, release.tag_name);
  return release;
}
export function platform_build(
  platform = process.platform,
  arch = process.arch,
) {
  const builds = {
    "win32-x64": ["bsl-indexer-windows-x64.zip", "bsl-indexer.exe", "zip"],
    "linux-x64": ["bsl-indexer-linux-x64.tar.gz", "bsl-indexer", "tar.gz"],
    "darwin-arm64": ["bsl-indexer-macos-arm64.tar.gz", "bsl-indexer", "tar.gz"],
  };
  const build = builds[platform + "-" + arch];
  if (!build)
    throw new ConfigError(
      `Неподдерживаемая платформа code-index: ${platform}/${arch}. Доступны сборки Windows x64, Linux x64 и macOS arm64.`,
    );
  return { asset: build[0], executable: build[1], format: build[2] };
}
export const read_json = (file, fallback = null) =>
  is_file(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback;
export const save_json = (file, value) =>
  atomic_write(file, JSON.stringify(value, null, 2) + "\n");
export const sha = (file) => sha256(fs.readFileSync(file));
export async function fetch_json(url, timeout = 30000, options = {}) {
  const response = await fetch(url, {
    headers: { "User-Agent": "1c-ai-core/" + core_version, ...(options.fresh ? { "Cache-Control": "no-cache" } : {}) },
    ...(options.fresh ? { cache: "no-store" } : {}),
    signal: AbortSignal.timeout(timeout),
    redirect: "error",
  });
  try {
    if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}: ${url}`), { status: response.status });
    options.on_response?.(response);
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body || []) {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) throw new ConfigError("Ответ каталога выпусков превышает 8 МиБ.");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    await response.body?.cancel().catch(() => {});
    throw error;
  }
}
export function artifact(state, component, slot = "active") {
  const active = read_json(path.join(state, "runtime-lock.json"), {})[component];
  const entry = slot === "active" ? active : active?.[slot];
  if (!entry || !entry.release) return null;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(entry.release || "") ||
    !/^[0-9a-f]{64}$/.test(entry.sha256 || "")
  )
    throw new ConfigError("Некорректная запись runtime-lock");
  const executable =
    component === "code-index"
      ? platform_build().executable
      : "bsl-language-server-exec.jar";
  if (
    entry.platform &&
    entry.platform !== process.platform + "-" + process.arch
  )
    return null;
  if (typeof entry.path !== "string") throw new ConfigError("Некорректный путь артефакта в runtime-lock");
  const home = path.join(state, "runtime", component, entry.release),
    target = inside(state, entry.path);
  if (resolve(target) !== resolve(path.join(home, entry.sha256, executable)))
    throw new ConfigError("Некорректный путь артефакта в runtime-lock");
  return is_file(target) && sha(target) === entry.sha256 ? target : null;
}
export function installed_versions(state, root = null) {
  let lock;
  try { lock = read_json(path.join(state, "runtime-lock.json"), {}); }
  catch { lock = {}; }
  return Object.fromEntries(managed_components.map(component => {
    try {
      const active = artifact(state, component);
      if (component === "code-index" && root) {
        const home = path.join(project_home(state, root), "code-index"), owner = read_json(path.join(home, "owner.json"), {}), daemon = read_json(path.join(home, "daemon.json"), {});
        if (owner.project_root && path_key(owner.project_root) === path_key(root) && owner.pid === daemon.pid && alive(owner.pid) && owner.executable !== active && owned_executable(state, owner)) {
          const release = path.relative(path.join(state, "runtime/code-index"), owner.executable).split(path.sep)[0];
          if (/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(release)) return [component, release];
        }
      }
      return [component, active ? lock[component].release : null];
    }
    catch { return [component, null]; }
  }));
}
export async function ensure_installed(
  state,
  config,
  component,
  refresh = false,
  io = { fetch_json, fetch },
  options = {},
) {
  if (!Object.hasOwn(SPECS, component))
    throw new ConfigError("Неизвестный компонент окружения");
  const build =
    component === "code-index"
      ? platform_build()
      : { executable: "bsl-language-server-exec.jar" };
  const existing = artifact(state, component),
    requested = config.mcp.managed[component].version,
    current =
      read_json(path.join(state, "runtime-lock.json"), {})[component] || {};
  if (!refresh && existing && (requested === "latest" || requested.replace(/^v/, "") === current.release.replace(/^v/, "")))
    require_supported_version(component, current.release);
  if (
    existing &&
    !refresh &&
    (requested === "latest" ||
      requested.replace(/^v/, "") === current.release.replace(/^v/, ""))
  )
    return existing;
  const release = await runtime_release(component, component_settings(config, component), io);
  const version = release.tag_name;
  if (existing && current.release === version && !refresh) return existing;
  const candidates = release.assets.filter((asset) =>
    component === "code-index"
      ? asset.name === build.asset
      : /^bsl-language-server-.*-exec\.jar$/.test(asset.name),
  );
  if (candidates.length !== 1)
    throw new ConfigError(
      `Ожидался один артефакт ${component}, получено ${candidates.length}. Требуемая платформа: ${process.platform}/${process.arch}.`,
    );
  const asset = candidates[0],
    digest = asset.digest || "";
  if (!/^sha256:[0-9a-f]{64}$/.test(digest))
    throw new ConfigError(
      `Для артефакта выпуска ${version} не опубликована контрольная сумма SHA-256`,
    );
  if (
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0 ||
    asset.size > 512 * 1024 * 1024
  )
    throw new ConfigError("Некорректный размер артефакта компонента");
  const url = new URL(asset.browser_download_url);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    !url.pathname.startsWith("/" + SPECS[component] + "/releases/download/")
  )
    throw new ConfigError("Недопустимый источник загрузки компонента");
  process.stderr.write(
    `Installing ${component} ${version}: ${asset.size} bytes\n`,
  );
  const response = await io.fetch(url.href, {
    headers: { "User-Agent": "1c-ai-core/" + core_version },
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Загрузка компонента: HTTP " + response.status);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > asset.size)
      throw new ConfigError("Не совпадает размер или SHA-256 артефакта: " + component);
    chunks.push(chunk);
  }
  const download = Buffer.concat(chunks);
  if (size !== asset.size || sha256(download) !== digest.slice(7))
    throw new ConfigError("Не совпадает размер или SHA-256 артефакта: " + component);
  let staged;
  if (component === "code-index")
    staged = extract_binary(download, build.format, build.executable);
  else {
    zip_entries(download, 1024 * 1024 * 1024);
    staged = download;
  }
  const contentSHA = sha256(staged);
  const target =
    existing && current.release === version && sha(existing) === contentSHA
      ? existing
      : path.join(
          state,
          "runtime",
          component,
          version,
          contentSHA,
          build.executable,
        );
  if (!is_file(target) || sha(target) !== contentSHA)
    atomic_write(target, staged);
  if (component === "code-index" && process.platform !== "win32")
    fs.chmodSync(target, 0o755);
  const lock = read_json(path.join(state, "runtime-lock.json"), {});
  const entry = {
    release: version,
    prerelease: Boolean(release.prerelease),
    path: path.relative(resolve(state), resolve(target)),
    sha256: contentSHA,
    asset_sha256: digest.slice(7),
    source: url.href,
    bytes: asset.size,
    ...(component === "code-index"
      ? { platform: process.platform + "-" + process.arch }
      : {}),
  };
  if (options.stage || existing) lock[component] = { ...lock[component], candidate: entry };
  else lock[component] = { ...entry, ...(lock[component]?.path ? { previous: active_entry(lock[component]) } : {}) };
  save_json(path.join(state, "runtime-lock.json"), lock);
  return resolve(target);
}
export function project(selected, config, requireRepositories = true) {
  selected ||= process.env.EDT_AI_PROJECT_ROOT || config.active_project;
  if (!selected)
    throw new ConfigError(
      "Укажите --project-root, EDT_AI_PROJECT_ROOT или active_project в настройках плагина",
    );
  const root = locate_project(selected),
    data = project_profile(root);
  if (requireRepositories && !data.repositories.length)
    throw new ConfigError(
      "Задайте репозитории в профиле проекта: id, относительный path и alias",
    );
  for (const repo of data.repositories)
    if (!is_dir(inside(root, repo.path)))
      throw new ConfigError(
        "Каталог репозитория не существует: " + repo.path,
      );
  return [root, data];
}
export const path_key = path_identity;
export const project_home = (state, root) =>
  project_directory(state, root);
export const installed_runtime = (state, config, component, refresh = false, allow_install = true, lock_timeout = 120) =>
  operation_lock(
    state,
    () => {
      const current = artifact(state, component), requested = component_settings(config, component).version;
      const release = read_json(path.join(state, "runtime-lock.json"), {})[component]?.release;
      if (current && !refresh) require_supported_version(component, release);
      if (current && (refresh || (requested !== "latest" && requested.replace(/^v/, "") !== release?.replace(/^v/, ""))))
        throw new ConfigError("Проверенный компонент уже активен; используйте settings.updates для загрузки, проверки и применения новой версии.");
      if (!current && !allow_install)
        throw new ConfigError("Компонент не установлен или повреждён. Нажмите «Подготовить и проверить» для подготовки runtime.");
      return ensure_installed(state, config, component, refresh);
    },
    lock_timeout,
  );
const active_entry = ({ candidate, previous, ...entry } = {}) => entry;
const runtimeOwner = randomUUID();
const activeMaintenance = new Set();
const uncertain_update = message => Object.assign(new ConfigError(message), { outcomeUnknown: true });
function owned_executable(state, owner) {
  if (!owner.executable || !is_file(owner.executable)) return false;
  const target = resolve(owner.executable), base = resolve(path.join(state, "runtime/code-index"));
  if (!target.startsWith(base + path.sep)) return false;
  // The process's own immutable artifact is checked, not today's active release.
  const digest = path.basename(path.dirname(target));
  return /^[0-9a-f]{64}$/.test(digest) && digest === sha(target);
}
export async function check_updates(state, config, component, io = { fetch_json }) {
  const options = component_settings(config, component);
  if (!component_enabled(config, component) || options.mode === "external")
    return { component, state: !component_enabled(config, component) ? "disabled" : "external" };
  const release = await runtime_release(component, options, io);
  const current = read_json(path.join(state, "runtime-lock.json"), {})[component] || {};
  return { component, state: current.release === release.tag_name ? "current" : "update_available", active: current.release || null,
    latest: release.tag_name, requested: options.version, candidate: current.candidate?.release || null, previous: current.previous?.release || null };
}
export function signal_component(state, root, component, allInstances = false) {
  const selected = reconnect_file(state, root), files = new Set([selected]);
  if (allInstances && exists(path.dirname(selected)))
    for (const name of fs.readdirSync(path.dirname(selected))) {
      const match = /^([A-Za-z0-9][A-Za-z0-9._-]{0,63})\.(?:preparation|reconnect)\.json$/.exec(name);
      if (match) files.add(path.join(path.dirname(selected), match[1] + ".reconnect.json"));
    }
  for (const file of files) {
    const record = read_json(file, {});
    save_json(file, { ...record, [component]: Date.now() + ":" + Math.random() });
  }
}
export async function active_readers(state, root) {
  const directory = path.join(project_home(state, root), "code-index/readers");
  const active = [];
  if (!exists(directory)) return active;
  for (const name of fs.readdirSync(directory).filter(file => file.endsWith(".json"))) {
    const file = path.join(directory, name);
    let reader;
    try { reader = read_json(file); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (!reader) continue;
    if (reader.root !== resolve(root)) continue;
    if (await reader_active(reader.id)) active.push(reader);
    else fs.rmSync(file, { force: true });
  }
  return active;
}
function check_maintenance(home, allowOwned = false) {
  const file = path.join(home, "maintenance.json");
  if (!exists(file)) return;
  let record;
  if (allowOwned && activeMaintenance.has(home)) {
    try { record = read_json(file); } catch { /* An unreadable marker remains a barrier. */ }
  }
  if (!allowOwned || !activeMaintenance.has(home) || record?.pid !== process.pid || record?.ownerId !== runtimeOwner)
    throw new ConfigError("Обновление компонента выполняется или было прервано; проверьте settings.operation до подключения читателей");
}
function begin_maintenance(home, root) {
  check_maintenance(home);
  save_json(path.join(home, "maintenance.json"), { pid: process.pid, root: resolve(root), ownerId: runtimeOwner });
  activeMaintenance.add(home);
}
export async function acquire_reader(state, root) {
  record_project_owner(state, root);
  const home = path.join(project_home(state, root), "code-index");
  return operation_lock(home, async () => {
    check_maintenance(home);
    const id = randomUUID(), file = path.join(home, "readers", id + ".json"), owner = await open_reader(id);
    try { save_json(file, { id, pid: process.pid, root: resolve(root) }); }
    catch (error) { await owner.close(); throw error; }
    let closing;
    return { file, close: () => closing ||= (async () => {
      try { fs.rmSync(file, { force: true }); } finally { await owner.close(); }
    })() };
  });
}
export async function update_component(state, config, root, data, component, action, io = {}) {
  if (!managed_components.includes(component)) throw new ConfigError("Неизвестный управляемый компонент");
  const lockfile = path.join(state, "runtime-lock.json");
  return operation_lock(state, async () => {
    if (io.load_context) ({ config, root, data } = await io.load_context());
    if (!component_enabled(config, component) || component_settings(config, component).mode === "external") throw new ConfigError("Перед обновлением включите управляемый режим для " + component);
    if (["download", "install"].includes(action)) {
      const file = await ensure_installed(state, config, component, true, io.fetch_json ? io : { fetch_json, fetch }, { stage: true });
      if (action === "download") return { component, state: "candidate_downloaded", path: file };
    }
    if (!["install", "apply", "rollback"].includes(action)) throw new ConfigError("Неизвестное действие обновления");
    const before = read_json(lockfile, {}), entry = before[component] || {}, slot = action === "rollback" ? "previous" : "candidate";
    const candidate = artifact(state, component, slot);
    if (!candidate) throw new ConfigError("Нет проверенного артефакта " + slot + "; сначала загрузите кандидата");
    require_supported_version(component, entry[slot].release);
    if (action !== "rollback") {
      const options = component_settings(config, component), selected = entry[slot];
      // An RC is allowed by the default policy only while no supported stable
      // release exists. A previously downloaded candidate may have gone stale.
      if (action === "apply" && component === "bsl-ls" && options.version === "latest" &&
          !options.allow_prerelease && selected.prerelease === true) {
        const fetchRelease = io.fetch_json || fetch_json;
        const current = await runtime_release(component, options, {
          fetch_json: url => fetchRelease(url, 30000, { fresh: true }),
        });
        if (current.tag_name !== selected.release)
          throw new ConfigError("Загруженный кандидат не соответствует текущим настройкам версии; перед применением загрузите нового кандидата");
      }
      if ((options.version !== "latest" && options.version.replace(/^v/, "") !== selected.release.replace(/^v/, "")) ||
          (options.version === "latest" && !options.allow_prerelease && selected.prerelease === true &&
            !(component === "bsl-ls" && /^v?1\.1\.0-rc\.\d+$/.test(selected.release))))
        throw new ConfigError("Загруженный кандидат не соответствует текущим настройкам версии; перед применением загрузите нового кандидата");
    }
    const home = path.join(project_home(state, root), "code-index"), maintenance = path.join(home, "maintenance.json");
    if (component === "code-index") await operation_lock(home, () => begin_maintenance(home, root));
    let leaveMaintenance = false;
    try {
    signal_component(state, root, component, true);
    if (component === "code-index") {
      for (let i = 0; i < 12 && (await active_readers(state, root)).length; i++) await sleep(250);
      if ((await active_readers(state, root)).length) throw new ConfigError("Индекс кода используется. Завершите текущие операции или закройте их чаты, затем примените загруженного кандидата.");
      try { await (io.stop || stop_daemon)(state, root); }
      catch (error) { leaveMaintenance = true; throw uncertain_update("Остановка демона не подтверждена; перед повтором проверьте его фактическое состояние: " + safe_error_message(error)); }
    }
    try {
      const checked = await (io.smoke || smoke)(state, config, root, data, component, 90, false, candidate);
      const lock = read_json(lockfile, {});
      lock[component] = { ...entry[slot], ...(entry.release ? { previous: active_entry(entry) } : {}) };
      const restoreConfig = await io.commit?.(entry[slot].release);
      try { save_json(lockfile, lock); }
      catch (error) {
        try { await restoreConfig?.(); }
        catch (restoreError) { throw uncertain_update("Активация компонента не удалась; восстановление настроек требует проверки: " + restoreError.message); }
        throw error;
      }
      let reconnect = "requested";
      try { signal_component(state, root, component, true); }
      catch { reconnect = "open_new_chat"; }
      return { component, state: "applied", release: entry[slot].release, requested: component_settings(config, component).version, protocol: checked.status, indexReady: checked.index_ready ?? null, reconnect };
    } catch (error) {
      if (component === "code-index") {
        try { await (io.stop || stop_daemon)(state, root); }
        catch (stopError) { leaveMaintenance = true; throw uncertain_update("Проверка кандидата не удалась: " + safe_error_message(error) + "; остановка кандидата не подтверждена: " + safe_error_message(stopError)); }
        const old = artifact(state, component);
        if (old) try { await (io.restart || ensure_daemon)(state, root, data, old); }
        catch (restartError) { leaveMaintenance = true; throw uncertain_update("Проверка кандидата не удалась; восстановление требует проверки: " + restartError.message); }
      }
      if (error.outcomeUnknown) throw error;
      throw new ConfigError("Новая версия не прошла проверку; прежний артефакт сохранён: " + safe_error_message(error));
    }
    } finally {
      if (component === "code-index") {
        activeMaintenance.delete(home);
        if (!leaveMaintenance && read_json(maintenance)?.ownerId === runtimeOwner) fs.rmSync(maintenance, { force: true });
      }
    }
  }, 180);
}
export function index_config(home, root, data, health = null) {
  let text = "[daemon]\nhttp_port = 0\nmax_concurrent_initial = 1\n";
  for (const repo of index_repositories(root, data))
    text +=
      "\n[[paths]]\nalias = " +
      JSON.stringify(repo.alias) +
      "\npath = " +
      JSON.stringify(inside(root, repo.path).replaceAll("\\", "/")) +
      '\nlanguage = "bsl"\n';
  const file = path.join(home, "daemon.toml");
  if (exists(file) && fs.readFileSync(file, "utf8") === text) return;
  if (exists(file) && health)
    throw new ConfigError(
      "Состав репозиториев изменился: нажмите «Применить состав проектов» в настройках индекса.",
    );
  atomic_write(file, text);
}
export async function daemon_health(home) {
  const info = read_json(path.join(home, "daemon.json"), {}),
    port = info.http_port;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  try {
    const response = await fetch_json(`http://127.0.0.1:${port}/health`, 2000);
    if (response.pid === info.pid && response.status === "running")
      return response;
  } catch {}
  return null;
}
const pathsMatch = (health, root, data) =>
  stable(
    [
      ...new Set(
        index_repositories(root, data).map((repo) => path_key(inside(root, repo.path))),
      ),
    ].sort(),
  ) ===
  stable(
    [
      ...new Set(
        (health?.paths || [])
          .filter((item) => item?.path)
          .map((item) => path_key(item.path)),
      ),
    ].sort(),
  );
export async function start_daemon(
  home,
  root,
  data,
  exe,
  io = {
    launch: process.platform === "win32" ? spawn_detached_windows : launch,
  },
  environment = native_environment(),
) {
  const health = await daemon_health(home);
  index_config(home, root, data, health);
  if (health) {
    const owner = read_json(path.join(home, "owner.json"), {});
    if (owner.executable !== exe)
      throw new ConfigError(
        "Демон проекта использует другую версию компонента; остановите его до смены версии",
      );
    if (
      !owner.project_root ||
      path_key(owner.project_root) !== path_key(root) ||
      owner.pid !== health.pid
    )
      throw new ConfigError(
        "Владелец демона проекта не совпадает; повторное использование запрещено",
      );
    if (!pathsMatch(health, root, data))
      throw new ConfigError(
        "Пути репозиториев демона проекта не совпадают с выбранным профилем",
      );
    return home;
  }
  const stale = read_json(path.join(home, "daemon.json"), {}),
    owner = read_json(path.join(home, "owner.json"), {});
  if (alive(stale.pid) || alive(owner.pid))
    throw new ConfigError(
      "Демон проекта работает, но не отвечает проверке; перед перезапуском изучите его журналы",
    );
  const proc = io.launch(exe, ["daemon", "run"], {
    cwd: home,
    env: {
      ...environment,
      CODE_INDEX_HOME: home,
      CODE_INDEX_DAEMON_DETACHED: "1",
    },
    detached: true,
    sessionOwned: false,
    // The component owns daemon.log and its size-based rotation. Duplicating
    // stderr into another file would bypass that bound after this chat exits.
    stdio: "ignore",
  });
  try {
    let launchError;
    proc.once("error", (error) => {
      launchError = error;
    });
    proc.unref();
    if (!proc.pid) {
      await sleep(10);
      throw launchError || new Error("Не удалось запустить code-index");
    }
    save_json(path.join(home, "owner.json"), {
      pid: proc.pid,
      executable: exe,
      project_root: root,
    });
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline) {
      const ready = await daemon_health(home);
      if (ready?.pid === proc.pid && pathsMatch(ready, root, data)) return home;
      if (launchError || proc.exitCode !== null || proc.signalCode !== null)
        throw new ConfigError(
          `Демон code-index завершился (${proc.exitCode}); см. ${path.join(home, "daemon.log")}. Если журнала нет, проверьте доступ к каталогу компонента.`,
        );
      await sleep(250);
    }
    throw new ConfigError(
      `Истекло время запуска code-index; проверьте ${home} перед повтором`,
    );
  } finally {
    proc.release?.();
  }
}
export async function ensure_daemon(state, root, data, exe, io, environment) {
  record_project_owner(state, root);
  const home = path.join(project_home(state, root), "code-index");
  return operation_lock(
    home,
    () => { check_maintenance(home, true); return start_daemon(home, root, data, exe, io, environment); },
    45,
  );
}
export function java_info(command = "java", config = null, environment = native_environment(config)) {
  const java = which(command || "java");
  if (!java)
    throw new ConfigError(
      "Требуется Java; укажите mcp.managed.bsl-ls.java в настройках плагина",
    );
  const version = spawnSync(java, ["-version"], {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: 20000,
    env: environment,
  });
  return parse_java_info(java, version);
}
function parse_java_info(java, version) {
  const output = (version.stderr || "") + (version.stdout || "");
  const match = /^(?:java|openjdk) version "([0-9][A-Za-z0-9._+-]{0,127})"/m.exec(output);
  if (version.error || version.status !== 0 || !match) {
    // Java can echo JAVA_TOOL_OPTIONS and arbitrary JVM properties. Never put
    // process output or an untrusted executable's error text into diagnostics.
    const code = typeof version.error?.code === "string" && /^[A-Z0-9_]{1,32}$/.test(version.error.code)
      ? ` (${version.error.code})` : Number.isInteger(version.status) ? ` (exit ${version.status})` : "";
    throw new ConfigError(`Не удалось запустить Java; настройте mcp.managed.bsl-ls.java${code}.`);
  }
  return { path: java, version: match[1] };
}
async function java_info_async(command = "java", config = null) {
  const java = which(command || "java");
  if (!java) throw new ConfigError("Требуется Java; укажите mcp.managed.bsl-ls.java в настройках плагина");
  const version = await new Promise(resolve => execFile(java, ["-version"],
    { encoding: "utf8", windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024, env: native_environment(config) },
    (error, stdout, stderr) => resolve({ error, status: error ? (Number.isInteger(error.code) ? error.code : null) : 0, stdout, stderr })));
  return parse_java_info(java, version);
}
export function java_in_directory(directory, config = null, environment = native_environment(config)) {
  if (!path.isAbsolute(directory) || !is_dir(directory)) throw new ConfigError("Выберите существующий каталог Java.");
  const executable = process.platform === "win32" ? "java.exe" : "java";
  const java = [path.join(directory, "bin", executable), path.join(directory, executable)].find(file => {
    try { return fs.statSync(file).isFile(); } catch { return false; }
  });
  if (!java) throw new ConfigError(`В выбранном каталоге не найден bin/${executable}.`);
  return java_info(java, config, environment);
}
export function java_command(config) {
  return java_info(config.mcp.managed["bsl-ls"].java || "java", config).path;
}
export async function launch_command(
  state,
  config,
  component,
  root,
  data,
  refresh = false,
  selected_artifact = null,
  allow_install = true,
) {
  if (!component_enabled(config, component)) throw new ConfigError("Компонент отключён: " + component);
  if (component === "code-index") {
    if (!index_repositories(root, data).length) throw new ConfigError("В репозиториях профиля не найдены проекты EDT с файлом .project.");
    let exe = selected_artifact || await installed_runtime(state, config, component, refresh, allow_install);
    const oldHome = path.join(project_home(state, root), "code-index"), owner = read_json(path.join(oldHome, "owner.json"), {});
    if (!selected_artifact && await daemon_health(oldHome) && owned_executable(state, owner)) exe = owner.executable;
    const home = await ensure_daemon(state, root, data, exe, undefined, native_environment(config));
    return [
      [exe, "serve", "--config", path.join(home, "daemon.toml")],
      home,
      { ...native_environment(config), CODE_INDEX_HOME: home },
    ];
  }
  const bsl = config.mcp.managed["bsl-ls"],
    node = which(bsl.node || process.execPath);
  if (!node)
    throw new ConfigError(
      "Для адаптера BSL LS MCP требуется Node.js 22+",
    );
  let configuration = bsl.configuration;
  if (configuration) {
    configuration = path.isAbsolute(configuration)
      ? configuration
      : inside(root, configuration);
    if (!is_file(configuration))
      throw new ConfigError("Указанный файл конфигурации BSL LS не существует");
  }
  const java = (await java_info_async(bsl.java || "java", config)).path,
    exe = selected_artifact || await installed_runtime(state, config, component, refresh, allow_install);
  return [
    [
      node,
      path.join(ROOT, "mcp/bsl-ls-proxy.mjs"),
      "--project-root",
      resolve(root),
      "--java",
      java,
      "--jar",
      exe,
      ...(configuration ? ["--configuration", resolve(configuration)] : []),
    ],
    resolve(root),
    native_environment(config),
  ];
}
export function validate_bsl_tools(tools) {
  const required = [
      "register_workspace_folder",
      "list_workspace_folders",
      "unregister_workspace_folder",
    ],
    missing = required.filter(
      (name) => !tools.some((tool) => tool.name === name),
    );
  if (
    !tools.some(
      (tool) =>
        !required.includes(tool.name) &&
        tool.inputSchema?.properties?.workspaceFolder?.type === "string" &&
        tool.inputSchema?.required?.includes("workspaceFolder"),
    )
  )
    missing.push("инструмент анализа с параметром workspaceFolder");
  if (missing.length)
    throw new ConfigError(
      "В BSL LS отсутствует собственный API нескольких рабочих областей: " +
        missing.join(", ") +
        ". В настройках компонента выберите и установите явную версию с этим API. " +
        "Внешний сервер должен предоставлять регистрацию рабочих областей и параметры workspaceFolder.",
    );
}
export function index_readiness(body, root, data, selection = index_selection(root, data)) {
  const { repositories, missingProjects } = selection;
  if (
    !body?.mcp ||
    !body?.daemon ||
    !Array.isArray(body.repos) ||
    !repositories.length || missingProjects.length || body.repos.length !== repositories.length
  )
    return false;
  const expected = new Map(
      repositories.map((repo) => [
        repo.alias,
        path_key(inside(root, repo.path)),
      ]),
    ),
    seen = new Set();
  for (const repo of body.repos) {
    if (
      !repo ||
      typeof repo.repo !== "string" ||
      !expected.has(repo.repo) ||
      seen.has(repo.repo) ||
      typeof repo.root_path !== "string" ||
      !repo.root_path ||
      path_key(repo.root_path) !== expected.get(repo.repo) ||
      repo.path_status?.status !== "ready" ||
      repo.path_status.error ||
      repo.data_version?.stale !== false
    )
      return false;
    if (
      repo.path_status.path &&
      path_key(repo.path_status.path) !== expected.get(repo.repo)
    )
      return false;
    seen.add(repo.repo);
  }
  return (
    seen.size === expected.size &&
    body.mcp.status === "ok" &&
    body.daemon.status === "online"
  );
}
export function index_status(body, root, data) {
  const selection = index_selection(root, data), indexed = selection.repositories;
  const repositories = indexed.map(repo => {
    const directory = inside(root, repo.path), item = body?.repos?.find(item => item.repo === repo.alias);
    const present = is_file(path.join(directory, ".code-index/index.db"));
    let state = "not_checked";
    if (!item || !item.root_path || path_key(item.root_path) !== path_key(directory)) state = "mismatch";
    else if (item.path_status?.error || item.path_status?.status === "error") state = "error";
    else if (item.data_version?.stale === true) state = "stale";
    else if (["indexing", "initializing", "initial_indexing", "pending", "reindexing", "reindexing_batch", "reindexing_extras"].includes(item.path_status?.status)) state = "indexing";
    else if (item.path_status?.status === "ready" && item.data_version?.stale === false) state = "ready";
    else if (!present) state = "missing";
    return { id: repo.id, edtProject: repo.edt_project, alias: repo.alias, present, state };
  });
  const ready = index_readiness(body, root, data, selection);
  const missingProjects = selection.missingProjects;
  const state = ready ? "ready" : missingProjects.length ? "missing_project" : ["mismatch", "error", "stale", "indexing", "missing"].find(state => repositories.some(repo => repo.state === state)) || "not_checked";
  const retryable = state === "not_checked" && body?.mcp?.status === "ok" && body?.daemon?.status === "online" &&
    body?.repos?.length === indexed.length && repositories.length > 0 &&
    repositories.every(repo => repo.present && ["ready", "not_checked"].includes(repo.state)) && repositories.some(repo => repo.state === "not_checked");
  return { ready, state, repositories, ...(missingProjects.length ? { missingProjects } : {}), ...(retryable ? { retryable: true } : {}) };
}

// The native CLI is the writer. Stop only the owned project daemon and never
// delete databases or use a shell command to rebuild a selected repository.
export async function rebuild_index(state, config, root, data, repositoryId, io = {}) {
  const repo = index_repositories(root, data).find(repo => repo.id === repositoryId);
  if (!repo) throw new ConfigError("Выберите EDT-проект из профиля.");
  return maintain_index(state, config, root, data, [repo], io);
}
export async function rebuild_all_indexes(state, config, root, data, io = {}) {
  const repositories = index_repositories(root, data);
  if (!repositories.length) throw new ConfigError("В репозиториях профиля не найдены проекты EDT с файлом .project.");
  return { ...await maintain_index(state, config, root, data, repositories, io), all: true };
}
export async function restart_index(state, config, root, data, io = {}) {
  if (!index_repositories(root, data).length) throw new ConfigError("В репозиториях профиля не найдены проекты EDT с файлом .project.");
  return maintain_index(state, config, root, data, [], io);
}
async function maintain_index(state, config, root, data, repositories, io) {
  if (!component_enabled(config, "code-index") || component_settings(config, "code-index").mode === "external")
    throw new ConfigError("Действие доступно для управляемого индекса кода.");
  let completed = 0, current = null;
  const progress = phase => {
    // Losing an observer must never interrupt the index writer or its cleanup.
    try { io.progress?.({ phase, total: repositories.length, completed, ...(current ? { repository: current.id, edtProject: current.edt_project } : {}) }); } catch {}
  };
  progress("preparing");
  const home = path.join(project_home(state, root), "code-index"), maintenance = path.join(home, "maintenance.json");
  const exe = await (io.installed || installed_runtime)(state, config, "code-index");
  progress("waiting_lock");
  return operation_lock(state, async () => {
    if (!io.installed && artifact(state, "code-index") !== exe) throw new ConfigError("Версия индексатора изменилась. Повторите действие после завершения обновления.");
    await operation_lock(home, () => begin_maintenance(home, root));
    let keepMaintenance = false, stopped = false;
    try {
      signal_component(state, root, "code-index", true);
      progress("waiting_readers");
      for (let i = 0; i < 12 && (await active_readers(state, root)).length; i++) await sleep(250);
      if ((await active_readers(state, root)).length) throw new ConfigError("Индекс используется. Завершите текущие запросы и повторите действие.");
      const environment = native_environment(config);
      progress("stopping");
      try { await (io.stop || stop_daemon)(state, root, undefined, environment); stopped = true; }
      catch (error) { keepMaintenance = true; throw uncertain_update("Остановка индекса не подтверждена: " + safe_error_message(error)); }
      for (const repo of repositories) {
        current = repo; progress("indexing");
        try { await (io.run || run_index)(exe, inside(root, repo.path), home, environment, state); completed++; }
        catch (error) { if (error.outcomeUnknown) keepMaintenance = true; throw error; }
      }
      current = null; progress("restarting");
      await (io.restart || ensure_daemon)(state, root, data, exe, undefined, environment); stopped = false;
      progress("checking");
      const checked = await (io.smoke || smoke)(state, config, root, data, "code-index", 90, false, exe);
      return { projectRoot: root, ...(repositories.length === 1 ? { repository: repositories[0].id, edtProject: repositories[0].edt_project } : {}),
        ...(repositories.length ? { rebuilt: repositories.map(repo => ({ repository: repo.id, edtProject: repo.edt_project })) } : {}),
        state: checked.index_state || (checked.index_ready ? "ready" : "not_checked"), index: checked.index };
    } finally {
      try {
        if (stopped && !keepMaintenance) try { progress("restoring"); await (io.restart || ensure_daemon)(state, root, data, exe, undefined, native_environment(config)); }
        catch (error) { keepMaintenance = true; throw uncertain_update("Восстановление сервиса индекса требует проверки: " + safe_error_message(error)); }
        if (!keepMaintenance && read_json(maintenance)?.ownerId === runtimeOwner) fs.rmSync(maintenance, { force: true });
        signal_component(state, root, "code-index", true);
      } finally { activeMaintenance.delete(home); }
    }
  }, 180);
}
async function run_index(exe, directory, home, environment, state) {
  // Unlike daemon run, the one-shot CLI only logs to stderr. Persist it once
  // through the existing bounded diagnostic journal, not a separate rebuild.log.
  const diagnostic = create_diagnostic_logger("code-index", state);
  let child;
  try {
    child = launch(exe, ["index", directory, "--force"], { cwd: directory, env: { ...environment, CODE_INDEX_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
    for (const [stream, level] of [[child.stdout, "info"], [child.stderr, "warning"]])
      stream.on("data", chunk => diagnostic.event("index_output", { projectRoot: directory, message: String(chunk) }, level));
    await new Promise((done, reject) => { child.once("error", reject); child.once("close", code => code === 0 ? done() : reject(new ConfigError("Пересоздание индекса завершилось с ошибкой; см. журнал поддержки компонента code-index (код " + code + ")."))); });
  } finally {
    if (child) await stop_child(child, 0);
  }
}
async function probe_client(client, component, root, data) {
  const server = await client.initialize(),
    tools = (await all_pages(client, "tools/list", "tools")).tools;
  if (!tools.length)
    throw new ConfigError(component + " не предоставляет инструментов MCP");
  if (component === "bsl-ls") validate_bsl_tools(tools);
  const result = {
    component,
    status: "mcp_ready",
    server: server.serverInfo,
    tools: tools.map((tool) => tool.name),
  };
  if (component === "code-index") {
    const deadline = Date.now() + 4000;
    do {
      const health = await client.request("tools/call", { name: "health", arguments: {} });
      if (health.isError) throw Object.assign(new ConfigError("Проверка состояния code-index не удалась; текст внешней ошибки скрыт"), { remote: true });
      const body = health.structuredContent || JSON.parse(health.content.find(part => part.type === "text").text);
      result.index = index_status(body, root, data);
      if ((result.index.state !== "indexing" && !result.index.retryable) || !result.index.repositories.every(repo => repo.present) || Date.now() >= deadline) break;
      await sleep(250);
    } while (true);
    result.index_ready = result.index.ready;
    result.index_state = result.index.state;
    result.readiness_scope =
      "Проверены пути репозиториев и актуальность данных; проверяйте покрытие конкретной операции в каждом ответе";
  }
  return result;
}

async function bounded_probe_client(client, component, root, data, timeoutMs) {
  let timer, closing, expired = false;
  const guard = {
    initialize: (...args) => { if (expired) throw new ConfigError("Истекло общее время проверки компонента"); return client.initialize(...args); },
    request: (...args) => { if (expired) throw new ConfigError("Истекло общее время проверки компонента"); return client.request(...args); },
  };
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => {
    expired = true; closing = client.close().catch(() => {});
    reject(new ConfigError("Истекло общее время проверки компонента"));
  }, timeoutMs); });
  try { return await Promise.race([probe_client(guard, component, root, data), deadline]); }
  finally { clearTimeout(timer); await closing; }
}

// Observe only the existing daemon through its immutable read-only client.
// Do not use launch_command: it can prepare config and start a stopped daemon.
export async function observe_index(state, config, root, data) {
  require_preparation(state, root, "code-index");
  const lease = await acquire_reader(state, root);
  let client;
  try {
    const home = path.join(project_home(state, root), "code-index"), health = await daemon_health(home);
    if (!health) return null;
    const owner = read_json(path.join(home, "owner.json"), {});
    if (!owner.project_root || path_key(owner.project_root) !== path_key(root) || owner.pid !== health.pid)
      throw new ConfigError("Владелец демона проекта не совпадает; повторное использование запрещено");
    if (!owned_executable(state, owner))
      throw new ConfigError("Не удалось подтвердить исполняемый файл работающего демона индекса.");
    if (!pathsMatch(health, root, data))
      throw new ConfigError("Пути репозиториев демона проекта не совпадают с выбранным профилем");
    const options = component_settings(config, "code-index");
    client = new McpClient([owner.executable, "serve", "--config", path.join(home, "daemon.toml")], home,
      { ...native_environment(config), CODE_INDEX_HOME: home }, options.timeout_seconds || 30, { maxBytes: options.max_response_bytes });
    return await bounded_probe_client(client, "code-index", root, data, Math.min(options.timeout_seconds || 30, 25) * 1000);
  } finally {
    try { await client?.close(); } finally { await lease.close(); }
  }
}

export async function smoke(
  state,
  config,
  root,
  data,
  component,
  timeout = 90,
  refresh = false,
  selected_artifact = null,
  allow_install = true,
  max_probe_seconds = null,
) {
  const options = component_settings(config, component);
  if (!component_enabled(config, component)) return { component, status: "disabled" };
  const lease = component === "code-index" && options.mode !== "external" && !selected_artifact ? await acquire_reader(state, root) : null;
  let client;
  try {
  if (options.mode === "external") {
    if (!options.url) throw new ConfigError("Укажите внешний адрес подключения для " + component);
    client = new RemoteMcp(options.url, options.timeout_seconds || timeout, { headers_env: options.headers_env, maxBytes: options.max_response_bytes });
  } else {
    const [command, cwd, env] = await launch_command(
      state,
      config,
      component,
      root,
      data,
      refresh,
      selected_artifact,
      allow_install,
    );
    client = new McpClient(command, cwd, env, options.timeout_seconds || timeout, { maxBytes: options.max_response_bytes });
  }
  try {
    return max_probe_seconds ? await bounded_probe_client(client, component, root, data, Math.min(options.timeout_seconds || timeout, max_probe_seconds) * 1000) : await probe_client(client, component, root, data);
  } finally {
    await client.close();
  }
  } finally {
    if (lease) await lease.close();
  }
}
export async function stop_daemon(state, root, io = { stop: run_sync }, environment = native_environment()) {
  const home = path.join(project_home(state, root), "code-index");
  await operation_lock(
    home,
    async () => {
      const owner = read_json(path.join(home, "owner.json"), {}),
        health = await daemon_health(home);
      if (!health) {
        if (
          alive(owner.pid) ||
          alive(read_json(path.join(home, "daemon.json"), {}).pid)
        )
          throw new ConfigError(
            "Демон не отвечает проверке состояния; остановка не подтверждена",
          );
        return;
      }
      if (
        health.pid !== owner.pid ||
        !owner.project_root ||
        path_key(owner.project_root) !== path_key(root) ||
        !owned_executable(state, owner)
      )
        throw new ConfigError("Владелец демона не совпадает; остановка запрещена");
      await io.stop(owner.executable, ["daemon", "stop"], {
        cwd: home,
        env: { ...environment, CODE_INDEX_HOME: home },
        timeout: 20000,
      });
      for (let i = 0; i < 40; i++) {
        if (!(await daemon_health(home)) && !alive(owner.pid)) return;
        await sleep(250);
      }
      throw new ConfigError("Остановка демона не подтверждена");
    },
    45,
  );
}
export async function main() {
  const a = argumentsOf(
      undefined,
      ["refresh"],
      ["state_dir", "settings", "project_root", "output"],
    ),
    [action, component = "all"] = a._,
    config = settings(a.settings),
    state = state_path(config, a.state_dir),
    components = component === "all" ? Object.keys(SPECS) : [component];
  if (
    !["install", "status", "start", "stop", "smoke", "config"].includes(
      action,
    ) ||
    components.some((name) => !Object.hasOwn(SPECS, name))
  )
    throw new ConfigError("Неизвестное действие или компонент окружения");
  let result;
  if (action === "install")
    result = await operation_lock(state, async () => {
      const result = {};
      for (const c of components)
        result[c] = !component_enabled(config, c) ? { status: "disabled" }
          : component_settings(config, c).mode === "external" ? { status: "external" }
            : await ensure_installed(state, config, c, a.refresh);
      return result;
    });
  else if (action === "status") {
    result = {
      artifacts: Object.fromEntries(
        components.map((c) => [c, artifact(state, c)]),
      ),
      runtime_lock: read_json(path.join(state, "runtime-lock.json"), {}),
    };
    if (a.project_root)
      result.daemon = await daemon_health(
        path.join(project_home(state, a.project_root), "code-index"),
      );
  } else if (action === "stop") {
    if (component === "bsl-ls") throw new ConfigError("BSL LS принадлежит своему клиенту stdio и завершается при отключении");
    const selected = a.project_root || process.env.EDT_AI_PROJECT_ROOT || config.active_project;
    if (!selected) throw new ConfigError("Выберите корень проекта, демон которого нужно остановить");
    const root = configuration_root(selected);
    // Stopping an owned daemon must still work after its profile is removed or
    // damaged. With no reliable credential names, inherit no caller variables.
    let environment = {};
    try { environment = native_environment(effective_settings(config, root, project_profile(root), null, state)); }
    catch { /* The stop operation checks daemon ownership independently. */ }
    await stop_daemon(state, root, undefined, environment);
    result = { status: "stopped", project_root: root };
  } else {
    const [root, data] = project(a.project_root, config, false),
      effective = effective_settings(config, root, data, null, state);
    if (action === "smoke") {
      result = [];
      for (const c of components)
        result.push(await smoke(state, effective, root, data, c));
    } else if (action === "start") {
      if (component === "all") throw new ConfigError("Выберите компонент");
      if (!component_enabled(effective, component)) throw new ConfigError("Компонент отключён: " + component);
      if (component_settings(effective, component).mode === "external") throw new ConfigError("Внешние компоненты запускает пользователь; используйте smoke для проверки подключения");
      grant_preparation(state, root, [component]);
      if (component === "bsl-ls")
        return (await import("./managed_mcp.mjs")).serve(
          component,
          root,
          state,
          effective,
        );
      project(root, effective); // code-index startup requires explicit mappings.
      const exe = await installed_runtime(state, effective, component),
        home = await ensure_daemon(state, root, data, exe, undefined, native_environment(effective));
      result = { status: "running", daemon: await daemon_health(home) };
    } else {
      if (!a.output) throw new ConfigError("Для config требуется --output");
      const servers = {
        policy: (await import("./policy_runtime.mjs")).binding(effective),
      };
      for (const c of Object.keys(COMPONENTS).filter(id => component_enabled(effective, id)))
        servers[c] = {
          type: "stdio",
          command: process.execPath,
          args: COMPONENTS[c].adapter ? [path.join(ROOT, COMPONENTS[c].adapter)] : [
            path.join(ROOT, "scripts/lazy_mcp.mjs"),
            "--component",
            c,
          ],
          cwd: root,
          env: { EDT_AI_PROJECT_ROOT: root, EDT_AI_STATE_DIR: state,
            EDT_AI_SETTINGS: resolve(a.settings || process.env.EDT_AI_SETTINGS || path.join(ROOT, "settings/local.yaml")) },
        };
      save_json(a.output, {
        mcpServers: servers,
      });
      result = { status: "written", path: resolve(a.output) };
    }
  }
  console.log(JSON.stringify(result, null, 2));
}
if (entrypoint(import.meta.url)) await cli(main);
