import { ReactNode } from 'react';

interface KpiCardProps {
  label: string;
  value: string;
  subLabel?: string;
  /** true = green delta, false = red delta, undefined = neutral */
  deltaPositive?: boolean;
  /** Highlight card border red */
  highlight?: boolean;
  /** Lucide icon element */
  icon?: ReactNode;
  /** Left border accent color class e.g. 'border-accent-primary' */
  accentColor?: string;
  /** Optional sparkline or extra content below value */
  extra?: ReactNode;
}

export default function KpiCard({
  label,
  value,
  subLabel,
  deltaPositive,
  highlight = false,
  icon,
  accentColor = 'border-accent-primary',
  extra,
}: KpiCardProps) {
  const subLabelColor =
    deltaPositive === true
      ? 'text-accent-emerald font-medium'
      : deltaPositive === false
      ? 'text-accent-red font-medium'
      : 'text-gray-400 dark:text-text-muted';

  return (
    <div
      className={[
        'bg-white/80 dark:bg-surface-card/85 backdrop-blur-md rounded-2xl border p-5 flex flex-col gap-1',
        'border-l-4 shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all duration-300 ease-out',
        highlight
          ? 'border-gray-100 dark:border-surface-border border-l-accent-red'
          : `border-gray-100 dark:border-surface-border ${accentColor}`,
      ].join(' ')}
    >
      {/* Top row: icon + label */}
      <div className="flex items-center gap-2">
        {icon && (
          <span className="text-gray-400 dark:text-text-muted">{icon}</span>
        )}
        <span className="text-xs font-semibold text-gray-500 dark:text-text-muted uppercase tracking-wider">
          {label}
        </span>
      </div>

      {/* Main value */}
      <span
        className={[
          'text-3xl font-bold tabular-nums mt-1',
          highlight
            ? 'text-accent-red'
            : 'text-gray-900 dark:text-text-primary',
        ].join(' ')}
      >
        {value}
      </span>

      {/* Delta / sub-label */}
      {subLabel && (
        <span className={`text-xs mt-0.5 ${subLabelColor}`}>
          {deltaPositive === true && '↑ '}
          {deltaPositive === false && '↓ '}
          {subLabel}
        </span>
      )}

      {/* Extra content (sparkline etc.) */}
      {extra && <div className="mt-2">{extra}</div>}
    </div>
  );
}
