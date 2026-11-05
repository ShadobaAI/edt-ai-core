// No shell/glob expansion; identical invocation on Windows, Linux and macOS.
import fs from "node:fs";
import { run_tests } from "./test-runner.mjs";

const files = fs
  .readdirSync("tests")
  .filter(
    (file) => /^test[-_].*\.mjs$/.test(file) && !file.endsWith("-fixtures.mjs"),
  )
  .sort()
  .map((file) => "tests/" + file);
process.exitCode = await run_tests(files);
