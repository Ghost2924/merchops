/**
 * Shows exactly which months have data in the DB and which are missing.
 * Usage: node scripts/check-coverage.mjs
 */
import { readFileSync } from 'fs';
import { createClient } from '@libsql/client';

const envPath = new URL('../.env.local', import.meta.url).pathname;
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eq = trimmed.indexOf('=');
  if (eq === -1) continue;
  const key = trimmed.slice(0, eq).trim();
  const val = trimmed.slice(eq + 1).trim();
  if (!process.env[key]) process.env[key] = val;
}

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function main() {
  const result = await db.execute(`
    SELECT
      SUBSTR(order_date, 1, 7) as month,
      COUNT(DISTINCT order_id)  as orders,
      COUNT(*)                  as rows
    FROM orders
    WHERE order_date >= '2022-01-01'
    GROUP BY month
    ORDER BY month
  `);

  const present = new Set(result.rows.map(r => r.month));

  // Build every month from 2022-01 to today
  const today = new Date();
  const missing = [];
  for (let y = 2022; y <= today.getFullYear(); y++) {
    const maxM = y === today.getFullYear() ? today.getMonth() + 1 : 12;
    for (let m = 1; m <= maxM; m++) {
      const key = `${y}-${String(m).padStart(2, '0')}`;
      if (!present.has(key)) missing.push(key);
    }
  }

  console.log('\n── Months IN the DB ──────────────────────────────');
  for (const r of result.rows) {
    console.log(`  ${r.month}  orders=${String(r.orders).padStart(5)}  rows=${r.rows}`);
  }

  console.log('\n── Months MISSING ────────────────────────────────');
  if (missing.length === 0) {
    console.log('  None — all months present!');
  } else {
    console.log(' ', missing.join('  '));
  }

  console.log(`\nTotal missing: ${missing.length} months`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
