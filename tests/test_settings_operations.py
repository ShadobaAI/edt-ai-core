"""Real stdio operation lifecycle, with an owned delayed backend and no downloads."""
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from common import ROOT
from mcp_client import McpClient


class SettingsOperations(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name).resolve()
        plugin = self.base / "plugin"
        (plugin / "mcp").mkdir(parents=True)
        (plugin / "scripts").mkdir()
        for relative in ("mcp/settings.mjs", "mcp/settings-operations.mjs", "scripts/bootstrap.py"):
            shutil.copy2(ROOT / relative, plugin / relative)
        (plugin / "scripts/settings_backend.py").write_text(
            'import json, os, sys, time\nfrom pathlib import Path\n'
            'request=json.load(sys.stdin)\n'
            'time.sleep(.4)\n'
            'state=Path(os.environ["EDT_AI_STATE_DIR"])\n'
            'with (state/"calls").open("a") as stream: stream.write(request["action"]+"\\n")\n'
            'if request.get("set",{}).get("edtUrl")=="unknown": os._exit(3)\n'
            'if request.get("set",{}).get("edtUrl")=="malformed": print(json.dumps({"ok":True,"result":None})); sys.exit(0)\n'
            'print(json.dumps({"ok":True,"result":{"managed":[],"values":{"projectRoot":os.environ["EDT_AI_PROJECT_ROOT"]}}}))\n',
            encoding="utf-8")
        # The old 240-second kill is accelerated to expose that regression quickly.
        preload = self.base / "deadline.mjs"
        preload.write_text('const original=globalThis.setTimeout; globalThis.setTimeout=(fn,ms,...args)=>original(fn,ms===240000?50:ms,...args);', encoding="utf-8")
        self.state = self.base / "state"
        self.env = {**os.environ, "EDT_AI_STATE_DIR": str(self.state),
                    "EDT_AI_SETTINGS": str(self.state / "settings.json"),
                    "EDT_AI_PROJECT_ROOT": str(self.base), "EDT_AI_PYTHON": sys.executable}
        self.command = ["node", "--import", preload.as_uri(), str(plugin / "mcp/settings.mjs")]
        self.plugin = plugin
        self.client = McpClient(self.command, plugin, self.env, timeout=5)
        self.client.initialize()

    def tearDown(self):
        self.client.close()
        self.tmp.cleanup()

    def call(self, name, **args):
        if name == "settings.run_check" and not args:
            args = {"authorization": {
                "scope": f"{self.base}#default", "effects": ["launch"],
                "evidence": "fixture user authorization",
            }}
        return self.client.call(name, args)["structuredContent"]

    def wait_operation(self, operation_id):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            status = self.call("settings.operation", operationId=operation_id)
            if status["status"] != "running":
                return status
            time.sleep(.02)
        self.fail("Operation did not finish")

    def test_preparation_is_one_tracked_operation_and_polling_does_not_retry(self):
        operation = self.call("settings.run_check")
        self.assertEqual(operation["status"], "running")
        self.assertEqual(operation["projectRoot"], str(self.base))
        with self.assertRaisesRegex(RuntimeError, "ещё выполняется"):
            self.call("settings.run_check")
        with self.assertRaisesRegex(RuntimeError, "ещё выполняется"):
            self.call("settings.update", set={"edtUrl": "http://127.0.0.1:19851/mcp"})
        completed = self.wait_operation(operation["id"])
        self.assertEqual(completed["status"], "completed")
        self.assertEqual(completed["result"]["managed"], [])
        self.assertEqual((self.state / "calls").read_text().splitlines(), ["check"])
        again = self.call("settings.operation", operationId=operation["id"])
        self.assertEqual(again, completed)

    def test_preparation_rejects_missing_or_empty_authorization_before_the_backend(self):
        for args in ({}, {"authorization": {"scope": str(self.base), "effects": [], "evidence": " "}}):
            with self.subTest(args=args), self.assertRaises(RuntimeError):
                self.client.call("settings.run_check", args)
        self.assertFalse((self.state / "calls").exists())

    def test_update_waits_for_actual_completion_and_never_kills_the_supervisor(self):
        result = self.call("settings.update", set={"edtUrl": "http://127.0.0.1:19852/mcp"})
        self.assertEqual(result["values"]["projectRoot"], str(self.base))
        self.assertEqual(self.call("settings.operation")["status"], "completed")
        self.assertEqual((self.state / "calls").read_text().splitlines(), ["update"])

    def test_abnormal_exit_has_an_unknown_outcome_instead_of_a_retry_instruction(self):
        with self.assertRaisesRegex(RuntimeError, "Исход операции неизвестен"):
            self.call("settings.update", set={"edtUrl": "unknown"})
        self.assertEqual(self.call("settings.operation")["status"], "outcome_unknown")
        self.assertEqual((self.state / "calls").read_text().splitlines(), ["update"])

    def test_malformed_messages_do_not_crash_the_settings_server(self):
        self.client.process.stdin.write(b'null\n{broken\n[]\n')
        self.client.process.stdin.flush()
        self.assertEqual(self.client.request("ping"), {})
        self.assertEqual(self.call("settings.operation")["status"], "idle")

    def test_malformed_backend_result_does_not_leave_a_running_operation(self):
        with self.assertRaisesRegex(RuntimeError, "некорректный ответ"):
            self.call("settings.update", set={"edtUrl": "malformed"})
        self.assertEqual(self.call("settings.operation")["status"], "outcome_unknown")

    def test_client_request_id_cannot_be_mistaken_for_the_server_roots_response(self):
        env = dict(self.env); env.pop("EDT_AI_PROJECT_ROOT")
        with McpClient(self.command, self.plugin, env, timeout=5) as client:
            client.initialize()
            roots_request = client.messages.get(timeout=2)
            self.assertEqual(roots_request["method"], "roots/list")
            client.send({"id": roots_request["id"], "method": "ping"})
            answer = client.messages.get(timeout=2)
            self.assertEqual(answer.get("result"), {})
            self.assertEqual(answer["id"], roots_request["id"])
            client.send({"id": roots_request["id"], "result": {"roots": []}})
            self.assertEqual(client.request("ping"), {})


if __name__ == "__main__":
    unittest.main()
