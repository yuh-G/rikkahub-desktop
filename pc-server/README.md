# pc-server

The Bun-runtime backend for RikkaHub PC. A single-file HTTP server (`server.ts`) that owns
all state, talks to LLM providers, runs tools, serves SSE streams, and ships static frontend
assets.

## Run from source

```powershell
bun run server.ts
```

Listens on `http://localhost:8080`. All persistent state lives under `../pc-data/` next to
the project root (or `RIKKAHUB_PC_DATA_DIR` if set).

Override the port:

```powershell
bun run server.ts --port=8081
# or
PORT=8081 bun run server.ts
```

## Compile to a portable Windows exe

```powershell
bun run compile
# → ../dist/rikkahub-pc.exe
```

The exe is fully self-contained: it bundles `server.ts` plus the Bun runtime. At runtime it
looks for `icons/` and `web-ui/build/client/` next to itself, then falls back to the source
tree, so the same exe works in dev (`bun run compile` followed by `../dist/rikkahub-pc.exe`)
and in a shipped archive.

## Run the smoke test

```powershell
bun run smoke:request-chain
```

Spins up mock LLM, MCP, WebDAV, and S3 servers and exercises the full request chain end-to-end
into a scratch `pc-data/smoke-request-chain/` directory. Use this as the canary after edits.

## Layout

```
server.ts          # The whole backend in one file. Sections in order:
                   #   1. Type definitions
                   #   2. Default settings (providers, search, assistants, prompts)
                   #   3. State load/save + throttled IO
                   #   4. SSE broadcast helpers
                   #   5. Transformer pipeline (regex, OCR, template, prompt injection)
                   #   6. Provider clients (OpenAI / Claude / Google + streaming + tools)
                   #   7. Tool dispatch (local + MCP + search + skills)
                   #   8. Search service implementations (17 services)
                   #   9. Backup (WebDAV, S3 with AWS SigV4)
                   #  10. Route table
scripts/
  request-chain-smoke.ts   # End-to-end mock-server test runner
package.json       # dev / start / compile / smoke:request-chain scripts
```

## Conventions

- Keep `server.ts` as a single file by design — easier to compile, ship, and audit.
- New features go inline; aim for short comments that explain non-obvious invariants
  (throttle coalescing, provider quirks, streaming reconnection), not what the code does.
- Provider-specific request building goes through `applyCustomBody`, `applyRequestHeaders`,
  `responseApi*ForProvider`, `reasoningPayloadForProvider`. Don't bypass these.
- Streaming is driven by the `StreamHooks` shape: `{ message, conversation, node }`. Pushing
  through `addStreamText` / `appendReasoningDelta` / `replaceLoadingReasoningWithTool`
  automatically broadcasts to SSE clients.
- Never log API keys or store them anywhere outside `pc-data/state.json` (which is
  user-local and gitignored).
