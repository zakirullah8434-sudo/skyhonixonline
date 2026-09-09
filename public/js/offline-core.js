/**
 * SkyHonix Offline-First Synchronization Engine
 * Centralized: IndexedDB, SyncQueue, NetworkManager, SyncManager, CacheManager
 */
(function() {
  'use strict';
  const DB_NAME = 'skyhonix_offline_db';
  const DB_VERSION = 1;

  class OfflineDB {
    constructor() { this.db = null; this.ready = this._init(); }
    _init() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('sync_queue')) {
            const s = db.createObjectStore('sync_queue', { keyPath: 'actionId' });
            s.createIndex('status', 'status', { unique: false });
            s.createIndex('entity', 'entity', { unique: false });
          }
          if (!db.objectStoreNames.contains('entity_cache')) {
            const c = db.createObjectStore('entity_cache', { keyPath: ['entity', 'id'] });
            c.createIndex('entity', 'entity', { unique: false });
          }
          if (!db.objectStoreNames.contains('id_map')) db.createObjectStore('id_map', { keyPath: 'localId' });
          if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
        };
        req.onsuccess = (e) => { this.db = e.target.result; resolve(this.db); };
        req.onerror = (e) => reject(e.target.error);
      });
    }
    async _store(name, mode) { await this.ready; return this.db.transaction(name, mode).objectStore(name); }
    async getAll(name) { const s = await this._store(name); return new Promise((r, j) => { const q = s.getAll(); q.onsuccess = () => r(q.result); q.onerror = () => j(q.error); }); }
    async get(name, key) { const s = await this._store(name); return new Promise((r, j) => { const q = s.get(key); q.onsuccess = () => r(q.result); q.onerror = () => j(q.error); }); }
    async put(name, data) { const s = await this._store(name, 'readwrite'); return new Promise((r, j) => { const q = s.put(data); q.onsuccess = () => r(q.result); q.onerror = () => j(q.error); }); }
    async delete(name, key) { const s = await this._store(name, 'readwrite'); return new Promise((r, j) => { const q = s.delete(key); q.onsuccess = () => r(); q.onerror = () => j(q.error); }); }
    async clear(name) { const s = await this._store(name, 'readwrite'); return new Promise((r, j) => { const q = s.clear(); q.onsuccess = () => r(); q.onerror = () => j(q.error); }); }
    async getByIndex(name, idx, val) { const s = await this._store(name); const i = s.index(idx); return new Promise((r, j) => { const q = i.getAll(val); q.onsuccess = () => r(q.result); q.onerror = () => j(q.error); }); }
    async count(name) { const s = await this._store(name); return new Promise((r, j) => { const q = s.count(); q.onsuccess = () => r(q.result); q.onerror = () => j(q.error); }); }
  }

  class NetworkManager {
    constructor() { this._online = navigator.onLine; this._listeners = []; this._pingTimer = null; this._apiBase = '';
      window.addEventListener('online', () => { this._online = true; this._notify(); this._verify(); });
      window.addEventListener('offline', () => { this._online = false; this._notify(); });
      document.addEventListener('visibilitychange', () => { if (!document.hidden) this._verify(); });
      window.addEventListener('focus', () => this._verify());
    }
    setApiBase(u) { this._apiBase = u; }
    get isOnline() { return this._online; }
    onChange(cb) { this._listeners.push(cb); }
    _notify() { this._listeners.forEach(cb => cb(this._online)); }
    async _verify() {
      if (!this._apiBase) return;
      try { const c = new AbortController(); const t = setTimeout(() => c.abort(), 5000);
        await fetch(this._apiBase + '/settings', { method: 'HEAD', signal: c.signal, cache: 'no-store' });
        clearTimeout(t); if (!this._online) { this._online = true; this._notify(); }
      } catch(e) {}
    }
    startPing(ms) { this.stopPing(); this._pingTimer = setInterval(() => this._verify(), ms || 30000); }
    stopPing() { if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; } }
  }

  class SyncQueue {
    constructor(db) { this.db = db; }
    genId() { return 'act_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9); }
    async enqueue(a) {
      const r = { actionId: a.actionId || this.genId(), operation: a.operation, entity: a.entity,
        entityId: a.entityId || null, endpoint: a.endpoint, method: a.method, payload: a.payload || {},
        timestamp: new Date().toISOString(), retryCount: 0, maxRetries: 5, status: 'pending',
        userId: a.userId || null, schoolId: a.schoolId || null, dependentOn: a.dependentOn || null, errorMessage: null, lastAttempt: null };
      await this.db.put('sync_queue', r); return r;
    }
    async getPending() { return this.db.getByIndex('sync_queue', 'status', 'pending'); }
    async getFailed() { return this.db.getByIndex('sync_queue', 'status', 'failed'); }
    async getAll() { return this.db.getAll('sync_queue'); }
    async get(id) { return this.db.get('sync_queue', id); }
    async update(id, u) { const e = await this.get(id); if (!e) return; await this.db.put('sync_queue', { ...e, ...u }); }
    async remove(id) { await this.db.delete('sync_queue', id); }
    async countPending() { const p = await this.getPending(); return p.length; }
    async countFailed() { const f = await this.getFailed(); return f.length; }
    async dedup(entity, eid, op, payload) {
      const all = await this.getPending();
      const ex = all.find(a => a.entity === entity && a.entityId === eid && a.operation === op);
      if (ex) { await this.update(ex.actionId, { payload: { ...ex.payload, ...payload }, timestamp: new Date().toISOString(), retryCount: 0 }); return ex.actionId; }
      return null;
    }
  }

  class IDMapper {
    constructor(db) { this.db = db; }
    async map(local, server) { await this.db.put('id_map', { localId: local, serverId: server, at: new Date().toISOString() }); }
    async serverId(local) { const m = await this.db.get('id_map', local); return m ? m.serverId : null; }
    async isLocal(id) { return typeof id === 'string' && (id.startsWith('local_') || id.startsWith('tmp_')); }
  }

  class CacheManager {
    constructor(db) { this.db = db; }
    async put(entity, id, data) { await this.db.put('entity_cache', { entity, id, data, syncStatus: data._syncStatus || 'synced', cachedAt: new Date().toISOString() }); }
    async get(entity, id) { return this.db.get('entity_cache', [entity, id]); }
    async getByType(entity) { return this.db.getByIndex('entity_cache', 'entity', entity); }
    async updateStatus(entity, id, status) { const e = await this.get(entity, id); if (e) { e.syncStatus = status; await this.db.put('entity_cache', e); } }
    async putIfNewer(entity, id, data) {
      const ex = await this.get(entity, id);
      if (!ex || (data.updated_at && (!ex.data.updated_at || new Date(data.updated_at) > new Date(ex.data.updated_at)))) {
        await this.put(entity, id, data); return true;
      }
      return false;
    }
  }

  class SyncManager {
    constructor(db, queue, mapper, cache, network) { this.db = db; this.queue = queue; this.mapper = mapper; this.cache = cache; this.network = network; this._syncing = false; this._listeners = []; this._token = ''; this._apiBase = ''; this._lastSync = null; }
    setAuth(t, b) { this._token = t; this._apiBase = b; }
    onStatus(cb) { this._listeners.push(cb); }
    _notify(s) { this._listeners.forEach(cb => cb(s)); }
    get isSyncing() { return this._syncing; }
    get lastSyncTime() { return this._lastSync; }

    async syncAll() {
      if (this._syncing || !this.network.isOnline || !this._token) return;
      this._syncing = true;
      this._notify({ status: 'syncing', message: 'Syncing changes...' });
      try {
        const pending = await this.queue.getPending();
        if (!pending.length) { this._syncing = false; this._notify({ status: 'idle', message: 'All synced' }); return; }
        const order = { student:1, teacher:1, parent:1, attendance:2, fee_setup:2, fee:3, exam:2, marks:3, announcement:5, timetable:5, settings:6 };
        const sorted = [...pending].sort((a,b) => (order[a.entity]||5) - (order[b.entity]||5) || new Date(a.timestamp) - new Date(b.timestamp));
        let synced = 0, failed = 0;
        for (const act of sorted) {
          if (!this.network.isOnline) break;
          if (act.dependentOn) {
            const sid = await this.mapper.serverId(act.dependentOn);
            if (!sid) continue;
            act.payload = this._replIds(act.payload, act.dependentOn, sid);
            act.entityId = sid;
          }
          try { await this._syncOne(act); synced++; } catch(e) { failed++; }
          this._notify({ status: 'syncing', message: `Syncing... (${synced}/${sorted.length})` });
        }
        this._lastSync = new Date().toISOString();
        await this.db.put('settings', { key: 'lastSyncTime', value: this._lastSync });
        const rem = await this.queue.countPending();
        this._notify(rem === 0 && !failed ? { status: 'synced', message: 'All changes synced' } : { status: 'partial', message: `${synced} synced, ${failed} failed` });
      } catch(e) { this._notify({ status: 'error', message: e.message }); }
      finally { this._syncing = false; }
    }

    _replIds(obj, lid, sid) {
      if (typeof obj === 'string') return obj === lid ? sid : obj;
      if (Array.isArray(obj)) return obj.map(i => this._replIds(i, lid, sid));
      if (obj && typeof obj === 'object') { const r = {}; for (const [k,v] of Object.entries(obj)) r[k] = this._replIds(v, lid, sid); return r; }
      return obj;
    }

    async _syncOne(act) {
      await this.queue.update(act.actionId, { status: 'syncing', lastAttempt: new Date().toISOString() });
      try {
        const resp = await fetch(this._apiBase + act.endpoint, { method: act.method,
          headers: { 'Authorization': 'Bearer ' + this._token, 'Content-Type': 'application/json' },
          body: act.method !== 'GET' && act.method !== 'HEAD' ? JSON.stringify(act.payload) : undefined });
        const txt = await resp.text(); let res; try { res = JSON.parse(txt); } catch(e) { throw new Error('Invalid response'); }
        if (!resp.ok) { if (resp.status === 401 || resp.status === 403) { await this.queue.update(act.actionId, { status: 'failed', errorMessage: 'Auth expired' }); return; } throw new Error(res.error || 'Server error'); }
        if (act.operation === 'CREATE' && res.id && act.entityId && await this.mapper.isLocal(act.entityId)) {
          await this.mapper.map(act.entityId, res.id);
          const pending2 = await this.queue.getPending();
          for (const p of pending2) { if (p.dependentOn === act.entityId) { p.dependentOn = res.id; p.entityId = res.id; p.payload = this._replIds(p.payload, act.entityId, res.id); await this.queue.update(p.actionId, p); } }
        }
        const rid = res.id || act.entityId;
        if (rid) await this.cache.updateStatus(act.entity, rid, 'synced');
        await this.queue.update(act.actionId, { status: 'completed' });
      } catch(e) {
        const rc = (act.retryCount || 0) + 1;
        await this.queue.update(act.actionId, { status: rc >= act.maxRetries ? 'failed' : 'pending', retryCount: rc, errorMessage: e.message });
        throw e;
      }
    }
  }

  class OfflineAPI {
    constructor(db, queue, mapper, cache, network, sync) { this.db = db; this.queue = queue; this.mapper = mapper; this.cache = cache; this.network = network; this.sync = sync; this._apiCall = null; }
    setOnlineApiCall(fn) { this._apiCall = fn; }
    genLocalId() { return 'local_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9); }

    async call(endpoint, method, body, opts) {
      const { entity, entityId, isFormData, skipOffline, skipCache } = opts || {};
      if (method === 'GET') {
        if (this.network.isOnline) {
          try {
            const r = await this._apiCall(endpoint, method, body, isFormData);
            if (entity && r) { const items = Array.isArray(r) ? r : (r.id ? [r] : null); if (items) for (const i of items) await this.cache.putIfNewer(entity, i.id, i); }
            return r;
          } catch(e) { if (entity && !skipCache) return this._fromCache(entity); throw e; }
        } else { if (entity && !skipCache) return this._fromCache(entity); throw new Error('You are offline.'); }
      }
      if (this.network.isOnline && !skipOffline) {
        try { return await this._apiCall(endpoint, method, body, isFormData); }
        catch(e) { if (e.message.includes('Failed to fetch') || e.message.includes('NetworkError')) return this._queueMut(endpoint, method, body, entity, entityId); throw e; }
      } else { return this._queueMut(endpoint, method, body, entity, entityId); }
    }

    async _queueMut(endpoint, method, body, entity, entityId) {
      const uj = localStorage.getItem('skyhonix_user'); const u = uj ? JSON.parse(uj) : {};
      let lid = entityId; const isCreate = method === 'POST' && !entityId;
      if (isCreate) lid = this.genLocalId();
      const op = method === 'DELETE' ? 'DELETE' : (method === 'PUT' ? 'UPDATE' : 'CREATE');
      const existing = await this.queue.dedup(entity, lid || entityId, op, body || {});
      if (existing) return { _offline: true, _syncStatus: 'pending', _actionId: existing, _localId: lid, id: lid, message: 'Saved locally. Will sync when online.' };
      const act = await this.queue.enqueue({ operation: op, entity, entityId: lid || entityId, endpoint, method, payload: body || {}, userId: u.id || u.teacherId, schoolId: u.schoolId });
      if (entity && body && op !== 'DELETE') await this.cache.put(entity, lid || entityId, { ...body, id: lid || entityId, _syncStatus: 'pending' });
      if (op === 'DELETE' && entity && entityId) await this.cache.updateStatus(entity, entityId, 'deleted');
      if (this.network.isOnline) setTimeout(() => this.sync.syncAll(), 100);
      return { _offline: true, _syncStatus: 'pending', _actionId: act.actionId, _localId: lid, id: lid || entityId, message: 'Saved locally. Will sync when online.' };
    }

    async _fromCache(entity) {
      const all = await this.cache.getByType(entity);
      const active = all.filter(c => c.syncStatus !== 'deleted');
      if (active.length) return active.map(c => c.data);
      throw new Error('Data not available offline');
    }
  }

  class OfflineIndicator {
    constructor(network, sync, queue) {
      this.network = network; this.sync = sync; this.queue = queue;
      this._el = document.createElement('div'); this._el.id = 'offline-indicator';
      this._el.style.cssText = 'position:fixed;bottom:20px;left:20px;z-index:9999;display:flex;align-items:center;gap:8px;padding:8px 16px;border-radius:24px;font-family:Inter,sans-serif;font-size:0.8rem;font-weight:500;box-shadow:0 4px 12px rgba(0,0,0,0.15);transition:all 0.3s;cursor:pointer;background:#fff;border:1px solid #E5E7EB;';
      this._el.innerHTML = '<span class="sd" style="width:8px;height:8px;border-radius:50%;background:#059669;"></span><span class="st">Online</span>';
      document.body.appendChild(this._el);
      this._panel = document.createElement('div'); this._panel.id = 'offline-detail-panel';
      this._panel.style.cssText = 'position:fixed;bottom:60px;left:20px;z-index:9999;width:300px;padding:16px;border-radius:12px;background:#fff;border:1px solid #E5E7EB;box-shadow:0 10px 25px rgba(0,0,0,0.12);font-family:Inter,sans-serif;display:none;';
      document.body.appendChild(this._panel);
      this._el.addEventListener('click', () => { this._panel.style.display = this._panel.style.display === 'none' ? 'block' : 'none'; this._refresh(); });
      this.network.onChange(() => this._update());
      this.sync.onStatus((s) => { this._update(); if (s.status === 'synced') this._toast(s.message); });
      document.addEventListener('click', (e) => { if (!this._el.contains(e.target) && !this._panel.contains(e.target)) this._panel.style.display = 'none'; });
      this._update();
    }
    _update() {
      const d = this._el.querySelector('.sd'), t = this._el.querySelector('.st');
      if (this.sync.isSyncing) { d.style.background='#D97706'; d.style.animation='pulse 1s infinite'; t.textContent='Syncing...'; this._el.style.borderColor='#D97706'; }
      else if (!this.network.isOnline) { d.style.background='#DC2626'; d.style.animation='none'; t.textContent='Offline'; this._el.style.borderColor='#DC2626'; }
      else { d.style.background='#059669'; d.style.animation='none'; t.textContent='Online'; this._el.style.borderColor='#059669'; }
      this._refresh();
    }
    async _refresh() {
      const p = await this.queue.countPending(), f = await this.queue.countFailed(), ls = this.sync.lastSyncTime, on = this.network.isOnline;
      this._panel.innerHTML = '<div style="margin-bottom:12px;font-weight:600;font-size:0.9rem;color:#111827;">Sync Status</div>'
        + '<div style="display:flex;justify-content:space-between;margin-bottom:8px;font-size:0.85rem;"><span style="color:#6B7280;">Connection</span><span style="color:'+(on?'#059669':'#DC2626')+';font-weight:600;">'+(on?'Online':'Offline')+'</span></div>'
        + '<div style="display:flex;justify-content:space-between;margin-bottom:8px;font-size:0.85rem;"><span style="color:#6B7280;">Pending</span><span style="color:'+(p>0?'#D97706':'#059669')+';font-weight:600;">'+p+'</span></div>'
        + (f>0?'<div style="display:flex;justify-content:space-between;margin-bottom:8px;font-size:0.85rem;"><span style="color:#6B7280;">Failed</span><span style="color:#DC2626;font-weight:600;">'+f+'</span></div>':'')
        + '<div style="display:flex;justify-content:space-between;margin-bottom:12px;font-size:0.85rem;"><span style="color:#6B7280;">Last Sync</span><span style="color:#111827;font-weight:500;">'+(ls?new Date(ls).toLocaleTimeString():'Never')+'</span></div>'
        + (p>0&&on?'<button onclick="window.SkyHonixOffline.forceSync()" style="width:100%;padding:8px;background:#4F46E5;color:#fff;border:none;border-radius:8px;font-size:0.85rem;font-weight:600;cursor:pointer;">Sync Now</button>':'');
    }
    _toast(msg) { const t = document.createElement('div'); t.style.cssText='position:fixed;bottom:60px;left:50%;transform:translateX(-50%);padding:10px 20px;border-radius:8px;background:#111827;color:#fff;font-family:Inter,sans-serif;font-size:0.85rem;box-shadow:0 4px 12px rgba(0,0,0,0.2);z-index:10000;'; t.textContent=msg; document.body.appendChild(t); setTimeout(()=>t.remove(),3000); }
  }

  class SkyHonixOfflineEngine {
    constructor() { this.db = new OfflineDB(); this.network = new NetworkManager(); this.queue = new SyncQueue(this.db); this.mapper = new IDMapper(this.db); this.cache = new CacheManager(this.db); this.syncManager = new SyncManager(this.db, this.queue, this.mapper, this.cache, this.network); this.offlineAPI = new OfflineAPI(this.db, this.queue, this.mapper, this.cache, this.network, this.syncManager); this.indicator = null; this._initialized = false; }
    async init(opts) {
      await this.db.ready;
      if (opts.apiBase) this.network.setApiBase(opts.apiBase);
      if (opts.token) this.syncManager.setAuth(opts.token, opts.apiBase || '');
      this.network.startPing(30000);
      this.network.onChange((on) => { if (on) setTimeout(() => this.syncManager.syncAll(), 500); });
      const p = await this.queue.countPending();
      if (p > 0 && this.network.isOnline) setTimeout(() => this.syncManager.syncAll(), 1000);
      this.indicator = new OfflineIndicator(this.network, this.syncManager, this.queue);
      if ('serviceWorker' in navigator) { try { await navigator.serviceWorker.register('/service-worker.js'); } catch(e) {} }
      this._initialized = true; return this;
    }
    setOnlineApiCall(fn) { this.offlineAPI.setOnlineApiCall(fn); }
    async forceSync() { return this.syncManager.syncAll(); }
    async getSyncStatus() { return { isOnline: this.network.isOnline, isSyncing: this.syncManager.isSyncing, pending: await this.queue.countPending(), failed: await this.queue.countFailed(), lastSyncTime: this.syncManager.lastSyncTime }; }
  }

  window.SkyHonixOffline = new SkyHonixOfflineEngine();
  const s = document.createElement('style');
  s.textContent = '@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}';
  document.head.appendChild(s);
})();
