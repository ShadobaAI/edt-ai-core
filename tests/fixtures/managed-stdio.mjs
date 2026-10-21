import readline from "node:readline";
let discoveries = 0,
  changed = false;
const emit = (message) =>
  console.log(JSON.stringify({ jsonrpc: "2.0", ...message }));
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (!Object.hasOwn(message, "id")) return;
  const params = message.params || {};
  let result;
  if (message.method === "initialize")
    result = {
      protocolVersion: "2024-11-05",
      serverInfo: { name: "fixture", version: "1" },
      capabilities: { tools: { listChanged: true } },
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
    if (params.arguments?.change) {
      changed = true;
      emit({ method: "notifications/tools/list_changed" });
    }
    result = {
      content: [{ type: "text", text: "result" }],
      structuredContent: {
        discoveries,
        binding: process.cwd(),
        rows_elided_already_delivered: 3,
        response_sections_omitted: true,
      },
    };
  } else result = {};
  emit({ id: message.id, result });
});
