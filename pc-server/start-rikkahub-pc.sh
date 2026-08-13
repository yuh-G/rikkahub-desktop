#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$SCRIPT_DIR/../dist/rikkahub-app"
if [ -x "$APP_DIR/rikkahub" ]; then
  exec "$APP_DIR/rikkahub" "$@"
fi
EXE="$SCRIPT_DIR/../dist/rikkahub-pc"
if [ -x "$EXE" ]; then
  exec "$EXE" "$@"
fi
echo "错误：未找到编译产物，请先运行 web-ui/src-tauri/build-linux.sh" >&2
exit 1
