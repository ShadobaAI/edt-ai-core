"""A modern probe cannot opt a session-owned relay into stateless semantics."""
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from common import ROOT
from mcp_client import McpClient


class ProtocolBoundary(unittest.TestCase):
    def test_modern_probe_falls_back_and_preserves_host_roots(self):
        from test_native_settings import ControlledRoots
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            selected = base / "project"
            selected.mkdir()
            env = {**os.environ, "EDT_AI_STATE_DIR": str(base / "state"),
                   "EDT_AI_SETTINGS": str(base / "state/settings.json"), "EDT_AI_PYTHON": sys.executable}
            for key in ("EDT_AI_PROJECT_ROOT", "EDT_AI_CONNECTIONS_FILE"):
                env.pop(key, None)
            with ControlledRoots(["node", str(ROOT / "mcp/settings.mjs")], ROOT, env) as client:
                client.supplied_roots = [selected]
                client.send({"id": "probe", "method": "server/discover", "params": {
                    "_meta": {"io.modelcontextprotocol/protocolVersion": "2026-07-28"}}})
                probe = client.messages.get(timeout=2)
                self.assertEqual(probe["error"]["code"], -32601)
                client.initialize()
                read = client.call("settings.read", {})["structuredContent"]
                self.assertEqual(Path(read["values"]["projectRoot"]), selected)
                self.assertTrue(read["projectSelection"]["locked"])

    def test_session_entrypoints_do_not_echo_an_unimplemented_protocol(self):
        with tempfile.TemporaryDirectory() as temporary:
            env = {**os.environ, "EDT_AI_STATE_DIR": temporary, "EDT_AI_SETTINGS": str(Path(temporary) / "settings.json")}
            commands = [["node", str(ROOT / "mcp/settings.mjs")], ["node", str(ROOT / "policy/read-only-mcp.mjs")],
                        [sys.executable, str(ROOT / "scripts/lazy_mcp.py"), "--component", "edt"]]
            for command in commands:
                with self.subTest(command=command), McpClient(command, ROOT, env) as client:
                    initialized = client.request("initialize", {"protocolVersion": "2026-07-28", "capabilities": {}})
                    self.assertNotEqual(initialized["protocolVersion"], "2026-07-28")
                    with self.assertRaises(RuntimeError):
                        client.request("tools/list", {"_meta": {"io.modelcontextprotocol/protocolVersion": "2026-07-28"}})


if __name__ == "__main__":
    unittest.main()
