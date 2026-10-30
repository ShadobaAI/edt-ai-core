// GitHub run steps use `node {0}`. No platform shell is part of the build.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const invoke = (script, args = []) => {
  const result = spawnSync(process.execPath, [script, ...args], {
    stdio: "inherit",
    windowsHide: true,
    shell: false,
  });
  if (result.error || result.status !== 0)
    throw result.error || new Error(script + " failed");
};
const action = process.argv[2];
if (action === "install") {
  const bin = path.dirname(process.execPath),
    candidates = [
      path.join(bin, "node_modules/npm/bin/npm-cli.js"),
      path.resolve(bin, "../lib/node_modules/npm/bin/npm-cli.js"),
    ];
  const npm = candidates.find((file) => fs.existsSync(file));
  if (!npm)
    throw new Error("npm CLI is missing from the developer Node installation");
  invoke(npm, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
  invoke("tools/vendor.mjs");
} else if (action === "test")
  invoke("tools/without-shells.mjs", ["tools/test.mjs"]);
else if (action === "build") {
  const preview = process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_EVENT_NAME === "push" && process.env.GITHUB_REF === "refs/heads/develop";
  let version = null;
  if (preview) {
    // The install action must run before loading modules that depend on vendor/.
    const { preview_number } = await import("./preview-number.mjs");
    const { read_source_manifest } = await import("./release_policy.mjs");
    version = `${read_source_manifest(process.cwd()).version}-preview.${preview_number()}`;
  }
  invoke("tools/without-shells.mjs", ["tools/package-plugin.mjs", ...(preview ? ["--preview", "true", "--version", version] : [])]);
  invoke("tools/check-plugin.mjs", [`.build/marketplace/plugins/${preview ? "1c-ai-core-preview" : "1c-ai-core"}`]);
  if (process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      "Node.js plugin and marketplace ZIPs verified. Publication follows successful release or develop builds and the complete smoke matrix.\n",
    );
} else if (action === "smoke") {
  const target = path.join(process.env.RUNNER_TEMP, "1c core smoke");
  invoke("tools/verify-package.mjs", [".build/download", target]);
  const name = JSON.parse(fs.readFileSync(path.join(target, ".agents/plugins/marketplace.json"), "utf8")).plugins[0].name;
  invoke("tools/check-plugin.mjs", [path.join(target, "plugins", name)]);
} else if (action === "publish")
  invoke("tools/publish-marketplace.mjs", [
    "--run-id",
    process.env.BUILD_RUN_ID,
    "--work",
    path.join(process.env.RUNNER_TEMP, "1c-ai-core-publication"),
  ]);
else throw new Error("Unknown CI action");
