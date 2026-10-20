"""Real stdio proxy and owned loopback endpoints; no 1C application is started."""
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from common import ROOT, dump, load
from mcp_client import McpClient
from project_paths import reconnect_file


class LazySurface(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        owner = self
        self.enabled, self.calls = {}, []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_POST(self):
                msg = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                owner.calls.append((self.path, msg))
                method, params = msg["method"], msg.get("params", {})
                def tool(name): return {"name": name, "inputSchema": {"type": "object", "properties": {}}}
                if method == "notifications/initialized":
                    self.send_response(202); self.end_headers(); return
                if method == "initialize": result = {"protocolVersion": "2024-11-05", "serverInfo": {"name": "fixture", "version": "1"}, "instructions": "Read corpus " + self.path, "capabilities": {"tools": {"listChanged": True}}}
                elif method == "tools/list":
                    names = [self.path[1:] + "_later"] if params.get("cursor") else ["enable", self.path[1:] + "_first"]
                    if owner.enabled.get(self.path) and not params.get("cursor"): names.append("activated")
                    result = {"tools": [tool(name) for name in names]}
                    if not params.get("cursor"): result["nextCursor"] = "second"
                elif method == "tools/call":
                    owner.enabled[self.path] = True
                    result = {"content": [{"type": "text", "text": self.path}],
                              "structuredContent": {"id": "same-standard", "body_truncated": True,
                                                    "context": params.get("arguments", {}).get("context")}}
                elif method == "resources/read": result = {"contents": [{"uri": params["uri"], "text": self.path}]}
                elif method == "resources/list": result = {"resources": [{"uri": "fixture://a", "name": "same"}, {"uri": "fixture://b", "name": "same"}]}
                elif method in ("prompts/list", "resources/templates/list"):
                    payload = json.dumps({"jsonrpc": "2.0", "id": msg["id"],
                                          "error": {"code": -32601, "message": "Method not found"}}).encode()
                    self.send_response(200); self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(payload))); self.end_headers()
                    self.wfile.write(payload); return
                else: raise ValueError(method)
                payload = json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": result}).encode()
                self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(payload))); self.end_headers(); self.wfile.write(payload)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.a, self.b = self.root / "adapter", self.root / "unit"
        for directory in (self.a, self.b): self.profile(directory, directory.name)
        self.config = self.root / "settings.json"
        self.config.write_text(json.dumps({"active_project": str(self.b), "mcp": {"required": {"edt": {"url": self.url("wrong")}}}}), encoding="utf-8")
        self.clients = []

    def url(self, route): return f"http://127.0.0.1:{self.server.server_port}/{route}"

    def profile(self, directory, route):
        data = load(ROOT / "profiles/generic-1c/profile.yaml")
        data["repositories"] = [{"id": "product", "path": ".", "alias": "product"}]
        data["connections"] = {"edt": {"url": self.url(route)}, "v8std": {"url": self.url(route)}}
        dump(data, directory / ".ai/project.yaml")

    def connect(self, root, extra=None, without_site=False, component="edt"):
        env = {**os.environ, "EDT_AI_SETTINGS": str(self.config), "EDT_AI_STATE_DIR": str(self.root / "state")}
        for key in ("EDT_AI_PROJECT_ROOT", "EDT_AI_EDT_URL", "EDT_AI_V8STD_URL", "EDT_AI_CONNECTIONS_FILE"): env.pop(key, None)
        env.update(extra or {})
        client = McpClient([sys.executable, *(["-S"] if without_site else []), str(ROOT / "scripts/lazy_mcp.py"), "--component", component], root, env, timeout=15)
        self.clients.append(client); client.initialize()
        return client

    def names(self, client):
        # The host first answers the proxy's roots/list request; it then binds.
        for _ in range(3):
            names = [tool["name"] for tool in client.request("tools/list")["tools"]]
            if names != ["core_runtime_status"]: return names
        self.fail("Proxy did not bind the selected project")

    def tearDown(self):
        for client in self.clients: client.close()
        self.server.shutdown(); self.server.server_close(); self.tmp.cleanup()

    def test_pages_dynamic_tools_and_resources(self):
        client = self.connect(self.a)
        self.assertIn("adapter_later", self.names(client))
        client.call("enable", {})
        self.assertIn("activated", self.names(client))
        self.assertEqual(client.request("resources/read", {"uri": "fixture://guide"})["contents"][0]["text"], "/adapter")
        self.assertEqual(len(client.request("resources/list")["resources"]), 2)
        self.assertEqual(len([m for _, m in self.calls if m["method"] == "tools/call"]), 1)

    def test_directory_change_and_parallel_clients_are_isolated(self):
        first, second = self.connect(self.a), self.connect(self.b)
        self.assertIn("adapter_first", self.names(first)); self.assertIn("unit_first", self.names(second))
        first.root = self.b
        first.send({"method": "notifications/roots/list_changed"})
        self.assertIn("unit_first", self.names(first))
        self.profile(self.b, "conversion")
        self.assertIn("conversion_first", self.names(second))
        self.assertIn("conversion_first", self.names(first))

    def test_same_directory_instances_use_their_own_environment(self):
        first = self.connect(self.a, {"EDT_AI_INSTANCE": "one", "EDT_AI_EDT_URL": self.url("crm1")})
        second = self.connect(self.a, {"EDT_AI_INSTANCE": "two", "EDT_AI_EDT_URL": self.url("crm2")})
        self.assertIn("crm1_first", self.names(first)); self.assertIn("crm2_first", self.names(second))

    def test_ordinary_calls_do_not_reload_the_catalogue(self):
        client = self.connect(self.a)
        self.names(client)
        before = len([m for _, m in self.calls if m["method"] == "tools/list"])
        for _ in range(3):
            client.call("adapter_first", {})
            client.request("resources/read", {"uri": "fixture://guide"})
        self.assertEqual(len([m for _, m in self.calls if m["method"] == "tools/list"]), before)

    def test_explicit_discovery_observes_external_catalogue_changes(self):
        client = self.connect(self.a)
        self.assertNotIn("activated", self.names(client))
        self.enabled["/adapter"] = True  # Another client changed the server.
        self.assertIn("activated", self.names(client))

    def test_disclosure_followed_by_discovery_fetches_each_page_once(self):
        client = self.connect(self.a)
        self.names(client)
        client.call("enable_toolset", {})
        before = len([m for _, m in self.calls if m["method"] == "tools/list"])
        self.assertIn("activated", self.names(client))
        self.assertEqual(len([m for _, m in self.calls if m["method"] == "tools/list"]) - before, 2)

    def test_optional_missing_catalogues_do_not_break_edt_discovery(self):
        client = self.connect(self.a)
        self.names(client)
        self.assertEqual(client.request("prompts/list"), {"prompts": []})
        self.assertEqual(client.request("resources/templates/list"), {"resourceTemplates": []})
        self.assertEqual(len(client.request("resources/list")["resources"]), 2)

    def test_reconnect_is_scoped_to_directory_and_instance(self):
        first = self.connect(self.a, {"EDT_AI_INSTANCE": "one", "EDT_AI_EDT_URL": self.url("crm1")})
        same_root = self.connect(self.a, {"EDT_AI_INSTANCE": "two", "EDT_AI_EDT_URL": self.url("crm2")})
        other_root = self.connect(self.b, {"EDT_AI_INSTANCE": "one"})
        for client in (first, same_root, other_root): self.names(client)
        with patch.dict(os.environ, {"EDT_AI_INSTANCE": "one"}):
            token = reconnect_file(self.root / "state", self.a)
        token.parent.mkdir(parents=True, exist_ok=True)
        token.write_text('{"id":"check-selected-instance"}', encoding="utf-8")
        for client in (first, same_root, other_root): self.names(client)
        initializations = [path for path, msg in self.calls if msg["method"] == "initialize"]
        self.assertEqual(initializations.count("/crm1"), 2)
        self.assertEqual(initializations.count("/crm2"), 1)
        self.assertEqual(initializations.count("/unit"), 1)

    def test_bad_profile_disconnects_and_restored_profile_rebinds(self):
        client = self.connect(self.a)
        self.assertIn("adapter_first", self.names(client))
        file = self.a / ".ai/project.yaml"; before = file.read_bytes()
        file.write_text("invalid: true", encoding="utf-8")
        self.assertEqual(client.request("tools/list")["tools"][0]["name"], "core_runtime_status")
        file.write_bytes(before)
        self.assertIn("adapter_first", self.names(client))

    def test_dependency_free_entrypoint_relays_through_prepared_python(self):
        client = self.connect(self.a, {"EDT_AI_PYTHON": sys.executable}, without_site=True)
        self.assertIn("adapter_later", self.names(client))
        self.assertEqual(client.request("resources/read", {"uri": "fixture://guide"})["contents"][0]["text"], "/adapter")
        self.assertFalse((self.root / "state").exists())

    def test_v8std_exposes_negotiated_contract_without_reloading_on_status(self):
        client = self.connect(self.a, component="v8std")
        self.assertIn("core_runtime_status", self.names(client))
        before = len([m for _, m in self.calls if m["method"] == "tools/list"])
        first = client.call("core_runtime_status", {})["structuredContent"]
        self.assertEqual(first["serverContract"]["instructions"], "Read corpus /adapter")
        self.assertNotIn("resources", first["serverContract"]["capabilities"])
        self.assertEqual(first["binding"]["projectRoot"], str(self.a))
        self.assertEqual(first["binding"]["endpoint"], self.url("adapter"))
        self.assertEqual(client.call("core_runtime_status", {})["structuredContent"], first)
        self.assertEqual(len([m for _, m in self.calls if m["method"] == "tools/list"]), before)
        self.assertFalse(any(m.get("params", {}).get("name") == "core_runtime_status" for _, m in self.calls))

    def test_v8std_parallel_projects_can_share_endpoint_without_sharing_results(self):
        self.profile(self.b, "adapter")
        first = self.connect(self.a, component="v8std")
        second = self.connect(self.b, component="v8std")
        for client in (first, second): self.names(client)
        a = first.call("core_runtime_status", {})["structuredContent"]["binding"]
        b = second.call("core_runtime_status", {})["structuredContent"]["binding"]
        self.assertNotEqual(a["connectionId"], b["connectionId"])
        self.assertNotEqual(a["projectRoot"], b["projectRoot"])
        self.assertEqual(a["endpoint"], b["endpoint"])
        before = len([m for _, m in self.calls if m["method"] == "tools/list"])
        for client, context in ((first, "project-one"), (second, "project-two")):
            result = client.call("adapter_first", {"context": context})["structuredContent"]
            self.assertEqual(result, {"id": "same-standard", "body_truncated": True, "context": context})
        first.close(); self.clients.remove(first)
        self.assertEqual(second.call("adapter_first", {"context": "still-two"})["structuredContent"]["context"], "still-two")
        self.assertEqual(len([m for _, m in self.calls if m["method"] == "tools/list"]), before)

    def test_v8std_rebind_replaces_contract_and_leaves_other_project_connected(self):
        first, second = self.connect(self.a, component="v8std"), self.connect(self.b, component="v8std")
        for client in (first, second): self.names(client)
        old = first.call("core_runtime_status", {})["structuredContent"]["binding"]
        unchanged = second.call("core_runtime_status", {})["structuredContent"]
        data = load(self.a / ".ai/project.yaml")
        data["connections"]["v8std"]["url"] = self.url("new-corpus")
        dump(data, self.a / ".ai/project.yaml")
        self.assertIn("new-corpus_first", self.names(first))
        status = first.call("core_runtime_status", {})["structuredContent"]
        self.assertNotEqual(status["binding"]["connectionId"], old["connectionId"])
        self.assertEqual(status["serverContract"]["instructions"], "Read corpus /new-corpus")
        self.assertEqual(second.call("core_runtime_status", {})["structuredContent"], unchanged)
        self.assertEqual([p for p, m in self.calls if m["method"] == "initialize"].count("/unit"), 1)
