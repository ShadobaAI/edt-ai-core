import { gunzipSync } from "node:zlib";
import { unzipSync, zipSync } from "../vendor/deps.mjs";

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let bit = 0; bit < 8; bit++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
export function zip_entries(bytes, maxBytes = 100_000_000) {
  bytes = Buffer.from(bytes);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (
      bytes.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + bytes.readUInt16LE(i + 20) === bytes.length
    ) {
      eocd = i;
      break;
    }
  if (
    eocd < 0 ||
    bytes.readUInt16LE(eocd + 4) ||
    bytes.readUInt16LE(eocd + 6) ||
    bytes.readUInt16LE(eocd + 8) !== bytes.readUInt16LE(eocd + 10)
  )
    throw new Error("Invalid or unsupported ZIP");
  // fflate locates the last EOCD signature without checking the comment length
  // and recognizes ZIP64 from a locator immediately before it. Reject both
  // ambiguities so its directory is exactly the one validated below.
  for (let i = eocd + 1; i <= bytes.length - 22; i++)
    if (bytes.readUInt32LE(i) === 0x06054b50)
      throw new Error("Ambiguous ZIP end record");
  if (eocd >= 20 && bytes.readUInt32LE(eocd - 20) === 0x07064b50)
    throw new Error("ZIP64 is unsupported");
  const count = bytes.readUInt16LE(eocd + 10),
    offset = bytes.readUInt32LE(eocd + 16);
  if (count === 65535 || offset + bytes.readUInt32LE(eocd + 12) !== eocd)
    throw new Error("Invalid ZIP directory");
  const entries = [];
  let cursor = offset,
    total = 0;
  const names = new Set();
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > eocd || bytes.readUInt32LE(cursor) !== 0x02014b50)
      throw new Error("Invalid ZIP entry");
    const size = bytes.readUInt32LE(cursor + 24),
      length = bytes.readUInt16LE(cursor + 28),
      extra = bytes.readUInt16LE(cursor + 30),
      comment = bytes.readUInt16LE(cursor + 32);
    const name = bytes
        .subarray(cursor + 46, cursor + 46 + length)
        .toString("utf8"),
      mode = bytes.readUInt32LE(cursor + 38) >>> 16;
    const parts = name.replace(/\/$/, "").split("/");
    total += size;
    if (
      !name ||
      name.startsWith("/") ||
      /[\\:\x00]/.test(name) ||
      parts.some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      ) ||
      names.has(name.toLowerCase()) ||
      (mode & 0o170000) === 0o120000 ||
      total > maxBytes ||
      bytes.readUInt16LE(cursor + 8) & 1
    )
      throw new Error("Unsafe ZIP entry");
    names.add(name.toLowerCase());
    entries.push({ name, size, crc: bytes.readUInt32LE(cursor + 16), directory: name.endsWith("/") });
    cursor += 46 + length + extra + comment;
  }
  if (cursor !== eocd) throw new Error("Invalid ZIP directory size");
  return entries;
}
export function unzip(bytes, maxBytes) {
  const entries = zip_entries(bytes, maxBytes);
  const data = unzipSync(bytes);
  if (
    Object.keys(data).length !== entries.length ||
    entries.some(
      (item) => !data[item.name] || data[item.name].length !== item.size || crc32(data[item.name]) !== item.crc,
    )
  )
    throw new Error("ZIP entry mismatch");
  return data;
}
export function zip(files) {
  return zipSync(
    Object.fromEntries(
      Object.entries(files).map(([name, data]) => [
        name,
        [data, { mtime: new Date(2020, 0, 1), os: 3, attrs: 0o100644 << 16 }],
      ]),
    ),
    { level: 9 },
  );
}
// Project transfer archives have a deliberately closed layout. Validate the
// central directory before decompression, then accept only bounded UTF-8 YAML.
const projectEntries = [".ai/project.yaml", ".ai/project.local.yaml"];
const projectFileLimit = 2 * 1024 * 1024;
export function read_project_archive(bytes) {
  bytes = Buffer.from(bytes);
  if (bytes.length > 4 * 1024 * 1024) throw new Error("Project archive exceeds 4 MiB");
  const entries = zip_entries(bytes, 2 * projectFileLimit);
  if (entries.length !== projectEntries.length ||
      entries.some(entry => entry.directory || !projectEntries.includes(entry.name) || entry.size > projectFileLimit))
    throw new Error("Project archive must contain exactly the two project YAML files");
  const data = unzip(bytes, 2 * projectFileLimit), result = {};
  for (const name of projectEntries) {
    const content = Buffer.from(data[name]), text = content.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(content) || text.includes("\0")) throw new Error("Project archive YAML must be UTF-8");
    result[name] = text;
  }
  return result;
}
export function write_project_archive(documents) {
  if (!documents || typeof documents !== "object" || Object.keys(documents).length !== projectEntries.length ||
      projectEntries.some(name => typeof documents[name] !== "string" || Buffer.byteLength(documents[name]) > projectFileLimit || documents[name].includes("\0")))
    throw new Error("Project archive requires exactly two bounded YAML documents");
  return zip(Object.fromEntries(projectEntries.map(name => [name, Buffer.from(documents[name], "utf8")])));
}
export function extract_binary(bytes, format, executable) {
  if (format === "zip") {
    const data = unzip(bytes, 512 * 1024 * 1024),
      matches = Object.keys(data).filter(
        (name) => name.split("/").at(-1) === executable,
      );
    if (matches.length !== 1)
      throw new Error("Archive must contain exactly one " + executable);
    return data[matches[0]];
  }
  if (format !== "tar.gz") throw new Error("Unsupported runtime archive");
  const tar = gunzipSync(bytes, { maxOutputLength: 512 * 1024 * 1024 });
  let cursor = 0;
  const matches = [];
  while (cursor + 512 <= tar.length) {
    const header = tar.subarray(cursor, cursor + 512);
    if (header.every((value) => value === 0)) break;
    const text = (start, length) =>
      header
        .subarray(start, start + length)
        .toString("utf8")
        .split("\0")[0];
    const octal = (start, length) => {
      const value = text(start, length).trim();
      if (!/^[0-7]+$/.test(value)) throw new Error("Invalid tar numeric field");
      return parseInt(value, 8);
    };
    const checksum = [...header].reduce(
      (sum, value, index) => sum + (index >= 148 && index < 156 ? 32 : value),
      0,
    );
    if (checksum !== octal(148, 8)) throw new Error("Tar checksum mismatch");
    const name = (text(345, 155) ? text(345, 155) + "/" : "") + text(0, 100),
      size = octal(124, 12),
      type = text(156, 1);
    cursor += 512;
    if (!Number.isSafeInteger(size) || cursor + size > tar.length)
      throw new Error("Truncated tar entry");
    // Nothing is extracted by path. Only regular files with the exact basename qualify.
    if (name.split("/").at(-1) === executable) {
      if (!["", "0"].includes(type))
        throw new Error("Runtime binary must be a regular file");
      matches.push(tar.subarray(cursor, cursor + size));
    }
    cursor += Math.ceil(size / 512) * 512;
  }
  if (matches.length !== 1)
    throw new Error("Archive must contain exactly one " + executable);
  return matches[0];
}
