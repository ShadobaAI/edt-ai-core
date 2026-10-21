import fs from "node:fs";
import path from "node:path";
import { inside, ConfigError, entrypoint } from "./common.mjs";
import { project_profile } from "./profile.mjs";
import { locate_project, resolve, contained } from "./project_paths.mjs";
import { casefold } from "./casefold.mjs";
export function* strings(value) {
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) {
    for (const child of value) yield* strings(child);
  } else if (value && typeof value === "object") {
    for (const child of Object.values(value)) yield* strings(child);
  }
}
const escapeRE = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function reason(event) {
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
  const data = project_profile(root);
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
  const explicit = ["path", "file_path", "filename", "file", "directory", "uri"]
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
  for (const file of paths)
    if (
      touches(
        path.resolve(base, file),
        ["Glob", "Grep", "list_directory"].includes(bare),
      )
    )
      return "Filesystem path resolves into protected source";
  if (
    ["Glob", "Grep", "list_directory"].includes(bare) &&
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
