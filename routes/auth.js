const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { queryMain, queryMainOne, runMain, runSchool, querySchoolOne, querySchool } = require('../database_manager');

// Subscription status cache — eliminates per-request DB hit (60s TTL)
const subscriptionCache = new Map();
const SUB_CACHE_TTL = 60000;

// Login lookup cache — the school registry row is re-read on every login attempt.
// Caching it for a few seconds removes a whole database round trip from the
// critical sign-in path (invalidated automatically by register()).
const SCHOOL_LOOKUP_TTL = 15000;
const schoolLookupCache = new Map(); // key -> { row, exp }
function schoolCacheGet(key) {
  const hit = schoolLookupCache.get(key);
  if (!hit) return null;
  if (hit.exp <= Date.now()) { schoolLookupCache.delete(key); return null; }
  return hit.row;
}
function schoolCacheSet(key, row) {
  if (schoolLookupCache.size > 500) schoolLookupCache.clear();
  schoolLookupCache.set(key, { row, exp: Date.now() + SCHOOL_LOOKUP_TTL });
}
function invalidateSchoolLookup(key) {
  if (key) schoolLookupCache.delete(key);
}

function invalidateSubCache(schoolId) {
  subscriptionCache.delete(schoolId);
}

// Middleware to verify JWT token and inject req.user
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required. Please log in.' });
  }

  jwt.verify(token, config.JWT_SECRET, async (err, decoded) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired session. Please log in again.' });
    }

    req.user = decoded;

    try {
      // Check cache first
      const cacheKey = req.user.schoolId;
      let school = subscriptionCache.get(cacheKey);
      if (school && (Date.now() - school._cachedAt) < SUB_CACHE_TTL) {
        req.user.subscriptionStatus = school.subscription_status;
        req.user.nextDueDate = school.next_due_date;
      } else {
        const dbSchool = await queryMainOne(
          'SELECT subscription_status, next_due_date FROM schools WHERE id = ?',
          [req.user.schoolId]
        );
        if (!dbSchool) {
          return res.status(404).json({ error: 'School registration not found' });
        }
        req.user.subscriptionStatus = dbSchool.subscription_status;
        req.user.nextDueDate = dbSchool.next_due_date;
        subscriptionCache.set(cacheKey, { ...dbSchool, _cachedAt: Date.now() });
      }

      const isBillingRoute = req.originalUrl.includes('/billing') || req.originalUrl.includes('/subscription');

      if (req.user.subscriptionStatus === 'pending' && !isBillingRoute) {
        return res.status(403).json({ 
          error: 'Your school registration is pending admin approval. Please wait for activation.', 
          pending: true 
        });
      }

      if (req.user.subscriptionStatus === 'suspended' && !isBillingRoute) {
        return res.status(403).json({ 
          error: 'Subscription suspended. Access locked. Please proceed to Billing to renew.', 
          suspended: true 
        });
      }

      next();
    } catch (dbErr) {
      console.error('Auth middleware DB error:', dbErr);
      res.status(500).json({ error: 'Internal server authorization error' });
    }
  });
}

// School Registration (Multi-Tenant SignUp)
router.post('/register', async (req, res) => {
  const { schoolName, email, password, phone, selectedPackage } = req.body;

  if (!schoolName || !email || !password || !phone) {
    return res.status(400).json({ error: 'All fields (including Phone Number) are required' });
  }

  // Clean phone number (keep digits only)
  const cleanPhone = phone.replace(/\D/g, '');
  if (!cleanPhone) {
    return res.status(400).json({ error: 'Invalid phone number' });
  }

  try {
    // Check if school email already exists
    const existing = await queryMainOne('SELECT id FROM schools WHERE email = ?', [email]);
    if (existing) {
      return res.status(400).json({ error: 'School email is already registered' });
    }

    // Determine database file name
    const timestamp = Date.now();
    const dbFile = `school_${timestamp}.db`;
    invalidateSchoolLookup('email:' + email);

    // Hash password for the initial school admin user
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Map selected package to monthly amount
    const packagePrices = {
      'Package 1': 1200,
      'Package 2': 2000,
      'Package 3': 3000,
      'Package 4': 4000,
      'Package 5': 5200,
      'Package 6': 6600,
      'Package 7': 8000
    };
    const subscriptionAmount = packagePrices[selectedPackage] || 1500;

    // Insert tenant registration into main.db with status 'pending' (awaiting admin approval)
    // school_code is NULL until admin assigns one during approval
    const mainResult = await runMain(
      `INSERT INTO schools (school_name, email, password, db_file, subscription_status, subscription_amount, next_due_date, created_at, phone, selected_package)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [schoolName, email, hashedPassword, dbFile, 'pending', subscriptionAmount, null, new Date().toISOString(), phone, selectedPackage || null]
    );

    const schoolId = mainResult.id;

    // Connect to the tenant database (this will trigger file creation and schema initialization)
    // Use INSERT OR REPLACE to guarantee admin user exists (schema init callbacks may not have finished)
    await runSchool(schoolId,
      'INSERT OR REPLACE INTO users (username, password, role) VALUES (?, ?, ?)',
      ['admin', hashedPassword, 'admin']
    );

    res.status(201).json({
      message: `School registered successfully! Please wait for admin approval. Admin will assign a unique School ID upon activation.`,
      schoolId
    });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Failed to register school. ' + err.message });
  }
});

// User Login (School login - Email & Password only)
router.post('/login', async (req, res) => {
  const { schoolEmail, password } = req.body;

  if (!schoolEmail || !password) {
    return res.status(400).json({ error: 'School Email and Password are required' });
  }

  try {
    // 1. Find school tenant in main registry by email (cached for a few seconds)
    const cacheKey = 'email:' + schoolEmail;
    let school = schoolCacheGet(cacheKey);
    if (!school) {
      school = await queryMainOne(
        'SELECT id, school_name, db_file, password, subscription_status, next_due_date, school_code FROM schools WHERE email = ?',
        [schoolEmail]
      );
      if (school) schoolCacheSet(cacheKey, school);
    }

    if (!school) {
      return res.status(404).json({ error: 'School email is not registered' });
    }

    const schoolId = school.id;

    // 2. Verify password AND fetch the admin user in parallel — one round trip saved
    const [isMatch, user] = await Promise.all([
      bcrypt.compare(password, school.password),
      querySchoolOne(
        schoolId,
        'SELECT id, username, role FROM users WHERE role = ?',
        ['admin']
      ).catch(() => null)
    ]);

    if (!isMatch) {
      return res.status(401).json({ error: 'Incorrect password' });
    }

    // Block pending schools from logging in
    if (school.subscription_status === 'pending') {
      return res.status(403).json({ error: 'Your school registration is pending admin approval. Please wait for activation.' });
    }

    // If admin user is missing (schema init race condition), create it now
    let finalUser = user;
    if (!finalUser) {
      await runSchool(schoolId,
        'INSERT OR IGNORE INTO users (username, password, role) VALUES (?, ?, ?)',
        ['admin', school.password, 'admin']
      );
      finalUser = await querySchoolOne(
        schoolId,
        'SELECT id, username, role FROM users WHERE role = ?',
        ['admin']
      );
    }

    if (!finalUser) {
      return res.status(401).json({ error: 'No admin user found for this school' });
    }

    // 3. Generate JWT
    const payload = {
      schoolId: schoolId,
      schoolName: school.school_name,
      username: finalUser.username,
      role: finalUser.role
    };

    const token = jwt.sign(payload, config.JWT_SECRET, { expiresIn: '7d' });

    res.json({
      message: 'Login successful',
      token,
      user: {
        username: finalUser.username,
        role: finalUser.role,
        schoolName: school.school_name,
        schoolId: schoolId,
        schoolCode: school.school_code || null,
        subscriptionStatus: school.subscription_status,
        nextDueDate: school.next_due_date
      }
    });

  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed. ' + err.message });
  }
});

// ─── Server-side logout ──────────────────────────────────────────────────────
// The mobile APKs keep their own copy of the JWT (localStorage on the login
// screen) so they can restore the session the next time the app is opened.
// Clearing localStorage in the portal cannot reach that copy, so "Log out"
// records a revocation timestamp here and /api/auth/session checks it before
// the app is allowed to sign the user back in.
function sessionSubject(user) {
  const role = user.role || 'admin';
  if (role === 'teacher' && user.teacherId !== undefined && user.teacherId !== null) return String(user.teacherId);
  if (role === 'parent' && user.parentId !== undefined && user.parentId !== null) return String(user.parentId);
  if (user.username) return String(user.username);
  return '*';
}

async function revokeSession(user) {
  const schoolId = user && user.schoolId;
  if (!schoolId) return;
  const role = user.role || 'admin';
  await runMain(
    'INSERT OR REPLACE INTO session_revocations (school_id, role, subject, revoked_at) VALUES (?, ?, ?, ?)',
    [schoolId, role, sessionSubject(user), Date.now()]
  );
}

async function isSessionRevoked(user) {
  const schoolId = user && user.schoolId;
  if (!schoolId) return false;
  const role = user.role || 'admin';
  try {
    const row = await queryMainOne(
      'SELECT revoked_at FROM session_revocations WHERE school_id = ? AND role = ? AND subject IN (?, ?)',
      [schoolId, role, sessionSubject(user), '*']
    );
    if (!row) return false;
    const revokedAt = Number(row.revoked_at) || 0;
    const issuedAt = user.iat ? Number(user.iat) * 1000 : 0;
    return revokedAt > issuedAt;
  } catch (e) {
    // A missing table or a transient DB error must never lock everybody out.
    return false;
  }
}

router.post('/logout', authenticateToken, async (req, res) => {
  try {
    await revokeSession(req.user);
  } catch (e) {
    console.error('Logout revocation failed:', e.message);
  }
  res.json({ message: 'Logged out' });
});

// Get current session details
router.get('/session', authenticateToken, async (req, res) => {
  if (await isSessionRevoked(req.user)) {
    return res.status(401).json({ error: 'Session ended. Please log in again.' });
  }
  res.json({
    user: req.user
  });
});

// Teacher Login (school_id + phone + password)
router.post('/teacher-login', async (req, res) => {
  const { school_id, phone, password } = req.body;

  if (!school_id || !phone || !password) {
    return res.status(400).json({ error: 'School ID, Phone, and Password are required' });
  }

  try {
    // 1. Find the specific school — try id first, then school_code (cached 15s)
    const schoolCacheKey = 'id:' + school_id;
    let school = schoolCacheGet(schoolCacheKey);

    if (!school) {
      school = await queryMainOne(
        'SELECT id, school_name, subscription_status FROM schools WHERE id = ?',
        [school_id]
      );

      if (!school && typeof school_id === 'string') {
        school = await queryMainOne(
          'SELECT id, school_name, subscription_status FROM schools WHERE school_code = ?',
          [school_id]
        );
      } else if (!school) {
        school = await queryMainOne(
          'SELECT id, school_name, subscription_status FROM schools WHERE school_code = ?',
          [String(school_id)]
        );
      }
      if (school) schoolCacheSet(schoolCacheKey, school);
    }

    if (!school) {
      return res.status(404).json({ error: 'School not found with this ID' });
    }

    // 2. Find teacher in this school
    let foundTeacher = null;
    try {
      foundTeacher = await querySchoolOne(
        school.id,
        'SELECT id, name, phone, password, subject, status FROM teachers WHERE phone = ?',
        [phone]
      );
    } catch (e) {
      return res.status(404).json({ error: 'Teacher not found in this school' });
    }

    if (!foundTeacher) {
      return res.status(404).json({ error: 'Teacher not found in this school' });
    }

    if (foundTeacher.status !== 'Active') {
      return res.status(403).json({ error: 'Teacher account is inactive. Contact admin.' });
    }

    // Block login for pending or suspended schools
    if (school.subscription_status === 'pending') {
      return res.status(403).json({ error: 'School registration is pending admin approval.' });
    }
    if (school.subscription_status === 'suspended') {
      return res.status(403).json({ error: 'School access is suspended. Contact admin.' });
    }

    // 3. Verify password
    const isMatch = await bcrypt.compare(password, foundTeacher.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Incorrect password' });
    }

    // 4. Generate JWT
    const payload = {
      schoolId: school.id,
      schoolName: school.school_name,
      teacherId: foundTeacher.id,
      teacherName: foundTeacher.name,
      role: 'teacher',
      can_collect_fees: foundTeacher.can_collect_fees || 0
    };

    const token = jwt.sign(payload, config.JWT_SECRET, { expiresIn: '7d' });

    res.json({
      message: 'Teacher login successful',
      token,
      user: {
        teacherId: foundTeacher.id,
        teacherName: foundTeacher.name,
        subject: foundTeacher.subject,
        role: 'teacher',
        schoolName: school.school_name,
        schoolId: school.id,
        can_collect_fees: foundTeacher.can_collect_fees || 0
      }
    });

  } catch (err) {
    console.error('Teacher login error:', err);
    res.status(500).json({ error: 'Login failed. ' + err.message });
  }
});

module.exports = {
  router,
  authenticateToken
};
