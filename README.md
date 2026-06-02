<div align="center">
  <img src="docs/icon.png" alt="App Icon" width="100" />
  <h1>Rikkahub</h1>

  A native Windows LLM chat client that supports switching between different providers
  for conversations 🤖💬

  Reconstructed on top of [Android edition of Rikkahub](https://github.com/rikkahub/rikkahub) by RE.

  [简体中文](README_ZH_CN.md) | [繁體中文](README_ZH_TW.md) | English
</div>

## 🚀 Download

Grab the latest installer from the
[Releases](https://github.com/yuh-G/rikkahub-desktop/releases) page and double-click
`Rikkahub_X.X.X_x64-setup.exe`. The wizard:

- Asks where to install the program (default: `%LOCALAPPDATA%\Rikkahub\`,
  **no admin rights required**)
- Asks where to keep your data — conversations, settings, uploaded files (default:
  `<install dir>\pc-data\`; freely movable later from the in-app settings)
- Optionally creates Start Menu / Desktop shortcuts
- Ships a WebView2 bootstrapper so the app works on any Win10 1809+ / Win11 machine,
  even without WebView2 pre-installed

Uninstall via Windows "Apps & features". `pc-data/` is yours — back it up if you care.

No telemetry, no admin, no cloud account required. Everything is local.

## ✨ Features

- 🎨 Multiple theme palettes (Claude / RikkaHub / Mono / Custom) + 🌙 dark mode
- 🪟 Native desktop app with a custom titlebar that follows the theme
- 🔄 Multi-provider support: OpenAI / Anthropic / Google Gemini + any OpenAI-compatible endpoint
- 🦙 Local model support via [Ollama](https://ollama.com/) /
  [LM Studio](https://lmstudio.ai/) /
  [llama.cpp server](https://github.com/ggerganov/llama.cpp) — just point an
  OpenAI-compatible provider at `http://localhost:11434/v1`
- 🖼️ Multimodal input: image, PDF, DOCX, plain text
- 🛠️ MCP (Model Context Protocol) Streamable HTTP support
- 📝 Markdown rendering with code highlighting, LaTeX formulas, tables, Mermaid diagrams
- 🪾 Message branching, regeneration, per-branch model switching
- 🔍 17 web-search engines: Tavily, Exa, Brave, Perplexity, Bocha, 智谱, 秘塔, Firecrawl,
  Grok, Ollama, Jina, SearXNG, custom JS, …
- 🔎 Per-model built-in search toggle (Gemini Search Grounding, OpenAI `web_search`)
- 🧠 Per-assistant or global memory tool, plus recent-chat awareness and a time-gap reminder
- 🧩 Prompt template variables (model name, current time, locale, device info, …)
- 🤖 Multiple customizable assistants with their own system prompts, prompt injections,
  world books, quick messages
- 🛠️ Granular per-model configuration: manually add models, set custom request headers /
  custom request bodies / provider overwrite (per-model baseUrl + API Key)
- 🎨 Image generation: gpt-image-2, DALL·E 3, Imagen, Qwen-Image, FLUX, …
- 🎙️ TTS and ASR via Windows SAPI, OpenAI, Gemini, Qwen, Groq, MiniMax, MiMo, **with built-in test buttons**
- 📥 One-click import from Android .zip backups: conversation history, settings, attachments,
  Skills, MCP, prompt injections, world books, quick messages
- 📤 WebDAV and S3-compatible cloud backup, plus JSON import/export
- 🔄 In-app update check: auto-download and install new versions, with full data preservation on upgrade
- 📊 Request log and usage statistics with a daily activity heatmap

## 🏗️ Build from source

Building the installer locally requires:

- [Bun](https://bun.sh/) 1.1+
- [Rust](https://rustup.rs/) toolchain (stable, MSVC target — picked automatically by rustup
  on Windows)
- [Visual Studio Build Tools 2022](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
  with the **"Desktop development with C++"** workload (provides MSVC linker + Windows SDK)

End-user installation requires none of the above — the resulting `.exe` is self-contained.

```powershell
# 1. Compile the embedded backend (Bun --compile → single Windows exe)
cd pc-server
bun run compile

# 2. Copy the freshly compiled sidecar to where Tauri expects it
cp ../dist/rikkahub-pc.exe ../web-ui/src-tauri/binaries/rikkahub-server-x86_64-pc-windows-msvc.exe

# 3. Build the SPA, Tauri shell, and NSIS installer in one go
cd ../web-ui
bun install
./src-tauri/tauri-msvc.cmd build --bundles nsis
```

The shipped installer lands at `dist/Rikkahub_X.X.X_x64-setup.exe`. The wrapper
`tauri-msvc.cmd` activates the MSVC environment and uses an ASCII-only `CARGO_TARGET_DIR`
to work around two Windows quirks (Git Bash's `link.exe` conflict and the project path
containing non-ASCII characters).

### Dev workflow

```powershell
# Backend on http://localhost:8080
cd pc-server
bun run server.ts

# Vite dev server on http://localhost:5173 (proxies /api to :8080)
cd ../web-ui
bun run dev
```

For frontend-only iteration just open `http://localhost:5173` in any browser — the custom
titlebar auto-hides outside the Tauri shell so the SPA stays usable.

### Smoke test

```powershell
cd pc-server
bun run smoke:request-chain
```

Spins up mock provider / MCP / WebDAV / S3 servers and exercises the full request chain.

### Linux binary

Build a self-contained Linux x64 binary (requires only [Bun](https://bun.sh/)):

```bash
# 1. Build the SPA
cd web-ui && bun install && bun run build

# 2. Compile the server binary
cd ../pc-server && bun run compile:linux
# → dist/rikkahub-pc
```

Run it:

```bash
./dist/rikkahub-pc
# Open http://localhost:8080 in your browser
# Data is stored in ./pc-data/
```

**Required system packages** — install before using the relevant features:

| Package | Feature |
|---|---|
| `espeak-ng` | System TTS (text-to-speech tool, voice playback) |
| `xclip` (X11) or `wl-clipboard` (Wayland) | Clipboard read/write tool |
| `unzip`, `zip` | Backup restore / skill import from ZIP |

On Debian/Ubuntu: `sudo apt install espeak-ng xclip unzip zip`  
On Fedora/RHEL: `sudo dnf install espeak-ng xclip unzip zip`

Missing tools are detected at startup and listed as warnings — the server still starts and
all other features remain available.

### Docker

A multi-arch image can be built from the included `Dockerfile`:

```bash
docker build -t rikkahub-pc .
```

Run with persistent data:

```bash
docker run -d \
  --name rikkahub \
  -p 8080:8080 \
  -v ./pc-data:/app/pc-data \
  rikkahub-pc
```

Then open `http://localhost:8080` in your browser. The image uses
`distroless/base-debian12` and bundles `unzip`/`zip`; clipboard and TTS are
not available inside a headless container.


## 🧰 Tech stack

- [Bun](https://bun.sh/) — runtime, bundler, package manager
- [Tauri v2](https://tauri.app/) + Rust — desktop shell (native window, NSIS installer,
  sidecar lifecycle, Job-Object-bound process tree)
- [TypeScript](https://www.typescriptlang.org/) — strict end-to-end typing
- [React 19](https://react.dev/) + [React Router 7](https://reactrouter.com/) — SPA
  (client-only mode)
- [Tailwind CSS v4](https://tailwindcss.com/) + [shadcn/ui](https://ui.shadcn.com/) — styling
- [Zustand](https://zustand-demo.pmnd.rs/) — state management
- [ky](https://github.com/sindresorhus/ky) — HTTP client
- [Lucide](https://lucide.dev/) — icon set
- [i18next](https://www.i18next.com/) — internationalization (zh-CN / en-US)

## 🙏 Credits

This project is a Windows port built on top of the product design, brand, and concepts
of [RikkaHub](https://github.com/rikkahub/rikkahub) by
[@re-ovo](https://github.com/re-ovo). All product direction, naming, and visual identity
belong to the original project.

## ⭐ Star History

If Rikkahub is useful to you, please give it a star ⭐

[![Star History Chart](https://api.star-history.com/svg?repos=yuh-G/rikkahub-pc&type=Date)](https://star-history.com/#yuh-G/rikkahub-desktop&Date)

## 📄 License

[License](LICENSE)
