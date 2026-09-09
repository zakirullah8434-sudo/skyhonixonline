const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const { authenticateToken } = require('./auth');
const { querySchool, querySchoolOne, runSchool } = require('../database_manager');
const syncManager = require('../sync_manager');

// Setup multer memory storage for student photos (base64 in DB, not file on disk)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (extname && mimetype) {
      return cb(null, true);
    }
    cb(new Error('Only images are allowed'));
  }
});

function fileToDataUri(file) {
  if (!file) return '';
  const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
  const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
  return `data:${mime};base64,${file.buffer.toString('base64')}`;
}

// GET /students - Search, filter, and list students (optimized: no photo, with pagination)
router.get('/', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { class_name, section_name, status, search, page, limit } = req.query;

  // Exclude heavy photo column from list views
  let query = `SELECT id, student_id, name, roll_no, class_name, section_name, father_name, phone,
    status, is_free, discount_amount, discount_percent, transport_fee, family_head_id,
    dob, admission_date, gender, blood_group
    FROM students WHERE 1=1`;
  const params = [];

  if (class_name) {
    query += ' AND class_name = ?';
    params.push(class_name);
  }
  if (section_name) {
    if (section_name === 'No Section') {
      query += " AND (section_name IS NULL OR section_name = '')";
    } else {
      query += ' AND section_name = ?';
      params.push(section_name);
    }
  }
  if (status) {
    query += ' AND status = ?';
    params.push(status);
  } else {
    query += " AND (status IS NULL OR status != 'Left')";
  }

  if (search) {
    query += ' AND (name LIKE ? OR roll_no LIKE ? OR student_id LIKE ? OR father_name LIKE ? OR phone LIKE ?)';
    const searchParam = `%${search}%`;
    params.push(searchParam, searchParam, searchParam, searchParam, searchParam);
  }

  // Pagination
  const pageNum = Math.max(1, parseInt(page) || 1);
  const pageSize = Math.min(500, Math.max(1, parseInt(limit) || 200));
  const offset = (pageNum - 1) * pageSize;

  // Get total count for pagination metadata
  let countQuery = 'SELECT COUNT(*) as total FROM students WHERE 1=1';
  const countParams = [];
  if (class_name) { countQuery += ' AND class_name = ?'; countParams.push(class_name); }
  if (section_name) {
    if (section_name === 'No Section') { countQuery += " AND (section_name IS NULL OR section_name = '')"; }
    else { countQuery += ' AND section_name = ?'; countParams.push(section_name); }
  }
  if (status) { countQuery += ' AND status = ?'; countParams.push(status); }
  else { countQuery += " AND (status IS NULL OR status != 'Left')"; }
  if (search) {
    countQuery += ' AND (name LIKE ? OR roll_no LIKE ? OR student_id LIKE ? OR father_name LIKE ? OR phone LIKE ?)';
    const sp = `%${search}%`;
    countParams.push(sp, sp, sp, sp, sp);
  }

  query += ' ORDER BY class_name, CAST(roll_no AS INTEGER), name LIMIT ? OFFSET ?';
  params.push(pageSize, offset);

  try {
    const [students, countResult] = await Promise.all([
      querySchool(schoolId, query, params),
      querySchoolOne(schoolId, countQuery, countParams)
    ]);
    res.json({
      data: students,
      pagination: {
        page: pageNum,
        limit: pageSize,
        total: countResult ? countResult.total : students.length,
        pages: Math.ceil((countResult ? countResult.total : 0) / pageSize)
      }
    });
  } catch (err) {
    console.error('Fetch students error:', err);
    res.status(500).json({ error: 'Failed to retrieve students: ' + err.message });
  }
});

// GET /students/classes - Get unique active classes
router.get('/classes', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  try {
    const rows = await querySchool(schoolId, "SELECT DISTINCT class_name FROM students WHERE status != 'Left' OR status IS NULL");
    const classes = rows.map(r => r.class_name).filter(Boolean);
    res.json(classes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /students/all - Get ALL students including Left status (for profile search)
router.get('/all', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { class_name, section_name, search } = req.query;

  let query = 'SELECT * FROM students WHERE 1=1';
  const params = [];

  if (class_name) {
    query += ' AND class_name = ?';
    params.push(class_name);
  }
  if (section_name) {
    if (section_name === 'No Section') {
      query += " AND (section_name IS NULL OR section_name = '')";
    } else {
      query += ' AND section_name = ?';
      params.push(section_name);
    }
  }
  if (search) {
    query += ' AND (name LIKE ? OR student_id LIKE ? OR class_name LIKE ? OR father_name LIKE ? OR phone LIKE ? OR roll_no LIKE ?)';
    const searchParam = `%${search}%`;
    params.push(searchParam, searchParam, searchParam, searchParam, searchParam, searchParam);
  }

  query += ' ORDER BY class_name, CAST(roll_no AS INTEGER), name';

  try {
    const students = await querySchool(schoolId, query, params);
    res.json(students);
  } catch (err) {
    console.error('Fetch all students error:', err);
    res.status(500).json({ error: 'Failed to retrieve students: ' + err.message });
  }
});

// GET /students/sections/:className - Get sections for a class
router.get('/sections/:className', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const className = req.params.className;
  try {
    const rows = await querySchool(schoolId,
      `SELECT DISTINCT section_name FROM students WHERE class_name = ? AND section_name IS NOT NULL AND section_name != '' AND (status IS NULL OR status != 'Left') ORDER BY section_name`,
      [className]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /students/:id - Fetch single student details with family/sibling info
router.get('/:id', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const studentId = req.params.id;

  try {
    const student = await querySchoolOne(schoolId, 'SELECT * FROM students WHERE id = ?', [studentId]);
    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }

    // Get siblings if any
    let siblings = [];
    if (student.family_head_id) {
      // Current student is a sibling. Get the head and other siblings
      siblings = await querySchool(
        schoolId,
        'SELECT id, name, roll_no, class_name, section_name, is_free, discount_amount, discount_percent FROM students WHERE (family_head_id = ? OR id = ?) AND id != ?',
        [student.family_head_id, student.family_head_id, studentId]
      );
    } else {
      // Current student might be a family head. Get their siblings
      siblings = await querySchool(
        schoolId,
        'SELECT id, name, roll_no, class_name, section_name, is_free, discount_amount, discount_percent FROM students WHERE family_head_id = ?',
        [studentId]
      );
    }

    res.json({ student, siblings });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch student details: ' + err.message });
  }
});

// POST /students - Create a student
router.post('/', authenticateToken, upload.single('photo'), async (req, res) => {
  const schoolId = req.user.schoolId;
  const data = req.body;

  const photoDataUri = fileToDataUri(req.file);

  try {
    // Generate unique custom student_id if not provided
    let studentIdCode = data.student_id;
    if (!studentIdCode) {
      const year = new Date().getFullYear();
      const countRow = await querySchoolOne(schoolId, 'SELECT COUNT(*) as count FROM students');
      studentIdCode = `ST-${year}-${countRow.count + 1}`;
    }

    const result = await runSchool(
      schoolId,
      `INSERT INTO students (
        student_id, admission_no, roll_no, name, father_name, class_name, section_name, phone,
        dob, dob_words, admission_date, admission_class, slc_no, national_id, religion, gender,
        status, discount_amount, discount_percent, is_free, transport_fee, photo, family_head_id,
        address, previous_school, previous_school_contact, blood_group
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        studentIdCode,
        data.admission_no || '',
        data.roll_no || '',
        data.name,
        data.father_name || '',
        data.class_name,
        data.section_name || '',
        data.phone || '',
        data.dob || '',
        data.dob_words || '',
        data.admission_date || new Date().toISOString().split('T')[0],
        data.admission_class || data.class_name,
        data.slc_no || '',
        data.national_id || '',
        data.religion || 'Islam',
        data.gender || 'Male',
        data.status || 'Active',
        parseFloat(data.discount_amount) || 0,
        parseFloat(data.discount_percent) || 0,
        parseInt(data.is_free) || 0,
        parseFloat(data.transport_fee) || 0,
        photoDataUri,
        data.family_head_id ? parseInt(data.family_head_id) : null,
        data.address || '',
        data.previous_school || '',
        data.previous_school_contact || '',
        data.blood_group || ''
      ]
    );

    res.status(201).json({
      message: 'Student added successfully!',
      id: result.id,
      studentId: studentIdCode
    });
  } catch (err) {
    console.error('Create student error:', err);
    res.status(500).json({ error: 'Failed to create student: ' + err.message });
  }
});

// PUT /students/:id - Update student
router.put('/:id', authenticateToken, upload.single('photo'), async (req, res) => {
  const schoolId = req.user.schoolId;
  const id = req.params.id;
  const data = req.body;

  try {
    const existing = await querySchoolOne(schoolId, 'SELECT photo FROM students WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ error: 'Student not found' });
    }

    let photoPath = existing.photo;
    if (req.file) {
      photoPath = fileToDataUri(req.file);
    }

    await runSchool(
      schoolId,
      `UPDATE students SET
        student_id = ?, admission_no = ?, roll_no = ?, name = ?, father_name = ?, class_name = ?,
        section_name = ?, phone = ?, dob = ?, dob_words = ?, admission_date = ?, admission_class = ?,
        slc_no = ?, national_id = ?, religion = ?, gender = ?, status = ?, discount_amount = ?,
        discount_percent = ?, is_free = ?, transport_fee = ?, photo = ?, family_head_id = ?,
        address = ?, previous_school = ?, previous_school_contact = ?, blood_group = ?
      WHERE id = ?`,
      [
        data.student_id,
        data.admission_no || '',
        data.roll_no || '',
        data.name,
        data.father_name || '',
        data.class_name,
        data.section_name || '',
        data.phone || '',
        data.dob || '',
        data.dob_words || '',
        data.admission_date || '',
        data.admission_class || '',
        data.slc_no || '',
        data.national_id || '',
        data.religion || '',
        data.gender || '',
        data.status || 'Active',
        parseFloat(data.discount_amount) || 0,
        parseFloat(data.discount_percent) || 0,
        parseInt(data.is_free) || 0,
        parseFloat(data.transport_fee) || 0,
        photoPath,
        data.family_head_id ? parseInt(data.family_head_id) : null,
        data.address || '',
        data.previous_school || '',
        data.previous_school_contact || '',
        data.blood_group || '',
        id
      ]
    );

    res.json({ message: 'Student details updated successfully!' });
  } catch (err) {
    console.error('Update student error:', err);
    res.status(500).json({ error: 'Failed to update student: ' + err.message });
  }
});

// POST /students/:id/archive - Archive student (mark as Left)
router.post('/:id/archive', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const id = req.params.id;
  try {
    await runSchool(schoolId, "UPDATE students SET status = 'Left' WHERE id = ?", [id]);
    res.json({ message: 'Student marked as Left successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /students/sibling-candidates - Get list of potential family heads
router.get('/sibling-candidates/all', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { excludeId } = req.query;

  try {
    // Sibling candidates are students who are NOT siblings themselves (family_head_id is null)
    let sql = "SELECT id, name, roll_no, class_name, section_name, father_name FROM students WHERE family_head_id IS NULL AND (status IS NULL OR status != 'Left')";
    const params = [];

    if (excludeId) {
      sql += ' AND id != ?';
      params.push(excludeId);
    }
    
    sql += ' ORDER BY name';

    const candidates = await querySchool(schoolId, sql, params);
    res.json(candidates);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /students/:id/profile - Complete student profile with fees, exams, attendance
router.get('/:id/profile', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const studentId = req.params.id;

  try {
    // 1. Basic student info
    const student = await querySchoolOne(schoolId,
      'SELECT * FROM students WHERE id = ?', [studentId]
    );
    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }

    const safeQuery = (sql, params=[]) => querySchool(schoolId, sql, params).catch(() => []);

    // Parallel fetch all profile sub-queries (with LIMIT to prevent memory blowup)
    const [feeLedger, payments, marks, results, attendance, exceptions, dues, parents, promotionHistory, homework, certificates, documents, transferHistory] = await Promise.all([
      safeQuery(`SELECT id, month, year, base_fee, discount, monthly_fee, previous_due, total_payable, paid_amount, status, transport_fee FROM fee_ledger WHERE student_id = ? ORDER BY year DESC, month DESC LIMIT 60`, [studentId]),
      safeQuery(`SELECT id, month, year, amount_paid, payment_date, fee_ledger_id FROM fee_payments WHERE student_id = ? ORDER BY payment_date DESC LIMIT 100`, [studentId]),
      safeQuery(`SELECT m.id, m.student_id, m.exam_id, m.subject, m.marks, m.term, e.exam_name, e.year FROM marks m JOIN exams e ON e.id = m.exam_id WHERE m.student_id = ? ORDER BY e.year DESC, e.exam_name, m.term, m.subject LIMIT 500`, [studentId]),
      safeQuery(`SELECT r.id, r.student_id, r.exam_id, r.term, r.total, r.obtained, r.percentage, r.grade, r.position, r.remarks, e.exam_name, e.year FROM results r JOIN exams e ON e.id = r.exam_id WHERE r.student_id = ? ORDER BY e.year DESC, e.exam_name LIMIT 100`, [studentId]),
      safeQuery(`SELECT id, date, status, time FROM attendance WHERE student_id = ? ORDER BY date DESC LIMIT 180`, [studentId]),
      safeQuery(`SELECT id, student_id, exception_type, amount, reason, date FROM student_fee_exceptions WHERE student_id = ?`, [studentId]),
      safeQuery(`SELECT id, student_id, due_amount FROM fee_dues WHERE student_id = ?`, [studentId]),
      safeQuery(`SELECT p.id, p.name, p.phone, p.email, sp.relation FROM student_parents sp JOIN parents p ON p.id = sp.parent_id WHERE sp.student_id = ?`, [studentId]),
      safeQuery(`SELECT id, student_id, from_class, to_class, exam_year, promotion_date, final_percentage, remarks FROM student_promotion_history WHERE student_id = ? ORDER BY promotion_date DESC LIMIT 20`, [studentId]),
      safeQuery(`SELECT a.id, a.title, a.subject, a.description, a.type, a.due_date, a.priority, a.created_at, t.name as teacher_name FROM assignments a LEFT JOIN teachers t ON t.id = a.teacher_id WHERE a.class_name = ? AND (a.section_name = ? OR a.section_name = '' OR a.section_name IS NULL) ORDER BY a.created_at DESC LIMIT 50`, [student.class_name, student.section_name || '']),
      safeQuery(`SELECT id, student_id, certificate_name, certificate_type, issue_date, description FROM student_certificates WHERE student_id = ? ORDER BY issue_date DESC LIMIT 20`, [studentId]),
      safeQuery(`SELECT id, student_id, document_name, document_type, upload_date, description, created_at FROM student_documents WHERE student_id = ? ORDER BY created_at DESC LIMIT 50`, [studentId]),
      safeQuery(`SELECT id, student_id, transfer_date, from_class, to_class, to_school, reason, remarks FROM student_transfer_history WHERE student_id = ? ORDER BY transfer_date DESC LIMIT 20`, [studentId])
    ]);

    // Calculate stats
    let totalPaid = 0;
    payments.forEach(p => totalPaid += (p.amount_paid || 0));

    let totalDue = 0;
    feeLedger.forEach(f => totalDue += ((f.total_payable || 0) - (f.paid_amount || 0)));
    if (totalDue < 0) totalDue = 0;

    let presentDays = attendance.filter(a => a.status === 'present' || a.status === 'Present').length;
    let absentDays = attendance.filter(a => a.status === 'absent' || a.status === 'Absent').length;
    let attendanceRate = attendance.length > 0 ? ((presentDays / attendance.length) * 100).toFixed(1) : 0;

    let totalMarksObtained = 0;
    let totalMaxMarks = 0;
    marks.forEach(m => {
      totalMarksObtained += (m.marks || 0);
      totalMaxMarks += (m.max_marks || 100);
    });
    let avgPercentage = totalMaxMarks > 0 ? ((totalMarksObtained / totalMaxMarks) * 100).toFixed(1) : 0;

    res.json({
      student,
      feeLedger,
      payments,
      marks,
      results,
      attendance,
      exceptions,
      dues,
      parents,
      promotionHistory,
      homework,
      certificates,
      documents,
      transferHistory,
      stats: {
        totalPaid,
        totalDue,
        presentDays,
        absentDays,
        attendanceRate,
        totalMarksObtained,
        totalMaxMarks,
        avgPercentage
      }
    });
  } catch (err) {
    console.error('Error fetching student profile:', err);
    res.status(500).json({ error: 'Failed to load student profile: ' + err.message });
  }
});

// POST /students/:id/certificates - Add a certificate
router.post('/:id/certificates', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const studentId = req.params.id;
  const { certificate_name, certificate_type, issue_date, description } = req.body;

  try {
    const result = await runSchool(schoolId,
      `INSERT INTO student_certificates (student_id, certificate_name, certificate_type, issue_date, description, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [studentId, certificate_name, certificate_type || 'General', issue_date || '', description || '', new Date().toISOString()]
    );
    res.status(201).json({ message: 'Certificate added successfully!', id: result.id });
  } catch (err) {
    console.error('Add certificate error:', err);
    res.status(500).json({ error: 'Failed to add certificate: ' + err.message });
  }
});

// DELETE /students/:id/certificates/:certId - Remove a certificate
router.delete('/:id/certificates/:certId', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  try {
    await runSchool(schoolId, 'DELETE FROM student_certificates WHERE id = ?', [req.params.certId]);
    res.json({ message: 'Certificate removed.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove certificate.' });
  }
});

// POST /students/:id/documents - Add a document
router.post('/:id/documents', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const studentId = req.params.id;
  const { document_name, document_type, upload_date, description } = req.body;

  try {
    const result = await runSchool(schoolId,
      `INSERT INTO student_documents (student_id, document_name, document_type, upload_date, description, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [studentId, document_name, document_type || 'Other', upload_date || new Date().toISOString().split('T')[0], description || '', new Date().toISOString()]
    );
    res.status(201).json({ message: 'Document added successfully!', id: result.id });
  } catch (err) {
    console.error('Add document error:', err);
    res.status(500).json({ error: 'Failed to add document: ' + err.message });
  }
});

// DELETE /students/:id/documents/:docId - Remove a document
router.delete('/:id/documents/:docId', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  try {
    await runSchool(schoolId, 'DELETE FROM student_documents WHERE id = ?', [req.params.docId]);
    res.json({ message: 'Document removed.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove document.' });
  }
});

// POST /students/:id/transfers - Add a transfer record
router.post('/:id/transfers', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const studentId = req.params.id;
  const { transfer_date, from_class, to_class, to_school, reason, remarks } = req.body;

  try {
    const result = await runSchool(schoolId,
      `INSERT INTO student_transfer_history (student_id, transfer_date, from_class, to_class, to_school, reason, remarks, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [studentId, transfer_date || new Date().toISOString().split('T')[0], from_class || '', to_class || '', to_school || '', reason || '', remarks || '', new Date().toISOString()]
    );
    res.status(201).json({ message: 'Transfer record added!', id: result.id });
  } catch (err) {
    console.error('Add transfer error:', err);
    res.status(500).json({ error: 'Failed to add transfer record: ' + err.message });
  }
});

// DELETE /students/:id/transfers/:transferId - Remove a transfer record
router.delete('/:id/transfers/:transferId', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  try {
    await runSchool(schoolId, 'DELETE FROM student_transfer_history WHERE id = ?', [req.params.transferId]);
    res.json({ message: 'Transfer record removed.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove transfer record.' });
  }
});

module.exports = router;
