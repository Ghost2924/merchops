export const ORG_SYNC_RELOAD_KEY = 'clerk_org_sync_reload';

export function clearOrgSyncReloadFlag() {
  try {
    sessionStorage.removeItem(ORG_SYNC_RELOAD_KEY);
  } catch {
    // ignore
  }
}

export function reloadAfterOrgChange(path = '/dashboard') {
  clearOrgSyncReloadFlag();
  window.location.assign(path);
}
