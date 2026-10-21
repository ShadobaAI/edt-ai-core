import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const html = fs.readFileSync(new URL("../ui/settings.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function screen(handler, options = {}) {
  const elements = new Map(), timers = new Map(), calls = [];
  let nextTimer = 0, message, observedResize;
  class Element {
    constructor(tag = "div") { Object.assign(this, { tag, disabled: false, readOnly: false, hidden: false, value: "", files: [], textContent: "", children: [], events: {} }); }
    classList = { toggle() {} };
    addEventListener(name, fn) { this.events[name] = fn; }
    setAttribute(key, value) { (this.attributes ||= {})[key] = value; }
    replaceChildren(...children) { this.children = children; }
    append(...children) { this.children.push(...children); }
    click() {}
    focus() {}
    getBoundingClientRect() { return { height: options.height?.() ?? 500 }; }
  }
  for (const match of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g)) { const element = new Element(match[1]); element.id = match[2]; elements.set(match[2], element); }
  const parent = { postMessage(request) {
    calls.push(request);
    if (!request.id) return;
    Promise.resolve().then(async () => {
      let result;
      try {
        const data = request.method === "ui/initialize" ? { hostInfo: { name: "fixture" }, hostContext: options.hostContext } : await handler(request.params.name, request.params.arguments);
        result = request.method === "ui/initialize" ? data : { structuredContent: data };
      } catch (error) { result = { isError: true, content: [{ type: "text", text: error.message }] }; }
      const deliver = data => message({ source: parent, origin: "https://fixture.invalid", data });
      if (options.echo && request.method === "tools/call") deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: result });
      deliver({ jsonrpc: "2.0", id: request.id, result });
      if (options.echo && request.method === "tools/call") deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: result });
    });
  } };
  const document = { getElementById: id => elements.get(id), createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag),
    querySelector: () => new Element("main"), body: new Element("body"),
    querySelectorAll: () => [...elements.values()].filter(element => ["button", "input"].includes(element.tag)),
    documentElement: { scrollHeight: 500, style: { setProperty() {} }, setAttribute() {} } };
  const context = vm.createContext({ document, window: { parent, addEventListener: (_, listener) => { message = listener; } },
    setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id),
    getComputedStyle: () => ({ paddingTop: "20px", paddingBottom: "20px" }),
    ResizeObserver: class { constructor(callback) { observedResize = callback; } observe() {} },
    Blob, URL: { createObjectURL: () => "blob:fixture", revokeObjectURL() {} } });
  vm.runInContext(script, context);
  const flush = () => new Promise(resolve => setImmediate(resolve));
  return { context, elements, timers, calls, flush, resize: () => observedResize(),
    deliver(data) { message({ source: parent, origin: "https://fixture.invalid", data }); },
    async tick(ms = 1000) { const [id, timer] = [...timers].find(([, timer]) => timer.ms === ms) || []; assert.ok(timer); timers.delete(id); timer.fn(); await flush(); } };
}

const read = { values: { projectRoot: "C:/fixture/project" }, preparationScope: "C:/fixture/project#default",
  schema: { properties: { projectRoot: { readOnly: true } } } };

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

test("component selection is saved independently and update polling never repeats apply",async()=>{
  let enabled=false,polls=0;
  const ui=screen(async(name,args)=>{
    if(name==="settings.read")return {...read,values:{...read.values,codeIndexEnabled:true,bslLsEnabled:enabled}};
    if(name==="settings.update"){assert.equal(args.set.bslLsEnabled,true);enabled=true;return {};}
    if(name==="settings.updates"){assert.equal(args.operation,"apply");assert.equal(args.component,"bsl-ls");assert.equal(args.authorization.scope,read.preparationScope);return {id:"update",status:"running"};}
    if(name==="settings.operation")return ++polls===1?{id:"update",status:"running",action:"updates"}:{id:"update",status:"completed",action:"updates",result:{component:"bsl-ls",state:"applied",release:"v9.0.0"}};
    throw new Error(name);
  });
  await ui.flush();assert.equal(ui.elements.get("bslLsEnabled").checked,false);
  ui.elements.get("bslLsEnabled").checked=true;await ui.elements.get("saveComponentsButton").onclick();
  assert.equal(ui.calls.filter(c=>c.params?.name==="settings.run_check").length,0);
  ui.elements.get("updateComponent").value="bsl-ls";await ui.elements.get("applyUpdateButton").onclick();await ui.tick();
  assert.equal(ui.calls.filter(c=>c.params?.name==="settings.updates").length,1);
  assert.match(ui.elements.get("updatesResult").textContent,/BSL LS: применён · v9.0.0/);
});

test("manual settings require a fresh preview after editing and apply the reviewed text", async () => {
  const text = JSON.stringify({ format: "1c-ai-core-settings", version: 1, settings: { mcp: { managed: {} } } });
  const ui = screen(async (name, args) => {
    if(name === "settings.read") return read;
    if(name === "settings.edit") return { text, baseRevision: "loaded" };
    if(name === "settings.preview") { assert.equal(args.mode, "edit"); assert.equal(args.baseRevision, "loaded"); return { revision: "reviewed", projectRoot: read.values.projectRoot, repositories: [] }; }
    if(name === "settings.apply") { assert.equal(args.text, text); assert.equal(args.revision, "reviewed"); assert.equal(args.mode, "edit"); assert.equal(args.baseRevision, "loaded"); return {}; }
    throw new Error(name);
  });
  await ui.flush();
  await ui.elements.get("editSettingsButton").onclick();
  assert.equal(ui.elements.get("settingsText").value, text);
  await ui.elements.get("previewButton").onclick();
  assert.equal(ui.elements.get("preview").hidden, false);
  ui.elements.get("settingsText").events.input();
  await ui.elements.get("applyButton").onclick();
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.apply").length, 0);
  await ui.elements.get("previewButton").onclick();
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
  assert.equal(ui.elements.get("saveButton").disabled, false);
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
  assert.equal(ui.elements.get("projectRoot").readOnly, true);
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
  assert.match(ui.elements.get("status").textContent, /автоматического переподключения нет/);
  const contents = element => [element.textContent, ...element.children.map(contents)].join(" ");
  const lines = contents(ui.elements.get("connections"));
  assert.match(lines, /MCP и workspace API доступны/);
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
  assert.equal(ui.elements.get("loadButton").hidden, false);
  assert.match(ui.elements.get("status").textContent, /новый чат/);
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.run_check").length, 0);
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
    if (name === "settings.operation") return selected ? { ...picker, status: "completed", result: read } : picker;
    throw new Error(name);
  });
  await ui.flush();
  assert.equal(ui.elements.get("checkButton").disabled, true);
  assert.equal(ui.elements.get("pickDirectoryButton").disabled, true);
  assert.equal(ui.elements.get("operationButton").disabled, false);
  assert.match(ui.elements.get("status").textContent, /системный выбор папки/);
  selected = true;
  await ui.tick();
  assert.equal(ui.elements.get("profileTitle").textContent, "selected-profile");
  assert.equal(ui.elements.get("loadButton").hidden, false);
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

test("state refreshes a completed load and queries the latest operation instead of the previous one", async () => {
  let reads = 0;
  const ui = screen(async (name, args) => {
    if (name === "settings.read") return { ...read, profile: { status: "loaded", profileId: ++reads === 1 ? "old" : "reloaded" }, operation: { id: "previous", action: "update", status: "completed" } };
    if (name === "settings.operation") {
      assert.equal(JSON.stringify(args), "{}");
      return { id: "latest", action: "load", status: "completed", result: { sessionGuidance: "Профиль доступен в новом чате." } };
    }
    throw new Error(name);
  });
  await ui.flush();
  await ui.elements.get("operationButton").onclick();
  assert.equal(ui.elements.get("profileTitle").textContent, "reloaded");
  assert.match(ui.elements.get("status").textContent, /Профиль загружен.*новом чате/);
  assert.doesNotMatch(ui.elements.get("status").textContent, /Обновите настройки/);
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.load").length, 0);
});

test("echoed load and operation results do not navigate, refresh recursively or multiply polling", async () => {
  const operation = { id: "loaded", action: "load", status: "completed", mode: "operation", result: {} };
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
  await ui.elements.get("operationButton").onclick();
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
