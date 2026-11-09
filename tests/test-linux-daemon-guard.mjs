import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import childProcess, { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
import { edt_fixture as fixture, environment, ROOT } from "./helpers.mjs";
import { alive, spawn_guarded_linux } from "../scripts/processes.mjs";
import { linux_process_identity, pin_linux_process } from "../scripts/unix_process.mjs";
import { sha256 } from "../scripts/project_paths.mjs";
import { ensure_daemon, stop_daemon, daemon_health, read_json, save_json, project_home, IndexObserver } from "../scripts/runtime.mjs";
import { SettingsBackend } from "../scripts/settings_backend.mjs";

const linux = process.platform === "linux" && process.arch === "x64";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, message, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await delay(25);
  assert.ok(predicate(), message);
}
function target(f, suffix = "") {
  const file = path.join(f.base, "daemon-tree" + suffix + ".json"), stop = path.join(f.base, "stop-daemon" + suffix);
  const code = `import fs from 'node:fs'; import {spawn} from 'node:child_process';
    process.on('SIGTERM',()=>{});
    const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});process.send("ready");setTimeout(()=>process.exit(0),25000);setInterval(()=>{},1000)'],
      {detached:true,stdio:['ignore','ignore','ignore','ipc']});
    child.once('message',()=>{child.disconnect();fs.writeFileSync(${JSON.stringify(file)},JSON.stringify([process.pid,child.pid]));});
    setInterval(()=>{if(fs.existsSync(${JSON.stringify(stop)}))process.exit(0);},50);setTimeout(()=>process.exit(0),25000);`;
  return { file, stop, args: ["--input-type=module", "-e", code] };
}
function pinsFor(pids) { return pids.map(pin_linux_process); }
async function expectStopped(pins) {
  await waitFor(() => pins.every(pin => !pin.alive()), "the owned daemon tree and both guards must exit", 15000);
}

test("a Linux guard spawn failure records not-started without an unknown outcome", { skip: !linux }, async t => {
  const f = fixture(t);
  t.mock.method(childProcess, "spawn", () => {
    const child = new EventEmitter(); child.pid = undefined; child.connected = false; child.unref = () => {};
    queueMicrotask(() => { child.emit("error", Object.assign(new Error("fixture process limit"), { code: "EAGAIN" })); child.emit("close", -1, null); });
    return child;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(spawn_guarded_linux(process.execPath, [], { cwd: f.base, env: f.env }), error => error.notSpawned === true && !error.outcomeUnknown);
    const receipt = JSON.parse(fs.readFileSync(path.join(f.base, "guard-lifecycle.json")));
    assert.equal(receipt.state, "completed"); assert.equal(receipt.notSpawned, true);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("repeated Linux guarded startups do not retain processes or parent descriptors", { skip: !linux, timeout: 30000 }, async t => {
  const f = fixture(t); let baseline;
  for (let i = 0; i < 16; i++) {
    const controller = await spawn_guarded_linux(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: f.base, env: f.env });
    const pins = pinsFor([controller.guardPid, controller.workerPid, controller.pid]);
    try { await controller.rollback(); controller.release(); assert.ok(pins.every(pin => !pin.alive())); }
    finally { pins.forEach(pin => pin.close()); }
    if (i === 0) baseline = fs.readdirSync("/proc/self/fd").length;
  }
  assert.ok(fs.readdirSync("/proc/self/fd").length <= baseline + 3, "guard lifecycles must not accumulate parent descriptors");
});

test("an unwritable completion receipt keeps the active Linux guard barrier", { skip: !linux || process.getuid?.() === 0, timeout: 15000 }, async t => {
  const f = fixture(t), controller = await spawn_guarded_linux(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: f.base, env: f.env });
  const pins = pinsFor([controller.guardPid, controller.workerPid, controller.pid]);
  f.clients.push({ close: async () => { fs.chmodSync(f.base, 0o700); controller.release(); await expectStopped(pins); pins.forEach(pin => pin.close()); } });
  try {
    fs.chmodSync(f.base, 0o500);
    await assert.rejects(controller.rollback(), error => error.outcomeUnknown === true);
  } finally { fs.chmodSync(f.base, 0o700); }
  await expectStopped(pins);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.base, "guard-lifecycle.json"))).state, "active");
  await assert.rejects(spawn_guarded_linux(process.execPath, [], { cwd: f.base, env: f.env }), /не подтверждена/);
});

test("a completed guard receipt is not reused while its exact finisher is alive", { skip: !linux, timeout: 15000 }, async t => {
  const f = fixture(t), finisher = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  const closed = new Promise(resolve => finisher.once("close", resolve)); let controller;
  f.clients.push({ close: async () => {
    if (finisher.exitCode === null && finisher.signalCode === null) finisher.kill("SIGKILL"); await closed;
    if (controller) { await controller.rollback(); controller.release(); }
  } });
  const creation = linux_process_identity(finisher.pid); assert.ok(creation);
  save_json(path.join(f.base, "guard-lifecycle.json"), { id: "de8a62aa-fef6-4f62-829c-1a7c3998731f", state: "completed", finisher: { pid: finisher.pid, creation } });
  let started = false; const pending = spawn_guarded_linux(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: f.base, env: f.env }).then(value => { started = true; return value; });
  await delay(300); assert.equal(started, false); assert.equal(alive(finisher.pid), true);
  finisher.kill("SIGKILL"); await closed; controller = await pending;
  assert.equal(started, true); await controller.rollback(); controller.release(); controller = null;
});

test("Linux guarded startup rollback drains a detached daemon descendant", { skip: !linux, timeout: 20000 }, async t => {
  const f = fixture(t), spec = target(f), controller = await spawn_guarded_linux(process.execPath, spec.args, { cwd: f.base, env: f.env });
  let pins = [];
  f.clients.push({ close: async () => {
    try { await controller.rollback(); } catch {}
    controller.release();
    await expectStopped(pins); pins.forEach(pin => pin.close());
  } });
  await waitFor(() => fs.existsSync(spec.file), "daemon descendant did not start");
  const [daemon, descendant] = JSON.parse(fs.readFileSync(spec.file));
  assert.equal(controller.pid, daemon);
  pins = pinsFor([controller.guardPid, controller.workerPid, daemon, descendant]);
  assert.ok(pins.every(pin => pin.alive()));
  const first = controller.rollback(); assert.equal(controller.rollback(), first); await first;
  await expectStopped(pins);
});

for (const killed of ["guard", "worker"]) test(`Linux daemon tree is drained if its ${killed} dies during startup`, { skip: !linux, timeout: 20000 }, async t => {
  const f = fixture(t), spec = target(f), controller = await spawn_guarded_linux(process.execPath, spec.args, { cwd: f.base, env: f.env });
  let pins = [];
  f.clients.push({ close: async () => { try { await controller.rollback(); } catch {} controller.release(); await expectStopped(pins); pins.forEach(pin => pin.close()); } });
  await waitFor(() => fs.existsSync(spec.file), "daemon descendant did not start");
  const [daemon, descendant] = JSON.parse(fs.readFileSync(spec.file));
  pins = pinsFor([controller.guardPid, controller.workerPid, daemon, descendant]);
  pins[killed === "guard" ? 0 : 1].signal(9);
  await expectStopped(pins);
});

for (const stoppedGuard of [false, true]) test(`Linux daemon startup is drained after owner crash${stoppedGuard ? " with a stopped guard" : ""}`, { skip: !linux, timeout: 20000 }, async t => {
  const f = fixture(t), spec = target(f), info = path.join(f.base, "controller.json"), other = target(f, "-other");
  const otherHome = path.join(f.base, "other-home"); fs.mkdirSync(otherHome);
  const persistent = await spawn_guarded_linux(process.execPath, other.args, { cwd: otherHome, env: f.env });
  let otherPins = [];
  f.clients.push({ close: async () => {
    fs.writeFileSync(other.stop, "stop"); persistent.release(); await expectStopped(otherPins); otherPins.forEach(pin => pin.close());
  } });
  await waitFor(() => fs.existsSync(other.file), "independent project daemon did not start");
  const otherTree = JSON.parse(fs.readFileSync(other.file));
  otherPins = pinsFor([persistent.guardPid, persistent.workerPid, ...otherTree]);
  await persistent.commit(); persistent.release();
  const module = pathToFileURL(path.join(ROOT, "scripts/processes.mjs")).href;
  const ownerCode = `import fs from 'node:fs';import {spawn_guarded_linux} from ${JSON.stringify(module)};
    const c=await spawn_guarded_linux(process.execPath,${JSON.stringify(spec.args)},{cwd:${JSON.stringify(f.base)},env:process.env});
    fs.writeFileSync(${JSON.stringify(info)},JSON.stringify({pid:c.pid,guard:c.guardPid,worker:c.workerPid}));setInterval(()=>{},1000);`;
  const owner = spawn(process.execPath, ["--input-type=module", "-e", ownerCode], { env: f.env, stdio: "ignore" });
  const closed = new Promise(resolve => owner.once("close", resolve)); let pins = [];
  f.clients.push({ close: async () => { if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL"); await closed; await expectStopped(pins); pins.forEach(pin => pin.close()); } });
  await waitFor(() => fs.existsSync(info) && fs.existsSync(spec.file), "guarded startup did not reach the target");
  const ids = JSON.parse(fs.readFileSync(info)), [daemon, descendant] = JSON.parse(fs.readFileSync(spec.file));
  assert.equal(ids.pid, daemon); pins = pinsFor([ids.guard, ids.worker, daemon, descendant]);
  if (stoppedGuard) {
    pins[0].signal(19);
    await waitFor(() => /\) T /.test(fs.readFileSync(`/proc/${ids.guard}/stat`, "utf8")), "outer guard did not stop");
  }
  owner.kill("SIGKILL"); await closed; await expectStopped(pins);
  assert.ok(otherPins.every(pin => pin.alive()), "the already committed project daemon must remain untouched");
});

test("a crash before owner.json retains the project lock and records confirmed guard completion", { skip: !linux, timeout: 20000 }, async t => {
  const f = fixture(t), spec = target(f), info = path.join(f.base, "before-owner.json"), home = path.join(project_home(f.state, f.root), "code-index");
  const runtime = pathToFileURL(path.join(ROOT, "scripts/runtime.mjs")).href, processes = pathToFileURL(path.join(ROOT, "scripts/processes.mjs")).href;
  const ownerCode = `import fs from 'node:fs';import {ensure_daemon} from ${JSON.stringify(runtime)};import {spawn_guarded_linux} from ${JSON.stringify(processes)};
    const io={launch:async(command,args,options)=>{const c=await spawn_guarded_linux(command,${JSON.stringify(spec.args)},options);
      fs.writeFileSync(${JSON.stringify(info)},JSON.stringify({pid:c.pid,guard:c.guardPid,worker:c.workerPid,id:c.guardId}));await new Promise(()=>{});return c;}};
    await ensure_daemon(${JSON.stringify(f.state)},${JSON.stringify(f.root)},${JSON.stringify(f.profile)},process.execPath,io,process.env);`;
  const owner = spawn(process.execPath, ["--input-type=module", "-e", ownerCode], { env: f.env, stdio: "ignore" });
  const closed = new Promise(resolve => owner.once("close", resolve)); let pins = [];
  f.clients.push({ close: async () => { if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL"); await closed; await expectStopped(pins); pins.forEach(pin => pin.close()); } });
  await waitFor(() => fs.existsSync(info) && fs.existsSync(spec.file), "daemon did not start before owner registration");
  const ids = JSON.parse(fs.readFileSync(info)), [daemon, descendant] = JSON.parse(fs.readFileSync(spec.file));
  assert.equal(fs.existsSync(path.join(home, "owner.json")), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, "guard-lifecycle.json"))).state, "active");
  pins = pinsFor([ids.guard, ids.worker, daemon, descendant]);
  owner.kill("SIGKILL"); await closed; await expectStopped(pins);
  const receipt = JSON.parse(fs.readFileSync(path.join(home, "guard-lifecycle.json")));
  assert.equal(receipt.id, ids.id); assert.equal(receipt.state, "completed");
  assert.equal(fs.existsSync(path.join(home, "operation.lock")), true);
});

test("Linux committed project daemon survives its launcher and releases guards when stopped", { skip: !linux, timeout: 25000 }, async t => {
  const f = fixture(t), spec = target(f), info = path.join(f.base, "committed.json");
  const module = pathToFileURL(path.join(ROOT, "scripts/processes.mjs")).href;
  const ownerCode = `import fs from 'node:fs';import {spawn_guarded_linux} from ${JSON.stringify(module)};
    const c=await spawn_guarded_linux(process.execPath,${JSON.stringify(spec.args)},{cwd:${JSON.stringify(f.base)},env:process.env});
    await c.commit();c.release();fs.writeFileSync(${JSON.stringify(info)},JSON.stringify({pid:c.pid,guard:c.guardPid,worker:c.workerPid}));setInterval(()=>{},1000);`;
  const owner = spawn(process.execPath, ["--input-type=module", "-e", ownerCode], { env: f.env, stdio: "ignore" });
  const closed = new Promise(resolve => owner.once("close", resolve)); let pins = [];
  f.clients.push({ close: async () => { fs.writeFileSync(spec.stop, "stop"); if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL"); await closed; await expectStopped(pins); pins.forEach(pin => pin.close()); } });
  await waitFor(() => fs.existsSync(info) && fs.existsSync(spec.file), "committed daemon did not start");
  const ids = JSON.parse(fs.readFileSync(info)), [daemon, descendant] = JSON.parse(fs.readFileSync(spec.file));
  assert.equal(ids.pid, daemon); pins = pinsFor([ids.guard, ids.worker, daemon, descendant]);
  owner.kill("SIGKILL"); await closed; await delay(1200);
  assert.ok(pins.every(pin => pin.alive()), "a committed project daemon must outlive its launcher");
  fs.writeFileSync(spec.stop, "stop"); await expectStopped(pins);
});

test("a stopped inner guard cannot strand a daemon when the owner crashes during handoff", { skip: !linux, timeout: 20000 }, async t => {
  const f = fixture(t), spec = target(f), info = path.join(f.base, "handoff.json");
  const module = pathToFileURL(path.join(ROOT, "scripts/processes.mjs")).href;
  const ownerCode = `import fs from 'node:fs';import {spawn_guarded_linux} from ${JSON.stringify(module)};
    const c=await spawn_guarded_linux(process.execPath,${JSON.stringify(spec.args)},{cwd:${JSON.stringify(f.base)},env:process.env});
    fs.writeFileSync(${JSON.stringify(info)},JSON.stringify({pid:c.pid,guard:c.guardPid,worker:c.workerPid}));
    process.on('message',()=>void c.commit().catch(()=>{}));setInterval(()=>{},1000);`;
  const owner = spawn(process.execPath, ["--input-type=module", "-e", ownerCode], { env: f.env, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const closed = new Promise(resolve => owner.once("close", resolve)); let pins = [];
  f.clients.push({ close: async () => { if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL"); await closed; await expectStopped(pins); pins.forEach(pin => pin.close()); } });
  await waitFor(() => fs.existsSync(info) && fs.existsSync(spec.file), "guarded startup did not reach handoff");
  const ids = JSON.parse(fs.readFileSync(info)), [daemon, descendant] = JSON.parse(fs.readFileSync(spec.file));
  pins = pinsFor([ids.guard, ids.worker, daemon, descendant]);
  pins[1].signal(19);
  await waitFor(() => /\) T /.test(fs.readFileSync(`/proc/${ids.worker}/stat`, "utf8")), "inner guard did not stop");
  owner.send("commit"); await delay(100); owner.kill("SIGKILL"); await closed;
  await expectStopped(pins);
});

for (const stopped of ["guard", "worker"]) test(`a stopped ${stopped} cannot strand a committed Linux daemon`, { skip: !linux, timeout: 25000 }, async t => {
  const f = fixture(t), spec = target(f), controller = await spawn_guarded_linux(process.execPath, spec.args, { cwd: f.base, env: f.env });
  let pins = [];
  f.clients.push({ close: async () => { controller.release(); await expectStopped(pins); pins.forEach(pin => pin.close()); } });
  await waitFor(() => fs.existsSync(spec.file), "daemon descendant did not start");
  const [daemon, descendant] = JSON.parse(fs.readFileSync(spec.file));
  pins = pinsFor([controller.guardPid, controller.workerPid, daemon, descendant]);
  await controller.commit(); controller.release();
  pins[stopped === "guard" ? 0 : 1].signal(19);
  await expectStopped(pins);
});

test("Linux daemon stop waits for the guarded tree before allowing a new writer", { skip: !linux, timeout: 30000 }, async t => {
  const f = fixture(t), descendantFile = path.join(f.base, "stubborn-child.pid"), digest = sha256(fs.readFileSync(process.execPath));
  const exe = path.join(f.state, "runtime", "code-index", "fixture", digest, "node");
  fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.copyFileSync(process.execPath, exe); fs.chmodSync(exe, 0o755);
  const io = { launch: (command, _args, options) => spawn_guarded_linux(command, [path.join(ROOT, "tests/fixtures/index-daemon.mjs")],
    { ...options, env: { ...options.env, INDEX_TEST_DESCENDANT: descendantFile } }) };
  let pins = [], home;
  f.clients.push({ close: async () => {
    if (pins[1]?.alive()) pins[1].signal(18);
    if (home && await daemon_health(home)) try { await stop_daemon(f.state, f.root); } catch {}
    for (const pin of pins) if (pin.alive()) pin.signal(9);
    await expectStopped(pins); pins.forEach(pin => pin.close());
  } });
  home = await ensure_daemon(f.state, f.root, f.profile, exe, io, f.env);
  await waitFor(() => fs.existsSync(descendantFile), "daemon descendant did not start");
  const owner = read_json(path.join(home, "owner.json"));
  const daemon = read_json(path.join(home, "daemon.json")), observer = new IndexObserver(f.state);
  assert.ok(observer.verifyDaemon(owner, daemon, home));
  pins = pinsFor([owner.guards[0].pid, owner.guards[1].pid, owner.pid, Number(fs.readFileSync(descendantFile))]);
  pins[1].signal(19);
  await waitFor(() => /\) T /.test(fs.readFileSync(`/proc/${owner.guards[1].pid}/stat`, "utf8")), "inner guard did not stop");
  assert.throws(() => observer.verifyDaemon(owner, daemon, home), /наблюдател/);
  await assert.rejects(ensure_daemon(f.state, f.root, f.profile, exe, io, f.env), error => error.outcomeUnknown === true);
  assert.equal(fs.existsSync(path.join(home, "maintenance.json")), false, "the active lifecycle is already the barrier");
  let finished = false; const stopping = stop_daemon(f.state, f.root).finally(() => { finished = true; });
  await delay(800); assert.equal(finished, false); assert.equal(pins[3].alive(), true);
  await stopping; await expectStopped(pins);
  const receipt = JSON.parse(fs.readFileSync(path.join(home, "guard-lifecycle.json")));
  assert.equal(receipt.id, owner.guardId); assert.equal(receipt.state, "completed");
});

test("a live daemon is not reused after both Linux guards are lost", { skip: !linux, timeout: 20000 }, async t => {
  const f = fixture(t), descendantFile = path.join(f.base, "lost-guards-child.pid"), digest = sha256(fs.readFileSync(process.execPath));
  const exe = path.join(f.state, "runtime", "code-index", "fixture", digest, "node");
  fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.copyFileSync(process.execPath, exe); fs.chmodSync(exe, 0o755);
  const io = { launch: (command, _args, options) => spawn_guarded_linux(command, [path.join(ROOT, "tests/fixtures/index-daemon.mjs")],
    { ...options, env: { ...options.env, INDEX_TEST_DESCENDANT: descendantFile } }) };
  let pins = [], home;
  f.clients.push({ close: async () => { for (const pin of pins) if (pin.alive()) pin.signal(9); await expectStopped(pins); pins.forEach(pin => pin.close()); } });
  home = await ensure_daemon(f.state, f.root, f.profile, exe, io, f.env);
  await waitFor(() => fs.existsSync(descendantFile), "daemon descendant did not start");
  const owner = read_json(path.join(home, "owner.json")), daemon = read_json(path.join(home, "daemon.json"));
  pins = pinsFor([owner.guards[0].pid, owner.guards[1].pid, owner.pid, Number(fs.readFileSync(descendantFile))]);
  pins[1].signal(19);
  await waitFor(() => /\) T /.test(fs.readFileSync(`/proc/${owner.guards[1].pid}/stat`, "utf8")), "inner guard did not stop");
  pins[0].signal(9); pins[1].signal(9);
  await waitFor(() => !pins[0].alive() && !pins[1].alive(), "guards did not exit");
  assert.equal(pins[2].alive(), true); assert.ok(await daemon_health(home));
  await assert.rejects(ensure_daemon(f.state, f.root, f.profile, exe, io, f.env), error => error.outcomeUnknown === true);
  assert.throws(() => new IndexObserver(f.state).verifyDaemon(owner, daemon, home), /наблюдател/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, "guard-lifecycle.json"))).state, "active");
  pins[2].signal(9); pins[3].signal(9); await expectStopped(pins);
  await waitFor(() => !alive(owner.pid), "the fixture daemon must be reaped");
  await assert.rejects(stop_daemon(f.state, f.root), error => error.outcomeUnknown === true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, "guard-lifecycle.json"))).state, "active");
});

test("an unconfirmed stop blocks reuse and cached observation until explicit recovery", { skip: !linux, timeout: 20000 }, async t => {
  const f = fixture(t), digest = sha256(fs.readFileSync(process.execPath));
  const exe = path.join(f.state, "runtime", "code-index", "fixture", digest, "node");
  fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.copyFileSync(process.execPath, exe); fs.chmodSync(exe, 0o755);
  const io = { launch: (command, _args, options) => spawn_guarded_linux(command, [path.join(ROOT, "tests/fixtures/index-daemon.mjs")],
    { ...options, env: { ...options.env, INDEX_TEST_STOP_FAILURE: "1" } }) };
  let pins = [], home;
  f.clients.push({ close: async () => { for (const pin of pins) if (pin.alive()) pin.signal(9); await expectStopped(pins); pins.forEach(pin => pin.close()); } });
  home = await ensure_daemon(f.state, f.root, f.profile, exe, io, f.env);
  const owner = read_json(path.join(home, "owner.json")), daemon = read_json(path.join(home, "daemon.json")), observer = new IndexObserver(f.state);
  pins = pinsFor([owner.guards[0].pid, owner.guards[1].pid, owner.pid]);
  assert.ok(observer.verifyDaemon(owner, daemon, home));
  await assert.rejects(stop_daemon(f.state, f.root), error => error.outcomeUnknown === true);
  const barrier = path.join(home, "guard-cleanup-unknown.json"); assert.equal(fs.existsSync(barrier), true);
  assert.ok(await daemon_health(home), "the service is still online while its rejected stop is pending");
  await assert.rejects(ensure_daemon(f.state, f.root, f.profile, exe, io, f.env), /не подтверждено/i);
  assert.throws(() => observer.verifyDaemon(owner, daemon, home), /не подтверждено/i);
  await expectStopped(pins);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, "guard-lifecycle.json"))).state, "completed");
  assert.equal(fs.existsSync(barrier), true, "a timeout or later exit alone must not remove the explicit stop barrier");
});

test("a retained project lock blocks observation when the stop barrier cannot be written", { skip: !linux, timeout: 20000 }, async t => {
  const f = fixture(t), digest = sha256(fs.readFileSync(process.execPath));
  const exe = path.join(f.state, "runtime", "code-index", "fixture", digest, "node");
  fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.copyFileSync(process.execPath, exe); fs.chmodSync(exe, 0o755);
  const io = { launch: (command, _args, options) => spawn_guarded_linux(command, [path.join(ROOT, "tests/fixtures/index-daemon.mjs")], options) };
  let pins = [], home;
  f.clients.push({ close: async () => {
    t.mock.restoreAll();
    if (home) { try { fs.unlinkSync(path.join(home, "operation.lock")); } catch {} if (await daemon_health(home)) try { await stop_daemon(f.state, f.root); } catch {} }
    for (const pin of pins) if (pin.alive()) pin.signal(9); await expectStopped(pins); pins.forEach(pin => pin.close());
  } });
  home = await ensure_daemon(f.state, f.root, f.profile, exe, io, f.env);
  const owner = read_json(path.join(home, "owner.json")), daemon = read_json(path.join(home, "daemon.json")), observer = new IndexObserver(f.state);
  pins = pinsFor([owner.guards[0].pid, owner.guards[1].pid, owner.pid]);
  const barrier = path.join(home, "guard-cleanup-unknown.json"), write = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (file, ...args) => {
    if (file === barrier) throw Object.assign(new Error("fixture denied"), { code: "EACCES" });
    return write(file, ...args);
  });
  await assert.rejects(stop_daemon(f.state, f.root, { stop: async () => { throw Object.assign(new Error("fixture unknown stop"), { outcomeUnknown: true }); } }),
    error => error.outcomeUnknown === true && error.retainOperationLock === true);
  assert.equal(fs.existsSync(barrier), false); assert.equal(fs.existsSync(path.join(home, "operation.lock")), true);
  assert.throws(() => observer.verifyDaemon(owner, daemon, home), error => error.code === "INDEX_BUSY");
  await assert.rejects(observer.run({}, f.root, {}, {}), error => error.code === "INDEX_BUSY");
  t.mock.restoreAll(); fs.unlinkSync(path.join(home, "operation.lock"));
  assert.ok(observer.verifyDaemon(owner, daemon, home), "observation resumes after the retained lock is removed");
  await stop_daemon(f.state, f.root); await expectStopped(pins);
});

test("a real settings MCP crash terminates its backend and uncommitted Linux daemon tree", { skip: !linux, timeout: 30000 }, async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  await new SettingsBackend().main({ action: "update", set: { codeIndexEnabled: true, codeIndexVersion: "v1.15.6", bslLsEnabled: false } });
  const digest = sha256(fs.readFileSync(process.execPath)), exe = path.join(f.state, "runtime", "code-index", "v1.15.6", digest, "bsl-indexer");
  fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.copyFileSync(process.execPath, exe); fs.chmodSync(exe, 0o755);
  save_json(path.join(f.state, "runtime-lock.json"), { "code-index": { release: "v1.15.6", sha256: digest, path: path.relative(f.state, exe), platform: "linux-x64" } });
  const home = path.join(project_home(f.state, f.root), "code-index"), pidsFile = path.join(f.base, "mcp-daemon-pids.json");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "daemon"), `const fs=require('node:fs'),cp=require('node:child_process');process.on('SIGTERM',()=>{});
    const c=cp.spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});process.send("ready");setTimeout(()=>process.exit(0),25000);setInterval(()=>{},1000)'],
      {detached:true,stdio:['ignore','ignore','ignore','ipc']});
    c.once('message',()=>{c.disconnect();fs.writeFileSync(${JSON.stringify(pidsFile)},JSON.stringify([process.pid,c.pid]));});setTimeout(()=>process.exit(0),25000);setInterval(()=>{},1000);`);
  const mcp = spawn(process.execPath, [path.join(ROOT, "mcp/settings.mjs")], { cwd: f.root, env: f.env, stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise(resolve => mcp.once("close", resolve)); let pins = [], stdout = "", stderr = "", sequence = 0;
  const pending = new Map();
  mcp.stderr.on("data", chunk => { if (stderr.length < 4096) stderr += chunk; });
  mcp.stdout.setEncoding("utf8"); mcp.stdout.on("data", chunk => {
    stdout += chunk; let newline;
    while ((newline = stdout.indexOf("\n")) >= 0) {
      const line = stdout.slice(0, newline); stdout = stdout.slice(newline + 1);
      let message; try { message = JSON.parse(line); } catch { continue; }
      if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error("MCP fixture request timed out: " + method + " " + stderr)); }, 10000);
    pending.set(id, message => { clearTimeout(timer); message.error ? reject(new Error(message.error.message)) : resolve(message.result); });
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  f.clients.push({ close: async () => { if (mcp.exitCode === null && mcp.signalCode === null) mcp.kill("SIGKILL"); await closed; await expectStopped(pins); pins.forEach(pin => pin.close()); } });
  await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "fixture", version: "1" } });
  mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const result = await request("tools/call", { name: "settings.run_check", arguments: { authorization: { scope: f.root + "#first", effects: ["launch"], evidence: "isolated test" } } });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  await waitFor(() => fs.existsSync(pidsFile), "the real backend did not start the daemon: " + stderr, 12000);
  const [daemon, descendant] = JSON.parse(fs.readFileSync(pidsFile));
  const parent = pid => Number(fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ")[1]);
  const worker = parent(daemon), guard = parent(worker), backend = parent(guard);
  assert.equal(parent(backend), mcp.pid, "the settings backend must belong to this MCP session");
  pins = pinsFor([backend, guard, worker, daemon, descendant]);
  const owner = read_json(path.join(home, "owner.json"), {});
  assert.equal(owner.daemon_started_at, undefined, "the fixture must crash before a verified handoff");
  mcp.kill("SIGKILL"); await closed; await expectStopped(pins);
  assert.equal(fs.existsSync(path.join(home, "operation.lock")), true, "crashed setup must retain its project lock");
});
