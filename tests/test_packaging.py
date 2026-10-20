"""Packaging and publication checks; publication fixtures adapted from md_design (MPL 2.0)."""
import hashlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "tools" / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


packager = load("package-plugin")
verifier = load("verify-package")
publisher = load("publish-marketplace")
policy = load("release_policy")


class PackagingTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        for directory in packager.DIRECTORIES:
            shutil.copytree(ROOT / directory, self.root / directory,
                            ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "local.yaml", "runtime.local.json"))
        for relative in packager.FILES:
            target = self.root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / relative, target)
        (self.root / "packaging").mkdir()
        shutil.copyfile(ROOT / packager.CATALOG_TEMPLATE, self.root / packager.CATALOG_TEMPLATE)

    def package(self, version="0.1.0", environment=None, revision="a" * 40):
        result = subprocess.CompletedProcess([], 0, revision, "")
        with patch.dict(packager.os.environ, environment or {"GITHUB_ACTIONS": ""}), \
                patch.object(packager, "ROOT", self.root), \
                patch.object(packager.subprocess, "run", return_value=result), \
                patch.object(packager.subprocess, "check_output", return_value=""), \
                redirect_stdout(io.StringIO()):
            packager.package(self.root / ".build", version)
        return self.root / ".build"

    def test_portable_roundtrip_excludes_machine_state_and_tests(self):
        plugin = self.root
        (plugin / "settings/local.yaml").write_text("secret")
        (plugin / "hooks/runtime.local.json").write_text("secret")
        (plugin / "settings/secret.json").write_text("secret")
        output = self.package()
        build = verifier.verify(output, self.root / "unpacked")
        shipped = self.root / "unpacked/plugins/1c-ai-core"
        self.assertEqual(build["plugin"], "1c-ai-core")
        for name in ["settings/local.yaml", "hooks/runtime.local.json", "tests", "settings/secret.json",
                     "tools", "packaging", ".work", ".build", ".git", ".venv"]:
            self.assertFalse((shipped / name).exists(), name)
        self.assertEqual({path.name for path in (shipped / "profiles").iterdir()}, {"generic-1c"})
        for name in ["mcp.json", "policy/default.json", "scripts/lazy_mcp.py", "ui/settings.html",
                     "hooks/guard.mjs", ".codex-plugin/plugin.json", "LICENSE", "NOTICE.md", "SOURCE.md",
                     "docs/DEVELOPMENT.md"]:
            self.assertTrue((shipped / name).is_file(), name)
        self.assertEqual((shipped / "LICENSE").read_bytes(), (ROOT / "LICENSE").read_bytes())
        source_notice = (shipped / "SOURCE.md").read_text(encoding="utf-8")
        self.assertIn("https://github.com/ShadobaAI/edt-ai-core/tree/" + build["revision"], source_notice)
        self.assertFalse((ROOT / ".agents/plugins/marketplace.json").exists())

    def test_reproducible_build_and_no_source_manifest_mutation(self):
        original = (self.root / "plugin.json").read_bytes()
        output = self.package()
        checksums = (output / "SHA256SUMS").read_bytes()
        self.package()
        self.assertEqual(checksums, (output / "SHA256SUMS").read_bytes())
        self.assertEqual(original, (self.root / "plugin.json").read_bytes())

    def test_missing_input_preserves_previous_build(self):
        output = self.package()
        original = (output / "SHA256SUMS").read_bytes()
        (self.root / packager.CATALOG_TEMPLATE).unlink()
        with self.assertRaisesRegex(ValueError, "Missing input"):
            self.package()
        self.assertEqual(original, (output / "SHA256SUMS").read_bytes())

    def test_checksum_corruption_rejected_before_extraction(self):
        output = self.package()
        next(output.glob("*.zip")).write_bytes(b"corrupt")
        with self.assertRaisesRegex(ValueError, "Checksum mismatch"):
            verifier.verify(output, self.root / "unpacked")
        self.assertFalse((self.root / "unpacked").exists())

    def test_release_tag_cannot_be_overridden(self):
        environment = {"GITHUB_ACTIONS": "true", "GITHUB_REF_TYPE": "tag", "GITHUB_REF_NAME": "0.2.3"}
        with self.assertRaisesRegex(ValueError, "triggering Git tag"):
            self.package(version="9.0.0", environment=environment)
        output = self.package(version=None, environment=environment)
        self.assertEqual(verifier.verify(output, self.root / "unpacked")["version"], "0.2.3")

    def test_initial_checkout_uses_source_version_without_tags(self):
        result = subprocess.CompletedProcess([], 128, "", "no HEAD")
        with patch.dict(os.environ, {"GITHUB_ACTIONS": ""}), patch.object(policy.subprocess, "run", return_value=result):
            self.assertEqual(policy.resolve_version(self.root), "0.2.1")

    def test_publication_writes_only_to_separate_marketplace_including_first_commit(self):
        source = self.root / "source-origin"
        marketplace = self.root / "marketplace-origin.git"
        real_run = publisher.run
        real_run("git", "init", "--quiet", "--initial-branch=main", str(source))
        real_run("git", "init", "--quiet", "--bare", str(marketplace))
        identity = ["git", "-c", "user.name=CI", "-c", "user.email=ci@example.test"]
        record = {"repository": {"full_name": publisher.REPOSITORY},
                  "head_repository": {"full_name": publisher.REPOSITORY},
                  "path": ".github/workflows/build-plugin.yml", "event": "push", "conclusion": "success"}
        pushes = []

        def github_run(*args, cwd=None, env=None):
            if args[:2] == ("gh", "api"):
                return json.dumps(record)
            if args[:3] == ("gh", "auth", "setup-git"):
                return ""
            if args[:3] == ("gh", "run", "download"):
                destination = Path(args[args.index("--dir") + 1])
                destination.mkdir(parents=True)
                for file in output.iterdir():
                    if file.is_file():
                        shutil.copyfile(file, destination / file.name)
                return ""
            if args[:2] == ("git", "clone"):
                url = args[-2]
                if url == f"https://github.com/{publisher.REPOSITORY}.git":
                    self.assertIsNone(env)  # Built-in source token only.
                    args = (*args[:-2], str(source), args[-1])
                else:
                    self.assertEqual(url, f"https://github.com/{publisher.MARKETPLACE_REPOSITORY}.git")
                    self.assertEqual(env["GH_TOKEN"], "marketplace-write-token")
                    args = (*args[:-2], str(marketplace), args[-1])
            if args[:2] == ("git", "push"):
                self.assertEqual(Path(cwd).name, "catalog")
                self.assertEqual(env["GH_TOKEN"], "marketplace-write-token")
                pushes.append(args)
            return real_run(*args, cwd=cwd, env=env)

        for number, version in enumerate(["0.1.0", "0.2.0"], 1):
            (source / "file.txt").write_text(version)
            real_run("git", "add", "file.txt", cwd=source)
            real_run(*identity, "commit", "-qm", version, cwd=source)
            revision = real_run("git", "rev-parse", "HEAD", cwd=source)
            real_run("git", "tag", version, cwd=source)
            record.update(head_branch=version, head_sha=revision, id=number)
            output = self.package(version=version, revision=revision,
                                  environment={"GITHUB_ACTIONS": "", "GITHUB_RUN_ID": str(number)})
            with patch.dict(publisher.os.environ, {"GITHUB_REPOSITORY": publisher.REPOSITORY,
                            "GH_TOKEN": "source-read-token", "MARKETPLACE_TOKEN": "marketplace-write-token"}), \
                    patch.object(publisher, "run", side_effect=github_run):
                publisher.publish(number, self.root / f"publication-{number}")
            manifest = json.loads(real_run("git", "show", "main:plugins/1c-ai-core/.codex-plugin/plugin.json", cwd=marketplace))
            self.assertEqual(manifest["version"], version)
            self.assertEqual(real_run("git", "rev-parse", "HEAD", cwd=source), revision)
        self.assertEqual(len(pushes), 2)
        published = real_run("git", "rev-parse", "main", cwd=marketplace)
        with patch.dict(publisher.os.environ, {"GITHUB_REPOSITORY": publisher.REPOSITORY,
                        "MARKETPLACE_TOKEN": "marketplace-write-token"}), \
                patch.object(publisher, "run", side_effect=github_run):
            publisher.publish(2, self.root / "publication-repeat")
        self.assertEqual(real_run("git", "rev-parse", "main", cwd=marketplace), published)
        self.assertEqual(len(pushes), 2)

        record.update(head_branch="0.1.0", head_sha=real_run("git", "rev-parse", "0.1.0", cwd=source), id=1)
        output = self.package(version="0.1.0", revision=record["head_sha"],
                              environment={"GITHUB_ACTIONS": "", "GITHUB_RUN_ID": "1"})
        with patch.dict(publisher.os.environ, {"GITHUB_REPOSITORY": publisher.REPOSITORY,
                        "MARKETPLACE_TOKEN": "marketplace-write-token"}), \
                patch.object(publisher, "run", side_effect=github_run), \
                self.assertRaisesRegex(ValueError, "roll back"):
            publisher.publish(1, self.root / "publication-rollback")
        self.assertEqual(real_run("git", "rev-parse", "main", cwd=marketplace), published)
        self.assertEqual(len(pushes), 2)

    def test_catalog_merge_preserves_other_plugins_order_and_metadata(self):
        payload = self.root / "payload"
        verifier.verify(self.package(), payload)
        incoming = json.loads((payload / ".agents/plugins/marketplace.json").read_text(encoding="utf-8"))
        checkout = self.root / "store"
        catalog_file = checkout / ".agents/plugins/marketplace.json"
        catalog_file.parent.mkdir(parents=True)
        other = {"name": "notes", "source": {"source": "local", "path": "./plugins/notes"},
                 "policy": {"installation": "AVAILABLE", "authentication": "ON_INSTALL"}, "category": "Productivity"}
        for plugins in [[other], [{"name": "1c-ai-core", "category": "Outdated"}, other]]:
            with self.subTest(replace=plugins[0]["name"] == "1c-ai-core"):
                current = {"name": "shadobaai", "owner": {"name": "ShadobaAI"},
                           "interface": {"displayName": "ShadobaAI", "shortDescription": "Shared plugins"},
                           "plugins": plugins}
                catalog_file.write_text(json.dumps(current), encoding="utf-8")
                publisher.update_catalog(checkout, payload)
                actual = json.loads(catalog_file.read_text(encoding="utf-8"))
                expected_names = [entry["name"] for entry in plugins]
                if "1c-ai-core" not in expected_names:
                    expected_names.append("1c-ai-core")
                self.assertEqual([entry["name"] for entry in actual["plugins"]], expected_names)
                self.assertEqual(next(entry for entry in actual["plugins"] if entry["name"] == "notes"), other)
                self.assertEqual(next(entry for entry in actual["plugins"] if entry["name"] == "1c-ai-core"), incoming["plugins"][0])
                self.assertEqual(actual["name"], incoming["name"])
                self.assertEqual(actual["owner"], current["owner"])
                self.assertEqual(actual["interface"]["shortDescription"], "Shared plugins")

        duplicate = {**current, "plugins": [other, other]}
        catalog_file.write_text(json.dumps(duplicate), encoding="utf-8")
        original = catalog_file.read_bytes()
        with self.assertRaisesRegex(ValueError, "Duplicate plugin names"):
            publisher.update_catalog(checkout, payload)
        self.assertEqual(catalog_file.read_bytes(), original)

    def test_shared_store_push_conflicts_are_bounded_and_preserve_other_plugins(self):
        real_run = publisher.run
        identity = ["git", "-c", "user.name=CI", "-c", "user.email=ci@example.test"]
        relative_catalog = ".agents/plugins/marketplace.json"
        for scenario, expected_attempts in [("concurrent", 2), ("denied", 1), ("busy", 3)]:
            with self.subTest(scenario=scenario):
                root = self.root / scenario
                root.mkdir()
                origin, seed, checkout, payload = [root / name for name in ["origin.git", "seed", "checkout", "payload"]]
                build = verifier.verify(self.package(), payload)
                real_run("git", "init", "--quiet", "--bare", str(origin))
                real_run("git", "init", "--quiet", "--initial-branch=main", str(seed))
                other = {"name": "notes", "source": {"source": "local", "path": "./plugins/notes"},
                         "policy": {"installation": "AVAILABLE", "authentication": "ON_INSTALL"}, "category": "Productivity"}
                catalog = {"name": "shadobaai", "interface": {"displayName": "ShadobaAI"}, "plugins": [other]}
                catalog_file = seed / relative_catalog
                catalog_file.parent.mkdir(parents=True)
                catalog_file.write_text(json.dumps(catalog), encoding="utf-8")
                notes_file = seed / "plugins/notes/notes.txt"
                notes_file.parent.mkdir(parents=True)
                notes_file.write_text("initial")
                (seed / "README.md").write_text("Shared plugin store")
                real_run("git", "add", ".", cwd=seed)
                real_run(*identity, "commit", "-qm", "Initial store", cwd=seed)
                real_run("git", "remote", "add", "origin", str(origin), cwd=seed)
                real_run("git", "push", "--quiet", "origin", "main", cwd=seed)
                real_run("git", "clone", "--quiet", "--branch", "main", str(origin), str(checkout))
                attempts = []

                def competing_run(*args, cwd=None, env=None):
                    if args[:2] == ("git", "push") and Path(cwd) == checkout:
                        attempts.append(args)
                        if scenario == "denied":
                            raise subprocess.CalledProcessError(128, args)
                        if scenario == "busy" or len(attempts) == 1:
                            other["description"] = f"Concurrent update {len(attempts)}"
                            catalog_file.write_text(json.dumps(catalog), encoding="utf-8")
                            notes_file.write_text(other["description"])
                            real_run("git", "add", ".", cwd=seed)
                            real_run(*identity, "commit", "-qm", other["description"], cwd=seed)
                            real_run("git", "push", "--quiet", "origin", "main", cwd=seed)
                    return real_run(*args, cwd=cwd, env=env)

                with patch.object(publisher, "run", side_effect=competing_run):
                    if scenario == "concurrent":
                        publisher.push_release(checkout, payload, self.root, build, dict(publisher.os.environ))
                    else:
                        with self.assertRaises(subprocess.CalledProcessError):
                            publisher.push_release(checkout, payload, self.root, build, dict(publisher.os.environ))
                self.assertEqual(len(attempts), expected_attempts)
                published = json.loads(real_run("git", "show", f"main:{relative_catalog}", cwd=origin))
                self.assertEqual(next(entry for entry in published["plugins"] if entry["name"] == "notes"), other)
                self.assertEqual(real_run("git", "show", "main:plugins/notes/notes.txt", cwd=origin),
                                 other.get("description", "initial"))
                self.assertEqual(real_run("git", "show", "main:README.md", cwd=origin), "Shared plugin store")
                self.assertEqual(sum(entry["name"] == "1c-ai-core" for entry in published["plugins"]),
                                 int(scenario == "concurrent"))


class PublicationTests(unittest.TestCase):
    def record(self):
        return {"repository": {"full_name": publisher.REPOSITORY}, "head_repository": {"full_name": publisher.REPOSITORY},
                "path": ".github/workflows/build-plugin.yml", "event": "push", "conclusion": "success",
                "head_branch": "1.0.0", "head_sha": "a" * 40, "id": 123}

    def test_only_successful_tag_run_from_this_repository_is_accepted(self):
        for version in ["1.0.0", "10.20.30"]:
            publisher.validate_run({**self.record(), "head_branch": version})
        for key, value in [("event", "pull_request"), ("conclusion", "failure"), ("head_branch", "main"),
                           ("head_branch", "v1.0.0"), ("head_branch", "release-1.0.0"),
                           ("head_branch", "1.0.0-rc.1"), ("head_branch", "01.0.0"),
                           ("head_repository", {"full_name": "other/repo"}), ("path", "other.yml")]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                publisher.validate_run({**self.record(), key: value})

    def test_automatic_publication_rejects_ineligible_runs_before_download_or_write(self):
        for key, value in [("event", "pull_request"), ("conclusion", "failure"),
                           ("conclusion", "cancelled"), ("head_branch", "main"),
                           ("head_branch", "feature/test"), ("head_branch", "v1.0.0"),
                           ("head_branch", "1.0"), ("head_branch", "invalid"),
                           ("head_repository", {"full_name": "other/repo"})]:
            record = {**self.record(), key: value}
            with self.subTest(key=key, value=value), \
                    patch.dict(publisher.os.environ, {"GITHUB_REPOSITORY": publisher.REPOSITORY}), \
                    patch.object(publisher, "run", return_value=json.dumps(record)) as calls:
                with self.assertRaises(ValueError):
                    publisher.publish(123, ROOT / ".test-tmp/not-used-publication")
                calls.assert_called_once_with("gh", "api", f"repos/{publisher.REPOSITORY}/actions/runs/123")

    def test_missing_marketplace_token_fails_before_download_or_write(self):
        with patch.dict(publisher.os.environ, {"GITHUB_REPOSITORY": publisher.REPOSITORY, "MARKETPLACE_TOKEN": ""}), \
                patch.object(publisher, "run", return_value=json.dumps(self.record())) as calls:
            with self.assertRaisesRegex(ValueError, "MARKETPLACE_TOKEN"):
                publisher.publish(123, ROOT / ".test-tmp/not-used-publication")
            calls.assert_called_once_with("gh", "api", f"repos/{publisher.REPOSITORY}/actions/runs/123")

    def test_nonproduction_dirty_or_unrelated_artifacts_are_rejected(self):
        build = {"profile": "release", "dirty": False, "revision": "a" * 40, "version": "1.0.0", "runId": "123"}
        publisher.validate_build(build, self.record())
        for key, value in [("profile", "development"), ("dirty", True), ("revision", "b" * 40), ("version", "0.9.0"), ("runId", "999")]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                publisher.validate_build({**build, key: value}, self.record())

    def test_stable_version_order_and_rejection(self):
        versions = ["0.9.0", "1.0.0", "1.0.1", "2.0.0", "10.0.0"]
        self.assertEqual(sorted(reversed(versions), key=publisher.version_key), versions)
        for version in ["v1.0.0", "1.0.0-rc.1", "1.0", "01.0.0", "١.0.0"]:
            with self.subTest(version=version), self.assertRaises(ValueError):
                publisher.version_key(version)

    def test_source_tag_peels_annotated_tags_and_rejects_moved_tag(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            origin = root / "origin"
            checkout = root / "checkout"
            publisher.run("git", "init", "--quiet", "--initial-branch=main", str(origin))
            (origin / "file.txt").write_text("first")
            publisher.run("git", "add", "file.txt", cwd=origin)
            identity = ["git", "-c", "user.name=CI", "-c", "user.email=ci@example.test"]
            publisher.run(*identity, "commit", "-qm", "first", cwd=origin)
            revision = publisher.run("git", "rev-parse", "HEAD", cwd=origin)
            publisher.run(*identity, "tag", "-a", "1.0.0", "-m", "release", cwd=origin)
            publisher.run("git", "clone", "--quiet", str(origin), str(checkout))
            build = {"version": "1.0.0", "revision": revision}
            publisher.validate_source_tag(checkout, build)
            (origin / "file.txt").write_text("second")
            publisher.run("git", "add", "file.txt", cwd=origin)
            publisher.run(*identity, "commit", "-qm", "second", cwd=origin)
            publisher.run("git", "tag", "--force", "1.0.0", cwd=origin)
            with self.assertRaisesRegex(ValueError, "no longer points"):
                publisher.validate_source_tag(checkout, build)


if __name__ == "__main__":
    unittest.main()
