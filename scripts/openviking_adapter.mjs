// Protocol translation, not an upstream tool catalogue. Unknown dialects fail
// closed. Only the connected server's validated descriptors authorize a call.
import { Ajv, Ajv2020 } from "../vendor/deps.mjs";
import { object } from "./common.mjs";
import { RemoteMcp } from "./remote_client.mjs";
import { all_pages } from "./mcp_pages.mjs";
import { knowledge_status, search_requirements, parse_material, knowledge_material_active, knowledge_material_summary } from "./knowledge.mjs";

export const OPENVIKING_LIMITS = Object.freeze({ concurrent: 2, queued: 8, candidates: 10, toolPages: 16,
  tools: 256, collections: 64, metadataChars: 8000, resultChars: 32000, contentChars: 24000 });

function compiler(schema) {
  if (!object(schema)) throw new Error("Missing live MCP schema");
  const Compiler = /draft-07/.test(schema.$schema || "") ? Ajv : Ajv2020;
  return new Compiler({ strict: false, allErrors: true, ownProperties: true, validateFormats: false }).compile(schema);
}
export function knowledge_uri(uri) {
  if (typeof uri !== "string" || uri.length > 2048 || !/^viking:\/\/resources\/[\p{L}\p{N}._/-]+$/u.test(uri) ||
      uri.slice("viking://resources/".length).split("/").some(part => !part || part === "." || part === ".."))
    throw new Error("Knowledge URI must be a canonical shared resources path");
  return uri;
}
function result_text(result) {
  if (!object(result) || result.isError || !Array.isArray(result.content) ||
      result.content.length !== 1 || result.content[0]?.type !== "text" || typeof result.content[0].text !== "string")
    throw new Error("Invalid or failed OpenViking text response");
  const text = result.content[0].text;
  if (result.structuredContent !== undefined && (!object(result.structuredContent) || result.structuredContent.result !== text))
    throw new Error("Inconsistent OpenViking structured/text response");
  return text;
}
// Same separators as the server's Python str.splitlines(keepends=True).
const line_count = text => {
  if (!text) return 0;
  const breaks = [...text.matchAll(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/g)], last = breaks.at(-1);
  return breaks.length + Number(!last || last.index + last[0].length < text.length);
};
export class OpenVikingAdapter {
  constructor(profile, config, client = null) {
    this.profile = structuredClone(profile);
    this.config = structuredClone(config);
    this.options = this.config.mcp.optional.openviking;
    this.requirements = search_requirements(profile);
    this.client = client || new RemoteMcp(this.options.url, this.options.timeout_seconds, {
      headers_env: this.options.headers_env, maxBytes: this.options.max_response_bytes });
    this.connected = false;
    this.active = 0; this.waiters = []; this.closed = false;
  }
  async connect() {
    const status = knowledge_status(this.profile, this.config);
    if (status.state !== "not_verified") throw new Error(status.detail);
    const map = this.profile.knowledge.collection_uris || {};
    if (this.profile.knowledge.collections.length > OPENVIKING_LIMITS.collections) throw new Error("Selected collection budget exceeded");
    this.collections = new Map(this.profile.knowledge.collections.map(id => {
      if (!map[id]) throw new Error("Explicit knowledge.collection_uris mapping required: " + id);
      return [id, knowledge_uri(map[id])];
    }));
    await this.client.initialize();
    try {
      await this.refreshContract();
      this.connected = true;
      return this.status();
    } catch (error) { await this.close(); throw error; }
  }
  status() {
    return { connected: this.connected, ready: false, contract: { search: this.searchTool?.name, read: this.readTool?.name },
      publication: "not_verified", access: "not_verified" };
  }
  async refreshContract() {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      const revision = this.client.tools_revision;
      const tools = (await all_pages({ request: (method, params) => this.request(method, params) }, "tools/list", "tools", {
        maxPages: OPENVIKING_LIMITS.toolPages, maxItems: OPENVIKING_LIMITS.tools })).tools;
      if (revision !== this.client.tools_revision) throw new Error("OpenViking contract changed during discovery");
      const compile = tool => ({ ...tool, input: compiler(tool.inputSchema), output: tool.outputSchema ? compiler(tool.outputSchema) : null });
      this.searchTool = tools.find(tool => ["find", "search"].includes(tool.name) &&
        ["query", "target_uri", "limit"].every(key => Object.hasOwn(tool.inputSchema?.properties || {}, key)));
      this.readTool = tools.find(tool => tool.name === "read" &&
        ["uris", "offset", "limit"].every(key => Object.hasOwn(tool.inputSchema?.properties || {}, key)));
      if (!this.searchTool || !this.readTool) throw new Error("Unsupported live OpenViking search/read contract");
      this.searchTool = compile(this.searchTool); this.readTool = compile(this.readTool);
      // Test the actual scoped argument shapes before any native operation.
      const target = this.collections.values().next().value;
      this.arguments(this.searchTool, this.searchArgs("contract probe", target, 1));
      this.arguments(this.readTool, { uris: target + "/probe.md", offset: 0, limit: 1 });
      this.contractRevision = revision;
    })();
    try { await this.refreshPromise; }
    catch (error) { await this.close(); throw error; }
    finally { this.refreshPromise = null; }
  }
  async ensureContract(force = false) {
    if (!this.connected) throw new Error("OpenViking is not connected");
    if (force || this.contractRevision !== this.client.tools_revision) await this.refreshContract();
  }
  async request(method, params) {
    if (this.closed) throw new Error("OpenViking adapter is closed");
    if (this.active < OPENVIKING_LIMITS.concurrent) this.active++;
    else {
      if (this.waiters.length >= OPENVIKING_LIMITS.queued) throw new Error("OpenViking request queue budget exceeded");
      await new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
    }
    try {
      if (this.closed) throw new Error("OpenViking adapter is closed");
      return await this.client.request(method, params);
    } finally {
      const next = this.waiters.shift();
      if (next) next.resolve(); else this.active--;
    }
  }
  arguments(tool, args) {
    if (!tool.input(args)) throw new Error("Incompatible live arguments for " + tool.name);
    return args;
  }
  searchArgs(query, target, limit) {
    const props = this.searchTool.inputSchema.properties;
    return { query, target_uri: target, limit,
      ...(this.searchTool.name === "search" && props.mode ? { mode: "list" } : {}),
      ...(props.read_content ? { read_content: false } : {}) };
  }
  async invoke(role, args) {
    await this.ensureContract();
    const tool = this[role + "Tool"];
    if (typeof args === "function") args = args();
    this.arguments(tool, args);
    const result = await this.request("tools/call", { name: tool.name, arguments: args });
    if (!this.connected || this.closed || this.contractRevision !== this.client.tools_revision)
      throw new Error("OpenViking connection or contract changed during retrieval; discard this result");
    if (tool.output && !tool.output(result.structuredContent)) throw new Error("Invalid live output for " + tool.name);
    const text = result_text(result);
    if (result.nextCursor != null || result._meta?.nextCursor != null)
      throw new Error("Unsupported OpenViking pagination contract; results are incomplete");
    const partial = [result, result._meta].some(value => value &&
      (value.truncated === true || value.partial === true || value.complete === false || value.hasMore === true));
    return { text, partial };
  }
  collection(id) {
    const uri = this.collections?.get(id);
    if (!uri) throw new Error("Collection is outside the selected profile");
    return uri;
  }
  scoped(uri, collection) {
    knowledge_uri(uri);
    if (!uri.startsWith(this.collection(collection) + "/") || !uri.endsWith(".md")) throw new Error("Material is outside the selected collection");
    return uri;
  }
  async search({ query, collection, limit = this.requirements.max_results }) {
    if (typeof query !== "string" || !query.trim() || query.length > 8000 || !Number.isInteger(limit) || limit < 1 || limit > this.requirements.max_results)
      throw new Error("Invalid knowledge search arguments");
    const effectiveLimit = Math.min(limit, OPENVIKING_LIMITS.candidates);
    const reply = await this.invoke("search", () => this.searchArgs(query, this.collection(collection), effectiveLimit)), text = reply.text;
    const completeness = { complete: false, apiExistence: "not_determined", coverage: "not_verified",
      pagination: "unsupported_by_dialect", serverPartial: reply.partial, limitReached: false,
      scope: { collection, targetUri: this.collection(collection), limited: true }, requestedLimit: limit, effectiveLimit,
      budgetLimited: effectiveLimit < limit };
    if (text === "No matching context found.") return { items: [], ...completeness, outcome: "no_matches" };
    const count = /^Found (\d+) item\(s\):\n\n/.exec(text);
    const hits = [...text.matchAll(/^- \[resource (\d+)%\] (viking:\/\/[^\s]+)\r?\n/gm)];
    if (!count || Number(count[1]) !== hits.length || hits.length > effectiveLimit) throw new Error("Unsupported or incomplete OpenViking search response");
    const seen = new Set();
    const candidates = hits.map(hit => {
      const uri = this.scoped(hit[2], collection);
      if (seen.has(uri)) throw new Error("Duplicate OpenViking hit");
      seen.add(uri);
      return { uri, collection, score: Number(hit[1]) / 100 };
    });
    const items = [];
    let filtered = 0, examined = 0, resultChars = 2;
    for (const candidate of candidates) {
      const material = await this.material(candidate.uri, collection);
      examined++;
      if (!knowledge_material_active(material.metadata)) { filtered++; continue; }
      const item = { ...candidate, ...knowledge_material_summary(material.metadata, {
        body: material.body, maxExcerptChars: this.requirements.max_excerpt_chars, partial: material.partial }) };
      const size = JSON.stringify(item).length + 1;
      if (resultChars + size > OPENVIKING_LIMITS.contentChars) { completeness.budgetLimited = true; break; }
      items.push(item); resultChars += size;
    }
    return { items, ...completeness, filtered, examined, candidates: candidates.length, unexpanded: candidates.length - examined,
      limitReached: candidates.length === effectiveLimit, outcome: items.length ? "matches" : filtered ? "filtered_empty" : completeness.budgetLimited ? "budget_limited" : "no_matches" };
  }
  async material(uri, collection) {
    this.scoped(uri, collection);
    // A small header/body window for selected hits only, never a corpus walk.
    const reply = await this.invoke("read", { uris: uri, offset: 0, limit: 200 }), text = reply.text;
    const window = text.slice(0, this.requirements.max_material_chars);
    let metadata;
    try { metadata = parse_material(window); }
    catch (error) { throw new Error("Invalid or over-budget material metadata: " + error.message); }
    if (JSON.stringify(metadata).length > OPENVIKING_LIMITS.metadataChars) throw new Error("Knowledge metadata budget exceeded");
    const body = window.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
    return { metadata, body, text, serverPartial: reply.partial, partial: reply.partial || line_count(text) >= 200 || window.length < text.length };
  }
  async read({ uri, collection, offset = 0, limit = 200, charOffset = 0 }) {
    this.scoped(uri, collection);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isSafeInteger(charOffset) || charOffset < 0) throw new Error("Invalid material line/character range");
    const material = await this.material(uri, collection);
    if (!knowledge_material_active(material.metadata)) throw new Error("Inactive knowledge material is excluded from active retrieval");
    const reply = offset === 0 && limit === 200 ? { text: material.text, partial: material.serverPartial } : await this.invoke("read", { uris: uri, offset, limit });
    const text = reply.text;
    if (charOffset > text.length) throw new Error("Character offset exceeds the returned material window");
    const summary = knowledge_material_summary(material.metadata);
    const textBudget = OPENVIKING_LIMITS.contentChars - JSON.stringify({ uri, collection, ...summary }).length - 1024;
    let start = charOffset, end = Math.min(text.length, charOffset + this.requirements.max_material_chars);
    const maximum = end;
    // Account for JSON escaping, not just the length of unescaped content.
    while (start < end) {
      const middle = Math.ceil((start + end) / 2);
      if (JSON.stringify(text.slice(charOffset, middle)).length - 2 <= textBudget) start = middle; else end = middle - 1;
    }
    end = Math.min(start, maximum);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
    const truncated = end < text.length, hasMoreLines = line_count(text) >= limit;
    return { uri, collection, ...summary,
      text: text.slice(charOffset, end), truncated, serverPartial: reply.partial,
      next: truncated ? { offset, limit, charOffset: end } : hasMoreLines ? { offset: offset + line_count(text), limit, charOffset: 0 } : null,
      offset, limit, charOffset, complete: false };
  }
  async close() {
    this.connected = false; this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(new Error("OpenViking adapter closed while queued"));
    await this.client.close();
  }
}
