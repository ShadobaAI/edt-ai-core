import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

let native;
function systemAPI() {
  if (native) return native;
  const platform = process.platform === "linux" && !process.report.getReport().header.glibcVersionRuntime ? "musl" : process.platform;
  const koffi = createRequire(import.meta.url)(path.join(path.dirname(fileURLToPath(import.meta.url)), "../vendor/native", `${platform}_${process.arch}`, "koffi.node"));
  const libc = koffi.load(null);
  native = { koffi, libc };
  return native;
}
export function unlink_at(directory, name) {
  if (!Number.isInteger(directory) || directory < 0 || typeof name !== "string" || !name || name.includes("/") || name === "." || name === "..")
    throw new Error("Invalid owned file name");
  const { koffi, libc } = systemAPI(), unlink = libc.func("int unlinkat(int directory, const char *name, int flags)");
  if (unlink(directory, name, 0) !== 0 && koffi.errno() !== 2) throw new Error("Cannot remove an owned observation file (" + koffi.errno() + ")");
}

// macOS proc_bsdinfo is defined by XNU's public proc_info.h. Validate both the
// returned size and PID; an unavailable or changing process is never cached.
export function darwin_process_identity(pid) {
  if (process.platform !== "darwin" || !Number.isSafeInteger(pid) || pid <= 0) return null;
  const { libc } = systemAPI(), info = Buffer.alloc(136);
  const procPidInfo = libc.func("int proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int size)");
  if (procPidInfo(pid, 3, 0, info, info.length) !== info.length || info.readUInt32LE(12) !== pid) return null;
  const sec = info.readBigUInt64LE(120), usec = info.readBigUInt64LE(128);
  return sec > 0n && usec < 1000000n ? `darwin:${sec}:${usec}` : null;
}

export function darwin_process_executable(pid) {
  if (process.platform !== "darwin") return null;
  const { libc } = systemAPI(), buffer = Buffer.alloc(4096);
  const procPidPath = libc.func("int proc_pidpath(int pid, void *buffer, uint32_t size)");
  const length = procPidPath(pid, buffer, buffer.length);
  return length > 0 && length < buffer.length ? buffer.subarray(0, length).toString("utf8").replace(/\0.*$/, "") : null;
}

export function darwin_has_loopback_listener(pid, port) {
  if (process.platform !== "darwin") return false;
  const { libc } = systemAPI(), list = libc.func("int proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int size)"),
    fdinfo = libc.func("int proc_pidfdinfo(int pid, int fd, int flavor, void *buffer, int size)");
  // XNU's public proc_fdinfo and socket_fdinfo layouts. A truncated or
  // inaccessible list is never treated as evidence of ownership.
  const fds = Buffer.alloc(256 * 1024), count = list(pid, 1, 0, fds, fds.length);
  if (count <= 0 || count >= fds.length || count % 8) return false;
  for (let i = 0; i < count; i += 8) {
    if (fds.readUInt32LE(i + 4) !== 2) continue;
    const socket = Buffer.alloc(1024), size = fdinfo(pid, fds.readInt32LE(i), 3, socket, socket.length);
    if (size < 348) continue;
    if (socket.readInt32LE(176) === 1 && socket.readInt32LE(180) === 6 && socket.readInt32LE(184) === 2 &&
        socket.readInt32LE(256) === 2 && socket.readUInt16BE(268) === port && socket.readInt32LE(344) === 1 &&
        socket.subarray(324, 328).toString("hex") === "7f000001") return true;
  }
  return false;
}

export function linux_has_loopback_listener(pid, port) {
  if (process.platform !== "linux") return false;
  const sockets = new Set(), descriptors = fs.readdirSync(`/proc/${pid}/fd`);
  if (descriptors.length > 4096) throw new Error("Too many daemon descriptors to confirm listener ownership");
  for (const fd of descriptors) {
    try { const match = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${pid}/fd/${fd}`)); if (match) sockets.add(match[1]); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const file = fs.openSync(`/proc/${pid}/net/tcp`, "r"), chunks = []; let size = 0;
  try {
    while (true) {
      const chunk = Buffer.allocUnsafe(64 * 1024), count = fs.readSync(file, chunk, 0, chunk.length, null);
      if (!count) break;
      size += count; if (size > 8 * 1024 * 1024) throw new Error("TCP table is too large to confirm listener ownership");
      chunks.push(chunk.subarray(0, count));
    }
  } finally { fs.closeSync(file); }
  const address = "0100007F:" + port.toString(16).toUpperCase().padStart(4, "0");
  let found = null;
  for (const line of Buffer.concat(chunks).toString("utf8").trim().split("\n").slice(1)) {
    const row = line.trim().split(/\s+/);
    if (row[3] !== "0A" || !row[1]?.endsWith(address.slice(8))) continue;
    if (found) return false;
    found = row;
  }
  return Boolean(found && found[1] === address && sockets.has(found[9]));
}

// Confirm both ends of the already connected loopback socket, including the
// accepted descriptor held by the expected daemon process.
export function linux_has_tcp_peer(pid, serverPort, clientPort) {
  if (process.platform !== "linux") return false;
  const socketInodes = processId => {
    const descriptors = fs.readdirSync(`/proc/${processId}/fd`), result = new Set();
    if (descriptors.length > 4096) throw new Error("Too many process descriptors to confirm TCP ownership");
    for (const fd of descriptors) {
      try { const match = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${processId}/fd/${fd}`)); if (match) result.add(match[1]); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    return result;
  };
  const localSockets = socketInodes(process.pid), serverSockets = socketInodes(pid);
  const fd = fs.openSync(`/proc/${pid}/net/tcp`, "r"), chunks = []; let bytes = 0;
  try {
    for (;;) {
      const chunk = Buffer.allocUnsafe(64 * 1024), count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      bytes += count; if (bytes > 8 * 1024 * 1024) throw new Error("TCP table is too large");
      chunks.push(chunk.subarray(0, count));
    }
  } finally { fs.closeSync(fd); }
  const address = port => "0100007F:" + port.toString(16).toUpperCase().padStart(4, "0");
  const client = address(clientPort), server = address(serverPort);
  let local = 0, remote = 0;
  for (const line of Buffer.concat(chunks).toString("utf8").trim().split("\n").slice(1)) {
    const row = line.trim().split(/\s+/); if (row[3] !== "01") continue;
    if (row[1] === client && row[2] === server && localSockets.has(row[9])) local++;
    if (row[1] === server && row[2] === client && serverSockets.has(row[9])) remote++;
  }
  return local === 1 && remote === 1;
}

let linux;
function linuxAPI() {
  if (linux) return linux;
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("Protected readers require supported Linux x64");
  const { koffi, libc } = systemAPI();
  linux = { koffi,
    prctl: libc.func("int prctl(int option, unsigned long a, unsigned long b, unsigned long c, unsigned long d)"),
    pidfdOpen: libc.func("long syscall(long number, int pid, unsigned int flags)"),
    pidfdSignal: libc.func("long syscall(long number, int fd, int signal, void *info, unsigned int flags)"),
    close: libc.func("int close(int fd)"),
    wait: libc.func("int waitpid(int pid, void *status, int options)"),
    poll: libc.func("int poll(void *fds, unsigned long count, int timeout)"),
  };
  return linux;
}
export function pin_linux_process(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid process PID");
  const api = linuxAPI(), fd = api.pidfdOpen(434, pid, 0);
  if (fd < 0) throw new Error("Cannot pin daemon process");
  let closed = false;
  return {
    alive() {
      if (closed) throw new Error("Daemon pidfd is closed");
      const pollfd = Buffer.alloc(8); pollfd.writeInt32LE(fd, 0); pollfd.writeInt16LE(1, 4);
      const result = api.poll(pollfd, 1, 0);
      if (result < 0) throw new Error("Cannot inspect daemon pidfd");
      return result === 0;
    },
    close() { if (!closed) { closed = true; if (api.close(fd) !== 0) throw Object.assign(new Error("Cannot close daemon pidfd"), { outcomeUnknown: true }); } },
  };
}
const childFile = () => `/proc/self/task/${process.pid}/children`;
export function linux_children() {
  const value = fs.readFileSync(childFile(), "utf8").trim();
  if (!value) return [];
  const children = value.split(/\s+/).map(Number);
  if (children.some(pid => !Number.isSafeInteger(pid) || pid <= 0)) throw new Error("Cannot confirm owned Linux children");
  return children;
}
function pidfd(pid, signal) {
  const api = linuxAPI(), fd = api.pidfdOpen(434, pid, 0);
  if (fd < 0) { if (api.koffi.errno() === 3) return; throw new Error("Cannot open owned Linux process"); }
  try {
    // The descriptor pins the process. Only signal a process which is still a
    // direct child of this private supervisor; a reused PID is never enough.
    if (pid !== process.pid && !linux_children().includes(pid)) return;
    if (api.pidfdSignal(424, fd, signal, null, 0) < 0 && api.koffi.errno() !== 3)
      throw new Error("Cannot signal owned Linux process");
  } finally { api.close(fd); }
}
export function linux_subreaper() {
  const api = linuxAPI();
  if (api.prctl(36, 1, 0, 0, 0) !== 0) throw new Error("Cannot establish Linux child subreaper");
  linux_children();
  pidfd(process.pid, 0); // Require pidfd support before launching the target.
}
export function linux_signal_children(signal) {
  for (const pid of linux_children()) pidfd(pid, signal);
}
export function linux_terminate_children(originalPid) {
  const api = linuxAPI();
  for (const pid of linux_children()) {
    // libuv reaps the original child. Adopted grandchildren are not tracked by
    // libuv, so reap their zombies explicitly without stealing that exit event.
    if (pid !== originalPid && api.wait(pid, null, 1) === pid) continue;
    pidfd(pid, 9);
  }
  return linux_children().length === 0;
}
