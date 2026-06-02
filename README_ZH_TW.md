<div align="center">
  <img src="docs/icon.png" alt="App 圖示" width="100" />
  <h1>Rikkahub</h1>

  Rikkahub 是一個原生 Windows 桌面 LLM 聊天客戶端，支援切換不同的供應商進行對話 🤖💬
  —— 同時也能在 Linux 上執行（原生二進位檔或 Docker）。

  基於作者 RE 構建的 [Android 版 Rikkahub](https://github.com/rikkahub/rikkahub) 重構而成。

  [English](README.md) | 繁體中文 | [简体中文](README_ZH_CN.md)
</div>

## 🚀 下載

到 [Releases](https://github.com/yuh-G/rikkahub-desktop/releases) 頁面下載最新的安裝包，
雙擊 `Rikkahub_X.X.X_x64-setup.exe`。安裝精靈會讓你選擇：

- 程式安裝路徑（預設 `%LOCALAPPDATA%\Rikkahub\`，**不需要管理員權限**）
- 資料儲存目錄——對話、設定、上傳檔案（預設 `<安裝目錄>\pc-data\`，安裝完成後也可以在應用內
  「設定 → 資料設定」隨時更換位置）
- 是否建立開始功能表 / 桌面捷徑
- 內建 WebView2 引導器：Win10 1809+ / Win11 即使未安裝 WebView2 也能執行

解除安裝從 Windows「應用程式與功能」進行。`pc-data/` 的內容屬於你，需要請自行備份。

無遙測、不需要管理員權限、不需要雲端帳號，**一切都在本機完成**。

> **使用 Linux？** 目前還沒有預先編譯的下載包——可以從原始碼建置原生二進位檔，或直接執行 Docker
> 映像。詳見下方 [Linux 二進位檔](#-linux-二進位檔) 與 [Docker](#docker) 兩節。

## ✨ 功能特色

- 🎨 多套主題色（Claude / RikkaHub / Mono / 自訂）+ 🌙 深色模式
- 🪟 原生桌面應用 + 自訂標題列，會跟著主題色變化
- 🐧 同樣支援 Linux —— 自帶相依套件的原生二進位檔，或多架構 Docker 映像（amd64 / arm64）
- 🔄 多種供應商支援：OpenAI / Anthropic / Google Gemini + 任意 OpenAI 相容介面
- 🦙 開箱即用的本地模型支援：透過 [Ollama](https://ollama.com/) /
  [LM Studio](https://lmstudio.ai/) /
  [llama.cpp server](https://github.com/ggerganov/llama.cpp)，
  把 OpenAI 相容供應商指向 `http://localhost:11434/v1` 即可
- 🖼️ 多模態輸入：圖片、PDF、DOCX、純文字
- 🛠️ MCP（Model Context Protocol）Streamable HTTP 支援
- 📝 Markdown 渲染：程式碼高亮、LaTeX 數學公式、表格、Mermaid 圖
- 🪾 訊息分支、重新生成、分支獨立切換模型
- 🔍 17 種網路搜尋：Tavily、Exa、Brave、Perplexity、博查、智譜、秘塔、Firecrawl、Grok、
  Ollama、Jina、SearXNG、自訂 JS、…
- 🔎 模型內建搜尋開關（Gemini Search Grounding、OpenAI `web_search`）
- 🧠 助理層級或全域共用的記憶工具，支援參考最近對話 + 長時間無訊息後自動注入時間提醒
- 🧩 Prompt 範本變數（模型名稱、目前時間、地區、裝置資訊……）
- 🤖 多助理自訂：獨立 System Prompt、提示詞注入、世界書、快捷訊息
- 🛠️ 模型精細化配置：手動新增模型，每個模型可設自訂請求標頭 / 請求內容 / 供應商覆寫（per-model
  baseUrl + API Key）
- 🎨 圖像生成：gpt-image-2、DALL·E 3、Imagen、Qwen-Image、FLUX、…
- 🎙️ TTS 與 ASR：系統語音（Windows SAPI / Linux espeak-ng）、OpenAI、Gemini、Qwen、Groq、MiniMax、MiMo，**內建測試按鈕**
- 📥 一鍵匯入 Android 端 .zip 備份：對話歷史、設定、附件、Skills、MCP、提示詞注入、世界書、快捷訊息
- 📤 WebDAV 與 S3 相容雲端備份，JSON 匯入匯出
- 🔄 應用內檢查更新：自動下載並安裝新版本，覆蓋安裝完整保留資料
- 📊 請求日誌與每日活動熱力圖統計

## 🏗️ 從原始碼建置

本機打包安裝器需要以下工具——**這只是開發者需要的，終端使用者執行安裝包完全不需要**：

- [Bun](https://bun.sh/) 1.1+
- [Rust](https://rustup.rs/) 工具鏈（stable，Windows 下 rustup 預設選擇 MSVC target）
- [Visual Studio Build Tools 2022](https://visualstudio.microsoft.com/visual-cpp-build-tools/) +
  **「使用 C++ 的桌面開發」** 工作負載（提供 MSVC linker 和 Windows SDK）

```powershell
# 1. 編譯嵌入的後端服務（Bun --compile → 單檔 Windows exe）
cd pc-server
bun run compile

# 2. 把剛編好的 sidecar 複製到 Tauri 指定的位置
cp ../dist/rikkahub-pc.exe ../web-ui/src-tauri/binaries/rikkahub-server-x86_64-pc-windows-msvc.exe

# 3. 一併建置前端、Tauri 殼與 NSIS 安裝包
cd ../web-ui
bun install
./src-tauri/tauri-msvc.cmd build --bundles nsis
```

最終的安裝包位於 `dist/Rikkahub_X.X.X_x64-setup.exe`。包裝指令稿 `tauri-msvc.cmd` 在呼叫
cargo 之前啟用 MSVC 環境，並把 `CARGO_TARGET_DIR` 指向 ASCII 路徑，用來繞開兩個 Windows
開發坑：Git Bash 的 `link.exe` 與 MSVC 連結器衝突、以及專案路徑包含非 ASCII 字元時編譯失敗。

### 開發流程

```powershell
# 後端執行在 http://localhost:8080
cd pc-server
bun run server.ts

# 前端 Vite dev server 執行在 http://localhost:5173（會自動代理 /api 至 :8080）
cd ../web-ui
bun run dev
```

只需要除錯前端時，直接用瀏覽器開啟 `http://localhost:5173` 即可——自訂標題列在非 Tauri
環境下會自動隱藏，整套 UI 在瀏覽器內也能正常使用。

### 煙霧測試

```powershell
cd pc-server
bun run smoke:request-chain
```

會啟動 mock 供應商 / MCP / WebDAV / S3 服務，跑完整的請求鏈路。

### 🐧 Linux 二進位檔

建置一個自帶相依套件的 Linux x64 原生二進位檔（只需要 [Bun](https://bun.sh/)）：

```bash
# 1. 建置前端 SPA
cd web-ui && bun install && bun run build

# 2. 編譯後端二進位檔
cd ../pc-server && bun run compile:linux
# → dist/rikkahub-pc
```

執行：

```bash
./dist/rikkahub-pc
# 瀏覽器開啟 http://localhost:8080
# 資料儲存在 ./pc-data/
```

**需要的系統套件** —— 用到對應功能前安裝即可：

| 系統套件 | 對應功能 |
|---|---|
| `espeak-ng` | 系統語音播報（TTS 工具、語音播放） |
| `xclip`（X11）或 `wl-clipboard`（Wayland） | 剪貼簿讀寫工具 |
| `unzip`、`zip` | 備份還原 / 從 ZIP 匯入 Skill |

Debian/Ubuntu：`sudo apt install espeak-ng xclip unzip zip`  
Fedora/RHEL：`sudo dnf install espeak-ng xclip unzip zip`

缺少的工具會在啟動時被偵測並以警告列出——服務照常啟動，其它功能不受影響。

### Docker

用專案自帶的 `Dockerfile` 可以建置多架構映像：

```bash
docker build -t rikkahub-pc .
```

帶持久化資料執行：

```bash
docker run -d \
  --name rikkahub \
  -p 8080:8080 \
  -v ./pc-data:/app/pc-data \
  rikkahub-pc
```

接著瀏覽器開啟 `http://localhost:8080`。映像基於 `distroless/base-debian12`，已內建
`unzip`/`zip`；剪貼簿和 TTS 在無頭容器內無法使用。

## 🧰 技術棧

- [Bun](https://bun.sh/) —— 執行環境、打包器、套件管理器
- [Tauri v2](https://tauri.app/) + Rust —— 桌面殼（原生視窗、NSIS 安裝器、sidecar 生命週期、
  以 Job Object 綁定子處理程序，父處理程序異常結束時系統會一併清理）
- [TypeScript](https://www.typescriptlang.org/) —— 嚴格型別，前後端一致
- [React 19](https://react.dev/) + [React Router 7](https://reactrouter.com/) —— SPA（純用戶端模式）
- [Tailwind CSS v4](https://tailwindcss.com/) + [shadcn/ui](https://ui.shadcn.com/) —— 樣式與元件
- [Zustand](https://zustand-demo.pmnd.rs/) —— 狀態管理
- [ky](https://github.com/sindresorhus/ky) —— HTTP 用戶端
- [Lucide](https://lucide.dev/) —— 圖示集
- [i18next](https://www.i18next.com/) —— 國際化（zh-CN / en-US）

## 🙏 致謝

本專案是基於 [@re-ovo](https://github.com/re-ovo) 的
[RikkaHub](https://github.com/rikkahub/rikkahub) 產品設計、品牌與概念在 Windows 平台上的
移植版本。所有產品方向、名稱與視覺資產均屬於原專案。

## ⭐ Star History

如果 Rikkahub 對你有幫助，歡迎按個 Star ⭐

[![Star History Chart](https://api.star-history.com/svg?repos=yuh-G/rikkahub-pc&type=Date)](https://star-history.com/#yuh-G/rikkahub-desktop&Date)

## 📄 授權條款

[License](LICENSE)
