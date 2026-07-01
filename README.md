# MerchOps

**Real-time profitability infrastructure for Amazon Vendors & Sellers.**

Live demo: [merchops-one.vercel.app](https://merchops-one.vercel.app/)

MerchOps is a multi-tenant SaaS operations and profitability dashboard built for Amazon Vendors and Sellers who run on Teapplix. It unifies Amazon SP-API analytics, Teapplix 3PL order/shipping data, and local inventory cost tracking into a single source of truth for **Net PPM** and **Contribution Margin** — updated in real time, not reconstructed at month-end in a spreadsheet.

---

## The Problem

Amazon Vendors and Sellers running lean operations typically stitch profitability together from three disconnected sources: Vendor Central / Seller Central reports, their 3PL or fulfillment system, and a manually maintained landed-cost spreadsheet. This creates two recurring failure modes:

- **Revenue loss from inventory mismatches** — stockouts, overselling, and restock timing errors that go unnoticed until they've already cost sales velocity or ranking.
- **Fragmented profitability metrics** — Net PPM and Contribution Margin calculated inconsistently (or not at all) because landed cost, ad spend, and fulfillment cost live in different systems that don't talk to each other.

## The Solution

MerchOps continuously syncs order, inventory, and cost data across systems and computes true unit economics automatically:

- **Net PPM & Contribution Margin, per SKU and per account** — computed from real landed cost, not estimated
- **Teapplix integration** — order volume, revenue, and fulfillment data synced on a scheduled basis
- **Amazon SP-API analytics** — Vendor/Seller performance data layered directly against cost data
- **Inventory intelligence** — SKU-level velocity tracking and volatility monitoring to catch stockout and overselling risk before it hits revenue
- **Multi-tenant architecture** — each company's data, credentials, and cost inputs are isolated, so the same platform can serve multiple Amazon businesses independently

## How It Was Built

The backend is architected as a multi-tenant system from the ground up — tenant-scoped data access, per-account API credentials, and isolated sync jobs — rather than a single-account tool retrofitted for multiple users. AI-assisted development was used to accelerate SP-API and Teapplix integration work, map complex e-commerce data structures (SKU family/variation logic, shadow SKU and combo SKU cost attribution), and iterate on the multi-tenant backend design.

---

## Features (Current)

- KPI cards: Total Orders Today, Total Revenue Today, AOV
- Time-series charts: daily order volume (bar) and revenue (line), 7d/30d toggle
- Top Selling Items table (top 20 SKUs by quantity)
- Order Volatility Monitor — 7-day velocity trends per SKU
- Scheduled nightly sync from Teapplix (23:55 UTC)

## Roadmap

- Landed cost ingestion (Google Sheets → database) wired into Net PPM / Contribution Margin calculations
- Amazon SP-API Vendor Central analytics (sales, net PPM, inventory reports)
- Amazon Ads spend integration for true blended contribution margin
- Open PO awareness in restock/inventory planning
- Tenant onboarding flow (self-serve account + credential setup)
- Billing/subscription layer

---

## Tech Stack

- **Frontend:** Next.js 14 (App Router)
- **Data layer:** Teapplix Report API, Amazon SP-API
- **Storage:** Vercel Blob, Turso/libSQL
- **Automation:** Scheduled sync jobs (GitHub Actions / Inngest)
- **Hosting:** Vercel

---

## Development

### Milestone 1 — Mock data

```bash
cp .env.example .env.local
# .env.local already has NEXT_PUBLIC_USE_MOCK_DATA=true
npm install
npm run dev
```

### Milestone 2 — Live data

Set `NEXT_PUBLIC_USE_MOCK_DATA=false` (or remove it) and configure all server-side env vars below.

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

- `VERCEL_APP_URL` — your deployed Vercel URL, e.g. `https://merchops-one.vercel.app`
- `CRON_SECRET` — same value as the Vercel env var

The nightly sync workflow runs at **23:55 UTC** and can also be triggered manually from the Actions tab.

---

## Multi-Tenancy Note

MerchOps is designed to serve multiple Amazon Vendor/Seller accounts from a single deployment, with per-tenant data isolation. If you're evaluating this for your own operation or as an acquisition target, reach out for a walkthrough of the tenant architecture and current data model.
