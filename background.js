// ─── Tab Watch State ──────────────────────────────────────────────────────────

const watch = {
  active: false,
  resumeTabId: null,
  watchedTabId: null,
};

// ─── Messages from content script ────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'START_WATCHING_TAB':
      watch.active = true;
      watch.resumeTabId = sender.tab.id;
      watch.watchedTabId = null;
      sendResponse({ ok: true });
      break;

    case 'STOP_WATCHING_TAB':
      watch.active = false;
      watch.resumeTabId = null;
      watch.watchedTabId = null;
      sendResponse({ ok: true });
      break;

    case 'GET_WATCH_STATE':
      sendResponse({ watchedTabId: watch.watchedTabId });
      break;
  }
  return true;
});

// ─── Tab lifecycle ────────────────────────────────────────────────────────────

chrome.tabs.onCreated.addListener((tab) => {
  if (watch.active && !watch.watchedTabId) {
    watch.watchedTabId = tab.id;
    watch.active = false;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === watch.watchedTabId) {
    const resumeTabId = watch.resumeTabId;
    watch.watchedTabId = null;
    watch.resumeTabId = null;
    if (resumeTabId) {
      chrome.tabs.sendMessage(resumeTabId, { type: 'RESUME_AFTER_TAB_CLOSE' }).catch(() => {});
    }
  }
});
