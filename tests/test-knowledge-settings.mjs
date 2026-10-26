import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, environment, session, node, success } from "./helpers.mjs";
import { settings, validate_settings, dump, load } from "../scripts/common.mjs";
import { probe_connections } from "../scripts/setup_probe.mjs";
import { resolved_settings, instance_file } from "../scripts/project_context.mjs";
import { SettingsBackend } from "../scripts/settings_backend.mjs";
import { knowledge_gate, WORKFLOW_ACTIONS } from "../scripts/knowledge.mjs";

function enable_knowledge(f) {
  f.profile.knowledge = { mode: "transitional", provider: "openviking", manifest: null,
    collections: ["team"], required: true, dependent_actions: ["implementation"] };
}

test("OpenViking form/chat transport fields use validated instance overrides", async t => {
  const f = fixture(t); environment(t, f.env); enable_knowledge(f); f.save();
  const client = await session(t, "mcp/settings.mjs", [], f);
  const set = { openvikingEnabled: true, openvikingUrl: "https://knowledge.example/mcp",
    openvikingTimeout: 2.5, openvikingMaxResponseBytes: 4096,
    openvikingHeadersEnv: { Authorization: "OV_AUTHORIZATION" } };
  const update = await client.call("settings.update", { set });
  assert.equal(update.isError, undefined);
  const backend = new SettingsBackend();
  const view = await backend.main({ action: "read" });
  for (const [key, value] of Object.entries(set)) assert.deepEqual(view.values[key], value);
  const file = instance_file(backend.current(), f.root), before = fs.readFileSync(file);
  for (const change of [{ openvikingTimeout: 0 }, { openvikingMaxResponseBytes: 2048.5 },
    { openvikingHeadersEnv: { Authorization: "Bearer secret" } }, { openvikingHeadersEnv: null }]) {
    await assert.rejects(backend.main({ action: "update", set: change }));
    assert.deepEqual(fs.readFileSync(file), before);
  }
  process.env.EDT_AI_INSTANCE = "second";
  assert.equal((await backend.main({ action: "read" })).values.openvikingTimeout, 20);
  assert.equal(fs.existsSync(f.env.EDT_AI_SETTINGS), false);
});

test("OpenViking credential maps replace and clear inherited and saved header identities", async t => {
  const f = fixture(t); environment(t, f.env); enable_knowledge(f);
  f.profile.connections = { openviking: { headers_env: { Authorization: "OLD_AUTH", "X-Key": "OLD_KEY" } } }; f.save();
  const backend = new SettingsBackend();
  for (const headers of [{ Authorization: "NEW_AUTH", "X-Key": "NEW_KEY" }, { Authorization: "NEW_AUTH" }, {}]) {
    await backend.main({ action: "update", set: { openvikingHeadersEnv: headers } });
    assert.deepEqual((await backend.main({ action: "read" })).values.openvikingHeadersEnv, headers);
    assert.deepEqual(load(instance_file(backend.current(), f.root)).connections.openviking.headers_env, headers);
  }
  process.env.EDT_AI_INSTANCE = "second";
  assert.deepEqual((await backend.main({ action: "read" })).values.openvikingHeadersEnv,
    { Authorization: "OLD_AUTH", "X-Key": "OLD_KEY" });
});

test("OpenViking exposes the effective source of each independently inherited field", async t => {
  const f = fixture(t); environment(t, f.env); enable_knowledge(f);
  f.profile.connections = { openviking: { enabled: true, url: "https://profile.example/mcp", headers_env: { Authorization: "PROFILE_AUTH" } } }; f.save();
  dump({ connections: { openviking: { timeout_seconds: 3 } } }, path.join(f.root, ".ai/project.local.yaml"));
  const backend = new SettingsBackend();
  await backend.main({ action: "update", set: { openvikingMaxResponseBytes: 4096 } });
  const explicit = path.join(f.base, "connections.yaml");
  dump({ connections: { openviking: { headers_env: {} } } }, explicit);
  process.env.EDT_AI_CONNECTIONS_FILE = explicit; process.env.EDT_AI_OPENVIKING_URL = "https://environment.example/mcp";
  const expected = { openvikingEnabled: "profile", openvikingUrl: "environment:EDT_AI_OPENVIKING_URL",
    openvikingTimeout: "project_local", openvikingMaxResponseBytes: "instance", openvikingHeadersEnv: "connections_file" };
  assert.deepEqual((await backend.main({ action: "read" })).valueSources, expected);
  const client = await session(t, "mcp/settings.mjs", [], f, {
    EDT_AI_CONNECTIONS_FILE: explicit, EDT_AI_OPENVIKING_URL: process.env.EDT_AI_OPENVIKING_URL });
  for (const name of ["settings.read", "settings.status", "settings.inspect"]) {
    const view = (await client.call(name, {})).structuredContent;
    assert.deepEqual(view.valueSources, expected);
    if (view.schema) {
      assert.equal(view.schema.properties.openvikingHeadersEnv.readOnly, true);
      assert.equal(view.schema.properties.openvikingTimeout.readOnly, undefined);
    }
  }
});

test("both form entries, chat and CLI share OpenViking values, sources and instance scope", async t => {
  const f = fixture(t); environment(t, f.env); enable_knowledge(f); f.save();
  const cli = request => success(node("scripts/settings_backend.mjs", [], { env: f.env, input: JSON.stringify(request) })).result;
  cli({ action: "update", set: { openvikingEnabled: true, openvikingUrl: "https://instance.example/mcp", openvikingTimeout: 4 } });
  const snapshot = cli({ action: "read" });
  const client = await session(t, "mcp/settings.mjs", [], f);
  for (const name of ["settings.profile", "settings.open", "settings.inspect", "settings.read"]) {
    const response = await client.call(name, { ...(["settings.profile", "settings.inspect"].includes(name) ? { projectRoot: f.root } : {}) });
    const view = response.structuredContent;
    assert.deepEqual(view.values, snapshot.values, name);
    assert.deepEqual(view.valueSources, snapshot.valueSources, name);
    assert.equal(view.instance, snapshot.instance);
    if (name === "settings.inspect" || name === "settings.read")
      assert.equal(response._meta?.ui, undefined);
  }
  await client.call("settings.update", { set: { openvikingTimeout: 5 } });
  assert.equal(cli({ action: "read" }).values.openvikingTimeout, 5);
});

test("chat onboarding connects an existing knowledge server without guesses or preparation", async t => {
  const f = fixture(t); environment(t, f.env); enable_knowledge(f); f.save();
  const client = await session(t, "mcp/settings.mjs", [], f);
  const inspect = async () => (await client.call("settings.inspect", {})).structuredContent;
  const initial = await inspect();
  assert.equal(initial.knowledgeSetup.serverManagement, "external");
  assert.equal(initial.knowledgeSetup.createsKnowledge, false);
  assert.equal(initial.knowledgeSetup.guessesEndpoint, false);
  assert.ok(initial.nextSteps.includes("configure_knowledge_connection"));
  await client.call("settings.update", { set: { openvikingEnabled: true, openvikingUrl: "https://assigned.example/mcp" } });
  const configured = await inspect();
  assert.ok(configured.nextSteps.includes("verify_knowledge_readiness"));
  assert.equal(configured.knowledge.ready, false);
  assert.deepEqual(load(path.join(f.root, ".ai/project.yaml")).knowledge, f.profile.knowledge);
  assert.equal(fs.existsSync(path.join(f.state, "runtime-lock.json")), false);
});

test("unsaved knowledge probe transport is validated without persisting or changing the profile mode", async t => {
  const f = fixture(t); environment(t, f.env); enable_knowledge(f); f.save();
  const backend = new SettingsBackend(), before = fs.readFileSync(path.join(f.root, ".ai/project.yaml"));
  const draft = { enabled: true, url: "https://draft.example/mcp", timeout_seconds: 1, max_response_bytes: 4096,
    headers_env: { Authorization: "OV_AUTHORIZATION" } };
  const network = t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected network without access proof"); });
  const probe = await backend.main({ action: "probe", connections: { openviking: draft } });
  assert.equal(probe.external.openviking.configured, true);
  assert.equal(probe.external.openviking.ready, false);
  assert.equal(probe.knowledge.required, true);
  assert.equal((await backend.main({ action: "read" })).values.openvikingUrl, "");
  assert.equal(network.mock.callCount(), 0);
  for (const change of [{ timeout_seconds: 0 }, { headers_env: { Authorization: "Bearer secret" } },
    { url: "https://draft.example/mcp?token=secret" }])
    await assert.rejects(backend.main({ action: "probe", connections: { openviking: { ...draft, ...change } } }));
  assert.deepEqual(fs.readFileSync(path.join(f.root, ".ai/project.yaml")), before);
  assert.equal(fs.existsSync(instance_file(backend.current(), f.root)), false);
});

test("OpenViking settings validate endpoint, environment credentials and bounded transport budgets", t => {
  const f = fixture(t); environment(t, f.env);
  const config = settings();
  assert.equal(config.mcp.optional.openviking.timeout_seconds, 20);
  assert.equal(config.mcp.optional.openviking.max_response_bytes, 2097152);
  const valid = { enabled: true, url: "https://knowledge.example/mcp", timeout_seconds: 2.5,
    max_response_bytes: 4096, headers_env: { Authorization: "OV_AUTHORIZATION" } };
  config.mcp.optional.openviking = valid; validate_settings(config);
  for (const change of [{ timeout_seconds: 0 }, { timeout_seconds: 301 }, { max_response_bytes: 1023 },
    { max_response_bytes: 16777217 }, { max_response_bytes: 2048.5 },
    { headers_env: { Authorization: "Bearer secret" } }, { headers: { Authorization: "secret" } },
    { url: "https://knowledge.example/mcp?api_key=secret" },
    { url: "https://user:password@knowledge.example/mcp" }, { url: "https://knowledge.example/mcp#token" }]) {
    config.mcp.optional.openviking = { ...valid, ...change };
    assert.throws(() => validate_settings(config));
  }
});

test("OpenViking setup probe refuses credentials without external access confirmations", async t => {
  const f = fixture(t); environment(t, f.env); enable_knowledge(f);
  const config = settings();
  config.mcp.optional.openviking = { enabled: true, url: "https://knowledge.example/mcp",
    timeout_seconds: 0.0015, max_response_bytes: 1024, headers_env: { Authorization: "OV_AUTHORIZATION" } };
  const calls = [];
  f.profile.knowledge.collection_uris = { team: "viking://resources/team" };
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    calls.push(options);
    return new Response("x".repeat(2048), { headers: { "Content-Type": "application/json" } });
  });
  let result = await probe_connections(config, f.root, f.profile);
  assert.equal(calls.length, 0);
  assert.match(result.external.openviking.detail, /access|credential/);
  process.env.OV_AUTHORIZATION = "Bearer fixture-secret";
  result = await probe_connections(config, f.root, f.profile);
  assert.equal(calls.length, 0);
  assert.equal(result.external.openviking.access, "not_verified");
  assert.equal(result.external.openviking.ready, false);
  assert.equal(JSON.stringify(config).includes("fixture-secret"), false);
  assert.equal(result.external.openviking.connected, false);
});

test("OpenViking resolves profile, local, repository instance, state instance, explicit file and environment per field", t => {
  const f = fixture(t); environment(t, f.env); enable_knowledge(f);
  f.profile.connections = { openviking: { enabled: true, url: "https://profile.example/mcp",
    headers_env: { Authorization: "OV_AUTHORIZATION" } } }; f.save();
  const config = settings();
  config.mcp.optional.openviking.url = "https://settings.example/mcp";
  const read = () => {
    const [effective, sources] = resolved_settings(config, f.root, f.profile);
    validate_settings(effective);
    return [effective.mcp.optional.openviking, sources.openviking];
  };
  delete f.profile.connections.openviking.url;
  assert.equal(read()[1], "settings");
  config.mcp.optional.openviking.url = "";
  assert.equal(read()[1], "unconfigured");
  config.mcp.optional.openviking.url = "https://settings.example/mcp";
  f.profile.connections.openviking.url = "https://profile.example/mcp";
  assert.equal(read()[1], "profile");
  dump({ connections: { openviking: { timeout_seconds: 3, headers_env: { Authorization: "OV_LOCAL_AUTH" } } } }, path.join(f.root, ".ai/project.local.yaml"));
  assert.equal(read()[0].timeout_seconds, 3);
  dump({ connections: { openviking: { url: "https://repository-instance.example/mcp" } } }, path.join(f.root, ".ai/instances/first.local.yaml"));
  assert.equal(read()[1], "repository_instance");
  const stateFile = instance_file(config, f.root);
  dump({ connections: { openviking: { url: "https://instance.example/mcp", max_response_bytes: 8192 } } }, stateFile);
  assert.equal(read()[1], "instance");
  const explicit = path.join(f.base, "connections.yaml");
  dump({ connections: { openviking: { url: "https://explicit.example/mcp", timeout_seconds: 5 } } }, explicit);
  process.env.EDT_AI_CONNECTIONS_FILE = explicit;
  const [effective, source] = read();
  assert.equal(source, "connections_file");
  assert.deepEqual(effective, { enabled: true, url: "https://explicit.example/mcp", timeout_seconds: 5,
    max_response_bytes: 8192, headers_env: { Authorization: "OV_LOCAL_AUTH" } });
  process.env.EDT_AI_OPENVIKING_URL = "https://environment.example/mcp";
  assert.equal(read()[0].url, process.env.EDT_AI_OPENVIKING_URL);
  assert.equal(read()[1], "environment:EDT_AI_OPENVIKING_URL");
  dump({ connections: { openviking: { url_env: "CUSTOM_OV_URL" } } }, explicit);
  process.env.CUSTOM_OV_URL = "https://custom.example/mcp";
  assert.equal(read()[0].url, process.env.CUSTOM_OV_URL);
  assert.equal(read()[1], "environment:CUSTOM_OV_URL");
  delete process.env.EDT_AI_CONNECTIONS_FILE; delete process.env.EDT_AI_OPENVIKING_URL;
  process.env.EDT_AI_INSTANCE = "second";
  assert.equal(read()[0].url, "https://profile.example/mcp");
  assert.equal(read()[0].max_response_bytes, 2097152);
  const other = path.join(f.base, "other"); fs.mkdirSync(other);
  assert.equal(resolved_settings(config, other, null)[0].mcp.optional.openviking.url, "https://settings.example/mcp");
});

test("OpenViking settings updates belong to the selected instance and MCP exposes the effective source", async t => {
  const f = fixture(t); environment(t, f.env); enable_knowledge(f); f.save();
  const backend = new SettingsBackend();
  const updated = await backend.main({ action: "update", set: { openvikingUrl: "https://instance.example/mcp", openvikingEnabled: true } });
  assert.equal(updated.values.openvikingEnabled, true);
  assert.equal(updated.values.openvikingUrl, "https://instance.example/mcp");
  assert.deepEqual(load(instance_file(backend.current(), f.root)).connections.openviking,
    { enabled: true, url: "https://instance.example/mcp" });
  assert.equal(fs.existsSync(f.env.EDT_AI_SETTINGS), false);
  const client = await session(t, "mcp/settings.mjs", [], f);
  const view = (await client.call("settings.read", {})).structuredContent;
  assert.equal(view.connectionSources.openviking, "instance");
  assert.equal(view.schema.properties.openvikingUrl.readOnly, undefined);
  const environmentClient = await session(t, "mcp/settings.mjs", [], f, { EDT_AI_OPENVIKING_URL: "https://environment.example/mcp" });
  for (const name of ["settings.read", "settings.status"]) {
    const inherited = (await environmentClient.call(name, {})).structuredContent;
    assert.equal(inherited.schema.properties.openvikingUrl.readOnly, true);
    assert.equal(inherited.schema.properties.v8stdUrl.readOnly, undefined);
    assert.equal(inherited.values.openvikingUrl, "https://environment.example/mcp");
  }
  process.env.EDT_AI_INSTANCE = "second";
  assert.equal((await backend.main({ action: "read" })).values.openvikingUrl, "");
});

test("OpenViking portable export/import preserves public transport defaults without credentials or local overrides", async t => {
  const f = fixture(t); environment(t, f.env); enable_knowledge(f);
  f.profile.connections = { openviking: { enabled: true, url: "https://public.example/mcp", timeout_seconds: 4,
    max_response_bytes: 4096, headers_env: { Authorization: "OV_AUTHORIZATION" } } }; f.save();
  process.env.OV_AUTHORIZATION = "Bearer fixture-secret";
  process.env.EDT_AI_OPENVIKING_URL = "https://environment.example/mcp";
  dump({ connections: { openviking: { url: "https://private-local.example/mcp" } } }, path.join(f.root, ".ai/project.local.yaml"));
  const backend = new SettingsBackend();
  await backend.main({ action: "update", set: { openvikingUrl: "https://private-instance.example/mcp" } });
  const exported = await backend.main({ action: "export" });
  assert.deepEqual(JSON.parse(exported.text).profile, f.profile);
  assert.equal(/fixture-secret|private-local|private-instance|environment\.example/.test(exported.text), false);
  const other = path.join(f.base, "other"); fs.mkdirSync(path.join(other, "src"), { recursive: true });
  process.env.EDT_AI_PROJECT_ROOT = other; delete process.env.EDT_AI_OPENVIKING_URL;
  const request = { text: exported.text };
  const preview = await backend.main({ action: "preview", ...request });
  assert.equal(preview.openviking.url, "https://public.example/mcp");
  assert.equal(preview.openviking.timeout_seconds, 4);
  assert.equal(preview.openviking.max_response_bytes, 4096);
  assert.deepEqual(preview.openviking.headers_env, { Authorization: "OV_AUTHORIZATION" });
  assert.equal(JSON.stringify(preview).includes("fixture-secret"), false);
  const applied = await backend.main({ action: "apply", ...request, revision: preview.revision });
  assert.equal(applied.values.openvikingUrl, preview.openviking.url);
  assert.deepEqual(backend.effective(backend.current()).mcp.optional.openviking, preview.openviking);
});

for (const mode of ["import", "edit"])
  for (const changed of ["shared", "profile", "local", "repository_instance", "instance", "explicit"])
    test(`OpenViking ${mode} rejects a stale ${changed} source even under an environment URL override`, async t => {
      const f = fixture(t); environment(t, f.env); enable_knowledge(f); f.save();
      process.env.EDT_AI_OPENVIKING_URL = "https://environment.example/mcp";
      const explicit = path.join(f.base, "connections.yaml"); dump({ connections: {} }, explicit);
      process.env.EDT_AI_CONNECTIONS_FILE = explicit;
      const backend = new SettingsBackend(), config = backend.current();
      const document = await backend.main({ action: mode === "edit" ? "edit" : "export" });
      // Importing only settings must still track the profile it resolves against.
      if (mode === "import") { const data = JSON.parse(document.text); data.profile = null; document.text = JSON.stringify(data); }
      const request = { text: document.text, ...(mode === "edit" ? { mode, baseRevision: document.baseRevision } : {}) };
      const preview = await backend.main({ action: "preview", ...request });
      const profileFile = path.join(f.root, ".ai/project.yaml");
      const sources = { shared: f.env.EDT_AI_SETTINGS, local: path.join(f.root, ".ai/project.local.yaml"),
        repository_instance: path.join(f.root, ".ai/instances/first.local.yaml"), instance: instance_file(config, f.root), explicit };
      if (changed === "profile") { f.profile.project.purpose = "Changed after preview"; f.save(); }
      else if (changed === "shared") dump({ mcp: { optional: { openviking: { url: "https://changed.example/mcp" } } } }, sources.shared);
      else dump({ connections: { openviking: { url: "https://changed.example/mcp" } } }, sources[changed]);
      const profileBefore = fs.readFileSync(profileFile);
      const sourceBefore = changed === "profile" ? profileBefore : fs.readFileSync(sources[changed]);
      await assert.rejects(backend.main({ action: "apply", ...request, revision: preview.revision, replace: true }), /после загрузки|предпросмотра/);
      assert.deepEqual(fs.readFileSync(profileFile), profileBefore);
      if (changed !== "profile") assert.deepEqual(fs.readFileSync(sources[changed]), sourceBefore);
      assert.equal(fs.readdirSync(path.dirname(profileFile)).some(name => name.endsWith(".bak.yaml")), false);
    });

test("OpenViking import rejects inline credentials and credential-bearing URLs before writing", async t => {
  const f = fixture(t); environment(t, f.env); enable_knowledge(f); f.save();
  const backend = new SettingsBackend(), before = fs.readFileSync(path.join(f.root, ".ai/project.yaml"));
  for (const connection of [{ url: "https://knowledge.example/mcp?token=secret" },
    { url: "https://user:password@knowledge.example/mcp" }, { headers: { Authorization: "Bearer secret" } },
    { headers_env: { Authorization: "Bearer secret" } }]) {
    const profile = { ...f.profile, connections: { openviking: connection } };
    await assert.rejects(backend.main({ action: "preview", text: JSON.stringify(profile) }));
    const exported = JSON.parse((await backend.main({ action: "export" })).text);
    exported.settings.mcp.optional.openviking = connection;
    await assert.rejects(backend.main({ action: "preview", text: JSON.stringify(exported) }));
  }
  assert.deepEqual(fs.readFileSync(path.join(f.root, ".ai/project.yaml")), before);
  assert.equal(fs.existsSync(f.env.EDT_AI_SETTINGS), false);
});

for (const source of ["profile", "local", "repository_instance", "instance", "explicit", "environment"])
  test(`OpenViking empty ${source} URL remains an explicit disconnect above saved defaults`, async t => {
    const f = fixture(t); environment(t, f.env); enable_knowledge(f);
    f.profile.connections = { openviking: { enabled: true, url: source === "profile" ? "" : "https://profile.example/mcp" } }; f.save();
    dump({ mcp: { optional: { openviking: { enabled: true, url: "https://defaults.example/mcp" } } } }, f.env.EDT_AI_SETTINGS);
    const backend = new SettingsBackend(), config = backend.current();
    const files = { local: path.join(f.root, ".ai/project.local.yaml"),
      repository_instance: path.join(f.root, ".ai/instances/first.local.yaml"),
      instance: instance_file(config, f.root), explicit: path.join(f.base, "connections.yaml") };
    if (files[source]) dump({ connections: { openviking: { url: "" } } }, files[source]);
    if (source === "explicit") process.env.EDT_AI_CONNECTIONS_FILE = files.explicit;
    if (source === "environment") process.env.EDT_AI_OPENVIKING_URL = "";
    const before = files[source] ? fs.readFileSync(files[source]) : null;
    const network = t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected network"); });
    const read = await backend.main({ action: "read" });
    assert.equal(read.values.openvikingUrl, "");
    assert.equal(read.values.openvikingEnabled, true);
    assert.equal(read.connectionSources.openviking, source === "environment" ? "environment:EDT_AI_OPENVIKING_URL" : source === "local" ? "project_local" : source === "explicit" ? "connections_file" : source);
    const preview = await backend.main({ action: "preview", text: JSON.stringify(f.profile) });
    assert.equal(preview.openviking.url, "");
    await backend.main({ action: "apply", text: JSON.stringify(f.profile), revision: preview.revision, replace: true });
    assert.equal((await backend.main({ action: "read" })).values.openvikingUrl, "");
    const probe = await backend.main({ action: "probe" });
    assert.equal(probe.external.openviking.configured, false);
    assert.equal(network.mock.callCount(), 0);
    if (before) assert.deepEqual(fs.readFileSync(files[source]), before);
  });

test("OpenViking false transport flag retains the endpoint and explicit reset removes only this instance URL", async t => {
  const f = fixture(t); environment(t, f.env); enable_knowledge(f);
  f.profile.connections = { openviking: { enabled: true, url: "https://profile.example/mcp" } }; f.save();
  const backend = new SettingsBackend();
  const file = instance_file(backend.current(), f.root);
  const retained = { enabled: false, timeout_seconds: 3, max_response_bytes: 4096, headers_env: { Authorization: "OV_AUTHORIZATION" } };
  dump({ connections: { openviking: { ...retained, url: "" } } }, file);
  const client = await session(t, "mcp/settings.mjs", [], f);
  await client.call("settings.reset_connection", { connection: "openviking" });
  assert.deepEqual(load(file).connections.openviking, retained);
  assert.equal((await backend.main({ action: "read" })).values.openvikingUrl, "https://profile.example/mcp");
  assert.equal((await backend.main({ action: "read" })).values.openvikingEnabled, false);
  const network = t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected network"); });
  await backend.main({ action: "probe" });
  assert.equal(network.mock.callCount(), 0);
  assert.equal(fs.existsSync(f.env.EDT_AI_SETTINGS), false);
  process.env.EDT_AI_INSTANCE = "second";
  assert.equal((await backend.main({ action: "read" })).values.openvikingEnabled, true);
});

for (const mode of ["transitional", "kora"])
  test(`OpenViking ${mode} requirements survive transport edits, export/import and an empty local endpoint`, async t => {
    const f = fixture(t); environment(t, f.env); enable_knowledge(f);
    f.profile.knowledge.mode = mode;
    if (mode === "kora") f.profile.knowledge.dependent_actions = [...WORKFLOW_ACTIONS];
    f.profile.connections = { openviking: { enabled: true, url: "https://profile.example/mcp" } }; f.save();
    const required = structuredClone(f.profile.knowledge), backend = new SettingsBackend();
    const network = t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected network"); });
    for (const set of [{ openvikingUrl: "" }, { openvikingEnabled: false, openvikingUrl: "https://saved.example/mcp" },
      { openvikingEnabled: true, openvikingUrl: "" }]) {
      await backend.main({ action: "update", set });
      const view = await backend.main({ action: "read" });
      assert.equal(view.knowledge.provider, "openviking");
      assert.equal(view.knowledge.mode, mode);
      assert.equal(view.knowledge.required, true);
      assert.deepEqual(view.knowledge.dependentActions, required.dependent_actions);
      assert.equal(view.knowledge.state, "not_configured");
      assert.equal(view.knowledge.koraReady, false);
      assert.deepEqual(view.knowledge.transport, { enabled: view.values.openvikingEnabled, endpointConfigured: Boolean(view.values.openvikingUrl) });
      const config = backend.effective(backend.current());
      assert.equal(knowledge_gate(f.profile, config, "implementation").allowed, false);
      assert.equal(knowledge_gate(f.profile, config, "review").allowed, mode !== "kora");
      if (mode === "kora") assert.equal(knowledge_gate(f.profile, config, "future_operation").allowed, false);
      await backend.main({ action: "probe" });
      assert.deepEqual(load(path.join(f.root, ".ai/project.yaml")).knowledge, required);
    }
    const exported = await backend.main({ action: "export" });
    assert.deepEqual(JSON.parse(exported.text).profile.knowledge, required);
    const preview = await backend.main({ action: "preview", text: exported.text });
    await backend.main({ action: "apply", text: exported.text, revision: preview.revision, replace: true });
    assert.deepEqual(load(path.join(f.root, ".ai/project.yaml")).knowledge, required);
    assert.equal(network.mock.callCount(), 0);
    const client = await session(t, "mcp/settings.mjs", [], f);
    for (const name of ["settings.read", "settings.status", "settings.inspect"]) {
      const view = (await client.call(name, {})).structuredContent;
      assert.equal(view.knowledge.state, "not_configured");
      assert.equal(view.knowledge.required, true);
      assert.equal(view.knowledge.mode, mode);
      assert.deepEqual(view.knowledge.transport, { enabled: true, endpointConfigured: false });
    }
  });

test("transport settings cannot implicitly enable a provider disabled by the profile", async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  const backend = new SettingsBackend(), original = structuredClone(f.profile.knowledge);
  await backend.main({ action: "update", set: { openvikingUrl: "https://saved.example/mcp", openvikingEnabled: false } });
  const view = await backend.main({ action: "read" });
  assert.equal(view.knowledge.state, "disabled");
  assert.deepEqual(view.knowledge.transport, { enabled: false, endpointConfigured: true });
  await backend.main({ action: "update", set: { openvikingEnabled: true } });
  assert.equal((await backend.main({ action: "read" })).knowledge.state, "invalid");
  const network = t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected network"); });
  await backend.main({ action: "probe" });
  assert.equal(network.mock.callCount(), 0);
  assert.deepEqual(load(path.join(f.root, ".ai/project.yaml")).knowledge, original);
});
