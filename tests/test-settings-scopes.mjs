import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { fixture, session, dialog_session } from "./helpers.mjs";
import { dump, load } from "../scripts/common.mjs";
import { remember_profile } from "../scripts/profile_history.mjs";
import { profile_state } from "../scripts/profile.mjs";
import { java_info, java_in_directory } from "../scripts/runtime.mjs";
import { which } from "../scripts/processes.mjs";
import { save_export_to_path } from "../scripts/settings_export.mjs";
import { stringify } from "yaml";

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
  await assert.rejects(client.call("settings.update", { set: { edtUrl: "http://127.0.0.1:8125/mcp" }, scope: "instance", expectedRevision: originalRevision }), /изменились/);
  await assert.rejects(client.call("settings.update", { set: { bslLsEnabled: false }, scope: "profile" }), /нельзя сохранить/);
  await assert.rejects(client.call("settings.update", { set: { edtUrl: "" }, scope: "profile" }), /pattern|шаблон/i);

  const local = (await client.call("settings.update", { set: { edtUrl: "http://127.0.0.1:8200/mcp", bslLsEnabled: false, bslLsJava: "local-java" }, scope: "project_local", expectedRevision: current.settingsRevision })).structuredContent;
  assert.equal(local.savedTo, current.writePaths.project_local);
  assert.equal(load(local.savedTo).components["bsl-ls"].java, "local-java");
  current = await read(); assert.equal(current.values.bslLsEnabled, false); assert.equal(current.managedValueSources.bslLsJava, "project_local");
  await client.call("settings.update", { set: { edtUrl: "http://127.0.0.1:8300/mcp", bslLsJava: "instance-java" }, scope: "instance", expectedRevision: current.settingsRevision });
  current = await read(); assert.equal(current.connectionSources.edt, "instance"); assert.equal(current.managedValueSources.bslLsJava, "instance");
  const previousRevision = current.settingsRevision;
  await client.call("settings.update", { set: { bslLsJava: "global-java" }, scope: "global", expectedRevision: previousRevision });
  await assert.rejects(client.call("settings.reset_connection", { connection: "edt", expectedRevision: previousRevision }), /изменились/);
  current = await read(); assert.equal(current.values.bslLsJava, "instance-java"); assert.equal(current.managedValueSources.bslLsJava, "instance");
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
  for (const layerScope of ["project_local", "instance"]) {
    const edit = (await client.call("settings.edit", { layerScope }))._meta.data;
    for (const document of documents) await assert.rejects(client.call("settings.preview", {
      mode: "layer", layerScope, baseRevision: edit.baseRevision, text: JSON.stringify(document),
    }), /credentials|query parameters/i);
    assert.equal(fs.existsSync(edit.path), false);
  }
  for (const scope of ["project_local", "instance", undefined]) {
    await assert.rejects(client.call("settings.update", { set: { openvikingUrl: "http://127.0.0.1:8203/mcp?credential=value" },
      ...(scope ? { scope } : {}) }), /query parameters/i);
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
  const edit = (await client.call("settings.edit", { layerScope: "project_local" }))._meta.data;
  const request = { mode: "layer", layerScope: "project_local", baseRevision: edit.baseRevision, text: '{"schema_version":"0.1"}' };
  const preview = (await client.call("settings.preview", request)).structuredContent;
  await client.call("settings.apply", { ...request, revision: preview.revision });
  assert.equal((await client.call("settings.read", {})).structuredContent.profile.status, "loaded");
});

test("profile and global documents are edited separately with guarded previews and exact readback", async t => {
  const f = fixture(t); f.save();
  const client = await session(t, "mcp/settings.mjs", [], f);
  await client.call("settings.update", { scope: "global", set: { bslLsJava: "before-java" } });
  const current = (await client.call("settings.read", {})).structuredContent;
  const globalBefore = fs.readFileSync(current.writePaths.global), globalTime = fs.statSync(current.writePaths.global).mtimeMs;
  const profileBefore = fs.readFileSync(current.writePaths.profile);
  const edit = (await client.call("settings.edit", { layerScope: "profile" }))._meta.data;
  assert.equal(edit.path, current.writePaths.profile);
  const profile = JSON.parse(edit.text); assert.equal(profile.project.id, f.profile.project.id); assert.equal(profile.settings, undefined);
  profile.project.purpose = "Updated through the profile document";
  const request = { mode: "layer", layerScope: "profile", baseRevision: edit.baseRevision, text: stringify(profile), projectRoot: f.root };
  const preview = (await client.call("settings.preview", request)).structuredContent;
  assert.equal(preview.layerPath, current.writePaths.profile); assert.equal(preview.replacesProfile, true);
  assert.ok(preview.layerChanges.some(change => change.path === "project.purpose"));
  await assert.rejects(client.call("settings.apply", { ...request, revision: preview.revision }), /замену/);
  await assert.rejects(client.call("settings.apply", { ...request, text: request.text + "\n", revision: preview.revision, replace: true }), /предпросмотра/);
  const result = (await client.call("settings.apply", { ...request, revision: preview.revision, replace: true })).structuredContent;
  assert.equal(result.savedTo, current.writePaths.profile); assert.deepEqual(fs.readFileSync(result.backup), profileBefore);
  assert.equal(load(current.writePaths.profile).project.purpose, profile.project.purpose);
  assert.deepEqual(fs.readFileSync(current.writePaths.global), globalBefore);
  assert.equal(fs.statSync(current.writePaths.global).mtimeMs, globalTime);

  const savedProfile = fs.readFileSync(current.writePaths.profile), profileTime = fs.statSync(current.writePaths.profile).mtimeMs;
  const globalEdit = (await client.call("settings.edit", { layerScope: "global" }))._meta.data;
  assert.equal(globalEdit.path, current.writePaths.global);
  const globalDocument = JSON.parse(globalEdit.text);
  assert.equal(globalDocument.mcp.managed["bsl-ls"].java, "before-java"); assert.equal(globalDocument.profile, undefined);
  globalDocument.mcp.managed["bsl-ls"].java = "after-java";
  const globalRequest = { mode: "layer", layerScope: "global", baseRevision: globalEdit.baseRevision, text: stringify(globalDocument), projectRoot: f.root };
  const globalPreview = (await client.call("settings.preview", globalRequest)).structuredContent;
  assert.equal(globalPreview.layerPath, current.writePaths.global); assert.equal(globalPreview.replacesProfile, false);
  const saved = (await client.call("settings.apply", { ...globalRequest, revision: globalPreview.revision })).structuredContent;
  assert.equal(saved.savedTo, current.writePaths.global);
  assert.equal(load(current.writePaths.global).mcp.managed["bsl-ls"].java, "after-java");
  assert.deepEqual(fs.readFileSync(current.writePaths.profile), savedProfile);
  assert.equal(fs.statSync(current.writePaths.profile).mtimeMs, profileTime);
  const next = (await client.call("settings.edit", { layerScope: "global" }))._meta.data;
  await assert.rejects(client.call("settings.preview", { ...globalRequest, baseRevision: next.baseRevision, text: stringify({ mcp: globalDocument.mcp, unexpected: true }) }), /недопустим/i);
  await client.call("settings.update", { scope: "instance", set: { edtUrl: "http://127.0.0.1:9999/mcp" } });
  await assert.rejects(client.call("settings.preview", { mode: "layer", layerScope: "global", baseRevision: next.baseRevision, text: next.text }), /изменились/);
});

test("saving a global document creates its file even when its values equal defaults", async t => {
  const f = fixture(t); f.save(); const client = await session(t, "mcp/settings.mjs", [], f);
  const edit = (await client.call("settings.edit", { layerScope: "global" }))._meta.data;
  assert.equal(fs.existsSync(edit.path), false);
  const request = { mode: "layer", layerScope: "global", baseRevision: edit.baseRevision, text: edit.text };
  const preview = (await client.call("settings.preview", request)).structuredContent;
  const saved = (await client.call("settings.apply", { ...request, revision: preview.revision })).structuredContent;
  assert.equal(saved.savedTo, edit.path);
  assert.deepEqual(load(edit.path).mcp.managed, JSON.parse(edit.text).mcp.managed);
});

for (const layerScope of ["project_local", "instance"]) test(`MCP JSON editor validates and saves the complete ${layerScope} override`, async t => {
  const f = fixture(t); f.save(); const client = await session(t, "mcp/settings.mjs", [], f);
  const edit = (await client.call("settings.edit", { layerScope }))._meta.data;
  assert.equal(JSON.parse(edit.text).schema_version, "0.1");
  const document = { schema_version: "0.1", connections: { v8std: { url: "http://127.0.0.1:9001/mcp" } },
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
  const fresh = (await client.call("settings.edit", { layerScope }))._meta.data;
  await assert.rejects(client.call("settings.preview", { ...args, baseRevision: fresh.baseRevision, text: '{"unsupported": true}' }), /additional properties/i);
  assert.deepEqual(load(edit.path), document);
});

test("a malformed local override can be repaired through the layer editor", async t => {
  const f = fixture(t); f.save(); const file = path.join(f.root, ".ai/project.local.yaml");
  fs.writeFileSync(file, "connections: [broken\n");
  const client = await session(t, "mcp/settings.mjs", [], f);
  assert.equal((await client.call("settings.read", {})).structuredContent.configurationError, true);
  const edit = (await client.call("settings.edit", { layerScope: "project_local" }))._meta.data;
  assert.match(edit.text, /broken/);
  const args = { text: '{"schema_version":"0.1","components":{"bsl-ls":{"node":"node"}}}', mode: "layer", layerScope: "project_local", baseRevision: edit.baseRevision, projectRoot: f.root };
  const preview = (await client.call("settings.preview", args)).structuredContent;
  await client.call("settings.apply", { ...args, revision: preview.revision });
  assert.equal((await client.call("settings.read", {})).structuredContent.profile.status, "loaded");
  assert.equal(load(file).components["bsl-ls"].node, "node");
});

test("MCP profile rename changes only project.id and rejects stale or invalid edits", async t => {
  const f = fixture(t); f.save();
  const client = await session(t, "mcp/settings.mjs", [], f);
  const initial = (await client.call("settings.read", {})).structuredContent;
  await assert.rejects(client.call("settings.rename_profile", { projectId: "bad name", expectedRevision: initial.settingsRevision }), /pattern|шаблон/i);
  const renamed = (await client.call("settings.rename_profile", { projectId: "renamed.project", expectedRevision: initial.settingsRevision })).structuredContent;
  const document = load(initial.writePaths.profile);
  assert.equal(document.project.id, "renamed.project");
  assert.equal(document.profile_id, f.profile.profile_id);
  assert.deepEqual(document.repositories, f.profile.repositories);
  assert.equal(load(renamed.backup).project.id, f.profile.project.id);
  assert.match(renamed.detail, /Vanessa/);
  await assert.rejects(client.call("settings.rename_profile", { projectId: "stale", expectedRevision: initial.settingsRevision }), /изменил/);
  const updated = (await client.call("settings.read", {})).structuredContent;
  assert.equal(updated.profile.projectId, "renamed.project");
});

test("registered profile import is validated in the target and excludes machine settings by default", async t => {
  const f = fixture(t); f.save();
  const other = path.join(f.base, "source"); fs.mkdirSync(other); fs.mkdirSync(path.join(other, "src"));
  const source = structuredClone(f.profile); source.project.id = "source";
  source.connections = { edt: { url: "http://127.0.0.1:9999/mcp" } };
  source.testing.commands = [{ id: "machine-test", repository_id: "product", argv: ["node", "C:\\local\\runner.js"], effects: [] }];
  dump(source, path.join(other, ".ai/project.yaml"));
  dump({ components: { "bsl-ls": { java: "private-java" } } }, path.join(other, ".ai/project.local.yaml"));
  remember_profile(f.state, other, profile_state(other));
  const client = await session(t, "mcp/settings.mjs", [], f);
  const portable = (await client.call("settings.profile_source", { sourceRoot: other }))._meta.data;
  assert.equal(JSON.parse(portable.text).connections, undefined);
  assert.equal(portable.localOverridesIncluded, false);
  const withConnections = (await client.call("settings.profile_source", { sourceRoot: other, includeConnections: true }))._meta.data;
  assert.equal(JSON.parse(withConnections.text).connections.edt.url, source.connections.edt.url);
  await assert.rejects(client.call("settings.profile_source", { sourceRoot: f.root }), /другой доступный/);
  const input = { text: withConnections.text, projectRoot: f.root, includeMachineSettings: false };
  const preview = (await client.call("settings.preview", input)).structuredContent;
  assert.equal(preview.replacesProfile, true);
  assert.deepEqual(preview.omittedTestingCommands, ["machine-test"]);
  assert.deepEqual(preview.projectSpecific.edtMappings, [{ repository: "product", project: "Product", status: "not_detected" }]);
  await assert.rejects(client.call("settings.apply", { ...input, revision: preview.revision }), /Подтвердите замену/);
  await client.call("settings.apply", { ...input, revision: preview.revision, replace: true });
  const imported = load(path.join(f.root, ".ai/project.yaml"));
  assert.equal(imported.project.id, "source"); assert.equal(imported.connections, undefined);
  assert.deepEqual(imported.testing.commands, []);
  assert.equal(fs.existsSync(path.join(f.root, ".ai/project.local.yaml")), false);
  const bad = structuredClone(source); bad.repositories[0].path = "absent";
  await assert.rejects(client.call("settings.preview", { text: JSON.stringify(bad), projectRoot: f.root, includeMachineSettings: false }), /отсутствует репозиторий/);
});

test("file import omits machine paths unless explicitly selected and reports missing paths", async t => {
  const f = fixture(t); f.save();
  fs.writeFileSync(path.join(f.root, ".project"), "<projectDescription><name>Product</name></projectDescription>");
  const client = await session(t, "mcp/settings.mjs", [], f);
  const exported = (await client.call("settings.export_data", {}))._meta.data;
  const data = JSON.parse(exported.text);
  data.settings.mcp.managed["bsl-ls"].java = "foreign-java";
  data.settings.mcp.managed["bsl-ls"].mode = "external";
  data.settings.mcp.managed["bsl-ls"].url = "http://127.0.0.1:9998/mcp";
  data.profile.connections = { v8std: { url: "http://127.0.0.1:9000/mcp" } };
  data.profile.testing.commands = [{ id: "machine-test", repository_id: "product", argv: ["node", "C:\\local\\runner.js"], effects: [] }];
  data.profile.roots.source.push("missing-source");
  const text = JSON.stringify(data);
  const safe = (await client.call("settings.preview", { text, includeMachineSettings: false })).structuredContent;
  assert.deepEqual(safe.missingPaths, ["missing-source"]);
  assert.equal(safe.connectionUrls.v8std, "");
  assert.deepEqual(safe.omittedTestingCommands, ["machine-test"]);
  assert.equal(safe.projectSpecific.testing.commands, 0);
  assert.deepEqual(safe.projectSpecific.edtMappings, [{ repository: "product", project: "Product", status: "detected" }]);
  assert.equal(safe.sharedRuntimeChanges["bsl-ls"], undefined);
  fs.writeFileSync(path.join(f.root, ".project"), "<projectDescription><name>Different</name></projectDescription>");
  await assert.rejects(client.call("settings.apply", { text, includeMachineSettings: false, revision: safe.revision, replace: true }), /предпросмотра/);
  fs.writeFileSync(path.join(f.root, ".project"), "<projectDescription><name>Product</name></projectDescription>");
  const full = (await client.call("settings.preview", { text, includeMachineSettings: true })).structuredContent;
  assert.equal(full.connectionUrls.v8std, "http://127.0.0.1:9000/mcp");
  assert.equal(full.projectSpecific.testing.commands, 1);
  const legacy = (await client.call("settings.preview", { text })).structuredContent;
  assert.equal(legacy.projectSpecific.testing.commands, 1);
  assert.equal(full.sharedRuntimeChanges["bsl-ls"].java, "foreign-java");
  assert.equal(full.sharedRuntimeChanges["bsl-ls"].mode, "external");
  await assert.rejects(client.call("settings.apply", { text, includeMachineSettings: true, revision: safe.revision, replace: true }), /предпросмотра/);
});

test("malformed profiles can be read as text and repaired through preview and replacement", async t => {
  const f = fixture(t); f.save(); const file = path.join(f.root, ".ai/project.yaml");
  fs.writeFileSync(file, "project: [unterminated\n");
  const client = await session(t, "mcp/settings.mjs", [], f);
  assert.equal((await client.call("settings.read", {})).structuredContent.profile.status, "invalid");
  assert.match((await client.call("settings.repair_document", {}))._meta.data.text, /unterminated/);
  const input = { text: JSON.stringify(f.profile), projectRoot: f.root, includeMachineSettings: true };
  const preview = (await client.call("settings.preview", input)).structuredContent;
  await client.call("settings.apply", { ...input, revision: preview.revision, replace: true });
  assert.equal((await client.call("settings.read", {})).structuredContent.profile.status, "loaded");
});

test("Java probing rejects absent installations and reports the actual executable when available", t => {
  const f = fixture(t);
  assert.throws(() => java_in_directory(f.root), /не найден/);
  let java;
  try { java = java_info("java"); } catch { t.skip("Java is not installed in PATH"); return; }
  assert.ok(path.isAbsolute(java.path)); assert.match(java.version, /^\d/);
  assert.equal(java_in_directory(path.dirname(java.path)).path, java.path);
});

test("Java probe failure never includes arbitrary process output or error text", () => {
  const original = childProcess.spawnSync;
  try {
    childProcess.spawnSync = () => ({ status: 1, stderr: "Picked up JAVA_TOOL_OPTIONS: -Dauth=synthetic-private-value\n" });
    syncBuiltinESMExports();
    assert.throws(() => java_info(process.execPath), error => /exit 1/.test(error.message) && !error.message.includes("synthetic-private-value"));
    childProcess.spawnSync = () => ({ status: null, error: Object.assign(new Error("synthetic-private-value"), { code: "ETIMEDOUT" }) });
    syncBuiltinESMExports();
    assert.throws(() => java_info(process.execPath), error => /ETIMEDOUT/.test(error.message) && !error.message.includes("synthetic-private-value"));
    childProcess.spawnSync = () => ({ status: 0, stderr: 'Picked up JAVA_TOOL_OPTIONS: -Dauth=version "2synthetic-private-value"\nopenjdk version "21.0.2"\n' });
    syncBuiltinESMExports();
    assert.equal(java_info(process.execPath).version, "21.0.2");
  } finally { childProcess.spawnSync = original; syncBuiltinESMExports(); }
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

test("MCP file selection keeps contents app-only, prevents protected paths and saves only chosen destinations", async t => {
  const f = fixture(t); f.save(); const { client, choose } = await dialog_session(t, f);
  const source = path.join(f.base, "input.yaml"), output = path.join(f.base, "user-selected.json");
  fs.writeFileSync(source, "schema_version: '0.2'\nprivate: example\n"); choose(source);
  let job = (await client.call("settings.pick_import_file", {})).structuredContent;
  job = (await client.call("settings.operation", { operationId: job.id, waitMs: 10000 })).structuredContent;
  assert.equal(job.status, "completed"); assert.equal(job.result.filename, "input.yaml");
  assert.doesNotMatch(JSON.stringify(job), /private: example/);
  const file = await client.call("settings.import_file", { fileId: job.result.fileId });
  assert.match(file._meta.data.text, /private: example/); assert.equal(file.structuredContent, undefined);
  await assert.rejects(client.call("settings.import_file", { fileId: job.result.fileId }), /устарел/);
  const protectedFile = path.join(f.root, "src", "protected.json"); fs.writeFileSync(protectedFile, "{}"); choose(protectedFile);
  job = (await client.call("settings.pick_import_file", {})).structuredContent;
  job = (await client.call("settings.operation", { operationId: job.id, waitMs: 10000 })).structuredContent;
  assert.equal(job.status, "failed"); assert.match(job.error, /защищённых исходниках/);
  choose(output);
  const saved = (await client.call("settings.save_export", {}))._meta.data;
  assert.equal(saved.path, output); assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).format, "1c-ai-core-settings");
  assert.equal(fs.existsSync(path.join(f.state, "exports/1c-ai-core-settings.json")), false);
  const profileFile = path.join(f.root, ".ai/project.yaml"), before = fs.readFileSync(profileFile, "utf8");
  choose(profileFile); await assert.rejects(client.call("settings.save_export", {}), /нельзя заменять файлы настроек проекта/i);
  assert.equal(fs.readFileSync(profileFile, "utf8"), before);
  choose(path.join(f.state, "settings.json")); await assert.rejects(client.call("settings.save_export", {}), /служебное состояние/i);
  choose(null);
  const cancelled = (await client.call("settings.save_export", {}))._meta.data;
  assert.equal(cancelled.cancelled, true); assert.ok(fs.existsSync(output));
});

test("file selection uses the canonical profile root when the chat opens a subdirectory", async t => {
  const f = fixture(t); f.save();
  const subdirectory = path.join(f.root, "subdirectory"); fs.mkdirSync(subdirectory);
  f.env.EDT_AI_PROJECT_ROOT = subdirectory;
  const { client, choose } = await dialog_session(t, f);
  const source = path.join(f.root, "src", "protected.json"); fs.writeFileSync(source, "{}"); choose(source);
  let job = (await client.call("settings.pick_import_file", {})).structuredContent;
  job = (await client.call("settings.operation", { operationId: job.id, waitMs: 10000 })).structuredContent;
  assert.equal(job.status, "failed"); assert.match(job.error, /защищённых исходниках/);
  const profile = path.join(f.root, ".ai", "project.yaml"), before = fs.readFileSync(profile);
  choose(profile); await assert.rejects(client.call("settings.save_export", {}), /нельзя заменять файлы настроек проекта/i);
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
    await assert.rejects(client.call("settings.update", args), /redirects into protected project source/);
    await assert.rejects(client.call("settings.edit", { layerScope: "project_local" }), /redirects into protected project source/);
    await assert.rejects(client.call("settings.export_data", {}), /redirects into protected project source/);
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
    await assert.rejects(client.call("settings.update", { set: { bslLsJava: "java" }, ...(scope ? { scope } : {}) }), /redirects into protected project source/);
  assert.equal(fs.existsSync(path.join(target, "settings.json")), false);
});

test("an instance settings directory cannot redirect into protected sources", async t => {
  const f = fixture(t); f.save();
  const target = path.join(f.root, "src", "state-data"); fs.mkdirSync(target);
  const alias = path.join(f.base, "state-alias");
  fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
  f.env.EDT_AI_STATE_DIR = alias;
  const client = await session(t, "mcp/settings.mjs", [], f);
  await assert.rejects(client.call("settings.update", { scope: "instance", set: { edtUrl: "http://127.0.0.1:8123/mcp" } }), /redirects into protected project source/);
  assert.equal(fs.existsSync(path.join(target, "projects")), false);
});

test("ambiguous nested profiles protect the selected directory but allow an external support export", async t => {
  const f = fixture(t);
  for (const name of ["first", "second"]) {
    const root = path.join(f.root, name); fs.mkdirSync(root); fs.mkdirSync(path.join(root, "src"));
    dump(f.profile, path.join(root, ".ai", "project.yaml"));
  }
  const { client, choose } = await dialog_session(t, f);
  const protectedFile = path.join(f.root, "src", "protected.json"); fs.writeFileSync(protectedFile, "{}"); choose(protectedFile);
  let job = (await client.call("settings.pick_import_file", {})).structuredContent;
  job = (await client.call("settings.operation", { operationId: job.id, waitMs: 10000 })).structuredContent;
  assert.equal(job.status, "failed"); assert.match(job.error, /защищённых исходниках/);
  const report = path.join(f.base, "report.json"); choose(report);
  assert.equal((await client.call("settings.export_diagnostics", {}))._meta.data.path, report);
  assert.equal(JSON.parse(fs.readFileSync(report, "utf8")).format, "1c-ai-core-diagnostics");
});
