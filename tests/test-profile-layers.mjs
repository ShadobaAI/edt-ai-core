import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, environment, node, success, ROOT } from "./helpers.mjs";
import { dump, load, settings } from "../scripts/common.mjs";
import { project_profile, profile_state } from "../scripts/profile.mjs";
import { resolved_settings, instance_file } from "../scripts/project_context.mjs";
import { SettingsBackend } from "../scripts/settings_backend.mjs";
import { remember_profile } from "../scripts/profile_history.mjs";

test("profile layers merge every field, replace arrays and protect shared boundaries", t => {
  const f = fixture(t); environment(t, f.env);
  f.profile.components = { "bsl-ls": { configuration: "shared.json", allow_prerelease: true } };
  f.profile.testing.commands = [];
  f.save();
  const file = path.join(f.root, ".ai/project.local.yaml");
  dump({ project: { purpose: "local purpose" }, components: { "bsl-ls": { configuration: "local.json" } }, testing: { commands: [] } }, file);
  const p = project_profile(f.root);
  assert.equal(p.project.purpose, "local purpose");
  assert.equal(p.project.id, f.profile.project.id);
  assert.equal(p.components["bsl-ls"].configuration, "local.json");
  assert.equal(p.components["bsl-ls"].allow_prerelease, true);
  assert.equal(resolved_settings(settings(f.env.EDT_AI_SETTINGS), f.root, p)[0].mcp.managed["bsl-ls"].configuration, "local.json");
  dump({ roots: { protected: [] } }, file);
  assert.throws(() => project_profile(f.root), /cannot weaken/);
  dump({ roots: { protected: ["."] } }, file);
  assert.deepEqual(project_profile(f.root).roots.protected, ["."]);
  dump({ project: { purpose: "local" } }, file);
  f.profile.schema_version = "0.1"; f.save();
  dump({ schema_version: "0.2" }, file);
  assert.throws(() => project_profile(f.root), e => e.code === "UNSUPPORTED_CONTRACT_VERSION");
});

test("partial shared profile and local overlay are edited, validated and exported separately", async t => {
  const f = fixture(t); environment(t, f.env);
  const local = path.join(f.root, ".ai/project.local.yaml");
  const purpose = f.profile.project.purpose;
  delete f.profile.project.purpose;
  f.save(); dump({ project: { purpose }, components: { "bsl-ls": { configuration: "private.json" } } }, local);
  const backend = new SettingsBackend(f.state, f.env.EDT_AI_SETTINGS);
  const edit = await backend.main({ action: "edit", layerScope: "profile" });
  const document = JSON.parse(edit.text);
  document.components = { "bsl-ls": { configuration: "shared.json" } };
  const args = { action: "preview", mode: "layer", layerScope: "profile", baseRevision: edit.baseRevision, text: JSON.stringify(document) };
  const preview = await backend.main(args);
  await backend.main({ ...args, action: "apply", revision: preview.revision, replace: true });
  assert.equal(load(path.join(f.root, ".ai/project.yaml")).components["bsl-ls"].configuration, "shared.json");
  assert.equal(project_profile(f.root).components["bsl-ls"].configuration, "private.json");
  const exported = JSON.parse((await backend.main({ action: "export" })).text).profile;
  assert.equal(exported.project.purpose, undefined);
  assert.equal(exported.components["bsl-ls"].configuration, "shared.json");
  success(node("scripts/profile.mjs", ["validate", path.join(f.root, ".ai/project.yaml")], { env: f.env }));
  const out = path.join(f.base, "export.yaml");
  success(node("scripts/profile.mjs", ["export", f.root, "--output", out], { env: f.env }));
  assert.equal(load(out).components["bsl-ls"].configuration, "shared.json");
  success(node("scripts/profile.mjs", ["import", f.root, "--input", out, "--replace"], { env: f.env }));
  assert.equal(load(path.join(f.root, ".ai/project.yaml")).project.purpose, undefined);
});

test("CLI merge checks shared profile identity even when a local identity masks it", t => {
  const f = fixture(t), shared = path.join(f.root, ".ai/project.yaml"), local = path.join(f.root, ".ai/project.local.yaml"), input = path.join(f.base, "incoming.yaml");
  f.save();
  dump({ profile_id: "local-profile" }, local);
  const before = fs.readFileSync(shared);
  dump({ profile_id: "different-profile" }, input);
  const rejected = node("scripts/profile.mjs", ["import", f.root, "--input", input, "--merge"], { env: f.env });
  assert.notEqual(rejected.status, 0);
  assert.match(JSON.parse(rejected.stdout).error, /Cannot merge different profile types/);
  assert.deepEqual(fs.readFileSync(shared), before);
  assert.deepEqual(fs.readdirSync(path.dirname(shared)).sort(), ["project.local.yaml", "project.yaml"]);

  dump({ profile_id: f.profile.profile_id, project: { purpose: "Updated shared purpose" } }, input);
  success(node("scripts/profile.mjs", ["import", f.root, "--input", input, "--merge"], { env: f.env }));
  assert.equal(load(shared).project.purpose, "Updated shared purpose");
  assert.equal(project_profile(f.root).profile_id, "local-profile");

  const partial = load(shared);
  delete partial.profile_id;
  dump(partial, shared);
  dump({ project: { purpose: "Partial shared profile" } }, input);
  success(node("scripts/profile.mjs", ["import", f.root, "--input", input, "--merge"], { env: f.env }));
  dump({ profile_id: "different-profile" }, input);
  assert.notEqual(node("scripts/profile.mjs", ["import", f.root, "--input", input, "--merge"], { env: f.env }).status, 0);
  dump({ profile_id: "local-profile" }, input);
  success(node("scripts/profile.mjs", ["import", f.root, "--input", input, "--merge"], { env: f.env }));
  assert.equal(load(shared).profile_id, "local-profile");
});

test("each layer validates hidden URLs and instance files reject unrelated fields", t => {
  const f = fixture(t); environment(t, f.env);
  f.profile.connections = { edt: { url: "http://user:secret@example.org/mcp" } }; f.save();
  dump({ connections: { edt: { url: "http://localhost:8080/mcp" } } }, path.join(f.root, ".ai/project.local.yaml"));
  assert.throws(() => project_profile(f.root), /credentials/i);
  delete f.profile.connections; f.save();
  const config = settings(f.env.EDT_AI_SETTINGS);
  dump({ project: { purpose: "ignored" } }, instance_file(config, f.root));
  assert.throws(() => resolved_settings(config, f.root, project_profile(f.root)), /Instance overrides/);
});

test("copying a partial shared profile never copies source local settings", async t => {
  const target = fixture(t), source = fixture(t); environment(t, target.env);
  const purpose = source.profile.project.purpose;
  delete source.profile.project.purpose;
  delete source.profile.schema_version;
  source.save();
  dump({ schema_version: "0.2", project: { purpose: "source private" } }, path.join(source.root, ".ai/project.local.yaml"));
  target.save();
  dump({ schema_version: "0.2", project: { purpose } }, path.join(target.root, ".ai/project.local.yaml"));
  remember_profile(target.state, source.root, profile_state(source.root));
  const backend = new SettingsBackend(target.state, target.env.EDT_AI_SETTINGS);
  const copied = await backend.main({ action: "profile_source", sourceRoot: source.root });
  assert.equal(JSON.parse(copied.text).project.purpose, undefined);
  assert.doesNotMatch(copied.text, /source private/);
  const preview = await backend.main({ action: "preview", text: copied.text });
  assert.equal(preview.projectId, source.profile.project.id);
});

test("shared and local schemas expose the same profile fields and replace header maps", t => {
  const sharedSchema = JSON.parse(fs.readFileSync(path.join(ROOT, "schemas/project-profile.schema.json")));
  const localSchema = JSON.parse(fs.readFileSync(path.join(ROOT, "schemas/project-local.schema.json")));
  function compare(a, b) {
    assert.deepEqual(Object.keys(a.properties || {}).sort(), Object.keys(b.properties || {}).sort());
    for (const key of Object.keys(a.properties || {})) if (a.properties[key].properties) compare(a.properties[key], b.properties[key]);
  }
  compare(sharedSchema, localSchema);
  const f = fixture(t); environment(t, f.env);
  f.profile.connections = { edt: { headers_env: { Authorization: "SHARED_AUTH" } } };
  f.profile.components = { "bsl-ls": { headers_env: { Authorization: "SHARED_AUTH" } } }; f.save();
  dump({ connections: { edt: { headers_env: {} } }, components: { "bsl-ls": { headers_env: {} } } }, path.join(f.root, ".ai/project.local.yaml"));
  const profile = project_profile(f.root);
  const effective = resolved_settings(settings(f.env.EDT_AI_SETTINGS), f.root, profile)[0];
  assert.deepEqual(effective.mcp.required.edt.headers_env, {});
  assert.deepEqual(effective.mcp.managed["bsl-ls"].headers_env, {});
});
