import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  ROOT,
  ConfigError,
  barrier_recovery_hint,
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
  parse,
  load,
  deep_merge,
  validate_settings,
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
  instance_name,
  instance_directory,
  reconnect_file,
  record_project_owner,
  configuration_root,
} from "./project_paths.mjs";
import { project_profile, merged_profile } from "./profile.mjs";
import { effective_settings, external_override_files } from "./project_context.mjs";
import { safe_error_message, create_diagnostic_logger } from "./diagnostics.mjs";
import { launch, stop_child, alive, which, require_protected_process_support, spawn_guarded_linux } from "./processes.mjs";
import { extract_binary, zip_entries } from "./archives.mjs";
import { McpClient } from "./mcp_client.mjs";
import { all_pages } from "./mcp_pages.mjs";
import { COMPONENTS, managed_components, component_enabled, component_settings, grant_preparation, preparation_granted, require_preparation, native_environment } from "./components.mjs";
import { RemoteMcp } from "./remote_client.mjs";
import { core_version } from "./compatibility.mjs";
import { spawn_detached_windows, windows_process_identity, windows_process_session, windows_reader_job_absent, windows_tcp_rows, pin_windows_process, pin_windows_readonly_file, windows_has_tcp_peer } from "./windows_process.mjs";
import { index_repositories, index_selection } from "./directory_context.mjs";
import { capture_index_snapshot, snapshot_bytes } from "./index_snapshot.mjs";
import { open_reader, reader_active, observe_reader } from "./reader_lease.mjs";
import { darwin_process_identity, darwin_process_executable, darwin_has_loopback_listener, linux_has_loopback_listener, pin_linux_process, linux_has_tcp_peer, linux_process_identity, linux_read_daemon_lease, linux_retain_daemon_barrier } from "./unix_process.mjs";
import { read_regular_file, hash_regular_file } from "./bounded_file.mjs";
import { private_observation_directory } from "./openviking_store.mjs";

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
export const sha = (file) => hash_regular_file(file, 512 * 1024 * 1024);
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
export function artifact(state, component, slot = "active", { verify = true } = {}) {
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
  return is_file(target) && (!verify || sha(target) === entry.sha256) ? target : null;
}
export function installed_versions(state, root = null, { verify = true } = {}) {
  let lock;
  try { lock = read_json(path.join(state, "runtime-lock.json"), {}); }
  catch { lock = {}; }
  return Object.fromEntries(managed_components.map(component => {
    try {
      const active = artifact(state, component, "active", { verify });
      if (verify && component === "code-index" && root) {
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
async function active_readers_locked(state, root) {
  const directory = path.join(project_home(state, root), "code-index/readers");
  const active = [];
  if (!exists(directory)) return active;
  const names = fs.readdirSync(directory).filter(file => file.endsWith(".json"));
  if (names.length > 1024) throw new ConfigError("Слишком много записей читателей индекса; обслуживание заблокировано.");
  const deadline = performance.now() + 3000; let index = 0;
  const worker = async () => { while (index < names.length) {
    if (performance.now() >= deadline) throw new ConfigError("Не удалось вовремя подтвердить владельцев читателей индекса.");
    const name = names[index++];
    const file = path.join(directory, name);
    let reader;
    try { const value = read_regular_file(file, 64 * 1024); if (!value) continue; reader = JSON.parse(value.bytes.toString("utf8")); }
    catch { throw new ConfigError("Неподдерживаемая запись читателя индекса; обслуживание заблокировано. " + barrier_recovery_hint(file)); }
    if (!reader || typeof reader !== "object" || Array.isArray(reader) ||
        typeof reader.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(reader.id) || name !== reader.id + ".json" ||
        reader.root !== resolve(root) || !Number.isSafeInteger(reader.pid) || reader.pid <= 0 ||
        reader.phase !== undefined && !["preparing", "active", "closing"].includes(reader.phase) ||
        ["active", "closing"].includes(reader.phase) && reader.orphanedBarrier !== true ||
        reader.snapshotMayExist !== undefined && (typeof reader.snapshotMayExist !== "boolean" ||
          typeof reader.observerBinding !== "string" || !/^[a-f0-9]{64}$/.test(reader.observerBinding)) ||
        reader.recovery !== undefined && (!reader.recovery || typeof reader.recovery !== "object" || Array.isArray(reader.recovery) ||
          Object.keys(reader.recovery).sort().join(",") !== "creation,kind,session" || reader.recovery.kind !== "windows-observer-job-v1" ||
          !Number.isSafeInteger(reader.recovery.session) || reader.recovery.session < 0 ||
          typeof reader.recovery.creation !== "string" || !/^win32-filetime:\d+$/.test(reader.recovery.creation) ||
          typeof reader.observerBinding !== "string" || !/^[a-f0-9]{64}$/.test(reader.observerBinding)))
      throw new ConfigError("Неподдерживаемая запись читателя индекса; обслуживание заблокировано. " + barrier_recovery_hint(file));
    if (await reader_active(reader.id, { timeoutMs: Math.max(1, Math.min(2000, deadline - performance.now())) })) active.push(reader);
    // An observation may have spawned a supervised native reader. Loss of the
    // backend's socket alone does not prove that child tree has terminated.
    else if (reader.phase !== "preparing" || reader.orphanedBarrier === true ||
        Object.hasOwn(reader, "observerBinding") && reader.snapshotMayExist !== false) {
      let recovered = false;
      // The v1 marker is used only when every process of the observation,
      // including the copy worker, uses this one named Windows Job. The owner
      // must be gone and the Job must be absent in its original session. A
      // missing endpoint, PID alone, timeout, foreign session, or unknown Job
      // is never evidence of cleanup; old markers retain their barrier.
      // An absent Job says nothing about snapshot files. Only a marker which
      // explicitly predates snapshot creation can be recovered this way; old
      // markers and interruptions during or after creation remain barriers.
      if (process.platform === "win32" && reader.phase === "active" && reader.recovery?.kind === "windows-observer-job-v1" &&
          reader.snapshotMayExist === false) try {
        const current = windows_process_identity(reader.pid);
        recovered = windows_process_session(process.pid) === reader.recovery.session &&
          (!current || current.created !== reader.recovery.creation) && windows_reader_job_absent(reader.id);
      } catch { /* Preserve the marker whenever the kernel cannot confirm it. */ }
      if (recovered) fs.rmSync(file, { force: true });
      else active.push({ ...reader, orphaned: true });
    }
    else fs.rmSync(file, { force: true });
  } };
  const results = await Promise.allSettled(Array.from({ length: Math.min(8, names.length) }, worker));
  const failed = results.find(result => result.status === "rejected");
  if (failed) throw failed.reason;
  return active;
}
export async function active_readers(state, root) {
  const home = path.join(project_home(state, root), "code-index");
  if (!exists(path.join(home, "readers"))) return [];
  return operation_lock(home, () => active_readers_locked(state, root), 10);
}
async function wait_for_readers(state, root, timeoutMs = 6000) {
  const deadline = performance.now() + timeoutMs;
  while (true) {
    const readers = await active_readers(state, root);
    if (!readers.length || readers.some(reader => reader.orphaned) || performance.now() >= deadline) return readers;
    await sleep(Math.min(250, Math.max(1, deadline - performance.now())));
  }
}
function orphaned_reader_message(home, reader) {
  return "Не подтверждено завершение читателя индекса после аварии. Обслуживание заблокировано до проверки процесса. " +
    barrier_recovery_hint(path.join(home, "readers", reader.id + ".json"));
}
function check_maintenance(home, allowOwned = false) {
  const guard = path.join(home, "guard-cleanup-unknown.json");
  try {
    fs.lstatSync(guard);
    throw new ConfigError("Не подтверждено завершение дерева демона индекса. " + barrier_recovery_hint(guard));
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const file = path.join(home, "maintenance.json");
  let entry;
  try { entry = fs.lstatSync(file); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (!entry.isFile() || entry.isSymbolicLink())
    throw new ConfigError("Повреждён барьер обслуживания индекса. " + barrier_recovery_hint(file));
  let record;
  if (allowOwned && activeMaintenance.has(home)) {
    try { record = read_json(file); } catch { /* An unreadable marker remains a barrier. */ }
  }
  if (!allowOwned || !activeMaintenance.has(home) || record?.pid !== process.pid || record?.ownerId !== runtimeOwner)
    throw new ConfigError("Обновление компонента выполняется или было прервано; проверьте settings.operation до подключения читателей. " + barrier_recovery_hint(file));
}
function check_index_observation(home) {
  check_maintenance(home);
  const lock = path.join(home, "operation.lock");
  try { fs.lstatSync(lock); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  throw Object.assign(new ConfigError("Операция индекса ещё выполняется или её завершение не подтверждено. " + barrier_recovery_hint(lock)), { code: "INDEX_BUSY" });
}
async function wait_index_observation(home) {
  const deadline = performance.now() + 1000;
  while (true) {
    try { check_index_observation(home); return; }
    catch (error) { if (error.code !== "INDEX_BUSY" || performance.now() >= deadline) throw error; }
    await sleep(25);
  }
}
function begin_maintenance(home, root) {
  check_maintenance(home);
  save_json(path.join(home, "maintenance.json"), { pid: process.pid, root: resolve(root), ownerId: runtimeOwner });
  activeMaintenance.add(home);
}
export async function acquire_reader(state, root, { preparing = true, observerBinding = null, observe = null } = {}) {
  record_project_owner(state, root);
  const home = path.join(project_home(state, root), "code-index");
  return operation_lock(home, async () => {
    check_maintenance(home);
    const readers = await active_readers_locked(state, root);
    const orphaned = readers.find(reader => reader.orphaned);
    if (orphaned)
      throw new ConfigError("Не подтверждено завершение предыдущего читателя индекса. Новое подключение заблокировано. " + barrier_recovery_hint(path.join(home, "readers", orphaned.id + ".json")));
    const existing = observerBinding && readers.find(reader => reader.observerBinding === observerBinding && reader.instance === instance_name());
    if (existing) return existing.phase === "closing" ? { closing: existing.id } : { joined: existing.id };
    let recovery;
    if (observerBinding && process.platform === "win32") {
      const identity = windows_process_identity(process.pid);
      if (!identity?.created) throw new ConfigError("Не удалось подтвердить владельца наблюдателя индекса.");
      recovery = { kind: "windows-observer-job-v1", session: windows_process_session(process.pid), creation: identity.created };
    }
    const id = randomUUID(), file = path.join(home, "readers", id + ".json"), owner = await open_reader(id, { binding: observerBinding, observe });
    let record = { id, pid: process.pid, root: resolve(root), ...(preparing ? { phase: "preparing" } : {}),
      ...(observerBinding ? { observerBinding, instance: instance_name(), snapshotMayExist: false } : {}), ...(recovery ? { recovery } : {}) };
    try { save_json(file, record); }
    catch (error) { await owner.close(); throw error; }
    let closing;
    const ensureAvailable = async () => {
      if (closing) throw new ConfigError("Читатель индекса уже закрывается.");
      check_maintenance(home);
      const orphaned = (await active_readers_locked(state, root)).find(reader => reader.orphaned);
      if (orphaned)
        throw new ConfigError("Не подтверждено завершение предыдущего читателя индекса. Новое наблюдение заблокировано. " + barrier_recovery_hint(path.join(home, "readers", orphaned.id + ".json")));
    };
    return { id, file, assertAvailable: () => operation_lock(home, ensureAvailable, 45), arm: ({ snapshotMayExist = false } = {}) => operation_lock(home, async () => {
      if (typeof snapshotMayExist !== "boolean") throw new ConfigError("Некорректное состояние снимка читателя индекса.");
      await ensureAvailable();
      const next = { ...record, phase: "active", orphanedBarrier: true,
        ...(observerBinding ? { snapshotMayExist: record.snapshotMayExist || snapshotMayExist } : {}) };
      save_json(file, next);
      record = next;
    }, 45), markClosing: () => operation_lock(home, () => {
      save_json(file, { ...record, phase: "closing", orphanedBarrier: true });
    }, 10), close: () => closing ||= (async () => {
      // Keep the barrier until both the native tree and its lease endpoint
      // have been closed. A failed endpoint cleanup must remain observable.
      await operation_lock(home, async () => {
        await owner.close();
        fs.rmSync(file, { force: true });
      }, 10);
    })(), abandon: () => closing ||= owner.close() };
  }, 45);
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
    require_protected_process_support();
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
      const readers = await wait_for_readers(state, root);
      const orphaned = readers.find(reader => reader.orphaned);
      if (readers.length) throw new ConfigError(orphaned ? orphaned_reader_message(home, orphaned) : "Индекс кода используется. Завершите текущие операции или закройте их чаты, затем примените загруженного кандидата.");
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
        if (error.outcomeUnknown) { leaveMaintenance = true; throw error; }
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
export function index_config_text(root, data, selection = null) {
  let text = "[daemon]\nhttp_port = 0\nmax_concurrent_initial = 1\n";
  for (const repo of selection?.repositories || index_repositories(root, data))
    text +=
      "\n[[paths]]\nalias = " +
      JSON.stringify(repo.alias) +
      "\npath = " +
      JSON.stringify((selection?.canonicalPaths?.[repo.id] || inside(root, repo.path)).replaceAll("\\", "/")) +
      '\nlanguage = "bsl"\n';
  return text;
}
export function index_config(home, root, data, health = null) {
  const text = index_config_text(root, data);
  const file = path.join(home, "daemon.toml");
  const configured = exists(file);
  if (configured && fs.readFileSync(file, "utf8") === text) return;
  if (health)
    throw new ConfigError(
      configured ? "Состав репозиториев изменился: нажмите «Применить состав проектов» в настройках индекса." :
        "Файл daemon.toml работающего индекса отсутствует. Проверьте состояние индекса перед восстановлением конфигурации.",
    );
  atomic_write(file, text);
}
export async function daemon_health(home, snapshot = null) {
  const bytes = snapshot ? snapshot_bytes(snapshot, "daemon.json") : null;
  const info = snapshot ? bytes ? JSON.parse(bytes.toString("utf8")) : {} : read_json(path.join(home, "daemon.json"), {}),
    port = info.http_port;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  try {
    const response = await fetch_json(`http://127.0.0.1:${port}/health`, 2000);
    if (response.pid === info.pid && response.status === "running")
      return response;
  } catch {}
  return null;
}
const canonical_key = file => process.platform === "win32" ? path.normalize(file).replace(/^\\\\\?\\/, "").toLowerCase() : path.normalize(file);
const pathsMatch = (health, root, data, selection = null) =>
  stable(
    [
      ...new Set(
        (selection?.repositories || index_repositories(root, data)).map((repo) => selection ? canonical_key(selection.canonicalPaths[repo.id]) : path_key(inside(root, repo.path))),
      ),
    ].sort(),
  ) ===
  stable(
    [
      ...new Set(
        (health?.paths || [])
          .filter((item) => item?.path)
          .map((item) => selection ? canonical_key(item.path) : path_key(item.path)),
      ),
    ].sort(),
  );
export async function start_daemon(
  home,
  root,
  data,
  exe,
  io = {
    launch: process.platform === "win32" ? spawn_detached_windows : process.platform === "linux" ? spawn_guarded_linux : launch,
  },
  environment = native_environment(),
  beforeStart = null,
) {
  const health = await daemon_health(home);
  let lifecycle = null;
  if (process.platform === "linux") {
    try { lifecycle = linux_read_daemon_lease(home); }
    catch { throw new ConfigError("Не удалось проверить запись наблюдателя демона. " + barrier_recovery_hint(path.join(home, "guard-lifecycle.json"))); }
  }
  if (!health) {
    // The public runtime CLI can reach this path without going through smoke.
    // Do not start an uncontained local daemon on macOS.
    if (process.platform === "darwin") require_protected_process_support();
    const stale = read_json(path.join(home, "daemon.json"), {}), owner = read_json(path.join(home, "owner.json"), {});
    if (process.platform === "linux" && owner.guardId && (!lifecycle || lifecycle.id !== owner.guardId))
      throw uncertain_update("Не подтверждена запись предыдущих наблюдателей демона. " + barrier_recovery_hint(path.join(home, "guard-lifecycle.json")));
    if (alive(stale.pid) || alive(owner.pid))
      throw new ConfigError("Демон проекта работает либо его старый PID занят, но health не подтверждён; перезапуск запрещён. Записи: " + path.join(home, "owner.json") + ", " + path.join(home, "daemon.json") + ". " + barrier_recovery_hint(path.join(home, "daemon.json")));
    if (lifecycle?.state === "active") throw new ConfigError("Не подтверждено завершение предыдущего дерева демона. " + barrier_recovery_hint(path.join(home, "guard-lifecycle.json")));
    if (beforeStart) await beforeStart();
  }
  index_config(home, root, data, health);
  if (health) {
    const owner = read_json(path.join(home, "owner.json"), {});
    if (process.platform === "linux" && owner.guardId && (lifecycle?.id !== owner.guardId || lifecycle.state !== "active"))
      throw uncertain_update("Не подтверждена запись наблюдателей работающего демона. " + barrier_recovery_hint(path.join(home, "guard-lifecycle.json")));
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
    const daemon = read_json(path.join(home, "daemon.json"), {});
    const identity = daemon_owner_identity(owner, daemon);
    if (!identity || daemon.http_host !== "127.0.0.1" || owner.creation && identity !== owner.creation ||
        owner.daemon_started_at && daemon.started_at !== owner.daemon_started_at || owner.health_started_at && health.started_at !== owner.health_started_at)
      throw new ConfigError("Не подтверждена идентичность работающего демона индекса; повторное использование запрещено.");
    if (!pathsMatch(health, root, data))
      throw new ConfigError(
        "Пути репозиториев демона проекта не совпадают с выбранным профилем",
      );
    return home;
  }
  const proc = await io.launch(exe, ["daemon", "run"], {
    cwd: home,
    env: {
      ...environment,
      CODE_INDEX_HOME: home,
      CODE_INDEX_DAEMON_DETACHED: "1",
    },
    detached: true,
    sessionOwned: false,
    ...(process.platform === "win32" ? { guardUntilCommit: true } : {}),
    // The component owns daemon.log and its size-based rotation. Duplicating
    // stderr into another file would bypass that bound after this chat exits.
    stdio: "ignore",
  });
  const diagnostic = environment.EDT_AI_STATE_DIR ? create_diagnostic_logger("index-daemon", environment.EDT_AI_STATE_DIR) : null;
  diagnostic?.event("daemon_starting", { projectRoot: root, pid: proc.pid, guardPid: proc.guardPid, workerPid: proc.workerPid });
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
    const owner = {
      pid: proc.pid,
      executable: exe,
      project_root: root,
      creation: daemon_process_identity(proc.pid),
    };
    if (!owner.creation) throw uncertain_update("Не удалось зафиксировать идентичность запущенного демона индекса.");
    if (process.platform === "linux" && proc.guardPid && proc.workerPid) {
      const guardCreation = daemon_process_identity(proc.guardPid), workerCreation = daemon_process_identity(proc.workerPid);
      if (!guardCreation || !workerCreation) throw uncertain_update("Не удалось зафиксировать идентичность наблюдателей демона индекса.");
      owner.guardId = proc.guardId;
      owner.guards = [{ pid: proc.guardPid, creation: guardCreation }, { pid: proc.workerPid, creation: workerCreation }];
    }
    save_json(path.join(home, "owner.json"), owner);
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline) {
      const ready = await daemon_health(home);
      if (ready?.pid === proc.pid && pathsMatch(ready, root, data)) {
        const daemon = read_json(path.join(home, "daemon.json"), {});
        if (daemon.http_host !== "127.0.0.1" || typeof daemon.started_at !== "string" || !daemon.started_at ||
            typeof ready.started_at !== "string" || !ready.started_at || daemon_owner_identity(owner, daemon) !== owner.creation)
          throw uncertain_update("Не удалось подтвердить процесс и порт запущенного демона индекса.");
        save_json(path.join(home, "owner.json"), { ...owner, daemon_started_at: daemon.started_at, health_started_at: ready.started_at });
        await proc.commit?.();
        diagnostic?.event("daemon_started", { projectRoot: root, pid: proc.pid });
        return home;
      }
      if (launchError || proc.exitCode !== null || proc.signalCode !== null)
        throw new ConfigError(
          `Демон code-index завершился (${proc.exitCode}); см. ${path.join(home, "daemon.log")}. Если журнала нет, проверьте доступ к каталогу компонента.`,
        );
      await sleep(250);
    }
    throw new ConfigError(
      `Истекло время запуска code-index; проверьте ${home} перед повтором`,
    );
  } catch (error) {
    let stopped = false;
    if (proc.rollback) try {
      await proc.rollback(); stopped = true;
      diagnostic?.event("daemon_start_rolled_back", { projectRoot: root, pid: proc.pid });
    } catch (cleanup) {
      error.outcomeUnknown = true;
      diagnostic?.event("daemon_start_cleanup_failed", { projectRoot: root, pid: proc.pid, error: cleanup }, "error");
    }
    if (proc.pid && !stopped) {
      error.outcomeUnknown = true;
      diagnostic?.event("daemon_start_unconfirmed", { projectRoot: root, pid: proc.pid, error }, "error");
    }
    throw error;
  } finally {
    proc.release?.();
  }
}
export async function ensure_daemon(state, root, data, exe, io, environment, readerId = null) {
  record_project_owner(state, root);
  const home = path.join(project_home(state, root), "code-index");
  return operation_lock(
    home,
    async () => {
      check_maintenance(home, true);
      try {
        return await start_daemon(home, root, data, exe, io, environment, async () => {
          const readers = (await active_readers_locked(state, root)).filter(reader => reader.id !== readerId && (reader.orphaned || reader.phase !== "preparing"));
          const orphaned = readers.find(reader => reader.orphaned);
          if (orphaned)
            throw new ConfigError("Не подтверждено завершение предыдущего читателя индекса. Запуск демона заблокирован. " + barrier_recovery_hint(path.join(home, "readers", orphaned.id + ".json")));
          if (readers.length)
            throw new ConfigError("Запуск демона заблокирован: другие читатели индекса ещё работают или их завершение не подтверждено.");
        });
      } catch (error) {
        if (error.outcomeUnknown) {
          const marker = path.join(home, "maintenance.json"), diagnostic = create_diagnostic_logger("index-daemon", state);
          try {
            // The pre-spawn lifecycle record remains in place until the
            // guards prove cleanup. It already blocks any competing start.
            const protectedByLifecycle = process.platform === "linux" && linux_read_daemon_lease(home)?.state === "active";
            if (!protectedByLifecycle) {
              // Do not replace a maintenance marker already owned by this operation.
              try { atomic_write(marker, JSON.stringify({ pid: process.pid, root: resolve(root), reason: "daemon_start_cleanup_unknown" }), false); }
              catch (failure) { if (failure.code !== "EEXIST") throw failure; }
              const entry = fs.lstatSync(marker);
              if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Invalid daemon cleanup barrier");
            }
            diagnostic.event("daemon_start_barrier_retained", { projectRoot: root });
          } catch (failure) {
            // Preserve the already-acquired project lock if a regular
            // maintenance marker cannot be confirmed after creation.
            error.retainOperationLock = true;
            error.message += " Не удалось сохранить барьер. " + barrier_recovery_hint(path.join(home, "operation.lock"));
            diagnostic.event("daemon_start_barrier_failed", { projectRoot: root, error: failure }, "error");
          }
        }
        throw error;
      }
    },
    45,
  );
}
export async function java_info(command = "java", config = null, environment = native_environment(config), { timeoutMs = 20000, state = config?.state_dir } = {}) {
  const java = which(command || "java");
  if (!java)
    throw new ConfigError(
      "Требуется Java; укажите mcp.managed.bsl-ls.java в настройках плагина",
    );
  // The executable is user selected and may hang or create descendants. Use
  // the same protected tree as managed runtimes; an execFile timeout only
  // signals the immediate child and can wait indefinitely on inherited pipes.
  const id = randomUUID(), diagnostic = state ? create_diagnostic_logger("java-probe", state) : null;
  const child = launch(java, ["-version"], { env: environment, stdio: ["ignore", "pipe", "pipe"], readerJob: id });
  diagnostic?.event("process_started", { owner: id, supervisorPid: child.pid });
  let timer, total = 0, stdout = "", stderr = "";
  const complete = new Promise(resolve => {
    let settled = false;
    const finish = value => { if (!settled) { settled = true; resolve(value); } };
    const collect = (kind, chunk) => {
      total += chunk.length;
      if (total > 1024 * 1024) return finish({ error: { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" } });
      if (kind === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout.on("data", chunk => collect("stdout", chunk));
    child.stderr.on("data", chunk => collect("stderr", chunk));
    child.once("error", error => finish({ error }));
    child.once("close", status => finish({ status, stdout, stderr }));
    timer = setTimeout(() => finish({ error: { code: "ETIMEDOUT" } }), timeoutMs);
  });
  let version;
  try { version = await complete; }
  finally {
    clearTimeout(timer);
    try {
      await stop_child(child, 0);
      diagnostic?.event("process_stopped", { owner: id, supervisorPid: child.pid });
    } catch (error) {
      diagnostic?.event("process_cleanup_failed", { owner: id, supervisorPid: child.pid, error }, "error");
      throw error;
    }
  }
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
export async function java_in_directory(directory, config = null, environment = native_environment(config), options = {}) {
  if (!path.isAbsolute(directory) || !is_dir(directory)) throw new ConfigError("Выберите существующий каталог Java.");
  const executable = process.platform === "win32" ? "java.exe" : "java";
  const java = [path.join(directory, "bin", executable), path.join(directory, executable)].find(file => {
    try { return fs.statSync(file).isFile(); } catch { return false; }
  });
  if (!java) throw new ConfigError(`В выбранном каталоге не найден bin/${executable}.`);
  return java_info(java, config, environment, options);
}
export async function java_command(config) {
  return (await java_info(config.mcp.managed["bsl-ls"].java || "java", config)).path;
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
  readerId = null,
) {
  if (!component_enabled(config, component)) throw new ConfigError("Компонент отключён: " + component);
  if (component === "code-index") {
    if (!index_repositories(root, data).length) throw new ConfigError("В репозиториях профиля не найдены проекты EDT с файлом .project.");
    let exe = selected_artifact || await installed_runtime(state, config, component, refresh, allow_install);
    const oldHome = path.join(project_home(state, root), "code-index"), owner = read_json(path.join(oldHome, "owner.json"), {});
    if (!selected_artifact && await daemon_health(oldHome) && owned_executable(state, owner)) exe = owner.executable;
    const home = await ensure_daemon(state, root, data, exe, undefined, native_environment(config), readerId);
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
  // The actual MCP handshake checks the selected Java together with the JAR.
  // Avoid starting a second JVM solely for a redundant -version probe.
  const java = which(bsl.java || "java");
  if (!java) throw new ConfigError("Требуется Java; укажите mcp.managed.bsl-ls.java в настройках плагина");
  const exe = selected_artifact || await installed_runtime(state, config, component, refresh, allow_install);
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
        selection.canonicalPaths ? canonical_key(selection.canonicalPaths[repo.id]) : path_key(inside(root, repo.path)),
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
      (selection.canonicalPaths ? canonical_key(repo.root_path) : path_key(repo.root_path)) !== expected.get(repo.repo) ||
      repo.path_status?.status !== "ready" ||
      repo.path_status.error ||
      repo.data_version?.stale !== false
    )
      return false;
    if (
      repo.path_status.path &&
      (selection.canonicalPaths ? canonical_key(repo.path_status.path) : path_key(repo.path_status.path)) !== expected.get(repo.repo)
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
export function index_status(body, root, data, selection = index_selection(root, data)) {
  const indexed = selection.repositories;
  const repositories = indexed.map(repo => {
    const directory = selection.canonicalPaths?.[repo.id] || inside(root, repo.path), item = body?.repos?.find(item => item.repo === repo.alias);
    const present = selection.present ? selection.present[repo.id] : is_file(path.join(directory, ".code-index/index.db"));
    let state = "not_checked";
    if (!item || !item.root_path || (selection.canonicalPaths ? canonical_key(item.root_path) !== canonical_key(directory) : path_key(item.root_path) !== path_key(directory))) state = "mismatch";
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
  require_protected_process_support();
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
      const readers = await wait_for_readers(state, root);
      const orphaned = readers.find(reader => reader.orphaned);
      if (readers.length) throw new ConfigError(orphaned ? orphaned_reader_message(home, orphaned) : "Индекс используется. Завершите текущие запросы и повторите действие.");
      const environment = native_environment(config);
      progress("stopping");
      try { await (io.stop || stop_daemon)(state, root, undefined, environment); stopped = true; }
      catch (error) { keepMaintenance = true; throw uncertain_update("Остановка индекса не подтверждена: " + safe_error_message(error)); }
      for (const repo of repositories) {
        current = repo; progress("indexing");
        try { await (io.run || run_index)(exe, inside(root, repo.path), home, environment, state, root); completed++; }
        catch (error) { if (error.outcomeUnknown) keepMaintenance = true; throw error; }
      }
      current = null; progress("restarting");
      await (io.restart || ensure_daemon)(state, root, data, exe, undefined, environment); stopped = false;
      progress("checking");
      const checked = await (io.smoke || smoke)(state, config, root, data, "code-index", 90, false, exe);
      return { projectRoot: root, ...(repositories.length === 1 ? { repository: repositories[0].id, edtProject: repositories[0].edt_project } : {}),
        ...(repositories.length ? { rebuilt: repositories.map(repo => ({ repository: repo.id, edtProject: repo.edt_project })) } : {}),
        state: checked.index_state || (checked.index_ready ? "ready" : "not_checked"), index: checked.index };
    } catch (error) {
      if (error.outcomeUnknown) keepMaintenance = true;
      throw error;
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
async function run_index(exe, directory, home, environment, state, projectRoot = directory) {
  // Output streams are untrusted and stderr is not a severity indicator.
  // Record only one aggregate after the process finishes.
  const diagnostic = create_diagnostic_logger("code-index", state);
  let child, bytes = 0, chunks = 0;
  const started = Date.now();
  try {
    child = launch(exe, ["index", directory, "--force"], { cwd: directory, env: { ...environment, CODE_INDEX_HOME: home },
      readerJob: randomUUID(), stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { bytes += chunk.length; chunks++; });
    await new Promise((done, reject) => { child.once("error", reject); child.once("close", code => code === 0 ? done() : reject(Object.assign(new ConfigError("Пересоздание индекса завершилось с ошибкой; см. журнал поддержки компонента code-index (код " + code + ")."), { exitCode: code }))); });
    diagnostic.event("index_completed", { projectRoot, phase: "indexing", durationMs: Date.now() - started, exitCode: 0 });
  } catch (error) {
    diagnostic.event("index_failed", { projectRoot, phase: "indexing", durationMs: Date.now() - started, exitCode: error.exitCode, error }, "error");
    throw error;
  } finally {
    if (chunks) diagnostic.event("index_output", { projectRoot, bytes, count: chunks });
    if (child) await stop_child(child, 0);
  }
}
async function probe_client(client, component, root, data, selection = null) {
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
      result.index = index_status(body, root, data, selection || undefined);
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

async function bounded_probe_client(client, component, root, data, timeoutMs, selection = null, beforeRequest = () => {}) {
  let timer, closing, expired = false;
  const guard = {
    initialize: (...args) => { if (expired) throw new ConfigError("Истекло общее время проверки компонента"); beforeRequest(); return client.probeInitialization || client.initialize(...args); },
    request: (...args) => { if (expired) throw new ConfigError("Истекло общее время проверки компонента"); beforeRequest(); return client.request(...args); },
  };
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => {
    expired = true; closing = Promise.resolve().then(() => client.close({ grace: 0 })).then(() => null, error => error);
    reject(new ConfigError("Истекло общее время проверки компонента"));
  }, timeoutMs); });
  try { return await Promise.race([probe_client(guard, component, root, data, selection), deadline]); }
  finally { clearTimeout(timer); const failure = await closing; if (failure) throw failure; }
}

// Observe only the existing daemon through its immutable read-only client.
// Do not use launch_command: it can prepare config and start a stopped daemon.
function index_snapshot_current(state, root, data, snapshot) {
  const current = capture_index_snapshot(state, root, data);
  const view = value => ({ root: value.root, repositories: value.repositories, selection: value.selection,
    files: Object.fromEntries(Object.entries(value.files).map(([name, entry]) => [name, entry.digest])) });
  return stable(view(current)) === stable(view(snapshot));
}
async function remove_index_snapshot(snapshot) {
  if (!snapshot) return;
  const directory = snapshot.path, deadline = performance.now() + 1500;
  // The isolated reader may write bounded local logs. Never recursively follow
  // anything a native process put in its private directory.
  try {
    snapshot.ensure();
    const names = fs.readdirSync(directory);
    for (const name of names) {
      if (!/^(?:daemon\.json|daemon\.toml|reader(?:\.exe)?|serve\.log(?:\.[0-9]+)?)$/.test(name)) throw new Error("Unexpected file in private observation directory");
      while (true) try { snapshot.unlink(name); break; }
      catch (error) {
        if (!(["EPERM", "EACCES", "EBUSY"].includes(error.code) && performance.now() < deadline)) throw error;
        await sleep(50);
      }
    }
    snapshot.remove();
  } catch (error) { try { snapshot.close(); } catch {} throw error; }
}
function reader_file_identity(file) {
  const actual = resolve(file), stat = fs.statSync(actual, { bigint: true });
  if (!stat.isFile()) throw new ConfigError("Исполняемый файл индекса недоступен.");
  return [actual, ...[stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String)];
}

async function copy_index_runtime(config, home, source, destination, timeoutMs, diagnostic, readerId, register, destinationIdentity = null) {
  let child, timer, monitor, expired = false, output = "", oversized = false;
  try {
    child = launch(process.execPath, [fileURLToPath(new URL("./index_copy_worker.mjs", import.meta.url))], {
      cwd: home, env: native_environment(config), readerJob: process.platform === "win32" ? readerId : randomUUID(), stdio: ["pipe", "pipe", "pipe"],
    });
    diagnostic.event("reader_copy_started", { reader: readerId, supervisorPid: child.pid });
    register(() => stop_child(child, 0));
    child.stdin.on("error", () => {}); child.stderr.on("data", () => {});
    child.stdout.setEncoding("utf8"); child.stdout.on("data", chunk => {
      if (oversized) return;
      if (output.length + chunk.length > 1024) { oversized = true; output = ""; void stop_child(child, 0).catch(() => {}); return; }
      output += chunk;
    });
    const completion = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", code => resolve(code)); });
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => {
      expired = true;
      void stop_child(child, 0).then(() => reject(new ConfigError("Истекло время подготовки проверенной копии индекса.")), reject);
    }, timeoutMs); });
    monitor = setInterval(() => {
      try { fs.lstatSync(path.join(home, "maintenance.json")); void stop_child(child, 0).catch(() => {}); }
      catch (error) { if (error.code !== "ENOENT") void stop_child(child, 0).catch(() => {}); }
    }, 200); monitor.unref?.();
    child.stdin.end(JSON.stringify({ source, destination, ...(destinationIdentity ? { destinationIdentity } : {}) }));
    const code = await Promise.race([completion, deadline]);
    await stop_child(child, 0);
    if (expired) throw new ConfigError("Истекло время подготовки проверенной копии индекса.");
    let result; try { result = JSON.parse(output); } catch { /* Invalid output is rejected below. */ }
    if (code !== 0 || oversized || !/^[0-9a-f]{64}$/.test(result?.digest || "")) throw new ConfigError("Не удалось подготовить проверенную копию индекса.");
    diagnostic.event("reader_copy_stopped", { reader: readerId, supervisorPid: child.pid });
    return result.digest;
  } catch (error) {
    if (child) {
      try { await stop_child(child, 0); error.copyStopped = true; diagnostic.event("reader_copy_stopped", { reader: readerId, supervisorPid: child.pid, reason: expired ? "timeout" : "error" }); }
      catch (cleanup) { diagnostic.event("reader_copy_cleanup_failed", { reader: readerId, error: cleanup }, "error"); throw cleanup; }
    }
    throw error;
  } finally { clearTimeout(timer); clearInterval(monitor); register(null); }
}
function daemon_process_identity(pid) {
  try {
    if (process.platform === "win32") return windows_process_identity(pid)?.created || null;
    if (process.platform === "darwin") return darwin_process_identity(pid);
    if (process.platform === "linux") return linux_process_identity(pid);
  } catch { /* An unavailable kernel identity prevents safe reuse. */ }
  return null;
}
function linux_process_parent(pid) {
  try {
    const value = fs.readFileSync(`/proc/${pid}/stat`, "utf8"), parent = Number(value.slice(value.lastIndexOf(")") + 2).split(" ")[1]);
    return Number.isSafeInteger(parent) && parent > 0 ? parent : null;
  } catch { return null; }
}
function linux_process_state(pid) {
  try { const value = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); return value.slice(value.lastIndexOf(")") + 2).split(" ")[0]; }
  catch { return null; }
}
function close_process_pins(pins) {
  const failures = [];
  for (const pin of pins) try { pin.close(); } catch (error) { failures.push(error); }
  if (failures.length) throw Object.assign(new AggregateError(failures, "Process handle cleanup is not confirmed"), { outcomeUnknown: true });
}
function pin_daemon_guards(owner, requireLineage, home, allowStopped = false) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(owner.guardId || "") ||
      !Array.isArray(owner.guards) || owner.guards.length !== 2 || owner.guards[0]?.pid === owner.guards[1]?.pid ||
      owner.guards.some(item => !Number.isSafeInteger(item?.pid) || item.pid <= 0 || !/^linux:[a-f0-9-]{36}:\d+$/i.test(item.creation || "")))
    throw new ConfigError("Для старого демона Linux нет подтверждённых наблюдателей; безопасная остановка дерева недоступна. " + barrier_recovery_hint(path.join(home, "owner.json")));
  const pins = [];
  try {
    for (const item of owner.guards) {
      const identity = daemon_process_identity(item.pid);
      if (!identity) { if (alive(item.pid)) throw uncertain_update("Идентичность наблюдателя демона недоступна."); continue; }
      if (identity !== item.creation) continue;
      const pin = pin_linux_process(item.pid);
      pins.push(pin);
      if (!pin.alive() || daemon_process_identity(item.pid) !== item.creation) { pin.close(); pins.pop(); continue; }
    }
    if (requireLineage && (pins.length !== 2 || owner.guards.some(item => !(allowStopped ? ["R", "S", "I", "T", "t"] : ["R", "S", "I"]).includes(linux_process_state(item.pid))) ||
        linux_process_parent(owner.pid) !== owner.guards[1].pid || linux_process_parent(owner.guards[1].pid) !== owner.guards[0].pid ||
        daemon_process_identity(owner.pid) !== owner.creation || pins.some(pin => !pin.alive())))
      throw uncertain_update("Не подтверждена связь демона с его наблюдателями.");
    return pins;
  } catch (error) { try { close_process_pins(pins); } catch (cleanup) { error.outcomeUnknown = true; error.cause = cleanup; } throw error; }
}
async function wait_daemon_guards(pins, home, owner) {
  const deadline = performance.now() + 12000;
  try {
    let lifecycle;
    do {
      try { lifecycle = linux_read_daemon_lease(home); }
      catch { throw uncertain_update("Запись завершения наблюдателей недоступна."); }
      if (!lifecycle || lifecycle.id !== owner.guardId) throw uncertain_update("Запись завершения наблюдателей изменилась или отсутствует.");
      const running = pins.some(pin => pin.alive());
      if (lifecycle.state === "completed" && !running) break;
      if (!running && lifecycle.state !== "completed") throw uncertain_update("Завершение дерева демона не подтверждено.");
      await sleep(50);
    } while (performance.now() < deadline);
    if (lifecycle?.state !== "completed" || pins.some(pin => pin.alive()) || lifecycle.notSpawned === true ||
        !owner.guards.some(item => item.pid === lifecycle.finisher?.pid && item.creation === lifecycle.finisher?.creation))
      throw uncertain_update("Завершение наблюдателей и дерева демона не подтверждено.");
    const marker = path.join(home, "guard-cleanup-unknown.json");
    try { fs.lstatSync(marker); throw uncertain_update("Очистка дерева демона не подтверждена. " + barrier_recovery_hint(marker)); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  } finally { close_process_pins(pins); }
}
export function daemon_owner_identity(owner, daemon, { allowStoppedGuard = false } = {}) {
  const pid = owner?.pid, port = daemon?.http_port;
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isInteger(port) || port < 1 || port > 65535 || typeof owner.executable !== "string") return null;
  try {
    const before = daemon_process_identity(pid); if (!before) return null;
    if (process.platform === "win32") {
      const processInfo = windows_process_identity(pid);
      if (!processInfo || canonical_key(path_identity(processInfo.executable)) !== canonical_key(path_identity(owner.executable))) return null;
      const listeners = windows_tcp_rows(2).filter(row => row.state === 2 && row.localPort === port);
      if (listeners.length !== 1 || listeners[0].pid !== pid || listeners[0].localAddress !== "7f000001") return null;
    } else if (process.platform === "linux") {
      const actual = fs.statSync(`/proc/${pid}/exe`, { bigint: true }), expected = fs.statSync(owner.executable, { bigint: true });
      if (actual.dev !== expected.dev || actual.ino !== expected.ino || !linux_has_loopback_listener(pid, port)) return null;
      if (owner.guardId || owner.guards !== undefined) close_process_pins(pin_daemon_guards(owner, true, ".", allowStoppedGuard));
    } else if (process.platform === "darwin") {
      const executable = darwin_process_executable(pid);
      if (!executable || path_identity(executable) !== path_identity(owner.executable) || !darwin_has_loopback_listener(pid, port)) return null;
    } else return null;
    return before === daemon_process_identity(pid) ? before : null;
  } catch (error) { if (error.outcomeUnknown) throw error; return null; }
}
function reader_binding(state, config, root, snapshot) {
  const bytes = read_regular_file(path.join(state, "runtime-lock.json"), 4 * 1024 * 1024)?.bytes;
  const lock = bytes ? JSON.parse(bytes.toString("utf8")) : {};
  return sha256(stable({ state: resolve(state), root: resolve(root), instance: instance_name(), options: component_settings(config, "code-index"),
    grant: preparation_granted(state, root, "code-index"),
    runtime: lock["code-index"] || null, repositories: snapshot.repositories, selection: snapshot.selection,
    files: Object.fromEntries(Object.entries(snapshot.files).map(([name, item]) => [name, item.digest])) }));
}
function reader_watch(state, root, previous = null) {
  const home = path.join(project_home(state, root), "code-index"), external = external_override_files();
  const files = [resolve(process.env.EDT_AI_SETTINGS || path.join(state, "settings.json")),
    inside(root, ".ai/project.yaml"), inside(root, ".ai/project.local.yaml"),
    path.join(instance_directory(state, root), instance_name() + ".preparation.json"),
    path.join(state, "runtime-lock.json"), ...["daemon.json", "owner.json", "daemon.toml"].map(name => path.join(home, name)), ...external];
  const stamp = file => {
    try {
      const stat = fs.lstatSync(file, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4n * 1024n * 1024n) throw new Error("Invalid observation input");
      return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
    } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  };
  const stamps = stable(files.map(file => [file, stamp(file)]));
  if (previous?.stamps === stamps) return previous;
  const read = (file, expected) => {
    if (!expected) return null;
    const value = read_regular_file(file, 4 * 1024 * 1024), stat = value?.stat;
    if (!stat || stable([stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String)) !== stable(expected)) throw new Error("Observation input changed");
    return value.bytes;
  };
  const observed = JSON.parse(stamps), values = observed.map(([file, expected]) => read(file, expected));
  if (stable(files.map(file => [file, stamp(file)])) !== stamps) throw new Error("Observation input changed");
  if (!values[1]) throw new Error("Project profile is unavailable");
  const local = values[2] ? parse(values[2].toString("utf8")) : {}, profile = merged_profile(root, parse(values[1].toString("utf8")), local);
  const config = validate_settings(deep_merge(load(path.join(ROOT, "settings/defaults.json")), values[0] ? parse(values[0].toString("utf8")) : {}));
  config.state_dir = state; config.active_project = root;
  const externalInputs = new Map(external.map((file, i) => [file, parse(values[8 + i].toString("utf8"))]));
  const effective = effective_settings(config, root, profile, null, state, local, externalInputs);
  const binding = { options: component_settings(effective, "code-index"), repositories: profile.repositories,
    policy: { edt_repository_ids: profile.policy?.edt_repository_ids || [], unbound_edt_repositories: profile.policy?.unbound_edt_repositories || [] } };
  const grant = values[3] ? JSON.parse(values[3].toString("utf8")) : {};
  const granted = grant?.root === resolve(root) && Array.isArray(grant.components) && grant.components.includes("code-index");
  return { stamps, binding, grantIdentity: observed[3][1], signature: sha256(stable({ binding, grant: granted,
    runtime: values[4] ? JSON.parse(values[4].toString("utf8"))["code-index"] || null : null,
    daemon: values.slice(5, 8).map(value => value ? sha256(value) : "missing") })) };
}

// A settings session owns at most one strictly read-only client. The lease and
// immutable inputs outlive individual health calls and are released only after
// the complete owned process tree has been confirmed stopped.
export class IndexObserver {
  constructor(state) { this.state = state; this.entry = null; this.pending = Promise.resolve(); this.closing = null; this.closed = false; this.cleanupError = null; this.closePromise = null; this.cancelCopy = null; }
  verifyDaemon(owner, daemon, home) {
    if (home) check_index_observation(home);
    if (process.platform === "linux" && (owner.guardId || owner.guards !== undefined)) {
      try { const lifecycle = linux_read_daemon_lease(home); if (lifecycle?.id !== owner.guardId || lifecycle.state !== "active") return null; }
      catch { return null; }
    }
    return daemon_owner_identity(owner, daemon);
  }
  observe(config, root, data, snapshot = capture_index_snapshot(this.state, root, data), { cancelled = () => false } = {}) {
    const run = this.pending.then(async () => {
      if (cancelled()) throw new ConfigError("Ожидание наблюдения индекса отменено.");
      try { return await this.run(config, root, data, snapshot); }
      catch (error) { if (!error.keepReader) await this.retire(this.entry, "invalidated"); throw error; }
    });
    this.pending = run.catch(() => {});
    return run;
  }
  async retire(entry = this.entry, reason = "closed") {
    if (!entry) return this.closing;
    if (entry.closing) return entry.closing;
    if (this.entry === entry) this.entry = null;
    clearInterval(entry.timer);
    entry.closing = (async () => {
      let stopped = false, leaseClosed = false;
      try {
        let coordinationFailure;
        try { await entry.lease.markClosing(); }
        catch (error) { coordinationFailure = error; entry.diagnostic.event("reader_coordination_failed", { projectRoot: entry.root, reader: entry.lease.id, reason, error }, "error"); }
        await entry.client.close({ grace: 0 }); stopped = true;
        entry.diagnostic.event("reader_stopped", { projectRoot: entry.root, reader: entry.lease.id, reason });
        await remove_index_snapshot(entry.snapshotDirectory);
        entry.diagnostic.event("reader_files_removed", { projectRoot: entry.root, reader: entry.lease.id, reason });
        if (coordinationFailure) throw coordinationFailure;
        await entry.lease.close(); leaseClosed = true;
      } catch (error) {
        const failure = error instanceof Error ? error : new Error("Index reader cleanup failed");
        failure.outcomeUnknown = true;
        failure.cleanupUnconfirmed = true;
        this.cleanupError = failure;
        // Leave the durable marker as a barrier, but do not leave its socket
        // alive and falsely claim that the reader is still owned and usable.
        if (!leaseClosed) try { await entry.lease.abandon(); } catch { /* The original failure is authoritative. */ }
        try { entry.snapshotDirectory?.close(); } catch { /* The original failure is authoritative. */ }
        entry.diagnostic.event(stopped && leaseClosed ? "reader_files_cleanup_failed" : "reader_cleanup_failed", { projectRoot: entry.root, reader: entry.lease.id, reason, error: failure }, "error");
        throw failure;
      }
    })();
    this.closing = entry.closing;
    try { await entry.closing; }
    finally { if (this.closing === entry.closing) this.closing = null; }
  }
  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    if (this.cancelCopy) void this.cancelCopy().catch(() => {});
    return this.closePromise = (async () => {
      let failure;
      try { await this.retire(); } catch (error) { failure = error; }
      await this.pending;
      try { await this.retire(); } catch (error) { failure ||= error; }
      if (failure || this.cleanupError) throw failure || this.cleanupError;
    })();
  }
  async run(config, root, data, snapshot) {
    if (this.closed) throw Object.assign(new ConfigError("Сеанс наблюдения индекса закрыт."), { ownerClosing: true });
    if (this.closing) await this.closing;
    if (this.cleanupError) throw Object.assign(new ConfigError("Завершение предыдущего читателя индекса не подтверждено."), { outcomeUnknown: true });
    const state = this.state, home = path.join(project_home(state, root), "code-index"), diagnostic = create_diagnostic_logger("index-observer", state);
    await wait_index_observation(home);
    const watch = reader_watch(state, root, this.entry?.watch);
    if (this.entry && this.entry.watch.signature !== watch.signature) {
      await this.retire(this.entry, "inputs_changed");
    }
    if (this.entry) this.entry.watch = watch;
    const requested = { options: component_settings(config, "code-index"), repositories: data.repositories,
      policy: { edt_repository_ids: data.policy?.edt_repository_ids || [], unbound_edt_repositories: data.policy?.unbound_edt_repositories || [] } };
    if (stable(requested) !== stable(watch.binding))
      throw Object.assign(new ConfigError("Настройки наблюдения индекса изменились."), { inputsChanged: true });
    const checkAuthority = () => {
      check_index_observation(home);
      require_preparation(state, root, "code-index");
      const current = reader_watch(state, root, watch);
      if (current.signature !== watch.signature)
        throw Object.assign(new ConfigError("Разрешение или настройки наблюдения изменились."), { inputsChanged: true });
      if (stable(current.grantIdentity) !== stable(watch.grantIdentity))
        throw Object.assign(new ConfigError("Разрешение изменилось во время наблюдения."), { inputsChanged: true, grantRevisionChanged: true });
    };
    require_preparation(state, root, "code-index");
    if (snapshot.root !== resolve(root) || !index_snapshot_current(state, root, data, snapshot))
      throw Object.assign(new ConfigError("Привязка индекса изменилась во время проверки."), { inputsChanged: true });
    const daemonBytes = snapshot_bytes(snapshot, "daemon.json"), ownerBytes = snapshot_bytes(snapshot, "owner.json"), configBytes = snapshot_bytes(snapshot, "daemon.toml");
    const health = await daemon_health(home, snapshot);
    if (!health) { await this.retire(); return null; }
    const owner = ownerBytes ? JSON.parse(ownerBytes.toString("utf8")) : {}, daemon = daemonBytes ? JSON.parse(daemonBytes.toString("utf8")) : {};
    if (!owner.project_root || path_key(owner.project_root) !== path_key(root) || owner.pid !== health.pid)
      throw new ConfigError("Владелец демона проекта не совпадает; повторное использование запрещено");
    if (daemon.http_host !== undefined && daemon.http_host !== "127.0.0.1") throw new ConfigError("Адрес работающего демона индекса не является локальным.");
    if (!pathsMatch(health, root, data, snapshot.selection)) throw new ConfigError("Пути репозиториев демона проекта не совпадают с выбранным профилем");
    if (!configBytes || configBytes.toString("utf8") !== index_config_text(root, data, snapshot.selection)) throw new ConfigError("Конфигурация индекса не соответствует выбранным репозиториям.");
    const identity = this.verifyDaemon(owner, daemon, home), key = reader_binding(state, config, root, snapshot), executable = reader_file_identity(owner.executable);
    if (!identity) throw new ConfigError("Не удалось подтвердить процесс и локальный порт демона индекса.");
    if (this.closed) throw Object.assign(new ConfigError("Сеанс наблюдения индекса закрыт."), { ownerClosing: true });
    let entry = this.entry;
    if (entry && (entry.key !== key || stable(entry.executable) !== stable(executable) || !identity || entry.identity !== identity ||
        !health.started_at || entry.daemonStartedAt !== health.started_at || entry.client.error)) {
      await this.retire(entry, "binding_changed"); entry = null;
    }
    if (!entry) {
      require_protected_process_support();
      const deadline = performance.now() + 10000; let lease;
      while (true) {
        lease = await acquire_reader(state, root, { preparing: true, observerBinding: key,
          observe: cancelled => this.observe(config, root, data, snapshot, { cancelled }) });
        if (lease.closing) {
          if (performance.now() >= deadline) throw new ConfigError("Истекло время завершения предыдущего читателя индекса.");
          await sleep(50);
          if (this.closed || reader_watch(state, root, watch).signature !== watch.signature) throw Object.assign(new ConfigError("Настройки наблюдения индекса изменились."), { inputsChanged: true });
          continue;
        }
        if (!lease.joined) break;
        try {
          checkAuthority();
          const result = await observe_reader(lease.joined, key), after = await daemon_health(home, snapshot);
          checkAuthority();
          if (this.closed || !after || after.pid !== health.pid || after.started_at !== health.started_at ||
              this.verifyDaemon(owner, daemon, home) !== identity || !index_snapshot_current(state, root, data, snapshot))
            throw Object.assign(new ConfigError("Привязка индекса изменилась во время проверки."), { inputsChanged: true });
          return result;
        } catch (error) {
          if (error.ownerResponded && !error.ownerClosing || error.inputsChanged || performance.now() >= deadline) throw error;
          const previous = (await active_readers(state, root)).find(reader => reader.id === lease.joined);
          if (previous && previous.phase !== "closing" && !error.ownerClosing) throw error;
          if (previous) await sleep(50);
        }
      }
      let client, launching = false, snapshotHome, snapshotDirectory;
      try {
        if (this.closed) throw new ConfigError("Сеанс наблюдения индекса закрыт.");
        await lease.assertAvailable();
        checkAuthority();
        // Record the possible snapshot before creating anything. If this
        // process dies during creation, neither Job absence nor a preparing
        // lease proves that the private files were removed.
        await lease.arm({ snapshotMayExist: true });
        checkAuthority();
        if (this.closed) throw new ConfigError("Сеанс наблюдения индекса закрыт.");
        snapshotDirectory = private_observation_directory(home); snapshotHome = snapshotDirectory.path;
        snapshotDirectory.ensure();
        const target = resolve(owner.executable), runtimeRoot = resolve(path.join(state, "runtime", "code-index"));
        const access = snapshotDirectory.ioPath, expected = path.basename(path.dirname(target)), readerName = process.platform === "win32" ? "reader.exe" : "reader", reader = path.join(access, readerName);
        if (!target.startsWith(runtimeRoot + path.sep) || !/^[0-9a-f]{64}$/.test(expected))
          throw new ConfigError("Не удалось подтвердить исполняемый файл работающего демона индекса.");
        checkAuthority();
        if (this.closed) throw new ConfigError("Сеанс наблюдения индекса закрыт.");
        const destinationIdentity = process.platform === "win32" ? snapshotDirectory.createFile(readerName) : null;
        const sourcePin = process.platform === "win32" ? pin_windows_readonly_file(target) : null;
        let digest;
        try {
          launching = true;
          digest = await copy_index_runtime(config, home, sourcePin?.path || target, reader, Math.min(component_settings(config, "code-index").timeout_seconds || 30, 25) * 1000,
            diagnostic, lease.id, cancel => { this.cancelCopy = cancel; }, destinationIdentity);
        } finally { sourcePin?.close(); }
        launching = false;
        if (digest !== expected)
          throw new ConfigError("Не удалось подтвердить исполняемый файл работающего демона индекса.");
        if (!index_snapshot_current(state, root, data, snapshot) || stable(reader_file_identity(owner.executable)) !== stable(executable))
          throw Object.assign(new ConfigError("Привязка индекса изменилась во время проверки."), { inputsChanged: true });
        snapshotDirectory.ensure();
        if (process.platform === "win32") {
          snapshotDirectory.writeFile("daemon.json", daemonBytes);
          snapshotDirectory.writeFile("daemon.toml", configBytes);
        } else {
          fs.writeFileSync(path.join(access, "daemon.json"), daemonBytes, { flag: "wx", mode: 0o600 });
          fs.writeFileSync(path.join(access, "daemon.toml"), configBytes, { flag: "wx", mode: 0o600 });
        }
        const options = component_settings(config, "code-index");
        await lease.assertAvailable();
        if (this.closed) throw new ConfigError("Сеанс наблюдения индекса закрыт.");
        checkAuthority();
        snapshotDirectory.ensure();
        launching = true;
        client = new McpClient([reader, "serve", "--config", path.join(access, "daemon.toml")], home,
          { ...native_environment(config), CODE_INDEX_HOME: access }, options.timeout_seconds || 30, { maxBytes: options.max_response_bytes, readerJob: lease.id });
        entry = { key, root, identity, daemonStartedAt: health.started_at, executable, lease, client, snapshotHome, snapshotDirectory, diagnostic, watch };
        this.entry = entry;
        diagnostic.event("reader_started", { projectRoot: root, reader: lease.id, supervisorPid: client.process.pid });
        client.process.once("exit", () => { void this.retire(entry, "supervisor_exited").catch(() => {}); });
        entry.timer = setInterval(() => {
          try { check_maintenance(home); }
          catch { void this.retire(entry, "maintenance").catch(() => {}); return; }
          try {
            fs.lstatSync(path.join(home, "operation.lock"));
            entry.lockSince ||= performance.now();
            if (performance.now() - entry.lockSince >= 1000) { void this.retire(entry, "index_locked").catch(() => {}); return; }
          } catch (error) {
            if (error.code !== "ENOENT") { void this.retire(entry, "index_lock_unknown").catch(() => {}); return; }
            entry.lockSince = 0;
          }
          try {
            const current = reader_watch(state, root, entry.watch);
            if (current.signature !== entry.watch.signature) void this.retire(entry, "inputs_changed").catch(() => {});
            else entry.watch = current;
          } catch { void this.retire(entry, "inputs_unknown").catch(() => {}); }
        }, 500);
        entry.timer.unref?.();
      } catch (error) {
        let stopped = !launching || error.notSpawned === true || error.copyStopped === true;
        try {
          let coordinationFailure;
          try { await lease.markClosing(); } catch (failure) { coordinationFailure = failure; }
          if (client) { await client.close({ grace: 0 }); stopped = true; }
          if (!stopped || error.cleanupUnconfirmed) throw error;
          await remove_index_snapshot(snapshotDirectory);
          if (coordinationFailure) throw coordinationFailure;
          await lease.close();
        } catch (cleanup) {
          const failure = cleanup instanceof Error ? cleanup : new Error("Index reader cleanup failed");
          failure.outcomeUnknown = true; failure.cleanupUnconfirmed = true; this.cleanupError = failure;
          try { await lease.abandon(); } catch {}
          try { snapshotDirectory?.close(); } catch {}
          diagnostic.event("reader_cleanup_failed", { projectRoot: root, reader: lease.id, error: failure }, "error");
          throw failure;
        }
        throw error;
      }
    }
    try {
      const options = component_settings(config, "code-index");
      const result = await bounded_probe_client(entry.client, "code-index", root, data, Math.min(options.timeout_seconds || 30, 25) * 1000, snapshot.selection, () => {
        checkAuthority();
        if (this.entry !== entry)
          throw Object.assign(new ConfigError("Разрешение или настройки наблюдения изменились."), { inputsChanged: true });
      });
      const after = await daemon_health(home, snapshot);
      checkAuthority();
      if (this.entry !== entry || !after || after.pid !== health.pid || after.started_at !== health.started_at ||
          this.verifyDaemon(owner, daemon, home) !== identity ||
          !index_snapshot_current(state, root, data, snapshot))
        throw Object.assign(new ConfigError("Привязка индекса изменилась во время проверки."), { inputsChanged: true });
      // No kernel creation identity (or server start time) means a future PID
      // might be a replacement. The current observation remains one-shot.
      if (!identity || !health.started_at) await this.retire(entry, "identity_unavailable");
      return result;
    } catch (error) {
      if (error.grantRevisionChanged && !this.closed && this.entry === entry && !entry.client.error) try {
        const current = reader_watch(state, root, entry.watch);
        if (current.signature === watch.signature && preparation_granted(state, root, "code-index")) {
          entry.watch = current; error.keepReader = true;
        }
      } catch { /* An unknown binding must be retired. */ }
      if (!error.keepReader) await this.retire(entry, "probe_failed");
      throw error;
    }
  }
}

export async function observe_index(state, config, root, data, snapshot = capture_index_snapshot(state, root, data)) {
  const observer = new IndexObserver(state);
  try { return await observer.observe(config, root, data, snapshot); }
  finally { await observer.close(); }
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
  if (options.mode !== "external") require_protected_process_support();
  const lease = component === "code-index" && options.mode !== "external" && !selected_artifact ? await acquire_reader(state, root, { preparing: true }) : null;
  let client, launching = false, stopped = false;
  try {
  if (options.mode === "external") {
    if (!options.url) throw new ConfigError("Укажите внешний адрес подключения для " + component);
    client = new RemoteMcp(options.url, options.timeout_seconds || timeout, { headers_env: options.headers_env, maxBytes: options.max_response_bytes });
  } else {
    await lease?.assertAvailable();
    const [command, cwd, env] = await launch_command(
      state,
      config,
      component,
      root,
      data,
      refresh,
      selected_artifact,
      allow_install,
      lease?.id,
    );
    await lease?.assertAvailable();
    await lease?.arm();
    launching = Boolean(lease);
    try {
      client = new McpClient(command, cwd, env, options.timeout_seconds || timeout, { maxBytes: options.max_response_bytes,
        readerJob: lease?.id || randomUUID() });
    } catch (error) { if (error.notSpawned) launching = false; throw error; }
  }
  try {
    return max_probe_seconds ? await bounded_probe_client(client, component, root, data, Math.min(options.timeout_seconds || timeout, max_probe_seconds) * 1000) : await probe_client(client, component, root, data);
  } finally {
    await client.close();
    stopped = true;
  }
  } finally {
    if (lease && (!launching || stopped)) await lease.close();
    else if (lease) await lease.abandon();
  }
}
// The native CLI rereads daemon.json after the caller checks it. Send the same
// control request only over a socket whose exact peer was verified while a
// kernel handle pins the recorded process identity.
async function stop_owned_daemon(owner, daemon, guard) {
  const socket = new net.Socket(); let sent = false, timer;
  const timeoutError = () => Object.assign(new ConfigError("Время остановки демона истекло; проверьте его состояние."), { outcomeUnknown: sent });
  let disconnected;
  const closed = new Promise(resolve => { disconnected = resolve; });
  socket.on("error", () => {});
  socket.once("close", () => disconnected());
  try {
    if (!guard.alive() || process.platform === "win32" && guard.created !== owner.creation ||
        daemon_owner_identity(owner, daemon, { allowStoppedGuard: true }) !== owner.creation)
      throw new ConfigError("Не подтверждена идентичность демона; остановка запрещена.");
    const deadline = performance.now() + 20000;
    timer = setTimeout(() => socket.destroy(timeoutError()), 20000);
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
      socket.connect({ host: "127.0.0.1", port: daemon.http_port });
    });
    let peer = false;
    while (performance.now() < deadline && !socket.destroyed) {
      if (!guard.alive() || daemon_owner_identity(owner, daemon, { allowStoppedGuard: true }) !== owner.creation) break;
      peer = process.platform === "win32" ? windows_has_tcp_peer(owner.pid, daemon.http_port, socket.localPort)
        : linux_has_tcp_peer(owner.pid, daemon.http_port, socket.localPort);
      if (peer) break;
      await Promise.race([sleep(25), closed]);
    }
    if (!peer || socket.destroyed || !guard.alive() || daemon_owner_identity(owner, daemon, { allowStoppedGuard: true }) !== owner.creation)
      throw new ConfigError("Не подтверждён владелец соединения с демоном; остановка запрещена.");
    const response = new Promise((resolve, reject) => {
      let text = "";
      socket.on("data", chunk => {
        text += chunk.toString("latin1");
        if (text.length > 65536) socket.destroy(Object.assign(new Error("Daemon stop response exceeds limit"), { outcomeUnknown: true }));
      });
      socket.once("error", reject);
      socket.once("end", () => resolve(text));
      socket.once("close", () => resolve(text));
    });
    sent = true;
    socket.write(`POST /stop HTTP/1.1\r\nHost: 127.0.0.1:${daemon.http_port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    const reply = await response;
    if (!/^HTTP\/1\.[01] 2\d\d(?:\s|\r)/.test(reply))
      throw Object.assign(new ConfigError("Демон не подтвердил запрос остановки; проверьте его состояние."), { outcomeUnknown: true });
  } catch (error) {
    if (sent) error.outcomeUnknown = true;
    throw error;
  } finally {
    clearTimeout(timer); socket.destroy();
    let cleanupTimer;
    try {
      const complete = await Promise.race([closed.then(() => true), new Promise(resolve => { cleanupTimer = setTimeout(() => resolve(false), 2000); })]);
      if (!complete) throw uncertain_update("Закрытие соединения с демоном не подтверждено.");
    } finally { clearTimeout(cleanupTimer); }
  }
}

export async function stop_daemon(state, root, io = null, environment = native_environment()) {
  const home = path.join(project_home(state, root), "code-index");
  const diagnostic = create_diagnostic_logger("index-daemon", state);
  await operation_lock(
    home,
    async () => {
      try {
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
        if (process.platform === "linux" && !io?.stop) {
          if (owner.pid) await wait_daemon_guards(pin_daemon_guards(owner, false, home), home, owner);
          else {
            const lifecycle = linux_read_daemon_lease(home);
            if (lifecycle) throw new ConfigError("Запись наблюдателя требует проверки перед остановкой. " + barrier_recovery_hint(path.join(home, "guard-lifecycle.json")));
          }
        }
        return;
      }
      if (
        health.pid !== owner.pid ||
        !owner.project_root ||
        path_key(owner.project_root) !== path_key(root) ||
        !owned_executable(state, owner)
      )
        throw new ConfigError("Владелец демона не совпадает; остановка запрещена");
      if (process.platform === "linux" && owner.guardId) {
        let lifecycle;
        try { lifecycle = linux_read_daemon_lease(home); } catch { throw uncertain_update("Запись наблюдателей демона недоступна."); }
        if (lifecycle?.id !== owner.guardId || lifecycle.state !== "active") throw uncertain_update("Запись наблюдателей демона не подтверждена.");
      }
      const daemon = read_json(path.join(home, "daemon.json"), {});
      if (!owner.creation || !owner.daemon_started_at || !owner.health_started_at || daemon.started_at !== owner.daemon_started_at ||
          health.started_at !== owner.health_started_at || daemon.http_host !== "127.0.0.1" || daemon_owner_identity(owner, daemon, { allowStoppedGuard: true }) !== owner.creation)
        throw new ConfigError("Не подтверждена идентичность процесса и порта демона; остановка запрещена.");
      if (!["win32", "linux"].includes(process.platform)) throw new ConfigError("Безопасная остановка демона на этой платформе недоступна.");
      let treePins = process.platform === "linux" && !io?.stop ? pin_daemon_guards(owner, true, home, true) : null;
      let guard;
      let requested = false, stopped = false;
      diagnostic.event("daemon_stop_started", { projectRoot: root, pid: owner.pid });
      try {
        guard = process.platform === "win32" ? pin_windows_process(owner.pid) : pin_linux_process(owner.pid);
        if (!guard.alive() || process.platform === "win32" && guard.created !== owner.creation || daemon_process_identity(owner.pid) !== owner.creation)
          throw new ConfigError("Идентичность процесса демона изменилась; остановка запрещена.");
        if (io?.stop) {
          requested = true;
          await io.stop(owner.executable, ["daemon", "stop"], { cwd: home, env: { ...environment, CODE_INDEX_HOME: home }, timeout: 20000, state });
        } else { await stop_owned_daemon(owner, daemon, guard); requested = true; }
        for (let i = 0; i < 40; i++) {
          if (!guard.alive()) { stopped = true; break; }
          await sleep(250);
        }
        if (!stopped) throw uncertain_update("Остановка демона не подтверждена");
        if (treePins) { const pending = treePins; treePins = null; await wait_daemon_guards(pending, home, owner); }
      } catch (error) {
        if (requested) error.outcomeUnknown = true;
        diagnostic.event("daemon_stop_failed", { projectRoot: root, pid: owner.pid, error }, "error");
        throw error;
      } finally {
        try { close_process_pins([...(guard ? [guard] : []), ...(treePins || [])]); }
        catch (error) { diagnostic.event("daemon_cleanup_failed", { projectRoot: root, pid: owner.pid, error }, "error"); throw error; }
      }
      diagnostic.event("daemon_stopped", { projectRoot: root, pid: owner.pid });
      } catch (error) {
        if (process.platform === "linux" && error.outcomeUnknown) {
          try { linux_retain_daemon_barrier(home, "daemon_stop_cleanup_unknown", { forceSeparate: true }); }
          catch (barrier) { error.retainOperationLock = true; diagnostic.event("daemon_guard_barrier_failed", { projectRoot: root, error: barrier }, "error"); }
        }
        throw error;
      }
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
