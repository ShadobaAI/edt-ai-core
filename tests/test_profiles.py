"""Profile behavior and failure-path regression checks."""
import copy
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from common import ROOT, ConfigError, dump, load
from profile import validate


class Profiles(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.a = self.root / "source"
        self.b = self.root / "destination"
        self.a.mkdir()
        self.b.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def run_cli(self, *args, success=True):
        run = subprocess.run([sys.executable, str(ROOT / "scripts" / "profile.py"), *map(str, args)],
                             capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(run.returncode == 0, success, run.stdout + run.stderr)
        self.assertNotIn("Traceback", run.stderr)
        return run

    def test_all_presets_roundtrip_and_backups(self):
        for preset in ("generic-1c",):
            a = self.a / preset
            b = self.b / preset
            a.mkdir()
            b.mkdir()
            self.run_cli("init", a, "--profile", preset)
            source = a / ".ai/project.yaml"
            original = load(source)
            original["repositories"] = [{"id": "product", "path": ".", "alias": "product"}]
            original["policy"]["exceptions"] = [{"id": "formatting", "selectors": ["std444"],
                "repository_ids": ["product"], "reason": "Project formatting rule", "source": ".ai/PROJECT.md"}]
            dump(original, source)
            exported = self.root / f"{preset}.yaml"
            self.run_cli("export", a, "--output", exported)
            self.run_cli("import", b, "--input", exported)
            self.assertEqual(load(b / ".ai/project.yaml"), original)
            self.run_cli("import", b, "--input", exported, success=False)
            self.run_cli("import", b, "--input", exported, "--merge")
            backups = list((b / ".ai").glob("*.bak.yaml"))
            self.assertEqual(len(backups), 1)
            self.assertEqual(load(backups[0]), original)
            self.run_cli("export", b, "--output", exported, success=False)
            self.run_cli("export", b, "--output", exported, "--replace")
            self.assertTrue((a / "AGENTS.md").exists())
            self.assertTrue((a / ".ai/PROJECT.md").exists())

    def test_invalid_input_never_changes_active_profile(self):
        self.run_cli("init", self.a)
        active = self.a / ".ai/project.yaml"
        original = active.read_bytes()
        base = load(active)
        cases = [[], {"profile_id": "custom-project"}]
        for field, value in [
            ("repositories", [{"id": "bad", "path": "../outside", "alias": "bad"}]),
            ("repositories", [{"id": "bad", "path": "C:/outside", "alias": "bad"}]),
            ("repositories", [{"id": "a", "path": ".", "alias": "same"},
                              {"id": "b", "path": ".", "alias": "same"}]),
            ("authorities", {"edt_writer": "wrong"}),
            ("schema_version", "9.0"),
            ("policy", {"api_key": "example"}),
            ("roots", {"source": "wrong-type", "protected": []}),
        ]:
            candidate = copy.deepcopy(base)
            candidate[field] = value
            cases.append(candidate)
        for n, candidate in enumerate(cases):
            incoming = self.root / f"invalid{n}.yaml"
            dump(candidate, incoming)
            self.run_cli("import", self.a, "--input", incoming, "--replace", success=False)
            self.assertEqual(active.read_bytes(), original)
        duplicate = self.root / "duplicate.yaml"
        duplicate.write_text("a: 1\na: 2\n", encoding="utf-8")
        self.run_cli("validate", duplicate, success=False)

    def test_merge_profile_switch_rejected(self):
        self.run_cli("init", self.a)
        self.run_cli("init", self.b)
        incoming = self.b / ".ai/project.yaml"
        data = load(incoming)
        data["profile_id"] = "other-project"
        dump(data, incoming)
        self.run_cli("import", self.a, "--input", self.b / ".ai/project.yaml", "--merge", success=False)

    def test_project_presets_are_not_bundled(self):
        self.assertEqual({path.name for path in (ROOT / "profiles").iterdir()}, {"generic-1c"})
        for preset in ("crm", "kafka"):
            self.run_cli("init", self.a, "--profile", preset, success=False)
        self.assertFalse((self.a / ".ai/project.yaml").exists())


if __name__ == "__main__":
    unittest.main()

