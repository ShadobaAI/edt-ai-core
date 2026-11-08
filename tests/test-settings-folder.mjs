import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { fixture } from "./helpers.mjs";
import { folder_action, windows_folder_api, activate_folder_window, folder_error_details, folder_error_from_details } from "../scripts/settings_folder.mjs";

test("native worker errors retain their codes and stack across the worker boundary", () => {
  const original = Object.assign(new Error("Save As failed"), { code: "EACCES", errno: -1, hresult: -2147024891 });
  const restored = folder_error_from_details(folder_error_details(original));
  assert.equal(restored.message, original.message); assert.equal(restored.code, "EACCES");
  assert.equal(restored.errno, -1); assert.equal(restored.hresult, -2147024891); assert.equal(restored.stack, original.stack);
  assert.equal(folder_error_from_details("legacy error").message, "legacy error");
});

test("Explorer activation waits for the exact folder window and restores it before focusing", async () => {
  const calls=[];let found=0,current=0;
  await activate_folder_window({find:()=>++found===1?0:42,minimized:window=>window===42,restore:window=>calls.push(["restore",window]),activate:window=>{calls.push(["activate",window]);},foreground:()=>current},
    {attempts:3,pause:async()=>{if(found>1)current=42;}});
  assert.deepEqual(calls,[["restore",42],["activate",42]]);
});

test("Explorer activation reports denied focus and never activates an unrelated window", async () => {
  const calls=[];
  await assert.rejects(activate_folder_window({find:()=>42,minimized:()=>false,restore:()=>assert.fail("must not restore"),activate:window=>calls.push(window),foreground:()=>17},
    {attempts:1,pause:async()=>{}}),/не перевела Проводник на передний план/);
  assert.deepEqual(calls,[42]);
  await assert.rejects(activate_folder_window({find:()=>0,activate:()=>assert.fail("must not activate")},{attempts:2,pause:async()=>{}}),/не удалось найти/);
});

test("native Explorer lookup handles an unopened Unicode folder without creating a window", {skip:process.platform!=="win32"}, t => {
  const f=fixture(t);assert.equal(windows_folder_api().findFolderWindow(f.root),0n);
});

test("native folder dialog initializes for Unicode paths without displaying a window", { skip: process.platform !== "win32" }, t => {
  const f = fixture(t);
  const api = windows_folder_api(), dialog = api.createDialog(f.root);
  dialog.dispose();
});

test("native Save As dialog initializes with a suggested Unicode filename", { skip: process.platform !== "win32" }, t => {
  const f = fixture(t);
  const api = windows_folder_api(), dialog = api.createDialog(f.root, { save: true, filename: "настройки.json" });
  dialog.dispose();
});

test("native Open dialog initializes for an existing project directory", { skip: process.platform !== "win32" }, t => {
  const f = fixture(t);
  const api = windows_folder_api(), dialog = api.createDialog(f.root, { file: true, title: "Выберите файл настроек · 1C AI Core" });
  dialog.dispose();
});

test("opening a folder rejects files and missing directories before launching Explorer", { skip: process.platform !== "win32" }, async t => {
  const f = fixture(t);
  await assert.rejects(folder_action("open", fileURLToPath(import.meta.url)), /папк|directory|ENOENT/i);
  await assert.rejects(folder_action("open", path.join(f.root, "missing")), /папк|directory|ENOENT/i);
  const file=path.join(f.base,"outside.json");fs.writeFileSync(file,"{}");
  await assert.rejects(folder_action("open",f.root,{select:file}),/Файл должен находиться/);
});

// Opt in from an interactive Windows desktop; ordinary CI never opens UI.
test("folder picker receives foreground focus from its owner and cancels cleanly", {
  skip: process.platform !== "win32" || process.env.EDT_AI_TEST_FOLDER_DIALOG !== "1",
  timeout: 15000,
}, async t => {
  const f = fixture(t);
  const koffi = createRequire(import.meta.url)(fileURLToPath(new URL(`../vendor/native/win32_${process.arch}/koffi.node`, import.meta.url)));
  const user = koffi.load("user32.dll");
  const foreground = user.func("void * __stdcall GetForegroundWindow()"),
    find = user.func("void * __stdcall FindWindowExW(void *parent, void *after, str16 className, str16 title)"),
    windowPid = user.func("uint32_t __stdcall GetWindowThreadProcessId(void *window, _Out_ uint32_t *pid)"),
    owner = user.func("void * __stdcall GetWindow(void *window, uint32_t command)"),
    visible = user.func("int __stdcall IsWindowVisible(void *window)"),
    post = user.func("int __stdcall PostMessageW(void *window, uint32_t message, uintptr_t wparam, intptr_t lparam)");
  const host = foreground();
  assert.ok(host, "Run the focus test on an interactive desktop with a foreground host window");
  const worker = new Worker(new URL("../scripts/settings_folder.mjs", import.meta.url), {
    workerData: { settingsFolder: true, action: "pick", directory: f.root },
  });
  const result = new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", code => { if (code) reject(new Error(`Folder worker exited with code ${code}`)); });
  });
  const exited = new Promise(resolve => worker.once("exit", resolve));
  const findDialog = () => {
    let window = null;
    while ((window = find(null, window, "#32770", "Выберите папку проекта · 1C AI Core"))) {
      const pid = [0]; windowPid(window, pid);
      if (pid[0] === process.pid && visible(window)) return window;
    }
    return null;
  };
  let window;
  t.after(async () => {
    window ||= findDialog();
    if (window) post(window, 0x10, 0, 0); // WM_CLOSE, only our test process's picker
    await Promise.race([exited, setTimeout(2000)]);
    await worker.terminate();
  });
  const deadline = Date.now() + 10000;
  while (!(window = findDialog()) && Date.now() < deadline) await setTimeout(50);
  assert.ok(window, "The native picker must appear");
  while (foreground() !== window && Date.now() < deadline) await setTimeout(50);
  assert.equal(owner(window, 4), host, "The foreground host must own the picker (GW_OWNER)");
  assert.equal(foreground(), window, "Keyboard input must go to the picker");
  assert.ok(post(window, 0x10, 0, 0));
  assert.deepEqual(await result, { directory: null });
  await exited;
  assert.equal(foreground(), host, "Cancelling must restore focus to the host");
});
