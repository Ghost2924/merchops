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

const [mim, sm, invRes, comboRes, comboRecipes] = await Promise.all([
  db.execute('SELECT marketplace_sku FROM marketplace_item_mappings'),
  db.execute('SELECT source_sku FROM sku_mappings WHERE active = 1'),
  db.execute('SELECT sku FROM inventory_products'),
  db.execute('SELECT sku FROM combo_products'),
  db.execute('SELECT parent_combo_sku, child_inventory_sku, quantity_multiplier FROM combo_product_recipes'),
]);

const mapped = new Set([...mim.rows.map(r => r.marketplace_sku), ...sm.rows.map(r => r.source_sku)]);
const inventorySkus = new Set(invRes.rows.map(r => r.sku));
const comboSkus = new Set(comboRes.rows.map(r => r.sku));

// Build combo recipe lookup
const recipes = new Map();
for (const r of comboRecipes.rows) {
  const list = recipes.get(r.parent_combo_sku) ?? [];
  list.push({ child: r.child_inventory_sku, qty: r.quantity_multiplier });
  recipes.set(r.parent_combo_sku, list);
}

// Get summer 2025 unmapped SKUs
const orders = await db.execute(`
  SELECT sku,
         SUM(CASE WHEN order_date >= '2025-06-01' AND order_date <= '2025-08-31' THEN qty ELSE 0 END) as summer25_qty,
         SUM(qty) as total_qty,
         MAX(order_date) as last_order
  FROM orders
  WHERE order_date >= '2024-01-01'
  GROUP BY sku
  HAVING summer25_qty > 0
  ORDER BY summer25_qty DESC
`);

const unmapped = orders.rows.filter(r => r.sku && !mapped.has(r.sku) && !inventorySkus.has(r.sku));

// Parse combo-style SKU: "AM5237-4-AM5235" → [{sku:AM5237, qty:4}, {sku:AM5235, qty:1}]
// Pattern: BASE-QTY-BASE2 or BASE-QTY-BASE2-QTY2 etc
function parseComboSku(sku) {
  // Split on segments, try to identify SKU+qty pairs
  // e.g. AM5237-4-AM5235 → AM5237 x4, AM5235 x1
  // e.g. AM5237-2-AM5273 → AM5237 x2, AM5273 x1
  const parts = sku.split('-');
  const components = [];
  let i = 0;
  while (i < parts.length) {
    // Try to build a SKU token (may contain letters+numbers)
    let skuPart = parts[i];
    i++;
    // If next part is a pure number, it's the qty for this SKU
    let qty = 1;
    if (i < parts.length && /^\d+$/.test(parts[i])) {
      qty = parseInt(parts[i], 10);
      i++;
    }
    if (skuPart) components.push({ skuPart, qty });
  }
  return components;
}

// Try to resolve a SKU token to an inventory SKU
function resolveToken(token) {
  if (inventorySkus.has(token)) return token;
  if (inventorySkus.has(`${token}-1`)) return `${token}-1`;
  if (inventorySkus.has(`${token}-one`)) return `${token}-one`;
  // case-insensitive
  const lower = token.toLowerCase();
  for (const s of inventorySkus) {
    if (s.toLowerCase() === lower) return s;
    if (s.toLowerCase() === `${lower}-1`) return s;
  }
  return null;
}

const JUNK = new Set(['parts', '1', 'a', 'hoodie', 'part c2 rod shorter piece', '5230 part i screw for feet']);

const results = {
  selfMap: [],      // SKU exists in inventory directly (missed earlier)
  packVariant: [],  // SKU-N pattern → base SKU in inventory
  combo: [],        // multi-component combo
  needsRecipe: [],  // combo but missing recipe entries
  junk: [],         // ignore
  unknown: [],      // can't resolve
};

for (const row of unmapped) {
  const sku = row.sku;
  const lower = sku.toLowerCase().trim();

  if (JUNK.has(lower) || /^\d{7,}$/.test(sku)) {
    results.junk.push({ sku, summer25_qty: row.summer25_qty });
    continue;
  }

  // Already in inventory?
  if (inventorySkus.has(sku)) {
    results.selfMap.push({ sku, target: sku, summer25_qty: row.summer25_qty });
    continue;
  }

  // Pack variant: ends in -N where N>=2 and base exists
  const packMatch = sku.match(/^(.+)-(\d+)$/);
  if (packMatch && parseInt(packMatch[2], 10) >= 2) {
    const base = packMatch[1];
    const resolved = resolveToken(base);
    if (resolved) {
      results.packVariant.push({ sku, target: resolved, multiplier: parseInt(packMatch[2], 10), summer25_qty: row.summer25_qty });
      continue;
    }
  }

  // Combo pattern: contains multiple SKU-like segments separated by numbers
  // e.g. AM5237-4-AM5235, A-AM5229, AM5237-3-AM5274
  const comboComponents = parseComboSku(sku);
  if (comboComponents.length >= 2) {
    const resolved = comboComponents.map(c => ({ ...c, resolved: resolveToken(c.skuPart) }));
    const allResolved = resolved.every(c => c.resolved !== null);
    if (allResolved) {
      results.combo.push({ sku, components: resolved, summer25_qty: row.summer25_qty });
      continue;
    }
  }

  // Single segment that resolves
  const single = resolveToken(sku);
  if (single) {
    results.selfMap.push({ sku, target: single, summer25_qty: row.summer25_qty });
    continue;
  }

  results.unknown.push({ sku, summer25_qty: row.summer25_qty, last_order: row.last_order });
}

console.log('\n📊 Resolution summary:');
console.log(`  Self-map (direct):  ${results.selfMap.length}`);
console.log(`  Pack variants:      ${results.packVariant.length}`);
console.log(`  Combos:             ${results.combo.length}`);
console.log(`  Junk (skip):        ${results.junk.length}`);
console.log(`  Unknown:            ${results.unknown.length}`);

if (results.selfMap.length) {
  console.log('\n✅ Self-maps:');
  for (const r of results.selfMap) console.log(`  ${r.sku.padEnd(30)} → ${r.target}  (summer: ${r.summer25_qty})`);
}

if (results.packVariant.length) {
  console.log('\n📦 Pack variants (map to base SKU, qty×multiplier):');
  for (const r of results.packVariant) console.log(`  ${r.sku.padEnd(30)} → ${r.target}  ×${r.multiplier}  (summer: ${r.summer25_qty})`);
}

if (results.combo.length) {
  console.log('\n🔀 Combos (need recipe entries):');
  for (const r of results.combo) {
    const parts = r.components.map(c => `${c.resolved}×${c.qty}`).join(' + ');
    console.log(`  ${r.sku.padEnd(35)} → ${parts}  (summer: ${r.summer25_qty})`);
  }
}

if (results.unknown.length) {
  console.log('\n❓ Unknown (need manual mapping):');
  for (const r of results.unknown) console.log(`  ${r.sku.padEnd(30)} summer:${r.summer25_qty}  last:${r.last_order}`);
}

process.exit(0);
