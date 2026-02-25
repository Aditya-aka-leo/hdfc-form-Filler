// ─── Skip Config ─────────────────────────────────────────────────────────────
// Elements listed here will be ignored during both recording and replay.
// Each entry can match by any combination of: name, text, tag, id.
// A button is skipped if ALL specified fields in an entry match.

// eslint-disable-next-line no-unused-vars
const SKIP_CLICKS = [
  // Dashboard refresh button — always visible, should never be auto-clicked
  { name: 'dashboardRefreshCTA' },
];
