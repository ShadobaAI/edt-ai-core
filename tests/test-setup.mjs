import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { edt_fixture as fixture, ROOT, environment } from "./helpers.mjs";
import { McpClient } from "../scripts/mcp_client.mjs";
import { parse } from "../scripts/common.mjs";
import { core_version } from "../scripts/compatibility.mjs";
import { SettingsOperations } from "../mcp/settings-operations.mjs";
import { alive } from "../scripts/processes.mjs";

test("background readiness and foreground saves retain independent operation results", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const operations = new SettingsOperations(async action => { if (action === "refresh_readiness") await gate; return { action }; });
  const background = operations.start("refresh_readiness", {}, {});
  await operations.execute("update", {}, {});
  assert.equal(operations.status().id, background.id);
  release(); await operations.wait(background.id, 10000);
  assert.equal(operations.status().id, background.id);
  assert.equal(operations.status().status, "completed");
});

test("daemon maintenance forwards direct backend progress to its operation", async t => {
  const f = fixture(t); f.save();
  const fake = path.join(f.base, "progress-backend.mjs"), preload = path.join(f.base, "progress-preload.mjs");
  fs.writeFileSync(fake, `process.stdin.resume(); process.stdin.on('end',()=>{
    process.send({type:'progress',progress:{phase:'indexing',total:1,completed:0}});
    setTimeout(()=>{console.log(JSON.stringify({ok:true,result:{state:'ready'}}));process.disconnect();},800);
  });`);
  fs.writeFileSync(preload, `import cp from 'node:child_process'; import path from 'node:path'; import {syncBuiltinESMExports} from 'node:module';
    const spawn=cp.spawn; cp.spawn=(command,args,options)=>path.basename(args?.[0]||'')==='settings_backend.mjs'
      ? spawn(command,[${JSON.stringify(fake)}],options) : spawn(command,args,options); syncBuiltinESMExports();`);
  const client = new McpClient([process.execPath, path.join(ROOT, "mcp/settings.mjs")], f.root,
    { ...f.env, NODE_OPTIONS: "--import " + pathToFileURL(preload).href }, 10);
  f.clients.push(client); await client.initialize();
  const authorization = { scope: f.root + "#first", effects: ["launch"], evidence: "fixture authorization" };
  const job = (await client.call("settings.restart_index", { authorization })).structuredContent;
  let progress;
  for (let i = 0; i < 40 && !progress; i++) {
    const current = (await client.call("settings.operation", { operationId: job.id, waitMs: 50 })).structuredContent;
    progress = current.progress; if (current.status !== "running") break;
  }
  assert.equal(progress?.phase, "indexing");
  const done = (await client.call("settings.operation", { operationId: job.id, waitMs: 5000 })).structuredContent;
  assert.equal(done.status, "completed");
});

test("a direct backend receives the index observation response", { timeout: 15000 }, async t => {
  const f = fixture(t); f.save();
  const fake = path.join(f.base, "direct-observer-backend.mjs"), preload = path.join(f.base, "direct-observer-preload.mjs");
  fs.writeFileSync(fake, `import {randomUUID} from 'node:crypto'; let text='';
    process.stdin.on('data', chunk=>text+=chunk); process.stdin.on('end',()=>{const input=JSON.parse(text),root=process.env.EDT_AI_PROJECT_ROOT;
      process.on('message',message=>{if(message.type!=='index_observation_result')return; console.log(JSON.stringify({ok:true,result:{projectRoot:root,componentChecks:[],managed:[],external:{},ipcResponse:message.ok===false}}));process.disconnect();});
      process.send({type:'index_observation',token:input._indexObserverToken,id:randomUUID(),root,config:{active_project:root},profile:{},snapshot:{}});
    });`);
  fs.writeFileSync(preload, `import cp from 'node:child_process'; import path from 'node:path'; import {syncBuiltinESMExports} from 'node:module';
    if(path.basename(process.argv[1]||'')==='settings.mjs') Object.defineProperty(process,'platform',{value:'darwin'});
    const spawn=cp.spawn; cp.spawn=(command,args,options)=>path.basename(args?.[0]||'')==='settings_backend.mjs'
      ? spawn(command,[${JSON.stringify(fake)}],options) : spawn(command,args,options); syncBuiltinESMExports();`);
  const client = new McpClient([process.execPath, path.join(ROOT, "mcp/settings.mjs")], f.root,
    { ...f.env, NODE_OPTIONS: "--import " + pathToFileURL(preload).href }, 10);
  f.clients.push(client); await client.initialize();
  const job = (await client.call("settings.refresh_readiness", { scope: f.root + "#first", component: "code-index" })).structuredContent;
  const done = (await client.call("settings.operation", { operationId: job.id, waitMs: 10000 })).structuredContent;
  assert.equal(done.status, "completed", JSON.stringify(done)); assert.equal(done.result.ipcResponse, true);
});

test("an oversized settings backend response is stopped and not copied into the error", { timeout: 20000, skip: process.platform === "darwin" }, async t => {
  const f = fixture(t); f.save();
  const fake = path.join(f.base, "oversized-backend.mjs"), preload = path.join(f.base, "oversized-preload.mjs");
  fs.writeFileSync(fake, `process.stdin.resume(); process.stdin.on('end',()=>{const chunk='synthetic-private-output-'+'x'.repeat(1024*1024);
    for(let i=0;i<33;i++)process.stdout.write(chunk); process.stdout.end();});`);
  fs.writeFileSync(preload, `import cp from 'node:child_process'; import path from 'node:path'; import {syncBuiltinESMExports} from 'node:module';
    const spawn=cp.spawn; cp.spawn=(command,args,options)=>path.basename(args?.[0]||'')==='process_supervisor.mjs'
      ? spawn(command,['--import',import.meta.url,...args],options)
      : path.basename(args?.[0]||'')==='settings_backend.mjs' ? spawn(command,[${JSON.stringify(fake)}],options) : spawn(command,args,options);
    syncBuiltinESMExports();`);
  const client = new McpClient([process.execPath, path.join(ROOT, "mcp/settings.mjs")], f.root,
    { ...f.env, NODE_OPTIONS: "--import " + pathToFileURL(preload).href }, 10);
  f.clients.push(client); await client.initialize();
  const result = await client.call("settings.read", {});
  assert.equal(result.structuredContent.profile.status, "invalid");
  assert.match(result.structuredContent.profile.detail, /превысил допустимый размер/);
  const log = fs.readFileSync(path.join(f.state, "diagnostics", "events.0.jsonl"), "utf8");
  assert.match(log, /output_limit/); assert.doesNotMatch(log + JSON.stringify(result), /synthetic-private-output/);
});

test("observation timeouts stop an unresponsive backend and its detached child", { timeout: 30000, skip: process.platform === "darwin" }, async t => {
  const f = fixture(t); f.save();
  const fake = path.join(f.base, "hung-observation-backend.mjs"), preload = path.join(f.base, "hung-observation-preload.mjs");
  fs.writeFileSync(fake, `import fs from 'node:fs'; import path from 'node:path'; import {spawn} from 'node:child_process'; let text='';
    process.stdin.on('data',part=>text+=part); process.stdin.on('end',()=>{const action=JSON.parse(text).action;
      const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});process.send("ready");setTimeout(()=>process.exit(0),20000);setInterval(()=>{},1000)'],
        {detached:true,stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
      child.once('message',()=>fs.writeFileSync(path.join(${JSON.stringify(f.base)},action+'.json'),JSON.stringify([process.pid,child.pid])));
    }); process.on('SIGTERM',()=>{}); setTimeout(()=>process.exit(0),20000); setInterval(()=>{},1000);`);
  fs.writeFileSync(preload, `import cp from 'node:child_process'; import path from 'node:path'; import {syncBuiltinESMExports} from 'node:module';
    if(path.basename(process.argv[1]||'')==='settings.mjs'){const original=setTimeout;globalThis.setTimeout=(fn,ms,...args)=>original(fn,ms===120000?3000:ms,...args);}
    const spawn=cp.spawn; cp.spawn=(command,args,options)=>path.basename(args?.[0]||'')==='process_supervisor.mjs'
      ? spawn(command,['--import',import.meta.url,...args],options)
      : path.basename(args?.[0]||'')==='settings_backend.mjs' ? spawn(command,[${JSON.stringify(fake)}],options) : spawn(command,args,options);
    syncBuiltinESMExports();`);
  const client = new McpClient([process.execPath, path.join(ROOT, "mcp/settings.mjs")], f.root,
    { ...f.env, NODE_OPTIONS: "--import " + pathToFileURL(preload).href }, 15);
  f.clients.push(client); await client.initialize();
  for (const [tool, action, args] of [
    ["settings.refresh_readiness", "refresh_readiness", { scope: f.root + "#first", component: "bsl-ls" }],
    ["settings.probe_connections", "probe", { component: "bsl-ls" }],
  ]) {
    const job = (await client.call(tool, args)).structuredContent, pidFile = path.join(f.base, action + ".json");
    for (let i = 0; i < 250 && !fs.existsSync(pidFile); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(fs.existsSync(pidFile), "the backend and detached child must both have started");
    const pids = JSON.parse(fs.readFileSync(pidFile, "utf8")); assert.ok(pids.every(alive));
    const done = (await client.call("settings.operation", { operationId: job.id, waitMs: 10000 })).structuredContent;
    assert.equal(done.status, "failed", JSON.stringify(done)); assert.match(done.error, /Истекло время проверки/);
    assert.ok(pids.every(pid => !alive(pid)), "timed-out owned processes must be gone before the operation finishes");
  }
});

test("an observation timeout reports unconfirmed backend cleanup", { timeout: 15000, skip: process.platform === "darwin" }, async t => {
  const f = fixture(t); f.save();
  const fake = path.join(f.base, "unresponsive-supervisor.mjs"), preload = path.join(f.base, "unresponsive-supervisor-preload.mjs");
  const pidFile = path.join(f.base, "unresponsive-supervisor.pid");
  // This deliberately ignores stop requests and exits on its own, so the test
  // can verify the failure path without leaving a process behind.
  fs.writeFileSync(fake, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
    process.stdin.resume(); process.on('message',()=>{}); setTimeout(()=>process.exit(0),8500);`);
  fs.writeFileSync(preload, `import cp from 'node:child_process'; import path from 'node:path'; import {syncBuiltinESMExports} from 'node:module';
    if(path.basename(process.argv[1]||'')==='settings.mjs'){const original=setTimeout;globalThis.setTimeout=(fn,ms,...args)=>original(fn,ms===120000?1000:ms,...args);}
    const spawn=cp.spawn; cp.spawn=(command,args,options)=>path.basename(args?.[0]||'')==='process_supervisor.mjs'
      ? spawn(command,[${JSON.stringify(fake)}],options) : spawn(command,args,options); syncBuiltinESMExports();`);
  const client = new McpClient([process.execPath, path.join(ROOT, "mcp/settings.mjs")], f.root,
    { ...f.env, NODE_OPTIONS: "--import " + pathToFileURL(preload).href }, 12);
  f.clients.push(client); await client.initialize();
  const job = (await client.call("settings.refresh_readiness", { scope: f.root + "#first", component: "bsl-ls" })).structuredContent;
  for (let i = 0; i < 200 && !fs.existsSync(pidFile); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(fs.existsSync(pidFile)); const pid = Number(fs.readFileSync(pidFile, "utf8"));
  const done = (await client.call("settings.operation", { operationId: job.id, waitMs: 10000 })).structuredContent;
  assert.equal(done.status, "outcome_unknown", JSON.stringify(done)); assert.match(done.error, /Завершение ресурсов проверки не подтверждено/);
  for (let i = 0; i < 10; i++)
    await assert.rejects(client.call("settings.refresh_readiness", { scope: f.root + "#first", component: "bsl-ls" }), /предыдущей проверки не подтверждено/i);
  const other = new McpClient([process.execPath, path.join(ROOT, "mcp/settings.mjs")], f.root,
    { ...f.env, NODE_OPTIONS: "--import " + pathToFileURL(preload).href }, 10);
  f.clients.push(other); await other.initialize();
  for (let i = 0; i < 10; i++)
    await assert.rejects(other.call("settings.refresh_readiness", { scope: f.root + "#first", component: "bsl-ls" }), /предыдущей проверки готовности.*заблокирована/i);
  assert.equal(Number(fs.readFileSync(pidFile, "utf8")), pid, "retries must not start another supervisor");
  const log = fs.readFileSync(path.join(f.state, "diagnostics", "events.0.jsonl"), "utf8");
  assert.match(log, /backend_process_cleanup_failed/);
  for (let i = 0; i < 500 && alive(pid); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(alive(pid), false);
});

test("a rejected observation does not block a later request from the same backend", { timeout: 12000, skip: process.platform === "darwin" }, async t => {
  const f = fixture(t); f.save();
  const fake = path.join(f.base, "retry-observer-backend.mjs"), preload = path.join(f.base, "retry-observer-preload.mjs");
  fs.writeFileSync(fake, `import path from 'node:path'; import {randomUUID} from 'node:crypto'; let input='';
    process.stdin.on('data',part=>input+=part); process.stdin.on('end',()=>{const token=JSON.parse(input)._indexObserverToken,root=process.env.EDT_AI_PROJECT_ROOT;
      const first=randomUUID(),second=randomUUID(), send=(id,r)=>process.send({type:'index_observation',token,id,root:r,config:{active_project:r},profile:{},snapshot:{}});
      let finished=false; const done=ok=>{if(finished)return;finished=true;console.log(JSON.stringify({ok:true,result:{projectRoot:root,componentChecks:[],managed:[],external:{},secondResponse:ok}}));process.disconnect();};
      process.on('message',m=>{if(m.id===first)send(second,root);else if(m.id===second)done(m.ok===true);});
      send(first,path.join(root,'wrong-project'));setTimeout(()=>done(false),2500).unref();});`);
  fs.writeFileSync(preload, `import cp from 'node:child_process'; import path from 'node:path'; import {syncBuiltinESMExports} from 'node:module';
    if(path.basename(process.argv[1]||'')==='settings.mjs'){const {IndexObserver}=await import(${JSON.stringify(pathToFileURL(path.join(ROOT, "scripts/runtime.mjs")).href)});IndexObserver.prototype.observe=async()=>({ok:true});}
    const spawn=cp.spawn;cp.spawn=(command,args,options)=>path.basename(args?.[0]||'')==='process_supervisor.mjs'
      ? spawn(command,['--import',import.meta.url,...args],options)
      : path.basename(args?.[0]||'')==='settings_backend.mjs' ? spawn(command,[${JSON.stringify(fake)}],options) : spawn(command,args,options);syncBuiltinESMExports();`);
  const client = new McpClient([process.execPath, path.join(ROOT, "mcp/settings.mjs")], f.root,
    { ...f.env, NODE_OPTIONS: "--import " + pathToFileURL(preload).href }, 10);
  f.clients.push(client); await client.initialize();
  const job = (await client.call("settings.refresh_readiness", { scope: f.root + "#first", component: "code-index" })).structuredContent;
  const done = (await client.call("settings.operation", { operationId: job.id, waitMs: 10000 })).structuredContent;
  assert.equal(done.status, "completed", JSON.stringify(done)); assert.equal(done.result.secondResponse, true);
});

test("an observation cancellation waits for observer cleanup and reports its failure", { timeout: 12000, skip: process.platform === "darwin" }, async t => {
  const f = fixture(t); f.save();
  const fake = path.join(f.base, "cancel-observer-backend.mjs"), preload = path.join(f.base, "cancel-observer-preload.mjs"), started = path.join(f.base, "observer-started");
  fs.writeFileSync(fake, `import fs from 'node:fs'; import {randomUUID} from 'node:crypto'; let input='';
    process.stdin.on('data',part=>input+=part);process.stdin.on('end',()=>{const token=JSON.parse(input)._indexObserverToken,root=process.env.EDT_AI_PROJECT_ROOT,id=randomUUID();
      process.on('message',m=>{if(m.id!==id)return;console.log(JSON.stringify({ok:true,result:{projectRoot:root,componentChecks:[],managed:[],external:{}}}));process.disconnect();});
      process.send({type:'index_observation',token,id,root,config:{active_project:root},profile:{},snapshot:{}});
      const poll=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(started)}))return;clearInterval(poll);process.send({type:'index_observation_cancel',token,id});},20);
      setTimeout(()=>process.exit(2),8000).unref();});`);
  fs.writeFileSync(preload, `import cp from 'node:child_process'; import path from 'node:path'; import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    if(path.basename(process.argv[1]||'')==='settings.mjs'){const {IndexObserver}=await import(${JSON.stringify(pathToFileURL(path.join(ROOT, "scripts/runtime.mjs")).href)});let fail;
      IndexObserver.prototype.observe=()=>new Promise((_,reject)=>{fail=reject;fs.writeFileSync(${JSON.stringify(started)},'started');});
      IndexObserver.prototype.close=()=>{fail(new Error('observation cancelled'));return new Promise((_,reject)=>setTimeout(()=>reject(new Error('forced observer cleanup failure')),1000));};}
    const spawn=cp.spawn;cp.spawn=(command,args,options)=>path.basename(args?.[0]||'')==='process_supervisor.mjs'
      ? spawn(command,['--import',import.meta.url,...args],options)
      : path.basename(args?.[0]||'')==='settings_backend.mjs' ? spawn(command,[${JSON.stringify(fake)}],options) : spawn(command,args,options);syncBuiltinESMExports();`);
  const client = new McpClient([process.execPath, path.join(ROOT, "mcp/settings.mjs")], f.root,
    { ...f.env, NODE_OPTIONS: "--import " + pathToFileURL(preload).href }, 10);
  f.clients.push(client); await client.initialize();
  const job = (await client.call("settings.refresh_readiness", { scope: f.root + "#first", component: "code-index" })).structuredContent;
  const done = (await client.call("settings.operation", { operationId: job.id, waitMs: 10000 })).structuredContent;
  assert.equal(done.status, "outcome_unknown", JSON.stringify(done)); assert.match(done.error, /Завершение ресурсов проверки не подтверждено/);
  const log = fs.readFileSync(path.join(f.state, "diagnostics", "events.0.jsonl"), "utf8");
  assert.match(log, /index_observer_cleanup_failed/); assert.match(log, /backend_cleanup_unconfirmed/);
});

test("a reader cleanup failure cannot become a completed observation", { timeout: 10000, skip: process.platform === "darwin" }, async t => {
  const f = fixture(t); f.save();
  const fake = path.join(f.base, "failed-reader-backend.mjs"), preload = path.join(f.base, "failed-reader-preload.mjs");
  fs.writeFileSync(fake, `import {randomUUID} from 'node:crypto';let text='';process.stdin.on('data',part=>text+=part);process.stdin.on('end',()=>{
    const token=JSON.parse(text)._indexObserverToken,root=process.env.EDT_AI_PROJECT_ROOT,id=randomUUID();
    process.on('message',m=>{if(m.id!==id)return;console.log(JSON.stringify({ok:true,result:{projectRoot:root,componentChecks:[],managed:[],external:{}}}));process.disconnect();});
    process.send({type:'index_observation',token,id,root,config:{active_project:root},profile:{},snapshot:{}});});`);
  fs.writeFileSync(preload, `import cp from 'node:child_process';import path from 'node:path';import {syncBuiltinESMExports} from 'node:module';
    if(path.basename(process.argv[1]||'')==='settings.mjs'){const {IndexObserver}=await import(${JSON.stringify(pathToFileURL(path.join(ROOT, "scripts/runtime.mjs")).href)});
      IndexObserver.prototype.observe=async function(){this.cleanupError=Object.assign(new Error('fixture reader cleanup failure'),{outcomeUnknown:true});throw this.cleanupError;};
      IndexObserver.prototype.close=async function(){throw this.cleanupError;};}
    const spawn=cp.spawn;cp.spawn=(command,args,options)=>path.basename(args?.[0]||'')==='process_supervisor.mjs'
      ? spawn(command,['--import',import.meta.url,...args],options)
      : path.basename(args?.[0]||'')==='settings_backend.mjs' ? spawn(command,[${JSON.stringify(fake)}],options) : spawn(command,args,options);syncBuiltinESMExports();`);
  const client = new McpClient([process.execPath, path.join(ROOT, "mcp/settings.mjs")], f.root,
    { ...f.env, NODE_OPTIONS: "--import " + pathToFileURL(preload).href }, 10);
  f.clients.push(client); await client.initialize();
  const job = (await client.call("settings.refresh_readiness", { scope: f.root + "#first", component: "code-index" })).structuredContent;
  const done = (await client.call("settings.operation", { operationId: job.id, waitMs: 10000 })).structuredContent;
  assert.equal(done.status, "outcome_unknown", JSON.stringify(done));
  const log = fs.readFileSync(path.join(f.state, "diagnostics", "events.0.jsonl"), "utf8");
  assert.match(log, /index_observer_cleanup_failed/); assert.match(log, /backend_cleanup_unconfirmed/);
});

test("an unresponsive observer bounds both operation and session shutdown", { timeout: 12000, skip: process.platform === "darwin" }, async t => {
  const f = fixture(t); f.save();
  const fake = path.join(f.base, "hanging-observer-backend.mjs"), preload = path.join(f.base, "hanging-observer-preload.mjs"), started = path.join(f.base, "hanging-observer-started");
  fs.writeFileSync(fake, `import fs from 'node:fs'; import {randomUUID} from 'node:crypto'; let input='';
    process.stdin.on('data',part=>input+=part);process.stdin.on('end',()=>{const token=JSON.parse(input)._indexObserverToken,root=process.env.EDT_AI_PROJECT_ROOT,id=randomUUID();
      process.send({type:'index_observation',token,id,root,config:{active_project:root},profile:{},snapshot:{}});
      const poll=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(started)}))return;clearInterval(poll);
        console.log(JSON.stringify({ok:true,result:{projectRoot:root,componentChecks:[],managed:[],external:{}}}));process.disconnect();},20);
      setTimeout(()=>process.exit(2),8000).unref();});`);
  fs.writeFileSync(preload, `import cp from 'node:child_process'; import path from 'node:path'; import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    if(path.basename(process.argv[1]||'')==='settings.mjs'){const original=setTimeout;globalThis.setTimeout=(fn,ms,...args)=>original(fn,ms===12000?1200:ms,...args);
      const {IndexObserver}=await import(${JSON.stringify(pathToFileURL(path.join(ROOT, "scripts/runtime.mjs")).href)});
      IndexObserver.prototype.observe=()=>{fs.writeFileSync(${JSON.stringify(started)},'started');return new Promise(()=>{});};
      IndexObserver.prototype.close=()=>{setInterval(()=>{},1000);return new Promise(()=>{});};}
    const spawn=cp.spawn;cp.spawn=(command,args,options)=>path.basename(args?.[0]||'')==='process_supervisor.mjs'
      ? spawn(command,['--import',import.meta.url,...args],options)
      : path.basename(args?.[0]||'')==='settings_backend.mjs' ? spawn(command,[${JSON.stringify(fake)}],options) : spawn(command,args,options);syncBuiltinESMExports();`);
  const client = new McpClient([process.execPath, path.join(ROOT, "mcp/settings.mjs")], f.root,
    { ...f.env, NODE_OPTIONS: "--import " + pathToFileURL(preload).href }, 10);
  f.clients.push(client); await client.initialize();
  const job = (await client.call("settings.refresh_readiness", { scope: f.root + "#first", component: "code-index" })).structuredContent;
  const done = (await client.call("settings.operation", { operationId: job.id, waitMs: 10000 })).structuredContent;
  assert.equal(done.status, "outcome_unknown", JSON.stringify(done)); assert.match(done.error, /Завершение ресурсов проверки не подтверждено/);
  await client.close({ grace: 4000 });
  assert.equal(client.process.exitCode, 1, "the settings supervisor must report failed session cleanup");
  const log = fs.readFileSync(path.join(f.state, "diagnostics", "events.0.jsonl"), "utf8");
  assert.match(log, /index_observer_cleanup_failed/); assert.match(log, /session_cleanup_failed|session_cleanup_timeout/);
});

test("switching projects bounds observer cleanup and keeps the reader barrier", { timeout: 12000, skip: process.platform === "darwin" }, async t => {
  const f = fixture(t); f.save();
  const other = path.join(f.base, "Other"); fs.mkdirSync(other);
  const fake = path.join(f.base, "project-switch-backend.mjs"), preload = path.join(f.base, "project-switch-preload.mjs");
  fs.writeFileSync(fake, `import {randomUUID} from 'node:crypto';let text='';process.stdin.on('data',part=>text+=part);process.stdin.on('end',()=>{
    const input=JSON.parse(text),root=process.env.EDT_AI_PROJECT_ROOT;
    if(input.action==='read'){console.log(JSON.stringify({ok:true,result:{values:{projectRoot:root},profile:{status:'loaded'}}}));return;}
    const token=input._indexObserverToken,id=randomUUID();process.on('message',m=>{if(m.id!==id)return;
      console.log(JSON.stringify({ok:true,result:{projectRoot:root,componentChecks:[],managed:[],external:{}}}));process.disconnect();});
    process.send({type:'index_observation',token,id,root,config:{active_project:root},profile:{},snapshot:{}});});`);
  fs.writeFileSync(preload, `import cp from 'node:child_process';import path from 'node:path';import {syncBuiltinESMExports} from 'node:module';
    if(path.basename(process.argv[1]||'')==='settings.mjs'){const original=setTimeout;globalThis.setTimeout=(fn,ms,...args)=>original(fn,ms===12000?1200:ms,...args);
      const {IndexObserver}=await import(${JSON.stringify(pathToFileURL(path.join(ROOT, "scripts/runtime.mjs")).href)});
      IndexObserver.prototype.observe=async()=>({ok:true});IndexObserver.prototype.close=()=>{setInterval(()=>{},1000);return new Promise(()=>{});};}
    const spawn=cp.spawn;cp.spawn=(command,args,options)=>path.basename(args?.[0]||'')==='process_supervisor.mjs'
      ? spawn(command,['--import',import.meta.url,...args],options)
      : path.basename(args?.[0]||'')==='settings_backend.mjs' ? spawn(command,[${JSON.stringify(fake)}],options) : spawn(command,args,options);syncBuiltinESMExports();`);
  const client = new McpClient([process.execPath, path.join(ROOT, "mcp/settings.mjs")], f.root,
    { ...f.env, EDT_AI_PROJECT_ROOT: "", NODE_OPTIONS: "--import " + pathToFileURL(preload).href }, 10);
  const send = client.send.bind(client); let fallbackRoots = true;
  client.send = message => send(fallbackRoots && message.result?.roots ? { id: message.id, error: { code: -32601, message: "fixture" } } : message);
  f.clients.push(client); await client.initialize();
  const job = (await client.call("settings.refresh_readiness", { scope: f.root + "#first", component: "code-index" })).structuredContent;
  const done = (await client.call("settings.operation", { operationId: job.id, waitMs: 10000 })).structuredContent;
  assert.equal(done.status, "completed", JSON.stringify(done));
  fallbackRoots = false; client.roots = []; client.notify("notifications/roots/list_changed");
  await assert.rejects(client.call("settings.inspect", { projectRoot: other }), /Завершение предыдущего читателя индекса не подтверждено/);
  await assert.rejects(client.call("settings.inspect", { projectRoot: other }), /Завершение предыдущего читателя индекса не подтверждено/);
  await client.close({ grace: 4000 }); assert.equal(client.process.exitCode, 1);
});

async function foregroundCloseFixture(t) {
  const f = fixture(t); f.save();
  const fake = path.join(f.base, "foreground-backend.mjs"), preload = path.join(f.base, "foreground-preload.mjs"), closing = path.join(f.base, "foreground-closing");
  fs.writeFileSync(fake, `process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({ok:true,result:{projectRoot:process.env.EDT_AI_PROJECT_ROOT,componentChecks:[],managed:[],external:{}}})));`);
  fs.writeFileSync(preload, `import cp from 'node:child_process';import path from 'node:path';import fs from 'node:fs';import net from 'node:net';import {syncBuiltinESMExports} from 'node:module';
    if(path.basename(process.argv[1]||'')==='settings.mjs'){const original=setTimeout;globalThis.setTimeout=(fn,ms,...args)=>original(fn,ms===5000?500:ms,...args);
      const close=net.Server.prototype.close;net.Server.prototype.close=function(callback){const address=String(this.address());
        if(address.includes('1c-ai-core-reader-')&&!address.includes('-observe')){fs.writeFileSync(${JSON.stringify(closing)},'closing');return close.call(this,()=>{});}return close.call(this,callback);};}
    const spawn=cp.spawn;cp.spawn=(command,args,options)=>path.basename(args?.[0]||'')==='process_supervisor.mjs'
      ? spawn(command,['--import',import.meta.url,...args],options)
      : path.basename(args?.[0]||'')==='settings_backend.mjs' ? spawn(command,[${JSON.stringify(fake)}],options) : spawn(command,args,options);syncBuiltinESMExports();`);
  const env = { ...f.env, NODE_OPTIONS: "--import " + pathToFileURL(preload).href };
  const client = new McpClient([process.execPath, path.join(ROOT, "mcp/settings.mjs")], f.root, env, 10);
  f.clients.push(client); await client.initialize();
  return { f, client, env, closing };
}

test("an unconfirmed foreground lease blocks checks in this and another session", { timeout: 10000, skip: process.platform === "darwin" }, async t => {
  const { f, client, env } = await foregroundCloseFixture(t);
  const job = (await client.call("settings.probe_connections", { component: "v8std" })).structuredContent;
  const done = (await client.call("settings.operation", { operationId: job.id, waitMs: 10000 })).structuredContent;
  assert.equal(done.status, "outcome_unknown", JSON.stringify(done));
  await assert.rejects(client.call("settings.probe_connections", { component: "v8std" }), /предыдущей проверки не подтверждено/i);
  const other = new McpClient([process.execPath, path.join(ROOT, "mcp/settings.mjs")], f.root, env, 10);
  f.clients.push(other); await other.initialize();
  await assert.rejects(other.call("settings.refresh_readiness", { scope: f.root + "#first", component: "bsl-ls" }), /предыдущей проверки готовности.*заблокирована/i);
  const log = fs.readFileSync(path.join(f.state, "diagnostics", "events.0.jsonl"), "utf8"); assert.match(log, /operation_cleanup_failed/);
  await client.close({ grace: 4000 }); assert.equal(client.process.exitCode, 1);
});

test("session shutdown waits for an active foreground lease and reports cleanup failure", { timeout: 10000, skip: process.platform === "darwin" }, async t => {
  const { client, closing } = await foregroundCloseFixture(t);
  await client.call("settings.probe_connections", { component: "v8std" });
  for (let i = 0; i < 300 && !fs.existsSync(closing); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(fs.existsSync(closing), "foreground cleanup must be in progress");
  await client.close({ grace: 4000 }); assert.equal(client.process.exitCode, 1);
});
import { dump, sleep } from "../scripts/common.mjs";
import { grant_preparation } from "../scripts/components.mjs";
import { read_lines } from "../scripts/mcp_codec.mjs";
import { probe_connections, edt_project_building } from "../scripts/setup_probe.mjs";
import { index_repositories } from "../scripts/directory_context.mjs";
import { settings } from "../scripts/common.mjs";
import { instance_directory } from "../scripts/project_paths.mjs";

async function unbound(t, f, file = "mcp/settings.mjs", args = []) {
  const client = new McpClient([process.execPath, path.join(ROOT, file), ...args], ROOT, { ...f.env, EDT_AI_PROJECT_ROOT: "" }, 10);
  f.clients.push(client); client.roots = []; await client.initialize(); return client;
}

test("chat setup binds only its settings session, reports repairs and needs no reload or source inspection", async t => {
  const f = fixture(t); f.save();
  const a = await unbound(t, f), b = await unbound(t, f);
  const before = fs.readFileSync(path.join(f.root, ".ai/project.yaml"));
  const view = (await a.call("settings.inspect", { projectRoot: f.root })).structuredContent;
  assert.equal(view.profile.status, "loaded");
  assert.equal(view.projectRoot, f.root);
  const full = await a.call("settings.read", {});
  const compact = await a.call("settings.inspect", {});
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) < Buffer.byteLength(JSON.stringify(full)) * 0.75);
  assert.deepEqual(view.nextSteps, ["configure_connections", "prepare_managed_with_authorization"]);
  assert.equal((await b.call("settings.inspect", {})).structuredContent.projectRoot, "");
  assert.deepEqual(fs.readdirSync(f.state).filter(name => name !== "diagnostics"), []);
  assert.deepEqual(fs.readFileSync(path.join(f.root, ".ai/project.yaml")), before);
  const other = path.join(f.base, "other"); fs.mkdirSync(other);
  await assert.rejects(a.call("settings.inspect", { projectRoot: other }), /закреплён/);
  f.profile.compatibility.core = ">=0.1.0 <0.2.0"; f.save();
  const invalid = (await a.call("settings.inspect", {})).structuredContent;
  assert.equal(invalid.profile.status, "invalid");
  assert.equal(invalid.profile.compatibility.core, ">=0.1.0 <0.2.0");
  assert.deepEqual(invalid.nextSteps, ["repair_profile"]);
  const edit = (await a.call("settings.edit", { layerScope: "profile", format: "yaml" })).structuredContent;
  const data = parse(edit.text); data.compatibility.core = `=${core_version}`;
  const request = { text: JSON.stringify(data), mode: "layer", layerScope: "profile", baseRevision: edit.baseRevision };
  const preview = (await a.call("settings.preview", request)).structuredContent;
  await a.call("settings.apply", { ...request, revision: preview.revision, replace: true });
  assert.equal((await a.call("settings.inspect", {})).structuredContent.profile.status, "loaded");
  a.roots = [{ uri: pathToFileURL(other).href }]; a.notify("notifications/roots/list_changed");
  assert.equal((await a.call("settings.inspect", {})).structuredContent.projectRoot, other);
  await assert.rejects(a.call("settings.inspect", { projectRoot: f.root }), /закреплён/);
});

test("invalid profile shapes remain inspectable and host selection cannot be overridden", async t => {
  const f = fixture(t); f.save();
  fs.writeFileSync(path.join(f.root, ".ai/project.yaml"), "repositories: [null, text]\n");
  const client = await unbound(t, f);
  const view = (await client.call("settings.inspect", { projectRoot: f.root })).structuredContent;
  assert.equal(view.profile.status, "invalid"); assert.deepEqual(view.nextSteps, ["repair_profile"]);
  const locked = new McpClient([process.execPath, path.join(ROOT, "mcp/settings.mjs")], f.root, f.env, 10);
  f.clients.push(locked); await locked.initialize();
  await assert.rejects(locked.call("settings.inspect", { projectRoot: f.state }), /закреплён/);
});

test("readiness inspection and operation polling return data without settings UI or runtime preparation", async t => {
  const f = fixture(t); f.save();
  const client = await unbound(t, f);
  const tools = (await client.request("tools/list")).tools;
  for (const name of ["settings.inspect", "settings.check", "settings.probe_connections", "settings.run_check", "settings.operation", "settings.create", "settings.load"])
    assert.equal(tools.find(tool => tool.name === name)._meta.ui.resourceUri, undefined, name);
  const checked = (await client.call("settings.check", { projectRoot: f.root })).structuredContent;
  assert.equal(checked.profile.status, "loaded");
  assert.deepEqual(checked.nextSteps, ["configure_connections", "prepare_managed_with_authorization"]);
  assert.equal(checked.mode, undefined);
  assert.equal((await client.call("settings.operation", {})).structuredContent.status, "idle");
  assert.deepEqual(fs.readdirSync(f.state).filter(name => name !== "diagnostics"), []);
  const other = path.join(f.base, "other"); fs.mkdirSync(other);
  await assert.rejects(client.call("settings.check", { projectRoot: other }), /закреплён/);
});

async function endpoint(t, root, getProjects = () => [{ name: "Product", path: root, open: true, state: "ready", edtProject: true }]) {
  const calls = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const part of request) body += part;
    if (!body) { response.writeHead(202).end(); return; }
    const message = JSON.parse(body); calls.push(message.method);
    const reply = result => response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    if (message.method === "server/discover") { response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "legacy" } })); return; }
    if (message.method === "initialize") return reply({ protocolVersion: "2025-11-25", serverInfo: { name: "fixture", version: "1" }, capabilities: { tools: {} } });
    if (message.method.startsWith("notifications/")) { response.writeHead(202).end(); return; }
    if (message.method === "tools/list") return reply({ tools: [{ name: "list_projects", inputSchema: { type: "object", properties: { format: { type: "string", enum: ["json"] } } } }] });
    if (message.method === "tools/call") return reply({ content: [], structuredContent: { projects: getProjects() } });
    reply({});
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise(done => server.close(done)); });
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, calls };
}

test("empty host roots can bind a relay without spawning substitutes or changing another session", async t => {
  const f = fixture(t), upstream = await endpoint(t, f.root); f.profile.connections = { edt: { url: upstream.url } }; f.save();
  const a = await unbound(t, f, "scripts/lazy_mcp.mjs", ["--component", "edt"]);
  const b = await unbound(t, f, "scripts/lazy_mcp.mjs", ["--component", "edt"]);
  assert.equal((await a.call("core_runtime_status", {})).structuredContent.selectedDirectory, null);
  const result = await a.call("core_runtime_status", { projectRoot: f.root });
  assert.equal(result.structuredContent.ready, true);
  assert.equal(result.structuredContent.selectionSource, "argument");
  assert.ok(result.content[0].text.length < JSON.stringify(result.structuredContent).length);
  assert.equal((await b.call("core_runtime_status", {})).structuredContent.selectedDirectory, null);
  await assert.rejects(a.call("core_runtime_status", { projectRoot: f.state }), /закреплён/);
  a.roots = []; a.notify("notifications/roots/list_changed");
  assert.equal((await a.call("core_runtime_status", {})).structuredContent.selectedDirectory, null);
});

test("one bounded setup probe verifies external connections and refuses a wrong EDT path", async t => {
  const f = fixture(t), upstream = await endpoint(t, f.root);
  f.profile.connections = { edt: { url: upstream.url }, v8std: { url: upstream.url } }; f.save();
  const profileBefore = fs.readFileSync(path.join(f.root, ".ai/project.yaml"));
  const client = await unbound(t, f); await client.call("settings.inspect", { projectRoot: f.root });
  const run = async () => {
    const operation = (await client.call("settings.probe_connections", {})).structuredContent;
    const completed = (await client.call("settings.operation", { operationId: operation.id, waitMs: 10000 })).structuredContent;
    assert.equal(completed.status, "completed"); return completed.result;
  };
  const result = await run();
  assert.equal(result.external.edt.projectReadiness, "verified");
  assert.equal(result.external.v8std.connected, true);
  assert.equal(result.fullReadiness, "not_verified");
  assert.equal(result.chatRelay, "not_verified");
  assert.match(result.detail, /каталог инструментов/i);
  assert.equal(upstream.calls.filter(name => name === "tools/call").length, 1);
  assert.deepEqual(fs.readdirSync(f.state).filter(name => name !== "diagnostics"), ["projects"]);
  assert.deepEqual(fs.readFileSync(path.join(f.root, ".ai/project.yaml")), profileBefore);
  assert.equal(fs.existsSync(f.env.EDT_AI_SETTINGS), false);
  assert.equal(fs.existsSync(path.join(f.state, "runtime-lock.json")), false);
  const receiptDirectory = instance_directory(f.state, f.root);
  assert.deepEqual(fs.readdirSync(receiptDirectory).sort(), ["first.readiness-observations.json", "first.readiness.json"]);
  const observationFile = path.join(receiptDirectory, "first.readiness-observations.json");
  const observations = JSON.parse(fs.readFileSync(observationFile, "utf8"));
  assert.deepEqual(Object.keys(observations).sort(), ["components", "version"]);
  assert.equal(observations.version, 1);
  assert.deepEqual(Object.keys(observations.components).sort(), ["edt", "openviking", "v8std"]);
  assert.equal(new Set(Object.values(observations.components)).size, 1);
  assert.match(observations.components.edt, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  const receipt = JSON.parse(fs.readFileSync(path.join(receiptDirectory, "first.readiness.json"), "utf8"));
  assert.deepEqual(Object.keys(receipt.components).sort(), ["edt", "v8std"]);
  assert.equal(receipt.result, undefined, "external probes do not assert full setup readiness");
  f.profile.repositories[0].path = "src"; f.save();
  assert.equal((await run()).external.edt.repositories[0].matched, false);
  const repeated = JSON.parse(fs.readFileSync(observationFile, "utf8"));
  assert.deepEqual(Object.keys(repeated.components).sort(), Object.keys(observations.components).sort());
  assert.notEqual(repeated.components.edt, observations.components.edt, "a new probe replaces bounded component tickets instead of accumulating sessions");
  await assert.rejects(client.call("settings.operation", { waitMs: 10001 }), /диапазона/);
  await assert.rejects(client.call("settings.operation", { waitMs: 0.5 }), /тип/);
});

test("EDT probe matches a nested .project and skips an explicitly unbound feature repository", async t => {
  const f=fixture(t), nested=path.join(f.root,"framework/exts/Product");
  fs.mkdirSync(nested,{recursive:true});fs.mkdirSync(path.join(f.root,"ui"));
  fs.writeFileSync(path.join(nested,".project"),"<projectDescription><name>Different.Internal.Name</name></projectDescription>");
  f.profile.repositories=[{id:"ui",path:"ui",alias:"ui"},{id:"framework",path:"framework",alias:"framework",edt_project:"Product"}];
  f.profile.policy.unbound_edt_repositories=["ui"];
  const upstream=await endpoint(t,nested),config=settings();
  config.mcp.required.edt.url=upstream.url;config.mcp.required.v8std.url=upstream.url;
  const first=await probe_connections(config,f.root,f.profile);
  assert.equal(first.external.edt.projectReadiness,"verified",JSON.stringify(first.external.edt));
  assert.deepEqual(first.external.edt.repositories.map(item=>item.id),["framework"]);
  fs.writeFileSync(path.join(nested,".project"),"<projectDescription><name></name></projectDescription>");
  assert.equal((await probe_connections(config,f.root,f.profile)).external.edt.projectReadiness,"verified");
  const duplicate=path.join(f.root,"framework/other/Product");fs.mkdirSync(duplicate,{recursive:true});
  fs.writeFileSync(path.join(duplicate,".project"),"<projectDescription><name>Another</name></projectDescription>");
  assert.equal((await probe_connections(config,f.root,f.profile)).external.edt.projectReadiness,"not_ready");
  fs.rmSync(path.join(duplicate,".project"));
  fs.rmSync(path.join(nested,".project"));
  const missing=await probe_connections(config,f.root,f.profile);
  assert.equal(missing.external.edt.projectReadiness,"not_ready");
  assert.equal(missing.external.edt.repositories[0].matched,false);
});

test("EDT probe provides one canonical diagnostic per project for ready and unconfirmed states", async t => {
  const f = fixture(t), testRoot = path.join(f.root, "Tests");
  fs.mkdirSync(testRoot); fs.writeFileSync(path.join(testRoot, ".project"), "<projectDescription><name>Tests</name></projectDescription>");
  f.profile.repositories = [{ id: "crm-production", path: ".", alias: "crm-production", edt_project: "Product" },
    { id: "crm-yaxunit", path: "Tests", alias: "crm-yaxunit", edt_project: "Tests" }];
  const product = { name: "Product", path: f.root, open: true, state: "ready", edtProject: true };
  let testProject = { name: "Tests", path: testRoot, open: false, state: "ready", edtProject: true };
  const upstream = await endpoint(t, f.root, () => [product, testProject]), config = settings();
  config.mcp.required.edt.url = upstream.url;
  for (const [patch, expected] of [
    [{ open: false }, "проект не открыт или его состояние открытия не подтверждено"],
    [{ open: true, state: "building" }, "EDT сообщает о сборке проекта"],
    [{ state: "error" }, "готовность проекта EDT не подтверждена"],
    [{ state: "ready", edtProject: false }, "готовность проекта EDT не подтверждена"],
    [{ edtProject: true, path: f.base }, "имя и путь не сопоставлены с проектом EDT"],
    [{ path: testRoot }, "готов"],
  ]) {
    Object.assign(testProject, patch);
    const result = (await probe_connections(config, f.root, f.profile, f.state, "edt")).external.edt;
    const lines = result.detail.split("\n");
    assert.deepEqual(lines.slice(0, 2), ["crm-production: готов", "crm-yaxunit: " + expected]);
    assert.equal(lines.length, testProject.state === "building" ? 3 : 2);
    assert.equal(result.ready, expected === "готов");
    assert.equal(result.projectReadiness, result.ready ? "verified" : "not_ready");
  }
});

test("EDT optionality changes setup requirements without changing actual project readiness or index selection", async t => {
  const f = fixture(t), directory = path.join(f.root, "Tests");
  fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, ".project"), "<projectDescription><name>Tests</name></projectDescription>");
  f.profile.repositories.push({ id: "tests", path: "Tests", alias: "tests", edt_project: "Tests", edt_required: false });
  const product = { name: "Product", path: f.root, open: true, state: "ready", edtProject: true };
  let dependent = { name: "Tests", path: directory, open: false, state: "closed" };
  let projects = () => [product, dependent, { name: "Unassigned", path: f.base, open: true, state: "building" }];
  const upstream = await endpoint(t, f.root, () => projects()), config = settings(); config.mcp.required.edt.url = upstream.url;
  const probe = async () => (await probe_connections(config, f.root, f.profile, f.state, "edt")).external.edt;
  for (const state of ["closed", "ready", "building", "error", "unknown", "not_available"]) for (const nature of [undefined, false, true]) {
    dependent = { name: "Tests", path: directory, open: false, state, ...(nature === undefined ? {} : { edtProject: nature }) };
    const result = await probe(), repo = result.repositories[1];
    assert.equal(result.ready, true, JSON.stringify(dependent));
    assert.equal(result.projectReadiness, "verified");
    assert.deepEqual([repo.matched, repo.required, repo.ready, repo.requirementsMet], [true, false, false, true]);
    assert.equal(edt_project_building(result), false);
    assert.match(result.detail, /tests: необязательный проект закрыт; недоступен для операций/);
    assert.equal(result.failure, undefined);
  }
  assert.deepEqual(index_repositories(f.root, f.profile).map(item => item.id), ["product", "tests"]);
  dependent = { name: "Tests", path: directory, open: true, state: "ready", edtProject: true };
  assert.equal((await probe()).ready, true);
  for (const state of ["building", "error", "unknown", "not_available", "closed"]) {
    dependent.state = state;
    const result = await probe();
    assert.equal(result.ready, false, state); assert.equal(result.repositories[1].requirementsMet, false);
    assert.equal(edt_project_building(result), state === "building");
    assert.equal(result.failure, undefined, "project readiness is distinct from connection or mapping failures");
  }
  dependent.state = "ready";
  for (const nature of [false, undefined]) {
    dependent.edtProject = nature;
    assert.equal((await probe()).ready, false, "open projects still require a confirmed EDT nature");
  }
  for (const required of [undefined, true]) {
    if (required === undefined) delete f.profile.repositories[1].edt_required;
    else f.profile.repositories[1].edt_required = required;
    Object.assign(dependent, { open: false, state: "closed" });
    const result = await probe();
    assert.equal(result.ready, false); assert.equal(result.repositories[1].required, true);
    assert.equal(result.repositories[1].requirementsMet, false);
  }
  f.profile.repositories[1].edt_required = false;
  for (const wrong of [{ ...dependent, name: "Other" }, { ...dependent, path: f.base }, null]) {
    projects = () => [product, ...(wrong ? [wrong] : [])];
    const result = await probe();
    assert.equal(result.ready, false); assert.equal(result.repositories[1].matched, false);
    assert.equal(result.failure.category, "access_scope");
  }
  projects = () => [product, dependent];
  fs.rmSync(path.join(directory, ".project"));
  assert.equal((await probe()).repositories[1].matched, false, "optional projects still require a local descriptor");
  for (const nested of ["one/Tests", "two/Tests"]) {
    const nestedDirectory = path.join(directory, nested); fs.mkdirSync(nestedDirectory, { recursive: true });
    fs.writeFileSync(path.join(nestedDirectory, ".project"), "<projectDescription><name>Tests</name></projectDescription>");
  }
  assert.equal((await probe()).repositories[1].matched, false, "ambiguous optional descriptors cannot be accepted as closed");
});

test("EDT requires every required assignment and at least one ready required assignment", async t => {
  const f = fixture(t), projects = [{ name: "Product", path: f.root, open: true, state: "ready", edtProject: true }];
  for (const name of ["Second", "Tests"]) {
    const directory = path.join(f.root, name); fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, ".project"), `<projectDescription><name>${name}</name></projectDescription>`);
    f.profile.repositories.push({ id: name.toLowerCase(), path: name, alias: name.toLowerCase(), edt_project: name, edt_required: name !== "Tests" });
    projects.push({ name, path: directory, open: name !== "Tests", state: name === "Tests" ? "closed" : "ready", edtProject: true });
  }
  const upstream = await endpoint(t, f.root, () => projects), config = settings(); config.mcp.required.edt.url = upstream.url;
  const probe = async () => (await probe_connections(config, f.root, f.profile, f.state, "edt")).external.edt;
  assert.equal((await probe()).ready, true);
  projects[1].open = false; assert.equal((await probe()).ready, false);
  projects[1].open = true;
  f.profile.repositories.forEach(item => { item.edt_required = false; });
  for (const open of [false, true]) {
    projects.forEach(item => { item.open = open; item.state = open ? "ready" : "closed"; });
    const result = await probe(); assert.equal(result.ready, false); assert.match(result.detail, /хотя бы один обязательный/);
    assert.ok(result.repositories.every(item => item.requirementsMet));
  }
  f.profile.repositories[0].edt_required = true; projects[0].open = false;
  assert.equal((await probe()).ready, false, "ready optional assignments cannot replace an unready required assignment");
});

test("EDT setup rejects unconfirmed open, duplicate names and incomplete or malformed inventories", async t => {
  const f = fixture(t); f.profile.repositories[0].edt_required = false;
  const valid = { name: "Product", path: f.root, open: false, state: "closed" };
  let projects = [valid];
  const upstream = await endpoint(t, f.root, () => projects), config = settings(); config.mcp.required.edt.url = upstream.url;
  for (const open of [undefined, null, "false", 0]) {
    projects = [{ ...valid, open }];
    const result = (await probe_connections(config, f.root, f.profile, f.state, "edt")).external.edt;
    assert.equal(result.ready, false); assert.equal(result.connected, true); assert.equal(result.failure.category, "server_contract");
    assert.match(result.detail, /неподдерживаемый или неполный список/);
  }
  for (const rows of [[valid, valid], [{ ...valid, edtProject: null }], [{ ...valid, state: 1 }], [null]]) {
    projects = rows;
    const result = (await probe_connections(config, f.root, f.profile, f.state, "edt")).external.edt;
    assert.equal(result.ready, false); assert.equal(result.failure.category, "server_contract");
  }
});

test("v8std bootstrap survives empty roots and isolates projects on a shared server", async t => {
  const f = fixture(t), messages = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const part of request) body += part;
    if (!body) return response.writeHead(202).end();
    const message = JSON.parse(body); messages.push(message);
    const reply = result => response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    if (message.method === "server/discover") return response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "legacy" } }));
    if (message.method === "initialize") return reply({ protocolVersion: "2025-11-25", serverInfo: { name: "v8std-fixture", version: "1" }, capabilities: { tools: {} } });
    if (message.method.startsWith("notifications/")) return response.writeHead(202).end();
    if (message.method === "tools/list") return reply({ tools: [{ name: "v8std_explain_snippet", inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] }, annotations: { readOnlyHint: true } }, { name: "fixture_operation", inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] }, annotations: { readOnlyHint: false } }] });
    if (message.method === "tools/call") return reply({ content: [{ type: "text", text: "fixture candidate" }], structuredContent: { candidates: ["fixture standard"] } });
    if (message.method === "resources/list") return response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32010, message: "fixture resource error" } }));
    response.writeHead(202).end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise(done => server.close(done)); });
  f.profile.connections = { v8std: { url: `http://127.0.0.1:${server.address().port}/mcp` } }; f.save();
  const other = path.join(f.base, "other"); fs.mkdirSync(other); fs.mkdirSync(path.join(other, "src"));
  dump(f.profile, path.join(other, ".ai/project.yaml"));
  const a = await unbound(t, f, "scripts/lazy_mcp.mjs", ["--component", "v8std"]);
  const b = await unbound(t, f, "scripts/lazy_mcp.mjs", ["--component", "v8std"]);
  const controls = (await a.request("tools/list")).tools;
  assert.deepEqual(controls.map(tool => tool.name), ["core_runtime_status", "core_runtime_tools", "core_runtime_call"]);
  assert.match(controls.find(tool => tool.name === "core_runtime_call").description, /do not request additional v8std permission/i);
  assert.deepEqual(await a.request("resources/list"), { resources: [] });
  assert.deepEqual(await a.request("resources/templates/list"), { resourceTemplates: [] });
  assert.equal(messages.length, 0);
  const statusA = (await a.call("core_runtime_status", { projectRoot: f.root })).structuredContent;
  assert.equal(statusA.ready, true);
  assert.equal((await b.call("core_runtime_status", {})).structuredContent.selectedDirectory, null);
  const statusB = (await b.call("core_runtime_status", { projectRoot: other })).structuredContent;
  assert.equal(statusB.ready, true); assert.notEqual(statusA.binding.connectionId, statusB.binding.connectionId);
  await assert.rejects(a.request("resources/list"), /MCP resources\/list/);
  assert.ok((await a.request("tools/list")).tools.some(tool => tool.name === "core_runtime_status"));
  const result = await a.call("core_runtime_call", { calls: [{ name: "v8std_explain_snippet", arguments: { code: "Сообщить(\"Тест\");" } }] });
  assert.deepEqual(result.structuredContent.results[0].result.structuredContent.candidates, ["fixture standard"]);
  const code = "Функция ВнутренняяЛогика()\nВозврат \"пример\";\nКонецФункции";
  const operation = await a.call("core_runtime_call", { calls: [{ name: "fixture_operation", arguments: { code } }] });
  assert.equal(operation.structuredContent.completed, 1);
  assert.deepEqual(messages.filter(message => message.method === "tools/call").at(-1).params, { name: "fixture_operation", arguments: { code } });
  assert.equal((await b.call("core_runtime_status", {})).structuredContent.binding.projectRoot, other);
  assert.equal(JSON.stringify(messages).includes(JSON.stringify(f.root).slice(1, -1)), false);
  assert.equal(JSON.stringify(messages).includes(JSON.stringify(other).slice(1, -1)), false);
  assert.equal(messages.filter(message => message.method === "initialize").every(message => !message.params.capabilities.roots), true);
});

test("resource and prompt discovery changes are advertised when a binding opens and closes", async t => {
  const f = fixture(t), notifications = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const part of request) body += part;
    if (!body) return response.writeHead(202).end();
    const message = JSON.parse(body);
    const reply = result => response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    if (message.method === "server/discover") return response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "legacy" } }));
    if (message.method === "initialize") return reply({ protocolVersion: "2025-11-25", serverInfo: { name: "fixture", version: "1" }, capabilities: { tools: {}, resources: {}, prompts: {} } });
    if (message.method === "tools/list") return reply({ tools: [] });
    if (message.method === "resources/list") return reply({ resources: [{ uri: "fixture://one", name: "one" }] });
    if (message.method === "resources/templates/list") return reply({ resourceTemplates: [{ uriTemplate: "fixture://{id}", name: "template" }] });
    if (message.method === "prompts/list") return reply({ prompts: [{ name: "fixture" }] });
    return response.writeHead(202).end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise(done => server.close(done)); });
  f.profile.connections = { edt: { url: `http://127.0.0.1:${server.address().port}/mcp` } }; f.save();
  const client = new McpClient([process.execPath, path.join(ROOT, "scripts/lazy_mcp.mjs"), "--component", "edt"], ROOT,
    { ...f.env, EDT_AI_PROJECT_ROOT: "" }, 10, { onNotification: message => notifications.push(message.method) });
  f.clients.push(client); client.roots = [];
  let rootsAnswered; const rootsReady = new Promise(resolve => { rootsAnswered = resolve; });
  const send = client.send.bind(client);
  client.send = message => { send(message); if (message.result?.roots) rootsAnswered(); };
  const init = await client.initialize();
  await rootsReady;
  assert.equal(init.capabilities.resources.listChanged, true); assert.equal(init.capabilities.prompts.listChanged, true);
  assert.deepEqual(await client.request("resources/list"), { resources: [] });
  assert.deepEqual(await client.request("resources/templates/list"), { resourceTemplates: [] });
  assert.deepEqual(await client.request("prompts/list"), { prompts: [] });
  notifications.length = 0;
  await client.call("core_runtime_status", { projectRoot: f.root });
  assert.ok(notifications.includes("notifications/resources/list_changed"));
  assert.ok(notifications.includes("notifications/prompts/list_changed"));
  assert.equal((await client.request("resources/list")).resources.length, 1);
  assert.equal((await client.request("resources/templates/list")).resourceTemplates.length, 1);
  assert.equal((await client.request("prompts/list")).prompts.length, 1);
  notifications.length = 0;
  client.notify("notifications/roots/list_changed");
  await client.request("ping");
  assert.ok(notifications.includes("notifications/resources/list_changed"));
  assert.ok(notifications.includes("notifications/prompts/list_changed"));
});

test("initial relay catalogue is available while host roots are pending or fail", async t => {
  const f = fixture(t); f.save();
  for (const component of ["v8std", "edt", "code-index", "bsl-ls"]) {
    const child = spawn(process.execPath, [path.join(ROOT, "scripts/lazy_mcp.mjs"), "--component", component],
      { cwd: ROOT, env: { ...f.env, EDT_AI_PROJECT_ROOT: "" }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    t.after(() => child.kill());
    const pending = new Map(), notifications = []; let roots, receivedRoots = false;
    const rootsRequest = new Promise(resolve => { roots = resolve; });
    read_lines(child.stdout, message => {
      if (message.method === "roots/list") { receivedRoots = true; roots(message); }
      else if (message.method) notifications.push(message.method);
      else if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
    }, error => { throw error; });
    const send = message => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
    const request = (id, method, params = {}) => new Promise(resolve => { pending.set(id, resolve); send({ id, method, params }); });
    const init = await request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: { roots: {} }, clientInfo: { name: "host-fixture", version: "1" } });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    await request(9, "ping"); assert.equal(receivedRoots, false);
    send({ method: "notifications/initialized", params: {} });
    const rootCall = await rootsRequest;
    const first = await request(2, "tools/list");
    assert.deepEqual(first.result.tools.map(tool => tool.name), ["core_runtime_status", "core_runtime_tools", "core_runtime_call"]);
    const pendingResources = request(3, "resources/list");
    send({ id: rootCall.id, error: { code: -32000, message: "host roots failed" } });
    assert.match((await pendingResources).error.message, /Хост не передал выбранный каталог/);
    assert.deepEqual((await request(4, "tools/list")).result.tools.map(tool => tool.name), ["core_runtime_status", "core_runtime_tools", "core_runtime_call"]);
    assert.ok(notifications.includes("notifications/resources/list_changed"));
    assert.ok(notifications.includes("notifications/prompts/list_changed"));
    assert.ok((await request(5, "tools/call", { name: "core_runtime_status", arguments: { projectRoot: f.root } })).error);
    assert.match((await request(6, "resources/list")).error.message, /Хост не передал выбранный каталог/);
    assert.match((await request(7, "resources/templates/list")).error.message, /Хост не передал выбранный каталог/);
    assert.match((await request(8, "prompts/list")).error.message, /Хост не передал выбранный каталог/);
    child.stdin.end(); await once(child, "exit");
  }
});

test("settings and knowledge request host roots only after MCP initialization", async t => {
  const f = fixture(t);
  for (const file of ["mcp/settings.mjs", "mcp/openviking.mjs"]) {
    const child = spawn(process.execPath, [path.join(ROOT, file)],
      { cwd: ROOT, env: { ...f.env, EDT_AI_PROJECT_ROOT: "" }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    t.after(() => child.kill());
    const pending = new Map(); let rootRequest, receivedRoots = false;
    const roots = new Promise(resolve => { rootRequest = resolve; });
    read_lines(child.stdout, message => {
      if (message.method === "roots/list") { receivedRoots = true; rootRequest(message); }
      else if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
    }, error => { throw error; });
    const send = message => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
    const request = (id, method, params = {}) => new Promise(resolve => { pending.set(id, resolve); send({ id, method, params }); });
    const init = await request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: { roots: {} }, clientInfo: { name: "fixture", version: "1" } });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    await request(2, "tools/list"); assert.equal(receivedRoots, false);
    send({ method: "notifications/initialized", params: {} });
    const root = await roots; send({ id: root.id, result: { roots: [] } });
    assert.ok((await request(3, "tools/list")).result.tools.length > 0);
    child.stdin.end(); await once(child, "exit");
  }
});

test("a slow shared EDT connection cannot block the relay's bootstrap catalogue", async t => {
  const f = fixture(t); let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const server = createServer(async (request, response) => {
    let body = ""; for await (const part of request) body += part;
    if (!body) return response.writeHead(202).end();
    const message = JSON.parse(body);
    const reply = result => response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    if (message.method === "server/discover") return response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "legacy" } }));
    if (message.method === "initialize") { entered(); await held; return reply({ protocolVersion: "2025-11-25", serverInfo: { name: "fixture", version: "1" }, capabilities: { tools: {} } }); }
    if (message.method === "tools/list") return reply({ tools: [{ name: "inspect", inputSchema: { type: "object" } }] });
    response.writeHead(202).end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise(done => server.close(done)); });
  f.profile.connections = { edt: { url: `http://127.0.0.1:${server.address().port}/mcp` } }; f.save();
  const client = new McpClient([process.execPath, path.join(ROOT, "scripts/lazy_mcp.mjs"), "--component", "edt"], f.root, f.env, 10);
  f.clients.push(client); await client.initialize();
  assert.equal((await client.request("tools/list")).tools.length, 3);
  const status = client.call("core_runtime_status", {}); await started;
  assert.equal((await client.request("tools/list")).tools.length, 3);
  release(); assert.equal((await status).structuredContent.ready, true);
  assert.ok((await client.call("core_runtime_tools", {})).structuredContent.tools.some(tool => tool.name === "inspect"));
});

test("explicit managed binding preserves the public catalogue and honors the preparation gate", async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  const preload = new URL("./fixtures/managed-spawn.mjs", import.meta.url).href;
  const client = new McpClient([process.execPath, path.join(ROOT, "scripts/lazy_mcp.mjs"), "--component", "code-index"], ROOT,
    { ...f.env, EDT_AI_PROJECT_ROOT: "", NODE_OPTIONS: [process.env.NODE_OPTIONS, "--import " + preload].filter(Boolean).join(" ") }, 10);
  f.clients.push(client); client.roots = []; await client.initialize();
  const revision = client.tools_revision;
  await client.call("core_runtime_status", { projectRoot: f.root });
  assert.equal(client.tools_revision, revision);
  assert.deepEqual((await client.request("tools/list")).tools.map(tool => tool.name), ["core_runtime_status", "core_runtime_tools", "core_runtime_call"]);
  assert.deepEqual(fs.readdirSync(f.state).filter(name => name !== "diagnostics"), []);
  grant_preparation(f.state, f.root, ["code-index"]);
  await client.call("core_runtime_status", {});
  assert.ok((await client.call("core_runtime_tools", {})).structuredContent.tools.some(tool => tool.name === "inspect"));
  assert.equal((await client.call("core_runtime_status", {})).structuredContent.ready, true);
});

test("v8std binding never sends the local project directory, including unsolicited roots callbacks", async t => {
  const f = fixture(t), messages = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const part of request) body += part;
    const message = JSON.parse(body); messages.push(message);
    const reply = result => response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    if (message.method === "server/discover") return response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "legacy" } }));
    if (message.method === "initialize") {
      assert.equal(message.params.capabilities.roots, undefined);
      return reply({ protocolVersion: "2025-11-25", serverInfo: { name: "standards", version: "1" }, capabilities: { tools: {} } });
    }
    if (message.method === "tools/list") {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write('data: {"jsonrpc":"2.0","id":"unsolicited-roots","method":"roots/list","params":{}}\n\n');
      response.end('data: '+JSON.stringify({jsonrpc:"2.0",id:message.id,result:{tools:[]}})+'\n\n');return;
    }
    response.writeHead(202).end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise(done => server.close(done)); });
  f.profile.connections = { v8std: { url: `http://127.0.0.1:${server.address().port}/mcp` } }; f.save();
  const client = await unbound(t, f, "scripts/lazy_mcp.mjs", ["--component", "v8std"]);
  assert.equal((await client.call("core_runtime_status", { projectRoot: f.root })).structuredContent.ready, true);
  assert.deepEqual(messages.find(message => message.id === "unsolicited-roots").result.roots, []);
  assert.equal(JSON.stringify(messages).includes(JSON.stringify(f.root).slice(1, -1)), false);
});

test("bounded operation waits do not restart work and return promptly after completion", async () => {
  let calls = 0;
  const operations = new SettingsOperations(async () => { calls++; await sleep(50); return { checked: true }; });
  const job = operations.start("probe", {}, {});
  await operations.wait(job.id, 1); assert.equal(operations.status(job.id).status, "running");
  await operations.wait(job.id, 1000); assert.equal(operations.status(job.id).status, "completed");
  assert.equal(calls, 1);
});
