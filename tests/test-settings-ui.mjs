import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { fixture, environment, session, ROOT } from "./helpers.mjs";
import { canonical_yaml, dump, load, parse } from "../scripts/common.mjs";
import { McpClient } from "../scripts/mcp_client.mjs";
import { remember_profile } from "../scripts/profile_history.mjs";
import { profile_state } from "../scripts/profile.mjs";
import { patch_yaml_draft, SettingsBackend } from "../scripts/settings_backend.mjs";
import { yaxunit_result } from "../scripts/yaxunit_readiness.mjs";
import { save_component_checks } from "../scripts/setup_readiness.mjs";

const html = fs.readFileSync(new URL("../ui/settings.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const componentName = card => card.children[0].children[0].children[0].textContent;
const componentButton = card => card.children[0].children.at(-1);
const headerState = (ui,name) => ui.elements.get("headerComponentStatuses").children.find(item=>item.textContent.startsWith(name+": "))?.textContent.slice(name.length+2);

test("static settings controls have unique IDs and script references point to real elements", () => {
  const markup = html.split("<script>")[0], ids = [...markup.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  const available = new Set(ids);
  for (const match of script.matchAll(/\$\("([^"]+)"\)/g)) assert.ok(available.has(match[1]), `Missing control ${match[1]}`);
});

test("main navigation contains the three requested sections", () => {
  const nav=html.match(/<nav class="tabs" id="profileTabs"[\s\S]*?<\/nav>/)?.[0];
  assert.ok(nav);assert.deepEqual([...nav.matchAll(/role="tab"[^>]*>([^<]+)/g)].map(match=>match[1]),["Компоненты","Конфигурация","Поддержка"]);
});

test("component operation feedback is live and stays outside collapsed diagnostics", () => {
  for (const [dialog, notice] of [["componentDialog", "componentDialogStatus"], ["managedDialog", "managedDialogNotice"], ["testingDialog", "testingDialogNotice"]]) {
    const markup = html.match(new RegExp('<dialog id="' + dialog + '"[\\s\\S]*?</dialog>'))[0];
    const output = markup.match(new RegExp('<[^>]+id="' + notice + '"[^>]*>'));
    assert.ok(output, dialog + " must contain operation feedback");
    assert.match(output[0], /role="status"/); assert.match(output[0], /aria-live="polite"/);
    const preceding = markup.slice(0, output.index);
    assert.equal([...preceding.matchAll(/<details\b/g)].length, [...preceding.matchAll(/<\/details>/g)].length,
      dialog + " feedback must remain visible when diagnostics are collapsed");
  }
});

test("readiness preparation states its side effects before the user starts it", () => {
  const panel = html.match(/<div id="readinessPanel"[\s\S]*?<\/details><\/div>/)?.[0];
  assert.match(panel, /id="readinessButton">Подготовить и проверить/);
  assert.match(panel, /скачать компоненты и запустить включённые сервисы/);
  assert.match(panel, /Состояние обновляется каждую минуту или кнопкой в шапке/);
  assert.match(html, /При изменении окружения подготовленного BSL LS Java запускается только на время проверки/);
});

test("the components tab starts with compact counters and filters without a repeated heading",()=>{
  const panel=html.slice(html.indexOf('<section id="checkPanel"'),html.indexOf('<div id="managedControlsHolder"'));
  assert.doesNotMatch(panel,/<h2>Компоненты<\/h2>|Подключения, управляемые сервисы и возможности выбранного проекта/);
  assert.match(panel,/class="catalog-toolbar"/);
  for(const id of ["countAll","countReady","countIssues","countDisabled","countChecking","countStale","componentsAll","componentsIssues"])assert.match(panel,new RegExp('id="'+id+'"'));
});

function screen(handler, options = {}) {
  const elements = new Map(), timers = new Map(), calls = [], downloads = [], blobs = [], closeEvents = [];
  let nextTimer = 0, message, observedResize;const lifecycle = {}, documentEvents = {};
  class Element {
    constructor(tag = "div") { Object.assign(this, { tag, style: {}, disabled: false, readOnly: false, hidden: false, checked: false, value: "", files: [], textContent: "", children: [], events: {} });
      if (tag.toLowerCase() === "textarea") { let value = ""; Object.defineProperty(this, "value", { get: () => value, set: text => { value = String(text).replace(/\r\n?/g, "\n"); } }); }
    }
    classList = { toggle() {} };
    get parentElement() { return this.parentNode; }
    get tagName() { return this.tag.toUpperCase(); }
    addEventListener(name, fn) { this.events[name] = fn; }
    setAttribute(key, value) { (this.attributes ||= {})[key] = value; }
    removeAttribute(key) { delete (this.attributes ||= {})[key]; }
    contains(target) { return target===this||this.children.some(child=>child.contains?.(target)); }
    replaceChildren(...children) { for (const child of this.children) { if (child.contains?.(document.activeElement)) document.activeElement = document.body; child.parentNode = null; } this.children = []; this.append(...children); }
    append(...children) { for (const child of children) { if (child.parentNode) { if (child.contains?.(document.activeElement)) document.activeElement = document.body; child.parentNode.children = child.parentNode.children.filter(item => item !== child); } child.parentNode = this; this.children.push(child); } }
    insertBefore(child, next) { this.append(child); this.children.splice(this.children.indexOf(child), 1); this.children.splice(next ? this.children.indexOf(next) : this.children.length, 0, child); }
    click() { if (this.tag === "a") downloads.push({ filename: this.download, href: this.href }); }
    showModal() { this.open = true; }
    close() { this.open = false; if (options.deferredClose) closeEvents.push(() => this.events.close?.()); else this.events.close?.(); }
    remove() { if (this.parentNode) { if (this.contains(document.activeElement)) document.activeElement = document.body; this.parentNode.children = this.parentNode.children.filter(item => item !== this); this.parentNode = null; } }
    focus() { document.activeElement = this; }
    getBoundingClientRect() { return { height: options.height?.() ?? 500 }; }
  }
  for (const match of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g)) { const element = new Element(match[1]); element.id = match[2]; elements.set(match[2], element); }
  for(const match of html.matchAll(/<select\b[^>]*\bid="([^"]+)"[^>]*>\s*<option value="([^"]+)"/g))elements.get(match[1]).value=match[2];
  const parent = { postMessage(request) {
    calls.push(request);
    if (!request.id) return;
    Promise.resolve().then(async () => {
      let result;
      try {
        const data = request.method === "ui/initialize" ? { hostInfo: { name: "fixture" }, hostContext: options.hostContext }
          : request.method === "ui/request-display-mode" ? {mode:"fullscreen"}
          : request.method === "ui/message" ? {}
          : request.params?.name === "settings.refresh_readiness" && !options.liveRefresh ? {
            id: "passive-" + request.id, action: "refresh_readiness", component: request.params.arguments.component, status: "completed",
            projectRoot: vm.runInContext("currentData.values.projectRoot", context), instance: vm.runInContext("currentData.instance", context), result: { componentChecks: [], managed: [], external: {} } }
          : await handler(request.params.name, request.params.arguments,request.params._meta);
        result = request.method === "ui/initialize" || (request.method === "tools/call" && options.rawResults) ? data : { structuredContent: data };
      } catch (error) { result = { isError: true, content: [{ type: "text", text: error.message }] }; }
      const deliver = data => message({ source: parent, origin: "https://fixture.invalid", data });
      if (options.echo && request.method === "tools/call") deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: result });
      deliver({ jsonrpc: "2.0", id: request.id, result });
      if (options.echo && request.method === "tools/call") deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: result });
    });
  } };
  const document = { hidden: false, addEventListener: (name, fn) => { documentEvents[name] = fn; }, getElementById: id => elements.get(id), createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag),
    createTextNode: text => ({textContent:text}), querySelector: () => new Element("main"), body: new Element("body"),
    querySelectorAll: () => {
      const found=new Set();const visit=element=>{if(found.has(element))return;found.add(element);for(const child of element.children||[])visit(child);};
      for(const element of elements.values())visit(element);
      return [...found].filter(element=>["button","input","textarea","select"].includes(element.tag));
    },
    documentElement: { scrollHeight: 500, style: { setProperty() {} }, setAttribute() {} } };
  const media={matches:Boolean(options.narrow),addEventListener(name,fn){this.listener=fn;}};
  const browserWindow={parent,matchMedia:()=>media,addEventListener:(name,listener)=>{if(name==="message")message=listener;else lifecycle[name]=listener;}};
  if(options.standalone)browserWindow.parent=browserWindow;
  const context = vm.createContext({ document, window: browserWindow,
    setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id),
    getComputedStyle: () => ({ paddingTop: "20px", paddingBottom: "20px" }),
    ResizeObserver: class { constructor(callback) { observedResize = callback; } observe() {} },
    Blob, TextDecoder, URL: { createObjectURL: blob => { blobs.push(blob); return "blob:fixture"; }, revokeObjectURL() {} } });
  vm.runInContext(script, context);
  vm.runInContext(`configureNavigation(${JSON.stringify(options.navigation || "profiles")})`, context);
  const flush = () => new Promise(resolve => setImmediate(resolve));
  return { context, elements, timers, calls, downloads, blobs, flush, document, lifecycle, documentEvents, media, resize: () => observedResize(),
    deliver(data) { message({ source: parent, origin: "https://fixture.invalid", data }); },
    flushCloseEvents() { for (const close of closeEvents.splice(0)) close(); },
    async tick(ms = 1000) { const entries=[...timers];const [id, timer] = entries.find(([, timer]) => timer.ms === ms) || (ms===60000?entries.find(([, timer])=>timer.ms>59000&&timer.ms<60000):null) || []; assert.ok(timer); timers.delete(id); timer.fn(); await flush(); } };
}

const read = { values: { projectRoot: "C:/fixture/project" }, preparationScope: "C:/fixture/project#default",
  profile: { status: "loaded", projectId: "Project", profileId: "generic-1c", repositories: [] },
  schema: { properties: { projectRoot: { readOnly: true } } } };

function liveStatusScreen({hold=false,running=false}={}) {
  const current={...read,instance:"default",settingsRevision:"saved",values:{...read.values,edtUrl:"http://edt",v8stdUrl:"http://v8std",openvikingEnabled:true,openvikingUrl:"http://knowledge",codeIndexEnabled:true,bslLsEnabled:true},
    profile:{...read.profile,testing:{yaxunit:true,vanessa:true}},testing:{yaxunit_config:{},vanessa_config:{}},summary:{components:[{id:"code-index",status:"external",mode:"external"},{id:"bsl-ls",status:"external",mode:"external"}]}};
  const requests=[],operations=new Map();let failure=null,pollFailure=false,releasePoll,pollGate,release,gate=hold?new Promise(done=>{release=done;}):null;
  const ui=screen(async(name,args)=>{
    if(["settings.read","settings.status"].includes(name))return current;
    if(name==="settings.load")return {};
    if(["settings.refresh_readiness","settings.probe_connections"].includes(name)){
      const root=current.values.projectRoot,instance=current.instance,number=requests.length+1;
      requests.push({name,...args});
      if(gate){const pending=gate;gate=null;await pending;}
      if(failure)throw new Error(failure);
      const ids=args.component?[args.component]:["edt","v8std","openviking","code-index","bsl-ls","yaxunit","vanessa"];
      const operation={id:"live-"+number,action:name==="settings.refresh_readiness"?"refresh_readiness":"probe",component:args.component,projectRoot:root,instance,status:"completed",
        result:{componentChecks:ids.map(id=>({id,state:id==="yaxunit"?"configured":"ready",detail:id+" · проверка "+number,checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),...(id==="code-index"?{repositories:[{id:"product",edtProject:"Product",state:"ready"}]}:{})}))}};
      operations.set(operation.id,operation);return running?{...operation,status:"running"}:operation;
    }
    if(name==="settings.operation"){
      if(args.operationId==="foreground"){await pollGate;return {id:"foreground",action:"pick_java",projectRoot:current.values.projectRoot,instance:current.instance,status:"completed",result:{cancelled:true}};}
      if(pollFailure)throw new Error("Не удалось получить результат проверки");
      return operations.get(args.operationId);
    }
    if(name==="settings.versions")return {component:args.component,versions:[]};
    if(name==="settings.edit")return {text:"testing: {}\n",format:"yaml",baseRevision:"base",layerScope:"profile"};
    if(name==="settings.document_fields")return new SettingsBackend("unused","unused").main({action:"document_fields",...args});
    throw new Error(name);
  },{liveRefresh:true});
  return {ui,current,requests,release:()=>release(),fail:message=>{failure=message;},holdNext:()=>{gate=new Promise(done=>{release=done;});},failPoll:value=>{pollFailure=value;},holdPoll:()=>{pollGate=new Promise(done=>{releasePoll=done;});},releasePoll:()=>releasePoll()};
}

test("the header keeps all component states but shows only issues and active work on every tab",async()=>{
  const f=liveStatusScreen();f.current.profile.repositories=[{id:"shared"}];
  f.current.profileDirectoryContext={edt:{projectCount:4},git:{status:"detected",branch:"feature/header"}};
  await f.ui.flush();
  assert.equal(f.ui.elements.get("headerProfileFacts").textContent,"Профиль: generic-1c · Экземпляр: default · EDT-проектов: 4 · Репозиториев: 1 · Ветка: feature/header");
  assert.equal(f.ui.elements.get("headerProfileSummary").title,f.current.values.projectRoot);
  const badges=f.ui.elements.get("headerComponentStatuses");assert.equal(badges.hidden,false);assert.equal(badges.children.length,7);
  for(const item of f.ui.context.catalogItems(f.current)){
    const badge=badges.children.find(badge=>badge.attributes["data-component"]===item.id);
    assert.equal(badge.attributes["data-state"],item.state);assert.ok(badge.textContent.startsWith(item.name+": "));
    if(["ready","disabled"].includes(item.state)&&!item.issue)assert.equal(badge.hidden,true);
    if(item.issue||["checking","indexing","preparing","building"].includes(item.state))assert.equal(badge.hidden,false);
    if(item.id==="yaxunit")assert.match(badge.textContent,/Требуется проверка настроек/);
    if(item.id==="vanessa")assert.match(badge.textContent,/Менеджер доступен/);
  }
  assert.ok(badges.children.some(badge=>badge.hidden));
  const requests=f.requests.length;
  for(const tab of ["check","editor","support"]){f.ui.context.show(tab);assert.equal(f.ui.elements.get("headerProfileSummary").hidden,false);assert.equal(badges.children.length,7);}
  assert.equal(f.requests.length,requests,"rendering the summary must not initiate additional component checks");
});

test("header component badges follow addressed results, in-progress checks and evidence expiry",async()=>{
  const f=liveStatusScreen();await f.ui.flush();await f.ui.elements.get("headerRefresh").onclick();
  const badge=id=>f.ui.elements.get("headerComponentStatuses").children.find(item=>item.attributes["data-component"]===id);
  const v8=badge("v8std").textContent;
  f.ui.context.observeComponentResult({componentChecks:[{id:"edt",state:"error",detail:"Проверка EDT завершилась ошибкой"}]},
    {action:"probe",component:"edt",projectRoot:f.current.values.projectRoot,instance:f.current.instance});
  assert.equal(badge("edt").textContent,"EDT: Ошибка");assert.match(badge("edt").title,/Проверка EDT завершилась ошибкой/);assert.equal(badge("v8std").textContent,v8);
  vm.runInContext('activeOperation={action:"refresh_readiness",component:"code-index",status:"running",projectRoot:currentData.values.projectRoot,instance:currentData.instance}',f.ui.context);
  f.ui.context.renderComponentCatalog(f.current);assert.equal(badge("code-index").attributes["data-state"],"ready");assert.equal(badge("v8std").textContent,v8);
  vm.runInContext('activeOperation.status="completed";componentObservations.get("v8std").check.expiresAt=new Date(Date.now()-1).toISOString()',f.ui.context);
  f.ui.context.renderComponentCatalog(f.current);assert.equal(badge("v8std").textContent,"v8std: Проверка устарела");
});

test("BSL status names the verified API and shows the limits of that observation", async () => {
  const f = liveStatusScreen(), detail = "Проверены JAR, запуск выбранной Java и совместимость MCP API. Применение конфигурации и работа диагностик этой проверкой не подтверждаются.";
  const checkedAt = new Date().toISOString();
  f.current.componentStatuses = [{ id: "bsl-ls", state: "ready", apiCompatible: true, apiEvidenceVersion: 1, detail, checkedAt, expiresAt: new Date(Date.now() + 60000).toISOString() }];
  await f.ui.flush();
  const badge = f.ui.elements.get("headerComponentStatuses").children.find(item => item.attributes["data-component"] === "bsl-ls");
  assert.match(badge.textContent, /Совместимость API проверена/); assert.match(badge.title, /работа диагностик.*не подтверждаются/);
  const card = f.ui.elements.get("componentCatalog").children.flatMap(group => group.children[1].children).find(item => componentName(item) === "BSL LS");
  assert.equal(card.catalogNodes.status.textContent, "Совместимость API проверена"); assert.match(card.catalogNodes.meta.textContent, /работа диагностик.*не подтверждаются/);
});

test("Vanessa status shows the observed manager and expires without probing",async()=>{
  const f=liveStatusScreen();await f.ui.flush();
  assert.equal(headerState(f.ui,"Vanessa"),"Менеджер доступен");
  await f.ui.elements.get("headerRefresh").onclick();
  assert.equal(headerState(f.ui,"Vanessa"),"Менеджер доступен");
  const item=f.ui.context.catalogItems(f.current).find(item=>item.id==="vanessa");
  await f.ui.context.openTestingSettings("vanessa",null);
  assert.equal(f.ui.elements.get("testingDialogDiagnostic").textContent,"Менеджер доступен");
  assert.equal(item.state,"ready");
  const count=f.requests.length;
  vm.runInContext('componentObservations.get("vanessa").check.expiresAt=new Date(Date.now()-1).toISOString();renderTimeSensitiveStatus()',f.ui.context);
  assert.equal(headerState(f.ui,"Vanessa"),"Проверка устарела");
  assert.equal(f.ui.elements.get("testingDialogDiagnostic").textContent,"Проверка устарела");
  assert.equal(f.requests.length,count);
  f.ui.context.observeComponentResult({componentChecks:[{id:"vanessa",state:"stopped",detail:"Нет подключения к MCP менеджера"}]},
    {action:"probe",component:"vanessa",projectRoot:f.current.values.projectRoot,instance:f.current.instance});
  assert.equal(headerState(f.ui,"Vanessa"),"Менеджер недоступен");
  assert.equal(f.ui.elements.get("testingDialogDiagnostic").textContent,"Менеджер недоступен");
  assert.equal(f.requests.length,count);
});

test("a successful Vanessa manager start refreshes that component",async()=>{
  const f=liveStatusScreen();await f.ui.flush();await f.ui.flush();
  const count=f.requests.length,operation={id:"manager-start",action:"vanessa_start",status:"completed",projectRoot:f.current.values.projectRoot,instance:f.current.instance,result:{status:"started"}};
  await f.ui.context.pollOperation(operation.id,null,operation);await f.ui.flush();await f.ui.flush();
  assert.ok(f.requests.slice(count).some(item=>item.name==="settings.refresh_readiness"&&item.component==="vanessa"));
});

test("server component statuses outrank stale setup and refresh preserves card focus",async()=>{
  const f=liveStatusScreen(),ids=["edt","v8std","openviking","code-index","bsl-ls","yaxunit","vanessa"];
  f.ui.document.hidden=true;
  const checkedAt=new Date().toISOString(),expiresAt=new Date(Date.now()+60000).toISOString();
  f.current.componentStatuses=ids.map(id=>({id,state:"ready",detail:"Собственное наблюдение "+id,checkedAt,expiresAt,inputRevision:id,currentInputRevision:id}));
  f.current.readiness={state:"stale",reason:"Изменился другой компонент",checks:ids.map(id=>({id,state:"error"}))};
  await f.ui.flush();
  assert.ok(f.ui.context.catalogItems(f.current).every(item=>item.state==="ready"));
  const catalog=f.ui.elements.get("componentCatalog"),card=[...catalog.children].flatMap(group=>group.children[1].children).find(item=>item.attributes["aria-label"]==="EDT");
  const button=card.catalogNodes.button;button.focus();
  const observations=f.current.componentStatuses.map(item=>item.id==="edt"?{...item,state:"error",detail:"EDT недоступен",checkedAt:new Date(Date.now()+1).toISOString()}:item);
  f.current.componentStatuses=observations;f.ui.context.renderComponentCatalog(f.current);
  assert.equal(f.ui.document.activeElement,button);
  assert.equal(card.catalogNodes.status.textContent,"Ошибка");
  assert.equal(f.ui.context.catalogItems(f.current).find(item=>item.id==="vanessa").state,"ready");
});

test("real MCP read and status deliver component statuses to the renderer", async t => {
  const f=fixture(t);environment(t,f.env);f.save();
  const backend=new SettingsBackend(),config=backend.effective(backend.current());
  save_component_checks(f.state,config,f.profile,[{id:"bsl-ls",state:"ready",inputRevision:"private-fixture-revision"}]);
  const client=await session(t,"mcp/settings.mjs",[],f),response=await client.call("settings.read",{});
  assert.doesNotMatch(JSON.stringify(response),/inputRevision|currentInputRevision|private-fixture-revision/);
  const snapshot=response.structuredContent;
  assert.equal(snapshot.componentStatuses.length,7);
  const observed=(await client.call("settings.status",{})).structuredContent;
  assert.deepEqual(observed.componentStatuses.map(item=>item.id),snapshot.componentStatuses.map(item=>item.id));
  const ui=screen((name,args,meta)=>client.request("tools/call",{name,arguments:args,...(meta?{_meta:meta}:{})}),{navigation:"project",rawResults:true});
  ui.document.hidden=true;
  const end=Date.now()+10000;
  while(!vm.runInContext("Boolean(currentData?.componentStatuses)",ui.context)){
    assert.ok(Date.now()<end,ui.elements.get("status").textContent);
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  const items=ui.context.catalogItems(vm.runInContext("currentData",ui.context));
  for(const status of snapshot.componentStatuses)assert.equal(items.find(item=>item.id===status.id).state,status.state);
  ui.lifecycle.pagehide();
});

test("a late observation is replaced by the server projection even when the settings revision is unchanged", async () => {
  const f=liveStatusScreen({hold:true}),checkedAt=new Date().toISOString(),expiresAt=new Date(Date.now()+60000).toISOString();
  const ids=["edt","v8std","openviking","code-index","bsl-ls","yaxunit","vanessa"];
  f.current.componentStatuses=ids.map(id=>({id,state:"ready",checkedAt,expiresAt,detail:"Сохранённое наблюдение"}));
  await f.ui.flush();const pending=f.ui.elements.get("headerRefresh").onclick();
  f.current.componentStatuses=f.current.componentStatuses.map(item=>item.id==="edt"?{...item,state:"check_stale",detail:"Файл .project изменился."}:item);
  f.release();await pending;await f.ui.flush();
  const edt=f.ui.context.catalogItems(f.current).find(item=>item.id==="edt");
  assert.equal(edt.state,"check_stale");assert.match(edt.detail,/\.project изменился/);
});

test("an older settings snapshot cannot overwrite a newer snapshot returned first", async () => {
  const base={...read,instance:"default",settingsRevision:"same",values:{...read.values,edtUrl:"http://edt"},summary:{components:[]},
    componentStatuses:[{id:"edt",state:"ready",detail:"Старые данные",checkedAt:new Date().toISOString()}]};
  let delayed=false,release,entered;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  const ui=screen(async name=>{
    if(name!=="settings.read")return base;
    if(!delayed)return base;
    if(delayed==="first"){delayed="second";entered();await gate;return base;}
    return {...base,componentStatuses:[{id:"edt",state:"check_stale",detail:"Файл .project изменился.",checkedAt:new Date().toISOString()}]};
  });ui.document.hidden=true;await ui.flush();delayed="first";
  const old=ui.context.refresh();await started;await ui.context.refresh();release();await old;
  const item=ui.context.catalogItems(vm.runInContext("currentData",ui.context)).find(item=>item.id==="edt");
  assert.equal(item.state,"check_stale");assert.match(item.detail,/\.project изменился/);
});

test("a failed refresh does not invent a reliable time from an inconclusive attempt", async () => {
  const f=liveStatusScreen(),checkedAt=new Date().toISOString();f.ui.document.hidden=true;
  f.current.componentStatuses=[{id:"edt",state:"not_verified",checkedAt,detail:"EDT не предоставил данные."}];
  await f.ui.flush();
  f.ui.context.reportComponentRefreshFailure({component:"edt",projectRoot:f.current.values.projectRoot,instance:f.current.instance},"failure");
  const item=f.ui.context.catalogItems(f.current).find(item=>item.id==="edt");
  assert.equal(item.state,"not_verified");assert.equal(item.lastCheckedAt,undefined);
});

test("compact counters explain their composition and expose only relevant refresh and stale counts",async()=>{
  const f=liveStatusScreen();await f.ui.flush();await f.ui.elements.get("headerRefresh").onclick();
  assert.equal(f.ui.elements.get("countAll").textContent,"7");assert.match(f.ui.elements.get("countAll").title,/EDT, v8std, OpenViking/);
  assert.equal(f.ui.elements.get("countCheckingGroup").hidden,true);assert.equal(f.ui.elements.get("countStaleGroup").hidden,true);
  vm.runInContext('activeOperation={action:"refresh_readiness",component:"edt",status:"running",projectRoot:currentData.values.projectRoot,instance:currentData.instance};componentObservations.get("v8std").check.expiresAt=new Date(Date.now()-1).toISOString()',f.ui.context);
  f.ui.context.renderComponentCatalog(f.current);
  assert.equal(f.ui.elements.get("countChecking").textContent,"0");assert.equal(f.ui.elements.get("countCheckingGroup").hidden,true);
  assert.equal(f.ui.elements.get("countStale").textContent,"1");assert.equal(f.ui.elements.get("countStale").title,"v8std");assert.equal(f.ui.elements.get("countStaleGroup").hidden,false);
  f.ui.elements.get("componentsIssues").onclick();assert.equal(f.ui.elements.get("countAll").textContent,"7");
  vm.runInContext('activeOperation.status="completed";componentObservations.get("v8std").check.expiresAt=new Date(Date.now()+60000).toISOString()',f.ui.context);
  f.ui.context.renderComponentCatalog(f.current);assert.equal(f.ui.elements.get("countCheckingGroup").hidden,true);assert.equal(f.ui.elements.get("countStaleGroup").hidden,true);
});

test("durable BSL checks ignore setup expiry and unrelated revisions but respect newer server input changes",async()=>{
  const checkedAt=new Date(Date.now()-20*60000).toISOString(),proof={id:"bsl-ls",state:"ready",checkedAt,expiresAt:null,validity:"inputs",inputRevision:"basis-a"};
  const current={...read,instance:"default",settingsRevision:"r1",values:{...read.values,bslLsEnabled:true},
    readiness:{state:"stale",checkedAt,expiresAt:new Date(Date.now()-5*60000).toISOString(),checks:[{id:"bsl-ls",state:"ready"}]},
    componentChecks:[proof],summary:{components:[{id:"bsl-ls",mode:"auto",status:"ready",checkedAt}]}};
  const ui=screen(async name=>["settings.read","settings.status"].includes(name)?current:{versions:[]});await ui.flush();
  const state=()=>ui.context.catalogItems(current).find(item=>item.id==="bsl-ls").state;
  assert.equal(state(),"ready");
  ui.context.observeComponentResult({managed:[{...proof,name:"bsl-ls",ready:true,checkedAt:new Date().toISOString()}],readiness:current.readiness},
    {action:"check",projectRoot:current.values.projectRoot,instance:current.instance});
  assert.equal(vm.runInContext('componentObservations.get("bsl-ls").check.expiresAt',ui.context),null);
  current.settingsRevision="unrelated-change";ui.context.renderCurrent(current,{preserveDraft:true});assert.equal(state(),"ready");
  current.componentChecks=[{...proof,state:"check_stale",lastState:"ready",inputRevision:"basis-b",detail:"Окружение BSL LS изменилось"}];
  ui.context.renderCurrent(current,{preserveDraft:true});assert.equal(state(),"check_stale");
  current.readiness={...current.readiness,state:"ready",checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()};
  ui.context.renderCurrent(current,{preserveDraft:true});assert.equal(state(),"check_stale","newer full setup must not hide older independent BSL invalidation");
});

test("evidence expires on screen without probing, replacing drafts or expiring durable BSL",async()=>{
  const f=liveStatusScreen(),now=Date.now();await f.ui.flush();
  vm.runInContext(`Date.now=()=>${now};componentObservations.delete("edt")`,f.ui.context);
  const checkedAt=new Date(now-5000).toISOString();
  f.current.readiness={state:"ready",checkedAt,expiresAt:new Date(now+1000).toISOString(),checks:[{id:"edt",label:"EDT",state:"ready"}],
    knowledge:{ready:true,readiness:{publication:{state:"verified",gitRevision:"expiry-revision",snapshot:"expiry-snapshot"}}}};
  f.current.knowledge={mode:"transitional",provider:"openviking",collections:[],required:true};
  f.current.componentChecks=[{id:"bsl-ls",state:"ready",checkedAt,validity:"inputs",expiresAt:new Date(now+1000).toISOString()}];
  f.ui.context.renderCurrent(f.current,{preserveDraft:true});
  const badge=id=>f.ui.elements.get("headerComponentStatuses").children.find(item=>item.attributes["data-component"]===id);
  assert.equal(badge("edt").attributes["data-state"],"ready");assert.equal(badge("bsl-ls").attributes["data-state"],"ready");
  assert.match(f.ui.elements.get("knowledgeDetails").textContent,/expiry-revision/);
  const field=f.ui.elements.get("openvikingUrl");field.value="https://draft.example/mcp";field.events.input();await f.ui.flush();
  const before=f.ui.calls.filter(call=>call.method==="tools/call").length;vm.runInContext(`Date.now=()=>${now+1000}`,f.ui.context);await f.ui.tick(1000);
  assert.equal(f.ui.calls.filter(call=>call.method==="tools/call").length,before);assert.equal(f.requests.length,1);
  assert.equal(badge("edt").attributes["data-state"],"check_stale");assert.equal(badge("bsl-ls").attributes["data-state"],"ready");
  assert.match(f.ui.elements.get("readinessItems").children[0].textContent,/проверка устарела/);
  assert.doesNotMatch(f.ui.elements.get("knowledgeDetails").textContent,/expiry-revision/);assert.equal(field.value,"https://draft.example/mcp");
});

test("returning to a hidden form refreshes expired component evidence",async()=>{
  const f=liveStatusScreen(),now=Date.now();await f.ui.flush();vm.runInContext(`Date.now=()=>${now}`,f.ui.context);
  f.current.readiness={state:"ready",checkedAt:new Date(now-5000).toISOString(),expiresAt:new Date(now+1000).toISOString(),checks:[{id:"edt",state:"ready"}]};
  f.ui.context.renderCurrent(f.current,{preserveDraft:true});f.ui.document.hidden=true;f.ui.documentEvents.visibilitychange();
  const before=f.ui.calls.length;vm.runInContext(`Date.now=()=>${now+2000}`,f.ui.context);
  f.ui.document.hidden=false;f.ui.documentEvents.visibilitychange();await f.ui.flush();
  const badge=f.ui.elements.get("headerComponentStatuses").children.find(item=>item.attributes["data-component"]==="edt");
  assert.equal(badge.attributes["data-state"],"ready");assert.ok(f.ui.calls.length>before);assert.equal(f.requests.length,2);
});

test("compact component cards retain the full diagnostic in their tooltip and dialog",async()=>{
  const detail="Ошибка сервера компонента. ".repeat(30).trim(),current={...read,values:{...read.values,bslLsEnabled:true},
    summary:{components:[{id:"bsl-ls",status:"external",mode:"external"}]},componentChecks:[{id:"bsl-ls",state:"error",detail,checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()}]};
  const ui=screen(async name=>name==="settings.versions"?{versions:[]}:current);await ui.flush();
  const card=ui.elements.get("componentCatalog").children.flatMap(group=>group.children[1].children).find(card=>componentName(card)==="BSL LS");
  const reason=card.children[1].children[0];assert.equal(reason.title,detail);assert.equal(reason.children[0].textContent,detail);
  ui.context.openManagedDialog(ui.context.catalogItems(current).find(item=>item.id==="bsl-ls"),null);await ui.flush();
  assert.ok(ui.elements.get("managedDialogStatus").textContent.endsWith(detail));
  assert.equal(ui.elements.get("managedDialogState").attributes["data-tone"],"error");
  assert.equal(ui.elements.get("managedDialogDiagnostic").textContent,"Ошибка проверки");
});

test("header profile summary clears unavailable profile data and respects read-only and disabled states",async()=>{
  const f=liveStatusScreen();await f.ui.flush();
  f.current.values.openvikingEnabled=false;f.current.viewOnly=true;f.ui.context.renderCurrent(f.current);
  assert.match(f.ui.elements.get("headerProfileFacts").textContent,/Только чтение/);
  assert.equal(f.ui.elements.get("headerComponentStatuses").children.find(item=>item.attributes["data-component"]==="openviking").textContent,"OpenViking: Отключён");
  for(const [status,label]of [["invalid","Профиль содержит ошибку"],["missing","Профиль не найден"],["unselected","Профиль не выбран"]]){
    f.current.profile={status};f.ui.context.renderCurrent(f.current);
    assert.equal(f.ui.elements.get("headerProfileFacts").textContent,label);assert.equal(f.ui.elements.get("headerComponentStatuses").hidden,true);assert.equal(f.ui.elements.get("headerComponentStatuses").children.length,0);
  }
});

test("component checks refresh on load, every minute and on manual request",async()=>{
  const f=liveStatusScreen();await f.ui.flush();
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].component,undefined);
  const timer=[...f.ui.timers.values()].find(item=>item.ms>59000&&item.ms<=60000);assert.ok(timer);
  await f.ui.tick(timer.ms);assert.equal(f.requests.length,2);assert.equal(f.requests[1].component,undefined);
  assert.equal(f.ui.context.catalogItems(f.current).filter(item=>["ready","configured"].includes(item.state)).length,7);
  await f.ui.elements.get("headerRefresh").onclick();assert.equal(f.requests.length,3);assert.equal(f.requests[2].component,undefined);
  assert.match(f.ui.context.catalogItems(f.current).find(item=>item.id==="edt").detail,/проверка 3/);
  f.current.values.projectRoot="C:/fixture/second";f.current.preparationScope="C:/fixture/second#default";
  f.ui.context.renderSelectedProfile(f.current);await f.ui.flush();
  assert.equal(f.requests.length,4);assert.equal(f.requests[3].scope,"C:/fixture/second#default");
  await f.ui.elements.get("headerRefresh").onclick();await f.ui.flush();assert.equal(f.requests.length,5);assert.equal(f.requests[4].scope,"C:/fixture/second#default");
});

test("manual refresh shows the recovery path when an older foreground barrier blocks it", async () => {
  const current={...read,instance:"default",settingsRevision:"saved"}, detail="Проверка отложена. Файл блокировки: C:/state/readiness-active. См. USAGE.md.";
  const ui=screen(async name=>{
    if(["settings.read","settings.status"].includes(name))return current;
    if(name==="settings.refresh_readiness")return {id:"blocked",action:"refresh_readiness",status:"completed",projectRoot:current.values.projectRoot,instance:current.instance,
      result:{transient:true,superseded:true,detail}};
    throw new Error(name);
  },{liveRefresh:true});
  await ui.flush();await ui.flush();
  await ui.elements.get("headerRefresh").onclick();await ui.flush();
  assert.match(ui.elements.get("status").textContent,/C:\/state\/readiness-active/);
  assert.match(ui.elements.get("status").textContent,/USAGE\.md/);
});

test("manual refresh shows the recovery path when cleanup is unconfirmed", async () => {
  const current={...read,instance:"default",settingsRevision:"saved"};
  const ui=screen(async name=>{
    if(["settings.read","settings.status"].includes(name))return current;
    if(name==="settings.refresh_readiness")throw new Error("Очистка не подтверждена. Файл: C:/state/barrier. См. USAGE.md.");
    throw new Error(name);
  },{liveRefresh:true});
  await ui.flush();await ui.flush();
  await ui.elements.get("headerRefresh").onclick();await ui.flush();
  assert.match(ui.elements.get("status").textContent,/C:\/state\/barrier/);
  assert.match(ui.elements.get("status").textContent,/USAGE\.md/);
});

for (const failedResponse of [false, true]) test(`a previous profile's manual refresh ${failedResponse ? "failure" : "exception"} does not show its recovery path`, async () => {
  let current={...read,instance:"default",settingsRevision:"saved"}, hold=false, release, entered;
  const started=new Promise(done=>{entered=done;}), gate=new Promise(done=>{release=done;});
  const ui=screen(async name=>{
    if(["settings.read","settings.status"].includes(name))return current;
    if(name==="settings.refresh_readiness") {
      if(hold){hold=false;entered();await gate;if(!failedResponse)throw new Error("Старый путь C:/old/barrier USAGE.md");
        return {id:"old",action:"refresh_readiness",status:"failed",error:"Старый путь C:/old/barrier USAGE.md"};}
      return {id:"ok",action:"refresh_readiness",status:"completed",projectRoot:current.values.projectRoot,instance:current.instance,result:{componentChecks:[]}};
    }
    throw new Error(name);
  },{liveRefresh:true});
  await ui.flush();await ui.flush();hold=true;
  const pending=ui.elements.get("headerRefresh").onclick();await started;
  current={...current,values:{...current.values,projectRoot:"C:/fixture/other"},preparationScope:"C:/fixture/other#default"};
  ui.context.renderSelectedProfile(current);release();await pending;await ui.flush();
  assert.doesNotMatch(ui.elements.get("status").textContent,/C:\/old\/barrier/);
});

test("a shared near-expiry observation schedules the next refresh from its actual check time",async()=>{
  const current={...read,instance:"default",settingsRevision:"saved",values:{...read.values,edtUrl:"http://edt"}};let attempts=0;
  const ui=screen(async name=>{
    if(["settings.read","settings.status"].includes(name))return current;
    if(name==="settings.refresh_readiness"){
      const checkedAt=new Date(Date.now()-(attempts++===0?59000:0)).toISOString();
      return {id:"shared-"+attempts,action:"refresh_readiness",status:"completed",projectRoot:current.values.projectRoot,instance:current.instance,
        result:{componentChecks:[{id:"edt",state:"ready",checkedAt,expiresAt:new Date(Date.parse(checkedAt)+60000).toISOString()}]}};
    }
    throw new Error(name);
  },{liveRefresh:true});
  await ui.flush();assert.equal(attempts,1);
  const due=[...ui.timers.values()].find(timer=>timer.ms>=1000&&timer.ms<=1500);assert.ok(due,"next refresh is due near the original observation's deadline");
  await ui.tick(due.ms);assert.equal(attempts,2);
});

test("an expired evidence deadline does not cause a rapid automatic refresh loop",async()=>{
  const current={...read,instance:"default",settingsRevision:"saved"};
  const ui=screen(async name=>{
    if(["settings.read","settings.status"].includes(name))return current;
    if(name==="settings.refresh_readiness")return {id:"job",action:"refresh_readiness",status:"completed",projectRoot:current.values.projectRoot,instance:current.instance,
      result:{componentChecks:[{id:"openviking",state:"error",checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()-5000).toISOString()}]}};
    throw new Error(name);
  },{liveRefresh:true});
  await ui.flush();
  assert.ok([...ui.timers.values()].some(timer=>timer.ms>59000&&timer.ms<=60000));
  assert.ok(![...ui.timers.values()].some(timer=>timer.ms===1000));
});

test("the minute refresh reads changed saved settings before probing and preserves a draft",async()=>{
  const first={...read,instance:"default",settingsRevision:"one",values:{...read.values,edtUrl:"http://old",v8stdUrl:"http://v8std"}},
    next={...first,settingsRevision:"two",values:{...first.values,edtUrl:"http://new"}};
  let saved=first;const requests=[];
  const ui=screen(async(name,args)=>{
    requests.push(name);
    if(["settings.read","settings.status"].includes(name))return saved;
    if(name==="settings.refresh_readiness")return {id:"job",action:"refresh_readiness",status:"completed",projectRoot:saved.values.projectRoot,instance:saved.instance,
      result:{componentChecks:[{id:"edt",state:saved===next?"error":"ready",detail:saved.values.edtUrl,checkedAt:new Date().toISOString()}]}};
    throw new Error(name);
  },{liveRefresh:true});
  await ui.flush();assert.equal(headerState(ui,"EDT"),"Готов");
  ui.elements.get("edtUrl").value="http://draft";ui.elements.get("edtUrl").events.input();saved=next;
  const start=requests.length;await ui.tick(60000);
  assert.deepEqual(requests.slice(start),["settings.status","settings.refresh_readiness"]);
  assert.equal(headerState(ui,"EDT"),"Ошибка");assert.equal(ui.elements.get("edtUrl").value,"http://draft");
  assert.equal(vm.runInContext("currentData.values.edtUrl",ui.context),"http://new");
});

test("a superseded refresh rereads settings and retries once",async()=>{
  let attempts=0;const current={...read,instance:"default",settingsRevision:"saved",values:{...read.values,edtUrl:"http://edt"}};
  const ui=screen(async name=>{
    if(["settings.read","settings.status"].includes(name))return current;
    if(name==="settings.refresh_readiness")return {id:"job-"+(++attempts),action:"refresh_readiness",status:"completed",projectRoot:current.values.projectRoot,instance:current.instance,
      result:attempts===1?{superseded:true}:{componentChecks:[{id:"edt",state:"ready",checkedAt:new Date().toISOString()}]}};
    throw new Error(name);
  },{liveRefresh:true});
  await ui.flush();await ui.flush();assert.equal(attempts,2);assert.equal(headerState(ui,"EDT"),"Готов");
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.status").length,1);
});

test("repeated supersession does not leave an old ready status or retry without limit",async()=>{
  let attempts=0;const current={...read,instance:"default",settingsRevision:"saved",values:{...read.values,edtUrl:"http://edt"},
    componentChecks:[{id:"edt",state:"ready",checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()}]};
  const ui=screen(async name=>{
    if(["settings.read","settings.status"].includes(name))return current;
    if(name==="settings.refresh_readiness")return {id:"job-"+(++attempts),action:"refresh_readiness",status:"completed",projectRoot:current.values.projectRoot,instance:current.instance,result:{superseded:true}};
    throw new Error(name);
  },{liveRefresh:true});
  await ui.flush();await ui.flush();assert.equal(attempts,2);assert.equal(ui.context.catalogItems(current).find(item=>item.id==="edt").state,"not_verified");
});

test("a removed connection is not hidden by an earlier observation, while a draft probe remains visible",async()=>{
  const f=liveStatusScreen();await f.ui.flush();
  f.current.values.edtUrl="";f.current.settingsRevision="updated";f.ui.context.renderCurrent(f.current,{preserveDraft:true});
  assert.equal(f.ui.context.catalogItems(f.current).find(item=>item.id==="edt").state,"missing_config");
  f.ui.elements.get("edtUrl").value="http://draft";f.ui.elements.get("edtUrl").events.input();
  f.ui.context.observeComponentResult({draft:true,componentChecks:[{id:"edt",state:"ready",checkedAt:new Date(Date.now()+100).toISOString()}]},
    {action:"probe",component:"edt",projectRoot:f.current.values.projectRoot,instance:f.current.instance});
  assert.equal(f.ui.context.catalogItems(f.current).find(item=>item.id==="edt").state,"draft_verified");
});

test("hiding during a status read defers the component probes until the form is visible",async()=>{
  let release;const gate=new Promise(done=>{release=done;}),current={...read,instance:"default"};let probes=0;
  const ui=screen(async name=>{
    if(name==="settings.read")return current;
    if(name==="settings.status"){await gate;return current;}
    if(name==="settings.refresh_readiness"){probes++;return {id:"job",action:"refresh_readiness",status:"completed",projectRoot:current.values.projectRoot,instance:current.instance,result:{componentChecks:[]}};}
    throw new Error(name);
  },{liveRefresh:true});
  await ui.flush();assert.equal(probes,1);await ui.tick(60000);
  ui.document.hidden=true;ui.documentEvents.visibilitychange();release();await ui.flush();assert.equal(probes,1);
  ui.document.hidden=false;ui.documentEvents.visibilitychange();await ui.flush();assert.equal(probes,2);
});

test("opening a profile waits for an existing background refresh before starting another",async()=>{
  let finish;const gate=new Promise(done=>{finish=done;}),current={...read,instance:"default",values:{...read.values,edtUrl:"http://edt"}};
  const existing={id:"existing",action:"refresh_readiness",status:"running",projectRoot:current.values.projectRoot,instance:current.instance};let started=0;
  const ui=screen(async(name,args)=>{
    if(["settings.read","settings.status"].includes(name))return {...current,operation:existing};
    if(name==="settings.operation"&&args.operationId==="existing"){await gate;return {...existing,status:"completed",result:{componentChecks:[]}};}
    if(name==="settings.refresh_readiness"){started++;return {id:"new",action:"refresh_readiness",status:"completed",projectRoot:current.values.projectRoot,instance:current.instance,
      result:{componentChecks:[{id:"edt",state:"ready",checkedAt:new Date().toISOString()}]}};}
    throw new Error(name);
  },{liveRefresh:true});
  await ui.flush();assert.equal(started,0);finish();await ui.flush();await ui.flush();
  assert.equal(started,1);assert.equal(headerState(ui,"EDT"),"Готов");
});

test("Windows separator variants identify the same operation without crossing project or instance boundaries",async()=>{
  const current={...read,instance:"default",values:{...read.values,edtUrl:"http://edt"}};
  const ui=screen(async()=>current);await ui.flush();
  const op={action:"refresh_readiness",status:"running",projectRoot:"C:\\fixture\\project",instance:"default"};
  vm.runInContext('activeOperation={action:"refresh_readiness",status:"running",projectRoot:"C:\\\\fixture\\\\project",instance:"default"}',ui.context);
  ui.context.renderComponentCatalog(current);assert.equal(ui.context.catalogItems(current).find(item=>item.id==="edt").state,"not_checked");
  ui.context.observeComponentResult({componentChecks:[{id:"edt",state:"error",checkedAt:new Date().toISOString()}]},{...op,status:"completed"});
  vm.runInContext('activeOperation.status="completed"',ui.context);
  assert.equal(ui.context.catalogItems(current).find(item=>item.id==="edt").state,"error");
  assert.equal(ui.context.operationMatchesProfile({...op,projectRoot:"C:\\fixture\\other"}),false);
  assert.equal(ui.context.operationMatchesProfile({...op,instance:"other"}),false);
});

test("automatic refresh replaces expired evidence for all seven components",async()=>{
  const f=liveStatusScreen(), checkedAt=new Date(Date.now()-16*60000).toISOString(), expiresAt=new Date(Date.now()-60000).toISOString();
  f.current.componentChecks=["edt","v8std","openviking","code-index","bsl-ls","yaxunit","vanessa"].map(id=>({id,state:"check_stale",checkedAt,expiresAt}));
  await f.ui.flush();assert.equal(f.requests.length,1);
  assert.equal(f.ui.context.catalogItems(f.current).filter(item=>["ready","configured"].includes(item.state)).length,7);
  await f.ui.tick(60000);assert.equal(f.requests.length,2);
  assert.equal(f.ui.context.catalogItems(f.current).filter(item=>["ready","configured"].includes(item.state)).length,7);
});

for(const action of ["check","rebuild_index"])test(`automatic status refresh continues during a long ${action}`,async()=>{
  const f=liveStatusScreen();await f.ui.flush();
  vm.runInContext(`activeOperation={id:"foreground",action:${JSON.stringify(action)},status:"running",startedAt:new Date(Date.now()-1000).toISOString(),projectRoot:currentData.values.projectRoot,instance:currentData.instance};polling=true`,f.ui.context);
  await f.ui.tick(60000);assert.equal(f.requests.length,2);assert.equal(f.requests[1].component,undefined);
  assert.equal(f.ui.context.catalogItems(f.current).find(item=>item.id==="edt").state,"ready");
  assert.equal(vm.runInContext("activeOperation.id",f.ui.context),"foreground");
  assert.equal(f.ui.context.catalogItems(f.current).find(item=>item.id==="vanessa").state,"ready");
});

test("an expired setup is shown as checking while the full operation continues",async()=>{
  const f=liveStatusScreen(),now=Date.now();f.current.readiness={state:"ready",checkedAt:new Date(now-16*60000).toISOString(),expiresAt:new Date(now-60000).toISOString(),checks:[{id:"edt",label:"EDT",state:"ready"}]};
  await f.ui.flush();vm.runInContext('activeOperation={id:"foreground",action:"check",status:"running",startedAt:new Date(Date.now()-1000).toISOString(),projectRoot:currentData.values.projectRoot,instance:currentData.instance}',f.ui.context);
  f.ui.context.renderReadiness();await f.ui.tick(60000);
  assert.equal(f.ui.elements.get("headerStatusTitle").textContent,"Проверяется");
  assert.match(f.ui.elements.get("readinessItems").children[0].textContent,/проверяется/);
  assert.equal(f.ui.context.catalogItems(f.current).find(item=>item.id==="edt").state,"ready");
});

test("an old automatic readiness result cannot overwrite a newer settings revision",async()=>{
  let release;const gate=new Promise(done=>{release=done;});
  const now=Date.now(),current={...read,instance:"default",settingsRevision:"old",readiness:{state:"blocked",checkedAt:new Date(now).toISOString(),checks:[]}};
  const ui=screen(async(name)=>{
    if(["settings.read","settings.status"].includes(name))return current;
    if(name==="settings.refresh_readiness"){await gate;return {id:"old",action:"refresh_readiness",status:"completed",projectRoot:current.values.projectRoot,instance:current.instance,result:{readiness:{state:"ready",checkedAt:new Date(now+1000).toISOString(),checks:[]},componentChecks:[]}};}
    throw new Error(name);
  },{liveRefresh:true});
  await ui.flush();const pending=ui.context.queueComponentRefresh();await ui.flush();
  current.settingsRevision="new";current.readiness={state:"blocked",checkedAt:new Date(now+500).toISOString(),checks:[]};ui.context.renderCurrent(current,{preserveDraft:true});
  release();await pending;assert.equal(vm.runInContext("currentData.readiness.state",ui.context),"blocked");
});

test("slow automatic refreshes do not overlap or block a user action",async()=>{
  const f=liveStatusScreen({hold:true});await f.ui.flush();await f.ui.tick(60000);assert.equal(f.requests.length,1);
  await f.ui.tick(60000);assert.equal(f.requests.length,1,"a second tick must not duplicate an in-flight refresh");
  f.ui.context.openConnectionDialog({id:"edt",name:"EDT"},null);assert.equal(f.ui.elements.get("probeButton").disabled,false);
  const probe=f.ui.elements.get("probeButton").onclick();await probe;await f.ui.flush();
  assert.equal(f.requests.length,2);assert.equal(f.requests[1].component,"edt");
  f.release();await f.ui.flush();assert.match(f.ui.elements.get("probeResult").textContent,/edt · проверка 2/);
});

for(const action of ["check","rebuild_index"])test(`a running background refresh cannot swallow a manual ${action}`,async()=>{
  let reads=0;
  const current={...read,instance:"default",profile:{...read.profile,repositories:[{id:"main",path:"src",edt_project:"Main"}]},values:{...read.values,codeIndexEnabled:true},summary:{components:[{id:"code-index",mode:"managed",status:"running"}]}};
  const ui=screen(async(name,args)=>{
    if(name==="settings.read")return ++reads===1?current:{...current,operation:{id:"background",action:"refresh_readiness",status:"running",projectRoot:current.values.projectRoot,instance:current.instance}};
    if(name==="settings.run_check")return {id:"manual",status:"running"};
    if(name==="settings.rebuild_index")return {id:"manual",status:"running"};
    if(name==="settings.operation")return {id:"manual",action:action==="check"?"check":"rebuild_index",status:"completed",projectRoot:current.values.projectRoot,instance:current.instance,result:action==="check"?{managed:[],external:{}}:{repository:"main",edtProject:"Main",state:"ready"}};
    throw new Error(name);
  });
  await ui.flush();ui.elements.get("indexRepository").value="main";
  await ui.elements.get(action==="check"?"readinessButton":"rebuildIndexButton").onclick();
  assert.equal(ui.calls.filter(call=>call.params?.name===(action==="check"?"settings.run_check":"settings.rebuild_index")).length,1);
});

test("a late rejected background poll cannot replace a foreground operation",async()=>{
  let rejectBackground;
  const current={...read,instance:"default"};
  const ui=screen(async(name,args)=>{
    if(["settings.read","settings.status"].includes(name))return current;
    if(name==="settings.refresh_readiness")return {id:"background",action:"refresh_readiness",status:"running",projectRoot:current.values.projectRoot,instance:current.instance};
    if(name==="settings.run_check")return {id:"manual",status:"running"};
    if(name==="settings.operation"&&args.operationId==="background")return new Promise((_,reject)=>{rejectBackground=reject;});
    if(name==="settings.operation"&&args.operationId==="manual")return {id:"manual",action:"check",status:"running",projectRoot:current.values.projectRoot,instance:current.instance};
    throw new Error(name);
  },{liveRefresh:true});
  await ui.flush();const background=ui.context.queueComponentRefresh();await ui.flush();assert.equal(typeof rejectBackground,"function");
  await ui.elements.get("readinessButton").onclick();await ui.flush();assert.match(ui.elements.get("status").textContent,/Операция выполняется/);
  rejectBackground(new Error("late background failure"));await background;await ui.flush();
  assert.match(ui.elements.get("status").textContent,/Операция выполняется/);
  assert.equal(vm.runInContext("activeOperation.id",ui.context),"manual");
  assert.equal([...ui.timers.values()].filter(timer=>timer.ms===1000).length,1);
});

for(const id of ["edt","v8std","openviking","code-index","bsl-ls","yaxunit","vanessa"])test(`opening ${id} is passive and its button checks only that component`,async()=>{
  const f=liveStatusScreen();await f.ui.flush();const item=f.ui.context.catalogItems(f.current).find(item=>item.id===id);
  const requestCount=f.requests.length;
  const before=JSON.parse(JSON.stringify(f.ui.context.catalogItems(f.current).filter(item=>item.id!==id)));
  if(item.kind==="external")f.ui.context.openConnectionDialog(item,null);else if(item.kind==="managed")f.ui.context.openManagedDialog(item,null);else await f.ui.context.openTestingSettings(id,null);
  await f.ui.flush();assert.equal(f.requests.length,requestCount);
  assert.deepEqual(JSON.parse(JSON.stringify(f.ui.context.catalogItems(f.current).filter(item=>item.id!==id))),before);
  await f.ui.elements.get(item.kind==="external"?"probeButton":item.kind==="managed"?"managedProbeButton":"testingProbeButton").onclick();
  assert.equal(f.requests.length,requestCount+1);assert.equal(f.requests.at(-1).component,id);
  assert.match(f.ui.context.catalogItems(f.current).find(item=>item.id===id).detail,/проверка 2/);
  if(id==="code-index"){
    assert.equal(f.ui.elements.get("connections").hidden,true);
    assert.match(f.ui.elements.get("managedDialogCheckedAt").textContent,/Последняя попытка/);
    assert.deepEqual(f.ui.elements.get("managedProjectStates").children.map(row=>row.textContent),["Product: готов"]);
    assert.equal(f.ui.elements.get("managedProjectStates").hidden,false);
    vm.runInContext('componentObservations.get("code-index").check.expiresAt=new Date(Date.now()-1).toISOString()',f.ui.context);
    f.ui.context.renderDialogStates();
    assert.equal(f.ui.elements.get("managedProjectStates").hidden,true);
    assert.equal(f.ui.elements.get("managedProjectStates").children.length,0);
    f.ui.elements.get("managedDialog").close();
    f.ui.context.openManagedDialog(f.ui.context.catalogItems(f.current).find(item=>item.id==="bsl-ls"),null);await f.ui.flush();
    assert.equal(f.ui.elements.get("managedProjectStates").hidden,true);
    assert.equal(f.ui.elements.get("connections").hidden,false);
  }
});

test("manual OpenViking check works with unchanged saved fields",async()=>{
  const f=liveStatusScreen();await f.ui.flush();
  f.ui.context.openConnectionDialog({id:"openviking",name:"OpenViking"},null);
  await f.ui.elements.get("probeButton").onclick();
  assert.equal(f.requests.length,2);assert.equal(f.requests.at(-1).component,"openviking");
  assert.match(f.ui.elements.get("probeResult").textContent,/openviking · проверка 2/);
});

test("an in-flight manual refresh is not duplicated by opening cards",async()=>{
  const f=liveStatusScreen({hold:true});await f.ui.flush();const refresh=f.ui.elements.get("headerRefresh").onclick();await f.ui.flush();assert.equal(f.requests.length,1);
  f.ui.context.openConnectionDialog({id:"edt",name:"EDT"},null);await f.ui.flush();
  const duplicate=f.ui.context.queueComponentRefresh();await f.ui.flush();assert.equal(f.requests.length,1);
  f.release();await Promise.all([refresh,duplicate]);await f.ui.flush();assert.equal(f.requests.length,1);
  assert.match(f.ui.elements.get("probeResult").textContent,/edt · проверка 1/);
});

test("automatic and manual refresh preserve drafts across hidden and visible forms",async()=>{
  const f=liveStatusScreen();await f.ui.flush();
  f.ui.elements.get("edtUrl").value="http://draft";f.ui.elements.get("edtUrl").events.input();
  f.ui.elements.get("settingsText").value="draft YAML";f.ui.elements.get("settingsText").events.input();f.ui.context.show("editor");
  await f.ui.elements.get("headerRefresh").onclick();assert.equal(f.requests.length,2);assert.equal(f.requests.at(-1).connections,undefined);
  assert.equal(f.ui.elements.get("edtUrl").value,"http://draft");assert.equal(f.ui.elements.get("settingsText").value,"draft YAML");
  assert.equal(f.ui.elements.get("editorPanel").hidden,false);
  f.ui.document.hidden=true;f.ui.documentEvents.visibilitychange();assert.equal([...f.ui.timers.values()].filter(timer=>timer.ms===60000).length,0);
  f.ui.document.hidden=false;f.ui.documentEvents.visibilitychange();await f.ui.flush();assert.equal(f.requests.length,3);
  assert.equal(f.ui.elements.get("edtUrl").value,"http://draft");assert.equal(f.ui.elements.get("settingsText").value,"draft YAML");
  f.ui.lifecycle.pagehide();await f.ui.context.refreshStatus();assert.equal(f.requests.length,3);
});

test("a queued manual refresh discards a late result from the previous profile",async()=>{
  const f=liveStatusScreen();await f.ui.flush();f.holdNext();const pending=f.ui.context.queueComponentRefresh();await f.ui.flush();
  f.current.values.projectRoot="C:/fixture/new-profile";f.current.preparationScope="C:/fixture/new-profile#default";f.ui.context.renderSelectedProfile(f.current);
  const next=f.ui.context.queueComponentRefresh();f.release();await Promise.all([pending,next]);await f.ui.flush();
  assert.equal(f.requests.at(-1).scope,"C:/fixture/new-profile#default");
  assert.match(f.ui.context.catalogItems(f.current).find(item=>item.id==="edt").detail,/проверка 3/);
});

test("a failed status refresh marks the components unverified and retries automatically",async()=>{
  const f=liveStatusScreen();await f.ui.flush();await f.ui.elements.get("headerRefresh").onclick();
  assert.equal(headerState(f.ui,"Code Index"),"Готов");assert.equal(headerState(f.ui,"BSL LS"),"Совместимость API проверена");
  f.fail("Сервер недоступен");await f.ui.tick(60000);assert.match(f.ui.elements.get("headerRefresh").title,/Не удалось обновить состояние/);
  assert.ok(f.ui.context.catalogItems(f.current).every(item=>item.state==="not_verified"));
  f.fail(null);await f.ui.tick(60000);
  assert.equal(f.requests.length,4);assert.ok(f.ui.context.catalogItems(f.current).every(item=>["ready","configured"].includes(item.state)));
});

for(const status of ["missing","invalid","viewOnly"])test(`automatic component probes respect ${status} profile restrictions`,async()=>{
  const f=liveStatusScreen();if(status==="viewOnly")f.current.viewOnly=true;else f.current.profile={...f.current.profile,status};
  await f.ui.flush();await f.ui.context.refreshStatus();assert.equal(f.requests.length,0);
});

test("a background refresh resumes polling after another operation releases the poller",async()=>{
  const f=liveStatusScreen();await f.ui.flush();await f.ui.elements.get("headerRefresh").onclick();f.holdNext();
  const update=f.ui.context.queueComponentRefresh();await f.ui.flush();f.holdPoll();
  const foreground=f.ui.context.pollOperation("foreground");await f.ui.flush();f.release();await f.ui.flush();
  f.releasePoll();await foreground;await update;
  assert.equal(f.requests.length,3);assert.equal(vm.runInContext("componentRefresh",f.ui.context),null);
  assert.match(f.ui.context.catalogItems(f.current).find(item=>item.id==="edt").detail,/проверка 3/);
});

test("a failed background poll preserves its diagnostic and waits for the next refresh",async()=>{
  const f=liveStatusScreen({running:true});f.failPoll(true);await f.ui.flush();
  await f.ui.elements.get("headerRefresh").onclick();
  assert.equal(f.requests.length,2);assert.equal(f.ui.context.catalogItems(f.current).find(item=>item.id==="edt").state,"not_verified");
  assert.match(f.ui.elements.get("headerRefresh").title,/Не удалось получить результат/);
  f.failPoll(false);await f.ui.elements.get("headerRefresh").onclick();assert.equal(f.requests.length,3);
  assert.equal(f.ui.context.catalogItems(f.current).find(item=>item.id==="edt").state,"ready");
});

test("components have no duplicate overview or standalone service disclosure", () => {
  assert.doesNotMatch(html, /overviewDetails|managedSettings|overview-details|managed-settings|Сведения о проекте и проверка готовности|Управление сервисами и версиями/);
  assert.equal([...html.matchAll(/id="readinessButton"/g)].length, 1);
  for (const id of ["managedControlsHolder", "javaSettingsPanel", "versionPicker", "indexActions", "testingDialog"]) assert.match(html, new RegExp(`id="${id}"`));
});

for (const statuses of [[], ["loaded"], ["invalid"], ["missing"], ["unavailable"], ["loaded", "loaded"]]) test(`global settings history selection: ${statuses.join(",") || "empty"}`, async () => {
  const history = statuses.map((status, i) => ({ status, projectRoot: `C:/history/${i}` }));
  let selected = null;
  const ui = screen(async (name, args) => {
    if (name === "settings.read") return { ...read, values: { projectRoot: "" }, profile: { status: "unselected" }, projectSelection: { locked: false }, profileHistory: history };
    if (name === "settings.select_profile") { selected = args.projectRoot; return { ...read, values: { projectRoot: selected }, profile: { ...read.profile, status: statuses[0] === "unavailable" ? "missing" : statuses[0], detail: "Ошибка единственного профиля" }, projectSelection: { locked: false } }; }
    throw new Error(name);
  });
  await ui.flush(); await ui.flush();
  assert.equal(selected, statuses.length === 1 ? history[0].projectRoot : null);
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.select_profile").length, statuses.length === 1 ? 1 : 0);
  if (statuses[0] === "invalid") { assert.equal(ui.elements.get("profileError").hidden, false); assert.equal(ui.elements.get("profileError").open, true); assert.match(ui.elements.get("profileErrorText").textContent, /Ошибка единственного профиля/); assert.match(ui.elements.get("status").textContent, /Ошибка единственного профиля/); }
  if (statuses.length > 1) assert.equal(ui.elements.get("profileBrowser").hidden, false);
  assert.equal(ui.calls.filter(call => ["settings.update", "settings.run_check", "settings.probe_connections"].includes(call.params?.name)).length, 0);
});

test("history never autoselects a profile for a chat or an unresolved selection", async () => {
  for (const selection of [{ locked: true }, { locked: false, detail: "Каталог неоднозначен" }]) {
    const ui = screen(async name => { assert.equal(name, "settings.read"); return { ...read, values: { projectRoot: "" }, profile: { status: "unselected" }, projectSelection: selection, profileHistory: [{ projectRoot: "C:/history", status: "loaded" }] }; });
    await ui.flush(); assert.equal(ui.calls.filter(call => call.params?.name === "settings.select_profile").length, 0);
  }
});

for (const late of [false, true]) test(`global settings restore a sole profile when entry metadata is text-only (${late ? "late" : "early"})`, async () => {
  let releaseRead;
  const empty = { ...read, values: { projectRoot: "" }, profile: { status: "unselected" }, projectSelection: { locked: false },
    profileHistory: [{ projectRoot: read.values.projectRoot, status: "loaded" }] };
  const ui = screen(async (name, args) => {
    if (name === "settings.read") return late ? empty : new Promise(resolve => { releaseRead = () => resolve(empty); });
    if (name === "settings.select_profile") { assert.equal(args.projectRoot, read.values.projectRoot); return read; }
    throw new Error(name);
  }, { navigation: "project" });
  await ui.flush();
  ui.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: {
    content: [{ type: "text", text: JSON.stringify({ mode: "profile", navigation: "profiles", projectRoot: "" }) }] } });
  if (!late) releaseRead();
  await ui.flush(); await ui.flush();
  assert.equal(ui.elements.get("profileTitle").textContent, "Project");
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.select_profile").length, 1);
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.refresh_readiness").length, 1);
});

test("text-only chat entry never selects the only profile from history", async () => {
  const ui = screen(async name => {
    assert.equal(name, "settings.read");
    return { ...read, values: { projectRoot: "" }, profile: { status: "unselected" }, projectSelection: { locked: false },
      profileHistory: [{ projectRoot: read.values.projectRoot, status: "loaded" }] };
  }, { navigation: "project" });
  await ui.flush();
  ui.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: {
    content: [{ type: "text", text: JSON.stringify({ mode: "profile", navigation: "project", projectRoot: "" }) }] } });
  await ui.flush();
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.select_profile").length, 0);
});

test("global text-only entry selects the sole saved profile through MCP without selecting it in another chat", async t => {
  const f = fixture(t); f.save();
  assert.equal(remember_profile(f.state, f.root, profile_state(f.root)), true);
  const env = { ...f.env, EDT_AI_PROJECT_ROOT: "" };
  const app = new McpClient([process.execPath, path.join(ROOT, "mcp/settings.mjs")], ROOT, env, 10);
  const chat = new McpClient([process.execPath, path.join(ROOT, "mcp/settings.mjs")], ROOT, env, 10);
  f.clients.push(app, chat); app.roots = []; chat.roots = [];
  await app.initialize(); await chat.initialize();
  const entry = await app.call("settings.open", {});
  const ui = screen((name, args, meta) => app.request("tools/call", { name, arguments: args, ...(meta ? { _meta: meta } : {}) }),
    { navigation: "project", rawResults: true });
  const deadline = Date.now() + 10000;
  while (ui.elements.get("profileTitle").textContent !== "Профиль не выбран") {
    if (Date.now() > deadline) throw new Error("Initial unselected settings view did not load");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  ui.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { content: entry.content } });
  while (ui.elements.get("profileTitle").textContent !== f.profile.project.id) {
    if (Date.now() > deadline) throw new Error("The sole profile was not restored through MCP");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.select_profile").length, 1);
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.refresh_readiness").length, 1);
  const otherChat = (await chat.call("settings.read", {})).structuredContent;
  assert.equal(otherChat.values.projectRoot, "");
  assert.equal(otherChat.projectSelection.status, "unselected");
});

test("component evidence keeps success and errors until its inputs, lifetime or scope change", async () => {
  const checkedAt = new Date().toISOString(), expiresAt = new Date(Date.now() + 60000).toISOString();
  const current = { ...read, instance: "default", settingsRevision: "r1", values: { ...read.values, edtUrl: "http://edt", v8stdUrl: "http://v8std" }, componentChecks: [
    { id: "edt", state: "ready", checkedAt, expiresAt }, { id: "bsl-ls", state: "error", detail: "Ошибка API", checkedAt, expiresAt }], summary: { components: [{ id: "bsl-ls", status: "not_checked" }] } };
  const ui = screen(async () => current); await ui.flush();
  const state = id => ui.context.catalogItems(current).find(item => item.id === id).state;
  assert.equal(state("edt"), "ready"); assert.equal(state("bsl-ls"), "error");
  await ui.context.refresh(); assert.equal(state("edt"), "ready");
  current.componentChecks[0].expiresAt = new Date(Date.now() - 1).toISOString(); assert.equal(state("edt"), "check_stale");
  current.componentChecks[1].state = "check_stale"; assert.equal(state("bsl-ls"), "check_stale");
  current.componentChecks = []; current.instance = "other"; ui.context.renderCurrent(current); assert.equal(state("edt"), "not_checked");
  current.readiness = { state: "ready", checks: [] }; ui.context.renderCurrent(current); assert.notEqual(ui.elements.get("headerStatusTitle").textContent, "Готово");
});

test("YaXUnit and Vanessa save from their dialogs through the real YAML preview/apply without navigating or losing other drafts", async t => {
  const f = fixture(t);
  f.profile.testing.yaxunit_config = { repository_id: "product", runner: "edt", results: "test-results" };
  f.profile.testing.vanessa_config = { repository_id: "product", runtime_profile: "vanessa.json", features: "features", results: "ui-results", server_name: "vanessa" };
  f.save(); const client = await session(t, "mcp/settings.mjs", [], f);
  const ui = screen((name, args, meta) => client.request("tools/call", { name, arguments: args, _meta: meta }), { navigation: "project", rawResults: true });
  ui.document.hidden = true;
  const until = async predicate => { const deadline = Date.now() + 10000; while (!predicate()) { assert.ok(Date.now() < deadline, ui.elements.get("status").textContent); await new Promise(resolve => setTimeout(resolve, 20)); } };
  const controls = () => { const found = []; const visit = node => { if (["input", "select"].includes(node.tag)) found.push(node); for (const child of node.children || []) visit(child); }; visit(ui.elements.get("jsonTree")); return found; };
  await until(() => ui.elements.get("profileTitle").textContent === f.profile.project.id);
  ui.elements.get("v8stdUrl").value = "http://unsaved/mcp"; ui.elements.get("v8stdUrl").events.input();
  for (const id of ["yaxunit", "vanessa"]) {
    await ui.context.openTestingSettings(id, null);
    await until(() => controls().some(input => input.attributes?.["aria-label"] === `testing.${id}`));
    assert.equal(ui.elements.get("checkPanel").hidden, false); assert.equal(ui.elements.get("testingDialog").open, true);
    const inputs = controls(); assert.equal(inputs.some(input => input.attributes?.["aria-label"] === `testing.${id === "yaxunit" ? "vanessa" : "yaxunit"}`), false);
    ui.elements.get("settingsText").value += "# unrelated draft comment\n";
    ui.elements.get("settingsText").events.input();
    const toggle=controls().find(input=>input.attributes?.["aria-label"]===`testing.${id}`);
    assert.equal(toggle.type,"checkbox");assert.equal(toggle.attributes.role,"switch");
    toggle.checked=true;await toggle.onchange();
    await ui.elements.get("reviewEditButton").onclick(); assert.equal(ui.elements.get("preview").hidden, false);
    await ui.elements.get("applyButton").onclick();
    assert.equal(load(path.join(f.root, ".ai/project.yaml")).testing[id], true, ui.elements.get("status").textContent + "\n" + ui.elements.get("editorValidation").textContent);
    assert.match(fs.readFileSync(path.join(f.root, ".ai/project.yaml"), "utf8"), /unrelated draft comment/);
    assert.equal(ui.elements.get("v8stdUrl").value, "http://unsaved/mcp");
    assert.equal(ui.elements.get("checkPanel").hidden, false); assert.equal(ui.elements.get("testingDialog").open, true);
    ui.elements.get("testingDialogClose").onclick();
    assert.equal(ui.elements.get("editorControls").parentElement, ui.elements.get("editorControlsHolder"));
  }
});

for (const id of ["edt", "v8std", "openviking", "code-index", "bsl-ls", "yaxunit", "vanessa"]) test(`the ${id} dialog probes only its component and updates its card`, async () => {
  const current = { ...read, instance: "default", settingsRevision: "before", values: { ...read.values, edtUrl: "http://edt", v8stdUrl: "http://v8std", openvikingEnabled: true, openvikingUrl: "http://knowledge", codeIndexEnabled: true, bslLsEnabled: true },
    profile: { ...read.profile, testing: { yaxunit: true, vanessa: true } }, testing: { yaxunit_config: {}, vanessa_config: {} }, summary: { components: [] }, readiness: { state: "not_checked" } };
  const ui = screen(async (name, args) => {
    if (["settings.read", "settings.status"].includes(name)) return current;
    if (name === "settings.versions") return { component: args.component, versions: [{ version: "1.0" }] };
    if (name === "settings.edit") return { text: "testing: {}\n", format: "yaml", baseRevision: "base", layerScope: "profile" };
    if (name === "settings.document_fields") return new SettingsBackend("unused", "unused").main({ action: "document_fields", ...args });
    if (name === "settings.probe_connections") {
      assert.equal(args.component, id); assert.ok(Object.keys(args.connections || {}).every(key => key === id));
      return { id: "component-probe", component: id, status: "running" };
    }
    if (name === "settings.operation") return { id: "component-probe", component: id, action: "probe", status: "completed", projectRoot: current.values.projectRoot, instance: current.instance,
      result: { external: {}, componentChecks: [{ id, state: id === "yaxunit" ? "configured" : "ready", detail: "Проверен выбранный компонент" }] } };
    throw new Error(name);
  }); await ui.flush();
  const before = JSON.parse(JSON.stringify(ui.context.catalogItems(current))).filter(item => item.id !== id);
  const item = ui.context.catalogItems(current).find(item => item.id === id);
  if (item.kind === "external") ui.context.openConnectionDialog(item, null);
  else if (item.kind === "managed") ui.context.openManagedDialog(item, null);
  else await ui.context.openTestingSettings(id, null);
  await ui.elements.get(item.kind === "external" ? "probeButton" : item.kind === "managed" ? "managedProbeButton" : "testingProbeButton").onclick();
  const after = JSON.parse(JSON.stringify(ui.context.catalogItems(current)));
  assert.deepEqual(after.filter(item => item.id !== id), before);
  assert.equal(after.find(item => item.id === id).state, id === "yaxunit" ? "configured" : "ready");
  const prefix=item.kind==="external"?"componentDialog":item.kind==="managed"?"managedDialog":"testingDialog";
  assert.equal(ui.elements.get(prefix+"State").attributes["data-state"],id==="yaxunit"?"configured":"ready");
  assert.equal(ui.elements.get(prefix+"State").attributes["data-tone"],id==="yaxunit"?"warning":"good");
  const refresh=ui.elements.get(item.kind==="external"?"probeButton":item.kind==="managed"?"managedProbeButton":"testingProbeButton");
  assert.equal(refresh.attributes["aria-label"],id==="yaxunit"?"Проверить настройки запуска YaXUnit":id==="vanessa"?"Проверить менеджер Vanessa":"Проверить "+item.name);assert.equal(refresh.attributes["aria-busy"],"false");
  assert.match(ui.elements.get(item.kind === "external" ? "probeResult" : item.kind === "managed" ? "managedDialogStatus" : "testingDialogStatus").textContent, /Проверен выбранный компонент/);
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.probe_connections").length, 1);
  assert.equal(ui.calls.filter(call => ["settings.update", "settings.run_check"].includes(call.params?.name)).length, 0);
  assert.ok(ui.calls.filter(call => call.params?.name === "settings.refresh_readiness").every(call => !call.params.arguments.component || call.params.arguments.component === id));
});

test("EDT building evidence has an actionable state instead of an unconfirmed connection", async () => {
  const current={...read,instance:"default",values:{...read.values,edtUrl:"http://edt"},componentChecks:[{id:"edt",state:"building",detail:"Тестовый проект: EDT сообщает о сборке проекта",checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()}]};
  const ui=screen(async()=>current);await ui.flush();
  const item=ui.context.catalogItems(current).find(item=>item.id==="edt");ui.context.openConnectionDialog(item,null);
  assert.equal(ui.elements.get("componentDialogDiagnostic").textContent,"Идёт сборка EDT-проекта");
  assert.equal(ui.elements.get("componentDialogState").attributes["data-tone"],"warning");
  assert.match(ui.elements.get("probeResult").textContent,/EDT сообщает о сборке/);
  const card=ui.elements.get("componentCatalog").children.flatMap(group=>group.children[1].children).find(card=>componentName(card)==="EDT");
  assert.equal(card.children[0].children[1].textContent,"Идёт сборка");assert.equal(ui.elements.get("headerStatusTitle").textContent,"Требует внимания");
});

test("settings UI saves, previews a local document, and renames through the real MCP server", async t => {
  const f = fixture(t); f.save();
  const shared = path.join(f.root, ".ai/project.yaml"), sharedBefore = fs.readFileSync(shared);
  const client = await session(t, "mcp/settings.mjs", [], f);
  // The DOM and host transport are simulated, but every settings request is
  // handled by the real MCP entrypoint and backend in an isolated profile.
  const ui = screen((name, args, meta) => client.request("tools/call", { name, arguments: args, ...(meta ? { _meta: meta } : {}) }),
    { navigation: "project", rawResults: true });
  ui.document.hidden = true; // No automatic readiness operation in this test.
  const until = async (predicate, label) => {
    const end = Date.now() + 10000;
    while (!predicate()) {
      if (Date.now() > end) throw new Error(`Timed out waiting for ${label}: ${ui.elements.get("status").textContent}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  await until(() => ui.elements.get("profileTitle").textContent === f.profile.project.id, "profile");
  const local = path.join(f.root, ".ai", "project.local.yaml");
  ui.elements.get("connectionScope").value = "project_local";
  ui.elements.get("connectionScope").events.change();
  ui.elements.get("edtUrl").value = "http://127.0.0.1:8123/mcp";
  ui.elements.get("edtUrl").events.input();
  await ui.elements.get("saveButton").onclick();
  assert.equal(load(local).connections.edt.url, "http://127.0.0.1:8123/mcp");
  fs.writeFileSync(local, fs.readFileSync(local, "utf8").replace(/\n/g, "\r\n"));
  assert.match(ui.elements.get("connectionDestination").textContent, /project\.local\.yaml/);

  ui.elements.get("editorTab").onclick();
  await until(() => ui.elements.get("settingsText").value.length > 0 && !ui.elements.get("editSettingsButton").disabled, "editor");
  ui.elements.get("editorDocument").value = "project_local";
  ui.elements.get("editorDocument").events.change();
  await until(() => {
    try { return parse(ui.elements.get("settingsText").value).connections?.edt?.url === "http://127.0.0.1:8123/mcp" && !ui.elements.get("editSettingsButton").disabled; }
    catch { return false; }
  }, "local editor");
  assert.equal(ui.context.editorChanged(), false);
  ui.elements.get("editorMode").value = "tree"; ui.elements.get("editorMode").events.change();
  await until(() => treeInputs(ui).some(input => input.attributes?.["aria-label"] === "connections.edt.url"), "schema fields through MCP");
  assert.match(vm.runInContext('jsonRows.get(JSON.stringify(["connections","edt","url"])).origin.textContent',ui.context),/Действует:.*локальные настройки проекта/);
  ui.elements.get("editorMode").value = "text"; ui.elements.get("editorMode").events.change();
  const updated = "connections:\n  edt:\n    url: http://127.0.0.1:8123/mcp\n# keep this comment\ncomponents:\n  bsl-ls:\n    java: fixture-java\n\n";
  ui.elements.get("settingsText").value = updated;
  ui.elements.get("settingsText").events.input();
  await ui.elements.get("reviewEditButton").onclick();
  assert.equal(ui.elements.get("preview").hidden, false,ui.elements.get("status").textContent);
  assert.match(ui.elements.get("importEffects").textContent, /project\.local\.yaml/);
  const comparison = ui.elements.get("previewTextDiff").children[0];
  assert.match(comparison.children[2].textContent, /connections:/);
  assert.match(comparison.children[4].textContent, /# keep this comment/);
  assert.equal(comparison.children[4].textContent, canonical_yaml(updated));
  await ui.elements.get("applyButton").onclick();
  assert.equal(load(local).components["bsl-ls"].java, "fixture-java");
  assert.equal(fs.readFileSync(local, "utf8"), comparison.children[4].textContent);

  ui.elements.get("connectionSharedButton").onclick();
  ui.elements.get("componentSharedButton").onclick();
  ui.elements.get("javaGlobalButton").onclick();
  ui.elements.get("editorSharedButton").onclick();
  await until(() => {
    try { return parse(ui.elements.get("settingsText").value).project?.id === f.profile.project.id && !ui.elements.get("editSettingsButton").disabled; }
    catch { return false; }
  }, "shared editor");
  assert.equal(ui.elements.get("connectionScope").value, "profile");
  assert.equal(ui.elements.get("componentScope").value, "profile");
  assert.equal(ui.elements.get("javaScope").value, "global");
  for (const projectId of ["renamed-in-ui", "renamed-again-in-ui"]) {
    ui.elements.get("renameButton").onclick();
    assert.equal(ui.elements.get("projectIdInput").value, load(local).project?.id || f.profile.project.id);
    ui.elements.get("projectIdInput").value = projectId;
    ui.elements.get("projectIdInput").events.input();
    await ui.elements.get("renameSaveButton").onclick();
    assert.equal(load(local).project.id, projectId);
    assert.deepEqual(fs.readFileSync(shared), sharedBefore, "renaming through the form must not alter project.yaml");
    assert.equal(ui.elements.get("profileTitle").textContent, projectId);
    assert.equal(ui.elements.get("headerProjectName").textContent, projectId);
    assert.equal(ui.elements.get("selectedProjectLabel").textContent, projectId);
    assert.equal(ui.elements.get("profileHistory").children[0].children[0].children[0].textContent, projectId);
    const saved = parse(updated); saved.project = { id: projectId };
    assert.deepEqual(load(local), saved);
    const renamedText = fs.readFileSync(local, "utf8");
    assert.match(renamedText, /# keep this comment\n/);
    assert.equal(renamedText, canonical_yaml(renamedText));
    const snapshot = (await client.call("settings.read", {})).structuredContent;
    assert.equal(snapshot.profileHistory.find(item => item.projectRoot === f.root).projectId, projectId);
    await ui.context.refresh();
    assert.equal(ui.elements.get("headerProjectName").textContent, projectId);
  }
  // The deliberate shared edit is performed through Configuration → Общий · Git.
  await ui.elements.get("editSettingsButton").onclick();
  const sharedDocument = parse(ui.elements.get("settingsText").value);
  assert.equal(sharedDocument.project.id, f.profile.project.id);
  sharedDocument.project.id = "explicit-shared-name";
  ui.elements.get("settingsText").value = JSON.stringify(sharedDocument, null, 2);
  ui.elements.get("settingsText").events.input();
  await ui.elements.get("reviewEditButton").onclick();
  const localBefore = fs.readFileSync(local);
  await ui.elements.get("applyButton").onclick();
  assert.equal(load(shared).project.id, "explicit-shared-name");
  assert.deepEqual(fs.readFileSync(local), localBefore);
  assert.equal(ui.elements.get("headerProjectName").textContent, "renamed-again-in-ui");
  assert.equal(ui.elements.get("profileHistory").children[0].children[0].children[0].textContent, "renamed-again-in-ui");
  ui.lifecycle.pagehide();
});

test("the rename form states its fixed local destination and the explicit shared editing route", () => {
  const hint = html.match(/id="renameHint"[^>]*>([^<]*)<\/span>/)[1];
  assert.match(hint, /project\.id.*\.ai\/project\.local\.yaml/);
  assert.match(hint, /Выбор области в других панелях не влияет/);
  assert.match(hint, /Конфигурация → Общий · Git/);
  assert.match(hint, /Vanessa/);
});

test("YAML editor preserves mixed line endings around an edited or added line", async () => {
  const text = "schema_version: '0.2'\r\ncomponents: {}\n";
  const ui = screen(async name => name === "settings.edit" ? { text, format: "yaml", baseRevision: "base", layerScope: "project_local" } : read);
  await ui.flush();
  ui.elements.get("editorDocument").value = "project_local"; ui.elements.get("editorDocument").events.change(); await ui.flush();
  assert.equal(ui.context.editorChanged(), false);
  assert.equal(ui.context.editorText(), text);
  ui.elements.get("settingsText").value += "# changed\n"; ui.elements.get("settingsText").events.input();
  assert.equal(ui.context.editorText(), text + "# changed\n");
  ui.elements.get("settingsText").value = "schema_version: '0.2'\ncomponents: {x: 1}\n";
  assert.equal(ui.context.editorText(), "schema_version: '0.2'\r\ncomponents: {x: 1}\n");
  vm.runInContext(`editorRawOriginal="a\\r\\nb\\nc\\r\\nd\\n";editorOriginal="a\\nb\\nc\\nd\\n"`,ui.context);
  ui.elements.get("settingsText").value="A\nb\nc\nD\nnew\n";
  assert.equal(ui.context.editorText(),"A\r\nb\nc\r\nD\nnew\n");
});

test("chat project selector views another profile without rebinding the chat", async t => {
  const f = fixture(t); f.save();
  const other = path.join(f.base, "Other"); fs.mkdirSync(path.join(other, "src"), { recursive: true });
  dump({ ...f.profile, project: { ...f.profile.project, id: "Other" } }, path.join(other, ".ai", "project.yaml"));
  const client = await session(t, "mcp/settings.mjs", [], f);
  const ui = screen((name, args, meta) => client.request("tools/call", { name, arguments: args, ...(meta ? { _meta: meta } : {}) }),
    { navigation: "project", rawResults: true });
  const until = async predicate => { const deadline = Date.now() + 10000; while (!predicate()) { if (Date.now() > deadline) throw new Error("UI did not load"); await new Promise(resolve => setTimeout(resolve, 20)); } };
  await until(() => ui.elements.get("profileTitle").textContent === f.profile.project.id);
  ui.elements.get("profileToggleButton").onclick();
  await ui.context.selectProfile(other);
  const selection = ui.calls.find(call => call.params?.name === "settings.select_profile");
  assert.equal(selection.params._meta["1c-ai-core/projectRoot"], f.root);
  assert.equal(ui.elements.get("profileTitle").textContent, "Other");
  assert.equal(ui.elements.get("viewOnlyHint").hidden, false);
  assert.equal(ui.elements.get("profileBrowser").hidden, true);
  assert.equal((await client.call("settings.read", {})).structuredContent.values.projectRoot, f.root);
  assert.equal(ui.elements.get("saveButton").disabled, true);
  await ui.context.selectProfile(f.root);
  assert.equal(ui.elements.get("profileTitle").textContent, f.profile.project.id);
  assert.equal(ui.elements.get("viewOnlyHint").hidden, true);
  ui.lifecycle.pagehide();
});

test("historical view waits for the real MCP host root change before confirming the new chat", async t => {
  const f=fixture(t);f.save();const other=path.join(f.base,"Other"),next=path.join(f.base,"Next");
  for(const [root,id] of [[other,"Other"],[next,"Next"]]){fs.mkdirSync(path.join(root,"src"),{recursive:true});dump({...f.profile,project:{...f.profile.project,id}},path.join(root,".ai/project.yaml"));}
  const client=new McpClient([process.execPath,path.join(ROOT,"mcp/settings.mjs")],f.root,{...f.env,EDT_AI_PROJECT_ROOT:""},10);
  f.clients.push(client);await client.initialize();
  const ui=screen((name,args,meta)=>client.request("tools/call",{name,arguments:args,...(meta?{_meta:meta}:{})}),{navigation:"project",rawResults:true});
  const until=async predicate=>{const deadline=Date.now()+10000;while(!predicate()){if(Date.now()>deadline)throw new Error("UI did not reach expected state");await new Promise(resolve=>setTimeout(resolve,20));}};
  await until(()=>ui.elements.get("profileTitle").textContent===f.profile.project.id);
  await ui.context.selectProfile(other);assert.equal(ui.elements.get("viewOnlyHint").hidden,false);
  ui.deliver({jsonrpc:"2.0",method:"ui/notifications/tool-input",params:{arguments:{projectRoot:next}}});
  await ui.context.refreshStatus();assert.equal(ui.context.confirmedChatRoot(),null);
  const before=ui.calls.filter(call=>call.params?.name==="settings.select_profile").length;
  await ui.context.selectProfile(next);assert.equal(ui.calls.filter(call=>call.params?.name==="settings.select_profile").length,before);
  client.roots=[{uri:pathToFileURL(next).href}];client.notify("notifications/roots/list_changed");
  const deadline=Date.now()+10000;while(ui.context.confirmedChatRoot()!==next&&Date.now()<deadline){await ui.context.refreshStatus();await new Promise(resolve=>setTimeout(resolve,20));}
  assert.equal(ui.context.confirmedChatRoot(),next);assert.equal(ui.elements.get("profileTitle").textContent,"Other");
  await ui.context.selectProfile(next);assert.equal(ui.elements.get("profileTitle").textContent,"Next");
  assert.equal((await client.call("settings.read",{})).structuredContent.values.projectRoot,next);
  ui.lifecycle.pagehide();
});

test("document selector shows separate scopes and preserves a draft through the real MCP", async t => {
  const f = fixture(t); f.save();
  const client = await session(t, "mcp/settings.mjs", [], f);
  await client.call("settings.update", { scope: "global", set: { bslLsJava: "before-java" } });
  const initial = (await client.call("settings.read", {})).structuredContent;
  const profileBefore = fs.readFileSync(initial.writePaths.profile);
  const ui = screen((name, args, meta) => client.request("tools/call", { name, arguments: args, ...(meta ? { _meta: meta } : {}) }),
    { navigation: "project", rawResults: true });
  ui.document.hidden = true;
  const until = async predicate => {
    const end = Date.now() + 10000;
    while (!predicate()) {
      if (Date.now() > end) throw new Error(`Timed out waiting for editor: ${ui.elements.get("status").textContent}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  await until(() => ui.elements.get("profileTitle").textContent === f.profile.project.id);
  ui.elements.get("editorTab").onclick();
  await until(() => { try { return parse(ui.elements.get("settingsText").value).project.id === f.profile.project.id; } catch { return false; } });
  assert.equal(ui.elements.get("editorDocument").value, "profile");
  assert.equal(ui.elements.get("editorDestination").textContent, initial.writePaths.profile);
  const profile = parse(ui.elements.get("settingsText").value); assert.equal(profile.settings, undefined);
  profile.project.purpose = "unsaved change";
  ui.elements.get("settingsText").value = JSON.stringify(profile); ui.elements.get("settingsText").events.input();
  ui.elements.get("editorDocument").value = "project_local"; ui.elements.get("editorDocument").events.change();
  assert.equal(ui.elements.get("editorDocument").value, "profile");
  assert.equal(JSON.parse(ui.elements.get("settingsText").value).project.purpose, "unsaved change");
  assert.equal(ui.elements.get("editorSwitchDialog").open, true);
  ui.elements.get("editorSwitchDiscard").onclick();
  await until(() => ui.elements.get("editorDestination").textContent === initial.writePaths.project_local && ui.elements.get("settingsText").value.trim() === "{}");
  const local = { connections: { edt: { url: "http://localhost:8333/mcp" } } };
  ui.elements.get("settingsText").value = JSON.stringify(local); ui.elements.get("settingsText").events.input();
  await ui.elements.get("reviewEditButton").onclick();
  assert.equal(ui.elements.get("preview").hidden, false, ui.elements.get("status").textContent);
  assert.match(ui.elements.get("importEffects").textContent, /Файл записи/);
  await ui.elements.get("applyButton").onclick();
  assert.equal(load(initial.writePaths.project_local).connections.edt.url, "http://localhost:8333/mcp");
  assert.deepEqual(fs.readFileSync(initial.writePaths.profile), profileBefore);
  ui.lifecycle.pagehide();
});

test("removing a profile while an empty directory is selected opens the remaining profile through the real MCP server", async t => {
  const f = fixture(t), secondRoot = path.join(f.base, "second"), emptyRoot = path.join(f.base, "empty");
  f.profile.project.id = "first-project";
  f.profile.connections = { edt: { url: "http://127.0.0.1:8123/mcp" } };
  f.save();
  fs.mkdirSync(path.join(secondRoot, "src"), { recursive: true }); fs.mkdirSync(emptyRoot);
  const second = structuredClone(f.profile);
  second.project.id = "second-project"; second.connections.edt.url = "http://127.0.0.1:8124/mcp";
  dump(second, path.join(secondRoot, ".ai", "project.yaml"));
  const profileFiles = [f.root, secondRoot].map(root => path.join(root, ".ai", "project.yaml"));
  const originals = profileFiles.map(file => fs.readFileSync(file));
  const client = new McpClient([process.execPath, path.join(ROOT, "mcp/settings.mjs")], ROOT, { ...f.env, EDT_AI_PROJECT_ROOT: "" }, 10);
  f.clients.push(client); client.roots = []; await client.initialize();
  const ui = screen((name, args, meta) => client.request("tools/call", { name, arguments: args, ...(meta ? { _meta: meta } : {}) }),
    { navigation: "profiles", rawResults: true });
  ui.document.hidden = true;
  const end = Date.now() + 10000;
  while (ui.elements.get("profileTitle").textContent !== "Профиль не выбран") {
    if (Date.now() > end) throw new Error(`Timed out waiting for settings: ${ui.elements.get("status").textContent}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const open = async root => {
    const field = ui.elements.get("projectRoot"); field.value = root; field.events.input();
    await ui.elements.get("selectProfileButton").onclick();
  };
  await open(f.root);
  assert.equal(ui.elements.get("profileTitle").textContent, "first-project");
  assert.equal(ui.elements.get("edtUrl").value, "http://127.0.0.1:8123/mcp");
  await open(secondRoot);
  assert.equal(ui.elements.get("profileTitle").textContent, "second-project");
  assert.equal(ui.elements.get("edtUrl").value, "http://127.0.0.1:8124/mcp");
  await open(emptyRoot);
  assert.equal(ui.elements.get("createButton").hidden, false);
  const secondCard = ui.elements.get("profileHistory").children.find(card => card.children[0].children[0].textContent === "second-project");
  assert.ok(secondCard); await secondCard.children[1].onclick();
  assert.equal(ui.elements.get("profileTitle").textContent, "first-project");
  assert.equal(ui.elements.get("projectRoot").value, f.root);
  assert.equal(ui.elements.get("edtUrl").value, "http://127.0.0.1:8123/mcp");
  assert.equal(ui.elements.get("createButton").hidden, true);
  assert.equal((await client.call("settings.read", {})).structuredContent.values.projectRoot, f.root);
  assert.equal(ui.elements.get("profileHistory").children.some(card => card.children[0].children[0].textContent === "second-project"), false);
  ui.elements.get("connectionScope").value = "project_local"; ui.elements.get("connectionScope").events.change();
  ui.elements.get("edtUrl").value = "http://127.0.0.1:8125/mcp"; ui.elements.get("edtUrl").events.input();
  await ui.elements.get("saveButton").onclick();
  assert.equal(load(path.join(f.root, ".ai", "project.local.yaml")).connections.edt.url, "http://127.0.0.1:8125/mcp");
  assert.equal(fs.existsSync(path.join(secondRoot, ".ai", "project.local.yaml")), false);
  assert.equal(fs.existsSync(path.join(emptyRoot, ".ai", "project.local.yaml")), false);
  assert.deepEqual(profileFiles.map(file => fs.readFileSync(file)), originals);
  assert.equal(fs.existsSync(path.join(emptyRoot, ".ai", "project.yaml")), false);
  ui.lifecycle.pagehide();
});

test("OpenViking editable transport fields save typed values through the shared backend", async () => {
  let updated;
  const current = structuredClone(read);
  current.values = { ...current.values, openvikingEnabled: false, openvikingUrl: "",
    openvikingTimeout: 20, openvikingMaxResponseBytes: 2097152, openvikingConnectionId: "" };
  const ui = screen(async (name, args) => {
    if (["settings.read", "settings.status"].includes(name)) return current;
    if (name === "settings.update") { updated = args.set; Object.assign(current.values, args.set); return {}; }
    throw new Error(name);
  }); await ui.flush();
  assert.equal(ui.elements.get("openvikingEnabled").checked, false);
  const values = { openvikingEnabled: true, openvikingUrl: "https://knowledge.example/mcp",
    openvikingTimeout: 2.5, openvikingMaxResponseBytes: 4096,
    openvikingConnectionId: "team" };
  for (const [key, value] of Object.entries(values)) {
    const field = ui.elements.get(key); assert.equal(field.disabled, false);
    if (typeof value === "boolean") { field.checked = value; field.events.change(); }
    else { field.value = typeof value === "object" ? JSON.stringify(value) : String(value); field.events.input(); }
  }
  await ui.elements.get("saveButton").onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(updated)), values);
});

test("a delayed shared-record load cannot overwrite a draft and external scope changes keep an escape", async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const current = { ...read, instance: "one", values: { ...read.values, openvikingUrl: "https://example.org/mcp", openvikingConnectionId: "team" } };
  const ui = screen(async name => {
    if (["settings.read", "settings.status"].includes(name)) return current;
    if (name === "settings.openviking_read") return pending;
    throw new Error(name);
  });
  await ui.flush(); await ui.flush();
  const credential = ui.elements.get("ovCredential"); credential.value = "draft"; credential.events.input();
  assert.equal(ui.elements.get("probeButton").disabled, true);
  release({ revision: "saved", values: { credential: "saved", bindingKey: "", accessPublicKey: "", accessReceipts: "", publicationPublicKey: "", publicationReceipts: "" } });
  await ui.flush(); await ui.flush(); assert.equal(credential.value, "draft");
  vm.runInContext(`renderCurrent(${JSON.stringify({ ...current, instance: "two", values: { ...current.values, projectRoot: "C:/fixture/other" } })})`, ui.context);
  assert.equal(ui.elements.get("unsavedHint").hidden, false);
  assert.equal(ui.elements.get("openvikingRecordDiscard").disabled, true);
  ui.elements.get("discardDraftButton").onclick();
  assert.equal(ui.elements.get("projectRoot").value, "C:/fixture/other");
  assert.equal(ui.elements.get("probeButton").disabled, false);
});

test("OpenViking can be disabled and enabled without changing its saved URL", async () => {
  const url = "https://knowledge.example/mcp", updates = [];
  const current = { ...read, values: { ...read.values, openvikingEnabled: true, openvikingUrl: url },
    valueSources: { openvikingEnabled: "project_local" } };
  const ui = screen(async (name, args) => {
    if (["settings.read", "settings.status"].includes(name)) return current;
    if (name === "settings.update") { updates.push(args.set); Object.assign(current.values, args.set); return {}; }
    throw new Error(name);
  }); await ui.flush();
  const enabled = ui.elements.get("openvikingEnabled");
  assert.equal(enabled.checked, true);
  assert.match(ui.elements.get("openvikingEnabledSource").textContent, /локальные настройки проекта/);
  for (const value of [false, true]) {
    enabled.checked = value; enabled.events.change();
    await ui.elements.get("saveButton").onclick();
    assert.deepEqual(JSON.parse(JSON.stringify(updates.at(-1))), { openvikingEnabled: value });
    assert.equal(ui.elements.get("openvikingUrl").value, url);
    assert.equal(current.values.openvikingUrl, url);
  }
});

test("an unsaved OpenViking disable is included in the probe and survives refresh", async () => {
  const url = "https://knowledge.example/mcp";
  const current = { ...read, values: { ...read.values, openvikingEnabled: true, openvikingUrl: url } };
  let draft;
  const ui = screen(async (name, args) => {
    if (["settings.read", "settings.status"].includes(name)) return current;
    if (name === "settings.probe_connections") { draft = args.connections.openviking; return { id: "off-probe", status: "completed", result: { external: {} } }; }
    throw new Error(name);
  }); await ui.flush();
  ui.context.openConnectionDialog({id:"openviking",name:"openviking"},null);
  const enabled = ui.elements.get("openvikingEnabled");
  enabled.checked = false; enabled.events.change();
  await ui.elements.get("probeButton").onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(draft)), { enabled: false });
  assert.equal(enabled.checked, false);
  assert.equal(ui.elements.get("openvikingUrl").value, url);
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.update").length, 0);
});

test("knowledge UI shows scoped setup publication and drops stale readiness without losing draft fields", async () => {
  const current = structuredClone(read);
  current.knowledge = { mode: "transitional", provider: "openviking", collections: ["team", "api"], required: true,
    workflowScope: "dependent_actions", dependentActions: ["implementation"], state: "not_verified", detail: "Search not verified" };
  current.valueSources = { openvikingTimeout: "project_local", openvikingConnectionId: "connections_file" };
  current.readiness = { state: "blocked", checkedAt: new Date().toISOString(), checks: [], knowledge: { ready: true,
    readiness: { publication: { state: "verified", gitRevision: "revision-fixture", snapshot: "index-fixture" } } } };
  const ui = screen(async name => { if (["settings.read", "settings.status"].includes(name)) return current; throw new Error(name); });
  await ui.flush();
  assert.match(ui.elements.get("knowledgeDetails").textContent, /team, api/);
  assert.match(ui.elements.get("knowledgeDetails").textContent, /revision-fixture · индекс index-fixture/);
  assert.match(ui.elements.get("knowledgeDetails").textContent, /Режим знаний: переходный · OpenViking/);
  assert.match(ui.elements.get("knowledgeDetails").textContent, /Область блокировки: изменение/);
  assert.deepEqual(current.knowledge.dependentActions, ["implementation"]);
  assert.match(ui.elements.get("openvikingTimeoutSource").textContent, /локальные настройки проекта/);
  const field = ui.elements.get("openvikingUrl"); field.value = "https://draft.example/mcp"; field.events.input();
  current.readiness.state = "stale"; current.readiness.reason = "Изменились полномочия";
  await ui.context.refreshStatus();
  assert.doesNotMatch(ui.elements.get("knowledgeDetails").textContent, /revision-fixture/);
  assert.match(ui.elements.get("knowledgeDetails").textContent, /Изменились полномочия/);
  assert.equal(field.value, "https://draft.example/mcp");
});

function treeInputs(ui){const inputs=[];const visit=node=>{if(node.tag==="input")inputs.push(node);for(const child of node.children||[])visit(child);};visit(ui.elements.get("jsonTree"));return inputs;}

test("opening the HTML directly allows every preview tab without a host or profile", async () => {
  const ui=screen(()=>{throw new Error("Standalone preview must not contact the plugin");},{standalone:true});await ui.flush();
  assert.equal(ui.elements.get("standaloneHint").hidden,false);
  assert.equal(ui.elements.get("profileTitle").textContent,"Предпросмотр настроек");
  assert.equal(ui.elements.get("profileState").textContent,"Без подключения");
  assert.equal(ui.elements.get("checkPanel").hidden,false);
  assert.equal(ui.elements.get("profilePanel").hidden,true);
  assert.equal(ui.elements.get("countAll").textContent,"7");
  assert.equal(ui.elements.get("countIssues").textContent,"7");
  assert.equal(ui.elements.get("componentCatalog").children.length,3);
  for(const mode of ["check","editor","support"]){
    const tab=ui.elements.get(mode+"Tab");assert.equal(tab.disabled,false);tab.onclick();
    assert.equal(ui.elements.get(mode+"Panel").hidden,false);assert.equal(tab.attributes["aria-selected"],"true");
  }
  ui.elements.get("checkTab").events.keydown({key:"ArrowRight",preventDefault(){}});
  assert.equal(ui.elements.get("editorPanel").hidden,false);
  assert.equal(ui.elements.get("versionButton").disabled,false);await ui.elements.get("versionButton").onclick();
  assert.equal(ui.elements.get("versionPopup").hidden,false);assert.equal(ui.elements.get("versionSearch").disabled,false);
  assert.match(ui.elements.get("versionHint").textContent,/в настройках плагина/);
  assert.deepEqual(ui.calls,[]);assert.ok(![...ui.timers.values()].some(timer=>timer.ms===60000));
});

test("standalone preview keeps saving, updates and service launches unavailable after navigation", async () => {
  const ui=screen(()=>{throw new Error("No plugin calls in preview");},{standalone:true});await ui.flush();
  assert.equal(ui.elements.get("editorDestination").textContent,"недоступен");
  assert.equal(ui.elements.get("journalCount").textContent,"Недоступен в предпросмотре");
  for(const mode of ["check","editor","support"]){
    ui.elements.get(mode+"Tab").onclick();
    for(const id of ["saveButton","saveComponentsButton","readinessButton","rebuildIndexButton","rebuildAllIndexesButton","installUpdateButton","refreshVersionsButton","transferExport","transferPreview","applyButton","diagnosticsButton"])
      assert.equal(ui.elements.get(id).disabled,true,id);
  }
  await ui.elements.get("readinessButton").onclick();
  assert.deepEqual(ui.calls,[]);assert.match(ui.elements.get("status").textContent,/Подключение к плагину/);
});

test("invalid numeric YAML fields block preview until corrected", async () => {
  const backend=new SettingsBackend("unused-state","unused-settings"), original="connections:\n  openviking:\n    timeout_seconds: 20\n";
  const ui=screen(async(name,args)=>{
    if(name==="settings.read"||name==="settings.status")return read;
    if(name==="settings.edit")return {text:original,format:"yaml",baseRevision:"base",layerScope:"project_local"};
    if(name==="settings.document_fields")return backend.main({action:"document_fields",...args});
    if(name==="settings.document_patch")return patch_yaml_draft(args.text,args.operation);
    throw new Error(name);
  });
  await ui.flush();ui.elements.get("editorDocument").value="project_local";ui.elements.get("editorDocument").events.change();await ui.flush();await ui.flush();
  ui.elements.get("editorMode").value="tree";ui.elements.get("editorMode").events.change();await ui.flush();await ui.flush();
  const input=treeInputs(ui).find(element=>element.attributes?.["aria-label"]==="connections.openviking.timeout_seconds");assert.ok(input);
  input.value="";input.onchange();assert.equal(input.attributes["aria-invalid"],"true");assert.equal(ui.elements.get("reviewEditButton").disabled,true);
  input.value="30";input.onchange();await ui.flush();await ui.flush();assert.match(ui.elements.get("settingsText").value,/timeout_seconds: 30/);
});

test("schema fields and YAML share one draft and keep a scalar comment", async () => {
  const backend = new SettingsBackend("unused-state", "unused-settings"), original = "schema_version: '0.2'\nproject:\n  id: old # retained\n";
  const ui = screen(async (name,args) => {
    if(name==="settings.read"||name==="settings.status")return read;
    if(name==="settings.edit")return {text:original,format:"yaml",baseRevision:"base",layerScope:"profile"};
    if(name==="settings.document_fields")return backend.main({action:"document_fields",...args});
    if(name==="settings.document_patch")return patch_yaml_draft(args.text,args.operation);
    throw new Error(name);
  });
  await ui.flush();await ui.elements.get("editSettingsButton").onclick();
  ui.elements.get("editorMode").value="tree";ui.elements.get("editorMode").events.change();
  await ui.flush();await ui.flush();
  const inputs=treeInputs(ui), id=inputs.find(input=>input.attributes?.["aria-label"]==="project.id");
  assert.ok(id);id.value="new";id.onchange();await ui.flush();await ui.flush();
  assert.equal(ui.elements.get("settingsText").value,"schema_version: '0.2'\nproject:\n  id: \"new\" # retained\n");
  ui.elements.get("editorMode").value="text";ui.elements.get("editorMode").events.change();
  assert.equal(ui.elements.get("settingsText").hidden,false);
});

for (const layerScope of ["profile", "project_local"]) test(`edt_required is YAML-only in the ${layerScope} editor and survives edits through schema fields`, async () => {
  const backend = new SettingsBackend("unused-state", "unused-settings");
  const repositories = [
    { id: "first", path: ".", alias: "first", edt_project: "First", edt_required: false },
    { id: "second", path: ".", alias: "second", edt_project: "Second", edt_required: true },
    { id: "third", path: ".", alias: "third" },
  ];
  const original = JSON.stringify({ repositories });
  const ui = screen(async (name, args) => {
    if (["settings.read", "settings.status"].includes(name)) return read;
    if (name === "settings.edit") return { text: original, format: "yaml", baseRevision: "base", layerScope };
    if (name === "settings.document_fields") return backend.main({ action: "document_fields", ...args });
    if (name === "settings.document_patch") return patch_yaml_draft(args.text, args.operation);
    throw new Error(name);
  });
  await ui.flush();
  if (layerScope === "profile") await ui.elements.get("editSettingsButton").onclick();
  else { ui.elements.get("editorDocument").value = layerScope; ui.elements.get("editorDocument").events.change(); }
  await ui.flush(); await ui.flush();
  ui.elements.get("editorMode").value = "tree"; ui.elements.get("editorMode").events.change(); await ui.flush(); await ui.flush();
  const noFlagControls = () => {
    assert.equal(ui.document.querySelectorAll().some(input => input.attributes?.["aria-label"]?.includes("edt_required")), false);
    assert.equal(vm.runInContext("[...jsonRows.keys()].some(key => JSON.parse(key).at(-1) === 'edt_required')", ui.context), false, "no value, toggle or add/remove field may be generated");
  };
  noFlagControls();
  const alias = treeInputs(ui).find(input => input.attributes?.["aria-label"] === "repositories.0.alias");
  assert.ok(alias); alias.value = "renamed"; await alias.onchange(); await ui.flush(); await ui.flush();
  assert.deepEqual(parse(ui.elements.get("settingsText").value).repositories, repositories.map((item, index) => index ? item : { ...item, alias: "renamed" }));
  noFlagControls();
  ui.elements.get("editorMode").value = "text"; ui.elements.get("editorMode").events.change();
  const next = parse(ui.elements.get("settingsText").value); next.repositories[0].edt_required = true;
  ui.elements.get("settingsText").value = JSON.stringify(next); ui.elements.get("settingsText").events.input();
  ui.elements.get("editorMode").value = "tree"; ui.elements.get("editorMode").events.change(); await ui.flush(); await ui.flush();
  assert.equal(parse(ui.elements.get("settingsText").value).repositories[0].edt_required, true); noFlagControls();
});

test("editor search filters collapsed fields without changing YAML and restores disclosure state", async () => {
  const backend=new SettingsBackend("unused-state","unused-settings"),text="project:\n  id: Demo\nconnections:\n  edt:\n    url: http://localhost:9000/mcp\ntesting:\n  yaxunit: false\n";
  const ui=screen(async(name,args)=>{
    if(["settings.read","settings.status"].includes(name))return read;
    if(name==="settings.edit")return {text,format:"yaml",baseRevision:"base",layerScope:"profile"};
    if(name==="settings.document_fields")return backend.main({action:"document_fields",...args});
    if(name==="settings.document_patch")return patch_yaml_draft(args.text,args.operation);
    throw new Error(name);
  });await ui.flush();await ui.elements.get("editSettingsButton").onclick();await ui.flush();await ui.flush();
  assert.equal(vm.runInContext("fieldDetails.every(([,details])=>!details.open)",ui.context),true);
  const sections=ui.elements.get("jsonTree").children,main=sections.find(section=>section.children[0].textContent==="Идентификация"),tools=sections.find(section=>section.children[0].textContent==="Подключения MCP");main.open=true;
  const search=ui.elements.get("editorSearch");search.focus();const requests=ui.calls.length;
  search.value="connections.edt.url";search.events.input();
  assert.equal(main.hidden,true);assert.equal(tools.hidden,false);assert.equal(tools.open,true);
  const row=vm.runInContext('jsonRows.get(JSON.stringify(["connections","edt","url"]))',ui.context);
  for(let parent=row.container;parent&&parent!==ui.elements.get("jsonTree");parent=parent.parentElement){assert.equal(parent.hidden,false);if(parent.tagName==="DETAILS")assert.equal(parent.open,true);}
  assert.equal(ui.calls.length,requests);assert.equal(ui.elements.get("settingsText").value,text);assert.equal(ui.context.editorChanged(),false);
  search.value="no matching setting";search.events.input();assert.equal(sections.every(section=>section.hidden),true);assert.equal(ui.elements.get("editorSearchStatus").textContent,"Совпадений нет");
  search.events.keydown({key:"Escape",preventDefault(){}});assert.equal(main.open,true);assert.equal(tools.open,false);assert.equal(sections.every(section=>!section.hidden),true);
  const input=treeInputs(ui).find(item=>item.fieldPath===JSON.stringify(["project","id"]));input.value="Unsaved";input.oninput();
  search.value="connections.edt.url";search.events.input();assert.equal(vm.runInContext('jsonRows.get(JSON.stringify(["project","id"])).container.hidden',ui.context),false);
  assert.equal(ui.context.editorChanged(),true);assert.equal(ui.elements.get("settingsText").value,text);
  vm.runInContext('markFieldErrors("/schema_version: invalid")',ui.context);ui.context.applyEditorSearch();
  assert.equal(vm.runInContext('jsonRows.get(JSON.stringify(["schema_version"])).container.hidden',ui.context),false);
});

test("YAML search finds literal text, cycles matches and preserves the caret during editing", async () => {
  const backend=new SettingsBackend("unused-state","unused-settings"),text="project:\n  id: 'a.b[0]* a.b[0]*'\n";
  const ui=screen(async(name,args)=>{
    if(["settings.read","settings.status"].includes(name))return read;
    if(name==="settings.edit")return {text,format:"yaml",baseRevision:"base",layerScope:"profile"};
    if(name==="settings.document_fields")return backend.main({action:"document_fields",...args});
    throw new Error(name);
  });await ui.flush();await ui.elements.get("editSettingsButton").onclick();await ui.flush();ui.elements.get("editorYamlButton").onclick();
  const search=ui.elements.get("editorSearch"),yaml=ui.elements.get("settingsText"),term="a.b[0]*";search.focus();search.value=term;search.events.input();
  assert.equal(yaml.selectionStart,text.indexOf(term));assert.equal(yaml.value.slice(yaml.selectionStart,yaml.selectionEnd),term);assert.equal(ui.elements.get("editorSearchStatus").textContent,"1 из 2");
  search.events.keydown({key:"Enter",preventDefault(){}});assert.equal(yaml.selectionStart,text.lastIndexOf(term));
  search.events.keydown({key:"Enter",shiftKey:true,preventDefault(){}});assert.equal(yaml.selectionStart,text.indexOf(term));
  yaml.value=text+"# draft\n";yaml.selectionStart=2;yaml.selectionEnd=2;yaml.events.input();assert.equal(yaml.selectionStart,2);assert.equal(yaml.selectionEnd,2);assert.equal(ui.context.editorChanged(),true);
  search.value="[";search.events.input();assert.equal(ui.elements.get("editorSearchStatus").textContent,"1 из 2");
  search.events.keydown({key:"Escape",preventDefault(){}});assert.equal(ui.elements.get("editorSearchStatus").hidden,true);assert.equal(yaml.value,text+"# draft\n");
});

test("editing fields preserves opened sections and nested branches", async () => {
  const backend=new SettingsBackend("unused-state","unused-settings"),text="testing:\n  yaxunit_config:\n    launch_configuration: old\n";
  const ui=screen(async(name,args)=>{
    if(name==="settings.read"||name==="settings.status")return read;
    if(name==="settings.edit")return {text,format:"yaml",baseRevision:"base",layerScope:"profile"};
    if(name==="settings.document_fields")return backend.main({action:"document_fields",...args});
    if(name==="settings.document_patch")return patch_yaml_draft(args.text,args.operation);
    throw new Error(name);
  });
  await ui.flush();await ui.elements.get("editSettingsButton").onclick();await ui.flush();
  const section=()=>ui.elements.get("jsonTree").children.find(item=>item.children[0].textContent==="Тестирование");
  section().open=true;
  const input=treeInputs(ui).find(item=>item.attributes?.["aria-label"]==="testing.yaxunit_config.launch_configuration");
  assert.ok(input);let node=input.parentNode;while(node&&node!==section()){if(node.tagName==="DETAILS")node.open=true;node=node.parentNode;}
  input.value="new";input.onchange();ui.elements.get("supportTab").focus();await ui.flush();await ui.flush();
  assert.equal(section().open,true);
  const updated=treeInputs(ui).find(item=>item.attributes?.["aria-label"]==="testing.yaxunit_config.launch_configuration");
  assert.ok(updated);node=updated.parentNode;while(node&&node!==section()){if(node.tagName==="DETAILS")assert.equal(node.open,true);node=node.parentNode;}
  assert.equal(ui.document.activeElement,ui.elements.get("supportTab"));
});

test("unblurred field input is a protected draft and a failed patch keeps it editable", async () => {
  const backend=new SettingsBackend("unused-state","unused-settings"),text="project:\n  id: old\n";
  let rejectPatch=true;
  const ui=screen(async(name,args)=>{
    if(["settings.read","settings.status"].includes(name))return read;
    if(name==="settings.edit")return {text,format:"yaml",baseRevision:"base",layerScope:"profile"};
    if(name==="settings.document_fields")return backend.main({action:"document_fields",...args});
    if(name==="settings.document_patch"){if(rejectPatch)throw new Error("fixture failure");return patch_yaml_draft(args.text,args.operation);}
    throw new Error(name);
  });
  await ui.flush();await ui.elements.get("editSettingsButton").onclick();await ui.flush();await ui.flush();
  const input=treeInputs(ui).find(item=>item.attributes?.["aria-label"]==="project.id");
  input.value="draft";input.oninput();let prevented=false;ui.lifecycle.beforeunload({preventDefault(){prevented=true;}});
  assert.equal(prevented,true);assert.equal(ui.context.editorChanged(),true);assert.equal(ui.elements.get("editorDraftStatus").textContent,"Есть изменения");
  await ui.elements.get("reviewEditButton").onclick();assert.equal(ui.calls.some(call=>call.params?.name==="settings.preview"),false);
  input.onchange();await ui.flush();await ui.flush();assert.equal(input.value,"draft");assert.match(ui.elements.get("editorValidation").textContent,/Не удалось/);
  rejectPatch=false;input.value="draft revised";input.oninput();input.onchange();await ui.flush();await ui.flush();
  assert.equal(parse(ui.elements.get("settingsText").value).project.id,"draft revised");
});

test("rapid edits of two fields are serialized without stealing focus", async () => {
  const backend=new SettingsBackend("unused-state","unused-settings"),text="project:\n  id: old\n  purpose: before\n";const releases=[];
  const ui=screen(async(name,args)=>{
    if(["settings.read","settings.status"].includes(name))return read;
    if(name==="settings.edit")return {text,format:"yaml",baseRevision:"base",layerScope:"profile"};
    if(name==="settings.document_fields")return backend.main({action:"document_fields",...args});
    if(name==="settings.document_patch")return new Promise(resolve=>releases.push(()=>resolve(patch_yaml_draft(args.text,args.operation))));
    throw new Error(name);
  });
  await ui.flush();await ui.elements.get("editSettingsButton").onclick();await ui.flush();await ui.flush();
  const find=path=>treeInputs(ui).find(item=>item.attributes?.["aria-label"]===path),first=find("project.id"),second=find("project.purpose");
  first.value="new";first.oninput();first.onchange();await ui.flush();second.focus();second.value="after";second.oninput();second.onchange();
  releases.shift()();await ui.flush();await ui.flush();assert.equal(ui.document.activeElement,second);
  assert.equal(releases.length,1);releases.shift()();await ui.flush();await ui.flush();
  assert.deepEqual(parse(ui.elements.get("settingsText").value).project,{id:"new",purpose:"after"});
  assert.equal(ui.document.activeElement,second);
});

test("field sections resolve local schema composition and attach object errors", async () => {
  const schema={type:"object",$defs:{extra:{type:"object",properties:{new_field:{type:"string"}}}},allOf:[{$ref:"#/$defs/extra"}],properties:{project:{type:"object",properties:{id:{type:"string"}}}}};
  const ui=screen(async(name)=>{
    if(name==="settings.read"||name==="settings.status")return read;
    if(name==="settings.edit")return {text:"project: {}\nnew_field: value\n",format:"yaml",baseRevision:"base",layerScope:"profile"};
    if(name==="settings.document_fields")return {schema,value:{project:{},new_field:"value"}};
    throw new Error(name);
  });
  await ui.flush();await ui.elements.get("editSettingsButton").onclick();await ui.flush();await ui.flush();
  assert.equal(ui.elements.get("editorMode").value,"tree");
  assert.deepEqual(ui.elements.get("jsonTree").children.map(section=>section.children[0].textContent),["Идентификация","Дополнительно"]);
  assert.ok(treeInputs(ui).some(input=>input.attributes?.["aria-label"]==="new_field"));
  vm.runInContext('markFieldErrors("/project: missing id")',ui.context);
  assert.equal(vm.runInContext('jsonRows.get(JSON.stringify(["project"])).error.textContent',ui.context),"missing id");
  assert.equal(vm.runInContext('jsonRows.get(JSON.stringify(["project"])).node.parentNode.tag',ui.context),"details");
});

test("schema composition keeps scalar defaults, nested allOf fields and selected object variants", async () => {
  const ui=screen(async()=>read);await ui.flush();
  assert.equal(vm.runInContext('schemaDefault(formSchema({$ref:"#/$defs/s"},{$defs:{s:{type:"string"}}},undefined))',ui.context),"");
  const keys=vm.runInContext(`Object.keys(formSchema({allOf:[{properties:{section:{type:"object",properties:{a:{type:"string"}}}}},{properties:{section:{type:"object",properties:{b:{type:"string"}}}}}]},{},{}).properties.section.properties).sort().join(",")`,ui.context);
  assert.equal(keys,"a,b");
  const branch=vm.runInContext(`formSchema({oneOf:[{type:"object",properties:{kind:{const:"a"},alpha:{type:"string"}}},{type:"object",properties:{kind:{const:"b"},beta:{type:"string"}}}]},{},{kind:"b"}).properties`,ui.context);
  assert.ok(branch.beta);assert.equal(branch.alpha,undefined);
});

test("referenced array and dictionary elements get values of the declared type", async () => {
  const schema={type:"object",$defs:{item:{type:"object",properties:{name:{type:"string"}}}},properties:{items:{type:"array",items:{$ref:"#/$defs/item"}},mapping:{type:"object",additionalProperties:{$ref:"#/$defs/item"}}}};
  const patches=[],ui=screen(async(name,args)=>{
    if(name==="settings.read"||name==="settings.status")return read;
    if(name==="settings.edit")return {text:"items: []\nmapping: {}\n",format:"yaml",baseRevision:"base",layerScope:"profile"};
    if(name==="settings.document_fields")return {schema,value:parse(args.text)};
    if(name==="settings.document_patch"){patches.push(args.operation);return patch_yaml_draft(args.text,args.operation);}
    throw new Error(name);
  });
  await ui.flush();await ui.elements.get("editSettingsButton").onclick();await ui.flush();await ui.flush();
  const all=()=>{const out=[],visit=node=>{out.push(node);for(const child of node.children||[])visit(child);};visit(ui.elements.get("jsonTree"));return out;};
  all().find(node=>node.textContent==="+ Добавить элемент").onclick();await ui.flush();await ui.flush();
  const key=all().find(node=>node.attributes?.["aria-label"]==="Новый ключ: mapping");key.value="first";
  const add=all().find(node=>node.textContent==="+ Добавить ключ");add.onclick();await ui.flush();await ui.flush();
  assert.deepEqual(JSON.parse(JSON.stringify(patches.map(op=>op.value))),[{},{}]);
});

test("schema variant control switches between an object and an array", async () => {
  const schema={type:"object",properties:{variant:{oneOf:[{title:"Объект",type:"object",properties:{name:{type:"string"}}},{title:"Массив",type:"array",items:{type:"string"}}]}}};
  const ui=screen(async(name,args)=>{
    if(name==="settings.read"||name==="settings.status")return read;
    if(name==="settings.edit")return {text:"variant: {}\n",format:"yaml",baseRevision:"base",layerScope:"profile"};
    if(name==="settings.document_fields")return {schema,value:parse(args.text)};
    if(name==="settings.document_patch")return patch_yaml_draft(args.text,args.operation);
    throw new Error(name);
  });
  await ui.flush();await ui.elements.get("editSettingsButton").onclick();await ui.flush();await ui.flush();
  const all=[],visit=node=>{all.push(node);for(const child of node.children||[])visit(child);};visit(ui.elements.get("jsonTree"));
  const select=all.find(node=>node.attributes?.["aria-label"]==="Вариант: variant");assert.ok(select);select.value="1";select.onchange();await ui.flush();await ui.flush();
  assert.deepEqual(parse(ui.elements.get("settingsText").value).variant,[]);
});

test("discarding a document restores its loaded text without clearing other drafts", async () => {
  const backend=new SettingsBackend("unused-state","unused-settings"),original="project:\n  id: original\n";
  const ui=screen(async(name,args)=>{
    if(name==="settings.read"||name==="settings.status")return read;
    if(name==="settings.edit")return {text:original,format:"yaml",baseRevision:"base",layerScope:"profile"};
    if(name==="settings.document_fields")return backend.main({action:"document_fields",...args});
    throw new Error(name);
  });
  await ui.flush();await ui.elements.get("editSettingsButton").onclick();await ui.flush();
  ui.elements.get("settingsText").value="project:\n  id: changed\n";ui.elements.get("settingsText").events.input();
  vm.runInContext('dirtyFields.add("edtUrl")',ui.context);ui.elements.get("discardDraftButton").onclick();
  assert.equal(ui.elements.get("settingsText").value,original);assert.equal(vm.runInContext('dirtyFields.has("edtUrl")',ui.context),true);
});

test("scope switch saves and opens the requested document in one action", async () => {
  const backend=new SettingsBackend("unused-state","unused-settings"),edits=[];
  const ui=screen(async(name,args)=>{
    if(name==="settings.read"||name==="settings.status")return read;
    if(name==="settings.edit")return {text:args.layerScope==="profile"?"project:\n  id: old\n":"{}\n",format:"yaml",baseRevision:"base",layerScope:args.layerScope};
    if(name==="settings.document_fields")return backend.main({action:"document_fields",...args});
    if(name==="settings.preview")return {repositories:[],revision:"preview",projectRoot:read.values.projectRoot,replacesProfile:false};
    if(name==="settings.apply"){edits.push(args);return {};}
    throw new Error(name);
  });
  await ui.flush();await ui.elements.get("editSettingsButton").onclick();await ui.flush();
  ui.elements.get("settingsText").value="project:\n  id: changed\n";ui.elements.get("settingsText").events.input();
  ui.elements.get("editorDocument").value="project_local";ui.elements.get("editorDocument").events.change();
  ui.elements.get("editorSwitchSave").onclick();await ui.flush();await ui.flush();
  assert.equal(ui.elements.get("preview").hidden,true);
  assert.equal(edits.length,1);assert.equal(ui.elements.get("editorDocument").value,"project_local");assert.equal(ui.elements.get("settingsText").value,"{}\n");
});

for (const change of ["text", "gitignore", "none"]) test(`optional preview handles ${change} changes without a manual edit`, async () => {
  const original = change === "text" ? "project: {id: old}\n" : "project:\n  id: \"old\"\n";
  const formatted = canonical_yaml(original), applied = [];
  const ui = screen(async (name, args) => {
    if (["settings.read", "settings.status"].includes(name)) return read;
    if (name === "settings.edit") return { text: original, format: "yaml", baseRevision: "base", layerScope: args.layerScope };
    if (name === "settings.document_fields") return { schema: { type: "object" }, value: parse(args.text) };
    if (name === "settings.preview") return { repositories: [], revision: "preview", formattedText: formatted,
      textChanged: change === "text", gitignoreChange: change === "gitignore" ? { beforeText: "", afterText: ".ai/project.local.yaml\n" } : null };
    if (name === "settings.apply") { applied.push(args); return {}; }
    throw new Error(name);
  });
  await ui.flush(); await ui.elements.get("editSettingsButton").onclick(); await ui.flush();
  assert.equal(ui.elements.get("applyButton").disabled, true);
  await ui.elements.get("reviewEditButton").onclick();
  assert.equal(ui.elements.get("preview").hidden, false);
  assert.equal(Boolean(ui.context.hasProfileDraft()), change !== "none");
  assert.equal(ui.elements.get("applyButton").disabled, change === "none");
  assert.equal(ui.elements.get("editorDiscardButton").disabled, change === "none");
  if (change !== "none") {
    await ui.elements.get("applyButton").onclick();
    assert.equal(applied.length, 1); assert.equal(applied[0].text, original);
    assert.equal(Boolean(ui.context.hasProfileDraft()), false);
    await ui.elements.get("reviewEditButton").onclick();
    ui.elements.get("editorDiscardButton").onclick();
    assert.equal(ui.elements.get("preview").hidden, true);
    assert.equal(Boolean(ui.context.hasProfileDraft()), false);
  } else {
    await ui.elements.get("editSettingsButton").onclick();
    assert.equal(ui.elements.get("preview").hidden, true);
    await ui.elements.get("reviewEditButton").onclick();
    ui.elements.get("editorLocalButton").onclick(); await ui.flush(); await ui.flush();
    assert.equal(Boolean(ui.elements.get("editorSwitchDialog").open), false);
    assert.equal(ui.elements.get("editorDocument").value, "project_local");
  }
});

for (const failure of ["preview", "apply"]) for (const change of ["text", "gitignore"]) test(`failed ${failure} preserves ${change} preview changes for retry or discard`, async () => {
  const original = "project: {id: old}\n";
  let failWrite = true, applied = 0, reviewed = false;
  const ui = screen(async (name, args) => {
    if (["settings.read", "settings.status"].includes(name)) return read;
    if (name === "settings.edit") return { text: original, format: "yaml", baseRevision: "base", layerScope: "profile" };
    if (name === "settings.document_fields") return { schema: { type: "object" }, value: parse(args.text) };
    if (name === "settings.preview") {
      if (reviewed && failWrite && failure === "preview") throw new Error("Preview failed");
      reviewed = true;
      return { repositories: [], revision: "preview", formattedText: canonical_yaml(original),
        textChanged: change === "text", gitignoreChange: change === "gitignore" ? { beforeText: "", afterText: "/project.local.yaml\n" } : null };
    }
    if (name === "settings.apply") { applied++; if (failWrite) throw new Error("Write failed"); return {}; }
    throw new Error(name);
  });
  await ui.flush(); await ui.elements.get("editSettingsButton").onclick(); await ui.flush();
  await ui.elements.get("reviewEditButton").onclick();
  await ui.elements.get("applyButton").onclick();
  assert.equal(applied, failure === "apply" ? 1 : 0); assert.equal(ui.elements.get("settingsText").value, original);
  assert.equal(Boolean(ui.context.hasProfileDraft()), true);
  assert.equal(ui.elements.get("applyButton").disabled, false);
  assert.equal(ui.elements.get("editorDiscardButton").disabled, false);
  ui.context.show("support"); ui.context.show("editor");
  assert.equal(ui.elements.get("preview").hidden, true);
  failWrite = false; await ui.elements.get("applyButton").onclick();
  assert.equal(applied, failure === "apply" ? 2 : 1); assert.equal(Boolean(ui.context.hasProfileDraft()), false);
});

test("the save shortcut uses the physical key with a Russian keyboard layout and ignores repeats during a save", async () => {
  let applied = 0, prevented = 0, release;
  const ui = screen(async (name, args) => {
    if (["settings.read", "settings.status"].includes(name)) return read;
    if (name === "settings.edit") return { text: "project: {}\n", format: "yaml", baseRevision: "base", layerScope: "profile" };
    if (name === "settings.document_fields") return { schema: {}, value: parse(args.text) };
    if (name === "settings.preview") return new Promise(resolve => { release = () => resolve({ repositories: [], revision: "preview" }); });
    if (name === "settings.apply") { applied++; return {}; }
    throw new Error(name);
  });
  await ui.flush(); await ui.elements.get("editSettingsButton").onclick();
  ui.elements.get("settingsText").value += "# edited\n"; ui.elements.get("settingsText").events.input();
  const event = { key: "ы", code: "KeyS", ctrlKey: true, preventDefault() { prevented++; } };
  ui.elements.get("editorControls").events.keydown(event); await ui.flush();
  ui.elements.get("editorControls").events.keydown(event); await ui.flush();
  assert.equal(prevented, 2);
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.preview").length, 1);
  assert.equal(ui.elements.get("editorDiscardButton").disabled, true);
  release(); await ui.flush(); await ui.flush();
  assert.equal(applied, 1);
});

test("validation errors appear beside the affected field and in the general status", async () => {
  const backend = new SettingsBackend("unused-state", "unused-settings"), text = "repositories:\n  - path: ../outside\n";
  const ui = screen(async (name, args) => {
    if (["settings.read", "settings.status"].includes(name)) return read;
    if (name === "settings.edit") return { text, format: "yaml", baseRevision: "base", layerScope: "profile" };
    if (name === "settings.document_fields") return backend.main({ action: "document_fields", ...args });
    if (name === "settings.preview") throw new Error("/repositories/0/path: Path escapes project");
    throw new Error(name);
  });
  await ui.flush(); await ui.elements.get("editSettingsButton").onclick();
  ui.elements.get("editorMode").value = "tree"; ui.elements.get("editorMode").events.change(); await ui.flush(); await ui.flush();
  const field = treeInputs(ui).find(input => input.attributes?.["aria-label"] === "repositories.0.path"); assert.ok(field);
  await ui.elements.get("reviewEditButton").onclick();
  assert.equal(field.attributes["aria-invalid"], "true");
  assert.match(field.parentNode.children.map(item => item.textContent).join(" "), /Path escapes project/);
  assert.match(ui.elements.get("editorValidation").textContent, /Path escapes project/);
});

test("nullable fields remain editable and pending field edits block saving the old draft", async () => {
  const backend = new SettingsBackend("unused-state", "unused-settings");let release;
  const ui = screen(async (name,args) => {
    if(name==="settings.read"||name==="settings.status")return read;
    if(name==="settings.edit")return {text:"knowledge:\n  manifest: old.yaml\n",format:"yaml",baseRevision:"base",layerScope:"profile"};
    if(name==="settings.document_fields")return backend.main({action:"document_fields",...args});
    if(name==="settings.document_patch")return new Promise(resolve=>{release=()=>resolve(patch_yaml_draft(args.text,args.operation));});
    throw new Error(name);
  });
  await ui.flush();await ui.elements.get("editSettingsButton").onclick();ui.elements.get("editorMode").value="tree";ui.elements.get("editorMode").events.change();await ui.flush();await ui.flush();
  const input=treeInputs(ui).find(item=>item.attributes?.["aria-label"]==="knowledge.manifest");assert.ok(input);input.value="new.yaml";input.onchange();await ui.flush();
  assert.equal(ui.elements.get("reviewEditButton").disabled,true);assert.equal(ui.elements.get("applyButton").disabled,true);assert.equal(ui.elements.get("editorMode").disabled,true);
  await ui.elements.get("reviewEditButton").onclick();assert.equal(ui.calls.some(call=>call.params?.name==="settings.preview"),false);
  release();await ui.flush();await ui.flush();assert.match(ui.elements.get("settingsText").value,/manifest: "new.yaml"/);
});

test("detailed log export sends the selected period and displays the confirmed path", async () => {
  let days;
  const ui=screen(async(name,args)=>{
    if(name==="settings.read"||name==="settings.status")return read;
    if(name==="settings.export_log"){days=args.days;return {path:"C:/support/log.txt",canOpenDirectory:true};}
    throw new Error(name);
  });
  await ui.flush();ui.elements.get("logPeriod").value="3";await ui.elements.get("exportLogButton").onclick();
  assert.equal(days,3);assert.equal(ui.elements.get("diagnosticsPath").textContent,"C:/support/log.txt");assert.equal(ui.elements.get("diagnosticsSaved").hidden,false);
});


test("project transfer reviews YAML and requires replacement confirmation", async () => {
  let applied;
  const ui=screen(async(name,args)=>{
    if(name==="settings.read"||name==="settings.status")return read;
    if(name==="settings.pick_import_file")return {id:"pick",status:"running"};
    if(name==="settings.operation")return {id:"pick",status:"completed",action:"pick_import_file",projectRoot:read.values.projectRoot,result:{fileId:"file"}};
    if(name==="settings.import_file")return {scope:"profile",filename:"project.yaml",text:"{}\n"};
    if(name==="settings.transfer_context")return {baseRevision:"base"};
    if(name==="settings.transfer_preview")return {revision:"review",files:[{path:"project.yaml",scope:"profile",exists:true,changes:[]}]};
    if(name==="settings.transfer_apply"){applied=args;return {backups:[{scope:"profile",path:"backup.yaml"}]};}
    throw new Error(name);
  });
  await ui.flush();ui.elements.get("openImportButton").onclick();
  ui.elements.get("transferScope").value="profile";
  ui.elements.get("transferPath").value="C:/input/project.yaml";await ui.elements.get("transferPick").onclick();
  await ui.elements.get("transferPreview").onclick();
  await ui.elements.get("transferApply").onclick();assert.equal(applied,undefined);
  ui.elements.get("transferReplace").checked=true;ui.elements.get("transferReplace").events.change();await ui.elements.get("transferApply").onclick();
  assert.equal(applied.revision,"review");assert.equal(applied.replace,true);assert.equal(applied.documents.profile,"{}\n");
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.run_check").length,0);
  assert.match(ui.elements.get("transferDetails").children[0].textContent,/backup\.yaml/);
});


test("profile table and header show detected EDT projects separately from the shared Git repository", async () => {
  const projects=[{name:"configuration",displayName:"Base",directory:"C:/fixture/project/configuration"},{name:"extension",displayName:"<Extension>",directory:"C:/fixture/project/extension"},{name:"other",directory:"C:/fixture/project/other"}];
  const ui=screen(async()=>({...read,profile:{...read.profile,repositories:[{id:"shared",path:read.values.projectRoot}]},directoryContext:{edt:{detectedProjects:projects.slice(0,1),projectCount:1},git:{status:"not_repository"}},profileDirectoryContext:{edt:{detectedProjects:projects,projectCount:3},git:{status:"detected",root:read.values.projectRoot}}}));
  await ui.flush();assert.match(ui.elements.get("headerProfileFacts").textContent,/EDT-проектов: 3/);
  const rows=ui.elements.get("profileEdtProjects").children;assert.equal(rows.length,3);
  assert.deepEqual(rows.map(row=>row.children.map(cell=>cell.textContent)),projects.map(project=>[project.name,project.displayName||"—",project.directory]));
  assert.equal(ui.elements.get("profileGitRoot").textContent,"Git-репозиторий каталога профиля: "+read.values.projectRoot);
  assert.match(ui.context.describeProjectImport({edtMappings:[{repository:"repo",project:"examples",status:"ambiguous"}]}),/найдено несколько подходящих каталогов/);
});





test("history view displays the read-only YAML profile", async () => {
  const document = "project:\n  id: viewed\n",local = "project:\n  purpose: local\n";
  const ui = screen(async (name,args) => name === "settings.document" ? { text: args.layerScope==="project_local"?local:document, format: "yaml" } : { ...read, viewOnly: true });
  await ui.flush(); await ui.elements.get("editSettingsButton").onclick();
  assert.equal(ui.elements.get("settingsText").value, document);
  assert.equal(ui.elements.get("settingsText").readOnly, true);
  assert.equal(ui.elements.get("editorDocument").value, "profile");
  assert.equal(ui.elements.get("editorDocument").disabled,false);
  ui.elements.get("editorDocument").value="project_local";ui.elements.get("editorDocument").events.change();await ui.flush();
  assert.equal(ui.elements.get("settingsText").value,local);
  assert.equal(ui.elements.get("settingsText").readOnly,true);
});

test("settings export confirms a saved YAML file without browser downloads", async () => {
  const savedPath="C:/fixture/state/exports/project.yaml";
  const ui=screen(async name=>{
    if(name==="settings.read")return read;
    if(name==="settings.transfer_export")return {path:savedPath};
    throw new Error(name);
  });await ui.flush();await ui.elements.get("transferExport").onclick();
  assert.match(ui.elements.get("status").textContent,/сохранён/);
  assert.match(ui.elements.get("status").textContent,/project.yaml/);
  assert.equal(ui.downloads.length,0);
});

test("settings export never reports success when the disk write fails or no path is confirmed", async () => {
  for(const result of [null,{text:"{}"}]){
    const ui=screen(async name=>{
      if(name==="settings.read")return read;
      if(name==="settings.transfer_export"){if(!result)throw new Error("Disk unavailable");return result;}
      throw new Error(name);
    });await ui.flush();await ui.elements.get("transferExport").onclick();
    assert.match(ui.elements.get("status").textContent,/Диск недоступен|не подтверждено/);
    assert.equal(ui.downloads.length,0);
  }
});

test("diagnostics save stays available during preparation and shows the confirmed file path", async () => {
  const operation = { id: "pending", action: "check", status: "running" };
  let release;
  const ui = screen(async name => {
    if (name === "settings.read") return { ...read, operation };
    if (name === "settings.operation") return operation;
    if (name === "settings.export_diagnostics") return new Promise(resolve => { release = resolve; });
    if (name === "settings.open_diagnostics_directory") return {};
    throw new Error(name);
  });
  await ui.flush();
  assert.equal(ui.elements.get("readinessButton").disabled, true);
  assert.equal(ui.elements.get("diagnosticsButton").disabled, false);
  const pending = ui.elements.get("diagnosticsButton").onclick(); await ui.flush();
  assert.equal(ui.elements.get("diagnosticsButton").disabled, true);
  await ui.elements.get("diagnosticsButton").onclick();
  const savedPath = "C:/fixture/state/diagnostics/exports/1c-ai-core-diagnostics.json";
  release({ filename: "1c-ai-core-diagnostics.json", path: savedPath, canOpenDirectory: true });
  await pending;
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.export_diagnostics").length, 1);
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.run_check").length, 0);
  assert.equal(ui.downloads.length, 0);
  assert.equal(ui.elements.get("diagnosticsPath").textContent, savedPath);
  assert.equal(ui.elements.get("diagnosticsSaved").hidden, false);
  assert.equal(ui.elements.get("openDiagnosticsButton").hidden, false);
  assert.equal(ui.elements.get("openDiagnosticsButton").disabled, false);
  assert.match(ui.elements.get("status").textContent, /Файл|файл/);
  await ui.elements.get("openDiagnosticsButton").onclick();
  const opened = ui.calls.find(call => call.params?.name === "settings.open_diagnostics_directory");
  assert.equal(JSON.stringify(opened.params.arguments), "{}");
  assert.equal(ui.elements.get("diagnosticsButton").disabled, false);
  assert.equal(ui.elements.get("readinessButton").disabled, true);
});

test("diagnostics remain accessible when the first settings read fails", async () => {
  const ui = screen(async name => {
    if (name === "settings.read") throw new Error("damaged settings");
    if (name === "settings.export_diagnostics") return { path: "C:/fixture/support.json" };
    throw new Error(name);
  });
  await ui.flush();
  await ui.elements.get("diagnosticsButton").onclick();
  assert.equal(ui.elements.get("diagnosticsPath").textContent, "C:/fixture/support.json");
  assert.equal(ui.elements.get("openDiagnosticsButton").hidden, true);
});

test("a failed or legacy diagnostics export never claims a file was saved", async () => {
  for (const result of [null, { filename: "memory-only.json", text: "{}" }]) {
    const ui = screen(async name => {
      if (name === "settings.read") return read;
      if (name === "settings.export_diagnostics") { if (!result) throw new Error("Disk unavailable"); return result; }
      throw new Error(name);
    });
    await ui.flush(); await ui.elements.get("diagnosticsButton").onclick();
    assert.doesNotMatch(ui.elements.get("status").textContent, /файл сохранён/i);
    assert.equal(ui.elements.get("diagnosticsPath").textContent, "");
    assert.equal(ui.downloads.length, 0);
  }
});

test("directory context shows EDT and Git facts safely while an ambiguous profile cannot be created", async () => {
  const ui = screen(async name => {
    assert.equal(name, "settings.read");
    return { ...read, profile: { status: "ambiguous", detail: "Select a specific folder" },
      values: { ...read.values, edtUrl: "http://127.0.0.1:19801/mcp" }, connectionSources: { edt: "edt_workspace" },
      directoryContext: { directory: read.values.projectRoot,
        edt: { projects: [{ name: "<Project>", runtimeVersion: "8.5.1", source: "C:/fixture/project/src" }], connection: { url: "http://127.0.0.1:19801/mcp" } },
        git: { status: "detected", root: read.values.projectRoot, branch: "topic", commit: "a".repeat(40) } } };
  });
  await ui.flush();
  assert.equal(ui.elements.get("directoryInfo").hidden, false);
  assert.match(ui.elements.get("directoryInfoText").textContent, /<Project> · платформа 8\.5\.1/);
  assert.match(ui.elements.get("directoryInfoText").textContent, /Ветка: topic/);
  assert.match(ui.elements.get("edtSource").textContent, /Действует: http:\/\/127\.0\.0\.1:19801\/mcp — настройки EDT/);
  assert.equal(ui.elements.get("createButton").hidden, true);
});

test("component selection is saved independently and update polling never repeats installation",async()=>{
  let enabled=false,polls=0;
  const ui=screen(async(name,args)=>{
    if(name==="settings.read")return {...read,values:{...read.values,codeIndexEnabled:true,bslLsEnabled:enabled}};
    if(name==="settings.update"){assert.equal(args.set.bslLsEnabled,true);enabled=true;return {};}
    if(name==="settings.updates"){assert.equal(args.operation,"install");assert.equal(args.component,"bsl-ls");assert.equal(args.authorization.scope,read.preparationScope);return {id:"update",status:"running"};}
    if(name==="settings.operation")return ++polls===1?{id:"update",status:"running",action:"updates"}:{id:"update",status:"completed",action:"updates",projectRoot:read.values.projectRoot,instance:read.instance,result:{component:"bsl-ls",state:"applied",release:"v9.0.0"}};
    throw new Error(name);
  });
  await ui.flush();assert.equal(ui.elements.get("bslLsEnabled").checked,false);
  ui.elements.get("bslLsEnabled").checked=true;ui.elements.get("bslLsEnabled").events.change();await ui.elements.get("saveComponentsButton").onclick();assert.equal(enabled,true);
  assert.equal(ui.calls.filter(c=>c.params?.name==="settings.run_check").length,0);
  ui.elements.get("updateComponent").value="bsl-ls";await ui.elements.get("installUpdateButton").onclick();await ui.tick();
  assert.equal(ui.calls.filter(c=>c.params?.name==="settings.updates").length,1);
  assert.match(ui.elements.get("updatesResult").textContent,/BSL LS: установлена версия · v9.0.0/);
});

test("the searchable version picker keeps independent drafts without changing runtime settings", async () => {
  const values={...read.values,codeIndexVersion:"latest",bslLsVersion:"latest",bslLsAllowPrerelease:true};
  const ui=screen(async(name,args)=>{
    if(name==="settings.read"||name==="settings.status")return {...read,values:{...values}};
    if(name==="settings.versions")return {component:args.component,versions:args.component==="bsl-ls"?[{version:"v1.1.0-rc.7"},{version:"v1.1.0-rc.4"}]:[{version:"v1.14.1"}]};
    throw new Error(name);
  });await ui.flush();assert.equal(ui.elements.get("versionValue").textContent,"Последняя стабильная версия");
  for(const id of ["codeIndexVersion","bslLsVersion","codeIndexAllowPrerelease","bslLsAllowPrerelease","saveVersionsButton"])assert.equal(ui.elements.has(id),false);
  ui.elements.get("updateComponent").value="bsl-ls";ui.elements.get("updateComponent").events.change();await ui.elements.get("versionButton").onclick();
  assert.deepEqual(ui.elements.get("versionOptions").children.map(option=>option.textContent),["Последняя подходящая версия","v1.1.0-rc.7","v1.1.0-rc.4"]);
  ui.elements.get("versionSearch").value="rc.7";ui.elements.get("versionSearch").events.input();await ui.context.refreshStatus();
  assert.equal(ui.elements.get("versionSearch").value,"rc.7");assert.equal(ui.elements.get("versionOptions").children.length,1);
  await ui.elements.get("versionOptions").children[0].onclick();assert.equal(ui.elements.get("versionValue").textContent,"v1.1.0-rc.7");assert.equal(ui.elements.get("versionPopup").hidden,true);
  ui.elements.get("updateComponent").value="code-index";ui.elements.get("updateComponent").events.change();assert.equal(ui.elements.get("versionValue").textContent,"Последняя стабильная версия");
  await ui.elements.get("versionButton").onclick();assert.deepEqual(ui.elements.get("versionOptions").children.map(option=>option.textContent),["Последняя стабильная версия","v1.14.1"]);
  ui.elements.get("updateComponent").value="bsl-ls";ui.elements.get("updateComponent").events.change();assert.equal(ui.elements.get("versionValue").textContent,"v1.1.0-rc.7");
  await ui.context.refreshStatus();assert.equal(ui.elements.get("versionValue").textContent,"v1.1.0-rc.7");
  assert.equal(values.bslLsVersion,"latest");assert.equal(values.bslLsAllowPrerelease,true);
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.update").length,0);
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.updates").length,0);
});

test("version search covers the complete large catalog, limits visible rows and supports keyboard selection", async () => {
  const versions=Array.from({length:2500},(_,i)=>({version:"v"+(2500-i)+".0.0"}));
  const ui=screen(async(name,args)=>{
    if(name==="settings.read")return {...read,values:{...read.values,codeIndexVersion:"latest"}};
    if(name==="settings.versions")return {component:args.component,versions};
    throw new Error(name);
  });await ui.flush();await ui.elements.get("versionButton").onclick();
  assert.equal(ui.elements.get("versionOptions").children.length,50);assert.equal(ui.elements.get("moreVersionsButton").hidden,false);
  ui.elements.get("moreVersionsButton").onclick();assert.equal(ui.elements.get("versionOptions").children.length,100);
  ui.elements.get("versionSearch").value="v1.0.0";ui.elements.get("versionSearch").events.input();
  assert.deepEqual(ui.elements.get("versionOptions").children.map(option=>option.textContent),["v1.0.0"]);
  ui.elements.get("versionSearch").events.keydown({key:"ArrowDown",preventDefault(){}});
  assert.equal(ui.elements.get("versionSearch").attributes["aria-activedescendant"],"version-option-0");
  ui.elements.get("versionSearch").events.keydown({key:"Enter",preventDefault(){}});await ui.flush();await ui.flush();
  assert.equal(ui.elements.get("versionValue").textContent,"v1.0.0");
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.update").length,0);
  await ui.elements.get("versionButton").onclick();ui.elements.get("versionSearch").events.keydown({key:"Escape",preventDefault(){}});
  assert.equal(ui.elements.get("versionPopup").hidden,true);assert.equal(ui.calls.filter(call=>call.params?.name==="settings.versions").length,1);
});

test("a failed version catalog can retry and a late response cannot replace another component's list", async () => {
  let attempt=0,finish;
  const ui=screen(async(name,args)=>{
    if(name==="settings.read")return read;
    if(name==="settings.versions"){
      if(args.component==="bsl-ls")return new Promise(resolve=>{finish=()=>resolve({component:"bsl-ls",versions:[{version:"v1.1.0-rc.7"}]});});
      if(++attempt===1)throw new Error("offline");return {component:"code-index",versions:[{version:"v1.14.1"}]};
    }throw new Error(name);
  });await ui.flush();await ui.elements.get("versionButton").onclick();assert.match(ui.elements.get("versionHint").textContent,/Не удалось подключиться к серверу/);
  await ui.elements.get("refreshVersionsButton").onclick();assert.equal(ui.elements.get("refreshVersionsButton").disabled,false);
  ui.elements.get("updateComponent").value="bsl-ls";ui.elements.get("updateComponent").events.change();const pending=ui.elements.get("versionButton").onclick();await ui.flush();
  ui.elements.get("updateComponent").value="code-index";ui.elements.get("updateComponent").events.change();await ui.elements.get("versionButton").onclick();finish();await pending;
  assert.deepEqual(ui.elements.get("versionOptions").children.map(option=>option.textContent),["Последняя стабильная версия","v1.14.1"]);
});

test("an empty BSL LS catalog shows a retry and refreshes the server instead of reporting latest as the full list", async () => {
  let attempts=0;
  const ui=screen(async(name,args)=>{
    if(name==="settings.read")return read;
    if(name==="settings.versions"){
      if(args.component==="code-index")return {component:"code-index",versions:[{version:"v1.14.1"}]};
      if(++attempts===1)return {component:"bsl-ls",versions:[]};
      assert.equal(args.refresh,true);return {component:"bsl-ls",versions:[{version:"v1.1.0-rc.7"},{version:"v1.1.0-rc.4"}]};
    }throw new Error(name);
  });await ui.flush();await ui.elements.get("versionButton").onclick();
  ui.elements.get("updateComponent").value="bsl-ls";ui.elements.get("updateComponent").events.change();await ui.elements.get("versionButton").onclick();
  assert.match(ui.elements.get("versionHint").textContent,/пустой каталог/);assert.doesNotMatch(ui.elements.get("versionHint").textContent,/Найдено: 1/);
  assert.equal(ui.elements.get("refreshVersionsButton").disabled,false);await ui.elements.get("refreshVersionsButton").onclick();
  assert.deepEqual(ui.elements.get("versionOptions").children.map(option=>option.textContent),["Последняя подходящая версия","v1.1.0-rc.7","v1.1.0-rc.4"]);
  assert.equal(ui.elements.get("refreshVersionsButton").disabled,false);
});

test("installation uses one authorized operation for the selected component", async () => {
  for(const component of ["code-index","bsl-ls"]){
    const ui=screen(async(name,args)=>{
      if(name==="settings.read")return read;
      if(name==="settings.updates"){assert.equal(args.operation,"install");assert.equal(args.component,component);assert.equal(args.version,"latest");assert.equal(args.authorization.scope,read.preparationScope);return {id:"install-update",status:"running"};}
      if(name==="settings.operation")return {id:"install-update",action:"updates",projectRoot:read.values.projectRoot,instance:read.instance,status:"completed",result:{component,state:"applied",release:"v1.0.0"}};
      throw new Error(name);
    });await ui.flush();ui.elements.get("updateComponent").value=component;await ui.elements.get("installUpdateButton").onclick();
    assert.equal(ui.calls.filter(call=>call.params?.name==="settings.updates").length,1);
    assert.equal(ui.elements.get("updatesResult").textContent,(component==="bsl-ls"?"BSL LS":"Индекс кода")+": установлена версия · v1.0.0");
  }
});

test("installation is disabled for the verified active version and latest resolves independently of prereleases", async () => {
  for(const component of ["code-index","bsl-ls"]){
    const field=component==="bsl-ls"?"bslLsVersion":"codeIndexVersion";
    let finish,installed="v1.0.7";
    const ui=screen(async(name,args)=>{
      if(name==="settings.read"||name==="settings.status")return {...read,values:{...read.values,[field]:"latest"},installedVersions:{[component]:installed}};
      if(name==="settings.versions"){
        assert.equal(args.component,component);
        return new Promise(resolve=>{finish=()=>resolve({component,latest:"v1.0.7",versions:[{version:"v2.0.0-rc.1",prerelease:true},{version:"v1.0.7"},{version:"1.0.7"}]});});
      }
      throw new Error(name);
    });await ui.flush();ui.elements.get("updateComponent").value=component;ui.elements.get("updateComponent").events.change();
    const pending=ui.elements.get("versionButton").onclick();await ui.flush();
    assert.equal(ui.elements.get("installUpdateButton").disabled,true);
    finish();await pending;
    assert.equal(ui.elements.get("installUpdateButton").disabled,true);
    assert.match(ui.elements.get("installHint").textContent,component==="bsl-ls"?/Последняя подходящая версия: v1\.0\.7/:/Последняя стабильная версия: v1\.0\.7/);
    assert.match(ui.elements.get("installUpdateButton").title,/уже установлена/);
    const choose=async version=>{
      if(ui.elements.get("versionPopup").hidden)await ui.elements.get("versionButton").onclick();
      await ui.elements.get("versionOptions").children.find(option=>option.textContent===(version==="latest"?(component==="bsl-ls"?"Последняя подходящая версия":"Последняя стабильная версия"):version)).onclick();
    };
    await choose("v1.0.7");assert.equal(ui.elements.get("installUpdateButton").disabled,true);
    await choose("1.0.7");assert.equal(ui.elements.get("installUpdateButton").disabled,true);
    await choose("v2.0.0-rc.1");assert.equal(ui.elements.get("installUpdateButton").disabled,false);
    installed="v2.0.0-rc.1";await ui.context.refreshStatus();
    assert.equal(ui.elements.get("installUpdateButton").disabled,true);
    await ui.elements.get("installUpdateButton").onclick();
    assert.equal(ui.calls.filter(call=>call.params?.name==="settings.updates").length,0);
    await choose("latest");assert.equal(ui.elements.get("installUpdateButton").disabled,false);
  }
});

test("latest reflects a locally overridden prerelease policy, but an explicit install resets the shared policy", async () => {
  for (const source of ["settings", "project_local", "instance"]) {
    const ui=screen(async(name,args)=>{
      if(name==="settings.read"||name==="settings.status")return {...read,
        values:{...read.values,codeIndexVersion:"latest",codeIndexAllowPrerelease:true},
        managedValueSources:{codeIndexAllowPrerelease:source},installedVersions:{"code-index":"v1.0.0"}};
      if(name==="settings.versions")return {component:args.component,latest:"v1.0.0",latestPrerelease:"v2.0.0-rc.1",
        versions:[{version:"v2.0.0-rc.1",prerelease:true},{version:"v1.0.0"}]};
      throw new Error(name);
    });
    await ui.flush();await ui.elements.get("versionButton").onclick();
    assert.equal(ui.elements.get("installUpdateButton").disabled,source==="settings");
    assert.match(ui.elements.get("installHint").textContent,source==="settings"?/v1\.0\.0/:/v2\.0\.0-rc\.1/);
  }
});

test("an unresolved prerelease latest does not fall back to a stable release", async () => {
  const ui=screen(async(name,args)=>{
    if(name==="settings.read"||name==="settings.status")return {...read,
      values:{...read.values,codeIndexVersion:"latest",codeIndexAllowPrerelease:true},
      managedValueSources:{codeIndexAllowPrerelease:"project_local"},installedVersions:{"code-index":"v1.0.0"}};
    if(name==="settings.versions")return {component:args.component,latest:"v2.0.0",latestPrerelease:null,
      versions:[{version:"v2.0.0"}]};
    throw new Error(name);
  });
  await ui.flush();await ui.elements.get("versionButton").onclick();
  assert.equal(ui.elements.get("installUpdateButton").disabled,true);
  assert.match(ui.elements.get("installHint").textContent,/Не удалось определить подходящую версию/);
});

test("an unresolved latest keeps installation disabled while exact versions remain usable", async () => {
  const ui=screen(async(name,args)=>{
    if(name==="settings.read")return {...read,installedVersions:{"code-index":"v1.0.0"}};
    if(name==="settings.versions")return {component:args.component,versions:[{version:"v1.0.0"},{version:"v2.0.0"}],latest:null,latestError:"HTTP 503"};
    throw new Error(name);
  });await ui.flush();await ui.elements.get("versionButton").onclick();
  assert.equal(ui.elements.get("installUpdateButton").disabled,true);
  assert.match(ui.elements.get("installHint").textContent,/Не удалось определить подходящую версию/);
  await ui.elements.get("versionOptions").children.find(option=>option.textContent==="v2.0.0").onclick();
  assert.equal(ui.elements.get("installUpdateButton").disabled,false);
});

test("an inconsistent saved pin can be repaired by installing the working version", async () => {
  let saved="v2.0.0";
  const ui=screen(async(name,args)=>{
    if(name==="settings.read")return {...read,values:{...read.values,codeIndexVersion:saved},installedVersions:{"code-index":"v1.0.0"}};
    if(name==="settings.versions")return {component:args.component,latest:"v2.0.0",versions:[{version:"v1.0.0"},{version:"v2.0.0"}]};
    if(name==="settings.updates"){assert.equal(args.version,"v1.0.0");return {id:"repair-pin",status:"running"};}
    if(name==="settings.operation"){saved="v1.0.0";return {id:"repair-pin",action:"updates",projectRoot:read.values.projectRoot,instance:read.instance,status:"completed",result:{component:"code-index",state:"applied",requested:saved,release:saved}};}
    throw new Error(name);
  });await ui.flush();await ui.elements.get("versionButton").onclick();
  await ui.elements.get("versionOptions").children.find(option=>option.textContent==="v1.0.0").onclick();
  assert.equal(ui.elements.get("installUpdateButton").disabled,false);
  assert.match(ui.elements.get("installHint").textContent,/настройка отличается/);
  await ui.elements.get("installUpdateButton").onclick();assert.equal(saved,"v1.0.0");
  assert.equal(ui.elements.get("installUpdateButton").disabled,true);
});

test("the catalog refresh icon preserves search and selection, bypasses cache and shares an in-flight request", async () => {
  let calls=0,finish;
  const ui=screen(async(name,args)=>{
    if(name==="settings.read")return {...read,values:{...read.values,codeIndexVersion:"v1.0.0"}};
    if(name==="settings.versions"){
      if(++calls===1)return {component:args.component,versions:[{version:"v1.0.0"}]};
      assert.equal(args.component,"code-index");assert.equal(args.refresh,true);
      return new Promise(resolve=>{finish=()=>resolve({component:args.component,versions:[{version:"v1.0.1"},{version:"v1.0.0"}]});});
    }
    throw new Error(name);
  });await ui.flush();await ui.elements.get("versionButton").onclick();
  ui.elements.get("versionSearch").value="v1.0";ui.elements.get("versionSearch").events.input();
  const pending=ui.elements.get("refreshVersionsButton").onclick();await ui.flush();
  assert.equal(ui.elements.get("refreshVersionsButton").disabled,true);
  assert.equal(ui.elements.get("refreshVersionsButton").attributes["aria-busy"],"true");
  const duplicate=ui.elements.get("refreshVersionsButton").onclick();assert.equal(calls,2);
  finish();await pending;await duplicate;
  assert.equal(ui.elements.get("refreshVersionsButton").disabled,false);
  assert.equal(ui.elements.get("refreshVersionsButton").attributes["aria-busy"],"false");
  assert.equal(ui.elements.get("versionSearch").value,"v1.0");
  assert.equal(ui.elements.get("versionValue").textContent,"v1.0.0");
  assert.equal(ui.elements.get("versionPopup").hidden,false);
  assert.deepEqual(ui.elements.get("versionOptions").children.map(option=>option.textContent),["v1.0.1","v1.0.0"]);
  ui.elements.get("versionSearch").events.keydown({key:"Tab"});
  assert.equal(ui.elements.get("versionPopup").hidden,false);
  ui.elements.get("versionPopup").events.keydown({key:"Escape",preventDefault(){}});
  assert.equal(ui.elements.get("versionPopup").hidden,true);
  assert.equal(ui.calls.filter(call=>["settings.update","settings.updates"].includes(call.params?.name)).length,0);
});

test("a failed installation is reported without resubmitting or claiming success", async () => {
  const ui=screen(async(name)=>{
    if(name==="settings.read")return read;
    if(name==="settings.updates")return {id:"failed-install",status:"running"};
    if(name==="settings.operation")return {id:"failed-install",action:"updates",projectRoot:read.values.projectRoot,instance:read.instance,status:"failed",error:"Candidate rejected; active artifact retained: bad API"};
    throw new Error(name);
  });await ui.flush();await ui.elements.get("installUpdateButton").onclick();
  assert.match(ui.elements.get("status").textContent,/Прежняя версия сохранена/);
  assert.doesNotMatch(ui.elements.get("updatesResult").textContent,/установлена версия/);
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.updates").length,1);
});

test("UI translates an uncertain operation without changing its diagnostic data", async () => {
  const operation={id:"unknown",action:"updates",projectRoot:read.values.projectRoot,instance:read.instance,
    status:"outcome_unknown",error:"External MCP rejected the request (HTTP 503); remote error text omitted"};
  const ui=screen(async name=>{if(name==="settings.read")return read;if(name==="settings.operation")return operation;throw new Error(name);});
  await ui.flush();await ui.context.pollOperation("unknown");
  assert.match(ui.elements.get("status").textContent,/Внешний сервер MCP отклонил запрос \(HTTP 503\)/);
  assert.match(ui.elements.get("status").textContent,/перед повтором/);
  assert.equal(operation.error,"External MCP rejected the request (HTTP 503); remote error text omitted");
  assert.equal(ui.context.userMessage("v24.20.0"),"v24.20.0");
  const missing="Не найден или неоднозначен .project для: base, examples, unit";
  assert.equal(ui.context.userMessage(missing),missing);
  assert.match(ui.context.userMessage("Ошибка: External MCP rejected the request (HTTP 503)"),/Внешний сервер MCP отклонил запрос/);
});

test("installing an older draft saves it on success and a later failure clears the old success message", async () => {
  let saved="v2.0.0",attempts=0;
  const ui=screen(async(name,args)=>{
    if(name==="settings.read"||name==="settings.status")return {...read,values:{...read.values,codeIndexVersion:saved}};
    if(name==="settings.versions")return {component:"code-index",versions:[{version:"v1.0.0"}]};
    if(name==="settings.updates"){
      assert.equal(args.operation,"install");assert.equal(args.version,"v1.0.0");
      if(++attempts===1)assert.equal(saved,"v2.0.0");
      return {id:"install-"+attempts,status:"running"};
    }
    if(name==="settings.operation"){
      if(attempts===2)return {id:"install-2",action:"updates",projectRoot:read.values.projectRoot,instance:read.instance,status:"failed",error:"offline"};
      saved="v1.0.0";return {id:"install-1",action:"updates",projectRoot:read.values.projectRoot,instance:read.instance,status:"completed",result:{component:"code-index",state:"applied",release:saved,requested:saved}};
    }
    throw new Error(name);
  });await ui.flush();await ui.elements.get("versionButton").onclick();
  await ui.elements.get("versionOptions").children.find(option=>option.textContent==="v1.0.0").onclick();
  assert.equal(saved,"v2.0.0");await ui.elements.get("installUpdateButton").onclick();
  assert.equal(saved,"v1.0.0");assert.match(ui.elements.get("updatesResult").textContent,/установлена версия · v1.0.0/);
  await ui.elements.get("installUpdateButton").onclick();assert.match(ui.elements.get("status").textContent,/Не удалось подключиться к серверу/);
  assert.doesNotMatch(ui.elements.get("updatesResult").textContent,/установлена версия/);
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.update").length,0);
});

test("switching the update component hides unrelated results and scopes every action", async () => {
  const ui=screen(async(name,args)=>{
    if(name==="settings.read")return read;
    if(name==="settings.updates")return {id:args.operation,action:"updates",projectRoot:read.values.projectRoot,instance:read.instance,status:"completed"};
    if(name==="settings.operation")return {id:args.operationId,action:"updates",projectRoot:read.values.projectRoot,instance:read.instance,status:"completed",result:{component:"bsl-ls",state:"current"}};
    throw new Error(name);
  });await ui.flush();
  ui.elements.get("updateComponent").value="bsl-ls";ui.elements.get("updateComponent").events.change();
  for(const id of ["updatesButton","downloadUpdateButton","applyUpdateButton","rollbackUpdateButton","retryVersionsButton"])assert.equal(ui.elements.has(id),false);
  await ui.elements.get("installUpdateButton").onclick();
  assert.deepEqual(ui.calls.filter(call=>call.params?.name==="settings.updates").map(call=>[call.params.arguments.component,call.params.arguments.operation]),[["bsl-ls","install"]]);
  assert.match(ui.elements.get("updatesResult").textContent,/BSL LS: актуален/);
  ui.elements.get("updateComponent").value="code-index";ui.elements.get("updateComponent").events.change();
  assert.doesNotMatch(ui.elements.get("updatesResult").textContent,/BSL LS/);
  ui.elements.get("updateComponent").value="bsl-ls";ui.elements.get("updateComponent").events.change();
  assert.match(ui.elements.get("updatesResult").textContent,/BSL LS: актуален/);
});

test("external connection button polls one read-only probe and displays project readiness", async () => {
  let probes = 0; const current = { ...read, values: { ...read.values, edtUrl: "http://edt" } };
  const ui = screen(async (name,args) => {
    if (name === "settings.read") return current;
    if (name === "settings.probe_connections") { assert.equal(args.component,"edt");probes++; return { id: "probe", status: "running" }; }
    if (name === "settings.operation") return { projectRoot: read.values.projectRoot, instance: read.instance, id: "probe", status: "completed", action: "probe", result: { external: { edt: { configured: true, connected: true, detail: "product: EDT сообщает о сборке проекта", repositories: [{ id: "product", matched: true, ready: false, state: "building" }] } } } };
    throw new Error(name);
  });
  await ui.flush(); ui.context.openConnectionDialog({id:"edt",name:"edt"},null); await ui.elements.get("probeButton").onclick();
  assert.equal(probes, 1);
  assert.equal(ui.elements.get("probeResult").textContent, "product: EDT сообщает о сборке проекта");
  assert.doesNotMatch(ui.elements.get("probeResult").textContent, /v8std:/);
  assert.match(html, /Каталог инструментов и подключение текущего чата не проверены/);
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.run_check").length, 0);
});

test("EDT diagnostics show each project once and follow the current component evidence", async () => {
  const detail = "crm-production: готов\ncrm-yaxunit: проект не открыт или его состояние открытия не подтверждено";
  const current = { ...read, values: { ...read.values, edtUrl: "http://edt", v8stdUrl: "http://v8std" } };
  const ui = screen(async name => {
    if (["settings.read", "settings.status"].includes(name)) return current;
    if (name === "settings.probe_connections") return { id: "edt-probe", status: "running" };
    if (name === "settings.operation") return { projectRoot: read.values.projectRoot, instance: read.instance, id: "edt-probe", status: "completed", action: "probe",
      result: { external: { edt: { configured: true, connected: true, ready: false, detail, repositories: [
        { id: "crm-production", matched: true, open: true, ready: true, state: "ready" },
        { id: "crm-yaxunit", matched: true, open: false, ready: false, state: "ready" },
      ] } } } };
    throw new Error(name);
  }); await ui.flush();
  ui.context.openConnectionDialog({ id: "edt", name: "EDT" }, null); await ui.elements.get("probeButton").onclick();
  const output = () => ui.elements.get("componentDialogDiagnostic").textContent + "\n" + ui.elements.get("probeResult").textContent;
  assert.equal(ui.elements.get("probeResult").textContent, detail);
  assert.equal(ui.elements.get("probeResult").hidden, false);
  assert.match(ui.elements.get("componentDialogCheckedAt").textContent,/Последняя попытка/);
  assert.deepEqual(ui.elements.get("externalProjectStates").children.map(row=>row.textContent),["crm-production: Готов","crm-yaxunit: Не открыт"]);
  assert.equal(output().match(/crm-production:/g).length, 1);
  assert.equal(output().match(/crm-yaxunit:/g).length, 1);
  assert.doesNotMatch(output(), /подключение проверено|crm-yaxunit: не готов/i);
  await ui.context.refresh(); assert.equal(ui.elements.get("probeResult").textContent, detail);
  ui.elements.get("componentDialog").close();
  ui.context.openConnectionDialog({ id: "v8std", name: "v8std" }, null);
  assert.equal(ui.elements.get("probeResult").hidden, true);
  assert.equal(ui.elements.get("probeResult").textContent, "");
  ui.elements.get("componentDialog").close();
  ui.context.openConnectionDialog({ id: "edt", name: "EDT" }, null);
  assert.equal(ui.elements.get("probeResult").textContent, detail);
  vm.runInContext('componentObservations.get("edt").check.expiresAt=new Date(Date.now()-1).toISOString()', ui.context);
  ui.context.renderDialogStates();
  assert.equal(ui.elements.get("componentDialogDiagnostic").textContent, "Проверка устарела");
  assert.ok(ui.elements.get("externalProjectStates").children.every(row=>row.textContent.endsWith("Проверка устарела")));
  vm.runInContext('componentObservations.get("edt").check.checkedAt=new Date(Date.now()-1000).toISOString()', ui.context);
  current.componentChecks = [{ id: "edt", state: "ready", detail: "crm-production: готов\ncrm-yaxunit: готов",
    checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() }];
  await ui.context.refresh();
  assert.equal(ui.elements.get("probeResult").textContent, "crm-production: готов\ncrm-yaxunit: готов");
  assert.equal(output().match(/crm-yaxunit:/g).length, 1);
});

for (const [state, detail] of [["ready", "crm-production: готов"], ["error", "Сервер EDT недоступен"]]) test(`the EDT dialog displays saved ${state} diagnostics once`, async () => {
  const current = { ...read, values: { ...read.values, edtUrl: "http://edt" }, componentChecks: [{ id: "edt", state, detail,
    checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() }] };
  const ui = screen(async () => current); await ui.flush();
  ui.context.openConnectionDialog({ id: "edt", name: "EDT" }, null);
  assert.equal(ui.elements.get("probeResult").textContent, detail);
  assert.equal(ui.elements.get("probeResult").hidden, false);
  assert.equal(ui.elements.get("componentDialogDiagnostic").textContent.includes(detail), false);
  assert.doesNotMatch(ui.elements.get("probeResult").textContent, /подключение проверено/i);
});

function isolatedProbeScreen(source, { delayed = false, failed = false, startFailed = false, deferredClose = false } = {}) {
  const ids = ["edt", "v8std", "openviking", "code-index", "bsl-ls", "yaxunit", "vanessa"], checkedAt = new Date(Date.now() - 1000).toISOString();
  const current = { ...read, instance: "default", settingsRevision: "saved", values: { ...read.values, edtUrl: "http://edt", v8stdUrl: "http://v8std",
    openvikingEnabled: true, openvikingUrl: "http://knowledge", codeIndexEnabled: true, bslLsEnabled: true },
    profile: { ...read.profile, testing: { yaxunit: true, vanessa: true } }, testing: { yaxunit_config: {}, vanessa_config: {} }, summary: { components: [] },
    componentChecks: ids.filter(id => id !== source).map(id => ({ id, state: "not_verified", detail: "Собственная диагностика " + id,
      checkedAt, expiresAt: new Date(Date.now() + 60000).toISOString() })) };
  let finish;
  const ui = screen(async (name, args) => {
    if (["settings.read", "settings.status"].includes(name)) return current;
    if (name === "settings.versions") return { component: args.component, versions: [] };
    if (name === "settings.edit") return { text: "testing: {}\n", format: "yaml", baseRevision: "base", layerScope: "profile" };
    if (name === "settings.document_fields") return new SettingsBackend("unused", "unused").main({ action: "document_fields", ...args });
    if (name === "settings.probe_connections") {
      assert.equal(args.component, source);
      if (startFailed) { await new Promise(resolve => { finish = resolve; }); throw new Error("Ошибка проверки " + source); }
      return { id: "probe-" + source, component: source, action: "probe", status: "running" };
    }
    if (name === "settings.operation") {
      if (delayed) await new Promise(resolve => { finish = resolve; });
      return { id: "probe-" + source, component: source, action: "probe", projectRoot: current.values.projectRoot, instance: current.instance,
        status: failed ? "failed" : "completed", ...(failed ? { error: "Ошибка проверки " + source } : { result: { component: source,
          componentChecks: [{ id: source, state: "not_verified", detail: "Результат проверки " + source }] } }) };
    }
    throw new Error(name);
  }, { deferredClose });
  const item = id => ui.context.catalogItems(current).find(item => item.id === id);
  const open = async id => {
    const card = ui.elements.get("componentCatalog").children.flatMap(group => group.children[1].children).find(card => componentName(card) === item(id).name);
    await componentButton(card).onclick();
    await ui.flush();
  };
  const close = id => ui.elements.get(item(id).kind === "external" ? "componentDialogClose" : item(id).kind === "managed" ? "managedDialogClose" : "testingDialogClose").onclick();
  const diagnostic = id => ui.elements.get(item(id).kind === "external" ? "probeResult" : item(id).kind === "managed" ? "managedDialogStatus" : "testingDialogStatus").textContent;
  const probe = id => ui.elements.get(item(id).kind === "external" ? "probeButton" : item(id).kind === "managed" ? "managedProbeButton" : "testingProbeButton").onclick();
  return { ui, current, ids, item, open, close, diagnostic, probe, finish: () => finish() };
}

for (const source of ["edt", "v8std", "openviking", "code-index", "bsl-ls", "yaxunit", "vanessa"]) {
  test(`a completed ${source} probe stays isolated when opening every other component`, async () => {
    const f = isolatedProbeScreen(source); await f.ui.flush(); await f.open(source); await f.probe(source);
    assert.match(f.diagnostic(source), new RegExp("Результат проверки " + source));
    f.close(source);
    assert.equal(f.ui.elements.get("probeResult").hidden, true);
    assert.equal(f.ui.elements.get("probeResult").textContent, "");
    for (const target of f.ids.filter(id => id !== source)) {
      await f.open(target);
      assert.match(f.diagnostic(target), new RegExp("Собственная диагностика " + target));
      assert.doesNotMatch(f.diagnostic(target), /Результат проверки/);
      await f.ui.context.refresh();
      assert.match(f.diagnostic(target), new RegExp("Собственная диагностика " + target));
      f.close(target);
    }
    await f.open(source); assert.match(f.diagnostic(source), new RegExp("Результат проверки " + source));
    assert.equal(f.ui.calls.filter(call => call.params?.name === "settings.probe_connections").length, 1);
  });

  for (const failed of [false, true]) test(`a late ${failed ? "failed" : "completed"} ${source} probe cannot overwrite another component dialog`, async () => {
    const f = isolatedProbeScreen(source, { delayed: true, failed }), target = source === "v8std" ? "edt" : "v8std";
    await f.ui.flush(); await f.open(source); const checking = f.probe(source); await f.ui.flush();
    f.close(source); await f.open(target); f.finish(); await checking;
    assert.match(f.diagnostic(target), new RegExp("Собственная диагностика " + target));
    assert.doesNotMatch(f.ui.elements.get("componentDialogStatus").textContent, new RegExp("Ошибка проверки " + source));
    f.close(target); await f.open(source);
    assert.match(f.diagnostic(source), new RegExp((failed ? "Ошибка проверки " : "Результат проверки ") + source));
    assert.equal(f.ui.calls.filter(call => call.params?.name === "settings.probe_connections").length, 1);
  });

  test(`a late ${source} probe request error stays in its component`, async () => {
    const f = isolatedProbeScreen(source, { startFailed: true }), target = source === "v8std" ? "edt" : "v8std";
    await f.ui.flush(); await f.open(source); const checking = f.probe(source); await f.ui.flush();
    f.close(source); await f.open(target); f.finish(); await checking;
    assert.match(f.diagnostic(target), new RegExp("Собственная диагностика " + target));
    assert.doesNotMatch(f.ui.elements.get("componentDialogStatus").textContent, new RegExp("Ошибка проверки " + source));
    f.close(target); await f.open(source);
    assert.match(f.diagnostic(source), new RegExp("Ошибка проверки " + source));
  });
}

for (const [source, target, dialog, component, controls, body] of [
  ["edt", "v8std", "componentDialog", "dialogComponent", "connectionSettings", "componentDialogBody"],
  ["code-index", "bsl-ls", "managedDialog", "managedComponent", "managedControls", "managedDialogBody"],
  ["yaxunit", "vanessa", "testingDialog", "testingComponent", "editorControls", "testingDialogBody"],
]) test(`a queued ${source} dialog close cannot clear the newly opened ${target} dialog`, async () => {
  const f = isolatedProbeScreen(source, { deferredClose: true }); await f.ui.flush();
  await f.open(source); f.close(source); await f.open(target); f.ui.flushCloseEvents();
  assert.equal(f.ui.elements.get(dialog).open, true);
  assert.equal(vm.runInContext(component, f.ui.context), target);
  assert.equal(f.ui.elements.get(controls).parentElement, f.ui.elements.get(body));
  assert.match(f.diagnostic(target), new RegExp("Собственная диагностика " + target));
});

test("an addressed result cannot update unrelated component observations", async () => {
  const f = isolatedProbeScreen("edt"); await f.ui.flush();
  f.ui.context.observeComponentResult({ componentChecks: [{ id: "edt", state: "ready", detail: "Результат проверки edt" },
    { id: "v8std", state: "error", detail: "Чужая диагностика edt" }] },
  { action: "probe", component: "edt", projectRoot: read.values.projectRoot, instance: "default" });
  await f.open("v8std");
  assert.equal(f.diagnostic("v8std"), "Собственная диагностика v8std");
  assert.equal(vm.runInContext('componentObservations.has("v8std")', f.ui.context), false);
});

for (const startFailed of [false, true]) test(`a late probe ${startFailed ? "request" : "operation"} error retains its original settings revision`, async () => {
  const f = isolatedProbeScreen("edt", { delayed: true, failed: true, startFailed }); await f.ui.flush(); await f.open("edt");
  const checking = f.probe("edt"); await f.ui.flush();
  f.current.settingsRevision = "changed"; f.ui.context.renderCurrent(f.current, { preserveDraft: true });
  f.finish(); await checking;
  assert.equal(f.item("edt").state, "check_stale");
  assert.equal(f.ui.elements.get("componentDialogDiagnostic").textContent, "Проверка устарела");
});

test("saving validates the current draft even after an optional preview", async () => {
  const text = "project: {}\n", edited = "project: {id: edited}\n";
  const ui = screen(async (name, args) => {
    if(name === "settings.read") return read;
    if(name === "settings.edit") return { text, format: "yaml", layerScope: "profile", baseRevision: "loaded" };
    if(name === "settings.preview") { assert.equal(args.mode, "layer"); assert.equal(args.baseRevision, "loaded"); return { revision: "reviewed", projectRoot: read.values.projectRoot, repositories: [], openviking: { enabled: true, url: "https://knowledge.example/mcp", timeout_seconds: 4, max_response_bytes: 4096 } }; }
    if(name === "settings.apply") { assert.equal(args.text, edited); assert.equal(args.revision, "reviewed"); assert.equal(args.mode, "layer"); assert.equal(args.baseRevision, "loaded"); assert.equal(args.replace, true); return {}; }
    throw new Error(name);
  });
  await ui.flush();
  await ui.elements.get("editSettingsButton").onclick();
  assert.equal(ui.elements.get("settingsText").value, text);
  await ui.elements.get("reviewEditButton").onclick();
  assert.equal(ui.elements.get("preview").hidden, false);
  assert.equal(ui.elements.get("openvikingStatus").textContent, "Включён: https://knowledge.example/mcp · 4 с · 4096 байт");
  ui.elements.get("settingsText").value = edited; ui.elements.get("settingsText").events.input();
  assert.equal(ui.elements.get("preview").hidden, true);
  assert.equal(ui.elements.get("applyButton").disabled, false);
  await ui.elements.get("applyButton").onclick();
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.preview").length, 2);
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.apply").length, 1);
  assert.equal(ui.elements.get("settingsText").value, text);
});

test("the chat directory is filled on opening and can be opened without changing its binding", async () => {
  const ui = screen(async name => {
    if (name === "settings.read") return read;
    if (name === "settings.open_directory") return { opened: true };
    throw new Error(name);
  });
  await ui.flush();
  assert.equal(ui.elements.get("projectRoot").value, read.values.projectRoot);
  assert.equal(ui.elements.get("pickDirectoryButton").hidden, true);
  assert.equal(ui.elements.get("openDirectoryButton").hidden, false);
  await ui.elements.get("openDirectoryButton").onclick();
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.open_directory").length, 1);
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.update").length, 0);
});

test("picking a directory refreshes the profile and invalidates an earlier import preview", async () => {
  let selected = false;
  const ui = screen(async (name, args) => {
    if (name === "settings.read") return selected ? { ...read, schema: {}, profile: { status: "missing" } } : { values: { projectRoot: "" }, schema: {}, profile: { status: "unselected" } };
    if (name === "settings.select_profile") return { ...read, schema: {}, profile: { status: "missing" } };
    if (name === "settings.pick_directory") { assert.equal(args.projectRoot, ""); return { id: "picker", status: "running" }; }
    if (name === "settings.operation") { selected = true; return { id: "picker", status: "completed", action: "pick_directory", result: read }; }
    throw new Error(name);
  });
  await ui.flush();
  assert.equal(ui.elements.get("pickDirectoryButton").hidden, false);
  assert.equal(ui.elements.get("openDirectoryButton").hidden, true);
  ui.elements.get("preview").hidden = false;
  await ui.elements.get("pickDirectoryButton").onclick();
  assert.equal(ui.elements.get("projectRoot").value, read.values.projectRoot);
  assert.equal(ui.elements.get("preview").hidden, true);
  assert.equal(ui.elements.get("createButton").hidden, false);
  assert.equal(ui.elements.get("saveButton").disabled, true); // profile must exist before editing
});

test("cancelling the directory picker preserves the draft and reviewed import", async () => {
  const ui = screen(async name => {
    if (name === "settings.read") return { ...read, schema: {} };
    if (name === "settings.pick_directory") return { id: "picker", status: "running" };
    if (name === "settings.operation") return { id: "picker", status: "completed", action: "pick_directory", result: { cancelled: true } };
    throw new Error(name);
  });
  await ui.flush();
  ui.elements.get("projectRoot").value = "C:/draft";
  ui.elements.get("preview").hidden = false;
  await ui.elements.get("pickDirectoryButton").onclick();
  assert.equal(ui.elements.get("projectRoot").value, "C:/draft");
  assert.equal(ui.elements.get("preview").hidden, false);
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.read").length, 1);
});

for (const delayed of [false, true]) test(`picking another project replaces the old app scope after ${delayed ? "delayed" : "immediate"} completion`, async () => {
  const nextRoot = "C:/fixture/another", next = { ...read, schema: {}, values: { projectRoot: nextRoot },
    profile: { status: "missing" }, profileHistory: [{ projectRoot: nextRoot, status: "missing" }] };
  let selectedRoot = read.values.projectRoot, polls = 0;
  const ui = screen(async (name, args, meta) => {
    if (name === "settings.operation") {
      if (delayed && ++polls === 1) return { id: "another-picker", action: "pick_directory", status: "running" };
      selectedRoot = nextRoot;
      return { id: "another-picker", action: "pick_directory", status: "completed", result: next };
    }
    if (meta?.["1c-ai-core/projectRoot"] && meta["1c-ai-core/projectRoot"] !== selectedRoot)
      throw new Error("Каталог закреплён этой MCP-сессией.");
    if (name === "settings.read" || name === "settings.status") return selectedRoot === nextRoot ? next : { ...read, schema: {} };
    if (name === "settings.pick_directory") {
      assert.equal(args.projectRoot, read.values.projectRoot);
      return { id: "another-picker", action: "pick_directory", status: "running" };
    }
    if (name === "settings.select_profile") { assert.equal(args.projectRoot, nextRoot); return next; }
    throw new Error(name);
  }, { narrow: true });
  await ui.flush();ui.elements.get("profileToggleButton").onclick();
  await ui.elements.get("addProfileButton").onclick();
  assert.equal(ui.elements.get("directoryChooser").open,true);
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.pick_directory").length,0);
  await ui.elements.get("pickDirectoryButton").onclick();
  if (delayed) {
    assert.equal(ui.elements.get("pickDirectoryButton").disabled, true);
    await ui.tick();
  }
  assert.equal(ui.elements.get("projectRoot").value, nextRoot);
  assert.equal(ui.elements.get("profilePath").textContent, nextRoot);
  assert.equal(ui.elements.get("createButton").hidden, false);
  assert.equal(ui.elements.get("createButton").disabled, false);
  assert.equal(ui.elements.get("profileBrowser").hidden, true);
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.pick_directory").length, 1);
  await ui.context.refreshStatus();
  assert.equal(ui.elements.get("projectRoot").value, nextRoot);
  assert.doesNotMatch(ui.elements.get("headerRefresh").title, /Нет свежих данных/);
  assert.equal(ui.calls.filter(call => ["settings.create", "settings.run_check"].includes(call.params?.name)).length, 0);
});

test("a late observation of the previous profile cannot replace the completed folder selection", async () => {
  const nextRoot = "C:/fixture/another", next = { ...read, schema: {}, values: { projectRoot: nextRoot } };
  let polls = 0, releaseStatus;
  const ui = screen(async name => {
    if (name === "settings.read") return { ...read, schema: {} };
    if (name === "settings.status") return new Promise(resolve => { releaseStatus = resolve; });
    if (name === "settings.pick_directory") return { id: "picker", status: "running" };
    if (name === "settings.operation") return ++polls === 1
      ? { id: "picker", action: "pick_directory", status: "running" }
      : { id: "picker", action: "pick_directory", status: "completed", result: next };
    if (name === "settings.select_profile") return next;
    throw new Error(name);
  });
  await ui.flush();await ui.elements.get("pickDirectoryButton").onclick();
  const observing=ui.context.refreshStatus();await ui.flush();assert.equal(typeof releaseStatus, "function");
  await ui.tick();assert.equal(ui.elements.get("profilePath").textContent, nextRoot);
  releaseStatus({ ...read, schema: {} });await observing;await ui.flush();
  assert.equal(ui.elements.get("profilePath").textContent, nextRoot);
  assert.equal(ui.elements.get("projectRoot").value, nextRoot);
});

test("selecting the current folder replaces a manually typed directory draft", async () => {
  const ui = screen(async name => {
    if (name === "settings.read" || name === "settings.select_profile") return { ...read, schema: {} };
    if (name === "settings.pick_directory") return { id: "same-picker", status: "running" };
    if (name === "settings.operation") return { id: "same-picker", status: "completed", action: "pick_directory", result: read };
    throw new Error(name);
  });
  await ui.flush();ui.elements.get("projectRoot").value = "C:/draft";ui.elements.get("projectRoot").events.input();
  await ui.elements.get("pickDirectoryButton").onclick();
  assert.equal(ui.elements.get("projectRoot").value, read.values.projectRoot);
  assert.equal(ui.elements.get("unsavedHint").hidden, true);
  assert.equal(ui.elements.get("saveButton").disabled, true);
});

for (const failsToStart of [false, true]) test(`a picker ${failsToStart ? "startup" : "operation"} error keeps the current project and allows retry`, async () => {
  const ui = screen(async name => {
    if (name === "settings.read") return { ...read, schema: {} };
    if (name === "settings.pick_directory") {
      if (failsToStart) throw new Error("Не удалось открыть окно выбора папки.");
      return { id: "failed-picker", status: "running" };
    }
    if (name === "settings.operation") return { id: "failed-picker", action: "pick_directory", status: "failed", error: "Не удалось открыть окно выбора папки." };
    throw new Error(name);
  });
  await ui.flush();ui.elements.get("projectRoot").value = "C:/draft";ui.elements.get("projectRoot").events.input();
  await ui.elements.get("pickDirectoryButton").onclick();
  assert.match(ui.elements.get("status").textContent, /Не удалось открыть окно выбора папки/);
  assert.equal(ui.elements.get("projectRoot").value, "C:/draft");
  assert.equal(ui.elements.get("profilePath").textContent, read.values.projectRoot);
  assert.equal(ui.elements.get("pickDirectoryButton").disabled, false);
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.select_profile").length, 0);
});

test("a locked project remains locked and preparation polling does not restart it", async () => {
  let polls = 0;
  const ui = screen(async name => {
    if (name === "settings.read") return {...read,instance:"A"};
    if (name === "settings.run_check") return { id: "one", status: "running" };
    if (name === "settings.operation") return ++polls === 1
      ? { id: "one", action: "check", projectRoot: "C:/fixture/project", instance: "A", status: "running" }
      : { id: "one", action: "check", projectRoot: "C:/fixture/project", instance: "A", status: "completed", result: {
        managed: [{ name: "code-index", ready: false, state: "indexing" }, { name: "bsl-ls", ready: true }, { name: "policy", ready: true }], external: {} } };
    throw new Error(name);
  });
  await ui.flush();
  assert.equal(ui.elements.get("pickDirectoryButton").hidden, true);
  await ui.elements.get("readinessButton").onclick();
  assert.equal(ui.elements.get("readinessButton").disabled, true);
  await ui.tick();
  assert.equal(ui.elements.get("readinessButton").disabled, false);
  const preparations = ui.calls.filter(call => call.params?.name === "settings.run_check");
  assert.equal(preparations.length, 1);
  assert.equal(JSON.stringify(preparations[0].params.arguments.authorization), JSON.stringify({
    scope: "C:/fixture/project#default", effects: ["launch"],
    evidence: "Пользователь нажал «Подготовить и проверить» в экране настроек."
  }));
  assert.equal([...ui.timers.values()].filter(timer => timer.ms === 1000 || timer.ms === 5000).length, 0);
  assert.match(ui.elements.get("status").textContent, /затем проверьте готовность/);
  const contents = element => [element.textContent, ...element.children.map(contents)].join(" ");
  const lines = contents(ui.elements.get("connections"));
  assert.match(lines, /Совместимость API BSL LS подтверждена последней проверкой/);
  assert.match(lines, /тестовых данных/);
});

test("an edited import cannot acquire the previous preview result", async () => {
  let release;
  const ui = screen(async name => {
    if (name === "settings.read") return read;
    if (name === "settings.pick_import_file") return { id: "pick", status: "running" };
    if (name === "settings.operation") return { id: "pick", status: "completed", action: "pick_import_file", projectRoot: read.values.projectRoot, result: { fileId: "file" } };
    if (name === "settings.import_file") return { scope: "profile", filename: "project.yaml", text: "{}" };
    if (name === "settings.transfer_context") return { baseRevision: "base" };
    if (name === "settings.transfer_preview") return new Promise(resolve => { release = resolve; });
    throw new Error(name);
  });
  await ui.flush();
  ui.elements.get("transferPath").value = "C:/profile.yaml"; await ui.elements.get("transferPick").onclick();
  const pending = ui.elements.get("transferPreview").onclick();
  await ui.flush();
  ui.elements.get("transferScope").value = "project_local"; ui.elements.get("transferScope").events.change();
  release({ revision: "old", files: [] });
  await pending;
  assert.equal(ui.elements.get("transferApply").disabled, true);
  assert.match(ui.elements.get("status").textContent, /изменились/);
});

test("a late operation notification opens and refreshes its result", async () => {
  const ui = screen(async name => {
    if (name === "settings.read") return read;
    if (name === "settings.operation") return { id: "finished", action: "update", projectRoot: "C:/fixture/project", status: "completed" };
    throw new Error(name);
  });
  await ui.flush();
  ui.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { mode: "operation", id: "finished" } } });
  await ui.flush();
  assert.equal(ui.elements.get("checkPanel").hidden, false);
  assert.match(ui.elements.get("status").textContent, /Подключения сохранены/);
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.read").length, 2);
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.operation").length, 1);
});

test("preparation uses the current backend scope after a host directory change", async () => {
  let reads = 0;
  const ui = screen(async name => {
    if (name === "settings.read") return ++reads === 1 ? read : { ...read, preparationScope: "C:/other#second" };
    if (name === "settings.run_check") return { id: "new", status: "running" };
    if (name === "settings.operation") return { id: "new", status: "running" };
    throw new Error(name);
  });
  await ui.flush();
  await ui.elements.get("readinessButton").onclick();
  const preparation = ui.calls.find(call => call.params?.name === "settings.run_check");
  assert.equal(preparation.params.arguments.authorization.scope, "C:/other#second");
});

test("profile creation reports restart guidance without preparing services", async () => {
  let created = false;
  const ui = screen(async name => {
    if (name === "settings.read") return { ...read, profile: { status: created ? "loaded" : "missing", profileId: "generic-1c", repositories: [] } };
    if (name === "settings.create") { created = true; return { sessionGuidance: "Откройте новый чат при необходимости." }; }
    throw new Error(name);
  });
  await ui.flush();
  assert.equal(ui.elements.get("profilePanel").hidden, false);
  assert.equal(ui.elements.get("createButton").hidden, false);
  await ui.elements.get("createButton").onclick();
  assert.equal(ui.elements.get("createButton").hidden, true);
  assert.equal(ui.elements.get("headerRefresh").disabled, false);
  assert.match(ui.elements.get("status").textContent, /новый чат/);
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.run_check").length, 0);
  assert.match(ui.elements.get("status").textContent, /дополнить правила команды/);
});

test("profile creation explains starter and preserved instructions and override precedence", async () => {
  for (const instructions of [
    { created: [".ai/PROJECT.md", "AGENTS.md"], preserved: [], contentValidated: false },
    { created: [], preserved: [".ai/PROJECT.md", "AGENTS.md"], contentValidated: false },
    { created: [".ai/PROJECT.md"], preserved: ["AGENTS.override.md", "AGENTS.md"], contentValidated: false, overrideFile: "AGENTS.override.md" },
    { created: [".ai/PROJECT.md", "AGENTS.md"], preserved: ["AGENTS.override.md"], contentValidated: false },
  ]) {
    let created = false;
    const ui = screen(async name => {
      if (name === "settings.read") return { ...read, profile: { status: created ? "loaded" : "missing", repositories: [] } };
      if (name === "settings.create") { created = true; return { projectInstructions: instructions }; }
      throw new Error(name);
    });
    await ui.flush();
    await ui.elements.get("createButton").onclick();
    const text = ui.elements.get("status").textContent;
    if (instructions.created.length) assert.ok(text.includes("Созданы стартовые инструкции: " + instructions.created.join(", ")));
    else assert.doesNotMatch(text, /Созданы стартовые инструкции/);
    if (instructions.preserved.length) assert.ok(text.includes("Сохранены без изменений: " + instructions.preserved.join(", ")));
    else assert.doesNotMatch(text, /Сохранены без изменений/);
    if (instructions.overrideFile) assert.match(text, /AGENTS.override.md имеет приоритет над AGENTS.md/);
    else assert.doesNotMatch(text, /имеет приоритет/);
    assert.match(text, /действующем файле инструкций/);
    assert.match(text, /Готовность сервисов не подтверждает полноту/);
    assert.doesNotMatch(text, /contentValidated|projectInstructions/);
    assert.equal(ui.calls.filter(call => ["settings.run_check", "settings.probe_connections"].includes(call.params?.name)).length, 0);
  }
});

test("the readiness summary checks once and retains a scoped result across refresh", async () => {
  let completed=false;
  const readiness={state:"ready",checkedAt:"2026-10-22T12:00:00Z",checks:[{id:"edt",label:"EDT",state:"ready"},{id:"v8std",label:"v8std",state:"ready"},{id:"policy",label:"Политика",state:"ready"},{id:"skills",label:"Навыки",state:"ready"}]};
  const ui=screen(async(name,args)=>{
    if(name==="settings.read")return {...read,values:{...read.values,edtUrl:"http://edt",v8stdUrl:"http://v8std"},readiness:completed?readiness:{state:"not_checked"}};
    if(name==="settings.run_check"){assert.equal(args.authorization.scope,read.preparationScope);return {id:"ready-check",status:"running"};}
    if(name==="settings.operation"){completed=true;return {id:"ready-check",status:"completed",action:"check",result:{managed:[],external:{},readiness}};}
    throw new Error(name);
  });await ui.flush();assert.match(ui.elements.get("readinessTitle").textContent,/не выполнялась/);
  await ui.elements.get("readinessButton").onclick();
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.run_check").length,1);
  assert.match(ui.elements.get("readinessTitle").textContent,/можно начинать работу/);
  assert.equal(ui.elements.get("readinessItems").children.length,4);
  ui.elements.get("edtUrl").value="http://localhost:2222/mcp";ui.elements.get("edtUrl").events.input();
  assert.match(ui.elements.get("readinessTitle").textContent,/несохранённые/);
  await ui.elements.get("readinessButton").onclick();assert.equal(ui.calls.filter(call=>call.params?.name==="settings.run_check").length,1);
});

test("failed service checks name the failing component and stale indexes offer rebuilding", async () => {
  const ui=screen(async()=>read);await ui.flush();
  ui.context.renderCheck({managed:[{name:"policy",state:"error",ready:false,detail:"Policy unavailable"},{name:"code-index",state:"stale",ready:false}],external:{}},{projectRoot:read.values.projectRoot});
  const contents=node=>[node.textContent,...node.children.map(contents)].join(" ");
  const text=contents(ui.elements.get("connections"));assert.match(text,/Ошибка проверки/);assert.doesNotMatch(text,/Ошибка индекса/);
  assert.match(text,/Индекс устарел/);assert.match(text,/Пересоздайте индекс/);assert.doesNotMatch(text,/Дождитесь завершения/);
});

test("a stale readiness result cannot display ready", async () => {
  const ui=screen(async()=>({...read,values:{...read.values,edtUrl:"http://edt",v8stdUrl:"http://v8std"},readiness:{state:"stale",checkedAt:"2026-10-22T12:00:00Z",reason:"Изменился порт EDT.",checks:[{id:"edt",label:"EDT",state:"ready"}]}}));
  await ui.flush();assert.match(ui.elements.get("readinessTitle").textContent,/повторить/);assert.match(ui.elements.get("readinessDetail").textContent,/Изменился порт/);
});

test("an unchecked connection is not reported as stale or disconnected", async () => {
  const ui=screen(async()=>({...read,readiness:{state:"not_checked",checks:[{id:"edt",label:"EDT",state:"ready"}]},summary:{components:[]}}));
  await ui.flush();
  const contents=node=>[node.textContent,...node.children.map(contents)].join(" ");
  const text=contents(ui.elements.get("connections"));
  assert.match(text,/Нет данных подключения/);assert.doesNotMatch(text,/Проверка устарела|Нет подключения/);
});

for (const selectedScope of ["profile", "project_local"]) test(`EDT port suggestion switches to local settings from ${selectedScope}`, async () => {
  const suggestion={configuredPort:8765,detectedPort:19801,url:"http://localhost:19801/mcp"};
  const sharedUrl="http://localhost:8765/mcp",localPath="C:/fixture/project/.ai/project.local.yaml",updates=[];
  const current={...read,settingsRevision:"before",values:{...read.values,edtUrl:sharedUrl,bslLsEnabled:false},connectionSources:{edt:"profile"},
    layerValues:{profile:{edtUrl:sharedUrl},project_local:{}},writePaths:{profile:"C:/fixture/project/.ai/project.yaml",project_local:localPath},edtPortSuggestion:suggestion};
  const ui=screen(async(name,args)=>{
    if(name==="settings.read")return current;
    if(name==="settings.update"){
      updates.push(args);Object.assign(current.layerValues[args.scope],args.set);
      if(args.set.edtUrl){current.values.edtUrl=args.set.edtUrl;current.connectionSources.edt=args.scope;current.edtPortSuggestion=null;}
      current.settingsRevision="after";return {savedTo:current.writePaths[args.scope],settingsRevision:current.settingsRevision};
    }
    throw new Error(name);
  });await ui.flush();assert.equal(ui.elements.get("edtPortHint").hidden,false);
  const hintText=ui.elements.get("edtPortText").textContent;
  ui.elements.get("connectionScope").value=selectedScope;ui.elements.get("connectionScope").events.change();
  ui.elements.get("componentLocalButton").onclick();ui.elements.get("bslLsEnabled").checked=true;ui.elements.get("bslLsEnabled").events.change();
  await ui.elements.get("useEdtPortButton").onclick();
  assert.equal(updates.length,1);assert.equal(updates[0].scope,"project_local");assert.equal(updates[0].expectedRevision,"before");
  assert.match(hintText,/19801.*8765.*локальн/i);
  assert.equal(JSON.stringify(updates[0].set),JSON.stringify({edtUrl:suggestion.url}));
  assert.equal(current.layerValues.profile.edtUrl,sharedUrl);assert.equal(current.layerValues.project_local.edtUrl,suggestion.url);
  assert.equal(ui.elements.get("connectionScope").value,"project_local");assert.equal(ui.elements.get("edtPortHint").hidden,true);
  assert.equal(ui.elements.get("connectionLocalButton").attributes["aria-pressed"],"true");
  assert.equal(ui.elements.get("connectionSharedButton").attributes["aria-pressed"],"false");
  assert.match(ui.elements.get("connectionDestination").textContent,/project\.local\.yaml/);
  assert.equal(ui.elements.get("edtUrl").value,suggestion.url);assert.equal(ui.elements.get("bslLsEnabled").checked,true);
  assert.match(ui.elements.get("status").textContent,/Локальные настройки/);assert.match(ui.elements.get("status").textContent,/project\.local\.yaml/);
  ui.elements.get("connectionSharedButton").onclick();assert.equal(ui.elements.get("connectionScope").value,"profile");
  ui.elements.get("connectionLocalButton").onclick();assert.equal(ui.elements.get("connectionScope").value,"project_local");
  await ui.elements.get("saveComponentsButton").onclick();
  assert.equal(updates.length,2);assert.equal(updates[1].scope,"project_local");assert.equal(updates[1].expectedRevision,"after");
  assert.equal(JSON.stringify(updates[1].set),JSON.stringify({bslLsEnabled:true}));
});

test("EDT port update does not move a shared connection draft to local settings", async () => {
  const suggestion={configuredPort:8765,detectedPort:19801,url:"http://localhost:19801/mcp"};
  let updates=0;
  const current={...read,values:{...read.values,edtUrl:"http://localhost:8765/mcp"},connectionSources:{edt:"profile"},edtPortSuggestion:suggestion};
  const ui=screen(async name=>{if(name==="settings.read")return current;if(name==="settings.update"){updates++;return {};}throw new Error(name);});
  await ui.flush();assert.equal(ui.elements.get("connectionScope").value,"profile");
  ui.elements.get("v8stdUrl").value="http://localhost:9000/mcp";ui.elements.get("v8stdUrl").events.input();
  assert.equal(ui.elements.get("useEdtPortButton").disabled,true);
  assert.match(ui.elements.get("edtPortText").textContent,/Сохраните или отмените черновик/);
  await ui.elements.get("useEdtPortButton").onclick();
  assert.equal(updates,0);assert.equal(ui.elements.get("connectionScope").value,"profile");
  assert.equal(ui.elements.get("v8stdUrl").value,"http://localhost:9000/mcp");
});

test("EDT port update preserves other connection drafts already in local settings", async () => {
  const suggestion={configuredPort:8765,detectedPort:19801,url:"http://localhost:19801/mcp"},updates=[];
  let current={...read,settingsRevision:"before",values:{...read.values,edtUrl:"http://localhost:8765/mcp"},edtPortSuggestion:suggestion};
  const ui=screen(async(name,args)=>{
    if(name==="settings.read")return current;
    if(name==="settings.update"){updates.push(args);current={...current,settingsRevision:"after",edtPortSuggestion:null};return {settingsRevision:"after"};}
    throw new Error(name);
  });await ui.flush();ui.elements.get("connectionLocalButton").onclick();
  ui.elements.get("v8stdUrl").value="http://localhost:9000/mcp";ui.elements.get("v8stdUrl").events.input();
  assert.equal(ui.elements.get("useEdtPortButton").disabled,false);await ui.elements.get("useEdtPortButton").onclick();
  assert.equal(ui.elements.get("connectionScope").value,"project_local");assert.equal(ui.elements.get("v8stdUrl").value,"http://localhost:9000/mcp");
  await ui.elements.get("saveButton").onclick();assert.equal(updates.length,2);assert.equal(updates[1].scope,"project_local");
  assert.equal(updates[1].expectedRevision,"after");assert.equal(JSON.stringify(updates[1].set),JSON.stringify({v8stdUrl:"http://localhost:9000/mcp"}));
});

test("a failed EDT port update leaves the shared scope selected", async () => {
  const suggestion={configuredPort:8765,detectedPort:19801,url:"http://localhost:19801/mcp"};
  const ui=screen(async name=>{if(name==="settings.read")return {...read,edtPortSuggestion:suggestion};if(name==="settings.update")throw new Error("Настройки изменились после загрузки.");throw new Error(name);});
  await ui.flush();assert.equal(ui.elements.get("connectionScope").value,"profile");await ui.elements.get("useEdtPortButton").onclick();
  assert.equal(ui.elements.get("connectionScope").value,"profile");assert.equal(ui.elements.get("connectionSharedButton").attributes["aria-pressed"],"true");
  assert.equal(ui.elements.get("edtPortHint").hidden,false);assert.match(ui.elements.get("status").textContent,/изменились/);
});

test("a late EDT port update does not switch the scope of another project", async () => {
  const suggestion={configuredPort:8765,detectedPort:19801,url:"http://localhost:19801/mcp"};
  let current={...read,instance:"first",values:{...read.values,edtUrl:"http://localhost:8765/mcp"},connectionSources:{edt:"profile"},edtPortSuggestion:suggestion};
  let releaseUpdate,updateStarted;const started=new Promise(resolve=>{updateStarted=resolve;});
  const ui=screen(async name=>{
    if(name==="settings.read")return current;
    if(name==="settings.update"){updateStarted();await new Promise(resolve=>{releaseUpdate=resolve;});return {};}
    throw new Error(name);
  });await ui.flush();
  const saving=ui.elements.get("useEdtPortButton").onclick();await started;
  current={...read,instance:"second",values:{...read.values,projectRoot:"C:/other",edtUrl:"http://localhost:9000/mcp"},connectionSources:{edt:"profile"}};
  ui.context.renderCurrent(current,{preserveDraft:true});assert.equal(ui.elements.get("connectionScope").value,"profile");
  releaseUpdate();await saving;
  assert.equal(ui.elements.get("connectionScope").value,"profile");assert.equal(ui.elements.get("connectionSharedButton").attributes["aria-pressed"],"true");
});

test("EDT port suggestion never overwrites a draft or accepts a changed preference", async () => {
  let reads=0;
  const ui=screen(async name=>{
    if(name==="settings.read")return {...read,edtPortSuggestion:{configuredPort:8765,detectedPort:++reads===1?19801:19802,url:"http://localhost:"+(reads===1?19801:19802)+"/mcp"}};
    throw new Error(name);
  });await ui.flush();await ui.elements.get("useEdtPortButton").onclick();
  assert.match(ui.elements.get("status").textContent,/Настройки EDT изменились/);
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.update").length,0);
  ui.elements.get("edtUrl").value="http://localhost:20000/mcp";ui.elements.get("edtUrl").events.input();
  assert.equal(ui.elements.get("useEdtPortButton").disabled,true);
});

test("rebuilding an index uses the selected EDT repository and never repeats the operation", async () => {
  const ui=screen(async(name,args)=>{
    if(name==="settings.read")return {...read,profile:{...read.profile,repositories:[{id:"main",path:"src",edt_project:"Base"},{id:"ext",path:"extension",edt_project:"Extension"}]}};
    if(name==="settings.rebuild_index"){assert.equal(args.repository,"ext");assert.equal(args.authorization.scope,read.preparationScope);return {id:"rebuild",status:"running"};}
    if(name==="settings.operation")return {id:"rebuild",action:"rebuild_index",projectRoot:read.values.projectRoot,instance:read.instance,status:"completed",result:{repository:"ext",edtProject:"Extension",state:"ready"}};
    throw new Error(name);
  });await ui.flush();ui.elements.get("indexRepository").value="ext";await ui.elements.get("rebuildIndexButton").onclick();
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.rebuild_index").length,1);
  assert.match(ui.elements.get("status").textContent,/Extension.*пересоздан.*Готов/);
});

test("bulk rebuild remains observable after several minutes, a polling error and reopening the card", async () => {
  let launched = false, failPoll = false;
  const current = { ...read, instance: "default", values: { ...read.values, codeIndexEnabled: true },
    profile: { ...read.profile, repositories: [{ id: "main", path: "src", edt_project: "Main" }, { id: "ext", path: "extension", edt_project: "Extension" }] },
    summary: { components: [{ id: "code-index", status: "running" }] } };
  const startedAt = new Date().toISOString(), job = { id: "bulk", action: "rebuild_index", component: "code-index", all: true,
    projectRoot: current.values.projectRoot, instance: current.instance, status: "running", startedAt,
    progress: { phase: "indexing", total: 2, completed: 0, edtProject: "Main" } };
  const ui = screen(async (name, args) => {
    if (name === "settings.read" || name === "settings.status") return { ...current, ...(launched ? { operation: job } : {}) };
    if (name === "settings.versions") return { versions: [] };
    if (name === "settings.rebuild_index") { assert.equal(args.all, true); assert.equal(args.repository, undefined); assert.equal(args.authorization.scope, read.preparationScope); launched = true; return job; }
    if (name === "settings.operation") { if (failPoll) { failPoll = false; throw new Error("offline"); } return job; }
    throw new Error(name);
  }); await ui.flush();
  const open = () => ui.context.openManagedDialog(ui.context.catalogItems(current).find(item => item.id === "code-index"), null);
  open(); await ui.flush(); await ui.elements.get("rebuildAllIndexesButton").onclick();
  assert.equal(ui.elements.get("indexMaintenanceProgress").hidden, false);
  assert.match(ui.elements.get("indexMaintenanceDetail").textContent, /Main.*0 из 2/);
  assert.equal(ui.elements.get("indexMaintenanceMeter").hidden, false);
  assert.equal(ui.elements.get("rebuildIndexButton").disabled, true); assert.equal(ui.elements.get("rebuildAllIndexesButton").disabled, true);
  assert.equal(ui.elements.get("managedDialogClose").disabled, false);
  vm.runInContext("Date.now=()=>" + (Date.parse(startedAt) + 7 * 60000 + 12000), ui.context);
  ui.context.renderIndexMaintenance(); assert.match(ui.elements.get("indexMaintenanceElapsed").textContent, /7 мин 12 с/);
  failPoll = true; await ui.context.pollOperation(job.id);
  assert.match(ui.elements.get("indexMaintenanceHint").textContent, /повторим проверку через 5 секунд/);
  assert.equal(ui.elements.get("indexMaintenanceMeter").hidden, false);
  job.progress = { phase: "indexing", total: 2, completed: 1, edtProject: "Extension" };
  await ui.tick(5000); assert.match(ui.elements.get("indexMaintenanceDetail").textContent, /Extension.*1 из 2/);
  await ui.elements.get("managedDialogClose").onclick();
  const card = ui.elements.get("componentCatalog").children.flatMap(group => group.children[1].children).find(card => componentName(card) === "Code Index");
  assert.equal(componentButton(card).disabled, false); await componentButton(card).onclick(); await ui.flush();
  assert.equal(ui.elements.get("indexMaintenanceProgress").hidden, false); assert.match(ui.elements.get("indexMaintenanceElapsed").textContent, /7 мин 12 с/);
  job.progress = { phase: "checking", total: 2, completed: 2 }; await ui.context.pollOperation(job.id);
  assert.match(ui.elements.get("indexMaintenanceDetail").textContent, /Проверяем.*2 из 2/);
  job.status = "completed"; job.completedAt = new Date(Date.parse(startedAt) + 8 * 60000).toISOString(); job.result = { all: true, state: "ready", rebuilt: [{ repository: "main" }, { repository: "ext" }] };
  await ui.context.pollOperation(job.id); await ui.flush();
  assert.match(ui.elements.get("indexMaintenanceTitle").textContent, /завершено/); assert.equal(ui.elements.get("indexMaintenanceMeter").hidden, true);
  assert.match(ui.elements.get("indexMaintenanceDetail").textContent, /2 из 2.*готов/);
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.rebuild_index").length, 1);
});

test("failed index maintenance shows partial progress and never shows another instance's operation", async () => {
  const current = { ...read, instance: "default", values: { ...read.values, codeIndexEnabled: true }, summary: { components: [{ id: "code-index", status: "running" }] } };
  const job = { id: "failed-index", action: "rebuild_index", component: "code-index", all: true, projectRoot: current.values.projectRoot, instance: current.instance,
    status: "failed", startedAt: new Date().toISOString(), error: "Не удалось пересоздать индекс.", progress: { phase: "restoring", total: 3, completed: 1, edtProject: "Extension" } };
  const ui = screen(async name => { if (name === "settings.operation") return job; if (name === "settings.versions") return { versions: [] }; return current; });
  await ui.flush(); ui.context.openManagedDialog(ui.context.catalogItems(current).find(item => item.id === "code-index"), null); await ui.flush();
  await ui.context.pollOperation(job.id);
  assert.match(ui.elements.get("indexMaintenanceTitle").textContent, /ошибка/);
  assert.match(ui.elements.get("indexMaintenanceDetail").textContent, /1 из 3.*Extension.*Не удалось/);
  assert.equal(ui.elements.get("indexMaintenanceMeter").hidden, true);
  current.instance = "another"; await ui.context.refresh();
  assert.equal(ui.elements.get("indexMaintenanceProgress").hidden, true);
  assert.doesNotMatch(ui.elements.get("managedDialogNotice").textContent, /Extension/);
});

test("index UI excludes feature-only repositories and applies mappings without rebuilding", async () => {
  const ui=screen(async(name,args)=>{
    if(name==="settings.read")return {...read,profile:{...read.profile,indexRepositories:["core"],repositories:[{id:"ui",path:"ui"},{id:"core",path:"framework",edt_project:"Core"}]}};
    if(name==="settings.restart_index"){assert.equal(args.authorization.scope,read.preparationScope);return {id:"restart",status:"running"};}
    if(name==="settings.operation")return {id:"restart",action:"restart_index",projectRoot:read.values.projectRoot,instance:read.instance,status:"completed",result:{state:"ready"}};
    throw new Error(name);
  });await ui.flush();
  assert.deepEqual(ui.elements.get("indexRepository").children.map(item=>item.value),["core"]);
  await ui.elements.get("restartIndexButton").onclick();
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.restart_index").length,1);
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.rebuild_index").length,0);
  assert.match(ui.elements.get("status").textContent,/Состав проектов индекса применён/);
});

test("index maintenance keeps its selection while per-project diagnostics refresh without a duplicate service block", async () => {
  let stale = false;
  const ui = screen(async name => {
    if(name==="settings.versions")return {versions:[]};
    assert.ok(["settings.read", "settings.status"].includes(name));
    return { ...read, profile: { ...read.profile, repositories: [{ id: "main", path: "src" }, { id: "ext", path: "ext" }] },
      values: { ...read.values, edtUrl: "http://localhost/mcp" },
      readiness: { state: "ready", checkedAt: new Date().toISOString(), checks: [{ id: "edt", state: "ready" },
        { id: "code-index", state: stale ? "stale" : "ready", repositories: [{ id: "main", edtProject: "Main", state: "ready" }, { id: "ext", edtProject: "Extension", state: stale ? "stale" : "ready", present: true }] }] },
      summary: { components: [{ id: "code-index", status: stale ? "stale" : "ready" }, { id: "bsl-ls", status: "ready" }] } };
  });
  await ui.flush();
  ui.context.openManagedDialog(ui.context.catalogItems(vm.runInContext("currentData",ui.context)).find(item=>item.id==="code-index"),null);
  const box = ui.elements.get("connections"), projects = ui.elements.get("managedProjectStates");
  assert.equal(box.hidden, true); assert.equal(projects.hidden, false);
  assert.deepEqual(projects.children.map(row=>row.textContent), ["Main: готов", "Extension: готов · индекс на диске найден"]);
  assert.ok(ui.elements.get("managedControls").contains(ui.elements.get("indexActions")));
  const select = ui.elements.get("indexRepository"); ui.elements.get("indexActions").append(select);
  ui.elements.get("managedDiagnostics").open = true; select.value = "ext"; const option = select.children[0]; select.focus();
  stale = true; await ui.context.refreshStatus();
  assert.equal(box.hidden, true); assert.equal(ui.elements.get("managedDiagnostics").open, true);
  assert.deepEqual(projects.children.map(row=>row.textContent), ["Main: готов", "Extension: устарел · индекс на диске найден"]);
  assert.match(ui.elements.get("managedDialogStatus").textContent, /Обслуживание индекса/);
  assert.equal(select.value, "ext"); assert.equal(select.children[0], option); assert.equal(ui.document.activeElement, select);
  stale = false; await ui.context.refreshStatus();
  assert.deepEqual(projects.children.map(row=>row.textContent), ["Main: готов", "Extension: готов · индекс на диске найден"]);
  assert.equal(ui.document.activeElement, select);
});

test("index maintenance explains when an external or disabled component cannot be managed", async () => {
  let enabled = true, state = "ready";
  const ui = screen(async name => {
    assert.ok(["settings.read", "settings.status"].includes(name));
    return { ...read, profile: { ...read.profile, repositories: [{ id: "main", path: "src" }] },
      values: { ...read.values, codeIndexEnabled: enabled },
      summary: { components: [{ id: "code-index", mode: "external", status: enabled ? state : "disabled" }] } };
  });
  await ui.flush();
  assert.equal(ui.elements.get("rebuildIndexButton").disabled, true);
  assert.equal(ui.elements.get("rebuildAllIndexesButton").disabled, true);
  assert.equal(ui.elements.get("restartIndexButton").disabled, true);
  assert.match(ui.elements.get("indexActionsHint").textContent, /Внешний code-index/);
  state = "stale"; await ui.context.refreshStatus();
  assert.match(ui.elements.get("connections").children[0].textNode.textContent, /средствами внешнего сервиса/);
  enabled = false; await ui.context.refreshStatus();
  assert.match(ui.elements.get("indexActionsHint").textContent, /Компонент отключён/);
  assert.match(ui.elements.get("connections").children[0].textNode.textContent, /отключён/);
});

test("connection checks use unsaved fields without saving and preserve drafts", async () => {
  let checked;
  const ui=screen(async(name,args)=>{
    if(name==="settings.read")return {...read,values:{...read.values,edtUrl:"http://localhost:4000/mcp",v8stdUrl:"http://localhost:8000/mcp"}};
    if(name==="settings.probe_connections"){checked=args.connections;return {id:"draft-probe",status:"running"};}
    if(name==="settings.operation")return {projectRoot:read.values.projectRoot,instance:read.instance,id:"draft-probe",status:"completed",action:"probe",result:{external:{edt:{configured:true,connected:true},v8std:{configured:false,connected:false}}}};
    throw new Error(name);
  });await ui.flush();
  ui.context.openConnectionDialog({id:"edt",name:"edt"},null);
  ui.elements.get("edtUrl").value="http://localhost:4001/mcp";ui.elements.get("edtUrl").events.input();
  ui.elements.get("v8stdUrl").value="";ui.elements.get("v8stdUrl").events.input();
  await ui.elements.get("probeButton").onclick();
  assert.equal(JSON.stringify(checked),JSON.stringify({edt:"http://localhost:4001/mcp"}));
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.update").length,0);
  assert.equal(ui.elements.get("edtUrl").value,"http://localhost:4001/mcp");
  assert.equal(ui.elements.get("unsavedHint").hidden,false);
});

test("a long OpenViking draft probe is polled by ID and preserves transport and editor drafts", async () => {
  const current = { ...read, values: { ...read.values, openvikingEnabled: true, openvikingUrl: "https://saved.example/mcp" } };
  let finished = false, checked;
  const ui = screen(async (name, args) => {
    if (["settings.read", "settings.status"].includes(name)) return current;
    if (name === "settings.probe_connections") { checked = args.connections.openviking; return { id: "knowledge-probe", status: "running" }; }
    if (name === "settings.operation") {
      assert.equal(args.operationId, "knowledge-probe"); assert.equal(args.waitMs, 1000);
      return { projectRoot: read.values.projectRoot, instance: read.instance, id: "knowledge-probe", action: "probe", status: finished ? "completed" : "running",
        ...(finished ? { result: { external: { openviking: { configured: true, connected: true, ready: false, detail: "publication missing" } } } } : {}) };
    }
    throw new Error(name);
  }); await ui.flush();
  ui.context.openConnectionDialog({id:"openviking",name:"openviking"},null);
  const field = ui.elements.get("openvikingUrl"); field.value = "https://draft.example/mcp"; field.events.input();
  ui.elements.get("settingsText").value = "draft document"; ui.elements.get("settingsText").events.input();
  await ui.elements.get("probeButton").onclick(); await ui.tick(1000);
  finished = true; await ui.tick(1000);
  assert.equal(checked.url, "https://draft.example/mcp");
  assert.equal(field.value, "https://draft.example/mcp");
  assert.equal(ui.elements.get("settingsText").value, "draft document");
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.probe_connections").length, 1);
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.update").length, 0);
  assert.match(ui.elements.get("probeResult").textContent, /Не найдено подтверждение публикации/);
});

for (const changed of ["root", "instance"]) test(`late probe from another ${changed} never appears in the current profile`, async () => {
  const first = { ...read, instance: "first" }; let finish;
  const ui = screen(async name => {
    if (["settings.read", "settings.status"].includes(name)) return first;
    if (name === "settings.probe_connections") return { id: "old-probe", status: "running" };
    if (name === "settings.operation") {
      await new Promise(resolve => { finish = resolve; });
      return { id: "old-probe", projectRoot: first.values.projectRoot, instance: "first", action: "probe", status: "completed",
        result: { external: { openviking: { configured: true, connected: true, detail: "old server" } } } };
    }
    throw new Error(name);
  }); await ui.flush();
  ui.context.openConnectionDialog({id:"edt",name:"edt"},null);
  const checking = ui.elements.get("probeButton").onclick(); await ui.flush();
  ui.context.renderCurrent({ ...first, ...(changed === "root" ? { values: { projectRoot: "C:/other" } } : { instance: "second" }) });
  finish(); await checking;
  assert.equal(ui.elements.get("probeResult").hidden, true);
  assert.match(ui.elements.get("status").textContent, /другого каталога или экземпляра/);
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.probe_connections").length, 1);
});

test("editing connections saves only writable changes for the bound project", async () => {
  let written;
  const ui = screen(async (name, args) => {
    if (name === "settings.read") return { ...read, values: { ...read.values, edtUrl: "http://localhost:4000/mcp", v8stdUrl: "http://localhost:8000/mcp" },
      schema: { properties: { projectRoot: { readOnly: true }, edtUrl: { readOnly: true } } } };
    if (name === "settings.update") { written = args.set; return {}; }
    throw new Error(name);
  });
  await ui.flush();
  assert.equal(ui.elements.get("edtUrl").readOnly, true);
  ui.elements.get("edtUrl").value = "ignored";
  ui.elements.get("v8stdUrl").value = "http://localhost:8001/mcp";
  ui.elements.get("v8stdUrl").events.input();
  await ui.elements.get("saveButton").onclick();
  assert.equal(JSON.stringify(written), JSON.stringify({ v8stdUrl: "http://localhost:8001/mcp" }));
});

test("resizing measures content independently from the iframe viewport", async () => {
  const ui = screen(async () => read);await ui.flush();
  const sizes = () => ui.calls.filter(call => call.method === "ui/notifications/size-changed");
  await ui.tick(50);
  assert.equal(sizes().at(-1).params.height, 540);
  const count = sizes().length;ui.resize();ui.resize();await ui.tick(50);
  assert.equal(sizes().length, count); // no self-sustaining iframe resize loop
});

test("reopening settings resumes the pending picker and enables preparation only after it closes", async () => {
  let selected = false;
  const picker = { id: "picker", action: "pick_directory", status: "running", instance: "default" };
  const ui = screen(async name => {
    if (name === "settings.read") return selected
      ? { ...read, profile: { status: "loaded", profileId: "selected-profile" }, operation: { ...picker, status: "completed" } }
      : { ...read, operation: picker };
    if (name === "settings.select_profile") return { ...read, profile: { status: "loaded", profileId: "selected-profile" }, operation: { ...picker, status: "completed" } };
    if (name === "settings.operation") return selected ? { ...picker, status: "completed", result: read } : picker;
    throw new Error(name);
  });
  await ui.flush();
  assert.equal(ui.elements.get("readinessButton").disabled, true);
  assert.equal(ui.elements.get("pickDirectoryButton").disabled, true);
  assert.equal(ui.elements.has("operationButton"), false);
  assert.match(ui.elements.get("status").textContent, /системный выбор папки/);
  selected = true;
  await ui.tick();
  assert.equal(ui.elements.get("profileTitle").textContent, "selected-profile");
  assert.equal(ui.elements.get("headerRefresh").disabled, false);
  assert.equal(ui.elements.get("readinessButton").disabled, false);
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.run_check").length, 0);
  assert.equal([...ui.timers.values()].filter(timer => timer.ms === 1000).length, 0);
});

test("preparation observes a picker started by another settings view without launching services", async () => {
  let reads = 0;
  const picker = { id: "other-view", action: "pick_directory", status: "running" };
  const ui = screen(async name => {
    if (name === "settings.read") return ++reads === 1 ? read : { ...read, operation: picker };
    if (name === "settings.operation") return picker;
    throw new Error(name);
  });
  await ui.flush();
  await ui.elements.get("readinessButton").onclick();
  assert.equal(ui.elements.get("readinessButton").disabled, true);
  assert.match(ui.elements.get("status").textContent, /Выберите папку или нажмите «Отмена»/);
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.run_check").length, 0);
});

test("opening an operation result refreshes its completed load without repeating the action", async () => {
  let reads = 0;
  const ui = screen(async (name, args) => {
    if (name === "settings.read") return { ...read, profile: { status: "loaded", profileId: ++reads === 1 ? "old" : "reloaded" }, operation: { id: "previous", action: "update", status: "completed" } };
    if (name === "settings.operation") {
      assert.equal(JSON.stringify(args), '{"operationId":"latest","waitMs":1000}');
      return { id: "latest", action: "load", status: "completed", result: { sessionGuidance: "Профиль доступен в новом чате." } };
    }
    throw new Error(name);
  });
  await ui.flush();
  ui.deliver({jsonrpc:"2.0",method:"ui/notifications/tool-result",params:{structuredContent:{mode:"operation",id:"latest",navigation:"profiles"}}});await ui.flush();
  assert.equal(ui.elements.get("profileTitle").textContent, "reloaded");
  assert.match(ui.elements.get("status").textContent, /Профиль загружен.*новом чате/);
  assert.doesNotMatch(ui.elements.get("status").textContent, /Обновите настройки/);
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.load").length, 0);
});

test("echoed load and operation results do not navigate, refresh recursively or multiply polling", async () => {
  const operation = { id: "loaded", action: "load", status: "completed", mode: "operation", navigation: "project", result: {} };
  const ui = screen(async name => {
    if (name === "settings.read") return { ...read, profile: { status: "loaded", profileId: "one" } };
    if (name === "settings.load") return { mode: "profile", sessionGuidance: "Загружено." };
    if (name === "settings.operation") return operation;
    throw new Error(name);
  }, { echo: true });
  await ui.flush();
  ui.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { mode: "profile" } } });
  await ui.context.tool("settings.load",{projectRoot:read.values.projectRoot});await ui.context.refresh();
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.read").length, 2);
  assert.equal(ui.elements.get("checkPanel").hidden, false);
  ui.elements.get("checkTab").onclick();
  await ui.context.pollOperation(operation.id);
  for (let index = 0; index < 3; index++) ui.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: operation } });
  await ui.flush();
  assert.equal(ui.elements.get("checkPanel").hidden, false);
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.load").length, 1);
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.operation").length, 1);
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.read").length, 3);
  assert.equal([...ui.timers.values()].filter(timer => timer.ms === 1000).length, 0);
});

test("fixed host height is respected and flexible height is capped without resize jitter", async () => {
  let height = 900;
  const ui = screen(async () => read, { hostContext: { containerDimensions: { height: 600 } }, height: () => height });
  await ui.flush();await ui.tick(50);
  const sizes = () => ui.calls.filter(call => call.method === "ui/notifications/size-changed");
  assert.equal(sizes().length, 0);
  ui.resize();await ui.tick(50);
  assert.equal(sizes().length, 0);
  ui.deliver({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { containerDimensions: { maxHeight: 650 } } });
  await ui.tick(50);
  assert.equal(sizes().at(-1).params.height, 650);
  const cappedCount = sizes().length;
  ui.deliver({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { containerDimensions: { maxHeight: 650 } } });
  await ui.tick(50);
  assert.equal(sizes().length, cappedCount);
  height = 500;ui.resize();await ui.tick(50);
  assert.equal(sizes().at(-1).params.height, 540);
  const count = sizes().length;
  height = 500.1;ui.resize();ui.resize();await ui.tick(50);
  assert.equal(sizes().length, count);
  height = 450;ui.resize();await ui.tick(50);
  assert.equal(sizes().at(-1).params.height, 490);
});

test("opening, selecting and reloading a profile render its service status immediately", async () => {
  let projectRoot = read.values.projectRoot, running = false;
  const snapshot = () => ({ ...read, values: { ...read.values, projectRoot }, summary: {
    observedAt: "2026-10-22T12:00:00Z",
    components: [{ id: "code-index", status: running ? "running" : "stopped" }, { id: "bsl-ls", status: "disabled" }],
  } });
  const ui = screen(async (name, args) => {
    if (name === "settings.read") return snapshot();
    if (name === "settings.select_profile") { projectRoot = args.projectRoot; running = true; return snapshot(); }
    if (name === "settings.status") { running = false; return snapshot(); }
    throw new Error(name);
  });
  await ui.flush();
  assert.equal(headerState(ui,"Code Index"),"Сервис недоступен");
  assert.equal(headerState(ui,"BSL LS"),"Отключён");
  await ui.context.selectProfile("C:/fixture/other");
  assert.equal(headerState(ui,"Code Index"),"Процесс работает");
  await ui.elements.get("headerRefresh").onclick();
  assert.equal(headerState(ui,"Code Index"),"Сервис недоступен");
  assert.match(ui.elements.get("headerRefresh").title, /Обновить состояние/);
  assert.doesNotMatch(ui.elements.get("headerRefresh").title, /автообновление/);
  assert.equal(ui.calls.filter(call => ["settings.run_check", "settings.probe_connections"].includes(call.params?.name)).length, 0);
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.status").length, 1);
});

test("opening and observing a profile keep managed status and service results consistent", async () => {
  let stale = false,projectRoot=read.values.projectRoot;
  const ui = screen(async (name,args) => {
    if(name==="settings.refresh_readiness")return {id:"observe",action:"refresh_readiness",status:"running"};
    if(name==="settings.operation")return {id:"observe",action:"refresh_readiness",projectRoot,instance:"default",status:"completed",result:{managed:[],external:{}}};
    assert.ok(["settings.read", "settings.status", "settings.select_profile"].includes(name));
    if(name==="settings.select_profile"){projectRoot=args.projectRoot;stale=false;}
    return { ...read, values: { ...read.values, projectRoot, bslLsEnabled: true }, readiness: {
      state: stale ? "stale" : "ready", checkedAt: "2026-10-22T12:00:00Z",
      checks: [{ id: "code-index", label: "Индекс кода", state: "ready", repositories: [{ edtProject: "Product", state: "ready" }] }, { id: "bsl-ls", label: "BSL LS", state: "ready" }],
    }, summary: { observedAt: "2026-10-22T12:00:00Z", components: [
      { id: "code-index", status: stale ? "stopped" : "ready", ...(!stale?{checkedAt:"2026-10-22T12:00:00Z"}:{}) },
      { id: "bsl-ls", status: stale ? "check_stale" : "ready", checkedAt: "2026-10-22T12:00:00Z" },
    ] } };
  });
  const contents = node => [node.textContent, ...node.children.map(contents)].join(" ");
  await ui.flush();
  assert.equal(headerState(ui,"Code Index"),"Готов");
  assert.equal(headerState(ui,"BSL LS"),"Совместимость API проверена");
  assert.equal(ui.elements.get("connections").hidden, false);
  assert.match(contents(ui.elements.get("connections")), /Совместимость API проверена/);
  assert.match(contents(ui.elements.get("connections")), /Product: готов/);
  const detail=ui.elements.get("connections").children[1];detail.open=true;
  await ui.context.refreshStatus();assert.equal(ui.elements.get("connections").children[1],detail);
  stale = true; await ui.context.refreshStatus();
  assert.equal(headerState(ui,"Code Index"),"Сервис недоступен");
  assert.equal(headerState(ui,"BSL LS"),"Проверка устарела");
  assert.doesNotMatch(contents(ui.elements.get("connections")), /Совместимость API проверена|Индекс актуален/);
  assert.doesNotMatch(contents(ui.elements.get("connections")), /Product: готов/);
  assert.match(contents(ui.elements.get("connections")), /Проверка устарела/);
  assert.equal(ui.elements.get("connections").children[1].open,true);
  await ui.context.selectProfile("C:/fixture/other");
  assert.equal(headerState(ui,"BSL LS"),"Совместимость API проверена");
  assert.equal(ui.elements.get("connections").children[1].open,false);
  assert.equal(ui.calls.filter(call=>["settings.run_check","settings.probe_connections"].includes(call.params?.name)).length,0);
});

test("opening, refreshing and switching projects only observe status, including stale and indexing states", async () => {
  let projectRoot = read.values.projectRoot, statusCalls = 0;
  const snapshot = () => ({ ...read, instance: "default", values: { ...read.values, projectRoot, edtUrl: "http://edt", v8stdUrl: "http://v8std" },
    preparationScope: projectRoot + "#default", readiness: { state: "stale", reason: "Истёк срок проверки", checks: [] },
    summary: { components: [{ id: "code-index", status: "indexing" }, { id: "bsl-ls", status: "check_stale" }] } });
  const ui = screen(async (name, args) => {
    if (name === "settings.read") return snapshot();
    if (name === "settings.status") { statusCalls++; return snapshot(); }
    if (name === "settings.select_profile") { projectRoot = args.projectRoot; return snapshot(); }
    if (name === "settings.load") return {};
    throw new Error("Unexpected active operation: " + name);
  });
  await ui.flush();
  assert.match(ui.elements.get("readinessTitle").textContent, /устарел|провер/i);
  await ui.context.refreshStatus(); await ui.context.refreshStatus();
  await ui.elements.get("headerRefresh").onclick();
  await ui.context.selectProfile("C:/fixture/next");
  await ui.elements.get("headerRefresh").onclick();
  ui.document.hidden = true; ui.documentEvents.visibilitychange();
  ui.document.hidden = false; ui.documentEvents.visibilitychange(); await ui.flush();
  assert.ok(statusCalls >= 4);
  assert.equal(ui.elements.get("projectRoot").value, "C:/fixture/next");
  assert.equal(ui.calls.filter(call => ["settings.run_check", "settings.probe_connections", "settings.updates", "settings.rebuild_index", "settings.restart_index"].includes(call.params?.name)).length, 0);
  assert.ok(ui.calls.some(call=>call.params?.name==="settings.refresh_readiness"));
});

test("component catalogue uses fresh evidence and treats disabled required services as attention", async () => {
  const current={...read,profile:{...read.profile,authorities:{code_index:"code-index",bsl_ls:"bsl-ls"},testing:{yaxunit:false,vanessa:false}},
    values:{...read.values,edtUrl:"http://edt",v8stdUrl:"http://v8std",openvikingEnabled:false,codeIndexEnabled:false,bslLsEnabled:true},
    readiness:{state:"ready",checkedAt:"2026-10-22T12:00:00Z",checks:[{id:"edt",state:"ready"},{id:"v8std",state:"ready"},{id:"code-index",state:"disabled"},{id:"bsl-ls",state:"ready"}]},
    summary:{components:[{id:"code-index",status:"disabled"},{id:"bsl-ls",status:"ready",checkedAt:"2026-10-22T12:00:00Z"}]},installedVersions:{"bsl-ls":"1.2.3"}};
  const ui=screen(async()=>current);await ui.flush();
  const cards=()=>ui.elements.get("componentCatalog").children.flatMap(group=>group.children[1].children);
  const card=name=>cards().find(item=>componentName(item)===name);
  assert.equal(cards().length,7);assert.equal(card("EDT").children[0].children[1].textContent,"Готов");
  assert.equal(ui.elements.get("countAll").textContent,"7");assert.equal(ui.elements.get("countReady").textContent,"3");
  assert.equal(ui.elements.get("countIssues").textContent,"1");assert.equal(ui.elements.get("countDisabled").textContent,"3");
  assert.equal(ui.elements.has("overviewDetails"),false);
  assert.equal(ui.elements.get("profileOverview").hidden,true);
  assert.equal(card("OpenViking").children[0].children[1].textContent,"Отключён");
  assert.match(ui.elements.get("readinessTitle").textContent,/требуется внимание/);
  assert.match(ui.elements.get("readinessDetail").textContent,/Code Index/);
  ui.elements.get("componentsIssues").onclick();assert.ok(card("Code Index"));assert.equal(card("OpenViking"),undefined);
  componentButton(card("Code Index")).onclick();assert.equal(ui.elements.get("managedControls").parentElement,ui.elements.get("managedDialogBody"));
  current.readiness={...current.readiness,state:"stale"};ui.context.renderCurrent(current,{preserveDraft:true});
  ui.elements.get("componentsAll").onclick();assert.equal(card("EDT").children[0].children[1].textContent,"Проверка устарела");
  assert.equal(card("BSL LS").children[0].children[1].textContent,"Проверка устарела");
});

test("known configuration problems take priority over unchecked or stale status", async () => {
  for(const state of ["not_checked","stale"]){
    const current={...read,values:{...read.values,edtUrl:"",v8stdUrl:"http://v8std"},readiness:{state,checks:[]}};
    const ui=screen(async()=>current);await ui.flush();
    assert.equal(ui.elements.get("headerStatusTitle").textContent,"Требует внимания");
    assert.match(ui.elements.get("headerStatusReason").textContent,/EDT/);
  }
});

test("a check completion never announces ready with a disabled assigned authority", async () => {
  const current = { ...read, instance: "default", profile: { ...read.profile, authorities: { code_index: "code-index", bsl_ls: "bsl-ls" } } };
  const ui = screen(async () => current); await ui.flush();
  for (const name of ["code-index", "bsl-ls"]) {
    const result = { managed: [{ name, state: "disabled", ready: true }], external: {}, readiness: { state: "ready", checks: [{ id: name, state: "disabled" }] } };
    ui.context.renderCheck(result, { projectRoot: read.values.projectRoot, instance: "default" });
    assert.match(ui.elements.get("status").textContent, /требует внимания/, name);
    assert.doesNotMatch(ui.elements.get("status").textContent, /Окружение готово/, name);
  }
});

test("component actions target their service and preserve an unrelated document draft", async () => {
  const current={...read,profile:{...read.profile,testing:{yaxunit:true,vanessa:true}},values:{...read.values,edtUrl:"http://edt",v8stdUrl:"http://v8std",openvikingEnabled:false,codeIndexEnabled:true,bslLsEnabled:true},
    knowledge:{provider:"openviking",mode:"kora",required:true},readiness:{state:"ready",checkedAt:"2026-10-22T12:00:00Z",checks:[{id:"edt",state:"ready"},{id:"v8std",state:"ready"}]},summary:{components:[]}};
  const ui=screen(async(name,args)=>name==="settings.edit"?{text:'{"mcp":{}}',baseRevision:"base",layerScope:args.layerScope}:name==="settings.versions"?{component:args.component,versions:[]}:current);await ui.flush();
  const cards=()=>ui.elements.get("componentCatalog").children.flatMap(group=>group.children[1].children),card=name=>cards().find(item=>componentName(item)===name);
  ui.elements.get("componentsIssues").onclick();assert.ok(card("OpenViking"));assert.match(ui.elements.get("readinessDetail").textContent,/OpenViking/);
  componentButton(card("BSL LS")).onclick();assert.equal(ui.elements.get("updateComponent").value,"bsl-ls");assert.equal(ui.elements.get("managedDialog").open,true);assert.equal(ui.document.activeElement,ui.elements.get("bslLsEnabled"));ui.elements.get("managedDialogClose").onclick();
  ui.elements.get("editorDocument").value="project_local";ui.elements.get("editorDocument").events.change();await ui.flush();
  ui.elements.get("settingsText").value='{"mcp":{"draft":true}}';ui.elements.get("settingsText").events.input();
  componentButton(card("YaXUnit")).onclick();assert.equal(ui.elements.get("editorDocument").value,"project_local");assert.match(ui.elements.get("settingsText").value,/draft/);
});

test("testing cards open and focus the matching profile field", async () => {
  const backend=new SettingsBackend("unused-state","unused-settings"),text="testing:\n  commands: []\n  yaxunit: false\n  vanessa: false\n";
  const current={...read,profile:{...read.profile,testing:{yaxunit:false,vanessa:false}}};
  const ui=screen(async(name,args)=>{
    if(["settings.read","settings.status"].includes(name))return current;
    if(name==="settings.edit")return {text,format:"yaml",baseRevision:"base",layerScope:"profile"};
    if(name==="settings.document_fields")return backend.main({action:"document_fields",...args});
    throw new Error(name);
  });
  await ui.flush();const cards=ui.elements.get("componentCatalog").children.flatMap(group=>group.children[1].children);
  componentButton(cards.find(card=>componentName(card)==="YaXUnit")).onclick();
  await ui.flush();await ui.flush();await ui.flush();
  const section=ui.elements.get("jsonTree").children.find(item=>item.children[0].textContent==="Тестирование");
  assert.equal(section.open,true);assert.equal(ui.document.activeElement.attributes?.["aria-label"],"testing.yaxunit");
});

test("managed component dialog keeps a draft and collapses its panel on close", async () => {
  const current={...read,values:{...read.values,codeIndexEnabled:true,bslLsEnabled:true},summary:{components:[]}};
  const ui=screen(async()=>current);await ui.flush();const cards=ui.elements.get("componentCatalog").children.flatMap(group=>group.children[1].children);
  componentButton(cards.find(card=>componentName(card)==="BSL LS")).onclick();
  assert.equal(ui.elements.get("codeIndexChoice").hidden,true);assert.equal(ui.elements.get("bslLsChoice").hidden,false);assert.equal(ui.elements.get("javaSettingsPanel").hidden,false);assert.equal(ui.elements.get("updateComponent").disabled,true);
  ui.elements.get("bslLsEnabled").checked=false;ui.elements.get("bslLsEnabled").events.change();ui.elements.get("managedDialogClose").onclick();
  assert.equal(ui.elements.get("managedCloseConfirm").open,true);ui.elements.get("managedCloseKeep").onclick();
  assert.equal(ui.elements.get("managedDialog").open,false);assert.equal(ui.elements.get("managedControls").parentElement,ui.elements.get("managedControlsHolder"));assert.equal(ui.elements.get("bslLsEnabled").checked,false);assert.equal(ui.elements.get("codeIndexChoice").hidden,false);assert.equal(ui.elements.get("updateComponent").disabled,false);
  componentButton(cards.find(card=>componentName(card)==="Code Index")).onclick();
  assert.equal(ui.elements.get("managedDialog").open,false);assert.match(ui.elements.get("status").textContent,/черновик другого компонента/);
});

test("separate import and export actions expose the selected transfer flow", async () => {
  const ui=screen(async()=>read);await ui.flush();
  ui.elements.get("openImportButton").onclick();assert.equal(ui.elements.get("transferImportSection").hidden,false);assert.equal(ui.elements.get("transferExportSection").hidden,true);
  ui.elements.get("transferClose").onclick();assert.equal(ui.document.activeElement,ui.elements.get("openImportButton"));
  ui.elements.get("openExportButton").onclick();assert.equal(ui.elements.get("transferImportSection").hidden,true);assert.equal(ui.elements.get("transferExportSection").hidden,false);
  ui.elements.get("transferClose").onclick();ui.context.show("export");assert.equal(ui.elements.get("transferImportSection").hidden,true);assert.equal(ui.elements.get("transferExportSection").hidden,false);
});

test("connection dialog keeps its draft and prevents saving it from another component", async () => {
  const current={...read,values:{...read.values,edtUrl:"http://edt",v8stdUrl:"http://v8std"},readiness:{state:"not_checked"},summary:{components:[]}};
  const ui=screen(async()=>current);await ui.flush();
  const card=name=>ui.elements.get("componentCatalog").children.flatMap(group=>group.children[1].children).find(item=>componentName(item)===name);
  componentButton(card("EDT")).onclick();assert.equal(ui.elements.get("componentDialog").open,true);
  assert.equal(ui.elements.get("edtField").hidden,false);assert.equal(ui.elements.get("v8stdField").hidden,true);
  ui.elements.get("connectionScope").value="project_local";ui.elements.get("connectionScope").events.change();
  ui.elements.get("edtUrl").value="http://draft";ui.elements.get("edtUrl").events.input();
  ui.elements.get("connectionScope").value="profile";ui.elements.get("connectionScope").events.change();
  assert.equal(ui.elements.get("connectionScope").value,"project_local");assert.match(ui.elements.get("componentDialogStatus").textContent,/сменой области/);
  ui.elements.get("componentDialogClose").onclick();assert.equal(ui.elements.get("componentCloseConfirm").open,true);
  ui.elements.get("componentCloseKeep").onclick();assert.equal(ui.elements.get("componentDialog").open,false);
  assert.equal(ui.elements.get("edtUrl").value,"http://draft");
  componentButton(card("v8std")).onclick();assert.equal(ui.elements.get("componentDialog").open,false);assert.match(ui.elements.get("status").textContent,/черновик другого подключения/);
  componentButton(card("EDT")).onclick();assert.equal(ui.elements.get("componentDialog").open,true);
});

test("discarding a connection draft does not release a pending external project change", async () => {
  const current={...read,instance:"first",values:{...read.values,edtUrl:"http://edt",bslLsJava:"java"},summary:{components:[]}};
  const ui=screen(async()=>current);await ui.flush();
  const cards=ui.elements.get("componentCatalog").children.flatMap(group=>group.children[1].children),edt=cards.find(item=>componentName(item)==="EDT");
  componentButton(edt).onclick();ui.elements.get("edtUrl").value="http://draft";ui.elements.get("edtUrl").events.input();
  ui.elements.get("bslLsJava").value="other-draft";ui.elements.get("bslLsJava").events.input();
  ui.context.renderCurrent({...current,values:{...current.values,projectRoot:"C:/new"}},{preserveDraft:true});
  assert.equal(ui.elements.get("saveButton").disabled,true);
  ui.elements.get("componentDiscard").onclick();
  assert.equal(ui.elements.get("edtUrl").value,"http://edt");assert.equal(ui.elements.get("bslLsJava").value,"other-draft");
  assert.equal(ui.elements.get("saveJavaButton").disabled,true);assert.equal(ui.elements.get("unsavedHint").hidden,false);
  assert.match(ui.elements.get("componentDialogStatus").textContent,/Проект изменился/);
  ui.elements.get("bslLsJava").value="java";ui.elements.get("bslLsJava").events.input();
  assert.equal(ui.elements.get("unsavedHint").hidden,false);assert.equal(ui.elements.get("discardDraftButton").disabled,false);
});

test("component catalogue shows checking instead of the previous ready receipt during a scoped operation", async () => {
  const current={...read,instance:"default",values:{...read.values,edtUrl:"http://edt",v8stdUrl:"http://v8std"},readiness:{state:"ready",checkedAt:"2026-10-22T12:00:00Z",checks:[{id:"edt",state:"ready"},{id:"v8std",state:"ready"}]},summary:{components:[]}};
  const ui=screen(async()=>current);await ui.flush();
  current.operation={id:"check",action:"check",status:"running",projectRoot:read.values.projectRoot,instance:"default"};ui.context.renderCurrent(current,{preserveDraft:true});
  const cards=ui.elements.get("componentCatalog").children.flatMap(group=>group.children[1].children),edt=cards.find(item=>componentName(item)==="EDT");
  assert.equal(edt.children[0].children[1].textContent,"Проверяется…");
});

test("enabled YaXUnit without launch evidence requires attention in the setup summary", async () => {
  const current={...read,profile:{...read.profile,testing:{yaxunit:true,vanessa:true}},values:{...read.values,edtUrl:"http://edt",v8stdUrl:"http://v8std"},readiness:{state:"ready",checkedAt:"2026-10-22T12:00:00Z",checks:[{id:"edt",state:"ready"},{id:"v8std",state:"ready"}]},summary:{components:[]}};
  const ui=screen(async()=>current);await ui.flush();
  const cards=ui.elements.get("componentCatalog").children.flatMap(group=>group.children[1].children),testCard=cards.find(item=>componentName(item)==="YaXUnit");
  assert.equal(testCard.children[0].children[1].textContent,"Не настроен");assert.equal(ui.elements.get("headerStatusTitle").textContent,"Требует внимания");
});

test("header names non-component readiness failures and opens their details", async () => {
  const current={...read,values:{...read.values,edtUrl:"http://edt",v8stdUrl:"http://v8std"},readiness:{state:"blocked",checkedAt:"2026-10-22T12:00:00Z",checks:[{id:"edt",label:"EDT",state:"ready"},{id:"v8std",label:"v8std",state:"ready"},{id:"policy",label:"Политика",state:"error"}]},summary:{components:[]}};
  const ui=screen(async()=>current);await ui.flush();assert.equal(ui.elements.get("headerStatusTitle").textContent,"Требует внимания");
  assert.match(ui.elements.get("headerStatusReason").textContent,/Политика/);
  ui.elements.get("headerStatus").onclick();assert.equal(ui.elements.get("readinessDetails").open,true);assert.equal(ui.elements.get("checkPanel").hidden,false);
});

test("a manual status refresh leaves the form usable and preserves edits made while waiting", async () => {
  let release;
  const snapshot={...read,instance:"default",values:{...read.values,edtUrl:"saved"}};
  const ui=screen(async name=>{
    if(name==="settings.read")return snapshot;
    if(name==="settings.status"){await new Promise(resolve=>{release=resolve;});return snapshot;}
    throw new Error(name);
  });
  await ui.flush();
  const pending=ui.elements.get("headerRefresh").onclick();await ui.flush();
  assert.equal(ui.elements.get("edtUrl").disabled,false);
  ui.elements.get("edtUrl").value="draft";ui.elements.get("edtUrl").events.input();
  release();await pending;
  assert.equal(ui.elements.get("edtUrl").value,"draft");
});

test("a manual status refresh reports failure without overwriting a later action's notice", async () => {
  let release;
  const ui=screen(async name=>{
    if(name==="settings.read")return {...read,instance:"default"};
    if(name==="settings.status"){await new Promise(resolve=>{release=resolve;});throw new Error("unavailable");}
    throw new Error(name);
  });
  await ui.flush();const pending=ui.elements.get("headerRefresh").onclick();await ui.flush();
  ui.context.notice("Настройки сохранены.");release();await pending;
  assert.equal(ui.elements.get("status").textContent,"Настройки сохранены.");
  assert.match(ui.elements.get("headerRefresh").title,/Нет свежих данных/);
});

test("a failed status request for the previous profile does not mark the selected profile stale", async () => {
  let release;
  const ui=screen(async (name,args)=>{
    if(name==="settings.read")return {...read,instance:"default"};
    if(name==="settings.status"){await new Promise(resolve=>{release=resolve;});throw new Error("unavailable");}
    if(name==="settings.select_profile")return {...read,instance:"default",values:{projectRoot:args.projectRoot}};
    throw new Error(name);
  });
  await ui.flush();const pending=ui.elements.get("headerRefresh").onclick();await ui.flush();
  await ui.context.selectProfile("C:/fixture/other");
  const indicator=ui.elements.get("headerRefresh").title;
  release();await pending;assert.equal(ui.elements.get("headerRefresh").title,indicator);
});

test("an existing readiness check completed on the first poll does not trigger another check", async () => {
  let completed=false;
  const ui=screen(async name=>{
    if(name==="settings.read")return {...read,instance:"default",readiness:{state:completed?"ready":"stale",checks:[]},operation:completed?{status:"completed"}:{id:"existing",action:"check",status:"running"}};
    if(name==="settings.operation"){completed=true;return {id:"existing",action:"check",projectRoot:read.values.projectRoot,instance:"default",status:"completed",result:{managed:[],external:{}}};}
    throw new Error(name);
  });await ui.flush();
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.operation").length,1);
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.run_check").length,0);
});

test("a real operation entry matching the backend snapshot still opens its result", async () => {
  const operation={id:"existing",action:"load",projectRoot:read.values.projectRoot,instance:"default",status:"completed"};
  const ui=screen(async name=>{
    if(name==="settings.read")return {...read,instance:"default",operation};
    if(name==="settings.operation")return operation;
    throw new Error(name);
  });await ui.flush();
  ui.deliver({jsonrpc:"2.0",method:"ui/notifications/tool-result",params:{structuredContent:{id:"existing",mode:"operation",navigation:"project"}}});await ui.flush();
  assert.equal(ui.elements.get("checkPanel").hidden,false);
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.operation").length,1);
  assert.match(ui.elements.get("status").textContent,/Профиль загружен/);
});

test("manual status observation preserves drafts without preparation or foreground probes", async () => {
  let observations=0;
  const ui=screen(async name=>{
    if(name==="settings.read")return {...read,values:{...read.values,edtUrl:"inherited",codeIndexEnabled:true}};
    if(name==="settings.status"){observations++;return {...read,values:{...read.values,edtUrl:"changed-on-disk",codeIndexEnabled:true},summary:{observedAt:"2026-10-21T12:00:00Z",components:[{id:"code-index",status:"running"}]}};}
    throw new Error(name);
  });
  await ui.flush();
  ui.elements.get("edtUrl").value="draft";ui.elements.get("edtUrl").events.input();
  ui.elements.get("codeIndexEnabled").checked=false;ui.elements.get("codeIndexEnabled").events.change();
  await ui.context.refreshStatus();await ui.context.refreshStatus();
  assert.equal(observations,2);
  assert.equal(ui.elements.get("edtUrl").value,"draft");assert.equal(ui.elements.get("codeIndexEnabled").checked,false);
  assert.equal(headerState(ui,"Code Index"),"Процесс работает");
  assert.equal(ui.calls.filter(call=>["settings.run_check","settings.probe_connections","settings.update"].includes(call.params?.name)).length,0);
  ui.elements.get("discardDraftButton").onclick();
  assert.equal(ui.elements.get("edtUrl").value,"changed-on-disk");
});

test("visibility refreshes observations and a late manual status request cannot update a closed form", async () => {
  let release;
  const ui=screen(async name=>name==="settings.read"?read:new Promise(resolve=>{release=resolve;}));
  await ui.flush();ui.document.hidden=true;ui.documentEvents.visibilitychange();
  assert.equal([...ui.timers.values()].filter(timer=>timer.ms===60000).length,0);
  ui.document.hidden=false;ui.documentEvents.visibilitychange();await ui.flush();
  assert.equal([...ui.timers.values()].filter(timer=>timer.ms===60000).length,1);
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.status").length,1);
  const observing=ui.context.refreshStatus();await ui.flush();
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.status").length,1);
  await ui.context.refreshStatus();
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.status").length,1);
  ui.lifecycle.pagehide();release({...read,profile:{status:"loaded",projectId:"Late"}});await ui.flush();
  assert.equal(ui.elements.get("profileTitle").textContent,"Project");
  assert.equal([...ui.timers.values()].filter(timer=>timer.ms===60000).length,0);
});

test("the profile chooser gates scoped settings until a profile is loaded", async () => {
  const ui=screen(async name=>{assert.equal(name,"settings.read");return {...read,profile:{status:"missing"}};});
  await ui.flush();assert.equal(ui.elements.get("connectionSettings").hidden,true);
  for(const id of ["saveButton","readinessButton","saveComponentsButton","transferExport"])assert.equal(ui.elements.get(id).disabled,true);
  for(const id of ["connectionSharedButton","connectionLocalButton","componentSharedButton","componentLocalButton","javaSharedButton","javaLocalButton","javaGlobalButton"])assert.equal(ui.elements.get(id).disabled,true,id);
  assert.equal(ui.elements.get("createButton").hidden,false);assert.equal(ui.elements.get("openMissingTransfer").disabled,false);
});

test("history previews another profile read-only without selecting it for chat operations", async () => {
  const other={...read,values:{...read.values,projectRoot:"C:/fixture/other"},profile:{...read.profile,projectId:"Other"},viewOnly:true};
  const ui=screen(async(name,args)=>{
    if(name==="settings.read")return {...read,profileHistory:[{projectRoot:other.values.projectRoot,projectId:"Other",status:"loaded",repositoryCount:2}]};
    if(name==="settings.select_profile"||name==="settings.status"){assert.equal(args.projectRoot,other.values.projectRoot);return other;}
    if(name==="settings.document"){assert.equal(args.projectRoot,other.values.projectRoot);return {text:"history-profile-document",baseRevision:"history"};}
    throw new Error(name);
  });
  await ui.flush();await ui.elements.get("profileHistory").children.find(item=>item.children[0].children[0].textContent==="Other").children[0].onclick();
  assert.equal(ui.elements.get("profileTitle").textContent,"Other");assert.equal(ui.elements.get("viewOnlyHint").hidden,false);
  for(const id of ["saveButton","probeButton","readinessButton","transferExport"])assert.equal(ui.elements.get(id).disabled,true);
  for(const id of ["connectionSharedButton","connectionLocalButton","componentSharedButton","componentLocalButton","javaSharedButton","javaLocalButton","javaGlobalButton"])assert.equal(ui.elements.get(id).disabled,true,id);
  assert.equal(ui.elements.get("editSettingsButton").disabled,false);
  assert.equal(ui.elements.get("settingsText").readOnly,true);
  ui.elements.get("editorTab").onclick();await ui.flush();
  assert.equal(ui.elements.get("settingsText").value,"history-profile-document");
  assert.equal(ui.elements.get("settingsText").disabled,false);
  await ui.context.refreshStatus();assert.equal(ui.calls.filter(call=>call.params?.name==="settings.update").length,0);
});

test("profile cards show EDT project counts instead of repository counts", async () => {
  const ui = screen(async () => ({ ...read,
    profile: { ...read.profile, repositories: [{ id: "one", path: "." }] },
    directoryContext: { edt: { projectCount: 2 } },
    profileHistory: [
      { projectRoot: "C:/other", projectId: "Other", status: "loaded", repositoryCount: 3, edtProjectCount: 0 },
      { projectRoot: "C:/old", projectId: "Old", status: "unavailable", repositoryCount: 5 },
    ],
  }));
  await ui.flush();
  const cards = ui.elements.get("profileHistory").children.map(card => card.children[0]);
  assert.equal(cards.find(card => card.children[0].textContent === "Project").children[2].textContent, "EDT-проектов: 2");
  assert.equal(cards.find(card => card.children[0].textContent === "Other").children[2].textContent, "EDT-проектов: 0");
  assert.equal(cards.find(card => card.children[0].textContent === "Old").children[2].textContent, "EDT-проектов: —");
  assert.match(ui.elements.get("headerProfileFacts").textContent,/EDT-проектов: 2/);
});

test("typing a new directory requires explicit selection and leaves current settings intact", async () => {
  let selected=false;
  const ui=screen(async(name,args)=>{
    if(name==="settings.read")return {...read,schema:{},values:{...read.values,edtUrl:"inherited"}};
    if(name==="settings.select_profile"){selected=true;assert.equal(args.projectRoot,"C:/new");return {...read,schema:{},values:{...read.values,projectRoot:"C:/new"}};}
    throw new Error(name);
  });
  await ui.flush();ui.elements.get("projectRoot").value="C:/new";ui.elements.get("projectRoot").events.input();
  assert.equal(ui.elements.get("saveButton").disabled,true);assert.equal(selected,false);
  await ui.elements.get("selectProfileButton").onclick();assert.equal(selected,true);
  assert.equal(ui.elements.get("saveButton").disabled,true);
});

test("history search filters names and paths without losing profile state", async () => {
  const ui=screen(async()=>({...read,profileHistory:[{projectRoot:"C:/Archive/Old",projectId:"Old",status:"unavailable",repositoryCount:3}]}));
  await ui.flush();ui.elements.get("historySearch").value="archive";ui.elements.get("historySearch").events.input();
  const entries=ui.elements.get("profileHistory").children;
  assert.equal(entries.length,1);assert.equal(entries[0].children[0].disabled,true);assert.equal(entries[0].children[0].children[3].textContent,"Каталог недоступен");
  ui.elements.get("historySearch").value="absent";ui.elements.get("historySearch").events.input();
  assert.equal(ui.elements.get("historyEmpty").textContent,"Профили не найдены.");
});

test("history removal works for unavailable and current profiles without selecting them", async () => {
  const gone={projectRoot:"C:/gone",projectId:"Gone",status:"unavailable"};let history=[gone];
  const ui=screen(async(name,args)=>{
    if(name==="settings.read")return {...read,profileHistory:history};
    if(name==="settings.forget_profile"){history=history.filter(item=>item.projectRoot!==args.projectRoot);return {profileHistory:history};}
    throw new Error(name);
  });
  await ui.flush();const cards=ui.elements.get("profileHistory").children;
  const unavailable=cards.find(card=>card.children[0].children[0].textContent==="Gone");
  assert.equal(unavailable.children[0].disabled,true);assert.equal(unavailable.children[1].disabled,false);
  await unavailable.children[1].onclick();
  const current=ui.elements.get("profileHistory").children[0];await current.children[1].onclick();
  assert.equal(ui.elements.get("profileHistory").children.length,0);
  assert.equal(ui.elements.get("profileTitle").textContent,"Project");
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.select_profile").length,0);
});

test("removing the selected profile opens the most recently used available profile", async () => {
  const currentRoot=read.values.projectRoot, nextRoot="C:/next", goneRoot="C:/gone";
  let history=[{projectRoot:currentRoot,projectId:"Project",status:"loaded"},{projectRoot:goneRoot,status:"unavailable"},{projectRoot:nextRoot,projectId:"Next",status:"loaded"}];
  const ui=screen(async(name,args)=>{
    if(name==="settings.read")return {...read,projectSelection:{locked:false},profileHistory:history};
    if(name==="settings.forget_profile"){history=history.filter(item=>item.projectRoot!==args.projectRoot);return {profileHistory:history};}
    if(name==="settings.select_profile"){assert.equal(args.projectRoot,nextRoot);return {...read,values:{projectRoot:nextRoot,edtUrl:"http://next"},profile:{status:"loaded",projectId:"Next"},profileHistory:history};}
    throw new Error(name);
  });await ui.flush();
  await ui.elements.get("profileHistory").children.find(card=>card.children[0].children[0].textContent==="Project").children[1].onclick();
  assert.equal(ui.elements.get("profileTitle").textContent,"Next");
  assert.equal(ui.elements.get("edtUrl").value,"http://next");
  assert.match(ui.elements.get("status").textContent,/настройки загружены/);
});

test("removing another profile leaves the selected valid profile unchanged", async () => {
  let history=[{projectRoot:read.values.projectRoot,projectId:"Project",status:"loaded"},{projectRoot:"C:/other",projectId:"Other",status:"loaded"}];
  const ui=screen(async(name,args)=>{
    if(name==="settings.read")return {...read,profileHistory:history};
    if(name==="settings.forget_profile"){history=history.filter(item=>item.projectRoot!==args.projectRoot);return {profileHistory:history};}
    throw new Error(name);
  });await ui.flush();
  await ui.elements.get("profileHistory").children.find(card=>card.children[0].children[0].textContent==="Other").children[1].onclick();
  assert.equal(ui.elements.get("profileTitle").textContent,"Project");
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.select_profile").length,0);
});

test("automatic selection after removal preserves an unsaved import or directory draft", async () => {
  for(const draft of ["import","directory"]){
    const missing={...read,profile:{status:"missing"},projectSelection:{locked:false}};
    let history=[{projectRoot:"C:/first",projectId:"First",status:"loaded"},{projectRoot:"C:/second",projectId:"Second",status:"loaded"}];
    const ui=screen(async(name,args)=>{
      if(name==="settings.read")return {...missing,profileHistory:history};
      if(name==="settings.forget_profile"){history=history.filter(item=>item.projectRoot!==args.projectRoot);return {profileHistory:history};}
      throw new Error(name);
    });await ui.flush();
    if(draft==="import"){ui.elements.get("transferPath").value="C:/draft.yaml";ui.elements.get("transferPath").events.input();}
    else{ui.elements.get("projectRoot").value="C:/typed";ui.elements.get("projectRoot").events.input();}
    await ui.elements.get("profileHistory").children.find(card=>card.children[0].children[0].textContent==="Second").children[1].onclick();
    assert.equal(ui.calls.filter(call=>call.params?.name==="settings.select_profile").length,0);
    assert.equal(ui.elements.get("profileHistory").children.some(card=>card.children[0].children[0].textContent==="Second"),false);
    assert.match(ui.elements.get("status").textContent,/Сохраните или отмените изменения/);
    assert.equal(draft==="import"?ui.elements.get("transferPath").value:ui.elements.get("projectRoot").value,draft==="import"?"C:/draft.yaml":"C:/typed");
  }
});

test("automatic selection after removal does not rebind a locked chat and reports selection errors", async () => {
  for(const locked of [true,false]){
    const missing={...read,profile:{status:"missing"},projectSelection:{locked}};
    let history=[{projectRoot:"C:/first",projectId:"First",status:"loaded"},{projectRoot:"C:/second",projectId:"Second",status:"loaded"}];
    const ui=screen(async(name,args)=>{
      if(name==="settings.read")return {...missing,profileHistory:history};
      if(name==="settings.forget_profile"){history=history.filter(item=>item.projectRoot!==args.projectRoot);return {profileHistory:history};}
      if(name==="settings.select_profile")throw new Error("профиль недоступен");
      throw new Error(name);
    });await ui.flush();
    await ui.elements.get("profileHistory").children.find(card=>card.children[0].children[0].textContent==="Second").children[1].onclick();
    assert.equal(ui.elements.get("projectRoot").value,read.values.projectRoot);
    assert.equal(ui.calls.filter(call=>call.params?.name==="settings.select_profile").length,locked?0:1);
    assert.match(ui.elements.get("status").textContent,locked?/Файлы профиля сохранены/:/убран из списка, но открыть оставшийся не удалось.*недоступен/);
  }
});

test("a failed manual observation can be retried and keeps the last successful profile visible", async () => {
  let attempts=0;
  const ui=screen(async name=>{if(name==="settings.read")return read;if(name==="settings.status"&&++attempts===1)throw new Error("offline");return {...read,summary:{observedAt:"2026-10-21T12:00:00Z",components:[]}};});
  await ui.flush();await ui.context.refreshStatus();assert.match(ui.elements.get("headerRefresh").title,/Нет свежих данных/);
  assert.equal(ui.elements.get("profileTitle").textContent,"Project");await ui.context.refreshStatus();
  assert.equal(attempts,2);assert.match(ui.elements.get("headerRefresh").title,/Обновить состояние/);
});

test("keyboard navigation skips unavailable profile tabs and dirty drafts guard the folder picker", async () => {
  const ui=screen(async()=>({...read,profile:{status:"missing"},schema:{}}));await ui.flush();
  ui.elements.get("checkTab").events.keydown({key:"ArrowRight",preventDefault(){}});
  assert.equal(ui.elements.get("supportPanel").hidden,false);
  ui.elements.get("settingsText").value="draft";ui.elements.get("settingsText").events.input();
  await ui.elements.get("pickDirectoryButton").onclick();
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.pick_directory").length,0);
  assert.match(ui.elements.get("status").textContent,/Сохраните изменения/);
});

test("chat settings do not automatically choose another profile when the chat root is unknown", async () => {
  const ui=screen(async name=>{assert.equal(name,"settings.read");return {...read,values:{projectRoot:""},profile:{status:"unselected"},profileHistory:[{projectRoot:"C:/other",status:"loaded"}]};},{navigation:"project"});
  await ui.flush();assert.equal(ui.elements.get("profileBrowser").hidden,true);
  assert.equal(ui.elements.get("profileToggleButton").hidden,false);
  assert.equal(ui.elements.get("projectRoot").readOnly,true);assert.equal(ui.elements.get("pickDirectoryButton").hidden,true);
  assert.equal(ui.elements.get("directoryChooser").hidden,true);assert.equal(ui.elements.get("addProfileButton").hidden,true);
  assert.equal(ui.elements.get("viewDirectoryChooser").hidden,false);assert.equal(ui.elements.get("openViewDirectoryButton").disabled,true);
  ui.elements.get("profileToggleButton").onclick();
  await ui.elements.get("profileHistory").children[0].children[0].onclick();
  assert.match(ui.elements.get("profileChooserStatus").textContent,/Сначала определите каталог/);
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.select_profile").length,0);
  assert.equal(ui.elements.get("emptyTitle").textContent,"Проект чата не определён");
  assert.equal(ui.elements.get("headerStatusReason").textContent,"Выберите проект");
});

test("settings declare fullscreen only and request it once when the host initially embeds the form", async () => {
  const ui=screen(async()=>read,{hostContext:{displayMode:"inline",availableDisplayModes:["inline","fullscreen"]}});await ui.flush();
  const modes=ui.calls.find(call=>call.method==="ui/initialize").params.appCapabilities.availableDisplayModes;
  assert.equal(JSON.stringify(modes),'["fullscreen"]');
  assert.equal(ui.calls.filter(call=>call.method==="ui/request-display-mode").length,1);
  assert.equal(ui.calls.find(call=>call.method==="ui/request-display-mode").params.mode,"fullscreen");
  ui.deliver({jsonrpc:"2.0",method:"ui/notifications/host-context-changed",params:{displayMode:"fullscreen"}});await ui.flush();
  assert.equal(ui.calls.filter(call=>call.method==="ui/request-display-mode").length,1);
});

test("a late chat entry result carries the directory into a separate app connection without navigating away", async () => {
  const ui=screen(async(name,args,meta)=>{
    if(name==="settings.diagnostics")return {events:[]};
    assert.equal(name,"settings.read");return meta?.["1c-ai-core/projectRoot"]===read.values.projectRoot?read:{...read,values:{projectRoot:""},profile:{status:"unselected"}};
  },{navigation:"project"});await ui.flush();
  ui.elements.get("supportTab").onclick();await ui.flush();
  ui.deliver({jsonrpc:"2.0",method:"ui/notifications/tool-result",params:{structuredContent:{...read,mode:"profile",navigation:"project"}}});await ui.flush();
  assert.equal(ui.elements.get("profileTitle").textContent,"Project");assert.equal(ui.elements.get("supportPanel").hidden,false);
  const readCall=ui.calls.filter(call=>call.params?.name==="settings.read").at(-1);
  assert.equal(readCall.params._meta["1c-ai-core/projectRoot"],read.values.projectRoot);
  assert.equal(ui.elements.get("profileBrowser").hidden,true);
});

test("tool input supplies chat scope before the first app read and an empty entry can request context from the chat", async () => {
  const ui=screen(async(name,args,meta)=>{assert.equal(name,"settings.read");assert.equal(meta["1c-ai-core/projectRoot"],read.values.projectRoot);return read;},{navigation:"project"});
  ui.deliver({jsonrpc:"2.0",method:"ui/notifications/tool-input",params:{arguments:{projectRoot:read.values.projectRoot}}});await ui.flush();
  assert.equal(ui.elements.get("profileTitle").textContent,"Project");
  const empty=screen(async()=>({...read,values:{projectRoot:""},profile:{status:"unselected"}}),{navigation:"project"});await empty.flush();
  assert.equal(empty.elements.get("resolveChatActions").hidden,false);await empty.elements.get("resolveChatButton").onclick();
  assert.equal(empty.calls.filter(call=>call.method==="ui/message").length,1);
  assert.equal(empty.calls.filter(call=>call.params?.name==="settings.select_profile").length,0);
});

test("project selector opens from the header at narrow and wide widths without changing the selected profile", async () => {
  const ui=screen(async name=>{assert.equal(name,"settings.read");return read;},{narrow:true});await ui.flush();
  assert.equal(ui.elements.get("profileBrowser").hidden,true);assert.equal(ui.elements.get("profileToggleButton").hidden,false);
  ui.elements.get("profileToggleButton").onclick();
  assert.equal(ui.elements.get("profileBrowser").hidden,false);assert.equal(ui.elements.get("profileBackdrop").hidden,false);
  assert.equal(ui.elements.get("profileBrowser").attributes["aria-modal"],"true");assert.equal(ui.elements.get("settingsWorkspace").inert,true);
  assert.equal(ui.elements.get("profileTitle").textContent,"Project");
  ui.documentEvents.keydown({key:"Escape",preventDefault(){}});
  assert.equal(ui.elements.get("profileBrowser").hidden,true);assert.equal(ui.elements.get("settingsWorkspace").inert,false);
  ui.elements.get("profileToggleButton").onclick();ui.elements.get("profileBackdrop").onclick();
  assert.equal(ui.elements.get("profileBrowser").hidden,true);
  ui.media.matches=false;assert.equal(ui.elements.get("profileBrowser").hidden,true);
  assert.equal(ui.elements.get("profileToggleButton").hidden,false);
  assert.equal(ui.elements.get("selectedProjectLabel").textContent,"Project");
  ui.elements.get("profileToggleButton").onclick();assert.equal(ui.elements.get("profileBrowser").hidden,false);
  ui.documentEvents.keydown({key:"Escape",preventDefault(){}});
  assert.equal(ui.elements.get("profileBrowser").hidden,true);assert.equal(ui.document.activeElement,ui.elements.get("profileToggleButton"));
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.select_profile").length,0);
});

test("project selector announces a blocked directory picker inside the modal when a draft exists", async () => {
  const ui=screen(async()=>({...read,schema:{properties:{projectRoot:{readOnly:false}}},folderActions:{supported:true}}));await ui.flush();
  ui.elements.get("settingsText").value="draft";ui.elements.get("settingsText").events.input();
  ui.elements.get("profileToggleButton").onclick();
  await ui.elements.get("addProfileButton").onclick();
  assert.equal(ui.elements.get("profileBrowser").hidden,false);
  assert.match(ui.elements.get("profileChooserStatus").textContent,/Сохраните изменения/);
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.pick_directory").length,0);
});

test("chat directory picker opens the chosen profile read-only and retains the chat scope", async () => {
  const base = { ...read, instance: "default", projectSelection: { locked: true }, folderActions: { supported: true } };
  const other = "C:/fixture/other";
  const ui = screen(async (name, args, meta) => {
    if (name === "settings.read" || name === "settings.status") return base;
    if (name === "settings.pick_view_directory") return { id: "pick-view", action: "pick_view_directory", status: "running", projectRoot: read.values.projectRoot, instance: "default" };
    if (name === "settings.operation") return { id: "pick-view", action: "pick_view_directory", status: "completed", projectRoot: read.values.projectRoot, instance: "default", result: { directory: other } };
    if (name === "settings.select_profile") {
      assert.equal(args.projectRoot, other); assert.equal(meta["1c-ai-core/projectRoot"], read.values.projectRoot);
      return { ...base, values: { projectRoot: other }, profile: { ...read.profile, projectId: "Other" }, viewOnly: true, chatProjectRoot: read.values.projectRoot };
    }
    throw new Error(name);
  }, { navigation: "project" });
  await ui.flush();
  ui.deliver({jsonrpc:"2.0",method:"ui/notifications/tool-input",params:{arguments:{projectRoot:read.values.projectRoot+"/src"}}});
  await ui.context.refreshStatus();
  ui.elements.get("profileToggleButton").onclick(); await ui.elements.get("pickViewDirectoryButton").onclick();
  assert.equal(ui.elements.get("profileTitle").textContent, "Other"); assert.equal(ui.elements.get("viewOnlyHint").hidden, false);
  assert.equal(ui.elements.get("profileBrowser").hidden, true);
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.pick_view_directory").length, 1);
});

test("a changed chat input invalidates a pending view picker before it selects a profile", async () => {
  const base = { ...read, instance: "default", projectSelection: { locked: true }, folderActions: { supported: true } };
  let release;
  const ui = screen(async name => {
    if (name === "settings.read") return base;
    if (name === "settings.pick_view_directory") return { id: "pick-view", action: "pick_view_directory", status: "running", projectRoot: read.values.projectRoot, instance: "default" };
    if (name === "settings.operation") { await new Promise(resolve => { release = resolve; }); return { id: "pick-view", action: "pick_view_directory", status: "completed", projectRoot: read.values.projectRoot, instance: "default", result: { directory: "C:/other" } }; }
    throw new Error("Unexpected call " + name);
  }, { navigation: "project" });
  await ui.flush(); ui.elements.get("profileToggleButton").onclick();
  const picking = ui.elements.get("pickViewDirectoryButton").onclick(); await ui.flush();
  ui.deliver({jsonrpc:"2.0",method:"ui/notifications/tool-input",params:{arguments:{projectRoot:"C:/new-chat"}}});
  release(); await picking;
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.select_profile").length,0);
  assert.match(ui.elements.get("profileChooserStatus").textContent,/Каталог чата изменился/);
  await ui.context.selectProfile("C:/other");
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.select_profile").length,0);
  assert.equal(ui.elements.get("profileTitle").textContent,"Project");
});

test("a changed chat input discards an in-flight history selection", async () => {
  const base = { ...read, instance: "default", projectSelection: { locked: true } }; let release;
  const ui = screen(async name => {
    if(name==="settings.read")return base;
    if(name==="settings.select_profile"){await new Promise(resolve=>{release=resolve;});return {...base,values:{projectRoot:"C:/other"},profile:{...read.profile,projectId:"Other"},viewOnly:true,chatProjectRoot:read.values.projectRoot};}
    throw new Error(name);
  },{navigation:"project"});await ui.flush();
  const selecting=ui.context.selectProfile("C:/other");await ui.flush();
  ui.deliver({jsonrpc:"2.0",method:"ui/notifications/tool-input",params:{arguments:{projectRoot:"C:/new-chat"}}});
  release();await selecting;
  assert.equal(ui.elements.get("profileTitle").textContent,"Project");
  assert.match(ui.elements.get("status").textContent,/Каталог чата изменился/);
});

test("a viewed profile stays visible while the new chat scope is confirmed", async () => {
  const first=read.values.projectRoot,second="C:/new-chat",other="C:/history",third="C:/another";
  const base=root=>({...read,values:{projectRoot:root},instance:"default",projectSelection:{locked:true}});
  let selected=other;
  const ui=screen(async(name,args,meta)=>{
    if(name==="settings.read")return base(meta?.["1c-ai-core/projectRoot"]===second?second:first);
    if(name==="settings.status")return {...base(selected),profile:{...read.profile,projectId:"Viewed"},viewOnly:true,chatProjectRoot:second};
    if(name==="settings.select_profile"){selected=args.projectRoot;return {...base(selected),profile:{...read.profile,projectId:selected===other?"Viewed":"Another"},viewOnly:true,chatProjectRoot:meta["1c-ai-core/projectRoot"]};}
    throw new Error(name);
  },{navigation:"project"});await ui.flush();
  await ui.context.selectProfile(other);assert.equal(ui.elements.get("profileTitle").textContent,"Viewed");
  ui.deliver({jsonrpc:"2.0",method:"ui/notifications/tool-input",params:{arguments:{projectRoot:second}}});
  await ui.context.selectProfile(third);assert.equal(ui.calls.filter(call=>call.params?.name==="settings.select_profile").length,1);
  await ui.context.refreshStatus();assert.equal(ui.elements.get("profileTitle").textContent,"Viewed");
  await ui.context.selectProfile(third);assert.equal(ui.elements.get("profileTitle").textContent,"Another");
  const selections=ui.calls.filter(call=>call.params?.name==="settings.select_profile");assert.equal(selections[1].params._meta["1c-ai-core/projectRoot"],second);
});

test("the full settings workspace requires a manual choice when several history entries exist", async () => {
  const ui=screen(async(name,args)=>{
    if(name==="settings.read")return {...read,values:{projectRoot:""},profile:{status:"unselected"},schema:{},profileHistory:[{projectRoot:"C:/gone",status:"unavailable"},{projectRoot:read.values.projectRoot,status:"loaded"}]};
    assert.equal(name,"settings.select_profile");assert.equal(args.projectRoot,read.values.projectRoot);return read;
  });await ui.flush();
  assert.equal(ui.elements.get("profileBrowser").hidden,false);assert.equal(ui.calls.filter(call=>call.params?.name==="settings.select_profile").length,0);
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.pick_directory").length,0);
});

test("scoped connection edits show the destination and preserve higher-priority source information", async () => {
  const current = { ...read, values: { ...read.values, edtUrl: "http://local/mcp" }, settingsRevision: "rev1",
    connectionSources: { edt: "project_local" }, layerValues: { profile: { edtUrl: "http://old-profile/mcp" } }, writePaths: { profile: "C:/project/.ai/project.yaml", project_local: "C:/project/.ai/project.local.yaml" } };
  let saved;
  const ui = screen(async (name, args) => {
    if (["settings.read", "settings.status"].includes(name)) return current;
    if (name === "settings.update") { saved = args; current.layerValues.profile.edtUrl = args.set.edtUrl; return { savedTo: current.writePaths.profile }; }
    throw new Error(name);
  }); await ui.flush();
  ui.elements.get("connectionScope").value = "profile"; ui.elements.get("connectionScope").events.change();
  assert.match(ui.elements.get("connectionDestination").textContent, /project.yaml/);
  assert.match(ui.elements.get("connectionScopeHint").textContent, /приоритетный/);
  assert.equal(ui.elements.get("edtUrl").value, "");assert.equal(ui.elements.get("edtUrl").placeholder,"http://local/mcp");
  assert.match(ui.elements.get("edtSource").textContent, /Действует: http:\/\/local/);
  const field = ui.elements.get("edtUrl"); field.value = "http://project/mcp"; field.events.input();
  await ui.elements.get("saveButton").onclick();
  assert.equal(saved.scope, "profile"); assert.equal(saved.expectedRevision, "rev1"); assert.equal(saved.set.edtUrl, "http://project/mcp");
  assert.equal(field.value, "");assert.equal(field.placeholder,"http://local/mcp");assert.equal(current.layerValues.profile.edtUrl,"http://project/mcp");
});

test("connection scope defaults follow only the fields of the opened server", async () => {
  const current={...read,values:{...read.values,edtUrl:"http://shared/mcp",v8stdUrl:"",openvikingTimeout:25},
    connectionSources:{edt:"profile",v8std:"project_local",openviking:"profile"},valueSources:{openvikingEnabled:"profile",openvikingTimeout:"project_local"},
    layerValues:{profile:{edtUrl:"http://shared/mcp",v8stdUrl:"http://shared-v8/mcp",openvikingTimeout:30},project_local:{v8stdUrl:"",openvikingTimeout:25}}};
  const ui=screen(async()=>current);await ui.flush();
  for(const [id,scope]of [["edt","profile"],["v8std","project_local"],["openviking","project_local"]]){
    ui.context.openConnectionDialog(ui.context.catalogItems(current).find(item=>item.id===id),null);
    assert.equal(ui.elements.get("connectionScope").value,scope,id);
    assert.equal(ui.elements.get(scope==="profile"?"connectionSharedButton":"connectionLocalButton").attributes["aria-pressed"],"true");
    assert.equal(ui.elements.get("connectionScopeHint").textContent,"",id+" ignores other servers' sources");
    ui.elements.get("componentDialog").close();
  }
  assert.equal(ui.elements.get("v8stdUrl").value,"");
});

test("inherited URLs can be edited from their displayed value without saving unchanged hints", async () => {
  const shared="http://shared/mcp",local="http://local/mcp",updates=[];
  const current={...read,instance:"first",values:{...read.values,edtUrl:shared},connectionSources:{edt:"profile"},
    layerValues:{profile:{edtUrl:shared},project_local:{}},writePaths:{profile:"C:/project/.ai/project.yaml",project_local:"C:/project/.ai/project.local.yaml"}};
  let probed;
  const ui=screen(async(name,args)=>{
    if(["settings.read","settings.status"].includes(name))return current;
    if(name==="settings.update"){
      updates.push(args);Object.assign(current.layerValues[args.scope],args.set);
      for(const field of args.unset||[])delete current.layerValues[args.scope][field];
      const scope=Object.hasOwn(current.layerValues.project_local,"edtUrl")?"project_local":"profile";
      current.values.edtUrl=current.layerValues[scope].edtUrl;current.connectionSources.edt=scope;return {savedTo:current.writePaths[args.scope]};
    }
    if(name==="settings.probe_connections"){probed=args.connections.edt;return {id:"hint-probe",status:"running"};}
    if(name==="settings.operation")return {id:"hint-probe",action:"probe",component:"edt",projectRoot:current.values.projectRoot,instance:"first",status:"completed",result:{external:{}}};
    throw new Error(name);
  });await ui.flush();ui.context.openConnectionDialog(ui.context.catalogItems(current).find(item=>item.id==="edt"),null);
  const field=ui.elements.get("edtUrl");assert.equal(field.value,shared);
  ui.elements.get("connectionLocalButton").focus();ui.elements.get("connectionLocalButton").onclick();assert.equal(field.value,"");assert.equal(field.placeholder,shared);assert.equal(field.attributes["data-inherited"],"true");assert.equal(ui.elements.get("saveButton").disabled,true);
  await ui.elements.get("probeButton").onclick();assert.equal(probed,shared);assert.equal(updates.length,0);
  field.focus();field.events.focus();assert.equal(field.value,shared);assert.equal(ui.elements.get("saveButton").disabled,true);
  field.value=shared.replace("shared","temporary");field.events.input();assert.equal(ui.elements.get("saveButton").disabled,false);assert.equal(field.attributes["data-inherited"],"false");
  field.value=shared;field.events.input();assert.equal(ui.elements.get("saveButton").disabled,false);assert.equal(field.attributes["data-inherited"],"false");
  ui.context.renderCurrent(current,{preserveDraft:true});assert.equal(field.value,shared,"refresh keeps the explicitly edited value while focused");
  field.value="";field.events.input();assert.equal(ui.elements.get("saveButton").disabled,true);assert.equal(field.value,"");
  ui.context.renderCurrent(current,{preserveDraft:true});assert.equal(field.value,"","refresh must not refill a field while the user is replacing its inherited value");
  ui.elements.get("connectionLocalButton").focus();field.events.blur();assert.equal(field.value,"");assert.equal(field.placeholder,shared);
  field.focus();field.events.focus();assert.equal(field.value,shared);
  field.value=local;field.events.input();await ui.elements.get("saveButton").onclick();
  assert.equal(updates.length,1);assert.equal(updates[0].scope,"project_local");assert.equal(updates[0].set.edtUrl,local);assert.equal(field.value,local);
  ui.elements.get("connectionSharedButton").focus();ui.elements.get("connectionSharedButton").onclick();assert.equal(current.layerValues.profile.edtUrl,shared);assert.equal(field.value,"");assert.equal(field.placeholder,local);
  field.value="http://draft/mcp";field.events.input();ui.context.renderCurrent(current,{preserveDraft:true});assert.equal(field.value,"http://draft/mcp");
  ui.elements.get("componentDiscard").onclick();assert.equal(field.value,"");assert.equal(field.placeholder,local);
  ui.elements.get("connectionLocalButton").focus();ui.elements.get("connectionLocalButton").onclick();field.value="";field.events.input();await ui.elements.get("saveButton").onclick();
  assert.deepEqual(Array.from(updates.at(-1).unset),["edtUrl"]);assert.equal(updates.at(-1).set.edtUrl,undefined);
  assert.equal(current.values.edtUrl,shared);assert.equal(field.value,"");assert.equal(field.placeholder,shared);assert.equal(ui.elements.get("saveButton").disabled,true);
  ui.elements.get("connectionSharedButton").onclick();assert.equal(field.value,shared);
});

test("detected EDT saving responds immediately to clearing, blurring and refocusing the field", async () => {
  const detected="http://127.0.0.1:8765/mcp",current={...read,instance:"first",settingsRevision:"saved",
    values:{...read.values,edtUrl:detected},connectionSources:{edt:"edt_workspace"},layerValues:{profile:{},project_local:{}}};
  const ui=screen(async name=>{if(["settings.read","settings.status"].includes(name))return current;throw new Error(name);});
  await ui.flush();ui.context.openConnectionDialog(ui.context.catalogItems(current).find(item=>item.id==="edt"),null);
  const field=ui.elements.get("edtUrl"),save=ui.elements.get("saveButton"),source=ui.elements.get("edtSource");
  assert.equal(save.disabled,false);
  field.value="";field.events.input();assert.equal(save.disabled,true);
  ui.elements.get("connectionSharedButton").focus();field.events.blur();
  assert.equal(save.disabled,false,"leaving the empty inherited field restores explicit saving without a timer");
  assert.match(source.textContent,/«Сохранить» запишет обнаруженный адрес/);
  field.focus();field.events.focus();assert.equal(field.value,detected);assert.equal(save.disabled,false);
  assert.equal(ui.elements.get("componentDiscard").hidden,true);
  assert.equal(ui.elements.get("unsavedHint").hidden,true);
  assert.equal(ui.calls.some(call=>call.params?.name==="settings.update"),false);
});

test("inherited OpenViking fields preserve record identity and numeric probe values", async () => {
  const url="https://knowledge.example/mcp",current={...read,instance:"first",values:{...read.values,openvikingEnabled:true,openvikingUrl:url,openvikingTimeout:30,openvikingMaxResponseBytes:4096,openvikingConnectionId:"team"},
    connectionSources:{openviking:"profile"},valueSources:{openvikingEnabled:"profile",openvikingTimeout:"project_local",openvikingMaxResponseBytes:"settings",openvikingConnectionId:"settings"},
    layerValues:{profile:{openvikingEnabled:true,openvikingUrl:url,openvikingTimeout:20},project_local:{openvikingTimeout:30}}};
  let probed;
  const ui=screen(async(name,args)=>{
    if(["settings.read","settings.status"].includes(name))return current;
    if(name==="settings.openviking_read")return {revision:"record",values:{}};
    if(name==="settings.probe_connections"){probed=args;return {id:"ov-hint-probe",status:"running"};}
    if(name==="settings.operation")return {id:"ov-hint-probe",action:"probe",component:"openviking",projectRoot:current.values.projectRoot,instance:"first",status:"completed",result:{external:{}}};
    throw new Error(name);
  });await ui.flush();ui.context.openConnectionDialog(ui.context.catalogItems(current).find(item=>item.id==="openviking"),null);
  assert.equal(ui.elements.get("openvikingUrl").value,"");assert.equal(ui.elements.get("openvikingUrl").placeholder,url);
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext("ovIdentity()",ui.context))),{url,connectionId:"team"});
  ui.elements.get("connectionSharedButton").onclick();
  const timeout=ui.elements.get("openvikingTimeout");assert.equal(timeout.value,"");assert.equal(timeout.placeholder,"30");timeout.focus();timeout.events.focus();assert.equal(timeout.value,"30");assert.equal(timeout.attributes["data-inherited"],"true");
  assert.equal(vm.runInContext('transportValue("openvikingMaxResponseBytes")',ui.context),4096);
  await ui.elements.get("probeButton").onclick();assert.equal(probed.connections,undefined);
  timeout.value="31";timeout.events.input();assert.equal(timeout.attributes["data-inherited"],"false");await ui.elements.get("probeButton").onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(probed.connections.openviking)),{timeout_seconds:31});
  timeout.value="30";timeout.events.input();assert.equal(ui.elements.get("saveButton").disabled,false);assert.equal(timeout.attributes["data-inherited"],"false");
  ui.elements.get("componentDiscard").onclick();assert.equal(ui.elements.get("saveButton").disabled,true);
  ui.elements.get("probeButton").focus();timeout.events.blur();assert.equal(timeout.value,"");assert.equal(timeout.placeholder,"30");
});

test("Java checks use the inherited executable while selected paths become editable drafts", async () => {
  const java="C:/LocalJava/bin/java.exe",picked="C:/PickedJava/bin/java.exe",current={...read,instance:"first",values:{...read.values,bslLsJava:java},managedValueSources:{bslLsJava:"project_local"},
    layerValues:{profile:{bslLsJava:"old-java"},project_local:{bslLsJava:java},global:{bslLsJava:"java"}}};
  let command,action,chosen=java;
  const ui=screen(async(name,args)=>{
    if(["settings.read","settings.status"].includes(name))return current;
    if(name==="settings.check_java"){command=args.command;action="check_java";return {id:"java-hint",status:"running"};}
    if(name==="settings.pick_java"){action="pick_java";return {id:"java-hint",status:"running"};}
    if(name==="settings.operation")return {id:"java-hint",action,projectRoot:current.values.projectRoot,instance:"first",status:"completed",result:{path:action==="pick_java"?chosen:java,version:"21"}};
    throw new Error(name);
  });await ui.flush();ui.elements.get("javaSharedButton").onclick();
  const field=ui.elements.get("bslLsJava");assert.equal(field.value,"");assert.equal(field.placeholder,java);field.focus();field.events.focus();assert.equal(field.value,java);assert.equal(field.attributes["data-inherited"],"true");
  await ui.elements.get("checkJavaButton").onclick();assert.equal(command,java);assert.equal(ui.elements.get("saveJavaButton").disabled,true);
  field.value=java.replace("LocalJava","ProjectJava");field.events.input();assert.equal(field.attributes["data-inherited"],"false");assert.equal(ui.elements.get("saveJavaButton").disabled,false);
  field.value=java;field.events.input();assert.equal(field.attributes["data-inherited"],"false");assert.equal(ui.elements.get("saveJavaButton").disabled,false);
  await ui.elements.get("pickJavaButton").onclick();assert.equal(field.value,java);assert.equal(ui.elements.get("saveJavaButton").disabled,false,"explicitly choosing the inherited Java path can create an override");
  field.events.input();assert.equal(ui.elements.get("saveJavaButton").disabled,false);chosen=picked;
  await ui.elements.get("pickJavaButton").onclick();assert.equal(field.value,picked);assert.equal(ui.elements.get("saveJavaButton").disabled,false);
});

test("managed scope defaults separate enablement, versions and Java", async () => {
  const current={...read,values:{...read.values,codeIndexEnabled:true,bslLsEnabled:false,bslLsJava:"java"},
    managedValueSources:{codeIndexEnabled:"profile",codeIndexVersion:"project_local",bslLsEnabled:"project_local",bslLsJava:"settings"},
    layerValues:{profile:{codeIndexEnabled:true,bslLsEnabled:true},project_local:{codeIndexVersion:"v1.2.3",bslLsEnabled:false},global:{bslLsJava:"java"}}};
  const ui=screen(async(name,args)=>name==="settings.versions"?{component:args.component,versions:[{version:"v1.2.3"}]}:current);await ui.flush();
  const open=id=>ui.context.openManagedDialog(ui.context.catalogItems(current).find(item=>item.id===id),null);
  open("code-index");assert.equal(ui.elements.get("componentScope").value,"profile");ui.elements.get("managedDialog").close();
  open("bsl-ls");assert.equal(ui.elements.get("componentScope").value,"project_local");assert.equal(ui.elements.get("bslLsEnabled").checked,false);
  assert.equal(ui.elements.get("javaScope").value,"global");assert.equal(ui.elements.get("javaGlobalButton").attributes["aria-pressed"],"true");
  ui.elements.get("managedDialog").close();
  for(const source of ["profile","project_local"]){
    current.managedValueSources.bslLsJava=source;open("bsl-ls");assert.equal(ui.elements.get("javaScope").value,source);ui.elements.get("managedDialog").close();
  }
});

test("document scope defaults include all local YAML settings and respect each testing dialog", async () => {
  const backend=new SettingsBackend("unused-state","unused-settings"),current={...read,localOverridePaths:[["project","purpose"],["testing","yaxunit"]]};
  const ui=screen(async(name,args)=>{
    if(["settings.read","settings.status"].includes(name))return current;
    if(name==="settings.edit")return {text:"testing:\n  yaxunit: false\n  vanessa: false\n",format:"yaml",baseRevision:"base",layerScope:args.layerScope};
    if(name==="settings.document_fields")return backend.main({action:"document_fields",...args});
    throw new Error(name);
  });await ui.flush();
  ui.context.show("editor");await ui.flush();await ui.flush();
  assert.equal(ui.elements.get("editorDocument").value,"project_local");
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.edit").at(-1).params.arguments.layerScope,"project_local");
  await ui.context.openTestingSettings("yaxunit",null);assert.equal(ui.elements.get("editorDocument").value,"project_local");ui.elements.get("testingDialog").close();
  await ui.context.openTestingSettings("vanessa",null);assert.equal(ui.elements.get("editorDocument").value,"profile");ui.elements.get("testingDialog").close();
  current.localOverridePaths.push(["testing","commands"]);
  await ui.context.openTestingSettings("vanessa",null);assert.equal(ui.elements.get("editorDocument").value,"project_local");ui.elements.get("testingDialog").close();
  current.localOverridePaths=[];
  ui.context.show("editor");await ui.flush();assert.equal(ui.elements.get("editorDocument").value,"profile");
});

test("manual scope choices and drafts survive refresh while another project gets its own defaults", async () => {
  const current={...read,instance:"first",connectionSources:{edt:"profile"},managedValueSources:{bslLsJava:"profile"},values:{...read.values,edtUrl:"http://shared/mcp",bslLsJava:"project-java"}};
  const ui=screen(async()=>current);await ui.flush();
  assert.equal(ui.elements.get("connectionScope").value,"profile");
  ui.elements.get("connectionLocalButton").onclick();ui.elements.get("javaGlobalButton").onclick();
  ui.context.renderCurrent(current,{preserveDraft:true});
  assert.equal(ui.elements.get("connectionScope").value,"project_local");assert.equal(ui.elements.get("javaScope").value,"global");
  const field=ui.elements.get("edtUrl");field.value="http://draft/mcp";field.events.input();
  ui.context.renderCurrent(current,{preserveDraft:true});assert.equal(field.value,"http://draft/mcp");assert.equal(ui.elements.get("connectionScope").value,"project_local");
  ui.elements.get("discardDraftButton").onclick();
  ui.context.renderCurrent({...current,values:{...current.values,projectRoot:"C:/another"}});
  assert.equal(ui.elements.get("connectionScope").value,"profile");assert.equal(ui.elements.get("javaScope").value,"profile");
  ui.context.renderCurrent({...current,instance:"second",connectionSources:{edt:"project_local"},managedValueSources:{bslLsJava:"settings"}});
  assert.equal(ui.elements.get("connectionScope").value,"project_local");assert.equal(ui.elements.get("javaScope").value,"global");
});

test("scoped panels keep accessible segments and a single save action", () => {
  assert.doesNotMatch(html, /Изменять в/);
  for (const [scope, save, start, end] of [["connectionScope", "saveButton", '<section id="connectionTransportPanel"', "</section>"], ["componentScope", "saveComponentsButton", '<section id="managedOptionsPanel"', "</section>"], ["javaScope", "saveJavaButton", '<div id="javaSettingsPanel"', '<section id="versionSettingsPanel"']]) {
    const from=html.indexOf(start),toolbar=html.slice(from,html.indexOf(end,from));
    assert.ok(toolbar.includes(`id="${save}"`), `${scope} and its save action should share a panel`);
    assert.equal(toolbar.split(`id="${save}"`).length-1,1);
    assert.match(toolbar, /role="group" aria-label="[^"]+" aria-describedby="[^"]+"/);
    assert.match(toolbar, />Общий · Git<\/button>/);
    assert.match(toolbar, />Локальный<\/button>/);
    assert.match(toolbar, new RegExp(`<select id="${scope}" hidden`));
  }
  const editor = html.match(/<select id="editorDocument"[^>]*>([\s\S]*?)<\/select>/)?.[1];
  assert.ok(editor);
  assert.deepEqual([...editor.matchAll(/<option value="([^"]+)"[^>]*>([^<]+)<\/option>/g)].map(match => [match[1], match[2]]), [
    ["project_local", "Локальные настройки проекта"], ["profile", "Профиль проекта"],
  ]);
});

test("project scopes keep drafts isolated and save through the real MCP", async t => {
  const f=fixture(t);f.save();const client=await session(t,"mcp/settings.mjs",[],f);
  await client.call("settings.update",{scope:"profile",set:{edtUrl:"http://localhost:8111/mcp"}});
  await client.call("settings.update",{scope:"project_local",set:{edtUrl:"http://localhost:8222/mcp"}});
  const ui=screen((name,args,meta)=>client.request("tools/call",{name,arguments:args,...(meta?{_meta:meta}:{})}),{navigation:"project",rawResults:true});ui.document.hidden=true;
  const until=async predicate=>{const end=Date.now()+10000;while(!predicate()){if(Date.now()>end)throw new Error("Timed out waiting for project scope");await new Promise(resolve=>setTimeout(resolve,20));}};
  await until(()=>ui.elements.get("edtUrl").value==="http://localhost:8222/mcp");
  assert.equal(ui.elements.get("connectionLocalButton").attributes["aria-pressed"],"true");
  ui.elements.get("connectionSharedButton").onclick();
  assert.equal(ui.elements.get("connectionSharedButton").attributes["aria-pressed"],"true");
  assert.equal(ui.elements.get("connectionLocalButton").attributes["aria-pressed"],"false");
  assert.equal(ui.elements.get("edtUrl").value,"");assert.equal(ui.elements.get("edtUrl").placeholder,"http://localhost:8222/mcp");assert.match(ui.elements.get("edtSource").textContent,/приоритет выше/);
  ui.elements.get("edtUrl").value="http://localhost:8333/mcp";ui.elements.get("edtUrl").events.input();
  ui.elements.get("connectionSharedButton").onclick();
  ui.elements.get("connectionLocalButton").onclick();assert.equal(ui.elements.get("connectionScope").value,"profile");
  assert.equal(ui.elements.get("connectionSharedButton").attributes["aria-pressed"],"true");
  assert.equal(ui.elements.get("connectionLocalButton").attributes["aria-pressed"],"false");
  await ui.elements.get("saveButton").onclick();assert.equal(load(path.join(f.root,".ai/project.yaml")).connections.edt.url,"http://localhost:8333/mcp");
  assert.equal(load(path.join(f.root,".ai/project.local.yaml")).connections.edt.url,"http://localhost:8222/mcp");
  ui.elements.get("connectionLocalButton").onclick();
  assert.equal(ui.elements.get("edtUrl").value,"http://localhost:8222/mcp");
  assert.equal(ui.elements.get("connectionLocalButton").attributes["aria-pressed"],"true");ui.lifecycle.pagehide();
});

test("component card input, save, clear and scope events restore inheritance through the real MCP", async t => {
  const f=fixture(t);
  f.profile.connections={edt:{url:"http://localhost:18191/mcp"},v8std:{url:"http://localhost:18192/mcp"},
    openviking:{enabled:true,url:"http://localhost:18193/mcp",timeout_seconds:30,max_response_bytes:4096,connection_id:"shared"}};
  f.profile.components={...f.profile.components,"bsl-ls":{...f.profile.components?.["bsl-ls"],java:"shared-java"}};f.save();
  const sharedFile=path.join(f.root,".ai/project.yaml"),localFile=path.join(f.root,".ai/project.local.yaml"),original=fs.readFileSync(sharedFile);
  const client=await session(t,"mcp/settings.mjs",[],f);
  const ui=screen((name,args,meta)=>name==="settings.versions"?{structuredContent:{component:args.component,versions:[]}}
    :client.request("tools/call",{name,arguments:args,...(meta?{_meta:meta}:{})}),{navigation:"project",rawResults:true});ui.document.hidden=true;
  const until=async predicate=>{const end=Date.now()+10000;while(!predicate()){if(Date.now()>end)throw new Error("Timed out waiting for card events: "+ui.elements.get("status").textContent);await new Promise(resolve=>setTimeout(resolve,20));}};
  await until(()=>ui.elements.get("edtUrl").value===f.profile.connections.edt.url&&!vm.runInContext("initializing",ui.context));
  const item=id=>vm.runInContext(`catalogItems(currentData).find(item=>item.id===${JSON.stringify(id)})`,ui.context);
  const edit=(id,value)=>{const field=ui.elements.get(id);field.value=String(value);field.events.input();};
  for(const [id,fields]of [["edt",[["edtUrl","url","http://localhost:18291/mcp"]]],["v8std",[["v8stdUrl","url","http://localhost:18292/mcp"]]],
    ["openviking",[["openvikingUrl","url","http://localhost:18293/mcp"],["openvikingTimeout","timeout_seconds",45],["openvikingMaxResponseBytes","max_response_bytes",8192],["openvikingConnectionId","connection_id","local"]]]]){
    ui.context.openConnectionDialog(item(id),null);ui.elements.get("connectionLocalButton").focus();ui.elements.get("connectionLocalButton").onclick();
    for(const [field,member,value]of fields){assert.equal(ui.elements.get(field).value,"");assert.equal(ui.elements.get(field).placeholder,String(f.profile.connections[id][member]));edit(field,value);}
    assert.equal(ui.elements.get("saveButton").disabled,false);
    ui.elements.get("connectionSharedButton").onclick();assert.equal(ui.elements.get("connectionScope").value,"project_local","a draft must block scope switching");
    await ui.elements.get("saveButton").onclick();
    for(const [field,member,value]of fields){assert.equal(load(localFile).connections[id][member],value);assert.equal(ui.elements.get(field).value,String(value));edit(field,"");}
    assert.equal(ui.elements.get("saveButton").disabled,false);await ui.elements.get("saveButton").onclick();
    const update=ui.calls.filter(call=>call.params?.name==="settings.update").at(-1).params.arguments;
    assert.equal(Object.keys(update.set).length,0);assert.deepEqual(Array.from(update.unset),fields.map(([field])=>field));
    for(const [field,member]of fields){assert.equal(load(localFile).connections?.[id]?.[member],undefined);assert.equal(ui.elements.get(field).value,"");assert.equal(ui.elements.get(field).placeholder,String(f.profile.connections[id][member]));}
    assert.equal(ui.elements.get("saveButton").disabled,true);assert.deepEqual(fs.readFileSync(sharedFile),original);
    ui.elements.get("connectionSharedButton").focus();ui.elements.get("connectionSharedButton").onclick();
    for(const [field,member]of fields)assert.equal(ui.elements.get(field).value,String(f.profile.connections[id][member]));
    ui.elements.get("componentDialog").close();
  }
  ui.context.openManagedDialog(item("bsl-ls"),null);await ui.flush();
  const java=ui.elements.get("bslLsJava");ui.elements.get("javaLocalButton").onclick();assert.equal(java.placeholder,"shared-java");
  edit("bslLsJava","local-java");await ui.elements.get("saveJavaButton").onclick();assert.equal(java.value,"local-java");
  edit("bslLsJava","");await ui.elements.get("saveJavaButton").onclick();
  assert.equal(load(localFile).components?.["bsl-ls"]?.java,undefined);assert.equal(java.value,"");assert.equal(java.placeholder,"shared-java");
  ui.elements.get("javaSharedButton").onclick();assert.equal(java.value,"shared-java");
  edit("bslLsJava","");await ui.elements.get("saveJavaButton").onclick();
  assert.equal(load(sharedFile).components?.["bsl-ls"]?.java,undefined);assert.equal(java.placeholder,"java");
  ui.elements.get("javaGlobalButton").onclick();assert.equal(java.value,"java");
  edit("bslLsJava","global-java");await ui.elements.get("saveJavaButton").onclick();assert.equal(java.value,"global-java");
  edit("bslLsJava","");await ui.elements.get("saveJavaButton").onclick();assert.equal(java.value,"java");
  assert.equal(load(f.env.EDT_AI_SETTINGS).mcp.managed["bsl-ls"].java,undefined);assert.equal(ui.elements.get("saveJavaButton").disabled,true);
  ui.lifecycle.pagehide();
});

test("component reset stages only its local overrides and restores booleans through the real MCP", async t => {
  const f=fixture(t);f.profile.components={"code-index":{enabled:true},"bsl-ls":{enabled:true}};
  f.profile.connections={openviking:{enabled:false,url:"http://localhost:18393/mcp"}};f.save();
  const sharedFile=path.join(f.root,".ai/project.yaml"),original=fs.readFileSync(sharedFile),localFile=path.join(f.root,".ai/project.local.yaml");
  const client=await session(t,"mcp/settings.mjs",[],f);
  await client.call("settings.update",{scope:"project_local",set:{codeIndexEnabled:false,bslLsEnabled:false,openvikingEnabled:true,openvikingTimeout:45}});
  const ui=screen((name,args,meta)=>name==="settings.versions"?{structuredContent:{versions:[]}}:client.request("tools/call",{name,arguments:args,_meta:meta}),{navigation:"project",rawResults:true});ui.document.hidden=true;
  const deadline=Date.now()+10000;while(!vm.runInContext("currentData&&!initializing",ui.context)){assert.ok(Date.now()<deadline,ui.elements.get("status").textContent);await new Promise(resolve=>setTimeout(resolve,20));}
  const item=id=>ui.context.catalogItems(vm.runInContext("currentData",ui.context)).find(item=>item.id===id);
  ui.context.openManagedDialog(item("code-index"),null);await ui.flush();
  assert.equal(ui.elements.get("componentScope").value,"project_local");assert.equal(ui.elements.get("resetComponentsButton").hidden,false);
  ui.elements.get("resetComponentsButton").onclick();
  assert.equal(load(localFile).components["code-index"].enabled,false,"reset must remain a draft until save");
  assert.equal(ui.elements.get("codeIndexEnabled").indeterminate,true);assert.match(ui.elements.get("codeIndexEnabledSource").textContent,/после сохранения/);
  await ui.elements.get("saveComponentsButton").onclick();
  const update=ui.calls.filter(call=>call.params?.name==="settings.update").at(-1).params.arguments;
  assert.deepEqual(Array.from(update.unset),["codeIndexEnabled"]);assert.equal(Object.keys(update.set).length,0);
  assert.equal(load(localFile).components?.["code-index"]?.enabled,undefined);assert.equal(load(localFile).components["bsl-ls"].enabled,false);
  assert.equal(ui.elements.get("codeIndexEnabled").checked,true);assert.equal(ui.elements.get("codeIndexEnabled").indeterminate,false);assert.equal(ui.elements.get("saveComponentsButton").disabled,true);
  ui.elements.get("managedDialog").close();ui.context.openConnectionDialog(item("openviking"),null);
  ui.elements.get("resetConnectionButton").onclick();assert.equal(ui.elements.get("probeButton").disabled,true,"unresolved inheritance must be saved before probing a draft");
  await ui.elements.get("saveButton").onclick();
  assert.equal(load(localFile).connections?.openviking?.enabled,undefined);assert.equal(load(localFile).connections?.openviking?.timeout_seconds,undefined);
  assert.equal(load(localFile).components["bsl-ls"].enabled,false);assert.equal(ui.elements.get("openvikingEnabled").checked,false);assert.deepEqual(fs.readFileSync(sharedFile),original);
  ui.lifecycle.pagehide();
});

test("managed cancellation clears a staged reset while preserving connection and YAML drafts",async()=>{
  const current={...read,values:{...read.values,codeIndexEnabled:false,v8stdUrl:"http://saved/mcp"},managedValueSources:{codeIndexEnabled:"project_local"},layerValues:{profile:{codeIndexEnabled:true},project_local:{codeIndexEnabled:false}}};
  const ui=screen(async name=>name==="settings.versions"?{versions:[]}:current);await ui.flush();
  ui.context.openManagedDialog(ui.context.catalogItems(current).find(item=>item.id==="code-index"),null);
  assert.equal(ui.elements.get("componentScope").value,"project_local");
  const connection=ui.elements.get("v8stdUrl");connection.value="http://draft/mcp";connection.events.input();
  ui.elements.get("settingsText").value="# unrelated YAML draft\n";ui.elements.get("settingsText").events.input();
  ui.elements.get("resetComponentsButton").onclick();assert.equal(ui.elements.get("codeIndexEnabled").indeterminate,true);
  ui.elements.get("managedDiscardButton").onclick();
  assert.equal(ui.elements.get("codeIndexEnabled").checked,false);assert.equal(ui.elements.get("codeIndexEnabled").indeterminate,false);assert.equal(ui.elements.get("saveComponentsButton").disabled,true);
  assert.equal(connection.value,"http://draft/mcp");assert.equal(ui.elements.get("settingsText").value,"# unrelated YAML draft\n");
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.update").length,0);
});

test("catalog grids follow the three plus two plus two grouping and header refresh checks all components",async()=>{
  const f=liveStatusScreen();await f.ui.flush();
  const groups=f.ui.elements.get("componentCatalog").children;
  assert.deepEqual(groups.map(group=>group.children[1].children.length),[3,2,2]);
  assert.deepEqual(groups.map(group=>group.children[1].className),["catalog-grid","catalog-grid two","catalog-grid two"]);
  assert.equal(f.ui.elements.get("headerProjectName").textContent,f.current.profile.projectId);assert.equal(f.ui.elements.get("headerProjectPath").textContent,f.current.values.projectRoot);
  const requests=f.requests.length;await f.ui.elements.get("headerRefresh").onclick();
  assert.equal(f.requests.length,requests+1);assert.equal(f.requests.at(-1).name,"settings.refresh_readiness");assert.equal(f.requests.at(-1).component,undefined);
  assert.equal(f.ui.calls.filter(call=>["settings.run_check","settings.updates","settings.update"].includes(call.params?.name)).length,0);
});

test("environment URLs remain read-only and explain the higher-priority source", async () => {
  const current = { ...read, values: { ...read.values, edtUrl: "http://env/mcp" },
    connectionSources: { edt: "environment:EDT_AI_EDT_URL" },
    layerValues: { profile: { edtUrl: "http://profile/mcp" }, instance: {} },
    schema: { properties: { edtUrl: { readOnly: true } } } };
  const ui = screen(async name => { if (["settings.read", "settings.status"].includes(name)) return current; throw new Error(name); });
  await ui.flush();
  ui.elements.get("connectionScope").value = "profile"; ui.elements.get("connectionScope").events.change();
  assert.equal(ui.elements.get("edtUrl").value, "");assert.equal(ui.elements.get("edtUrl").placeholder,"http://env/mcp");
  assert.equal(ui.elements.get("edtUrl").readOnly, true);
  ui.elements.get("edtUrl").focus();ui.elements.get("edtUrl").events.focus();assert.equal(ui.elements.get("edtUrl").value, "");
  assert.match(ui.elements.get("edtSource").textContent, /Действует: http:\/\/env\/mcp — переменная окружения EDT_AI_EDT_URL.*приоритет выше/);
});

test("rename guards other profile selection and refreshes the displayed project id", async () => {
  let current = { ...read, settingsRevision: "rename-revision" }, changed;
  const ui = screen(async (name, args) => {
    if (["settings.read", "settings.status"].includes(name)) return current;
    if (name === "settings.rename_profile") { changed = args; current = { ...current, profile: { ...current.profile, projectId: args.projectId } }; return { detail: "Разрешения Vanessa потребуется получить заново." }; }
    throw new Error(name);
  }); await ui.flush();
  ui.elements.get("renameButton").onclick();
  ui.elements.get("projectIdInput").value = "New.Name"; ui.elements.get("projectIdInput").events.input();
  await ui.context.selectProfile("C:/other");
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.select_profile").length, 0);
  await ui.elements.get("renameSaveButton").onclick();
  assert.equal(changed.projectId, "New.Name"); assert.equal(changed.expectedRevision, "rename-revision");
  assert.deepEqual(Object.keys(changed).sort(), ["expectedRevision", "projectId"]);
  assert.equal(ui.elements.get("profileTitle").textContent, "New.Name");
  assert.equal(ui.elements.get("headerProjectName").textContent, "New.Name");
  assert.match(ui.elements.get("status").textContent, /Vanessa/);
});

test("Java selection checks the chosen executable and saves only after an explicit action", async () => {
  let current = { ...read, instance: "first", values: { ...read.values, bslLsJava: "java" }, settingsRevision: "java-revision",
    writePaths: { instance: "C:/state/first.yaml", project_local: "C:/project/.ai/project.local.yaml", global: "C:/state/settings.json" } }, saved;
  const ui = screen(async (name, args) => {
    if (["settings.read", "settings.status"].includes(name)) return current;
    if (name === "settings.pick_java") return { id: "java", status: "running" };
    if (name === "settings.operation") return { id: "java", status: "completed", action: "pick_java", projectRoot: read.values.projectRoot, instance: "first", result: { path: "C:/Java/bin/java.exe", version: "21.0.2" } };
    if (name === "settings.update") { saved = args; current = { ...current, values: { ...current.values, bslLsJava: args.set.bslLsJava } }; return { savedTo: current.writePaths[args.scope] }; }
    throw new Error(name);
  }); await ui.flush();
  ui.elements.get("javaLocalButton").onclick();
  assert.equal(ui.elements.get("javaLocalButton").attributes["aria-pressed"], "true");
  await ui.elements.get("pickJavaButton").onclick();
  assert.match(ui.elements.get("javaResult").textContent, /21\.0\.2/);
  assert.equal(saved, undefined); assert.equal(ui.elements.get("saveJavaButton").disabled, false);
  ui.elements.get("javaGlobalButton").onclick();
  assert.equal(ui.elements.get("javaLocalButton").attributes["aria-pressed"], "true");
  assert.equal(ui.elements.get("javaGlobalButton").attributes["aria-pressed"], "false");
  await ui.elements.get("saveJavaButton").onclick();
  assert.equal(saved.scope, "project_local"); assert.equal(saved.set.bslLsJava, "C:/Java/bin/java.exe");
  ui.elements.get("javaGlobalButton").onclick();
  assert.equal(ui.elements.get("javaGlobalButton").attributes["aria-pressed"], "true");
  assert.match(ui.elements.get("javaDestination").textContent, /settings\.json/);
  ui.elements.get("bslLsJava").value = "C:/SharedJava/bin/java.exe"; ui.elements.get("bslLsJava").events.input();
  await ui.elements.get("saveJavaButton").onclick();
  assert.equal(saved.scope, "global"); assert.equal(saved.set.bslLsJava, "C:/SharedJava/bin/java.exe");
});

test("Windows file import uses the native picker and previews its returned document", async () => {
  const current = { ...read, instance: "first", folderActions: { supported: true } }; let previewed;
  const ui = screen(async (name, args) => {
    if (["settings.read", "settings.status"].includes(name)) return current;
    if (name === "settings.pick_import_file") return { id: "picker", status: "running" };
    if (name === "settings.operation") return { id: "picker", status: "completed", action: "pick_import_file", projectRoot: read.values.projectRoot, instance: "first", result: { fileId: "chosen", filename: "profile.yaml" } };
    if (name === "settings.import_file") { assert.equal(args.fileId, "chosen"); return { scope: "profile", filename: "profile.yaml", text: "document" }; }
    if (name === "settings.transfer_context") return { baseRevision: "base" };
    if (name === "settings.transfer_preview") { previewed = args; return { projectRoot: read.values.projectRoot, files: [], revision: "preview" }; }
    throw new Error(name);
  }); await ui.flush();
  assert.equal(ui.elements.get("transferPath").hidden, true);
  await ui.elements.get("transferPick").onclick();
  assert.match(ui.elements.get("transferFilename").textContent, /profile.yaml/);
  await ui.elements.get("transferPreview").onclick();
  assert.equal(previewed.documents.profile, "document");
});

test("cancelled Save As does not report a saved settings or diagnostics file", async () => {
  const ui = screen(async name => {
    if (["settings.read", "settings.status"].includes(name)) return read;
    if (["settings.transfer_export", "settings.export_diagnostics"].includes(name)) return { cancelled: true };
    throw new Error(name);
  }); await ui.flush();
  ui.elements.get("diagnosticsSaved").hidden = true;
  await ui.elements.get("transferExport").onclick(); assert.match(ui.elements.get("status").textContent, /отменено/);
  await ui.elements.get("diagnosticsButton").onclick(); assert.equal(ui.elements.get("diagnosticsSaved").hidden, true);
  assert.match(ui.elements.get("status").textContent, /отменено/);
});

test("export hints explain the platform-specific destination", async () => {
  for (const supported of [true, false]) {
    const ui = screen(async name => {
      if (["settings.read", "settings.status"].includes(name)) return { ...read, folderActions: { supported } };
      throw new Error(name);
    });
    await ui.flush();
    assert.match(ui.elements.get("diagnosticsDestinationHint").textContent, supported ? /Выберите место/ : /каталоге состояния/);
    assert.equal(ui.elements.get("transferPath").hidden, supported);
    ui.lifecycle.pagehide();
  }
});

test("an external scope change retains a draft and blocks writes until it is discarded", async () => {
  const next = { ...read, values: { ...read.values, projectRoot: "C:/next", edtUrl: "http://next" }, profile: { ...read.profile, projectId: "Next" } };
  const first = { ...read, values: { ...read.values, edtUrl: "http://old" } }; let status = first;
  const ui = screen(async name => { if (name === "settings.read") return first; if (name === "settings.status") return status; throw new Error(name); }); await ui.flush();
  ui.elements.get("edtUrl").value = "http://draft"; ui.elements.get("edtUrl").events.input(); status = next;
  await ui.context.refreshStatus();
  assert.equal(ui.elements.get("edtUrl").value, "http://draft"); assert.equal(ui.elements.get("profileTitle").textContent, "Project");
  assert.equal(ui.elements.get("saveButton").disabled, true); assert.match(ui.elements.get("status").textContent, /Черновик/);
  let prevented = false; ui.lifecycle.beforeunload({ preventDefault() { prevented = true; } }); assert.equal(prevented, true);
  ui.elements.get("discardDraftButton").onclick();
  assert.equal(ui.elements.get("profileTitle").textContent, "Next"); assert.equal(ui.elements.get("edtUrl").value, "http://next");
});

test("background refresh cannot replace the revision on which a settings draft was based", async () => {
  let current = { ...read, settingsRevision: "before", values: { ...read.values, edtUrl: "http://old" } }, requested;
  const ui = screen(async (name, args) => {
    if (["settings.read", "settings.status"].includes(name)) return current;
    if (name === "settings.update") { requested = args; throw new Error("Настройки изменились после загрузки."); }
    throw new Error(name);
  }); await ui.flush();
  const field = ui.elements.get("edtUrl"); field.value = "http://draft"; field.events.input();
  current = { ...current, settingsRevision: "after", values: { ...current.values, edtUrl: "http://external" } };
  await ui.context.refreshStatus(); await ui.elements.get("saveButton").onclick();
  assert.equal(requested.expectedRevision, "before"); assert.equal(field.value, "http://draft");
  assert.match(ui.elements.get("status").textContent, /изменились/);
});

test("saving one group preserves other drafts and rebases them only to the confirmed revision", async () => {
  let current = { ...read, settingsRevision: "one", values: { ...read.values, edtUrl: "http://old", bslLsEnabled: false } }; const revisions = [], scopes = [];
  const ui = screen(async (name, args) => {
    if (["settings.read", "settings.status"].includes(name)) return current;
    if (name === "settings.update") { revisions.push(args.expectedRevision); scopes.push(args.scope); current = { ...current, settingsRevision: revisions.length === 1 ? "two" : "three", values: { ...current.values, ...args.set } }; return { settingsRevision: current.settingsRevision }; }
    throw new Error(name);
  }); await ui.flush();
  const url = ui.elements.get("edtUrl"), enabled = ui.elements.get("bslLsEnabled");
  ui.elements.get("componentLocalButton").onclick();
  assert.equal(ui.elements.get("componentLocalButton").attributes["aria-pressed"], "true");
  url.value = "http://draft"; url.events.input(); enabled.checked = true; enabled.events.change();
  ui.elements.get("componentSharedButton").onclick();
  assert.equal(enabled.checked, true); assert.equal(ui.elements.get("componentLocalButton").attributes["aria-pressed"], "true");
  await ui.elements.get("saveButton").onclick(); assert.equal(enabled.checked, true);
  await ui.elements.get("saveComponentsButton").onclick(); assert.deepEqual(revisions, ["one", "two"]);
  assert.deepEqual(scopes, ["profile", "project_local"]);
  ui.elements.get("componentSharedButton").onclick();
  assert.equal(ui.elements.get("componentSharedButton").attributes["aria-pressed"], "true");
});

test("late update or index results from another profile are not shown as current", async () => {
  for (const action of ["updates", "rebuild_index"]) {
    const ui = screen(async name => {
      if (name === "settings.read") return read;
      if (name === "settings.operation") return { id: "old", action, status: "completed", projectRoot: "C:/other", instance: "first",
        result: action === "updates" ? { component: "bsl-ls", state: "applied", release: "old-result" } : { edtProject: "Old", state: "ready" } };
      throw new Error(name);
    }); await ui.flush(); await ui.context.pollOperation("old");
    assert.doesNotMatch(ui.elements.get("updatesResult").textContent, /old-result/);
    assert.match(ui.elements.get("status").textContent, /другого профиля/);
  }
});

test("diagnostics show and filter safe text, stay available during an operation, and refresh without repeating it", async () => {
  let logs=0;const operation={id:"pending",action:"check",status:"running"};
  const data={events:[{time:"2026-10-22T10:01:00Z",level:"error",component:"edt",event:"<failure>",detail:{message:"ECONNREFUSED"}},{time:"2026-10-22T10:00:00Z",level:"info",component:"settings",event:"opened",detail:{}}],total:2,runtime:{plugin:"1.0.0",node:"v24",platform:"win32",architecture:"x64"},session:{instance:"A",operation,logger:{dropped:0}},paths:{state:"C:/state"},observedAt:"2026-10-22T10:01:00Z"};
  const ui=screen(async name=>{if(name==="settings.read"||name==="settings.status")return {...read,operation};if(name==="settings.operation")return operation;if(name==="settings.diagnostics"){logs++;return data;}throw new Error(name);});await ui.flush();
  ui.elements.get("supportTab").onclick();await ui.flush();assert.equal(logs,1);
  assert.equal(ui.elements.get("diagnosticsRefreshButton").disabled,false);assert.equal(ui.elements.get("diagnosticJournal").children.length,2);
  assert.equal(ui.elements.get("expandJournalButton").disabled,false);assert.equal(ui.elements.get("journalDialogClose").disabled,false);
  assert.match(ui.elements.get("diagnosticOperation").textContent,/Выполняется · подготовка и проверка готовности/);
  assert.equal(ui.elements.get("diagnosticJournal").children.at(-1).children[0].children[2].textContent,"edt · <failure>");
  assert.equal(ui.elements.get("diagnosticJournal").children.at(-1).children[0].children[1].textContent,"ошибка");
  assert.match(ui.elements.get("diagnosticJournal").children.at(-1).children[1].textContent,/ECONNREFUSED/);
  assert.equal(data.events[0].level,"error");assert.equal(data.events[0].detail.message,"ECONNREFUSED");
  ui.elements.get("logLevel").value="error";ui.elements.get("logLevel").events.change();assert.equal(ui.elements.get("diagnosticJournal").children.length,1);
  ui.elements.get("logSearch").value="absent";ui.elements.get("logSearch").events.input();assert.match(ui.elements.get("diagnosticJournal").children[0].textContent,/Нет записей/);
  await ui.elements.get("diagnosticsRefreshButton").onclick();assert.equal(logs,2);
  await ui.tick(2000);assert.equal(logs,3);
  ui.elements.get("checkTab").onclick();await ui.context.refreshStatus();assert.equal(logs,3);
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.run_check").length,0);
});

test("journal scrolls the complete chronological history and expands without losing filters, disclosure state or focus", async () => {
  let reads=0;
  const events=Array.from({length:8},(_,index)=>({time:new Date(Date.UTC(2026,10,5,12,0,8-index)).toISOString(),level:index===7?"error":"info",component:"settings",event:"record-"+index,detail:{index}}));
  const data={events,total:events.length,session:{logger:{}},observedAt:events[0].time};
  const ui=screen(async name=>{if(["settings.read","settings.status"].includes(name))return read;if(name==="settings.diagnostics"){reads++;return data;}throw new Error(name);});await ui.flush();
  ui.elements.get("supportTab").onclick();await ui.flush();
  const journal=ui.elements.get("diagnosticJournal"),dialog=ui.elements.get("journalDialog"),expand=ui.elements.get("expandJournalButton"),controls=ui.elements.get("journalControls");
  assert.equal(journal.children.length,8);assert.equal(ui.elements.get("journalCount").textContent,"8 из 8");
  assert.equal(journal.children.at(-1).children[0].children[2].textContent,"settings · record-0");
  const oldRow=journal.children[0];oldRow.open=true;expand.onclick();
  assert.equal(dialog.open,true);assert.equal(controls.parentElement,ui.elements.get("journalDialogBody"));assert.equal(journal.children.length,8);assert.equal(journal.children[0].open,true);assert.equal(reads,1);
  oldRow.open=false;oldRow.events.toggle();dialog.events.cancel({preventDefault(){}});
  assert.equal(dialog.open,false);assert.equal(controls.parentElement,ui.elements.get("journalPreviewHolder"));assert.equal(journal.children.length,8);assert.equal(journal.children[0].open,false);assert.equal(ui.document.activeElement,expand);
  ui.elements.get("logLevel").value="error";ui.elements.get("logLevel").events.change();assert.equal(journal.children.length,1);assert.equal(journal.children[0].children[0].children[2].textContent,"settings · record-7");
  expand.onclick();assert.equal(journal.children.length,1);assert.equal(ui.elements.get("logLevel").value,"error");
  ui.elements.get("logSearch").value="not present";ui.elements.get("logSearch").events.input();assert.match(journal.children[0].textContent,/Нет записей/);
  ui.elements.get("journalDialogClose").onclick();assert.equal(ui.elements.get("logSearch").value,"not present");assert.match(journal.children[0].textContent,/Нет записей/);
  ui.elements.get("logSearch").value="";ui.elements.get("logSearch").events.input();ui.elements.get("logLevel").value="all";ui.elements.get("logLevel").events.change();expand.onclick();
  events.unshift({...events[0],time:"2026-11-05T12:00:09Z",event:"new-record"});await ui.context.loadDiagnostics();
  assert.equal(reads,2);assert.equal(journal.children.length,9);assert.equal(journal.children.at(-1).children[0].children[2].textContent,"settings · new-record");assert.equal(journal.children[0].open,false);
  dialog.getBoundingClientRect=()=>({left:10,right:100,top:10,bottom:100});dialog.events.click({target:dialog,clientX:30,clientY:30});assert.equal(dialog.open,true);
  dialog.events.click({target:dialog,clientX:5,clientY:30});assert.equal(dialog.open,false);assert.equal(journal.children.length,9);assert.equal(ui.document.activeElement,expand);
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.run_check").length,0);
});

test("live journal preserves history position and focused records until the user resumes following", async () => {
  const events=Array.from({length:10},(_,index)=>({time:new Date(Date.UTC(2026,10,5,12,0,20-index)).toISOString(),level:"info",component:"settings",event:"record-"+index,detail:{index}}));
  const data={events,total:events.length,session:{logger:{}},observedAt:events[0].time};let reads=0;
  const ui=screen(async name=>{if(["settings.read","settings.status"].includes(name))return read;if(name==="settings.diagnostics"){reads++;return data;}throw new Error(name);});await ui.flush();
  ui.elements.get("supportTab").onclick();await ui.flush();
  const journal=ui.elements.get("diagnosticJournal");journal.clientHeight=215;
  journal.clientTop=1;journal.getBoundingClientRect=()=>({top:500});
  Object.defineProperty(journal,"scrollHeight",{get(){return this.children.length*43;}});
  journal.children.forEach(row=>{row.getBoundingClientRect=()=>{const top=501+journal.children.indexOf(row)*43-journal.scrollTop;return {top,bottom:top+43};};});
  ui.elements.get("journalResumeButton").onclick();assert.equal(journal.scrollTop,430);
  journal.scrollTop=43;journal.events.scroll();
  const row=journal.children[2];row.open=true;row.children[0].focus();
  events.unshift({...events[0],time:"2026-11-05T12:00:21Z",event:"newest"});
  await ui.tick(2000);
  assert.equal(journal.children.length,11);assert.equal(journal.children[2],row);assert.equal(row.open,true);
  assert.equal(journal.scrollTop,43);assert.equal(ui.document.activeElement,row.children[0]);
  assert.equal(ui.elements.get("journalResumeButton").hidden,false);assert.match(ui.elements.get("journalResumeButton").textContent,/\(1\)/);
  ui.elements.get("journalResumeButton").onclick();assert.equal(journal.scrollTop,473);assert.equal(ui.elements.get("journalResumeButton").hidden,true);
  ui.elements.get("journalFollowButton").onclick();assert.equal(ui.elements.get("journalFollowButton").attributes["aria-pressed"],"false");
  const position=journal.scrollTop;events.unshift({...events[0],time:"2026-11-05T12:00:22Z",event:"later"});await ui.tick(2000);assert.equal(journal.scrollTop,position);
  ui.document.hidden=true;ui.documentEvents.visibilitychange();assert.ok(![...ui.timers.values()].some(timer=>timer.ms===2000));
  ui.document.hidden=false;ui.documentEvents.visibilitychange();await ui.flush();assert.equal(reads,4);
  ui.elements.get("checkTab").onclick();assert.ok(![...ui.timers.values()].some(timer=>timer.ms===2000));
  ui.lifecycle.pagehide();assert.ok(![...ui.timers.values()].some(timer=>timer.ms===2000));
  assert.equal(ui.calls.filter(call=>["settings.run_check","settings.probe_connections"].includes(call.params?.name)).length,0);
});

test("the configuration form shows backend effective sources and preserves overridden saved file values", async () => {
  const sources={};for(const [path,source]of [[["connections","edt","url"],"environment:EDT_AI_EDT_URL"],[["project","purpose"],"project_local"],[["components","bsl-ls","java"],"settings"]])sources[JSON.stringify(path)]=source;
  const current={...read,configurationValues:{connections:{edt:{url:"http://environment/mcp"}},project:{purpose:"local purpose"},components:{"bsl-ls":{java:"java"}}},configurationSources:sources};
  const text="connections:\n  edt:\n    url: http://shared/mcp\nproject:\n  purpose: shared purpose\n";
  const ui=screen(async(name,args)=>{
    if(["settings.read","settings.status"].includes(name))return current;
    if(name==="settings.edit")return {text,format:"yaml",layerScope:"profile",baseRevision:"base"};
    if(name==="settings.document_fields")return new SettingsBackend("unused","unused").main({action:"document_fields",...args});
    throw new Error(name);
  });await ui.flush();ui.elements.get("editorTab").onclick();await ui.flush();await ui.flush();
  const rows=vm.runInContext("jsonRows",ui.context),url=rows.get(JSON.stringify(["connections","edt","url"]));
  assert.match(url.origin.textContent,/http:\/\/environment\/mcp.*EDT_AI_EDT_URL/);
  assert.match(rows.get(JSON.stringify(["project","purpose"])).origin.textContent,/local purpose.*локальные настройки/);
  assert.match(ui.elements.get("editorOriginNote").textContent,/Внешние переопределения/);
  assert.equal(treeInputs(ui).find(input=>input.attributes?.["aria-label"]==="connections.edt.url").value,"http://shared/mcp");
  assert.equal(ui.elements.get("settingsText").value,text);
});

test("profile editing lives in its dropdown row and returns focus after cancellation", async () => {
  const ui=screen(async name=>{if(["settings.read","settings.status"].includes(name))return {...read,profileHistory:[{...read.profile,projectRoot:read.values.projectRoot}]};throw new Error(name);});await ui.flush();
  ui.elements.get("profileToggleButton").onclick();ui.elements.get("renameButton").onclick();
  const card=ui.elements.get("profileHistory").children[0];
  assert.equal(ui.elements.get("renameButton").parentElement,card);assert.equal(ui.elements.get("renameArea").parentElement,card);
  assert.equal(ui.elements.get("profileBrowser").hidden,false);assert.equal(ui.elements.get("profileOverview").hidden,true);
  ui.elements.get("renameCancelButton").onclick();assert.equal(ui.elements.get("renameArea").hidden,true);assert.equal(ui.document.activeElement,ui.elements.get("renameButton"));
});

test("a slow initial snapshot preserves the tab selected while it was loading", async () => {
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const ui=screen(async name=>{if(name==="settings.read"){await gate;return read;}if(name==="settings.diagnostics")return {events:[],session:{},observedAt:new Date().toISOString()};throw new Error(name);});
  await ui.flush();ui.elements.get("supportTab").onclick();await ui.flush();release();await ui.flush();
  assert.equal(ui.elements.get("supportPanel").hidden,false);assert.equal(ui.elements.get("supportTab").attributes["aria-selected"],"true");
  ui.lifecycle.pagehide();
});

for (const id of ["edt", "v8std", "openviking", "code-index", "bsl-ls", "yaxunit", "vanessa"]) test(`a failed ${id} save stays visible in its dialog and a successful retry replaces the error`, async () => {
  const backend = new SettingsBackend("unused", "unused"), failure = "Профиль изменился на диске. Проверьте изменения заново.";
  const current = { ...read, instance: "default", settingsRevision: "before", values: { ...read.values,
    edtUrl: "http://edt", v8stdUrl: "http://v8std", openvikingUrl: "", openvikingEnabled: false, codeIndexEnabled: true, bslLsEnabled: true },
    profile: { ...read.profile, testing: { yaxunit: false, vanessa: false } } };
  current.layerValues = { profile: { ...current.values } };
  let failWrites = true, text = "testing:\n  yaxunit: false\n  vanessa: false\n";
  const ui = screen(async (name, args) => {
    if (["settings.read", "settings.status"].includes(name)) return current;
    if (name === "settings.versions") return { component: args.component, versions: [] };
    if (name === "settings.edit") return { text, format: "yaml", baseRevision: current.settingsRevision, layerScope: "profile" };
    if (name === "settings.document_fields") return backend.main({ action: "document_fields", ...args });
    if (name === "settings.document_patch") return patch_yaml_draft(args.text, args.operation);
    if (name === "settings.preview") return { revision: "reviewed", projectRoot: current.values.projectRoot,
      profileId: "generic-1c", replacesProfile: true, repositories: [] };
    if (["settings.update", "settings.apply"].includes(name)) {
      if (failWrites) throw new Error(failure);
      if (name === "settings.apply") text = args.text;
      else { Object.assign(current.values, args.set); Object.assign(current.layerValues.profile, args.set); }
      current.settingsRevision = "after";
      return { settingsRevision: "after", savedTo: "C:/fixture/project/.ai/project.yaml" };
    }
    throw new Error(name);
  });
  await ui.flush(); ui.document.hidden = true;
  const item = ui.context.catalogItems(current).find(item => item.id === id);
  let save, notice;
  if (item.kind === "external") {
    ui.context.openConnectionDialog(item, null);
    const input = ui.elements.get(id + "Url"); input.value = "http://draft/mcp"; input.events.input();
    save = ui.elements.get("saveButton"); notice = ui.elements.get("componentDialogStatus");
  } else if (item.kind === "managed") {
    ui.context.openManagedDialog(item, null); await ui.flush();
    const input = ui.elements.get(id === "code-index" ? "codeIndexEnabled" : "bslLsEnabled"); input.checked = false; input.events.change();
    save = ui.elements.get("saveComponentsButton"); notice = ui.elements.get("managedDialogNotice");
  } else {
    await ui.context.openTestingSettings(id, null); await ui.flush(); await ui.flush();
    const input = treeInputs(ui).find(input => input.attributes?.["aria-label"] === "testing." + id);
    input.checked = true; await input.onchange();
    await ui.elements.get("reviewEditButton").onclick();
    save = ui.elements.get("applyButton"); notice = ui.elements.get("testingDialogNotice");
  }
  assert.equal(save.disabled, false);
  await save.onclick();
  assert.ok(notice, "The open dialog must expose operation feedback");
  assert.equal(notice.hidden, false); assert.equal(notice.textContent, failure);
  assert.equal(ui.context.hasProfileDraft(), true);
  await ui.context.refresh();
  assert.equal(notice.hidden, false); assert.equal(notice.textContent, failure);
  failWrites = false;
  await save.onclick();
  assert.equal(notice.hidden, false); assert.match(notice.textContent, /Сохранено:|Настройки сохранены/);
  assert.doesNotMatch(notice.textContent, /изменился на диске/);
  assert.equal(ui.context.hasProfileDraft(), false);
  const next = structuredClone(current); next.values.projectRoot = "C:/fixture/other";
  ui.context.renderCurrent(next);
  assert.equal(notice.hidden, true); assert.equal(notice.textContent, "");
});

for (const [source, target, noticeId] of [["code-index", "bsl-ls", "managedDialogNotice"], ["yaxunit", "vanessa", "testingDialogNotice"]]) test(`a late ${source} error cannot replace the ${target} operation notice`, async () => {
  const f = isolatedProbeScreen(source, { startFailed: true }); await f.ui.flush(); await f.open(source);
  const checking = f.probe(source); await f.ui.flush();
  f.close(source); await f.open(target);
  const notice = f.ui.elements.get(noticeId);
  assert.ok(notice);
  const message = notice.textContent, hidden = notice.hidden;
  f.finish(); await checking;
  assert.equal(notice.textContent, message); assert.equal(notice.hidden, hidden);
  f.close(target); assert.equal(notice.hidden, true); assert.equal(notice.textContent, "");
});

for (const expanded of [false, true]) test(`a rolling journal tail preserves the visible record with ancestor-relative offsets${expanded ? " in the full dialog" : ""}`, async () => {
  const events = Array.from({ length: 200 }, (_, index) => ({ time: new Date(Date.UTC(2026, 10, 5, 12, 0, 200 - index)).toISOString(),
    level: "info", component: "settings", event: "record-" + (200 - index), detail: {} }));
  const data = { events, total: 250, truncated: true, session: {}, observedAt: events[0].time };
  const ui = screen(async name => { if (["settings.read", "settings.status"].includes(name)) return read; if (name === "settings.diagnostics") return data; throw new Error(name); });
  await ui.flush(); ui.elements.get("supportTab").onclick(); await ui.flush();
  if (expanded) ui.elements.get("expandJournalButton").onclick();
  const journal = ui.elements.get("diagnosticJournal"), offsetBase = expanded ? 130 : 500;
  journal.clientHeight = 217; journal.clientTop = 1;
  journal.getBoundingClientRect = () => ({ top: offsetBase, height: 219 });
  Object.defineProperty(journal, "scrollHeight", { get() { return this.children.length * 43; } });
  for (const row of journal.children) {
    row.offsetHeight = 43;
    Object.defineProperty(row, "offsetTop", { get() { return offsetBase + journal.children.indexOf(this) * 43; } });
    row.getBoundingClientRect = () => { const top = offsetBase + journal.clientTop + journal.children.indexOf(row) * 43 - journal.scrollTop; return { top, bottom: top + 43 }; };
  }
  journal.scrollTop = 86; journal.events.scroll();
  const reading = journal.children[2]; reading.open = true; reading.children[0].focus();
  events.unshift({ ...events[0], time: "2026-11-05T12:03:21Z", event: "record-201" }); events.pop();
  await ui.tick(2000);
  assert.equal(journal.children.length, 200); assert.equal(journal.children[1], reading);
  assert.equal(journal.scrollTop, 43, "The same record must remain at the same viewport position");
  assert.equal(reading.open, true); assert.equal(ui.document.activeElement, reading.children[0]);
  assert.equal(ui.elements.get("journalResumeButton").hidden, false);
  assert.equal(Boolean(ui.elements.get("journalDialog").open), expanded);
});

for (const [code, tone] of [["launch_required", "warning"], ["ambiguous", "warning"], ["api_unsupported", "warning"], ["unsupported_response", "warning"], ["edt_unavailable", "error"], ["check_stale", "warning"], ["launch_verified", "good"]]) test(`YaXUnit ${code} agrees across its card, dialog, counters and setup summary`, async () => {
  const checkedAt = new Date().toISOString(), expiresAt = new Date(Date.now() + 60000).toISOString();
  const check = { ...yaxunit_result(code, code === "launch_verified" ? { target: { projectName: "Product", applicationId: "app", launchConfigurationName: "Unit tests" } } : {}), checkedAt, expiresAt };
  const current = { ...read, instance: "default", settingsRevision: "r1", profile: { ...read.profile, testing: { yaxunit: true, vanessa: false } },
    values: { ...read.values, edtUrl: "http://edt", v8stdUrl: "http://v8std", codeIndexEnabled: false, bslLsEnabled: false, openvikingEnabled: false },
    testing: { yaxunit_config: {} }, componentChecks: [check], summary: { components: [] },
    readiness: { state: check.state === "ready" ? "ready" : "blocked", checkedAt, expiresAt, checks: [{ id: "edt", label: "EDT", state: "ready" }, { id: "v8std", label: "v8std", state: "ready" }, { ...check, label: "YaXUnit" }] } };
  const ui = screen(async name => {
    if (["settings.read", "settings.status"].includes(name)) return current;
    if (name === "settings.edit") return { text: "testing: {}\n", baseRevision: "base", layerScope: "profile" };
    if (name === "settings.document_fields") return new SettingsBackend("unused", "unused").main({ action: "document_fields", text: "testing: {}\n", layerScope: "profile" });
    throw new Error(name);
  });
  await ui.flush(); ui.document.hidden = true;
  const cards = ui.elements.get("componentCatalog").children.flatMap(group => group.children[1].children), card = cards.find(item => componentName(item) === "YaXUnit"), trigger = componentButton(card); trigger.isConnected = true;
  await ui.context.openTestingSettings("yaxunit", trigger); await ui.flush();
  assert.equal(ui.elements.get("testingDialogDiagnostic").textContent, check.title);
  assert.equal(ui.elements.get("testingDialogState").attributes["data-tone"], tone);
  assert.equal(ui.elements.get("testingLaunchSummary").hidden, false);
  assert.match(ui.elements.get("testingLaunchText").textContent, new RegExp(check.state === "ready" ? "Проверенная цель: Unit tests" : (check.nextStep.includedInDetail ? check.detail : check.nextStep.detail).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(card.children[0].children[1].textContent, check.title);
  assert.equal(card.children[0].children[1].className.includes(" ready"), check.state === "ready");
  assert.equal(card.className.includes(" error"), check.state === "error");
  assert.equal(ui.elements.get("countReady").textContent, check.state === "ready" ? "3" : "2");
  assert.equal(ui.elements.get("countIssues").textContent, check.state === "ready" ? "0" : "1");
  assert.equal(ui.elements.get("headerStatusTitle").textContent, check.state === "ready" ? "Готово" : "Требует внимания");
  assert.equal(ui.elements.get("testingProbeButton").children.at(-1).textContent, "Проверить настройки запуска");
  ui.elements.get("testingProbeButton").focus(); ui.context.renderDialogStates(); assert.equal(ui.document.activeElement, ui.elements.get("testingProbeButton"));
  ui.elements.get("testingDialogClose").onclick(); assert.equal(ui.document.activeElement, trigger);
});

test("EDT stays ready beside unavailable tests and labels an optional closed project without claiming operational readiness", async () => {
  const checkedAt = new Date().toISOString(), expiresAt = new Date(Date.now() + 60000).toISOString();
  const repositories = [{ id: "product", required: true, matched: true, open: true, state: "ready", ready: true, requirementsMet: true },
    { id: "tests", required: false, matched: true, open: false, state: "not_available", ready: false, requirementsMet: true }];
  const checks = [{ id: "edt", label: "EDT", state: "ready", repositories }, { id: "v8std", label: "v8std", state: "ready" }, { ...yaxunit_result("project_not_ready"), label: "YaXUnit" }];
  const current = { ...read, instance: "default", profile: { ...read.profile, testing: { yaxunit: true, vanessa: false } }, testing: { yaxunit_config: {} },
    values: { ...read.values, edtUrl: "http://edt", v8stdUrl: "http://v8std", codeIndexEnabled: false, bslLsEnabled: false, openvikingEnabled: false },
    readiness: { state: "blocked", mainReadiness: { scope: "setup_main", state: "ready" }, checkedAt, expiresAt, checks } };
  const ui = screen(async name => { if (["settings.read", "settings.status"].includes(name)) return current; throw new Error(name); });
  await ui.flush();
  assert.equal(headerState(ui, "EDT"), "Готов"); assert.equal(headerState(ui, "YaXUnit"), "Проекты EDT не готовы");
  assert.equal(ui.elements.get("headerStatusTitle").textContent, "Требует внимания");
  assert.match(ui.elements.get("readinessTitle").textContent, /Основное окружение готово; тесты требуют внимания/);
  assert.match(ui.elements.get("readinessDetail").textContent, /независимой работы.*YaXUnit.*Полная проверка окружения не пройдена/);
  const cards = ui.elements.get("componentCatalog").children.flatMap(group => group.children[1].children);
  const edt = cards.find(card => componentName(card) === "EDT"), yaxunit = cards.find(card => componentName(card) === "YaXUnit");
  assert.equal(edt.children[0].children[1].textContent, "Готов"); assert.equal(edt.className.includes("error"), false);
  assert.equal(yaxunit.children[0].children[1].textContent, "Проекты EDT не готовы");
  componentButton(edt).onclick();
  assert.equal(ui.elements.get("externalStateDescription").textContent, "Готов");
  assert.equal(ui.elements.get("externalProjectStates").children[1].textContent, "tests: Необязательный · закрыт · недоступен для операций");
  assert.equal(repositories[1].ready, false);
  ui.context.renderCurrent({ ...current, readiness: { ...current.readiness, state: "stale", mainReadiness: { scope: "setup_main", state: "stale" } } });
  assert.doesNotMatch(ui.elements.get("readinessTitle").textContent, /Основное окружение готово/);
});

test("YaXUnit draft keeps the saved status and identifies which settings were checked", async () => {
  const backend = new SettingsBackend("unused", "unused"), text = "testing:\n  yaxunit: true\n  yaxunit_config:\n    repository_id: product\n    runner: edt\n    results: results\n";
  const current = { ...read, instance: "default", settingsRevision: "r1", profile: { ...read.profile, testing: { yaxunit: true, vanessa: false } }, testing: { yaxunit_config: {} },
    componentChecks: [{ ...yaxunit_result("launch_verified", { choices: [{ name: "Discovered", projectName: "Product" }] }), checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() }] };
  const ui = screen(async (name, args) => {
    if (["settings.read", "settings.status"].includes(name)) return current;
    if (name === "settings.edit") return { text, baseRevision: "base", layerScope: "profile" };
    if (name === "settings.document_fields") return backend.main({ action: "document_fields", ...args });
    if (name === "settings.document_patch") return backend.main({ action: "document_patch", ...args });
    throw new Error(name);
  });
  await ui.flush(); ui.document.hidden = true; await ui.context.openTestingSettings("yaxunit", null); await ui.flush();
  const input = treeInputs(ui).find(item => item.attributes?.["aria-label"] === "testing.yaxunit_config.launch_configuration");
  assert.ok(input); assert.equal(input.value, ""); assert.equal(input.launchOptions.children[0].value, "Discovered");
  input.focus(); input.value = "Discovered"; await input.onchange(); await ui.flush();
  assert.equal(parse(ui.elements.get("settingsText").value).testing.yaxunit_config.launch_configuration, "Discovered");
  assert.equal(ui.document.activeElement, input); assert.equal(ui.elements.get("testingDialogState").attributes["data-state"], "ready");
  assert.match(ui.elements.get("testingLaunchText").textContent, /Статус относится к сохранённым настройкам/);
});

test("a successful background YaXUnit check immediately resolves its existing setup blocker", async () => {
  const checkedAt = new Date(Date.now() - 1000).toISOString(), expiresAt = new Date(Date.now() + 60000).toISOString();
  const current = { ...read, instance: "default", settingsRevision: "r1", profile: { ...read.profile, testing: { yaxunit: true, vanessa: false } },
    values: { ...read.values, edtUrl: "http://edt", v8stdUrl: "http://v8std", codeIndexEnabled: false, bslLsEnabled: false, openvikingEnabled: false }, testing: { yaxunit_config: {} },
    readiness: { state: "blocked", checkedAt, expiresAt, checks: [{ id: "edt", state: "ready" }, { id: "v8std", state: "ready" }, { ...yaxunit_result("launch_required"), label: "YaXUnit" }] } };
  const ui = screen(async () => current); await ui.flush(); assert.equal(ui.elements.get("headerStatusTitle").textContent, "Требует внимания");
  const check = { ...yaxunit_result("launch_verified"), checkedAt: new Date().toISOString(), expiresAt };
  await ui.context.pollOperation("background-yaxunit", null, { id: "background-yaxunit", action: "refresh_readiness", component: "yaxunit", status: "completed", projectRoot: current.values.projectRoot, instance: current.instance,
    result: { componentChecks: [check], readiness: { ...current.readiness, state: "ready", checks: [{ id: "edt", state: "ready" }, { id: "v8std", state: "ready" }, { ...check, label: "YaXUnit" }] } } });
  assert.equal(ui.elements.get("headerStatusTitle").textContent, "Готово"); assert.equal(ui.elements.get("countReady").textContent, "3");
  assert.equal(ui.context.catalogItems(current).find(item => item.id === "yaxunit").state, "ready");
});

test("disabled YaXUnit stays neutral, cannot probe launch settings and does not block ready setup", async () => {
  const checkedAt = new Date().toISOString(), current = { ...read, instance: "default", profile: { ...read.profile, testing: { yaxunit: false, vanessa: false } },
    values: { ...read.values, edtUrl: "http://edt", v8stdUrl: "http://v8std", codeIndexEnabled: false, bslLsEnabled: false, openvikingEnabled: false },
    readiness: { state: "ready", checkedAt, checks: [{ id: "edt", state: "ready" }, { id: "v8std", state: "ready" }, { ...yaxunit_result("disabled"), label: "YaXUnit" }] } };
  const ui = screen(async name => {
    if (["settings.read", "settings.status"].includes(name)) return current;
    if (name === "settings.edit") return { text: "testing: {}\n", baseRevision: "base", layerScope: "profile" };
    return new SettingsBackend("unused", "unused").main({ action: "document_fields", text: "testing: {}\n", layerScope: "profile" });
  });
  await ui.flush(); ui.document.hidden = true; await ui.context.openTestingSettings("yaxunit", null); await ui.flush();
  assert.equal(ui.elements.get("testingDialogState").attributes["data-tone"], "neutral"); assert.equal(ui.elements.get("testingProbeButton").disabled, true);
  assert.equal(ui.elements.get("testingLaunchSummary").hidden, true); assert.equal(ui.elements.get("headerStatusTitle").textContent, "Готово");
});
