import { readFileSync } from 'fs';
import { createClient } from '@libsql/client';

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

const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });

// Manually resolved from inventory lookup
const MAPPINGS = [
  { source: 'AM5114',    target: 'AM5114-2'  },  // only variant in inventory
  { source: 'AM5242-1',  target: 'AM5242'    },  // base SKU exists
  { source: 'AM5252-1',  target: 'AM5252'    },  // base SKU exists
  { source: '5111GY',    target: '5111GY-2'  },  // only variant in inventory
];

console.log('\n📌 Applying remaining manual mappings...\n');

for (const m of MAPPINGS) {
  await db.execute({
    sql: `INSERT OR IGNORE INTO sku_mappings
            (source_sku, marketplace, teapplix_sku, mapping_type, active, confidence, notes)
          VALUES (?, 'UNKNOWN', ?, 'manual', 1, 0.9, 'manual resolve')`,
    args: [m.source, m.target],
  });
  await db.execute({
    sql: `INSERT OR IGNORE INTO marketplace_item_mappings
            (marketplace_id, marketplace_sku, internal_sku)
          VALUES ('UNKNOWN', ?, ?)`,
    args: [m.source, m.target],
  });
  console.log(`  ✓ ${m.source.padEnd(20)} → ${m.target}`);
}

const [afterMim, afterSm] = await Promise.all([
  db.execute('SELECT COUNT(*) as cnt FROM marketplace_item_mappings'),
  db.execute('SELECT COUNT(*) as cnt FROM sku_mappings'),
]);

console.log(`\n✅  Done!`);
console.log(`    marketplace_item_mappings : ${afterMim.rows[0].cnt}`);
console.log(`    sku_mappings              : ${afterSm.rows[0].cnt}`);
console.log(`\n    Now run final allocation backfill:`);
console.log(`    node scripts/backfill-allocations.mjs 2024-01-01 2025-09-30`);

process.exit(0);
