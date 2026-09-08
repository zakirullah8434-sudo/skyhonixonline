const express = require('express');
const router = express.Router();
const { authenticateToken } = require('./auth');
const { querySchool, querySchoolOne, runSchool } = require('../database_manager');
const syncManager = require('../sync_manager');

// GET /promotions/classes - Get all classes with student counts
router.get('/classes', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  try {
    const rows = await querySchool(schoolId,
      `SELECT class_name, COUNT(*) as count FROM students WHERE (status IS NULL OR status != 'Left') GROUP BY class_name ORDER BY class_name`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /promotions/school-wide - Promote all students across all classes
router.post('/school-wide', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { passing_percent, exam_id, term } = req.body;

  if (!passing_percent && passing_percent !== 0) {
    return res.status(400).json({ error: 'Passing percentage is required' });
  }

  try {
    const passingMark = parseFloat(passing_percent);

    // Get all classes ordered
    const classes = await querySchool(schoolId,
      `SELECT DISTINCT class_name FROM students WHERE (status IS NULL OR status != 'Left') ORDER BY class_name`
    );

    if (classes.length === 0) {
      return res.status(400).json({ error: 'No classes found' });
    }

    let promoted = 0;
    let stayed = 0;
    let renamed = 0;
    const details = [];

    // Process from highest class to lowest (so renaming doesn't conflict)
    const classNameOrder = classes.map(c => c.class_name);

    for (let i = classNameOrder.length - 1; i >= 0; i--) {
      const currentClass = classNameOrder[i];

      // Find which class comes after this one (alphabetical sort)
      let nextClass = null;
      if (i > 0) {
        // The previous element in sorted array is the next class alphabetically
        // But we want the logical next class. Let's just go to the next in the sorted list.
        nextClass = classNameOrder[i - 1]; // sorted ascending, so i-1 is the next
      }
      
      // For last class (highest), promote to next class name
      // If current is "8th" and next is "9th", promote to "9th"
      // If current is "KG", promote to "Nursery" (first class in sorted order)
      // If no next class exists, create one (last class graduates)
      
      // Actually, let's simplify: the next class is simply the next logical class.
      // We need a proper class ordering. Let's use natural sorting or just promote within the list.
      // The simplest: if current class is at index i (ascending), next is at index i+1
      // But we're iterating from highest to lowest, so let's think differently.
      
      // Let's just use: for each class, find the next class alphabetically
      // and if none, skip promotion (can't promote beyond the last class)
      
      // Actually the user wants: class 8 promotes to class 9, class 9 doesn't exist yet → rename to "9th old"
      // So the "next class" should be determined by user configuration, not by alphabetical order.
      // The simplest approach: for each class, the next class is the next in the sorted list of existing classes.
      // If there's no next class, we don't promote (or we could create a new class).
      
      // Let me reconsider: classes are like ["1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th"]
      // When we promote 8th → 9th, and 9th already has students, we rename those students to "9th old" first
      // Actually the requirement says: rename the NOT promoted class (9th) to "9th old", then promote 8th students to 9th.
      
      // So the flow is:
      // 1. For each class (from highest to lowest):
      //    a. Determine next class name
      //    b. If next class has students, rename them to "nextClass old"
      //    c. Promote passing students from current class to next class
      //    d. Keep failing students in current class
    }

    // Better approach: use numeric class ordering
    // Extract class numbers for sorting
    function extractNum(name) {
      const m = name.match(/(\d+)/);
      return m ? parseInt(m[1]) : -1;
    }

    // Build class pairs: current → next
    const sortedClasses = [...classNameOrder].sort((a, b) => {
      const na = extractNum(a);
      const nb = extractNum(b);
      if (na !== nb) return na - nb;
      return a.localeCompare(b);
    });

    for (let i = 0; i < sortedClasses.length - 1; i++) {
      const currentClass = sortedClasses[i];
      const nextClass = sortedClasses[i + 1];

      // Check if next class already has students
      const existingNextStudents = await querySchool(schoolId,
        `SELECT id FROM students WHERE class_name = ? AND (status IS NULL OR status != 'Left')`, [nextClass]
      );

      if (existingNextStudents.length > 0) {
        // Rename existing students in next class to "nextClass old"
        await runSchool(schoolId,
          `UPDATE students SET class_name = ? WHERE class_name = ? AND (status IS NULL OR status != 'Left')`,
          [nextClass + ' old', nextClass]
        );
        renamed += existingNextStudents.length;
      }

      // Get students from current class with their exam results
      let studentsWithResults;
      if (exam_id) {
        studentsWithResults = await querySchool(schoolId,
          `SELECT s.id, s.name, COALESCE(r.percentage, -1) as percentage
           FROM students s
           LEFT JOIN results r ON r.student_id = s.id AND r.exam_id = ? AND r.term = ?
           WHERE s.class_name = ? AND (s.status IS NULL OR s.status != 'Left')`,
          [exam_id, term || 'Final', currentClass]
        );
      } else {
        // Get latest results
        studentsWithResults = await querySchool(schoolId,
          `SELECT s.id, s.name, COALESCE(r.percentage, -1) as percentage
           FROM students s
           LEFT JOIN (
             SELECT student_id, percentage, ROW_NUMBER() OVER (PARTITION BY student_id ORDER BY id DESC) as rn
             FROM results
           ) r ON r.student_id = s.id AND r.rn = 1
           WHERE s.class_name = ? AND (s.status IS NULL OR s.status != 'Left')`,
          [currentClass]
        );
      }

      for (const student of studentsWithResults) {
        const percentage = student.percentage;
        const hasExamResult = percentage >= 0;

        if (hasExamResult && percentage >= passingMark) {
          // Promote to next class
          await runSchool(schoolId,
            `UPDATE students SET class_name = ? WHERE id = ?`,
            [nextClass, student.id]
          );
          promoted++;

          // Record promotion history
          await runSchool(schoolId,
            `INSERT INTO student_promotion_history (student_id, from_class, to_class, exam_year, promotion_date, final_percentage, remarks)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [student.id, currentClass, nextClass, new Date().getFullYear(),
             new Date().toISOString(), percentage, `School-wide promotion (pass: ${passingMark}%)`]
          );
        } else if (hasExamResult) {
          stayed++;
        } else {
          // No exam result, keep in current class
          stayed++;
        }
      }

      if (studentsWithResults.length > 0) {
        details.push({
          from: currentClass,
          to: nextClass,
          total: studentsWithResults.length
        });
      }
    }

    // Emit sync event
    syncManager.emit('student.updated', { schoolId });

    res.json({
      message: 'School-wide promotion completed!',
      promoted,
      stayed,
      renamed,
      details
    });
  } catch (err) {
    console.error('School-wide promotion error:', err);
    res.status(500).json({ error: 'Promotion failed: ' + err.message });
  }
});

// POST /promotions/class-wise - Promote specific classes
router.post('/class-wise', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { passing_percent, exam_id, term, class_names } = req.body;

  if (!passing_percent && passing_percent !== 0) {
    return res.status(400).json({ error: 'Passing percentage is required' });
  }
  if (!class_names || class_names.length === 0) {
    return res.status(400).json({ error: 'At least one class must be selected' });
  }

  try {
    const passingMark = parseFloat(passing_percent);

    // Extract class numbers for sorting
    function extractNum(name) {
      const m = name.match(/(\d+)/);
      return m ? parseInt(m[1]) : -1;
    }

    // Build class pairs: current → next
    const sortedClasses = [...class_names].sort((a, b) => {
      const na = extractNum(a);
      const nb = extractNum(b);
      if (na !== nb) return na - nb;
      return a.localeCompare(b);
    });

    let promoted = 0;
    let stayed = 0;
    let renamed = 0;
    const details = [];

    for (const currentClass of sortedClasses) {
      // Find next class name (same logic as school-wide)
      // Get all classes in the system
      const allClasses = await querySchool(schoolId,
        `SELECT DISTINCT class_name FROM students WHERE (status IS NULL OR status != 'Left') ORDER BY class_name`
      );
      const allClassNames = allClasses.map(c => c.class_name);
      
      // Find next class
      let nextClass = null;
      for (let i = 0; i < allClassNames.length; i++) {
        if (allClassNames[i] === currentClass) {
          if (i < allClassNames.length - 1) {
            nextClass = allClassNames[i + 1];
          }
          break;
        }
      }

      if (!nextClass) {
        // This is the last/highest class, skip promotion
        details.push({
          from: currentClass,
          to: 'N/A (highest class)',
          total: 0,
          note: 'Cannot promote - this is the highest class'
        });
        continue;
      }

      // Check if next class already has students
      const existingNextStudents = await querySchool(schoolId,
        `SELECT id FROM students WHERE class_name = ? AND (status IS NULL OR status != 'Left')`, [nextClass]
      );

      if (existingNextStudents.length > 0) {
        await runSchool(schoolId,
          `UPDATE students SET class_name = ? WHERE class_name = ? AND (status IS NULL OR status != 'Left')`,
          [nextClass + ' old', nextClass]
        );
        renamed += existingNextStudents.length;
      }

      // Get students from current class with results
      let studentsWithResults;
      if (exam_id) {
        studentsWithResults = await querySchool(schoolId,
          `SELECT s.id, s.name, COALESCE(r.percentage, -1) as percentage
           FROM students s
           LEFT JOIN results r ON r.student_id = s.id AND r.exam_id = ? AND r.term = ?
           WHERE s.class_name = ? AND (s.status IS NULL OR s.status != 'Left')`,
          [exam_id, term || 'Final', currentClass]
        );
      } else {
        studentsWithResults = await querySchool(schoolId,
          `SELECT s.id, s.name, COALESCE(r.percentage, -1) as percentage
           FROM students s
           LEFT JOIN (
             SELECT student_id, percentage, ROW_NUMBER() OVER (PARTITION BY student_id ORDER BY id DESC) as rn
             FROM results
           ) r ON r.student_id = s.id AND r.rn = 1
           WHERE s.class_name = ? AND (s.status IS NULL OR s.status != 'Left')`,
          [currentClass]
        );
      }

      let classPromoted = 0;
      let classStayed = 0;

      for (const student of studentsWithResults) {
        const percentage = student.percentage;
        const hasExamResult = percentage >= 0;

        if (hasExamResult && percentage >= passingMark) {
          await runSchool(schoolId,
            `UPDATE students SET class_name = ? WHERE id = ?`,
            [nextClass, student.id]
          );
          classPromoted++;

          await runSchool(schoolId,
            `INSERT INTO student_promotion_history (student_id, from_class, to_class, exam_year, promotion_date, final_percentage, remarks)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [student.id, currentClass, nextClass, new Date().getFullYear(),
             new Date().toISOString(), percentage, `Class-wise promotion (pass: ${passingMark}%)`]
          );
        } else {
          classStayed++;
        }
      }

      promoted += classPromoted;
      stayed += classStayed;

      details.push({
        from: currentClass,
        to: nextClass,
        total: studentsWithResults.length,
        promoted: classPromoted,
        stayed: classStayed
      });
    }

    syncManager.emit('student.updated', { schoolId });

    res.json({
      message: 'Class-wise promotion completed!',
      promoted,
      stayed,
      renamed,
      details
    });
  } catch (err) {
    console.error('Class-wise promotion error:', err);
    res.status(500).json({ error: 'Promotion failed: ' + err.message });
  }
});

// POST /promotions/leave - Mark students as Left (leave school)
router.post('/leave', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { student_ids } = req.body;

  if (!student_ids || student_ids.length === 0) {
    return res.status(400).json({ error: 'No students selected' });
  }

  try {
    let count = 0;
    for (const studentId of student_ids) {
      await runSchool(schoolId,
        `UPDATE students SET status = 'Left' WHERE id = ?`, [studentId]
      );
      count++;
    }

    syncManager.emit('student.updated', { schoolId });

    res.json({
      message: `${count} student(s) marked as Left`,
      count
    });
  } catch (err) {
    console.error('Leave students error:', err);
    res.status(500).json({ error: 'Failed to process leave: ' + err.message });
  }
});

// GET /promotions/history - Get promotion history
router.get('/history', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  try {
    const history = await querySchool(schoolId,
      `SELECT ph.*, s.name as student_name, s.student_id as student_code
       FROM student_promotion_history ph
       LEFT JOIN students s ON s.id = ph.student_id
       ORDER BY ph.promotion_date DESC`
    );
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /promotions/preview - Preview promotion results without executing
router.get('/preview', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { passing_percent, exam_id, term, mode, class_names } = req.query;

  if (!passing_percent && passing_percent !== 0) {
    return res.status(400).json({ error: 'Passing percentage is required' });
  }

  try {
    const passingMark = parseFloat(passing_percent);
    const targetClasses = mode === 'class-wise' && class_names
      ? class_names.split(',')
      : null;

    const allClasses = await querySchool(schoolId,
      `SELECT DISTINCT class_name FROM students WHERE (status IS NULL OR status != 'Left') ORDER BY class_name`
    );

    function extractNum(name) {
      const m = name.match(/(\d+)/);
      return m ? parseInt(m[1]) : -1;
    }

    const sortedClasses = allClasses.map(c => c.class_name).sort((a, b) => {
      const na = extractNum(a);
      const nb = extractNum(b);
      if (na !== nb) return na - nb;
      return a.localeCompare(b);
    });

    const preview = [];

    for (const currentClass of sortedClasses) {
      if (targetClasses && !targetClasses.includes(currentClass)) continue;

      // Find next class
      let nextClass = null;
      for (let i = 0; i < sortedClasses.length; i++) {
        if (sortedClasses[i] === currentClass && i < sortedClasses.length - 1) {
          nextClass = sortedClasses[i + 1];
          break;
        }
      }

      if (!nextClass) {
        preview.push({ from: currentClass, to: 'N/A (highest)', students: [] });
        continue;
      }

      let studentsWithResults;
      if (exam_id) {
        studentsWithResults = await querySchool(schoolId,
          `SELECT s.id, s.name, s.roll_no, COALESCE(r.percentage, -1) as percentage
           FROM students s
           LEFT JOIN results r ON r.student_id = s.id AND r.exam_id = ? AND r.term = ?
           WHERE s.class_name = ? AND (s.status IS NULL OR s.status != 'Left')`,
          [exam_id, term || 'Final', currentClass]
        );
      } else {
        studentsWithResults = await querySchool(schoolId,
          `SELECT s.id, s.name, s.roll_no, COALESCE(r.percentage, -1) as percentage
           FROM students s
           LEFT JOIN (
             SELECT student_id, percentage, ROW_NUMBER() OVER (PARTITION BY student_id ORDER BY id DESC) as rn
             FROM results
           ) r ON r.student_id = s.id AND r.rn = 1
           WHERE s.class_name = ? AND (s.status IS NULL OR s.status != 'Left')`,
          [currentClass]
        );
      }

      const students = studentsWithResults.map(s => ({
        id: s.id,
        name: s.name,
        roll_no: s.roll_no,
        percentage: s.percentage >= 0 ? s.percentage : null,
        will_promote: s.percentage >= 0 && s.percentage >= passingMark,
        status: s.percentage < 0 ? 'No exam result' :
                (s.percentage >= passingMark ? 'PASS' : 'FAIL')
      }));

      preview.push({
        from: currentClass,
        to: nextClass,
        total: students.length,
        willPromote: students.filter(s => s.will_promote).length,
        willStay: students.filter(s => !s.will_promote).length,
        students
      });
    }

    res.json(preview);
  } catch (err) {
    console.error('Preview error:', err);
    res.status(500).json({ error: 'Preview failed: ' + err.message });
  }
});

module.exports = router;
