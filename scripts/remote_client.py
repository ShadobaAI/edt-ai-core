"""Minimal streamable-HTTP MCP transport.

The external server owns the process; this client owns only its connection and
optional MCP session for one selected profile/instance. Initialise
once, reuse the negotiated id, and close it when the proxy is disconnected.
There are deliberately no automatic retries for tool calls because a transport
failure can leave a mutation outcome unknown.
"""
import json
import urllib.request
import urllib.error


class RemoteSessionExpired(RuntimeError):
    """The remote server no longer recognises this client's MCP session."""


class RemoteRpcError(RuntimeError):
    def __init__(self, error):
        self.code = error.get("code")
        super().__init__(f"MCP: {error}")


class RemoteMcp:
    def __init__(self, url, timeout=30):
        self.url = url
        self.timeout = timeout
        self.session = None
        self.protocol = "2024-11-05"
        self.sequence = 0
        self.tools_revision = 0
        self.initialization = {}

    def send(self, payload, expect_reply=True):
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream",
                   "MCP-Protocol-Version": self.protocol}
        if self.session:
            headers["Mcp-Session-Id"] = self.session
        request = urllib.request.Request(self.url, data=json.dumps(payload).encode(),
                                         headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
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
            if error.code in (400, 404) and self.session:
                raise RemoteSessionExpired(
                    f"MCP session expired ({error.code}); reconnect the selected project profile") from error
            raise RuntimeError(f"MCP HTTP {error.code}: {error.reason}") from error

    @staticmethod
    def result(message):
        if "error" in message:
            raise RemoteRpcError(message["error"])
        if "result" not in message:
            raise RuntimeError("Invalid MCP response")
        return message["result"]

    def request(self, method, params=None):
        self.sequence += 1
        return self.send({"jsonrpc": "2.0", "id": self.sequence, "method": method, "params": params or {}})

    def notify(self, method, params=None):
        """Forward a client notification without manufacturing a request id."""
        self.send({"jsonrpc": "2.0", "method": method, "params": params or {}}, expect_reply=False)

    def initialize(self):
        result = self.request("initialize", {"protocolVersion": self.protocol,
            "clientInfo": {"name": "1c-ai-core", "version": "0.1.1"}, "capabilities": {}})
        self.protocol = result.get("protocolVersion", self.protocol)
        self.send({"jsonrpc": "2.0", "method": "notifications/initialized"}, expect_reply=False)
        self.initialization = result
        return result

    def close(self):
        # The user owns the remote process, but this proxy owns its MCP session.
        # Explicit DELETE prevents stale sessions accumulating in EDT-MCP while
        # multiple project profiles are opened and closed in parallel.
        session, self.session = self.session, None
        self.initialization = {}
        if not session:
            return
        request = urllib.request.Request(self.url, headers={"Mcp-Session-Id": session}, method="DELETE")
        try:
            with urllib.request.urlopen(request, timeout=min(self.timeout, 5)):
                pass
        except (OSError, urllib.error.HTTPError):
            # Disconnect must never mask the result that caused the proxy to
            # close. The server can already be stopped or the session expired.
            pass

