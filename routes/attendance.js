const express = require('express');
const router = express.Router();
const { authenticateToken } = require('./auth');
const { querySchool, querySchoolOne, runSchool, runSchoolTransaction } = require('../database_manager');

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
    const statements = [];
    for (const record of attendanceList) {
      const time = record.time || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      statements.push({
        sql: 'DELETE FROM attendance WHERE student_id = ? AND date = ?',
        params: [record.student_id, date]
      });
      statements.push({
        sql: `INSERT INTO attendance (student_id, class_name, section_name, date, status, time, school_id)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        params: [record.student_id, record.class_name, record.section_name || '', date, record.status, time, schoolId]
      });
    }
    await runSchoolTransaction(schoolId, statements);
    res.json({ message: 'Attendance saved successfully!' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save attendance: ' + err.message });
  }
});

// POST /attendance/scan - Register attendance via QR Scanner (Webcam scan in browser)
router.post('/scan', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { scanValue, date } = req.body;

  if (!scanValue) {
    return res.status(400).json({ error: 'Scan value is required' });
  }

  // Clean the scan value: trim, decode URL encoding, handle common QR artifacts
  let cleaned = scanValue.trim();
  try { cleaned = decodeURIComponent(cleaned); } catch(e) {}
  cleaned = cleaned.trim();

  const currentDate = date || new Date().toISOString().split('T')[0];
  const currentTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  try {
    // Try exact match first, then numeric id match
    let student = await querySchoolOne(
      schoolId,
      "SELECT * FROM students WHERE (student_id = ? OR roll_no = ?) AND (status IS NULL OR status != 'Left')",
      [cleaned, cleaned]
    );

    // If not found and it's numeric, try matching by id
    if (!student && !isNaN(cleaned)) {
      student = await querySchoolOne(
        schoolId,
        "SELECT * FROM students WHERE id = ? AND (status IS NULL OR status != 'Left')",
        [parseInt(cleaned)]
      );
    }

    // If still not found, try case-insensitive student_id match
    if (!student) {
      student = await querySchoolOne(
        schoolId,
        "SELECT * FROM students WHERE UPPER(student_id) = UPPER(?) AND (status IS NULL OR status != 'Left')",
        [cleaned]
      );
    }

    if (!student) {
      return res.status(404).json({ error: `Student with code '${cleaned}' not found. Check that the QR code contains a valid Student ID.` });
    }

    // Insert or replace attendance
    await runSchool(schoolId, `DELETE FROM attendance WHERE student_id = ? AND date = ?`, [student.id, currentDate]);
    await runSchool(
      schoolId,
      `INSERT INTO attendance (student_id, class_name, section_name, date, status, time, school_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [student.id, student.class_name, student.section_name || '', currentDate, 'Present', currentTime, schoolId]
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
    console.error('[QR Scan] Error:', err);
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

// GET /attendance/session-info - Get session start date
router.get('/session-info', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  try {
    const row = await querySchoolOne(schoolId, "SELECT value FROM settings WHERE key = 'session_start_date'");
    res.json({ session_start_date: row ? row.value : '' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /attendance/session-info - Set session start date
router.post('/session-info', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { session_start_date } = req.body;
  try {
    await runSchool(schoolId, "DELETE FROM settings WHERE key = 'session_start_date'");
    if (session_start_date) {
      await runSchool(schoolId, "INSERT INTO settings (key, value) VALUES ('session_start_date', ?)", [session_start_date]);
    }
    res.json({ message: 'Session start date updated!', session_start_date: session_start_date || '' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /attendance/holidays - List all holidays
router.get('/holidays', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  try {
    const holidays = await querySchool(schoolId, "SELECT * FROM holidays ORDER BY date DESC");
    res.json(holidays);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /attendance/holidays - Add a holiday
router.post('/holidays', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { date, name, type } = req.body;

  if (!date || !name) {
    return res.status(400).json({ error: 'Date and Name are required' });
  }

  try {
    await runSchool(
      schoolId,
      `INSERT OR REPLACE INTO holidays (date, name, type, school_id) VALUES (?, ?, ?, ?)`,
      [date, name, type || 'Holiday', schoolId]
    );
    res.json({ message: 'Holiday marked successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /attendance/holidays/:id - Remove a holiday
router.delete('/holidays/:id', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { id } = req.params;
  try {
    await runSchool(schoolId, "DELETE FROM holidays WHERE id = ?", [id]);
    res.json({ message: 'Holiday removed!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /attendance/total - Calculate total attendance from session start to given month
// Each Present day = 2 attendance counts (morning + afternoon session)
// Query params: class_name, section_name (optional), month (YYYY-MM, optional, defaults to current month)
router.get('/total', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { class_name, section_name, month } = req.query;

  if (!class_name) {
    return res.status(400).json({ error: 'class_name is required' });
  }

  try {
    // 1. Get session start date from settings
    const sessionRow = await querySchoolOne(schoolId, "SELECT value FROM settings WHERE key = 'session_start_date'");
    const sessionStart = sessionRow ? sessionRow.value : null;

    // 2. Determine date range
    const targetMonth = month || new Date().toISOString().slice(0, 7); // YYYY-MM
    const monthEnd = targetMonth + '-31';
    const fromDate = sessionStart || (targetMonth + '-01');

    // 3. Get all active students for the class
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

    // 4. Get holidays in the range
    const holidays = await querySchool(
      schoolId,
      "SELECT date FROM holidays WHERE date >= ? AND date <= ?",
      [fromDate, monthEnd]
    );
    const holidayDates = new Set(holidays.map(h => h.date));

    // 5. Get attendance logs from session start to month end for this class
    let attQuery = `SELECT student_id, date, status FROM attendance 
                     WHERE class_name = ? AND date >= ? AND date <= ?
                     AND (status = 'Present' OR status = 'Late')`;
    const attParams = [class_name, fromDate, monthEnd];
    if (section_name) {
      if (section_name === 'No Section') {
        attQuery += " AND (section_name IS NULL OR section_name = '')";
      } else {
        attQuery += " AND section_name = ?";
        attParams.push(section_name);
      }
    }
    const logs = await querySchool(schoolId, attQuery, attParams);

    // 6. Calculate total school days (excluding holidays) in the target month
    // Count days from 1st of target month to end of month (or today if current month)
    const year = parseInt(targetMonth.split('-')[0]);
    mon = parseInt(targetMonth.split('-')[1]);
    const daysInMonth = new Date(year, mon, 0).getDate();
    const today = new Date().toISOString().split('T')[0];
    const effectiveEnd = (monthEnd > today) ? today : monthEnd;

    let totalSchoolDays = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const dayStr = `${targetMonth}-${String(d).padStart(2, '0')}`;
      if (dayStr > effectiveEnd) break;
      if (!holidayDates.has(dayStr)) {
        // Check if it's a weekday (Mon-Sat, 0=Sun, 6=Sat)
        const dow = new Date(dayStr).getDay();
        if (dow !== 0) { // Exclude Sundays
          totalSchoolDays++;
        }
      }
    }

    // 7. Build per-student attendance summary
    const studentMap = {};
    students.forEach(s => {
      studentMap[s.id] = {
        student_id: s.id,
        name: s.name,
        roll_no: s.roll_no,
        class_name: s.class_name,
        section_name: s.section_name,
        total_present: 0,
        total_late: 0,
        total_attendance_count: 0, // Present days * 2
        total_absent: 0,
        total_leaves: 0
      };
    });

    // Count present/late per student
    logs.forEach(log => {
      if (studentMap[log.student_id]) {
        if (log.status === 'Present') {
          studentMap[log.student_id].total_present++;
          studentMap[log.student_id].total_attendance_count += 2;
        } else if (log.status === 'Late') {
          studentMap[log.student_id].total_late++;
          studentMap[log.student_id].total_attendance_count += 2;
        }
      }
    });

    // Calculate absent = total school days - present - late
    // Also count actual absent records (status = 'Absent') for reference
    let absentQuery = `SELECT student_id, COUNT(*) as absent_count FROM attendance 
                       WHERE class_name = ? AND date >= ? AND date <= ? AND status = 'Absent'`;
    const absentParams = [class_name, fromDate, monthEnd];
    if (section_name) {
      if (section_name === 'No Section') {
        absentQuery += " AND (section_name IS NULL OR section_name = '')";
      } else {
        absentQuery += " AND section_name = ?";
        absentParams.push(section_name);
      }
    }
    absentQuery += " GROUP BY student_id";
    const absentLogs = await querySchool(schoolId, absentQuery, absentParams);
    absentLogs.forEach(a => {
      if (studentMap[a.student_id]) {
        studentMap[a.student_id].total_absent = a.absent_count;
      }
    });

    const result = Object.values(studentMap);

    res.json({
      session_start_date: sessionStart,
      month: targetMonth,
      total_school_days: totalSchoolDays,
      holidays_count: holidayDates.size,
      students: result
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to calculate total attendance: ' + err.message });
  }
});

module.exports = router;
