// Inject the existing JVM fixture in the process that launches the BSL proxy.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
const spawn = childProcess.spawn;
const proxy = fileURLToPath(new URL("../../mcp/bsl-ls-proxy.mjs", import.meta.url));
childProcess.spawn = (command, args, options) => spawn(command,
  args[0] === proxy ? ["--import", new URL("./bsl-spawn.mjs", import.meta.url).href, ...args] : args,
  args[0] === proxy ? { ...options, env: { ...options.env,
    BSL_TEST_MODE: process.env.BSL_TEST_MODE, BSL_TEST_HANG: process.env.BSL_TEST_HANG, BSL_TEST_PID_FILE: process.env.BSL_TEST_PID_FILE,
  } } : options);
syncBuiltinESMExports();
