"""Real stdio relay: discovery reuse, notifications, complete schemas and results."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from common import ROOT, dump, load
from mcp_client import McpClient


class IndexSurface(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.fixture = self.root / "server.py"
        self.fixture.write_text('''import json, sys
discoveries, changed = 0, False
for line in sys.stdin:
    msg = json.loads(line)
    if "id" not in msg: continue
    method, params = msg.get("method"), msg.get("params", {})
    if method == "initialize":
        result = {"protocolVersion": "2024-11-05", "serverInfo": {"name": "fixture", "version": "fixture"}, "capabilities": {"tools": {"listChanged": True}}}
    elif method == "tools/list":
        discoveries += 1
        names = ["tail"] if params.get("cursor") else ["inspect", *( ["later"] if changed else [])]
        result = {"tools": [{"name": name, "description": "fixture", "inputSchema": {"type": "object", "properties": {"change": {"type": "boolean"}}}} for name in names]}
        if not params.get("cursor"): result["nextCursor"] = "tail"
    elif method == "tools/call":
        if params.get("arguments", {}).get("change"):
            changed = True
            print(json.dumps({"jsonrpc": "2.0", "method": "notifications/tools/list_changed"}), flush=True)
        result = {"structuredContent": {"discoveries": discoveries, "binding": __import__("os").getcwd(), "rows_elided_already_delivered": 3, "response_sections_omitted": True}, "content": [{"type": "text", "text": "result"}]}
    else: result = {}
    print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": result}), flush=True)
''', encoding="utf-8")
        self.runner = self.root / "proxy.py"
        self.runner.write_text('''import os, runpy, sys
sys.path.insert(0, os.environ["FIXTURE_SCRIPTS"])
import mcp_client
RealClient = mcp_client.McpClient
class FixtureClient(RealClient):
    def __init__(self, command, cwd, env=None, timeout=60):
        super().__init__([sys.executable, os.environ["FIXTURE_SERVER"]], cwd, env, timeout)
mcp_client.McpClient = FixtureClient
runpy.run_path(os.path.join(os.environ["FIXTURE_SCRIPTS"], "lazy_mcp.py"), run_name="__main__")
''', encoding="utf-8")
        self.clients = []

    def connect(self, name, component="code-index"):
        root = self.root / name; root.mkdir()
        data = load(ROOT / "profiles/generic-1c/profile.yaml")
        data["repositories"] = [{"id": "product", "alias": "product", "path": "."}]
        dump(data, root / ".ai/project.yaml")
        config = self.root / "settings.json"; config.write_text("{}", encoding="utf-8")
        env = {**os.environ, "EDT_AI_PROJECT_ROOT": str(root), "EDT_AI_STATE_DIR": str(self.root / "state"),
               "EDT_AI_SETTINGS": str(config), "FIXTURE_SERVER": str(self.fixture), "FIXTURE_SCRIPTS": str(ROOT / "scripts")}
        for key in ("EDT_AI_CONNECTIONS_FILE", "EDT_AI_EDT_URL", "EDT_AI_V8STD_URL"):
            env.pop(key, None)
        client = McpClient([sys.executable, str(self.runner), "--component", component], root, env, timeout=15)
        self.clients.append(client); client.initialize()
        tools = client.request("tools/list")["tools"]
        if component == "code-index":
            self.assertEqual({tool["name"] for tool in tools}, {"inspect", "tail"})
            self.assertIn("change", tools[0]["inputSchema"]["properties"])
        else:
            self.assertEqual([tool["name"] for tool in tools], ["core_runtime_status"])
        return client, root

    def tearDown(self):
        for client in self.clients: client.close()
        self.tmp.cleanup()

    def test_reuses_discovery_and_keeps_response_markers(self):
        client, _ = self.connect("first")
        first = client.call("inspect", {})["structuredContent"]
        for _ in range(3):
            self.assertEqual(client.call("inspect", {})["structuredContent"], first)
        self.assertEqual(first["rows_elided_already_delivered"], 3)
        self.assertTrue(first["response_sections_omitted"])
        client.request("tools/list")
        self.assertGreater(client.call("inspect", {})["structuredContent"]["discoveries"], first["discoveries"])

    def test_notification_refreshes_surface_and_other_profile_stays_independent(self):
        first, first_root = self.connect("first")
        second, second_root = self.connect("second")
        before = first.call("inspect", {})["structuredContent"]["discoveries"]
        first.call("inspect", {"change": True})
        refreshed = first.call("inspect", {})["structuredContent"]
        self.assertGreater(refreshed["discoveries"], before)
        self.assertEqual(Path(refreshed["binding"]), first_root)
        tools = first.request("tools/list")["tools"]
        self.assertIn("later", {tool["name"] for tool in tools})
        other = second.call("inspect", {})["structuredContent"]
        self.assertEqual(Path(other["binding"]), second_root)
        self.assertEqual(other["discoveries"], before)

    def test_bsl_binding_reports_missing_native_workspace_contract(self):
        client, _ = self.connect("incompatible-bsl", component="bsl-ls")
        status = client.call("core_runtime_status", {})["structuredContent"]
        self.assertFalse(status["ready"])
        self.assertIn("native multi-workspace API", status["detail"])
        with self.assertRaisesRegex(RuntimeError, "native multi-workspace API"):
            client.call("inspect", {})
