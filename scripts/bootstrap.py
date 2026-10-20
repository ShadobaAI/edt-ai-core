#!/usr/bin/env python3
"""Prepare Python dependencies internally, then enter a managed plugin service."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import venv

ROOT = Path(__file__).resolve().parents[1]


def state_root():
    if os.environ.get("EDT_AI_STATE_DIR"):
        return Path(os.environ["EDT_AI_STATE_DIR"]).resolve()
    return Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")) / "1c-ai-core"


def ensure_python(state):
    state.mkdir(parents=True, exist_ok=True)
    # Developers may already provide a prepared environment. No network is needed.
    if all(importlib.util.find_spec(name) for name in ("yaml", "jsonschema")):
        return Path(sys.executable)
    folder = state / "python"
    python = folder / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    ready = folder / ".core-ready"
    if ready.exists() and python.is_file():
        return python
    lock = state / "python-setup.lock"
    deadline = time.monotonic() + 120
    while True:
        try:
            descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.close(descriptor)
            break
        except FileExistsError:
            if time.monotonic() > deadline:
                raise RuntimeError("Подготовка Python занята другим процессом. Повторите подключение.")
            time.sleep(.2)
            if ready.exists() and python.is_file():
                return python
    try:
        venv.EnvBuilder(with_pip=True).create(folder)
        command = [str(python), "-m", "pip", "install", "--disable-pip-version-check",
                   "-r", str(ROOT / "requirements.txt")]
        subprocess.run(command, check=True, stdout=sys.stderr, timeout=150)
        ready.write_text("0.1.1", encoding="ascii")
        return python
    finally:
        lock.unlink(missing_ok=True)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--component", choices=["code-index", "bsl-ls"])
    p.add_argument("--backend", action="store_true")
    p.add_argument("--direct", action="store_true")
    p.add_argument("--settings")
    args = p.parse_args()
    state = state_root()
    python = ensure_python(state)
    env = dict(os.environ)
    env["PYTHONUTF8"] = "1"
    env.setdefault("EDT_AI_STATE_DIR", str(state))
    env.setdefault("EDT_AI_SETTINGS", str(state / "settings.json"))
    if args.settings:
        env["EDT_AI_SETTINGS"] = args.settings
    if args.backend:
        command = [str(python), str(ROOT / "scripts/settings_backend.py")]
    elif args.component:
        service = "managed_mcp.py" if args.direct else "lazy_mcp.py"
        command = [str(python), str(ROOT / "scripts" / service), "--component", args.component]
    else:
        raise RuntimeError("Missing service")
    # Wait for the child: Windows exec emulation can close a short-lived backend
    # pipe before the host has received its final response.
    raise SystemExit(subprocess.call(command, env=env))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"1c-ai-core: {exc}", file=sys.stderr)
        raise SystemExit(1)

