import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fixture, environment, session, ROOT } from "./helpers.mjs";
import { settings, dump, sleep } from "../scripts/common.mjs";
import { grant_preparation } from "../scripts/components.mjs";
import { instance_directory, sha256 } from "../scripts/project_paths.mjs";
import { launch_selection, roots_selection } from "../scripts/selection.mjs";
import { project_home, ensure_installed, artifact, update_component, read_json } from "../scripts/runtime.mjs";
import { zip } from "../scripts/archives.mjs";
import { satisfies_core } from "../scripts/compatibility.mjs";
import { validate } from "../scripts/profile.mjs";
import { casefold } from "../scripts/casefold.mjs";
import { SettingsBackend } from "../scripts/settings_backend.mjs";
import { McpClient } from "../scripts/mcp_client.mjs";
import { createServer } from "node:http";
import { once } from "node:events";
import { launch, stop_child } from "../scripts/processes.mjs";
import { stop_daemon, platform_build, save_json, acquire_reader, installed_runtime } from "../scripts/runtime.mjs";
const preload = new URL("./fixtures/managed-spawn.mjs", import.meta.url).href;
async function managed(t, f, prepare = true) {
  environment(t, f.env); f.save();
  if (prepare) grant_preparation(f.state, f.root, ["code-index"]);
  const c = await session(t, "scripts/lazy_mcp.mjs", ["--component", "code-index"], f,
    { NODE_OPTIONS: [process.env.NODE_OPTIONS, "--import " + preload].filter(Boolean).join(" ") });
  await c.request("tools/list"); return c;
}
test("unselected connections never borrow active_project; roots fallback is shared", t => {
  const f = fixture(t);
  assert.equal(launch_selection(ROOT, "").directory, null);
  assert.equal(roots_selection({error:{code:-32601}}, f.root).directory, f.root);
  assert.equal(roots_selection({result:{roots:[]}}, f.root).directory, null);
  assert.throws(() => roots_selection({result:{roots:[{uri:pathToFileURL(f.root).href},{uri:pathToFileURL(f.state).href}]}}, ROOT), /ambiguous/);
});
test("distinct Unicode filesystem directories cannot share instances or daemon homes", t => {
  const f = fixture(t), roots = ["Straße", "STRASSE"].map(name => path.join(f.base,name));
  roots.forEach(root => fs.mkdirSync(root));
  assert.notEqual(instance_directory(f.state,roots[0]), instance_directory(f.state,roots[1]));
  assert.notEqual(project_home(f.state,roots[0]), project_home(f.state,roots[1]));
});
test("unowned legacy overrides are preserved and require explicit selection before reuse",async t=>{
  const f=fixture(t);environment(t,f.env);f.save();
  const old=path.join(f.state,"projects",sha256(casefold(f.root)).slice(0,16),"instances/first.yaml");
  dump({connections:{edt:{url:"http://localhost:17889/mcp"}}},old);
  const before=fs.readFileSync(old),backend=new SettingsBackend(f.state,f.env.EDT_AI_SETTINGS);
  const read=await backend.main({action:"read"});assert.equal(read.values.edtUrl,"");assert.equal(read.legacyState.status,"owner_unknown");
  assert.equal(read.legacyState.connections.edt.url,"http://localhost:17889/mcp");
  await backend.main({action:"update",set:{edtUrl:read.legacyState.connections.edt.url}});
  assert.equal((await backend.main({action:"read"})).values.edtUrl,"http://localhost:17889/mcp");
  assert.deepEqual(fs.readFileSync(old),before);
});
test("native instructions survive and unrelated settings preserve the reader session", async t => {
  const f = fixture(t), c = await managed(t,f);
  const status = (await c.call("core_runtime_status",{})).structuredContent;
  assert.match(status.serverContract.instructions,/Native fixture contract/);
  const before = (await c.call("inspect",{})).structuredContent;
  dump({mcp:{required:{v8std:{url:"http://localhost:19999/mcp"}}}},f.env.EDT_AI_SETTINGS);
  assert.deepEqual((await c.call("inspect",{})).structuredContent,before);
});
test("cancellation reaches the executing upstream request before completion with its mapped id", async t => {
  const f=fixture(t), c=await managed(t,f);
  const pending=c.request("tools/call",{name:"slow"}); const hostId=c.sequence;
  await sleep(80); c.notify("notifications/cancelled",{requestId:hostId,reason:"test"});
  const result=(await pending).structuredContent;
  const cancellation=result.notifications.find(n=>n.method==="notifications/cancelled");
  assert.ok(cancellation); assert.equal(cancellation.params.requestId,result.upstreamId);
});
test("cancellation maps numeric/string host ids independently", async t => {
  const f=fixture(t), c=await managed(t,f);
  const raw = id => new Promise(resolve=>{ c.pending.set(id,resolve); c.send({id,method:"tools/call",params:{name:"slow"}}); });
  const a=raw(888), b=raw("888");
  await sleep(80); c.notify("notifications/cancelled",{requestId:"888"});
  const [first,second]=await Promise.all([a,b]);
  const ids=second.result.structuredContent.notifications.filter(n=>n.method==="notifications/cancelled").map(n=>n.params.requestId);
  assert.ok(ids.includes(second.result.structuredContent.upstreamId));
  assert.ok(!ids.includes(first.result.structuredContent.upstreamId));
});
test("cancellation during initialization prevents dispatch of the waiting call", async t => {
  const f=fixture(t);environment(t,f.env);f.save();grant_preparation(f.state,f.root,["code-index"]);
  const c=await session(t,"scripts/lazy_mcp.mjs",["--component","code-index"],f,{FIXTURE_INIT_DELAY:"250",NODE_OPTIONS:"--import "+preload});
  const first=c.request("tools/call",{name:"slow"});
  const second=c.request("tools/call",{name:"inspect",arguments:{change:true}}); const id=c.sequence;
  const rejection=assert.rejects(second,/cancelled before dispatch/);
  await sleep(60);c.notify("notifications/cancelled",{requestId:id});await Promise.all([first,rejection]);
  assert.ok(!(await c.request("tools/list")).tools.some(tool=>tool.name==="later"));
});
test("native client callbacks cross the relay while the original call is running",async t=>{
  const f=fixture(t);environment(t,f.env);f.save();grant_preparation(f.state,f.root,["code-index"]);
  let callbacks=0;
  const c=new McpClient([process.execPath,path.join(ROOT,"scripts/lazy_mcp.mjs"),"--component","code-index"],f.root,{...f.env,NODE_OPTIONS:"--import "+preload},10,{capabilities:{sampling:{}},onRequest:async message=>{assert.equal(message.method,"sampling/createMessage");callbacks++;return {model:"fixture-model",role:"assistant",content:{type:"text",text:"callback answered"}};}});
  f.clients.push(c);await c.initialize();
  const result=await c.call("ask_host",{});assert.equal(result.structuredContent.content.text,"callback answered");assert.equal(callbacks,1);
});
for (const failure of ["crash","malformed"]) test("a failed child is unavailable and subsequent discovery recovers: "+failure, async t=>{
  const f=fixture(t), c=await managed(t,f), pid=(await c.call("inspect",{})).structuredContent.pid;
  await assert.rejects(c.request("tools/call",{name:failure}),/exited|envelope/);
  assert.equal((await c.call("core_runtime_status",{})).structuredContent.ready,false);
  await c.request("tools/list");
  assert.notEqual((await c.call("inspect",{})).structuredContent.pid,pid);
});
test("reading a profile cannot provision managed runtimes before initial preparation",async t=>{
  const f=fixture(t),c=await managed(t,f,false);
  assert.equal((await c.call("core_runtime_status",{})).structuredContent.ready,false);
  assert.deepEqual((await c.request("tools/list")).tools.map(x=>x.name),["core_runtime_status"]);
  assert.equal(fs.existsSync(path.join(f.state,"runtime-lock.json")),false);
  grant_preparation(f.state,f.root,["code-index"]);
  assert.ok((await c.request("tools/list")).tools.some(x=>x.name==="inspect"));
});
test("disabled components neither require preparation nor launch a child",async t=>{
  const f=fixture(t);dump({mcp:{managed:{"code-index":{enabled:false}}}},f.env.EDT_AI_SETTINGS);
  const c=await managed(t,f,false);
  assert.match((await c.call("core_runtime_status",{})).structuredContent.detail,/отключён/);
  assert.deepEqual((await c.request("tools/list")).tools.map(x=>x.name),["core_runtime_status"]);
});
test("profile compatibility is checked against core semantics independently of format",t=>{
  const f=fixture(t);f.profile.compatibility.core=">=99.0.0";assert.throws(()=>validate(f.profile),/running/);
  for(const range of [">=0.1.0", "^0.2.0", "~0.2.0", ">=0.2.0 <0.3.0 || >=1.0.0"])assert.equal(satisfies_core(range,"0.2.1"),true);
  assert.equal(satisfies_core("<0.2.0","0.2.1"),false);
  assert.throws(()=>satisfies_core(">=0.1.0 bad"),/comparator/);
});
function download(bytes,tag){return {fetch_json:async()=>({tag_name:tag,assets:[{name:`bsl-language-server-${tag}-exec.jar`,size:bytes.length,digest:"sha256:"+sha256(bytes),browser_download_url:`https://github.com/1c-syntax/bsl-language-server/releases/download/${tag}/server.jar`}]}),fetch:async()=>new Response(bytes)};}
test("download, failed validation, apply and rollback preserve the active artifact transactionally",async t=>{
  const f=fixture(t),config=settings();config.mcp.managed["bsl-ls"].enabled=true;
  const first=await ensure_installed(f.state,config,"bsl-ls",false,download(zip({"old.txt":Buffer.from("old")}),"v1.0.0"));
  const changed=structuredClone(config);changed.mcp.managed["bsl-ls"].version="9.0.0";
  await assert.rejects(installed_runtime(f.state,changed,"bsl-ls"),/apply the requested candidate/);
  await update_component(f.state,config,f.root,f.profile,"bsl-ls","download",download(zip({"new.txt":Buffer.from("new")}),"v2.0.0"));
  const candidate=artifact(f.state,"bsl-ls","candidate");assert.notEqual(candidate,first);assert.equal(artifact(f.state,"bsl-ls"),first);
  await assert.rejects(update_component(f.state,config,f.root,f.profile,"bsl-ls","apply",{smoke:async()=>{throw new Error("bad native contract");}}),/active artifact retained/);
  assert.equal(artifact(f.state,"bsl-ls"),first);
  await update_component(f.state,config,f.root,f.profile,"bsl-ls","apply",{smoke:async(...args)=>{assert.equal(args.at(-1),candidate);return {status:"mcp_ready"};}});
  assert.equal(artifact(f.state,"bsl-ls"),candidate);assert.equal(artifact(f.state,"bsl-ls","previous"),first);
  await update_component(f.state,config,f.root,f.profile,"bsl-ls","rollback",{smoke:async()=>({status:"mcp_ready"})});
  assert.equal(artifact(f.state,"bsl-ls"),first);
});
test("stop validates the running daemon's old immutable executable after active release changes",async t=>{
  const f=fixture(t), bytes=Buffer.from("old verified executable"),digest=sha256(bytes),
    old=path.join(f.state,"runtime/code-index/v1.0.0",digest,platform_build().executable),
    home=path.join(project_home(f.state,f.root),"code-index");
  fs.mkdirSync(path.dirname(old),{recursive:true});fs.writeFileSync(old,bytes);
  const child=launch(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});await once(child,"spawn");f.clients.push({close:()=>stop_child(child,0)});
  const server=createServer((req,res)=>res.end(JSON.stringify({pid:child.pid,status:"running"})));
  await new Promise(done=>server.listen(0,"127.0.0.1",done));t.after(()=>server.close());
  save_json(path.join(home,"daemon.json"),{pid:child.pid,http_port:server.address().port});
  save_json(path.join(home,"owner.json"),{pid:child.pid,project_root:f.root,executable:old});
  let stopped=false;
  await stop_daemon(f.state,f.root,{stop:async(exe,args)=>{assert.equal(exe,old);assert.deepEqual(args,["daemon","stop"]);stopped=true;await new Promise(done=>server.close(done));await stop_child(child,0);fs.rmSync(path.join(home,"daemon.json"));}});
  assert.equal(stopped,true);
});
test("maintenance blocks new reader leases before a runtime switch",async t=>{
  const f=fixture(t),home=path.join(project_home(f.state,f.root),"code-index");
  save_json(path.join(home,"maintenance.json"),{pid:99999999,root:f.root});
  await assert.rejects(acquire_reader(f.state,f.root),/update is in progress/);
  assert.equal(fs.existsSync(path.join(home,"readers")),false);
});
test("rejected code-index candidate restores the previous daemon; uncertain cleanup retains maintenance",async t=>{
  const f=fixture(t),config=settings(), entries=["old","new"].map((text,i)=>{
    const bytes=Buffer.from(text),digest=sha256(bytes),file=path.join(f.state,"runtime/code-index/v"+(i+1)+".0.0",digest,platform_build().executable);
    fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);
    return {release:"v"+(i+1)+".0.0",path:path.relative(f.state,file),sha256:digest};
  });
  save_json(path.join(f.state,"runtime-lock.json"),{"code-index":{...entries[0],candidate:entries[1]}});
  let stops=0,restarted=null;
  await assert.rejects(update_component(f.state,config,f.root,f.profile,"code-index","apply",{stop:async()=>{stops++;},smoke:async()=>{throw new Error("native contract missing");},restart:async(...args)=>{restarted=args.at(-1);}}),/active artifact retained/);
  assert.equal(stops,2);assert.equal(restarted,artifact(f.state,"code-index"));
  const maintenance=path.join(project_home(f.state,f.root),"code-index/maintenance.json");assert.equal(fs.existsSync(maintenance),false);
  await assert.rejects(update_component(f.state,config,f.root,f.profile,"code-index","apply",{stop:async()=>{throw new Error("timeout");}}),error=>error.outcomeUnknown===true);
  assert.equal(fs.existsSync(maintenance),true);assert.equal(read_json(path.join(f.state,"runtime-lock.json"))["code-index"].release,"v1.0.0");
});
