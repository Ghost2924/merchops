# Requirements Document

## Introduction

The Unmapped SKU Workflow transforms the existing passive warning banner into an active operational queue that a non-technical business user can work through without engineering involvement. When a marketplace SKU (e.g. an Amazon ASIN or raw storefront SKU) has no entry in `marketplace_item_mappings`, orders for that SKU are written to the `orders` table with `resolved_sku = NULL` and no allocation rows are created in `order_item_allocations`. This means inventory depletion is not tracked and restock planning is blind to those sales. The feature provides a dedicated queue page, severity classification, per-SKU detail with estimated revenue impact, resolve and ignore actions, bulk operations, post-resolve backfill, fuzzy-match suggestions, an audit trail, and an upgraded dashboard banner.

## Glossary

- **Unmapped_SKU**: A marketplace SKU present in the `unmapped_skus` table that has no corresponding row in `marketplace_item_mappings`.
- **Queue**: The set of all `unmapped_skus` rows whose `status` is `active`.
- **Severity**: A classification label (Critical, High, Medium, Low) assigned to each Unmapped_SKU based on recency and occurrence count.
- **Internal_SKU**: A canonical warehouse SKU stored in the `inventory` table (e.g. `AM-5234`).
- **Marketplace_SKU**: The raw storefront identifier sent by Teapplix (e.g. `B0GFYCV87C` or `5003DM-4-LA`).
- **Resolve**: The act of creating a `marketplace_item_mappings` row that links a Marketplace_SKU to an Internal_SKU, removing the SKU from the active Queue.
- **Ignore**: The act of marking an Unmapped_SKU with `status = 'ignored'` so it is hidden from the active Queue without creating a mapping.
- **Backfill**: Re-running the allocation logic for all `orders` rows where `sku = marketplace_sku AND resolved_sku IS NULL` after a mapping is created, so that `order_item_allocations` rows are retroactively written and `resolved_sku` is updated.
- **Fuzzy_Match**: A candidate Internal_SKU suggested by string-similarity comparison against the Marketplace_SKU being resolved.
- **Resolution_Log**: A row in the `unmapped_sku_resolutions` table recording who resolved a SKU, when, and whether a backfill was run.
- **Dashboard_Banner**: The existing red warning strip on the main dashboard page (`app/page.tsx`) that currently lists Unmapped_SKUs.
- **Admin**: The single shared authenticated user of the dashboard (password-protected via `middleware.ts`).

---

## Requirements

### Requirement 1: Database Schema Extensions

**User Story:** As a developer, I want the `unmapped_skus` table and a new `unmapped_sku_resolutions` table to carry the fields needed by the workflow, so that status, ignore reasons, revenue impact, and audit history can be persisted.

#### Acceptance Criteria

1. THE `unmapped_skus` table SHALL include a `status` column with allowed values `'active'`, `'ignored'`, and `'resolved'`, defaulting to `'active'`.
2. THE `unmapped_skus` table SHALL include an `ignored_reason` TEXT column that is nullable.
3. THE `unmapped_skus` table SHALL include a `resolved_mapping_id` INTEGER column that is nullable and references `marketplace_item_mappings.id`.
4. THE `unmapped_skus` table SHALL include a `resolved_at` TEXT column (ISO date string, nullable).
5. THE `unmapped_skus` table SHALL include a `total_revenue_affected` REAL column that is nullable, storing the sum of `orders.total_price` for all orders where `sku = marketplace_sku AND resolved_sku IS NULL`.
6. THE `unmapped_skus` table SHALL include a `marketplace_id` TEXT column that is nullable, storing the originating marketplace identifier (e.g. `'AMAZON_US'`).
7. THE `unmapped_sku_resolutions` table SHALL exist with columns: `id` INTEGER PRIMARY KEY AUTOINCREMENT, `marketplace_sku` TEXT NOT NULL, `internal_sku` TEXT NOT NULL, `resolved_at` TEXT NOT NULL, `resolved_by` TEXT NOT NULL, `backfill_run` INTEGER NOT NULL DEFAULT 0, `backfill_order_count` INTEGER, `notes` TEXT.
8. WHEN the application starts, THE Migration_Runner SHALL apply schema changes idempotently using `ALTER TABLE … ADD COLUMN IF NOT EXISTS` or equivalent guards so that existing data is not lost.
9. IF the Migration_Runner fails to apply schema changes, THEN THE application SHALL continue to start and log the migration error server-side, allowing the rest of the dashboard to function while the unmapped-sku workflow routes return HTTP 500 until the schema is corrected.

---

### Requirement 2: Unmapped SKU Queue Page

**User Story:** As a business user, I want a dedicated page that shows all active Unmapped_SKUs as an actionable list, so that I can see exactly what needs to be resolved and work through the queue systematically.

#### Acceptance Criteria

1. THE Queue_Page SHALL be accessible at the route `/unmapped-skus`.
2. THE Queue_Page SHALL be protected by the same cookie-based authentication used by the rest of the dashboard (enforced by `middleware.ts`).
3. WHEN the Queue_Page loads, THE Queue_Page SHALL display all `unmapped_skus` rows where `status = 'active'` ordered by severity descending, then by `last_seen` descending.
4. WHEN the Queue_Page loads, THE Queue_Page SHALL display a summary header showing the total count of active Unmapped_SKUs and a breakdown count per severity level (Critical, High, Medium, Low).
5. THE Queue_Page SHALL provide filter controls allowing the user to filter the list by status (`active`, `ignored`, `resolved`), by severity level, and by marketplace_id.
6. WHEN no active Unmapped_SKUs exist, THE Queue_Page SHALL display a confirmation message indicating the queue is clear.
7. THE Queue_Page SHALL display each Unmapped_SKU row with: Marketplace_SKU, severity badge, first_seen date, last_seen date, occurrence_count, estimated revenue affected, and marketplace_id.
8. THE Queue_Page SHALL provide a "Resolve" action button per row that opens the Resolve_Modal.
9. THE Queue_Page SHALL provide an "Ignore" action button per row that opens the Ignore_Modal.
10. THE Queue_Page SHALL provide checkboxes on each row to enable bulk selection.

---

### Requirement 3: Severity Classification

**User Story:** As a business user, I want each Unmapped_SKU to be automatically classified by severity, so that I can prioritize the most impactful SKUs first.

#### Acceptance Criteria

1. THE Severity_Classifier SHALL assign severity `'Critical'` to any Unmapped_SKU where `last_seen` is within the past 7 days AND `occurrence_count >= 5`.
2. THE Severity_Classifier SHALL assign severity `'High'` to any Unmapped_SKU where `occurrence_count >= 2` AND the SKU does not qualify as Critical.
3. THE Severity_Classifier SHALL assign severity `'Medium'` to any Unmapped_SKU where `occurrence_count = 1` AND the SKU does not qualify as Critical or High.
4. THE Severity_Classifier SHALL assign severity `'Low'` to any Unmapped_SKU where `status = 'ignored'` OR `last_seen` is more than 90 days ago.
5. WHEN severity is computed, THE Severity_Classifier SHALL evaluate rules in the order: Critical → High → Medium → Low, applying the first matching rule.
6. THE Severity_Badge component SHALL render Critical as red, High as orange, Medium as yellow, and Low as gray.

---

### Requirement 4: Per-SKU Revenue Impact

**User Story:** As a business user, I want to see the estimated revenue affected by each Unmapped_SKU, so that I can understand the financial cost of leaving it unresolved.

#### Acceptance Criteria

1. WHEN the Queue_Page loads, THE Revenue_Calculator SHALL compute `total_revenue_affected` for each Unmapped_SKU as the sum of `orders.total_price` for all rows where `orders.sku = unmapped_skus.marketplace_sku AND orders.resolved_sku IS NULL`.
2. THE Queue_Page SHALL display `total_revenue_affected` formatted as a USD currency value (e.g. `$1,234.56`).
3. WHEN `total_revenue_affected` is NULL or zero, THE Queue_Page SHALL display `$0.00` rather than a blank cell.
4. THE `GET /api/unmapped-skus` endpoint SHALL return `total_revenue_affected` as a field in each row of the response.

---

### Requirement 5: Resolve Action

**User Story:** As a business user, I want to resolve an Unmapped_SKU by selecting the correct Internal_SKU from a searchable dropdown, so that future and historical orders for that SKU are correctly attributed.

#### Acceptance Criteria

1. WHEN the user clicks "Resolve" on a Queue row, THE Resolve_Modal SHALL open displaying the Marketplace_SKU being resolved, a searchable Internal_SKU dropdown populated from the `inventory` table, a list of Fuzzy_Match suggestions, and a "Backfill affected orders" checkbox.
2. WHEN the user types in the Internal_SKU search field, THE Resolve_Modal SHALL filter the dropdown options to inventory SKUs whose `sku` or `item_title` contains the typed string (case-insensitive).
3. WHEN the user submits the Resolve_Modal with a selected Internal_SKU, THE Resolve_Action SHALL call `POST /api/unmapped-skus/:sku/resolve` with the selected `internal_sku` and the `backfill` flag.
4. WHEN `POST /api/unmapped-skus/:sku/resolve` is called, THE Resolve_Endpoint SHALL create a row in `marketplace_item_mappings` with `marketplace_id` from the unmapped SKU record (defaulting to `'AMAZON_US'`), `marketplace_sku`, and `internal_sku`.
5. WHEN `POST /api/unmapped-skus/:sku/resolve` is called, THE Resolve_Endpoint SHALL update the `unmapped_skus` row to set `status = 'resolved'`, `resolved_at` to the current ISO timestamp, and `resolved_mapping_id` to the new mapping's `id`.
6. WHEN `POST /api/unmapped-skus/:sku/resolve` is called, THE Resolve_Endpoint SHALL insert a row into `unmapped_sku_resolutions` with `marketplace_sku`, `internal_sku`, `resolved_at`, `resolved_by = 'admin'`, and `backfill_run` set to 1 if backfill was requested, 0 otherwise.
7. WHEN the resolve succeeds, THE Queue_Page SHALL remove the resolved row from the active queue display without a full page reload.
8. IF `POST /api/unmapped-skus/:sku/resolve` is called with a missing or empty `internal_sku`, THEN THE Resolve_Endpoint SHALL return HTTP 400 with a descriptive error message.
9. IF `POST /api/unmapped-skus/:sku/resolve` is called for a `marketplace_sku` that does not exist in `unmapped_skus`, THEN THE Resolve_Endpoint SHALL return HTTP 404.

---

### Requirement 6: Ignore Action

**User Story:** As a business user, I want to mark an Unmapped_SKU as ignored with a reason, so that test SKUs, obsolete listings, and duplicates are hidden from the active queue without creating a spurious mapping.

#### Acceptance Criteria

1. WHEN the user clicks "Ignore" on a Queue row, THE Ignore_Modal SHALL open displaying the Marketplace_SKU and a reason dropdown with options: `'Test SKU'`, `'Obsolete listing'`, `'Duplicate listing'`, `'Other'`.
2. WHEN the user selects `'Other'`, THE Ignore_Modal SHALL display a free-text input for a custom reason.
3. WHEN the user submits the Ignore_Modal, THE Ignore_Action SHALL call `POST /api/unmapped-skus/:sku/ignore` with the selected reason.
4. WHEN `POST /api/unmapped-skus/:sku/ignore` is called, THE Ignore_Endpoint SHALL update the `unmapped_skus` row to set `status = 'ignored'` and `ignored_reason` to the provided reason string.
5. WHEN the ignore succeeds, THE Queue_Page SHALL remove the ignored row from the active queue display without a full page reload.
6. IF `POST /api/unmapped-skus/:sku/ignore` is called with a missing or empty reason, THEN THE Ignore_Endpoint SHALL return HTTP 400 with a descriptive error message.
7. WHEN the user filters the Queue_Page by status `'ignored'`, THE Queue_Page SHALL display all ignored SKUs with their `ignored_reason` visible in a dedicated column; `ignored_reason` SHALL NOT be shown in any other queue view or filter context.

---

### Requirement 7: Bulk Actions

**User Story:** As a business user, I want to resolve or ignore multiple Unmapped_SKUs at once, so that I can clear large batches of similar SKUs efficiently.

#### Acceptance Criteria

1. WHEN the user selects two or more rows via checkboxes, THE Queue_Page SHALL display a bulk action toolbar showing the count of selected rows and "Bulk Resolve" and "Bulk Ignore" buttons.
2. WHEN the user clicks "Bulk Resolve", THE Bulk_Resolve_Modal SHALL open with a single Internal_SKU search field that will be applied to all selected Marketplace_SKUs.
3. WHEN the user submits the Bulk_Resolve_Modal, THE Bulk_Resolve_Action SHALL call `POST /api/unmapped-skus/bulk-resolve` with an array of `marketplace_sku` values and the shared `internal_sku`.
4. WHEN `POST /api/unmapped-skus/bulk-resolve` is called, THE Bulk_Resolve_Endpoint SHALL process each SKU identically to the single-resolve endpoint and return a summary of how many succeeded and how many failed.
5. WHEN the user clicks "Bulk Ignore", THE Bulk_Ignore_Modal SHALL open with the same reason dropdown as the single Ignore_Modal, applied to all selected rows.
6. WHEN the user submits the Bulk_Ignore_Modal, THE Bulk_Ignore_Action SHALL call `POST /api/unmapped-skus/bulk-ignore` with an array of `marketplace_sku` values and the shared reason.
7. WHEN `POST /api/unmapped-skus/bulk-ignore` is called, THE Bulk_Ignore_Endpoint SHALL process each SKU identically to the single-ignore endpoint and return a summary of how many succeeded and how many failed.
8. IF any individual SKU in a bulk operation fails, THEN THE Bulk_Endpoint SHALL continue processing the remaining SKUs and include the failures in the response summary rather than aborting the entire batch.

---

### Requirement 8: Post-Resolve Backfill

**User Story:** As a business user, I want the option to backfill historical orders after resolving a mapping, so that inventory depletion and restock planning immediately reflect the previously untracked sales.

#### Acceptance Criteria

1. WHEN the Resolve_Modal is open, THE Resolve_Modal SHALL display a "Backfill affected orders" checkbox that is checked by default.
2. WHEN the user submits the Resolve_Modal with the backfill checkbox checked, THE Resolve_Endpoint SHALL identify all `orders` rows where `sku = marketplace_sku AND resolved_sku IS NULL` and re-run the allocation logic for each, writing rows to `order_item_allocations` and updating `orders.resolved_sku` to the new `internal_sku`.
3. WHEN backfill completes, THE Resolve_Endpoint SHALL update the `unmapped_sku_resolutions` row to set `backfill_run = 1` and `backfill_order_count` to the number of orders that were backfilled.
4. WHEN the resolve response is returned to the client, THE response SHALL include `backfill_order_count` so the UI can display a confirmation message (e.g. "Mapping saved. 12 historical orders backfilled.").
5. WHEN the user submits the Resolve_Modal with the backfill checkbox unchecked, THE Resolve_Endpoint SHALL skip writing allocation rows and updating `orders.resolved_sku`, and SHALL set `backfill_run = 0` in the resolution log; the mapping row in `marketplace_item_mappings` SHALL still be created so future syncs route the SKU correctly.
6. IF backfill encounters an error for a specific order row, THEN THE Resolve_Endpoint SHALL log the error, skip that row, and continue processing remaining rows rather than rolling back the entire mapping creation.

---

### Requirement 9: Fuzzy-Match Suggestions

**User Story:** As a business user, I want the Resolve_Modal to suggest likely Internal_SKU matches based on string similarity, so that I can resolve SKUs quickly without manually searching the full inventory list.

#### Acceptance Criteria

1. WHEN the Resolve_Modal opens for a given Marketplace_SKU, THE Suggestion_Engine SHALL call `GET /api/unmapped-skus/suggestions?sku=<marketplace_sku>` to retrieve candidate Internal_SKUs.
2. THE `GET /api/unmapped-skus/suggestions` endpoint SHALL return up to 5 candidate Internal_SKUs from the `inventory` table ranked by string similarity to the query `sku` parameter.
3. THE Suggestion_Engine SHALL compute similarity using a character-level comparison that considers both the `inventory.sku` field and the `inventory.item_title` field.
4. THE Resolve_Modal SHALL display each suggestion with its `sku`, `item_title`, and `qty_available` so the user can make an informed choice, regardless of the suggestion's similarity score.
5. WHEN the user clicks a suggestion, THE Resolve_Modal SHALL populate the Internal_SKU field with that suggestion's `sku`; IF the population fails due to a system error, THEN THE Resolve_Modal SHALL display an inline error message and allow the user to retry or manually type the SKU.
6. IF no suggestions score above a minimum similarity threshold, THEN THE Suggestion_Engine SHALL return an empty array rather than low-quality matches.

---

### Requirement 10: Audit Trail

**User Story:** As a business user, I want a log of every resolve and ignore action, so that I can review what was changed and when.

#### Acceptance Criteria

1. WHEN a Resolve action completes successfully, THE Audit_Logger SHALL insert a row into `unmapped_sku_resolutions` with `marketplace_sku`, `internal_sku`, `resolved_at` (current ISO timestamp), `resolved_by = 'admin'`, `backfill_run`, and `backfill_order_count`.
2. WHEN an Ignore action completes successfully, THE Audit_Logger SHALL insert a row into `unmapped_sku_resolutions` with `marketplace_sku`, `internal_sku = ''`, `resolved_at` (current ISO timestamp), `resolved_by = 'admin'`, `backfill_run = 0`, and `notes` set to the ignore reason.
3. THE Queue_Page SHALL include a "Resolution History" section or tab that displays all rows from `unmapped_sku_resolutions` ordered by `resolved_at` descending.
4. THE Resolution_History display SHALL show: Marketplace_SKU, Internal_SKU (or "Ignored"), resolved_at, resolved_by, backfill_run (yes/no), backfill_order_count, and notes.
5. THE `GET /api/unmapped-skus` endpoint SHALL accept an optional `include_history=true` query parameter that appends the resolution history to the response.

---

### Requirement 11: Dashboard Banner Integration

**User Story:** As a business user, I want the existing dashboard warning banner to link directly to the Queue_Page and show a severity breakdown, so that I can navigate to the workflow in one click.

#### Acceptance Criteria

1. WHEN `unmapped_skus` rows with `status = 'active'` exist, THE Dashboard_Banner SHALL display the total count of active Unmapped_SKUs and a count per severity level (e.g. "3 Critical, 2 High, 1 Medium").
2. THE Dashboard_Banner SHALL include a "Review Queue →" link that navigates to `/unmapped-skus`.
3. WHEN all `unmapped_skus` rows have `status` of `'ignored'` or `'resolved'` (i.e. the active queue is empty), THE Dashboard_Banner SHALL not be rendered.
4. THE Dashboard_Banner SHALL continue to display the list of active Marketplace_SKU chips as it does today, limited to the first 10 with a "+N more" overflow label linking to the Queue_Page.
5. WHEN the Dashboard_Banner is rendered, THE Dashboard_Banner SHALL fetch only `status = 'active'` rows from `unmapped_skus` so that ignored and resolved SKUs do not inflate the count.

---

### Requirement 12: API Endpoints

**User Story:** As a developer, I want well-defined API routes for all queue operations, so that the UI components have a consistent, validated interface to interact with.

#### Acceptance Criteria

1. THE `GET /api/unmapped-skus` endpoint SHALL accept optional query parameters `status` (one of `active`, `ignored`, `resolved`), `severity` (one of `Critical`, `High`, `Medium`, `Low`), and `marketplace_id` (string), and SHALL return only rows matching all provided filters.
2. THE `GET /api/unmapped-skus` endpoint SHALL return each row with fields: `id`, `marketplace_sku`, `status`, `severity`, `first_seen`, `last_seen`, `occurrence_count`, `total_revenue_affected`, `marketplace_id`, `ignored_reason`, `resolved_at`.
3. THE `POST /api/unmapped-skus/:sku/resolve` endpoint SHALL accept a JSON body with `internal_sku` (required, string) and `backfill` (optional, boolean, default true).
4. THE `POST /api/unmapped-skus/:sku/ignore` endpoint SHALL accept a JSON body with `reason` (required, string).
5. THE `POST /api/unmapped-skus/bulk-resolve` endpoint SHALL accept a JSON body with `skus` (required, non-empty array of strings) and `internal_sku` (required, string).
6. THE `POST /api/unmapped-skus/bulk-ignore` endpoint SHALL accept a JSON body with `skus` (required, non-empty array of strings) and `reason` (required, string).
7. THE `GET /api/unmapped-skus/suggestions` endpoint SHALL accept a required `sku` query parameter and return an array of up to 5 objects each containing `sku`, `item_title`, and `qty_available`.
8. IF any API endpoint receives a request body that fails validation, THEN THE endpoint SHALL return HTTP 400 with a JSON body containing an `error` field describing the validation failure.
9. IF any API endpoint encounters an unexpected server error, THEN THE endpoint SHALL return HTTP 500 with a JSON body containing an `error` field and SHALL log the error server-side.
