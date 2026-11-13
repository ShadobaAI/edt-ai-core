import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { canonical_yaml, parse, stringify_yaml } from "../scripts/common.mjs";
import { SettingsBackend } from "../scripts/settings_backend.mjs";
import { environment, fixture, node, session, success } from "./helpers.mjs";

test("equivalent YAML and JSON documents use one block format", () => {
  const input = '{"project":{"id":"bit"},"connections":{"edt":{"url":"http://localhost:8765/mcp"}},"repositories":[{"id":"bf","enabled":true}],"empty":{"object":{},"array":[]}}';
  const value = parse(input), formatted = canonical_yaml(input);
  assert.equal(formatted, stringify_yaml(value));
  assert.match(formatted, /connections:\n  edt:\n    url: "http:\/\/localhost:8765\/mcp"\n/);
  assert.match(formatted, /repositories:\n  - id: "bf"\n    enabled: true\n/);
  assert.match(formatted, /empty:\n  object: \{\}\n  array: \[\]\n/);
  assert.equal(canonical_yaml(formatted), formatted);
});

test("normalizing flow YAML preserves comments, aliases and typed values", () => {
  const input = "\uFEFF# header\r\nconnections:\r\n  edt: &base {url: http://localhost:8765/mcp, enabled: YES} # connection\r\n  v8std: {<<: *base, url: http://example.test/mcp}\r\nitems: ['yes', 0x10, null, [one, two]] # items\r\n";
  const formatted = canonical_yaml(input);
  assert.deepEqual(parse(formatted), parse(input));
  assert.match(formatted, /^# header\n/);
  assert.match(formatted, /edt: &base\n    url: "http:\/\/localhost:8765\/mcp"\n    enabled: true/);
  assert.match(formatted, /<<: \*base/);
  assert.match(formatted, /# connection/);
  assert.match(formatted, /# items/);
  assert.match(formatted, /  - "yes"\n  - 16\n  - null\n  - - "one"\n    - "two"/);
  assert.doesNotMatch(formatted, /\r/);
  assert.equal(canonical_yaml(formatted), formatted);
});

test("empty collections keep their canonical notation and nested comments", () => {
  const input = "empty_map: { # map comment\n} # map end\nempty_list: [ # list comment\n] # list end\n";
  const formatted = canonical_yaml(input);
  assert.match(formatted, /^empty_map: \{\}\n/);
  assert.match(formatted, /empty_list: \[\]\n/);
  for (const comment of ["map comment", "map end", "list comment", "list end"]) assert.match(formatted, new RegExp(comment));
  assert.deepEqual(parse(formatted), parse(input));
  assert.equal(canonical_yaml(formatted), formatted);
});

test("comments in nested flow blocks settle into an idempotent format", () => {
  const input = '# header   \ncomponents: { # components\n  bsl-ls: { # bsl\n    enabled: false # value\n  } # nested\n} # outer\n# tail   \n';
  const formatted = canonical_yaml(input);
  assert.deepEqual(parse(formatted), parse(input));
  for (const comment of ["header", "components", "bsl", "value", "nested", "outer", "tail"]) assert.match(formatted, new RegExp("# " + comment));
  assert.equal(canonical_yaml(formatted), formatted);
});

test("generated strings and YAML 1.1 dictionary keys stay in the same format", () => {
  for (const key of ["yes", "no", "true", "null", "0", "<<", "__proto__", "constructor", "a:b"]) {
    const value = Object.defineProperty({}, key, { value: "строка\nwith a quote: \"", enumerable: true });
    const generated = stringify_yaml({ value, empty: [], nested: [value] });
    assert.equal(canonical_yaml(generated), generated);
  }
});

test("CLI profile import and export write the same block YAML format", t => {
  const f = fixture(t), input = path.join(f.base, "input.yaml"), output = path.join(f.base, "output.yaml");
  f.save();
  const target = path.join(f.root, ".ai/project.yaml"), before = fs.readFileSync(target, "utf8");
  f.profile.connections = { edt: { url: "http://localhost:8765/mcp" } };
  fs.writeFileSync(input, JSON.stringify(f.profile));
  const imported = success(node("scripts/profile.mjs", ["import", f.root, "--input", input, "--replace"], { env: f.env }));
  const saved = fs.readFileSync(target, "utf8");
  assert.equal(saved, canonical_yaml(saved));
  assert.match(saved, /edt:\n    url: "http:\/\/localhost:8765\/mcp"/);
  assert.equal(fs.readFileSync(imported.backup, "utf8"), before);
  success(node("scripts/profile.mjs", ["export", f.root, "--output", output], { env: f.env }));
  assert.equal(fs.readFileSync(output, "utf8"), saved);
});

for (const scope of ["profile", "project_local"]) test(`scoped ${scope} saves write block YAML and keep an exact backup`, async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  const target = path.join(f.root, ".ai", scope === "profile" ? "project.yaml" : "project.local.yaml");
  const connections = '# retained\nconnections:\n  edt: {}\n  v8std: {url: "http://example.test/mcp"}\n';
  const before = scope === "profile" ? fs.readFileSync(target, "utf8") + connections : connections;
  fs.writeFileSync(target, before);
  const backend = new SettingsBackend(f.state, f.env.EDT_AI_SETTINGS);
  const result = await backend.main({ action: "update", scope, set: { edtUrl: "http://localhost:8765/mcp" } });
  const saved = fs.readFileSync(target, "utf8");
  assert.equal(saved, canonical_yaml(saved));
  assert.match(saved, /edt:\n    url: "http:\/\/localhost:8765\/mcp"/);
  assert.match(saved, /v8std:\n    url: "http:\/\/example.test\/mcp"/);
  assert.match(saved, /# retained/);
  assert.equal(fs.readFileSync(result.backup, "utf8"), before);
});

test("global settings also use block YAML when the selected file has a YAML extension", async t => {
  const f = fixture(t);
  f.env.EDT_AI_SETTINGS = path.join(f.state, "custom-settings.yaml");
  environment(t, f.env); f.save();
  fs.writeFileSync(f.env.EDT_AI_SETTINGS, '# retained global comment\nmcp:\n  managed:\n    bsl-ls: {java: "old-java"} # retained component\n');
  const backend = new SettingsBackend(f.state, f.env.EDT_AI_SETTINGS);
  await backend.main({ action: "update", scope: "global", set: { bslLsJava: "new-java" } });
  const saved = fs.readFileSync(f.env.EDT_AI_SETTINGS, "utf8");
  assert.equal(saved, canonical_yaml(saved));
  assert.equal(parse(saved).mcp.managed["bsl-ls"].java, "new-java");
  assert.match(saved, /bsl-ls:\n\s+java: "new-java"/);
  assert.match(saved, /# retained global comment/);
  assert.match(saved, /# retained component/);
});

for (const scope of ["profile", "project_local"]) test(`the ${scope} editor previews and saves the same formatted YAML`, async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  const target = path.join(f.root, ".ai", scope === "profile" ? "project.yaml" : "project.local.yaml");
  if (scope === "project_local") fs.writeFileSync(target, "# local\n{}\n");
  const before = fs.readFileSync(target, "utf8"), backend = new SettingsBackend(f.state, f.env.EDT_AI_SETTINGS);
  const edit = await backend.main({ action: "edit", layerScope: scope, format: "yaml" });
  const draft = (scope === "profile" ? edit.text : "# local\n") + 'connections: {edt: {url: "http://localhost:8765/mcp"}}\n';
  const request = { mode: "layer", layerScope: scope, baseRevision: edit.baseRevision, text: draft };
  const preview = await backend.main({ action: "preview", ...request });
  assert.equal(preview.formattedText, canonical_yaml(draft));
  assert.match(preview.formattedText, /edt:\n    url: "http:\/\/localhost:8765\/mcp"/);
  await assert.rejects(backend.main({ action: "apply", ...request, text: draft + "\n", revision: preview.revision, replace: true }), /предпросмотра/);
  const applied = await backend.main({ action: "apply", ...request, revision: preview.revision, replace: true });
  assert.equal(fs.readFileSync(target, "utf8"), preview.formattedText);
  assert.equal(fs.readFileSync(applied.backup, "utf8"), before);
});

test("import preview and comment-preserving export use the saved YAML format", async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  const backend = new SettingsBackend(f.state, f.env.EDT_AI_SETTINGS);
  const shared = path.join(f.root, ".ai/project.yaml"), local = path.join(f.root, ".ai/project.local.yaml");
  const sharedBefore = fs.readFileSync(shared, "utf8");
  const documents = { profile: '# kept\n' + JSON.stringify(f.profile) + '\n', project_local: 'connections: {edt: {url: "http://localhost:8765/mcp"}}\n' };
  const request = { projectRoot: f.root, baseRevision: backend.edit_revision(), documents };
  const preview = await backend.main({ action: "transfer_preview", ...request });
  assert.equal(preview.files.find(item => item.scope === "profile").afterText, canonical_yaml(documents.profile));
  assert.equal(preview.files.find(item => item.scope === "project_local").afterText, canonical_yaml(documents.project_local));
  const applied = await backend.main({ action: "transfer_apply", ...request, revision: preview.revision, replace: true });
  assert.equal(fs.readFileSync(shared, "utf8"), canonical_yaml(documents.profile));
  assert.equal(fs.readFileSync(local, "utf8"), canonical_yaml(documents.project_local));
  assert.equal(fs.readFileSync(applied.backups.find(item => item.scope === "profile").path, "utf8"), sharedBefore);
  const exported = await backend.main({ action: "transfer_export", scope: "profile", includeCommandsAndComments: true });
  assert.equal(exported.text, fs.readFileSync(shared, "utf8"));
  assert.match(exported.text, /^# kept/);
});

test("the formatted editor preview is app-only metadata", async t => {
  const f = fixture(t); f.save();
  const client = await session(t, "mcp/settings.mjs", [], f);
  const edit = (await client.call("settings.edit", { layerScope: "project_local", format: "yaml" }))._meta.data;
  const text = '# private-comment-marker\nconnections: {edt: {url: "http://localhost:8765/mcp"}}\n';
  const request = { mode: "layer", layerScope: "project_local", baseRevision: edit.baseRevision, text };
  const preview = await client.call("settings.preview", request);
  assert.equal(preview._meta.data.formattedText, canonical_yaml(text));
  assert.doesNotMatch(JSON.stringify(preview.structuredContent), /private-comment-marker|formattedText/);
  const applied = await client.call("settings.apply", { ...request, revision: preview.structuredContent.revision });
  assert.doesNotMatch(JSON.stringify(applied.structuredContent), /private-comment-marker|formattedText/);
  const operation = await client.call("settings.operation", {});
  assert.doesNotMatch(JSON.stringify(operation.structuredContent), /private-comment-marker|formattedText/);
});
