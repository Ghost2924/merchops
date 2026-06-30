/**
 * Applies resolved mappings for summer 2025 unmapped SKUs:
 *   1. Inserts combo SKUs into combo_products + combo_product_recipes
 *   2. Inserts self-mappings into sku_mappings + marketplace_item_mappings
 *
 * Usage: node scripts/apply-summer-mappings.mjs
 */

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

// ---------------------------------------------------------------------------
// 12 combos auto-resolved by resolve-summer-skus.mjs
// Format: { sku, components: [{resolved, qty}] }
// ---------------------------------------------------------------------------
const COMBOS = [
  { sku: 'AM5237-4-AM5235',    components: [{ child: 'AM5237-1', qty: 4 }, { child: 'AM5235-1', qty: 1 }] },
  { sku: 'AM5237-3-AM5274',    components: [{ child: 'AM5237-1', qty: 3 }, { child: 'AM5274-1', qty: 1 }] },
  { sku: 'AM5237-4-AM5273',    components: [{ child: 'AM5237-1', qty: 4 }, { child: 'AM5273-1', qty: 1 }] },
  { sku: 'AM5237-2-AM5273',    components: [{ child: 'AM5237-1', qty: 2 }, { child: 'AM5273-1', qty: 1 }] },
  { sku: 'AM5237-4-AM5274',    components: [{ child: 'AM5237-1', qty: 4 }, { child: 'AM5274-1', qty: 1 }] },
  { sku: 'AM5237BK-4-AM5235',  components: [{ child: 'AM5237BK', qty: 4 }, { child: 'AM5235-1', qty: 1 }] },
  { sku: 'AM5227GY-4-AM5229',  components: [{ child: 'AM5227GY', qty: 4 }, { child: 'AM5229',   qty: 1 }] },
  { sku: 'AM5240BN-2-AM5232',  components: [{ child: 'AM5240BN', qty: 2 }, { child: 'AM5232',   qty: 1 }] },
  { sku: 'AM5236RD-4-AM5235',  components: [{ child: 'AM5236RD', qty: 4 }, { child: 'AM5235-1', qty: 1 }] },
  { sku: 'AM5237-2-AM5274',    components: [{ child: 'AM5237-1', qty: 2 }, { child: 'AM5274-1', qty: 1 }] },
  { sku: 'AM5237-3-AM5273',    components: [{ child: 'AM5237-1', qty: 3 }, { child: 'AM5273-1', qty: 1 }] },
  { sku: 'AM5240BK-4-AM5232',  components: [{ child: 'AM5240BK', qty: 4 }, { child: 'AM5232',   qty: 1 }] },
];

console.log('\n🔀 Inserting combo products + recipes...');

for (const combo of COMBOS) {
  // 1. Add to combo_products (so pipeline knows it's a combo)
  await db.execute({
    sql: `INSERT OR IGNORE INTO combo_products (sku, title, asin, upc, active, image_url, updated_at)
          VALUES (?, ?, '', '', 1, '', datetime('now'))`,
    args: [combo.sku, combo.sku],
  });

  // 2. Add recipe rows
  for (let i = 0; i < combo.components.length; i++) {
    const c = combo.components[i];
    await db.execute({
      sql: `INSERT OR IGNORE INTO combo_product_recipes
              (parent_combo_sku, child_inventory_sku, quantity_multiplier)
            VALUES (?, ?, ?)`,
      args: [combo.sku, c.child, c.qty],
    });
  }

  // 3. Map the combo SKU → itself in both mapping tables
  //    (pipeline routes it as a combo, then explodes via recipe)
  await db.execute({
    sql: `INSERT OR IGNORE INTO sku_mappings
            (source_sku, marketplace, teapplix_sku, mapping_type, active, confidence, notes)
          VALUES (?, 'UNKNOWN', ?, 'auto_combo', 1, 0.9, 'auto-resolved combo')`,
    args: [combo.sku, combo.sku],
  });
  await db.execute({
    sql: `INSERT OR IGNORE INTO marketplace_item_mappings
            (marketplace_id, marketplace_sku, internal_sku)
          VALUES ('UNKNOWN', ?, ?)`,
    args: [combo.sku, combo.sku],
  });

  const parts = combo.components.map(c => `${c.child}×${c.qty}`).join(' + ');
  console.log(`  ✓ ${combo.sku.padEnd(30)} → ${parts}`);
}

// ---------------------------------------------------------------------------
// Unknown SKUs — check inventory for close matches
// ---------------------------------------------------------------------------
const UNKNOWNS = [
  'AM5114', 'AM5242-1', 'AM5107GR', 'EACK1190', 'A-AM5229',
  'AM5230-2NF', 'EACK1322', '5111GY', '5212cushion-Gray', 'AM5234-RING',
  'AM5243-10A', 'AM5252-1', 'EACK1149', 'EACK1169', '5230C1',
  'EACK1348', 'EACK1358', 'EACK1145', 'EACK1147', 'EACK1155',
  'EACK1198', 'EACK1206', 'EACK1248', 'EACK1331', 'EACK1346',
  'BB5187-AM5100S', '5230 Part F', '5230FC1', '5237-FC-1-B',
  'P5237W-FC', 'P5237W-FC-1',
];

const inv = await db.execute('SELECT sku FROM inventory_products');
const inventorySkus = new Set(inv.rows.map(r => r.sku));

console.log('\n🔍 Checking unknowns against inventory...');
const autoResolved = [];
const stillUnknown = [];

for (const sku of UNKNOWNS) {
  // Exact
  if (inventorySkus.has(sku)) { autoResolved.push({ source: sku, target: sku }); continue; }
  // -1 variant
  if (inventorySkus.has(`${sku}-1`)) { autoResolved.push({ source: sku, target: `${sku}-1` }); continue; }
  // Case-insensitive
  const lower = sku.toLowerCase();
  const match = [...inventorySkus].find(s => s.toLowerCase() === lower || s.toLowerCase() === `${lower}-1`);
  if (match) { autoResolved.push({ source: sku, target: match }); continue; }
  // Prefix match (e.g. A-AM5229 → AM5229)
  const stripped = sku.replace(/^[A-Z]-/, '');
  if (stripped !== sku && inventorySkus.has(stripped)) { autoResolved.push({ source: sku, target: stripped }); continue; }
  if (stripped !== sku && inventorySkus.has(`${stripped}-1`)) { autoResolved.push({ source: sku, target: `${stripped}-1` }); continue; }

  stillUnknown.push(sku);
}

if (autoResolved.length > 0) {
  console.log(`\n  Auto-resolved ${autoResolved.length} unknowns:`);
  for (const r of autoResolved) {
    console.log(`  ✓ ${r.source.padEnd(30)} → ${r.target}`);
    await db.execute({
      sql: `INSERT OR IGNORE INTO sku_mappings
              (source_sku, marketplace, teapplix_sku, mapping_type, active, confidence, notes)
            VALUES (?, 'UNKNOWN', ?, 'auto_resolve', 1, 0.85, 'auto-resolved unknown')`,
      args: [r.source, r.target],
    });
    await db.execute({
      sql: `INSERT OR IGNORE INTO marketplace_item_mappings
              (marketplace_id, marketplace_sku, internal_sku)
            VALUES ('UNKNOWN', ?, ?)`,
      args: [r.source, r.target],
    });
  }
}

if (stillUnknown.length > 0) {
  console.log(`\n  ⚠  ${stillUnknown.length} still unknown (low volume, safe to skip):`);
  for (const s of stillUnknown) console.log(`     ${s}`);
}

const [afterMim, afterSm, afterCombo] = await Promise.all([
  db.execute('SELECT COUNT(*) as cnt FROM marketplace_item_mappings'),
  db.execute('SELECT COUNT(*) as cnt FROM sku_mappings'),
  db.execute('SELECT COUNT(*) as cnt FROM combo_product_recipes'),
]);

console.log(`\n✅  Done!`);
console.log(`    marketplace_item_mappings : ${afterMim.rows[0].cnt}`);
console.log(`    sku_mappings              : ${afterSm.rows[0].cnt}`);
console.log(`    combo_product_recipes     : ${afterCombo.rows[0].cnt}`);
console.log(`\n    Re-run allocation backfill:`);
console.log(`    node scripts/backfill-allocations.mjs 2024-01-01 2025-09-30`);

process.exit(0);
