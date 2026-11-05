import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { launch, stop_child, alive } from "../scripts/processes.mjs";
import { fixture, ROOT } from "./helpers.mjs";

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
  const code = `import {launch} from ${JSON.stringify(processes)}; import {spawn_detached_windows} from ${JSON.stringify(windows)}; import fs from 'node:fs';
    const child=process.platform==='win32'
      ? spawn_detached_windows(process.execPath,['-e','setTimeout(()=>{},2000)'],{cwd:process.cwd(),env:process.env})
      : launch(process.execPath,['-e','setTimeout(()=>{},2000)'],{sessionOwned:false,detached:true,stdio:'ignore'});
    child.release?.(); fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); setInterval(()=>{},1000);`;
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
