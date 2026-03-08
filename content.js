// ─── State ───────────────────────────────────────────────────────────────────
const recordedData = {};
const recordedSteps = [];
let replayData = null;
let replayObserver = null;
let fillInProgress = false;
let pendingFill = false;
let stepReplayActive = false;
let isChildRecordingTab = false; // true when this tab is a child being recorded
let isChildReplayTab   = false; // true when this tab is a child being replayed (survives cross-page resumes)
let lastApiError = false;
let pendingMarkRedirect = null; // tracks the one click whose beforeunload listener is still active
let isReplayFilling = false;          // true only while dispatchEvents() is running
const userModifiedDuringReplay = new Set(); // field names the user manually touched during replay
const replayTargetValues = new Map(); // fieldName → value the replay last set
const lastRecordedFillValue = new Map(); // fieldName → last value written into recordedSteps (dedup across non-consecutive steps)

// ─── Logger ───────────────────────────────────────────────────────────────────

const log = {
  info:  (...args) => console.log('[HDFC]', ...args),
  warn:  (...args) => console.log('[HDFC] WARN', ...args),
  group: (label)   => console.groupCollapsed(`[HDFC] ${label}`),
  end:   ()        => console.groupEnd(),
};

/** Resolves once there are no in-flight fetch/XHR requests.
 *  The page's actual fetch/XHR calls are intercepted by api-tab-opener-main.js
 *  (MAIN world) which sets data-hdfc-pending on <html> while requests are active.
 *  Isolated-world fetch overrides don't reach the page's own calls, so we read
 *  the DOM attribute instead of counting locally. */
function waitForNetwork() {
  return new Promise(resolve => {
    const isPending = () => document.documentElement.hasAttribute('data-hdfc-pending');
    if (!isPending()) return resolve();
    const id = setInterval(() => {
      if (!isPending()) { clearInterval(id); resolve(); }
    }, 20);
  });
}


// ─── Helpers ─────────────────────────────────────────────────────────────────

function storageKey() {
  return `journey_${window.location.pathname}`;
}

/** Returns true if el or any ancestor is visually hidden (display:none, visibility:hidden, or data-visible="false") */
function isHidden(el) {
  // Fast check: AEM's data-visible attribute on self or ancestor
  if (el.dataset && el.dataset.visible === 'false') return true;
  // CSS check: walk up the tree looking for display:none or visibility:hidden
  let node = el;
  while (node && node !== document.documentElement) {
    if (node.dataset && node.dataset.visible === 'false') return true;
    const s = window.getComputedStyle(node);
    if (s.display === 'none' || s.visibility === 'hidden') return true;
    node = node.parentElement;
  }
  return false;
}

/** Returns true if this field should be skipped entirely */
function shouldSkip(input) {
  const name = input.name || '';
  if (!name) return true;
  if (name.startsWith('hidden')) return true;
  if (input.readOnly) return true;
  if (input.disabled) return true;
  return false;
}

/** Returns true if a click element matches any entry in SKIP_CLICKS */
function shouldSkipClick(el) {
  const normalize = t => (t || '').replace(/\s+/g, ' ').trim();
  const elText = normalize(el.textContent || el.value || '');
  return (typeof SKIP_CLICKS !== 'undefined' ? SKIP_CLICKS : []).some(rule => {
    if (rule.name && rule.name !== (el.name || '')) return false;
    if (rule.text && rule.text !== elText) return false;
    if (rule.tag  && rule.tag  !== el.tagName.toLowerCase()) return false;
    if (rule.id   && rule.id   !== el.id) return false;
    return true;
  });
}

/** Dispatch input + change so the rule engine re-evaluates */
function dispatchEvents(el) {
  isReplayFilling = true;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  isReplayFilling = false;
}

/**
 * Types text into an input one character at a time using execCommand('insertText').
 * Each character fires a trusted InputEvent (isTrusted=true), which is required for
 * Angular typeahead/autocomplete components that ignore synthetic events.
 */
async function typeCharByChar(el, text) {
  el.focus();
  // Clear any existing value first
  if (el.value) {
    el.setSelectionRange?.(0, el.value.length);
    document.execCommand('selectAll', false);
    document.execCommand('delete', false);
  }
  for (const char of String(text)) {
    document.execCommand('insertText', false, char);
    await new Promise(r => setTimeout(r, 40));
  }
}

/**
 * Waits for a dropdown overlay option (mat-option, [role="option"]) whose text or
 * data-value matches target. Used after typeCharByChar triggers the search API.
 */
function waitForDropdownOption(target) {
  const t = String(target);
  const TIMEOUT_MS = 5_000;
  const SELECTORS = [
    '.dropdown-option',                                        // dynamic-dropdown-wrapper (HDFC custom)
    '[role="option"]', 'mat-option', '.mat-option',
    '.dropdown-item', '.ng-option', 'li[role="option"]',
    '[role="listbox"] li', '[role="listbox"] > *',
    '.cdk-overlay-container li', '.cdk-overlay-container [role="option"]',
    '.mat-autocomplete-panel li', '.mat-autocomplete-panel mat-option',
    '.autocomplete-option', '.suggestion-item',
    'ul.dropdown-menu li', 'li.ui-autocomplete-item',
  ].join(', ');
  const find = () => Array.from(document.querySelectorAll(SELECTORS)).find(el => {
    if (isHidden(el)) return false; // skip options inside hidden dropdown containers
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    return text === t || text.includes(t) || el.getAttribute('data-value') === t;
  });
  return new Promise(resolve => {
    const el = find();
    if (el) return resolve(el);
    const start = Date.now();
    const id = setInterval(() => {
      if (!stepReplayActive) { clearInterval(id); return resolve(null); }
      const el = find();
      if (el) { clearInterval(id); log.info(`waitForDropdownOption: found "${t}"`); return resolve(el); }
      if (Date.now() - start >= TIMEOUT_MS) {
        clearInterval(id);
        // Show every leaf element in the DOM that contains the target text
        const withTarget = Array.from(document.querySelectorAll('*'))
          .filter(el => el.children.length === 0 && (el.textContent || '').includes(t))
          .slice(0, 5)
          .map(el => `<${el.tagName.toLowerCase()} class="${el.className}"> "${(el.textContent||'').trim().slice(0,60)}" (parent: <${el.parentElement?.tagName?.toLowerCase()} class="${el.parentElement?.className}">)`);
        log.warn(`waitForDropdownOption: timed out for "${t}".\nDOM elements containing target:\n${withTarget.join('\n') || '(none — option not in DOM yet)'}`);
        return resolve(null);
      }
    }, 100);
  });
}

// ─── Recording ───────────────────────────────────────────────────────────────

function handleInputChange(e) {
  const input = e.target;
  if (!(input instanceof HTMLInputElement || input instanceof HTMLSelectElement || input instanceof HTMLTextAreaElement)) return;
  if (shouldSkip(input)) return;

  const type = input.type.toLowerCase();

  if (type === 'radio' || type === 'checkbox') {
    recordedData[input.name] = input.checked;
  } else {
    recordedData[input.name] = input.value;
  }
  persistRecordingState();
}

// Persist recording state to window.localStorage so it survives same-tab
// navigation (e.g. Perfios redirect). localStorage is per-origin, synchronous,
// and always accessible from content scripts — no extension API needed.
// The Perfios page (different origin) cannot read or modify it.
const LS_KEY = '__hdfc_ext_recording__';
function persistRecordingState() {
  if (stepReplayActive) return; // don't overwrite during replay
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify({
      data:     { ...recordedData },
      steps:    [...recordedSteps],
      pathname: window.location.origin + window.location.pathname,
      savedAt:  Date.now(),
    }));
  } catch { /* storage full or unavailable — ignore */ }

  // If this is a child recording tab, push the latest steps to background after every step.
  // Background immediately forwards them to the parent RM tab so it stays up-to-date
  // without depending on tab switching or closing events.
  if (isChildRecordingTab) {
    chrome.runtime.sendMessage({
      type:  'CHILD_STEP_RECORDED',
      steps: [...recordedSteps],
      url:   window.location.href,
    }).catch(() => {});
  }
}

// ─── Activation Guard ────────────────────────────────────────────────────────
// Only attach listeners and intercept network if current page matches allowed patterns.
// If no patterns are configured, activate everywhere (default behaviour).
chrome.storage.local.get('allowedPatterns').then(async ({ allowedPatterns }) => {
  if (allowedPatterns && allowedPatterns.length > 0) {
    const href = window.location.href;
    const allowed = allowedPatterns.some(p => href.startsWith(p.replace(/\*$/, '')));
    if (!allowed) {
      // URL doesn't match — but check if background flagged this as a child tab
      // (recording or replay). If so, activate anyway regardless of URL filter.
      const check = await chrome.runtime.sendMessage({ type: 'IS_CHILD_TAB' }).catch(() => ({}));
      if (!check.isChildTab && !check.isChildTabReplay) {
        log.info('Skipping — page not in allowed URL list');
        return;
      }
      log.info('Child tab detected — activating despite URL filter');
    }
  }
  activate();
});

// Synchronously restore recording state BEFORE activating listeners
// This prevents form change events from firing before old steps are restored
function restoreRecordingStateSync() {
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    if (!raw) return;
    // On a hard reload, clear saved state — only restore on redirect/navigation
    const navType = performance.getEntriesByType('navigation')[0]?.type;
    if (navType === 'reload') {
      window.localStorage.removeItem(LS_KEY);
      log.info('recording restore: page reloaded — cleared state');
      return;
    }
    const { data, steps, savedAt } = JSON.parse(raw);
    const expired = Date.now() - savedAt > 2 * 60 * 60 * 1000; // 2 hours
    if (expired) {
      window.localStorage.removeItem(LS_KEY);
      log.info('recording restore: state expired — cleared');
      return;
    }
    // Restore steps BEFORE listeners are attached
    if (recordedSteps.length === 0) {
      Object.assign(recordedData, data);
      recordedSteps.push(...steps);
      // Rebuild dedup map so post-redirect recording doesn't re-record already-saved fields
      for (const step of steps) {
        if (step.type === 'fill') lastRecordedFillValue.set(step.name, step.value);
      }
      log.info(`recording restore: ✅ restored — ${Object.keys(data).length} field(s), ${steps.length} step(s) (before listeners attached)`);
    }
  } catch (e) {
    log.warn('recording restore: error reading localStorage —', e);
  }
}

function activate() {
log.info('activate: fired —', window.location.href);

// Restore old recording state BEFORE attaching listeners (prevents new steps from being recorded before old ones are restored)
restoreRecordingStateSync();

// ─── Resume replay after same-tab redirect (e.g. Perfios) ────────────────────
// Ask background if there is a pending resume state for this tab.
// Background holds it in chrome.storage.session (survives SW restarts).
// Intermediate pages (Perfios) get { resume: false } — state is preserved.
// Only restore recording state if this is an actual redirect flow.
let isRedirectFlow = false;

chrome.runtime.sendMessage({ type: 'FORM_READY' }).then(async (response) => {
  // ── Child tab in RECORDING mode ──────────────────────────────────────────
  // Background detected this tab was opened by a watched click during recording.
  // Set the flag so persistRecordingState() forwards every step to the parent RM tab
  // as it's recorded — no dependency on tab switching or closing.
  if (response?.isChildTab) {
    // Clear any RM form steps restored from shared localStorage (same origin = same storage).
    recordedSteps.length = 0;
    Object.keys(recordedData).forEach(k => delete recordedData[k]);
    // If this is a subsequent page within the child tab (customer form navigated internally),
    // background returns the steps accumulated by previous pages so they carry forward.
    if (response.accumulatedSteps?.length > 0) {
      recordedSteps.push(...response.accumulatedSteps);
      log.info(`activate: child recording tab — restored ${response.accumulatedSteps.length} step(s) from previous page in this child tab`);
    } else {
      log.info('activate: child recording tab — starting fresh, will push each step to parent RM tab in real-time');
    }
    isChildRecordingTab = true;
    return;
  }

  // ── Child tab in REPLAY mode ──────────────────────────────────────────────
  // Background has steps queued for this tab to replay.
  // After all steps complete, signal background → RM form auto-continues its replay.
  if (response?.isChildTabReplay) {
    log.info(`activate: child replay tab — replaying ${response.steps.length} step(s)`);
    // Clear any RM form state restored from shared localStorage (same origin = same storage).
    recordedSteps.length = 0;
    Object.keys(recordedData).forEach(k => delete recordedData[k]);
    // Set flag BEFORE replaySteps so SAVE_RESUME_STATE carries isChildTabReplay:true,
    // allowing IS_CHILD_TAB to recognise subsequent pages in this tab (e.g. OTP page).
    isChildReplayTab = true;
    await new Promise(r => setTimeout(r, 1000));
    await waitForNetwork();
    stepReplayActive = true;
    try {
      const result = await replaySteps(response.steps, -1);
      if (!result?.suspended) {
        // All steps on this page completed — child tab replay fully done.
        log.info('activate: child replay complete — signaling parent RM tab to continue');
        await chrome.runtime.sendMessage({ type: 'CHILD_REPLAY_DONE' }).catch(() => {});
      } else {
        // Mid-replay navigation detected — next page will resume via FORM_READY and
        // send CHILD_REPLAY_DONE once all remaining steps complete.
        log.info('activate: child replay suspended for navigation — next page will continue');
      }
    } catch (err) {
      log.warn('child tab replay error:', err);
    }
    stepReplayActive = false;
    return;
  }

  if (!response?.resume) {
    if (response?.pendingState) {
      isRedirectFlow = true; // We're in the middle of a redirect flow
      log.info(`replay restore: ⏸ pending state found but still on intermediate domain — waiting to resume at ${response.expectedPath}`);
    } else {
      // No redirect flow — clear any stale recording state
      if (!isRedirectFlow) {
        log.info('replay restore: no pending state for this page');
        window.localStorage.removeItem(LS_KEY);
      }
    }
    return;
  }
  isRedirectFlow = true;
  const { steps, resumeFromStep, stopAfterIndex, isChildTabReplay: resumeIsChildReplay } = response;
  if (resumeIsChildReplay) {
    // Resuming replay inside a child tab after a mid-replay navigation (e.g. consent → OTP page).
    // Re-set the flag so subsequent SAVE_RESUME_STATE calls keep carrying isChildTabReplay:true.
    isChildReplayTab = true;
  }
  log.info(`replay restore: ✅ state found — resuming from step ${resumeFromStep + 1}/${steps.length}, stopAfter=${stopAfterIndex}, childReplay=${!!resumeIsChildReplay}, url=${window.location.pathname}`);
  // Brief pause to let the form's scripts fire their initial API calls (ASE polling etc.),
  // then wait for all in-flight requests to settle before touching any fields.
  await new Promise(r => setTimeout(r, 1000));
  await waitForNetwork();
  log.info('replay restore: network idle — form initialization complete');
  await new Promise(r => setTimeout(r, 500));
  stepReplayActive = true;
  const slicedSteps = steps.slice(resumeFromStep);
  const adjustedStop = stopAfterIndex >= resumeFromStep ? stopAfterIndex - resumeFromStep : -1;
  log.info(`replay restore: starting replaySteps with ${slicedSteps.length} remaining step(s), adjustedStop=${adjustedStop}`);
  replaySteps(slicedSteps, adjustedStop).then(async result => {
    if (isChildReplayTab && !result?.suspended) {
      // All remaining child tab steps completed on this page — signal RM to continue.
      log.info('replay restore: child replay complete — signaling parent RM tab to continue');
      await chrome.runtime.sendMessage({ type: 'CHILD_REPLAY_DONE' }).catch(() => {});
    }
  }).catch(err => {
    log.warn('replay restore: error —', err);
    stepReplayActive = false;
  });
}).catch(err => { log.warn('replay restore: FORM_READY message failed —', err); });

// Attach listeners AFTER restoration and FORM_READY check
document.addEventListener('input', handleInputChange, true);
document.addEventListener('change', handleInputChange, true);



// ─── Step Recording ───────────────────────────────────────────────────────────

function handleStepChange(e) {
  if (stepReplayActive) return;
  const input = e.target;
  if (!(input instanceof HTMLInputElement || input instanceof HTMLSelectElement || input instanceof HTMLTextAreaElement)) return;
  if (shouldSkip(input)) return;

  const type = input.type.toLowerCase();
  const name = input.name;
  const value = type === 'radio' ? input.value : type === 'checkbox' ? input.checked : input.value;
  // For selects, also record the display label so typeahead can filter by text
  const label = (type === 'select-one' && input.selectedIndex >= 0)
    ? (input.options[input.selectedIndex]?.text || '')
    : undefined;
  
  // Deduplicate: skip if this field was last recorded with the same value
  // (catches AEM re-firing change events on already-filled fields after section re-renders,
  //  even when other fields were recorded in between)
  if (lastRecordedFillValue.get(name) === value) {
    log.info('skipped duplicate fill (re-fire):', name, '=', value);
    return;
  }
  lastRecordedFillValue.set(name, value);

  recordedSteps.push({ type: 'fill', name, value, inputType: type, ...(label !== undefined && { label }) });
  log.info('recorded fill:', name, '=', value, label ? `(label: ${label})` : '');
  persistRecordingState();
}

function handleStepClick(e) {
  if (stepReplayActive) return;
  // Guard against stale content scripts after extension reload.
  // chrome.runtime.id becomes undefined (or throws) when the context is invalidated.
  try { if (!chrome.runtime.id) return; } catch { return; }
  const el = e.target.closest('button:not([type="reset"]), input[type="submit"], input[type="button"]');
  if (!el) return;

  const tag = el.tagName.toLowerCase();
  const text = (el.textContent || el.value || '').trim().slice(0, 80);
  const name = el.name || '';
  if (!text && !name) return;

  if (shouldSkipClick(el)) { log.info('recorded click: skipped (skip-config)', name || text); return; }

  const allOfTag = Array.from(document.querySelectorAll(tag));
  const index = allOfTag.indexOf(el);
  recordedSteps.push({ type: 'click', tag, text, name, index });
  log.info('recorded click:', tag, name || text);
  persistRecordingState();

  // Only watch for new-tab detection on the RM form — child tab buttons don't open new tabs,
  // and sending START_WATCHING_TAB from the child would clear watch.watchedTabId in the
  // background, breaking IS_CHILD_TAB for subsequent pages within the child tab.
  if (!isChildRecordingTab) {
    const clickStepIndex = recordedSteps.length - 1;
    chrome.runtime.sendMessage({ type: 'START_WATCHING_TAB', isRecording: true }).catch(() => {});
    let tabPollElapsed = 0;
    const TAB_POLL_INTERVAL = 500;
    const TAB_POLL_MAX = 30_000;
    const tabPollId = setInterval(async () => {
      tabPollElapsed += TAB_POLL_INTERVAL;
      try {
        const { watchedTabId } = await chrome.runtime.sendMessage({ type: 'GET_WATCH_STATE' });
        if (watchedTabId) {
          clearInterval(tabPollId);
          if (recordedSteps[clickStepIndex]?.type === 'click') {
            recordedSteps[clickStepIndex].opensNewTab = true;
            persistRecordingState();
            log.info('recorded click: marked opensNewTab=true for step', clickStepIndex + 1, `(detected at ${tabPollElapsed}ms)`);
          }
          return;
        }
      } catch {
        clearInterval(tabPollId);
        return;
      }
      if (tabPollElapsed >= TAB_POLL_MAX) {
        clearInterval(tabPollId);
        chrome.runtime.sendMessage({ type: 'STOP_WATCHING_TAB' }).catch(() => {});
        log.info('recorded click: no new tab detected after 30s for step', clickStepIndex + 1);
      }
    }, TAB_POLL_INTERVAL);
  }

  // Detect same-tab navigation after this click (e.g. Perfios redirect).
  // Cancel any listener from a previous click first — only the LAST click that causes
  // navigation should be marked expectsRedirect=true (avoids multi-flag bug).
  if (pendingMarkRedirect) {
    window.removeEventListener('beforeunload', pendingMarkRedirect);
    pendingMarkRedirect = null;
  }
  const redirectStepIndex = recordedSteps.length - 1;
  const originalUrl = window.location.pathname;
  const markRedirect = () => {
    pendingMarkRedirect = null;
    if (recordedSteps[redirectStepIndex]?.type === 'click') {
      // Distinguish reload (same URL) vs redirect (different URL)
      const isReload = window.location.pathname === originalUrl;
      recordedSteps[redirectStepIndex].expectsRedirect = !isReload;
      if (isReload) {
        recordedSteps[redirectStepIndex].expectsReload = true;
        // Clear recording state from localStorage before reload to suppress restore logs
        window.localStorage.removeItem(LS_KEY);
        log.info('recorded reload: clearing recording state from localStorage');
      }
      persistRecordingState();
      const navType = isReload ? 'reload' : 'redirect';
      log.info(`recorded ${navType}: step ${redirectStepIndex + 1} marked as expects${isReload ? 'Reload' : 'Redirect'}=true`);
    }
  };
  pendingMarkRedirect = markRedirect;
  window.addEventListener('beforeunload', markRedirect, { once: true });
  setTimeout(() => {
    window.removeEventListener('beforeunload', markRedirect);
    if (pendingMarkRedirect === markRedirect) pendingMarkRedirect = null;
  }, 30_000);
}

document.addEventListener('change', handleStepChange, true);
document.addEventListener('click', handleStepClick, true);

// ── Child tab steps → embed into parent click step (recording) ──────────────
// Background forwards child steps to the parent RM tab after each recorded step
// (CHILD_STEP_RECORDED) and also when the child tab actually closes (tab lifecycle).
// Both paths arrive here as RESUME_AFTER_TAB_CLOSE — just overwrite each time.
chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== 'RESUME_AFTER_TAB_CLOSE' || stepReplayActive) return;
  if (!message.childTabSteps?.length) return;
  // Find the most recent click step marked opensNewTab=true (the one that opened this child)
  let lastChildClickIdx = -1;
  for (let i = recordedSteps.length - 1; i >= 0; i--) {
    if (recordedSteps[i].type === 'click' && recordedSteps[i].opensNewTab) {
      lastChildClickIdx = i;
      break;
    }
  }
  if (lastChildClickIdx >= 0) {
    recordedSteps[lastChildClickIdx].childTabSteps = message.childTabSteps;
    recordedSteps[lastChildClickIdx].childTabUrl   = message.childTabUrl;
    persistRecordingState();
    log.info(`recorded child tab: embedded ${message.childTabSteps.length} step(s) into click step ${lastChildClickIdx + 1} (url: ${message.childTabUrl})`);
  }
});

// ─── Prefill ─────────────────────────────────────────────────────────────────

async function prefillVisibleFields() {
  if (!replayData) return;

  if (fillInProgress) {
    pendingFill = true;
    return;
  }

  fillInProgress = true;
  pendingFill = false;

  try {
    const inputs = Array.from(document.querySelectorAll('input, select, textarea'));

    for (const input of inputs) {
      if (!replayData) break;
      if (shouldSkip(input)) continue;
      if (isHidden(input)) continue;

      const name = input.name;
      if (!(name in replayData)) continue;

      const value = replayData[name];
      const type = input.type.toLowerCase();

      if (type === 'radio' || type === 'checkbox') {
        if (input.checked !== Boolean(value)) {
          input.checked = Boolean(value);
          dispatchEvents(input);
          await waitForNetwork();
        }
      } else {
        if (input.value !== String(value)) {
          input.value = String(value);
          dispatchEvents(input);
          await waitForNetwork();
        }
      }
    }
  } finally {
    fillInProgress = false;
  }

  if (pendingFill && replayData) {
    pendingFill = false;
    setTimeout(prefillVisibleFields, 50);
  }
}

// ─── MutationObserver ────────────────────────────────────────────────────────

function startReplayObserver() {
  if (replayObserver) replayObserver.disconnect();

  replayObserver = new MutationObserver((mutations) => {
    let shouldPrefill = false;
    for (const mutation of mutations) {
      if (
        mutation.type === 'attributes' &&
        mutation.attributeName === 'data-visible' &&
        mutation.target.dataset.visible === 'true'
      ) {
        shouldPrefill = true;
        break;
      }
    }
    if (shouldPrefill) {
      prefillVisibleFields();
    }
  });

  replayObserver.observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ['data-visible'],
  });
}

function stopReplayObserver() {
  if (replayObserver) {
    replayObserver.disconnect();
    replayObserver = null;
  }
}

// ─── Step Replay ─────────────────────────────────────────────────────────────

function waitForElement(selector, timeout = 2000) {
  return new Promise(resolve => {
    const start = Date.now();
    const id = setInterval(() => {
      const el = document.querySelector(selector);
      if (el && !isHidden(el)) { clearInterval(id); return resolve(el); }
      if (Date.now() - start > timeout) { clearInterval(id); return resolve(null); }
    }, 50);
  });
}

/** Polls until a fill-step's input exists in the DOM AND is not hidden by AEM.
 *  For AEM typeahead selects (native <select> always display:none), resolves as
 *  soon as the sibling .dynamic-dropdown-input becomes visible — meaning the
 *  ancestor wrapper's data-visible toggled to true (e.g. after "channel" → "DIRECT").
 *  After 30s we fall back and return the element even if still hidden. */
function waitForFillable(name) {
  const selector = `[name="${CSS.escape(name)}"]`;
  const VISIBILITY_TIMEOUT_MS = 30_000;
  log.info(`waitForFillable: "${name}"`);
  return new Promise(resolve => {
    const start = Date.now();
    let lastLog = 0;
    const id = setInterval(() => {
      if (!stepReplayActive) { clearInterval(id); return resolve(null); }
      // Use querySelectorAll and prefer the first visible instance.
      // AEM accordion sections duplicate field names; querySelector returns the first
      // (often hidden) copy — querySelectorAll lets us find the visible one.
      const all = Array.from(document.querySelectorAll(selector));
      const el = all.find(e => !isHidden(e)) || all[0] || null;
      const elapsed = Date.now() - start;
      if (el) {
        if (!isHidden(el)) {
          clearInterval(id);
          log.info(`waitForFillable: ready "${name}"`);
          return resolve(el);
        }
        // AEM typeahead: native <select> always has display:none; the visible
        // indicator is the sibling .dynamic-dropdown-input becoming un-hidden
        // (its ancestor wrapper toggles data-visible when the triggering field changes).
        if (el.tagName === 'SELECT') {
          const dynInput = el.parentElement?.querySelector('.dynamic-dropdown-input');
          if (dynInput && !isHidden(dynInput)) {
            clearInterval(id);
            log.info(`waitForFillable: ready "${name}" (typeahead input visible)`);
            return resolve(el);
          }
        }
        // AEM has this field's section marked data-visible="false" — wait for it
        if (elapsed >= VISIBILITY_TIMEOUT_MS) {
          clearInterval(id);
          log.warn(`waitForFillable: "${name}" still hidden after 30s — filling anyway`);
          return resolve(el);
        }
        if (elapsed - lastLog >= 2000) { lastLog = elapsed; log.info(`waitForFillable: "${name}" in DOM but hidden (${Math.round(elapsed/1000)}s) — waiting`); }
        return;
      }
      if (elapsed - lastLog >= 2000) { lastLog = elapsed; log.info(`waitForFillable: "${name}" not in DOM (${Math.round(elapsed/1000)}s)`); }
    }, 100);
  });
}

/**
 * For select elements whose options are populated by an API call:
 * polls until the target option value exists in the <select>, then resolves it.
 * Infinite wait (respects stepReplayActive).
 */
function waitForSelectOption(selectEl, targetValue) {
  const target = String(targetValue);
  const TIMEOUT_MS = 5_000;
  // Match by value OR by trimmed display text (handles cases where .value differs from recorded)
  const findOption = () => Array.from(selectEl.options).find(
    o => o.value === target || o.text.trim() === target
  );
  return new Promise(resolve => {
    const opt = findOption();
    if (opt) return resolve({ el: selectEl, option: opt });
    log.info(`waitForSelectOption: "${target}" not yet present (${selectEl.options.length} options loaded)`);
    const start = Date.now();
    let lastLog = 0;
    const id = setInterval(() => {
      if (!stepReplayActive) { clearInterval(id); return resolve(null); }
      const opt = findOption();
      if (opt) { clearInterval(id); log.info(`waitForSelectOption: option "${target}" appeared`); return resolve({ el: selectEl, option: opt }); }
      const elapsed = Date.now() - start;
      if (elapsed >= TIMEOUT_MS) {
        clearInterval(id);
        const allOpts = Array.from(selectEl.options);
        const existing = allOpts.map(o => o.text.trim()).join(', ') || '(none)';
        // Fall back to first option with a non-empty value (skip placeholder)
        const firstReal = allOpts.find(o => o.value !== '');
        if (firstReal) {
          log.warn(`waitForSelectOption: "${target}" not found — selecting first option "${firstReal.text.trim()}" as fallback. Options: ${existing}`);
          return resolve({ el: selectEl, option: firstReal });
        }
        log.warn(`waitForSelectOption: timed out after ${TIMEOUT_MS/1000}s — skipping. Options: ${existing}`);
        return resolve(null);
      }
      if (elapsed - lastLog >= 2000) { lastLog = elapsed; log.info(`waitForSelectOption: waiting for option "${target}" (${Math.round(elapsed/1000)}s)`); }
    }, 100);
  });
}

// Waits for background to signal that the new tab was closed (5 min max)
function waitForTabClose() {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, 5 * 60 * 1000);
    const listener = (message) => {
      if (message.type === 'RESUME_AFTER_TAB_CLOSE') {
        clearTimeout(timer);
        chrome.runtime.onMessage.removeListener(listener);
        resolve();
      }
    };
    chrome.runtime.onMessage.addListener(listener);
  });
}

function waitForEnabled(el, timeout = 8000) {
  const isReady = () => !el.disabled && !isHidden(el);
  return new Promise(resolve => {
    if (isReady()) return resolve(el);
    const start = Date.now();
    const id = setInterval(() => {
      if (isReady()) { clearInterval(id); return resolve(el); }
      if (Date.now() - start > timeout) { clearInterval(id); return resolve(null); }
    }, 100);
  });
}

/** Polls indefinitely until a click-step's target element exists AND is not disabled */
function waitForClickable(step) {
  const normalize = t => (t || '').replace(/\s+/g, ' ').trim();
  log.info(`waitForClickable: <${step.tag}> name="${step.name}" text="${step.text}"`);
  return new Promise(resolve => {
    const start = Date.now();
    let lastLog = 0;
    const id = setInterval(() => {
      if (!stepReplayActive) { clearInterval(id); return resolve(null); } // stopped by user
      // Helper: true if element is non-disabled and has layout dimensions on screen
      const isClickable = e => !e.disabled && (r => r.width > 0 && r.height > 0)(e.getBoundingClientRect());

      let el = null;
      if (step.name) {
        // Use querySelectorAll — there may be duplicate name="..." elements in the DOM
        // (e.g. hidden copies in collapsed panels). Pick the first one that's on screen.
        const all = Array.from(document.querySelectorAll(`${step.tag}[name="${CSS.escape(step.name)}"]`));
        el = all.find(isClickable) || all[0] || null;
      }
      if (!el && step.text) {
        const candidates = Array.from(document.querySelectorAll(step.tag));
        el = candidates.find(b => normalize(b.textContent) === normalize(step.text)) || null;
      }
      if (!el && step.index >= 0) {
        const candidates = Array.from(document.querySelectorAll(step.tag));
        el = candidates[step.index] || null;
      }
      if (el && isClickable(el)) {
        clearInterval(id);
        log.info('waitForClickable: ready', el);
        return resolve(el);
      }
      const elapsed = Date.now() - start;
      if (elapsed - lastLog >= 2000) {
        lastLog = elapsed;
        const reason = !el ? 'not in DOM' : el.disabled ? 'disabled' : 'not on screen';
        log.info(`waitForClickable: ${reason} (${Math.round(elapsed/1000)}s)`);
      }
    }, 200);
  });
}


/** Pauses until this tab is the active (visible) tab again */
function waitForTabVisible() {
  return new Promise(resolve => {
    if (!document.hidden) return resolve();
    const handler = () => {
      if (!document.hidden) {
        document.removeEventListener('visibilitychange', handler);
        resolve();
      }
    };
    document.addEventListener('visibilitychange', handler);
  });
}

async function replaySteps(steps, stopAfterIndex = -1) {
  log.info(`replaySteps: starting — ${steps.length} step(s)${stopAfterIndex >= 0 ? `, stop after step ${stopAfterIndex + 1}` : ''}`);
  console.log('[Recorder] replaySteps stopAfterIndex =', stopAfterIndex);
  document.documentElement.setAttribute('data-hdfc-replay', '1');

  // If the page navigates mid-replay (e.g. same-tab Perfios redirect), stop immediately.
  // SAVE_RESUME_STATE is saved before each click so FORM_READY can resume after the redirect.
  let suspendedForNavigation = false;
  const onNavigate = () => {
    log.info('replaySteps: beforeunload — page navigating, suspending replay');
    stepReplayActive = false;
    suspendedForNavigation = true;
  };
  window.addEventListener('beforeunload', onNavigate, { once: true });

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!stepReplayActive) { log.info('replaySteps: stopped'); break; }
    // Safety: if a previous iteration used `continue` and skipped the end-of-loop
    // stop check, catch it here at the start of the next iteration.
    if (stopAfterIndex >= 0 && i >= stopAfterIndex) {
      log.info('replaySteps: stop checkpoint — halting before step', i + 1, '(selected step not fired)');
      break;
    }

    await waitForTabVisible();

    // If the previous click triggered same-tab navigation (e.g. Perfios redirect),
    // beforeunload fired and set stepReplayActive=false. Stop here — FORM_READY will resume.
    if (!stepReplayActive) { log.info('replaySteps: navigation detected — suspending'); break; }

    // We're executing step i — the previous step did NOT cause page navigation.
    // Safe to clear any resume state that was saved for the previous click.
    await chrome.runtime.sendMessage({ type: 'CLEAR_RESUME_STATE' }).catch(() => {});

    log.group(`Step ${i + 1}/${steps.length}: ${step.type} — ${step.name || step.text || ''}`);

    if (step.type === 'fill') {
      const input = await waitForFillable(step.name);
      if (!input) { log.warn('fill: stopped', step.name); log.end(); continue; }
      // Skip only hard conditions — not isHidden, since field was visible at record time
      const _n = input.name || '';
      if (!_n || _n.startsWith('hidden') || input.readOnly || input.disabled) {
        log.warn('fill: skipping', step.name); log.end(); continue;
      }
      const type = (step.inputType || input.type)?.toLowerCase();
      // Skip empty-value select steps — they represent intermediate cleared states (e.g.
      // the component resetting before a real selection) and actively break typeahead replay.
      if (type === 'select-one' && (step.value === '' || step.value === null || step.value === undefined)) {
        log.info(`fill: skipping empty select value for "${step.name}"`); log.end(); continue;
      }
      log.info(`fill: [${step.name}] type=${type} value="${step.value}"`);

      if (type === 'radio') {
        const radio = document.querySelector(`[name="${CSS.escape(step.name)}"][value="${CSS.escape(String(step.value))}"]`);
        if (radio && !radio.checked) {
          const clickTarget = radio.labels?.[0] || radio.closest('label') || radio.parentElement || radio;
          clickTarget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          radio.checked = true;
          dispatchEvents(radio);
          await waitForNetwork();
        }
        replayTargetValues.set(step.name, step.value);
      } else if (type === 'checkbox') {
        if (input.checked !== Boolean(step.value)) {
          const clickTarget = input.labels?.[0] || input.closest('label') || input.parentElement || input;
          clickTarget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          input.checked = Boolean(step.value);
          dispatchEvents(input);
          await waitForNetwork();
        }
        replayTargetValues.set(step.name, step.value);
      } else if (input.tagName === 'SELECT') {
        // Typeahead selects hide the <select> (display:none) and show a custom input instead.
        // Regular native dropdowns keep the <select> visible — use direct value assignment for those.
        const isTypeahead = input.style.display === 'none' || isHidden(input);

        const container = input.closest('mat-form-field, [class*="form-field"], [class*="field-wrap"], .ng-select')
          || input.parentElement?.parentElement
          || input.parentElement;
        const typeaheadInput = isTypeahead && container
          ? Array.from(container.querySelectorAll('input')).find(el => !isHidden(el) && !el.readOnly && !el.disabled)
          : null;

        if (typeaheadInput) {
          // Typeahead: type the label (display text) char-by-char so the filter matches,
          // then click the overlay option. Fall back to value if no label recorded.
          const typeText = step.label || String(step.value);
          log.info(`fill: [${step.name}] typeahead — typing "${typeText}" char-by-char`);
          await typeCharByChar(typeaheadInput, typeText);
          await waitForNetwork();
          const overlayOpt = await waitForDropdownOption(String(step.value));
          if (overlayOpt) {
            overlayOpt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
            overlayOpt.click();
            await waitForNetwork();
          } else {
            // Overlay didn't appear — fall through to native select approach
            const result = await waitForSelectOption(input, step.value);
            if (result) {
              result.el.value = result.option.value;
              dispatchEvents(result.el);
              await waitForNetwork();
            }
          }
        } else {
          // Native select: focus+click to trigger lazy-load, then set value directly
          input.focus();
          input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
          input.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true, view: window }));
          await waitForNetwork();
          const result = await waitForSelectOption(input, step.value);
          if (result) {
            result.el.value = result.option.value;
            dispatchEvents(result.el);
            await waitForNetwork();
          }
        }
        replayTargetValues.set(step.name, step.value);
      } else if (input.type === 'range') {
        if (input.value !== String(step.value)) {
          input.value = String(step.value);
          // AEM rule engine uses mouseup to commit slider value and re-evaluate visibility rules
          input.dispatchEvent(new Event('input',  { bubbles: true }));
          input.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          await waitForNetwork();
        }
        replayTargetValues.set(step.name, step.value);
      } else {
        if (input.value !== String(step.value)) {
          // Clear any existing value first so Angular sees a clean transition
          if (input.value) {
            input.value = '';
            dispatchEvents(input);
          }
          input.value = String(step.value);
          dispatchEvents(input);
          input.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
          await waitForNetwork();
        }
        replayTargetValues.set(step.name, step.value);
      }

    } else if (step.type === 'click') {
      // Skip if the step matches a skip-config rule (checked against recorded metadata)
      const skipRule = (typeof SKIP_CLICKS !== 'undefined' ? SKIP_CLICKS : []).some(rule => {
        if (rule.name && rule.name !== step.name) return false;
        if (rule.text && rule.text !== step.text) return false;
        if (rule.tag  && rule.tag  !== step.tag)  return false;
        return true;
      });
      if (skipRule) { log.info('click: skipped by skip-config', step.name || step.text); log.end(); continue; }

      let el = await waitForClickable(step);
      if (el) {
        // Wait for any in-flight requests to settle before clicking
        await waitForNetwork();
        await new Promise(r => setTimeout(r, 300));

        // Tell background to hold a resume state for this tab before clicking.
        // If this click triggers a same-tab navigation, the content script will be
        // destroyed. The state lives in background memory (keyed by tabId) and is
        // immune to interference from any intermediate page's content script.
        await chrome.runtime.sendMessage({
          type: 'SAVE_RESUME_STATE',
          steps,
          resumeFromStep: i + 1,
          stopAfterIndex,
          expectedPath: window.location.origin + window.location.pathname,
          isChildTabReplay: isChildReplayTab, // carry flag so next page knows it's still a child replay
        });
        log.info(`replay save: ⏳ saved state before click — will resume from step ${i + 2}/${steps.length} if page navigates (expectedPath=${window.location.pathname})`);

        // If this click is expected to open a child tab, always queue child replay steps
        // (even if empty) so IS_CHILD_TAB returns isChildTabReplay:true and the URL filter
        // is bypassed, allowing the child tab's content script to activate.
        if (step.opensNewTab) {
          const childSteps = step.childTabSteps || [];
          await chrome.runtime.sendMessage({
            type: 'SAVE_CHILD_REPLAY_STEPS',
            steps: childSteps,
            expectedUrl: step.childTabUrl || '',  // used by bg to skip intermediate redirect pages
          });
          log.info(`click: queued ${childSteps.length} child tab step(s) for replay in new tab (expectedUrl=${step.childTabUrl || 'unknown'})`);
        }

        let clicked = false;

        if (step.expectsRedirect) {
          // This click was recorded as causing a same-tab navigation (e.g. Perfios redirect).
          // Fire once and wait for beforeunload — no need to guess from "button gone" heuristics.
          // SAVE_RESUME_STATE is already saved; FORM_READY will resume after the redirect.
          log.info('click: expectsRedirect=true — firing and waiting for page navigation (up to 30s)');
          await chrome.runtime.sendMessage({ type: 'START_WATCHING_TAB' });
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
          el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true, view: window }));
          el.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true, view: window }));
          await waitForNetwork();

          const navigated = await new Promise(resolve => {
            const h = () => resolve(true);
            window.addEventListener('beforeunload', h, { once: true });
            setTimeout(() => { window.removeEventListener('beforeunload', h); resolve(false); }, 30_000);
          });

          if (navigated) {
            log.info('click: navigation confirmed — suspending replay, FORM_READY will resume');
            suspendedForNavigation = true;
            stepReplayActive = false;
          } else {
            log.warn('click: navigation expected but did not happen after 30s — continuing normally');
          }
          clicked = true;
          await chrome.runtime.sendMessage({ type: 'STOP_WATCHING_TAB' });
        } else if (step.opensNewTab) {
          // Child replay steps were already queued via SAVE_CHILD_REPLAY_STEPS above.
          // Fire the click once (triggers the API call) and move on immediately —
          // the child tab opens and auto-replays in the background.
          // The next RM step's waitForFillable/waitForClickable naturally waits
          // until the RM form is ready (e.g. button enabled after customer sync).
          log.info('click: opensNewTab=true — firing once, child tab will auto-replay in background');
          await chrome.runtime.sendMessage({ type: 'START_WATCHING_TAB' });
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
          el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true, view: window }));
          el.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true, view: window }));
          await waitForNetwork();
          clicked = true;

        } else {

        while (stepReplayActive && !clicked) {
          log.info('click: firing on', el);
          await chrome.runtime.sendMessage({ type: 'START_WATCHING_TAB' });
          // Register listener BEFORE the click fires so we never miss a fast tab open+close
          const tabClosePromise = waitForTabClose();

          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
          el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true, view: window }));
          el.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true, view: window }));
          await waitForNetwork();

          // Wait to see if navigation/new-tab happened
          await new Promise(r => setTimeout(r, 1500));

          const { watchedTabId } = await chrome.runtime.sendMessage({ type: 'GET_WATCH_STATE' });
          if (watchedTabId) {
            log.info(`click: new tab detected (${watchedTabId}), waiting for close`);
            clicked = true;
            await tabClosePromise;
            await waitForTabVisible();
            await waitForNetwork();
            await new Promise(r => setTimeout(r, 500));
          } else {
            // Check if button is gone (page navigated) or still present (click blocked by validation)
            const stillHere = document.querySelector(
              step.name ? `${step.tag}[name="${CSS.escape(step.name)}"]` : step.tag
            );
            if (!stillHere || stillHere.disabled) {
              // Button gone or now disabled — navigation happened or form moved on
              log.info('click: button gone/disabled after click, assuming success');
              clicked = true;
              await chrome.runtime.sendMessage({ type: 'STOP_WATCHING_TAB' });
              await new Promise(r => setTimeout(r, 200));
            } else if (isHidden(stillHere)) {
              // Button is now hidden (display:none / visibility:hidden) — click had its effect
              // (e.g. "Go to Bottom" scroll helper hides itself, modal close hides the trigger, etc.)
              log.info('click: button hidden after click — treating as success');
              clicked = true;
              await chrome.runtime.sendMessage({ type: 'STOP_WATCHING_TAB' });
            } else {
              // Look ahead: if the next step's target is now visible on screen, the click
              // opened a modal/overlay even though this button is still present (e.g. eVerifyButton).
              // Must check visibility (getBoundingClientRect), not just DOM presence — the next
              // element may always be in the DOM but hidden inside a collapsed panel.
              const nextStep = steps[i + 1];
              const nextEl = nextStep?.name
                ? document.querySelector(`${nextStep.tag}[name="${CSS.escape(nextStep.name)}"]`)
                : null;
              const nextRect = nextEl?.getBoundingClientRect();
              const nextVisible = nextRect && nextRect.width > 0 && nextRect.height > 0;
              if (nextVisible) {
                log.info('click: next step element is now visible — assuming modal/overlay opened, moving on');
                clicked = true;
                await chrome.runtime.sendMessage({ type: 'STOP_WATCHING_TAB' });
                await new Promise(r => setTimeout(r, 300));
              } else {
                // Button still visible and enabled — click once and move on.
                // The next step's waitForFillable will naturally wait for any
                // side-effects (API calls, panel opening) to complete.
                log.info('click: button still present after click — clicked once, moving on');
                clicked = true;
                await chrome.runtime.sendMessage({ type: 'STOP_WATCHING_TAB' });
                await new Promise(r => setTimeout(r, 300));
              }
            }
          }
        }
        } // end else (normal click — not expectsRedirect)
        // CLEAR_RESUME_STATE will be sent at the start of the next loop iteration.
      } else {
        log.warn('click: stopped before element found');
      }
      // Note: CLEAR_RESUME_STATE is sent at the START of the next iteration,
      // not here — this avoids the race where navigation triggers after "button gone"
      // is detected but before we've sent the clear message.
    }

    log.end();
  }
  window.removeEventListener('beforeunload', onNavigate);
  if (!suspendedForNavigation) {
    // Replay finished normally or was user-stopped — clear any lingering resume state.
    // If navigating, preserve the state so FORM_READY can resume after the redirect.
    document.documentElement.removeAttribute('data-hdfc-replay');
    await chrome.runtime.sendMessage({ type: 'CLEAR_RESUME_STATE' }).catch(() => {});
  } else {
    log.info('replaySteps: navigation in progress — preserving resume state for FORM_READY');
  }
  stepReplayActive = false;
  log.info('replaySteps: done');
  return { suspended: suspendedForNavigation };
}

// ─── Message Handler (popup → content) ───────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  log.info('msg:', message.type);
  switch (message.type) {
    case 'START_REPLAY': {
      replayData = message.data;
      log.info('START_REPLAY: keys =', Object.keys(replayData));
      startReplayObserver();
      prefillVisibleFields();
      sendResponse({ ok: true });
      break;
    }
    case 'STOP_REPLAY': {
      replayData = null;
      pendingFill = false;
      stopReplayObserver();
      sendResponse({ ok: true });
      break;
    }
    case 'GET_CURRENT': {
      sendResponse({ data: { ...recordedData } });
      break;
    }
    case 'GET_STEPS': {
      log.info('GET_STEPS: returning', recordedSteps.length, 'step(s)');
      sendResponse({ steps: [...recordedSteps] });
      break;
    }
    case 'START_STEP_REPLAY': {
      log.info('START_STEP_REPLAY:', message.steps.length, 'step(s)');
      stepReplayActive = true;
      replaySteps(message.steps, message.stopAfterIndex ?? -1).catch((err) => { log.warn('replaySteps error:', err); stepReplayActive = false; });
      sendResponse({ ok: true });
      break;
    }
    case 'STOP_STEP_REPLAY': {
      stepReplayActive = false;
      document.documentElement.removeAttribute('data-hdfc-replay');
      sendResponse({ ok: true });
      break;
    }
    case 'CLEAR_RECORDING_STATE': {
      try { window.localStorage.removeItem(LS_KEY); } catch {}
      sendResponse({ ok: true });
      break;
    }
    default:
      sendResponse({ ok: false, error: 'Unknown message type' });
  }
  return true;
});
} // end activate()
