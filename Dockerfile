#  — Stage 0: System tools for runtime (unzip, zip) —
# Use the same Debian version as distroless/base-debian12 (bookworm)
#
# 运行时依赖登记(distroless 极简,这些二进制/库不在基础镜像里,须显式 bund 或接受降级):
#   - zip/unzip:备份导出 pc-server/backup/zip.ts:146 在非 Windows 平台 spawn `zip` CLI ——
#     缺它导出即崩。本 Stage bund 进镜像(见下)。
#   - fc-list(fontconfig):系统字体枚举 pc-server/assets/fonts.ts:176 —— 未 bund,缺失时
#     静默回退内置兜底清单,PDF 导出可选字体变少,不致命。
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

# react-dom 19.2.4 的 server.bun.js 缺 renderToPipeableStream,用 node 入口覆盖它。
RUN cd node_modules/react-dom && cp server.node.js server.bun.js

# web-ui 的 @server/* 路径别名解析到 ../pc-server(见 web-ui/tsconfig.json paths):
# tsc 用它做类型对齐,Rollup 经 vite-tsconfig-paths 也按它解析【值导入】(如
# @server/tools/ask-user)。web-ui 必须与 pc-server 源码平铺为兄弟目录才能构建——
# 此前 pc-server 只在下面才 COPY,vite 一遇到值导入就 Rollup failed to resolve。
# node_modules 排除:web-ui 的 bun install 装在 /build/node_modules,绝不能被这次
# COPY 覆盖成宿主目录里的 Windows 依赖(布局:/build/node_modules 在,COPY pc-server
# 只会新增 pc-server/ 子目录)。
COPY pc-server/ ../build/pc-server/
RUN bun run build

# pi/ 是 gitignore 的本地浅克隆(vendored 源码),不进构建上下文。pc-server 直接
# import 其 TS 源码,缺它 bun build --compile 第一步解析 import 即失败。
# 按 CLAUDE.md「pi vendor 维护手册」重建:浅克隆上游基线 + 应用 pi-patches/*.patch。
# --no-install-recommends 防止 bookworm-slim 带 ca-certificates 缺失导致 https clone 失败。
# 装 pi 自己的依赖(proper-lockfile/typebox/openai 等,bun build 会把它们一并打包)。
#
# 模型数据走 pi-model-data/ 快照(host 仓库 tracked,与 Dockerfile 的 pi pin 配对),
# 不跑 generate-models:上游生成器是破坏性的(先删全部 *.models.ts 分片再按
# models.dev 【当天】状态重建)——第三方数据漂移(实测 2026-09:kimi-for-coding 被
# models.dev 摘除)会让 tracked 分片被删后无人重建,或聚合器引用的 data/*.json
# 缺失,bun build 解析 import 即失败:每次构建都在赌 models.dev 的实时状态。
# 快照 = 本地 pi/(pin 基线 + 补丁)生成的 data/ 原样拷贝,与 39 个 tracked 分片
# 严格配对,构建从此可复现。pi 升级换基线时:本地 pi 重跑 bun run generate-models
# (它产出与新版分片配对的 data/),再刷新本目录快照(升级流程第 2 步刷新 patches
# 的同款时机)。
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY pi-patches/ ./pi-patches/
COPY pi-model-data/ ./pi-model-data/
RUN git clone --filter=blob:none --no-checkout https://github.com/earendil-works/pi.git pi && \
    cd pi && \
    git checkout d981de1229ef899957bbe968bc8dcda02a21f477 && \
    git reset --hard && \
    git apply ../pi-patches/*.patch && \
    bun install && \
    mkdir -p packages/ai/src/providers/data && \
    cp ../pi-model-data/*.json ../pi-model-data/.manifest.json packages/ai/src/providers/data/

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
# 容器内端口钉在 8080(镜像契约:EXPOSE/用户的 -p 8080:8080 映射/README nginx 示例)。
# Podman 放的是 /run/.containerenv 而非 /.dockerenv,服务端容器检测在 Podman 下不成立,
# 会把这类实例误判成桌面形态换用冷门默认端口——ENV PORT 与检测构成双保险。优先级:
# --port > -e PORT > 本值,用户显式覆盖仍然生效。
ENV PORT=8080
EXPOSE 8080

ENTRYPOINT ["./rikkahub-pc", "--no-open"]
