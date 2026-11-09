// Inspect a disposable settings session without reading or writing user state.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "core-inspector-"));
try {
  const project = path.join(scratch, "project");
  fs.mkdirSync(project);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("EDT_AI_")));
  Object.assign(env, {
    EDT_AI_PROJECT_ROOT: project,
    EDT_AI_STATE_DIR: path.join(scratch, "state"),
    EDT_AI_SETTINGS: path.join(scratch, "settings.json"),
    MCP_CATALOG_PATH: path.join(scratch, "catalog.json"),
    MCP_CLIENT_CONFIG_PATH: path.join(scratch, "client.json"),
  });
  const inspector = path.join(root, "node_modules/@modelcontextprotocol/inspector/clients/launcher/build/index.js");
  const server = path.join(root, "mcp/settings.mjs");
  const result = spawnSync(process.execPath, [inspector, "--cli", process.execPath, server,
    "--method", "tools/list", "--strict", "--format", "json"], {
    cwd: project, env, encoding: "utf8", timeout: 60000, maxBuffer: 32 * 1024 * 1024, windowsHide: true,
  });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    throw new Error(`MCP Inspector failed with exit code ${result.status}`);
  }
  const tools = JSON.parse(result.stdout).result?.tools;
  if (!Array.isArray(tools) || !tools.some(tool => tool.name === "settings.read"))
    throw new Error("MCP Inspector did not return the settings tool catalog");
  console.log(`MCP Inspector checked ${tools.length} settings tools.`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
