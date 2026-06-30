#!/usr/bin/env node
/**
 * restock-audit.js  —  READ-ONLY audit of the restock planner's data.
 *
 * It touches NOTHING. It only SELECTs. It writes one report file you can
 * paste straight back to Claude: ./restock-audit-report.md
 *
 * ---------------------------------------------------------------------------
 * HOW TO RUN
 * ---------------------------------------------------------------------------
 *   Turso / libSQL (this project):
 *     TURSO_DATABASE_URL="libsql://..." TURSO_AUTH_TOKEN="..." node restock-audit.js
 *
 *   Postgres / Supabase / Neon:
 *     DATABASE_URL="postgres://..." node restock-audit.js
 *
 *   SQLite:
 *     node restock-audit.js ./path/to/your.db
 *
 * If the driver isn't installed it'll tell you which one to `npm i`.
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');

// ---- tiny output buffer -> markdown report ---------------------------------
const lines = [];
const log = (s = '') => { lines.push(s); console.log(s); };
const h = (s) => log(`\n## ${s}\n`);
const code = (s) => log('```\n' + s + '\n```');
const safe = (id) => /^[A-Za-z0-9_]+$/.test(id); // guard against weird identifiers

// ===========================================================================
// DB ABSTRACTION  (auto-detect postgres vs sqlite)
// ===========================================================================
async function getDb() {
  // ---- Turso / libSQL (takes priority when TURSO_DATABASE_URL is set) -----
  const tursoUrl = process.env.TURSO_DATABASE_URL;
  const tursoToken = process.env.TURSO_AUTH_TOKEN;
  if (tursoUrl) {
    let createClient;
    try { ({ createClient } = require('@libsql/client')); }
    catch { fail("Turso detected but '@libsql/client' isn't installed. Run: npm i @libsql/client"); }
    const client = createClient({ url: tursoUrl, authToken: tursoToken });
    const exec = async (sql) => (await client.execute(sql)).rows;
    return {
      kind: 'turso',
      label: `Turso/libSQL @ ${tursoUrl.slice(0, 50)}...`,
      query: exec,
      close: () => client.close(),
      monthExpr: (col) => `strftime('%Y-%m', "${col}")`,
      daysAgoExpr: (col, n) => `"${col}" >= date('now','-${n} day')`,
      listTables: async () =>
        (await exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"))
          .map(r => r.name),
      columnsOf: async (t) =>
        (await exec(`PRAGMA table_info("${t}")`)).map(r => ({ name: r.name, type: r.type })),
    };
  }

  const sqliteArg = process.argv[2] || process.env.SQLITE_PATH;
  const pgUrl =
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL_NON_POOLING;

  // SQLite takes priority only if a path was explicitly given
  if (sqliteArg && sqliteArg.match(/\.(db|sqlite|sqlite3)$/i)) {
    let Database;
    try { Database = require('better-sqlite3'); }
    catch { fail("SQLite detected but 'better-sqlite3' isn't installed. Run: npm i better-sqlite3"); }
    const db = new Database(sqliteArg, { readonly: true });
    return {
      kind: 'sqlite',
      label: `SQLite @ ${sqliteArg}`,
      query: (sql) => db.prepare(sql).all(),
      close: () => db.close(),
      monthExpr: (col) => `strftime('%Y-%m', "${col}")`,
      daysAgoExpr: (col, n) => `"${col}" >= date('now','-${n} day')`,
      listTables: () =>
        db.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        ).all().map(r => r.name),
      columnsOf: (t) =>
        db.prepare(`PRAGMA table_info("${t}")`).all().map(r => ({ name: r.name, type: r.type })),
    };
  }

  if (pgUrl) {
    let Client;
    try { ({ Client } = require('pg')); }
    catch { fail("Postgres detected but 'pg' isn't installed. Run: npm i pg"); }
    const needsSsl = !/localhost|127\.0\.0\.1/.test(pgUrl);
    const client = new Client({ connectionString: pgUrl, ssl: needsSsl ? { rejectUnauthorized: false } : undefined });
    await client.connect();
    return {
      kind: 'pg',
      label: `Postgres (${pgUrl.replace(/:\/\/[^@]*@/, '://***@').slice(0, 60)}...)`,
      query: async (sql) => (await client.query(sql)).rows,
      close: () => client.end(),
      monthExpr: (col) => `to_char("${col}", 'YYYY-MM')`,
      daysAgoExpr: (col, n) => `"${col}" >= now() - interval '${n} days'`,
      listTables: async () =>
        (await client.query(
          "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name"
        )).rows.map(r => r.table_name),
      columnsOf: async (t) =>
        (await client.query(
          "SELECT column_name, data_type FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position",
          [t]
        )).rows.map(r => ({ name: r.column_name, type: r.data_type })),
    };
  }

  fail(
    "Couldn't find a database to connect to.\n" +
    "  - For Turso/libSQL: set TURSO_DATABASE_URL (and TURSO_AUTH_TOKEN), e.g.\n" +
    "      TURSO_DATABASE_URL=\"libsql://...\" TURSO_AUTH_TOKEN=\"...\" node restock-audit.js\n" +
    "  - For Postgres: set DATABASE_URL (or POSTGRES_URL) in your env, e.g.\n" +
    "      DATABASE_URL=\"postgres://...\" node restock-audit.js\n" +
    "  - For SQLite: pass the file path, e.g.\n" +
    "      node restock-audit.js ./data/app.db"
  );
}

function fail(msg) { console.error('\n[restock-audit] ' + msg + '\n'); process.exit(1); }

// run a query, never throw — return rows or [] and note the error in the report
async function q(db, sql) {
  try { return await db.query(sql); }
  catch (e) { log(`> _query failed: ${String(e.message || e).slice(0, 200)}_`); return null; }
}

// ===========================================================================
// COLUMN HEURISTICS
// ===========================================================================
const pickDateCol = (cols) => {
  const names = cols.map(c => c.name);
  const pref = [/order.*date/i, /sold/i, /^date$/i, /created.*at/i, /ship.*date/i, /timestamp/i, /_at$/i, /date/i];
  for (const re of pref) { const m = names.find(n => re.test(n)); if (m) return m; }
  return null;
};
const pickQtyCol = (cols) => {
  const names = cols.map(c => c.name);
  const pref = [/^units$/i, /^qty$/i, /quantity/i, /units/i, /count$/i];
  for (const re of pref) { const m = names.find(n => re.test(n)); if (m) return m; }
  return null;
};
const has = (cols, name) => cols.some(c => c.name.toLowerCase() === name.toLowerCase());
const findCol = (cols, re) => (cols.find(c => re.test(c.name)) || {}).name;

// ===========================================================================
// MAIN
// ===========================================================================
(async () => {
  const db = await getDb();
  log(`# Restock Planner Data Audit`);
  log(`Generated: ${new Date().toISOString()}`);
  log(`Database: ${db.label}`);

  const tables = await db.listTables();
  const schema = {}; // tableName -> [{name,type}]
  for (const t of tables) schema[t] = await db.columnsOf(t);

  // ---- 1. SCHEMA + ROW COUNTS ---------------------------------------------
  h('1. Schema & row counts');
  const rowCounts = {};
  for (const t of tables) {
    if (!safe(t)) continue;
    const r = await q(db, `SELECT count(*) AS c FROM "${t}"`);
    rowCounts[t] = r ? Number(r[0].c) : '?';
  }
  let schemaDump = '';
  for (const t of tables) {
    schemaDump += `${t}  (${rowCounts[t]} rows)\n`;
    for (const c of schema[t]) schemaDump += `    ${c.name} : ${c.type}\n`;
  }
  code(schemaDump.trimEnd());

  // Resolve the tables we care about by fuzzy name (in case naming drifted)
  const tbl = (re) => tables.find(t => re.test(t));
  const T = {
    alloc:    tbl(/alloc/i),
    orders:   tbl(/order.*line|^order_lines$|^orders$/i),
    unmapped: tbl(/unmapped/i),
    mapErr:   tbl(/mapping_error|map_error/i),
    review:   tbl(/needs_review|review_product/i),
    invProd:  tbl(/inventory_product|^products$/i),
    comboP:   tbl(/combo_product/i),
    comboC:   tbl(/combo_component/i),
    skuMap:   tbl(/sku_mapping/i),
  };
  h('Resolved table mapping (what the script thinks is what)');
  code(Object.entries(T).map(([k, v]) => `${k.padEnd(10)} -> ${v || '(NOT FOUND)'}`).join('\n'));

  // ---- 2. INVENTORY_ALLOCATIONS = the velocity source ---------------------
  if (T.alloc) {
    const cols = schema[T.alloc];
    const dateC = pickDateCol(cols);
    const qtyC  = pickQtyCol(cols);
    const baseC = findCol(cols, /base|sku|product/i);
    const typeC = findCol(cols, /type/i);
    h(`2. ${T.alloc} — velocity source  [date col: ${dateC || '?'} | qty col: ${qtyC || '?'} | base col: ${baseC || '?'}]`);

    if (dateC) {
      const r = await q(db, `SELECT min("${dateC}") AS lo, max("${dateC}") AS hi FROM "${T.alloc}"`);
      if (r) log(`Date range: **${r[0].lo}**  →  **${r[0].hi}**`);
    }
    if (typeC) {
      const r = await q(db, `SELECT "${typeC}" AS t, count(*) AS c FROM "${T.alloc}" GROUP BY 1 ORDER BY 2 DESC`);
      if (r) code('by ' + typeC + ':\n' + r.map(x => `  ${x.t}: ${x.c}`).join('\n'));
    }
    if (baseC) {
      const r = await q(db, `SELECT count(DISTINCT "${baseC}") AS d FROM "${T.alloc}"`);
      if (r) log(`Distinct base units with any allocation: **${r[0].d}**`);
    }

    // monthly histogram — THIS is what exposes a timed-out / oldest-first backfill
    if (dateC) {
      const sel = qtyC
        ? `SELECT ${db.monthExpr(dateC)} AS ym, count(*) AS rows, sum("${qtyC}") AS units FROM "${T.alloc}" GROUP BY 1 ORDER BY 1`
        : `SELECT ${db.monthExpr(dateC)} AS ym, count(*) AS rows FROM "${T.alloc}" GROUP BY 1 ORDER BY 1`;
      const r = await q(db, sel);
      if (r) {
        const last = r.slice(-24);
        code('Monthly allocation volume (last 24 mo) — look for recent months collapsing to ~0:\n' +
          last.map(x => `  ${x.ym}   rows=${String(x.rows).padStart(7)}` + (qtyC ? `   units=${x.units}` : '')).join('\n'));
      }
    }

    // velocity windows
    if (dateC && qtyC) {
      for (const n of [30, 90, 365]) {
        const r = await q(db, `SELECT count(*) AS rows, sum("${qtyC}") AS units FROM "${T.alloc}" WHERE ${db.daysAgoExpr(dateC, n)}`);
        if (r) log(`Last ${String(n).padStart(3)} days: rows=${r[0].rows}, units=${r[0].units}`);
      }
      // top movers in the 90-day velocity window
      if (baseC) {
        const r = await q(db,
          `SELECT "${baseC}" AS base, sum("${qtyC}") AS units FROM "${T.alloc}" WHERE ${db.daysAgoExpr(dateC, 90)} GROUP BY 1 ORDER BY 2 DESC LIMIT 15`);
        if (r) code('Top 15 base units by 90-day velocity:\n' + r.map(x => `  ${String(x.base).padEnd(20)} ${x.units}`).join('\n'));
      }
    }
  } else {
    h('2. inventory_allocations — NOT FOUND (this is the velocity source; if missing, velocity has no backing table)');
  }

  // ---- 3. ORDER COVERAGE vs ALLOCATIONS -----------------------------------
  if (T.orders) {
    const cols = schema[T.orders];
    const dateC = pickDateCol(cols);
    const qtyC  = pickQtyCol(cols);
    h(`3. ${T.orders} — raw order coverage  [date: ${dateC || '?'} | qty: ${qtyC || '?'}]`);
    if (dateC) {
      const r = await q(db, `SELECT min("${dateC}") AS lo, max("${dateC}") AS hi, count(*) AS c FROM "${T.orders}"`);
      if (r) log(`Range: ${r[0].lo} → ${r[0].hi}  (rows: ${r[0].c})`);
      const sel = qtyC
        ? `SELECT ${db.monthExpr(dateC)} AS ym, count(*) AS rows, sum("${qtyC}") AS qty FROM "${T.orders}" GROUP BY 1 ORDER BY 1`
        : `SELECT ${db.monthExpr(dateC)} AS ym, count(*) AS rows FROM "${T.orders}" GROUP BY 1 ORDER BY 1`;
      const m = await q(db, sel);
      if (m) {
        const last = m.slice(-24);
        code('Monthly ORDER volume (last 24 mo) — compare against allocation histogram above.\n' +
          'If orders exist for a month but allocations are ~0, those sales were dropped:\n' +
          last.map(x => `  ${x.ym}   orders=${String(x.rows).padStart(7)}` + (qtyC ? `   qty=${x.qty}` : '')).join('\n'));
      }
    }
  }

  // ---- 4. SILENTLY-DROPPED SALES ------------------------------------------
  for (const [key, title] of [[ 'unmapped', 'unmapped SKUs' ], [ 'mapErr', 'mapping errors' ], [ 'review', 'needs-review products' ]]) {
    const t = T[key];
    if (!t) { h(`4. ${title} (${key}) — NOT FOUND`); continue; }
    const cols = schema[t];
    h(`4. ${t} — ${title} (sales/products that never reached velocity)`);
    const c = await q(db, `SELECT count(*) AS c FROM "${t}"`);
    if (c) log(`Count: **${c[0].c}**`);
    const reasonC = findCol(cols, /reason|error|message/i);
    const skuC = findCol(cols, /sku|name|source/i);
    const proj = [skuC, reasonC].filter(Boolean).map(x => `"${x}"`).join(', ') || '*';
    const sample = await q(db, `SELECT ${proj} FROM "${t}" LIMIT 25`);
    if (sample && sample.length) code('Sample (up to 25):\n' + sample.map(r => '  ' + JSON.stringify(r)).join('\n'));
  }

  // ---- 5. COMBOS ----------------------------------------------------------
  if (T.comboP && T.comboC) {
    const cc = schema[T.comboC];
    const comboKey = findCol(cc, /combo/i) || findCol(cc, /parent/i);
    const childKey = findCol(cc, /child|base|component|sku/i);
    const qtyKey   = pickQtyCol(cc);
    const shareKey = findCol(cc, /share|alloc|revenue|ratio/i);
    h(`5. combos — ${T.comboP} / ${T.comboC}  [combo:${comboKey} child:${childKey} qty:${qtyKey} share:${shareKey}]`);
    const cP = await q(db, `SELECT count(*) AS c FROM "${T.comboP}"`);
    const cC = await q(db, `SELECT count(*) AS c FROM "${T.comboC}"`);
    if (cP) log(`combo_products: ${cP[0].c}`);
    if (cC) log(`combo_components: ${cC[0].c}`);
    // combos with NO components (these explode to nothing -> sales vanish)
    if (comboKey) {
      const orphan = await q(db,
        `SELECT count(*) AS c FROM "${T.comboP}" p WHERE NOT EXISTS (SELECT 1 FROM "${T.comboC}" c WHERE c."${comboKey}" = p."${findCol(schema[T.comboP], /sku/i) || 'sku'}")`);
      if (orphan) log(`Combos with ZERO components (sales explode to nothing): **${orphan[0].c}**`);
    }
    // revenue shares per combo should sum ~1.0
    if (comboKey && shareKey) {
      const bad = await q(db,
        `SELECT "${comboKey}" AS combo, sum("${shareKey}") AS s FROM "${T.comboC}" GROUP BY 1 HAVING abs(sum("${shareKey}") - 1.0) > 0.01 LIMIT 20`);
      if (bad) {
        log(`Combos whose revenue shares don't sum to ~1.0: ${bad.length}`);
        if (bad.length) code(bad.map(r => `  ${r.combo}: ${r.s}`).join('\n'));
      }
    }
  }

  // ---- 6. INVENTORY / ON-HAND ---------------------------------------------
  if (T.invProd) {
    const cols = schema[T.invProd];
    const qtyC = findCol(cols, /current_qty|on_hand|qty|quantity|stock/i);
    h(`6. ${T.invProd} — on-hand source  [qty col: ${qtyC || '?'}]`);
    const c = await q(db, `SELECT count(*) AS c FROM "${T.invProd}"`);
    if (c) log(`Products: ${c[0].c}`);
    if (qtyC) {
      const r = await q(db,
        `SELECT count(*) AS total, sum(CASE WHEN "${qtyC}" IS NULL THEN 1 ELSE 0 END) AS nulls, sum(CASE WHEN "${qtyC}" = 0 THEN 1 ELSE 0 END) AS zeros FROM "${T.invProd}"`);
      if (r) log(`on-hand: ${r[0].nulls} NULL, ${r[0].zeros} zero out of ${r[0].total} (NULL/zero on-hand makes everything look like it needs restocking)`);
    }
    // duplicate base-unit detection — the planner should have exactly one row per base unit
    const skuC = findCol(cols, /^sku$|base/i);
    if (skuC) {
      const dup = await q(db,
        `SELECT "${skuC}" AS sku, count(*) AS c FROM "${T.invProd}" GROUP BY 1 HAVING count(*) > 1 ORDER BY 2 DESC LIMIT 20`);
      if (dup) {
        log(`Duplicate ${skuC} rows in ${T.invProd}: ${dup.length}`);
        if (dup.length) code(dup.map(r => `  ${r.sku}: ${r.c}`).join('\n'));
      }
    }
  }

  // ---- 7. AUTO-FLAGGED ANOMALIES ------------------------------------------
  h('7. Auto-flags (quick read)');
  const flags = [];
  if (T.unmapped && rowCounts[T.unmapped] > 0) flags.push(`${rowCounts[T.unmapped]} unmapped SKUs — those sales are NOT in velocity.`);
  if (T.mapErr && rowCounts[T.mapErr] > 0) flags.push(`${rowCounts[T.mapErr]} mapping errors — those sales are NOT in velocity.`);
  if (T.review && rowCounts[T.review] > 0) flags.push(`${rowCounts[T.review]} products in needs_review — combos likely exploding to nothing.`);
  if (!T.alloc) flags.push(`No inventory_allocations table found — velocity has no source.`);
  flags.push(`Compare the §2 allocation histogram with the §3 order histogram month-by-month. If recent months drop to ~0 allocations while orders continue, your backfill timed out before reaching the present — that alone makes current velocity wrong.`);
  code(flags.map((f, i) => `${i + 1}. ${f}`).join('\n'));

  log('\n---\nEnd of audit. Paste this whole file back to Claude.');

  fs.writeFileSync('restock-audit-report.md', lines.join('\n'));
  console.log('\n[restock-audit] Wrote restock-audit-report.md');
  await db.close();
})().catch(e => { console.error(e); process.exit(1); });