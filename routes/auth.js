const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { queryMain, queryMainOne, runMain, runSchool, querySchoolOne, querySchool } = require('../database_manager');

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

    req.user = decoded; // Contains: schoolId, username, role

    // Check school status in main DB
    try {
      const school = await queryMainOne(
        'SELECT subscription_status, next_due_date FROM schools WHERE id = ?',
        [req.user.schoolId]
      );

      if (!school) {
        return res.status(404).json({ error: 'School registration not found' });
      }

      req.user.subscriptionStatus = school.subscription_status;
      req.user.nextDueDate = school.next_due_date;

      // Allow access to billing endpoints even if pending/suspended
      const isBillingRoute = req.originalUrl.includes('/billing') || req.originalUrl.includes('/subscription');

      // Block pending schools from non-billing endpoints
      if (school.subscription_status === 'pending' && !isBillingRoute) {
        return res.status(403).json({ 
          error: 'Your school registration is pending admin approval. Please wait for activation.', 
          pending: true 
        });
      }

      // Block suspended schools from non-billing endpoints
      if (school.subscription_status === 'suspended' && !isBillingRoute) {
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
  const schoolCode = `skyhonix${cleanPhone}`;

  try {
    // Check if school email already exists
    const existing = await queryMainOne('SELECT id FROM schools WHERE email = ?', [email]);
    if (existing) {
      return res.status(400).json({ error: 'School email is already registered' });
    }

    // Check if school code/phone number is already registered
    const existingCode = await queryMainOne('SELECT id FROM schools WHERE school_code = ?', [schoolCode]);
    if (existingCode) {
      return res.status(400).json({ error: 'School code or phone number is already registered' });
    }

    // Determine database file name
    const timestamp = Date.now();
    const dbFile = `school_${timestamp}.db`;

    // Hash password for the initial school admin user
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Map selected package to monthly amount
    const packagePrices = {
      'Package 1': 800,
      'Package 2': 1200,
      'Package 3': 1500,
      'Package 4': 1800,
      'Package 5': 2000,
      'Package 6': 2400
    };
    const subscriptionAmount = packagePrices[selectedPackage] || 1500;

    // Insert tenant registration into main.db with status 'pending' (awaiting admin approval)
    const mainResult = await runMain(
      `INSERT INTO schools (school_name, email, password, db_file, subscription_status, subscription_amount, next_due_date, created_at, phone, school_code, selected_package)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [schoolName, email, hashedPassword, dbFile, 'pending', subscriptionAmount, null, new Date().toISOString(), phone, schoolCode, selectedPackage || null]
    );

    const schoolId = mainResult.id;

    // Connect to the tenant database (this will trigger file creation and schema initialization)
    // Use INSERT OR REPLACE to guarantee admin user exists (schema init callbacks may not have finished)
    await runSchool(schoolId,
      'INSERT OR REPLACE INTO users (username, password, role) VALUES (?, ?, ?)',
      ['admin', hashedPassword, 'admin']
    );

    res.status(201).json({
      message: `School registered successfully! Unique Code: ${schoolCode}. Please share this code with the administrator to request access activation.`,
      schoolId,
      schoolCode
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
    // 1. Find school tenant in main registry by email AND verify password
    const school = await queryMainOne(
      'SELECT id, school_name, db_file, password, subscription_status, next_due_date FROM schools WHERE email = ?',
      [schoolEmail]
    );

    if (!school) {
      return res.status(404).json({ error: 'School email is not registered' });
    }

    // 2. Verify school password
    const isMatch = await bcrypt.compare(password, school.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Incorrect password' });
    }

    // Block pending schools from logging in
    if (school.subscription_status === 'pending') {
      return res.status(403).json({ error: 'Your school registration is pending admin approval. Please wait for activation.' });
    }

    const schoolId = school.id;

    // 3. Get admin user from school's tenant database for username/role info
    let user = await querySchoolOne(
      schoolId,
      'SELECT id, username, role FROM users WHERE role = ?',
      ['admin']
    );

    // If admin user is missing (schema init race condition), create it now
    if (!user) {
      await runSchool(schoolId,
        'INSERT OR IGNORE INTO users (username, password, role) VALUES (?, ?, ?)',
        ['admin', school.password, 'admin']
      );
      user = await querySchoolOne(
        schoolId,
        'SELECT id, username, role FROM users WHERE role = ?',
        ['admin']
      );
    }

    if (!user) {
      return res.status(401).json({ error: 'No admin user found for this school' });
    }

    // 4. Generate JWT
    const payload = {
      schoolId: schoolId,
      schoolName: school.school_name,
      username: user.username,
      role: user.role
    };

    const token = jwt.sign(payload, config.JWT_SECRET, { expiresIn: '7d' });

    res.json({
      message: 'Login successful',
      token,
      user: {
        username: user.username,
        role: user.role,
        schoolName: school.school_name,
        schoolId: schoolId,
        subscriptionStatus: school.subscription_status,
        nextDueDate: school.next_due_date
      }
    });

  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed. ' + err.message });
  }
});

// Get current session details
router.get('/session', authenticateToken, (req, res) => {
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
    // 1. Find the specific school
    const school = await queryMainOne(
      'SELECT id, school_name, subscription_status FROM schools WHERE id = ?',
      [school_id]
    );

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
      role: 'teacher'
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
        schoolId: school.id
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
