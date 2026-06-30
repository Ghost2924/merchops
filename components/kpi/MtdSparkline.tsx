'use client';

import { LineChart, Line, ResponsiveContainer } from 'recharts';
import { DailySummary } from '@/lib/data/types';

export default function MtdSparkline({ summaries }: { summaries: DailySummary[] }) {
  if (summaries.length < 2) return null;
  const data = summaries
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((s) => ({ v: s.totalRevenue }));

  return (
    <ResponsiveContainer width="100%" height={40}>
      <LineChart data={data} margin={{ top: 2, right: 2, left: 2, bottom: 2 }}>
        <Line
          type="monotone"
          dataKey="v"
          stroke="#6366f1"
          strokeWidth={1.5}
          dot={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
