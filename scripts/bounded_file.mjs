import fs from "node:fs";
import { createHash } from "node:crypto";

// Reject pipes, devices, symlinks and files which change while being read.
// O_NONBLOCK prevents a file replaced by a FIFO after lstat from hanging the
// owning MCP event loop; O_NOFOLLOW prevents a final-component symlink swap.
export function read_regular_file(file, maxBytes) {
  let fd;
  try {
    const before = fs.lstatSync(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(maxBytes)) throw new Error("Invalid or oversized local input");
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_NOFOLLOW || 0);
    fd = fs.openSync(file, flags);
    const opened = fs.fstatSync(fd, { bigint: true });
    const stamp = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(":");
    if (!opened.isFile() || stamp(opened) !== stamp(before) || opened.size > BigInt(maxBytes)) throw Object.assign(new Error("Local input changed while opening"), { code: "LOCAL_FILE_CHANGED" });
    const bytes = Buffer.alloc(Number(opened.size) + 1); let length = 0;
    while (length < bytes.length) { const count = fs.readSync(fd, bytes, length, bytes.length - length, null); if (!count) break; length += count; }
    if (length !== Number(opened.size) || stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(opened)) throw Object.assign(new Error("Local input changed while reading"), { code: "LOCAL_FILE_CHANGED" });
    return { bytes: bytes.subarray(0, length), stat: opened };
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function hash_regular_file(file, maxBytes) {
  let fd;
  try {
    const before = fs.lstatSync(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(maxBytes)) throw new Error("Invalid or oversized local input");
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_NOFOLLOW || 0);
    fd = fs.openSync(file, flags);
    const opened = fs.fstatSync(fd, { bigint: true });
    const stamp = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(":");
    if (!opened.isFile() || stamp(opened) !== stamp(before) || opened.size > BigInt(maxBytes)) throw new Error("Local input changed while opening");
    const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(256 * 1024); let total = 0;
    while (true) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null); if (!count) break;
      total += count; if (total > maxBytes || total > Number(opened.size)) throw new Error("Local input changed or exceeds its size limit");
      hash.update(buffer.subarray(0, count));
    }
    if (total !== Number(opened.size) || stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(opened)) throw new Error("Local input changed while reading");
    return hash.digest("hex");
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

// Used by the long-lived settings MCP: keep one pinned source descriptor, but
// perform disk I/O asynchronously so a large runtime cannot block the UI.
export async function copy_and_hash_regular_file(file, destination, maxBytes, timeoutMs = 30000, destinationIdentity = null) {
  let source, output, complete = false;
  const stamp = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(":");
  const deadline = performance.now() + timeoutMs;
  const check = () => { if (performance.now() >= deadline) throw new Error("Timed out copying the verified runtime"); };
  try {
    const before = await fs.promises.lstat(file, { bigint: true }); check();
    if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(maxBytes)) throw new Error("Invalid or oversized local input");
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_NOFOLLOW || 0);
    source = await fs.promises.open(file, flags); check();
    const opened = await source.stat({ bigint: true }); check();
    if (!opened.isFile() || stamp(opened) !== stamp(before) || opened.size > BigInt(maxBytes)) throw new Error("Local input changed while opening");
    if (destinationIdentity) {
      if (typeof destinationIdentity.dev !== "string" || typeof destinationIdentity.ino !== "string" ||
          !/^\d{1,32}$/.test(destinationIdentity.dev) || !/^\d{1,32}$/.test(destinationIdentity.ino)) throw new Error("Invalid destination identity");
      const destinationBefore = await fs.promises.lstat(destination, { bigint: true }); check();
      const matches = stat => stat.isFile() && String(stat.dev) === destinationIdentity.dev && String(stat.ino) === destinationIdentity.ino && stat.size === 0n;
      if (destinationBefore.isSymbolicLink() || !matches(destinationBefore)) throw new Error("Destination changed before copying");
      output = await fs.promises.open(destination, fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0)); check();
      if (!matches(await output.stat({ bigint: true }))) throw new Error("Destination changed while opening");
    } else { output = await fs.promises.open(destination, "wx", 0o700); check(); }
    const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(256 * 1024); let total = 0;
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, null); check();
      if (!bytesRead) break;
      total += bytesRead; if (total > maxBytes || total > Number(opened.size)) throw new Error("Local input changed or exceeds its size limit");
      hash.update(buffer.subarray(0, bytesRead));
      for (let offset = 0; offset < bytesRead;) {
        const { bytesWritten } = await output.write(buffer, offset, bytesRead - offset); check();
        if (bytesWritten <= 0) throw new Error("Could not write the complete verified copy");
        offset += bytesWritten;
      }
    }
    if (total !== Number(opened.size) || stamp(await source.stat({ bigint: true })) !== stamp(opened)) throw new Error("Local input changed while reading");
    const digest = hash.digest("hex"); complete = true; return digest;
  } finally {
    try { await source?.close(); }
    finally {
      try { await output?.close(); }
      finally { if (output && !complete && !destinationIdentity) await fs.promises.rm(destination, { force: true }); }
    }
  }
}
