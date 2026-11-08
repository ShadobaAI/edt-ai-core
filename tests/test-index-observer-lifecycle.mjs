import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { edt_fixture as fixture, environment, ROOT } from "./helpers.mjs";
import { SettingsBackend } from "../scripts/settings_backend.mjs";
import { IndexObserverProxy } from "../scripts/index_observer_proxy.mjs";
import { active_readers, daemon_health, ensure_daemon, stop_daemon } from "../scripts/runtime.mjs";
import { spawn_guarded_linux } from "../scripts/processes.mjs";
import { pin_linux_process } from "../scripts/unix_process.mjs";
import { spawn_detached_windows } from "../scripts/windows_process.mjs";
import { grant_preparation } from "../scripts/components.mjs";
import { sha256 } from "../scripts/project_paths.mjs";

test("observation survives its session crash and releases the reader without stopping another session", {
  skip: process.platform !== "win32" && (process.platform !== "linux" || process.arch !== "x64"), timeout: 90000,
}, async t => {
  const f = fixture(t, { preserveOnCleanupFailure: true }); environment(t, f.env); f.save();
  const backend = new SettingsBackend();
  await backend.main({ action: "update", set: { codeIndexEnabled: true } });
  grant_preparation(f.state, f.root, ["code-index"]);
  const config = backend.effective(backend.current()), bytes = fs.readFileSync(process.execPath);
  const exe = path.join(f.state, "runtime/code-index/fixture", sha256(bytes), process.platform === "win32" ? "reader.exe" : "reader");
  fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.writeFileSync(exe, bytes, { mode: 0o755 });
  fs.mkdirSync(path.join(f.root, ".code-index")); fs.writeFileSync(path.join(f.root, ".code-index/index.db"), "fixture");
  const daemonFixture = path.join(ROOT, "tests/fixtures/index-daemon.mjs");
  let home, started = false, owner, ownerClosed, second;
  const cleanup = async () => {
    if (owner && owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
    if (ownerClosed) await ownerClosed;
    if (second) { await second.close(); second = null; }
    if (started) { await stop_daemon(f.state, f.root); started = false; }
  };
  f.clients.push({ close: cleanup });
  try {
    home = await ensure_daemon(f.state, f.root, f.profile, exe, { launch: (command, _args, options) =>
      process.platform === "win32" ? spawn_detached_windows(command, [daemonFixture], options) : spawn_guarded_linux(command, [daemonFixture], options) }, f.env);
    started = true;
    const daemonBefore = await daemon_health(home);
    const health = { mcp: { status: "ok" }, daemon: { status: "online" }, repos: [{ repo: "product", root_path: f.root,
      path_status: { status: "ready" }, data_version: { stale: false } }] };
    fs.writeFileSync(path.join(home, "serve"), `const readline=require('node:readline');
      readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!Object.hasOwn(m,'id'))return;
        const result=m.method==='initialize'?{protocolVersion:'2025-11-25',serverInfo:{name:'fixture',version:'1'},capabilities:{tools:{}}}:
          m.method==='tools/list'?{tools:[{name:'health',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:JSON.stringify(${JSON.stringify(health)})}]};
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`);
    const proxyModule = pathToFileURL(path.join(ROOT, "scripts/index_observer_proxy.mjs")).href;
    const code = `import {IndexObserverProxy} from ${JSON.stringify(proxyModule)};
      const p=new IndexObserverProxy(${JSON.stringify(f.state)});
      const r=await p.observe(${JSON.stringify(config)},${JSON.stringify(f.root)},${JSON.stringify(f.profile)});
      console.log(r.index_state); setInterval(()=>{},1000);`;
    owner = spawn(process.execPath, ["--input-type=module", "-e", code], { cwd: f.root, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
    ownerClosed = once(owner, "close");
    const [data] = await Promise.race([once(owner.stdout, "data"), new Promise((_, reject) => {
      setTimeout(() => reject(new Error("observer fixture did not start")), 30000).unref();
    })]);
    assert.equal(String(data).trim(), "ready");
    const first = await active_readers(f.state, f.root); assert.equal(first.length, 1);
    second = new IndexObserverProxy(f.state);
    assert.equal((await second.observe(config, f.root, f.profile)).index_state, "ready");
    assert.equal((await active_readers(f.state, f.root))[0].id, first[0].id);
    owner.kill("SIGKILL"); await ownerClosed;
    const deadline = Date.now() + 15000;
    while ((await active_readers(f.state, f.root)).length && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(await active_readers(f.state, f.root), []);
    assert.equal((await second.observe(config, f.root, f.profile)).index_state, "ready");
    const cli = spawn(process.execPath, [path.join(ROOT, "scripts/settings_backend.mjs")], { cwd: f.root, env: f.env, stdio: ["pipe", "pipe", "pipe"] });
    let output = ""; cli.stdout.setEncoding("utf8"); cli.stdout.on("data", chunk => { output += chunk; });
    const cliClosed = once(cli, "close"); cli.stdin.end(JSON.stringify({ action: "probe", component: "code-index" }));
    assert.equal((await cliClosed)[0], 0, output);
    assert.equal(JSON.parse(output).result.componentChecks[0].state, "ready");
    // A standalone backend has no MCP parent to cancel a stuck observer.
    const preload = path.join(f.base, "stalled-observer.mjs");
    fs.writeFileSync(preload, `import {IndexObserverProxy} from ${JSON.stringify(proxyModule)};
      const schedule=globalThis.setTimeout;
      globalThis.setTimeout=(fn,ms,...args)=>schedule(fn,ms===75000?100:ms,...args);
      IndexObserverProxy.prototype.observe=()=>new Promise(()=>{});`);
    const stalled = spawn(process.execPath, ["--import", pathToFileURL(preload).href, path.join(ROOT, "scripts/settings_backend.mjs")],
      { cwd: f.root, env: f.env, stdio: ["pipe", "pipe", "pipe"] });
    let stalledOutput = ""; stalled.stdout.setEncoding("utf8"); stalled.stdout.on("data", chunk => { stalledOutput += chunk; });
    const stalledClosed = once(stalled, "close"), killTimer = setTimeout(() => stalled.kill("SIGKILL"), 5000);
    stalled.stdin.end(JSON.stringify({ action: "probe", component: "code-index" }));
    let stalledCode;
    try { [stalledCode] = await stalledClosed; } finally { clearTimeout(killTimer); }
    assert.equal(stalledCode, 0, stalledOutput);
    const stalledCheck = JSON.parse(stalledOutput).result.componentChecks[0];
    assert.equal(stalledCheck.state, "error"); assert.match(stalledCheck.detail, /Истекло время наблюдения индекса/);
    assert.equal((await active_readers(f.state, f.root)).length, 1);
    if (process.platform === "linux") {
      const [replacement] = await active_readers(f.state, f.root), pin = pin_linux_process(replacement.pid);
      try {
        pin.signal(15);
        const stopDeadline = Date.now() + 15000;
        while ((await active_readers(f.state, f.root)).length && Date.now() < stopDeadline)
          await new Promise(resolve => setTimeout(resolve, 50));
        assert.deepEqual(await active_readers(f.state, f.root), []);
        while (second.socket && Date.now() < stopDeadline) await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(second.socket, null);
      } finally { pin.close(); }
      assert.equal((await second.observe(config, f.root, f.profile)).index_state, "ready");
    }
    assert.equal((await daemon_health(home)).pid, daemonBefore.pid);
  } finally { await cleanup(); }
});
