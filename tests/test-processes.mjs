import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { launch, stop_child, alive } from "../scripts/processes.mjs";
import { windows_handle_count, windows_process_identity, pin_windows_process, pin_windows_readonly_file, spawn_detached_windows } from "../scripts/windows_process.mjs";
import { fixture, ROOT } from "./helpers.mjs";

test("Windows file pins prevent writes, replacement and ancestor renames until release", { skip: process.platform !== "win32" }, t => {
  const f = fixture(t), directory = path.join(f.base, "pinned"), file = path.join(directory, "source.bin");
  fs.mkdirSync(directory); fs.writeFileSync(file, "original");
  const link = path.join(f.base, "hard-link.bin"); fs.linkSync(file, link);
  const writer = fs.openSync(file, "r+");
  try { assert.throws(() => pin_windows_readonly_file(file), /Cannot pin file path/); }
  finally { fs.closeSync(writer); }
  const pin = pin_windows_readonly_file(file);
  try {
    assert.equal(fs.readFileSync(pin.path, "utf8"), "original");
    assert.throws(() => fs.writeFileSync(file, "changed"));
    assert.throws(() => fs.writeFileSync(link, "changed"));
    assert.throws(() => fs.renameSync(file, file + ".old"));
    assert.throws(() => fs.renameSync(directory, directory + ".old"));
    assert.equal(fs.readFileSync(file, "utf8"), "original");
  } finally { pin.close(); }
  pin.close();
  fs.writeFileSync(file, "after release");
  assert.equal(fs.readFileSync(link, "utf8"), "after release");
  fs.renameSync(directory, directory + ".old");
});

test("Windows file pins reject an existing writable mapping", { skip: process.platform !== "win32" }, t => {
  const f = fixture(t), file = path.join(f.base, "mapped.bin"); fs.writeFileSync(file, "original");
  const koffi = createRequire(import.meta.url)(path.join(ROOT, "vendor/native", "win32_" + process.arch, "koffi.node"));
  const kernel = koffi.load("kernel32.dll");
  const open = kernel.func("void * __stdcall CreateFileW(str16 name, uint32_t access, uint32_t share, void *security, uint32_t creation, uint32_t flags, void *templateFile)");
  const map = kernel.func("void * __stdcall CreateFileMappingW(void *file, void *security, uint32_t protect, uint32_t high, uint32_t low, str16 name)");
  const view = kernel.func("void * __stdcall MapViewOfFile(void *mapping, uint32_t access, uint32_t high, uint32_t low, size_t bytes)");
  const unmap = kernel.func("int __stdcall UnmapViewOfFile(void *view)");
  const close = kernel.func("int __stdcall CloseHandle(void *handle)");
  let handle, mapping, mapped;
  try {
    handle = open(file, 0xc0000000, 7, null, 3, 0x80, null);
    if (handle && BigInt.asIntN(64, koffi.address(handle)) === -1n) handle = null;
    assert.ok(handle);
    mapping = map(handle, null, 4, 0, 0, null); assert.ok(mapping);
    mapped = view(mapping, 2, 0, 0, 0); assert.ok(mapped);
    const opened = handle; handle = null;
    assert.ok(close(opened));
    assert.throws(() => pin_windows_readonly_file(file), /Cannot pin file path/);
  } finally {
    const results = [mapped ? unmap(mapped) : 1, mapping ? close(mapping) : 1, handle ? close(handle) : 1];
    assert.ok(results.every(Boolean), "mapping handles must be released");
  }
  const pin = pin_windows_readonly_file(file); pin.close();
});

test("a terminated Windows process has no live identity even while its handle is pinned", { skip: process.platform !== "win32" }, async t => {
  const f = fixture(t), child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", windowsHide: true });
  const closed = new Promise(resolve => child.once("close", resolve));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await closed; });
  await once(child, "spawn");
  const pin = pin_windows_process(child.pid);
  try {
    child.kill("SIGKILL"); await closed;
    assert.equal(pin.alive(), false);
    assert.equal(windows_process_identity(child.pid), null);
  } finally { pin.close(); }
});

test("concurrent shutdown callers share the owned child's termination", async t => {
  const f = fixture(t), child = launch(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: ["pipe", "ignore", "ignore"] });
  f.clients.push({ close: () => stop_child(child, 0) });
  await once(child, "spawn");
  const first = stop_child(child, 0), second = stop_child(child, 0);
  assert.equal(first, second);
  await first;
  await stop_child(child, 0);
  assert.equal(alive(child.pid), false);
  assert.equal(alive(process.pid), true);
});

test("forwarded IPC preserves ownership when the parent dies", { timeout: 16000, skip: process.platform === "darwin" }, async t => {
  const f = fixture(t), file = path.join(f.base, "forwarded-processes.json"), module = pathToFileURL(path.join(ROOT, "scripts/processes.mjs")).href;
  const target = `process.on('message', m => { if (m.ping) process.send({pong:process.pid}); });
    process.send({ready:process.pid}); setTimeout(()=>process.exit(0),8000); setInterval(()=>{},1000);`;
  const ownerCode = `import fs from 'node:fs'; import {randomUUID} from 'node:crypto'; import {launch} from ${JSON.stringify(module)};
    const child=launch(process.execPath,['-e',${JSON.stringify(target)}],{stdio:'ignore',forwardIpc:true,readerJob:randomUUID()}); let target;
    child.on('message', m=>{if(m.relay?.ready){target=m.relay.ready; child.send({relay:{ping:true}});} if(Number.isSafeInteger(target)&&m.relay?.pong===target) fs.writeFileSync(${JSON.stringify(file)},JSON.stringify([child.pid,target]));});
    setInterval(()=>{},1000);`;
  const owner = spawn(process.execPath, ["--input-type=module", "-e", ownerCode], { stdio: "ignore", windowsHide: true });
  const closed = new Promise(resolve => owner.once("close", resolve)); let owned = [];
  t.after(async () => {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
    await closed;
    for (let i = 0; i < 900 && owned.some(alive); i++) await new Promise(resolve => setTimeout(resolve, 10));
  });
  for (let i = 0; i < 500 && !fs.existsSync(file); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(fs.existsSync(file), "both IPC directions must be established");
  owned = JSON.parse(fs.readFileSync(file, "utf8")); assert.ok(owned.every(alive));
  owner.kill("SIGKILL"); await closed;
  for (let i = 0; i < 500 && owned.some(alive); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(owned.every(pid => !alive(pid)), "the backend tree must not survive its owner");
});

test("a protected backend can start and confirm a nested protected child", { timeout: 15000, skip: process.platform === "darwin" }, async t => {
  const module = pathToFileURL(path.join(ROOT, "scripts/processes.mjs")).href;
  const code = `import {launch,stop_child} from ${JSON.stringify(module)}; import {randomUUID} from 'node:crypto'; import {once} from 'node:events';
    const child=launch(process.execPath,['-e','console.log("ready");process.stdin.resume();'],{readerJob:randomUUID(),stdio:['pipe','pipe','ignore']});
    await once(child.stdout,'data'); await stop_child(child,0); console.log('nested-stopped');`;
  const outer = launch(process.execPath, ["--input-type=module", "-e", code], { readerJob: randomUUID(), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  outer.stdout.on("data", chunk => { stdout += chunk; }); outer.stderr.on("data", chunk => { stderr += chunk; });
  try { const [code] = await once(outer, "close"); assert.equal(code, 0, stderr); assert.match(stdout, /nested-stopped/); }
  finally { await stop_child(outer, 0); }
});

test("macOS protected launches fail closed before starting a process", async () => {
  const module = pathToFileURL(path.join(ROOT, "scripts/processes.mjs")).href;
  const code = `Object.defineProperty(process,'platform',{value:'darwin'}); const {launch}=await import(${JSON.stringify(module)}); const {randomUUID}=await import('node:crypto');
    try { launch(process.execPath,['-e','process.exit(0)'],{readerJob:randomUUID()}); process.exitCode=1; }
    catch(error) { if(error.code==='PROCESS_CONTAINMENT_UNAVAILABLE'&&error.notSpawned===true) console.log('rejected'); else process.exitCode=2; }`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  let output = ""; child.stdout.on("data", chunk => { output += chunk; });
  const [status] = await once(child, "close");
  assert.equal(status, 0); assert.equal(output.trim(), "rejected");
});

test("macOS direct index daemon startup refuses before launching or writing config", async t => {
  const f = fixture(t), home = path.join(f.base, "index-home"), module = pathToFileURL(path.join(ROOT, "scripts/runtime.mjs")).href;
  fs.mkdirSync(home);
  const code = `Object.defineProperty(process,'platform',{value:'darwin'});const {start_daemon}=await import(${JSON.stringify(module)});
    let launched=false;try {await start_daemon(${JSON.stringify(home)},${JSON.stringify(f.root)},${JSON.stringify(f.profile)},process.execPath,
      {launch(){launched=true;throw new Error('unexpected launch');}});process.exitCode=1;}
    catch(error){if(error.code==='PROCESS_CONTAINMENT_UNAVAILABLE'&&error.notSpawned===true&&!launched)console.log('rejected');else {console.error(error);process.exitCode=2;}}`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "", stderr = ""; child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  const [status] = await once(child, "close");
  assert.equal(status, 0, stderr); assert.equal(stdout.trim(), "rejected"); assert.deepEqual(fs.readdirSync(home), []);
});

test("macOS managed smoke, updates and maintenance refuse protected launches", async t => {
  const f = fixture(t), runtime = pathToFileURL(path.join(ROOT, "scripts/runtime.mjs")).href,
    common = pathToFileURL(path.join(ROOT, "scripts/common.mjs")).href;
  fs.writeFileSync(path.join(f.root, ".project"), "<projectDescription><name>Product</name></projectDescription>");
  const code = `import assert from 'node:assert/strict';import fs from 'node:fs';
    Object.defineProperty(process,'platform',{value:'darwin'});
    const {smoke,restart_index,update_component}=await import(${JSON.stringify(runtime)}),{settings}=await import(${JSON.stringify(common)});
    const config=settings(),calls=[];config.mcp.managed['code-index'].enabled=true;config.mcp.managed['bsl-ls'].enabled=true;
    const io={installed:()=>calls.push('installed'),launch:()=>calls.push('launch'),stop:()=>calls.push('stop'),smoke:()=>calls.push('smoke')};
    const state=${JSON.stringify(f.state)},root=${JSON.stringify(f.root)},profile=${JSON.stringify(f.profile)};
    for(const operation of [()=>smoke(state,config,root,profile,'bsl-ls'),()=>restart_index(state,config,root,profile,io),()=>update_component(state,config,root,profile,'bsl-ls','apply',io)])
      await assert.rejects(operation,error=>error.code==='PROCESS_CONTAINMENT_UNAVAILABLE'&&error.notSpawned===true);
    assert.deepEqual(calls,[]);assert.deepEqual(fs.readdirSync(state),[]);console.log('rejected');`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let output = "", errors = ""; child.stdout.on("data", chunk => output += chunk); child.stderr.on("data", chunk => errors += chunk);
  const [status] = await once(child, "close"); assert.equal(status, 0, errors); assert.equal(output.trim(), "rejected");
});

test("a protected index reader closes its entire owned process tree", { timeout: 15000, skip: process.platform === "darwin" }, async t => {
  const f = fixture(t), pidFile = path.join(f.base, "strict-tree.json");
  const source = `import {spawn} from 'node:child_process'; import fs from 'node:fs';
    process.on('SIGTERM',()=>{});
    const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{}); process.send("ready"); setInterval(()=>{},1000)'],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
    child.once('message',()=>fs.writeFileSync(process.argv[1],JSON.stringify({target:process.pid,descendant:child.pid})));
    setInterval(()=>{},1000);`;
  const child = launch(process.execPath, ["--input-type=module", "-e", source, pidFile], { readerJob: randomUUID(), stdio: ["pipe", "pipe", "pipe"] });
  f.clients.push({ close: () => stop_child(child, 0) });
  for (let i = 0; i < 300 && !fs.existsSync(pidFile); i++) await new Promise(done => setTimeout(done, 10));
  assert.ok(fs.existsSync(pidFile), "protected reader and its descendant must start");
  const pids = Object.values(JSON.parse(fs.readFileSync(pidFile, "utf8")));
  assert.ok(pids.every(alive));
  await stop_child(child, 0);
  assert.ok(pids.every(pid => !alive(pid)), "the lease may be released only after the whole tree exits");
});


test("a protected reader reaps a descendant that leaves its process group", { timeout: 15000, skip: process.platform === "darwin" }, async t => {
  const f = fixture(t), pidFile = path.join(f.base, "detached-reader.json");
  const source = `import {spawn} from 'node:child_process'; import fs from 'node:fs';
    process.on('SIGTERM',()=>{});
    const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{}); process.send("ready"); setTimeout(()=>process.exit(0),8000); setInterval(()=>{},1000)'],{detached:true,stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
    child.once('message',()=>fs.writeFileSync(process.argv[1],JSON.stringify({target:process.pid,descendant:child.pid})));
    setInterval(()=>{},1000);`;
  const child = launch(process.execPath, ["--input-type=module", "-e", source, pidFile], { readerJob: randomUUID(), stdio: ["pipe", "pipe", "pipe"] });
  f.clients.push({ close: () => stop_child(child, 0) });
  for (let i = 0; i < 300 && !fs.existsSync(pidFile); i++) await new Promise(done => setTimeout(done, 10));
  assert.ok(fs.existsSync(pidFile));
  const pids = Object.values(JSON.parse(fs.readFileSync(pidFile, "utf8")));
  t.after(async () => { for (let i = 0; i < 900 && pids.some(alive); i++) await new Promise(done => setTimeout(done, 10)); });
  assert.ok(pids.every(alive));
  await stop_child(child, 0);
  assert.ok(pids.every(pid => !alive(pid)), "a detached descendant must be gone before releasing the lease");
});

test("repeated protected readers release their processes and controller handles", { timeout: 30000, skip: process.platform === "darwin" }, async () => {
  const count = () => process.platform === "win32" ? windows_handle_count() : fs.readdirSync("/proc/self/fd").length;
  const identity = pid => {
    if (process.platform === "win32") return windows_process_identity(pid)?.created ?? null;
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] || null;
    } catch (error) { if (["ENOENT", "ESRCH"].includes(error.code)) return null; throw error; }
  };
  const pids = [], counts = [];
  for (let i = 0; i < 16; i++) {
    const child = launch(process.execPath, ["-e", "console.log(process.pid); process.stdin.resume();"], { readerJob: randomUUID(), stdio: ["pipe", "pipe", "ignore"] });
    const [line] = await once(child.stdout, "data");
    for (const pid of [Number(String(line).trim()), child.pid]) {
      assert.ok(Number.isSafeInteger(pid) && pid > 0);
      const created = identity(pid);
      assert.ok(created, "must capture the identity of each running process");
      pids.push({ pid, created });
    }
    await stop_child(child, 0);
    counts.push(count());
  }
  await new Promise(done => setTimeout(done, 150));
  // A PID may be recycled by an unrelated parallel test; only the original
  // process identity is evidence that an owned process is still alive.
  const live = pids.filter(({ pid, created }) => identity(pid) === created);
  assert.deepEqual(live, [], "every owned supervisor and reader must exit");
  // Node/libuv lazily creates persistent process-handling resources. Compare
  // subsequent iterations with the first warmed-up lifecycle.
  const after = count();
  assert.ok(after - counts[0] <= 6, `repeated readers must not accumulate handles or descriptors: ${counts}, ${after}`);
});

test("a crashed protected reader owner releases a detached descendant", { timeout: 15000, skip: process.platform === "darwin" }, async t => {
  const f = fixture(t), targetFile = path.join(f.base, "strict-target.mjs"), pidsFile = path.join(f.base, "strict-pids.json"), supervisorFile = path.join(f.base, "strict-supervisor.pid");
  const processes = pathToFileURL(path.join(ROOT, "scripts/processes.mjs")).href;
  fs.writeFileSync(targetFile, `import {spawn} from 'node:child_process'; import fs from 'node:fs';
    process.on('SIGTERM',()=>{});
    const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{}); process.send("ready"); setTimeout(()=>process.exit(0),8000); setInterval(()=>{},1000)'],{detached:true,stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
    child.once('message',()=>fs.writeFileSync(${JSON.stringify(pidsFile)},JSON.stringify({target:process.pid,descendant:child.pid})));
    setInterval(()=>{},1000);`);
  const code = `import {launch} from ${JSON.stringify(processes)}; import {randomUUID} from 'node:crypto'; import fs from 'node:fs';
    const child=launch(process.execPath,[${JSON.stringify(targetFile)}],{readerJob:randomUUID(),stdio:'ignore'});
    fs.writeFileSync(${JSON.stringify(supervisorFile)},String(child.pid)); setInterval(()=>{},1000);`;
  const owner = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: "ignore", windowsHide: true });
  const closed = new Promise(resolve => owner.once("close", resolve));
  t.after(async () => { if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL"); await closed; });
  for (let i = 0; i < 300 && !fs.existsSync(pidsFile); i++) await new Promise(done => setTimeout(done, 10));
  assert.ok(fs.existsSync(pidsFile));
  const pids = [...Object.values(JSON.parse(fs.readFileSync(pidsFile, "utf8"))), Number(fs.readFileSync(supervisorFile, "utf8"))];
  t.after(async () => { for (let i = 0; i < 900 && pids.some(alive); i++) await new Promise(done => setTimeout(done, 10)); });
  assert.ok(pids.every(alive));
  owner.kill("SIGKILL"); await closed;
  for (let i = 0; i < 600 && pids.some(alive); i++) await new Promise(done => setTimeout(done, 10));
  assert.ok(pids.every(pid => !alive(pid)), "the owner crash must not leave a protected descendant");
});

for (const exitBeforeStop of [true, false]) {
  test(`POSIX cleanup kills a TERM-resistant descendant after leader ${exitBeforeStop ? "exit" : "termination"}`, { skip: process.platform === "win32" }, async t => {
    const f = fixture(t), pidFile = path.join(f.base, "descendant.pid");
    const script = `import {spawn} from 'node:child_process'; import fs from 'node:fs';
      const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{}); process.send("ready"); setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit','ipc']});
      child.once('message',()=>{fs.writeFileSync(process.argv[1],String(child.pid));${exitBeforeStop ? "setTimeout(()=>process.exit(0),50);" : "process.on('SIGTERM',()=>process.exit(0));"}});
      setInterval(()=>{},1000);`;
    const child = launch(process.execPath, ["--input-type=module", "-e", script, pidFile], { stdio: ["pipe", "pipe", "pipe"] });
    f.clients.push({ close: () => stop_child(child, 0) });
    const exited = once(child, "exit");
    for (let i = 0; i < 200 && !fs.existsSync(pidFile); i++) await new Promise(done => setTimeout(done, 10));
    assert.ok(fs.existsSync(pidFile));
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    assert.ok(alive(pid));
    if (exitBeforeStop) await exited;
    await stop_child(child, 0);
    for (let i = 0; i < 100 && alive(pid); i++) await new Promise(done => setTimeout(done, 10));
    assert.equal(alive(pid), false);
    assert.equal(alive(process.pid), true);
  });
}

test("target startup errors and exit codes survive supervision without retaining its owner", async () => {
  const missing = launch(path.join(ROOT, "missing-owned-program"), [], { stdio: "ignore" });
  const closed = new Promise(resolve => missing.once("close", resolve));
  const [error] = await once(missing, "error");
  assert.equal(error.code, "ENOENT");
  await closed; await stop_child(missing, 0);
  assert.equal(alive(missing.pid), false);
  const child = launch(process.execPath, ["-e", "process.exit(7)"], { stdio: "ignore" });
  assert.equal((await once(child, "close"))[0], 7);
  await stop_child(child, 0);
});

test("a protected reader that cannot start leaves no live process", { skip: process.platform === "darwin" }, async () => {
  const child = launch(path.join(ROOT, "missing-owned-program"), [], { readerJob: randomUUID(), stdio: "ignore" });
  const closed = new Promise(resolve => child.once("close", resolve));
  const [error] = await once(child, "error");
  assert.equal(error.code, "ENOENT");
  await closed; await stop_child(child, 0);
  assert.equal(alive(child.pid), false);
});

test("Linux refuses a protected reader cleanly when pidfd is unavailable", { skip: process.platform !== "linux" || process.env.EDT_AI_TEST_DENY_PIDFD !== "1" }, async () => {
  const child = launch(process.execPath, ["-e", "setInterval(()=>{},1000)"], { readerJob: randomUUID(), stdio: "ignore" });
  const closed = new Promise(resolve => child.once("close", resolve));
  const [error] = await once(child, "error");
  assert.match(error.message, /Cannot open owned Linux process/);
  await closed; await stop_child(child, 0);
  assert.equal(alive(child.pid), false);
});

test("target preloads run once in the target and cannot change the supervisor bootstrap", async t => {
  const f = fixture(t), preload = path.join(f.base, "preload.mjs"), marker = path.join(f.base, "preloaded.pid");
  fs.writeFileSync(preload, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(marker)},String(process.pid)+'\\n');`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "NODE_OPTIONS"));
  env[process.platform === "win32" ? "node_options" : "NODE_OPTIONS"] = "--import " + pathToFileURL(preload).href;
  const child = launch(process.execPath, ["-e", "console.log(process.pid)"], { env, stdio: ["ignore", "pipe", "pipe"] });
  f.clients.push({ close: () => stop_child(child, 0) });
  let output = ""; child.stdout.on("data", chunk => { output += chunk; });
  assert.equal((await once(child, "close"))[0], 0);
  assert.equal(fs.readFileSync(marker, "utf8"), output);
  assert.notEqual(Number(output.trim()), child.pid);
});

test("killing the owner releases its supervisor and a TERM-resistant tree without touching another session", { timeout: 15000 }, async t => {
  const f = fixture(t), targetFile = path.join(f.base, "target.mjs"), pidsFile = path.join(f.base, "tree.json"), supervisorFile = path.join(f.base, "supervisor.pid");
  const processes = pathToFileURL(path.join(ROOT, "scripts/processes.mjs")).href;
  fs.writeFileSync(targetFile, `import {spawn} from 'node:child_process'; import fs from 'node:fs';
    process.on('SIGTERM',()=>{});
    const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{}); process.send("ready"); setInterval(()=>{},1000)'],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
    child.once('message',()=>fs.writeFileSync(${JSON.stringify(pidsFile)},JSON.stringify({target:process.pid,descendant:child.pid})));
    setInterval(()=>{},1000);`);
  const code = `import {launch} from ${JSON.stringify(processes)}; import fs from 'node:fs';
    const child=launch(process.execPath,[${JSON.stringify(targetFile)}],{stdio:'ignore'});
    fs.writeFileSync(${JSON.stringify(supervisorFile)},String(child.pid)); setInterval(()=>{},1000);`;
  const owner = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: "ignore", windowsHide: true });
  const foreign = launch(process.execPath, ["-e", "process.stdin.on('data',chunk=>process.stdout.write(chunk));"], { stdio: ["pipe", "pipe", "ignore"] });
  const ownerClosed = new Promise(resolve => owner.once("close", resolve)), foreignClosed = new Promise(resolve => foreign.once("close", resolve));
  t.after(async () => {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
    await stop_child(foreign, 0);
    await Promise.all([ownerClosed, foreignClosed]);
  });
  for (let i = 0; i < 300 && !fs.existsSync(pidsFile); i++) await new Promise(done => setTimeout(done, 10));
  assert.ok(fs.existsSync(pidsFile), "the first target action must create its descendant");
  const pids = [...Object.values(JSON.parse(fs.readFileSync(pidsFile))), Number(fs.readFileSync(supervisorFile))];
  for (const pid of pids) assert.equal(alive(pid), true);
  owner.kill("SIGKILL"); await ownerClosed;
  for (let i = 0; i < 300 && pids.some(alive); i++) await new Promise(done => setTimeout(done, 10));
  for (const pid of pids) assert.equal(alive(pid), false, `owned process ${pid} must not outlive the crashed owner`);
  assert.equal(alive(foreign.pid), true);
  const echoed = once(foreign.stdout, "data"); foreign.stdin.write("independent session\n");
  assert.equal(String((await echoed)[0]), "independent session\n");
  assert.equal(alive(process.pid), true);
});

test("an independently owned daemon survives a hard owner exit", { timeout: 10000 }, async t => {
  const f = fixture(t), pidFile = path.join(f.base, "independent.pid");
  const processes = pathToFileURL(path.join(ROOT, "scripts/processes.mjs")).href;
  const windows = pathToFileURL(path.join(ROOT, "scripts/windows_process.mjs")).href;
  const target = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid)); setTimeout(()=>{},2000)`;
  const code = `import {launch} from ${JSON.stringify(processes)}; import {spawn_detached_windows} from ${JSON.stringify(windows)}; import fs from 'node:fs';
    const child=process.platform==='win32'
      ? spawn_detached_windows(process.execPath,['-e',${JSON.stringify(target)}],{cwd:process.cwd(),env:process.env})
      : launch(process.execPath,['-e',${JSON.stringify(target)}],{sessionOwned:false,detached:true,stdio:'ignore'});
    child.release?.(); setInterval(()=>{},1000);`;
  const owner = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: "ignore", windowsHide: true });
  const closed = new Promise(resolve => owner.once("close", resolve));
  t.after(async () => { if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL"); await closed; });
  for (let i = 0; i < 300 && !fs.existsSync(pidFile); i++) await new Promise(done => setTimeout(done, 10));
  assert.ok(fs.existsSync(pidFile));
  const pid = Number(fs.readFileSync(pidFile));
  owner.kill("SIGKILL"); await closed;
  assert.equal(alive(pid), true);
  for (let i = 0; i < 300 && alive(pid); i++) await new Promise(done => setTimeout(done, 10));
  assert.equal(alive(pid), false, "the independent fixture exits on its own schedule");
});

test("Windows terminates the daemon startup job when its owner crashes", { skip: process.platform !== "win32", timeout: 18000 }, async t => {
  const f = fixture(t), pidFile = path.join(f.base, "daemon-startup-tree.json");
  const sentinel = launch(process.execPath, ["-e", "process.stdin.resume();setInterval(()=>{},1000)"], { readerJob: randomUUID(), stdio: ["pipe", "ignore", "ignore"] });
  f.clients.push({ close: () => stop_child(sentinel, 0) });
  const windows = pathToFileURL(path.join(ROOT, "scripts/windows_process.mjs")).href;
  const target = `const fs=require('node:fs'),cp=require('node:child_process');
    const child=cp.spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),10000);setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
    child.once('spawn',()=>fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify([process.pid,child.pid])));
    setTimeout(()=>process.exit(0),10000);setInterval(()=>{},1000);`;
  const ownerCode = `import {spawn_detached_windows} from ${JSON.stringify(windows)};
    spawn_detached_windows(process.execPath,['-e',${JSON.stringify(target)}],{cwd:process.cwd(),env:process.env,guardUntilCommit:true});setInterval(()=>{},1000);`;
  const owner = spawn(process.execPath, ["--input-type=module", "-e", ownerCode], { stdio: "ignore", windowsHide: true });
  const closed = new Promise(resolve => owner.once("close", resolve)); let pins = [];
  t.after(async () => {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
    await closed;
    for (let i = 0; i < 1100 && pins.some(pin => pin.alive()); i++) await new Promise(resolve => setTimeout(resolve, 10));
    for (const pin of pins) pin.close();
  });
  for (let i = 0; i < 400 && !fs.existsSync(pidFile); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(fs.existsSync(pidFile));
  pins = JSON.parse(fs.readFileSync(pidFile, "utf8")).map(pin_windows_process);
  assert.ok(pins.every(pin => pin.alive()));
  owner.kill("SIGKILL"); await closed;
  for (let i = 0; i < 500 && pins.some(pin => pin.alive()); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(pins.every(pin => !pin.alive()));
  assert.equal(sentinel.exitCode, null); assert.equal(sentinel.signalCode, null);
});

test("Windows commits an intentionally persistent daemon only after startup", { skip: process.platform !== "win32", timeout: 10000 }, async t => {
  const f = fixture(t), pidFile = path.join(f.base, "committed-daemon.pid"), readyFile = path.join(f.base, "committed.ready");
  const windows = pathToFileURL(path.join(ROOT, "scripts/windows_process.mjs")).href;
  const target = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidFile + ".tmp")},String(process.pid));fs.renameSync(${JSON.stringify(pidFile + ".tmp")},${JSON.stringify(pidFile)});setTimeout(()=>process.exit(0),2000);`;
  const ownerCode = `import fs from 'node:fs';import {spawn_detached_windows} from ${JSON.stringify(windows)};
    const child=spawn_detached_windows(process.execPath,['-e',${JSON.stringify(target)}],{cwd:process.cwd(),env:process.env,guardUntilCommit:true});
    child.commit();child.release();fs.writeFileSync(${JSON.stringify(readyFile)},'committed');setInterval(()=>{},1000);`;
  const owner = spawn(process.execPath, ["--input-type=module", "-e", ownerCode], { stdio: "ignore", windowsHide: true });
  const closed = new Promise(resolve => owner.once("close", resolve));
  t.after(async () => { if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL"); await closed; });
  for (let i = 0; i < 400 && (!fs.existsSync(pidFile) || !fs.existsSync(readyFile)); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(fs.existsSync(pidFile) && fs.existsSync(readyFile));
  const pin = pin_windows_process(Number(fs.readFileSync(pidFile, "utf8"))); t.after(() => pin.close());
  owner.kill("SIGKILL"); await closed;
  assert.equal(pin.alive(), true);
  for (let i = 0; i < 400 && pin.alive(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(pin.alive(), false);
});

test("Windows startup rollback confirms process exit and releases job handles", { skip: process.platform !== "win32", timeout: 12000 }, async () => {
  let warmed;
  for (let i = 0; i < 12; i++) {
    const child = spawn_detached_windows(process.execPath, ["-e", "setTimeout(()=>process.exit(0),8000);setInterval(()=>{},1000)"],
      { cwd: process.cwd(), env: process.env, guardUntilCommit: true });
    const pin = pin_windows_process(child.pid);
    try { const first = child.rollback(), second = child.rollback(); assert.equal(first, second); await first; await child.rollback(); assert.equal(pin.alive(), false); }
    finally { pin.close(); child.release(); }
    if (!i) warmed = windows_handle_count();
  }
  assert.ok(windows_handle_count() - warmed <= 3, "startup jobs must not accumulate handles");
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(`repeated POSIX ${signal} signals cannot interrupt descendant escalation`, { skip: process.platform === "win32", timeout: 10000 }, async t => {
    const f = fixture(t), child = launch(process.execPath, ["-e", `process.on('SIGTERM',()=>{}); console.log(process.pid); setInterval(()=>{},1000);`], { stdio: ["ignore", "pipe", "ignore"] });
    f.clients.push({ close: () => stop_child(child, 0) });
    const closed = once(child, "close");
    const [ready] = await once(child.stdout, "data"), target = Number(String(ready).trim());
    child.kill(signal); await new Promise(resolve => setTimeout(resolve, 30)); child.kill(signal);
    assert.deepEqual(await closed, [128 + constants.signals.SIGKILL, null]);
    assert.equal(alive(target), false);
    assert.equal(alive(child.pid), false);
  });
}
