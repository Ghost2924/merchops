import { createClient } from '@libsql/client';

const db = createClient({
  url: 'libsql://teaplixinventory-ghost2924.aws-us-west-2.turso.io',
  authToken: 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3Nzk0MTUzNDAsImlkIjoiMDE5ZTRkNmEtNGUwMS03MWYxLTk5NmUtMGMxOWM1NDQ2YTczIiwicmlkIjoiMDE5MTJmMjgtYzYxZi00ZTNiLWExMDUtMWExNTI0ODZiOWRkIn0.7JNuVJCh6y2mqCZRqTOOmHAeMAVmALum-EQRPc0WCq_R_XW00dgNo4PhALBTziqagehnczUrg9x6coCI0tlxDQ',
});

function normalizeSku(raw) {
  if (!raw) return '';
  return raw.trim().replace(/^'+/, '').replace(/\s+/g, ' ').trim();
}

async function main() {
  const token = 'd818a-ced1e-0132e-3861d-60aac-81bc5-5e8a';
  const res = await fetch('https://api.teapplix.com/api2/ProductQuantity', {
    headers: { APIToken: token },
  });
  const data = await res.json();
  const products = data.ProductQuantities ?? [];
  console.log('Fetched', products.length, 'products from Teapplix');

  // Aggregate by normalized SKU
  const aggregated = new Map();
  for (const p of products) {
    const sku = normalizeSku(p.ItemName ?? '');
    if (!sku) continue;
    if (!aggregated.has(sku)) {
      aggregated.set(sku, {
        sku,
        title: p.ItemTitle ?? '',
        asin: p.Asin ?? '',
        upc: p.Upc ?? '',
        qty_on_hand: 0,
        qty_to_ship: 0,
        qty_available: 0,
      });
    }
    const row = aggregated.get(sku);
    row.qty_on_hand   += Number(p.QtyOnHand)   || 0;
    row.qty_to_ship   += Number(p.QtyToShip)   || 0;
    row.qty_available += Number(p.QtyAvailable) || 0;
    if (!row.title && p.ItemTitle) row.title = p.ItemTitle;
    if (!row.asin && p.Asin) row.asin = p.Asin;
    if (!row.upc && p.Upc) row.upc = p.Upc;
  }

  const rows = [...aggregated.values()];
  const withQty = rows.filter(r => r.qty_available > 0);
  console.log('Canonical SKUs:', rows.length, '| With qty > 0:', withQty.length);

  // Write in batches of 100
  const BATCH = 100;
  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    await db.batch(chunk.map(r => ({
      sql: `INSERT INTO inventory_products (sku, title, asin, upc, active, current_qty, updated_at)
            VALUES (?, ?, ?, ?, 1, ?, datetime('now'))
            ON CONFLICT(sku) DO UPDATE SET
              title       = COALESCE(excluded.title, title),
              asin        = COALESCE(excluded.asin, asin),
              upc         = COALESCE(excluded.upc, upc),
              current_qty = excluded.current_qty,
              updated_at  = datetime('now')`,
      args: [r.sku, r.title ?? '', r.asin ?? '', r.upc ?? '', r.qty_available],
    })));
    written += chunk.length;
  }
  console.log('Written', written, 'rows to inventory_products');

  // Verify
  const check = await db.execute('SELECT COUNT(*) as n FROM inventory_products WHERE current_qty > 0');
  console.log('Rows with qty > 0 after update:', check.rows[0].n);

  // Sample
  const sample = await db.execute(
    'SELECT sku, current_qty FROM inventory_products WHERE current_qty > 0 ORDER BY current_qty DESC LIMIT 5'
  );
  console.log('Top 5 by qty:');
  sample.rows.forEach(r => console.log(' ', r.sku, '->', r.current_qty));
}

main().catch(console.error);
