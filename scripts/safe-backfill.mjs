#!/usr/bin/env node
/**
 * safe-backfill.mjs
 *
 * Wrapper around backfill-order-allocations.mjs --force with backup/restore safety.
 *
 * Steps:
 *   1. Create inventory_allocations_bak (drops old bak if exists)
 *   2. Verify backup row count == current count (abort if mismatch)
 *   3. Run backfill --force
 *   4. Print before/after counts + direct/combo_explode split
 *   5. If backfill exits non-zero, print rollback command
 *
 * Usage:
 *   node scripts/safe-backfill.mjs
 *   node scripts/safe-backfill.mjs --dry-run   # backup only, no backfill
 */

import { readFileSync, existsSync } from 'fs';
import { createClient } from '@libsql/client';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ---------------------------------------------------------------------------
// Load .env.local
// ---------------------------------------------------------------------------
const envPath = join(ROOT, '.env.local');
try {
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
} catch { /* env already set */ }

const DRY_RUN = process.argv.includes('--dry-run');

const TURSO_URL   = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;

if (!TURSO_URL || !TURSO_TOKEN) {
  console.error('❌  Missing TURSO_DATABASE_URL / TURSO_AUTH_TOKEN');
  process.exit(1);
}

const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

async function count(table) {
  const r = await db.execute(`SELECT COUNT(*) AS c FROM ${table}`);
  return Number(r.rows[0].c);
}

async function main() {
  console.log('\n🔒  safe-backfill.mjs — backup-guarded allocation rebuild');
  console.log(`    Mode: ${DRY_RUN ? 'DRY RUN (backup only)' : 'LIVE'}\n`);

  // ── 1. Current count ────────────────────────────────────────────────────
  const before = await count('inventory_allocations');
  console.log(`    inventory_allocations current: ${before.toLocaleString()} rows`);

  // ── 2. Create backup ─────────────────────────────────────────────────────
  console.log('\n    Creating backup...');
  await db.execute(`DROP TABLE IF EXISTS inventory_allocations_bak`);
  await db.execute(`CREATE TABLE inventory_allocations_bak AS SELECT * FROM inventory_allocations`);

  const bakCount = await count('inventory_allocations_bak');
  console.log(`    inventory_allocations_bak: ${bakCount.toLocaleString()} rows`);

  if (bakCount !== before) {
    console.error(`\n❌  ABORT: backup row count (${bakCount}) != source count (${before}). Do not proceed.`);
    process.exit(1);
  }
  console.log(`    ✅ Backup verified (${bakCount.toLocaleString()} rows match)\n`);

  if (DRY_RUN) {
    console.log('    --dry-run: stopping here. Backup table left in place for inspection.');
    console.log('    To rollback manually: INSERT INTO inventory_allocations SELECT * FROM inventory_allocations_bak;');
    db.close();
    return;
  }

  // ── 3. Run backfill --force ───────────────────────────────────────────────
  console.log('    Running backfill --force ...\n');

  const backfillScript = join(__dirname, 'backfill-order-allocations.mjs');
  const exitCode = await new Promise((resolve) => {
    const child = spawn(process.execPath, [backfillScript, '--force'], {
      stdio: 'inherit',
      env: process.env,
      cwd: ROOT,
    });
    child.on('close', resolve);
  });

  // ── 4. Post-run stats ─────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(65));
  const after = await count('inventory_allocations');
  const directResult = await db.execute(`SELECT COUNT(*) AS c FROM inventory_allocations WHERE allocation_type='direct'`);
  const comboResult  = await db.execute(`SELECT COUNT(*) AS c FROM inventory_allocations WHERE allocation_type='combo_explode'`);
  const direct = Number(directResult.rows[0].c);
  const combo  = Number(comboResult.rows[0].c);

  console.log(`\n    inventory_allocations before : ${before.toLocaleString()}`);
  console.log(`    inventory_allocations after  : ${after.toLocaleString()}  (${after > before ? '+' : ''}${(after - before).toLocaleString()})`);
  console.log(`      direct                     : ${direct.toLocaleString()}`);
  console.log(`      combo_explode              : ${combo.toLocaleString()}`);
  console.log(`    Backup table                 : inventory_allocations_bak (${bakCount.toLocaleString()} rows — safe to DROP after audit)`);

  if (exitCode !== 0) {
    console.error(`\n⚠️  Backfill exited with code ${exitCode}.`);
    console.error('    Table may be partially populated. To rollback to pre-run state:');
    console.error('      DELETE FROM inventory_allocations;');
    console.error('      INSERT INTO inventory_allocations SELECT * FROM inventory_allocations_bak;');
    db.close();
    process.exit(exitCode);
  }

  // ── 5. Sanity check ───────────────────────────────────────────────────────
  const EXPECTED_MIN = 150_000;
  const EXPECTED_MAX = 280_000;
  if (after < EXPECTED_MIN) {
    console.warn(`\n⚠️  After count (${after.toLocaleString()}) is below expected minimum (${EXPECTED_MIN.toLocaleString()}).`);
    console.warn('    Run node scripts/restock-audit.js and check §2 vs §3 histogram.');
  } else if (after > EXPECTED_MAX) {
    console.warn(`\n⚠️  After count (${after.toLocaleString()}) exceeds expected maximum (${EXPECTED_MAX.toLocaleString()}). Check for duplicate writes.`);
  } else {
    console.log(`\n    ✅ Row count in expected range [${EXPECTED_MIN.toLocaleString()}–${EXPECTED_MAX.toLocaleString()}]`);
  }

  console.log('\n    Next: node scripts/restock-audit.js');
  console.log('    Check §2 histogram — should match §3 order histogram month-by-month.\n');

  db.close();
}

main().catch(err => {
  console.error('\n💥  Fatal:', err.message ?? err);
  db.close();
  process.exit(1);
});
