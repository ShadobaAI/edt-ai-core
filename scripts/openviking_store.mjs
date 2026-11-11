// User-owned connection records and the shared private-file writer.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { atomic_write, operation_lock, validate_openviking_url } from "./common.mjs";
import { state_root } from "./project_paths.mjs";
import { unlink_at } from "./unix_process.mjs";

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

// On Windows Node's mode bits do not establish an ACL. Protect private
// directories and observation files with an explicit owner and a DACL for the
// current token user. Fail closed when the platform cannot enforce this policy.
let win;
function windows_api() {
  if (win) return win;
  const koffi = createRequire(import.meta.url)(fileURLToPath(new URL(`../vendor/native/win32_${process.arch}/koffi.node`, import.meta.url)));
  const adv = koffi.load("advapi32.dll"), kernel = koffi.load("kernel32.dll"), nt = koffi.load("ntdll.dll");
  const securityAttributes = koffi.struct({ nLength: "uint32_t", lpSecurityDescriptor: "void *", bInheritHandle: "int32_t" });
  const unicode = koffi.struct({ Length: "uint16_t", MaximumLength: "uint16_t", Buffer: "void *" });
  const objectAttributes = koffi.struct({ Length: "uint32_t", RootDirectory: "void *", ObjectName: koffi.pointer(unicode), Attributes: "uint32_t", SecurityDescriptor: "void *", SecurityQualityOfService: "void *" });
  win = { koffi,
    securityAttributesSize: koffi.sizeof(securityAttributes),
    objectAttributesSize: koffi.sizeof(objectAttributes),
    process: kernel.func("void * __stdcall GetCurrentProcess()"),
    close: kernel.func("int __stdcall CloseHandle(void *handle)"),
    free: kernel.func("void * __stdcall LocalFree(void *memory)"),
    error: kernel.func("uint32_t __stdcall GetLastError()"),
    openToken: adv.func("int __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ void **token)"),
    tokenInfo: adv.func("int __stdcall GetTokenInformation(void *token, int kind, _Out_ void *buffer, uint32_t size, _Out_ uint32_t *needed)"),
    sidText: adv.func("int __stdcall ConvertSidToStringSidW(void *sid, _Out_ void **text)"),
    equalSid: adv.func("int __stdcall EqualSid(void *left, void *right)"),
    getSecurity: adv.func("uint32_t __stdcall GetNamedSecurityInfoW(str16 file, int type, uint32_t info, _Out_ void **owner, void *group, void *dacl, void *sacl, _Out_ void **descriptor)"),
    getHandleSecurity: adv.func("uint32_t __stdcall GetSecurityInfo(void *file, int type, uint32_t info, _Out_ void **owner, void *group, _Out_ void **dacl, void *sacl, _Out_ void **descriptor)"),
    descriptorControl: adv.func("int __stdcall GetSecurityDescriptorControl(void *descriptor, _Out_ uint16_t *control, _Out_ uint32_t *revision)"),
    aclInfo: adv.func("int __stdcall GetAclInformation(void *acl, _Out_ void *information, uint32_t size, int kind)"),
    aceAt: adv.func("int __stdcall GetAce(void *acl, uint32_t index, _Out_ void **ace)"),
    descriptor: adv.func("int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(str16 text, uint32_t revision, _Out_ void **descriptor, void *size)"),
    setSecurity: adv.func("int __stdcall SetFileSecurityW(str16 file, uint32_t info, void *descriptor)"),
    createDirectory: kernel.func("__stdcall", "CreateDirectoryW", "int", ["str16", koffi.pointer(securityAttributes)]),
    createFile: kernel.func("__stdcall", "CreateFileW", "void *", ["str16", "uint32_t", "uint32_t", koffi.pointer(securityAttributes), "uint32_t", "uint32_t", "void *"]),
    setFileInformation: kernel.func("int __stdcall SetFileInformationByHandle(void *file, int kind, void *info, uint32_t size)"),
    fileInformation: kernel.func("int __stdcall GetFileInformationByHandle(void *file, _Out_ void *info)"),
    ntCreate: nt.func("__stdcall", "NtCreateFile", "int32_t", [koffi.out(koffi.pointer("void *")), "uint32_t", koffi.pointer(objectAttributes), "void *", "void *", "uint32_t", "uint32_t", "uint32_t", "uint32_t", "void *", "uint32_t"]),
  };
  return win;
}

function verify_private_handle(api, handle, sid, directory) {
  const owner = [null], acl = [null], descriptor = [null];
  let prior;
  try {
    const status = api.getHandleSecurity(handle, 1, 5, owner, null, acl, null, descriptor);
    if (status) throw new Error("Cannot inspect private directory security (" + status + ")");
    const info = Buffer.alloc(12), ace = [null], control = [0], revision = [0];
    if (!descriptor[0] || !owner[0] || !acl[0] || !api.equalSid(sid, owner[0]) || !api.descriptorControl(descriptor[0], control, revision) || (control[0] & 0x1004) !== 0x1004 ||
        !api.aclInfo(acl[0], info, info.length, 2) || info.readUInt32LE(0) !== 1 || !api.aceAt(acl[0], 0, ace) || !ace[0])
      throw new Error("Private directory ownership or ACL is not confirmed");
    const start = api.koffi.address(acl[0]), end = start + BigInt(info.readUInt32LE(4)), entry = api.koffi.address(ace[0]);
    if (end < start + 8n || entry < start + 8n || entry + 4n > end) throw new Error("Invalid private object ACL");
    const header = Buffer.from(api.koffi.decode(ace[0], "uint8_t", 4));
    const length = header.readUInt16LE(2);
    if (length < 16 || entry + BigInt(length) > end) throw new Error("Invalid private object ACL");
    const bytes = Buffer.from(api.koffi.decode(ace[0], "uint8_t", length));
    if (bytes[8] !== 1 || bytes[9] > 15 || length !== 16 + 4 * bytes[9] || bytes[0] !== 0 || bytes.readUInt32LE(4) !== 0x001f01ff ||
        bytes[1] !== (directory ? 3 : 0) || !api.equalSid(bytes.subarray(8), sid)) throw new Error("Private object ACL is not exclusive");
  } catch (error) { prior = error; throw error; }
  finally {
    if (descriptor[0] && api.free(descriptor[0]))
      throw Object.assign(new Error("Private security descriptor cleanup is not confirmed"), { outcomeUnknown: true, cleanupUnconfirmed: true, ...(prior ? { cause: prior } : {}) });
  }
}
function with_windows_identity(isDirectory, action) {
  const api = windows_api(), token = [null], str = [null], descriptor = [null];
  if (!api.openToken(api.process(), 0x0008, token)) throw new Error("Не удалось определить пользователя для защиты OpenViking.");
  let prior;
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
  } catch (error) { prior = error; throw error; }
  finally {
    let failed = false;
    if (descriptor[0] && api.free(descriptor[0])) failed = true;
    if (str[0] && api.free(str[0])) failed = true;
    if (!api.close(token[0])) failed = true;
    if (failed) throw Object.assign(new Error("Windows identity cleanup is not confirmed"), { outcomeUnknown: true, cleanupUnconfirmed: true, ...(prior ? { cause: prior } : {}) });
  }
}
function restrict_windows(file, isDirectory = true) {
  return with_windows_identity(isDirectory, (api, sid, descriptor) => {
    const owner = [null], currentDescriptor = [null];
    let prior;
    try {
      const status = api.getSecurity(file, 1, 1, owner, null, null, null, currentDescriptor);
      if (status) throw new Error("Не удалось проверить владельца OpenViking (" + status + ").");
      if (!owner[0] || !api.equalSid(sid, owner[0])) throw new Error("Файл или каталог OpenViking принадлежит другому пользователю.");
      if (!api.setSecurity(file, 0x80000004, descriptor))
        throw new Error("Не удалось ограничить доступ к каталогу OpenViking (" + api.error() + ").");
    } catch (error) { prior = error; throw error; }
    finally {
      if (currentDescriptor[0] && api.free(currentDescriptor[0]))
        throw Object.assign(new Error("Windows security descriptor cleanup is not confirmed"), { outcomeUnknown: true, cleanupUnconfirmed: true, ...(prior ? { cause: prior } : {}) });
    }
  });
}
function create_private_directory_windows(directory, exclusive = false) {
  return with_windows_identity(true, (api, _sid, descriptor) => {
    const attributes = { nLength: api.securityAttributesSize, lpSecurityDescriptor: descriptor, bInheritHandle: 0 };
    if (!api.createDirectory(directory, attributes)) {
      const error = api.error();
      if (error !== 183 || exclusive) throw new Error("Не удалось создать защищённый каталог OpenViking (" + error + ").");
    }
  });
}

// Create the directory with its protected DACL already in place. Keep a
// non-delete-sharing handle until the reader exits, so even a writable parent
// cannot rename or replace the directory while its executable is in use.
export function private_observation_directory(parent) {
  if (process.platform !== "win32") {
    if (typeof process.getuid !== "function") throw new Error("Cannot verify private observation directory ownership");
    const uid = process.getuid();
    const safeParent = candidate => {
      let current = fs.realpathSync.native(candidate), child = null; const canonical = current;
      while (true) {
        const stat = fs.statSync(current);
        const trustedSticky = (stat.mode & 0o1000) && (stat.uid === 0 || stat.uid === uid) && (!child || child.uid === uid);
        if (!stat.isDirectory() || stat.uid !== 0 && stat.uid !== uid || (stat.mode & 0o022) && !trustedSticky) return null;
        child = stat; const next = path.dirname(current); if (next === current) return canonical; current = next;
      }
    };
    const base = safeParent(parent) || safeParent("/tmp");
    if (!base) throw new Error("Observation directory has an unsafe writable ancestor");
    const directory = fs.mkdtempSync(path.join(base, ".observation-"));
    let created, fd, identity;
    try {
      created = fs.lstatSync(directory, { bigint: true });
      fs.chmodSync(directory, 0o700);
      fd = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0));
      identity = fs.fstatSync(fd, { bigint: true });
      if (!identity.isDirectory() || identity.dev !== created.dev || identity.ino !== created.ino) throw new Error("Private observation directory changed");
    } catch (error) {
      let cleanupFailure;
      try { if (fd !== undefined) fs.closeSync(fd); } catch (failure) { cleanupFailure = failure; }
      try {
        if (!created) throw new Error("Private observation directory cleanup identity is not confirmed");
        else {
          const current = fs.lstatSync(directory, { bigint: true, throwIfNoEntry: false });
          if (!current?.isDirectory() || current.isSymbolicLink() || current.dev !== created.dev || current.ino !== created.ino)
            throw new Error("Private observation directory cleanup identity is not confirmed");
          fs.rmdirSync(directory);
        }
      } catch (failure) { cleanupFailure ||= failure; }
      if (cleanupFailure) throw Object.assign(new Error("Private observation directory cleanup is not confirmed"),
        { outcomeUnknown: true, cleanupUnconfirmed: true, cause: cleanupFailure });
      throw error;
    }
    let closed = false;
    const ensure = () => {
      if (closed) throw new Error("Private observation directory is closed");
      const current = fs.lstatSync(directory, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino)
        throw new Error("Private observation directory changed");
    };
    const close = () => { if (!closed) { closed = true; fs.closeSync(fd); } };
    return { path: directory, ioPath: process.platform === "linux" ? `/proc/${process.pid}/fd/${fd}` : directory, ensure, close, unlink(name) { ensure(); unlink_at(fd, name); },
      remove() { ensure(); close(); fs.rmdirSync(directory); } };
  }
  const parentPath = fs.realpathSync.native(parent), directory = path.join(parentPath, ".observation-" + randomUUID()), api = windows_api();
  let handle, parentHandle; const ancestors = [], files = new Map();
  try {
    const root = path.parse(parentPath).root, parts = path.relative(root, parentPath).split(path.sep).filter(Boolean);
    let current = root;
    for (const part of [null, ...parts]) {
      if (part) current = path.join(current, part);
      const before = fs.lstatSync(current, { bigint: true }), pinned = api.createFile(current, 0x80, 3, null, 3, 0x02200000, null);
      if (!pinned || BigInt.asIntN(64, api.koffi.address(pinned)) === -1n) throw new Error("Cannot pin an observation ancestor (" + api.error() + ")");
      ancestors.push(pinned);
      const info = Buffer.alloc(52);
      if (!before.isDirectory() || before.isSymbolicLink() || !api.fileInformation(pinned, info) || !(info.readUInt32LE(0) & 0x10) || (info.readUInt32LE(0) & 0x400) ||
          before.dev !== BigInt(info.readUInt32LE(28)) || before.ino !== ((BigInt(info.readUInt32LE(44)) << 32n) | BigInt(info.readUInt32LE(48))))
        throw new Error("Observation ancestor identity is not confirmed");
    }
    parentHandle = ancestors.at(-1);
    with_windows_identity(true, (_api, sid, descriptor) => {
      const wide = Buffer.from(path.basename(directory) + "\0", "utf16le"), name = { Length: wide.length - 2, MaximumLength: wide.length, Buffer: wide };
      const attributes = { Length: api.objectAttributesSize, RootDirectory: parentHandle, ObjectName: name, Attributes: 0x40, SecurityDescriptor: descriptor, SecurityQualityOfService: null };
      const output = [null], io = Buffer.alloc(16);
      // FILE_CREATE + FILE_DIRECTORY_FILE returns a pinned handle atomically;
      // no other user can replace the new entry between creation and pinning.
      const status = api.ntCreate(output, 0x001f01ff, attributes, io, null, 0, 3, 2, 0x21, null, 0);
      if (status !== 0 || !output[0]) throw new Error("Cannot create the private observation directory (NTSTATUS " + status + ")");
      handle = output[0]; verify_private_handle(api, handle, sid, true);
    });
    const info = Buffer.alloc(52);
    if (!api.fileInformation(handle, info) || !(info.readUInt32LE(0) & 0x10) || (info.readUInt32LE(0) & 0x400)) throw new Error("Private observation directory type is not confirmed");
    const identity = { dev: BigInt(info.readUInt32LE(28)), ino: (BigInt(info.readUInt32LE(44)) << 32n) | BigInt(info.readUInt32LE(48)) }; let closed = false;
    const ensure = () => {
      if (closed) throw new Error("Private observation directory is closed");
      const current = fs.lstatSync(directory, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino)
        throw new Error("Private observation directory changed");
    };
    const createFile = name => {
      if (!/^(?:reader\.exe|daemon\.json|daemon\.toml)$/.test(name) || files.has(name)) throw new Error("Invalid private observation file");
      ensure();
      return with_windows_identity(false, (_api, sid, descriptor) => {
        const attributes = { nLength: api.securityAttributesSize, lpSecurityDescriptor: descriptor, bInheritHandle: 0 };
        // Do not share deletion: the exact file stays pinned through reader shutdown.
        const file = api.createFile(path.join(directory, name), 0x00130080, 3, attributes, 1, 0x80, null);
        if (!file || BigInt.asIntN(64, api.koffi.address(file)) === -1n) throw new Error("Cannot create a private observation file (" + api.error() + ")");
        files.set(name, file);
        const data = Buffer.alloc(52);
        if (!api.fileInformation(file, data) || (data.readUInt32LE(0) & (0x10 | 0x400))) throw new Error("Private observation file type is not confirmed");
        verify_private_handle(api, file, sid, false);
        return { dev: String(data.readUInt32LE(28)), ino: String((BigInt(data.readUInt32LE(44)) << 32n) | BigInt(data.readUInt32LE(48))) };
      });
    };
    const writeFile = (name, contents) => {
      const expected = createFile(name), fd = fs.openSync(path.join(directory, name), "r+");
      try {
        const stat = fs.fstatSync(fd, { bigint: true });
        if (!stat.isFile() || String(stat.dev) !== expected.dev || String(stat.ino) !== expected.ino || stat.size !== 0n)
          throw new Error("Private observation file changed before writing");
        fs.writeFileSync(fd, contents);
      } finally { fs.closeSync(fd); }
    };
    const close = () => {
      if (closed) return; closed = true;
      let failure = 0;
      for (const file of files.values()) if (!api.close(file)) failure ||= api.error() || 1;
      files.clear();
      if (!api.close(handle)) failure ||= api.error() || 1;
      for (const ancestor of ancestors.reverse()) if (!api.close(ancestor)) failure ||= api.error() || 1;
      if (failure) throw new Error("Cannot close the private directory handles (" + failure + ")");
    };
    return { path: directory, ioPath: directory, ensure, close, createFile, writeFile, unlink(name) {
      ensure();
      const file = files.get(name);
      if (!file) { fs.rmSync(path.join(directory, name), { force: true }); return; }
      const disposition = Buffer.alloc(4); disposition.writeUInt32LE(1);
      if (!api.setFileInformation(file, 4, disposition, disposition.length)) {
        const error = api.error(), code = error === 5 ? "EACCES" : [32, 33].includes(error) ? "EBUSY" : undefined;
        throw Object.assign(new Error("Cannot remove a private observation file (" + error + ")"), code ? { code } : {});
      }
      files.delete(name);
      // An unsuccessful close is ambiguous; never retry a possibly reused handle.
      if (!api.close(file)) throw Object.assign(new Error("Cannot close a private observation file (" + api.error() + ")"), { outcomeUnknown: true, cleanupUnconfirmed: true });
    }, remove() {
      ensure();
      const disposition = Buffer.alloc(4); disposition.writeUInt32LE(1);
      const ok = api.setFileInformation(handle, 4, disposition, disposition.length), error = ok ? 0 : api.error();
      if (!ok) throw new Error("Cannot remove the private observation directory (" + error + ")");
      close();
    } };
  } catch (error) {
    let cleanupFailure = 0;
    if (handle && BigInt.asIntN(64, api.koffi.address(handle)) !== -1n) {
      const disposition = Buffer.alloc(4); disposition.writeUInt32LE(1);
      if (!api.setFileInformation(handle, 4, disposition, disposition.length)) cleanupFailure ||= api.error() || 1;
      if (!api.close(handle)) cleanupFailure ||= api.error() || 1;
    }
    for (const ancestor of ancestors.reverse()) if (!api.close(ancestor)) cleanupFailure ||= api.error() || 1;
    if (cleanupFailure) throw Object.assign(new Error("Private observation directory cleanup is not confirmed"),
      { outcomeUnknown: true, cleanupUnconfirmed: true });
    throw error;
  }
}
function private_atomic_write_windows(file, contents, overwrite) {
  // A protected file DACL alone does not prevent DELETE_CHILD through a writable
  // parent. Keep the staging directory and all its ancestors pinned until the
  // private file has been published and the staging entry has been removed.
  const directory = private_observation_directory(path.dirname(file));
  const temporary = path.join(directory.ioPath, `.core-${randomUUID()}.tmp`);
  const destination = path.join(path.dirname(directory.path), path.basename(file));
  let created = false;
  try {
    with_windows_identity(false, (api, sid, descriptor) => {
      const attributes = { nLength: api.securityAttributesSize, lpSecurityDescriptor: descriptor, bInheritHandle: 0 };
      const handle = api.createFile(temporary, 0x40020000, 0, attributes, 1, 0x80, null);
      if (!handle || BigInt.asIntN(64, api.koffi.address(handle)) === -1n)
        throw new Error("Не удалось создать защищённый файл (" + api.error() + ").");
      created = true;
      try { verify_private_handle(api, handle, sid, false); }
      finally { if (!api.close(handle)) throw new Error("Не удалось закрыть защищённый файл (" + api.error() + ")."); }
    });
    // Fail closed before putting any values on disk if the filesystem did not
    // honour the requested owner or cannot enforce the protected DACL.
    restrict_windows(temporary, false);
    directory.ensure();
    fs.writeFileSync(temporary, contents, { flag: "r+" });
    directory.ensure();
    if (!overwrite) fs.linkSync(temporary, destination);
    else {
      for (let attempt = 0; ; attempt++) {
        try { fs.renameSync(temporary, destination); break; }
        catch (error) {
          if (!["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt === 5) throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * 2 ** attempt);
        }
      }
    }
  } finally {
    let failure;
    try { if (created) fs.rmSync(temporary, { force: true }); } catch (error) { failure = error; }
    try { directory.remove(); } catch (error) { failure ||= error; }
    try { directory.close(); } catch (error) { failure ||= error; }
    if (failure) throw Object.assign(new Error("Private file staging cleanup is not confirmed"),
      { outcomeUnknown: true, cleanupUnconfirmed: true, cause: failure });
  }
}
export function private_atomic_write(file, contents, overwrite = true) {
  if (process.platform !== "win32") return atomic_write(file, contents, overwrite);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return private_atomic_write_windows(file, contents, overwrite);
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
    private_atomic_write(record_path(state, key), contents);
    return { revision };
  }, 5);
}
