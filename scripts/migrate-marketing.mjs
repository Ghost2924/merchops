/**
 * Migration: Add marketing cost tracking + COGS column
 *
 * Changes applied:
 *   1. ALTER TABLE inventory_products ADD COLUMN cost_of_goods_sold REAL NOT NULL DEFAULT 0.0
 *      (if column already exists, silently skipped)
 *   2. CREATE TABLE IF NOT EXISTS daily_marketing_spend
 *   3. Bumps schema_version to next integer.
 *
 * Usage:
 *   node scripts/migrate-marketing.mjs
 *
 * Safe to re-run — all DDL is idempotent.
 */

import { readFileSync } from 'fs';
import { createClient } from '@libsql/client';

// ---------------------------------------------------------------------------
// Load .env.local
// ---------------------------------------------------------------------------
const envPath = new URL('../.env.local', import.meta.url).pathname;
const envLines = readFileSync(envPath, 'utf8').split('\n');
for (const line of envLines) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eq = trimmed.indexOf('=');
  if (eq === -1) continue;
  const key = trimmed.slice(0, eq).trim();
  const val = trimmed.slice(eq + 1).trim();
  if (!process.env[key]) process.env[key] = val;
}

const TURSO_URL = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;

if (!TURSO_URL || !TURSO_TOKEN) {
  console.error('Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN in .env.local');
  process.exit(1);
}

const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function columnExists(table, column) {
  const result = await db.execute({ sql: `PRAGMA table_info(${table})`, args: [] });
  return result.rows.some((r) => r.name === column);
}

async function tableExists(table) {
  const result = await db.execute({
    sql: `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
    args: [table],
  });
  return result.rows.length > 0;
}

// ---------------------------------------------------------------------------
// Migration steps
// ---------------------------------------------------------------------------

async function step1_addCogsColumn() {
  if (await columnExists('inventory_products', 'cost_of_goods_sold')) {
    console.log('  [skip] inventory_products.cost_of_goods_sold already exists');
    return;
  }
  await db.execute({
    sql: `ALTER TABLE inventory_products ADD COLUMN cost_of_goods_sold REAL NOT NULL DEFAULT 0.0`,
    args: [],
  });
  console.log('  [done] Added inventory_products.cost_of_goods_sold');
}

async function step2_createMarketingTable() {
  if (await tableExists('daily_marketing_spend')) {
    console.log('  [skip] daily_marketing_spend table already exists');
    return;
  }
  await db.execute({
    sql: `
      CREATE TABLE daily_marketing_spend (
        id                      TEXT    PRIMARY KEY,
        date                    TEXT    NOT NULL,
        ad_spend                REAL    NOT NULL DEFAULT 0.0,
        coupon_redemption_spend REAL    NOT NULL DEFAULT 0.0,
        marketplace             TEXT    NOT NULL,
        updated_at              INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `,
    args: [],
  });
  await db.execute({
    sql: `CREATE UNIQUE INDEX idx_dms_date_marketplace ON daily_marketing_spend (date, marketplace)`,
    args: [],
  });
  await db.execute({
    sql: `CREATE INDEX idx_dms_date ON daily_marketing_spend (date)`,
    args: [],
  });
  console.log('  [done] Created daily_marketing_spend table + indexes');
}

async function step3_bumpSchemaVersion() {
  // Ensure schema_version table exists + has at least one row
  await db.execute({
    sql: `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`,
    args: [],
  });
  const current = await db.execute({ sql: `SELECT MAX(version) AS v FROM schema_version`, args: [] });
  const currentVersion = Number(current.rows[0]?.v ?? 0);
  const nextVersion = Math.max(currentVersion, 0) + 1;
  await db.execute({ sql: `INSERT INTO schema_version (version) VALUES (?)`, args: [nextVersion] });
  console.log(`  [done] schema_version → ${nextVersion}`);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

(async () => {
  console.log('Running migration: marketing cost tracking...\n');
  try {
    await step1_addCogsColumn();
    await step2_createMarketingTable();
    await step3_bumpSchemaVersion();
    console.log('\nMigration complete.');
  } catch (err) {
    console.error('\nMigration failed:', err.message);
    process.exit(1);
  }
})();
