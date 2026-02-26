// ─── State ───────────────────────────────────────────────────────────────────
const recordedData = {};
const recordedSteps = [];
let replayData = null;
let replayObserver = null;
let fillInProgress = false;
let pendingFill = false;
let activeRequests = 0;
let stepReplayActive = false;
let lastApiError = false;
let isReplayFilling = false;          // true only while dispatchEvents() is running
const userModifiedDuringReplay = new Set(); // field names the user manually touched during replay
const replayTargetValues = new Map(); // fieldName → value the replay last set

// ─── Logger ───────────────────────────────────────────────────────────────────

const log = {
  info:  (...args) => console.log('[HDFC]', ...args),
  warn:  (...args) => console.log('[HDFC] WARN', ...args),
  group: (label)   => console.groupCollapsed(`[HDFC] ${label}`),
  end:   ()        => console.groupEnd(),
};

// ─── Network Intercept ───────────────────────────────────────────────────────

(function interceptNetwork() {
  // Intercept fetch
  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    activeRequests++;
    return originalFetch.apply(this, args).finally(() => {
      activeRequests = Math.max(0, activeRequests - 1);
    });
  };

  // Intercept XHR
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._capturedUrl = url;
    return originalOpen.apply(this, [method, url, ...rest]);
  };

  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    activeRequests++;
    this.addEventListener('loadend', () => {
      activeRequests = Math.max(0, activeRequests - 1);
    });
    return originalSend.apply(this, args);
  };
})();

/** Resolves once there are no in-flight fetch/XHR requests */
function waitForNetwork() {
  return new Promise(resolve => {
    if (activeRequests === 0) return resolve();
    const id = setInterval(() => {
      if (activeRequests === 0) {
        clearInterval(id);
        resolve();
      }
    }, 20);
  });
}


// ─── Helpers ─────────────────────────────────────────────────────────────────

function storageKey() {
  return `journey_${window.location.pathname}`;
}

/** Returns true if any ancestor has data-visible="false" */
function isHidden(el) {
  if (el.dataset && el.dataset.visible === 'false') return true;
  let node = el.parentElement;
  while (node) {
    if (node.dataset && node.dataset.visible === 'false') return true;
    node = node.parentElement;
  }
  return false;
}

/** Returns true if this field should be skipped entirely */
function shouldSkip(input) {
  const name = input.name || '';
  if (!name) return true;
  if (name.startsWith('hidden')) return true;
  if (name.toLowerCase().includes('otp')) return true;
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
}

// ─── Activation Guard ────────────────────────────────────────────────────────
// Only attach listeners and intercept network if current page matches allowed patterns.
// If no patterns are configured, activate everywhere (default behaviour).
chrome.storage.local.get('allowedPatterns').then(({ allowedPatterns }) => {
  if (allowedPatterns && allowedPatterns.length > 0) {
    const href = window.location.href;
    const allowed = allowedPatterns.some(p => href.startsWith(p.replace(/\*$/, '')));
    if (!allowed) { log.info('Skipping — page not in allowed URL list'); return; }
  }
  activate();
});

function activate() {
document.addEventListener('input', handleInputChange, true);
document.addEventListener('change', handleInputChange, true);

// ─── Restore recording state after same-tab navigation ───────────────────────
// If the user was recording and the page navigated (e.g. to Perfios), the
// in-memory recordedData/recordedSteps were wiped. Restore them here so the
// user can continue recording on the callback page and save the full journey.
try {
  const raw = window.localStorage.getItem(LS_KEY);
  if (raw) {
    const { data, steps, pathname, savedAt } = JSON.parse(raw);
    const currentPath = window.location.origin + window.location.pathname;
    const expired = Date.now() - savedAt > 2 * 60 * 60 * 1000; // 2 hours
    if (expired || pathname !== currentPath) {
      window.localStorage.removeItem(LS_KEY);
    } else if (Object.keys(recordedData).length === 0 && recordedSteps.length === 0) {
      Object.assign(recordedData, data);
      recordedSteps.push(...steps);
      log.info(`activate: restored recording — ${Object.keys(data).length} field(s), ${steps.length} step(s)`);
    }
  }
} catch { /* parse error or storage unavailable — ignore */ }


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
  recordedSteps.push({ type: 'fill', name, value, inputType: type, ...(label !== undefined && { label }) });
  log.info('recorded fill:', name, '=', value, label ? `(label: ${label})` : '');
  persistRecordingState();
}

function handleStepClick(e) {
  if (stepReplayActive) return;
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
}

document.addEventListener('change', handleStepChange, true);
document.addEventListener('click', handleStepClick, true);

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

/** Polls indefinitely until a fill-step's input exists in the DOM */
function waitForFillable(name) {
  const selector = `[name="${CSS.escape(name)}"]`;
  log.info(`waitForFillable: "${name}"`);
  return new Promise(resolve => {
    const start = Date.now();
    let lastLog = 0;
    const id = setInterval(() => {
      if (!stepReplayActive) { clearInterval(id); return resolve(null); } // stopped by user
      const el = document.querySelector(selector);
      if (el) { clearInterval(id); log.info(`waitForFillable: ready "${name}" (hidden=${isHidden(el)})`); return resolve(el); }
      const elapsed = Date.now() - start;
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
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!stepReplayActive) { log.info('replaySteps: stopped'); break; }
    // Safety: if a previous iteration used `continue` and skipped the end-of-loop
    // stop check, catch it here at the start of the next iteration.
    if (stopAfterIndex >= 0 && i > stopAfterIndex) {
      log.info('replaySteps: stop checkpoint passed — halting before step', i + 1);
      break;
    }

    await waitForTabVisible();
    log.group(`Step ${i + 1}/${steps.length}: ${step.type} — ${step.name || step.text || ''}`);

    if (step.type === 'fill') {
      const input = await waitForFillable(step.name);
      if (!input) { log.warn('fill: stopped', step.name); log.end(); continue; }
      // Skip only hard conditions — not isHidden, since field was visible at record time
      const _n = input.name || '';
      if (!_n || _n.startsWith('hidden') || _n.toLowerCase().includes('otp') || input.readOnly || input.disabled) {
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
        });
        log.info(`click: resume state saved in background — will resume from step ${i + 2}/${steps.length} if page navigates`);

        let clicked = false;
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
              // Button is now hidden — API likely failed and the journey was terminated
              log.warn('click: button is hidden after click — likely API/journey failure, stopping retry');
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
                // Button still visible and enabled — form validation blocked the click, retry
                log.warn('click: button still present after click — form may have validation errors, waiting to retry…');
                await chrome.runtime.sendMessage({ type: 'STOP_WATCHING_TAB' });
                el = await waitForClickable(step);
                await waitForNetwork();
                await new Promise(r => setTimeout(r, 500));
              }
            }
          }
        }
        // Still on this page after click — tell background to drop the resume state
        await chrome.runtime.sendMessage({ type: 'CLEAR_RESUME_STATE' });
        log.info('click: no navigation detected — resume state cleared');
      } else {
        log.warn('click: stopped before element found');
      }
    }

    log.end();
    if (stopAfterIndex >= 0 && i >= stopAfterIndex) {
      log.info('replaySteps: stop checkpoint reached at step', i + 1, '— pausing replay');
      break;
    }
  }
  stepReplayActive = false;
  log.info('replaySteps: done');
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
