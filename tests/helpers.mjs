import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { ROOT, load, dump } from "../scripts/common.mjs";
import { McpClient } from "../scripts/mcp_client.mjs";
export { ROOT };
export function fixture(t) {
  const base = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "core fixture Юникод ")),
    ),
    root = path.join(base, "project"),
    state = path.join(base, "state");
  fs.mkdirSync(root);
  fs.mkdirSync(state);
  const profile = load(path.join(ROOT, "profiles/generic-1c/profile.yaml"));
  profile.repositories = [
    { id: "product", path: ".", alias: "product", edt_project: "Product" },
  ];
  profile.roots = { source: ["src"], protected: ["src"] };
  fs.mkdirSync(path.join(root, "src"));
  const env = {
    ...process.env,
    EDT_AI_PROJECT_ROOT: root,
    EDT_AI_STATE_DIR: state,
    EDT_AI_SETTINGS: path.join(state, "settings.json"),
    EDT_AI_INSTANCE: "first",
  };
  for (const key of [
    "EDT_AI_CONNECTIONS_FILE",
    "EDT_AI_EDT_URL",
    "EDT_AI_V8STD_URL",
    "EDT_AI_OPENVIKING_URL",
  ])
    delete env[key];
  const save = () => dump(profile, path.join(root, ".ai/project.yaml"));
  const clients = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    // Windows may briefly retain cwd/stdio handles after a process exits.
    await fs.promises.rm(base, {
      recursive: true, force: true, maxRetries: 10, retryDelay: 100,
    });
  });
  return { base, root, state, profile, env, save, clients };
}
export function environment(t, env) {
  const previous = { ...process.env };
  for (const key of Object.keys(process.env))
    if (key.startsWith("EDT_AI_")) delete process.env[key];
  Object.assign(process.env, env);
  t.after(() => {
    for (const key of Object.keys(process.env))
      if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
}
export function node(file, args = [], options = {}) {
  return spawnSync(process.execPath, [path.resolve(ROOT, file), ...args], {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: 20000,
    ...options,
  });
}
export function success(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}
export async function session(t, file, args, f, extra = {}) {
  const client = new McpClient(
    [process.execPath, path.join(ROOT, file), ...args],
    f.root,
    { ...f.env, ...extra },
    10,
  );
  f.clients.push(client);
  await client.initialize();
  return client;
}
