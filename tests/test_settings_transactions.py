"""Import rollback and revision checks against concurrent or masked input changes."""
import contextlib
import copy
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from common import ROOT, ConfigError, dump, load, settings
from project_context import instance_file


class SettingsTransactions(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.state = self.root / "state"
        self.config_path = self.state / "settings.json"
        self.profile = load(ROOT / "profiles/generic-1c/profile.yaml")
        self.profile["repositories"] = [{"id": "product", "path": ".", "alias": "product"}]
        self.target = self.root / ".ai/project.yaml"
        dump(self.profile, self.target)
        self.config = settings()
        self.config["state_dir"] = str(self.state)
        dump(self.config, self.config_path)
        self.env = patch.dict(os.environ, {"EDT_AI_PROJECT_ROOT": str(self.root), "EDT_AI_STATE_DIR": str(self.state),
                         "EDT_AI_SETTINGS": str(self.config_path), "EDT_AI_INSTANCE": "transaction"})
        self.env.start()
        spec = importlib.util.spec_from_file_location("transaction_settings", ROOT / "scripts/settings_backend.py")
        self.backend = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.backend)
        self.override = instance_file(self.config, self.root)

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def request(self):
        changed = copy.deepcopy(self.profile)
        changed["project"]["purpose"] = "changed"
        bundle = {"format": "1c-ai-core-settings", "version": 1, "profile": changed,
                  "settings": {"mcp": {"required": {"edt": {"url": "http://127.0.0.1:19871/mcp"}}}}}
        request = {"text": json.dumps(bundle), "replace": True}
        preview = self.backend.main({**request, "action": "preview"})
        return {**request, "action": "apply", "revision": preview["revision"]}

    def test_failed_shared_settings_write_restores_profile_override_and_config(self):
        dump({"connections": {"edt": {"url": "http://127.0.0.1:19872/mcp"}}}, self.override)
        before = {path: path.read_bytes() for path in (self.target, self.override, self.config_path)}
        request = self.request()
        with patch.object(self.backend, "store_shared_settings", side_effect=OSError("simulated storage failure")):
            with self.assertRaisesRegex(OSError, "simulated"):
                self.backend.main(request)
        for path, contents in before.items():
            self.assertEqual(path.read_bytes(), contents)

    def test_apply_reloads_settings_after_acquiring_the_lock(self):
        request = self.request()
        before = self.target.read_bytes()
        @contextlib.contextmanager
        def concurrent_update(_state):
            changed = load(self.config_path)
            changed["mcp"]["managed"]["bsl-ls"]["version"] = "0.99.1"
            dump(changed, self.config_path)
            yield
        with patch.object(self.backend, "operation_lock", concurrent_update):
            with self.assertRaisesRegex(ConfigError, "после предпросмотра"):
                self.backend.main(request)
        self.assertEqual(self.target.read_bytes(), before)
        self.assertEqual(load(self.config_path)["mcp"]["managed"]["bsl-ls"]["version"], "0.99.1")
        self.assertFalse(self.override.exists())

    def test_masked_override_changes_still_invalidate_preview(self):
        dump({"connections": {"edt": {"url": "http://127.0.0.1:19873/mcp"}}}, self.override)
        with patch.dict(os.environ, {"EDT_AI_EDT_URL": "http://127.0.0.1:19874/mcp"}):
            request = self.request()
            dump({"connections": {"edt": {"url": "http://127.0.0.1:19875/mcp"}}}, self.override)
            with self.assertRaisesRegex(ConfigError, "после предпросмотра"):
                self.backend.main(request)
        self.assertEqual(load(self.target), self.profile)

    def test_optional_settings_cannot_hide_untyped_credentials(self):
        bundle = {"format": "1c-ai-core-settings", "version": 1,
                  "settings": {"mcp": {"optional": {"openviking": {"enabled": "false", "api_key": "fixture"}}}}}
        before = self.config_path.read_bytes()
        with self.assertRaises(ConfigError):
            self.backend.main({"action": "preview", "text": json.dumps(bundle)})
        self.assertEqual(self.config_path.read_bytes(), before)

    def test_saved_and_imported_optional_urls_use_the_same_validation(self):
        config = copy.deepcopy(self.config)
        config["mcp"]["optional"]["openviking"]["url"] = "http://fixture:secret@example.invalid/mcp"
        dump(config, self.config_path)
        with self.assertRaisesRegex(ConfigError, "credentials"):
            self.backend.main({"action": "read"})


if __name__ == "__main__":
    unittest.main()
