const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const sqlite3 = require('sqlite3');
const { queryMain, queryMainOne, runMain, getSchoolDb } = require('../database_manager');

// Helper: get student count from a school's database
async function getStudentCount(schoolId) {
  try {
    const db = await getSchoolDb(schoolId);
    return new Promise((resolve) => {
      db.get("SELECT COUNT(*) as cnt FROM students WHERE status IS NULL OR status != 'Left'", [], (err, row) => {
        resolve(err ? 0 : (row ? row.cnt : 0));
      });
    });
  } catch (e) { return 0; }
}

// Helper: get DB file size in bytes
function getDbFileSize(dbFile) {
  try {
    const filePath = path.join(config.DATABASES_DIR, dbFile);
    const stat = fs.statSync(filePath);
    return stat.size;
  } catch (e) { return 0; }
}

// Helper: format bytes to human readable
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Helper: enrich schools with student count and resource usage
async function enrichSchools(schools) {
  const enriched = await Promise.all(schools.map(async (s) => {
    const [studentCount, dbSize] = await Promise.all([
      getStudentCount(s.id),
      Promise.resolve(s.db_file ? getDbFileSize(s.db_file) : 0)
    ]);
    return {
      ...s,
      student_count: studentCount,
      db_size: dbSize,
      db_size_formatted: formatBytes(dbSize)
    };
  }));
  return enriched;
}

// Admin Authentication Middleware
function authenticateAdmin(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Admin token required' });
  }

  jwt.verify(token, config.JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired admin token' });
    }

    // Check if it's an admin token
    if (!decoded.isAdmin) {
      return res.status(403).json({ error: 'Not authorized as admin' });
    }

    req.admin = decoded;
    next();
  });
}

// Admin Login - Authenticate with just email and password
router.post('/authenticate', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    // Find admin user
    const admin = await queryMainOne(
      'SELECT id, email, password, name FROM admin_users WHERE email = ?',
      [email]
    );

    if (!admin) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Verify password
    const isMatch = await bcrypt.compare(password, admin.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Update last login
    await runMain(
      'UPDATE admin_users SET last_login = ? WHERE id = ?',
      [new Date().toISOString(), admin.id]
    );

    // Generate admin token
    const payload = {
      isAdmin: true,
      adminId: admin.id,
      email: admin.email,
      name: admin.name
    };

    const token = jwt.sign(payload, config.JWT_SECRET, { expiresIn: '24h' });

    res.json({
      message: 'Admin authenticated successfully',
      token,
      admin: {
        id: admin.id,
        email: admin.email,
        name: admin.name
      }
    });
  } catch (err) {
    console.error('Admin auth error:', err);
    res.status(500).json({ error: 'Authentication failed: ' + err.message });
  }
});

// Get all schools or filter by status (with student counts and resource usage)
router.get('/schools', authenticateAdmin, async (req, res) => {
  try {
    const status = req.query.status;
    let query = 'SELECT id, school_name, email, phone, school_code, subscription_status, subscription_amount, next_due_date, created_at, selected_package, db_file FROM schools';
    let params = [];

    if (status) {
      query += ' WHERE subscription_status = ?';
      params.push(status);
    }

    query += ' ORDER BY created_at DESC';

    const schools = await queryMain(query, params);
    const enriched = await enrichSchools(schools || []);

    res.json({
      message: 'Schools retrieved successfully',
      schools: enriched
    });
  } catch (err) {
    console.error('Error fetching schools:', err);
    res.status(500).json({ error: 'Failed to fetch schools: ' + err.message });
  }
});

// Get specific school details (with student count and resource usage)
router.get('/schools/:schoolId', authenticateAdmin, async (req, res) => {
  try {
    const schoolId = req.params.schoolId;

    const school = await queryMainOne(
      'SELECT id, school_name, email, phone, school_code, subscription_status, subscription_amount, next_due_date, created_at, db_file, selected_package FROM schools WHERE id = ?',
      [schoolId]
    );

    if (!school) {
      return res.status(404).json({ error: 'School not found' });
    }

    const [studentCount, dbSize] = await Promise.all([
      getStudentCount(school.id),
      Promise.resolve(school.db_file ? getDbFileSize(school.db_file) : 0)
    ]);

    school.student_count = studentCount;
    school.db_size = dbSize;
    school.db_size_formatted = formatBytes(dbSize);

    // Add bandwidth data
    const tracker = req.app.locals.bandwidthTracker || {};
    const bw = tracker[school.id] || { requests: 0, bytesIn: 0, bytesOut: 0 };
    school.request_count = bw.requests;
    school.bandwidth_in = bw.bytesIn;
    school.bandwidth_out = bw.bytesOut;
    school.bandwidth_total = bw.bytesIn + bw.bytesOut;
    school.bandwidth_formatted = formatBytes(bw.bytesIn + bw.bytesOut);

    res.json({
      message: 'School details retrieved',
      school
    });
  } catch (err) {
    console.error('Error fetching school details:', err);
    res.status(500).json({ error: 'Failed to fetch school details: ' + err.message });
  }
});

// ---- Duplicate-student scan & cleanup (v55) ----
// Older releases could create the same student more than once (multi-tap while
// the network was flaky + no server-side uniqueness guard). v54+ prevents new
// duplicates; these admin endpoints detect and clean up the historical ones.
// Rules mirror the student guards: admission_no unique school-wide,
// roll_no unique per class, student_id never repeated.
function dbAll(db, sql, params) {
  return new Promise((resolve, reject) => {
    db.all(sql, params || [], (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}
function dbRun(db, sql, params) {
  return new Promise((resolve, reject) => {
    db.run(sql, params || [], function (err) { return err ? reject(err) : resolve(this); });
  });
}

// Admin scans open a DEDICATED short-lived connection instead of reusing the
// long-lived cached tenant connection, so a scan always reads the latest
// committed rows regardless of what the pooled handle has open. (The v55
// "scan sees nothing" bug was actually server.js's 8s GET response cache —
// fixed by the duplicate-students bypass there — this dedicated connection is
// defense-in-depth for a rare, admin-only operation.) Turso mode has no local
// file: read through the shared proxy there (HTTP reads are always current).
async function withScanDb(schoolId, fn) {
  if (config.useTurso) return fn(await getSchoolDb(schoolId), null);
  const school = await queryMainOne('SELECT db_file FROM schools WHERE id = ?', [schoolId]);
  const dbPath = school && school.db_file ? path.join(config.DATABASES_DIR, school.db_file) : null;
  if (!dbPath || !fs.existsSync(dbPath)) return fn(null, dbPath); // no student DB yet → no duplicates
  const db = await new Promise((resolve, reject) => {
    const conn = new sqlite3.Database(dbPath, (err) => (err ? reject(err) : resolve(conn)));
  });
  try { db.configure('busyTimeout', 5000); } catch (e) { /* best effort */ }
  try { return await fn(db, dbPath); } finally { db.close(); }
}

async function findDuplicateStudentGroupsOnDb(db) {
  const groups = { admission_no: [], roll_no: [], student_id: [] };
  if (!db) return { groups, totalArchiveIds: [], totalStudents: 0 };
  const rows = await dbAll(db,
    `SELECT id, student_id, admission_no, roll_no, class_name, name, status
     FROM students ORDER BY id ASC`);

  const byAdm = new Map(), byRoll = new Map(), bySid = new Map();
  for (const r of rows) {
    const adm = String(r.admission_no || '').trim().toLowerCase();
    if (adm) { if (!byAdm.has(adm)) byAdm.set(adm, []); byAdm.get(adm).push(r); }
    const roll = String(r.roll_no || '').trim().toLowerCase();
    const cls = String(r.class_name || '').trim().toLowerCase();
    if (roll && cls) { const k = cls + '|' + roll; if (!byRoll.has(k)) byRoll.set(k, []); byRoll.get(k).push(r); }
    const sid = String(r.student_id || '').trim().toLowerCase();
    if (sid) { if (!bySid.has(sid)) bySid.set(sid, []); bySid.get(sid).push(r); }
  }

  // A row kept once it appears in ANY duplicate group is archived by dedupe.
  const seen = new Set();
  const pack = (field, key, list, extra) => {
    if (list.length < 2) return;
    const dups = list.filter(r => r.status !== 'Left');
    if (dups.length < 2) return; // already cleaned (only one active copy left)
    const keep = dups[0];
    const archive = dups.slice(1);
    archive.forEach(r => seen.add(r.id));
    groups[field].push({
      field, key, ...extra,
      keep: { id: keep.id, name: keep.name, student_id: keep.student_id, admission_no: keep.admission_no, roll_no: keep.roll_no, class_name: keep.class_name },
      archive: archive.map(r => ({ id: r.id, name: r.name, student_id: r.student_id, admission_no: r.admission_no, roll_no: r.roll_no, class_name: r.class_name }))
    });
  };

  for (const [k, list] of byAdm) pack('admission_no', k, list, {});
  for (const [k, list] of byRoll) { const [cls, roll] = k.split('|'); pack('roll_no', k, list, { class_name: cls, roll_no: roll }); }
  for (const [k, list] of bySid) pack('student_id', k, list, {});

  const totalArchiveIds = [...seen];
  return { groups, totalArchiveIds, totalStudents: rows.length };
}

async function findDuplicateStudentGroups(schoolId) {
  return withScanDb(schoolId, findDuplicateStudentGroupsOnDb);
}

// GET /admin/schools/:schoolId/duplicate-students — report only
router.get('/schools/:schoolId/duplicate-students', authenticateAdmin, async (req, res) => {
  try {
    const schoolId = req.params.schoolId;
    const school = await queryMainOne('SELECT id FROM schools WHERE id = ?', [schoolId]);
    if (!school) return res.status(404).json({ error: 'School not found' });

    const { groups, totalArchiveIds, totalStudents } = await findDuplicateStudentGroups(schoolId);
    const summary = {
      admission_no: groups.admission_no.length,
      roll_no: groups.roll_no.length,
      student_id: groups.student_id.length,
      students_to_archive: totalArchiveIds.length
    };
    res.json({ message: 'Duplicate scan complete', summary, groups, total_students: totalStudents });
  } catch (err) {
    console.error('Error scanning duplicates:', err);
    res.status(500).json({ error: 'Failed to scan duplicates: ' + err.message });
  }
});

// POST /admin/schools/:schoolId/dedupe-students — archive the extra copies
// (marks them status='Left', the same non-destructive "remove" the portal uses).
// Body: { apply: true } to actually archive; anything else is a dry run.
router.post('/schools/:schoolId/dedupe-students', authenticateAdmin, async (req, res) => {
  try {
    const schoolId = req.params.schoolId;
    const school = await queryMainOne('SELECT id FROM schools WHERE id = ?', [schoolId]);
    if (!school) return res.status(404).json({ error: 'School not found' });

    const apply = req.body && req.body.apply === true;

    // Scan AND archive on the same dedicated connection (see withScanDb) so
    // the ids we archive are exactly the ids we just saw, even if another
    // process wrote rows after the cached connection's snapshot was taken.
    const { groups, totalArchiveIds, archived } = await withScanDb(schoolId, async (db) => {
      const scan = await findDuplicateStudentGroupsOnDb(db);
      let archived = 0;
      if (apply && scan.totalArchiveIds.length && db) {
        for (const id of scan.totalArchiveIds) {
          await dbRun(db, `UPDATE students SET status = 'Left' WHERE id = ? AND (status IS NULL OR status != 'Left')`, [id]);
          archived++;
        }
      }
      return { groups: scan.groups, totalArchiveIds: scan.totalArchiveIds, archived };
    });
    res.json({
      message: apply
        ? `Archived ${archived} duplicate student record${archived === 1 ? '' : 's'} (kept the oldest copy of each).`
        : `Dry run: ${totalArchiveIds.length} duplicate record(s) would be archived. Send { apply: true } to proceed.`,
      applied: apply, archived, would_archive: totalArchiveIds.length, groups
    });
  } catch (err) {
    console.error('Error de-duplicating students:', err);
    res.status(500).json({ error: 'Failed to de-duplicate students: ' + err.message });
  }
});

// Approve School - Set status to 'active' and set next due date
router.post('/schools/:schoolId/approve', authenticateAdmin, async (req, res) => {
  try {
    const schoolId = req.params.schoolId;
    const { school_code } = req.body;

    // Check if school exists
    const school = await queryMainOne('SELECT id, subscription_status FROM schools WHERE id = ?', [schoolId]);
    if (!school) {
      return res.status(404).json({ error: 'School not found' });
    }

    // Validate school_code is provided
    if (!school_code || !school_code.trim()) {
      return res.status(400).json({ error: 'School ID is required. Please generate or enter a unique School ID.' });
    }

    const trimmedCode = school_code.trim();

    // Check if school_code is already taken by another school
    const existingCode = await queryMainOne('SELECT id FROM schools WHERE school_code = ? AND id != ?', [trimmedCode, schoolId]);
    if (existingCode) {
      return res.status(400).json({ error: 'This School ID is already taken. Please generate a new one.' });
    }

    // Calculate next due date (30 days from now)
    const nextDueDate = new Date();
    nextDueDate.setDate(nextDueDate.getDate() + 30);

    // Update school status and assign school_code
    await runMain(
      'UPDATE schools SET subscription_status = ?, next_due_date = ?, school_code = ? WHERE id = ?',
      ['active', nextDueDate.toISOString(), trimmedCode, schoolId]
    );

    res.json({
      message: 'School approved and activated successfully',
      schoolId: schoolId,
      school_code: trimmedCode,
      newStatus: 'active',
      nextDueDate: nextDueDate.toISOString()
    });
  } catch (err) {
    console.error('Error approving school:', err);
    res.status(500).json({ error: 'Failed to approve school: ' + err.message });
  }
});

// Suspend/Block School - Set status to 'suspended'
router.post('/schools/:schoolId/suspend', authenticateAdmin, async (req, res) => {
  try {
    const schoolId = req.params.schoolId;

    // Check if school exists
    const school = await queryMainOne('SELECT id, subscription_status FROM schools WHERE id = ?', [schoolId]);
    if (!school) {
      return res.status(404).json({ error: 'School not found' });
    }

    // Update school status
    await runMain(
      'UPDATE schools SET subscription_status = ? WHERE id = ?',
      ['suspended', schoolId]
    );

    res.json({
      message: 'School suspended/blocked successfully',
      schoolId: schoolId,
      newStatus: 'suspended'
    });
  } catch (err) {
    console.error('Error suspending school:', err);
    res.status(500).json({ error: 'Failed to suspend school: ' + err.message });
  }
});

// Get Admin Dashboard Statistics
router.get('/statistics', authenticateAdmin, async (req, res) => {
  try {
    const stats = await queryMain(`
      SELECT
        COUNT(*) as total_schools,
        SUM(CASE WHEN subscription_status = 'active' THEN 1 ELSE 0 END) as active_count,
        SUM(CASE WHEN subscription_status = 'pending' THEN 1 ELSE 0 END) as pending_count,
        SUM(CASE WHEN subscription_status = 'suspended' THEN 1 ELSE 0 END) as suspended_count,
        SUM(CASE WHEN subscription_status = 'trial' THEN 1 ELSE 0 END) as trial_count,
        SUM(subscription_amount) as total_revenue
      FROM schools
    `, []);

    // Get total student count and storage across all schools
    const allSchools = await queryMain('SELECT id, db_file FROM schools', []);
    let totalStudents = 0;
    let totalStorage = 0;

    const results = await Promise.all(allSchools.map(async (s) => {
      const [count, size] = await Promise.all([
        getStudentCount(s.id),
        Promise.resolve(s.db_file ? getDbFileSize(s.db_file) : 0)
      ]);
      return { count, size };
    }));

    results.forEach(r => {
      totalStudents += r.count;
      totalStorage += r.size;
    });

    const stat = stats[0] || {};
    res.json({
      message: 'Statistics retrieved',
      statistics: {
        total_schools: stat.total_schools || 0,
        active_count: stat.active_count || 0,
        pending_count: stat.pending_count || 0,
        suspended_count: stat.suspended_count || 0,
        trial_count: stat.trial_count || 0,
        total_revenue: stat.total_revenue || 0,
        total_students: totalStudents,
        total_storage: totalStorage,
        total_storage_formatted: formatBytes(totalStorage)
      }
    });
  } catch (err) {
    console.error('Error fetching statistics:', err);
    res.status(500).json({ error: 'Failed to fetch statistics: ' + err.message });
  }
});

// Update School Subscription Amount
router.post('/schools/:schoolId/update-amount', authenticateAdmin, async (req, res) => {
  try {
    const schoolId = req.params.schoolId;
    const { amount } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Valid subscription amount is required' });
    }

    const school = await queryMainOne('SELECT id FROM schools WHERE id = ?', [schoolId]);
    if (!school) {
      return res.status(404).json({ error: 'School not found' });
    }

    await runMain(
      'UPDATE schools SET subscription_amount = ? WHERE id = ?',
      [amount, schoolId]
    );

    res.json({
      message: 'School subscription amount updated',
      schoolId: schoolId,
      newAmount: amount
    });
  } catch (err) {
    console.error('Error updating subscription amount:', err);
    res.status(500).json({ error: 'Failed to update amount: ' + err.message });
  }
});

// Edit School ID (school_code)
router.post('/schools/:schoolId/edit-code', authenticateAdmin, async (req, res) => {
  try {
    const schoolId = req.params.schoolId;
    const { school_code } = req.body;

    if (!school_code || !school_code.trim()) {
      return res.status(400).json({ error: 'School ID is required' });
    }

    const trimmedCode = school_code.trim();
    const school = await queryMainOne('SELECT id FROM schools WHERE id = ?', [schoolId]);
    if (!school) {
      return res.status(404).json({ error: 'School not found' });
    }

    // Check uniqueness
    const existing = await queryMainOne('SELECT id FROM schools WHERE school_code = ? AND id != ?', [trimmedCode, schoolId]);
    if (existing) {
      return res.status(400).json({ error: 'This School ID is already taken by another school' });
    }

    await runMain('UPDATE schools SET school_code = ? WHERE id = ?', [trimmedCode, schoolId]);

    res.json({ message: 'School ID updated successfully', school_code: trimmedCode });
  } catch (err) {
    console.error('Error updating school code:', err);
    res.status(500).json({ error: 'Failed to update School ID: ' + err.message });
  }
});

// Get bandwidth stats for all schools
router.get('/bandwidth', authenticateAdmin, async (req, res) => {
  try {
    const tracker = req.app.locals.bandwidthTracker || {};
    const schools = await queryMain('SELECT id, school_name, school_code FROM schools', []);

    const stats = schools.map(s => {
      const t = tracker[s.id] || { requests: 0, bytesIn: 0, bytesOut: 0 };
      return {
        school_id: s.id,
        school_name: s.school_name,
        school_code: s.school_code,
        requests: t.requests,
        bandwidth_in: t.bytesIn,
        bandwidth_out: t.bytesOut,
        bandwidth_total: t.bytesIn + t.bytesOut,
        bandwidth_formatted: formatBytes(t.bytesIn + t.bytesOut)
      };
    });

    res.json({ stats });
  } catch (err) {
    console.error('Error fetching bandwidth stats:', err);
    res.status(500).json({ error: 'Failed to fetch bandwidth stats: ' + err.message });
  }
});

module.exports = router;
