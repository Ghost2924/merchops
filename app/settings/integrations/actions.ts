'use server';

import { auth } from '@clerk/nextjs/server';
import { saveOrganizationCredentials, getOrganizationCredentials } from '@/lib/db/queries';
import { revalidatePath } from 'next/cache';

export async function saveTeapplixCredentialsAction(formData: FormData) {
  const { orgId } = auth();
  if (!orgId) {
    return { success: false, error: 'Unauthorized. Active organization required.' };
  }

  const apiKey = formData.get('teapplix_api_key') as string;
  if (!apiKey) {
    return { success: false, error: 'Teapplix API key cannot be empty.' };
  }

  try {
    await saveOrganizationCredentials({
      teapplix_api_key: apiKey.trim(),
    });
    revalidatePath('/settings/integrations');
    return { success: true };
  } catch (error: any) {
    console.error('[saveTeapplixCredentialsAction] error:', error);
    return { success: false, error: error.message || 'Failed to save Teapplix credentials' };
  }
}

export async function saveAmazonCredentialsAction(formData: FormData) {
  const { orgId } = auth();
  if (!orgId) {
    return { success: false, error: 'Unauthorized. Active organization required.' };
  }

  const clientId = formData.get('amazon_client_id') as string;
  const clientSecret = formData.get('amazon_client_secret') as string;
  const refreshToken = formData.get('amazon_refresh_token') as string;

  if (!clientId || !clientSecret || !refreshToken) {
    return { success: false, error: 'All Amazon credentials fields are required.' };
  }

  try {
    await saveOrganizationCredentials({
      amazon_client_id: clientId.trim(),
      amazon_client_secret: clientSecret.trim(),
      amazon_refresh_token: refreshToken.trim(),
    });
    revalidatePath('/settings/integrations');
    return { success: true };
  } catch (error: any) {
    console.error('[saveAmazonCredentialsAction] error:', error);
    return { success: false, error: error.message || 'Failed to save Amazon credentials' };
  }
}

export async function generateAmazonOAuthUrlAction() {
  const { orgId } = auth();
  if (!orgId) {
    return { success: false, error: 'Unauthorized' };
  }

  try {
    const creds = await getOrganizationCredentials();
    const clientId = creds?.amazon_client_id;
    
    if (!clientId) {
      return { 
        success: false, 
        error: 'Please save your Amazon Client ID first to generate the OAuth authorize URL.' 
      };
    }

    // Amazon SP-API Authorization URL (North America production URL)
    // https://sellercentral.amazon.com/apps/authorize/consent?app_id={APP_ID_ASSOCIATED_WITH_CLIENT_ID}&state={ORG_ID}&version=beta
    // Note: The App ID matches client ID but has amzn1.sellerapps.app prefix.
    // If the client ID is amzn1.application-oa2-client.xxx, the Developer App ID format in Amazon is amzn1.sellerapps.app.xxx.
    // We can infer the App ID if the Client ID has the oa2-client format.
    let appId = clientId;
    if (clientId.includes('amzn1.application-oa2-client.')) {
      appId = clientId.replace('amzn1.application-oa2-client.', 'amzn1.sellerapps.app.');
    }
    
    // Redirect URI must match the one registered in Amazon App Console. We point to the local or production host callback.
    const oauthUrl = `https://sellercentral.amazon.com/apps/authorize/consent?app_id=${encodeURIComponent(appId)}&state=${encodeURIComponent(orgId)}&version=beta`;

    return { success: true, url: oauthUrl };
  } catch (error: any) {
    return { success: false, error: error.message || 'Failed to generate OAuth URL' };
  }
}
