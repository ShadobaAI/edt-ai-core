"""Dependency-free path and host-root selection for plugin entrypoints."""
from pathlib import Path
import hashlib
import os
import re
from urllib.parse import urlsplit, unquote

ROOT = Path(__file__).resolve().parents[1]

class ConfigError(ValueError):
    pass


class ProfileNotFound(ConfigError):
    pass


def instance_name():
    name = os.environ.get("EDT_AI_INSTANCE", "default")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", name):
        raise ConfigError("Invalid EDT_AI_INSTANCE identifier")
    return name


def instance_directory(state, root):
    key = hashlib.sha256(str(Path(root).resolve()).casefold().encode()).hexdigest()[:16]
    return Path(state) / "projects" / key / "instances"


def reconnect_file(state, root):
    return instance_directory(state, root) / (instance_name() + ".reconnect.json")


def locate_project(selected):
    directory = Path(selected).resolve()
    if not directory.is_dir():
        raise ConfigError("Selected project directory does not exist")
    for candidate in (directory, *directory.parents):
        profile = candidate / ".ai/project.yaml"
        if profile.is_file():
            if not profile.resolve().is_relative_to(candidate):
                raise ConfigError("Project profile must remain inside its repository")
            return candidate
        # Do not borrow a parent workspace profile across another repository.
        if (candidate / ".git").exists():
            break
    raise ProfileNotFound("No .ai/project.yaml in the selected repository")


def configuration_root(selected):
    """Keep a Git repository's binding stable before and after profile init."""
    try:
        return locate_project(selected)
    except ProfileNotFound:
        directory = Path(selected).resolve()
        for candidate in (directory, *directory.parents):
            if (candidate / ".git").exists():
                return candidate
        return directory


def select_root(roots, cwd):
    paths = []
    for item in roots:
        uri = urlsplit(item.get("uri", ""))
        if uri.scheme != "file" or uri.netloc not in ("", "localhost"):
            raise ConfigError("Project roots must be local file URIs")
        value = unquote(uri.path)
        if len(value) > 2 and value[0] == "/" and value[2] == ":":
            value = value[1:]
        path = Path(value).resolve()
        if path not in paths:
            paths.append(path)
    if len(paths) == 1:
        return paths[0]
    matches = [path for path in paths if Path(cwd).resolve().is_relative_to(path)]
    if len(matches) == 1:
        return matches[0]
    raise ConfigError("Select exactly one project directory; multiple roots are ambiguous")


