"""The core Vanessa entry rejects missing bindings/consent before any UI launch."""
import contextlib
import io
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import sys
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from common import ROOT, ConfigError, dump, load
from vanessa import main, runtime_profile


class VanessaBinding(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.data = load(ROOT / "profiles/generic-1c/profile.yaml")
        self.data["repositories"] = [{"id": "ui", "path": ".", "alias": "ui"}]
        self.data["testing"].update(vanessa=True, vanessa_config={"repository_id": "ui",
            "runtime_profile": ".ai/vanessa.local.json", "features": "features", "results": "results", "server_name": "vanessa"})
        self.file = self.root / ".ai/vanessa.local.json"
        self.raw = {"version": 1, "id": "fixture", "projectRoot": str(self.root),
            "platform": str(self.root / "never-start.exe"), "runtime": {"epf": str(self.root / "fixture.epf")},
            "manager": {"infobase": {"type": "file", "path": str(self.root / "manager")}},
            "client": {"name": "TestClient", "infobase": {"type": "file", "path": str(self.root / "client")}},
            "mcp": {"serverName": "vanessa", "url": "http://127.0.0.1:19876/mcp", "port": 19876},
            "features": str(self.root / "features"), "results": str(self.root / "results")}
        self.save()

    def save(self):
        dump(self.data, self.root / ".ai/project.yaml")
        self.file.write_text(json.dumps(self.raw), encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def invoke(self, command, *args):
        with patch.object(sys, "argv", ["vanessa.py", command, "--project-root", str(self.root), *args]):
            return main()

    def test_disabled_or_mismatched_profile_cannot_dispatch(self):
        self.data["testing"]["vanessa"] = False; self.save()
        with self.assertRaisesRegex(ConfigError, "disabled"):
            runtime_profile(self.root)
        self.data["testing"]["vanessa"] = True
        self.raw["features"] = str(self.root.parent / "outside"); self.save()
        with self.assertRaisesRegex(ConfigError, "differs"):
            runtime_profile(self.root)

    def test_describe_emits_utf8_even_with_a_legacy_windows_io_encoding(self):
        result = subprocess.run([sys.executable, str(ROOT / "scripts/vanessa.py"), "describe",
            "--project-root", str(self.root), "--feature", "features/测试.feature", "--scenario", "Проверка 🧪"],
            env={**os.environ, "PYTHONIOENCODING": "cp1251"}, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", errors="replace"))
        response = json.loads(result.stdout.decode("utf-8"))
        self.assertIn("Проверка 🧪", response["scope"])

    def test_start_requires_real_authorization_evidence_before_subprocess(self):
        with patch("vanessa.subprocess.run") as dispatch:
            with self.assertRaisesRegex(ConfigError, "agreement required"):
                self.invoke("start")
            dispatch.assert_not_called()

    def test_configured_and_temporary_features_use_the_same_authorized_run(self):
        for relative in ("features/smoke.feature", ".local/repair.feature"):
            feature = self.root / relative
            feature.parent.mkdir(parents=True, exist_ok=True)
            feature.write_text("Feature: Repair\nScenario: Exact scenario\n", encoding="utf-8")
        for selected in ("features/smoke.feature", ".local/repair.feature",
                         str(self.root / ".local/repair.feature")):
            with self.subTest(feature=selected):
                args = ("--feature", selected, "--scenario", "Exact scenario", "--editor-transition")
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    self.assertEqual(self.invoke("describe", *args), 0)
                request = json.loads(output.getvalue())
                request.pop("runtimeProfile")
                self.assertEqual(json.loads(request["scope"])["feature"], selected)
                with patch("vanessa.subprocess.run") as dispatch:
                    with self.assertRaisesRegex(ConfigError, "agreement required"):
                        self.invoke("run", *args)
                    dispatch.assert_not_called()
                request["authorizations"] = [{"effects": request["effects"], "scope": request["scope"],
                    "evidence": "Synthetic user instruction for this exact fixture scenario"}]
                approval = self.root / "run-approval.json"
                approval.write_text(json.dumps(request), encoding="utf-8")
                with patch("vanessa.subprocess.run") as dispatch:
                    dispatch.return_value.returncode = 0
                    self.assertEqual(self.invoke("run", *args, "--authorization-file", str(approval)), 0)
                    dispatch.assert_called_once()
                    command = dispatch.call_args.args[0]
                    self.assertEqual(command[command.index("--feature") + 1], selected)
                    self.assertIn("--editor-transition", command)
                    self.assertEqual(dispatch.call_args.kwargs["cwd"], self.root)

    def test_describe_and_run_reject_features_outside_the_project(self):
        with tempfile.TemporaryDirectory() as directory:
            outside = Path(directory).resolve() / "outside.feature"
            outside.write_text("Feature: Outside\nScenario: Exact scenario\n", encoding="utf-8")
            relative = os.path.relpath(outside, self.root)
            for command in ("describe", "run"):
                for selected in (str(outside), relative, ".local/repair.txt"):
                    with self.subTest(command=command, feature=selected), \
                         patch("vanessa.McpClient") as policy, patch("vanessa.subprocess.run") as dispatch:
                        with self.assertRaises(ConfigError):
                            self.invoke(command, "--feature", selected, "--scenario", "Exact scenario")
                        policy.assert_not_called()
                        dispatch.assert_not_called()

    def test_relative_arguments_are_bound_to_the_same_bytes_across_cwd_change(self):
        calls = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_POST(self):
                request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                if request["method"] == "notifications/initialized":
                    self.send_response(202); self.end_headers(); return
                if request["method"] == "initialize":
                    result = {"protocolVersion": "2025-03-26", "serverInfo": {"name": "own-loopback", "version": "1"}, "capabilities": {"tools": {}}}
                elif request["method"] == "tools/list":
                    result = {"tools": [{"name": "get_test_results", "inputSchema": {"type": "object", "properties": {"marker": {"type": "string"}}, "required": ["marker"], "additionalProperties": False}}]}
                elif request["method"] == "tools/call":
                    calls.append(request["params"])
                    result = {"content": [{"type": "text", "text": "synthetic read-only result"}]}
                else: result = {}
                payload = json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}).encode()
                self.send_response(200); self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload))); self.end_headers(); self.wfile.write(payload)
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            port = server.server_address[1]
            self.raw["mcp"].update(url=f"http://127.0.0.1:{port}/mcp", port=port); self.save()
            caller = self.root / "caller"; caller.mkdir()
            isolated = self.root / "isolated-temp"; isolated.mkdir()
            arguments = caller / "arguments.json"; arguments.write_text('{"marker":"authorized"}', encoding="utf-8")
            (self.root / "arguments.json").write_text('{"marker":"different-project-file"}', encoding="utf-8")
            env = {**os.environ, "TEMP": str(isolated), "TMP": str(isolated),
                   "EDT_AI_SETTINGS": str(self.root / "settings.json"), "EDT_AI_STATE_DIR": str(self.root / "state")}
            command = [sys.executable, str(ROOT / "scripts/vanessa.py")]
            args = ["--project-root", str(self.root), "--tool", "get_test_results", "--arguments-file", "arguments.json"]
            described = subprocess.run([*command, "describe", "--for-action", "call", *args],
                cwd=caller, env=env, capture_output=True, encoding="utf-8", timeout=20)
            self.assertEqual(described.returncode, 0, described.stdout + described.stderr)
            request = json.loads(described.stdout); request.pop("runtimeProfile"); request["authorizations"] = []
            self.assertEqual(json.loads(request["scope"])["argumentsHash"], hashlib.sha256(arguments.read_bytes()).hexdigest())
            approval = self.root / "read-only-authorization.json"; approval.write_text(json.dumps(request), encoding="utf-8")
            called = subprocess.run([*command, "call", *args, "--authorization-file", str(approval)],
                cwd=caller, env=env, capture_output=True, encoding="utf-8", timeout=20)
            self.assertEqual(called.returncode, 0, called.stdout + called.stderr)
            self.assertEqual(calls, [{"name": "get_test_results", "arguments": {"marker": "authorized"}}])
        finally:
            server.shutdown(); server.server_close()

    def test_describe_and_exact_scope_authorization_roundtrip(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.invoke("describe", "--for-action", "start")
        request = json.loads(output.getvalue())
        self.assertEqual(request["effects"], ["launch"])
        request.pop("runtimeProfile")
        request["authorizations"] = [{"effects": ["launch"], "scope": request["scope"],
                                       "evidence": "synthetic user instruction for this fixture target"}]
        approval = self.root / "approval.json"; approval.write_text(json.dumps(request), encoding="utf-8")
        with patch("vanessa.subprocess.run") as dispatch:
            dispatch.return_value.returncode = 0
            self.assertEqual(self.invoke("start", "--authorization-file", str(approval)), 0)
            self.assertIn("start", dispatch.call_args.args[0])
            self.assertIn("--expected-profile-sha256", dispatch.call_args.args[0])
            self.assertNotIn("shell", dispatch.call_args.kwargs)
        self.raw["client"]["infobase"]["path"] = str(self.root / "other-client"); self.save()
        with patch("vanessa.subprocess.run") as dispatch:
            with self.assertRaisesRegex(ConfigError, "scope/effects differ"):
                self.invoke("start", "--authorization-file", str(approval))
            dispatch.assert_not_called()

    def test_identical_relative_profiles_in_two_clones_cannot_share_authorization(self):
        self.raw.update(projectRoot="..", platform="../never-start.exe", features="../features", results="../results")
        self.raw["runtime"] = {"epf": "../fixture.epf"}
        self.raw["manager"]["infobase"]["path"] = "../manager"
        self.raw["client"]["infobase"]["path"] = "../client"
        self.save()
        output = io.StringIO()
        with contextlib.redirect_stdout(output): self.invoke("describe", "--for-action", "start")
        request = json.loads(output.getvalue()); request.pop("runtimeProfile")
        request["authorizations"] = [{"scope": request["scope"], "effects": request["effects"], "evidence": "Only the first synthetic clone is authorized"}]
        approval = self.root / "approval.json"; approval.write_text(json.dumps(request), encoding="utf-8")
        with tempfile.TemporaryDirectory() as other:
            clone = Path(other).resolve()
            dump(self.data, clone / ".ai/project.yaml")
            (clone / ".ai/vanessa.local.json").write_bytes(self.file.read_bytes())
            with patch("vanessa.subprocess.run") as dispatch, patch.object(sys, "argv", ["vanessa.py", "start", "--project-root", str(clone), "--authorization-file", str(approval)]):
                with self.assertRaisesRegex(ConfigError, "scope/effects differ"): main()
                dispatch.assert_not_called()


if __name__ == "__main__":
    unittest.main()
