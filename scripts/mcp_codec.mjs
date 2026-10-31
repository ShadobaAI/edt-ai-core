// Transport budgets protect memory, independently of model response budgets.
export const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const contract_error = message => Object.assign(new Error(message), { category: "server_contract", outcomeUnknown: true });
export function envelope(message) {
  if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0")
    throw contract_error("Invalid MCP envelope; outcome unknown");
  const hasId = Object.hasOwn(message, "id");
  if (hasId && !(typeof message.id === "string" || Number.isSafeInteger(message.id)))
    throw contract_error("Invalid MCP id; outcome unknown");
  if (Object.hasOwn(message, "method")) {
    if (typeof message.method !== "string" || !message.method) throw contract_error("Invalid MCP method");
  } else if (!hasId || Object.hasOwn(message, "result") === Object.hasOwn(message, "error"))
    throw contract_error("Invalid MCP response; outcome unknown");
  return message;
}
export function json_message(text, maxBytes = DEFAULT_MAX_BYTES) {
  if (Buffer.byteLength(text) > maxBytes) throw new Error("MCP output budget exceeded; outcome unknown");
  return envelope(JSON.parse(text));
}
export function read_lines(stream, receive, fail, maxBytes = DEFAULT_MAX_BYTES) {
  let buffer = Buffer.alloc(0), failed = false;
  const reject = error => { if (!failed) { failed = true; buffer = Buffer.alloc(0); fail(error); } };
  stream.on("data", chunk => {
    if (failed) return;
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    let end, consumed = false;
    try {
      while ((end = buffer.indexOf(10)) !== -1) {
        const line = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
        consumed = true;
        if (line.toString().trim()) receive(json_message(line.toString(), maxBytes));
      }
      if (buffer.length > maxBytes) throw new Error("MCP output budget exceeded; outcome unknown");
      // A subarray retains its entire backing allocation, even when empty. Keep
      // only the unfinished line after processing a potentially large message.
      if (consumed) buffer = buffer.length ? Buffer.from(buffer) : Buffer.alloc(0);
    } catch (error) { reject(error); }
  });
  stream.on("end", () => { if (buffer.length) reject(new Error("Truncated MCP envelope; outcome unknown")); });
}
export async function response_json(response, maxBytes = DEFAULT_MAX_BYTES) {
  const chunks = []; let bytes = 0;
  try {
    for await (const chunk of response.body || []) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw new Error("MCP output budget exceeded; outcome unknown");
      chunks.push(chunk);
    }
    return json_message(Buffer.concat(chunks).toString(), maxBytes);
  } catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
}
