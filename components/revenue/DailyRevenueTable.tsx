import { DailySummary } from '@/lib/data/types';
import { formatUSD } from '@/lib/formatters';

interface DailyRevenueTableProps {
  summaries: DailySummary[];      // expects up to 30 days, sorted asc or desc
  todaySummary: DailySummary | null;
}

export default function DailyRevenueTable({
  summaries,
  todaySummary,
}: DailyRevenueTableProps) {
  // Merge today into the list if not already present, then sort desc (newest first)
  const allDays = [...summaries];
  if (
    todaySummary &&
    !allDays.find((s) => s.date === todaySummary.date)
  ) {
    allDays.push(todaySummary);
  }
  const rows = allDays
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 30);

  const total30 = rows.reduce((sum, r) => sum + r.totalRevenue, 0);
  const totalOrders30 = rows.reduce((sum, r) => sum + r.orderCount, 0);
  const avgDaily = rows.length > 0 ? total30 / rows.length : 0;

  // Highest revenue day for bar scaling
  const maxRevenue = Math.max(...rows.map((r) => r.totalRevenue), 1);

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-100">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-sm font-semibold text-gray-700">Daily Revenue</h3>
            <p className="text-xs text-gray-400 mt-0.5">Last 30 days · newest first</p>
          </div>
          <div className="text-right">
            <p className="text-lg font-bold text-gray-900">{formatUSD(total30)}</p>
            <p className="text-xs text-gray-400">30-day total</p>
          </div>
        </div>

        {/* Summary pills */}
        <div className="flex gap-4 mt-3">
          <div className="bg-gray-50 rounded-lg px-3 py-2 flex-1 text-center">
            <p className="text-xs text-gray-400">Avg / day</p>
            <p className="text-sm font-semibold text-gray-800">{formatUSD(avgDaily)}</p>
          </div>
          <div className="bg-gray-50 rounded-lg px-3 py-2 flex-1 text-center">
            <p className="text-xs text-gray-400">Total orders</p>
            <p className="text-sm font-semibold text-gray-800">
              {totalOrders30.toLocaleString()}
            </p>
          </div>
          <div className="bg-gray-50 rounded-lg px-3 py-2 flex-1 text-center">
            <p className="text-xs text-gray-400">Days tracked</p>
            <p className="text-sm font-semibold text-gray-800">{rows.length}</p>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-left">
              <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                Date
              </th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide text-right">
                Orders
              </th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide text-right">
                AOV
              </th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide text-right">
                Revenue
              </th>
              <th className="px-4 py-3 w-32 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                {/* bar */}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-gray-400">
                  No revenue data available
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const isToday = row.date === todaySummary?.date;
                const barPct = Math.round((row.totalRevenue / maxRevenue) * 100);
                const [year, month, day] = row.date.split('-').map(Number);
                const label = new Date(year, month - 1, day).toLocaleDateString('en-US', {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                });

                return (
                  <tr
                    key={row.date}
                    className={`transition-colors ${
                      isToday
                        ? 'bg-indigo-50 hover:bg-indigo-100'
                        : 'hover:bg-gray-50'
                    }`}
                  >
                    <td className="px-4 py-3 font-medium text-gray-900">
                      {label}
                      {isToday && (
                        <span className="ml-2 text-xs font-semibold text-indigo-600 bg-indigo-100 px-1.5 py-0.5 rounded-full">
                          today
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-600">
                      {row.orderCount.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-500">
                      {formatUSD(row.aov)}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-gray-900">
                      {formatUSD(row.totalRevenue)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="w-full bg-gray-100 rounded-full h-1.5">
                        <div
                          className={`h-1.5 rounded-full ${
                            isToday ? 'bg-indigo-500' : 'bg-emerald-400'
                          }`}
                          style={{ width: `${barPct}%` }}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr className="bg-gray-50 border-t border-gray-200">
                <td className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase">
                  30-day total
                </td>
                <td className="px-4 py-3 text-right font-bold text-gray-900">
                  {totalOrders30.toLocaleString()}
                </td>
                <td className="px-4 py-3 text-right text-gray-500 text-xs">
                  avg {formatUSD(avgDaily)}/day
                </td>
                <td className="px-4 py-3 text-right font-bold text-gray-900">
                  {formatUSD(total30)}
                </td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
