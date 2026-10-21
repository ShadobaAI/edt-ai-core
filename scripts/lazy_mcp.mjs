// Connection-owned project binding. Host requests and idle refresh share one queue.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { ROOT, ConfigError, settings, stable, argumentsOf } from "./common.mjs";
import {
  state_root,
  resolve,
  exists,
  reconnect_file,
  instance_name,
  select_root,
  sha256,
} from "./project_paths.mjs";
import { context_revision, effective_settings } from "./project_context.mjs";
import { project_profile } from "./profile.mjs";
import { McpClient } from "./mcp_client.mjs";
import { all_pages } from "./mcp_pages.mjs";
import {
  RemoteMcp,
  RemoteSessionExpired,
  RemoteRpcError,
} from "./remote_client.mjs";
import { validate_bsl_tools } from "./runtime.mjs";

const component = argumentsOf(undefined, [], ["component"]).component;
if (!["edt", "v8std", "code-index", "bsl-ls"].includes(component))
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
  bindingContext = null;
let selected = process.env.EDT_AI_PROJECT_ROOT
    ? resolve(process.env.EDT_AI_PROJECT_ROOT)
    : null,
  selectionError = null,
  rootsPending = null,
  rootsCounter = 0,
  initialized = false;
let lastError = "Выберите каталог проекта с .ai/project.yaml.";
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const emit = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
async function disconnect() {
  const previous = client;
  client = null;
  tools = [];
  toolsRevision = null;
  toolsDirty = false;
  bindingContext = null;
  if (previous) await previous.close();
}
async function requestRoots() {
  await disconnect();
  currentRevision = null;
  rootsPending = "core-roots-" + ++rootsCounter;
  emit({ id: rootsPending, method: "roots/list", params: {} });
}
function configContext() {
  const config = settings(configuration);
  if (selectionError) throw new ConfigError(selectionError);
  let directory = selected || process.cwd();
  if (!selected && resolve(directory) === ROOT && config.active_project)
    directory = config.active_project;
  const [root, profileRevision] = context_revision(directory),
    data = project_profile(root);
  return [
    root,
    effective_settings(config, root, data, null, state),
    profileRevision,
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
async function ensureBinding(refreshSurface = true, retryFailed = true) {
  if (rootsPending) return;
  let revision = null;
  try {
    const [root, config, profileRevision] = configContext(),
      token = reconnect_file(state, root);
    revision = stable([
      config,
      root,
      profileRevision,
      exists(token) ? fs.readFileSync(token, "utf8") : "",
    ]);
    if (revision === failedRevision && !retryFailed) return;
    if (client && revision === currentRevision) {
      if (refreshSurface) await refreshNotifiedTools();
      return;
    }
    await disconnect();
    currentRevision = revision;
    let candidate, url;
    if (["edt", "v8std"].includes(component)) {
      url = config.mcp.required[component].url;
      if (!url)
        throw new ConfigError(
          `Укажите connections.${component}.url в профиле проекта.`,
        );
      candidate = new RemoteMcp(url, component === "v8std" ? 60 : 30);
    } else
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
      );
    try {
      await candidate.initialize();
      toolsRevision = candidate.tools_revision;
      tools = (await all_pages(candidate, "tools/list", "tools")).tools;
      if (component === "bsl-ls") validate_bsl_tools(tools);
      toolsDirty = false;
    } catch (error) {
      await candidate.close();
      currentRevision = null;
      throw error;
    }
    client = candidate;
    failedRevision = null;
    lastError = "";
    if (component === "v8std")
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
        if (message.error)
          throw new ConfigError("Host could not supply the selected directory");
        selected = select_root(message.result?.roots || [], process.cwd());
        selectionError = null;
      } catch (error) {
        selected = null;
        selectionError = error.message;
      }
    }
    return;
  }
  if (!Object.hasOwn(message, "id")) {
    if (method === "notifications/initialized") initialized = true;
    else if (
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
          serverInfo: { name: "1c-ai-" + component, version: "0.1.1" },
          capabilities: {
            tools: { listChanged: true },
            resources: {},
            prompts: {},
          },
        };
      if (component === "v8std")
        result.instructions =
          "For a new v8std binding, read core_runtime_status once for the selected project/instance and negotiated server instructions/capabilities. Select operations from their live schemas; reuse discovery until binding, contract or relevant evidence changes. A shared corpus does not share project assessments.";
      if (component === "bsl-ls")
        result.instructions =
          "Use the assigned EDT-MCP to discover configuration project names and paths. Register the exact configuration directory with register_workspace_folder, then use file paths or the returned workspaceFolder URI to select its context. Several folders may remain registered; no active configuration is shared. Only directories inside the selected project binding are accepted.";
      emit({ id, result });
      if (message.params?.capabilities?.roots != null && selected === null)
        await requestRoots();
      return;
    }
    let result;
    const params = message.params || {};
    if (method === "ping") result = {};
    else {
      const previous = client;
      await ensureBinding(method !== "tools/list");
      if (method === "tools/list") {
        if (client && client === previous) await refreshTools();
        let visible = tools;
        if (
          component === "v8std" &&
          !tools.some((tool) => tool.name === "core_runtime_status")
        )
          visible = [statusTool(), ...tools];
        result = { tools: visible.length ? visible : [statusTool()] };
      } else if (
        method === "tools/call" &&
        params.name === "core_runtime_status"
      ) {
        const status = {
          ready: !!client,
          component,
          detail: lastError,
          selectedDirectory: selected,
        };
        if (component === "v8std") {
          status.binding = bindingContext;
          if (client)
            status.serverContract = Object.fromEntries(
              ["instructions", "capabilities"]
                .filter((key) => key in client.initialization)
                .map((key) => [key, client.initialization[key]]),
            );
        }
        result = {
          content: [
            {
              type: "text",
              text:
                component === "v8std"
                  ? JSON.stringify(status)
                  : lastError || "Готов",
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
        if (key && !params.cursor) {
          try {
            result = await all_pages(client, method, key);
          } catch (error) {
            if (!(error instanceof RemoteRpcError) || error.code !== -32601)
              throw error;
            result = { [key]: [] };
          }
        } else result = await client.request(method, params);
      } else
        throw new ConfigError(
          rootsPending ? "Ожидается каталог проекта." : lastError,
        );
    }
    emit({ id, result });
    if (method === "tools/call" && client && params.name === "enable_toolset") {
      toolsDirty = true;
      emit({ method: "notifications/tools/list_changed" });
    }
  } catch (error) {
    if (error instanceof RemoteSessionExpired) {
      await disconnect();
      currentRevision = null;
      lastError = error.message;
    }
    emit({ id, error: { code: -32000, message: error.message } });
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
const input = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});
input.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  enqueue(() => dispatch(message));
});
const timer = setInterval(() => {
  if (initialized && !closed && !idleQueued) {
    idleQueued = true;
    enqueue(async () => {
      try {
        if (!closed) await ensureBinding(true, false);
      } finally {
        idleQueued = false;
      }
    });
  }
}, 500);
input.once("close", () => {
  closed = true;
  clearInterval(timer);
  enqueue(disconnect);
});
const shutdown = () => {
  closed = true;
  clearInterval(timer);
  input.close();
  enqueue(disconnect);
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
