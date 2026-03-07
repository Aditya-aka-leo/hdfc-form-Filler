// ─── API Hooks ────────────────────────────────────────────────────────────────
// Project-specific API response hooks.
// When a fetch/XHR response URL matches urlPattern, extractUrl() is called with
// the response body. If it returns a non-null string, that URL is automatically
// opened in a new tab — works for both recording and replay.
//
// This file runs in the MAIN world (document_start) and must be listed
// before api-tab-opener-main.js in the manifest so API_HOOKS is defined first.
//
// Add one entry per API that should trigger an automatic tab open.

// var (not const/let) so it lands on window and is visible to other scripts in MAIN world
// eslint-disable-next-line no-unused-vars
var API_HOOKS = [
  {
    // HDFC BL Assisted Journey — "Share Consent Link via SMS"
    // After the RM clicks the button, the notification API responds with a
    // customerUrl. Open it automatically so the child-tab flow (recording or
    // replay) starts without the RM having to manually copy-paste the link.
    urlPattern: '/api/sendnotification.json',
    extractUrl(body) {
      try {
        const json = JSON.parse(body);
        return json?.responseData?.notificationResponse?.customerUrl ?? null;
      } catch { return null; }
    },
  },
];

// ─── API Virtualization Patterns ──────────────────────────────────────────────
// API responses whose URLs match these patterns will be captured during
// recording and replayed during step replay (when virtualization is enabled).
// Uses the same urlPattern substring-match convention as API_HOOKS.
// Add one entry per API whose responses should be recorded and virtualized.
// var (not const/let) so it lands on window and is visible to api-tab-opener-main.js.
// eslint-disable-next-line no-unused-vars
var VIRTUAL_APIS = [
  { urlPattern: '/api/sendnotification.json' },
];
