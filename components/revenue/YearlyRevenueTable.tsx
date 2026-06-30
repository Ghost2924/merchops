'use client';

import { useState } from 'react';
import { DailySummary } from '@/lib/data/types';
import { formatUSD } from '@/lib/formatters';

interface YearlyRevenueTableProps {
  summaries: DailySummary[];
}

interface YearSummary {
  year: number;
  totalRevenue: number;
  totalOrders: number;
  aov: number;
  days: number;
  dailySummaries: DailySummary[];
}

interface MonthSummary {
  month: number; // 1–12
  label: string;
  totalRevenue: number;
  totalOrders: number;
  aov: number;
  days: number;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function buildYears(summaries: DailySummary[]): YearSummary[] {
  const byYear = new Map<number, DailySummary[]>();
  for (const s of summaries) {
    const year = parseInt(s.date.slice(0, 4), 10);
    const list = byYear.get(year) ?? [];
    list.push(s);
    byYear.set(year, list);
  }

  return Array.from(byYear.entries())
    .map(([year, days]) => {
      const totalRevenue = days.reduce((sum, d) => sum + d.totalRevenue, 0);
      const totalOrders = days.reduce((sum, d) => sum + d.orderCount, 0);
      return {
        year,
        totalRevenue,
        totalOrders,
        aov: totalOrders > 0 ? totalRevenue / totalOrders : 0,
        days: days.length,
        dailySummaries: days,
      };
    })
    .sort((a, b) => b.year - a.year); // newest first
}

function buildMonths(dailySummaries: DailySummary[]): MonthSummary[] {
  const byMonth = new Map<number, DailySummary[]>();
  for (const s of dailySummaries) {
    const month = parseInt(s.date.slice(5, 7), 10);
    const list = byMonth.get(month) ?? [];
    list.push(s);
    byMonth.set(month, list);
  }

  return Array.from(byMonth.entries())
    .map(([month, days]) => {
      const totalRevenue = days.reduce((sum, d) => sum + d.totalRevenue, 0);
      const totalOrders = days.reduce((sum, d) => sum + d.orderCount, 0);
      return {
        month,
        label: MONTH_NAMES[month - 1],
        totalRevenue,
        totalOrders,
        aov: totalOrders > 0 ? totalRevenue / totalOrders : 0,
        days: days.length,
      };
    })
    .sort((a, b) => b.month - a.month); // newest month first
}

export default function YearlyRevenueTable({ summaries }: YearlyRevenueTableProps) {
  const [expandedYear, setExpandedYear] = useState<number | null>(null);

  const years = buildYears(summaries);
  if (years.length === 0) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-8 text-center text-gray-400 text-sm">
        No historical data available
      </div>
    );
  }

  const maxRevenue = Math.max(...years.map((y) => y.totalRevenue), 1);
  const currentYear = new Date().getFullYear();

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-gray-700">Revenue by Year</h3>
          <p className="text-xs text-gray-400 mt-0.5">Click a year to see monthly breakdown</p>
        </div>
        <span className="text-xs text-gray-400">{years.length} years of data</span>
      </div>

      {/* Year rows */}
      <div className="divide-y divide-gray-50">
        {years.map((y) => {
          const isExpanded = expandedYear === y.year;
          const isCurrentYear = y.year === currentYear;
          const barPct = Math.round((y.totalRevenue / maxRevenue) * 100);
          const months = isExpanded ? buildMonths(y.dailySummaries) : [];
          const maxMonthRevenue = isExpanded
            ? Math.max(...months.map((m) => m.totalRevenue), 1)
            : 1;

          return (
            <div key={y.year}>
              {/* Year row — clickable */}
              <button
                onClick={() => setExpandedYear(isExpanded ? null : y.year)}
                className={`w-full text-left px-6 py-4 transition-colors flex items-center gap-4 ${
                  isExpanded
                    ? 'bg-indigo-50 hover:bg-indigo-100'
                    : 'hover:bg-gray-50'
                }`}
              >
                {/* Chevron */}
                <span
                  className={`text-gray-400 transition-transform text-xs ${
                    isExpanded ? 'rotate-90' : ''
                  }`}
                  style={{ display: 'inline-block' }}
                >
                  ▶
                </span>

                {/* Year label */}
                <span className="w-16 font-bold text-gray-900 text-sm">
                  {y.year}
                  {isCurrentYear && (
                    <span className="ml-1.5 text-xs font-semibold text-indigo-600 bg-indigo-100 px-1.5 py-0.5 rounded-full">
                      YTD
                    </span>
                  )}
                </span>

                {/* Stats */}
                <div className="flex-1 grid grid-cols-3 gap-4 text-sm">
                  <div>
                    <span className="text-xs text-gray-400 block">Revenue</span>
                    <span className="font-semibold text-gray-900">{formatUSD(y.totalRevenue)}</span>
                  </div>
                  <div>
                    <span className="text-xs text-gray-400 block">Orders</span>
                    <span className="font-semibold text-gray-700">{y.totalOrders.toLocaleString()}</span>
                  </div>
                  <div>
                    <span className="text-xs text-gray-400 block">AOV</span>
                    <span className="font-semibold text-gray-700">{formatUSD(y.aov)}</span>
                  </div>
                </div>

                {/* Bar */}
                <div className="w-32 hidden sm:block">
                  <div className="w-full bg-gray-100 rounded-full h-2">
                    <div
                      className={`h-2 rounded-full ${
                        isCurrentYear ? 'bg-indigo-500' : 'bg-emerald-400'
                      }`}
                      style={{ width: `${barPct}%` }}
                    />
                  </div>
                </div>
              </button>

              {/* Monthly breakdown — expanded */}
              {isExpanded && (
                <div className="bg-gray-50 border-t border-gray-100">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left border-b border-gray-200">
                        <th className="pl-16 pr-4 py-2 text-xs font-semibold text-gray-400 uppercase tracking-wide">
                          Month
                        </th>
                        <th className="px-4 py-2 text-xs font-semibold text-gray-400 uppercase tracking-wide text-right">
                          Revenue
                        </th>
                        <th className="px-4 py-2 text-xs font-semibold text-gray-400 uppercase tracking-wide text-right">
                          Orders
                        </th>
                        <th className="px-4 py-2 text-xs font-semibold text-gray-400 uppercase tracking-wide text-right">
                          AOV
                        </th>
                        <th className="px-4 py-2 w-28 hidden sm:table-cell" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {months.map((m) => {
                        const mBarPct = Math.round((m.totalRevenue / maxMonthRevenue) * 100);
                        return (
                          <tr key={m.month} className="hover:bg-white transition-colors">
                            <td className="pl-16 pr-4 py-2.5 font-medium text-gray-700">
                              {m.label}
                            </td>
                            <td className="px-4 py-2.5 text-right font-semibold text-gray-900">
                              {formatUSD(m.totalRevenue)}
                            </td>
                            <td className="px-4 py-2.5 text-right text-gray-600">
                              {m.totalOrders.toLocaleString()}
                            </td>
                            <td className="px-4 py-2.5 text-right text-gray-500">
                              {formatUSD(m.aov)}
                            </td>
                            <td className="px-4 py-2.5 hidden sm:table-cell">
                              <div className="w-full bg-gray-200 rounded-full h-1.5">
                                <div
                                  className="h-1.5 rounded-full bg-emerald-400"
                                  style={{ width: `${mBarPct}%` }}
                                />
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-gray-200 bg-white">
                        <td className="pl-16 pr-4 py-2.5 text-xs font-semibold text-gray-500 uppercase">
                          {y.year} Total
                        </td>
                        <td className="px-4 py-2.5 text-right font-bold text-gray-900">
                          {formatUSD(y.totalRevenue)}
                        </td>
                        <td className="px-4 py-2.5 text-right font-bold text-gray-900">
                          {y.totalOrders.toLocaleString()}
                        </td>
                        <td className="px-4 py-2.5 text-right text-gray-500">
                          {formatUSD(y.aov)}
                        </td>
                        <td className="hidden sm:table-cell" />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
