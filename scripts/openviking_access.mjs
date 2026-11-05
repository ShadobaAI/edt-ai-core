import { createHmac, createPublicKey, randomBytes, verify } from "node:crypto";
import { check_schema, stable } from "./common.mjs";
import { sha256 } from "./project_paths.mjs";
import { RemoteRpcError } from "./remote_client.mjs";
import { connection_failure, safe_error_message } from "./diagnostics.mjs";
import { read_openviking_record } from "./openviking_store.mjs";

const revisionKey = randomBytes(32);
const record = (options, state) => options.url ? read_openviking_record(options.url, options.connection_id || "", state) : { revision: "missing", values: {} };
function relevant_receipts(options, state) {
  const raw = record(options, state).values.accessReceipts || "";
  try { const all = JSON.parse(raw); if (Array.isArray(all)) return all.filter(entry => entry?.payload?.endpoint === options.url); } catch {}
  return raw;
}
// Stable between processes for saved setup receipts. The operator's private
// binding key prevents a public fingerprint from becoming a credential oracle.
export function persisted_access_revision(options, state) {
  const current = record(options, state), key = current.values.bindingKey;
  const evidence = [current.revision, relevant_receipts(options, state), current.values.accessPublicKey, current.values.credential];
  return key && Buffer.byteLength(key) >= 32
    ? createHmac("sha256", key).update("1c-ai-core/setup-readiness/v1\0").update(stable(evidence)).digest("hex")
    : "binding_key_unavailable";
}
export function access_receipt_epoch(options, now = Date.now(), state) {
  const entries = relevant_receipts(options, state);
  return Array.isArray(entries) ? entries.map(entry => {
    const start = instant(entry?.payload?.verified_at), end = instant(entry?.payload?.expires_at);
    return !Number.isFinite(start) || !Number.isFinite(end) ? "invalid" : now < start ? "future" : now >= end ? "expired" : "current";
  }) : "invalid";
}
export function access_revision(options, state) {
  const current = record(options, state);
  return createHmac("sha256", revisionKey).update(stable([current.revision, access_receipt_epoch(options, Date.now(), state)])).digest("hex");
}
function instant(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return NaN;
  const time = Date.parse(value), canonical = value.includes(".") ? value : value.slice(0, -1) + ".000Z";
  return Number.isFinite(time) && new Date(time).toISOString() === canonical ? time : NaN;
}

function credentials(values) {
  const value = values.credential, name = value?.startsWith("Bearer ") ? "authorization" : "x-api-key";
  if (!value || /[\r\n]/.test(value) || (/^Bearer(?:\s|$)/i.test(value) && !/^Bearer \S+$/.test(value)))
    throw new Error("Учётные данные поиска OpenViking отсутствуют или некорректны");
  return [[name, value]];
}
export function search_credential_headers(options, state) {
  return Object.fromEntries(credentials(record(options, state).values));
}
export function access_error(error, options, pinnedHeaders = {}, phase = "server_contract", state) {
  const classification = connection_failure(error, phase);
  if (error instanceof SyntaxError)
    return Object.assign(new Error("OpenViking вернул некорректный JSON; фрагмент ответа скрыт"), classification);
  // Upstream text is untrusted and can encode a credential arbitrarily. Keep
  // numeric transport evidence; never forward that text as a diagnostic.
  if (error instanceof RemoteRpcError) {
    const codes = [Number.isInteger(error.status) ? "HTTP " + error.status : null,
      Number.isInteger(error.code) ? "RPC " + error.code : null].filter(Boolean).join(", ");
    return Object.assign(new Error("Внешний сервер OpenViking отклонил запрос" + (codes ? " (" + codes + ")" : "") + "; текст внешней ошибки скрыт"), classification);
  }
  const values = [...Object.values(record(options, state).values), ...Object.values(pinnedHeaders)].filter(Boolean);
  const secrets = [...new Set(values.flatMap(value => /^Bearer /i.test(value) ? [value, value.slice(7)] : [value]).flatMap(value => {
    const escaped = JSON.stringify(value).slice(1, -1);
    return [value, escaped, JSON.stringify(escaped).slice(1, -1)];
  }).filter(Boolean))].sort((a, b) => b.length - a.length);
  let message = String(error?.message || "Подключение OpenViking не удалось");
  for (const secret of secrets) message = message.split(secret).join("[redacted]");
  const failure = Object.assign(new Error(message.slice(0, 2000)), classification,
    error?.outcomeUnknown === true ? { outcomeUnknown: true } : {});
  if (failure.outcomeUnknown) failure.message = safe_error_message(failure);
  return failure;
}
export const surface_fingerprint = tools => sha256(stable([...tools].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
export const operation_fingerprint = tool => sha256(stable(tool));
export function verify_search_surface(access, tools, initialization) {
  if (Object.keys(initialization?.capabilities || {}).some(key => key !== "tools"))
    throw new Error("OpenViking объявляет неподтверждённую возможность MCP");
  if (tools.length !== 2 || !tools.some(tool => ["find", "search"].includes(tool.name)) || !tools.some(tool => tool.name === "read") ||
      surface_fingerprint(tools) !== access.tools_sha256)
    throw new Error("Действующий API OpenViking отличается от внешне подтверждённого контракта поиска и чтения; скрытие инструментов не ограничивает права сервера");
  for (const role of ["search", "read"]) {
    const tool = tools.find(tool => role === "search" ? ["find", "search"].includes(tool.name) : tool.name === "read");
    const approval = access.operations[role];
    if (approval.name !== tool.name || approval.descriptor_sha256 !== operation_fingerprint(tool))
      throw new Error("Для операции OpenViking нет внешнего подтверждения назначения и принудительной области только для чтения");
  }
}
function binding(values) {
  const key = values.bindingKey;
  if (!key || Buffer.byteLength(key) < 32) throw new Error("Ключ привязки доступа OpenViking отсутствует или слишком короткий");
  return createHmac("sha256", key).update("1c-ai-core/openviking-credential/v2\0").update(stable(credentials(values))).digest("hex");
}
export function credential_binding(options, state) {
  return binding(record(options, state).values);
}
export function verify_search_access(options, collections, now = Date.now(), state) {
  const values = record(options, state).values, credentialBinding = binding(values);
  let receipts, key;
  try {
    const raw = values.accessReceipts;
    if (!raw || raw.length > 262144) throw new Error();
    receipts = JSON.parse(raw);
    if (!Array.isArray(receipts) || receipts.length > 64) throw new Error();
    key = createPublicKey(values.accessPublicKey || "");
    if (key.asymmetricKeyType !== "ed25519") throw new Error();
  } catch { throw new Error("Для OpenViking нужны внешние подписанные подтверждения доступа к поиску и доверенный ключ оператора"); }
  const grants = [];
  let incompatible = false;
  for (const envelope of receipts) {
    try {
      const { payload, signature } = envelope;
      if (typeof signature !== "string" || !verify(null, Buffer.from(stable(payload)), key, Buffer.from(signature, "base64"))) continue;
      if (payload.endpoint !== options.url || payload.credential_binding !== credentialBinding) continue;
      const start = instant(payload.verified_at), end = instant(payload.expires_at);
      if (!Number.isFinite(start) || !Number.isFinite(end)) { incompatible = true; continue; }
      if (start > now || end <= now) continue;
      try {
        check_schema(payload, "knowledge-access-receipt.schema.json");
        if (end <= start || end - start > 86400000 || payload.team_roots.some(root => root.slice("viking://resources/".length).split("/").some(part => !part || part === "." || part === ".."))) throw new Error();
      } catch { incompatible = true; continue; }
      grants.push(payload);
    } catch { /* A malformed or unrelated receipt grants nothing. */ }
  }
  if (incompatible) throw new Error("Для учётных данных поиска OpenViking нет согласованного действующего подписанного разрешения только на чтение");
  if (grants.length) {
    const contract = ({ verified_at, expires_at, ...payload }) => stable(payload);
    if (grants.some(grant => contract(grant) !== contract(grants[0])))
      throw new Error("У OpenViking конфликтуют подписанные подтверждения доступа для этой идентичности подключения");
    const selected = grants.sort((a, b) => Date.parse(a.expires_at) - Date.parse(b.expires_at))[0];
    if ([...collections.values()].every(uri => selected.team_roots.some(root => uri === root || uri.startsWith(root + "/")))) return selected;
  }
  throw new Error("Для учётных данных поиска OpenViking нет действующего подписанного разрешения на этот адрес и область команды");
}
