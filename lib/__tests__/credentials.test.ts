import { runWithOrg } from '../db/context';
import { getOrganizationCredentials, saveOrganizationCredentials } from '../db/queries';
import { migrate, getDb } from '../db/turso';

describe('Credentials DB Operations and Multi-Tenancy', () => {
  beforeAll(async () => {
    // Run migrations before testing to ensure organization_credentials exists
    await migrate();
  });

  beforeEach(async () => {
    const db = getDb();
    // Clear credentials table to ensure tests are isolated and idempotent
    await db.execute("DELETE FROM organization_credentials");
  });

  it('should save and get credentials with multi-tenant isolation', async () => {
    // Save credentials under org_a
    await runWithOrg('org_a', false, async () => {
      await saveOrganizationCredentials({
        teapplix_api_key: 'apiKeyA',
        amazon_refresh_token: 'refreshTokenA',
        amazon_client_id: 'clientIdA',
        amazon_client_secret: 'clientSecretA',
      });
      
      const creds = await getOrganizationCredentials();
      expect(creds).not.toBeNull();
      expect(creds?.teapplix_api_key).toBe('apiKeyA');
      expect(creds?.amazon_refresh_token).toBe('refreshTokenA');
      expect(creds?.amazon_client_id).toBe('clientIdA');
      expect(creds?.amazon_client_secret).toBe('clientSecretA');
    });

    // Fetch under org_b (should be isolated/empty)
    await runWithOrg('org_b', false, async () => {
      const creds = await getOrganizationCredentials();
      expect(creds).toBeNull();
      
      // Save under org_b
      await saveOrganizationCredentials({
        teapplix_api_key: 'apiKeyB',
        amazon_refresh_token: 'refreshTokenB',
      });

      const credsB = await getOrganizationCredentials();
      expect(credsB).not.toBeNull();
      expect(credsB?.teapplix_api_key).toBe('apiKeyB');
      expect(credsB?.amazon_refresh_token).toBe('refreshTokenB');
      expect(credsB?.amazon_client_id).toBeUndefined(); // unmodified
    });

    // Double check org_a again
    await runWithOrg('org_a', false, async () => {
      const creds = await getOrganizationCredentials();
      expect(creds).not.toBeNull();
      expect(creds?.teapplix_api_key).toBe('apiKeyA');
    });
  });
});
