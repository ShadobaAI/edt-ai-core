// Runs entirely in Node; state belongs to the selected profile/session.
import fs from "node:fs";
import { guard } from "../scripts/guard.mjs";
import { configure_hook_environment } from "../scripts/project_paths.mjs";
import { create_diagnostic_logger } from "../scripts/diagnostics.mjs";
let diagnostic;
try {
  configure_hook_environment();
  diagnostic = create_diagnostic_logger("guard");
  const input = JSON.parse(fs.readFileSync(0, "utf8")), result = guard(input);
  if (result.hookSpecificOutput?.permissionDecision === "deny") diagnostic.event("request_denied", {
    tool: input.tool_name, projectRoot: input.cwd, reason: result.hookSpecificOutput.permissionDecisionReason }, "warning");
  console.log(JSON.stringify(result));
} catch (error) {
  diagnostic?.event("guard_failed", { name: error.name, code: error.code }, "error");
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "1C routing guard could not parse or validate this request",
      },
    }),
  );
}
