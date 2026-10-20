#!/usr/bin/env python3
"""Build a local Codex marketplace with a prepared Python and persistent settings."""
import argparse
import json
from pathlib import Path
import shutil
import sys

from common import ROOT, ConfigError, cli, deep_merge, load, validate_settings
from runtime import save_json


def build(destination, state, python, project_root=None, edt_url=None, v8std_url=None):
    destination = Path(destination).resolve()
    state = Path(state).resolve()
    python = Path(python).resolve()
    if not python.is_file():
        raise ConfigError(f"Prepared Python not found: {python}")
    if destination.exists():
        raise ConfigError("Build destination must be new")
    state.mkdir(parents=True, exist_ok=True)
    config_path = state / "settings.json"
    config = load(ROOT / "settings/defaults.json")
    previous = config_path if config_path.exists() else state / "settings.yaml"
    if previous.exists():
        config = deep_merge(config, load(previous))
    config["state_dir"] = str(state)
    if project_root:
        root = Path(project_root).resolve()
        if not root.is_dir():
            raise ConfigError("Project directory does not exist")
        config["active_project"] = str(root)
    for key, url in (("edt", edt_url), ("v8std", v8std_url)):
        if url is not None:
            config["mcp"]["required"][key]["url"] = url
    validate_settings(config)

    plugin = destination / "plugins/1c-ai-core"
    # Preserve the canonical servers (settings, lazy project bindings and policy).
    shutil.copytree(ROOT, plugin, ignore=shutil.ignore_patterns(
        "__pycache__", "*.pyc", "migration", "tests", "local.yaml", "runtime.local.json",
        ".git", ".github", ".agents", ".venv", ".work", ".build", "node_modules",
        "tools", "packaging", "examples", "AGENTS.md", ".gitignore", ".gitattributes"))
    # Hooks run in the host environment, outside the MCP servers' env blocks.
    save_json(plugin / "hooks/runtime.local.json", {"python": str(python),
              "state": str(state), "settings": str(config_path)})
    mcp = json.loads((plugin / "mcp.json").read_text(encoding="utf-8"))
    from policy_runtime import binding as policy_binding
    mcp["mcpServers"]["policy"] = policy_binding(config, plugin)
    for name, entry in mcp["mcpServers"].items():
        if entry.get("command") == "python":
            entry["command"] = str(python)
        if name != "policy":
            entry["env"] = {**entry.get("env", {}), "EDT_AI_SETTINGS": str(config_path),
                            "EDT_AI_STATE_DIR": str(state), "EDT_AI_PYTHON": str(python)}
    save_json(plugin / "mcp.json", mcp)
    manifest = json.loads((plugin / "plugin.json").read_text(encoding="utf-8"))
    save_json(plugin / "plugin.json", manifest)
    save_json(destination / ".agents/plugins/marketplace.json", {
        "name": "edt-ai-local",
        "interface": {"displayName": "EDT AI Local"},
        "plugins": [{
            "name": "1c-ai-core", "source": {"source": "local", "path": "./plugins/1c-ai-core"},
            "policy": {"installation": "AVAILABLE", "authentication": "ON_INSTALL"},
            "category": "Developer tools"
        }]})
    save_json(config_path, config)
    return {"marketplace": str(destination), "settings": str(config_path),
            "plugin_id": "1c-ai-core@edt-ai-local", "python": str(python)}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--destination", type=Path, required=True)
    p.add_argument("--state-dir", type=Path, required=True)
    p.add_argument("--python", type=Path, default=Path(sys.executable))
    p.add_argument("--project-root", type=Path)
    p.add_argument("--edt-url")
    p.add_argument("--v8std-url")
    a = p.parse_args()
    print(json.dumps(build(a.destination, a.state_dir, a.python, a.project_root,
                           a.edt_url, a.v8std_url), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(cli(main))

