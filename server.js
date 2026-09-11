const express = require('express');
const cors = require('cors');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const config = require('./config');
const { initMainDb } = require('./main_db_init');
const { resetMainDb } = require('./database_manager');

const app = express();

// CRITICAL: Compression — reduces bandwidth 60-80% for JSON/HTML
app.use(compression({
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  },
  level: 6,
  threshold: 1024
}));

// Middleware
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// Bandwidth tracking — lightweight, no JWT verify (uses req.user after auth)
const bandwidthTracker = new Map();
app.use((req, res, next) => {
  if (!req.path.startsWith('/api')) return next();
  const startBytes = JSON.stringify(req.body || {}).length;
  const originalJson = res.json.bind(res);
  res.json = function(data) {
    const endBytes = JSON.stringify(data || {}).length;
    try {
      if (req.user && req.user.schoolId) {
        const sid = req.user.schoolId;
        if (!bandwidthTracker.has(sid)) {
          bandwidthTracker.set(sid, { requests: 0, bytesIn: 0, bytesOut: 0 });
        }
        const tracker = bandwidthTracker.get(sid);
        tracker.requests++;
        tracker.bytesIn += startBytes;
        tracker.bytesOut += endBytes;
      }
    } catch (e) { /* non-critical */ }
    return originalJson(data);
  };
  next();
});

// Expose tracker to admin routes
app.locals.bandwidthTracker = bandwidthTracker;

let dbInitialized = false;
let dbInitializationPromise = null;

async function ensureDbInitialized() {
  if (dbInitialized) return;
  if (!dbInitializationPromise) {
    dbInitializationPromise = (async () => {
      try {
        if (config.isVercel) {
          if (!fs.existsSync(config.DATABASES_DIR)) {
            fs.mkdirSync(config.DATABASES_DIR, { recursive: true });
          }
          if (!fs.existsSync(config.UPLOADS_DIR)) {
            fs.mkdirSync(config.UPLOADS_DIR, { recursive: true });
          }
          if (fs.existsSync(config.READONLY_DATABASES_DIR)) {
            const files = fs.readdirSync(config.READONLY_DATABASES_DIR);
            for (const file of files) {
              if (file.endsWith('.db')) {
                const src = path.join(config.READONLY_DATABASES_DIR, file);
                const dest = path.join(config.DATABASES_DIR, file);
                if (!fs.existsSync(dest)) {
                  fs.copyFileSync(src, dest);
                  console.log(`[INIT] Copied ${file} to /tmp/databases/`);
                }
              }
            }
          }
          const copyDirRecursive = (srcDir, destDir) => {
            if (!fs.existsSync(srcDir)) return;
            if (!fs.existsSync(destDir)) {
              fs.mkdirSync(destDir, { recursive: true });
            }
            const items = fs.readdirSync(srcDir);
            for (const item of items) {
              const srcItem = path.join(srcDir, item);
              const destItem = path.join(destDir, item);
              if (fs.statSync(srcItem).isDirectory()) {
                copyDirRecursive(srcItem, destItem);
              } else {
                if (!fs.existsSync(destItem)) {
                  fs.copyFileSync(srcItem, destItem);
                }
              }
            }
          };
          copyDirRecursive(config.READONLY_UPLOADS_DIR, config.UPLOADS_DIR);

          if (!config.useTurso) {
            console.warn('[WARNING] Running on Vercel WITHOUT Turso. Data in /tmp is ephemeral and will be lost on cold starts. Set TURSO_URL environment variable for persistent storage.');
          }
        }
        await initMainDb();
        resetMainDb(); // Reset cached connection to ensure fresh connection to new DB
        dbInitialized = true;
        console.log('[INIT] Database initialized successfully.');
      } catch (initErr) {
        console.error('DB initialization error:', initErr);
        dbInitializationPromise = null;
        throw initErr;
      }
    })();
  }
  return dbInitializationPromise;
}

// Middleware to ensure DB is initialized
app.use((req, res, next) => {
  ensureDbInitialized()
    .then(() => next())
    .catch(err => {
      console.error('Failed to initialize database:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Database initialization failed', details: err.message });
      }
    });
});

// Serve static uploaded assets
app.use('/uploads', (req, res, next) => {
  if (config.isVercel && !fs.existsSync(config.UPLOADS_DIR)) {
    fs.mkdirSync(config.UPLOADS_DIR, { recursive: true });
  }
  express.static(config.UPLOADS_DIR)(req, res, next);
});

// Import routes
const authRoutes = require('./routes/auth').router;
const studentsRoutes = require('./routes/students');
const attendanceRoutes = require('./routes/attendance');
const feesRoutes = require('./routes/fees');
const examsRoutes = require('./routes/exams');
const billingRoutes = require('./routes/billing');
const settingsRoutes = require('./routes/settings');
const adminRoutes = require('./routes/admin');
const staffRoutes = require('./routes/staff');
const teacherRoutes = require('./routes/teachers');
const parentRoutes = require('./routes/parents');
const promotionsRoutes = require('./routes/promotions');
const transportRoutes = require('./routes/transport');
const salaryRoutes = require('./routes/salary');

// ─── Ping endpoint (for offline connectivity detection) ───
app.get('/api/auth/ping', (req, res) => {
  res.status(200).json({ ok: true, timestamp: Date.now() });
});

// ─── Idempotency middleware for offline sync ───
const idempotencyCache = new Map();
const IDEMPOTENCY_MAX = 10000;
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const idempotencyKey = req.headers['x-idempotency-key'];
  if (idempotencyKey) {
    if (idempotencyCache.has(idempotencyKey)) {
      const cached = idempotencyCache.get(idempotencyKey);
      return res.status(cached.status).json(cached.data);
    }
    // Evict oldest entries if cache is full
    if (idempotencyCache.size >= IDEMPOTENCY_MAX) {
      const firstKey = idempotencyCache.keys().next().value;
      idempotencyCache.delete(firstKey);
    }
    const originalJson = res.json.bind(res);
    res.json = function(data) {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        idempotencyCache.set(idempotencyKey, { status: res.statusCode, data });
        setTimeout(() => idempotencyCache.delete(idempotencyKey), 86400000);
      }
      return originalJson(data);
    };
  }
  next();
});

// ─── Rate Limiting — prevents brute-force and abuse ───
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX = 100; // 100 requests per minute per IP
const LOGIN_RATE_LIMIT_MAX = 10; // 10 login attempts per minute per IP
const RATE_LIMIT_CLEANUP = 300000; // cleanup every 5 min

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  const key = req.path.includes('/login') ? `login:${ip}` : `api:${ip}`;
  const max = req.path.includes('/login') ? LOGIN_RATE_LIMIT_MAX : RATE_LIMIT_MAX;

  if (!rateLimitMap.has(key)) {
    rateLimitMap.set(key, { count: 1, start: now });
    return next();
  }

  const entry = rateLimitMap.get(key);
  if (now - entry.start > RATE_LIMIT_WINDOW) {
    entry.count = 1;
    entry.start = now;
    return next();
  }

  entry.count++;
  if (entry.count > max) {
    const retryAfter = Math.ceil((entry.start + RATE_LIMIT_WINDOW - now) / 1000);
    res.setHeader('Retry-After', retryAfter);
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }
  next();
}

// Periodic cleanup of rate limit map
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (now - entry.start > RATE_LIMIT_WINDOW) rateLimitMap.delete(key);
  }
}, RATE_LIMIT_CLEANUP).unref();

app.use('/api', rateLimit);

// ─── Dashboard aggregate stats (lightweight, cached 30s per school) ───
const dashboardCache = new Map();
const DASHBOARD_CACHE_TTL = 30000;
const { querySchool: querySchoolDb, querySchoolOne: querySchoolOneDb } = require('./database_manager');

app.get('/api/dashboard/stats', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Access denied' });
    const decoded = jwt.verify(token, config.JWT_SECRET);
    const schoolId = decoded.schoolId;
    if (!schoolId) return res.status(401).json({ error: 'Invalid token' });

    const cacheKey = String(schoolId);
    const cached = dashboardCache.get(cacheKey);
    if (cached && Date.now() - cached.time < DASHBOARD_CACHE_TTL) {
      return res.json(cached.data);
    }

    const currentMonth = new Date().toLocaleString('en-US', { month: 'long' });
    const currentYear = new Date().getFullYear();
    const today = new Date().toISOString().split('T')[0];

    const [studentCount, attStats, feeAgg, settings] = await Promise.all([
      querySchoolOneDb(schoolId, "SELECT COUNT(*) as cnt FROM students WHERE status IS NULL OR status != 'Left'"),
      querySchoolDb(schoolId,
        `SELECT status, COUNT(*) as count FROM attendance WHERE date = ? GROUP BY status`, [today]),
      querySchoolOneDb(schoolId,
        `SELECT SUM(total_payable - paid_amount) as pending_dues,
                SUM(CASE WHEN month = ? AND year = ? THEN paid_amount ELSE 0 END) as month_collected
         FROM fee_ledger`, [currentMonth, currentYear]),
      querySchoolOneDb(schoolId, 'SELECT school_name, logo_path, phone, registration_number FROM fee_settings LIMIT 1')
    ]);

    const result = {
      totalStudents: studentCount ? studentCount.cnt : 0,
      attendanceStats: attStats || [],
      pendingDues: feeAgg ? (feeAgg.pending_dues || 0) : 0,
      monthCollected: feeAgg ? (feeAgg.month_collected || 0) : 0,
      settings: settings || {}
    };

    dashboardCache.set(cacheKey, { data: result, time: Date.now() });
    res.json(result);
  } catch (err) {
    console.error('Dashboard stats error:', err.message);
    res.status(500).json({ error: 'Failed to load dashboard stats' });
  }
});

// Mount API routes
app.use('/api/auth', authRoutes);
app.use('/api/students', studentsRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/fees', feesRoutes);
app.use('/api/exams', examsRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/staff', staffRoutes);
app.use('/api/teachers', teacherRoutes);
app.use('/api/parents', parentRoutes);
app.use('/api/promotions', promotionsRoutes);
app.use('/api/transport', transportRoutes);
app.use('/api/salary', salaryRoutes);

// Serve static frontend files with optimized caching
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (filePath.match(/\.(jpg|jpeg|png|gif|webp|svg|ico|woff2?|ttf|eot)$/)) {
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    }
  }
}));

// API 404
app.all('/api/*', (req, res) => {
  res.status(404).json({ error: 'Endpoint not found: ' + req.method + ' ' + req.path });
});

// Catch-all: serve index.html for page navigation
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Global error handler — never leak internals in production
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// Start Server after initializing main registry database
async function startServer() {
  try {
    // 1. Initialize DB structure
    await initMainDb();
    dbInitialized = true;

    // 2. Start Express Listener
    app.listen(config.PORT, () => {
      console.log(`==================================================`);
      console.log(`SkyHonix School System API running online on port: ${config.PORT}`);
      console.log(`Access Landing Page: http://localhost:${config.PORT}/`);
      console.log(`Access Portal Dashboard: http://localhost:${config.PORT}/portal.html`);
      console.log(`==================================================`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

if (!config.isVercel) {
  startServer();
}

module.exports = app;
