const express = require('express');
const router = express.Router();
const { authenticateToken } = require('./auth');
const { querySchool, querySchoolOne, runSchool, runSchoolTransaction } = require('../database_manager');
const syncManager = require('../sync_manager');

// GET /exams - Get list of exams
router.get('/', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  try {
    const exams = await querySchool(schoolId, 'SELECT * FROM exams ORDER BY year DESC, id DESC');
    // Parse classes JSON string into array
    exams.forEach(ex => {
      try { ex.classes = JSON.parse(ex.classes || '[]'); } catch (e) { ex.classes = []; }
    });
    res.json(exams);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /exams - Create an exam
router.post('/', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { exam_name, year, classes } = req.body;

  if (!exam_name || !year) {
    return res.status(400).json({ error: 'exam_name and year are required' });
  }

  const classesJson = JSON.stringify(classes || []);

  try {
    const result = await runSchool(
      schoolId,
      'INSERT INTO exams (exam_name, year, classes) VALUES (?, ?, ?)',
      [exam_name, parseInt(year), classesJson]
    );
    res.status(201).json({ message: 'Exam created successfully!', id: result.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /exams/subjects - Get exam subjects
router.get('/subjects', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { exam_id, class_name, term } = req.query;

  if (!exam_id || !term) {
    return res.status(400).json({ error: 'exam_id and term are required' });
  }

  let query = 'SELECT * FROM exam_subjects WHERE exam_id = ? AND term = ?';
  const params = [parseInt(exam_id), term];

  if (class_name && class_name !== 'All Classes') {
    query += ' AND class = ?';
    params.push(class_name);
  }

  query += ' ORDER BY class, subject';

  try {
    const subjects = await querySchool(schoolId, query, params);
    res.json(subjects);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /exams/subjects - Add exam subject
router.post('/subjects', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { exam_id, class_name, subject, max_marks, term } = req.body;

  if (!exam_id || !class_name || !subject || !max_marks || !term) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  try {
    const result = await runSchool(
      schoolId,
      'INSERT INTO exam_subjects (exam_id, class, subject, max_marks, term) VALUES (?, ?, ?, ?, ?)',
      [parseInt(exam_id), class_name, subject, parseInt(max_marks), term]
    );
    res.status(201).json({ message: 'Subject added successfully!', id: result.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /exams/subjects/:id - Delete an exam subject
router.delete('/subjects/:id', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const id = req.params.id;

  try {
    await runSchool(schoolId, 'DELETE FROM exam_subjects WHERE id = ?', [id]);
    res.json({ message: 'Subject deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /exams/marks - Get marks grid for a subject
router.get('/marks', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { exam_id, class_name, section_name, subject, term } = req.query;

  if (!exam_id || !class_name || !subject || !term) {
    return res.status(400).json({ error: 'exam_id, class_name, subject, and term are required' });
  }

  try {
    // 1. Get all active students in class/section
    let studentsQuery = "SELECT id, name, roll_no, class_name, section_name FROM students WHERE class_name = ? AND (status IS NULL OR status != 'Left')";
    const studentsParams = [class_name];

    if (section_name) {
      if (section_name === 'No Section') {
        studentsQuery += " AND (section_name IS NULL OR section_name = '')";
      } else {
        studentsQuery += " AND section_name = ?";
        studentsParams.push(section_name);
      }
    }
    studentsQuery += " ORDER BY CAST(roll_no AS INTEGER), name";

    const students = await querySchool(schoolId, studentsQuery, studentsParams);

    // 2. Get marks entered for this subject
    const marksQuery = `
      SELECT student_id, marks 
      FROM marks 
      WHERE exam_id = ? AND subject = ? AND term = ?
    `;
    const marks = await querySchool(schoolId, marksQuery, [parseInt(exam_id), subject, term]);
    const marksMap = {};
    marks.forEach(m => {
      marksMap[m.student_id] = m.marks;
    });

    // 3. Merge
    const grid = students.map(student => {
      return {
        id: student.id,
        name: student.name,
        roll_no: student.roll_no,
        class_name: student.class_name,
        section_name: student.section_name,
        marks: marksMap[student.id] !== undefined ? marksMap[student.id] : ''
      };
    });

    res.json(grid);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /exams/marks - Save marks grid
router.post('/marks', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { exam_id, subject, term, marksList } = req.body; // marksList: [{student_id, marks}]

  if (!exam_id || !subject || !term || !marksList || !Array.isArray(marksList)) {
    return res.status(400).json({ error: 'Invalid parameters' });
  }

  try {
    const affectedStudents = [];

    for (const entry of marksList) {
      const marksVal = entry.marks === '' ? null : parseInt(entry.marks);

      if (marksVal === null) {
        // Delete if cleared
        await runSchool(
          schoolId,
          'DELETE FROM marks WHERE student_id = ? AND exam_id = ? AND subject = ? AND term = ?',
          [entry.student_id, parseInt(exam_id), subject, term]
        );
      } else {
        // Safe-insert: delete then insert to avoid duplicates
        await runSchool(
          schoolId,
          'DELETE FROM marks WHERE student_id = ? AND exam_id = ? AND subject = ? AND term = ?',
          [entry.student_id, parseInt(exam_id), subject, term]
        );
        await runSchool(
          schoolId,
          'INSERT INTO marks (student_id, exam_id, subject, marks, term) VALUES (?, ?, ?, ?, ?)',
          [entry.student_id, parseInt(exam_id), subject, marksVal, term]
        );
      }

      affectedStudents.push(entry.student_id);

      // SYNC: Emit marks update event for each student affected
      await syncManager.onMarksUpdated(
        schoolId,
        entry.student_id,
        parseInt(exam_id),
        subject,
        null, // oldMarks not tracked for this version
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
    res.status(500).json({ error: err.message });
  }
});

// Grading formula helpers
function getGrade(percentage) {
  if (percentage >= 90) return 'A+';
  if (percentage >= 80) return 'A';
  if (percentage >= 70) return 'B';
  if (percentage >= 60) return 'C';
  if (percentage >= 50) return 'D';
  return 'F';
}

function getRemarks(percentage) {
  if (percentage > 79) return 'Excellent keep it up';
  if (percentage > 65) return 'Very good keep it up';
  if (percentage > 50) return 'Good but need improvment';
  if (percentage > 40) return 'Satisfactory need improvement';
  if (percentage > 32) return 'Satisfactory need more hardwork';
  return 'Not good More hardwork to pass';
}

// POST /exams/calculate - Calculate term results & positions (Dense Ranking)
router.post('/calculate', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { class_name, term, exam_id, section_name } = req.body;

  if (!term || !exam_id) {
    return res.status(400).json({ error: 'term and exam_id are required' });
  }

  try {
    // 1. Get classes to process
    let classes = [];
    if (class_name) {
      classes = [class_name];
    } else {
      const rows = await querySchool(schoolId, 'SELECT DISTINCT class_name FROM students WHERE status != "Left" OR status IS NULL');
      classes = rows.map(r => r.class_name).filter(Boolean);
    }

    for (const cls of classes) {
      // Get all virtual result sections if configured, otherwise legacy [null]
      let targetResSections = [null];
      const rsRows = await querySchool(schoolId, 'SELECT section_name FROM result_sections WHERE class_name = ?', [cls]);
      if (rsRows.length > 0) {
        targetResSections = rsRows.map(r => r.section_name);
      }

      for (const resSec of targetResSections) {
        // Fetch students in this class/section filter
        let studentsQuery = "SELECT id, roll_no FROM students WHERE class_name = ? AND (status IS NULL OR status != 'Left')";
        const studentsParams = [cls];

        if (section_name) {
          if (section_name === 'No Section') {
            studentsQuery += " AND (section_name IS NULL OR section_name = '')";
          } else {
            studentsQuery += " AND section_name = ?";
            studentsParams.push(section_name);
          }
        }

        if (resSec) {
          const rsRange = await querySchoolOne(schoolId, 'SELECT roll_start, roll_end FROM result_sections WHERE class_name = ? AND section_name = ?', [cls, resSec]);
          if (rsRange) {
            studentsQuery += ' AND CAST(roll_no AS INTEGER) BETWEEN ? AND ?';
            studentsParams.push(rsRange.roll_start, rsRange.roll_end);
          }
        }

        const students = await querySchool(schoolId, studentsQuery, studentsParams);
        if (students.length === 0) continue;

        // Fetch subjects for this class/term
        const subjects = await querySchool(
          schoolId,
          'SELECT subject, max_marks FROM exam_subjects WHERE exam_id = ? AND class = ? AND term = ?',
          [parseInt(exam_id), cls, term]
        );
        if (subjects.length === 0) continue;

        const totalMarks = subjects.reduce((sum, s) => sum + s.max_marks, 0);

        // Process student scores
        for (const student of students) {
          const marksRows = await querySchool(
            schoolId,
            'SELECT subject, marks FROM marks WHERE student_id = ? AND exam_id = ? AND term = ?',
            [student.id, parseInt(exam_id), term]
          );

          const marksMap = {};
          marksRows.forEach(m => {
            marksMap[m.subject.toUpperCase()] = m.marks;
          });

          // Sum obtained marks
          const obtained = subjects.reduce((sum, sub) => {
            const m = marksMap[sub.subject.toUpperCase()] || 0;
            return sum + m;
          }, 0);

          const percentage = totalMarks ? parseFloat(((obtained / totalMarks) * 100).toFixed(2)) : 0;
          const grade = getGrade(percentage);
          const remarks = getRemarks(percentage);

          // Clear previous results
          await runSchool(
            schoolId,
            'DELETE FROM results WHERE student_id = ? AND exam_id = ? AND term = ?',
            [student.id, parseInt(exam_id), term]
          );

          // Insert results
          await runSchool(
            schoolId,
            `INSERT INTO results (student_id, exam_id, term, total, obtained, percentage, grade, position, remarks)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
            [student.id, parseInt(exam_id), term, totalMarks, obtained, percentage, grade, remarks]
          );
        }

        // Apply Dense Ranking
        let rankQuery = `
          SELECT r.id, r.percentage
          FROM results r
          JOIN students s ON s.id = r.student_id
          WHERE r.exam_id = ? AND r.term = ? AND s.class_name = ?
        `;
        const rankParams = [parseInt(exam_id), term, cls];

        if (section_name) {
          if (section_name === 'No Section') {
            rankQuery += " AND (s.section_name IS NULL OR s.section_name = '')";
          } else {
            rankQuery += " AND s.section_name = ?";
            rankParams.push(section_name);
          }
        }

        if (resSec) {
          const rsRange = await querySchoolOne(schoolId, 'SELECT roll_start, roll_end FROM result_sections WHERE class_name = ? AND section_name = ?', [cls, resSec]);
          if (rsRange) {
            rankQuery += ' AND CAST(s.roll_no AS INTEGER) BETWEEN ? AND ?';
            rankParams.push(rsRange.roll_start, rsRange.roll_end);
          }
        }

        rankQuery += ' ORDER BY r.percentage DESC';

        const rankedRows = await querySchool(schoolId, rankQuery, rankParams);
        let rank = 0;
        let prevPercentage = null;

        for (const row of rankedRows) {
          if (prevPercentage === null || row.percentage < prevPercentage) {
            rank++;
          }
          await runSchool(schoolId, 'UPDATE results SET position = ? WHERE id = ?', [rank, row.id]);
          prevPercentage = row.percentage;
        }
      }
    }

    // SYNC: Emit results calculated event to cascade updates to analytics, dashboard, and DMCs
    const affectedClasses = class_name ? [class_name] : classes;
    await syncManager.onResultsCalculated(schoolId, affectedClasses, term, parseInt(exam_id));

    res.json({
      message: 'Result calculations completed successfully!',
      syncEvent: 'results.calculated',
      affectedClasses,
      term,
      examId: parseInt(exam_id)
    });
  } catch (err) {
    console.error('Calculation error:', err);
    res.status(500).json({ error: 'Failed to calculate results: ' + err.message });
  }
});

// GET /exams/results - Fetch results summary
router.get('/results', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { class_name, term, exam_id } = req.query;

  if (!term || !exam_id) {
    return res.status(400).json({ error: 'term and exam_id are required' });
  }

  let query = `
    SELECT r.*, s.name as student_name, s.roll_no, s.class_name, s.section_name
    FROM results r
    JOIN students s ON s.id = r.student_id
    WHERE r.exam_id = ? AND r.term = ?
  `;
  const params = [parseInt(exam_id), term];

  if (class_name) {
    query += ' AND s.class_name = ?';
    params.push(class_name);
  }

  query += ' ORDER BY s.class_name, r.position';

  try {
    const list = await querySchool(schoolId, query, params);
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /exams/dmc - Fetch DMC detailed card for a single student
router.get('/dmc/:studentId', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const studentId = parseInt(req.params.studentId);
  const { exam_id, term } = req.query;

  if (!exam_id || !term) {
    return res.status(400).json({ error: 'exam_id and term are required' });
  }

  try {
    // 1. Get student profile details
    const student = await querySchoolOne(schoolId, 'SELECT * FROM students WHERE id = ?', [studentId]);
    if (!student) return res.status(404).json({ error: 'Student not found' });

    // 2. Get list of subjects (try exam_subjects first, fallback to timetable)
    let subjects = await querySchool(
      schoolId,
      'SELECT subject, max_marks FROM exam_subjects WHERE exam_id = ? AND class = ? AND term = ? ORDER BY subject',
      [parseInt(exam_id), student.class_name, term]
    );
    if (subjects.length === 0) {
      subjects = await querySchool(
        schoolId,
        `SELECT DISTINCT subject, 100 as max_marks FROM timetable WHERE class_name = ? AND subject IS NOT NULL AND subject != '' ORDER BY subject`,
        [student.class_name]
      );
    }

    // 3. Get student's individual marks per subject
    const marks = await querySchool(
      schoolId,
      'SELECT subject, marks FROM marks WHERE student_id = ? AND exam_id = ? AND term = ?',
      [studentId, parseInt(exam_id), term]
    );

    const marksMap = {};
    marks.forEach(m => { marksMap[m.subject.toUpperCase()] = m.marks; });

    const reportDetails = subjects.map(sub => {
      const obMarks = marksMap[sub.subject.toUpperCase()] !== undefined ? marksMap[sub.subject.toUpperCase()] : 0;
      const status = obMarks >= (sub.max_marks * 0.33) ? 'Pass' : 'Fail';
      return { subject: sub.subject, max_marks: sub.max_marks, obtained_marks: obMarks, status };
    });

    // 4. Calculate summary on-the-fly from marks data
    let total = 0, obtained = 0;
    reportDetails.forEach(r => { total += r.max_marks; obtained += r.obtained_marks; });
    const percentage = total > 0 ? ((obtained / total) * 100).toFixed(1) : 0;
    let grade = 'F';
    if (percentage >= 90) grade = 'A+';
    else if (percentage >= 80) grade = 'A';
    else if (percentage >= 70) grade = 'B';
    else if (percentage >= 60) grade = 'C';
    else if (percentage >= 50) grade = 'D';
    else if (percentage >= 33) grade = 'E';

    // Try to get saved result, or use calculated
    const savedResult = await querySchoolOne(
      schoolId,
      'SELECT position, remarks FROM results WHERE student_id = ? AND exam_id = ? AND term = ?',
      [studentId, parseInt(exam_id), term]
    );

    // If no saved result, calculate position on-the-fly from marks
    let position = savedResult ? savedResult.position : null;
    if (!position || position === 0) {
      // First try from results table
      const rankRow = await querySchoolOne(
        schoolId,
        `SELECT COUNT(*) + 1 as position FROM results r
         JOIN students s ON s.id = r.student_id
         WHERE r.exam_id = ? AND r.term = ? AND s.class_name = ?
         AND r.obtained > ?`,
        [parseInt(exam_id), term, student.class_name, obtained]
      );
      position = rankRow ? rankRow.position : null;

      // If results table is empty, calculate from marks directly
      if (!position || position === 1) {
        const allStudents = await querySchool(
          schoolId,
          `SELECT s.id FROM students s
           WHERE s.class_name = ? AND (s.status IS NULL OR s.status != 'Left')`,
          [student.class_name]
        );
        let rank = 1;
        for (const other of allStudents) {
          if (other.id === student.id) continue;
          const otherMarks = await querySchool(
            schoolId,
            'SELECT COALESCE(SUM(marks), 0) as total_obt FROM marks WHERE student_id = ? AND exam_id = ? AND term = ?',
            [other.id, parseInt(exam_id), term]
          );
          const otherObt = otherMarks[0] ? otherMarks[0].total_obt : 0;
          if (otherObt > obtained) rank++;
        }
        position = rank;
      }
    }

    const summary = {
      total,
      obtained,
      percentage,
      grade,
      position: position || '-',
      remarks: savedResult ? savedResult.remarks : (percentage >= 33 ? 'Pass' : 'Fail')
    };

    res.json({ student, summary, reportDetails });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /exams/dmc/class/:className - Get DMC data for ALL students in a class
router.get('/dmc/class/:className', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const className = req.params.className;
  const { exam_id, term, section_name } = req.query;

  if (!exam_id || !term) {
    return res.status(400).json({ error: 'exam_id and term are required' });
  }

  try {
    let studentsQuery = "SELECT * FROM students WHERE class_name = ? AND (status IS NULL OR status != 'Left')";
    const params = [className];
    if (section_name && section_name !== 'All Sections') {
      studentsQuery += " AND section_name = ?";
      params.push(section_name);
    }
    studentsQuery += " ORDER BY CAST(roll_no AS INTEGER), name";
    const students = await querySchool(schoolId, studentsQuery, params);

    // Get subjects for this class (from timetable as fallback)
    let subjects = await querySchool(
      schoolId,
      'SELECT subject, max_marks FROM exam_subjects WHERE exam_id = ? AND class = ? AND term = ? ORDER BY subject',
      [parseInt(exam_id), className, term]
    );
    if (subjects.length === 0) {
      subjects = await querySchool(
        schoolId,
        `SELECT DISTINCT subject, 100 as max_marks FROM timetable WHERE class_name = ? AND subject IS NOT NULL AND subject != '' ORDER BY subject`,
        [className]
      );
    }

    const results = [];
    for (const student of students) {
      // Get summary
      const summary = await querySchoolOne(
        schoolId,
        'SELECT total, obtained, percentage, grade, position, remarks FROM results WHERE student_id = ? AND exam_id = ? AND term = ?',
        [student.id, parseInt(exam_id), term]
      );

      // Get marks
      const marks = await querySchool(
        schoolId,
        'SELECT subject, marks FROM marks WHERE student_id = ? AND exam_id = ? AND term = ?',
        [student.id, parseInt(exam_id), term]
      );
      const marksMap = {};
      marks.forEach(m => { marksMap[m.subject.toUpperCase()] = m.marks; });

      const reportDetails = subjects.map(sub => {
        const obMarks = marksMap[sub.subject.toUpperCase()] !== undefined ? marksMap[sub.subject.toUpperCase()] : 0;
        const status = obMarks >= (sub.max_marks * 0.33) ? 'Pass' : 'Fail';
        return { subject: sub.subject, max_marks: sub.max_marks, obtained_marks: obMarks, status };
      });

      // Calculate summary on-the-fly
      let total = 0, obtained = 0;
      reportDetails.forEach(r => { total += r.max_marks; obtained += r.obtained_marks; });
      const percentage = total > 0 ? ((obtained / total) * 100).toFixed(1) : 0;
      let grade = 'F';
      if (percentage >= 90) grade = 'A+';
      else if (percentage >= 80) grade = 'A';
      else if (percentage >= 70) grade = 'B';
      else if (percentage >= 60) grade = 'C';
      else if (percentage >= 50) grade = 'D';
      else if (percentage >= 33) grade = 'E';

      const savedResult = summary || {};

      // Calculate position on-the-fly if not saved
      let position = savedResult.position || null;
      if (!position || position === 0) {
        // First try from results table
        const rankRow = await querySchoolOne(
          schoolId,
          `SELECT COUNT(*) + 1 as position FROM results r
           JOIN students s ON s.id = r.student_id
           WHERE r.exam_id = ? AND r.term = ? AND s.class_name = ?
           AND r.obtained > ?`,
          [parseInt(exam_id), term, className, obtained]
        );
        position = rankRow ? rankRow.position : null;

        // If results table is empty, calculate from marks directly
        if (!position || position === 1) {
          const allClassStudents = await querySchool(
            schoolId,
            `SELECT s.id FROM students s
             WHERE s.class_name = ? AND (s.status IS NULL OR s.status != 'Left')`,
            [className]
          );
          let rank = 1;
          for (const other of allClassStudents) {
            if (other.id === student.id) continue;
            const otherMarks = await querySchool(
              schoolId,
              'SELECT COALESCE(SUM(marks), 0) as total_obt FROM marks WHERE student_id = ? AND exam_id = ? AND term = ?',
              [other.id, parseInt(exam_id), term]
            );
            const otherObt = otherMarks[0] ? otherMarks[0].total_obt : 0;
            if (otherObt > obtained) rank++;
          }
          position = rank;
        }
      }

      results.push({
        student,
        summary: {
          total,
          obtained,
          percentage,
          grade,
          position: position || '-',
          remarks: savedResult.remarks || (percentage >= 33 ? 'Pass' : 'Fail')
        },
        reportDetails
      });
    }

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// DATE SHEET ENDPOINTS
// ==========================================

// POST /exams/datesheets - Create or merge date sheet template (same name = merge subjects)
router.post('/datesheets', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { name, template_json } = req.body;

  if (!name || !template_json) {
    return res.status(400).json({ error: 'name and template_json are required' });
  }

  try {
    // Ensure table exists
    await runSchool(schoolId, `CREATE TABLE IF NOT EXISTS date_sheet_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      template_json TEXT,
      is_active INTEGER DEFAULT 0
    )`);

    // Check if template with same name already exists
    const existing = await querySchoolOne(schoolId, 'SELECT * FROM date_sheet_templates WHERE name = ?', [name]);

    const newTemplate = JSON.parse(template_json);

    if (existing) {
      // Merge: combine existing subjects with new ones
      const existingTemplate = JSON.parse(existing.template_json || '{}');
      const existingSubjects = existingTemplate.subjects || [];
      const newSubjects = newTemplate.subjects || [];
      const mergedSubjects = [...existingSubjects, ...newSubjects];
      const merged = {
        exam_id: newTemplate.exam_id || existingTemplate.exam_id,
        term: newTemplate.term || existingTemplate.term,
        subjects: mergedSubjects
      };
      await runSchool(schoolId, 'UPDATE date_sheet_templates SET template_json = ? WHERE id = ?', [JSON.stringify(merged), existing.id]);
      res.status(200).json({ message: 'Template updated — ' + mergedSubjects.length + ' total subjects', id: existing.id });
    } else {
      // Create new
      const result = await runSchool(schoolId, 'INSERT INTO date_sheet_templates (name, template_json) VALUES (?, ?)', [name, template_json]);
      res.status(201).json({ message: 'Template created!', id: result.id });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /exams/datesheets - Get all date sheet templates
router.get('/datesheets', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  try {
    await runSchool(schoolId, `CREATE TABLE IF NOT EXISTS date_sheet_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      template_json TEXT,
      is_active INTEGER DEFAULT 0
    )`);
    const templates = await querySchool(schoolId, 'SELECT * FROM date_sheet_templates ORDER BY id DESC');
    templates.forEach(t => {
      try { t.template = JSON.parse(t.template_json || '{}'); } catch (e) { t.template = {}; }
    });
    res.json(templates);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /exams/datesheets/active - Get the currently active datesheet
router.get('/datesheets/active', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  try {
    await runSchool(schoolId, `CREATE TABLE IF NOT EXISTS date_sheet_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      template_json TEXT,
      is_active INTEGER DEFAULT 0
    )`);
    const tpl = await querySchoolOne(schoolId, 'SELECT * FROM date_sheet_templates WHERE is_active = 1');
    if (!tpl) return res.json(null);
    try { tpl.template = JSON.parse(tpl.template_json || '{}'); } catch (e) { tpl.template = {}; }
    res.json(tpl);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /exams/datesheets/:id - Delete date sheet template
router.delete('/datesheets/:id', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const id = req.params.id;
  try {
    await runSchool(schoolId, 'DELETE FROM date_sheet_templates WHERE id = ?', [id]);
    res.json({ message: 'Date sheet template deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /exams/datesheets/:id/activate - Activate a datesheet template (deactivates others)
router.put('/datesheets/:id/activate', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const id = req.params.id;
  try {
    await runSchool(schoolId, `CREATE TABLE IF NOT EXISTS date_sheet_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      template_json TEXT,
      is_active INTEGER DEFAULT 0
    )`);
    await runSchool(schoolId, 'UPDATE date_sheet_templates SET is_active = 0');
    await runSchool(schoolId, 'UPDATE date_sheet_templates SET is_active = 1 WHERE id = ?', [parseInt(id)]);
    res.json({ message: 'Datesheet activated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /exams/marks/spreadsheet - Get multi-subject marks spreadsheet
router.get('/marks/spreadsheet', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { exam_id, class_name, section_name, term } = req.query;

  if (!exam_id || !class_name || !term) {
    return res.status(400).json({ error: 'exam_id, class_name, and term are required' });
  }

  try {
    let studentsQuery = "SELECT id, name, roll_no, class_name, section_name FROM students WHERE class_name = ? AND (status IS NULL OR status != 'Left')";
    const studentsParams = [class_name];

    if (section_name && section_name !== 'All Sections') {
      if (section_name === 'No Section') {
        studentsQuery += " AND (section_name IS NULL OR section_name = '')";
      } else {
        studentsQuery += " AND section_name = ?";
        studentsParams.push(section_name);
      }
    }
    studentsQuery += " ORDER BY CAST(roll_no AS INTEGER), name";
    const students = await querySchool(schoolId, studentsQuery, studentsParams);

    // First try exam_subjects table (manual setup)
    let subjects = await querySchool(
      schoolId,
      'SELECT subject, max_marks FROM exam_subjects WHERE exam_id = ? AND class = ? AND term = ? ORDER BY subject',
      [parseInt(exam_id), class_name, term]
    );

    // If no exam_subjects found, fetch from timetable for this class
    if (subjects.length === 0) {
      const timetableSubjects = await querySchool(
        schoolId,
        `SELECT DISTINCT subject, 100 as max_marks FROM timetable WHERE class_name = ? AND subject IS NOT NULL AND subject != '' ORDER BY subject`,
        [class_name]
      );
      subjects = timetableSubjects;
    }

    const allMarks = await querySchool(
      schoolId,
      'SELECT student_id, subject, marks FROM marks WHERE exam_id = ? AND term = ?',
      [parseInt(exam_id), term]
    );
    const marksMap = {};
    allMarks.forEach(m => {
      const key = `${m.student_id}__${m.subject.toUpperCase()}`;
      marksMap[key] = m.marks;
    });

    const grid = students.map(student => {
      const row = { id: student.id, name: student.name, roll_no: student.roll_no, class_name: student.class_name, section_name: student.section_name, marks: {} };
      subjects.forEach(sub => {
        const key = `${student.id}__${sub.subject.toUpperCase()}`;
        row.marks[sub.subject] = marksMap[key] !== undefined ? marksMap[key] : '';
      });
      return row;
    });

    res.json({ subjects, grid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /exams/marks/spreadsheet - Save multi-subject marks spreadsheet
router.post('/marks/spreadsheet', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { exam_id, term, marksData } = req.body;

  if (!exam_id || !term || !marksData || !Array.isArray(marksData)) {
    return res.status(400).json({ error: 'Invalid parameters' });
  }

  try {
    for (const entry of marksData) {
      const studentId = entry.student_id;
      const subjectMarks = entry.marks;
      for (const [subject, marks] of Object.entries(subjectMarks)) {
        const marksVal = (marks === '' || marks === null || marks === undefined) ? null : parseInt(marks);
        if (marksVal === null) {
          await runSchool(
            schoolId,
            'DELETE FROM marks WHERE student_id = ? AND exam_id = ? AND subject = ? AND term = ?',
            [studentId, parseInt(exam_id), subject, term]
          );
        } else {
          await runSchool(
            schoolId,
            'DELETE FROM marks WHERE student_id = ? AND exam_id = ? AND subject = ? AND term = ?',
            [studentId, parseInt(exam_id), subject, term]
          );
          await runSchool(
            schoolId,
            'INSERT INTO marks (student_id, exam_id, subject, marks, term) VALUES (?, ?, ?, ?, ?)',
            [studentId, parseInt(exam_id), subject, marksVal, term]
          );
        }
      }
    }
    res.json({ message: 'Marks saved successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// ROLL NO SLIP TEMPLATES
// ==========================================

// POST /exams/rollno-templates - Create roll no slip template
router.post('/rollno-templates', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { name, template_json } = req.body;

  if (!name || !template_json) {
    return res.status(400).json({ error: 'name and template_json are required' });
  }

  try {
    await runSchool(schoolId, `CREATE TABLE IF NOT EXISTS roll_slip_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      template_json TEXT,
      is_active INTEGER DEFAULT 0,
      created_at TEXT
    )`);
    const result = await runSchool(
      schoolId,
      'INSERT INTO roll_slip_templates (name, template_json, created_at) VALUES (?, ?, ?)',
      [name, template_json, new Date().toISOString()]
    );
    res.status(201).json({ message: 'Roll no slip template saved!', id: result.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /exams/rollno-templates - Get all roll no slip templates
router.get('/rollno-templates', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  try {
    await runSchool(schoolId, `CREATE TABLE IF NOT EXISTS roll_slip_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      template_json TEXT,
      is_active INTEGER DEFAULT 0,
      created_at TEXT
    )`);
    const templates = await querySchool(schoolId, 'SELECT * FROM roll_slip_templates ORDER BY id DESC');
    templates.forEach(t => {
      try { t.template = JSON.parse(t.template_json || '{}'); } catch (e) { t.template = {}; }
    });
    res.json(templates);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /exams/rollno-templates/:id
router.delete('/rollno-templates/:id', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const id = req.params.id;
  try {
    await runSchool(schoolId, 'DELETE FROM roll_slip_templates WHERE id = ?', [id]);
    res.json({ message: 'Roll no slip template deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
