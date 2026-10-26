import { read_lines, DEFAULT_MAX_BYTES } from "./mcp_codec.mjs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { launch, stop_child } from "./processes.mjs";
import { core_version } from "./compatibility.mjs";
const localFailure = Symbol("local MCP failure");
export class McpClient {
  constructor(command, cwd, env = process.env, timeout = 60, options = {}) {
    this.options = options;
    this.timeout = timeout * 1000;
    this.root = path.resolve(cwd);
    this.roots = [
      { uri: pathToFileURL(this.root).href, name: path.basename(this.root) },
    ];
    this.stderr = "";
    this.stderrBytes = 0;
    this.sequence = 0;
    this.tools_revision = 0;
    this.pending = new Map();
    this.process = launch(command[0], command.slice(1), {
      cwd,
      env: env || process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process.stderr.on("data", (chunk) => {
      this.stderr = "[stderr omitted]";
      this.stderrBytes += chunk.length;
      this.options.onStderr?.(chunk);
    });
    this.process.stdin.on("error", () => {});
    this.process.once("error", (error) => this.fail(error));
    this.process.once("close", code =>
      this.fail(Object.assign(new Error("MCP exited (code " + code + "); stderr omitted; pending operation outcome unknown"), { outcomeUnknown: true })),
    );
    read_lines(this.process.stdout, (message) => {
        if (message.method === "notifications/tools/list_changed")
          this.tools_revision++;
        if (message.method && Object.hasOwn(message, "id")) {
          void (async () => {
            try {
              const result = message.method === "roots/list" ? { roots: this.roots }
                : this.options.onRequest ? await this.options.onRequest(message)
                  : await Promise.reject(Object.assign(new Error("Not supported"), { code: -32601 }));
              this.send({ id: message.id, result });
            } catch (error) { this.send({ id: message.id, error: { code: error.code || -32603, message: error.message } }); }
          })().catch(error => this.fail(error));
        } else if (this.pending.has(message.id)) {
          const done = this.pending.get(message.id);
          this.pending.delete(message.id);
          done(message);
        } else if (message.method) this.options.onNotification?.(message);
      }, (error) => { this.fail(error); void stop_child(this.process, 0); }, options.maxBytes || DEFAULT_MAX_BYTES);
  }
  fail(error) {
    if (this.error) return;
    this.error = error;
    for (const done of this.pending.values())
      done({ [localFailure]: error });
    this.pending.clear();
    this.options.onClose?.(error);
  }
  send(message) {
    if (this.error) throw this.error;
    this.process.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n",
    );
  }
  request(method, params = {}, options = {}) {
    if (this.error) return Promise.reject(this.error);
    const id = ++this.sequence;
    options.onId?.(id);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          Object.assign(new Error(`MCP ${method} timed out; outcome unknown; stderr omitted`), { outcomeUnknown: true }),
        );
      }, this.timeout);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        if (message[localFailure]) { reject(message[localFailure]); return; }
        if (message.error) {
          const error = new Error(`MCP ${method}: ${message.error.message}`);
          error.code = Number.isInteger(message.error.code) ? message.error.code : undefined;
          error.remote = true;
          reject(error);
        } else resolve(message.result);
      });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  notify(method, params = {}) {
    this.send({ method, params });
  }
  async initialize() {
    const result = await this.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: { ...this.options.capabilities, roots: { listChanged: false } },
      clientInfo: { name: "1c-ai-core", version: core_version },
    });
    this.initialization = result;
    this.notify("notifications/initialized");
    return result;
  }
  async call(name, args) {
    const result = await this.request("tools/call", { name, arguments: args });
    if (result.isError)
      throw Object.assign(new Error(`${name}: ${JSON.stringify(result).slice(0, 4000)}`), { remote: true });
    return result;
  }
  async close() {
    this.fail(Object.assign(new Error("MCP connection closed; pending operation outcome unknown"), { outcomeUnknown: true }));
    await stop_child(this.process);
  }
}
