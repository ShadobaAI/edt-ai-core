// Local operational telemetry. Never record MCP arguments, results or source.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

export const LOG_POLICY = Object.freeze({ files: 4, fileBytes: 512 * 1024, days: 7, eventBytes: 8192 });
const secretKey = /password|passwd|pwd|secret|token|credential|authorization|api.?key|cookie|private.?key|connection.?string|строкасоединения|пароль|имяпользователя/i;
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
function clean_text(value) {
  let text = String(value);
  const secrets = [...registered, ...Object.entries(process.env).filter(([key, val]) => secretKey.test(key) && val.length >= 4).map(([, val]) => val)];
  for (const secret of secrets.sort((a, b) => b.length - a.length)) text = text.split(secret).join("[REDACTED]");
  text = text.replace(/https?:\/\/[^\s<>"']+/gi, raw => {
    try { const url = new URL(raw); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.href; }
    catch { return "[REDACTED_URL]"; }
  });
  return text.replace(/\b(Bearer|Basic)\s+[^\s,;"']+/gi, "$1 [REDACTED]")
    .replace(/((?:password|passwd|pwd|usr|secret|token|credential|authorization|api[_-]?key|cookie|пароль|имяпользователя)[\w-]*["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, "$1[REDACTED]")
    .replace(/(^|[\s|;])\/([NP])\s*(?:"(?:[^"]|"")*"|[^\s|;]+)/gm, "$1/$2[REDACTED]");
}
export function sanitize_diagnostics(value, depth = 0) {
  if (depth > 14) return "[depth limit]";
  if (typeof value === "string") return clean_text(value).slice(0, 16000);
  if (value === null || ["number", "boolean"].includes(typeof value)) return value;
  if (value instanceof Error && (value.code === "INVALID_DOCUMENT" || value instanceof SyntaxError))
    return { name: value.name, code: value.code || "INVALID_JSON", message: "Invalid document; input excerpt omitted" };
  if (value instanceof Error) return sanitize_diagnostics({ name: value.name, message: value.message, code: value.code, stack: value.stack, ...(value.cause ? { cause: value.cause } : {}) }, depth + 1);
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
      const record = { time: new Date(now).toISOString(), component: clean_text(component).slice(0, 80), session, pid: process.pid,
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
        try { const event = JSON.parse(line); if (Date.parse(event.time) >= Date.now() - LOG_POLICY.days * 86400000) events.push(sanitize_diagnostics(event)); }
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
