# Design Document: Unmapped SKU Workflow

## Overview

The Unmapped SKU Workflow transforms the passive dashboard warning banner into an active operational queue. When a marketplace SKU has no entry in `marketplace_item_mappings`, orders land in the `orders` table with `resolved_sku = NULL` and no allocation rows are written — meaning inventory depletion is invisible and restock planning is blind to those sales.

This feature adds:
- A dedicated queue page at `/unmapped-skus` for reviewing, resolving, and ignoring unmapped SKUs
- Severity classification (Critical / High / Medium / Low) computed in TypeScript
- Per-SKU revenue impact estimation
- Resolve action: creates a mapping and optionally backfills historical allocations
- Ignore action: hides test/obsolete SKUs from the active queue
- Bulk resolve and bulk ignore for batch operations
- Fuzzy-match suggestions in the resolve modal
- An audit trail in `unmapped_sku_resolutions`
- An upgraded dashboard banner with severity breakdown and a direct link to the queue

The feature is entirely within the existing Next.js 14 App Router + Turso/libSQL stack. No new dependencies are introduced.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  app/page.tsx (Server Component)                                │
│  └─ Updated banner: status='active' only, severity breakdown    │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  app/unmapped-skus/page.tsx (Server Component)                  │
│  └─ Fetches initial data, passes to UnmappedSkuQueue            │
└─────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────┐
│  components/unmapped/UnmappedSkuQueue.tsx (Client Component)    │
│  ├─ Filter state (status, severity, marketplace_id)             │
│  ├─ Selection state (bulk checkboxes)                           │
│  ├─ ResolveModal.tsx                                            │
│  ├─ IgnoreModal.tsx                                             │
│  └─ SeverityBadge.tsx                                           │
└─────────────────────────────────────────────────────────────────┘
         │  fetch
         ▼
┌─────────────────────────────────────────────────────────────────┐
│  app/api/unmapped-skus/                                         │
│  ├─ route.ts                    GET list / filters              │
│  ├─ [sku]/resolve/route.ts      POST resolve + backfill         │
│  ├─ [sku]/ignore/route.ts       POST ignore                     │
│  ├─ bulk-resolve/route.ts       POST bulk resolve               │
│  ├─ bulk-ignore/route.ts        POST bulk ignore                │
│  └─ suggestions/route.ts        GET fuzzy suggestions           │
└─────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────┐
│  lib/db/queries.ts + lib/unmapped/severity.ts                   │
│  lib/unmapped/fuzzy.ts + lib/unmapped/backfill.ts               │
└─────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────┐
│  Turso/libSQL                                                   │
│  unmapped_skus (extended) + unmapped_sku_resolutions (new)      │
└─────────────────────────────────────────────────────────────────┘
```

Data flow for a resolve action:
1. User clicks Resolve → `ResolveModal` opens, fetches suggestions from `GET /api/unmapped-skus/suggestions?sku=X`
2. User selects internal SKU, submits → `POST /api/unmapped-skus/:sku/resolve`
3. Endpoint creates mapping row, updates `unmapped_skus.status`, runs backfill if requested, writes audit row
4. Response returns `backfill_order_count`; client removes row from queue display


---

## Components and Interfaces

### New Utility Modules

```
lib/unmapped/
  severity.ts    — computeSeverity() pure function
  fuzzy.ts       — computeSimilarity(), getSuggestions()
  backfill.ts    — runBackfill()
```

### Page Components

**`app/unmapped-skus/page.tsx`** — Server Component
- Calls `migrate()` (same pattern as `app/page.tsx`)
- Fetches initial data via `getUnmappedSkusWithRevenue()` (status='active' by default)
- Passes serialized data to `UnmappedSkuQueue`

**`components/unmapped/UnmappedSkuQueue.tsx`** — Client Component
```typescript
interface UnmappedSkuQueueProps {
  initialRows: UnmappedSkuRow[];
}
```
Manages: filter state, selection state, optimistic row removal after resolve/ignore, bulk toolbar visibility.

**`components/unmapped/ResolveModal.tsx`** — Client Component
```typescript
interface ResolveModalProps {
  sku: string;
  marketplaceId: string;
  onSuccess: (sku: string, backfillCount: number) => void;
  onClose: () => void;
}
```
Fetches suggestions on mount. Contains internal SKU search (client-side filter against inventory list fetched once). Checkbox for backfill (default checked).

**`components/unmapped/IgnoreModal.tsx`** — Client Component
```typescript
interface IgnoreModalProps {
  sku: string;
  onSuccess: (sku: string) => void;
  onClose: () => void;
}
```
Reason dropdown: `'Test SKU' | 'Obsolete listing' | 'Duplicate listing' | 'Other'`. Shows free-text input when 'Other' is selected.

**`components/unmapped/SeverityBadge.tsx`** — Pure display component
```typescript
interface SeverityBadgeProps {
  severity: 'Critical' | 'High' | 'Medium' | 'Low';
}
```
Renders a colored pill using Tailwind classes:
- Critical → `bg-red-100 text-red-800`
- High → `bg-orange-100 text-orange-800`
- Medium → `bg-yellow-100 text-yellow-800`
- Low → `bg-gray-100 text-gray-600`


---

## Data Models

### Database Schema Changes

#### 1. Extend `unmapped_skus` — via `ALTER TABLE` in `migrate()` (v5)

```sql
-- Add to migrate() under a new v5 block:
ALTER TABLE unmapped_skus ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE unmapped_skus ADD COLUMN ignored_reason TEXT;
ALTER TABLE unmapped_skus ADD COLUMN resolved_mapping_id INTEGER;
ALTER TABLE unmapped_skus ADD COLUMN resolved_at TEXT;
ALTER TABLE unmapped_skus ADD COLUMN total_revenue_affected REAL;
ALTER TABLE unmapped_skus ADD COLUMN marketplace_id TEXT;
```

Each statement is wrapped in `try/catch` (column-already-exists guard), matching the existing pattern in `turso.ts`.

#### 2. New table `unmapped_sku_resolutions`

```sql
CREATE TABLE IF NOT EXISTS unmapped_sku_resolutions (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  marketplace_sku      TEXT    NOT NULL,
  internal_sku         TEXT    NOT NULL,  -- empty string '' for ignore actions
  resolved_at          TEXT    NOT NULL,  -- ISO timestamp
  resolved_by          TEXT    NOT NULL,  -- 'admin' (single-user system)
  backfill_run         INTEGER NOT NULL DEFAULT 0,  -- 1 if backfill was executed
  backfill_order_count INTEGER,           -- number of orders backfilled (NULL if no backfill)
  notes                TEXT               -- ignore reason or free-form notes
);

CREATE INDEX IF NOT EXISTS idx_sku_res_sku
  ON unmapped_sku_resolutions (marketplace_sku);

CREATE INDEX IF NOT EXISTS idx_sku_res_resolved_at
  ON unmapped_sku_resolutions (resolved_at);
```

#### 3. `SCHEMA_VERSION` bump

`SCHEMA_VERSION` in `lib/db/turso.ts` is incremented from `4` to `5`. The v5 migration block runs all `ALTER TABLE` statements and creates `unmapped_sku_resolutions`.

### TypeScript Interfaces

```typescript
// lib/unmapped/types.ts

export type UnmappedSkuStatus = 'active' | 'ignored' | 'resolved';
export type Severity = 'Critical' | 'High' | 'Medium' | 'Low';

/** Full DB row shape after schema extension */
export interface UnmappedSkuDbRow {
  id: number;
  marketplace_sku: string;
  first_seen: string;           // YYYY-MM-DD
  last_seen: string;            // YYYY-MM-DD
  occurrence_count: number;
  status: UnmappedSkuStatus;
  ignored_reason: string | null;
  resolved_mapping_id: number | null;
  resolved_at: string | null;
  total_revenue_affected: number | null;
  marketplace_id: string | null;
}

/** Row shape returned by the API (adds computed severity) */
export interface UnmappedSkuRow extends UnmappedSkuDbRow {
  severity: Severity;
}

/** Resolution audit log row */
export interface ResolutionLogRow {
  id: number;
  marketplace_sku: string;
  internal_sku: string;
  resolved_at: string;
  resolved_by: string;
  backfill_run: boolean;
  backfill_order_count: number | null;
  notes: string | null;
}

/** Fuzzy match suggestion returned by GET /api/unmapped-skus/suggestions */
export interface SkuSuggestion {
  sku: string;
  item_title: string;
  qty_available: number;
  score: number;  // 0–1, not exposed to UI but used for sorting/threshold
}
```


### API Route Contracts

#### `GET /api/unmapped-skus`

Query params (all optional):
- `status`: `'active' | 'ignored' | 'resolved'`
- `severity`: `'Critical' | 'High' | 'Medium' | 'Low'`
- `marketplace_id`: string
- `include_history`: `'true'` — appends resolution log to response

Response `200`:
```typescript
{
  ok: true;
  rows: UnmappedSkuRow[];           // severity computed server-side
  history?: ResolutionLogRow[];     // only when include_history=true
}
```

#### `POST /api/unmapped-skus/[sku]/resolve`

Request body:
```typescript
{ internal_sku: string; backfill?: boolean; /* default true */ }
```

Response `200`:
```typescript
{
  ok: true;
  mapping_id: number;
  backfill_order_count: number;  // 0 if backfill=false
}
```

Errors: `400` (missing internal_sku), `404` (sku not in unmapped_skus), `500` (unexpected).

#### `POST /api/unmapped-skus/[sku]/ignore`

Request body:
```typescript
{ reason: string; }
```

Response `200`:
```typescript
{ ok: true; }
```

Errors: `400` (missing/empty reason), `404`, `500`.

#### `POST /api/unmapped-skus/bulk-resolve`

Request body:
```typescript
{ skus: string[]; internal_sku: string; backfill?: boolean; }
```

Response `200`:
```typescript
{
  ok: true;
  succeeded: number;
  failed: number;
  errors: { sku: string; error: string }[];
  total_backfill_order_count: number;
}
```

#### `POST /api/unmapped-skus/bulk-ignore`

Request body:
```typescript
{ skus: string[]; reason: string; }
```

Response `200`:
```typescript
{
  ok: true;
  succeeded: number;
  failed: number;
  errors: { sku: string; error: string }[];
}
```

#### `GET /api/unmapped-skus/suggestions`

Query params:
- `sku` (required): the marketplace SKU to find matches for

Response `200`:
```typescript
{
  ok: true;
  suggestions: Array<{ sku: string; item_title: string; qty_available: number }>;
}
```

Returns up to 5 results. Empty array if no results exceed the similarity threshold.


### Updated `getUnmappedSkus()` Query

The existing `getUnmappedSkus()` in `lib/db/queries.ts` returns all rows with no status filter. It needs two changes:

1. **Dashboard banner call** — filter `status = 'active'` only
2. **Queue page call** — new function `getUnmappedSkusWithRevenue()` that joins `orders` to compute `total_revenue_affected` and accepts an optional status filter

```typescript
// New function in lib/db/queries.ts

export interface UnmappedSkuWithRevenue {
  id: number;
  marketplace_sku: string;
  first_seen: string;
  last_seen: string;
  occurrence_count: number;
  status: string;
  ignored_reason: string | null;
  resolved_mapping_id: number | null;
  resolved_at: string | null;
  total_revenue_affected: number;
  marketplace_id: string | null;
}

export async function getUnmappedSkusWithRevenue(
  status?: 'active' | 'ignored' | 'resolved'
): Promise<UnmappedSkuWithRevenue[]> {
  const db = getDb();
  const whereClause = status ? `WHERE u.status = '${status}'` : '';
  const result = await db.execute(`
    SELECT
      u.id,
      u.marketplace_sku,
      u.first_seen,
      u.last_seen,
      u.occurrence_count,
      u.status,
      u.ignored_reason,
      u.resolved_mapping_id,
      u.resolved_at,
      u.marketplace_id,
      COALESCE(SUM(o.total_price), 0) AS total_revenue_affected
    FROM unmapped_skus u
    LEFT JOIN orders o
      ON o.sku = u.marketplace_sku
      AND o.resolved_sku IS NULL
    ${whereClause}
    GROUP BY u.id
    ORDER BY u.last_seen DESC
  `);
  // ... map rows
}
```

The existing `getUnmappedSkus()` is updated to add `WHERE status = 'active'` for the dashboard banner call in `app/page.tsx`. The banner call site changes from `getUnmappedSkus()` to `getUnmappedSkus()` with the status filter, or a new lightweight variant `getActiveUnmappedSkus()` that returns only the fields the banner needs.


---

## Severity Computation

Severity is computed in TypeScript in a shared utility so both the API and the dashboard banner use identical logic.

```typescript
// lib/unmapped/severity.ts

export type Severity = 'Critical' | 'High' | 'Medium' | 'Low';

export function computeSeverity(row: {
  last_seen: string;       // YYYY-MM-DD
  occurrence_count: number;
  status: string;
}): Severity {
  const today = new Date();
  const lastSeen = new Date(row.last_seen + 'T00:00:00');
  const daysSinceLastSeen = Math.floor(
    (today.getTime() - lastSeen.getTime()) / (1000 * 60 * 60 * 24)
  );

  // Rule 1: Critical — seen within 7 days AND >= 5 occurrences
  if (daysSinceLastSeen <= 7 && row.occurrence_count >= 5) {
    return 'Critical';
  }

  // Rule 2: Low — ignored status OR last seen > 90 days ago
  // Checked before High/Medium so ignored SKUs always show as Low
  if (row.status === 'ignored' || daysSinceLastSeen > 90) {
    return 'Low';
  }

  // Rule 3: High — >= 2 occurrences
  if (row.occurrence_count >= 2) {
    return 'High';
  }

  // Rule 4: Medium — exactly 1 occurrence
  return 'Medium';
}
```

**Design decision**: Rule 2 (Low) is evaluated before High/Medium. An ignored SKU should always appear as Low regardless of occurrence count, since it has been explicitly dismissed. The requirements state "Critical → High → Medium → Low" as the evaluation order, but the Low rule for `status = 'ignored'` is a special override that takes precedence over High/Medium (not over Critical, since a Critical SKU should not be ignorable without first being resolved). This interpretation is consistent with the intent: ignored SKUs are deprioritized.

The `computeSeverity` function is called server-side in the API route before returning rows, so the client always receives pre-computed severity values.

---

## Fuzzy Matching Algorithm

```typescript
// lib/unmapped/fuzzy.ts

const MIN_SIMILARITY_THRESHOLD = 0.3;
const MAX_SUGGESTIONS = 5;

/**
 * Normalize a string for comparison:
 * - lowercase
 * - remove non-alphanumeric characters
 * - collapse whitespace
 */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Levenshtein distance between two strings.
 * O(m*n) time, O(min(m,n)) space.
 */
function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let curr = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const next = Math.min(prev[j] + 1, curr + 1, prev[j - 1] + cost);
      prev[j - 1] = curr;
      curr = next;
    }
    prev[b.length] = curr;
  }
  return prev[b.length];
}

/**
 * Similarity score in [0, 1].
 * 1.0 = identical, 0.0 = completely different.
 * Takes the best score across the SKU field and the item_title field.
 */
export function computeSimilarity(
  query: string,
  candidate: { sku: string; item_title: string }
): number {
  const q = normalize(query);
  const skuNorm = normalize(candidate.sku);
  const titleNorm = normalize(candidate.item_title ?? '');

  const skuDist = levenshtein(q, skuNorm);
  const skuScore = 1 - skuDist / Math.max(q.length, skuNorm.length, 1);

  let titleScore = 0;
  if (titleNorm.length > 0) {
    // For titles, also check if query is a substring (prefix match bonus)
    if (titleNorm.includes(q)) {
      titleScore = 0.8;
    } else {
      const titleDist = levenshtein(q, titleNorm);
      titleScore = 1 - titleDist / Math.max(q.length, titleNorm.length, 1);
    }
  }

  return Math.max(skuScore, titleScore);
}

/**
 * Return top-N inventory candidates for a given marketplace SKU query.
 * Filters out candidates below MIN_SIMILARITY_THRESHOLD.
 */
export function getSuggestions(
  query: string,
  inventory: Array<{ sku: string; item_title: string; qty_available: number }>
): Array<{ sku: string; item_title: string; qty_available: number; score: number }> {
  const scored = inventory
    .map((item) => ({ ...item, score: computeSimilarity(query, item) }))
    .filter((item) => item.score >= MIN_SIMILARITY_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SUGGESTIONS);
  return scored;
}
```


---

## Backfill Algorithm

The backfill re-runs the existing `buildIngestRows()` pipeline for all orders that were written with `resolved_sku = NULL` for a given marketplace SKU.

```
FUNCTION runBackfill(marketplace_sku, internal_sku):

  1. Fetch fresh lookups (to pick up the mapping just created):
       mappingLookup ← buildMappingLookup()
       comboLookup   ← buildComboLookup()
       costMap       ← getCostMap()

  2. Query all affected orders:
       orders ← SELECT id, order_id, order_date, sku, qty, total_price
                 FROM orders
                 WHERE sku = marketplace_sku
                   AND resolved_sku IS NULL

  3. For each order row:
       a. Build a RawOrderItem:
            item = {
              marketplace_sku: order.sku,
              order_id:        order.order_id,
              order_date:      order.order_date,
              qty:             order.qty,
              total_price:     order.total_price,
              line_number:     0   -- already stable order_id in DB
            }

       b. Run through buildIngestRows([item], mappingLookup, comboLookup, costMap)
            → result.allocationRows  (should be non-empty now that mapping exists)
            → result.unmappedSkus    (should be empty)

       c. If result.allocationRows is non-empty:
            - Call upsertAllocations(result.allocationRows)
              (upsertAllocations deletes existing rows for the order_id first,
               so re-running is safe)
            - UPDATE orders SET resolved_sku = internal_sku
              WHERE order_id = order.order_id AND sku = marketplace_sku

       d. If result.allocationRows is empty (mapping still not resolving):
            - Log warning: "backfill: no allocation rows for order_id X"
            - Increment skipped_count, continue

  4. Return { backfilled_count, skipped_count }
```

**Key design decisions:**
- `buildIngestRows()` is reused unchanged — the backfill is just a re-ingest of existing order rows with the updated mapping lookup.
- `upsertAllocations()` already handles idempotency by deleting existing rows for the order_id before inserting, so re-running backfill is safe.
- Errors on individual rows are caught, logged, and skipped (requirement 8.6). The mapping creation is not rolled back.
- The `line_number: 0` is safe because the `order_id` in the DB is already the stable `${order_id}|${line_number}` composite key from the original ingest.

```typescript
// lib/unmapped/backfill.ts

export interface BackfillResult {
  backfilled_count: number;
  skipped_count: number;
}

export async function runBackfill(
  marketplace_sku: string,
  internal_sku: string
): Promise<BackfillResult> {
  const db = getDb();
  const [mappingLookup, comboLookup, costMap] = await Promise.all([
    buildMappingLookup(),
    buildComboLookup(),
    getCostMap(),
  ]);

  const result = await db.execute({
    sql: `SELECT order_id, order_date, sku, qty, total_price
          FROM orders
          WHERE sku = ? AND resolved_sku IS NULL`,
    args: [marketplace_sku],
  });

  let backfilled_count = 0;
  let skipped_count = 0;

  for (const row of result.rows) {
    try {
      const item: RawOrderItem = {
        marketplace_sku: row.sku as string,
        order_id: row.order_id as string,
        order_date: row.order_date as string,
        qty: Number(row.qty),
        total_price: Number(row.total_price),
        line_number: 0,
      };

      const ingestResult = buildIngestRows([item], mappingLookup, comboLookup, costMap);

      if (ingestResult.allocationRows.length > 0) {
        await upsertAllocations(ingestResult.allocationRows);
        await db.execute({
          sql: `UPDATE orders SET resolved_sku = ?
                WHERE order_id = ? AND sku = ?`,
          args: [internal_sku, row.order_id as string, marketplace_sku],
        });
        backfilled_count++;
      } else {
        console.warn(`[backfill] no allocation rows for order_id=${row.order_id}`);
        skipped_count++;
      }
    } catch (err) {
      console.error(`[backfill] error on order_id=${row.order_id}:`, err);
      skipped_count++;
    }
  }

  return { backfilled_count, skipped_count };
}
```


---

## Dashboard Banner Update

`app/page.tsx` currently calls `getUnmappedSkus()` which returns all rows with no status filter. The changes needed:

1. Replace the `getUnmappedSkus()` call with `getActiveUnmappedSkus()` — a new lightweight query that filters `status = 'active'` and returns only the fields the banner needs.

2. Compute severity breakdown from the returned rows using `computeSeverity()`.

3. Update the banner JSX to show severity counts and the "Review Queue →" link.

```typescript
// New query in lib/db/queries.ts
export async function getActiveUnmappedSkus(): Promise<
  { marketplace_sku: string; last_seen: string; occurrence_count: number; status: string }[]
> {
  const db = getDb();
  const result = await db.execute(
    `SELECT marketplace_sku, last_seen, occurrence_count, status
     FROM unmapped_skus
     WHERE status = 'active'
     ORDER BY last_seen DESC`
  );
  return result.rows.map((r) => ({
    marketplace_sku: r.marketplace_sku as string,
    last_seen: r.last_seen as string,
    occurrence_count: Number(r.occurrence_count),
    status: r.status as string,
  }));
}
```

Banner update in `app/page.tsx`:
```tsx
// Replace getUnmappedSkus() call with getActiveUnmappedSkus()
// Then compute severity breakdown:
const severityCounts = { Critical: 0, High: 0, Medium: 0, Low: 0 };
for (const u of unmappedSkus) {
  const sev = computeSeverity(u);
  severityCounts[sev]++;
}

// Banner JSX changes:
// - Show severity breakdown: "3 Critical, 2 High, 1 Medium"
// - Limit SKU chips to first 10 (was 20), add "+N more" linking to /unmapped-skus
// - Add "Review Queue →" link to /unmapped-skus
// - Hide banner entirely when unmappedSkus.length === 0
```

---

## Error Handling Strategy

### Migration Errors (Requirement 1.9)
`migrate()` is called inside a `try/catch` in `app/page.tsx` and will be called the same way in `app/unmapped-skus/page.tsx`. If migration fails, the page continues to render but the unmapped-sku API routes will return HTTP 500 (the DB queries will fail with a missing-column error, which is caught and returned as `{ ok: false, error: "..." }`).

### API Route Errors
All API routes follow the existing pattern:
```typescript
try {
  // ... logic
  return NextResponse.json({ ok: true, ... });
} catch (err) {
  const message = err instanceof Error ? err.message : 'Unknown error';
  console.error('[route] error:', err);
  return NextResponse.json({ ok: false, error: message }, { status: 500 });
}
```

Validation errors return HTTP 400 before the try/catch:
```typescript
if (!body.internal_sku) {
  return NextResponse.json({ ok: false, error: 'internal_sku is required' }, { status: 400 });
}
```

### Backfill Errors (Requirement 8.6)
Individual order row failures during backfill are caught per-row, logged with `console.error`, and counted in `skipped_count`. The mapping creation and `unmapped_skus` status update are committed before backfill starts, so a partial backfill failure does not roll back the mapping.

### Bulk Operation Errors (Requirement 7.8)
Bulk endpoints process each SKU in a loop with individual try/catch. Failures are collected into an `errors` array and returned in the response summary. The loop continues regardless of individual failures.

### Client-Side Errors
The `ResolveModal` and `IgnoreModal` display inline error messages when the API call fails. The queue list is not modified on failure (no optimistic update on error).


---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

The following properties are derived from the acceptance criteria. The feature has several pure functions (`computeSeverity`, `computeSimilarity`, `getSuggestions`) and a data-transformation pipeline (`buildIngestRows` reused in backfill) that are well-suited to property-based testing. Infrastructure wiring, UI rendering, and endpoint integration tests are handled separately as examples or integration tests.

**Property reflection**: After reviewing all testable criteria, the severity rules (3.1–3.5) can be consolidated into two properties: one for the classification rules themselves, and one for rule priority. The backfill correctness (8.2) and error resilience (8.6) are distinct enough to keep separate. The filter correctness (12.1) and queue ordering (2.3) can be combined since ordering depends on severity which depends on the filter.

---

### Property 1: Severity classification is exhaustive and deterministic

*For any* unmapped SKU row with valid `last_seen`, `occurrence_count`, and `status` fields, `computeSeverity()` SHALL return exactly one of `'Critical'`, `'High'`, `'Medium'`, or `'Low'`, and calling it twice with the same input SHALL return the same value.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4**

---

### Property 2: Severity rule priority — Critical always wins

*For any* unmapped SKU row where `last_seen` is within the past 7 days AND `occurrence_count >= 5`, `computeSeverity()` SHALL return `'Critical'` regardless of the `status` field value.

**Validates: Requirements 3.1, 3.5**

---

### Property 3: Ignored SKUs are always Low severity

*For any* unmapped SKU row where `status = 'ignored'`, `computeSeverity()` SHALL return `'Low'` unless the row also qualifies as Critical (i.e., `last_seen` within 7 days AND `occurrence_count >= 5`).

**Validates: Requirements 3.4, 3.5**

---

### Property 4: Active queue contains only active rows

*For any* call to `GET /api/unmapped-skus` with `status = 'active'` (or the default), every row in the response SHALL have `status = 'active'`; no `'ignored'` or `'resolved'` rows SHALL appear.

**Validates: Requirements 2.3, 11.5, 12.1**

---

### Property 5: Severity filter correctness

*For any* call to `GET /api/unmapped-skus` with a `severity` filter parameter, every row in the response SHALL have a `severity` field equal to the requested filter value.

**Validates: Requirements 12.1**

---

### Property 6: Fuzzy suggestions are ranked by descending similarity score

*For any* query string and inventory list, the array returned by `getSuggestions()` SHALL be ordered such that `suggestions[i].score >= suggestions[i+1].score` for all valid indices, and no returned suggestion SHALL have a score below `MIN_SIMILARITY_THRESHOLD`.

**Validates: Requirements 9.2, 9.3, 9.6**

---

### Property 7: Backfill produces allocation rows for all previously-unresolved orders

*For any* marketplace SKU that has been resolved (mapping created), after `runBackfill()` completes, every `orders` row where `sku = marketplace_sku` that previously had `resolved_sku IS NULL` SHALL either have `resolved_sku` set to the new `internal_sku` (and corresponding `order_item_allocations` rows written), or appear in the `skipped_count` due to a logged error.

**Validates: Requirements 8.2, 8.3**

---

### Property 8: Bulk operations are resilient to partial failures

*For any* bulk resolve or bulk ignore request containing N SKUs where some subset fails, the endpoint SHALL process all N SKUs independently, return `succeeded + failed = N`, and the `errors` array SHALL contain exactly one entry per failed SKU.

**Validates: Requirements 7.8**

---

### Property 9: Migration idempotency

*For any* number of sequential calls to `migrate()` on a database that already has the current schema version, `migrate()` SHALL complete without error and the schema SHALL remain in the correct state.

**Validates: Requirements 1.8**

---

### Property 10: Revenue impact aggregation correctness

*For any* set of `orders` rows where `sku = marketplace_sku AND resolved_sku IS NULL`, the `total_revenue_affected` value returned by `getUnmappedSkusWithRevenue()` SHALL equal the arithmetic sum of `total_price` for those rows (within floating-point rounding tolerance of ±0.01).

**Validates: Requirements 4.1**


---

## Testing Strategy

### Unit Tests

Focus on pure functions and specific examples:

- `computeSeverity()` — one test per severity level with concrete inputs, plus boundary cases (exactly 7 days ago, exactly 5 occurrences, exactly 90 days ago)
- `computeSimilarity()` — identical strings return 1.0, completely different strings return near 0, known pairs return expected scores
- `normalize()` — specific strings with special characters, mixed case, spaces
- `getSuggestions()` — empty inventory returns empty array, all below threshold returns empty array
- `SeverityBadge` — renders correct Tailwind class for each severity value
- USD formatting — `$0.00` for null/zero, correct formatting for known values
- Ignore modal — 'Other' option shows free-text input, other options do not

### Property-Based Tests

Use a property-based testing library (recommended: `fast-check` for TypeScript/Node.js). Configure each test to run minimum 100 iterations.

```typescript
// Example property test structure (fast-check)
// Feature: unmapped-sku-workflow, Property 1: Severity classification is exhaustive and deterministic

import fc from 'fast-check';
import { computeSeverity } from '@/lib/unmapped/severity';

test('Property 1: computeSeverity is exhaustive and deterministic', () => {
  fc.assert(
    fc.property(
      fc.record({
        last_seen: fc.date({ min: new Date('2020-01-01'), max: new Date() })
          .map(d => d.toISOString().slice(0, 10)),
        occurrence_count: fc.integer({ min: 1, max: 1000 }),
        status: fc.constantFrom('active', 'ignored', 'resolved'),
      }),
      (row) => {
        const result1 = computeSeverity(row);
        const result2 = computeSeverity(row);
        const validValues = ['Critical', 'High', 'Medium', 'Low'];
        return validValues.includes(result1) && result1 === result2;
      }
    ),
    { numRuns: 100 }
  );
});
```

Each property test is tagged with a comment:
```
// Feature: unmapped-sku-workflow, Property N: <property_text>
```

Properties 1–3 (severity): pure function tests, no DB needed.
Properties 4–5 (filter/queue): test the query-building logic with an in-memory mock or a test DB.
Property 6 (fuzzy): pure function test against generated inventory arrays.
Properties 7–8 (backfill, bulk): use a test DB (Turso in-memory mode or SQLite via `better-sqlite3` for tests).
Properties 9–10 (migration, revenue): use a test DB.

### Integration Tests

- `POST /api/unmapped-skus/[sku]/resolve` — creates mapping row, updates status, writes audit row
- `POST /api/unmapped-skus/[sku]/ignore` — updates status and ignored_reason
- Backfill end-to-end: seed orders with `resolved_sku = NULL`, resolve, verify allocations written
- Dashboard banner: verify `getActiveUnmappedSkus()` excludes ignored/resolved rows

### Not Tested (by design)

- UI visual appearance and layout (Tailwind classes are verified by unit tests on `SeverityBadge`, not visual regression)
- Middleware authentication (covered by existing middleware tests)
- Teapplix API integration (out of scope for this feature)

