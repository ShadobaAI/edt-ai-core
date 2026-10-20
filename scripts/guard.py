"""Profile-driven PreToolUse guard. A guardrail, not an arbitrary-code sandbox."""
import json
import os
from pathlib import Path
import re
import sys

from common import ConfigError, inside
from profile import project_profile
from project_context import locate_project


def strings(value):
    if isinstance(value, dict):
        for child in value.values():
            yield from strings(child)
    elif isinstance(value, list):
        for child in value:
            yield from strings(child)
    elif isinstance(value, str):
        yield value


def reason(event):
    cwd = Path(event.get("cwd") or os.environ.get("EDT_AI_PROJECT_ROOT") or Path.cwd()).resolve()
    try:
        root = locate_project(cwd)
    except ConfigError as error:
        if "No .ai/project.yaml" in str(error):
            return None
        raise
    name = str(event.get("tool_name", ""))
    args = event.get("tool_input", {})
    if not isinstance(args, dict):
        args = {"command": str(args)}
    bare = name.split(".")[-1]
    filesystem = {"Bash", "bash", "shell", "exec_command", "exec", "apply_patch", "view_image", "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "read_file", "write_file", "list_directory"}
    indexed = re.search(r"code[_-]index", name, re.I) and "repo" in args
    generic = bare in filesystem or re.search(r"filesystem.*__", name, re.I)
    if not generic and not indexed:
        return None
    data = project_profile(root)
    if indexed and args["repo"] not in {repo["alias"] for repo in data["repositories"]}:
        return "code-index alias is outside the selected project profile"
    if not generic:
        return None
    protected = [inside(root, path) for path in set(data["roots"]["protected"] + data["roots"]["source"])]
    def touches(path, broad=False):
        path = Path(path).resolve()
        return any(path.is_relative_to(source) or (broad and source.is_relative_to(path)) for source in protected)
    body = "\n".join(strings(args))
    shell = bare in ("Bash", "bash", "shell", "exec_command")
    patch_paths = re.findall(r"^\*\*\* (?:(?:Add|Update|Delete) File|Move to): ([^\r\n]+)", body, re.M)
    explicit = [args[key] for key in ("path", "file_path", "filename", "file", "directory", "uri") if isinstance(args.get(key), str)]
    if isinstance(args.get("paths"), list):
        explicit.extend(item for item in args["paths"] if isinstance(item, str))
    inspected = body if shell or bare == "exec" else "\n".join(patch_paths + explicit)
    payload = inspected.replace("\\", "/").casefold()
    for source in protected:
        if source.as_posix().casefold() in payload:
            return "Protected 1C source requires the assigned EDT/code-index authority"
        relative = source.relative_to(root).as_posix().casefold()
        if re.search(r"(?:^|[^\w.-])(?:\./)?" + re.escape(relative) + r"(?:/|$|[^\w.-])", payload):
            return "Protected source path is not available to filesystem tools"
    # Resolve explicit relative arguments/patch paths, including parent traversal
    # and symlinks, against the declared command directory.
    workdir = args.get("workdir", args.get("cwd"))
    base = (cwd / workdir).resolve() if workdir else cwd
    paths = explicit + patch_paths
    paths += re.findall(r"(?:[A-Za-z]:[/\\]|\.\.?[/\\])[^\s\"'`;|<>]+", inspected)
    for path in paths:
        if touches(base / path, bare in ("Glob", "Grep", "list_directory")):
            return "Filesystem path resolves into protected source"
    if bare in ("Glob", "Grep", "list_directory") and not paths and touches(base, broad=True):
        return "Discovery needs an explicit directory outside protected source"
    command = str(args.get("cmd", args.get("command", "")))
    if bare == "exec" and re.search(r"exec_command|apply_patch|view_image|read_file|write_file", payload):
        return "Use an explicit scoped filesystem call; nested code cannot establish a safe source boundary"
    if shell:
        if not workdir or touches(base, broad=True):
            return "Shell requires an explicit directory outside protected source and its ancestors"
        if re.search(r"(?i)\b(cd|chdir|set-location|push-location|invoke-expression|iex)\b|(?:^|\s)(?:-enc(?:odedcommand)?|--cwd|-C)\b", command):
            return "Shell directory changes or opaque evaluation cannot establish the protected-source boundary"
    return None


def main():
    try:
        event = json.load(sys.stdin)
        denied = reason(event)
    except Exception:
        denied = "1C routing guard could not validate the request/profile; repair the profile or Python setup"
    if denied:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": denied}}))
    else:
        print("{}")


if __name__ == "__main__":
    main()
