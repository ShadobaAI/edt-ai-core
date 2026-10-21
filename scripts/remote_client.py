"""Minimal streamable-HTTP MCP transport.

The external server owns the process; this client owns only its connection and
optional MCP session for one selected profile/instance. Initialise
once, reuse the negotiated id, and close it when the proxy is disconnected.
There are deliberately no automatic retries for tool calls because a transport
failure can leave a mutation outcome unknown.
"""
import base64
import json
import re
import urllib.request
import urllib.error


class RemoteSessionExpired(RuntimeError):
    """The remote server no longer recognises this client's MCP session."""


class RemoteRpcError(RuntimeError):
    def __init__(self, error):
        self.error = error
        self.code = error.get("code")
        super().__init__(f"MCP: {error}")


class RemoteHttpError(RemoteRpcError):
    def __init__(self, status, reason, rpc_error=None):
        self.status, self.rpc_error = status, rpc_error
        self.error = rpc_error or {}
        self.code = self.error.get("code")
        RuntimeError.__init__(self, f"MCP HTTP {status}: {reason}" + (f"; {rpc_error}" if rpc_error else ""))


def header_value(value):
    text = str(value).lower() if isinstance(value, bool) else str(value)
    if (text != text.strip() or any(ord(char) < 32 or ord(char) > 126 for char in text)
            or (text.startswith("=?base64?") and text.endswith("?="))):
        return "=?base64?" + base64.b64encode(text.encode("utf-8")).decode("ascii") + "?="
    return text


def tool_header_fields(schema):
    """Validate live x-mcp-header annotations, without interpreting JSON Schema."""
    fields, names = [], set()

    def walk(node, path=None):
        if isinstance(node, list):
            for item in node:
                walk(item)
        elif isinstance(node, dict):
            if "x-mcp-header" in node:
                name, kind = node["x-mcp-header"], node.get("type")
                if (not path or not isinstance(name, str)
                        or not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", name)
                        or name.casefold() in names or kind not in ("string", "integer", "boolean")):
                    raise ValueError("Invalid x-mcp-header annotation")
                names.add(name.casefold())
                fields.append((path, name, kind))
            for key, child in node.items():
                if key == "properties" and path is not None and isinstance(child, dict):
                    for name, prop in child.items():
                        walk(prop, (*path, name))
                elif key not in ("const", "enum", "default", "examples"):
                    walk(child)
    walk(schema, ())
    return fields


class RemoteMcp:
    MODERN_PROTOCOL = "2026-07-28"
    LEGACY_PROTOCOLS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")

    def __init__(self, url, timeout=30):
        self.url = url
        self.timeout = timeout
        self.session = None
        self.protocol = "2024-11-05"
        self.sequence = 0
        self.tools_revision = 0
        self.initialization = {}
        self.tool_headers = {}

    def send(self, payload, expect_reply=True):
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream",
                   "MCP-Protocol-Version": self.protocol}
        wire_payload = payload
        if self.protocol == self.MODERN_PROTOCOL:
            params = dict(payload.get("params") or {})
            meta = dict(params.get("_meta") or {})
            # This HTTP client is the peer of the remote server. Do not forward
            # a host's protocol version, identity or unsupported capabilities.
            meta.update({"io.modelcontextprotocol/protocolVersion": self.MODERN_PROTOCOL,
                         "io.modelcontextprotocol/clientInfo": {"name": "1c-ai-core", "version": "0.2.1"},
                         "io.modelcontextprotocol/clientCapabilities": {}})
            params["_meta"] = meta
            wire_payload = {**payload, "params": params}
            headers["Mcp-Method"] = payload.get("method", "")
            method = payload.get("method")
            if method in ("tools/call", "resources/read", "prompts/get"):
                name = params.get("uri" if method == "resources/read" else "name")
                if isinstance(name, str) and name:
                    headers["Mcp-Name"] = header_value(name)
            if method == "tools/call":
                for path, name, kind in self.tool_headers.get(params.get("name"), []):
                    value = params.get("arguments", {})
                    for key in path:
                        value = value.get(key) if isinstance(value, dict) else None
                    if value is None:
                        continue
                    expected = {"string": str, "integer": int, "boolean": bool}[kind]
                    if type(value) is not expected or (kind == "integer" and abs(value) > 2**53-1):
                        raise ValueError("Invalid HTTP-mirrored tool parameter: " + ".".join(path))
                    headers["Mcp-Param-" + name] = header_value(value)
        if self.session and self.protocol != self.MODERN_PROTOCOL:
            headers["Mcp-Session-Id"] = self.session
        request = urllib.request.Request(self.url, data=json.dumps(wire_payload).encode(),
                                         headers=headers, method="POST")
        if payload.get("method") == "initialize":
            # Legacy initialization negotiates the version in its body. The
            # HTTP version header applies only to subsequent requests.
            request.remove_header("Mcp-protocol-version")
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                if self.protocol != self.MODERN_PROTOCOL:
                    self.session = response.headers.get("Mcp-Session-Id") or self.session
                if not expect_reply:
                    return {}
                if response.status in (202, 204):
                    raise RuntimeError("MCP request received no result; outcome unknown")
                if "text/event-stream" not in response.headers.get("Content-Type", ""):
                    message = json.load(response)
                    if message.get("id") != payload["id"]:
                        raise RuntimeError("MCP response ID mismatch; outcome unknown")
                    return self.result(message)
                event = []
                for raw in response:
                    line = raw.decode("utf-8").rstrip("\r\n")
                    if line.startswith("data:"):
                        event.append(line[5:].lstrip())
                    elif not line and event:
                        message = json.loads("\n".join(event))
                        event = []
                        if message.get("method") == "notifications/tools/list_changed":
                            self.tools_revision += 1
                        if message.get("id") == payload["id"] and "method" not in message:
                            return self.result(message)
                        if "method" in message and "id" in message:
                            raise RuntimeError("This MCP endpoint requires unsupported client callbacks; outcome unknown")
                raise RuntimeError("MCP stream ended before the response; outcome unknown")
        except urllib.error.HTTPError as error:
            # EDT-MCP uses 404 for an expired/terminated MCP session.  Let the
            # proxy discard the binding, but never retry the original request.
            # A stateful Streamable HTTP server uses 404 for an unknown or
            # expired session.  HTTP 400 is also used for ordinary malformed
            # requests, so it must remain an actionable server error rather
            # than silently discarding a healthy binding.
            try:
                body = json.load(error)
                rpc_error = body.get("error") if isinstance(body, dict) else None
                if not isinstance(rpc_error, dict):
                    rpc_error = None
            except (ValueError, OSError):
                rpc_error = None
            finally:
                error.close()
            if error.code == 404 and self.session and (rpc_error or {}).get("code") != -32601:
                raise RemoteSessionExpired(
                    f"MCP session expired ({error.code}); reconnect the selected project profile") from error
            raise RemoteHttpError(error.code, error.reason, rpc_error) from error

    @staticmethod
    def result(message):
        if "error" in message:
            raise RemoteRpcError(message["error"])
        if "result" not in message:
            raise RuntimeError("Invalid MCP response")
        result = message["result"]
        if not isinstance(result, dict):
            raise RuntimeError("Invalid MCP result")
        if result.get("resultType", "complete") != "complete":
            raise RuntimeError("Unsupported MCP result type; operation is not confirmed complete: "
                               + str(result.get("resultType")))
        return result

    def request(self, method, params=None):
        self.sequence += 1
        result = self.send({"jsonrpc": "2.0", "id": self.sequence, "method": method, "params": params or {}})
        if self.protocol == self.MODERN_PROTOCOL and method == "tools/list" and isinstance(result.get("tools"), list):
            if not (params or {}).get("cursor"):
                self.tool_headers.clear()
            visible = []
            for tool in result["tools"]:
                try:
                    fields = tool_header_fields(tool.get("inputSchema", {}))
                except ValueError as error:
                    __import__("sys").stderr.write(f"Excluded MCP tool {tool.get('name')}: {error}\n")
                    continue
                self.tool_headers[tool["name"]] = fields
                visible.append(tool)
            result = {**result, "tools": visible}
        return result

    def notify(self, method, params=None):
        """Forward a client notification without manufacturing a request id."""
        self.send({"jsonrpc": "2.0", "method": method, "params": params or {}}, expect_reply=False)

    def initialize(self):
        self.close()
        self.tool_headers.clear()
        self.protocol = self.MODERN_PROTOCOL
        self.session = None
        self.sequence = 0
        try:
            result = self.request("server/discover")
            supported = result.get("supportedVersions") if isinstance(result, dict) else None
            if not isinstance(supported, list) or self.MODERN_PROTOCOL not in supported:
                raise RuntimeError("server/discover did not advertise the modern MCP protocol")
            # Modern MCP is stateless. Ignore a legacy session header if a
            # transitional gateway happens to emit one for discovery.
            self.session = None
            self.initialization = result
            return result
        except RemoteRpcError as error:
            rpc_error = error.error
            if rpc_error and rpc_error.get("code") in (-32020, -32021, -32022):
                # A recognized modern error is not evidence of a legacy peer.
                raise
            if isinstance(error, RemoteHttpError) and error.status not in (400, 404, 405):
                raise
            if not isinstance(error, RemoteHttpError) and error.code != -32601:
                raise

        self.protocol = self.LEGACY_PROTOCOLS[0]
        self.session = None
        self.sequence = 0
        try:
            result = self.request("initialize", {"protocolVersion": self.protocol,
                "clientInfo": {"name": "1c-ai-core", "version": "0.2.1"}, "capabilities": {}})
            negotiated = result.get("protocolVersion")
            if negotiated not in self.LEGACY_PROTOCOLS:
                raise RuntimeError("Invalid legacy MCP negotiated version: " + str(negotiated))
            self.protocol = negotiated
            self.send({"jsonrpc": "2.0", "method": "notifications/initialized"}, expect_reply=False)
            self.initialization = result
            return result
        except Exception:
            self.close()
            raise

    def close(self):
        # The user owns the remote process, but this proxy owns its MCP session.
        # Explicit DELETE prevents stale sessions accumulating in EDT-MCP while
        # multiple project profiles are opened and closed in parallel.
        session, self.session = self.session, None
        self.initialization = {}
        self.tool_headers.clear()
        if not session:
            return
        request = urllib.request.Request(self.url, headers={
            "Mcp-Session-Id": session,
            "MCP-Protocol-Version": self.protocol,
        }, method="DELETE")
        try:
            with urllib.request.urlopen(request, timeout=min(self.timeout, 5)):
                pass
        except (OSError, urllib.error.HTTPError):
            # Disconnect must never mask the result that caused the proxy to
            # close. The server can already be stopped or the session expired.
            pass

