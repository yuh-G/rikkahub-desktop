# RikkaHub Analytics

Cloudflare Worker + D1 for anonymous DAU tracking.

## One-time setup

```bash
cd analytics

# 1. Create D1 database
npx wrangler d1 create rikkahub-stats
# → Copy the database_id from output into wrangler.toml

# 2. Initialize schema
npx wrangler d1 execute rikkahub-stats --file=schema.sql

# 3. Change AUTH_TOKEN in wrangler.toml to your own secret

# 4. Deploy
npx wrangler deploy
```

## Verify

```bash
# Send a test ping
curl "https://rikkahub-stats.yuh-g.workers.dev/ping?id=test-device-001&d=2026-06-12&v=1.1.0&os=win&mc=5"

# View dashboard (replace TOKEN)
open "https://rikkahub-stats.yuh-g.workers.dev/dashboard?token=YOUR_TOKEN"
```

## Files

- `wrangler.toml` — Worker config (needs your D1 database_id + auth token)
- `schema.sql` — D1 table definitions
- `src/index.ts` — Worker entry (routing)
- `src/ping.ts` — Ping handler + daily summary aggregation
- `src/stats.ts` — Stats API (trends, retention, version dist)
- `dashboard/index.html.ts` — Dashboard HTML (Chart.js)
