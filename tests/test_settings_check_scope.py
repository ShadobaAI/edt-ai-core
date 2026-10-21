"""The real settings backend only invalidates its selected profile/instance."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from common import ROOT, dump, load
from project_paths import reconnect_file


class SettingsCheckScope(unittest.TestCase):
    def test_check_writes_only_the_selected_reconnect_token(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            root, other, state = base / "selected", base / "other", base / "state"
            data = load(ROOT / "profiles/generic-1c/profile.yaml")
            data["repositories"] = [{"id": "product", "path": ".", "alias": "product"}]
            for directory in (root, other): dump(data, directory / ".ai/project.yaml")
            env = {"EDT_AI_PROJECT_ROOT": str(root), "EDT_AI_STATE_DIR": str(state),
                   "EDT_AI_SETTINGS": str(state / "settings.json"), "EDT_AI_INSTANCE": "selected"}
            with patch.dict(os.environ, env):
                spec = importlib.util.spec_from_file_location("check_backend", ROOT / "scripts/settings_backend.py")
                backend = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(backend)
                fixture = {"server": {"version": "fixture"}, "index_ready": True}
                with patch("runtime.smoke", return_value=fixture), patch("policy_runtime.smoke", return_value=fixture):
                    scope = backend.main({"action": "read"})["preparationScope"]
                    result = backend.main({"action": "check", "authorization": {
                        "scope": scope, "effects": ["launch"], "evidence": "explicit fixture launch request"}})
                token = reconnect_file(state, root)
                self.assertTrue(json.loads(token.read_text())["id"])
                self.assertEqual(result["fullReadiness"], "not_verified")
                self.assertFalse(reconnect_file(state, other).exists())
                with patch.dict(os.environ, {"EDT_AI_INSTANCE": "another"}):
                    self.assertFalse(reconnect_file(state, root).exists())
                self.assertFalse((state / "reconnect.json").exists())


if __name__ == "__main__":
    unittest.main()
