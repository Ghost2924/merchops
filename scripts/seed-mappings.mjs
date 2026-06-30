/**
 * Seed marketplace_item_mappings for unmapped Amazon ASINs.
 *
 * Usage:
 *   node scripts/seed-mappings.mjs
 *
 * Fill in the `internal_sku` for each ASIN below, then run.
 * Re-running is safe — uses INSERT OR REPLACE (idempotent).
 */

import { readFileSync } from 'fs';
import { createClient } from '@libsql/client';

// Load .env.local
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

const TURSO_URL = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;

if (!TURSO_URL || !TURSO_TOKEN) {
  console.error('Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN');
  process.exit(1);
}

const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

// ---------------------------------------------------------------------------
// EDIT THIS: marketplace_sku (ASIN) → internal_sku (your warehouse SKU)
// ---------------------------------------------------------------------------
// Rules:
//   - internal_sku: your canonical warehouse SKU (e.g. "AM-5234")
//                   For combo/bundle ASINs, set internal_sku to the
//                   parent_combo_sku defined in combo_product_recipes.
//   - Leave internal_sku as '' to skip that row (skipped with a warning).
//
// Already auto-mapped (12 SKUs inserted by auto-map-asins.mjs):
//   B0D8NTQDDX  → AM5291
//   B09C52YPFH  → 5187
//   B0GF3KM5M1  → AM5234-five
//   B0CC2CLB39  → AM5263
//   B0CNN5T8DC  → AM5233-10
//   B0BRPYQ2XY  → AM5233-2
//   B0BRKNG6GH  → AM5237-8
//   B0C814WJVY  → AM5230-2NF
//   B0CPHSG1M5  → AM5271-2
//   B0CQGN7WL3  → AM5234B-5
//   B0CMF14J73  → AM5237-20
//   B0CQGNBSMF  → AM5234B-10
// ---------------------------------------------------------------------------
const MAPPINGS = [
  // ── AM-prefixed internal SKUs — map to themselves ──────────────────────
  { marketplace_sku: 'AM5320',            internal_sku: 'AM5320' },
  { marketplace_sku: 'AM5320SS',          internal_sku: 'AM5320SS' },
  { marketplace_sku: 'AM5248',            internal_sku: 'AM5248' },
  { marketplace_sku: 'AM5265',            internal_sku: 'AM5265' },
  { marketplace_sku: 'AM5291',            internal_sku: 'AM5291' },
  { marketplace_sku: 'AM5228',            internal_sku: 'AM5228' },
  { marketplace_sku: 'AM5230',            internal_sku: 'AM5230' },
  { marketplace_sku: 'AM5230NF',          internal_sku: 'AM5230NF' },
  { marketplace_sku: 'AM5233-2',          internal_sku: 'AM5233-2' },
  { marketplace_sku: 'AM5233-10',         internal_sku: 'AM5233-10' },
  { marketplace_sku: 'AM5234-1',          internal_sku: 'AM5234-1' },
  { marketplace_sku: 'AM5234-2',          internal_sku: 'AM5234-2' },
  { marketplace_sku: 'AM5235-HB-1',       internal_sku: 'AM5235-HB-1' },
  { marketplace_sku: 'AM5235-HW-1',       internal_sku: 'AM5235-HW-1' },
  { marketplace_sku: 'AM5237-4',          internal_sku: 'AM5237-4' },
  { marketplace_sku: 'AM5237-6',          internal_sku: 'AM5237-6' },
  { marketplace_sku: 'AM5237-50',         internal_sku: 'AM5237-50' },
  { marketplace_sku: 'AM5240BK-2',        internal_sku: 'AM5240BK-2' },
  { marketplace_sku: 'AM5240BN-2',        internal_sku: 'AM5240BN-2' },
  { marketplace_sku: 'AM5240BN-4',        internal_sku: 'AM5240BN-4' },
  { marketplace_sku: 'AM5240BN-4-AM5232', internal_sku: 'AM5240BN-4-AM5232' },
  { marketplace_sku: 'AM5241BN-2',        internal_sku: 'AM5241BN-2' },
  { marketplace_sku: 'AM5241BN-10',       internal_sku: 'AM5241BN-10' },
  { marketplace_sku: 'AM5242-2',          internal_sku: 'AM5242-2' },
  { marketplace_sku: 'AM5242B-1',         internal_sku: 'AM5242B-1' },
  { marketplace_sku: 'AM5243-1',          internal_sku: 'AM5243-1' },
  { marketplace_sku: 'AM5275-1',          internal_sku: 'AM5275-1' },
  { marketplace_sku: 'AM5293GY-2',        internal_sku: 'AM5293GY-2' },
  { marketplace_sku: 'AM5304-20',         internal_sku: 'AM5304-20' },
  { marketplace_sku: 'AM3000WW',          internal_sku: 'AM3000WW' },
  { marketplace_sku: 'am3000ww',          internal_sku: 'AM3000WW' },  // lowercase alias
  { marketplace_sku: 'CC5044BY-2',        internal_sku: 'CC5044BY-2' },

  // ── Numeric internal SKUs — map to themselves ──────────────────────────
  { marketplace_sku: '5003-18DM-1',       internal_sku: '5003-18DM-1' },
  { marketplace_sku: '5003-24DM-1',       internal_sku: '5003-24DM-1' },
  { marketplace_sku: '5010BR',            internal_sku: '5010BR' },
  { marketplace_sku: '5029G',             internal_sku: '5029G' },
  { marketplace_sku: '5029W-A',           internal_sku: '5029W-A' },
  { marketplace_sku: '5029w1',            internal_sku: '5029w1' },
  { marketplace_sku: '5046BR',            internal_sku: '5046BR' },
  { marketplace_sku: '5046BR-1',          internal_sku: '5046BR-1' },
  { marketplace_sku: '5046 armrest',      internal_sku: '5046 armrest' },
  { marketplace_sku: '5074',              internal_sku: '5074' },
  { marketplace_sku: '5091H-2',           internal_sku: '5091H-2' },
  { marketplace_sku: '5091M-2',           internal_sku: '5091M-2' },
  { marketplace_sku: '5092-2',            internal_sku: '5092-2' },
  { marketplace_sku: '5107GR-2',          internal_sku: '5107GR-2' },
  { marketplace_sku: '5111GY-4',          internal_sku: '5111GY-4' },
  { marketplace_sku: '5114-2',            internal_sku: '5114-2' },
  { marketplace_sku: '5114-4',            internal_sku: '5114-4' },
  { marketplace_sku: '5148',              internal_sku: '5148' },
  { marketplace_sku: '5153GR-2',          internal_sku: '5153GR-2' },
  { marketplace_sku: '5162BN',            internal_sku: '5162BN' },
  { marketplace_sku: '5162GY',            internal_sku: '5162GY' },
  { marketplace_sku: '5164',              internal_sku: '5164' },
  { marketplace_sku: '5165',              internal_sku: '5165' },
  { marketplace_sku: '5170',              internal_sku: '5170' },
  { marketplace_sku: '5171',              internal_sku: '5171' },
  { marketplace_sku: '5172',              internal_sku: '5172' },
  { marketplace_sku: '5181',              internal_sku: '5181' },
  { marketplace_sku: '5181W',             internal_sku: '5181W' },
  { marketplace_sku: '5186',              internal_sku: '5186' },
  { marketplace_sku: '5187',              internal_sku: '5187' },
  { marketplace_sku: '5188',              internal_sku: '5188' },
  { marketplace_sku: '5196',              internal_sku: '5196' },
  { marketplace_sku: '5223GY-2',          internal_sku: '5223GY-2' },
  { marketplace_sku: '5234-1',            internal_sku: '5234-1' },
  { marketplace_sku: '5245-cushion-Red-2',internal_sku: '5245-cushion-Red-2' },
  { marketplace_sku: '5256',              internal_sku: '5256' },
  { marketplace_sku: '5267-cushion-Brown',internal_sku: '5267-cushion-Brown' },
  { marketplace_sku: '5269',              internal_sku: '5269' },
  { marketplace_sku: '5290W',             internal_sku: '5290W' },
  { marketplace_sku: '5317-12',           internal_sku: '5317-12' },
  { marketplace_sku: '5396',              internal_sku: '5396' },
  { marketplace_sku: '5841',              internal_sku: '5841' },
  { marketplace_sku: '5903',              internal_sku: '5903' },
  { marketplace_sku: '6068',              internal_sku: '6068' },
  { marketplace_sku: '7026',              internal_sku: '7026' },
  { marketplace_sku: '7029',              internal_sku: '7029' },
  { marketplace_sku: '7043',              internal_sku: '7043' },
  { marketplace_sku: '7092',              internal_sku: '7092' },
  { marketplace_sku: '7145',              internal_sku: '7145' },
  { marketplace_sku: '7146',              internal_sku: '7146' },
  { marketplace_sku: '15044BG-2',         internal_sku: '15044BG-2' },

  // ── BB-prefixed internal SKUs — map to themselves ──────────────────────
  { marketplace_sku: 'BB5046BR',          internal_sku: 'BB5046BR' },
  { marketplace_sku: 'BB5167',            internal_sku: 'BB5167' },
  { marketplace_sku: 'BB5167-AM5100S',    internal_sku: 'BB5167-AM5100S' },
  { marketplace_sku: 'BB5170',            internal_sku: 'BB5170' },
  { marketplace_sku: 'BB5171',            internal_sku: 'BB5171' },

  // ── ASINs — resolved from mapping.csv ────────────────────────────────
  { marketplace_sku: 'B0FPPBLLKT',        internal_sku: 'AM5312' },
  { marketplace_sku: 'B0D8SB74R5',        internal_sku: 'AM5291-2' },
  { marketplace_sku: 'B0959ZDKYC',        internal_sku: '5164' },
  { marketplace_sku: 'B0FY9P7LLG',        internal_sku: 'AM5248-3' },
  { marketplace_sku: 'B0GF4CTR2L',        internal_sku: 'AM5242B-1' },   // CSV: AM5242B-one → normalised
  { marketplace_sku: 'B0FHTRJW3H',        internal_sku: 'AM5303-12' },
  { marketplace_sku: 'B0GSSNSKC8',        internal_sku: 'AM5291' },
  { marketplace_sku: 'B0FC5NRY83',        internal_sku: 'AM5233-10' },
  { marketplace_sku: 'B0CTRYVM2L',        internal_sku: 'AM5234B-10' },
  { marketplace_sku: 'B0GZLR36VS',        internal_sku: 'NS5330-4PK' },
  { marketplace_sku: 'B0GNCL9KPH',        internal_sku: 'AM5279-10' },
  { marketplace_sku: 'B0F9BF2FG3',        internal_sku: 'AM5230-2NF' },
  { marketplace_sku: 'B0CN3TRV9G',        internal_sku: '5196' },
  { marketplace_sku: 'B0D8VH8C4L',        internal_sku: 'AM5292-5' },
  { marketplace_sku: 'B0GSSV86C9',        internal_sku: 'AM5227BZ-4' },
  { marketplace_sku: 'B0F9BGX9NH',        internal_sku: 'AM5230NF' },
  { marketplace_sku: 'B0FTK9X1NX',        internal_sku: '5312-2' },
  { marketplace_sku: 'B0CTRTX38Y',        internal_sku: 'AM5273-2' },
  { marketplace_sku: 'B0FXD7XCFH',        internal_sku: 'AM5252-2' },
  { marketplace_sku: 'B0FHT53VLL',        internal_sku: 'AM5304-50' },
  { marketplace_sku: 'B0FHTV88DP',        internal_sku: 'AM5303-4' },
  { marketplace_sku: 'B0FPPHXYQD',        internal_sku: '5311-1' },
  { marketplace_sku: 'B0CZZ8ZT1P',        internal_sku: 'AM5269' },
  { marketplace_sku: 'B0CTSHHZBG',        internal_sku: 'AM5234B-5' },
  { marketplace_sku: 'B09BJV9QBD',        internal_sku: '15044BG' },
  { marketplace_sku: 'B0FTQ8C54W',        internal_sku: '5311-1' },
  { marketplace_sku: 'B0GNCLCG6W',        internal_sku: 'AM5234B-1' },
  { marketplace_sku: 'B0B5MDRKXZ',        internal_sku: '15044BLU-2' },
  { marketplace_sku: 'B0BCT24GXC',        internal_sku: '5BCasters' },
  { marketplace_sku: 'B0FYB49PDX',        internal_sku: 'AM5237-5' },
  { marketplace_sku: 'B0F9BYBR4V',        internal_sku: 'AM5230-10' },
  { marketplace_sku: 'B0FC5W3GTM',        internal_sku: 'AM5233-1' },
  { marketplace_sku: 'B0C79LJ23M',        internal_sku: 'AM5253-50' },
  { marketplace_sku: 'B0F9CT3R6C',        internal_sku: 'AM5248-2' },
  { marketplace_sku: 'B0FHTLW1H2',        internal_sku: 'AM5304-36' },
  { marketplace_sku: 'B0C79MSV7T',        internal_sku: 'AM5253-20' },
  { marketplace_sku: 'B0FHT83KZC',        internal_sku: 'AM5303-20' },
  { marketplace_sku: 'B0FC5NTY46',        internal_sku: 'AM5233-2' },
  { marketplace_sku: 'B0CTRYJMJT',        internal_sku: 'AM5274-1' },
  { marketplace_sku: 'B0FTLJMZRN',        internal_sku: '5311-2' },
  { marketplace_sku: 'B0FXD5PB8M',        internal_sku: 'AM5317-2' },
  { marketplace_sku: 'B0FPPT3F7V',        internal_sku: 'AM5313-1' },
  { marketplace_sku: 'B0GDJWS9XW',        internal_sku: 'AM5302-1' },
  { marketplace_sku: 'B0GJ7CDBSV',        internal_sku: 'AM5242-1' },
  { marketplace_sku: 'B0GJ7JPP71',        internal_sku: 'AM5242B-10' },
  { marketplace_sku: 'B0FYB1C1YW',        internal_sku: '5318-100' },
  { marketplace_sku: 'B0GDJB6DZ6',        internal_sku: 'AM5332-4' },
  { marketplace_sku: 'B0C797YKKN',        internal_sku: 'AM5252-20' },
  { marketplace_sku: 'B0FPP74K6X',        internal_sku: 'AM5312-2' },
  { marketplace_sku: 'B0FY97XR5N',        internal_sku: 'AM5235-3' },
  { marketplace_sku: 'B0G5N1FPB5',        internal_sku: 'AM5321-1' },
  { marketplace_sku: 'B0CTSCHP27',        internal_sku: 'AM5273-5' },
  { marketplace_sku: 'B0C79GDN2P',        internal_sku: 'AM5253-30' },
  { marketplace_sku: 'B0FY97YQKV',        internal_sku: '5273-4' },
  { marketplace_sku: 'B0FHTF5VL7',        internal_sku: 'AM5303-8' },
  { marketplace_sku: 'B0FC5WV2MG',        internal_sku: 'AM5233-5' },
  { marketplace_sku: 'B0CTS3CBPG',        internal_sku: 'AM5274-2' },
  { marketplace_sku: 'B09BJVWLQN',        internal_sku: '15044GR-2' },
  { marketplace_sku: 'B0C8ZK8DD4',        internal_sku: 'AM5227GY-10' },
  { marketplace_sku: 'B0FYBBHW18',        internal_sku: '5212-3' },
  { marketplace_sku: 'B0FW1FSFRR',        internal_sku: '5313-2' },
  { marketplace_sku: 'B0FHT829PL',        internal_sku: 'AM5304-6' },
  { marketplace_sku: 'B09C51J8MN',        internal_sku: '5186' },
  { marketplace_sku: 'B0C8ZM6LCG',        internal_sku: 'AM5227GY-4' },
  { marketplace_sku: 'B0B5MBM23G',        internal_sku: '15044BY' },
  { marketplace_sku: 'B0FHT2C9PF',        internal_sku: 'AM5303-50' },
  { marketplace_sku: 'B0C8ZLVC1P',        internal_sku: 'AM5227GY-3' },
  { marketplace_sku: 'B0C8ZKGQ9Z',        internal_sku: 'AM5227GY-2' },
  { marketplace_sku: 'B0F9C79WX7',        internal_sku: 'AM5228' },
  { marketplace_sku: 'B0BDQ4Q6PP',        internal_sku: '5123T-2' },
  { marketplace_sku: 'B0D15TZ75Z',        internal_sku: 'AM5262' },
  { marketplace_sku: 'B0CTRTY1ND',        internal_sku: 'AM5273-1' },
  { marketplace_sku: 'B0959WJW9H',        internal_sku: '5170' },
  { marketplace_sku: 'B0959NPRG1',        internal_sku: '5167' },
  { marketplace_sku: 'B0F5YS2QH1',        internal_sku: 'NSRM12' },
  { marketplace_sku: 'B0F9CW8RY4',        internal_sku: 'AM5230-2' },
  { marketplace_sku: 'B0GF4RM9RY',        internal_sku: 'AM5248-1' },   // CSV: AM5248-one → normalised
  { marketplace_sku: 'B0GFY5DHWQ',        internal_sku: 'NS5330' },
  { marketplace_sku: 'B0G2DZFYXZ',        internal_sku: 'AM5237-4-AM5235-HW' },
  { marketplace_sku: 'B0G2TZ64Y1',        internal_sku: 'AM5274-6' },
  { marketplace_sku: 'B0G2TZ5LM1',        internal_sku: 'AM5274-1' },
  { marketplace_sku: 'B0FPPDCHS9',        internal_sku: '5311-2' },
  { marketplace_sku: 'B0B5MC1QKF',        internal_sku: '15044BY-2' },
  { marketplace_sku: 'B0GFY9423F',        internal_sku: 'NS5331' },
  { marketplace_sku: 'B0F9LQPVXJ',        internal_sku: 'AM5229' },
  { marketplace_sku: 'B09WY1ZQSN',        internal_sku: '5029b' },

  // ── ASINs — not found in mapping.csv, need manual lookup ─────────────
  { marketplace_sku: 'B0GJ6YZP4N',        internal_sku: '' },  // unknown
  { marketplace_sku: 'B0DHF36L3W',        internal_sku: '' },  // unknown
  { marketplace_sku: 'B0DHMSB68R',        internal_sku: '' },  // unknown
  { marketplace_sku: 'B0DP5P8VR4',        internal_sku: '' },  // unknown
  { marketplace_sku: 'B0DNVCGLWV',        internal_sku: '' },  // unknown
  { marketplace_sku: 'B0DP3MD6B4',        internal_sku: '' },  // unknown
  { marketplace_sku: 'B0DP3LJNXB',        internal_sku: '' },  // unknown
  { marketplace_sku: 'B0DP3R8N4G',        internal_sku: '' },  // unknown
  { marketplace_sku: 'B0DDRFJPP3',        internal_sku: '' },  // unknown
  { marketplace_sku: 'B0DDRHVS5L',        internal_sku: '' },  // unknown

  // ── Truly unknown — fill in or leave blank to skip ────────────────────
  { marketplace_sku: 'NS5334',            internal_sku: '' },  // not in mapping.csv
  { marketplace_sku: 'Lily Leaf Free standing bird bath pedestal garden home décor water feeder bath [Gray]', internal_sku: '' },  // junk title
  { marketplace_sku: 'Hoodie',            internal_sku: '' },  // junk
  { marketplace_sku: 'parts',             internal_sku: '' },  // junk
  { marketplace_sku: 'A',                 internal_sku: '' },  // likely a test/junk order line
];

const MARKETPLACE_ID = 'AMAZON_US';

async function main() {
  const toInsert = MAPPINGS.filter((m) => {
    if (!m.internal_sku) {
      console.warn(`  ⚠ Skipping ${m.marketplace_sku} — internal_sku not set`);
      return false;
    }
    return true;
  });

  if (toInsert.length === 0) {
    console.log('Nothing to insert. Fill in the internal_sku values in this script first.');
    process.exit(0);
  }

  console.log(`Inserting ${toInsert.length} mappings into marketplace_item_mappings...`);

  const BATCH = 100;
  for (let i = 0; i < toInsert.length; i += BATCH) {
    const chunk = toInsert.slice(i, i + BATCH);
    await db.batch(
      chunk.map((r) => ({
        sql: `INSERT OR REPLACE INTO marketplace_item_mappings
                (marketplace_id, marketplace_sku, internal_sku)
              VALUES (?, ?, ?)`,
        args: [MARKETPLACE_ID, r.marketplace_sku, r.internal_sku],
      }))
    );
  }

  // Clear resolved SKUs from unmapped_skus log
  const resolvedSkus = toInsert.map((m) => m.marketplace_sku);
  const placeholders = resolvedSkus.map(() => '?').join(',');
  const deleted = await db.execute({
    sql: `DELETE FROM unmapped_skus WHERE marketplace_sku IN (${placeholders})`,
    args: resolvedSkus,
  });

  console.log(`Done. ${toInsert.length} mappings upserted, ${deleted.rowsAffected} unmapped_skus entries cleared.`);
  console.log('\nRun a manual sync to re-process today\'s orders with the new mappings:');
  console.log('  POST /api/manual-sync');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
