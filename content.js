// ─── State ───────────────────────────────────────────────────────────────────
const recordedData = {};
let replayData = null;
let replayObserver = null;
let fillInProgress = false;
let pendingFill = false;
let activeRequests = 0;

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
  if (isHidden(input)) return true;
  return false;
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

// ─── Prefill ─────────────────────────────────────────────────────────────────

/**
 * Prefill visible, non-skipped inputs top-to-bottom with a delay between each
 * changed field so the form's rule engine can settle (e.g. reset/show dependents)
 * before we move on.
 */
async function prefillVisibleFields() {
  if (!replayData) return;

  // If already running, note that another pass is needed after this one finishes
  if (fillInProgress) {
    pendingFill = true;
    return;
  }

  fillInProgress = true;
  pendingFill = false;

  try {
    // querySelectorAll returns elements in DOM (top-to-bottom) order
    const inputs = Array.from(document.querySelectorAll('input, select, textarea'));

    for (const input of inputs) {
      if (!replayData) break; // replay was stopped mid-fill

      if (shouldSkip(input)) continue;

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

  // If the MutationObserver fired new visible fields while we were filling, run again
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

// ─── Message Handler (popup → content) ───────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case 'START_REPLAY': {
      replayData = message.data;
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
    default:
      sendResponse({ ok: false, error: 'Unknown message type' });
  }
  return true; // keep channel open for async
});
