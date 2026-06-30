export async function fetchOrders(
  startDate: string,
  endDate: string
): Promise<string> {
  const accountName = process.env.TEAPPLIX_ACCOUNT_NAME;
  const user = process.env.TEAPPLIX_USER;
  const passwd = process.env.TEAPPLIX_PASSWORD;

  if (!accountName || !user || !passwd) {
    throw new Error('Missing TEAPPLIX_ACCOUNT_NAME, TEAPPLIX_USER, or TEAPPLIX_PASSWORD env vars');
  }

  const url = new URL(
    `https://app.teapplix.com/h/${encodeURIComponent(accountName)}/ea/admin.php`
  );
  url.searchParams.set('Action', 'Report');
  url.searchParams.set('Subaction', 'OrderRun');
  url.searchParams.set('combine', 'all');
  url.searchParams.set('start_date', startDate);
  url.searchParams.set('end_date', endDate);
  url.searchParams.set('User', user);
  url.searchParams.set('Passwd', passwd);

  // Debug: log URL with masked password
  console.log('[TeapplixClient] URL:', url.toString().replace(passwd, '***'));

  const res = await fetch(url.toString(), { method: 'GET', cache: 'no-store' });

  if (!res.ok) {
    const body = await res.text();
    // Log server-side only — do not expose to client
    console.error(`[TeapplixClient] HTTP ${res.status}: ${body}`);
    throw new Error(`Teapplix API returned ${res.status}`);
  }

  return res.text();
}
