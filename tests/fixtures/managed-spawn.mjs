import cp from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncBuiltinESMExports } from "node:module";
const original = cp.spawn;
cp.spawn = (command, args, options) =>
  original(
    command,
    args?.[0] && path.basename(args[0]) === "managed_mcp.mjs"
      ? [fileURLToPath(new URL("./managed-stdio.mjs", import.meta.url))]
      : args,
    options,
  );
syncBuiltinESMExports();
