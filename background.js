// ─── Tab Watch State ──────────────────────────────────────────────────────────

const watch = {
  active: false,
  resumeTabId: null,
  watchedTabId: null,
  isRecording: false,           // true when watching on behalf of recording (not replay)
  pendingChildReplaySteps: null, // steps to replay in next-opened child tab
};

// ─── Child Tab Step Stores ────────────────────────────────────────────────────
// childStepsStore: steps pushed by child tabs before they close (recording)
// childReplayStore: steps queued to replay in a specific child tab (replay)

const childStepsStore = {};  // { [tabId]: { steps, url } }
const childReplayStore = {}; // { [tabId]: { steps, expectedUrl } }

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

    case 'OPEN_TAB': {
      const newTab = await chrome.tabs.create({ url: message.url });
      console.log('[HDFC bg] OPEN_TAB: opened tab', newTab.id, '→', message.url);
      return { ok: true, tabId: newTab.id };
    }

    case 'START_WATCHING_TAB':
      watch.active = true;
      watch.resumeTabId = sender.tab.id;
      watch.watchedTabId = null;
      watch.isRecording = message.isRecording ?? false;
      return { ok: true };

    case 'STOP_WATCHING_TAB':
      watch.active = false;
      watch.resumeTabId = null;
      watch.watchedTabId = null;
      watch.isRecording = false;
      return { ok: true };

    case 'GET_WATCH_STATE':
      return { watchedTabId: watch.watchedTabId };

    // Content script calls this before firing a click that may navigate the page.
    // State is written to chrome.storage.session so it survives service-worker restarts.
    case 'SAVE_RESUME_STATE': {
      const state = {
        steps:            message.steps,
        resumeFromStep:   message.resumeFromStep,
        stopAfterIndex:   message.stopAfterIndex,
        expectedPath:     message.expectedPath,
        isChildTabReplay: message.isChildTabReplay || false, // true when saved inside a child tab replay
        savedAt:          Date.now(),
      };
      await setResumeState(sender.tab.id, state);
      return { ok: true };
    }

    // Content script calls this after a click that did NOT navigate the page.
    case 'CLEAR_RESUME_STATE': {
      await deleteResumeState(sender.tab.id);
      return { ok: true };
    }

    // Child tab pushes its recorded steps after every step via CHILD_STEP_RECORDED
    // (fired from persistRecordingState when isChildRecordingTab=true).
    // Background stores them and forwards to the parent RM tab in real-time.
    case 'CHILD_STEP_RECORDED': {
      childStepsStore[sender.tab.id] = { steps: message.steps, url: message.url };
      if (watch.watchedTabId === sender.tab.id && watch.resumeTabId) {
        chrome.tabs.sendMessage(watch.resumeTabId, {
          type:          'RESUME_AFTER_TAB_CLOSE',
          childTabSteps: message.steps,
          childTabUrl:   message.url,
        }).catch(() => {});
      }
      return { ok: true };
    }

    // Child tab signals that all replay steps have completed.
    // Background forwards RESUME_AFTER_TAB_CLOSE to the parent RM tab so its
    // waitForTabClose() resolves and the RM replay automatically continues.
    case 'CHILD_REPLAY_DONE': {
      if (watch.watchedTabId === sender.tab.id && watch.resumeTabId) {
        chrome.tabs.sendMessage(watch.resumeTabId, {
          type:          'RESUME_AFTER_TAB_CLOSE',
          childTabSteps: [],
          childTabUrl:   '',
        }).catch(() => {});
      }
      return { ok: true };
    }

    // Safety-net fallback: child tab pushes steps on beforeunload (tab close).
    // Normally CHILD_STEP_RECORDED keeps the parent up-to-date, but this ensures
    // the final steps are captured even if the tab closes before the last message sends.
    case 'SAVE_CHILD_STEPS': {
      childStepsStore[sender.tab.id] = { steps: message.steps, url: message.url };
      return { ok: true };
    }

    // Parent tab queues child replay steps BEFORE firing the click that opens the child tab.
    // Background associates them with the new tab once it's created.
    // Non-destructive check — used by content script's activation guard to bypass
    // the URL pattern filter for child tabs without consuming childReplayStore.
    case 'IS_CHILD_TAB': {
      const isChildTab = (watch.watchedTabId === sender.tab.id && watch.isRecording);
      let isChildTabReplay = !!childReplayStore[sender.tab.id];
      console.log('[HDFC bg] IS_CHILD_TAB — tabId:', sender.tab.id, 'url:', sender.tab.url,
        '| watchedTabId:', watch.watchedTabId, 'isRecording:', watch.isRecording,
        '| childReplayStore hit:', isChildTabReplay,
        '| pendingChildReplaySteps:', !!watch.pendingChildReplaySteps);

      // Fallback A: onCreated may have been missed (hdfc:// redirect is slow and
      // STOP_WATCHING_TAB from a later RM step ran first) or may have captured the wrong
      // intermediate tab. If pending steps exist and this page's origin matches the
      // expected customer-form origin, adopt this tab directly without waiting for onCreated.
      if (!isChildTabReplay && watch.pendingChildReplaySteps) {
        let currentOrigin = '', expectedOrigin = '';
        try { currentOrigin = new URL(sender.tab.url).origin; } catch { /* ignore */ }
        try { expectedOrigin = new URL(watch.pendingChildReplaySteps.expectedUrl).origin; } catch { /* ignore */ }
        console.log('[HDFC bg] IS_CHILD_TAB fallback A — currentOrigin:', currentOrigin, 'expectedOrigin:', expectedOrigin);
        if (currentOrigin && expectedOrigin && currentOrigin === expectedOrigin) {
          childReplayStore[sender.tab.id] = watch.pendingChildReplaySteps;
          watch.pendingChildReplaySteps = null;
          watch.watchedTabId = sender.tab.id;
          isChildTabReplay = true;
          console.log('[HDFC bg] IS_CHILD_TAB fallback A — adopted tab', sender.tab.id, 'as child replay tab');
        } else {
          console.log('[HDFC bg] IS_CHILD_TAB fallback A — origin mismatch, not adopting');
        }
      }

      // Fallback B: subsequent pages within the same child tab after a mid-replay navigation.
      // Check resume state for isChildTabReplay flag set by earlier pages in this tab.
      if (!isChildTabReplay) {
        const resumeState = await getResumeState(sender.tab.id).catch(() => null);
        if (resumeState?.isChildTabReplay) {
          isChildTabReplay = true;
          console.log('[HDFC bg] IS_CHILD_TAB fallback B — resume state has isChildTabReplay for tab', sender.tab.id);
        }
      }

      console.log('[HDFC bg] IS_CHILD_TAB — result: isChildTab:', isChildTab, 'isChildTabReplay:', isChildTabReplay);
      return { isChildTab, isChildTabReplay };
    }

    case 'SAVE_CHILD_REPLAY_STEPS': {
      // Store steps + expected final URL so FORM_READY can skip intermediate redirect pages
      watch.pendingChildReplaySteps = { steps: message.steps, expectedUrl: message.expectedUrl || '' };
      return { ok: true };
    }

    // Called by content script in activate() on every page load.
    // Background checks storage for a pending resume state for this tab.
    // Intermediate pages (Perfios etc.) get { resume: false } — state is preserved.
    case 'FORM_READY': {
      // Child tab in recording mode — return any steps already accumulated from previous
      // pages within this child tab so the new page can carry them forward seamlessly.
      if (watch.watchedTabId === sender.tab.id && watch.isRecording) {
        const accumulatedSteps = childStepsStore[sender.tab.id]?.steps || [];
        return { resume: false, isChildTab: true, accumulatedSteps };
      }

      // Child tab in replay mode — send it the steps to replay.
      // If the step has a known final URL, check if we're on an intermediate redirect page
      // (e.g. hdfc:// → https://same-origin/redirect → https://same-origin/customer-form).
      // Compare both origin AND pathname — the hdfc:// deep link may redirect through an
      // intermediate page on the SAME origin as the final customer form, so origin alone is
      // not sufficient to detect intermediate pages.
      if (childReplayStore[sender.tab.id]) {
        const entry = childReplayStore[sender.tab.id];
        const { steps, expectedUrl } = entry;

        if (expectedUrl) {
          let currentOrigin = '', expectedOrigin = '';
          let currentPath = '', expectedPath = '';
          try { const u = new URL(sender.tab.url); currentOrigin = u.origin; currentPath = u.pathname; } catch { /* ignore */ }
          try { const u = new URL(expectedUrl);    expectedOrigin = u.origin; expectedPath = u.pathname; } catch { /* ignore */ }

          const differentOrigin = currentOrigin && expectedOrigin && currentOrigin !== expectedOrigin;
          const sameOriginDifferentPath = currentOrigin && expectedOrigin && currentOrigin === expectedOrigin
            && currentPath && expectedPath && currentPath !== expectedPath;

          if (differentOrigin || sameOriginDifferentPath) {
            // Intermediate redirect page — keep store, signal content script to wait.
            // Next FORM_READY on the final page will get the real steps.
            return { isChildTabReplay: true, steps: [], isIntermediate: true };
          }
        }

        delete childReplayStore[sender.tab.id];
        return { isChildTabReplay: true, steps };
      }

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
      return { resume: true, steps: state.steps, resumeFromStep: state.resumeFromStep, stopAfterIndex: state.stopAfterIndex, isChildTabReplay: state.isChildTabReplay || false };
    }

    default:
      return { ok: false, error: 'Unknown message type' };
  }
}

// ─── Tab lifecycle ────────────────────────────────────────────────────────────

chrome.tabs.onCreated.addListener((tab) => {
  console.log('[HDFC bg] onCreated — tabId:', tab.id, 'url:', tab.url || '(blank)',
    '| watch.active:', watch.active, 'watch.watchedTabId:', watch.watchedTabId,
    '| pendingChildReplaySteps:', !!watch.pendingChildReplaySteps);
  if (watch.active && !watch.watchedTabId) {
    watch.watchedTabId = tab.id;
    watch.active = false;
    // If child replay steps were queued, associate them with this new tab
    if (watch.pendingChildReplaySteps) {
      childReplayStore[tab.id] = watch.pendingChildReplaySteps;
      watch.pendingChildReplaySteps = null;
      console.log('[HDFC bg] onCreated — assigned childReplayStore for tab', tab.id);
    } else {
      console.log('[HDFC bg] onCreated — watched tab set but no pendingChildReplaySteps');
    }
  } else {
    console.log('[HDFC bg] onCreated — ignored (watch.active:', watch.active, 'watchedTabId already:', watch.watchedTabId, ')');
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === watch.watchedTabId) {
    const resumeTabId = watch.resumeTabId;
    // Collect any child steps the closing tab pushed via SAVE_CHILD_STEPS
    const childEntry = childStepsStore[tabId] || null;
    delete childStepsStore[tabId];
    watch.watchedTabId = null;
    watch.resumeTabId = null;
    watch.isRecording = false;
    if (resumeTabId) {
      chrome.tabs.sendMessage(resumeTabId, {
        type: 'RESUME_AFTER_TAB_CLOSE',
        childTabSteps: childEntry?.steps || [],
        childTabUrl:   childEntry?.url   || '',
      }).catch(() => {});
    }
  }
});
