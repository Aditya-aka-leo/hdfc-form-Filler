// ─── API Tab Opener (MAIN world) ─────────────────────────────────────────────
// Runs in the page's JS realm so window.fetch / XHR overrides actually intercept
// the page's own network calls. Cannot use chrome.* APIs here — signals the
// isolated-world api-tab-opener.js via CustomEvent instead.

(function () {
  // ── Network request counter (signals isolated world via DOM attribute) ──────
  // content.js runs in the isolated world and cannot intercept the page's own
  // fetch/XHR calls. We count them here (MAIN world) and expose the count via
  // data-hdfc-pending on <html> so waitForNetwork() in content.js can poll it.
  let _pending = 0;
  function _inc() {
    _pending++;
    document.documentElement.setAttribute('data-hdfc-pending', _pending);
  }
  function _dec() {
    _pending = Math.max(0, _pending - 1);
    if (_pending === 0) document.documentElement.removeAttribute('data-hdfc-pending');
    else document.documentElement.setAttribute('data-hdfc-pending', _pending);
  }

  // ── API virtualization state ────────────────────────────────────────────────
  // Populated via __hdfc_set_virtual_responses__ CustomEvent from content.js
  // (isolated world) when START_STEP_REPLAY begins. Cleared on CLEAR_RECORDING_STATE.
  let _virtualResponses = [];
  // Tracks how many times each URL+method has been matched this replay session.
  // Enables polling APIs (same URL called N times) to serve the Nth recorded response.
  let _callCounters = new Map();

  document.addEventListener('__hdfc_set_virtual_responses__', (e) => {
    _virtualResponses = e.detail || [];
    _callCounters.clear();
    if (_virtualResponses.length > 0) {
      console.log('[HDFC:virt] loaded', _virtualResponses.length, 'virtual response(s):',
        _virtualResponses.map(r => `${r.method} ${r.url}`));
    } else {
      console.log('[HDFC:virt] virtual responses cleared');
    }
  });

  // ── Body normalisation (for matching recorded vs replayed request bodies) ────
  function normalizeBody(body) {
    if (!body) return '';
    if (typeof body === 'string') {
      try { return JSON.stringify(JSON.parse(body)); } catch { return body; }
    }
    if (body instanceof URLSearchParams) return body.toString();
    return String(body);
  }

  function urlPath(url) {
    try { return new URL(url, location.href).pathname; } catch { return url.split('?')[0]; }
  }

  // Find a recorded response that matches this request (URL path + method).
  // Body matching is intentionally omitted — request bodies during replay often
  // contain dynamic values (session tokens, application IDs, timestamps) that
  // differ from the recording even when the logical request is the same.
  //
  // For polling APIs (same URL called N times), returns the Nth recorded response
  // in order, capping at the last one when calls exceed recordings.
  function findVirtualResponse(url, method) {
    const matches = _virtualResponses.filter(r =>
      (urlPath(url) === urlPath(r.url) || url.includes(r.url) || r.url.includes(url)) &&
      (r.method || 'GET').toUpperCase() === method.toUpperCase()
    );
    if (!matches.length) return null;
    const key = `${method.toUpperCase()}:${urlPath(url)}`;
    const callIndex = _callCounters.get(key) || 0;
    _callCounters.set(key, callIndex + 1);
    return matches[Math.min(callIndex, matches.length - 1)];
  }

  // ── Tab-open hook (existing logic) ──────────────────────────────────────────
  function checkAndOpen(url, body) {
    if (typeof API_HOOKS === 'undefined') return;
    if (!document.documentElement.hasAttribute('data-hdfc-replay')) return;
    const hook = API_HOOKS.find(h => url.includes(h.urlPattern));
    if (!hook) return;
    try {
      const tabUrl = hook.extractUrl(body);
      if (tabUrl) {
        console.log('[HDFC] api-hook: opening tab →', tabUrl);
        window.dispatchEvent(new CustomEvent('__hdfc_open_tab__', { detail: { url: tabUrl } }));
      }
    } catch (err) {
      console.error('[HDFC] api-hook error:', err);
    }
  }

  // ── fetch ───────────────────────────────────────────────────────────────────
  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
    const options = args[1] || {};
    const method = (options.method || 'GET').toUpperCase();
    const bodyStr = normalizeBody(options.body);
    const isReplay = document.documentElement.hasAttribute('data-hdfc-replay');

    // Replay: serve recorded response directly (no real network call).
    if (isReplay && _virtualResponses.length > 0) {
      const match = findVirtualResponse(url, method);
      if (match) {
        console.log('[HDFC:virt] ✓ virtual fetch —', method, url, '| recorded status:', match.status);
        checkAndOpen(url, match.responseBody);
        _inc();
        // Small delay keeps _pending > 0 long enough for the form's rendering
        // pipeline (Angular digest / AEM rule engine) to process the response
        // and update the DOM before waitForNetwork() clears.
        return new Promise(resolve => setTimeout(() =>
          resolve(new Response(match.responseBody, {
            status: match.status,
            headers: new Headers(match.responseHeaders || { 'content-type': 'application/json' }),
          })), 100
        )).finally(() => _dec());
      }
      console.log('[HDFC:virt] → pass-through fetch (no match):', method, url);
    }

    // Real fetch (no virtual match, or not in replay)
    _inc();
    const promise = originalFetch.apply(this, args).finally(() => _dec());

    // Recording: capture all JSON API responses (skipped during replay)
    if (!isReplay) {
      promise.then(async response => {
        try {
          const text = await response.clone().text();
          if (!text.trim()) return;
          const ct = response.headers.get('content-type') || '';
          const looksLikeJson = ct.includes('json') || text.trim().startsWith('{') || text.trim().startsWith('[');
          if (!looksLikeJson) return;
          console.log('[HDFC:virt] ● RECORD fetch —', method, url, '| status:', response.status, '| body length:', text.length);
          document.dispatchEvent(new CustomEvent('__hdfc_api_recorded__', {
            detail: {
              url, method, requestBody: bodyStr,
              status: response.status,
              responseBody: text,
              responseHeaders: Object.fromEntries(response.headers.entries()),
            },
          }));
        } catch { }
      }).catch(() => {});
    }

    // Existing tab-open hook
    if (typeof API_HOOKS !== 'undefined' && API_HOOKS.some(h => url.includes(h.urlPattern))) {
      promise.then(async response => {
        try {
          const text = await response.clone().text();
          checkAndOpen(url, text);
        } catch { }
      }).catch(() => {});
    }

    return promise;
  };

  // ── XHR ─────────────────────────────────────────────────────────────────────
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._hdfcUrl = url;
    this._hdfcMethod = method;
    return originalOpen.apply(this, [method, url, ...rest]);
  };

  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (body) {
    const url = this._hdfcUrl || '';
    const method = (this._hdfcMethod || 'GET').toUpperCase();
    const bodyStr = normalizeBody(body);
    const isReplay = document.documentElement.hasAttribute('data-hdfc-replay');

    // Replay: serve recorded response directly (no real network call).
    if (isReplay && _virtualResponses.length > 0) {
      const match = findVirtualResponse(url, method);
      if (match) {
        console.log('[HDFC:virt] ✓ virtual XHR —', method, url, '| recorded status:', match.status);
        _inc();
        checkAndOpen(url, match.responseBody);
        const xhr = this;
        // 100ms delay keeps _pending > 0 long enough for the form's rendering
        // pipeline to process the response before waitForNetwork() clears.
        setTimeout(() => {
          try {
            Object.defineProperty(xhr, 'status', { value: match.status, configurable: true });
            Object.defineProperty(xhr, 'readyState', { value: 4, configurable: true });
            Object.defineProperty(xhr, 'responseText', { value: match.responseBody, configurable: true });
            Object.defineProperty(xhr, 'response', { value: match.responseBody, configurable: true });
          } catch { }
          xhr.dispatchEvent(new ProgressEvent('readystatechange'));
          xhr.dispatchEvent(new ProgressEvent('load'));
          xhr.dispatchEvent(new ProgressEvent('loadend'));
          _dec();
        }, 100);
        return;
      }
      console.log('[HDFC:virt] → pass-through XHR (no match):', method, url);
    }

    // Real XHR
    _inc();
    this.addEventListener('loadend', () => {
      _dec();
      if (url) {
        checkAndOpen(url, this.responseText || '');
        // Recording: capture all JSON API responses (skipped during replay)
        if (!isReplay) {
          const responseText = this.responseText || '';
          if (responseText.trim()) {
            const ct = (() => { try { return this.getResponseHeader('content-type') || ''; } catch { return ''; } })();
            const looksLikeJson = ct.includes('json') || responseText.trim().startsWith('{') || responseText.trim().startsWith('[');
            if (looksLikeJson) {
              console.log('[HDFC:virt] ● RECORD XHR —', method, url, '| status:', this.status, '| body length:', responseText.length);
              document.dispatchEvent(new CustomEvent('__hdfc_api_recorded__', {
                detail: {
                  url, method, requestBody: bodyStr,
                  status: this.status,
                  responseBody: responseText,
                  responseHeaders: {},
                },
              }));
            }
          }
        }
      }
    });
    return originalSend.apply(this, [body]);
  };
})();
