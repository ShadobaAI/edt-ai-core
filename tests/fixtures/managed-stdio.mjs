import readline from "node:readline";
let discoveries = 0,
  changed = false;
const notifications = [];
let callbackRequest;
const emit = (message) =>
  console.log(JSON.stringify({ jsonrpc: "2.0", ...message }));
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (!message.method && message.id === "fixture-host-callback") { emit({id:callbackRequest,result:{content:[],structuredContent:message.result}}); return; }
  if (!Object.hasOwn(message, "id")) { notifications.push(message); return; }
  const params = message.params || {};
  let result;
  if (message.method === "initialize")
    result = {
      protocolVersion: "2024-11-05",
      serverInfo: { name: "fixture", version: "1" },
      capabilities: { tools: { listChanged: true } },
      instructions: "Native fixture contract: retain this instruction per binding.",
    };
  else if (message.method === "tools/list") {
    discoveries++;
    const names = params.cursor
      ? ["tail"]
      : ["inspect", ...(process.env.FIXTURE_BSL_WORKSPACES ?
        ["register_workspace_folder", "list_workspace_folders", "unregister_workspace_folder", "analyze_workspace"] : []),
        ...(process.env.FIXTURE_RUNTIME_BATCH ? ["fail", "rpc_fail", "slow"] : []), ...(changed ? ["later"] : [])];
    result = {
      tools: names.map((name) => ({
        name,
        inputSchema: {
          ...(process.env.FIXTURE_RUNTIME_BATCH && name === "inspect" ? { $schema: "http://json-schema.org/draft-07/schema#" } : {}),
          type: "object",
          properties: { change: { type: "boolean" }, ...(name === "analyze_workspace" ? { workspaceFolder: { type: "string" } } : {}) },
          ...(name === "analyze_workspace" ? { required: ["workspaceFolder"] } : {}),
        },
        outputSchema: { type: "object" },
        annotations: { readOnlyHint: true },
      })),
      ...(!params.cursor ? { nextCursor: "tail" } : {}),
    };
  } else if (message.method === "tools/call") {
    if (params.name === "rpc_fail") { emit({ id: message.id, error: { code: -32002, message: "native RPC failure" } }); return; }
    if (params.name === "fail") { emit({ id: message.id, result: { content: [{ type: "text", text: "native failure" }], structuredContent: { nativeError: true }, isError: true } }); return; }
    if (params.name === "crash") { process.exit(7); return; }
    if (params.name === "malformed") { console.log("null"); return; }
    if (params.name === "ask_host") { callbackRequest=message.id; emit({id:"fixture-host-callback",method:"sampling/createMessage",params:{messages:[],maxTokens:10}}); return; }
    if (params.name === "slow") {
      if (process.env.FIXTURE_SLOW_STARTED) emit({ method: "notifications/progress", params: { progressToken: "fixture-slow", progress: 1 } });
      setTimeout(() => emit({ id: message.id, result: { content: [], structuredContent: { upstreamId: message.id, notifications } } }), process.env.FIXTURE_SLOW_STARTED ? 1200 : 400); return;
    }
    if (params.arguments?.change) {
      changed = true;
      emit({ method: "notifications/tools/list_changed" });
    }
    result = {
      content: [{ type: "text", text: "result" }],
      structuredContent: {
        discoveries,
        pid: process.pid,
        binding: process.cwd(),
        rows_elided_already_delivered: 3,
        response_sections_omitted: true,
      },
    };
  } else result = {};
  if (message.method === "initialize" && process.env.FIXTURE_INIT_DELAY) setTimeout(()=>emit({id:message.id,result}),Number(process.env.FIXTURE_INIT_DELAY));
  else emit({ id: message.id, result });
});
