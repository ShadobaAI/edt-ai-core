#!/usr/bin/env bash
# Temporary development entrypoint. Builds locally; never publishes.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
node tools/vendor.mjs
node tools/package-plugin.mjs "$@"
