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
import { Ajv, Ajv2020 } from "../vendor/deps.mjs";
import { create_diagnostic_logger, register_diagnostic_secrets } from "./diagnostics.mjs";

const component = argumentsOf(undefined, [], ["component"]).component;
if (!Object.hasOwn(COMPONENTS, component))
  throw new ConfigError("Invalid --component");
const state = state_root(),
  configuration =
    process.env.EDT_AI_SETTINGS || path.join(state, "settings.json");
const diagnostic = create_diagnostic_logger(component, state);
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
  initialized = false;
let lastError = "Выберите каталог проекта с .ai/project.yaml.";
let rootsReady = Promise.resolve(), finishRoots = null;
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const emit = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
async function disconnect() {
  generation++;
  const previous = client;
  if (previous) diagnostic.event("disconnected", { projectRoot: selected, binding: bindingContext });
  const connecting = connectingClient;
  const hadTools = tools.length > 0;
  connectingClient = null;
  client = null;
  tools = [];
  toolsRevision = null;
  toolsDirty = false;
  bindingContext = null;
  boundAliases.clear();
  nativeValidators.clear();
  if (hadTools && !closed) emit({ method: "notifications/tools/list_changed" });
  if (previous) await previous.close();
  if (connecting && connecting !== previous) await connecting.close();
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
async function refreshTools() {
  const revision = client.tools_revision,
    next = (await all_pages(client, "tools/list", "tools")).tools;
  toolsRevision = revision;
  toolsDirty = false;
  if (stable(next) !== stable(tools)) {
    tools = next;
    emit({ method: "notifications/tools/list_changed" });
  }
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
  let revision = null;
  try {
    const [root, config, profile] = configContext(),
      token = reconnect_file(state, root);
    const options = component_settings(config, component);
    register_diagnostic_secrets(config);
    const reconnect = exists(token) ? JSON.parse(fs.readFileSync(token, "utf8")) : {};
    revision = binding_fingerprint(config, component, root, profile, reconnect[component] || reconnect.id || "");
    if (revision === failedRevision && !retryFailed) return;
    if (client && !client.error && revision === currentRevision) {
      if (refreshSurface) await refreshNotifiedTools();
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
      onStderr: chunk => diagnostic.event("runtime_stderr", { projectRoot: root, message: String(chunk) }, "warning"),
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
      await candidate.initialize();
      toolsRevision = candidate.tools_revision;
      tools = (await all_pages(candidate, "tools/list", "tools")).tools;
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
    bindingContext = {
        projectRoot: root,
        instance: instance_name(),
        endpoint: url,
        connectionId: randomUUID().replaceAll("-", ""),
        revision: sha256(revision),
      };
    diagnostic.event("connected", { binding: bindingContext, tools: tools.length,
      server: candidate.initialization?.serverInfo, protocol: candidate.initialization?.protocolVersion });
    emit({ method: "notifications/tools/list_changed" });
  } catch (error) {
    await disconnect();
    failedRevision = revision;
    if (revision === null) currentRevision = null;
    if (lastError !== error.message) diagnostic.event("connection_failed", { projectRoot: selected, error }, "error");
    lastError = error.message;
  }
}
const statusTool = () => ({
  name: "core_runtime_status",
  icons: component_icons(component),
  title: "Состояние " + component,
  description:
    component === "v8std"
      ? "Read the selected profile binding and negotiated server instructions/capabilities. Reuse until the binding or contract changes."
      : "Connect the selected repository binding and read its service state and native server contract. Managed services start only with this project's and instance's existing preparation permission; this does not grant permission. If the host keeps its initial catalogue, use core_runtime_tools and core_runtime_call.",
  inputSchema: { type: "object", properties: {
    projectRoot: { type: "string", minLength: 1, description: "Current chat's known local project directory, only when the host supplied no directory. Binds this MCP session without changing other chats. Never substitute another project's directory." },
  }, additionalProperties: false },
  annotations: { readOnlyHint: COMPONENTS[component].kind === "remote", destructiveHint: false },
});
const rootProperty = () => statusTool().inputSchema.properties.projectRoot;
const controlTools = () => [statusTool(), {
  name: "core_runtime_tools",
  title: "Живой API " + component,
  description: "Read the selected server's live native tool definitions, including full schemas and annotations. Use names to request only needed definitions. Available even when the host caches its initial tool list. Supply this chat's projectRoot when roots are empty; this never overrides a host/session binding.",
  inputSchema: { type: "object", properties: {
    projectRoot: rootProperty(),
    names: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 32, uniqueItems: true },
  }, additionalProperties: false },
  annotations: { readOnlyHint: COMPONENTS[component].kind === "remote", destructiveHint: false },
}, {
  name: "core_runtime_call",
  title: "Вызов native API " + component,
  description: "Call native tools using their live schemas from core_runtime_tools. Calls run sequentially in one project-bound connection, so workspace registration and analysis can share a BSL LS process. Stops at the first failure; completed calls are not rolled back. Apply the native annotations, source workflow and action policy to EVERY call; this wrapper grants no permissions. Supply this chat's projectRoot when roots are empty. Never retry a failed batch blindly.",
  inputSchema: { type: "object", properties: {
    projectRoot: rootProperty(),
    calls: { type: "array", minItems: 1, maxItems: 16, items: {
      type: "object", properties: { name: { type: "string", minLength: 1 }, arguments: { type: "object", additionalProperties: true } },
      required: ["name", "arguments"], additionalProperties: false,
    } },
  }, required: ["calls"], additionalProperties: false },
  // Actual effects belong to the selected native operations, not this envelope.
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
}];
function controlArguments(name, args) {
  const allowed = name === "core_runtime_tools" ? ["projectRoot", "names"] : name === "core_runtime_call" ? ["projectRoot", "calls"] : ["projectRoot"];
  if (!object(args) || Object.keys(args).some(key => !allowed.includes(key))) throw new ConfigError("Invalid runtime control arguments");
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
    const Compiler = /draft-07/.test(schema?.$schema || "") ? Ajv : Ajv2020;
    nativeValidators.set(key, new Compiler({ allErrors: true, strict: false, ownProperties: true, validateFormats: false }).compile(schema));
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
        selectionError = error.message;
      }
    }
    finishRoots?.(); finishRoots = null;
    emit({ method: "notifications/tools/list_changed" });
    return;
  }
  if (!Object.hasOwn(message, "id")) {
    if (method === "notifications/initialized") initialized = true;
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
            tools: { listChanged: true },
            resources: {},
            prompts: {},
          },
        };
      hostCapabilities = message.params?.capabilities || {};
      result.instructions = "For each new binding read core_runtime_status once for the selected project/instance and the native server instructions/capabilities. If selectedDirectory is empty, pass this chat's known local project directory as projectRoot to core_runtime_status; this binds only this connection. Do not restart chats or spawn substitute relays to repair empty roots. Reuse the contract until binding changes. Native tools and results retain their full schemas. Managed services require initial preparation in settings; profile inspection does not start them.";
      result.instructions += " If the host catalogue lacks native tools, get their live definitions with core_runtime_tools (names limits the response), then use core_runtime_call with native name/arguments in calls. Pass the same chat projectRoot on these controls when host roots are empty. A short sequential calls batch preserves workspace registration and analysis in one process even on hosts with separate connections. Classify and authorize every native call by its schema/annotations and action policy; the envelope grants no permissions. Batches stop on the first failure, preserve prior results and are never automatically retried.";
      if (component === "bsl-ls")
        result.instructions +=
          "Use the assigned EDT-MCP to discover configuration project names and paths. Register the exact configuration directory with register_workspace_folder, then use file paths or the returned workspaceFolder URI to select its context. Several folders may remain registered; no active configuration is shared. Only directories inside the selected project binding are accepted.";
      emit({ id, result });
      if (message.params?.capabilities?.roots != null && !process.env.EDT_AI_PROJECT_ROOT)
        await requestRoots();
      return;
    }
    let result;
    const params = message.params || {};
    if (method === "tools/call") diagnostic.event("request_started", { requestId: id, tool: params.name, projectRoot: selected });
    const pending = { cancelled: false };
    requests.set(requestKey(id), pending);
    if (method === "ping") result = {};
    else {
      const previous = client;
      const control = method === "tools/call" && controlTools().some(tool => tool.name === params.name);
      if (control) {
        const args = params.arguments || {};
        controlArguments(params.name, args);
        if (rootsPending && args.projectRoot !== undefined) {
          let timer;
          try { await Promise.race([rootsReady, new Promise(resolve => { timer = setTimeout(resolve, 3000); })]); }
          finally { clearTimeout(timer); }
        }
        if (rootsPending && args.projectRoot !== undefined) throw new ConfigError("Ожидается выбранный каталог проекта.");
        const previousDirectory = selected;
        selection = explicit_selection({ ...selection, directory: selected }, args.projectRoot, selectionError);
        selected = selection.directory;
        if (selected !== previousDirectory) emit({ method: "notifications/tools/list_changed" });
      }
      // Status is the model's bootstrap when only this tool was discovered.
      // Waiting for a host tools/list refresh here strands prepared services.
      // bind() still enforces the project/instance preparation permission.
      await ensureBinding(method !== "tools/list");
      if (pending.cancelled) throw new ConfigError("Request cancelled before dispatch; not executed");
      if (method === "tools/list") {
        if (client && client === previous) await refreshTools();
        result = { tools: [...controlTools(), ...tools] };
      } else if (
        method === "tools/call" &&
        params.name === "core_runtime_status"
      ) {
        const status = {
          ready: !!client && !client.error,
          state: client?.error ? "error" : client ? "connected" : "disconnected",
          component,
          detail: lastError,
          selectedDirectory: selected,
          selectionSource: selection.source,
          nativeToolCount: tools.length,
          toolAccess: "Use core_runtime_tools for live schemas and core_runtime_call if native tools are absent from the host catalogue. Both accept this chat's projectRoot for empty host roots.",
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
        result = { content: [], structuredContent: { binding: bindingContext, tools: names ? tools.filter(tool => names.includes(tool.name)) : tools } };
      } else if (client && control && params.name === "core_runtime_call") {
        const owner = client, ownerBinding = bindingContext, epoch = generation, results = [];
        for (const call of params.arguments.calls) {
          let dispatched = false;
          try {
            if (pending.cancelled || client !== owner || epoch !== generation) throw new ConfigError("Runtime batch interrupted before the next call; completed calls were not rolled back");
            await refreshNotifiedTools();
            validateNative(call);
            pending.client = owner;
            diagnostic.event("native_request_started", { requestId: id, tool: call.name, projectRoot: selected });
            dispatched = true;
            const native = await owner.request("tools/call", { ...call, ...(params._meta ? { _meta: params._meta } : {}) }, { onId: value => { pending.upstreamId = value; } });
            results.push({ name: call.name, result: native });
            diagnostic.event("native_request_completed", { requestId: id, tool: call.name, projectRoot: selected, isError: Boolean(native.isError) });
            if (call.name === "enable_toolset") toolsDirty = true;
            if (native.isError) break;
          } catch (error) {
            diagnostic.event("native_request_failed", { requestId: id, tool: call.name, projectRoot: ownerBinding?.projectRoot, error }, "error");
            results.push({ name: call.name, error: { message: error.message, outcome: dispatched ? "unknown" : "not_executed", ...(error.code ? { code: error.code } : {}) } });
            if (error instanceof RemoteSessionExpired) {
              await disconnect(); currentRevision = null; lastError = error.message;
            }
            break;
          }
        }
        const failed = Boolean(results.at(-1)?.error || results.at(-1)?.result?.isError);
        result = { content: results.flatMap(entry => entry.result ? entry.result.content || [] : [{ type: "text", text: entry.error.message }]),
          structuredContent: { binding: ownerBinding, results, completed: results.filter(entry => entry.result && !entry.result.isError).length, requested: params.arguments.calls.length },
          ...(failed ? { isError: true } : {}) };
      } else if (client) {
        const keys = {
            "resources/list": "resources",
            "resources/templates/list": "resourceTemplates",
            "prompts/list": "prompts",
          },
          key = keys[method];
        if (method === "tools/call") checkAlias(params);
        pending.client = client;
        if (key) {
          try {
            result = await client.request(method, params, { onId: value => { pending.upstreamId = value; } });
          } catch (error) {
            if (error.code !== -32601)
              throw error;
            result = { [key]: [] };
          }
        } else {
          pending.client = client;
          result = await client.request(method, params, { onId: value => { pending.upstreamId = value; } });
        }
      } else
        throw new ConfigError(
          rootsPending ? "Ожидается каталог проекта." : lastError,
        );
    }
    if (method === "tools/call") diagnostic.event("request_completed", { requestId: id, tool: message.params?.name, projectRoot: selected,
      durationMs: Date.now() - started, isError: Boolean(result?.isError), binding: bindingContext }, result?.isError ? "error" : "info");
    emit({ id, result });
    if (method === "tools/call" && client && params.name === "enable_toolset") {
      toolsDirty = true;
    }
  } catch (error) {
    diagnostic.event("request_failed", { requestId: id, method, tool: message.params?.name, projectRoot: selected, durationMs: Date.now() - started, error }, "error");
    if (error instanceof RemoteSessionExpired) {
      await disconnect();
      currentRevision = null;
      lastError = error.message;
    }
    emit({ id, error: { code: -32000, message: error.message } });
  } finally {
    requests.delete(requestKey(id));
  }
}
let queue = Promise.resolve(),
  closed = false,
  idleQueued = false;
const enqueue = (action) => {
  queue = queue.then(action).catch((error) => {
    process.stderr.write(error.message + "\n");
  });
};
read_lines(process.stdin, message => {
  if (!message.method && callbacks.has(message.id)) { callbacks.get(message.id)(message); callbacks.delete(message.id); return; }
  void dispatch(message).catch(error => process.stderr.write(error.message + "\n"));
}, error => { process.stderr.write(error.message + "\n"); shutdown(); });
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
