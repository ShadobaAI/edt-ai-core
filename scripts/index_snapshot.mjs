import fs from "node:fs";
import path from "node:path";
import { inside } from "./common.mjs";
import { project_directory, resolve, sha256 } from "./project_paths.mjs";
import { repository_projects, index_selection } from "./directory_context.mjs";
import { read_regular_file } from "./bounded_file.mjs";

const names = ["daemon.json", "owner.json", "daemon.toml"];
const limit = 1024 * 1024;

function snapshot_file(file) {
  const value = read_regular_file(file, limit);
  return value ? { digest: sha256(value.bytes), bytes: value.bytes.toString("base64"),
    stamp: [value.stat.dev, value.stat.ino, value.stat.size, value.stat.mtimeNs, value.stat.ctimeNs].map(String) }
    : { digest: "missing", bytes: null, stamp: null };
}

// Capture input bytes and repository inventory for before/after validation.
// The native client reads the existing project files, not these in-memory bytes.
export function capture_index_snapshot(state, root, profile) {
  const home = path.join(project_directory(state, root), "code-index"), repositories = repository_projects(root, profile.repositories);
  const selection = index_selection(root, profile, repositories);
  selection.canonicalPaths = Object.fromEntries(selection.repositories.map(repo => [repo.id, inside(root, repo.path)]));
  selection.present = Object.fromEntries(selection.repositories.map(repo => [repo.id, fs.statSync(path.join(selection.canonicalPaths[repo.id], ".code-index/index.db"), { throwIfNoEntry: false })?.isFile() === true]));
  return { root: resolve(root), repositories, selection,
    files: Object.fromEntries(names.map(name => [name, snapshot_file(path.join(home, name))])) };
}

export function snapshot_bytes(snapshot, name) {
  const entry = snapshot?.files?.[name];
  if (!entry || entry.bytes === null && entry.digest === "missing") return null;
  if (typeof entry.bytes !== "string" || !/^[a-f0-9]{64}$/.test(entry.digest || "")) throw new Error("Invalid index runtime snapshot");
  const bytes = Buffer.from(entry.bytes, "base64");
  if (bytes.length > limit || bytes.toString("base64") !== entry.bytes || sha256(bytes) !== entry.digest) throw new Error("Invalid index runtime snapshot");
  return bytes;
}
