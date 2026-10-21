import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, entrypoint, argumentsOf, cli } from "../scripts/common.mjs";
import { resolve, exists, sha256 } from "../scripts/project_paths.mjs";
import { zip } from "../scripts/archives.mjs";
import { read_source_manifest, resolve_version } from "./release_policy.mjs";

import { source_files, walk } from "../scripts/package_layout.mjs";
export { DIRECTORIES, FILES, walk } from "../scripts/package_layout.mjs";

export function package_plugin(output = path.join(ROOT, ".build"), override) {
  const manifest = read_source_manifest(ROOT),
    version = resolve_version(ROOT, override),
    paths = source_files(ROOT);
  const template = path.join(ROOT, "packaging/marketplace.template.json");
  if (
    !fs.statSync(template).isFile() ||
    resolve(template) !== path.resolve(template)
  )
    throw new Error("Missing or symlinked marketplace template");
  const catalog = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, "packaging/marketplace.template.json"),
      "utf8",
    ),
  );
  output = path.resolve(output);
  if (output !== path.join(ROOT, ".build") || resolve(output) !== output)
    throw new Error(
      "Output must be the repository .build directory, without symlinks",
    );
  const git = (args) =>
    spawnSync("git", args, {
      cwd: ROOT,
      encoding: "utf8",
      windowsHide: true,
      shell: false,
    });
  const rev = git(["rev-parse", "HEAD"]),
    status = git(["status", "--porcelain", "--untracked-files=normal"]);
  if (status.error || status.status !== 0)
    throw new Error("Cannot determine Git worktree state");
  const revision = rev.status === 0 ? rev.stdout.trim() : null,
    dirty = !!status.stdout.trim() || !revision;
  // Validate all inputs before removing the previous, repository-scoped output.
  if (exists(output)) fs.rmSync(output, { recursive: true });
  const marketplace = path.join(output, "marketplace"),
    plugin = path.join(marketplace, "plugins/1c-ai-core");
  fs.mkdirSync(plugin, { recursive: true });
  for (const name of paths) {
    const target = path.join(plugin, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(ROOT, name), target);
  }
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
  };
  manifest.version = version;
  write(path.join(plugin, "plugin.json"), manifest);
  const codex = Object.fromEntries(
    Object.entries(manifest).filter(
      ([key]) => !["$schema", "extensions"].includes(key),
    ),
  );
  write(path.join(plugin, ".codex-plugin/plugin.json"), {
    ...codex,
    ...manifest.extensions?.["com.openai"],
    skills: "./skills/",
    mcpServers: "./mcp.json",
  });
  write(path.join(plugin, "build-info.json"), {
    plugin: "1c-ai-core",
    version,
    profile: "release",
    revision,
    dirty,
    runId: process.env.GITHUB_RUN_ID || null,
  });
  let sourceNotice = `# Source code\n\n1C AI Core ${version}\n\nhttps://github.com/ShadobaAI/edt-ai-core${revision ? "/tree/" + revision : ""}\n\nCopyright (c) 2026 ShadobaAI and contributors.\n\nThis Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. See LICENSE and NOTICE.md.\n`;
  if (dirty)
    sourceNotice +=
      "\nThis local build includes uncommitted changes or has no base commit. The source link does not identify its complete contents.\n";
  fs.writeFileSync(path.join(plugin, "SOURCE.md"), sourceNotice);
  catalog.plugins[0].policy.installation = "AVAILABLE";
  write(path.join(marketplace, ".agents/plugins/marketplace.json"), catalog);
  const archive = (directory, destination, prefix = "") =>
    fs.writeFileSync(
      destination,
      zip(
        Object.fromEntries(
          walk(directory).map((file) => [
            prefix + path.relative(directory, file).replaceAll("\\", "/"),
            fs.readFileSync(file),
          ]),
        ),
      ),
    );
  const archives = [
    path.join(output, `1c-ai-core-${version}.zip`),
    path.join(output, `1c-ai-core-${version}-marketplace.zip`),
  ];
  archive(plugin, archives[0], "1c-ai-core/");
  archive(marketplace, archives[1]);
  fs.writeFileSync(
    path.join(output, "SHA256SUMS"),
    [...archives]
      .sort()
      .map(
        (file) => `${sha256(fs.readFileSync(file))}  ${path.basename(file)}\n`,
      )
      .join(""),
  );
  return { plugin, archives };
}
if (entrypoint(import.meta.url))
  await cli(() => {
    console.log(
      JSON.stringify(package_plugin(undefined, argumentsOf().version)),
    );
  });
