import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { read_frames } from "../scripts/mcp_codec.mjs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { launch_selection, roots_selection, explicit_selection } from "../scripts/selection.mjs";
import { core_version } from "../scripts/compatibility.mjs";
import { SettingsOperations } from "./settings-operations.mjs";
import { plugin_icons, component_icons } from "../scripts/icons.mjs";
import { folder_action, folder_actions_supported } from "../scripts/settings_folder.mjs";
import { create_diagnostic_logger, register_diagnostic_secrets, diagnostic_journal, sanitize_diagnostics, safe_error_message } from "../scripts/diagnostics.mjs";
import { locate_project, path_identity } from "../scripts/project_paths.mjs";
import { launch, stop_child } from "../scripts/processes.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const state = process.env.EDT_AI_STATE_DIR || path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "1c-ai-core");
const configPath = process.env.EDT_AI_SETTINGS || path.join(state, "settings.json");
const diagnostic = create_diagnostic_logger("settings", state);
process.on("uncaughtExceptionMonitor", error => diagnostic.event("uncaught_exception", { error }, "error"));
const resource = "ui://1c-ai-core/settings.html";
const protocols = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
let selectedRoot = process.env.EDT_AI_PROJECT_ROOT || null;
let viewedRoot = null;
let latestDiagnosticsExport = null;
const pickedImports = new Map();
let rootLocked = Boolean(selectedRoot);
let selectionRevision = 0;
let pendingRoots = null, rootsSequence = 0, requestInitialRoots = false;
let selectionError = null, rootReady = Promise.resolve(), finishRoots;
let transferInFlight = null, deferredRoots = false;
let indexObserverPromise = null, indexObserverCleanup = Promise.resolve(), indexObserverFailure = null;
let sessionClosing = false, shutdownPromise = null;
let backendCleanupFailure = null;
const backendCleanups = new Map();
function waitIndexObserverCleanup(reason) {
  const pending = indexObserverCleanup;
  let timer;
  const failed = error => {
    if (!indexObserverFailure) {
      indexObserverFailure = error;
      diagnostic.event("index_observer_cleanup_failed", { reason, error }, "error");
    }
    return Object.assign(new Error("Завершение предыдущего читателя индекса не подтверждено."), { outcomeUnknown: true, cause: indexObserverFailure });
  };
  if (indexObserverFailure) return Promise.reject(failed(indexObserverFailure));
  return Promise.race([
    pending,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Index observer cleanup timed out")), 12000); }),
  ]).then(() => { if (indexObserverFailure) throw failed(indexObserverFailure); }, error => { throw failed(error); })
    .finally(() => clearTimeout(timer));
}
function indexObserver() {
  if (sessionClosing) throw Object.assign(new Error("Сеанс настроек закрывается."), { outcomeUnknown: true });
  if (indexObserverFailure) throw Object.assign(new Error("Завершение предыдущего читателя индекса не подтверждено."), { outcomeUnknown: true });
  return indexObserverPromise ||= waitIndexObserverCleanup("new_reader").then(() => {
    if (sessionClosing) throw Object.assign(new Error("Сеанс настроек закрывается."), { outcomeUnknown: true });
    if (indexObserverFailure) throw Object.assign(new Error("Завершение предыдущего читателя индекса не подтверждено."), { outcomeUnknown: true });
    return import("../scripts/index_observer_proxy.mjs").then(({ IndexObserverProxy }) => new IndexObserverProxy(state));
  });
}
function dropIndexObserver(reason) {
  const previous = indexObserverPromise; indexObserverPromise = null;
  if (previous) indexObserverCleanup = indexObserverCleanup.then(() => previous).then(observer => observer.close()).catch(error => {
    if (!indexObserverFailure) { indexObserverFailure = error; diagnostic.event("index_observer_cleanup_failed", { reason, error }, "error"); }
  });
  return waitIndexObserverCleanup(reason);
}
function requestRoots() {
  if (process.env.EDT_AI_PROJECT_ROOT) return;
  if (transferInFlight) { deferredRoots = true; return; }
  finishRoots?.();
  void dropIndexObserver("roots_changed").catch(() => {});
  selectionRevision += 1;
  selectedRoot = null;
  rootLocked = false;
  selectionError = "Ожидается выбранный каталог проекта.";
  rootReady = new Promise(resolve => { finishRoots = resolve; });
  pendingRoots = `settings-roots-${++rootsSequence}`;
  write({ id: pendingRoots, method: "roots/list", params: {} });
}
// A new project has no profile yet. Its launch directory still belongs to this
// chat; never use the plugin install directory or a saved active_project here.
function useLaunchDirectory() {
  selectedRoot = launch_selection().directory;
  rootLocked = Boolean(selectedRoot);
  selectionError = null;
}
if (!selectedRoot) useLaunchDirectory();
if (selectedRoot) diagnostic.event("session_started", { version: core_version, projectRoot: selectedRoot, node: process.version });
const empty = { type: "object", properties: {}, additionalProperties: false };
const preparationAuthorization = {
  type: "object", additionalProperties: false,
  properties: { scope: { type: "string", minLength: 1 }, effects: {
    type: "array", items: { const: "launch" }, minItems: 1, maxItems: 1,
  }, evidence: { type: "string", minLength: 1 } },
  required: ["scope", "effects", "evidence"],
};
const primitive = {
  projectRoot: { type: "string", title: "Папка проекта" },
  edtUrl: { type: "string", title: "URL EDT MCP", description: "Override этого каталога и экземпляра. Пустое значение отключает подключение; окружение имеет высший приоритет." },
  v8stdUrl: { type: "string", title: "URL v8std MCP", description: "Подключение разрешает операции v8std и передачу ему кода и контекста задачи. Override этого каталога и экземпляра. Пустое значение отключает подключение; окружение имеет высший приоритет." },
  codeIndexEnabled: { type: "boolean", title: "Индекс кода" },
  bslLsEnabled: { type: "boolean", title: "BSL LS", description: "Включён по умолчанию; дополняет диагностику EDT." },
  codeIndexVersion: { type: "string", title: "Версия индекса кода", pattern: "^(latest|[A-Za-z0-9][A-Za-z0-9._+-]{0,127})$", description: "latest или точный тег, включая предварительный релиз. Общая настройка пользователя." },
  codeIndexAllowPrerelease: { type: "boolean", title: "Предварительные релизы индекса кода", description: "При version=latest разрешить предварительные релизы. По умолчанию false. Общая настройка пользователя." },
  bslLsVersion: { type: "string", title: "Версия BSL LS", pattern: "^(latest|[A-Za-z0-9][A-Za-z0-9._+-]{0,127})$", description: "latest или точный тег, включая предварительный релиз. Общая настройка пользователя." },
  bslLsAllowPrerelease: { type: "boolean", title: "Предварительные релизы BSL LS", description: "При version=latest разрешить предварительные релизы. По умолчанию false. Общая настройка пользователя." },
  bslLsJava: { type: "string", minLength: 1, title: "Java для BSL LS" },
  openvikingEnabled: { type: "boolean", title: "Транспорт OpenViking", description: "Включает подключение для текущего каталога и экземпляра. При выключении сохранённый URL остаётся; режим и обязательность знаний не изменяются." },
  openvikingUrl: { type: "string", title: "URL OpenViking", description: "Пустое значение отключает транспорт." },
  openvikingTimeout: { type: "number", title: "Таймаут OpenViking, с", exclusiveMinimum: 0, maximum: 300 },
  openvikingMaxResponseBytes: { type: "integer", title: "Лимит ответа OpenViking, байт", minimum: 1024, maximum: 16777216 },
  openvikingConnectionId: { type: "string", title: "Код подключения OpenViking", pattern: "^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$" },
};
const versionCatalogs = new Map();
const openvikingTransport = { type: "object", additionalProperties: false, properties: {
  enabled: primitive.openvikingEnabled, url: primitive.openvikingUrl,
  timeout_seconds: primitive.openvikingTimeout, max_response_bytes: primitive.openvikingMaxResponseBytes,
  connection_id: primitive.openvikingConnectionId,
} };

function values(c) {
  return {
    projectRoot: c.active_project || "",
    edtUrl: c.mcp.required.edt.url, v8stdUrl: c.mcp.required.v8std.url,
    codeIndexEnabled: c.mcp.managed["code-index"].enabled !== false, bslLsEnabled: c.mcp.managed["bsl-ls"].enabled !== false,
    codeIndexVersion: c.mcp.managed["code-index"].version, codeIndexAllowPrerelease: Boolean(c.mcp.managed["code-index"].allow_prerelease),
    bslLsVersion: c.mcp.managed["bsl-ls"].version, bslLsAllowPrerelease: Boolean(c.mcp.managed["bsl-ls"].allow_prerelease),
    bslLsJava: c.mcp.managed["bsl-ls"].java,
    openvikingEnabled: Boolean(c.mcp.optional?.openviking?.enabled),
    openvikingUrl: c.mcp.optional?.openviking?.url || "",
    openvikingTimeout: c.mcp.optional?.openviking?.timeout_seconds,
    openvikingMaxResponseBytes: c.mcp.optional?.openviking?.max_response_bytes,
    openvikingConnectionId: c.mcp.optional?.openviking?.connection_id || "",
  };
}
async function readValues(remember = false) {
  // The Node backend owns JSON/YAML loading, profile resolution and precedence.
  // The unconfigured screen remains dependency-free and does not create state.
  if (selectedRoot || fs.existsSync(configPath) || fs.existsSync(path.join(state, "projects"))) {
    try {
      const current = await backend("read", { remember });
      return current;
    }
    catch (error) {
      diagnostic.event("settings_unavailable", { error }, "error");
      const defaults = JSON.parse(fs.readFileSync(path.join(root, "settings", "defaults.json"), "utf8"));
      return { values: { ...values(defaults), projectRoot: selectedRoot || "" },
        profile: { status: "invalid", detail: error.code === "BACKEND_OUTPUT_LIMIT" ? "Ответ сервиса настроек превысил допустимый размер. Проверьте объём настроек и скачайте диагностику." : "Не удалось прочитать настройки. Скачайте диагностику для поддержки.", path: null },
        configurationError: true, instance: process.env.EDT_AI_INSTANCE || "default", preparationScope: null };
    }
  }
  const defaults = JSON.parse(fs.readFileSync(path.join(root, "settings", "defaults.json"), "utf8"));
  return { values: { ...values(defaults), projectRoot: "" }, profile: { status: "unselected", path: null }, instance: process.env.EDT_AI_INSTANCE || "default", preparationScope: null };
}
function readSettings(actual) {
  const properties = structuredClone(primitive);
  for (const [field, source] of Object.entries({ ...actual.valueSources, ...actual.managedValueSources }))
    if (properties[field] && (source.startsWith("environment:") || source === "connections_file"))
      properties[field].readOnly = true;
  return {
    schema: { type: "object", properties },
    values: actual.values, instance: actual.instance, connectionSources: actual.connectionSources,
    valueSources: actual.valueSources, managedValueSources: actual.managedValueSources,
    settingsRevision: actual.settingsRevision, writePaths: actual.writePaths, layerValues: actual.layerValues,
    localOverridePaths: actual.localOverridePaths,
    configurationValues: actual.configurationValues, configurationSources: actual.configurationSources,
    installedVersions: actual.installedVersions,
    preparationScope: actual.preparationScope,
    profile: actual.profile, directoryContext: actual.directoryContext, sessionGuidance: actual.sessionGuidance,
    profileDirectoryContext: actual.profileDirectoryContext,
    edtPortSuggestion: actual.edtPortSuggestion,
    readiness: publicResult(actual.readiness),
    componentChecks: publicResult(actual.componentChecks),
    componentStatuses: publicResult(actual.componentStatuses),
    testing: actual.testing,
    knowledge: actual.knowledge,
    environmentCompatibility: actual.environmentCompatibility,
    profileHistory: actual.profileHistory || [], profileHistoryHidden: actual.profileHistoryHidden, summary: actual.summary,
    configurationError: actual.configurationError,
    operation: operationSummary(),
    folderActions: { supported: folder_actions_supported() },
    projectSelection: { status: selectionError ? (pendingRoots ? "pending" : "ambiguous") : selectedRoot ? "selected" : "unselected",
      locked: rootLocked, detail: selectionError },
  };
}
const annotations = (readOnly = true) => ({ readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false });
const appOnly = { ui: { visibility: ["app"] } };
// Chat and the advanced form use the same validation and scoped backend.
const shared = { ui: { visibility: ["app", "model"] } };
const appTool = { ui: { resourceUri: resource, visibility: ["app", "model"] } };
const inspectInput = { type: "object", properties: {
  projectRoot: { type: "string", minLength: 1, description: "Known local directory of this chat when host roots are empty. Read-only inspection binds only this settings session; does not create a profile or launch services." },
}, additionalProperties: false };
const editArguments = {
  mode: { type: "string", const: "layer", description: "Edit one selected project document." },
  baseRevision: { type: "string", minLength: 1, description: "Exact baseRevision returned by settings.edit." },
  layerScope: { type: "string", enum: ["profile", "project_local"], description: "The project document returned by settings.edit." },
};
const tools = [
  { name: "settings.forget_profile", title: "Убрать профиль из списка", description: "Remove a profile from the user's list without deleting the profile, project state, or changing the chat selection.",
    inputSchema: { type: "object", required: ["projectRoot"], properties: { projectRoot: { type: "string", minLength: 1 } }, additionalProperties: false }, annotations: annotations(false), _meta: appOnly },
  { name: "settings.select_profile", title: "Открыть профиль", description: "Explicitly select a directory in the settings app. Another chat's profile is read-only and never rebinds the current chat.",
    inputSchema: { type: "object", required: ["projectRoot"], properties: { projectRoot: { type: "string", minLength: 1 } }, additionalProperties: false }, annotations: annotations(false), _meta: appOnly },
  { name: "settings.status", title: "Сводное состояние профиля", description: "Passive profile and local daemon observation. Does not launch services or repeat preparation or probes.",
    inputSchema: { type: "object", properties: { projectRoot: { type: "string", minLength: 1 } }, additionalProperties: false }, annotations: annotations(), _meta: appOnly },
  { name: "settings.refresh_readiness", title: "Обновить состояние компонентов", description: "Refresh component status for this exact project and instance. Checks all seven components, or only component when supplied. Local BSL LS reuses its last API evidence while launch inputs remain unchanged; absent or changed evidence requires an explicit check. Observation never starts a JVM, grants permission, downloads, installs, restarts a daemon or rebinds chat connections. Poll settings.operation with the returned id.",
    inputSchema: { type: "object", properties: { scope: { type: "string", minLength: 1 }, component: { enum: ["edt", "v8std", "openviking", "code-index", "bsl-ls", "yaxunit", "vanessa"] }, automatic: { type: "boolean" } }, required: ["scope"], additionalProperties: false }, annotations: { ...annotations(false), openWorldHint: true }, _meta: appOnly },
  { name: "settings.reset_connection", title: "Вернуть наследование подключения", description: "Remove the project-local URL override and inherit the next configured source.",
    inputSchema: { type: "object", required: ["connection"], properties: { connection: { type: "string", enum: ["edt", "v8std", "openviking"] }, expectedRevision: { type: "string", minLength: 1 } }, additionalProperties: false }, annotations: annotations(false), _meta: appOnly },
  { name: "settings.open", title: "Настройки", description: "Open the full settings workspace with the user's profile list from Open plugin or app navigation. Status observation is passive; preparation requires an explicit action.",
    inputSchema: empty, annotations: annotations(), _meta: { ui: { resourceUri: resource, visibility: ["app"] }, "openai/ui": { entrypoints: [{ type: "global" }] } } },
  { name: "settings.inspect", title: "Проверить настройку проекта", description: "Start chat setup here: compact profile validation, effective connections, detected EDT projects/port, managed preparation and next steps in one read-only call. Supply this chat's known projectRoot when host roots are empty. Do not read plugin source or reload an already loaded profile to diagnose setup.",
    inputSchema: inspectInput, annotations: annotations(), _meta: shared },
  { name: "settings.probe_connections", title: "Проверить компонент или подключения", description: "Check the selected component and cache its scoped result, or check all external connections when component is omitted. YaXUnit checks exact EDT project mappings, client launch configurations and applications against the live API; ready confirms launch settings, never test results. Does not run a client, tests or database updates or change project settings. Reuses local BSL LS evidence until launch inputs change. Invalidated local BSL LS checks require an existing project/instance preparation grant and installed JAR; their temporary JVM closes before completion. Never downloads, installs or restarts a daemon. Testing configuration is distinct from runtime acceptance. Returns an operation ID: poll settings.operation with waitMs=10000; never repeat to wait. This acceptance is separate from current chat relay binding.",
    inputSchema: { type: "object", properties: { component: { enum: ["edt", "v8std", "openviking", "code-index", "bsl-ls", "yaxunit", "vanessa"], description: "Check only this component; invalidated local BSL LS evidence may use a temporary JVM under its existing scoped grant. Omit for all external connections." }, connections: { type: "object", properties: { edt: { type: "string" }, v8std: { type: "string" }, openviking: openvikingTransport }, additionalProperties: false, description: "Optional unsaved transport fields to test without persisting them. Empty URLs disconnect transport without changing knowledge requirements." } }, additionalProperties: false }, annotations: { ...annotations(false), openWorldHint: true }, _meta: shared },
  { name: "settings.profile", title: "Настройки проекта", description: "Open the settings form for this chat's selected profile only on an explicit user request to open/show this form. Chat configuration, code analysis and runtime troubleshooting do not authorize opening a form; use settings.inspect instead. Always supply this chat's known projectRoot so the form retains its directory across MCP connections; {} uses host roots when available. Does not reload profiles or borrow another chat's directory.",
    inputSchema: inspectInput, annotations: annotations(), _meta: { ...appTool, "openai/ui": { entrypoints: [{ type: "thread" }] } } },
  ...[["settings.create", "Создать профиль", "Create the generic .ai/project.yaml and missing project instructions in this chat's selected repository, only when the user requests creation. Never overwrites a profile or existing instructions. Returns projectInstructions.created/preserved; optional overrideFile reports a non-empty AGENTS.override.md that takes precedence over the adjacent AGENTS.md. contentValidated=false means project rules still need review. Follow the setup skill's project-instructions reference to complete them from confirmed facts. Repository mappings still need configuration."],
      ["settings.load", "Загрузить профиль", "Validate and reload the existing .ai/project.yaml for this chat's selected repository. Does not import a file or launch services. Report sessionGuidance. Use the assigned relay's core_runtime_tools/core_runtime_call with this chat's projectRoot."]].map(([name, title, description]) => ({
    name, title, description, inputSchema: { type: "object", properties: { projectRoot: { type: "string", minLength: 1, description: "Only for an unbound settings screen. A chat's selected root cannot be changed." } }, additionalProperties: false },
    annotations: annotations(false), _meta: shared,
  })),
  { name: "settings.read", title: "Настройки 1C AI Core", description: "Read plugin settings.",
    inputSchema: empty, outputSchema: { type: "object", required: ["schema", "values"],
      properties: { schema: { type: "object" }, values: { type: "object" } } },
    annotations: annotations(), _meta: shared },
  { name: "settings.pick_directory", title: "Выбрать папку проекта", description: "Start the native folder picker for an unbound settings screen and return an operation ID immediately. Poll settings.operation; do not repeat to wait. Cancellation leaves the selection unchanged.",
    inputSchema: { type: "object", properties: { projectRoot: { type: "string" } }, additionalProperties: false },
    annotations: annotations(false), _meta: appOnly },
  { name: "settings.pick_view_directory", title: "Выбрать папку для просмотра", description: "Choose another directory for read-only viewing without changing the bound chat project. Returns an operation ID; poll settings.operation.",
    inputSchema: empty, annotations: annotations(), _meta: appOnly },
  { name: "settings.pick_java", title: "Выбрать Java", description: "Choose a Java installation in a native folder dialog and verify its executable. Returns an operation ID; does not save settings.", inputSchema: empty, annotations: annotations(false), _meta: appOnly },
  { name: "settings.pick_import_file", title: "Выбрать файл для импорта", description: "Choose a YAML profile or a ZIP with both profiles in the native dialog, or specify an absolute path where the native dialog is unavailable. Returns an operation ID; cancellation changes nothing.", inputSchema: { type: "object", required: ["scope"], properties: { scope: { type: "string", enum: ["profile", "project_local", "both"] }, path: { type: "string", minLength: 1 } }, additionalProperties: false }, annotations: annotations(false), _meta: appOnly },
  { name: "settings.import_file", title: "Прочитать выбранный файл", description: "Return the previously selected import file to the settings app only.", inputSchema: { type: "object", properties: { fileId: { type: "string", minLength: 1 } }, required: ["fileId"], additionalProperties: false }, annotations: annotations(), _meta: appOnly },
  { name: "settings.check_java", title: "Проверить Java", description: "Check the specified Java executable and report its path and version without saving it.", inputSchema: { type: "object", properties: { command: { type: "string", minLength: 1 } }, required: ["command"], additionalProperties: false }, annotations: annotations(false), _meta: appOnly },
  { name: "settings.rename_profile", title: "Изменить локальное имя проекта", description: "Change only project.id in the selected project's .ai/project.local.yaml, independently of other panels' scopes. The local ID overrides .ai/project.yaml, which remains unchanged. Creates a minimal local document if absent; validates the merged profile, checks the revision, protects the local file from Git and backs up an existing local file outside the project and Git repositories. An unchanged ID causes no persistent writes. To change the shared ID explicitly, edit Configuration → Общий · Git. Vanessa permissions for the old ID are not transferred.", inputSchema: { type: "object", properties: { projectId: { type: "string", minLength: 1 }, expectedRevision: { type: "string", minLength: 1 } }, required: ["projectId", "expectedRevision"], additionalProperties: false }, annotations: annotations(false), _meta: appOnly },
  { name: "settings.open_directory", title: "Открыть папку проекта", description: "Open the selected project directory in the system file manager.",
    inputSchema: empty, annotations: annotations(false), _meta: appOnly },
  { name: "settings.update", title: "Сохранить настройки", description: "Update changed plugin settings. With an explicit scope, unset removes the listed overrides and restores inheritance; set may be empty only when unset is nonempty.",
    inputSchema: { type: "object", required: ["set"], properties: { set: {
      type: "object", properties: primitive, additionalProperties: false },
      unset: { type: "array", minItems: 1, maxItems: Object.keys(primitive).length - 1, uniqueItems: true, items: { type: "string", enum: Object.keys(primitive).filter(key => key !== "projectRoot") } },
      scope: { type: "string", enum: ["profile", "project_local", "global"] }, expectedRevision: { type: "string", minLength: 1 } }, additionalProperties: false },
    outputSchema: { type: "object", required: ["values"], properties: { values: { type: "object" } } },
    annotations: annotations(false), _meta: shared },
  ...[["settings.import", "Открыть импорт"], ["settings.export", "Открыть экспорт"]].map(([name, title]) => ({
    name, title, description: `${title}. Open the project transfer dialog on explicit user request. This does not import or export by itself.`,
    inputSchema: inspectInput, annotations: annotations(), _meta: appTool,
  })),
  { name: "settings.preview", title: "Проверить файл", description: "Preview one project YAML document without writing.",
    inputSchema: { type: "object", required: ["text", "mode", "baseRevision", "layerScope"], properties: {
      ...editArguments,
      text: { type: "string", maxLength: 2097152 }, projectRoot: { type: "string" } }, additionalProperties: false },
    annotations: annotations(), _meta: shared },
  { name: "settings.apply", title: "Сохранить профиль", description: "Apply a reviewed project YAML document.",
    inputSchema: { type: "object", required: ["text", "revision", "mode", "baseRevision", "layerScope"], properties: {
      ...editArguments,
      text: { type: "string", maxLength: 2097152 }, projectRoot: { type: "string" },
      revision: { type: "string" }, replace: { type: "boolean" } }, additionalProperties: false },
    annotations: annotations(false), _meta: shared },
  { name: "settings.export_diagnostics", title: "Сохранить диагностику", description: "Choose a destination for a bounded, redacted support report. Works without a profile and during a running operation. Does not contact services or upload data.",
    inputSchema: empty, annotations: annotations(false), _meta: appOnly },
  { name: "settings.export_log", title: "Сохранить журнал", description: "Export sanitized local operational events for the selected period. Does not contact services or upload data.",
    inputSchema: { type: "object", properties: { days: { type: "integer", enum: [1, 3, 7] } }, required: ["days"], additionalProperties: false }, annotations: annotations(false), _meta: appOnly },
  { name: "settings.diagnostics", title: "Журнал и диагностика", description: "Read the last 200 sanitized plugin events and local session metadata in the settings app. Works without a profile and during operations. Does not contact or launch services. Log data is app-only metadata.",
    inputSchema: empty, annotations: annotations(), _meta: appOnly },
  { name: "settings.open_diagnostics_directory", title: "Открыть папку диагностики", description: "Open the directory containing the saved support report from the settings app only. Does not generate a report or accept arbitrary paths.",
    inputSchema: empty, annotations: annotations(false), _meta: appOnly },
  { name: "settings.edit", title: "Загрузить настройки для редактирования", description: "Read one project YAML document with its baseRevision for preview/apply.",
    inputSchema: { type: "object", required: ["layerScope", "format"], properties: { layerScope: { type: "string", enum: ["profile", "project_local"] }, format: { type: "string", const: "yaml" } }, additionalProperties: false }, annotations: annotations(), _meta: shared },
  { name: "settings.document", title: "Просмотреть документ профиля", description: "Read a history profile document in the settings app without selecting it for chat operations. Does not write or launch services.",
    inputSchema: { type: "object", required: ["projectRoot"], properties: { projectRoot: { type: "string", minLength: 1 }, layerScope: { type: "string", enum: ["profile", "project_local"] } }, additionalProperties: false }, annotations: annotations(), _meta: appOnly },
  { name: "settings.document_fields", title: "Поля документа", description: "Parse a YAML draft and return its current project schema without writing files.",
    inputSchema: { type: "object", required: ["layerScope", "text"], properties: { layerScope: { type: "string", enum: ["profile", "project_local"] }, text: { type: "string", maxLength: 2097152 } }, additionalProperties: false }, annotations: annotations(), _meta: appOnly },
  { name: "settings.document_patch", title: "Изменить поле черновика", description: "Update one YAML node in a supplied draft without writing files.",
    inputSchema: { type: "object", required: ["text", "operation"], properties: { text: { type: "string", maxLength: 2097152 }, operation: { type: "object", required: ["kind", "path"], properties: { kind: { type: "string", enum: ["set", "remove", "append", "move"] }, path: { type: "array", minItems: 1, maxItems: 64, items: { anyOf: [{ type: "string" }, { type: "integer", minimum: 0 }] } }, value: {}, to: { type: "integer", minimum: 0 } }, additionalProperties: false } }, additionalProperties: false }, annotations: annotations(), _meta: appOnly },
  { name: "settings.transfer_export", title: "Экспорт проектных профилей", description: "Save one YAML project profile or both profiles as a ZIP without uploading them.",
    inputSchema: { type: "object", required: ["projectRoot", "scope"], properties: { projectRoot: { type: "string", minLength: 1 }, scope: { type: "string", enum: ["profile", "project_local", "both"] }, includeCommandsAndComments: { type: "boolean" } }, additionalProperties: false }, annotations: annotations(false), _meta: appOnly },
  { name: "settings.transfer_decode", title: "Прочитать архив профилей", description: "Decode a bounded project archive without writing files.",
    inputSchema: { type: "object", required: ["base64"], properties: { base64: { type: "string", maxLength: 5592408 } }, additionalProperties: false }, annotations: annotations(), _meta: appOnly },
  { name: "settings.transfer_context", title: "Проверить ревизию проекта", description: "Read the project revision before preparing an import.",
    inputSchema: { type: "object", required: ["projectRoot"], properties: { projectRoot: { type: "string", minLength: 1 } }, additionalProperties: false }, annotations: annotations(), _meta: appOnly },
  ...["preview", "apply"].map(kind => ({ name: "settings.transfer_" + kind, title: kind === "preview" ? "Проверить импорт профилей" : "Импортировать профили", description: "Review or apply selected project profile documents.",
    inputSchema: { type: "object", required: ["projectRoot", "baseRevision", "documents", ...(kind === "apply" ? ["revision", "replace"] : [])], properties: { projectRoot: { type: "string", minLength: 1 }, baseRevision: { type: "string", minLength: 1 }, documents: { type: "object", minProperties: 1, properties: { profile: { type: "string", maxLength: 2097152 }, project_local: { type: "string", maxLength: 2097152 } }, additionalProperties: false }, revision: { type: "string", minLength: 1 }, replace: { type: "boolean" } }, additionalProperties: false }, annotations: annotations(kind !== "apply"), _meta: appOnly })),
  { name: "settings.operation", title: "Состояние операции", description: "Read a running or completed settings operation without retrying it. Results belong to this MCP session and include their original project/instance.",
    inputSchema: { type: "object", properties: { operationId: { type: "string" }, waitMs: { type: "integer", minimum: 0, maximum: 10000, description: "Wait for this operation to finish, up to 10 seconds. Prefer a bounded wait over repeated immediate polls." } }, additionalProperties: false },
    annotations: annotations(), _meta: shared },
  { name: "settings.check", title: "Проверка готовности", description: "Read the compact profile inspection and saved readiness, like settings.inspect, without opening a form or launching services. Use settings.probe_connections for live external checks, core_runtime_status for the required chat relay, or settings.run_check for authorized preparation.",
    inputSchema: inspectInput, annotations: annotations(), _meta: shared },
];
const ovIdentity = { url: { type: "string", minLength: 1, maxLength: 2048 }, connectionId: primitive.openvikingConnectionId };
const ovValues = { type: "object", additionalProperties: false,
  properties: Object.fromEntries(["credential", "bindingKey", "accessPublicKey", "accessReceipts", "publicationPublicKey", "publicationReceipts"].map(name => [name, { type: "string", maxLength: 262144 }])),
  required: ["credential", "bindingKey", "accessPublicKey", "accessReceipts", "publicationPublicKey", "publicationReceipts"] };
tools.push({ name: "settings.openviking_read", title: "Открыть общую запись OpenViking", description: "Read connection values for the settings app only.",
  inputSchema: { type: "object", properties: ovIdentity, required: ["url", "connectionId"], additionalProperties: false }, annotations: annotations(), _meta: appOnly });
tools.push({ name: "settings.openviking_save", title: "Сохранить общую запись OpenViking", description: "Save this user's shared connection record with an optimistic revision check.",
  inputSchema: { type: "object", properties: { ...ovIdentity, values: ovValues, expectedRevision: { type: "string", minLength: 1 } },
    required: ["url", "connectionId", "values", "expectedRevision"], additionalProperties: false }, annotations: annotations(false), _meta: appOnly });

function backend(action, args, context = { projectRoot: selectedRoot, selectedDirectory: selectedRoot, rootLocked, instance: process.env.EDT_AI_INSTANCE || "default" }, readDeadline = 0, onProgress = null) {
  register_diagnostic_secrets(args);
  return new Promise((resolve, reject) => {
    if (sessionClosing) return reject(new Error("Сеанс настроек завершён; новая операция не запущена."));
    if (backendCleanupFailure) return reject(Object.assign(new Error("Завершение предыдущего процесса настроек не подтверждено; новая операция заблокирована."), { outcomeUnknown: true }));
    const observerToken = ["refresh_readiness", "probe"].includes(action) ? randomUUID() : null, revision = selectionRevision, requests = new Map();
    const protectedRead = Boolean(readDeadline && action === "read"), owner = randomUUID();
    // These operations may deliberately create a daemon that outlives this
    // backend. A strict reader job cannot safely perform that handoff.
    const createsDaemon = ["check", "updates", "restart_index", "rebuild_index"].includes(action);
    const supervised = protectedRead || process.platform !== "darwin" && !createsDaemon;
    const forwardIpc = Boolean(onProgress || observerToken);
    const options = {
        cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe", ...(!supervised && forwardIpc ? ["ipc"] : [])],
        env: { ...process.env, EDT_AI_STATE_DIR: state, EDT_AI_SETTINGS: configPath,
          EDT_AI_PROJECT_ROOT: context.selectedDirectory || "", EDT_AI_SETTINGS_ROOT_LOCKED: context.rootLocked === false ? "0" : "1" },
      };
    for (const name of Object.keys(options.env)) if (["EDT_AI_SETTINGS_PARENT_PID", "EDT_AI_OPERATION_ID"].includes(name.toUpperCase())) delete options.env[name];
    if (context.operationId) options.env.EDT_AI_OPERATION_ID = context.operationId;
    if (process.platform === "linux" && process.arch === "x64" && createsDaemon) {
      // The backend can hand the project daemon to its own guard. Tie only
      // this backend to the MCP process, including an uncatchable owner exit.
      for (const name of Object.keys(options.env)) if (name.toUpperCase() === "NODE_OPTIONS") delete options.env[name];
      options.env.EDT_AI_SETTINGS_PARENT_PID = String(process.pid);
    }
    const command = [path.join(root, "scripts", "settings_backend.mjs")];
    const child = supervised ? launch(process.execPath, command, { ...options, readerJob: owner, forwardIpc }) : spawn(process.execPath, command, options);
    const backgroundRead = ["read", "refresh_readiness"].includes(action);
    if (!backgroundRead) diagnostic.event("backend_process_started", { owner, operationId: context.operationId, projectRoot: context.projectRoot, action, supervisorPid: child.pid });
    let cleanupPromise;
    const cleanup = reason => cleanupPromise ||= stop_child(child, 0).then(() => {
      if (!backgroundRead) diagnostic.event(supervised ? "backend_process_stopped" : "backend_child_stopped", { owner, operationId: context.operationId, projectRoot: context.projectRoot, action, supervisorPid: child.pid, reason });
    }, error => {
      diagnostic.event("backend_process_cleanup_failed", { owner, operationId: context.operationId, projectRoot: context.projectRoot, action, supervisorPid: child.pid, phase: "cleanup", error }, "error");
      throw error;
    }).finally(() => backendCleanups.delete(child));
    backendCleanups.set(child, cleanup);
    let output = "", outputBytes = 0, errors = "", expired = false, failed = false, finishing = false, observerUsed = false;
    const retireObserver = reason => { observerUsed = true; return dropIndexObserver(reason); };
    const cleanupAll = async reason => {
      // A previous cancel may already have started closing the observer even
      // after its request left the map. Preserve and await that same cleanup.
      const retiring = requests.size && observerUsed ? retireObserver(reason) : observerUsed ? waitIndexObserverCleanup(reason) : Promise.resolve();
      let waitTimer;
      try {
        const results = await Promise.race([
          Promise.allSettled([cleanup(reason), retiring]),
          new Promise((_, fail) => { waitTimer = setTimeout(() => fail(Object.assign(new Error("Завершение ресурсов проверки не подтверждено."), { outcomeUnknown: true })), 12000); }),
        ]);
        const failure = results.find(result => result.status === "rejected");
        if (failure || observerUsed && indexObserverFailure)
          throw Object.assign(new Error("Завершение ресурсов проверки не подтверждено."), { outcomeUnknown: true, cause: failure?.reason || indexObserverFailure });
      } catch (error) {
        backendCleanupFailure ||= error;
        diagnostic.event("backend_cleanup_unconfirmed", { owner, operationId: context.operationId, projectRoot: context.projectRoot, action, reason, phase: "cleanup", error }, "error");
        throw error;
      } finally { clearTimeout(waitTimer); }
    };
    // Observation must eventually release its backend even if a filesystem or
    // a native dependency stops responding. Mutations have separate lifetime
    // semantics and must not be interrupted by an observation deadline.
    const timeout = readDeadline && action === "read" ? readDeadline : ["probe", "refresh_readiness"].includes(action) ? 120000 : 0;
    const timer = timeout ? setTimeout(() => {
      expired = true;
      void cleanupAll("timeout").then(() => reject(Object.assign(new Error(action === "read" ? "Истекло время чтения состояния для диагностики" : "Истекло время проверки состояния компонентов."),
        { code: action === "read" ? "READ_TIMEOUT" : "ETIMEDOUT", ...(!supervised ? { outcomeUnknown: true } : {}) })), reject);
    }, timeout) : null;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      if (failed || expired) return;
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes <= 32 * 1024 * 1024) { output += chunk; return; }
      failed = true; clearTimeout(timer); output = "";
      const error = Object.assign(new Error("Ответ сервиса настроек превышает допустимый размер."), { code: "BACKEND_OUTPUT_LIMIT", outcomeUnknown: action !== "read" });
      void cleanupAll("output_limit").then(() => reject(error), reject);
    });
    if (onProgress || observerToken) child.on("message", envelope => {
      if (sessionClosing || expired || failed || finishing) return;
      const message = supervised ? envelope?.relay : envelope;
      if (message?.type === "progress") { onProgress?.(message.progress); return; }
      if (!observerToken || message?.token !== observerToken || typeof message.id !== "string" || !/^[0-9a-f-]{36}$/.test(message.id)) return;
      if (message.type === "index_observation_cancel") {
        if (requests.has(message.id) && observerUsed) void retireObserver("backend_timeout").catch(() => {});
        return;
      }
      if (message.type !== "index_observation" || requests.size || !message.config || !message.profile || !message.snapshot) return;
      requests.set(message.id, null);
      const request = (async () => {
        let observer;
        try {
          if (sessionClosing || revision !== selectionRevision || !context.selectedDirectory || !selectedRoot || context.instance !== (process.env.EDT_AI_INSTANCE || "default") ||
              path_identity(locate_project(context.selectedDirectory)) !== path_identity(message.root) ||
              path_identity(message.config.active_project) !== path_identity(message.root))
            throw Object.assign(new Error("Профиль изменился во время наблюдения индекса."), { inputsChanged: true });
          observerUsed = true;
          observer = await indexObserver();
          if (sessionClosing || expired || failed) throw Object.assign(new Error("Сеанс наблюдения закрывается."), { outcomeUnknown: true });
          const result = await observer.observe(message.config, message.root, message.profile, message.snapshot);
          if (expired || failed) return;
          if (revision !== selectionRevision) throw Object.assign(new Error("Профиль изменился во время наблюдения индекса."), { inputsChanged: true });
          if (child.connected) child.send(supervised ? { relay: { type: "index_observation_result", token: observerToken, id: message.id, ok: true, result } } : { type: "index_observation_result", token: observerToken, id: message.id, ok: true, result }, () => {});
        } catch (error) {
          if (expired || failed) return;
          if (error?.cleanupUnconfirmed || observer?.cleanupError) {
            error = Object.assign(error instanceof Error ? error : new Error("Index reader cleanup failed"), { outcomeUnknown: true, cleanupUnconfirmed: true });
            try { await retireObserver("observation_cleanup_failed"); } catch { /* The failure remains a session barrier. */ }
          } else if (!(error instanceof Error)) error = new Error("Index observation failed");
          if (expired || failed) return;
          const failure = { type: "index_observation_result", token: observerToken, id: message.id, ok: false,
            error: safe_error_message(error), ...(typeof error.code === "string" ? { code: error.code } : {}),
            ...(error.inputsChanged ? { inputsChanged: true } : {}), ...(error.outcomeUnknown ? { outcomeUnknown: true } : {}),
            ...(error.cleanupUnconfirmed ? { cleanupUnconfirmed: true } : {}), ...(error.remote ? { remote: true } : {}) };
          if (child.connected) child.send(supervised ? { relay: failure } : failure, () => {});
        } finally { requests.delete(message.id); }
      })();
      if (requests.has(message.id)) requests.set(message.id, request);
    });
    child.stderr.on("data", () => { errors = "Содержимое stderr сервиса скрыто."; });
    child.once("error", error => {
      if (expired || failed) return;
      failed = true; clearTimeout(timer);
      void cleanupAll("error").then(() => {
        if (action !== "read" && child.pid) error.outcomeUnknown = true;
        reject(error);
      }, reject);
    });
    child.stdin.on("error", () => {}); // close/output below owns the operation outcome
    child.once("close", async code => {
      clearTimeout(timer);
      if (expired || failed) return;
      finishing = true;
      try { await cleanupAll("completed"); }
      catch (error) { reject(error); return; }
      let data;
      try {
        data = JSON.parse(output);
      } catch {
        const error = new Error(`Сервис настроек завершился без результата (код ${code}). Исход операции неизвестен; проверьте сохранённые настройки и состояние сервисов перед повтором. ${errors}`);
        error.outcomeUnknown = true;
        reject(error); return;
      }
      if (!data || typeof data !== "object" || Array.isArray(data) || typeof data.ok !== "boolean" ||
          (data.ok && (!data.result || typeof data.result !== "object" || Array.isArray(data.result)))) {
        const error = new Error("Сервис настроек вернул некорректный ответ. Исход операции неизвестен; проверьте сохранённые настройки и состояние сервисов перед повтором.");
        error.outcomeUnknown = true; reject(error); return;
      }
      if (data.ok !== true) { const error = new Error(safe_error_message({ message: data.error || "Сервис настроек сообщил об ошибке.", code: data.errorCode, documentLine: data.documentLine })); error.code = data.errorCode; error.documentLine = data.documentLine; error.outcomeUnknown = data.outcomeUnknown === true; error.diagnosticFailure = data.diagnosticFailure; reject(error); return; }
      if (code !== 0) {
        const error = new Error("Сервис настроек вернул результат, но завершился с ошибкой. Проверьте сохранённые настройки и состояние сервисов перед повтором.");
        error.outcomeUnknown = true; reject(error); return;
      }
      register_diagnostic_secrets(data.result);
      resolve(data.result);
    });
    child.stdin.end(JSON.stringify({ action, ...args, ...(observerToken ? { _indexObserverToken: observerToken } : {}) }));
  });
}
const operations = new SettingsOperations(async (action, args, context, progress) => {
  if (action === "pick_import_file") {
    if (args.path !== undefined && !path.isAbsolute(args.path)) throw new Error("Укажите абсолютный путь к файлу.");
    const file = args.path ?? await folder_action("file", context.selectedDirectory || "", { title: "Выберите файл настроек · 1C AI Core" });
    if (context.selectionRevision !== selectionRevision) throw new Error("Профиль изменился во время выбора файла.");
    if (!file) return { cancelled: true };
    const archive = args.scope === "both", limit = archive ? 4 * 1024 * 1024 : 2 * 1024 * 1024;
    if (archive ? !/\.zip$/i.test(file) : !/\.ya?ml$/i.test(file)) throw new Error(archive ? "Выберите ZIP-архив." : "Выберите YAML-файл.");
    await assertUserFileBoundary(file, context.projectRoot);
    if (context.selectionRevision !== selectionRevision) throw new Error("Профиль изменился во время выбора файла.");
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error("Файл недоступен, является ссылкой или превышает допустимый размер.");
    const bytes = fs.readFileSync(file);
    if (bytes.length > limit) throw new Error("Файл превышает допустимый размер.");
    const text = archive ? undefined : bytes.toString("utf8");
    if (!archive && !Buffer.from(text, "utf8").equals(bytes)) throw new Error("Файл должен быть в кодировке UTF-8.");
    if (context.selectionRevision !== selectionRevision) throw new Error("Профиль изменился во время выбора файла.");
    const fileId = randomUUID();
    pickedImports.set(fileId, { ...(archive ? { base64: bytes.toString("base64") } : { text }), scope: args.scope, filename: path.basename(file), projectRoot: context.projectRoot, selectionRevision });
    while (pickedImports.size > 4) pickedImports.delete(pickedImports.keys().next().value);
    return { fileId, filename: path.basename(file) };
  }
  if (action === "pick_java") {
    const directory = await folder_action("pick", "", { title: "Выберите каталог Java · 1C AI Core" });
    if (context.selectionRevision !== selectionRevision) throw new Error("Профиль изменился во время выбора Java.");
    return directory ? backend("java_probe", { directory }, context) : { cancelled: true };
  }
  if (action === "check_java") return backend("java_probe", args, context);
  if (action === "pick_view_directory") {
    const directory = await folder_action("pick", context.selectedDirectory || "");
    if (context.selectionRevision !== selectionRevision) throw new Error("Папка чата изменилась во время выбора. Откройте настройки заново.");
    return directory ? { directory } : { cancelled: true };
  }
  if (action !== "pick_directory") return backend(action, args, context, 0, ["rebuild_index", "restart_index"].includes(action) ? progress : null);
  const directory = await folder_action("pick", args.projectRoot || context.selectedDirectory || "");
  if (context.selectionRevision !== selectionRevision) throw new Error("Папка чата изменилась во время выбора. Откройте настройки заново.");
  if (!directory) return { cancelled: true };
    const data = await backend("read", { remember: true }, { selectedDirectory: directory, rootLocked: false });
    while (transferInFlight) await transferInFlight;
  if (context.selectionRevision !== selectionRevision) throw new Error("Папка чата изменилась во время выбора. Откройте настройки заново.");
  if (selectedRoot !== data.values.projectRoot) await dropIndexObserver("project_changed");
  selectedRoot = data.values.projectRoot;
  selectionRevision += 1;
  return data;
}, (name, detail, level) => diagnostic.event(name, detail, level), { stateDirectory: state });
async function assertUserFileBoundary(selected, projectRoot, write = false, allowStateExport = false) {
  const { resolve, contained, configuration_root, ProfileAmbiguous } = await import("../scripts/project_paths.mjs");
  const destination = resolve(selected);
  if (write) {
    const settingsFiles = [configPath, process.env.EDT_AI_CONNECTIONS_FILE].filter(Boolean).map(resolve);
    if ((!allowStateExport && contained(resolve(state), destination)) ||
        settingsFiles.some(file => contained(file, destination) && contained(destination, file)))
      throw new Error("Нельзя заменять служебное состояние плагина экспортом.");
  }
  if (projectRoot) {
    const { project_profile } = await import("../scripts/profile.mjs");
    const { inside } = await import("../scripts/common.mjs");
    let root;
    try { root = configuration_root(projectRoot); }
    catch (error) {
      // Multiple candidate profiles are all below the selected directory.
      // Protect that whole directory while still allowing an external report.
      if (!(error instanceof ProfileAmbiguous)) throw error;
      root = resolve(projectRoot);
    }
    let protectedPaths;
    try { const profile = project_profile(root); protectedPaths = [...profile.roots.source, ...profile.roots.protected].map(relative => inside(root, relative)); }
    catch { protectedPaths = [root]; }
    if (protectedPaths.some(protectedPath => contained(protectedPath, destination))) throw new Error("Нельзя выбирать файлы в защищённых исходниках проекта.");
    if (write && [inside(root, ".ai/project.yaml"), inside(root, ".ai/project.local.yaml")].some(file => contained(file, destination) && contained(destination, file)))
      throw new Error("Нельзя заменять файлы настроек проекта экспортом.");
  }
}
async function exportDestination(data, context, title) {
  context.onStage?.("prepare_destination");
  const { save_export_to_path, state_export_path, save_state_export } = await import("../scripts/settings_export.mjs");
  const fallback = !folder_actions_supported();
  context.onStage?.("choose_destination");
  const selected = fallback ? state_export_path(state, context.kind) : await folder_action("save", "", { title, filename: data.filename, extension: path.extname(data.filename).slice(1) || "json" });
  if (!selected) return { cancelled: true };
  context.onDestination?.(selected);
  context.onStage?.("validate_destination");
  if (context.revision !== selectionRevision) throw new Error("Профиль изменился во время выбора файла. Повторите экспорт.");
  await assertUserFileBoundary(selected, context.projectRoot, true, fallback);
  if (context.revision !== selectionRevision) throw new Error("Профиль изменился во время выбора файла. Повторите экспорт.");
  context.onStage?.("write_file");
  const saved = fallback ? save_state_export(state, context.kind, data, selected, context.limit) : save_export_to_path(selected, data, context.limit);
  return { ...saved, canOpenDirectory: !fallback };
}
function operationSummary() {
  const { result, ...summary } = operations.status();
  return summary;
}
function publicResult(value) {
  if (Array.isArray(value)) return value.map(publicResult);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !["inputRevision", "currentInputRevision"].includes(key)).map(([key, item]) => [key, publicResult(item)]));
  return value;
}
function result(data, text) {
  return { content: [{ type: "text", text: text ?? JSON.stringify(data) }], structuredContent: data };
}
async function call(name, args, meta = {}, requestContext = {}) {
  // An import is committed for the reviewed project as one operation.
  // Queue root changes and other calls until its actual result is known.
  while (transferInFlight) await transferInFlight;
  if (pendingRoots) await new Promise(resolve => {
    const timer = setTimeout(resolve, 3000);
    rootReady.then(() => { clearTimeout(timer); resolve(); });
  });
  while (transferInFlight) await transferInFlight;
  const definition = tools.find(item => item.name === name);
  if (!definition) throw new Error("Неизвестный инструмент");
  validateArguments(definition.inputSchema, args);
  // A job owns its original context. The picker can finish before the app
  // learns its new directory; stale view metadata must not rebind this read.
  if (name === "settings.operation") {
    await operations.wait(args.operationId, args.waitMs || 0);
    const operation = operations.status(args.operationId);
    const view = { ...operation, mode: "operation", navigation: "project" };
    return result(["probe", "check", "refresh_readiness"].includes(operation.action) ? publicResult(view) : view, `${operation.status}${operation.id ? " · " + operation.id : ""}${operation.error ? ": " + operation.error : ""}`);
  }
  // App calls may use a fresh MCP connection with empty roots. Carry the
  // invoking chat's explicit scope, never a global last-used profile.
  const requestedRoot = meta?.["1c-ai-core/projectRoot"] ??
    (["settings.profile", "settings.import", "settings.export", "settings.check"].includes(name) ? args.projectRoot : undefined);
  if (requestedRoot !== undefined) {
    if (operations.status().status === "running" && !selectedRoot) throw new Error("Дождитесь завершения текущей операции перед привязкой проекта.");
    const selection = explicit_selection({ directory: selectedRoot }, requestedRoot, selectionError);
    if (selection.directory !== selectedRoot) { await dropIndexObserver("project_changed"); selectedRoot = selection.directory; selectionRevision += 1; }
    rootLocked ||= ["settings.profile", "settings.import", "settings.export", "settings.check"].includes(name) || meta?.["1c-ai-core/navigation"] !== "profiles";
  }
  if (name === "settings.openviking_read" || name === "settings.openviking_save") {
    const { read_openviking_record, save_openviking_record } = await import("../scripts/openviking_store.mjs");
    const data = name === "settings.openviking_read" ? read_openviking_record(args.url, args.connectionId, state)
      : await save_openviking_record(args.url, args.connectionId, args.values, args.expectedRevision, state);
    return { content: [{ type: "text", text: name === "settings.openviking_read" ? "Запись открыта." : "Общая запись сохранена." }], _meta: { data } };
  }
  if (name === "settings.document") {
    const revision = selectionRevision;
    const document = await backend("edit", { layerScope: args.layerScope || "profile", format: "yaml" }, { selectedDirectory: args.projectRoot, rootLocked: false });
    if (revision !== selectionRevision) throw new Error("Папка чата изменилась. Откройте документ заново.");
    return { content: [{ type: "text", text: "Документ профиля прочитан." }], _meta: { data: document } };
  }
  if (name === "settings.document_fields" || name === "settings.document_patch") {
    const data = await backend(name === "settings.document_fields" ? "document_fields" : "document_patch", args);
    return { content: [{ type: "text", text: "Черновик обработан." }], _meta: { data } };
  }
  if (name === "settings.forget_profile") {
    const { forget_profile, profile_history, profile_hidden } = await import("../scripts/profile_history.mjs");
    forget_profile(state, args.projectRoot, [selectedRoot, viewedRoot]);
    return result({ profileHistory: profile_history(state, selectedRoot), profileHistoryHidden: profile_hidden(state, args.projectRoot) });
  }
  if (name === "settings.diagnostics") {
    const { events, ...journal } = diagnostic_journal(state);
    const data = { ...sanitize_diagnostics({ ...journal, observedAt: new Date().toISOString(),
      runtime: { plugin: core_version, node: process.version, platform: process.platform, architecture: process.arch },
      session: { projectRoot: selectedRoot, instance: process.env.EDT_AI_INSTANCE || "default", locked: rootLocked,
        selectionError, pendingRoots: Boolean(pendingRoots), operation: operationSummary(), logger: diagnostic.status() },
      paths: { state, settings: configPath } }), events };
    return { content: [{ type: "text", text: "Журнал плагина прочитан." }], _meta: { data } };
  }
  if (name === "settings.export_diagnostics") {
    const requestId = requestContext.id;
    const stageLabels = { collect: "Сбор диагностических данных", validate_selection: "Проверка выбранного проекта",
      prepare_destination: "Подготовка сохранения", choose_destination: "Выбор файла", validate_destination: "Проверка пути", write_file: "Запись и проверка файла" };
    const exportProgress = requestContext.exportProgress = { stage: "collect", stageLabel: stageLabels.collect };
    const setStage = stage => { exportProgress.stage = stage; exportProgress.stageLabel = stageLabels[stage]; };
    const exportContext = { revision: selectionRevision, projectRoot: selectedRoot, kind: "diagnostics", limit: 16 * 1024 * 1024,
      onStage: setStage, onDestination: value => { exportProgress.destination = value; } };
    requestContext.exportRoot = exportContext.projectRoot;
    const started = Date.now();
    diagnostic.event("support_export_requested", { projectRoot: exportContext.projectRoot, requestId });
    try {
      const { support_bundle } = await import("../scripts/support_bundle.mjs");
      const context = { selectedDirectory: selectedRoot, rootLocked };
      const operationsObservedAt = new Date().toISOString();
      const data = await support_bundle({ state, configPath, selectedRoot,
        selection: { rootLocked, selectionError, pendingRoots }, operation: operations.status(), operations: operations.retained(), operationsObservedAt, loggerStatus: diagnostic.status(), currentSession: diagnostic.session,
        readCurrent: () => backend("read", {}, context, 8000),
        onIssue: (section, error) => diagnostic.event("support_export_section_failed", { projectRoot: exportContext.projectRoot, requestId, stage: "collect", stageLabel: stageLabels.collect, section, error }, "error") });
      setStage("validate_selection");
      if (exportContext.revision !== selectionRevision) throw new Error("Профиль изменился во время подготовки диагностики. Повторите операцию.");
      const saved = await exportDestination(data, exportContext, "Сохранить диагностику · 1C AI Core");
      if (saved.cancelled) {
        diagnostic.event("support_export_cancelled", { projectRoot: exportContext.projectRoot, requestId, ...exportProgress });
        return { content: [{ type: "text", text: "Сохранение отменено." }], _meta: { data: saved } };
      }
      latestDiagnosticsExport = saved;
      diagnostic.event("support_export_saved", { projectRoot: exportContext.projectRoot, requestId, path: saved.path, bytes: saved.bytes, durationMs: Date.now() - started });
      // Only the settings app receives the saved path. File bytes do not cross
      // the app bridge, and a success response requires a completed disk write.
      return { content: [{ type: "text", text: "Диагностический файл сохранён." }], _meta: { data: { ...saved, canOpenDirectory: folder_actions_supported() } } };
    } catch (error) {
      diagnostic.event("support_export_failed", { projectRoot: exportContext.projectRoot, requestId, ...exportProgress, durationMs: Date.now() - started, error }, "error");
      throw error;
    }
  }
  if (name === "settings.export_log") {
    const exportContext = { revision: selectionRevision, projectRoot: selectedRoot, kind: "logs", limit: 16 * 1024 * 1024 };
    const { detailed_log_export } = await import("../scripts/support_bundle.mjs");
    const data = detailed_log_export(state, args.days);
    const saved = await exportDestination(data, exportContext, "Сохранить журнал · 1C AI Core");
    if (saved.cancelled) return { content: [{ type: "text", text: "Сохранение отменено." }], _meta: { data: saved } };
    latestDiagnosticsExport = saved;
    return { content: [{ type: "text", text: "Журнал сохранён." }], _meta: { data: { ...saved, canOpenDirectory: folder_actions_supported() } } };
  }
  if (name === "settings.open_diagnostics_directory") {
    const { saved_support_report } = await import("../scripts/support_bundle.mjs");
    const saved = latestDiagnosticsExport || saved_support_report(state);
    if (!saved) throw new Error("Сначала сохраните диагностический файл.");
    await folder_action("open", saved.directory, { select: saved.path });
    return { content: [{ type: "text", text: "Папка диагностики открыта." }] };
  }
  const readOnlyEntry = ["settings.inspect", "settings.read", "settings.status", "settings.open", "settings.profile", "settings.import", "settings.export", "settings.check", "settings.versions"].includes(name);
  if (name === "settings.versions") {
    let cached = versionCatalogs.get(args.component);
    if (args.refresh || !cached || cached.expires < Date.now()) {
      const promise = import("../scripts/runtime.mjs").then(async runtime => {
        const [catalog, latest, latestPrerelease] = await Promise.allSettled([
          runtime.list_versions(args.component, undefined, { refresh: args.refresh }),
          runtime.latest_version(args.component, undefined, { refresh: args.refresh }),
          runtime.latest_version(args.component, undefined, { refresh: args.refresh, allowPrerelease: true }),
        ]);
        if (catalog.status === "rejected") throw catalog.reason;
        const data = { ...catalog.value, latest: latest.status === "fulfilled" ? latest.value : null,
          ...(latest.status === "rejected" ? { latestError: latest.reason.message } : {}),
          latestPrerelease: latestPrerelease.status === "fulfilled" ? latestPrerelease.value : null,
          ...(latestPrerelease.status === "rejected" ? { latestPrereleaseError: latestPrerelease.reason.message } : {}) };
        diagnostic.event("version_catalog_loaded", { component: args.component, versions: data.versions.length, latest: data.latest });return data;
      });
      cached = { promise, expires: Date.now() + 5 * 60 * 1000 };versionCatalogs.set(args.component, cached);
      promise.catch(() => { if (versionCatalogs.get(args.component) === cached) versionCatalogs.delete(args.component); });
    }
    return result(await cached.promise);
  }
  if (name === "settings.status" || name === "settings.select_profile") {
    if (name === "settings.select_profile" && operations.status().status === "running" && operations.status().action !== "refresh_readiness") throw new Error("Дождитесь завершения текущей операции.");
    const revision = selectionRevision, directory = args.projectRoot || selectedRoot;
    const actual = await backend(name === "settings.status" ? "status" : "read", { remember: name === "settings.select_profile" },
      { selectedDirectory: directory, rootLocked: false });
    if (revision !== selectionRevision) throw new Error("Папка чата изменилась. Выберите профиль заново.");
    const current = rootLocked ? await readValues() : null;
    while (transferInFlight) await transferInFlight;
    if (revision !== selectionRevision) throw new Error("Папка чата изменилась. Выберите профиль заново.");
    const viewOnly = Boolean(selectionError || (rootLocked && actual.values.projectRoot !== current.values.projectRoot));
    if (name === "settings.select_profile") {
      viewedRoot = actual.values.projectRoot;
      if (!viewOnly) { if (selectedRoot !== actual.values.projectRoot) await dropIndexObserver("project_changed"); selectedRoot = actual.values.projectRoot; selectionRevision += 1; }
    }
    const view = readSettings(actual);
    view.viewOnly = viewOnly;
    view.chatProjectRoot = current?.values.projectRoot || null;
    if (rootLocked || selectionError) view.schema.properties.projectRoot.readOnly = true;
    for (const [id, source] of Object.entries(view.connectionSources || {}))
      if (source.startsWith("environment:") || source === "connections_file") view.schema.properties[id + "Url"].readOnly = true;
    return result(view);
  }
  if (name === "settings.inspect" || name === "settings.check") {
    if (operations.status().status === "running" && args.projectRoot !== undefined && !selectedRoot)
      throw new Error("Дождитесь завершения текущей операции перед выбором папки.");
    const selection = explicit_selection({ directory: selectedRoot }, args.projectRoot, selectionError);
    if (selection.directory !== selectedRoot) { await dropIndexObserver("project_changed"); selectedRoot = selection.directory; selectionRevision += 1; }
    if (args.projectRoot !== undefined) rootLocked = true;
    const read = await readValues();
    const { setup_inspection } = await import("../scripts/setup_inspection.mjs");
    const snapshot = setup_inspection({ ...read, projectSelection: { status: selectionError ? (pendingRoots ? "pending" : "ambiguous") : selectedRoot ? "selected" : "unselected", locked: rootLocked, detail: selectionError }, operation: operationSummary() }, state);
    return result({ ...snapshot, readiness: publicResult(snapshot.readiness), componentChecks: publicResult(snapshot.componentChecks) }, `Профиль: ${snapshot.profile.status}. Следующие шаги: ${snapshot.nextSteps.join(", ") || "нет"}.`);
  }
  if (selectionError && !readOnlyEntry) throw new Error(selectionError);
  const duringRefresh = ["settings.edit", "settings.preview", "settings.import_file", "settings.update", "settings.reset_connection", "settings.rename_profile", "settings.create", "settings.load", "settings.apply", "settings.open_directory", "settings.run_check", "settings.probe_connections", "settings.rebuild_index", "settings.restart_index", "settings.updates"].includes(name);
  const parallelObservation = name === "settings.refresh_readiness" && ["check", "rebuild_index", "restart_index", "updates"].includes(operations.status().action);
  if (operations.status().status === "running" && !readOnlyEntry && !(operations.status().action === "refresh_readiness" && duringRefresh) && !parallelObservation) throw new Error(
    operations.status().action === "pick_directory"
      ? "Завершите или отмените выбор папки в системном окне."
      : "Операция ещё выполняется. Дождитесь её завершения.");
  if (name === "settings.transfer_decode") {
    const data = await backend("transfer_decode", args);
    return { content: [{ type: "text", text: "Архив прочитан." }], _meta: { data } };
  }
  if (name === "settings.transfer_export") {
    if (!selectedRoot) throw new Error("Выберите проект текущего чата.");
    const context = { revision: selectionRevision, projectRoot: selectedRoot, kind: "project_" + args.scope, limit: 4 * 1024 * 1024 };
    const data = await backend("transfer_export", args);
    if (context.revision !== selectionRevision) throw new Error("Проект изменился. Повторите экспорт.");
    const saved = await exportDestination(data, context, "Сохранить профиль · 1C AI Core");
    return { content: [{ type: "text", text: saved.cancelled ? "Сохранение отменено." : "Файл сохранён." }], _meta: { data: saved } };
  }
  if (["settings.transfer_context", "settings.transfer_preview", "settings.transfer_apply"].includes(name)) {
    if (!selectedRoot) throw new Error("Выберите проект текущего чата.");
    const revision = selectionRevision;
    let finish;
    if (name.endsWith("_apply")) transferInFlight = new Promise(resolve => { finish = resolve; });
    try {
      const data = await backend(name.slice("settings.".length), args);
      if (revision !== selectionRevision) throw new Error("Проект изменился. Проверьте перенос заново.");
      return { content: [{ type: "text", text: name.endsWith("_context") ? "Ревизия прочитана." : name.endsWith("_preview") ? "Изменения проверены." : "Настройки сохранены." }], _meta: { data } };
    } finally {
      if (finish) {
        transferInFlight = null;
        if (deferredRoots) { deferredRoots = false; requestRoots(); }
        finish();
      }
    }
  }
  if (name === "settings.probe_connections") {
    if (!selectedRoot) throw new Error("Проект чата не определён. Сообщите агенту путь к папке проекта в текущем чате.");
    return result(operations.status(operations.start("probe", args, { projectRoot: selectedRoot, selectedDirectory: selectedRoot, rootLocked, instance: process.env.EDT_AI_INSTANCE || "default" }).id));
  }
  if (name === "settings.pick_directory") {
    if (rootLocked) throw new Error("Каталог закреплён текущим чатом. Смените папку проекта в Codex.");
    const job = operations.start("pick_directory", args, { projectRoot: selectedRoot,
      selectedDirectory: selectedRoot, rootLocked, selectionRevision, instance: process.env.EDT_AI_INSTANCE || "default" });
    return result(operations.status(job.id));
  }
  if (name === "settings.pick_view_directory") {
    if (!rootLocked || !selectedRoot || selectionError) throw new Error("Сначала определите каталог текущего чата.");
    return result(operations.status(operations.start("pick_view_directory", args, { projectRoot: selectedRoot,
      selectedDirectory: selectedRoot, rootLocked, selectionRevision, instance: process.env.EDT_AI_INSTANCE || "default" }).id));
  }
  if (name === "settings.pick_java" || name === "settings.check_java") {
    if (!selectedRoot) throw new Error("Выберите папку проекта.");
    const job = operations.start(name === "settings.pick_java" ? "pick_java" : "check_java", args,
      { projectRoot: selectedRoot, selectedDirectory: selectedRoot, rootLocked, selectionRevision, instance: process.env.EDT_AI_INSTANCE || "default" });
    return result(operations.status(job.id));
  }
  if (name === "settings.pick_import_file") {
    if (!selectedRoot) throw new Error("Выберите папку проекта.");
    const job = operations.start("pick_import_file", args, { projectRoot: selectedRoot, selectedDirectory: selectedRoot, rootLocked, selectionRevision, instance: process.env.EDT_AI_INSTANCE || "default" });
    return result(operations.status(job.id));
  }
  if (name === "settings.import_file") {
    const file = pickedImports.get(args.fileId);
    if (!file || file.selectionRevision !== selectionRevision || file.projectRoot !== selectedRoot) throw new Error("Выбранный файл устарел. Выберите его заново.");
    pickedImports.delete(args.fileId);
    return { content: [{ type: "text", text: "Файл прочитан." }], _meta: { data: { filename: file.filename, scope: file.scope, ...(file.base64 ? { base64: file.base64 } : { text: file.text }) } } };
  }
  if (name === "settings.open_directory") {
    const current = await readValues();
    if (!current.values.projectRoot) throw new Error("Выберите папку проекта.");
    await folder_action("open", current.values.projectRoot);
    return result({ opened: true });
  }
  if (name === "settings.read") {
    const view = readSettings(await readValues());
    for (const [name, source] of Object.entries(view.connectionSources || {})) {
      if (source.startsWith("environment:") || source === "connections_file") {
        view.schema.properties[name + "Url"] = {
          ...primitive[name + "Url"], readOnly: true,
          description: "Значение задаёт " + source + ". Сначала измените этот источник с более высоким приоритетом.",
        };
      }
    }
    if (rootLocked || selectionError) view.schema.properties.projectRoot = { ...primitive.projectRoot,
      readOnly: true, description: "Каталог текущей сессии. Чтобы выбрать другой профиль, смените каталог проекта в Codex." };
    return result(view);
  }
  if (name === "settings.profile" || name === "settings.open") {
    const view = readSettings(await readValues(true));
    const mode = "profile", navigation = name === "settings.profile" ? "project" : "profiles";
    return result({ ...view, mode, navigation }, JSON.stringify({ mode, navigation, profile: view.profile, directoryContext: view.directoryContext, projectRoot: view.values.projectRoot, instance: view.instance, projectSelection: view.projectSelection, sessionGuidance: view.sessionGuidance }));
  }
  if (name === "settings.import" || name === "settings.export") {
    const actual = await readValues();
    return result({ mode: name.split(".")[1], navigation: "project", values: actual.values });
  }
  if (name === "settings.edit") {
    if (!selectedRoot) throw new Error("Выберите папку проекта.");
    const data = await backend("edit", args);
    return { ...result(data), _meta: { data } };
  }
  const actions = { "settings.reset_connection": "reset_connection", "settings.update": "update", "settings.preview": "preview", "settings.apply": "apply", "settings.run_check": "check", "settings.refresh_readiness": "refresh_readiness", "settings.rebuild_index": "rebuild_index", "settings.restart_index": "restart_index", "settings.updates": "updates", "settings.create": "create", "settings.load": "load", "settings.rename_profile": "rename_profile" };
  if (!actions[name]) throw new Error("Неизвестный инструмент");
  if (["settings.run_check", "settings.refresh_readiness"].includes(name) && !selectedRoot) throw new Error("Выберите папку проекта.");
  // The backend resolves and authorizes the same root immediately before
  // preparation. A second path resolver here would disagree on profile/Git roots.
  const revision = selectionRevision;
  const proposedRoot = name === "settings.update" ? args.set.projectRoot : args.projectRoot;
  const context = { projectRoot: proposedRoot === undefined ? selectedRoot : proposedRoot || null,
    selectedDirectory: selectedRoot, rootLocked, instance: process.env.EDT_AI_INSTANCE || "default" };
  if (["settings.run_check", "settings.refresh_readiness"].includes(name)) return result(operations.status(operations.start(actions[name], args, context).id));
  if (["settings.rebuild_index", "settings.restart_index"].includes(name)) {
    if (name === "settings.rebuild_index" && (args.all === true) === Object.hasOwn(args, "repository")) throw new Error("Выберите один EDT-проект или все EDT-проекты.");
    return result(operations.status(operations.start(actions[name], args, context).id));
  }
  if (name === "settings.updates") return result(operations.status(operations.start("updates", args, context).id));
  const data = await (name === "settings.preview" ? backend(actions[name], args, context) : operations.execute(actions[name], args, context));
  if (revision === selectionRevision && !rootLocked && !selectionError && data.values && Object.hasOwn(data.values, "projectRoot")) {
    if (selectedRoot !== (data.values.projectRoot || null)) await dropIndexObserver("project_changed");
    selectedRoot = data.values.projectRoot || null;
  }
  return result({ ...data, ...(["settings.create", "settings.load"].includes(name) ? { mode: "profile" } : {}) },
    ["settings.create", "settings.load"].includes(name) ? JSON.stringify(data) : name === "settings.apply" ? args.mode === "layer" ? "Настройки сохранены." : "Настройки импортированы." : "Готово");
}
function validateArguments(schema, value) {
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Ожидался объект настроек");
    for (const required of schema.required || []) if (!Object.hasOwn(value, required)) throw new Error("Не заполнено поле: " + required);
    if (schema.minProperties && Object.keys(value).length < schema.minProperties) throw new Error("Нет изменений настроек");
    for (const [key, child] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties || {}, key)) {
        if (schema.additionalProperties === false) throw new Error("Неизвестное поле: " + key);
      } else validateArguments(schema.properties[key], child);
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) throw new Error("Некорректный тип настройки");
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new Error("Недостаточно элементов настройки");
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new Error("Слишком много элементов настройки");
    for (const item of value) validateArguments(schema.items || {}, item);
  } else if (schema.type === "integer" ? !Number.isInteger(value) : schema.type && typeof value !== schema.type) throw new Error("Некорректный тип настройки");
  if (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum) throw new Error("Значение настройки вне допустимого диапазона");
  if (schema.const !== undefined && value !== schema.const) throw new Error("Некорректное значение настройки");
  if (schema.enum && !schema.enum.includes(value)) throw new Error("Некорректное значение настройки");
  if (schema.minLength && value.trim().length < schema.minLength) throw new Error("Пустое значение настройки");
  if (schema.maxLength && value.length > schema.maxLength) throw new Error("Файл слишком большой");
}
tools.push({ name: "settings.run_check", title: "Подготовить и проверить готовность", description: "Prepare enabled managed runtimes and check all configured MCPs, exact EDT project readiness, index health, bundled policy, skills and guard files. Requires scoped authorization for launching project services. The timestamped setup result expires on settings/files changes or after 15 minutes; host hook trust/activation is not established. Pass refresh=true only for an incompatible cached managed artifact. Poll settings.operation with its id; do not repeat to wait.",
  inputSchema: { type: "object", properties: {
    refresh: { type: "boolean" }, authorization: preparationAuthorization,
  }, required: ["authorization"], additionalProperties: false },
  annotations: { ...annotations(false), openWorldHint: true }, _meta: shared });
tools.push({ name: "settings.rebuild_index", title: "Пересоздать индексы EDT-проектов", description: "Rebuild one configured EDT repository, or all=true for every configured EDT repository, with the native index --force CLI after scoped authorization. Specify exactly one of repository or all. Stops the owned project daemon once and rebuilds sequentially before restarting it. May take several minutes; poll settings.operation for phase, current project and completed/total counts. Never retry a running operation. Does not edit the profile or source files.",
  inputSchema: { type: "object", properties: { repository: { type: "string", minLength: 1 }, all: { type: "boolean", const: true }, authorization: preparationAuthorization }, required: ["authorization"], oneOf: [{ required: ["repository"] }, { required: ["all"] }], additionalProperties: false },
  annotations: { ...annotations(false), openWorldHint: true }, _meta: shared });
tools.push({ name: "settings.restart_index", title: "Применить состав проектов индекса", description: "Safely restart the owned code-index daemon with current repository mappings, without rebuilding indexes. Requires scoped authorization and waits for active readers. Poll settings.operation.",
  inputSchema: { type: "object", properties: { authorization: preparationAuthorization }, required: ["authorization"], additionalProperties: false },
  annotations: { ...annotations(false), openWorldHint: true }, _meta: appOnly });
tools.push({ name: "settings.updates", title: "Обновления компонентов", description: "Install the component's saved version in one operation: download a candidate, validate its live protocol and activate it. An explicit version can upgrade or downgrade. Stable releases are the default for latest. Separate check, download, apply and rollback operations remain available. Mutating operations require scoped authorization. Poll settings.operation; do not retry a running operation.",
  inputSchema: { type: "object", properties: {
    operation: { enum: ["install", "check", "download", "apply", "rollback"] },
    version: { ...primitive.codeIndexVersion, title: "Версия для установки", description: "Install only: selected tag or latest (stable). Saved only after successful validation and activation; omit to use the saved release policy." },
    component: { enum: ["code-index", "bsl-ls"], description: "Target component for this operation. Only check may omit it to inspect both components." }, authorization: preparationAuthorization,
  }, required: ["operation"], additionalProperties: false },
  annotations: { ...annotations(false), openWorldHint: true }, _meta: shared });
tools.push({ name: "settings.versions", title: "Версии компонента", description: "List published release tags and resolve latest with and without prereleases using the installation release policy. Read-only catalog; does not install or launch components. The settings form searches the complete catalog locally.",
  inputSchema: { type: "object", properties: { component: { enum: ["code-index", "bsl-ls"] }, refresh: { type: "boolean", description: "Bypass the catalog cache and revalidate GitHub responses for a manual refresh or retry." } }, required: ["component"], additionalProperties: false },
  annotations: { ...annotations(), openWorldHint: true }, _meta: appOnly });
for (const tool of tools) tool.icons = component_icons("settings");

function write(message) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n"); }
async function dispatch(message) {
  if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") {
    write({ id: null, error: { code: -32600, message: "Invalid Request" } }); return;
  }
  if (!Object.hasOwn(message, "method") && message.id === pendingRoots && pendingRoots !== null) {
    while (transferInFlight) await transferInFlight;
    if (message.id !== pendingRoots || pendingRoots === null) return;
    pendingRoots = null;
    const entries = message.result?.roots;
    if (!process.env.EDT_AI_PROJECT_ROOT) {
      try {
        // Some hosts advertise roots but cannot serve the request. Only an
        // unsupported method falls back to cwd; explicit empty roots clear it.
        if (message.error?.code === -32601) { useLaunchDirectory(); finishRoots?.(); finishRoots = null; return; }
        if (!Array.isArray(entries)) throw new Error("missing roots");
        if (!entries.length) { selectedRoot = null; rootLocked = false; selectionError = null; finishRoots?.(); finishRoots = null; return; }
        selectedRoot = roots_selection(message).directory;
        rootLocked = Boolean(selectedRoot);
        selectionError = null;
      } catch { selectedRoot = null; selectionError = "Не удалось однозначно определить папку проекта этого чата. Укажите одну папку проекта на этом компьютере."; }
    }
    finishRoots?.(); finishRoots = null;
    return;
  }
  if (message.method === undefined && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) return;
  if (typeof message.method !== "string") {
    write({ id: message.id ?? null, error: { code: -32600, message: "Invalid Request" } }); return;
  }
  if (message.method === "notifications/initialized") {
    if (requestInitialRoots) { requestInitialRoots = false; requestRoots(); }
    return;
  }
  if (message.method === "notifications/roots/list_changed") { requestRoots(); return; }
  if (!Object.hasOwn(message, "id")) return;
  // Discovery reports the supported legacy versions even to modern probes.
  // Project selection and operation ownership still require the connection-
  // scoped initialize handshake; no stateless tool calls are enabled.
  const requested = message.params?._meta?.["io.modelcontextprotocol/protocolVersion"];
  if (message.method !== "server/discover" && requested && !protocols.includes(requested)) {
    write({ id: message.id, error: { code: -32601,
      message: "Session-scoped settings require the initialize handshake." } });
    return;
  }
  try {
    let data;
    if (message.method === "initialize") {
      data = { protocolVersion: protocols.includes(message.params?.protocolVersion) ? message.params.protocolVersion : protocols[0],
        instructions: "Start with settings.inspect; supply this chat's projectRoot if roots are empty. Forms and preparation require authorization.",
        serverInfo: { name: "1c-ai-settings", title: "1c-ai-settings", version: core_version, icons: plugin_icons() },
        capabilities: { tools: {}, resources: {} } };
    } else if (message.method === "server/discover") {
      data = { resultType: "complete", supportedVersions: protocols,
        _meta: { "io.modelcontextprotocol/serverInfo": { name: "1c-ai-settings", title: "1c-ai-settings", version: core_version } },
        capabilities: { tools: {}, resources: {} } };
    } else if (message.method === "ping") data = {};
    else if (message.method === "tools/list") data = { tools };
    else if (message.method === "tools/call") {
      const started = Date.now(), tool = message.params?.name;
      register_diagnostic_secrets(message.params?.arguments || {});
      const quiet = ["settings.read", "settings.status", "settings.operation", "settings.diagnostics", "settings.refresh_readiness"].includes(tool);
      const requestContext = { id: message.id };
      if (!quiet) diagnostic.event("request_started", { requestId: message.id, tool, projectRoot: selectedRoot, phase: "dispatch" });
      try {
        data = await call(message.params.name, message.params.arguments || {}, message.params._meta, requestContext);
        if (!quiet) diagnostic.event("request_completed", { requestId: message.id, tool, projectRoot: selectedRoot, durationMs: Date.now() - started,
          ...(data.structuredContent?.status === "running" ? { operationId: data.structuredContent.id } : {}), isError: Boolean(data.isError), phase: "completed" }, data.isError ? "error" : "info");
      }
      catch (error) { diagnostic.event("request_failed", { requestId: message.id, tool, projectRoot: Object.hasOwn(requestContext, "exportRoot") ? requestContext.exportRoot : selectedRoot, phase: "dispatch", ...requestContext.exportProgress, durationMs: Date.now() - started, error }, "error"); data = { isError: true, content: [{ type: "text", text: safe_error_message(error) }] }; }
    } else if (message.method === "resources/list") {
      data = { resources: [{ uri: resource, name: "Настройки 1C AI Core", mimeType: "text/html;profile=mcp-app" }] };
    } else if (message.method === "resources/read" && message.params?.uri === resource) {
      data = { contents: [{ uri: resource, mimeType: "text/html;profile=mcp-app",
        text: fs.readFileSync(path.join(root, "ui/settings.html"), "utf8").replaceAll("__CORE_VERSION__", core_version),
        _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } },
                 "openai/ui": { availableDisplayModes: ["fullscreen"] } } }] };
    } else {
      write({ id: message.id, error: { code: -32601, message: "Method not found" } });
      return;
    }
    if (message.method === "initialize") requestInitialRoots = !process.env.EDT_AI_PROJECT_ROOT && message.params?.capabilities?.roots != null;
    write({ id: message.id, result: data });
  } catch (error) { write({ id: message.id, error: { code: -32000, message: safe_error_message(error) } }); }
}
function shutdown(reason) {
  if (shutdownPromise) return shutdownPromise;
  sessionClosing = true;
  // The MCP host must not be held open forever by a broken close operation.
  // A forced exit is a failed cleanup, never confirmation that descendants
  // or remote resources have stopped.
  const deadline = setTimeout(() => {
    diagnostic.event("session_cleanup_timeout", { reason }, "error");
    process.exit(1);
  }, 12000);
  shutdownPromise = Promise.allSettled([dropIndexObserver(reason), operations.shutdown(), ...[...backendCleanups.values()].map(cleanup => cleanup(reason))]).then(async results => {
    await dropIndexObserver(reason);
    const failure = results.find(result => result.status === "rejected");
    if (failure || indexObserverFailure) throw failure?.reason || indexObserverFailure;
  }).catch(error => { diagnostic.event("session_cleanup_failed", { reason, error }, "error"); process.exit(1); })
    .finally(() => clearTimeout(deadline));
  return shutdownPromise;
}
read_frames(process.stdin, line => {
  try { const msg = JSON.parse(line); void dispatch(msg).catch(error => diagnostic.event("dispatch_failed", { error }, "error")); }
  catch { write({ id: null, error: { code: -32700, message: "Parse error" } }); }
}, () => {
  write({ id: null, error: { code: -32600, message: "Сообщение MCP повреждено или превышает допустимый размер." } });
  process.exitCode = 1;
  process.stdin.destroy();
});
process.stdin.once("end", () => { void shutdown("session_closed"); });
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => {
  process.stdin.destroy();
  void shutdown("session_signal").finally(() => { process.exitCode = 1; });
});

