const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const config = require('../config');
const { querySchool, querySchoolOne, runSchool, queryMainOne } = require('../database_manager');

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
    }

    res.json({
      message: 'Marks saved successfully!',
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
      'SELECT id, subject, max_marks FROM exam_subjects WHERE exam_id = ? AND class_name = ? AND term = ?',
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

// GET /api/teachers/assignments - Get all assignments created by this teacher
router.get('/assignments', authenticateTeacherToken, async (req, res) => {
  const schoolId = req.teacher.schoolId;
  const teacherId = req.teacher.teacherId;
  try {
    const rows = await querySchool(
      schoolId,
      `SELECT * FROM assignments WHERE teacher_id = ? ORDER BY created_at DESC`,
      [teacherId]
    );
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
  const { subject, class_name, section_name, title, description, type, due_date, priority } = req.body;

  if (!title || !subject || !class_name) {
    return res.status(400).json({ error: 'Title, subject, and class are required' });
  }

  try {
    const teacherInfo = await querySchoolOne(schoolId, 'SELECT name FROM teachers WHERE id = ?', [teacherId]);
    const teacherName = teacherInfo ? teacherInfo.name : 'Teacher';

    const result = await runSchool(
      schoolId,
      `INSERT INTO assignments (teacher_id, teacher_name, subject, class_name, section_name, title, description, type, due_date, priority, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [teacherId, teacherName, subject, class_name, section_name || '', title, description || '', type || 'homework', due_date || '', priority || 'medium']
    );
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
  const { subject, class_name, section_name, title, description, type, due_date, priority } = req.body;

  try {
    await runSchool(
      schoolId,
      `UPDATE assignments SET subject=?, class_name=?, section_name=?, title=?, description=?, type=?, due_date=?, priority=?
       WHERE id=? AND teacher_id=?`,
      [subject, class_name, section_name || '', title, description || '', type || 'homework', due_date || '', priority || 'medium', assignmentId, teacherId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Error updating assignment:', err);
    res.status(500).json({ error: 'Failed to update assignment' });
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
      `DELETE FROM assignments WHERE id=? AND teacher_id=?`,
      [assignmentId, teacherId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting assignment:', err);
    res.status(500).json({ error: 'Failed to delete assignment' });
  }
});

module.exports = router;
