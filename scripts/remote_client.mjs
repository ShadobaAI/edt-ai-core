import { object } from "./common.mjs";
import { json_message, response_json, DEFAULT_MAX_BYTES, wait_with_abort } from "./mcp_codec.mjs";
import { core_version } from "./compatibility.mjs";
export class RemoteRpcError extends Error {
  constructor(error) {
    super(error?.message || "MCP RPC error");
    this.error = error;
    this.code = Number.isInteger(error?.code) ? error.code : undefined;
    this.remote = true;
  }
}
export class RemoteHttpError extends RemoteRpcError {
  constructor(status, reason, error) {
    super(error);
    this.status = status;
    this.message = `MCP HTTP ${status}: ${reason}${error?.message ? ": " + error.message : ""}`;
  }
}
export class RemoteSessionExpired extends Error {}
export class RemoteContractError extends Error {
  category = "server_contract";
}
export function header_value(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return /[^\x20-\x7e]/.test(text) ||
    (text.startsWith("=?") && text.endsWith("?="))
    ? "=?base64?" + Buffer.from(text).toString("base64") + "?="
    : text;
}
export function tool_header_fields(schema) {
  const fields = [],
    names = new Set();
  function walk(node, location = null) {
    if (Array.isArray(node)) node.forEach((child) => walk(child));
    else if (object(node)) {
      if (Object.hasOwn(node, "x-mcp-header")) {
        const name = node["x-mcp-header"],
          kind = node.type;
        if (
          !location?.length ||
          typeof name !== "string" ||
          !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
          names.has(name.toLowerCase()) ||
          !["string", "integer", "boolean"].includes(kind)
        )
          throw new Error("Invalid x-mcp-header annotation");
        names.add(name.toLowerCase());
        fields.push([location, name, kind]);
      }
      for (const [key, child] of Object.entries(node)) {
        if (key === "properties" && location !== null && object(child))
          for (const [name, prop] of Object.entries(child))
            walk(prop, [...location, name]);
        else if (!["const", "enum", "default", "examples"].includes(key))
          walk(child);
      }
    }
  }
  walk(schema, []);
  return fields;
}
export class RemoteMcp {
  static MODERN_PROTOCOL = "2026-07-28";
  static LEGACY_PROTOCOLS = [
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
  ];
  constructor(url, timeout = 30, options = {}) {
    this.options = options;
    this.maxBytes = options.maxBytes || DEFAULT_MAX_BYTES;
    this.url = url;
    this.timeout = Math.max(1, Math.ceil(timeout * 1000));
    this.session = null;
    this.protocol = "2024-11-05";
    this.sequence = 0;
    this.tools_revision = 0;
    this.resources_revision = 0;
    this.initialization = {};
    this.tool_headers = new Map();
    this.activeRequests = new Set();
    this.generation = 0;
    this.closing = null;
    this.accepting = true;
    this.initializationUncertain = false;
  }
  result(message) {
    if (message.error) throw new RemoteRpcError(message.error);
    if (!object(message.result)) throw new RemoteContractError("Invalid MCP result");
    if ((message.result.resultType || "complete") !== "complete")
      throw new RemoteContractError(
        "Unsupported MCP result type; operation is not confirmed complete",
      );
    return message.result;
  }
  credential_headers() {
    if (this.options.credentialHeaders) return this.options.credentialHeaders();
    return Object.fromEntries(Object.entries(this.options.headers_env || {}).map(([name, variable]) => {
      if (!process.env[variable]) throw Object.assign(new Error("Missing connection credential environment variable: " + variable), { category: "authorization" });
      return [name, process.env[variable]];
    }));
  }
  async send(payload, expect_reply = true, onDispatch) {
    if (!this.accepting) throw new Error("MCP connection is closed; initialize a new connection before sending");
    this.options.beforeRequest?.(payload);
    const modern = this.protocol === RemoteMcp.MODERN_PROTOCOL;
    const headers = {
      ...this.credential_headers(),
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": this.protocol,
    };
    let wire = payload;
    if (modern && payload.method) {
      const params = {
        ...payload.params,
        _meta: {
          ...payload.params?._meta,
          "io.modelcontextprotocol/protocolVersion": this.protocol,
          "io.modelcontextprotocol/clientInfo": {
            name: "1c-ai-core",
            version: core_version,
          },
          "io.modelcontextprotocol/clientCapabilities": this.options.capabilities || {},
        },
      };
      wire = { ...payload, params };
      headers["Mcp-Method"] = payload.method || "";
      if (
        ["tools/call", "resources/read", "prompts/get"].includes(payload.method)
      ) {
        const name =
          params[payload.method === "resources/read" ? "uri" : "name"];
        if (typeof name === "string" && name)
          headers["Mcp-Name"] = header_value(name);
      }
      if (payload.method === "tools/call") {
        const fields = this.tool_headers.get(params.name);
        if (fields instanceof Error) throw new Error(`Incompatible native HTTP contract for ${params.name}: ${fields.message}`);
        for (const [location, name, kind] of fields || []) {
          let value = params.arguments || {};
          for (const key of location)
            value = object(value) ? value[key] : undefined;
          if (value == null) continue;
          if (
            (kind === "integer" && !Number.isSafeInteger(value)) ||
            (kind !== "integer" && typeof value !== kind)
          )
            throw new Error(
              "Invalid HTTP-mirrored tool parameter: " + location.join("."),
            );
          headers["Mcp-Param-" + name] = header_value(value);
        }
      }
    }
    if (this.session && !modern) headers["Mcp-Session-Id"] = this.session;
    if (payload.method === "initialize") delete headers["MCP-Protocol-Version"];
    const body = JSON.stringify(wire);
    onDispatch?.();
    if (!this.accepting) throw new Error("MCP connection is closed; request was not sent");
    const active = { controller: new AbortController(), method: payload.method, closeTimer: null };
    this.activeRequests.add(active);
    const signal = AbortSignal.any([active.controller.signal, AbortSignal.timeout(this.timeout)]);
    active.settled = this.exchange(payload, body, headers, modern, expect_reply, signal)
      .catch(error => {
        if (payload.method === "initialize" && !this.session) this.initializationUncertain = true;
        throw error;
      })
      .finally(() => { clearTimeout(active.closeTimer); this.activeRequests.delete(active); });
    return active.settled;
  }
  async exchange(payload, body, headers, modern, expect_reply, signal) {
    const response = await fetch(this.url, {
      method: "POST",
      headers,
      body,
      signal,
      redirect: "error",
    });
    if (!response.ok) {
      let rpc;
      try {
        const body = await response_json(response, this.maxBytes);
        if (object(body.error)) rpc = body.error;
      } catch {}
      if (response.status === 404 && this.session && rpc?.code !== -32601)
        throw new RemoteSessionExpired(
          "MCP session expired (404); reconnect the selected project profile",
        );
      throw new RemoteHttpError(response.status, response.statusText, rpc);
    }
    if (!modern)
      this.session = response.headers.get("Mcp-Session-Id") || this.session;
    if (!expect_reply) {
      await response.body?.cancel();
      return {};
    }
    if ([202, 204].includes(response.status)) {
      await response.body?.cancel();
      throw new Error("MCP request received no result; outcome unknown");
    }
    if (response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "text/event-stream") {
      const message = await response_json(response, this.maxBytes);
      if (message.id !== payload.id)
        throw new RemoteContractError("MCP response ID mismatch; outcome unknown");
      return this.result(message);
    }
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let buffer = "",
      event = [],
      bytes = 0,
      skipLF = false;
    try {
      while (true) {
        const { value, done } = await reader.read();
        bytes += value?.length || 0;
        if (bytes > this.maxBytes)
          throw new Error("MCP output budget exceeded; outcome unknown");
        buffer += decoder.decode(value, { stream: !done });
        if (skipLF && buffer.length) {
          if (buffer.startsWith("\n")) buffer = buffer.slice(1);
          skipLF = false;
        }
        let match;
        while ((match = /\r\n|\r|\n/.exec(buffer))) {
          const line = buffer.slice(0, match.index);
          skipLF = match[0] === "\r" && match.index === buffer.length - 1;
          buffer = buffer.slice(match.index + match[0].length);
          if (line.startsWith("data:")) event.push(line.slice(5).replace(/^ /, ""));
          else if (!line && event.length) {
            const message = json_message(event.join("\n"), this.maxBytes);
            event = [];
            if (message.method === "notifications/tools/list_changed")
              this.tools_revision++;
            if (["notifications/resources/updated", "notifications/resources/list_changed"].includes(message.method))
              this.resources_revision++;
            if (message.id === payload.id && !message.method)
              return this.result(message);
            if (message.method && Object.hasOwn(message, "id")) {
              if (!this.options.onRequest) throw new Error("This MCP endpoint requires unsupported client callbacks; outcome unknown");
              let reply;
              try { reply = { result: await wait_with_abort(() => this.options.onRequest(message, { signal }), signal) }; }
              catch (error) { reply = { error: { code: error.code || -32603, message: error.message } }; }
              signal.throwIfAborted();
              await this.send({ jsonrpc: "2.0", id: message.id, ...reply }, false);
            } else if (message.method) this.options.onNotification?.(message);
          }
        }
        if (done) break;
      }
      throw new Error("MCP stream ended before the response; outcome unknown");
    } finally {
      try { await reader.cancel(); } catch {} finally { reader.releaseLock(); }
    }
  }
  async request(method, params = {}, options = {}) {
    const id = ++this.sequence;
    options.onId?.(id);
    let result = await this.send({
      jsonrpc: "2.0",
      id,
      method,
      params,
    }, true, options.onDispatch);
    if (
      this.protocol === RemoteMcp.MODERN_PROTOCOL &&
      method === "tools/list" &&
      Array.isArray(result.tools)
    ) {
      if (!params.cursor) this.tool_headers.clear();
      for (const tool of result.tools) {
        try {
          this.tool_headers.set(
            tool.name,
            tool_header_fields(tool.inputSchema || {}),
          );
        } catch (error) {
          this.tool_headers.set(tool.name, error);
        }
      }
    }
    return result;
  }
  notify(method, params = {}) {
    return this.send({ jsonrpc: "2.0", method, params }, false);
  }
  async initialize() {
    const closing = this.close(), generation = this.generation;
    await closing;
    if (generation !== this.generation) throw new Error("MCP connection closed during initialization");
    this.accepting = true;
    this.protocol = RemoteMcp.MODERN_PROTOCOL;
    this.sequence = 0;
    try {
      const result = await this.request("server/discover");
      if (generation !== this.generation) throw new Error("MCP connection closed during initialization");
      if (
        !Array.isArray(result.supportedVersions) ||
        !result.supportedVersions.includes(this.protocol)
      )
        throw new RemoteContractError(
          "server/discover did not advertise the modern MCP protocol",
        );
      this.session = null;
      this.initialization = result;
      return result;
    } catch (error) {
      if (
        !(error instanceof RemoteRpcError) ||
        [-32020, -32021, -32022].includes(error.code) ||
        (error instanceof RemoteHttpError
          ? ![400, 404, 405].includes(error.status)
          : error.code !== -32601)
      )
        throw error;
    }
    if (generation !== this.generation) throw new Error("MCP connection closed during initialization");
    this.protocol = RemoteMcp.LEGACY_PROTOCOLS[0];
    this.session = null;
    this.sequence = 0;
    try {
      const result = await this.request("initialize", {
        protocolVersion: this.protocol,
        clientInfo: { name: "1c-ai-core", version: core_version },
        capabilities: this.options.capabilities || {},
      });
      if (!RemoteMcp.LEGACY_PROTOCOLS.includes(result.protocolVersion))
        throw new RemoteContractError(
          "Invalid legacy MCP negotiated version",
        );
      this.protocol = result.protocolVersion;
      if (generation !== this.generation) throw new Error("MCP connection closed during initialization");
      await this.notify("notifications/initialized");
      if (generation !== this.generation) throw new Error("MCP connection closed during initialization");
      this.initialization = result;
      return result;
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  close() {
    this.generation++;
    this.accepting = false;
    if (this.closing) return this.closing;
    const closing = this.closeTransport();
    this.closing = closing;
    // A failed cleanup is sticky: a second close must not silently report
    // success or start a new session while the old outcome is unknown.
    closing.then(() => { if (this.closing === closing) this.closing = null; }, () => {});
    return closing;
  }
  async closeTransport() {
    this.initialization = {};
    this.tool_headers.clear();
    // Ending a local transport does not prove the remote operation was stopped.
    // Abort its HTTP resources while preserving the unknown-outcome semantics.
    const pending = [...this.activeRequests];
    for (const active of pending) {
      const abort = () => active.controller.abort(Object.assign(new Error("MCP connection closed; pending operation outcome unknown"), { outcomeUnknown: true }));
      if (active.method === "initialize") {
        // A late initialize may establish a server session. Give its response
        // a bounded chance to supply the ID so that it can be deleted.
        if (!active.closeTimer) {
          active.closeTimer = setTimeout(abort, Math.min(this.timeout, 5000));
          active.closeTimer.unref();
        }
      } else abort();
    }
    const results = await Promise.allSettled(pending.map(active => active.settled));
    const session = this.session;
    // An unanswered initialize may have created a session without returning
    // its identifier. Closing the socket cannot prove remote cleanup.
    if (!session && (this.initializationUncertain || pending.some((active, index) => active.method === "initialize" && results[index].status === "rejected")))
      throw Object.assign(new Error("Завершение удалённой MCP-сессии не подтверждено после прерванной инициализации."), { outcomeUnknown: true, code: "MCP_CLEANUP_UNKNOWN" });
    if (!session) return;
    let response;
    try {
      response = await fetch(this.url, {
        method: "DELETE",
        headers: {
          ...this.credential_headers(),
          "Mcp-Session-Id": session,
          "MCP-Protocol-Version": this.protocol,
        },
        signal: AbortSignal.timeout(Math.min(this.timeout, 5000)),
        redirect: "error",
      });
      await response.body?.cancel();
      // A proxy or an unsupported DELETE route can also return 404; it does
      // not by itself attest that this server-side session was destroyed.
      if (!response.ok)
        throw Object.assign(new Error("Удалённый MCP не подтвердил завершение сессии (HTTP " + response.status + ")."), { status: response.status });
      this.session = null;
    } catch (error) {
      throw Object.assign(new Error(error.status === 405
        ? "Удалённый MCP не поддерживает завершение сессии; её освобождение не подтверждено."
        : "Завершение удалённой MCP-сессии не подтверждено."), { outcomeUnknown: true, code: "MCP_CLEANUP_UNKNOWN", ...(error.status ? { status: error.status } : {}) });
    }
  }
}
