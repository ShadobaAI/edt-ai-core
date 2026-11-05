import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { path_identity } from "../scripts/project_paths.mjs";

export const digest = value => createHash("sha256").update(value).digest("hex");
export const fail = message => { throw new Error(message); };
export function object(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`Некорректное поле ${label}`);
  if (Object.keys(value).some(key => !keys.includes(key))) fail(`Неизвестное поле в ${label}`);
}
const text = (value, label) => {
  if (typeof value !== "string" || !value.trim() || /[\x00-\x1f]/.test(value)) fail(`Некорректное поле ${label}`);
  return value;
};
export function readJson(file, maxBytes = 1024 * 1024, expectedHash) {
  if (fs.statSync(file).size > maxBytes) fail("Файл JSON превышает допустимый размер");
  const bytes = fs.readFileSync(file);
  if (bytes.length > maxBytes) fail("Файл JSON превышает допустимый размер");
  if (expectedHash !== undefined && (!/^[a-f0-9]{64}$/.test(expectedHash) || digest(bytes) !== expectedHash)) fail("Аргументы инструмента изменились после разрешения; опишите и проверьте новые данные");
  try { return JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, "")); }
  catch { fail("Некорректный файл JSON"); }
}
export function loadProfile(file, expectedHash, clientName) {
  file = path_identity(file);
  const bytes = fs.readFileSync(file);
  if (bytes.length > 65536) fail("Файл JSON превышает допустимый размер");
  if (expectedHash !== undefined && (!/^[a-f0-9]{64}$/.test(expectedHash) || digest(bytes) !== expectedHash)) fail("Профиль запуска изменился после разрешения; опишите и проверьте новую цель");
  let raw;
  try { raw = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, "")); } catch { fail("Некорректный файл JSON"); }
  const base = path.dirname(file);
  object(raw, ["version", "id", "projectRoot", "platform", "runtime", "manager", "client", "clients", "mcp", "features", "results", "stateDir", "limits"], "profile");
  if (raw.version !== 1) fail("Неподдерживаемая версия профиля");
  if (typeof raw.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(raw.id)) fail("Некорректный идентификатор профиля");
  const resolve = (value, label) => path.resolve(base, text(value, label));
  const infobase = value => {
    object(value, ["type", "path", "server", "database"], "infobase");
    if (value.type === "file" && value.server === undefined && value.database === undefined) return { type: "file", path: resolve(value.path, "infobase path") };
    if (value.type === "server" && value.path === undefined) {
      for (const key of ["server", "database"]) if (/[;"']/.test(text(value[key], key))) fail(`Некорректное поле информационной базы ${key}`);
      return { type: "server", server: value.server, database: value.database };
    }
    fail("Некорректное указание информационной базы");
  };
  object(raw.runtime, ["epf", "navigationUrl", "paramsFile", "manifest"], "runtime");
  if (Object.hasOwn(raw.runtime, "epf") === Object.hasOwn(raw.runtime, "navigationUrl") || (Object.hasOwn(raw.runtime, "navigationUrl") && Object.hasOwn(raw.runtime, "manifest"))) fail("Для запуска требуется ровно один вариант: EPF или встроенный navigationUrl");
  for (const key of ["epf", "navigationUrl", "paramsFile", "manifest"]) if (Object.hasOwn(raw.runtime, key)) text(raw.runtime[key], `runtime ${key}`);
  if (raw.runtime.navigationUrl && !/^e1cib\/app\/[^\s;"\x00-\x1f]+$/i.test(raw.runtime.navigationUrl)) fail("Некорректный navigationUrl встроенного запуска");
  object(raw.manager, ["infobase", "user", "userEnv", "interface"], "manager");
  if (raw.manager.interface !== undefined && raw.manager.interface !== "taxi") fail("Неподдерживаемый интерфейс менеджера; требуется taxi");
  const auth = (value, label) => {
    if (Object.hasOwn(value, "user")) text(value.user, `${label} user`);
    if (Object.hasOwn(value, "userEnv") && (typeof value.userEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.userEnv))) fail(`Некорректная переменная окружения user для ${label}`);
    if (Object.hasOwn(value, "user") && Object.hasOwn(value, "userEnv")) fail(`Для ${label} нельзя одновременно указывать user и userEnv`);
    return { ...(value.user !== undefined ? { user: value.user } : {}), ...(value.userEnv !== undefined ? { userEnv: value.userEnv } : {}) };
  };
  const managerAuth = auth(raw.manager, "manager");
  const parseClient = value => {
    object(value, ["name", "infobase", "interface", "user", "userEnv", "computerName"], "client");
    if (Object.hasOwn(value, "computerName")) text(value.computerName, "client computer name");
    if (value.interface !== undefined && value.interface !== "taxi") fail("Неподдерживаемый интерфейс клиента; требуется taxi");
    return { name: text(value.name, "client name"), infobase: infobase(value.infobase), interface: "taxi", ...auth(value, "client"), computerName: value.computerName ?? "localhost" };
  };
  if (raw.clients !== undefined && (!Array.isArray(raw.clients) || raw.clients.length === 0)) fail("Некорректный список дополнительных клиентов");
  const clients = [raw.client, ...(raw.clients ?? [])].map(parseClient);
  if (new Set(clients.map(client => client.name)).size !== clients.length) fail("Повторное имя клиента");
  const baseKey = base => base.type === "file" ? `file:${process.platform === "win32" ? base.path.toLowerCase() : base.path}` : `server:${base.server.toLowerCase()}\u0000${base.database.toLowerCase()}`;
  if (clients.some(client => baseKey(client.infobase) !== baseKey(clients[0].infobase))) fail("Дополнительные клиенты должны использовать ту же информационную базу, что и основной клиент");
  const selectedClient = clientName === undefined ? clients[0] : clients.find(client => client.name === clientName);
  if (!selectedClient) fail("Неизвестное имя клиента");
  object(raw.mcp, ["serverName", "url", "port"], "mcp");
  let url;
  try { url = new URL(raw.mcp.url); } catch { fail("Некорректный URL MCP"); }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash ||
      !Number.isInteger(raw.mcp.port) || raw.mcp.port < 1 || raw.mcp.port > 65535 || Number(url.port || 80) !== raw.mcp.port) fail("MCP требует локальный URL HTTP и совпадающий порт");
  const serverName = raw.mcp.serverName ?? "vanessa";
  if (typeof serverName !== "string" || !/^[a-zA-Z0-9_-]+$/.test(serverName)) fail("Некорректное имя сервера MCP");
  if (Object.hasOwn(raw, "limits")) object(raw.limits, ["timeoutMs", "maxBytes"], "limits");
  if (Object.hasOwn(raw, "stateDir")) text(raw.stateDir, "stateDir");
  const limits = { timeoutMs: 30000, maxBytes: 1024 * 1024, ...raw.limits };
  object(limits, ["timeoutMs", "maxBytes"], "limits");
  if (!Number.isInteger(limits.timeoutMs) || limits.timeoutMs < 100 || limits.timeoutMs > 120000 || !Number.isInteger(limits.maxBytes) || limits.maxBytes < 1024 || limits.maxBytes > 8 * 1024 * 1024) fail("Некорректные ограничения профиля");
  const identity = digest(file);
  return { version: 1, id: raw.id, file, identity,
    projectRoot: resolve(raw.projectRoot, "project root"), platform: resolve(raw.platform, "platform"),
    runtime: { ...(raw.runtime.epf ? { epf: resolve(raw.runtime.epf, "runtime epf") } : { navigationUrl: raw.runtime.navigationUrl }), ...(raw.runtime.paramsFile ? { paramsFile: resolve(raw.runtime.paramsFile, "runtime paramsFile") } : {}), ...(raw.runtime.manifest ? { manifest: resolve(raw.runtime.manifest, "runtime manifest") } : {}) },
    manager: { infobase: infobase(raw.manager.infobase), interface: "taxi", ...managerAuth }, client: selectedClient, ...(raw.clients ? { ownerClient: clients[0] } : {}),
    mcp: { url: url.href, port: raw.mcp.port, serverName }, features: resolve(raw.features, "features"), results: resolve(raw.results, "results"),
    stateDir: raw.stateDir ? resolve(raw.stateDir, "stateDir") : path.join(base, ".vanessa", `${raw.id}-${identity.slice(0, 12)}`), limits };
}

export function connectionString(base) {
  if (base.type === "file") {
    if (/[;"\r\n]/.test(base.path)) fail("Недопустимые символы в пути информационной базы");
    return `File="${base.path}";`;
  }
  return `Srvr="${base.server}";Ref="${base.database}";`;
}
export function configuredUser(config, label, env = process.env) {
  if (config.user !== undefined && config.userEnv !== undefined) fail(`Для ${label} нельзя одновременно указывать user и userEnv`);
  if (config.user !== undefined) return text(config.user, `${label} user`);
  return config.userEnv !== undefined ? text(env[config.userEnv], `значение переменной окружения user для ${label}`) : undefined;
}
export function clientAdditionalParameters(profile, env = process.env) {
  const user = configuredUser(profile.client, "client", env);
  if (user === undefined) return "/iTaxi";
  return `/iTaxi /N"${user.replaceAll('"', '""')}"`;
}
export function startArguments(profile, env = process.env, { startupLog = path.join(profile.stateDir, `startup-${randomUUID()}.log`) } = {}) {
  const paramsFile = path.join(profile.stateDir, "interactive.json");
  if ([paramsFile, profile.projectRoot].some(value => /[;"\r\n]/.test(value))) fail("Недопустимые символы в пути запуска");
  const command = ["runMcp", `mcpPort=${profile.mcp.port}`, "UseEditor", `WorkspaceRoot=${profile.projectRoot}`, `VAParams=${paramsFile}`];
  const auth = [];
  const user = configuredUser(profile.manager, "manager", env);
  if (user !== undefined) auth.push("/N", user);
  return ["ENTERPRISE", "/TESTMANAGER", "/iTaxi", "/IBConnectionString", connectionString(profile.manager.infobase), ...auth,
    ...(profile.runtime.epf ? ["/Execute", profile.runtime.epf] : ["/URL", profile.runtime.navigationUrl]), "/Out", startupLog, "/C", command.join(";")];
}

// 1C's documented command-line parser doubles embedded quotes. It does not use
// CRT backslash-quote escaping for /IBConnectionString.
export function platformCommandLine(args) {
  return args.map(arg => /^[A-Za-z/][A-Za-z0-9/]*$/.test(arg) ? arg : '"' + arg.replaceAll('"', '""') + '"').join(" ");
}

export function interactiveParameters(profile, source = profile.runtime.paramsFile ? readJson(profile.runtime.paramsFile) : {}) {
  if (!source || typeof source !== "object" || Array.isArray(source)) fail("Некорректные параметры интерактивного запуска");
  const check = value => {
    if (Array.isArray(value)) return value.forEach(check);
    if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (/password|passwd|token|secret|credential|authorization|пароль/i.test(key) && item !== "" && item !== null) fail("Учётные данные запрещены в сохранённых параметрах интерактивного запуска");
        check(item);
      }
    } else if (typeof value === "string" && /(Pwd|Password|Token|Secret|Пароль)\s*[=:]\s*\S/i.test(value)) fail("Учётные данные запрещены в сохранённых параметрах интерактивного запуска");
  };
  check(source);
  for (const key of ["StartFeaturePlayer", "QuietInstallVanessaExt", "ТихаяУстановкаVanessaExt", "QuietInstallVanessaExtAndClose", "InstallVanessaExtOnFailOfQuietInstall", "InstallExtensionsAndClose", "УстановитьРасширенияИЗакрыть", "GenerateSmokeTest"]) {
    if (source[key] !== undefined && source[key] !== false) fail("Параметры интерактивного запуска содержат запрещённый режим выполнения или установки");
  }
  return { ...source,
    "ВыполнитьСценарии": false, "ЗавершитьРаботуСистемы": false,
    "ИспользоватьКомпонентуVanessaExt": true,
    "ИскатьЭлементыФормыПоИмени": true, "КаталогПроекта": profile.projectRoot, "КаталогФич": profile.features,
    "КаталогВыгрузкиJUnit": path.join(profile.results, "junit"), "КаталогВыгрузкиAllure": path.join(profile.results, "allure"),
    "КаталогВыгрузкиСкриншотов": path.join(profile.results, "screenshots") };
}

export function checkFiles(profile) {
  for (const file of [profile.platform, profile.runtime.epf].filter(Boolean)) if (!fs.statSync(file).isFile()) fail("Отсутствует обязательный исполняемый файл или файл запуска");
  for (const dir of [profile.projectRoot, profile.features]) if (!fs.statSync(dir).isDirectory()) fail("Отсутствует обязательный каталог проекта или сценариев");
  for (const base of [profile.manager.infobase, profile.client.infobase]) if (base.type === "file" && !fs.statSync(base.path).isDirectory()) fail("Отсутствует каталог информационной базы");
  if (profile.runtime.manifest) {
    const manifest = readJson(profile.runtime.manifest, 65536);
    if (manifest.version !== 1 || typeof manifest.product !== "string" || !manifest.product || typeof manifest.release !== "string" || !manifest.release || !Array.isArray(manifest.files) || !manifest.files.length || !/^[a-f0-9]{64}$/i.test(manifest.source?.sha256 ?? "")) fail("Некорректный манифест запуска");
    let source;
    try { source = new URL(manifest.source.url); } catch { fail("Некорректный источник манифеста запуска"); }
    if (source.protocol !== "https:" || source.username || source.password) fail("Некорректный источник манифеста запуска");
    const manifestRoot = path.dirname(profile.runtime.manifest);
    const entries = manifest.files.filter(entry => {
      if (typeof entry.path !== "string" || path.isAbsolute(entry.path) || !/^[a-f0-9]{64}$/i.test(entry.sha256 ?? "")) fail("Некорректная запись файла в манифесте запуска");
      const target = path.resolve(manifestRoot, entry.path), relative = path.relative(manifestRoot, target);
      if (relative.startsWith("..") || path.isAbsolute(relative)) fail("Файл манифеста запуска выходит за границы пакета");
      return target.toLowerCase() === profile.runtime.epf.toLowerCase();
    });
    if (entries.length !== 1) fail("EPF запуска не сопоставлен однозначно с манифестом");
    const actual = createHash("sha256").update(fs.readFileSync(profile.runtime.epf)).digest("hex");
    if (actual !== entries[0].sha256.toLowerCase()) fail("Нарушена целостность EPF запуска");
  }
  if (profile.runtime.paramsFile) {
    const params = readJson(profile.runtime.paramsFile);
    // Opt-in interactive settings are supplied separately; CI auto-run/exit is forbidden.
    if (params["ВыполнитьСценарии"] !== false || params["ЗавершитьРаботуСистемы"] !== false ||
        params["ИспользоватьКомпонентуVanessaExt"] !== true) fail("В интерактивных параметрах нужно явно отключить запуск и выход, а также включить VanessaExt");
    interactiveParameters(profile, params);
  }
}

export function configSnippet(profile) {
  return `[mcp_servers.${profile.mcp.serverName}]\nurl = ${JSON.stringify(profile.mcp.url)}\nstartup_timeout_sec = 30\ntool_timeout_sec = 120\n`;
}
