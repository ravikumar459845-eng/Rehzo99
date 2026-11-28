(function () {
  var alertTimer = null;
  var lastAlertKey = '';
  var lastAlertAt = 0;
  window.dismissrehzo99SystemAlert = function () {
    var box = document.getElementById('rehzo99SystemAlert');
    if (box) box.hidden = true;
    if (alertTimer) { clearTimeout(alertTimer); alertTimer = null; }
  };
  window.showrehzo99SystemAlert = function (message, title) {
    var box = document.getElementById('rehzo99SystemAlert');
    var body = document.getElementById('rehzo99SystemAlertMessage');
    var heading = document.getElementById('rehzo99SystemAlertTitle');
    if (!box || !body || !heading) return;
    var safeMessage = String(message || 'Please try again.').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, 240);
    if (!safeMessage) safeMessage = 'Please try again.';
    var key = (title || 'Something went wrong') + ':' + safeMessage;
    var now = Date.now();
    if (key === lastAlertKey && now - lastAlertAt < 3000) return;
    lastAlertKey = key;
    lastAlertAt = now;
    heading.textContent = String(title || 'Something went wrong').slice(0, 80);
    body.textContent = safeMessage;
    box.hidden = false;
    if (alertTimer) clearTimeout(alertTimer);
    alertTimer = setTimeout(function () { box.hidden = true; }, 8000);
  };
  function safeUnexpectedError() {
    return 'An unexpected error occurred. Please refresh the page and try again.';
  }
  window.addEventListener('error', function (event) {
    // Keep diagnostics in the browser console, but never expose internal details to users.
    if (event && event.target && event.target !== window) {
      console.error('REHZO 99 resource load failure:', event.target.src || event.target.href || event.target.tagName || 'unknown resource');
      window.showrehzo99SystemAlert('A page resource could not load. Check your connection and refresh if needed.', 'Loading problem');
      return;
    }
    if (event) {
      console.error('REHZO 99 JavaScript error:', {
        message: event.message || 'Unknown script error',
        source: event.filename || 'unknown source',
        line: event.lineno || 0,
        column: event.colno || 0,
        error: event.error || null
      });
    }
    window.showrehzo99SystemAlert(safeUnexpectedError(), 'App error');
  }, true);
  window.addEventListener('unhandledrejection', function (event) {
    // Log technical details for diagnosis without blocking the user's screen with a
    // generic popup for recoverable background requests (auth refresh/realtime).
    console.warn('Background request failed:', event && event.reason ? event.reason : 'Unknown rejection');
    if (!navigator.onLine) {
      window.showrehzo99SystemAlert('You appear to be offline. Check your connection and retry.', 'Connection lost');
    }
    // Prevent browser-level unhandled rejection noise; explicit user actions still
    // display their own safe, actionable error messages.
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
  });
  window.addEventListener('offline', function () {
    window.showrehzo99SystemAlert('You are offline. Check your internet connection; changes may not be saved.', 'Connection lost');
  });
  window.addEventListener('online', function () {
    window.showrehzo99SystemAlert('Connection restored. Please retry any action that did not finish.', 'Back online');
  });
})();
