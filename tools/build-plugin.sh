#!/usr/bin/env bash
# Temporary development entrypoint. Builds locally; never publishes.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -n "${PYTHON:-}" ]]; then
  python_command=("$PYTHON")
elif command -v python3 >/dev/null 2>&1 && python3 -c 'import sys; assert sys.version_info >= (3, 10)' >/dev/null 2>&1; then
  python_command=(python3)
elif command -v python >/dev/null 2>&1 && python -c 'import sys; assert sys.version_info >= (3, 10)' >/dev/null 2>&1; then
  python_command=(python)
else
  echo 'Python 3.10+ is required. Set PYTHON to its executable path.' >&2
  exit 1
fi
"${python_command[@]}" "$ROOT/tools/package-plugin.py" "$@"
