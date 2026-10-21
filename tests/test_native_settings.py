"""Exercise native settings extension and import tools over the real MCP connection."""
import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from common import ROOT, dump, load
from mcp_client import McpClient


class ControlledRoots(McpClient):
    supplied_roots = None

    def send(self, message):
        if self.supplied_roots is not None and str(message.get("id", "")).startswith("settings-roots-") and "result" in message:
            message = {**message, "result": {"roots": [{"uri": path.as_uri()} for path in self.supplied_roots]}}
        super().send(message)


class NativeSettings(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name).resolve()
        self.project = self.base / "project"
        self.project.mkdir()
        self.state = self.base / "state"
        self.env = {**os.environ, "EDT_AI_STATE_DIR": str(self.state),
                    "EDT_AI_SETTINGS": str(self.state / "settings.json"),
                    "EDT_AI_INSTANCE": "first",
                    "EDT_AI_PYTHON": sys.executable}
        for key in ("EDT_AI_PROJECT_ROOT", "EDT_AI_CONNECTIONS_FILE", "EDT_AI_EDT_URL", "EDT_AI_V8STD_URL", "EDT_AI_SETTINGS_ROOT_LOCKED"):
            self.env.pop(key, None)
        self.client = McpClient(["node", str(ROOT / "mcp/settings.mjs")], ROOT,
                                env=self.env, timeout=30)
        self.init = self.client.initialize()
        self.profile = load(ROOT / "profiles/generic-1c/profile.yaml")
        self.profile["repositories"] = [{"id": "product", "path": ".", "alias": "product"}]

    def tearDown(self):
        self.client.close()
        self.tmp.cleanup()

    def call(self, name, **args):
        return self.client.call(name, args)

    def preview(self, profile=None):
        return self.call("settings.preview", text=json.dumps(profile or self.profile),
                         projectRoot=str(self.project))["structuredContent"]

    def apply(self, profile=None, replace=False):
        data = profile or self.profile
        preview = self.preview(data)
        return self.call("settings.apply", text=json.dumps(data), projectRoot=str(self.project),
                         revision=preview["revision"], replace=replace)["structuredContent"]

    def test_native_metadata_and_read_are_available_before_configuration(self):
        capability = self.init["capabilities"]["experimental"]["openai/settings"]
        self.assertEqual(capability["readTool"], "settings.read")
        discover = self.client.request("server/discover")
        self.assertEqual(discover["capabilities"]["extensions"]["openai/settings"], capability)
        read = self.call("settings.read")["structuredContent"]
        self.assertEqual(read["values"]["projectRoot"], "")
        self.assertIn({"kind": "tool", "tool": "settings.import"}, read["layout"][0]["items"])
        self.assertFalse(self.state.exists())
        tools = self.client.request("tools/list")["tools"]
        action = next(t for t in tools if t["name"] == "settings.import")
        uri = action["_meta"]["ui"]["resourceUri"]
        content = self.client.request("resources/read", {"uri": uri})["contents"][0]
        self.assertEqual(content["mimeType"], "text/html;profile=mcp-app")
        self.assertIn('type="file"', content["text"])

    def test_managed_connections_can_open_before_settings_or_dependencies(self):
        for component in ("code-index", "bsl-ls", "edt", "v8std"):
            with McpClient([sys.executable, "-S", str(ROOT / "scripts/lazy_mcp.py"),
                            "--component", component], ROOT, self.env) as managed:
                managed.initialize()
                tools = managed.request("tools/list")["tools"]
                self.assertEqual(tools[0]["name"], "core_runtime_status")
        self.assertFalse(self.state.exists())

    def test_import_export_roundtrip_through_ui_tools(self):
        preview = self.preview()
        self.assertFalse(preview["replacesProfile"])
        self.assertFalse((self.project / ".ai").exists())
        imported = self.apply()
        self.assertEqual(imported["status"], "imported")
        self.assertEqual(load(self.project / ".ai/project.yaml"), self.profile)
        read = self.call("settings.read")["structuredContent"]
        self.assertEqual(Path(read["values"]["projectRoot"]), self.project)
        exported = self.call("settings.export_data")["_meta"]["data"]
        bundle = json.loads(exported["text"])
        self.assertEqual(bundle["profile"], self.profile)
        self.assertEqual(bundle["format"], "1c-ai-core-settings")

    def test_replace_requires_confirmation_and_preserves_backup(self):
        self.apply()
        changed = copy.deepcopy(self.profile)
        changed["project"]["purpose"] = "Изменённое назначение"
        with self.assertRaisesRegex(RuntimeError, "Подтвердите"):
            self.apply(changed)
        self.assertEqual(load(self.project / ".ai/project.yaml"), self.profile)
        imported = self.apply(changed, replace=True)
        self.assertTrue(Path(imported["backup"]).exists())
        self.assertEqual(load(Path(imported["backup"])), self.profile)

    def test_preview_cannot_be_reused_for_a_different_payload(self):
        preview = self.preview()
        changed = copy.deepcopy(self.profile)
        changed["project"]["purpose"] = "unexpected"
        with self.assertRaisesRegex(RuntimeError, "после предпросмотра"):
            self.call("settings.apply", text=json.dumps(changed),
                      projectRoot=str(self.project), revision=preview["revision"])
        self.assertFalse((self.project / ".ai/project.yaml").exists())

    def test_changed_instance_after_preview_requires_a_new_preview(self):
        self.apply()
        before = (self.project / ".ai/project.yaml").read_bytes()
        preview = self.preview()
        self.call("settings.update", set={"edtUrl": "http://127.0.0.1:18768/mcp"})
        with self.assertRaisesRegex(RuntimeError, "после предпросмотра"):
            self.call("settings.apply", text=json.dumps(self.profile), projectRoot=str(self.project),
                      revision=preview["revision"], replace=True)
        self.assertEqual((self.project / ".ai/project.yaml").read_bytes(), before)
        self.assertEqual(list((self.project / ".ai").glob("*.bak.yaml")), [])

    def test_invalid_import_never_writes_and_unknown_fields_rejected(self):
        bad = copy.deepcopy(self.profile)
        bad["repositories"][0]["path"] = "../outside"
        with self.assertRaises(RuntimeError):
            self.preview(bad)
        with self.assertRaises(RuntimeError):
            self.call("settings.update", set={"unexpected": "value"})
        with self.assertRaises(RuntimeError):
            self.call("settings.update", set={"openvikingEnabled": "false"})
        self.assertFalse((self.state / "settings.json").exists())

    def test_import_bundle_updates_native_connection_settings(self):
        bundle = {"format": "1c-ai-core-settings", "version": 1,
                  "settings": {"mcp": {"required": {
                      "edt": {"url": "http://127.0.0.1:8765/mcp"},
                      "v8std": {"url": "http://127.0.0.1:8000/mcp"}}}},
                  "profile": self.profile}
        self.apply(bundle)
        read = self.call("settings.read")["structuredContent"]
        self.assertEqual(read["values"]["edtUrl"], "http://127.0.0.1:8765/mcp")
        self.assertFalse(read["values"]["openvikingEnabled"])

    def test_removed_repository_selection_cannot_be_imported(self):
        bundle = {"format": "1c-ai-core-settings", "version": 1,
                  "settings": {"selected_repository": "product"}, "profile": self.profile}
        with self.assertRaisesRegex(RuntimeError, "Недопустимые поля"):
            self.preview(bundle)

    def test_typed_contract_rejections_preserve_active_profile_and_settings(self):
        self.apply()
        target = self.project / ".ai/project.yaml"
        before_profile = target.read_bytes()
        before_settings = (self.state / "settings.json").read_bytes()
        revision = self.preview()["revision"]
        cases = []
        bad = copy.deepcopy(self.profile); bad["testing"]["yaxunit"] = "false"; cases.append(bad)
        bad = copy.deepcopy(self.profile); bad["testing"].update(vanessa=True); cases.append(bad)
        bad = copy.deepcopy(self.profile); bad["policy"]["require_explicit_confirmation"] = []; cases.append(bad)
        bad = copy.deepcopy(self.profile); bad["knowledge"]["manifest"] = "../outside.json"; cases.append(bad)
        bad = copy.deepcopy(self.profile); bad["testing"]["commands"] = [
            {"id": "unit", "repository_id": "missing", "argv": ["python"], "effects": []}]; cases.append(bad)
        for bad in cases:
            with self.subTest(bad=bad):
                with self.assertRaises(RuntimeError):
                    self.preview(bad)
                # An apply call cannot bypass the same validation with an old preview.
                with self.assertRaises(RuntimeError):
                    self.call("settings.apply", text=json.dumps(bad), projectRoot=str(self.project),
                              revision=revision, replace=True)
                self.assertEqual(target.read_bytes(), before_profile)
                self.assertEqual((self.state / "settings.json").read_bytes(), before_settings)
                self.assertEqual(list(target.parent.glob("*.bak.yaml")), [])

    def test_url_update_changes_only_the_selected_instance_override(self):
        self.profile["connections"] = {"edt": {"url": "http://127.0.0.1:18760/mcp"}}
        self.apply()
        target = self.project / ".ai/project.yaml"; before = target.read_bytes()
        first_url, second_url = "http://127.0.0.1:18761/mcp", "http://127.0.0.1:18762/mcp"
        self.call("settings.update", set={"edtUrl": first_url})
        with McpClient(["node", str(ROOT / "mcp/settings.mjs")], self.project,
                       {**self.env, "EDT_AI_INSTANCE": "second", "EDT_AI_PROJECT_ROOT": str(self.project)}, timeout=30) as other:
            other.initialize()
            other.call("settings.update", {"set": {"edtUrl": second_url}})
            self.assertEqual(other.call("settings.read", {})["structuredContent"]["values"]["edtUrl"], second_url)
            self.assertEqual(self.call("settings.read")["structuredContent"]["values"]["edtUrl"], first_url)
        self.assertEqual(target.read_bytes(), before)
        portable = json.loads(self.call("settings.export_data")["_meta"]["data"]["text"])
        self.assertEqual(portable["profile"], self.profile)
        self.assertNotIn(first_url, json.dumps(portable))
        self.assertNotIn(second_url, json.dumps(portable))

    def test_selected_project_does_not_inherit_another_projects_legacy_edt_url(self):
        self.apply()
        second = self.base / "another-project"; second.mkdir()
        dump(self.profile, second / ".ai/project.yaml")
        config = load(self.state / "settings.json")
        config["active_project"] = str(self.project)
        config["mcp"]["required"]["edt"]["url"] = "http://127.0.0.1:18769/mcp"
        dump(config, self.state / "settings.json")
        with McpClient(["node", str(ROOT / "mcp/settings.mjs")], second,
                       {**self.env, "EDT_AI_PROJECT_ROOT": str(second)}, timeout=30) as client:
            client.initialize()
            values = client.call("settings.read", {})["structuredContent"]["values"]
            self.assertEqual(values["edtUrl"], "")

    def test_settings_uses_host_directory_and_rejects_ambiguous_roots(self):
        self.apply()
        second = self.base / "second"; second.mkdir()
        profile = copy.deepcopy(self.profile)
        profile["connections"] = {"edt": {"url": "http://127.0.0.1:18763/mcp"}}
        dump(profile, second / ".ai/project.yaml")
        with ControlledRoots(["node", str(ROOT / "mcp/settings.mjs")], self.project, self.env, timeout=30) as client:
            client.supplied_roots = [second]
            client.initialize()
            values = client.call("settings.read", {})["structuredContent"]["values"]
            self.assertEqual(Path(values["projectRoot"]), second)
            self.assertEqual(values["edtUrl"], "http://127.0.0.1:18763/mcp")
            client.call("settings.update", {"set": {"edtUrl": "http://127.0.0.1:18764/mcp"}})
            snapshots = {path: path.read_bytes() for path in self.state.glob("projects/*/instances/*.yaml")}
            third = self.base / "third"; third.mkdir()
            client.supplied_roots = [second, third]
            client.send({"method": "notifications/roots/list_changed"})
            with self.assertRaisesRegex(RuntimeError, "каталог"):
                client.call("settings.update", {"set": {"edtUrl": "http://127.0.0.1:18765/mcp"}})
            self.assertEqual({path: path.read_bytes() for path in self.state.glob("projects/*/instances/*.yaml")}, snapshots)

    def test_import_cannot_switch_host_directory_through_embedded_settings(self):
        self.apply()
        other = self.base / "other"; other.mkdir()
        bundle = {"format": "1c-ai-core-settings", "version": 1,
                  "settings": {"active_project": str(other)}, "profile": self.profile}
        before = (self.state / "settings.json").read_bytes()
        with ControlledRoots(["node", str(ROOT / "mcp/settings.mjs")], ROOT, self.env, timeout=30) as client:
            client.supplied_roots = [self.project]
            client.initialize()
            with self.assertRaisesRegex(RuntimeError, "другому каталогу"):
                client.call("settings.preview", {"text": json.dumps(bundle)})
            with self.assertRaisesRegex(RuntimeError, "другому каталогу"):
                client.call("settings.apply", {"text": json.dumps(bundle), "revision": "unused"})
        self.assertFalse((other / ".ai/project.yaml").exists())
        self.assertEqual((self.state / "settings.json").read_bytes(), before)

    def test_subdirectory_uses_one_root_for_read_import_and_export(self):
        self.profile["connections"] = {"edt": {"url": "http://127.0.0.1:18766/mcp"}}
        self.apply()
        sub = self.project / "docs"; sub.mkdir()
        env = {**self.env, "EDT_AI_PROJECT_ROOT": str(sub)}
        with McpClient(["node", str(ROOT / "mcp/settings.mjs")], ROOT, env, timeout=30) as client:
            client.initialize()
            shown = client.call("settings.read", {})["structuredContent"]["values"]
            self.assertEqual(Path(shown["projectRoot"]), self.project)
            exported = json.loads(client.call("settings.export_data", {})["_meta"]["data"]["text"])
            self.assertEqual(exported["profile"], self.profile)
            changed = copy.deepcopy(self.profile); changed["project"]["purpose"] = "subdirectory import"
            request = {"text": json.dumps(changed), "projectRoot": shown["projectRoot"]}
            preview = client.call("settings.preview", request)["structuredContent"]
            self.assertTrue(preview["edtConfigured"])
            client.call("settings.apply", {**request, "revision": preview["revision"], "replace": True})
            self.assertEqual(load(self.project / ".ai/project.yaml"), changed)
            self.assertFalse((sub / ".ai").exists())
        # A nested Git root must not be normalized to its parent's profile.
        (sub / ".git").mkdir()
        with McpClient(["node", str(ROOT / "mcp/settings.mjs")], ROOT, env, timeout=30) as client:
            client.initialize()
            with self.assertRaisesRegex(RuntimeError, "другому каталогу"):
                client.call("settings.preview", {"text": json.dumps(self.profile), "projectRoot": str(self.project)})

    def test_workspace_choice_is_not_a_persistent_setting(self):
        self.apply()
        values = self.call("settings.read")["structuredContent"]["values"]
        self.assertNotIn("repository", values)
        before = (self.state / "settings.json").read_bytes()
        with self.assertRaises(RuntimeError):
            self.call("settings.update", set={"repository": "product"})
        self.assertEqual((self.state / "settings.json").read_bytes(), before)

    def test_legacy_yaml_settings_use_the_shared_backend_reader(self):
        config = self.state / "legacy.yaml"
        dump({"active_project": str(self.project), "mcp": {"required": {
            "edt": {"url": "http://127.0.0.1:18767/mcp"}}}}, config)
        with McpClient(["node", str(ROOT / "mcp/settings.mjs")], ROOT,
                       {**self.env, "EDT_AI_SETTINGS": str(config), "EDT_AI_PROJECT_ROOT": str(self.project)}, timeout=30) as client:
            client.initialize()
            self.assertEqual(client.call("settings.read", {})["structuredContent"]["values"]["edtUrl"],
                             "http://127.0.0.1:18767/mcp")

    def test_empty_roots_does_not_borrow_the_last_projects_settings(self):
        self.apply()
        stored = load(self.state / "settings.json")
        stored["active_project"] = str(self.project)
        stored["mcp"]["required"]["edt"]["url"] = "http://127.0.0.1:19801/mcp"
        dump(stored, self.state / "settings.json")
        before = (self.state / "settings.json").read_bytes()
        with ControlledRoots(["node", str(ROOT / "mcp/settings.mjs")], ROOT, self.env, timeout=30) as client:
            client.supplied_roots = []
            client.initialize()
            read = client.call("settings.read", {})["structuredContent"]
            self.assertEqual(read["projectSelection"]["status"], "unselected")
            self.assertEqual(read["values"]["projectRoot"], "")
            self.assertEqual(read["values"]["edtUrl"], "")
            self.assertFalse(read["schema"]["properties"]["projectRoot"].get("readOnly", False))
            with self.assertRaisesRegex(RuntimeError, "выберите папку"):
                client.call("settings.update", {"set": {"edtUrl": "http://127.0.0.1:19802/mcp"}})
            self.assertEqual((self.state / "settings.json").read_bytes(), before)
            another = self.base / "unconfigured"; another.mkdir()
            client.call("settings.update", {"set": {"projectRoot": str(another), "edtUrl": "http://127.0.0.1:19803/mcp"}})
            self.assertEqual(client.call("settings.read", {})["structuredContent"]["values"]["edtUrl"], "http://127.0.0.1:19803/mcp")
            self.assertEqual(load(self.state / "settings.json")["active_project"], str(self.project))
            client.send({"method": "notifications/roots/list_changed"})
            read = client.call("settings.read", {})["structuredContent"]
            self.assertEqual(read["values"]["projectRoot"], "")

    def test_unconfigured_instances_keep_urls_after_profile_import(self):
        first = {**self.env, "EDT_AI_PROJECT_ROOT": str(self.project)}
        with McpClient(["node", str(ROOT / "mcp/settings.mjs")], ROOT, first, timeout=30) as a, \
             McpClient(["node", str(ROOT / "mcp/settings.mjs")], ROOT, {**first, "EDT_AI_INSTANCE": "second"}, timeout=30) as b:
            a.initialize(); b.initialize()
            a.call("settings.update", {"set": {"edtUrl": "http://127.0.0.1:19811/mcp"}})
            b.call("settings.update", {"set": {"edtUrl": "http://127.0.0.1:19812/mcp"}})
            self.assertFalse((self.project / ".ai/project.yaml").exists())
            self.assertFalse((self.state / "settings.json").exists())
            self.assertEqual(a.call("settings.read", {})["structuredContent"]["values"]["edtUrl"], "http://127.0.0.1:19811/mcp")
            self.assertEqual(b.call("settings.read", {})["structuredContent"]["values"]["edtUrl"], "http://127.0.0.1:19812/mcp")
            self.apply()
            self.assertEqual(a.call("settings.read", {})["structuredContent"]["values"]["edtUrl"], "http://127.0.0.1:19811/mcp")
            self.assertEqual(b.call("settings.read", {})["structuredContent"]["values"]["edtUrl"], "http://127.0.0.1:19812/mcp")

    def test_legacy_bundle_urls_are_imported_only_into_the_selected_instance(self):
        self.apply()
        self.call("settings.update", set={"edtUrl": "http://127.0.0.1:19821/mcp"})
        config_before = (self.state / "settings.json").read_bytes()
        bundle = {"format": "1c-ai-core-settings", "version": 1,
                  "settings": {"mcp": {"required": {"edt": {"url": "http://127.0.0.1:19822/mcp"}}}}}
        with McpClient(["node", str(ROOT / "mcp/settings.mjs")], ROOT,
                       {**self.env, "EDT_AI_PROJECT_ROOT": str(self.project), "EDT_AI_INSTANCE": "second"}, timeout=30) as other:
            other.initialize()
            request = {"text": json.dumps(bundle)}
            preview = other.call("settings.preview", request)["structuredContent"]
            self.assertTrue(preview["writesInstanceConnections"])
            other.call("settings.apply", {**request, "revision": preview["revision"]})
            self.assertEqual(other.call("settings.read", {})["structuredContent"]["values"]["edtUrl"], "http://127.0.0.1:19822/mcp")
        self.assertEqual(self.call("settings.read")["structuredContent"]["values"]["edtUrl"], "http://127.0.0.1:19821/mcp")
        self.assertEqual((self.state / "settings.json").read_bytes(), config_before)

    def test_empty_override_explicitly_disconnects_and_environment_is_disclosed(self):
        self.profile["connections"] = {"edt": {"url": "http://127.0.0.1:19831/mcp"}}
        self.apply()
        self.call("settings.update", set={"edtUrl": ""})
        self.assertEqual(self.call("settings.read")["structuredContent"]["values"]["edtUrl"], "")
        with McpClient(["node", str(ROOT / "mcp/settings.mjs")], ROOT,
                       {**self.env, "EDT_AI_PROJECT_ROOT": str(self.project), "EDT_AI_EDT_URL": "http://127.0.0.1:19832/mcp"}, timeout=30) as client:
            client.initialize()
            read = client.call("settings.read", {})["structuredContent"]
            self.assertEqual(read["values"]["edtUrl"], "http://127.0.0.1:19832/mcp")
            self.assertEqual(read["connectionSources"]["edt"], "environment:EDT_AI_EDT_URL")
            self.assertTrue(read["schema"]["properties"]["edtUrl"]["readOnly"])

    def test_portable_roundtrip_preserves_profile_defaults_without_disconnecting_them(self):
        self.profile["connections"] = {"edt": {"url": "http://127.0.0.1:19861/mcp"},
                                       "v8std": {"url": "http://127.0.0.1:19862/mcp"}}
        self.apply()
        self.call("settings.update", set={"edtUrl": "http://127.0.0.1:19863/mcp"})
        exported = json.loads(self.call("settings.export_data")["_meta"]["data"]["text"])
        self.assertNotIn("active_project", exported["settings"])
        self.assertNotIn("required", exported["settings"]["mcp"])
        self.assertNotIn("19863", json.dumps(exported))
        other = self.base / "portable-copy"; other.mkdir()
        with McpClient(["node", str(ROOT / "mcp/settings.mjs")], ROOT,
                       {**self.env, "EDT_AI_PROJECT_ROOT": str(other)}, timeout=30) as client:
            client.initialize()
            # Also accept an old export with empty global fallback URLs.
            exported["settings"]["mcp"]["required"] = {"edt": {"url": ""}, "v8std": {"url": ""}}
            request = {"text": json.dumps(exported)}
            preview = client.call("settings.preview", request)["structuredContent"]
            self.assertEqual(preview["connectionUrls"]["edt"], "http://127.0.0.1:19861/mcp")
            client.call("settings.apply", {**request, "revision": preview["revision"]})
            read = client.call("settings.read", {})["structuredContent"]["values"]
            self.assertEqual(read["edtUrl"], "http://127.0.0.1:19861/mcp")
            self.assertEqual(read["v8stdUrl"], "http://127.0.0.1:19862/mcp")

    def test_git_root_binding_survives_initialization_from_a_subdirectory(self):
        (self.project / ".git").mkdir()
        sub = self.project / "docs"; sub.mkdir()
        with McpClient(["node", str(ROOT / "mcp/settings.mjs")], ROOT,
                       {**self.env, "EDT_AI_PROJECT_ROOT": str(sub)}, timeout=30) as client:
            client.initialize()
            client.call("settings.update", {"set": {"edtUrl": "http://127.0.0.1:19841/mcp"}})
            read = client.call("settings.read", {})["structuredContent"]
            self.assertEqual(Path(read["values"]["projectRoot"]), self.project)
            self.assertEqual(read["preparationScope"], f"{self.project}#first")
            request = {"text": json.dumps(self.profile)}
            preview = client.call("settings.preview", request)["structuredContent"]
            client.call("settings.apply", {**request, "revision": preview["revision"]})
            self.assertTrue((self.project / ".ai/project.yaml").exists())
            self.assertFalse((sub / ".ai").exists())
            self.assertEqual(client.call("settings.read", {})["structuredContent"]["values"]["edtUrl"], "http://127.0.0.1:19841/mcp")


if __name__ == "__main__":
    unittest.main()

