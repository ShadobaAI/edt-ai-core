import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { fixture, environment } from "./helpers.mjs";
import { SettingsBackend } from "../scripts/settings_backend.mjs";
import { setup_assets } from "../scripts/setup_readiness.mjs";
import { instance_directory } from "../scripts/project_paths.mjs";
import { grant_preparation } from "../scripts/components.mjs";

async function ready_fixture(t) {
  const f=fixture(t);environment(t,f.env);f.save();let calls=0,wrongPath=false,noTools=false,indexChecks=0,settling=false,indexFailure=null;
  const server=createServer(async(req,res)=>{
    let text="";for await(const part of req)text+=part;
    if(!text){res.writeHead(202).end();return;}const message=JSON.parse(text);calls++;
    const reply=result=>res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify({jsonrpc:"2.0",id:message.id,result}));
    if (req.url === "/index" && indexFailure) return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: indexFailure } }));
    if(message.method==="server/discover")return res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify({jsonrpc:"2.0",id:message.id,error:{code:-32601,message:"legacy"}}));
    if(message.method==="initialize")return reply({protocolVersion:"2025-11-25",serverInfo:{name:"fixture",version:"1"},capabilities:{tools:{}}});
    if(message.method.startsWith("notifications/"))return res.writeHead(202).end();
    if(message.method==="tools/list"){
      if(req.url==="/bsl")return reply({tools:[...(["register_workspace_folder","list_workspace_folders","unregister_workspace_folder"].map(name=>({name,inputSchema:{type:"object"}}))),{name:"analyze",inputSchema:{type:"object",properties:{workspaceFolder:{type:"string"}},required:["workspaceFolder"]}}]});
      if(req.url==="/index")return reply({tools:[{name:"health",inputSchema:{type:"object"}}]});
      return reply({tools:noTools&&req.url==="/v8std"?[]:[{name:"list_projects",inputSchema:{type:"object",properties:{format:{enum:["json"]}}}}]});
    }
    if(message.method==="tools/call"&&req.url==="/index")return reply({structuredContent:{mcp:{status:"ok"},daemon:{status:"online"},repos:[{repo:"product",root_path:f.root,path_status:{status:"ready"},data_version:settling&&++indexChecks===1?{}:{stale:false}}]}});
    if(message.method==="tools/call")return reply({content:[{type:"text",text:JSON.stringify({projects:[{name:"Product",path:wrongPath?f.base:f.root,open:true,state:"ready",edtProject:true}]})}]});
    reply({});
  });server.listen(0,"127.0.0.1");await once(server,"listening");t.after(()=>{server.closeAllConnections();return new Promise(done=>server.close(done));});
  const backend=new SettingsBackend(),url="http://127.0.0.1:"+server.address().port;
  await backend.main({action:"update",set:{codeIndexEnabled:false,bslLsEnabled:false,edtUrl:url+"/edt",v8stdUrl:url+"/v8std"}});
  return {f,backend,url,authorization:{scope:f.root+"#first",effects:["launch"],evidence:"user requested setup check"},count:()=>calls,wrong:()=>{wrongPath=true;},noTools:()=>{noTools=true;},settle:()=>{settling=true;},indexChecks:()=>indexChecks,failIndex:message=>{indexFailure=message;}};
}

test("managed probe errors omit arbitrary upstream credential encodings before readiness caching", async t => {
  const { f, backend, url, failIndex } = await ready_fixture(t);
  const encoded = [..."private-search-5839"].join("."); failIndex(encoded);
  const config = backend.current();
  Object.assign(config.mcp.managed["code-index"], { mode: "external", url: url + "/index" });
  fs.writeFileSync(f.env.EDT_AI_SETTINGS, JSON.stringify(config));
  await backend.main({ action: "update", set: { codeIndexEnabled: true } });
  const result = await backend.main({ action: "refresh_readiness", scope: f.root + "#first" });
  assert.match(result.managed.find(item => item.name === "code-index").detail, /RPC -32000.*remote error text omitted/);
  const cache = fs.readFileSync(path.join(instance_directory(f.state, f.root), "first.readiness.json"), "utf8");
  assert.equal((JSON.stringify(result) + cache).includes(encoded), false);
});

test("old readiness receipts cannot reintroduce untrusted diagnostic messages", async t => {
  const { f, backend, authorization } = await ready_fixture(t);
  await backend.main({ action: "check", authorization });
  const file = path.join(instance_directory(f.state, f.root), "first.readiness.json");
  const receipt = JSON.parse(fs.readFileSync(file, "utf8")); assert.equal(receipt.version, 3);
  receipt.result.checks[0].detail = "legacy-untrusted-5731";
  for (const version of [undefined, 2, 99]) {
    receipt.version = version;
    const bytes = JSON.stringify(receipt); fs.writeFileSync(file, bytes);
    const current = await backend.main({ action: "read" });
    assert.equal(current.readiness.state, "not_checked");
    assert.match(current.readiness.reason, /Несовместимая версия/);
    assert.equal(JSON.stringify(current).includes("legacy-untrusted-5731"), false);
    assert.equal(fs.readFileSync(file, "utf8"), bytes);
  }
});

test("one readiness check verifies externals, policy and skills, and passive reads reuse scoped evidence",async t=>{
  const {f,backend,authorization,count}=await ready_fixture(t);
  assert.equal((await backend.main({action:"read"})).readiness.state,"not_checked");
  await assert.rejects(backend.main({action:"check"}),/разрешения/);
  const result=await backend.main({action:"check",authorization});assert.equal(result.fullReadiness,"verified");assert.equal(result.readiness.state,"ready");
  for(const id of ["edt","v8std","policy","skills","source-guard","node","profile"])assert.equal(result.readiness.checks.find(check=>check.id===id).state,"ready",id);
  assert.equal(result.readiness.verificationLimits.hostHookTrust,"not_verified");
  assert.equal(result.readiness.verificationLimits.hostHookActivation,"not_verified");
  assert.equal(result.readiness.verificationLimits.deploymentLiveAcceptance,"not_verified");
  assert.equal(result.readiness.checks.find(check=>check.id==="code-index").state,"disabled");
  const contacted=count();assert.equal((await new SettingsBackend().main({action:"status"})).readiness.state,"ready");assert.equal(count(),contacted);
  process.env.EDT_AI_INSTANCE="another";assert.equal((await backend.main({action:"read"})).readiness.state,"not_checked");process.env.EDT_AI_INSTANCE="first";
  f.profile.repositories[0].edt_project="Changed";f.save();assert.equal((await backend.main({action:"read"})).readiness.state,"stale");
});

test("automatic readiness makes fresh probes without new launch grants or reconnecting relays",async t=>{
  const {f,backend,count,wrong}=await ready_fixture(t),scope=f.root+"#first";
  const first=await backend.main({action:"refresh_readiness",scope});assert.equal(first.readiness.state,"ready");
  const calls=count();wrong();
  const second=await backend.main({action:"refresh_readiness",scope});assert.ok(count()>calls);assert.equal(second.readiness.state,"blocked");
  assert.equal(second.external.edt.ready,false);
  const home=instance_directory(f.state,f.root);
  assert.equal(fs.existsSync(path.join(home,"first.preparation.json")),false);
  assert.equal(fs.existsSync(path.join(home,"first.reconnect.json")),false);
  const before=count();await assert.rejects(backend.main({action:"refresh_readiness",scope:f.root+"#another"}),/другой папке или экземпляру/);assert.equal(count(),before);
});

test("automatic readiness never prepares unapproved components or downloads missing runtimes",async t=>{
  const {f,backend}=await ready_fixture(t),scope=f.root+"#first";
  // Supply a Java probe fixture so Node-only PATH reaches the missing-JAR check.
  const config=backend.current();config.mcp.managed["bsl-ls"].java=process.execPath;
  fs.writeFileSync(f.env.EDT_AI_SETTINGS,JSON.stringify(config));
  const spawnSync=childProcess.spawnSync;
  t.mock.method(childProcess,"spawnSync",(command,args,options)=>command===process.execPath&&args?.[0]==="-version"?{status:0,stderr:'java version "21"'}:spawnSync(command,args,options));
  syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  const download=t.mock.method(globalThis,"fetch",async()=>{throw new Error("Unexpected download");});
  await backend.main({action:"update",set:{codeIndexEnabled:true,bslLsEnabled:true,edtUrl:"",v8stdUrl:""}});
  const unprepared=await backend.main({action:"refresh_readiness",scope});
  for(const component of ["code-index","bsl-ls"]){const item=unprepared.managed.find(item=>item.name===component);assert.equal(item.ready,false);assert.match(item.detail,/не подготовлен/);}
  grant_preparation(f.state,f.root,["code-index","bsl-ls"]);
  const file=path.join(instance_directory(f.state,f.root),"first.preparation.json"),before=fs.readFileSync(file);
  const missing=await backend.main({action:"refresh_readiness",scope});
  for(const component of ["code-index","bsl-ls"]){const item=missing.managed.find(item=>item.name===component);assert.equal(item.ready,false);assert.match(item.detail,/не установлен или повреждён/);}
  assert.deepEqual(fs.readFileSync(file),before);assert.equal(fs.existsSync(path.join(f.state,"runtime-lock.json")),false);
  process.env.EDT_AI_INSTANCE="another";
  const other=await backend.main({action:"refresh_readiness",scope:f.root+"#another"});assert.match(other.managed.find(item=>item.name==="code-index").detail,/не подготовлен/);
  assert.equal(download.mock.callCount(),0);
});

test("automatic readiness verifies live managed APIs instead of relying on saved BSL LS evidence",async t=>{
  const {f,backend,url,count,settle,indexChecks}=await ready_fixture(t);
  const config=backend.current();
  for(const component of ["code-index","bsl-ls"])Object.assign(config.mcp.managed[component],{enabled:true,mode:"external",url:url+(component==="bsl-ls"?"/bsl":"/index")});
  fs.writeFileSync(f.env.EDT_AI_SETTINGS,JSON.stringify(config));
  await backend.main({action:"update",set:{codeIndexEnabled:true,bslLsEnabled:true}});
  fs.mkdirSync(path.join(f.root,".code-index"));fs.writeFileSync(path.join(f.root,".code-index/index.db"),"existing");settle();
  assert.equal((await backend.main({action:"read"})).summary.components.find(item=>item.id==="bsl-ls").status,"external");
  const calls=count(),result=await backend.main({action:"refresh_readiness",scope:f.root+"#first"});
  assert.ok(count()>calls);assert.equal(result.readiness.state,"ready");
  assert.equal(indexChecks(),2,"a startup health response without freshness is observed again before completing the check");
  for(const component of ["code-index","bsl-ls"]){
    assert.equal(result.managed.find(item=>item.name===component).ready,true);
    const summary=(await backend.main({action:"read"})).summary.components.find(item=>item.id===component);assert.equal(summary.status,"ready");assert.equal(summary.checkedAt,result.readiness.checkedAt);
  }
  assert.equal(fs.existsSync(path.join(f.state,"runtime-lock.json")),false);
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
  await backend.main({action:"update",set:{openvikingUrl:"https://knowledge.example/mcp"}});
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
