#!/usr/bin/env python3
"""Host-owned stdio MCP: ensure runtime, start scoped server, relay protocol."""
import argparse
import os
import subprocess
import sys
import threading
from common import settings, state_path
from runtime import launch_command, project


def serve(component, root, state, config):
    root, data = project(root, config)
    from project_context import effective_settings
    config = effective_settings(config, root, data, state=state)
    command, cwd, env = launch_command(state, config, component, root, data)
    child = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.PIPE,
                             stdout=subprocess.PIPE, stderr=None,
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    def forward_input():
        try:
            for line in sys.stdin.buffer:
                child.stdin.write(line)
                child.stdin.flush()
        except (BrokenPipeError, OSError):
            pass
        finally:
            try:
                child.stdin.close()
            except OSError:
                pass
    threading.Thread(target=forward_input, daemon=True).start()
    try:
        for line in child.stdout:
            sys.stdout.buffer.write(line)
            sys.stdout.buffer.flush()
        return child.wait()
    finally:
        if child.poll() is None:
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(child.pid), "/T", "/F"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            else:
                child.terminate()
            child.wait(timeout=10)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--component", required=True, choices=["code-index", "bsl-ls"])
    p.add_argument("--project-root")
    p.add_argument("--state-dir")
    p.add_argument("--settings")
    a = p.parse_args()
    config = settings(a.settings)
    return serve(a.component, a.project_root, state_path(config, a.state_dir), config)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"1c-ai-core: {exc}", file=sys.stderr)
        raise SystemExit(1)

