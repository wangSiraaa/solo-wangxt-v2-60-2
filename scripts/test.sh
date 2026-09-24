#!/usr/bin/env bash
# Run the full test suite against real file-backed SQLite databases.
set -euo pipefail
cd "$(dirname "$0")/.."
exec python3 -m pytest "$@"
