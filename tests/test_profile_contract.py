"""Typed capabilities, repository relations and safe nested-path import."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from common import ROOT, ConfigError, dump, load
from profile import validate, validate_at
from action_policy import effective_policy


class ProfileContract(unittest.TestCase):
    def setUp(self):
        self.data = load(ROOT / "profiles/generic-1c/profile.yaml")
        self.data["repositories"] = [
            {"id": "product", "path": "product", "alias": "product", "edt_project": "Product"},
            {"id": "tests", "path": "tests", "alias": "tests", "edt_project": "TestExtension"},
            {"id": "framework", "path": "framework", "alias": "framework"},
        ]

    def enabled(self):
        data = copy.deepcopy(self.data)
        data["testing"].update(yaxunit=True, vanessa=True,
            yaxunit_config={"repository_id": "tests", "framework_repository_id": "framework",
                "product_repository_ids": ["product"], "runner": "edt", "results": "results/unit"},
            vanessa_config={"repository_id": "tests", "runtime_profile": ".ai/vanessa.local.json",
                "features": "tests/features", "results": "results/ui", "server_name": "vanessa"})
        return data

    def test_enabled_test_bindings_are_typed_and_portable(self):
        data = self.enabled()
        self.assertIs(validate(data), data)
        self.assertEqual(effective_policy(data["policy"])["require_explicit_confirmation"],
                         ["cleanup", "launch", "database", "remote_git"])

    def test_bad_capability_types_missing_bindings_and_unknown_fields_fail(self):
        for update in [
            {"yaxunit": "false"}, {"vanessa": 123}, {"commands": "run something"},
            {"yaxunit": True}, {"vanessa": True}, {"vanesa": False},
            {"commands": [{"id": "run", "repository_id": "tests", "argv": "python run.py", "effects": []}]},
        ]:
            with self.subTest(update=update):
                data = copy.deepcopy(self.data)
                data["testing"].update(update)
                with self.assertRaises(ConfigError):
                    validate(data)
        for section in ("project", "policy", "knowledge"):
            data = copy.deepcopy(self.data)
            data[section]["unknown_field"] = True
            with self.assertRaises(ConfigError):
                validate(data)
        # Portable and local runtime schemas must accept the same server names.
        data = self.enabled(); data["testing"]["vanessa_config"]["server_name"] = "project.ui"
        with self.assertRaises(ConfigError):
            validate(data)

    def test_unknown_or_conflicting_repository_bindings_fail(self):
        cases = []
        for key in ("repository_id", "framework_repository_id"):
            data = self.enabled(); data["testing"]["yaxunit_config"][key] = "missing"; cases.append(data)
        data = self.enabled(); data["testing"]["yaxunit_config"]["framework_repository_id"] = "tests"; cases.append(data)
        data = self.enabled(); data["repositories"][1].pop("edt_project"); cases.append(data)
        data = self.enabled(); data["policy"]["unbound_edt_repositories"] = ["tests"]; cases.append(data)
        data = self.enabled(); data["policy"].update(edt_repository_ids=["tests"], unbound_edt_repositories=["tests"]); cases.append(data)
        for data in cases:
            with self.subTest(data=data), self.assertRaises(ConfigError):
                validate(data)

    def test_shared_policy_cannot_be_weakened_and_exceptions_need_scoped_evidence(self):
        for update in [
            {"allow_shell_source_read": True}, {"require_explicit_confirmation": []},
            {"mode": "anything"}, {"require_explicit_confirmation": ["unknown_effect"]},
            {"exceptions": [{"id": "rule", "selectors": ["std444"], "repository_ids": [], "reason": "reason", "source": "user instruction"}]},
            {"exceptions": [{"id": "rule", "selectors": ["std444"], "repository_ids": ["tests"], "reason": " ", "source": "user instruction"}]},
        ]:
            data = copy.deepcopy(self.data); data["policy"].update(update)
            with self.subTest(update=update), self.assertRaises(ConfigError):
                validate(data)

    def test_nested_paths_and_cross_repository_features_are_rejected(self):
        for key in ("features", "results", "runtime_profile"):
            for value in ("../outside", "C:/outside"):
                data = self.enabled(); data["testing"]["vanessa_config"][key] = value
                with self.subTest(key=key, value=value), self.assertRaises(ConfigError):
                    validate(data)
        with tempfile.TemporaryDirectory() as directory:
            data = self.enabled(); data["testing"]["vanessa_config"]["features"] = "product/features"
            with self.assertRaisesRegex(ConfigError, "owning repository"):
                validate_at(directory, data)

    def test_command_validation_does_not_execute_it(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "must-not-exist"
            command = {"id": "unit", "repository_id": "tests", "argv": ["python", "-c", f"open({str(marker)!r}, 'w').close()"], "effects": []}
            data = copy.deepcopy(self.data); data["testing"]["commands"] = [command]
            validate(data)
            self.assertFalse(marker.exists())
            data["testing"]["commands"].append(copy.deepcopy(command))
            with self.assertRaisesRegex(ConfigError, "ids must be unique"):
                validate(data)

    def test_invalid_nested_cli_import_preserves_profile_and_creates_no_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            active = root / ".ai/project.yaml"
            dump(self.data, active)
            before = active.read_bytes()
            data = self.enabled(); data["testing"]["vanessa_config"]["features"] = "../outside"
            incoming = root / "invalid.json"; incoming.write_text(json.dumps(data), encoding="utf-8")
            result = subprocess.run([sys.executable, str(ROOT / "scripts/profile.py"), "import", str(root),
                                     "--input", str(incoming), "--replace"], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(active.read_bytes(), before)
            self.assertEqual(list(active.parent.glob("*.bak.yaml")), [])


if __name__ == "__main__":
    unittest.main()
