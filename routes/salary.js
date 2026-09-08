const express = require('express');
const router = express.Router();
const { authenticateToken } = require('./auth');
const { querySchool, querySchoolOne, runSchool } = require('../database_manager');

async function ensureSalaryTables(schoolId) {
  try {
    await runSchool(schoolId, `CREATE TABLE IF NOT EXISTS teacher_salaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, teacher_id INTEGER NOT NULL, basic_salary REAL DEFAULT 0,
      house_allowance REAL DEFAULT 0, medical_allowance REAL DEFAULT 0, transport_allowance REAL DEFAULT 0,
      other_allowances REAL DEFAULT 0, deductions REAL DEFAULT 0, tax REAL DEFAULT 0,
      effective_date TEXT, school_id INTEGER, created_at TEXT DEFAULT (datetime('now'))
    )`);
  } catch (e) {}
  try {
    await runSchool(schoolId, `CREATE TABLE IF NOT EXISTS salary_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, teacher_id INTEGER NOT NULL, month TEXT NOT NULL, year INTEGER NOT NULL,
      basic_salary REAL DEFAULT 0, allowances REAL DEFAULT 0, deductions REAL DEFAULT 0, tax REAL DEFAULT 0,
      net_salary REAL DEFAULT 0, payment_date TEXT, payment_method TEXT DEFAULT 'Cash', reference_no TEXT,
      remarks TEXT, paid_by TEXT, school_id INTEGER, created_at TEXT DEFAULT (datetime('now'))
    )`);
  } catch (e) {}
  for (const col of ['basic_salary', 'house_allowance', 'medical_allowance', 'transport_allowance', 'other_allowances', 'deductions', 'tax']) {
    try { await runSchool(schoolId, `ALTER TABLE teacher_salaries ADD COLUMN ${col} REAL DEFAULT 0`); } catch (e) {}
  }
  for (const col of ['basic_salary', 'allowances', 'deductions', 'tax', 'net_salary', 'payment_method', 'reference_no', 'remarks', 'paid_by']) {
    try { await runSchool(schoolId, `ALTER TABLE salary_payments ADD COLUMN ${col} TEXT`); } catch (e) {}
  }
}

// GET /api/salary/teachers - List all teachers with salary info
router.get('/teachers', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  try {
    await ensureSalaryTables(schoolId);
    const teachers = await querySchool(schoolId,
      `SELECT t.id, t.name, t.phone, t.subject, t.qualification, t.status,
              ts.id as salary_id, ts.basic_salary, ts.house_allowance, ts.medical_allowance,
              ts.transport_allowance, ts.other_allowances, ts.deductions, ts.tax, ts.effective_date
       FROM teachers t
       LEFT JOIN teacher_salaries ts ON ts.teacher_id = t.id
       WHERE t.status = 'Active'
       ORDER BY t.name`)
    res.json(teachers);
  } catch (err) {
    console.error('Error fetching teachers for salary:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/salary/setup - Save/update teacher salary structure
router.post('/setup', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { teacher_id, basic_salary, house_allowance, medical_allowance, transport_allowance, other_allowances, deductions, tax } = req.body;
  try {
    await ensureSalaryTables(schoolId);
    const existing = await querySchoolOne(schoolId, 'SELECT id FROM teacher_salaries WHERE teacher_id = ?', [teacher_id]);
    const totalAllow = (house_allowance || 0) + (medical_allowance || 0) + (transport_allowance || 0) + (other_allowances || 0);
    if (existing) {
      await runSchool(schoolId,
        `UPDATE teacher_salaries SET basic_salary=?, house_allowance=?, medical_allowance=?,
         transport_allowance=?, other_allowances=?, deductions=?, tax=?, effective_date=datetime('now')
         WHERE teacher_id=?`,
        [basic_salary || 0, house_allowance || 0, medical_allowance || 0, transport_allowance || 0, other_allowances || 0, deductions || 0, tax || 0, teacher_id]);
    } else {
      await runSchool(schoolId,
        `INSERT INTO teacher_salaries (teacher_id, basic_salary, house_allowance, medical_allowance,
         transport_allowance, other_allowances, deductions, tax, effective_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        [teacher_id, basic_salary || 0, house_allowance || 0, medical_allowance || 0, transport_allowance || 0, other_allowances || 0, deductions || 0, tax || 0]);
    }
    res.json({ message: 'Salary structure saved successfully' });
  } catch (err) {
    console.error('Error saving salary:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/salary/payments/:teacherId - Get payment history for a teacher
router.get('/payments/:teacherId', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  try {
    await ensureSalaryTables(schoolId);
    const payments = await querySchool(schoolId,
      'SELECT * FROM salary_payments WHERE teacher_id = ? ORDER BY year DESC, month DESC', [req.params.teacherId]);
    res.json(payments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/salary/pay - Process salary payment
router.post('/pay', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { teacher_id, month, year, payment_method, reference_no, remarks } = req.body;
  try {
    await ensureSalaryTables(schoolId);
    const salary = await querySchoolOne(schoolId,
      'SELECT * FROM teacher_salaries WHERE teacher_id = ?', [teacher_id]);
    if (!salary) return res.status(400).json({ error: 'No salary structure found for this teacher' });

    const existing = await querySchoolOne(schoolId,
      'SELECT id FROM salary_payments WHERE teacher_id = ? AND month = ? AND year = ?', [teacher_id, month, year]);
    if (existing) return res.status(400).json({ error: `Salary already paid for ${month} ${year}` });

    const totalAllow = (salary.house_allowance || 0) + (salary.medical_allowance || 0) + (salary.transport_allowance || 0) + (salary.other_allowances || 0);
    const totalDeductions = (salary.deductions || 0) + (salary.tax || 0);
    const netSalary = (salary.basic_salary || 0) + totalAllow - totalDeductions;

    const paidByName = req.user.adminName || req.user.teacherName || 'Admin';
    await runSchool(schoolId,
      `INSERT INTO salary_payments (teacher_id, month, year, basic_salary, allowances, deductions, tax,
       net_salary, payment_date, payment_method, reference_no, remarks, paid_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?)`,
      [teacher_id, month, year, salary.basic_salary || 0, totalAllow, salary.deductions || 0, salary.tax || 0,
       netSalary, payment_method || 'Cash', reference_no || '', remarks || '', paidByName]);

    res.json({ message: `Rs. ${netSalary} paid to teacher for ${month} ${year}`, net_salary: netSalary });
  } catch (err) {
    console.error('Error paying salary:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/salary/summary - Monthly salary summary
router.get('/summary', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { month, year } = req.query;
  try {
    await ensureSalaryTables(schoolId);
    const summary = await querySchool(schoolId,
      `SELECT sp.*, t.name as teacher_name, t.subject, t.phone
       FROM salary_payments sp
       JOIN teachers t ON t.id = sp.teacher_id
       WHERE sp.month = ? AND sp.year = ?
       ORDER BY t.name`, [month, year]);
    const totals = await querySchoolOne(schoolId,
      `SELECT COUNT(*) as count, SUM(net_salary) as total_paid
       FROM salary_payments WHERE month = ? AND year = ?`, [month, year]);
    res.json({ payments: summary, totals });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
