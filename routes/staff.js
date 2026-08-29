const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { authenticateToken } = require('./auth');
const { querySchool, querySchoolOne, runSchool } = require('../database_manager');

// ==========================================
// TEACHERS CRUD
// ==========================================

// GET /staff/teachers - List all teachers with their timetable assignments
router.get('/teachers', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  try {
    const teachers = await querySchool(schoolId,
      'SELECT id, name, phone, subject, qualification, status, created_at FROM teachers ORDER BY name'
    );

    // Get timetable assignments for each teacher
    for (const teacher of teachers) {
      const assignments = await querySchool(schoolId,
        `SELECT class_name, section_name, subject, day, start_time, end_time
         FROM timetable WHERE teacher_id = ?
         ORDER BY class_name, section_name`,
        [teacher.id]
      );
      teacher.assignments = assignments;
    }

    res.json(teachers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /staff/teachers - Create a new teacher
router.post('/teachers', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { name, phone, password, subject, qualification } = req.body;

  if (!name || !phone || !password) {
    return res.status(400).json({ error: 'Name, phone, and password are required' });
  }

  try {
    const existing = await querySchoolOne(schoolId, 'SELECT id FROM teachers WHERE phone = ?', [phone]);
    if (existing) {
      return res.status(409).json({ error: 'A teacher with this phone number already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await runSchool(schoolId,
      `INSERT INTO teachers (name, phone, password, subject, qualification, status, school_id, created_at)
       VALUES (?, ?, ?, ?, ?, 'Active', ?, datetime('now'))`,
      [name, phone, hashedPassword, subject || '', qualification || '', schoolId]
    );

    res.json({ id: result.id, message: 'Teacher created successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /staff/teachers/:id - Update teacher
router.put('/teachers/:id', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { id } = req.params;
  const { name, phone, subject, qualification, status, password } = req.body;

  try {
    let query = `UPDATE teachers SET name=?, phone=?, subject=?, qualification=?, status=?`;
    let params = [name, phone, subject || '', qualification || '', status || 'Active'];

    if (password) {
      const hashedPassword = await bcrypt.hash(password, 10);
      query += `, password=?`;
      params.push(hashedPassword);
    }

    query += ` WHERE id=?`;
    params.push(id);

    await runSchool(schoolId, query, params);
    res.json({ message: 'Teacher updated successfully' });
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
    const result = await runSchool(schoolId,
      `INSERT INTO parents (name, phone, password, cnic, address, status, created_at)
       VALUES (?, ?, ?, '', '', 'Active', datetime('now'))`,
      [parentName, phone, hashedPassword]
    );

    // Auto-link all students with matching phone
    const students = await querySchool(schoolId,
      'SELECT id FROM students WHERE phone = ?', [phone]
    );
    for (const s of students) {
      await runSchool(schoolId,
        'INSERT OR IGNORE INTO student_parents (student_id, parent_id, relation) VALUES (?, ?, ?)',
        [s.id, result.id, 'Father']
      );
    }

    res.json({ id: result.id, message: `Parent created and linked to ${students.length} student(s)` });
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
      `INSERT OR REPLACE INTO student_parents (student_id, parent_id, relation) VALUES (?, ?, ?)`,
      [student_id, parent_id, relation || 'Father']
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
       VALUES (?, ?, ?, ?, datetime('now'))`,
      [title, message, target_role || 'all', req.user.username || 'Admin']
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
