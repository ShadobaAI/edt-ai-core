import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";
import { fixture, environment, session, ROOT } from "./helpers.mjs";
import { dump, operation_lock } from "../scripts/common.mjs";
import { SettingsBackend } from "../scripts/settings_backend.mjs";
import { settings } from "../scripts/common.mjs";
import { McpClient } from "../scripts/mcp_client.mjs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { zip } from "../scripts/archives.mjs";
import { sha256 } from "../scripts/project_paths.mjs";
import { artifact, ensure_installed, installed_runtime, read_json } from "../scripts/runtime.mjs";

test("the settings MCP exposes an app-only read-only catalog for both components", async t => {
  const f=fixture(t),client=await session(t,"mcp/settings.mjs",[],f);
  const tool=(await client.request("tools/list")).tools.find(item=>item.name==="settings.versions");
  assert.ok(tool);assert.equal(tool.annotations.readOnlyHint,true);assert.deepEqual(tool._meta.ui.visibility,["app"]);
  assert.deepEqual(tool.inputSchema.properties.component.enum,["code-index","bsl-ls"]);
  const updates=(await client.request("tools/list")).tools.find(item=>item.name==="settings.updates");
  assert.ok(updates.inputSchema.properties.operation.enum.includes("install"));
  await assert.rejects(client.call("settings.versions",{component:"unknown"}));
  assert.equal(fs.existsSync(path.join(f.state,"runtime-lock.json")),false);
});

test("installation requires authorization for the current project and instance before downloading or granting preparation", async t => {
  const f=fixture(t);environment(t,f.env);f.save();
  dump({mcp:{managed:{"code-index":{enabled:true},"bsl-ls":{enabled:true}}}},f.env.EDT_AI_SETTINGS);
  let fetched=false;t.mock.method(globalThis,"fetch",async()=>{fetched=true;throw new Error("Unexpected download");});
  const backend=new SettingsBackend();
  for(const component of ["code-index","bsl-ls"]){
    await assert.rejects(backend.main({action:"updates",operation:"install",component}),/требует разрешения/);
    await assert.rejects(backend.main({action:"updates",operation:"install",component,authorization:{scope:f.root+"#other-instance",effects:["launch"],evidence:"Install selected version"}}),/другой папке или экземпляру/);
  }
  assert.equal(fetched,false);assert.equal(fs.existsSync(path.join(f.state,"runtime-lock.json")),false);
  assert.equal(fs.existsSync(path.join(f.state,"projects")),false);
});

test("installation commits the saved version only after validation and restores it if activation fails", async t => {
  const f=fixture(t);environment(t,f.env);f.save();
  dump({mcp:{managed:{"bsl-ls":{enabled:true,version:"v1.0.0",java:process.execPath}}}},f.env.EDT_AI_SETTINGS);
  const backend=new SettingsBackend(),authorization={scope:f.root+"#first",effects:["launch"],evidence:"Install selected version"};
  const source=tag=>{
    const bytes=zip({"fixture.txt":Buffer.from(tag)});
    return {bytes,release:{tag_name:tag,assets:[{name:`bsl-language-server-${tag}-exec.jar`,size:bytes.length,digest:"sha256:"+sha256(bytes),browser_download_url:`https://github.com/1c-syntax/bsl-language-server/releases/download/${tag}/server.jar`}]}};
  };
  const first=source("v1.0.0");
  await ensure_installed(f.state,settings(f.env.EDT_AI_SETTINGS),"bsl-ls",false,{fetch_json:async()=>first.release,fetch:async()=>new Response(first.bytes)});
  const original=artifact(f.state,"bsl-ls"),lockfile=path.join(f.state,"runtime-lock.json");
  assert.equal((await backend.main({action:"read"})).installedVersions["bsl-ls"],"v1.0.0");
  let valid=true,offline=false,failWrite="",expectedSaved="v1.0.0";
  const server=path.join(f.base,"updates-mcp.mjs");
  fs.writeFileSync(server,`import readline from 'node:readline';
    readline.createInterface({input:process.stdin}).on('line',line=>{
      const m=JSON.parse(line);if(!Object.hasOwn(m,'id'))return;
      const names=process.argv[2]==='valid'?['register_workspace_folder','list_workspace_folders','unregister_workspace_folder','analyze']:['analyze'];
      const result=m.method==='initialize'?{serverInfo:{name:'fixture',version:'1'}}:{tools:names.map(name=>({name,inputSchema:{type:'object',properties:{workspaceFolder:{type:'string'}},required:['workspaceFolder']}}))};
      console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
    });`);
  const spawn=childProcess.spawn,spawnSync=childProcess.spawnSync,rename=fs.renameSync;
  t.mock.method(childProcess,"spawn",(command,args,options)=>{
    if(args?.some(arg=>String(arg).endsWith("bsl-ls-proxy.mjs"))){
      assert.equal(settings(f.env.EDT_AI_SETTINGS).mcp.managed["bsl-ls"].version,expectedSaved);
      return spawn(process.execPath,[server,valid?"valid":"invalid"],options);
    }
    return spawn(command,args,options);
  });
  t.mock.method(childProcess,"spawnSync",(command,args,options)=>args?.[0]==="-version"?{status:0,stderr:'java version "21"'}:spawnSync(command,args,options));
  syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  t.mock.method(fs,"renameSync",(from,to)=>{
    if((failWrite==="settings"&&to===f.env.EDT_AI_SETTINGS)||(failWrite==="activation"&&to===lockfile&&settings(f.env.EDT_AI_SETTINGS).mcp.managed["bsl-ls"].version==="v2.0.0"))throw new Error("Simulated write failure");
    return rename(from,to);
  });
  t.mock.method(globalThis,"fetch",async url=>{
    if(offline)throw new Error("offline");
    const value=String(url),tag=/\/(?:tags|download)\/(v[^/]+)/.exec(value)?.[1]||"v1.0.0",item=source(tag);
    return new Response(value.startsWith("https://api.github.com/")?JSON.stringify(item.release):item.bytes);
  });
  const install=version=>backend.main({action:"updates",operation:"install",component:"bsl-ls",version,authorization});
  const unchanged=async()=>{
    assert.equal(settings(f.env.EDT_AI_SETTINGS).mcp.managed["bsl-ls"].version,"v1.0.0");
    assert.equal(artifact(f.state,"bsl-ls"),original);
    assert.equal(await installed_runtime(f.state,settings(f.env.EDT_AI_SETTINGS),"bsl-ls"),original);
  };
  offline=true;await assert.rejects(install("v2.0.0"),/offline/);await unchanged();offline=false;
  valid=false;await assert.rejects(install("v2.0.0"),/native multi-workspace API/);await unchanged();valid=true;
  for(const target of ["settings","activation"]){failWrite=target;await assert.rejects(install("v2.0.0"),/Simulated write failure/);await unchanged();}
  failWrite="";
  assert.equal((await install("v2.0.0")).release,"v2.0.0");expectedSaved="v2.0.0";
  assert.equal(settings(f.env.EDT_AI_SETTINGS).mcp.managed["bsl-ls"].version,"v2.0.0");
  assert.equal((await install("v1.0.0")).release,"v1.0.0");expectedSaved="v1.0.0";
  await unchanged();
  const rollback=await backend.main({action:"updates",operation:"rollback",component:"bsl-ls",authorization});
  assert.equal(rollback.release,"v2.0.0");assert.equal(settings(f.env.EDT_AI_SETTINGS).mcp.managed["bsl-ls"].version,"v2.0.0");
  assert.equal(read_json(lockfile)["bsl-ls"].release,"v2.0.0");
  assert.equal(await installed_runtime(f.state,settings(f.env.EDT_AI_SETTINGS),"bsl-ls"),artifact(f.state,"bsl-ls"));
});

test("a conflicting local version is rejected before a download or shared settings change", async t => {
  const f=fixture(t);environment(t,f.env);f.save();
  dump({mcp:{managed:{"bsl-ls":{enabled:true,version:"v1.0.0"}}}},f.env.EDT_AI_SETTINGS);
  dump({components:{"bsl-ls":{version:"v1.0.0"}}},path.join(f.root,".ai/project.local.yaml"));
  const before=fs.readFileSync(f.env.EDT_AI_SETTINGS,"utf8");
  let fetched=false;t.mock.method(globalThis,"fetch",async()=>{fetched=true;throw new Error("Unexpected download");});
  await assert.rejects(new SettingsBackend().main({action:"updates",operation:"install",component:"bsl-ls",version:"v2.0.0",authorization:{scope:f.root+"#first",effects:["launch"],evidence:"Install selected version"}}),/закреплена локальными настройками/);
  assert.equal(fetched,false);assert.equal(fs.readFileSync(f.env.EDT_AI_SETTINGS,"utf8"),before);
  assert.equal(fs.existsSync(path.join(f.state,"runtime-lock.json")),false);
});

test("an update waiting for the state lock reads the release policy after acquiring it", async t => {
  const f=fixture(t);environment(t,f.env);f.save();
  dump({mcp:{managed:{"bsl-ls":{enabled:true,version:"v1.0.0"}}}},f.env.EDT_AI_SETTINGS);
  let release;
  const holding=operation_lock(f.state,()=>new Promise(resolve=>{release=resolve;}));
  const urls=[];t.mock.method(globalThis,"fetch",async url=>{urls.push(String(url));throw new Error("offline");});
  const pending=new SettingsBackend().main({action:"updates",operation:"install",component:"bsl-ls",authorization:{scope:f.root+"#first",effects:["launch"],evidence:"Install saved version"}});
  const rejected=assert.rejects(pending,/offline/);
  try {
    await new Promise(resolve=>setImmediate(resolve));
    dump({mcp:{managed:{"bsl-ls":{enabled:true,version:"v2.0.0"}}}},f.env.EDT_AI_SETTINGS);
  } finally { release();await holding; }
  await rejected;assert.equal(urls.length,1);assert.match(urls[0],/\/tags\/v2\.0\.0$/);
});

test("the settings MCP never caches empty catalogs and refresh bypasses both caches", async t => {
  const f=fixture(t),preload=path.join(f.base,"catalog-fetch.mjs");
  fs.writeFileSync(preload,`let calls=0;globalThis.fetch=async(url,options)=>{
    if(String(url).endsWith('/latest'))return new Response(JSON.stringify({tag_name:'v1.0.7',prerelease:false}));
    const count=++calls;
    if(count<=3)return new Response('[]');
    if(count===5&&!(options.cache==='no-store'&&options.headers['Cache-Control']==='no-cache'))throw new Error('Refresh did not revalidate HTTP cache');
    return new Response(JSON.stringify([{tag_name:'v1.0.'+count,published_at:'2026-10-22T00:00:00Z'}]));
  };`);
  const client=new McpClient([process.execPath,"--import",pathToFileURL(preload).href,path.join(ROOT,"mcp/settings.mjs")],f.root,f.env,10);f.clients.push(client);await client.initialize();
  await assert.rejects(client.call("settings.versions",{component:"bsl-ls"}),/пустую страницу/);
  const first=(await client.call("settings.versions",{component:"bsl-ls"})).structuredContent;
  assert.equal(first.versions[0].version,"v1.0.4");assert.equal(first.latest,"v1.0.7");
  assert.deepEqual((await client.call("settings.versions",{component:"bsl-ls"})).structuredContent,first);
  const refreshed=(await client.call("settings.versions",{component:"bsl-ls",refresh:true})).structuredContent;
  assert.equal(refreshed.versions[0].version,"v1.0.5");
  const snapshot=(await client.call("settings.read",{})).structuredContent;
  assert.deepEqual(snapshot.installedVersions,{"code-index":null,"bsl-ls":null});
  assert.equal(fs.existsSync(path.join(f.state,"runtime-lock.json")),false);
});

test("update check contacts only the selected component and preserves the explicit all-components API", async t => {
  const f=fixture(t);environment(t,f.env);f.save();
  dump({mcp:{managed:{"code-index":{enabled:true},"bsl-ls":{enabled:true}}}},f.env.EDT_AI_SETTINGS);
  const urls=[];t.mock.method(globalThis,"fetch",async url=>{urls.push(String(url));return new Response(JSON.stringify({tag_name:"v9.0.0",draft:false,prerelease:false}));});
  const backend=new SettingsBackend();
  for(const component of ["code-index","bsl-ls"]){
    urls.length=0;const result=await backend.main({action:"updates",operation:"check",component});
    assert.deepEqual(result.components.map(item=>item.component),[component]);
    assert.equal(result.components[0].state,"update_available");assert.equal(urls.length,1);
    assert.match(urls[0],component==="bsl-ls"?/\/bsl-language-server\//:/\/code-index-mcp\//);
  }
  urls.length=0;const all=await backend.main({action:"updates",operation:"check"});
  assert.deepEqual(all.components.map(item=>item.component),["code-index","bsl-ls"]);assert.equal(urls.length,2);
  urls.length=0;await assert.rejects(backend.main({action:"updates",operation:"check",component:"unknown"}),/Выберите компонент/);
  for(const operation of ["check","download","apply","rollback"])
    await assert.rejects(backend.main({action:"updates",operation,component:"bsl-ls",version:"v2.0.0"}),/только для установки/);
  assert.equal(urls.length,0);assert.equal(fs.existsSync(path.join(f.state,"runtime-lock.json")),false);
});

test("release settings are shared, typed, and independently select releases for both components", async t => {
  const f=fixture(t);environment(t,f.env);f.save();
  dump({mcp:{managed:{"bsl-ls":{enabled:true}}}},f.env.EDT_AI_SETTINGS);
  const backend=new SettingsBackend(), before=settings(f.env.EDT_AI_SETTINGS);
  const result=await backend.main({action:"update",set:{codeIndexAllowPrerelease:true,bslLsVersion:"v1.1.0-rc.7"}});
  assert.equal(result.values.codeIndexAllowPrerelease,true);assert.equal(result.values.bslLsVersion,"v1.1.0-rc.7");
  const stored=settings(f.env.EDT_AI_SETTINGS);
  assert.deepEqual(stored.mcp.managed["code-index"],{...before.mcp.managed["code-index"],allow_prerelease:true});
  assert.deepEqual(stored.mcp.managed["bsl-ls"],{...before.mcp.managed["bsl-ls"],version:"v1.1.0-rc.7"});
  const urls=[];t.mock.method(globalThis,"fetch",async url=>{
    urls.push(String(url));const release={tag_name:"v1.1.0-rc.7",draft:false,prerelease:true};
    return new Response(JSON.stringify(String(url).includes("?per_page=")?[release]:release));
  });
  const checked=await backend.main({action:"updates",operation:"check"});
  assert.ok(checked.components.every(item=>item.latest==="v1.1.0-rc.7"));
  assert.match(urls[0],/code-index-mcp\/releases\?per_page=100$/);
  assert.match(urls[1],/bsl-language-server\/releases\/tags\/v1\.1\.0-rc\.7$/);
  for(const set of [{codeIndexAllowPrerelease:"true"},{bslLsAllowPrerelease:1},{codeIndexVersion:"../bad"},{bslLsVersion:""}])
    await assert.rejects(backend.main({action:"update",set}));
  assert.deepEqual(settings(f.env.EDT_AI_SETTINGS).mcp.managed,stored.mcp.managed);
  assert.equal(fs.existsSync(path.join(f.state,"runtime-lock.json")),false);
});
