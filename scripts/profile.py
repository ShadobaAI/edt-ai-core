#!/usr/bin/env python3
"""Portable project profiles: init, validate, export, import with backup."""
from __future__ import annotations
import argparse
import os
import json
import re
from pathlib import Path
from datetime import datetime, timezone
import uuid

from common import ROOT, ConfigError, atomic_write, check_schema, cli, deep_merge, dump, inside, load

SECRET_KEY = re.compile(r"(?i)(password|secret|credential|private.?key|api.?key|access.?token|authorization)")


def validate(data):
    check_schema(data, "project-profile.schema.json")
    from common import validate_url
    for name, entry in data.get("connections", {}).items():
        validate_url(entry["url"], name)
    aliases = [r["alias"] for r in data["repositories"]]
    ids = [r["id"] for r in data["repositories"]]
    if len(set(aliases)) != len(aliases) or len(set(ids)) != len(ids):
        raise ConfigError("Repository ids and index aliases must be unique")
    repositories = {repo["id"]: repo for repo in data["repositories"]}
    def known(values, label):
        missing = set(values) - repositories.keys()
        if missing:
            raise ConfigError(f"Unknown repository ids in {label}: {', '.join(sorted(missing))}")
    policy = data["policy"]
    assigned = policy.get("edt_repository_ids", [])
    unbound = policy.get("unbound_edt_repositories", [])
    known(assigned + unbound, "policy")
    if set(assigned) & set(unbound):
        raise ConfigError("EDT assigned and unbound repository groups overlap")
    from action_policy import effective_policy
    effective_policy(policy)
    exception_ids = []
    for exception in policy.get("exceptions", []):
        exception_ids.append(exception["id"])
        known(exception["repository_ids"], "policy exception")
        if not exception["repository_ids"]:
            raise ConfigError("A policy exception needs an explicit repository scope")
    if len(set(exception_ids)) != len(exception_ids):
        raise ConfigError("Policy exception ids must be unique")
    testing = data["testing"]
    for kind in ("yaxunit", "vanessa"):
        config = testing.get(kind + "_config")
        if config:
            owner = config["repository_id"]
            known([owner], kind)
            if kind == "yaxunit":
                framework = config.get("framework_repository_id")
                known(config.get("product_repository_ids", []) + ([framework] if framework else []), kind)
                if framework == owner:
                    raise ConfigError("YaXUnit framework and test owner must be different repositories")
                if testing[kind] and (not repositories[owner].get("edt_project") or owner in unbound):
                    raise ConfigError("Enabled YaXUnit needs a bound EDT project for its test owner")
    command_ids = []
    for command in testing["commands"]:
        command_ids.append(command["id"])
        known([command["repository_id"]], "test command")
        if re.search(r"[\\/:\s]", command["argv"][0]):
            raise ConfigError("Test command program must be a portable executable name, not a shell expression/path")
    if len(set(command_ids)) != len(command_ids):
        raise ConfigError("Test command ids must be unique")
    # A portable profile never stores credentials; references are allowed separately.
    def walk(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if SECRET_KEY.search(str(key)):
                    raise ConfigError(f"Credentials do not belong in portable profiles: {key}")
                walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)
    walk(data)
    return data


def scoped_paths(data):
    paths = data["roots"]["source"] + data["roots"]["protected"]
    paths += [repo["path"] for repo in data["repositories"]]
    for kind in ("yaxunit", "vanessa"):
        config = data["testing"].get(kind + "_config", {})
        paths += [config[key] for key in ("results", "features", "runtime_profile") if key in config]
    if data["knowledge"].get("manifest"):
        paths.append(data["knowledge"]["manifest"])
    return paths


def validate_at(root, data):
    validate(data)
    for relative in scoped_paths(data):
        inside(root, relative)
    config = data["testing"].get("vanessa_config")
    if config:
        owner = next(repo for repo in data["repositories"] if repo["id"] == config["repository_id"])
        if not inside(root, config["features"]).is_relative_to(inside(root, owner["path"])):
            raise ConfigError("Vanessa features must remain inside their owning repository")
    return data


def project_profile(root):
    from project_paths import locate_project
    root = locate_project(root)
    return validate_at(root, load(Path(root) / ".ai" / "project.yaml"))


def profile_target(root):
    target = Path(root).resolve() / ".ai" / "project.yaml"
    if not target.resolve().is_relative_to(Path(root).resolve()):
        raise ConfigError(".ai must remain inside the project")
    return target


def backup(target):
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = target.with_name(f"project.{stamp}.{uuid.uuid4().hex[:8]}.bak.yaml")
    atomic_write(path, target.read_text(encoding="utf-8"), overwrite=False)
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    init = sub.add_parser("init")
    init.add_argument("project_root", type=Path)
    init.add_argument("--profile", default="generic-1c", choices=["generic-1c"])
    for name in ("export", "import"):
        cmd = sub.add_parser(name)
        cmd.add_argument("project_root", type=Path)
        cmd.add_argument("--output" if name == "export" else "--input", type=Path, required=True)
        if name == "import":
            cmd.add_argument("--merge", action="store_true")
            cmd.add_argument("--replace", action="store_true")
        else:
            cmd.add_argument("--replace", action="store_true")
    sub.add_parser("validate").add_argument("profile", type=Path)
    for command in ("effective", "configure-instance"):
        context = sub.add_parser(command)
        context.add_argument("project_root", type=Path)
        context.add_argument("--settings", type=Path)
        context.add_argument("--instance")
        if command == "configure-instance":
            context.add_argument("--edt-url")
            context.add_argument("--v8std-url")
    args = parser.parse_args()
    if args.command == "validate":
        validate(load(args.profile))
        print(json.dumps({"status": "valid", "readiness": "not_checked"}))
        return 0
    if args.command in ("effective", "configure-instance"):
        from common import settings, validate_url, operation_lock, state_path
        from project_context import locate_project, effective_settings, instance_file, instance_name
        if args.instance:
            os.environ["EDT_AI_INSTANCE"] = args.instance
        root = locate_project(args.project_root)
        data = project_profile(root)
        config = settings(args.settings)
        target = instance_file(config, root)
        if args.command == "configure-instance":
            updates = {name: {"url": validate_url(value, name)} for name, value in
                       (("edt", args.edt_url), ("v8std", args.v8std_url)) if value is not None}
            override_update = {"connections": updates}
            if not updates:
                raise ConfigError("Specify --edt-url or --v8std-url")
            with operation_lock(state_path(config, os.environ.get("EDT_AI_STATE_DIR"))):
                override = load(target) if target.exists() else {"connections": {}}
                check_schema(override, "project-local.schema.json")
                candidate = deep_merge(override, override_update)
                check_schema(candidate, "project-local.schema.json")
                effective_settings(config, root, data, instance_override=candidate)
                dump(candidate, target)
        effective = effective_settings(config, root, data)
        applied = {**data,
                   "connections": {name: {"url": value["url"]} for name, value in
                                           effective["mcp"]["required"].items() if value["url"]}}
        print(json.dumps({"projectRoot": str(root), "instance": instance_name(),
                          "instanceFile": str(target), "profile": applied}, ensure_ascii=False, indent=2))
        return 0
    root = args.project_root.resolve()
    if not root.is_dir():
        raise ConfigError(f"Project directory does not exist: {root}")
    if args.command in ("export", "import"):
        from project_paths import configuration_root
        root = configuration_root(root)
    target = profile_target(root)
    if args.command == "init":
        if target.exists():
            raise ConfigError(f"Profile already exists: {target}")
        data = load(ROOT / "profiles" / args.profile / "profile.yaml")
        data["project"]["id"] = re.sub("[^a-z0-9-]", "-", root.name.lower()).strip("-") or "project"
        validate(data)
        dump(data, target, overwrite=False)
        docs = {root / ".ai" / "PROJECT.md": "# Project\n\nDescribe purpose, architecture and sources of truth.\n",
                root / ".ai" / ".gitignore": "project.local.yaml\ninstances/*.local.yaml\n",
                root / "AGENTS.md": "# 1C project\n\nUse 1c-ai-core. Read .ai/project.yaml and .ai/PROJECT.md.\nUse $1c-routing and its shared action-policy reference before project operations.\nApply the shared policy and reuse actual user authorizations only for their approved scope.\nUse assigned authorities for protected sources.\n"}
        for path, content in docs.items():
            if not path.exists():
                atomic_write(path, content, overwrite=False)
        result = {"status": "created", "path": str(target), "profile_id": args.profile}
    elif args.command == "export":
        data = project_profile(root)
        output = args.output.resolve()
        if output == target.resolve():
            raise ConfigError("Export destination must differ from the active profile")
        dump(data, output, overwrite=args.replace)
        result = {"status": "exported", "path": str(output)}
    else:
        if args.merge and args.replace:
            raise ConfigError("Choose --merge or --replace")
        incoming = validate(load(args.input))
        if target.exists() and not (args.merge or args.replace):
            raise ConfigError("Profile exists: choose --merge or --replace (a backup will be saved)")
        if args.merge and target.exists():
            current = project_profile(root)
            if incoming["profile_id"] != current["profile_id"]:
                raise ConfigError("Cannot merge different profile types; use --replace")
            incoming = validate(deep_merge(current, incoming))
        # Validate containment against the destination before any write.
        validate_at(root, incoming)
        saved = str(backup(target)) if target.exists() else None
        dump(incoming, target, overwrite=target.exists())
        result = {"status": "imported", "path": str(target), "backup": saved,
                  "profile_id": incoming["profile_id"]}
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(cli(main))

