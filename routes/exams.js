const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const os = require('os');
const { authenticateToken } = require('./auth');
const { querySchool, querySchoolOne, runSchool, runSchoolTransaction } = require('../database_manager');
const syncManager = require('../sync_manager');

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
    const statements = [];

    for (const entry of marksList) {
      const marksVal = entry.marks === '' ? null : parseInt(entry.marks);
      statements.push({
        sql: 'DELETE FROM marks WHERE student_id = ? AND exam_id = ? AND subject = ? AND term = ?',
        params: [entry.student_id, parseInt(exam_id), subject, term]
      });
      if (marksVal !== null) {
        statements.push({
          sql: 'INSERT INTO marks (student_id, exam_id, subject, marks, term) VALUES (?, ?, ?, ?, ?)',
          params: [entry.student_id, parseInt(exam_id), subject, marksVal, term]
        });
      }
      affectedStudents.push(entry.student_id);
    }

    if (statements.length > 0) {
      await runSchoolTransaction(schoolId, statements);
    }

    for (const studentId of affectedStudents) {
      syncManager.onMarksUpdated(schoolId, studentId, parseInt(exam_id), subject, null, null);
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
      const rows = await querySchool(schoolId, "SELECT DISTINCT class_name FROM students WHERE status != 'Left' OR status IS NULL");
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

        // Bulk pre-fetch: all marks for all students in this class/term
        const studentIds = students.map(s => s.id);
        const placeholders = studentIds.map(() => '?').join(',');
        const allMarksRows = await querySchool(
          schoolId,
          `SELECT student_id, subject, marks FROM marks WHERE student_id IN (${placeholders}) AND exam_id = ? AND term = ?`,
          [...studentIds, parseInt(exam_id), term]
        );
        const marksByStudent = {};
        allMarksRows.forEach(m => {
          if (!marksByStudent[m.student_id]) marksByStudent[m.student_id] = {};
          marksByStudent[m.student_id][m.subject.toUpperCase()] = m.marks;
        });

        // Bulk delete previous results for all students in this class
        await runSchool(
          schoolId,
          `DELETE FROM results WHERE student_id IN (${placeholders}) AND exam_id = ? AND term = ?`,
          [...studentIds, parseInt(exam_id), term]
        );

        // Build all result rows and insert in batch
        const resultRows = [];
        for (const student of students) {
          const marksMap = marksByStudent[student.id] || {};

          // Sum obtained marks
          const obtained = subjects.reduce((sum, sub) => {
            const m = marksMap[sub.subject.toUpperCase()] || 0;
            return sum + m;
          }, 0);

          const percentage = totalMarks ? parseFloat(((obtained / totalMarks) * 100).toFixed(2)) : 0;
          const grade = getGrade(percentage);
          const remarks = getRemarks(percentage);

          resultRows.push([student.id, parseInt(exam_id), term, totalMarks, obtained, percentage, grade, remarks]);
        }

        // Batch insert results
        const insertStmts = [];
        for (const row of resultRows) {
          insertStmts.push({
            sql: `INSERT INTO results (student_id, exam_id, term, total, obtained, percentage, grade, position, remarks)
                   VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
            params: row
          });
        }
        if (insertStmts.length > 0) {
          await runSchoolTransaction(schoolId, insertStmts);
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

        const updateStmts = [];
        for (const row of rankedRows) {
          if (prevPercentage === null || row.percentage < prevPercentage) {
            rank++;
          }
          updateStmts.push({
            sql: 'UPDATE results SET position = ? WHERE id = ?',
            params: [rank, row.id]
          });
          prevPercentage = row.percentage;
        }
        if (updateStmts.length > 0) {
          await runSchoolTransaction(schoolId, updateStmts);
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

// GET /exams/results/comparison - Class-wise result comparison for dashboard
router.get('/results/comparison', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { exam_id, term } = req.query;

  if (!exam_id || !term) {
    return res.status(400).json({ error: 'exam_id and term are required' });
  }

  try {
    const classes = await querySchool(
      schoolId,
      "SELECT DISTINCT class_name FROM students WHERE (status IS NULL OR status != 'Left') ORDER BY class_name"
    );

    const comparison = [];

    for (const cls of classes) {
      const students = await querySchool(
        schoolId,
        `SELECT r.*, s.name as student_name, s.roll_no
         FROM results r
         JOIN students s ON s.id = r.student_id
         WHERE r.exam_id = ? AND r.term = ? AND s.class_name = ?`,
        [parseInt(exam_id), term, cls.class_name]
      );

      if (students.length === 0) continue;

      const percentages = students.map(s => s.percentage || 0);
      const avg = percentages.length ? (percentages.reduce((a, b) => a + b, 0) / percentages.length).toFixed(1) : 0;
      const max = percentages.length ? Math.max(...percentages).toFixed(1) : 0;
      const min = percentages.length ? Math.min(...percentages).toFixed(1) : 0;
      const passed = percentages.filter(p => p >= 40).length;
      const passRate = percentages.length ? ((passed / percentages.length) * 100).toFixed(1) : 0;
      const topStudent = students.reduce((best, s) => (!best || s.percentage > best.percentage) ? s : best, null);

      let gradeDist = { A: 0, B: 0, C: 0, D: 0, F: 0 };
      percentages.forEach(p => {
        if (p >= 80) gradeDist.A++;
        else if (p >= 65) gradeDist.B++;
        else if (p >= 50) gradeDist.C++;
        else if (p >= 40) gradeDist.D++;
        else gradeDist.F++;
      });

      comparison.push({
        class_name: cls.class_name,
        total_students: students.length,
        avg_percentage: parseFloat(avg),
        max_percentage: parseFloat(max),
        min_percentage: parseFloat(min),
        pass_rate: parseFloat(passRate),
        passed,
        failed: students.length - passed,
        top_student: topStudent ? { name: topStudent.student_name, roll_no: topStudent.roll_no, percentage: topStudent.percentage } : null,
        grade_distribution: gradeDist
      });
    }

    comparison.sort((a, b) => a.class_name.localeCompare(b.class_name, undefined, { numeric: true }));
    res.json(comparison);
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
    let studentsQuery = "SELECT id, student_id, name, roll_no, father_name, class_name, section_name, phone, dob, gender FROM students WHERE class_name = ? AND (status IS NULL OR status != 'Left')";
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

    // Bulk pre-fetch: all results and marks for all students in this class
    const studentIds = students.map(s => s.id);
    const placeholders = studentIds.map(() => '?').join(',');

    const allResults = await querySchool(
      schoolId,
      `SELECT student_id, total, obtained, percentage, grade, position, remarks
       FROM results WHERE student_id IN (${placeholders}) AND exam_id = ? AND term = ?`,
      [...studentIds, parseInt(exam_id), term]
    );
    const resultMap = {};
    allResults.forEach(r => { resultMap[r.student_id] = r; });

    const allMarksRows = await querySchool(
      schoolId,
      `SELECT student_id, subject, marks FROM marks WHERE student_id IN (${placeholders}) AND exam_id = ? AND term = ?`,
      [...studentIds, parseInt(exam_id), term]
    );
    const marksByStudent = {};
    allMarksRows.forEach(m => {
      if (!marksByStudent[m.student_id]) marksByStudent[m.student_id] = {};
      marksByStudent[m.student_id][m.subject.toUpperCase()] = m.marks;
    });

    // Bulk pre-fetch: all students in class for O(1) ranking
    const allClassStudents = await querySchool(
      schoolId,
      `SELECT s.id, COALESCE(SUM(m.marks), 0) as total_obt
       FROM students s
       LEFT JOIN marks m ON m.student_id = s.id AND m.exam_id = ? AND m.term = ?
       WHERE s.class_name = ? AND (s.status IS NULL OR s.status != 'Left')
       GROUP BY s.id ORDER BY total_obt DESC`,
      [parseInt(exam_id), term, className]
    );
    const rankMap = {};
    allClassStudents.forEach((row, idx) => { rankMap[row.id] = idx + 1; });

    const results = [];
    for (const student of students) {
      const summary = resultMap[student.id] || null;

      const marksMap = marksByStudent[student.id] || {};

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
      let position = savedResult.position || rankMap[student.id] || '-';

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

// POST /exams/datesheets - Create a new date sheet template
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

    const result = await runSchool(schoolId, 'INSERT INTO date_sheet_templates (name, template_json) VALUES (?, ?)', [name, template_json]);
    res.status(201).json({ message: 'Template created!', id: result.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /exams/datesheets/:id - Update an existing date sheet template (replace subjects)
router.put('/datesheets/:id', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const id = req.params.id;
  const { name, template_json } = req.body;

  if (!name || !template_json) {
    return res.status(400).json({ error: 'name and template_json are required' });
  }

  try {
    await runSchool(schoolId, `CREATE TABLE IF NOT EXISTS date_sheet_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      template_json TEXT,
      is_active INTEGER DEFAULT 0
    )`);

    const existing = await querySchoolOne(schoolId, 'SELECT * FROM date_sheet_templates WHERE id = ?', [parseInt(id)]);
    if (!existing) {
      return res.status(404).json({ error: 'Template not found' });
    }

    const result = await runSchool(schoolId, 'UPDATE date_sheet_templates SET name = ?, template_json = ? WHERE id = ?', [name, template_json, parseInt(id)]);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Template not found or no changes made' });
    }
    res.json({ message: 'Template updated successfully', id: parseInt(id) });
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

// GET /exams/datesheets/active/subjects - Get subjects from active datesheet for a given class
router.get('/datesheets/active/subjects', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { class_name } = req.query;

  try {
    await runSchool(schoolId, `CREATE TABLE IF NOT EXISTS date_sheet_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      template_json TEXT,
      is_active INTEGER DEFAULT 0
    )`);
    const tpl = await querySchoolOne(schoolId, 'SELECT * FROM date_sheet_templates WHERE is_active = 1');
    if (!tpl || !tpl.template_json) return res.json([]);

    let parsed;
    try { parsed = JSON.parse(tpl.template_json); } catch (e) { return res.json([]); }

    const subjects = [];
    const seen = new Set();
    const tplSubjects = parsed.subjects || [];
    for (const s of tplSubjects) {
      if (!s.subject) continue;
      if (class_name && s.class !== class_name && s.class !== 'All Classes') continue;
      const key = s.subject.toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      subjects.push({ subject: s.subject, max_marks: s.max_marks || 100 });
    }

    res.json(subjects.sort((a, b) => a.subject.localeCompare(b.subject)));
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

// PUT /exams/datesheets/:id/activate - Activate a datesheet template (deactivates others).
// Activation = the exam is now running: the exam registry entry is created automatically
// (and its subjects seeded) from the template's exam_name/year/term/subjects.
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
    const upd = await runSchool(schoolId, 'UPDATE date_sheet_templates SET is_active = 1 WHERE id = ?', [parseInt(id)]);
    if (!upd.changes) {
      return res.status(404).json({ error: 'Datesheet template not found' });
    }

    const tplRow = await querySchoolOne(schoolId, 'SELECT name, template_json FROM date_sheet_templates WHERE id = ?', [parseInt(id)]);
    let parsed = {};
    try { parsed = JSON.parse((tplRow && tplRow.template_json) || '{}'); } catch (e) { parsed = {}; }

    // Resolve exam name/year: new templates carry exam_name + year; legacy templates only carry exam_id
    let examName = parsed.exam_name;
    let examYear = parsed.year ? parseInt(parsed.year) : null;
    let examId = parsed.exam_id || null;
    if ((!examName || !examYear) && examId) {
      const oldExam = await querySchoolOne(schoolId, 'SELECT id, exam_name, year FROM exams WHERE id = ?', [parseInt(examId)]);
      if (oldExam) {
        examId = oldExam.id;
        examName = examName || oldExam.exam_name;
        examYear = examYear || parseInt(oldExam.year);
      }
    }
    examName = examName || (tplRow && tplRow.name) || 'Exam';
    examYear = examYear || new Date().getFullYear();

    // Classes derived from the template's subject rows
    const subjects = Array.isArray(parsed.subjects) ? parsed.subjects : [];
    const classes = [...new Set(subjects.map(s => (s.class || 'All Classes')))];
    if (classes.length === 0) classes.push('All Classes');
    const classesJson = JSON.stringify(classes);

    // Reuse an existing exam with the same name+year, else create it (the exam is now running)
    let exam = await querySchoolOne(schoolId, 'SELECT id FROM exams WHERE exam_name = ? AND year = ? ORDER BY id DESC LIMIT 1', [examName, examYear]);
    if (!exam) {
      const inserted = await runSchool(schoolId, 'INSERT INTO exams (exam_name, year, classes) VALUES (?, ?, ?)', [examName, examYear, classesJson]);
      examId = inserted.id;
    } else {
      examId = exam.id;
    }

    // Seed exam_subjects from the template (deduped) so marks entry / result flows see them
    const term = parsed.term || '1st Term';
    for (const s of subjects) {
      const subj = (s.subject || '').trim();
      if (!subj) continue;
      const cls = s.class || 'All Classes';
      const maxMarks = parseInt(s.max_marks) || 100;
      const exists = await querySchoolOne(
        schoolId,
        'SELECT id FROM exam_subjects WHERE exam_id = ? AND class = ? AND subject = ? AND term = ?',
        [examId, cls, subj, term]
      );
      if (!exists) {
        await runSchool(
          schoolId,
          'INSERT INTO exam_subjects (exam_id, class, subject, max_marks, term) VALUES (?, ?, ?, ?, ?)',
          [examId, cls, subj, maxMarks, term]
        );
      }
    }

    // Link the exam back into the template so downstream filters (marks spreadsheet etc.) scope correctly
    parsed.exam_id = examId;
    parsed.exam_name = examName;
    parsed.year = examYear;
    await runSchool(schoolId, 'UPDATE date_sheet_templates SET template_json = ? WHERE id = ?', [JSON.stringify(parsed), parseInt(id)]);

    res.json({ message: 'Datesheet activated — exam "' + examName + '" (' + examYear + ') is now running', examId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /exams/datesheets/generate-pdf - Generate a date sheet PDF (A4 landscape matrix)
router.post('/datesheets/generate-pdf', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { template_id } = req.body;

  if (!template_id) {
    return res.status(400).json({ error: 'template_id is required' });
  }

  try {
    const tplRow = await querySchoolOne(schoolId, 'SELECT id, name, template_json FROM date_sheet_templates WHERE id = ?', [parseInt(template_id)]);
    if (!tplRow) {
      return res.status(404).json({ error: 'Date sheet template not found' });
    }

    let t = {};
    try { t = JSON.parse(tplRow.template_json || '{}'); } catch (e) { t = {}; }
    const subjects = Array.isArray(t.subjects) ? t.subjects : [];
    if (subjects.length === 0) {
      return res.status(400).json({ error: 'This template has no subject rows' });
    }

    // Exam label: prefer exam_name/year from the template; fall back to linked exam
    let examLabel = (t.exam_name || '') + (t.year ? ' ' + t.year : '');
    if (!t.exam_name && t.exam_id) {
      const ex = await querySchoolOne(schoolId, 'SELECT exam_name, year FROM exams WHERE id = ?', [parseInt(t.exam_id)]);
      if (ex) examLabel = ex.exam_name + ' ' + ex.year;
    }
    if (!examLabel) examLabel = tplRow.name || 'Exam';

    function imageBuffer(value) {
      try {
        if (!value || typeof value !== 'string') return null;
        if (value.startsWith('data:')) {
          const i = value.indexOf('base64,');
          if (i < 0) return null;
          return Buffer.from(value.slice(i + 7), 'base64');
        }
        const clean = value.replace(/^\/+/, '');
        if (clean.includes('..')) return null;
        const full = path.join(__dirname, '..', 'public', clean);
        if (fs.existsSync(full)) return fs.readFileSync(full);
      } catch (e) { /* unreadable or unsupported image */ }
      return null;
    }

    const settings = await querySchoolOne(schoolId, 'SELECT * FROM fee_settings LIMIT 1');
    const schoolName = settings ? settings.school_name : 'School Name';
    const logoBuf = imageBuffer(settings ? settings.logo_path : null);

    // Build the matrix the same way the on-screen preview does
    const dateSet = new Set();
    const classSet = new Set();
    const cellMap = {};
    subjects.forEach(s => {
      const cls = s.class || 'All Classes';
      const date = s.date || '';
      classSet.add(cls);
      if (date) dateSet.add(date);
      if (!cellMap[cls]) cellMap[cls] = {};
      cellMap[cls][date] = s.subject || '-';
    });
    const sortedDates = Array.from(dateSet).sort();
    const sortedClasses = Array.from(classSet).sort((a, b) => {
      const na = parseInt(a), nb = parseInt(b);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return String(a).localeCompare(String(b));
    });
    const fmtDate = (d) => {
      try {
        return new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
      } catch (e) { return d; }
    };

    const PDFDocument = require('pdfkit');
    const uploadsDir = pdfStorageDir('datesheets');
    const fileName = `datesheet_${Date.now()}.pdf`;
    const filePath = path.join(uploadsDir, fileName);

    // compress:false keeps the single-page sheet tiny (~KBs) and content verifiable
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', bufferPages: true, compress: false });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    // Zero margins: pdfkit auto-adds phantom pages when text nears the default 72pt bottom margin
    const zeroMargins = () => { doc.page.margins = { top: 0, bottom: 0, left: 0, right: 0 }; };
    doc.on('pageAdded', zeroMargins);
    zeroMargins();

    const PAGE_W = doc.page.width;   // 842 landscape
    const MARGIN = 36;
    const CONTENT_W = PAGE_W - MARGIN * 2;

    // Header: logo + school name + DATE SHEET title
    let headerY = MARGIN;
    if (logoBuf) {
      try { doc.image(logoBuf, MARGIN, headerY, { fit: [64, 64] }); } catch (e) { /* skip bad image */ }
    }
    doc.fill('#111827').font('Helvetica-Bold').fontSize(20)
      .text(schoolName, MARGIN + (logoBuf ? 76 : 0), headerY + 12, { width: CONTENT_W - (logoBuf ? 76 : 0), align: logoBuf ? 'left' : 'center' });
    headerY += 74;
    doc.moveTo(MARGIN, headerY).lineTo(PAGE_W - MARGIN, headerY).lineWidth(2).stroke('#111827');
    headerY += 14;
    doc.font('Helvetica-Bold').fontSize(16).fill('#111827')
      .text('DATE SHEET', MARGIN, headerY, { width: CONTENT_W, align: 'center' });
    headerY += 24;
    doc.font('Helvetica').fontSize(10).fill('#374151')
      .text('Exam: ' + examLabel + '    |    Term: ' + (t.term || '-') + '    |    Template: ' + tplRow.name, MARGIN, headerY, { width: CONTENT_W, align: 'center' });
    headerY += 30;

    // Matrix table — auto-fit so the whole sheet stays on ONE A4 landscape page
    const CLASS_COL = 110;
    const DATE_COUNT = Math.max(sortedDates.length, 1);
    const DATE_COL = (CONTENT_W - CLASS_COL) / DATE_COUNT;
    const PAD = 6;
    const FOOTER_H = 72;
    const TABLE_TOP = headerY + 4;
    const TABLE_BOTTOM = doc.page.height - MARGIN - FOOTER_H;
    const availTableH = Math.max(TABLE_BOTTOM - TABLE_TOP, 60);
    const rowsTotal = sortedClasses.length + 1; // header row + one row per class
    // Scale row height to whatever fits the page (capped at the old fixed 26)
    let rowH = Math.floor(availTableH / rowsTotal);
    if (rowH > 26) rowH = 26;
    if (rowH < 11) rowH = 11;
    let cellFont = rowH >= 24 ? 9.5 : rowH >= 20 ? 8.5 : rowH >= 16 ? 7.5 : 6.5;
    if (DATE_COUNT > 8 && cellFont > 6.5) cellFont = Math.max(6.5, cellFont - 1.5);

    const drawCell = (x, y, w, text, { bold = false, fill = '#ffffff', align = 'left' } = {}) => {
      doc.rect(x, y, w, rowH).fillAndStroke(fill, '#111827');
      doc.fill('#111827').font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(cellFont)
        .text(text, x + PAD, y + rowH / 2 - cellFont / 2 - 1, { width: w - PAD * 2, align, height: rowH - 4, ellipsis: true, lineBreak: false });
    };

    const drawHeaderRow = (y) => {
      let x = MARGIN;
      drawCell(x, y, CLASS_COL, 'Class', { bold: true, fill: '#e5e7eb', align: 'center' });
      x += CLASS_COL;
      sortedDates.forEach(d => {
        drawCell(x, y, DATE_COL, fmtDate(d), { bold: true, fill: '#e5e7eb', align: 'center' });
        x += DATE_COL;
      });
    };

    // Header row + class rows — no page breaks: sizing guarantees a single page
    drawHeaderRow(TABLE_TOP);
    let y = TABLE_TOP + rowH;

    sortedClasses.forEach((cls, idx) => {
      const bg = idx % 2 === 0 ? '#ffffff' : '#f3f4f6';
      let x = MARGIN;
      drawCell(x, y, CLASS_COL, String(cls), { bold: true, fill: bg, align: 'center' });
      x += CLASS_COL;
      sortedDates.forEach(d => {
        const subject = (cellMap[cls] && cellMap[cls][d]) ? cellMap[cls][d] : '';
        drawCell(x, y, DATE_COL, String(subject), { fill: bg, align: 'center' });
        x += DATE_COL;
      });
      y += rowH;
    });

    // Footer: instructions + principal sign (always on the same single page)
    y += 22;
    doc.font('Helvetica').fontSize(9).fill('#374151');
    doc.text('• All students must be uniformed.', MARGIN, y);
    doc.text('• Students must reach the examination hall on time.', MARGIN, y + 14);
    doc.text('Principal Sign: ____________________', PAGE_W - MARGIN - 200, y, { width: 200, align: 'right' });
    doc.font('Helvetica-Bold').fontSize(10).fill('#111827')
      .text(schoolName, PAGE_W - MARGIN - 200, y + 20, { width: 200, align: 'right' });

    doc.end();

    stream.on('finish', () => {
      res.json({
        message: 'Date sheet PDF generated successfully',
        file_name: fileName,
        file_path: `/api/exams/datesheets/download/${fileName}`,
        class_count: sortedClasses.length,
        date_count: sortedDates.length
      });
    });

    stream.on('error', (err) => {
      res.status(500).json({ error: 'Failed to generate PDF: ' + err.message });
    });

  } catch (err) {
    console.error('Datesheet PDF generation error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /exams/datesheets/download/:filename - Download generated date sheet PDF
router.get('/datesheets/download/:filename', pdfDownloadAuth, async (req, res) => {
  const { filename } = req.params;
  if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  const filePath = path.join(pdfStorageDir('datesheets'), filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  res.download(filePath, filename);
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

    // If no exam_subjects, fetch from datesheet templates for this exam/class
    if (subjects.length === 0) {
      try {
        const templates = await querySchool(schoolId, 'SELECT template_json FROM date_sheet_templates');
        const datesheetSubjects = [];
        const seen = new Set();
        for (const tpl of templates) {
          try {
            const parsed = JSON.parse(tpl.template_json || '{}');
            if (parsed.exam_id && parsed.exam_id != parseInt(exam_id)) continue;
            if (parsed.term && parsed.term !== term) continue;
            const tplSubjects = parsed.subjects || [];
            for (const s of tplSubjects) {
              if (s.subject && (s.class === class_name || s.class === 'All Classes') && !seen.has(s.subject.toUpperCase())) {
                seen.add(s.subject.toUpperCase());
                datesheetSubjects.push({ subject: s.subject, max_marks: s.max_marks || 100 });
              }
            }
          } catch (e) {}
        }
        if (datesheetSubjects.length > 0) {
          subjects = datesheetSubjects.sort((a, b) => a.subject.localeCompare(b.subject));
        }
      } catch (e) {}
    }

    // If still no subjects, fetch from timetable for this class (last fallback)
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
    const affectedStudents = [];
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
        await syncManager.onMarksUpdated(schoolId, studentId, parseInt(exam_id), subject, null, marksVal);
      }
      affectedStudents.push(studentId);
    }
    res.json({ message: 'Marks saved successfully!', syncEvent: 'results.marks.updated', affectedStudents, needsRecalculation: true });
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

// POST /exams/rollno-slips/generate-pdf - Server-side roll no slips PDF (A4 landscape, template per_page)
router.post('/rollno-slips/generate-pdf', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { template_id, class_name, exam_id } = req.body;

  try {
    let t = {};
    if (template_id) {
      const tplRow = await querySchoolOne(schoolId, 'SELECT name, template_json FROM roll_slip_templates WHERE id = ?', [parseInt(template_id)]);
      if (tplRow) {
        try { t = JSON.parse(tplRow.template_json || '{}'); } catch (e) { t = {}; }
      }
    }
    const includeLogo = String(t.include_logo === undefined ? '1' : t.include_logo) !== '0';

    // Exam label (same wording as the on-screen slips)
    let examLabel = '';
    if (exam_id) {
      const ex = await querySchoolOne(schoolId, 'SELECT exam_name, year FROM exams WHERE id = ?', [parseInt(exam_id)]);
      if (ex) examLabel = t.term ? t.term + ' ' + ex.exam_name + ' ' + ex.year : ex.exam_name + ' Exam ' + ex.year;
    }
    if (!examLabel) examLabel = t.term || 'Exam';

    // Students — class filter mirrors the frontend generate handler
    let students;
    const cls = (class_name || '').trim();
    const studentCols = 'SELECT name, father_name, roll_no, class_name, section_name FROM students WHERE (status IS NULL OR status != \'Left\')';
    if (!cls || cls === 'All Classes') {
      students = await querySchool(schoolId, studentCols + ' ORDER BY CAST(roll_no AS INTEGER), name');
    } else {
      students = await querySchool(schoolId, studentCols + ' AND class_name = ? ORDER BY CAST(roll_no AS INTEGER), name', [cls]);
    }
    if (!students || students.length === 0) {
      return res.status(400).json({ error: 'No students found for the selected class' });
    }

    // Subject rows from the active date sheet (same source as the on-screen slips)
    let subjectRows = [];
    try {
      await runSchool(schoolId, `CREATE TABLE IF NOT EXISTS date_sheet_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        template_json TEXT,
        is_active INTEGER DEFAULT 0,
        created_at TEXT
      )`);
      const activeTpl = await querySchoolOne(schoolId, 'SELECT template_json FROM date_sheet_templates WHERE is_active = 1');
      if (activeTpl) {
        let at = {};
        try { at = JSON.parse(activeTpl.template_json || '{}'); } catch (e) { at = {}; }
        subjectRows = Array.isArray(at.subjects) ? at.subjects : [];
      }
    } catch (e) { subjectRows = []; }

    const settings = await querySchoolOne(schoolId, 'SELECT * FROM fee_settings LIMIT 1');
    const schoolName = settings ? settings.school_name : 'School Name';

    function imageBuffer(value) {
      try {
        if (!value || typeof value !== 'string') return null;
        if (value.startsWith('data:')) {
          const i = value.indexOf('base64,');
          if (i < 0) return null;
          return Buffer.from(value.slice(i + 7), 'base64');
        }
        const clean = value.replace(/^\/+/, '');
        if (clean.includes('..')) return null;
        const full = path.join(__dirname, '..', 'public', clean);
        if (fs.existsSync(full)) return fs.readFileSync(full);
      } catch (e) { /* unreadable or unsupported image */ }
      return null;
    }

    const logoBuf = includeLogo ? imageBuffer(settings ? settings.logo_path : null) : null;
    const signBuf = imageBuffer(t.principal_sign || null);

    // Instructions: template text, or the same defaults the on-screen slips use
    const instructions = (t.instructions && String(t.instructions).trim())
      ? String(t.instructions).split('. ').filter(Boolean).map(line => line.endsWith('.') ? line : line + '.')
      : ['All Students Must be Uniformed.', 'Students Must come on time.', 'Dues Must be cleared.'];

    const PDFDocument = require('pdfkit');
    const uploadsDir = pdfStorageDir('rollno');
    const fileName = `rollno_slips_${Date.now()}.pdf`;
    const filePath = path.join(uploadsDir, fileName);

    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', bufferPages: true, compress: false });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    // Zero margins: pdfkit auto-adds phantom pages when text nears the default 72pt bottom margin
    const zeroMargins = () => { doc.page.margins = { top: 0, bottom: 0, left: 0, right: 0 }; };
    doc.on('pageAdded', zeroMargins);
    zeroMargins();

    const PAGE_W = doc.page.width;   // 842
    const PAGE_H = doc.page.height;  // 595
    const MARGIN = 18;
    const GAP = 10;

    // Grid per page: always 2 columns (matches the print layout); rows from template per_page
    const perPageSetting = Math.min(6, Math.max(2, parseInt(t.per_page, 10) || 2));
    const COLS = 2;
    const ROWS = Math.ceil(perPageSetting / COLS);
    const PER_PAGE = COLS * ROWS;
    const SLIP_W = (PAGE_W - MARGIN * 2 - GAP) / COLS;
    const SLIP_H = (PAGE_H - MARGIN * 2 - GAP * (ROWS - 1)) / ROWS;

    const fmtDate = (d) => {
      try { return new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }); }
      catch (e) { return d; }
    };
    const fmtDay = (d) => {
      try { return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long' }); }
      catch (e) { return '-'; }
    };

    const drawSlip = (x, y, s) => {
      const w = SLIP_W, h = SLIP_H;
      // Slip border
      doc.rect(x, y, w, h).lineWidth(1.5).stroke('#000000');

      // School name
      doc.fill('#000000').font('Helvetica-Bold').fontSize(13)
        .text(schoolName.toUpperCase(), x + 10, y + 12, { width: w - 20, align: 'center' });

      // Logo + ROLL NO SLIP title
      let titleY = y + 32;
      if (logoBuf) {
        try { doc.image(logoBuf, x + 14, titleY, { fit: [36, 36] }); } catch (e) { /* skip bad image */ }
      }
      doc.font('Helvetica-Bold').fontSize(12)
        .text('ROLL NO SLIP', x + (logoBuf ? 58 : 10), titleY + 2, { width: w - (logoBuf ? 72 : 20), align: 'center' });
      doc.font('Helvetica').fontSize(9).fill('#333333')
        .text(examLabel, x + (logoBuf ? 58 : 10), titleY + 18, { width: w - (logoBuf ? 72 : 20), align: 'center' });

      // Student info (2-column grid)
      const infoY = titleY + 42;
      doc.fill('#000000').font('Helvetica-Bold').fontSize(9);
      doc.text('Name: ', x + 14, infoY);
      doc.font('Helvetica').text(s.name || '-', x + 52, infoY, { width: w / 2 - 60 });
      doc.font('Helvetica-Bold').text('Class: ', x + w / 2 + 6, infoY);
      doc.font('Helvetica').text((s.class_name || '-') + (s.section_name ? ' - ' + s.section_name : ''), x + w / 2 + 40, infoY, { width: w / 2 - 54 });
      doc.font('Helvetica-Bold').text('Father Name: ', x + 14, infoY + 15);
      doc.font('Helvetica').text(s.father_name || '-', x + 72, infoY + 15, { width: w / 2 - 80 });
      doc.font('Helvetica-Bold').text('Roll No: ', x + w / 2 + 6, infoY + 15);
      doc.font('Helvetica').text(s.roll_no != null && s.roll_no !== '' ? String(s.roll_no) : '-', x + w / 2 + 44, infoY + 15, { width: w / 2 - 58 });

      // Exam table from the active date sheet (same filter as the on-screen slips)
      const subjectsForClass = subjectRows.filter(sub => sub.class === 'All Classes' || sub.class === s.class_name);
      const FOOTER_H = 62;
      const tableTop = infoY + 36;
      const tableH = h - (tableTop - y) - FOOTER_H;
      const TH = 14;
      const maxDataRows = Math.max(1, Math.floor((tableH - TH) / TH));
      const colW = [w * 0.07, w * 0.19, w * 0.17, w * 0.33, w * 0.24];
      const headers = ['#', 'Date', 'Day', 'Subject', 'Time'];

      let ty = tableTop;
      // Header row
      doc.rect(x + 8, ty, w - 16, TH).fillAndStroke('#f0f0f0', '#000000');
      let tx = x + 8;
      doc.fill('#000000').font('Helvetica-Bold').fontSize(8);
      headers.forEach((hd, ci) => {
        doc.text(hd, tx + 2, ty + 3, { width: colW[ci] - 4, align: 'center', lineBreak: false });
        tx += colW[ci];
      });
      ty += TH;

      const cellText = (text, cx, cy, cw, bold) => {
        doc.fill('#000000').font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8)
          .text(String(text), cx + 2, cy + 3, { width: cw - 4, align: 'center', ellipsis: true, lineBreak: false });
      };

      if (subjectsForClass.length === 0) {
        doc.rect(x + 8, ty, w - 16, TH).fillAndStroke('#ffffff', '#000000');
        cellText('No datesheet available', x + 8, ty, w - 16, false);
      } else {
        subjectsForClass.slice(0, maxDataRows).forEach((sub, i) => {
          const bg = i % 2 === 0 ? '#ffffff' : '#f9fafb';
          doc.rect(x + 8, ty, w - 16, TH).fillAndStroke(bg, '#000000');
          let cx = x + 8;
          cellText(i + 1, cx, ty, colW[0], false); cx += colW[0];
          cellText(fmtDate(sub.date || ''), cx, ty, colW[1], false); cx += colW[1];
          cellText(fmtDay(sub.date || ''), cx, ty, colW[2], false); cx += colW[2];
          cellText(sub.subject || '-', cx, ty, colW[3], false); cx += colW[3];
          cellText(sub.time || '-', cx, ty, colW[4], false);
          ty += TH;
        });
      }

      // Footer: instructions (left) + principal signature (right)
      const footY = y + h - FOOTER_H + 6;
      doc.fill('#000000').font('Helvetica-Bold').fontSize(8)
        .text('Instructions:', x + 12, footY);
      doc.font('Helvetica').fontSize(7.5).fill('#333333');
      instructions.slice(0, 4).forEach((inst, i) => {
        doc.text('• ' + inst, x + 12, footY + 12 + i * 10, { width: w * 0.55 });
      });
      const signX = x + w - 12;
      if (signBuf) {
        try { doc.image(signBuf, signX - 90, footY, { fit: [80, 28] }); } catch (e) { /* skip bad image */ }
      }
      doc.moveTo(signX - 110, y + h - 18).lineTo(signX, y + h - 18).lineWidth(0.8).stroke('#000000');
      doc.fill('#000000').font('Helvetica').fontSize(7.5)
        .text('Principal Signature', signX - 110, y + h - 15, { width: 110, align: 'center' });
    };

    students.forEach((s, idx) => {
      const slot = idx % PER_PAGE;
      if (slot === 0 && idx > 0) doc.addPage();
      const row = Math.floor(slot / COLS);
      const col = slot % COLS;
      const x = MARGIN + col * (SLIP_W + GAP);
      const y = MARGIN + row * (SLIP_H + GAP);
      drawSlip(x, y, s);
    });

    doc.end();

    stream.on('finish', () => {
      res.json({
        message: 'Roll no slips PDF generated successfully',
        file_name: fileName,
        file_path: `/api/exams/rollno-slips/download/${fileName}`,
        slip_count: students.length
      });
    });

    stream.on('error', (err) => {
      res.status(500).json({ error: 'Failed to generate PDF: ' + err.message });
    });

  } catch (err) {
    console.error('Roll no slips PDF generation error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /exams/rollno-slips/download/:filename - Download generated roll no slips PDF
router.get('/rollno-slips/download/:filename', pdfDownloadAuth, async (req, res) => {
  const { filename } = req.params;
  if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  const filePath = path.join(pdfStorageDir('rollno'), filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  res.download(filePath, filename);
});

module.exports = router;
