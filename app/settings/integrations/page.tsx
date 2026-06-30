import { Metadata } from 'next';
import { getOrganizationCredentials } from '@/lib/db/queries';
import IntegrationsForm from './IntegrationsForm';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Integration Settings | BTEXPERT Operations Dashboard',
  description: 'Manage and configure secure credentials and API connections for Teapplix and Amazon SP-API.',
};

export default async function IntegrationsSettingsPage() {
  let hasTeapplixKey = false;
  let hasAmazonClientId = false;
  let hasAmazonClientSecret = false;
  let hasAmazonRefreshToken = false;

  try {
    const creds = await getOrganizationCredentials();
    if (creds) {
      hasTeapplixKey = !!creds.teapplix_api_key;
      hasAmazonClientId = !!creds.amazon_client_id;
      hasAmazonClientSecret = !!creds.amazon_client_secret;
      hasAmazonRefreshToken = !!creds.amazon_refresh_token;
    }
  } catch (error) {
    console.error('[IntegrationsSettingsPage] failed to fetch credentials:', error);
  }

  return (
    <main className="min-h-screen bg-gray-50 dark:bg-surface pb-12" id="settings-integrations-page">
      {/* Premium Header */}
      <header className="bg-white dark:bg-surface-card border-b border-gray-200 dark:border-surface-border px-6 py-8">
        <div className="max-w-7xl mx-auto">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-text-primary tracking-tight">
            Integration Settings
          </h1>
          <p className="text-sm text-gray-500 dark:text-text-secondary mt-1 max-w-2xl">
            Configure secure API credentials and OAuth settings. All credentials are encrypted using industry-standard AES-256-GCM before being saved in your isolated tenant database.
          </p>
        </div>
      </header>

      {/* Forms Section */}
      <section aria-label="Credentials Forms" className="max-w-7xl mx-auto mt-4">
        <IntegrationsForm
          hasTeapplixKey={hasTeapplixKey}
          hasAmazonClientId={hasAmazonClientId}
          hasAmazonClientSecret={hasAmazonClientSecret}
          hasAmazonRefreshToken={hasAmazonRefreshToken}
        />
      </section>
    </main>
  );
}
