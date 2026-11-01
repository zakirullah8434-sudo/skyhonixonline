/*
 * SkyHonix section history
 *
 * Turns each portal into a real browser-history stack so the Android back
 * button behaves the way a native app does — one level per press:
 *
 *   dashboard -> section -> subsection   (back) -> subsection closed
 *              (back) -> section         (back) -> dashboard
 *              (back) -> exit the app (no logout)
 *
 * Two modes:
 *
 * 1. Explicit mode (school portal) — the portal records navigation itself
 *    through visit()/subvisit()/back(). A history entry is pushed exactly
 *    when the user really navigated, and the entry's state is re-applied
 *    through cfg.apply() on popstate:
 *
 *      SkyHonixSectionHistory.init({
 *        apply: (state) => showSectionAndMaybeSub(state.section, state.sub),
 *        home:  'dashboard'
 *      });
 *
 * 2. Legacy MutationObserver mode (teacher & parent portals) — watches the
 *    DOM for the portal's own section switching (all switches end up
 *    toggling style.display / the active class), pushes a history entry
 *    whenever the visible section changes, and re-applies the section
 *    stored in the entry when popstate fires:
 *
 *      SkyHonixSectionHistory.init({
 *        getActive: () => currentSectionKeyOrNull,  // null = "not restorable"
 *        setActive: (key) => showThatSection,
 *        initial:   () => firstSectionKey
 *      });
 */
(function () {
  'use strict';

  if (typeof window === 'undefined' || !window.history || !window.history.pushState) return;

  var cfg = null;
  var mode = null; // 'explicit' | 'legacy'
  var initialized = false;

  // Legacy (MutationObserver) state
  var current = null;
  var restoring = false;
  var scheduled = false;

  // Explicit state
  var currentNav = null; // { section, sub }
  var depth = 0;         // pushed entries (so back() knows if it can pop)

  function historyUrl() {
    try {
      return window.location.pathname + window.location.search;
    } catch (e) {
      return '';
    }
  }

  function sameNav(a, b) {
    if (!a || !b) return false;
    return a.section === b.section && (a.sub || null) === (b.sub || null);
  }

  // ============================================================
  // Explicit mode (school portal)
  // ============================================================
  function markNav(nav) {
    currentNav = nav;
    try {
      window.history.replaceState({ skySection: nav.section, skySub: nav.sub || null }, '', historyUrl());
    } catch (e) { /* ignore */ }
  }

  function pushNav(nav) {
    currentNav = nav;
    try {
      window.history.pushState({ skySection: nav.section, skySub: nav.sub || null }, '', historyUrl());
    } catch (e) { return; }
    depth++;
  }

  function onPopStateExplicit(event) {
    if (!cfg) return;
    var s = (event && event.state) || {};
    var nav = {
      section: (typeof s.skySection === 'string' && s.skySection) || (cfg.home || 'dashboard'),
      sub: (typeof s.skySub === 'string' && s.skySub) || null
    };
    if (depth > 0) depth--;
    if (sameNav(nav, currentNav)) {
      currentNav = nav;
      return;
    }
    currentNav = nav;
    try {
      if (typeof cfg.apply === 'function') cfg.apply(nav);
    } catch (e) { /* ignore */ }
  }

  // ============================================================
  // Legacy mode (teacher & parent portals) — MutationObserver
  // ============================================================
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

  function onPopStateLegacy(event) {
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

      if (typeof cfg.apply === 'function') {
        // Explicit mode: history entries are pushed by visit()/subvisit().
        mode = 'explicit';
        markNav({ section: cfg.home || 'dashboard', sub: null });
        window.addEventListener('popstate', onPopStateExplicit, false);
        return;
      }

      // Legacy mode: watch the DOM for section switches.
      mode = 'legacy';
      var start = detect() || initialKey();
      if (start) markCurrent(start);

      window.addEventListener('popstate', onPopStateLegacy, false);

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

    // --- explicit-mode API (school portal) ---

    // The user opened a top-level section (sidebar tap, dashboard card, ...).
    visit: function (section, sub) {
      if (mode !== 'explicit') return;
      var nav = { section: section || 'dashboard', sub: sub || null };
      if (sameNav(nav, currentNav)) return; // no duplicate entries
      pushNav(nav);
    },

    // The user opened a subsection (option panel) inside the current section.
    subvisit: function (sub) {
      if (mode !== 'explicit' || !currentNav) return;
      var nav = { section: currentNav.section, sub: sub || null };
      if (sameNav(nav, currentNav)) return;
      pushNav(nav);
    },

    // Pop the current entry (used by "Back" buttons inside subsections and
    // by section back buttons). Returns true when history.back() was used,
    // false when the stack has nothing to pop (caller runs its fallback).
    back: function () {
      if (mode !== 'explicit') return false;
      if (depth > 0) {
        try { window.history.back(); return true; } catch (e) { /* fall through */ }
      }
      return false;
    },

    // --- shared / legacy API ---
    refresh: function () { if (mode === 'legacy') checkForChange(); },
    current: function () {
      return mode === 'explicit' ? (currentNav && currentNav.section) : current;
    }
  };
})();
