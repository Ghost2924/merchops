'use client';

import { useState } from 'react';
import { Key, CheckCircle2, AlertCircle, ExternalLink, RefreshCw } from 'lucide-react';
import { 
  saveTeapplixCredentialsAction, 
  saveAmazonCredentialsAction, 
  generateAmazonOAuthUrlAction 
} from './actions';

interface IntegrationsFormProps {
  hasTeapplixKey: boolean;
  hasAmazonClientId: boolean;
  hasAmazonClientSecret: boolean;
  hasAmazonRefreshToken: boolean;
}

export default function IntegrationsForm({
  hasTeapplixKey,
  hasAmazonClientId,
  hasAmazonClientSecret,
  hasAmazonRefreshToken,
}: IntegrationsFormProps) {
  // Teapplix form state
  const [teapplixSaving, setTeapplixSaving] = useState(false);
  const [teapplixError, setTeapplixError] = useState<string | null>(null);
  const [teapplixSuccess, setTeapplixSuccess] = useState(false);

  // Amazon form state
  const [amazonSaving, setAmazonSaving] = useState(false);
  const [amazonError, setAmazonError] = useState<string | null>(null);
  const [amazonSuccess, setAmazonSuccess] = useState(false);

  // OAuth state
  const [oauthLoading, setOauthLoading] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);

  async function handleTeapplixSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setTeapplixSaving(true);
    setTeapplixError(null);
    setTeapplixSuccess(false);

    const formData = new FormData(e.currentTarget);
    const res = await saveTeapplixCredentialsAction(formData);

    if (res.success) {
      setTeapplixSuccess(true);
      // Clear password field
      const input = e.currentTarget.querySelector('input[name="teapplix_api_key"]') as HTMLInputElement;
      if (input) input.value = '';
    } else {
      setTeapplixError(res.error || 'Failed to save');
    }
    setTeapplixSaving(false);
  }

  async function handleAmazonSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setAmazonSaving(true);
    setAmazonError(null);
    setAmazonSuccess(false);

    const formData = new FormData(e.currentTarget);
    const res = await saveAmazonCredentialsAction(formData);

    if (res.success) {
      setAmazonSuccess(true);
      // Clear password fields
      const clientSecretInput = e.currentTarget.querySelector('input[name="amazon_client_secret"]') as HTMLInputElement;
      if (clientSecretInput) clientSecretInput.value = '';
      const refreshTokenInput = e.currentTarget.querySelector('input[name="amazon_refresh_token"]') as HTMLInputElement;
      if (refreshTokenInput) refreshTokenInput.value = '';
    } else {
      setAmazonError(res.error || 'Failed to save');
    }
    setAmazonSaving(false);
  }

  async function handleInitiateOAuth() {
    setOauthLoading(true);
    setOauthError(null);

    const res = await generateAmazonOAuthUrlAction();
    if (res.success && res.url) {
      window.open(res.url, '_blank', 'noopener,noreferrer');
    } else {
      setOauthError(res.error || 'Could not generate OAuth URL');
    }
    setOauthLoading(false);
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 max-w-7xl mx-auto px-4 md:px-6 py-8">
      {/* Teapplix API Settings Card */}
      <div className="bg-white dark:bg-surface-card border border-gray-200 dark:border-surface-border rounded-2xl p-6 shadow-sm flex flex-col justify-between">
        <div>
          <div className="flex items-center gap-3 mb-4">
            <div className="p-3 bg-indigo-50 dark:bg-indigo-950/50 rounded-xl text-accent-primary">
              <Key size={24} />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-text-primary">Teapplix Integration</h2>
              <p className="text-xs text-gray-400 dark:text-text-secondary">Sync order lines and inventory catalog</p>
            </div>
          </div>
          
          <div className="h-px bg-gray-100 dark:bg-surface-border my-4" />

          {hasTeapplixKey ? (
            <div className="mb-6 flex items-center gap-2 px-4 py-3 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 dark:text-accent-emerald text-sm rounded-xl border border-emerald-100 dark:border-emerald-950/50 font-medium">
              <CheckCircle2 size={16} className="shrink-0" />
              <span>Teapplix API credentials are fully configured.</span>
            </div>
          ) : (
            <div className="mb-6 flex items-center gap-2 px-4 py-3 bg-amber-50 dark:bg-amber-950/30 text-amber-600 dark:text-accent-amber text-sm rounded-xl border border-amber-100 dark:border-amber-950/50 font-medium">
              <AlertCircle size={16} className="shrink-0" />
              <span>API credentials not found. Complete setup below.</span>
            </div>
          )}

          <form onSubmit={handleTeapplixSubmit} className="space-y-4">
            <div>
              <label htmlFor="teapplix_api_key" className="block text-xs font-semibold text-gray-500 dark:text-text-secondary mb-1.5 uppercase tracking-wider">
                Teapplix API Key
              </label>
              <input
                type="password"
                id="teapplix_api_key"
                name="teapplix_api_key"
                placeholder={hasTeapplixKey ? "••••••••••••••••" : "Enter Teapplix API Key"}
                className="w-full border border-gray-200 dark:border-surface-border bg-white dark:bg-surface bg-opacity-50 text-gray-900 dark:text-text-primary px-4 py-2.5 rounded-xl text-sm focus:ring-2 focus:ring-accent-primary focus:border-transparent outline-none transition-all"
                required
              />
            </div>

            {teapplixError && (
              <div className="p-3 bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-accent-red text-xs rounded-xl flex items-center gap-2">
                <AlertCircle size={14} />
                <span>{teapplixError}</span>
              </div>
            )}

            {teapplixSuccess && (
              <div className="p-3 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 dark:text-accent-emerald text-xs rounded-xl flex items-center gap-2">
                <CheckCircle2 size={14} />
                <span>Credentials saved successfully.</span>
              </div>
            )}

            <button
              type="submit"
              disabled={teapplixSaving}
              className="w-full bg-accent-primary hover:bg-indigo-600 text-white font-medium text-sm py-2.5 px-4 rounded-xl transition-all shadow-md shadow-indigo-500/10 flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {teapplixSaving ? <RefreshCw size={16} className="animate-spin" /> : null}
              <span>Save Teapplix Credentials</span>
            </button>
          </form>
        </div>
      </div>

      {/* Amazon SP-API Settings Card */}
      <div className="bg-white dark:bg-surface-card border border-gray-200 dark:border-surface-border rounded-2xl p-6 shadow-sm flex flex-col justify-between">
        <div>
          <div className="flex items-center gap-3 mb-4">
            <div className="p-3 bg-indigo-50 dark:bg-indigo-950/50 rounded-xl text-accent-primary">
              <Share2Icon size={24} />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-text-primary">Amazon SP-API</h2>
              <p className="text-xs text-gray-400 dark:text-text-secondary">Sync Amazon catalogs, coupons and spend metrics</p>
            </div>
          </div>

          <div className="h-px bg-gray-100 dark:bg-surface-border my-4" />

          {hasAmazonClientId && hasAmazonClientSecret && hasAmazonRefreshToken ? (
            <div className="mb-6 flex items-center gap-2 px-4 py-3 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 dark:text-accent-emerald text-sm rounded-xl border border-emerald-100 dark:border-emerald-950/50 font-medium font-sans">
              <CheckCircle2 size={16} className="shrink-0" />
              <span>Amazon SP-API credentials are configured.</span>
            </div>
          ) : (
            <div className="mb-6 flex items-center gap-2 px-4 py-3 bg-amber-50 dark:bg-amber-950/30 text-amber-600 dark:text-accent-amber text-sm rounded-xl border border-amber-100 dark:border-amber-950/50 font-medium">
              <AlertCircle size={16} className="shrink-0" />
              <span>Amazon SP-API credentials not fully configured.</span>
            </div>
          )}

          <form onSubmit={handleAmazonSubmit} className="space-y-4">
            <div>
              <label htmlFor="amazon_client_id" className="block text-xs font-semibold text-gray-500 dark:text-text-secondary mb-1.5 uppercase tracking-wider">
                Amazon Client ID (LWA Client ID)
              </label>
              <input
                type="text"
                id="amazon_client_id"
                name="amazon_client_id"
                defaultValue={hasAmazonClientId ? "amzn1.application-oa2-client.••••••••••••••••" : ""}
                placeholder="amzn1.application-oa2-client.xxxx"
                className="w-full border border-gray-200 dark:border-surface-border bg-white dark:bg-surface bg-opacity-50 text-gray-900 dark:text-text-primary px-4 py-2.5 rounded-xl text-sm focus:ring-2 focus:ring-accent-primary focus:border-transparent outline-none transition-all"
                required
              />
            </div>

            <div>
              <label htmlFor="amazon_client_secret" className="block text-xs font-semibold text-gray-500 dark:text-text-secondary mb-1.5 uppercase tracking-wider">
                Amazon Client Secret (LWA Client Secret)
              </label>
              <input
                type="password"
                id="amazon_client_secret"
                name="amazon_client_secret"
                placeholder={hasAmazonClientSecret ? "••••••••••••••••••••••••••••••••" : "Enter Amazon Client Secret"}
                className="w-full border border-gray-200 dark:border-surface-border bg-white dark:bg-surface bg-opacity-50 text-gray-900 dark:text-text-primary px-4 py-2.5 rounded-xl text-sm focus:ring-2 focus:ring-accent-primary focus:border-transparent outline-none transition-all"
                required
              />
            </div>

            <div>
              <label htmlFor="amazon_refresh_token" className="block text-xs font-semibold text-gray-500 dark:text-text-secondary mb-1.5 uppercase tracking-wider">
                Amazon Refresh Token
              </label>
              <input
                type="password"
                id="amazon_refresh_token"
                name="amazon_refresh_token"
                placeholder={hasAmazonRefreshToken ? "Atzr|••••••••••••••••••••••••••••" : "Enter Amazon Refresh Token"}
                className="w-full border border-gray-200 dark:border-surface-border bg-white dark:bg-surface bg-opacity-50 text-gray-900 dark:text-text-primary px-4 py-2.5 rounded-xl text-sm focus:ring-2 focus:ring-accent-primary focus:border-transparent outline-none transition-all"
                required
              />
            </div>

            {amazonError && (
              <div className="p-3 bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-accent-red text-xs rounded-xl flex items-center gap-2">
                <AlertCircle size={14} />
                <span>{amazonError}</span>
              </div>
            )}

            {amazonSuccess && (
              <div className="p-3 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 dark:text-accent-emerald text-xs rounded-xl flex items-center gap-2">
                <CheckCircle2 size={14} />
                <span>Credentials saved successfully.</span>
              </div>
            )}

            <div className="flex flex-col gap-3 pt-2">
              <button
                type="submit"
                disabled={amazonSaving}
                className="w-full bg-accent-primary hover:bg-indigo-600 text-white font-medium text-sm py-2.5 px-4 rounded-xl transition-all shadow-md shadow-indigo-500/10 flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {amazonSaving ? <RefreshCw size={16} className="animate-spin" /> : null}
                <span>Save Amazon Credentials</span>
              </button>

              <button
                type="button"
                onClick={handleInitiateOAuth}
                disabled={oauthLoading}
                className="w-full border border-gray-200 dark:border-surface-border bg-gray-50 dark:bg-surface hover:bg-gray-100 dark:hover:bg-surface-hover text-gray-700 dark:text-text-primary font-medium text-sm py-2.5 px-4 rounded-xl transition-all flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {oauthLoading ? <RefreshCw size={16} className="animate-spin" /> : <ExternalLink size={16} />}
                <span>Initiate SP-API OAuth Flow</span>
              </button>
              
              {oauthError && (
                <p className="text-center text-xs text-accent-red">{oauthError}</p>
              )}
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

// Simple custom component for Share2 icon in case Lucide lacks it or standard icon is wanted
function Share2Icon({ size = 20 }: { size?: number }) {
  return (
    <svg 
      xmlns="http://www.w3.org/2000/svg" 
      width={size} 
      height={size} 
      viewBox="0 0 24 24" 
      fill="none" 
      stroke="currentColor" 
      strokeWidth="2" 
      strokeLinecap="round" 
      strokeLinejoin="round"
    >
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
    </svg>
  );
}
