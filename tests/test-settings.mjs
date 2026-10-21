import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { fixture, environment, session, node, success, ROOT } from "./helpers.mjs";
import { dump, load, settings, sleep } from "../scripts/common.mjs";
import {
  SettingsBackend,
  authorize_preparation,
  preparation_scope,
} from "../scripts/settings_backend.mjs";
import { instance_file } from "../scripts/project_context.mjs";
import { McpClient } from "../scripts/mcp_client.mjs";
import { reconnect_file } from "../scripts/project_paths.mjs";

test("settings use the chat launch directory before a profile exists without host roots", async (t) => {
  const f = fixture(t), sub = path.join(f.root, "src");
  fs.mkdirSync(path.join(f.root, ".git"));
  // A saved selection from a different chat must not override the launch cwd.
  dump({ active_project: f.base }, f.env.EDT_AI_SETTINGS);
  const client = new McpClient([process.execPath, path.join(ROOT, "mcp/settings.mjs")], sub, { ...f.env, EDT_AI_PROJECT_ROOT: "" }, 10);
  f.clients.push(client);
  await client.request("initialize", { protocolVersion: "2025-11-25", capabilities: {} });
  const profile = (await client.call("settings.profile", {})).structuredContent;
  assert.equal(profile.values.projectRoot, f.root);
  assert.equal(profile.profile.status, "missing");
  const view = (await client.call("settings.read", {})).structuredContent;
  assert.equal(view.schema.properties.projectRoot.readOnly, true);
  assert.equal(view.preparationScope, f.root + "#first");
  assert.equal(fs.existsSync(path.join(f.root, ".ai")), false);
  await assert.rejects(client.call("settings.pick_directory", {}), /закреплён/);
  assert.equal((await client.call("settings.create", {})).structuredContent.profile.status, "loaded");
});

test("unsupported roots fall back to cwd but the plugin install directory is never a chat project", async (t) => {
  const f = fixture(t);
  for (const directory of [f.root, ROOT]) {
    const client = new McpClient([process.execPath, path.join(ROOT, "mcp/settings.mjs")], directory, { ...f.env, EDT_AI_PROJECT_ROOT: "" }, 10);
    f.clients.push(client);
    const send = client.send.bind(client);
    client.send = message => send(message.result?.roots ? { id: message.id, error: { code: -32601, message: "Not supported" } } : message);
    await client.initialize();
    const view = (await client.call("settings.read", {})).structuredContent;
    assert.equal(view.values.projectRoot, directory === ROOT ? "" : f.root);
    assert.equal(view.projectSelection.status, directory === ROOT ? "unselected" : "selected");
  }
});

test("the directory picker binds the canonical project without writes and discards a choice after host roots change", async (t) => {
  const f = fixture(t), plugin = path.join(f.base, "plugin"), choice = path.join(f.base, "choice.json"),
    started = path.join(f.base, "started"), released = path.join(f.base, "released"), other = path.join(f.base, "other");
  fs.mkdirSync(path.join(f.root, ".git")); fs.mkdirSync(other);
  for (const directory of ["mcp", "scripts", "assets"]) fs.mkdirSync(path.join(plugin, directory), { recursive: true });
  for (const file of ["plugin.json", "mcp/settings.mjs", "mcp/settings-operations.mjs", "scripts/icons.mjs", "scripts/selection.mjs", "scripts/project_paths.mjs", "scripts/casefold.mjs", "scripts/compatibility.mjs", "assets/icon.svg"])
    fs.copyFileSync(path.join(ROOT, file), path.join(plugin, file));
  fs.writeFileSync(path.join(plugin, "scripts/settings_folder.mjs"),
    `import fs from 'node:fs'; export async function folder_action() { const value=JSON.parse(fs.readFileSync(${JSON.stringify(choice)},'utf8')); if(value.wait) { fs.writeFileSync(${JSON.stringify(started)},''); while(!fs.existsSync(${JSON.stringify(released)})) await new Promise(done=>setTimeout(done,5)); } return value.directory; }`);
  fs.writeFileSync(path.join(plugin, "scripts/settings_backend.mjs"),
    `import { SettingsBackend } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "scripts/settings_backend.mjs")).href)}; let input=''; for await (const chunk of process.stdin) input+=chunk; try { console.log(JSON.stringify({ok:true,result:await new SettingsBackend().main(JSON.parse(input))})); } catch(error) { console.log(JSON.stringify({ok:false,error:error.message})); process.exitCode=1; }`);
  const client = new McpClient([process.execPath, path.join(plugin, "mcp/settings.mjs")], plugin, { ...f.env, EDT_AI_PROJECT_ROOT: "" }, 10);
  f.clients.push(client); client.roots = []; await client.initialize();
  async function finishedPicker() {
    const started = (await client.call("settings.pick_directory", {})).structuredContent;
    assert.equal(started.status, "running");
    return finishOperation(started.id);
  }
  async function finishOperation(id) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const job = (await client.call("settings.operation", { operationId: id })).structuredContent;
      if (job.status !== "running") return job;
      await sleep(5);
    }
    assert.fail("directory operation did not finish");
  }
  fs.writeFileSync(choice, JSON.stringify({ directory: path.join(f.root, "src") }));
  const selection = await finishedPicker();
  assert.equal(selection.status, "completed");
  const picked = (await client.call("settings.read", {})).structuredContent;
  assert.equal(picked.values.projectRoot, f.root);
  assert.equal(picked.profile.status, "missing");
  assert.equal(picked.projectSelection.locked, false);
  assert.equal(fs.existsSync(path.join(f.root, ".ai")), false);
  assert.deepEqual(fs.readdirSync(f.state), []);
  fs.writeFileSync(choice, JSON.stringify({ directory: null }));
  assert.equal((await finishedPicker()).result.cancelled, true);
  assert.equal((await client.call("settings.read", {})).structuredContent.values.projectRoot, f.root);
  fs.writeFileSync(choice, JSON.stringify({ directory: f.root, wait: true }));
  const pending = (await client.call("settings.pick_directory", {})).structuredContent;
  assert.equal(pending.status, "running");
  const deadline = Date.now() + 2000;
  while (!fs.existsSync(started) && Date.now() < deadline) await sleep(5);
  assert.ok(fs.existsSync(started));
  const progress = (await client.call("settings.operation", {})).structuredContent;
  assert.equal(progress.id, pending.id);
  assert.equal(progress.action, "pick_directory");
  assert.equal(progress.status, "running");
  assert.equal((await client.call("settings.read", {})).structuredContent.operation.id, pending.id);
  await assert.rejects(client.call("settings.update", { set: { projectRoot: other } }), /завершения выбора/);
  await assert.rejects(client.call("settings.run_check", { authorization: { scope: f.root + "#first", effects: ["launch"], evidence: "fixture" } }), /завершения выбора/);
  client.roots = [{ uri: pathToFileURL(other).href }]; client.notify("notifications/roots/list_changed");
  assert.equal((await client.call("settings.read", {})).structuredContent.values.projectRoot, other);
  fs.writeFileSync(released, "");
  const discarded = await finishOperation(pending.id);
  assert.equal(discarded.status, "failed");
  assert.match(discarded.error, /изменилась во время выбора/);
  assert.equal((await client.call("settings.read", {})).structuredContent.values.projectRoot, other);
});

test("chat profile tools discover the selected profile and preserve instructions/instance overrides", async (t) => {
  const f = fixture(t), client = await session(t, "mcp/settings.mjs", [], f);
  const catalogue = (await client.request("tools/list")).tools;
  for (const name of ["settings.profile", "settings.create", "settings.load", "settings.import", "settings.export", "settings.read", "settings.update", "settings.preview", "settings.apply", "settings.export_data", "settings.run_check", "settings.operation"]) {
    assert.ok(catalogue.find(tool => tool.name === name)._meta.ui.visibility.includes("model"));
  }
  const initial = await client.call("settings.read", {});
  assert.deepEqual(JSON.parse(initial.content[0].text), initial.structuredContent);
  assert.equal((await client.call("settings.profile", {})).structuredContent.profile.status, "missing");
  assert.ok(!fs.existsSync(path.join(f.root, ".ai")));
  fs.writeFileSync(path.join(f.root, "AGENTS.md"), "Existing project rules\n");
  await client.call("settings.update", { set: { edtUrl: "http://localhost:18111/mcp" } });
  const created = (await client.call("settings.create", {})).structuredContent;
  assert.equal(created.profile.status, "loaded");
  assert.equal(created.values.edtUrl, "http://localhost:18111/mcp");
  assert.match(created.sessionGuidance, /новый чат/);
  assert.equal(fs.readFileSync(path.join(f.root, "AGENTS.md"), "utf8"), "Existing project rules\n");
  assert.equal(fs.existsSync(f.env.EDT_AI_SETTINGS), false);
  const profileFile = path.join(f.root, ".ai/project.yaml"), before = fs.readFileSync(profileFile);
  await assert.rejects(client.call("settings.create", {}), /already exists/);
  assert.deepEqual(fs.readFileSync(profileFile), before);
  const token = path.join(f.state, "projects");
  assert.ok(fs.existsSync(token));
  const loaded = (await client.call("settings.load", {})).structuredContent;
  assert.equal(loaded.reload, "requested");
  assert.equal(loaded.readiness, "not_checked");
  assert.deepEqual(fs.readFileSync(profileFile), before);
  const other = path.join(f.base, "other"); fs.mkdirSync(other);
  for (const name of ["settings.load", "settings.create"])
    await assert.rejects(client.call(name, { projectRoot: other }), /текущим чатом/);
  assert.ok(!fs.existsSync(path.join(other, ".ai")));
});

test("existing and invalid profiles are visible without importing or starting services", async (t) => {
  const f = fixture(t); f.save();
  const before = fs.readFileSync(path.join(f.root, ".ai/project.yaml"));
  const client = await session(t, "mcp/settings.mjs", [], f);
  const profile = (await client.call("settings.profile", {})).structuredContent;
  assert.equal(profile.profile.status, "loaded");
  assert.equal(profile.values.projectRoot, f.root);
  assert.deepEqual(fs.readFileSync(path.join(f.root, ".ai/project.yaml")), before);
  assert.equal(fs.existsSync(path.join(f.state, "runtime-lock.json")), false);
  fs.writeFileSync(path.join(f.root, ".ai/project.yaml"), "invalid");
  assert.equal((await client.call("settings.read", {})).structuredContent.profile.status, "invalid");
  await assert.rejects(client.call("settings.load", {}));
  assert.equal(fs.readFileSync(path.join(f.root, ".ai/project.yaml"), "utf8"), "invalid");
});

test("profile reload signals only the selected instance", async (t) => {
  const f = fixture(t); environment(t, f.env); f.save();
  const first = reconnect_file(f.state, f.root);
  const second = path.join(path.dirname(first), "second.reconnect.json");
  fs.mkdirSync(path.dirname(second), { recursive: true });fs.writeFileSync(second, '{"id":"unchanged"}');
  const client = await session(t, "mcp/settings.mjs", [], f);
  await client.call("settings.load", {});
  assert.ok(JSON.parse(fs.readFileSync(first, "utf8")).id);
  assert.equal(fs.readFileSync(second, "utf8"), '{"id":"unchanged"}');
});

test("SessionStart discovers profile data without writes and stops at nested Git boundaries", (t) => {
  const f = fixture(t); f.save();
  const sub = path.join(f.root, "docs");fs.mkdirSync(sub);
  const run = (cwd, env = { ...f.env, EDT_AI_PROJECT_ROOT: "" }) => success(node("hooks/session-start.mjs", [], { env, input: JSON.stringify({ cwd, source: "startup" }) })).hookSpecificOutput.additionalContext;
  assert.match(run(sub), /"status":"loaded"/);
  assert.ok(!fs.existsSync(f.env.EDT_AI_SETTINGS));
  fs.mkdirSync(path.join(sub, ".git"));
  assert.match(run(sub), /"status":"missing"/);
  assert.match(run(sub, f.env), /"status":"loaded"/);
  assert.deepEqual(fs.readdirSync(f.state), []);
});

test("exported JSON settings import into another repository and keep local overrides private", async (t) => {
  const f = fixture(t); environment(t, f.env); f.save();
  const backend = new SettingsBackend(f.state, f.env.EDT_AI_SETTINGS);
  await backend.main({ action: "update", set: { edtUrl: "http://localhost:18112/mcp" } });
  const exported = await backend.main({ action: "export" });
  const other = path.join(f.base, "destination");fs.mkdirSync(other);fs.mkdirSync(path.join(other, "src"));
  process.env.EDT_AI_PROJECT_ROOT = other;
  const request = { text: exported.text }, preview = await backend.main({ action: "preview", ...request });
  assert.equal(preview.projectRoot, other);
  assert.ok(!preview.connectionUrls.edt);
  await backend.main({ action: "apply", ...request, revision: preview.revision });
  assert.deepEqual(load(path.join(other, ".ai/project.yaml")), f.profile);
  assert.equal((await backend.main({ action: "read" })).values.edtUrl, "");
});

test("native settings discovery negotiates legacy sessions and refuses stateless calls before configuration", async (t) => {
  const f = fixture(t),
    client = await session(t, "mcp/settings.mjs", [], f);
  const read = (await client.call("settings.read", {})).structuredContent;
  assert.equal(read.values.projectRoot, f.root);
  assert.equal(read.preparationScope, f.root + "#first");
  assert.equal(read.schema.properties.projectRoot.readOnly, true);
  const discovery = await client.request("server/discover");
  assert.ok(discovery.capabilities.extensions["openai/settings"]);
  const modernProbe = await client.request("server/discover", {
      _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
    });
  assert.equal(modernProbe.resultType, "complete");
  assert.ok(modernProbe.supportedVersions.includes("2025-11-25"));
  await assert.rejects(
    client.request("tools/list", { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } }),
    /initialize handshake/,
  );
  for (const component of ["edt", "v8std", "code-index", "bsl-ls"]) {
    const other = await session(
      t,
      "scripts/lazy_mcp.mjs",
      ["--component", component],
      f,
    );
    assert.equal(
      (await other.call("core_runtime_status", {})).structuredContent.ready,
      false,
    );
  }
  assert.ok(!fs.existsSync(path.join(f.state, "settings.json")));
});
test("native settings open their manual App without a chat or selected project", async (t) => {
  const f = fixture(t);
  const client = new McpClient([process.execPath, path.join(ROOT, "mcp/settings.mjs")], ROOT, { ...f.env, EDT_AI_PROJECT_ROOT: "" }, 10);
  f.clients.push(client);
  const discovery = await client.request("server/discover", { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } });
  assert.equal(discovery.resultType, "complete");
  await client.request("initialize", { protocolVersion: discovery.supportedVersions[0], capabilities: {} });
  const capability = discovery.capabilities.extensions["openai/settings"];
  const read = (await client.call(capability.readTool, {})).structuredContent;
  assert.equal(read.values.projectRoot, "");
  assert.ok(read.layout.flatMap(group => group.items).some(item => item.tool === "settings.open"));
  const tools = (await client.request("tools/list")).tools;
  const action = tools.find(tool => tool.name === "settings.open");
  assert.deepEqual(action.inputSchema.properties, {});
  const opened = (await client.call(action.name, {})).structuredContent;
  assert.equal(opened.mode, "profile");
  const resource = await client.request("resources/read", { uri: action._meta.ui.resourceUri });
  assert.match(resource.contents[0].text, /id="editSettingsButton"/);
  assert.deepEqual(fs.readdirSync(f.state), []);
});

test("manual editing resets removed runtime fields and preserves the unchanged profile bytes", async (t) => {
  const f = fixture(t); environment(t, f.env); f.save();
  const profilePath = path.join(f.root, ".ai/project.yaml");
  fs.writeFileSync(profilePath, "# Keep project explanation\n" + fs.readFileSync(profilePath, "utf8"));
  dump({ mcp: { managed: { "bsl-ls": { java: "old-java", node: "old-node", configuration: "old.json" } } } }, f.env.EDT_AI_SETTINGS);
  const client = await session(t, "mcp/settings.mjs", [], f);
  await client.call("settings.update", { set: { edtUrl: "http://localhost:18120/mcp" } });
  const overridePath = instance_file(settings(), f.root), override = fs.readFileSync(overridePath);
  const before = fs.readFileSync(profilePath), stat = fs.statSync(profilePath);
  const edit = (await client.call("settings.edit", {})).structuredContent, data = JSON.parse(edit.text);
  for (const field of ["java", "node", "configuration"]) delete data.settings.mcp.managed["bsl-ls"][field];
  const request = { text: JSON.stringify(data), mode: "edit", baseRevision: edit.baseRevision };
  const preview = (await client.call("settings.preview", request)).structuredContent;
  assert.equal(preview.replacesProfile, false);
  assert.deepEqual(preview.sharedRuntimeChanges["bsl-ls"], { mode: "auto", version: "latest", java: "java", node: "node", configuration: null, enabled: false });
  const result = (await client.call("settings.apply", { ...request, revision: preview.revision })).structuredContent;
  assert.equal(result.backup, null);
  assert.deepEqual(fs.readFileSync(profilePath), before);
  assert.equal(fs.statSync(profilePath).mtimeMs, stat.mtimeMs);
  assert.deepEqual(fs.readFileSync(overridePath), override);
  assert.equal(fs.readdirSync(path.dirname(profilePath)).filter(name => name.endsWith(".bak.yaml")).length, 0);
  const stored = load(f.env.EDT_AI_SETTINGS).mcp.managed["bsl-ls"];
  assert.equal(stored.java, "java"); assert.equal(stored.node, "node"); assert.equal(stored.configuration, null);
});

test("manual profile changes still require replacement and preserve a backup", async (t) => {
  const f = fixture(t); environment(t, f.env); f.save();
  const backend = new SettingsBackend(f.state, f.env.EDT_AI_SETTINGS);
  const edit = await backend.main({ action: "edit" }), data = JSON.parse(edit.text);
  data.profile.project.purpose = "Updated purpose";
  const request = { text: JSON.stringify(data), mode: "edit", baseRevision: edit.baseRevision };
  const preview = await backend.main({ ...request, action: "preview" });
  assert.equal(preview.replacesProfile, true);
  await assert.rejects(backend.main({ ...request, action: "apply", revision: preview.revision }), /замену/);
  const result = await backend.main({ ...request, action: "apply", revision: preview.revision, replace: true });
  assert.ok(result.backup);
  assert.deepEqual(load(result.backup), f.profile);
  assert.equal(load(path.join(f.root, ".ai/project.yaml")).project.purpose, "Updated purpose");
});

test("an incompatible legacy profile can be repaired in the editor without bypassing preview validation",async t=>{
  const f=fixture(t);environment(t,f.env);f.profile.compatibility.core=">=0.1.0 <0.2.0";f.save();
  const backend=new SettingsBackend(f.state,f.env.EDT_AI_SETTINGS);
  assert.equal((await backend.main({action:"read"})).profile.status,"invalid");
  const edit=await backend.main({action:"edit"}),document=JSON.parse(edit.text);
  const args={mode:"edit",baseRevision:edit.baseRevision,text:edit.text};
  await assert.rejects(backend.main({action:"preview",...args}),/Profile requires core/);
  document.profile.compatibility.core=">=0.1.0";args.text=JSON.stringify(document);
  const preview=await backend.main({action:"preview",...args});assert.equal(preview.replacesProfile,true);
  await backend.main({action:"apply",...args,revision:preview.revision,replace:true});
  assert.equal((await backend.main({action:"read"})).profile.status,"loaded");
});

for (const changed of ["shared settings", "profile", "instance", "preview mode"])
  test("manual edit rejects stale or changed " + changed + " before writes", async (t) => {
    const f = fixture(t); environment(t, f.env); f.save();
    const backend = new SettingsBackend(f.state, f.env.EDT_AI_SETTINGS);
    const edit = await backend.main({ action: "edit" }), data = JSON.parse(edit.text);
    data.settings.mcp.managed["bsl-ls"].version = "0.99.0";
    const request = { text: JSON.stringify(data), mode: "edit", baseRevision: edit.baseRevision };
    const preview = await backend.main({ ...request, action: "preview" });
    if (changed === "shared settings") dump({ mcp: { managed: { "bsl-ls": { java: "new-java" } } } }, f.env.EDT_AI_SETTINGS);
    if (changed === "profile") fs.appendFileSync(path.join(f.root, ".ai/project.yaml"), "\n# Concurrent edit\n");
    if (changed === "instance") await backend.main({ action: "update", set: { edtUrl: "http://localhost:18121/mcp" } });
    const before = fs.readFileSync(path.join(f.root, ".ai/project.yaml"));
    if (changed === "preview mode") { delete request.mode; delete request.baseRevision; }
    else await assert.rejects(backend.main({ ...request, action: "preview" }), /после загрузки/);
    await assert.rejects(backend.main({ ...request, action: "apply", revision: preview.revision, replace: true }), /после загрузки|предпросмотра/);
    assert.deepEqual(fs.readFileSync(path.join(f.root, ".ai/project.yaml")), before);
    assert.equal(settings(f.env.EDT_AI_SETTINGS).mcp.managed["bsl-ls"].version, "latest");
  });

test("UI import/export, replacement backup and portable roundtrip preserve profile defaults", async (t) => {
  const f = fixture(t),
    client = await session(t, "mcp/settings.mjs", [], f);
  f.profile.connections = {
    edt: { url: "http://localhost:18101/mcp" },
    v8std: { url: "http://localhost:18102/mcp" },
  };
  const request = { text: JSON.stringify(f.profile) },
    preview = (await client.call("settings.preview", request))
      .structuredContent;
  assert.ok(!fs.existsSync(path.join(f.root, ".ai")));
  await client.call("settings.apply", {
    ...request,
    revision: preview.revision,
  });
  assert.deepEqual(load(path.join(f.root, ".ai/project.yaml")), f.profile);
  const again = (await client.call("settings.preview", request))
    .structuredContent;
  await assert.rejects(
    client.call("settings.apply", { ...request, revision: again.revision }),
    /замену/,
  );
  await client.call("settings.apply", {
    ...request,
    revision: again.revision,
    replace: true,
  });
  assert.equal(
    fs
      .readdirSync(path.join(f.root, ".ai"))
      .filter((name) => name.endsWith(".bak.yaml")).length,
    1,
  );
  await client.call("settings.update", {
    set: { edtUrl: "http://localhost:18103/mcp" },
  });
  const exported = JSON.parse(
    (await client.call("settings.export_data", {}))._meta.data.text,
  );
  assert.deepEqual(exported.profile, f.profile);
  assert.ok(!("active_project" in exported.settings));
  assert.ok(!("required" in exported.settings.mcp));
  assert.ok(!JSON.stringify(exported).includes("18103"));
  assert.equal(
    (await client.call("settings.read", {})).structuredContent.values.edtUrl,
    "http://localhost:18103/mcp",
  );
});
for (const changed of ["payload", "config", "override", "masked override"])
  test(
    "preview rejects changed " + changed + " without writes or backups",
    async (t) => {
      const f = fixture(t);
      environment(t, f.env);
      f.save();
      const backend = new SettingsBackend(f.state, f.env.EDT_AI_SETTINGS),
        request = { action: "preview", text: JSON.stringify(f.profile) };
      const override = instance_file(settings(), f.root);
      if (changed === "masked override")
        process.env.EDT_AI_EDT_URL = "http://localhost:18104/mcp";
      const preview = await backend.main(request),
        before = fs.readFileSync(path.join(f.root, ".ai/project.yaml"));
      if (changed === "payload")
        request.text = JSON.stringify({
          ...f.profile,
          project: { ...f.profile.project, purpose: "different" },
        });
      if (changed === "config")
        dump(
          { mcp: { managed: { "code-index": { version: "1.2.3" } } } },
          f.env.EDT_AI_SETTINGS,
        );
      if (changed.includes("override"))
        dump(
          { connections: { edt: { url: "http://localhost:18105/mcp" } } },
          override,
        );
      await assert.rejects(
        backend.main({
          ...request,
          action: "apply",
          revision: preview.revision,
          replace: true,
        }),
        /предпросмотра/,
      );
      assert.deepEqual(
        fs.readFileSync(path.join(f.root, ".ai/project.yaml")),
        before,
      );
      assert.equal(
        fs
          .readdirSync(path.join(f.root, ".ai"))
          .filter((name) => name.endsWith(".bak.yaml")).length,
        0,
      );
    },
  );
test("settings transaction rolls back profile, instance and shared config on a failed store", async (t) => {
  const f = fixture(t);
  environment(t, f.env);
  f.save();
  const backend = new SettingsBackend(f.state, f.env.EDT_AI_SETTINGS),
    before = fs.readFileSync(path.join(f.root, ".ai/project.yaml"));
  const request = {
    text: JSON.stringify({
      format: "1c-ai-core-settings",
      version: 1,
      settings: {
        mcp: { required: { edt: { url: "http://localhost:18106/mcp" } } },
      },
      profile: f.profile,
    }),
  };
  const preview = await backend.main({ ...request, action: "preview" });
  backend.store_shared_settings = () => {
    throw new Error("fixture write failure");
  };
  await assert.rejects(
    backend.main({
      ...request,
      action: "apply",
      revision: preview.revision,
      replace: true,
    }),
    /fixture write failure/,
  );
  assert.deepEqual(
    fs.readFileSync(path.join(f.root, ".ai/project.yaml")),
    before,
  );
  assert.ok(!fs.existsSync(instance_file(settings(), f.root)));
  assert.ok(!fs.existsSync(f.env.EDT_AI_SETTINGS));
});
test("apply reparses under the acquired lock and detects intervening changes", async (t) => {
  const f = fixture(t);
  environment(t, f.env);
  f.save();
  const backend = new SettingsBackend(f.state, f.env.EDT_AI_SETTINGS),
    request = { text: JSON.stringify(f.profile) };
  const preview = await backend.main({ ...request, action: "preview" }),
    parse = backend.parse_import.bind(backend);
  let count = 0;
  backend.parse_import = (request) => {
    if (++count === 2)
      dump(
        { mcp: { managed: { "bsl-ls": { version: "1.2.3" } } } },
        f.env.EDT_AI_SETTINGS,
      );
    return parse(request);
  };
  await assert.rejects(
    backend.main({
      ...request,
      action: "apply",
      revision: preview.revision,
      replace: true,
    }),
    /предпросмотра/,
  );
});
test("parallel instances keep overrides before profile init and after import; empty URL disconnects", async (t) => {
  const f = fixture(t),
    a = await session(t, "mcp/settings.mjs", [], f),
    b = await session(t, "mcp/settings.mjs", [], f, {
      EDT_AI_INSTANCE: "second",
    });
  await a.call("settings.update", {
    set: { edtUrl: "http://localhost:18111/mcp" },
  });
  await b.call("settings.update", {
    set: { edtUrl: "http://localhost:18112/mcp" },
  });
  assert.ok(!fs.existsSync(f.env.EDT_AI_SETTINGS));
  f.profile.connections = { edt: { url: "http://localhost:18113/mcp" } };
  f.save();
  assert.equal(
    (await a.call("settings.read", {})).structuredContent.values.edtUrl,
    "http://localhost:18111/mcp",
  );
  assert.equal(
    (await b.call("settings.read", {})).structuredContent.values.edtUrl,
    "http://localhost:18112/mcp",
  );
  await a.call("settings.update", { set: { edtUrl: "" } });
  assert.equal(
    (await a.call("settings.read", {})).structuredContent.values.edtUrl,
    "",
  );
  const c = await session(t, "mcp/settings.mjs", [], f, {
    EDT_AI_EDT_URL: "http://localhost:18114/mcp",
  });
  const read = (await c.call("settings.read", {})).structuredContent;
  assert.equal(read.values.edtUrl, "http://localhost:18114/mcp");
  assert.equal(read.connectionSources.edt, "environment:EDT_AI_EDT_URL");
  assert.equal(read.schema.properties.edtUrl.readOnly, true);
});
test("host roots can change; ambiguous/empty roots never borrow the previous project", async (t) => {
  const f = fixture(t);
  f.save();
  const other = path.join(f.base, "other");
  fs.mkdirSync(other);
  const profile = structuredClone(f.profile);
  profile.connections = { edt: { url: "http://localhost:18121/mcp" } };
  dump(profile, path.join(other, ".ai/project.yaml"));
  const env = { ...f.env, EDT_AI_PROJECT_ROOT: "" },
    client = new McpClient(
      [process.execPath, path.join(ROOT, "mcp/settings.mjs")],
      f.base,
      env,
      10,
    );
  f.clients.push(client);
  client.roots = [{ uri: pathToFileURL(other).href }];
  await client.initialize();
  assert.equal(
    (await client.call("settings.read", {})).structuredContent.values.edtUrl,
    profile.connections.edt.url,
  );
  await assert.rejects(
    client.call("settings.preview", {
      text: JSON.stringify({
        format: "1c-ai-core-settings",
        version: 1,
        settings: { active_project: f.root },
        profile: f.profile,
      }),
    }),
    /другому каталогу/,
  );
  client.roots = [
    { uri: pathToFileURL(f.root).href },
    { uri: pathToFileURL(other).href },
  ];
  client.notify("notifications/roots/list_changed");
  await assert.rejects(
    client.call("settings.update", { set: { edtUrl: "http://localhost/mcp" } }),
    /каталог/,
  );
  client.roots = [];
  client.notify("notifications/roots/list_changed");
  const read = (await client.call("settings.read", {})).structuredContent;
  assert.equal(read.values.projectRoot, "");
  assert.equal(read.values.edtUrl, "");
  assert.equal(read.projectSelection.status, "unselected");
  await client.call("settings.update", {
    set: { edtUrl: "http://localhost:18122/mcp", projectRoot: f.root },
  });
  assert.equal(
    (await client.call("settings.read", {})).structuredContent.values
      .projectRoot,
    f.root,
  );
});
test("subdirectory and Git root use one settings binding; legacy YAML is still read", async (t) => {
  const f = fixture(t);
  f.save();
  const sub = path.join(f.root, "docs");
  fs.mkdirSync(sub);
  fs.mkdirSync(path.join(f.root, ".git"));
  dump(
    {
      active_project: f.root,
      mcp: { required: { edt: { url: "http://localhost:18131/mcp" } } },
    },
    f.env.EDT_AI_SETTINGS,
  );
  const client = await session(t, "mcp/settings.mjs", [], f, {
    EDT_AI_PROJECT_ROOT: sub,
  });
  const read = (await client.call("settings.read", {})).structuredContent;
  assert.equal(read.values.projectRoot, f.root);
  assert.equal(read.preparationScope, f.root + "#first");
  assert.equal(read.values.edtUrl, "http://localhost:18131/mcp");
  const exported = JSON.parse(
    (await client.call("settings.export_data", {}))._meta.data.text,
  );
  assert.deepEqual(exported.profile, f.profile);
  fs.mkdirSync(path.join(sub, ".git"));
  await assert.rejects(
    client.call("settings.preview", {
      text: JSON.stringify(f.profile),
      projectRoot: f.root,
    }),
    /другому каталогу/,
  );
});
for (const value of [
  { set: { repository: "x" } },
  { set: { edtUrl: false } },
  { set: { openvikingUrl: "http://user:password@localhost/mcp" } },
])
  test(
    "unknown/untyped/credential settings writes are rejected: " +
      JSON.stringify(value),
    async (t) => {
      const f = fixture(t),
        client = await session(t, "mcp/settings.mjs", [], f);
      await assert.rejects(client.call("settings.update", value));
      assert.ok(!fs.existsSync(f.env.EDT_AI_SETTINGS));
    },
  );
test("preparation validates exact root, instance, effects and evidence before runtime side effects", (t) => {
  const f = fixture(t);
  environment(t, f.env);
  const scope = preparation_scope(f.root);
  authorize_preparation(
    {
      authorization: {
        scope,
        effects: ["launch"],
        evidence: "actual fixture user turn",
      },
    },
    f.root,
  );
  for (const authorization of [
    null,
    { scope, effects: [], evidence: "x" },
    { scope, effects: ["launch"], evidence: " " },
    { scope: f.root + "#second", effects: ["launch"], evidence: "x" },
    { scope, effects: ["launch"], evidence: "x", extra: true },
  ])
    assert.throws(() => authorize_preparation({ authorization }, f.root));
  assert.ok(!fs.existsSync(path.join(f.state, "runtime-lock.json")));
});
test("settings supervisor tracks one delayed operation and retains unknown outcomes without retry", async (t) => {
  const f = fixture(t),
    plugin = path.join(f.base, "plugin");
  fs.mkdirSync(path.join(plugin, "mcp"), { recursive: true });
  fs.mkdirSync(path.join(plugin, "scripts"));
  fs.mkdirSync(path.join(plugin, "assets"));
  fs.copyFileSync(path.join(ROOT,"plugin.json"),path.join(plugin,"plugin.json"));
  for (const name of ["icons.mjs", "selection.mjs", "project_paths.mjs", "casefold.mjs", "compatibility.mjs"])
    fs.copyFileSync(path.join(ROOT, "scripts", name), path.join(plugin, "scripts", name));
  fs.copyFileSync(path.join(ROOT, "scripts/settings_folder.mjs"), path.join(plugin, "scripts/settings_folder.mjs"));
  fs.copyFileSync(path.join(ROOT, "assets/icon.svg"), path.join(plugin, "assets/icon.svg"));
  for (const name of ["settings.mjs", "settings-operations.mjs"])
    fs.copyFileSync(
      path.join(ROOT, "mcp", name),
      path.join(plugin, "mcp", name),
    );
  fs.writeFileSync(
    path.join(plugin, "scripts/settings_backend.mjs"),
    `import fs from 'node:fs'; let input=''; for await (const chunk of process.stdin) input+=chunk; const r=JSON.parse(input); await new Promise(done=>setTimeout(done,200)); fs.appendFileSync(process.env.EDT_AI_STATE_DIR+'/calls',r.action+'\\n'); if(r.set?.edtUrl==='unknown') process.exit(3); console.log(JSON.stringify({ok:true,result:r.set?.edtUrl==='malformed'?null:{managed:[],values:{projectRoot:process.env.EDT_AI_PROJECT_ROOT}}}));`,
  );
  const client = new McpClient(
    [process.execPath, path.join(plugin, "mcp/settings.mjs")],
    f.root,
    f.env,
    10,
  );
  f.clients.push(client);
  await client.initialize();
  await assert.rejects(client.call("settings.run_check", {}));
  const operation = (
    await client.call("settings.run_check", {
      authorization: {
        scope: f.root + "#first",
        effects: ["launch"],
        evidence: "fixture",
      },
    })
  ).structuredContent;
  assert.equal(operation.status, "running");
  await assert.rejects(
    client.call("settings.update", { set: { edtUrl: "x" } }),
    /ещё выполняется/,
  );
  let completed;
  for (let i = 0; i < 50; i++) {
    completed = (
      await client.call("settings.operation", { operationId: operation.id })
    ).structuredContent;
    if (completed.status !== "running") break;
    await sleep(20);
  }
  assert.equal(completed.status, "completed");
  assert.equal(fs.readFileSync(path.join(f.state, "calls"), "utf8"), "check\n");
  await assert.rejects(
    client.call("settings.update", { set: { edtUrl: "unknown" } }),
    /неизвестен/,
  );
  await assert.rejects(
    client.call("settings.update", { set: { edtUrl: "malformed" } }),
    /некорректный/,
  );
  const status = (await client.call("settings.operation", {}))
    .structuredContent;
  assert.notEqual(status.status, "running");
});
