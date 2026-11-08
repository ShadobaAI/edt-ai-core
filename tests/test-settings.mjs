import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { fixture, environment, session, dialog_session, node, success, ROOT } from "./helpers.mjs";
import { check_schema, deep_merge, dump, load, parse, settings, sleep } from "../scripts/common.mjs";
import {
  SettingsBackend,
  patch_yaml_draft,
  authorize_preparation,
  preparation_scope,
} from "../scripts/settings_backend.mjs";
import { McpClient } from "../scripts/mcp_client.mjs";
import { project_profile } from "../scripts/profile.mjs";
import { resolved_settings } from "../scripts/project_context.mjs";
import { reconnect_file } from "../scripts/project_paths.mjs";
import { zip, read_project_archive, write_project_archive } from "../scripts/archives.mjs";
import { zipSync } from "../vendor/deps.mjs";

test("project transfer archives accept only two bounded UTF-8 YAML files", () => {
  const documents={".ai/project.yaml":"schema_version: '0.2'\n",".ai/project.local.yaml":"{}\n"};
  assert.deepEqual(read_project_archive(write_project_archive(documents)),documents);
  assert.throws(()=>read_project_archive(zip({".ai/project.yaml":Buffer.from("x"),"../project.local.yaml":Buffer.from("x")})),/Небезопасн/);
  assert.throws(()=>read_project_archive(zip({".ai/project.yaml":Buffer.from("x"),".ai/project.local.yaml":Buffer.from("x"),"other":Buffer.from("x")})),/ровно/);
  assert.throws(()=>read_project_archive(zip({".ai/project.yaml":Buffer.from("x"),".ai/PROJECT.yaml":Buffer.from("x")})),/Небезопасн/);
  assert.throws(()=>read_project_archive(zip({".ai/project.yaml":Buffer.from([0xff]),".ai/project.local.yaml":Buffer.from("{}")})),/UTF-8/);
  assert.throws(()=>write_project_archive({...documents,".ai/project.local.yaml":"x".repeat(2*1024*1024+1)}),/допустимого размера/);
  const corrupt=Buffer.from(zipSync(Object.fromEntries(Object.entries(documents).map(([name,text])=>[name,Buffer.from(text)])),{level:0}));
  const dataOffset=30+corrupt.readUInt16LE(26)+corrupt.readUInt16LE(28);corrupt[dataOffset]^=1;
  assert.throws(()=>read_project_archive(corrupt),/не совпадает/);
});

test("schema-driven field edits preserve surrounding YAML and distinguish scalar values", async () => {
  const backend = new SettingsBackend("unused-state", "unused-settings");
  const fields = await backend.main({ action: "document_fields", layerScope: "project_local", text: "flag: false\n" });
  assert.ok(fields.schema.properties.connections);
  assert.equal(fields.value.flag, false);
  let text = "# header\r\na: false # keep\r\nb: 0\r\nc: ''\r\nd: null\r\n";
  text = patch_yaml_draft(text, { kind: "set", path: ["a"], value: true }).text;
  assert.equal(text, "# header\r\na: true # keep\r\nb: 0\r\nc: ''\r\nd: null\r\n");
  text = patch_yaml_draft(text, { kind: "set", path: ["b"], value: 2 }).text;
  assert.match(text, /b: 2\r\nc: ''\r\nd: null/);
  const result = patch_yaml_draft("items:\n  - one\n  - two\nnext: 0\n", { kind: "append", path: ["items", 2], value: "three" });
  assert.equal(result.text, 'items:\n  - one\n  - two\n  - "three"\nnext: 0\n');
  assert.equal(result.reformatted, false);
  assert.equal(patch_yaml_draft("items:\n  - one # explanation\n", { kind: "append", path: ["items", 1], value: "two" }).text, 'items:\n  - one # explanation\n  - "two"\n');
  const moved = patch_yaml_draft("items:\n  - one\n  # note about two\n  - two\n  - three\n", { kind: "move", path: ["items", 0], to: 2 });
  assert.equal(moved.text,"items:\n  # note about two\n  - two\n  - three\n  - one\n");
  const anchored = patch_yaml_draft("a: &ref value\nb: *ref\n", { kind: "set", path: ["a"], value: "other" });
  assert.deepEqual(parse(anchored.text),{a:"other",b:"value"});assert.equal(anchored.reformatted,true);
  const alias = patch_yaml_draft("connections:\n  edt: &shared\n    url: http://localhost:8000/mcp\n  v8std: *shared\n", { kind: "set", path: ["connections", "v8std", "url"], value: "http://localhost:8001/mcp" });
  assert.deepEqual(parse(alias.text).connections,{edt:{url:"http://localhost:8000/mcp"},v8std:{url:"http://localhost:8001/mcp"}});
  const flowComments=patch_yaml_draft("before: 1\nitems: [one, # note\n  two] # tail\nafter: 2\n",{kind:"remove",path:["items",0]});
  assert.match(flowComments.text,/# note/);assert.match(flowComments.text,/# tail\nafter: 2/);assert.deepEqual(parse(flowComments.text).items,["two"]);
  const removed=patch_yaml_draft("items:\n  - one # important\n  - two\n",{kind:"remove",path:["items",0]});
  assert.match(removed.text,/# important/);assert.equal(removed.reformatted,true);assert.deepEqual(parse(removed.text).items,["two"]);
  const merged=patch_yaml_draft("connections:\n  edt: &base\n    url: http://localhost:8000/mcp\n  v8std:\n    <<: *base\n",{kind:"set",path:["connections","v8std","url"],value:"http://localhost:9000/mcp"});
  assert.match(merged.text,/<<: \*base/);assert.equal(parse(merged.text).connections.edt.url,"http://localhost:8000/mcp");assert.equal(parse(merged.text).connections.v8std.url,"http://localhost:9000/mcp");
  const baseText="connections:\n  edt: &base\n    url: http://localhost:8000/mcp\n  v8std:\n    <<: *base\n";
  const baseEdit=patch_yaml_draft(baseText,{kind:"set",path:["connections","edt","url"],value:"http://localhost:9000/mcp"});
  assert.equal(parse(baseEdit.text).connections.edt.url,"http://localhost:9000/mcp");assert.equal(parse(baseEdit.text).connections.v8std.url,"http://localhost:8000/mcp");
  const removeInherited=patch_yaml_draft(baseText,{kind:"remove",path:["connections","v8std","url"]});
  assert.deepEqual(parse(removeInherited.text).connections.v8std,{});assert.match(removeInherited.text,/\n$/);
  const override=baseText+"    url: http://localhost:9000/mcp\n";
  const removeOverride=patch_yaml_draft(override,{kind:"remove",path:["connections","v8std","url"]});
  assert.equal(parse(removeOverride.text).connections.v8std.url,"http://localhost:8000/mcp");assert.match(removeOverride.text,/<<: \*base/);
  const nested=patch_yaml_draft("items:\n  - id: one # keep nested\n    path: src\n  - id: two\n    path: src2\n",{kind:"remove",path:["items",0]});
  assert.match(nested.text,/# keep nested/);assert.deepEqual(parse(nested.text).items,[{id:"two",path:"src2"}]);assert.equal(nested.reformatted,true);
  assert.throws(() => patch_yaml_draft("{}\n", { kind: "set", path: ["__proto__"], value: {} }), /путь/);
  const flow = "items: [one,   two, three] # retain\nmap: {a: 'x',  b: 0}\n";
  assert.equal(patch_yaml_draft(flow, { kind: "move", path: ["items", 0], to: 2 }).text,
    "items: [two,   three, one] # retain\nmap: {a: 'x',  b: 0}\n");
  assert.equal(patch_yaml_draft(flow, { kind: "remove", path: ["map", "b"] }).text,
    "items: [one,   two, three] # retain\nmap: {a: 'x'}\n");
  assert.equal(patch_yaml_draft(flow, { kind: "append", path: ["items", 3], value: false }).text,
    "items: [one,   two, three, false] # retain\nmap: {a: 'x',  b: 0}\n");
});

test("schema dictionary keys remain editable without prototype pollution", () => {
  for (const key of ["constructor", "prototype", "__proto__"]) {
    let text="connections:\n  edt:\n    headers_env: {}\n";
    const field=["connections","edt","headers_env",key];
    text=patch_yaml_draft(text,{kind:"set",path:field,value:"HEADER_ENV"}).text;
    const value=parse(text);check_schema(value,"project-local.schema.json");
    assert.equal(Object.hasOwn(value.connections.edt.headers_env,key),true);
    const combined=deep_merge({connections:{edt:{headers_env:{}}}},value);
    assert.equal(combined.connections.edt.headers_env[key],"HEADER_ENV");
    const runtime=deep_merge({mcp:{required:{edt:{headers_env:{}}}}},{mcp:{required:{edt:value.connections.edt}}});
    assert.equal(Object.hasOwn(runtime.mcp.required.edt.headers_env,key),true);
    text=patch_yaml_draft(text,{kind:"set",path:field,value:"CHANGED_ENV"}).text;
    text=patch_yaml_draft(text,{kind:"remove",path:field}).text;
    assert.equal(Object.hasOwn(parse(text).connections.edt.headers_env,key),false);
  }
  const collection=patch_yaml_draft("knowledge:\n  collection_uris: {}\n",{kind:"set",path:["knowledge","collection_uris","constructor"],value:"viking://resources/example"});
  check_schema(parse(collection.text),"project-local.schema.json");
  assert.throws(()=>patch_yaml_draft("{}\n",{kind:"set",path:["constructor"],value:{prototype:{polluted:true}}}),/путь/);
  assert.throws(()=>deep_merge({},JSON.parse('{"constructor":{"prototype":{"polluted":true}}}')),/Небезопасн/);
  assert.equal(Object.prototype.polluted,undefined);
});

test("reserved dictionary names survive real profile and connection resolution", t => {
  const f=fixture(t);
  f.profile.connections={edt:{headers_env:JSON.parse('{"constructor":"SHARED_ENV"}')}};
  f.profile.knowledge.mode="transitional";f.profile.knowledge.provider="openviking";f.profile.knowledge.collections=["constructor"];
  f.profile.knowledge.collection_uris=JSON.parse('{"constructor":"viking://resources/example"}');
  f.save();
  dump({connections:{edt:{headers_env:JSON.parse('{"__proto__":"LOCAL_ENV"}')}},knowledge:{collection_uris:JSON.parse('{"constructor":"viking://resources/updated"}')}},path.join(f.root,".ai/project.local.yaml"));
  const profile=project_profile(f.root),[effective]=resolved_settings(settings(f.env.EDT_AI_SETTINGS),f.root,profile);
  assert.equal(profile.knowledge.collection_uris.constructor,"viking://resources/updated");
  assert.equal(Object.hasOwn(effective.mcp.required.edt.headers_env,"__proto__"),true);
  assert.equal(effective.mcp.required.edt.headers_env.__proto__,"LOCAL_ENV");
  assert.equal(Object.prototype.polluted,undefined);
});


test("settings MCP exports two profiles as ZIP and previews the decoded documents", async t => {
  const f=fixture(t); f.save();
  const shared=path.join(f.root,".ai","project.yaml");fs.writeFileSync(shared,"# retained on export\n"+fs.readFileSync(shared,"utf8"));
  const {client,choose}=await dialog_session(t,f);choose(path.join(f.base,"project.zip"));
  const edit=await client.call("settings.edit",{layerScope:"profile",format:"yaml"});
  const exported=await client.call("settings.transfer_export",{projectRoot:f.root,scope:"both",includeCommandsAndComments:true});
  const file=exported._meta.data.path;
  assert.match(file,/\.zip$/i);
  const decoded=await client.call("settings.transfer_decode",{base64:fs.readFileSync(file).toString("base64")});
  assert.match(decoded._meta.data.documents.profile,/^# retained on export/);
  const preview=await client.call("settings.transfer_preview",{projectRoot:f.root,baseRevision:edit._meta.data.baseRevision,documents:decoded._meta.data.documents});
  assert.equal(preview._meta.data.files.length,2);
});

test("profile export rejects credentials passed as separate command arguments", async t => {
  const f=fixture(t);environment(t,f.env);
  f.profile.testing.commands=[{id:"check",repository_id:"product",argv:["tool","--db-password","my-private-value"],effects:[]}];f.save();
  const backend=new SettingsBackend(f.state,f.env.EDT_AI_SETTINGS);
  const safe=await backend.main({action:"transfer_export",scope:"profile",projectRoot:f.root});
  assert.doesNotMatch(safe.text,/my-private-value/);assert.deepEqual(parse(safe.text).testing.commands,[]);
  await assert.rejects(backend.main({action:"transfer_export",scope:"profile",projectRoot:f.root,includeCommandsAndComments:true}),/секрет/);
  f.profile.testing.commands[0].argv=["mysql","-phunter2"];f.save();
  await assert.rejects(backend.main({action:"transfer_export",scope:"profile",projectRoot:f.root,includeCommandsAndComments:true}),/секрет/);
  f.profile.testing.commands[0].argv=["curl","--user","alice:hunter2","https://example.org"];f.save();
  await assert.rejects(backend.main({action:"transfer_export",scope:"profile",projectRoot:f.root,includeCommandsAndComments:true}),/секрет/);
  f.profile.testing.commands=[];f.save();const file=path.join(f.root,".ai","project.yaml");fs.appendFileSync(file,"# password my-private-value\n");
  await assert.rejects(backend.main({action:"transfer_export",scope:"profile",projectRoot:f.root,includeCommandsAndComments:true}),/секрет/);
});

test("settings import restores previous files when read-back verification fails", async t => {
  const f = fixture(t); f.save(); environment(t, f.env);
  const backend = new SettingsBackend(), target = path.join(f.root, ".ai", "project.yaml");
  const original = fs.readFileSync(target), replacement = structuredClone(f.profile);
  replacement.project.id = "replacement";
  const input = { documents:{profile:JSON.stringify(replacement)}, projectRoot: f.root, baseRevision:backend.edit_revision() };
  const preview = await backend.main({ action: "transfer_preview", ...input });
  const read = fs.readFileSync, rename = fs.renameSync;
  let verifyNext = false;
  fs.renameSync = (...args) => {
    const result = rename(...args);
    if (args[1] === target) verifyNext = true;
    return result;
  };
  fs.readFileSync = (...args) => {
    if (verifyNext && args[0] === target) { verifyNext = false; throw new Error("Injected verification read failure"); }
    return read(...args);
  };
  try {
    await assert.rejects(backend.main({ action: "transfer_apply", ...input, revision: preview.revision, replace: true }), /verification read failure/);
  } finally { fs.readFileSync = read; fs.renameSync = rename; }
  assert.deepEqual(fs.readFileSync(target), original);
  assert.equal(fs.existsSync(f.env.EDT_AI_SETTINGS), false);
});

test("settings use the chat launch directory before a profile exists without host roots", async (t) => {
  const f = fixture(t), sub = path.join(f.root, "src");
  fs.mkdirSync(path.join(f.root, ".git"));
  // A saved selection from a different chat must not override the launch cwd.
  dump({ active_project: f.base }, f.env.EDT_AI_SETTINGS);
  const client = new McpClient([process.execPath, path.join(ROOT, "mcp/settings.mjs")], sub, { ...f.env, EDT_AI_PROJECT_ROOT: "" }, 10);
  f.clients.push(client);
  await client.request("initialize", { protocolVersion: "2025-11-25", capabilities: {} });
  const profile = (await client.call("settings.profile", {})).structuredContent;
  assert.equal(profile.values.projectRoot, f.root);
  assert.equal(profile.profile.status, "missing");
  const view = (await client.call("settings.read", {})).structuredContent;
  assert.equal(view.schema.properties.projectRoot.readOnly, true);
  assert.equal(view.preparationScope, f.root + "#first");
  assert.equal(fs.existsSync(path.join(f.root, ".ai")), false);
  await assert.rejects(client.call("settings.pick_directory", {}), /закреплён/);
  assert.equal((await client.call("settings.create", {})).structuredContent.profile.status, "loaded");
});

test("unsupported roots fall back to cwd but the plugin install directory is never a chat project", async (t) => {
  const f = fixture(t);
  for (const directory of [f.root, ROOT]) {
    const client = new McpClient([process.execPath, path.join(ROOT, "mcp/settings.mjs")], directory, { ...f.env, EDT_AI_PROJECT_ROOT: "" }, 10);
    f.clients.push(client);
    const send = client.send.bind(client);
    client.send = message => send(message.result?.roots ? { id: message.id, error: { code: -32601, message: "Not supported" } } : message);
    await client.initialize();
    const view = (await client.call("settings.read", {})).structuredContent;
    assert.equal(view.values.projectRoot, directory === ROOT ? "" : f.root);
    assert.equal(view.projectSelection.status, directory === ROOT ? "unselected" : "selected");
  }
});

test("the directory picker binds the canonical project without writes and discards a choice after host roots change", async (t) => {
  const f = fixture(t), plugin = path.join(f.base, "plugin"), choice = path.join(f.base, "choice.json"),
    started = path.join(f.base, "started"), released = path.join(f.base, "released"), other = path.join(f.base, "other");
  fs.mkdirSync(path.join(f.root, ".git")); fs.mkdirSync(other);
  for (const directory of ["mcp", "scripts", "assets"]) fs.mkdirSync(path.join(plugin, directory), { recursive: true });
  for (const file of ["plugin.json", "mcp/settings.mjs", "mcp/settings-operations.mjs", "scripts/icons.mjs", "scripts/selection.mjs", "scripts/project_paths.mjs", "scripts/casefold.mjs", "scripts/compatibility.mjs", "scripts/diagnostics.mjs", "scripts/mcp_codec.mjs", "assets/icon.svg"])
    fs.copyFileSync(path.join(ROOT, file), path.join(plugin, file));
  for (const name of ["common", "setup_readiness", "processes"])
    fs.writeFileSync(path.join(plugin, "scripts", name + ".mjs"), `export * from ${JSON.stringify(pathToFileURL(path.join(ROOT, "scripts", name + ".mjs")).href)};`);
  fs.writeFileSync(path.join(plugin, "scripts/settings_folder.mjs"),
    `import fs from 'node:fs'; export async function folder_action() { const value=JSON.parse(fs.readFileSync(${JSON.stringify(choice)},'utf8')); if(value.wait) { fs.writeFileSync(${JSON.stringify(started)},''); while(!fs.existsSync(${JSON.stringify(released)})) await new Promise(done=>setTimeout(done,5)); } return value.directory; }`);
  fs.writeFileSync(path.join(plugin, "scripts/settings_backend.mjs"),
    `import { SettingsBackend } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "scripts/settings_backend.mjs")).href)}; let input=''; for await (const chunk of process.stdin) input+=chunk; try { console.log(JSON.stringify({ok:true,result:await new SettingsBackend().main(JSON.parse(input))})); } catch(error) { console.log(JSON.stringify({ok:false,error:error.message})); process.exitCode=1; }`);
  const client = new McpClient([process.execPath, path.join(plugin, "mcp/settings.mjs")], plugin, { ...f.env, EDT_AI_PROJECT_ROOT: "" }, 10);
  f.clients.push(client); client.roots = []; await client.initialize();
  async function finishedPicker() {
    const started = (await client.call("settings.pick_directory", {})).structuredContent;
    assert.equal(started.status, "running");
    return finishOperation(started.id);
  }
  async function finishOperation(id, meta) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const response = await client.request("tools/call", { name: "settings.operation", arguments: { operationId: id }, ...(meta ? { _meta: meta } : {}) });
      assert.notEqual(response.isError, true, response.content?.[0]?.text);
      const job = response.structuredContent;
      if (job.status !== "running") return job;
      await sleep(5);
    }
    assert.fail("directory operation did not finish");
  }
  fs.writeFileSync(choice, JSON.stringify({ directory: path.join(f.root, "src") }));
  const selection = await finishedPicker();
  assert.equal(selection.status, "completed");
  const picked = (await client.call("settings.read", {})).structuredContent;
  assert.equal(picked.values.projectRoot, f.root);
  assert.equal(picked.profile.status, "missing");
  assert.equal(picked.projectSelection.locked, false);
  assert.equal(fs.existsSync(path.join(f.root, ".ai")), false);
  assert.deepEqual(fs.readdirSync(f.state).filter(name => name !== "diagnostics"), []);
  fs.writeFileSync(choice, JSON.stringify({ directory: null }));
  assert.equal((await finishedPicker()).result.cancelled, true);
  assert.equal((await client.call("settings.read", {})).structuredContent.values.projectRoot, f.root);
  // App polling may still carry the previous profile while the native picker
  // has already selected its replacement. Reading a job must never rebind it.
  const previousScope = { "1c-ai-core/projectRoot": f.root, "1c-ai-core/navigation": "profiles" };
  fs.mkdirSync(path.join(other, "src"));dump(f.profile, path.join(other, ".ai/project.yaml"));
  const profileBefore = fs.readFileSync(path.join(other, ".ai/project.yaml"));
  fs.writeFileSync(choice, JSON.stringify({ directory: other }));
  const replacement = (await client.request("tools/call", { name: "settings.pick_directory", arguments: { projectRoot: f.root }, _meta: previousScope })).structuredContent;
  const replaced = await finishOperation(replacement.id, previousScope);
  assert.equal(replaced.status, "completed");assert.equal(replaced.result.values.projectRoot, other);
  const selected = (await client.call("settings.select_profile", { projectRoot: other })).structuredContent;
  assert.equal(selected.values.projectRoot, other);assert.equal(selected.profile.status, "loaded");
  assert.equal(selected.profileHistory.some(item => item.projectRoot === other), true);
  assert.equal((await client.call("settings.read", {})).structuredContent.values.projectRoot, other);
  assert.deepEqual(fs.readFileSync(path.join(other, ".ai/project.yaml")), profileBefore);
  assert.equal(fs.existsSync(f.env.EDT_AI_SETTINGS), false);
  await client.call("settings.select_profile", { projectRoot: f.root });
  fs.writeFileSync(choice, JSON.stringify({ directory: f.root, wait: true }));
  const pending = (await client.call("settings.pick_directory", {})).structuredContent;
  assert.equal(pending.status, "running");
  const deadline = Date.now() + 2000;
  while (!fs.existsSync(started) && Date.now() < deadline) await sleep(5);
  assert.ok(fs.existsSync(started));
  const progress = (await client.call("settings.operation", {})).structuredContent;
  assert.equal(progress.id, pending.id);
  assert.equal(progress.action, "pick_directory");
  assert.equal(progress.status, "running");
  assert.equal((await client.call("settings.read", {})).structuredContent.operation.id, pending.id);
  await assert.rejects(client.call("settings.update", { set: { projectRoot: other } }), /Завершите или отмените выбор папки/);
  await assert.rejects(client.call("settings.run_check", { authorization: { scope: f.root + "#first", effects: ["launch"], evidence: "fixture" } }), /Завершите или отмените выбор папки/);
  client.roots = [{ uri: pathToFileURL(other).href }]; client.notify("notifications/roots/list_changed");
  assert.equal((await client.call("settings.read", {})).structuredContent.values.projectRoot, other);
  fs.writeFileSync(released, "");
  const discarded = await finishOperation(pending.id);
  assert.equal(discarded.status, "failed");
  assert.match(discarded.error, /изменилась во время выбора/);
  assert.equal((await client.call("settings.read", {})).structuredContent.values.projectRoot, other);
});

test("chat view picker chooses another directory without rebinding the project", async t => {
  const f = fixture(t); f.save();
  const other = path.join(f.base, "Other"); fs.mkdirSync(path.join(other, "src"), { recursive: true });
  dump({ ...f.profile, project: { ...f.profile.project, id: "Other" } }, path.join(other, ".ai/project.yaml"));
  const { client, choose } = await dialog_session(t, f);
  const finish = async () => {
    const start = (await client.call("settings.pick_view_directory", {})).structuredContent;
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const job = (await client.call("settings.operation", { operationId: start.id, waitMs: 1000 })).structuredContent;
      if (job.status !== "running") return job;
    }
    assert.fail("view picker did not finish");
  };
  choose(other);
  const picked = await finish(); assert.equal(picked.status, "completed"); assert.equal(picked.result.directory, other);
  assert.equal((await client.call("settings.read", {})).structuredContent.values.projectRoot, f.root);
  const viewed = (await client.call("settings.select_profile", { projectRoot: picked.result.directory })).structuredContent;
  assert.equal(viewed.viewOnly, true); assert.equal(viewed.chatProjectRoot, f.root);
  assert.equal((await client.call("settings.read", {})).structuredContent.values.projectRoot, f.root);
  choose(null); assert.equal((await finish()).result.cancelled, true);
  const unbound = await dialog_session(t, f, { extra: { EDT_AI_PROJECT_ROOT: "" }, roots: [] });
  await assert.rejects(unbound.client.call("settings.pick_view_directory", {}), /определите каталог/);
});

test("chat profile tools discover the selected profile and preserve instructions/instance overrides", async (t) => {
  const f = fixture(t), client = await session(t, "mcp/settings.mjs", [], f);
  const catalogue = (await client.request("tools/list")).tools;
  for (const name of ["settings.profile", "settings.create", "settings.load", "settings.import", "settings.export", "settings.read", "settings.update", "settings.preview", "settings.apply", "settings.run_check", "settings.operation"]) {
    assert.ok(catalogue.find(tool => tool.name === name)._meta.ui.visibility.includes("model"));
  }
  const initial = await client.call("settings.read", {});
  assert.deepEqual(JSON.parse(initial.content[0].text), initial.structuredContent);
  assert.equal((await client.call("settings.profile", {})).structuredContent.profile.status, "missing");
  assert.ok(!fs.existsSync(path.join(f.root, ".ai")));
  fs.writeFileSync(path.join(f.root, "AGENTS.md"), "Existing project rules\n");
  fs.writeFileSync(path.join(f.root, "AGENTS.override.md"), "Override project rules\n");
  await client.call("settings.update", { set: { edtUrl: "http://localhost:18111/mcp" } });
  const created = (await client.call("settings.create", {})).structuredContent;
  assert.equal(created.profile.status, "loaded");
  assert.deepEqual(created.projectInstructions, {
    created: [".ai/PROJECT.md"], preserved: ["AGENTS.override.md", "AGENTS.md"], contentValidated: false,
    overrideFile: "AGENTS.override.md",
  });
  assert.equal(created.values.edtUrl, "http://localhost:18111/mcp");
  assert.match(created.sessionGuidance, /сообщите агенту путь к его папке/);
  assert.match(created.sessionGuidance, /«Подготовить и проверить»/);
  assert.doesNotMatch(created.sessionGuidance, /selectedDirectory|projectRoot|core_runtime_status|roots/);
  assert.equal(fs.readFileSync(path.join(f.root, "AGENTS.md"), "utf8"), "Existing project rules\n");
  assert.equal(fs.readFileSync(path.join(f.root, "AGENTS.override.md"), "utf8"), "Override project rules\n");
  assert.equal(fs.existsSync(f.env.EDT_AI_SETTINGS), false);
  const profileFile = path.join(f.root, ".ai/project.yaml"), before = fs.readFileSync(profileFile);
  await assert.rejects(client.call("settings.create", {}), /уже существует/);
  assert.deepEqual(fs.readFileSync(profileFile), before);
  const token = path.join(f.state, "projects");
  assert.ok(fs.existsSync(token));
  const loaded = (await client.call("settings.load", {})).structuredContent;
  assert.equal(loaded.projectInstructions, undefined);
  assert.equal(loaded.reload, "requested");
  assert.equal(loaded.readiness, "not_checked");
  assert.deepEqual(fs.readFileSync(profileFile), before);
  const other = path.join(f.base, "other"); fs.mkdirSync(other);
  for (const name of ["settings.load", "settings.create"])
    await assert.rejects(client.call(name, { projectRoot: other }), /текущим чатом/);
  assert.ok(!fs.existsSync(path.join(other, ".ai")));
});

test("MCP creation rejects instruction directories without creating a profile or reconnect signal", async (t) => {
  const f = fixture(t), client = await session(t, "mcp/settings.mjs", [], f);
  fs.mkdirSync(path.join(f.root, "AGENTS.override.md"));
  await assert.rejects(client.call("settings.create", {}), /обычный файл/);
  assert.ok(!fs.existsSync(path.join(f.root, ".ai")));
  assert.ok(!fs.existsSync(reconnect_file(f.state, f.root)));
  assert.equal((await client.call("settings.read", {})).structuredContent.profile.status, "missing");
});

test("existing and invalid profiles are visible without importing or starting services", async (t) => {
  const f = fixture(t); f.save();
  const before = fs.readFileSync(path.join(f.root, ".ai/project.yaml"));
  const client = await session(t, "mcp/settings.mjs", [], f);
  const profile = (await client.call("settings.profile", {})).structuredContent;
  assert.equal(profile.profile.status, "loaded");
  assert.equal(profile.values.projectRoot, f.root);
  assert.deepEqual(fs.readFileSync(path.join(f.root, ".ai/project.yaml")), before);
  assert.equal(fs.existsSync(path.join(f.state, "runtime-lock.json")), false);
  fs.writeFileSync(path.join(f.root, ".ai/project.yaml"), "invalid");
  assert.equal((await client.call("settings.read", {})).structuredContent.profile.status, "invalid");
  await assert.rejects(client.call("settings.load", {}));
  assert.equal(fs.readFileSync(path.join(f.root, ".ai/project.yaml"), "utf8"), "invalid");
});

test("profile reload signals only the selected instance", async (t) => {
  const f = fixture(t); environment(t, f.env); f.save();
  const first = reconnect_file(f.state, f.root);
  const second = path.join(path.dirname(first), "second.reconnect.json");
  fs.mkdirSync(path.dirname(second), { recursive: true });fs.writeFileSync(second, '{"id":"unchanged"}');
  const client = await session(t, "mcp/settings.mjs", [], f);
  await client.call("settings.load", {});
  assert.ok(JSON.parse(fs.readFileSync(first, "utf8")).id);
  assert.equal(fs.readFileSync(second, "utf8"), '{"id":"unchanged"}');
});

test("SessionStart discovers profile data without writes and stops at nested Git boundaries", (t) => {
  const f = fixture(t); f.save();
  const sub = path.join(f.root, "docs");fs.mkdirSync(sub);
  const run = (cwd, env = { ...f.env, EDT_AI_PROJECT_ROOT: "" }) => success(node("hooks/session-start.mjs", [], { env, input: JSON.stringify({ cwd, source: "startup" }) })).hookSpecificOutput.additionalContext;
  assert.match(run(sub), /"status":"loaded"/);
  assert.match(run(sub), /Use settings\.inspect once/);
  assert.match(run(sub), /Open settings UI only on an explicit user request/);
  assert.doesNotMatch(run(sub), /Use settings\.profile|Use settings\.load|restart Codex/);
  assert.ok(!fs.existsSync(f.env.EDT_AI_SETTINGS));
  fs.mkdirSync(path.join(sub, ".git"));
  assert.match(run(sub), /"status":"missing"/);
  assert.match(run(sub, f.env), /"status":"loaded"/);
  assert.deepEqual(fs.readdirSync(f.state).filter(name => name !== "diagnostics"), []);
});

test("project YAML export imports into another repository without local overrides", async t => {
  const f=fixture(t); environment(t,f.env); f.save(); const backend=new SettingsBackend(f.state,f.env.EDT_AI_SETTINGS);
  await backend.main({action:"update",set:{edtUrl:"http://localhost:18112/mcp"}});
  const exported=await backend.main({action:"transfer_export",scope:"profile",includeCommandsAndComments:true});
  const other=path.join(f.base,"destination"); fs.mkdirSync(path.join(other,"src"),{recursive:true}); process.env.EDT_AI_PROJECT_ROOT=other;
  const context=await backend.main({action:"transfer_context"}),args={baseRevision:context.baseRevision,documents:{profile:exported.text}};
  const preview=await backend.main({action:"transfer_preview",...args}); assert.equal(preview.projectRoot,other);
  await backend.main({action:"transfer_apply",...args,revision:preview.revision,replace:true});
  assert.deepEqual(load(path.join(other,".ai/project.yaml")),f.profile);
  assert.equal((await backend.main({action:"read"})).values.edtUrl,"");
});

test("settings discovery negotiates legacy sessions and refuses stateless calls before configuration", async (t) => {
  const f = fixture(t),
    client = await session(t, "mcp/settings.mjs", [], f);
  const read = (await client.call("settings.read", {})).structuredContent;
  assert.equal(read.values.projectRoot, f.root);
  assert.equal(read.preparationScope, f.root + "#first");
  assert.equal(read.schema.properties.projectRoot.readOnly, true);
  const discovery = await client.request("server/discover");
  assert.equal(discovery.capabilities.extensions?.["openai/settings"], undefined);
  const modernProbe = await client.request("server/discover", {
      _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
    });
  assert.equal(modernProbe.resultType, "complete");
  assert.equal(modernProbe.capabilities.extensions?.["openai/settings"], undefined);
  assert.ok(modernProbe.supportedVersions.includes("2025-11-25"));
  await assert.rejects(
    client.request("tools/list", { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } }),
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
test("one global Settings app opens without a duplicate native section, chat or selected project", async (t) => {
  const f = fixture(t);
  const client = new McpClient([process.execPath, path.join(ROOT, "mcp/settings.mjs")], ROOT, { ...f.env, EDT_AI_PROJECT_ROOT: "" }, 10);
  f.clients.push(client);
  const discovery = await client.request("server/discover", { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } });
  assert.equal(discovery.resultType, "complete");
  const initialized = await client.request("initialize", { protocolVersion: discovery.supportedVersions[0], capabilities: {} });
  assert.equal(discovery.capabilities.extensions?.["openai/settings"], undefined);
  assert.equal(initialized.capabilities.extensions?.["openai/settings"], undefined);
  assert.equal(initialized.capabilities.experimental?.["openai/settings"], undefined);
  const read = (await client.call("settings.read", {})).structuredContent;
  assert.equal(read.values.projectRoot, "");
  assert.equal(read.layout, undefined);
  const tools = (await client.request("tools/list")).tools;
  assert.equal(tools.some(tool => ["settings.native_read", "settings.manage"].includes(tool.name)), false);
  const action = tools.find(tool => tool.name === "settings.open");
  assert.equal(action.title, "Настройки");
  assert.deepEqual(tools.filter(tool => tool._meta?.["openai/ui"]?.entrypoints?.some(entry => entry.type === "global")).map(tool => tool.name), [action.name]);
  assert.deepEqual(action._meta["openai/ui"].entrypoints, [{ type: "global" }]);
  assert.deepEqual(action._meta.ui.visibility, ["app"]);
  assert.deepEqual(tools.find(tool => tool.name === "settings.profile")._meta["openai/ui"].entrypoints, [{ type: "thread" }]);
  assert.deepEqual(action.inputSchema.properties, {});
  assert.deepEqual(tools.filter(tool => tool._meta?.ui?.resourceUri).map(tool => tool.name).sort(),
    ["settings.export", "settings.import", "settings.open", "settings.profile"]);
  assert.match(tools.find(tool => tool.name === "settings.profile").description, /only on an explicit user request/);
  const entry = await client.call(action.name, {}), opened = entry.structuredContent;
  assert.equal(opened.mode, "profile");
  assert.equal(opened.navigation, "profiles");
  assert.equal(JSON.parse(entry.content[0].text).navigation, "profiles", "global navigation survives hosts that forward only text content");
  assert.equal((await client.call("settings.profile", {})).structuredContent.navigation, "project");
  const resource = await client.request("resources/read", { uri: action._meta.ui.resourceUri });
  assert.match(resource.contents[0].text, /id="editSettingsButton"/);
  assert.deepEqual(resource.contents[0]._meta["openai/ui"].availableDisplayModes,["fullscreen"]);
  assert.deepEqual(fs.readdirSync(f.state).filter(name => name !== "diagnostics"), []);
});

test("the global Settings app stays available when settings or the project profile are broken", async (t) => {
  const f = fixture(t); f.save();
  fs.writeFileSync(f.env.EDT_AI_SETTINGS, "invalid settings JSON");
  fs.writeFileSync(path.join(f.root, ".ai/project.yaml"), "project: [invalid");
  const before = fs.readFileSync(f.env.EDT_AI_SETTINGS);
  const client = await session(t, "mcp/settings.mjs", [], f);
  const tools = (await client.request("tools/list")).tools;
  const app = tools.find(tool => tool._meta?.["openai/ui"]?.entrypoints?.some(entry => entry.type === "global"));
  const opened = (await client.call(app.name, {})).structuredContent;
  assert.equal(opened.navigation, "profiles");
  assert.equal(opened.configurationError, true);
  assert.deepEqual(fs.readFileSync(f.env.EDT_AI_SETTINGS), before);
});

test("profile editor requires confirmation and preserves a backup", async t => {
  const f=fixture(t); environment(t,f.env); f.save(); const backend=new SettingsBackend(f.state,f.env.EDT_AI_SETTINGS);
  const edit=await backend.main({action:"edit",layerScope:"profile",format:"yaml"}), data=parse(edit.text); data.project.purpose="Updated purpose";
  const args={mode:"layer",layerScope:"profile",baseRevision:edit.baseRevision,text:JSON.stringify(data)};
  const preview=await backend.main({action:"preview",...args});
  await assert.rejects(backend.main({action:"apply",...args,revision:preview.revision}),/замену/);
  const result=await backend.main({action:"apply",...args,revision:preview.revision,replace:true});
  assert.deepEqual(load(result.backup),f.profile); assert.equal(load(path.join(f.root,".ai/project.yaml")).project.purpose,"Updated purpose");
});
for(const changed of ["payload","config","override","masked override"]) test("transfer rejects changed "+changed+" without writes",async t=>{
  const f=fixture(t); environment(t,f.env); f.save(); const backend=new SettingsBackend(f.state,f.env.EDT_AI_SETTINGS);
  if(changed==="masked override")process.env.EDT_AI_EDT_URL="http://localhost:18104/mcp";
  const context=await backend.main({action:"transfer_context"}),args={baseRevision:context.baseRevision,documents:{profile:JSON.stringify(f.profile)}};
  const preview=await backend.main({action:"transfer_preview",...args}),before=fs.readFileSync(path.join(f.root,".ai/project.yaml"));
  if(changed==="payload")args.documents.profile=JSON.stringify({...f.profile,project:{...f.profile.project,purpose:"different"}});
  if(changed==="config")dump({mcp:{managed:{"code-index":{version:"1.2.3"}}}},f.env.EDT_AI_SETTINGS);
  if(changed.includes("override"))dump({connections:{edt:{url:"http://localhost:18105/mcp"}}},path.join(f.root,".ai/project.local.yaml"));
  await assert.rejects(backend.main({action:"transfer_apply",...args,revision:preview.revision,replace:true}),/изменились/);
  assert.deepEqual(fs.readFileSync(path.join(f.root,".ai/project.yaml")),before);
});

test("parallel instances share project-local settings; empty URL disconnects", async (t) => {
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
    "http://localhost:18112/mcp",
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
    client.call("settings.transfer_context", { projectRoot: f.root }),
    /проект текущего чата|другому каталогу/,
  );
  client.roots = [
    { uri: pathToFileURL(f.root).href },
    { uri: pathToFileURL(other).href },
  ];
  client.notify("notifications/roots/list_changed");
  await assert.rejects(
    client.call("settings.update", { set: { edtUrl: "http://localhost/mcp" } }),
    /Не удалось однозначно определить папку проекта/,
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
test("subdirectory and Git root use one binding without a shared EDT URL", async (t) => {
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
  assert.equal(read.values.edtUrl, "");
  const context = (await client.call("settings.transfer_context", { projectRoot: f.root }))._meta.data;
  assert.equal(context.projectRoot, f.root);
  fs.mkdirSync(path.join(sub, ".git"));
  await assert.rejects(
    client.call("settings.transfer_context", { projectRoot: f.root }),
    /проект текущего чата|другому каталогу/,
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
  fs.mkdirSync(path.join(plugin, "assets"));
  fs.copyFileSync(path.join(ROOT,"plugin.json"),path.join(plugin,"plugin.json"));
  for (const name of ["icons.mjs", "selection.mjs", "project_paths.mjs", "casefold.mjs", "compatibility.mjs", "diagnostics.mjs", "support_bundle.mjs", "mcp_codec.mjs"])
    fs.copyFileSync(path.join(ROOT, "scripts", name), path.join(plugin, "scripts", name));
  fs.writeFileSync(path.join(plugin, "scripts/settings_folder.mjs"), `export async function folder_action() { return ${JSON.stringify(path.join(f.base, "report.json"))}; }`);
  for (const name of ["common", "profile", "settings_export", "setup_readiness", "processes"])
    fs.writeFileSync(path.join(plugin, "scripts", name + ".mjs"), `export * from ${JSON.stringify(pathToFileURL(path.join(ROOT, "scripts", name + ".mjs")).href)};`);
  fs.copyFileSync(path.join(ROOT, "assets/icon.svg"), path.join(plugin, "assets/icon.svg"));
  for (const name of ["settings.mjs", "settings-operations.mjs"])
    fs.copyFileSync(
      path.join(ROOT, "mcp", name),
      path.join(plugin, "mcp", name),
    );
  fs.writeFileSync(
    path.join(plugin, "scripts/settings_backend.mjs"),
    `import fs from 'node:fs';
    import path from 'node:path';
    let input=''; for await (const chunk of process.stdin) input+=chunk;
    const r=JSON.parse(input), state=process.env.EDT_AI_STATE_DIR;
    if(r.action==='check') {
      fs.writeFileSync(path.join(state,'check-started'),'');
      const deadline=Date.now()+30000;
      while(!fs.existsSync(path.join(state,'check-release'))) {
        if(Date.now()>deadline) throw new Error('Check was not released');
        await new Promise(done=>setTimeout(done,20));
      }
    } else await new Promise(done=>setTimeout(done,200));
    fs.appendFileSync(path.join(state,'calls'),r.action+'\\n');
    if(r.set?.edtUrl==='unknown') { process.stderr.write('unmarked-backend-secret-8931'); process.exit(3); }
    if(r.action==='rebuild_index'){process.send?.({type:'progress',progress:{phase:'indexing',total:2,completed:1,repository:'extension',edtProject:'Extension',message:'unmarked-progress-secret-2184'}});await new Promise(done=>setTimeout(done,400));}
    console.log(JSON.stringify({ok:true,result:r.set?.edtUrl==='malformed'?null:{managed:[],values:{projectRoot:process.env.EDT_AI_PROJECT_ROOT}}}));if(process.connected)process.disconnect();`,
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
  const started = path.join(f.state, "check-started");
  try {
    assert.equal(operation.status, "running");
    for (let i = 0; i < 750 && !fs.existsSync(started); i++) await sleep(20);
    assert.ok(fs.existsSync(started), "check backend must start before the export");
    await assert.rejects(
      client.call("settings.update", { set: { edtUrl: "x" } }),
      /ещё выполняется/,
    );
    const report = JSON.parse(fs.readFileSync((await client.call("settings.export_diagnostics", {}))._meta.data.path, "utf8"));
    assert.equal(report.snapshot.host.operation.id, operation.id);
    assert.equal(report.snapshot.host.operation.status, "running");
    assert.equal((await client.call("settings.operation", { operationId: operation.id })).structuredContent.status, "running");
  } finally {
    fs.writeFileSync(path.join(f.state, "check-release"), "");
  }
  const completed = (await client.call("settings.operation", { operationId: operation.id, waitMs: 10000 })).structuredContent;
  assert.equal(completed.status, "completed");
  assert.deepEqual(fs.readFileSync(path.join(f.state, "calls"), "utf8").trim().split("\n").sort(), ["check", "read"]);
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
  assert.doesNotMatch(client.stderr + JSON.stringify(status) + fs.readFileSync(path.join(f.state, "diagnostics/events.0.jsonl"), "utf8"), /unmarked-backend-secret-8931/);
  assert.notEqual(status.status, "running");
  const authorization = { scope: f.root + "#first", effects: ["launch"], evidence: "fixture" };
  for (const selection of [{}, { all: true, repository: "product" }, { all: false }])
    await assert.rejects(client.call("settings.rebuild_index", { ...selection, authorization }), /Выберите|Некорректное/);
  const rebuild = (await client.call("settings.rebuild_index", { all: true, authorization })).structuredContent;
  assert.equal(rebuild.status, "running"); assert.equal(rebuild.component, "code-index");
  let observed;
  for (let i = 0; i < 15; i++) {
    observed = (await client.call("settings.operation", { operationId: rebuild.id, waitMs: 100 })).structuredContent;
    if (observed.progress) break;
  }
  assert.equal(observed.status, "running"); assert.equal(observed.progress.phase, "indexing");
  assert.equal(observed.progress.completed, 1); assert.equal(observed.progress.total, 2);
  assert.equal(observed.progress.edtProject, "Extension"); assert.equal(observed.progress.message, undefined);
  assert.doesNotMatch(JSON.stringify(observed), /unmarked-progress-secret/);
  await assert.rejects(client.call("settings.rebuild_index", { all: true, authorization }), /ещё выполняется/);
  const rebuilt = (await client.call("settings.operation", { operationId: rebuild.id, waitMs: 1000 })).structuredContent;
  assert.equal(rebuilt.status, "completed"); assert.equal(rebuilt.progress.completed, 1);
  assert.equal(fs.readFileSync(path.join(f.state, "calls"), "utf8").split("\n").filter(action => action === "rebuild_index").length, 1);
});
