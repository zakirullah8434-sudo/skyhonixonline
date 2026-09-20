const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const config = require('../config');
const { querySchool, querySchoolOne, runSchool, queryMainOne } = require('../database_manager');
const syncManager = require('../sync_manager');

// Middleware to verify teacher JWT token
function authenticateTeacherToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required. Please log in.' });
  }

  jwt.verify(token, config.JWT_SECRET, async (err, decoded) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired session. Please log in again.' });
    }

    if (decoded.role !== 'teacher') {
      return res.status(403).json({ error: 'Access denied. Teacher login required.' });
    }

    req.teacher = decoded;

    // Check school subscription
    try {
      const school = await queryMainOne(
        'SELECT subscription_status FROM schools WHERE id = ?',
        [req.teacher.schoolId]
      );

      if (!school) {
        return res.status(404).json({ error: 'School not found' });
      }

      req.teacher.subscriptionStatus = school.subscription_status;

      if (school.subscription_status === 'pending') {
        return res.status(403).json({ error: 'School registration is pending admin approval.' });
      }
      if (school.subscription_status === 'suspended') {
        return res.status(403).json({ error: 'School access is suspended.' });
      }

      next();
    } catch (dbErr) {
      console.error('Teacher auth middleware DB error:', dbErr);
      res.status(500).json({ error: 'Internal server authorization error' });
    }
  });
}

// GET /api/teachers/settings - Get school settings (logo, name)
router.get('/settings', authenticateTeacherToken, async (req, res) => {
  const schoolId = req.teacher.schoolId;
  try {
    const settings = await querySchoolOne(schoolId, 'SELECT school_name, logo_path, phone, registration_number FROM fee_settings LIMIT 1');
    res.json({
      school_name: settings ? settings.school_name : '',
      logo_path: settings ? settings.logo_path : '',
      phone: settings ? settings.phone : '',
      registration_number: settings ? settings.registration_number : ''
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/teachers/my-subjects - Fetch teacher's assigned timetable
router.get('/my-subjects', authenticateTeacherToken, async (req, res) => {
  const schoolId = req.teacher.schoolId;
  const teacherId = req.teacher.teacherId;

  try {
    const entries = await querySchool(
      schoolId,
      `SELECT t.id, t.class_name, t.section_name, t.day, t.period, t.start_time, t.end_time, t.subject, t.room
       FROM timetable t
       WHERE t.teacher_id = ?
       ORDER BY
         CASE t.day
           WHEN 'Monday' THEN 1 WHEN 'Tuesday' THEN 2 WHEN 'Wednesday' THEN 3
           WHEN 'Thursday' THEN 4 WHEN 'Friday' THEN 5 WHEN 'Saturday' THEN 6 WHEN 'Sunday' THEN 7
         END,
         t.period ASC`,
      [teacherId]
    );

    // Group by subject for cleaner display
    const subjects = {};
    entries.forEach(e => {
      if (!subjects[e.subject]) {
        subjects[e.subject] = { subject: e.subject, entries: [] };
      }
      subjects[e.subject].entries.push(e);
    });

    res.json({ subjects: Object.values(subjects), allEntries: entries });
  } catch (err) {
    console.error('Error fetching teacher subjects:', err);
    res.status(500).json({ error: 'Failed to load subjects' });
  }
});

// GET /api/teachers/my-classes - Fetch unique classes assigned to this teacher
router.get('/my-classes', authenticateTeacherToken, async (req, res) => {
  const schoolId = req.teacher.schoolId;
  const teacherId = req.teacher.teacherId;

  try {
    const classes = await querySchool(
      schoolId,
      `SELECT DISTINCT t.class_name, t.section_name, t.subject
       FROM timetable t
       WHERE t.teacher_id = ?
       ORDER BY t.class_name, t.section_name`,
      [teacherId]
    );

    res.json(classes);
  } catch (err) {
    console.error('Error fetching teacher classes:', err);
    res.status(500).json({ error: 'Failed to load classes' });
  }
});

// GET /api/teachers/my-marks - Fetch marks grid for teacher's assigned subject
router.get('/my-marks', authenticateTeacherToken, async (req, res) => {
  const schoolId = req.teacher.schoolId;
  const teacherId = req.teacher.teacherId;
  const { exam_id, class_name, section_name, subject, term } = req.query;

  if (!exam_id || !class_name || !subject || !term) {
    return res.status(400).json({ error: 'exam_id, class_name, subject, and term are required' });
  }

  try {
    // Verify this teacher is assigned to this subject/class
    const assignment = await querySchoolOne(
      schoolId,
      `SELECT id FROM timetable WHERE teacher_id = ? AND class_name = ? AND subject = ?`,
      [teacherId, class_name, subject]
    );

    if (!assignment) {
      return res.status(403).json({ error: 'You are not assigned to teach this subject in this class' });
    }

    // Get max_marks from exam_subjects if configured
    let maxMarks = 100;
    const examSubject = await querySchoolOne(
      schoolId,
      'SELECT max_marks FROM exam_subjects WHERE exam_id = ? AND class = ? AND subject = ? AND term = ?',
      [parseInt(exam_id), class_name, subject, term]
    );
    if (examSubject && examSubject.max_marks) {
      maxMarks = examSubject.max_marks;
    }

    // Get students
    let studentsQuery = "SELECT id, name, roll_no, class_name, section_name FROM students WHERE class_name = ? AND (status IS NULL OR status != 'Left')";
    const params = [class_name];

    if (section_name) {
      studentsQuery += " AND section_name = ?";
      params.push(section_name);
    }
    studentsQuery += " ORDER BY roll_no ASC";

    const students = await querySchool(schoolId, studentsQuery, params);

    // Get existing marks
    const marks = await querySchool(
      schoolId,
      'SELECT student_id, marks FROM marks WHERE exam_id = ? AND subject = ? AND term = ?',
      [parseInt(exam_id), subject, term]
    );

    const marksMap = {};
    marks.forEach(m => { marksMap[m.student_id] = m.marks; });

    const grid = students.map(student => ({
      id: student.id,
      name: student.name,
      roll_no: student.roll_no,
      class_name: student.class_name,
      section_name: student.section_name,
      marks: marksMap[student.id] !== undefined ? marksMap[student.id] : '',
      max_marks: maxMarks
    }));

    res.json(grid);
  } catch (err) {
    console.error('Error fetching teacher marks:', err);
    res.status(500).json({ error: 'Failed to load marks' });
  }
});

// POST /api/teachers/my-marks - Save marks for teacher's assigned subject
router.post('/my-marks', authenticateTeacherToken, async (req, res) => {
  const schoolId = req.teacher.schoolId;
  const teacherId = req.teacher.teacherId;
  const { exam_id, subject, term, class_name, section_name, max_marks, marksList } = req.body;

  if (!exam_id || !subject || !term || !class_name || !marksList) {
    return res.status(400).json({ error: 'exam_id, subject, term, class_name, and marksList are required' });
  }

  try {
    // Verify this teacher is assigned to this subject/class
    const assignment = await querySchoolOne(
      schoolId,
      `SELECT id FROM timetable WHERE teacher_id = ? AND class_name = ? AND subject = ?`,
      [teacherId, class_name, subject]
    );

    if (!assignment) {
      return res.status(403).json({ error: 'You are not assigned to teach this subject in this class' });
    }

    // Save max_marks to exam_subjects (upsert)
    const maxMarksVal = parseInt(max_marks) || 100;
    const existing = await querySchoolOne(
      schoolId,
      'SELECT id FROM exam_subjects WHERE exam_id = ? AND class = ? AND subject = ? AND term = ?',
      [parseInt(exam_id), class_name, subject, term]
    );
    if (existing) {
      await runSchool(schoolId,
        'UPDATE exam_subjects SET max_marks = ? WHERE id = ?',
        [maxMarksVal, existing.id]
      );
    } else {
      await runSchool(schoolId,
        'INSERT INTO exam_subjects (exam_id, class, subject, max_marks, term) VALUES (?, ?, ?, ?, ?)',
        [parseInt(exam_id), class_name, subject, maxMarksVal, term]
      );
    }

    const affectedStudents = [];
    for (const entry of marksList) {
      const marksVal = entry.marks === '' || entry.marks === null || entry.marks === undefined
        ? null
        : parseInt(entry.marks);

      if (marksVal === null) {
        await runSchool(schoolId,
          'DELETE FROM marks WHERE student_id = ? AND exam_id = ? AND subject = ? AND term = ?',
          [entry.student_id, parseInt(exam_id), subject, term]
        );
      } else {
        await runSchool(schoolId,
          'DELETE FROM marks WHERE student_id = ? AND exam_id = ? AND subject = ? AND term = ?',
          [entry.student_id, parseInt(exam_id), subject, term]
        );
        await runSchool(schoolId,
          'INSERT INTO marks (student_id, exam_id, subject, marks, term, teacher_id) VALUES (?, ?, ?, ?, ?, ?)',
          [entry.student_id, parseInt(exam_id), subject, marksVal, term, teacherId]
        );
      }
      affectedStudents.push(entry.student_id);

      // Sync: trigger cascade for results invalidation
      await syncManager.onMarksUpdated(
        schoolId,
        entry.student_id,
        parseInt(exam_id),
        subject,
        null,
        marksVal
      );
    }

    res.json({
      message: 'Marks saved successfully!',
      syncEvent: 'results.marks.updated',
      affectedStudents,
      needsRecalculation: true
    });
  } catch (err) {
    console.error('Error saving teacher marks:', err);
    res.status(500).json({ error: 'Failed to save marks. ' + err.message });
  }
});

// GET /api/teachers/announcements - Fetch school announcements
router.get('/announcements', authenticateTeacherToken, async (req, res) => {
  const schoolId = req.teacher.schoolId;

  try {
    const announcements = await querySchool(
      schoolId,
      `SELECT id, title, message, target_role, created_by, created_at
       FROM announcements
       WHERE target_role = 'all' OR target_role = 'teachers'
       ORDER BY created_at DESC
       LIMIT 50`
    );

    res.json(announcements);
  } catch (err) {
    console.error('Error fetching announcements:', err);
    res.status(500).json({ error: 'Failed to load announcements' });
  }
});

// GET /api/teachers/exams - Fetch active exams for teacher's assigned classes
router.get('/exams', authenticateTeacherToken, async (req, res) => {
  const schoolId = req.teacher.schoolId;
  const teacherId = req.teacher.teacherId;

  try {
    // Get classes this teacher is assigned to
    const classes = await querySchool(
      schoolId,
      `SELECT DISTINCT class_name FROM timetable WHERE teacher_id = ?`,
      [teacherId]
    );

    const classNames = classes.map(c => c.class_name);
    if (classNames.length === 0) {
      return res.json([]);
    }

    // Get exams that include these classes
    const exams = await querySchool(
      schoolId,
      'SELECT id, exam_name, year, classes FROM exams ORDER BY year DESC, exam_name ASC'
    );

    // Filter exams that have at least one of the teacher's classes
    const filtered = exams.filter(ex => {
      try {
        const exClasses = JSON.parse(ex.classes);
        // If exam has 'All Classes', it matches every teacher
        if (exClasses.includes('All Classes')) return true;
        return classNames.some(cn => exClasses.includes(cn));
      } catch { return false; }
    });

    res.json(filtered);
  } catch (err) {
    console.error('Error fetching teacher exams:', err);
    res.status(500).json({ error: 'Failed to load exams' });
  }
});

// GET /api/teachers/exam-subjects - Fetch subjects for an exam that the teacher is assigned to
router.get('/exam-subjects', authenticateTeacherToken, async (req, res) => {
  const schoolId = req.teacher.schoolId;
  const teacherId = req.teacher.teacherId;
  const { exam_id, class_name, term } = req.query;

  if (!exam_id || !class_name || !term) {
    return res.status(400).json({ error: 'exam_id, class_name, and term are required' });
  }

  try {
    // Get subjects this teacher teaches in this class
    const teacherSubjects = await querySchool(
      schoolId,
      `SELECT DISTINCT subject FROM timetable WHERE teacher_id = ? AND class_name = ?`,
      [teacherId, class_name]
    );

    const teacherSubjectNames = teacherSubjects.map(s => s.subject);

    // Get all exam subjects for this class/term
    const allSubjects = await querySchool(
      schoolId,
      'SELECT id, subject, max_marks FROM exam_subjects WHERE exam_id = ? AND class = ? AND term = ?',
      [parseInt(exam_id), class_name, term]
    );

    // Filter to only teacher's assigned subjects
    const filtered = allSubjects.filter(s => teacherSubjectNames.includes(s.subject));

    res.json(filtered);
  } catch (err) {
    console.error('Error fetching exam subjects:', err);
    res.status(500).json({ error: 'Failed to load exam subjects' });
  }
});

// ============ ASSIGNMENTS (Homework, Tests, Projects) ============

// GET /api/teachers/assignments - Get all assignments created by this teacher (with optional date filtering)
router.get('/assignments', authenticateTeacherToken, async (req, res) => {
  const schoolId = req.teacher.schoolId;
  const teacherId = req.teacher.teacherId;
  const { from_date, to_date, status } = req.query;

  async function ensureAssignmentsTable() {
    await runSchool(schoolId, `CREATE TABLE IF NOT EXISTS assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, teacher_id INTEGER, teacher_name TEXT, subject TEXT, class_name TEXT, section_name TEXT, title TEXT NOT NULL, description TEXT, type TEXT DEFAULT 'homework', due_date TEXT, priority TEXT DEFAULT 'medium', status TEXT DEFAULT 'active', total_marks INTEGER DEFAULT 0, marks_info TEXT DEFAULT '', school_id INTEGER, created_at TEXT)`).catch(() => {});
    await runSchool(schoolId, `ALTER TABLE assignments ADD COLUMN status TEXT DEFAULT 'active'`).catch(() => {});
    await runSchool(schoolId, `ALTER TABLE assignments ADD COLUMN total_marks INTEGER DEFAULT 0`).catch(() => {});
    await runSchool(schoolId, `ALTER TABLE assignments ADD COLUMN marks_info TEXT DEFAULT ''`).catch(() => {});
  }

  async function fetchAssignments() {
    let sql = `SELECT * FROM assignments WHERE teacher_id = ?`;
    const params = [teacherId];
    if (from_date) { sql += ` AND created_at >= ?`; params.push(from_date); }
    if (to_date) { sql += ` AND created_at <= ?`; params.push(to_date + 'T23:59:59.999Z'); }
    if (status) { sql += ` AND status = ?`; params.push(status); }
    sql += ` ORDER BY created_at DESC LIMIT 200`;
    return await querySchool(schoolId, sql, params);
  }

  try {
    let rows;
    try {
      rows = await fetchAssignments();
    } catch (firstErr) {
      console.warn('[ASSIGNMENTS] List query failed, ensuring table and retrying:', firstErr.message);
      await ensureAssignmentsTable();
      rows = await fetchAssignments();
    }
    res.json(rows);
  } catch (err) {
    console.error('Error fetching assignments:', err);
    res.status(500).json({ error: 'Failed to load assignments' });
  }
});

// POST /api/teachers/assignments - Create a new assignment
router.post('/assignments', authenticateTeacherToken, async (req, res) => {
  const schoolId = req.teacher.schoolId;
  const teacherId = req.teacher.teacherId;
  const { subject, class_name, section_name, title, description, type, due_date, priority, total_marks } = req.body;

  if (!title || !subject || !class_name) {
    return res.status(400).json({ error: 'Title, subject, and class are required' });
  }

  async function ensureAssignmentsTable() {
    await runSchool(schoolId, `CREATE TABLE IF NOT EXISTS assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, teacher_id INTEGER, teacher_name TEXT, subject TEXT, class_name TEXT, section_name TEXT, title TEXT NOT NULL, description TEXT, type TEXT DEFAULT 'homework', due_date TEXT, priority TEXT DEFAULT 'medium', status TEXT DEFAULT 'active', total_marks INTEGER DEFAULT 0, marks_info TEXT DEFAULT '', school_id INTEGER, created_at TEXT)`).catch(() => {});
    await runSchool(schoolId, `ALTER TABLE assignments ADD COLUMN total_marks INTEGER DEFAULT 0`).catch(() => {});
    await runSchool(schoolId, `ALTER TABLE assignments ADD COLUMN marks_info TEXT DEFAULT ''`).catch(() => {});
  }

  try {
    const teacherInfo = await querySchoolOne(schoolId, 'SELECT name FROM teachers WHERE id = ?', [teacherId]);
    const teacherName = teacherInfo ? teacherInfo.name : 'Teacher';
    const now = new Date().toISOString();

    let result;
    try {
      result = await runSchool(
        schoolId,
        `INSERT INTO assignments (teacher_id, teacher_name, subject, class_name, section_name, title, description, type, due_date, priority, status, total_marks, marks_info, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, '', ?)`,
        [teacherId, teacherName, subject, class_name, section_name || '', title, description || '', type || 'homework', due_date || '', priority || 'medium', total_marks || 0, now]
      );
    } catch (firstErr) {
      console.warn('[ASSIGNMENTS] POST failed, ensuring table and retrying:', firstErr.message);
      await ensureAssignmentsTable();
      result = await runSchool(
        schoolId,
        `INSERT INTO assignments (teacher_id, teacher_name, subject, class_name, section_name, title, description, type, due_date, priority, status, total_marks, marks_info, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, '', ?)`,
        [teacherId, teacherName, subject, class_name, section_name || '', title, description || '', type || 'homework', due_date || '', priority || 'medium', total_marks || 0, now]
      );
    }
    res.json({ success: true, id: result.lastID });
  } catch (err) {
    console.error('Error creating assignment:', err);
    res.status(500).json({ error: 'Failed to create assignment' });
  }
});

// PUT /api/teachers/assignments/:id - Update an assignment
router.put('/assignments/:id', authenticateTeacherToken, async (req, res) => {
  const schoolId = req.teacher.schoolId;
  const teacherId = req.teacher.teacherId;
  const assignmentId = req.params.id;
  const { subject, class_name, section_name, title, description, type, due_date, priority, total_marks } = req.body;

  async function ensureAssignmentsTable() {
    await runSchool(schoolId, `CREATE TABLE IF NOT EXISTS assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, teacher_id INTEGER, teacher_name TEXT, subject TEXT, class_name TEXT, section_name TEXT, title TEXT NOT NULL, description TEXT, type TEXT DEFAULT 'homework', due_date TEXT, priority TEXT DEFAULT 'medium', status TEXT DEFAULT 'active', total_marks INTEGER DEFAULT 0, marks_info TEXT DEFAULT '', school_id INTEGER, created_at TEXT)`).catch(() => {});
    await runSchool(schoolId, `ALTER TABLE assignments ADD COLUMN total_marks INTEGER DEFAULT 0`).catch(() => {});
    await runSchool(schoolId, `ALTER TABLE assignments ADD COLUMN marks_info TEXT DEFAULT ''`).catch(() => {});
  }

  try {
    try {
      await runSchool(
        schoolId,
        `UPDATE assignments SET subject=?, class_name=?, section_name=?, title=?, description=?, type=?, due_date=?, priority=?, total_marks=?
         WHERE id=? AND teacher_id=?`,
        [subject, class_name, section_name || '', title, description || '', type || 'homework', due_date || '', priority || 'medium', total_marks || 0, assignmentId, teacherId]
      );
    } catch (firstErr) {
      console.warn('[ASSIGNMENTS] PUT failed, ensuring table and retrying:', firstErr.message);
      await ensureAssignmentsTable();
      await runSchool(
        schoolId,
        `UPDATE assignments SET subject=?, class_name=?, section_name=?, title=?, description=?, type=?, due_date=?, priority=?, total_marks=?
         WHERE id=? AND teacher_id=?`,
        [subject, class_name, section_name || '', title, description || '', type || 'homework', due_date || '', priority || 'medium', total_marks || 0, assignmentId, teacherId]
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Error updating assignment:', err);
    res.status(500).json({ error: 'Failed to update assignment' });
  }
});

// PUT /api/teachers/assignments/:id/status - Toggle assignment completion status
router.put('/assignments/:id/status', authenticateTeacherToken, async (req, res) => {
  const schoolId = req.teacher.schoolId;
  const teacherId = req.teacher.teacherId;
  const assignmentId = req.params.id;
  const { status } = req.body;

  if (!status || !['active', 'completed'].includes(status)) {
    return res.status(400).json({ error: 'Status must be either active or completed' });
  }

  async function ensureStatusColumn() {
    await runSchool(schoolId, `CREATE TABLE IF NOT EXISTS assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, teacher_id INTEGER, teacher_name TEXT, subject TEXT, class_name TEXT, section_name TEXT, title TEXT NOT NULL, description TEXT, type TEXT DEFAULT 'homework', due_date TEXT, priority TEXT DEFAULT 'medium', status TEXT DEFAULT 'active', total_marks INTEGER DEFAULT 0, marks_info TEXT DEFAULT '', school_id INTEGER, created_at TEXT)`).catch(() => {});
    await runSchool(schoolId, `ALTER TABLE assignments ADD COLUMN status TEXT DEFAULT 'active'`).catch(() => {});
  }

  try {
    try {
      await runSchool(schoolId, `UPDATE assignments SET status=? WHERE id=? AND teacher_id=?`, [status, assignmentId, teacherId]);
    } catch (firstErr) {
      await ensureStatusColumn();
      await runSchool(schoolId, `UPDATE assignments SET status=? WHERE id=? AND teacher_id=?`, [status, assignmentId, teacherId]);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Error updating assignment status:', err);
    res.status(500).json({ error: 'Failed to update assignment status' });
  }
});

// PUT /api/teachers/assignments/:id/marks - Update marks info for an assignment (for tests)
router.put('/assignments/:id/marks', authenticateTeacherToken, async (req, res) => {
  const schoolId = req.teacher.schoolId;
  const teacherId = req.teacher.teacherId;
  const assignmentId = req.params.id;
  const { marks_info } = req.body;

  async function ensureMarksColumn() {
    await runSchool(schoolId, `CREATE TABLE IF NOT EXISTS assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, teacher_id INTEGER, teacher_name TEXT, subject TEXT, class_name TEXT, section_name TEXT, title TEXT NOT NULL, description TEXT, type TEXT DEFAULT 'homework', due_date TEXT, priority TEXT DEFAULT 'medium', status TEXT DEFAULT 'active', total_marks INTEGER DEFAULT 0, marks_info TEXT DEFAULT '', school_id INTEGER, created_at TEXT)`).catch(() => {});
    await runSchool(schoolId, `ALTER TABLE assignments ADD COLUMN marks_info TEXT DEFAULT ''`).catch(() => {});
  }

  try {
    try {
      await runSchool(schoolId, `UPDATE assignments SET marks_info=? WHERE id=? AND teacher_id=?`, [marks_info || '', assignmentId, teacherId]);
    } catch (firstErr) {
      await ensureMarksColumn();
      await runSchool(schoolId, `UPDATE assignments SET marks_info=? WHERE id=? AND teacher_id=?`, [marks_info || '', assignmentId, teacherId]);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Error updating assignment marks:', err);
    res.status(500).json({ error: 'Failed to update assignment marks' });
  }
});

// GET /api/teachers/assignments/:id/students - Get students for an assignment with their status/marks
router.get('/assignments/:id/students', authenticateTeacherToken, async (req, res) => {
  const schoolId = req.teacher.schoolId;
  const teacherId = req.teacher.teacherId;
  const assignmentId = parseInt(req.params.id, 10);
  if (!assignmentId) return res.status(400).json({ error: 'Invalid assignment ID' });

  async function ensureAssignmentTables() {
    await runSchool(schoolId, `CREATE TABLE IF NOT EXISTS assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, teacher_id INTEGER, teacher_name TEXT, subject TEXT, class_name TEXT, section_name TEXT, title TEXT NOT NULL, description TEXT, type TEXT DEFAULT 'homework', due_date TEXT, priority TEXT DEFAULT 'medium', status TEXT DEFAULT 'active', total_marks INTEGER DEFAULT 0, marks_info TEXT DEFAULT '', school_id INTEGER, created_at TEXT)`).catch(() => {});
    await runSchool(schoolId, `ALTER TABLE assignments ADD COLUMN status TEXT DEFAULT 'active'`).catch(() => {});
    await runSchool(schoolId, `ALTER TABLE assignments ADD COLUMN total_marks INTEGER DEFAULT 0`).catch(() => {});
    await runSchool(schoolId, `ALTER TABLE assignments ADD COLUMN marks_info TEXT DEFAULT ''`).catch(() => {});
    await runSchool(schoolId, `CREATE TABLE IF NOT EXISTS assignment_students (id INTEGER PRIMARY KEY AUTOINCREMENT, assignment_id INTEGER NOT NULL, student_id INTEGER NOT NULL, status TEXT DEFAULT 'pending', marks INTEGER DEFAULT 0, feedback TEXT DEFAULT '', completed_at TEXT, school_id INTEGER, created_at TEXT)`).catch(() => {});
    await runSchool(schoolId, `ALTER TABLE assignment_students ADD COLUMN school_id INTEGER`).catch(() => {});
  }

  async function loadStudents() {
    const assignment = await querySchoolOne(schoolId,
      'SELECT id, teacher_id, class_name, section_name, title, subject, status, total_marks, type, due_date FROM assignments WHERE id=? AND teacher_id=?',
      [assignmentId, teacherId]
    );
    if (!assignment) return null;

    let students = [];
    if (assignment.class_name) {
      if (assignment.section_name) {
        students = await querySchool(schoolId,
          'SELECT s.id, s.name, s.roll_no, s.class_name, s.section_name FROM students s WHERE s.class_name = ? AND s.section_name = ? AND (s.status IS NULL OR s.status != ?) ORDER BY CAST(s.roll_no AS INTEGER), s.name',
          [assignment.class_name, assignment.section_name, 'Left']
        );
      } else {
        students = await querySchool(schoolId,
          'SELECT s.id, s.name, s.roll_no, s.class_name, s.section_name FROM students s WHERE s.class_name = ? AND (s.status IS NULL OR s.status != ?) ORDER BY CAST(s.roll_no AS INTEGER), s.name',
          [assignment.class_name, 'Left']
        );
      }
    }

    let tracked = [];
    try {
      tracked = await querySchool(schoolId,
        'SELECT student_id, status, marks, feedback FROM assignment_students WHERE assignment_id=?',
        [assignmentId]
      );
    } catch (e) {
      await ensureAssignmentTables();
      tracked = await querySchool(schoolId,
        'SELECT student_id, status, marks, feedback FROM assignment_students WHERE assignment_id=?',
        [assignmentId]
      ).catch(() => []);
    }
    const trackedMap = {};
    tracked.forEach(function(t) { trackedMap[t.student_id] = t; });

    const result = students.map(function(s) {
      return {
        id: s.id, name: s.name, roll_no: s.roll_no, class_name: s.class_name, section_name: s.section_name,
        status: trackedMap[s.id] ? trackedMap[s.id].status : 'pending',
        marks: trackedMap[s.id] ? trackedMap[s.id].marks : 0,
        feedback: trackedMap[s.id] ? trackedMap[s.id].feedback : ''
      };
    });

    return { assignment: assignment, students: result };
  }

  try {
    let result;
    try {
      result = await loadStudents();
    } catch (firstErr) {
      console.warn('[ASSIGNMENTS] First attempt failed, ensuring tables and retrying:', firstErr.message);
      await ensureAssignmentTables();
      result = await loadStudents();
    }
    if (!result) return res.status(404).json({ error: 'Assignment not found' });
    res.json(result);
  } catch (err) {
    console.error('Error fetching assignment students:', err.message || err);
    res.status(500).json({ error: 'Failed to load students: ' + (err.message || 'unknown') });
  }
});

// PUT /api/teachers/assignments/:id/students - Bulk update student status/marks for an assignment
router.put('/assignments/:id/students', authenticateTeacherToken, async (req, res) => {
  const schoolId = req.teacher.schoolId;
  const teacherId = req.teacher.teacherId;
  const assignmentId = req.params.id;
  const { students } = req.body; // Array of { student_id, status, marks, feedback }

  try {
    const assignment = await querySchoolOne(schoolId,
      `SELECT id FROM assignments WHERE id=? AND teacher_id=?`,
      [assignmentId, teacherId]
    );
    if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

    const now = new Date().toISOString();
    for (const s of (students || [])) {
      if (!s.student_id) continue;
      const existing = await querySchoolOne(schoolId,
        `SELECT id FROM assignment_students WHERE assignment_id=? AND student_id=?`,
        [assignmentId, s.student_id]
      );
      if (existing) {
        await runSchool(schoolId,
          `UPDATE assignment_students SET status=?, marks=?, feedback=?, completed_at=? WHERE assignment_id=? AND student_id=?`,
          [s.status || 'pending', s.marks || 0, s.feedback || '', s.status === 'completed' ? now : null, assignmentId, s.student_id]
        );
      } else {
        await runSchool(schoolId,
          `INSERT INTO assignment_students (assignment_id, student_id, status, marks, feedback, completed_at, school_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [assignmentId, s.student_id, s.status || 'pending', s.marks || 0, s.feedback || '', s.status === 'completed' ? now : null, schoolId, now]
        );
      }
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Error updating assignment students:', err);
    res.status(500).json({ error: 'Failed to update students' });
  }
});

// DELETE /api/teachers/assignments/:id - Delete an assignment
router.delete('/assignments/:id', authenticateTeacherToken, async (req, res) => {
  const schoolId = req.teacher.schoolId;
  const teacherId = req.teacher.teacherId;
  const assignmentId = req.params.id;

  try {
    await runSchool(
      schoolId,
      `DELETE FROM assignment_students WHERE assignment_id=? AND school_id IN (SELECT school_id FROM assignments WHERE id=? AND teacher_id=?)`,
      [assignmentId, assignmentId, teacherId]
    );
    await runSchool(
      schoolId,
      `DELETE FROM assignments WHERE id=? AND teacher_id=?`,
      [assignmentId, teacherId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting assignment:', err);
    res.status(500).json({ error: 'Failed to delete assignment' });
  }
});

// GET /api/teachers/fee-students - Get students for fee collection (only assigned class)
router.get('/fee-students', authenticateTeacherToken, async (req, res) => {
  const schoolId = req.teacher.schoolId;
  const teacherId = req.teacher.teacherId;

  try {
    const teacher = await querySchoolOne(schoolId, 'SELECT assigned_class, can_collect_fees FROM teachers WHERE id = ?', [teacherId]);
    if (!teacher || !teacher.can_collect_fees) {
      return res.status(403).json({ error: 'You do not have permission to collect fees.' });
    }
    if (!teacher.assigned_class) {
      return res.status(400).json({ error: 'No class assigned to you. Please contact admin.' });
    }

    const students = await querySchool(schoolId,
      `SELECT s.id, s.name, s.roll_no, s.class_name, s.section_name, s.father_name, s.photo
       FROM students s
       WHERE s.class_name = ? AND (s.status IS NULL OR s.status != 'Left')
       ORDER BY CAST(s.roll_no AS INTEGER), s.name`,
      [teacher.assigned_class]
    );
    res.json(students);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/teachers/fee-ledger/:studentId - Get fee ledger for a student
router.get('/fee-ledger/:studentId', authenticateTeacherToken, async (req, res) => {
  const schoolId = req.teacher.schoolId;
  const teacherId = req.teacher.teacherId;
  const studentId = req.params.studentId;

  try {
    const teacher = await querySchoolOne(schoolId, 'SELECT assigned_class, can_collect_fees FROM teachers WHERE id = ?', [teacherId]);
    if (!teacher || !teacher.can_collect_fees) {
      return res.status(403).json({ error: 'You do not have permission to collect fees.' });
    }

    const ledger = await querySchool(schoolId,
      `SELECT fl.*, s.name as student_name, s.roll_no, s.father_name
       FROM fee_ledger fl
       JOIN students s ON s.id = fl.student_id
       WHERE fl.student_id = ? ORDER BY fl.year DESC, fl.month DESC`,
      [studentId]
    );

    const payments = await querySchool(schoolId,
      `SELECT * FROM fee_payments WHERE student_id = ? ORDER BY payment_date DESC`,
      [studentId]
    );

    const dues = await querySchool(schoolId,
      `SELECT * FROM fee_dues WHERE student_id = ?`,
      [studentId]
    );

    res.json({ ledger, payments, dues });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/teachers/fee-pay - Collect fee payment
router.post('/fee-pay', authenticateTeacherToken, async (req, res) => {
  const schoolId = req.teacher.schoolId;
  const teacherId = req.teacher.teacherId;
  const { ledger_id, amount_paid, payment_date } = req.body;

  try {
    const teacher = await querySchoolOne(schoolId, 'SELECT assigned_class, can_collect_fees FROM teachers WHERE id = ?', [teacherId]);
    if (!teacher || !teacher.can_collect_fees) {
      return res.status(403).json({ error: 'You do not have permission to collect fees.' });
    }

    if (!ledger_id || !amount_paid || amount_paid <= 0) {
      return res.status(400).json({ error: 'Valid ledger ID and amount are required' });
    }

    const ledger = await querySchoolOne(schoolId, 'SELECT * FROM fee_ledger WHERE id = ?', [ledger_id]);
    if (!ledger) {
      return res.status(404).json({ error: 'Fee ledger record not found' });
    }

    // Verify the student belongs to the teacher's assigned class
    if (teacher.assigned_class && ledger.class_name !== teacher.assigned_class) {
      return res.status(403).json({ error: 'You can only collect fees for your assigned class.' });
    }

    const newPaid = (ledger.paid_amount || 0) + parseFloat(amount_paid);
    const totalPayable = ledger.total_payable || 0;
    let status = 'Unpaid';
    if (newPaid >= totalPayable) status = 'Paid';
    else if (newPaid > 0) status = 'Partial';

    const payDate = payment_date || new Date().toISOString().split('T')[0];

    await runSchool(schoolId, 'UPDATE fee_ledger SET paid_amount = ?, status = ? WHERE id = ?', [newPaid, status, ledger_id]);
    await runSchool(schoolId,
      `INSERT INTO fee_payments (student_id, class_name, month, year, amount_paid, payment_date, fee_ledger_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [ledger.student_id, ledger.class_name, ledger.month, ledger.year, parseFloat(amount_paid), payDate, ledger_id]
    );

    res.json({ message: 'Payment recorded successfully', new_paid: newPaid, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
