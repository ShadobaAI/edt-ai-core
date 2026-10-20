"""Resolve a repository profile from the selected directory, never a project name."""
from pathlib import Path
import hashlib
import os

from common import ConfigError, check_schema, deep_merge, inside, load, validate_url, state_path
from project_paths import locate_project, select_root, instance_name, instance_directory, configuration_root


def local_overrides(root):
    path = inside(root, ".ai/project.local.yaml")
    if not path.exists():
        return {}
    data = load(path)
    check_schema(data, "project-local.schema.json")
    return data


def legacy_edt_matches(config, root):
    owner = config.get("active_project")
    if not owner:
        return True  # Unbound legacy settings explicitly supplied to the CLI.
    owner = Path(owner).resolve()
    if owner.is_dir():
        owner = configuration_root(owner)
    return owner == Path(root).resolve()


def effective_settings(config, root, data=None, instance_override=None, state=None):
    return resolved_settings(config, root, data, instance_override, state)[0]


def resolved_settings(config, root, data=None, instance_override=None, state=None):
    # A selected directory owns its instance overrides even before profile init.
    overrides = {"connections": (data or {}).get("connections", {})}
    sources = {name: "profile" for name in overrides["connections"]}
    local = local_overrides(root)
    overrides = deep_merge(overrides, local)
    sources.update({name: "project_local" for name in local.get("connections", {})})
    state_override = instance_file(config, root, state)
    for path in instance_files(config, root, state):
        if instance_override is not None and path == state_override:
            extra = instance_override
        elif path.exists():
            extra = load(path)
        else:
            continue
        if extra is not None:
            check_schema(extra, "project-local.schema.json")
            overrides = deep_merge(overrides, extra)
            source = "repository_instance"
            if path == state_override:
                source = "instance"
            elif os.environ.get("EDT_AI_CONNECTIONS_FILE") and path == Path(os.environ["EDT_AI_CONNECTIONS_FILE"]).resolve():
                source = "connections_file"
            sources.update({name: source for name in extra.get("connections", {})})
    connections = overrides["connections"]
    overlay = {}
    # An EDT URL owned by another directory is not this project's fallback.
    # The normative corpus may legitimately be shared.
    if not legacy_edt_matches(config, root):
        overlay["edt"] = {"url": ""}
    overlay.update({name: {"url": entry["url"]} for name, entry in connections.items()})
    for name in ("edt", "v8std"):
        variable = connections.get(name, {}).get("url_env", f"EDT_AI_{name.upper()}_URL")
        if variable in os.environ:
            overlay[name] = {"url": os.environ[variable]}
            sources[name] = "environment:" + variable
        else:
            sources.setdefault(name, "legacy" if config["mcp"]["required"][name]["url"] and (name != "edt" or legacy_edt_matches(config, root)) else "unconfigured")
    for name, entry in overlay.items():
        if entry["url"]:
            validate_url(entry["url"], name)
    result = deep_merge(config, {"active_project": str(Path(root).resolve()),
                                 "mcp": {"required": overlay}})
    return result, sources


def instance_file(config, root, state=None):
    return instance_directory(state_path(config, state), root) / (instance_name() + ".yaml")


def instance_files(config, root, state=None):
    paths = [inside(root, ".ai/instances/" + instance_name() + ".local.yaml"), instance_file(config, root, state)]
    if os.environ.get("EDT_AI_CONNECTIONS_FILE"):
        explicit = Path(os.environ["EDT_AI_CONNECTIONS_FILE"]).resolve()
        if not explicit.is_file():
            raise ConfigError("EDT_AI_CONNECTIONS_FILE must identify an existing override file")
        paths.append(explicit)
    return paths


def context_revision(selected):
    root = locate_project(selected)
    digest = hashlib.sha256(str(root).casefold().encode())
    for name in ("project.yaml", "project.local.yaml"):
        path = inside(root, ".ai/" + name)
        digest.update(path.read_bytes() if path.exists() else b"")
    return root, digest.hexdigest()
