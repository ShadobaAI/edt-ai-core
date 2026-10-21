#!/usr/bin/env python3
"""Session-local project binding and transparent bounded MCP discovery."""
import argparse
import hashlib
import importlib.util
import os
import json
from pathlib import Path
import queue
import sys
import threading
import uuid

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
from project_paths import ROOT, ConfigError, locate_project, select_root, reconnect_file, instance_name
from mcp_client import McpClient
from mcp_pages import all_pages
from bootstrap import state_root, ensure_python
from remote_client import RemoteMcp, RemoteSessionExpired, RemoteRpcError

parser = argparse.ArgumentParser()
parser.add_argument("--component", required=True, choices=["edt", "v8std", "code-index", "bsl-ls"])
component = parser.parse_args().component
state = state_root()
configuration = Path(os.environ.get("EDT_AI_SETTINGS", state / "settings.json"))
messages = queue.Queue()
client = None
current_revision = None
failed_revision = None
tools = []
tools_revision = None
tools_dirty = False
binding_context = None
selected = Path(os.environ["EDT_AI_PROJECT_ROOT"]).resolve() if os.environ.get("EDT_AI_PROJECT_ROOT") else None
selection_error = None
roots_pending = None
roots_counter = 0
initialized = False
last_error = "Выберите каталог проекта с .ai/project.yaml."
PROTOCOLS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")


def emit(message):
    print(json.dumps({"jsonrpc": "2.0", **message}, ensure_ascii=False), flush=True)


def read_input():
    for line in sys.stdin:
        try:
            messages.put(json.loads(line))
        except ValueError:
            continue
    messages.put(None)


threading.Thread(target=read_input, daemon=True).start()


def disconnect():
    global client, tools, tools_revision, tools_dirty, binding_context
    if client:
        client.close()
    client, tools, tools_revision, tools_dirty = None, [], None, False
    binding_context = None


def request_roots():
    global roots_pending, roots_counter, current_revision
    disconnect()
    current_revision = None
    roots_counter += 1
    roots_pending = f"core-roots-{roots_counter}"
    emit({"id": roots_pending, "method": "roots/list", "params": {}})


def config_context():
    from common import settings
    from profile import project_profile
    from project_context import context_revision, effective_settings
    config = settings(configuration)
    if selection_error:
        raise ConfigError(selection_error)
    directory = selected
    if directory is None:
        directory = Path.cwd()
        # Compatibility fallback only when no host directory was supplied.
        if directory.resolve() == ROOT and config.get("active_project"):
            directory = Path(config["active_project"])
    root, profile_revision = context_revision(directory)
    data = project_profile(root)
    return root, effective_settings(config, root, data, state=state), profile_revision


def ensure_binding(refresh_surface=True, retry_failed=True):
    global client, tools, tools_revision, tools_dirty, current_revision, failed_revision, last_error, binding_context
    if roots_pending:
        return
    revision = None
    try:
        if not all(importlib.util.find_spec(name) for name in ("yaml", "jsonschema")):
            # initialize/status need no third-party imports. Prepare dependencies
            # only after a selected repository actually supplies a profile, then
            # keep this stdlib process alive as the protocol relay on Windows.
            if selection_error:
                raise ConfigError(selection_error)
            if os.environ.get("EDT_AI_PREPARED_RELAY"):
                raise ConfigError("Prepared Python lacks required yaml/jsonschema dependencies")
            directory = selected or Path.cwd()
            if Path(directory).resolve() == ROOT and configuration.exists():
                try:
                    fallback = json.loads(configuration.read_text(encoding="utf-8"))
                    directory = fallback.get("active_project") or directory
                except ValueError:
                    pass
            root = locate_project(directory)
            token = reconnect_file(state, root)
            revision = ("prepared-relay", str(root), configuration.read_bytes() if configuration.exists() else b"",
                        token.read_bytes() if token.exists() else b"")
            if revision == failed_revision and not retry_failed:
                return
            # A revision is reusable only after a candidate has been fully
            # initialized.  Failed startup must remain retryable when the
            # endpoint/JAR becomes available without a config change.
            if client is not None and current_revision == revision:
                if refresh_surface:
                    refresh_notified_tools()
                return
            disconnect()
            current_revision = revision
            python = Path(os.environ["EDT_AI_PYTHON"]) if os.environ.get("EDT_AI_PYTHON") else ensure_python(state)
            env = {**os.environ, "EDT_AI_STATE_DIR": str(state), "EDT_AI_SETTINGS": str(configuration),
                   "EDT_AI_PROJECT_ROOT": str(root), "EDT_AI_PREPARED_RELAY": "1"}
            candidate = McpClient([str(python), str(Path(__file__).resolve()), "--component", component], root, env, timeout=180)
            try:
                candidate.initialize()
                tools_revision = getattr(candidate, "tools_revision", None)
                tools = all_pages(candidate, "tools/list", "tools")["tools"]
                tools_dirty = False
            except Exception:
                candidate.close()
                current_revision = None
                raise
            client, current_revision, failed_revision, last_error = candidate, revision, None, ""
            emit({"method": "notifications/tools/list_changed"})
            return
        root, config, profile_revision = config_context()
        token = reconnect_file(state, root)
        revision = (json.dumps(config, sort_keys=True), str(root), profile_revision,
                    token.read_bytes() if token.exists() else b"")
        if revision == failed_revision and not retry_failed:
            return
        if client is not None and revision == current_revision:
            if refresh_surface:
                refresh_notified_tools()
            return
        disconnect()
        current_revision = revision
        if component in ("edt", "v8std"):
            url = config["mcp"]["required"][component]["url"]
            if not url:
                raise ConfigError(f"Укажите connections.{component}.url в профиле проекта.")
            candidate = RemoteMcp(url, timeout=60 if component == "v8std" else 30)
        else:
            env = {**os.environ, "EDT_AI_STATE_DIR": str(state), "EDT_AI_SETTINGS": str(configuration),
                   "EDT_AI_PROJECT_ROOT": str(root)}
            candidate = McpClient([sys.executable, str(ROOT / "scripts/bootstrap.py"),
                                   "--component", component, "--direct"], root, env, timeout=180)
        try:
            candidate.initialize()
            tools_revision = getattr(candidate, "tools_revision", None)
            tools = all_pages(candidate, "tools/list", "tools")["tools"]
            if component == "bsl-ls":
                from runtime import validate_bsl_tools
                validate_bsl_tools(tools)
            tools_dirty = False
        except Exception:
            candidate.close()
            current_revision = None
            raise
        client, failed_revision, last_error = candidate, None, ""
        if component == "v8std":
            binding_context = {"projectRoot": str(root), "instance": instance_name(), "endpoint": url,
                               "connectionId": uuid.uuid4().hex,
                               "revision": hashlib.sha256(repr(revision).encode()).hexdigest()}
        emit({"method": "notifications/tools/list_changed"})
    except Exception as error:
        disconnect()
        failed_revision = revision
        if revision is None:
            current_revision = None
        last_error = str(error)


def refresh_tools():
    """Pull the catalogue on host discovery or a surface-change signal only."""
    global tools, tools_revision, tools_dirty
    revision = getattr(client, "tools_revision", None)
    new = all_pages(client, "tools/list", "tools")["tools"]
    tools_revision = revision
    tools_dirty = False
    if new != tools:
        tools = new
        emit({"method": "notifications/tools/list_changed"})


def refresh_notified_tools():
    if client and (
        tools_dirty or getattr(client, "tools_revision", None) != tools_revision):
        refresh_tools()


def status_tool():
    return {"name": "core_runtime_status", "title": "Состояние " + component,
            "description": ("Read the selected profile binding and negotiated server instructions/capabilities. Reuse until the binding or contract changes."
                            if component == "v8std" else "Read the service state for the selected repository profile."),
            "inputSchema": {"type": "object", "additionalProperties": False},
            "annotations": {"readOnlyHint": True}}


try:
    while True:
        try:
            message = messages.get(timeout=.5)
        except queue.Empty:
            if initialized:
                # A changed binding/reconnect token can be discovered while
                # idle. A failed, unchanged startup is retried only by a host
                # request, never by a loop that relaunches children every 0.5 s.
                ensure_binding(retry_failed=False)
            continue
        if message is None:
            break
        request_id, method = message.get("id"), message.get("method")
        if request_id == roots_pending and roots_pending is not None:
            roots_pending = None
            if not os.environ.get("EDT_AI_PROJECT_ROOT"):
                try:
                    if "error" in message:
                        raise ConfigError("Host could not supply the selected directory")
                    selected = select_root(message["result"].get("roots", []), Path.cwd())
                    selection_error = None
                except Exception as error:
                    selected, selection_error = None, str(error)
            continue
        if request_id is None:
            if method == "notifications/initialized":
                initialized = True
            elif method == "notifications/roots/list_changed" and not os.environ.get("EDT_AI_PROJECT_ROOT"):
                request_roots()
            elif client and method not in ("notifications/initialized", "notifications/tools/list_changed"):
                # Preserve MCP cancellation/progress notifications for the
                # selected EDT session. Root changes are handled locally because
                # they invalidate the binding before any remote call.
                try:
                    client.notify(method, message.get("params", {}))
                except RemoteSessionExpired:
                    disconnect()
                    current_revision = None
            continue
        try:
            requested = message.get("params", {}).get("_meta", {}).get("io.modelcontextprotocol/protocolVersion")
            if method == "server/discover" or (requested and requested not in PROTOCOLS):
                # This relay owns a project binding and child process per
                # connection. Do not advertise stateless, per-request routing.
                emit({"id": request_id, "error": {"code": -32601,
                      "message": "Session-scoped relay requires the initialize handshake."}})
                continue
            if method == "initialize":
                proposed = message.get("params", {}).get("protocolVersion")
                result = {"protocolVersion": proposed if proposed in PROTOCOLS else PROTOCOLS[0],
                          "serverInfo": {"name": "1c-ai-" + component, "version": "0.1.1"},
                          "capabilities": {"tools": {"listChanged": True}, "resources": {}, "prompts": {}}}
                if component == "v8std":
                    result["instructions"] = (
                        "For a new v8std binding, read core_runtime_status once for the selected "
                        "project/instance and negotiated server instructions/capabilities. Select "
                        "operations from their live schemas; reuse discovery until binding, contract "
                        "or relevant evidence changes. A shared corpus does not share project assessments.")
                elif component == "bsl-ls":
                    result["instructions"] = (
                        "Use the assigned EDT-MCP to discover configuration project names and paths. "
                        "Register the exact configuration directory with register_workspace_folder, "
                        "then use file paths or the returned workspaceFolder URI to select its context. "
                        "Several folders may remain registered; no active configuration is shared. "
                        "Only directories inside the selected project binding are accepted.")
                emit({"id": request_id, "result": result})
                if message.get("params", {}).get("capabilities", {}).get("roots") is not None and selected is None:
                    request_roots()
                continue
            if method == "ping":
                result = {}
            else:
                binding_before = client
                ensure_binding(refresh_surface=method != "tools/list")
                params = message.get("params", {})
                if method == "tools/list":
                    # A host discovery request is an explicit pull boundary,
                    # including servers with no notification stream. A new
                    # binding already fetched all pages; do not fetch them twice.
                    if client and client is binding_before:
                        refresh_tools()
                    visible = tools
                    if component == "v8std" and not any(t["name"] == "core_runtime_status" for t in tools):
                        visible = [status_tool(), *tools]
                    result = {"tools": visible or [status_tool()]}
                elif method == "tools/call" and params.get("name") == "core_runtime_status":
                    if client and current_revision and current_revision[0] == "prepared-relay":
                        result = client.request(method, params)
                    else:
                        status = {"ready": bool(client), "component": component, "detail": last_error,
                                  "selectedDirectory": str(selected) if selected else None}
                        if component == "v8std":
                            status["binding"] = binding_context
                            if client:
                                contract = getattr(client, "initialization", {})
                                status["serverContract"] = {key: contract[key] for key in ("instructions", "capabilities") if key in contract}
                        result = {"content": [{"type": "text", "text": json.dumps(status, ensure_ascii=False) if component == "v8std" else last_error or "Готов"}],
                                  "structuredContent": status}
                elif client:
                    if method in ("resources/list", "resources/templates/list", "prompts/list") and not params.get("cursor"):
                        key = {"resources/list": "resources", "resources/templates/list": "resourceTemplates", "prompts/list": "prompts"}[method]
                        try:
                            result = all_pages(client, method, key)
                        except RemoteRpcError as error:
                            # Our lazy interface advertises optional catalogues
                            # before the backend is selected. Unsupported lists
                            # are empty, not a broken project connection. Never
                            # suppress auth, session, pagination or tool failures.
                            if error.code != -32601:
                                raise
                            result = {key: []}
                    else:
                        result = client.request(method, params)
                else:
                    raise ConfigError("Ожидается каталог проекта." if roots_pending else last_error)
            emit({"id": request_id, "result": result})
            if method == "tools/call" and client:
                # Only the toolset-management call can change the visible EDT
                # surface. Never re-list after ordinary reads/writes; the result
                # already reached the host and must remain authoritative.
                if params.get("name") == "enable_toolset":
                    tools_dirty = True
                    emit({"method": "notifications/tools/list_changed"})
        except RemoteSessionExpired as error:
            # A server restart/DELETE invalidates the session. Discard only the
            # binding; the host must explicitly retry any failed mutation.
            disconnect()
            current_revision = None
            last_error = str(error)
            emit({"id": request_id, "error": {"code": -32000, "message": str(error)}})
        except Exception as error:
            emit({"id": request_id, "error": {"code": -32000, "message": str(error)}})
finally:
    disconnect()
