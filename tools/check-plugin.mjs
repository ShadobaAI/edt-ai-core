// Intentionally depends only on Node built-ins and the extracted plugin itself.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

async function check_worker(selected) {
  const root = fs.realpathSync(selected),
    json = (name) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
  const manifest = json(".codex-plugin/plugin.json"),
    universal = json("plugin.json"),
    build = json("build-info.json");
  const name = build.profile === "preview" ? "1c-ai-core-preview" : "1c-ai-core";
  for (const item of [manifest, universal]) {
    assert.equal(item.name, name);
    assert.equal(item.version, build.version);
  }
  assert.equal(build.plugin, name);
  assert.equal(manifest.interface.displayName, name === "1c-ai-core-preview" ? "1C AI Core Preview" : "1C AI Core");
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.mcpServers, "./mcp.json");
  assert.equal(manifest.hooks, "./hooks/hooks.json");
  for (const extension of [manifest, universal.extensions["com.openai"]]) {
    assert.equal(extension.requires_local_executor, true);
    assert.equal(extension.onboardingSkill, "./skills/edt-ai-core/SKILL.md");
    assert.ok(fs.existsSync(path.join(root, extension.onboardingSkill)));
  }
  for (const listing of [manifest.interface, universal.extensions["com.openai"].interface]) {
    assert.equal(listing.developerName, "ShadobaAI");
    for (const key of ["composerIcon", "logo"]) {
      assert.equal(listing[key], "./assets/icon.svg");
      assert.match(fs.readFileSync(path.join(root, listing[key]), "utf8"), /viewBox="0 0 64 64"/);
    }
  }
  assert.equal(universal.author.name, "ShadobaAI");
  const hooks = json("hooks/hooks.json");
  assert.match(hooks.hooks.SessionStart[0].hooks[0].command, /session-start\.mjs/);
  assert.equal(hooks.hooks.PreToolUse[0].matcher, ".*");
  assert.match(hooks.hooks.PreToolUse[0].hooks[0].command, /hooks\/guard\.mjs/);
  assert.match(
    fs.readFileSync(path.join(root, "LICENSE"), "utf8"),
    /^Mozilla Public License Version 2.0/,
  );
  assert.match(
    fs.readFileSync(path.join(root, "NOTICE.md"), "utf8"),
    /ShadobaAI/,
  );
  assert.match(fs.readFileSync(path.join(root, "UNICODE-LICENSE.txt"), "utf8"), /^UNICODE LICENSE V3/);
  assert.deepEqual(fs.readdirSync(path.join(root, "profiles")), ["generic-1c"]);
  assert.deepEqual(fs.readdirSync(path.join(root, "profiles/generic-1c")), ["profile.yaml"]);
  assert.deepEqual(fs.readdirSync(path.join(root, "knowledge")), ["recommended-manifest.yaml"]);
  assert.deepEqual(fs.readdirSync(path.join(root, "runtime")), ["runtime-manifest.yaml"]);
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
    // A hard link can stay locked by this still-running Node process on Windows.
    if (process.platform === "win32") {
      fs.copyFileSync(process.execPath, node);
    } else {
      try {
        fs.linkSync(process.execPath, node);
      } catch {
        fs.copyFileSync(process.execPath, node);
      }
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
    // Exercise the shipped knowledge schemas and containment validator through
    // the extracted, bundled runtime; no server or real knowledge is involved.
    const common = await import(pathToFileURL(path.join(root, "scripts/common.mjs")).href);
    const knowledge = await import(pathToFileURL(path.join(root, "scripts/knowledge.mjs")).href);
    const profiles = await import(pathToFileURL(path.join(root, "scripts/profile.mjs")).href);
    knowledge.validate_manifest(common.load(path.join(root, "knowledge/recommended-manifest.yaml")));
    const corpus = path.join(project, "knowledge"); fs.mkdirSync(corpus);
    const metadata = { schema_version: "0.1", kind: "document", id: "smoke", title: "Smoke fixture",
      provenance: { source: "https://example.org/source" }, scope: ["Isolated fixture"], revision: "edition-1",
      compatibility: { fixture: "1" }, status: "published" };
    const content = "---\n" + JSON.stringify(metadata) + "\n---\n# Fixture\n";
    fs.writeFileSync(path.join(corpus, "smoke.md"), content);
    const catalog = { schema_version: "0.1", kind: "catalog", provider: "openviking",
      collections: [{ id: "smoke", description: "Isolated fixture" }],
      materials: [{ id: "smoke", collection: "smoke", path: "smoke.md", sha256: createHash("sha256").update(content).digest("hex") }] };
    fs.writeFileSync(path.join(corpus, "catalog.json"), JSON.stringify(catalog));
    const candidate = common.parse(yaml);
    assert.equal(candidate.schema_version, "0.2");
    candidate.knowledge = { provider: "openviking", mode: "transitional", manifest: "knowledge/catalog.json",
      collections: ["smoke"], required: false, dependent_actions: [] };
    profiles.validate_at(project, candidate);
    const declared = knowledge.load_manifest(project, "knowledge/catalog.json", ["smoke"]);
    knowledge.validate_publication_receipt({ schema_version: "0.2", provider: "openviking",
      server: { endpoint: "https://example.org/mcp", scope: "fixture" }, collections: ["smoke"],
      publication_revision: "a".repeat(40), manifest_sha256: declared.sha256, index_revision: "fixture-1",
      collection_snapshots: [{ ...knowledge.publication_inventory(catalog, ["smoke"])[0], root: "viking://resources/fixture/smoke" }],
      verification: { git_manifest: "matched_committed_bytes", index_contents: "exact_active_manifest", excluded_materials: "absent",
        deleted_materials: "absent", changed_materials: "matched", delivery: "immutable_endpoint", deployment_id: "fixture-deployment" },
      verified_at: "2026-10-24T08:00:00Z", expires_at: "2026-10-25T08:00:00Z", evidence_ref: "https://example.org/publication" });
    const knowledgeSettings = common.load(path.join(root, "settings/defaults.json"));
    assert.equal(knowledge.knowledge_status(candidate, knowledgeSettings).state, "disabled");
    knowledgeSettings.mcp.optional.openviking.enabled = true;
    assert.equal(knowledge.knowledge_status(candidate, knowledgeSettings).state, "not_configured");
    knowledgeSettings.mcp.optional.openviking.url = "https://example.org/mcp";
    assert.equal(knowledge.knowledge_status(candidate, knowledgeSettings).state, "not_verified");
    knowledgeSettings.mcp.optional.openviking.enabled = false;
    assert.equal(knowledge.knowledge_status(candidate, knowledgeSettings).state, "disabled");
    assert.equal(knowledgeSettings.mcp.optional.openviking.url, "https://example.org/mcp");
    assert.throws(() => profiles.validate({ ...candidate, schema_version: "0.1" }), error => error.code === "UNSUPPORTED_CONTRACT_VERSION");
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
        const initialized = await client.initialize();
        assert.ok(initialized.serverInfo);
        assert.equal(name, name.toLowerCase());
        assert.equal(initialized.serverInfo.title, name);
        assert.equal(initialized.serverInfo.name, initialized.serverInfo.name.toLowerCase());
        const tools = (await client.request("tools/list")).tools;
        assert.ok(tools.length);
        if (name === "1c-ai-settings") {
          const app = tools.find(tool => tool.name === "settings.open");
          assert.equal(app.title, "Настройки");
          assert.deepEqual(app._meta["openai/ui"].entrypoints, [{ type: "global" }]);
          assert.equal(initialized.capabilities.extensions?.["openai/settings"], undefined);
          assert.equal(initialized.capabilities.experimental?.["openai/settings"], undefined);
          const discovery = await client.request("server/discover");
          assert.equal(discovery._meta["io.modelcontextprotocol/serverInfo"].title, name);
          assert.equal(discovery.capabilities.extensions?.["openai/settings"], undefined);
          assert.equal(tools.some(tool => ["settings.native_read", "settings.manage"].includes(tool.name)), false);
          assert.equal((await client.call(app.name, {})).structuredContent.navigation, "profiles");
          assert.deepEqual(tools.find(tool => tool.name === "settings.profile")._meta["openai/ui"].entrypoints, [{ type: "thread" }]);
          assert.ok(tools.some(tool => tool.name === "settings.inspect"));
          assert.ok(tools.some(tool => tool.name === "settings.probe_connections"));
          assert.deepEqual(tools.find(tool => tool.name === "settings.export_diagnostics")._meta.ui.visibility, ["app"]);
          // Packaging checks are noninteractive: validate collection and a
          // caller-selected destination without presenting an OS dialog.
          const journal = await client.call("settings.diagnostics", {});
          assert.equal(journal.structuredContent, undefined);
          const { support_bundle, save_support_bundle } = await import(pathToFileURL(path.join(root, "scripts/support_bundle.mjs")).href);
          const bundle = await support_bundle({ state: env.EDT_AI_STATE_DIR, configPath: env.EDT_AI_SETTINGS, selectedRoot: null });
          const support = save_support_bundle(env.EDT_AI_STATE_DIR, bundle, path.join(temp, "support.json"));
          assert.equal(JSON.parse(fs.readFileSync(support.path, "utf8")).format, "1c-ai-core-diagnostics");
          const resource = await client.request("resources/read", { uri: app._meta.ui.resourceUri });
          assert.deepEqual(resource.contents[0]._meta["openai/ui"].availableDisplayModes,["fullscreen"]);
          const before = (await client.call("settings.read", {}))
            .structuredContent;
          assert.equal(before.values.projectRoot, "");
          assert.equal(before.layout, undefined);
          for (const id of ["settings.select_profile", "settings.status", "settings.reset_connection"])
            assert.deepEqual(tools.find(tool => tool.name === id)._meta.ui.visibility, ["app"]);
          const inspected = (await client.call("settings.inspect", { projectRoot: project })).structuredContent;
          assert.equal(inspected.profile.status, "loaded");
          const selected = (await client.call("settings.select_profile", { projectRoot: project })).structuredContent;
          assert.equal(selected.viewOnly, false);
          const observed = (await client.call("settings.status", {})).structuredContent;
          assert.equal(observed.profileHistory[0].projectRoot, project);
          assert.ok(observed.summary.observedAt);
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
        if (name === "openviking")
          assert.equal((await client.call("knowledge_status", { projectRoot: project })).structuredContent.ready, false);
      } finally {
        await client.close();
      }
    }
    assert.deepEqual(
      JSON.parse(run("hooks/guard.mjs", [], JSON.stringify({ cwd: temp }))),
      {},
    );
    // Direct execution verifies the shipped guard, not host hook activation.
    const guarded = common.parse(yaml);
    guarded.roots.source = ["src"]; guarded.roots.protected = ["src"];
    fs.mkdirSync(path.join(project, "src"));
    common.dump(guarded, profile);
    const denied = JSON.parse(run("hooks/guard.mjs", [], JSON.stringify({
      cwd: project, tool_name: "Write", tool_input: { path: "src/Denied.bsl", content: "fixture" },
    })));
    assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
    assert.equal(fs.existsSync(path.join(project, "src/Denied.bsl")), false);
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
      sourceGuard: { registration: "verified", directExecution: "verified", hostActivation: "not_verified" },
    };
  } finally {
    // Windows may retain executable/stdio handles briefly after child close.
    await fs.promises.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
