import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { fixture, environment, session, dialog_session } from "./helpers.mjs";
import { canonical_yaml, dump, load, parse } from "../scripts/common.mjs";
import { remember_profile } from "../scripts/profile_history.mjs";
import { profile_state } from "../scripts/profile.mjs";
import { java_info, java_in_directory } from "../scripts/runtime.mjs";
import { SettingsBackend } from "../scripts/settings_backend.mjs";
import { project_directory } from "../scripts/project_paths.mjs";
import { which } from "../scripts/processes.mjs";
import { save_export_to_path } from "../scripts/settings_export.mjs";
import { stringify } from "yaml";

for (const layerScope of ["profile", "project_local"]) test(`YAML ${layerScope} editor previews formatted text, backs up and rejects stale previews`, async t => {
  const f = fixture(t); f.save();
  const target = path.join(f.root, ".ai", layerScope === "profile" ? "project.yaml" : "project.local.yaml");
  if (layerScope === "project_local") fs.writeFileSync(target, "# local comment\ncomponents: {}\n");
  else fs.writeFileSync(target, "# shared comment\n" + fs.readFileSync(target, "utf8"));
  const before = fs.readFileSync(target, "utf8");
  const client = await session(t, "mcp/settings.mjs", [], f);
  const edit = (await client.call("settings.edit", { layerScope, format: "yaml" }))._meta.data;
  assert.equal(edit.text, before);
  const request = { mode: "layer", layerScope, baseRevision: edit.baseRevision, text: before + "\n# trailing comment\n" };
  const reply = await client.call("settings.preview", request), preview = reply.structuredContent;
  assert.equal(preview.textChanged, true);
  assert.equal(reply._meta.data.formattedText, canonical_yaml(request.text));
  await assert.rejects(client.call("settings.apply", { ...request, text: request.text + "# changed\n", revision: preview.revision, replace: true }), /предпросмотра/);
  const applied = (await client.call("settings.apply", { ...request, revision: preview.revision, replace: true })).structuredContent;
  assert.equal(fs.readFileSync(target, "utf8"), reply._meta.data.formattedText);
  assert.equal(fs.readFileSync(applied.backup, "utf8"), before);
  if (layerScope === "project_local") assert.equal(path.relative(f.state, applied.backup).startsWith(".."), false);
  await assert.rejects(client.call("settings.preview", request), /изменились/);
});

test("local backups cannot be written inside the project", async t => {
  const f = fixture(t); f.save();
  f.env.EDT_AI_STATE_DIR = path.join(f.root, "state");
  f.env.EDT_AI_SETTINGS = path.join(f.env.EDT_AI_STATE_DIR, "settings.json");
  const target = path.join(f.root, ".ai", "project.local.yaml");
  fs.writeFileSync(target, "# private\n{}\n");
  const client = await session(t, "mcp/settings.mjs", [], f);
  const edit = (await client.call("settings.edit", { layerScope: "project_local", format: "yaml" }))._meta.data;
  const request = { mode: "layer", layerScope: "project_local", baseRevision: edit.baseRevision, text: "{}\n" };
  const preview = (await client.call("settings.preview", request)).structuredContent;
  await assert.rejects(client.call("settings.apply", { ...request, revision: preview.revision }), /вне проекта/);
  assert.equal(fs.readFileSync(target, "utf8"), "# private\n{}\n");
});

test("local backups cannot be written inside another Git worktree", async t => {
  const f = fixture(t); f.save();
  fs.mkdirSync(path.join(f.state, ".git"));
  const target = path.join(f.root, ".ai", "project.local.yaml");
  fs.writeFileSync(target, "# private\n{}\n");
  const client = await session(t, "mcp/settings.mjs", [], f);
  const edit = (await client.call("settings.edit", { layerScope: "project_local", format: "yaml" }))._meta.data;
  const request = { mode: "layer", layerScope: "project_local", baseRevision: edit.baseRevision, text: "{}\n" };
  const preview = (await client.call("settings.preview", request)).structuredContent;
  await assert.rejects(client.call("settings.apply", { ...request, revision: preview.revision }), /Git-репозитория/);
  assert.equal(fs.readFileSync(target, "utf8"), "# private\n{}\n");
});

test("YAML editor repairs a malformed shared profile without losing its backup", async t => {
  const f = fixture(t); f.save();
  const target = path.join(f.root, ".ai", "project.yaml"), valid = fs.readFileSync(target, "utf8");
  fs.writeFileSync(target, "broken: [\n");
  const client = await session(t, "mcp/settings.mjs", [], f);
  const edit = (await client.call("settings.edit", { layerScope: "profile", format: "yaml" }))._meta.data;
  assert.equal(edit.text, "broken: [\n");
  const request = { mode: "layer", layerScope: "profile", baseRevision: edit.baseRevision, text: valid };
  const reply = await client.call("settings.preview", request), preview = reply.structuredContent;
  const result = (await client.call("settings.apply", { ...request, revision: preview.revision, replace: true })).structuredContent;
  assert.equal(fs.readFileSync(target, "utf8"), canonical_yaml(valid));
  assert.equal(fs.readFileSync(target, "utf8"), reply._meta.data.formattedText);
  assert.equal(fs.readFileSync(result.backup, "utf8"), edit.text);
});

test("creating an empty local file invalidates the editor revision", async t => {
  const f = fixture(t); f.save();
  const client = await session(t, "mcp/settings.mjs", [], f);
  const edit = (await client.call("settings.edit", { layerScope: "project_local", format: "yaml" }))._meta.data;
  fs.writeFileSync(edit.path, "");
  await assert.rejects(client.call("settings.preview", { mode: "layer", layerScope: "project_local", baseRevision: edit.baseRevision, text: "{}\n" }), /изменились/);
});

test("invalid YAML reports its line without exposing document contents", async t => {
  const f = fixture(t); f.save();
  const client = await session(t, "mcp/settings.mjs", [], f);
  const edit = (await client.call("settings.edit", { layerScope: "project_local", format: "yaml" }))._meta.data;
  await assert.rejects(client.call("settings.preview", { mode: "layer", layerScope: "project_local", baseRevision: edit.baseRevision,
    text: "# synthetic-private-value\ncomponents:\n  broken: [\n" }), error => {
    assert.match(error.message, /в строке 4/);
    assert.doesNotMatch(error.message, /synthetic-private-value/);
    return true;
  });
});

test("MCP saves supported fields in the chosen layer and reports masking and revisions", async t => {
  const f = fixture(t); f.save();
  const client = await session(t, "mcp/settings.mjs", [], f);
  const read = async () => (await client.call("settings.read", {})).structuredContent;
  let current = await read();
  const originalRevision = current.settingsRevision;
  const profile = (await client.call("settings.update", { set: { edtUrl: "http://127.0.0.1:8123/mcp", v8stdUrl: "http://127.0.0.1:8124/mcp" }, scope: "profile", expectedRevision: originalRevision })).structuredContent;
  assert.equal(profile.savedTo, current.writePaths.profile);
  assert.ok(fs.existsSync(profile.backup));
  assert.equal(load(profile.savedTo).connections.edt.url, "http://127.0.0.1:8123/mcp");
  current = await read(); assert.equal(current.connectionSources.edt, "profile"); assert.equal(profile.settingsRevision, current.settingsRevision);
  await assert.rejects(client.call("settings.update", { set: { edtUrl: "http://127.0.0.1:8125/mcp" }, scope: "project_local", expectedRevision: originalRevision }), /изменились/);
  await client.call("settings.update", { set: { bslLsEnabled: false }, scope: "profile" });
  assert.equal(load(current.writePaths.profile).components["bsl-ls"].enabled, false);
  current = await read();

  const local = (await client.call("settings.update", { set: { edtUrl: "http://127.0.0.1:8200/mcp", bslLsEnabled: false, bslLsJava: "local-java" }, scope: "project_local", expectedRevision: current.settingsRevision })).structuredContent;
  assert.equal(local.savedTo, current.writePaths.project_local);
  assert.equal(load(local.savedTo).components["bsl-ls"].java, "local-java");
  current = await read(); assert.equal(current.values.bslLsEnabled, false); assert.equal(current.managedValueSources.bslLsJava, "project_local");
  await client.call("settings.update", { set: { edtUrl: "http://127.0.0.1:8300/mcp", bslLsJava: "local-java-2" }, scope: "project_local", expectedRevision: current.settingsRevision });
  current = await read(); assert.equal(current.connectionSources.edt, "project_local"); assert.equal(current.managedValueSources.bslLsJava, "project_local");
  const previousRevision = current.settingsRevision;
  await client.call("settings.update", { set: { bslLsJava: "global-java" }, scope: "global", expectedRevision: previousRevision });
  await assert.rejects(client.call("settings.reset_connection", { connection: "edt", expectedRevision: previousRevision }), /изменились/);
  current = await read(); assert.equal(current.values.bslLsJava, "local-java-2"); assert.equal(current.managedValueSources.bslLsJava, "project_local");
  assert.equal(load(current.writePaths.global).mcp.managed["bsl-ls"].java, "global-java");
});

test("environment URLs remain effective while a lower layer is saved", async t => {
  const f = fixture(t); f.save(); f.env.EDT_AI_EDT_URL = "http://127.0.0.1:9400/mcp";
  const client = await session(t, "mcp/settings.mjs", [], f);
  const before = (await client.call("settings.read", {})).structuredContent;
  assert.equal(before.connectionSources.edt, "environment:EDT_AI_EDT_URL");
  await client.call("settings.update", { set: { edtUrl: "http://127.0.0.1:9401/mcp" }, scope: "project_local", expectedRevision: before.settingsRevision });
  const after = (await client.call("settings.read", {})).structuredContent;
  assert.equal(after.values.edtUrl, f.env.EDT_AI_EDT_URL);
  assert.equal(after.schema.properties.edtUrl.readOnly, true);
  assert.equal(load(after.writePaths.project_local).connections.edt.url, "http://127.0.0.1:9401/mcp");
});

test("masked override URLs are validated before preview or direct writes", async t => {
  const f = fixture(t); f.save();
  const external = path.join(f.base, "connections.yaml");
  dump({ connections: { edt: { url: "http://127.0.0.1:8101/mcp" }, v8std: { url: "http://127.0.0.1:8102/mcp" },
    openviking: { url: "http://127.0.0.1:8103/mcp" } }, components: { "bsl-ls": { url: "http://127.0.0.1:8104/mcp" } } }, external);
  f.env.EDT_AI_CONNECTIONS_FILE = external;
  const client = await session(t, "mcp/settings.mjs", [], f);
  const documents = [
    { connections: { edt: { url: "http://user:password@127.0.0.1:8201/mcp" } } },
    { connections: { v8std: { url: "http://user:password@127.0.0.1:8202/mcp" } } },
    { connections: { openviking: { url: "http://127.0.0.1:8203/mcp?credential=value" } } },
    { components: { "bsl-ls": { url: "http://user:password@127.0.0.1:8204/mcp" } } },
  ];
  for (const layerScope of ["project_local"]) {
    const edit = (await client.call("settings.edit", { layerScope, format:"yaml" }))._meta.data;
    for (const document of documents) await assert.rejects(client.call("settings.preview", {
      mode: "layer", layerScope, baseRevision: edit.baseRevision, text: JSON.stringify(document),
    }), /Некорректный URL MCP|Параметры запроса в URL OpenViking/);
    assert.equal(fs.existsSync(edit.path), false);
  }
  for (const scope of ["project_local", undefined]) {
    await assert.rejects(client.call("settings.update", { set: { openvikingUrl: "http://127.0.0.1:8203/mcp?credential=value" },
      ...(scope ? { scope } : {}) }), /Параметры запроса/);
  }
  assert.equal(fs.existsSync(path.join(f.root, ".ai/project.local.yaml")), false);
});

test("passive settings reads do not expose a pre-existing masked credential URL", async t => {
  const f = fixture(t); f.save();
  const external = path.join(f.base, "connections.yaml");
  dump({ connections: { edt: { url: "http://127.0.0.1:8101/mcp" } } }, external);
  f.env.EDT_AI_CONNECTIONS_FILE = external;
  const local = path.join(f.root, ".ai/project.local.yaml");
  dump({ connections: { edt: { url: "http://user:synthetic-private-value@127.0.0.1:8201/mcp" } } }, local);
  const client = await session(t, "mcp/settings.mjs", [], f);
  const read = await client.call("settings.read", {});
  assert.equal(read.structuredContent.configurationError, true);
  assert.doesNotMatch(JSON.stringify(read), /synthetic-private-value/);
  const edit = (await client.call("settings.edit", { layerScope: "project_local", format:"yaml" }))._meta.data;
  const request = { mode: "layer", layerScope: "project_local", baseRevision: edit.baseRevision, text: '{"schema_version":"0.2"}' };
  const preview = (await client.call("settings.preview", request)).structuredContent;
  await client.call("settings.apply", { ...request, revision: preview.revision });
  assert.equal((await client.call("settings.read", {})).structuredContent.profile.status, "loaded");
});



for (const layerScope of ["project_local"]) test(`MCP validates and saves the complete ${layerScope} override`, async t => {
  const f = fixture(t); f.save(); const client = await session(t, "mcp/settings.mjs", [], f);
  const edit = (await client.call("settings.edit", { layerScope, format:"yaml" }))._meta.data;
  assert.deepEqual(parse(edit.text), {});
  const document = { schema_version: "0.2", connections: { v8std: { url: "http://127.0.0.1:9001/mcp" } },
    components: { "bsl-ls": { java: "custom-java", node: "custom-node", configuration: ".bsl-language-server.json", version: "v2.0.0" } } };
  const args = { text: JSON.stringify(document), mode: "layer", layerScope, baseRevision: edit.baseRevision, projectRoot: f.root };
  const preview = (await client.call("settings.preview", args)).structuredContent;
  assert.equal(preview.layerPath, edit.path); assert.equal(preview.replacesProfile, false);
  assert.ok(preview.layerChanges.some(change => change.path === "components"));
  await client.call("settings.apply", { ...args, revision: preview.revision });
  assert.deepEqual(load(edit.path), document);
  const current = (await client.call("settings.read", {})).structuredContent;
  assert.equal(current.values.v8stdUrl, document.connections.v8std.url);
  assert.equal(current.values.bslLsJava, "custom-java"); assert.equal(current.managedValueSources.bslLsJava, layerScope);
  await assert.rejects(client.call("settings.apply", { ...args, revision: preview.revision }), /изменились/);
  const fresh = (await client.call("settings.edit", { layerScope, format:"yaml" }))._meta.data;
  await assert.rejects(client.call("settings.preview", { ...args, baseRevision: fresh.baseRevision, text: '{"unsupported": true}' }), /неизвестное поле/);
  assert.deepEqual(load(edit.path), document);
});

test("a malformed local override can be repaired through the layer editor", async t => {
  const f = fixture(t); f.save(); const file = path.join(f.root, ".ai/project.local.yaml");
  fs.writeFileSync(file, "connections: [broken\n");
  const client = await session(t, "mcp/settings.mjs", [], f);
  assert.equal((await client.call("settings.read", {})).structuredContent.configurationError, true);
  const edit = (await client.call("settings.edit", { layerScope: "project_local", format:"yaml" }))._meta.data;
  assert.match(edit.text, /broken/);
  const args = { text: '{"schema_version":"0.2","components":{"bsl-ls":{"node":"node"}}}', mode: "layer", layerScope: "project_local", baseRevision: edit.baseRevision, projectRoot: f.root };
  const preview = (await client.call("settings.preview", args)).structuredContent;
  await client.call("settings.apply", { ...args, revision: preview.revision });
  assert.equal((await client.call("settings.read", {})).structuredContent.profile.status, "loaded");
  assert.equal(load(file).components["bsl-ls"].node, "node");
});

test("MCP profile rename creates a minimal local ID and leaves project.yaml byte-for-byte unchanged", async t => {
  const f = fixture(t); f.save();
  const shared = path.join(f.root, ".ai/project.yaml"), local = path.join(f.root, ".ai/project.local.yaml");
  fs.writeFileSync(shared, "\uFEFF# shared profile\r\n" + fs.readFileSync(shared, "utf8").replace(/\r?\n/g, "\r\n"));
  const sharedBefore = fs.readFileSync(shared);
  const client = await session(t, "mcp/settings.mjs", [], f);
  const contract = (await client.request("tools/list")).tools.find(tool => tool.name === "settings.rename_profile");
  assert.match(contract.description, /project\.local\.yaml/);
  assert.equal(contract.inputSchema.additionalProperties, false);
  assert.equal(contract.inputSchema.properties.scope, undefined);
  const initial = (await client.call("settings.read", {})).structuredContent;
  const renamed = (await client.call("settings.rename_profile", { projectId: "  renamed.project  ", expectedRevision: initial.settingsRevision })).structuredContent;
  assert.equal(renamed.status, "renamed");
  assert.deepEqual(load(local), { project: { id: "renamed.project" } });
  assert.deepEqual(fs.readFileSync(shared), sharedBefore, "rename must not write project.yaml, including comments, BOM and CRLF");
  assert.equal(renamed.backup, null);
  assert.equal(fs.existsSync(path.join(f.state, "backups")), false);
  assert.match(renamed.detail, /Vanessa/);
  const updated = (await client.call("settings.read", {})).structuredContent;
  assert.equal(updated.profile.projectId, "renamed.project");
  assert.equal(updated.configurationValues.project.id, "renamed.project");
  assert.equal(updated.configurationSources[JSON.stringify(["project", "id"])], "project_local");
  assert.equal(updated.profileHistory.find(item => item.projectRoot === f.root).projectId, "renamed.project");

  const localBefore = fs.readFileSync(local);
  const repeated = (await client.call("settings.rename_profile", { projectId: "renamed.again", expectedRevision: updated.settingsRevision })).structuredContent;
  assert.equal(repeated.profile.projectId, "renamed.again");
  assert.deepEqual(load(local), { project: { id: "renamed.again" } });
  assert.deepEqual(fs.readFileSync(shared), sharedBefore, "repeated rename must not write project.yaml");
  assert.deepEqual(fs.readFileSync(repeated.backup), localBefore);
  assert.equal(path.dirname(repeated.backup), path.join(f.state, "backups"));
  assert.equal(JSON.parse(fs.readFileSync(path.join(project_directory(f.state, f.root), "profile-history.json"))).projectId, "renamed.again");
  await assert.rejects(client.call("settings.rename_profile", { projectId: "stale", expectedRevision: initial.settingsRevision }), /изменил/);
  assert.equal((await client.call("settings.read", {})).structuredContent.profile.projectId, "renamed.again");
});

for (const existing of [false, true]) test(`rename makes no persistent writes for unchanged, invalid or stale IDs (${existing ? "existing" : "absent"} local file)`, async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  const local = path.join(f.root, ".ai/project.local.yaml"), shared = path.join(f.root, ".ai/project.yaml");
  if (existing) dump({ project: { id: "local-name", purpose: "retained" } }, local);
  const backend = new SettingsBackend(f.state, f.env.EDT_AI_SETTINGS), profile = profile_state(f.root);
  remember_profile(f.state, f.root, profile);
  const expectedRevision = backend.edit_revision(), sharedBefore = fs.readFileSync(shared), localBefore = existing ? fs.readFileSync(local) : null;
  const writes = [], write = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (file, ...args) => {
    if (file !== path.join(f.state, "operation.lock")) writes.push(file);
    return write(file, ...args);
  });
  const unchanged = await backend.main({ action: "rename_profile", projectId: `  ${profile.projectId}  `, expectedRevision });
  assert.equal(unchanged.status, "unchanged");
  for (const projectId of ["", "  ", null, 42, "bad name", "-leading", "кириллица", "x".repeat(65)])
    await assert.rejects(backend.main({ action: "rename_profile", projectId, expectedRevision }), /идентификатор|требуемому формату/i);
  for (const revision of [undefined, "stale"])
    await assert.rejects(backend.main({ action: "rename_profile", projectId: "changed", expectedRevision: revision }), /изменился/);
  assert.deepEqual(writes, [], "only the transient operation lock may be written");
  assert.deepEqual(fs.readFileSync(shared), sharedBefore);
  assert.deepEqual(existing ? fs.readFileSync(local) : null, localBefore);
  assert.equal(fs.existsSync(path.join(f.root, ".ai/.gitignore")), false);
  assert.equal(fs.existsSync(path.join(f.state, "backups")), false);
  assert.equal(fs.existsSync(path.join(f.state, "operation.lock")), false);
});

test("repeated renames preserve unrelated settings and comments in canonical YAML", async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  const local = path.join(f.root, ".ai/project.local.yaml"), shared = path.join(f.root, ".ai/project.yaml"), sharedBefore = fs.readFileSync(shared);
  const original = '\uFEFF# local comment\r\ncomponents:\r\n  bsl-ls: {java: "custom-java"} # retained\nproject:\r\n  purpose: local purpose\r\n  id: "old-name" # project label\r\n# trailing comment\n';
  fs.writeFileSync(local, original);
  const backend = new SettingsBackend(f.state, f.env.EDT_AI_SETTINGS);
  let before = original;
  for (const projectId of ["new-name", "next-name"]) {
    const result = await backend.main({ action: "rename_profile", projectId, expectedRevision: backend.edit_revision() });
    assert.equal(fs.readFileSync(result.backup, "utf8"), before);
    const after = fs.readFileSync(local, "utf8"), expected = parse(before);
    expected.project.id = projectId;
    assert.deepEqual(parse(after), expected);
    assert.equal(after, canonical_yaml(after));
    for (const comment of ["# local comment", "# retained", "# project label", "# trailing comment"]) assert.match(after, new RegExp(comment));
    assert.ok(after.indexOf("components:") < after.indexOf("project:"));
    assert.ok(after.indexOf("purpose:") < after.indexOf("id:"));
    assert.doesNotMatch(after, /\r|^\uFEFF/);
    const read = await backend.main({ action: "read" });
    assert.equal(read.profile.projectId, projectId);
    assert.equal(read.values.bslLsJava, "custom-java");
    assert.equal(read.configurationValues.project.purpose, "local purpose");
    assert.deepEqual(fs.readFileSync(shared), sharedBefore);
    before = after;
  }
});

for (const original of ["project: [broken\n", "project: old-name\n", "unexpected: true\n", Buffer.from([0xff])])
  test(`rename safely rejects a damaged local document (${Buffer.isBuffer(original) ? "UTF-8" : original.trim()})`, async t => {
    const f = fixture(t); environment(t, f.env); f.save();
    const backend = new SettingsBackend(f.state, f.env.EDT_AI_SETTINGS), expectedRevision = backend.edit_revision();
    const local = path.join(f.root, ".ai/project.local.yaml"), shared = path.join(f.root, ".ai/project.yaml"), sharedBefore = fs.readFileSync(shared);
    fs.writeFileSync(local, original);
    await assert.rejects(backend.main({ action: "rename_profile", projectId: "changed", expectedRevision }));
    // Even a revision obtained from the repair editor must not permit rename to replace a broken document.
    await assert.rejects(backend.main({ action: "rename_profile", projectId: "changed", expectedRevision: backend.edit_revision() }), /YAML|ожидался тип|неизвестное поле|UTF-8/i);
    assert.deepEqual(fs.readFileSync(local), Buffer.from(original));
    assert.deepEqual(fs.readFileSync(shared), sharedBefore);
    assert.equal(fs.existsSync(path.join(f.root, ".ai/.gitignore")), false);
    assert.equal(fs.existsSync(path.join(f.state, "backups")), false);
  });

test("rename checks the merged profile before any local write", async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  const backend = new SettingsBackend(f.state, f.env.EDT_AI_SETTINGS);
  const shared = path.join(f.root, ".ai/project.yaml"), local = path.join(f.root, ".ai/project.local.yaml");
  // Each layer passes its partial schema, but the active profile has an unknown repository reference.
  dump({ testing: { commands: [{ id: "test", repository_id: "missing", argv: ["runner"], effects: [] }] } }, local);
  const before = fs.readFileSync(local), sharedBefore = fs.readFileSync(shared);
  await assert.rejects(backend.main({ action: "rename_profile", projectId: "changed", expectedRevision: backend.edit_revision() }), /Неизвестные идентификаторы репозиториев/);
  assert.deepEqual(fs.readFileSync(local), before);
  assert.deepEqual(fs.readFileSync(shared), sharedBefore);
  assert.equal(fs.existsSync(path.join(f.state, "backups")), false);
});



test("malformed profiles can be read as text and repaired through preview and replacement", async t => {
  const f = fixture(t); f.save(); const file = path.join(f.root, ".ai/project.yaml");
  fs.writeFileSync(file, "project: [unterminated\n");
  const client = await session(t, "mcp/settings.mjs", [], f);
  assert.equal((await client.call("settings.read", {})).structuredContent.profile.status, "invalid");
  assert.match((await client.call("settings.edit", {layerScope:"profile",format:"yaml"}))._meta.data.text, /unterminated/);
  const context=(await client.call("settings.transfer_context",{projectRoot:f.root}))._meta.data;
  const input = { documents:{profile:JSON.stringify(f.profile)}, projectRoot: f.root, baseRevision:context.baseRevision };
  const preview = (await client.call("settings.transfer_preview", input))._meta.data;
  await client.call("settings.transfer_apply", { ...input, revision: preview.revision, replace: true });
  assert.equal((await client.call("settings.read", {})).structuredContent.profile.status, "loaded");
});

test("Java probing rejects absent installations and reports the actual executable when available", async t => {
  if (process.platform === "darwin") return t.skip("protected local launch is unavailable on macOS");
  const f = fixture(t);
  await assert.rejects(java_in_directory(f.root), /не найден/);
  let java;
  try { java = await java_info("java"); } catch (error) { if (!which("java")) { t.skip("Java is not installed in PATH"); return; } throw error; }
  assert.ok(path.isAbsolute(java.path)); assert.match(java.version, /^\d/);
  assert.equal((await java_in_directory(path.dirname(java.path))).path, java.path);
});

function inject_java_probe(t, mode, extra = {}) {
  const spawn = childProcess.spawn;
  const preload = new URL("./fixtures/java-probe-inject.mjs", import.meta.url).href;
  const calls = t.mock.method(childProcess, "spawn", (command, args, options) => {
    if (path.basename(args?.[0] || "") !== "process_supervisor.mjs") return spawn(command, args, options);
    extra.inspect?.(options.env);
    return spawn(command, ["--import", preload, ...args], { ...options, env: { ...options.env,
      JAVA_PROBE_TEST_MODE: mode, ...(extra.pids ? { JAVA_PROBE_TEST_PIDS: extra.pids } : {}) } });
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return calls;
}

test("Java probe failure never includes arbitrary process output or error text", async t => {
  if (process.platform === "darwin") return t.skip("protected local launch is unavailable on macOS");
  inject_java_probe(t, "error");
  await assert.rejects(java_info(process.execPath), error => /exit 1/.test(error.message) && !error.message.includes("synthetic-private-value"));
});

test("Java version comes from a version line, not echoed JVM options", async t => {
  if (process.platform === "darwin") return t.skip("protected local launch is unavailable on macOS");
  inject_java_probe(t, "version");
  assert.equal((await java_info(process.execPath)).version, "21.0.2");
});

test("a timed out Java probe terminates its detached descendants before returning", { timeout: 15000, skip: process.platform === "darwin" }, async t => {
  const f = fixture(t), pids = path.join(f.base, "java-probe-pids.json");
  inject_java_probe(t, "hang", { pids });
  const started = Date.now();
  await assert.rejects(java_info(process.execPath, null, process.env, { timeoutMs: 3000, state: f.state }), error => /ETIMEDOUT/.test(error.message));
  assert.ok(Date.now() - started < 12000);
  assert.ok(fs.existsSync(pids), "the process tree must actually have started");
  for (const pid of JSON.parse(fs.readFileSync(pids, "utf8"))) assert.throws(() => process.kill(pid, 0));
  const logs = fs.readFileSync(path.join(f.state, "diagnostics", "events.0.jsonl"), "utf8");
  assert.match(logs, /process_started/); assert.match(logs, /process_stopped/);
  assert.doesNotMatch(logs, /synthetic-private-value/);
});

test("Java probe remains available with invalid settings without inheriting credentials", async t => {
  if (process.platform === "darwin") return t.skip("protected local launch is unavailable on macOS");
  const f = fixture(t), backend = new SettingsBackend(f.state, f.env.EDT_AI_SETTINGS);
  t.mock.method(backend, "current", () => { throw new Error("invalid settings"); });
  inject_java_probe(t, "version", { inspect: env => assert.deepEqual(env, {}) });
  assert.equal((await backend.main({ action: "java_probe", command: process.execPath })).version, "21.0.2");
});

test("failed Java startup does not copy JVM options into operations or the journal", async t => {
  if (!which("java")) return t.skip("Java is not installed in PATH");
  const f = fixture(t); f.save();
  const marker = "synthetic-private-value-498312";
  f.env.JAVA_TOOL_OPTIONS = `-Dcustom.auth=${marker} -XX:DefinitelyInvalidOption`;
  const client = await session(t, "mcp/settings.mjs", [], f);
  let job = (await client.call("settings.check_java", { command: "java" })).structuredContent;
  job = (await client.call("settings.operation", { operationId: job.id, waitMs: 10000 })).structuredContent;
  assert.equal(job.status, "failed");
  const journal = (await client.call("settings.diagnostics", {}))._meta.data;
  assert.equal(JSON.stringify({ job, journal }).includes(marker), false);
});

test("chosen exports write and verify exactly the selected file and reject invalid destinations", t => {
  const f = fixture(t), target = path.join(f.base, "selected.json");
  assert.equal(save_export_to_path(target, { text: "first" }).path, target);
  save_export_to_path(target, { text: "second" }); assert.equal(fs.readFileSync(target, "utf8"), "second");
  assert.throws(() => save_export_to_path(f.root, { text: "data" }), /обычным файлом/);
  assert.throws(() => save_export_to_path(target, { text: "toolong" }, 2), /размер/);
  assert.equal(fs.readFileSync(target, "utf8"), "second");
});

test("settings exposes only the current file-selection and transfer scenario", async t => {
  const f=fixture(t);f.save();const client=await session(t,"mcp/settings.mjs",[],f);
  const names=(await client.request("tools/list")).tools.map(tool=>tool.name);
  assert.ok(names.includes("settings.transfer_preview"));
  assert.equal(names.includes("settings.profile_source"),false);
  assert.equal(names.includes("settings.repair_document"),false);
});

test("MCP file selection keeps contents app-only, prevents protected paths and saves only chosen destinations", async t => {
  const f = fixture(t); f.save(); const { client, choose } = await dialog_session(t, f);
  const source = path.join(f.base, "input.yaml"), output = path.join(f.base, "user-selected.yaml");
  fs.writeFileSync(source, "schema_version: '0.2'\nprivate: example\n"); choose(source);
  let job = (await client.call("settings.pick_import_file", {scope:"profile"})).structuredContent;
  job = (await client.call("settings.operation", { operationId: job.id, waitMs: 10000 })).structuredContent;
  assert.equal(job.status, "completed"); assert.equal(job.result.filename, "input.yaml");
  assert.doesNotMatch(JSON.stringify(job), /private: example/);
  const file = await client.call("settings.import_file", { fileId: job.result.fileId });
  assert.match(file._meta.data.text, /private: example/); assert.equal(file.structuredContent, undefined);
  await assert.rejects(client.call("settings.import_file", { fileId: job.result.fileId }), /устарел/);
  const protectedFile = path.join(f.root, "src", "protected.yaml"); fs.writeFileSync(protectedFile, "{}"); choose(protectedFile);
  job = (await client.call("settings.pick_import_file", {scope:"profile"})).structuredContent;
  job = (await client.call("settings.operation", { operationId: job.id, waitMs: 10000 })).structuredContent;
  assert.equal(job.status, "failed"); assert.match(job.error, /защищённых исходниках/);
  choose(output);
  const saved = (await client.call("settings.transfer_export", {scope:"profile",projectRoot:f.root}))._meta.data;
  assert.equal(saved.path, output); assert.equal(load(output).profile_id, f.profile.profile_id);
  assert.equal(fs.existsSync(path.join(f.state, "exports/1c-ai-core-settings.json")), false);
  const profileFile = path.join(f.root, ".ai/project.yaml"), before = fs.readFileSync(profileFile, "utf8");
  choose(profileFile); await assert.rejects(client.call("settings.transfer_export", {scope:"profile",projectRoot:f.root}), /нельзя заменять файлы настроек проекта/i);
  assert.equal(fs.readFileSync(profileFile, "utf8"), before);
  choose(path.join(f.state, "settings.json")); await assert.rejects(client.call("settings.transfer_export", {scope:"profile",projectRoot:f.root}), /служебное состояние/i);
  choose(null);
  const cancelled = (await client.call("settings.transfer_export", {scope:"profile",projectRoot:f.root}))._meta.data;
  assert.equal(cancelled.cancelled, true); assert.ok(fs.existsSync(output));
});

test("file selection uses the canonical profile root when the chat opens a subdirectory", async t => {
  const f = fixture(t); f.save();
  const subdirectory = path.join(f.root, "subdirectory"); fs.mkdirSync(subdirectory);
  f.env.EDT_AI_PROJECT_ROOT = subdirectory;
  const { client, choose } = await dialog_session(t, f);
  const source = path.join(f.root, "src", "protected.yaml"); fs.writeFileSync(source, "{}"); choose(source);
  let job = (await client.call("settings.pick_import_file", {scope:"profile"})).structuredContent;
  job = (await client.call("settings.operation", { operationId: job.id, waitMs: 10000 })).structuredContent;
  assert.equal(job.status, "failed"); assert.match(job.error, /защищённых исходниках/);
  const profile = path.join(f.root, ".ai", "project.yaml"), before = fs.readFileSync(profile);
  choose(profile); await assert.rejects(client.call("settings.transfer_export", {scope:"profile",projectRoot:f.root}), /нельзя заменять файлы настроек проекта/i);
  assert.deepEqual(fs.readFileSync(profile), before);
});

for (const protectedTarget of [true, false]) test(`settings paths ${protectedTarget ? "reject protected" : "allow unprotected"} directory redirects`, async t => {
  const f = fixture(t);
  const target = path.join(protectedTarget ? path.join(f.root, "src") : f.root, "settings-data"); fs.mkdirSync(target);
  fs.symlinkSync(target, path.join(f.root, ".ai"), process.platform === "win32" ? "junction" : "dir"); f.save();
  const client = await session(t, "mcp/settings.mjs", [], f);
  const args = { scope: "project_local", set: { edtUrl: "http://127.0.0.1:8123/mcp" } };
  if (protectedTarget) {
    assert.equal((await client.call("settings.read", {})).structuredContent.configurationError, true);
    await assert.rejects(client.call("settings.update", args), /Путь настроек перенаправляется в защищённые исходники проекта/);
    await assert.rejects(client.call("settings.rename_profile", { projectId: "changed", expectedRevision: "unavailable" }), /Путь настроек перенаправляется в защищённые исходники проекта/);
    await assert.rejects(client.call("settings.edit", { layerScope: "project_local", format:"yaml" }), /Путь настроек перенаправляется в защищённые исходники проекта/);
    await assert.rejects(client.call("settings.transfer_export", {scope:"profile",projectRoot:f.root}), /Путь настроек перенаправляется в защищённые исходники проекта/);
    assert.equal(fs.existsSync(path.join(target, "project.local.yaml")), false);
  } else {
    await client.call("settings.update", args);
    assert.equal(load(path.join(target, "project.local.yaml")).connections.edt.url, args.set.edtUrl);
  }
});

test("shared settings cannot be redirected into protected sources, including legacy updates", async t => {
  const f = fixture(t); f.save();
  const target = path.join(f.root, "src", "settings-data"); fs.mkdirSync(target);
  const alias = path.join(f.base, "settings-alias");
  fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
  f.env.EDT_AI_SETTINGS = path.join(alias, "settings.json");
  const client = await session(t, "mcp/settings.mjs", [], f);
  for (const scope of ["global", undefined])
    await assert.rejects(client.call("settings.update", { set: { bslLsJava: "java" }, ...(scope ? { scope } : {}) }), /Путь настроек перенаправляется в защищённые исходники проекта/);
  assert.equal(fs.existsSync(path.join(target, "settings.json")), false);
});

test("the state directory cannot redirect into protected sources", async t => {
  const f = fixture(t); f.save();
  const target = path.join(f.root, "src", "state-data"); fs.mkdirSync(target);
  const alias = path.join(f.base, "state-alias");
  fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
  f.env.EDT_AI_STATE_DIR = alias;
  const client = await session(t, "mcp/settings.mjs", [], f);
  await assert.rejects(client.call("settings.update", { scope: "project_local", set: { edtUrl: "http://127.0.0.1:8123/mcp" } }), /Путь настроек перенаправляется в защищённые исходники проекта/);
  assert.equal(fs.existsSync(path.join(target, "projects")), false);
});

test("ambiguous nested profiles protect the selected directory but allow an external support export", async t => {
  const f = fixture(t);
  for (const name of ["first", "second"]) {
    const root = path.join(f.root, name); fs.mkdirSync(root); fs.mkdirSync(path.join(root, "src"));
    dump(f.profile, path.join(root, ".ai", "project.yaml"));
  }
  const { client, choose } = await dialog_session(t, f);
  const protectedFile = path.join(f.root, "src", "protected.yaml"); fs.writeFileSync(protectedFile, "{}"); choose(protectedFile);
  let job = (await client.call("settings.pick_import_file", {scope:"profile"})).structuredContent;
  job = (await client.call("settings.operation", { operationId: job.id, waitMs: 10000 })).structuredContent;
  assert.equal(job.status, "failed"); assert.match(job.error, /защищённых исходниках/);
  const report = path.join(f.base, "report.json"); choose(report);
  assert.equal((await client.call("settings.export_diagnostics", {}))._meta.data.path, report);
  assert.equal(JSON.parse(fs.readFileSync(report, "utf8")).format, "1c-ai-core-diagnostics");
});
