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

const r = await db.execute(
  `SELECT MIN(period_start) as oldest, MAX(period_start) as newest,
          COUNT(*) as total_rows, COUNT(DISTINCT period_start) as distinct_days
   FROM vendor_ara_metrics`
);
const row = r.rows[0];
console.log('oldest :', row.oldest);
console.log('newest :', row.newest);
console.log('total rows :', row.total_rows);
console.log('distinct days:', row.distinct_days);

// days from oldest to today
if (row.oldest) {
  const diff = Math.round((new Date() - new Date(row.oldest)) / 86400000);
  console.log('span (days)  :', diff);
}
