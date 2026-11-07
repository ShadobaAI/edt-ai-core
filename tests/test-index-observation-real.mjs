import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { edt_fixture as fixture, environment, session } from "./helpers.mjs";
import { settings } from "../scripts/common.mjs";
import { sha256, project_directory } from "../scripts/project_paths.mjs";
import { grant_preparation } from "../scripts/components.mjs";
import { active_readers, daemon_health, index_config, observe_index, save_json, ensure_daemon, stop_daemon, read_json } from "../scripts/runtime.mjs";
import { SettingsBackend } from "../scripts/settings_backend.mjs";
import { launch, stop_child } from "../scripts/processes.mjs";
import { pin_windows_process, spawn_detached_windows } from "../scripts/windows_process.mjs";

// Explicit opt-in only: no test downloads a runtime or touches a user's index.
// The binary, daemon, database, configuration and logs live in the fixture.
test("the real Code Index reader uses an isolated runtime snapshot", { skip: !process.env.EDT_AI_TEST_REAL_INDEX, timeout: 120000 }, async t => {
  const trace = message => { if (process.env.EDT_AI_TEST_INDEX_TRACE === "1") process.stderr.write("fixture: " + message + "\n"); };
  const source = process.env.EDT_AI_TEST_REAL_INDEX;
  assert.ok(path.isAbsolute(source) && fs.statSync(source).isFile());
  const f = fixture(t); environment(t, f.env); f.save();
  await new SettingsBackend().main({ action: "update", set: { codeIndexEnabled: true } });
  fs.writeFileSync(path.join(f.root, "src", "Example.bsl"), "Процедура Пример() Экспорт\nКонецПроцедуры\n");
  const bytes = fs.readFileSync(source), hash = sha256(bytes), exe = path.join(f.state, "runtime", "code-index", "fixture", hash, path.basename(source));
  fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.writeFileSync(exe, bytes, { mode: 0o755 });
  trace("runtime copied");
  const home = path.join(project_directory(f.state, f.root), "code-index"); fs.mkdirSync(home, { recursive: true });
  index_config(home, f.root, f.profile);
  const daemon = launch(exe, ["daemon", "run"], { cwd: home, env: { ...process.env, CODE_INDEX_HOME: home, CODE_INDEX_DAEMON_DETACHED: "1" },
    readerJob: randomUUID(), stdio: ["ignore", "ignore", "ignore"] });
  trace("daemon started");
  f.clients.push({ close: () => stop_child(daemon, 0) });
  try {
    assert.ok(daemon.pid);
    const until = Date.now() + 30000; let health;
    while (Date.now() < until) {
      if (daemon.exitCode !== null || daemon.signalCode !== null) throw new Error("Fixture index daemon exited before becoming ready");
      try { health = await daemon_health(home); } catch { health = null; }
      if (health?.paths?.some(item => item.status === "ready")) break;
      await new Promise(done => setTimeout(done, 200));
    }
    assert.ok(health?.paths?.some(item => item.status === "ready"), "fixture index daemon did not become ready");
    trace("daemon ready");
    save_json(path.join(home, "owner.json"), { pid: health.pid, executable: exe, project_root: f.root });
    grant_preparation(f.state, f.root, ["code-index"]);
    const config = settings(); config.active_project = f.root; config.state_dir = f.state;
    const observed = await observe_index(f.state, config, f.root, f.profile);
    trace("observation completed");
    assert.equal(observed.index_state, "ready", JSON.stringify(observed.index));
    assert.equal(observed.index.repositories[0].alias, "product");
    const client = await session(t, "mcp/settings.mjs", [], f), second = await session(t, "mcp/settings.mjs", [], f);
    let readerId;
    for (let i = 0; i < 3; i++) {
      const current = i % 2 ? second : client;
      const job = (await current.call("settings.refresh_readiness", { scope: f.root + "#first", component: "code-index" })).structuredContent;
      const deadline = Date.now() + 30000; let completed;
      do {
        completed = (await current.call("settings.operation", { operationId: job.id, waitMs: 10000 })).structuredContent;
      } while (completed.status === "running" && Date.now() < deadline);
      assert.equal(completed.status, "completed", JSON.stringify(completed));
      assert.equal(completed.result.componentChecks[0].state, "ready", JSON.stringify(completed.result));
      const readers = await active_readers(f.state, f.root);
      assert.equal(readers.length, 1);
      readerId ||= readers[0].id;
      assert.equal(readers[0].id, readerId, "settings sessions must reuse the same verified reader");
    }
    await second.close();
    assert.equal((await active_readers(f.state, f.root)).length, 1);
    await client.close();
    assert.deepEqual(await active_readers(f.state, f.root), []);
    const restarted = await session(t, "mcp/settings.mjs", [], f);
    const loaded = (await restarted.call("settings.read", {})).structuredContent;
    assert.equal(loaded.profile.status, "loaded");
    const job = (await restarted.call("settings.refresh_readiness", { scope: f.root + "#first", component: "code-index" })).structuredContent;
    let result;
    do { result = (await restarted.call("settings.operation", { operationId: job.id, waitMs: 10000 })).structuredContent; }
    while (result.status === "running");
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(result.result.componentChecks[0].state, "ready", JSON.stringify(result.result));
    const afterRestart = await daemon_health(home);
    assert.equal(afterRestart.pid, health.pid); assert.equal(afterRestart.started_at, health.started_at);
    assert.notEqual((await active_readers(f.state, f.root))[0].id, readerId);
    await restarted.close(); assert.deepEqual(await active_readers(f.state, f.root), []);
  } finally {
    trace("stopping daemon");
    await stop_child(daemon, 0);
  }
});

test("the real Windows Code Index startup uses the guarded persistent handoff", { skip: process.platform !== "win32" || !process.env.EDT_AI_TEST_REAL_INDEX, timeout: 120000 }, async t => {
  const source = process.env.EDT_AI_TEST_REAL_INDEX, f = fixture(t); environment(t, f.env); f.save();
  const bytes = fs.readFileSync(source), hash = sha256(bytes), exe = path.join(f.state, "runtime", "code-index", "fixture", hash, path.basename(source));
  fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.writeFileSync(exe, bytes);
  fs.writeFileSync(path.join(f.root, "src", "Example.bsl"), "Процедура Пример() Экспорт\nКонецПроцедуры\n");
  const sentinel = launch(process.execPath, ["-e", "process.stdin.resume();setInterval(()=>{},1000)"], { readerJob: randomUUID(), stdio: ["pipe", "ignore", "ignore"] });
  let launched, pinned, started = false;
  try {
    const io = { launch: (command, args, options) => { assert.equal(options.guardUntilCommit, true); return launched = spawn_detached_windows(command, args, options); } };
    const home = await ensure_daemon(f.state, f.root, f.profile, exe, io); started = true;
    const owner = read_json(path.join(home, "owner.json"));
    pinned = pin_windows_process(owner.pid);
    assert.equal(owner.pid, launched.pid); assert.equal(pinned.created, owner.creation); assert.equal(pinned.alive(), true);
    await stop_daemon(f.state, f.root); started = false;
    assert.equal(pinned.alive(), false); assert.equal(sentinel.exitCode, null); assert.equal(sentinel.signalCode, null);
  } finally {
    if (started) await stop_daemon(f.state, f.root);
    pinned?.close(); await stop_child(sentinel, 0);
  }
});

test("the real Code Index startup records ownership and stops only its own daemon", { skip: !process.env.EDT_AI_TEST_REAL_INDEX, timeout: 120000 }, async t => {
  const source = process.env.EDT_AI_TEST_REAL_INDEX;
  assert.ok(path.isAbsolute(source) && fs.statSync(source).isFile());
  const f = fixture(t); environment(t, f.env); f.save();
  fs.writeFileSync(path.join(f.root, "src", "Example.bsl"), "Процедура Пример() Экспорт\nКонецПроцедуры\n");
  const bytes = fs.readFileSync(source), hash = sha256(bytes), exe = path.join(f.state, "runtime", "code-index", "fixture", hash, path.basename(source));
  fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.writeFileSync(exe, bytes, { mode: 0o755 });
  const sentinel = launch(process.execPath, ["-e", "process.stdin.resume();setInterval(()=>{},1000)"], { readerJob: randomUUID(), stdio: ["pipe", "ignore", "ignore"] });
  let daemon;
  try {
    const io = { launch: (command, args, options) => { daemon = launch(command, args, options); return daemon; } };
    const home = await ensure_daemon(f.state, f.root, f.profile, exe, io), owner = read_json(path.join(home, "owner.json"));
    assert.ok(owner.creation && owner.daemon_started_at && owner.health_started_at);
    assert.equal(daemon.pid, owner.pid);
    await stop_daemon(f.state, f.root);
    assert.equal(sentinel.exitCode, null); assert.equal(sentinel.signalCode, null);
    if (daemon.exitCode === null && daemon.signalCode === null) await once(daemon, "exit");
    assert.equal(daemon.exitCode !== null || daemon.signalCode !== null, true);
  } finally {
    if (daemon) await stop_child(daemon, 0);
    await stop_child(sentinel, 0);
  }
});
