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
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
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
}

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
  recordedSteps.push({ type: 'fill', name, value, inputType: type });
  log.info('recorded fill:', name, '=', value);
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
      let el = null;
      if (step.name) {
        el = document.querySelector(`${step.tag}[name="${CSS.escape(step.name)}"]`);
      }
      if (!el && step.text) {
        const candidates = Array.from(document.querySelectorAll(step.tag));
        el = candidates.find(b => normalize(b.textContent) === normalize(step.text)) || null;
      }
      if (!el && step.index >= 0) {
        const candidates = Array.from(document.querySelectorAll(step.tag));
        el = candidates[step.index] || null;
      }
      if (el && !el.disabled && !isHidden(el)) {
        clearInterval(id);
        log.info('waitForClickable: ready', el);
        return resolve(el);
      }
      const elapsed = Date.now() - start;
      if (elapsed - lastLog >= 2000) {
        lastLog = elapsed;
        const reason = !el ? 'not in DOM' : el.disabled ? `disabled` : `hidden`;
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

async function replaySteps(steps) {
  log.info(`replaySteps: starting — ${steps.length} step(s)`);
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!stepReplayActive) { log.info('replaySteps: stopped'); break; }

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
      } else if (type === 'checkbox') {
        if (input.checked !== Boolean(step.value)) {
          const clickTarget = input.labels?.[0] || input.closest('label') || input.parentElement || input;
          clickTarget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          input.checked = Boolean(step.value);
          dispatchEvents(input);
          await waitForNetwork();
        }
      } else {
        if (input.value !== String(step.value)) {
          input.value = String(step.value);
          dispatchEvents(input);
          await waitForNetwork();
        }
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

        let clicked = false;
        while (stepReplayActive && !clicked) {
          log.info('click: firing on', el);
          await chrome.runtime.sendMessage({ type: 'START_WATCHING_TAB' });
          // Register listener BEFORE the click fires so we never miss a fast tab open+close
          const tabClosePromise = waitForTabClose();

          el.focus();
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
              // Button still visible and enabled — form validation blocked the click, retry
              log.warn('click: button still present after click — form may have validation errors, waiting to retry…');
              await chrome.runtime.sendMessage({ type: 'STOP_WATCHING_TAB' });
              el = await waitForClickable(step);
              await waitForNetwork();
              await new Promise(r => setTimeout(r, 500));
            }
          }
        }
      } else {
        log.warn('click: stopped before element found');
      }
    }

    log.end();
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
      replaySteps(message.steps).catch((err) => { log.warn('replaySteps error:', err); stepReplayActive = false; });
      sendResponse({ ok: true });
      break;
    }
    case 'STOP_STEP_REPLAY': {
      stepReplayActive = false;
      sendResponse({ ok: true });
      break;
    }
    default:
      sendResponse({ ok: false, error: 'Unknown message type' });
  }
  return true;
});
