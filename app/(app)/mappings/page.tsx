'use client';

export const dynamic = 'force-dynamic';

import { useEffect, useState } from 'react';
import { Save, Plus, AlertCircle } from 'lucide-react';

interface Mapping {
  id?: number;
  // API returns source_sku (from SkuMappingRow); we alias it as storefront_sku in the UI
  source_sku: string;
  teapplix_sku: string;
  updated_at?: string;
}

interface UnmappedSku {
  raw_storefront_sku: string;
  order_count: number;
  qty_sold: number;
  revenue: number;
  last_seen_at: string;
}

interface MappingError {
  id: number;
  source_sku?: string;
  teapplix_sku?: string;
  message: string;
  severity: string;
  created_at: string;
}

type Tab = 'all' | 'unmapped' | 'errors';

const thCls = 'px-4 py-3 text-xs font-semibold text-gray-500 dark:text-text-muted uppercase tracking-wider text-left';
const tdCls = 'px-4 py-3 border-b border-gray-50 dark:border-surface-border text-sm';

function formatUSD(v: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(v);
}

export default function MappingsPage() {
  const [activeTab, setActiveTab] = useState<Tab>('all');
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [unmapped, setUnmapped] = useState<UnmappedSku[]>([]);
  const [errors, setErrors] = useState<MappingError[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [showAddRow, setShowAddRow] = useState(false);
  const [newStorefront, setNewStorefront] = useState('');
  const [newTeapplix, setNewTeapplix] = useState('');
  const [quickMapValues, setQuickMapValues] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true); setFetchError(null);
    fetch('/api/mappings')
      .then((r) => r.json())
      .then((d) => {
        if (!d.ok) throw new Error(d.error ?? 'Unknown error');
        setMappings(d.mappings ?? []);
        setUnmapped(d.unmapped ?? []);
        setErrors(d.errors ?? []);
      })
      .catch((e) => setFetchError(e.message))
      .finally(() => setLoading(false));
  }, []);

  async function saveMapping(storefront: string, teapplix: string) {
    setSaving(true);
    setSaveError(null);
    try {
      const r = await fetch('/api/mappings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storefront_sku: storefront, teapplix_sku: teapplix }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error ?? 'Save failed');
      setMappings((prev) => {
        const idx = prev.findIndex((m) => m.source_sku === storefront);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = { ...next[idx], teapplix_sku: teapplix };
          return next;
        }
        return [...prev, { source_sku: storefront, teapplix_sku: teapplix }];
      });
      setUnmapped((prev) => prev.filter((u) => u.raw_storefront_sku !== storefront));
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false); setEditingId(null); setShowAddRow(false); setNewStorefront(''); setNewTeapplix('');
    }
  }

  const filteredMappings = mappings.filter(
    (m) => m.source_sku.toLowerCase().includes(search.toLowerCase()) || m.teapplix_sku.toLowerCase().includes(search.toLowerCase())
  );

  const pillBase = 'px-3 py-1.5 rounded-full text-xs font-medium transition-colors';
  const pillActive = 'bg-accent-primary text-white';
  const pillInactive = 'text-gray-500 dark:text-text-secondary hover:bg-gray-100 dark:hover:bg-surface-hover';

  return (
    <main className="min-h-screen bg-gray-50 dark:bg-surface">
      <div className="bg-white dark:bg-surface-card border-b border-gray-200 dark:border-surface-border px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-xl font-semibold text-gray-900 dark:text-text-primary">Mappings</h1>
            <p className="text-xs text-gray-400 dark:text-text-muted mt-0.5">Storefront SKU → Teapplix SKU mappings</p>
          </div>
          {unmapped.length > 0 && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-amber-950 text-amber-300 ring-1 ring-amber-700">
              <AlertCircle size={12} /> {unmapped.length} unmapped SKUs
            </span>
          )}
        </div>
      </div>

      {/* Tab bar */}
      <div className="bg-white dark:bg-surface-card border-b border-gray-200 dark:border-surface-border px-6 py-2">
        <div className="max-w-7xl mx-auto flex gap-1">
          <button onClick={() => setActiveTab('all')} className={`${pillBase} ${activeTab === 'all' ? pillActive : pillInactive}`}>All Mappings</button>
          <button onClick={() => setActiveTab('unmapped')} className={`${pillBase} ${activeTab === 'unmapped' ? pillActive : pillInactive}`}>
            Unmapped Queue {unmapped.length > 0 && <span className="ml-1 bg-accent-amber text-white text-[10px] px-1.5 py-0.5 rounded-full">{unmapped.length}</span>}
          </button>
          <button onClick={() => setActiveTab('errors')} className={`${pillBase} ${activeTab === 'errors' ? pillActive : pillInactive}`}>
            Mapping Errors {errors.length > 0 && <span className="ml-1 bg-accent-red text-white text-[10px] px-1.5 py-0.5 rounded-full">{errors.length}</span>}
          </button>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-6">
        {loading && <div className="space-y-3">{[...Array(5)].map((_, i) => <div key={i} className="h-12 bg-gray-100 dark:bg-surface-elevated rounded-xl animate-pulse" />)}</div>}
        {fetchError && <div className="bg-red-950 border border-red-800 rounded-xl p-4 text-red-300 text-sm">✗ {fetchError}</div>}
        {saveError && <div className="bg-red-950 border border-red-800 rounded-xl p-4 text-red-300 text-sm mb-4">✗ {saveError}</div>}

        {!loading && !fetchError && (
          <>
            {/* All Mappings */}
            {activeTab === 'all' && (
              <div className="bg-white dark:bg-surface-card rounded-2xl border border-gray-100 dark:border-surface-border overflow-hidden">
                <div className="px-4 py-3 border-b border-gray-100 dark:border-surface-border flex items-center gap-3 flex-wrap">
                  <input
                    type="text" placeholder="Search mappings…" value={search} onChange={(e) => setSearch(e.target.value)}
                    className="flex-1 min-w-0 max-w-xs text-sm border border-gray-200 dark:border-surface-border rounded-xl px-3 py-2 bg-white dark:bg-surface-elevated text-gray-900 dark:text-text-primary focus:outline-none focus:ring-2 focus:ring-accent-primary"
                  />
                  <button onClick={() => setShowAddRow(true)} className="flex items-center gap-1.5 px-3 py-2 bg-accent-primary text-white rounded-xl text-xs font-medium hover:bg-indigo-700 transition-colors">
                    <Plus size={12} /> Add Mapping
                  </button>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead><tr className="bg-gray-50 dark:bg-surface-elevated"><th className={thCls}>Storefront SKU</th><th className={thCls}>Teapplix SKU</th><th className={thCls}>Last Updated</th><th className={thCls}>Action</th></tr></thead>
                    <tbody>
                      {showAddRow && (
                        <tr className="bg-accent-primary/5">
                          <td className={tdCls}><input type="text" placeholder="Storefront SKU" value={newStorefront} onChange={(e) => setNewStorefront(e.target.value.toUpperCase())} className="w-full text-xs border border-gray-200 dark:border-surface-border rounded-lg px-2 py-1.5 bg-white dark:bg-surface-elevated text-gray-900 dark:text-text-primary focus:outline-none focus:ring-2 focus:ring-accent-primary font-mono" /></td>
                          <td className={tdCls}><input type="text" placeholder="Teapplix SKU" value={newTeapplix} onChange={(e) => setNewTeapplix(e.target.value.toUpperCase())} className="w-full text-xs border border-gray-200 dark:border-surface-border rounded-lg px-2 py-1.5 bg-white dark:bg-surface-elevated text-gray-900 dark:text-text-primary focus:outline-none focus:ring-2 focus:ring-accent-primary font-mono" /></td>
                          <td className={tdCls} />
                          <td className={tdCls}>
                            <div className="flex gap-2">
                              <button onClick={() => saveMapping(newStorefront, newTeapplix)} disabled={saving || !newStorefront || !newTeapplix} className="flex items-center gap-1 px-2 py-1 bg-accent-primary text-white rounded-lg text-xs disabled:opacity-50"><Save size={10} /> Save</button>
                              <button onClick={() => setShowAddRow(false)} className="px-2 py-1 text-xs text-gray-500 dark:text-text-muted hover:text-gray-700 dark:hover:text-text-primary">Cancel</button>
                            </div>
                          </td>
                        </tr>
                      )}
                      {filteredMappings.length === 0 ? (
                        <tr><td colSpan={4} className="px-4 py-12 text-center text-gray-400 dark:text-text-muted">No mappings found</td></tr>
                      ) : filteredMappings.map((m) => {
                        const isEditing = editingId === m.source_sku;
                        return (
                          <tr key={m.source_sku} className="hover:bg-gray-50 dark:hover:bg-surface-hover transition-colors">
                            <td className={`${tdCls} font-mono font-semibold text-gray-900 dark:text-text-primary`}>{m.source_sku}</td>
                            <td className={tdCls}>
                              {isEditing ? (
                                <input type="text" value={editValue} onChange={(e) => setEditValue(e.target.value.toUpperCase())} className="w-full text-xs border border-accent-primary rounded-lg px-2 py-1.5 bg-white dark:bg-surface-elevated text-gray-900 dark:text-text-primary focus:outline-none focus:ring-2 focus:ring-accent-primary font-mono" autoFocus />
                              ) : (
                                <span className="font-mono text-gray-700 dark:text-text-secondary">{m.teapplix_sku}</span>
                              )}
                            </td>
                            <td className={`${tdCls} text-xs text-gray-400 dark:text-text-muted`}>{m.updated_at ?? '—'}</td>
                            <td className={tdCls}>
                              {isEditing ? (
                                <div className="flex gap-2">
                                  <button onClick={() => saveMapping(m.source_sku, editValue)} disabled={saving} className="flex items-center gap-1 px-2 py-1 bg-accent-primary text-white rounded-lg text-xs disabled:opacity-50"><Save size={10} /> Save</button>
                                  <button onClick={() => setEditingId(null)} className="px-2 py-1 text-xs text-gray-500 dark:text-text-muted">Cancel</button>
                                </div>
                              ) : (
                                <button onClick={() => { setEditingId(m.source_sku); setEditValue(m.teapplix_sku); }} className="text-xs text-accent-primary hover:underline">Edit</button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Unmapped Queue */}
            {activeTab === 'unmapped' && (
              <div className="bg-white dark:bg-surface-card rounded-2xl border border-gray-100 dark:border-surface-border overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead><tr className="bg-gray-50 dark:bg-surface-elevated"><th className={thCls}>Storefront SKU</th><th className={`${thCls} text-right`}>Orders</th><th className={`${thCls} text-right`}>Total Qty</th><th className={`${thCls} text-right`}>Revenue</th><th className={thCls}>Last Seen</th><th className={thCls}>Map To</th></tr></thead>
                    <tbody>
                      {unmapped.length === 0 ? (
                        <tr><td colSpan={6} className="px-4 py-12 text-center text-gray-400 dark:text-text-muted">✓ No unmapped SKUs</td></tr>
                      ) : [...unmapped].sort((a, b) => b.revenue - a.revenue).map((u) => (
                        <tr key={u.raw_storefront_sku} className="hover:bg-gray-50 dark:hover:bg-surface-hover transition-colors">
                          <td className={`${tdCls} font-mono font-semibold text-accent-amber`}>{u.raw_storefront_sku}</td>
                          <td className={`${tdCls} text-right tabular-nums text-gray-700 dark:text-text-secondary`}>{u.order_count.toLocaleString()}</td>
                          <td className={`${tdCls} text-right tabular-nums text-gray-700 dark:text-text-secondary`}>{u.qty_sold.toLocaleString()}</td>
                          <td className={`${tdCls} text-right tabular-nums text-accent-emerald font-semibold`}>{formatUSD(u.revenue)}</td>
                          <td className={`${tdCls} text-xs text-gray-400 dark:text-text-muted`}>{u.last_seen_at}</td>
                          <td className={tdCls}>
                            <div className="flex gap-2 items-center">
                              <input
                                type="text" placeholder="Teapplix SKU"
                                value={quickMapValues[u.raw_storefront_sku] ?? ''}
                                onChange={(e) => setQuickMapValues((prev) => ({ ...prev, [u.raw_storefront_sku]: e.target.value.toUpperCase() }))}
                                className="w-28 text-xs border border-gray-200 dark:border-surface-border rounded-lg px-2 py-1.5 bg-white dark:bg-surface-elevated text-gray-900 dark:text-text-primary focus:outline-none focus:ring-2 focus:ring-accent-primary font-mono"
                              />
                              <button
                                onClick={() => saveMapping(u.raw_storefront_sku, quickMapValues[u.raw_storefront_sku] ?? '')}
                                disabled={saving || !quickMapValues[u.raw_storefront_sku]}
                                className="flex items-center gap-1 px-2 py-1 bg-accent-primary text-white rounded-lg text-xs disabled:opacity-50 hover:bg-indigo-700 transition-colors"
                              >
                                <Save size={10} /> Save
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Mapping Errors */}
            {activeTab === 'errors' && (
              <div className="bg-white dark:bg-surface-card rounded-2xl border border-gray-100 dark:border-surface-border overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead><tr className="bg-gray-50 dark:bg-surface-elevated"><th className={thCls}>Source SKU</th><th className={thCls}>Attempted Target</th><th className={thCls}>Error</th><th className={thCls}>Logged At</th></tr></thead>
                    <tbody>
                      {errors.length === 0 ? (
                        <tr><td colSpan={4} className="px-4 py-12 text-center text-gray-400 dark:text-text-muted">✓ No mapping errors</td></tr>
                      ) : errors.map((e) => (
                        <tr key={e.id} className="bg-red-50/30 dark:bg-red-950/20 hover:bg-red-50/50 dark:hover:bg-red-950/30 transition-colors">
                          <td className={`${tdCls} font-mono font-semibold text-accent-red`}>{e.source_sku ?? '—'}</td>
                          <td className={`${tdCls} font-mono text-gray-700 dark:text-text-secondary`}>{e.teapplix_sku ?? '—'}</td>
                          <td className={`${tdCls} text-red-600 dark:text-red-400 text-xs`}>{e.message}</td>
                          <td className={`${tdCls} text-xs text-gray-400 dark:text-text-muted`}>{e.created_at}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}
