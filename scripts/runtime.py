#!/usr/bin/env python3
"""Manage plugin-owned runtimes; user-owned EDT/v8std are URL connections only."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import tempfile
import time
import urllib.request
import zipfile

from common import ROOT, ConfigError, atomic_write, cli, inside, operation_lock, settings, state_path
from profile import project_profile

SPECS = {
    "code-index": ("Regsorm/code-index-mcp", r"^bsl-indexer-windows-x64\.zip$", "bsl-indexer.exe"),
    "bsl-ls": ("1c-syntax/bsl-language-server", r"^bsl-language-server-.*-exec\.jar$", "bsl-language-server-exec.jar"),
}


def read_json(path, default=None):
    return json.loads(Path(path).read_text(encoding="utf-8")) if Path(path).is_file() else default


def save_json(path, value):
    atomic_write(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def fetch_json(url):
    request = urllib.request.Request(url, headers={"User-Agent": "1c-ai-core/0.1.0"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024*1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def artifact(state, component):
    lock = read_json(state / "runtime-lock.json", {})
    entry = lock.get(component)
    if not entry:
        return None
    if not isinstance(entry, dict) or not re.fullmatch(r"v?\d+\.\d+\.\d+", str(entry.get("release", ""))):
        raise ConfigError("Invalid runtime-lock entry")
    target = state / "runtime" / component / entry["release"] / SPECS[component][2]
    if not target.is_file() or sha(target) != entry["sha256"]:
        return None
    return target


def ensure_installed(state, config, component, refresh=False):
    existing = artifact(state, component)
    requested = config["mcp"]["managed"][component]["version"]
    current = read_json(state / "runtime-lock.json", {}).get(component, {})
    if existing and not refresh and (requested == "latest" or requested.lstrip("v") == current["release"].lstrip("v")):
        return existing
    if component == "code-index" and (os.name != "nt" or platform.machine().lower() not in ("amd64", "x86_64")):
        raise ConfigError("This prototype supports code-index on Windows x64")
    repo, pattern, executable = SPECS[component]
    release_url = "latest" if requested == "latest" else "tags/" + ("v" + requested.lstrip("v"))
    release = fetch_json(f"https://api.github.com/repos/{repo}/releases/{release_url}")
    if release.get("draft") or release.get("prerelease"):
        raise ConfigError("Only stable releases are supported")
    version = release["tag_name"]
    if not re.fullmatch(r"v?\d+\.\d+\.\d+", version):
        raise ConfigError(f"Unsupported release tag: {version}")
    if existing and current.get("release") == version:
        return existing
    candidates = [a for a in release["assets"] if re.fullmatch(pattern, a["name"])]
    if len(candidates) != 1:
        raise ConfigError(f"Expected one artifact for {component}, got {len(candidates)}")
    asset = candidates[0]
    digest = asset.get("digest") or ""
    if not re.fullmatch("sha256:[0-9a-f]{64}", digest):
        raise ConfigError(f"Release {version} does not publish an SHA-256 asset digest")
    target = state / "runtime" / component / version / executable
    print(f"Installing {component} {version}: {asset['size']} bytes", file=__import__("sys").stderr, flush=True)
    state.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="download-", dir=state) as tmp:
        download = Path(tmp) / "artifact"
        request = urllib.request.Request(asset["browser_download_url"], headers={"User-Agent": "1c-ai-core/0.1.0"})
        with urllib.request.urlopen(request, timeout=60) as src, download.open("wb") as dst:
            shutil.copyfileobj(src, dst, length=1024*1024)
        if download.stat().st_size != asset["size"] or sha(download) != digest[7:]:
            raise ConfigError(f"Artifact size or SHA-256 mismatch: {component}")
        staged = Path(tmp) / executable
        if component == "code-index":
            # Read one known file, never extract an arbitrary archive tree.
            with zipfile.ZipFile(download) as archive:
                matches = [n for n in archive.namelist() if n.replace("\\", "/").split("/")[-1] == executable]
                if len(matches) != 1:
                    raise ConfigError("Archive must contain exactly one bsl-indexer.exe")
                with archive.open(matches[0]) as src, staged.open("wb") as dst:
                    shutil.copyfileobj(src, dst)
        else:
            shutil.copy2(download, staged)
            if not zipfile.is_zipfile(staged):
                raise ConfigError("BSL LS artifact is not a JAR")
        target.parent.mkdir(parents=True, exist_ok=True)
        os.replace(staged, target)
    entry = {"release": version, "path": str(target.relative_to(state)),
             "sha256": sha(target), "asset_sha256": digest[7:],
             "source": asset["browser_download_url"], "bytes": asset["size"]}
    lock = read_json(state / "runtime-lock.json", {})
    lock[component] = entry
    save_json(state / "runtime-lock.json", lock)
    return target


def project(root, config):
    selected = root or os.environ.get("EDT_AI_PROJECT_ROOT") or config.get("active_project")
    if not selected:
        raise ConfigError("Set --project-root, EDT_AI_PROJECT_ROOT, or active_project in plugin settings")
    from project_context import locate_project
    root = locate_project(selected)
    data = project_profile(root)
    if not data["repositories"]:
        raise ConfigError("Configure explicit repositories (id, relative path, alias) in the project profile")
    for repo in data["repositories"]:
        if not inside(root, repo["path"]).is_dir():
            raise ConfigError(f"Repository directory does not exist: {repo['path']}")
    return root, data


def project_home(state, root):
    return state / "projects" / hashlib.sha256(path_key(root).casefold().encode()).hexdigest()[:16]


def path_key(path):
    value = str(Path(path).resolve())
    # Rust canonicalize reports Windows verbatim paths; profiles usually do not.
    if os.name == "nt":
        if value.startswith("\\\\?\\UNC\\"):
            value = "\\\\" + value[8:]
        elif value.startswith("\\\\?\\"):
            value = value[4:]
    return os.path.normcase(value)


def installed_runtime(state, config, component):
    # Artifact metadata is shared; project startup must not hold this lock.
    with operation_lock(state, timeout=120):
        return ensure_installed(state, config, component)


def index_config(home, root, data):
    text = "[daemon]\nhttp_port = 0\nmax_concurrent_initial = 1\n"
    for repo in data["repositories"]:
        text += "\n[[paths]]\n" + "alias = " + json.dumps(repo["alias"]) + "\n"
        text += "path = " + json.dumps(inside(root, repo["path"]).as_posix(), ensure_ascii=False) + "\nlanguage = \"bsl\"\n"
    path = home / "daemon.toml"
    if path.exists() and path.read_text(encoding="utf-8") == text:
        return
    if path.exists() and path.read_text(encoding="utf-8") != text:
        if daemon_health(home):
            raise ConfigError("Repository mapping changed: stop this project's daemon before applying it")
    atomic_write(path, text)


def daemon_health(home):
    info = read_json(home / "daemon.json", {})
    port = info.get("http_port")
    if not isinstance(port, int):
        return None
    try:
        response = fetch_json(f"http://127.0.0.1:{port}/health")
        if response.get("pid") == info.get("pid") and response.get("status") == "running":
            return response
    except OSError:
        pass
    return None


def ensure_daemon(state, root, data, exe):
    home = project_home(state, root) / "code-index"
    home.mkdir(parents=True, exist_ok=True)
    # One daemon per selected profile root, shared by its reader sessions.
    # Never stop another session's daemon on disconnect or a roots change.
    with operation_lock(home, timeout=45):
        return start_daemon(home, root, data, exe)


def start_daemon(home, root, data, exe):
    index_config(home, root, data)
    health = daemon_health(home)
    if health:
        owner = read_json(home / "owner.json", {})
        if owner.get("executable") != str(exe):
            raise ConfigError("The project daemon runs a different runtime; stop it before changing versions")
        if not owner.get("project_root") or path_key(owner["project_root"]) != path_key(root) or owner.get("pid") != health.get("pid"):
            raise ConfigError("Project daemon ownership mismatch; refusing to reuse it")
        expected = {path_key(inside(root, repo["path"])) for repo in data["repositories"]}
        actual = {path_key(item["path"]) for item in health.get("paths", []) if isinstance(item, dict) and item.get("path")}
        if expected != actual:
            raise ConfigError("Project daemon repository paths do not match the selected profile")
        return home
    stale = read_json(home / "daemon.json", {})
    if stale.get("pid"):
        # Never start a competing daemon while a previous process might be alive.
        if os.name == "nt":
            import ctypes
            handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, stale["pid"])
            if handle:
                ctypes.windll.kernel32.CloseHandle(handle)
                raise ConfigError("Existing project daemon is alive but unhealthy; inspect its logs before restart")
    env = {**os.environ, "CODE_INDEX_HOME": str(home), "CODE_INDEX_DAEMON_DETACHED": "1"}
    with (home / "stdout.log").open("ab") as out, (home / "stderr.log").open("ab") as err:
        proc = subprocess.Popen([str(exe), "daemon", "run"], cwd=home, env=env,
                                stdin=subprocess.DEVNULL, stdout=out, stderr=err,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    # Keep ownership evidence even when readiness times out, for scoped recovery.
    save_json(home / "owner.json", {"pid": proc.pid, "executable": str(exe), "project_root": str(root)})
    deadline = time.monotonic() + 40
    while time.monotonic() < deadline:
        health = daemon_health(home)
        expected = {path_key(inside(root, repo["path"])) for repo in data["repositories"]}
        actual = {path_key(item["path"]) for item in (health or {}).get("paths", []) if isinstance(item, dict) and item.get("path")}
        if health and health.get("pid") == proc.pid and actual == expected:
            return home
        if proc.poll() is not None:
            raise ConfigError(f"code-index daemon exited ({proc.returncode}); see {home / 'stderr.log'}")
        time.sleep(.25)
    raise ConfigError(f"code-index startup timed out; inspect {home} before retrying")


def java_command(config):
    java = config["mcp"]["managed"]["bsl-ls"].get("java", "java")
    resolved = shutil.which(java)
    if not resolved:
        raise ConfigError("Java is required; set mcp.managed.bsl-ls.java in plugin settings")
    version = subprocess.run([resolved, "-version"], capture_output=True, text=True, timeout=20)
    match = re.search(r'version "(\d+)', version.stderr + version.stdout)
    if version.returncode or not match or int(match[1]) < 25:
        raise ConfigError("BSL LS requires Java 25 or newer")
    return resolved


def launch_command(state, config, component, root, data):
    if component == "code-index":
        exe = installed_runtime(state, config, component)
        home = ensure_daemon(state, root, data, exe)
        return [str(exe), "serve", "--config", str(home / "daemon.toml")], home, {**os.environ, "CODE_INDEX_HOME": str(home)}
    root = Path(root).resolve()
    bsl = config["mcp"]["managed"]["bsl-ls"]
    node = shutil.which(bsl.get("node", "node"))
    if not node:
        raise ConfigError("Node.js 18+ is required for the scoped BSL LS MCP adapter")
    configuration = bsl.get("configuration")
    if configuration:
        configuration = str(inside(root, configuration)) if not Path(configuration).is_absolute() else configuration
        if not Path(configuration).is_file():
            raise ConfigError("Configured BSL LS configuration does not exist")
    java = java_command(config)
    exe = installed_runtime(state, config, component)
    command = [node, str(ROOT / "mcp" / "bsl-ls-proxy.mjs"), "--project-root", str(root),
               "--java", java, "--jar", str(exe)]
    if configuration:
        command += ["--configuration", str(Path(configuration).resolve())]
    return command, root, None


def validate_bsl_tools(tools):
    """Require the native multi-workspace API, never emulate an older server."""
    by_name = {tool["name"]: tool for tool in tools}
    required = {"register_workspace_folder", "list_workspace_folders", "unregister_workspace_folder"}
    missing = sorted(required - by_name.keys())
    for name in ("type_info", "global_member_info", "global_member_search"):
        schema = by_name.get(name, {}).get("inputSchema", {})
        if "workspaceFolder" not in schema.get("properties", {}) or "workspaceFolder" not in schema.get("required", []):
            missing.append(name + ".workspaceFolder")
    if missing:
        raise ConfigError("BSL LS lacks the native multi-workspace API: " + ", ".join(missing)
                          + ". Use a BSL LS artifact exposing workspace registration and workspaceFolder parameters.")


def smoke(state, config, root, data, component, timeout=90):
    from mcp_client import McpClient
    from mcp_pages import all_pages
    command, cwd, env = launch_command(state, config, component, root, data)
    with McpClient(command, cwd, env, timeout) as client:
        server = client.initialize()
        tools = all_pages(client, "tools/list", "tools")["tools"]
        if not tools:
            raise ConfigError(f"{component} exposes no MCP tools")
        if component == "bsl-ls":
            validate_bsl_tools(tools)
        result = {"component": component, "status": "mcp_ready",
                  "server": server.get("serverInfo"), "tools": [t["name"] for t in tools]}
        if component == "code-index":
            health = client.call("health", {})
            body = json.loads(next(part["text"] for part in health["content"] if part["type"] == "text"))
            result["index_ready"] = index_readiness(body, root, data)
            result["readiness_scope"] = "Reported repository paths and data freshness; check operation-specific coverage in each response"
        return result


def index_readiness(body, root, data):
    """Fail closed on missing freshness or an alias pointing at another root."""
    if not isinstance(body, dict) or not isinstance(body.get("mcp"), dict) or not isinstance(body.get("daemon"), dict):
        return False
    repos = body.get("repos")
    if not isinstance(repos, list) or len(repos) != len(data["repositories"]):
        return False
    expected = {repo["alias"]: path_key(inside(root, repo["path"])) for repo in data["repositories"]}
    seen = set()
    for repo in repos:
        if not isinstance(repo, dict):
            return False
        alias = repo.get("repo")
        status, version = repo.get("path_status"), repo.get("data_version")
        if (not isinstance(alias, str) or alias not in expected or alias in seen or
            not isinstance(repo.get("root_path"), str) or not repo["root_path"] or
            path_key(repo["root_path"]) != expected[alias] or
            not isinstance(status, dict) or status.get("status") != "ready" or status.get("error") or
            not isinstance(version, dict) or version.get("stale") is not False):
            return False
        if status.get("path") and path_key(status["path"]) != expected[alias]:
            return False
        seen.add(alias)
    return (seen == set(expected) and body.get("mcp", {}).get("status") == "ok" and
            body.get("daemon", {}).get("status") == "online")


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("action", choices=["install", "status", "start", "stop", "smoke", "config"])
    p.add_argument("component", nargs="?", choices=["code-index", "bsl-ls", "all"], default="all")
    p.add_argument("--state-dir", type=Path)
    p.add_argument("--settings", type=Path)
    p.add_argument("--project-root", type=Path)
    p.add_argument("--output", type=Path)
    p.add_argument("--refresh", action="store_true")
    a = p.parse_args()
    config = settings(a.settings)
    state = state_path(config, a.state_dir)
    components = list(SPECS) if a.component == "all" else [a.component]
    if a.action == "install":
        with operation_lock(state):
            result = {c: str(ensure_installed(state, config, c, a.refresh)) for c in components}
    elif a.action == "status":
        result = {"artifacts": {c: str(artifact(state, c)) if artifact(state, c) else None for c in components},
                  "runtime_lock": read_json(state / "runtime-lock.json", {})}
        if a.project_root:
            result["daemon"] = daemon_health(project_home(state, a.project_root.resolve()) / "code-index")
    else:
        root, data = project(a.project_root, config)
        from project_context import effective_settings
        config = effective_settings(config, root, data, state=state)
        if a.action == "smoke":
            result = [smoke(state, config, root, data, c) for c in components]
        elif a.action == "stop":
            if a.component == "bsl-ls":
                raise ConfigError("BSL LS is owned by its stdio client and stops on disconnect")
            home = project_home(state, root) / "code-index"
            with operation_lock(home, timeout=45):
                owner = read_json(home / "owner.json", {})
                health = daemon_health(home)
                if health and (health["pid"] != owner.get("pid") or
                               not owner.get("project_root") or path_key(owner["project_root"]) != path_key(root)):
                    raise ConfigError("Daemon ownership mismatch; refusing to stop it")
                if health:
                    stopped = subprocess.run([owner["executable"], "daemon", "stop"], cwd=home,
                        env={**os.environ, "CODE_INDEX_HOME": str(home)}, capture_output=True, timeout=20)
                    if stopped.returncode:
                        raise ConfigError(stopped.stderr.decode(errors="replace"))
                    for _ in range(40):
                        if not daemon_health(home):
                            break
                        time.sleep(.25)
                    else:
                        raise ConfigError("Daemon stop is not confirmed")
            result = {"status": "stopped", "project_root": str(root)}
        elif a.action == "start":
            if a.component == "all":
                raise ConfigError("Select a component; BSL LS runs in foreground stdio, code-index starts its daemon")
            if a.component == "bsl-ls":
                from managed_mcp import serve
                return serve(a.component, root, state, config)
            exe = installed_runtime(state, config, "code-index")
            home = ensure_daemon(state, root, data, exe)
            result = {"status": "running", "daemon": daemon_health(home)}
        else:
            if not a.output:
                raise ConfigError("config requires --output")
            from sys import executable
            from policy_runtime import binding as policy_binding
            servers = {"policy": policy_binding(config)}
            for c in SPECS:
                servers[c] = {"type": "stdio", "command": executable,
                    "args": [str(ROOT / "scripts" / "managed_mcp.py"), "--component", c,
                             "--project-root", str(root), "--state-dir", str(state),
                             * (["--settings", str(a.settings.resolve())] if a.settings else [])]}
            for c, item in config["mcp"]["required"].items():
                if not item["url"]:
                    raise ConfigError(f"Configure user-started MCP URL: {c}")
                servers[c] = {"type": "streamable-http", "url": item["url"]}
            save_json(a.output, {"$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", "mcpServers": servers})
            result = {"status": "written", "path": str(a.output.resolve())}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(cli(main))
    except RuntimeError as exc:
        print(json.dumps({"status": "error", "error": str(exc)}, ensure_ascii=False))
        raise SystemExit(1)

