"""Configuration readiness and generated MCP bindings."""
import copy
import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from common import ROOT, ConfigError, dump, load, settings
from doctor import inspect, main as doctor_main

class Configuration(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.config = settings()
        self.data = load(ROOT / "profiles/generic-1c/profile.yaml")
        self.data["repositories"] = [{"id": "product", "path": ".", "alias": "product"}]
        dump(self.data, self.root / ".ai/project.yaml")
    def tearDown(self):
        self.tmp.cleanup()

    def test_missing_external_urls_are_not_ready(self):
        full = inspect(self.root, self.config, self.root / "state")
        self.assertEqual(full["status"], "error")
        managed = inspect(self.root, self.config, self.root / "state", managed_only=True)
        self.assertFalse(managed["errors"])
        self.assertEqual(managed["full_development_readiness"], "not_verified")
        self.assertFalse((self.root / "state").exists())  # static doctor is read-only

    def test_optional_openviking_is_not_a_gate(self):
        self.data["knowledge"]["provider"] = "openviking"
        dump(self.data, self.root / ".ai/project.yaml")
        result = inspect(self.root, self.config, self.root / "state", managed_only=True)
        self.assertFalse(result["errors"])
        self.assertTrue(any("OpenViking" in w for w in result["warnings"]))

    def test_live_doctor_exit_code_requires_confirmed_index_readiness(self):
        for probe in ({"index_ready": False}, {"index_ready": None}, {}, {"index_ready": True}):
            with self.subTest(probe=probe):
                def smoke_result(state, config, root, data, component):
                    return {"component": component, "status": "mcp_ready",
                            **(probe if component == "code-index" else {})}
                output = io.StringIO()
                with patch("doctor.smoke", side_effect=smoke_result), \
                     patch("policy_runtime.smoke", return_value={"live": "ready"}), \
                     patch.object(sys, "argv", ["doctor.py", str(self.root), "--live", "--managed-only"]), \
                     contextlib.redirect_stdout(output):
                    exit_code = doctor_main()
                report = json.loads(output.getvalue())
                ready = probe.get("index_ready") is True
                self.assertEqual(exit_code, 0 if ready else 1)
                self.assertEqual(report["status"], "managed_mcp_ready" if ready else "error")
                self.assertEqual(bool(report["errors"]), not ready)
                if not ready:
                    self.assertTrue(any("code-index" in error for error in report["errors"]))
                self.assertEqual(report["managed"][0], {"component": "code-index", "status": "mcp_ready", **probe})
                self.assertEqual(report["full_development_readiness"], "not_verified")

    def test_settings_overlay_and_generated_host_config(self):
        overlay = {"mcp": {"required": {"edt": {"url": "http://127.0.0.1:8765/mcp"},
                                       "v8std": {"url": "http://127.0.0.1:8000/mcp"}}}}
        path = self.root / "plugin-local.yaml"
        dump(overlay, path)
        self.assertEqual(settings(path)["mcp"]["managed"]["code-index"]["mode"], "auto")
        out = self.root / "mcp.json"
        result = subprocess.run([sys.executable, str(ROOT / "scripts/runtime.py"),
            "config", "--project-root", str(self.root), "--settings", str(path),
            "--state-dir", str(self.root / "state"), "--output", str(out)],
            capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        servers = json.loads(out.read_text())["mcpServers"]
        self.assertEqual(set(servers), {"edt", "v8std", "code-index", "bsl-ls", "policy"})
        self.assertEqual(servers["code-index"]["command"], sys.executable)
        self.assertIn(str(self.root.resolve()), servers["bsl-ls"]["args"])
        self.assertEqual(servers["policy"]["args"], [str(ROOT / "policy/read-only-mcp.mjs")])

    def test_invalid_url_or_managed_mode_is_rejected(self):
        for overlay in (
            {"mcp": {"required": {"edt": {"url": "http://user:password@localhost/mcp"}}}},
            {"mcp": {"required": {"edt": {"url": "http://localhost:bad/mcp"}}}},
            {"mcp": {"managed": {"bsl-ls": {"mode": "manual"}}}},
        ):
            path = self.root / "invalid.yaml"
            dump(overlay, path)
            with self.assertRaises(ConfigError):
                settings(path)

if __name__ == "__main__":
    unittest.main()

