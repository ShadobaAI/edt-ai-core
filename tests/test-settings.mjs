import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { fixture, environment, session, ROOT } from "./helpers.mjs";
import { dump, load, settings, sleep } from "../scripts/common.mjs";
import {
  SettingsBackend,
  authorize_preparation,
  preparation_scope,
} from "../scripts/settings_backend.mjs";
import { instance_file } from "../scripts/project_context.mjs";
import { McpClient } from "../scripts/mcp_client.mjs";

test("native settings metadata, legacy handshake and modern refusal work before configuration", async (t) => {
  const f = fixture(t),
    client = await session(t, "mcp/settings.mjs", [], f);
  const read = (await client.call("settings.read", {})).structuredContent;
  assert.equal(read.values.projectRoot, f.root);
  assert.equal(read.preparationScope, f.root + "#first");
  assert.equal(read.schema.properties.projectRoot.readOnly, true);
  const discovery = await client.request("server/discover");
  assert.ok(discovery.capabilities.extensions["openai/settings"]);
  await assert.rejects(
    client.request("server/discover", {
      _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
    }),
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
