// Protocol translation, not an upstream tool catalogue. Unknown dialects fail
// closed. Only the connected server's validated descriptors authorize a call.
import { Ajv, Ajv2020 } from "../vendor/deps.mjs";
import { object, stable } from "./common.mjs";
import { sha256 } from "./project_paths.mjs";
import { RemoteMcp } from "./remote_client.mjs";
import { all_pages } from "./mcp_pages.mjs";
import { verify_search_access, search_credential_headers, verify_search_surface, access_revision, access_error } from "./openviking_access.mjs";
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
  constructor(profile, config, client = null, validateBinding = null) {
    this.profile = structuredClone(profile);
    this.config = structuredClone(config);
    this.options = this.config.mcp.optional.openviking;
    this.requirements = search_requirements(profile);
    this.validateBinding = validateBinding;
    this.client = client || new RemoteMcp(this.options.url, this.options.timeout_seconds, {
      credentialHeaders: () => ({ ...this.credentialHeaders }), maxBytes: this.options.max_response_bytes,
      beforeRequest: payload => { this.validateBinding?.(); this.checkAccess(); this.validateRequest(payload.method, payload.params, true); } });
    this.connected = false;
    this.active = 0; this.waiters = []; this.closed = false;
  }
  async connect() {
    if (this.closed) throw new Error("OpenViking adapter is closed");
    const status = knowledge_status(this.profile, this.config);
    if (status.state !== "not_verified") throw new Error(status.detail);
    const map = this.profile.knowledge.collection_uris || {};
    if (this.profile.knowledge.collections.length > OPENVIKING_LIMITS.collections) throw new Error("Selected collection budget exceeded");
    this.collections = new Map(this.profile.knowledge.collections.map(id => {
      if (!map[id]) throw new Error("Explicit knowledge.collection_uris mapping required: " + id);
      return [id, knowledge_uri(map[id])];
    }));
    try {
      this.access = verify_search_access(this.options, this.collections);
      this.accessRevision = access_revision(this.options);
      this.credentialHeaders = search_credential_headers(this.options);
      await this.client.initialize();
      if (this.closed) {
        // A late initialize may assign a remote session after close() ran.
        await this.client.close();
        throw new Error("OpenViking adapter closed during connection");
      }
      this.validateBinding?.();
      await this.refreshContract();
      if (this.closed) throw new Error("OpenViking adapter closed during connection");
      this.connected = true;
      return this.status();
    } catch (error) { await this.close(); throw access_error(error, this.options, this.credentialHeaders); }
  }
  status() {
    return { connected: this.connected, ready: false, contract: { search: this.searchTool?.name, read: this.readTool?.name },
      publication: "not_verified", access: this.connected ? "externally_attested" : "not_verified",
      accessEvidence: this.connected ? { source: "operator_signature", deploymentId: this.access.verification.deployment_id,
        policyRevision: this.access.verification.policy_revision, verifiedAt: this.access.verified_at,
        expiresAt: this.access.expires_at, liveTestByPlugin: false } : null };
  }
  checkAccess() {
    const access = verify_search_access(this.options, this.collections);
    if (this.accessRevision && this.accessRevision !== access_revision(this.options))
      throw new Error("OpenViking access confirmation or identity changed; reconnect required");
    if (this.access && this.access.credential_binding !== access.credential_binding)
      throw new Error("OpenViking connection credentials changed; reconnect required");
    return access;
  }
  async refreshContract() {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      const revision = this.client.tools_revision;
      let pageContext;
      const tools = (await all_pages({ request: async (method, params) => {
        const page = await this.request(method, params), current = stable(page._meta ?? null);
        if (pageContext !== undefined && pageContext !== current) throw new Error("OpenViking response context changed during discovery; discard mixed pages");
        pageContext = current;
        return page;
      } }, "tools/list", "tools", {
        maxPages: OPENVIKING_LIMITS.toolPages, maxItems: OPENVIKING_LIMITS.tools })).tools;
      if (this.closed) throw new Error("OpenViking adapter closed during discovery");
      if (revision !== this.client.tools_revision) throw new Error("OpenViking contract changed during discovery");
      verify_search_surface(this.checkAccess(), tools, this.client.initialization);
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
    this.validateRequest(method, params);
    if (this.active < OPENVIKING_LIMITS.concurrent) this.active++;
    else {
      if (this.waiters.length >= OPENVIKING_LIMITS.queued) throw new Error("OpenViking request queue budget exceeded");
      await new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
    }
    try {
      if (this.closed) throw new Error("OpenViking adapter is closed");
      this.validateBinding?.();
      this.checkAccess();
      this.validateRequest(method, params);
      const result = await this.client.request(method, params);
      if (this.closed) throw new Error("OpenViking adapter closed during request");
      this.validateBinding?.(); this.checkAccess();
      return result;
    } catch (error) {
      await this.close(); throw access_error(error, this.options, this.credentialHeaders);
    } finally {
      const next = this.waiters.shift();
      if (next) next.resolve(); else this.active--;
    }
  }
  validateRequest(method, params = {}, transport = false) {
    if (transport && ["server/discover", "initialize", "notifications/initialized"].includes(method)) return;
    if (method === "tools/list") return;
    if (method !== "tools/call" || !this.searchTool || !this.readTool)
      throw new Error("OpenViking operation is outside the permitted search/read surface");
    if (this.contractRevision !== this.client.tools_revision)
      throw new Error("OpenViking approved contract changed before the operation; rediscovery required");
    const args = params.arguments;
    if (!object(args) || Object.keys(params).some(key => !["name", "arguments"].includes(key)))
      throw new Error("Invalid OpenViking operation envelope");
    if (params.name === this.searchTool.name) {
      if (typeof args.query !== "string" || !args.query.trim() || args.query.length > 8000 ||
          !Number.isInteger(args.limit) || args.limit < 1 || args.limit > Math.min(this.requirements.max_results, OPENVIKING_LIMITS.candidates) ||
          ![...this.collections.values()].includes(args.target_uri) ||
          stable(args) !== stable(this.searchArgs(args.query, args.target_uri, args.limit)))
        throw new Error("OpenViking search must use the selected team collection and bounded arguments");
      this.arguments(this.searchTool, args);
    } else if (params.name === this.readTool.name) {
      const collection = [...this.collections].find(([, root]) => typeof args.uris === "string" && args.uris.startsWith(root + "/"))?.[0];
      if (!collection || args.offset !== 0 || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 1000 ||
          Object.keys(args).some(key => !["uris", "offset", "limit"].includes(key)))
        throw new Error("OpenViking read must use a selected team material and bounded arguments");
      this.scoped(args.uris, collection);
      this.arguments(this.readTool, args);
    } else throw new Error("OpenViking operation is outside the permitted search/read surface");
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
  retrievalEpoch() {
    return stable([this.client.tools_revision, this.client.resources_revision || 0]);
  }
  assertRetrieval(retrieval) {
    if (!this.connected || this.closed || retrieval.epoch !== this.retrievalEpoch())
      throw new Error("OpenViking connection, contract or resources changed during retrieval; discard this result");
  }
  async invoke(role, args, retrieval = {}) {
    // An explicit list is also required when the server omits list_changed.
    await this.ensureContract(true);
    retrieval.epoch ??= this.retrievalEpoch();
    this.assertRetrieval(retrieval);
    const tool = this[role + "Tool"];
    if (typeof args === "function") args = args();
    this.arguments(tool, args);
    const result = await this.request("tools/call", { name: tool.name, arguments: args });
    this.assertRetrieval(retrieval);
    const responseContext = sha256(stable([retrieval.epoch, result._meta ?? null]));
    // Opaque MCP response metadata is only a change detector, never proof of
    // publication. Missing/changing context cannot silently join another page.
    if (retrieval.responseContext !== undefined && retrieval.responseContext !== responseContext)
      throw new Error("OpenViking response context changed during retrieval; discard mixed results");
    retrieval.responseContext = responseContext;
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
    const target = this.collection(collection);
    const retrieval = {};
    const reply = await this.invoke("search", () => this.searchArgs(query, target, effectiveLimit), retrieval), text = reply.text;
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
    // The native dialect has no verified snapshot contract. Enriching hits with
    // later reads would mix publications even when all response metadata agrees.
    // Pointers are not active materials; each must be read as fresh discovery.
    return { items: [], discoveryCandidates: candidates, ...completeness, filtered: 0, examined: 0,
      candidates: candidates.length, unexpanded: candidates.length, metadata: "not_checked",
      expansion: "blocked_until_snapshot_verified", limitReached: candidates.length === effectiveLimit,
      outcome: candidates.length ? "unverified_candidates" : "no_matches" };
  }
  async material(uri, collection, retrieval = {}, limit = 200) {
    this.scoped(uri, collection);
    // A small header/body window for selected hits only, never a corpus walk.
    const reply = await this.invoke("read", { uris: uri, offset: 0, limit }, retrieval), text = reply.text;
    const window = text.slice(0, this.requirements.max_material_chars);
    let metadata;
    try { metadata = parse_material(window); }
    catch { throw new Error("Invalid or over-budget material metadata; parser excerpt omitted"); }
    if (JSON.stringify(metadata).length > OPENVIKING_LIMITS.metadataChars) throw new Error("Knowledge metadata budget exceeded");
    const body = window.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
    return { metadata, body, text, serverPartial: reply.partial, partial: reply.partial || line_count(text) >= limit || window.length < text.length };
  }
  async read({ uri, collection, offset = 0, limit = 200, charOffset = 0, continuation }) {
    this.scoped(uri, collection);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isSafeInteger(charOffset) || charOffset < 0) throw new Error("Invalid material line/character range");
    if (offset !== 0) throw new Error("Line offsets require a verified publication snapshot; restart at offset 0 with a larger line limit");
    const retrieval = {}, material = await this.material(uri, collection, retrieval, limit);
    const materialFingerprint = sha256(material.text);
    if (continuation && (continuation.materialRevision !== material.metadata.revision ||
        continuation.materialFingerprint !== materialFingerprint || continuation.responseContext !== retrieval.responseContext))
      throw new Error("Material revision changed or response context changed during continuation; discard this result");
    if (!knowledge_material_active(material.metadata)) throw new Error("Inactive knowledge material is excluded from active retrieval");
    const reply = { text: material.text, partial: material.serverPartial };
    const text = reply.text;
    const windowFingerprint = sha256(text);
    if (continuation && charOffset > 0 && continuation.windowFingerprint !== windowFingerprint)
      throw new Error("Material window changed during continuation; discard this result");
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
    return { uri, collection, ...summary, retrieval: { materialFingerprint, responseContext: retrieval.responseContext, windowFingerprint },
      text: text.slice(charOffset, end), truncated, serverPartial: reply.partial,
      next: truncated ? { offset, limit, charOffset: end } : null,
      hasMoreLines, lineContinuation: hasMoreLines ? "blocked_until_snapshot_verified" : null,
      offset, limit, charOffset, complete: false };
  }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.connected = false; this.closed = true;
    this.searchTool = null; this.readTool = null; this.collections?.clear();
    for (const waiter of this.waiters.splice(0)) waiter.reject(new Error("OpenViking adapter closed while queued"));
    this.closePromise = this.client.close();
    await this.closePromise;
  }
}
