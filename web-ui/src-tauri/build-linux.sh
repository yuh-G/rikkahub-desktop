#!/usr/bin/env bash
# 一键构建 Linux Tauri 版 Rikkahub(与 Windows 的 tauri-msvc.cmd 对应):
#   1. 安装前端依赖 + react-dom server bundle 替换(与 CI/Dockerfile 同处理,
#      Bun 自带 server.bun.js 缺 renderToPipeableStream,某些环境下 build 会报错)
#   2. tauri:build:linux = 编译 sidecar(bun --compile → src-tauri/binaries/) + 构建 SPA
#      + cargo release 构建 Tauri 壳(--no-bundle;Linux 官方产物是便携目录而非 deb/rpm,
#      因为那些格式把资源放到 usr/lib/<product>/,而 sidecar 约定从自身同目录读 web-ui)
#   3. 组装便携目录 dist/rikkahub-app/ 并打 tar.gz(自动更新按
#      Rikkahub_<version>_linux_x64.tar.gz 命名约定匹配,不能改名)
#
# 前置要求: bun 1.1+、Rust stable、Tauri v2 Linux 系统依赖
#   Debian/Ubuntu: sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev \
#     javascriptcoregtk-4.1-dev librsvg2-dev patchelf
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "==> [1/3] 安装前端依赖 + react-dom 替换"
cd "$ROOT_DIR/web-ui"
bun install
rm -f node_modules/react-dom/server.bun.js
ln -sf server.node.js node_modules/react-dom/server.bun.js
rm -f node_modules/react-dom/cjs/react-dom-server.bun.development.js
ln -sf react-dom-server.node.development.js node_modules/react-dom/cjs/react-dom-server.bun.development.js
rm -f node_modules/react-dom/cjs/react-dom-server.bun.production.js
ln -sf react-dom-server.node.production.js node_modules/react-dom/cjs/react-dom-server.bun.production.js

echo "==> [2/3] 构建 Linux Tauri 版(编译 sidecar + SPA + 壳)"
bun run tauri:build:linux

echo "==> [3/3] 组装便携目录 + tar.gz"
RELEASE_DIR="$ROOT_DIR/dist"
APP_DIR="$RELEASE_DIR/rikkahub-app"
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/web-ui/build"
cp "$ROOT_DIR/web-ui/src-tauri/target/release/rikkahub" "$APP_DIR/rikkahub"
cp "$ROOT_DIR/web-ui/src-tauri/target/release/rikkahub-server" "$APP_DIR/rikkahub-server"
cp -r "$ROOT_DIR/web-ui/build/client" "$APP_DIR/web-ui/build/client"
cp -r "$ROOT_DIR/fonts" "$APP_DIR/fonts"
cp -r "$ROOT_DIR/icons" "$APP_DIR/icons"
chmod +x "$APP_DIR/rikkahub" "$APP_DIR/rikkahub-server"

# sanity:缺 index.html 时 routeStatic 会回退到 "not built" 提示
test -f "$APP_DIR/web-ui/build/client/index.html"

# 版本号只从 tauri.conf.json 读(不依赖 jq;bun 是前置依赖,必在)
VERSION="$(cd "$ROOT_DIR/web-ui/src-tauri" && bun -e 'console.log(JSON.parse(await Bun.file("tauri.conf.json").text()).version)')"
tar czf "$RELEASE_DIR/Rikkahub_${VERSION}_linux_x64.tar.gz" -C "$RELEASE_DIR" rikkahub-app/
ls -lh "$RELEASE_DIR/Rikkahub_${VERSION}_linux_x64.tar.gz"
echo "完成: $APP_DIR"
