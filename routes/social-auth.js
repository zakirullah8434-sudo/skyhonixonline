const express = require('express');
const router = express.Router();
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const AppleStrategy = require('apple-signin-auth').Strategy;
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const config = require('../config');
const { queryMain, queryMainOne, runMain, getSchoolDb } = require('../database_manager');

// Store user data temporarily during OAuth flow
const oauthTempStore = new Map();

// Configure Google Strategy
if (config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID: config.GOOGLE_CLIENT_ID,
    clientSecret: config.GOOGLE_CLIENT_SECRET,
    callbackURL: config.GOOGLE_CALLBACK_URL,
    scope: ['profile', 'email'],
    state: true
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      const email = profile.emails && profile.emails[0] ? profile.emails[0].value : null;
      const name = profile.displayName || '';
      const providerId = profile.id;
      
      // Store in temp store for callback handling
      const tempId = `google_${providerId}_${Date.now()}`;
      oauthTempStore.set(tempId, {
        provider: 'google',
        providerId,
        email,
        name,
        accessToken
      });
      
      // Clean up old entries (older than 10 minutes)
      const cutoff = Date.now() - 600000;
      for (const [key, val] of oauthTempStore.entries()) {
        if (val.timestamp && val.timestamp < cutoff) {
          oauthTempStore.delete(key);
        }
      }
      
      return done(null, { tempId, provider: 'google', providerId, email, name });
    } catch (err) {
      return done(err, null);
    }
  }));
}

// Configure Apple Strategy
if (config.APPLE_CLIENT_ID && config.APPLE_TEAM_ID && config.APPLE_KEY_ID) {
  passport.use(new AppleStrategy({
    clientID: config.APPLE_CLIENT_ID,
    teamID: config.APPLE_TEAM_ID,
    keyID: config.APPLE_KEY_ID,
    privateKeyLocation: config.APPLE_PRIVATE_KEY_PATH,
    callbackURL: config.APPLE_CALLBACK_URL,
    scope: ['name', 'email'],
    passReqToCallback: true
  }, async (req, accessToken, refreshToken, idToken, profile, done) => {
    try {
      const email = profile.email || (profile.user && profile.user.email) || null;
      const name = profile.name ? `${profile.name.firstName || ''} ${profile.name.lastName || ''}`.trim() : '';
      const providerId = profile.sub || profile.id;
      
      // Store in temp store for callback handling
      const tempId = `apple_${providerId}_${Date.now()}`;
      oauthTempStore.set(tempId, {
        provider: 'apple',
        providerId,
        email,
        name,
        accessToken
      });
      
      return done(null, { tempId, provider: 'apple', providerId, email, name });
    } catch (err) {
      return done(err, null);
    }
  }));
}

// Initialize passport
router.use(passport.initialize());

// Google OAuth Routes
router.get('/google', (req, res, next) => {
  const userType = req.query.type || 'school';
  const schoolId = req.query.school_id || null;
  
  // Store the intended user type in session
  req.session = req.session || {};
  req.session.oauthUserType = userType;
  req.session.oauthSchoolId = schoolId;
  
  const authOptions = {
    scope: ['profile', 'email'],
    state: JSON.stringify({ type: userType, school_id: schoolId })
  };
  
  passport.authenticate('google', authOptions)(req, res, next);
});

router.get('/google/callback', 
  passport.authenticate('google', { failureRedirect: '/?error=google_auth_failed', session: false }),
  async (req, res) => {
    try {
      const { tempId, provider, providerId, email, name } = req.user;
      const userType = req.session?.oauthUserType || 'school';
      const schoolId = req.session?.oauthSchoolId || null;
      
      // Process the OAuth result
      const result = await processOAuthUser(provider, providerId, email, name, userType, schoolId);
      
      // Redirect based on result
      if (result.requiresRegistration) {
        // Redirect to complete registration
        const params = new URLSearchParams({
          temp_id: tempId,
          provider: provider,
          email: email || '',
          name: name || '',
          type: userType,
          school_id: schoolId || ''
        });
        res.redirect(`/?social_register=true&${params.toString()}`);
      } else if (result.token) {
        // Login successful
        const params = new URLSearchParams({
          social_login: 'success',
          token: result.token,
          user: encodeURIComponent(JSON.stringify(result.user)),
          type: userType
        });
        res.redirect(`/?${params.toString()}`);
      } else {
        res.redirect('/?error=auth_failed');
      }
    } catch (err) {
      console.error('Google callback error:', err);
      res.redirect('/?error=auth_failed');
    }
  }
);

// Apple OAuth Routes
router.get('/apple', (req, res, next) => {
  const userType = req.query.type || 'school';
  const schoolId = req.query.school_id || null;
  
  req.session = req.session || {};
  req.session.oauthUserType = userType;
  req.session.oauthSchoolId = schoolId;
  
  passport.authenticate('apple', {
    scope: ['name', 'email'],
    state: JSON.stringify({ type: userType, school_id: schoolId })
  })(req, res, next);
});

router.get('/apple/callback',
  passport.authenticate('apple', { failureRedirect: '/?error=apple_auth_failed', session: false }),
  async (req, res) => {
    try {
      const { tempId, provider, providerId, email, name } = req.user;
      const userType = req.session?.oauthUserType || 'school';
      const schoolId = req.session?.oauthSchoolId || null;
      
      const result = await processOAuthUser(provider, providerId, email, name, userType, schoolId);
      
      if (result.requiresRegistration) {
        const params = new URLSearchParams({
          temp_id: tempId,
          provider: provider,
          email: email || '',
          name: name || '',
          type: userType,
          school_id: schoolId || ''
        });
        res.redirect(`/?social_register=true&${params.toString()}`);
      } else if (result.token) {
        const params = new URLSearchParams({
          social_login: 'success',
          token: result.token,
          user: encodeURIComponent(JSON.stringify(result.user)),
          type: userType
        });
        res.redirect(`/?${params.toString()}`);
      } else {
        res.redirect('/?error=auth_failed');
      }
    } catch (err) {
      console.error('Apple callback error:', err);
      res.redirect('/?error=auth_failed');
    }
  }
);

// Process OAuth user - check if already registered or needs registration
async function processOAuthUser(provider, providerId, email, name, userType, schoolId) {
  // Check if user already has a social auth record
  const existingAuth = await queryMainOne(
    'SELECT * FROM social_auth WHERE provider = ? AND provider_id = ? AND user_type = ?',
    [provider, providerId, userType]
  );
  
  if (existingAuth) {
    // User already registered - generate token
    return await generateTokenForUser(existingAuth, userType);
  }
  
  // Check if there's a pending registration
  const pending = await queryMainOne(
    'SELECT * FROM pending_registrations WHERE provider = ? AND provider_id = ? AND user_type = ? AND status = ?',
    [provider, providerId, userType, 'pending']
  );
  
  if (pending) {
    // Registration pending approval
    return { requiresRegistration: false, pendingApproval: true, message: 'Registration pending approval' };
  }
  
  // New user - needs to complete registration
  return { 
    requiresRegistration: true, 
    tempData: { provider, providerId, email, name, userType, schoolId }
  };
}

// Generate JWT token for authenticated user
async function generateTokenForUser(authRecord, userType) {
  let user = null;
  
  switch (userType) {
    case 'school':
      user = await queryMainOne('SELECT * FROM schools WHERE id = ?', [authRecord.user_id]);
      if (user) {
        const token = jwt.sign({
          schoolId: user.id,
          schoolName: user.school_name,
          username: user.email,
          role: 'admin'
        }, config.JWT_SECRET, { expiresIn: '7d' });
        
        return {
          token,
          user: {
            id: user.id,
            schoolName: user.school_name,
            email: user.email,
            role: 'admin'
          }
        };
      }
      break;
      
    case 'teacher':
      // Get school_id from pending or social_auth
      const teacherSchool = await queryMainOne(
        'SELECT school_id FROM pending_registrations WHERE provider = ? AND provider_id = ? AND user_type = ?',
        [authRecord.provider, authRecord.provider_id, 'teacher']
      );
      if (teacherSchool && teacherSchool.school_id) {
        const db = await getSchoolDb(teacherSchool.school_id);
        const teacher = await new Promise((resolve) => {
          db.get('SELECT * FROM teachers WHERE id = ?', [authRecord.user_id], (err, row) => {
            resolve(err ? null : row);
          });
        });
        if (teacher) {
          const school = await queryMainOne('SELECT * FROM schools WHERE id = ?', [teacherSchool.school_id]);
          const token = jwt.sign({
            schoolId: teacherSchool.school_id,
            schoolName: school ? school.school_name : '',
            teacherId: teacher.id,
            teacherName: teacher.name,
            role: 'teacher'
          }, config.JWT_SECRET, { expiresIn: '7d' });
          
          return {
            token,
            user: {
              id: teacher.id,
              teacherName: teacher.name,
              schoolId: teacherSchool.school_id,
              schoolName: school ? school.school_name : '',
              role: 'teacher'
            }
          };
        }
      }
      break;
      
    case 'parent':
      const parentSchool = await queryMainOne(
        'SELECT school_id FROM pending_registrations WHERE provider = ? AND provider_id = ? AND user_type = ?',
        [authRecord.provider, authRecord.provider_id, 'parent']
      );
      if (parentSchool && parentSchool.school_id) {
        const db = await getSchoolDb(parentSchool.school_id);
        const parent = await new Promise((resolve) => {
          db.get('SELECT * FROM parents WHERE id = ?', [authRecord.user_id], (err, row) => {
            resolve(err ? null : row);
          });
        });
        if (parent) {
          const school = await queryMainOne('SELECT * FROM schools WHERE id = ?', [parentSchool.school_id]);
          const token = jwt.sign({
            schoolId: parentSchool.school_id,
            schoolName: school ? school.school_name : '',
            parentId: parent.id,
            parentName: parent.name,
            role: 'parent'
          }, config.JWT_SECRET, { expiresIn: '7d' });
          
          return {
            token,
            user: {
              id: parent.id,
              parentName: parent.name,
              schoolId: parentSchool.school_id,
              schoolName: school ? school.school_name : '',
              role: 'parent'
            }
          };
        }
      }
      break;
      
    case 'admin':
      const admin = await queryMainOne('SELECT * FROM admin_users WHERE id = ?', [authRecord.user_id]);
      if (admin) {
        const token = jwt.sign({
          isAdmin: true,
          adminId: admin.id,
          email: admin.email,
          name: admin.name
        }, config.JWT_SECRET, { expiresIn: '24h' });
        
        return {
          token,
          user: {
            id: admin.id,
            email: admin.email,
            name: admin.name,
            role: 'admin'
          }
        };
      }
      break;
  }
  
  return { token: null, user: null };
}

// API endpoint: Complete social registration with mobile number
router.post('/complete-registration', async (req, res) => {
  try {
    const { temp_id, phone, school_id, subject, qualification, cnic, address } = req.body;
    
    if (!temp_id || !phone) {
      return res.status(400).json({ error: 'Temporary ID and phone number are required' });
    }
    
    // Get temp data from store
    const tempData = oauthTempStore.get(temp_id);
    if (!tempData) {
      return res.status(400).json({ error: 'Registration session expired. Please try again.' });
    }
    
    const { provider, providerId, email, name, userType } = tempData;
    
    // Validate phone number uniqueness
    const existingPhone = await queryMainOne(
      'SELECT id FROM pending_registrations WHERE phone = ? AND user_type = ?',
      [phone, userType]
    );
    if (existingPhone) {
      return res.status(400).json({ error: 'This phone number is already registered' });
    }
    
    // For teachers and parents, check phone in their respective tables
    if (userType === 'teacher' && school_id) {
      const db = await getSchoolDb(school_id);
      const existingTeacher = await new Promise((resolve) => {
        db.get('SELECT id FROM teachers WHERE phone = ?', [phone], (err, row) => {
          resolve(err ? null : row);
        });
      });
      if (existingTeacher) {
        return res.status(400).json({ error: 'This phone number is already registered as a teacher' });
      }
    }
    
    if (userType === 'parent' && school_id) {
      const db = await getSchoolDb(school_id);
      const existingParent = await new Promise((resolve) => {
        db.get('SELECT id FROM parents WHERE phone = ?', [phone], (err, row) => {
          resolve(err ? null : row);
        });
      });
      if (existingParent) {
        return res.status(400).json({ error: 'This phone number is already registered as a parent' });
      }
    }
    
    // Check email uniqueness
    if (email) {
      const existingEmail = await queryMainOne(
        'SELECT id FROM pending_registrations WHERE email = ? AND user_type = ?',
        [email, userType]
      );
      if (existingEmail) {
        return res.status(400).json({ error: 'This email is already registered' });
      }
    }
    
    // Create pending registration
    const result = await runMain(
      `INSERT INTO pending_registrations (provider, provider_id, user_type, email, name, phone, school_id, subject, qualification, cnic, address, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [provider, providerId, userType, email, name, phone, school_id || null, subject || null, qualification || null, cnic || null, address || null, new Date().toISOString()]
    );
    
    // Clean up temp store
    oauthTempStore.delete(temp_id);
    
    res.json({
      success: true,
      message: userType === 'teacher' 
        ? 'Registration submitted! Your account is pending school approval.'
        : userType === 'parent'
        ? 'Registration submitted! Your account is pending school approval.'
        : 'Registration submitted! Please wait for admin approval.',
      registrationId: result.id
    });
    
  } catch (err) {
    console.error('Complete registration error:', err);
    res.status(500).json({ error: 'Failed to complete registration: ' + err.message });
  }
});

// API endpoint: Get pending registrations for a school (teachers)
router.get('/pending-teachers/:schoolId', async (req, res) => {
  try {
    const { schoolId } = req.params;
    
    const pending = await queryMain(
      'SELECT * FROM pending_registrations WHERE user_type = ? AND school_id = ? AND status = ? ORDER BY created_at DESC',
      ['teacher', schoolId, 'pending']
    );
    
    res.json({ pending_teachers: pending || [] });
  } catch (err) {
    console.error('Get pending teachers error:', err);
    res.status(500).json({ error: 'Failed to fetch pending teachers' });
  }
});

// API endpoint: Get pending registrations for a school (parents)
router.get('/pending-parents/:schoolId', async (req, res) => {
  try {
    const { schoolId } = req.params;
    
    const pending = await queryMain(
      'SELECT * FROM pending_registrations WHERE user_type = ? AND school_id = ? AND status = ? ORDER BY created_at DESC',
      ['parent', schoolId, 'pending']
    );
    
    res.json({ pending_parents: pending || [] });
  } catch (err) {
    console.error('Get pending parents error:', err);
    res.status(500).json({ error: 'Failed to fetch pending parents' });
  }
});

// API endpoint: Approve teacher registration
router.post('/approve-teacher/:registrationId', async (req, res) => {
  try {
    const { registrationId } = req.params;
    const { school_id } = req.body;
    
    // Get the pending registration
    const registration = await queryMainOne(
      'SELECT * FROM pending_registrations WHERE id = ? AND user_type = ? AND status = ?',
      [registrationId, 'teacher', 'pending']
    );
    
    if (!registration) {
      return res.status(404).json({ error: 'Registration not found or already processed' });
    }
    
    const targetSchoolId = school_id || registration.school_id;
    if (!targetSchoolId) {
      return res.status(400).json({ error: 'School ID is required' });
    }
    
    // Check if school exists
    const school = await queryMainOne('SELECT * FROM schools WHERE id = ?', [targetSchoolId]);
    if (!school) {
      return res.status(404).json({ error: 'School not found' });
    }
    
    // Create teacher in school database
    const db = await getSchoolDb(targetSchoolId);
    const salt = await bcrypt.genSalt(10);
    const tempPassword = await bcrypt.hash('social_' + Date.now(), salt);
    
    const teacherResult = await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO teachers (name, phone, password, subject, qualification, status, school_id, created_at)
         VALUES (?, ?, ?, ?, ?, 'Active', ?, ?)`,
        [registration.name || 'Social User', registration.phone, tempPassword, registration.subject || '', registration.qualification || '', targetSchoolId, new Date().toISOString()],
        function(err) {
          if (err) reject(err);
          else resolve({ id: this.lastID });
        }
      );
    });
    
    // Create social auth record
    await runMain(
      `INSERT INTO social_auth (provider, provider_id, user_type, user_id, email, name, phone, created_at)
       VALUES (?, ?, 'teacher', ?, ?, ?, ?, ?)`,
      [registration.provider, registration.provider_id, teacherResult.id, registration.email, registration.name, registration.phone, new Date().toISOString()]
    );
    
    // Update registration status
    await runMain(
      'UPDATE pending_registrations SET status = ? WHERE id = ?',
      ['approved', registrationId]
    );
    
    res.json({
      success: true,
      message: 'Teacher registration approved successfully',
      teacherId: teacherResult.id,
      tempPassword: 'social_' + Date.now() // Instruct school to change password
    });
    
  } catch (err) {
    console.error('Approve teacher error:', err);
    res.status(500).json({ error: 'Failed to approve teacher: ' + err.message });
  }
});

// API endpoint: Approve parent registration
router.post('/approve-parent/:registrationId', async (req, res) => {
  try {
    const { registrationId } = req.params;
    const { school_id, student_id, relation } = req.body;
    
    // Get the pending registration
    const registration = await queryMainOne(
      'SELECT * FROM pending_registrations WHERE id = ? AND user_type = ? AND status = ?',
      [registrationId, 'parent', 'pending']
    );
    
    if (!registration) {
      return res.status(404).json({ error: 'Registration not found or already processed' });
    }
    
    const targetSchoolId = school_id || registration.school_id;
    if (!targetSchoolId) {
      return res.status(400).json({ error: 'School ID is required' });
    }
    
    // Check if school exists
    const school = await queryMainOne('SELECT * FROM schools WHERE id = ?', [targetSchoolId]);
    if (!school) {
      return res.status(404).json({ error: 'School not found' });
    }
    
    // Create parent in school database
    const db = await getSchoolDb(targetSchoolId);
    const salt = await bcrypt.genSalt(10);
    const tempPassword = await bcrypt.hash('social_' + Date.now(), salt);
    
    const parentResult = await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO parents (name, phone, password, cnic, address, status, school_id, created_at)
         VALUES (?, ?, ?, ?, ?, 'Active', ?, ?)`,
        [registration.name || 'Social User', registration.phone, tempPassword, registration.cnic || '', registration.address || '', targetSchoolId, new Date().toISOString()],
        function(err) {
          if (err) reject(err);
          else resolve({ id: this.lastID });
        }
      );
    });
    
    // Link to student if provided
    if (student_id) {
      await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO student_parents (student_id, parent_id, relation, school_id)
           VALUES (?, ?, ?, ?)`,
          [student_id, parentResult.id, relation || 'Father', targetSchoolId],
          function(err) {
            if (err) reject(err);
            else resolve();
          }
        );
      });
    }
    
    // Create social auth record
    await runMain(
      `INSERT INTO social_auth (provider, provider_id, user_type, user_id, email, name, phone, created_at)
       VALUES (?, ?, 'parent', ?, ?, ?, ?, ?)`,
      [registration.provider, registration.provider_id, parentResult.id, registration.email, registration.name, registration.phone, new Date().toISOString()]
    );
    
    // Update registration status
    await runMain(
      'UPDATE pending_registrations SET status = ? WHERE id = ?',
      ['approved', registrationId]
    );
    
    res.json({
      success: true,
      message: 'Parent registration approved successfully',
      parentId: parentResult.id,
      tempPassword: 'social_' + Date.now()
    });
    
  } catch (err) {
    console.error('Approve parent error:', err);
    res.status(500).json({ error: 'Failed to approve parent: ' + err.message });
  }
});

// API endpoint: Reject registration
router.post('/reject-registration/:registrationId', async (req, res) => {
  try {
    const { registrationId } = req.params;
    
    await runMain(
      'UPDATE pending_registrations SET status = ? WHERE id = ?',
      ['rejected', registrationId]
    );
    
    res.json({ success: true, message: 'Registration rejected' });
  } catch (err) {
    console.error('Reject registration error:', err);
    res.status(500).json({ error: 'Failed to reject registration' });
  }
});

// API endpoint: Get all pending registrations for admin (all schools)
router.get('/admin/pending-registrations', async (req, res) => {
  try {
    const pending = await queryMain(
      `SELECT pr.*, s.school_name 
       FROM pending_registrations pr 
       LEFT JOIN schools s ON pr.school_id = s.id 
       WHERE pr.status = 'pending' 
       ORDER BY pr.created_at DESC`
    );
    
    res.json({ pending_registrations: pending || [] });
  } catch (err) {
    console.error('Get pending registrations error:', err);
    res.status(500).json({ error: 'Failed to fetch pending registrations' });
  }
});

// API endpoint: Admin approve registration
router.post('/admin/approve-registration/:registrationId', async (req, res) => {
  try {
    const { registrationId } = req.params;
    const { student_id, relation } = req.body;
    
    const registration = await queryMainOne(
      'SELECT * FROM pending_registrations WHERE id = ?',
      [registrationId]
    );
    
    if (!registration) {
      return res.status(404).json({ error: 'Registration not found' });
    }
    
    if (registration.status !== 'pending') {
      return res.status(400).json({ error: 'Registration already processed' });
    }
    
    if (registration.user_type === 'teacher') {
      // Approve teacher
      const db = await getSchoolDb(registration.school_id);
      const salt = await bcrypt.genSalt(10);
      const tempPassword = await bcrypt.hash('social_' + Date.now(), salt);
      
      const teacherResult = await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO teachers (name, phone, password, subject, qualification, status, school_id, created_at)
           VALUES (?, ?, ?, ?, ?, 'Active', ?, ?)`,
          [registration.name || 'Social User', registration.phone, tempPassword, registration.subject || '', registration.qualification || '', registration.school_id, new Date().toISOString()],
          function(err) {
            if (err) reject(err);
            else resolve({ id: this.lastID });
          }
        );
      });
      
      await runMain(
        `INSERT INTO social_auth (provider, provider_id, user_type, user_id, email, name, phone, created_at)
         VALUES (?, ?, 'teacher', ?, ?, ?, ?, ?)`,
        [registration.provider, registration.provider_id, teacherResult.id, registration.email, registration.name, registration.phone, new Date().toISOString()]
      );
      
      await runMain(
        'UPDATE pending_registrations SET status = ? WHERE id = ?',
        ['approved', registrationId]
      );
      
      res.json({
        success: true,
        message: 'Teacher registration approved',
        teacherId: teacherResult.id
      });
      
    } else if (registration.user_type === 'parent') {
      // Approve parent
      const db = await getSchoolDb(registration.school_id);
      const salt = await bcrypt.genSalt(10);
      const tempPassword = await bcrypt.hash('social_' + Date.now(), salt);
      
      const parentResult = await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO parents (name, phone, password, cnic, address, status, school_id, created_at)
           VALUES (?, ?, ?, ?, ?, 'Active', ?, ?)`,
          [registration.name || 'Social User', registration.phone, tempPassword, registration.cnic || '', registration.address || '', registration.school_id, new Date().toISOString()],
          function(err) {
            if (err) reject(err);
            else resolve({ id: this.lastID });
          }
        );
      });
      
      if (student_id) {
        await new Promise((resolve, reject) => {
          db.run(
            `INSERT INTO student_parents (student_id, parent_id, relation, school_id)
             VALUES (?, ?, ?, ?)`,
            [student_id, parentResult.id, relation || 'Father', registration.school_id],
            function(err) {
              if (err) reject(err);
              else resolve();
            }
          );
        });
      }
      
      await runMain(
        `INSERT INTO social_auth (provider, provider_id, user_type, user_id, email, name, phone, created_at)
         VALUES (?, ?, 'parent', ?, ?, ?, ?, ?)`,
        [registration.provider, registration.provider_id, parentResult.id, registration.email, registration.name, registration.phone, new Date().toISOString()]
      );
      
      await runMain(
        'UPDATE pending_registrations SET status = ? WHERE id = ?',
        ['approved', registrationId]
      );
      
      res.json({
        success: true,
        message: 'Parent registration approved',
        parentId: parentResult.id
      });
      
    } else {
      return res.status(400).json({ error: 'Invalid user type for this endpoint' });
    }
    
  } catch (err) {
    console.error('Admin approve registration error:', err);
    res.status(500).json({ error: 'Failed to approve registration: ' + err.message });
  }
});

// API endpoint: School admin approve teacher/parent
router.post('/school/approve-registration/:registrationId', async (req, res) => {
  try {
    const { registrationId } = req.params;
    const { school_id, student_id, relation } = req.body;
    
    const registration = await queryMainOne(
      'SELECT * FROM pending_registrations WHERE id = ?',
      [registrationId]
    );
    
    if (!registration) {
      return res.status(404).json({ error: 'Registration not found' });
    }
    
    if (registration.status !== 'pending') {
      return res.status(400).json({ error: 'Registration already processed' });
    }
    
    if (registration.school_id != school_id) {
      return res.status(403).json({ error: 'Unauthorized to approve this registration' });
    }
    
    if (registration.user_type === 'teacher') {
      const db = await getSchoolDb(school_id);
      const salt = await bcrypt.genSalt(10);
      const tempPassword = await bcrypt.hash('social_' + Date.now(), salt);
      
      const teacherResult = await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO teachers (name, phone, password, subject, qualification, status, school_id, created_at)
           VALUES (?, ?, ?, ?, ?, 'Active', ?, ?)`,
          [registration.name || 'Social User', registration.phone, tempPassword, registration.subject || '', registration.qualification || '', school_id, new Date().toISOString()],
          function(err) {
            if (err) reject(err);
            else resolve({ id: this.lastID });
          }
        );
      });
      
      await runMain(
        `INSERT INTO social_auth (provider, provider_id, user_type, user_id, email, name, phone, created_at)
         VALUES (?, ?, 'teacher', ?, ?, ?, ?, ?)`,
        [registration.provider, registration.provider_id, teacherResult.id, registration.email, registration.name, registration.phone, new Date().toISOString()]
      );
      
      await runMain(
        'UPDATE pending_registrations SET status = ? WHERE id = ?',
        ['approved', registrationId]
      );
      
      res.json({
        success: true,
        message: 'Teacher registration approved',
        teacherId: teacherResult.id
      });
      
    } else if (registration.user_type === 'parent') {
      const db = await getSchoolDb(school_id);
      const salt = await bcrypt.genSalt(10);
      const tempPassword = await bcrypt.hash('social_' + Date.now(), salt);
      
      const parentResult = await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO parents (name, phone, password, cnic, address, status, school_id, created_at)
           VALUES (?, ?, ?, ?, ?, 'Active', ?, ?)`,
          [registration.name || 'Social User', registration.phone, tempPassword, registration.cnic || '', registration.address || '', school_id, new Date().toISOString()],
          function(err) {
            if (err) reject(err);
            else resolve({ id: this.lastID });
          }
        );
      });
      
      if (student_id) {
        await new Promise((resolve, reject) => {
          db.run(
            `INSERT INTO student_parents (student_id, parent_id, relation, school_id)
             VALUES (?, ?, ?, ?)`,
            [student_id, parentResult.id, relation || 'Father', school_id],
            function(err) {
              if (err) reject(err);
              else resolve();
            }
          );
        });
      }
      
      await runMain(
        `INSERT INTO social_auth (provider, provider_id, user_type, user_id, email, name, phone, created_at)
         VALUES (?, ?, 'parent', ?, ?, ?, ?, ?)`,
        [registration.provider, registration.provider_id, parentResult.id, registration.email, registration.name, registration.phone, new Date().toISOString()]
      );
      
      await runMain(
        'UPDATE pending_registrations SET status = ? WHERE id = ?',
        ['approved', registrationId]
      );
      
      res.json({
        success: true,
        message: 'Parent registration approved',
        parentId: parentResult.id
      });
    }
    
  } catch (err) {
    console.error('School approve registration error:', err);
    res.status(500).json({ error: 'Failed to approve registration: ' + err.message });
  }
});

// API endpoint: Delete registration (allows re-registration)
router.delete('/delete-registration/:registrationId', async (req, res) => {
  try {
    const { registrationId } = req.params;
    
    const registration = await queryMainOne(
      'SELECT * FROM pending_registrations WHERE id = ?',
      [registrationId]
    );
    
    if (!registration) {
      return res.status(404).json({ error: 'Registration not found' });
    }
    
    // Delete social auth if exists
    await runMain(
      'DELETE FROM social_auth WHERE provider = ? AND provider_id = ? AND user_type = ?',
      [registration.provider, registration.provider_id, registration.user_type]
    );
    
    // Delete pending registration
    await runMain(
      'DELETE FROM pending_registrations WHERE id = ?',
      [registrationId]
    );
    
    // If teacher or parent was created, delete from school database
    if (registration.user_type === 'teacher' && registration.school_id) {
      const db = await getSchoolDb(registration.school_id);
      await new Promise((resolve) => {
        db.run('DELETE FROM teachers WHERE phone = ? AND school_id = ?', 
          [registration.phone, registration.school_id], 
          () => resolve()
        );
      });
    } else if (registration.user_type === 'parent' && registration.school_id) {
      const db = await getSchoolDb(registration.school_id);
      await new Promise((resolve) => {
        db.run('DELETE FROM parents WHERE phone = ? AND school_id = ?', 
          [registration.phone, registration.school_id], 
          () => resolve()
        );
      });
    }
    
    res.json({ 
      success: true, 
      message: 'Registration deleted. User can register again with same email and phone.' 
    });
    
  } catch (err) {
    console.error('Delete registration error:', err);
    res.status(500).json({ error: 'Failed to delete registration' });
  }
});

// API endpoint: Check if email/phone is already registered
router.post('/check-availability', async (req, res) => {
  try {
    const { email, phone, user_type } = req.body;
    
    let emailExists = false;
    let phoneExists = false;
    
    if (email) {
      const existingEmail = await queryMainOne(
        'SELECT id FROM pending_registrations WHERE email = ? AND user_type = ?',
        [email, user_type]
      );
      emailExists = !!existingEmail;
      
      if (!emailExists) {
        // Check in main tables
        if (user_type === 'school') {
          const schoolEmail = await queryMainOne('SELECT id FROM schools WHERE email = ?', [email]);
          emailExists = !!schoolEmail;
        } else if (user_type === 'admin') {
          const adminEmail = await queryMainOne('SELECT id FROM admin_users WHERE email = ?', [email]);
          emailExists = !!adminEmail;
        }
      }
    }
    
    if (phone) {
      const existingPhone = await queryMainOne(
        'SELECT id FROM pending_registrations WHERE phone = ? AND user_type = ?',
        [phone, user_type]
      );
      phoneExists = !!existingPhone;
    }
    
    res.json({
      email_exists: emailExists,
      phone_exists: phoneExists
    });
    
  } catch (err) {
    console.error('Check availability error:', err);
    res.status(500).json({ error: 'Failed to check availability' });
  }
});

module.exports = router;