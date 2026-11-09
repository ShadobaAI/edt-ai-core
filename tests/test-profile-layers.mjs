import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fixture, environment, node, success, session, ROOT } from "./helpers.mjs";
import { dump, load, parse, settings } from "../scripts/common.mjs";
import { project_profile, profile_state } from "../scripts/profile.mjs";
import { resolved_settings } from "../scripts/project_context.mjs";
import { SettingsBackend } from "../scripts/settings_backend.mjs";
import { remember_profile } from "../scripts/profile_history.mjs";
import { McpClient } from "../scripts/mcp_client.mjs";

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

test("settings.read exposes the resolved BSL configuration and its source through MCP", async t => {
  const f = fixture(t); environment(t, f.env);
  f.profile.components = { "bsl-ls": { configuration: "shared.json" } }; f.save();
  const local = path.join(f.root, ".ai/project.local.yaml");
  dump({ components: { "bsl-ls": { configuration: "local.json" } } }, local);
  const client = new McpClient([process.execPath, path.join(ROOT, "mcp/settings.mjs")], f.root,
    { ...f.env, EDT_AI_PROJECT_ROOT: "" }, 10);
  f.clients.push(client); client.roots = []; await client.initialize();
  const inspection = (await client.call("settings.inspect", { projectRoot: f.root })).structuredContent;
  assert.equal(inspection.projectSelection.status, "selected");
  const key = JSON.stringify(["components", "bsl-ls", "configuration"]);
  const read = async () => (await client.call("settings.read", {})).structuredContent;
  let result = await read();
  assert.equal(result.configurationValues.components["bsl-ls"].configuration, "local.json");
  assert.equal(result.configurationSources[key], "project_local");

  dump({ project: { purpose: "local purpose" } }, local);
  result = await read();
  assert.equal(result.configurationValues.components["bsl-ls"].configuration, "shared.json");
  assert.equal(result.configurationSources[key], "profile");

  dump({ components: { "bsl-ls": { configuration: null } } }, local);
  result = await read();
  assert.equal(result.configurationValues.components["bsl-ls"].configuration, null);
  assert.equal(result.configurationSources[key], "project_local");
});

test("EDT required flags survive scoped updates, rename, YAML save and import/export of both profile layers", async t => {
  const f = fixture(t); environment(t, f.env);
  f.profile.repositories[0].edt_required = false;
  f.profile.repositories.push({ id: "tests", path: ".", alias: "tests", edt_project: "Tests", edt_required: true }, { id: "features", path: ".", alias: "features" }); f.save();
  const localRepositories = f.profile.repositories.map(item => Object.hasOwn(item, "edt_required") ? { ...item, edt_required: !item.edt_required } : item);
  const shared = path.join(f.root, ".ai/project.yaml"), local = path.join(f.root, ".ai/project.local.yaml"); dump({ repositories: localRepositories }, local);
  const backend = new SettingsBackend(f.state, f.env.EDT_AI_SETTINGS);
  const assertFlags = () => {
    assert.deepEqual(load(shared).repositories, f.profile.repositories);
    assert.deepEqual(load(local).repositories, localRepositories);
    assert.deepEqual(profile_state(f.root).repositories.map(item => item.edt_required), [true, false, true]);
  };
  await backend.main({ action: "update", scope: "profile", set: { edtUrl: "http://localhost:8123/mcp" } });
  await backend.main({ action: "update", scope: "project_local", set: { bslLsJava: "local-java" } });
  await backend.main({ action: "rename_profile", projectId: "renamed", expectedRevision: backend.edit_revision() }); assertFlags();
  for (const layerScope of ["profile", "project_local"]) {
    const edit = await backend.main({ action: "edit", layerScope, format: "yaml" });
    const args = { text: edit.text + "\n# retained flags\n", mode: "layer", layerScope, baseRevision: edit.baseRevision };
    const preview = await backend.main({ action: "preview", ...args });
    await backend.main({ action: "apply", ...args, revision: preview.revision, replace: true }); assertFlags();
  }
  for (const includeCommandsAndComments of [false, true]) {
    const exported = await backend.main({ action: "transfer_export", scope: "both", includeCommandsAndComments });
    const { documents } = await backend.main({ action: "transfer_decode", base64: exported.base64 });
    assert.deepEqual(parse(documents.profile).repositories, f.profile.repositories);
    assert.deepEqual(parse(documents.project_local).repositories, localRepositories);
    const context = await backend.main({ action: "transfer_context" }), args = { ...context, documents };
    const preview = await backend.main({ action: "transfer_preview", ...args });
    await backend.main({ action: "transfer_apply", ...args, revision: preview.revision, replace: true }); assertFlags();
  }
  const client = await session(t, "mcp/settings.mjs", [], f);
  const compact = (await client.call("settings.inspect", {})).structuredContent;
  assert.deepEqual(compact.repositories.map(item => item.edt_required), [true, false, true]);
  assert.deepEqual(compact.profile.repositories.map(item => item.edt_required), [true, false, true]);
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

for (const method of ["transfer", "editor", "update", "rename"]) test(`local write through ${method} leaves the default ignore rule unchanged`, async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  assert.equal(spawnSync("git", ["init", "-q", f.root]).status, 0);
  const ignore = path.join(f.root, ".ai/.gitignore"), original = "project.local.yaml\n";
  fs.writeFileSync(ignore, original);
  assert.equal(spawnSync("git", ["-C", f.root, "add", "--", ".ai/.gitignore"]).status, 0);
  const backend = new SettingsBackend(f.state, f.env.EDT_AI_SETTINGS), local = "connections:\n  edt:\n    url: http://localhost:8123/mcp\n";
  if (method === "rename") await backend.main({ action: "rename_profile", projectId: "local-name", expectedRevision: backend.edit_revision() });
  else if (method === "update") await backend.main({ action: "update", scope: "project_local", set: { edtUrl: "http://localhost:8123/mcp" } });
  else if (method === "editor") {
    const edit = await backend.main({ action: "edit", format: "yaml", layerScope: "project_local" });
    const args = { mode: "layer", layerScope: "project_local", baseRevision: edit.baseRevision, text: local };
    const preview = await backend.main({ action: "preview", ...args });
    assert.equal(preview.gitignoreChange, null);
    await backend.main({ action: "apply", ...args, revision: preview.revision });
  } else {
    const context = await backend.main({ action: "transfer_context" });
    const args = { baseRevision: context.baseRevision, documents: { project_local: local } };
    const preview = await backend.main({ action: "transfer_preview", ...args });
    assert.equal(preview.gitignoreChange, null);
    await backend.main({ action: "transfer_apply", ...args, revision: preview.revision, replace: true });
  }
  assert.equal(fs.readFileSync(ignore, "utf8"), original);
  assert.equal(spawnSync("git", ["-C", f.root, "diff", "--exit-code", "--", ".ai/.gitignore"]).status, 0);
  assert.equal(spawnSync("git", ["-C", f.root, "check-ignore", "-q", ".ai/project.local.yaml"]).status, 0);
});

for (const { name, original, changed } of [
  { name: "unanchored rule before unrelated rules", original: "project.local.yaml\r\ncache/\r\n# retained\r\n", changed: false },
  { name: "anchored rule before unrelated rules", original: "/project.local.yaml\n*.log\n", changed: false },
  { name: "rule without a final newline", original: "project.local.yaml", changed: false },
  { name: "rule with trailing spaces", original: "project.local.yaml   \n", changed: false },
  { name: "restored ignore after a negation", original: "!*.yaml\nproject.local.yaml\nother/\n", changed: false },
  { name: "wildcard negation after the ignore", original: "project.local.yaml\n!*.yaml", changed: true },
  { name: "anchored negation after the ignore", original: "project.local.yaml\n!/project.local.yaml\n", changed: true },
  { name: "leading space in an anchored rule", original: " /project.local.yaml\n", changed: true },
]) test(`local write handles ${name}`, async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  assert.equal(spawnSync("git", ["init", "-q", f.root]).status, 0);
  const ignore = path.join(f.root, ".ai/.gitignore"); fs.writeFileSync(ignore, original);
  const backend = new SettingsBackend(f.state, f.env.EDT_AI_SETTINGS);
  await backend.main({ action: "update", scope: "project_local", set: { edtUrl: "http://localhost:8123/mcp" } });
  assert.equal(fs.readFileSync(ignore, "utf8"), changed ? original + (original.endsWith("\n") ? "" : "\n") + "/project.local.yaml\n" : original);
  assert.equal(spawnSync("git", ["-C", f.root, "check-ignore", "-q", ".ai/project.local.yaml"]).status, 0);
});

test("local write keeps an existing ignore rule outside a Git repository", async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  const ignore = path.join(f.root, ".ai/.gitignore"), original = "project.local.yaml\n";
  fs.writeFileSync(ignore, original);
  const backend = new SettingsBackend(f.state, f.env.EDT_AI_SETTINGS);
  await backend.main({ action: "update", scope: "project_local", set: { edtUrl: "http://localhost:8123/mcp" } });
  assert.equal(fs.readFileSync(ignore, "utf8"), original);
});

for (const method of ["transfer", "editor", "update", "rename"]) test(`first local write through ${method} preserves existing Git rules and ignores the local layer`, async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  assert.equal(spawnSync("git", ["init", "-q", f.root]).status, 0);
  const ignore = path.join(f.root, ".ai/.gitignore"); fs.writeFileSync(ignore, "# retained\n!project.local.yaml\n");
  const backend = new SettingsBackend(f.state, f.env.EDT_AI_SETTINGS), local = "connections:\n  edt:\n    url: http://localhost:8123/mcp\n";
  if (method === "rename") await backend.main({ action: "rename_profile", projectId: "local-name", expectedRevision: backend.edit_revision() });
  else if (method === "update") await backend.main({ action: "update", scope: "project_local", set: { edtUrl: "http://localhost:8123/mcp" } });
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

for (const method of ["update", "rename"]) test(`local settings ${method} rejects a file already tracked by Git`, async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  assert.equal(spawnSync("git", ["init", "-q", f.root]).status, 0);
  const target = path.join(f.root, ".ai/project.local.yaml"); fs.writeFileSync(target, "{}\n");
  assert.equal(spawnSync("git", ["-C", f.root, "add", "--", ".ai/project.local.yaml"]).status, 0);
  const backend = new SettingsBackend(f.state, f.env.EDT_AI_SETTINGS);
  const request = method === "rename" ? { action: "rename_profile", projectId: "local-name", expectedRevision: backend.edit_revision() }
    : { action: "update", scope: "project_local", set: { edtUrl: "http://localhost:8123/mcp" } };
  await assert.rejects(backend.main(request), /уже отслеживается Git/);
  assert.equal(fs.readFileSync(target, "utf8"), "{}\n");
  assert.equal(fs.existsSync(path.join(f.root, ".ai/.gitignore")), false);
});

for (const existing of [false, true]) for (const failure of ["write", "verification"])
  test(`rename rolls back the local file and gitignore after ${failure} failure (${existing ? "existing" : "absent"} files)`, async t => {
    const f = fixture(t); environment(t, f.env); f.save();
    const target = path.join(f.root, ".ai/project.local.yaml"), ignore = path.join(f.root, ".ai/.gitignore"), shared = path.join(f.root, ".ai/project.yaml");
    const original = "# private settings\r\nproject: {id: old-name, purpose: retained}\r\n", ignoreBefore = "# retained\n!project.local.yaml\n", sharedBefore = fs.readFileSync(shared);
    if (existing) { fs.writeFileSync(target, original); fs.writeFileSync(ignore, ignoreBefore); }
    const backend = new SettingsBackend(f.state, f.env.EDT_AI_SETTINGS), expectedRevision = backend.edit_revision();
    const method = existing ? "renameSync" : "linkSync", mutate = fs[method], read = fs.readFileSync;
    let saved = false, injected = false;
    t.mock.method(fs, method, (...args) => {
      if (args[1] === target && failure === "write" && !injected) { injected = true; throw new Error("fixture rename write failure"); }
      const result = mutate(...args);
      if (args[1] === target) saved = true;
      return result;
    });
    t.mock.method(fs, "readFileSync", (file, ...args) => {
      if (file === target && saved && failure === "verification" && !injected) { injected = true; throw new Error("fixture rename verification failure"); }
      return read(file, ...args);
    });
    await assert.rejects(backend.main({ action: "rename_profile", projectId: "new-name", expectedRevision }), /fixture rename (write|verification) failure/);
    assert.equal(injected, true);
    assert.equal(fs.existsSync(target), existing);
    assert.equal(fs.existsSync(ignore), existing);
    if (existing) {
      assert.equal(fs.readFileSync(target, "utf8"), original);
      assert.equal(fs.readFileSync(ignore, "utf8"), ignoreBefore);
      const backups = fs.readdirSync(path.join(f.state, "backups"));
      assert.equal(backups.length, 1);
      assert.equal(fs.readFileSync(path.join(f.state, "backups", backups[0]), "utf8"), original);
    } else assert.equal(fs.existsSync(path.join(f.state, "backups")), false);
    assert.deepEqual(fs.readFileSync(shared), sharedBefore);
    assert.equal(fs.readdirSync(path.dirname(target)).some(file => file.startsWith(".core-")), false);
  });

for (const changed of ["local", "gitignore"]) test(`rename rollback preserves concurrent ${changed} edits`, async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  const target = path.join(f.root, ".ai/project.local.yaml"), ignore = path.join(f.root, ".ai/.gitignore");
  const original = "project:\n  id: old-name\n", ignoreBefore = "# original rules\n", external = "# changed elsewhere\nproject: {id: external-name}\n";
  fs.writeFileSync(target, original); fs.writeFileSync(ignore, ignoreBefore);
  const backend = new SettingsBackend(f.state, f.env.EDT_AI_SETTINGS), expectedRevision = backend.edit_revision(), rename = fs.renameSync, read = fs.readFileSync;
  let saved = false, injected = false;
  t.mock.method(fs, "renameSync", (...args) => {
    const result = rename(...args);
    if (args[1] === target && !saved) { saved = true; fs.writeFileSync(changed === "local" ? target : ignore, external); }
    return result;
  });
  t.mock.method(fs, "readFileSync", (file, ...args) => {
    if (file === target && saved && !injected) { injected = true; throw new Error("fixture verification failure"); }
    return read(file, ...args);
  });
  await assert.rejects(backend.main({ action: "rename_profile", projectId: "new-name", expectedRevision }), /Не удалось восстановить файлы:.*Резервная копия:/);
  assert.equal(fs.readFileSync(target, "utf8"), changed === "local" ? external : original);
  assert.equal(fs.readFileSync(ignore, "utf8"), changed === "gitignore" ? external : ignoreBefore);
  const backups = fs.readdirSync(path.join(f.state, "backups"));
  assert.equal(fs.readFileSync(path.join(f.state, "backups", backups[0]), "utf8"), original);
});

test("rename rolls back when the persisted merged profile fails validation and preserves the external shared edit", async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  const target = path.join(f.root, ".ai/project.local.yaml"), ignore = path.join(f.root, ".ai/.gitignore"), shared = path.join(f.root, ".ai/project.yaml");
  const original = "project: {id: old-name}\n", ignoreBefore = "# original rules\n";
  fs.writeFileSync(target, original); fs.writeFileSync(ignore, ignoreBefore);
  const backend = new SettingsBackend(f.state, f.env.EDT_AI_SETTINGS), expectedRevision = backend.edit_revision(), rename = fs.renameSync;
  const external = JSON.stringify({ ...f.profile, testing: { ...f.profile.testing, commands: [{ id: "test", repository_id: "unknown", argv: ["runner"], effects: [] }] } });
  let injected = false;
  t.mock.method(fs, "renameSync", (...args) => {
    const result = rename(...args);
    if (args[1] === target && !injected) { injected = true; fs.writeFileSync(shared, external); }
    return result;
  });
  await assert.rejects(backend.main({ action: "rename_profile", projectId: "new-name", expectedRevision }), /Неизвестные идентификаторы репозиториев/);
  assert.equal(injected, true);
  assert.equal(fs.readFileSync(target, "utf8"), original);
  assert.equal(fs.readFileSync(ignore, "utf8"), ignoreBefore);
  assert.equal(fs.readFileSync(shared, "utf8"), external);
  const backups = fs.readdirSync(path.join(f.state, "backups"));
  assert.equal(fs.readFileSync(path.join(f.state, "backups", backups[0]), "utf8"), original);
});

test("rename refuses a local alias to project.yaml without changing either profile", async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  const local = path.join(f.root, ".ai/project.local.yaml"), shared = path.join(f.root, ".ai/project.yaml"), sharedBefore = fs.readFileSync(shared);
  let linked = false;
  try { fs.symlinkSync(shared, local, "file"); linked = true; }
  catch (error) {
    if (process.platform !== "win32" || error.code !== "EPERM") throw error;
    // Windows may require extra privileges for file symlinks. Substitute only
    // OS path resolution so the same backend guard is exercised on that host.
    fs.copyFileSync(shared, local);
    const realpath = fs.realpathSync.native;
    t.mock.method(fs.realpathSync, "native", (file, ...args) => path.resolve(file) === local ? shared : realpath(file, ...args));
  }
  const backend = new SettingsBackend(f.state, f.env.EDT_AI_SETTINGS);
  await assert.rejects(backend.main({ action: "rename_profile", projectId: "new-name", expectedRevision: backend.edit_revision() }), /Локальный файл не должен перенаправляться в общий профиль/);
  assert.deepEqual(fs.readFileSync(shared), sharedBefore);
  assert.deepEqual(fs.readFileSync(local), sharedBefore);
  assert.equal(fs.lstatSync(local).isSymbolicLink(), linked);
  assert.equal(fs.existsSync(path.join(f.root, ".ai/.gitignore")), false);
  assert.equal(fs.existsSync(path.join(f.state, "backups")), false);
});

test("rename checks protected path redirects before reading local bytes", async t => {
  const f = fixture(t); environment(t, f.env);
  const directory = path.join(f.root, "src/settings-data"); fs.mkdirSync(directory);
  fs.symlinkSync(directory, path.join(f.root, ".ai"), process.platform === "win32" ? "junction" : "dir"); f.save();
  const local = path.join(directory, "project.local.yaml"), original = "project: {id: local-name}\n"; fs.writeFileSync(local, original);
  const backend = new SettingsBackend(f.state, f.env.EDT_AI_SETTINGS), read = fs.readFileSync;
  let localReads = 0;
  t.mock.method(fs, "readFileSync", (file, ...args) => {
    if (typeof file === "string" && path.resolve(file) === local) localReads++;
    return read(file, ...args);
  });
  await assert.rejects(backend.main({ action: "rename_profile", projectId: "new-name", expectedRevision: "unavailable" }), /Путь настроек перенаправляется в защищённые исходники проекта/);
  assert.equal(localReads, 0);
  assert.equal(read(local, "utf8"), original);
  assert.equal(fs.existsSync(path.join(directory, ".gitignore")), false);
  assert.equal(fs.existsSync(path.join(f.state, "backups")), false);
});

for (const location of ["project", "git"]) test(`rename rejects a local backup destination inside ${location}`, async t => {
  const f = fixture(t); f.save();
  const state = location === "project" ? path.join(f.root, "state") : f.state;
  fs.mkdirSync(state, { recursive: true });
  if (location === "git") fs.mkdirSync(path.join(state, ".git"));
  const env = { ...f.env, EDT_AI_STATE_DIR: state, EDT_AI_SETTINGS: path.join(state, "settings.json") }; environment(t, env);
  const target = path.join(f.root, ".ai/project.local.yaml"), original = "project: {id: local-name}\n"; fs.writeFileSync(target, original);
  const backend = new SettingsBackend(state, env.EDT_AI_SETTINGS);
  await assert.rejects(backend.main({ action: "rename_profile", projectId: "new-name", expectedRevision: backend.edit_revision() }), /вне проекта и Git-репозитория/);
  assert.equal(fs.readFileSync(target, "utf8"), original);
  assert.equal(fs.existsSync(path.join(f.root, ".ai/.gitignore")), false);
  assert.equal(fs.existsSync(path.join(state, "backups")), false);
});

test("the shared configuration editor changes project.id explicitly while the local rename retains priority", async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  const backend = new SettingsBackend(f.state, f.env.EDT_AI_SETTINGS), shared = path.join(f.root, ".ai/project.yaml"), local = path.join(f.root, ".ai/project.local.yaml");
  await backend.main({ action: "rename_profile", projectId: "local-name", expectedRevision: backend.edit_revision() });
  const localBefore = fs.readFileSync(local), edit = await backend.main({ action: "edit", layerScope: "profile", format: "yaml" });
  assert.equal(parse(edit.text).project.id, f.profile.project.id);
  const document = parse(edit.text); document.project.id = "shared-name";
  const args = { mode: "layer", layerScope: "profile", baseRevision: edit.baseRevision, text: JSON.stringify(document) };
  const preview = await backend.main({ action: "preview", ...args });
  await backend.main({ action: "apply", ...args, revision: preview.revision, replace: true });
  assert.equal(load(shared).project.id, "shared-name");
  assert.deepEqual(fs.readFileSync(local), localBefore);
  assert.equal((await backend.main({ action: "read" })).profile.projectId, "local-name");
  fs.rmSync(local);
  assert.equal(project_profile(f.root).project.id, "shared-name");
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
  assert.throws(() => project_profile(f.root), /не могут ослаблять/);
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
  assert.match(JSON.parse(rejected.stdout).error, /Нельзя объединять разные типы профилей/);
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
  assert.throws(() => project_profile(f.root), /учётные данные/i);
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
