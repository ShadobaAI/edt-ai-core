// Compatibility entrypoint for explicitly bound local Node installations.
import path from "node:path";
import { once } from "node:events";
import { ROOT, argumentsOf } from "./common.mjs";
import { launch, stop_child } from "./processes.mjs";
const args = argumentsOf(
  undefined,
  [],
  ["node", "component", "project_root", "state_dir", "settings"],
);
const forwarded = [];
for (const key of ["component", "project_root", "state_dir", "settings"])
  if (args[key]) forwarded.push("--" + key.replaceAll("_", "-"), args[key]);
const child = launch(
  args.node || process.execPath,
  [path.join(ROOT, "scripts/managed_mcp.mjs"), ...forwarded],
  { stdio: "inherit" },
);
try {
  const [code] = await once(child, "close");
  process.exitCode = code ?? 1;
} finally {
  await stop_child(child);
}
