import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// One stdio connection owns one JVM. BSL LS owns workspace registration,
// configuration loading and file-to-workspace resolution.
const MAX_LINE = 16 * 1024 * 1024;
const MAX_PENDING = 1024;

function options(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!["--project-root", "--jar", "--java", "--configuration"].includes(key)
        || result[key] !== undefined || !argv[i + 1] || argv[i + 1].startsWith("--")) {
      throw new Error(`invalid argument: ${key}`);
    }
    result[key] = argv[i + 1];
  }
  return result;
}

function localPath(value, base) {
  if (typeof value !== "string" || !value || value.includes("\0")) throw new Error("expected a local path or file URI");
  if (/^file:/i.test(value)) {
    const uri = new URL(value);
    if (uri.search || uri.hash) throw new Error("file URI cannot contain a query or fragment");
    return fileURLToPath(uri);
  }
  if (/^[a-z][a-z0-9+.-]+:/i.test(value)) throw new Error("expected a local path or file URI");
  return path.resolve(base, value);
}

function existing(value, base, directory) {
  const resolved = fs.realpathSync.native(localPath(value, base));
  const stat = fs.statSync(resolved);
  if (!(directory ? stat.isDirectory() : stat.isFile())) throw new Error(`expected ${directory ? "directory" : "file"}: ${value}`);
  return resolved;
}

let args, projectRoot, jar, configuration;
try {
  if (Number(process.versions.node.split(".")[0]) < 18) throw new Error("Node.js 18+ is required");
  args = options(process.argv.slice(2));
  projectRoot = existing(args["--project-root"] || process.cwd(), process.cwd(), true);
  jar = existing(args["--jar"] || process.env.BSL_LANGUAGE_SERVER_JAR, projectRoot, false);
  if (args["--configuration"]) configuration = existing(args["--configuration"], projectRoot, false);
} catch (failure) {
  process.stderr.write(`bsl-ls-proxy: ${failure.message}\n`);
  process.exit(1);
}

function scoped(value, directory) {
  const resolved = existing(value, projectRoot, directory);
  const relative = path.relative(projectRoot, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("path must stay inside the selected project directory (including symlink targets)");
  }
  return resolved;
}

const command = ["-Dfile.encoding=UTF-8", "-Dstdout.encoding=UTF-8", "-Dstderr.encoding=UTF-8"];
// McpCommand loads global options; the factory also needs app.configuration.path
// to load workspace options from an explicitly chosen configuration file.
if (configuration) command.push(`-Dapp.configuration.path=${configuration}`);
command.push("-jar", jar, "mcp");
if (configuration) command.push("--configuration", configuration);
const child = spawn(args["--java"] || process.env.BSL_LANGUAGE_SERVER_JAVA || "java", command, {
  cwd: projectRoot, shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
});
child.stderr.pipe(process.stderr);

const clientRequests = new Map(); // upstream id -> original request
const clientIds = new Map(); // typed client id -> upstream id
const serverRequests = new Map(); // downstream id -> original server id
const tools = [];
let counter = 0;
let activeTool;
let stopping = false;
let stopTimer;
let failed = false;
let childClosed = false;
const key = (id) => `${typeof id}:${JSON.stringify(id)}`;
const hasId = (message) => Object.hasOwn(message, "id");
const validId = (id) => typeof id === "string" || (typeof id === "number" && Number.isFinite(id));

function write(stream, message, source) {
  if (stream.destroyed || stream.writableEnded) return;
  if (!stream.write(`${JSON.stringify(message)}\n`) && source) {
    source.pause();
    stream.once("drain", () => { if (source !== process.stdin || !stopping) source.resume(); });
  }
}

function error(id, message, code = -32602) {
  write(process.stdout, { jsonrpc: "2.0", id, error: { code, message } }, child.stdout);
}

function stop(immediate = false) {
  if (stopping || childClosed) return;
  stopping = true;
  process.stdin.pause();
  if (immediate) child.kill("SIGTERM");
  else child.stdin.end();
  // Bound EOF shutdown before the owning host exits, even if Java leaves
  // non-daemon threads alive. Only this connection's direct child is killed.
  stopTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
}

function dispatchTool() {
  if (activeTool || stopping) return;
  let next;
  while ((next = tools.shift())) {
    try {
      // Recheck after waiting: a queued directory can have been replaced by a
      // junction or a file can have disappeared while another call was running.
      prepareTool(next.params);
    } catch (failure) {
      const request = clientRequests.get(next.id);
      clientRequests.delete(next.id);
      clientIds.delete(key(request.id));
      error(request.id, failure.message);
      continue;
    }
    activeTool = next.id;
    write(child.stdin, next, process.stdin);
    return;
  }
}

function prepareTool(params) {
  if (!params || typeof params.name !== "string") throw new Error("tools/call requires a name");
  const arguments_ = params.arguments ?? {};
  if (!arguments_ || Array.isArray(arguments_) || typeof arguments_ !== "object") throw new Error("tools/call arguments must be an object");
  params.arguments = arguments_;
  if (params.name === "register_workspace_folder") arguments_.path = scoped(arguments_.path, true);
  if (Object.hasOwn(arguments_, "workspaceFolder")) arguments_.workspaceFolder = scoped(arguments_.workspaceFolder, true);
  // McpDocumentReader takes filesystem paths, not URIs. UTF-8 stdio
  // preserves Unicode names without 8.3 aliases or response rewriting.
  if (Object.hasOwn(arguments_, "file")) arguments_.file = scoped(arguments_.file, false);
}

function clientMessage(message) {
  if (!message.method) {
    const original = serverRequests.get(message.id);
    if (original !== undefined) {
      serverRequests.delete(message.id);
      write(child.stdin, { ...message, id: original }, process.stdin);
    }
    return;
  }
  if (message.method === "notifications/roots/list_changed") return;
  if (message.method === "notifications/cancelled") {
    const upstream = clientIds.get(key(message.params?.requestId));
    if (!upstream) return;
    const queued = tools.findIndex((item) => item.id === upstream);
    if (queued !== -1) {
      tools.splice(queued, 1);
      const request = clientRequests.get(upstream);
      clientRequests.delete(upstream);
      clientIds.delete(key(request.id));
      error(request.id, "Request cancelled before dispatch", -32800);
    } else write(child.stdin, { ...message, params: { ...message.params, requestId: upstream } }, process.stdin);
    return;
  }
  if (message.method === "initialize") {
    message.params ??= {};
    message.params.capabilities = { ...message.params.capabilities };
    // Host roots choose the outer project, not its configuration folders.
    // Registering the outer directory would index the entire multi-config tree.
    delete message.params.capabilities.roots;
  }
  if (!hasId(message)) {
    if (message.method !== "tools/call") write(child.stdin, message, process.stdin);
    return;
  }
  if (!validId(message.id) || clientIds.has(key(message.id))) {
    error(null, "Invalid or duplicate outstanding request ID", -32600);
    return;
  }
  if (clientRequests.size >= MAX_PENDING) {
    error(message.id, "Too many outstanding requests", -32000);
    return;
  }
  if (message.method === "tools/call") {
    try {
      prepareTool(message.params);
    } catch (failure) {
      error(message.id, failure.message);
      return;
    }
  }
  const upstream = `bsl-client-${++counter}`;
  clientRequests.set(upstream, { id: message.id, method: message.method });
  clientIds.set(key(message.id), upstream);
  message.id = upstream;
  // A removal must not race an analysis using the index. Other protocol
  // messages (including cancellations and server requests) remain independent.
  if (message.method === "tools/call") {
    tools.push(message);
    dispatchTool();
  } else write(child.stdin, message, process.stdin);
}

function serverMessage(message) {
  if (message.method === "roots/list") {
    if (hasId(message)) write(child.stdin, { jsonrpc: "2.0", id: message.id, result: { roots: [] } }, process.stdin);
    return;
  }
  if (message.method) {
    if (hasId(message)) {
      if (serverRequests.size >= MAX_PENDING) {
        write(child.stdin, { jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "Too many server requests" } });
        return;
      }
      const downstream = `bsl-server-${++counter}`;
      serverRequests.set(downstream, message.id);
      message.id = downstream;
    } else if (message.method === "notifications/cancelled") {
      const entry = [...serverRequests].find(([, id]) => key(id) === key(message.params?.requestId));
      if (entry) message.params.requestId = entry[0];
      else return;
    }
    write(process.stdout, message, child.stdout);
    return;
  }
  const request = clientRequests.get(message.id);
  if (!request) return;
  clientRequests.delete(message.id);
  clientIds.delete(key(request.id));
  const finishedTool = activeTool === message.id;
  write(process.stdout, { ...message, id: request.id }, child.stdout);
  if (finishedTool) {
    activeTool = undefined;
    dispatchTool();
  }
}

function consume(stream, handler, fromClient) {
  let buffer = "";
  stream.setEncoding("utf8");
  function line(value) {
    if (!value.trim()) return;
    try {
      const message = JSON.parse(value);
      if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("Invalid JSON-RPC message");
      handler(message);
    } catch (failure) {
      if (fromClient) error(null, failure.message, failure instanceof SyntaxError ? -32700 : -32600);
      else {
        failed = true;
        process.stderr.write("bsl-ls-proxy: invalid server protocol output\n");
        stop(true);
      }
    }
  }
  stream.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      if (newline > MAX_LINE) break;
      const value = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      line(value);
    }
    if (buffer.length > MAX_LINE) {
      failed = true;
      process.stderr.write("bsl-ls-proxy: protocol line exceeds limit\n");
      stop(true);
    }
  });
  stream.on("end", () => {
    if (buffer.length <= MAX_LINE) line(buffer);
    if (fromClient) stop();
  });
}

consume(process.stdin, clientMessage, true);
consume(child.stdout, serverMessage, false);
process.on("SIGINT", () => { process.exitCode = 130; stop(true); });
process.on("SIGTERM", () => { process.exitCode = 143; stop(true); });
process.stdout.on("error", () => stop(true));
child.stdin.on("error", () => { failed = true; stop(true); });
child.on("error", (failure) => {
  failed = true;
  process.stderr.write(`bsl-ls-proxy: failed to start BSL LS: ${failure.message}\n`);
});
child.on("close", (code) => {
  childClosed = true;
  clearTimeout(stopTimer);
  for (const request of clientRequests.values()) error(request.id, "BSL LS disconnected before completing the request", -32000);
  clientRequests.clear();
  clientIds.clear();
  serverRequests.clear();
  tools.length = 0;
  process.stdin.destroy();
  process.exitCode ??= failed ? 1 : (code ?? (stopping ? 0 : 1));
  process.stdout.end();
});
