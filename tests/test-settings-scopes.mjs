import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { fixture, session, dialog_session } from "./helpers.mjs";
import { dump, load, parse } from "../scripts/common.mjs";
import { remember_profile } from "../scripts/profile_history.mjs";
import { profile_state } from "../scripts/profile.mjs";
import { java_info, java_in_directory } from "../scripts/runtime.mjs";
import { SettingsBackend } from "../scripts/settings_backend.mjs";
import { which } from "../scripts/processes.mjs";
import { save_export_to_path } from "../scripts/settings_export.mjs";
import { stringify } from "yaml";

for (const layerScope of ["profile", "project_local"]) test(`YAML ${layerScope} editor preserves exact text, backs up and rejects stale previews`, async t => {
  const f = fixture(t); f.save();
  const target = path.join(f.root, ".ai", layerScope === "profile" ? "project.yaml" : "project.local.yaml");
  if (layerScope === "project_local") fs.writeFileSync(target, "# local comment\ncomponents: {}\n");
  else fs.writeFileSync(target, "# shared comment\n" + fs.readFileSync(target, "utf8"));
  const before = fs.readFileSync(target, "utf8");
  const client = await session(t, "mcp/settings.mjs", [], f);
  const edit = (await client.call("settings.edit", { layerScope, format: "yaml" }))._meta.data;
  assert.equal(edit.text, before);
  const request = { mode: "layer", layerScope, baseRevision: edit.baseRevision, text: before + "\n# trailing comment\n" };
  const preview = (await client.call("settings.preview", request)).structuredContent;
  assert.equal(preview.textChanged, true);
  await assert.rejects(client.call("settings.apply", { ...request, text: request.text + "# changed\n", revision: preview.revision, replace: true }), /предпросмотра/);
  const applied = (await client.call("settings.apply", { ...request, revision: preview.revision, replace: true })).structuredContent;
  assert.equal(fs.readFileSync(target, "utf8"), request.text);
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
  const preview = (await client.call("settings.preview", request)).structuredContent;
  const result = (await client.call("settings.apply", { ...request, revision: preview.revision, replace: true })).structuredContent;
  assert.equal(fs.readFileSync(target, "utf8"), valid);
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

test("MCP profile rename changes only project.id and rejects stale or invalid edits", async t => {
  const f = fixture(t); f.save();
  const client = await session(t, "mcp/settings.mjs", [], f);
  const initial = (await client.call("settings.read", {})).structuredContent;
  await assert.rejects(client.call("settings.rename_profile", { projectId: "bad name", expectedRevision: initial.settingsRevision }), /требуемому формату/);
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

test("Java probe remains available with invalid settings without inheriting credentials", async t => {
  const f = fixture(t), backend = new SettingsBackend(f.state, f.env.EDT_AI_SETTINGS);
  t.mock.method(backend, "current", () => { throw new Error("invalid settings"); });
  const original = childProcess.spawnSync;
  try {
    childProcess.spawnSync = (_command, _args, options) => {
      assert.deepEqual(options.env, {});
      return { status: 0, stderr: 'java version "21"' };
    };
    syncBuiltinESMExports();
    assert.equal((await backend.main({ action: "java_probe", command: process.execPath })).version, "21");
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
