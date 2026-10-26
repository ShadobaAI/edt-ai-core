import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const html = fs.readFileSync(new URL("../ui/settings.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function screen(handler, options = {}) {
  const elements = new Map(), timers = new Map(), calls = [], downloads = [], blobs = [];
  let nextTimer = 0, message, observedResize;const lifecycle = {}, documentEvents = {};
  class Element {
    constructor(tag = "div") { Object.assign(this, { tag, style: {}, disabled: false, readOnly: false, hidden: false, value: "", files: [], textContent: "", children: [], events: {} }); }
    classList = { toggle() {} };
    addEventListener(name, fn) { this.events[name] = fn; }
    setAttribute(key, value) { (this.attributes ||= {})[key] = value; }
    removeAttribute(key) { delete (this.attributes ||= {})[key]; }
    contains(target) { return target===this||this.children.some(child=>child.contains?.(target)); }
    replaceChildren(...children) { this.children = children; }
    append(...children) { this.children.push(...children); }
    click() { if (this.tag === "a") downloads.push({ filename: this.download, href: this.href }); }
    remove() {}
    focus() {}
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
          : await handler(request.params.name, request.params.arguments,request.params._meta);
        result = request.method === "ui/initialize" ? data : { structuredContent: data };
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
    Blob, URL: { createObjectURL: blob => { blobs.push(blob); return "blob:fixture"; }, revokeObjectURL() {} } });
  vm.runInContext(script, context);
  vm.runInContext(`configureNavigation(${JSON.stringify(options.navigation || "profiles")})`, context);
  const flush = () => new Promise(resolve => setImmediate(resolve));
  return { context, elements, timers, calls, downloads, blobs, flush, document, lifecycle, documentEvents, media, resize: () => observedResize(),
    deliver(data) { message({ source: parent, origin: "https://fixture.invalid", data }); },
    async tick(ms = 1000) { const [id, timer] = [...timers].find(([, timer]) => timer.ms === ms) || []; assert.ok(timer); timers.delete(id); timer.fn(); await flush(); } };
}

const read = { values: { projectRoot: "C:/fixture/project" }, preparationScope: "C:/fixture/project#default",
  profile: { status: "loaded", projectId: "Project", profileId: "generic-1c", repositories: [] },
  schema: { properties: { projectRoot: { readOnly: true } } } };

test("OpenViking editable transport fields save typed values through the shared backend", async () => {
  let updated;
  const current = structuredClone(read);
  current.values = { ...current.values, openvikingEnabled: false, openvikingUrl: "",
    openvikingTimeout: 20, openvikingMaxResponseBytes: 2097152, openvikingHeadersEnv: {} };
  const ui = screen(async (name, args) => {
    if (["settings.read", "settings.status"].includes(name)) return current;
    if (name === "settings.update") { updated = args.set; Object.assign(current.values, args.set); return {}; }
    throw new Error(name);
  }); await ui.flush();
  const values = { openvikingEnabled: true, openvikingUrl: "https://knowledge.example/mcp",
    openvikingTimeout: 2.5, openvikingMaxResponseBytes: 4096,
    openvikingHeadersEnv: { Authorization: "OV_AUTHORIZATION" } };
  for (const [key, value] of Object.entries(values)) {
    const field = ui.elements.get(key); assert.equal(field.disabled, false);
    if (typeof value === "boolean") { field.checked = value; field.events.change(); }
    else { field.value = typeof value === "object" ? JSON.stringify(value) : String(value); field.events.input(); }
  }
  await ui.elements.get("saveButton").onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(updated)), values);
});

test("knowledge UI shows scoped setup publication and drops stale readiness without losing draft fields", async () => {
  const current = structuredClone(read);
  current.knowledge = { mode: "transitional", provider: "openviking", collections: ["team", "api"], required: true,
    workflowScope: "dependent_actions", dependentActions: ["implementation"], state: "not_verified", detail: "Search not verified" };
  current.valueSources = { openvikingTimeout: "project_local", openvikingHeadersEnv: "connections_file" };
  current.readiness = { state: "blocked", checks: [], knowledge: { ready: true,
    readiness: { publication: { state: "verified", gitRevision: "revision-fixture", snapshot: "index-fixture" } } } };
  const ui = screen(async name => { if (["settings.read", "settings.status"].includes(name)) return current; throw new Error(name); });
  await ui.flush();
  assert.match(ui.elements.get("knowledgeDetails").textContent, /team, api/);
  assert.match(ui.elements.get("knowledgeDetails").textContent, /revision-fixture · индекс index-fixture/);
  assert.match(ui.elements.get("openvikingTimeoutSource").textContent, /локальных настроек проекта/);
  const field = ui.elements.get("openvikingUrl"); field.value = "https://draft.example/mcp"; field.events.input();
  current.readiness.state = "stale"; current.readiness.reason = "Изменились полномочия";
  await ui.tick(8000);
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
  for(const mode of ["check","editor","import","export","support","profile"]){
    const tab=ui.elements.get(mode+"Tab");assert.equal(tab.disabled,false);tab.onclick();
    assert.equal(ui.elements.get(mode+"Panel").hidden,false);assert.equal(tab.attributes["aria-selected"],"true");
  }
  ui.elements.get("profileTab").events.keydown({key:"ArrowRight",preventDefault(){}});
  assert.equal(ui.elements.get("checkPanel").hidden,false);
  assert.equal(ui.elements.get("versionButton").disabled,false);await ui.elements.get("versionButton").onclick();
  assert.equal(ui.elements.get("versionPopup").hidden,false);assert.equal(ui.elements.get("versionSearch").disabled,false);
  assert.match(ui.elements.get("versionHint").textContent,/в настройках плагина/);
  assert.deepEqual(ui.calls,[]);assert.ok(![...ui.timers.values()].some(timer=>timer.ms===8000));
});

test("standalone preview keeps saving, updates and service launches unavailable after navigation", async () => {
  const ui=screen(()=>{throw new Error("No plugin calls in preview");},{standalone:true});await ui.flush();
  for(const mode of ["check","import","export","editor","support"]){
    ui.elements.get(mode+"Tab").onclick();
    for(const id of ["saveButton","saveComponentsButton","checkButton","rebuildIndexButton","installUpdateButton","refreshVersionsButton","downloadButton","previewButton","applyButton","diagnosticsButton"])
      assert.equal(ui.elements.get(id).disabled,true,id);
  }
  await ui.elements.get("checkButton").onclick();
  assert.deepEqual(ui.calls,[]);assert.match(ui.elements.get("status").textContent,/Подключение к плагину/);
});

test("JSON tree edits typed values and sends the exact document through revision-protected preview", async () => {
  const text=JSON.stringify({settings:{enabled:false,items:[1,null]},profile:{name:"<script>"}},null,2);
  let previewText;
  const ui=screen(async(name,args)=>{
    if(name==="settings.read"||name==="settings.status")return read;
    if(name==="settings.edit")return {text,baseRevision:"base-json"};
    if(name==="settings.preview"){assert.equal(args.baseRevision,"base-json");assert.equal(args.mode,"edit");previewText=args.text;return {revision:"reviewed",projectRoot:read.values.projectRoot,repositories:[]};}
    throw new Error(name);
  });await ui.flush();ui.elements.get("editorMode").value="tree";await ui.elements.get("editSettingsButton").onclick();
  assert.equal(ui.elements.get("jsonTree").hidden,false);assert.equal(ui.elements.get("settingsText").hidden,true);
  const inputs=treeInputs(ui);assert.equal(inputs[3].value,'"<script>"');
  inputs[0].value="true";inputs[0].events.input();inputs[1].value="42";inputs[1].events.input();
  inputs[2].value='"typed"';inputs[2].events.input();
  const expected={settings:{enabled:true,items:[42,"typed"]},profile:{name:"<script>"}};
  assert.deepEqual(JSON.parse(ui.elements.get("settingsText").value),expected);
  await ui.tick(8000);assert.deepEqual(JSON.parse(ui.elements.get("settingsText").value),expected);
  await ui.elements.get("reviewEditButton").onclick();assert.deepEqual(JSON.parse(previewText),expected);
  ui.elements.get("editorMode").value="text";ui.elements.get("editorMode").events.change();
  assert.equal(ui.elements.get("settingsText").hidden,false);
});

test("profile table and header show detected EDT projects separately from the shared Git repository", async () => {
  const projects=[{name:"Base",directory:"C:/fixture/project/configuration"},{name:"<Extension>",directory:"C:/fixture/project/extension"}];
  const ui=screen(async()=>({...read,profile:{...read.profile,repositories:[{id:"shared",path:read.values.projectRoot}]},directoryContext:{edt:{detectedProjects:projects.slice(0,1),projectCount:1},git:{status:"not_repository"}},profileDirectoryContext:{edt:{detectedProjects:projects,projectCount:2},git:{status:"detected",root:read.values.projectRoot}}}));
  await ui.flush();assert.equal(ui.elements.get("profileEdtProjectCount").textContent,"EDT-проектов: 2");
  const rows=ui.elements.get("profileEdtProjects").children;assert.equal(rows.length,2);
  assert.deepEqual(rows.map(row=>row.children.map(cell=>cell.textContent)),projects.map(project=>[project.name,project.directory]));
  assert.equal(ui.elements.get("profileGitRoot").textContent,"Git-репозиторий каталога профиля: "+read.values.projectRoot);
});

test("invalid tree values guard preview, import and profile changes until corrected or discarded", async () => {
  const ui=screen(async name=>{if(name==="settings.read")return read;if(name==="settings.edit")return {text:'{"value":false}',baseRevision:"base"};throw new Error(name);});
  await ui.flush();ui.elements.get("editorMode").value="tree";await ui.elements.get("editSettingsButton").onclick();
  const input=treeInputs(ui)[0];input.value="fals";input.events.input();
  assert.equal(input.attributes["aria-invalid"],"true");assert.equal(ui.elements.get("reviewEditButton").disabled,true);
  assert.equal(ui.elements.get("unsavedHint").hidden,false);
  await ui.elements.get("reviewEditButton").onclick();await ui.elements.get("previewButton").onclick();
  await ui.context.selectProfile("C:/another");
  assert.equal(ui.calls.filter(call=>["settings.preview","settings.select_profile"].includes(call.params?.name)).length,0);
  ui.elements.get("editorMode").value="text";ui.elements.get("editorMode").events.change();assert.equal(ui.elements.get("editorMode").value,"tree");
  input.value="true";input.events.input();assert.equal(ui.elements.get("reviewEditButton").disabled,false);
  input.value="{";input.events.input();ui.elements.get("discardDraftButton").onclick();
  assert.equal(ui.elements.get("jsonTree").children.length,0);assert.equal(ui.elements.get("unsavedHint").hidden,true);
});

test("JSON tree blocks edits while a different project directory is awaiting selection", async () => {
  const ui=screen(async name=>name==="settings.edit"?{text:'{"value":false}',baseRevision:"base"}:{...read,schema:{properties:{projectRoot:{readOnly:false}}}});
  await ui.flush();await ui.elements.get("editSettingsButton").onclick();
  const input=treeInputs(ui)[0];assert.equal(input.disabled,false);
  ui.elements.get("projectRoot").value="C:/different";ui.elements.get("projectRoot").events.input();
  assert.equal(ui.elements.get("settingsText").disabled,true);assert.equal(input.disabled,true);
  input.value="true";input.events.input();assert.equal(ui.elements.get("settingsText").value,'{"value":false}');
  ui.elements.get("projectRoot").value=read.values.projectRoot;ui.elements.get("projectRoot").events.input();
  assert.equal(input.disabled,false);input.events.input();assert.equal(JSON.parse(ui.elements.get("settingsText").value).value,true);
});

test("JSON formatting validates syntax without losing invalid text, and YAML stays editable", async () => {
  const ui=screen(async name=>{if(name==="settings.read")return read;if(name==="settings.edit")return {text:'{"value":1}',baseRevision:"base"};throw new Error(name);});
  await ui.flush();await ui.elements.get("editSettingsButton").onclick();
  ui.elements.get("formatJsonButton").onclick();assert.equal(ui.elements.get("settingsText").value,'{\n  "value": 1\n}');
  ui.elements.get("settingsText").value='{"value":';ui.elements.get("settingsText").events.input();ui.elements.get("formatJsonButton").onclick();
  assert.equal(ui.elements.get("settingsText").value,'{"value":');assert.match(ui.elements.get("editorValidation").textContent,/Не удалось форматировать JSON/);
  ui.elements.get("settingsText").value="value: true";ui.elements.get("settingsText").events.input();
  ui.elements.get("editorMode").value="tree";ui.elements.get("editorMode").events.change();
  assert.equal(ui.elements.get("editorMode").value,"text");assert.equal(ui.elements.get("settingsText").value,"value: true");
});

test("history JSON tree is read-only and prototype-like keys remain ordinary document data", async () => {
  const text='{"__proto__":{"value":false},"constructor":"safe"}';
  const ui=screen(async name=>{if(name==="settings.read")return {...read,viewOnly:true};if(name==="settings.document")return {text};throw new Error(name);});
  await ui.flush();ui.elements.get("editorMode").value="tree";await ui.elements.get("editSettingsButton").onclick();
  assert.ok(treeInputs(ui).every(input=>input.readOnly));assert.equal(ui.elements.get("formatJsonButton").disabled,true);
  const input=treeInputs(ui)[0];input.value="true";input.events.input();assert.equal(ui.elements.get("settingsText").value,text);
  const editable=screen(async name=>name==="settings.edit"?{text,baseRevision:"base"}:read);await editable.flush();
  editable.elements.get("editorMode").value="tree";await editable.elements.get("editSettingsButton").onclick();
  const field=treeInputs(editable)[0];field.value="true";field.events.input();
  assert.equal(JSON.parse(editable.elements.get("settingsText").value).__proto__.value,true);
  assert.equal(vm.runInContext("Object.prototype.value",editable.context),undefined);
});

test("settings export confirms a saved file and opens its folder without browser downloads", async () => {
  const savedPath="C:/fixture/state/exports/1c-ai-core-settings.json";
  const ui=screen(async name=>{
    if(name==="settings.read")return read;
    if(name==="settings.save_export")return {path:savedPath,canOpenDirectory:true};
    if(name==="settings.open_export_directory")return {};
    throw new Error(name);
  });await ui.flush();await ui.elements.get("downloadButton").onclick();
  assert.equal(ui.elements.get("exportPath").textContent,savedPath);
  assert.equal(ui.elements.get("exportSaved").hidden,false);
  assert.equal(ui.elements.get("openExportButton").hidden,false);
  assert.match(ui.elements.get("status").textContent,/Файл настроек сохранён/);
  assert.equal(ui.downloads.length,0);
  await ui.elements.get("openExportButton").onclick();
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.open_export_directory").length,1);
});

test("settings export never reports success when the disk write fails or no path is confirmed", async () => {
  for(const result of [null,{text:"{}"}]){
    const ui=screen(async name=>{
      if(name==="settings.read")return read;
      if(name==="settings.save_export"){if(!result)throw new Error("Disk unavailable");return result;}
      throw new Error(name);
    });await ui.flush();await ui.elements.get("downloadButton").onclick();
    assert.equal(ui.elements.get("exportSaved").hidden,true);
    assert.match(ui.elements.get("status").textContent,/Disk unavailable|не подтверждено/);
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
  assert.equal(ui.elements.get("checkButton").disabled, true);
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
  assert.equal(ui.elements.get("checkButton").disabled, true);
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
  assert.equal(ui.elements.get("edtSource").textContent, "Из настроек EDT");
  assert.equal(ui.elements.get("createButton").hidden, true);
});

test("component selection is saved independently and update polling never repeats installation",async()=>{
  let enabled=false,polls=0;
  const ui=screen(async(name,args)=>{
    if(name==="settings.read")return {...read,values:{...read.values,codeIndexEnabled:true,bslLsEnabled:enabled}};
    if(name==="settings.update"){assert.equal(args.set.bslLsEnabled,true);enabled=true;return {};}
    if(name==="settings.updates"){assert.equal(args.operation,"install");assert.equal(args.component,"bsl-ls");assert.equal(args.authorization.scope,read.preparationScope);return {id:"update",status:"running"};}
    if(name==="settings.operation")return ++polls===1?{id:"update",status:"running",action:"updates"}:{id:"update",status:"completed",action:"updates",result:{component:"bsl-ls",state:"applied",release:"v9.0.0"}};
    throw new Error(name);
  });
  await ui.flush();assert.equal(ui.elements.get("bslLsEnabled").checked,false);
  ui.elements.get("bslLsEnabled").checked=true;await ui.elements.get("saveComponentsButton").onclick();
  assert.equal(ui.calls.filter(c=>c.params?.name==="settings.run_check").length,0);
  ui.elements.get("updateComponent").value="bsl-ls";await ui.elements.get("installUpdateButton").onclick();await ui.tick();
  assert.equal(ui.calls.filter(c=>c.params?.name==="settings.updates").length,1);
  assert.match(ui.elements.get("updatesResult").textContent,/BSL LS: установлена версия · v9.0.0/);
});

test("the searchable version picker keeps independent drafts without changing runtime settings", async () => {
  const values={...read.values,codeIndexVersion:"latest",bslLsVersion:"latest",bslLsAllowPrerelease:true};
  const ui=screen(async(name,args)=>{
    if(name==="settings.read"||name==="settings.status")return {...read,values:{...values}};
    if(name==="settings.versions")return {component:args.component,versions:args.component==="bsl-ls"?[{version:"v1.1.0-rc.7"},{version:"v1.0.7"}]:[{version:"v1.14.1"}]};
    throw new Error(name);
  });await ui.flush();assert.equal(ui.elements.get("versionValue").textContent,"latest");
  for(const id of ["codeIndexVersion","bslLsVersion","codeIndexAllowPrerelease","bslLsAllowPrerelease","saveVersionsButton"])assert.equal(ui.elements.has(id),false);
  ui.elements.get("updateComponent").value="bsl-ls";ui.elements.get("updateComponent").events.change();await ui.elements.get("versionButton").onclick();
  assert.deepEqual(ui.elements.get("versionOptions").children.map(option=>option.textContent),["latest","v1.1.0-rc.7","v1.0.7"]);
  ui.elements.get("versionSearch").value="rc.7";ui.elements.get("versionSearch").events.input();await ui.tick(8000);
  assert.equal(ui.elements.get("versionSearch").value,"rc.7");assert.equal(ui.elements.get("versionOptions").children.length,1);
  await ui.elements.get("versionOptions").children[0].onclick();assert.equal(ui.elements.get("versionValue").textContent,"v1.1.0-rc.7");assert.equal(ui.elements.get("versionPopup").hidden,true);
  ui.elements.get("updateComponent").value="code-index";ui.elements.get("updateComponent").events.change();assert.equal(ui.elements.get("versionValue").textContent,"latest");
  await ui.elements.get("versionButton").onclick();assert.deepEqual(ui.elements.get("versionOptions").children.map(option=>option.textContent),["latest","v1.14.1"]);
  ui.elements.get("updateComponent").value="bsl-ls";ui.elements.get("updateComponent").events.change();assert.equal(ui.elements.get("versionValue").textContent,"v1.1.0-rc.7");
  await ui.tick(8000);assert.equal(ui.elements.get("versionValue").textContent,"v1.1.0-rc.7");
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
  });await ui.flush();await ui.elements.get("versionButton").onclick();assert.match(ui.elements.get("versionHint").textContent,/offline/);
  await ui.elements.get("refreshVersionsButton").onclick();assert.equal(ui.elements.get("refreshVersionsButton").disabled,false);
  ui.elements.get("updateComponent").value="bsl-ls";ui.elements.get("updateComponent").events.change();const pending=ui.elements.get("versionButton").onclick();await ui.flush();
  ui.elements.get("updateComponent").value="code-index";ui.elements.get("updateComponent").events.change();await ui.elements.get("versionButton").onclick();finish();await pending;
  assert.deepEqual(ui.elements.get("versionOptions").children.map(option=>option.textContent),["latest","v1.14.1"]);
});

test("an empty BSL LS catalog shows a retry and refreshes the server instead of reporting latest as the full list", async () => {
  let attempts=0;
  const ui=screen(async(name,args)=>{
    if(name==="settings.read")return read;
    if(name==="settings.versions"){
      if(args.component==="code-index")return {component:"code-index",versions:[{version:"v1.14.1"}]};
      if(++attempts===1)return {component:"bsl-ls",versions:[]};
      assert.equal(args.refresh,true);return {component:"bsl-ls",versions:[{version:"v1.1.0-rc.7"},{version:"v1.0.7"}]};
    }throw new Error(name);
  });await ui.flush();await ui.elements.get("versionButton").onclick();
  ui.elements.get("updateComponent").value="bsl-ls";ui.elements.get("updateComponent").events.change();await ui.elements.get("versionButton").onclick();
  assert.match(ui.elements.get("versionHint").textContent,/пустой каталог/);assert.doesNotMatch(ui.elements.get("versionHint").textContent,/Найдено: 1/);
  assert.equal(ui.elements.get("refreshVersionsButton").disabled,false);await ui.elements.get("refreshVersionsButton").onclick();
  assert.deepEqual(ui.elements.get("versionOptions").children.map(option=>option.textContent),["latest","v1.1.0-rc.7","v1.0.7"]);
  assert.equal(ui.elements.get("refreshVersionsButton").disabled,false);
});

test("installation uses one authorized operation for the selected component", async () => {
  for(const component of ["code-index","bsl-ls"]){
    const ui=screen(async(name,args)=>{
      if(name==="settings.read")return read;
      if(name==="settings.updates"){assert.equal(args.operation,"install");assert.equal(args.component,component);assert.equal(args.version,"latest");assert.equal(args.authorization.scope,read.preparationScope);return {id:"install-update",status:"running"};}
      if(name==="settings.operation")return {id:"install-update",action:"updates",status:"completed",result:{component,state:"applied",release:"v1.0.0"}};
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
    assert.match(ui.elements.get("installHint").textContent,/latest: v1\.0\.7/);
    assert.match(ui.elements.get("installUpdateButton").title,/уже установлена/);
    const choose=async version=>{
      if(ui.elements.get("versionPopup").hidden)await ui.elements.get("versionButton").onclick();
      await ui.elements.get("versionOptions").children.find(option=>option.textContent===version).onclick();
    };
    await choose("v1.0.7");assert.equal(ui.elements.get("installUpdateButton").disabled,true);
    await choose("1.0.7");assert.equal(ui.elements.get("installUpdateButton").disabled,true);
    await choose("v2.0.0-rc.1");assert.equal(ui.elements.get("installUpdateButton").disabled,false);
    installed="v2.0.0-rc.1";await ui.tick(8000);
    assert.equal(ui.elements.get("installUpdateButton").disabled,true);
    await ui.elements.get("installUpdateButton").onclick();
    assert.equal(ui.calls.filter(call=>call.params?.name==="settings.updates").length,0);
    await choose("latest");assert.equal(ui.elements.get("installUpdateButton").disabled,false);
  }
});

test("an unresolved latest keeps installation disabled while exact versions remain usable", async () => {
  const ui=screen(async(name,args)=>{
    if(name==="settings.read")return {...read,installedVersions:{"code-index":"v1.0.0"}};
    if(name==="settings.versions")return {component:args.component,versions:[{version:"v1.0.0"},{version:"v2.0.0"}],latest:null,latestError:"HTTP 503"};
    throw new Error(name);
  });await ui.flush();await ui.elements.get("versionButton").onclick();
  assert.equal(ui.elements.get("installUpdateButton").disabled,true);
  assert.match(ui.elements.get("installHint").textContent,/Не удалось определить latest/);
  await ui.elements.get("versionOptions").children.find(option=>option.textContent==="v2.0.0").onclick();
  assert.equal(ui.elements.get("installUpdateButton").disabled,false);
});

test("an inconsistent saved pin can be repaired by installing the working version", async () => {
  let saved="v2.0.0";
  const ui=screen(async(name,args)=>{
    if(name==="settings.read")return {...read,values:{...read.values,codeIndexVersion:saved},installedVersions:{"code-index":"v1.0.0"}};
    if(name==="settings.versions")return {component:args.component,latest:"v2.0.0",versions:[{version:"v1.0.0"},{version:"v2.0.0"}]};
    if(name==="settings.updates"){assert.equal(args.version,"v1.0.0");return {id:"repair-pin",status:"running"};}
    if(name==="settings.operation"){saved="v1.0.0";return {id:"repair-pin",action:"updates",status:"completed",result:{component:"code-index",state:"applied",requested:saved,release:saved}};}
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
    if(name==="settings.operation")return {id:"failed-install",action:"updates",status:"failed",error:"Candidate rejected; active artifact retained: bad API"};
    throw new Error(name);
  });await ui.flush();await ui.elements.get("installUpdateButton").onclick();
  assert.match(ui.elements.get("status").textContent,/active artifact retained/);
  assert.doesNotMatch(ui.elements.get("updatesResult").textContent,/установлена версия/);
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.updates").length,1);
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
      if(attempts===2)return {id:"install-2",action:"updates",status:"failed",error:"offline"};
      saved="v1.0.0";return {id:"install-1",action:"updates",status:"completed",result:{component:"code-index",state:"applied",release:saved,requested:saved}};
    }
    throw new Error(name);
  });await ui.flush();await ui.elements.get("versionButton").onclick();
  await ui.elements.get("versionOptions").children.find(option=>option.textContent==="v1.0.0").onclick();
  assert.equal(saved,"v2.0.0");await ui.elements.get("installUpdateButton").onclick();
  assert.equal(saved,"v1.0.0");assert.match(ui.elements.get("updatesResult").textContent,/установлена версия · v1.0.0/);
  await ui.elements.get("installUpdateButton").onclick();assert.match(ui.elements.get("status").textContent,/offline/);
  assert.doesNotMatch(ui.elements.get("updatesResult").textContent,/установлена версия/);
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.update").length,0);
});

test("switching the update component hides unrelated results and scopes every action", async () => {
  const ui=screen(async(name,args)=>{
    if(name==="settings.read")return read;
    if(name==="settings.updates")return {id:args.operation,action:"updates",status:"completed"};
    if(name==="settings.operation")return {id:args.operationId,action:"updates",status:"completed",result:{component:"bsl-ls",state:"current"}};
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
  let probes = 0;
  const ui = screen(async (name) => {
    if (name === "settings.read") return read;
    if (name === "settings.probe_connections") { probes++; return { id: "probe", status: "running" }; }
    if (name === "settings.operation") return { projectRoot: read.values.projectRoot, instance: read.instance, id: "probe", status: "completed", action: "probe", result: { external: { edt: { configured: true, connected: true, repositories: [{ id: "product", matched: true, ready: false, state: "building" }] }, v8std: { configured: true, connected: true } } } };
    throw new Error(name);
  });
  await ui.flush(); await ui.elements.get("probeButton").onclick();
  assert.equal(probes, 1);
  assert.match(ui.elements.get("probeResult").textContent, /product: building/);
  assert.match(ui.elements.get("probeResult").textContent, /v8std: подключение проверено/);
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.run_check").length, 0);
});

test("manual settings require a fresh preview after editing and apply the reviewed text", async () => {
  const text = JSON.stringify({ format: "1c-ai-core-settings", version: 1, settings: { mcp: { managed: {} } } });
  const ui = screen(async (name, args) => {
    if(name === "settings.read") return read;
    if(name === "settings.edit") return { text, baseRevision: "loaded" };
    if(name === "settings.preview") { assert.equal(args.mode, "edit"); assert.equal(args.baseRevision, "loaded"); return { revision: "reviewed", projectRoot: read.values.projectRoot, repositories: [], openviking: { enabled: true, url: "https://knowledge.example/mcp", timeout_seconds: 4, max_response_bytes: 4096 } }; }
    if(name === "settings.apply") { assert.equal(args.text, text); assert.equal(args.revision, "reviewed"); assert.equal(args.mode, "edit"); assert.equal(args.baseRevision, "loaded"); return {}; }
    throw new Error(name);
  });
  await ui.flush();
  await ui.elements.get("editSettingsButton").onclick();
  assert.equal(ui.elements.get("settingsText").value, text);
  await ui.elements.get("reviewEditButton").onclick();
  assert.equal(ui.elements.get("preview").hidden, false);
  assert.equal(ui.elements.get("openvikingStatus").textContent, "Включён: https://knowledge.example/mcp · 4 с · 4096 байт");
  ui.elements.get("settingsText").events.input();
  await ui.elements.get("applyButton").onclick();
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.apply").length, 0);
  await ui.elements.get("reviewEditButton").onclick();
  await ui.elements.get("applyButton").onclick();
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.apply").length, 1);
  assert.equal(ui.elements.get("settingsText").value, "");
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
  await ui.flush();ui.elements.get("profileToggleButton").onclick();ui.elements.get("addProfileButton").onclick();
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
  await ui.tick(8000);
  assert.equal(ui.elements.get("projectRoot").value, nextRoot);
  assert.doesNotMatch(ui.elements.get("autoRefreshState").textContent, /Нет свежих данных/);
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
  await ui.tick(8000);assert.equal(typeof releaseStatus, "function");
  await ui.tick();assert.equal(ui.elements.get("profilePath").textContent, nextRoot);
  releaseStatus({ ...read, schema: {} });await ui.flush();
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
  assert.equal(ui.elements.get("saveButton").disabled, false);
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
    if (name === "settings.read") return read;
    if (name === "settings.run_check") return { id: "one", status: "running" };
    if (name === "settings.operation") return ++polls === 1
      ? { id: "one", action: "check", projectRoot: "C:/fixture/project", instance: "A", status: "running" }
      : { id: "one", action: "check", projectRoot: "C:/fixture/project", instance: "A", status: "completed", result: {
        managed: [{ name: "code-index", ready: false, state: "indexing" }, { name: "bsl-ls", ready: true }, { name: "policy", ready: true }], external: {} } };
    throw new Error(name);
  });
  await ui.flush();
  assert.equal(ui.elements.get("pickDirectoryButton").hidden, true);
  await ui.elements.get("checkButton").onclick();
  assert.equal(ui.elements.get("checkButton").disabled, true);
  await ui.tick();
  assert.equal(ui.elements.get("checkButton").disabled, false);
  const preparations = ui.calls.filter(call => call.params?.name === "settings.run_check");
  assert.equal(preparations.length, 1);
  assert.equal(JSON.stringify(preparations[0].params.arguments.authorization), JSON.stringify({
    scope: "C:/fixture/project#default", effects: ["launch"],
    evidence: "Пользователь нажал «Подготовить и проверить MCP» в экране настроек."
  }));
  assert.equal([...ui.timers.values()].filter(timer => timer.ms === 1000 || timer.ms === 5000).length, 0);
  assert.match(ui.elements.get("status").textContent, /Сводка обновляется автоматически/);
  const contents = element => [element.textContent, ...element.children.map(contents)].join(" ");
  const lines = contents(ui.elements.get("connections"));
  assert.match(lines, /Подключение к BSL LS и работа с проектами доступны/);
  assert.match(lines, /тестовых данных/);
});

test("an edited import cannot acquire the previous preview result", async () => {
  let release;
  const ui = screen(async name => {
    if (name === "settings.read") return read;
    if (name === "settings.preview") return new Promise(resolve => { release = resolve; });
    throw new Error(name);
  });
  await ui.flush();
  ui.elements.get("file").files = [{ size: 20, text: async () => "profile" }];
  const pending = ui.elements.get("previewButton").onclick();
  await ui.flush();
  assert.equal(ui.elements.get("file").disabled, true);
  ui.elements.get("file").events.change();
  release({ projectRoot: "C:/old", repositories: [] });
  await pending;
  assert.equal(ui.elements.get("preview").hidden, true);
  assert.match(ui.elements.get("status").textContent, /изменились во время проверки/);
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
  await ui.elements.get("checkButton").onclick();
  const preparation = ui.calls.find(call => call.params?.name === "settings.run_check");
  assert.equal(preparation.params.arguments.authorization.scope, "C:/other#second");
});

test("importing a profile does not assert a separate launch authorization", async () => {
  const ui = screen(async name => {
    if (name === "settings.read") return read;
    if (name === "settings.preview") return { projectRoot: "C:/fixture/project", repositories: [], revision: "one" };
    if (name === "settings.apply") return { values: read.values };
    throw new Error(name);
  });
  await ui.flush();
  ui.elements.get("file").files = [{ size: 20, text: async () => "profile" }];
  await ui.elements.get("previewButton").onclick();
  await ui.elements.get("applyButton").onclick();
  assert.equal(ui.elements.get("checkPanel").hidden, false);
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.run_check").length, 0);
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
  assert.equal(ui.elements.get("refreshButton").disabled, false);
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
  const readiness={state:"ready",checkedAt:"2026-10-22T12:00:00Z",checks:[{id:"edt",label:"EDT",state:"ready"},{id:"policy",label:"Политика",state:"ready"},{id:"skills",label:"Навыки",state:"ready"}]};
  const ui=screen(async(name,args)=>{
    if(name==="settings.read")return {...read,readiness:completed?readiness:{state:"not_checked"}};
    if(name==="settings.run_check"){assert.equal(args.authorization.scope,read.preparationScope);return {id:"ready-check",status:"running"};}
    if(name==="settings.operation"){completed=true;return {id:"ready-check",status:"completed",action:"check",result:{managed:[],external:{},readiness}};}
    throw new Error(name);
  });await ui.flush();assert.match(ui.elements.get("readinessTitle").textContent,/ещё не проверена/);
  await ui.elements.get("readinessButton").onclick();
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.run_check").length,1);
  assert.match(ui.elements.get("readinessTitle").textContent,/можно начинать работу/);
  assert.equal(ui.elements.get("readinessItems").children.length,3);
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
  const ui=screen(async()=>({...read,readiness:{state:"stale",checkedAt:"2026-10-22T12:00:00Z",reason:"Изменился порт EDT.",checks:[{id:"edt",label:"EDT",state:"ready"}]}}));
  await ui.flush();assert.match(ui.elements.get("readinessTitle").textContent,/повторить/);assert.match(ui.elements.get("readinessDetail").textContent,/Изменился порт/);
});

test("EDT port suggestion is adjacent, explicit, and saves only the instance URL", async () => {
  let saved,applied=false;
  const suggestion={configuredPort:8765,detectedPort:19801,url:"http://localhost:19801/mcp"};
  const ui=screen(async(name,args)=>{
    if(name==="settings.read")return {...read,values:{...read.values,edtUrl:applied?suggestion.url:"http://localhost:8765/mcp"},edtPortSuggestion:applied?null:suggestion};
    if(name==="settings.update"){saved=args.set;applied=true;return {};}
    throw new Error(name);
  });await ui.flush();assert.equal(ui.elements.get("edtPortHint").hidden,false);
  assert.match(ui.elements.get("edtPortText").textContent,/19801.*8765/);
  ui.elements.get("v8stdUrl").value="http://localhost:9000/mcp";ui.elements.get("v8stdUrl").events.input();
  await ui.elements.get("useEdtPortButton").onclick();
  assert.equal(JSON.stringify(saved),JSON.stringify({edtUrl:suggestion.url}));
  assert.equal(ui.elements.get("edtPortHint").hidden,true);assert.equal(ui.elements.get("v8stdUrl").value,"http://localhost:9000/mcp");
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
    if(name==="settings.operation")return {id:"rebuild",action:"rebuild_index",status:"completed",result:{repository:"ext",edtProject:"Extension",state:"ready"}};
    throw new Error(name);
  });await ui.flush();ui.elements.get("indexRepository").value="ext";await ui.elements.get("rebuildIndexButton").onclick();
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.rebuild_index").length,1);
  assert.match(ui.elements.get("status").textContent,/Extension.*пересоздан.*Готов/);
});

test("connection checks use unsaved fields without saving and preserve drafts", async () => {
  let checked;
  const ui=screen(async(name,args)=>{
    if(name==="settings.read")return {...read,values:{...read.values,edtUrl:"http://localhost:4000/mcp",v8stdUrl:"http://localhost:8000/mcp"}};
    if(name==="settings.probe_connections"){checked=args.connections;return {id:"draft-probe",status:"running"};}
    if(name==="settings.operation")return {projectRoot:read.values.projectRoot,instance:read.instance,id:"draft-probe",status:"completed",action:"probe",result:{external:{edt:{configured:true,connected:true},v8std:{configured:false,connected:false}}}};
    throw new Error(name);
  });await ui.flush();
  ui.elements.get("edtUrl").value="http://localhost:4001/mcp";ui.elements.get("edtUrl").events.input();
  ui.elements.get("v8stdUrl").value="";ui.elements.get("v8stdUrl").events.input();
  await ui.elements.get("probeButton").onclick();
  assert.equal(JSON.stringify(checked),JSON.stringify({edt:"http://localhost:4001/mcp",v8std:""}));
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
  const field = ui.elements.get("openvikingUrl"); field.value = "https://draft.example/mcp"; field.events.input();
  ui.elements.get("settingsText").value = "draft document"; ui.elements.get("settingsText").events.input();
  await ui.elements.get("probeButton").onclick(); await ui.tick(1000);
  finished = true; await ui.tick(1000);
  assert.equal(checked.url, "https://draft.example/mcp");
  assert.equal(field.value, "https://draft.example/mcp");
  assert.equal(ui.elements.get("settingsText").value, "draft document");
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.probe_connections").length, 1);
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.update").length, 0);
  assert.match(ui.elements.get("probeResult").textContent, /publication missing/);
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
  await ui.elements.get("saveButton").onclick();
  assert.equal(JSON.stringify(written), JSON.stringify({ v8stdUrl: "http://localhost:8001/mcp" }));
});

test("a replacement needs confirmation and carries the reviewed revision", async () => {
  let applied;
  const ui = screen(async (name, args) => {
    if (name === "settings.read") return read;
    if (name === "settings.preview") return { projectRoot: read.values.projectRoot, repositories: [], replacesProfile: true, revision: "reviewed" };
    if (name === "settings.apply") { applied = args; return {}; }
    throw new Error(name);
  });
  await ui.flush();
  ui.elements.get("file").files = [{ name: "profile.yaml", size: 20, text: async () => "profile" }];
  await ui.elements.get("previewButton").onclick();
  await ui.elements.get("applyButton").onclick();
  assert.equal(applied, undefined);
  assert.match(ui.elements.get("status").textContent, /Подтвердите/);
  ui.elements.get("replace").checked = true;
  await ui.elements.get("applyButton").onclick();
  assert.equal(applied.revision, "reviewed");assert.equal(applied.replace, true);
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
  assert.equal(ui.elements.get("checkButton").disabled, true);
  assert.equal(ui.elements.get("pickDirectoryButton").disabled, true);
  assert.equal(ui.elements.has("operationButton"), false);
  assert.match(ui.elements.get("status").textContent, /системный выбор папки/);
  selected = true;
  await ui.tick();
  assert.equal(ui.elements.get("profileTitle").textContent, "selected-profile");
  assert.equal(ui.elements.get("refreshButton").disabled, false);
  assert.equal(ui.elements.get("checkButton").disabled, false);
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
  await ui.elements.get("checkButton").onclick();
  assert.equal(ui.elements.get("checkButton").disabled, true);
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
  await ui.elements.get("loadButton").onclick();
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.read").length, 2);
  assert.equal(ui.elements.get("profilePanel").hidden, false);
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
    if (name === "settings.load") { running = false; return {}; }
    throw new Error(name);
  });
  await ui.flush();
  assert.equal(ui.elements.get("indexSummary").textContent, "Не запущен");
  assert.equal(ui.elements.get("bslSummary").textContent, "Отключён");
  await ui.context.selectProfile("C:/fixture/other");
  assert.equal(ui.elements.get("indexSummary").textContent, "Процесс работает");
  await ui.elements.get("loadButton").onclick();
  assert.equal(ui.elements.get("indexSummary").textContent, "Не запущен");
  assert.match(ui.elements.get("autoRefreshState").textContent, /Автообновление/);
  assert.equal(ui.calls.filter(call => ["settings.status", "settings.run_check", "settings.probe_connections"].includes(call.params?.name)).length, 0);
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
  assert.equal(ui.elements.get("indexSummary").textContent, "Индекс актуален");
  assert.equal(ui.elements.get("bslSummary").textContent, "API доступен");
  assert.equal(ui.elements.get("connections").hidden, false);
  assert.match(contents(ui.elements.get("connections")), /API доступен/);
  assert.match(contents(ui.elements.get("connections")), /Product: готов/);
  const detail=ui.elements.get("connections").children[1];detail.open=true;
  await ui.tick(8000);assert.equal(ui.elements.get("connections").children[1],detail);
  stale = true; await ui.tick(8000);
  assert.equal(ui.elements.get("indexSummary").textContent, "Не запущен");
  assert.equal(ui.elements.get("bslSummary").textContent, "Проверка устарела");
  assert.doesNotMatch(contents(ui.elements.get("connections")), /API доступен|Индекс актуален/);
  assert.doesNotMatch(contents(ui.elements.get("connections")), /Product: готов/);
  assert.match(contents(ui.elements.get("connections")), /Проверка устарела/);
  assert.equal(ui.elements.get("connections").children[1].open,true);
  await ui.context.selectProfile("C:/fixture/other");
  assert.equal(ui.elements.get("bslSummary").textContent,"API доступен");
  assert.equal(ui.elements.get("connections").children[1].open,false);
  assert.equal(ui.calls.filter(call=>["settings.run_check","settings.probe_connections"].includes(call.params?.name)).length,0);
});

test("loading, selecting and reloading profiles run live readiness checks without a button click", async () => {
  let projectRoot=read.values.projectRoot,verified=false,checks=0,release;
  const snapshot=()=>({...read,values:{...read.values,projectRoot},preparationScope:projectRoot+"#default",instance:"default",
    readiness:{state:verified?"ready":"stale",checks:[]},summary:{components:[{id:"code-index",status:verified?"ready":"stopped"},{id:"bsl-ls",status:verified?"ready":"check_stale"}]}});
  const ui=screen(async(name,args)=>{
    if(name==="settings.read"||name==="settings.status")return snapshot();
    if(name==="settings.refresh_readiness"){checks++;assert.equal(args.scope,projectRoot+"#default");assert.equal(args.authorization,undefined);return {id:"observe-"+checks,action:"refresh_readiness",status:"running"};}
    if(name==="settings.operation"){await new Promise(resolve=>{release=resolve;});verified=true;return {id:args.operationId,action:"refresh_readiness",projectRoot,instance:"default",status:"completed",result:{managed:[],external:{}}};}
    if(name==="settings.select_profile"){projectRoot=args.projectRoot;verified=false;return snapshot();}
    if(name==="settings.load"){verified=false;return {};}
    throw new Error(name);
  });
  await ui.flush();assert.equal(checks,1);assert.match(ui.elements.get("readinessTitle").textContent,/Обновляем готовность/);
  release();await ui.flush();
  assert.equal(ui.elements.get("indexSummary").textContent,"Индекс актуален");assert.equal(ui.elements.get("bslSummary").textContent,"API доступен");
  assert.match(ui.elements.get("readinessTitle").textContent,/можно начинать работу/);
  await ui.tick(8000);await ui.tick(8000);assert.equal(checks,1);
  const selected=ui.context.selectProfile("C:/fixture/other");await ui.flush();assert.equal(checks,2);release();await selected;
  const reloaded=ui.elements.get("loadButton").onclick();await ui.flush();assert.equal(checks,3);release();await reloaded;
  ui.document.hidden=true;ui.documentEvents.visibilitychange();ui.document.hidden=false;ui.documentEvents.visibilitychange();await ui.flush();assert.equal(checks,4);release();await ui.flush();
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.run_check").length,0);
});

test("automatic readiness defers drafts, skips viewed profiles and follows an existing check", async () => {
  let ready=false,checks=0;
  const current=()=>({...read,instance:"default",readiness:{state:ready?"ready":"stale",checks:[]}});
  const ui=screen(async(name,args)=>{
    if(name==="settings.read"||name==="settings.status")return current();
    if(name==="settings.refresh_readiness"){checks++;return {id:"observe",action:"refresh_readiness",status:"running"};}
    if(name==="settings.operation"){ready=true;return {id:"observe",action:"refresh_readiness",status:"completed",result:{managed:[],external:{}}};}
    if(name==="settings.select_profile")return {...current(),values:{projectRoot:args.projectRoot},preparationScope:args.projectRoot+"#default",viewOnly:true};
    throw new Error(name);
  });await ui.flush();assert.equal(checks,1);
  ui.elements.get("edtUrl").value="draft";ui.elements.get("edtUrl").events.input();
  await ui.elements.get("refreshButton").onclick();await ui.tick(8000);assert.equal(checks,1);assert.equal(ui.elements.get("edtUrl").value,"draft");
  ui.elements.get("discardDraftButton").onclick();await ui.flush();assert.equal(checks,2);
  await ui.context.selectProfile("C:/foreign");assert.equal(checks,2);
  const running=screen(async name=>{
    if(name==="settings.read")return {...current(),operation:{id:"existing",action:"check",status:"running"}};
    if(name==="settings.operation")return {id:"existing",action:"check",status:"running"};
    throw new Error(name);
  });await running.flush();assert.equal(running.calls.filter(call=>call.params?.name==="settings.refresh_readiness").length,0);
  assert.equal(running.calls.filter(call=>call.params?.name==="settings.operation").length,1);
});

test("automatic checks leave navigation and drafts usable and do not release another action's busy state", async () => {
  let releaseCheck,releaseEditor,verified=false;
  const ui=screen(async name=>{
    if(name==="settings.read")return {...read,instance:"default",values:{...read.values,edtUrl:"saved"},readiness:{state:verified?"ready":"stale",checks:[]}};
    if(name==="settings.refresh_readiness")return {id:"background",action:"refresh_readiness",status:"running"};
    if(name==="settings.operation"){await new Promise(resolve=>{releaseCheck=resolve;});verified=true;return {id:"background",action:"refresh_readiness",projectRoot:read.values.projectRoot,instance:"default",status:"completed",result:{managed:[],external:{}}};}
    if(name==="settings.edit"){await new Promise(resolve=>{releaseEditor=resolve;});return {text:"{}",baseRevision:"document"};}
    if(name==="settings.versions")return {versions:[]};
    throw new Error(name);
  });await ui.flush();
  for(const id of ["profileTab","checkTab","editorTab","edtUrl","bslLsEnabled","selectProfileButton"])assert.equal(ui.elements.get(id).disabled,false,id);
  for(const id of ["saveButton","readinessButton","installUpdateButton"])assert.equal(ui.elements.get(id).disabled,true,id);
  ui.elements.get("edtUrl").value="draft";ui.elements.get("edtUrl").events.input();
  ui.elements.get("checkTab").onclick();assert.equal(ui.elements.get("checkPanel").hidden,false);
  const editing=ui.elements.get("editSettingsButton").onclick();await ui.flush();
  releaseCheck();await ui.flush();assert.equal(ui.elements.get("edtUrl").disabled,true,"document loading still owns its busy state");
  releaseEditor();await editing;assert.equal(ui.elements.get("edtUrl").disabled,false);assert.equal(ui.elements.get("edtUrl").value,"draft");
});

test("a profile can be selected while the previous automatic check is still running", async () => {
  const scopes=[];let projectRoot=read.values.projectRoot,operationRoot=projectRoot,release,releaseStart,running=false;
  const snapshot=()=>({...read,values:{projectRoot},instance:"default",preparationScope:projectRoot+"#default",readiness:{state:"stale",checks:[]},operation:running?{id:"background",action:"refresh_readiness",projectRoot:operationRoot,instance:"default",status:"running"}:{status:"idle"}});
  const ui=screen(async(name,args)=>{
    if(name==="settings.read")return snapshot();
    if(name==="settings.refresh_readiness"){scopes.push(args.scope);operationRoot=projectRoot;running=true;if(scopes.length===2)await new Promise(resolve=>{releaseStart=resolve;});return {id:"background",action:"refresh_readiness",projectRoot:operationRoot,instance:"default",status:"running"};}
    if(name==="settings.operation"){const root=operationRoot;await new Promise(resolve=>{release=resolve;});running=false;return {id:"background",action:"refresh_readiness",projectRoot:root,instance:"default",status:"completed",result:{managed:[],external:{}}};}
    if(name==="settings.select_profile"){projectRoot=args.projectRoot;return snapshot();}
    throw new Error(name);
  });await ui.flush();assert.deepEqual(scopes,[read.preparationScope]);
  await ui.context.selectProfile("C:/next-profile");assert.equal(ui.elements.get("projectRoot").value,"C:/next-profile");assert.equal(scopes.length,1);
  assert.equal(ui.elements.get("edtUrl").disabled,false);
  release();await ui.flush();assert.deepEqual(scopes,[read.preparationScope,"C:/next-profile#default"]);
  assert.equal(ui.elements.get("readinessButton").disabled,true,"the previous check cannot release the new check's startup lock");
  releaseStart();await ui.flush();
  release();await ui.flush();assert.equal(ui.elements.get("projectRoot").value,"C:/next-profile");
});

test("a late refresh from the previous automatic check cannot undo a completed profile selection", async () => {
  const firstRoot=read.values.projectRoot,secondRoot="C:/selected-profile",scopes=[];let reads=0,releaseCheck,releaseRead,releaseSelection;
  const snapshot=root=>({...read,values:{projectRoot:root},instance:"default",preparationScope:root+"#default",readiness:{state:"stale",checks:[]},operation:{status:"completed"}});
  const ui=screen(async(name,args)=>{
    if(name==="settings.read"){reads++;if(reads===2)return new Promise(resolve=>{releaseRead=()=>resolve(snapshot(firstRoot));});return snapshot(reads===1?firstRoot:secondRoot);}
    if(name==="settings.refresh_readiness"){scopes.push(args.scope);return {id:args.scope,action:"refresh_readiness",projectRoot:args.scope.split("#")[0],instance:"default",status:"running"};}
    if(name==="settings.operation"){const root=args.operationId.split("#")[0];await new Promise(resolve=>{releaseCheck=resolve;});return {id:args.operationId,action:"refresh_readiness",projectRoot:root,instance:"default",status:"completed",result:{managed:[],external:{}}};}
    if(name==="settings.select_profile")return new Promise(resolve=>{releaseSelection=()=>resolve(snapshot(secondRoot));});
    throw new Error(name);
  });await ui.flush();
  const selecting=ui.context.selectProfile(secondRoot);await ui.flush();releaseCheck();await ui.flush();assert.equal(typeof releaseRead,"function");
  releaseSelection();await selecting;assert.equal(ui.elements.get("projectRoot").value,secondRoot);
  releaseRead();await ui.flush();assert.equal(ui.elements.get("projectRoot").value,secondRoot);assert.deepEqual(scopes,[firstRoot+"#default",secondRoot+"#default"]);
  releaseCheck();await ui.flush();
});

test("missing startup freshness is retried automatically with a bounded per-profile budget", async () => {
  let checks=0;
  const ui=screen(async name=>{
    if(name==="settings.read"||name==="settings.status")return {...read,instance:"default",readiness:{state:"blocked",checks:[]}};
    if(name==="settings.refresh_readiness"){checks++;return {id:"settling",action:"refresh_readiness",status:"running"};}
    if(name==="settings.operation")return {id:"settling",action:"refresh_readiness",projectRoot:read.values.projectRoot,instance:"default",status:"completed",result:{managed:[{name:"code-index",state:"not_checked",ready:false,retryable:true}],external:{}}};
    throw new Error(name);
  });await ui.flush();assert.equal(checks,1);
  for(let attempt=0;attempt<10;attempt++)await ui.tick(8000);
  assert.equal(checks,4,"initial observation plus three retries; status polling does not reset the budget");
  ui.document.hidden=true;ui.documentEvents.visibilitychange();ui.document.hidden=false;ui.documentEvents.visibilitychange();await ui.flush();
  for(let attempt=0;attempt<10;attempt++)await ui.tick(8000);
  assert.equal(checks,8,"returning to the form starts a new bounded cycle");
});

test("an existing readiness check completed on the first poll does not trigger another check", async () => {
  let completed=false;
  const ui=screen(async name=>{
    if(name==="settings.read")return {...read,instance:"default",readiness:{state:completed?"ready":"stale",checks:[]},operation:completed?{status:"completed"}:{id:"existing",action:"check",status:"running"}};
    if(name==="settings.operation"){completed=true;return {id:"existing",action:"check",projectRoot:read.values.projectRoot,instance:"default",status:"completed",result:{managed:[],external:{}}};}
    throw new Error(name);
  });await ui.flush();
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.operation").length,1);
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.refresh_readiness").length,0);
});

test("echoed automatic check results keep the selected settings view without restarting polling", async () => {
  const ui=screen(async name=>{
    if(name==="settings.read")return {...read,instance:"default",readiness:{state:"ready",checks:[]}};
    if(name==="settings.refresh_readiness")return {id:"automatic",action:"refresh_readiness",status:"running"};
    if(name==="settings.operation")return {id:"automatic",action:"refresh_readiness",mode:"operation",navigation:"project",projectRoot:read.values.projectRoot,instance:"default",status:"completed",result:{managed:[],external:{}}};
    throw new Error(name);
  },{echo:true});await ui.flush();
  assert.equal(ui.elements.get("profileBrowser").hidden,false);assert.equal(ui.elements.get("profilePanel").hidden,false);
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.operation").length,1);
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.refresh_readiness").length,1);
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

test("a host scope change during a check queues readiness for the new profile", async () => {
  const firstRoot=read.values.projectRoot,secondRoot="C:/new-host-root",scopes=[];
  let projectRoot=firstRoot,operationRoot=firstRoot,finished=false;
  const snapshot=()=>({...read,values:{projectRoot},instance:"default",preparationScope:projectRoot+"#default",readiness:{state:"stale",checks:[]},operation:{id:"check",action:"refresh_readiness",projectRoot:operationRoot,instance:"default",status:finished?"completed":"running"}});
  const ui=screen(async(name,args)=>{
    if(name==="settings.read")return {...snapshot(),operation:{status:"idle"}};
    if(name==="settings.status")return snapshot();
    if(name==="settings.refresh_readiness"){scopes.push(args.scope);operationRoot=projectRoot;return {id:"check",action:"refresh_readiness",projectRoot:operationRoot,instance:"default",status:"running"};}
    if(name==="settings.operation")return {id:"check",action:"refresh_readiness",projectRoot:operationRoot,instance:"default",status:finished?"completed":"running",...(finished?{result:{managed:[],external:{}}}:{})};
    throw new Error(name);
  });await ui.flush();assert.deepEqual(scopes,[firstRoot+"#default"]);
  projectRoot=secondRoot;await ui.context.refreshStatus();assert.equal(ui.elements.get("projectRoot").value,secondRoot);assert.equal(scopes.length,1);
  finished=true;await ui.tick();await ui.flush();assert.deepEqual(scopes,[firstRoot+"#default",secondRoot+"#default"]);
});

test("indexing is checked again automatically until ready, and retries respect drafts and profile scope", async () => {
  let checks=0,projectRoot=read.values.projectRoot,state="indexing",viewOnly=false;
  const snapshot=()=>({...read,values:{projectRoot},instance:"default",viewOnly,preparationScope:projectRoot+"#default",readiness:{state:state==="ready"?"ready":"blocked",checks:[]}});
  const ui=screen(async(name,args)=>{
    if(name==="settings.read"||name==="settings.status")return snapshot();
    if(name==="settings.refresh_readiness"){checks++;return {id:"observe",action:"refresh_readiness",status:"running"};}
    if(name==="settings.operation")return {id:"observe",action:"refresh_readiness",projectRoot,instance:"default",status:"completed",result:{managed:[{name:"code-index",ready:state==="ready",state}],external:{}}};
    if(name==="settings.select_profile"){projectRoot=args.projectRoot;viewOnly=true;return snapshot();}
    throw new Error(name);
  });await ui.flush();assert.equal(checks,1);
  const retry=[...ui.timers.entries()].find(([,timer])=>timer.ms===8000);assert.ok(retry);ui.timers.delete(retry[0]);retry[1].fn();await ui.flush();assert.equal(checks,2);
  ui.elements.get("edtUrl").value="draft";ui.elements.get("edtUrl").events.input();
  await ui.tick(8000);await ui.tick(8000);assert.equal(checks,2);
  state="ready";ui.elements.get("discardDraftButton").onclick();await ui.flush();assert.equal(checks,3);
  await ui.tick(8000);assert.equal(checks,3);assert.match(ui.elements.get("readinessTitle").textContent,/можно начинать работу/);
  state="indexing";await ui.elements.get("refreshButton").onclick();assert.equal(checks,4);
  const oldRetry=[...ui.timers.values()].find(timer=>timer.ms===8000);
  await ui.context.selectProfile("C:/view-only");await ui.tick(8000);assert.equal(checks,4);
  oldRetry.fn();await ui.flush();assert.equal(checks,4);
  ui.lifecycle.pagehide();assert.equal([...ui.timers.values()].filter(timer=>[1000,8000].includes(timer.ms)).length,0);
});

test("automatic observation preserves drafts and never repeats preparation or external probes", async () => {
  let observations=0;
  const ui=screen(async name=>{
    if(name==="settings.read")return {...read,values:{...read.values,edtUrl:"inherited",codeIndexEnabled:true}};
    if(name==="settings.status"){observations++;return {...read,values:{...read.values,edtUrl:"changed-on-disk",codeIndexEnabled:true},summary:{observedAt:"2026-10-21T12:00:00Z",components:[{id:"code-index",status:"running"}]}};}
    throw new Error(name);
  });
  await ui.flush();
  ui.elements.get("edtUrl").value="draft";ui.elements.get("edtUrl").events.input();
  ui.elements.get("codeIndexEnabled").checked=false;ui.elements.get("codeIndexEnabled").events.change();
  await ui.tick(8000);await ui.tick(8000);
  assert.equal(observations,2);
  assert.equal(ui.elements.get("edtUrl").value,"draft");assert.equal(ui.elements.get("codeIndexEnabled").checked,false);
  assert.equal(ui.elements.get("indexSummary").textContent,"Процесс работает");
  assert.equal(ui.calls.filter(call=>["settings.run_check","settings.probe_connections","settings.update"].includes(call.params?.name)).length,0);
  ui.elements.get("discardDraftButton").onclick();
  assert.equal(ui.elements.get("edtUrl").value,"changed-on-disk");
});

test("observation pauses for hidden windows, ignores late closed responses and does not overlap", async () => {
  let release;
  const ui=screen(async name=>name==="settings.read"?read:new Promise(resolve=>{release=resolve;}));
  await ui.flush();ui.document.hidden=true;ui.documentEvents.visibilitychange();
  assert.equal([...ui.timers.values()].filter(timer=>timer.ms===8000).length,0);
  ui.document.hidden=false;ui.documentEvents.visibilitychange();await ui.flush();
  assert.equal([...ui.timers.values()].filter(timer=>timer.ms===8000).length,0);
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.status").length,1);
  await ui.context.refreshStatus();
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.status").length,1);
  ui.lifecycle.pagehide();release({...read,profile:{status:"loaded",projectId:"Late"}});await ui.flush();
  assert.equal(ui.elements.get("profileTitle").textContent,"Project");
  assert.equal([...ui.timers.values()].filter(timer=>timer.ms===8000).length,0);
});

test("the profile chooser gates scoped settings until a profile is loaded", async () => {
  const ui=screen(async name=>{assert.equal(name,"settings.read");return {...read,profile:{status:"missing"}};});
  await ui.flush();assert.equal(ui.elements.get("connectionSettings").hidden,true);
  for(const id of ["saveButton","checkButton","saveComponentsButton","downloadButton"])assert.equal(ui.elements.get(id).disabled,true);
  assert.equal(ui.elements.get("createButton").hidden,false);assert.equal(ui.elements.get("previewButton").disabled,false);
});

test("history previews another profile read-only without selecting it for chat operations", async () => {
  const other={...read,values:{...read.values,projectRoot:"C:/fixture/other"},profile:{...read.profile,projectId:"Other"},viewOnly:true};
  const ui=screen(async(name,args)=>{
    if(name==="settings.read")return {...read,profileHistory:[{projectRoot:other.values.projectRoot,projectId:"Other",status:"loaded",repositoryCount:2}]};
    if(name==="settings.select_profile"||name==="settings.status"){assert.equal(args.projectRoot,other.values.projectRoot);return other;}
    if(name==="settings.document"){assert.equal(args.projectRoot,other.values.projectRoot);return {text:"history-profile-document",baseRevision:"history"};}
    throw new Error(name);
  });
  await ui.flush();await ui.elements.get("profileHistory").children.find(item=>item.children[0].textContent==="Other").onclick();
  assert.equal(ui.elements.get("profileTitle").textContent,"Other");assert.equal(ui.elements.get("viewOnlyHint").hidden,false);
  for(const id of ["saveButton","probeButton","checkButton","downloadButton"])assert.equal(ui.elements.get(id).disabled,true);
  assert.equal(ui.elements.get("editSettingsButton").disabled,false);
  assert.equal(ui.elements.get("settingsText").readOnly,true);
  ui.elements.get("editorTab").onclick();await ui.flush();
  assert.equal(ui.elements.get("settingsText").value,"history-profile-document");
  assert.equal(ui.elements.get("settingsText").disabled,false);
  await ui.tick(8000);assert.equal(ui.calls.filter(call=>call.params?.name==="settings.update").length,0);
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
  const cards = ui.elements.get("profileHistory").children;
  assert.equal(cards.find(card => card.children[0].textContent === "Project").children[2].textContent, "EDT-проектов: 2");
  assert.equal(cards.find(card => card.children[0].textContent === "Other").children[2].textContent, "EDT-проектов: 0");
  assert.equal(cards.find(card => card.children[0].textContent === "Old").children[2].textContent, "EDT-проектов: —");
  assert.equal(ui.elements.get("profileEdtProjectCount").textContent, "EDT-проектов: 2");
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
  assert.equal(ui.elements.get("saveButton").disabled,false);
});

test("history search filters names and paths without losing profile state", async () => {
  const ui=screen(async()=>({...read,profileHistory:[{projectRoot:"C:/Archive/Old",projectId:"Old",status:"unavailable",repositoryCount:3}]}));
  await ui.flush();ui.elements.get("historySearch").value="archive";ui.elements.get("historySearch").events.input();
  const entries=ui.elements.get("profileHistory").children;
  assert.equal(entries.length,1);assert.equal(entries[0].disabled,true);assert.equal(entries[0].children[3].textContent,"Каталог недоступен");
  ui.elements.get("historySearch").value="absent";ui.elements.get("historySearch").events.input();
  assert.equal(ui.elements.get("historyEmpty").textContent,"Профили не найдены.");
});

test("a failed automatic observation retries and keeps the last successful profile visible", async () => {
  let attempts=0;
  const ui=screen(async name=>{if(name==="settings.read")return read;if(name==="settings.status"&&++attempts===1)throw new Error("offline");return {...read,summary:{observedAt:"2026-10-21T12:00:00Z",components:[]}};});
  await ui.flush();await ui.tick(8000);assert.match(ui.elements.get("autoRefreshState").textContent,/Нет свежих данных/);
  assert.equal(ui.elements.get("profileTitle").textContent,"Project");await ui.tick(8000);
  assert.equal(attempts,2);assert.match(ui.elements.get("autoRefreshState").textContent,/Автообновление/);
});

test("keyboard navigation skips unavailable profile tabs and dirty drafts guard the folder picker", async () => {
  const ui=screen(async()=>({...read,profile:{status:"missing"},schema:{}}));await ui.flush();
  ui.elements.get("profileTab").events.keydown({key:"ArrowRight",preventDefault(){}});
  assert.equal(ui.elements.get("importPanel").hidden,false);
  ui.elements.get("settingsText").value="draft";ui.elements.get("settingsText").events.input();
  await ui.elements.get("pickDirectoryButton").onclick();
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.pick_directory").length,0);
  assert.match(ui.elements.get("status").textContent,/Сохраните изменения/);
});

test("chat settings hide profile navigation and never restore or select another profile", async () => {
  const ui=screen(async name=>{assert.equal(name,"settings.read");return {...read,values:{projectRoot:""},profile:{status:"unselected"},profileHistory:[{projectRoot:"C:/other",status:"loaded"}]};},{navigation:"project"});
  await ui.flush();assert.equal(ui.elements.get("profileBrowser").hidden,true);
  assert.equal(ui.elements.get("projectRoot").readOnly,true);assert.equal(ui.elements.get("pickDirectoryButton").hidden,true);
  ui.elements.get("projectRoot").value="C:/other";await ui.elements.get("selectProfileButton").onclick();
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.select_profile").length,0);
  assert.equal(ui.elements.get("emptyTitle").textContent,"Проект чата не определён");
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

test("narrow full settings use an overlay drawer without replacing or changing the selected profile", async () => {
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
  ui.media.matches=false;ui.media.listener();assert.equal(ui.elements.get("profileBrowser").hidden,false);
  assert.equal(ui.elements.get("profileToggleButton").hidden,true);
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.select_profile").length,0);
});

test("the full settings workspace restores the most recent available profile without a folder dialog", async () => {
  const ui=screen(async(name,args)=>{
    if(name==="settings.read")return {...read,values:{projectRoot:""},profile:{status:"unselected"},schema:{},profileHistory:[{projectRoot:"C:/gone",status:"unavailable"},{projectRoot:read.values.projectRoot,status:"loaded"}]};
    assert.equal(name,"settings.select_profile");assert.equal(args.projectRoot,read.values.projectRoot);return read;
  });await ui.flush();
  assert.equal(ui.elements.get("profileBrowser").hidden,false);assert.equal(ui.elements.get("profileTitle").textContent,"Project");
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.pick_directory").length,0);
});

test("import uses its selected file even after an unchanged editor document has been loaded", async () => {
  const ui=screen(async(name,args)=>{
    if(name==="settings.read")return read;
    if(name==="settings.edit")return {text:"editor-document",baseRevision:"editor-base"};
    if(name==="settings.preview"){assert.equal(args.text,"import-document");assert.equal(args.mode,undefined);return {revision:"import-revision",projectRoot:read.values.projectRoot,repositories:[]};}
    if(name==="settings.apply"){assert.equal(args.text,"import-document");assert.equal(args.mode,undefined);assert.equal(args.revision,"import-revision");return {};}
    throw new Error(name);
  });await ui.flush();await ui.elements.get("editSettingsButton").onclick();
  assert.equal(ui.elements.get("unsavedHint").hidden,true);
  ui.elements.get("file").files=[{size:10,text:async()=>"import-document"}];await ui.elements.get("previewButton").onclick();await ui.elements.get("applyButton").onclick();
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.apply").length,1);
});

test("diagnostics show and filter safe text, stay available during an operation, and refresh without repeating it", async () => {
  let logs=0;const operation={id:"pending",action:"check",status:"running"};
  const data={events:[{time:"2026-10-22T10:01:00Z",level:"error",component:"edt",event:"<failure>",detail:{message:"ECONNREFUSED"}},{time:"2026-10-22T10:00:00Z",level:"info",component:"settings",event:"opened",detail:{}}],total:2,runtime:{plugin:"1.0.0",node:"v24",platform:"win32",architecture:"x64"},session:{instance:"A",operation,logger:{dropped:0}},paths:{state:"C:/state"},observedAt:"2026-10-22T10:01:00Z"};
  const ui=screen(async name=>{if(name==="settings.read"||name==="settings.status")return {...read,operation};if(name==="settings.operation")return operation;if(name==="settings.diagnostics"){logs++;return data;}throw new Error(name);});await ui.flush();
  ui.elements.get("supportTab").onclick();await ui.flush();assert.equal(logs,1);
  assert.equal(ui.elements.get("diagnosticsRefreshButton").disabled,false);assert.equal(ui.elements.get("diagnosticJournal").children.length,2);
  assert.equal(ui.elements.get("diagnosticJournal").children[0].children[0].children[2].textContent,"edt · <failure>");
  ui.elements.get("logLevel").value="error";ui.elements.get("logLevel").events.change();assert.equal(ui.elements.get("diagnosticJournal").children.length,1);
  ui.elements.get("logSearch").value="absent";ui.elements.get("logSearch").events.input();assert.match(ui.elements.get("diagnosticJournal").children[0].textContent,/Нет записей/);
  await ui.elements.get("diagnosticsRefreshButton").onclick();assert.equal(logs,2);
  await ui.tick(8000);assert.equal(logs,3);
  ui.elements.get("profileTab").onclick();await ui.tick(8000);assert.equal(logs,3);
  assert.equal(ui.calls.filter(call=>call.params?.name==="settings.run_check").length,0);
});
