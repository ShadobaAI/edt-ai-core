// Windows process identity via a bundled Node N-API addon; no shell helper.
import { createRequire } from "node:module";
import fs from "node:fs";
import net from "node:net";
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
  const iphelper = koffi.load("iphlpapi.dll");
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
    fileInformation: kernel.func(
      "int __stdcall GetFileInformationByHandle(void *handle, _Out_ void *information)",
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
    waitSingle: kernel.func("uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t milliseconds)"),
    handleCount: kernel.func(
      "int __stdcall GetProcessHandleCount(void *handle, _Out_ uint32_t *count)",
    ),
    open: kernel.func(
      "void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)",
    ),
    close: kernel.func("int __stdcall CloseHandle(void *handle)"),
    error: kernel.func("uint32_t __stdcall GetLastError()"),
    setError: kernel.func("void __stdcall SetLastError(uint32_t code)"),
    image: kernel.func(
      "int __stdcall QueryFullProcessImageNameW(void *handle, uint32_t flags, _Out_ uint16_t *buffer, _Inout_ uint32_t *size)",
    ),
    times: kernel.func(
      "int __stdcall GetProcessTimes(void *handle, _Out_ uint64_t *created, _Out_ uint64_t *exited, _Out_ uint64_t *kernel, _Out_ uint64_t *user)",
    ),
    tcpTable: iphelper.func(
      "uint32_t __stdcall GetExtendedTcpTable(void *table, _Inout_ uint32_t *size, int order, uint32_t family, uint32_t tableClass, uint32_t reserved)",
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
    openJob: kernel.func(
      "void * __stdcall OpenJobObjectW(uint32_t access, int inherit, const uint16_t *name)",
    ),
    processSession: kernel.func(
      "int __stdcall ProcessIdToSessionId(uint32_t pid, _Out_ uint32_t *session)",
    ),
    queryJob: kernel.func(
      "int __stdcall QueryInformationJobObject(void *job, int kind, _Out_ void *info, uint32_t size, void *returned)",
    ),
    terminateJob: kernel.func(
      "int __stdcall TerminateJobObject(void *job, uint32_t exitCode)",
    ),
  };
  return api;
}

function reader_job_name(id) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id || ""))
    throw new Error("Invalid reader job identifier");
  return "Local\\1c-ai-core-index-reader-" + id;
}
const wide = value => Buffer.from(value + "\0", "utf16le");

// Pin the canonical path as well as the file. Omitting FILE_SHARE_WRITE and
// FILE_SHARE_DELETE on the file prevents both in-place changes and replacement
// (including through another hard link) until the returned handle is closed.
// Directory handles allow ordinary file operations but prevent an ancestor
// from being renamed or replaced. A pre-existing conflicting writer makes the
// acquisition fail; it must never be treated as an immutable snapshot.
export function pin_windows_readonly_file(file) {
  if (!path.isAbsolute(file)) throw new Error("A pinned file path must be absolute");
  const win = windowsAPI(), canonical = fs.realpathSync.native(file), root = path.parse(canonical).root;
  const parts = path.relative(root, canonical).split(path.sep).filter(Boolean);
  if (!parts.length) throw new Error("A pinned file must be a regular file");
  const handles = [];
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    let failure;
    for (const handle of handles.reverse()) if (!win.close(handle)) failure ||= win.error() || 1;
    if (failure) throw Object.assign(new Error("Cannot release pinned file handles (" + failure + ")"), { outcomeUnknown: true, cleanupUnconfirmed: true });
  };
  try {
    let current = root;
    for (let index = -1; index < parts.length; index++) {
      if (index >= 0) current = path.join(current, parts[index]);
      const directory = index < parts.length - 1;
      const before = fs.lstatSync(current, { bigint: true });
      // Open the reparse point itself, not its target. Each already-pinned
      // ancestor remains in place while the next component is opened.
      const handle = win.createFile(current, directory ? 0x80 : 0x80000000,
        directory ? 3 : 1, null, 3, directory ? 0x02200000 : 0x00200080, null);
      if (!handle || BigInt.asIntN(64, win.address(handle)) === -1n)
        throw new Error("Cannot pin file path (" + win.error() + "): " + current);
      handles.push(handle);
      const info = Buffer.alloc(52);
      if (!win.fileInformation(handle, info)) throw new Error("Cannot inspect pinned file (" + win.error() + ")");
      const attributes = info.readUInt32LE(0), volume = BigInt(info.readUInt32LE(28));
      const identity = (BigInt(info.readUInt32LE(44)) << 32n) | BigInt(info.readUInt32LE(48));
      const after = fs.lstatSync(current, { bigint: true });
      if (attributes & 0x400 || Boolean(attributes & 0x10) !== directory ||
          before.isSymbolicLink() || after.isSymbolicLink() ||
          (directory ? !before.isDirectory() || !after.isDirectory() : !before.isFile() || !after.isFile()) ||
          before.dev !== volume || before.ino !== identity || after.dev !== volume || after.ino !== identity)
        throw new Error("Pinned file path identity is not confirmed: " + current);
    }
    return { path: canonical, close };
  } catch (error) {
    try { close(); } catch (cleanup) { error.outcomeUnknown = true; error.cleanupUnconfirmed = true; error.cause = cleanup; }
    throw error;
  }
}

export function windows_process_session(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff) throw new Error("Invalid process PID");
  const win = windowsAPI(), session = [0];
  if (!win.processSession(pid, session)) throw new Error("Cannot determine Windows process session (" + win.error() + ")");
  return session[0];
}

// Job names are local to a Windows session. Callers must first establish that
// they are looking in the same session in which the job was created. Windows
// destroys a Job object only after its handles close and its members terminate:
// https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
export function windows_reader_job_absent(id) {
  const win = windowsAPI();
  win.setError(0);
  const job = win.openJob(0x0004, 0, wide(reader_job_name(id)));
  if (!job) {
    const error = win.error();
    if (error === 2) return true;
    throw new Error("Cannot inspect index reader job (" + error + ")");
  }
  if (!win.close(job)) throw new Error("Cannot close index reader job handle (" + win.error() + ")");
  return false;
}

// The controller remains outside the job. The supervisor joins it before
// creating the native reader, so even its first instruction is contained.
// A separately retained controller handle allows termination and accounting
// to be checked instead of treating the supervisor's exit as tree completion.
export function create_windows_reader_job(id) {
  const win = windowsAPI(), name = reader_job_name(id);
  win.setError(0);
  const job = win.createJob(null, wide(name));
  if (!job) throw new Error("Cannot create index reader job (" + win.error() + ")");
  if (win.error() === 183) { win.close(job); throw new Error("Index reader job name already exists"); }
  const limits = Buffer.alloc(144); limits.writeUInt32LE(0x2000, 16);
  if (!win.setJob(job, 9, limits, limits.length)) { const error = win.error(); win.close(job); throw new Error("Cannot configure index reader job (" + error + ")"); }
  let closed = false;
  return {
    name,
    active() {
      if (closed) throw new Error("Index reader job is closed");
      const info = Buffer.alloc(48);
      if (!win.queryJob(job, 1, info, info.length, null)) throw new Error("Cannot inspect index reader job (" + win.error() + ")");
      return info.readUInt32LE(40);
    },
    terminate() {
      if (closed) throw new Error("Index reader job is closed");
      if (!win.terminateJob(job, 1)) throw new Error("Cannot terminate index reader job (" + win.error() + ")");
    },
    close() {
      if (!closed) {
        closed = true;
        if (!win.close(job)) throw Object.assign(new Error("Cannot close owned process job handle"), { outcomeUnknown: true });
      }
    },
  };
}

export function join_windows_reader_job(id, pid) {
  const win = windowsAPI(), job = win.openJob(0x0001, 0, wide(reader_job_name(id)));
  if (!job) throw new Error("Cannot open index reader job (" + win.error() + ")");
  let processHandle;
  try {
    processHandle = win.open(0x0100 | 0x0001, 0, pid);
    if (!processHandle || !win.assignJob(job, processHandle)) throw new Error("Cannot join index reader job (" + win.error() + ")");
    let closed = false;
    return { close() { if (!closed) { closed = true; if (!win.close(job)) throw Object.assign(new Error("Cannot close supervisor job handle"), { outcomeUnknown: true }); } } };
  } catch (error) { win.close(job); throw error; }
  finally { if (processHandle) win.close(processHandle); }
}

export function windows_handle_count(pid = process.pid) {
  const win = windowsAPI(), handle = win.open(0x1000, 0, pid), count = [0];
  if (!handle) throw new Error("Cannot inspect process handles (" + win.error() + ")");
  try {
    if (!win.handleCount(handle, count)) throw new Error("Cannot count process handles (" + win.error() + ")");
    return count[0];
  } finally { win.close(handle); }
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
        if (!win.close(job)) throw Object.assign(new Error("Cannot close owned process job handle"), { outcomeUnknown: true });
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
    retainedAttributes = [],
    info = {};
  const guarded = options.guardUntilCommit === true;
  let attributes, startupJob = null, transferred = false, rollbackPromise = null,
    attributesReady = false, committed = false, rolledBack = false;
  const fail = (action) => new Error(`${action} (${win.error()})`);
  try {
    if (guarded) {
      startupJob = win.createJob(null, null);
      if (!startupJob) throw fail("Cannot create daemon startup job");
      const limits = Buffer.alloc(144); limits.writeUInt32LE(0x2000, 16);
      if (!win.setJob(startupJob, 9, limits, limits.length)) throw fail("Cannot guard daemon startup");
    }
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
      output = open("NUL", 0x40000000, 3),
      error = open("NUL", 0x40000000, 3),
      size = [0n];
    win.initAttributes(null, guarded ? 2 : 1, 0, size);
    if (!Number(size[0]) || Number(size[0]) > 65536)
      throw fail("Cannot size daemon handle list");
    attributes = Buffer.alloc(Number(size[0]));
    if (!win.initAttributes(attributes, guarded ? 2 : 1, 0, size))
      throw fail("Cannot create daemon handle list");
    attributesReady = true;
    const inherited = Buffer.alloc(24);
    retainedAttributes.push(inherited);
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
    if (guarded) {
      const jobs = Buffer.alloc(8); jobs.writeBigUInt64LE(win.address(startupJob)); retainedAttributes.push(jobs);
      // Assign the job during process creation, before the first instruction.
      if (!win.updateAttribute(attributes, 0, 0x2000d, jobs, jobs.length, null, null))
        throw fail("Cannot attach daemon startup job");
    }
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
    // extended startup attributes. A restrictive ancestor Job can still retain
    // the child, even when CreateProcess succeeds and the startup Job commits.
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
    if (!win.close(info.hThread)) throw Object.assign(fail("Cannot close daemon thread handle"), { outcomeUnknown: true });
    info.hThread = null;
    let released = false;
    const controller = {
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
      ...(guarded ? {
        commit() {
          if (committed) return;
          if (rollbackPromise) throw Object.assign(new Error("Daemon startup rollback has already begun"), { outcomeUnknown: true });
          if (!startupJob) throw Object.assign(new Error("Daemon startup job is unavailable"), { outcomeUnknown: true });
          // The daemon is now recorded and healthy; its intentional project
          // lifetime may outlive the launching session.
          if (!win.setJob(startupJob, 9, Buffer.alloc(144), 144)) throw fail("Cannot commit daemon ownership");
          committed = true;
          const job = startupJob; startupJob = null;
          if (!win.close(job)) throw Object.assign(fail("Cannot close committed daemon job"), { outcomeUnknown: true });
        },
        rollback() {
          if (rolledBack) return Promise.resolve();
          return rollbackPromise ||= (async () => {
          if (committed || !startupJob) throw Object.assign(new Error("Daemon startup cleanup is not confirmed"), { outcomeUnknown: true });
          if (!win.terminateJob(startupJob, 1)) throw Object.assign(fail("Cannot terminate daemon startup job"), { outcomeUnknown: true });
          const active = () => {
            const counts = Buffer.alloc(48);
            if (!win.queryJob(startupJob, 1, counts, counts.length, null)) throw Object.assign(fail("Cannot inspect daemon startup job"), { outcomeUnknown: true });
            return counts.readUInt32LE(40);
          };
          const running = () => {
            const result = win.waitSingle(info.hProcess, 0);
            if (result === 0) return false;
            if (result === 258) return true;
            throw Object.assign(fail("Cannot confirm daemon startup exit"), { outcomeUnknown: true });
          };
          const deadline = performance.now() + 5000;
          while ((active() || running()) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
          if (active() || running()) throw Object.assign(new Error("Daemon startup termination is not confirmed"), { outcomeUnknown: true });
          const job = startupJob; startupJob = null;
          if (!win.close(job)) throw Object.assign(fail("Cannot close daemon startup job"), { outcomeUnknown: true });
          rolledBack = true;
          })();
        },
      } : {}),
      release() {
        if (!released) {
          released = true;
          const job = startupJob; startupJob = null;
          const jobClosed = !job || win.close(job);
          const processClosed = win.close(info.hProcess);
          if (!jobClosed || !processClosed || job && !committed)
            throw Object.assign(new Error("Daemon startup or handle cleanup is not confirmed"), { outcomeUnknown: true });
        }
      },
    };
    transferred = true;
    return controller;
  } finally {
    if (attributesReady) win.deleteAttributes(attributes);
    for (const handle of handles) win.close(handle);
    if (!transferred) {
      if (startupJob) { if (info.hProcess) win.terminateJob(startupJob, 1); win.close(startupJob); }
      if (info.hThread) win.close(info.hThread);
      if (info.hProcess) win.close(info.hProcess);
    }
    retainedAttributes.length = 0;
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
    const hasExited = () => {
      if (!win.times(handle, created, exited, kernel, user))
        throw new Error("Cannot query Windows process identity (" + win.error() + ")");
      return BigInt(exited[0]) !== 0n;
    };
    // Windows can retain an exited process object while another caller holds a
    // handle, but its image name is no longer queryable. Test the exit time on
    // this pinned object before and after querying the image, and only report
    // an image-query error if the same process is still alive.
    if (hasExited()) return null;
    if (!win.image(handle, 0, buffer, size)) {
      const error = win.error();
      if (hasExited()) return null;
      throw new Error("Cannot query Windows process identity (" + error + ")");
    }
    if (hasExited()) return null;
    const ticks = BigInt(created[0]);
    return {
      pid,
      executable: buffer.subarray(0, size[0] * 2).toString("utf16le"),
      created: "win32-filetime:" + ticks,
    };
  } finally {
    win.close(handle);
  }
}

// Hold the exact process object across listener/connection verification. A PID
// alone may be reused between verification and sending a control request.
export function pin_windows_process(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff) throw new Error("Invalid process PID");
  const win = windowsAPI(), handle = win.open(0x1000 | 0x00100000, 0, pid);
  if (!handle) throw new Error("Cannot pin daemon process (" + win.error() + ")");
  try {
    const created = [0n], exited = [0n], kernel = [0n], user = [0n];
    if (!win.times(handle, created, exited, kernel, user) || BigInt(exited[0]) !== 0n) throw new Error("Cannot confirm daemon process creation");
    let closed = false;
    return {
      created: "win32-filetime:" + BigInt(created[0]),
      alive() {
        if (closed) throw new Error("Daemon process handle is closed");
        const status = win.waitSingle(handle, 0);
        if (status === 258) return true;
        if (status === 0) return false;
        throw new Error("Cannot inspect daemon process handle");
      },
      close() { if (!closed) { closed = true; if (!win.close(handle)) throw Object.assign(new Error("Cannot close daemon process handle"), { outcomeUnknown: true }); } },
    };
  } catch (error) { win.close(handle); throw error; }
}

export function windows_has_tcp_peer(pid, serverPort, clientPort) {
  const rows = windows_tcp_rows(2), loopback = "7f000001";
  const local = rows.filter(row => row.state === 5 && row.pid === process.pid && row.localAddress === loopback &&
    row.remoteAddress === loopback && row.localPort === clientPort && row.remotePort === serverPort);
  const peer = rows.filter(row => row.state === 5 && row.pid === pid && row.localAddress === loopback &&
    row.remoteAddress === loopback && row.localPort === serverPort && row.remotePort === clientPort);
  return local.length === 1 && peer.length === 1;
}
export function same_creation(state, recorded) {
  return typeof recorded === "string" && recorded.startsWith("win32-filetime:") && state.created === recorded;
}

// A profile's stored PID and address can change without reconnecting. Use the
// kernel's TCP owner table to associate the actual MCP listener and TestClient.
export function windows_tcp_rows(family) {
  if (![2, 23].includes(family)) throw new Error("Unsupported TCP address family");
  const win = windowsAPI(), rowSize = family === 2 ? 24 : 56, size = [0];
  let result = win.tcpTable(null, size, 0, family, 5, 0), buffer;
  for (let attempt = 0; attempt < 3 && result === 122; attempt++) {
    if (size[0] < 4 || size[0] > 8 * 1024 * 1024) throw new Error("Invalid TCP table size");
    buffer = Buffer.alloc(size[0]);
    result = win.tcpTable(buffer, size, 0, family, 5, 0);
  }
  if (result !== 0 || !buffer || size[0] > buffer.length) throw new Error("Cannot query TCP owner table");
  const count = buffer.readUInt32LE(0);
  if (count > Math.floor((buffer.length - 4) / rowSize)) throw new Error("Truncated TCP owner table");
  const rows = [];
  for (let i = 0; i < count; i++) {
    const off = 4 + i * rowSize;
    const v4 = family === 2;
    const addr = (start, length) => buffer.subarray(off + start, off + start + length).toString("hex");
    rows.push({ family, state: buffer.readUInt32LE(off + (v4 ? 0 : 48)), pid: buffer.readUInt32LE(off + (v4 ? 20 : 52)),
      localAddress: addr(v4 ? 4 : 0, v4 ? 4 : 16), localScope: v4 ? 0 : buffer.readUInt32LE(off + 16),
      localPort: buffer.readUInt16BE(off + (v4 ? 8 : 20)),
      remoteAddress: addr(v4 ? 12 : 24, v4 ? 4 : 16), remoteScope: v4 ? 0 : buffer.readUInt32LE(off + 40),
      remotePort: buffer.readUInt16BE(off + (v4 ? 16 : 44)) });
  }
  return rows;
}

const reciprocal_tcp = (left, right) => right.family === left.family && right.state === 5 &&
  right.localPort === left.remotePort && right.remotePort === left.localPort && right.localAddress === left.remoteAddress &&
  right.remoteAddress === left.localAddress && right.localScope === left.remoteScope && right.remoteScope === left.localScope;

function tcp_address_hex(value) {
  if (typeof value !== "string") return null;
  const address = value.split("%")[0], family = net.isIP(address);
  if (family === 4) return address.split(".").map(part => Number(part).toString(16).padStart(2, "0")).join("");
  if (family !== 6) return null;
  let input = address;
  const lastColon = input.lastIndexOf(":"), tail = input.slice(lastColon + 1);
  if (net.isIP(tail) === 4) {
    const bytes = tail.split(".").map(Number);
    input = input.slice(0, lastColon + 1) + ((bytes[0] << 8) | bytes[1]).toString(16) + ":" + ((bytes[2] << 8) | bytes[3]).toString(16);
  }
  const halves = input.split("::"), left = halves[0] ? halves[0].split(":") : [], right = halves[1] ? halves[1].split(":") : [];
  const groups = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
  return groups.length === 8 ? groups.map(group => group.toLowerCase().padStart(4, "0")).join("") : null;
}

// A listening PID alone does not establish that this MCP session reached it.
export function match_mcp_binding(rows, mcpPort, managerPid, callerPid = process.pid, socket) {
  if (!Number.isInteger(mcpPort) || mcpPort < 1 || mcpPort > 65535 ||
      !Number.isInteger(managerPid) || managerPid < 1 || !Number.isInteger(callerPid) || callerPid < 1) return false;
  // A replaced listener is not necessarily the server of an existing keep-alive
  // connection. Check listeners that could serve each actual destination;
  // unrelated listeners on a different address or family are not owners.
  let mcpConnections = rows.filter(row => row.state === 5 && row.pid === callerPid && row.remotePort === mcpPort);
  if (socket) {
    const localAddress = tcp_address_hex(socket.localAddress), remoteAddress = tcp_address_hex(socket.remoteAddress);
    if (!localAddress || !remoteAddress || socket.remotePort !== mcpPort || !Number.isInteger(socket.localPort)) return false;
    mcpConnections = mcpConnections.filter(row => row.localPort === socket.localPort && row.localAddress === localAddress &&
      row.remoteAddress === remoteAddress && row.localScope === 0 && row.remoteScope === 0);
    if (mcpConnections.length !== 1) return false;
  }
  return mcpConnections.length > 0 && mcpConnections.every(left => {
    const listeners = [...new Set(rows.filter(row => row.state === 2 && row.localPort === mcpPort && row.family === left.family &&
      typeof row.localAddress === "string" && (/^0+$/.test(row.localAddress) ||
        row.localAddress === left.remoteAddress && row.localScope === left.remoteScope)).map(row => row.pid))];
    return listeners.length === 1 && listeners[0] === managerPid && rows.some(right => right.pid === managerPid && reciprocal_tcp(left, right));
  });
}

export function match_testclient_binding(rows, mcpPort, clientPid, clientPort, callerPid = process.pid) {
  if (![mcpPort, clientPort].every(port => Number.isInteger(port) && port > 0 && port <= 65535) ||
      !Number.isInteger(clientPid) || clientPid <= 0 || !Number.isInteger(callerPid) || callerPid <= 0) return null;
  const mcpConnections = rows.filter(row => row.state === 5 && row.pid === callerPid && row.remotePort === mcpPort);
  const peers = [...new Set(rows.filter(right => mcpConnections.some(left => reciprocal_tcp(left, right))).map(row => row.pid))];
  if (peers.length !== 1 || !peers[0] || peers[0] === clientPid) return null;
  const managerPid = peers[0];
  if (!match_mcp_binding(rows, mcpPort, managerPid, callerPid)) return null;
  const managerConnections = rows.filter(row => row.state === 5 && row.pid === managerPid && row.remotePort === clientPort);
  const matched = managerConnections.filter(left => rows.some(right => right.pid === clientPid && reciprocal_tcp(left, right)));
  return matched.length > 0 && matched.length === managerConnections.length ? managerPid : null;
}

export function windows_testclient_binding(mcpPort, clientPid, clientPort, clientCreated) {
  const snapshot = () => [...windows_tcp_rows(2), ...windows_tcp_rows(23)];
  const managerPid = match_testclient_binding(snapshot(), mcpPort, clientPid, clientPort);
  if (!managerPid) return null;
  const manager = windows_process_identity(managerPid), client = windows_process_identity(clientPid);
  if (!manager || !client || !/(?:^|[\\/])1cv8c?\.exe$/i.test(manager.executable) || client.created !== clientCreated) return null;
  const next = match_testclient_binding(snapshot(), mcpPort, clientPid, clientPort);
  const managerAfter = windows_process_identity(managerPid), clientAfter = windows_process_identity(clientPid);
  if (next !== managerPid || !managerAfter || !clientAfter || manager.created !== managerAfter.created || client.created !== clientAfter.created) return null;
  return { managerPid, managerCreated: manager.created };
}
