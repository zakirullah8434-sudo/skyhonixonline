const express = require('express');
const router = express.Router();
const { authenticateToken } = require('./auth');
const { querySchool, querySchoolOne, runSchool } = require('../database_manager');

// GET /attendance/students - Get attendance grid for a class/section on a specific date
router.get('/students', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { class_name, section_name, date } = req.query;

  if (!class_name || !date) {
    return res.status(400).json({ error: 'class_name and date are required' });
  }

  try {
    // 1. Get all active students in class/section
    let studentsQuery = "SELECT id, name, roll_no, class_name, section_name, photo FROM students WHERE class_name = ? AND (status IS NULL OR status != 'Left')";
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

    // 2. Get attendance logs for this class/section on the date
    let attQuery = "SELECT student_id, status, time FROM attendance WHERE class_name = ? AND date = ?";
    const attParams = [class_name, date];

    if (section_name) {
      if (section_name === 'No Section') {
        attQuery += " AND (section_name IS NULL OR section_name = '')";
      } else {
        attQuery += " AND section_name = ?";
        attParams.push(section_name);
      }
    }

    const logs = await querySchool(schoolId, attQuery, attParams);
    const logsMap = {};
    logs.forEach(log => {
      logsMap[log.student_id] = { status: log.status, time: log.time };
    });

    // 3. Merge attendance log with student info
    const grid = students.map(student => {
      const log = logsMap[student.id] || { status: 'Unmarked', time: '' };
      return {
        id: student.id,
        name: student.name,
        roll_no: student.roll_no,
        class_name: student.class_name,
        section_name: student.section_name,
        photo: student.photo,
        status: log.status,
        time: log.time
      };
    });

    res.json(grid);
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve attendance grid: ' + err.message });
  }
});

// POST /attendance/save - Bulk save/mark attendance
router.post('/save', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { date, attendanceList } = req.body; // attendanceList: [{student_id, class_name, section_name, status, time}]

  if (!date || !attendanceList || !Array.isArray(attendanceList)) {
    return res.status(400).json({ error: 'date and attendanceList are required' });
  }

  try {
    for (const record of attendanceList) {
      await runSchool(
        schoolId,
        `INSERT OR REPLACE INTO attendance (student_id, class_name, section_name, date, status, time)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          record.student_id,
          record.class_name,
          record.section_name || '',
          date,
          record.status,
          record.time || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        ]
      );
    }
    res.json({ message: 'Attendance saved successfully!' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save attendance: ' + err.message });
  }
});

// POST /attendance/scan - Register attendance via QR Scanner (Webcam scan in browser)
router.post('/scan', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { scanValue, date } = req.body; // scanValue could be student_id (ST-...) or roll_no, or simple number

  if (!scanValue) {
    return res.status(400).json({ error: 'Scan value is required' });
  }

  const currentDate = date || new Date().toISOString().split('T')[0];
  const currentTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  try {
    // 1. Find student by student_id or roll_no
    let student = await querySchoolOne(
      schoolId,
      "SELECT * FROM students WHERE (student_id = ? OR roll_no = ? OR id = ?) AND (status IS NULL OR status != 'Left')",
      [scanValue, scanValue, scanValue]
    );

    // If not found, try stripping prefix or matching name (but strict ID/Roll is best)
    if (!student) {
      return res.status(404).json({ error: `Student with code '${scanValue}' not found` });
    }

    // 2. Insert or replace attendance
    await runSchool(
      schoolId,
      `INSERT OR REPLACE INTO attendance (student_id, class_name, section_name, date, status, time)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [student.id, student.class_name, student.section_name || '', currentDate, 'Present', currentTime]
    );

    res.json({
      message: `${student.name} marked PRESENT`,
      student: {
        id: student.id,
        name: student.name,
        roll_no: student.roll_no,
        class_name: student.class_name,
        section_name: student.section_name,
        photo: student.photo,
        time: currentTime
      }
    });

  } catch (err) {
    res.status(500).json({ error: 'QR Scan failed: ' + err.message });
  }
});

// GET /attendance/history - Get monthly attendance matrix for analytics
router.get('/history', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { class_name, month_year } = req.query; // month_year format: YYYY-MM

  if (!class_name || !month_year) {
    return res.status(400).json({ error: 'class_name and month_year are required' });
  }

  try {
    // Select all logs in that month for the class
    const logs = await querySchool(
      schoolId,
      `SELECT a.student_id, s.name, s.roll_no, a.date, a.status, a.time
       FROM attendance a
       JOIN students s ON s.id = a.student_id
       WHERE a.class_name = ? AND a.date LIKE ?
       ORDER BY a.date, CAST(s.roll_no AS INTEGER)`,
      [class_name, `${month_year}-%`]
    );

    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch attendance history: ' + err.message });
  }
});

// GET /attendance/analytics - Quick dashboard statistics
router.get('/analytics', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const date = req.query.date || new Date().toISOString().split('T')[0];

  try {
    const stats = await querySchool(
      schoolId,
      `SELECT status, COUNT(*) as count 
       FROM attendance 
       WHERE date = ? 
       GROUP BY status`,
      [date]
    );

    const totalStudents = await querySchoolOne(
      schoolId,
      "SELECT COUNT(*) as count FROM students WHERE status IS NULL OR status != 'Left'"
    );

    res.json({
      date,
      stats,
      totalActiveStudents: totalStudents ? totalStudents.count : 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
