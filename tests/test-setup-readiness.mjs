import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { edt_fixture as fixture, environment } from "./helpers.mjs";
import { SettingsBackend } from "../scripts/settings_backend.mjs";
import { setup_assets, save_readiness, read_readiness, save_component_checks, read_component_checks, begin_foreground_readiness, activate_foreground_readiness, release_foreground_readiness, capture_readiness_priority, readiness_priority_current, foreground_readiness_active } from "../scripts/setup_readiness.mjs";
import { instance_directory, project_directory, sha256 } from "../scripts/project_paths.mjs";
import { grant_preparation } from "../scripts/components.mjs";
import { zip } from "../scripts/archives.mjs";
import { alive } from "../scripts/processes.mjs";
import { index_config, installed_runtime } from "../scripts/runtime.mjs";
import { dump } from "../scripts/common.mjs";
import { project_profile } from "../scripts/profile.mjs";
import { SettingsOperations } from "../mcp/settings-operations.mjs";

async function with_clean_policy_environment(run) {
  const isPolicyInput = name => !["NODE_TEST_CONTEXT", "NODE_TEST_WORKER_ID"].includes(name.toUpperCase()) &&
    /^(?:NODE_|OPENSSL_|SSL_CERT_|LD_|DYLD_|UV_)/i.test(name);
  const previous = Object.fromEntries(Object.entries(process.env).filter(([name]) => isPolicyInput(name)));
  for (const name of Object.keys(previous)) delete process.env[name];
  try { return await run(); }
  finally {
    for (const name of Object.keys(process.env)) if (isPolicyInput(name)) delete process.env[name];
    Object.assign(process.env, previous);
  }
}

async function ready_fixture(t) {
  const f=fixture(t);environment(t,f.env);f.save();let calls=0,wrongPath=false,noTools=false,indexChecks=0,settling=false,indexFailure=null,projectState="ready",delayV8=0,indexGate=null,indexStarted=null,edtObserved;const paths=[],requests=[];
  const edtDone=new Promise(resolve=>{edtObserved=resolve;});
  const server=createServer(async(req,res)=>{
    let text="";for await(const part of req)text+=part;
    if(!text){res.writeHead(202).end();return;}const message=JSON.parse(text);calls++;paths.push(req.url);requests.push({url:req.url,method:message.method});
    const reply=result=>res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify({jsonrpc:"2.0",id:message.id,result}));
    if(req.url==="/index"&&message.method==="initialize"&&indexGate){const gate=indexGate;indexGate=null;indexStarted();await gate;}
    if (req.url === "/index" && indexFailure) return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: indexFailure } }));
    if(message.method==="server/discover")return res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify({jsonrpc:"2.0",id:message.id,error:{code:-32601,message:"legacy"}}));
    if(message.method==="initialize")return reply({protocolVersion:"2025-11-25",serverInfo:{name:"fixture",version:"1"},capabilities:{tools:{}}});
    if(message.method.startsWith("notifications/"))return res.writeHead(202).end();
    if(message.method==="tools/list"){
      if(req.url==="/v8std"&&delayV8)await new Promise(done=>setTimeout(done,delayV8));
      if(req.url==="/bsl")return reply({tools:[...(["register_workspace_folder","list_workspace_folders","unregister_workspace_folder"].map(name=>({name,inputSchema:{type:"object"}}))),{name:"analyze",inputSchema:{type:"object",properties:{workspaceFolder:{type:"string"}},required:["workspaceFolder"]}}]});
      if(req.url==="/index")return reply({tools:[{name:"health",inputSchema:{type:"object"}}]});
      return reply({tools:noTools&&req.url==="/v8std"?[]:[{name:"list_projects",inputSchema:{type:"object",properties:{format:{enum:["json"]}}}}]});
    }
    if(message.method==="tools/call"&&req.url==="/index")return reply({structuredContent:{mcp:{status:"ok"},daemon:{status:"online"},repos:[{repo:"product",root_path:f.root,path_status:{status:"ready"},data_version:settling&&++indexChecks===1?{}:{stale:false}}]}});
    if(message.method==="tools/call"){reply({content:[{type:"text",text:JSON.stringify({projects:[{name:"Product",path:wrongPath?f.base:f.root,open:true,state:projectState,edtProject:true}]})}]});if(req.url==="/edt")edtObserved();return;}
    reply({});
  });server.listen(0,"127.0.0.1");await once(server,"listening");t.after(()=>{server.closeAllConnections();return new Promise(done=>server.close(done));});
  const backend=new SettingsBackend(),url="http://127.0.0.1:"+server.address().port;
  await backend.main({action:"update",set:{codeIndexEnabled:false,bslLsEnabled:false,edtUrl:url+"/edt",v8stdUrl:url+"/v8std"}});
  return {f,backend,url,paths,requests,edtDone,authorization:{scope:f.root+"#first",effects:["launch"],evidence:"user requested setup check"},count:()=>calls,wrong:()=>{wrongPath=true;},noTools:()=>{noTools=true;},settle:()=>{settling=true;},indexChecks:()=>indexChecks,failIndex:message=>{indexFailure=message;},setProjectState:state=>{projectState=state;},delayV8:ms=>{delayV8=ms;},holdIndex:()=>{let release;indexGate=new Promise(done=>{release=done;});const started=new Promise(done=>{indexStarted=done;});return {started,release};}};
}

async function enable_external_index(f, backend, url) {
  const config=backend.current();Object.assign(config.mcp.managed["code-index"],{enabled:true,mode:"external",url:url+"/index"});
  fs.writeFileSync(f.env.EDT_AI_SETTINGS,JSON.stringify(config));
  await backend.main({action:"update",set:{codeIndexEnabled:true}});
  fs.mkdirSync(path.join(f.root,".code-index"),{recursive:true});fs.writeFileSync(path.join(f.root,".code-index/index.db"),"existing");
}

test("component evidence expires only when that component's inputs change", async t => {
  const {f,backend}=await ready_fixture(t), config=backend.effective(backend.current()), profile=project_profile(f.root);
  profile.testing.yaxunit=true;profile.testing.yaxunit_config={repository_id:"product",runner:"edt",results:"results"};
  profile.testing.vanessa=true;profile.testing.vanessa_config={repository_id:"product",runtime_profile:"vanessa.json",server_name:"vanessa",features:"features",results:"ui-results"};
  const ids=["edt","v8std","code-index","yaxunit","vanessa"];
  save_component_checks(f.state,config,profile,ids.map(id=>({id,state:"ready"})));
  const states=(settings=config,data=profile)=>Object.fromEntries(read_component_checks(f.state,settings,data).map(item=>[item.id,item.state]));
  const changedBsl=structuredClone(config);changedBsl.mcp.managed["bsl-ls"].java="another-java";
  assert.deepEqual(states(changedBsl),Object.fromEntries(ids.map(id=>[id,"ready"])));
  fs.writeFileSync(path.join(f.root,"AGENTS.md"),"Unrelated project instructions\n");
  assert.deepEqual(states(),Object.fromEntries(ids.map(id=>[id,"ready"])));
  const unrelatedTestPaths=structuredClone(profile);unrelatedTestPaths.testing.yaxunit_config.results="other-results";unrelatedTestPaths.testing.vanessa_config.features="other-features";
  assert.deepEqual(states(config,unrelatedTestPaths),Object.fromEntries(ids.map(id=>[id,"ready"])));
  const changedV8=structuredClone(config);changedV8.mcp.required.v8std.url+="/other";
  assert.deepEqual(states(changedV8),{edt:"ready",v8std:"check_stale","code-index":"ready",yaxunit:"ready",vanessa:"ready"});
  const changedTest=structuredClone(profile);changedTest.testing.yaxunit_config.launch_configuration="other";
  assert.deepEqual(states(config,changedTest),{edt:"ready",v8std:"ready","code-index":"ready",yaxunit:"check_stale",vanessa:"ready"});
  const changedEdt=structuredClone(config);changedEdt.mcp.required.edt.url+="/other";
  assert.deepEqual(states(changedEdt),{edt:"check_stale",v8std:"ready","code-index":"ready",yaxunit:"check_stale",vanessa:"ready"});
});

test("remote credential changes invalidate only the observations that used them", async t => {
  const {f,backend}=await ready_fixture(t),config=backend.effective(backend.current()),profile=project_profile(f.root);
  config.mcp.required.edt.headers_env={Authorization:"EDT_REVIEW_TEST_TOKEN"};process.env.EDT_REVIEW_TEST_TOKEN="first";
  t.after(()=>{delete process.env.EDT_REVIEW_TEST_TOKEN;});
  save_component_checks(f.state,config,profile,[{id:"edt",state:"ready"},{id:"v8std",state:"ready"},{id:"yaxunit",state:"ready"}]);
  process.env.EDT_REVIEW_TEST_TOKEN="second";
  assert.deepEqual(Object.fromEntries(read_component_checks(f.state,config,profile).map(item=>[item.id,item.state])),
    {edt:"check_stale",v8std:"ready",yaxunit:"check_stale"});
  const receipt=fs.readFileSync(path.join(instance_directory(f.state,f.root),"first.readiness.json"),"utf8");
  assert.doesNotMatch(receipt,/first|second/);
});

test("a foreground check invalidates an older background job before delayed backend dispatch", async t => {
  const {f,backend,authorization}=await ready_fixture(t);let release;
  const gate=new Promise(done=>{release=done;});
  const operations=new SettingsOperations(async(action,args)=>{if(action==="refresh_readiness")await gate;return backend.main({action,...args});},()=>{},{stateDirectory:f.state});
  const background=operations.start("refresh_readiness",{scope:f.root+"#first"},{});
  const foreground=operations.start("check",{authorization},{});await foreground.finished;
  assert.equal(foreground.status,"completed");assert.equal(foreground.result.superseded,undefined);
  const before=fs.readFileSync(path.join(instance_directory(f.state,f.root),"first.readiness.json"),"utf8");
  release();await background.finished;assert.equal(background.result.superseded,true);
  assert.equal(fs.readFileSync(path.join(instance_directory(f.state,f.root),"first.readiness.json"),"utf8"),before);
  assert.equal(fs.existsSync(path.join(f.state,".settings-refresh-cancel",background.id)),false);
});

test("a foreground check in another MCP session takes priority over an older background dispatch", async t => {
  const {f,backend,authorization}=await ready_fixture(t),context={projectRoot:f.root,instance:"first"};let release;
  const gate=new Promise(done=>{release=done;});
  const first=new SettingsOperations(async(action,args)=>{await gate;return backend.main({action,...args});},()=>{},{stateDirectory:f.state});
  const second=new SettingsOperations((action,args)=>backend.main({action,...args}),()=>{},{stateDirectory:f.state});
  const background=first.start("refresh_readiness",{scope:f.root+"#first"},context);
  const foreground=second.start("check",{authorization},context);await foreground.finished;
  assert.equal(foreground.status,"completed");assert.notEqual(foreground.result.superseded,true);
  release();await background.finished;assert.equal(background.status,"completed");assert.equal(background.result.superseded,true);
});

test("a different MCP session observes transiently while full preparation is running", async t => {
  const {f,backend,authorization}=await ready_fixture(t),context={projectRoot:f.root,instance:"first"};let release;
  const gate=new Promise(done=>{release=done;});
  const first=new SettingsOperations(async(action,args)=>{await gate;return backend.main({action,...args});},()=>{},{stateDirectory:f.state});
  const second=new SettingsOperations((action,args)=>backend.main({action,...args}),()=>{},{stateDirectory:f.state});
  const foreground=first.start("check",{authorization},context),background=second.start("refresh_readiness",{scope:f.root+"#first"},context);
  await background.finished;assert.equal(background.status,"completed");assert.equal(background.result.componentChecks.length,7);
  assert.equal(fs.existsSync(path.join(instance_directory(f.state,f.root),"first.readiness.json")),false);
  release();await foreground.finished;assert.equal(foreground.status,"completed");assert.notEqual(foreground.result.superseded,true);
});

test("readiness priority stays isolated by project and instance", async t => {
  const {f}=await ready_fixture(t),other=path.join(f.base,"other-priority");fs.mkdirSync(other);
  const first=capture_readiness_priority(f.state,f.root,"first"),otherProject=capture_readiness_priority(f.state,other,"first"),otherInstance=capture_readiness_priority(f.state,f.root,"second");
  const id=randomUUID(),marker=begin_foreground_readiness(f.state,f.root,"first",id);
  const owner=await activate_foreground_readiness(f.state,f.root,"first",marker,id);
  assert.equal(readiness_priority_current(f.state,f.root,"first",first),false);
  assert.equal(await foreground_readiness_active(f.state,f.root,"first"),true);
  assert.equal(readiness_priority_current(f.state,other,"first",otherProject),true);
  assert.equal(readiness_priority_current(f.state,f.root,"second",otherInstance),true);
  assert.equal(await foreground_readiness_active(f.state,other,"first"),false);
  assert.equal(await foreground_readiness_active(f.state,f.root,"second"),false);
  await owner.close();release_foreground_readiness(f.state,marker);assert.equal(await foreground_readiness_active(f.state,f.root,"first"),false);
});

test("a temporary Windows-style lease unlink failure does not keep refresh transient", async t => {
  const {f}=await ready_fixture(t),marker=begin_foreground_readiness(f.state,f.root,"first",randomUUID()),remove=fs.rmSync;let failed=false;
  t.mock.method(fs,"rmSync",(file,options)=>{if(file===marker&&!failed){failed=true;throw Object.assign(new Error("busy"),{code:"EPERM"});}return remove(file,options);});
  assert.equal(release_foreground_readiness(f.state,marker),true);assert.equal(failed,true);
  assert.equal(JSON.parse(fs.readFileSync(marker,"utf8")).finished,true);assert.equal(await foreground_readiness_active(f.state,f.root,"first"),false);
  assert.equal(release_foreground_readiness(f.state,marker),true);assert.equal(fs.existsSync(marker),false);
});

test("lease cleanup retries when both replacement and deletion are temporarily denied", async t => {
  const {f}=await ready_fixture(t),rename=fs.renameSync,remove=fs.rmSync;let blocked=false,marker;
  t.mock.method(fs,"renameSync",(from,to)=>{if(blocked&&to===marker)throw Object.assign(new Error("busy"),{code:"EPERM"});return rename(from,to);});
  t.mock.method(fs,"rmSync",(file,options)=>{if(blocked&&file===marker)throw Object.assign(new Error("busy"),{code:"EBUSY"});return remove(file,options);});
  const operations=new SettingsOperations(async()=>{blocked=true;return {};},()=>{},{stateDirectory:f.state});
  const foreground=operations.start("check",{},{projectRoot:f.root,instance:"first"});
  marker=path.join(project_directory(f.state,f.root),"coordination","first.readiness-active",foreground.id);
  await foreground.finished;assert.equal(fs.existsSync(marker),true);blocked=false;
  await new Promise(done=>setTimeout(done,1200));assert.equal(fs.existsSync(marker),false);
});

test("a stale foreground marker with a reused PID cannot keep refresh transient", async t => {
  const {f,backend}=await ready_fixture(t),id=randomUUID(),marker=begin_foreground_readiness(f.state,f.root,"first",id);
  fs.writeFileSync(marker,JSON.stringify({pid:process.pid,id,phase:"active"}));
  assert.equal(await foreground_readiness_active(f.state,f.root,"first"),false);
  const operations=new SettingsOperations((action,args)=>backend.main({action,...args}),()=>{},{stateDirectory:f.state});
  const background=operations.start("refresh_readiness",{scope:f.root+"#first"},{projectRoot:f.root,instance:"first"});await background.finished;
  assert.equal(background.status,"completed");assert.notEqual(background.result.superseded,true);
  assert.equal(fs.existsSync(path.join(instance_directory(f.state,f.root),"first.readiness.json")),true);
  release_foreground_readiness(f.state,marker);
});

test("an abandoned atomic-write temporary file cannot keep refresh transient", async t => {
  const {f,backend}=await ready_fixture(t),id=randomUUID(),marker=begin_foreground_readiness(f.state,f.root,"first",id);
  fs.rmSync(marker);fs.writeFileSync(path.join(path.dirname(marker),".core-abandoned.tmp"),JSON.stringify({id,pid:process.pid,phase:"active"}));
  assert.equal(await foreground_readiness_active(f.state,f.root,"first"),false);
  const operations=new SettingsOperations((action,args)=>backend.main({action,...args}),()=>{},{stateDirectory:f.state});
  const background=operations.start("refresh_readiness",{scope:f.root+"#first"},{projectRoot:f.root,instance:"first"});await background.finished;
  assert.equal(background.status,"completed");assert.equal(fs.existsSync(path.join(instance_directory(f.state,f.root),"first.readiness.json")),true);
});

test("an interrupted old foreground marker cannot keep refresh transient", async t => {
  const {f,backend}=await ready_fixture(t),id=randomUUID(),marker=begin_foreground_readiness(f.state,f.root,"first",id);
  fs.writeFileSync(marker,"");assert.equal(await foreground_readiness_active(f.state,f.root,"first"),false);
  const operations=new SettingsOperations((action,args)=>backend.main({action,...args}),()=>{},{stateDirectory:f.state});
  const background=operations.start("refresh_readiness",{scope:f.root+"#first"},{projectRoot:f.root,instance:"first"});await background.finished;
  assert.equal(background.status,"completed");assert.equal(fs.existsSync(path.join(instance_directory(f.state,f.root),"first.readiness.json")),true);
});

test("a foreground check snapshots the receipt under lock after an older commit", async t => {
  const {f,backend,authorization}=await ready_fixture(t),signal=new Int32Array(new SharedArrayBuffer(8));
  const receipt=path.join(instance_directory(f.state,f.root),"first.readiness.json");let worker;
  const workerSource=`
    import fs from "node:fs";
    import { parentPort, workerData } from "node:worker_threads";
    const signal=new Int32Array(workerData.signal),rename=fs.renameSync;
    fs.renameSync=(from,to)=>{if(String(to)===workerData.receipt&&Atomics.compareExchange(signal,0,0,1)===0){Atomics.notify(signal,0);Atomics.wait(signal,1,0,5000);}return rename(from,to);};
    try { const {SettingsBackend}=await import(workerData.backendUrl);const result=await new SettingsBackend().main({action:"refresh_readiness",...workerData.args});parentPort.postMessage({result}); }
    catch(error){parentPort.postMessage({error:error.stack||error.message});}
  `;
  t.after(async()=>{Atomics.store(signal,1,1);Atomics.notify(signal,1);await worker?.terminate();});
  const operations=new SettingsOperations((action,args)=>{
    if(action==="check")return backend.main({action,...args});
    worker=new Worker(new URL("data:text/javascript,"+encodeURIComponent(workerSource)),{workerData:{signal:signal.buffer,receipt,args,backendUrl:pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)),"../scripts/settings_backend.mjs")).href}});
    return new Promise((resolve,reject)=>{worker.once("message",message=>message.error?reject(new Error(message.error)):resolve(message.result));worker.once("error",reject);});
  },()=>{},{stateDirectory:f.state});
  const background=operations.start("refresh_readiness",{scope:f.root+"#first"},{});
  const deadline=Date.now()+10000;while(!Atomics.load(signal,0)&&Date.now()<deadline)await new Promise(done=>setTimeout(done,10));
  assert.equal(Atomics.load(signal,0),1,"background must pause inside its receipt commit");
  const foreground=operations.start("check",{authorization},{});await new Promise(done=>setTimeout(done,250));
  Atomics.store(signal,1,1);Atomics.notify(signal,1);await Promise.all([background.finished,foreground.finished]);
  assert.equal(background.status,"completed");assert.equal(foreground.status,"completed");assert.notEqual(foreground.result.superseded,true);
});

test("a parallel refresh during full preparation observes without changing the receipt or tickets", async t => {
  const {f,backend,authorization}=await ready_fixture(t);let release;
  const gate=new Promise(done=>{release=done;});
  const operations=new SettingsOperations(async(action,args)=>{if(action==="check")await gate;return backend.main({action,...args});},()=>{},{stateDirectory:f.state});
  const foreground=operations.start("check",{authorization},{}), background=operations.start("refresh_readiness",{scope:f.root+"#first"},{});
  await background.finished;assert.equal(background.status,"completed");assert.equal(background.result.componentChecks.length,7);
  assert.equal(fs.existsSync(path.join(instance_directory(f.state,f.root),"first.readiness.json")),false);
  assert.equal(fs.existsSync(path.join(instance_directory(f.state,f.root),"first.readiness-observations.json")),false);
  assert.equal(operations.status().id,foreground.id);release();await foreground.finished;assert.equal(foreground.result.superseded,undefined);
});

test("a changed EDT project descriptor invalidates an in-flight full check", async t => {
  const {f,backend,url,authorization,holdIndex,edtDone}=await ready_fixture(t);await enable_external_index(f,backend,url);
  const delayed=holdIndex(),pending=backend.main({action:"check",authorization});await Promise.all([delayed.started,edtDone]);
  fs.rmSync(path.join(f.root,".project"));delayed.release();const result=await pending;
  assert.equal(result.superseded,true);assert.equal(result.fullReadiness,"not_verified");
});

test("a full check never renews evidence that expired while another component was running", async t => {
  const {f,backend,url,authorization,holdIndex,edtDone}=await ready_fixture(t);await enable_external_index(f,backend,url);
  const NativeDate=Date;let offset=0;class ClockDate extends NativeDate {constructor(...args){super(...(args.length?args:[NativeDate.now()+offset]));}static now(){return NativeDate.now()+offset;}}
  t.mock.method(globalThis,"Date",ClockDate);
  const delayed=holdIndex(),pending=backend.main({action:"check",authorization});await Promise.all([delayed.started,edtDone]);
  offset=16*60000;delayed.release();const result=await pending;
  assert.equal(result.fullReadiness,"not_ready");assert.equal(result.readiness.checks.find(item=>item.id==="edt").state,"not_verified");
});

test("parallel external checks retain their own observation times", async t => {
  const { f, backend, delayV8 } = await ready_fixture(t); delayV8(300);
  const result = await backend.main({ action: "refresh_readiness", scope: f.root + "#first" });
  const edt = result.componentChecks.find(item => item.id === "edt"), v8 = result.componentChecks.find(item => item.id === "v8std");
  assert.equal(edt.state, "ready"); assert.equal(v8.state, "ready");
  assert.ok(Date.parse(v8.checkedAt) - Date.parse(edt.checkedAt) >= 100);
});

test("fresh component observations update overall setup without extending its lifetime", async t => {
  const { f, backend } = await ready_fixture(t), config = backend.effective(backend.current());
  const managed = ["code-index", "bsl-ls"].map(name => ({ name, state: "ready", ready: true }));
  const setup = save_readiness(f.state, config, f.profile, managed, { edt: { ready: true }, v8std: { ready: true } });
  const updated = state => save_component_checks(f.state, config, f.profile, [{ id: "v8std", state }]);
  updated("error"); let read = await read_readiness(f.state, config, f.profile);
  assert.equal(read.state, "blocked"); assert.equal(read.checks.find(item => item.id === "v8std").state, "error");
  updated("ready"); read = await read_readiness(f.state, config, f.profile);
  assert.equal(read.state, "ready"); assert.equal(read.expiresAt, setup.expiresAt); assert.equal(read.checkedAt, setup.checkedAt);
});

test("an expired setup is fully observed again without preparation or duplicate endpoint probes", async t => {
  const { f, backend, url, requests } = await ready_fixture(t), selected = backend.current();
  for (const id of ["code-index", "bsl-ls"]) Object.assign(selected.mcp.managed[id], { enabled: true, mode: "external", url: url + (id === "code-index" ? "/index" : "/bsl") });
  fs.writeFileSync(f.env.EDT_AI_SETTINGS, JSON.stringify(selected));
  await backend.main({ action: "update", set: { codeIndexEnabled: true, bslLsEnabled: true } });
  const config = backend.effective(backend.current()), managed = ["code-index", "bsl-ls"].map(name => ({ name, state: "ready", ready: true }));
  save_readiness(f.state, config, f.profile, managed, { edt: { ready: true }, v8std: { ready: true } });
  const file = path.join(instance_directory(f.state, f.root), "first.readiness.json"), receipt = JSON.parse(fs.readFileSync(file, "utf8"));
  receipt.result.checkedAt = new Date(Date.now() - 16 * 60000).toISOString(); receipt.result.expiresAt = new Date(Date.now() - 60000).toISOString();
  fs.writeFileSync(file, JSON.stringify(receipt)); assert.equal((await backend.main({ action: "read" })).readiness.state, "stale");
  process.env.UNRELATED_COMPONENT_SECRET = "foreign-secret-fixture"; process.env.JAVA_TOOL_OPTIONS = "-Dpassword=java-secret-fixture";
  const spawn = childProcess.spawn, policyLaunches = [];
  t.mock.method(childProcess, "spawn", (command, args, options) => {
    const child = spawn(command, args, options), send = child.send?.bind(child);
    if (send) child.send = (message, ...rest) => {
      if (message.args?.some(value => value.endsWith("policy/read-only-mcp.mjs") || value.endsWith("policy\\read-only-mcp.mjs"))) policyLaunches.push(message);
      return send(message, ...rest);
    };
    return child;
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  requests.length = 0;
  // CI's no-shell preload is already installed in this process, but its
  // NODE_OPTIONS must not make this clean-environment scenario fail closed.
  const result = await with_clean_policy_environment(() => backend.main({ action: "refresh_readiness", scope: f.root + "#first" }));
  assert.equal(result.readiness.state, "ready", JSON.stringify(result.readiness.checks)); assert.equal(result.readiness.workflowReadiness.state, "not_checked");
  for (const urlPath of ["/edt", "/v8std"]) assert.equal(requests.filter(item => item.url === urlPath && item.method === "initialize").length, 1);
  assert.equal(result.componentChecks.length, 7); assert.equal(fs.existsSync(path.join(instance_directory(f.state, f.root), "first.preparation.json")), false);
  assert.equal(policyLaunches.length, 1); assert.equal(policyLaunches[0].command, process.execPath);
  assert.equal(policyLaunches[0].env.UNRELATED_COMPONENT_SECRET, undefined); assert.equal(policyLaunches[0].env.JAVA_TOOL_OPTIONS, undefined);
  assert.equal(policyLaunches[0].env.NODE_OPTIONS, undefined);
  assert.equal((await backend.main({ action: "read" })).readiness.state, "ready");
});

test("automatic setup never marks a different configured policy Node as verified", async t => {
  const { f, backend } = await ready_fixture(t), selected = backend.current();
  selected.mcp.managed["bsl-ls"].node = path.join(f.base, "missing-custom-node");
  fs.writeFileSync(f.env.EDT_AI_SETTINGS, JSON.stringify(selected));
  const config = backend.effective(backend.current());
  save_readiness(f.state, config, f.profile, [{ name: "code-index", state: "ready", ready: true }, { name: "bsl-ls", state: "ready", ready: true }], { edt: { ready: true }, v8std: { ready: true } });
  const file = path.join(instance_directory(f.state, f.root), "first.readiness.json"), receipt = JSON.parse(fs.readFileSync(file, "utf8"));
  receipt.result.checkedAt = new Date(Date.now() - 16 * 60000).toISOString(); receipt.result.expiresAt = new Date(Date.now() - 60000).toISOString(); fs.writeFileSync(file, JSON.stringify(receipt));
  const result = await backend.main({ action: "refresh_readiness", scope: f.root + "#first" });
  assert.equal(result.readiness.state, "blocked");
  assert.equal(result.readiness.checks.find(item => item.id === "policy").state, "not_verified");
});

test("automatic refresh recovers a previous policy error without waiting for setup expiry", async t => {
  const { f, backend, url } = await ready_fixture(t), selected = backend.current();
  for (const id of ["code-index", "bsl-ls"]) Object.assign(selected.mcp.managed[id], { enabled: true, mode: "external", url: url + (id === "code-index" ? "/index" : "/bsl") });
  fs.writeFileSync(f.env.EDT_AI_SETTINGS, JSON.stringify(selected)); await backend.main({ action: "update", set: { codeIndexEnabled: true, bslLsEnabled: true } });
  const config = backend.effective(backend.current()), managed = ["code-index", "bsl-ls"].map(name => ({ name, state: "ready", ready: true }));
  const setup = save_readiness(f.state, config, f.profile, [...managed, { name: "policy", state: "error", ready: false }], { edt: { ready: true }, v8std: { ready: true } });
  assert.equal(setup.state, "blocked");
  const result = await with_clean_policy_environment(() => backend.main({ action: "refresh_readiness", scope: f.root + "#first" }));
  assert.equal(result.readiness.checks.find(item => item.id === "policy").state, "ready"); assert.equal(result.readiness.state, "ready");
});

test("automatic setup does not claim policy readiness with unverified Node startup options", async t => {
  const { f, backend } = await ready_fixture(t), config = backend.effective(backend.current());
  save_readiness(f.state, config, f.profile, [{ name: "code-index", state: "ready", ready: true }, { name: "bsl-ls", state: "ready", ready: true }], { edt: { ready: true }, v8std: { ready: true } });
  const file = path.join(instance_directory(f.state, f.root), "first.readiness.json"), receipt = JSON.parse(fs.readFileSync(file, "utf8"));
  receipt.result.checkedAt = new Date(Date.now() - 16 * 60000).toISOString(); receipt.result.expiresAt = new Date(Date.now() - 60000).toISOString(); fs.writeFileSync(file, JSON.stringify(receipt));
  const result = await with_clean_policy_environment(() => {
    process.env.NODE_OPTIONS = "--no-such-flag";
    return backend.main({ action: "refresh_readiness", scope: f.root + "#first" });
  });
  const policy = result.readiness.checks.find(item => item.id === "policy");
  assert.equal(result.readiness.state, "blocked"); assert.equal(policy.state, "not_verified");
  assert.match(policy.detail, /Окружение запуска Node отличается/);
});

for (const expired of [false, true]) test(`overall setup respects ${expired ? "already expired" : "remaining"} component evidence`, async t => {
  const { f, backend, url } = await ready_fixture(t), selected = backend.current();
  for (const id of ["code-index", "bsl-ls"]) Object.assign(selected.mcp.managed[id], { enabled: true, mode: "external", url: url + (id === "code-index" ? "/index" : "/bsl") });
  fs.writeFileSync(f.env.EDT_AI_SETTINGS, JSON.stringify(selected));
  await backend.main({ action: "update", set: { codeIndexEnabled: true, bslLsEnabled: true } });
  const config = backend.effective(backend.current()), managed = ["code-index", "bsl-ls"].map(name => ({ name, state: "ready", ready: true }));
  save_readiness(f.state, config, f.profile, managed, { edt: { ready: true }, v8std: { ready: true } });
  const file = path.join(instance_directory(f.state, f.root), "first.readiness.json"), receipt = JSON.parse(fs.readFileSync(file, "utf8"));
  receipt.result.checkedAt = new Date(Date.now() - 16 * 60000).toISOString(); receipt.result.expiresAt = new Date(Date.now() - 60000).toISOString(); fs.writeFileSync(file, JSON.stringify(receipt));
  const expiresAt = new Date(Date.now() + (expired ? 200 : 60000)).toISOString(), observed = new Date(Date.now() - 14 * 60000).toISOString();
  const main = backend.main.bind(backend);
  t.mock.method(backend, "main", async (request, ...args) => {
    if (request.action === "probe" && request.component === "code-index" && request.collectOnly)
      return { componentChecks: [{ id: "code-index", state: "ready", checkedAt: observed, expiresAt }], managed: [], external: {} };
    if (expired && request.action === "probe" && request.component === "bsl-ls" && request.collectOnly) await new Promise(resolve => setTimeout(resolve, 400));
    return main(request, ...args);
  });
  const result = await with_clean_policy_environment(() => main({ action: "refresh_readiness", scope: f.root + "#first" }));
  if (expired) {
    assert.equal(result.componentChecks.find(item => item.id === "code-index").state, "not_verified");
    assert.equal(result.readiness.state, "blocked");
  } else {
    assert.equal(result.readiness.state, "ready");
    assert.ok(Date.parse(result.readiness.expiresAt) <= Date.parse(expiresAt));
  }
});

for (const layer of ["profile", "project_local"]) test(`changing edt_required in ${layer} invalidates dependent readiness within the directory and instance`, async t => {
  const { f, backend } = await ready_fixture(t);
  f.profile.testing.yaxunit=true;f.profile.testing.yaxunit_config={repository_id:"product",runner:"edt",results:"results"};f.save();
  const config = backend.effective(backend.current());
  const target = path.join(f.root, layer === "profile" ? ".ai/project.yaml" : ".ai/project.local.yaml");
  const profile = project_profile(f.root), managed = ["code-index", "bsl-ls"].map(name => ({ name, state: "ready", ready: true }));
  save_readiness(f.state, config, profile, managed, { edt: { ready: true }, v8std: { ready: true } }, [{ id: "yaxunit", state: "ready" }]);
  save_component_checks(f.state, config, profile, [{ id: "edt", state: "ready" }, { id: "yaxunit", state: "ready", target: { projectName: "Product" } }]);
  assert.equal((await read_readiness(f.state, config, profile)).state, "ready");
  const receipt = path.join(instance_directory(f.state, f.root), "first.readiness.json"), before = fs.readFileSync(receipt);
  const repositories = profile.repositories.map(item => ({ ...item, edt_required: false }));
  dump(layer === "profile" ? { ...f.profile, repositories } : { repositories }, target);
  const updated = project_profile(f.root), saved = await read_readiness(f.state, config, updated);
  assert.equal(saved.state, "stale"); assert.equal(saved.mainReadiness.state, "stale");
  const checks = read_component_checks(f.state, config, updated);
  assert.ok(checks.filter(item => ["edt", "yaxunit"].includes(item.id)).every(item => item.state === "check_stale"));
  assert.equal(checks.find(item => item.id === "bsl-ls").state, "ready", "independent durable BSL evidence retains its existing validity contract");
  assert.equal(checks.find(item => item.id === "yaxunit").target, undefined);
  assert.deepEqual(fs.readFileSync(receipt), before, "invalidation must not rewrite or renew previous observations");
  process.env.EDT_AI_INSTANCE = "other";
  assert.equal((await read_readiness(f.state, config, updated)).state, "not_checked");
  assert.deepEqual(read_component_checks(f.state, config, updated), []);
  process.env.EDT_AI_INSTANCE = "first";
  const other = path.join(f.base, "Other"); fs.mkdirSync(other);
  const otherConfig = { ...config, active_project: other };
  assert.equal((await read_readiness(f.state, otherConfig, updated)).state, "not_checked");
  assert.deepEqual(read_component_checks(f.state, otherConfig, updated), []);
});

test("background component refreshes use the same addressed probes and preserve all other receipts",async t=>{
  const {f,backend,url,paths}=await ready_fixture(t),config=backend.current();
  for(const id of ["code-index","bsl-ls"])Object.assign(config.mcp.managed[id],{enabled:true,mode:"external",url:url+(id==="code-index"?"/index":"/bsl")});
  fs.writeFileSync(f.env.EDT_AI_SETTINGS,JSON.stringify(config));await backend.main({action:"update",set:{codeIndexEnabled:true,bslLsEnabled:true}});
  const profileBefore=fs.readFileSync(path.join(f.root,".ai/project.yaml")),settingsBefore=fs.readFileSync(f.env.EDT_AI_SETTINGS);
  for(const component of ["edt","v8std","openviking","code-index","bsl-ls","yaxunit","vanessa"]){
    const before=(await backend.main({action:"read"})).componentChecks,offset=paths.length;
    const checked=await backend.main({action:"refresh_readiness",scope:f.root+"#first",component});
    assert.deepEqual(checked.componentChecks.map(item=>item.id),[component]);
    const endpoint={edt:"/edt",v8std:"/v8std","code-index":"/index","bsl-ls":"/bsl"}[component];
    assert.ok(paths.slice(offset).every(value=>value===endpoint));if(endpoint)assert.ok(paths.length>offset);
    const after=(await backend.main({action:"read"})).componentChecks;
    assert.deepEqual(after.filter(item=>item.id!==component),before.filter(item=>item.id!==component));
  }
  const all=await backend.main({action:"refresh_readiness",scope:f.root+"#first"});assert.equal(all.componentChecks.length,7);
  assert.equal(all.readiness,undefined);assert.deepEqual(fs.readFileSync(path.join(f.root,".ai/project.yaml")),profileBefore);
  assert.deepEqual(fs.readFileSync(f.env.EDT_AI_SETTINGS),settingsBefore);assert.equal(fs.existsSync(path.join(f.state,"runtime-lock.json")),false);
});

test("EDT building and mapping failures remain distinct in saved readiness", async t => {
  const { f, backend, setProjectState, wrong } = await ready_fixture(t);
  const scope = f.root + "#first";
  setProjectState("building");
  const result = await backend.main({ action: "refresh_readiness", scope });
  assert.equal(result.componentChecks.find(item => item.id === "edt").state, "building");
  assert.equal(result.external.edt.repositories[0].matched, true);
  assert.equal(result.external.edt.failure, undefined);
  assert.match(result.external.edt.detail, /product: EDT сообщает о сборке проекта/);
  assert.match(result.external.edt.detail, /повторите проверку готовности/);
  const saved = (await backend.main({ action: "read" })).componentChecks.find(item => item.id === "edt");
  assert.equal(saved.detail, result.external.edt.detail);
  wrong();
  const mismatch = await backend.main({ action: "refresh_readiness", scope });
  assert.equal(mismatch.external.edt.failure.category, "access_scope");
  assert.match(mismatch.external.edt.detail, /имя и путь не сопоставлены/);
  setProjectState("ready");
});

test("managed probe errors omit arbitrary upstream credential encodings before readiness caching", async t => {
  const { f, backend, url, failIndex } = await ready_fixture(t);
  const encoded = [..."private-search-5839"].join("."); failIndex(encoded);
  const config = backend.current();
  Object.assign(config.mcp.managed["code-index"], { mode: "external", url: url + "/index" });
  fs.writeFileSync(f.env.EDT_AI_SETTINGS, JSON.stringify(config));
  await backend.main({ action: "update", set: { codeIndexEnabled: true } });
  const result = await backend.main({ action: "refresh_readiness", scope: f.root + "#first" });
  assert.match(result.managed.find(item => item.name === "code-index").detail, /RPC -32000.*текст внешней ошибки скрыт/);
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
  const result=await backend.main({action:"check",authorization});assert.equal(result.fullReadiness,"not_ready");assert.equal(result.readiness.state,"blocked");
  for(const id of ["edt","v8std","policy","skills","source-guard","node","profile"])assert.equal(result.readiness.checks.find(check=>check.id===id).state,"ready",id);
  assert.equal(result.readiness.verificationLimits.hostHookTrust,"not_verified");
  assert.equal(result.readiness.verificationLimits.hostHookActivation,"not_verified");
  assert.equal(result.readiness.verificationLimits.deploymentLiveAcceptance,"not_verified");
  assert.equal(result.readiness.checks.find(check=>check.id==="code-index").state,"disabled");
  const contacted=count();assert.equal((await new SettingsBackend().main({action:"status"})).readiness.state,"blocked");assert.equal(count(),contacted);
  process.env.EDT_AI_INSTANCE="another";assert.equal((await backend.main({action:"read"})).readiness.state,"not_checked");process.env.EDT_AI_INSTANCE="first";
  f.profile.repositories[0].edt_project="Changed";f.save();assert.equal((await backend.main({action:"read"})).readiness.state,"stale");
});

test("disabled assigned authorities block readiness and old ready receipts are rejected", async t => {
  const { f, backend } = await ready_fixture(t), config = backend.effective(backend.current());
  const external = { edt: { ready: true }, v8std: { ready: true } };
  const managed = ["code-index", "bsl-ls"].map(name => ({ name, state: "ready", ready: true }));
  const complete = save_readiness(f.state, config, f.profile, managed, external);
  assert.equal(complete.state, "ready");
  assert.equal(complete.checks.find(item => item.id === "knowledge").state, "disabled");
  for (const name of ["code-index", "bsl-ls"]) {
    const checks = managed.map(item => item.name === name ? { ...item, state: "disabled" } : item);
    assert.equal(save_readiness(f.state, config, f.profile, checks, external).state, "blocked", name);
    assert.equal((await read_readiness(f.state, config, f.profile)).state, "blocked", name);
    const file = path.join(instance_directory(f.state, f.root), "first.readiness.json");
    const old = JSON.parse(fs.readFileSync(file, "utf8")); old.result.state = "ready";
    fs.writeFileSync(file, JSON.stringify(old));
    const restored = await read_readiness(f.state, config, f.profile);
    assert.equal(restored.state, "not_checked", name);
    assert.match(restored.reason, /обязательным компонентам/);
  }
});

test("automatic readiness makes fresh probes without new launch grants or reconnecting relays",async t=>{
  const {f,backend,count,wrong}=await ready_fixture(t),scope=f.root+"#first";
  const first=await backend.main({action:"refresh_readiness",scope});assert.equal(first.componentChecks.length,7);
  const calls=count();wrong();
  const second=await backend.main({action:"refresh_readiness",scope});assert.ok(count()>calls);assert.equal(second.componentChecks.find(item=>item.id==="edt").state,"not_verified");
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
  const execFile=childProcess.execFile;
  t.mock.method(childProcess,"execFile",(command,args,options,callback)=>command===process.execPath&&args?.[0]==="-version"?queueMicrotask(()=>callback(null,"",'java version "21"')):execFile(command,args,options,callback));
  syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  const download=t.mock.method(globalThis,"fetch",async()=>{throw new Error("Unexpected download");});
  await backend.main({action:"update",set:{codeIndexEnabled:true,bslLsEnabled:true,edtUrl:"",v8stdUrl:""}});
  const unprepared=await backend.main({action:"refresh_readiness",scope});
  for(const component of ["code-index","bsl-ls"]){const item=unprepared.managed.find(item=>item.name===component);assert.equal(item.ready,false);assert.match(item.detail,/недоступен|не проверена/);}
  grant_preparation(f.state,f.root,["code-index","bsl-ls"]);
  const file=path.join(instance_directory(f.state,f.root),"first.preparation.json"),before=fs.readFileSync(file);
  const missing=await backend.main({action:"refresh_readiness",scope});
  for(const component of ["code-index","bsl-ls"]){const item=missing.managed.find(item=>item.name===component);assert.equal(item.ready,false);assert.match(item.detail,/недоступен|не установлен/);}
  assert.deepEqual(fs.readFileSync(file),before);assert.equal(fs.existsSync(path.join(f.state,"runtime-lock.json")),false);
  process.env.EDT_AI_INSTANCE="another";
  const other=await backend.main({action:"refresh_readiness",scope:f.root+"#another"});assert.equal(other.managed.find(item=>item.name==="code-index").state,"stopped");
  assert.equal(download.mock.callCount(),0);
});

test("status reads and missing prepared artifacts never probe Java or start local services", async t => {
  const {f,backend,count}=await ready_fixture(t);
  const config=backend.current();config.mcp.managed["bsl-ls"].java=process.execPath;
  fs.writeFileSync(f.env.EDT_AI_SETTINGS,JSON.stringify(config));
  await backend.main({action:"update",set:{bslLsEnabled:true}});
  grant_preparation(f.state,f.root,["bsl-ls"]);
  const execute=t.mock.method(childProcess,"execFile",()=>{throw new Error("Unexpected Java probe");});
  const spawn=t.mock.method(childProcess,"spawn",()=>{throw new Error("Unexpected process launch");});
  syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  await backend.main({action:"status"});
  const calls=count(), result=await backend.main({action:"refresh_readiness",scope:f.root+"#first"});
  assert.ok(count()>calls);assert.equal(result.external.edt.ready,true);
  assert.equal(result.componentChecks.find(item=>item.id==="bsl-ls").state,"error");
  assert.equal(execute.mock.callCount(),0);assert.equal(spawn.mock.callCount(),0);
});

test("a busy runtime lock does not stall automatic BSL observation", async t => {
  const { f, backend } = await ready_fixture(t);
  await backend.main({ action: "update", set: { bslLsEnabled: true } }); grant_preparation(f.state, f.root, ["bsl-ls"]);
  const lock = path.join(f.state, "operation.lock"); fs.writeFileSync(lock, String(process.pid));
  const started = Date.now();
  await assert.rejects(installed_runtime(f.state, backend.effective(backend.current()), "bsl-ls", false, false, 1), error => error.code === "RUNTIME_BUSY");
  assert.ok(Date.now() - started < 5000); fs.unlinkSync(lock);
  assert.equal(fs.existsSync(path.join(f.state, "runtime-lock.json")), false);
});

test("local BSL compatibility survives setup expiry and unrelated changes without launching Java", async t => {
  const {f,backend,authorization}=await ready_fixture(t);
  await backend.main({action:"update",set:{bslLsEnabled:true}});
  const config=backend.effective(backend.current());
  save_readiness(f.state,config,f.profile,[{name:"bsl-ls",state:"ready",ready:true}],{});
  const saved=read_component_checks(f.state,config,f.profile).find(item=>item.id==="bsl-ls");
  assert.equal(saved.validity,"inputs");assert.equal(saved.expiresAt,null);
  const now=Date.now();t.mock.method(Date,"now",()=>now+20*60000);
  const execute=t.mock.method(childProcess,"execFile",()=>{throw new Error("Unexpected Java probe");});
  syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  f.profile.project.id="renamed";f.save();fs.writeFileSync(path.join(f.root,"src/Changed.bsl"),"// changed source");
  await backend.main({action:"update",set:{v8stdUrl:""}});
  for(let i=0;i<2;i++){
    const result=await backend.main({action:"refresh_readiness",scope:f.root+"#first",component:"bsl-ls"}),check=result.componentChecks[0];
    assert.equal(check.state,"ready");assert.equal(check.checkedAt,saved.checkedAt);assert.equal(check.expiresAt,null);
    const current=await backend.main({action:"read"});assert.equal(current.readiness.state,"stale");
    assert.equal(current.summary.components.find(item=>item.id==="bsl-ls").status,"ready");
  }
  const repeated=await backend.main({action:"check",authorization});
  assert.equal(repeated.managed.find(item=>item.name==="bsl-ls").state,"ready");
  assert.equal(repeated.managed.find(item=>item.name==="bsl-ls").checkedAt,saved.checkedAt);
  assert.equal(execute.mock.callCount(),0);
});

test("first BSL preparation accepts its own installation, reuses unchanged API evidence and rejects input races", async t => {
  const {f,backend,authorization}=await ready_fixture(t),configuration=path.join(f.root,"bsl.json");
  fs.writeFileSync(configuration,"{}");
  await backend.main({action:"update",set:{bslLsEnabled:true,bslLsJava:process.execPath}});
  const config=backend.current();Object.assign(config.mcp.managed["bsl-ls"],{node:process.execPath,configuration});
  fs.writeFileSync(f.env.EDT_AI_SETTINGS,JSON.stringify(config));
  const bytes=zip({"META-INF/MANIFEST.MF":Buffer.from("fixture")}),hash=sha256(bytes),fetch=globalThis.fetch;
  t.mock.method(globalThis,"fetch",(url,options)=>{
    if(String(url).startsWith("https://api.github.com/repos/1c-syntax/bsl-language-server/"))return Promise.resolve(new Response(JSON.stringify({tag_name:"v1.1.0",assets:[{
      name:"bsl-language-server-1.1.0-exec.jar",size:bytes.length,digest:"sha256:"+hash,browser_download_url:"https://github.com/1c-syntax/bsl-language-server/releases/download/v1.1.0/server.jar"}]})));
    if(String(url).startsWith("https://github.com/1c-syntax/bsl-language-server/releases/download/"))return Promise.resolve(new Response(bytes));
    return fetch(url,options);
  });
  const originalSpawn=childProcess.spawn,preload=new URL("./fixtures/bsl-smoke-spawn.mjs",import.meta.url).href;
  let launches=0,mutate=false;const pidFiles=[];
  t.mock.method(childProcess,"spawn",(command,args,options)=>{
    if(path.basename(args[0])!=="process_supervisor.mjs" || options.cwd!==f.root)return originalSpawn(command,args,options);
    const pidFile=path.join(f.base,"bsl-"+(++launches)+".pid");pidFiles.push(pidFile);
    return originalSpawn(command,["--import",preload,...args],{...options,env:{...options.env,BSL_TEST_PID_FILE:pidFile}});
  });
  t.mock.method(childProcess,"execFile",(_command,_args,_options,callback)=>{
    if(mutate)fs.writeFileSync(configuration,'{"changed":"during-check"}');
    queueMicrotask(()=>callback(null,"",'java version "21"'));
  });
  syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  assert.equal(fs.existsSync(path.join(f.state,"runtime-lock.json")),false);
  const first=await backend.main({action:"check",authorization}),bsl=first.managed.find(item=>item.name==="bsl-ls");
  assert.equal(bsl.state,"ready",bsl.detail);assert.equal(bsl.ready,true);assert.equal(bsl.expiresAt,null);assert.equal(launches,1);
  const second=await backend.main({action:"check",authorization});assert.equal(second.managed.find(item=>item.name==="bsl-ls").checkedAt,bsl.checkedAt);assert.equal(launches,1);
  fs.writeFileSync(configuration,'{"changed":"before-check"}');mutate=true;
  const changed=await backend.main({action:"check",authorization}),invalid=changed.managed.find(item=>item.name==="bsl-ls");
  assert.equal(invalid.state,"check_stale");assert.equal(invalid.ready,false);assert.equal(launches,2);
  mutate=false;
  const refreshed=await backend.main({action:"refresh_readiness",scope:f.root+"#first",component:"bsl-ls"});
  assert.equal(refreshed.componentChecks[0].state,"ready");assert.equal(refreshed.componentChecks[0].expiresAt,null);assert.equal(launches,3);
  await backend.main({action:"refresh_readiness",scope:f.root+"#first",component:"bsl-ls"});assert.equal(launches,3,"unchanged inputs must not start another JVM");
  fs.writeFileSync(configuration,'{"changed":"on-disk"}');
  const refreshedAgain=await backend.main({action:"refresh_readiness",scope:f.root+"#first",component:"bsl-ls"});
  assert.equal(refreshedAgain.componentChecks[0].state,"ready");assert.equal(launches,4,"invalidated inputs must be rechecked automatically");
  fs.writeFileSync(configuration,'{"changed":"before-lock-contention"}');
  const write=fs.writeFileSync;let lockWrites=0;
  t.mock.method(fs,"writeFileSync",(file,...args)=>{
    if(file===path.join(f.state,"operation.lock")&&++lockWrites===2)throw Object.assign(new Error("fixture lock is held"), { code: "RUNTIME_BUSY" });
    return write(file,...args);
  });
  const busy=await backend.main({action:"refresh_readiness",scope:f.root+"#first",component:"bsl-ls"});
  assert.equal(busy.componentChecks[0].state,"preparing");assert.equal(busy.componentChecks[0].validity,undefined);assert.equal(launches,4);
  const retry=await backend.main({action:"refresh_readiness",scope:f.root+"#first",component:"bsl-ls"});
  assert.equal(retry.componentChecks[0].state,"ready");assert.equal(launches,5,"temporary lock contention must allow the next refresh to retry");
  save_component_checks(f.state,backend.effective(backend.current()),f.profile,[{id:"bsl-ls",state:"error",inputRevision:retry.componentChecks[0].inputRevision}]);
  const recovered=await backend.main({action:"refresh_readiness",scope:f.root+"#first",component:"bsl-ls"});
  assert.equal(recovered.componentChecks[0].state,"ready");assert.equal(launches,6,"a transient error must be retried using the existing grant");
  await backend.main({action:"refresh_readiness",scope:f.root+"#first",component:"bsl-ls"});assert.equal(launches,6,"successful unchanged evidence must be reused");
  for(const file of pidFiles)assert.equal(alive(Number(fs.readFileSync(file,"utf8"))),false);
});

test("local BSL evidence follows its launch inputs and a passive refresh cannot rebase invalid evidence", async t => {
  const {f,backend}=await ready_fixture(t);
  const java=path.join(f.base,process.platform==="win32"?"java.exe":"java"),configuration=path.join(f.root,"bsl.json"),jar=path.join(f.state,"fixture.jar");
  fs.writeFileSync(java,"java-a",{mode:0o755});fs.writeFileSync(configuration,"{}");fs.writeFileSync(jar,"jar-a");
  await backend.main({action:"update",set:{bslLsEnabled:true,bslLsJava:java}});
  const settings=backend.current();settings.mcp.managed["bsl-ls"].configuration=configuration;
  fs.writeFileSync(f.env.EDT_AI_SETTINGS,JSON.stringify(settings));
  const lock=path.join(f.state,"runtime-lock.json");fs.writeFileSync(lock,JSON.stringify({"bsl-ls":{path:"fixture.jar"}}));
  const config=backend.effective(backend.current()),proof=save_component_checks(f.state,config,f.profile,[{id:"bsl-ls",state:"ready"}])[0];
  const state=()=>read_component_checks(f.state,config,f.profile)[0].state;
  for(const [file,changed,original]of [[jar,"jar-b","jar-a"],[java,"java-b","java-a"],[configuration,'{"changed":true}',"{}"]]){
    fs.writeFileSync(file,changed);assert.equal(state(),"check_stale");fs.writeFileSync(file,original);assert.equal(state(),"ready");
  }
  fs.writeFileSync(lock,JSON.stringify({"bsl-ls":{path:"fixture.jar"},"code-index":{release:"changed"}}));assert.equal(state(),"ready");
  config.mcp.managed["bsl-ls"].node="missing-node-fixture";assert.equal(state(),"check_stale");config.mcp.managed["bsl-ls"].node=settings.mcp.managed["bsl-ls"].node;
  config.mcp.managed["bsl-ls"].configuration="../outside.json";assert.equal(state(),"check_stale");config.mcp.managed["bsl-ls"].configuration=configuration;
  const oldOptions=process.env.JAVA_TOOL_OPTIONS;process.env.JAVA_TOOL_OPTIONS="-Dfixture=changed";assert.equal(state(),"check_stale");
  if(oldOptions===undefined)delete process.env.JAVA_TOOL_OPTIONS;else process.env.JAVA_TOOL_OPTIONS=oldOptions;
  fs.writeFileSync(configuration,'{"changed":true}');
  const receiptFile=path.join(instance_directory(f.state,f.root),"first.readiness.json"),before=fs.readFileSync(receiptFile,"utf8");
  const result=await backend.main({action:"refresh_readiness",scope:f.root+"#first",component:"bsl-ls"});
  assert.equal(result.componentChecks[0].state,"not_verified");assert.deepEqual(JSON.parse(fs.readFileSync(receiptFile,"utf8")).components["bsl-ls"],JSON.parse(before).components["bsl-ls"]);
  assert.equal(state(),"check_stale");fs.writeFileSync(configuration,"{}");assert.equal(state(),"ready");
  process.env.EDT_AI_INSTANCE="another";assert.deepEqual(read_component_checks(f.state,config,f.profile),[]);
});

test("external BSL checks keep their time limit and local legacy evidence is not promoted", async t => {
  const {f,backend}=await ready_fixture(t),config=backend.effective(backend.current());
  config.mcp.managed["bsl-ls"].mode="external";
  const saved=save_component_checks(f.state,config,f.profile,[{id:"bsl-ls",state:"ready"}])[0];
  assert.ok(saved.expiresAt);assert.equal(saved.validity,undefined);
  const now=Date.now();t.mock.method(Date,"now",()=>now+20*60000);
  assert.equal(read_component_checks(f.state,config,f.profile)[0].state,"check_stale");
  config.mcp.managed["bsl-ls"].mode="auto";
  assert.equal(read_component_checks(f.state,config,f.profile)[0].state,"check_stale");
});

test("managed refresh does not renew expired index proof or relaunch an unchanged BSL", async t => {
  const {f,backend}=await ready_fixture(t);
  await backend.main({action:"update",set:{codeIndexEnabled:true,bslLsEnabled:true}});
  const config=backend.effective(backend.current()),home=path.join(project_directory(f.state,f.root),"code-index");
  fs.mkdirSync(home,{recursive:true});fs.writeFileSync(path.join(home,"daemon.json"),JSON.stringify({pid:process.pid,http_port:45678}));
  const fetch=globalThis.fetch;
  t.mock.method(globalThis,"fetch",(url,options)=>String(url)==="http://127.0.0.1:45678/health"?Promise.resolve(new Response(JSON.stringify({pid:process.pid,status:"running",paths:[]}))):fetch(url,options));
  save_readiness(f.state,config,f.profile,[{name:"code-index",state:"stale",ready:false},{name:"bsl-ls",state:"ready",ready:true}],{edt:{ready:true},v8std:{ready:true}});
  const file=path.join(instance_directory(f.state,f.root),"first.readiness.json"),receipt=JSON.parse(fs.readFileSync(file,"utf8"));
  const observedAt=Date.now(),checkedAt=new Date(observedAt-16*60000).toISOString(),expiresAt=new Date(observedAt-60000).toISOString();
  receipt.result.checkedAt=checkedAt;receipt.result.expiresAt=expiresAt;fs.writeFileSync(file,JSON.stringify(receipt));
  // Reproduce the old loop: a newer liveness-only observation used to hide
  // the older setup API result as soon as its 15-minute validity expired.
  save_component_checks(f.state,config,f.profile,[{id:"code-index",state:"running"}]);
  const spawn=t.mock.method(childProcess,"spawn",()=>{throw new Error("Unexpected service launch");});syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  for(const component of ["code-index","bsl-ls"]){
    const result=await backend.main({action:"refresh_readiness",scope:f.root+"#first",component}),check=result.componentChecks[0];
    assert.equal(check.state,component==="bsl-ls"?"ready":"not_verified");
    if(component==="code-index"){assert.ok(Date.parse(check.checkedAt)>Date.parse(checkedAt));assert.match(check.detail,/актуальность индекса не подтверждена/);}
    else assert.equal(check.expiresAt,null);
    const saved=(await backend.main({action:"read"})).componentChecks.find(item=>item.id===component);
    assert.equal(saved.state,check.state);if(component==="code-index")assert.match(saved.detail,/Подготовить и проверить/);
  }
  assert.equal(spawn.mock.callCount(),0);
  process.env.EDT_AI_INSTANCE="another";
  const other=await backend.main({action:"probe",component:"bsl-ls"});assert.equal(other.componentChecks[0].state,"not_verified");
});

async function live_index_fixture(t) {
  const { f, backend } = await ready_fixture(t);
  await backend.main({ action: "update", set: { codeIndexEnabled: true } });
  const home = path.join(project_directory(f.state, f.root), "code-index"), binary = Buffer.from("managed index fixture");
  const exe = path.join(f.state, "runtime/code-index/fixture", sha256(binary), "bsl-indexer.exe");
  fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.writeFileSync(exe, binary);
  fs.mkdirSync(home, { recursive: true }); index_config(home, f.root, f.profile);
  fs.mkdirSync(path.join(f.root, ".code-index")); fs.writeFileSync(path.join(f.root, ".code-index/index.db"), "existing");
  const daemon = createServer((req, res) => {
    assert.equal(req.method, "GET"); assert.equal(req.url, "/health");
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ pid: process.pid, status: "running", paths: [{ path: f.root, status: "ready" }] }));
  });
  daemon.listen(0, "127.0.0.1"); await once(daemon, "listening");
  t.after(() => { daemon.closeAllConnections(); return new Promise(done => daemon.close(done)); });
  fs.writeFileSync(path.join(home, "daemon.json"), JSON.stringify({ pid: process.pid, http_port: daemon.address().port }));
  fs.writeFileSync(path.join(home, "owner.json"), JSON.stringify({ pid: process.pid, project_root: f.root, executable: exe }));
  const spawn = childProcess.spawn, reader = fileURLToPath(new URL("./fixtures/index-reader.mjs", import.meta.url)), starts = [];
  t.mock.method(childProcess, "spawn", (command, args, options) => {
    if (options.cwd !== home) return spawn(command, args, options);
    assert.equal(path.basename(args[0]), "process_supervisor.mjs", "observation must not launch a daemon");
    const child = spawn(command, args, options), send = child.send.bind(child);
    child.send = (message, ...rest) => {
      if (message.command) {
        assert.equal(message.command, exe);
        assert.deepEqual(message.args, ["serve", "--config", path.join(home, "daemon.toml")]);
        starts.push(message);
        message = { ...message, command: process.execPath, args: [reader] };
      }
      return send(message, ...rest);
    };
    return child;
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (url, options) => {
    assert.match(String(url), /^http:\/\/127\.0\.0\.1:/, "observation must not download or query releases");
    return fetch(url, options);
  });
  const health = (status = "ready", stale = false) => ({ mcp: { status: "ok" }, daemon: { status: "online" },
    repos: [{ repo: "product", root_path: f.root, path_status: { status }, data_version: { stale } }] });
  const setHealth = (...results) => fs.writeFileSync(path.join(home, "health-fixture.json"), JSON.stringify({ results }));
  const refresh = () => backend.main({ action: "refresh_readiness", scope: f.root + "#first", component: "code-index" });
  return { f, backend, home, exe, starts, health, setHealth, refresh };
}

test("a replacement index process cannot inherit the previous process API proof", async t => {
  const {f,backend,home,refresh}=await live_index_fixture(t),config=backend.effective(backend.current());
  save_component_checks(f.state,config,f.profile,[{id:"code-index",state:"ready"}]);
  const unchanged=await refresh();assert.equal(unchanged.componentChecks[0].state,"not_verified","liveness cannot prove that a PID was not reused");
  save_component_checks(f.state,config,f.profile,[{id:"code-index",state:"ready"}]);
  const daemonFile=path.join(home,"daemon.json"),daemon=JSON.parse(fs.readFileSync(daemonFile,"utf8"));
  daemon.pid+=1;fs.writeFileSync(daemonFile,JSON.stringify(daemon));
  const fetch=globalThis.fetch;
  t.mock.method(globalThis,"fetch",(url,options)=>String(url).endsWith("/health")
    ? Promise.resolve(new Response(JSON.stringify({pid:daemon.pid,status:"running",paths:[{path:f.root,status:"ready"}]}),{status:200,headers:{"content-type":"application/json"}}))
    : fetch(url,options));
  const result=await refresh();assert.equal(result.componentChecks[0].state,"not_verified");assert.equal(result.managed[0].ready,false);
});

test("prepared index refresh replaces liveness and cached results with current read-only API evidence", async t => {
  const { f, backend, home, starts, health, setHealth, refresh } = await live_index_fixture(t);
  const config = backend.effective(backend.current()), files = ["daemon.json", "owner.json", "daemon.toml"];
  const before = files.map(file => fs.readFileSync(path.join(home, file)));
  grant_preparation(f.state, f.root, ["code-index"]);
  save_component_checks(f.state, config, f.profile, [{ id: "code-index", state: "running" }]);
  setHealth(health("initial_indexing"), health());
  let result = await refresh();
  assert.equal(result.managed[0].state, "ready", result.managed[0].detail);
  assert.equal(result.managed[0].ready, true); assert.equal(result.componentChecks[0].repositories[0].state, "ready");
  const events = () => fs.readFileSync(path.join(home, "reader-events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(events().filter(event => event.method === "tools/call").length, 2, "a building index is observed again before reporting readiness");
  for (const [body, expected] of [[health("ready", true), "stale"], [health(), "ready"],
    [{ isError: true, content: [{ type: "text", text: "private external error" }] }, "error"],
    [{ ...health(), repos: [{ ...health().repos[0], root_path: f.base }] }, "mismatch"]]) {
    setHealth(body); result = await refresh();
    assert.equal(result.managed[0].state, expected, result.managed[0].detail);
    const current = await backend.main({ action: "read" });
    assert.equal(current.componentChecks.find(item => item.id === "code-index").state, expected);
    assert.doesNotMatch(JSON.stringify(result), /private external error/);
  }
  for (const event of events()) assert.equal(alive(event.pid), false, "temporary readers must close before the check completes");
  assert.equal(starts.length, 5);
  files.forEach((file, i) => assert.deepEqual(fs.readFileSync(path.join(home, file)), before[i]));
  assert.deepEqual(fs.readdirSync(path.join(home, "readers")), []);
  assert.equal(fs.existsSync(path.join(f.state, "runtime-lock.json")), false);
  assert.equal((await backend.main({ action: "read" })).readiness.state, "not_checked");
});

test("index observation never launches an unapproved, stopped, foreign or modified runtime", async t => {
  const { f, home, exe, starts, health, setHealth, refresh } = await live_index_fixture(t);
  setHealth(health());
  assert.equal((await refresh()).managed[0].state, "running"); assert.equal(starts.length, 0);
  grant_preparation(f.state, f.root, ["code-index"]);
  process.env.EDT_AI_INSTANCE = "another";
  const other = await new SettingsBackend().main({ action: "refresh_readiness", scope: f.root + "#another", component: "code-index" });
  assert.equal(other.managed[0].state, "running"); assert.equal(starts.length, 0);
  process.env.EDT_AI_INSTANCE = "first";
  const ownerFile = path.join(home, "owner.json"), owner = JSON.parse(fs.readFileSync(ownerFile));
  for (const change of [value => value.pid++, value => value.project_root = f.base]) {
    const invalid = structuredClone(owner); change(invalid); fs.writeFileSync(ownerFile, JSON.stringify(invalid));
    const result = await refresh(); assert.equal(result.managed[0].state, "error"); assert.match(result.managed[0].detail, /Владелец/);
  }
  fs.writeFileSync(ownerFile, JSON.stringify(owner)); fs.writeFileSync(exe, "modified artifact");
  assert.match((await refresh()).managed[0].detail, /исполняемый файл/);
  fs.writeFileSync(path.join(home, "daemon.json"), "{}");
  const unavailable = (await refresh()).managed[0];
  assert.equal(unavailable.state, "not_verified"); assert.equal(starts.length, 0);
  assert.match(unavailable.detail, /процесс может работать/);
  assert.doesNotMatch(unavailable.detail, /не запущен|разрешённую подготовку/);
});

test("a temporary invalid index health response does not claim the live daemon is stopped", async t => {
  const { f, starts, health, setHealth, refresh } = await live_index_fixture(t);
  grant_preparation(f.state, f.root, ["code-index"]); setHealth(health());
  assert.equal((await refresh()).managed[0].state, "ready");
  const fetch = globalThis.fetch;
  const broken = t.mock.method(globalThis, "fetch", (url, options) => String(url).endsWith("/health")
    ? Promise.resolve(new Response("not JSON", { status: 200 })) : fetch(url, options));
  const unavailable = (await refresh()).managed[0];
  assert.equal(unavailable.state, "not_verified"); assert.match(unavailable.detail, /процесс может работать/);
  broken.mock.restore();
  assert.equal((await refresh()).managed[0].state, "ready"); assert.equal(starts.length, 2);
});

test("a failed component probe cannot replace other component results", async t => {
  const { f, backend, url } = await ready_fixture(t), config = backend.current();
  for (const id of ["code-index", "bsl-ls"]) Object.assign(config.mcp.managed[id], { enabled: true, mode: "external", url: url + (id === "code-index" ? "/index" : "/bsl") });
  fs.writeFileSync(f.env.EDT_AI_SETTINGS, JSON.stringify(config));
  await backend.main({ action: "update", set: { codeIndexEnabled: true, bslLsEnabled: true } });
  const main = backend.main.bind(backend);
  t.mock.method(backend, "main", (request, ...args) => request.action === "probe" && request.component === "openviking" && request.collectOnly
    ? Promise.reject(new Error("opaque-secret-from-broken-probe")) : main(request, ...args));
  const result = await main({ action: "refresh_readiness", scope: f.root + "#first" });
  assert.equal(result.componentChecks.find(item => item.id === "openviking").state, "not_verified");
  for (const id of ["code-index", "bsl-ls"]) assert.equal(result.componentChecks.find(item => item.id === id).state, "ready");
  assert.equal(JSON.stringify(result).includes("opaque-secret-from-broken-probe"), false);
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
  assert.ok(count()>calls);assert.equal(result.readiness,undefined);
  assert.equal(indexChecks(),2,"a startup health response without freshness is observed again before completing the check");
  for(const component of ["code-index","bsl-ls"]){
    assert.equal(result.managed.find(item=>item.name===component).ready,true);
    const current=await backend.main({action:"read"}),saved=current.componentChecks.find(item=>item.id===component);assert.equal(saved.state,"ready");assert.equal(saved.checkedAt,result.componentChecks.find(item=>item.id===component).checkedAt);
    assert.equal(current.summary.components.find(item=>item.id===component).mode,"external");
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
  for (const invalid of [value => { value.result.checkedAt="invalid"; }, value => { value.result.checkedAt=new Date(Date.now()+60000).toISOString(); }, value => { delete value.fingerprint; }]) {
    const damaged=structuredClone(receipt);invalid(damaged);fs.writeFileSync(file,JSON.stringify(damaged));
    assert.equal((await backend.main({action:"read"})).readiness.state,"not_checked");
  }
  receipt.result.checkedAt=new Date(Date.now()-16*60*1000).toISOString();fs.writeFileSync(file,JSON.stringify(receipt));
  assert.equal((await backend.main({action:"read"})).readiness.state,"stale");
  fs.writeFileSync(file,'{"version":1,"result":{"state":"ready","checks":[null]}}');assert.equal((await backend.main({action:"read"})).readiness.state,"not_checked");
  await backend.main({action:"update",set:{openvikingEnabled:true,openvikingUrl:"https://knowledge.example/mcp"}});
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
