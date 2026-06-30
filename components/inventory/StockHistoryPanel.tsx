'use client';

import { useState, useCallback } from 'react';

interface StockHistoryPoint {
  year_month: string;
  label: string;
  qty_available: number | null;
  source: 'snapshot' | 'allocation_estimate' | 'no_data';
}

interface StockHistoryPanelProps {
  sku: string;
}

export function StockHistoryPanel({ sku }: StockHistoryPanelProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<StockHistoryPoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (data !== null || loading) return; // already loaded or in-flight
    setLoading(true);
    try {
      const res = await fetch(`/api/stock-history?sku=${encodeURIComponent(sku)}`);
      const json = await res.json();
      if (!json.ok) throw new Error(json.error ?? 'Failed to load');
      setData(json.history as StockHistoryPoint[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [sku, data, loading]);

  const toggle = useCallback(() => {
    const next = !open;
    setOpen(next);
    if (next) load();
  }, [open, load]);

  return (
    <div className="mt-1.5">
      <button
        onClick={toggle}
        className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-400 hover:text-blue-300 transition-colors focus:outline-none select-none"
        aria-expanded={open}
        aria-controls={`stock-history-${sku}`}
      >
        <span className={`transition-transform duration-150 ${open ? 'rotate-90' : ''}`}>▶</span>
        Historical Stock
      </button>

      {open && (
        <div
          id={`stock-history-${sku}`}
          className="mt-2 rounded-lg border border-surface-border bg-surface-elevated overflow-hidden"
        >
          {loading && (
            <div className="px-3 py-2 text-xs text-text-muted animate-pulse">Loading…</div>
          )}
          {error && (
            <div className="px-3 py-2 text-xs text-red-400">⚠ {error}</div>
          )}
          {data && !loading && (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-surface-border bg-surface-card">
                  <th className="px-3 py-1.5 text-left font-semibold text-text-muted uppercase tracking-wider text-[10px]">
                    Month
                  </th>
                  <th className="px-3 py-1.5 text-right font-semibold text-text-muted uppercase tracking-wider text-[10px]">
                    In-Stock Qty
                  </th>
                  <th className="px-3 py-1.5 text-right font-semibold text-text-muted uppercase tracking-wider text-[10px]">
                    Source
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {data.map((row) => (
                  <tr key={row.year_month} className="hover:bg-surface-hover transition-colors">
                    <td className="px-3 py-1.5 font-medium text-text-secondary tabular-nums">
                      {row.label}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-text-primary font-semibold">
                      {row.qty_available !== null ? row.qty_available.toLocaleString() : (
                        <span className="text-text-muted font-normal">—</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {row.source === 'snapshot' && (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-semibold bg-emerald-900 text-emerald-300">
                          snapshot
                        </span>
                      )}
                      {row.source === 'allocation_estimate' && (
                        <span
                          className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-semibold bg-indigo-900 text-indigo-300 cursor-help"
                          title="Reconstructed: current stock + all depletions recorded after this month. Accurate if all orders are synced."
                        >
                          reconstructed
                        </span>
                      )}
                      {row.source === 'no_data' && (
                        <span className="text-text-muted text-[9px]">no data</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
