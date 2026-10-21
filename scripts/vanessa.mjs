import fs from "node:fs";
import path from "node:path";
import {
  ROOT,
  ConfigError,
  cli,
  inside,
  settings,
  check_schema,
  stable,
  argumentsOf,
  entrypoint,
} from "./common.mjs";
import {
  locate_project,
  resolve,
  contained,
  sha256,
} from "./project_paths.mjs";
import { project_profile } from "./profile.mjs";
import { binding } from "./policy_runtime.mjs";
import { McpClient } from "./mcp_client.mjs";
import { spawn } from "node:child_process";
import { once } from "node:events";
export function runtime_profile(selected, with_digest = false) {
  const root = locate_project(selected),
    data = project_profile(root);
  if (!data.testing.vanessa)
    throw new ConfigError("Vanessa is disabled in this project profile");
  const config = data.testing.vanessa_config,
    file = inside(root, config.runtime_profile);
  if (fs.statSync(file).size > 65536)
    throw new ConfigError("Vanessa runtime profile exceeds the 64 KiB limit");
  const payload = fs.readFileSync(file),
    raw = JSON.parse(payload.toString("utf8").replace(/^\uFEFF/, ""));
  check_schema(raw, "vanessa-runtime.schema.json");
  for (const [key, expected] of [
    ["projectRoot", root],
    ["features", inside(root, config.features)],
    ["results", inside(root, config.results)],
  ])
    if (resolve(path.resolve(path.dirname(file), raw[key])) !== expected)
      throw new ConfigError(
        `Vanessa local runtime ${key} differs from the project binding`,
      );
  if ((raw.mcp.serverName || "vanessa") !== config.server_name)
    throw new ConfigError(
      "Vanessa MCP server name differs from the project binding",
    );
  const result = [root, data, config, file, raw];
  return with_digest ? [...result, sha256(payload)] : result;
}
export async function main() {
  const a = argumentsOf(
      undefined,
      ["editor_transition"],
      [
        "project_root",
        "settings",
        "feature",
        "scenario",
        "tool",
        "arguments_file",
        "authorization_file",
        "for_action",
      ],
    ),
    command = a._[0];
  if (
    ![
      "describe",
      "configure",
      "doctor",
      "list",
      "start",
      "setup",
      "connect",
      "call",
      "run",
    ].includes(command)
  )
    throw new ConfigError("Unknown Vanessa command");
  const [root, data, config, file, raw, runtimeHash] = runtime_profile(
      a.project_root,
      true,
    ),
    action = command === "describe" ? a.for_action || "run" : command;
  const infobase = (value) =>
    value.type === "file"
      ? {
          ...value,
          path: resolve(path.resolve(path.dirname(file), value.path)),
        }
      : value;
  if (action === "run") {
    if (!a.feature || !a.scenario?.trim())
      throw new ConfigError("Run requires an exact feature and scenario");
    const feature = path.isAbsolute(a.feature)
      ? resolve(a.feature)
      : inside(root, a.feature);
    if (
      path.extname(feature).toLowerCase() !== ".feature" ||
      !contained(root, feature)
    )
      throw new ConfigError(
        "Feature must remain inside projectRoot or configured features",
      );
  }
  let argumentsHash = null,
    argumentsFile = null;
  if (a.arguments_file) {
    argumentsFile = resolve(a.arguments_file);
    if (fs.statSync(argumentsFile).size > 1024 * 1024)
      throw new ConfigError("Tool arguments exceed the 1 MiB limit");
    argumentsHash = sha256(fs.readFileSync(argumentsFile));
  }
  const scope = stable({
    project: data.project.id,
    repository: config.repository_id,
    projectRoot: root,
    runtimeProfile: resolve(file),
    manager: infobase(raw.manager.infobase),
    client: infobase(raw.client.infobase),
    runtime: runtimeHash,
    command: action,
    feature: a.feature || null,
    scenario: a.scenario || null,
    tool: a.tool || null,
    argumentsHash,
  });
  const effects =
    {
      start: ["launch"],
      setup: ["launch", "database"],
      connect: ["launch", "database"],
      run: ["database"],
    }[action] || [];
  if (command === "describe") {
    console.log(JSON.stringify({ scope, effects, runtimeProfile: file }));
    return 0;
  }
  let request = { effects, scope, authorizations: [] };
  if (a.authorization_file) {
    request = JSON.parse(
      fs.readFileSync(a.authorization_file, "utf8").replace(/^\uFEFF/, ""),
    );
    if (
      request.scope !== scope ||
      effects.some((effect) => !request.effects?.includes(effect))
    )
      throw new ConfigError(
        "Authorization scope/effects differ from the intended Vanessa action",
      );
  }
  if (command === "call" && !a.authorization_file)
    throw new ConfigError(
      "Generic call needs an explicit effects/authorization record based on the live tool contract",
    );
  const entry = binding(settings(a.settings)),
    client = new McpClient([entry.command, ...entry.args], ROOT);
  let assessment;
  try {
    await client.initialize();
    assessment = (await client.call("check_action", request)).structuredContent;
  } finally {
    await client.close();
  }
  if (assessment.status !== "within_declared_scope")
    throw new ConfigError(
      "Actual user agreement required for: " + assessment.missing.join(", "),
    );
  const args = [
    path.join(ROOT, "vanessa/vanessa.mjs"),
    command,
    "--profile",
    file,
    "--expected-profile-sha256",
    runtimeHash,
  ];
  for (const key of ["feature", "scenario", "tool"])
    if (a[key]) args.push("--" + key, a[key]);
  if (argumentsFile)
    args.push(
      "--arguments-file",
      argumentsFile,
      "--expected-arguments-sha256",
      argumentsHash,
    );
  if (a.editor_transition) args.push("--editor-transition");
  const child = spawn(entry.command, args, {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
    shell: false,
  });
  const [code] = await once(child, "close");
  return code ?? 1;
}
if (entrypoint(import.meta.url)) await cli(main);
