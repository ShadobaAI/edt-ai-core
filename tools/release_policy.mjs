import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, entrypoint, argumentsOf, cli } from "../scripts/common.mjs";
export const VERSION_PATTERN =
  "(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)";
export const PREVIEW_PATTERN = `${VERSION_PATTERN}-preview\\.(?:[1-9][0-9]*)`;
export function preview_key(version) {
  const match = new RegExp(`^(${VERSION_PATTERN})-preview\\.([1-9][0-9]*)$`).exec(version);
  if (!match) throw new Error("Expected a preview version such as 1.0.0-preview.1");
  return { base: match[1], number: BigInt(match[2]) };
}
export function compare_preview(a, b) {
  const left = preview_key(a), right = preview_key(b);
  return compare_version(left.base, right.base) || (left.number > right.number ? 1 : left.number < right.number ? -1 : 0);
}
export function version_key(version) {
  if (
    typeof version !== "string" ||
    !new RegExp("^" + VERSION_PATTERN + "$").test(version)
  )
    throw new Error(
      "Expected a stable version such as 1.0.0, without prefix or prerelease",
    );
  return version.split(".").map(BigInt);
}
export function compare_version(a, b) {
  const left = version_key(a),
    right = version_key(b);
  for (let i = 0; i < 3; i++)
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}
export function read_source_manifest(root) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "plugin.json"), "utf8"),
  );
  if (manifest.name !== "1c-ai-core")
    throw new Error("Unexpected plugin identity");
  version_key(manifest.version);
  return manifest;
}
export function resolve_version(root, version) {
  if (
    process.env.GITHUB_ACTIONS === "true" &&
    process.env.GITHUB_REF_TYPE === "tag"
  ) {
    const tag = process.env.GITHUB_REF_NAME || "";
    version_key(tag);
    if (version !== undefined && version !== tag)
      throw new Error("Package version must match the triggering Git tag");
    return tag;
  }
  if (version === undefined) {
    const result = spawnSync("git", ["tag", "--merged", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      shell: false,
    });
    const tags = (result.stdout || "")
      .split(/\r?\n/)
      .filter((tag) => new RegExp("^" + VERSION_PATTERN + "$").test(tag));
    version = [...tags, read_source_manifest(root).version].sort(compare_version).at(-1);
  }
  version_key(version);
  return version;
}
if (entrypoint(import.meta.url))
  await cli(
    () => console.log(resolve_version(ROOT, argumentsOf().version)) && 0,
  );
