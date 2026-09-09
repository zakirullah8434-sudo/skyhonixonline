/**
 * SkyHonix Sync Queue Manager
 * Manages the offline action queue with deduplication, dependency resolution,
 * and exponential backoff retry logic.
 */
(function () {
  'use strict';

  const MAX_RETRIES = 5;
  const BASE_DELAY_MS = 2000;
  const MAX_DELAY_MS = 60000;

  function createQueueItem({ operation, entity, entityId, payload, parentId, metadata }) {
    return {
      id: window.SkyOfflineDB.generateLocalId(),
      operation,       // CREATE | UPDATE | DELETE
      entity,          // student | attendance | fee | exam | marks | etc
      entityId,        // local or server ID
      payload: payload || {},
      parentId: parentId || null,  // dependency: must sync parent first
      metadata: metadata || {},    // userId, schoolId, role, etc
      timestamp: new Date().toISOString(),
      retryCount: 0,
      lastAttempt: null,
      lastError: null,
      status: 'pending'  // pending | syncing | failed | completed
    };
  }

  async function enqueue(opts) {
    const item = createQueueItem(opts);
    await window.SkyOfflineDB.addToSyncQueue(item);
    window.dispatchEvent(new CustomEvent('sky:queue-changed', { detail: { action: 'added', item } }));
    return item;
  }

  async function getPending() {
    return window.SkyOfflineDB.getSyncQueue('pending');
  }

  async function getAll() {
    return window.SkyOfflineDB.getSyncQueue();
  }

  async function markSyncing(id) {
    const item = await window.SkyOfflineDB.getSyncQueueItem(id);
    if (!item) return;
    item.status = 'syncing';
    item.lastAttempt = new Date().toISOString();
    await window.SkyOfflineDB.updateSyncQueueItem(item);
    return item;
  }

  async function markCompleted(id) {
    const item = await window.SkyOfflineDB.getSyncQueueItem(id);
    if (!item) return;
    item.status = 'completed';
    await window.SkyOfflineDB.updateSyncQueueItem(item);
    // Remove after brief delay to allow reads
    setTimeout(() => window.SkyOfflineDB.removeSyncQueueItem(id), 5000);
    window.dispatchEvent(new CustomEvent('sky:queue-changed', { detail: { action: 'completed', item } }));
    return item;
  }

  async function markFailed(id, error) {
    const item = await window.SkyOfflineDB.getSyncQueueItem(id);
    if (!item) return;
    item.retryCount++;
    item.lastError = error;
    if (item.retryCount >= MAX_RETRIES) {
      item.status = 'failed';
    } else {
      item.status = 'pending';
    }
    await window.SkyOfflineDB.updateSyncQueueItem(item);
    window.dispatchEvent(new CustomEvent('sky:queue-changed', { detail: { action: 'failed', item } }));
    return item;
  }

  function getRetryDelay(retryCount) {
    const delay = BASE_DELAY_MS * Math.pow(2, retryCount);
    return Math.min(delay + Math.random() * 1000, MAX_DELAY_MS);
  }

  // Deduplicate: if same entity + entityId + operation exists as pending, merge payloads
  async function deduplicate(queueItem) {
    const pending = await window.SkyOfflineDB.getSyncQueue('pending');
    const existing = pending.find(p =>
      p.entity === queueItem.entity &&
      p.entityId === queueItem.entityId &&
      p.operation === queueItem.operation &&
      p.id !== queueItem.id
    );

    if (existing) {
      if (queueItem.operation === 'UPDATE') {
        // Merge: keep the latest payload
        existing.payload = { ...existing.payload, ...queueItem.payload };
        existing.timestamp = queueItem.timestamp;
        existing.retryCount = 0;
        await window.SkyOfflineDB.updateSyncQueueItem(existing);
        // Remove the duplicate
        await window.SkyOfflineDB.removeSyncQueueItem(queueItem.id);
        return existing;
      } else if (queueItem.operation === 'CREATE') {
        // Double create — remove the duplicate
        await window.SkyOfflineDB.removeSyncQueueItem(queueItem.id);
        return existing;
      }
    }
    return queueItem;
  }

  // Get items ordered by dependencies (parentId must come first)
  function topologicalSort(items) {
    const map = new Map(items.map(i => [i.id, i]));
    const resolved = [];
    const seen = new Set();

    function resolve(item) {
      if (seen.has(item.id)) return;
      if (item.parentId && map.has(item.parentId)) {
        resolve(map.get(item.parentId));
      }
      seen.add(item.id);
      resolved.push(item);
    }

    items.forEach(resolve);
    return resolved;
  }

  async function getOrderedPending() {
    let pending = await getPending();
    pending = pending.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    return topologicalSort(pending);
  }

  async function getFailedCount() {
    const all = await window.SkyOfflineDB.getSyncQueue('failed');
    return all.length;
  }

  async function getStats() {
    const all = await window.SkyOfflineDB.getSyncQueue();
    return {
      pending: all.filter(i => i.status === 'pending').length,
      syncing: all.filter(i => i.status === 'syncing').length,
      failed: all.filter(i => i.status === 'failed').length,
      completed: all.filter(i => i.status === 'completed').length,
      total: all.length
    };
  }

  async function retryFailed() {
    const all = await window.SkyOfflineDB.getSyncQueue('failed');
    for (const item of all) {
      item.status = 'pending';
      item.retryCount = 0;
      await window.SkyOfflineDB.updateSyncQueueItem(item);
    }
    window.dispatchEvent(new CustomEvent('sky:queue-changed', { detail: { action: 'retry-all' } }));
  }

  window.SkySyncQueue = {
    enqueue,
    getPending,
    getAll,
    getOrderedPending,
    markSyncing,
    markCompleted,
    markFailed,
    getRetryDelay,
    deduplicate,
    getFailedCount,
    getStats,
    retryFailed,
    createQueueItem
  };
})();
