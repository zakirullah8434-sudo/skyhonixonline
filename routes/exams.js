const express = require('express');
const router = express.Router();
const { authenticateToken } = require('./auth');
const { querySchool, querySchoolOne, runSchool, runSchoolTransaction } = require('../database_manager');

// GET /exams - Get list of exams
router.get('/', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  try {
    const exams = await querySchool(schoolId, 'SELECT * FROM exams ORDER BY year DESC, id DESC');
    res.json(exams);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /exams - Create an exam
router.post('/', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { exam_name, year } = req.body;

  if (!exam_name || !year) {
    return res.status(400).json({ error: 'exam_name and year are required' });
  }

  try {
    const result = await runSchool(
      schoolId,
      'INSERT INTO exams (exam_name, year) VALUES (?, ?)',
      [exam_name, parseInt(year)]
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

  if (!exam_id || !class_name || !term) {
    return res.status(400).json({ error: 'exam_id, class_name, and term are required' });
  }

  try {
    const subjects = await querySchool(
      schoolId,
      'SELECT * FROM exam_subjects WHERE exam_id = ? AND class = ? AND term = ? ORDER BY subject',
      [parseInt(exam_id), class_name, term]
    );
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
        // Upsert marks
        await runSchool(
          schoolId,
          `INSERT INTO marks (student_id, exam_id, subject, marks, term)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(student_id, exam_id, subject, term) DO UPDATE SET marks = excluded.marks`,
          // Wait, SQLite doesn't have a unique constraint on marks(student_id, exam_id, subject, term) in the original schema!
          // Ah, is there a unique index in the marks table? Let's check:
          // The database schema created: CREATE TABLE IF NOT EXISTS marks (id INTEGER PRIMARY KEY AUTOINCREMENT, student_id INTEGER, exam_id INTEGER, subject TEXT, marks INTEGER, term TEXT DEFAULT '1st Term')
          // No unique index was defined!
          // So we should delete the existing record first and insert to avoid duplicate marks!
        );
        // Let's safe-insert:
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
    }
    res.json({ message: 'Marks saved successfully!' });
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

    res.json({ message: 'Result calculations completed successfully!' });
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

    // 2. Get overall calculated result summary
    const summary = await querySchoolOne(
      schoolId,
      'SELECT total, obtained, percentage, grade, position, remarks FROM results WHERE student_id = ? AND exam_id = ? AND term = ?',
      [studentId, parseInt(exam_id), term]
    );

    if (!summary) {
      return res.status(404).json({ error: 'Results have not been calculated yet. Go to Result Calculator first.' });
    }

    // 3. Get list of subjects
    const subjects = await querySchool(
      schoolId,
      'SELECT subject, max_marks FROM exam_subjects WHERE exam_id = ? AND class = ? AND term = ? ORDER BY subject',
      [parseInt(exam_id), student.class_name, term]
    );

    // 4. Get student's individual marks per subject
    const marks = await querySchool(
      schoolId,
      'SELECT subject, marks FROM marks WHERE student_id = ? AND exam_id = ? AND term = ?',
      [studentId, parseInt(exam_id), term]
    );

    const marksMap = {};
    marks.forEach(m => {
      marksMap[m.subject.toUpperCase()] = m.marks;
    });

    const reportDetails = subjects.map(sub => {
      const obMarks = marksMap[sub.subject.toUpperCase()] !== undefined ? marksMap[sub.subject.toUpperCase()] : 0;
      const status = obMarks >= (sub.max_marks * 0.33) ? 'Pass' : 'Fail'; // Standard 33% passing rule
      return {
        subject: sub.subject,
        max_marks: sub.max_marks,
        obtained_marks: obMarks,
        status
      };
    });

    res.json({
      student,
      summary,
      reportDetails
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
