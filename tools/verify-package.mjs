import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { VERSION_PATTERN, version_key } from "./release_policy.mjs";
import { unzip } from "../scripts/archives.mjs";
import {
  sha256,
  exists,
  resolve,
  contained,
} from "../scripts/project_paths.mjs";
import { argumentsOf, entrypoint, cli } from "../scripts/common.mjs";
export function verify(download, destination) {
  const entries = new Map();
  for (const line of fs
    .readFileSync(path.join(download, "SHA256SUMS"), "utf8")
    .trimEnd()
    .split("\n")) {
    const match = new RegExp(
      `^([a-f0-9]{64})  (1c-ai-core-${VERSION_PATTERN}(?:-marketplace)?\\.zip)$`,
    ).exec(line.replace(/\r$/, ""));
    if (!match || entries.has(match[2]))
      throw new Error("Invalid or duplicate checksum entry");
    if (sha256(fs.readFileSync(path.join(download, match[2]))) !== match[1])
      throw new Error("Checksum mismatch: " + match[2]);
    entries.set(match[2], match[1]);
  }
  assert.deepEqual(
    [...entries.keys()].sort(),
    fs
      .readdirSync(download)
      .filter((file) => file.endsWith(".zip"))
      .sort(),
    "Expected exactly one plugin ZIP and one marketplace ZIP",
  );
  const name = [...entries.keys()].find((name) =>
    name.endsWith("-marketplace.zip"),
  );
  if (
    entries.size !== 2 ||
    !name ||
    !entries.has(name.replace("-marketplace.zip", ".zip"))
  )
    throw new Error("Missing matching plugin/marketplace pair");
  if (exists(destination))
    throw new Error("Extraction destination already exists");
  const data = unzip(fs.readFileSync(path.join(download, name)));
  for (const file of Object.keys(data))
    if (
      file.endsWith("/") ||
      !(
        file === ".agents/plugins/marketplace.json" ||
        file.startsWith("plugins/1c-ai-core/")
      )
    )
      throw new Error("Unexpected marketplace content");
  const catalog = JSON.parse(
    Buffer.from(data[".agents/plugins/marketplace.json"]),
  );
  if (
    catalog.name !== "shadobaai" ||
    catalog.plugins.length !== 1 ||
    catalog.plugins[0].name !== "1c-ai-core"
  )
    throw new Error("Unexpected marketplace source");
  assert.deepEqual(catalog.interface, { displayName: "ShadobaAI" });
  assert.deepEqual(catalog.plugins[0].source, {
    source: "local",
    path: "./plugins/1c-ai-core",
  });
  assert.deepEqual(catalog.plugins[0].policy, {
    installation: "AVAILABLE",
    authentication: "ON_INSTALL",
  });
  const manifest = JSON.parse(
      Buffer.from(data["plugins/1c-ai-core/.codex-plugin/plugin.json"]),
    ),
    build = JSON.parse(Buffer.from(data["plugins/1c-ai-core/build-info.json"]));
  if (
    manifest.name !== "1c-ai-core" ||
    manifest.version !== build.version ||
    manifest.skills !== "./skills/" ||
    build.profile !== "release"
  )
    throw new Error("Inconsistent plugin identity");
  version_key(manifest.version);
  if (name !== `1c-ai-core-${manifest.version}-marketplace.zip`)
    throw new Error("Archive name does not match the manifest version");
  const plugin = unzip(
    fs.readFileSync(
      path.join(download, name.replace("-marketplace.zip", ".zip")),
    ),
  );
  const expected = Object.fromEntries(
    Object.entries(data)
      .filter(([file]) => file.startsWith("plugins/1c-ai-core/"))
      .map(([file, value]) => [file.slice("plugins/".length), value]),
  );
  assert.deepEqual(plugin, expected, "Plugin ZIP and marketplace ZIP differ");
  const root = resolve(destination);
  for (const [file, content] of Object.entries(data)) {
    const target = resolve(path.join(root, file));
    if (!contained(root, target)) throw new Error("Unsafe extraction target");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, { flag: "wx" });
  }
  return build;
}
if (entrypoint(import.meta.url))
  await cli(() => {
    const a = argumentsOf();
    console.log(JSON.stringify(verify(a._[0], a._[1])));
  });
