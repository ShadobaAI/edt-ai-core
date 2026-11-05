import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fixture, environment, node, success, ROOT } from "./helpers.mjs";
import { dump, load, parse, settings } from "../scripts/common.mjs";
import { project_profile, profile_state } from "../scripts/profile.mjs";
import { resolved_settings } from "../scripts/project_context.mjs";
import { SettingsBackend } from "../scripts/settings_backend.mjs";
import { remember_profile } from "../scripts/profile_history.mjs";

test("configuration presentation reuses resolved values and reports each saved source without writing", async t => {
  const f=fixture(t);environment(t,f.env);
  f.profile.connections={edt:{url:"http://shared/mcp",timeout_seconds:11,headers_env:{Authorization:"SHARED_TOKEN"}},openviking:{enabled:false}};
  f.profile.components={"bsl-ls":{java:"shared-java",configuration:"shared.json"}};f.save();
  const local=path.join(f.root,".ai/project.local.yaml"),external=path.join(f.base,"connections.yaml");
  dump({project:{purpose:"local purpose"},connections:{edt:{headers_env:{}}},components:{"bsl-ls":{java:"local-java",configuration:null}}},local);
  dump({connections:{edt:{timeout_seconds:19},v8std:{url_env:"CUSTOM_V8STD_URL"}},components:{"bsl-ls":{node:"external-node"}}},external);
  process.env.EDT_AI_CONNECTIONS_FILE=external;process.env.EDT_AI_EDT_URL="http://environment/mcp";process.env.SHARED_TOKEN="not-a-display-value";t.after(()=>{delete process.env.SHARED_TOKEN;});
  const shared=path.join(f.root,".ai/project.yaml"),before=[shared,local,external].map(file=>fs.readFileSync(file,"utf8"));
  const backend=new SettingsBackend(f.state,f.env.EDT_AI_SETTINGS),snapshot=await backend.main({action:"read"});
  const values=snapshot.configurationValues,source=path=>snapshot.configurationSources[JSON.stringify(path)];
  assert.equal(values.project.id,f.profile.project.id);assert.equal(source(["project","id"]),"profile");
  assert.equal(values.project.purpose,"local purpose");assert.equal(source(["project","purpose"]),"project_local");
  assert.equal(values.connections.edt.url,snapshot.values.edtUrl);assert.equal(source(["connections","edt","url"]),"environment:EDT_AI_EDT_URL");
  assert.equal(values.connections.edt.timeout_seconds,19);assert.equal(source(["connections","edt","timeout_seconds"]),"connections_file");
  assert.equal(values.connections.v8std.url_env,"CUSTOM_V8STD_URL");assert.equal(source(["connections","v8std","url_env"]),"connections_file");
  assert.deepEqual(values.connections.edt.headers_env,{});assert.equal(source(["connections","edt","headers_env"]),"project_local");
  assert.equal(values.components["bsl-ls"].node,"external-node");assert.equal(source(["components","bsl-ls","node"]),"connections_file");
  assert.equal(values.components["bsl-ls"].java,"local-java");assert.equal(values.components["bsl-ls"].configuration,null);
  assert.equal(source(["components","bsl-ls","configuration"]),"project_local");
  assert.equal(source(["components","code-index","version"]),"settings");
  assert.ok(!JSON.stringify(snapshot).includes("not-a-display-value"));
  assert.deepEqual([shared,local,external].map(file=>fs.readFileSync(file,"utf8")),before);
});

test("configuration sources follow replaced arrays and local header dictionaries", async t => {
  const f=fixture(t);environment(t,f.env);f.save();
  dump({repositories:[{id:"local",path:".",alias:"local",edt_project:null}],connections:{v8std:{headers_env:{"X-Api-Key":"LOCAL_TOKEN"}}}},path.join(f.root,".ai/project.local.yaml"));
  const data=await new SettingsBackend(f.state,f.env.EDT_AI_SETTINGS).main({action:"read"});
  assert.equal(data.configurationValues.repositories.length,1);
  assert.equal(data.configurationValues.repositories[0].id,"local");
  assert.equal(data.configurationSources[JSON.stringify(["repositories",0,"edt_project"])],"project_local");
  assert.equal(data.configurationSources[JSON.stringify(["connections","v8std","headers_env","X-Api-Key"])],"project_local");
});



test("two project documents are reviewed together and imported with revision and backups", async t => {
  const f=fixture(t); environment(t,f.env); f.save();
  const shared=path.join(f.root,".ai","project.yaml"), local=path.join(f.root,".ai","project.local.yaml");
  fs.writeFileSync(local,"project:\n  purpose: original\n");
  const backend=new SettingsBackend(f.state,f.env.EDT_AI_SETTINGS);
  const edit=await backend.main({action:"edit",layerScope:"profile",format:"yaml"});
  const documents={profile:fs.readFileSync(shared,"utf8"),project_local:"project:\n  purpose: imported\n"};
  const args={projectRoot:f.root,baseRevision:edit.baseRevision,documents};
  const preview=await backend.main({action:"transfer_preview",...args});
  assert.equal(preview.files.length,2);
  await assert.rejects(backend.main({action:"transfer_apply",...args,revision:preview.revision}),/Подтвердите/);
  const applied=await backend.main({action:"transfer_apply",...args,revision:preview.revision,replace:true});
  assert.equal(load(local).project.purpose,"imported");
  assert.equal(applied.backups.length,2);
  assert.match(fs.readFileSync(applied.backups.find(item=>item.scope==="project_local").path,"utf8"),/original/);
  await assert.rejects(backend.main({action:"transfer_apply",...args,revision:preview.revision,replace:true}),/изменились/);
});

test("project import works before a profile exists", async t => {
  const f=fixture(t);environment(t,f.env);const backend=new SettingsBackend(f.state,f.env.EDT_AI_SETTINGS);
  const context=await backend.main({action:"transfer_context",projectRoot:f.root});
  const args={projectRoot:f.root,baseRevision:context.baseRevision,documents:{profile:JSON.stringify(f.profile)}};
  const preview=await backend.main({action:"transfer_preview",...args});
  assert.equal(preview.files[0].exists,false);
  await backend.main({action:"transfer_apply",...args,revision:preview.revision,replace:true});
  assert.equal(project_profile(f.root).profile_id,f.profile.profile_id);
});

for (const method of ["transfer", "editor", "update"]) test(`first local write through ${method} preserves existing Git rules and ignores the local layer`, async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  assert.equal(spawnSync("git", ["init", "-q", f.root]).status, 0);
  const ignore = path.join(f.root, ".ai/.gitignore"); fs.writeFileSync(ignore, "# retained\n!project.local.yaml\n");
  const backend = new SettingsBackend(f.state, f.env.EDT_AI_SETTINGS), local = "connections:\n  edt:\n    url: http://localhost:8123/mcp\n";
  if (method === "update") await backend.main({ action: "update", scope: "project_local", set: { edtUrl: "http://localhost:8123/mcp" } });
  else if (method === "editor") {
    const edit = await backend.main({ action: "edit", format: "yaml", layerScope: "project_local" });
    const args = { mode: "layer", layerScope: "project_local", baseRevision: edit.baseRevision, text: local };
    const preview = await backend.main({ action: "preview", ...args });
    await backend.main({ action: "apply", ...args, revision: preview.revision });
  } else {
    const context = await backend.main({ action: "transfer_context" });
    const args = { baseRevision: context.baseRevision, documents: { project_local: local } };
    const preview = await backend.main({ action: "transfer_preview", ...args });
    await backend.main({ action: "transfer_apply", ...args, revision: preview.revision, replace: true });
  }
  assert.match(fs.readFileSync(ignore, "utf8"), /^# retained\n!project.local.yaml\n\/project.local.yaml\n$/);
  assert.equal(spawnSync("git", ["-C", f.root, "check-ignore", "-q", ".ai/project.local.yaml"]).status, 0);
});

test("local settings writes reject a file already tracked by Git", async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  assert.equal(spawnSync("git", ["init", "-q", f.root]).status, 0);
  const target = path.join(f.root, ".ai/project.local.yaml"); fs.writeFileSync(target, "{}\n");
  assert.equal(spawnSync("git", ["-C", f.root, "add", "--", ".ai/project.local.yaml"]).status, 0);
  const backend = new SettingsBackend(f.state, f.env.EDT_AI_SETTINGS);
  await assert.rejects(backend.main({ action: "update", scope: "project_local", set: { edtUrl: "http://localhost:8123/mcp" } }), /уже отслеживается Git/);
  assert.equal(fs.readFileSync(target, "utf8"), "{}\n");
});

test("failed local transfer rolls back the reviewed gitignore change", async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  const ignore = path.join(f.root, ".ai/.gitignore"), target = path.join(f.root, ".ai/project.local.yaml");
  fs.writeFileSync(ignore, "# existing\n");
  const backend = new SettingsBackend(f.state, f.env.EDT_AI_SETTINGS), context = await backend.main({ action: "transfer_context" });
  const args = { baseRevision: context.baseRevision, documents: { project_local: "{}\n" } };
  const preview = await backend.main({ action: "transfer_preview", ...args });
  assert.equal(preview.gitignoreChange.beforeText, "# existing\n");
  assert.match(preview.gitignoreChange.afterText, /\/project.local.yaml/);
  const link = fs.linkSync;
  fs.linkSync = (...call) => { if (call[1] === target) throw new Error("fixture local write failure"); return link(...call); };
  try { await assert.rejects(backend.main({ action: "transfer_apply", ...args, revision: preview.revision, replace: true }), /fixture local write failure/); }
  finally { fs.linkSync = link; }
  assert.equal(fs.readFileSync(ignore, "utf8"), "# existing\n");
  assert.equal(fs.existsSync(target), false);
});

test("a concurrent local edit is preserved while gitignore rolls back", async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  const ignore = path.join(f.root, ".ai/.gitignore"), target = path.join(f.root, ".ai/project.local.yaml");
  fs.writeFileSync(ignore, "# original\n"); fs.writeFileSync(target, "{}\n");
  const backend = new SettingsBackend(f.state, f.env.EDT_AI_SETTINGS), rename = fs.renameSync;
  fs.renameSync = (...call) => { const result = rename(...call); if (call[1] === target) fs.writeFileSync(target, "project:\n  purpose: external\n"); return result; };
  try { await assert.rejects(backend.main({ action: "update", scope: "project_local", set: { edtUrl: "http://localhost:8123/mcp" } }), /Не удалось восстановить/); }
  finally { fs.renameSync = rename; }
  assert.match(fs.readFileSync(target, "utf8"), /external/);
  assert.equal(fs.readFileSync(ignore, "utf8"), "# original\n");
});

test("a Git index that cannot be checked is reported before and after saving", async t => {
  const f = fixture(t); environment(t, f.env); f.save(); fs.mkdirSync(path.join(f.root, ".git"));
  const backend = new SettingsBackend(f.state, f.env.EDT_AI_SETTINGS), edit = await backend.main({ action: "edit", layerScope: "project_local", format: "yaml" });
  const args = { mode: "layer", layerScope: "project_local", baseRevision: edit.baseRevision, text: "{}\n" };
  const preview = await backend.main({ action: "preview", ...args }); assert.match(preview.gitWarning, /Не удалось проверить индекс Git/);
  const saved = await backend.main({ action: "apply", ...args, revision: preview.revision }); assert.match(saved.summary.gitWarning, /Не удалось проверить индекс Git/);
});

test("a concurrent gitignore edit invalidates the local transfer preview", async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  const ignore = path.join(f.root, ".ai/.gitignore"); fs.writeFileSync(ignore, "# before\n");
  const backend = new SettingsBackend(f.state, f.env.EDT_AI_SETTINGS), context = await backend.main({ action: "transfer_context" });
  const args = { baseRevision: context.baseRevision, documents: { project_local: "{}\n" } };
  const preview = await backend.main({ action: "transfer_preview", ...args });
  fs.writeFileSync(ignore, "# changed elsewhere\n");
  await assert.rejects(backend.main({ action: "transfer_apply", ...args, revision: preview.revision, replace: true }), /предпросмотра/);
  assert.equal(fs.readFileSync(ignore, "utf8"), "# changed elsewhere\n");
  assert.equal(fs.existsSync(path.join(f.root, ".ai/project.local.yaml")), false);
});

test("transfer preview reports missing repository paths before import", async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  const backend = new SettingsBackend(f.state, f.env.EDT_AI_SETTINGS), document = structuredClone(f.profile);
  document.repositories[0].path = "missing-repository";
  const context = await backend.main({ action: "transfer_context" });
  const preview = await backend.main({ action: "transfer_preview", baseRevision: context.baseRevision, documents: { profile: JSON.stringify(document) } });
  assert.ok(preview.missingPaths.includes("missing-repository"));
  assert.equal(preview.edtMappings[0].status, "unavailable");
});

test("profile validation identifies an escaping repository path by field", async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  const backend = new SettingsBackend(f.state, f.env.EDT_AI_SETTINGS), document = structuredClone(f.profile);
  document.repositories[0].path = "../outside";
  const edit = await backend.main({ action: "edit", layerScope: "profile", format: "yaml" });
  await assert.rejects(backend.main({ action: "preview", mode: "layer", layerScope: "profile", baseRevision: edit.baseRevision, text: JSON.stringify(document) }), /\/repositories\/0\/path:/);
});

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
  const edit = await backend.main({ action: "edit", layerScope: "profile", format: "yaml" });
  const document = parse(edit.text);
  document.components = { "bsl-ls": { configuration: "shared.json" } };
  const args = { action: "preview", mode: "layer", layerScope: "profile", baseRevision: edit.baseRevision, text: JSON.stringify(document) };
  const preview = await backend.main(args);
  await backend.main({ ...args, action: "apply", revision: preview.revision, replace: true });
  assert.equal(load(path.join(f.root, ".ai/project.yaml")).components["bsl-ls"].configuration, "shared.json");
  assert.equal(project_profile(f.root).components["bsl-ls"].configuration, "private.json");
  const exported = parse((await backend.main({ action: "transfer_export",scope:"profile",projectRoot:f.root,includeCommandsAndComments:true })).text);
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

test("each active layer validates hidden URLs and old instance files are ignored", t => {
  const f = fixture(t); environment(t, f.env);
  f.profile.connections = { edt: { url: "http://user:secret@example.org/mcp" } }; f.save();
  dump({ connections: { edt: { url: "http://localhost:8080/mcp" } } }, path.join(f.root, ".ai/project.local.yaml"));
  assert.throws(() => project_profile(f.root), /credentials/i);
  delete f.profile.connections; f.save();
  const config = settings(f.env.EDT_AI_SETTINGS);
  dump({ connections: { edt: { url: "http://localhost:9999/mcp" } } }, path.join(f.root, ".ai", "instances", "first.local.yaml"));
  assert.equal(resolved_settings(config, f.root, project_profile(f.root))[0].mcp.required.edt.url, "http://localhost:8080/mcp");
});

test("scoped connection saves preserve YAML comments and back up local settings", async t => {
  const f=fixture(t);environment(t,f.env);f.save();const file=path.join(f.root,".ai","project.local.yaml");
  fs.writeFileSync(file,"# retained\nconnections:\n  edt:\n    url: http://localhost:8000/mcp # old endpoint\n");
  const backend=new SettingsBackend(f.state,f.env.EDT_AI_SETTINGS);
  const result=await backend.main({action:"update",scope:"project_local",set:{edtUrl:"http://localhost:8001/mcp"}});
  const saved=fs.readFileSync(file,"utf8");assert.match(saved,/^# retained/);assert.match(saved,/# old endpoint/);
  assert.match(fs.readFileSync(result.backup,"utf8"),/localhost:8000/);assert.equal(load(file).connections.edt.url,"http://localhost:8001/mcp");
});

test("scoped edits detach aliased connection objects without changing the other connection", async t => {
  const f=fixture(t);environment(t,f.env);f.save();const file=path.join(f.root,".ai","project.local.yaml");
  const original="connections:\n  edt: &shared\n    url: http://localhost:8000/mcp\n  v8std: *shared\n";fs.writeFileSync(file,original);
  const backend=new SettingsBackend(f.state,f.env.EDT_AI_SETTINGS);
  const result=await backend.main({action:"update",scope:"project_local",set:{edtUrl:"http://localhost:8001/mcp"}});
  const saved=load(file);assert.equal(saved.connections.edt.url,"http://localhost:8001/mcp");assert.equal(saved.connections.v8std.url,"http://localhost:8000/mcp");
  assert.equal(fs.readFileSync(result.backup,"utf8"),original);
});

test("resetting a connection and updating a component preserve their aliased peers", async t => {
  const f=fixture(t);environment(t,f.env);f.save();const file=path.join(f.root,".ai","project.local.yaml");
  fs.writeFileSync(file,"connections:\n  edt: &shared\n    url: http://localhost:8000/mcp\n  v8std: *shared\ncomponents:\n  code-index: &component\n    enabled: true\n  bsl-ls: *component\n");
  const backend=new SettingsBackend(f.state,f.env.EDT_AI_SETTINGS);
  await backend.main({action:"reset_connection",connection:"edt"});
  assert.equal(load(file).connections.v8std.url,"http://localhost:8000/mcp");assert.equal(load(file).connections.edt,undefined);
  await backend.main({action:"update",scope:"project_local",set:{codeIndexEnabled:false}});
  const saved=load(file);assert.equal(saved.components["code-index"].enabled,false);assert.equal(saved.components["bsl-ls"].enabled,true);
});

test("resetting a connection removes both explicit and merged values in its local layer", async t => {
  const f=fixture(t);environment(t,f.env);f.save();const file=path.join(f.root,".ai","project.local.yaml");
  fs.writeFileSync(file,"connections:\n  v8std: &base\n    url: http://localhost:8000/mcp\n  edt:\n    <<: *base\n    url: http://localhost:9000/mcp\n    enabled: true\n");
  const backend=new SettingsBackend(f.state,f.env.EDT_AI_SETTINGS);await backend.main({action:"reset_connection",connection:"edt"});
  const saved=load(file);assert.equal(saved.connections.edt.url,undefined);assert.equal(saved.connections.edt.enabled,true);assert.equal(saved.connections.v8std.url,"http://localhost:8000/mcp");
});

test("YAML editor rejects invalid UTF-8 instead of silently changing file bytes", async t => {
  const f=fixture(t);environment(t,f.env);f.save();const file=path.join(f.root,".ai","project.local.yaml");
  const original=Buffer.concat([Buffer.from("# comment "),Buffer.from([0xff]),Buffer.from("\n{}\n")]);fs.writeFileSync(file,original);
  const backend=new SettingsBackend(f.state,f.env.EDT_AI_SETTINGS);
  await assert.rejects(backend.main({action:"edit",layerScope:"project_local",format:"yaml"}),/UTF-8/);
  assert.deepEqual(fs.readFileSync(file),original);
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
