"""Runtime failure paths independent from network and external processes."""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import copy
import hashlib
import io
import os
import sys
import tempfile
import threading
import time
import unittest
import zipfile
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from common import ConfigError, operation_lock, settings
from runtime import (artifact, ensure_daemon, ensure_installed, index_config, index_readiness,
                     launch_command, project_home, read_json, save_json, sha, validate_bsl_tools)
from runtime import path_key


class Runtime(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state = Path(self.tmp.name)
        self.config = settings()
    def tearDown(self):
        self.tmp.cleanup()

    def test_lock_prevents_concurrent_mutation(self):
        with operation_lock(self.state):
            with self.assertRaises(ConfigError):
                with operation_lock(self.state):
                    pass
        self.assertFalse((self.state / "operation.lock").exists())

    def test_corrupt_artifact_is_never_treated_as_installed(self):
        target = self.state / "runtime/code-index/v1.2.3/bsl-indexer.exe"
        target.parent.mkdir(parents=True)
        target.write_bytes(b"test binary")
        save_json(self.state / "runtime-lock.json", {"code-index": {
            "release": "v1.2.3", "sha256": sha(target)}})
        self.assertEqual(artifact(self.state, "code-index"), target)
        with patch("runtime.fetch_json", side_effect=AssertionError("network used")):
            self.assertEqual(ensure_installed(self.state, self.config, "code-index"), target)
        target.write_bytes(b"corrupt")
        self.assertIsNone(artifact(self.state, "code-index"))

    def test_unverified_download_cannot_replace_lock(self):
        prior = {"bsl-ls": {"release": "v1.0.0", "sha256": "0" * 64}}
        save_json(self.state / "runtime-lock.json", prior)
        release = {"tag_name": "v1.0.7", "assets": [{"name": "bsl-language-server-1.0.7-exec.jar",
                                                  "digest": None}]}
        with patch("runtime.fetch_json", return_value=release):
            with self.assertRaises(ConfigError):
                ensure_installed(self.state, self.config, "bsl-ls")
        import json
        self.assertEqual(json.loads((self.state / "runtime-lock.json").read_text()), prior)

    def test_refresh_of_the_same_release_keeps_existing_process_artifacts_immutable(self):
        def jar(text):
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, "w") as archive:
                archive.writestr("fixture.txt", text)
            return buffer.getvalue()
        old, new = jar("old runtime"), jar("replacement runtime")
        prior = self.state / "runtime/bsl-ls/v1.2.3/bsl-language-server-exec.jar"
        prior.parent.mkdir(parents=True)
        prior.write_bytes(old)
        save_json(self.state / "runtime-lock.json", {"bsl-ls": {
            "release": "v1.2.3", "path": str(prior.relative_to(self.state)), "sha256": sha(prior)}})
        release = {"tag_name": "v1.2.3", "assets": [{
            "name": "bsl-language-server-1.2.3-exec.jar", "size": len(new),
            "digest": "sha256:" + hashlib.sha256(new).hexdigest(), "browser_download_url": "https://fixture.invalid/runtime.jar"}]}
        unchanged = copy.deepcopy(release)
        unchanged["assets"][0].update(size=len(old), digest="sha256:" + hashlib.sha256(old).hexdigest())
        with prior.open("rb"), patch("runtime.fetch_json", return_value=unchanged), \
             patch("runtime.urllib.request.urlopen", return_value=io.BytesIO(old)):
            self.assertEqual(ensure_installed(self.state, self.config, "bsl-ls", refresh=True), prior.resolve())
        with prior.open("rb"), patch("runtime.fetch_json", return_value=release), \
             patch("runtime.urllib.request.urlopen", side_effect=lambda *a, **kw: io.BytesIO(new)) as download:
            target = ensure_installed(self.state, self.config, "bsl-ls", refresh=True)
            self.assertNotEqual(target, prior)
            self.assertEqual(prior.read_bytes(), old)
            self.assertEqual(target.read_bytes(), new)
            self.assertEqual(artifact(self.state, "bsl-ls"), target)
            modified = target.stat().st_mtime_ns
            with target.open("rb"):
                self.assertEqual(ensure_installed(self.state, self.config, "bsl-ls", refresh=True), target)
            self.assertEqual(target.stat().st_mtime_ns, modified)
            self.assertEqual(download.call_count, 2)

    def test_runtime_lock_cannot_redirect_an_artifact_outside_its_component(self):
        foreign = self.state / "foreign.jar"
        foreign.write_bytes(b"foreign")
        save_json(self.state / "runtime-lock.json", {"bsl-ls": {
            "release": "v1.2.3", "path": "foreign.jar", "sha256": sha(foreign)}})
        with self.assertRaises(ConfigError):
            artifact(self.state, "bsl-ls")

    def test_mapping_change_while_daemon_running_is_rejected(self):
        root = self.state / "project"
        root.mkdir()
        data = {"repositories": [{"id": "a", "alias": "a", "path": "."}]}
        home = self.state / "daemon"
        index_config(home, root, data)
        data["repositories"][0]["alias"] = "changed"
        with patch("runtime.daemon_health", return_value={"status": "running"}):
            with self.assertRaises(ConfigError):
                index_config(home, root, data)

    def test_bsl_launch_allows_multiple_repositories_without_picking_a_configuration(self):
        root = self.state / "project"; root.mkdir()
        (root / "tests").mkdir()
        data = {"repositories": [{"id": "product", "path": ".", "alias": "product"},
                                  {"id": "tests", "path": "tests", "alias": "tests"}]}
        with patch("runtime.ensure_installed", return_value=self.state / "fixture.jar"), \
             patch("runtime.java_command", return_value="java"), patch("runtime.shutil.which", return_value="node"):
            command, cwd, _ = launch_command(self.state, self.config, "bsl-ls", root, data)
            self.assertEqual(cwd, root.resolve())
            self.assertEqual(command[command.index("--project-root") + 1], str(root.resolve()))
            self.assertNotIn("--configuration", command)
            self.assertFalse((project_home(self.state, root) / "bsl-language-server.json").exists())

    def test_bsl_explicit_configuration_is_checked_before_install_and_passed_unchanged(self):
        root = self.state / "проект"; root.mkdir()
        configuration = root / "bsl-language-server.json"
        self.config["mcp"]["managed"]["bsl-ls"]["configuration"] = configuration.name
        with patch("runtime.ensure_installed") as install, patch("runtime.shutil.which", return_value="node"):
            with self.assertRaisesRegex(ConfigError, "configuration does not exist"):
                launch_command(self.state, self.config, "bsl-ls", root, {})
            install.assert_not_called()
        configuration.write_text('{}', encoding='utf-8')
        with patch("runtime.ensure_installed", return_value=self.state / "fixture.jar"), \
             patch("runtime.java_command", return_value="java"), patch("runtime.shutil.which", return_value="node"):
            command, _, _ = launch_command(self.state, self.config, "bsl-ls", root, {})
            self.assertEqual(command[command.index("--configuration") + 1], str(configuration.resolve()))

    def test_bsl_contract_requires_native_registration_and_workspace_scoping(self):
        tools = [{"name": name} for name in ("register_workspace_folder", "list_workspace_folders", "unregister_workspace_folder")]
        tools[-1]["inputSchema"] = {"properties": {"workspaceFolder": {"type": "string"}}, "required": ["workspaceFolder"]}
        for name in ("type_info", "global_member_info", "global_member_search"):
            tools.append({"name": name, "inputSchema": {"properties": {"workspaceFolder": {"type": "string"}}, "required": ["workspaceFolder"]}})
        validate_bsl_tools(tools)
        with self.assertRaisesRegex(ConfigError, "native multi-workspace API"):
            validate_bsl_tools(tools[1:])
        for tool in tools[3:]:
            tool["inputSchema"]["required"] = []
        with self.assertRaisesRegex(ConfigError, "workspaceFolder-aware analyzer tool"):
            validate_bsl_tools(tools)

    def test_bsl_gate_accepts_a_new_analyzer_name_but_not_a_lifecycle_only_catalogue(self):
        tools = [{"name": name} for name in ("register_workspace_folder", "list_workspace_folders", "unregister_workspace_folder")]
        schema = {"properties": {"workspaceFolder": {"type": "string"}}, "required": ["workspaceFolder"]}
        tools[-1]["inputSchema"] = schema
        with self.assertRaises(ConfigError):
            validate_bsl_tools(tools)
        tools.append({"name": "future_analyzer", "inputSchema": schema})
        validate_bsl_tools(tools)

    def test_readiness_needs_exact_paths_and_positive_freshness(self):
        root = self.state / "project"; root.mkdir()
        data = {"repositories": [{"id": "a", "alias": "product", "path": "."},
                                  {"id": "b", "alias": "tests", "path": "tests"}]}
        body = {"mcp": {"status": "ok"}, "daemon": {"status": "online"}, "repos": [
            {"repo": repo["alias"], "root_path": str(root / repo["path"]),
             "path_status": {"status": "ready", "path": str(root / repo["path"])},
             "data_version": {"stale": False}} for repo in data["repositories"]]}
        self.assertTrue(index_readiness(body, root, data))
        variants = []
        for field in ("root_path", "path_status", "data_version"):
            changed = copy.deepcopy(body); changed["repos"][0].pop(field); variants.append(changed)
        for status in ("not_started", "initial_indexing", "reindexing_batch", "reindexing_extras", "error"):
            changed = copy.deepcopy(body); changed["repos"][0]["path_status"]["status"] = status; variants.append(changed)
        for stale in (None, True, "false", 0):
            changed = copy.deepcopy(body); changed["repos"][0]["data_version"]["stale"] = stale; variants.append(changed)
        changed = copy.deepcopy(body); changed["repos"][0]["root_path"] = str(self.state / "foreign"); variants.append(changed)
        changed = copy.deepcopy(body); changed["repos"][0]["path_status"]["path"] = str(self.state / "foreign"); variants.append(changed)
        changed = copy.deepcopy(body); changed["repos"][1] = changed["repos"][0]; variants.append(changed)
        changed = copy.deepcopy(body); changed["daemon"]["status"] = "offline"; variants.append(changed)
        for changed in variants:
            with self.subTest(body=changed):
                self.assertFalse(index_readiness(changed, root, data))

    @unittest.skipUnless(os.name == "nt", "Windows canonical daemon paths")
    def test_verbatim_windows_paths_match_profile_and_daemon_identity(self):
        root = self.state / "project"; root.mkdir()
        verbatim = "\\\\?\\" + str(root.resolve())
        self.assertEqual(path_key(root), path_key(verbatim))
        self.assertEqual(project_home(self.state, root), project_home(self.state, verbatim))

    def test_different_profiles_start_concurrently_and_reuse_their_own_daemon(self):
        roots = [self.state / name for name in ("first", "second")]
        for root in roots: root.mkdir()
        data = {"repositories": [{"id": "product", "alias": "product", "path": "."}]}
        exe = self.state / "runtime.exe"
        running, starts = {}, []
        barrier = threading.Barrier(2)
        def start(command, cwd, env, **kwargs):
            self.assertEqual(Path(env["CODE_INDEX_HOME"]), cwd)
            barrier.wait(timeout=5)  # A global startup lock would deadlock this.
            # Each home corresponds to one canonical profile root.
            root = next(root for root in roots if project_home(self.state, root) / "code-index" == cwd)
            pid = 100 + roots.index(root)
            running[cwd] = {"status": "running", "pid": pid, "paths": [{"path": str(root), "status": "ready"}]}
            starts.append(cwd)
            from types import SimpleNamespace
            return SimpleNamespace(pid=pid, poll=lambda: None)
        with patch("runtime.ensure_installed", return_value=exe), \
             patch("runtime.daemon_health", side_effect=lambda home: running.get(home)), \
             patch("runtime.subprocess.Popen", side_effect=start):
            with ThreadPoolExecutor(max_workers=2) as pool:
                launches = list(pool.map(lambda root: launch_command(self.state, self.config, "code-index", root, data), roots))
            self.assertEqual(len(starts), 2)
            self.assertNotEqual(launches[0][1], launches[1][1])
            for root, (_, home, env) in zip(roots, launches):
                self.assertEqual(ensure_daemon(self.state, root / ".", data, exe), home)
                self.assertEqual(Path(env["CODE_INDEX_HOME"]), home)
            self.assertEqual(len(starts), 2)
            owner_file = launches[0][1] / "owner.json"
            owner = read_json(owner_file); owner["project_root"] = str(roots[1]); save_json(owner_file, owner)
            with self.assertRaisesRegex(ConfigError, "ownership mismatch"):
                ensure_daemon(self.state, roots[0], data, exe)

    def test_same_profile_simultaneous_readers_start_only_one_daemon(self):
        root = self.state / "project"; root.mkdir()
        data = {"repositories": [{"id": "a", "alias": "a", "path": "."}]}
        exe = self.state / "runtime.exe"
        running, starts = {}, []
        def start(command, cwd, **kwargs):
            from types import SimpleNamespace
            time.sleep(.1)
            starts.append(cwd)
            running[cwd] = {"pid": 123, "status": "running", "paths": [{"path": str(root)}]}
            return SimpleNamespace(pid=123, poll=lambda: None)
        with patch("runtime.daemon_health", side_effect=lambda home: running.get(home)), \
             patch("runtime.subprocess.Popen", side_effect=start):
            with ThreadPoolExecutor(max_workers=2) as pool:
                homes = list(pool.map(lambda _: ensure_daemon(self.state, root, data, exe), range(2)))
        self.assertEqual(homes[0], homes[1])
        self.assertEqual(len(starts), 1)


if __name__ == "__main__":
    unittest.main()

