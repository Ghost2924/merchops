'use client';

export const dynamic = 'force-dynamic';

import { useEffect, useState } from 'react';
import { Package, Layers, Puzzle, AlertTriangle, CheckCircle, XCircle, RefreshCw } from 'lucide-react';
import { normalizeSku, parsePack } from '@/lib/sku/resolver';

/** Family key: parsePack(normalizeSku(sku)).base */
function familyKey(sku: string): string {
  return parsePack(normalizeSku(sku)).base;
}

interface CatalogSummary {
  totalInventorySkus: number;
  totalComboSkus: number;
  needsReviewCount: number;
  mappingErrorsCount: number;
}

interface InventorySku {
  sku: string;
  description?: string;
  qty: number;
  itemType?: string;
  updatedAt?: string;
  storefrontSkus?: string[];
}

interface ComboSku {
  sku: string;
  description?: string;
  components: { sku: string; qty: number }[];
}

interface ValidationResult {
  orphanCombos: number;
  badMappingTargets: number;
  invalidQuantities: number;
  allocationsOnCombos: number;
}

type Tab = 'summary' | 'inventory' | 'combos' | 'components' | 'review' | 'validate';

const tabDef: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'summary', label: 'Summary', icon: <Package size={14} /> },
  { id: 'inventory', label: 'Inventory SKUs', icon: <Layers size={14} /> },
  { id: 'combos', label: 'Combo Products', icon: <Puzzle size={14} /> },
  { id: 'components', label: 'Components', icon: <Puzzle size={14} /> },
  { id: 'review', label: 'Needs Review', icon: <AlertTriangle size={14} /> },
  { id: 'validate', label: 'Validate', icon: <CheckCircle size={14} /> },
];

function qtyColor(qty: number) {
  if (qty === 0) return 'text-accent-red';
  if (qty < 10) return 'text-accent-amber';
  return 'text-accent-emerald';
}

interface InventoryFamily {
  family: string;         // family key (e.g. "AM5233")
  children: InventorySku[]; // physical SKUs under this family
  familyQty: number;      // sum of all children qty
  isSingleton: boolean;   // true when only one child = no expand
}

function buildFamilies(skus: InventorySku[]): InventoryFamily[] {
  const familyMap = new Map<string, InventorySku[]>();

  for (const s of skus) {
    const family = familyKey(s.sku);
    const list = familyMap.get(family) ?? [];
    list.push(s);
    familyMap.set(family, list);
  }

  return Array.from(familyMap.entries()).map(([family, children]) => ({
    family,
    children,
    familyQty: children.reduce((sum, c) => sum + c.qty, 0),
    isSingleton: children.length === 1,
  }));
}

const thCls = 'px-4 py-3 text-xs font-semibold text-gray-500 dark:text-text-muted uppercase tracking-wider text-left';
const tdCls = 'px-4 py-3 border-b border-gray-50 dark:border-surface-border text-sm';

export default function CatalogPage() {
  const [activeTab, setActiveTab] = useState<Tab>('summary');
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
  const [expandedCombo, setExpandedCombo] = useState<string | null>(null);
  const [expandedFamily, setExpandedFamily] = useState<Set<string>>(new Set());
  const [qtySort, setQtySort] = useState<'asc' | 'desc'>('asc');

  useEffect(() => {
    setLoading(true); setError(null);
    fetch('/api/catalog')
      .then((r) => r.json())
      .then((d) => { if (d.error) throw new Error(d.error); setData(d); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  async function runValidation() {
    setValidating(true);
    try {
      const r = await fetch('/api/catalog?view=validate');
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      setValidationResult(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Validation failed');
    } finally {
      setValidating(false);
    }
  }

  const pillBase = 'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors';
  const pillActive = 'bg-accent-primary text-white';
  const pillInactive = 'text-gray-500 dark:text-text-secondary hover:bg-gray-100 dark:hover:bg-surface-hover';

  const inventorySkus: InventorySku[] = (data as Record<string, InventorySku[]>)?.inventorySkus ?? [];
  const comboSkus: ComboSku[] = (data as Record<string, ComboSku[]>)?.comboSkus ?? [];
  const needsReview: InventorySku[] = (data as Record<string, InventorySku[]>)?.needsReview ?? [];

  const filteredInventory = inventorySkus
    .filter((s) => s.sku.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => qtySort === 'desc' ? b.qty - a.qty : a.qty - b.qty);

  const inventoryFamilies: InventoryFamily[] = (() => {
    const filtered = inventorySkus.filter((s) =>
      s.sku.toLowerCase().includes(search.toLowerCase())
    );
    const families = buildFamilies(filtered);
    return families.sort((a, b) =>
      qtySort === 'desc' ? b.familyQty - a.familyQty : a.familyQty - b.familyQty
    );
  })();

  const summary: CatalogSummary = {
    totalInventorySkus: inventorySkus.length,
    totalComboSkus: comboSkus.length,
    needsReviewCount: needsReview.length,
    mappingErrorsCount: (data as Record<string, unknown[]>)?.mappingErrors?.length ?? 0,
  };

  return (
    <main className="min-h-screen bg-gray-50 dark:bg-surface">
      <div className="bg-white dark:bg-surface-card border-b border-gray-200 dark:border-surface-border px-6 py-4">
        <div className="max-w-7xl mx-auto">
          <h1 className="text-xl font-semibold text-gray-900 dark:text-text-primary">SKU Catalog</h1>
          <p className="text-xs text-gray-400 dark:text-text-muted mt-0.5">Inventory SKUs, combo products, and component mappings</p>
        </div>
      </div>

      {/* Tab bar */}
      <div className="bg-white dark:bg-surface-card border-b border-gray-200 dark:border-surface-border px-6 py-2">
        <div className="max-w-7xl mx-auto flex gap-1 flex-wrap">
          {tabDef.map(({ id, label, icon }) => (
            <button key={id} onClick={() => setActiveTab(id)} className={`${pillBase} ${activeTab === id ? pillActive : pillInactive}`}>
              {icon}{label}
            </button>
          ))}
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-6">
        {loading && (
          <div className="space-y-3">
            {[...Array(4)].map((_, i) => <div key={i} className="h-16 bg-gray-100 dark:bg-surface-elevated rounded-xl animate-pulse" />)}
          </div>
        )}

        {error && (
          <div className="bg-red-950 border border-red-800 rounded-xl p-4 text-red-300 text-sm">
            ✗ {error}
          </div>
        )}

        {!loading && !error && (
          <>
            {/* Summary tab */}
            {activeTab === 'summary' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {[
                  { label: 'Inventory SKUs', value: summary.totalInventorySkus, icon: <Layers size={20} />, tab: 'inventory' as Tab, color: 'text-accent-primary' },
                  { label: 'Combo Products', value: summary.totalComboSkus, icon: <Puzzle size={20} />, tab: 'combos' as Tab, color: 'text-accent-violet' },
                  { label: 'Needs Review', value: summary.needsReviewCount, icon: <AlertTriangle size={20} />, tab: 'review' as Tab, color: 'text-accent-amber' },
                  { label: 'Mapping Errors', value: summary.mappingErrorsCount, icon: <XCircle size={20} />, tab: 'validate' as Tab, color: 'text-accent-red' },
                ].map(({ label, value, icon, tab, color }) => (
                  <button
                    key={label}
                    onClick={() => setActiveTab(tab)}
                    className="bg-white dark:bg-surface-card rounded-2xl border border-gray-100 dark:border-surface-border p-5 text-left hover:border-accent-primary transition-colors"
                  >
                    <div className={`${color} mb-2`}>{icon}</div>
                    <div className="text-2xl font-bold text-gray-900 dark:text-text-primary tabular-nums">{value.toLocaleString()}</div>
                    <div className="text-xs text-gray-500 dark:text-text-muted mt-1">{label}</div>
                  </button>
                ))}
              </div>
            )}

            {/* Inventory SKUs tab */}
            {activeTab === 'inventory' && (
              <div className="bg-white dark:bg-surface-card rounded-2xl border border-gray-100 dark:border-surface-border overflow-hidden">
                <div className="px-4 py-3 border-b border-gray-100 dark:border-surface-border">
                  <input
                    type="text"
                    placeholder="Search SKU..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="w-full max-w-xs text-sm border border-gray-200 dark:border-surface-border rounded-xl px-3 py-2 bg-white dark:bg-surface-elevated text-gray-900 dark:text-text-primary focus:outline-none focus:ring-2 focus:ring-accent-primary"
                  />
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead><tr className="bg-gray-50 dark:bg-surface-elevated"><th className={thCls}>Physical SKU</th><th className={thCls}>Storefront SKU(s)</th><th className={thCls}>Description</th><th className={`${thCls} text-right cursor-pointer select-none hover:text-gray-900 dark:hover:text-text-primary`} onClick={() => setQtySort(q => q === 'desc' ? 'asc' : 'desc')}>Qty {qtySort === 'desc' ? '↓' : '↑'}</th><th className={thCls}>Last Updated</th></tr></thead>
                    <tbody>
                      {inventoryFamilies.length === 0 ? (
                        <tr><td colSpan={5} className="px-4 py-12 text-center text-gray-400 dark:text-text-muted">No SKUs found</td></tr>
                      ) : inventoryFamilies.map((fam) => {
                        const isExpanded = expandedFamily.has(fam.family);
                        const canExpand = !fam.isSingleton;
                        // For singleton rows, render the single child's data directly
                        const displaySku = fam.isSingleton ? fam.children[0] : null;
                        return (
                          <>
                            {/* Family / parent row */}
                            <tr
                              key={fam.family}
                              className={`hover:bg-gray-50 dark:hover:bg-surface-hover transition-colors ${canExpand ? 'cursor-pointer' : ''}`}
                              onClick={() => {
                                if (!canExpand) return;
                                setExpandedFamily((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(fam.family)) next.delete(fam.family);
                                  else next.add(fam.family);
                                  return next;
                                });
                              }}
                            >
                              <td className={`${tdCls} font-mono font-semibold text-gray-900 dark:text-text-primary`}>
                                <span className="inline-flex items-center gap-1">
                                  {canExpand && (
                                    <span className="text-gray-400 text-xs w-3">{isExpanded ? '▼' : '▶'}</span>
                                  )}
                                  {fam.family}
                                </span>
                              </td>
                              <td className={tdCls}>
                                {displaySku && displaySku.storefrontSkus && displaySku.storefrontSkus.length > 0 ? (
                                  <div className="flex flex-col gap-0.5">
                                    {displaySku.storefrontSkus.map((sf) => (
                                      <span key={sf} className="font-mono text-xs text-gray-500 dark:text-text-secondary">{sf}</span>
                                    ))}
                                  </div>
                                ) : (
                                  <span className="text-xs text-gray-300 dark:text-text-muted">{canExpand ? `${fam.children.length} variants` : '—'}</span>
                                )}
                              </td>
                              <td className={`${tdCls} text-gray-600 dark:text-text-secondary`}>
                                {displaySku ? (displaySku.description ?? '—') : '—'}
                              </td>
                              <td className={`${tdCls} text-right font-bold tabular-nums ${qtyColor(fam.familyQty)}`}>
                                {fam.familyQty.toLocaleString()}
                              </td>
                              <td className={`${tdCls} text-gray-400 dark:text-text-muted text-xs`}>
                                {displaySku ? (displaySku.updatedAt ?? '—') : '—'}
                              </td>
                            </tr>
                            {/* Child rows (only when expanded and multi-variant) */}
                            {canExpand && isExpanded && fam.children.map((s) => (
                              <tr key={s.sku} className="bg-indigo-50/30 dark:bg-accent-primary/5 hover:bg-indigo-50/50 dark:hover:bg-accent-primary/10 transition-colors">
                                <td className={`${tdCls} pl-8 font-mono text-sm text-gray-700 dark:text-text-secondary`}>↳ {s.sku}</td>
                                <td className={tdCls}>
                                  {s.storefrontSkus && s.storefrontSkus.length > 0 ? (
                                    <div className="flex flex-col gap-0.5">
                                      {s.storefrontSkus.map((sf) => (
                                        <span key={sf} className="font-mono text-xs text-gray-500 dark:text-text-secondary">{sf}</span>
                                      ))}
                                    </div>
                                  ) : (
                                    <span className="text-xs text-gray-300 dark:text-text-muted">—</span>
                                  )}
                                </td>
                                <td className={`${tdCls} text-gray-600 dark:text-text-secondary text-xs`}>{s.description ?? '—'}</td>
                                <td className={`${tdCls} text-right font-semibold tabular-nums ${qtyColor(s.qty)}`}>{s.qty.toLocaleString()}</td>
                                <td className={`${tdCls} text-gray-400 dark:text-text-muted text-xs`}>{s.updatedAt ?? '—'}</td>
                              </tr>
                            ))}
                          </>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Combo Products tab */}
            {activeTab === 'combos' && (
              <div className="bg-white dark:bg-surface-card rounded-2xl border border-gray-100 dark:border-surface-border overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead><tr className="bg-gray-50 dark:bg-surface-elevated"><th className={thCls}>Combo SKU</th><th className={thCls}>Description</th><th className={`${thCls} text-right`}># Components</th></tr></thead>
                    <tbody>
                      {comboSkus.length === 0 ? (
                        <tr><td colSpan={3} className="px-4 py-12 text-center text-gray-400 dark:text-text-muted">No combo products</td></tr>
                      ) : comboSkus.map((c) => {
                        const isExpanded = expandedCombo === c.sku;
                        return (
                          <>
                            <tr key={c.sku} className="hover:bg-gray-50 dark:hover:bg-surface-hover transition-colors cursor-pointer" onClick={() => setExpandedCombo(isExpanded ? null : c.sku)}>
                              <td className={`${tdCls} font-mono font-semibold text-gray-900 dark:text-text-primary`}>
                                <span className="inline-flex items-center gap-1">{c.sku}<span className="text-gray-400 text-xs">{isExpanded ? '▲' : '▼'}</span></span>
                              </td>
                              <td className={`${tdCls} text-gray-600 dark:text-text-secondary`}>{c.description ?? '—'}</td>
                              <td className={`${tdCls} text-right text-gray-700 dark:text-text-secondary tabular-nums`}>{c.components.length}</td>
                            </tr>
                            {isExpanded && c.components.map((comp) => (
                              <tr key={comp.sku} className="bg-indigo-50/40 dark:bg-accent-primary/5">
                                <td className={`${tdCls} pl-8 font-mono text-xs text-gray-500 dark:text-text-muted`}>↳ {comp.sku}</td>
                                <td className={tdCls} />
                                <td className={`${tdCls} text-right text-xs text-gray-500 dark:text-text-muted tabular-nums`}>×{comp.qty}</td>
                              </tr>
                            ))}
                          </>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Components tab */}
            {activeTab === 'components' && (
              <div className="bg-white dark:bg-surface-card rounded-2xl border border-gray-100 dark:border-surface-border overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead><tr className="bg-gray-50 dark:bg-surface-elevated"><th className={thCls}>Component SKU</th><th className={thCls}>Used In (Combos)</th><th className={`${thCls} text-right`}>Total Qty Available</th></tr></thead>
                    <tbody>
                      {comboSkus.length === 0 ? (
                        <tr><td colSpan={3} className="px-4 py-12 text-center text-gray-400 dark:text-text-muted">No component data</td></tr>
                      ) : (() => {
                        const compMap = new Map<string, string[]>();
                        for (const c of comboSkus) {
                          for (const comp of c.components) {
                            const list = compMap.get(comp.sku) ?? [];
                            list.push(c.sku);
                            compMap.set(comp.sku, list);
                          }
                        }
                        return Array.from(compMap.entries()).map(([compSku, parents]) => {
                          const inv = inventorySkus.find((s) => s.sku === compSku);
                          return (
                            <tr key={compSku} className="hover:bg-gray-50 dark:hover:bg-surface-hover transition-colors">
                              <td className={`${tdCls} font-mono font-semibold text-gray-900 dark:text-text-primary`}>{compSku}</td>
                              <td className={tdCls}><div className="flex flex-wrap gap-1">{parents.map((p) => <span key={p} className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-mono bg-indigo-900 text-indigo-300">{p}</span>)}</div></td>
                              <td className={`${tdCls} text-right tabular-nums font-semibold ${inv ? qtyColor(inv.qty) : 'text-gray-400 dark:text-text-muted'}`}>{inv ? inv.qty.toLocaleString() : '—'}</td>
                            </tr>
                          );
                        });
                      })()}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Needs Review tab */}
            {activeTab === 'review' && (
              <div className="bg-white dark:bg-surface-card rounded-2xl border border-gray-100 dark:border-surface-border overflow-hidden">
                <div className="px-4 py-3 border-b border-gray-100 dark:border-surface-border">
                  <p className="text-xs text-gray-500 dark:text-text-muted">Unclassified SKUs that need manual review or mapping.</p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead><tr className="bg-gray-50 dark:bg-surface-elevated"><th className={thCls}>SKU</th><th className={thCls}>Description</th><th className={`${thCls} text-right`}>Qty</th><th className={thCls}>Action</th></tr></thead>
                    <tbody>
                      {needsReview.length === 0 ? (
                        <tr><td colSpan={4} className="px-4 py-12 text-center text-gray-400 dark:text-text-muted">✓ Nothing needs review</td></tr>
                      ) : needsReview.map((s) => (
                        <tr key={s.sku} className="hover:bg-gray-50 dark:hover:bg-surface-hover transition-colors">
                          <td className={`${tdCls} font-mono font-semibold text-accent-amber`}>{s.sku}</td>
                          <td className={`${tdCls} text-gray-600 dark:text-text-secondary`}>{s.description ?? '—'}</td>
                          <td className={`${tdCls} text-right tabular-nums ${qtyColor(s.qty)}`}>{s.qty.toLocaleString()}</td>
                          <td className={tdCls}><a href="/mappings" className="text-xs text-accent-primary hover:underline">→ Map it</a></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Validate tab */}
            {activeTab === 'validate' && (
              <div className="space-y-4">
                <button
                  onClick={runValidation}
                  disabled={validating}
                  className="flex items-center gap-2 px-4 py-2 bg-accent-primary text-white rounded-xl text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors"
                >
                  <RefreshCw size={14} className={validating ? 'animate-spin' : ''} />
                  {validating ? 'Running…' : 'Run Validation'}
                </button>
                {validationResult && (
                  <div className="bg-white dark:bg-surface-card rounded-2xl border border-gray-100 dark:border-surface-border p-6 space-y-3">
                    {[
                      { label: 'Orphan Combos', value: validationResult.orphanCombos },
                      { label: 'Bad Mapping Targets', value: validationResult.badMappingTargets },
                      { label: 'Invalid Quantities', value: validationResult.invalidQuantities },
                      { label: 'Allocations on Combo SKUs', value: validationResult.allocationsOnCombos },
                    ].map(({ label, value }) => (
                      <div key={label} className="flex items-center gap-3">
                        {value === 0
                          ? <CheckCircle size={16} className="text-accent-emerald shrink-0" />
                          : <XCircle size={16} className="text-accent-red shrink-0" />}
                        <span className="text-sm text-gray-700 dark:text-text-secondary">{label}</span>
                        {value > 0 && <span className="ml-auto text-xs font-bold text-accent-red">{value} issues</span>}
                        {value === 0 && <span className="ml-auto text-xs text-accent-emerald">OK</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}
