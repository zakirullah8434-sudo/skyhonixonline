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

startServer();
