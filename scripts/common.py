"""Shared configuration, validation and atomic storage."""
from __future__ import annotations
import contextlib
import json
import os
import sys
from pathlib import Path
import tempfile
import time
from urllib.parse import urlsplit

import yaml
from jsonschema import Draft202012Validator

from project_paths import ROOT, ConfigError


class UniqueLoader(yaml.SafeLoader):
    pass


def mapping(loader, node, deep=False):
    result = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in result:
            raise ConfigError(f"Duplicate YAML key: {key}")
        result[key] = loader.construct_object(value_node, deep=deep)
    return result


UniqueLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, mapping)


def load(path):
    value = yaml.load(Path(path).read_text(encoding="utf-8-sig"), Loader=UniqueLoader)
    if not isinstance(value, dict):
        raise ConfigError(f"Expected an object: {path}")
    return value


def check_schema(data, name):
    schema = json.loads((ROOT / "schemas" / name).read_text(encoding="utf-8"))
    errors = sorted(Draft202012Validator(schema).iter_errors(data), key=lambda e: str(e.path))
    if errors:
        raise ConfigError("; ".join(f"{'.'.join(map(str, e.path)) or '$'}: {e.message}" for e in errors))


def atomic_write(path, text, overwrite=True):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n",
                                     dir=path.parent, delete=False) as stream:
        tmp = Path(stream.name)
        stream.write(text)
    try:
        if overwrite:
            os.replace(tmp, path)
        else:
            # Hard link provides no-clobber semantics, including concurrent creators.
            os.link(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def dump(data, path, overwrite=True):
    atomic_write(path, yaml.safe_dump(data, allow_unicode=True, sort_keys=False), overwrite)


def inside(root, relative):
    if not isinstance(relative, str) or not relative or Path(relative).is_absolute():
        raise ConfigError(f"Path must be relative to the project: {relative!r}")
    root = Path(root).resolve()
    target = (root / relative).resolve()
    if not target.is_relative_to(root):
        raise ConfigError(f"Path escapes project: {relative}")
    return target


def deep_merge(base, overlay):
    result = dict(base)
    for key, value in overlay.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def settings(path=None):
    base = load(ROOT / "settings" / "defaults.json")
    local = Path(path or os.environ.get("EDT_AI_SETTINGS", ROOT / "settings" / "local.yaml"))
    if local.exists():
        base = deep_merge(base, load(local))
    return validate_settings(base)


def validate_settings(config):
    check_schema(config, "plugin-settings.schema.json")
    for name, entry in config["mcp"]["required"].items():
        if not entry["url"]:
            continue
        validate_url(entry["url"], name)
    optional_url = config["mcp"]["optional"].get("openviking", {}).get("url")
    if optional_url:
        validate_url(optional_url, "OpenViking")
    return config


def validate_url(value, name="MCP"):
    parsed = urlsplit(value)
    try:
        port = parsed.port
    except ValueError as exc:
        raise ConfigError(f"Invalid {name} URL port") from exc
    if not parsed.hostname or parsed.scheme not in ("http", "https") or parsed.fragment:
        raise ConfigError(f"Invalid {name} MCP URL")
    if parsed.username or parsed.password or (port is not None and not 0 < port < 65536):
        raise ConfigError(f"Invalid {name} URL: credentials or invalid port")
    return value


def state_path(config, override=None):
    override = override or os.environ.get("EDT_AI_STATE_DIR")
    if override:
        return Path(override).expanduser().resolve()
    home = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
    value = config["state_dir"].replace("${CODEX_HOME}", str(home))
    if "${" in value:
        raise ConfigError("Unresolved variable in state_dir")
    return Path(value).expanduser().resolve()


@contextlib.contextmanager
def operation_lock(state, timeout=0):
    state.mkdir(parents=True, exist_ok=True)
    lock = state / "operation.lock"
    deadline = time.monotonic() + timeout
    while True:
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            break
        except FileExistsError:
            if time.monotonic() >= deadline:
                raise ConfigError(f"Another runtime operation holds {lock}. Verify its PID before removing a stale lock.")
            time.sleep(min(.1, max(0, deadline - time.monotonic())))
    try:
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
        yield
    finally:
        lock.unlink(missing_ok=True)


def cli(main):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    try:
        return main()
    except (ConfigError, OSError, ValueError, yaml.YAMLError) as exc:
        print(json.dumps({"status": "error", "error": str(exc)}, ensure_ascii=False))
        return 1

