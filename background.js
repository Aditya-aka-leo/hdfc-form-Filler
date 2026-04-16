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

// ─── Watch state — persisted so IS_CHILD_TAB survives service-worker restarts ──
// MV3 SWs can be killed after ~30s of inactivity.  Without persistence the in-memory
// `watch` object resets, causing child tabs opened during a long recording session to
// not be recognised as child tabs.

const WATCH_SESSION_KEY = 'bgWatchState'; // { watchedTabId, resumeTabId, isRecording, savedAt }

async function getWatchState() {
  const r = await chrome.storage.session.get(WATCH_SESSION_KEY).catch(() => ({}));
  return r[WATCH_SESSION_KEY] ?? null;
}
async function setWatchState(state) {
  await chrome.storage.session.set({ [WATCH_SESSION_KEY]: state }).catch(() => {});
}
async function clearWatchState() {
  await chrome.storage.session.remove(WATCH_SESSION_KEY).catch(() => {});
}

// ─── Child steps — persisted so accumulated steps survive service-worker restarts ─

const CHILD_STEPS_KEY = 'bgChildSteps'; // { [tabId]: { steps, url } }

async function getChildStepsFromSession(tabId) {
  const r = await chrome.storage.session.get(CHILD_STEPS_KEY).catch(() => ({}));
  return (r[CHILD_STEPS_KEY] || {})[String(tabId)] ?? null;
}
async function setChildStepsInSession(tabId, entry) {
  const r = await chrome.storage.session.get(CHILD_STEPS_KEY).catch(() => ({}));
  const all = r[CHILD_STEPS_KEY] || {};
  all[String(tabId)] = entry;
  await chrome.storage.session.set({ [CHILD_STEPS_KEY]: all }).catch(() => {});
}
async function deleteChildStepsFromSession(tabId) {
  const r = await chrome.storage.session.get(CHILD_STEPS_KEY).catch(() => ({}));
  const all = r[CHILD_STEPS_KEY] || {};
  delete all[String(tabId)];
  await chrome.storage.session.set({ [CHILD_STEPS_KEY]: all }).catch(() => {});
}

// ─── Child replay steps — persisted so childReplayStore survives SW restarts ───
// MV3 SW can restart between onCreated (which populates childReplayStore in memory)
// and FORM_READY on the child tab page. Without persistence, the replay steps are
// lost and the child tab gets { resume: false } — appearing to not replay at all.

const CHILD_REPLAY_STEPS_KEY = 'bgChildReplaySteps'; // { [tabId]: { steps, expectedUrl } }

async function getChildReplayStepsFromSession(tabId) {
  const r = await chrome.storage.session.get(CHILD_REPLAY_STEPS_KEY).catch(() => ({}));
  return (r[CHILD_REPLAY_STEPS_KEY] || {})[String(tabId)] ?? null;
}
async function setChildReplayStepsInSession(tabId, entry) {
  const r = await chrome.storage.session.get(CHILD_REPLAY_STEPS_KEY).catch(() => ({}));
  const all = r[CHILD_REPLAY_STEPS_KEY] || {};
  all[String(tabId)] = entry;
  await chrome.storage.session.set({ [CHILD_REPLAY_STEPS_KEY]: all }).catch(() => {});
}
async function deleteChildReplayStepsFromSession(tabId) {
  const r = await chrome.storage.session.get(CHILD_REPLAY_STEPS_KEY).catch(() => ({}));
  const all = r[CHILD_REPLAY_STEPS_KEY] || {};
  delete all[String(tabId)];
  await chrome.storage.session.set({ [CHILD_REPLAY_STEPS_KEY]: all }).catch(() => {});
}

// pendingChildReplaySteps also needs session persistence (set by SAVE_CHILD_REPLAY_STEPS,
// consumed by onCreated — if SW restarts in between, the pending steps are lost)
const PENDING_CHILD_REPLAY_KEY = 'bgPendingChildReplaySteps'; // single entry (not per-tab)

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
      await setWatchState({ watchedTabId: null, resumeTabId: sender.tab.id, isRecording: watch.isRecording, savedAt: Date.now() });
      console.log('[HDFC bg] START_WATCHING_TAB — resumeTabId:', sender.tab.id, 'isRecording:', watch.isRecording,
        '| session saved: bgWatchState = { watchedTabId: null, resumeTabId:', sender.tab.id, 'isRecording:', watch.isRecording, '}');
      return { ok: true };

    case 'STOP_WATCHING_TAB':
      watch.active = false;
      watch.resumeTabId = null;
      watch.watchedTabId = null;
      watch.isRecording = false;
      await clearWatchState();
      console.log('[HDFC bg] STOP_WATCHING_TAB — watch cleared, bgWatchState removed from session');
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
      console.log('[HDFC bg] SAVE_RESUME_STATE — tabId:', sender.tab.id,
        '| resumeFromStep:', message.resumeFromStep, '/', message.steps?.length,
        '| stopAfterIndex:', message.stopAfterIndex,
        '| expectedPath:', message.expectedPath,
        '| isChildTabReplay:', state.isChildTabReplay,
        '| session key: bgResumeStates[', sender.tab.id, ']');
      return { ok: true };
    }

    // Content script calls this after a click that did NOT navigate the page.
    case 'CLEAR_RESUME_STATE': {
      await deleteResumeState(sender.tab.id);
      console.log('[HDFC bg] CLEAR_RESUME_STATE — tabId:', sender.tab.id, '| bgResumeStates[', sender.tab.id, '] deleted');
      return { ok: true };
    }

    // Child tab pushes its recorded steps after every step via CHILD_STEP_RECORDED
    // (fired from persistRecordingState when isChildRecordingTab=true).
    // Background stores them and forwards to the parent RM tab in real-time.
    case 'CHILD_STEP_RECORDED': {
      childStepsStore[sender.tab.id] = { steps: message.steps, url: message.url };
      await setChildStepsInSession(sender.tab.id, { steps: message.steps, url: message.url });
      console.log('[HDFC bg] CHILD_STEP_RECORDED — childTabId:', sender.tab.id,
        '| steps:', message.steps?.length, '| url:', message.url,
        '| watch.resumeTabId:', watch.resumeTabId, 'watch.watchedTabId:', watch.watchedTabId,
        '| saved to bgChildSteps[', sender.tab.id, ']');
      // Restore watch state from session if SW restarted after IS_CHILD_TAB was last processed
      // (e.g. child tab navigated internally and SW was idle >30s before next CHILD_STEP_RECORDED)
      if (!watch.resumeTabId) {
        const ws = await getWatchState().catch(() => null);
        console.log('[HDFC bg] CHILD_STEP_RECORDED — watch.resumeTabId is null, checking session storage:',
          ws ? `bgWatchState = { watchedTabId: ${ws.watchedTabId}, resumeTabId: ${ws.resumeTabId}, isRecording: ${ws.isRecording}, age: ${Math.round((Date.now()-ws.savedAt)/1000)}s }` : 'null');
        if (ws?.watchedTabId === sender.tab.id && Date.now() - ws.savedAt < 10 * 60 * 1000) {
          watch.watchedTabId = ws.watchedTabId;
          watch.resumeTabId  = ws.resumeTabId;
          watch.isRecording  = ws.isRecording;
          console.log('[HDFC bg] CHILD_STEP_RECORDED — ✅ restored watch from session storage for tab', sender.tab.id,
            '| resumeTabId now:', watch.resumeTabId);
        }
      }
      if (watch.watchedTabId === sender.tab.id && watch.resumeTabId) {
        chrome.tabs.sendMessage(watch.resumeTabId, {
          type:          'RESUME_AFTER_TAB_CLOSE',
          childTabSteps: message.steps,
          childTabUrl:   message.url,
        }).catch(() => {});
        console.log('[HDFC bg] CHILD_STEP_RECORDED — ✅ forwarded', message.steps?.length, 'steps to parent tab', watch.resumeTabId);
      } else {
        console.log('[HDFC bg] CHILD_STEP_RECORDED — ⚠️ NOT forwarded to parent',
          '(watchedTabId:', watch.watchedTabId, '=== sender:', sender.tab.id, '?', watch.watchedTabId === sender.tab.id, ')',
          '(resumeTabId:', watch.resumeTabId, ')');
      }
      return { ok: true };
    }

    // Child tab signals that all replay steps have completed.
    // Background forwards RESUME_AFTER_TAB_CLOSE to the parent RM tab so its
    // waitForTabClose() resolves and the RM replay automatically continues.
    case 'CHILD_REPLAY_DONE': {
      console.log('[HDFC bg] CHILD_REPLAY_DONE — childTabId:', sender.tab.id,
        '| watch.resumeTabId:', watch.resumeTabId, 'watch.watchedTabId:', watch.watchedTabId);
      // Restore watch state from session if SW restarted during child replay
      if (!watch.resumeTabId) {
        const ws = await getWatchState().catch(() => null);
        console.log('[HDFC bg] CHILD_REPLAY_DONE — watch.resumeTabId is null, checking session storage:',
          ws ? `bgWatchState = { watchedTabId: ${ws.watchedTabId}, resumeTabId: ${ws.resumeTabId}, age: ${Math.round((Date.now()-ws.savedAt)/1000)}s }` : 'null');
        if (ws?.watchedTabId === sender.tab.id && Date.now() - ws.savedAt < 10 * 60 * 1000) {
          watch.watchedTabId = ws.watchedTabId;
          watch.resumeTabId  = ws.resumeTabId;
          console.log('[HDFC bg] CHILD_REPLAY_DONE — ✅ restored watch from session storage for tab', sender.tab.id,
            '| resumeTabId now:', watch.resumeTabId);
        }
      }
      if (watch.watchedTabId === sender.tab.id && watch.resumeTabId) {
        chrome.tabs.sendMessage(watch.resumeTabId, {
          type:          'RESUME_AFTER_TAB_CLOSE',
          childTabSteps: [],
          childTabUrl:   '',
        }).catch(() => {});
        console.log('[HDFC bg] CHILD_REPLAY_DONE — ✅ sent RESUME_AFTER_TAB_CLOSE to parent tab', watch.resumeTabId);
      } else {
        console.log('[HDFC bg] CHILD_REPLAY_DONE — ⚠️ could not forward to parent',
          '(watchedTabId:', watch.watchedTabId, 'resumeTabId:', watch.resumeTabId, ')');
      }
      return { ok: true };
    }

    // Safety-net fallback: child tab pushes steps on beforeunload (tab close).
    // Normally CHILD_STEP_RECORDED keeps the parent up-to-date, but this ensures
    // the final steps are captured even if the tab closes before the last message sends.
    case 'SAVE_CHILD_STEPS': {
      childStepsStore[sender.tab.id] = { steps: message.steps, url: message.url };
      await setChildStepsInSession(sender.tab.id, { steps: message.steps, url: message.url });
      console.log('[HDFC bg] SAVE_CHILD_STEPS (beforeunload fallback) — childTabId:', sender.tab.id,
        '| steps:', message.steps?.length, '| url:', message.url,
        '| saved to bgChildSteps[', sender.tab.id, ']');
      return { ok: true };
    }

    // Parent tab queues child replay steps BEFORE firing the click that opens the child tab.
    // Background associates them with the new tab once it's created.
    // Non-destructive check — used by content script's activation guard to bypass
    // the URL pattern filter for child tabs without consuming childReplayStore.
    case 'IS_CHILD_TAB': {
      let isChildTab = (watch.watchedTabId === sender.tab.id && watch.isRecording);
      let isChildTabReplay = !!childReplayStore[sender.tab.id];
      console.log('[HDFC bg] IS_CHILD_TAB — tabId:', sender.tab.id, 'url:', sender.tab.url,
        '\n  watch = { active:', watch.active, 'watchedTabId:', watch.watchedTabId, 'resumeTabId:', watch.resumeTabId, 'isRecording:', watch.isRecording, '}',
        '\n  childReplayStore hit:', isChildTabReplay,
        '| pendingChildReplaySteps:', !!watch.pendingChildReplaySteps,
        '\n  → initial isChildTab:', isChildTab);

      // Fallback A: onCreated may have been missed (race with STOP_WATCHING_TAB).
      // If pending steps exist, adopt this tab directly — no origin check needed since
      // the tab is opened directly at the customer form URL via API hook.
      if (!isChildTabReplay && watch.pendingChildReplaySteps) {
        childReplayStore[sender.tab.id] = watch.pendingChildReplaySteps;
        watch.pendingChildReplaySteps = null;
        watch.watchedTabId = sender.tab.id;
        isChildTabReplay = true;
        console.log('[HDFC bg] IS_CHILD_TAB fallback A — adopted tab', sender.tab.id, 'as child replay tab');
      }

      // Fallback B: subsequent pages within the same child tab after a mid-replay navigation.
      // Check resume state for isChildTabReplay flag set by earlier pages in this tab.
      if (!isChildTabReplay) {
        const resumeState = await getResumeState(sender.tab.id).catch(() => null);
        if (resumeState?.isChildTabReplay) {
          isChildTabReplay = true;
          console.log('[HDFC bg] IS_CHILD_TAB fallback B — resume state has isChildTabReplay for tab', sender.tab.id,
            '| resumeFromStep:', resumeState.resumeFromStep, '/', resumeState.steps?.length);
        } else {
          console.log('[HDFC bg] IS_CHILD_TAB fallback B — no resume state with isChildTabReplay for tab', sender.tab.id,
            '| resumeState:', resumeState ? `resumeFromStep:${resumeState.resumeFromStep} isChildTabReplay:${resumeState.isChildTabReplay}` : 'null');
        }
      }

      // Fallback C: service worker restarted — in-memory watch was reset to defaults.
      // Check session storage for the persisted watch state written by START_WATCHING_TAB / onCreated.
      if (!isChildTab) {
        const ws = await getWatchState().catch(() => null);
        console.log('[HDFC bg] IS_CHILD_TAB fallback C check — session bgWatchState:',
          ws ? `{ watchedTabId: ${ws.watchedTabId}, resumeTabId: ${ws.resumeTabId}, isRecording: ${ws.isRecording}, age: ${Math.round((Date.now()-ws.savedAt)/1000)}s }` : 'null');
        if (ws && ws.watchedTabId === sender.tab.id && ws.isRecording && Date.now() - ws.savedAt < 10 * 60 * 1000) {
          // Defense-in-depth: verify the parent tab (resumeTabId) still exists.
          // Tab IDs are recycled by Chrome, so a stale watchedTabId can match a brand-new tab.
          // If the parent is gone the watch state is from a dead session — discard it.
          let parentTabExists = false;
          if (ws.resumeTabId) {
            try { await chrome.tabs.get(ws.resumeTabId); parentTabExists = true; }
            catch { parentTabExists = false; }
          }
          if (parentTabExists) {
            watch.watchedTabId = ws.watchedTabId;
            watch.resumeTabId  = ws.resumeTabId;
            watch.isRecording  = ws.isRecording;
            isChildTab = true;
            console.log('[HDFC bg] IS_CHILD_TAB fallback C — ✅ restored watch from session storage for tab', sender.tab.id,
              '| watch.resumeTabId:', watch.resumeTabId);
          } else {
            // Stale state — clear it so it can't affect future tabs
            await clearWatchState().catch(() => {});
            console.log('[HDFC bg] IS_CHILD_TAB fallback C — ⚠️ stale bgWatchState: parent tab', ws.resumeTabId,
              'no longer exists — cleared (tab ID was probably recycled)');
          }
        }
      }

      console.log('[HDFC bg] IS_CHILD_TAB — ✅ FINAL result: isChildTab:', isChildTab, '| isChildTabReplay:', isChildTabReplay);
      return { isChildTab, isChildTabReplay };
    }

    case 'SAVE_CHILD_REPLAY_STEPS': {
      // Store steps + expected final URL so FORM_READY can skip intermediate redirect pages.
      // Also persist to session — if SW restarts between this call and onCreated (or FORM_READY),
      // the pending steps survive.
      const entry = { steps: message.steps, expectedUrl: message.expectedUrl || '' };
      watch.pendingChildReplaySteps = entry;
      await chrome.storage.session.set({ [PENDING_CHILD_REPLAY_KEY]: entry }).catch(() => {});
      console.log('[HDFC bg] SAVE_CHILD_REPLAY_STEPS — queued', message.steps?.length, 'steps for next new tab',
        '| expectedUrl:', message.expectedUrl || '(none)',
        '| persisted to session bgPendingChildReplaySteps');
      return { ok: true };
    }

    // Called by content script in activate() on every page load.
    // Background checks storage for a pending resume state for this tab.
    // Intermediate pages (Perfios etc.) get { resume: false } — state is preserved.
    case 'FORM_READY': {
      console.log('[HDFC bg] FORM_READY — tabId:', sender.tab.id, '| url:', sender.tab.url,
        '\n  watch = { watchedTabId:', watch.watchedTabId, 'resumeTabId:', watch.resumeTabId, 'isRecording:', watch.isRecording, '}');

      // Child tab in recording mode — return any steps already accumulated from previous
      // pages within this child tab so the new page can carry them forward seamlessly.
      // If the service worker restarted, restore watch state from session storage first.
      if (!watch.watchedTabId) {
        const ws = await getWatchState().catch(() => null);
        console.log('[HDFC bg] FORM_READY — watch.watchedTabId null, checking session bgWatchState:',
          ws ? `{ watchedTabId: ${ws.watchedTabId}, resumeTabId: ${ws.resumeTabId}, isRecording: ${ws.isRecording}, age: ${Math.round((Date.now()-ws.savedAt)/1000)}s }` : 'null');
        if (ws?.watchedTabId === sender.tab.id && ws.isRecording && Date.now() - ws.savedAt < 10 * 60 * 1000) {
          // Same parent-tab existence check as IS_CHILD_TAB fallback C:
          // tab IDs are recycled — confirm the parent (resumeTabId) is still alive before trusting this.
          let parentTabExists = false;
          if (ws.resumeTabId) {
            try { await chrome.tabs.get(ws.resumeTabId); parentTabExists = true; }
            catch { parentTabExists = false; }
          }
          if (parentTabExists) {
            watch.watchedTabId = ws.watchedTabId;
            watch.resumeTabId  = ws.resumeTabId;
            watch.isRecording  = ws.isRecording;
            console.log('[HDFC bg] FORM_READY — ✅ restored watch from session storage for tab', sender.tab.id);
          } else {
            await clearWatchState().catch(() => {});
            console.log('[HDFC bg] FORM_READY — ⚠️ stale bgWatchState: parent tab', ws.resumeTabId,
              'no longer exists — cleared');
          }
        }
      }
      if (watch.watchedTabId === sender.tab.id && watch.isRecording) {
        const inMemorySteps = childStepsStore[sender.tab.id]?.steps;
        const sessionEntry  = await getChildStepsFromSession(sender.tab.id).catch(() => null);
        const accumulatedSteps = inMemorySteps || sessionEntry?.steps || [];
        console.log('[HDFC bg] FORM_READY → child recording tab — accumulatedSteps:', accumulatedSteps.length,
          `(source: ${inMemorySteps ? 'in-memory childStepsStore' : sessionEntry ? 'session bgChildSteps' : 'none — starting fresh'})`);
        return { resume: false, isChildTab: true, accumulatedSteps };
      }

      // Child tab in replay mode — send it the steps to replay.
      // Fall back to session storage if SW restarted between onCreated and this FORM_READY:
      // onCreated sets childReplayStore[tabId] in memory AND persists to bgChildReplaySteps.
      // After SW restart, in-memory childReplayStore is empty but session entry survives.
      if (!childReplayStore[sender.tab.id]) {
        const sessionEntry = await getChildReplayStepsFromSession(sender.tab.id).catch(() => null);
        if (sessionEntry) {
          childReplayStore[sender.tab.id] = sessionEntry;
          console.log('[HDFC bg] FORM_READY — ✅ child replay steps recovered from session (SW restarted)',
            '| tabId:', sender.tab.id, '| steps:', sessionEntry.steps?.length);
        }
      }
      if (childReplayStore[sender.tab.id]) {
        const { steps } = childReplayStore[sender.tab.id];
        delete childReplayStore[sender.tab.id];
        // Session entry no longer needed — consumed
        await deleteChildReplayStepsFromSession(sender.tab.id).catch(() => {});
        console.log('[HDFC bg] FORM_READY → ✅ child replay tab — delivering', steps.length,
          'steps | bgChildReplaySteps[', sender.tab.id, '] deleted');
        return { isChildTabReplay: true, steps };
      }

      const state = await getResumeState(sender.tab.id);
      if (!state) {
        console.log('[HDFC bg] FORM_READY → no resume state for tab', sender.tab.id, '— returning { resume: false }');
        return { resume: false };
      }

      const expired = Date.now() - state.savedAt > 10 * 60 * 1000;
      if (expired) {
        await deleteResumeState(sender.tab.id);
        console.log('[HDFC bg] FORM_READY → resume state expired (age:', Math.round((Date.now()-state.savedAt)/1000), 's) — cleared');
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

      console.log('[HDFC bg] FORM_READY — origin check: current =', currentOrigin, '| expected =', expectedOrigin,
        '| match:', currentOrigin === expectedOrigin,
        '| resumeFromStep:', state.resumeFromStep, '/', state.steps?.length,
        '| age:', Math.round((Date.now()-state.savedAt)/1000), 's');

      // For child tab replay, skip the origin check entirely.
      // Child tabs often span multiple domains (e.g. consent-form.bank.in → ekyc.bank.in).
      // The origin check was designed for the parent RM form's Perfios redirect (parent
      // leaves and RETURNS to the same domain). Child tabs don't return — they move forward.
      // Applying the origin check here would block replay on every cross-origin child page.
      if (!state.isChildTabReplay && (!currentOrigin || currentOrigin !== expectedOrigin)) {
        // Still on an intermediate domain (e.g. Perfios) — keep state, don't resume yet
        console.log('[HDFC bg] FORM_READY → intermediate page (origin mismatch) — returning pendingState, preserving resume state');
        return { resume: false, pendingState: true, expectedPath: state.expectedPath };
      }
      if (state.isChildTabReplay && currentOrigin !== expectedOrigin) {
        console.log('[HDFC bg] FORM_READY → child tab replay cross-origin continuation — skipping origin check',
          '| current:', currentOrigin, '| expected:', expectedOrigin);
      }

      // Same origin — resume regardless of exact pathname (form may have advanced a step)
      await deleteResumeState(sender.tab.id);
      console.log('[HDFC bg] FORM_READY → ✅ same origin — resuming from step', state.resumeFromStep + 1, '/', state.steps?.length,
        '| stopAfterIndex:', state.stopAfterIndex, '| isChildTabReplay:', state.isChildTabReplay,
        '| bgResumeStates[', sender.tab.id, '] deleted');
      return { resume: true, steps: state.steps, resumeFromStep: state.resumeFromStep, stopAfterIndex: state.stopAfterIndex, isChildTabReplay: state.isChildTabReplay || false };
    }

    default:
      return { ok: false, error: 'Unknown message type' };
  }
}

// ─── Tab lifecycle ────────────────────────────────────────────────────────────

chrome.tabs.onCreated.addListener(async (tab) => {
  console.log('[HDFC bg] onCreated — tabId:', tab.id, 'url:', tab.url || '(blank)',
    '| watch.active:', watch.active, 'watch.watchedTabId:', watch.watchedTabId,
    '| pendingChildReplaySteps:', !!watch.pendingChildReplaySteps);
  if (watch.active && !watch.watchedTabId) {
    watch.watchedTabId = tab.id;
    watch.active = false;
    // Persist the new watchedTabId to session storage so IS_CHILD_TAB can recover after SW restart
    const ws = await getWatchState().catch(() => null);
    if (ws) {
      await setWatchState({ ...ws, watchedTabId: tab.id });
      console.log('[HDFC bg] onCreated — ✅ bgWatchState updated: watchedTabId =', tab.id, '(was null)');
    } else {
      console.log('[HDFC bg] onCreated — ⚠️ bgWatchState not in session (START_WATCHING_TAB may not have run yet)');
    }
    // If child replay steps were queued, associate them with this new tab.
    // If SW restarted after SAVE_CHILD_REPLAY_STEPS but before onCreated, fall back to session.
    let pendingEntry = watch.pendingChildReplaySteps;
    if (!pendingEntry) {
      const r = await chrome.storage.session.get(PENDING_CHILD_REPLAY_KEY).catch(() => ({}));
      pendingEntry = r[PENDING_CHILD_REPLAY_KEY] ?? null;
      if (pendingEntry) {
        console.log('[HDFC bg] onCreated — ✅ recovered pendingChildReplaySteps from session storage (SW restarted)');
      }
    }
    if (pendingEntry) {
      childReplayStore[tab.id] = pendingEntry;
      watch.pendingChildReplaySteps = null;
      // Clear the global pending key from session — it has been assigned to a specific tab
      await chrome.storage.session.remove(PENDING_CHILD_REPLAY_KEY).catch(() => {});
      // Persist the tab-specific entry so FORM_READY can recover it if SW restarts again
      await setChildReplayStepsInSession(tab.id, pendingEntry);
      console.log('[HDFC bg] onCreated — ✅ assigned childReplayStore for tab', tab.id,
        '| steps:', pendingEntry.steps?.length, '| persisted to bgChildReplaySteps[', tab.id, ']');
    } else {
      console.log('[HDFC bg] onCreated — watched tab set, no pending replay steps (recording mode)');
    }
  } else {
    console.log('[HDFC bg] onCreated — ignored (watch.active:', watch.active, 'watchedTabId already:', watch.watchedTabId, ')');
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  console.log('[HDFC bg] onRemoved — tabId:', tabId,
    '| watch = { watchedTabId:', watch.watchedTabId, 'resumeTabId:', watch.resumeTabId, 'isRecording:', watch.isRecording, '}');

  // If the service worker restarted after the child tab was opened, watch is empty.
  // Fall back to session storage so we can still notify the parent RM tab.
  let effectiveWatchedTabId = watch.watchedTabId;
  let effectiveResumeTabId  = watch.resumeTabId;
  if (effectiveWatchedTabId !== tabId) {
    const ws = await getWatchState().catch(() => null);
    console.log('[HDFC bg] onRemoved — watch mismatch, checking session bgWatchState:',
      ws ? `{ watchedTabId: ${ws.watchedTabId}, resumeTabId: ${ws.resumeTabId}, age: ${Math.round((Date.now()-ws.savedAt)/1000)}s }` : 'null');
    if (ws?.watchedTabId === tabId && Date.now() - ws.savedAt < 10 * 60 * 1000) {
      effectiveWatchedTabId = ws.watchedTabId;
      effectiveResumeTabId  = ws.resumeTabId;
      console.log('[HDFC bg] onRemoved — ✅ restored watch from session storage for tab', tabId,
        '| effectiveResumeTabId:', effectiveResumeTabId);
    }
  }

  if (tabId === effectiveWatchedTabId) {
    // Collect child steps — fall back to session storage if SW restarted and in-memory store is empty
    const inMemoryEntry  = childStepsStore[tabId] || null;
    const sessionEntry   = inMemoryEntry ? null : await getChildStepsFromSession(tabId).catch(() => null);
    const childEntry     = inMemoryEntry || sessionEntry;
    const stepSource     = inMemoryEntry ? 'in-memory childStepsStore' : sessionEntry ? 'session bgChildSteps' : 'none';
    console.log('[HDFC bg] onRemoved — ✅ watched tab closed',
      '| childSteps:', childEntry?.steps?.length ?? 0, `(source: ${stepSource})`,
      '| notifying resumeTabId:', effectiveResumeTabId);
    delete childStepsStore[tabId];
    watch.watchedTabId = null;
    watch.resumeTabId  = null;
    watch.isRecording  = false;
    // Clean up any child replay store entry for this tab (prevents memory leak)
    delete childReplayStore[tabId];
    // Clear persisted watch + child steps + child replay steps state
    await clearWatchState().catch(() => {});
    await deleteChildStepsFromSession(tabId).catch(() => {});
    await deleteChildReplayStepsFromSession(tabId).catch(() => {});
    console.log('[HDFC bg] onRemoved — bgWatchState + bgChildSteps[', tabId, '] + bgChildReplaySteps[', tabId, '] cleared from session');
    if (effectiveResumeTabId) {
      chrome.tabs.sendMessage(effectiveResumeTabId, {
        type: 'RESUME_AFTER_TAB_CLOSE',
        childTabSteps: childEntry?.steps || [],
        childTabUrl:   childEntry?.url   || '',
      }).catch(() => {});
      console.log('[HDFC bg] onRemoved — ✅ RESUME_AFTER_TAB_CLOSE sent to parent tab', effectiveResumeTabId,
        'with', childEntry?.steps?.length ?? 0, 'child steps');
    } else {
      console.log('[HDFC bg] onRemoved — ⚠️ no resumeTabId — parent was not notified');
    }
  } else {
    // Check if the removed tab was the PARENT (resumeTabId). If so, the watch session
    // is orphaned — the child tab can no longer report to anyone. Clear it so the stale
    // watchedTabId doesn't get recycled and mis-identify a future tab as a child tab.
    const effectiveResumeTabIdForCheck = watch.resumeTabId ||
      (await getWatchState().catch(() => null))?.resumeTabId;
    if (tabId === effectiveResumeTabIdForCheck) {
      watch.watchedTabId = null;
      watch.resumeTabId  = null;
      watch.isRecording  = false;
      await clearWatchState().catch(() => {});
      console.log('[HDFC bg] onRemoved — ⚠️ parent (resumeTab', tabId, ') removed — bgWatchState cleared to prevent stale watchedTabId recycling');
    } else {
      console.log('[HDFC bg] onRemoved — tab', tabId, 'was not a watched child tab or parent tab, ignoring');
    }
  }
});
