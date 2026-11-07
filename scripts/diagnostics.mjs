// Local operational telemetry. Never record MCP arguments, results or source.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

export const LOG_POLICY = Object.freeze({ files: 4, fileBytes: 512 * 1024, priorityFiles: 2, priorityFileBytes: 256 * 1024, days: 7, eventBytes: 8192 });
export const LOG_FORMAT_VERSION = 3;
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

// Only locally established codes are retained. An upstream message, code
// string or stack is never evidence and may contain arbitrary private data.
const osCodes = new Set(["EACCES", "EPERM", "ENOENT", "ENOTDIR", "EISDIR", "EEXIST", "ENOSPC", "EMFILE", "ENFILE", "EPIPE", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"]);
const localCodes = new Set(["INVALID_DOCUMENT", "LOCAL_FILE_CHANGED", "BACKEND_OUTPUT_LIMIT", "READ_TIMEOUT", "RUNTIME_BUSY", "unsupported_response"]);
export function diagnostic_failure(error, phase = "unknown") {
  const code = error?.cause?.code || error?.code;
  const httpStatus = Number.isInteger(error?.status) ? error.status : error?.httpStatus;
  const rpcCode = Number.isInteger(error?.code) ? error.code : error?.rpcCode;
  let category = "unknown", reasonCode = "unknown_failure";
  if (error?.outcomeUnknown === true) { category = "outcome_unknown"; reasonCode = "outcome_unknown"; }
  else if (["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "READ_TIMEOUT"].includes(code) || error?.name === "TimeoutError" || httpStatus === 408) { category = "timeout"; reasonCode = "timeout"; }
  else if (error?.name === "AbortError" || error?.cancelled === true) { category = "cancelled"; reasonCode = "cancelled"; }
  else if (code === "RUNTIME_BUSY") { category = "blocked"; reasonCode = "runtime_busy"; }
  else if (httpStatus === 401 || httpStatus === 403) { category = "authorization"; reasonCode = "authorization_denied"; }
  else if (httpStatus === 429) { category = "blocked"; reasonCode = "rate_limited"; }
  else if (["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "EPIPE"].includes(code)) { category = "connection"; reasonCode = "connection_failed"; }
  else if (error instanceof SyntaxError || code === "INVALID_DOCUMENT" || code === "unsupported_response" || [-32700, -32600, -32601, -32602].includes(rpcCode)) { category = "contract"; reasonCode = "invalid_response"; }
  else if ((Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus <= 599) || Number.isInteger(rpcCode)) { category = "remote_error"; reasonCode = "remote_error"; }
  else if (["EACCES", "EPERM"].includes(code)) { category = "permission"; reasonCode = "access_denied"; }
  else if (code === "ENOENT") { category = "configuration"; reasonCode = "path_not_found"; }
  else if (code === "BACKEND_OUTPUT_LIMIT") { category = "resource_limit"; reasonCode = "output_limit"; }
  else if ((error?.remote !== true && /^(?:ConfigError|ProfileNotFound|ProfileAmbiguous)$/.test(error?.constructor?.name || "")) || phase === "configuration" || phase === "preparation") { category = "configuration"; reasonCode = "configuration_invalid"; }
  const causeCategory = category === "outcome_unknown" ? (["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "READ_TIMEOUT"].includes(code) || error?.name === "TimeoutError" || httpStatus === 408 ? "timeout"
    : ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "EPIPE"].includes(code) ? "connection" : undefined) : undefined;
  return { category, reasonCode, ...(causeCategory ? { causeCategory } : {}),
    ...(Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? { httpStatus } : {}),
    ...(Number.isSafeInteger(rpcCode) && Math.abs(rpcCode) <= 2147483648 ? { rpcCode } : {}),
    ...(osCodes.has(code) ? { osCode: code } : {}), ...(localCodes.has(code) ? { localCode: code } : {}) };
}
export function diagnostic_id(value) {
  return typeof value === "string" && value ? createHash("sha256").update(value).digest("hex").slice(0, 24) : null;
}
export function diagnostic_project_id(value) {
  if (typeof value !== "string" || !value) return null;
  const resolved = path.resolve(value);
  return diagnostic_id(process.platform === "win32" ? resolved.toLowerCase() : resolved);
}

const diagnosticActions = new Set("read status check probe refresh_readiness rebuild_index restart_index updates pick_directory pick_view_directory pick_java check_java pick_import_file update create load save preview import export transfer_apply transfer_export document_patch rename open close install download apply rollback java_probe".split(" "));
const diagnosticPhases = new Set("configuration preparation initialize tools/list native_validation transport server_contract authorization access_scope index preparing waiting_lock waiting_readers stopping indexing restarting checking restoring cleanup dispatch completed unknown".split(" "));
const diagnosticReasons = new Set("completed timeout error output_limit project_changed observation_cleanup_failed backend_timeout cancelled shutdown disconnect expired session_closed cleanup_unknown".split(" "));
const diagnosticStates = new Set("idle running completed failed outcome_unknown cancelled ready disabled stopped missing missing_config missing_project mismatch stale indexing building not_checked not_verified not_configured invalid check_stale awaiting_observation preparing error connected disconnected verified not_ready blocked superseded".split(" "));
const diagnosticReasonCodes = new Set("disabled profile_missing not_checked launch_required configuration_missing configuration_project configuration_type target_unconfirmed ambiguous project_mismatch project_not_ready edt_unavailable request_failed timeout api_unsupported unsupported_response api_limit check_stale launch_verified unknown_failure outcome_unknown cancelled runtime_busy authorization_denied connection_failed invalid_response remote_error rate_limited access_denied path_not_found output_limit configuration_invalid policy_denied".split(" "));
const diagnosticComponents = new Set(["settings", "session-start", "guard", "cli", "edt", "v8std", "openviking", "code-index", "bsl-ls", "yaxunit", "vanessa", "policy", "managed", "managed-code-index", "managed-bsl-ls", "index-daemon", "index-observer", "java-probe", "process-supervisor", "linux-daemon-guard"]);
const uuid = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : undefined;
// This is the persisted event contract, not a recursive redaction filter.
// Unknown fields, upstream prose, command lines, paths and payloads are omitted.
export function diagnostic_fields(detail = {}, { projected = false } = {}) {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return {};
  const result = {};
  for (const key of ["pid", "supervisorPid", "workerPid", "targetPid", "bytes", "exitCode", "durationMs", "callIndex", "count", "controlCount", "tools", "total", "completed", "versions", "index", "i"]) {
    const value = detail[key]; if (Number.isSafeInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) result[key] = value;
  }
  for (const key of ["bound", "rootsPending", "rootsAdvertised", "isError", "rootLocked", "all", "cancelled", "configured", "connected", "ready", "toolsVerified", "truncated"]) if (typeof detail[key] === "boolean") result[key] = detail[key];
  for (const key of ["id", "operationId", "owner", "reader", "connectionId"]) if (uuid(detail[key])) result[key] = detail[key];
  for (const [key, target] of [["projectRoot", "projectId"], ["selectedDirectory", "selectedDirectoryId"], ["requestId", "requestId"], ["tool", "toolId"], ["executable", "executableId"]]) {
    if (["string", "number"].includes(typeof detail[key])) result[target] = ["projectRoot", "selectedDirectory"].includes(key) ? diagnostic_project_id(String(detail[key])) : diagnostic_id(key === "requestId" ? typeof detail[key] + ":" + String(detail[key]) : String(detail[key]));
  }
  if (projected) {
    for (const key of ["projectId", "selectedDirectoryId", "toolId", "executableId"]) if (typeof detail[key] === "string" && /^[a-f0-9]{24}$/.test(detail[key])) result[key] = detail[key];
    if (typeof detail.requestId === "string" && /^[a-f0-9]{24}$/.test(detail.requestId)) result.requestId = detail.requestId;
  }
  if (diagnosticActions.has(detail.action)) result.action = detail.action;
  if (diagnosticPhases.has(detail.phase)) result.phase = detail.phase;
  if (diagnosticReasons.has(detail.reason)) result.reason = detail.reason;
  if (diagnosticStates.has(detail.status)) result.status = detail.status;
  if (diagnosticStates.has(detail.state)) result.state = detail.state;
  if (["not_executed", "unknown", "response_received", "response_error", "response_ok"].includes(detail.outcome)) result.outcome = detail.outcome;
  if (diagnosticReasonCodes.has(detail.reasonCode)) result.reasonCode = detail.reasonCode;
  for (const key of ["startedAt", "checkedAt", "expiresAt"]) if (typeof detail[key] === "string" && Number.isFinite(Date.parse(detail[key]))) result[key] = new Date(detail[key]).toISOString();
  for (const key of ["version", "node"]) {
    const value = key === "version" ? detail.version || detail.server?.version : detail[key];
    if (typeof value === "string" && /^v?\d{1,6}(?:\.\d{1,6}){0,3}(?:[-.]?(?:alpha|beta|rc|preview|dev)(?:[.-]?\d{1,6})?)?$/i.test(value)) result[key] = value;
  }
  if (typeof detail.protocol === "string" && /^\d{4}-\d{2}-\d{2}$/.test(detail.protocol)) result.protocol = detail.protocol;
  if (diagnosticComponents.has(detail.component)) result.component = detail.component;
  if (["knowledge_status", "knowledge_search", "knowledge_read", "settings.run_check", "settings.probe_connections", "settings.rebuild_index", "settings.restart_index", "settings.refresh_readiness", "settings.updates", "settings.update", "settings.export_diagnostics", "settings.export_log"].includes(detail.tool)) result.tool = detail.tool;
  if (["profile.mjs", "runtime.mjs", "vanessa.mjs", "doctor.mjs", "prepare_install.mjs", "action_policy.mjs"].includes(detail.executable)) result.executable = detail.executable;
  if (detail.error) result.failure = detail.error.diagnosticFailure && typeof detail.error.diagnosticFailure === "object"
    ? diagnostic_fields({ failure: detail.error.diagnosticFailure }).failure || diagnostic_failure(detail.error, detail.phase)
    : diagnostic_failure(detail.error, detail.phase);
  if (detail.failure && typeof detail.failure === "object") {
    const f = detail.failure;
    if (["configuration", "transport", "authorization", "server_contract", "access_scope", "index", "connection", "timeout", "cancelled", "blocked", "outcome_unknown", "unknown", "permission", "contract", "remote_error", "resource_limit"].includes(f.category)) result.failure = { category: f.category,
      ...(Number.isInteger(f.httpStatus) && f.httpStatus >= 100 && f.httpStatus <= 599 ? { httpStatus: f.httpStatus } : {}),
      ...(Number.isSafeInteger(f.rpcCode) && Math.abs(f.rpcCode) <= 2147483648 ? { rpcCode: f.rpcCode } : {}),
      ...(osCodes.has(f.osCode) ? { osCode: f.osCode } : {}), ...(localCodes.has(f.localCode) ? { localCode: f.localCode } : {}),
      ...(["timeout", "connection"].includes(f.causeCategory) ? { causeCategory: f.causeCategory } : {}),
      ...(diagnosticReasonCodes.has(f.reasonCode) ? { reasonCode: f.reasonCode } : {}) };
  }
  if (detail.binding && typeof detail.binding === "object") {
    const b = detail.binding, id = projected && typeof b.projectId === "string" && /^[a-f0-9]{24}$/.test(b.projectId) ? b.projectId : diagnostic_project_id(b.projectRoot);
    result.binding = { ...(id ? { projectId: id } : {}), ...(typeof b.connectionId === "string" && /^[a-f0-9]{32}$/.test(b.connectionId) ? { connectionId: b.connectionId } : {}), ...(uuid(b.connectionId) ? { connectionId: b.connectionId } : {}) };
  }
  return result;
}
const diagnosticEvents = new Set(`session_started uncaught_exception index_observer_cleanup_failed settings_unavailable backend_process_started backend_process_stopped backend_child_stopped backend_process_cleanup_failed backend_cleanup_unconfirmed
operation_started operation_completed operation_failed operation_outcome_unknown operation_cleanup_failed operation_barrier_failed operation_rejected operation_phase component_observed component_observation_failed
support_export_requested support_export_saved version_catalog_loaded request_started request_completed request_failed native_request_started native_request_completed native_request_failed dispatch_failed
command_started command_completed command_failed profile_discovered discovery_failed request_denied guard_failed connected disconnected connection_failed host_initialized host_tools_list runtime_stderr
process_started process_exited process_stopped process_shutdown_failed process_cleanup_failed launch_failed daemon_starting daemon_started daemon_start_rolled_back daemon_start_cleanup_failed daemon_start_unconfirmed daemon_start_barrier_retained daemon_start_barrier_failed daemon_stop_started daemon_stop_failed daemon_cleanup_failed daemon_stopped
daemon_guard_stopping daemon_guard_stopped daemon_guard_barrier_failed daemon_guard_cleanup_failed daemon_guard_started daemon_guard_committed daemon_guard_monitor_failed daemon_guard_cleanup_unconfirmed
index_output index_completed index_failed reader_copy_started reader_copy_stopped reader_copy_cleanup_failed reader_coordination_failed reader_stopped reader_files_removed reader_files_cleanup_failed reader_cleanup_failed reader_started session_cleanup_timeout session_cleanup_failed`.split(/\s+/));
// Records are local, mutable input too. An old or forged event name must not
// become a way to smuggle arbitrary text into an exported report.
export function export_diagnostic_events(events) {
  return events.map(event => ({ ...event,
    component: diagnosticComponents.has(event.component) ? event.component : "unknown",
    ...(diagnosticEvents.has(event.event) ? {} : { event: "unrecognized_event", eventId: diagnostic_id(event.event) }),
    detail: diagnostic_fields(event.detail, { projected: true }),
  }));
}
const secretKey = /password|passwd|pwd|secret|token|credential|authorization|api.?key|cookie|private.?key|binding.?key|connection.?string|строкасоединения|пароль|имяпользователя/i;
const omittedKey = /^(?:env|environment|headers|args|arguments|command|text|content|sourceCode)$/i;
const registered = new Set();
export function register_diagnostic_secrets(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "headers_env" && child && typeof child === "object") {
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
    return "Внешний сервер MCP отклонил запрос" + (evidence.httpStatus ? " (HTTP " + evidence.httpStatus + ")" : "") +
      (evidence.rpcCode !== undefined ? " (RPC " + evidence.rpcCode + ")" : "") + "; текст внешней ошибки скрыт";
  }
  if (error?.code === "INVALID_DOCUMENT" || error instanceof SyntaxError) return "Некорректный документ" +
    (Number.isSafeInteger(error?.documentLine) && error.documentLine > 0 && error.documentLine <= 2097152 ? ` в строке ${error.documentLine}` : "") + "; фрагмент исходного текста скрыт";
  if (error?.outcomeUnknown === true && !/[А-Яа-яЁё]/.test(error.message || ""))
    return "Исход операции неизвестен; проверьте фактическое состояние перед повтором.";
  return clean_text(error?.message || "Не удалось выполнить операцию").slice(0, 4000);
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
const priorityFiles = directory => Array.from({ length: LOG_POLICY.priorityFiles }, (_, index) => path.join(directory, `important.${index}.jsonl`));
function regular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error("Diagnostic path is not a private regular file");
  return stat;
}
function expire(files, now) {
  for (const file of files) {
    try { if (regular(file).mtimeMs < now - LOG_POLICY.days * 86400000) fs.unlinkSync(file); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
function append_record(files, limit, line) {
  let size = 0;
  try { size = regular(files[0]).size; } catch (error) { if (error.code !== "ENOENT") throw error; }
  let discarded = false;
  if (size + Buffer.byteLength(line) > limit) {
    try { regular(files.at(-1)); discarded = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
    for (let index = files.length - 1; index >= 1; index--) {
      try { regular(files[index]); fs.unlinkSync(files[index]); } catch (error) { if (error.code !== "ENOENT") throw error; }
      try { regular(files[index - 1]); fs.renameSync(files[index - 1], files[index]); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
  const fd = fs.openSync(files[0], flags, 0o600);
  try {
    const opened = fs.fstatSync(fd), current = regular(files[0]);
    if (!opened.isFile() || opened.nlink > 1 || opened.dev !== current.dev || opened.ino !== current.ino) throw new Error("Diagnostic file changed while opening");
    fs.writeFileSync(fd, line);
  } finally { fs.closeSync(fd); }
  return discarded;
}
function will_discard(files, limit, bytes) {
  try { if (regular(files[0]).size + bytes <= limit) return false; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
  try { regular(files.at(-1)); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
// Short cross-process lock protects whole NDJSON records and rotation. Logging
// failure never changes the outcome of the user's operation.
export function create_diagnostic_logger(component, state = diagnostic_state()) {
  const session = randomUUID(), directory = path.join(state, "diagnostics");
  let dropped = 0, priorityDropped = 0, lastError = null, sequence = 0;
  const event = (name, detail = {}, level = "info") => {
    const lock = path.join(directory, "writer.lock");
    const eventSequence = ++sequence;
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
      expire(logFiles(directory), now);
      let priorityUnavailable = false;
      try { expire(priorityFiles(directory), now); } catch { priorityUnavailable = true; }
      const record = { formatVersion: LOG_FORMAT_VERSION, recordId: randomUUID(), time: new Date(now).toISOString(), component: clean_text(component).slice(0, 80), session, sequence: eventSequence, pid: process.pid,
        instanceId: diagnostic_id(process.env.EDT_AI_INSTANCE || "default"), event: clean_text(name).slice(0, 80), level: level === "warning" ? "warn" : ["info", "warn", "error", "debug"].includes(level) ? level : "info",
        detail: diagnostic_fields({ ...(uuid(process.env.EDT_AI_OPERATION_ID) ? { operationId: process.env.EDT_AI_OPERATION_ID } : {}), ...detail }), ...(dropped ? { droppedBefore: dropped } : {}), ...(priorityDropped ? { priorityDroppedBefore: priorityDropped } : {}) };
      let line = JSON.stringify(record) + "\n";
      if (Buffer.byteLength(line) > LOG_POLICY.eventBytes) { record.detail = { truncated: true }; line = JSON.stringify(record) + "\n"; }
      const important = record.level === "error" || record.level === "warn" || /^(?:connected|disconnected|connection_failed|operation_failed|operation_outcome_unknown|operation_rejected|component_observed|daemon_started|daemon_stopped)$/.test(name);
      if (will_discard(logFiles(directory), LOG_POLICY.fileBytes, Buffer.byteLength(line))) record.rotatedBefore = true;
      if (important && !priorityUnavailable) try {
        if (will_discard(priorityFiles(directory), LOG_POLICY.priorityFileBytes, Buffer.byteLength(line))) record.priorityRotatedBefore = true;
      } catch { priorityUnavailable = true; }
      line = JSON.stringify(record) + "\n";
      append_record(logFiles(directory), LOG_POLICY.fileBytes, line);
      dropped = 0; priorityDropped = 0; lastError = null;
      // A separate bounded retention lane inside the same journal prevents
      // routine traffic from evicting errors and meaningful state transitions.
      if (important) {
        try {
          if (priorityUnavailable) throw new Error("Priority diagnostic path unavailable");
          append_record(priorityFiles(directory), LOG_POLICY.priorityFileBytes, line);
        } catch (error) { priorityDropped++; lastError = error.code || "priority_write_failed"; }
      }
      return true;
    } catch (error) { dropped++; lastError = error.code || "write_failed"; return false; }
    finally { if (owned) try { fs.unlinkSync(lock); } catch {} }
  };
  return { event, session, status: () => ({ dropped, priorityDropped, lastError }) };
}
export function read_diagnostic_logs(state = diagnostic_state()) {
  const directory = path.join(state, "diagnostics"), events = [], issues = [];
  const stats = { expiredFiles: 0, expiredRecords: 0, invalidTimestamps: 0, invalidRecords: 0, unsupportedRecords: 0, truncatedFiles: 0 };
  try {
    const directoryStat = fs.lstatSync(directory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) return { events, issues: ["Diagnostic directory is not a regular directory"], stats };
  } catch (error) { return { events, issues: error.code === "ENOENT" ? issues : ["Diagnostic directory unavailable: " + (error.code || "read_failed")], stats }; }
  const seen = new Map();
  for (const file of [...logFiles(directory).reverse(), ...priorityFiles(directory).reverse()]) {
    let fd;
    try {
      const stat = regular(file);
      if (stat.mtimeMs < Date.now() - LOG_POLICY.days * 86400000) { stats.expiredFiles++; continue; }
      const fileLimit = path.basename(file).startsWith("important.") ? LOG_POLICY.priorityFileBytes : LOG_POLICY.fileBytes;
      if (stat.size > fileLimit) { stats.truncatedFiles++; issues.push(path.basename(file) + ": file size limit; remainder omitted"); }
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.nlink > 1 || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error("Diagnostic file changed while opening");
      const bytes = Buffer.alloc(Math.min(stat.size, fileLimit));
      let length = 0;
      while (length < bytes.length) { const count = fs.readSync(fd, bytes, length, bytes.length - length, length); if (!count) break; length += count; }
      if (length !== bytes.length) issues.push(path.basename(file) + ": file changed while reading");
      for (const line of bytes.subarray(0, length).toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          let event = JSON.parse(line);
          const timestamp = Date.parse(event.time);
          if (!Number.isFinite(timestamp)) { stats.invalidTimestamps++; continue; }
          if (timestamp < Date.now() - LOG_POLICY.days * 86400000) { stats.expiredRecords++; continue; }
          if (![2, LOG_FORMAT_VERSION].includes(event.formatVersion)) {
            stats.unsupportedRecords++;
            issues.push("Unsupported log format: record details omitted");
            continue;
          }
          const recordId = uuid(event.recordId), duplicate = recordId && seen.get(recordId);
          if (duplicate?.line === line.trim()) continue;
          if (duplicate) issues.push("Conflicting duplicate log record");
          const detail = diagnostic_fields(event.detail, { projected: event.formatVersion === LOG_FORMAT_VERSION });
          const projected = { formatVersion: event.formatVersion, ...(recordId ? { recordId } : {}), time: new Date(timestamp).toISOString(),
            component: typeof event.component === "string" && /^[a-z0-9-]{1,80}$/.test(event.component) ? event.component : "unknown",
            ...(uuid(event.session) ? { session: event.session } : {}), ...(Number.isSafeInteger(event.pid) && event.pid > 0 ? { pid: event.pid } : {}),
            ...(Number.isSafeInteger(event.sequence) && event.sequence > 0 ? { sequence: event.sequence } : {}),
            instanceId: typeof event.instanceId === "string" && /^[a-f0-9]{24}$/.test(event.instanceId) ? event.instanceId : diagnostic_id(event.instance),
            event: typeof event.event === "string" && /^[a-z0-9_-]{1,80}$/.test(event.event) ? event.event : "unknown",
            level: event.formatVersion === 2 && ["runtime_stderr", "index_output"].includes(event.event) && ["warning", "warn"].includes(event.level) ? "info" : event.level === "warning" ? "warn" : ["info", "warn", "error", "debug"].includes(event.level) ? event.level : "info", detail,
            ...(Number.isSafeInteger(event.droppedBefore) && event.droppedBefore > 0 ? { droppedBefore: event.droppedBefore } : {}),
            ...(Number.isSafeInteger(event.priorityDroppedBefore) && event.priorityDroppedBefore > 0 ? { priorityDroppedBefore: event.priorityDroppedBefore } : {}),
            ...(event.rotatedBefore === true ? { rotatedBefore: true } : {}), ...(event.priorityRotatedBefore === true ? { priorityRotatedBefore: true } : {}) };
          if (!duplicate && recordId) seen.set(recordId, { index: events.length, line: line.trim() });
          events.push(projected);
        }
        catch { stats.invalidRecords++; issues.push(path.basename(file) + ": incomplete or invalid record"); }
      }
    } catch (error) { if (error.code !== "ENOENT") issues.push(path.basename(file) + ": " + (error.code || error.message)); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  // The ring bounds bytes; avoid an unbounded array in a malformed local file.
  return { events: events.sort((a, b) => String(a.time).localeCompare(String(b.time)) || String(a.session || "").localeCompare(String(b.session || "")) || (a.sequence || 0) - (b.sequence || 0)), issues: [...new Set(issues)], stats };
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
  return { events, issues: logs.issues, stats: logs.stats, total: logs.events.length,
    truncated: events.length < logs.events.length, policy: LOG_POLICY };
}
