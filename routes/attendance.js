const express = require('express');
const router = express.Router();
const { authenticateToken } = require('./auth');
const { querySchool, querySchoolOne, runSchool, runSchoolTransaction } = require('../database_manager');

// Ensure holidays table exists (defensive migration for existing databases)
async function ensureHolidaysTable(schoolId) {
  await runSchool(schoolId, `
    CREATE TABLE IF NOT EXISTS holidays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT DEFAULT 'Holiday',
      school_id INTEGER
    )
  `);
  await runSchool(schoolId, `CREATE UNIQUE INDEX IF NOT EXISTS idx_holidays_date ON holidays (date)`);
}

// Ensure attendance_reports table exists (defensive migration for existing databases)
async function ensureAttendanceReportsTable(schoolId) {
  await runSchool(schoolId, `
    CREATE TABLE IF NOT EXISTS attendance_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_name TEXT NOT NULL,
      section_name TEXT,
      month TEXT NOT NULL,
      total_school_days INTEGER,
      prev_school_days INTEGER,
      holidays_count INTEGER,
      report_data TEXT,
      school_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(class_name, section_name, month, school_id)
    )
  `);
}

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
      const time = record.time || new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
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
  const { scanValue, date, time } = req.body;

  if (!scanValue) {
    return res.status(400).json({ error: 'Scan value is required' });
  }

  // Clean the scan value: trim, decode URL encoding, handle common QR artifacts
  let cleaned = scanValue.trim();
  try { cleaned = decodeURIComponent(cleaned); } catch(e) {}
  cleaned = cleaned.trim();

  const currentDate = date || new Date().toISOString().split('T')[0];
  const currentTime = time || new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });

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

    // Check if attendance already marked today for this student
    const existing = await querySchoolOne(
      schoolId,
      "SELECT id, time, status FROM attendance WHERE student_id = ? AND date = ?",
      [student.id, currentDate]
    );

    if (existing) {
      return res.json({
        alreadyMarked: true,
        message: `${student.name} attendance already marked today at ${existing.time} (${existing.status})`,
        student: {
          id: student.id,
          name: student.name,
          roll_no: student.roll_no,
          class_name: student.class_name,
          section_name: student.section_name,
          photo: student.photo,
          time: existing.time,
          status: existing.status
        }
      });
    }

    // Insert attendance
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
    await ensureHolidaysTable(schoolId);
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
    await ensureHolidaysTable(schoolId);
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
    await ensureHolidaysTable(schoolId);
    await runSchool(schoolId, "DELETE FROM holidays WHERE id = ?", [id]);
    res.json({ message: 'Holiday removed!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper: Calculate school days and attendance for a given month
async function calcMonthAttendance(schoolId, class_name, section_name, targetMonth, holidayDates) {
  const year = parseInt(targetMonth.split('-')[0]);
  const mon = parseInt(targetMonth.split('-')[1]);
  const daysInMonth = new Date(year, mon, 0).getDate();
  const monthEnd = targetMonth + '-31';
  const today = new Date().toISOString().split('T')[0];
  const effectiveEnd = (monthEnd > today) ? today : monthEnd;

  let totalSchoolDays = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const dayStr = `${targetMonth}-${String(d).padStart(2, '0')}`;
    if (dayStr > effectiveEnd) break;
    if (!holidayDates.has(dayStr)) {
      const dow = new Date(dayStr).getDay();
      if (dow !== 0) { totalSchoolDays++; }
    }
  }

  // Get attendance logs for this month
  let attQuery = `SELECT student_id, status FROM attendance 
                   WHERE class_name = ? AND date >= ? AND date <= ?
                   AND (status = 'Present' OR status = 'Late')`;
  const attParams = [class_name, targetMonth + '-01', effectiveEnd];
  if (section_name) {
    if (section_name === 'No Section') {
      attQuery += " AND (section_name IS NULL OR section_name = '')";
    } else {
      attQuery += " AND section_name = ?";
      attParams.push(section_name);
    }
  }
  const logs = await querySchool(schoolId, attQuery, attParams);

  // Get absent logs
  let absentQuery = `SELECT student_id, COUNT(*) as absent_count FROM attendance 
                     WHERE class_name = ? AND date >= ? AND date <= ? AND status = 'Absent'`;
  const absentParams = [class_name, targetMonth + '-01', effectiveEnd];
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
  const absentMap = {};
  absentLogs.forEach(a => { absentMap[a.student_id] = a.absent_count; });

  // Build per-student counts
  const studentData = {};
  logs.forEach(log => {
    if (!studentData[log.student_id]) {
      studentData[log.student_id] = { total_present: 0, total_late: 0, total_attendance_count: 0 };
    }
    if (log.status === 'Present') {
      studentData[log.student_id].total_present++;
      studentData[log.student_id].total_attendance_count += 2;
    } else if (log.status === 'Late') {
      studentData[log.student_id].total_late++;
      studentData[log.student_id].total_attendance_count += 2;
    }
  });

  // Attach absent counts
  Object.keys(absentMap).forEach(sid => {
    if (studentData[sid]) studentData[sid].total_absent = absentMap[sid];
  });

  return { totalSchoolDays, studentData };
}

// GET /attendance/total - Calculate total attendance for current and previous months
// Query params: class_name, section_name (optional), month (YYYY-MM, optional, defaults to current month)
router.get('/total', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { class_name, section_name, month } = req.query;

  if (!class_name) {
    return res.status(400).json({ error: 'class_name is required' });
  }

  try {
    await ensureHolidaysTable(schoolId);
    const sessionRow = await querySchoolOne(schoolId, "SELECT value FROM settings WHERE key = 'session_start_date'");
    const sessionStart = sessionRow ? sessionRow.value : null;

    const targetMonth = month || new Date().toISOString().slice(0, 7);

    // Compute previous month
    const [tYear, tMon] = targetMonth.split('-').map(Number);
    const prevDate = new Date(tYear, tMon - 2, 1);
    const prevMonth = prevDate.toISOString().slice(0, 7);

    // Get all holidays (broader range to cover both months)
    const fromDate = sessionStart || prevMonth + '-01';
    const monthEnd = targetMonth + '-31';
    const holidays = await querySchool(
      schoolId,
      "SELECT date FROM holidays WHERE date >= ? AND date <= ?",
      [fromDate, monthEnd]
    );
    const holidayDates = new Set(holidays.map(h => h.date));

    // Get all active students
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

    // Calculate for current month
    const currentMonthData = await calcMonthAttendance(schoolId, class_name, section_name, targetMonth, holidayDates);
    // Calculate for previous month
    const prevMonthData = await calcMonthAttendance(schoolId, class_name, section_name, prevMonth, holidayDates);

    // Build combined result
    const result = students.map(s => {
      const cur = currentMonthData.studentData[s.id] || { total_present: 0, total_late: 0, total_attendance_count: 0, total_absent: 0 };
      const prev = prevMonthData.studentData[s.id] || { total_present: 0, total_late: 0, total_attendance_count: 0, total_absent: 0 };
      return {
        student_id: s.id,
        name: s.name,
        roll_no: s.roll_no,
        class_name: s.class_name,
        section_name: s.section_name,
        current_present: cur.total_present,
        current_late: cur.total_late,
        current_attendance: cur.total_attendance_count,
        current_absent: cur.total_absent || 0,
        prev_present: prev.total_present,
        prev_late: prev.total_late,
        prev_attendance: prev.total_attendance_count,
        prev_absent: prev.total_absent || 0,
        total_attendance: cur.total_attendance_count + prev.total_attendance_count
      };
    });

    res.json({
      session_start_date: sessionStart,
      current_month: targetMonth,
      previous_month: prevMonth,
      current_school_days: currentMonthData.totalSchoolDays,
      prev_school_days: prevMonthData.totalSchoolDays,
      holidays_count: holidayDates.size,
      students: result
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to calculate total attendance: ' + err.message });
  }
});

// POST /attendance/save-report - Save a monthly attendance report snapshot
router.post('/save-report', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { class_name, section_name, month, total_school_days, prev_school_days, holidays_count, report_data } = req.body;

  if (!class_name || !month || !report_data) {
    return res.status(400).json({ error: 'class_name, month, and report_data are required' });
  }

  try {
    await ensureAttendanceReportsTable(schoolId);
    await runSchool(schoolId, "DELETE FROM attendance_reports WHERE class_name = ? AND section_name = ? AND month = ? AND school_id = ?",
      [class_name, section_name || '', month, schoolId]);
    await runSchool(schoolId,
      `INSERT INTO attendance_reports (class_name, section_name, month, total_school_days, prev_school_days, holidays_count, report_data, school_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [class_name, section_name || '', month, total_school_days || 0, prev_school_days || 0, holidays_count || 0, JSON.stringify(report_data), schoolId]
    );
    res.json({ message: 'Attendance report saved successfully!' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save report: ' + err.message });
  }
});

// GET /attendance/saved-reports - List saved reports, optionally filtered by month
router.get('/saved-reports', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { class_name, section_name, month } = req.query;

  try {
    await ensureAttendanceReportsTable(schoolId);
    let query = "SELECT * FROM attendance_reports WHERE school_id = ?";
    const params = [schoolId];

    if (class_name) {
      query += " AND class_name = ?";
      params.push(class_name);
    }
    if (section_name) {
      query += " AND section_name = ?";
      params.push(section_name);
    }
    if (month) {
      query += " AND month = ?";
      params.push(month);
    }
    query += " ORDER BY month DESC";

    const reports = await querySchool(schoolId, query, params);
    // Parse report_data JSON
    reports.forEach(r => {
      try { r.report_data = JSON.parse(r.report_data); } catch(e) { r.report_data = []; }
    });
    res.json(reports);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch reports: ' + err.message });
  }
});

// DELETE /attendance/saved-reports/:id - Remove a saved report
router.delete('/saved-reports/:id', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { id } = req.params;
  try {
    await ensureAttendanceReportsTable(schoolId);
    await runSchool(schoolId, "DELETE FROM attendance_reports WHERE id = ? AND school_id = ?", [id, schoolId]);
    res.json({ message: 'Report removed!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
