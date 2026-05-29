#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXE="$SCRIPT_DIR/../dist/rikkahub-pc"
if [ ! -f "$EXE" ]; then
  echo "错误：未找到 rikkahub-pc，请先运行 compile:linux"
  exit 1
fi
exec "$EXE" "$@"
