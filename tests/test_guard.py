"""Actual bundled hook responses for synthetic protected-source boundaries."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from common import ROOT, dump, load


class RoutingGuard(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        (self.root / "src").mkdir(); (self.root / "tools").mkdir()
        data = load(ROOT / "profiles/generic-1c/profile.yaml")
        data["repositories"] = [{"id": "product", "path": ".", "alias": "product"}]
        data["roots"] = {"source": ["src"], "protected": ["src"]}
        dump(data, self.root / ".ai/project.yaml")

    def tearDown(self): self.tmp.cleanup()

    def check(self, tool, args, cwd=None):
        result = subprocess.run(["node", str(ROOT / "hooks/guard.mjs")],
            input=json.dumps({"hook_event_name": "PreToolUse", "cwd": str(cwd or self.root), "tool_name": tool, "tool_input": args}),
            capture_output=True, encoding="utf-8", env={**os.environ, "EDT_AI_PYTHON": sys.executable})
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout).get("hookSpecificOutput", {}).get("permissionDecision")

    def test_protected_read_write_patch_and_traversal_are_denied(self):
        for tool, args in [("Read", {"path": "src/Module.bsl"}),
            ("Write", {"path": str(self.root / "src/Module.bsl"), "content": "body"}),
            ("apply_patch", {"command": "*** Begin Patch\n*** Delete File: src/Module.bsl\n*** End Patch"}),
            ("Bash", {"command": "type ../src/Module.bsl", "cwd": str(self.root / "tools")})]:
            with self.subTest(tool=tool): self.assertEqual(self.check(tool, args), "deny")

    def test_broad_shell_and_alias_escape_are_denied(self):
        self.assertEqual(self.check("Bash", {"command": "rg --files", "cwd": str(self.root)}), "deny")
        self.assertEqual(self.check("Bash", {"command": "cd ..; rg --files", "cwd": str(self.root / "tools")}), "deny")
        self.assertEqual(self.check("mcp__code_index__get_function", {"repo": "foreign"}), "deny")

    def test_patch_moves_check_both_original_and_destination_paths(self):
        for original, destination in (("docs/change.md", "src/Module.bsl"),
                                      ("src/Module.bsl", "docs/change.md"),
                                      ("docs/change.md", "tools/../src/Module.bsl")):
            patch = f"*** Begin Patch\n*** Update File: {original}\n*** Move to: {destination}\n@@\n-old\n+new\n*** End Patch"
            with self.subTest(original=original, destination=destination):
                self.assertEqual(self.check("apply_patch", patch), "deny")
        safe = "*** Begin Patch\n*** Update File: docs/old.md\n*** Move to: docs/new.md\n@@\n-old\n+new\n*** End Patch"
        self.assertIsNone(self.check("apply_patch", safe))

    def test_scoped_tooling_docs_and_assigned_mcp_are_allowed(self):
        self.assertIsNone(self.check("Bash", {"command": "python lint.py", "cwd": str(self.root / "tools")}))
        self.assertIsNone(self.check("Write", {"path": "README.md", "content": "The src/ folder contains sources"}))
        self.assertIsNone(self.check("mcp__code_index__read_file", {"repo": "product", "path": "src/Module.bsl"}))
        self.assertIsNone(self.check("mcp__edt__write_module_source", {"projectName": "ExactProject"}))

    def test_invalid_profile_fails_closed_and_unrelated_directory_is_unaffected(self):
        (self.root / ".ai/project.yaml").write_text("broken: true", encoding="utf-8")
        self.assertEqual(self.check("Read", {"path": "src/Module.bsl"}), "deny")
        with tempfile.TemporaryDirectory() as unrelated:
            self.assertIsNone(self.check("Read", {"path": "README.md"}, unrelated))
