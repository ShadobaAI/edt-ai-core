import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deny = message => process.stdout.write(JSON.stringify({ hookSpecificOutput: {
  hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: message } }) + "\n");
try {
  const input = fs.readFileSync(0, "utf8");
  const event = JSON.parse(input);
  let directory = path.resolve(event.cwd || process.env.EDT_AI_PROJECT_ROOT || process.cwd()), found = false;
  while (true) {
    if (fs.existsSync(path.join(directory, ".ai/project.yaml"))) { found = true; break; }
    if (fs.existsSync(path.join(directory, ".git")) || path.dirname(directory) === directory) break;
    directory = path.dirname(directory);
  }
  if (!found) process.stdout.write("{}\n");
  else {
    const bindingFile = path.join(root, "hooks/runtime.local.json");
    const binding = fs.existsSync(bindingFile) ? JSON.parse(fs.readFileSync(bindingFile, "utf8")) : {};
    for (const key of ["python", "state", "settings"]) if (binding[key] !== undefined &&
        (typeof binding[key] !== "string" || !path.isAbsolute(binding[key]))) throw new Error("invalid installed hook binding");
    const state = process.env.EDT_AI_STATE_DIR || binding.state || path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "1c-ai-core");
    const prepared = path.join(state, "python", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    const python = process.env.EDT_AI_PYTHON || binding.python || (fs.existsSync(prepared) ? prepared : "python");
    const result = spawnSync(python, [path.join(root, "scripts/guard.py")], { input, encoding: "utf8", windowsHide: true, timeout: 4000, maxBuffer: 65536,
      env: { ...process.env, EDT_AI_STATE_DIR: state, EDT_AI_SETTINGS: process.env.EDT_AI_SETTINGS || binding.settings || path.join(state, "settings.json") } });
    if (result.status !== 0 || result.error) deny("1C routing guard is unavailable; prepare the plugin Python environment before source operations");
    else {
      JSON.parse(result.stdout);
      process.stdout.write(result.stdout);
    }
  }
} catch { deny("1C routing guard could not parse or validate this request"); }
