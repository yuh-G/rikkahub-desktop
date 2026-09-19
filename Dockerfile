#  — Stage 0: System tools for runtime (unzip, zip) —
# Use the same Debian version as distroless/base-debian12 (bookworm)
FROM debian:bookworm-slim AS tools
RUN apt-get update && apt-get install -y --no-install-recommends unzip zip && \
    rm -rf /var/lib/apt/lists/*

# Bundle binaries and every shared library they depend on into /tools
RUN mkdir -p /tools/bin && \
    cp /usr/bin/unzip /usr/bin/zip /tools/bin/ && \
    ldd /usr/bin/unzip /usr/bin/zip 2>/dev/null | \
    awk '/=> \// {print $3}' | sort -u | \
    while read -r lib; do \
      install -D "$lib" "/tools$lib"; \
    done

#  — Stage 1: Build —
# --platform=$BUILDPLATFORM ensures Bun runs natively (no QEMU emulation).
# Cross-compilation to TARGETARCH is handled via Bun's --target flag below.
FROM --platform=$BUILDPLATFORM docker.io/oven/bun:1.4.2 AS builder
ARG TARGETARCH

WORKDIR /build

# Install web-ui dependencies (cache layer)
COPY web-ui/package.json web-ui/bun.lock ./
RUN bun install

# Build web-ui SPA
COPY web-ui/ ./

# Build web-ui SPA
COPY web-ui/ ./

# react-dom 19.2.4 的 server.bun.js 缺 renderToPipeableStream,用 node 入口覆盖它。
RUN cd node_modules/react-dom && cp server.node.js server.bun.js

RUN bun run build

# pi/ 是 gitignore 的本地浅克隆(vendored 源码),不进构建上下文。pc-server 直接
# import 其 TS 源码,缺它 bun build --compile 第一步解析 import 即失败。
# 按 CLAUDE.md「pi vendor 维护手册」重建:浅克隆上游基线 + 应用 pi-patches/*.patch。
# --no-install-recommends 防止 bookworm-slim 带 ca-certificates 缺失导致 https clone 失败。
# 装 pi 自己的依赖(proper-lockfile/typebox/openai 等,bun build 会把它们一并打包)。
# packages/ai/src/providers/data/.manifest.json 是构建期生成物、git 不跟踪,
# 由 generate-models 从 models.dev 拉取生成。
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY pi-patches/ ./pi-patches/
RUN git clone --filter=blob:none --no-checkout https://github.com/earendil-works/pi.git pi && \
    cd pi && \
    git checkout 5cd93f688aaab89dbb6dfa4aca535f21796ae185 && \
    git reset --hard && \
    git apply ../pi-patches/*.patch && \
    bun install && \
    cd packages/ai && bun run generate-models

# Compile server — cross-compile to match the runtime platform.
# Lay out a separate /build/pc-server subtree so we don't mix the pc-server lockfile
# with the web-ui one above. We need `bun install` here for one reason only: server.ts
# does `import wasm with { type: "file" }` from ./node_modules/mupdf/dist/mupdf-wasm.wasm,
# and the wasm asset has to actually exist on disk so bun --compile can bundle it into the
# final exe. After install the wasm is at /build/pc-server/node_modules/mupdf/dist/...
WORKDIR /build/pc-server
COPY pc-server/package.json pc-server/bun.lock ./
RUN bun install
# 重构后 server.ts 依赖 pc-server 下数十个本地模块(收官审查 P0-3:只 COPY server.ts
# 会让 bun build 解析 import 直接失败)。整目录复制;node_modules 由上面的 bun install
# 在镜像内重建(.dockerignore 排除宿主 node_modules,避免 Windows 依赖覆盖 Linux 依赖)。
COPY pc-server/ ./
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) BUN_TARGET=bun-linux-x64 ;; \
      arm64) BUN_TARGET=bun-linux-arm64 ;; \
      *) echo "Unsupported TARGETARCH: $TARGETARCH"; exit 1 ;; \
    esac; \
    bun build --compile --target="$BUN_TARGET" server.ts --outfile rikkahub-pc

#  — Stage 2: Runtime —
FROM gcr.io/distroless/base-debian12
WORKDIR /app

COPY --from=tools /tools/ /
COPY --from=builder /build/pc-server/rikkahub-pc ./
COPY --from=builder /build/build/client/ ./web-ui/build/client/
# 8-5:品牌图标与内置字体随镜像分发(Tauri 形态经 bundle resources 携带,Docker 需显式拷)
COPY icons/ ./icons/
COPY fonts/ ./fonts/

VOLUME ["/app/pc-data"]
EXPOSE 8080

ENTRYPOINT ["./rikkahub-pc", "--no-open"]
