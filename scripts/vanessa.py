"""Profile-bound entry to the bundled Vanessa CLI; never starts an app implicitly."""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path
from common import ROOT, ConfigError, cli, inside, settings, check_schema
from profile import project_profile
from policy_runtime import binding
from mcp_client import McpClient


def runtime_profile(project_root, with_digest=False):
    from project_context import locate_project
    root = locate_project(project_root)
    data = project_profile(root)
    if not data["testing"]["vanessa"]:
        raise ConfigError("Vanessa is disabled in this project profile")
    config = data["testing"]["vanessa_config"]
    file = inside(root, config["runtime_profile"])
    if file.stat().st_size > 65536:
        raise ConfigError("Vanessa runtime profile exceeds the 64 KiB limit")
    payload = file.read_bytes()
    raw = json.loads(payload.decode("utf-8-sig"))
    check_schema(raw, "vanessa-runtime.schema.json")
    for key, expected in (("projectRoot", root), ("features", inside(root, config["features"])),
                          ("results", inside(root, config["results"]))):
        if (file.parent / raw[key]).resolve() != expected:
            raise ConfigError(f"Vanessa local runtime {key} differs from the project binding")
    if raw["mcp"].get("serverName", "vanessa") != config["server_name"]:
        raise ConfigError("Vanessa MCP server name differs from the project binding")
    result = (root, data, config, file, raw)
    return (*result, hashlib.sha256(payload).hexdigest()) if with_digest else result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["describe", "configure", "doctor", "list", "start", "setup", "connect", "call", "run"])
    parser.add_argument("--project-root", required=True)
    parser.add_argument("--settings")
    parser.add_argument("--feature")
    parser.add_argument("--scenario")
    parser.add_argument("--tool")
    parser.add_argument("--arguments-file")
    parser.add_argument("--authorization-file", help="Caller evidence of actual user agreement, not an automatic permission grant")
    parser.add_argument("--for-action", choices=["start", "setup", "connect", "call", "run"], default="run",
                        help="Read-only describe target; does not perform the action")
    parser.add_argument("--editor-transition", action="store_true")
    args = parser.parse_args()
    root, data, config, file, raw, runtime_hash = runtime_profile(args.project_root, with_digest=True)
    # Bind consent to resolved targets, including clones with identical IDs/JSON.
    def infobase(value):
        return {**value, "path": str((file.parent / value["path"]).resolve())} if value["type"] == "file" else value
    action = args.for_action if args.command == "describe" else args.command
    if action == "run":
        if not args.feature or not args.scenario or not args.scenario.strip():
            raise ConfigError("Run requires an exact feature and scenario")
        feature = Path(args.feature)
        feature = feature.resolve() if feature.is_absolute() else inside(root, args.feature)
        # The bound features directory is inside root; Node also permits explicit
        # temporary copies elsewhere in that same projectRoot.
        if feature.suffix.lower() != ".feature" or not feature.is_relative_to(root):
            raise ConfigError("Feature must remain inside projectRoot or configured features")
    arguments_hash = None
    arguments_file = None
    if args.arguments_file:
        arguments_file = Path(args.arguments_file).resolve()
        with arguments_file.open("rb") as stream:
            payload = stream.read(1024 * 1024 + 1)
        if len(payload) > 1024 * 1024:
            raise ConfigError("Tool arguments exceed the 1 MiB limit")
        arguments_hash = hashlib.sha256(payload).hexdigest()
    target = {"project": data["project"]["id"], "repository": config["repository_id"],
              "projectRoot": str(root), "runtimeProfile": str(file.resolve()),
              "manager": infobase(raw["manager"]["infobase"]), "client": infobase(raw["client"]["infobase"]),
              "runtime": runtime_hash,
              "command": action,
              "feature": args.feature, "scenario": args.scenario, "tool": args.tool,
              "argumentsHash": arguments_hash}
    scope = json.dumps(target, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    effects = {"start": ["launch"], "setup": ["launch", "database"],
               "connect": ["launch", "database"], "run": ["database"]}.get(action, [])
    if args.command == "describe":
        print(json.dumps({"scope": scope, "effects": effects, "runtimeProfile": str(file)}, ensure_ascii=False))
        return 0
    request = {"effects": effects, "scope": scope, "authorizations": []}
    if args.authorization_file:
        request = json.loads(Path(args.authorization_file).read_text(encoding="utf-8-sig"))
        if request.get("scope") != scope or not set(effects).issubset(request.get("effects", [])):
            raise ConfigError("Authorization scope/effects differ from the intended Vanessa action")
    if args.command == "call" and not args.authorization_file:
        raise ConfigError("Generic call needs an explicit effects/authorization record based on the live tool contract")
    config_settings = settings(args.settings)
    entry = binding(config_settings)
    with McpClient([entry["command"], *entry["args"]], ROOT) as client:
        client.initialize()
        result = client.call("check_action", request)["structuredContent"]
    if result["status"] != "within_declared_scope":
        raise ConfigError("Actual user agreement required for: " + ", ".join(result["missing"]))
    command = [entry["command"], str(ROOT / "vanessa/vanessa.mjs"), args.command, "--profile", str(file),
               "--expected-profile-sha256", runtime_hash]
    for key in ("feature", "scenario", "tool"):
        if getattr(args, key):
            command += ["--" + key.replace("_", "-"), getattr(args, key)]
    if arguments_file:
        command += ["--arguments-file", str(arguments_file), "--expected-arguments-sha256", arguments_hash]
    if args.editor_transition:
        command.append("--editor-transition")
    # Inherit stdin so a bounded editor transition keeps the same lock/session.
    return subprocess.run(command, cwd=root).returncode


if __name__ == "__main__":
    raise SystemExit(cli(main))
