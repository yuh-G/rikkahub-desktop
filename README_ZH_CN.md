<div align="center">
  <img src="docs/icon.png" alt="App 图标" width="100" />
  <h1>Rikkahub</h1>

  Rikkahub 是一个原生 Windows 桌面 LLM 聊天客户端，支持切换不同的供应商进行聊天 🤖💬
  —— 同时也能在 Linux 上运行（原生二进制或 Docker）。

  依赖作者 RE 构建的 [Android 版 Rikkahub](https://github.com/rikkahub/rikkahub) 重构而成。

  [English](README.md) | [繁體中文](README_ZH_TW.md) | 简体中文
</div>

## 🚀 下载

到 [Releases](https://github.com/yuh-G/rikkahub-desktop/releases) 页面下载最新的安装包，
双击 `Rikkahub_X.X.X_x64-setup.exe`。安装向导会让你选择：

- 程序安装路径（默认 `%LOCALAPPDATA%\Rikkahub\`，**无需管理员权限**）
- 数据保存目录——会话、配置、上传文件（默认 `<安装目录>\pc-data\`，安装完后也可以在应用内
  「设置 → 数据设置」里随时换位置）
- 是否创建开始菜单 / 桌面快捷方式
- 自带 WebView2 引导器：Win10 1809+ / Win11 即使没装 WebView2 也能跑

卸载从 Windows「应用与功能」走。`pc-data/` 里的内容是你的，需要可以自行备份。

无遥测、无管理员权限、无云端账号，**一切在本地完成**。

> **用 Linux？** 目前还没有预编译的下载包——可以从源码编译原生二进制，或直接跑 Docker 镜像。
> 详见下方 [Linux 二进制](#-linux-二进制) 与 [Docker](#docker) 两节。

## ✨ 功能特色

- 🎨 多套主题色（Claude / RikkaHub / Mono / 自定义）+ 🌙 深色模式
- 🪟 原生桌面应用 + 自定义标题栏，跟着主题走
- 🐧 同样支持 Linux —— 自带依赖的原生二进制，或多架构 Docker 镜像（amd64 / arm64）
- 🔄 多种供应商支持：OpenAI / Anthropic / Google Gemini + 任意 OpenAI 兼容接口
- 🦙 开箱即用的本地模型支持：通过 [Ollama](https://ollama.com/) /
  [LM Studio](https://lmstudio.ai/) /
  [llama.cpp server](https://github.com/ggerganov/llama.cpp)，
  把 OpenAI 兼容供应商指向 `http://localhost:11434/v1` 即可
- 🖼️ 多模态输入：图片、PDF、DOCX、纯文本
- 🛠️ MCP（Model Context Protocol）Streamable HTTP 支持
- 📝 Markdown 渲染：代码高亮、LaTeX 数学公式、表格、Mermaid 图
- 🪾 消息分支、重新生成、分支独立换模型
- 🔍 17 种联网搜索：Tavily、Exa、Brave、Perplexity、博查、智谱、秘塔、Firecrawl、Grok、
  Ollama、Jina、SearXNG、自定义 JS、…
- 🔎 模型内置搜索开关（Gemini Search Grounding、OpenAI `web_search`）
- 🧠 助手级或全局共享的记忆工具，支持参考最近聊天 + 长时间无消息后自动注入时间提醒
- 🧩 Prompt 模板变量（模型名称、当前时间、地区、设备信息……）
- 🤖 多助手自定义：独立 System Prompt、提示词注入、世界书、快捷消息
- 🛠️ 模型精细化配置：手动添加模型，每个模型可设自定义请求头 / 请求体 / 供应商覆盖（per-model
  baseUrl + API Key）
- 🎨 图像生成：gpt-image-2、DALL·E 3、Imagen、Qwen-Image、FLUX、…
- 🎙️ TTS 与 ASR：系统语音（Windows SAPI / Linux espeak-ng）、OpenAI、Gemini、Qwen、Groq、MiniMax、MiMo，**带测试按钮**
- 📥 一键导入 Android 端 .zip 备份：对话历史、设置、附件、Skills、MCP、提示词注入、世界书、快捷消息
- 📤 WebDAV 与 S3 兼容云端备份，JSON 导入导出
- 🔄 应用内检查更新：自动下载安装新版本，覆盖安装保留所有数据
- 📊 请求日志与每日活动热力图统计

## 🏗️ 从源码构建

本地打包安装器需要以下工具——**只是给开发者用的，终端用户装 exe 完全不需要这些**：

- [Bun](https://bun.sh/) 1.1+
- [Rust](https://rustup.rs/) 工具链（stable，Windows 下 rustup 默认选 MSVC target）
- [Visual Studio Build Tools 2022](https://visualstudio.microsoft.com/visual-cpp-build-tools/) +
  **"使用 C++ 的桌面开发"** 工作负载（提供 MSVC linker 和 Windows SDK）

```powershell
# 1. 编译嵌入的后端服务（Bun --compile → 单文件 Windows exe）
cd pc-server
bun run compile

# 2. 把刚编出的 sidecar 拷到 Tauri 指定位置
cp ../dist/rikkahub-pc.exe ../web-ui/src-tauri/binaries/rikkahub-server-x86_64-pc-windows-msvc.exe

# 3. 一并构建前端、Tauri 壳和 NSIS 安装包
cd ../web-ui
bun install
./src-tauri/tauri-msvc.cmd build --bundles nsis
```

最终安装包在 `dist/Rikkahub_X.X.X_x64-setup.exe`。包装脚本 `tauri-msvc.cmd` 在调用 cargo 前
激活 MSVC 环境、并把 `CARGO_TARGET_DIR` 设到 ASCII 路径，用来绕开两个 Windows 开发坑：
Git Bash 的 `link.exe` 跟 MSVC 链接器冲突，以及项目路径含非 ASCII 字符导致 build 失败。

### 开发流程

```powershell
# 后端在 http://localhost:8080
cd pc-server
bun run server.ts

# 前端 Vite dev server 在 http://localhost:5173（自动把 /api 代理到 :8080）
cd ../web-ui
bun run dev
```

只调前端时直接浏览器打开 `http://localhost:5173` 即可——自定义标题栏在非 Tauri 环境下会
自动隐藏，整套 UI 在浏览器里也能用。

### 烟雾测试

```powershell
cd pc-server
bun run smoke:request-chain
```

会拉起 mock 供应商 / MCP / WebDAV / S3 服务，跑一遍完整的请求链路。

### 🐧 Linux 二进制

编译一个自带依赖的 Linux x64 原生二进制（只需要 [Bun](https://bun.sh/)）：

```bash
# 1. 构建前端 SPA
cd web-ui && bun install && bun run build

# 2. 编译后端二进制
cd ../pc-server && bun run compile:linux
# → dist/rikkahub-pc
```

运行：

```bash
./dist/rikkahub-pc
# 浏览器打开 http://localhost:8080
# 数据保存在 ./pc-data/
```

**需要的系统包** —— 用到对应功能前安装即可：

| 系统包 | 对应功能 |
|---|---|
| `espeak-ng` | 系统语音播报（TTS 工具、语音播放） |
| `xclip`（X11）或 `wl-clipboard`（Wayland） | 剪贴板读写工具 |
| `unzip`、`zip` | 备份恢复 / 从 ZIP 导入 Skill |

Debian/Ubuntu：`sudo apt install espeak-ng xclip unzip zip`  
Fedora/RHEL：`sudo dnf install espeak-ng xclip unzip zip`

缺失的工具会在启动时被检测并以警告列出——服务照常启动，其它功能不受影响。

### Docker

用项目自带的 `Dockerfile` 可以构建多架构镜像：

```bash
docker build -t rikkahub-pc .
```

带持久化数据运行：

```bash
docker run -d \
  --name rikkahub \
  -p 8080:8080 \
  -v ./pc-data:/app/pc-data \
  rikkahub-pc
```

然后浏览器打开 `http://localhost:8080`。镜像基于 `distroless/base-debian12`，已内置
`unzip`/`zip`；剪贴板和 TTS 在无头容器内不可用。

## 🧰 技术栈

- [Bun](https://bun.sh/) —— 运行时、打包器、包管理器
- [Tauri v2](https://tauri.app/) + Rust —— 桌面壳（原生窗口、NSIS 安装器、sidecar 生命周期、
  Job Object 绑定保证父进程异常退出时子进程也一并清理）
- [TypeScript](https://www.typescriptlang.org/) —— 严格类型，前后端一致
- [React 19](https://react.dev/) + [React Router 7](https://reactrouter.com/) —— SPA（纯客户端模式）
- [Tailwind CSS v4](https://tailwindcss.com/) + [shadcn/ui](https://ui.shadcn.com/) —— 样式与组件
- [Zustand](https://zustand-demo.pmnd.rs/) —— 状态管理
- [ky](https://github.com/sindresorhus/ky) —— HTTP 客户端
- [Lucide](https://lucide.dev/) —— 图标集
- [i18next](https://www.i18next.com/) —— 国际化（zh-CN / en-US）

## 🙏 致谢

本项目是基于 [@re-ovo](https://github.com/re-ovo) 的
[RikkaHub](https://github.com/rikkahub/rikkahub) 产品设计、品牌与理念在 Windows 平台上的
移植版。所有产品方向、名称与视觉资产归原项目所有。

## ⭐ Star History

如果 Rikkahub 对你有帮助，欢迎点个 Star ⭐

[![Star History Chart](https://api.star-history.com/svg?repos=yuh-G/rikkahub-pc&type=Date)](https://star-history.com/#yuh-G/rikkahub-desktop&Date)

## 📄 许可证

[License](LICENSE)
