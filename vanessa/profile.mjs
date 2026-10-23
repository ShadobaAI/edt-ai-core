import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const digest = value => createHash("sha256").update(value).digest("hex");
export const fail = message => { throw new Error(message); };
export function object(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`invalid ${label}`);
  if (Object.keys(value).some(key => !keys.includes(key))) fail(`unknown field in ${label}`);
}
const text = (value, label) => {
  if (typeof value !== "string" || !value.trim() || /[\x00-\x1f]/.test(value)) fail(`invalid ${label}`);
  return value;
};
export function readJson(file, maxBytes = 1024 * 1024, expectedHash) {
  if (fs.statSync(file).size > maxBytes) fail("JSON file exceeds size limit");
  const bytes = fs.readFileSync(file);
  if (bytes.length > maxBytes) fail("JSON file exceeds size limit");
  if (expectedHash !== undefined && (!/^[a-f0-9]{64}$/.test(expectedHash) || digest(bytes) !== expectedHash)) fail("tool arguments changed after authorization; describe and verify the new payload");
  try { return JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, "")); }
  catch { fail("invalid JSON file"); }
}
export function loadProfile(file, expectedHash) {
  file = path.resolve(file);
  const bytes = fs.readFileSync(file);
  if (bytes.length > 65536) fail("JSON file exceeds size limit");
  if (expectedHash !== undefined && (!/^[a-f0-9]{64}$/.test(expectedHash) || digest(bytes) !== expectedHash)) fail("runtime profile changed after authorization; describe and verify the new target");
  let raw;
  try { raw = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, "")); } catch { fail("invalid JSON file"); }
  const base = path.dirname(file);
  object(raw, ["version", "id", "projectRoot", "platform", "runtime", "manager", "client", "mcp", "features", "results", "stateDir", "limits"], "profile");
  if (raw.version !== 1) fail("unsupported profile version");
  if (typeof raw.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(raw.id)) fail("invalid profile id");
  const resolve = (value, label) => path.resolve(base, text(value, label));
  const infobase = value => {
    object(value, ["type", "path", "server", "database"], "infobase");
    if (value.type === "file" && value.server === undefined && value.database === undefined) return { type: "file", path: resolve(value.path, "infobase path") };
    if (value.type === "server" && value.path === undefined) {
      for (const key of ["server", "database"]) if (/[;"']/.test(text(value[key], key))) fail(`invalid infobase ${key}`);
      return { type: "server", server: value.server, database: value.database };
    }
    fail("invalid infobase selector");
  };
  object(raw.runtime, ["epf", "navigationUrl", "paramsFile", "manifest"], "runtime");
  if (Object.hasOwn(raw.runtime, "epf") === Object.hasOwn(raw.runtime, "navigationUrl") || (Object.hasOwn(raw.runtime, "navigationUrl") && Object.hasOwn(raw.runtime, "manifest"))) fail("runtime requires exactly one EPF or embedded navigationUrl");
  for (const key of ["epf", "navigationUrl", "paramsFile", "manifest"]) if (Object.hasOwn(raw.runtime, key)) text(raw.runtime[key], `runtime ${key}`);
  if (raw.runtime.navigationUrl && !/^e1cib\/app\/[^\s;"\x00-\x1f]+$/i.test(raw.runtime.navigationUrl)) fail("invalid embedded runtime navigationUrl");
  object(raw.manager, ["infobase", "userEnv", "interface"], "manager");
  if (raw.manager.interface !== undefined && raw.manager.interface !== "taxi") fail("unsupported manager interface; taxi is required");
  if (Object.hasOwn(raw.manager, "userEnv") && (typeof raw.manager.userEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw.manager.userEnv))) fail("invalid manager user environment variable");
  object(raw.client, ["name", "infobase", "interface", "userEnv", "computerName"], "client");
  if (Object.hasOwn(raw.client, "computerName")) text(raw.client.computerName, "client computer name");
  if (Object.hasOwn(raw.client, "userEnv") && (typeof raw.client.userEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw.client.userEnv))) fail("invalid client user environment variable");
  if (raw.client.interface !== undefined && raw.client.interface !== "taxi") fail("unsupported client interface; taxi is required");
  object(raw.mcp, ["serverName", "url", "port"], "mcp");
  let url;
  try { url = new URL(raw.mcp.url); } catch { fail("invalid MCP URL"); }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash ||
      !Number.isInteger(raw.mcp.port) || raw.mcp.port < 1 || raw.mcp.port > 65535 || Number(url.port || 80) !== raw.mcp.port) fail("MCP must use a matching loopback HTTP URL and port");
  const serverName = raw.mcp.serverName ?? "vanessa";
  if (typeof serverName !== "string" || !/^[a-zA-Z0-9_-]+$/.test(serverName)) fail("invalid MCP server name");
  if (Object.hasOwn(raw, "limits")) object(raw.limits, ["timeoutMs", "maxBytes"], "limits");
  if (Object.hasOwn(raw, "stateDir")) text(raw.stateDir, "stateDir");
  const limits = { timeoutMs: 30000, maxBytes: 1024 * 1024, ...raw.limits };
  object(limits, ["timeoutMs", "maxBytes"], "limits");
  if (!Number.isInteger(limits.timeoutMs) || limits.timeoutMs < 100 || limits.timeoutMs > 120000 || !Number.isInteger(limits.maxBytes) || limits.maxBytes < 1024 || limits.maxBytes > 8 * 1024 * 1024) fail("invalid profile limits");
  const identity = digest(process.platform === "win32" ? file.toLowerCase() : file);
  return { version: 1, id: raw.id, file, identity,
    projectRoot: resolve(raw.projectRoot, "project root"), platform: resolve(raw.platform, "platform"),
    runtime: { ...(raw.runtime.epf ? { epf: resolve(raw.runtime.epf, "runtime epf") } : { navigationUrl: raw.runtime.navigationUrl }), ...(raw.runtime.paramsFile ? { paramsFile: resolve(raw.runtime.paramsFile, "runtime paramsFile") } : {}), ...(raw.runtime.manifest ? { manifest: resolve(raw.runtime.manifest, "runtime manifest") } : {}) },
    manager: { infobase: infobase(raw.manager.infobase), interface: "taxi", ...(raw.manager.userEnv ? { userEnv: raw.manager.userEnv } : {}) }, client: { name: text(raw.client.name, "client name"), infobase: infobase(raw.client.infobase), interface: "taxi", ...(raw.client.userEnv ? { userEnv: raw.client.userEnv } : {}), computerName: raw.client.computerName ?? "localhost" },
    mcp: { url: url.href, port: raw.mcp.port, serverName }, features: resolve(raw.features, "features"), results: resolve(raw.results, "results"),
    stateDir: raw.stateDir ? resolve(raw.stateDir, "stateDir") : path.join(base, ".vanessa", `${raw.id}-${identity.slice(0, 12)}`), limits };
}

export function connectionString(base) {
  if (base.type === "file") {
    if (/[;"\r\n]/.test(base.path)) fail("unsupported infobase path characters");
    return `File="${base.path}";`;
  }
  return `Srvr="${base.server}";Ref="${base.database}";`;
}
export function clientAdditionalParameters(profile, env = process.env) {
  if (!profile.client.userEnv) return "/iTaxi";
  const user = text(env[profile.client.userEnv], "client user environment value");
  return `/iTaxi /N"${user.replaceAll('"', '""')}"`;
}
export function startArguments(profile, env = process.env, { startupLog = path.join(profile.stateDir, `startup-${randomUUID()}.log`) } = {}) {
  const paramsFile = path.join(profile.stateDir, "interactive.json");
  if ([paramsFile, profile.projectRoot].some(value => /[;"\r\n]/.test(value))) fail("unsupported startup path characters");
  const command = ["runMcp", `mcpPort=${profile.mcp.port}`, "UseEditor", `WorkspaceRoot=${profile.projectRoot}`, `VAParams=${paramsFile}`];
  const auth = [];
  if (profile.manager.userEnv) auth.push("/N", text(env[profile.manager.userEnv], "manager user environment value"));
  return ["ENTERPRISE", "/TESTMANAGER", "/iTaxi", "/IBConnectionString", connectionString(profile.manager.infobase), ...auth,
    ...(profile.runtime.epf ? ["/Execute", profile.runtime.epf] : ["/URL", profile.runtime.navigationUrl]), "/Out", startupLog, "/C", command.join(";")];
}

// 1C's documented command-line parser doubles embedded quotes. It does not use
// CRT backslash-quote escaping for /IBConnectionString.
export function platformCommandLine(args) {
  return args.map(arg => /^[A-Za-z/][A-Za-z0-9/]*$/.test(arg) ? arg : '"' + arg.replaceAll('"', '""') + '"').join(" ");
}

export function interactiveParameters(profile, source = profile.runtime.paramsFile ? readJson(profile.runtime.paramsFile) : {}) {
  if (!source || typeof source !== "object" || Array.isArray(source)) fail("invalid interactive parameters");
  const check = value => {
    if (Array.isArray(value)) return value.forEach(check);
    if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (/password|passwd|token|secret|credential|authorization|пароль/i.test(key) && item !== "" && item !== null) fail("credentials are not supported in persisted interactive parameters");
        check(item);
      }
    } else if (typeof value === "string" && /(Pwd|Password|Token|Secret|Пароль)\s*[=:]\s*\S/i.test(value)) fail("credentials are not supported in persisted interactive parameters");
  };
  check(source);
  for (const key of ["StartFeaturePlayer", "QuietInstallVanessaExt", "ТихаяУстановкаVanessaExt", "QuietInstallVanessaExtAndClose", "InstallVanessaExtOnFailOfQuietInstall", "InstallExtensionsAndClose", "УстановитьРасширенияИЗакрыть", "GenerateSmokeTest"]) {
    if (source[key] !== undefined && source[key] !== false) fail("interactive parameters contain a forbidden execution or installation mode");
  }
  return { ...source,
    "ВыполнитьСценарии": false, "ЗавершитьРаботуСистемы": false,
    "ИспользоватьКомпонентуVanessaExt": true,
    "ИскатьЭлементыФормыПоИмени": true, "КаталогПроекта": profile.projectRoot, "КаталогФич": profile.features,
    "КаталогВыгрузкиJUnit": path.join(profile.results, "junit"), "КаталогВыгрузкиAllure": path.join(profile.results, "allure"),
    "КаталогВыгрузкиСкриншотов": path.join(profile.results, "screenshots") };
}

export function checkFiles(profile) {
  for (const file of [profile.platform, profile.runtime.epf].filter(Boolean)) if (!fs.statSync(file).isFile()) fail("required executable/runtime file missing");
  for (const dir of [profile.projectRoot, profile.features]) if (!fs.statSync(dir).isDirectory()) fail("required project/features directory missing");
  for (const base of [profile.manager.infobase, profile.client.infobase]) if (base.type === "file" && !fs.statSync(base.path).isDirectory()) fail("infobase directory missing");
  if (profile.runtime.manifest) {
    const manifest = readJson(profile.runtime.manifest, 65536);
    if (manifest.version !== 1 || typeof manifest.product !== "string" || !manifest.product || typeof manifest.release !== "string" || !manifest.release || !Array.isArray(manifest.files) || !manifest.files.length || !/^[a-f0-9]{64}$/i.test(manifest.source?.sha256 ?? "")) fail("invalid runtime manifest");
    let source;
    try { source = new URL(manifest.source.url); } catch { fail("invalid runtime manifest source"); }
    if (source.protocol !== "https:" || source.username || source.password) fail("invalid runtime manifest source");
    const manifestRoot = path.dirname(profile.runtime.manifest);
    const entries = manifest.files.filter(entry => {
      if (typeof entry.path !== "string" || path.isAbsolute(entry.path) || !/^[a-f0-9]{64}$/i.test(entry.sha256 ?? "")) fail("invalid runtime manifest file entry");
      const target = path.resolve(manifestRoot, entry.path), relative = path.relative(manifestRoot, target);
      if (relative.startsWith("..") || path.isAbsolute(relative)) fail("runtime manifest file escapes bundle");
      return target.toLowerCase() === profile.runtime.epf.toLowerCase();
    });
    if (entries.length !== 1) fail("runtime EPF is not uniquely covered by manifest");
    const actual = createHash("sha256").update(fs.readFileSync(profile.runtime.epf)).digest("hex");
    if (actual !== entries[0].sha256.toLowerCase()) fail("runtime EPF integrity mismatch");
  }
  if (profile.runtime.paramsFile) {
    const params = readJson(profile.runtime.paramsFile);
    // Opt-in interactive settings are supplied separately; CI auto-run/exit is forbidden.
    if (params["ВыполнитьСценарии"] !== false || params["ЗавершитьРаботуСистемы"] !== false ||
        params["ИспользоватьКомпонентуVanessaExt"] !== true) fail("interactive params must explicitly disable run/exit and enable VanessaExt");
    interactiveParameters(profile, params);
  }
}

export function configSnippet(profile) {
  return `[mcp_servers.${profile.mcp.serverName}]\nurl = ${JSON.stringify(profile.mcp.url)}\nstartup_timeout_sec = 30\ntool_timeout_sec = 120\n`;
}
