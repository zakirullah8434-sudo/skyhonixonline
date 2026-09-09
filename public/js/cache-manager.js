/**
 * SkyHonix Cache Manager
 * Intelligently caches API responses for offline viewing.
 * Only caches read (GET) data — never caches mutations.
 */
(function () {
  'use strict';

  const DEFAULT_TTL = 24 * 60 * 60 * 1000; // 24 hours

  // Cacheable entities and their cache keys
  const CACHEABLE_ROUTES = {
    '/students': { entity: 'students', ttl: 3600000 },          // 1 hour
    '/students/classes': { entity: 'classes', ttl: 86400000 },   // 24 hours
    '/students/sections': { entity: 'sections', ttl: 86400000 },
    '/students/all': { entity: 'students_all', ttl: 3600000 },
    '/attendance/students': { entity: 'attendance_grid', ttl: 3600000 },
    '/fees/setup': { entity: 'fee_setup', ttl: 86400000 },
    '/fees/ledger': { entity: 'fee_ledger', ttl: 3600000 },
    '/exams': { entity: 'exams', ttl: 86400000 },
    '/exams/subjects': { entity: 'exam_subjects', ttl: 86400000 },
    '/teachers/my-students': { entity: 'teacher_students', ttl: 3600000 },
    '/teachers/my-attendance': { entity: 'teacher_attendance', ttl: 1800000 },
    '/teachers/my-assignments': { entity: 'teacher_assignments', ttl: 3600000 },
    '/teachers/my-timetable': { entity: 'teacher_timetable', ttl: 86400000 },
    '/staff/teachers': { entity: 'teachers', ttl: 86400000 },
    '/staff/announcements': { entity: 'announcements', ttl: 3600000 },
    '/transport/vehicles': { entity: 'vehicles', ttl: 86400000 },
    '/transport/routes': { entity: 'transport_routes', ttl: 86400000 }
  };

  function buildCacheKey(endpoint, params) {
    const base = endpoint.split('?')[0];
    const qs = endpoint.includes('?') ? endpoint.split('?')[1] : '';
    return `${base}${qs ? '?' + qs : ''}`;
  }

  function matchCacheable(endpoint) {
    const basePath = endpoint.split('?')[0];
    for (const [route, config] of Object.entries(CACHEABLE_ROUTES)) {
      if (basePath === route || basePath.startsWith(route + '/')) {
        return config;
      }
    }
    return null;
  }

  async function cacheResponse(endpoint, data) {
    const config = matchCacheable(endpoint);
    if (!config) return;

    const cacheKey = buildCacheKey(endpoint);
    await window.SkyOfflineDB.cacheData(cacheKey, config.entity, {
      data,
      endpoint,
      ttl: config.ttl
    });
  }

  async function getCached(endpoint) {
    const cacheKey = buildCacheKey(endpoint);
    const entry = await window.SkyOfflineDB.getCachedData(cacheKey);
    if (!entry) return null;

    // Check expiry
    if (Date.now() > entry.expiry) {
      return null;
    }
    return entry.data;
  }

  async function getCacheByEntity(entity) {
    const entries = await window.SkyOfflineDB.getCachedDataByEntity(entity);
    return entries.filter(e => Date.now() <= e.expiry);
  }

  // Sync cache with server data after successful sync
  async function refreshCache(endpoint, data) {
    await cacheResponse(endpoint, data);
  }

  async function getCacheStats() {
    const all = await window.SkyOfflineDB.getCachedDataByEntity('');
    return {
      totalEntries: all.length,
      entities: [...new Set(all.map(e => e.entity))]
    };
  }

  window.SkyCacheManager = {
    cacheResponse,
    getCached,
    getCacheByEntity,
    refreshCache,
    matchCacheable,
    getCacheStats,
    CACHEABLE_ROUTES
  };
})();
