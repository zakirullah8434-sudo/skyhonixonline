const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { queryMain, queryMainOne, runMain } = require('../database_manager');

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

// Get all schools or filter by status
router.get('/schools', authenticateAdmin, async (req, res) => {
  try {
    const status = req.query.status;
    let query = 'SELECT id, school_name, email, phone, school_code, subscription_status, subscription_amount, next_due_date, created_at FROM schools';
    let params = [];

    if (status) {
      query += ' WHERE subscription_status = ?';
      params.push(status);
    }

    query += ' ORDER BY created_at DESC';

    const schools = await queryMain(query, params);

    res.json({
      message: 'Schools retrieved successfully',
      schools: schools || []
    });
  } catch (err) {
    console.error('Error fetching schools:', err);
    res.status(500).json({ error: 'Failed to fetch schools: ' + err.message });
  }
});

// Get specific school details
router.get('/schools/:schoolId', authenticateAdmin, async (req, res) => {
  try {
    const schoolId = req.params.schoolId;

    const school = await queryMainOne(
      'SELECT id, school_name, email, phone, school_code, subscription_status, subscription_amount, next_due_date, created_at, db_file FROM schools WHERE id = ?',
      [schoolId]
    );

    if (!school) {
      return res.status(404).json({ error: 'School not found' });
    }

    res.json({
      message: 'School details retrieved',
      school
    });
  } catch (err) {
    console.error('Error fetching school details:', err);
    res.status(500).json({ error: 'Failed to fetch school details: ' + err.message });
  }
});

// Approve School - Set status to 'active' and set next due date
router.post('/schools/:schoolId/approve', authenticateAdmin, async (req, res) => {
  try {
    const schoolId = req.params.schoolId;

    // Check if school exists
    const school = await queryMainOne('SELECT id, subscription_status FROM schools WHERE id = ?', [schoolId]);
    if (!school) {
      return res.status(404).json({ error: 'School not found' });
    }

    // Calculate next due date (30 days from now)
    const nextDueDate = new Date();
    nextDueDate.setDate(nextDueDate.getDate() + 30);

    // Update school status
    await runMain(
      'UPDATE schools SET subscription_status = ?, next_due_date = ? WHERE id = ?',
      ['active', nextDueDate.toISOString(), schoolId]
    );

    res.json({
      message: 'School approved and activated successfully',
      schoolId: schoolId,
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

    res.json({
      message: 'Statistics retrieved',
      statistics: stats[0] || {
        total_schools: 0,
        active_count: 0,
        pending_count: 0,
        suspended_count: 0,
        trial_count: 0,
        total_revenue: 0
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

module.exports = router;
