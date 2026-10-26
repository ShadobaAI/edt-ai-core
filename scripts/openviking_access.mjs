import { createHmac, createPublicKey, randomBytes, verify } from "node:crypto";
import { check_schema, stable } from "./common.mjs";
import { sha256 } from "./project_paths.mjs";
import { RemoteRpcError } from "./remote_client.mjs";
import { connection_failure } from "./diagnostics.mjs";

// These operator-supplied process variables are never read from a project,
// upstream MCP response, profile export or settings form.
const RECEIPTS = "EDT_AI_OPENVIKING_ACCESS_RECEIPTS";
const PUBLIC_KEY = "EDT_AI_OPENVIKING_ACCESS_PUBLIC_KEY";
const BINDING_KEY = "EDT_AI_OPENVIKING_ACCESS_BINDING_KEY";
const revisionKey = randomBytes(32);
function relevant_receipts(options) {
  const raw = process.env[RECEIPTS] || "";
  try { const all = JSON.parse(raw); if (Array.isArray(all)) return all.filter(entry => entry?.payload?.endpoint === options.url); } catch {}
  return raw;
}
// Stable between processes for saved setup receipts. The operator's private
// binding key prevents a public fingerprint from becoming a credential oracle.
export function persisted_access_revision(options) {
  const key = process.env[BINDING_KEY];
  const state = [relevant_receipts(options), process.env[PUBLIC_KEY] || "",
    Object.entries(options.headers_env || {}).map(([name, variable]) => [name, variable, process.env[variable]])];
  return key && Buffer.byteLength(key) >= 32
    ? createHmac("sha256", key).update("1c-ai-core/setup-readiness/v1\0").update(stable(state)).digest("hex")
    : "binding_key_unavailable";
}
export function access_receipt_epoch(options, now = Date.now()) {
  const entries = relevant_receipts(options);
  return Array.isArray(entries) ? entries.map(entry => {
    const start = instant(entry?.payload?.verified_at), end = instant(entry?.payload?.expires_at);
    return !Number.isFinite(start) || !Number.isFinite(end) ? "invalid" : now < start ? "future" : now >= end ? "expired" : "current";
  }) : "invalid";
}
export function access_revision(options) {
  const raw = process.env[RECEIPTS] || "";
  let relevant = raw;
  try {
    const all = JSON.parse(raw);
    if (Array.isArray(all)) relevant = all.filter(entry => entry?.payload?.endpoint === options.url);
  } catch { /* Invalid operator state must also invalidate the connection. */ }
  return createHmac("sha256", revisionKey).update(stable([relevant, process.env[PUBLIC_KEY], process.env[BINDING_KEY],
    Object.entries(options.headers_env || {}).map(([name, variable]) => [name, variable, process.env[variable]]), access_receipt_epoch(options)])).digest("hex");
}
function instant(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return NaN;
  const time = Date.parse(value), canonical = value.includes(".") ? value : value.slice(0, -1) + ".000Z";
  return Number.isFinite(time) && new Date(time).toISOString() === canonical ? time : NaN;
}

function credentials(options) {
  const entries = Object.entries(options.headers_env || {});
  if (entries.length !== 1 || !["authorization", "x-api-key"].includes(entries[0][0].toLowerCase()))
    throw new Error("OpenViking requires one dedicated search credential (Authorization or X-Api-Key)");
  const [[name, variable]] = entries, value = process.env[variable];
  if (!value || /[\r\n]/.test(value) || (name.toLowerCase() === "authorization" && !/^Bearer \S+$/.test(value)))
    throw new Error("OpenViking search credential is missing or invalid");
  return [[name.toLowerCase(), variable, value]];
}
export function search_credential_headers(options) {
  return Object.fromEntries(credentials(options).map(([name, , value]) => [name, value]));
}
export function access_error(error, options, pinnedHeaders = {}, phase = "server_contract") {
  const classification = connection_failure(error, phase);
  if (error instanceof SyntaxError)
    return Object.assign(new Error("OpenViking returned invalid JSON; response excerpt omitted"), classification);
  // Upstream text is untrusted and can encode a credential arbitrarily. Keep
  // numeric transport evidence; never forward that text as a diagnostic.
  if (error instanceof RemoteRpcError) {
    const codes = [Number.isInteger(error.status) ? "HTTP " + error.status : null,
      Number.isInteger(error.code) ? "RPC " + error.code : null].filter(Boolean).join(", ");
    return Object.assign(new Error("OpenViking upstream rejected the request" + (codes ? " (" + codes + ")" : "") + "; remote error text omitted"), classification);
  }
  const values = [process.env[BINDING_KEY], ...Object.values(pinnedHeaders),
    ...Object.values(options.headers_env || {}).map(variable => process.env[variable])].filter(Boolean);
  const secrets = [...new Set(values.flatMap(value => /^Bearer /i.test(value) ? [value, value.slice(7)] : [value]).flatMap(value => {
    const escaped = JSON.stringify(value).slice(1, -1);
    return [value, escaped, JSON.stringify(escaped).slice(1, -1)];
  }))].sort((a, b) => b.length - a.length);
  let message = String(error?.message || "OpenViking connection failed");
  for (const secret of secrets) message = message.split(secret).join("[redacted]");
  return Object.assign(new Error(message.slice(0, 2000)), classification);
}
export const surface_fingerprint = tools => sha256(stable([...tools].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
export const operation_fingerprint = tool => sha256(stable(tool));
export function verify_search_surface(access, tools, initialization) {
  if (Object.keys(initialization?.capabilities || {}).some(key => key !== "tools"))
    throw new Error("OpenViking advertises an unapproved MCP capability");
  if (tools.length !== 2 || !tools.some(tool => ["find", "search"].includes(tool.name)) || !tools.some(tool => tool.name === "read") ||
      surface_fingerprint(tools) !== access.tools_sha256)
    throw new Error("OpenViking live surface differs from the externally approved search/read contract; hiding tools does not restrict server rights");
  for (const role of ["search", "read"]) {
    const tool = tools.find(tool => role === "search" ? ["find", "search"].includes(tool.name) : tool.name === "read");
    const approval = access.operations[role];
    if (approval.name !== tool.name || approval.descriptor_sha256 !== operation_fingerprint(tool))
      throw new Error("OpenViking operation lacks external approval of its purpose and enforced read-only scope");
  }
}
export function credential_binding(options) {
  const key = process.env[BINDING_KEY];
  if (!key || Buffer.byteLength(key) < 32) throw new Error("OpenViking access binding key is missing or too short");
  return createHmac("sha256", key).update(stable(credentials(options))).digest("hex");
}
export function verify_search_access(options, collections, now = Date.now()) {
  const binding = credential_binding(options);
  let receipts, key;
  try {
    const raw = process.env[RECEIPTS];
    if (!raw || raw.length > 262144) throw new Error();
    receipts = JSON.parse(raw);
    if (!Array.isArray(receipts) || receipts.length > 64) throw new Error();
    key = createPublicKey(process.env[PUBLIC_KEY] || "");
    if (key.asymmetricKeyType !== "ed25519") throw new Error();
  } catch { throw new Error("OpenViking requires external signed search-access receipts and an operator trust key"); }
  const grants = [];
  let incompatible = false;
  for (const envelope of receipts) {
    try {
      const { payload, signature } = envelope;
      if (typeof signature !== "string" || !verify(null, Buffer.from(stable(payload)), key, Buffer.from(signature, "base64"))) continue;
      if (payload.endpoint !== options.url || payload.credential_binding !== binding) continue;
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
  if (incompatible) throw new Error("OpenViking search credentials lack a consistent current signed grant with read-only permissions");
  if (grants.length) {
    const contract = ({ verified_at, expires_at, ...payload }) => stable(payload);
    if (grants.some(grant => contract(grant) !== contract(grants[0])))
      throw new Error("OpenViking has conflicting signed access confirmations for this connection identity");
    const selected = grants.sort((a, b) => Date.parse(a.expires_at) - Date.parse(b.expires_at))[0];
    if ([...collections.values()].every(uri => selected.team_roots.some(root => uri === root || uri.startsWith(root + "/")))) return selected;
  }
  throw new Error("OpenViking search credentials lack a current signed grant for this endpoint and team area");
}
