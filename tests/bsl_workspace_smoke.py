"""Opt-in native BSL LS acceptance on synthetic files; never installs components."""
import argparse
import json
from pathlib import Path
import shutil
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from common import ROOT
from mcp_client import McpClient
from mcp_pages import all_pages
from runtime import validate_bsl_tools


def body(result):
    if isinstance(result.get("structuredContent"), dict):
        return result["structuredContent"]
    return json.loads(next(part["text"] for part in result["content"] if part["type"] == "text"))


def run(jar, java, node):
    with tempfile.TemporaryDirectory(prefix="bsl-native-") as temporary:
        base = Path(temporary)
        first, second = base / "Проект первый", base / "Проект второй"
        a, b, other = first / "Конфигурация А", first / "Конфигурация Б", second / "Другая"
        for folder, mode in ((a, "on"), (b, "off"), (other, "on")):
            folder.mkdir(parents=True)
            (folder / ".bsl-language-server.json").write_text(
                json.dumps({"diagnostics": {"mode": mode}}), encoding="utf-8")
            (folder / "Модуль.bsl").write_text("Процедура Ошибка(\n", encoding="utf-8")
        def connect(root, configuration=None):
            command = [node, str(ROOT / "mcp/bsl-ls-proxy.mjs"), "--project-root", str(root),
                       "--java", java, "--jar", str(jar)]
            if configuration:
                command += ["--configuration", str(configuration)]
            client = McpClient(command, root, timeout=90)
            try:
                client.initialize()
                validate_bsl_tools(all_pages(client, "tools/list", "tools")["tools"])
                return client
            except Exception:
                client.close()
                raise
        with connect(first) as one, connect(second) as two:
            uri_a = body(one.call("register_workspace_folder", {"path": str(a)}))["workspaceFolder"]["uri"]
            uri_b = body(one.call("register_workspace_folder", {"path": b.as_uri()}))["workspaceFolder"]["uri"]
            two.call("register_workspace_folder", {"path": str(other)})
            assert len(body(one.call("list_workspace_folders", {}))["workspaceFolders"]) == 2
            assert len(body(two.call("list_workspace_folders", {}))["workspaceFolders"]) == 1
            assert body(one.call("register_workspace_folder", {"path": str(a)}))["alreadyRegistered"]
            for folder, uri, enabled in ((a, uri_a, True), (b, uri_b, False), (a, uri_a, True)):
                diagnostics = body(one.call("analyze_file", {"file": (folder / "Модуль.bsl").as_uri()}))
                assert bool(diagnostics["diagnosticsCount"]) == enabled, diagnostics
                one.call("type_info", {"workspaceFolder": uri, "typeName": "Массив", "fileType": "BSL"})
            one.call("unregister_workspace_folder", {"workspaceFolder": uri_a})
            assert len(body(one.call("list_workspace_folders", {}))["workspaceFolders"]) == 1
            assert len(body(two.call("list_workspace_folders", {}))["workspaceFolders"]) == 1
            one.close()
            two.call("document_symbols", {"file": str(other / "Модуль.bsl")})
        explicit = first / "bsl-language-server.json"
        explicit.write_text('{"diagnostics":{"mode":"off"}}', encoding="utf-8")
        with connect(first, explicit) as client:
            client.call("register_workspace_folder", {"path": str(a)})
            assert body(client.call("analyze_file", {"file": str(a / "Модуль.bsl")}))["diagnosticsCount"] == 0
        return {"status": "passed", "scope": "native_registration_switching_unicode_workspace_and_explicit_configuration_parallel_sessions"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jar", type=Path, required=True)
    parser.add_argument("--java", default=shutil.which("java"))
    parser.add_argument("--node", default=shutil.which("node"))
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        report = run(args.jar.resolve(), args.java, args.node)
    except Exception as error:
        report = {"status": "failed", "detail": str(error)}
    if args.output:
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    raise SystemExit(0 if report["status"] == "passed" else 1)
