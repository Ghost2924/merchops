/**
 * Format a number as USD currency string.
 * Returns "—" for null/undefined values (e.g. when today's data is missing).
 */
export function formatUSD(value: number | null | undefined): string {
  if (value == null) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/**
 * Format a number as a plain integer string.
 * Returns "—" for null/undefined values.
 */
export function formatCount(value: number | null | undefined): string {
  if (value == null) return '—';
  return new Intl.NumberFormat('en-US').format(value);
}
