import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const proxy = fileURLToPath(new URL("../mcp/bsl-ls-proxy.mjs", import.meta.url));
const preload = new URL("./fixtures/bsl-spawn.mjs", import.meta.url).href;

async function session(t, extra = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "bsl-прокси-"));
  const root = path.join(base, "проект #1");
  const a = path.join(root, "Конфигурация А");
  const b = path.join(root, "Конфигурация Б");
  fs.mkdirSync(a, { recursive: true }); fs.mkdirSync(b);
  const file = path.join(a, "Модуль.bsl"); fs.writeFileSync(file, "Процедура Тест()\nКонецПроцедуры");
  const jar = path.join(base, "fixture.jar"); fs.writeFileSync(jar, "fixture");
  const configuration = path.join(root, "bsl-language-server.json");
  if (extra.configuration) fs.writeFileSync(configuration, '{"diagnostics":{"computeTrigger":"never"}}');
  const proc = spawn(process.execPath, ["--import", preload, proxy, "--project-root", root, "--jar", jar,
    ...(extra.configuration ? ["--configuration", configuration] : [])], {
    cwd: root, env: { ...process.env, BSL_TEST_HANG: extra.hang ? "1" : "" }, windowsHide: true,
  });
  let stderr = "";
  proc.stderr.on("data", (chunk) => { stderr += chunk; });
  let counter = 0;
  const pending = new Map(), received = [];
  const closed = once(proc, "close");
  const send = (m) => proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  readline.createInterface({ input: proc.stdout }).on("line", (line) => {
    const m = JSON.parse(line);
    received.push(m);
    if (m.method && Object.hasOwn(m, "id")) send({ id: m.id, result: { acknowledged: true } });
    else {
      const callback = pending.get(`${typeof m.id}:${m.id}`);
      if (callback) { pending.delete(`${typeof m.id}:${m.id}`); callback(m); }
    }
  });
  function request(method, params = {}, id = ++counter) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout: ${method}: ${stderr}`)), 7000);
      pending.set(`${typeof id}:${id}`, (m) => { clearTimeout(timer); resolve(m); });
      send({ id, method, params });
    });
  }
  const call = (name, arguments_ = {}, id) => request("tools/call", { name, arguments: arguments_ }, id);
  t.after(async () => {
    proc.stdin.end();
    await closed;
    fs.rmSync(base, { recursive: true, force: true });
  });
  const init = await request("initialize", { capabilities: { roots: { listChanged: true } } });
  return { root, a, b, file, configuration, proc, init: init.result, call, request, send, received, closed };
}

test("multiple configurations and parallel sessions keep their own workspace sets", async (t) => {
  const first = await session(t), second = await session(t);
  assert.notEqual(first.init.pid, second.init.pid);
  await first.call("register_workspace_folder", { path: first.a });
  await first.call("register_workspace_folder", { path: pathToFileURL(first.b).href });
  await second.call("register_workspace_folder", { path: second.a });
  assert.equal((await first.call("list_workspace_folders")).result.folders.length, 2);
  assert.equal((await second.call("list_workspace_folders")).result.folders.length, 1);
  for (const folder of [first.b, first.a, first.b]) {
    const r = await first.call("type_info", { workspaceFolder: pathToFileURL(folder).href });
    assert.equal(r.result.arguments.workspaceFolder, fs.realpathSync.native(folder));
  }
  await first.call("unregister_workspace_folder", { workspaceFolder: first.a });
  assert.equal((await first.call("list_workspace_folders")).result.folders.length, 1);
  first.proc.stdin.end(); await first.closed;
  assert.equal((await second.call("list_workspace_folders")).result.folders.length, 1);
});

test("UTF-8 paths and file URIs reach BSL as canonical filesystem paths", async (t) => {
  const s = await session(t);
  for (const file of [s.file, path.relative(s.root, s.file), pathToFileURL(s.file).href]) {
    const r = await s.call("analyze_file", { file });
    assert.equal(r.result.arguments.file, fs.realpathSync.native(s.file));
  }
  assert.ok(s.init.launch.includes("-Dfile.encoding=UTF-8"));
  assert.equal(s.init.params.capabilities.roots, undefined);
  assert.deepEqual((await s.request("ask-roots")).result.reply.result.roots, []);
});

test("configuration is optional; explicit file reaches global and workspace loaders", async (t) => {
  const plain = await session(t), configured = await session(t, { configuration: true });
  assert.ok(!plain.init.launch.includes("--configuration"));
  assert.ok(!fs.existsSync(plain.configuration));
  const config = fs.realpathSync.native(configured.configuration);
  assert.ok(configured.init.launch.includes(`-Dapp.configuration.path=${config}`));
  assert.equal(configured.init.launch[configured.init.launch.indexOf("--configuration") + 1], config);
});

test("outside paths, prefix siblings, traversal, URI tricks and junctions are rejected", async (t) => {
  const s = await session(t);
  const outside = path.dirname(s.root), sibling = s.root + "-sibling";
  fs.mkdirSync(sibling); const file = path.join(sibling, "outside.bsl"); fs.writeFileSync(file, "");
  for (const arguments_ of [{ path: outside }, { path: sibling }, { path: ".." }, { path: "https://invalid.local/" }]) {
    assert.ok((await s.call("register_workspace_folder", arguments_)).error);
  }
  for (const arguments_ of [{ file }, { file: pathToFileURL(file).href }, { file: pathToFileURL(s.file).href + "?x" }, { workspaceFolder: sibling }]) {
    assert.ok((await s.call("analyze_file", arguments_)).error);
  }
  const link = path.join(s.root, "linked");
  fs.symlinkSync(sibling, link, process.platform === "win32" ? "junction" : "dir");
  assert.ok((await s.call("register_workspace_folder", { path: link })).error);
  assert.ok((await s.call("analyze_file", { file: path.join(link, "outside.bsl") })).error);
});

test("bidirectional, numeric/string and duplicate IDs cannot steal responses", async (t) => {
  const s = await session(t);
  const [number, string, server] = await Promise.all([
    s.call("hold", {}, 77), s.request("ping", {}, "77"), s.request("server-request"),
  ]);
  assert.equal(number.id, 77); assert.equal(string.id, "77");
  assert.equal(server.result.reply.result.acknowledged, true);
  const pending = s.call("hold", {}, 88);
  s.send({ id: 88, method: "ping" });
  assert.equal((await pending).id, 88);
  assert.ok(s.received.some((m) => m.id === null && m.error?.code === -32600));
});

test("registration and removal wait for analysis; queued cancellation never reaches server", async (t) => {
  const s = await session(t);
  const analysis = s.call("hold");
  const cancelled = s.call("cancel-me", {}, 90);
  const remove = s.call("unregister_workspace_folder", { workspaceFolder: s.a });
  s.send({ method: "notifications/cancelled", params: { requestId: 90 } });
  assert.equal((await cancelled).error.code, -32800);
  await analysis;
  const reply = (await remove).result;
  assert.equal(reply.overlap, false);
  assert.ok(!reply.calls.includes("cancel-me"));
});

test("unexpected child exit answers every outstanding request", async (t) => {
  const s = await session(t);
  const exit = s.call("exit"), queued = s.call("after-exit");
  assert.equal((await exit).error.code, -32000);
  assert.equal((await queued).error.code, -32000);
  assert.equal((await s.closed)[0], 7);
});

test("a directory replaced by a junction while queued is checked again at dispatch", async (t) => {
  const s = await session(t);
  const hold = s.call("hold", { delay: 450 });
  const registration = s.call("register_workspace_folder", { path: s.a });
  await s.request("ping"); // The queued request has reached the relay.
  const outside = s.root + "-outside";
  fs.mkdirSync(outside);
  fs.renameSync(s.a, s.a + "-original");
  fs.symlinkSync(outside, s.a, process.platform === "win32" ? "junction" : "dir");
  await hold;
  assert.ok((await registration).error);
  const list = (await s.call("list_workspace_folders")).result;
  assert.ok(!list.calls.includes("register_workspace_folder"));
});

test("EOF terminates even a child that ignores disconnect", async (t) => {
  const s = await session(t, { hang: true });
  s.proc.stdin.end(); await s.closed;
  assert.throws(() => process.kill(s.init.pid, 0));
});

test("malformed JSON and invalid request objects fail without poisoning the connection", async (t) => {
  const s = await session(t);
  s.proc.stdin.write("broken-json\n[]\nnull\n");
  assert.deepEqual((await s.request("ping")).result, {});
  assert.deepEqual(s.received.filter((m) => m.error).map((m) => m.error.code), [-32700, -32600, -32600]);
});
