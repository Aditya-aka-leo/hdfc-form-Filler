// ─── API Tab Opener (isolated world) ─────────────────────────────────────────
// Listens for CustomEvents fired by api-tab-opener-main.js (MAIN world) and
// opens the customer tab using chrome.tabs.create (not available in MAIN world).

window.addEventListener('__hdfc_open_tab__', e => {
  const url = e.detail?.url;
  if (!url) return;
  // Guard: chrome.runtime may be unavailable in sandboxed iframe contexts
  if (typeof chrome === 'undefined' || !chrome.runtime) return;
  chrome.runtime.sendMessage({ type: 'OPEN_TAB', url }).catch(() => {});
});
