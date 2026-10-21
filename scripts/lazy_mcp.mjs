// Connection-owned binding. Control messages never wait for a running tool.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { ROOT, ConfigError, settings, stable, argumentsOf } from "./common.mjs";
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
import { launch_selection, roots_selection } from "./selection.mjs";
import { COMPONENTS, component_settings, component_enabled, binding_fingerprint, require_preparation } from "./components.mjs";
import { read_lines } from "./mcp_codec.mjs";
import { core_version } from "./compatibility.mjs";

const component = argumentsOf(undefined, [], ["component"]).component;
if (!Object.hasOwn(COMPONENTS, component))
  throw new ConfigError("Invalid --component");
const state = state_root(),
  configuration =
    process.env.EDT_AI_SETTINGS || path.join(state, "settings.json");
let client = null,
  currentRevision = null,
  failedRevision = null,
  tools = [],
  toolsRevision = null,
  toolsDirty = false,
  bindingContext = null,
  connectingClient = null;
let boundAliases = new Set();
let selection = launch_selection();
let selected = selection.directory,
  selectionError = null,
  rootsPending = null,
  rootsCounter = 0,
  initialized = false;
let lastError = "Выберите каталог проекта с .ai/project.yaml.";
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const emit = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
async function disconnect() {
  generation++;
  const previous = client;
  const connecting = connectingClient;
  const hadTools = tools.length > 0;
  connectingClient = null;
  client = null;
  tools = [];
  toolsRevision = null;
  toolsDirty = false;
  bindingContext = null;
  boundAliases.clear();
  if (hadTools && !closed) emit({ method: "notifications/tools/list_changed" });
  if (previous) await previous.close();
  if (connecting && connecting !== previous) await connecting.close();
}
async function requestRoots() {
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
      onRequest: message => message.method === "roots/list" ? { roots: [{ uri: pathToFileURL(root).href, name: path.basename(root) }] } : callback(message),
      maxBytes: options.max_response_bytes,
      onNotification: message => {
        if (message.method === "notifications/tools/list_changed") toolsDirty = true;
        else if (client && !closed) emit(message);
      } };
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
    emit({ method: "notifications/tools/list_changed" });
  } catch (error) {
    await disconnect();
    failedRevision = revision;
    if (revision === null) currentRevision = null;
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
      : "Read the service state for the selected repository profile.",
  inputSchema: { type: "object", additionalProperties: false },
  annotations: { readOnlyHint: true },
});
async function dispatch(message) {
  if (!message || typeof message !== "object") return;
  const id = message.id,
    method = message.method;
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
          serverInfo: { name: "1c-ai-" + component, version: core_version, icons: component_icons(component) },
          capabilities: {
            tools: { listChanged: true },
            resources: {},
            prompts: {},
          },
        };
      hostCapabilities = message.params?.capabilities || {};
      result.instructions = "For each new binding read core_runtime_status once for the selected project/instance and the native server instructions/capabilities. Reuse that contract until the binding changes. Native tools and results retain their full schemas. Managed services require initial preparation in settings; profile inspection does not start them.";
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
    const pending = { cancelled: false };
    requests.set(requestKey(id), pending);
    if (method === "ping") result = {};
    else {
      const previous = client;
      await ensureBinding(method !== "tools/list", true, COMPONENTS[component].kind === "remote" || !(method === "tools/call" && params.name === "core_runtime_status"));
      if (pending.cancelled) throw new ConfigError("Request cancelled before dispatch; not executed");
      if (method === "tools/list") {
        if (client && client === previous) await refreshTools();
        let visible = tools;
        if (
          !tools.some((tool) => tool.name === "core_runtime_status")
        )
          visible = [statusTool(), ...tools];
        result = { tools: visible.length ? visible : [statusTool()] };
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
                JSON.stringify(status),
            },
          ],
          structuredContent: status,
        };
      } else if (client) {
        const keys = {
            "resources/list": "resources",
            "resources/templates/list": "resourceTemplates",
            "prompts/list": "prompts",
          },
          key = keys[method];
        if (component === "code-index" && method === "tools/call" && Object.hasOwn(params.arguments || {}, "repo")) {
          if (!boundAliases.has(params.arguments.repo))
            throw new ConfigError("code-index alias is outside the selected project profile");
        }
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
    emit({ id, result });
    if (method === "tools/call" && client && params.name === "enable_toolset") {
      toolsDirty = true;
    }
  } catch (error) {
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
