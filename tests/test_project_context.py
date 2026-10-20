"""Repository discovery, instance overrides and URL isolation."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from common import ROOT, ConfigError, dump, load, settings, state_path
from project_context import locate_project, effective_settings, instance_file, select_root


class ProjectContext(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.state = self.root / "state"
        self.env = patch.dict(os.environ, {"EDT_AI_STATE_DIR": str(self.state), "EDT_AI_INSTANCE": "first"})
        self.env.start()
        for name in ("EDT_AI_EDT_URL", "EDT_AI_V8STD_URL", "EDT_AI_CONNECTIONS_FILE"):
            os.environ.pop(name, None)
        self.config = settings()
        self.data = load(ROOT / "profiles/generic-1c/profile.yaml")
        self.data["repositories"] = [{"id": "product", "path": ".", "alias": "product"}]
        self.data["connections"] = {"edt": {"url": "http://127.0.0.1:1111/mcp"}}
        dump(self.data, self.root / ".ai/project.yaml")

    def tearDown(self):
        self.env.stop(); self.tmp.cleanup()

    def url(self):
        return effective_settings(self.config, self.root, self.data)["mcp"]["required"]["edt"]["url"]

    def test_nearest_profile_and_repository_boundary(self):
        nested = self.root / "docs/nested"; nested.mkdir(parents=True)
        self.assertEqual(locate_project(nested), self.root)
        (nested / ".git").mkdir()
        with self.assertRaisesRegex(ConfigError, "No .ai/project.yaml"):
            locate_project(nested)
        dump(self.data, nested / ".ai/project.yaml")
        self.assertEqual(locate_project(nested), nested)

    def test_precedence_and_no_implicit_writes(self):
        before = (self.root / ".ai/project.yaml").read_bytes()
        self.assertEqual(self.url(), "http://127.0.0.1:1111/mcp")
        self.assertFalse(self.state.exists())
        dump({"connections": {"edt": {"url": "http://127.0.0.1:2222/mcp"}}}, self.root / ".ai/project.local.yaml")
        self.assertEqual(self.url(), "http://127.0.0.1:2222/mcp")
        dump({"connections": {"edt": {"url": "http://127.0.0.1:3333/mcp"}}}, self.root / ".ai/instances/first.local.yaml")
        self.assertEqual(self.url(), "http://127.0.0.1:3333/mcp")
        dump({"connections": {"edt": {"url": "http://127.0.0.1:4444/mcp"}}}, instance_file(self.config, self.root))
        self.assertEqual(self.url(), "http://127.0.0.1:4444/mcp")
        external = self.root / "variables.yaml"
        dump({"connections": {"edt": {"url": "http://127.0.0.1:5555/mcp"}}}, external)
        os.environ["EDT_AI_CONNECTIONS_FILE"] = str(external)
        self.assertEqual(self.url(), "http://127.0.0.1:5555/mcp")
        os.environ["EDT_AI_EDT_URL"] = "http://127.0.0.1:6666/mcp"
        self.assertEqual(self.url(), "http://127.0.0.1:6666/mcp")
        self.assertEqual((self.root / ".ai/project.yaml").read_bytes(), before)

    def test_instance_and_clone_keys_are_distinct(self):
        first = instance_file(self.config, self.root)
        os.environ["EDT_AI_INSTANCE"] = "second"
        second = instance_file(self.config, self.root)
        self.assertNotEqual(first, second)
        self.assertNotEqual(second, instance_file(self.config, self.root / "another-clone"))

    def test_legacy_edt_url_does_not_cross_project_bindings(self):
        other = self.root / "other"; other.mkdir()
        dump(self.data, other / ".ai/project.yaml")
        self.config["active_project"] = str(other)
        self.config["mcp"]["required"]["edt"]["url"] = "http://127.0.0.1:9992/mcp"
        data = {**self.data, "connections": {}}
        self.assertEqual(effective_settings(self.config, self.root, data)["mcp"]["required"]["edt"]["url"], "")
        self.assertEqual(self.url(), "http://127.0.0.1:1111/mcp")
        self.config["active_project"] = str(self.root / "removed-project")
        self.assertEqual(self.url(), "http://127.0.0.1:1111/mcp")
        self.assertEqual(effective_settings(self.config, self.root, data)["mcp"]["required"]["edt"]["url"], "")

    def test_removed_repository_selection_is_rejected_in_overrides(self):
        dump({"selected_repository": "product"}, instance_file(self.config, self.root))
        with self.assertRaises(ConfigError):
            effective_settings(self.config, self.root, self.data)

    def test_explicit_runtime_state_and_environment_choose_the_matching_instance_file(self):
        alternate = self.root / "alternate-state"
        self.assertEqual(state_path(self.config), self.state)
        self.assertEqual(state_path(self.config, alternate), alternate)
        dump({"connections": {"edt": {"url": "http://127.0.0.1:9991/mcp"}}},
             instance_file(self.config, self.root, state=alternate))
        self.assertEqual(effective_settings(self.config, self.root, self.data, state=alternate)["mcp"]["required"]["edt"]["url"],
                         "http://127.0.0.1:9991/mcp")
        self.assertEqual(self.url(), "http://127.0.0.1:1111/mcp")

    def test_invalid_override_cannot_change_policy_or_inject_credentials(self):
        dump({"connections": {}, "policy": {"allow_shell_source_read": True}}, self.root / ".ai/project.local.yaml")
        with self.assertRaises(ConfigError): self.url()
        dump({"connections": {"edt": {"url": "http://user:secret@localhost/mcp"}}}, self.root / ".ai/project.local.yaml")
        with self.assertRaises(ConfigError): self.url()

    def test_explicit_missing_override_does_not_fall_back_to_another_endpoint(self):
        os.environ["EDT_AI_CONNECTIONS_FILE"] = str(self.root / "missing.yaml")
        with self.assertRaisesRegex(ConfigError, "EDT_AI_CONNECTIONS_FILE"):
            self.url()

    def test_custom_environment_and_ambiguous_roots(self):
        self.data["connections"]["edt"]["url_env"] = "FIXTURE_EDT_URL"
        with patch.dict(os.environ, {"FIXTURE_EDT_URL": "http://127.0.0.1:7777/mcp"}):
            self.assertEqual(self.url(), "http://127.0.0.1:7777/mcp")
        with self.assertRaises(ConfigError):
            select_root([{"uri": (self.root / "a").as_uri()}, {"uri": (self.root / "b").as_uri()}], self.root)

    def test_cli_configures_only_the_requested_instance(self):
        before = (self.root / ".ai/project.yaml").read_bytes()
        command = [sys.executable, str(ROOT / "scripts/profile.py"), "configure-instance", str(self.root),
                   "--instance", "second", "--edt-url", "http://127.0.0.1:8888/mcp"]
        result = subprocess.run(command, capture_output=True, encoding="utf-8")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        applied = json.loads(result.stdout)
        self.assertEqual(applied["instance"], "second")
        self.assertEqual(applied["profile"]["connections"]["edt"]["url"], "http://127.0.0.1:8888/mcp")
        self.assertTrue(Path(applied["instanceFile"]).is_file())
        self.assertEqual(self.url(), "http://127.0.0.1:1111/mcp")
        self.assertEqual((self.root / ".ai/project.yaml").read_bytes(), before)

    def test_cli_import_export_use_the_nearest_profile_and_guard_its_target(self):
        sub = self.root / "docs"; sub.mkdir()
        script = str(ROOT / "scripts/profile.py")
        exported = self.root / "exported.yaml"
        result = subprocess.run([sys.executable, script, "export", str(sub), "--output", str(exported)], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(load(exported), self.data)
        incoming = load(exported); incoming["project"]["purpose"] = "subdirectory import"
        dump(incoming, exported)
        result = subprocess.run([sys.executable, script, "import", str(sub), "--input", str(exported), "--replace"], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        target = self.root / ".ai/project.yaml"
        self.assertEqual(load(target), incoming)
        self.assertFalse((sub / ".ai").exists())
        before = target.read_bytes()
        result = subprocess.run([sys.executable, script, "export", str(sub), "--output", str(target), "--replace"], capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(target.read_bytes(), before)
