import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { LOG_POLICY, read_diagnostic_logs, sanitize_diagnostics, environment_compatibility, verification_limits, diagnostic_id, diagnostic_project_id, diagnostic_fields, export_diagnostic_events } from "./diagnostics.mjs";

const FILE_LIMIT = 256 * 1024, SECTION_LIMIT = 128 * 1024;
const REPORT_NAME = "1c-ai-core-diagnostics.json";
const componentIds = ["edt", "v8std", "openviking", "code-index", "bsl-ls", "yaxunit", "vanessa"];
const states = new Set("ready disabled stopped missing missing_config missing_project mismatch stale indexing building running not_checked not_verified not_configured invalid check_stale awaiting_observation preparing error connected disconnected blocked unknown verified not_ready".split(" "));
const safeState = value => states.has(value) ? value : "unknown";
const time = value => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const version = value => typeof value === "string" && /^v?\d{1,6}(?:\.\d{1,6}){0,3}(?:[-.]?(?:alpha|beta|rc|preview|dev)(?:[.-]?\d{1,6})?)?$/i.test(value) ? value : null;
const fileMetadata = value => {
  if (!value || typeof value !== "object") return { unavailable: true };
  return Object.fromEntries(["exists", "bytes", "modified", "invalid", "omitted", "unavailable"].filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
};
function checkParents(file, boundary = path.dirname(file)) {
  const anchor = path.resolve(boundary), parent = path.resolve(path.dirname(file)), relative = path.relative(anchor, parent);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("Diagnostic path outside its root");
  let directory = anchor;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    directory = path.join(directory, part);
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Linked diagnostic directory");
  }
}
function operationSummary(operation, now) {
  if (!operation || typeof operation !== "object") return { status: "idle" };
  const fields = diagnostic_fields({ id: operation.id, action: operation.action, projectRoot: operation.projectRoot,
    component: operation.component, phase: operation.progress?.phase, status: operation.status, startedAt: operation.startedAt,
    total: operation.progress?.total, completed: operation.progress?.completed });
  const started = time(operation.startedAt), finished = time(operation.completedAt);
  return { ...fields, status: ["idle", "running", "completed", "failed", "outcome_unknown"].includes(operation.status) ? operation.status : "unknown",
    ...(finished ? { completedAt: finished } : {}), ...(started ? { durationMs: Math.max(0, (finished ? Date.parse(finished) : now) - Date.parse(started)) } : {}),
    result: "omitted", errorText: "omitted" };
}
function observation(check, now) {
  if (!check || typeof check !== "object") return { state: "not_checked", source: "no_saved_observation", freshness: "unknown" };
  const checkedAt = time(check.checkedAt), expiresAt = time(check.expiresAt), state = safeState(check.state);
  const freshness = !checkedAt ? "unknown" : Date.parse(checkedAt) > now ? "clock_skew" : state === "check_stale" || expiresAt && Date.parse(expiresAt) <= now ? "stale" : check.validity === "inputs" ? "input_bound" : expiresAt ? "within_recorded_validity" : "unknown";
  const detail = diagnostic_fields({ reasonCode: check.reasonCode, failure: check.failure || check.diagnostic?.failure, durationMs: check.durationMs });
  const repositories = Array.isArray(check.repositories) ? check.repositories.slice(0, 128).map(item => ({
    id: diagnostic_id(item?.id), ...(item?.edtProject ? { edtProjectId: diagnostic_id(item.edtProject) } : {}),
    ...Object.fromEntries(["required", "matched", "ready", "requirementsMet", "open", "present"].filter(key => typeof item?.[key] === "boolean").map(key => [key, item[key]])),
    ...(item?.state ? { state: safeState(item.state) } : {}) })) : undefined;
  return { state, ...(check.lastState ? { lastState: safeState(check.lastState) } : {}), source: "saved_component_check", checkedAt, expiresAt, freshness, ...detail,
    ...(typeof check.apiCompatible === "boolean" ? { apiCompatible: check.apiCompatible } : {}),
    ...(Array.isArray(check.choices) ? { choicesCount: check.choices.length } : {}),
    ...(repositories ? { repositories, ...(check.repositories.length > repositories.length ? { repositoriesOmitted: check.repositories.length - repositories.length } : {}) } : {}) };
}
function endpoint(value) {
  if (typeof value !== "string" || !value) return { state: "not_configured" };
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return { state: "unsupported_scheme" };
    const host = url.hostname.toLowerCase(), loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(host);
    const unspecified = ["0.0.0.0", "[::]", "::"].includes(host);
    return { state: "configured", scheme: url.protocol.slice(0, -1), port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
      portSource: url.port ? "explicit" : "scheme_default", hostKind: loopback ? "loopback" : unspecified ? "unspecified" : "other",
      endpointId: diagnostic_id(url.origin + url.pathname), source: "effective_settings", connectivity: "not_checked_by_export" };
  } catch { return { state: "invalid_url" }; }
}
function componentSummary(current, now) {
  const values = current?.values || {}, checks = new Map((Array.isArray(current?.componentChecks) ? current.componentChecks : []).filter(check => componentIds.includes(check?.id)).map(check => [check.id, check]));
  const statuses = new Map((Array.isArray(current?.componentStatuses) ? current.componentStatuses : []).filter(item => componentIds.includes(item?.id)).map(item => [item.id, item]));
  const managed = new Map((Array.isArray(current?.summary?.components) ? current.summary.components : []).filter(item => componentIds.includes(item?.id)).map(item => [item.id, item]));
  return Object.fromEntries(componentIds.map(id => {
    const check = checks.get(id), status = statuses.get(id), settings = managed.get(id), item = { currentState: safeState(status?.state || check?.state), currentStateSource: status ? "settings_component_status" : check ? "saved_component_check" : "no_data", observation: observation(check, now) };
    if (id === "edt" || id === "v8std") {
      const address = values[id === "edt" ? "edtUrl" : "v8stdUrl"];
      item.configured = typeof address === "string" ? Boolean(address) : null;
      if (typeof address === "string") item.endpoint = endpoint(address);
    }
    if (id === "edt") {
      const edt = current?.profileDirectoryContext?.edt, connection = edt?.connection;
      if (edt) item.workspace = { source: "directory_context", state: ["detected", "missing_preferences", "invalid_port", "unavailable", "workspace_not_found"].includes(connection?.status) ? connection.status : "unknown",
        liveVerified: false, projectCount: Number.isSafeInteger(edt.projectCount) && edt.projectCount >= 0 ? edt.projectCount : null,
        ...(Number.isSafeInteger(connection?.port) && connection.port > 0 && connection.port <= 65535 ? { port: connection.port } : {}),
        ...(typeof connection?.workspace === "string" ? { workspaceId: diagnostic_project_id(connection.workspace) } : {}) };
    }
    if (id === "openviking") { item.enabled = typeof values.openvikingEnabled === "boolean" ? values.openvikingEnabled : null; item.configured = typeof values.openvikingUrl === "string" ? Boolean(values.openvikingUrl) : null; if (typeof values.openvikingUrl === "string") item.endpoint = endpoint(values.openvikingUrl); }
    if (["code-index", "bsl-ls"].includes(id)) {
      const key = id === "code-index" ? "codeIndex" : "bslLs";
      item.enabled = typeof values[key + "Enabled"] === "boolean" ? values[key + "Enabled"] : null;
      item.installedVersion = version(current?.installedVersions?.[id]);
      item.installationState = item.installedVersion ? "artifact_found" : "not_confirmed";
      item.installationEvidence = "artifact_metadata_only";
      item.mode = ["auto", "external"].includes(settings?.mode) ? settings.mode : "unknown";
      if (id === "bsl-ls" && typeof values.bslLsJava === "string" && values.bslLsJava) item.java = { selection: /[\\/]/.test(values.bslLsJava) ? "path" : "path_lookup", executableId: diagnostic_id(values.bslLsJava), resolution: "not_checked_by_export" };
    }
    if (["yaxunit", "vanessa"].includes(id)) {
      item.enabled = typeof current?.testing?.[id] === "boolean" ? current.testing[id] : null;
      item.configured = current?.testing ? Boolean(current.testing[id + "_config"]) : null;
      const config = current?.testing?.[id + "_config"];
      if (config && typeof config === "object") {
        item.projectLinks = [config.repository_id, ...(id === "yaxunit" ? [config.framework_repository_id, ...(Array.isArray(config.product_repository_ids) ? config.product_repository_ids.slice(0, 32) : [])] : [])].filter(value => typeof value === "string" && value).map(diagnostic_id);
        if (id === "yaxunit" && Array.isArray(config.product_repository_ids) && config.product_repository_ids.length > 32) item.projectLinksOmitted = config.product_repository_ids.length - 32;
        if (id === "yaxunit") item.launchConfigurationSelected = typeof config.launch_configuration === "string" && Boolean(config.launch_configuration);
        else item.runtimeProfileConfigured = typeof config.runtime_profile === "string" && Boolean(config.runtime_profile);
      }
    }
    return [id, item];
  }));
}
function scopedEvents(events, projectRoot, instance, selectedRoot = projectRoot) {
  const projectIds = new Set([diagnostic_project_id(projectRoot), diagnostic_project_id(selectedRoot)].filter(Boolean));
  const instanceId = diagnostic_id(instance || "default"), matches = event => event.detail?.projectId || event.detail?.binding?.projectId;
  const sessions = new Set(events.filter(event => projectIds.has(matches(event)) && (!event.instanceId || event.instanceId === instanceId)).map(event => event.session).filter(Boolean));
  let excluded = 0, unboundOmitted = 0, unboundKept = 0;
  const kept = [];
  for (const event of export_diagnostic_events(events).reverse()) {
    const project = matches(event);
    if ((event.instanceId && event.instanceId !== instanceId) || (project && !projectIds.has(project))) { excluded++; continue; }
    if (project) kept.push({ ...event, scope: "project" });
    else if (event.session && sessions.has(event.session)) kept.push({ ...event, scope: "session" });
    else if (["error", "warn"].includes(event.level)) {
      if (unboundKept < 100) { kept.push({ ...event, scope: "unbound_unknown" }); unboundKept++; }
      else unboundOmitted++;
    }
    else excluded++;
  }
  return { events: kept.reverse(), excluded, unboundOmitted };
}
function export_directory(state) {
  let directory = path.resolve(state);
  for (const part of ["diagnostics", "exports"]) {
    directory = path.join(directory, part);
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Каталог экспорта диагностики должен быть обычным каталогом");
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
export function detailed_log_export(state, days, now = Date.now()) {
  if (![1, 3, 7].includes(days)) throw new Error("Выберите период журнала: 1, 3 или 7 дней.");
  const logs = read_diagnostic_logs(state), cutoff = now - days * 86400000;
  const events = export_diagnostic_events(logs.events.filter(event => Date.parse(event.time) >= cutoff));
  const lines = ["1C AI Core — журнал событий", `Период: ${days} дн.`, "Пути и произвольный текст заменены диагностическими идентификаторами или исключены.", "", ...events.map(event => JSON.stringify(event))];
  if (logs.issues.length) lines.push("", "Замечания при чтении: " + JSON.stringify(sanitize_diagnostics(logs.issues)));
  return { filename: "1c-ai-core-log.txt", mimeType: "text/plain", text: lines.join("\n") + "\n" };
}
// Deliberately no CLI or model tool. Only the settings app calls this collector.
// Every section fails independently; invalid settings must still be exportable.
export async function support_bundle({ state, configPath, selectedRoot, selection, operation, operations, operationsObservedAt, loggerStatus, readCurrent }) {
  const issues = [], snapshot = {};
  const capture = async (name, read) => {
    try { snapshot[name] = await read(); }
    catch (error) { const reason = ["ENOENT", "EACCES", "EPERM", "READ_TIMEOUT", "LOCAL_FILE_CHANGED"].includes(error?.code) ? error.code : "unavailable";
      snapshot[name] = { unavailable: true, error: reason }; issues.push({ section: name, reason }); }
  };
  const document = async (file, label = "document", boundary) => {
    if (file instanceof URL) file = fileURLToPath(file);
    let stat;
    try { checkParents(file, boundary); stat = fs.lstatSync(file); }
    catch (error) {
      if (error.code === "ENOENT") return { exists: false };
      issues.push({ section: label, reason: "path_unavailable" }); return { unavailable: true };
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) { issues.push({ section: label, reason: "path_not_regular" }); return { unavailable: true }; }
    const metadata = { exists: true, bytes: stat.size, modified: stat.mtime.toISOString() };
    if (stat.size > FILE_LIMIT) { issues.push({ section: label, reason: "file_size_limit" }); return { ...metadata, omitted: "file_size_limit" }; }
    try {
      const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
      const fd = fs.openSync(file, flags);
      let text;
      try {
        const opened = fs.fstatSync(fd);
        if (!opened.isFile() || opened.nlink > 1 || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) throw Object.assign(new Error("file changed"), { code: "LOCAL_FILE_CHANGED" });
        const bytes = Buffer.alloc(opened.size + 1); let length = 0;
        while (length < bytes.length) { const count = fs.readSync(fd, bytes, length, bytes.length - length, null); if (!count) break; length += count; }
        const after = fs.fstatSync(fd);
        if (length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw Object.assign(new Error("file changed"), { code: "LOCAL_FILE_CHANGED" });
        text = bytes.subarray(0, length).toString("utf8");
      } finally { fs.closeSync(fd); }
      let value;
      try { value = JSON.parse(text); }
      catch { const { parse } = await import("./common.mjs"); value = parse(text); }
      return { ...metadata, value };
    }
    // YAML parser errors can include a source excerpt containing a secret.
    catch (error) { const reason = error.code === "LOCAL_FILE_CHANGED" ? "file_changed" : typeof error.code === "string" && /^E[A-Z0-9]+$/.test(error.code) ? "read_failed" : "invalid_document";
      issues.push({ section: label, reason }); return { ...metadata, ...(reason === "invalid_document" ? { invalid: true } : { unavailable: true }) }; }
  };
  await capture("plugin", async () => ({ manifest: await document(new URL("../plugin.json", import.meta.url)), build: await document(new URL("../build-info.json", import.meta.url)) }));
  await capture("settings", () => document(configPath, "settings"));
  await capture("runtimeArtifacts", () => document(path.join(state, "runtime-lock.json"), "runtimeArtifacts"));
  await capture("environmentCompatibility", () => environment_compatibility({ projectRoot: selectedRoot }));
  await capture("verificationLimits", () => verification_limits());
  let projectIdentityRoot = selectedRoot;
  if (selectedRoot) {
    try { const { configuration_root } = await import("./project_paths.mjs"); projectIdentityRoot = configuration_root(selectedRoot, { recursive: false }); }
    catch { issues.push({ section: "project", reason: "project_root_unavailable" }); }
    await capture("current", async () => {
      if (!readCurrent) return { unavailable: true };
      let timer;
      try { return await Promise.race([Promise.resolve().then(readCurrent), new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("read timeout"), { code: "READ_TIMEOUT" })), 10000); })]); }
      finally { clearTimeout(timer); }
    });
    await capture("project", async () => {
      const { configuration_root, project_directory, instance_name } = await import("./project_paths.mjs");
      const root = configuration_root(selectedRoot, { recursive: false }), home = project_directory(state, root), instance = instance_name();
      return { root, home,
        profile: await document(path.join(root, ".ai/project.yaml"), "project.profile", root),
        local: await document(path.join(root, ".ai/project.local.yaml"), "project.local", root),
        connectionsFile: process.env.EDT_AI_CONNECTIONS_FILE ? await document(process.env.EDT_AI_CONNECTIONS_FILE, "project.connectionsFile") : null,
        preparation: await document(path.join(home, "instances", instance + ".preparation.json"), "project.preparation", state),
        reconnect: await document(path.join(home, "instances", instance + ".reconnect.json"), "project.reconnect", state),
        daemon: await document(path.join(home, "code-index/daemon.json"), "project.daemon", state),
        owner: await document(path.join(home, "code-index/owner.json"), "project.owner", state),
        maintenance: await document(path.join(home, "code-index/maintenance.json"), "project.maintenance", state) };
    });
    // Native logs are untrusted text and can echo credentials in arbitrary
    // encodings. Collect file metadata only, never their contents.
    for (const name of ["daemon.log", "daemon.log.1", "daemon.log.2", "daemon.log.3"]) await capture("codeIndex_" + name, async () => {
      const home = snapshot.project?.home;
      if (!home) return { unavailable: true };
      const file = path.join(home, "code-index", name);
      let stat;
      try { checkParents(file, state); stat = fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return { exists: false }; throw error; }
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Неподдерживаемый файл диагностики");
      if (stat.mtimeMs < Date.now() - LOG_POLICY.days * 86400000) return { omitted: "expired" };
      return { bytes: stat.size, modified: stat.mtime.toISOString(), omitted: "untrusted_runtime_log_content" };
    });
  }
  let logs;
  try { logs = read_diagnostic_logs(state); }
  catch (error) { logs = { events: [], issues: [error.code || error.name] }; }
  if (loggerStatus?.dropped || loggerStatus?.priorityDropped) issues.push({ section: "logger", reason: "write_failed", dropped: Number.isSafeInteger(loggerStatus.dropped) ? loggerStatus.dropped : 0, priorityDropped: Number.isSafeInteger(loggerStatus.priorityDropped) ? loggerStatus.priorityDropped : 0 });
  if (snapshot.current?.values?.projectRoot && diagnostic_project_id(projectIdentityRoot) !== diagnostic_project_id(snapshot.current.values.projectRoot)) {
    snapshot.current = { unavailable: true, error: "project_scope_changed" };
    issues.push({ section: "current", reason: "project_scope_changed" });
  }
  const now = Date.now(), current = snapshot.current, createdAt = new Date(now).toISOString();
  const operationTime = time(operationsObservedAt) || createdAt, operationNow = Date.parse(operationTime);
  const selectedInstanceId = diagnostic_id(process.env.EDT_AI_INSTANCE || "default");
  const selectedProjects = new Set([diagnostic_project_id(projectIdentityRoot), diagnostic_project_id(selectedRoot)].filter(Boolean));
  const sameScope = item => (!item?.projectRoot || selectedProjects.has(diagnostic_project_id(item.projectRoot))) &&
    (!item?.instance || diagnostic_id(item.instance) === selectedInstanceId);
  const retainedOperations = Array.isArray(operations) ? operations.filter(item => item && typeof item === "object") : [];
  const excludedOperations = retainedOperations.filter(item => !sameScope(item)).length +
    (operation && !sameScope(operation) && !retainedOperations.some(item => item.id && item.id === operation.id) ? 1 : 0);
  const safe = {
    plugin: { manifest: fileMetadata(snapshot.plugin?.manifest), build: fileMetadata(snapshot.plugin?.build),
      version: version(snapshot.plugin?.manifest?.value?.version),
      ...(typeof snapshot.plugin?.build?.value?.dirty === "boolean" ? { dirty: snapshot.plugin.build.value.dirty } : {}),
      ...(typeof snapshot.plugin?.build?.value?.revision === "string" && /^[a-f0-9]{7,64}$/i.test(snapshot.plugin.build.value.revision) ? { revision: snapshot.plugin.build.value.revision } : {}) },
    host: { observedAt: createdAt, source: "settings_process", platform: process.platform, architecture: process.arch,
      osRelease: /^\d+(?:\.\d+){0,3}(?:[-+.][a-z0-9.-]{1,30})?$/i.test(os.release()) ? os.release() : null, node: process.version,
      projectId: diagnostic_project_id(projectIdentityRoot), ...(selectedRoot ? {} : { selectedRoot: null }), instanceId: diagnostic_id(process.env.EDT_AI_INSTANCE || "default"),
      selection: { rootLocked: selection?.rootLocked === true, pendingRoots: Boolean(selection?.pendingRoots), selectionError: Boolean(selection?.selectionError) },
      operationsObservedAt: operationTime,
      operation: sameScope(operation) ? { ...operationSummary(operation, operationNow), ...(operation?.id ? { scope: operation.projectRoot ? "project" : "unbound_unknown" } : {}) } : { status: "unavailable", reason: "different_scope" },
      otherOperations: retainedOperations.filter(item => item.id !== operation?.id && sameScope(item)).slice(-16).map(item => ({ ...operationSummary(item, operationNow), scope: item.projectRoot ? "project" : "unbound_unknown" })),
      loggerStatus: { observedAt: operationTime, dropped: Number.isSafeInteger(loggerStatus?.dropped) ? loggerStatus.dropped : 0,
        priorityDropped: Number.isSafeInteger(loggerStatus?.priorityDropped) ? loggerStatus.priorityDropped : 0,
        ...(["EACCES", "EPERM", "ENOSPC", "EEXIST", "write_failed", "priority_write_failed"].includes(loggerStatus?.lastError) ? { lastError: loggerStatus.lastError } : {}) } },
    settings: fileMetadata(snapshot.settings), runtimeArtifacts: fileMetadata(snapshot.runtimeArtifacts),
    verificationLimits: verification_limits(),
    environmentCompatibility: snapshot.environmentCompatibility?.unavailable ? { unavailable: true } : {
      state: ["attention_required", "no_observed_conflicts"].includes(snapshot.environmentCompatibility?.state) ? snapshot.environmentCompatibility.state : "unknown",
      source: "bounded_configuration_declarations", hostEffectiveConfiguration: "not_verified", hostToolCatalogue: "not_verified",
      sources: (snapshot.environmentCompatibility?.sources || []).slice(0, 8).map((item, index) => ({ source: ["plugin", "user", "project"][index] || "unknown", state: ["inspected", "missing", "unavailable", "size_limit"].includes(item.state) ? item.state : "unknown" })),
      findings: (snapshot.environmentCompatibility?.findings || []).slice(0, 64).map(item => ({ code: ["forbidden_route", "parallel_connection", "auto_capture"].includes(item.code) ? item.code : "unknown",
        ...(["edt", "v8std", "openviking"].includes(item.component) ? { component: item.component } : {}),
        ...(["1c-docs-mcp", "1c-ssl-mcp", "HelpSearchServer"].includes(item.route) ? { route: item.route } : {}), ...(typeof item.enabled === "boolean" ? { enabled: item.enabled } : {}) })) },
  };
  if (selectedRoot) {
    safe.current = current?.unavailable ? { unavailable: true, ...(["ENOENT", "EACCES", "EPERM", "READ_TIMEOUT", "LOCAL_FILE_CHANGED", "project_scope_changed", "unavailable"].includes(current.error) ? { error: current.error } : {}) } : { observedAt: time(current?.summary?.observedAt) || createdAt,
      source: "settings_read", profileStatus: ["loaded", "invalid", "ambiguous", "missing", "unselected"].includes(current?.profile?.status) ? current.profile.status : "unknown",
      readiness: { state: safeState(current?.readiness?.state), source: "saved_setup_receipt", checkedAt: time(current?.readiness?.checkedAt), expiresAt: time(current?.readiness?.expiresAt) },
      components: componentSummary(current, now) };
    const knowledge = current?.knowledge || {}, setup = current?.summary?.knowledge || {};
    safe.knowledge = { configuration: { provider: ["none", "openviking"].includes(knowledge.provider) ? knowledge.provider : "unknown",
      configured: typeof knowledge.configured === "boolean" ? knowledge.configured : null, state: safeState(knowledge.state) },
      setup: { scope: setup.scope === "setup" ? "setup" : "unknown", state: safeState(setup.state), authorizesWorkflow: false },
      liveAcceptance: "not_verified", corpusContents: "not_collected" };
    if (snapshot.project && !snapshot.project.unavailable) {
      safe.project = Object.fromEntries(["profile", "local", "connectionsFile", "preparation", "reconnect", "daemon", "owner", "maintenance"].map(key => [key, fileMetadata(snapshot.project[key])]));
      if (snapshot.project.connectionsFile === null) safe.project.connectionsFile = { exists: false, reason: "not_configured" };
      for (const key of ["daemon", "owner"]) {
        const data = snapshot.project[key]?.value;
        if (Number.isSafeInteger(data?.pid) && data.pid > 0) safe.project[key].pid = data.pid;
        if (key === "daemon" && Number.isSafeInteger(data?.http_port) && data.http_port > 0 && data.http_port <= 65535) safe.project[key].port = data.http_port;
        if (key === "daemon" && version(data?.version)) safe.project[key].version = version(data.version);
        if (key === "daemon" && time(data?.started_at)) safe.project[key].startedAt = time(data.started_at);
        safe.project[key].processLiveness = "not_checked";
      }
    } else safe.project = { unavailable: true };
    for (const name of ["daemon.log", "daemon.log.1", "daemon.log.2", "daemon.log.3"]) {
      const key = "codeIndex_" + name, value = snapshot[key];
      safe[key] = value && typeof value === "object" ? Object.fromEntries(["bytes", "modified", "omitted", "exists", "unavailable"].filter(field => Object.hasOwn(value, field)).map(field => [field, value[field]])) : { unavailable: true };
    }
  }
  // Sections and export size remain bounded independently of local state size.
  for (const [name, value] of Object.entries(safe)) if (Buffer.byteLength(JSON.stringify(value)) > SECTION_LIMIT) {
    safe[name] = { omitted: "section_size_limit" }; issues.push({ section: name, reason: "section_size_limit" });
  }
  const scoped = scopedEvents(logs.events, projectIdentityRoot, process.env.EDT_AI_INSTANCE || "default", selectedRoot);
  const report = { format: "1c-ai-core-diagnostics", version: 2, createdAt,
    collection: { policy: LOG_POLICY, readOnly: true, networkRequests: false,
      includes: ["Операционные события недавних сессий плагина", "Текущие настройки выбранного проекта и локальное состояние компонентов"],
      excludes: ["История чата", "Исходные файлы", "Значения переменных окружения", "Аргументы и результаты MCP", "Содержимое журналов внешних сервисов"],
      redaction: "Только разрешённые типизированные поля; пути, адреса, произвольные сообщения, результаты операций и содержимое файлов исключены. Идентификаторы проектов и инструментов хешированы.",
      scope: { projectId: diagnostic_project_id(projectIdentityRoot), instanceId: selectedInstanceId, excludedEvents: scoped.excluded, excludedOperations, unboundEventsOmitted: scoped.unboundOmitted,
        unboundEvents: "unbound_unknown is not evidence of association with this project", retention: "bounded; older and dropped records may be unavailable",
        ordering: "sequence orders records within one logger session; timestamps do not establish order across sessions",
        logRead: logs.stats || { unavailable: true },
        observedDroppedRecords: logs.events.reduce((total, event) => total + (event.droppedBefore || 0), 0),
        observedPriorityWriteFailures: logs.events.reduce((total, event) => total + (event.priorityDroppedBefore || 0), 0),
        mainRotationObserved: logs.events.some(event => event.rotatedBefore), priorityRotationObserved: logs.events.some(event => event.priorityRotatedBefore) },
      issues: [...issues, ...logs.issues.map(issue => ({ section: "events", reason: /Unsupported log format/.test(issue) ? "unsupported_log_format" : /Conflicting duplicate/.test(issue) ? "conflicting_duplicate" : /size limit/.test(issue) ? "file_size_limit" : /invalid record/.test(issue) ? "invalid_record" : "log_read_failed" }))] },
    snapshot: safe, events: scoped.events };
  return { filename: "1c-ai-core-diagnostics-" + createdAt.replace(/[:.]/g, "-") + ".json", mimeType: "application/json", text: JSON.stringify(report, null, 2) + "\n" };
}
