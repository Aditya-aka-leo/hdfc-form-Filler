// ─── Tab Watch State ──────────────────────────────────────────────────────────

const watch = {
  active: false,
  resumeTabId: null,
  watchedTabId: null,
};

// ─── Per-tab replay resume state ──────────────────────────────────────────────
// Persisted in chrome.storage.session so it survives MV3 service-worker restarts
// (the worker can be killed after ~30s of inactivity — Perfios takes minutes).
// Only background.js reads/writes this key; content scripts never touch it.

const SESSION_KEY = 'bgResumeStates'; // { [tabId]: { steps, resumeFromStep, stopAfterIndex, expectedPath, savedAt } }

async function getResumeState(tabId) {
  const result = await chrome.storage.session.get(SESSION_KEY).catch(() => ({}));
  return (result[SESSION_KEY] || {})[tabId] ?? null;
}

async function setResumeState(tabId, state) {
  const result = await chrome.storage.session.get(SESSION_KEY).catch(() => ({}));
  const all = result[SESSION_KEY] || {};
  all[tabId] = state;
  await chrome.storage.session.set({ [SESSION_KEY]: all }).catch(() => {});
}

async function deleteResumeState(tabId) {
  const result = await chrome.storage.session.get(SESSION_KEY).catch(() => ({}));
  const all = result[SESSION_KEY] || {};
  delete all[tabId];
  await chrome.storage.session.set({ [SESSION_KEY]: all }).catch(() => {});
}

// ─── Messages from content script ────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch(() => sendResponse({ ok: false }));
  return true; // keep channel open for async response
});

async function handleMessage(message, sender) {
  switch (message.type) {

    case 'START_WATCHING_TAB':
      watch.active = true;
      watch.resumeTabId = sender.tab.id;
      watch.watchedTabId = null;
      return { ok: true };

    case 'STOP_WATCHING_TAB':
      watch.active = false;
      watch.resumeTabId = null;
      watch.watchedTabId = null;
      return { ok: true };

    case 'GET_WATCH_STATE':
      return { watchedTabId: watch.watchedTabId };

    // Content script calls this before firing a click that may navigate the page.
    // State is written to chrome.storage.session so it survives service-worker restarts.
    case 'SAVE_RESUME_STATE': {
      const state = {
        steps:          message.steps,
        resumeFromStep: message.resumeFromStep,
        stopAfterIndex: message.stopAfterIndex,
        expectedPath:   message.expectedPath,
        savedAt:        Date.now(),
      };
      await setResumeState(sender.tab.id, state);
      return { ok: true };
    }

    // Content script calls this after a click that did NOT navigate the page.
    case 'CLEAR_RESUME_STATE': {
      await deleteResumeState(sender.tab.id);
      return { ok: true };
    }

    // Called by content script in activate() on every page load.
    // Background checks storage for a pending resume state for this tab.
    // Intermediate pages (Perfios etc.) get { resume: false } — state is preserved.
    case 'FORM_READY': {
      const state = await getResumeState(sender.tab.id);
      if (!state) return { resume: false };

      const expired = Date.now() - state.savedAt > 10 * 60 * 1000;
      if (expired) {
        await deleteResumeState(sender.tab.id);
        return { resume: false };
      }

      // Compare origins only — after a redirect (e.g. Perfios) the form may advance
      // to a new pathname. As long as we're back on the same domain, resume replay.
      let currentOrigin;
      try { currentOrigin = new URL(sender.tab.url).origin; }
      catch { currentOrigin = ''; }

      let expectedOrigin;
      try { expectedOrigin = new URL(state.expectedPath).origin; }
      catch { expectedOrigin = ''; }

      if (!currentOrigin || currentOrigin !== expectedOrigin) {
        // Still on an intermediate domain (e.g. Perfios) — keep state, don't resume yet
        return { resume: false, pendingState: true, expectedPath: state.expectedPath };
      }

      // Same origin — resume regardless of exact pathname (form may have advanced a step)
      await deleteResumeState(sender.tab.id);
      return { resume: true, steps: state.steps, resumeFromStep: state.resumeFromStep, stopAfterIndex: state.stopAfterIndex };
    }

    default:
      return { ok: false, error: 'Unknown message type' };
  }
}

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
