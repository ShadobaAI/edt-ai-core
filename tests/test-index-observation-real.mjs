import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { edt_fixture as fixture, environment, session, ROOT } from "./helpers.mjs";
import { settings } from "../scripts/common.mjs";
import { sha256, project_directory } from "../scripts/project_paths.mjs";
import { grant_preparation } from "../scripts/components.mjs";
import { active_readers, daemon_health, index_config, observe_index, save_json, ensure_daemon, stop_daemon, read_json } from "../scripts/runtime.mjs";
import { SettingsBackend } from "../scripts/settings_backend.mjs";
import { launch, stop_child } from "../scripts/processes.mjs";
import { pin_windows_process, spawn_detached_windows } from "../scripts/windows_process.mjs";
import { pin_linux_process } from "../scripts/unix_process.mjs";

// Explicit opt-in only: no test downloads a runtime or touches a user's index.
// The binary, daemon, database, configuration and logs live in the fixture.
test("the real Code Index checks use the installed runtime and independent settings readers", { skip: !process.env.EDT_AI_TEST_REAL_INDEX, timeout: 120000 }, async t => {
  const trace = message => { if (process.env.EDT_AI_TEST_INDEX_TRACE === "1") process.stderr.write("fixture: " + message + "\n"); };
  const source = process.env.EDT_AI_TEST_REAL_INDEX;
  assert.ok(path.isAbsolute(source) && fs.statSync(source).isFile());
  const f = fixture(t, { preserveOnCleanupFailure: true }); environment(t, f.env); f.save();
  await new SettingsBackend().main({ action: "update", set: { codeIndexEnabled: true } });
  fs.writeFileSync(path.join(f.root, "src", "Example.bsl"), "Процедура Пример() Экспорт\nКонецПроцедуры\n");
  const bytes = fs.readFileSync(source), hash = sha256(bytes), exe = path.join(f.state, "runtime", "code-index", "fixture", hash, path.basename(source));
  fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.writeFileSync(exe, bytes, { mode: 0o755 });
  trace("runtime copied");
  const home = path.join(project_directory(f.state, f.root), "code-index"); fs.mkdirSync(home, { recursive: true });
  index_config(home, f.root, f.profile);
  let daemon, managed = false, startupUnknown = false, cleanupHandle;
  const closeDaemon = async () => {
    const failures = [];
    for (const client of f.clients) if (client !== cleanupHandle) try { await client.close(); } catch (error) { failures.push(error); }
    try {
      if (managed) {
        await stop_daemon(f.state, f.root);
        if (startupUnknown) throw new Error("Startup cleanup was not confirmed; preserve fixture " + f.base);
        managed = false;
      } else if (daemon) { await stop_child(daemon, 0); daemon = null; }
    } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Fixture cleanup was not confirmed; preserve fixture " + f.base);
  };
  cleanupHandle = { close: closeDaemon }; f.clients.push(cleanupHandle);
  try {
    if (["linux", "win32"].includes(process.platform)) {
      managed = true;
      try { await ensure_daemon(f.state, f.root, f.profile, exe); }
      catch (error) { startupUnknown = error.outcomeUnknown === true; throw error; }
    } else daemon = launch(exe, ["daemon", "run"], { cwd: home, env: { ...process.env, CODE_INDEX_HOME: home, CODE_INDEX_DAEMON_DETACHED: "1" },
      readerJob: randomUUID(), stdio: ["ignore", "ignore", "ignore"] });
    trace("daemon started");
    if (daemon) assert.ok(daemon.pid);
    const until = Date.now() + 30000; let health;
    while (Date.now() < until) {
      if (daemon && (daemon.exitCode !== null || daemon.signalCode !== null)) throw new Error("Fixture index daemon exited before becoming ready");
      try { health = await daemon_health(home); } catch { health = null; }
      if (health?.paths?.some(item => item.status === "ready")) break;
      await new Promise(done => setTimeout(done, 200));
    }
    assert.ok(health?.paths?.some(item => item.status === "ready"), "fixture index daemon did not become ready");
    trace("daemon ready");
    if (daemon) save_json(path.join(home, "owner.json"), { pid: health.pid, executable: exe, project_root: f.root });
    grant_preparation(f.state, f.root, ["code-index"]);
    const config = settings(); config.active_project = f.root; config.state_dir = f.state;
    const observed = await observe_index(f.state, config, f.root, f.profile);
    trace("observation completed");
    assert.equal(observed.index_state, "ready", JSON.stringify(observed.index));
    assert.equal(observed.index.repositories[0].alias, "product");
    const client = await session(t, "mcp/settings.mjs", [], f), second = await session(t, "mcp/settings.mjs", [], f);
    assert.equal((await client.call("settings.read", {})).structuredContent.profile.status, "loaded");
    const database = path.join(f.root, ".code-index", "index.db"), databaseBefore = sha256(fs.readFileSync(database));
    const readerIds = [];
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
      assert.equal(readers.length, Math.min(i + 1, 2));
      if (i < 2) readerIds.push(readers.find(reader => !readerIds.includes(reader.id)).id);
      assert.ok(readers.some(reader => reader.id === readerIds[i % 2]), "each settings session must reuse its own reader");
      assert.deepEqual(fs.readdirSync(home).filter(name => name.startsWith(".observation-")), []);
    }
    const probe = (await second.call("settings.probe_connections", { component: "code-index" })).structuredContent;
    let checked;
    do { checked = (await second.call("settings.operation", { operationId: probe.id, waitMs: 10000 })).structuredContent; }
    while (checked.status === "running");
    assert.equal(checked.status, "completed", JSON.stringify(checked));
    assert.equal(checked.result.componentChecks[0].state, "ready", JSON.stringify(checked.result));
    assert.deepEqual(new Set((await active_readers(f.state, f.root)).map(reader => reader.id)), new Set(readerIds));
    // Crash one settings session. Its reader must be retired without stopping
    // the daemon or the other session's independent reader.
    const interrupted = (await client.call("settings.refresh_readiness", { scope: f.root + "#first", component: "code-index" })).structuredContent;
    assert.equal(interrupted.status, "running");
    const closed = once(client.process, "close"); client.process.kill("SIGKILL"); await closed;
    const cleanupDeadline = Date.now() + 15000;
    while ((await active_readers(f.state, f.root)).some(reader => reader.id === readerIds[0]) && Date.now() < cleanupDeadline)
      await new Promise(done => setTimeout(done, 50));
    assert.deepEqual((await active_readers(f.state, f.root)).map(reader => reader.id), [readerIds[1]]);
    const restarted = second;
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
    assert.equal(sha256(fs.readFileSync(database)), databaseBefore, "manual, automatic and reconnected observations must preserve the existing index database");
    assert.equal((await active_readers(f.state, f.root))[0].id, readerIds[1]);
    await restarted.close(); assert.deepEqual(await active_readers(f.state, f.root), []);
  } finally {
    trace("stopping daemon");
    await closeDaemon();
  }
});

test("a live settings check starts the real installed daemon without a chat", { skip: !process.env.EDT_AI_TEST_REAL_INDEX || process.platform === "darwin", timeout: 120000 }, async t => {
  const f = fixture(t, { preserveOnCleanupFailure: true }); environment(t, f.env); f.save();
  await new SettingsBackend().main({ action: "update", set: { codeIndexEnabled: true } });
  grant_preparation(f.state, f.root, ["code-index"]);
  fs.writeFileSync(path.join(f.root, "src", "Example.bsl"), "Процедура Пример() Экспорт\nКонецПроцедуры\n");
  const bytes = fs.readFileSync(process.env.EDT_AI_TEST_REAL_INDEX), hash = sha256(bytes), release = "v1.15.6";
  const exe = path.join(f.state, "runtime", "code-index", release, hash, process.platform === "win32" ? "bsl-indexer.exe" : "bsl-indexer");
  fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.writeFileSync(exe, bytes, { mode: 0o755 });
  save_json(path.join(f.state, "runtime-lock.json"), { "code-index": { release, sha256: hash, path: path.relative(f.state, exe), platform: process.platform + "-" + process.arch } });
  const home = path.join(project_directory(f.state, f.root), "code-index");
  const cleanup = { close: async () => {
    for (const client of f.clients) if (client !== cleanup) await client.close();
    if (await daemon_health(home)) await stop_daemon(f.state, f.root);
  } }; f.clients.push(cleanup);
  try {
    const client = await session(t, "mcp/settings.mjs", [], f);
    const job = (await client.call("settings.probe_connections", { component: "code-index" })).structuredContent;
    let checked;
    do { checked = (await client.call("settings.operation", { operationId: job.id, waitMs: 10000 })).structuredContent; }
    while (checked.status === "running");
    assert.equal(checked.status, "completed", JSON.stringify(checked));
    assert.equal(checked.result.superseded, false, JSON.stringify(checked.result));
    assert.ok(["ready", "indexing"].includes(checked.result.componentChecks[0].state), JSON.stringify(checked.result));
    const health = await daemon_health(home); assert.ok(health?.pid);
    const [reader] = await active_readers(f.state, f.root); assert.ok(reader);
    const repeat = (await client.call("settings.probe_connections", { component: "code-index" })).structuredContent;
    do { checked = (await client.call("settings.operation", { operationId: repeat.id, waitMs: 10000 })).structuredContent; }
    while (checked.status === "running");
    assert.equal(checked.status, "completed"); assert.equal((await active_readers(f.state, f.root))[0].id, reader.id);
    assert.equal((await daemon_health(home)).pid, health.pid);
  } finally { await cleanup.close(); }
});

test("a real cold check and two chat relays share one daemon", { skip: !process.env.EDT_AI_TEST_REAL_INDEX || process.platform === "darwin", timeout: 120000 }, async t => {
  const trace = message => { if (process.env.EDT_AI_TEST_INDEX_TRACE === "1") process.stderr.write("cold fixture: " + message + "\n"); };
  const f = fixture(t, { preserveOnCleanupFailure: true }); environment(t, f.env); f.save();
  await new SettingsBackend().main({ action: "update", set: { codeIndexEnabled: true } });
  grant_preparation(f.state, f.root, ["code-index"]);
  fs.writeFileSync(path.join(f.root, "src", "Example.bsl"), "Процедура Пример() Экспорт\nКонецПроцедуры\n");
  const bytes = fs.readFileSync(process.env.EDT_AI_TEST_REAL_INDEX), hash = sha256(bytes), release = "v1.15.6";
  const exe = path.join(f.state, "runtime", "code-index", release, hash, process.platform === "win32" ? "bsl-indexer.exe" : "bsl-indexer");
  fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.writeFileSync(exe, bytes, { mode: 0o755 });
  save_json(path.join(f.state, "runtime-lock.json"), { "code-index": { release, sha256: hash, path: path.relative(f.state, exe), platform: process.platform + "-" + process.arch } });
  const home = path.join(project_directory(f.state, f.root), "code-index");
  const cleanup = { close: async () => {
    for (const client of f.clients) if (client !== cleanup) await client.close();
    if (await daemon_health(home)) await stop_daemon(f.state, f.root);
  } };
  f.clients.push(cleanup);
  try {
    const [settingsClient, a, b] = await Promise.all([
      session(t, "mcp/settings.mjs", [], f),
      session(t, "scripts/lazy_mcp.mjs", ["--component", "code-index"], f),
      session(t, "scripts/lazy_mcp.mjs", ["--component", "code-index"], f),
    ]);
    await settingsClient.call("settings.inspect", {});
    assert.equal(await daemon_health(home), null, "inspection is passive");
    const [job, first, second] = await Promise.all([
      settingsClient.call("settings.refresh_readiness", { scope: f.root + "#first", component: "code-index" }),
      a.call("core_runtime_status", {}), b.call("core_runtime_status", {}),
    ]);
    assert.equal(first.structuredContent.ready, true, JSON.stringify(first));
    assert.equal(second.structuredContent.ready, true, JSON.stringify(second));
    let checked;
    do { checked = (await settingsClient.call("settings.operation", { operationId: job.structuredContent.id, waitMs: 10000 })).structuredContent; }
    while (checked.status === "running");
    assert.equal(checked.status, "completed", JSON.stringify(checked));
    trace("cold connections ready");
    assert.equal(checked.result.superseded, false, JSON.stringify(checked.result));
    assert.ok(["ready", "indexing"].includes(checked.result.componentChecks[0].state), JSON.stringify(checked.result));
    const health = await daemon_health(home), readers = await active_readers(f.state, f.root);
    assert.ok(health?.pid); assert.equal(readers.length, 3);
    assert.equal(new Set(readers.map(reader => reader.id)).size, 3);
    assert.equal((await a.call("core_runtime_status", {})).structuredContent.binding.connectionId, first.structuredContent.binding.connectionId);
    assert.equal((await b.call("core_runtime_status", {})).structuredContent.binding.connectionId, second.structuredContent.binding.connectionId);
    assert.equal((await daemon_health(home)).pid, health.pid);
    assert.deepEqual(fs.readdirSync(home).filter(name => name.startsWith(".observation-")), []);
    await settingsClient.close();
    assert.equal((await active_readers(f.state, f.root)).length, 2);
    assert.equal((await daemon_health(home)).pid, health.pid);
    if (["win32", "linux"].includes(process.platform)) {
      const daemon = process.platform === "win32" ? pin_windows_process(health.pid) : pin_linux_process(health.pid);
      try {
        process.kill(health.pid, "SIGKILL");
        const until = Date.now() + 10000;
        while (daemon.alive() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(daemon.alive(), false);
        trace("daemon killed");
        const query = client => client.call("core_runtime_call", { calls: [{ name: "health", arguments: {} }] });
        const [recoveredA, recoveredB] = await Promise.all([query(a), query(b)]);
        assert.equal(recoveredA.structuredContent.completed, 1, JSON.stringify(recoveredA));
        assert.equal(recoveredB.structuredContent.completed, 1, JSON.stringify(recoveredB));
        assert.notEqual(recoveredA.structuredContent.binding.connectionId, first.structuredContent.binding.connectionId);
        assert.notEqual(recoveredB.structuredContent.binding.connectionId, second.structuredContent.binding.connectionId);
        assert.notEqual((await daemon_health(home)).pid, health.pid);
        assert.equal((await active_readers(f.state, f.root)).length, 2);
        trace("daemon recovered");
        const replacementDaemon = (await daemon_health(home)).pid;
        await b.close();
        const [firstReader] = await active_readers(f.state, f.root);
        const other = await session(t, "scripts/lazy_mcp.mjs", ["--component", "code-index"], f);
        const otherBefore = (await other.call("core_runtime_status", {})).structuredContent.binding.connectionId;
        assert.equal((await active_readers(f.state, f.root)).length, 2);
        process.kill(firstReader.pid, "SIGKILL");
        trace("reader owner killed");
        const readerDeadline = Date.now() + 15000;
        while (Date.now() < readerDeadline) {
          try { if (!(await active_readers(f.state, f.root)).some(reader => reader.id === firstReader.id)) break; }
          catch (error) { if (error.code !== "ECONNRESET") throw error; }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.equal((await active_readers(f.state, f.root)).some(reader => reader.id === firstReader.id), false);
        trace("reader cleanup confirmed");
        assert.equal((await query(a)).structuredContent.completed, 1);
        trace("reader recovered");
        assert.equal((await other.call("core_runtime_status", {})).structuredContent.binding.connectionId, otherBefore);
        assert.equal((await daemon_health(home)).pid, replacementDaemon);
      } finally { daemon.close(); }
    }
  } finally { await cleanup.close(); }
});

test("concurrent real cold checks share the startup result", { skip: !process.env.EDT_AI_TEST_REAL_INDEX || process.platform === "darwin", timeout: 120000 }, async t => {
  const f = fixture(t, { preserveOnCleanupFailure: true }); environment(t, f.env); f.save();
  await new SettingsBackend().main({ action: "update", set: { codeIndexEnabled: true } });
  grant_preparation(f.state, f.root, ["code-index"]);
  fs.writeFileSync(path.join(f.root, "src", "Example.bsl"), "Процедура Пример() Экспорт\nКонецПроцедуры\n");
  const bytes = fs.readFileSync(process.env.EDT_AI_TEST_REAL_INDEX), hash = sha256(bytes), release = "v1.15.6";
  const exe = path.join(f.state, "runtime", "code-index", release, hash, process.platform === "win32" ? "bsl-indexer.exe" : "bsl-indexer");
  fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.writeFileSync(exe, bytes, { mode: 0o755 });
  save_json(path.join(f.state, "runtime-lock.json"), { "code-index": { release, sha256: hash, path: path.relative(f.state, exe), platform: process.platform + "-" + process.arch } });
  const home = path.join(project_directory(f.state, f.root), "code-index");
  const cleanup = { close: async () => { if (await daemon_health(home)) await stop_daemon(f.state, f.root); } };
  f.clients.push(cleanup);
  let entered, releaseProbe, probes = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { releaseProbe = resolve; });
  t.after(() => releaseProbe());
  const observer = async ({ config, root, profile, snapshot }) => {
    probes++; entered(); await gate;
    return observe_index(f.state, config, root, profile, snapshot);
  };
  const first = new SettingsBackend(f.state, f.env.EDT_AI_SETTINGS, { observeIndex: observer });
  const second = new SettingsBackend(f.state, f.env.EDT_AI_SETTINGS, { observeIndex: observer });
  const request = { action: "refresh_readiness", scope: f.root + "#first", component: "code-index" };
  try {
    const a = first.main(request); await started;
    const b = second.main(request);
    await new Promise(resolve => setTimeout(resolve, 400));
    releaseProbe();
    const results = await Promise.all([a, b]);
    for (const result of results) {
      assert.equal(result.superseded, false, JSON.stringify(result));
      assert.ok(["ready", "indexing"].includes(result.componentChecks[0].state), JSON.stringify(result));
    }
    assert.equal(probes, 1);
    assert.ok((await daemon_health(home))?.pid);
    assert.deepEqual(await active_readers(f.state, f.root), []);
  } finally { await cleanup.close(); }
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

test("the real Linux Code Index cannot outlive a launcher crash before owner registration", { skip: process.platform !== "linux" || !process.env.EDT_AI_TEST_REAL_INDEX, timeout: 60000 }, async t => {
  const source = process.env.EDT_AI_TEST_REAL_INDEX, f = fixture(t); environment(t, f.env); f.save();
  const bytes = fs.readFileSync(source), hash = sha256(bytes), exe = path.join(f.state, "runtime", "code-index", "fixture", hash, path.basename(source));
  fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.writeFileSync(exe, bytes, { mode: 0o755 });
  fs.writeFileSync(path.join(f.root, "src", "Example.bsl"), "Процедура Пример() Экспорт\nКонецПроцедуры\n");
  const home = path.join(project_directory(f.state, f.root), "code-index"), info = path.join(f.base, "real-guard.json");
  const runtime = pathToFileURL(path.join(ROOT, "scripts/runtime.mjs")).href, processes = pathToFileURL(path.join(ROOT, "scripts/processes.mjs")).href;
  const code = `import fs from 'node:fs';import {ensure_daemon} from ${JSON.stringify(runtime)};import {spawn_guarded_linux} from ${JSON.stringify(processes)};
    const io={launch:async(command,args,options)=>{const c=await spawn_guarded_linux(command,args,options);
      fs.writeFileSync(${JSON.stringify(info)},JSON.stringify({pid:c.pid,guard:c.guardPid,worker:c.workerPid,id:c.guardId}));await new Promise(()=>{});return c;}};
    await ensure_daemon(${JSON.stringify(f.state)},${JSON.stringify(f.root)},${JSON.stringify(f.profile)},${JSON.stringify(exe)},io,process.env);`;
  const owner = spawn(process.execPath, ["--input-type=module", "-e", code], { env: f.env, stdio: "ignore" });
  const closed = new Promise(resolve => owner.once("close", resolve)); let pins = [];
  f.clients.push({ close: async () => {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL"); await closed;
    const until = Date.now() + 15000; while (pins.some(pin => pin.alive()) && Date.now() < until) await new Promise(done => setTimeout(done, 25));
    assert.ok(pins.every(pin => !pin.alive())); pins.forEach(pin => pin.close());
  } });
  const until = Date.now() + 15000; while (!fs.existsSync(info) && Date.now() < until) await new Promise(done => setTimeout(done, 25));
  assert.ok(fs.existsSync(info), "the real daemon did not start");
  const ids = JSON.parse(fs.readFileSync(info));
  assert.equal(fs.existsSync(path.join(home, "owner.json")), false);
  pins = [ids.guard, ids.worker, ids.pid].map(pin_linux_process);
  owner.kill("SIGKILL"); await closed;
  const deadline = Date.now() + 15000; while (pins.some(pin => pin.alive()) && Date.now() < deadline) await new Promise(done => setTimeout(done, 25));
  assert.ok(pins.every(pin => !pin.alive()));
  const receipt = JSON.parse(fs.readFileSync(path.join(home, "guard-lifecycle.json")));
  assert.equal(receipt.id, ids.id); assert.equal(receipt.state, "completed");
});

test("the real Code Index startup records ownership and stops only its own daemon", { skip: !process.env.EDT_AI_TEST_REAL_INDEX, timeout: 120000 }, async t => {
  const source = process.env.EDT_AI_TEST_REAL_INDEX;
  assert.ok(path.isAbsolute(source) && fs.statSync(source).isFile());
  const f = fixture(t); environment(t, f.env); f.save();
  fs.writeFileSync(path.join(f.root, "src", "Example.bsl"), "Процедура Пример() Экспорт\nКонецПроцедуры\n");
  const bytes = fs.readFileSync(source), hash = sha256(bytes), exe = path.join(f.state, "runtime", "code-index", "fixture", hash, path.basename(source));
  fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.writeFileSync(exe, bytes, { mode: 0o755 });
  const sentinel = launch(process.execPath, ["-e", "process.stdin.resume();setInterval(()=>{},1000)"], { readerJob: randomUUID(), stdio: ["pipe", "ignore", "ignore"] });
  let daemon, home, started = false, pins = [];
  try {
    if (process.platform === "linux") {
      home = await ensure_daemon(f.state, f.root, f.profile, exe); started = true;
      const owner = read_json(path.join(home, "owner.json"));
      assert.ok(owner.creation && owner.daemon_started_at && owner.health_started_at && owner.guardId);
      pins = [owner.pid, ...owner.guards.map(item => item.pid)].map(pin_linux_process);
      assert.ok(pins.every(pin => pin.alive()));
      assert.equal(await ensure_daemon(f.state, f.root, f.profile, exe), home);
      await stop_daemon(f.state, f.root); started = false;
      assert.ok(pins.every(pin => !pin.alive()));
      assert.equal(sentinel.exitCode, null); assert.equal(sentinel.signalCode, null);
      return;
    }
    const io = { launch: (command, args, options) => { daemon = launch(command, args, options); return daemon; } };
    home = await ensure_daemon(f.state, f.root, f.profile, exe, io); const owner = read_json(path.join(home, "owner.json"));
    assert.ok(owner.creation && owner.daemon_started_at && owner.health_started_at);
    assert.equal(daemon.pid, owner.pid);
    await stop_daemon(f.state, f.root);
    assert.equal(sentinel.exitCode, null); assert.equal(sentinel.signalCode, null);
    if (daemon.exitCode === null && daemon.signalCode === null) await once(daemon, "exit");
    assert.equal(daemon.exitCode !== null || daemon.signalCode !== null, true);
  } finally {
    if (started) await stop_daemon(f.state, f.root);
    for (const pin of pins) pin.close();
    if (daemon) await stop_child(daemon, 0);
    await stop_child(sentinel, 0);
  }
});
