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
import { create_diagnostic_logger, register_diagnostic_secrets } from "../scripts/diagnostics.mjs";

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
  openvikingEnabled: { type: "boolean", title: "Флаг OpenViking", description: "Резерв конфигурации. Подключение OpenViking этим плагином ещё не реализовано.", readOnly: true },
  openvikingUrl: { type: "string", title: "URL OpenViking", description: "Сохранённое значение; соединение и поиск не выполняются.", readOnly: true },
};

function values(c) {
  return {
    projectRoot: c.active_project || "",
    edtUrl: c.mcp.required.edt.url, v8stdUrl: c.mcp.required.v8std.url,
    codeIndexEnabled: c.mcp.managed["code-index"].enabled !== false, bslLsEnabled: c.mcp.managed["bsl-ls"].enabled !== false,
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
    preparationScope: actual.preparationScope,
    profile: actual.profile, directoryContext: actual.directoryContext, sessionGuidance: actual.sessionGuidance,
    legacyState: actual.legacyState,
    profileHistory: actual.profileHistory || [], summary: actual.summary,
    configurationError: actual.configurationError,
    operation: operationSummary(),
    folderActions: { supported: process.platform === "win32" },
    projectSelection: { status: selectionError ? (pendingRoots ? "pending" : "ambiguous") : selectedRoot ? "selected" : "unselected",
      locked: rootLocked, detail: selectionError },
    layout: [
      { kind: "group", title: "Настройки проекта", items: [
        { kind: "tool", tool: "settings.open" },
        { kind: "tool", tool: "settings.profile" },
        { kind: "tool", tool: "settings.import" }, { kind: "tool", tool: "settings.export" },
        { kind: "property", property: "projectRoot" },
      ] },
      { kind: "group", title: "Подключения", items: [
        { kind: "property", property: "edtUrl" }, { kind: "property", property: "v8stdUrl" },
        { kind: "tool", tool: "settings.check" },
        { kind: "tool", tool: "settings.operation" },
      ] },
    ],
  };
}
function nativeSettings(actual) {
  const loaded = actual.profile?.status === "loaded";
  const fields = {
    selectedProfile: { type: "string", title: "Выбранный профиль", readOnly: true },
    profileDirectory: { type: "string", title: "Каталог профиля", readOnly: true },
    profileStatus: { type: "string", title: "Состояние профиля", readOnly: true },
    sharedSettings: { type: "string", title: "Общие параметры", readOnly: true },
  };
  return { schema: { type: "object", properties: fields }, values: {
    selectedProfile: actual.profile?.projectId || actual.profile?.profileId || "Профиль не выбран",
    profileDirectory: actual.values.projectRoot || "Выберите каталог в окне профилей",
    profileStatus: loaded ? `Профиль прочитан · репозиториев: ${actual.profile.repositories?.length || 0}`
      : actual.profile?.status === "invalid" ? "Ошибка профиля — откройте настройки для исправления" : "Выберите или создайте профиль",
    sharedSettings: "Версии и программы запуска компонентов общие для пользователя. Подключения и выбор компонентов зависят от каталога и экземпляра.",
  }, layout: [
    { kind: "group", title: "Профиль проекта", items: [
      { kind: "tool", tool: "settings.open" },
      ...["selectedProfile", "profileDirectory", "profileStatus"].map(property => ({ kind: "property", property })),
    ] },
    { kind: "group", title: "Область действия", items: [{ kind: "property", property: "sharedSettings" }] },
  ] };
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
  { name: "settings.native_read", title: "Сводка настроек", description: "Read the profile-first native settings landing page.",
    inputSchema: empty, outputSchema: { type: "object", required: ["schema", "values"], properties: { schema: { type: "object" }, values: { type: "object" }, layout: { type: "array" } } }, annotations: annotations(), _meta: appOnly },
  { name: "settings.select_profile", title: "Открыть профиль", description: "Explicitly select a directory in the settings app. Another chat's profile is read-only and never rebinds the current chat.",
    inputSchema: { type: "object", required: ["projectRoot"], properties: { projectRoot: { type: "string", minLength: 1 } }, additionalProperties: false }, annotations: annotations(false), _meta: appOnly },
  { name: "settings.status", title: "Сводное состояние профиля", description: "Passive profile and local daemon observation. Does not launch services or repeat preparation or probes.",
    inputSchema: { type: "object", properties: { projectRoot: { type: "string", minLength: 1 } }, additionalProperties: false }, annotations: annotations(), _meta: appOnly },
  { name: "settings.open", title: "Профили и настройки", description: "Open the manual settings form without launching services. Available from plugin apps/navigation and the plugin details page's native settings action.",
    inputSchema: empty, annotations: annotations(), _meta: { ...appTool, "openai/ui": { entrypoints: [{ type: "global" }] } } },
  { name: "settings.inspect", title: "Проверить настройку проекта", description: "Start chat setup here: compact profile validation, effective connections, detected EDT projects/port, managed preparation and next steps in one read-only call. Supply this chat's known projectRoot when host roots are empty. Do not read plugin source or reload an already loaded profile to diagnose setup.",
    inputSchema: inspectInput, annotations: annotations(), _meta: shared },
  { name: "settings.probe_connections", title: "Проверить EDT и v8std", description: "One read-only external connection test, including exact EDT repository paths/readiness when list_projects is exposed. Does not download or launch services. Returns an operation ID: poll settings.operation with waitMs=10000; never repeat to wait. This acceptance is separate from current chat relay binding.",
    inputSchema: empty, annotations: { ...annotations(), openWorldHint: true }, _meta: shared },
  { name: "settings.profile", title: "Профиль текущего чата", description: "Open the profile settings screen with directory context. For chat setup use the compact settings.inspect instead; an already loaded profile needs no reload. Does not launch services or borrow another chat's directory.",
    inputSchema: empty, annotations: annotations(), _meta: appTool },
  ...[["settings.create", "Создать профиль", "Create the generic .ai/project.yaml and missing project instructions in this chat's selected repository, only when the user requests creation. Never overwrites a profile or existing instructions. Repository mappings still need configuration."],
      ["settings.load", "Загрузить профиль", "Validate and reload the existing .ai/project.yaml for this chat's selected repository. Does not import a file or launch services. Report sessionGuidance; if the host does not refresh tools, ask the user to open a new chat in the same directory or restart Codex."]].map(([name, title, description]) => ({
    name, title, description, inputSchema: { type: "object", properties: { projectRoot: { type: "string", minLength: 1, description: "Only for an unbound settings screen. A chat's selected root cannot be changed." } }, additionalProperties: false },
    annotations: annotations(false), _meta: appTool,
  })),
  { name: "settings.read", title: "Настройки 1C AI Core", description: "Read plugin settings.",
    inputSchema: empty, outputSchema: { type: "object", required: ["schema", "values"],
      properties: { schema: { type: "object" }, values: { type: "object" }, layout: { type: "array", items: { type: "object" } } } },
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
    name, title, description: `${title}. This opens the settings screen; it does not import or export by itself.`,
    inputSchema: empty, annotations: annotations(), _meta: appTool,
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
  { name: "settings.export_diagnostics", title: "Скачать диагностику", description: "Download a bounded, redacted support report from the settings app only. Works without a profile and during a running operation. Does not contact services or upload data.",
    inputSchema: empty, annotations: annotations(), _meta: appOnly },
  { name: "settings.edit", title: "Загрузить настройки для редактирования", description: "Read the complete profile and shared runtime document with a baseRevision. Save edits through settings.preview/apply with mode=edit and that baseRevision; omitted runtime fields reset to defaults, unchanged profiles are not rewritten.",
    inputSchema: empty, annotations: annotations(), _meta: shared },
  { name: "settings.operation", title: "Состояние операции", description: "Read a running or completed settings operation without retrying it. Results belong to this MCP session and include their original project/instance.",
    inputSchema: { type: "object", properties: { operationId: { type: "string" }, waitMs: { type: "integer", minimum: 0, maximum: 10000, description: "Wait for this operation to finish, up to 10 seconds. Prefer a bounded wait over repeated immediate polls." } }, additionalProperties: false },
    annotations: annotations(), _meta: appTool },
  { name: "settings.check", title: "Подготовить и проверить MCP", description: "Open managed runtime preparation and protocol checks. Does not verify EDT/v8std or project behavior.",
    inputSchema: empty, annotations: { ...annotations(false), openWorldHint: true }, _meta: appTool },
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
        const error = new Error(`Backend завершился без результата (${code}). Исход операции неизвестен; проверьте настройки и runtime перед повтором. ${errors}`);
        error.outcomeUnknown = true;
        reject(error); return;
      }
      if (!data || typeof data !== "object" || Array.isArray(data) || typeof data.ok !== "boolean" ||
          (data.ok && (!data.result || typeof data.result !== "object" || Array.isArray(data.result)))) {
        const error = new Error("Backend вернул некорректный ответ. Исход операции неизвестен; проверьте фактическое состояние перед повтором.");
        error.outcomeUnknown = true; reject(error); return;
      }
      if (data.ok !== true) { const error = new Error(data.error || "Backend сообщил об ошибке."); error.code = data.errorCode; error.outcomeUnknown = data.outcomeUnknown === true; reject(error); return; }
      if (code !== 0) {
        const error = new Error("Backend вернул результат, но завершился с ошибкой. Проверьте фактическое состояние перед повтором.");
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
  const data = await backend("read", {}, { selectedDirectory: directory, rootLocked: false });
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
async function call(name, args) {
  if (pendingRoots) await new Promise(resolve => {
    const timer = setTimeout(resolve, 3000);
    rootReady.then(() => { clearTimeout(timer); resolve(); });
  });
  const definition = tools.find(item => item.name === name);
  if (!definition) throw new Error("Неизвестный инструмент");
  validateArguments(definition.inputSchema, args);
  if (name === "settings.export_diagnostics") {
    diagnostic.event("support_export_requested", { projectRoot: selectedRoot });
    const { support_bundle } = await import("../scripts/support_bundle.mjs");
    const context = { selectedDirectory: selectedRoot, rootLocked };
    const data = await support_bundle({ state, configPath, selectedRoot,
      selection: { rootLocked, selectionError, pendingRoots }, operation: operations.status(), loggerStatus: diagnostic.status(),
      readCurrent: () => backend("read", {}, context, 8000) });
    // File bytes stay in app metadata and never enter model-visible content.
    return { content: [{ type: "text", text: "Диагностический файл подготовлен." }], _meta: { data } };
  }
  if (name === "settings.operation") {
    await operations.wait(args.operationId, args.waitMs || 0);
    const operation = operations.status(args.operationId);
    return result({ ...operation, mode: "operation" }, `${operation.status}${operation.id ? " · " + operation.id : ""}${operation.error ? ": " + operation.error : ""}`);
  }
  const readOnlyEntry = ["settings.inspect", "settings.read", "settings.native_read", "settings.status", "settings.open", "settings.profile", "settings.import", "settings.export", "settings.check"].includes(name);
  if (name === "settings.native_read") return result(nativeSettings(await readValues()));
  if (name === "settings.status" || name === "settings.select_profile") {
    if (name === "settings.select_profile" && operations.status().status === "running") throw new Error("Дождитесь завершения текущей операции.");
    const revision = selectionRevision, directory = args.projectRoot || selectedRoot;
    const actual = await backend(name === "settings.status" ? "status" : "read", { remember: name === "settings.select_profile" },
      { selectedDirectory: directory, rootLocked: false });
    if (revision !== selectionRevision) throw new Error("Папка чата изменилась. Выберите профиль заново.");
    const current = rootLocked ? await readValues() : null;
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
  if (name === "settings.inspect") {
    if (operations.status().status === "running" && args.projectRoot !== undefined && !selectedRoot)
      throw new Error("Операция ещё выполняется. Проверьте settings.operation перед выбором папки.");
    const selection = explicit_selection({ directory: selectedRoot }, args.projectRoot, selectionError);
    if (selection.directory !== selectedRoot) { selectedRoot = selection.directory; selectionRevision += 1; }
    if (args.projectRoot !== undefined) rootLocked = true;
    const read = await readValues();
    const { setup_inspection } = await import("../scripts/setup_inspection.mjs");
    const snapshot = setup_inspection({ ...read, projectSelection: { status: selectionError ? (pendingRoots ? "pending" : "ambiguous") : selectedRoot ? "selected" : "unselected", locked: rootLocked, detail: selectionError }, operation: operationSummary() }, state);
    return result(snapshot, `Профиль: ${snapshot.profile.status}. Следующие шаги: ${snapshot.nextSteps.join(", ") || "нет"}.`);
  }
  if (selectionError && !readOnlyEntry) throw new Error(selectionError);
  if (operations.status().status === "running" && !readOnlyEntry) throw new Error(
    operations.status().action === "pick_directory"
      ? "Дождитесь завершения выбора папки. Завершите или отмените выбор в системном окне; состояние доступно в settings.operation."
      : "Операция ещё выполняется. Состояние доступно в settings.operation; повтор не запущен.");
  if (name === "settings.probe_connections") {
    if (!selectedRoot) throw new Error("Выберите папку проекта через settings.inspect с projectRoot.");
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
        view.schema.properties[name === "edt" ? "edtUrl" : "v8stdUrl"] = {
          ...primitive[name === "edt" ? "edtUrl" : "v8stdUrl"], readOnly: true,
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
    return result({ ...view, mode: "profile" }, JSON.stringify({ profile: view.profile, directoryContext: view.directoryContext, projectRoot: view.values.projectRoot, instance: view.instance, projectSelection: view.projectSelection, sessionGuidance: view.sessionGuidance }));
  }
  if (name === "settings.import" || name === "settings.export" || name === "settings.check") {
    const actual = await readValues();
    return result({ mode: name.split(".")[1], values: actual.values });
  }
  if (name === "settings.export_data" || name === "settings.edit") {
    if (!selectedRoot) throw new Error("Выберите папку проекта.");
    const data = await backend(name === "settings.edit" ? "edit" : "export", args);
    return { ...result(data), _meta: { data } };
  }
  const actions = { "settings.update": "update", "settings.preview": "preview", "settings.apply": "apply", "settings.run_check": "check", "settings.updates": "updates", "settings.create": "create", "settings.load": "load" };
  if (!actions[name]) throw new Error("Неизвестный инструмент");
  if (name === "settings.run_check" && !selectedRoot) throw new Error("Выберите папку проекта.");
  // The backend resolves and authorizes the same root immediately before
  // preparation. A second path resolver here would disagree on profile/Git roots.
  const revision = selectionRevision;
  const proposedRoot = name === "settings.update" ? args.set.projectRoot : args.projectRoot;
  const context = { projectRoot: proposedRoot === undefined ? selectedRoot : proposedRoot || null,
    selectedDirectory: selectedRoot, rootLocked, instance: process.env.EDT_AI_INSTANCE || "default" };
  if (name === "settings.run_check") return result(operations.status(operations.start("check", args, context).id));
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
tools.push({ name: "settings.run_check", title: "Подготовить и проверить MCP", description: "Start one managed runtime preparation/protocol operation after caller-supplied user authorization for launching the selected project services. Pass refresh=true only when an incompatible cached managed artifact must be downloaded again. Poll settings.operation with its id; do not repeat to wait for completion.",
  inputSchema: { type: "object", properties: {
    refresh: { type: "boolean" }, authorization: preparationAuthorization,
  }, required: ["authorization"], additionalProperties: false },
  annotations: { ...annotations(false), openWorldHint: true }, _meta: shared });
tools.push({ name: "settings.updates", title: "Обновления компонентов", description: "Check upstream stable releases without restarting services, download a separate candidate, apply it after live protocol validation, or roll back to the previous artifact. Mutating operations require scoped authorization. Poll settings.operation; do not retry a running operation.",
  inputSchema: { type: "object", properties: {
    operation: { enum: ["check", "download", "apply", "rollback"] },
    component: { enum: ["code-index", "bsl-ls"] }, authorization: preparationAuthorization,
  }, required: ["operation"], additionalProperties: false },
  annotations: { ...annotations(false), openWorldHint: true }, _meta: shared });
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
      } catch { selectedRoot = null; selectionError = "Выберите один локальный каталог проекта; неоднозначные roots блокируют изменение настроек."; }
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
      const capability = { "openai/settings": { readTool: "settings.native_read", updateTool: "settings.update" } };
      data = { protocolVersion: protocols.includes(message.params?.protocolVersion) ? message.params.protocolVersion : protocols[0],
        instructions: "Start chat setup with settings.inspect once; include this chat's known local projectRoot when the host supplied no directory. Reuse its validation, connection sources and nextSteps. Do not reload an already loaded profile, inspect plugin source, spawn substitute relays or restart chats for empty roots. Create only a missing profile on user request. Preparation needs scoped user authorization. Never select another chat's root.",
        serverInfo: { name: "1C AI Core Settings", version: core_version, icons: plugin_icons() },
        capabilities: { tools: {}, resources: {}, experimental: capability, extensions: capability } };
    } else if (message.method === "server/discover") {
      data = { resultType: "complete", supportedVersions: protocols,
        _meta: { "io.modelcontextprotocol/serverInfo": { name: "1C AI Core Settings", version: core_version } },
        capabilities: { tools: {}, resources: {}, extensions: {
          "openai/settings": { readTool: "settings.native_read", updateTool: "settings.update" } } } };
    } else if (message.method === "ping") data = {};
    else if (message.method === "tools/list") data = { tools };
    else if (message.method === "tools/call") {
      try { data = await call(message.params.name, message.params.arguments || {}); }
      catch (error) { diagnostic.event("request_failed", { tool: message.params?.name, projectRoot: selectedRoot, error }, "error"); data = { isError: true, content: [{ type: "text", text: error.message }] }; }
    } else if (message.method === "resources/list") {
      data = { resources: [{ uri: resource, name: "Настройки 1C AI Core", mimeType: "text/html;profile=mcp-app" }] };
    } else if (message.method === "resources/read" && message.params?.uri === resource) {
      data = { contents: [{ uri: resource, mimeType: "text/html;profile=mcp-app",
        text: fs.readFileSync(path.join(root, "ui/settings.html"), "utf8").replaceAll("__CORE_VERSION__", core_version),
        _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } },
                 "openai/ui": { availableDisplayModes: ["inline", "fullscreen"], preferredDisplayMode: "fullscreen" } } }] };
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

