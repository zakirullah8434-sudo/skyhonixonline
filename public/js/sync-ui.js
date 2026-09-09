/**
 * SkyHonix Sync Status UI
 * Professional network/sync status indicator for the portal.
 * Shows: Online, Offline, Syncing, Synced, Failed items.
 */
(function () {
  'use strict';

  let _indicator = null;
  let _detailPanel = null;
  let _updateTimer = null;

  function create() {
    if (_indicator) return;

    // Main indicator bar
    _indicator = document.createElement('div');
    _indicator.id = 'sky-sync-indicator';
    _indicator.innerHTML = `
      <div class="sky-sync-bar">
        <span class="sky-sync-dot"></span>
        <span class="sky-sync-text">Checking...</span>
        <span class="sky-sync-badge" style="display:none;">0</span>
        <button class="sky-sync-detail-btn" title="Sync Details" style="display:none;">&#9660;</button>
      </div>
      <div class="sky-sync-detail" style="display:none;">
        <div class="sky-sync-detail-row">
          <span>Last sync:</span>
          <span id="sky-last-sync">Never</span>
        </div>
        <div class="sky-sync-detail-row">
          <span>Pending changes:</span>
          <span id="sky-pending-count">0</span>
        </div>
        <div class="sky-sync-detail-row">
          <span>Failed:</span>
          <span id="sky-failed-count" style="color:#ff5252;">0</span>
        </div>
        <div class="sky-sync-actions">
          <button id="sky-sync-now-btn" class="btn btn-primary btn-sm">Sync Now</button>
          <button id="sky-retry-failed-btn" class="btn btn-secondary btn-sm" style="display:none;">Retry Failed</button>
        </div>
      </div>
    `;

    // Inject styles if not already present
    if (!document.getElementById('sky-sync-styles')) {
      const style = document.createElement('style');
      style.id = 'sky-sync-styles';
      style.textContent = `
        #sky-sync-indicator {
          position: fixed;
          bottom: 0;
          right: 0;
          z-index: 99999;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          font-size: 13px;
          user-select: none;
        }
        .sky-sync-bar {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 16px;
          background: rgba(30, 30, 30, 0.95);
          color: #fff;
          border-radius: 12px 0 0 0;
          cursor: pointer;
          backdrop-filter: blur(10px);
          border: 1px solid rgba(255,255,255,0.08);
          border-bottom: none;
          border-right: none;
          transition: all 0.3s ease;
        }
        .sky-sync-bar:hover {
          background: rgba(40, 40, 40, 0.98);
        }
        .sky-sync-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #4caf50;
          flex-shrink: 0;
          transition: background 0.3s ease;
        }
        .sky-sync-dot.offline { background: #ff5252; }
        .sky-sync-dot.syncing {
          background: #ffb142;
          animation: sky-pulse 1s infinite;
        }
        .sky-sync-dot.failed { background: #ff5252; }
        .sky-sync-text { white-space: nowrap; }
        .sky-sync-badge {
          background: #ff5252;
          color: #fff;
          border-radius: 10px;
          padding: 1px 7px;
          font-size: 11px;
          font-weight: 600;
          min-width: 18px;
          text-align: center;
        }
        .sky-sync-detail-btn {
          background: none;
          border: none;
          color: rgba(255,255,255,0.6);
          cursor: pointer;
          font-size: 10px;
          padding: 2px 4px;
        }
        .sky-sync-detail {
          background: rgba(30, 30, 30, 0.98);
          color: #fff;
          padding: 12px 16px;
          border-radius: 0;
          border: 1px solid rgba(255,255,255,0.08);
          border-bottom: none;
          border-right: none;
          min-width: 220px;
          backdrop-filter: blur(10px);
        }
        .sky-sync-detail-row {
          display: flex;
          justify-content: space-between;
          padding: 4px 0;
          font-size: 12px;
          color: rgba(255,255,255,0.7);
        }
        .sky-sync-detail-row span:last-child {
          color: #fff;
          font-weight: 500;
        }
        .sky-sync-actions {
          display: flex;
          gap: 8px;
          margin-top: 10px;
          padding-top: 10px;
          border-top: 1px solid rgba(255,255,255,0.1);
        }
        .sky-sync-actions .btn {
          flex: 1;
          padding: 6px 10px;
          font-size: 11px;
          border-radius: 6px;
          border: none;
          cursor: pointer;
          font-weight: 500;
        }
        .sky-sync-actions .btn-primary {
          background: #6366f1;
          color: #fff;
        }
        .sky-sync-actions .btn-primary:hover { background: #5558e6; }
        .sky-sync-actions .btn-secondary {
          background: rgba(255,255,255,0.1);
          color: #fff;
        }
        .sky-sync-actions .btn-secondary:hover { background: rgba(255,255,255,0.15); }
        @keyframes sky-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
        .sky-sync-toast {
          position: fixed;
          bottom: 50px;
          right: 20px;
          z-index: 100000;
          padding: 10px 18px;
          border-radius: 8px;
          font-size: 13px;
          color: #fff;
          animation: sky-toast-in 0.3s ease;
          pointer-events: none;
        }
        .sky-sync-toast.success { background: rgba(76, 175, 80, 0.95); }
        .sky-sync-toast.warning { background: rgba(255, 177, 66, 0.95); }
        .sky-sync-toast.error { background: rgba(255, 82, 82, 0.95); }
        .sky-sync-toast.info { background: rgba(33, 150, 243, 0.95); }
        @keyframes sky-toast-in {
          from { transform: translateY(20px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
      `;
      document.head.appendChild(style);
    }

    document.body.appendChild(_indicator);

    // Toggle detail panel
    const bar = _indicator.querySelector('.sky-sync-bar');
    const detail = _indicator.querySelector('.sky-sync-detail');
    const detailBtn = _indicator.querySelector('.sky-sync-detail-btn');

    bar.addEventListener('click', (e) => {
      if (e.target.closest('.sky-sync-detail-btn')) return;
      detail.style.display = detail.style.display === 'none' ? 'block' : 'none';
    });

    detailBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      detail.style.display = detail.style.display === 'none' ? 'block' : 'none';
    });

    // Sync Now button
    _indicator.querySelector('#sky-sync-now-btn').addEventListener('click', () => {
      if (window.SkySyncEngine) window.SkySyncEngine.syncNow();
    });

    // Retry Failed button
    _indicator.querySelector('#sky-retry-failed-btn').addEventListener('click', async () => {
      await window.SkySyncQueue.retryFailed();
      if (window.SkySyncEngine) window.SkySyncEngine.syncNow();
    });

    // Listen for events
    window.addEventListener('sky:online', () => updateStatus('online'));
    window.addEventListener('sky:offline', () => updateStatus('offline'));
    window.addEventListener('sky:syncing', () => updateStatus('syncing'));
    window.addEventListener('sky:synced', (e) => {
      updateStatus('synced');
      showToast('All changes synced successfully', 'success');
    });
    window.addEventListener('sky:sync-progress', (e) => {
      if (e.detail.phase === 'completed') updateCounts();
    });
    window.addEventListener('sky:queue-changed', () => updateCounts());
    window.addEventListener('sky:conflict', (e) => {
      showToast('Sync conflict detected for ' + e.detail.action.entity, 'warning');
    });

    // Initial state
    updateStatus(navigator.onLine ? 'checking' : 'offline');
    updateCounts();

    // Periodic count update
    _updateTimer = setInterval(updateCounts, 15000);
  }

  function updateStatus(state) {
    if (!_indicator) return;
    const dot = _indicator.querySelector('.sky-sync-dot');
    const text = _indicator.querySelector('.sky-sync-text');
    const detailBtn = _indicator.querySelector('.sky-sync-detail-btn');

    dot.className = 'sky-sync-dot';

    switch (state) {
      case 'online':
        dot.classList.add('');
        text.textContent = 'Online';
        detailBtn.style.display = 'inline';
        break;
      case 'offline':
        dot.classList.add('offline');
        text.textContent = 'Offline Mode';
        detailBtn.style.display = 'inline';
        break;
      case 'syncing':
        dot.classList.add('syncing');
        text.textContent = 'Syncing...';
        detailBtn.style.display = 'inline';
        break;
      case 'synced':
        dot.classList.add('');
        text.textContent = 'All synced';
        detailBtn.style.display = 'inline';
        setTimeout(() => {
          if (SkyNetwork.isOnline()) {
            text.textContent = 'Online';
          }
        }, 3000);
        break;
      case 'checking':
        dot.classList.add('syncing');
        text.textContent = 'Connecting...';
        break;
    }
    updateCounts();
  }

  async function updateCounts() {
    if (!_indicator) return;
    try {
      const stats = await window.SkySyncQueue.getStats();
      const badge = _indicator.querySelector('.sky-sync-badge');
      const pendingEl = _indicator.querySelector('#sky-pending-count');
      const failedEl = _indicator.querySelector('#sky-failed-count');
      const lastSyncEl = _indicator.querySelector('#sky-last-sync');
      const retryBtn = _indicator.querySelector('#sky-retry-failed-btn');

      if (pendingEl) pendingEl.textContent = stats.pending + stats.syncing;
      if (failedEl) failedEl.textContent = stats.failed;
      if (retryBtn) retryBtn.style.display = stats.failed > 0 ? 'inline-block' : 'none';

      if (stats.pending + stats.syncing > 0) {
        badge.style.display = 'inline';
        badge.textContent = stats.pending + stats.syncing;
      } else {
        badge.style.display = 'none';
      }

      const lastSync = await window.SkyOfflineDB.getMeta('lastSyncTime');
      if (lastSyncEl) {
        lastSyncEl.textContent = lastSync ? new Date(lastSync).toLocaleString() : 'Never';
      }
    } catch (e) {
      // DB might not be ready yet
    }
  }

  function showToast(message, type) {
    const toast = document.createElement('div');
    toast.className = `sky-sync-toast ${type || 'info'}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  function destroy() {
    if (_indicator) { _indicator.remove(); _indicator = null; }
    if (_updateTimer) clearInterval(_updateTimer);
  }

  window.SkySyncUI = {
    create,
    destroy,
    updateStatus,
    updateCounts,
    showToast
  };
})();
