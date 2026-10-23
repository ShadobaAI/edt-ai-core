import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { launch_selection, roots_selection, explicit_selection } from "../scripts/selection.mjs";
import { core_version } from "../scripts/compatibility.mjs";
import { SettingsOperations } from "./settings-operations.mjs";
import { plugin_icons, component_icons } from "../scripts/icons.mjs";
import { folder_action } from "../scripts/settings_folder.mjs";
import { create_diagnostic_logger, register_diagnostic_secrets, diagnostic_journal, sanitize_diagnostics } from "../scripts/diagnostics.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const state = process.env.EDT_AI_STATE_DIR || path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "1c-ai-core");
const configPath = process.env.EDT_AI_SETTINGS || path.join(state, "settings.json");
const diagnostic = create_diagnostic_logger("settings", state);
diagnostic.event("session_started", { version: core_version, projectRoot: process.env.EDT_AI_PROJECT_ROOT || null, node: process.version });
process.on("uncaughtExceptionMonitor", error => diagnostic.event("uncaught_exception", { error }, "error"));
const resource = "ui://1c-ai-core/settings.html";
const protocols = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
let selectedRoot = process.env.EDT_AI_PROJECT_ROOT || null;
let rootLocked = Boolean(selectedRoot);
let selectionRevision = 0;
let pendingRoots = null, rootsSequence = 0;
let selectionError = null, rootReady = Promise.resolve(), finishRoots;
function requestRoots() {
  if (process.env.EDT_AI_PROJECT_ROOT) return;
  finishRoots?.();
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
  v8stdUrl: { type: "string", title: "URL v8std MCP", description: "Override этого каталога и экземпляра. Пустое значение отключает подключение; окружение имеет высший приоритет." },
  codeIndexEnabled: { type: "boolean", title: "Индекс кода" },
  bslLsEnabled: { type: "boolean", title: "BSL LS", description: "Дополнительный анализатор; включайте при необходимости." },
  codeIndexVersion: { type: "string", title: "Версия индекса кода", pattern: "^(latest|[A-Za-z0-9][A-Za-z0-9._+-]{0,127})$", description: "latest или точный тег, включая предварительный релиз. Общая настройка пользователя." },
  codeIndexAllowPrerelease: { type: "boolean", title: "Предварительные релизы индекса кода", description: "При version=latest разрешить предварительные релизы. По умолчанию false. Общая настройка пользователя." },
  bslLsVersion: { type: "string", title: "Версия BSL LS", pattern: "^(latest|[A-Za-z0-9][A-Za-z0-9._+-]{0,127})$", description: "latest или точный тег, включая предварительный релиз. Общая настройка пользователя." },
  bslLsAllowPrerelease: { type: "boolean", title: "Предварительные релизы BSL LS", description: "При version=latest разрешить предварительные релизы. По умолчанию false. Общая настройка пользователя." },
  openvikingEnabled: { type: "boolean", title: "Транспорт OpenViking", description: "Override текущего каталога и экземпляра. Не изменяет режим и обязательность знаний; поисковый адаптер пока не реализован." },
  openvikingUrl: { type: "string", title: "URL OpenViking", description: "Override текущего каталога и экземпляра. Пустое значение отключает транспорт; окружение имеет высший приоритет." },
};
const versionCatalogs = new Map();

function values(c) {
  return {
    projectRoot: c.active_project || "",
    edtUrl: c.mcp.required.edt.url, v8stdUrl: c.mcp.required.v8std.url,
    codeIndexEnabled: c.mcp.managed["code-index"].enabled !== false, bslLsEnabled: c.mcp.managed["bsl-ls"].enabled !== false,
    codeIndexVersion: c.mcp.managed["code-index"].version, codeIndexAllowPrerelease: Boolean(c.mcp.managed["code-index"].allow_prerelease),
    bslLsVersion: c.mcp.managed["bsl-ls"].version, bslLsAllowPrerelease: Boolean(c.mcp.managed["bsl-ls"].allow_prerelease),
    openvikingEnabled: Boolean(c.mcp.optional?.openviking?.enabled),
    openvikingUrl: c.mcp.optional?.openviking?.url || "",
  };
}
async function readValues(remember = false) {
  // The Node backend owns JSON/YAML loading, profile resolution and precedence.
  // The unconfigured screen remains dependency-free and does not create state.
  if (selectedRoot || fs.existsSync(configPath) || fs.existsSync(path.join(state, "projects"))) {
    try {
      const current = await backend("read", { remember });
      diagnostic.event("settings_snapshot", { projectRoot: current.values?.projectRoot, values: current.values, profile: current.profile, connectionSources: current.connectionSources });
      return current;
    }
    catch (error) {
      diagnostic.event("settings_unavailable", { error }, "error");
      const defaults = JSON.parse(fs.readFileSync(path.join(root, "settings", "defaults.json"), "utf8"));
      return { values: { ...values(defaults), projectRoot: selectedRoot || "" },
        profile: { status: "invalid", detail: "Не удалось прочитать настройки. Скачайте диагностику для поддержки.", path: null },
        configurationError: true, instance: process.env.EDT_AI_INSTANCE || "default", preparationScope: null };
    }
  }
  const defaults = JSON.parse(fs.readFileSync(path.join(root, "settings", "defaults.json"), "utf8"));
  return { values: { ...values(defaults), projectRoot: "" }, profile: { status: "unselected", path: null }, instance: process.env.EDT_AI_INSTANCE || "default", preparationScope: null };
}
function readSettings(actual) {
  return {
    schema: { type: "object", properties: structuredClone(primitive) },
    values: actual.values, instance: actual.instance, connectionSources: actual.connectionSources,
    installedVersions: actual.installedVersions,
    preparationScope: actual.preparationScope,
    profile: actual.profile, directoryContext: actual.directoryContext, sessionGuidance: actual.sessionGuidance,
    profileDirectoryContext: actual.profileDirectoryContext,
    edtPortSuggestion: actual.edtPortSuggestion,
    readiness: actual.readiness,
    knowledge: actual.knowledge,
    legacyState: actual.legacyState,
    profileHistory: actual.profileHistory || [], summary: actual.summary,
    configurationError: actual.configurationError,
    operation: operationSummary(),
    folderActions: { supported: process.platform === "win32" },
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
  mode: { type: "string", enum: ["import", "edit"], description: "Import merges portable settings; edit saves the complete document loaded by settings.edit and resets omitted runtime values to defaults." },
  baseRevision: { type: "string", minLength: 1, description: "Required in edit mode: exact baseRevision returned by settings.edit." },
};
const tools = [
  { name: "settings.select_profile", title: "Открыть профиль", description: "Explicitly select a directory in the settings app. Another chat's profile is read-only and never rebinds the current chat.",
    inputSchema: { type: "object", required: ["projectRoot"], properties: { projectRoot: { type: "string", minLength: 1 } }, additionalProperties: false }, annotations: annotations(false), _meta: appOnly },
  { name: "settings.status", title: "Сводное состояние профиля", description: "Passive profile and local daemon observation. Does not launch services or repeat preparation or probes.",
    inputSchema: { type: "object", properties: { projectRoot: { type: "string", minLength: 1 } }, additionalProperties: false }, annotations: annotations(), _meta: appOnly },
  { name: "settings.refresh_readiness", title: "Обновить готовность профиля", description: "Refresh live service checks when the settings app loads a profile. Reuses only this project's and instance's existing preparation permission and installed runtimes. Does not grant permission, download components or rebind chat connections. Poll settings.operation with the returned id.",
    inputSchema: { type: "object", properties: { scope: { type: "string", minLength: 1 } }, required: ["scope"], additionalProperties: false }, annotations: { ...annotations(false), openWorldHint: true }, _meta: appOnly },
  { name: "settings.reset_connection", title: "Вернуть наследование подключения", description: "Remove this instance's URL override and inherit the next configured source.",
    inputSchema: { type: "object", required: ["connection"], properties: { connection: { type: "string", enum: ["edt", "v8std", "openviking"] } }, additionalProperties: false }, annotations: annotations(false), _meta: appOnly },
  { name: "settings.open", title: "Настройки", description: "Open the full settings workspace with the user's profile list from Open plugin or app navigation. The form automatically refreshes readiness using installed runtimes and existing project-scoped preparation permissions.",
    inputSchema: empty, annotations: annotations(), _meta: { ui: { resourceUri: resource, visibility: ["app"] }, "openai/ui": { entrypoints: [{ type: "global" }] } } },
  { name: "settings.inspect", title: "Проверить настройку проекта", description: "Start chat setup here: compact profile validation, effective connections, detected EDT projects/port, managed preparation and next steps in one read-only call. Supply this chat's known projectRoot when host roots are empty. Do not read plugin source or reload an already loaded profile to diagnose setup.",
    inputSchema: inspectInput, annotations: annotations(), _meta: shared },
  { name: "settings.probe_connections", title: "Проверить EDT и v8std", description: "One read-only external connection test, including exact EDT repository paths/readiness when list_projects is exposed. Does not download or launch services. Returns an operation ID: poll settings.operation with waitMs=10000; never repeat to wait. This acceptance is separate from current chat relay binding.",
    inputSchema: { type: "object", properties: { connections: { type: "object", properties: { edt: { type: "string" }, v8std: { type: "string" } }, additionalProperties: false, description: "Optional unsaved URLs to test without persisting them. An empty string tests a disabled connection." } }, additionalProperties: false }, annotations: { ...annotations(), openWorldHint: true }, _meta: shared },
  { name: "settings.profile", title: "Настройки проекта", description: "Open the settings form for this chat's selected profile only on an explicit user request to view, create or change profile/settings. Code analysis and runtime troubleshooting do not authorize opening a form; use settings.inspect instead. Always supply this chat's known projectRoot so the form retains its directory across MCP connections; {} uses host roots when available. Does not reload profiles or borrow another chat's directory.",
    inputSchema: inspectInput, annotations: annotations(), _meta: { ...appTool, "openai/ui": { entrypoints: [{ type: "thread" }] } } },
  ...[["settings.create", "Создать профиль", "Create the generic .ai/project.yaml and missing project instructions in this chat's selected repository, only when the user requests creation. Never overwrites a profile or existing instructions. Returns projectInstructions.created/preserved; optional overrideFile reports a non-empty AGENTS.override.md that takes precedence over the adjacent AGENTS.md. contentValidated=false means project rules still need review. Follow the setup skill's project-instructions reference to complete them from confirmed facts. Repository mappings still need configuration."],
      ["settings.load", "Загрузить профиль", "Validate and reload the existing .ai/project.yaml for this chat's selected repository. Does not import a file or launch services. Report sessionGuidance; if the host does not refresh tools, ask the user to open a new chat in the same directory or restart Codex."]].map(([name, title, description]) => ({
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
  { name: "settings.open_directory", title: "Открыть папку проекта", description: "Open the selected project directory in the system file manager.",
    inputSchema: empty, annotations: annotations(false), _meta: appOnly },
  { name: "settings.update", title: "Сохранить настройки", description: "Update changed plugin settings.",
    inputSchema: { type: "object", required: ["set"], properties: { set: {
      type: "object", properties: primitive, minProperties: 1, additionalProperties: false } }, additionalProperties: false },
    outputSchema: { type: "object", required: ["values"], properties: { values: { type: "object" } } },
    annotations: annotations(false), _meta: shared },
  ...[["settings.import", "Открыть импорт"], ["settings.export", "Открыть экспорт"]].map(([name, title]) => ({
    name, title, description: `${title}. Open the form only on an explicit user request to import/export profile settings. This does not import or export by itself.`,
    inputSchema: inspectInput, annotations: annotations(), _meta: appTool,
  })),
  { name: "settings.preview", title: "Проверить файл", description: "Preview settings import without writing.",
    inputSchema: { type: "object", required: ["text"], properties: {
      ...editArguments,
      text: { type: "string", maxLength: 2097152 }, projectRoot: { type: "string" } }, additionalProperties: false },
    annotations: annotations(), _meta: shared },
  { name: "settings.apply", title: "Импортировать", description: "Apply a reviewed settings import.",
    inputSchema: { type: "object", required: ["text", "revision"], properties: {
      ...editArguments,
      text: { type: "string", maxLength: 2097152 }, projectRoot: { type: "string" },
      revision: { type: "string" }, replace: { type: "boolean" } }, additionalProperties: false },
    annotations: annotations(false), _meta: shared },
  { name: "settings.export_data", title: "Скачать настройки", description: "Export shared settings and tracked profile defaults; instance overrides stay local.",
    inputSchema: empty, annotations: annotations(), _meta: shared },
  { name: "settings.save_export", title: "Сохранить файл настроек", description: "Save the portable settings export to a local file and return its confirmed path to the settings app. Replaces the previous export; instance overrides stay local.",
    inputSchema: empty, annotations: annotations(false), _meta: appOnly },
  { name: "settings.open_export_directory", title: "Открыть папку экспорта", description: "Open the directory containing the saved settings export. Does not accept arbitrary paths or generate another export.",
    inputSchema: empty, annotations: annotations(false), _meta: appOnly },
  { name: "settings.export_diagnostics", title: "Сохранить диагностику", description: "Save a bounded, redacted support report to disk from the settings app only and return its confirmed path in app metadata. Replaces the previous support report. Works without a profile and during a running operation. Does not contact services or upload data.",
    inputSchema: empty, annotations: annotations(false), _meta: appOnly },
  { name: "settings.diagnostics", title: "Журнал и диагностика", description: "Read the last 200 sanitized plugin events and local session metadata in the settings app. Works without a profile and during operations. Does not contact or launch services. Log data is app-only metadata.",
    inputSchema: empty, annotations: annotations(), _meta: appOnly },
  { name: "settings.open_diagnostics_directory", title: "Открыть папку диагностики", description: "Open the directory containing the saved support report from the settings app only. Does not generate a report or accept arbitrary paths.",
    inputSchema: empty, annotations: annotations(false), _meta: appOnly },
  { name: "settings.edit", title: "Загрузить настройки для редактирования", description: "Read the complete profile and shared runtime document with a baseRevision. Save edits through settings.preview/apply with mode=edit and that baseRevision; omitted runtime fields reset to defaults, unchanged profiles are not rewritten.",
    inputSchema: empty, annotations: annotations(), _meta: shared },
  { name: "settings.document", title: "Просмотреть документ профиля", description: "Read a history profile document in the settings app without selecting it for chat operations. Does not write or launch services.",
    inputSchema: { type: "object", required: ["projectRoot"], properties: { projectRoot: { type: "string", minLength: 1 } }, additionalProperties: false }, annotations: annotations(), _meta: appOnly },
  { name: "settings.operation", title: "Состояние операции", description: "Read a running or completed settings operation without retrying it. Results belong to this MCP session and include their original project/instance.",
    inputSchema: { type: "object", properties: { operationId: { type: "string" }, waitMs: { type: "integer", minimum: 0, maximum: 10000, description: "Wait for this operation to finish, up to 10 seconds. Prefer a bounded wait over repeated immediate polls." } }, additionalProperties: false },
    annotations: annotations(), _meta: shared },
  { name: "settings.check", title: "Проверка готовности", description: "Read the compact profile inspection and saved readiness, like settings.inspect, without opening a form or launching services. Use settings.probe_connections for live external checks, core_runtime_status for the required chat relay, or settings.run_check for authorized preparation.",
    inputSchema: inspectInput, annotations: annotations(), _meta: shared },
];

function backend(action, args, context = { projectRoot: selectedRoot, selectedDirectory: selectedRoot, rootLocked, instance: process.env.EDT_AI_INSTANCE || "default" }, readDeadline = 0) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath,
      [path.join(root, "scripts", "settings_backend.mjs")], {
        cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, EDT_AI_STATE_DIR: state, EDT_AI_SETTINGS: configPath,
          EDT_AI_PROJECT_ROOT: context.selectedDirectory || "", EDT_AI_SETTINGS_ROOT_LOCKED: context.rootLocked === false ? "0" : "1" },
      });
    let output = "", errors = "";
    // Only the support collector sets a deadline, and only for a read.
    const timer = readDeadline && action === "read" ? setTimeout(() => {
      child.kill(); reject(Object.assign(new Error("Support state read timed out"), { code: "READ_TIMEOUT" }));
    }, readDeadline) : null;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { errors = (errors + chunk).slice(-4000); process.stderr.write(chunk); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.stdin.on("error", () => {}); // close/output below owns the operation outcome
    child.once("close", code => {
      clearTimeout(timer);
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
      if (data.ok !== true) { const error = new Error(data.error || "Сервис настроек сообщил об ошибке."); error.code = data.errorCode; error.outcomeUnknown = data.outcomeUnknown === true; reject(error); return; }
      if (code !== 0) {
        const error = new Error("Сервис настроек вернул результат, но завершился с ошибкой. Проверьте сохранённые настройки и состояние сервисов перед повтором.");
        error.outcomeUnknown = true; reject(error); return;
      }
      register_diagnostic_secrets(data.result);
      resolve(data.result);
    });
    child.stdin.end(JSON.stringify({ action, ...args }));
  });
}
const operations = new SettingsOperations(async (action, args, context) => {
  if (action !== "pick_directory") return backend(action, args, context);
  const directory = await folder_action("pick", args.projectRoot || context.selectedDirectory || "");
  if (context.selectionRevision !== selectionRevision) throw new Error("Папка чата изменилась во время выбора. Откройте настройки заново.");
  if (!directory) return { cancelled: true };
  const data = await backend("read", { remember: true }, { selectedDirectory: directory, rootLocked: false });
  if (context.selectionRevision !== selectionRevision) throw new Error("Папка чата изменилась во время выбора. Откройте настройки заново.");
  selectedRoot = data.values.projectRoot;
  selectionRevision += 1;
  return data;
}, (name, detail, level) => diagnostic.event(name, detail, level));
function operationSummary() {
  const { result, ...summary } = operations.status();
  return summary;
}
function result(data, text = JSON.stringify(data)) {
  return { content: [{ type: "text", text }], structuredContent: data };
}
async function call(name, args, meta = {}) {
  if (pendingRoots) await new Promise(resolve => {
    const timer = setTimeout(resolve, 3000);
    rootReady.then(() => { clearTimeout(timer); resolve(); });
  });
  const definition = tools.find(item => item.name === name);
  if (!definition) throw new Error("Неизвестный инструмент");
  validateArguments(definition.inputSchema, args);
  // A job owns its original context. The picker can finish before the app
  // learns its new directory; stale view metadata must not rebind this read.
  if (name === "settings.operation") {
    await operations.wait(args.operationId, args.waitMs || 0);
    const operation = operations.status(args.operationId);
    return result({ ...operation, mode: "operation", navigation: "project" }, `${operation.status}${operation.id ? " · " + operation.id : ""}${operation.error ? ": " + operation.error : ""}`);
  }
  // App calls may use a fresh MCP connection with empty roots. Carry the
  // invoking chat's explicit scope, never a global last-used profile.
  const requestedRoot = meta?.["1c-ai-core/projectRoot"] ??
    (["settings.profile", "settings.import", "settings.export", "settings.check"].includes(name) ? args.projectRoot : undefined);
  if (requestedRoot !== undefined) {
    if (operations.status().status === "running" && !selectedRoot) throw new Error("Дождитесь завершения текущей операции перед привязкой проекта.");
    const selection = explicit_selection({ directory: selectedRoot }, requestedRoot, selectionError);
    if (selection.directory !== selectedRoot) { selectedRoot = selection.directory; selectionRevision += 1; }
    rootLocked ||= ["settings.profile", "settings.import", "settings.export", "settings.check"].includes(name) || meta?.["1c-ai-core/navigation"] !== "profiles";
  }
  if (name === "settings.document") {
    const revision = selectionRevision;
    const document = await backend("edit", {}, { selectedDirectory: args.projectRoot, rootLocked: false });
    if (revision !== selectionRevision) throw new Error("Папка чата изменилась. Откройте документ заново.");
    return { content: [{ type: "text", text: "Документ профиля прочитан." }], _meta: { data: document } };
  }
  if (name === "settings.diagnostics") {
    const data = sanitize_diagnostics({ ...diagnostic_journal(state), observedAt: new Date().toISOString(),
      runtime: { plugin: core_version, node: process.version, platform: process.platform, architecture: process.arch },
      session: { projectRoot: selectedRoot, instance: process.env.EDT_AI_INSTANCE || "default", locked: rootLocked,
        selectionError, pendingRoots: Boolean(pendingRoots), operation: operationSummary(), logger: diagnostic.status() },
      paths: { state, settings: configPath } });
    return { content: [{ type: "text", text: "Журнал плагина прочитан." }], _meta: { data } };
  }
  if (name === "settings.export_diagnostics") {
    diagnostic.event("support_export_requested", { projectRoot: selectedRoot });
    const { support_bundle, save_support_bundle } = await import("../scripts/support_bundle.mjs");
    const context = { selectedDirectory: selectedRoot, rootLocked };
    const data = await support_bundle({ state, configPath, selectedRoot,
      selection: { rootLocked, selectionError, pendingRoots }, operation: operations.status(), loggerStatus: diagnostic.status(),
      readCurrent: () => backend("read", {}, context, 8000) });
    const saved = save_support_bundle(state, data);
    diagnostic.event("support_export_saved", { path: saved.path, bytes: saved.bytes });
    // Only the settings app receives the saved path. File bytes do not cross
    // the app bridge, and a success response requires a completed disk write.
    return { content: [{ type: "text", text: "Диагностический файл сохранён." }], _meta: { data: { ...saved, canOpenDirectory: process.platform === "win32" } } };
  }
  if (name === "settings.open_diagnostics_directory") {
    const { saved_support_report } = await import("../scripts/support_bundle.mjs");
    const saved = saved_support_report(state);
    if (!saved) throw new Error("Сначала сохраните диагностический файл.");
    await folder_action("open", saved.directory);
    return { content: [{ type: "text", text: "Папка диагностики открыта." }] };
  }
  const readOnlyEntry = ["settings.inspect", "settings.read", "settings.status", "settings.open", "settings.profile", "settings.import", "settings.export", "settings.check", "settings.versions"].includes(name);
  if (name === "settings.versions") {
    let cached = versionCatalogs.get(args.component);
    if (args.refresh || !cached || cached.expires < Date.now()) {
      const promise = import("../scripts/runtime.mjs").then(async runtime => {
        const [catalog, latest] = await Promise.allSettled([
          runtime.list_versions(args.component, undefined, { refresh: args.refresh }),
          runtime.latest_version(args.component, undefined, { refresh: args.refresh }),
        ]);
        if (catalog.status === "rejected") throw catalog.reason;
        const data = { ...catalog.value, latest: latest.status === "fulfilled" ? latest.value : null,
          ...(latest.status === "rejected" ? { latestError: latest.reason.message } : {}) };
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
    if (revision !== selectionRevision) throw new Error("Папка чата изменилась. Выберите профиль заново.");
    const viewOnly = Boolean(selectionError || (rootLocked && actual.values.projectRoot !== current.values.projectRoot));
    if (name === "settings.select_profile" && !viewOnly) { selectedRoot = actual.values.projectRoot; selectionRevision += 1; }
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
    if (selection.directory !== selectedRoot) { selectedRoot = selection.directory; selectionRevision += 1; }
    if (args.projectRoot !== undefined) rootLocked = true;
    const read = await readValues();
    const { setup_inspection } = await import("../scripts/setup_inspection.mjs");
    const snapshot = setup_inspection({ ...read, projectSelection: { status: selectionError ? (pendingRoots ? "pending" : "ambiguous") : selectedRoot ? "selected" : "unselected", locked: rootLocked, detail: selectionError }, operation: operationSummary() }, state);
    return result(snapshot, `Профиль: ${snapshot.profile.status}. Следующие шаги: ${snapshot.nextSteps.join(", ") || "нет"}.`);
  }
  if (selectionError && !readOnlyEntry) throw new Error(selectionError);
  if (operations.status().status === "running" && !readOnlyEntry && !(operations.status().action === "refresh_readiness" && ["settings.edit", "settings.preview", "settings.export_data"].includes(name))) throw new Error(
    operations.status().action === "pick_directory"
      ? "Завершите или отмените выбор папки в системном окне."
      : "Операция ещё выполняется. Дождитесь её завершения.");
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
    return result(view, JSON.stringify(view));
  }
  if (name === "settings.profile" || name === "settings.open") {
    const view = readSettings(await readValues(true));
    return result({ ...view, mode: "profile", navigation: name === "settings.profile" ? "project" : "profiles" }, JSON.stringify({ profile: view.profile, directoryContext: view.directoryContext, projectRoot: view.values.projectRoot, instance: view.instance, projectSelection: view.projectSelection, sessionGuidance: view.sessionGuidance }));
  }
  if (name === "settings.import" || name === "settings.export") {
    const actual = await readValues();
    return result({ mode: name.split(".")[1], navigation: "project", values: actual.values });
  }
  if (name === "settings.open_export_directory") {
    const { saved_settings_export } = await import("../scripts/settings_export.mjs");
    const saved = saved_settings_export(state);
    if (!saved) throw new Error("Сначала сохраните файл настроек.");
    await folder_action("open", saved.directory);
    return { content: [{ type: "text", text: "Папка с файлом настроек открыта." }] };
  }
  if (name === "settings.export_data" || name === "settings.edit" || name === "settings.save_export") {
    if (!selectedRoot) throw new Error("Выберите папку проекта.");
    const data = await backend(name === "settings.edit" ? "edit" : "export", args);
    if (name === "settings.save_export") {
      const { save_settings_export } = await import("../scripts/settings_export.mjs");
      const saved = save_settings_export(state, data);
      return { content: [{ type: "text", text: "Файл настроек сохранён." }], _meta: { data: { ...saved, canOpenDirectory: process.platform === "win32" } } };
    }
    return { ...result(data), _meta: { data } };
  }
  const actions = { "settings.reset_connection": "reset_connection", "settings.update": "update", "settings.preview": "preview", "settings.apply": "apply", "settings.run_check": "check", "settings.refresh_readiness": "refresh_readiness", "settings.rebuild_index": "rebuild_index", "settings.updates": "updates", "settings.create": "create", "settings.load": "load" };
  if (!actions[name]) throw new Error("Неизвестный инструмент");
  if (["settings.run_check", "settings.refresh_readiness"].includes(name) && !selectedRoot) throw new Error("Выберите папку проекта.");
  // The backend resolves and authorizes the same root immediately before
  // preparation. A second path resolver here would disagree on profile/Git roots.
  const revision = selectionRevision;
  const proposedRoot = name === "settings.update" ? args.set.projectRoot : args.projectRoot;
  const context = { projectRoot: proposedRoot === undefined ? selectedRoot : proposedRoot || null,
    selectedDirectory: selectedRoot, rootLocked, instance: process.env.EDT_AI_INSTANCE || "default" };
  if (["settings.run_check", "settings.refresh_readiness"].includes(name)) return result(operations.status(operations.start(actions[name], args, context).id));
  if (name === "settings.rebuild_index") return result(operations.status(operations.start("rebuild_index", args, context).id));
  if (name === "settings.updates") return result(operations.status(operations.start("updates", args, context).id));
  const data = await (name === "settings.preview" ? backend(actions[name], args, context) : operations.execute(actions[name], args, context));
  if (revision === selectionRevision && !rootLocked && !selectionError && data.values && Object.hasOwn(data.values, "projectRoot")) {
    selectedRoot = data.values.projectRoot || null;
  }
  return result({ ...data, ...(["settings.create", "settings.load"].includes(name) ? { mode: "profile" } : {}) },
    ["settings.create", "settings.load"].includes(name) ? JSON.stringify(data) : name === "settings.apply" ? "Настройки импортированы." : "Готово");
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
tools.push({ name: "settings.run_check", title: "Проверить готовность к работе", description: "Prepare enabled managed runtimes and check all configured MCPs, exact EDT project readiness, index health, bundled policy, skills and guard files. Requires scoped authorization for launching project services. The timestamped setup result expires on settings/files changes or after 15 minutes; host hook trust/activation is not established. Pass refresh=true only for an incompatible cached managed artifact. Poll settings.operation with its id; do not repeat to wait.",
  inputSchema: { type: "object", properties: {
    refresh: { type: "boolean" }, authorization: preparationAuthorization,
  }, required: ["authorization"], additionalProperties: false },
  annotations: { ...annotations(false), openWorldHint: true }, _meta: shared });
tools.push({ name: "settings.rebuild_index", title: "Пересоздать индекс EDT-проекта", description: "Rebuild only one configured repository with the native index --force CLI, after scoped authorization. Stops the owned project daemon and requires current readers to finish. Does not edit the profile or source files. Poll settings.operation; do not retry a running operation.",
  inputSchema: { type: "object", properties: { repository: { type: "string", minLength: 1 }, authorization: preparationAuthorization }, required: ["repository", "authorization"], additionalProperties: false },
  annotations: { ...annotations(false), openWorldHint: true }, _meta: shared });
tools.push({ name: "settings.updates", title: "Обновления компонентов", description: "Install the component's saved version in one operation: download a candidate, validate its live protocol and activate it. An explicit version can upgrade or downgrade. Stable releases are the default for latest. Separate check, download, apply and rollback operations remain available. Mutating operations require scoped authorization. Poll settings.operation; do not retry a running operation.",
  inputSchema: { type: "object", properties: {
    operation: { enum: ["install", "check", "download", "apply", "rollback"] },
    version: { ...primitive.codeIndexVersion, title: "Версия для установки", description: "Install only: selected tag or latest (stable). Saved only after successful validation and activation; omit to use the saved release policy." },
    component: { enum: ["code-index", "bsl-ls"], description: "Target component for this operation. Only check may omit it to inspect both components." }, authorization: preparationAuthorization,
  }, required: ["operation"], additionalProperties: false },
  annotations: { ...annotations(false), openWorldHint: true }, _meta: shared });
tools.push({ name: "settings.versions", title: "Версии компонента", description: "List all published release tags, including prereleases, newest publication first, and resolve latest through GitHub's stable-release endpoint. Read-only catalog; does not install or launch components. The settings form searches the complete catalog locally.",
  inputSchema: { type: "object", properties: { component: { enum: ["code-index", "bsl-ls"] }, refresh: { type: "boolean", description: "Bypass the catalog cache and revalidate GitHub responses for a manual refresh or retry." } }, required: ["component"], additionalProperties: false },
  annotations: { ...annotations(), openWorldHint: true }, _meta: appOnly });
for (const tool of tools) tool.icons = component_icons("settings");

function write(message) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n"); }
async function dispatch(message) {
  if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") {
    write({ id: null, error: { code: -32600, message: "Invalid Request" } }); return;
  }
  if (!Object.hasOwn(message, "method") && message.id === pendingRoots && pendingRoots !== null) {
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
        instructions: "Start chat setup with settings.inspect once; include this chat's known local projectRoot when the host supplied no directory. Reuse its validation, connection sources and nextSteps. Open settings forms only on an explicit user request about viewing, creating, editing, importing or exporting profile/settings. Code analysis or runtime diagnostics does not authorize opening a form. Inspection, checks and operation polling return data without UI. Do not reload an already loaded profile, inspect plugin source, spawn substitute relays or restart chats for empty roots. Create only a missing profile on user request. Preparation needs scoped user authorization. Never select another chat's root.",
        serverInfo: { name: "1c-ai-settings", title: "1c-ai-settings", version: core_version, icons: plugin_icons() },
        capabilities: { tools: {}, resources: {} } };
    } else if (message.method === "server/discover") {
      data = { resultType: "complete", supportedVersions: protocols,
        _meta: { "io.modelcontextprotocol/serverInfo": { name: "1c-ai-settings", title: "1c-ai-settings", version: core_version } },
        capabilities: { tools: {}, resources: {} } };
    } else if (message.method === "ping") data = {};
    else if (message.method === "tools/list") data = { tools };
    else if (message.method === "tools/call") {
      try { data = await call(message.params.name, message.params.arguments || {}, message.params._meta); }
      catch (error) { diagnostic.event("request_failed", { tool: message.params?.name, projectRoot: selectedRoot, error }, "error"); data = { isError: true, content: [{ type: "text", text: error.message }] }; }
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
    write({ id: message.id, result: data });
    if (message.method === "initialize" && !process.env.EDT_AI_PROJECT_ROOT && message.params?.capabilities?.roots) requestRoots();
  } catch (error) { write({ id: message.id, error: { code: -32000, message: error.message } }); }
}
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", line => {
  try { const msg = JSON.parse(line); void dispatch(msg); }
  catch { write({ id: null, error: { code: -32700, message: "Parse error" } }); }
});

