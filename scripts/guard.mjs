import fs from "node:fs";
import path from "node:path";
import { inside, ConfigError, entrypoint, settings } from "./common.mjs";
import { project_profile } from "./profile.mjs";
import { locate_project, resolve, contained, state_root } from "./project_paths.mjs";
import { casefold } from "./casefold.mjs";
import { effective_settings } from "./project_context.mjs";
import { knowledge_gate } from "./knowledge.mjs";
export function* strings(value) {
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) {
    for (const child of value) yield* strings(child);
  } else if (value && typeof value === "object") {
    for (const child of Object.values(value)) yield* strings(child);
  }
}
const escapeRE = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const setupMethods = new Set([
  "create", "load", "import", "export", "select_profile", "forget_profile", "status", "refresh_readiness", "reset_connection", "open", "inspect", "probe_connections", "profile", "read", "pick_directory",
  "open_directory", "update", "preview", "apply", "export_data", "save_export", "open_export_directory", "export_diagnostics", "diagnostics",
  "open_diagnostics_directory", "edit", "document", "operation", "check", "run_check", "rebuild_index", "updates", "versions",
  "pick_java", "check_java", "pick_import_file", "import_file", "profile_source", "rename_profile", "repair_document",
]);
function setup_control(name) {
  const match = /^mcp__([A-Za-z0-9_-]+)__(.+)$/.exec(name);
  if (!match) return false;
  const server = match[1].replaceAll("_", "-"), method = match[2];
  if (server === "1c-ai-settings") {
    const settingsMethod = /^settings[._](.+)$/.exec(method);
    return Boolean(settingsMethod && setupMethods.has(settingsMethod[1]));
  }
  if (["edt", "v8std", "code-index", "bsl-ls"].includes(server))
    return ["core_runtime_status", "core_runtime_tools"].includes(method);
  if (server === "openviking") return ["knowledge_status", "knowledge_search", "knowledge_read"].includes(method);
  return server === "policy" && ["get_action_policy", "check_action"].includes(method);
}
export function reason(event, delegatedKnowledge = false) {
  if (/(?:^|__|\.)core_runtime_call$/.test(String(event.tool_name || ""))) {
    const args = event.tool_input;
    if (!args || !Array.isArray(args.calls) || !args.calls.length || args.calls.length > 16)
      return "Invalid native runtime call envelope";
    const ownedRelay = /^mcp__(?:edt|v8std|code[_-]index|bsl[_-]ls)__core_runtime_call$/.test(String(event.tool_name));
    for (const call of args.calls) {
      if (!call || typeof call.name !== "string" || !call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments) || call.name === "core_runtime_call")
        return "Invalid native runtime call envelope";
      // The owned relay checks its own knowledge connection before each call.
      const denied = reason({ ...event, tool_name: String(event.tool_name).replace(/core_runtime_call$/, call.name), tool_input: call.arguments }, ownedRelay);
      if (denied) return denied;
    }
    return null;
  }
  const cwd = resolve(
    event.cwd || process.env.EDT_AI_PROJECT_ROOT || process.cwd(),
  );
  let root;
  try {
    root = locate_project(cwd);
  } catch (error) {
    if (
      error instanceof ConfigError &&
      error.message.includes("No .ai/project.yaml")
    )
      return null;
    throw error;
  }
  const name = String(event.tool_name || "");
  const setupControl = setup_control(name);
  // Setup validates its own scope and must stay usable to repair a bad profile.
  if (setupControl) return null;
  const data = project_profile(root);
  const config = effective_settings(settings(process.env.EDT_AI_SETTINGS || path.join(state_root(), "settings.json")), root, data);
  const gate = knowledge_gate(data, config, "workflow");
  if (!gate.allowed && !delegatedKnowledge) return "Knowledge workflow blocked: " + gate.reason + ". Use the project-bound core_runtime_call for authority work; it verifies knowledge readiness before dispatch.";
  let args = event.tool_input || {};
  if (typeof args !== "object" || Array.isArray(args))
    args = { command: String(args) };
  const bare = name.split(".").at(-1),
    filesystem = new Set([
      "Bash",
      "bash",
      "shell",
      "exec_command",
      "exec",
      "apply_patch",
      "view_image",
      "Read",
      "Write",
      "Edit",
      "MultiEdit",
      "Glob",
      "Grep",
      "read_file",
      "write_file",
      "list_directory",
    ]);
  const indexed = /code[_-]index/i.test(name) && Object.hasOwn(args, "repo"),
    generic = filesystem.has(bare) || /filesystem.*__/i.test(name);
  if (!generic && !indexed) return null;
  if (indexed && !data.repositories.some((repo) => repo.alias === args.repo))
    return "code-index alias is outside the selected project profile";
  if (!generic) return null;
  const protectedPaths = [
    ...new Set([...data.roots.protected, ...data.roots.source]),
  ].map((file) => inside(root, file));
  const touches = (file, broad = false) => {
    file = resolve(file);
    return protectedPaths.some(
      (source) => contained(source, file) || (broad && contained(file, source)),
    );
  };
  const body = [...strings(args)].join("\n"),
    shell = ["Bash", "bash", "shell", "exec_command"].includes(bare);
  const patches = [
    ...body.matchAll(
      /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): ([^\r\n]+)/gm,
    ),
  ].map((match) => match[1]);
  const explicit = ["path", "file_path", "filename", "file", "directory", "uri", "source", "destination"]
    .map((key) => args[key])
    .filter((value) => typeof value === "string");
  if (Array.isArray(args.paths))
    explicit.push(...args.paths.filter((value) => typeof value === "string"));
  const inspected =
      shell || bare === "exec" ? body : [...patches, ...explicit].join("\n"),
    payload = casefold(inspected.replaceAll("\\", "/"));
  for (const source of protectedPaths) {
    if (payload.includes(casefold(source.replaceAll("\\", "/"))))
      return "Protected 1C source requires the assigned EDT/code-index authority";
    const relative = casefold(
      path.relative(root, source).replaceAll("\\", "/"),
    );
    if (
      new RegExp(
        "(?:^|[^\\p{L}\\p{N}_.-])(?:\\./)?" +
          escapeRE(relative) +
          "(?:/|$|[^\\p{L}\\p{N}_.-])",
        "u",
      ).test(payload)
    )
      return "Protected source path is not available to filesystem tools";
  }
  const workdir = args.workdir || args.cwd,
    base = workdir ? resolve(path.resolve(cwd, workdir)) : cwd;
  const paths = [
    ...explicit,
    ...patches,
    ...[
      ...inspected.matchAll(/(?:[A-Za-z]:[/\\]|\.\.?[/\\])[^\s"'`;|<>]+/g),
    ].map((match) => match[0]),
  ];
  const broad = ["Glob", "Grep", "list_directory", "list_directory_with_sizes", "search_files", "directory_tree", "move_file"].includes(bare.split("__").at(-1));
  for (const file of paths)
    if (
      touches(
        path.resolve(base, file),
        broad,
      )
    )
      return "Filesystem path resolves into protected source";
  if (
    broad &&
    !paths.length &&
    touches(base, true)
  )
    return "Discovery needs an explicit directory outside protected source";
  const command = String(args.cmd || args.command || "");
  if (
    bare === "exec" &&
    /exec_command|apply_patch|view_image|read_file|write_file/.test(payload)
  )
    return "Use an explicit scoped filesystem call; nested code cannot establish a safe source boundary";
  if (shell) {
    if (!workdir || touches(base, true))
      return "Shell requires an explicit directory outside protected source and its ancestors";
    if (
      /\b(cd|chdir|set-location|push-location|invoke-expression|iex)\b|(?:^|\s)(?:-enc(?:odedcommand)?|--cwd|-C)\b/i.test(
        command,
      )
    )
      return "Shell directory changes or opaque evaluation cannot establish the protected-source boundary";
  }
  return null;
}
export function guard(event) {
  let denied;
  try {
    denied = reason(event);
  } catch {
    denied =
      "1C routing guard could not validate the request/profile; repair the profile or Node.js setup";
  }
  return denied
    ? {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: denied,
        },
      }
    : {};
}
if (entrypoint(import.meta.url)) {
  try {
    console.log(JSON.stringify(guard(JSON.parse(fs.readFileSync(0, "utf8")))));
  } catch {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "1C routing guard could not parse this request",
        },
      }),
    );
  }
}
