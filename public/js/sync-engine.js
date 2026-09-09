/**
 * SkyHonix Sync Engine
 * Processes the offline action queue when connectivity is available.
 * Handles dependency resolution, ID mapping, conflict detection, and retry logic.
 */
(function () {
  'use strict';

  let _isSyncing = false;
  let _syncTimer = null;
  let _abortController = null;

  function isSyncing() { return _isSyncing; }

  function emit(name, detail) {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }

  // Get auth token for sync requests
  function getToken() {
    return localStorage.getItem('skyhonix_token');
  }

  // Execute a single HTTP request
  async function executeRequest(operation, endpoint, payload, isFormData) {
    const token = getToken();
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (!isFormData) headers['Content-Type'] = 'application/json';

    // Idempotency key to prevent duplicate records on retry
    headers['X-Idempotency-Key'] = action.id || window.SkyOfflineDB.generateLocalId();

    const options = { method: operation === 'DELETE' ? 'DELETE' : operation === 'UPDATE' ? 'PUT' : 'POST', headers };
    if (payload && operation !== 'DELETE') {
      options.body = isFormData ? payload : JSON.stringify(payload);
    }

    const response = await fetch(endpoint, options);
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('Invalid server response'); }

    if (!response.ok) {
      const err = new Error(data.error || `HTTP ${response.status}`);
      err.status = response.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // Resolve endpoint for an action
  function resolveEndpoint(action) {
    const e = action.entity;
    const op = action.operation;
    const id = action.entityId;
    const mapping = action.payload._serverId || id;

    const routes = {
      student: {
        CREATE: '/api/students',
        UPDATE: `/api/students/${mapping}`,
        DELETE: `/api/students/${mapping}/archive`
      },
      attendance: {
        CREATE: '/api/attendance/save',
        UPDATE: '/api/attendance/save',
        DELETE: null // Not supported
      },
      fee: {
        CREATE: '/api/fees/pay',
        UPDATE: '/api/fees/pay',
        DELETE: `/api/fees/ledger/${mapping}`
      },
      exam: {
        CREATE: '/api/exams',
        UPDATE: `/api/exams/${mapping}`,
        DELETE: `/api/exams/subjects/${mapping}`
      },
      marks: {
        CREATE: '/api/exams/marks',
        UPDATE: '/api/exams/marks',
        DELETE: null
      },
      announcement: {
        CREATE: '/api/staff/announcements',
        UPDATE: `/api/staff/announcements/${mapping}`,
        DELETE: `/api/staff/announcements/${mapping}`
      },
      teacher: {
        CREATE: '/api/staff/teachers',
        UPDATE: `/api/staff/teachers/${mapping}`,
        DELETE: `/api/staff/teachers/${mapping}`
      },
      fee_setup: {
        CREATE: '/api/fees/setup',
        UPDATE: '/api/fees/setup',
        DELETE: null
      },
      fee_dues: {
        CREATE: '/api/fees/dues',
        UPDATE: '/api/fees/dues',
        DELETE: null
      },
      assignment: {
        CREATE: '/api/teachers/assignments',
        UPDATE: `/api/teachers/assignments/${mapping}`,
        DELETE: `/api/teachers/assignments/${mapping}`
      },
      exam_subject: {
        CREATE: '/api/exams/subjects',
        UPDATE: `/api/exams/subjects/${mapping}`,
        DELETE: `/api/exams/subjects/${mapping}`
      },
      settings: {
        CREATE: '/api/settings',
        UPDATE: '/api/settings',
        DELETE: null
      },
      vehicle: {
        CREATE: '/api/transport/vehicles',
        UPDATE: `/api/transport/vehicles/${mapping}`,
        DELETE: `/api/transport/vehicles/${mapping}`
      },
      driver: {
        CREATE: '/api/transport/drivers',
        UPDATE: `/api/transport/drivers/${mapping}`,
        DELETE: `/api/transport/drivers/${mapping}`
      },
      route: {
        CREATE: '/api/transport/routes',
        UPDATE: `/api/transport/routes/${mapping}`,
        DELETE: `/api/transport/routes/${mapping}`
      },
      parent: {
        CREATE: '/api/staff/parents',
        UPDATE: `/api/staff/parents/${mapping}`,
        DELETE: `/api/staff/parents/${mapping}`
      }
    };

    const entityRoutes = routes[e];
    if (!entityRoutes) return null;
    return entityRoutes[op] || null;
  }

  // Process a single action
  async function processAction(action) {
    await window.SkySyncQueue.markSyncing(action.id);
    emit('sky:sync-progress', { action, phase: 'sending' });

    const endpoint = resolveEndpoint(action);
    if (!endpoint) {
      await window.SkySyncQueue.markFailed(action.id, 'No route defined for this operation');
      return false;
    }

    try {
      const payload = { ...action.payload };
      delete payload._serverId;
      delete payload._localId;

      const data = await executeRequest(action.operation, endpoint, payload, payload._isFormData);
      delete payload._isFormData;

      // Handle ID mapping for CREATE operations
      if (action.operation === 'CREATE' && data) {
        const serverId = data.id || data.studentId || data.teacherId || data.insertedId;
        if (serverId) {
          await window.SkyOfflineDB.mapLocalToServer(action.entityId, serverId);
          // Update any pending child actions that reference this local ID
          await remapChildren(action.entityId, serverId);
        }
      }

      // Update local record sync status
      if (action.payload._localId) {
        const localRecord = await window.SkyOfflineDB.getLocalRecord(action.payload._localId);
        if (localRecord) {
          localRecord.syncStatus = 'synced';
          localRecord.serverId = data?.id || action.entityId;
          await window.SkyOfflineDB.updateLocalRecord(localRecord);
        }
      }

      await window.SkySyncQueue.markCompleted(action.id);
      emit('sky:sync-progress', { action, phase: 'completed', data });
      return true;

    } catch (err) {
      // Conflict detection: 409 or specific error
      if (err.status === 409) {
        await window.SkySyncQueue.markFailed(action.id, 'CONFLICT: ' + (err.data?.message || 'Server has newer data'));
        emit('sky:conflict', { action, serverData: err.data });
        return false;
      }

      // Auth error — don't retry, wait for re-login
      if (err.status === 401 || err.status === 403) {
        await window.SkySyncQueue.markFailed(action.id, 'AUTH: Session expired');
        return false;
      }

      // Validation error — don't retry
      if (err.status === 400 || err.status === 422) {
        await window.SkySyncQueue.markFailed(action.id, 'VALIDATION: ' + err.message);
        return false;
      }

      // Network/server error — retry later
      await window.SkySyncQueue.markFailed(action.id, err.message);
      return false;
    }
  }

  // Remap child actions when parent ID is resolved
  async function remapChildren(oldLocalId, newServerId) {
    const pending = await window.SkySyncQueue.getPending();
    for (const item of pending) {
      if (item.entityId === oldLocalId) {
        item.entityId = newServerId;
        if (item.payload) {
          // Update any references to the old local ID in the payload
          for (const key of Object.keys(item.payload)) {
            if (item.payload[key] === oldLocalId) {
              item.payload[key] = newServerId;
            }
          }
        }
        await window.SkyOfflineDB.updateSyncQueueItem(item);
      }
      // Also fix parentId references
      if (item.parentId === oldLocalId) {
        item.parentId = newServerId;
        await window.SkyOfflineDB.updateSyncQueueItem(item);
      }
    }
  }

  // Main sync loop
  async function syncNow() {
    if (_isSyncing) return;
    if (!SkyNetwork.isServerReachable()) return;

    _isSyncing = true;
    emit('sky:syncing', { timestamp: new Date().toISOString() });

    try {
      const actions = await window.SkySyncQueue.getOrderedPending();
      let successCount = 0;
      let failCount = 0;

      for (const action of actions) {
        // Re-check connectivity before each action
        if (!SkyNetwork.isServerReachable()) break;

        const success = await processAction(action);
        if (success) {
          successCount++;
        } else {
          failCount++;
          if (action.status === 'failed' && action.retryCount >= 5) {
            // Don't stop for permanently failed items
            continue;
          }
          // If it's a dependency failure, skip children
          if (action.parentId) {
            const parentMapping = await window.SkyOfflineDB.getServerId(action.parentId);
            if (!parentMapping) {
              // Parent not yet synced, skip this and siblings
              continue;
            }
          }
        }

        // Small delay between requests to not overwhelm server
        await new Promise(r => setTimeout(r, 200));
      }

      await window.SkyOfflineDB.setMeta('lastSyncTime', new Date().toISOString());
      await window.SkyOfflineDB.clearExpiredCache();

      emit('sky:synced', { successCount, failCount, timestamp: new Date().toISOString() });

    } catch (err) {
      console.error('Sync engine error:', err);
      emit('sky:sync-error', { error: err.message });
    } finally {
      _isSyncing = false;
    }
  }

  // Start auto-sync on connectivity events
  function startAutoSync() {
    window.addEventListener('sky:online', () => {
      // Delay slightly to let connection stabilize
      setTimeout(syncNow, 1500);
    });

    window.addEventListener('focus', () => {
      if (SkyNetwork.isServerReachable() && !_isSyncing) {
        SkySyncQueue.getPending().then(pending => {
          if (pending.length > 0) setTimeout(syncNow, 500);
        });
      }
    });

    // Sync on app startup if pending items exist
    setTimeout(async () => {
      const pending = await window.SkySyncQueue.getPending();
      if (pending.length > 0 && SkyNetwork.isServerReachable()) {
        syncNow();
      }
    }, 3000);
  }

  function stopAutoSync() {
    if (_syncTimer) clearInterval(_syncTimer);
  }

  window.SkySyncEngine = {
    isSyncing,
    syncNow,
    startAutoSync,
    stopAutoSync,
    processAction,
    resolveEndpoint
  };
})();
