"""Smoke-check the extracted plugin independently of the source checkout."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True


def check(root):
    root = root.resolve()
    manifest = json.loads((root / ".codex-plugin/plugin.json").read_text(encoding="utf-8"))
    universal = json.loads((root / "plugin.json").read_text(encoding="utf-8"))
    build = json.loads((root / "build-info.json").read_text(encoding="utf-8"))
    assert manifest["name"] == build["plugin"] == universal["name"] == "1c-ai-core"
    assert manifest["version"] == universal["version"] == build["version"]
    assert manifest["skills"] == "./skills/"
    assert manifest["mcpServers"] == "./mcp.json"
    assert manifest["hooks"] == "./hooks/hooks.json"
    assert (root / "LICENSE").read_text(encoding="utf-8").startswith("Mozilla Public License Version 2.0")
    assert "ShadobaAI" in (root / "NOTICE.md").read_text(encoding="utf-8")
    source_notice = (root / "SOURCE.md").read_text(encoding="utf-8")
    assert f"1C AI Core {build['version']}" in source_notice
    assert "https://github.com/ShadobaAI/edt-ai-core" in source_notice
    if build["revision"]:
        assert f"/tree/{build['revision']}" in source_notice
    assert len(list((root / "skills").glob("*/SKILL.md"))) >= 10
    for file in root.rglob("*"):
        assert not {"tests", "__pycache__", ".git", ".venv", "node_modules"}.intersection(file.relative_to(root).parts)
        assert file.name not in {"local.yaml", "runtime.local.json"}
    sys.path.insert(0, str(root / "scripts"))
    from common import load, validate_settings
    validate_settings(load(root / "settings/defaults.json"))
    from mcp_client import McpClient
    with tempfile.TemporaryDirectory(prefix="1c core outside checkout ") as directory:
        environment = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
        for entry in json.loads((root / "mcp.json").read_text(encoding="utf-8"))["mcpServers"].values():
            for arg in entry.get("args", []):
                if "${PLUGIN_ROOT}" in arg:
                    assert Path(arg.replace("${PLUGIN_ROOT}", str(root))).is_file()
        with McpClient(["node", str(root / "policy/read-only-mcp.mjs")], cwd=directory, env=environment) as client:
            client.initialize()
            assert client.request("tools/list")["tools"]
        result = subprocess.run(["node", str(root / "hooks/guard.mjs")], input=json.dumps({"cwd": directory}),
                                text=True, capture_output=True, check=True, cwd=directory, env=environment)
        assert json.loads(result.stdout) == {}
    print(f"Extracted plugin verified: {root}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    check(parser.parse_args().root)
