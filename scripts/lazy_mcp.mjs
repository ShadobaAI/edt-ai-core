// Connection-owned binding. Control messages never wait for a running tool.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
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
  RemoteRpcError,
} from "./remote_client.mjs";
import { validate_bsl_tools } from "./runtime.mjs";
import { component_icons } from "./icons.mjs";
import { launch_selection, roots_selection, explicit_selection } from "./selection.mjs";
import { COMPONENTS, component_settings, component_enabled, binding_fingerprint, require_preparation } from "./components.mjs";
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
diagnostic.event("session_started", { version: core_version, projectRoot: process.env.EDT_AI_PROJECT_ROOT || null, node: process.version });
process.on("uncaughtExceptionMonitor", error => diagnostic.event("uncaught_exception", { error }, "error"));
let client = null,
  currentRevision = null,
  failedRevision = null,
  tools = [],
  toolsRevision = null,
  toolsDirty = false,
  bindingContext = null,
  connectingClient = null;
let boundAliases = new Set();
const nativeValidators = new Map();
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
let rootsReady = Promise.resolve(), finishRoots = null;
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const emit = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
function notifyDiscoveryChanged() {
  if (closed) return;
  if (!initialized) { discoveryNotificationPending = true; return; }
  discoveryNotificationPending = false;
  emit({ method: "notifications/resources/list_changed" });
  emit({ method: "notifications/prompts/list_changed" });
}
async function disconnect() {
  generation++;
  const knowledgeClosing = workflowKnowledge.close();
  const previous = client;
  if (previous) diagnostic.event("disconnected", { projectRoot: selected, binding: bindingContext });
  const connecting = connectingClient;
  connectingClient = null;
  client = null;
  tools = [];
  toolsRevision = null;
  toolsDirty = false;
  bindingContext = null;
  boundAliases.clear();
  nativeValidators.clear();
  if (previous) notifyDiscoveryChanged();
  if (previous) await previous.close();
  if (connecting && connecting !== previous) await connecting.close();
  await knowledgeClosing;
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
async function refreshTools() {
  const owner = client, epoch = generation,
    revision = owner.tools_revision,
    next = (await all_pages(owner, "tools/list", "tools")).tools;
  if (owner !== client || epoch !== generation)
    throw new ConfigError("Project binding changed while refreshing tools");
  toolsRevision = revision;
  toolsDirty = false;
  if (stable(next) !== stable(tools)) tools = next;
}
async function refreshNotifiedTools() {
  if (client && (toolsDirty || client.tools_revision !== toolsRevision))
    await refreshTools();
}
let bindingPromise = null, generation = 0, hostCapabilities = {}, callbackSequence = 0;
const callbacks = new Map(), requests = new Map();
const requestKey = id => typeof id + ":" + id;
function callback(message) {
  const id = "core-callback-" + ++callbackSequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { callbacks.delete(id); reject(new Error("Host callback timed out")); }, 60000);
    callbacks.set(id, reply => { clearTimeout(timer); reply.error ? reject(Object.assign(new Error(reply.error.message), { code: reply.error.code })) : resolve(reply.result); });
    emit({ ...message, id });
  });
}
async function ensureBinding(refreshSurface = true, retryFailed = true, connect = true) {
  const next = (bindingPromise || Promise.resolve()).catch(() => {}).then(() => bind(refreshSurface, retryFailed, connect));
  bindingPromise = next;
  try { await next; } finally { if (bindingPromise === next) bindingPromise = null; }
}
async function bind(refreshSurface, retryFailed, connect) {
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
    if (client && !client.error && revision === currentRevision) {
      if (refreshSurface) { stage = "tools/list"; await refreshNotifiedTools(); }
      return;
    }
    await disconnect();
    if (!component_enabled(config, component)) throw new ConfigError("Компонент отключён в настройках.");
    if (!connect) { if (revision !== failedRevision) lastError = "Компонент не подключён. Откройте его инструменты после подготовки MCP."; return; }
    currentRevision = revision;
    const epoch = generation;
    const transportOptions = { capabilities: { ...hostCapabilities, roots: { listChanged: false } },
      onRequest: message => message.method === "roots/list" ? { roots: component === "v8std" ? [] : [{ uri: pathToFileURL(root).href, name: path.basename(root) }] } : callback(message),
      maxBytes: options.max_response_bytes,
      onStderr: chunk => diagnostic.event("runtime_stderr", { projectRoot: root, bytes: chunk.length, content: "omitted" }, "warning"),
      onNotification: message => {
        if (message.method === "notifications/tools/list_changed") toolsDirty = true;
        else if (client && !closed) emit(message);
      } };
    // The remote standards corpus has no need for local project directories.
    if (component === "v8std") delete transportOptions.capabilities.roots;
    let candidate, url;
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
          ...process.env,
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
      toolsRevision = candidate.tools_revision;
      tools = (await all_pages(candidate, "tools/list", "tools")).tools;
      stage = "native_validation";
      if (component === "bsl-ls") validate_bsl_tools(tools);
      toolsDirty = false;
      if (epoch !== generation || closed) throw new ConfigError("Project binding changed while connecting");
    } catch (error) {
      await candidate.close();
      currentRevision = null;
      throw error;
    }
    client = candidate;
    boundAliases = new Set(profile.repositories.map(repo => repo.alias));
    connectingClient = null;
    failedRevision = null;
    lastError = "";
    lastFailure = null;
    bindingContext = {
        projectRoot: root,
        instance: instance_name(),
        endpoint: url,
        connectionId: randomUUID().replaceAll("-", ""),
        revision: sha256(revision),
      };
    diagnostic.event("connected", { binding: bindingContext, tools: tools.length,
      server: candidate.initialization?.serverInfo, protocol: candidate.initialization?.protocolVersion });
    notifyDiscoveryChanged();
  } catch (error) {
    await disconnect();
    failedRevision = revision;
    if (revision === null) currentRevision = null;
    if (lastError !== safe_error_message(error)) diagnostic.event("connection_failed", { projectRoot: selected, error }, "error");
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
      : "Connect the selected repository binding and read its service state and native server contract. Managed services start only with this project's and instance's existing preparation permission; this does not grant permission. Use core_runtime_tools and core_runtime_call for native APIs.",
  inputSchema: { type: "object", properties: {
    projectRoot: { type: "string", minLength: 1, description: "Current chat's project directory when host roots are empty; binds only this session." },
  }, additionalProperties: false },
  annotations: { readOnlyHint: COMPONENTS[component].kind === "remote", destructiveHint: false },
});
const rootProperty = () => statusTool().inputSchema.properties.projectRoot;
const controlTools = () => [statusTool(), {
  name: "core_runtime_tools",
  title: "Живой API " + component,
  description: "Read the selected server's live native tool definitions, including full schemas and annotations. Use detail=names to discover names, then names to request only needed definitions. Supply this chat's projectRoot when roots are empty; this never overrides a host/session binding.",
  inputSchema: { type: "object", properties: {
    projectRoot: rootProperty(),
    names: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 32, uniqueItems: true },
    detail: { type: "string", enum: ["full", "names"], description: "Return full definitions (default) or only native tool names." },
  }, additionalProperties: false },
  annotations: { readOnlyHint: COMPONENTS[component].kind === "remote", destructiveHint: false },
}, {
  name: "core_runtime_call",
  title: "Вызов native API " + component,
  description: "Call native tools using their live schemas from core_runtime_tools. Calls run sequentially in one project-bound connection, so workspace registration and analysis can share a BSL LS process. Stops at the first failure; completed calls are not rolled back. The actions summary uses one-based positions; response_error or unknown does not prove whether a mutation had effects. Apply the native annotations, source workflow and action policy to EVERY call; this wrapper grants no permissions. Supply this chat's projectRoot when roots are empty. Never retry a failed batch blindly.",
  inputSchema: { type: "object", properties: {
    projectRoot: rootProperty(),
    calls: { type: "array", minItems: 1, maxItems: 16, items: {
      type: "object", properties: { name: { type: "string", minLength: 1 }, arguments: { type: "object", additionalProperties: true } },
      required: ["name", "arguments"], additionalProperties: false,
    } },
    workflowAction: { type: "string", enum: WORKFLOW_ACTIONS, description: "Current task phase; omission conservatively checks all mandatory knowledge dependencies. Does not grant action permission." },
  }, required: ["calls"], additionalProperties: false },
  // Actual effects belong to the selected native operations, not this envelope.
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
}];
function controlArguments(name, args) {
  const allowed = name === "core_runtime_tools" ? ["projectRoot", "names", "detail"] : name === "core_runtime_call" ? ["projectRoot", "calls", "workflowAction"] : ["projectRoot"];
  if (!object(args) || Object.keys(args).some(key => !allowed.includes(key))) throw new ConfigError("Invalid runtime control arguments");
  if (args.workflowAction !== undefined && !WORKFLOW_ACTIONS.includes(args.workflowAction)) throw new ConfigError("Invalid workflow action");
  if (args.detail !== undefined && !["full", "names"].includes(args.detail)) throw new ConfigError("Invalid runtime tool detail");
  if (args.names !== undefined && (!Array.isArray(args.names) || !args.names.length || args.names.length > 32 || args.names.some(name => typeof name !== "string" || !name) || new Set(args.names).size !== args.names.length))
    throw new ConfigError("names must contain 1 to 32 unique native tool names");
  if (name === "core_runtime_call" && (!Array.isArray(args.calls) || !args.calls.length || args.calls.length > 16 || args.calls.some(call => !object(call) || typeof call.name !== "string" || !call.name || !object(call.arguments) || Object.keys(call).some(key => !["name", "arguments"].includes(key)))))
    throw new ConfigError("calls must contain 1 to 16 native tools with object arguments");
}
function checkAlias(params) {
  if (component === "code-index" && Object.hasOwn(params.arguments || {}, "repo") && !boundAliases.has(params.arguments.repo))
    throw new ConfigError("code-index alias is outside the selected project profile");
}
function validateNative(call) {
  const tool = tools.find(tool => tool.name === call.name);
  if (!tool || controlTools().some(tool => tool.name === call.name)) throw new ConfigError("Unknown native tool: " + call.name);
  const schema = tool.inputSchema, key = stable(schema);
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
  checkAlias(call);
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
      try {
        await client.notify(method, message.params || {});
      } catch (error) {
        if (error instanceof RemoteSessionExpired) {
          await disconnect();
          currentRevision = null;
        } else throw error;
      }
    }
    return;
  }
  if (!method) return;
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
      result.instructions = "Call core_runtime_status per binding; pass this chat's projectRoot if roots are empty. Use core_runtime_tools and core_runtime_call for native APIs.";
      if (component === "bsl-ls")
        result.instructions +=
          " Discover configuration paths via EDT; register each directory before analysis. Only paths inside this binding are accepted.";
      diagnostic.event("host_initialized", { protocol: result.protocolVersion, rootsAdvertised: message.params?.capabilities?.roots != null });
      requestInitialRoots = message.params?.capabilities?.roots != null && !process.env.EDT_AI_PROJECT_ROOT;
      emit({ id, result });
      return;
    }
    let result;
    const params = message.params || {};
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
      await ensureBinding();
      if (pending.cancelled) throw new ConfigError("Request cancelled before dispatch; not executed");
      if (
        method === "tools/call" &&
        params.name === "core_runtime_status"
      ) {
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
          nativeToolCount: tools.length,
          nativeCatalog: client ? (tools.length ? "available" : "empty") : "not_checked",
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
        await refreshTools();
        const names = params.arguments?.names;
        if (names?.some(name => !tools.some(tool => tool.name === name))) throw new ConfigError("Requested native tool is not in the live server catalogue");
        const selectedTools = names ? tools.filter(tool => names.includes(tool.name)) : tools;
        result = { content: [], structuredContent: { binding: bindingContext,
          ...(params.arguments?.detail === "names" ? { names: selectedTools.map(tool => tool.name) } : { tools: selectedTools }) } };
      } else if (client && control && params.name === "core_runtime_call") {
        const owner = client, ownerBinding = bindingContext, epoch = generation, results = [];
        for (const call of params.arguments.calls) {
          let dispatched = false, received = false;
          try {
            if (pending.cancelled || client !== owner || epoch !== generation) throw new ConfigError("Runtime batch interrupted before the next call; completed calls were not rolled back");
            await refreshNotifiedTools();
            validateNative(call);
            const nativeTool = tools.find(tool => tool.name === call.name);
            const declaredRead = nativeTool.annotations?.readOnlyHint === true && nativeTool.annotations?.destructiveHint !== true;
            // A phase assertion cannot downgrade a writer or an unknown effect.
            const recheckKnowledge = await checkKnowledgeWorkflow(declaredRead ? params.arguments.workflowAction : "workflow");
            if (pending.cancelled || client !== owner || epoch !== generation) throw new ConfigError("Runtime batch interrupted before the next call; completed calls were not rolled back");
            pending.client = owner;
            diagnostic.event("native_request_started", { requestId: id, tool: call.name, projectRoot: selected });
            const native = await owner.request("tools/call", { ...call, ...(params._meta ? { _meta: params._meta } : {}) }, {
              onId: value => { pending.upstreamId = value; }, onDispatch: () => { dispatched = true; },
            });
            received = true;
            results.push({ name: call.name, result: native });
            diagnostic.event("native_request_completed", { requestId: id, tool: call.name, projectRoot: selected, isError: Boolean(native.isError) });
            if (call.name === "enable_toolset") toolsDirty = true;
            recheckKnowledge();
            if (native.isError) break;
          } catch (error) {
            diagnostic.event("native_request_failed", { requestId: id, tool: call.name, projectRoot: ownerBinding?.projectRoot, error }, "error");
            const detail = { message: safe_error_message(error), outcome: received ? "response_received" : dispatched ? "unknown" : "not_executed", ...(error.code ? { code: error.code } : {}) };
            if (received) results.at(-1).error = detail;
            else results.push({ name: call.name, error: detail });
            if (error instanceof RemoteSessionExpired) {
              await disconnect(); currentRevision = null; lastError = safe_error_message(error);
            }
            break;
          }
        }
        const failed = Boolean(results.at(-1)?.error || results.at(-1)?.result?.isError);
        const actions = params.arguments.calls.map((call, index) => {
          const entry = results[index];
          const status = !entry ? "not_started" : entry.error?.outcome === "not_executed" ? "not_started"
            : entry.error?.outcome === "unknown" ? "unknown" : entry.result?.isError ? "response_error"
            : entry.error ? "response_ok_workflow_stopped" : "response_ok";
          return { position: index + 1, name: call.name, status };
        });
        result = { content: results.flatMap(entry => [...(entry.result?.content || []), ...(entry.error ? [{ type: "text", text: entry.error.message }] : [])]),
          structuredContent: { binding: ownerBinding, results, actions, completed: results.filter(entry => entry.result && !entry.result.isError).length, requested: params.arguments.calls.length,
            ...(failed ? { stopped: { completedActions: results.filter(entry => entry.result && !entry.result.isError).map(entry => entry.name),
              notStarted: [...results.filter(entry => entry.error?.outcome === "not_executed").map(entry => entry.name), ...params.arguments.calls.slice(results.length).map(entry => entry.name)],
              unknownActions: results.filter(entry => entry.error?.outcome === "unknown").map(entry => entry.name), rollback: "not_performed",
              instruction: "Stop dependent work. Report completed actions and unknown outcomes; revalidate readiness before continuing. Do not retry mutations blindly." } } : {}) },
          ...(failed ? { isError: true } : {}) };
      } else if (client) {
        // Discovery/status controls remain available to repair setup. Native
        // workflow calls, resources and prompts cannot bypass mandatory KORA.
        const owner = client, epoch = generation,
          recheckKnowledge = await checkKnowledgeWorkflow();
        if (pending.cancelled) throw new ConfigError("Request cancelled before dispatch; not executed");
        if (client !== owner || epoch !== generation) throw new ConfigError("Project binding changed before dispatch; not executed");
        const keys = {
            "resources/list": "resources",
            "resources/templates/list": "resourceTemplates",
            "prompts/list": "prompts",
          },
          key = keys[method];
        if (method === "tools/call") checkAlias(params);
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
          result = await owner.request(method, params, { onId: value => { pending.upstreamId = value; } });
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
    if (method === "tools/call") diagnostic.event("request_completed", { requestId: id, tool: message.params?.name, projectRoot: selected,
      durationMs: Date.now() - started, isError: Boolean(result?.isError), binding: bindingContext }, result?.isError ? "error" : "info");
    if (method === "tools/list") diagnostic.event("host_tools_list", { requestId: id, durationMs: Date.now() - started, count: result.tools.length, controlCount: controlTools().length, bound: Boolean(client), rootsPending: Boolean(rootsPending) });
    emit({ id, result });
    if (method === "tools/call" && client && params.name === "enable_toolset") {
      toolsDirty = true;
    }
  } catch (error) {
    diagnostic.event("request_failed", { requestId: id, method, tool: message.params?.name, projectRoot: selected, durationMs: Date.now() - started, error }, "error");
    if (error instanceof RemoteSessionExpired) {
      await disconnect();
      currentRevision = null;
      lastError = safe_error_message(error);
    }
    emit({ id, error: { code: -32000, message: safe_error_message(error) } });
  } finally {
    requests.delete(requestKey(id));
  }
}
let queue = Promise.resolve(),
  closed = false,
  idleQueued = false;
const enqueue = (action) => {
  queue = queue.then(action).catch((error) => {
    process.stderr.write(safe_error_message(error) + "\n");
  });
};
read_lines(process.stdin, message => {
  if (!message.method && callbacks.has(message.id)) { callbacks.get(message.id)(message); callbacks.delete(message.id); return; }
  void dispatch(message).catch(error => process.stderr.write(safe_error_message(error) + "\n"));
}, error => { process.stderr.write(safe_error_message(error) + "\n"); shutdown(); });
const timer = setInterval(() => {
  if (initialized && !closed && !idleQueued) {
    idleQueued = true;
    enqueue(async () => {
      try {
        if (!closed && client && !requests.size) await ensureBinding(true, false, false);
      } finally {
        idleQueued = false;
      }
    });
  }
}, 500);
process.stdin.once("end", () => {
  closed = true;
  clearInterval(timer);
  void disconnect();
});
const shutdown = () => {
  closed = true;
  clearInterval(timer);
  process.stdin.pause();
  for (const done of callbacks.values()) done({ error: { message: "Host disconnected" } });
  callbacks.clear();
  void disconnect();
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
