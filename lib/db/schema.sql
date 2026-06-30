-- =============================================================================
-- Teapplix Inventory Platform Schema — Full Rebuild (Multi-tenant SaaS)
-- Mirrors Teapplix's exact product model with tenant isolation:
--   inventory_products  = Item Type 0 (physical warehouse SKUs)
--   combo_products      = Item Type 1 (virtual bundles, no physical stock)
--   combo_components    = the recipe: which inventory SKUs a combo depletes
--   sku_mappings        = marketplace/storefront SKU → Teapplix SKU
--   order_lines         = raw order line preserved exactly as received
--   inventory_allocations = physical depletion ledger (inventory SKUs only)
--   unmapped_skus       = queue of SKUs with no mapping entry
--   mapping_errors      = mapping targets that point to missing/invalid SKUs
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. inventory_products
--    Item Type = 0. Real physical warehouse SKUs.
--    Inventory quantity, velocity, and restock forecasting live here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory_products (
  organization_id      TEXT    NOT NULL,
  sku                  TEXT    NOT NULL,
  title                TEXT,
  asin                 TEXT,
  upc                  TEXT,
  active               INTEGER NOT NULL DEFAULT 1,   -- 1 = active, 0 = inactive
  image_url            TEXT,
  weight               REAL,
  current_qty          INTEGER NOT NULL DEFAULT 0,
  unit_cost            REAL    NOT NULL DEFAULT 0.0,
  cost_of_goods_sold   REAL    NOT NULL DEFAULT 0.0,  -- landed cost per unit (overrides unit_cost for P&L)
  lead_time_days       INTEGER,                       -- per-SKU lead time in days; NULL = use global default
  supplier_origin      TEXT,                          -- e.g. 'thailand', 'china', 'domestic'; used to infer default lead time
  moq                  INTEGER,                       -- minimum order quantity; NULL = no minimum
  case_pack_qty        INTEGER,                       -- units per case; order_moq rounds up to next multiple; NULL = treated as 1
  created_at           TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (organization_id, sku)
);

CREATE INDEX IF NOT EXISTS idx_inv_prod_org_id ON inventory_products (organization_id);
CREATE INDEX IF NOT EXISTS idx_inv_prod_asin   ON inventory_products (organization_id, asin);
CREATE INDEX IF NOT EXISTS idx_inv_prod_active ON inventory_products (organization_id, active);

-- ---------------------------------------------------------------------------
-- 2. combo_products
--    Item Type = 1. Virtual bundles. No physical stock.
--    Revenue and sales reporting use these. Depletion uses their children.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS combo_products (
  organization_id TEXT    NOT NULL,
  sku             TEXT    NOT NULL,
  title           TEXT,
  asin            TEXT,
  upc             TEXT,
  active          INTEGER NOT NULL DEFAULT 1,
  image_url       TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (organization_id, sku)
);

CREATE INDEX IF NOT EXISTS idx_combo_prod_org_id ON combo_products (organization_id);
CREATE INDEX IF NOT EXISTS idx_combo_prod_asin   ON combo_products (organization_id, asin);

-- ---------------------------------------------------------------------------
-- 3. needs_review_products
--    Item Type = 2 or invalid/missing SKUs. Flagged for manual review.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS needs_review_products (
  organization_id TEXT    NOT NULL,
  sku             TEXT    NOT NULL,
  title           TEXT,
  item_type       TEXT,   -- raw value from products.csv
  reason          TEXT,   -- why it was flagged
  raw_row         TEXT,   -- JSON of the original CSV row
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (organization_id, sku)
);

CREATE INDEX IF NOT EXISTS idx_needs_review_org_id ON needs_review_products (organization_id);

-- ---------------------------------------------------------------------------
-- 4. combo_components
--    The recipe table. Each row: when combo_sku sells qty_sold units,
--    deplete child_inventory_sku by (qty_sold × quantity) units.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS combo_components (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id     TEXT    NOT NULL,
  combo_sku           TEXT    NOT NULL,   -- FK → combo_products.sku
  child_inventory_sku TEXT    NOT NULL,   -- FK → inventory_products.sku
  quantity            INTEGER NOT NULL,   -- units of child depleted per 1 combo sold
  sequence            INTEGER NOT NULL DEFAULT 1,
  UNIQUE(organization_id, combo_sku, child_inventory_sku)
);

CREATE INDEX IF NOT EXISTS idx_cc_org_id ON combo_components (organization_id);
CREATE INDEX IF NOT EXISTS idx_cc_combo_sku ON combo_components (organization_id, combo_sku);
CREATE INDEX IF NOT EXISTS idx_cc_child_sku ON combo_components (organization_id, child_inventory_sku);

-- ---------------------------------------------------------------------------
-- 5. sku_mappings
--    Marketplace/storefront SKU → Teapplix SKU.
--    source_sku is the raw value from the order (ASIN, UPC, alias, etc.)
--    teapplix_sku resolves to either inventory_products.sku or combo_products.sku
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sku_mappings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT  NOT NULL,
  source_sku    TEXT    NOT NULL,
  marketplace   TEXT    NOT NULL DEFAULT 'UNKNOWN',
  teapplix_sku  TEXT    NOT NULL,
  mapping_type  TEXT    NOT NULL DEFAULT 'manual',  -- 'manual', 'auto', 'csv_import'
  active        INTEGER NOT NULL DEFAULT 1,
  confidence    REAL    NOT NULL DEFAULT 1.0,
  notes         TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_sku, marketplace)
);

CREATE INDEX IF NOT EXISTS idx_sku_map_org_id ON sku_mappings (organization_id);
CREATE INDEX IF NOT EXISTS idx_sku_map_source    ON sku_mappings (organization_id, source_sku);
CREATE INDEX IF NOT EXISTS idx_sku_map_teapplix  ON sku_mappings (organization_id, teapplix_sku);
CREATE INDEX IF NOT EXISTS idx_sku_map_active    ON sku_mappings (organization_id, active);

-- ---------------------------------------------------------------------------
-- 6. order_lines
--    Raw order line preserved exactly as received from Teapplix.
--    Revenue stays on the sold SKU (combo or inventory).
--    resolved_product_type: 'inventory' | 'combo' | 'unknown'
--    mapping_status: 'mapped' | 'unmapped' | 'mapping_error'
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_lines (
  organization_id        TEXT    NOT NULL,
  order_line_id          TEXT    NOT NULL,  -- "{txn_id}|{line_index}"
  customer_order_id      TEXT    NOT NULL,
  order_date             TEXT    NOT NULL,     -- YYYY-MM-DD
  marketplace            TEXT,
  raw_storefront_sku     TEXT    NOT NULL,     -- exactly as received
  resolved_teapplix_sku  TEXT,                 -- after mapping lookup
  resolved_product_type  TEXT,                 -- 'inventory' | 'combo' | 'unknown'
  qty_sold               INTEGER NOT NULL,
  revenue                REAL    NOT NULL,
  mapping_status         TEXT    NOT NULL DEFAULT 'unmapped',
  created_at             TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (organization_id, order_line_id)
);

CREATE INDEX IF NOT EXISTS idx_ol_org_id ON order_lines (organization_id);
CREATE INDEX IF NOT EXISTS idx_ol_order_date    ON order_lines (organization_id, order_date);
CREATE INDEX IF NOT EXISTS idx_ol_customer_id   ON order_lines (organization_id, customer_order_id);
CREATE INDEX IF NOT EXISTS idx_ol_raw_sku       ON order_lines (organization_id, raw_storefront_sku);
CREATE INDEX IF NOT EXISTS idx_ol_resolved_sku  ON order_lines (organization_id, resolved_teapplix_sku);
CREATE INDEX IF NOT EXISTS idx_ol_map_status    ON order_lines (organization_id, mapping_status);

-- ---------------------------------------------------------------------------
-- 7. inventory_allocations
--    Physical depletion ledger. ONLY inventory_products.sku values appear here.
--    Combo SKUs NEVER appear as inventory_sku.
--    allocation_type: 'direct' (inventory sold directly) | 'combo_explode' (child of combo)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory_allocations (
  organization_id      TEXT    NOT NULL,
  allocation_id        TEXT    NOT NULL,  -- "{order_line_id}|{inventory_sku}"
  order_line_id        TEXT    NOT NULL,     -- FK → order_lines.order_line_id
  inventory_sku        TEXT    NOT NULL,     -- FK → inventory_products.sku
  qty_depleted         INTEGER NOT NULL,
  source_teapplix_sku  TEXT    NOT NULL,     -- the resolved Teapplix SKU (combo or inventory)
  source_storefront_sku TEXT   NOT NULL,     -- original raw storefront SKU
  allocation_type      TEXT    NOT NULL DEFAULT 'direct',
  created_at           TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (organization_id, allocation_id)
);

CREATE INDEX IF NOT EXISTS idx_ia_org_id ON inventory_allocations (organization_id);
CREATE INDEX IF NOT EXISTS idx_ia_order_line_id  ON inventory_allocations (organization_id, order_line_id);
CREATE INDEX IF NOT EXISTS idx_ia_inventory_sku  ON inventory_allocations (organization_id, inventory_sku);
CREATE INDEX IF NOT EXISTS idx_ia_created_at     ON inventory_allocations (organization_id, created_at);

-- ---------------------------------------------------------------------------
-- 8. unmapped_skus
--    Queue of raw storefront SKUs that had no mapping entry.
--    status: 'pending' | 'resolved' | 'ignored'
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS unmapped_skus (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id  TEXT  NOT NULL,
  raw_storefront_sku TEXT  NOT NULL,
  marketplace      TEXT,
  first_seen_at    TEXT    NOT NULL,
  last_seen_at     TEXT    NOT NULL,
  order_count      INTEGER NOT NULL DEFAULT 1,
  qty_sold         INTEGER NOT NULL DEFAULT 0,
  revenue          REAL    NOT NULL DEFAULT 0,
  status           TEXT    NOT NULL DEFAULT 'pending',
  UNIQUE(organization_id, raw_storefront_sku)
);

CREATE INDEX IF NOT EXISTS idx_unmapped_org_id ON unmapped_skus (organization_id);
CREATE INDEX IF NOT EXISTS idx_unmapped_status ON unmapped_skus (organization_id, status);

-- ---------------------------------------------------------------------------
-- 9. mapping_errors
--    Mapping targets that point to missing or invalid Teapplix SKUs.
--    severity: 'warning' | 'error' | 'critical'
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mapping_errors (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT  NOT NULL,
  error_type   TEXT    NOT NULL,  -- 'missing_target' | 'invalid_combo_child' | 'duplicate' | etc.
  source_sku   TEXT,
  teapplix_sku TEXT,
  message      TEXT    NOT NULL,
  severity     TEXT    NOT NULL DEFAULT 'error',
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_me_org_id ON mapping_errors (organization_id);
CREATE INDEX IF NOT EXISTS idx_me_error_type ON mapping_errors (organization_id, error_type);
CREATE INDEX IF NOT EXISTS idx_me_severity   ON mapping_errors (organization_id, severity);

-- ---------------------------------------------------------------------------
-- 10. inventory_snapshots
--     Daily qty snapshot per inventory SKU. Used by restock planner.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory_snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT  NOT NULL,
  sku           TEXT    NOT NULL,
  snapshot_date TEXT    NOT NULL,
  qty_available INTEGER NOT NULL DEFAULT 0,
  UNIQUE(organization_id, sku, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_inv_snap_org_id ON inventory_snapshots (organization_id);
CREATE INDEX IF NOT EXISTS idx_inv_snap_date ON inventory_snapshots (organization_id, snapshot_date);

-- ---------------------------------------------------------------------------
-- 11. integrations
--     OAuth tokens per external platform (e.g. amazon_vendor).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS integrations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT  NOT NULL,
  platform      TEXT    NOT NULL,
  refresh_token TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(organization_id, platform)
);

CREATE INDEX IF NOT EXISTS idx_integrations_org_id ON integrations (organization_id);

-- ---------------------------------------------------------------------------
-- 12. daily_marketing_spend
--     Amazon Vendor Central ad spend + coupon redemption costs per day.
--     Used to calculate true net profit: revenue - COGS - marketing spend.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS daily_marketing_spend (
  organization_id         TEXT    NOT NULL,
  id                      TEXT    NOT NULL,             -- e.g. "2024-01-15|amazon"
  date                    TEXT    NOT NULL,             -- YYYY-MM-DD
  ad_spend                REAL    NOT NULL DEFAULT 0.0, -- Sponsored Products / Brands / Display
  coupon_redemption_spend REAL    NOT NULL DEFAULT 0.0, -- Coupon face value redeemed
  marketplace             TEXT    NOT NULL,             -- e.g. "amazon", "amazon_vendor"
  updated_at              INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (organization_id, id)
);

CREATE INDEX IF NOT EXISTS idx_dms_org_id ON daily_marketing_spend (organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dms_org_date_marketplace ON daily_marketing_spend (organization_id, date, marketplace);
CREATE INDEX        IF NOT EXISTS idx_dms_org_date             ON daily_marketing_spend (organization_id, date);

-- ---------------------------------------------------------------------------
-- 13. asin_ad_spend
--     Amazon Ads API daily spend per ASIN (Sponsored Products + Brands + Display).
--     Populated by /api/ads-sync via Amazon Advertising API v3 reports.
--     Joined into vendor-central API to compute per-ASIN Contribution PPM.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS asin_ad_spend (
  organization_id         TEXT    NOT NULL,
  asin                    TEXT    NOT NULL,  -- advertised ASIN
  report_date             TEXT    NOT NULL,  -- YYYY-MM-DD
  ad_spend                REAL    NOT NULL DEFAULT 0.0,  -- $ cost (clicks × CPC)
  ad_sales                REAL    NOT NULL DEFAULT 0.0,  -- attributed sales (7-day window)
  impressions             INTEGER NOT NULL DEFAULT 0,
  clicks                  INTEGER NOT NULL DEFAULT 0,
  acos                    REAL,             -- ad_spend / ad_sales * 100 (NULL if no sales)
  campaign_type           TEXT    NOT NULL DEFAULT 'SP', -- SP | SB | SD
  updated_at              TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (organization_id, asin, report_date, campaign_type)
);

CREATE INDEX IF NOT EXISTS idx_aas_org_id ON asin_ad_spend (organization_id);
CREATE INDEX IF NOT EXISTS idx_aas_asin        ON asin_ad_spend (organization_id, asin);
CREATE INDEX IF NOT EXISTS idx_aas_report_date ON asin_ad_spend (organization_id, report_date);

-- ---------------------------------------------------------------------------
-- 14. vendor_ara_metrics
--     Amazon Retail Analytics (ARA) — one row per ASIN per reporting period.
--     period_type: DAY | WEEK | MONTH
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vendor_ara_metrics (
  organization_id       TEXT    NOT NULL,
  asin                  TEXT    NOT NULL,
  period_start          TEXT    NOT NULL,   -- YYYY-MM-DD
  period_end            TEXT    NOT NULL,   -- YYYY-MM-DD
  period_type           TEXT    NOT NULL,   -- DAY | WEEK | MONTH
  shipped_revenue       REAL,
  shipped_cogs          REAL,
  ordered_units         INTEGER,
  shipped_units         INTEGER,
  customer_returns      INTEGER,
  net_ppm               REAL,
  sales_discount        REAL,
  currency              TEXT    NOT NULL DEFAULT 'USD',
  updated_at            TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (organization_id, asin, period_start, period_end, period_type)
);

CREATE INDEX IF NOT EXISTS idx_vam_org_id ON vendor_ara_metrics (organization_id);
CREATE INDEX IF NOT EXISTS idx_vam_asin         ON vendor_ara_metrics (organization_id, asin);
CREATE INDEX IF NOT EXISTS idx_vam_period_start ON vendor_ara_metrics (organization_id, period_start);
CREATE INDEX IF NOT EXISTS idx_vam_period_type  ON vendor_ara_metrics (organization_id, period_type);

-- ---------------------------------------------------------------------------
-- 15. vendor_inventory_health
--     Amazon inventory health snapshot — one row per ASIN per snapshot date.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vendor_inventory_health (
  organization_id                 TEXT    NOT NULL,
  asin                            TEXT    NOT NULL,
  snapshot_date                   TEXT    NOT NULL,   -- YYYY-MM-DD
  roos_percent                    REAL,
  sellable_on_hand_units          INTEGER,
  open_po_units                   INTEGER,
  unfilled_customer_ordered_units INTEGER,
  updated_at                      TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (organization_id, asin, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_vih_org_id ON vendor_inventory_health (organization_id);
CREATE INDEX IF NOT EXISTS idx_vih_asin          ON vendor_inventory_health (organization_id, asin);
CREATE INDEX IF NOT EXISTS idx_vih_snapshot_date ON vendor_inventory_health (organization_id, snapshot_date);

-- ---------------------------------------------------------------------------
-- 16. vendor_pending_reports
--     Deduplication / resume table for SP-API vendor report polling.
--     One row per report_type. Stores the last-known reportId so re-runs
--     can poll an IN_QUEUE/IN_PROGRESS report instead of creating a new one.
--     Cleared on DONE. Reset (deleted) on FATAL/CANCELLED to allow a fresh retry.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vendor_pending_reports (
  organization_id TEXT    NOT NULL,
  report_type     TEXT    NOT NULL,
  report_id       TEXT    NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'IN_QUEUE',  -- IN_QUEUE | IN_PROGRESS
  data_start      TEXT,   -- YYYY-MM-DD
  data_end        TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (organization_id, report_type)
);

CREATE INDEX IF NOT EXISTS idx_vendor_pending_org_id ON vendor_pending_reports (organization_id);

-- ---------------------------------------------------------------------------
-- 17. open_purchase_orders
--     Minimal open-PO tracker. Restock calc reads SUM(qty_ordered) WHERE status='open'
--     per SKU to net out stock already in transit from order_now.
--     No full PO lifecycle needed — status is 'open' or 'received'.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS open_purchase_orders (
  organization_id       TEXT    NOT NULL,
  po_id                 TEXT    NOT NULL,
  sku                   TEXT    NOT NULL,    -- FK → inventory_products.sku
  qty_ordered           INTEGER NOT NULL,
  expected_arrival_date TEXT,               -- YYYY-MM-DD; informational
  status                TEXT    NOT NULL DEFAULT 'open',  -- 'open' | 'received' | 'cancelled'
  notes                 TEXT,
  created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (organization_id, po_id, sku)
);

CREATE INDEX IF NOT EXISTS idx_opo_org_id ON open_purchase_orders (organization_id);
CREATE INDEX IF NOT EXISTS idx_opo_sku    ON open_purchase_orders (organization_id, sku);
CREATE INDEX IF NOT EXISTS idx_opo_status ON open_purchase_orders (organization_id, status);

-- ---------------------------------------------------------------------------
-- 18. asin_title_cache
--     Caches ASIN titles fetched from SP-API Catalog Items API.
--     Populated on first fetch; reused on subsequent /api/vendor-central loads.
--     Avoids repeated SP-API calls for the same ASINs.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS asin_title_cache (
  organization_id TEXT    NOT NULL,
  asin            TEXT    NOT NULL,
  title           TEXT    NOT NULL,
  fetched_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (organization_id, asin)
);

CREATE INDEX IF NOT EXISTS idx_asin_title_org_id ON asin_title_cache (organization_id);

-- ---------------------------------------------------------------------------
-- 19. asin_coupon_metrics
--     Per-ASIN coupon performance from GET_COUPON_PERFORMANCE_REPORT.
--     Replaces the blunt revenue-proportional coupon allocation in
--     daily_marketing_spend with actual SP-API per-ASIN coupon cost.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS asin_coupon_metrics (
  organization_id TEXT    NOT NULL,
  asin            TEXT    NOT NULL,
  coupon_id       TEXT    NOT NULL,
  report_date     TEXT    NOT NULL,   -- YYYY-MM-DD (campaign start date)
  coupon_name     TEXT,
  redemptions     INTEGER NOT NULL DEFAULT 0,
  coupon_spend    REAL    NOT NULL DEFAULT 0.0,  -- $ cost (face value × redemptions)
  sales           REAL    NOT NULL DEFAULT 0.0,  -- attributed sales
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (organization_id, asin, coupon_id, report_date)
);

CREATE INDEX IF NOT EXISTS idx_acm_org_id ON asin_coupon_metrics (organization_id);
CREATE INDEX IF NOT EXISTS idx_acm_asin        ON asin_coupon_metrics (organization_id, asin);
CREATE INDEX IF NOT EXISTS idx_acm_report_date ON asin_coupon_metrics (organization_id, report_date);

-- ---------------------------------------------------------------------------
-- 20. asin_promotion_metrics
--     Per-ASIN promotion performance from GET_PROMOTION_PERFORMANCE_REPORT (Vendor).
--     Covers Best Deal, Lightning Deal, and Price Discount promotion types.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS asin_promotion_metrics (
  organization_id  TEXT    NOT NULL,
  asin             TEXT    NOT NULL,
  promotion_id     TEXT    NOT NULL,
  report_date      TEXT    NOT NULL,   -- YYYY-MM-DD (promotion start date)
  promotion_name   TEXT,
  promotion_type   TEXT,               -- BEST_DEAL | LIGHTNING_DEAL | PRICE_DISCOUNT
  redemptions      INTEGER NOT NULL DEFAULT 0,
  discount_amount  REAL    NOT NULL DEFAULT 0.0,  -- $ total discount given
  sales            REAL    NOT NULL DEFAULT 0.0,  -- attributed sales
  updated_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (organization_id, asin, promotion_id, report_date)
);

CREATE INDEX IF NOT EXISTS idx_apm_org_id ON asin_promotion_metrics (organization_id);
CREATE INDEX IF NOT EXISTS idx_apm_asin        ON asin_promotion_metrics (organization_id, asin);
CREATE INDEX IF NOT EXISTS idx_apm_report_date ON asin_promotion_metrics (organization_id, report_date);

-- ---------------------------------------------------------------------------
-- 21. asin_net_retail_costs
--     Per-ASIN net retail program cost from GET_VENDOR_NET_RETAIL_PROG_COSTS_REPORT.
--     Captures co-op fees, marketing agreements, freight/damage allowances, and
--     other negotiated vendor program costs. Vendor Central credentials only.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS asin_net_retail_costs (
  organization_id         TEXT    NOT NULL,
  asin                    TEXT    NOT NULL,
  period_start            TEXT    NOT NULL,   -- YYYY-MM-DD
  period_end              TEXT    NOT NULL DEFAULT '',
  net_retail_program_cost REAL    NOT NULL DEFAULT 0.0,
  coop_cost               REAL    NOT NULL DEFAULT 0.0,
  other_program_cost      REAL    NOT NULL DEFAULT 0.0,
  currency                TEXT    NOT NULL DEFAULT 'USD',
  updated_at              TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (organization_id, asin, period_start)
);

CREATE INDEX IF NOT EXISTS idx_anrc_org_id ON asin_net_retail_costs (organization_id);
CREATE INDEX IF NOT EXISTS idx_anrc_asin         ON asin_net_retail_costs (organization_id, asin);
CREATE INDEX IF NOT EXISTS idx_anrc_period_start ON asin_net_retail_costs (organization_id, period_start);

-- ---------------------------------------------------------------------------
-- 22. sync_status
--     Single-row live progress tracker updated during manual sync and vendor sync.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_status (
  organization_id TEXT    NOT NULL,
  id              TEXT    NOT NULL DEFAULT 'current',
  phase           TEXT    NOT NULL DEFAULT 'idle',
  detail          TEXT,
  started_at      TEXT,
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  done            INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  PRIMARY KEY (organization_id, id)
);

CREATE INDEX IF NOT EXISTS idx_sync_status_org_id ON sync_status (organization_id);

-- ---------------------------------------------------------------------------
-- 23. schema_version (migration tracker) - System table (Shared)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

-- =============================================================================
-- Legacy / Backward Compatibility tables
-- =============================================================================
CREATE TABLE IF NOT EXISTS orders (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT    NOT NULL,
  order_id        TEXT    NOT NULL,
  order_date      TEXT    NOT NULL,
  sku             TEXT    NOT NULL,
  resolved_sku    TEXT,
  qty             INTEGER NOT NULL,
  unit_price      REAL    NOT NULL,
  total_price     REAL    NOT NULL,
  is_combo        INTEGER NOT NULL DEFAULT 0,
  UNIQUE(organization_id, order_id, sku)
);
CREATE INDEX IF NOT EXISTS idx_orders_org_id ON orders (organization_id);
CREATE INDEX IF NOT EXISTS idx_orders_date   ON orders (organization_id, order_date);
CREATE INDEX IF NOT EXISTS idx_orders_sku    ON orders (organization_id, sku);

CREATE TABLE IF NOT EXISTS order_item_allocations (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id        TEXT    NOT NULL,
  order_id               TEXT    NOT NULL,
  order_date             TEXT    NOT NULL,
  physical_sku           TEXT    NOT NULL,
  qty_depleted           INTEGER NOT NULL,
  source_marketplace_sku TEXT    NOT NULL,
  unit_cost_cogs         REAL
);
CREATE INDEX IF NOT EXISTS idx_alloc_org_id       ON order_item_allocations (organization_id);
CREATE INDEX IF NOT EXISTS idx_alloc_date         ON order_item_allocations (organization_id, order_date);
CREATE INDEX IF NOT EXISTS idx_alloc_physical_sku ON order_item_allocations (organization_id, physical_sku);
CREATE INDEX IF NOT EXISTS idx_alloc_order_id     ON order_item_allocations (organization_id, order_id);

CREATE TABLE IF NOT EXISTS marketplace_item_mappings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT    NOT NULL,
  marketplace_id  TEXT    NOT NULL,
  marketplace_sku TEXT   NOT NULL,
  internal_sku    TEXT    NOT NULL,
  UNIQUE(organization_id, marketplace_id, marketplace_sku)
);
CREATE INDEX IF NOT EXISTS idx_mim_org_id ON marketplace_item_mappings (organization_id);
CREATE INDEX IF NOT EXISTS idx_mim_marketplace_sku ON marketplace_item_mappings (organization_id, marketplace_sku);

CREATE TABLE IF NOT EXISTS combo_product_recipes (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id     TEXT    NOT NULL,
  parent_combo_sku    TEXT    NOT NULL,
  child_inventory_sku TEXT    NOT NULL,
  quantity_multiplier INTEGER NOT NULL,
  UNIQUE(organization_id, parent_combo_sku, child_inventory_sku)
);
CREATE INDEX IF NOT EXISTS idx_cpr_org_id ON combo_product_recipes (organization_id);
CREATE INDEX IF NOT EXISTS idx_cpr_parent ON combo_product_recipes (organization_id, parent_combo_sku);

-- ---------------------------------------------------------------------------
-- 12. organization_credentials
--     Multi-tenant secure API keys per company.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS organization_credentials (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id      TEXT    NOT NULL,
  teapplix_api_key     TEXT,
  amazon_refresh_token  TEXT,
  amazon_client_id     TEXT,
  amazon_client_secret TEXT,
  created_at           TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(organization_id)
);

CREATE INDEX IF NOT EXISTS idx_org_cred_org_id ON organization_credentials (organization_id);

