import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const home = process.env.CODE_INDEX_HOME;
let checks = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  fs.appendFileSync(path.join(home, "reader-events.jsonl"), JSON.stringify({ method: message.method, pid: process.pid }) + "\n");
  if (!Object.hasOwn(message, "id")) continue;
  let result;
  if (message.method === "initialize") result = { protocolVersion: "2025-11-25", serverInfo: { name: "index-reader-fixture", version: "1" }, capabilities: { tools: {} } };
  else if (message.method === "tools/list") result = { tools: [{ name: "health", inputSchema: { type: "object" } }] };
  else if (message.method === "tools/call" && message.params.name === "health") {
    const { results } = JSON.parse(fs.readFileSync(path.join(home, "health-fixture.json"), "utf8"));
    const body = results[Math.min(checks++, results.length - 1)];
    result = body.isError ? body : { content: [{ type: "text", text: JSON.stringify(body) }] };
  } else throw new Error("Unexpected index reader request: " + message.method);
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
}
