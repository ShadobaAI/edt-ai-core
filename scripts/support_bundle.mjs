import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { LOG_POLICY, read_diagnostic_logs, sanitize_diagnostics, register_diagnostic_secrets } from "./diagnostics.mjs";

const FILE_LIMIT = 256 * 1024, SECTION_LIMIT = 128 * 1024;
const REPORT_NAME = "1c-ai-core-diagnostics.json";
function export_directory(state, create = false) {
  let directory = path.resolve(state);
  if (create) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const part of ["diagnostics", "exports"]) {
    directory = path.join(directory, part);
    if (create) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Diagnostic export directory is not a regular directory");
  }
  return directory;
}
export function saved_support_report(state) {
  try {
    const directory = export_directory(state), file = path.join(directory, REPORT_NAME), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return { filename: REPORT_NAME, path: file, directory, bytes: stat.size, savedAt: stat.mtime.toISOString() };
  } catch { return null; }
}
// One actual file, atomically replaced on the next export. Browser download
// clicks cannot confirm that an embedded host saved anything to disk.
export function save_support_bundle(state, bundle) {
  if (typeof bundle?.text !== "string" || Buffer.byteLength(bundle.text) > 16 * 1024 * 1024)
    throw new Error("Диагностический файл отсутствует или превышает 16 МиБ.");
  const directory = export_directory(state, true), file = path.join(directory, REPORT_NAME), temporary = path.join(directory, `.support-${randomUUID()}.tmp`);
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Diagnostic export target is not a regular file");
  }
  try {
    fs.writeFileSync(temporary, bundle.text, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
    const saved = saved_support_report(state);
    if (!saved || saved.bytes !== Buffer.byteLength(bundle.text)) throw new Error("Не удалось подтвердить сохранение диагностического файла.");
    return saved;
  } finally { fs.rmSync(temporary, { force: true }); }
}
// Deliberately no CLI or model tool. Only the settings app calls this collector.
// Every section fails independently; invalid settings must still be exportable.
export async function support_bundle({ state, configPath, selectedRoot, selection, operation, loggerStatus, readCurrent }) {
  const issues = [], snapshot = {};
  const capture = async (name, read) => {
    try { snapshot[name] = await read(); register_diagnostic_secrets(snapshot[name]); }
    catch (error) { snapshot[name] = { unavailable: true, error: error.code || error.name }; issues.push({ section: name, reason: error.code || error.name }); }
  };
  const document = async file => {
    if (file instanceof URL) file = fileURLToPath(file);
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return { path: file, exists: false }; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsupported diagnostic file");
    const metadata = { path: file, exists: true, bytes: stat.size, modified: stat.mtime.toISOString() };
    if (stat.size > FILE_LIMIT) { issues.push({ section: file, reason: "file_size_limit" }); return { ...metadata, omitted: "file_size_limit" }; }
    try {
      const text = fs.readFileSync(file, "utf8");
      let value;
      try { value = JSON.parse(text); }
      catch { const { parse } = await import("./common.mjs"); value = parse(text); }
      return { ...metadata, value };
    }
    // YAML parser errors can include a source excerpt containing a secret.
    catch (error) { issues.push({ section: file, reason: "invalid_document" }); return { ...metadata, invalid: true, error: error.code || error.name }; }
  };
  await capture("plugin", async () => ({ manifest: await document(new URL("../plugin.json", import.meta.url)), build: await document(new URL("../build-info.json", import.meta.url)) }));
  await capture("host", () => ({ platform: process.platform, architecture: process.arch, osRelease: os.release(), node: process.version, locale: Intl.DateTimeFormat().resolvedOptions(),
    stateDirectory: state, settingsPath: configPath, pluginDirectory: fileURLToPath(new URL("..", import.meta.url)),
    selection, selectedRoot, operation, loggerStatus,
    // Presence only. Never export the environment, PATH, or credentials.
    environmentOverrides: Object.keys(process.env).filter(key => /^(?:EDT_AI_|CODEX_HOME$|JAVA_HOME$)/.test(key)).sort() }));
  await capture("settings", () => document(configPath));
  await capture("runtimeArtifacts", () => document(path.join(state, "runtime-lock.json")));
  if (selectedRoot) {
    await capture("current", async () => {
      return readCurrent ? readCurrent() : { unavailable: true };
    });
    await capture("project", async () => {
      const { configuration_root, project_directory, instance_name } = await import("./project_paths.mjs");
      const root = configuration_root(snapshot.current?.values?.projectRoot || selectedRoot, { recursive: false }), home = project_directory(state, root), instance = instance_name();
      return { root, home,
        profile: await document(path.join(root, ".ai/project.yaml")),
        local: await document(path.join(root, ".ai/project.local.yaml")),
        repositoryInstance: await document(path.join(root, ".ai/instances", instance + ".local.yaml")),
        instance: await document(path.join(home, "instances", instance + ".yaml")),
        connectionsFile: process.env.EDT_AI_CONNECTIONS_FILE ? await document(process.env.EDT_AI_CONNECTIONS_FILE) : null,
        preparation: await document(path.join(home, "instances", instance + ".preparation.json")),
        reconnect: await document(path.join(home, "instances", instance + ".reconnect.json")),
        daemon: await document(path.join(home, "code-index/daemon.json")),
        owner: await document(path.join(home, "code-index/owner.json")),
        maintenance: await document(path.join(home, "code-index/maintenance.json")) };
    });
    // Existing native daemon files are never copied wholesale or followed via
    // a symlink. Only a bounded recent tail is useful to support.
    for (const name of ["stdout", "stderr"]) await capture("codeIndex_" + name, async () => {
      const home = snapshot.project?.home;
      if (!home) return { unavailable: true };
      const file = path.join(home, "code-index", name + ".log");
      let stat;
      try { stat = fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return { exists: false }; throw error; }
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsupported diagnostic file");
      if (stat.mtimeMs < Date.now() - LOG_POLICY.days * 86400000) return { omitted: "expired" };
      const fd = fs.openSync(file, "r");
      try {
        const tail = Buffer.alloc(Math.min(stat.size, 64 * 1024));
        fs.readSync(fd, tail, 0, tail.length, Math.max(0, stat.size - tail.length));
        return { bytes: stat.size, truncated: stat.size > tail.length, tail: tail.toString("utf8") };
      } finally { fs.closeSync(fd); }
    });
  }
  let logs;
  try { logs = read_diagnostic_logs(state); }
  catch (error) { logs = { events: [], issues: [error.code || error.name] }; }
  if (loggerStatus?.dropped) issues.push({ section: "logger", reason: loggerStatus.lastError, dropped: loggerStatus.dropped });
  const safe = sanitize_diagnostics(snapshot);
  // Sections and export size remain bounded independently of local state size.
  for (const [name, value] of Object.entries(safe)) if (Buffer.byteLength(JSON.stringify(value)) > SECTION_LIMIT) {
    safe[name] = { omitted: "section_size_limit" }; issues.push({ section: name, reason: "section_size_limit" });
  }
  const createdAt = new Date().toISOString();
  const report = { format: "1c-ai-core-diagnostics", version: 1, createdAt,
    collection: { policy: LOG_POLICY, readOnly: true, networkRequests: false,
      includes: ["Operational events across recent plugin sessions", "Current selected project configuration and local runtime records"],
      excludes: ["Chat history", "Source files", "Environment values", "MCP arguments and results", "Full external service logs"],
      redaction: "Known credentials, secret fields, URL credentials/query/fragment and command/environment payloads are removed. Project paths and endpoint hosts remain for diagnosis.",
      issues: sanitize_diagnostics([...issues, ...logs.issues]) },
    snapshot: safe, events: logs.events };
  return { filename: "1c-ai-core-diagnostics-" + createdAt.replace(/[:.]/g, "-") + ".json", mimeType: "application/json", text: JSON.stringify(report, null, 2) + "\n" };
}
