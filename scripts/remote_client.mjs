import { object } from "./common.mjs";
import { json_message, response_json, DEFAULT_MAX_BYTES } from "./mcp_codec.mjs";
import { core_version } from "./compatibility.mjs";
export class RemoteRpcError extends Error {
  constructor(error) {
    super(error?.message || "MCP RPC error");
    this.error = error;
    this.code = error?.code;
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
    this.timeout = timeout * 1000;
    this.session = null;
    this.protocol = "2024-11-05";
    this.sequence = 0;
    this.tools_revision = 0;
    this.initialization = {};
    this.tool_headers = new Map();
  }
  result(message) {
    if (message.error) throw new RemoteRpcError(message.error);
    if (!object(message.result)) throw new Error("Invalid MCP result");
    if ((message.result.resultType || "complete") !== "complete")
      throw new Error(
        "Unsupported MCP result type; operation is not confirmed complete: " +
          message.result.resultType,
      );
    return message.result;
  }
  credential_headers() {
    return Object.fromEntries(Object.entries(this.options.headers_env || {}).map(([name, variable]) => {
      if (!process.env[variable]) throw new Error("Missing connection credential environment variable: " + variable);
      return [name, process.env[variable]];
    }));
  }
  async send(payload, expect_reply = true) {
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
    const response = await fetch(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify(wire),
      signal: AbortSignal.timeout(this.timeout),
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
    if ([202, 204].includes(response.status))
      throw new Error("MCP request received no result; outcome unknown");
    if (!response.headers.get("Content-Type")?.includes("text/event-stream")) {
      const message = await response_json(response, this.maxBytes);
      if (message.id !== payload.id)
        throw new Error("MCP response ID mismatch; outcome unknown");
      return this.result(message);
    }
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let buffer = "",
      event = [],
      bytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        bytes += value?.length || 0;
        if (bytes > this.maxBytes)
          throw new Error("MCP output budget exceeded; outcome unknown");
        buffer += decoder.decode(value, { stream: !done });
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, "");
          buffer = buffer.slice(index + 1);
          if (line.startsWith("data:")) event.push(line.slice(5).trimStart());
          else if (!line && event.length) {
            const message = json_message(event.join("\n"), this.maxBytes);
            event = [];
            if (message.method === "notifications/tools/list_changed")
              this.tools_revision++;
            if (message.id === payload.id && !message.method)
              return this.result(message);
            if (message.method && Object.hasOwn(message, "id")) {
              if (!this.options.onRequest) throw new Error("This MCP endpoint requires unsupported client callbacks; outcome unknown");
              let reply;
              try { reply = { result: await this.options.onRequest(message) }; }
              catch (error) { reply = { error: { code: error.code || -32603, message: error.message } }; }
              await this.send({ jsonrpc: "2.0", id: message.id, ...reply }, false);
            } else if (message.method) this.options.onNotification?.(message);
          }
        }
        if (done) break;
      }
      throw new Error("MCP stream ended before the response; outcome unknown");
    } finally {
      await reader.cancel().catch(() => {});
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
    });
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
    await this.close();
    this.protocol = RemoteMcp.MODERN_PROTOCOL;
    this.sequence = 0;
    try {
      const result = await this.request("server/discover");
      if (
        !Array.isArray(result.supportedVersions) ||
        !result.supportedVersions.includes(this.protocol)
      )
        throw new Error(
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
        throw new Error(
          "Invalid legacy MCP negotiated version: " + result.protocolVersion,
        );
      this.protocol = result.protocolVersion;
      await this.notify("notifications/initialized");
      this.initialization = result;
      return result;
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  async close() {
    const session = this.session;
    this.session = null;
    this.initialization = {};
    this.tool_headers.clear();
    if (!session) return;
    try {
      const response = await fetch(this.url, {
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
    } catch {}
  }
}
