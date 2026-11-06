import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import net from "node:net";
import { edt_fixture as fixture, ROOT } from "./helpers.mjs";
import { settings } from "../scripts/common.mjs";
import { acquire_reader, active_readers, restart_index, project_home, save_json } from "../scripts/runtime.mjs";
import { open_reader, reader_active } from "../scripts/reader_lease.mjs";

test("an exited reader cannot block maintenance when its PID belongs to another live process", async t => {
  const f = fixture(t), file = path.join(project_home(f.state, f.root), "code-index/readers", randomUUID() + ".json");
  save_json(file, { id: randomUUID(), pid: process.pid, root: f.root });
  const calls = [];
  const result = await restart_index(f.state, settings(), f.root, f.profile, {
    installed: async () => "fixture-exe", stop: async () => calls.push("stop"),
    restart: async () => calls.push("restart"), smoke: async () => ({ index_ready: true }),
  });
  assert.equal(result.state, "ready");
  assert.deepEqual(calls, ["stop", "restart"]);
  assert.equal(fs.existsSync(file), false);
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
