import fs from "node:fs";
import path from "node:path";
import { resolve } from "./project_paths.mjs";

export const DIRECTORIES = {
  assets: [".svg"],
  hooks: [".json", ".mjs"],
  mcp: [".mjs", ".md"],
  policy: [".json", ".mjs", ".md"],
  schemas: [".json"],
  scripts: [".mjs"],
  skills: [".md", ".yaml"],
  ui: [".html"],
  vanessa: [".mjs"],
};
export const FILES = [
  "LICENSE",
  "NOTICE.md",
  "UNICODE-LICENSE.txt",
  "plugin.json",
  "mcp.json",
  "settings/defaults.json",
  "settings/local.example.yaml",
  "profiles/generic-1c/profile.yaml",
  "knowledge/recommended-manifest.yaml",
  "runtime/runtime-manifest.yaml",
  "README.md",
  "vendor/deps.mjs",
  "vendor/NOTICE.txt",
  "vendor/native/win32_x64/koffi.node",
  "vendor/native/win32_arm64/koffi.node",
  ...[
    "README",
    "ARCHITECTURE",
    "ACCEPTANCE",
    "DEVELOPMENT",
    "USAGE",
    "PROFILES",
    "PROJECT_AGENTS",
    "REQUIREMENTS",
    "QUALITY_REQUIREMENTS",
    "INTEGRATIONS",
    "SOURCES",
  ].map((name) => "docs/" + name + ".md"),
];
const EXCLUDED = new Set(["local.yaml", "runtime.local.json"]);
export function walk(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((entry) => {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error("Symlink in package path: " + file);
      return entry.isDirectory() ? walk(file) : [file];
    });
}
export function source_files(root) {
  const paths = [...FILES];
  for (const [directory, extensions] of Object.entries(DIRECTORIES)) {
    for (const file of walk(path.join(root, directory))) {
      if (
        extensions.includes(path.extname(file)) &&
        !file.split(path.sep).some((part) => EXCLUDED.has(part))
      )
        paths.push(path.relative(root, file));
    }
  }
  for (const name of paths) {
    const file = path.join(root, name);
    if (!fs.statSync(file).isFile() || resolve(file) !== path.resolve(file))
      throw new Error("Missing input or symlink in package path: " + file);
  }
  return paths;
}
