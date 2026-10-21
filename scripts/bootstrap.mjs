import path from "node:path";
import { argumentsOf } from "./common.mjs";
import { state_root } from "./project_paths.mjs";
const args = argumentsOf(
  undefined,
  ["backend", "direct"],
  ["component", "settings"],
);
process.env.EDT_AI_STATE_DIR ||= state_root();
process.env.EDT_AI_SETTINGS =
  args.settings ||
  process.env.EDT_AI_SETTINGS ||
  path.join(state_root(), "settings.json");
if (args.backend) {
  const { SettingsBackend } = await import("./settings_backend.mjs");
  try {
    let text = "";
    for await (const chunk of process.stdin) text += chunk;
    console.log(
      JSON.stringify({
        ok: true,
        result: await new SettingsBackend().main(JSON.parse(text)),
      }),
    );
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  }
} else if (args.component) {
  if (args.direct)
    process.exitCode = await (await import("./managed_mcp.mjs")).main();
  else await import("./lazy_mcp.mjs");
} else throw new Error("Missing service");
