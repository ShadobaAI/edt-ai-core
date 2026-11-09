import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const installed = name => path.join(root, "node_modules", ...name.split("/"), "package.json");

test("CI installs build dependencies without local development tools", {
  skip: process.env.GITHUB_ACTIONS !== "true" && "requires the CI installation",
}, () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  for (const name of Object.keys(manifest.dependencies))
    assert.ok(fs.existsSync(installed(name)), `CI dependency is missing: ${name}`);
  for (const name of Object.keys(manifest.devDependencies))
    assert.ok(!fs.existsSync(installed(name)), `Local development tool is installed in CI: ${name}`);
});
