// Intercept only the JVM launch in transport tests; production has no test API.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
const spawn = childProcess.spawn;
childProcess.spawn = (_command, args, options) => spawn(process.execPath,
  [fileURLToPath(new URL("./bsl-server.mjs", import.meta.url))], {
    ...options, env: { ...process.env, BSL_TEST_ARGS: JSON.stringify(args) },
  });
syncBuiltinESMExports();
