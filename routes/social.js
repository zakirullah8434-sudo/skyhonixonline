const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const config = require('../config');
const { querySchoolOne, runSchool } = require('../database_manager');

// ============================================================
// School Social Media configuration
//
// Stored as a JSON blob in the per-school `settings` key/value
// table under key = 'social_media':
//   {
//     tiktok:   { channel: '', video: '', videos: [] },
//     facebook: { channel: '', video: '', videos: [] },
//     youtube:  { channel: '', video: '', videos: [] },
//     instagram:{ channel: '', video: '', videos: [] },
//     whatsapp: { number: '' }
//   }
//
// v74: each platform keeps MULTIPLE video links in `videos: []`.
// `video` stays = videos[0] so older cached clients keep working.
//
// GET  /api/social  - admin, teacher or parent (viewers)
// PUT  /api/social  - school admin only (the teacher/parent apps
//                     never write; they just read the school's links)
// ============================================================

const LINK_PLATFORMS = ['tiktok', 'facebook', 'youtube', 'instagram'];

function defaultConfig() {
  const cfg = {};
  LINK_PLATFORMS.forEach(p => { cfg[p] = { channel: '', video: '', videos: [] }; });
  cfg.whatsapp = { number: '' };
  return cfg;
}

const MAX_VIDEOS = 12; // per platform

// Accepts ANY logged-in role of the school (admin / teacher / parent).
function authenticateAnyRole(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Access token required. Please log in.' });
  }
  jwt.verify(token, config.JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired session. Please log in again.' });
    }
    if (!decoded || !decoded.schoolId) {
      return res.status(403).json({ error: 'Invalid session.' });
    }
    req.socialUser = decoded;
    next();
  });
}

// Trim + force a scheme so every saved link opens cleanly. Rejects
// anything that is not http(s) (javascript:, data: etc).
function cleanUrl(v) {
  v = String(v == null ? '' : v).trim();
  if (!v) return '';
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
  if (!/^https?:\/\/\S+$/i.test(v)) return '';
  return v.slice(0, 500);
}

// wa.me links need a plain country-code number (no +, no spaces).
function cleanPhone(v) {
  v = String(v == null ? '' : v).replace(/[^\d+]/g, '');
  if (v.charAt(0) === '+') v = v.slice(1);
  return v.slice(0, 20);
}

async function ensureSettingsTable(schoolId) {
  try {
    await runSchool(schoolId, 'CREATE TABLE IF NOT EXISTS settings (key TEXT, value TEXT, school_id INTEGER)');
  } catch (e) { /* table already exists with its schema — fine */ }
}

async function loadSocialConfig(schoolId) {
  await ensureSettingsTable(schoolId);
  const row = await querySchoolOne(schoolId, `SELECT value FROM settings WHERE key = 'social_media' LIMIT 1`);
  let saved = {};
  try { saved = row && row.value ? JSON.parse(row.value) : {}; } catch (e) { saved = {}; }

  const cfg = defaultConfig();
  Object.keys(cfg).forEach(k => {
    if (saved && typeof saved[k] === 'object' && saved[k]) {
      Object.keys(cfg[k]).forEach(field => {
        if (field === 'videos') return; // handled below (array + legacy seed)
        if (typeof saved[k][field] === 'string') cfg[k][field] = saved[k][field];
      });
      if ('videos' in cfg[k]) {
        if (Array.isArray(saved[k].videos)) {
          cfg[k].videos = saved[k].videos.map(cleanUrl).filter(Boolean).slice(0, MAX_VIDEOS);
        } else if (cfg[k].video) {
          // Legacy rows only stored a single `video` — seed the array from it.
          cfg[k].videos = [cfg[k].video];
        }
        // Keep the old single field in sync with the first video.
        cfg[k].video = cfg[k].videos[0] || '';
      }
    }
  });
  return cfg;
}

// GET /api/social - fetch the school's social media links (any role)
router.get('/', authenticateAnyRole, async (req, res) => {
  const schoolId = req.socialUser.schoolId;
  try {
    const cfg = await loadSocialConfig(schoolId);
    res.json(cfg);
  } catch (err) {
    console.error('Error fetching social media config:', err);
    res.status(500).json({ error: 'Failed to load social media links' });
  }
});

// PUT /api/social - save links (school admin only)
router.put('/', authenticateAnyRole, async (req, res) => {
  const user = req.socialUser;
  if (user.role === 'teacher' || user.role === 'parent') {
    return res.status(403).json({ error: 'Only the school admin can update social media links' });
  }
  const schoolId = user.schoolId;

  try {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const cfg = defaultConfig();

    LINK_PLATFORMS.forEach(p => {
      const src = (body[p] && typeof body[p] === 'object') ? body[p] : {};
      cfg[p].channel = cleanUrl(src.channel);

      // v74: multiple video links per platform. Accept `videos: []` and
      // fall back to the legacy single `video` string.
      let videos = [];
      if (Array.isArray(src.videos)) {
        videos = src.videos.map(cleanUrl).filter(Boolean);
      }
      if (!videos.length) {
        const one = cleanUrl(src.video);
        if (one) videos = [one];
      }
      // de-dup while preserving order
      videos = videos.filter((u, i) => videos.indexOf(u) === i).slice(0, MAX_VIDEOS);
      cfg[p].videos = videos;
      cfg[p].video = videos[0] || '';
    });
    const wa = (body.whatsapp && typeof body.whatsapp === 'object') ? body.whatsapp : {};
    cfg.whatsapp.number = cleanPhone(wa.number);

    const json = JSON.stringify(cfg);
    await ensureSettingsTable(schoolId);
    const upd = await runSchool(schoolId, `UPDATE settings SET value = ? WHERE key = 'social_media'`, [json]);
    if (!upd || !upd.changes) {
      await runSchool(
        schoolId,
        `INSERT INTO settings (key, value, school_id) VALUES ('social_media', ?, ?)`,
        [json, schoolId]
      );
    }

    res.json({ message: 'Social media links updated!', config: cfg });
  } catch (err) {
    console.error('Error saving social media config:', err);
    res.status(500).json({ error: 'Failed to save social media links' });
  }
});

module.exports = router;
