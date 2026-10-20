"""Small newline-delimited MCP client for readiness and smoke checks."""
import json
from pathlib import Path
import queue
import subprocess
import threading
import time


class McpClient:
    def __init__(self, command, cwd, env=None, timeout=60):
        self.timeout = timeout
        self.root = Path(cwd).resolve()
        self.stderr = []
        self.next_id = 0
        self.tools_revision = 0
        self.messages = queue.Queue()
        self.process = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        threading.Thread(target=self._read, daemon=True).start()
        threading.Thread(target=self._errors, daemon=True).start()

    def _read(self):
        try:
            for line in self.process.stdout:
                try:
                    message = json.loads(line)
                    if message.get("method") == "notifications/tools/list_changed":
                        self.tools_revision += 1
                    self.messages.put(message)
                except (ValueError, UnicodeError):
                    pass
        finally:
            self.messages.put(None)

    def _errors(self):
        for line in self.process.stderr:
            self.stderr.append(line.decode("utf-8", errors="replace"))
            self.stderr[:] = self.stderr[-100:]

    def send(self, message):
        self.process.stdin.write((json.dumps({"jsonrpc": "2.0", **message}) + "\n").encode("utf-8"))
        self.process.stdin.flush()

    def request(self, method, params=None):
        self.next_id += 1
        target = self.next_id
        self.send({"id": target, "method": method, "params": params or {}})
        deadline = time.monotonic() + self.timeout
        while time.monotonic() < deadline:
            try:
                msg = self.messages.get(timeout=max(.01, deadline-time.monotonic()))
            except queue.Empty:
                break
            if msg is None:
                raise RuntimeError("MCP exited: " + "".join(self.stderr)[-4000:])
            if msg.get("method") == "roots/list" and "id" in msg:
                self.send({"id": msg["id"], "result": {"roots": [
                    {"uri": self.root.as_uri(), "name": self.root.name}]}})
            elif "method" in msg and "id" in msg:
                self.send({"id": msg["id"], "error": {"code": -32601, "message": "Not supported"}})
            elif msg.get("id") == target:
                if "error" in msg:
                    raise RuntimeError(f"MCP {method}: {msg['error']}")
                return msg["result"]
        raise RuntimeError(f"MCP {method} timed out: " + "".join(self.stderr)[-2000:])

    def initialize(self):
        result = self.request("initialize", {"protocolVersion": "2024-11-05",
            "capabilities": {"roots": {"listChanged": False}},
            "clientInfo": {"name": "1c-ai-core-doctor", "version": "0.1.0"}})
        self.send({"method": "notifications/initialized"})
        return result

    def call(self, name, arguments):
        result = self.request("tools/call", {"name": name, "arguments": arguments})
        if result.get("isError"):
            raise RuntimeError(f"{name}: {json.dumps(result, ensure_ascii=False)[:4000]}")
        return result

    def close(self):
        try:
            self.process.stdin.close()
            self.process.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            if self.process.poll() is None:
                # Kill only the process tree created by this client.
                if __import__("os").name == "nt":
                    subprocess.run(["taskkill", "/PID", str(self.process.pid), "/T", "/F"],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                else:
                    self.process.terminate()
                self.process.wait(timeout=10)
        for stream in (self.process.stdout, self.process.stderr):
            stream.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

