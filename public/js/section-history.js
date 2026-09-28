/*
 * SkyHonix section history
 *
 * Turns each portal into a real browser-history stack so the Android back
 * button behaves the way a native app does:
 *
 *   dashboard -> section A -> section B   (back)  -> section A
 *   dashboard                             (back)  -> close the app (no logout)
 *
 * It works by watching the DOM for the portal's own section switching (all
 * switches end up toggling style.display / the active class), pushing a
 * history entry whenever the visible section changes, and re-applying the
 * section stored in the entry when popstate fires.
 *
 * Usage (per portal):
 *   SkyHonixSectionHistory.init({
 *     getActive: () => currentSectionKeyOrNull,   // null = "not restorable", no push
 *     setActive: (key) => showThatSection,
 *     initial:   () => firstSectionKey
 *   });
 */
(function () {
  'use strict';

  if (typeof window === 'undefined' || !window.history || !window.history.pushState) return;

  var cfg = null;
  var current = null;
  var restoring = false;
  var scheduled = false;
  var initialized = false;

  function detect() {
    if (!cfg || typeof cfg.getActive !== 'function') return null;
    try {
      var key = cfg.getActive();
      return (typeof key === 'string' && key) ? key : null;
    } catch (e) {
      return null;
    }
  }

  function initialKey() {
    if (!cfg || typeof cfg.initial !== 'function') return null;
    try {
      var key = cfg.initial();
      return (typeof key === 'string' && key) ? key : null;
    } catch (e) {
      return null;
    }
  }

  function historyUrl() {
    try {
      return window.location.pathname + window.location.search;
    } catch (e) {
      return '';
    }
  }

  function markCurrent(key) {
    current = key;
    try {
      window.history.replaceState({ skySection: key }, '', historyUrl());
    } catch (e) { /* ignore */ }
  }

  function pushCurrent(key) {
    current = key;
    try {
      window.history.pushState({ skySection: key }, '', historyUrl());
    } catch (e) { /* ignore */ }
  }

  function checkForChange() {
    if (scheduled || restoring || !cfg) return;
    scheduled = true;
    setTimeout(function () {
      scheduled = false;
      if (restoring || !cfg) return;
      var key = detect();
      if (key && key !== current) pushCurrent(key);
    }, 0);
  }

  function onPopState(event) {
    if (!cfg) return;
    var key = null;
    if (event && event.state && typeof event.state.skySection === 'string') {
      key = event.state.skySection;
    }
    if (!key) key = initialKey();
    if (!key) key = detect();
    if (!key || key === current) {
      current = key || current;
      return;
    }

    restoring = true;
    current = key;
    try {
      if (typeof cfg.setActive === 'function') cfg.setActive(key);
    } catch (e) { /* ignore */ }

    // Give the section a moment to settle before we trust the DOM again,
    // otherwise the mutation observer would push the change right back.
    setTimeout(function () { restoring = false; }, 40);
  }

  window.SkyHonixSectionHistory = {
    init: function (options) {
      if (initialized || !options) return;
      initialized = true;
      cfg = options;

      var start = detect() || initialKey();
      if (start) markCurrent(start);

      window.addEventListener('popstate', onPopState, false);

      if (window.MutationObserver && document.body) {
        var observer = new MutationObserver(checkForChange);
        observer.observe(document.body, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ['style', 'class', 'hidden']
        });
      }
    },
    refresh: function () { checkForChange(); },
    current: function () { return current; }
  };
})();
