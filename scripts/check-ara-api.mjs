/**
 * Directly replicates the dataAvailableDays calculation from /api/vendor-central
 * to confirm what the API would return.
 */
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

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const today = new Date().toISOString().slice(0, 10);

// Exact query from vendor-central route
const r = await db.execute({
  sql: `SELECT MIN(period_start) AS oldest, MAX(period_start) AS newest
        FROM vendor_ara_metrics
        WHERE period_type IN ('DAY', 'DAILY')`,
  args: [],
});

const row = r.rows[0];
console.log('oldest:', row.oldest);
console.log('newest:', row.newest);
console.log('today (route uses currentEnd):', today);

if (row.oldest) {
  const oldest = new Date(row.oldest);
  const todayD = new Date(today);
  const diffMs = todayD.getTime() - oldest.getTime();
  const dataAvailableDays = Math.round(diffMs / 86_400_000);
  console.log('dataAvailableDays:', dataAvailableDays);
  console.log('');
  console.log('isPartialPeriod(7)?  ', 7   > dataAvailableDays);
  console.log('isPartialPeriod(30)? ', 30  > dataAvailableDays);
  console.log('isPartialPeriod(90)? ', 90  > dataAvailableDays);
  console.log('isPartialPeriod(365)?', 365 > dataAvailableDays);
}
