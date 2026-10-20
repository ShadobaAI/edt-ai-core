"""Resolve stable release tags, with the source version as a development default."""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
from pathlib import Path

VERSION_PATTERN = r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"


def version_key(version):
    if not isinstance(version, str) or not re.fullmatch(VERSION_PATTERN, version):
        raise ValueError("Expected a stable version such as 1.0.0, without prefix or prerelease")
    return tuple(map(int, version.split(".")))


def read_source_manifest(root):
    manifest = json.loads((root / "plugin.json").read_text(encoding="utf-8"))
    if manifest["name"] != "1c-ai-core":
        raise ValueError("Unexpected plugin identity")
    version_key(manifest["version"])
    return manifest


def resolve_version(root, version=None):
    if os.environ.get("GITHUB_ACTIONS") == "true" and os.environ.get("GITHUB_REF_TYPE") == "tag":
        tag = os.environ.get("GITHUB_REF_NAME", "")
        version_key(tag)
        if version is not None and version != tag:
            raise ValueError("Package version must match the triggering Git tag")
        return tag
    if version is None:
        result = subprocess.run(["git", "tag", "--merged", "HEAD"], cwd=root,
                                text=True, capture_output=True)
        tags = [tag for tag in result.stdout.splitlines() if re.fullmatch(VERSION_PATTERN, tag)]
        version = max(tags, key=version_key) if tags else read_source_manifest(root)["version"]
    version_key(version)
    return version


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version")
    args = parser.parse_args()
    print(resolve_version(Path(__file__).resolve().parent.parent, args.version))
