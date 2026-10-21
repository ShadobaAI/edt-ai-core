#!/usr/bin/env bash
# Temporary development entrypoint. Builds locally; never publishes.
set -euo pipefail

pause_on_exit() {
  local exit_code=$?
  if [[ -t 0 ]]; then
    read -r -p "Press Enter to exit..." || true
  fi
  exit "$exit_code"
}
trap pause_on_exit EXIT

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
node tools/vendor.mjs
node tools/package-plugin.mjs "$@"
