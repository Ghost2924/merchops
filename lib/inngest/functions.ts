import { inngest } from './client';
import { runSync } from '../sync/runSync';
import { runVendorSync } from '../sync/runVendorSync';
import { getDb } from '../db/turso';

/**
 * Inngest function to run Teapplix order and inventory sync for a specific tenant.
 */
export const syncTeapplix = inngest.createFunction(
  { id: 'sync-teapplix', name: 'Sync Teapplix Orders & Inventory' },
  { event: 'sync/teapplix.run' },
  async ({ event, step }) => {
    const { organization_id, mode = 'backfill', lookbackDays, targetDate } = event.data;

    if (!organization_id) {
      throw new Error('Missing organization_id in event payload');
    }

    const result = await step.run('run-sync', async () => {
      return await runSync({
        mode,
        lookbackDays,
        targetDate,
        organizationId: organization_id,
      });
    });

    return result;
  }
);

/**
 * Inngest function to run Amazon Vendor Central ARA reports sync for a specific tenant.
 */
export const syncAmazon = inngest.createFunction(
  { id: 'sync-amazon', name: 'Sync Amazon Vendor ARA' },
  { event: 'sync/amazon.run' },
  async ({ event, step }) => {
    const { organization_id } = event.data;

    if (!organization_id) {
      throw new Error('Missing organization_id in event payload');
    }

    const result = await step.run('run-vendor-sync', async () => {
      return await runVendorSync({
        organizationId: organization_id,
      });
    });

    return result;
  }
);

/**
 * Inngest cron job function that automatically fires the sync pipeline events
 * for every active organization in the database every night (at 2:00 AM daily).
 */
export const nightlySyncScheduler = inngest.createFunction(
  { id: 'nightly-sync-scheduler', name: 'Nightly Sync Scheduler' },
  { cron: '0 2 * * *' },
  async ({ step }) => {
    // Retrieve all active organization IDs from the database
    const orgIds = await step.run('get-all-organizations', async () => {
      const db = getDb();
      // This runs outside context rewriting (bypass: true implicitly since no context is set)
      const result = await db.execute(`
        SELECT DISTINCT organization_id FROM organization_credentials
      `);
      return result.rows.map((r) => r.organization_id as string).filter(Boolean);
    });

    if (orgIds.length > 0) {
      const events = orgIds.flatMap((orgId) => [
        {
          name: 'sync/teapplix.run',
          data: {
            organization_id: orgId,
            mode: 'backfill' as const,
            lookbackDays: 7,
          },
        },
        {
          name: 'sync/amazon.run',
          data: {
            organization_id: orgId,
          },
        },
      ]);

      await step.sendEvent('dispatch-sync-events', events);
    }

    return { scheduledOrganizations: orgIds };
  }
);
