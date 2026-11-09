import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { edt_fixture as fixture, environment, ROOT } from "./helpers.mjs";
import { grant_preparation, preparation_granted } from "../scripts/components.mjs";
import { instance_directory } from "../scripts/project_paths.mjs";
import { copy_and_hash_regular_file } from "../scripts/bounded_file.mjs";
import { bsl_readiness_fingerprint, vanessa_runtime_snapshot } from "../scripts/setup_readiness.mjs";

test("copying and hashing a runtime does not block the event loop", async t => {
  const f = fixture(t), source = path.join(f.base, "source"), target = path.join(f.base, "copy"), bytes = Buffer.alloc(8 * 1024 * 1024, 91);
  fs.writeFileSync(source, bytes); let ticked = false;
  setImmediate(() => { ticked = true; });
  const digest = await copy_and_hash_regular_file(source, target, 16 * 1024 * 1024);
  assert.equal(ticked, true); assert.equal(digest, createHash("sha256").update(bytes).digest("hex"));
  assert.deepEqual(fs.readFileSync(target), bytes);
});

test("a pre-created copy is written only when its identity still matches", async t => {
  const f = fixture(t), source = path.join(f.base, "source"), target = path.join(f.base, "copy"), bytes = Buffer.from("verified runtime");
  fs.writeFileSync(source, bytes); fs.writeFileSync(target, "");
  const stat = fs.statSync(target, { bigint: true }), identity = { dev: String(stat.dev), ino: String(stat.ino) };
  const digest = await copy_and_hash_regular_file(source, target, 1024, 30000, identity);
  assert.equal(digest, createHash("sha256").update(bytes).digest("hex"));
  assert.deepEqual(fs.readFileSync(target), bytes);
  await assert.rejects(copy_and_hash_regular_file(source, target, 1024, 30000, identity), /Destination changed/);
  assert.deepEqual(fs.readFileSync(target), bytes);
});

test("a destination replaced while opening is not written or removed", async t => {
  const f = fixture(t), source = path.join(f.base, "source"), target = path.join(f.base, "copy"), original = target + ".original";
  fs.writeFileSync(source, "verified runtime"); fs.writeFileSync(target, "");
  const stat = fs.statSync(target, { bigint: true }), identity = { dev: String(stat.dev), ino: String(stat.ino) }, open = fs.promises.open;
  let replaced = false;
  t.mock.method(fs.promises, "open", async (file, ...args) => {
    if (file === target) { fs.renameSync(target, original); fs.writeFileSync(target, "untouched"); replaced = true; }
    return open(file, ...args);
  });
  await assert.rejects(copy_and_hash_regular_file(source, target, 1024, 30000, identity), /Destination changed while opening/);
  assert.equal(replaced, true);
  assert.equal(fs.readFileSync(target, "utf8"), "untouched");
  assert.equal(fs.readFileSync(original, "utf8"), "");
});

test("oversized preparation records fail closed without changing other settings", t => {
  const f = fixture(t); environment(t, f.env); f.save(); grant_preparation(f.state, f.root, ["code-index"]);
  const file = path.join(instance_directory(f.state, f.root), "first.preparation.json");
  fs.writeFileSync(file, Buffer.alloc(64 * 1024 + 1, 32));
  assert.throws(() => preparation_granted(f.state, f.root, "code-index"), /Invalid or oversized/);
  assert.throws(() => grant_preparation(f.state, f.root, ["bsl-ls"]), /Invalid or oversized/);
  assert.ok(fs.statSync(file).isFile());
});

test("Vanessa snapshots still resolve an allowed project symlink", { skip: process.platform === "win32" }, t => {
  const f = fixture(t), file = path.join(f.root, ".ai", "runtime.json"), link = path.join(f.root, ".ai", "runtime-link.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{}"); fs.symlinkSync(file, link);
  const snapshot = vanessa_runtime_snapshot(f.root, { testing: { vanessa_config: { runtime_profile: ".ai/runtime-link.json" } } });
  assert.equal(snapshot.file, fs.realpathSync.native(file));
  assert.equal(snapshot.digest, createHash("sha256").update("{}").digest("hex"));
});

test("a symlinked BSL configuration invalidates readiness when its target changes", { skip: process.platform === "win32" }, t => {
  const f = fixture(t), file = path.join(f.base, "first.json"), replacement = path.join(f.base, "second.json"), link = path.join(f.base, "config.json");
  fs.writeFileSync(file, "first"); fs.writeFileSync(replacement, "second"); fs.symlinkSync(file, link);
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, "settings/defaults.json"), "utf8"));
  config.active_project = f.root; config.mcp.managed["bsl-ls"].configuration = link;
  const first = bsl_readiness_fingerprint(f.state, config);
  fs.writeFileSync(file, "second");
  const changed = bsl_readiness_fingerprint(f.state, config);
  assert.notEqual(changed, first);
  fs.unlinkSync(link); fs.symlinkSync(replacement, link);
  assert.notEqual(bsl_readiness_fingerprint(f.state, config), changed);
});

test("the implicit project BSL configuration invalidates readiness", t => {
  const f = fixture(t), file = path.join(f.root, ".bsl-language-server.json");
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, "settings/defaults.json"), "utf8"));
  config.active_project = f.root;
  const absent = bsl_readiness_fingerprint(f.state, config);
  fs.writeFileSync(file, "{}");
  const present = bsl_readiness_fingerprint(f.state, config);
  assert.notEqual(present, absent);
  fs.writeFileSync(file, '{"language":"en"}');
  assert.notEqual(bsl_readiness_fingerprint(f.state, config), present);
});

test("a FIFO substituted before reading Vanessa runtime does not block refresh", { skip: !((process.platform === "linux" && process.arch === "x64") || (process.platform === "darwin" && process.arch === "arm64")), timeout: 10000 }, async t => {
  const f = fixture(t), file = path.join(f.root, ".ai", "runtime.json"), fifo = file + ".fifo";
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "{}");
  const platform = process.platform === "linux" && !process.report.getReport().header.glibcVersionRuntime ? "musl" : process.platform;
  const koffi = createRequire(import.meta.url)(path.join(ROOT, "vendor/native", `${platform}_${process.arch}`, "koffi.node"));
  assert.equal(koffi.load(null).func("int mkfifo(const char *path, unsigned int mode)")(fifo, 0o600), 0);
  const module = pathToFileURL(path.join(ROOT, "scripts/setup_readiness.mjs")).href;
  const code = `import fs from 'node:fs'; import {vanessa_runtime_snapshot} from ${JSON.stringify(module)};
    const file=${JSON.stringify(file)},fifo=${JSON.stringify(fifo)},open=fs.openSync; let swapped=false;
    fs.openSync=function(name,...args){if(name===file&&!swapped){swapped=true;fs.renameSync(file,file+'.old');fs.renameSync(fifo,file);}return open.call(this,name,...args);};
    const result=vanessa_runtime_snapshot(${JSON.stringify(f.root)},{testing:{vanessa_config:{runtime_profile:'.ai/runtime.json'}}});
    if(swapped&&result==='unavailable') console.log('rejected'); else process.exitCode=1;`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "ignore"] });
  let output = ""; child.stdout.on("data", chunk => { output += chunk; });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 3000);
  const result = await new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  clearTimeout(timeout);
  assert.equal(result.signal, null, "the replacement FIFO must not block the refresh");
  assert.equal(result.code, 0); assert.equal(output.trim(), "rejected");
});

test("a FIFO substituted during the Vanessa manager read is rejected", { skip: !((process.platform === "linux" && process.arch === "x64") || (process.platform === "darwin" && process.arch === "arm64")), timeout: 10000 }, async t => {
  const f = fixture(t), file = path.join(f.base, "manager.json"), fifo = file + ".fifo"; fs.writeFileSync(file, "{}");
  const platform = process.platform === "linux" && !process.report.getReport().header.glibcVersionRuntime ? "musl" : process.platform;
  const koffi = createRequire(import.meta.url)(path.join(ROOT, "vendor/native", `${platform}_${process.arch}`, "koffi.node"));
  assert.equal(koffi.load(null).func("int mkfifo(const char *path, unsigned int mode)")(fifo, 0o600), 0);
  const module = pathToFileURL(path.join(ROOT, "vanessa/profile.mjs")).href;
  const code = `import fs from 'node:fs'; import {readJson} from ${JSON.stringify(module)};
    const file=${JSON.stringify(file)},fifo=${JSON.stringify(fifo)},open=fs.openSync; let swapped=false;
    fs.openSync=function(name,...args){if(name===file&&!swapped){swapped=true;fs.renameSync(file,file+'.old');fs.renameSync(fifo,file);}return open.call(this,name,...args);};
    try { readJson(file,65536); process.exitCode=1; } catch { if(swapped) console.log('rejected'); else process.exitCode=2; }`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "ignore"] });
  let output = ""; child.stdout.on("data", chunk => { output += chunk; });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 3000);
  const result = await new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  clearTimeout(timeout);
  assert.equal(result.signal, null); assert.equal(result.code, 0); assert.equal(output.trim(), "rejected");
});

test("a preparation FIFO is rejected without blocking the MCP event loop", { skip: !((process.platform === "linux" && process.arch === "x64") || (process.platform === "darwin" && process.arch === "arm64")), timeout: 10000 }, async t => {
  const f = fixture(t); environment(t, f.env); f.save(); grant_preparation(f.state, f.root, ["code-index"]);
  const file = path.join(instance_directory(f.state, f.root), "first.preparation.json"); fs.unlinkSync(file);
  const platform = process.platform === "linux" && !process.report.getReport().header.glibcVersionRuntime ? "musl" : process.platform;
  const koffi = createRequire(import.meta.url)(path.join(ROOT, "vendor/native", `${platform}_${process.arch}`, "koffi.node"));
  const mkfifo = koffi.load(null).func("int mkfifo(const char *path, unsigned int mode)");
  assert.equal(mkfifo(file, 0o600), 0);
  const module = pathToFileURL(path.join(ROOT, "scripts/components.mjs")).href;
  const code = `import {preparation_granted} from ${JSON.stringify(module)}; try { preparation_granted(${JSON.stringify(f.state)},${JSON.stringify(f.root)},'code-index'); process.exitCode=1; } catch { console.log('rejected'); }`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: f.env, stdio: ["ignore", "pipe", "ignore"] });
  let output = ""; child.stdout.on("data", chunk => { output += chunk; });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 3000);
  const result = await new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  clearTimeout(timeout);
  assert.equal(result.signal, null, "the FIFO must not block the process");
  assert.equal(result.code, 0); assert.equal(output.trim(), "rejected");
});

test("a FIFO substituted between lstat and open cannot block preparation", { skip: !((process.platform === "linux" && process.arch === "x64") || (process.platform === "darwin" && process.arch === "arm64")), timeout: 10000 }, async t => {
  const f = fixture(t); environment(t, f.env); f.save(); grant_preparation(f.state, f.root, ["code-index"]);
  const file = path.join(instance_directory(f.state, f.root), "first.preparation.json"), fifo = file + ".fifo";
  const platform = process.platform === "linux" && !process.report.getReport().header.glibcVersionRuntime ? "musl" : process.platform;
  const koffi = createRequire(import.meta.url)(path.join(ROOT, "vendor/native", `${platform}_${process.arch}`, "koffi.node"));
  assert.equal(koffi.load(null).func("int mkfifo(const char *path, unsigned int mode)")(fifo, 0o600), 0);
  const module = pathToFileURL(path.join(ROOT, "scripts/components.mjs")).href;
  const code = `import fs from 'node:fs'; import {preparation_granted} from ${JSON.stringify(module)};
    const file=${JSON.stringify(file)},fifo=${JSON.stringify(fifo)},open=fs.openSync; let swapped=false;
    fs.openSync=function(name,...args){if(name===file&&!swapped){swapped=true;fs.renameSync(file,file+'.old');fs.renameSync(fifo,file);}return open.call(this,name,...args);};
    try { preparation_granted(${JSON.stringify(f.state)},${JSON.stringify(f.root)},'code-index'); process.exitCode=1; } catch { if(swapped) console.log('rejected'); else process.exitCode=2; }`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: f.env, stdio: ["ignore", "pipe", "ignore"] });
  let output = ""; child.stdout.on("data", chunk => { output += chunk; });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 3000);
  const result = await new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  clearTimeout(timeout);
  assert.equal(result.signal, null, "the replacement FIFO must not block the process");
  assert.equal(result.code, 0); assert.equal(output.trim(), "rejected");
});

test("hashing a replaced runtime FIFO fails without blocking", { skip: !((process.platform === "linux" && process.arch === "x64") || (process.platform === "darwin" && process.arch === "arm64")), timeout: 10000 }, async t => {
  const f = fixture(t), file = path.join(f.base, "runtime"), fifo = file + ".fifo"; fs.writeFileSync(file, "original");
  const platform = process.platform === "linux" && !process.report.getReport().header.glibcVersionRuntime ? "musl" : process.platform;
  const koffi = createRequire(import.meta.url)(path.join(ROOT, "vendor/native", `${platform}_${process.arch}`, "koffi.node"));
  assert.equal(koffi.load(null).func("int mkfifo(const char *path, unsigned int mode)")(fifo, 0o600), 0);
  const module = pathToFileURL(path.join(ROOT, "scripts/bounded_file.mjs")).href;
  const code = `import fs from 'node:fs'; import {hash_regular_file} from ${JSON.stringify(module)};
    const file=${JSON.stringify(file)},fifo=${JSON.stringify(fifo)},open=fs.openSync; let swapped=false;
    fs.openSync=function(name,...args){if(name===file&&!swapped){swapped=true;fs.renameSync(file,file+'.old');fs.renameSync(fifo,file);}return open.call(this,name,...args);};
    try { hash_regular_file(file,1024); process.exitCode=1; } catch { if(swapped) console.log('rejected'); else process.exitCode=2; }`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "ignore"] });
  let output = ""; child.stdout.on("data", chunk => { output += chunk; });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 3000);
  const result = await new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  clearTimeout(timeout);
  assert.equal(result.signal, null); assert.equal(result.code, 0); assert.equal(output.trim(), "rejected");
});

test("asynchronous runtime copying rejects a substituted FIFO", { skip: !((process.platform === "linux" && process.arch === "x64") || (process.platform === "darwin" && process.arch === "arm64")), timeout: 10000 }, async t => {
  const f = fixture(t), file = path.join(f.base, "async-runtime"), fifo = file + ".fifo", target = file + ".copy"; fs.writeFileSync(file, "original");
  const platform = process.platform === "linux" && !process.report.getReport().header.glibcVersionRuntime ? "musl" : process.platform;
  const koffi = createRequire(import.meta.url)(path.join(ROOT, "vendor/native", `${platform}_${process.arch}`, "koffi.node"));
  assert.equal(koffi.load(null).func("int mkfifo(const char *path, unsigned int mode)")(fifo, 0o600), 0);
  const module = pathToFileURL(path.join(ROOT, "scripts/bounded_file.mjs")).href;
  const code = `import fs from 'node:fs'; import {copy_and_hash_regular_file} from ${JSON.stringify(module)};
    const file=${JSON.stringify(file)},fifo=${JSON.stringify(fifo)},open=fs.promises.open; let swapped=false;
    fs.promises.open=async function(name,...args){if(name===file&&!swapped){swapped=true;fs.renameSync(file,file+'.old');fs.renameSync(fifo,file);}return open.call(this,name,...args);};
    try { await copy_and_hash_regular_file(file,${JSON.stringify(target)},1024); process.exitCode=1; } catch { if(swapped) console.log('rejected'); else process.exitCode=2; }`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "ignore"] });
  let output = ""; child.stdout.on("data", chunk => { output += chunk; });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 3000);
  const result = await new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  clearTimeout(timeout);
  assert.equal(result.signal, null); assert.equal(result.code, 0); assert.equal(output.trim(), "rejected");
  assert.equal(fs.existsSync(target), false);
});
