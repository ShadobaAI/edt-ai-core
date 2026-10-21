import readline from "node:readline";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { launch, stop_child } from "./processes.mjs";
export class McpClient {
  constructor(command, cwd, env = process.env, timeout = 60) {
    this.timeout = timeout * 1000;
    this.root = path.resolve(cwd);
    this.roots = [
      { uri: pathToFileURL(this.root).href, name: path.basename(this.root) },
    ];
    this.stderr = "";
    this.sequence = 0;
    this.tools_revision = 0;
    this.pending = new Map();
    this.process = launch(command[0], command.slice(1), {
      cwd,
      env: env || process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-16000);
    });
    this.process.stdin.on("error", () => {});
    this.process.once("error", (error) => this.fail(error));
    this.process.once("close", () =>
      this.fail(new Error("MCP exited: " + this.stderr.slice(-4000))),
    );
    readline
      .createInterface({ input: this.process.stdout, crlfDelay: Infinity })
      .on("line", (line) => {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (message.method === "notifications/tools/list_changed")
          this.tools_revision++;
        if (message.method && Object.hasOwn(message, "id")) {
          this.send(
            message.method === "roots/list"
              ? { id: message.id, result: { roots: this.roots } }
              : {
                  id: message.id,
                  error: { code: -32601, message: "Not supported" },
                },
          );
        } else if (this.pending.has(message.id)) {
          const done = this.pending.get(message.id);
          this.pending.delete(message.id);
          done(message);
        }
      });
  }
  fail(error) {
    this.error = error;
    for (const done of this.pending.values())
      done({ error: { message: error.message } });
    this.pending.clear();
  }
  send(message) {
    this.process.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n",
    );
  }
  request(method, params = {}) {
    if (this.error) return Promise.reject(this.error);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `MCP ${method} timed out; outcome unknown: ${this.stderr.slice(-2000)}`,
          ),
        );
      }, this.timeout);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) {
          const error = new Error(`MCP ${method}: ${message.error.message}`);
          error.code = message.error.code;
          reject(error);
        } else resolve(message.result);
      });
      this.send({ id, method, params });
    });
  }
  notify(method, params = {}) {
    this.send({ method, params });
  }
  async initialize() {
    const result = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { roots: { listChanged: false } },
      clientInfo: { name: "1c-ai-core-doctor", version: "0.1.0" },
    });
    this.initialization = result;
    this.notify("notifications/initialized");
    return result;
  }
  async call(name, args) {
    const result = await this.request("tools/call", { name, arguments: args });
    if (result.isError)
      throw new Error(`${name}: ${JSON.stringify(result).slice(0, 4000)}`);
    return result;
  }
  async close() {
    await stop_child(this.process);
  }
}
