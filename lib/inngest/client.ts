import { Inngest } from 'inngest';

const isDev =
  process.env.INNGEST_DEV === '1' || process.env.NODE_ENV === 'development';

// Create Inngest client for SaaS Dashboard
export const inngest = new Inngest({ id: 'saas-dashboard', isDev });
