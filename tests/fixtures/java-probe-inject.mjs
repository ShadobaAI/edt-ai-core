import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

// Insert the fixture inside the supervisor, so the real process containment
// and its inherited handles are exercised on the host OS.
const spawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => args.length === 1 && args[0] === "-version"
  ? spawn(process.execPath, [fileURLToPath(new URL("./java-probe.mjs", import.meta.url))], {
      ...options, env: { ...options.env, JAVA_PROBE_TEST_MODE: process.env.JAVA_PROBE_TEST_MODE,
        JAVA_PROBE_TEST_PIDS: process.env.JAVA_PROBE_TEST_PIDS },
    })
  : spawn(command, args, options);
syncBuiltinESMExports();
