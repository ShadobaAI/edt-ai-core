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
      : ["inspect", ...(changed ? ["later"] : [])];
    result = {
      tools: names.map((name) => ({
        name,
        inputSchema: {
          type: "object",
          properties: { change: { type: "boolean" } },
        },
        outputSchema: { type: "object" },
        annotations: { readOnlyHint: true },
      })),
      ...(!params.cursor ? { nextCursor: "tail" } : {}),
    };
  } else if (message.method === "tools/call") {
    if (params.name === "crash") { process.exit(7); return; }
    if (params.name === "malformed") { console.log("null"); return; }
    if (params.name === "ask_host") { callbackRequest=message.id; emit({id:"fixture-host-callback",method:"sampling/createMessage",params:{messages:[],maxTokens:10}}); return; }
    if (params.name === "slow") { setTimeout(() => emit({ id: message.id, result: { content: [], structuredContent: { upstreamId: message.id, notifications } } }), 400); return; }
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
