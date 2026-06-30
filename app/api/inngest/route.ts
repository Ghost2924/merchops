import { serve } from 'inngest/next';
import { inngest } from '@/lib/inngest/client';
import { syncTeapplix, syncAmazon, nightlySyncScheduler } from '@/lib/inngest/functions';

// Expose the Inngest serverless background queue handler endpoint at /api/inngest
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    syncTeapplix,
    syncAmazon,
    nightlySyncScheduler,
  ],
});
