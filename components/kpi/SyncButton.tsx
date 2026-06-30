'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw } from 'lucide-react';

type SyncState = 'idle' | 'loading' | 'success' | 'error';

interface SyncStatus {
  phase: string;
  detail: string | null;
  done: boolean;
  error: string | null;
  updated_at: string | null;
}

const PHASE_LABELS: Record<string, string> = {
  'idle':               'Syncing…',
  'orders:syncing':     'Fetching orders…',
  'orders:done':        'Orders done…',
  'vendor:starting':    'Starting vendor sync…',
  'vendor:polling':     'Waiting for Amazon report…',
  'vendor:downloading': 'Downloading report…',
  'vendor:done':        'Vendor sync complete',
  'error':              'Error',
};

export default function SyncButton() {
  const router = useRouter();
  const [state, setState] = useState<SyncState>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [orderCount, setOrderCount] = useState<number | null>(null);
  const [statusLabel, setStatusLabel] = useState('Syncing…');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  // Poll /api/sync-status every 3s while loading to show live phase
  useEffect(() => {
    if (state !== 'loading') {
      stopPolling();
      return;
    }
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch('/api/sync-status');
        if (!res.ok) return;
        const status: SyncStatus = await res.json();
        const label = PHASE_LABELS[status.phase] ?? status.phase;
        setStatusLabel(status.detail ? `${label} (${status.detail})` : label);
      } catch {
        // ignore — keep showing last label
      }
    }, 3000);
    return stopPolling;
  }, [state]);

  async function handleSync() {
    setState('loading');
    setErrorMsg('');
    setOrderCount(null);
    setStatusLabel('Syncing…');

    try {
      const res = await fetch('/api/manual-sync', { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json();
      setOrderCount(data.orderCount ?? null);
      setState('success');
      localStorage.setItem('last_sync_at', String(Date.now()));
      router.refresh();
      setTimeout(() => { setState('idle'); setOrderCount(null); }, 4000);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Sync failed');
      setState('error');
      setTimeout(() => setState('idle'), 5000);
    }
  }

  const label =
    state === 'loading'
      ? statusLabel
      : state === 'success'
      ? `✓ ${orderCount !== null ? `${orderCount} orders` : 'Synced'}`
      : state === 'error'
      ? `✗ ${errorMsg}`
      : 'Sync';

  const colorClass =
    state === 'success'
      ? 'bg-emerald-900 text-emerald-300 border-emerald-700'
      : state === 'error'
      ? 'bg-red-900 text-red-300 border-red-700'
      : 'bg-white dark:bg-surface-elevated text-gray-500 dark:text-text-secondary border-gray-200 dark:border-surface-border hover:text-gray-700 dark:hover:text-text-primary hover:border-gray-300 dark:hover:border-surface-hover';

  return (
    <button
      onClick={handleSync}
      disabled={state === 'loading'}
      title="Fetch today's orders from Teapplix now"
      className={`flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border transition-colors disabled:opacity-60 disabled:cursor-not-allowed min-w-[90px] justify-center ${colorClass}`}
    >
      {state === 'loading' && <RefreshCw size={12} className="animate-spin shrink-0" />}
      <span className="truncate max-w-[180px]">{label}</span>
    </button>
  );
}
