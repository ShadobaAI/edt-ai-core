import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
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

// Exercise the real settings MCP and backend while substituting only the
// user-operated OS dialog. This is not evidence of native window behavior.
export async function dialog_session(t, f, { extra = {}, roots } = {}) {
  const plugin = path.join(f.base, "dialog-plugin"), choice = path.join(f.base, "dialog-choice.json");
  for (const dir of ["mcp", "scripts", "assets", "settings"]) fs.mkdirSync(path.join(plugin, dir), { recursive: true });
  for (const file of ["plugin.json", "mcp/settings.mjs", "mcp/settings-operations.mjs", "assets/icon.svg", "settings/defaults.json"])
    fs.copyFileSync(path.join(ROOT, file), path.join(plugin, file));
  for (const name of ["selection", "compatibility", "icons", "diagnostics", "project_paths", "common", "profile", "settings_export", "support_bundle"])
    fs.writeFileSync(path.join(plugin, "scripts", name + ".mjs"), `export * from ${JSON.stringify(pathToFileURL(path.join(ROOT, "scripts", name + ".mjs")).href)};`);
  fs.writeFileSync(path.join(plugin, "scripts/settings_folder.mjs"), `import fs from 'node:fs'; export async function folder_action() { return JSON.parse(fs.readFileSync(${JSON.stringify(choice)}, 'utf8')).path; }`);
  fs.writeFileSync(path.join(plugin, "scripts/settings_backend.mjs"),
    `import { SettingsBackend } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "scripts/settings_backend.mjs")).href)}; let input=''; for await (const chunk of process.stdin) input+=chunk; try { console.log(JSON.stringify({ok:true,result:await new SettingsBackend().main(JSON.parse(input))})); } catch(error) { console.log(JSON.stringify({ok:false,error:error.message})); process.exitCode=1; }`);
  // These tests exercise the Windows dialog branch even on non-Windows CI.
  const entry = path.join(plugin, "dialog-entry.mjs");
  fs.writeFileSync(entry, `Object.defineProperty(process, 'platform', { value: 'win32' }); await import('./mcp/settings.mjs');`);
  const client = new McpClient([process.execPath, entry], f.root, { ...f.env, ...extra }, 10);
  f.clients.push(client); if (roots !== undefined) client.roots = roots; await client.initialize();
  return { client, choose: file => fs.writeFileSync(choice, JSON.stringify({ path: file })) };
}
