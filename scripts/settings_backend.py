"""Validated settings operations with per-file atomic writes and rollback on errors."""
from __future__ import annotations
import copy
import hashlib
import json
import os
from pathlib import Path
import sys

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

import yaml
from common import ConfigError, UniqueLoader, atomic_write, check_schema, deep_merge, dump, inside, load, operation_lock, settings, validate_settings, validate_url
from profile import backup, profile_target, project_profile, validate, validate_at
from action_policy import effective_policy
from project_paths import configuration_root, ProfileNotFound, reconnect_file

STATE = Path(os.environ["EDT_AI_STATE_DIR"])
CONFIG = Path(os.environ["EDT_AI_SETTINGS"])
FIELDS = {
    "projectRoot": ("active_project",),
    "edtUrl": ("mcp", "required", "edt", "url"),
    "v8stdUrl": ("mcp", "required", "v8std", "url"),
    "openvikingEnabled": ("mcp", "optional", "openviking", "enabled"),
    "openvikingUrl": ("mcp", "optional", "openviking", "url"),
}


def current():
    config = settings(CONFIG)
    config["state_dir"] = str(STATE)
    if os.environ.get("EDT_AI_PROJECT_ROOT"):
        from project_context import legacy_edt_matches
        selected = configuration_root(os.environ["EDT_AI_PROJECT_ROOT"])
        if not config.get("active_project") or not legacy_edt_matches(config, selected):
            config["mcp"]["required"]["edt"]["url"] = ""
        config["active_project"] = str(selected)
    elif "EDT_AI_PROJECT_ROOT" in os.environ:
        # The settings session has no selected root. A previous session's choice
        # is not permission to edit that directory or its connection defaults.
        config["active_project"] = None
        config["mcp"]["required"]["edt"]["url"] = ""
    elif config.get("active_project") and Path(config["active_project"]).is_dir():
        config["active_project"] = str(configuration_root(config["active_project"]))
    return config


def values(config):
    config = effective(config)
    output = {}
    for name, parts in FIELDS.items():
        item = config
        for part in parts:
            item = item.get(part, {}) if isinstance(item, dict) else None
        output[name] = item if isinstance(item, (str, bool)) else ""
    return output


def effective(config, instance_override=None, profile=None, with_sources=False):
    from project_context import locate_project, resolved_settings
    sources = {name: "legacy" if item["url"] else "unconfigured" for name, item in config["mcp"]["required"].items()}
    selected = config.get("active_project")
    if selected:
        try:
            root = locate_project(selected)
        except ProfileNotFound:
            config, sources = resolved_settings(config, configuration_root(selected), profile, instance_override=instance_override)
        else:
            config, sources = resolved_settings(config, root, profile if profile is not None else validate_at(root, load(root / ".ai/project.yaml")), instance_override=instance_override)
    return (config, sources) if with_sources else config


def checked(config):
    validate_settings(config)
    root = config.get("active_project")
    if root and not Path(root).is_dir():
        raise ConfigError("Папка проекта не найдена. Укажите папку на этом компьютере.")
    return config


def store_shared_settings(config):
    # Session selection and imported connection URLs never become shared state.
    # Preserve legacy CLI defaults/ownership until explicitly migrated by the CLI.
    saved = deep_merge(settings(CONFIG), {
        "state_dir": str(STATE),
        "mcp": {key: config["mcp"][key] for key in ("managed", "optional")},
    })
    atomic_write(CONFIG, json.dumps(saved, ensure_ascii=False, indent=2) + "\n")


def revision(config, target=None, payload=""):
    digest = hashlib.sha256()
    digest.update(json.dumps(config, sort_keys=True, ensure_ascii=False).encode("utf-8"))
    digest.update(payload.encode("utf-8"))
    digest.update(CONFIG.read_bytes() if CONFIG.exists() else b"")
    if target:
        digest.update(str(target.resolve()).encode())
        digest.update(target.read_bytes() if target.exists() else b"")
    if config.get("active_project"):
        from project_context import instance_files
        for path in instance_files(config, Path(config["active_project"])):
            digest.update(str(path).encode("utf-8"))
            digest.update(path.read_bytes() if path.exists() else b"")
    return digest.hexdigest()


def parse_import(request):
    text = request.get("text", "")
    if not isinstance(text, str) or len(text.encode("utf-8")) > 2 * 1024 * 1024:
        raise ConfigError("Допустим файл настроек размером до 2 МиБ.")
    data = yaml.load(text, Loader=UniqueLoader)
    if not isinstance(data, dict):
        raise ConfigError("Файл должен содержать объект настроек или профиль проекта.")
    config = current()
    previous_root = config.get("active_project")
    connection_changes = {}
    imported_profile = None
    if data.get("format") == "1c-ai-core-settings":
        if data.get("version") != 1 or set(data) - {"format", "version", "settings", "profile"}:
            raise ConfigError("Неизвестный формат или версия файла настроек.")
        changes = data.get("settings", {})
        if not isinstance(changes, dict) or set(changes) - {"active_project", "mcp"}:
            raise ConfigError("Недопустимые поля настроек.")
        changes = copy.deepcopy(changes)
        # Validate the complete old-format settings before extracting its URLs.
        check_schema(deep_merge(config, changes), "plugin-settings.schema.json")
        for name, entry in changes.get("mcp", {}).get("required", {}).items():
            if "url" in entry:
                value = entry.pop("url")
                # In the old shared settings format an empty URL meant "no
                # fallback", not "disconnect despite a tracked profile URL".
                if value:
                    connection_changes[name] = {"url": validate_url(value, name)}
        imported_profile = copy.deepcopy(data.get("profile"))
        config = deep_merge(config, changes)
    elif "schema_version" in data:
        imported_profile = data
    else:
        raise ConfigError("Это не экспорт настроек 1C AI Core и не профиль проекта.")
    if "projectRoot" in request:
        selected = os.environ.get("EDT_AI_PROJECT_ROOT") if os.environ.get("EDT_AI_SETTINGS_ROOT_LOCKED") != "0" else None
        proposed = configuration_root(request["projectRoot"]) if request["projectRoot"] else None
        if selected and proposed != configuration_root(selected):
            raise ConfigError("Импорт относится к другому каталогу. Сначала выберите этот проект в Codex.")
        config["active_project"] = str(proposed) if proposed else None
    elif config.get("active_project"):
        config["active_project"] = str(configuration_root(config["active_project"]))
    if config.get("active_project") != previous_root:
        config["mcp"]["required"]["edt"]["url"] = ""
    selected = os.environ.get("EDT_AI_PROJECT_ROOT") if os.environ.get("EDT_AI_SETTINGS_ROOT_LOCKED") != "0" else None
    if selected and (not config.get("active_project") or
                     Path(config["active_project"]).resolve() != configuration_root(selected)):
        raise ConfigError("Импорт относится к другому каталогу. Сначала выберите этот проект в Codex.")
    config["state_dir"] = str(STATE)
    checked(config)
    root = Path(config["active_project"]).resolve() if config.get("active_project") else None
    target = None
    if imported_profile is not None:
        validate(imported_profile)
        if root is None:
            raise ConfigError("Для импорта профиля выберите папку проекта.")
        target = profile_target(root)
        validate_at(root, imported_profile)
        for repo in imported_profile["repositories"]:
            if not inside(root, repo["path"]).is_dir():
                raise ConfigError("В выбранной папке отсутствует репозиторий: " + repo["path"])
        from project_context import effective_settings
        effective_settings(config, root, imported_profile)
    overrides = None
    if connection_changes:
        if root is None:
            raise ConfigError("Для импорта подключений выберите папку проекта.")
        from project_context import instance_file
        path = instance_file(config, root)
        overrides = deep_merge(load(path) if path.exists() else {"connections": {}}, {"connections": connection_changes})
        check_schema(overrides, "project-local.schema.json")
    return config, imported_profile, target, overrides


def main(request):
    action = request["action"]
    if action == "read":
        from project_context import instance_name
        config = current()
        _, sources = effective(config, with_sources=True)
        return {"values": values(config), "instance": instance_name(), "connectionSources": sources}
    if action == "update":
        changes = request.get("set", {})
        if not isinstance(changes, dict) or not changes or set(changes) - set(FIELDS):
            raise ConfigError("Некорректное изменение настроек.")
        for key, value in changes.items():
            if type(value) is not (bool if key == "openvikingEnabled" else str):
                raise ConfigError("Некорректный тип настройки: " + key)
        selected = os.environ.get("EDT_AI_PROJECT_ROOT") if os.environ.get("EDT_AI_SETTINGS_ROOT_LOCKED") != "0" else None
        if selected and "projectRoot" in changes and (not changes["projectRoot"] or
                configuration_root(changes["projectRoot"]) != configuration_root(selected)):
            raise ConfigError("Каталог задаётся текущей сессией; выберите другой проект в Codex.")
        with operation_lock(STATE):
            config = current()
            instance_changes = {}
            global_changed = False
            # Resolve the intended directory before applying URL changes,
            # independent of JSON property order.
            for key in sorted(changes, key=lambda item: item != "projectRoot"):
                value = changes[key]
                if key == "projectRoot" and value:
                    value = str(configuration_root(value))
                if key == "projectRoot":
                    if config.get("active_project") != (value or None):
                        config["mcp"]["required"]["edt"]["url"] = ""
                    config["active_project"] = value or None
                    continue
                if key in ("edtUrl", "v8stdUrl"):
                    if not config.get("active_project"):
                        raise ConfigError("Для настройки подключений выберите папку проекта.")
                    root = configuration_root(config["active_project"])
                    # Empty means explicitly disconnected, not an undocumented
                    # reset to a lower-priority URL. Environment still wins.
                    instance_changes.setdefault("connections", {})["edt" if key == "edtUrl" else "v8std"] = {"url": validate_url(value) if value else ""}
                    continue
                target = config
                global_changed = True
                parts = FIELDS[key]
                for part in parts[:-1]:
                    target = target.setdefault(part, {})
                target[parts[-1]] = (value or None) if key == "projectRoot" else value
            checked(config)
            path, previous_override = None, None
            if instance_changes:
                from project_context import instance_file, effective_settings
                path = instance_file(config, root)
                overrides = load(path) if path.exists() else {"connections": {}}
                check_schema(overrides, "project-local.schema.json")
                overrides = deep_merge(overrides, instance_changes)
                check_schema(overrides, "project-local.schema.json")
                data = project_profile(root) if (root / ".ai/project.yaml").is_file() else None
                effective_settings(config, root, data, instance_override=overrides)
                previous_override = path.read_bytes() if path.exists() else None
            previous_config = CONFIG.read_bytes() if CONFIG.exists() else None
            try:
                if path:
                    dump(overrides, path)
                if global_changed:
                    store_shared_settings(config)
            except Exception:
                if path:
                    if previous_override is None:
                        path.unlink(missing_ok=True)
                    else:
                        atomic_write(path, previous_override.decode("utf-8"))
                if previous_config is None:
                    CONFIG.unlink(missing_ok=True)
                else:
                    atomic_write(CONFIG, previous_config.decode("utf-8"))
                raise
        return {"values": values(config)}
    if action in ("preview", "apply"):
        config, profile, target, overrides = parse_import(request)
        applied_config = effective(config, instance_override=overrides, profile=profile)
        shared = settings(CONFIG)
        summary = {
            "projectRoot": config.get("active_project") or "",
            "profileId": profile.get("profile_id") if profile else None,
            "repositories": [{"id": r["id"], "path": r["path"], "alias": r["alias"]}
                             for r in profile.get("repositories", [])] if profile else [],
            "edtConfigured": bool(applied_config["mcp"]["required"]["edt"]["url"]),
            "v8stdConfigured": bool(applied_config["mcp"]["required"]["v8std"]["url"]),
            "replacesProfile": bool(target and target.exists()),
            "connectionUrls": {name: item["url"] for name, item in applied_config["mcp"]["required"].items()},
            "writesInstanceConnections": overrides is not None,
            "sharedRuntimeChanges": {name: item for name, item in config["mcp"]["managed"].items()
                                     if item != shared["mcp"]["managed"].get(name)},
            "revision": revision(applied_config, target, request["text"]),
        }
        if action == "preview":
            return summary
        with operation_lock(STATE):
            # Reparse under the lock; do not write a config read before another
            # settings writer completed.
            config, profile, target, overrides = parse_import(request)
            applied_config = effective(config, instance_override=overrides, profile=profile)
            if request.get("revision") != revision(applied_config, target, request["text"]):
                raise ConfigError("Настройки изменились после предпросмотра. Проверьте файл заново.")
            if target and target.exists() and request.get("replace") is not True:
                raise ConfigError("Подтвердите замену существующего профиля.")
            previous_config = CONFIG.read_bytes() if CONFIG.exists() else None
            previous_profile = target.read_bytes() if target and target.exists() else None
            from project_context import instance_file
            override_path = instance_file(config, Path(config["active_project"])) if overrides is not None else None
            previous_override = override_path.read_bytes() if override_path and override_path.exists() else None
            saved = str(backup(target)) if target and target.exists() else None
            try:
                if target:
                    dump(profile, target, overwrite=target.exists())
                if override_path:
                    dump(overrides, override_path)
                store_shared_settings(config)
            except Exception:
                if override_path:
                    if previous_override is None:
                        override_path.unlink(missing_ok=True)
                    else:
                        atomic_write(override_path, previous_override.decode("utf-8"))
                if target:
                    if previous_profile is None:
                        target.unlink(missing_ok=True)
                    else:
                        atomic_write(target, previous_profile.decode("utf-8"))
                if previous_config is None:
                    CONFIG.unlink(missing_ok=True)
                else:
                    atomic_write(CONFIG, previous_config.decode("utf-8"))
                raise
        return {"status": "imported", "summary": summary, "backup": saved, "values": values(config)}
    if action == "export":
        config = current()
        profile = None
        if config.get("active_project"):
            path = Path(config["active_project"]) / ".ai/project.yaml"
            if path.exists():
                profile = validate_at(path.parent.parent, load(path))
        bundle = {"format": "1c-ai-core-settings", "version": 1,
                  "settings": {"mcp": {key: config["mcp"][key] for key in ("managed", "optional")}},
                  "profile": profile}
        return {"filename": "1c-ai-core-settings.json",
                "text": json.dumps(bundle, ensure_ascii=False, indent=2)}
    if action == "check":
        from runtime import project, smoke
        from policy_runtime import smoke as policy_smoke
        config = effective(current())
        root, data = project(config.get("active_project"), config)
        managed = []
        for component in ("code-index", "bsl-ls"):
            try:
                item = smoke(STATE, config, root, data, component)
                index_ready = item.get("index_ready", True)
                managed.append({"name": component, "ready": index_ready,
                                "state": "ready" if index_ready else "indexing",
                                "version": item["server"].get("version")})
            except Exception as exc:
                busy = "Another runtime operation" in str(exc)
                managed.append({"name": component, "ready": False,
                                "state": "preparing" if busy else "error",
                                "detail": "Подготовка окружения выполняется…" if busy else str(exc)})
        try:
            item = policy_smoke(config)
            managed.append({"name": "policy", "ready": True, "state": "ready",
                            "version": item["server"]["version"]})
        except Exception as exc:
            managed.append({"name": "policy", "ready": False, "state": "error",
                            "detail": str(exc)})
        import uuid
        atomic_write(reconnect_file(STATE, root), json.dumps({"id": uuid.uuid4().hex}))
        return {"managed": managed,
                "actionPolicy": effective_policy(data["policy"]),
                "external": {name: {"configured": bool(item["url"]), "liveVerified": False}
                             for name, item in config["mcp"]["required"].items()},
                "fullReadiness": "not_verified"}
    raise ConfigError("Неизвестная операция.")


if __name__ == "__main__":
    try:
        result = main(json.load(sys.stdin))
        print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        raise SystemExit(1)

