"""Build portable plugin and local marketplace ZIPs, without machine bindings."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

from release_policy import read_source_manifest, resolve_version

ROOT = Path(__file__).resolve().parent.parent
CATALOG_TEMPLATE = "packaging/marketplace.template.json"
# Only runtime directories and known source formats are distributed.
DIRECTORIES = {
    "hooks": {".json", ".mjs"}, "knowledge": {".yaml"},
    "mcp": {".mjs", ".md"}, "policy": {".json", ".mjs", ".md"},
    "profiles/generic-1c": {".yaml"}, "runtime": {".yaml"}, "schemas": {".json"},
    "scripts": {".py"}, "skills": {".md", ".yaml"},
    "ui": {".html"}, "vanessa": {".mjs"},
}
FILES = ["LICENSE", "NOTICE.md", "plugin.json", "mcp.json", "requirements.txt", "settings/defaults.json",
         "docs/DEVELOPMENT.md",
         "settings/local.example.yaml", "README.md", "docs/USAGE.md", "docs/NATIVE_SETTINGS.md",
         "docs/SETTINGS_REVIEW.md", "docs/ROADMAP.md", "docs/VERIFICATION.md", "docs/SOURCES.md"]
EXCLUDED = {"local.yaml", "runtime.local.json", "__pycache__"}


def json_write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def archive(directory, destination, prefix=""):
    with ZipFile(destination, "w", compression=ZIP_DEFLATED, compresslevel=9) as output:
        for file in sorted(directory.rglob("*")):
            if file.is_file():
                info = ZipInfo(prefix + file.relative_to(directory).as_posix(), (2020, 1, 1, 0, 0, 0))
                info.create_system = 3
                info.external_attr = 0o100644 << 16
                info.compress_type = ZIP_DEFLATED
                output.writestr(info, file.read_bytes(), compresslevel=9)


def package(output, version=None):
    manifest = read_source_manifest(ROOT)
    version = resolve_version(ROOT, version)
    source = ROOT
    paths = list(FILES)
    for directory, extensions in DIRECTORIES.items():
        if not (source / directory).is_dir():
            raise ValueError(f"Missing input directory: {directory}")
        paths.extend(file.relative_to(source).as_posix() for file in sorted((source / directory).rglob("*"))
                     if file.is_file() and file.suffix in extensions and not EXCLUDED.intersection(file.parts))
    for file in [*(source / name for name in paths), ROOT / CATALOG_TEMPLATE]:
        if not file.is_file() or file.resolve() != file.absolute():
            raise ValueError(f"Missing input or symlink in package path: {file}")
    catalog = json.loads((ROOT / CATALOG_TEMPLATE).read_text(encoding="utf-8"))
    output = Path(output).absolute()
    if output != ROOT / ".build" or output.resolve() != output:
        raise ValueError("Output must be the repository .build directory, without symlinks")
    revision_result = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True, capture_output=True)
    revision = revision_result.stdout.strip() if revision_result.returncode == 0 else None
    dirty = bool(subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=normal"],
                                        cwd=ROOT, encoding="utf-8").strip()) or revision is None
    if output.exists():
        shutil.rmtree(output)
    plugin = output / "marketplace/plugins/1c-ai-core"
    plugin.mkdir(parents=True)
    for relative in paths:
        target = plugin / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / relative, target)
    manifest = {**manifest, "version": version}
    json_write(plugin / "plugin.json", manifest)
    # Codex marketplace metadata; keep the universal manifest for CLI tooling.
    codex = {key: value for key, value in manifest.items() if key not in {"$schema", "extensions"}}
    codex.update(manifest.get("extensions", {}).get("com.openai", {}))
    codex["skills"] = "./skills/"
    codex["mcpServers"] = "./mcp.json"
    json_write(plugin / ".codex-plugin/plugin.json", codex)
    json_write(plugin / "build-info.json", {
        "plugin": "1c-ai-core", "version": version, "profile": "release",
        "revision": revision, "dirty": dirty, "runId": os.environ.get("GITHUB_RUN_ID"),
    })
    source_url = "https://github.com/ShadobaAI/edt-ai-core"
    if revision:
        source_url += f"/tree/{revision}"
    source_notice = (
        f"# Source code\n\n1C AI Core {version}\n\n{source_url}\n\n"
        "Copyright (c) 2026 ShadobaAI and contributors.\n\n"
        "This Source Code Form is subject to the terms of the Mozilla Public "
        "License, v. 2.0. See LICENSE and NOTICE.md.\n"
    )
    if dirty:
        source_notice += (
            "\nThis local build includes uncommitted changes or has no base commit. "
            "The source link does not identify its complete contents.\n"
        )
    (plugin / "SOURCE.md").write_text(source_notice, encoding="utf-8")
    catalog["plugins"][0]["policy"]["installation"] = "AVAILABLE"
    marketplace = output / "marketplace"
    json_write(marketplace / ".agents/plugins/marketplace.json", catalog)
    archive(plugin, output / f"1c-ai-core-{version}.zip", "1c-ai-core/")
    archive(marketplace, output / f"1c-ai-core-{version}-marketplace.zip")
    zips = sorted(output.glob("*.zip"))
    (output / "SHA256SUMS").write_text("".join(
        f"{hashlib.sha256(file.read_bytes()).hexdigest()}  {file.name}\n" for file in zips
    ), encoding="utf-8")
    print(json.dumps({"plugin": str(plugin), "archives": [str(file) for file in zips]}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", help="Local override; stable release CI uses its triggering tag")
    args = parser.parse_args()
    package(ROOT / ".build", args.version)
