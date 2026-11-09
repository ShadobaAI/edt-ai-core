// A local test host for the MCP App. The app resource and tools come from the
// real settings server; only the surrounding postMessage host is simulated.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dump, load } from "../../scripts/common.mjs";
import { McpClient } from "../../scripts/mcp_client.mjs";
import { remember_profile } from "../../scripts/profile_history.mjs";
import { profile_state } from "../../scripts/profile.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const hostPage = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<style>html,body,iframe{margin:0;border:0;width:100%;height:100%}</style></head>
<body><iframe id="app" title="Settings" src="/settings" sandbox="allow-scripts allow-same-origin"></iframe>
<script>
const frame = document.getElementById('app');
window.hostMessages = [];
window.addEventListener('message', async event => {
  if (event.source !== frame.contentWindow || event.origin !== location.origin) return;
  const message = event.data;
  if (!message || message.jsonrpc !== '2.0') return;
  window.hostMessages.push(message);
  if (!Object.hasOwn(message, 'id')) return;
  let response;
  try {
    if (message.method === 'ui/initialize') {
      response = { result: { protocolVersion: '2026-01-26', hostInfo: { name: 'Playwright fixture', version: '1.0' },
        hostCapabilities: {}, hostContext: { displayMode: 'fullscreen', theme: 'light' } } };
    } else if (message.method === 'tools/call') {
      const reply = await fetch('/rpc', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(message.params) });
      if (!reply.ok) throw new Error('Test host request failed: ' + reply.status);
      response = await reply.json();
    } else if (message.method === 'ui/request-display-mode') {
      response = { result: { mode: 'fullscreen' } };
    } else {
      response = { error: { code: -32601, message: 'Unsupported host method: ' + message.method } };
    }
  } catch (error) { response = { error: { code: -32603, message: error.message } }; }
  frame.contentWindow.postMessage({ jsonrpc: '2.0', id: message.id, ...response }, location.origin);
});
</script></body></html>`;

export async function startHost() {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "core-ui-e2e-")));
  const project = path.join(base, "Product"), other = path.join(base, "Other"), state = path.join(base, "state");
  let client, server;
  try {
    fs.mkdirSync(state);
    const profile = load(path.join(root, "profiles/generic-1c/profile.yaml"));
    profile.repositories = [{ id: "product", path: ".", alias: "product", edt_project: "Product" }];
    profile.roots = { source: ["src"], protected: ["src"] };
    for (const [directory, id] of [[project, "Product"], [other, "Other"]]) {
      fs.mkdirSync(path.join(directory, "src"), { recursive: true });
      dump({ ...profile, project: { ...profile.project, id } }, path.join(directory, ".ai/project.yaml"));
    }
    for (const directory of [project, other]) {
      if (!remember_profile(state, directory, profile_state(directory))) throw new Error("Could not seed test profile history");
    }
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("EDT_AI_")));
    Object.assign(env, { EDT_AI_PROJECT_ROOT: project, EDT_AI_STATE_DIR: state,
      EDT_AI_SETTINGS: path.join(state, "settings.json"), EDT_AI_INSTANCE: "test" });
    client = new McpClient([process.execPath, path.join(root, "mcp/settings.mjs")], project, env, 30);
    await client.initialize();
    const resource = await client.request("resources/read", { uri: "ui://1c-ai-core/settings.html" });
    const html = resource.contents?.find(item => item.uri === "ui://1c-ai-core/settings.html")?.text;
    if (!html) throw new Error("Settings MCP did not return the app resource");
    const calls = [], failures = new Map();
    server = http.createServer(async (request, response) => {
      try {
        if (request.method === "GET" && ["/", "/settings"].includes(request.url)) {
          response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          response.end(request.url === "/" ? hostPage : html);
          return;
        }
        if (request.method !== "POST" || request.url !== "/rpc" || request.headers.origin !== `http://127.0.0.1:${server.address().port}`) {
          response.writeHead(404).end();
          return;
        }
        let input = "";
        for await (const chunk of request) {
          input += chunk;
          if (input.length > 1024 * 1024) throw new Error("Test request is too large");
        }
        const params = JSON.parse(input);
        calls.push(params);
        const failure = failures.get(params.name);
        let result;
        if (failure) {
          failures.delete(params.name);
          result = { isError: true, content: [{ type: "text", text: failure }] };
        } else result = await client.request("tools/call", params);
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ result }));
      } catch (error) {
        response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: error.message }));
      }
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    return {
      url: `http://127.0.0.1:${server.address().port}/`, project, other, state, calls, client,
      failNext(name, message) { failures.set(name, message); },
      async close() {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await client.close();
        await fs.promises.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      },
    };
  } catch (error) {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    if (client) await client.close();
    await fs.promises.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    throw error;
  }
}
