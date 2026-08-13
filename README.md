<div align="center">
  <img src="docs/icon.png" alt="App Icon" width="100" />
  <h1>Rikkahub</h1>


  
   **Rikkahub is a native Windows LLM client with multi-provider switching for conversations** 🤖💬
  
  — also runs on Linux (native binary or Docker).

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
- Ships a WebView2 bootstrapper so the app works on any Win10 1809+ / Win11 machine,
  even without WebView2 pre-installed

Uninstall via Windows "Apps & features". `pc-data/` is yours — back it up if you care.

No telemetry, no admin, no cloud account required. Everything is local.

Prefer no installer? Each release also ships a portable **.zip** — unzip and run, nothing
else needed.

> **On Linux?** Each release ships a portable `.tar.gz` — the same native Tauri desktop app as
> Windows (native window + custom titlebar), unzip and run.
> Prefer a native distro package, or building from source / running Docker? See
> [Community packages](#-community-packages), [Linux desktop app](#-linux-desktop-app) and [Docker](#docker) below.

## 📦 Community packages

Beyond the official `tar.gz`, the community maintains native packages for several Linux
distributions. **These are maintained by their respective authors, not this project**, and may
lag behind the latest release — for packaging issues please report upstream to the maintainer.

| Distribution | How to install | Maintainer |
|---|---|---|
| Debian / Ubuntu / Mint | `.deb` from the [Releases](https://github.com/yuh-G/rikkahub-desktop/releases) page or [Cloud drive](https://1842911757.share.123pan.cn/123pan/oW0UTd-irzxh) → `sudo apt install ./rikkahub-pc_*_amd64.deb` | [@Noah0932](https://github.com/Noah0932) |
| Arch / Manjaro | `.pkg.tar.zst` from the [Releases](https://github.com/yuh-G/rikkahub-desktop/releases) page or [Cloud drive](https://1842911757.share.123pan.cn/123pan/oW0UTd-irzxh) → `sudo pacman -U rikkahub-pc-*-x86_64.pkg.tar.zst` | [@Noah0932](https://github.com/Noah0932) |
| NixOS / Nix | `nur.repos.af-nur.rikkahub-desktop` (Built from source, recommended to use the binary cache `af-nur.cachix.org`)<br/>`nur.repos.af-nur.rikkahub-desktop-bin` (Synchronized with binary builds from [Releases](https://github.com/yuh-G/rikkahub-desktop/releases)) | [@AstralFlare-owo](https://github.com/AstralFlare-owo) |

Many thanks to both for covering these distributions.

## ✨ Features

- 🎨 Multiple theme palettes (Claude / RikkaHub / Mono / Custom) + 🌙 dark mode
- 🐧 Runs on Linux too — native Tauri desktop app (same shell as Windows) or multi-arch Docker image (amd64 / arm64)
- 🔄 Multi-provider support: OpenAI / Anthropic / Google Gemini + any OpenAI-compatible endpoint
- 🦙 Local model support via [Ollama](https://ollama.com/) /
  [LM Studio](https://lmstudio.ai/) /
  [llama.cpp server](https://github.com/ggerganov/llama.cpp) — just point an
  OpenAI-compatible provider at `http://localhost:11434/v1`
- 🖼️ Multimodal input: image, PDF, DOCX, PPTX, EPUB, plain text
- 🛠️ MCP (Model Context Protocol) Streamable HTTP support
- 📝 Markdown rendering with code highlighting, LaTeX formulas, tables, Mermaid diagrams
- 🪾 Message branching, regeneration, per-branch model switching
- 🔍 17 web-search engines: Tavily, Exa, Brave, Perplexity, Bocha, 智谱, 秘塔, Firecrawl,
  Grok, Ollama, Jina, SearXNG, custom JS, …
- 🧠 Per-assistant or global memory tool, plus recent-chat awareness and a time-gap reminder
- 🧩 Prompt template variables (model name, current time, locale, device info, …)
- 🤖 Multiple customizable assistants with their own system prompts, prompt injections,
  world books, quick messages
- 🛠️ Granular per-model configuration: manually add models, set custom request headers /
  custom request bodies / provider overwrite (per-model baseUrl + API Key)
- 🎨 Image generation: gpt-image-2, DALL·E 3, Imagen, Qwen-Image, FLUX, …
- 🎙️ TTS and ASR via system speech (Windows SAPI / Linux espeak-ng), OpenAI, Gemini, Qwen, Groq, MiniMax, MiMo
- 📥 One-click import from Android .zip backups: conversation history, settings, attachments,
  Skills, MCP, prompt injections, world books, quick messages
- 📤 WebDAV and S3-compatible cloud backup, plus JSON import/export
- 📊 Request log and usage statistics with a daily activity heatmap

## 💎 Sponsors

The following organizations sponsor Rikkahub's ongoing development. Our thanks to them.

<table>
  <tr>
    <td width="120" align="center">
      <a href="https://naapi.cc">
        <img src="icons/naapi.jpg" width="100" alt="钠API" />
      </a>
    </td>
    <td>
      <a href="https://naapi.cc"><b>钠API</b></a><br/>
      One-stop access to 100+ top global models — ChatGPT, Claude, Gemini and more —
      with competitive pricing and superior stability.
    </td>
  </tr>
</table>

## 🏗️ Build from source

Building the installer locally requires the following — **for developers only**:

- [Bun](https://bun.sh/) 1.1+
- [Rust](https://rustup.rs/) toolchain (stable, MSVC target — picked automatically by rustup
  on Windows)
- [Visual Studio Build Tools 2022](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
  with the **"Desktop development with C++"** workload (provides MSVC linker + Windows SDK)

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

### 🐧 Linux desktop app

The Linux release ships the same Tauri desktop shell as Windows — a native window with the
custom titlebar, single-instance behavior, and a sidecar lifecycle that tears the backend
down when the app exits (even if the shell is hard-killed). The portable `.tar.gz` contains
everything in one self-contained `rikkahub-app/` directory:

```
rikkahub-app/
├── rikkahub            # Tauri shell (native window)
├── rikkahub-server     # Backend (Bun-compiled, serves the SPA over HTTP + SSE)
├── web-ui/build/client # Frontend assets (served at runtime, not embedded)
├── fonts/   icons/
```

Run it:

```bash
tar xzf Rikkahub_X.X.X_linux_x64.tar.gz
./rikkahub-app/rikkahub
# Native window, same UX as Windows. Data is stored in ./rikkahub-app/pc-data/
```

Build from source (requires [Bun](https://bun.sh/) 1.1+, Rust stable, and the
[Tauri v2 Linux system dependencies](https://tauri.app/start/prerequisites/)):

```bash
bash web-ui/src-tauri/build-linux.sh
# → dist/rikkahub-app/                      (run ./dist/rikkahub-app/rikkahub)
# → dist/Rikkahub_<version>_linux_x64.tar.gz (release archive, same layout as the release asset)
```

Debian/Ubuntu build deps:
`sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev javascriptcoregtk-4.1-dev librsvg2-dev patchelf`

> The standalone browser-served build (`pc-server` + `bun run compile:linux`, open
> `http://localhost:8080`) still exists and keeps working — it's just no longer the shipped
> Linux artifact.

**Required runtime packages** — install before using the relevant features:

| Package | Feature |
|---|---|
| `webkit2gtk-4.1` | The GUI itself (native window) |
| `libayatana-appindicator` | System tray (optional — without it the tray is skipped and closing the window quits instead of hiding) |
| `espeak-ng` | System TTS (text-to-speech tool, voice playback) |
| `xclip` (X11) or `wl-clipboard` (Wayland) | Clipboard read/write tool |
| `unzip`, `zip` | Backup restore / skill import from ZIP |

On Debian/Ubuntu: `sudo apt install libwebkit2gtk-4.1-0 libayatana-appindicator3-1 espeak-ng xclip unzip zip`  
On Fedora/RHEL: `sudo dnf install webkit2gtk4.1 libayatana-appindicator espeak-ng xclip unzip zip`

Missing tools are detected at startup and listed as warnings — the app still starts and
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
  -e RIKKAHUB_PASSWORD=your-password \
  rikkahub-pc
```

Then open `http://localhost:8080` in your browser. The image uses
`distroless/base-debian12` and bundles `unzip`/`zip`; clipboard and TTS are
not available inside a headless container.

**Set `RIKKAHUB_PASSWORD` (or pass `--password <password>`) whenever the server
is reachable beyond your own machine** — the container binds `0.0.0.0`, so
without a password anyone on the same network can read your conversations and
API keys. With a password set, the web UI shows an unlock prompt and every API
request requires the issued access token. The desktop app binds `127.0.0.1`
and does not need this.


**Security note for LAN / public deployments:** the AI's `scrape_web` tool fetches
whatever URL the model asks for *from inside the container* — a prompt-injected web page can
steer it into probing internal services or cloud metadata endpoints (SSRF). If that matters in
your network, isolate the container's network or restrict its egress.

### Reverse proxy (nginx)

Two things matter when putting RikkaHub behind a reverse proxy (e.g. for HTTPS):

- **Host passthrough** — the server rejects state-changing requests whose `Origin` header
  doesn't match the request `Host` (CSRF protection). A default `proxy_pass` rewrites
  `Host` to the upstream address, so every POST/DELETE fails with 403 — "the page loads but
  nothing saves". Forward the original host with `proxy_set_header Host $host`.
- **Streaming** — SSE responses carry `X-Accel-Buffering: no`, which makes nginx disable
  response buffering for them automatically; `proxy_buffering off` is only a fallback for
  proxies that ignore the header.

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    server_name rikka.example.com;
    # ssl_certificate ...; ssl_certificate_key ...;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;              # keep the Origin/Host CSRF check working
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;   # WebSocket (voice input)
        proxy_set_header Connection $connection_upgrade;
        proxy_buffering off;                      # fallback; SSE already sends X-Accel-Buffering: no
        proxy_read_timeout 1h;                    # long-lived SSE / generation streams
        client_max_body_size 0;                   # backup restore uploads can be hundreds of MB
    }
}
```

Set `RIKKAHUB_PASSWORD` whenever the proxy makes the server reachable beyond localhost.

## 🧰 Tech stack

- [Bun](https://bun.sh/) — runtime, bundler, package manager
- [Tauri v2](https://tauri.app/) + Rust — desktop shell (native window, custom titlebar, NSIS
  installer, sidecar lifecycle; Job Object on Windows / parent-PID watchdog on Linux so the
  backend dies with the shell)
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
[@re-ovo](https://github.com/re-ovo).

## ⭐ Star History

If Rikkahub is useful to you, please give it a star ⭐

[![Star History Chart](https://api.star-history.com/svg?repos=yuh-G/rikkahub-pc&type=Date)](https://star-history.com/#yuh-G/rikkahub-desktop&Date)

## 📄 License

[License](LICENSE)
