/**
 * SkyHonix IndexedDB Offline Database Layer
 * Provides persistent offline storage for sync queue, cached data, and local records.
 * Database: SkyHonixOfflineDB
 * Object Stores:
 *   - syncQueue: pending offline actions
 *   - localRecords: locally created/modified records (keyed by localId)
 *   - idMapping: temporary local IDs → server IDs
 *   - cachedData: cached API responses for offline viewing
 *   - syncMeta: metadata (lastSyncTime, etc.)
 */
(function () {
  'use strict';

  const DB_NAME = 'SkyHonixOfflineDB';
  const DB_VERSION = 1;

  let _db = null;
  let _ready = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    if (_ready) return _ready;

    _ready = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (e) => {
        const db = e.target.result;

        // Sync queue — ordered by timestamp
        if (!db.objectStoreNames.contains('syncQueue')) {
          const sq = db.createObjectStore('syncQueue', { keyPath: 'id' });
          sq.createIndex('status', 'status', { unique: false });
          sq.createIndex('entity', 'entity', { unique: false });
          sq.createIndex('timestamp', 'timestamp', { unique: false });
          sq.createIndex('entityEntityId', ['entity', 'entityId'], { unique: false });
        }

        // Local records — locally created/edited data
        if (!db.objectStoreNames.contains('localRecords')) {
          const lr = db.createObjectStore('localRecords', { keyPath: 'localId' });
          lr.createIndex('entity', 'entity', { unique: false });
          lr.createIndex('syncStatus', 'syncStatus', { unique: false });
          lr.createIndex('serverId', 'serverId', { unique: false });
        }

        // ID mapping: temp local IDs → server IDs
        if (!db.objectStoreNames.contains('idMapping')) {
          db.createObjectStore('idMapping', { keyPath: 'localId' });
        }

        // Cached data for offline viewing
        if (!db.objectStoreNames.contains('cachedData')) {
          const cd = db.createObjectStore('cachedData', { keyPath: 'cacheKey' });
          cd.createIndex('entity', 'entity', { unique: false });
          cd.createIndex('expiry', 'expiry', { unique: false });
        }

        // Metadata
        if (!db.objectStoreNames.contains('syncMeta')) {
          db.createObjectStore('syncMeta', { keyPath: 'key' });
        }
      };

      req.onsuccess = (e) => {
        _db = e.target.result;
        _db.onversionchange = () => { _db.close(); _db = null; _ready = null; };
        resolve(_db);
      };

      req.onerror = (e) => {
        console.error('IndexedDB open failed:', e.target.error);
        reject(e.target.error);
      };
    });

    return _ready;
  }

  // Generic transaction helper
  function tx(storeName, mode) {
    return open().then(db => db.transaction(storeName, mode).objectStore(storeName));
  }

  function req2promise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // ─── Sync Queue Operations ───

  function addToSyncQueue(action) {
    return tx('syncQueue', 'readwrite').then(store => {
      return req2promise(store.put(action));
    });
  }

  function getSyncQueue(status) {
    return tx('syncQueue', 'readonly').then(store => {
      if (status !== undefined) {
        const idx = store.index('status');
        return req2promise(idx.getAll(status));
      }
      return req2promise(store.getAll());
    });
  }

  function getSyncQueueItem(id) {
    return tx('syncQueue', 'readonly').then(store => req2promise(store.get(id)));
  }

  function updateSyncQueueItem(action) {
    return tx('syncQueue', 'readwrite').then(store => req2promise(store.put(action)));
  }

  function removeSyncQueueItem(id) {
    return tx('syncQueue', 'readwrite').then(store => req2promise(store.delete(id)));
  }

  function clearSyncQueue() {
    return tx('syncQueue', 'readwrite').then(store => req2promise(store.clear()));
  }

  function getPendingCount() {
    return tx('syncQueue', 'readonly').then(store => req2promise(store.count('pending')));
  }

  // ─── Local Records Operations ───

  function saveLocalRecord(record) {
    return tx('localRecords', 'readwrite').then(store => req2promise(store.put(record)));
  }

  function getLocalRecord(localId) {
    return tx('localRecords', 'readonly').then(store => req2promise(store.get(localId)));
  }

  function getLocalRecordsByEntity(entity) {
    return tx('localRecords', 'readonly').then(store => {
      const idx = store.index('entity');
      return req2promise(idx.getAll(entity));
    });
  }

  function getLocalRecordsByStatus(syncStatus) {
    return tx('localRecords', 'readonly').then(store => {
      const idx = store.index('syncStatus');
      return req2promise(idx.getAll(syncStatus));
    });
  }

  function updateLocalRecord(record) {
    return tx('localRecords', 'readwrite').then(store => req2promise(store.put(record)));
  }

  function deleteLocalRecord(localId) {
    return tx('localRecords', 'readwrite').then(store => req2promise(store.delete(localId)));
  }

  // ─── ID Mapping Operations ───

  function mapLocalToServer(localId, serverId) {
    return tx('idMapping', 'readwrite').then(store => req2promise(store.put({ localId, serverId })));
  }

  function getServerId(localId) {
    return tx('idMapping', 'readonly').then(store => req2promise(store.get(localId)));
  }

  function getAllMappings() {
    return tx('idMapping', 'readonly').then(store => req2promise(store.getAll()));
  }

  function removeMapping(localId) {
    return tx('idMapping', 'readwrite').then(store => req2promise(store.delete(localId)));
  }

  // ─── Cached Data Operations ───

  function cacheData(cacheKey, entity, data) {
    const entry = {
      cacheKey,
      entity,
      data,
      expiry: Date.now() + (24 * 60 * 60 * 1000), // 24h default
      cachedAt: Date.now()
    };
    return tx('cachedData', 'readwrite').then(store => req2promise(store.put(entry)));
  }

  function getCachedData(cacheKey) {
    return tx('cachedData', 'readonly').then(store => req2promise(store.get(cacheKey)));
  }

  function getCachedDataByEntity(entity) {
    return tx('cachedData', 'readonly').then(store => {
      const idx = store.index('entity');
      return req2promise(idx.getAll(entity));
    });
  }

  function clearExpiredCache() {
    return tx('cachedData', 'readwrite').then(store => {
      const idx = store.index('expiry');
      const range = IDBKeyRange.upperBound(Date.now());
      const req = idx.openCursor(range);
      return new Promise((resolve, reject) => {
        req.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          } else {
            resolve();
          }
        };
        req.onerror = () => reject(req.error);
      });
    });
  }

  // ─── Metadata Operations ───

  function setMeta(key, value) {
    return tx('syncMeta', 'readwrite').then(store => req2promise(store.put({ key, value })));
  }

  function getMeta(key) {
    return tx('syncMeta', 'readonly').then(store => req2promise(store.get(key))).then(r => r ? r.value : null);
  }

  // ─── Utility ───

  function generateLocalId() {
    return 'local_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 9);
  }

  // Export
  window.SkyOfflineDB = {
    open,
    // Sync Queue
    addToSyncQueue,
    getSyncQueue,
    getSyncQueueItem,
    updateSyncQueueItem,
    removeSyncQueueItem,
    clearSyncQueue,
    getPendingCount,
    // Local Records
    saveLocalRecord,
    getLocalRecord,
    getLocalRecordsByEntity,
    getLocalRecordsByStatus,
    updateLocalRecord,
    deleteLocalRecord,
    // ID Mapping
    mapLocalToServer,
    getServerId,
    getAllMappings,
    removeMapping,
    // Cache
    cacheData,
    getCachedData,
    getCachedDataByEntity,
    clearExpiredCache,
    // Meta
    setMeta,
    getMeta,
    // Utility
    generateLocalId
  };
})();
