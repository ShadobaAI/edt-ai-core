import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { windows_process_identity, same_creation } from "../scripts/windows_process.mjs";
import { randomUUID } from "node:crypto";
import { path_identity } from "../scripts/project_paths.mjs";
import { digest, fail, readJson, startArguments, platformCommandLine, checkFiles, interactiveParameters, configuredUser } from "./profile.mjs";

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; } };
const endpointKey = profile => `endpoint-${profile.mcp.port}`;
// Only canonical filesystem identities can establish exclusive client control.
const clientKeyVersion = 3;
export const clientControlKey = profile => {
  const base = profile.client.infobase;
  const normalized = base.type === "file" ? { type: "file", path: path_identity(base.path) }
    : { type: "server", server: base.server.toLowerCase(), database: base.database.toLowerCase() };
  return `client-${digest(JSON.stringify(normalized)).slice(0, 32)}`;
};
export function registryDir() { return path.join(os.tmpdir(), "vanessa-ui-control"); }

export async function withProfileLock(profile, use) {
  const root = registryDir(), files = [];
  fs.mkdirSync(root, { recursive: true });
  try {
    for (const key of [`profile-${profile.identity}`, endpointKey(profile), clientControlKey(profile)].sort()) {
      const file = path.join(root, `${key}.lock`);
      try {
        const fd = fs.openSync(file, "wx");
        files.push(file);
        try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, profile: profile.identity })); }
        finally { fs.closeSync(fd); }
      }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        let owner;
        try { owner = readJson(file, 4096); } catch { fail("Не удалось проверить блокировку сессии; проверьте её вручную"); }
        if (!Number.isInteger(owner.pid) || owner.pid < 1 || alive(owner.pid)) fail("Другая сессия управления интерфейсом удерживает это подключение или TestClient");
        // Do not race another caller replacing a stale lock. Manual review only removes metadata.
        fail("Устаревшая блокировка управления интерфейсом; убедитесь, что операций нет, и вручную удалите только этот файл блокировки");
      }
    }
    return await use();
  } finally { for (const file of files.reverse()) fs.unlinkSync(file); }
}

export function checkOwner(profile, { required = false } = {}) {
  checkClaims(profile);
  const file = path.join(registryDir(), `${endpointKey(profile)}.owner.json`);
  if (!fs.existsSync(file)) { if (required) fail("Подключение не принадлежит этому профилю; внешний менеджер не принимается под управление"); return null; }
  const owner = readJson(file, 4096);
  if (owner.profile !== profile.identity) fail("Запись владельца подключения принадлежит другому профилю; проверьте процесс и порт: запись может быть устаревшей");
  if (owner.clientKeyVersion !== clientKeyVersion) fail("Неподдерживаемая запись владельца менеджера; проверьте процессы и перенесите запись в архив перед новым запуском");
  if (owner.fingerprint !== fingerprint(profile)) {
    if (owner.status === "starting" || !Number.isInteger(owner.pid) || owner.pid < 1 || alive(owner.pid)) fail("Настройки запуска профиля изменились; требуется проверить владельца активного менеджера или запуска с неизвестным исходом");
    // A confirmed dead, own process may be replaced with the current settings.
    // Its old claim is overwritten only after all new launch gates have passed.
  }
  return owner;
}
function fingerprint(profile) { return digest(JSON.stringify([profile.platform, profile.runtime, profile.manager, profile.ownerClient ?? profile.client, profile.stateDir, interactiveParameters(profile)])); }
export function checkClaims(profile) {
  const root = registryDir();
  if (!fs.existsSync(root)) return;
  for (const file of fs.readdirSync(root).filter(file => file.endsWith(".owner.json"))) {
    const owner = readJson(path.join(root, file), 4096);
    const active = owner.status === "starting" || (owner.pid && alive(owner.pid));
    if (!active) continue;
    if (owner.clientKeyVersion !== clientKeyVersion) fail("Неподдерживаемая запись владельца активного менеджера; проверьте процессы перед изменением записи");
    if (owner.profile === profile.identity && file !== `${endpointKey(profile)}.owner.json`) fail("Этот профиль уже владеет менеджером по другому адресу; настройки запуска изменились");
    if (owner.profile !== profile.identity && owner.client === clientControlKey(profile)) fail("TestClient принадлежит активному менеджеру другого профиля");
  }
}
export function managerAlive(profile, owner) {
  if (!owner?.pid) return false;
  if (process.platform !== "win32") fail("Проверка идентичности процесса менеджера требует Windows");
  const state = windows_process_identity(owner.pid);
  if (!state) return false;
  if (state.executable.toLowerCase() !== profile.platform.toLowerCase() || !same_creation(state, owner.created)) fail("PID менеджера использован повторно или идентичность процесса изменилась");
  return true;
}
export const portAvailable = profile => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", error => error.code === "EADDRINUSE" ? resolve(false) : reject(new Error("Не удалось проверить доступность порта подключения")));
  server.listen({ host: new URL(profile.mcp.url).hostname.replace(/^\[|\]$/g, ""), port: profile.mcp.port, exclusive: true }, () => server.close(() => resolve(true)));
});

export async function start(profile) {
  if (configuredUser(profile.manager, "manager") !== undefined) return { status: "unverified", reason: "manager_session_user_unverified" };
  // The primary owner remains part of the launch even when --client selects
  // another entry. Do not bypass the identity guard through that selection.
  if ([profile.client, profile.ownerClient].filter(Boolean).some(client => configuredUser(client, "client") !== undefined))
    return { status: "unverified", reason: "actual_test_client_user_unverified" };
  if (process.platform !== "win32") fail("Запуск менеджера требует Windows");
  checkFiles(profile);
  return withProfileLock(profile, async () => {
    const owner = checkOwner(profile);
    if (owner && managerAlive(profile, owner)) {
      return { status: "running", pid: owner.pid, ...(owner.startupLog ? { startupLog: owner.startupLog } : {}), readiness: "unverified" };
    }
    if (owner?.status === "starting") fail("Исход предыдущего запуска неизвестен; перед перезапуском вручную проверьте состояние менеджера");
    if (!await portAvailable(profile)) fail("Порт подключения занят; внешний менеджер не принимается под управление");
    const startupLog = path.join(profile.stateDir, `startup-${randomUUID()}.log`);
    // Validate authentication and command-line construction before recording a launch claim.
    const commandLine = platformCommandLine(startArguments(profile, process.env, { startupLog }));
    fs.mkdirSync(profile.stateDir, { recursive: true });
    const stateFile = path.join(profile.stateDir, "manager.json");
    if (fs.existsSync(stateFile)) {
      const state = readJson(stateFile, 4096);
      if (state.profile !== profile.identity) fail("Каталог состояния принадлежит другому профилю");
    }
    const claim = { profile: profile.identity, fingerprint: fingerprint(profile), client: clientControlKey(profile), clientKeyVersion, startupLog, status: "starting" };
    // Reserve an explicit state directory before launch, also for different endpoints.
    if (!fs.existsSync(stateFile)) {
      const fd = fs.openSync(stateFile, "wx");
      try { fs.writeFileSync(fd, JSON.stringify(claim)); }
      finally { fs.closeSync(fd); }
    }
    fs.writeFileSync(path.join(profile.stateDir, "interactive.json"), JSON.stringify(interactiveParameters(profile), null, 2) + "\n");
    fs.mkdirSync(profile.results, { recursive: true });
    const ownerFile = path.join(registryDir(), `${endpointKey(profile)}.owner.json`);
    fs.writeFileSync(ownerFile, JSON.stringify(claim));
    // Preserve the platform's doubled quote contract in the raw Windows command line.
    // The user-visible interactive test manager needs its normal application window.
    let launched;
    try {
      const child = spawn(profile.platform, [commandLine], {
        cwd: profile.projectRoot, windowsHide: false, windowsVerbatimArguments: true,
        argv0: '"' + profile.platform + '"', detached: true, stdio: "ignore", shell: false,
      });
      await once(child, "spawn");
      child.unref();
      const identity = windows_process_identity(child.pid);
      if (!identity || identity.executable.toLowerCase() !== profile.platform.toLowerCase()) throw new Error("Не удалось подтвердить идентичность запущенного менеджера");
      launched = { pid: child.pid, created: identity.created };
    } catch (error) {
      error.code = "manager_launch_indeterminate";
      error.detail = { classification: "manager_start", outcome: "indeterminate", startupLog,
        nextAction: "Перед новым запуском проверьте этот журнал запуска и фактическое состояние процессов; прежние журналы сохранены." };
      throw error;
    }
    if (!Number.isInteger(launched.pid) || !launched.created) fail("Не удалось подтвердить идентичность запущенного менеджера");
    const state = { ...claim, ...launched, status: "running" };
    fs.writeFileSync(ownerFile, JSON.stringify(state)); fs.writeFileSync(stateFile, JSON.stringify(state));
    return { status: "started", pid: state.pid, startupLog, diagnosticHint: "Если подключение MCP не готово, проверьте startupLog; прежние журналы сохранены.", readiness: "unverified" };
  });
}
