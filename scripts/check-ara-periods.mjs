import { readFileSync } from 'fs';
import { createClient } from '@libsql/client';

const envLines = readFileSync(new URL('../.env.local', import.meta.url).pathname, 'utf8').split('\n');
for (const line of envLines) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eq = trimmed.indexOf('=');
  if (eq === -1) continue;
  const key = trimmed.slice(0, eq).trim();
  const val = trimmed.slice(eq + 1).trim();
  if (!process.env[key]) process.env[key] = val;
}

const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

const today = new Date().toISOString().slice(0, 10);

for (const days of [7, 30, 90, 365]) {
  const start = daysAgo(days);
  const r = await db.execute({
    sql: `SELECT COUNT(*) as rows, COUNT(DISTINCT period_start) as days, SUM(shipped_revenue) as revenue
          FROM vendor_ara_metrics
          WHERE period_start >= ? AND period_start <= ?
            AND period_type IN ('DAY','DAILY')`,
    args: [start, today],
  });
  const row = r.rows[0];
  console.log(`${days}d  start=${start}  rows=${row.rows}  distinct_days=${row.days}  revenue=${Number(row.revenue ?? 0).toFixed(2)}`);
}

// Also show sample of period_start values to check format
const sample = await db.execute(`SELECT DISTINCT period_start FROM vendor_ara_metrics ORDER BY period_start DESC LIMIT 10`);
console.log('\nNewest 10 period_start values:');
for (const r of sample.rows) console.log(' ', r.period_start);
