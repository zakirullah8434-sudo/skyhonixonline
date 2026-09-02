const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const { authenticateToken } = require('./auth');
const { queryMain, queryMainOne, runMain } = require('../database_manager');

// Setup multer storage for billing payment slips
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const receiptsDir = path.join(config.UPLOADS_DIR, 'receipts');
    if (!fs.existsSync(receiptsDir)) {
      fs.mkdirSync(receiptsDir, { recursive: true });
    }
    cb(null, receiptsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, 'receipt-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 3 * 1024 * 1024 } // 3MB
});

// GET /billing/status - Retrieve tenant billing info
router.get('/status', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;

  try {
    const school = await queryMainOne(
      'SELECT id, school_name, email, subscription_status, subscription_amount, next_due_date, phone, school_code, selected_package FROM schools WHERE id = ?',
      [schoolId]
    );

    if (!school) {
      return res.status(404).json({ error: 'School record not found' });
    }

    // Get payment history (slips submitted)
    const history = await queryMain(
      'SELECT * FROM payment_slips WHERE school_id = ? ORDER BY submitted_at DESC',
      [schoolId]
    );

    res.json({
      school,
      paymentHistory: history,
      paymentInstructions: {
        amount: school.subscription_amount || 1500,
        methods: [
          { name: 'EasyPaisa Mobile Account', account_no: '03459191224', title: 'Golden Sun Academy' },
          { name: 'JazzCash Wallet Account', account_no: '03459191224', title: 'Golden Sun Academy' },
          { name: 'HBL Bank Account Swat', account_no: '00100405009116', title: 'SkyHonix Education Software (Pvt) Ltd' }
        ]
      }
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /billing/pay-slip - Upload a payment receipt slip for approval
router.post('/pay-slip', authenticateToken, upload.single('receipt'), async (req, res) => {
  const schoolId = req.user.schoolId;
  const { amount, payment_date, notes } = req.body;

  if (!amount || !payment_date || !req.file) {
    return res.status(400).json({ error: 'Amount, payment_date, and receipt photo are required' });
  }

  const receiptPath = 'uploads/receipts/' + req.file.filename;

  try {
    await runMain(
      `INSERT INTO payment_slips (school_id, payment_date, amount, receipt_photo, status, notes, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        schoolId,
        payment_date,
        parseFloat(amount),
        receiptPath,
        'pending',
        notes || '',
        new Date().toISOString()
      ]
    );

    res.json({ message: 'Payment receipt submitted successfully! Admin will verify and activate your account within 24 hours.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------
// GLOBAL MASTER BILLING CONTROL (Access using PIN)
// ----------------------------------------------------

// Middleware to verify master pin
function checkMasterPin(req, res, next) {
  const pin = req.headers['x-master-pin'] || req.query.pin;
  if (pin !== 'goldensunbk') {
    return res.status(403).json({ error: 'Invalid master PIN access denied' });
  }
  next();
}

// GET /billing/admin/schools - Retrieve all registered schools
router.get('/admin/schools', checkMasterPin, async (req, res) => {
  try {
    const schools = await queryMain(`
      SELECT id, school_name, email, phone, school_code, subscription_status, next_due_date, created_at
      FROM schools
      ORDER BY created_at DESC
    `);
    res.json(schools);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /billing/admin/allow - Set school access duration in months
router.post('/admin/allow', checkMasterPin, async (req, res) => {
  const { school_id, months } = req.body;

  if (!school_id || !months) {
    return res.status(400).json({ error: 'school_id and months are required' });
  }

  try {
    const schoolIdInt = parseInt(school_id);
    const school = await queryMainOne('SELECT subscription_status, next_due_date FROM schools WHERE id = ?', [schoolIdInt]);

    if (!school) {
      return res.status(404).json({ error: 'School not found' });
    }

    let baseDate = new Date();
    // If currently active and next_due_date is in the future, we extend from that date
    if (school.subscription_status === 'active' && school.next_due_date && new Date(school.next_due_date) > baseDate) {
      baseDate = new Date(school.next_due_date);
    }

    baseDate.setMonth(baseDate.getMonth() + parseInt(months));
    const extendedDueDate = baseDate.toISOString().split('T')[0];

    await runMain(
      "UPDATE schools SET subscription_status = 'active', next_due_date = ? WHERE id = ?",
      [extendedDueDate, schoolIdInt]
    );

    res.json({ message: `Access allowed successfully for ${months} month(s). New due date: ${extendedDueDate}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /billing/admin/slips - Retrieve all billing logs across ALL schools
router.get('/admin/slips', checkMasterPin, async (req, res) => {
  try {
    const slips = await queryMain(`
      SELECT ps.*, s.school_name, s.email, s.subscription_status as current_status
      FROM payment_slips ps
      JOIN schools s ON s.id = ps.school_id
      ORDER BY ps.status = 'pending' DESC, ps.submitted_at DESC
    `);
    res.json(slips);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /billing/admin/verify - Approve/Reject a payment slip
router.post('/admin/verify', checkMasterPin, async (req, res) => {
  const { slip_id, action, notes } = req.body; // action: 'approve' or 'reject'

  if (!slip_id || !action) {
    return res.status(400).json({ error: 'slip_id and action are required' });
  }

  try {
    const slip = await queryMainOne('SELECT * FROM payment_slips WHERE id = ?', [slip_id]);
    if (!slip) {
      return res.status(404).json({ error: 'Payment slip not found' });
    }

    if (action === 'approve') {
      // 1. Mark slip approved
      await runMain("UPDATE payment_slips SET status = 'approved', notes = ? WHERE id = ?", [notes || 'Approved by Master Admin', slip_id]);

      // 2. Fetch current next_due_date for school
      const school = await queryMainOne('SELECT subscription_status, next_due_date FROM schools WHERE id = ?', [slip.school_id]);
      
      let baseDate = new Date();
      // If current status is active and due date is in the future, extend it
      if (school.next_due_date && new Date(school.next_due_date) > baseDate) {
        baseDate = new Date(school.next_due_date);
      }

      baseDate.setDate(baseDate.getDate() + 30); // Extend 30 days
      const extendedDueDate = baseDate.toISOString().split('T')[0];

      // 3. Activate/extend school subscription status
      await runMain(
        "UPDATE schools SET subscription_status = 'active', next_due_date = ? WHERE id = ?",
        [extendedDueDate, slip.school_id]
      );

      res.json({ message: 'Payment approved. School subscription activated/extended successfully!' });
    } else {
      // Reject slip
      await runMain("UPDATE payment_slips SET status = 'rejected', notes = ? WHERE id = ?", [notes || 'Rejected by Admin', slip_id]);
      res.json({ message: 'Payment receipt rejected.' });
    }

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /billing/admin/status - Direct update subscription status (manual override)
router.post('/admin/status', checkMasterPin, async (req, res) => {
  const { school_id, status, next_due_date } = req.body;

  if (!school_id || !status) {
    return res.status(400).json({ error: 'school_id and status are required' });
  }

  try {
    await runMain(
      'UPDATE schools SET subscription_status = ?, next_due_date = ? WHERE id = ?',
      [status, next_due_date || null, parseInt(school_id)]
    );
    res.json({ message: 'School subscription details modified successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
