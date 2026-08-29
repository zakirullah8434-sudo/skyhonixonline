const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const config = require('../config');
const { queryMain, getSchoolDb } = require('../database_manager');

function querySchool(schoolId, sql, params = []) {
  return new Promise(async (resolve, reject) => {
    try {
      const db = await getSchoolDb(schoolId);
      db.all(sql, params, (err, rows) => { if (err) reject(err); else resolve(rows); });
    } catch (e) { reject(e); }
  });
}

function querySchoolOne(schoolId, sql, params = []) {
  return new Promise(async (resolve, reject) => {
    try {
      const db = await getSchoolDb(schoolId);
      db.get(sql, params, (err, row) => { if (err) reject(err); else resolve(row); });
    } catch (e) { reject(e); }
  });
}

function authenticateParentToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access denied' });
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET);
    if (decoded.role !== 'parent') return res.status(403).json({ error: 'Invalid role' });
    req.parent = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// POST /parents/login - Parent login (school_id + phone + password)
router.post('/login', async (req, res) => {
  const { school_id, phone, password } = req.body;
  if (!school_id || !phone || !password) {
    return res.status(400).json({ error: 'School ID, phone, and password are required' });
  }
  try {
    const schools = await queryMain('SELECT id, school_name, db_file FROM schools WHERE id = ?', [school_id]);
    if (schools.length === 0) {
      return res.status(404).json({ error: 'School not found with this ID' });
    }
    const school = schools[0];
    const parents = await querySchool(school.id,
      'SELECT id, name, phone, password, status FROM parents WHERE phone = ?',
      [phone]
    );
    if (parents.length === 0) {
      return res.status(401).json({ error: 'No parent account found with this phone number' });
    }
    const parent = parents[0];
    if (parent.status !== 'Active') {
      return res.status(403).json({ error: 'Parent account is inactive' });
    }
    const validPassword = await bcrypt.compare(password, parent.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid password' });
    }
    const token = jwt.sign({
      schoolId: school.id,
      schoolName: school.school_name,
      parentId: parent.id,
      parentName: parent.name,
      role: 'parent'
    }, config.JWT_SECRET, { expiresIn: '7d' });
    res.json({
      token,
      user: {
        role: 'parent',
        parentId: parent.id,
        parentName: parent.name,
        schoolId: school.id,
        schoolName: school.school_name
      }
    });
  } catch (err) {
    console.error('Parent login error:', err);
    res.status(500).json({ error: 'Login failed: ' + err.message });
  }
});

// GET /parents/my-children - Get children linked to this parent (by link table OR phone match)
router.get('/my-children', authenticateParentToken, async (req, res) => {
  const schoolId = req.parent.schoolId;
  const parentId = req.parent.parentId;
  try {
    // Get parent phone
    const parentInfo = await querySchoolOne(schoolId, 'SELECT phone FROM parents WHERE id = ?', [parentId]);
    const parentPhone = parentInfo ? parentInfo.phone : '';

    // Find children via student_parents link OR by matching phone in students table
    const children = await querySchool(schoolId,
      `SELECT DISTINCT s.id, s.student_id, s.name, s.class_name, s.section_name, s.roll_no, s.photo,
              s.father_name, s.phone, 'Father' as relation
       FROM students s
       LEFT JOIN student_parents sp ON s.id = sp.student_id AND sp.parent_id = ?
       WHERE (sp.id IS NOT NULL OR s.phone = ?)
       AND (s.status IS NULL OR s.status != 'Left')
       ORDER BY s.class_name, s.name`,
      [parentId, parentPhone]
    );
    res.json(children);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /parents/my-fees - Get fee records for a student
router.get('/my-fees/:studentId', authenticateParentToken, async (req, res) => {
  const schoolId = req.parent.schoolId;
  const parentId = req.parent.parentId;
  const studentId = req.params.studentId;
  try {
    const parentInfo = await querySchoolOne(schoolId, 'SELECT phone FROM parents WHERE id = ?', [parentId]);
    const child = await querySchoolOne(schoolId,
      `SELECT s.id FROM students s
       LEFT JOIN student_parents sp ON s.id = sp.student_id AND sp.parent_id = ?
       WHERE s.id = ? AND (sp.id IS NOT NULL OR s.phone = ?)`,
      [parentId, studentId, parentInfo ? parentInfo.phone : '']
    );
    if (!child) return res.status(403).json({ error: 'Access denied' });

    const ledger = await querySchool(schoolId,
      `SELECT id, month, year, paid_amount, total_payable, discount, status, transport_fee, created_at
       FROM fee_ledger WHERE student_id = ? ORDER BY year DESC,
       CASE month WHEN 'January' THEN 1 WHEN 'February' THEN 2 WHEN 'March' THEN 3
       WHEN 'April' THEN 4 WHEN 'May' THEN 5 WHEN 'June' THEN 6 WHEN 'July' THEN 7
       WHEN 'August' THEN 8 WHEN 'September' THEN 9 WHEN 'October' THEN 10
       WHEN 'November' THEN 11 WHEN 'December' THEN 12 END`,
      [studentId]
    );

    const feeSettings = await querySchoolOne(schoolId,
      'SELECT monthly_fee FROM class_fees WHERE class_name = (SELECT class_name FROM students WHERE id = ?)',
      [studentId]
    );

    res.json({ ledger, feeSettings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /parents/my-exams - Get exam results for a student
router.get('/my-exams/:studentId', authenticateParentToken, async (req, res) => {
  const schoolId = req.parent.schoolId;
  const parentId = req.parent.parentId;
  const studentId = req.params.studentId;
  try {
    // Verify access via link OR phone match
    const parentInfo = await querySchoolOne(schoolId, 'SELECT phone FROM parents WHERE id = ?', [parentId]);
    const child = await querySchoolOne(schoolId,
      `SELECT s.id, s.class_name, s.section_name FROM students s
       LEFT JOIN student_parents sp ON s.id = sp.student_id AND sp.parent_id = ?
       WHERE s.id = ? AND (sp.id IS NOT NULL OR s.phone = ?)`,
      [parentId, studentId, parentInfo ? parentInfo.phone : '']
    );
    if (!child) return res.status(403).json({ error: 'Access denied' });

    const exams = await querySchool(schoolId,
      `SELECT e.id, e.exam_name, e.year, e.classes FROM exams e
       ORDER BY e.year DESC, e.exam_name ASC`
    );

    const results = [];
    for (const exam of exams) {
      try {
        const classes = JSON.parse(exam.classes || '[]');
        if (!classes.includes(child.class_name)) continue;

        const marks = await querySchool(schoolId,
          `SELECT m.subject, m.marks, m.term, es.max_marks
           FROM marks m
           LEFT JOIN exam_subjects es ON m.exam_id = es.exam_id AND m.subject = es.subject AND es.class = ?
           WHERE m.exam_id = ? AND m.student_id = ?
           ORDER BY m.subject`,
          [child.class_name, exam.id, studentId]
        );
        if (marks.length > 0) {
          results.push({ exam, marks });
        }
      } catch (e) {}
    }
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /parents/my-attendance - Get attendance for a student
router.get('/my-attendance/:studentId', authenticateParentToken, async (req, res) => {
  const schoolId = req.parent.schoolId;
  const parentId = req.parent.parentId;
  const studentId = req.params.studentId;
  try {
    const parentInfo = await querySchoolOne(schoolId, 'SELECT phone FROM parents WHERE id = ?', [parentId]);
    const child = await querySchoolOne(schoolId,
      `SELECT s.id FROM students s
       LEFT JOIN student_parents sp ON s.id = sp.student_id AND sp.parent_id = ?
       WHERE s.id = ? AND (sp.id IS NOT NULL OR s.phone = ?)`,
      [parentId, studentId, parentInfo ? parentInfo.phone : '']
    );
    if (!child) return res.status(403).json({ error: 'Access denied' });

    const { month, year } = req.query;
    let query = `SELECT date, status, time FROM attendance WHERE student_id = ?`;
    const params = [studentId];

    if (month && year) {
      query += ` AND strftime('%m', date) = ? AND strftime('%Y', date) = ?`;
      params.push(month.padStart(2, '0'), year);
    }
    query += ` ORDER BY date DESC`;

    const attendance = await querySchool(schoolId, query, params);
    res.json(attendance);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /parents/announcements - Get announcements for parents
router.get('/announcements', authenticateParentToken, async (req, res) => {
  const schoolId = req.parent.schoolId;
  try {
    const announcements = await querySchool(schoolId,
      `SELECT id, title, message, target_role, created_by, created_at 
       FROM announcements WHERE target_role IN ('all', 'parents')
       ORDER BY created_at DESC`
    );
    res.json(announcements);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
