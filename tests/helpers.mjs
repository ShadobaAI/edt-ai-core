import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { ROOT, load, dump } from "../scripts/common.mjs";
import { McpClient } from "../scripts/mcp_client.mjs";
export { ROOT };
// Protected local process trees deliberately fail closed on macOS. Tests that
// require a successful local launch run on Windows and Linux instead.
export const protected_process_skip = process.platform === "darwin" ? "protected local processes are unavailable on macOS" : false;
export function fixture(t, { preserveOnCleanupFailure = false } = {}) {
  const base = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "core fixture Юникод ")),
    ),
    root = path.join(base, "Product"),
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
    const failures = [];
    for (const client of clients) try { await client.close(); } catch (error) { failures.push(error); }
    if (failures.length && preserveOnCleanupFailure)
      throw new AggregateError(failures, "Fixture cleanup was not confirmed; preserved at " + base);
    // Windows may briefly retain cwd/stdio handles after a process exits.
    try { await fs.promises.rm(base, {
      recursive: true, force: true, maxRetries: 10, retryDelay: 100,
    }); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Fixture cleanup was not confirmed");
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
export function edt_fixture(t, options) {
  const f = fixture(t, options);
  fs.writeFileSync(path.join(f.root, ".project"), "<projectDescription><name>Product</name></projectDescription>");
  return f;
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
// Async tests must not block their event loop while a CLI fixture runs.
export function node_async(file, args = [], options = {}) {
  const { input, ...execution } = options;
  return new Promise(resolve => {
    const child = execFile(process.execPath, [path.resolve(ROOT, file), ...args], {
      encoding: "utf8", windowsHide: true, shell: false,
      timeout: 20000, killSignal: "SIGKILL", ...execution,
    }, (error, stdout, stderr) => resolve({
      error: error && typeof error.code !== "number" ? error : undefined,
      status: child.exitCode, signal: child.signalCode, stdout, stderr,
    }));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
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
export async function dialog_session(t, f, { extra = {}, roots, platform = "win32" } = {}) {
  const plugin = path.join(f.base, "dialog-plugin"), choice = path.join(f.base, "dialog-choice.json"), opened = path.join(f.base, "dialog-opened"), released = path.join(f.base, "dialog-released");
  for (const dir of ["mcp", "scripts", "assets", "settings"]) fs.mkdirSync(path.join(plugin, dir), { recursive: true });
  for (const file of ["plugin.json", "mcp/settings.mjs", "mcp/settings-operations.mjs", "assets/icon.svg", "settings/defaults.json"])
    fs.copyFileSync(path.join(ROOT, file), path.join(plugin, file));
  for (const name of ["selection", "compatibility", "icons", "diagnostics", "project_paths", "common", "profile", "settings_export", "support_bundle", "mcp_codec", "setup_readiness"])
    fs.writeFileSync(path.join(plugin, "scripts", name + ".mjs"), `export * from ${JSON.stringify(pathToFileURL(path.join(ROOT, "scripts", name + ".mjs")).href)};`);
  // The protected process boundary is covered by real host OS tests.
  fs.writeFileSync(path.join(plugin, "scripts/processes.mjs"), `import {spawn} from 'node:child_process';
    export function launch(command,args,{readerJob,...options}) { return spawn(command,args,options); }
    export async function stop_child(child) { if(child.exitCode!==null||child.signalCode!==null)return; child.kill('SIGKILL'); await new Promise(resolve=>child.once('close',resolve)); }`);
  fs.writeFileSync(path.join(plugin, "scripts/settings_folder.mjs"), `import fs from 'node:fs'; export const folder_actions_supported = () => ${platform === "win32"}; export async function folder_action() { const choice=JSON.parse(fs.readFileSync(${JSON.stringify(choice)}, 'utf8')); if(choice.error) throw Object.assign(new Error(choice.error.message), {code:choice.error.code}); if(choice.hold) { fs.writeFileSync(${JSON.stringify(opened)},'open'); const until=Date.now()+10000; while(!fs.existsSync(${JSON.stringify(released)})) { if(Date.now()>until) throw new Error('Dialog fixture timed out'); await new Promise(resolve=>setTimeout(resolve,10)); } } return choice.path; }`);
  fs.writeFileSync(path.join(plugin, "scripts/settings_backend.mjs"),
    `import { SettingsBackend } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "scripts/settings_backend.mjs")).href)}; let input=''; for await (const chunk of process.stdin) input+=chunk; try { console.log(JSON.stringify({ok:true,result:await new SettingsBackend().main(JSON.parse(input))})); } catch(error) { console.log(JSON.stringify({ok:false,error:error.message})); process.exitCode=1; }`);
  // Simulate only the folder UI capability; diagnostic and path identity must
  // use the host platform in both the MCP process and the test process.
  const client = new McpClient([process.execPath, path.join(plugin, "mcp/settings.mjs")], f.root, { ...f.env, ...extra }, 10);
  f.clients.push(client); if (roots !== undefined) client.roots = roots; await client.initialize();
  return { client, choose: file => fs.writeFileSync(choice, JSON.stringify({ path: file })), failDialog: error => fs.writeFileSync(choice, JSON.stringify({ error })),
    holdDialog: file => {
      fs.writeFileSync(choice, JSON.stringify({ path: file, hold: true }));
      return { wait: async () => { const until = Date.now() + 10000; while (!fs.existsSync(opened)) { if (Date.now() > until) throw new Error("Dialog fixture did not open"); await new Promise(resolve => setTimeout(resolve, 10)); } },
        release: () => fs.writeFileSync(released, "release") };
    } };
}
