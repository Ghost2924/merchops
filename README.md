# Teapplix Analytics Dashboard

Read-only Next.js (App Router) dashboard for order and inventory intelligence from the Teapplix Report API.

## Features

- KPI cards: Total Orders Today, Total Revenue Today, AOV
- Time-series charts: daily order volume (bar) and revenue (line) with 7d/30d toggle
- Top Selling Items table (top 20 SKUs by quantity)
- Order Volatility Monitor (7-day velocity trends per SKU)

## Development

### Milestone 1 — Mock data

```bash
cp .env.example .env.local
# .env.local already has NEXT_PUBLIC_USE_MOCK_DATA=true
npm install
npm run dev
```

### Milestone 2 — Live data

Set `NEXT_PUBLIC_USE_MOCK_DATA=false` (or remove it) and configure all server-side env vars.

## Deployment

### Environment Variables

Copy `.env.example` and configure each variable in your Vercel project dashboard under **Settings → Environment Variables**.

| Variable | Required | Description |
|---|---|---|
| `TEAPPLIX_ACCOUNT_NAME` | Milestone 2 | Teapplix account subdomain (e.g. `mycompany`) |
| `TEAPPLIX_API_TOKEN` | Milestone 2 | API token for Teapplix Report API |
| `BLOB_READ_WRITE_TOKEN` | Milestone 2 | Vercel Blob read/write token (from Storage dashboard) |
| `CRON_SECRET` | Milestone 2 | Bearer token protecting `/api/sync` — generate with `openssl rand -hex 32` |
| `NEXT_PUBLIC_USE_MOCK_DATA` | Milestone 1 | Set `"true"` for mock data, `"false"` or omit for live |

### GitHub Actions Secrets

Add these secrets to your GitHub repository (**Settings → Secrets → Actions**):

- `VERCEL_APP_URL` — your deployed Vercel URL, e.g. `https://teapplix-dashboard.vercel.app`
- `CRON_SECRET` — same value as the Vercel env var

The nightly sync workflow runs at **23:55 UTC** and can also be triggered manually from the Actions tab.
