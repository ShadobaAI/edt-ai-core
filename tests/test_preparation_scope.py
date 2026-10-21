"""Preparation authority and target share the real backend's path resolver."""
from contextlib import ExitStack
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from common import ROOT, ConfigError, dump, load
from project_paths import reconnect_file


class PreparationScope(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        base = Path(self.stack.enter_context(tempfile.TemporaryDirectory())).resolve()
        self.root, self.state = base / "project", base / "state"
        self.root.mkdir()
        (self.root / ".git").mkdir()
        self.sub = self.root / "docs"
        self.sub.mkdir()
        profile = load(ROOT / "profiles/generic-1c/profile.yaml")
        profile["repositories"] = [{"id": "product", "path": ".", "alias": "product"}]
        dump(profile, self.root / ".ai/project.yaml")
        self.stack.enter_context(patch.dict(os.environ, {
            "EDT_AI_PROJECT_ROOT": str(self.sub), "EDT_AI_INSTANCE": "second",
            "EDT_AI_STATE_DIR": str(self.state), "EDT_AI_SETTINGS": str(self.state / "settings.json")}, clear=True))
        import settings_backend
        self.backend = settings_backend
        self.stack.enter_context(patch.object(settings_backend, "STATE", self.state))
        self.stack.enter_context(patch.object(settings_backend, "CONFIG", self.state / "settings.json"))
        self.smoke = self.stack.enter_context(patch("runtime.smoke", return_value={"server": {"version": "fixture"}}))
        self.stack.enter_context(patch("policy_runtime.smoke", return_value={"server": {"version": "fixture"}}))

    def authorization(self):
        read = self.backend.main({"action": "read"})
        return {"scope": read["preparationScope"], "effects": ["launch"], "evidence": "explicit fixture launch request"}

    def test_subdirectory_read_and_launch_use_the_same_canonical_root_and_instance(self):
        authorization = self.authorization()
        self.assertEqual(authorization["scope"], f"{self.root}#second")
        result = self.backend.main({"action": "check", "authorization": authorization})
        self.assertEqual(result["projectRoot"], str(self.root))
        self.assertEqual([call.args[2] for call in self.smoke.call_args_list], [self.root, self.root])

    def test_foreign_or_stale_authorization_has_no_runtime_or_reconnect_effect(self):
        authorization = self.authorization()
        for invalid in (None, {**authorization, "scope": f"{self.sub}#second"},
                        {**authorization, "scope": f"{self.root}#first"},
                        {**authorization, "effects": []}, {**authorization, "evidence": " "}):
            with self.subTest(invalid=invalid), self.assertRaises(ConfigError):
                self.backend.main({"action": "check", "authorization": invalid})
        self.smoke.assert_not_called()
        self.assertFalse(reconnect_file(self.state, self.root).exists())


if __name__ == "__main__":
    unittest.main()
