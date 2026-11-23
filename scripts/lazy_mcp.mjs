// Connection-owned binding. Control messages never wait for a running tool.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { ROOT, ConfigError, settings, stable, argumentsOf, object } from "./common.mjs";
import {
  state_root,
  exists,
  reconnect_file,
  instance_name,
  sha256,
  locate_project,
} from "./project_paths.mjs";
import { effective_settings } from "./project_context.mjs";
import { project_profile } from "./profile.mjs";
import { McpClient } from "./mcp_client.mjs";
import { all_pages } from "./mcp_pages.mjs";
import {
  RemoteMcp,
  RemoteSessionExpired,
} from "./remote_client.mjs";
import { validate_bsl_tools, project_home, read_json } from "./runtime.mjs";
import { pin_windows_process } from "./windows_process.mjs";
import { linux_process_identity, pin_linux_process } from "./unix_process.mjs";
import { component_icons } from "./icons.mjs";
import { launch_selection, roots_selection, explicit_selection } from "./selection.mjs";
import { COMPONENTS, component_settings, component_enabled, binding_fingerprint, require_preparation, native_environment } from "./components.mjs";
import { index_repositories } from "./directory_context.mjs";
import { read_lines } from "./mcp_codec.mjs";
import { core_version } from "./compatibility.mjs";
import { Ajv, Ajv2019, Ajv2020, draft6MetaSchema } from "../vendor/deps.mjs";
import { create_diagnostic_logger, register_diagnostic_secrets, safe_error_message, connection_failure } from "./diagnostics.mjs";
import { knowledge_status, WORKFLOW_ACTIONS } from "./knowledge.mjs";
import { WorkflowKnowledge } from "./openviking_adapter.mjs";

const component = argumentsOf(undefined, [], ["component"]).component;
if (!Object.hasOwn(COMPONENTS, component))
  throw new ConfigError("Invalid --component");
if (COMPONENTS[component].adapter)
  throw new ConfigError(component + " requires its dedicated restricted adapter; native relay disclosure is not permitted");
const state = state_root(),
  configuration =
    process.env.EDT_AI_SETTINGS || path.join(state, "settings.json");
const diagnostic = create_diagnostic_logger(component, state);
const workflowKnowledge = new WorkflowKnowledge();
process.on("uncaughtExceptionMonitor", error => diagnostic.event("uncaught_exception", { error }, "error"));
let client = null,
  currentRevision = null,
  failedRevision = null,
  catalogue = null,
  toolsRefresh = null,
  toolsetRevision = 0,
  bindingContext = null,
  connectingClient = null,
  daemonPin = null;
let boundAliases = new Set();
const nativeValidators = new Map();
const retiredClients = new Set();
let selection = launch_selection();
let selected = selection.directory,
  selectionError = null,
  rootsPending = null,
  rootsCounter = 0,
  initialized = false,
  discoveryNotificationPending = false,
  requestInitialRoots = false;
let lastError = "Выберите каталог проекта с .ai/project.yaml.";
let lastFailure = null;
let lastHostToolsObservation = null;
if (selected) diagnostic.event("session_started", { version: core_version, projectRoot: selected, node: process.version });
let rootsReady = Promise.resolve(), finishRoots = null;
let closed = false;
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const emit = (message) => {
  if (!closed) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
};
function notifyDiscoveryChanged() {
  if (closed) return;
  if (!initialized) { discoveryNotificationPending = true; return; }
  discoveryNotificationPending = false;
  emit({ method: "notifications/resources/list_changed" });
  emit({ method: "notifications/prompts/list_changed" });
}
async function disconnect({ preserveResponses = false } = {}) {
  generation++;
  stopIdlePolling();
  const knowledgeClosing = workflowKnowledge.close();
  const previous = client;
  const previousBinding = bindingContext;
  const previousDaemon = daemonPin;
  daemonPin = null;
  if (previous) diagnostic.event("disconnected", { projectRoot: selected, binding: bindingContext });
  const connecting = connectingClient;
  connectingClient = null;
  client = null;
  catalogue = null;
  toolsRefresh = null;
  toolsetRevision = 0;
  bindingContext = null;
  boundAliases.clear();
  nativeValidators.clear();
  if (previous) notifyDiscoveryChanged();
  try {
    const responses = preserveResponses && previous instanceof RemoteMcp ? previous.pendingResponses() : [];
    if (responses.length) {
      // A server can retire a session while still answering admitted requests.
      retiredClients.add(previous);
      void Promise.allSettled(responses).then(() => previous.close()).catch(error => {
        diagnostic.event("connection_cleanup_unconfirmed", { projectRoot: previousBinding?.projectRoot, error }, "error");
      }).finally(() => retiredClients.delete(previous));
    } else if (previous) await previous.close();
    if (connecting && connecting !== previous) await connecting.close();
  } finally {
    previousDaemon?.close();
    await knowledgeClosing;
  }
}
async function requestRoots() {
  finishRoots?.();
  rootsReady = new Promise(resolve => { finishRoots = resolve; });
  selected = null;
  selectionError = "Ожидается выбранный каталог проекта.";
  const id = "core-roots-" + ++rootsCounter;
  rootsPending = id;
  await disconnect();
  currentRevision = null;
  if (rootsPending === id) emit({ id, method: "roots/list", params: {} });
}
async function waitForRoots() {
  if (!rootsPending) return;
  let timer;
  try { await Promise.race([rootsReady, new Promise(resolve => { timer = setTimeout(resolve, 3000); })]); }
  finally { clearTimeout(timer); }
}
function configContext() {
  const config = settings(configuration);
  config.state_dir = state;
  if (selectionError) throw new ConfigError(selectionError);
  const directory = selected;
  if (!directory) throw new ConfigError("Выберите каталог проекта с .ai/project.yaml.");
  const root = locate_project(directory),
    data = project_profile(root);
  return [
    root,
    effective_settings(config, root, data, null, state),
    data,
  ];
}
async function checkKnowledgeWorkflow(action = "workflow") {
  const [root, config, profile] = configContext(), epoch = generation;
  const expected = stable([root, config, profile]);
  const validate = () => {
    if (epoch !== generation || expected !== stable(configContext())) throw new ConfigError("Knowledge workflow binding changed; repeat readiness");
  };
  await workflowKnowledge.require(profile, config, root, action, validate);
  validate();
  return () => { validate(); return workflowKnowledge.check(profile, config, action); };
}
const catalogueRevision = owner => `${owner.tools_revision}:${toolsetRevision}`;
const catalogueIsCurrent = owner => !toolsRefresh && catalogue?.revision === catalogueRevision(owner);
const sessionExpired = error => error instanceof RemoteSessionExpired || error?.cause instanceof RemoteSessionExpired;
async function readNativeCatalogue(owner, epoch) {
  const revision = catalogueRevision(owner);
  let tools;
  try { ({ tools } = await all_pages(owner, "tools/list", "tools")); }
  catch (error) {
    if (epoch !== generation) throw new ConfigError("Project binding changed while refreshing tools");
    throw error;
  }
  if (epoch !== generation)
    throw new ConfigError("Project binding changed while refreshing tools");
  if (revision !== catalogueRevision(owner))
    throw new ConfigError("Native catalogue changed during discovery; request current schemas");
  return { tools, revision };
}
async function refreshTools() {
  if (toolsRefresh) return toolsRefresh;
  const epoch = generation;
  const refresh = readNativeCatalogue(client, epoch).then(snapshot => {
    if (epoch !== generation) throw new ConfigError("Project binding changed while refreshing tools");
    // Identical definitions keep in-flight schema and annotation checks valid.
    if (isDeepStrictEqual(snapshot.tools, catalogue?.tools)) snapshot.tools = catalogue.tools;
    catalogue = snapshot;
    return snapshot;
  }).catch(error => {
    // A partial tools/list can already have changed the transport's schema-derived headers.
    if (epoch === generation) catalogue = null;
    throw error;
  });
  toolsRefresh = refresh;
  try { return await refresh; } finally { if (toolsRefresh === refresh) toolsRefresh = null; }
}
function currentCatalogue() {
  return catalogueIsCurrent(client) ? catalogue : refreshTools();
}
let bindingPromise = null, generation = 0, hostCapabilities = {}, callbackSequence = 0;
let failedAttempts = 0, retryAfter = 0;
const callbacks = new Map(), requests = new Map();
const requestKey = id => typeof id + ":" + id;
function callback(message, { signal } = {}) {
  if (closed) return Promise.reject(new Error("Host disconnected"));
  if (signal?.aborted) return Promise.reject(signal.reason);
  const id = "core-callback-" + ++callbackSequence;
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true; clearTimeout(timer); callbacks.delete(id); signal?.removeEventListener("abort", aborted);
      error ? reject(error) : resolve(value);
    };
    const aborted = () => finish(signal.reason || new Error("Connection closed"));
    const timer = setTimeout(() => finish(new Error("Host callback timed out")), 60000);
    callbacks.set(id, reply => reply.error ? finish(Object.assign(new Error(reply.error.message), { code: reply.error.code })) : finish(null, reply.result));
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) return aborted();
    try { emit({ ...message, id }); } catch (error) { finish(error); }
  });
}
async function ensureBinding(retryFailed = true, connect = true) {
  if (closed) throw new Error("Host disconnected");
  if (bindingPromise) {
    // Join the in-flight attempt. Revalidate after it finishes, but never let
    // each waiter repeat the same failed launch.
    await bindingPromise.catch(() => {});
    return ensureBinding(false, connect);
  }
  const next = bind(retryFailed, connect);
  bindingPromise = next;
  try { await next; } finally { if (bindingPromise === next) bindingPromise = null; }
}
async function bind(retryFailed, connect) {
  if (closed) return;
  if (rootsPending) return;
  let revision = null, stage = "configuration";
  try {
    const [root, config, profile] = configContext(),
      token = reconnect_file(state, root);
    const options = component_settings(config, component);
    register_diagnostic_secrets(config);
    const reconnect = exists(token) ? JSON.parse(fs.readFileSync(token, "utf8")) : {};
    revision = binding_fingerprint(config, component, root, profile, reconnect[component] || reconnect.id || "");
    if (revision === failedRevision && !retryFailed) return;
    if (revision === failedRevision && retryAfter > Date.now()) {
      await new Promise(resolve => setTimeout(resolve, retryAfter - Date.now()));
      // Re-read the project, grant and effective configuration after waiting.
      return bind(retryFailed, connect);
    }
    if (client && daemonPin && !daemonPin.alive()) {
      // Let calls already dispatched through this connection finish. A new
      // request then reconnects and the managed launcher coordinates recovery.
      while (!closed && [...requests.values()].some(request => request.client === client))
        await new Promise(resolve => setTimeout(resolve, 25));
      await disconnect();
      if (closed) return;
      return bind(retryFailed, connect);
    }
    if (client && !client.error && revision === currentRevision) return;
    if (component === "code-index" && client && !client.error && revision !== currentRevision) {
      // A maintenance signal or configuration change must not abort a native
      // request that was already sent. Re-read the binding after it drains.
      const previous = client;
      if ([...requests.values()].some(request => request.client === previous)) {
        while (!closed && client === previous && [...requests.values()].some(request => request.client === previous))
          await new Promise(resolve => setTimeout(resolve, 25));
        if (closed) return;
        return bind(retryFailed, connect);
      }
    }
    await disconnect();
    if (closed) return;
    if (!component_enabled(config, component)) throw new ConfigError("Компонент отключён в настройках.");
    if (!connect) { if (revision !== failedRevision) lastError = "Компонент не подключён. Откройте его инструменты после подготовки MCP."; return; }
    currentRevision = revision;
    const epoch = generation;
    let stderrObserved = false;
    let candidate, url;
    const ownsBinding = () => !closed && epoch === generation && (candidate === client || candidate === connectingClient);
    const transportOptions = { capabilities: { ...hostCapabilities, roots: { listChanged: false } },
      onRequest: async (message, context) => {
        if (!ownsBinding()) throw new ConfigError("Project binding changed before native callback");
        if (message.method === "roots/list")
          return { roots: component === "v8std" ? [] : [{ uri: pathToFileURL(root).href, name: path.basename(root) }] };
        const reply = await callback(message, context);
        if (!ownsBinding()) throw new ConfigError("Project binding changed during native callback");
        return reply;
      },
      maxBytes: options.max_response_bytes,
      onStderr: () => { if (!stderrObserved) { stderrObserved = true; diagnostic.event("runtime_stderr", { projectRoot: root }); } },
      onNotification: message => {
        if (message.method !== "notifications/tools/list_changed" && candidate === client && ownsBinding()) emit(message);
      } };
    // The remote standards corpus has no need for local project directories.
    if (component === "v8std") delete transportOptions.capabilities.roots;
    if (COMPONENTS[component].kind === "remote" || options.mode === "external") {
      url = options.url;
      if (!url)
        throw new ConfigError(
          `Укажите connections.${component}.url в профиле проекта.`,
        );
      candidate = new RemoteMcp(url, options.timeout_seconds || (component === "v8std" ? 60 : 30), { ...transportOptions, headers_env: options.headers_env });
    } else {
      stage = "preparation";
      require_preparation(state, root, component);
      candidate = new McpClient(
        [
          process.execPath,
          path.join(ROOT, "scripts/managed_mcp.mjs"),
          "--component",
          component,
        ],
        root,
        {
          ...native_environment(config),
          EDT_AI_STATE_DIR: state,
          EDT_AI_SETTINGS: configuration,
          EDT_AI_PROJECT_ROOT: root,
        },
        180,
        transportOptions,
      );
    }
    try {
      connectingClient = candidate;
      stage = "initialize";
      await candidate.initialize();
      stage = "tools/list";
      const snapshot = await readNativeCatalogue(candidate, epoch);
      stage = "native_validation";
      if (component === "bsl-ls") validate_bsl_tools(snapshot.tools);
      if (epoch !== generation || closed) throw new ConfigError("Project binding changed while connecting");
      catalogue = snapshot;
    } catch (error) {
      await candidate.close();
      currentRevision = null;
      throw error;
    }
    client = candidate;
    if (component === "code-index" && options.mode !== "external" && ["win32", "linux"].includes(process.platform)) {
      const owner = read_json(path.join(project_home(state, root), "code-index", "owner.json"), {});
      if (owner.pid) {
        const pinned = process.platform === "win32" ? pin_windows_process(owner.pid) : pin_linux_process(owner.pid);
        const creation = process.platform === "win32" ? pinned.created : linux_process_identity(owner.pid);
        if (!pinned.alive() || !creation || owner.creation && creation !== owner.creation) { pinned.close(); throw new ConfigError("Демон индекса изменился во время подключения."); }
        daemonPin = pinned;
      }
    }
    boundAliases = new Set((component === "code-index" ? index_repositories(root, profile) : profile.repositories).map(repo => repo.alias));
    connectingClient = null;
    failedRevision = null;
    failedAttempts = 0;
    retryAfter = 0;
    lastError = "";
    lastFailure = null;
    bindingContext = {
        projectRoot: root,
        instance: instance_name(),
        endpoint: url,
        connectionId: randomUUID().replaceAll("-", ""),
        revision: sha256(revision),
      };
    diagnostic.event("connected", { binding: bindingContext, tools: catalogue.tools.length,
      server: candidate.initialization?.serverInfo, protocol: candidate.initialization?.protocolVersion });
    startIdlePolling();
    notifyDiscoveryChanged();
  } catch (error) {
    await disconnect();
    failedAttempts = revision !== null && revision === failedRevision ? failedAttempts + 1 : 1;
    retryAfter = Date.now() + Math.min(5000, 250 * 2 ** Math.min(failedAttempts - 1, 5));
    failedRevision = revision;
    if (revision === null) currentRevision = null;
    if (lastError !== safe_error_message(error)) diagnostic.event("connection_failed", { projectRoot: selected, phase: stage, error }, "error");
    lastError = safe_error_message(error);
    lastFailure = { stage, ...connection_failure(error, ["configuration", "preparation"].includes(stage) ? "configuration" : stage === "initialize" ? "transport" : "server_contract") };
  }
}
const statusTool = () => ({
  name: "core_runtime_status",
  icons: component_icons(component),
  title: "Состояние " + component,
  description:
    component === "v8std"
      ? "Read the selected profile binding and negotiated server instructions/capabilities. Reuse until the binding or contract changes."
      : "Read the selected binding's state and server contract. Managed services require preparation permission for this project and instance.",
  inputSchema: { type: "object", properties: {
    projectRoot: { type: "string", minLength: 1, description: "Current chat's project directory when host roots are empty; binds only this session." },
  }, additionalProperties: false },
  annotations: { readOnlyHint: COMPONENTS[component].kind === "remote", destructiveHint: false },
});
const rootProperty = () => statusTool().inputSchema.properties.projectRoot;
const controlTools = () => [statusTool(), {
  name: "core_runtime_tools",
  title: "Живой API " + component,
  description: "Read live native tool schemas and annotations. Use exact names to reuse the binding's catalogue, or detail=names when names are unknown. Use refresh=true after external catalogue changes. With empty roots supply this chat's projectRoot; it cannot override the session binding.",
  inputSchema: { type: "object", properties: {
    projectRoot: rootProperty(),
    names: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 32, uniqueItems: true },
    detail: { type: "string", enum: ["full", "names"], description: "Return full definitions (default) or only native tool names." },
    refresh: { type: "boolean", description: "Refresh the catalogue. By default refresh unfiltered queries and cache misses." },
  }, additionalProperties: false },
  annotations: { readOnlyHint: COMPONENTS[component].kind === "remote", destructiveHint: false },
}, {
  name: "core_runtime_call",
  title: "Вызов native API " + component,
  description: "Call native tools sequentially in one binding. Failures and top-level isError stop the group without rollback. Inspect native results and item errors before dependent calls. Never retry an unknown outcome. " + (component === "v8std" ? "Configuration authorizes native v8std operations and sending task code and context. Do not request additional v8std permission. Host approval and independent project actions are separate. " : "Apply native annotations, source workflow and action policy to every call. ") + "With empty roots supply this chat's projectRoot.",
  inputSchema: { type: "object", properties: {
    projectRoot: rootProperty(),
    calls: { type: "array", minItems: 1, maxItems: 16, items: {
      type: "object", properties: { name: { type: "string", minLength: 1 }, arguments: { type: "object", additionalProperties: true } },
      required: ["name", "arguments"], additionalProperties: false,
    } },
    workflowAction: { type: "string", enum: WORKFLOW_ACTIONS, description: "Current task phase; omission conservatively checks all mandatory knowledge dependencies. Does not grant action permission." },
    compact: { type: "boolean", description: "Keep one copy of native data in structuredContent.results. Omit for top-level media rendering." },
  }, required: ["calls"], additionalProperties: false },
  // Actual effects belong to the selected native operations, not this envelope.
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
}];
function controlArguments(name, args) {
  const allowed = name === "core_runtime_tools" ? ["projectRoot", "names", "detail", "refresh"] : name === "core_runtime_call" ? ["projectRoot", "calls", "workflowAction", "compact"] : ["projectRoot"];
  if (!object(args) || Object.keys(args).some(key => !allowed.includes(key))) throw new ConfigError("Invalid runtime control arguments");
  if (args.workflowAction !== undefined && !WORKFLOW_ACTIONS.includes(args.workflowAction)) throw new ConfigError("Invalid workflow action");
  if (args.detail !== undefined && !["full", "names"].includes(args.detail)) throw new ConfigError("Invalid runtime tool detail");
  if (args.refresh !== undefined && typeof args.refresh !== "boolean") throw new ConfigError("refresh must be a boolean");
  if (args.compact !== undefined && typeof args.compact !== "boolean") throw new ConfigError("compact must be a boolean");
  if (args.names !== undefined && (!Array.isArray(args.names) || !args.names.length || args.names.length > 32 || args.names.some(name => typeof name !== "string" || !name) || new Set(args.names).size !== args.names.length))
    throw new ConfigError("names must contain 1 to 32 unique native tool names");
  if (name === "core_runtime_call" && (!Array.isArray(args.calls) || !args.calls.length || args.calls.length > 16 || args.calls.some(call => !object(call) || typeof call.name !== "string" || !call.name || !object(call.arguments) || Object.keys(call).some(key => !["name", "arguments"].includes(key)))))
    throw new ConfigError("calls must contain 1 to 16 native tools with object arguments");
}
function checkIndexSelector(args, schema) {
  if (component !== "code-index") return;
  const repo = Object.hasOwn(args, "repo"), repos = Object.hasOwn(args, "repos");
  const properties = schema?.properties ?? {};
  if (repo && repos) throw new ConfigError("Use either repo or repos, not both");
  if (repo && !boundAliases.has(args.repo))
    throw new ConfigError("code-index alias is outside the selected project profile");
  if (repo && !Object.hasOwn(properties, "repo"))
    throw new ConfigError("Native code-index schema does not advertise repo");
  if (repos) {
    if (!Object.hasOwn(properties, "repos"))
      throw new ConfigError("Native code-index schema does not advertise repos");
    if (!Array.isArray(args.repos) || !args.repos.length || args.repos.some(alias => !boundAliases.has(alias)))
      throw new ConfigError("code-index repos must contain only exact aliases from the selected project profile");
  }
  // A managed reader's default comes from the selected project's daemon.
  // An external server may have a default outside the profile.
  if (!repo && !repos && bindingContext.endpoint && (Object.hasOwn(properties, "repo") || Object.hasOwn(properties, "repos")))
    throw new ConfigError("External code-index requires an explicit repository selector");
}
function validateNative(call, availableTools) {
  const tool = availableTools.find(tool => tool.name === call.name);
  if (!tool || controlTools().some(tool => tool.name === call.name)) throw new ConfigError("Unknown native tool: " + call.name);
  const schema = tool.inputSchema, key = stable(schema);
  checkIndexSelector(call.arguments, schema);
  if (!nativeValidators.has(key)) {
    const dialect = schema?.$schema;
    const options = { allErrors: true, strict: false, ownProperties: true, validateFormats: false };
    let compiler;
    if (dialect === undefined || ["https://json-schema.org/draft/2020-12/schema", "https://json-schema.org/draft/2020-12/schema#"].includes(dialect)) compiler = new Ajv2020(options);
    else if (["https://json-schema.org/draft/2019-09/schema", "https://json-schema.org/draft/2019-09/schema#"].includes(dialect)) compiler = new Ajv2019(options);
    else if (["http://json-schema.org/draft-07/schema", "http://json-schema.org/draft-07/schema#"].includes(dialect)) compiler = new Ajv(options);
    else if (["http://json-schema.org/draft-06/schema", "http://json-schema.org/draft-06/schema#"].includes(dialect)) {
      compiler = new Ajv(options); compiler.addMetaSchema(draft6MetaSchema);
    } else throw new ConfigError("Unsupported native JSON Schema dialect");
    nativeValidators.set(key, compiler.compile(schema));
  }
  const validate = nativeValidators.get(key);
  if (!validate(call.arguments)) throw new ConfigError("Invalid native arguments for " + call.name + ": " + validate.errors.map(error => `${error.instancePath || "$"}: ${error.message}`).join("; "));
  return tool;
}
function compactNativeResult(result) {
  if (!object(result.structuredContent) || !Array.isArray(result.content)) return result;
  const content = result.content.filter(block => {
    if (block?.type !== "text" || typeof block.text !== "string" ||
        Object.keys(block).length !== 2 || !block.text.trimStart().startsWith("{")) return true;
    try { return !isDeepStrictEqual(JSON.parse(block.text), result.structuredContent); }
    catch { return true; }
  });
  return { ...result, content };
}
const optionalObject = value => value === undefined || object(value);
const optionalString = value => value === undefined || typeof value === "string";
const base64 = value => typeof value === "string" && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
function validAnnotations(value) {
  if (value === undefined) return true;
  if (!object(value)) return false;
  const { audience, priority, lastModified } = value;
  return (audience === undefined || Array.isArray(audience) && audience.every(role => role === "user" || role === "assistant")) &&
    (priority === undefined || typeof priority === "number" && priority >= 0 && priority <= 1) &&
    optionalString(lastModified);
}
function validIcon(icon) {
  return object(icon) && typeof icon.src === "string" && optionalString(icon.mimeType) &&
    (icon.sizes === undefined || Array.isArray(icon.sizes) && icon.sizes.every(size => typeof size === "string")) &&
    (icon.theme === undefined || icon.theme === "light" || icon.theme === "dark");
}
function isNativeContentBlock(block) {
  if (!object(block) || !optionalObject(block._meta) || !validAnnotations(block.annotations)) return false;
  switch (block.type) {
    case "text": return typeof block.text === "string";
    case "image":
    case "audio": return base64(block.data) && typeof block.mimeType === "string";
    case "resource_link":
      return typeof block.uri === "string" && typeof block.name === "string" &&
        optionalString(block.title) && optionalString(block.description) && optionalString(block.mimeType) &&
        (block.size === undefined || Number.isFinite(block.size) && block.size >= 0) &&
        (block.icons === undefined || Array.isArray(block.icons) && block.icons.every(validIcon));
    case "resource": {
      const resource = block.resource;
      return object(resource) && typeof resource.uri === "string" &&
        optionalString(resource.mimeType) && optionalObject(resource._meta) &&
        (typeof resource.text === "string" || base64(resource.blob));
    }
    default: return false;
  }
}
function checkNativeToolResult(result) {
  if (!object(result) || result.content !== undefined &&
      (!Array.isArray(result.content) || !result.content.every(isNativeContentBlock)) ||
      !optionalObject(result.structuredContent) || !optionalObject(result._meta) ||
      result.isError !== undefined && typeof result.isError !== "boolean")
    throw new ConfigError("Invalid native tool result; operation is not confirmed complete");
}
async function dispatch(message) {
  if (!message || typeof message !== "object") return;
  const id = message.id,
    method = message.method;
  const started = Date.now();
  if (id === rootsPending && rootsPending !== null) {
    rootsPending = null;
    if (!process.env.EDT_AI_PROJECT_ROOT) {
      try {
        selection = roots_selection(message);
        selected = selection.directory;
        selectionError = null;
      } catch (error) {
        selected = null;
        selectionError = safe_error_message(error);
      }
    }
    finishRoots?.(); finishRoots = null;
    notifyDiscoveryChanged();
    return;
  }
  if (!Object.hasOwn(message, "id")) {
    if (method === "notifications/initialized") {
      initialized = true;
      if (discoveryNotificationPending) notifyDiscoveryChanged();
      if (requestInitialRoots) { requestInitialRoots = false; await requestRoots(); }
    }
    else if (method === "notifications/cancelled") {
      const pending = requests.get(requestKey(message.params?.requestId));
      if (pending) {
        pending.cancelled = true;
        if (pending.client && pending.upstreamId !== undefined)
          await pending.client.notify(method, { ...message.params, requestId: pending.upstreamId });
      }
    } else if (
      method === "notifications/roots/list_changed" &&
      !process.env.EDT_AI_PROJECT_ROOT
    )
      await requestRoots();
    else if (
      client &&
      ![
        "notifications/initialized",
        "notifications/tools/list_changed",
      ].includes(method)
    ) {
      const owner = client;
      try {
        await owner.notify(method, message.params || {});
      } catch (error) {
        if (sessionExpired(error) && client === owner) {
          currentRevision = null;
          lastError = safe_error_message(error);
          await disconnect({ preserveResponses: true });
        } else throw error;
      }
    }
    return;
  }
  if (!method) return;
  let requestOwner, requestBinding, requestDirectory = selected;
  try {
    const requested =
      message.params?._meta?.["io.modelcontextprotocol/protocolVersion"];
    if (
      method === "server/discover" ||
      (requested && !PROTOCOLS.includes(requested))
    ) {
      emit({
        id,
        error: {
          code: -32601,
          message: "Session-scoped relay requires the initialize handshake.",
        },
      });
      return;
    }
    if (method === "initialize") {
      const proposed = message.params?.protocolVersion,
        result = {
          protocolVersion: PROTOCOLS.includes(proposed)
            ? proposed
            : PROTOCOLS[0],
          serverInfo: { name: "1c-ai-" + component, title: component, version: core_version, icons: component_icons(component) },
          capabilities: {
            tools: {},
            resources: { listChanged: true },
            prompts: { listChanged: true },
          },
        };
      hostCapabilities = message.params?.capabilities || {};
      result.instructions = "Use core_runtime_tools and core_runtime_call for native APIs; the relay connects automatically. Pass this chat's projectRoot if roots are empty. core_runtime_status reports the current binding.";
      if (component === "bsl-ls")
        result.instructions +=
          " Discover configuration paths via EDT; register each directory before analysis. Only paths inside this binding are accepted.";
      if (selected) diagnostic.event("host_initialized", { projectRoot: selected, protocol: result.protocolVersion, rootsAdvertised: message.params?.capabilities?.roots != null });
      requestInitialRoots = message.params?.capabilities?.roots != null && !process.env.EDT_AI_PROJECT_ROOT;
      emit({ id, result });
      return;
    }
    let result;
    const params = message.params || {};
    if (method === "tools/call") register_diagnostic_secrets(params.arguments || {});
    if (method === "tools/call") diagnostic.event("request_started", { requestId: id, tool: params.name, projectRoot: selected });
    const pending = { cancelled: false };
    requests.set(requestKey(id), pending);
    if (["resources/list", "resources/templates/list", "prompts/list"].includes(method)) await waitForRoots();
    if (method === "ping") result = {};
    // Keep the host catalogue stable and bounded; native API discovery and
    // calls use the controls regardless of upstream catalogue size.
    else if (method === "tools/list") {
      result = { tools: controlTools() };
    }
    // No project-bound resources exist yet. Do not hide errors from a bound
    // server or bypass knowledge checks after a project has been selected.
    else if (!client && !selected && !selectionError && !rootsPending && ["resources/list", "resources/templates/list", "prompts/list"].includes(method)) {
      result = { [{ "resources/list": "resources", "resources/templates/list": "resourceTemplates", "prompts/list": "prompts" }[method]]: [] };
    }
    else {
      const control = method === "tools/call" && controlTools().some(tool => tool.name === params.name);
      if (control) {
        const args = params.arguments || {};
        controlArguments(params.name, args);
        await waitForRoots();
        if (rootsPending) throw new ConfigError("Ожидается выбранный каталог проекта.");
        selection = explicit_selection({ ...selection, directory: selected }, args.projectRoot, selectionError);
        selected = selection.directory;
      }
      // Status is the model's bootstrap when only this tool was discovered.
      // Waiting for a host tools/list refresh here strands prepared services.
      // bind() still enforces the project/instance preparation permission.
      const priorCatalogue = catalogue;
      await ensureBinding();
      requestOwner = client;
      requestBinding = bindingContext;
      requestDirectory = selected;
      if (pending.cancelled) throw new ConfigError("Request cancelled before dispatch; not executed");
      if (
        method === "tools/call" &&
        params.name === "core_runtime_status"
      ) {
        const availableTools = client && catalogueIsCurrent(client) ? catalogue.tools : null;
        const status = {
          ready: !!client && !client.error,
          readinessScope: "native_connection",
          workflowReadiness: { state: "not_checked", scope: "workflow", detail: "Each native action must satisfy its knowledge dependency, source authority and action policy." },
          state: client?.error ? "error" : client ? "connected" : "disconnected",
          component,
          detail: lastError,
          ...(lastFailure ? { failure: lastFailure } : {}),
          selectedDirectory: selected,
          selectionSource: selection.source,
          knowledge: (() => { try { const [, config, profile] = configContext(); return knowledge_status(profile, config); } catch { return null; } })(),
          nativeToolCount: availableTools?.length ?? 0,
          nativeCatalog: availableTools ? (availableTools.length ? "available" : "empty") : "not_checked",
          toolAccess: "Use core_runtime_tools for live schemas and core_runtime_call for native operations. Both accept this chat's projectRoot for empty host roots.",
        };
        {
          status.binding = bindingContext;
          if (client)
            status.serverContract = Object.fromEntries(
              ["instructions", "capabilities", "serverInfo", "protocolVersion"]
                .filter((key) => key in client.initialization)
                .map((key) => [key, client.initialization[key]]),
            );
        }
        result = {
          content: [
            {
              type: "text",
              text:
                `${component}: ${status.state}${status.detail ? ". " + status.detail : ""}`,
            },
          ],
          structuredContent: status,
        };
      } else if (client && control && params.name === "core_runtime_tools") {
        const { names, detail, refresh } = params.arguments || {};
        // Initial binding may already have fetched the catalogue.
        const needsRefresh = !catalogueIsCurrent(client) || catalogue === priorCatalogue &&
          (refresh ?? (!names || names.some(name => !catalogue.tools.some(tool => tool.name === name))));
        const snapshot = needsRefresh ? await refreshTools() : catalogue;
        if (client !== requestOwner) throw new ConfigError("Project binding changed while refreshing tools");
        const { tools } = snapshot;
        const missing = names?.filter(name => !tools.some(tool => tool.name === name));
        if (missing?.length) throw new ConfigError("Native tools not advertised by the selected server: " + missing.join(", "));
        const selectedTools = names ? tools.filter(tool => names.includes(tool.name)) : tools;
        result = { content: [], structuredContent: { binding: bindingContext,
          ...(detail === "names" ? { names: selectedTools.map(tool => tool.name) } : { tools: selectedTools }) } };
      } else if (client && control && params.name === "core_runtime_call") {
        const owner = client, ownerBinding = bindingContext, epoch = generation, results = [];
        const compact = params.arguments.compact === true;
        for (const [callIndex, call] of params.arguments.calls.entries()) {
          let dispatched = false, received = false;
          const nativeStarted = Date.now();
          try {
            if (pending.cancelled || client !== owner || epoch !== generation) throw new ConfigError("Runtime batch interrupted before the next call; completed calls were not rolled back");
            const { tools: validatedTools } = await currentCatalogue();
            if (pending.cancelled || client !== owner || epoch !== generation) throw new ConfigError("Runtime batch interrupted before the next call; completed calls were not rolled back");
            const nativeTool = validateNative(call, validatedTools);
            const declaredRead = nativeTool.annotations?.readOnlyHint === true && nativeTool.annotations?.destructiveHint !== true;
            // A phase assertion cannot downgrade a writer or an unknown effect.
            const recheckKnowledge = await checkKnowledgeWorkflow(declaredRead ? params.arguments.workflowAction : "workflow");
            const refreshing = client === owner && !pending.cancelled ? toolsRefresh : null;
            if (refreshing) await refreshing;
            if (pending.cancelled || client !== owner || epoch !== generation) throw new ConfigError("Runtime batch interrupted before the next call; completed calls were not rolled back");
            if (!catalogueIsCurrent(owner) || catalogue.tools !== validatedTools)
              throw new ConfigError("Native catalogue changed before dispatch; request current schemas");
            if (refreshing) recheckKnowledge();
            pending.client = owner;
            diagnostic.event("native_request_started", { requestId: id, callIndex: callIndex + 1, tool: call.name, projectRoot: ownerBinding?.projectRoot, phase: "dispatch" });
            const native = await owner.request("tools/call", { ...call, ...(params._meta ? { _meta: params._meta } : {}) }, {
              onId: value => { pending.upstreamId = value; }, onDispatch: () => { dispatched = true; },
            });
            checkNativeToolResult(native);
            results.push({ name: call.name, result: compact ? compactNativeResult(native) : native });
            received = true;
            diagnostic.event("native_request_completed", { requestId: id, callIndex: callIndex + 1, tool: call.name, projectRoot: ownerBinding?.projectRoot, phase: "completed", durationMs: Date.now() - nativeStarted, outcome: native.isError ? "response_error" : "response_ok", isError: Boolean(native.isError) }, native.isError ? "error" : "info");
            recheckKnowledge();
            if (native.isError) break;
          } catch (error) {
            diagnostic.event("native_request_failed", { requestId: id, callIndex: callIndex + 1, tool: call.name, projectRoot: ownerBinding?.projectRoot,
              phase: dispatched ? "transport" : "dispatch", durationMs: Date.now() - nativeStarted, outcome: received ? "response_received" : dispatched ? "unknown" : "not_executed", error }, "error");
            const detail = { message: safe_error_message(error), outcome: received ? "response_received" : dispatched ? "unknown" : "not_executed",
              executionOutcome: received ? "completed" : dispatched ? "outcome_unknown" : "not_executed", ...(error.code ? { code: error.code } : {}) };
            if (received) results.at(-1).error = detail;
            else results.push({ name: call.name, error: detail });
            if (sessionExpired(error) && client === owner) {
              currentRevision = null; lastError = safe_error_message(error);
              try { await disconnect({ preserveResponses: true }); }
              catch (cleanup) {
                detail.cleanupUnconfirmed = true;
                diagnostic.event("connection_cleanup_unconfirmed", { projectRoot: ownerBinding?.projectRoot, error: cleanup }, "error");
              }
            }
            break;
          } finally {
            // Group visibility may have changed even if the server did not reply.
            if (dispatched && component === "edt" && call.name === "enable_toolset" && client === owner) toolsetRevision++;
          }
        }
        const failed = Boolean(results.at(-1)?.error || results.at(-1)?.result?.isError);
        const actions = params.arguments.calls.map((call, index) => {
          const entry = results[index];
          const status = !entry ? "not_started" : entry.error?.outcome === "not_executed" ? "not_started"
            : entry.error?.outcome === "unknown" ? "unknown" : entry.result?.isError ? "response_error"
            : entry.error ? "response_ok_workflow_stopped" : "response_ok";
          return { position: index + 1, name: call.name, status,
            executionOutcome: entry ? entry.error?.executionOutcome || "completed" : "not_executed" };
        });
        result = { content: compact ? [] : results.flatMap(entry => [...(entry.result?.content || []), ...(entry.error ? [{ type: "text", text: entry.error.message }] : [])]),
          structuredContent: { binding: ownerBinding, results, actions, completed: results.filter(entry => entry.result && !entry.result.isError).length, requested: params.arguments.calls.length,
            ...(failed ? { stopped: { completedActions: results.filter(entry => entry.result && !entry.result.isError).map(entry => entry.name),
              notStarted: [...results.filter(entry => entry.error?.outcome === "not_executed").map(entry => entry.name), ...params.arguments.calls.slice(results.length).map(entry => entry.name)],
              unknownActions: results.filter(entry => entry.error?.outcome === "unknown").map(entry => entry.name), rollback: "not_performed",
              instruction: "Stop dependent work and report completed actions and unknown outcomes. Subsequent requests reconnect when possible; do not retry unknown mutations blindly." } } : {}) },
          ...(failed ? { isError: true } : {}) };
      } else if (client) {
        // Discovery/status controls remain available to repair setup. Native
        // workflow calls, resources and prompts cannot bypass mandatory KORA.
        const owner = client, epoch = generation, nativeCall = method === "tools/call";
        const validatedTools = nativeCall ? (await currentCatalogue()).tools : null;
        if (client !== owner || epoch !== generation) throw new ConfigError("Project binding changed before dispatch; not executed");
        const recheckKnowledge = await checkKnowledgeWorkflow();
        const refreshing = nativeCall && client === owner && !pending.cancelled ? toolsRefresh : null;
        if (refreshing) await refreshing;
        if (pending.cancelled) throw new ConfigError("Request cancelled before dispatch; not executed");
        if (client !== owner || epoch !== generation) throw new ConfigError("Project binding changed before dispatch; not executed");
        if (nativeCall && (!catalogueIsCurrent(owner) || catalogue.tools !== validatedTools))
          throw new ConfigError("Native catalogue changed before dispatch; request current schemas");
        if (refreshing) recheckKnowledge();
        const keys = {
            "resources/list": "resources",
            "resources/templates/list": "resourceTemplates",
            "prompts/list": "prompts",
          },
          key = keys[method];
        if (nativeCall && component === "code-index") {
          const tool = validatedTools.find(tool => tool.name === params.name);
          if (!tool && bindingContext.endpoint) throw new ConfigError("Unknown native tool: " + params.name);
          checkIndexSelector(params.arguments ?? {}, tool?.inputSchema);
        }
        pending.client = owner;
        if (key) {
          try {
            result = await owner.request(method, params, { onId: value => { pending.upstreamId = value; } });
          } catch (error) {
            if (error.code !== -32601)
              throw error;
            result = { [key]: [] };
          }
        } else {
          let dispatched = false;
          try {
            result = await owner.request(method, params, {
              onId: value => { pending.upstreamId = value; }, onDispatch: () => { dispatched = true; },
            });
            if (nativeCall) checkNativeToolResult(result);
          } finally {
            if (dispatched && nativeCall && component === "edt" && params.name === "enable_toolset" && client === owner) toolsetRevision++;
          }
        }
        try { recheckKnowledge(); }
        catch (error) {
          if (method !== "tools/call") throw error;
          result = { ...result, isError: true, content: [...(result.content || []), { type: "text", text: safe_error_message(error) }],
            structuredContent: { ...result.structuredContent, workflowStopped: { reason: safe_error_message(error), action: params.name,
              outcome: "response_received", rollback: "not_performed", instruction: "Stop dependent work and report the received result before revalidating readiness." } } };
        }
      } else
        throw new ConfigError(
          rootsPending ? "Ожидается каталог проекта." : lastError,
        );
    }
    if (method === "tools/call") diagnostic.event("request_completed", { requestId: id, tool: message.params?.name, projectRoot: requestDirectory,
      durationMs: Date.now() - started, isError: Boolean(result?.isError), binding: requestBinding }, result?.isError ? "error" : "info");
    if (method === "tools/list" && selected) {
      const observed = JSON.stringify([selected, result.tools.length, Boolean(client), Boolean(rootsPending)]);
      if (observed !== lastHostToolsObservation) {
        lastHostToolsObservation = observed;
        diagnostic.event("host_tools_list", { requestId: id, projectRoot: selected, durationMs: Date.now() - started, count: result.tools.length, controlCount: controlTools().length, bound: Boolean(client), rootsPending: Boolean(rootsPending) });
      }
    }
    emit({ id, result });
  } catch (error) {
    diagnostic.event("request_failed", { requestId: id, method, tool: message.params?.name, projectRoot: requestDirectory,
      binding: requestBinding, durationMs: Date.now() - started, error }, "error");
    if (sessionExpired(error) && client === requestOwner) {
      currentRevision = null;
      lastError = safe_error_message(error);
      try { await disconnect({ preserveResponses: true }); }
      catch (cleanup) { diagnostic.event("connection_cleanup_unconfirmed", { projectRoot: requestDirectory, error: cleanup }, "error"); }
    }
    emit({ id, error: { code: -32000, message: safe_error_message(error) } });
  } finally {
    requests.delete(requestKey(id));
  }
}
let queue = Promise.resolve(),
  idleQueued = false,
  idleTimer = null;
const enqueue = (action) => {
  queue = queue.then(action).catch((error) => {
    process.stderr.write(safe_error_message(error) + "\n");
  });
};
function startIdlePolling() {
  if (idleTimer || closed) return;
  idleTimer = setInterval(() => {
    if (initialized && !closed && !idleQueued) {
      idleQueued = true;
      enqueue(async () => {
        try {
          if (!closed && client && !requests.size) await ensureBinding(false, false);
        } finally {
          idleQueued = false;
        }
      });
    }
  }, 500);
}
function stopIdlePolling() {
  if (idleTimer) clearInterval(idleTimer);
  idleTimer = null;
}
read_lines(process.stdin, message => {
  if (!message.method && callbacks.has(message.id)) { callbacks.get(message.id)(message); callbacks.delete(message.id); return; }
  void dispatch(message).catch(error => process.stderr.write(safe_error_message(error) + "\n"));
}, error => { process.stderr.write(safe_error_message(error) + "\n"); shutdown(); });
const shutdown = () => {
  if (closed) return;
  closed = true;
  stopIdlePolling();
  process.stdin.pause();
  finishRoots?.();
  finishRoots = null;
  for (const done of callbacks.values()) done({ error: { message: "Host disconnected" } });
  callbacks.clear();
  for (const owner of retiredClients) void owner.close().catch(error => process.stderr.write(safe_error_message(error) + "\n"));
  void disconnect().catch(error => process.stderr.write(safe_error_message(error) + "\n"));
};
process.stdin.once("end", shutdown);
process.stdin.once("close", shutdown);
process.stdin.once("error", shutdown);
process.stdout.once("error", shutdown);
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
