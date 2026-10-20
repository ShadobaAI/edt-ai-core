import readline from "node:readline";
const folders = new Set();
const replies = new Map();
const calls = [];
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const result = (id, value) => send({ id, result: value });
let busy = false;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (!m.method) {
    const target = replies.get(m.id);
    if (target) { replies.delete(m.id); result(target.id, { reply: m, ...target.extra }); }
    return;
  }
  if (m.method === "initialize") {
    result(m.id, { params: m.params, launch: JSON.parse(process.env.BSL_TEST_ARGS), pid: process.pid, cwd: process.cwd() });
  } else if (m.method === "ping") result(m.id, {});
  else if (m.method === "server-request") {
    replies.set(m.id, { id: m.id, extra: {} });
    send({ id: m.id, method: "fixture/ask", params: {} });
  } else if (m.method === "ask-roots") {
    replies.set(m.id, { id: m.id, extra: {} });
    send({ id: m.id, method: "roots/list", params: {} });
  } else if (m.method === "notifications/cancelled") {
    result(m.params.requestId, { cancelled: true });
  } else if (m.method === "tools/call") {
    const { name, arguments: a = {} } = m.params;
    calls.push(name);
    if (name === "exit") process.exit(7);
    const overlap = busy;
    if (name === "hold") {
      busy = true;
      setTimeout(() => { busy = false; result(m.id, { calls, overlap }); }, a.delay ?? 120);
    } else if (name === "register_workspace_folder") {
      folders.add(a.path);
      result(m.id, { path: a.path, overlap, calls });
    } else if (name === "unregister_workspace_folder") {
      folders.delete(a.workspaceFolder);
      result(m.id, { removed: true, overlap, calls });
    } else if (name === "list_workspace_folders") result(m.id, { folders: [...folders], overlap, calls });
    else result(m.id, { arguments: a, folders: [...folders], overlap, calls });
  }
}).on("close", () => {
  if (process.env.BSL_TEST_HANG) setInterval(() => {}, 1000);
  else process.exit(0);
});
