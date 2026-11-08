// Transport budgets protect memory, independently of model response budgets.
export const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const contract_error = message => Object.assign(new Error(message), { category: "server_contract", outcomeUnknown: true });
// Host callbacks are arbitrary promises. A closed transport must stop waiting
// for them and remove its abort listener even if the host never answers.
export function wait_with_abort(start, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    let finished = false;
    const done = (callback, result) => {
      if (finished) return;
      finished = true; signal.removeEventListener("abort", aborted); callback(result);
    };
    const aborted = () => done(reject, signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    // Start lazily: a callback must not be invoked after cancellation, and an
    // eventual rejection remains observed even if cancellation wins the race.
    Promise.resolve().then(() => { signal.throwIfAborted(); return start(); })
      .then(result => done(resolve, result), error => done(reject, error));
    if (signal.aborted) aborted();
  });
}
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
export function read_frames(stream, receive, fail, maxBytes = DEFAULT_MAX_BYTES) {
  let pending = null, bytes = 0, failed = false;
  const reject = error => { if (!failed) { failed = true; pending = null; bytes = 0; fail(error); } };
  const append = (data, start, end) => {
    const size = bytes + end - start;
    if (size > maxBytes) throw new Error("MCP input budget exceeded");
    if (!pending || pending.length < size) {
      const next = Buffer.allocUnsafe(Math.min(maxBytes, Math.max(size, pending ? pending.length * 2 : 4096)));
      if (bytes) pending.copy(next, 0, 0, bytes);
      pending = next;
    }
    data.copy(pending, bytes, start, end);
    bytes = size;
  };
  stream.on("data", chunk => {
    if (failed) return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0, end;
    try {
      while ((end = data.indexOf(10, start)) !== -1) {
        const size = bytes + end - start;
        if (size > maxBytes) throw new Error("MCP input budget exceeded");
        let line;
        if (bytes) {
          append(data, start, end);
          line = pending.toString("utf8", 0, bytes);
        } else line = data.toString("utf8", start, end);
        pending = null; bytes = 0; start = end + 1;
        if (line.trim()) receive(line);
      }
      // Retain only the unfinished frame. Geometric growth bounds copying and
      // prevents tiny fragments from retaining an object per input chunk.
      if (start < data.length) append(data, start, data.length);
    } catch (error) { reject(error); }
  });
  stream.once("end", () => { if (bytes) reject(new Error("Truncated MCP envelope; outcome unknown")); });
  stream.once("error", reject);
}
export function read_lines(stream, receive, fail, maxBytes = DEFAULT_MAX_BYTES) {
  read_frames(stream, line => receive(json_message(line, maxBytes)), fail, maxBytes);
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
