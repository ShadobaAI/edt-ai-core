import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const html = fs.readFileSync(new URL("../ui/settings.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function screen(handler) {
  const elements = new Map(), timers = new Map(), calls = [];
  let nextTimer = 0, message;
  class Element {
    constructor(tag = "div") { Object.assign(this, { tag, disabled: false, readOnly: false, hidden: false, value: "", files: [], textContent: "", children: [], events: {} }); }
    classList = { toggle() {} };
    addEventListener(name, fn) { this.events[name] = fn; }
    setAttribute() {}
    replaceChildren(...children) { this.children = children; }
    append(...children) { this.children.push(...children); }
    click() {}
  }
  for (const match of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g)) elements.set(match[2], new Element(match[1]));
  const parent = { postMessage(request) {
    if (!request.id) return;
    calls.push(request);
    Promise.resolve().then(async () => {
      const data = request.method === "ui/initialize" ? { hostInfo: { name: "fixture" } } : await handler(request.params.name, request.params.arguments);
      message({ source: parent, origin: "https://fixture.invalid", data: { jsonrpc: "2.0", id: request.id, result: request.method === "ui/initialize" ? data : { structuredContent: data } } });
    });
  } };
  const document = { getElementById: id => elements.get(id), createElement: tag => new Element(tag),
    querySelectorAll: () => [...elements.values()].filter(element => ["button", "input"].includes(element.tag)),
    documentElement: { scrollHeight: 500, style: { setProperty() {} } } };
  const context = vm.createContext({ document, window: { parent, addEventListener: (_, listener) => { message = listener; } },
    setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id),
    Blob, URL: { createObjectURL: () => "blob:fixture", revokeObjectURL() {} } });
  vm.runInContext(script, context);
  const flush = () => new Promise(resolve => setImmediate(resolve));
  return { context, elements, timers, calls, flush,
    deliver(data) { message({ source: parent, origin: "https://fixture.invalid", data }); },
    async tick() { const [id, timer] = [...timers].find(([, timer]) => timer.ms === 1000) || []; assert.ok(timer); timers.delete(id); timer.fn(); await flush(); } };
}

const read = { values: { projectRoot: "C:/fixture/project" }, schema: { properties: { projectRoot: { readOnly: true } } } };

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
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.run_check").length, 1);
  assert.equal([...ui.timers.values()].filter(timer => timer.ms === 1000 || timer.ms === 5000).length, 0);
  assert.match(ui.elements.get("status").textContent, /автоматического переподключения нет/);
  const lines = ui.elements.get("connections").children.flatMap(child => child.children).map(child => child.textContent).join(" ");
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
  assert.match(ui.elements.get("status").textContent, /update завершена/);
  assert.equal(ui.calls.filter(call => call.params?.name === "settings.operation").length, 1);
});
