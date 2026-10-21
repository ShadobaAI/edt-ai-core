import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { fixture, environment, session, ROOT } from "./helpers.mjs";
import { SettingsBackend } from "../scripts/settings_backend.mjs";
import { dump } from "../scripts/common.mjs";
import { profile_history } from "../scripts/profile_history.mjs";
import { McpClient } from "../scripts/mcp_client.mjs";
import { project_directory } from "../scripts/project_paths.mjs";

test("history persists across sessions, detects damaged and removed profiles, and keeps unavailable directories", async t => {
  const f=fixture(t);environment(t,f.env);f.save();const backend=new SettingsBackend();
  await backend.main({action:"read"});assert.equal(fs.existsSync(path.join(f.state,"projects")),false);
  await backend.main({action:"read",remember:true});
  const other=path.join(f.base,"other");fs.mkdirSync(other);fs.mkdirSync(path.join(other,"src"));
  dump({...f.profile,project:{...f.profile.project,id:"other"}},path.join(other,".ai/project.yaml"));
  process.env.EDT_AI_PROJECT_ROOT=other;
  await backend.main({action:"read",remember:true});
  const entries=profile_history(f.state);assert.equal(entries.length,2);assert.ok(entries.every(item=>item.lastOpened&&item.repositoryCount===1));
  const lastOpened=entries.find(item=>item.projectRoot===other).lastOpened;
  await backend.main({action:"status"});assert.equal(profile_history(f.state).find(item=>item.projectRoot===other).lastOpened,lastOpened);
  fs.writeFileSync(path.join(other,".ai/project.yaml"),"invalid");assert.equal(profile_history(f.state).find(item=>item.projectRoot===other).status,"invalid");
  fs.rmSync(path.join(other,".ai/project.yaml"));assert.equal(profile_history(f.state).find(item=>item.projectRoot===other).status,"missing");
  fs.rmSync(other,{recursive:true});assert.equal(profile_history(f.state).find(item=>item.projectRoot===other).status,"unavailable");
  assert.equal(fs.existsSync(path.join(f.state,"runtime-lock.json")),false);
});

test("history selection previews another project without rebinding the chat or launching services", async t => {
  const f=fixture(t);f.save();const other=path.join(f.base,"other");fs.mkdirSync(path.join(other,"src"),{recursive:true});
  dump({...f.profile,project:{...f.profile.project,id:"other"}},path.join(other,".ai/project.yaml"));
  const client=await session(t,"mcp/settings.mjs",[],f);
  const preview=(await client.call("settings.select_profile",{projectRoot:other})).structuredContent;
  assert.equal(preview.viewOnly,true);assert.equal(preview.profile.projectId,"other");
  assert.equal(preview.chatProjectRoot,f.root);
  assert.equal((await client.call("settings.read",{})).structuredContent.values.projectRoot,f.root);
  const status=(await client.call("settings.status",{projectRoot:other})).structuredContent;
  assert.equal(status.viewOnly,true);assert.equal(status.values.projectRoot,other);
  assert.equal(status.summary.components.find(item=>item.id==="code-index").status,"stopped");
  const document=await client.call("settings.document",{projectRoot:other});
  assert.equal(document.structuredContent,undefined);
  assert.equal(JSON.parse(document._meta.data.text).profile.project.id,"other");
  assert.equal((await client.call("settings.read",{})).structuredContent.values.projectRoot,f.root);
  assert.equal(fs.existsSync(path.join(f.state,"runtime-lock.json")),false);
  assert.equal(fs.existsSync(path.join(other,".ai/project.local.yaml")),false);
  await assert.rejects(client.call("settings.update",{set:{projectRoot:other}}),/текущей сессией/);
});

test("an unbound settings window selects a profile explicitly and remembers it without changing shared configuration", async t => {
  const f=fixture(t);f.save();
  const client=new McpClient([process.execPath,path.join(ROOT,"mcp/settings.mjs")],ROOT,{...f.env,EDT_AI_PROJECT_ROOT:""},10);
  f.clients.push(client);client.roots=[];await client.initialize();
  const selected=(await client.call("settings.select_profile",{projectRoot:f.root})).structuredContent;
  assert.equal(selected.viewOnly,false);assert.equal(selected.values.projectRoot,f.root);
  assert.equal((await client.call("settings.read",{})).structuredContent.values.projectRoot,f.root);
  assert.equal(profile_history(f.state).length,1);
  assert.equal(fs.existsSync(f.env.EDT_AI_SETTINGS),false);
});

test("chat profile scope survives an independent app MCP connection and never overrides another locked chat", async t => {
  const f=fixture(t);f.save();
  const make=async()=>{const client=new McpClient([process.execPath,path.join(ROOT,"mcp/settings.mjs")],ROOT,{...f.env,EDT_AI_PROJECT_ROOT:""},10);f.clients.push(client);client.roots=[];await client.initialize();return client;};
  const chat=await make(),opened=(await chat.call("settings.profile",{projectRoot:f.root})).structuredContent;
  assert.equal(opened.values.projectRoot,f.root);assert.equal(opened.navigation,"project");
  const app=await make(),meta={"1c-ai-core/projectRoot":opened.values.projectRoot,"1c-ai-core/navigation":"project"};
  const read=(await app.request("tools/call",{name:"settings.read",arguments:{},_meta:meta})).structuredContent;
  assert.equal(read.profile.status,"loaded");assert.equal(read.values.projectRoot,f.root);assert.equal(read.schema.properties.projectRoot.readOnly,true);
  const other=path.join(f.base,"other");fs.mkdirSync(other);
  const denied=await app.request("tools/call",{name:"settings.read",arguments:{},_meta:{...meta,"1c-ai-core/projectRoot":other}});
  assert.equal(denied.isError,true);assert.equal((await app.call("settings.read",{})).structuredContent.values.projectRoot,f.root);
  assert.equal(fs.existsSync(f.env.EDT_AI_SETTINGS),false);assert.equal(fs.existsSync(path.join(f.state,"runtime-lock.json")),false);
});

test("a full settings app restores its scope across connections without locking its profile chooser", async t => {
  const f=fixture(t);f.save();const other=path.join(f.base,"other");fs.mkdirSync(other);
  const app=new McpClient([process.execPath,path.join(ROOT,"mcp/settings.mjs")],ROOT,{...f.env,EDT_AI_PROJECT_ROOT:""},10);f.clients.push(app);app.roots=[];await app.initialize();
  await app.request("tools/call",{name:"settings.read",arguments:{},_meta:{"1c-ai-core/projectRoot":f.root,"1c-ai-core/navigation":"profiles"}});
  const next=(await app.call("settings.select_profile",{projectRoot:other})).structuredContent;
  assert.equal(next.viewOnly,false);assert.equal(next.values.projectRoot,other);
});

test("reset removes only this instance's URL and restores profile inheritance", async t => {
  const f=fixture(t);environment(t,f.env);
  f.profile.connections={edt:{url:"http://localhost:18191/mcp"},v8std:{url:"http://localhost:18192/mcp"}};f.save();
  const backend=new SettingsBackend(),before=fs.readFileSync(path.join(f.root,".ai/project.yaml"));
  await backend.main({action:"update",set:{edtUrl:"http://localhost:18193/mcp",v8stdUrl:"",bslLsEnabled:false}});
  assert.equal((await backend.main({action:"read"})).connectionSources.edt,"instance");
  await backend.main({action:"reset_connection",connection:"edt"});
  const read=await backend.main({action:"read"});
  assert.equal(read.values.edtUrl,"http://localhost:18191/mcp");assert.equal(read.connectionSources.edt,"profile");
  assert.equal(read.values.v8stdUrl,"");assert.equal(read.values.bslLsEnabled,false);
  assert.deepEqual(fs.readFileSync(path.join(f.root,".ai/project.yaml")),before);
});

test("malformed optional history metadata never blocks a valid profile", async t => {
  const f=fixture(t);environment(t,f.env);f.save();const backend=new SettingsBackend();
  await backend.main({action:"read",remember:true});
  const file=path.join(project_directory(f.state,f.root),"profile-history.json");
  for(const value of [null,{root:f.root,lastOpened:42,repositoryCount:-1},{root:f.root,lastOpened:"invalid"}]){
    fs.writeFileSync(file,JSON.stringify(value));const history=profile_history(f.state);
    assert.equal(history[0].status,"loaded");assert.equal(history[0].lastOpened,null);
    assert.equal(history[0].repositoryCount,1);
  }
});
