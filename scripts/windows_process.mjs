// Windows process identity via a bundled Node N-API addon; no shell helper.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
let api;
function windowsAPI() {
  if (process.platform !== "win32")
    throw new Error("Windows process identity requires Windows");
  if (api) return api;
  if (!["x64", "arm64"].includes(process.arch))
    throw new Error("Windows process identity supports x64 and arm64 Node.js");
  const koffi = createRequire(import.meta.url)(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../vendor/native",
      "win32_" + process.arch,
      "koffi.node",
    ),
  );
  const kernel = koffi.load("kernel32.dll");
  const startup = koffi.struct({
      cb: "uint32_t",
      lpReserved: "void *",
      lpDesktop: "void *",
      lpTitle: "void *",
      dwX: "uint32_t",
      dwY: "uint32_t",
      dwXSize: "uint32_t",
      dwYSize: "uint32_t",
      dwXCountChars: "uint32_t",
      dwYCountChars: "uint32_t",
      dwFillAttribute: "uint32_t",
      dwFlags: "uint32_t",
      wShowWindow: "uint16_t",
      cbReserved2: "uint16_t",
      lpReserved2: "void *",
      hStdInput: "void *",
      hStdOutput: "void *",
      hStdError: "void *",
    }),
    extended = koffi.struct({
      StartupInfo: startup,
      lpAttributeList: "void *",
    }),
    processInfo = koffi.struct({
      hProcess: "void *",
      hThread: "void *",
      dwProcessId: "uint32_t",
      dwThreadId: "uint32_t",
    });
  api = {
    address: koffi.address,
    startupSize: koffi.sizeof(extended),
    createFile: kernel.func(
      "void * __stdcall CreateFileW(const char16_t *name, uint32_t access, uint32_t share, void *security, uint32_t creation, uint32_t attributes, void *templateFile)",
    ),
    initAttributes: kernel.func(
      "int __stdcall InitializeProcThreadAttributeList(void *list, uint32_t count, uint32_t flags, _Inout_ size_t *size)",
    ),
    updateAttribute: kernel.func(
      "int __stdcall UpdateProcThreadAttribute(void *list, uint32_t flags, size_t attribute, void *value, size_t size, void *previous, void *returned)",
    ),
    deleteAttributes: kernel.func(
      "void __stdcall DeleteProcThreadAttributeList(void *list)",
    ),
    createProcess: kernel.func("__stdcall", "CreateProcessW", "int", [
      "str16",
      "void *",
      "void *",
      "void *",
      "int",
      "uint32_t",
      "void *",
      "str16",
      koffi.pointer(extended),
      koffi.out(koffi.pointer(processInfo)),
    ]),
    exitCode: kernel.func(
      "int __stdcall GetExitCodeProcess(void *handle, _Out_ uint32_t *code)",
    ),
    open: kernel.func(
      "void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)",
    ),
    close: kernel.func("int __stdcall CloseHandle(void *handle)"),
    error: kernel.func("uint32_t __stdcall GetLastError()"),
    image: kernel.func(
      "int __stdcall QueryFullProcessImageNameW(void *handle, uint32_t flags, _Out_ uint16_t *buffer, _Inout_ uint32_t *size)",
    ),
    times: kernel.func(
      "int __stdcall GetProcessTimes(void *handle, _Out_ uint64_t *created, _Out_ uint64_t *exited, _Out_ uint64_t *kernel, _Out_ uint64_t *user)",
    ),
    createJob: kernel.func(
      "void * __stdcall CreateJobObjectW(void *security, const uint16_t *name)",
    ),
    setJob: kernel.func(
      "int __stdcall SetInformationJobObject(void *job, int kind, const void *info, uint32_t size)",
    ),
    assignJob: kernel.func(
      "int __stdcall AssignProcessToJobObject(void *job, void *process)",
    ),
  };
  return api;
}
export function own_windows_tree(pid) {
  const win = windowsAPI(),
    job = win.createJob(null, null);
  if (!job)
    throw new Error(
      "Cannot create an owned Windows process job (" + win.error() + ")",
    );
  let handle;
  try {
    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION on x64/arm64. KILL_ON_JOB_CLOSE
    // also cleans descendants when a relay is terminated unexpectedly. Only an
    // explicit CREATE_BREAKAWAY_FROM_JOB may detach the shared project daemon.
    const limits = Buffer.alloc(144);
    limits.writeUInt32LE(0x2000 | 0x0800, 16);
    if (!win.setJob(job, 9, limits, limits.length))
      throw new Error(
        "Cannot configure Windows process job (" + win.error() + ")",
      );
    handle = win.open(0x0100 | 0x0001, 0, pid);
    if (!handle || !win.assignJob(job, handle))
      throw new Error(
        "Cannot supervise owned Windows process tree (" + win.error() + ")",
      );
  } catch (error) {
    win.close(job);
    throw error;
  } finally {
    if (handle) win.close(handle);
  }
  let closed = false;
  return {
    close() {
      if (!closed) {
        closed = true;
        win.close(job);
      }
    },
  };
}
function quote_windows_argument(value) {
  // CommandLineToArgvW/CRT quoting, including backslashes before quotes/end.
  return (
    '"' +
    String(value)
      .replace(/(\\*)"/g, '$1$1\\"')
      .replace(/(\\+)$/, "$1$1") +
    '"'
  );
}
export function spawn_detached_windows(command, args, options) {
  if (!path.isAbsolute(command))
    throw new Error("Detached Windows executable must be absolute");
  const win = windowsAPI(),
    handles = [],
    info = {};
  let attributes,
    attributesReady = false;
  const fail = (action) => new Error(`${action} (${win.error()})`);
  try {
    const security = Buffer.alloc(24);
    security.writeUInt32LE(24, 0);
    security.writeUInt32LE(1, 16);
    const open = (file, access, creation) => {
      const handle = win.createFile(
        file,
        access,
        3,
        security,
        creation,
        0x80,
        null,
      );
      if (!handle || win.address(handle) === 0xffffffffffffffffn)
        throw fail("Cannot open daemon stdio");
      handles.push(handle);
      return handle;
    };
    const input = open("NUL", 0x80000000, 3),
      output = open(options.stdoutFile, 0x0004, 4),
      error = open(options.stderrFile, 0x0004, 4),
      size = [0n];
    win.initAttributes(null, 1, 0, size);
    if (!Number(size[0]) || Number(size[0]) > 65536)
      throw fail("Cannot size daemon handle list");
    attributes = Buffer.alloc(Number(size[0]));
    if (!win.initAttributes(attributes, 1, 0, size))
      throw fail("Cannot create daemon handle list");
    attributesReady = true;
    const inherited = Buffer.alloc(24);
    handles.forEach((handle, index) =>
      inherited.writeBigUInt64LE(win.address(handle), index * 8),
    );
    // Inherit only these three stdio handles, never session pipes or Job handles.
    if (
      !win.updateAttribute(
        attributes,
        0,
        0x20002,
        inherited,
        inherited.length,
        null,
        null,
      )
    )
      throw fail("Cannot restrict daemon handle inheritance");
    const keys = Object.keys(options.env)
        .filter((key) => options.env[key] !== undefined)
        .sort(),
      seen = new Set(),
      values = [];
    for (const key of keys) {
      if (seen.has(key.toUpperCase())) continue;
      seen.add(key.toUpperCase());
      const value = String(options.env[key]);
      if (key.includes("\0") || value.includes("\0") || key.includes("="))
        throw new Error("Invalid daemon environment");
      values.push(key + "=" + value);
    }
    values.sort((a, b) =>
      a.toUpperCase() < b.toUpperCase()
        ? -1
        : a.toUpperCase() > b.toUpperCase()
          ? 1
          : 0,
    );
    const environment = Buffer.from(values.join("\0") + "\0\0", "utf16le"),
      argv = [command, ...args].map(String);
    if (argv.some((value) => value.includes("\0")))
      throw new Error("Invalid daemon argument");
    const line = Buffer.from(
      argv.map(quote_windows_argument).join(" ") + "\0",
      "utf16le",
    );
    // Explicit breakaway, hidden console, Unicode env, new process group and
    // extended startup attributes. A restrictive ancestor Job fails closed.
    if (
      !win.createProcess(
        command,
        line,
        null,
        null,
        1,
        0x09080600,
        environment,
        options.cwd,
        {
          StartupInfo: {
            cb: win.startupSize,
            dwFlags: 0x100,
            hStdInput: input,
            hStdOutput: output,
            hStdError: error,
          },
          lpAttributeList: attributes,
        },
        info,
      )
    )
      throw fail("Cannot start shared daemon outside the session job");
    win.close(info.hThread);
    let released = false;
    return {
      pid: info.dwProcessId,
      get exitCode() {
        const code = [0];
        if (released || !win.exitCode(info.hProcess, code))
          throw fail("Cannot inspect daemon process handle");
        return code[0] === 259 ? null : code[0];
      },
      signalCode: null,
      once() {
        return this;
      },
      unref() {},
      release() {
        if (!released) {
          released = true;
          win.close(info.hProcess);
        }
      },
    };
  } finally {
    if (attributesReady) win.deleteAttributes(attributes);
    for (const handle of handles) win.close(handle);
  }
}
export function windows_process_identity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff)
    throw new Error("Invalid process PID");
  const win = windowsAPI(),
    handle = win.open(0x1000, 0, pid);
  if (!handle) {
    const error = win.error();
    if (error === 87) return null;
    throw new Error(
      "Cannot verify Windows process identity (OpenProcess " + error + ")",
    );
  }
  try {
    const buffer = Buffer.alloc(32768 * 2),
      size = [32768],
      created = [0n],
      exited = [0n],
      kernel = [0n],
      user = [0n];
    if (
      !win.image(handle, 0, buffer, size) ||
      !win.times(handle, created, exited, kernel, user)
    )
      throw new Error(
        "Cannot query Windows process identity (" + win.error() + ")",
      );
    if (BigInt(exited[0]) !== 0n) return null;
    const ticks = BigInt(created[0]);
    return {
      pid,
      executable: buffer.subarray(0, size[0] * 2).toString("utf16le"),
      created: "win32-filetime:" + ticks,
      createdMs: Number((ticks - 116444736000000000n) / 10000n),
    };
  } finally {
    win.close(handle);
  }
}
export function same_creation(state, recorded) {
  if (typeof recorded !== "string") return false;
  if (recorded.startsWith("win32-filetime:")) return state.created === recorded;
  // Preserve existing CIM owner records written before the Node migration.
  const legacy = /\/?Date\((\d+)(?:[+-]\d+)?\)\/?/.exec(recorded),
    value = legacy ? Number(legacy[1]) : Date.parse(recorded);
  return Number.isFinite(value) && value === state.createdMs;
}
