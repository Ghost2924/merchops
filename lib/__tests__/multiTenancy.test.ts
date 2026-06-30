import { rewriteSql } from '../db/turso';
import { getOrgContext, runWithOrg } from '../db/context';

describe('SaaS Multi-Tenancy SQL Rewriter', () => {
  const orgId = 'org_test123';

  test('SELECT query is rewritten to filter by organization_id', () => {
    const rawSql = 'SELECT sku, title FROM inventory_products WHERE active = 1';
    const expected = "SELECT sku, title FROM (SELECT * FROM inventory_products WHERE organization_id = 'org_test123') WHERE active = 1";
    expect(rewriteSql(rawSql, orgId)).toBe(expected);
  });

  test('SELECT query with JOIN is rewritten for both tables', () => {
    const rawSql = 'SELECT ol.order_line_id FROM order_lines ol JOIN inventory_allocations ia ON ia.order_line_id = ol.order_line_id';
    const expected = "SELECT ol.order_line_id FROM (SELECT * FROM order_lines WHERE organization_id = 'org_test123') ol JOIN (SELECT * FROM inventory_allocations WHERE organization_id = 'org_test123') ia ON ia.order_line_id = ol.order_line_id";
    expect(rewriteSql(rawSql, orgId)).toBe(expected);
  });

  test('INSERT query is rewritten to inject organization_id and conflict target', () => {
    const rawSql = 'INSERT INTO inventory_products (sku, title) VALUES (?, ?)';
    const expected = "INSERT INTO inventory_products (organization_id, sku, title) VALUES ('org_test123', ?, ?)";
    expect(rewriteSql(rawSql, orgId)).toBe(expected);
  });

  test('INSERT query with ON CONFLICT is rewritten correctly', () => {
    const rawSql = 'INSERT INTO sku_mappings (source_sku, marketplace) VALUES (?, ?) ON CONFLICT(source_sku, marketplace) DO UPDATE SET active = 1';
    const expected = "INSERT INTO sku_mappings (organization_id, source_sku, marketplace) VALUES ('org_test123', ?, ?) ON CONFLICT (organization_id, source_sku, marketplace) DO UPDATE SET active = 1";
    expect(rewriteSql(rawSql, orgId)).toBe(expected);
  });

  test('UPDATE query is rewritten to filter by organization_id in WHERE clause', () => {
    const rawSql = 'UPDATE inventory_products SET current_qty = ? WHERE sku = ?';
    const expected = "UPDATE inventory_products SET current_qty = ? WHERE organization_id = 'org_test123' AND (sku = ?)";
    expect(rewriteSql(rawSql, orgId)).toBe(expected);
  });

  test('DELETE query is rewritten to filter by organization_id in WHERE clause', () => {
    const rawSql = 'DELETE FROM order_lines WHERE order_line_id = ?';
    const expected = "DELETE FROM order_lines WHERE organization_id = 'org_test123' AND (order_line_id = ?)";
    expect(rewriteSql(rawSql, orgId)).toBe(expected);
  });

  test('Schema queries are not modified', () => {
    const rawSql = 'CREATE TABLE IF NOT EXISTS schema_version (version INTEGER)';
    expect(rewriteSql(rawSql, orgId)).toBe(rawSql);
  });

  test('Non-core table is not modified', () => {
    const rawSql = 'SELECT * FROM unknown_table WHERE id = 1';
    expect(rewriteSql(rawSql, orgId)).toBe(rawSql);
  });
});

describe('SaaS Multi-Tenancy AsyncLocalStorage Context', () => {
  test('Context holds orgId and bypass flags when executed inside runWithOrg', () => {
    expect(getOrgContext()).toEqual({ orgId: null, bypass: true }); // Default outside context

    runWithOrg('org_abc', false, () => {
      expect(getOrgContext()).toEqual({ orgId: 'org_abc', bypass: false });
    });

    runWithOrg(null, true, () => {
      expect(getOrgContext()).toEqual({ orgId: null, bypass: true });
    });
  });

  test('Nested contexts work correctly', () => {
    runWithOrg('org_outer', false, () => {
      expect(getOrgContext().orgId).toBe('org_outer');

      runWithOrg('org_inner', false, () => {
        expect(getOrgContext().orgId).toBe('org_inner');
      });

      expect(getOrgContext().orgId).toBe('org_outer');
    });
  });
});

describe('Org context database guard', () => {
  const originalUrl = process.env.TURSO_DATABASE_URL;

  beforeEach(() => {
    delete (globalThis as { _client?: unknown })._client;
    delete (globalThis as { _appliedVersion?: unknown })._appliedVersion;
    delete (globalThis as { _migrationPromise?: unknown })._migrationPromise;
    jest.resetModules();
  });

  beforeAll(() => {
    process.env.TURSO_DATABASE_URL = 'file::memory:?cache=shared';
    delete process.env.TURSO_AUTH_TOKEN;
  });

  afterAll(() => {
    if (originalUrl) process.env.TURSO_DATABASE_URL = originalUrl;
    else delete process.env.TURSO_DATABASE_URL;
  });

  test('tenant queries without orgId throw OrgContextRequiredError', async () => {
    const { getDb } = await import('../db/turso');
    const { runWithOrg: withOrg } = await import('../db/context');

    await withOrg(null, false, async () => {
      const db = getDb();
      await expect(
        db.execute('SELECT sku FROM inventory_products LIMIT 1')
      ).rejects.toMatchObject({ name: 'OrgContextRequiredError' });
    });
  });

  test('schema queries without orgId are allowed when bypass is false', async () => {
    const { getDb } = await import('../db/turso');
    const { runWithOrg: withOrg } = await import('../db/context');

    await withOrg(null, false, async () => {
      const db = getDb();
      await expect(
        db.execute('CREATE TABLE IF NOT EXISTS guard_test (id INTEGER PRIMARY KEY)')
      ).resolves.toBeDefined();
    });
  });
});
