import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { fixture, environment } from "./helpers.mjs";
import { SettingsBackend } from "../scripts/settings_backend.mjs";
import { setup_assets } from "../scripts/setup_readiness.mjs";
import { instance_directory } from "../scripts/project_paths.mjs";

async function ready_fixture(t) {
  const f=fixture(t);environment(t,f.env);f.save();let calls=0,wrongPath=false,noTools=false;
  const server=createServer(async(req,res)=>{
    let text="";for await(const part of req)text+=part;
    if(!text){res.writeHead(202).end();return;}const message=JSON.parse(text);calls++;
    const reply=result=>res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify({jsonrpc:"2.0",id:message.id,result}));
    if(message.method==="server/discover")return res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify({jsonrpc:"2.0",id:message.id,error:{code:-32601,message:"legacy"}}));
    if(message.method==="initialize")return reply({protocolVersion:"2025-11-25",serverInfo:{name:"fixture",version:"1"},capabilities:{tools:{}}});
    if(message.method.startsWith("notifications/"))return res.writeHead(202).end();
    if(message.method==="tools/list")return reply({tools:noTools&&req.url==="/v8std"?[]:[{name:"list_projects",inputSchema:{type:"object",properties:{format:{enum:["json"]}}}}]});
    if(message.method==="tools/call")return reply({content:[{type:"text",text:JSON.stringify({projects:[{name:"Product",path:wrongPath?f.base:f.root,open:true,state:"ready",edtProject:true}]})}]});
    reply({});
  });server.listen(0,"127.0.0.1");await once(server,"listening");t.after(()=>{server.closeAllConnections();return new Promise(done=>server.close(done));});
  const backend=new SettingsBackend(),url="http://127.0.0.1:"+server.address().port;
  await backend.main({action:"update",set:{codeIndexEnabled:false,bslLsEnabled:false,edtUrl:url+"/edt",v8stdUrl:url+"/v8std"}});
  return {f,backend,authorization:{scope:f.root+"#first",effects:["launch"],evidence:"user requested setup check"},count:()=>calls,wrong:()=>{wrongPath=true;},noTools:()=>{noTools=true;}};
}

test("one readiness check verifies externals, policy and skills, and passive reads reuse scoped evidence",async t=>{
  const {f,backend,authorization,count}=await ready_fixture(t);
  assert.equal((await backend.main({action:"read"})).readiness.state,"not_checked");
  await assert.rejects(backend.main({action:"check"}),/разрешения/);
  const result=await backend.main({action:"check",authorization});assert.equal(result.fullReadiness,"verified");assert.equal(result.readiness.state,"ready");
  for(const id of ["edt","v8std","policy","skills","source-guard","node","profile"])assert.equal(result.readiness.checks.find(check=>check.id===id).state,"ready",id);
  assert.equal(result.readiness.checks.find(check=>check.id==="code-index").state,"disabled");
  const contacted=count();assert.equal((await new SettingsBackend().main({action:"status"})).readiness.state,"ready");assert.equal(count(),contacted);
  process.env.EDT_AI_INSTANCE="another";assert.equal((await backend.main({action:"read"})).readiness.state,"not_checked");process.env.EDT_AI_INSTANCE="first";
  f.profile.repositories[0].edt_project="Changed";f.save();assert.equal((await backend.main({action:"read"})).readiness.state,"stale");
});

test("readiness never passes wrong EDT mappings or a connected server without tools",async t=>{
  const {backend,authorization,wrong,noTools}=await ready_fixture(t);wrong();noTools();
  const result=await backend.main({action:"check",authorization});assert.equal(result.readiness.state,"blocked");assert.equal(result.fullReadiness,"not_ready");
  assert.equal(result.external.edt.connected,true);assert.equal(result.external.edt.ready,false);
  assert.equal(result.external.v8std.connected,true);assert.equal(result.external.v8std.ready,false);
  assert.equal(result.readiness.checks.find(check=>check.id==="edt").state,"not_verified");
});

test("readiness includes enabled optional MCP and invalidates changed settings, expired or malformed receipts",async t=>{
  const {f,backend,authorization}=await ready_fixture(t);
  await backend.main({action:"check",authorization});
  const file=path.join(instance_directory(f.state,f.root),"first.readiness.json"),receipt=JSON.parse(fs.readFileSync(file));
  receipt.result.checkedAt=new Date(Date.now()-16*60*1000).toISOString();fs.writeFileSync(file,JSON.stringify(receipt));
  assert.equal((await backend.main({action:"read"})).readiness.state,"stale");
  fs.writeFileSync(file,'{"version":1,"result":{"state":"ready","checks":[null]}}');assert.equal((await backend.main({action:"read"})).readiness.state,"not_checked");
  await backend.main({action:"update",set:{openvikingEnabled:true}});
  const result=await backend.main({action:"check",authorization});assert.equal(result.readiness.state,"blocked");assert.equal(result.external.openviking.ready,false);
  await backend.main({action:"update",set:{v8stdUrl:""}});assert.equal((await backend.main({action:"read"})).readiness.state,"stale");
});

test("missing skill files block local setup assets",t=>{
  const f=fixture(t),plugin=path.join(f.base,"plugin");
  const files={"plugin.json":"{}","mcp.json":"{}","policy/default.json":"{}","policy/read-only-mcp.mjs":"fixture","hooks/guard.mjs":"fixture","hooks/session-start.mjs":"fixture","skills/catalog.yaml":"active: [demo]","skills/demo/SKILL.md":"# Demo","hooks/hooks.json":JSON.stringify({hooks:{SessionStart:[{hooks:[{type:"command",command:"node session-start.mjs"}]}],PreToolUse:[{hooks:[{type:"command",command:"node guard.mjs"}]}]}})};
  for(const [name,text]of Object.entries(files)){const file=path.join(plugin,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);}
  assert.ok(setup_assets(plugin).checks.every(check=>check.state==="ready"));
  fs.rmSync(path.join(plugin,"skills/demo/SKILL.md"));assert.equal(setup_assets(plugin).checks.find(check=>check.id==="skills").state,"error");
});
