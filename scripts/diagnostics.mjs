// Local operational telemetry. Never record MCP arguments, results or source.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

export const LOG_POLICY = Object.freeze({ files: 4, fileBytes: 512 * 1024, days: 7, eventBytes: 8192 });
export const LOG_FORMAT_VERSION = 2;
const failureCategories = new Set(["configuration", "transport", "authorization", "server_contract", "access_scope", "index"]);
export function verification_limits(knowledgeVerified = false) {
  return { hostHookTrust: "not_verified", hostHookActivation: "not_verified", hostEffectiveToolCatalogue: "not_verified",
    serverReadBoundary: knowledgeVerified ? "externally_attested" : "not_verified",
    serverEnforcementByPlugin: "not_verified", bypassResistanceByPlugin: "not_verified",
    destructiveAccessProbes: "not_performed", corpusQuality: "not_verified", deploymentLiveAcceptance: "not_verified" };
}
// Use numeric transport evidence and the local validation phase, never an
// upstream error message as authority for classifying a failure.
export function connection_failure(error, phase = "transport") {
  const status = Number.isInteger(error?.status) ? error.status : Number.isInteger(error?.httpStatus) ? error.httpStatus : undefined;
  const code = error?.cause?.code || error?.code;
  const category = status === 401 || status === 403 ? "authorization"
    : status >= 500 || status === 408 || status === 429 ||
      ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"].includes(code) ||
      ["AbortError", "TimeoutError"].includes(error?.name) ? "transport"
    : error instanceof SyntaxError ? "server_contract"
    : failureCategories.has(error?.category) ? error.category
    : status || Number.isInteger(error?.code) ? "server_contract"
    : failureCategories.has(phase) ? phase : "transport";
  const rpcCode = Number.isInteger(error?.code) ? error.code : error?.rpcCode;
  return { category, ...(status ? { httpStatus: status } : {}), ...(Number.isInteger(rpcCode) ? { rpcCode } : {}) };
}
const secretKey = /password|passwd|pwd|secret|token|credential|authorization|api.?key|cookie|private.?key|binding.?key|connection.?string|строкасоединения|пароль|имяпользователя/i;
const omittedKey = /^(?:env|environment|headers|args|arguments|command|text|content|sourceCode)$/i;
const registered = new Set();
export function register_diagnostic_secrets(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (["headers_env", "openvikingHeadersEnv"].includes(key) && child && typeof child === "object") {
      for (const variable of Object.values(child)) if (process.env[variable]) registered.add(process.env[variable]);
    }
    else if (secretKey.test(key) && typeof child === "string" && child.length >= 4) registered.add(child);
    if (child && typeof child === "object") register_diagnostic_secrets(child);
  }
}
export function diagnostic_state() {
  return process.env.EDT_AI_STATE_DIR || path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "1c-ai-core");
}
// A bounded view of declarations, not proof of the host's effective catalogue.
// Return findings only: config text, endpoints, commands and env values stay local.
export function environment_compatibility({ projectRoot = null, pluginRoot = fileURLToPath(new URL("..", import.meta.url)), codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex") } = {}) {
  const files = [...new Set([path.join(pluginRoot, "mcp.json"), path.join(codexHome, "config.toml"),
    ...(projectRoot ? [path.join(projectRoot, ".codex/config.toml")] : [])])];
  const sources = [], findings = [];
  const declaration_line = raw => {
    let quote = null, escaped = false;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (escaped) { escaped = false; continue; }
      if (quote === '"' && ch === "\\") { escaped = true; continue; }
      if (!quote && ch === "#") return raw.slice(0, i).trim();
      if (quote === ch) quote = null;
      else if (!quote && ["'", '"'].includes(ch)) quote = ch;
    }
    return raw.trim();
  };
  const closes_multiline = (raw, quote) => {
    for (let at = raw.indexOf(quote); at !== -1; at = raw.indexOf(quote, at + 1)) {
      let escapes = 0;
      if (quote === '"""') for (let i = at - 1; i >= 0 && raw[i] === "\\"; i--) escapes++;
      if (escapes % 2 === 0) return true;
    }
    return false;
  };
  const check = (entry, file, bundled) => {
    const tokens = [entry.name, entry.command, ...(Array.isArray(entry.args) ? entry.args : [])].filter(value => typeof value === "string").join(" ");
    for (const route of ["1c-docs-mcp", "1c-ssl-mcp", "HelpSearchServer"])
      if (tokens.toLowerCase().includes(route.toLowerCase())) findings.push({ code: "forbidden_route", route, file, enabled: entry.enabled !== false, evidence: "configuration_declaration" });
    const component = ["edt", "v8std", "openviking"].find(id => new RegExp("(?:^|[-_])" + id + "(?:$|[-_])", "i").test(entry.name));
    if (!bundled && component && entry.enabled !== false) findings.push({ code: "parallel_connection", component, file, evidence: "configuration_declaration", resolution: "Check the assigned plugin relay and remove competing host routes explicitly; no configuration was changed." });
    if (entry.captureDeclared && entry.enabled !== false) findings.push({ code: "auto_capture", file, evidence: "configuration_declaration" });
  };
  for (const file of files) {
    try {
      if (fs.lstatSync(path.dirname(file)).isSymbolicLink()) throw new Error("linked_directory");
      const stat = regular(file);
      if (stat.size > 256 * 1024) { sources.push({ file, state: "size_limit" }); continue; }
      const text = fs.readFileSync(file, "utf8"), bundled = file === files[0];
      if (file.endsWith(".json")) {
        const data = JSON.parse(text);
        for (const [name, entry] of Object.entries(data.mcpServers || {})) check({ ...entry, name }, file, bundled);
        const visit = value => {
          if (!value || typeof value !== "object" || value.enabled === false) return;
          for (const [key, child] of Object.entries(value)) {
            if (/^(auto_?capture|capture_?session)$/i.test(key) && child === true)
              findings.push({ code: "auto_capture", file, evidence: "configuration_declaration" });
            if (typeof child === "object") visit(child);
          }
        }; visit(data);
      } else {
        let entry = null, multiline = null;
        for (const raw of text.split(/\r?\n/)) {
          if (multiline) { if (closes_multiline(raw, multiline)) multiline = null; continue; }
          const line = declaration_line(raw); if (!line) continue;
          const quoted = /^[^=]+\s*=\s*("""|''')/.exec(line);
          if (quoted) {
            if (!closes_multiline(line.slice(quoted[0].length), quoted[1])) multiline = quoted[1];
            continue;
          }
          if (entry && (entry.pendingArgs !== undefined || /^args\s*=\s*\[/.test(line))) {
            entry.pendingArgs = (entry.pendingArgs || "") + line;
            if (/\]\s*$/.test(line)) {
              entry.args = [...entry.pendingArgs.matchAll(/["']([^"']*)["']/g)].map(item => item[1]);
              delete entry.pendingArgs;
            }
            continue;
          }
          const section = /^\[(?:profiles\.[^\]]+\.)?mcp_servers\.([\w-]+|"[^"]+"|'[^']+')\]\s*(?:#.*)?$/.exec(line);
          if (section) { if (entry) check(entry, file, false); entry = { name: section[1].replace(/^["']|["']$/g, ""), args: [] }; continue; }
          if (line.startsWith("[")) { if (entry) check(entry, file, false); entry = null; }
          const command = /^command\s*=\s*["']([^"']+)["']/.exec(line);
          if (entry && command) entry.command = command[1];
          if (entry && /^enabled\s*=\s*false\s*$/.test(line)) entry.enabled = false;
          if (/^(?:auto_?capture|capture_?session)\s*=\s*true\s*$/i.test(line)) {
            if (entry) entry.captureDeclared = true;
            else findings.push({ code: "auto_capture", file, evidence: "configuration_declaration" });
          }
        }
        if (entry) check(entry, file, false);
      }
      sources.push({ file, state: "inspected" });
    } catch (error) { sources.push({ file, state: error.code === "ENOENT" ? "missing" : "unavailable" }); }
  }
  return { state: findings.length ? "attention_required" : "no_observed_conflicts", scope: "bounded_configuration_declarations",
    sources, findings, hostEffectiveConfiguration: "not_verified", hostToolCatalogue: "not_verified" };
}
function clean_text(value) {
  let text = String(value);
  const secrets = [...registered, ...Object.entries(process.env).filter(([key, val]) => secretKey.test(key) && val.length >= 4).map(([, val]) => val)];
  const variants = new Set(secrets.flatMap(value => /^Bearer /i.test(value) ? [value, value.slice(7)] : [value]).flatMap(value => {
    const escaped = JSON.stringify(value).slice(1, -1), encoded = Buffer.from(value).toString("base64");
    let uri = value; try { uri = encodeURIComponent(value); } catch { /* Redaction must accept arbitrary environment strings. */ }
    return [value, escaped, JSON.stringify(escaped).slice(1, -1), uri, encoded, encoded.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")];
  }));
  for (const secret of [...variants].filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join("[REDACTED]");
  text = text.replace(/https?:\/\/[^\s<>"']+/gi, raw => {
    try { const url = new URL(raw); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.href; }
    catch { return "[REDACTED_URL]"; }
  });
  return text.replace(/\b(Bearer|Basic)\s+[^\s,;"']+/gi, "$1 [REDACTED]")
    .replace(/((?:password|passwd|pwd|usr|secret|token|credential|authorization|api[_-]?key|cookie|пароль|имяпользователя)[\w-]*["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, "$1[REDACTED]")
    .replace(/(^|[\s|;])\/([NP])\s*(?:"(?:[^"]|"")*"|[^\s|;]+)/gm, "$1/$2[REDACTED]");
}
export function safe_error_message(error) {
  if (error?.remote === true) {
    const evidence = connection_failure(error);
    return "External MCP rejected the request" + (evidence.httpStatus ? " (HTTP " + evidence.httpStatus + ")" : "") +
      (evidence.rpcCode !== undefined ? " (RPC " + evidence.rpcCode + ")" : "") + "; remote error text omitted";
  }
  if (error?.code === "INVALID_DOCUMENT" || error instanceof SyntaxError) return "Invalid document; input excerpt omitted";
  return clean_text(error?.message || "Operation failed").slice(0, 4000);
}
// Setup results are operational data. Clean diagnostic prose without rewriting
// keys, state enums, flags, fingerprints or other fields used by the workflow.
export function sanitize_setup_result(value, key = "", parent = "") {
  if (value instanceof Error) return safe_error_message(value);
  if (Array.isArray(value)) return value.map(item => sanitize_setup_result(item, key, parent));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .map(([name, child]) => [name, sanitize_setup_result(child, name, key)]));
  return typeof value === "string" && (["detail", "reason", "message", "error", "stack", "version"].includes(key) || parent === "server")
    ? clean_text(value).slice(0, 16000) : value;
}
export function sanitize_diagnostics(value, depth = 0) {
  if (depth > 14) return "[depth limit]";
  if (typeof value === "string") return clean_text(value).slice(0, 16000);
  if (value === null || ["number", "boolean"].includes(typeof value)) return value;
  if (value instanceof Error && (value.code === "INVALID_DOCUMENT" || value instanceof SyntaxError))
    return { name: value.name, code: value.code || "INVALID_JSON", message: "Invalid document; input excerpt omitted" };
  if (value instanceof Error) return sanitize_diagnostics({ name: value.name, message: safe_error_message(value), code: value.code,
    ...(value.remote ? {} : { stack: value.stack, ...(value.cause ? { cause: value.cause } : {}) }) }, depth + 1);
  if (Array.isArray(value)) return value.slice(0, 256).map(item => sanitize_diagnostics(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 256).map(([key, child]) => [clean_text(key),
    secretKey.test(key) ? "[REDACTED]" : (key === "detail" && value.errorCode === "INVALID_DOCUMENT") || omittedKey.test(key) ? "[OMITTED]" : key === "tail" && typeof child === "string" ? clean_text(child).slice(-64 * 1024) : sanitize_diagnostics(child, depth + 1)]));
  return null;
}
const logFiles = directory => Array.from({ length: LOG_POLICY.files }, (_, index) => path.join(directory, `events.${index}.jsonl`));
function regular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Diagnostic path is not a regular file");
  return stat;
}
function expire(directory, now) {
  for (const file of logFiles(directory)) {
    try { if (regular(file).mtimeMs < now - LOG_POLICY.days * 86400000) fs.unlinkSync(file); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
// Short cross-process lock protects whole NDJSON records and rotation. Logging
// failure never changes the outcome of the user's operation.
export function create_diagnostic_logger(component, state = diagnostic_state()) {
  const session = randomUUID(), directory = path.join(state, "diagnostics");
  let dropped = 0, lastError = null;
  const event = (name, detail = {}, level = "info") => {
    const lock = path.join(directory, "writer.lock");
    let owned = false;
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("Diagnostic directory is a symlink");
      // A crashed writer cannot permanently disable diagnostics.
      try { if (regular(lock).mtimeMs < Date.now() - 30000) fs.unlinkSync(lock); } catch (error) { if (error.code !== "ENOENT") throw error; }
      for (let attempt = 0; ; attempt++) {
        try { fs.writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 }); owned = true; break; }
        catch (error) { if (error.code !== "EEXIST" || attempt === 4) throw error; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); }
      }
      const now = Date.now();
      expire(directory, now);
      const record = { formatVersion: LOG_FORMAT_VERSION, time: new Date(now).toISOString(), component: clean_text(component).slice(0, 80), session, pid: process.pid,
        instance: clean_text(process.env.EDT_AI_INSTANCE || "default").slice(0, 64), event: clean_text(name).slice(0, 80), level: clean_text(level).slice(0, 20),
        detail: sanitize_diagnostics(detail), ...(dropped ? { droppedBefore: dropped } : {}) };
      let line = JSON.stringify(record) + "\n";
      if (Buffer.byteLength(line) > LOG_POLICY.eventBytes) { record.detail = { truncated: true, summary: clean_text(JSON.stringify(record.detail)).slice(0, 1000) }; line = JSON.stringify(record) + "\n"; }
      const files = logFiles(directory);
      let size = 0;
      try { size = regular(files[0]).size; } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (size + Buffer.byteLength(line) > LOG_POLICY.fileBytes) {
        for (let index = files.length - 1; index >= 1; index--) {
          try { regular(files[index]); fs.unlinkSync(files[index]); } catch (error) { if (error.code !== "ENOENT") throw error; }
          try { regular(files[index - 1]); fs.renameSync(files[index - 1], files[index]); } catch (error) { if (error.code !== "ENOENT") throw error; }
        }
      }
      fs.appendFileSync(files[0], line, { mode: 0o600 });
      dropped = 0; lastError = null;
      return true;
    } catch (error) { dropped++; lastError = error.code || error.message; return false; }
    finally { if (owned) try { fs.unlinkSync(lock); } catch {} }
  };
  return { event, session, status: () => ({ dropped, lastError }) };
}
export function read_diagnostic_logs(state = diagnostic_state()) {
  const directory = path.join(state, "diagnostics"), events = [], issues = [];
  if (!fs.existsSync(directory)) return { events, issues };
  if (fs.lstatSync(directory).isSymbolicLink()) return { events, issues: ["Diagnostic directory is a symlink"] };
  for (const file of logFiles(directory).reverse()) {
    let fd;
    try {
      const stat = regular(file);
      if (stat.mtimeMs < Date.now() - LOG_POLICY.days * 86400000) continue;
      fd = fs.openSync(file, "r");
      const bytes = Buffer.alloc(Math.min(stat.size, LOG_POLICY.fileBytes));
      fs.readSync(fd, bytes, 0, bytes.length, 0);
      for (const line of bytes.toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          let event = JSON.parse(line);
          const timestamp = Date.parse(event.time);
          if (!Number.isFinite(timestamp) || timestamp < Date.now() - LOG_POLICY.days * 86400000) continue;
          if (event.formatVersion !== LOG_FORMAT_VERSION) {
            event = { formatVersion: LOG_FORMAT_VERSION, time: new Date(timestamp).toISOString(), component: "legacy", event: "legacy_event", level: "warning",
              detail: { omitted: "untrusted_legacy_record" } };
            issues.push("Unsupported log format: record details omitted");
          }
          if (event.event === "runtime_stderr") event.detail = { content: "omitted", ...(Number.isSafeInteger(event.detail?.bytes) ? { bytes: event.detail.bytes } : {}) };
          events.push(sanitize_diagnostics(event));
        }
        catch { issues.push(path.basename(file) + ": incomplete or invalid record"); }
      }
    } catch (error) { if (error.code !== "ENOENT") issues.push(path.basename(file) + ": " + (error.code || error.message)); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  // The ring bounds bytes; avoid an unbounded array in a malformed local file.
  return { events: events.sort((a, b) => String(a.time).localeCompare(String(b.time))), issues: [...new Set(issues)] };
}

// A lightweight, bounded window for the settings journal. This does not build
// an export, read configuration/source files or contact any runtime.
export function diagnostic_journal(state = diagnostic_state()) {
  let logs;
  try { logs = read_diagnostic_logs(state); }
  catch (error) { logs = { events: [], issues: [error.code || error.name] }; }
  const events = [], byteLimit = 256 * 1024;
  let bytes = 0;
  for (const event of logs.events.slice(-200).reverse()) {
    const size = Buffer.byteLength(JSON.stringify(event));
    if (bytes + size > byteLimit) break;
    events.push(event); bytes += size;
  }
  return { events, issues: logs.issues, total: logs.events.length,
    truncated: events.length < logs.events.length, policy: LOG_POLICY };
}
