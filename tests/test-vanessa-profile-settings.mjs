import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fixture, environment, session } from "./helpers.mjs";
import { SettingsBackend } from "../scripts/settings_backend.mjs";

function setup(t) {
  const f = fixture(t); environment(t, f.env);
  f.profile.testing.vanessa = true;
  f.profile.testing.vanessa_config = { repository_id: "product", runtime_profile: ".ai/vanessa.local.json", features: "features", results: "results", server_name: "vanessa" };
  f.save();
  const user = name => ({ name, password: "secret-9826", interface: "taxi" });
  const runtime = { version: 1, id: "ui-tests", projectRoot: "..", platform: "../1cv8c.exe", runtime: { epf: "../vanessa.epf" },
    manager: { infobase: { type: "server", server: "localhost", database: "manager" }, user: user("Manager") },
    infobase: { type: "file", path: "../base" }, users: { TestClient: user("Test") },
    mcp: { serverName: "vanessa", url: "http://127.0.0.1:19876/mcp", port: 19876 }, features: "../features", results: "../results" };
  const file = path.join(f.root, ".ai", "vanessa.local.json");
  const save = () => fs.writeFileSync(file, JSON.stringify(runtime, null, 2)); save();
  return { ...f, runtime, file, saveRuntime: save, backend: new SettingsBackend() };
}

test("runtime editor reads, validates and saves the complete selected profile with an optimistic revision", async t => {
  const f = setup(t), original = await f.backend.main({ action: "vanessa_read" });
  assert.equal(original.profile.users.TestClient.password, "secret-9826");
  original.profile.users.Operator = { name: "Operator", password: "another-secret", interface: "taxi" };
  original.profile.runtime.paramsFile = "../params.json";
  original.profile.limits = { timeoutMs: 5000, maxBytes: 4096 };
  const saved = await f.backend.main({ action: "vanessa_save", profile: original.profile, expectedRevision: original.revision });
  assert.equal(saved.status, "saved");
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, "utf8")), original.profile);
  assert.notEqual(saved.revision, original.revision);
  await assert.rejects(f.backend.main({ action: "vanessa_save", profile: original.profile, expectedRevision: original.revision }), /изменил/);
});

test("runtime editor creates a draft from the project binding and rejects unsafe or incompatible values", async t => {
  const f = setup(t); fs.unlinkSync(f.file);
  const draft = await f.backend.main({ action: "vanessa_read" });
  assert.equal(draft.exists, false); assert.equal(draft.profile.projectRoot, "..");
  assert.equal(draft.profile.features, "../features"); assert.equal(draft.profile.mcp.serverName, "vanessa");
  await assert.rejects(f.backend.main({ action: "vanessa_save", profile: draft.profile, expectedRevision: draft.revision }));
  for (const mutate of [
    p => { p.projectRoot = "../other"; },
    p => { p.features = "../other"; },
    p => { p.mcp.serverName = "other"; },
    p => { p.mcp.url = "https://example.com/mcp"; },
    p => { p.manager.infobase.server = "bad;server"; },
  ]) {
    const profile = structuredClone(f.runtime); mutate(profile);
    await assert.rejects(f.backend.main({ action: "vanessa_save", profile, expectedRevision: draft.revision }));
    assert.equal(fs.existsSync(f.file), false);
  }
  await f.backend.main({ action: "vanessa_save", profile: f.runtime, expectedRevision: draft.revision });
  assert.equal(fs.existsSync(f.file), true);
});

test("runtime editor refuses protected source paths and invalidates drafts when project bindings change", async t => {
  const f = setup(t), draft = await f.backend.main({ action: "vanessa_read" });
  f.profile.testing.vanessa_config.server_name = "other"; f.save();
  await assert.rejects(f.backend.main({ action: "vanessa_save", profile: draft.profile, expectedRevision: draft.revision }), /изменил/);
  f.profile.testing.vanessa_config.runtime_profile = "src/runtime.json"; f.save();
  await assert.rejects(f.backend.main({ action: "vanessa_read" }), /защищённых исходниках/);
});

test("runtime profile containing passwords must be untracked and ignored by Git", async t => {
  const f = setup(t), git = (...args) => spawnSync("git", ["-C", f.root, ...args], { windowsHide: true, encoding: "utf8" });
  assert.equal(git("init", "-q").status, 0);
  const draft = await f.backend.main({ action: "vanessa_read" }); draft.profile.id = "changed";
  await assert.rejects(f.backend.main({ action: "vanessa_save", profile: draft.profile, expectedRevision: draft.revision }), /Исключите runtime-профиль/);
  fs.writeFileSync(path.join(f.root, ".gitignore"), ".ai/vanessa.local.json\n");
  await f.backend.main({ action: "vanessa_save", profile: draft.profile, expectedRevision: draft.revision });
  assert.equal(git("add", "-f", ".ai/vanessa.local.json").status, 0);
  const tracked = await f.backend.main({ action: "vanessa_read" }); tracked.profile.id = "tracked";
  await assert.rejects(f.backend.main({ action: "vanessa_save", profile: tracked.profile, expectedRevision: tracked.revision }), /отслеживается Git/);
});

test("manager launch preview is bound to the exact project and runtime bytes", async t => {
  const f = setup(t), prepared = await f.backend.main({ action: "vanessa_prepare" });
  assert.equal(prepared.target.project, f.profile.project.id);
  assert.equal(prepared.target.manager.database, "manager");
  assert.equal(JSON.stringify(prepared).includes("secret-9826"), false);
  const authorization = { scope: prepared.scope, effects: ["launch"], evidence: "Пользователь подтвердил запуск менеджера в тесте." };
  f.runtime.manager.user.password = "changed-secret"; f.saveRuntime();
  await assert.rejects(f.backend.main({ action: "vanessa_start", authorization, expectedRevision: prepared.revision }), /изменил/);
  const fresh = await f.backend.main({ action: "vanessa_prepare" });
  await assert.rejects(f.backend.main({ action: "vanessa_start", authorization: { ...authorization, effects: [] }, expectedRevision: fresh.revision }), /разрешение/);
  await assert.rejects(f.backend.main({ action: "vanessa_start", authorization, expectedRevision: fresh.revision }), /отличаются/);
});

test("MCP returns runtime credentials only in app metadata and never in public content", async t => {
  const f = setup(t), client = await session(t, "mcp/settings.mjs", [], f);
  const result = await client.request("tools/call", { name: "settings.vanessa_read", arguments: {} });
  assert.equal(result.isError, undefined);
  assert.equal(result._meta.data.profile.manager.user.password, "secret-9826");
  assert.equal(JSON.stringify({ content: result.content, structuredContent: result.structuredContent }).includes("secret-9826"), false);
});

test("MCP starts the approved scoped operation and reports a pre-launch missing platform", async t => {
  const f = setup(t), client = await session(t, "mcp/settings.mjs", [], f);
  const call = (name, args = {}) => client.request("tools/call", { name, arguments: args });
  const prepared = (await call("settings.vanessa_prepare"))._meta.data;
  const authorization = { scope: prepared.scope, effects: ["launch"], evidence: "Пользователь подтвердил показанную цель в тесте." };
  const started = await call("settings.vanessa_start", { authorization, expectedRevision: prepared.revision });
  assert.equal(started.structuredContent.action, "vanessa_start");
  let operation = started.structuredContent;
  for (let attempt = 0; attempt < 6 && operation.status === "running"; attempt++)
    operation = (await call("settings.operation", { operationId: operation.id, waitMs: 3000 })).structuredContent;
  assert.equal(operation.status, "failed");
  assert.match(operation.error, /ENOENT|файл|Windows/);
  assert.equal(JSON.stringify(operation).includes("secret-9826"), false);
  assert.equal(fs.existsSync(path.join(f.root, "1cv8c.exe")), false);
});
