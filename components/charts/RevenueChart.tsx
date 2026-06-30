'use client';

import {
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Area,
  AreaChart,
} from 'recharts';
import { DailySummary } from '@/lib/data/types';

interface RevenueChartProps {
  summaries: DailySummary[];
  period?: number;
}

function formatDateLabel(dateStr: string, period: number): string {
  const d = new Date(dateStr + 'T00:00:00');
  if (period <= 90) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (period <= 365) return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
  return String(d.getFullYear());
}

export default function RevenueChart({ summaries, period = 30 }: RevenueChartProps) {
  if (summaries.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-400 dark:text-text-muted text-sm">
        No data available
      </div>
    );
  }

  const data = summaries.map((s) => ({ date: s.date, revenue: s.totalRevenue }));
  const tickInterval = period > 365 ? Math.floor(summaries.length / 8) : 'preserveStartEnd';

  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="revenueGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="rgba(16,185,129,0.3)" stopOpacity={1} />
            <stop offset="95%" stopColor="rgba(16,185,129,0)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e1e2e" />
        <XAxis
          dataKey="date"
          tick={{ fontSize: 11, fill: '#475569' }}
          interval={tickInterval}
          tickFormatter={(v: string) => formatDateLabel(v, period)}
        />
        <YAxis
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
          formatter={(v: number) => [
            `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
            'Revenue',
          ]}
        />
        <Area
          type="monotone"
          dataKey="revenue"
          stroke="rgba(16,185,129,1)"
          strokeWidth={2}
          fill="url(#revenueGradient)"
          dot={false}
          activeDot={{ r: 4 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
