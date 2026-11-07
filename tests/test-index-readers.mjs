import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once, EventEmitter } from "node:events";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import net from "node:net";
import { edt_fixture as fixture, ROOT } from "./helpers.mjs";
import { settings } from "../scripts/common.mjs";
import { acquire_reader, active_readers, ensure_daemon, index_config, restart_index, project_home, save_json } from "../scripts/runtime.mjs";
import { open_reader, reader_active } from "../scripts/reader_lease.mjs";
import { private_observation_directory } from "../scripts/openviking_store.mjs";

test("private observations use canonical parents and avoid writable shared ancestors", { skip: process.platform === "win32" }, t => {
  const f = fixture(t), shared = path.join(f.base, "shared"), safe = path.join(f.base, "safe"), foreign = path.join(f.base, "foreign"), alias = path.join(shared, "alias");
  fs.mkdirSync(shared, { mode: 0o777 }); fs.chmodSync(shared, 0o777);
  fs.mkdirSync(safe); fs.mkdirSync(foreign); fs.symlinkSync(safe, alias, "dir");
  const snapshot = private_observation_directory(alias);
  t.after(() => { try { snapshot.close(); } catch {} });
  assert.equal(path.dirname(snapshot.path), fs.realpathSync.native(safe));
  fs.unlinkSync(alias); fs.symlinkSync(foreign, alias, "dir");
  fs.writeFileSync(path.join(snapshot.ioPath, "reader"), "owned"); snapshot.ensure();
  assert.equal(fs.readFileSync(path.join(snapshot.path, "reader"), "utf8"), "owned");
  assert.deepEqual(fs.readdirSync(foreign), []);
  snapshot.unlink("reader"); snapshot.remove();
  const fallback = private_observation_directory(shared);
  t.after(() => { try { fallback.close(); } catch {} });
  assert.equal(path.dirname(fallback.path), fs.realpathSync.native("/tmp"));
  fallback.remove();
  if (process.getuid() === 0) {
    const foreignOwner = path.join(f.base, "foreign-owner"); fs.mkdirSync(foreignOwner); fs.chownSync(foreignOwner, 65534, 65534);
    const isolated = private_observation_directory(foreignOwner);
    t.after(() => { try { isolated.close(); } catch {} });
    assert.equal(path.dirname(isolated.path), fs.realpathSync.native("/tmp")); isolated.remove();
  }
});

test("failed private-directory pin removes its empty directory", { skip: process.platform === "win32" }, t => {
  const f = fixture(t), original = fs.openSync; let denied = false;
  t.mock.method(fs, "openSync", (file, ...args) => {
    if (typeof file === "string" && path.basename(file).startsWith(".observation-")) { denied = true; throw Object.assign(new Error("simulated handle exhaustion"), { code: "EMFILE" }); }
    return original(file, ...args);
  });
  assert.throws(() => private_observation_directory(f.base), /simulated handle exhaustion/);
  assert.equal(denied, true); assert.deepEqual(fs.readdirSync(f.base).filter(name => name.startsWith(".observation-")), []);
});

test("failed private-directory initialization reports unconfirmed cleanup", { skip: process.platform === "win32" }, t => {
  const f = fixture(t), open = fs.openSync, remove = fs.rmdirSync;
  t.mock.method(fs, "openSync", (file, ...args) => {
    if (typeof file === "string" && path.basename(file).startsWith(".observation-")) throw Object.assign(new Error("fixture pin failure"), { code: "EMFILE" });
    return open(file, ...args);
  });
  t.mock.method(fs, "rmdirSync", (file, ...args) => {
    if (typeof file === "string" && path.basename(file).startsWith(".observation-")) throw Object.assign(new Error("fixture cleanup failure"), { code: "EACCES" });
    return remove(file, ...args);
  });
  assert.throws(() => private_observation_directory(f.base), error => error.outcomeUnknown === true && error.cleanupUnconfirmed === true);
});

test("failed initial private-directory inspection does not remove an unverified path", { skip: process.platform === "win32" }, t => {
  const f = fixture(t), original = fs.lstatSync; let denied = false;
  t.mock.method(fs, "lstatSync", (file, ...args) => {
    if (typeof file === "string" && path.basename(file).startsWith(".observation-") && !denied) { denied = true; throw Object.assign(new Error("simulated metadata failure"), { code: "EIO" }); }
    return original(file, ...args);
  });
  assert.throws(() => private_observation_directory(f.base), error => error.outcomeUnknown === true && error.cleanupUnconfirmed === true);
  assert.equal(denied, true); assert.equal(fs.readdirSync(f.base).filter(name => name.startsWith(".observation-")).length, 1);
});

test("Windows reports failed native identity cleanup without retaining the fixture handles", { skip: process.platform !== "win32", timeout: 15000 }, async t => {
  const f = fixture(t), module = pathToFileURL(path.join(ROOT, "scripts/openviking_store.mjs")).href;
  const native = path.join(ROOT, "vendor/native", "win32_" + process.arch, "koffi.node");
  for (const failing of ["LocalFree", "CloseHandle"]) {
    const code = `import {createRequire} from 'node:module';const k=createRequire(import.meta.url)(${JSON.stringify(native)}),load=k.load;
      k.load=name=>{const lib=load(name);if(name!=='kernel32.dll')return lib;return {func(...args){const fn=lib.func(...args);
        return typeof args[0]==='string'&&args[0].includes(${JSON.stringify(failing)})?(...values)=>{fn(...values);return ${failing === "LocalFree" ? "values[0]" : "0"};}:fn;}};};
      const {private_observation_directory}=await import(${JSON.stringify(module)});try{private_observation_directory(${JSON.stringify(f.base)});process.exitCode=2;}
      catch(error){if(error.outcomeUnknown&&error.cleanupUnconfirmed)console.log('unconfirmed');else process.exitCode=3;}`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "", errors = ""; child.stdout.on("data", chunk => output += chunk); child.stderr.on("data", chunk => errors += chunk);
    const [status] = await once(child, "close"); assert.equal(status, 0, errors); assert.equal(output.trim(), "unconfirmed");
  }
});

test("Windows rejects a replaced ancestor before creating a private directory", { skip: process.platform !== "win32" }, t => {
  const f = fixture(t), middle = path.join(f.base, "middle"), parent = path.join(middle, "parent"), moved = middle + ".moved", victim = path.join(f.base, "other");
  fs.mkdirSync(parent, { recursive: true }); fs.mkdirSync(victim);
  const target = path.join(victim, "daemon.json"); fs.writeFileSync(target, "untouched");
  const lstat = fs.lstatSync; let swapped = false;
  t.mock.method(fs, "lstatSync", (file, ...args) => {
    const stat = lstat(file, ...args);
    if (!swapped && file === middle) {
      fs.renameSync(middle, moved);
      try { fs.symlinkSync(victim, middle, "junction"); swapped = true; }
      catch (error) { fs.renameSync(moved, middle); throw error; }
    }
    return stat;
  });
  try {
    assert.throws(() => private_observation_directory(parent), /ancestor identity|pin an observation ancestor/i);
    assert.equal(swapped, true); assert.equal(fs.readFileSync(target, "utf8"), "untouched");
  } finally {
    t.mock.restoreAll();
    if (swapped) { fs.unlinkSync(middle); fs.renameSync(moved, middle); }
  }
});

test("a legacy reader without termination proof blocks maintenance without touching a reused PID", async t => {
  const f = fixture(t), id = randomUUID(), file = path.join(project_home(f.state, f.root), "code-index/readers", id + ".json");
  save_json(file, { id, pid: process.pid, root: f.root });
  const calls = [];
  await assert.rejects(restart_index(f.state, settings(), f.root, f.profile, {
    installed: async () => "fixture-exe", stop: async () => calls.push("stop"),
    restart: async () => calls.push("restart"), smoke: async () => ({ index_ready: true }),
  }), /Не подтверждено завершение/);
  assert.deepEqual(calls, []);
  assert.equal(fs.existsSync(file), true);
  assert.doesNotThrow(() => process.kill(process.pid, 0));
});

test("live reader leases preserve project isolation and concurrent release is idempotent", async t => {
  const f = fixture(t), lease = await acquire_reader(f.state, f.root);
  f.clients.push(lease);
  const [reader] = await active_readers(f.state, f.root);
  assert.equal(reader.pid, process.pid);
  assert.equal(reader.root, f.root);
  const other = path.join(f.base, "other"); fs.mkdirSync(other);
  assert.deepEqual(await active_readers(f.state, other), []);
  const first = lease.close(); assert.equal(lease.close(), first); await first;
  assert.deepEqual(await active_readers(f.state, f.root), []);
  assert.equal(await reader_active(reader.id), false);
  assert.equal(fs.existsSync(lease.file), false);
});

test("arming a reader cannot race removal of a stale preparing lease", async t => {
  const f = fixture(t), lease = await acquire_reader(f.state, f.root);
  const connect = net.connect, unlink = fs.unlinkSync; let first = true, enter, rejectConnection;
  const entered = new Promise(resolve => { enter = resolve; });
  const address = process.platform === "win32" ? "\\\\.\\pipe\\1c-ai-core-reader-" + lease.id : "/tmp/1c-ai-core-reader-" + lease.id + ".sock";
  t.mock.method(net, "connect", (...args) => {
    if (!first || args[0] !== address) return connect(...args);
    first = false; const socket = new EventEmitter(); socket.setEncoding = () => socket; socket.destroy = () => {};
    rejectConnection = () => socket.emit("error", Object.assign(new Error("simulated stale endpoint"), { code: "ECONNREFUSED" }));
    enter(); return socket;
  });
  t.mock.method(fs, "unlinkSync", file => { if (file !== address) return unlink(file); });
  const scan = active_readers(f.state, f.root); await entered;
  const arm = lease.arm(); await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(JSON.parse(fs.readFileSync(lease.file, "utf8")).phase, "preparing");
  rejectConnection(); await scan; await arm;
  assert.equal(JSON.parse(fs.readFileSync(lease.file, "utf8")).orphanedBarrier, true);
  await lease.abandon();
  const [reader] = await active_readers(f.state, f.root);
  assert.equal(reader.orphaned, true);
  await assert.rejects(acquire_reader(f.state, f.root), /Не подтверждено завершение/);
});

test("reader release bounds a peer that keeps its half-open connection active", async t => {
  const id = randomUUID(), lease = await open_reader(id);
  const address = process.platform === "win32" ? "\\\\.\\pipe\\1c-ai-core-reader-" + id : "/tmp/1c-ai-core-reader-" + id + ".sock";
  const socket = net.connect({ path: address, allowHalfOpen: true }); socket.on("error", () => {});
  const closed = new Promise(resolve => socket.once("close", resolve));
  const acknowledged = once(socket, "end");
  await once(socket, "connect");
  socket.resume();
  await acknowledged;
  const activity = setInterval(() => { if (!socket.destroyed) socket.write("x"); }, 20);
  let deadline;
  t.after(async () => { clearInterval(activity); clearTimeout(deadline); socket.destroy(); await lease.close(); });
  await Promise.race([Promise.all([lease.close(), closed]), new Promise((_, reject) => {
    deadline = setTimeout(() => reject(new Error("reader peer retained a released listener")), 3000);
  })]);
  assert.equal(await reader_active(id), false);
});

test("disconnected health requesters do not accumulate observations", async t => {
  const id = randomUUID(), binding = randomUUID(); let calls = 0, cancel, enter, release;
  const started = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const lease = await open_reader(id, { binding, observe: async cancelled => { calls++; cancel = cancelled; enter(); await gate; return { state: "ready" }; } });
  t.after(async () => { release(); await lease.close(); });
  const address = process.platform === "win32" ? "\\\\.\\pipe\\1c-ai-core-reader-" + id + "-observe" : "/tmp/1c-ai-core-reader-" + id + "-observe.sock";
  for (let i = 0; i < 20; i++) {
    const socket = net.connect(address); socket.on("error", () => {});
    await once(socket, "connect"); socket.write(JSON.stringify({ id, binding, action: "health" }) + "\n");
    if (i === 0) await started;
    await new Promise(resolve => setTimeout(resolve, 5));
    socket.destroy(); await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(calls, 1);
  assert.equal(cancel(), true);
  release();
});

test("unresponsive reader owners have one bounded deadline and release their connections", { timeout: 10000 }, async t => {
  const f = fixture(t), servers = [], sockets = new Set(), home = path.join(project_home(f.state, f.root), "code-index/readers");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  });
  for (let i = 0; i < 12; i++) {
    const id = randomUUID(), address = process.platform === "win32" ? "\\\\.\\pipe\\1c-ai-core-reader-" + id : "/tmp/1c-ai-core-reader-" + id + ".sock";
    const server = net.createServer(socket => { sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket)); });
    server.listen(address); await once(server, "listening"); servers.push(server);
    save_json(path.join(home, id + ".json"), { id, pid: process.pid, root: f.root, phase: "active", orphanedBarrier: true });
  }
  const start = performance.now();
  await assert.rejects(active_readers(f.state, f.root), /подтвердить владельц/);
  assert.ok(performance.now() - start < 5000, "all owner checks share one deadline");
  for (let i = 0; i < 40 && sockets.size; i++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(sockets.size, 0);
});

test("a malformed live reader marker never permits maintenance", async t => {
  const f = fixture(t), lease = await acquire_reader(f.state, f.root); f.clients.push(lease);
  await lease.arm(); const original = fs.readFileSync(lease.file);
  for (const record of [null, {}, { id: randomUUID(), pid: process.pid, root: f.root, phase: "preparing" }]) {
    fs.writeFileSync(lease.file, JSON.stringify(record));
    await assert.rejects(active_readers(f.state, f.root), /Неподдерживаемая запись/);
    assert.equal(fs.existsSync(lease.file), true);
  }
  fs.writeFileSync(lease.file, original);
});

test("a crashed reader releases its OS endpoint and its stale record is removed", async t => {
  const f = fixture(t), runtime = pathToFileURL(path.join(ROOT, "scripts/runtime.mjs")).href;
  const code = `import {acquire_reader} from ${JSON.stringify(runtime)};
    await acquire_reader(${JSON.stringify(f.state)},${JSON.stringify(f.root)});
    console.log('ready'); setInterval(()=>{},1000);`;
  const owner = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const closed = new Promise(resolve => owner.once("close", resolve));
  t.after(async () => { if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL"); await closed; });
  const [ready] = await once(owner.stdout, "data"); assert.equal(String(ready).trim(), "ready");
  assert.equal((await active_readers(f.state, f.root)).length, 1);
  owner.kill("SIGKILL"); await closed;
  assert.deepEqual(await active_readers(f.state, f.root), []);
  assert.deepEqual(fs.readdirSync(path.join(project_home(f.state, f.root), "code-index/readers")), []);
});

test("a crashed native observation retains a fail-closed maintenance barrier", async t => {
  const f = fixture(t), runtime = pathToFileURL(path.join(ROOT, "scripts/runtime.mjs")).href;
  const previouslyIssued = await acquire_reader(f.state, f.root); f.clients.push(previouslyIssued);
  const code = `import {acquire_reader} from ${JSON.stringify(runtime)};
    const lease = await acquire_reader(${JSON.stringify(f.state)},${JSON.stringify(f.root)}); await lease.arm();
    console.log('ready'); setInterval(()=>{},1000);`;
  const owner = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const closed = new Promise(resolve => owner.once("close", resolve));
  t.after(async () => { if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL"); await closed; });
  await once(owner.stdout, "data"); owner.kill("SIGKILL"); await closed;
  const readers = await active_readers(f.state, f.root);
  assert.equal(readers.filter(reader => reader.orphaned).length, 1);
  await assert.rejects(acquire_reader(f.state, f.root), /Не подтверждено завершение предыдущего читателя/);
  await assert.rejects(previouslyIssued.assertAvailable(), /Не подтверждено завершение предыдущего читателя/);
  await previouslyIssued.close();
  const calls = [];
  await assert.rejects(restart_index(f.state, settings(), f.root, f.profile, {
    installed: async () => "fixture-exe", stop: async () => calls.push("stop"),
    restart: async () => calls.push("restart"), smoke: async () => ({ index_ready: true }),
  }), /Не подтверждено завершение читателя/);
  assert.deepEqual(calls, []);
});

test("a daemon is not started while another reader might still own a native process", async t => {
  const f = fixture(t), earlier = await acquire_reader(f.state, f.root), current = await acquire_reader(f.state, f.root);
  f.clients.push(earlier, current); let starts = 0;
  await earlier.arm();
  await assert.rejects(ensure_daemon(f.state, f.root, f.profile, process.execPath,
    { launch: () => { starts++; throw new Error("unexpected daemon launch"); } }, {}, current.id), /другие читатели/);
  assert.equal(starts, 0);
});

test("unstarted readers do not deadlock the initial daemon launch", async t => {
  const f = fixture(t), [first, second] = await Promise.all([acquire_reader(f.state, f.root, { preparing: true }), acquire_reader(f.state, f.root, { preparing: true })]);
  f.clients.push(first, second); let starts = 0;
  const startedAt = new Date().toISOString();
  const server = createServer((_request, response) => response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ pid: process.pid, status: "running", started_at: startedAt, paths: [{ path: f.root, status: "ready" }] })));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise(done => server.close(done)); });
  const home = path.join(project_home(f.state, f.root), "code-index"), io = { launch: () => {
    starts++; save_json(path.join(home, "daemon.json"), { pid: process.pid, http_host: "127.0.0.1", http_port: server.address().port, started_at: startedAt });
    const proc = new EventEmitter(); Object.assign(proc, { pid: process.pid, exitCode: null, signalCode: null, unref() {} }); return proc;
  } };
  const homes = await Promise.all([first, second].map(lease => ensure_daemon(f.state, f.root, f.profile, process.execPath, io, {}, lease.id)));
  assert.deepEqual(homes, [home, home]); assert.equal(starts, 1);
});

test("a reader arriving during daemon startup waits for the project lock", async t => {
  const f = fixture(t), first = await acquire_reader(f.state, f.root, { preparing: true }); f.clients.push(first);
  const startedAt = new Date().toISOString();
  const server = createServer((_request, response) => response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ pid: process.pid, status: "running", started_at: startedAt, paths: [{ path: f.root, status: "ready" }] })));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise(done => server.close(done)); });
  const home = path.join(project_home(f.state, f.root), "code-index"); let signal;
  const started = new Promise(done => { signal = done; }), io = { launch: () => {
    signal(); setTimeout(() => save_json(path.join(home, "daemon.json"), { pid: process.pid, http_host: "127.0.0.1", http_port: server.address().port, started_at: startedAt }), 300);
    const proc = new EventEmitter(); Object.assign(proc, { pid: process.pid, exitCode: null, signalCode: null, unref() {} }); return proc;
  } };
  const startup = ensure_daemon(f.state, f.root, f.profile, process.execPath, io, {}, first.id); await started;
  const second = acquire_reader(f.state, f.root, { preparing: true });
  assert.equal(await startup, home); f.clients.push(await second);
});

test("a live daemon with missing configuration never causes a config write", t => {
  const f = fixture(t), home = path.join(project_home(f.state, f.root), "code-index"); fs.mkdirSync(home, { recursive: true });
  assert.throws(() => index_config(home, f.root, f.profile, { pid: process.pid }), /daemon\.toml.*отсутствует/);
  assert.equal(fs.existsSync(path.join(home, "daemon.toml")), false);
});

test("reader publication failure closes the listener before returning the error", async t => {
  const f = fixture(t), rename = fs.renameSync;
  let id;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (path.dirname(to).endsWith(path.join("code-index", "readers"))) {
      id = JSON.parse(fs.readFileSync(from, "utf8")).id;
      throw new Error("fixture publication failure");
    }
    return rename(from, to);
  });
  await assert.rejects(acquire_reader(f.state, f.root), /fixture publication failure/);
  assert.equal(typeof id, "string");
  assert.equal(await reader_active(id), false);
});

test("an unresponsive live reader blocks maintenance without being discarded", { skip: process.platform === "win32", timeout: 10000 }, async t => {
  const f = fixture(t), runtime = pathToFileURL(path.join(ROOT, "scripts/runtime.mjs")).href;
  const code = `import {acquire_reader} from ${JSON.stringify(runtime)};
    await acquire_reader(${JSON.stringify(f.state)},${JSON.stringify(f.root)});
    console.log('ready'); setInterval(()=>{},1000);`;
  const owner = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "ignore"] });
  const closed = new Promise(resolve => owner.once("close", resolve));
  t.after(async () => {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
    await closed; await active_readers(f.state, f.root);
  });
  await once(owner.stdout, "data");
  owner.kill("SIGSTOP");
  await assert.rejects(active_readers(f.state, f.root), /обслуживание заблокировано/);
  assert.equal(fs.readdirSync(path.join(project_home(f.state, f.root), "code-index/readers")).length, 1);
});

test("an unsupported reader record fails closed without changing the maintenance barrier", async t => {
  const f = fixture(t), home = path.join(project_home(f.state, f.root), "code-index");
  save_json(path.join(home, "readers", "unsupported.json"), { pid: process.pid, root: f.root });
  await assert.rejects(active_readers(f.state, f.root), /Неподдерживаемая запись/);
  const barrier = path.join(home, "maintenance.json"); save_json(barrier, { outcomeUnknown: true });
  const before = fs.readFileSync(barrier);
  await assert.rejects(acquire_reader(f.state, f.root), /прервано/);
  assert.deepEqual(fs.readFileSync(barrier), before);
});
