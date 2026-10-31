// Native Windows file and folder UI through the already bundled Koffi addon. A worker
// owns the COM apartment so a modal dialog never blocks the MCP event loop.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { windows_process_identity } from "./windows_process.mjs";

let modalActive = false;
export function folder_action(action, directory = "", options = {}) {
  if (process.platform !== "win32") return Promise.reject(new Error("Системный диалог доступен только в Windows в этой версии плагина."));
  if (!["pick", "open", "save", "file"].includes(action)) return Promise.reject(new Error("Неизвестное действие с папкой."));
  if (action !== "open" && modalActive) return Promise.reject(new Error("Завершите текущий системный диалог."));
  // Reject invalid input before starting a native worker. Keep the worker-side
  // check as well in case the directory changes between validation and use.
  if (action === "open") {
    try {
      if (!directory || !path.isAbsolute(directory) || !fs.statSync(directory).isDirectory()) throw new Error("Папка проекта не найдена.");
    } catch (error) { return Promise.reject(error); }
  }
  if (action !== "open") modalActive = true;
  return new Promise((resolve, reject) => {
    let replied = false;
    const worker = new Worker(new URL(import.meta.url), { workerData: { settingsFolder: true, action, directory, options } });
    worker.once("message", message => { replied = true; message.error ? reject(new Error(message.error)) : resolve(message.directory); });
    worker.once("error", reject);
    worker.once("exit", () => { if (!replied) reject(new Error("Не удалось открыть окно выбора папки.")); });
    // Closing the MCP session must not leave it alive just for a modal window.
    worker.unref();
  }).finally(() => { if (action !== "open") modalActive = false; });
}

export function windows_folder_api() {
  const koffi = createRequire(import.meta.url)(fileURLToPath(new URL(`../vendor/native/win32_${process.arch}/koffi.node`, import.meta.url)));
  const ole = koffi.load("ole32.dll"), shell = koffi.load("shell32.dll"), user = koffi.load("user32.dll");
  const init = ole.func("int32_t __stdcall CoInitializeEx(void *reserved, uint32_t flags)"),
    uninit = ole.func("void __stdcall CoUninitialize()"),
    free = ole.func("void __stdcall CoTaskMemFree(void *memory)"),
    create = ole.func("int32_t __stdcall CoCreateInstance(const void *clsid, void *outer, uint32_t context, const void *iid, _Out_ void **object)"),
    itemFromPath = shell.func("int32_t __stdcall SHCreateItemFromParsingName(str16 path, void *context, const void *iid, _Out_ void **item)"),
    open = shell.func("intptr_t __stdcall ShellExecuteW(void *owner, str16 operation, str16 file, str16 parameters, str16 directory, int show)"),
    foreground = user.func("void * __stdcall GetForegroundWindow()"),
    windowPid = user.func("uint32_t __stdcall GetWindowThreadProcessId(void *window, _Out_ uint32_t *pid)");
  const guid = text => {
    const hex = text.replaceAll("-", ""), data = Buffer.from(hex, "hex");
    data.writeUInt32LE(parseInt(hex.slice(0, 8), 16), 0);
    data.writeUInt16LE(parseInt(hex.slice(8, 12), 16), 4);
    data.writeUInt16LE(parseInt(hex.slice(12, 16), 16), 6);
    return data;
  };
  const clsid = guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7"),
    iid = guid("D57C7288-D4AD-4768-BE02-9D969532D960"),
    saveClsid = guid("C0B4E2F3-BA21-4773-8DBA-335EC946EB8B"),
    saveIid = guid("84BCCD23-5FDE-4CDB-AEA4-AF64B83D78AB"),
    shellIID = guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");
  const signatures = new Map();
  function method(object, slot, result, types, ...args) {
    const key = JSON.stringify([result, types]);
    if (!signatures.has(key)) signatures.set(key, koffi.proto("__stdcall", null, result, ["void *", ...types]));
    const table = koffi.decode(object, "void *"), pointer = koffi.decode(table, slot * koffi.sizeof("void *"), "void *");
    return koffi.call(pointer, signatures.get(key), object, ...args);
  }
  const checked = code => { if (code < 0) throw new Error(`Ошибка диалога Windows (0x${(code >>> 0).toString(16)}).`); };
  const release = object => { if (object) method(object, 2, "uint32_t", []); };
  function shellItem(directory) {
    const item = [null]; checked(itemFromPath(directory, null, shellIID, item)); return item[0];
  }
  return {
    open(directory) {
      checked(init(null, 2));
      try { if (BigInt(open(null, "explore", directory, null, null, 1)) <= 32n) throw new Error("Не удалось открыть папку в Проводнике."); }
      finally { uninit(); }
    },
    createDialog(directory = "", options = {}) {
      checked(init(null, 2)); // COINIT_APARTMENTTHREADED on this worker only
      const dialog = [null];
      try {
        checked(create(options.save ? saveClsid : clsid, null, 1, options.save ? saveIid : iid, dialog));
        // IFileDialog vtable follows IUnknown and IModalWindow.
        const flags = 0x40 | 0x800 | 0x8 | 0x2000000 | (options.save ? 0x2 : options.file ? 0x1000 : 0x20);
        checked(method(dialog[0], 9, "int32_t", ["uint32_t"], flags));
        checked(method(dialog[0], 17, "int32_t", ["str16"], options.title || (options.save ? "Сохранить файл · 1C AI Core" : "Выберите папку проекта · 1C AI Core")));
        if (options.save && options.filename) checked(method(dialog[0], 15, "int32_t", ["str16"], options.filename));
        if (options.save) checked(method(dialog[0], 22, "int32_t", ["str16"], "json"));
        if (directory && fs.existsSync(directory) && fs.statSync(directory).isDirectory()) {
          const item = shellItem(path.resolve(directory));
          try { checked(method(dialog[0], 12, "int32_t", ["void *"], item)); }
          finally { release(item); }
        }
      } catch (error) { release(dialog[0]); uninit(); throw error; }
      return {
        show() {
          // The MCP worker has no window of its own. Give the modal picker the
          // active host window as its owner so Windows can activate it.
          const owner = foreground();
          if (!owner) throw new Error("Не найдено активное окно для системного диалога. Откройте настройки в Codex и повторите.");
          const pid = [0]; windowPid(owner, pid);
          let host;
          try { host = windows_process_identity(pid[0]); } catch { throw new Error("Не удалось определить активное окно Codex для системного диалога."); }
          if (!host || !/^(?:codex|chatgpt)\.exe$/i.test(path.basename(host.executable)))
            throw new Error("Окно Codex не на переднем плане. Вернитесь к настройкам и повторите выбор.");
          const code = method(dialog[0], 3, "int32_t", ["void *"], owner);
          if ((code >>> 0) === 0x800704c7) return null; // user cancelled
          checked(code);
          const item = [null], name = [null];
          checked(method(dialog[0], 20, "int32_t", ["_Out_ void **"], item));
          try {
            checked(method(item[0], 5, "int32_t", ["uint32_t", "_Out_ void **"], 0x80058000, name)); // SIGDN_FILESYSPATH
            return koffi.decode(name[0], "char16_t", -1);
          } finally { if (name[0]) free(name[0]); release(item[0]); }
        },
        dispose() { release(dialog[0]); uninit(); },
      };
    },
  };
}

if (!isMainThread && workerData?.settingsFolder) {
  try {
    const { action, directory, options = {} } = workerData, api = windows_folder_api();
    if (action === "open") {
      if (!directory || !path.isAbsolute(directory) || !fs.statSync(directory).isDirectory()) throw new Error("Папка проекта не найдена.");
      api.open(directory); parentPort.postMessage({ directory });
    } else {
      const dialog = api.createDialog(directory, { ...options, save: action === "save", file: action === "file" });
      try { parentPort.postMessage({ directory: dialog.show() }); }
      finally { dialog.dispose(); }
    }
  } catch (error) { parentPort.postMessage({ error: error.message }); }
}
