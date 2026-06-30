# Restock Planner Data Audit
Generated: 2026-06-05T16:56:06.653Z
Database: Turso/libSQL @ libsql://teaplixinventory-ghost2924.aws-us-west-2.turso.io

## 1. Schema & row counts

```
asin_title_cache  (5 rows)
    asin : TEXT
    title : TEXT
    fetched_at : TEXT
combo_components  (975 rows)
    id : INTEGER
    combo_sku : TEXT
    child_inventory_sku : TEXT
    quantity : INTEGER
    sequence : INTEGER
combo_product_recipes  (36 rows)
    id : INTEGER
    parent_combo_sku : TEXT
    child_inventory_sku : TEXT
    quantity_multiplier : INTEGER
combo_products  (719 rows)
    sku : TEXT
    title : TEXT
    asin : TEXT
    upc : TEXT
    active : INTEGER
    image_url : TEXT
    created_at : TEXT
    updated_at : TEXT
daily_marketing_spend  (5 rows)
    id : TEXT
    date : TEXT
    ad_spend : REAL
    coupon_redemption_spend : REAL
    marketplace : TEXT
    updated_at : INTEGER
integrations  (0 rows)
    id : INTEGER
    platform : TEXT
    refresh_token : TEXT
    updated_at : TEXT
inventory  (1985 rows)
    sku : TEXT
    item_title : TEXT
    asin : TEXT
    upc : TEXT
    qty_on_hand : INTEGER
    qty_to_ship : INTEGER
    qty_available : INTEGER
    last_synced : TEXT
inventory_allocations  (173003 rows)
    allocation_id : TEXT
    order_line_id : TEXT
    inventory_sku : TEXT
    qty_depleted : INTEGER
    source_teapplix_sku : TEXT
    source_storefront_sku : TEXT
    allocation_type : TEXT
    created_at : TEXT
inventory_allocations_bak  (71525 rows)
    allocation_id : TEXT
    order_line_id : TEXT
    inventory_sku : TEXT
    qty_depleted : INT
    source_teapplix_sku : TEXT
    source_storefront_sku : TEXT
    allocation_type : TEXT
    created_at : TEXT
inventory_products  (6360 rows)
    sku : TEXT
    title : TEXT
    asin : TEXT
    upc : TEXT
    active : INTEGER
    image_url : TEXT
    weight : REAL
    current_qty : INTEGER
    created_at : TEXT
    updated_at : TEXT
    unit_cost : REAL
    cost_of_goods_sold : REAL
    lead_time_days : INTEGER
    supplier_origin : TEXT
    moq : INTEGER
    case_pack_qty : INTEGER
inventory_snapshots  (60089 rows)
    id : INTEGER
    sku : TEXT
    snapshot_date : TEXT
    qty_available : INTEGER
mapping_errors  (190 rows)
    id : INTEGER
    error_type : TEXT
    source_sku : TEXT
    teapplix_sku : TEXT
    message : TEXT
    severity : TEXT
    created_at : TEXT
marketplace_item_mappings  (714 rows)
    id : INTEGER
    marketplace_id : TEXT
    marketplace_sku : TEXT
    internal_sku : TEXT
needs_review_products  (2 rows)
    sku : TEXT
    title : TEXT
    item_type : TEXT
    reason : TEXT
    raw_row : TEXT
    created_at : TEXT
open_purchase_orders  (0 rows)
    po_id : TEXT
    sku : TEXT
    qty_ordered : INTEGER
    expected_arrival_date : TEXT
    status : TEXT
    notes : TEXT
    created_at : TEXT
    updated_at : TEXT
order_item_allocations  (69982 rows)
    id : INTEGER
    order_id : TEXT
    order_date : TEXT
    physical_sku : TEXT
    qty_depleted : INTEGER
    source_marketplace_sku : TEXT
    unit_cost_cogs : REAL
order_lines  (173933 rows)
    order_line_id : TEXT
    customer_order_id : TEXT
    order_date : TEXT
    marketplace : TEXT
    raw_storefront_sku : TEXT
    resolved_teapplix_sku : TEXT
    resolved_product_type : TEXT
    qty_sold : INTEGER
    revenue : REAL
    mapping_status : TEXT
    created_at : TEXT
orders  (126589 rows)
    id : INTEGER
    order_id : TEXT
    order_date : TEXT
    sku : TEXT
    qty : INTEGER
    unit_price : REAL
    total_price : REAL
    is_combo : INTEGER
    resolved_sku : TEXT
schema_version  (1 rows)
    version : INTEGER
sku_mappings  (2707 rows)
    id : INTEGER
    source_sku : TEXT
    marketplace : TEXT
    teapplix_sku : TEXT
    mapping_type : TEXT
    active : INTEGER
    confidence : REAL
    notes : TEXT
    created_at : TEXT
    updated_at : TEXT
sync_status  (2 rows)
    id : TEXT
    phase : TEXT
    detail : TEXT
    started_at : TEXT
    updated_at : TEXT
    done : INTEGER
    error : TEXT
unmapped_skus  (142 rows)
    id : INTEGER
    raw_storefront_sku : TEXT
    marketplace : TEXT
    first_seen_at : TEXT
    last_seen_at : TEXT
    order_count : INTEGER
    qty_sold : INTEGER
    revenue : REAL
    status : TEXT
vendor_analytics_cache  (0 rows)
    id : INTEGER
    report_type : TEXT
    vendor_sku : TEXT
    period_start : TEXT
    period_end : TEXT
    metric_key : TEXT
    metric_value : REAL
    synced_at : TEXT
vendor_ara_metrics  (41475 rows)
    asin : TEXT
    period_start : TEXT
    period_end : TEXT
    period_type : TEXT
    shipped_revenue : REAL
    shipped_cogs : REAL
    ordered_units : INTEGER
    shipped_units : INTEGER
    customer_returns : INTEGER
    net_ppm : REAL
    sales_discount : REAL
    currency : TEXT
    updated_at : TEXT
vendor_inventory_health  (29003 rows)
    asin : TEXT
    snapshot_date : TEXT
    roos_percent : REAL
    sellable_on_hand_units : INTEGER
    open_po_units : INTEGER
    unfilled_customer_ordered_units : INTEGER
    updated_at : TEXT
vendor_order_items  (0 rows)
    id : INTEGER
    order_id : TEXT
    vendor_sku : TEXT
    title : TEXT
    quantity_requested : INTEGER
    quantity_confirmed : INTEGER
    cost_per_unit : REAL
vendor_orders  (0 rows)
    order_id : TEXT
    purchase_order_date : TEXT
    order_status : TEXT
    total_amount : REAL
    acknowledgment_status : TEXT
    synced_at : TEXT
vendor_pending_reports  (0 rows)
    report_type : TEXT
    report_id : TEXT
    status : TEXT
    data_start : TEXT
    data_end : TEXT
    created_at : TEXT
    updated_at : TEXT
```

## Resolved table mapping (what the script thinks is what)

```
alloc      -> inventory_allocations
orders     -> order_lines
unmapped   -> unmapped_skus
mapErr     -> mapping_errors
review     -> needs_review_products
invProd    -> inventory_products
comboP     -> combo_product_recipes
comboC     -> combo_components
skuMap     -> sku_mappings
```

## 2. inventory_allocations — velocity source  [date col: created_at | qty col: ? | base col: inventory_sku]

Date range: **2026-06-05 07:19:23**  →  **2026-06-05 16:48:17**
```
by allocation_type:
  direct: 172583
  combo_explode: 420
```
Distinct base units with any allocation: **1822**
```
Monthly allocation volume (last 24 mo) — look for recent months collapsing to ~0:
  2026-06   rows= 173003
```

## 3. order_lines — raw order coverage  [date: order_date | qty: ?]

Range: 2022-01-01 → 2026-06-05  (rows: 173933)
```
Monthly ORDER volume (last 24 mo) — compare against allocation histogram above.
If orders exist for a month but allocations are ~0, those sales were dropped:
  2024-07   orders=   7242
  2024-08   orders=   5109
  2024-09   orders=   5010
  2024-10   orders=   5363
  2024-11   orders=   3455
  2024-12   orders=   4160
  2025-01   orders=   3344
  2025-02   orders=   2749
  2025-03   orders=   3630
  2025-04   orders=   4632
  2025-05   orders=   5527
  2025-06   orders=   3790
  2025-07   orders=   4846
  2025-08   orders=   4134
  2025-09   orders=   3620
  2025-10   orders=   2514
  2025-11   orders=   6225
  2025-12   orders=   5306
  2026-01   orders=   2646
  2026-02   orders=   4514
  2026-03   orders=   4141
  2026-04   orders=   4956
  2026-05   orders=   5179
  2026-06   orders=    408
```

## 4. unmapped_skus — unmapped SKUs (sales/products that never reached velocity)

Count: **142**
```
Sample (up to 25):
  {"raw_storefront_sku":"15044B-2"}
  {"raw_storefront_sku":"15044GR"}
  {"raw_storefront_sku":"15044GR-2"}
  {"raw_storefront_sku":"4758"}
  {"raw_storefront_sku":"5003-18DM-1"}
  {"raw_storefront_sku":"5010BR"}
  {"raw_storefront_sku":"5011BR"}
  {"raw_storefront_sku":"5029G"}
  {"raw_storefront_sku":"5029w1"}
  {"raw_storefront_sku":"5046 armrest"}
  {"raw_storefront_sku":"5046 screws only"}
  {"raw_storefront_sku":"5091H-1"}
  {"raw_storefront_sku":"5091M-4"}
  {"raw_storefront_sku":"5106-2"}
  {"raw_storefront_sku":"5109-4"}
  {"raw_storefront_sku":"5111BU-2"}
  {"raw_storefront_sku":"5111GY-4"}
  {"raw_storefront_sku":"5111bu-2"}
  {"raw_storefront_sku":"5114-4"}
  {"raw_storefront_sku":"5130-2"}
  {"raw_storefront_sku":"5137"}
  {"raw_storefront_sku":"5153-2"}
  {"raw_storefront_sku":"5153BK-2"}
  {"raw_storefront_sku":"5153GR-2"}
  {"raw_storefront_sku":"5153PK-2"}
```

## 4. mapping_errors — mapping errors (sales/products that never reached velocity)

Count: **190**
```
Sample (up to 25):
  {"source_sku":"5003-24DDM-2","error_type":"missing_combo_parent"}
  {"source_sku":"5003-24MGG-2","error_type":"missing_combo_parent"}
  {"source_sku":"5003-24S-2","error_type":"missing_combo_parent"}
  {"source_sku":"5003AB-2","error_type":"missing_combo_parent"}
  {"source_sku":"5003DC-4","error_type":"missing_combo_parent"}
  {"source_sku":"5003R-2","error_type":"missing_combo_parent"}
  {"source_sku":"5003R-4","error_type":"missing_combo_parent"}
  {"source_sku":"5009B-2","error_type":"missing_combo_parent"}
  {"source_sku":"5009B-4","error_type":"missing_combo_parent"}
  {"source_sku":"5009S-2","error_type":"missing_combo_parent"}
  {"source_sku":"5009S-4","error_type":"missing_combo_parent"}
  {"source_sku":"5014P-2","error_type":"missing_combo_parent"}
  {"source_sku":"5014S-2","error_type":"missing_combo_parent"}
  {"source_sku":"5014W-2","error_type":"missing_combo_parent"}
  {"source_sku":"5020T-2","error_type":"missing_combo_parent"}
  {"source_sku":"5020T-4","error_type":"missing_combo_parent"}
  {"source_sku":"5024W-2","error_type":"missing_combo_parent"}
  {"source_sku":"5025p-2","error_type":"missing_combo_parent"}
  {"source_sku":"5026C-4","error_type":"missing_combo_parent"}
  {"source_sku":"5029w-2","error_type":"missing_combo_child"}
  {"source_sku":"5031MCC-4","error_type":"missing_combo_parent"}
  {"source_sku":"5048-24MDM-4","error_type":"missing_combo_parent"}
  {"source_sku":"5048-24MGG-2","error_type":"missing_combo_parent"}
  {"source_sku":"5048MGG-2","error_type":"missing_combo_parent"}
  {"source_sku":"5061MCC-2","error_type":"missing_combo_parent"}
```

## 4. needs_review_products — needs-review products (sales/products that never reached velocity)

Count: **2**
```
Sample (up to 25):
  {"sku":"#N/A","reason":"missing or invalid SKU"}
  {"sku":"5092-2","reason":"Item Type = 2"}
```

## 5. combos — combo_product_recipes / combo_components  [combo:combo_sku child:combo_sku qty:quantity share:undefined]

combo_products: 36
combo_components: 975
Combos with ZERO components (sales explode to nothing): **2**

## 6. inventory_products — on-hand source  [qty col: current_qty]

Products: 6360
on-hand: 0 NULL, 5620 zero out of 6360 (NULL/zero on-hand makes everything look like it needs restocking)
Duplicate sku rows in inventory_products: 0

## 7. Auto-flags (quick read)

```
1. 142 unmapped SKUs — those sales are NOT in velocity.
2. 190 mapping errors — those sales are NOT in velocity.
3. 2 products in needs_review — combos likely exploding to nothing.
4. Compare the §2 allocation histogram with the §3 order histogram month-by-month. If recent months drop to ~0 allocations while orders continue, your backfill timed out before reaching the present — that alone makes current velocity wrong.
```

---
End of audit. Paste this whole file back to Claude.