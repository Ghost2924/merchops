import MockupFrame from './MockupFrame';

export function DashboardFeatureMockup() {
  const kpis = [
    { label: 'Orders Today', value: '142', sub: '+8.2% vs yesterday', positive: true },
    { label: 'Revenue Today', value: '$8,420', sub: '+5.1% vs yesterday', positive: true },
    { label: 'Net Profit', value: '$2,180', sub: '25.9% margin', positive: true },
    { label: 'AOV', value: '$59.30', sub: 'Net of coupons', positive: undefined },
    { label: 'Low Stock Alerts', value: '6', sub: 'Under 14 days cover', positive: false },
    { label: 'MTD Revenue', value: '$184k', sub: '+11.2% vs prior', positive: true },
  ];

  const chartHeights = [38, 52, 45, 61, 58, 72, 68, 79, 74, 85, 82, 91, 88, 96];

  return (
    <MockupFrame title="Dashboard">
      <div className="space-y-3">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {kpis.map((kpi) => (
            <div
              key={kpi.label}
              className="rounded-lg border border-white/[0.06] bg-surface-elevated/40 p-2.5"
            >
              <p className="text-[9px] font-medium uppercase tracking-wide text-text-muted">
                {kpi.label}
              </p>
              <p className="text-base font-bold text-text-primary tabular-nums mt-0.5">
                {kpi.value}
              </p>
              <p
                className={[
                  'text-[9px] mt-0.5',
                  kpi.positive === true
                    ? 'text-accent-emerald'
                    : kpi.positive === false
                      ? 'text-accent-amber'
                      : 'text-text-muted',
                ].join(' ')}
              >
                {kpi.sub}
              </p>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-lg border border-white/[0.06] bg-surface-elevated/30 p-3">
            <p className="text-[10px] font-semibold text-text-primary mb-2">Daily Orders</p>
            <div className="flex items-end gap-0.5 h-14">
              {chartHeights.map((h, i) => (
                <div
                  key={i}
                  className="flex-1 rounded-sm bg-accent-primary/25"
                  style={{ height: `${h * 0.55}%` }}
                />
              ))}
            </div>
          </div>
          <div className="rounded-lg border border-white/[0.06] bg-surface-elevated/30 p-3">
            <p className="text-[10px] font-semibold text-text-primary mb-2">Daily Revenue</p>
            <div className="flex items-end gap-0.5 h-14">
              {chartHeights.map((h, i) => (
                <div
                  key={i}
                  className="flex-1 rounded-sm bg-accent-emerald/25"
                  style={{ height: `${h * 0.6}%` }}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </MockupFrame>
  );
}

const RESTOCK_ROWS = [
  { sku: 'WIDGET-A1', cover: 4, qty: 240, urgency: 'critical' as const },
  { sku: 'WIDGET-B2', cover: 9, qty: 120, urgency: 'warning' as const },
  { sku: 'COMBO-C3', cover: 18, qty: 60, urgency: 'ok' as const },
  { sku: 'WIDGET-D4', cover: 22, qty: 0, urgency: 'ok' as const },
];

export function RestockFeatureMockup() {
  const urgencyStyles = {
    critical: 'bg-accent-red/10 text-accent-red border-accent-red/25',
    warning: 'bg-accent-amber/10 text-accent-amber border-accent-amber/25',
    ok: 'bg-accent-emerald/10 text-accent-emerald border-accent-emerald/25',
  };

  return (
    <MockupFrame title="Restock Planner">
      <div className="rounded-lg border border-white/[0.06] overflow-hidden">
        <table className="w-full text-[10px]">
          <thead>
            <tr className="bg-surface-elevated/60 text-left border-b border-white/[0.06]">
              <th className="px-3 py-2 font-semibold text-text-muted uppercase tracking-wider">
                SKU
              </th>
              <th className="px-2 py-2 font-semibold text-text-muted uppercase tracking-wider text-right">
                Days Cover
              </th>
              <th className="px-2 py-2 font-semibold text-text-muted uppercase tracking-wider text-right">
                Rec. Qty
              </th>
              <th className="px-3 py-2 font-semibold text-text-muted uppercase tracking-wider text-right">
                Urgency
              </th>
            </tr>
          </thead>
          <tbody>
            {RESTOCK_ROWS.map((row) => (
              <tr key={row.sku} className="border-b border-white/[0.04] last:border-0">
                <td className="px-3 py-2.5 font-mono font-medium text-text-primary">{row.sku}</td>
                <td className="px-2 py-2.5 text-right tabular-nums text-text-secondary">
                  {row.cover}d
                </td>
                <td className="px-2 py-2.5 text-right tabular-nums font-semibold text-text-primary">
                  {row.qty > 0 ? row.qty : '—'}
                </td>
                <td className="px-3 py-2.5 text-right">
                  <span
                    className={`inline-flex px-1.5 py-0.5 rounded border text-[9px] font-semibold uppercase ${urgencyStyles[row.urgency]}`}
                  >
                    {row.urgency}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[9px] text-text-muted mt-2.5">
        Lead time: 12 days · Velocity: 90-day in-stock corrected
      </p>
    </MockupFrame>
  );
}

const CATALOG_ROWS = [
  { sku: 'WIDGET-A1', type: 'Single', mapped: true, storefront: 'AMZ-001' },
  { sku: 'COMBO-C3', type: 'Bundle', mapped: true, storefront: 'AMZ-003' },
  { sku: 'WIDGET-E5', type: 'Single', mapped: false, storefront: '—' },
  { sku: 'WIDGET-F6', type: 'Single', mapped: false, storefront: 'AMZ-006' },
];

export function CatalogFeatureMockup() {
  return (
    <MockupFrame title="SKU Catalog & Mappings">
      <div className="rounded-lg border border-white/[0.06] overflow-hidden">
        <table className="w-full text-[10px]">
          <thead>
            <tr className="bg-surface-elevated/60 text-left border-b border-white/[0.06]">
              <th className="px-3 py-2 font-semibold text-text-muted uppercase tracking-wider">
                SKU
              </th>
              <th className="px-2 py-2 font-semibold text-text-muted uppercase tracking-wider">
                Type
              </th>
              <th className="px-2 py-2 font-semibold text-text-muted uppercase tracking-wider">
                Storefront
              </th>
              <th className="px-3 py-2 font-semibold text-text-muted uppercase tracking-wider text-right">
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {CATALOG_ROWS.map((row) => (
              <tr key={row.sku} className="border-b border-white/[0.04] last:border-0">
                <td className="px-3 py-2.5 font-mono font-medium text-text-primary">{row.sku}</td>
                <td className="px-2 py-2.5 text-text-secondary">{row.type}</td>
                <td className="px-2 py-2.5 font-mono text-text-secondary">{row.storefront}</td>
                <td className="px-3 py-2.5 text-right">
                  <span
                    className={[
                      'inline-flex px-1.5 py-0.5 rounded border text-[9px] font-semibold uppercase',
                      row.mapped
                        ? 'bg-accent-emerald/10 text-accent-emerald border-accent-emerald/25'
                        : 'bg-accent-amber/10 text-accent-amber border-accent-amber/25',
                    ].join(' ')}
                  >
                    {row.mapped ? 'Mapped' : 'Unmapped'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[9px] text-accent-amber mt-2.5 font-medium">2 unmapped SKUs need attention</p>
    </MockupFrame>
  );
}

const VENDOR_ROWS = [
  { asin: 'B0XX1A2B3C', revenue: '$4,820', margin: '22.4%', discrepancy: 0 },
  { asin: 'B0XX4D5E6F', revenue: '$3,140', margin: '18.1%', discrepancy: 2 },
  { asin: 'B0XX7G8H9I', revenue: '$2,680', margin: '15.6%', discrepancy: 0 },
  { asin: 'B0XX0J1K2L', revenue: '$1,920', margin: '11.2%', discrepancy: 1 },
];

export function VendorFeatureMockup() {
  const maxRevenue = 4820;

  return (
    <MockupFrame title="Vendor Central Analytics">
      <div className="space-y-3">
        <div className="space-y-2">
          {VENDOR_ROWS.map((row) => (
            <div key={row.asin} className="flex items-center gap-3">
              <span className="w-24 shrink-0 font-mono text-[9px] text-text-secondary truncate">
                {row.asin}
              </span>
              <div className="flex-1 h-2 rounded-full bg-surface-elevated overflow-hidden">
                <div
                  className="h-full rounded-full bg-accent-primary/40"
                  style={{ width: `${(parseFloat(row.revenue.replace(/[$,]/g, '')) / maxRevenue) * 100}%` }}
                />
              </div>
              <span className="w-14 shrink-0 text-right text-[9px] tabular-nums text-text-primary font-medium">
                {row.revenue}
              </span>
            </div>
          ))}
        </div>

        <div className="rounded-lg border border-white/[0.06] overflow-hidden">
          <table className="w-full text-[10px]">
            <thead>
              <tr className="bg-surface-elevated/60 text-left border-b border-white/[0.06]">
                <th className="px-3 py-2 font-semibold text-text-muted uppercase tracking-wider">
                  ASIN
                </th>
                <th className="px-2 py-2 font-semibold text-text-muted uppercase tracking-wider text-right">
                  Margin
                </th>
                <th className="px-3 py-2 font-semibold text-text-muted uppercase tracking-wider text-right">
                  Discrepancies
                </th>
              </tr>
            </thead>
            <tbody>
              {VENDOR_ROWS.map((row) => (
                <tr key={row.asin} className="border-b border-white/[0.04] last:border-0">
                  <td className="px-3 py-2 font-mono text-text-primary">{row.asin}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-text-secondary">
                    {row.margin}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <span
                      className={[
                        'tabular-nums font-semibold',
                        row.discrepancy > 0 ? 'text-accent-amber' : 'text-accent-emerald',
                      ].join(' ')}
                    >
                      {row.discrepancy}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </MockupFrame>
  );
}
