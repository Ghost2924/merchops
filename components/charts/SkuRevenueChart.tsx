'use client';

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';
import { DailySummary } from '@/lib/data/types';
import { getFamilySku } from '@/lib/sku';

interface SkuRevenueChartProps {
  summaries: DailySummary[];
  topN?: number;
}

const COLORS = [
  '#6366f1', '#8b5cf6', '#a78bfa', '#c4b5fd',
  '#818cf8', '#4f46e5', '#7c3aed', '#9333ea',
  '#a855f7', '#c026d3',
];

export default function SkuRevenueChart({ summaries, topN = 10 }: SkuRevenueChartProps) {
  if (summaries.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-400 dark:text-text-muted text-sm">
        No data available
      </div>
    );
  }

  // Collect all raw SKUs for sibling check
  const allRawSkus = new Set<string>();
  for (const day of summaries) for (const skuRec of day.skus) allRawSkus.add(skuRec.sku);

  const skuRevMap = new Map<string, number>();
  for (const day of summaries) {
    for (const skuRec of day.skus) {
      const family = getFamilySku(skuRec.sku, allRawSkus);
      skuRevMap.set(family, (skuRevMap.get(family) ?? 0) + skuRec.totalRevenue);
    }
  }

  const data = Array.from(skuRevMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([sku, revenue]) => ({ sku, revenue: Math.round(revenue * 100) / 100 }));

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-400 dark:text-text-muted text-sm">
        No SKU data available
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart
        data={data}
        layout="vertical"
        margin={{ top: 4, right: 16, left: 8, bottom: 4 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="#1e1e2e" horizontal={false} />
        <XAxis
          type="number"
          tick={{ fontSize: 11, fill: '#475569' }}
          tickFormatter={(v: number) =>
            v >= 1000 ? `$${(v / 1000).toFixed(0)}k` : `$${v}`
          }
        />
        <YAxis
          type="category"
          dataKey="sku"
          tick={{ fontSize: 11, fill: '#475569' }}
          width={110}
          tickFormatter={(v: string) => (v.length > 14 ? v.slice(0, 13) + '…' : v)}
        />
        <Tooltip
          contentStyle={{
            fontSize: 12,
            borderRadius: 12,
            background: '#16161f',
            border: '1px solid #1e1e2e',
            color: '#f1f5f9',
          }}
          formatter={(v: number) => [
            `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
            'Revenue',
          ]}
        />
        <Bar dataKey="revenue" radius={[0, 4, 4, 0]}>
          {data.map((_, i) => (
            <Cell key={i} fill={COLORS[i % COLORS.length]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
