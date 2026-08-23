const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const { authenticateToken } = require('./auth');
const { querySchool, querySchoolOne, runSchool } = require('../database_manager');

// Setup multer storage for student photos
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const studentPhotosDir = path.join(config.UPLOADS_DIR, 'student_photos');
    if (!fs.existsSync(studentPhotosDir)) {
      fs.mkdirSync(studentPhotosDir, { recursive: true });
    }
    cb(null, studentPhotosDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, 'student-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
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

// GET /students - Search, filter, and list students
router.get('/', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { class_name, section_name, status, search } = req.query;

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
  if (status) {
    query += ' AND status = ?';
    params.push(status);
  } else {
    // Default to active students
    query += " AND (status IS NULL OR status != 'Left')";
  }

  if (search) {
    query += ' AND (name LIKE ? OR roll_no LIKE ? OR student_id LIKE ? OR father_name LIKE ? OR phone LIKE ?)';
    const searchParam = `%${search}%`;
    params.push(searchParam, searchParam, searchParam, searchParam, searchParam);
  }

  query += ' ORDER BY class_name, CAST(roll_no AS INTEGER), name';

  try {
    const students = await querySchool(schoolId, query, params);
    res.json(students);
  } catch (err) {
    console.error('Fetch students error:', err);
    res.status(500).json({ error: 'Failed to retrieve students: ' + err.message });
  }
});

// GET /students/classes - Get unique active classes
router.get('/classes', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  try {
    const rows = await querySchool(schoolId, 'SELECT DISTINCT class_name FROM students WHERE status != "Left" OR status IS NULL');
    const classes = rows.map(r => r.class_name).filter(Boolean);
    res.json(classes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /students/sections/:className - Get sections for a class
router.get('/sections/:className', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const className = req.params.className;
  try {
    const rows = await querySchool(schoolId, 'SELECT section_name FROM sections WHERE class_name = ?', [className]);
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

  let photoPath = '';
  if (req.file) {
    photoPath = 'uploads/student_photos/' + req.file.filename;
  }

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
        status, discount_amount, discount_percent, is_free, transport_fee, photo, family_head_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        photoPath,
        data.family_head_id ? parseInt(data.family_head_id) : null
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
      photoPath = 'uploads/student_photos/' + req.file.filename;
      // Delete old photo if it exists
      if (existing.photo) {
        const oldPath = path.join(config.DATABASES_DIR, '..', existing.photo);
        if (fs.existsSync(oldPath)) {
          try { fs.unlinkSync(oldPath); } catch (e) {}
        }
      }
    }

    await runSchool(
      schoolId,
      `UPDATE students SET
        student_id = ?, admission_no = ?, roll_no = ?, name = ?, father_name = ?, class_name = ?,
        section_name = ?, phone = ?, dob = ?, dob_words = ?, admission_date = ?, admission_class = ?,
        slc_no = ?, national_id = ?, religion = ?, gender = ?, status = ?, discount_amount = ?,
        discount_percent = ?, is_free = ?, transport_fee = ?, photo = ?, family_head_id = ?
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

module.exports = router;
