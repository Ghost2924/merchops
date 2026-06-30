import { createClient } from '@libsql/client';
import fs from 'fs';
import path from 'path';
import { getOrgContext } from './context';

const globalForTurso = globalThis as unknown as {
  _client?: ReturnType<typeof createClient>;
  _appliedVersion?: number;
  _migrationPromise?: Promise<void>;
};

const SCHEMA_VERSION = 19;

const coreTables = [
  'inventory_products',
  'combo_products',
  'needs_review_products',
  'combo_components',
  'sku_mappings',
  'order_lines',
  'inventory_allocations',
  'unmapped_skus',
  'mapping_errors',
  'inventory_snapshots',
  'integrations',
  'daily_marketing_spend',
  'asin_ad_spend',
  'vendor_ara_metrics',
  'vendor_inventory_health',
  'vendor_pending_reports',
  'open_purchase_orders',
  'asin_title_cache',
  'asin_coupon_metrics',
  'asin_promotion_metrics',
  'asin_net_retail_costs',
  'sync_status',
  'orders',
  'order_item_allocations',
  'marketplace_item_mappings',
  'combo_product_recipes',
  'organization_credentials'
];

/**
 * Automatically rewrites raw SQLite queries to inject tenant-level isolation
 * by checking the active Clerk organization_id.
 */
export function rewriteSql(sql: string, orgId: string): string {
  // Skip schema definition and migration queries
  if (/^\s*(CREATE|ALTER|DROP|PRAGMA|REINDEX)\b/i.test(sql)) {
    return sql;
  }

  const escapedOrgId = orgId.replace(/'/g, "''");

  // 1. Rewrite INSERT queries:
  // INSERT INTO table (col1, col2) VALUES (val1, val2)
  const insertRegex = /^\s*(INSERT(?:\s+OR\s+\w+)?\s+INTO\s+)(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i;
  const insertMatch = sql.match(insertRegex);
  if (insertMatch) {
    const [_, prefix, tableName, columns, values] = insertMatch;
    if (coreTables.includes(tableName.toLowerCase())) {
      let newColumns = `organization_id, ${columns}`;
      let newValues = `'${escapedOrgId}', ${values}`;
      let rewritten = `${prefix}${tableName} (${newColumns}) VALUES (${newValues})`;
      // Keep any ON CONFLICT clauses and rewrite their target columns
      const rest = sql.slice(insertMatch[0].length);
      if (rest) {
        const conflictRegex = /\bON\b\s+\bCONFLICT\b\s*\(([^)]+)\)/i;
        const conflictMatch = rest.match(conflictRegex);
        if (conflictMatch) {
          const conflictCols = conflictMatch[1];
          if (!conflictCols.toLowerCase().includes('organization_id')) {
            const rewrittenConflict = `ON CONFLICT (organization_id, ${conflictCols})`;
            rewritten += rest.replace(conflictMatch[0], rewrittenConflict);
          } else {
            rewritten += rest;
          }
        } else {
          rewritten += rest;
        }
      }
      return rewritten;
    }
  }

  // 2. Rewrite UPDATE queries:
  // UPDATE table SET col1 = val1 WHERE col2 = val2
  const updateRegex = /^\s*(UPDATE\s+)(\w+)\s+(SET\s+[\s\S]*?)(?:\s+WHERE\s+([\s\S]*))?$/i;
  const updateMatch = sql.match(updateRegex);
  if (updateMatch) {
    const [_, prefix, tableName, setClause, whereClause] = updateMatch;
    if (coreTables.includes(tableName.toLowerCase())) {
      if (whereClause) {
        return `${prefix}${tableName} ${setClause} WHERE organization_id = '${escapedOrgId}' AND (${whereClause})`;
      } else {
        return `${prefix}${tableName} ${setClause} WHERE organization_id = '${escapedOrgId}'`;
      }
    }
  }

  // 3. Rewrite DELETE queries:
  // DELETE FROM table WHERE col1 = val1
  const deleteRegex = /^\s*(DELETE\s+FROM\s+)(\w+)(?:\s+WHERE\s+([\s\S]*))?$/i;
  const deleteMatch = sql.match(deleteRegex);
  if (deleteMatch) {
    const [_, prefix, tableName, whereClause] = deleteMatch;
    if (coreTables.includes(tableName.toLowerCase())) {
      if (whereClause) {
        return `${prefix}${tableName} WHERE organization_id = '${escapedOrgId}' AND (${whereClause})`;
      } else {
        return `${prefix}${tableName} WHERE organization_id = '${escapedOrgId}'`;
      }
    }
  }

  // 4. Rewrite SELECT queries:
  // Replace references to coreTables in FROM or JOIN clauses with subqueries filtered by organization_id.
  let rewritten = sql;
  for (const table of coreTables) {
    const selectPattern = new RegExp(`(\\b(?:FROM|JOIN)\\s+)${table}\\b(?!\\.)`, 'gi');
    rewritten = rewritten.replace(selectPattern, `$1(SELECT * FROM ${table} WHERE organization_id = '${escapedOrgId}')`);
  }

  return rewritten;
}

function rewriteStatement(stmt: any, orgId: string): any {
  if (typeof stmt === 'string') {
    return rewriteSql(stmt, orgId);
  }
  if (stmt && typeof stmt === 'object' && typeof stmt.sql === 'string') {
    return {
      ...stmt,
      sql: rewriteSql(stmt.sql, orgId),
    };
  }
  return stmt;
}

function wrapTransaction(tx: any): any {
  return new Proxy(tx, {
    get(target, prop, receiver) {
      if (prop === 'execute') {
        return async function (stmt: any) {
          const { orgId, bypass } = getOrgContext();
          if (orgId && !bypass) {
            stmt = rewriteStatement(stmt, orgId);
          }
          return target.execute(stmt);
        };
      }
      if (prop === 'batch') {
        return async function (stmts: any[]) {
          const { orgId, bypass } = getOrgContext();
          if (orgId && !bypass) {
            stmts = stmts.map((stmt) => rewriteStatement(stmt, orgId));
          }
          return target.batch(stmts);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function wrapClient(client: any): any {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'execute') {
        return async function (stmt: any) {
          const { orgId, bypass } = getOrgContext();
          if (orgId && !bypass) {
            stmt = rewriteStatement(stmt, orgId);
          }
          return target.execute(stmt);
        };
      }
      if (prop === 'batch') {
        return async function (stmts: any[], mode?: any) {
          const { orgId, bypass } = getOrgContext();
          if (orgId && !bypass) {
            stmts = stmts.map((stmt) => rewriteStatement(stmt, orgId));
          }
          return target.batch(stmts, mode);
        };
      }
      if (prop === 'transaction') {
        return async function (mode?: any) {
          const tx = await target.transaction(mode);
          return wrapTransaction(tx);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

export function getDb(): ReturnType<typeof createClient> {
  if (globalForTurso._client) return globalForTurso._client;

  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (!url) throw new Error('Missing TURSO_DATABASE_URL env var');

  const client = createClient({ url, authToken });
  globalForTurso._client = wrapClient(client) as ReturnType<typeof createClient>;
  return globalForTurso._client;
}

/** Apply schema migrations idempotently. Call once at app startup. */
export async function migrate() {
  if (globalForTurso._appliedVersion && globalForTurso._appliedVersion >= SCHEMA_VERSION) return;

  if (
    globalForTurso._migrationPromise &&
    globalForTurso._appliedVersion != null &&
    globalForTurso._appliedVersion < SCHEMA_VERSION
  ) {
    globalForTurso._migrationPromise = undefined;
  }

  if (!globalForTurso._migrationPromise) {
    globalForTurso._migrationPromise = (async () => {
      const db = getDb();

      try {
        const dbUrl = process.env.TURSO_DATABASE_URL ?? '(no TURSO_DATABASE_URL set)';
        console.log(`[migrate] DB URL: ${dbUrl}`);

        await db.execute(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`);
        const versionResult = await db.execute(`SELECT version FROM schema_version LIMIT 1`);
        const currentVersion = versionResult.rows.length > 0 ? Number(versionResult.rows[0].version) : 0;

        if (currentVersion < SCHEMA_VERSION) {
          if (currentVersion === 0) {
            console.log('[migrate] Fresh database detected. Creating schema from schema.sql...');
            const schemaPath = path.join(process.cwd(), 'lib/db/schema.sql');
            const schemaFile = fs.readFileSync(schemaPath, 'utf8');
            const cleanSql = schemaFile
              .replace(/--.*$/gm, '')
              .replace(/\/\*[\s\S]*?\*\//g, '')
              .trim();
            const statements = cleanSql
              .split(';')
              .map(stmt => stmt.trim())
              .filter(stmt => stmt.length > 0);

            for (const stmt of statements) {
              await db.execute(stmt);
            }
            console.log('[migrate] Schema created successfully.');
          } else {
            console.log(`[migrate] Upgrading existing database to v${SCHEMA_VERSION}...`);
            // Ensure organization_credentials table exists when upgrading
            await db.execute(`
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
              )
            `);
            await db.execute(`CREATE INDEX IF NOT EXISTS idx_org_cred_org_id ON organization_credentials (organization_id)`);

            // Attempt to add organization_id to all tables dynamically
            for (const table of coreTables) {
              try {
                await db.execute(`ALTER TABLE ${table} ADD COLUMN organization_id TEXT`);
                await db.execute(`CREATE INDEX IF NOT EXISTS idx_${table}_org_id ON ${table} (organization_id)`);
              } catch (err) {
                // Ignore errors if the column already exists
              }
            }
            console.log('[migrate] Schema upgraded successfully.');
          }
        }

        // record new version
        await db.execute(`DELETE FROM schema_version`);
        await db.execute({ sql: `INSERT INTO schema_version (version) VALUES (?)`, args: [SCHEMA_VERSION] });
        globalForTurso._appliedVersion = SCHEMA_VERSION;
        console.log(`[migrate] schema upgraded to v${SCHEMA_VERSION}`);
      } catch (err) {
        console.error('[migrate] failed:', err);
        globalForTurso._migrationPromise = undefined;
        throw err;
      }
    })();
  }
  return globalForTurso._migrationPromise;
}
