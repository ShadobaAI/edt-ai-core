// Intentionally depends only on Node built-ins and the extracted plugin itself.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

async function check_worker(selected) {
  const root = fs.realpathSync(selected),
    json = (name) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
  const manifest = json(".codex-plugin/plugin.json"),
    universal = json("plugin.json"),
    build = json("build-info.json");
  for (const item of [manifest, universal]) {
    assert.equal(item.name, "1c-ai-core");
    assert.equal(item.version, build.version);
  }
  assert.equal(build.plugin, "1c-ai-core");
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.mcpServers, "./mcp.json");
  assert.equal(manifest.hooks, "./hooks/hooks.json");
  assert.match(
    fs.readFileSync(path.join(root, "LICENSE"), "utf8"),
    /^Mozilla Public License Version 2.0/,
  );
  assert.match(
    fs.readFileSync(path.join(root, "NOTICE.md"), "utf8"),
    /ShadobaAI/,
  );
  const source = fs.readFileSync(path.join(root, "SOURCE.md"), "utf8");
  assert.ok(source.includes(`1C AI Core ${build.version}`));
  if (build.revision) assert.ok(source.includes("/tree/" + build.revision));
  assert.ok(
    fs
      .readdirSync(path.join(root, "skills"))
      .filter((name) =>
        fs.existsSync(path.join(root, "skills", name, "SKILL.md")),
      ).length >= 10,
  );
  function scan(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      assert.ok(!entry.isSymbolicLink());
      assert.ok(
        ![
          "tests",
          "tools",
          "node_modules",
          ".git",
          ".venv",
          "__pycache__",
          "local.yaml",
          "runtime.local.json",
        ].includes(entry.name),
        entry.name,
      );
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) scan(file);
      else assert.ok(!/\.(py|pyc|ps1|sh)$/.test(entry.name), file);
    }
  }
  scan(root);
  assert.ok(fs.statSync(path.join(root, "vendor/deps.mjs")).size > 1000);
  assert.match(
    fs.readFileSync(path.join(root, "vendor/NOTICE.txt"), "utf8"),
    /yaml[\s\S]*ajv[\s\S]*fflate/,
  );
  const temp = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "1c core smoke Юникод ")),
  );
  try {
    const bin = path.join(temp, "bin");
    fs.mkdirSync(bin);
    const node = path.join(
      bin,
      process.platform === "win32" ? "node.exe" : "node",
    );
    try {
      fs.linkSync(process.execPath, node);
    } catch {
      fs.copyFileSync(process.execPath, node);
    }
    if (process.platform !== "win32") fs.chmodSync(node, 0o755);
    const preload = path.join(temp, "only-node.mjs"),
      trace = path.join(temp, "processes.jsonl");
    fs.writeFileSync(
      preload,
      `import cp from 'node:child_process'; import fs from 'node:fs'; import path from 'node:path'; import { syncBuiltinESMExports } from 'node:module';
for (const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync']) { const original = cp[name]; cp[name] = function(command, ...args) { const base = path.basename(String(command)).toLowerCase(); const options = args.find(value => value && typeof value === 'object' && !Array.isArray(value)) || {}; if (name === 'exec' || name === 'execSync' || options.shell || /^(python(?:[0-9.]+)?|py|powershell|pwsh|bash|sh)(?:\\.exe|\\.cmd)?$/.test(base)) throw new Error('Forbidden runtime: ' + command); fs.appendFileSync(process.env.CORE_PROCESS_TRACE, JSON.stringify({command, shell: !!options.shell}) + '\\n'); return original.call(this, command, ...args); }; } syncBuiltinESMExports();`,
    );
    const env = {
      ...process.env,
      PATH: bin,
      NODE_PATH: "",
      NODE_OPTIONS: "--import " + pathToFileURL(preload).href,
      CORE_PROCESS_TRACE: trace,
      EDT_AI_STATE_DIR: path.join(temp, "state"),
      EDT_AI_SETTINGS: path.join(temp, "state/settings.json"),
      EDT_AI_PROJECT_ROOT: "",
    };
    delete env.EDT_AI_CONNECTIONS_FILE;
    delete env.EDT_AI_EDT_URL;
    delete env.EDT_AI_V8STD_URL;
    const run = (file, args = [], input) => {
      const result = spawnSync(node, [path.join(root, file), ...args], {
        cwd: temp,
        env,
        input,
        encoding: "utf8",
        windowsHide: true,
        shell: false,
        timeout: 20000,
      });
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return result.stdout;
    };
    const project = path.join(temp, "project with spaces");
    fs.mkdirSync(project);
    run("scripts/profile.mjs", ["init", project]);
    run("scripts/profile.mjs", [
      "export",
      project,
      "--output",
      path.join(temp, "profile.yaml"),
    ]);
    run("scripts/profile.mjs", ["validate", path.join(temp, "profile.yaml")]);
    run("scripts/profile.mjs", [
      "configure-instance",
      project,
      "--edt-url",
      "http://127.0.0.1:18765/mcp",
    ]);
    const profile = path.join(project, ".ai/project.yaml");
    let yaml = fs.readFileSync(profile, "utf8");
    // Import through the real settings stdio server exercises bundled YAML/Ajv.
    const { McpClient } = await import(
      pathToFileURL(path.join(root, "scripts/mcp_client.mjs")).href
    );
    for (const [name, entry] of Object.entries(json("mcp.json").mcpServers)) {
      assert.equal(entry.command, "node");
      const args = entry.args.map((arg) =>
        arg.replaceAll("${PLUGIN_ROOT}", root),
      );
      for (const arg of args)
        if (arg.includes(root)) assert.ok(fs.statSync(arg).isFile());
      const client = new McpClient([node, ...args], temp, env, 20);
      client.roots = [];
      try {
        assert.ok((await client.initialize()).serverInfo);
        const tools = (await client.request("tools/list")).tools;
        assert.ok(tools.length);
        if (name === "1c-ai-settings") {
          const before = (await client.call("settings.read", {}))
            .structuredContent;
          assert.equal(before.values.projectRoot, "");
          const preview = (
            await client.call("settings.preview", {
              text: yaml,
              projectRoot: project,
            })
          ).structuredContent;
          await client.call("settings.apply", {
            text: yaml,
            projectRoot: project,
            revision: preview.revision,
            replace: true,
          });
          assert.equal(
            (await client.call("settings.read", {})).structuredContent.values
              .projectRoot,
            project,
          );
          assert.ok(
            (
              await client.call("settings.export_data", {})
            )._meta.data.text.includes("1c-ai-core-settings"),
          );
        }
        if (["edt", "v8std", "code-index", "bsl-ls"].includes(name))
          assert.equal(
            (await client.call("core_runtime_status", {})).structuredContent
              .ready,
            false,
          );
      } finally {
        await client.close();
      }
    }
    assert.deepEqual(
      JSON.parse(run("hooks/guard.mjs", [], JSON.stringify({ cwd: temp }))),
      {},
    );
    assert.ok(!fs.existsSync(path.join(env.EDT_AI_STATE_DIR, "python")));
    const processes = fs.existsSync(trace)
      ? fs
          .readFileSync(trace, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
    assert.ok(processes.length > 0);
    assert.ok(
      processes.every(
        (item) =>
          !item.shell && /^node(?:\.exe)?$/i.test(path.basename(item.command)),
      ),
    );
    console.log(
      `Extracted plugin verified without Python/PowerShell/Bash/npm: ${root} (${processes.length} supervised Node launches)`,
    );
    return {
      root,
      supervisedLaunches: processes.length,
      runtime: "node-only",
      liveExternal: "not_verified",
    };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
export async function check(selected) {
  // Native addons remain mapped until process exit on Windows. Isolate the
  // extracted package so the caller can remove its temporary directory safely.
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), selected, "--worker"],
    { encoding: "utf8", windowsHide: true, shell: false, timeout: 60000 },
  );
  if (result.error || result.status !== 0)
    throw result.error || new Error(result.stdout + result.stderr);
  const marker = result.stdout
    .split("\n")
    .find((line) => line.startsWith("CORE_CHECK_RESULT:"));
  if (!marker) throw new Error("Package smoke returned no result");
  process.stdout.write(
    result.stdout
      .split("\n")
      .filter((line) => !line.startsWith("CORE_CHECK_RESULT:"))
      .join("\n"),
  );
  return JSON.parse(marker.slice("CORE_CHECK_RESULT:".length));
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv[3] === "--worker")
      console.log(
        "CORE_CHECK_RESULT:" +
          JSON.stringify(await check_worker(process.argv[2])),
      );
    else await check(process.argv[2]);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
