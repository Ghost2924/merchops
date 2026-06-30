'use client';

import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { DailySummary } from '@/lib/data/types';

interface RevenueOrdersChartProps {
  summaries: DailySummary[];
  period?: number;
}

function formatDateLabel(dateStr: string, period: number): string {
  const d = new Date(dateStr + 'T00:00:00');
  if (period <= 90) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (period <= 365) return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
  return String(d.getFullYear());
}

export default function RevenueOrdersChart({ summaries, period = 30 }: RevenueOrdersChartProps) {
  if (summaries.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-400 dark:text-text-muted text-sm">
        No data available
      </div>
    );
  }

  const data = summaries.map((s) => ({
    date: s.date,
    orders: s.orderCount,
    revenue: s.totalRevenue,
  }));

  const tickInterval = period > 365 ? Math.floor(summaries.length / 8) : 'preserveStartEnd';

  return (
    <ResponsiveContainer width="100%" height={220}>
      <ComposedChart data={data} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e1e2e" />
        <XAxis
          dataKey="date"
          tick={{ fontSize: 11, fill: '#475569' }}
          interval={tickInterval}
          tickFormatter={(v: string) => formatDateLabel(v, period)}
        />
        {/* Left axis: orders */}
        <YAxis
          yAxisId="orders"
          orientation="left"
          tick={{ fontSize: 11, fill: '#475569' }}
          allowDecimals={false}
        />
        {/* Right axis: revenue */}
        <YAxis
          yAxisId="revenue"
          orientation="right"
          tick={{ fontSize: 11, fill: '#475569' }}
          tickFormatter={(v: number) => `$${(v / 1000).toFixed(0)}k`}
        />
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
          formatter={(v: number, name: string) =>
            name === 'revenue'
              ? [`$${v.toLocaleString('en-US', { minimumFractionDigits: 2 })}`, 'Revenue']
              : [v.toLocaleString(), 'Orders']
          }
        />
        <Legend
          wrapperStyle={{ fontSize: 11, color: '#475569' }}
        />
        <Bar
          yAxisId="orders"
          dataKey="orders"
          fill="rgba(99,102,241,0.6)"
          radius={[3, 3, 0, 0]}
          name="orders"
        />
        <Line
          yAxisId="revenue"
          type="monotone"
          dataKey="revenue"
          stroke="#10b981"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4 }}
          name="revenue"
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
