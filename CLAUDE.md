# CLAUDE.md

Guidance for Claude Code when working on this repository.

## What this project is

RikkaHub PC — a Windows desktop LLM chat client. Bun-runtime single-file backend (`pc-server/server.ts`) hosts an embedded React SPA (`web-ui/`) at `http://localhost:8080`. The whole thing compiles into one portable Windows exe via `bun build --compile`.

## Layout

```
pc-server/              # Bun backend
  server.ts             # The whole backend in one file (~10k lines): routes, SSE,
                        # provider clients (OpenAI / Claude / Google), tool dispatch,
                        # MCP, search services, TTS/ASR, WebDAV/S3 backup
  scripts/              # Smoke tests
  package.json          # bun run dev / start / compile / smoke:request-chain

web-ui/                 # React Router 7 SPA (SPA mode, no SSR)
  app/
    routes/             # File-routed pages (home/conversations, settings, images)
    components/         # message, input, ui (shadcn), markdown, extended
    stores/             # Zustand slices
    types/              # TypeScript types kept in sync with backend
  public/               # Static assets
  copy.ts               # Post-build: mirrors build/client into ../dist/web-ui/build/client
                        # so the portable exe can serve it

icons/                  # Provider/search-service SVG/PNG logos
dist/                   # Portable bundle: rikkahub-pc.exe + icons + web-ui build
                        # Linux: dist/rikkahub-app/ (rikkahub shell + rikkahub-server + web-ui)
                        # Also where pc-data/ lives at runtime when running the exe
pc-data/                # Runtime state (gitignored). Contains API keys — never commit.
```

## Development commands

```bash
# Backend dev (watches state file, serves API on 8080)
cd pc-server && bun run server.ts

# Frontend dev (Vite on 5173, proxies /api to 8080)
cd web-ui && bun install && bun run dev

# Type check the SPA
cd web-ui && bun run typecheck

# Production build → produces a fresh portable exe
cd web-ui && bun run build          # build SPA + copy to dist/
cd pc-server && bun run compile     # bundles server.ts → ../dist/rikkahub-pc.exe

# Linux Tauri desktop build (native window, same shell as Windows)
bash web-ui/src-tauri/build-linux.sh   # sidecar + SPA + Rust shell → dist/rikkahub-app/ + tar.gz

# Backend smoke (spins up mock provider/MCP/WebDAV and exercises the request chain)
cd pc-server && bun run smoke:request-chain
```

## Architecture notes

### Backend (`pc-server/server.ts`)

Single file by design — easier to compile, ship, and audit. Major sections in order:

- **Type definitions** (Model, Provider, Assistant, Conversation, Settings, etc.)
- **Persistence** — `loadState()` / `saveState()` over `pc-data/state.json`. Normalize on load
  backfills new defaults (search services, abilities, schema upgrades).
- **Throttled IO** — `scheduleThrottledSaveState()` (~5/s during streaming) and
  `scheduleNodeBroadcast()` (~30 fps SSE coalescing) keep streaming smooth.
- **SSE infra** — `conversationClients`, `broadcastNodeUpdate`, `openSse`.
- **Provider clients**:
  - OpenAI Chat Completions / Responses API streaming (`fetchOpenAiTextStreaming`)
  - Anthropic Claude streaming with tool use, thinking deltas, input_json_delta
    (`streamClaudeChatWithTools` + `readClaudeStreamingRound`)
  - Google Gemini generateContent
- **Tool dispatch** — `executeToolCall` runs local tools (memory, time, files), MCP tools,
  search tools, and skill tools. Tool parts created live during streaming.
- **Search services** — 17 implementations in `runSearchService` and `testSearchService`.
- **Backup** — WebDAV (XML), S3-compatible (AWS SigV4 with custom endpoint support).
- **Route table** — every `path === "..."` block at the bottom.

### Frontend (`web-ui/app/`)

- Settings SSE: `useSettingsSubscription` opens `/api/settings/stream` once at root.
- Conversation SSE: `useConversationDetail` opens `/api/conversations/:id/stream`,
  applies `node_update` events via `applyNodeUpdate`.
- Pickers: model / reasoning / search / files in `components/input/`. The search picker
  filters by `service.testPassed` (preset services bypass the gate).
- Messages render via `MessageParts` → `MessagePart` dispatcher; thinking shown via
  `ChainOfThought`, tools via `ToolStepPart`.

### Type sync between frontend and backend

Both sides define their own types (TypeScript vs ad-hoc types in `server.ts`). When changing
a shared shape (parts, settings, dtos), update both. The build won't catch a mismatch — only
the runtime will.

## Key conventions

- **Don't write comments that just restate the code.** Backend comments should explain
  non-obvious invariants (throttle coalescing, provider quirks, tool replay).
- **No "原版 / Android / PC 版" wording in user-facing strings.** This is a standalone product.
- **Default System Prompt** lives in `defaultSettings.assistants[1].systemPrompt` in
  `server.ts`. Keep its template variables (`{{char}}`, `{{model_name}}`, `{{cur_datetime}}`,
  `{{locale}}`, `{{timezone}}`, `{{user}}`) — they're resolved by the input transformer pipeline.
- **Never write user API keys** anywhere in version control. `pc-data/` is gitignored;
  the smoke tests use mock providers.
- **No bare `catch {}` without intent** (P2-1 discipline): every catch must either call
  `reportError(domain, severity, message, cause)` from `observability/app-errors.ts`, or
  carry a comment explaining why swallowing is safe (parse fallback / best-effort cleanup).
  Severity guide: `error` = user must know (global toast), `warn` = perceivable degradation,
  `info` = error-center record only.

## Common tasks

- **Adding a search service**: implement in `runSearchService` and `testSearchService`,
  add the default-services entry, add the type to the dropdown in `routes/settings.tsx`,
  and add the label to `SEARCH_SERVICE_TYPE_LABELS` (settings) and `SEARCH_SERVICE_LABELS`
  (picker).
- **Adding a provider**: extend the `providers/providers` switch in `callProvider` and
  `callProviderStreaming`, add to the defaultSettings list, add provider-specific paths
  for the test endpoints.
- **Releasing a new exe**: web-ui build + pc-server compile. Smoke first.
- **Releasing the Linux desktop app**: push a `v*.*.*` tag — `.github/workflows/build-linux.yml`
  builds the SPA + compiles the x64 sidecar into `src-tauri/binaries/` + builds the Tauri shell
  with `tauri build --no-bundle`, then packs `rikkahub-app/` (shell + sidecar + web-ui + fonts
  + icons) into a tar.gz attached to the Release. The tar.gz is **not** a bare binary:
  `routeStatic` serves the frontend from `web-ui/build/client` next to the sidecar at runtime,
  so the bundle must ship both or the user sees "web-ui is not built". The in-app updater
  matches the asset by the `Rikkahub_<tag>_linux_x64.tar.gz` naming convention, so don't rename
  the uploaded file. Windows (`Rikkahub_<tag>_x64-setup.exe`) and Linux assets live side by
  side on the same Release.
- **Linux update flow**: `update/download` extracts the tar.gz and returns the inner sidecar
  path (`rikkahub-app/rikkahub-server`, legacy `rikkahub-pc/rikkahub-pc` tolerated);
  `update/apply` swaps the sidecar + web-ui, and additionally swaps the Tauri shell binary
  (`rikkahub`) when present — the shell is a thin wrapper, so a failed shell swap is only a
  warning. Both swaps use copy-to-staging + rename so the running processes keep their old
  inodes (Linux allows renaming over a running executable).
- **Linux sidecar lifecycle**: the shell sets `RIKKAHUB_PARENT_PID` on the sidecar; server.ts
  watches it (non-Windows only) and exits when the shell dies — Linux's counterpart to the
  Windows Job Object. Standalone binary / Docker don't set the var and keep their old behavior.
