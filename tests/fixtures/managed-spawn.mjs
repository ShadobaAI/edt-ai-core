import cp from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncBuiltinESMExports } from "node:module";
const original = cp.spawn;
cp.spawn = (command, args, options) => {
  const managed = args?.[0] && path.basename(args[0]) === "managed_mcp.mjs";
  // Test-only switches control the replacement fixture, never real runtimes.
  const fixtureOptions = managed ? { ...options, env: { ...options.env,
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith("FIXTURE_"))) } } : options;
  return original(command, managed ? [fileURLToPath(new URL("./managed-stdio.mjs", import.meta.url))] : args, fixtureOptions);
};
syncBuiltinESMExports();
