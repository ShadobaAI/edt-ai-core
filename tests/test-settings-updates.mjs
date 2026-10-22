import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { fixture, environment, session } from "./helpers.mjs";
import { dump } from "../scripts/common.mjs";
import { SettingsBackend } from "../scripts/settings_backend.mjs";
import { settings } from "../scripts/common.mjs";

test("the settings MCP exposes an app-only read-only catalog for both components", async t => {
  const f=fixture(t),client=await session(t,"mcp/settings.mjs",[],f);
  const tool=(await client.request("tools/list")).tools.find(item=>item.name==="settings.versions");
  assert.ok(tool);assert.equal(tool.annotations.readOnlyHint,true);assert.deepEqual(tool._meta.ui.visibility,["app"]);
  assert.deepEqual(tool.inputSchema.properties.component.enum,["code-index","bsl-ls"]);
  await assert.rejects(client.call("settings.versions",{component:"unknown"}));
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
