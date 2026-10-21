// Runs entirely in Node; state belongs to the selected profile/session.
import fs from "node:fs";
import { guard } from "../scripts/guard.mjs";
try {
  console.log(JSON.stringify(guard(JSON.parse(fs.readFileSync(0, "utf8")))));
} catch {
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
