import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { casefold } from "./casefold.mjs";

export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export class ConfigError extends Error {}
export class ProfileNotFound extends ConfigError {}
export const exists = (file) => fs.existsSync(file);
export const is_file = (file) => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};
export const is_dir = (file) => {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
};
// realpath also resolves symlinks in the existing prefix of a not-yet-created path.
export function resolve(file) {
  let current = path.resolve(file),
    suffix = [];
  while (!exists(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    suffix.unshift(path.basename(current));
    current = parent;
  }
  return path.join(fs.realpathSync.native(current), ...suffix);
}
export function contained(root, target) {
  const relative = path.relative(root, target);
  return (
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
}
export const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");
export function instance_name() {
  const name = process.env.EDT_AI_INSTANCE || "default";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name))
    throw new ConfigError("Invalid EDT_AI_INSTANCE identifier");
  return name;
}
export function instance_directory(state, root) {
  return path.join(
    state,
    "projects",
    sha256(casefold(resolve(root))).slice(0, 16),
    "instances",
  );
}
export function reconnect_file(state, root) {
  return path.join(
    instance_directory(state, root),
    instance_name() + ".reconnect.json",
  );
}
export function locate_project(selected) {
  const directory = resolve(selected);
  if (!is_dir(directory))
    throw new ConfigError("Selected project directory does not exist");
  for (let candidate = directory; ; candidate = path.dirname(candidate)) {
    const profile = path.join(candidate, ".ai/project.yaml");
    if (is_file(profile)) {
      if (!contained(candidate, resolve(profile)))
        throw new ConfigError(
          "Project profile must remain inside its repository",
        );
      return candidate;
    }
    if (
      exists(path.join(candidate, ".git")) ||
      path.dirname(candidate) === candidate
    )
      break;
  }
  throw new ProfileNotFound("No .ai/project.yaml in the selected repository");
}
export function configuration_root(selected) {
  try {
    return locate_project(selected);
  } catch (error) {
    if (!(error instanceof ProfileNotFound)) throw error;
  }
  let directory = resolve(selected);
  for (let candidate = directory; ; candidate = path.dirname(candidate)) {
    if (exists(path.join(candidate, ".git"))) return candidate;
    if (path.dirname(candidate) === candidate) return directory;
  }
}
export function select_root(roots, cwd) {
  const paths = [
    ...new Set(
      roots.map((item) => {
        const uri = new URL(item.uri);
        if (
          uri.protocol !== "file:" ||
          !["", "localhost"].includes(uri.hostname)
        )
          throw new ConfigError("Project roots must be local file URIs");
        return resolve(fileURLToPath(uri));
      }),
    ),
  ];
  if (paths.length === 1) return paths[0];
  const matches = paths.filter((directory) =>
    contained(directory, resolve(cwd)),
  );
  if (matches.length === 1) return matches[0];
  throw new ConfigError(
    "Select exactly one project directory; multiple roots are ambiguous",
  );
}
export function state_root() {
  return resolve(
    process.env.EDT_AI_STATE_DIR ||
      path.join(
        process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
        "1c-ai-core",
      ),
  );
}
