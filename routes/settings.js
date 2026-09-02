const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const config = require('../config');
const { authenticateToken } = require('./auth');
const { querySchool, querySchoolOne, runSchool, closeSchoolDb, getSchoolDb } = require('../database_manager');

// Setup multer for uploading school logo & backups
const logoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const logosDir = path.join(config.UPLOADS_DIR, 'logos');
    if (!fs.existsSync(logosDir)) {
      fs.mkdirSync(logosDir, { recursive: true });
    }
    cb(null, logosDir);
  },
  filename: (req, file, cb) => {
    cb(null, 'logo-' + Date.now() + path.extname(file.originalname));
  }
});

const uploadLogo = multer({ storage: logoStorage });

const dbStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const restoreDir = path.join(config.DATABASES_DIR, 'temp_restore');
    if (!fs.existsSync(restoreDir)) {
      fs.mkdirSync(restoreDir, { recursive: true });
    }
    cb(null, restoreDir);
  },
  filename: (req, file, cb) => {
    cb(null, 'restore-' + Date.now() + '.db');
  }
});

const uploadDb = multer({ storage: dbStorage });

// GET /settings - Fetch school details and settings
router.get('/', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;

  try {
    let feeSettings = await querySchoolOne(schoolId, 'SELECT * FROM fee_settings LIMIT 1');
    if (!feeSettings) {
      // Seed default if missing
      await runSchool(
        schoolId,
        `INSERT INTO fee_settings (school_name, logo_path, phone, registration_number, footer_text) 
         VALUES (?, ?, ?, ?, ?)`,
        [req.user.schoolName, 'school_assets/school_logo.png', '', '', '']
      );
      feeSettings = await querySchoolOne(schoolId, 'SELECT * FROM fee_settings LIMIT 1');
    }

    const masterPinRow = await querySchoolOne(schoolId, "SELECT value FROM settings WHERE key = 'master_pin'");
    const masterPin = masterPinRow ? masterPinRow.value : 'goldensunbk';

    res.json({
      school_name: feeSettings.school_name,
      logo_path: feeSettings.logo_path,
      phone: feeSettings.phone || '',
      registration_number: feeSettings.registration_number || '',
      footer_text: feeSettings.footer_text || '',
      master_pin: masterPin
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /settings - Update school details
router.post('/', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { school_name, phone, registration_number, footer_text } = req.body;

  if (!school_name) {
    return res.status(400).json({ error: 'School name is required' });
  }

  try {
    await runSchool(
      schoolId,
      `UPDATE fee_settings SET school_name = ?, phone = ?, registration_number = ?, footer_text = ?`,
      [school_name, phone || '', registration_number || '', footer_text || '']
    );

    // Sync back school name inside main.db schools table
    const { runMain } = require('../database_manager');
    await runMain('UPDATE schools SET school_name = ? WHERE id = ?', [school_name, schoolId]);

    res.json({ message: 'School settings updated successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /settings/logo - Upload and change school logo
router.post('/logo', authenticateToken, uploadLogo.single('logo'), async (req, res) => {
  const schoolId = req.user.schoolId;

  if (!req.file) {
    return res.status(400).json({ error: 'No logo file provided' });
  }

  const logoUrl = 'uploads/logos/' + req.file.filename;

  try {
    await runSchool(schoolId, 'UPDATE fee_settings SET logo_path = ?', [logoUrl]);
    res.json({ message: 'School logo updated successfully!', logo_path: logoUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /settings/users/password - Update tenant password (admin/teacher)
router.post('/users/password', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { role, password } = req.body; // role: 'admin' or 'teacher'

  if (!role || !password) {
    return res.status(400).json({ error: 'Role and Password are required' });
  }

  try {
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(password, salt);

    await runSchool(schoolId, 'UPDATE users SET password = ? WHERE role = ?', [hash, role]);

    // If updating tenant admin password, sync to main.db schools table password as well
    if (role === 'admin') {
      const { runMain } = require('../database_manager');
      await runMain('UPDATE schools SET password = ? WHERE id = ?', [hash, schoolId]);
    }

    res.json({ message: `Password for '${role}' user updated successfully!` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /settings/backup - Download raw SQLite database file
router.get('/backup', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { queryMainOne } = require('../database_manager');

  try {
    const school = await queryMainOne('SELECT db_file, school_name FROM schools WHERE id = ?', [schoolId]);
    if (!school) return res.status(404).json({ error: 'School database file reference not found' });

    const dbPath = path.join(config.DATABASES_DIR, school.db_file);
    if (!fs.existsSync(dbPath)) {
      return res.status(404).json({ error: 'Database file does not exist' });
    }

    const cleanName = school.school_name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    res.download(dbPath, `${cleanName}_backup_${Date.now()}.db`);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /settings/restore - Upload and restore/override SQLite database file
router.post('/restore', authenticateToken, uploadDb.single('backup'), async (req, res) => {
  const schoolId = req.user.schoolId;
  const { queryMainOne } = require('../database_manager');

  if (!req.file) {
    return res.status(400).json({ error: 'No backup file provided' });
  }

  const uploadedPath = req.file.path;

  try {
    const school = await queryMainOne('SELECT db_file FROM schools WHERE id = ?', [schoolId]);
    if (!school) {
      if (fs.existsSync(uploadedPath)) fs.unlinkSync(uploadedPath);
      return res.status(404).json({ error: 'School not registered' });
    }

    const destPath = path.join(config.DATABASES_DIR, school.db_file);

    // 1. Close current database handles in cache
    await closeSchoolDb(schoolId);

    // 2. Perform copy backup file over existing school DB file
    fs.copyFileSync(uploadedPath, destPath);

    // 3. Remove temp uploaded file
    fs.unlinkSync(uploadedPath);

    // 4. Test run a quick query on restored DB to verify it's not corrupt
    const testRow = await querySchoolOne(schoolId, 'SELECT school_name FROM fee_settings LIMIT 1');

    res.json({
      message: 'Database backup restored successfully!',
      schoolName: testRow ? testRow.school_name : 'Restored School'
    });

  } catch (err) {
    console.error('Restore error:', err);
    if (fs.existsSync(uploadedPath)) {
      try { fs.unlinkSync(uploadedPath); } catch (e) {}
    }
    res.status(500).json({ error: 'Failed to restore database: ' + err.message });
  }
});

// POST /settings/delete-all-data - Delete all school operational data (students, fees, attendance, exams)
router.post('/delete-all-data', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { confirm_text } = req.body;

  if (confirm_text !== 'DELETE ALL DATA') {
    return res.status(400).json({ error: 'Please type "DELETE ALL DATA" to confirm.' });
  }

  try {
    const tablesToWipe = [
      'marks', 'results', 'exam_subjects', 'exams',
      'student_promotion_history', 'result_sections',
      'attendance', 'fee_payments', 'fee_ledger', 'fee_dues', 'past_dues',
      'class_fees', 'student_fee_exceptions', 'sections', 'students'
    ];

    let deletedCount = 0;
    let failedTables = [];

    for (const table of tablesToWipe) {
      try {
        await runSchool(schoolId, `DELETE FROM ${table}`);
        deletedCount++;
      } catch (e) {
        // Table might not exist — skip silently
        failedTables.push(table);
      }
    }

    // Reclaim disk space
    try {
      await runSchool(schoolId, 'VACUUM');
    } catch (e) { /* VACUUM may fail on some setups, ignore */ }

    const msg = deletedCount > 0
      ? `All school data has been deleted successfully (${deletedCount} tables wiped). School profile and login credentials are preserved.`
      : 'No data tables found to delete.';

    res.json({ message: msg });
  } catch (err) {
    console.error('Delete all data error:', err);
    res.status(500).json({ error: 'Failed to delete school data: ' + err.message });
  }
});

module.exports = router;
