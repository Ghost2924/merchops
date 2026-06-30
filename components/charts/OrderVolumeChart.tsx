'use client';

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { DailySummary } from '@/lib/data/types';

interface OrderVolumeChartProps {
  summaries: DailySummary[];
  period?: number;
}

function formatDateLabel(dateStr: string, period: number): string {
  const d = new Date(dateStr + 'T00:00:00');
  if (period <= 90) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (period <= 365) return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
  return String(d.getFullYear());
}

export default function OrderVolumeChart({ summaries, period = 30 }: OrderVolumeChartProps) {
  if (summaries.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-400 dark:text-text-muted text-sm">
        No data available
      </div>
    );
  }

  const data = summaries.map((s) => ({ date: s.date, orders: s.orderCount }));
  const tickInterval = period > 365 ? Math.floor(summaries.length / 8) : 'preserveStartEnd';

  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e1e2e" />
        <XAxis
          dataKey="date"
          tick={{ fontSize: 11, fill: '#475569' }}
          interval={tickInterval}
          tickFormatter={(v: string) => formatDateLabel(v, period)}
        />
        <YAxis tick={{ fontSize: 11, fill: '#475569' }} allowDecimals={false} />
        <Tooltip
          contentStyle={{
            fontSize: 12,
            borderRadius: 12,
            background: '#16161f',
            border: '1px solid #1e1e2e',
            color: '#f1f5f9',
          }}
          labelFormatter={(v: string) =>
            new Date(v + 'T00:00:00').toLocaleDateString('en-US', {
              year: 'numeric', month: 'short', day: 'numeric',
            })
          }
          formatter={(v: number) => [v.toLocaleString(), 'Orders']}
        />
        <Bar dataKey="orders" fill="rgba(99,102,241,0.8)" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
