// Bounded Streamable HTTP only: no redirects, reconnects, or legacy SSE fallback.
import { core_version } from "../scripts/compatibility.mjs";
export async function withHttpMcp(config, use, {
  env = process.env, timeout = 10000, maxBytes = 1024 * 1024, onResponse = () => {}, transportFetch = fetch,
} = {}) {
  let url, headers;
  try {
    url = new URL(config.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw 0;
    headers = new Headers();
    for (const [name, value] of Object.entries(config.http_headers ?? {})) {
      if (typeof value !== "string") throw 0;
      headers.set(name, value);
    }
    for (const [name, variable] of Object.entries(config.env_http_headers ?? {})) {
      if (typeof variable !== "string" || typeof env[variable] !== "string" || !env[variable]) throw 0;
      headers.set(name, env[variable]);
    }
    if (config.bearer_token_env_var != null) {
      const token = env[config.bearer_token_env_var];
      if (typeof token !== "string" || !token) throw 0;
      headers.set("Authorization", `Bearer ${token}`);
    }
    headers.set("Accept", "application/json, text/event-stream");
    headers.set("Content-Type", "application/json");
    headers.delete("Mcp-Session-Id");
    headers.delete("MCP-Protocol-Version");
  } catch { throw new Error("Некорректные настройки HTTP MCP или не задана переменная окружения с учётными данными"); }
  if (!Number.isFinite(timeout) || timeout <= 0 || !Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new Error("Некорректные ограничения HTTP MCP");
  }
  const controller = new AbortController();
  let id = 0, bytes = 0, session, finished = false;
  const version = "2025-03-26";
  const timedOut = () => new Error("Истекло время сессии HTTP MCP");
  const fetchSafe = async (options) => {
    try {
      const response = await transportFetch(url, { redirect: "error", ...options });
      if (options.method !== "DELETE") onResponse();
      return response;
    }
    catch { throw controller.signal.aborted ? timedOut() : new Error("Ошибка транспорта HTTP MCP"); }
  };
  const parse = (text) => {
    try { return JSON.parse(text); }
    catch { throw new Error("Некорректный JSON HTTP MCP"); }
  };
  const check = (message, expected) => {
    let found = false, result;
    const messages = Array.isArray(message) ? message : [message];
    if (!messages.length) throw new Error("Некорректное сообщение HTTP MCP");
    for (const item of messages) {
      if (!item || typeof item !== "object" || Array.isArray(item) || item.jsonrpc !== "2.0") {
        throw new Error("Некорректное сообщение HTTP MCP");
      }
      if (typeof item.method === "string") {
        if (Object.hasOwn(item, "id")) throw new Error("Запросы сервера HTTP MCP не поддерживаются");
        continue;
      }
      if (item.id !== expected || found) throw new Error("Неожиданный идентификатор ответа HTTP MCP");
      if (Object.hasOwn(item, "error") || !Object.hasOwn(item, "result")) throw new Error("Запрос HTTP MCP не удался");
      found = true; result = item.result;
    }
    return { found, result };
  };
  const readResponse = async (response, expected) => {
    const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (!["application/json", "text/event-stream"].includes(type) || !response.body) {
      await response.body?.cancel();
      throw new Error("Неподдерживаемый транспорт ответа HTTP MCP");
    }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = "", eventData = [], eventType = "";
    const dispatch = () => {
      if (eventType === "endpoint") throw new Error("Устаревший транспорт MCP SSE не поддерживается");
      const data = eventData.join("\n");
      eventData = []; eventType = "";
      return data ? check(parse(data), expected) : { found: false };
    };
    try {
      while (true) {
        let chunk;
        try { chunk = await reader.read(); }
        catch { throw controller.signal.aborted ? timedOut() : new Error("Ответ HTTP MCP прерван"); }
        if (chunk.value) {
          bytes += chunk.value.byteLength;
          if (bytes > maxBytes) throw new Error("Превышен допустимый размер ответа HTTP MCP");
        }
        buffer += decoder.decode(chunk.value, { stream: !chunk.done });
        if (type === "text/event-stream") {
          let match;
          while ((match = /\r\n|\n|\r/.exec(buffer)) && (chunk.done || match.index < buffer.length - 1 || match[0] !== "\r")) {
            const line = buffer.slice(0, match.index);
            buffer = buffer.slice(match.index + match[0].length);
            if (!line) {
              const answer = dispatch();
              if (answer.found) return answer.result;
            } else if (line.startsWith("data:")) eventData.push(line.slice(5).replace(/^ /, ""));
            else if (line.startsWith("event:")) eventType = line.slice(6).trim();
          }
        }
        if (chunk.done) break;
      }
      if (type === "application/json") {
        const answer = check(parse(buffer), expected);
        if (answer.found) return answer.result;
      }
      throw new Error("Неполный ответ HTTP MCP");
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  };
  const post = async (method, params, notification = false) => {
    if (finished) throw new Error("Сессия HTTP MCP закрыта");
    const next = notification ? undefined : ++id;
    const response = await fetchSafe({ method: "POST", headers, signal: controller.signal,
      body: JSON.stringify({ jsonrpc: "2.0", id: next, method, ...(params === undefined ? {} : { params }) }) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Состояние HTTP MCP: ${response.status}`);
    }
    if (notification) {
      await response.body?.cancel();
      if (response.status !== 202) throw new Error("Некорректное подтверждение уведомления HTTP MCP");
      return;
    }
    if (method === "initialize") {
      session = response.headers.get("Mcp-Session-Id");
      if (session !== null && !/^[\x21-\x7e]+$/.test(session)) {
        await response.body?.cancel();
        session = null;
        throw new Error("Некорректный идентификатор сессии HTTP MCP");
      }
      if (session) headers.set("Mcp-Session-Id", session);
    }
    return readResponse(response, next);
  };
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(timedOut()); }, timeout);
  });
  try {
    return await Promise.race([(async () => {
      const initialized = await post("initialize", { protocolVersion: version, capabilities: {},
        clientInfo: { name: "1c-ai-core", version: core_version } });
      // Some HTTP servers negotiate the older message schema on the same endpoint.
      // This does not opt into the deprecated GET + endpoint-event SSE transport.
      if (![version, "2024-11-05"].includes(initialized?.protocolVersion) || typeof initialized.serverInfo?.name !== "string" ||
          !initialized.serverInfo.name || typeof initialized.serverInfo?.version !== "string" || !initialized.serverInfo.version ||
          !initialized.capabilities || typeof initialized.capabilities !== "object" || Array.isArray(initialized.capabilities)) {
        throw new Error("Неполный ответ инициализации HTTP MCP");
      }
      headers.set("MCP-Protocol-Version", initialized.protocolVersion);
      await post("notifications/initialized", undefined, true);
      return use({ request: (method, params = {}) => post(method, params) });
    })(), deadline]);
  } finally {
    finished = true;
    clearTimeout(timer);
    controller.abort();
    if (session) {
      const cleanup = new AbortController();
      const stop = setTimeout(() => cleanup.abort(), Math.min(timeout, 1000));
      try {
        const response = await fetchSafe({ method: "DELETE", headers, signal: cleanup.signal });
        await response.body?.cancel();
      } catch { /* Cleanup never replaces the bounded probe result. */ }
      finally { clearTimeout(stop); }
    }
  }
}
