import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { windows_process_identity, windows_tcp_rows, match_mcp_binding, same_creation } from "../scripts/windows_process.mjs";
import { randomUUID } from "node:crypto";
import { path_identity } from "../scripts/project_paths.mjs";
import { withHttpMcp } from "../mcp/http-client.mjs";
import { digest, fail, readJson, startArguments, platformCommandLine, checkFiles, interactiveParameters } from "./profile.mjs";
import { listTools, callTool } from "./mcp.mjs";
import { sameInfobase, runtimeContract } from "./readiness.mjs";

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; } };
const endpointKey = profile => `endpoint-${profile.mcp.port}`;
// Only canonical filesystem identities can establish exclusive client control.
const clientKeyVersion = 3;
export const managerStartupTimeoutMs = 5 * 60 * 1000;
const managerPollIntervalMs = 2000, managerProbeTimeoutMs = 5000;
const systemDefaults = Object.freeze({
  platform: process.platform,
  processIdentity: windows_process_identity,
  tcpRows: () => [...windows_tcp_rows(2), ...windows_tcp_rows(23)],
  now: () => performance.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
});
const systemWith = overrides => ({ ...systemDefaults, ...overrides });

// A reused PID is stale only if its current image can be identified as not 1C.
// Unknown process state and all other 1C processes remain conservative.
function processState(profile, record, system) {
  if (!Number.isSafeInteger(record?.pid) || record.pid < 1 || record.pid > 0xffffffff) return { kind: "unknown" };
  if (system.platform !== "win32") return { kind: alive(record.pid) ? "unknown" : "absent" };
  let actual;
  try { actual = system.processIdentity(record.pid); } catch { return { kind: "unknown" }; }
  if (!actual) return { kind: "absent" };
  if (actual.pid !== record.pid || typeof actual.executable !== "string" || !actual.executable ||
      typeof actual.created !== "string" || !/^win32-filetime:\d+$/.test(actual.created)) return { kind: "unknown" };
  const image = path.win32.basename(actual.executable);
  const is1c = same_creation(actual, record.created) || /^(?:1cv8[^\\/]*|rphost|rmngr|ragent|ras|rac)\.exe$/i.test(image) ||
    typeof profile.platform === "string" && actual.executable.toLowerCase() === profile.platform.toLowerCase();
  return { kind: is1c ? "one_c" : "other", actual };
}
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

export function checkOwner(profile, { required = false, allowLiveConflict = false, system: overrides } = {}) {
  const system = systemWith(overrides);
  checkClaims(profile, { system });
  const file = path.join(registryDir(), `${endpointKey(profile)}.owner.json`);
  if (!fs.existsSync(file)) { if (required) fail("Подключение не принадлежит этому профилю; внешний менеджер не принимается под управление"); return null; }
  const owner = readJson(file, 4096);
  if (owner.profile !== profile.identity) fail("Запись владельца подключения принадлежит другому профилю; проверьте процесс и порт: запись может быть устаревшей");
  if (owner.clientKeyVersion !== clientKeyVersion) fail("Неподдерживаемая запись владельца менеджера; проверьте процессы и перенесите запись в архив перед новым запуском");
  if (!matchesFingerprint(profile, owner)) {
    const current = processState(profile, owner, system);
    if (owner.status === "starting" || current.kind === "unknown" || (current.kind === "one_c" && !allowLiveConflict))
      fail("Настройки запуска профиля изменились; требуется проверить владельца активного менеджера или запуска с неизвестным исходом");
    // For start only, a live 1C conflict is observed without accepting it as owner.
    // A dead PID or a PID now used by another application can be replaced later.
  }
  return owner;
}
// A client's credentials do not change the manager's launch. The application
// base still belongs to its isolation scope. Accept the prior exact fingerprint
// while its original profile remains unchanged, without adopting an unknown one.
function fingerprint(profile, parameters = interactiveParameters(profile)) { return digest(JSON.stringify([profile.platform, profile.runtime, profile.manager, { infobase: profile.client.infobase }, profile.stateDir, parameters])); }
function matchesFingerprint(profile, owner) {
  const previous = digest(JSON.stringify([profile.platform, profile.runtime, profile.manager, profile.ownerClient ?? profile.client, profile.stateDir, interactiveParameters(profile)]));
  return owner.fingerprint === fingerprint(profile) || owner.fingerprint === previous;
}
export function checkClaims(profile, { system: overrides } = {}) {
  const system = systemWith(overrides);
  const root = registryDir();
  if (!fs.existsSync(root)) return;
  for (const file of fs.readdirSync(root).filter(file => file.endsWith(".owner.json"))) {
    const owner = readJson(path.join(root, file), 4096);
    // Do not reinterpret another profile's claims using this profile's platform.
    const current = owner.profile === profile.identity ? processState(profile, owner, system) : null;
    const active = owner.status === "starting" || (current ? !["absent", "other"].includes(current.kind) : owner.pid && alive(owner.pid));
    if (!active) continue;
    if (owner.clientKeyVersion !== clientKeyVersion) fail("Неподдерживаемая запись владельца активного менеджера; проверьте процессы перед изменением записи");
    if (owner.profile === profile.identity && file !== `${endpointKey(profile)}.owner.json`) fail("Этот профиль уже владеет менеджером по другому адресу; настройки запуска изменились");
    if (owner.profile !== profile.identity && owner.client === clientControlKey(profile)) fail("TestClient принадлежит активному менеджеру другого профиля");
  }
}
export function managerAlive(profile, owner, { system: overrides } = {}) {
  if (!owner?.pid) return false;
  const system = systemWith(overrides);
  if (system.platform !== "win32") fail("Проверка идентичности процесса менеджера требует Windows");
  const current = processState(profile, owner, system);
  if (["absent", "other"].includes(current.kind)) return false;
  if (current.kind === "unknown") fail("Не удалось проверить процесс менеджера");
  if (current.actual.executable.toLowerCase() !== profile.platform.toLowerCase() || !same_creation(current.actual, owner.created)) fail("PID менеджера использован повторно или идентичность процесса изменилась");
  return true;
}
export const portAvailable = profile => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", error => error.code === "EADDRINUSE" ? resolve(false) : reject(new Error("Не удалось проверить доступность порта подключения")));
  server.listen({ host: new URL(profile.mcp.url).hostname.replace(/^\[|\]$/g, ""), port: profile.mcp.port, exclusive: true }, () => server.close(() => resolve(true)));
});

function sameObservedProcess(observed, system) {
  const actual = system.processIdentity(observed.pid);
  return Boolean(actual && actual.pid === observed.pid && actual.created === observed.created &&
    actual.executable.toLowerCase() === observed.executable.toLowerCase());
}
function verifiedManagerConnection(profile, observed, system, socket) {
  try {
    if (!socket) return false;
    const matches = () => match_mcp_binding(system.tcpRows(socket), profile.mcp.port, observed.pid, process.pid, socket);
    return Boolean(sameObservedProcess(observed, system) && matches() && sameObservedProcess(observed, system) && matches());
  } catch { return false; }
}

// Verify the concrete socket before Node is allowed to send HTTP headers or
// body. A fresh connection is verified for every request, including reconnects.
function guardedFetch(guard) {
  let connectionCheck;
  const transport = (url, { method, headers, signal, body }) => new Promise((resolve, reject) => {
    const agent = new http.Agent({ keepAlive: false });
    agent.createConnection = (options, callback) => {
      const socket = net.createConnection({ host: options.host, port: options.port, family: options.family, signal });
      let settled = false;
      const complete = (error, value) => {
        if (settled) return;
        settled = true;
        if (error) socket.destroy();
        callback(error, value);
      };
      socket.once("error", error => complete(error));
      socket.once("connect", () => {
        try {
          if (signal?.aborted || !guard(socket)) return complete(new Error("Связь MCP с процессом менеджера не подтверждена"));
          if (connectionCheck) connectionCheck(socket);
          complete(null, socket);
        } catch { complete(new Error("Связь MCP с процессом менеджера не подтверждена")); }
      });
      // Returning a socket here would let the agent transmit before verification.
      return undefined;
    };
    let request;
    try {
      if (url.protocol !== "http:") throw new Error("Требуется локальный HTTP MCP");
      request = http.request(url, { method, headers: Object.fromEntries(headers.entries()), agent, signal }, response => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item);
          else if (value !== undefined) responseHeaders.set(name, value);
        }
        response.once("close", () => agent.destroy());
        const status = response.statusCode ?? 0;
        resolve({ status, ok: status >= 200 && status < 300, headers: responseHeaders, body: Readable.toWeb(response) });
      });
      request.once("error", error => { agent.destroy(); reject(error); });
      request.end(body);
    } catch (error) { agent.destroy(); reject(error); }
  });
  transport.checkDuringRequest = async (check, request) => {
    if (connectionCheck) throw new Error("Проверка связи MCP уже выполняется");
    let observed = 0, result;
    connectionCheck = socket => {
      if (++observed !== 1) throw new Error("Неоднозначное соединение MCP");
      result = check(socket);
      if (result && typeof result.then === "function") throw new Error("Проверка сокета должна завершиться до отправки запроса");
    };
    try { return await request() === true && observed === 1 ? result : null; }
    finally { connectionCheck = undefined; }
  };
  return transport;
}

// Neither an endpoint alone nor a stale owner record authorizes credentials.
export function verifyOwnedManager(profile, expected, { system: overrides } = {}) {
  const system = systemWith(overrides);
  const sameRecord = record => record && record.status === "running" && record.profile === profile.identity &&
    record.pid === expected?.pid && record.created === expected?.created && record.fingerprint === expected?.fingerprint &&
    record.client === clientControlKey(profile) && record.clientKeyVersion === clientKeyVersion;
  const recordsMatch = () => {
    const owner = checkOwner(profile, { required: true, system });
    const state = readJson(path.join(profile.stateDir, "manager.json"), 4096);
    return sameRecord(owner) && sameRecord(state) && matchesFingerprint(profile, owner);
  };
  try {
    if (system.platform !== "win32" || !recordsMatch()) return false;
    const observed = { pid: expected.pid, executable: profile.platform, created: expected.created };
    return sameObservedProcess(observed, system) && recordsMatch();
  } catch { return false; }
}

export function ownedManagerTransport(profile, owner, { system: overrides } = {}) {
  const system = systemWith(overrides), observed = { pid: owner.pid, executable: profile.platform, created: owner.created };
  return guardedFetch(socket => verifyOwnedManager(profile, owner, { system }) &&
    verifiedManagerConnection(profile, observed, system, socket) && verifyOwnedManager(profile, owner, { system }));
}

// Confirm both the environment and the particular MCP connection to the
// observed process. An endpoint answering on the same port is not ownership.
export async function probeManager(profile, observed, { system: overrides, timeoutMs = managerProbeTimeoutMs } = {}) {
  const system = systemWith(overrides);
  let bindingDenied = false;
  const transportFetch = guardedFetch(socket => {
    const valid = verifiedManagerConnection(profile, observed, system, socket);
    if (!valid) bindingDenied = true;
    return valid;
  });
  try {
    const result = await withHttpMcp({ url: profile.mcp.url }, async client => {
      const tools = await listTools(client);
      if (!tools.some(tool => tool.name === "get_environment_data")) return { status: "pending", reason: "manager_mcp_contract_unverified" };
      const environment = runtimeContract.environment(await callTool(client, tools, "get_environment_data", {}));
      if (!environment) return { status: "pending", reason: "manager_environment_unverified" };
      if (!sameInfobase(profile.manager.infobase, environment.managerInfobase)) return { status: "unverified", reason: "manager_infobase_mismatch" };
      try { if (!sameObservedProcess(observed, system)) return { status: "unverified", reason: "manager_process_changed" }; }
      catch { return { status: "unverified", reason: "manager_process_unverified" }; }
      return { status: "ready", runtimeVersion: environment.runtimeVersion };
    }, { timeout: timeoutMs, maxBytes: profile.limits.maxBytes, transportFetch });
    if (bindingDenied) return { status: "unverified", reason: "manager_mcp_binding_unverified" };
    if (result.status === "ready") {
      try { if (!sameObservedProcess(observed, system)) return { status: "unverified", reason: "manager_process_changed" }; }
      catch { return { status: "unverified", reason: "manager_process_unverified" }; }
    }
    return result;
  } catch {
    // Startup, transport and server errors may be transient. This is a read-only
    // probe; never expose server text or retry a process launch here.
    return bindingDenied ? { status: "unverified", reason: "manager_mcp_binding_unverified" } : { status: "pending" };
  }
}

export async function waitForManager(profile, observed, { system: overrides } = {}) {
  const system = systemWith(overrides), timeout = system.startupTimeoutMs ?? managerStartupTimeoutMs,
    interval = system.pollIntervalMs ?? managerPollIntervalMs, deadline = system.now() + timeout;
  const probe = system.probeManager ?? probeManager;
  let lastObservation;
  for (;;) {
    const current = processState(profile, { pid: observed.pid }, system);
    if (current.kind === "unknown") return { status: "unverified", reason: "manager_process_unverified" };
    if (current.kind === "absent") return { status: "unverified", reason: "manager_process_exited" };
    if (current.kind !== "one_c" || current.actual.created !== observed.created ||
        current.actual.executable.toLowerCase() !== observed.executable.toLowerCase())
      return { status: "unverified", reason: "manager_process_changed" };
    const remaining = deadline - system.now();
    if (remaining <= 0) return { status: "unverified", reason: "manager_mcp_timeout", ...(lastObservation ? { observation: lastObservation } : {}) };
    const result = await probe(profile, observed, { system, timeoutMs: Math.min(managerProbeTimeoutMs, remaining) });
    if (result.status !== "pending") return result;
    lastObservation = result.reason;
    const wait = Math.min(interval, deadline - system.now());
    if (wait <= 0) return { status: "unverified", reason: "manager_mcp_timeout", ...(lastObservation ? { observation: lastObservation } : {}) };
    await system.sleep(wait);
  }
}

const choice = "Проверьте фактическое состояние 1С и MCP и выберите: перезапустить менеджер или запустить MCP самостоятельно; автоматического перезапуска нет.";
function unavailableManager(observed, result, startupLog) {
  return { status: "unverified", reason: result.reason, ...(result.observation ? { observation: result.observation } : {}),
    pid: observed.pid, ...(startupLog ? { startupLog } : {}), nextAction: choice };
}

async function launchManager(profile, commandLine) {
  const child = spawn(profile.platform, [commandLine], {
    cwd: profile.projectRoot, windowsHide: false, windowsVerbatimArguments: true,
    argv0: '"' + profile.platform + '"', detached: true, stdio: "ignore", shell: false,
  });
  await once(child, "spawn");
  child.unref();
  return child.pid;
}

export async function start(profile, { system: overrides } = {}) {
  const system = systemWith(overrides);
  if (system.platform !== "win32") fail("Запуск менеджера требует Windows");
  checkFiles(profile);
  return withProfileLock(profile, async () => {
    const stateFile = path.join(profile.stateDir, "manager.json");
    const getState = () => fs.existsSync(stateFile) ? readJson(stateFile, 4096) : null;
    const owner = checkOwner(profile, { allowLiveConflict: true, system }), priorState = getState();
    const unchanged = (expectedOwner, expectedState) => {
      try {
        return JSON.stringify(checkOwner(profile, { allowLiveConflict: true, system })) === JSON.stringify(expectedOwner) &&
          JSON.stringify(getState()) === JSON.stringify(expectedState);
      } catch { return false; }
    };
    if (priorState && priorState.profile !== profile.identity) fail("Каталог состояния принадлежит другому профилю");
    const records = [owner, priorState].filter(Boolean);
    if (records.some(record => record.status === "starting")) fail("Исход предыдущего запуска неизвестен; перед перезапуском вручную проверьте состояние менеджера");
    if (records.some(record => record.status !== "running")) fail("Не удалось подтвердить состояние предыдущего запуска менеджера");
    const observations = records.map(record => ({ record, current: processState(profile, record, system) }));
    if (observations.some(item => item.current.kind === "unknown")) fail("Не удалось проверить процесс менеджера; перед запуском проверьте его состояние");
    const live = observations.filter(item => item.current.kind === "one_c");
    if (live.length) {
      const observed = live[0].current.actual;
      if (live.some(item => item.current.actual.pid !== observed.pid || item.current.actual.created !== observed.created))
        return unavailableManager(observed, { reason: "multiple_manager_processes_unverified" });
      const owned = owner && owner.pid === observed.pid && same_creation(observed, owner.created) &&
        observed.executable.toLowerCase() === profile.platform.toLowerCase() && matchesFingerprint(profile, owner);
      const result = await waitForManager(profile, observed, { system });
      if (result.status !== "ready") return unavailableManager(observed, result, live[0].record.startupLog);
      if (!owned) return unavailableManager(observed, { reason: "manager_ownership_unverified" }, live[0].record.startupLog);
      if (!unchanged(owner, priorState)) return unavailableManager(observed, { reason: "manager_ownership_changed" }, owner.startupLog);
      return { status: "running", pid: observed.pid, ...(owner.startupLog ? { startupLog: owner.startupLog } : {}),
        readiness: "manager_mcp_ready", runtimeVersion: result.runtimeVersion };
    }
    if (!await portAvailable(profile)) fail("Порт подключения занят; внешний менеджер не принимается под управление");
    const startupLog = path.join(profile.stateDir, `startup-${randomUUID()}.log`);
    const commandLine = platformCommandLine(startArguments(profile, process.env, { startupLog }));
    fs.mkdirSync(profile.stateDir, { recursive: true });
    fs.mkdirSync(profile.results, { recursive: true });
    const interactiveTemp = path.join(profile.stateDir, `.interactive-${randomUUID()}.tmp`);
    const parameters = interactiveParameters(profile);
    fs.writeFileSync(interactiveTemp, JSON.stringify(parameters, null, 2) + "\n", { flag: "wx" });
    let claim;
    const ownerFile = path.join(registryDir(), `${endpointKey(profile)}.owner.json`);
    try {
      claim = { profile: profile.identity, fingerprint: fingerprint(profile, parameters), client: clientControlKey(profile), clientKeyVersion, startupLog, status: "starting" };
      // Locks serialize cooperating callers. Recheck both records and process
      // identities immediately before claiming a launch after stale PIDs.
      const latestOwner = checkOwner(profile, { allowLiveConflict: true, system }), latestState = getState();
      if (JSON.stringify(latestOwner) !== JSON.stringify(owner) || JSON.stringify(latestState) !== JSON.stringify(priorState))
        fail("Запись владельца менеджера изменилась; повторно проверьте состояние");
      if ([latestOwner, latestState].filter(Boolean).some(record => !["absent", "other"].includes(processState(profile, record, system).kind)))
        fail("Процесс менеджера изменился; повторно проверьте состояние");
      if (JSON.stringify(interactiveParameters(profile)) !== JSON.stringify(parameters)) fail("Параметры запуска изменились; повторно проверьте состояние");
      const oldState = priorState ? fs.readFileSync(stateFile) : null, oldOwner = owner ? fs.readFileSync(ownerFile) : null;
      const claimText = JSON.stringify(claim);
      let stateAttempted = false, ownerAttempted = false;
      try {
        // Exclusive creation also isolates two profiles sharing a stateDir.
        stateAttempted = true;
        fs.writeFileSync(stateFile, claimText, priorState ? {} : { flag: "wx" });
        ownerAttempted = true;
        fs.writeFileSync(ownerFile, claimText);
        fs.renameSync(interactiveTemp, path.join(profile.stateDir, "interactive.json"));
      } catch (error) {
        // No launch was dispatched. Restore only a reservation still containing
        // our exact claim; never erase a replaced or partially written record.
        const restore = (file, previous, attempted) => {
          if (!attempted || !fs.existsSync(file) || fs.readFileSync(file, "utf8") !== claimText) return;
          if (previous) fs.writeFileSync(file, previous); else fs.unlinkSync(file);
        };
        try { restore(ownerFile, oldOwner, ownerAttempted); restore(stateFile, oldState, stateAttempted); }
        catch { fail("Подготовка запуска не выполнена; проверьте записи резервирования менеджера перед повтором"); }
        throw error;
      }
    } finally { if (fs.existsSync(interactiveTemp)) fs.unlinkSync(interactiveTemp); }
    let launched;
    try {
      // Preserve the platform's doubled quote contract in the raw Windows command line.
      const pid = await (system.launchManager ?? launchManager)(profile, commandLine);
      const identity = system.processIdentity(pid);
      if (!identity || identity.pid !== pid || identity.executable.toLowerCase() !== profile.platform.toLowerCase() ||
          !/^win32-filetime:\d+$/.test(identity.created ?? "")) throw new Error("Не удалось подтвердить идентичность запущенного менеджера");
      launched = identity;
    } catch (error) {
      error.code = "manager_launch_indeterminate";
      error.detail = { classification: "manager_start", outcome: "indeterminate", startupLog,
        nextAction: "Перед новым запуском проверьте этот журнал запуска и фактическое состояние процессов; прежние журналы сохранены." };
      throw error;
    }
    const state = { ...claim, pid: launched.pid, created: launched.created, status: "running" };
    try { fs.writeFileSync(ownerFile, JSON.stringify(state)); fs.writeFileSync(stateFile, JSON.stringify(state)); }
    catch {
      const error = new Error("Не удалось сохранить идентичность запущенного менеджера; проверьте процесс перед повтором");
      error.code = "manager_launch_indeterminate";
      error.detail = { classification: "manager_start", outcome: "indeterminate", pid: launched.pid, startupLog, nextAction: error.message };
      throw error;
    }
    const result = await waitForManager(profile, launched, { system });
    if (result.status !== "ready") return unavailableManager(launched, result, startupLog);
    if (!unchanged(state, state)) return unavailableManager(launched, { reason: "manager_ownership_changed" }, startupLog);
    return { status: "started", pid: state.pid, startupLog, readiness: "manager_mcp_ready", runtimeVersion: result.runtimeVersion };
  });
}
