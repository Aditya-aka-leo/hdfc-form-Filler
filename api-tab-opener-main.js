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

  // ── fetch ──
  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
    _inc();
    const promise = originalFetch.apply(this, args).finally(() => _dec());
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

  // ── XHR ──
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._hdfcUrl = url;
    return originalOpen.apply(this, [method, url, ...rest]);
  };

  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    _inc();
    this.addEventListener('loadend', () => {
      _dec();
      if (this._hdfcUrl) checkAndOpen(this._hdfcUrl, this.responseText || '');
    });
    return originalSend.apply(this, args);
  };
})();
