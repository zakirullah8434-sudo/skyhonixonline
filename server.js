const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const { initMainDb } = require('./main_db_init');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let dbInitialized = false;
let dbInitializationPromise = null;

async function ensureDbInitialized() {
  if (dbInitialized) return;
  if (!dbInitializationPromise) {
    dbInitializationPromise = (async () => {
      if (config.isVercel) {
        console.log('Vercel environment detected. Copying templates to /tmp...');
        if (!fs.existsSync(config.DATABASES_DIR)) {
          fs.mkdirSync(config.DATABASES_DIR, { recursive: true });
        }
        if (fs.existsSync(config.READONLY_DATABASES_DIR)) {
          const files = fs.readdirSync(config.READONLY_DATABASES_DIR);
          for (const file of files) {
            if (file.endsWith('.db')) {
              const src = path.join(config.READONLY_DATABASES_DIR, file);
              const dest = path.join(config.DATABASES_DIR, file);
              if (!fs.existsSync(dest)) {
                fs.copyFileSync(src, dest);
                console.log(`Copied database ${file} to /tmp`);
              }
            }
          }
        }
        
        if (!fs.existsSync(config.UPLOADS_DIR)) {
          fs.mkdirSync(config.UPLOADS_DIR, { recursive: true });
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
        console.log('Template copy completed.');
      }
      await initMainDb();
      dbInitialized = true;
    })();
  }
  return dbInitializationPromise;
}

// Middleware to ensure DB is initialized
app.use(async (req, res, next) => {
  try {
    await ensureDbInitialized();
    next();
  } catch (err) {
    console.error('Failed to initialize database:', err);
    res.status(500).json({ error: 'Database initialization failed', details: err.message });
  }
});

// Serve static uploaded assets
app.use('/uploads', express.static(config.UPLOADS_DIR));

// Import routes
const authRoutes = require('./routes/auth').router;
const studentsRoutes = require('./routes/students');
const attendanceRoutes = require('./routes/attendance');
const feesRoutes = require('./routes/fees');
const examsRoutes = require('./routes/exams');
const billingRoutes = require('./routes/billing');
const settingsRoutes = require('./routes/settings');
const adminRoutes = require('./routes/admin');

// Mount API routes
app.use('/api/auth', authRoutes);
app.use('/api/students', studentsRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/fees', feesRoutes);
app.use('/api/exams', examsRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/admin', adminRoutes);

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// Catch-all route to serve landing page or dashboard
app.get('*', (req, res, next) => {
  // If API route not matched, return 404 for APIs, but serve index.html for UI pages
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'Endpoint not found' });
  }
  next();
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
