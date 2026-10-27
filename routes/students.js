const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const config = require('../config');
const { authenticateToken } = require('./auth');
const { querySchool, querySchoolOne, runSchool, querySchoolRaw } = require('../database_manager');
const syncManager = require('../sync_manager');
const { compareClasses, compareStudents } = require('../class_order');

// Ensure the school_classes registry table exists for a tenant
async function ensureSchoolClassesTable(schoolId) {
  await runSchool(schoolId,
    `CREATE TABLE IF NOT EXISTS school_classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_name TEXT NOT NULL UNIQUE,
      has_sections INTEGER DEFAULT 0,
      school_id INTEGER
    )`).catch(() => {});
}

// All known classes merged from the registry, students, sections and class_fees
async function fetchMergedClasses(schoolId) {
  await ensureSchoolClassesTable(schoolId);
  const [regRows, rows, secRows, feeRows] = await Promise.all([
    querySchoolRaw(schoolId,
      `SELECT class_name, has_sections FROM school_classes WHERE (school_id = ? OR school_id IS NULL) AND class_name IS NOT NULL AND class_name != ''`, [schoolId]).catch(() => []),
    querySchoolRaw(schoolId,
      `SELECT DISTINCT class_name FROM students WHERE (school_id = ? OR school_id IS NULL) AND (status != 'Left' OR status IS NULL) AND class_name IS NOT NULL AND class_name != ''`, [schoolId]).catch(() => []),
    querySchoolRaw(schoolId,
      `SELECT DISTINCT class_name FROM sections WHERE (school_id = ? OR school_id IS NULL) AND class_name IS NOT NULL AND class_name != ''`, [schoolId]).catch(() => []),
    querySchoolRaw(schoolId,
      `SELECT DISTINCT class_name FROM class_fees WHERE (school_id = ? OR school_id IS NULL) AND class_name IS NOT NULL AND class_name != ''`, [schoolId]).catch(() => [])
  ]);

  const classMap = new Map(); // lowercased name -> { class_name, has_sections(null=implicit) }
  const add = (name, hasSections) => {
    const key = String(name).trim().toLowerCase();
    if (!key) return;
    if (!classMap.has(key)) classMap.set(key, { class_name: String(name).trim(), has_sections: hasSections });
    else if (hasSections !== null && classMap.get(key).has_sections === null) classMap.get(key).has_sections = hasSections;
  };
  regRows.forEach(r => add(r.class_name, r.has_sections ? 1 : 0));
  rows.forEach(r => add(r.class_name, null));
  secRows.forEach(r => add(r.class_name, null));
  feeRows.forEach(r => add(r.class_name, null));

  const merged = Array.from(classMap.values());
  merged.sort((a, b) => compareClasses(a.class_name, b.class_name));
  return merged;
}

// Sections for a class: registry (sections table) + student-derived, honouring has_sections=0
async function fetchClassSections(schoolId, className) {
  await ensureSchoolClassesTable(schoolId);
  const reg = await querySchoolOne(schoolId,
    `SELECT has_sections FROM school_classes WHERE class_name = ?`, [className]).catch(() => null);

  // Class explicitly created WITHOUT sections -> no sections at all
  if (reg && !reg.has_sections) return [];

  const [secRows, stuRows] = await Promise.all([
    querySchool(schoolId,
      `SELECT DISTINCT section_name FROM sections WHERE class_name = ? AND section_name IS NOT NULL AND section_name != '' ORDER BY section_name`,
      [className]).catch(() => []),
    querySchool(schoolId,
      `SELECT DISTINCT section_name FROM students WHERE class_name = ? AND section_name IS NOT NULL AND section_name != '' AND (status IS NULL OR status != 'Left')`,
      [className]).catch(() => [])
  ]);

  const seen = new Set();
  const out = [];
  [...secRows, ...stuRows].forEach(r => {
    const name = String(r.section_name || '').trim();
    if (name && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      out.push({ section_name: name });
    }
  });
  out.sort((a, b) => a.section_name.localeCompare(b.section_name));
  return out;
}

function parseSectionsInput(sections) {
  if (!sections) return [];
  const list = Array.isArray(sections) ? sections : String(sections).split(/[,;]/);
  const seen = new Set();
  const out = [];
  list.forEach(s => {
    const name = String(s || '').trim();
    if (name && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      out.push(name);
    }
  });
  return out;
}

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

// GET /students - Search, filter, and list students (with photo)
router.get('/', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { class_name, section_name, status, search, page, limit, lite, slim } = req.query;

  // slim=1: minimal photo-free projection for fast bulk flows (e.g. roll no slip preview)
  const selectCols = slim
    ? 'id, name, roll_no, class_name, section_name, father_name'
    : 'id, student_id, admission_no, name, roll_no, class_name, section_name, father_name, phone, status, is_free, discount_amount, discount_percent, transport_fee, family_head_id, dob, admission_date, gender, blood_group, photo';

  let query = `SELECT ${selectCols}
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
  const hasPagination = !!(page || limit);
  const pageNum = Math.max(1, parseInt(page) || 1);
  const pageSize = Math.min(500, Math.max(1, parseInt(limit) || 500));
  const offset = (pageNum - 1) * pageSize;

  query += ' ORDER BY class_name, CAST(roll_no AS INTEGER), name';
  if (hasPagination) {
    query += ' LIMIT ? OFFSET ?';
    params.push(pageSize, offset);
  } else {
    query += ' LIMIT 500';
  }

  try {
    let students;
    if (hasPagination) {
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
      const [studentsData, countResult] = await Promise.all([
        querySchool(schoolId, query, params),
        querySchoolOne(schoolId, countQuery, countParams)
      ]);
      students = studentsData.sort(compareStudents);
      res.json({
        data: students,
        pagination: {
          page: pageNum,
          limit: pageSize,
          total: countResult ? countResult.total : students.length,
          pages: Math.ceil((countResult ? countResult.total : 0) / pageSize)
        }
      });
    } else {
      students = await querySchool(schoolId, query, params);
      res.json(students.sort(compareStudents));
    }
  } catch (err) {
    console.error('Fetch students error:', err);
    res.status(500).json({ error: 'Failed to retrieve students: ' + err.message });
  }
});

// GET /students/classes - Get unique active classes (registry + students + sections + class_fees)
router.get('/classes', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  try {
    const merged = await fetchMergedClasses(schoolId);
    res.json(merged.map(c => c.class_name));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /students/classes/detail - Classes with sections detail (for Create Classes manager)
router.get('/classes/detail', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  try {
    const merged = await fetchMergedClasses(schoolId);
    const detailed = await Promise.all(merged.map(async c => {
      const sections = await fetchClassSections(schoolId, c.class_name);
      return {
        class_name: c.class_name,
        has_sections: c.has_sections === 0 ? 0 : (sections.length > 0 ? 1 : (c.has_sections === 1 ? 1 : 0)),
        sections: sections.map(s => s.section_name)
      };
    }));
    res.json(detailed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /students/classes - Create a class (optionally with sections; blank section = no sections)
router.post('/classes', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const className = String(req.body.class_name || '').trim();
  const sections = parseSectionsInput(req.body.sections);

  if (!className) {
    return res.status(400).json({ error: 'Class name is required' });
  }

  try {
    await ensureSchoolClassesTable(schoolId);
    const existing = await querySchoolOne(schoolId, 'SELECT id, has_sections FROM school_classes WHERE class_name = ?', [className]);
    const hasSections = sections.length > 0 ? 1 : 0;

    if (existing) {
      await runSchool(schoolId, 'UPDATE school_classes SET has_sections = ? WHERE id = ?', [hasSections, existing.id]);
    } else {
      await runSchool(schoolId, 'INSERT INTO school_classes (class_name, has_sections, school_id) VALUES (?, ?, ?)',
        [className, hasSections, schoolId]);
    }

    for (const sec of sections) {
      await runSchool(schoolId, 'INSERT OR IGNORE INTO sections (class_name, section_name, school_id) VALUES (?, ?, ?)',
        [className, sec, schoolId]);
    }

    res.status(201).json({
      message: hasSections
        ? `Class "${className}" created with ${sections.length} section(s)`
        : `Class "${className}" created (no sections)`
    });
  } catch (err) {
    console.error('Create class error:', err);
    res.status(500).json({ error: 'Failed to create class: ' + err.message });
  }
});

// POST /students/classes/:className/sections - Add sections to an existing class
router.post('/classes/:className/sections', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const className = req.params.className;
  const sections = parseSectionsInput(req.body.sections);

  if (sections.length === 0) {
    return res.status(400).json({ error: 'At least one section name is required' });
  }

  try {
    await ensureSchoolClassesTable(schoolId);
    const existing = await querySchoolOne(schoolId, 'SELECT id FROM school_classes WHERE class_name = ?', [className]);
    if (existing) {
      await runSchool(schoolId, 'UPDATE school_classes SET has_sections = 1 WHERE id = ?', [existing.id]);
    } else {
      await runSchool(schoolId, 'INSERT INTO school_classes (class_name, has_sections, school_id) VALUES (?, 1, ?)',
        [className, schoolId]);
    }

    for (const sec of sections) {
      await runSchool(schoolId, 'INSERT OR IGNORE INTO sections (class_name, section_name, school_id) VALUES (?, ?, ?)',
        [className, sec, schoolId]);
    }

    res.status(201).json({ message: `Section(s) added to "${className}"` });
  } catch (err) {
    console.error('Add section error:', err);
    res.status(500).json({ error: 'Failed to add section: ' + err.message });
  }
});

// DELETE /students/classes/:className/sections/:sectionName - Remove a section
router.delete('/classes/:className/sections/:sectionName', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { className, sectionName } = req.params;
  try {
    await runSchool(schoolId, 'DELETE FROM sections WHERE class_name = ? AND section_name = ?', [className, sectionName]);
    res.json({ message: `Section "${sectionName}" removed from "${className}"` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /students/classes/:className - Remove a class from the registry (student records untouched)
router.delete('/classes/:className', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const className = req.params.className;
  try {
    await runSchool(schoolId, 'DELETE FROM school_classes WHERE class_name = ?', [className]);
    await runSchool(schoolId, 'DELETE FROM sections WHERE class_name = ?', [className]);
    res.json({ message: `Class "${className}" removed` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /students/all - Get ALL students including Left status (for profile search)
router.get('/all', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { class_name, section_name, search } = req.query;

  let query = 'SELECT id, student_id, admission_no, name, roll_no, class_name, section_name, father_name, phone, status, is_free, discount_amount, discount_percent, family_head_id, photo FROM students WHERE 1=1';
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

  query += ' ORDER BY class_name, CAST(roll_no AS INTEGER), name LIMIT 5000';

  try {
    const students = await querySchool(schoolId, query, params);
    res.json(students.sort(compareStudents));
  } catch (err) {
    console.error('Fetch all students error:', err);
    res.status(500).json({ error: 'Failed to retrieve students: ' + err.message });
  }
});

// GET /students/sections/:className - Get sections for a class (honours the no-sections registry flag)
router.get('/sections/:className', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const className = req.params.className;
  try {
    const rows = await fetchClassSections(schoolId, className);
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

// ---- Uniqueness guards (permanent fix for duplicate student records) ----
// Rules: admission_no -> unique across the whole school,
//        roll_no      -> unique within the same class,
//        student_id   -> never repeated inside a school.
// Comparisons are trimmed + case-insensitive; empty values are ignored so
// students without an admission/roll number are not blocked.
async function findDuplicateStudent(schoolId, { admissionNo, rollNo, className }, excludeId = null) {
  const excl = excludeId ? ' AND id != ?' : '';

  const adm = String(admissionNo || '').trim();
  if (adm) {
    const row = await querySchoolOne(schoolId,
      `SELECT id, name FROM students WHERE LOWER(TRIM(admission_no)) = LOWER(TRIM(?))${excl} LIMIT 1`,
      excludeId ? [adm, excludeId] : [adm]);
    if (row) return { field: 'admission_no', value: adm, row };
  }

  const roll = String(rollNo || '').trim();
  const cls = String(className || '').trim();
  if (roll && cls) {
    const row = await querySchoolOne(schoolId,
      `SELECT id, name FROM students WHERE LOWER(TRIM(roll_no)) = LOWER(TRIM(?)) AND LOWER(TRIM(class_name)) = LOWER(TRIM(?))${excl} LIMIT 1`,
      excludeId ? [roll, cls, excludeId] : [roll, cls]);
    if (row) return { field: 'roll_no', value: roll, className: cls, row };
  }

  return null;
}

// Generate ST-<year>-<n> codes that are guaranteed unused for this school.
// The old COUNT(*)+1 scheme collided after deletes/duplicates; this walks
// upward until an actually-free code is found (timestamp fallback).
async function generateUniqueStudentId(schoolId) {
  const year = new Date().getFullYear();
  const countRow = await querySchoolOne(schoolId, 'SELECT COUNT(*) as count FROM students');
  let n = (countRow && Number(countRow.count) ? Number(countRow.count) : 0) + 1;
  for (let i = 0; i < 100000; i++) {
    const candidate = `ST-${year}-${n}`;
    const clash = await querySchoolOne(schoolId, 'SELECT id FROM students WHERE student_id = ? LIMIT 1', [candidate]);
    if (!clash) return candidate;
    n++;
  }
  return `ST-${year}-${Date.now()}`;
}

async function studentIdConflict(schoolId, studentIdCode, excludeId = null) {
  const row = await querySchoolOne(schoolId, 'SELECT id, name FROM students WHERE student_id = ? LIMIT 1', [studentIdCode]);
  if (!row) return null;
  if (excludeId !== null && String(row.id) === String(excludeId)) return null;
  return row;
}

// Per-school write lock: serializes duplicate-check -> generate-id -> insert so
// two simultaneous saves (double-tap, second device, sync replay) can't both
// pick the same generated student_id or slip a duplicate past the checks.
const studentWriteChains = new Map();
function withStudentWriteLock(schoolId, fn) {
  const key = String(schoolId);
  const prev = studentWriteChains.get(key) || Promise.resolve();
  const run = prev.then(fn);
  studentWriteChains.set(key, run.catch(() => {}));
  return run;
}

// POST /students - Create a student
router.post('/', authenticateToken, upload.single('photo'), async (req, res) => {
  const schoolId = req.user.schoolId;
  const data = req.body;

  const photoDataUri = fileToDataUri(req.file);

  try {
    const outcome = await withStudentWriteLock(schoolId, async () => {
      // Reject duplicates BEFORE inserting: admission no. school-wide, roll no. per class
      const dup = await findDuplicateStudent(schoolId, {
        admissionNo: data.admission_no,
        rollNo: data.roll_no,
        className: data.class_name
      });
      if (dup && dup.field === 'admission_no') {
        return { status: 409, body: {
          error: `Admission No "${dup.value}" is already used by "${dup.row.name}". Admission numbers must be unique across the whole school — please use a different one.`
        } };
      }
      if (dup && dup.field === 'roll_no') {
        return { status: 409, body: {
          error: `Roll No "${dup.value}" already exists in class ${dup.className} ("${dup.row.name}"). Roll numbers must be unique within the same class.`
        } };
      }

      // student_id: use the provided code only if free, otherwise auto-generate a guaranteed-unique one
      let studentIdCode = String(data.student_id || '').trim();
      if (studentIdCode) {
        const clash = await studentIdConflict(schoolId, studentIdCode);
        if (clash) {
          return { status: 409, body: {
            error: `Student ID "${studentIdCode}" is already assigned to "${clash.name}". Please use a different Student ID.`
          } };
        }
      } else {
        studentIdCode = await generateUniqueStudentId(schoolId);
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

      return { status: 201, body: {
        message: 'Student added successfully!',
        id: result.id,
        studentId: studentIdCode
      } };
    });

    res.status(outcome.status).json(outcome.body);
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
    const outcome = await withStudentWriteLock(schoolId, async () => {
      const existing = await querySchoolOne(schoolId, 'SELECT photo FROM students WHERE id = ?', [id]);
      if (!existing) {
        return { status: 404, body: { error: 'Student not found' } };
      }

      // Same uniqueness rules as create (excluding this student itself)
      const dup = await findDuplicateStudent(schoolId, {
        admissionNo: data.admission_no,
        rollNo: data.roll_no,
        className: data.class_name
      }, id);
      if (dup && dup.field === 'admission_no') {
        return { status: 409, body: {
          error: `Admission No "${dup.value}" is already used by "${dup.row.name}". Admission numbers must be unique across the whole school — please use a different one.`
        } };
      }
      if (dup && dup.field === 'roll_no') {
        return { status: 409, body: {
          error: `Roll No "${dup.value}" already exists in class ${dup.className} ("${dup.row.name}"). Roll numbers must be unique within the same class.`
        } };
      }

      let studentIdCode = String(data.student_id || '').trim();
      if (!studentIdCode) {
        studentIdCode = await generateUniqueStudentId(schoolId);
      } else {
        const clash = await studentIdConflict(schoolId, studentIdCode, id);
        if (clash) {
          return { status: 409, body: {
            error: `Student ID "${studentIdCode}" is already assigned to "${clash.name}". Please use a different Student ID.`
          } };
        }
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

      return { status: 200, body: { message: 'Student details updated successfully!' } };
    });

    res.status(outcome.status).json(outcome.body);
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

// Vercel serverless filesystem is read-only except /tmp — store generated
// PDFs in a writable temp dir so "Save as PDF" works both locally and online.
function pdfStorageDir(sub) {
  const dir = path.join(os.tmpdir(), 'skyhonix-pdfs', sub);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* dir exists */ }
  return dir;
}

// Download auth: Capacitor WebView / external browser cannot send the
// Authorization header, so download links may carry ?token=<jwt> instead.
function pdfDownloadAuth(req, res, next) {
  if (!req.headers['authorization'] && req.query && typeof req.query.token === 'string' && req.query.token) {
    req.headers['authorization'] = 'Bearer ' + req.query.token;
  }
  return authenticateToken(req, res, next);
}

// POST /students/:id/card-pdf - Generate the QR attendance card as a PDF
router.post('/:id/card-pdf', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const studentId = req.params.id;

  try {
    const student = await querySchoolOne(schoolId, 'SELECT * FROM students WHERE id = ?', [studentId]);
    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }

    let feeSettings = null;
    try {
      feeSettings = await querySchoolOne(schoolId, 'SELECT school_name FROM fee_settings LIMIT 1');
    } catch (e) { feeSettings = null; }
    const schoolName = (feeSettings && feeSettings.school_name) || req.user.schoolName || 'Student Attendance Card';

    const PDFDocument = require('pdfkit');

    // QR image from the same public API the frontend uses; fall back to plain
    // text in the QR box if the fetch fails (offline / timeout).
    let qrBuffer = null;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const qrResp = await fetch(
        'https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=' + encodeURIComponent(student.student_id || ''),
        { signal: ctrl.signal }
      );
      clearTimeout(timer);
      if (qrResp.ok) qrBuffer = Buffer.from(await qrResp.arrayBuffer());
    } catch (e) { qrBuffer = null; }

    const safeCode = String(student.student_id || student.id || 'card')
      .replace(/[^A-Za-z0-9_-]/g, '') || 'card';
    const fileName = `StudentCard_${safeCode}_${Date.now()}.pdf`;
    const filePath = path.join(pdfStorageDir('cards'), fileName);

    const W = 300, H = 460;
    const doc = new PDFDocument({ size: [W, H], margin: 0 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    // Outer + inner gold borders
    doc.rect(8, 8, W - 16, H - 16).lineWidth(3).stroke('#D4A017');
    doc.rect(14, 14, W - 28, H - 28).lineWidth(1).stroke('#E5C76B');

    doc.font('Helvetica-Bold').fontSize(16).fillColor('#1E293B')
      .text(schoolName, 20, 32, { width: W - 40, align: 'center' });
    doc.font('Helvetica').fontSize(9).fillColor('#64748B')
      .text('Student QR Attendance Card', 20, 56, { width: W - 40, align: 'center' });
    doc.moveTo(30, 76).lineTo(W - 30, 76).lineWidth(1).stroke('#D4A017');

    const qrSize = 150;
    const qrX = (W - qrSize) / 2;
    const qrY = 96;
    doc.rect(qrX - 6, qrY - 6, qrSize + 12, qrSize + 12).lineWidth(1).stroke('#CBD5E1');
    if (qrBuffer) {
      doc.image(qrBuffer, qrX, qrY, { width: qrSize, height: qrSize });
    } else {
      doc.font('Courier-Bold').fontSize(10).fillColor('#0F172A')
        .text(student.student_id || '', qrX, qrY + qrSize / 2 - 6, { width: qrSize, align: 'center' });
    }

    doc.font('Helvetica-Bold').fontSize(15).fillColor('#1E293B')
      .text(student.name || '', 20, qrY + qrSize + 24, { width: W - 40, align: 'center' });
    doc.font('Helvetica').fontSize(10).fillColor('#475569')
      .text(`Roll No: ${student.roll_no || 'N/A'} | Class: ${student.class_name || ''}${student.section_name ? ' - ' + student.section_name : ''}`,
        20, qrY + qrSize + 46, { width: W - 40, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#B8860B')
      .text(`Student ID: ${student.student_id || ''}`, 20, qrY + qrSize + 66, { width: W - 40, align: 'center' });
    doc.font('Helvetica').fontSize(8).fillColor('#94A3B8')
      .text('Scan this code for attendance', 20, H - 44, { width: W - 40, align: 'center' });

    doc.end();

    stream.on('finish', () => {
      res.json({
        message: 'Card PDF generated successfully',
        file_name: fileName,
        file_path: `/api/students/card-pdf/download/${fileName}`
      });
    });

    stream.on('error', (err) => {
      res.status(500).json({ error: 'Failed to generate PDF: ' + err.message });
    });

  } catch (err) {
    console.error('Card PDF generation error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /students/card-pdf/download/:filename - Download generated card PDF
router.get('/card-pdf/download/:filename', pdfDownloadAuth, async (req, res) => {
  const { filename } = req.params;
  if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  const filePath = path.join(pdfStorageDir('cards'), filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  res.download(filePath, filename);
});

module.exports = router;
