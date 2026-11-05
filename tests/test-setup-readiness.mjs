import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { edt_fixture as fixture, environment } from "./helpers.mjs";
import { SettingsBackend } from "../scripts/settings_backend.mjs";
import { setup_assets, save_readiness, read_readiness, save_component_checks, read_component_checks } from "../scripts/setup_readiness.mjs";
import { instance_directory, project_directory, sha256 } from "../scripts/project_paths.mjs";
import { grant_preparation } from "../scripts/components.mjs";
import { zip } from "../scripts/archives.mjs";
import { alive } from "../scripts/processes.mjs";
import { index_config } from "../scripts/runtime.mjs";

async function ready_fixture(t) {
  const f=fixture(t);environment(t,f.env);f.save();let calls=0,wrongPath=false,noTools=false,indexChecks=0,settling=false,indexFailure=null,projectState="ready";const paths=[];
  const server=createServer(async(req,res)=>{
    let text="";for await(const part of req)text+=part;
    if(!text){res.writeHead(202).end();return;}const message=JSON.parse(text);calls++;paths.push(req.url);
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
    if(message.method==="tools/call")return reply({content:[{type:"text",text:JSON.stringify({projects:[{name:"Product",path:wrongPath?f.base:f.root,open:true,state:projectState,edtProject:true}]})}]});
    reply({});
  });server.listen(0,"127.0.0.1");await once(server,"listening");t.after(()=>{server.closeAllConnections();return new Promise(done=>server.close(done));});
  const backend=new SettingsBackend(),url="http://127.0.0.1:"+server.address().port;
  await backend.main({action:"update",set:{codeIndexEnabled:false,bslLsEnabled:false,edtUrl:url+"/edt",v8stdUrl:url+"/v8std"}});
  return {f,backend,url,paths,authorization:{scope:f.root+"#first",effects:["launch"],evidence:"user requested setup check"},count:()=>calls,wrong:()=>{wrongPath=true;},noTools:()=>{noTools=true;},settle:()=>{settling=true;},indexChecks:()=>indexChecks,failIndex:message=>{indexFailure=message;},setProjectState:state=>{projectState=state;}};
}

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
  for(const component of ["code-index","bsl-ls"]){const item=unprepared.managed.find(item=>item.name===component);assert.equal(item.ready,false);assert.match(item.detail,/не запущен|не проверена/);}
  grant_preparation(f.state,f.root,["code-index","bsl-ls"]);
  const file=path.join(instance_directory(f.state,f.root),"first.preparation.json"),before=fs.readFileSync(file);
  const missing=await backend.main({action:"refresh_readiness",scope});
  for(const component of ["code-index","bsl-ls"]){const item=missing.managed.find(item=>item.name===component);assert.equal(item.ready,false);assert.match(item.detail,/не запущен|не установлен/);}
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
  const result=await backend.main({action:"refresh_readiness",scope:f.root+"#first",component:"bsl-ls"});
  assert.equal(result.componentChecks[0].state,"check_stale");assert.equal(result.componentChecks[0].checkedAt,proof.checkedAt);
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

test("passive managed probes preserve index expiry and durable BSL evidence without launching services", async t => {
  const {f,backend}=await ready_fixture(t);
  await backend.main({action:"update",set:{codeIndexEnabled:true,bslLsEnabled:true}});
  const config=backend.effective(backend.current()),home=path.join(project_directory(f.state,f.root),"code-index");
  fs.mkdirSync(home,{recursive:true});fs.writeFileSync(path.join(home,"daemon.json"),JSON.stringify({pid:process.pid,http_port:45678}));
  const fetch=globalThis.fetch;
  t.mock.method(globalThis,"fetch",(url,options)=>String(url)==="http://127.0.0.1:45678/health"?Promise.resolve(new Response(JSON.stringify({pid:process.pid,status:"running",paths:[]}))):fetch(url,options));
  save_readiness(f.state,config,f.profile,[{name:"code-index",state:"stale",ready:false},{name:"bsl-ls",state:"ready",ready:true}],{edt:{ready:true},v8std:{ready:true}});
  const file=path.join(instance_directory(f.state,f.root),"first.readiness.json"),receipt=JSON.parse(fs.readFileSync(file,"utf8"));
  const checkedAt=new Date(Date.now()-16*60000).toISOString(),expiresAt=new Date(Date.now()-60000).toISOString();
  receipt.result.checkedAt=checkedAt;receipt.result.expiresAt=expiresAt;fs.writeFileSync(file,JSON.stringify(receipt));
  // Reproduce the old loop: a newer liveness-only observation used to hide
  // the older setup API result as soon as its 15-minute validity expired.
  save_component_checks(f.state,config,f.profile,[{id:"code-index",state:"running"}]);
  const spawn=t.mock.method(childProcess,"spawn",()=>{throw new Error("Unexpected service launch");});syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  for(const component of ["code-index","bsl-ls"]){
    const result=await backend.main({action:"refresh_readiness",scope:f.root+"#first",component}),check=result.componentChecks[0];
    assert.equal(check.state,component==="bsl-ls"?"ready":"check_stale");
    if(component==="code-index"){assert.equal(check.checkedAt,checkedAt);assert.equal(check.expiresAt,expiresAt);assert.match(check.detail,/Подготовить и проверить/);}
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
  assert.equal((await refresh()).managed[0].state, "stopped"); assert.equal(starts.length, 0);
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
