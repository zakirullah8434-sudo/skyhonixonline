const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { authenticateToken } = require('./auth');
const { querySchool, querySchoolOne, runSchool } = require('../database_manager');

// Lazy migration: add Staff Entry columns (role, staff_id, salary) to teachers
let staffColumnsEnsured = false;
async function ensureStaffColumns(schoolId) {
  if (staffColumnsEnsured) return;
  for (const ddl of [
    `ALTER TABLE teachers ADD COLUMN role TEXT DEFAULT 'Teacher'`,
    `ALTER TABLE teachers ADD COLUMN staff_id TEXT DEFAULT ''`,
    `ALTER TABLE teachers ADD COLUMN salary REAL DEFAULT 0`
  ]) {
    try { await runSchool(schoolId, ddl); } catch (e) { /* column already exists */ }
  }
  staffColumnsEnsured = true;
}

// Ensure salary structure table exists so staff salary connects to Salary Management
async function ensureSalaryTable(schoolId) {
  try {
    await runSchool(schoolId, `CREATE TABLE IF NOT EXISTS teacher_salaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, teacher_id INTEGER NOT NULL, basic_salary REAL DEFAULT 0,
      house_allowance REAL DEFAULT 0, medical_allowance REAL DEFAULT 0, transport_allowance REAL DEFAULT 0,
      other_allowances REAL DEFAULT 0, deductions REAL DEFAULT 0, tax REAL DEFAULT 0,
      effective_date TEXT, school_id INTEGER, created_at TEXT DEFAULT (datetime('now'))
    )`);
  } catch (e) { /* ignore */ }
}

// Sync the staff monthly salary into teacher_salaries so Salary Management shows it
async function syncSalaryToSetup(schoolId, teacherId, salary) {
  if (!teacherId || salary === undefined || salary === null || isNaN(Number(salary))) return;
  try {
    await ensureSalaryTable(schoolId);
    const existing = await querySchoolOne(schoolId, 'SELECT id FROM teacher_salaries WHERE teacher_id = ?', [teacherId]);
    if (existing) {
      await runSchool(schoolId,
        `UPDATE teacher_salaries SET basic_salary=?, effective_date=datetime('now') WHERE teacher_id=?`,
        [Number(salary) || 0, teacherId]);
    } else {
      await runSchool(schoolId,
        `INSERT INTO teacher_salaries (teacher_id, basic_salary, effective_date, school_id)
         VALUES (?, ?, datetime('now'), ?)`,
        [teacherId, Number(salary) || 0, schoolId]);
    }
  } catch (e) { console.error('[STAFF_SALARY_SYNC]', e.message); }
}

// ==========================================
// TEACHERS CRUD
// ==========================================

// GET /staff/teachers - List all teachers with their timetable assignments (single query, no N+1)
router.get('/teachers', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  await ensureStaffColumns(schoolId);
  if (req.query.lite === 'true') {
    try {
      const teachers = await querySchool(schoolId,
        `SELECT id, name, phone, subject, qualification, status, assigned_class, can_collect_fees, role, staff_id, salary FROM teachers WHERE (school_id = ? OR school_id IS NULL) ORDER BY name`,
        [schoolId]
      );
      return res.json(teachers);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
  try {
    const rows = await querySchool(schoolId,
      `SELECT t.id, t.name, t.phone, t.subject, t.qualification, t.status, t.created_at, t.assigned_class, t.can_collect_fees,
              t.role, t.staff_id, t.salary,
              tm.class_name, tm.section_name, tm.subject as tm_subject, tm.day, tm.start_time, tm.end_time
       FROM teachers t
       LEFT JOIN timetable tm ON tm.teacher_id = t.id
       ORDER BY t.name, tm.class_name, tm.section_name`
    );

    // Group timetable assignments by teacher
    const teacherMap = new Map();
    for (const row of rows) {
      if (!teacherMap.has(row.id)) {
        teacherMap.set(row.id, {
          id: row.id, name: row.name, phone: row.phone, subject: row.subject,
          qualification: row.qualification, status: row.status, created_at: row.created_at,
          assigned_class: row.assigned_class, can_collect_fees: row.can_collect_fees,
          role: row.role, staff_id: row.staff_id, salary: row.salary,
          assignments: []
        });
      }
      if (row.class_name) {
        teacherMap.get(row.id).assignments.push({
          class_name: row.class_name, section_name: row.section_name,
          subject: row.tm_subject, day: row.day, start_time: row.start_time, end_time: row.end_time
        });
      }
    }

    res.json(Array.from(teacherMap.values()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /staff/teachers - Create a new teacher/staff member
router.post('/teachers', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { name, phone, password, subject, qualification, assigned_class, can_collect_fees, role, staff_id, salary } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Staff name is required' });
  }

  try {
    await ensureStaffColumns(schoolId);

    // Phone is optional for non-teaching staff (Principal, Accountant, Class 4, etc.)
    // Generate a unique placeholder so the UNIQUE NOT NULL constraint holds and
    // they simply cannot log in to the teacher portal unless a real phone is set.
    let finalPhone = (phone || '').trim();
    if (!finalPhone) {
      finalPhone = 'staff-' + Date.now() + '-' + Math.floor(Math.random() * 10000);
    } else {
      const existing = await querySchoolOne(schoolId, 'SELECT id FROM teachers WHERE phone = ?', [finalPhone]);
      if (existing) {
        return res.status(409).json({ error: 'A staff member with this phone number already exists' });
      }
    }

    const finalRole = (role || 'Teacher').trim();
    // Non-teaching staff don't get portal login unless a password is supplied
    const hashedPassword = await bcrypt.hash(password || ('nopass-' + Date.now()), 10);
    const result = await runSchool(schoolId,
      `INSERT INTO teachers (name, phone, password, subject, qualification, status, school_id, created_at, assigned_class, can_collect_fees, role, staff_id, salary)
       VALUES (?, ?, ?, ?, ?, 'Active', ?, ?, ?, ?, ?, ?, ?)`,
      [name, finalPhone, hashedPassword, subject || '', qualification || '', schoolId, new Date().toISOString().slice(0, 19).replace('T', ' '),
       assigned_class || '', can_collect_fees ? 1 : 0, finalRole, (staff_id || '').trim(), Number(salary) || 0]
    );

    // Connect salary to Salary Management so it appears in salary setup & payments
    if (Number(salary) > 0) {
      await syncSalaryToSetup(schoolId, result.id, salary);
    }

    res.json({ id: result.id, message: finalRole + ' added successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /staff/teachers/:id - Update teacher
router.put('/teachers/:id', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { id } = req.params;
  const { name, phone, subject, qualification, status, password, assigned_class, can_collect_fees, role, staff_id, salary } = req.body;

  try {
    await ensureStaffColumns(schoolId);

    // Preserve existing role/staff_id/salary when the caller (e.g. Assign
    // Teachers form) doesn't send them, so staff metadata isn't wiped.
    let preservedRole = 'Teacher', preservedStaffId = '', preservedSalary = 0;
    if (role === undefined || staff_id === undefined || salary === undefined) {
      const cur = await querySchoolOne(schoolId, 'SELECT role, staff_id, salary FROM teachers WHERE id = ?', [id]);
      if (cur) {
        preservedRole = cur.role || 'Teacher';
        preservedStaffId = cur.staff_id || '';
        preservedSalary = cur.salary || 0;
      }
    }

    let query = `UPDATE teachers SET name=?, phone=?, subject=?, qualification=?, status=?, assigned_class=?, can_collect_fees=?, role=?, staff_id=?, salary=?`;
    let params = [name, phone, subject || '', qualification || '', status || 'Active', assigned_class || '', can_collect_fees ? 1 : 0,
                  (role !== undefined ? role : preservedRole) || 'Teacher',
                  (staff_id !== undefined ? staff_id : preservedStaffId) || '',
                  Number(salary !== undefined ? salary : preservedSalary) || 0];

    if (password) {
      const hashedPassword = await bcrypt.hash(password, 10);
      query += `, password=?`;
      params.push(hashedPassword);
    }

    query += ` WHERE id=?`;
    params.push(id);

    await runSchool(schoolId, query, params);

    // Keep Salary Management in sync when salary is edited
    if (salary !== undefined) {
      await syncSalaryToSetup(schoolId, id, salary);
    }

    res.json({ message: 'Staff updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /staff/teachers/:id - Delete teacher
router.delete('/teachers/:id', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { id } = req.params;

  try {
    await runSchool(schoolId, 'DELETE FROM teachers WHERE id=?', [id]);
    res.json({ message: 'Teacher deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// PARENTS CRUD
// ==========================================

// GET /staff/parents - List all parents with their linked children (by link table OR phone match)
router.get('/parents', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  try {
    const parents = await querySchool(schoolId,
      `SELECT p.id, p.name, p.phone, p.status, p.created_at,
              GROUP_CONCAT(DISTINCT s.name) as children
       FROM parents p
       LEFT JOIN student_parents sp ON sp.parent_id = p.id
       LEFT JOIN students s ON (s.id = sp.student_id OR s.phone = p.phone) AND (s.status IS NULL OR s.status != 'Left')
       GROUP BY p.id
       ORDER BY p.name`
    );
    res.json(parents);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /staff/parents - Create a new parent
router.post('/parents', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { name, phone, password } = req.body;

  if (!phone || !password) {
    return res.status(400).json({ error: 'Phone and password are required' });
  }

  try {
    const existing = await querySchoolOne(schoolId, 'SELECT id FROM parents WHERE phone = ?', [phone]);
    if (existing) {
      return res.status(409).json({ error: 'A parent with this phone number already exists' });
    }

    // Auto-find students with this phone to get parent name
    const matchedStudents = await querySchool(schoolId,
      `SELECT DISTINCT father_name FROM students WHERE phone = ? AND father_name IS NOT NULL AND father_name != '' LIMIT 1`,
      [phone]
    );
    const parentName = name || (matchedStudents.length > 0 ? matchedStudents[0].father_name : 'Parent');

    const hashedPassword = await bcrypt.hash(password, 10);
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const result = await runSchool(schoolId,
      `INSERT INTO parents (name, phone, password, cnic, address, status, school_id, created_at)
       VALUES (?, ?, ?, '', '', 'Active', ?, ?)`,
      [parentName, phone, hashedPassword, schoolId, now]
    );

    // Auto-link all students with matching phone
    const students = await querySchool(schoolId,
      'SELECT id FROM students WHERE phone = ?', [phone]
    );
    for (const s of students) {
      await runSchool(schoolId,
        'INSERT OR IGNORE INTO student_parents (student_id, parent_id, relation, school_id) VALUES (?, ?, ?, ?)',
        [s.id, result.id, 'Father', schoolId]
      );
    }

    res.json({ id: result.id, message: `Parent created and linked to ${students.length} student(s)` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /staff/parents/create-with-student - Create parent linked to a specific student
router.post('/parents/create-with-student', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { student_id, phone, password } = req.body;

  if (!student_id || !phone || !password) {
    return res.status(400).json({ error: 'Student, phone, and password are required' });
  }

  try {
    // Check if parent already exists with this phone
    const existing = await querySchoolOne(schoolId, 'SELECT id FROM parents WHERE phone = ?', [phone]);
    if (existing) {
      return res.status(409).json({ error: 'A parent with this phone number already exists' });
    }

    // Get student info for parent name
    const student = await querySchoolOne(schoolId,
      'SELECT father_name FROM students WHERE id = ?', [student_id]
    );
    const parentName = (student && student.father_name) ? student.father_name : 'Parent';

    const hashedPassword = await bcrypt.hash(password, 10);
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const result = await runSchool(schoolId,
      `INSERT INTO parents (name, phone, password, cnic, address, status, school_id, created_at)
       VALUES (?, ?, ?, '', '', 'Active', ?, ?)`,
      [parentName, phone, hashedPassword, schoolId, now]
    );

    // Link the specific student to this parent
    await runSchool(schoolId,
      'INSERT OR IGNORE INTO student_parents (student_id, parent_id, relation, school_id) VALUES (?, ?, ?, ?)',
      [student_id, result.id, 'Father', schoolId]
    );

    // Also link any other students with matching phone
    const otherStudents = await querySchool(schoolId,
      'SELECT id FROM students WHERE phone = ? AND id != ?', [phone, student_id]
    );
    for (const s of otherStudents) {
      await runSchool(schoolId,
        'INSERT OR IGNORE INTO student_parents (student_id, parent_id, relation, school_id) VALUES (?, ?, ?, ?)',
        [s.id, result.id, 'Father', schoolId]
      );
    }

    res.json({ id: result.id, message: `Parent created and linked to student` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /staff/parents/:id - Update parent
router.put('/parents/:id', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { id } = req.params;
  const { name, phone, cnic, address, status, password } = req.body;

  try {
    let query = `UPDATE parents SET name=?, phone=?, cnic=?, address=?, status=?`;
    let params = [name, phone, cnic || '', address || '', status || 'Active'];

    if (password) {
      const hashedPassword = await bcrypt.hash(password, 10);
      query += `, password=?`;
      params.push(hashedPassword);
    }

    query += ` WHERE id=?`;
    params.push(id);

    await runSchool(schoolId, query, params);
    res.json({ message: 'Parent updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /staff/parents/:id - Delete parent
router.delete('/parents/:id', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { id } = req.params;

  try {
    await runSchool(schoolId, 'DELETE FROM student_parents WHERE parent_id=?', [id]);
    await runSchool(schoolId, 'DELETE FROM parents WHERE id=?', [id]);
    res.json({ message: 'Parent deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /staff/parents/assign - Link student to parent
router.post('/parents/assign', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { student_id, parent_id, relation } = req.body;

  if (!student_id || !parent_id) {
    return res.status(400).json({ error: 'student_id and parent_id are required' });
  }

  try {
    await runSchool(schoolId,
      `INSERT OR REPLACE INTO student_parents (student_id, parent_id, relation, school_id) VALUES (?, ?, ?, ?)`,
      [student_id, parent_id, relation || 'Father', schoolId]
    );
    res.json({ message: 'Student linked to parent successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /staff/parents/unassign - Unlink student from parent
router.delete('/parents/unassign', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { student_id, parent_id } = req.body;

  try {
    await runSchool(schoolId,
      'DELETE FROM student_parents WHERE student_id=? AND parent_id=?',
      [student_id, parent_id]
    );
    res.json({ message: 'Student unlinked from parent' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// TIMETABLE
// ==========================================

// GET /staff/timetable - Get timetable (optional class/section/teacher filter)
router.get('/timetable', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { class_name, section_name, teacher_id, all } = req.query;

  try {
    let query = `SELECT t.*, te.name as teacher_name
                 FROM timetable t
                 LEFT JOIN teachers te ON te.id = t.teacher_id`;
    const params = [];
    const conditions = [];

    if (class_name) {
      conditions.push(`t.class_name = ?`);
      params.push(class_name);
      if (section_name) {
        conditions.push(`t.section_name = ?`);
        params.push(section_name);
      }
    }
    if (teacher_id) {
      conditions.push(`t.teacher_id = ?`);
      params.push(parseInt(teacher_id));
    }

    if (conditions.length > 0) {
      query += ` WHERE ` + conditions.join(' AND ');
    }

    query += ` ORDER BY t.class_name, t.section_name, 
      CASE t.day 
        WHEN 'Monday' THEN 1 WHEN 'Tuesday' THEN 2 WHEN 'Wednesday' THEN 3
        WHEN 'Thursday' THEN 4 WHEN 'Friday' THEN 5 WHEN 'Saturday' THEN 6
      END, t.period`;

    const rows = await querySchool(schoolId, query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /staff/timetable - Save a timetable entry (upsert)
router.post('/timetable', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { class_name, section_name, day, period, start_time, end_time, subject, teacher_id, room } = req.body;

  if (!class_name || !day || period === undefined) {
    return res.status(400).json({ error: 'class_name, day, and period are required' });
  }

  try {
    const daysToSave = day === 'all' ? ['all'] : [day];

    for (const d of daysToSave) {
      await runSchool(schoolId,
        `INSERT OR REPLACE INTO timetable 
          (class_name, section_name, day, period, start_time, end_time, subject, teacher_id, room)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [class_name, section_name || '', d, period, start_time || '', end_time || '', subject || '', teacher_id || null, room || '']
      );
    }

    res.json({ message: `Timetable entry saved for ${day === 'all' ? 'all days' : day}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /staff/timetable/bulk - Save multiple timetable entries at once
router.post('/timetable/bulk', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { entries } = req.body;

  if (!entries || !Array.isArray(entries) || entries.length === 0) {
    return res.status(400).json({ error: 'entries array is required' });
  }

  try {
    for (const e of entries) {
      await runSchool(schoolId,
        `INSERT OR REPLACE INTO timetable 
          (class_name, section_name, day, period, start_time, end_time, subject, teacher_id, room)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [e.class_name, e.section_name || '', e.day, e.period, e.start_time || '', e.end_time || '', e.subject || '', e.teacher_id || null, e.room || '']
      );
    }
    res.json({ message: `${entries.length} timetable entries saved` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /staff/timetable/:id - Delete a timetable entry
router.delete('/timetable/:id', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { id } = req.params;

  try {
    await runSchool(schoolId, 'DELETE FROM timetable WHERE id=?', [id]);
    res.json({ message: 'Timetable entry deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /staff/timetable - Clear full timetable for a class (or all if no class specified)
router.delete('/timetable', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { class_name, section_name } = req.query;

  try {
    if (class_name) {
      let query = 'DELETE FROM timetable WHERE class_name = ?';
      const params = [class_name];
      if (section_name) {
        query += ' AND section_name = ?';
        params.push(section_name);
      }
      await runSchool(schoolId, query, params);
      res.json({ message: 'Timetable cleared for class' });
    } else {
      await runSchool(schoolId, 'DELETE FROM timetable', []);
      res.json({ message: 'All timetable entries cleared' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// ANNOUNCEMENTS CRUD
// ==========================================

// GET /staff/announcements - List all announcements
router.get('/announcements', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  try {
    const announcements = await querySchool(schoolId,
      `SELECT id, title, message, target_role, created_by, created_at
       FROM announcements ORDER BY created_at DESC`
    );
    res.json(announcements);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /staff/announcements - Create announcement
router.post('/announcements', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { title, message, target_role } = req.body;

  if (!title || !message) {
    return res.status(400).json({ error: 'Title and message are required' });
  }

  try {
    const result = await runSchool(schoolId,
      `INSERT INTO announcements (title, message, target_role, created_by, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [title, message, target_role || 'all', req.user.username || 'Admin', new Date().toISOString().slice(0, 19).replace('T', ' ')]
    );
    res.json({ id: result.id, message: 'Announcement posted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /staff/announcements/:id - Update announcement
router.put('/announcements/:id', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { id } = req.params;
  const { title, message, target_role } = req.body;

  try {
    await runSchool(schoolId,
      `UPDATE announcements SET title=?, message=?, target_role=? WHERE id=?`,
      [title, message, target_role || 'all', id]
    );
    res.json({ message: 'Announcement updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /staff/announcements/:id - Delete announcement
router.delete('/announcements/:id', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { id } = req.params;

  try {
    await runSchool(schoolId, 'DELETE FROM announcements WHERE id=?', [id]);
    res.json({ message: 'Announcement deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /staff/announcements/parent - Fetch announcements for parents portal
router.get('/announcements/parent', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  try {
    const announcements = await querySchool(schoolId,
      `SELECT id, title, message, target_role, created_by, created_at 
       FROM announcements WHERE target_role IN ('all', 'parents')
       ORDER BY created_at DESC`
    );
    res.json(announcements);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
