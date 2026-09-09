/**
 * SkyHonix Network Detection Manager
 * Detects online/offline status with server ping verification.
 * Dispatches custom events: sky:online, sky:offline, sky:syncing, sky:synced
 */
(function () {
  'use strict';

  let _isOnline = navigator.onLine;
  let _isServerReachable = false;
  let _pingInterval = null;
  let _listeners = [];

  function isOnline() { return _isOnline; }
  function isServerReachable() { return _isServerReachable; }

  async function pingServer() {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch('/api/auth/ping', { method: 'HEAD', signal: ctrl.signal, cache: 'no-store' });
      clearTimeout(timer);
      return res.ok || res.status === 404;
    } catch {
      // Fallback: try fetching a small static asset
      try {
        const ctrl2 = new AbortController();
        const timer2 = setTimeout(() => ctrl2.abort(), 5000);
        const res2 = await fetch('/favicon.ico', { method: 'HEAD', signal: ctrl2.signal, cache: 'no-store' });
        clearTimeout(timer2);
        return true;
      } catch {
        return false;
      }
    }
  }

  function emit(event, detail) {
    window.dispatchEvent(new CustomEvent(event, { detail }));
    _listeners.forEach(fn => {
      try { fn(event, detail); } catch (e) { console.error('Network listener error:', e); }
    });
  }

  async function checkServer() {
    const wasReachable = _isServerReachable;
    _isServerReachable = await pingServer();

    if (_isOnline && _isServerReachable && !wasReachable) {
      emit('sky:online', { serverReachable: true });
    } else if (_isOnline && !_isServerReachable) {
      emit('sky:offline', { reason: 'server_unreachable' });
    }
    return _isServerReachable;
  }

  function onOnline() {
    _isOnline = true;
    checkServer().then(reachable => {
      if (reachable) emit('sky:online', { serverReachable: true });
    });
  }

  function onOffline() {
    _isOnline = false;
    _isServerReachable = false;
    emit('sky:offline', { reason: 'network' });
  }

  function start() {
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    // Initial check
    _isOnline = navigator.onLine;
    if (_isOnline) {
      checkServer();
    } else {
      _isServerReachable = false;
    }

    // Periodic server reachability check (every 30s when online)
    _pingInterval = setInterval(() => {
      if (navigator.onLine) checkServer();
    }, 30000);
  }

  function stop() {
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
    if (_pingInterval) clearInterval(_pingInterval);
  }

  function onStatusChange(fn) {
    _listeners.push(fn);
    return () => { _listeners = _listeners.filter(l => l !== fn); };
  }

  // Wait for actual connectivity: tries until server responds
  async function waitForConnectivity(timeoutMs) {
    const start = Date.now();
    const timeout = timeoutMs || 60000;
    while (Date.now() - start < timeout) {
      if (await pingServer()) return true;
      await new Promise(r => setTimeout(r, 2000));
    }
    return false;
  }

  window.SkyNetwork = {
    isOnline,
    isServerReachable,
    pingServer,
    checkServer,
    start,
    stop,
    onStatusChange,
    waitForConnectivity
  };
})();
