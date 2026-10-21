import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fileURLToPath as rootFromUri } from "node:url";
import { SettingsOperations } from "./settings-operations.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const state = process.env.EDT_AI_STATE_DIR || path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "1c-ai-core");
const configPath = process.env.EDT_AI_SETTINGS || path.join(state, "settings.json");
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
function hasProfile(directory) {
  let current = path.resolve(directory);
  while (true) {
    if (fs.existsSync(path.join(current, ".ai/project.yaml"))) return true;
    if (fs.existsSync(path.join(current, ".git")) || path.dirname(current) === current) return false;
    current = path.dirname(current);
  }
}
if (!selectedRoot && hasProfile(process.cwd())) { selectedRoot = process.cwd(); rootLocked = true; }
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
  openvikingEnabled: { type: "boolean", title: "Флаг OpenViking", description: "Резерв конфигурации. Подключение OpenViking этим плагином ещё не реализовано.", readOnly: true },
  openvikingUrl: { type: "string", title: "URL OpenViking", description: "Сохранённое значение; соединение и поиск не выполняются.", readOnly: true },
};

function values(c) {
  return {
    projectRoot: c.active_project || "",
    edtUrl: c.mcp.required.edt.url, v8stdUrl: c.mcp.required.v8std.url,
    openvikingEnabled: Boolean(c.mcp.optional?.openviking?.enabled),
    openvikingUrl: c.mcp.optional?.openviking?.url || "",
  };
}
async function readValues() {
  // Python owns JSON/YAML loading, profile resolution and instance precedence.
  // The unconfigured screen remains dependency-free and does not create state.
  if (selectedRoot || fs.existsSync(configPath)) return backend("read", {});
  const defaults = JSON.parse(fs.readFileSync(path.join(root, "settings", "defaults.json"), "utf8"));
  return { values: values(defaults), instance: process.env.EDT_AI_INSTANCE || "default", preparationScope: null };
}
function readSettings(actual) {
  return {
    schema: { type: "object", properties: structuredClone(primitive) },
    values: actual.values, instance: actual.instance, connectionSources: actual.connectionSources,
    preparationScope: actual.preparationScope,
    projectSelection: { status: selectionError ? (pendingRoots ? "pending" : "ambiguous") : selectedRoot ? "selected" : "unselected",
      locked: rootLocked, detail: selectionError },
    layout: [
      { kind: "group", title: "Настройки проекта", items: [
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
const annotations = (readOnly = true) => ({ readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false });
const appOnly = { ui: { visibility: ["app"] } };
const appTool = { ui: { resourceUri: resource, visibility: ["app"] } };
const tools = [
  { name: "settings.read", title: "Настройки 1C AI Core", description: "Read plugin settings.",
    inputSchema: empty, outputSchema: { type: "object", required: ["schema", "values"],
      properties: { schema: { type: "object" }, values: { type: "object" }, layout: { type: "array" } } },
    annotations: annotations(), _meta: appOnly },
  { name: "settings.update", title: "Сохранить настройки", description: "Update changed plugin settings.",
    inputSchema: { type: "object", required: ["set"], properties: { set: {
      type: "object", properties: primitive, minProperties: 1, additionalProperties: false } }, additionalProperties: false },
    outputSchema: { type: "object", required: ["values"], properties: { values: { type: "object" } } },
    annotations: annotations(false), _meta: appOnly },
  ...[["settings.import", "Открыть импорт"], ["settings.export", "Открыть экспорт"]].map(([name, title]) => ({
    name, title, description: `${title}. This opens the settings screen; it does not import or export by itself.`,
    inputSchema: empty, annotations: annotations(), _meta: appTool,
  })),
  { name: "settings.preview", title: "Проверить файл", description: "Preview settings import without writing.",
    inputSchema: { type: "object", required: ["text"], properties: {
      text: { type: "string", maxLength: 2097152 }, projectRoot: { type: "string" } }, additionalProperties: false },
    annotations: annotations(), _meta: appOnly },
  { name: "settings.apply", title: "Импортировать", description: "Apply a reviewed settings import.",
    inputSchema: { type: "object", required: ["text", "revision"], properties: {
      text: { type: "string", maxLength: 2097152 }, projectRoot: { type: "string" },
      revision: { type: "string" }, replace: { type: "boolean" } }, additionalProperties: false },
    annotations: annotations(false), _meta: appOnly },
  { name: "settings.export_data", title: "Скачать настройки", description: "Export shared settings and tracked profile defaults; instance overrides stay local.",
    inputSchema: empty, annotations: annotations(), _meta: appOnly },
  { name: "settings.operation", title: "Состояние операции", description: "Read a running or completed settings operation without retrying it. Results belong to this MCP session and include their original project/instance.",
    inputSchema: { type: "object", properties: { operationId: { type: "string" } }, additionalProperties: false },
    annotations: annotations(), _meta: appTool },
  { name: "settings.check", title: "Подготовить и проверить MCP", description: "Open managed runtime preparation and protocol checks. Does not verify EDT/v8std or project behavior.",
    inputSchema: empty, annotations: { ...annotations(false), openWorldHint: true }, _meta: appTool },
];

function backend(action, args, context = { projectRoot: selectedRoot, selectedDirectory: selectedRoot, rootLocked, instance: process.env.EDT_AI_INSTANCE || "default" }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.EDT_AI_PYTHON || "python",
      [path.join(root, "scripts", "bootstrap.py"), "--backend"], {
        cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, EDT_AI_STATE_DIR: state, EDT_AI_SETTINGS: configPath,
          EDT_AI_PROJECT_ROOT: context.selectedDirectory || "", EDT_AI_SETTINGS_ROOT_LOCKED: context.rootLocked === false ? "0" : "1" },
      });
    let output = "", errors = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { errors = (errors + chunk).slice(-4000); process.stderr.write(chunk); });
    child.once("error", reject);
    child.stdin.on("error", () => {}); // close/output below owns the operation outcome
    child.once("close", code => {
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
      if (data.ok !== true) { reject(new Error(data.error || "Backend сообщил об ошибке.")); return; }
      if (code !== 0) {
        const error = new Error("Backend вернул результат, но завершился с ошибкой. Проверьте фактическое состояние перед повтором.");
        error.outcomeUnknown = true; reject(error); return;
      }
      resolve(data.result);
    });
    child.stdin.end(JSON.stringify({ action, ...args }));
  });
}
const operations = new SettingsOperations(backend);
function result(data, text = "Готово") {
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
  if (name === "settings.operation") return result({ ...operations.status(args.operationId), mode: "operation" });
  const readOnlyEntry = ["settings.read", "settings.import", "settings.export", "settings.check"].includes(name);
  if (selectionError && !readOnlyEntry) throw new Error(selectionError);
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
    return result(view, "Настройки 1C AI Core");
  }
  if (name === "settings.import" || name === "settings.export" || name === "settings.check") {
    const actual = await readValues();
    return result({ mode: name.split(".")[1], values: actual.values });
  }
  if (name === "settings.export_data") {
    if (!selectedRoot) throw new Error("Выберите папку проекта.");
    const data = await backend("export", args);
    return { content: [{ type: "text", text: "Файл настроек подготовлен." }], _meta: { data } };
  }
  const actions = { "settings.update": "update", "settings.preview": "preview", "settings.apply": "apply", "settings.run_check": "check" };
  if (!actions[name]) throw new Error("Неизвестный инструмент");
  if (name === "settings.run_check" && !selectedRoot) throw new Error("Выберите папку проекта.");
  // The backend resolves and authorizes the same root immediately before
  // preparation. A second path resolver here would disagree on profile/Git roots.
  const revision = selectionRevision;
  const proposedRoot = name === "settings.update" ? args.set.projectRoot : args.projectRoot;
  const context = { projectRoot: proposedRoot === undefined ? selectedRoot : proposedRoot || null,
    selectedDirectory: selectedRoot, rootLocked, instance: process.env.EDT_AI_INSTANCE || "default" };
  if (name === "settings.run_check") return result(operations.status(operations.start("check", args, context).id));
  const data = await (name === "settings.preview" ? backend(actions[name], args, context) : operations.execute(actions[name], args, context));
  if (revision === selectionRevision && !rootLocked && !selectionError && data.values && Object.hasOwn(data.values, "projectRoot")) {
    selectedRoot = data.values.projectRoot || null;
  }
  return result(data, name === "settings.apply" ? "Настройки импортированы." : "Готово");
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
  } else if (schema.type && typeof value !== schema.type) throw new Error("Некорректный тип настройки");
  if (schema.const !== undefined && value !== schema.const) throw new Error("Некорректное значение настройки");
  if (schema.enum && !schema.enum.includes(value)) throw new Error("Некорректное значение настройки");
  if (schema.minLength && value.trim().length < schema.minLength) throw new Error("Пустое значение настройки");
  if (schema.maxLength && value.length > schema.maxLength) throw new Error("Файл слишком большой");
}
tools.push({ name: "settings.run_check", title: "Подготовить и проверить MCP", description: "Start one managed runtime preparation/protocol operation after caller-supplied user authorization for launching the selected project services. Pass refresh=true only when an incompatible cached managed artifact must be downloaded again. Poll settings.operation with its id; do not repeat to wait for completion.",
  inputSchema: { type: "object", properties: {
    refresh: { type: "boolean" }, authorization: preparationAuthorization,
  }, required: ["authorization"], additionalProperties: false },
  annotations: { ...annotations(false), openWorldHint: true }, _meta: appOnly });

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
        if (!Array.isArray(entries)) throw new Error("missing roots");
        if (!entries.length) { selectedRoot = null; rootLocked = false; selectionError = null; finishRoots?.(); finishRoots = null; return; }
        const directories = [...new Set(entries.map(entry => {
          const uri = new URL(entry.uri);
          if (uri.protocol !== "file:" || !["", "localhost"].includes(uri.hostname)) throw new Error("not a local directory");
          return path.resolve(rootFromUri(uri));
        }))];
        const matching = directories.filter(directory => {
          const relative = path.relative(directory, process.cwd());
          return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
        });
        const directory = directories.length === 1 ? directories[0] : matching.length === 1 ? matching[0] : null;
        if (!directory) throw new Error("ambiguous roots");
        // The plugin's own directory is not a selected user repository.
        selectedRoot = path.resolve(directory) === root ? null : directory;
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
  // Project selection and operation ownership are connection-scoped. A modern
  // probe must trigger legacy fallback, not opt into stateless semantics that
  // this entrypoint cannot provide. Native settings discovery without modern
  // metadata remains available to the host after legacy initialization.
  const requested = message.params?._meta?.["io.modelcontextprotocol/protocolVersion"];
  if (requested && !protocols.includes(requested)) {
    write({ id: message.id, error: { code: -32601,
      message: "Session-scoped settings require the initialize handshake." } });
    return;
  }
  try {
    let data;
    if (message.method === "initialize") {
      const capability = { "openai/settings": { readTool: "settings.read", updateTool: "settings.update" } };
      data = { protocolVersion: protocols.includes(message.params?.protocolVersion) ? message.params.protocolVersion : protocols[0],
        serverInfo: { name: "1C AI Core Settings", version: "0.1.1" },
        capabilities: { tools: {}, resources: {}, experimental: capability, extensions: capability } };
    } else if (message.method === "server/discover") {
      data = { supportedVersions: protocols,
        _meta: { "io.modelcontextprotocol/serverInfo": { name: "1C AI Core Settings", version: "0.1.1" } },
        capabilities: { tools: {}, resources: {}, extensions: {
          "openai/settings": { readTool: "settings.read", updateTool: "settings.update" } } } };
    } else if (message.method === "ping") data = {};
    else if (message.method === "tools/list") data = { tools };
    else if (message.method === "tools/call") {
      try { data = await call(message.params.name, message.params.arguments || {}); }
      catch (error) { data = { isError: true, content: [{ type: "text", text: error.message }] }; }
    } else if (message.method === "resources/list") {
      data = { resources: [{ uri: resource, name: "Настройки 1C AI Core", mimeType: "text/html;profile=mcp-app" }] };
    } else if (message.method === "resources/read" && message.params?.uri === resource) {
      data = { contents: [{ uri: resource, mimeType: "text/html;profile=mcp-app",
        text: fs.readFileSync(path.join(root, "ui/settings.html"), "utf8"),
        _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } },
                 "openai/ui": { availableDisplayModes: ["inline"], preferredDisplayMode: "inline" } } }] };
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

