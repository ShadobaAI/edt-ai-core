// User-owned connection records. A record is never part of project settings.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { atomic_write, operation_lock, validate_openviking_url } from "./common.mjs";
import { state_root } from "./project_paths.mjs";

export const connection_id_pattern = /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/;
const fields = ["credential", "bindingKey", "accessPublicKey", "accessReceipts", "publicationPublicKey", "publicationReceipts"];
const blank = () => Object.fromEntries(fields.map(key => [key, ""]));
function identity(url, connectionId = "") {
  if (typeof url !== "string" || !url) throw new Error("Укажите URL OpenViking.");
  validate_openviking_url(url);
  if (typeof connectionId !== "string" || !connection_id_pattern.test(connectionId)) throw new Error("Некорректный код подключения OpenViking.");
  return [url, connectionId];
}
function record_path(state, key) {
  return path.join(state, "openviking-private", createHash("sha256").update(JSON.stringify(key)).digest("hex") + ".json");
}

// On Windows Node's mode bits do not establish an ACL. Explicitly protect the
// directory with a DACL granting only the current token user, and let files
// inherit it. Fail closed when the platform cannot enforce this policy.
let win;
function windows_api() {
  if (win) return win;
  const koffi = createRequire(import.meta.url)(fileURLToPath(new URL(`../vendor/native/win32_${process.arch}/koffi.node`, import.meta.url)));
  const adv = koffi.load("advapi32.dll"), kernel = koffi.load("kernel32.dll");
  const securityAttributes = koffi.struct({ nLength: "uint32_t", lpSecurityDescriptor: "void *", bInheritHandle: "int32_t" });
  win = { koffi,
    securityAttributesSize: koffi.sizeof(securityAttributes),
    process: kernel.func("void * __stdcall GetCurrentProcess()"),
    close: kernel.func("int __stdcall CloseHandle(void *handle)"),
    free: kernel.func("void * __stdcall LocalFree(void *memory)"),
    error: kernel.func("uint32_t __stdcall GetLastError()"),
    openToken: adv.func("int __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ void **token)"),
    tokenInfo: adv.func("int __stdcall GetTokenInformation(void *token, int kind, _Out_ void *buffer, uint32_t size, _Out_ uint32_t *needed)"),
    sidText: adv.func("int __stdcall ConvertSidToStringSidW(void *sid, _Out_ void **text)"),
    equalSid: adv.func("int __stdcall EqualSid(void *left, void *right)"),
    getSecurity: adv.func("uint32_t __stdcall GetNamedSecurityInfoW(str16 file, int type, uint32_t info, _Out_ void **owner, void *group, void *dacl, void *sacl, _Out_ void **descriptor)"),
    descriptor: adv.func("int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(str16 text, uint32_t revision, _Out_ void **descriptor, void *size)"),
    setSecurity: adv.func("int __stdcall SetFileSecurityW(str16 file, uint32_t info, void *descriptor)"),
    createDirectory: kernel.func("__stdcall", "CreateDirectoryW", "int", ["str16", koffi.pointer(securityAttributes)]),
    createFile: kernel.func("__stdcall", "CreateFileW", "void *", ["str16", "uint32_t", "uint32_t", koffi.pointer(securityAttributes), "uint32_t", "uint32_t", "void *"]),
  };
  return win;
}
function with_windows_identity(isDirectory, action) {
  const api = windows_api(), token = [null], str = [null], descriptor = [null];
  if (!api.openToken(api.process(), 0x0008, token)) throw new Error("Не удалось определить пользователя для защиты OpenViking.");
  try {
    const needed = [0], data = Buffer.alloc(4096);
    if (!api.tokenInfo(token[0], 1, data, data.length, needed)) throw new Error("Не удалось получить идентификатор пользователя.");
    const sid = api.koffi.decode(data, "void *");
    if (!api.sidText(sid, str)) throw new Error("Не удалось получить идентификатор пользователя.");
    const user = api.koffi.decode(str[0], "char16_t", -1);
    if (!/^S-1-[0-9-]+$/.test(user) || !api.descriptor(`O:${user}D:P(A;${isDirectory ? "OICI" : ""};FA;;;${user})`, 1, descriptor, null))
      throw new Error("Не удалось подготовить ACL OpenViking (" + api.error() + ").");
    const result = action(api, sid, descriptor[0]);
    // The SID pointer refers into this buffer; retain it across all native calls.
    if (!data.length) throw new Error("Не удалось получить идентификатор пользователя.");
    return result;
  } finally {
    if (descriptor[0]) api.free(descriptor[0]);
    if (str[0]) api.free(str[0]);
    api.close(token[0]);
  }
}
function restrict_windows(file, isDirectory = true) {
  return with_windows_identity(isDirectory, (api, sid, descriptor) => {
    const owner = [null], currentDescriptor = [null];
    try {
      const status = api.getSecurity(file, 1, 1, owner, null, null, null, currentDescriptor);
      if (status) throw new Error("Не удалось проверить владельца OpenViking (" + status + ").");
      if (!owner[0] || !api.equalSid(sid, owner[0])) throw new Error("Файл или каталог OpenViking принадлежит другому пользователю.");
      if (!api.setSecurity(file, 0x80000004, descriptor))
        throw new Error("Не удалось ограничить доступ к каталогу OpenViking (" + api.error() + ").");
    } finally { if (currentDescriptor[0]) api.free(currentDescriptor[0]); }
  });
}
function create_private_directory_windows(directory) {
  return with_windows_identity(true, (api, _sid, descriptor) => {
    const attributes = { nLength: api.securityAttributesSize, lpSecurityDescriptor: descriptor, bInheritHandle: 0 };
    if (!api.createDirectory(directory, attributes)) {
      const error = api.error();
      if (error !== 183) throw new Error("Не удалось создать защищённый каталог OpenViking (" + error + ").");
    }
  });
}
function private_atomic_write_windows(file, contents) {
  const temporary = path.join(path.dirname(file), `.core-${randomUUID()}.tmp`);
  let created = false;
  try {
    with_windows_identity(false, (api, _sid, descriptor) => {
      const attributes = { nLength: api.securityAttributesSize, lpSecurityDescriptor: descriptor, bInheritHandle: 0 };
      const handle = api.createFile(temporary, 0x40000000, 0, attributes, 1, 0x80, null);
      if (!handle || BigInt.asIntN(64, api.koffi.address(handle)) === -1n)
        throw new Error("Не удалось создать защищённый файл OpenViking (" + api.error() + ").");
      created = true;
      if (!api.close(handle)) throw new Error("Не удалось закрыть файл OpenViking (" + api.error() + ").");
    });
    // Fail closed before putting any values on disk if the filesystem did not
    // honour the requested owner or cannot enforce the protected DACL.
    restrict_windows(temporary, false);
    fs.writeFileSync(temporary, contents, { flag: "r+" });
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(temporary, file); break; }
      catch (error) {
        if (!["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt === 5) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * 2 ** attempt);
      }
    }
  } finally { if (created) fs.rmSync(temporary, { force: true }); }
}
function secure_directory(state) {
  const directory = path.join(state, "openviking-private");
  if (process.platform === "win32") { fs.mkdirSync(state, { recursive: true }); create_private_directory_windows(directory); }
  else fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Недопустимый каталог настроек OpenViking.");
  if (process.platform === "win32") restrict_windows(directory);
  else {
    if (typeof process.getuid !== "function" || stat.uid !== process.getuid()) throw new Error("Каталог OpenViking принадлежит другому пользователю.");
    fs.chmodSync(directory, 0o700);
  }
  return directory;
}
function read(state, key) {
  const file = record_path(state, key);
  let text;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error("Недопустимый файл настроек OpenViking.");
    if (process.platform === "win32") restrict_windows(file, false);
    else {
      if (stat.uid !== process.getuid()) throw new Error("Файл OpenViking принадлежит другому пользователю.");
      fs.chmodSync(file, 0o600);
    }
    text = fs.readFileSync(file, "utf8");
  } catch (error) { if (error.code === "ENOENT") return { revision: "missing", values: blank() }; throw error; }
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("Некорректный файл настроек OpenViking."); }
  if (data.version !== 1 || JSON.stringify(data.identity) !== JSON.stringify(key) || typeof data.revision !== "string" ||
      !data.values || Object.keys(data.values).sort().join() !== [...fields].sort().join() ||
      fields.some(name => typeof data.values[name] !== "string")) throw new Error("Некорректный файл настроек OpenViking.");
  return { revision: data.revision, values: data.values };
}
export function read_openviking_record(url, connectionId = "", state = state_root()) {
  const key = identity(url, connectionId), directory = path.join(state, "openviking-private");
  if (!fs.existsSync(directory)) return { revision: "missing", values: blank() };
  secure_directory(state);
  return read(state, key);
}
export async function save_openviking_record(url, connectionId, values, expectedRevision, state = state_root()) {
  const key = identity(url, connectionId), directory = secure_directory(state);
  if (!values || Object.keys(values).sort().join() !== [...fields].sort().join() ||
      fields.some(name => typeof values[name] !== "string" || Buffer.byteLength(values[name]) > 262144)) throw new Error("Некорректные данные OpenViking.");
  if (typeof expectedRevision !== "string") throw new Error("Откройте запись заново перед сохранением.");
  return operation_lock(directory, () => {
    if (read(state, key).revision !== expectedRevision) throw new Error("Запись OpenViking изменена в другом окне. Откройте её заново.");
    const revision = randomUUID(), contents = JSON.stringify({ version: 1, identity: key, revision, values }) + "\n";
    if (Buffer.byteLength(contents) > 2 * 1024 * 1024) throw new Error("Запись OpenViking слишком велика.");
    if (process.platform === "win32") private_atomic_write_windows(record_path(state, key), contents);
    else atomic_write(record_path(state, key), contents);
    return { revision };
  }, 5);
}
