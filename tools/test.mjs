// No shell/glob expansion; identical invocation on Windows, Linux and macOS.
import fs from "node:fs";
import { spawnSync } from "node:child_process";
const files = fs
  .readdirSync("tests")
  .filter(
    (file) => /^test[-_].*\.mjs$/.test(file) && !file.endsWith("-fixtures.mjs"),
  )
  .sort()
  .map((file) => "tests/" + file);
const result = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit",
  windowsHide: true,
  shell: false,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
