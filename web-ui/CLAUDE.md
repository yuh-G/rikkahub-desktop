# CLAUDE.md (web-ui)

Guidance for AI agents working in the RikkaHub PC web UI.

## What this is

The chat front-end of RikkaHub PC. A React Router 7 single-page app (SPA mode, no SSR) that
talks to the Bun backend at `pc-server/server.ts` via REST + SSE. The build copies into
`../dist/web-ui/build/client/` so the portable exe can serve the static assets directly.

## Stack

- React 19, React Router 7 (file-routed, SPA)
- TypeScript 5.9 strict
- Tailwind v4 + shadcn/ui (New York style) + Radix UI primitives
- Zustand 5 (composed slices)
- ky for HTTP, native EventSource-style SSE in `app/services/api.ts`
- i18next (zh-CN default, en-US)
- Bun for package management

## Commands

```bash
bun install          # one-time
bun run dev          # Vite dev server on :5173, /api proxied to :8080
bun run build        # react-router build + copy to ../web-ui/build + ../dist/web-ui/build
bun run typecheck    # react-router typegen + tsc
bun run fmt          # prettier write
```

## Layout

```
app/
├── routes/             # File-routed pages
│   ├── home.tsx        # / route — re-exports conversations.tsx
│   ├── c.$id.tsx       # /c/:id — re-exports conversations.tsx
│   ├── conversations.tsx
│   ├── settings.tsx    # All settings sub-pages live here (general/providers/...)
│   └── images.tsx      # Image generation gallery
├── components/
│   ├── ui/             # shadcn/ui primitives
│   ├── message/        # ChatMessage, MessageParts dispatcher, ChainOfThought, parts/
│   ├── markdown/       # Markdown renderer with shiki + katex + custom citation links
│   ├── input/          # Chat input, model/reasoning/search pickers, file pickers
│   ├── extended/       # Conversation sidebar pieces, infinite scroll
│   └── conversation-sidebar.tsx etc.
├── stores/             # Zustand: settings slice (SSE-fed) + chat-input slice (drafts)
├── hooks/              # use-conversation-list, use-current-assistant, use-current-model, ...
├── services/api.ts     # ky wrapper + manual SSE reader
├── types/              # TS types matching the backend wire format
├── lib/                # utils (cn), display, files, error, settings-sync
├── locales/            # zh-CN + en-US, split by namespace (common/input/markdown/message)
├── root.tsx            # Layout, ThemeProvider, settings SSE subscription
└── routes.ts           # Type-safe route table
```

## Backend contract

The TypeScript types under `app/types/` mirror the wire format produced by
`pc-server/server.ts`. Whenever you change a shared shape, update both ends and run
`bun run typecheck`. There is no compile-time link between them — only runtime will catch a
mismatch.

Key endpoints:

- `GET  /api/settings/stream`            → SSE; pushes full `Settings` on every change
- `GET  /api/conversations`              → list summaries
- `GET  /api/conversations/paged?...`    → paged list with search query
- `GET  /api/conversations/:id`          → full conversation snapshot
- `GET  /api/conversations/:id/stream`   → SSE; `snapshot` + `node_update` events
- `POST /api/conversations/:id/send`     → start generation
- `POST /api/conversations/:id/stop`     → abort generation
- `POST /api/settings/...`               → most settings updates
- `GET  /api/ai-icon?name=...`           → provider/service logo
- `GET  /api/files/:id/content`          → uploaded file
- `POST /api/files/upload`               → multipart upload
- `POST /api/images/generate`            → text-to-image
- `POST /api/settings/provider/test/stream` → 3-mode provider test (SSE)
- `POST /api/settings/provider/test/image`  → dedicated image-gen test
- `POST /api/data/{export,import,webdav/*,s3/*}` → backup

## Patterns

### State

```ts
// Read with a selector to avoid extra renders
const settings = useSettingsStore((s) => s.settings);
const currentModel = useCurrentModel().currentModel;

// SSE drives settings — never write back from the client; call POST /api/settings/...
// then the backend rebroadcasts.
```

### Routing

SPA mode (`react-router.config.ts: ssr: false`). New routes go in `app/routes/` and get
declared in `app/routes.ts`. `home.tsx` and `c.$id.tsx` are thin re-exports of
`conversations.tsx` so route param differences are handled in one place.

### Message rendering

```
ChatMessage (container)
  └── MessageParts (groups text+reasoning+tool blocks)
      └── renderContentPart switch (text / image / video / audio / document / reasoning / tool / loading)
```

The `loading` placeholder part is emitted by the backend at the very start of generation so
the user sees a typing dot within ~30ms; it's stripped automatically when the first real
delta arrives.

### Markdown

`components/markdown/markdown.tsx` handles LaTeX (`\(...\)` / `\[...\]` → `$...$`),
GitHub-flavored markdown, code highlighting via Shiki, `<think>` blockquotes, and the
`[citation,domain](id)` link format.

### Internationalization

Namespaces (`common`, `input`, `markdown`, `message`) live under `app/locales/{zh-CN,en-US}/`.
Use `t("namespace:key")` or shorter when the hook is bound to a namespace.

## Build pipeline

`react-router build` → `build/client/` (static SPA assets).
`copy.ts` then mirrors the client output into:

1. `../web-ui/build/client/` — kept inside the source tree for the in-dev portable layout
2. `../dist/web-ui/build/client/` — the location the compiled exe looks for at runtime

The exe's static-file routing order is `executableDir/web-ui/build/client/` →
`executableDir/web-ui/build/` → source-tree fallbacks. So when you rebuild and recompile,
the new SPA bundle ships with the exe.

## Conventions

- **Imports**: `~` is aliased to `app/`. Prefer `~/components/ui/button` over relative.
- **shadcn**: New York style. Icons from `lucide-react`.
- **Comments**: keep sparse — explain the non-obvious WHY only. Don't restate code.
- **No "原版 / Android / PC 版" phrasing in user-facing strings.** This is a standalone product.
- **Type sync with backend** is manual. Keep `app/types/*` aligned with the structures
  built/consumed by `pc-server/server.ts`.

## Troubleshooting

- **Dev server can't reach API**: backend must be on `:8080`. Either `bun run pc-server/server.ts`
  in another terminal or run the compiled exe.
- **Stale dist**: if your changes "don't show up" after running the exe, you forgot
  `bun run build` (which is what writes the new SPA into `../dist/web-ui/build/client/`).
- **Type errors after route changes**: `bun run typecheck` regenerates `.react-router/types/`.
