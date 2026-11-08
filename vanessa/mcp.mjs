import { withHttpMcp } from "../mcp/http-client.mjs";
import { fail } from "./profile.mjs";

export async function listTools(client) {
  const tools = [], seen = new Set(), cursors = new Set();
  let cursor;
  do {
    const page = await client.request("tools/list", cursor ? { cursor } : {});
    if (!Array.isArray(page?.tools)) fail("Некорректный ответ MCP tools/list");
    for (const tool of page.tools) {
      if (typeof tool?.name !== "string" || !tool.name || seen.has(tool.name) || !tool.inputSchema || tool.inputSchema.type !== "object") fail("Некорректная или повторная схема инструмента MCP");
      seen.add(tool.name); tools.push(tool);
      if (tools.length > 2000) fail("Превышено допустимое число инструментов MCP");
    }
    cursor = page.nextCursor;
    if (cursor !== undefined && (typeof cursor !== "string" || !cursor || cursors.has(cursor))) fail("Некорректный курсор MCP tools/list");
    cursors.add(cursor);
  } while (cursor);
  return tools;
}

// These checks catch common argument mistakes; the server remains schema authority.
export function checkArguments(schema, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) fail("Аргументы инструмента должны быть объектом");
  for (const name of schema.required ?? []) if (!Object.hasOwn(args, name)) fail(`Отсутствует аргумент инструмента: ${name}`);
  if (schema.additionalProperties === false && Object.keys(args).some(name => !Object.hasOwn(schema.properties ?? {}, name))) fail("Неизвестный аргумент инструмента");
  for (const [name, value] of Object.entries(args)) {
    const property = schema.properties?.[name];
    if (!property) continue;
    if (property.enum && !property.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) fail(`Недопустимое значение перечисления аргумента: ${name}`);
    const types = Array.isArray(property.type) ? property.type : property.type ? [property.type] : [];
    const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    if (types.length && !types.includes(actual) && !(Number.isInteger(value) && types.includes("integer"))) fail(`Некорректный тип аргумента: ${name}`);
  }
}
export const session = (profile, use, { transportFetch } = {}) => withHttpMcp({ url: profile.mcp.url }, use, {
  timeout: profile.limits.timeoutMs, maxBytes: profile.limits.maxBytes, ...(transportFetch ? { transportFetch } : {}),
});
export async function callTool(client, tools, name, args, { onDispatch = () => {} } = {}) {
  const tool = tools.find(item => item.name === name);
  if (!tool) fail("Запрошенный инструмент недоступен");
  checkArguments(tool.inputSchema, args);
  onDispatch();
  const result = await client.request("tools/call", { name, arguments: args });
  if (!result || typeof result !== "object") fail("Некорректный ответ инструмента MCP");
  if (result.isError) {
    const error = new Error("Инструмент MCP вернул ошибку");
    error.code = "tool_error";
    // Profile and connection errors may contain credentials in arbitrary
    // formats that cannot be safely redacted by field or switch name.
    const safeResult = name === "manage_test_client_profiles" || name === "manage_test_client"
      ? { isError: true, content: [{ type: "text", text: "Ответ подключения скрыт: он может содержать учётные данные." }] } : redact(result);
    error.detail = { classification: "tool_error", outcome: "responded", tool: name, result: safeResult,
      nextAction: "Проверьте причину отказа и фактическое состояние; не повторяйте те же аргументы без изменений." };
    throw error;
  }
  return result;
}

const sensitiveKey = /password|passwd|token|secret|credential|authorization|connectionstring|строкасоединения|пароль|логин|username|user_name|имяпользователя|^(?:user|usr|pwd)$/i;
function schemaForOutput(value, sensitive = false) {
  if (Array.isArray(value)) return value.map(item => schemaForOutput(item, sensitive));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (sensitive && ["default", "examples", "example", "const", "enum"].includes(key)) return [key, "[redacted]"];
    if (key === "properties" && item && typeof item === "object") return [key, Object.fromEntries(Object.entries(item).map(([name, schema]) => [name, schemaForOutput(schema, sensitive || sensitiveKey.test(name))]))];
    return [key, schemaForOutput(item, sensitive)];
  }));
  return typeof value === "string" ? redact(value) : value;
}
export function redact(value, depth = 0) {
  if (depth > 50) return "[redacted]";
  if (Array.isArray(value)) return value.map(item => redact(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    ["inputSchema", "outputSchema"].includes(key) ? schemaForOutput(item) : sensitiveKey.test(key) ? "[redacted]" : redact(item, depth + 1)]));
  if (typeof value === "string") {
    // Some tools return JSON envelopes as MCP text; escaped credentials must
    // be decoded before applying the same key and command-line protections.
    if (/^\s*[\[{]/.test(value)) {
      try { const decoded = JSON.parse(value); if (decoded && typeof decoded === "object") return JSON.stringify(redact(decoded, depth + 1)); }
      catch { if (/password|passwd|pwd|token|secret|credential|authorization|пароль|логин|username|user_name|имяпользователя|\b(?:user|usr)\b|\/(?:N|P)/i.test(value)) return "[redacted]"; }
    }
    if (/\\["']/.test(value) && /password|passwd|pwd|token|secret|credential|authorization|пароль|логин|username|user_name|имяпользователя|\b(?:user|usr)\b|\/(?:N|P)/i.test(value)) return "[redacted]";
    return value
    .replace(/(Pwd|Password|Token|Secret|Пароль|Логин|Username|User_name|ИмяПользователя|Usr|(?<![A-Za-z0-9_])User)(["']?)\s*[=:]\s*(?:"(?:[^"]|"")*"|'(?:[^']|'')*'|[^;\r\n]+)/gi, "$1$2=[redacted]")
    .replace(/(^|[\s|;])\/([NP])\s*(?:"(?:[^"]|"")*"|[^\s|;]+)/gim, "$1/$2[redacted]")
    .replace(/(Bearer\s+)\S+/gi, "$1[redacted]");
  }
  return value;
}
