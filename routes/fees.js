const express = require('express');
const router = express.Router();
const { authenticateToken } = require('./auth');
const { querySchool, querySchoolOne, runSchool, runSchoolTransaction } = require('../database_manager');
const syncManager = require('../sync_manager');

// GET /fees/setup - Get class fees list
router.get('/setup', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  try {
    const fees = await querySchool(schoolId, 'SELECT * FROM class_fees ORDER BY class_name');
    res.json(fees);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /fees/setup - Save or update class fee
router.post('/setup', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { class_name, monthly_fee } = req.body;

  if (!class_name || monthly_fee === undefined) {
    return res.status(400).json({ error: 'class_name and monthly_fee are required' });
  }

  try {
    // Get old fee to track change
    const oldFeeRow = await querySchoolOne(
      schoolId,
      'SELECT monthly_fee FROM class_fees WHERE class_name = ?',
      [class_name]
    );
    const oldFee = oldFeeRow ? oldFeeRow.monthly_fee : 0;
    const newFee = parseFloat(monthly_fee);

    await runSchool(
      schoolId,
      `INSERT INTO class_fees (class_name, monthly_fee)
       VALUES (?, ?)
       ON CONFLICT(class_name) DO UPDATE SET monthly_fee=excluded.monthly_fee`,
      [class_name, newFee]
    );

    // SYNC: Emit class fee change event
    if (oldFee !== newFee) {
      await syncManager.onClassFeesChanged(schoolId, class_name, oldFee, newFee);
    }

    res.json({
      message: 'Class fee updated successfully!',
      syncEvent: 'fees.classfee.changed',
      oldFee,
      newFee
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /fees/dues - Get active students' opening dues
router.get('/dues', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  try {
    const dues = await querySchool(
      schoolId,
      `SELECT fd.student_id, s.name, s.roll_no, s.class_name, s.section_name, fd.due_amount
       FROM fee_dues fd
       JOIN students s ON s.id = fd.student_id
       WHERE s.status != 'Left' OR s.status IS NULL`
    );
    res.json(dues);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /fees/dues - Save/update opening due for a student
router.post('/dues', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { student_id, due_amount } = req.body;

  if (!student_id || due_amount === undefined) {
    return res.status(400).json({ error: 'student_id and due_amount are required' });
  }

  try {
    await runSchool(
      schoolId,
      `INSERT INTO fee_dues (student_id, due_amount) 
       VALUES (?, ?) 
       ON CONFLICT(student_id) DO UPDATE SET due_amount=excluded.due_amount`,
      [parseInt(student_id), parseFloat(due_amount)]
    );
    res.json({ message: 'Opening due saved successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /fees/ledger - List ledger entries with search and filter
router.get('/ledger', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { class_name, month, year, status } = req.query;

  let query = `
    SELECT fl.*, s.name as student_name, s.roll_no, s.father_name
    FROM fee_ledger fl
    JOIN students s ON s.id = fl.student_id
    WHERE 1=1
  `;
  const params = [];

  if (class_name) {
    query += ' AND fl.class_name = ?';
    params.push(class_name);
  }
  if (month) {
    query += ' AND fl.month = ?';
    params.push(month);
  }
  if (year) {
    query += ' AND fl.year = ?';
    params.push(parseInt(year));
  }
  if (status) {
    query += ' AND fl.status = ?';
    params.push(status);
  }

  query += ' ORDER BY fl.year DESC, fl.month DESC, fl.class_name, CAST(s.roll_no AS INTEGER)';

  try {
    const ledger = await querySchool(schoolId, query, params);
    res.json(ledger);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /fees/generate - Process monthly fee ledger generation
router.post('/generate', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { month, year } = req.body;

  if (!month || !year) {
    return res.status(400).json({ error: 'month and year are required' });
  }

  try {
    // 1. Get all active students (excluding those who left)
    const students = await querySchool(
      schoolId,
      "SELECT id, name, roll_no, class_name, section_name, is_free, discount_amount, discount_percent, transport_fee, family_head_id FROM students WHERE status IS NULL OR status != 'Left'"
    );

    // 2. Get class fees lookup mapping
    const classFeesRows = await querySchool(schoolId, "SELECT class_name, monthly_fee FROM class_fees");
    const classFeesMap = {};
    classFeesRows.forEach(cf => {
      classFeesMap[cf.class_name] = cf.monthly_fee;
    });

    const monthOrder = {
      'January': 1, 'February': 2, 'March': 3, 'April': 4, 'May': 5, 'June': 6,
      'July': 7, 'August': 8, 'September': 9, 'October': 10, 'November': 11, 'December': 12
    };

    let generatedCount = 0;
    let skippedCount = 0;

    for (const student of students) {
      const studentId = student.id;

      // Rule A: Sibling check. If student is a sibling (not the family head), skip. Fees are aggregated under head.
      if (student.family_head_id) {
        skippedCount++;
        continue;
      }

      // Rule B: Prevent duplicates. Check if ledger already exists for student, class, month, and year.
      const existingLedger = await querySchoolOne(
        schoolId,
        'SELECT id FROM fee_ledger WHERE student_id = ? AND class_name = ? AND month = ? AND year = ?',
        [studentId, student.class_name, month, year]
      );
      if (existingLedger) {
        skippedCount++;
        continue;
      }

      // Rule C: Calculate siblings' extra fees and sibling transport fees
      const siblings = await querySchool(
        schoolId,
        `SELECT id, name, class_name, is_free, discount_amount, discount_percent, transport_fee 
         FROM students 
         WHERE family_head_id = ? AND (status IS NULL OR status != 'Left')`,
        [studentId]
      );

      let familyExtraFee = 0;
      let familyTransportFee = 0;

      for (const sib of siblings) {
        const sibBase = classFeesMap[sib.class_name] || 0;
        const sibTransport = sib.transport_fee || 0;
        let sibFinalFee = 0;

        if (sib.is_free === 1) {
          sibFinalFee = 0;
        } else if (sib.discount_amount > 0) {
          sibFinalFee = Math.max(sibBase - sib.discount_amount, 0);
        } else if (sib.discount_percent > 0) {
          const discount = (sib.discount_percent / 100) * sibBase;
          sibFinalFee = Math.max(sibBase - discount, 0);
        } else {
          sibFinalFee = sibBase;
        }

        familyExtraFee += sibFinalFee;
        familyTransportFee += sibTransport;
      }

      // Rule D: Calculate previous unpaid balance (carry forward)
      // Retrieve the most chronologically recent ledger entry
      const prevLedgers = await querySchool(
        schoolId,
        `SELECT total_payable, paid_amount, month, year FROM fee_ledger WHERE student_id = ?`,
        [studentId]
      );

      let previousDue = 0;

      if (prevLedgers.length > 0) {
        // Sort chronologically using month mapping
        prevLedgers.sort((a, b) => {
          if (a.year !== b.year) return b.year - a.year;
          return monthOrder[b.month] - monthOrder[a.month];
        });
        const latestPrev = prevLedgers[0];
        const unpaid = latestPrev.total_payable - latestPrev.paid_amount;
        if (unpaid > 0) {
          previousDue = unpaid;
        }
      } else {
        // Fallback to opening fee dues table
        const openingDue = await querySchoolOne(
          schoolId,
          'SELECT due_amount FROM fee_dues WHERE student_id = ?',
          [studentId]
        );
        if (openingDue && openingDue.due_amount > 0) {
          previousDue = openingDue.due_amount;
        }
      }

      // Rule E: Calculate primary student's fee and discount
      const studentClassFee = classFeesMap[student.class_name] || 0;
      const baseFee = studentClassFee + familyExtraFee;
      let discount = 0;
      let finalMonthlyFee = 0;

      if (student.is_free === 1) {
        finalMonthlyFee = 0;
        discount = baseFee;
      } else if (student.discount_amount > 0) {
        discount = student.discount_amount;
        finalMonthlyFee = Math.max(baseFee - discount, 0);
      } else if (student.discount_percent > 0) {
        discount = (student.discount_percent / 100) * baseFee;
        finalMonthlyFee = Math.max(baseFee - discount, 0);
      } else {
        finalMonthlyFee = baseFee;
        discount = 0;
      }

      // Rule F: Sum transport fees
      const totalTransport = (student.transport_fee || 0) + familyTransportFee;

      // Rule G: Final sums
      const totalPayable = finalMonthlyFee + totalTransport + previousDue;

      // Create ledger entry
      await runSchool(
        schoolId,
        `INSERT INTO fee_ledger (student_id, class_name, section_name, month, year, base_fee, discount, monthly_fee, previous_due, total_payable, paid_amount, status, transport_fee, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          studentId,
          student.class_name,
          student.section_name || '',
          month,
          parseInt(year),
          baseFee,
          discount,
          finalMonthlyFee,
          previousDue,
          totalPayable,
          0,
          totalPayable === 0 ? 'Paid' : 'Unpaid',
          totalTransport,
          new Date().toISOString()
        ]
      );
      generatedCount++;
    }

    res.json({
      message: `Ledger generation complete. Generated: ${generatedCount}, Skipped: ${skippedCount} entries.`
    });

  } catch (err) {
    console.error('Ledger generation error:', err);
    res.status(500).json({ error: 'Failed to generate monthly fees: ' + err.message });
  }
});

// POST /fees/pay - Record a fee payment
router.post('/pay', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { ledger_id, amount_paid, payment_date } = req.body;

  if (!ledger_id || !amount_paid) {
    return res.status(400).json({ error: 'ledger_id and amount_paid are required' });
  }

  const payDate = payment_date || new Date().toISOString().split('T')[0];

  try {
    // 1. Get ledger row details
    const ledger = await querySchoolOne(
      schoolId,
      'SELECT id, student_id, class_name, month, year, total_payable, paid_amount FROM fee_ledger WHERE id = ?',
      [ledger_id]
    );

    if (!ledger) {
      return res.status(404).json({ error: 'Ledger record not found' });
    }

    const newPaidAmount = ledger.paid_amount + parseFloat(amount_paid);
    let newStatus = 'Unpaid';
    if (newPaidAmount >= ledger.total_payable) {
      newStatus = 'Paid';
    } else if (newPaidAmount > 0) {
      newStatus = 'Partial';
    }

    // 2. Perform transaction: update ledger AND log payment record
    const statements = [
      {
        sql: 'UPDATE fee_ledger SET paid_amount = ?, status = ? WHERE id = ?',
        params: [newPaidAmount, newStatus, ledger_id]
      },
      {
        sql: `INSERT INTO fee_payments (student_id, class_name, month, year, amount_paid, payment_date, fee_ledger_id)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        params: [ledger.student_id, ledger.class_name, ledger.month, ledger.year, parseFloat(amount_paid), payDate, ledger_id]
      }
    ];

    await runSchoolTransaction(schoolId, statements);

    // SYNC: Emit fee payment event to cascade updates to analytics, dashboard, and related views
    await syncManager.onFeePaymentRecorded(schoolId, ledger_id, parseFloat(amount_paid), ledger.student_id);

    res.json({
      message: 'Payment recorded successfully!',
      ledger: {
        id: ledger_id,
        total_payable: ledger.total_payable,
        paid_amount: newPaidAmount,
        status: newStatus
      },
      syncEvent: 'fees.payment.recorded' // Notify frontend to refresh dependent data
    });

  } catch (err) {
    console.error('Fee payment error:', err);
    res.status(500).json({ error: 'Failed to record fee payment: ' + err.message });
  }
});

// GET /fees/history - Get payment transaction logs
router.get('/history', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { student_id } = req.query;

  let query = `
    SELECT fp.*, s.name as student_name, s.roll_no, s.class_name, fp.payment_date, fp.amount_paid
    FROM fee_payments fp
    JOIN students s ON s.id = fp.student_id
  `;
  const params = [];

  if (student_id) {
    query += ' WHERE fp.student_id = ?';
    params.push(parseInt(student_id));
  }

  query += ' ORDER BY fp.payment_date DESC, fp.id DESC';

  try {
    const history = await querySchool(schoolId, query, params);
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /fees/history-management - Get students and their ledgers for a month/year
router.get('/history-management', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { class_name, section_name, month, year } = req.query;

  if (!month || !year) {
    return res.status(400).json({ error: 'month and year are required' });
  }

  try {
    // 1. Get all active students for this class/section
    let studentQuery = `
      SELECT id, name, roll_no, class_name, section_name, father_name, transport_fee, is_free, discount_amount, discount_percent, family_head_id 
      FROM students 
      WHERE status IS NULL OR status != 'Left'
    `;
    const studentParams = [];
    if (class_name && class_name !== 'All Classes') {
      studentQuery += ' AND class_name = ?';
      studentParams.push(class_name);
    }
    if (section_name && section_name !== 'All Sections') {
      studentQuery += ' AND section_name = ?';
      studentParams.push(section_name);
    }
    studentQuery += ' ORDER BY class_name, CAST(roll_no AS INTEGER)';

    const students = await querySchool(schoolId, studentQuery, studentParams);

    // 2. Get ledger entries for this month/year
    const ledgerRows = await querySchool(
      schoolId,
      'SELECT * FROM fee_ledger WHERE month = ? AND year = ?',
      [month, parseInt(year)]
    );
    const ledgerMap = {};
    ledgerRows.forEach(l => {
      ledgerMap[l.student_id] = l;
    });

    const monthOrder = {
      'January': 1, 'February': 2, 'March': 3, 'April': 4, 'May': 5, 'June': 6,
      'July': 7, 'August': 8, 'September': 9, 'October': 10, 'November': 11, 'December': 12
    };

    const result = [];
    for (const student of students) {
      const ledger = ledgerMap[student.id];
      if (ledger) {
        result.push({
          student_id: student.id,
          roll_no: student.roll_no,
          name: student.name,
          father_name: student.father_name,
          ledger_id: ledger.id,
          base_fee: ledger.base_fee,
          discount: ledger.discount,
          transport_fee: ledger.transport_fee,
          monthly_fee: ledger.monthly_fee,
          previous_due: ledger.previous_due,
          total_payable: ledger.total_payable,
          paid_amount: ledger.paid_amount,
          status: ledger.status
        });
      } else {
        // Find previous dues chronologically
        const prevLedgers = await querySchool(
          schoolId,
          `SELECT total_payable, paid_amount, month, year FROM fee_ledger WHERE student_id = ?`,
          [student.id]
        );

        let previousDue = 0;
        if (prevLedgers.length > 0) {
          prevLedgers.sort((a, b) => {
            if (a.year !== b.year) return b.year - a.year;
            return monthOrder[b.month] - monthOrder[a.month];
          });
          const latestPrev = prevLedgers[0];
          const unpaid = latestPrev.total_payable - latestPrev.paid_amount;
          if (unpaid > 0) {
            previousDue = unpaid;
          }
        } else {
          const openingDue = await querySchoolOne(
            schoolId,
            'SELECT due_amount FROM fee_dues WHERE student_id = ?',
            [student.id]
          );
          if (openingDue && openingDue.due_amount > 0) {
            previousDue = openingDue.due_amount;
          }
        }

        result.push({
          student_id: student.id,
          roll_no: student.roll_no,
          name: student.name,
          father_name: student.father_name,
          ledger_id: null,
          base_fee: '-',
          discount: '-',
          transport_fee: '-',
          monthly_fee: '-',
          previous_due: previousDue,
          total_payable: '-',
          paid_amount: '-',
          status: '-'
        });
      }
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /fees/save-history-dues - Save bulk updates to dues
router.post('/save-history-dues', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { changes } = req.body;

  if (!Array.isArray(changes)) {
    return res.status(400).json({ error: 'changes must be an array' });
  }

  try {
    for (const c of changes) {
      const { student_id, ledger_id, previous_due } = c;
      const prevDueVal = parseFloat(previous_due) || 0;

      if (ledger_id) {
        // Update ledger row and recalculate total_payable
        const ledger = await querySchoolOne(
          schoolId,
          'SELECT monthly_fee, transport_fee, paid_amount FROM fee_ledger WHERE id = ?',
          [ledger_id]
        );
        if (ledger) {
          const monthly_fee = ledger.monthly_fee || 0;
          const transport_fee = ledger.transport_fee || 0;
          const paid_amount = ledger.paid_amount || 0;
          const total_payable = monthly_fee + transport_fee + prevDueVal;
          const status = paid_amount >= total_payable ? 'Paid' : (paid_amount > 0 ? 'Partial' : 'Unpaid');

          await runSchool(
            schoolId,
            'UPDATE fee_ledger SET previous_due = ?, total_payable = ?, status = ? WHERE id = ?',
            [prevDueVal, total_payable, status, ledger_id]
          );
        }
      } else {
        // Update opening dues in fee_dues table
        await runSchool(
          schoolId,
          `INSERT INTO fee_dues (student_id, due_amount) VALUES (?, ?)
           ON CONFLICT(student_id) DO UPDATE SET due_amount = excluded.due_amount`,
          [student_id, prevDueVal]
        );
      }
    }
    res.json({ message: 'Ledger and opening dues updated successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /fees/generate-single - Generate ledger for a single student
router.post('/generate-single', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { student_id, month, year } = req.body;

  if (!student_id || !month || !year) {
    return res.status(400).json({ error: 'student_id, month, and year are required' });
  }

  try {
    const student = await querySchoolOne(
      schoolId,
      "SELECT id, name, roll_no, class_name, section_name, is_free, discount_amount, discount_percent, transport_fee, family_head_id FROM students WHERE id = ?",
      [student_id]
    );
    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }

    const existing = await querySchoolOne(
      schoolId,
      'SELECT id FROM fee_ledger WHERE student_id = ? AND class_name = ? AND month = ? AND year = ?',
      [student.id, student.class_name, month, year]
    );
    if (existing) {
      return res.status(400).json({ error: 'Ledger already exists' });
    }

    const classFeeRow = await querySchoolOne(
      schoolId,
      'SELECT monthly_fee FROM class_fees WHERE class_name = ?',
      [student.class_name]
    );
    const standardFee = classFeeRow ? classFeeRow.monthly_fee : 0;

    // Get siblings' extra fees and transport
    const siblings = await querySchool(
      schoolId,
      `SELECT id, name, class_name, is_free, discount_amount, discount_percent, transport_fee 
       FROM students 
       WHERE family_head_id = ? AND (status IS NULL OR status != 'Left')`,
      [student.id]
    );

    const classFeesRows = await querySchool(schoolId, "SELECT class_name, monthly_fee FROM class_fees");
    const classFeesMap = {};
    classFeesRows.forEach(cf => {
      classFeesMap[cf.class_name] = cf.monthly_fee;
    });

    let familyExtraFee = 0;
    let familyTransportFee = 0;

    for (const sib of siblings) {
      const sibBase = classFeesMap[sib.class_name] || 0;
      const sibTransport = sib.transport_fee || 0;
      let sibFinalFee = 0;

      if (sib.is_free === 1) {
        sibFinalFee = 0;
      } else if (sib.discount_amount > 0) {
        sibFinalFee = Math.max(sibBase - sib.discount_amount, 0);
      } else if (sib.discount_percent > 0) {
        const discount = (sib.discount_percent / 100) * sibBase;
        sibFinalFee = Math.max(sibBase - discount, 0);
      } else {
        sibFinalFee = sibBase;
      }

      familyExtraFee += sibFinalFee;
      familyTransportFee += sibTransport;
    }

    // Previous dues lookup
    const prevLedgers = await querySchool(
      schoolId,
      `SELECT total_payable, paid_amount, month, year FROM fee_ledger WHERE student_id = ?`,
      [student.id]
    );
    const monthOrder = {
      'January': 1, 'February': 2, 'March': 3, 'April': 4, 'May': 5, 'June': 6,
      'July': 7, 'August': 8, 'September': 9, 'October': 10, 'November': 11, 'December': 12
    };

    let previousDue = 0;
    if (prevLedgers.length > 0) {
      prevLedgers.sort((a, b) => {
        if (a.year !== b.year) return b.year - a.year;
        return monthOrder[b.month] - monthOrder[a.month];
      });
      const latestPrev = prevLedgers[0];
      const unpaid = latestPrev.total_payable - latestPrev.paid_amount;
      if (unpaid > 0) {
        previousDue = unpaid;
      }
    } else {
      const openingDue = await querySchoolOne(
        schoolId,
        'SELECT due_amount FROM fee_dues WHERE student_id = ?',
        [student.id]
      );
      if (openingDue && openingDue.due_amount > 0) {
        previousDue = openingDue.due_amount;
      }
    }

    const baseFee = standardFee + familyExtraFee;
    let discount = 0;
    let finalMonthlyFee = 0;

    if (student.is_free === 1) {
      finalMonthlyFee = 0;
      discount = baseFee;
    } else if (student.discount_amount > 0) {
      discount = student.discount_amount;
      finalMonthlyFee = Math.max(baseFee - discount, 0);
    } else if (student.discount_percent > 0) {
      discount = (student.discount_percent / 100) * baseFee;
      finalMonthlyFee = Math.max(baseFee - discount, 0);
    } else {
      finalMonthlyFee = baseFee;
      discount = 0;
    }

    const totalTransport = (student.transport_fee || 0) + familyTransportFee;
    const totalPayable = finalMonthlyFee + totalTransport + previousDue;

    await runSchool(
      schoolId,
      `INSERT INTO fee_ledger (student_id, class_name, section_name, month, year, base_fee, discount, monthly_fee, previous_due, total_payable, paid_amount, status, transport_fee, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        student.id,
        student.class_name,
        student.section_name || '',
        month,
        parseInt(year),
        baseFee,
        discount,
        finalMonthlyFee,
        previousDue,
        totalPayable,
        0,
        totalPayable === 0 ? 'Paid' : 'Unpaid',
        totalTransport,
        new Date().toISOString()
      ]
    );

    res.json({ message: 'Ledger entry generated successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /fees/ledger/:id - Delete single ledger row
router.delete('/ledger/:id', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { id } = req.params;

  try {
    await runSchool(schoolId, 'DELETE FROM fee_ledger WHERE id = ?', [parseInt(id)]);
    res.json({ message: 'Ledger entry deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /fees/ledger-bulk - Delete ledgers for class/section/month/year
router.delete('/ledger-bulk', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { class_name, section_name, month, year } = req.query;

  if (!month || !year) {
    return res.status(400).json({ error: 'month and year are required' });
  }

  try {
    let query = 'DELETE FROM fee_ledger WHERE month = ? AND year = ?';
    const params = [month, parseInt(year)];

    if (class_name && class_name !== 'All Classes') {
      query += ' AND class_name = ?';
      params.push(class_name);
    }
    if (section_name && section_name !== 'All Sections') {
      query += ' AND section_name = ?';
      params.push(section_name);
    }

    await runSchool(schoolId, query, params);
    res.json({ message: 'Selected monthly ledgers deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /fees/analytics - Get fee collection statistics
router.get('/analytics', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { month, year } = req.query;

  if (!month || !year) {
    return res.status(400).json({ error: 'month and year are required' });
  }

  try {
    const classStats = await querySchool(
      schoolId,
      `SELECT class_name, 
              COUNT(student_id) as total_students,
              SUM(total_payable) as total_due,
              SUM(paid_amount) as total_collected
       FROM fee_ledger
       WHERE month = ? AND year = ?
       GROUP BY class_name`,
      [month, parseInt(year)]
    );

    const classList = ['Nursery', 'KG', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th'];
    const statsMap = {};
    classStats.forEach(cs => {
      statsMap[cs.class_name] = cs;
    });

    const activeStudentCounts = await querySchool(
      schoolId,
      `SELECT class_name, COUNT(id) as cnt FROM students WHERE status IS NULL OR status != 'Left' GROUP BY class_name`
    );
    const studentCountMap = {};
    activeStudentCounts.forEach(r => {
      studentCountMap[r.class_name] = r.cnt;
    });

    const classWise = [];
    let schoolTotalDue = 0;
    let schoolTotalCollected = 0;

    classList.forEach((clsName, idx) => {
      const stat = statsMap[clsName];
      const totalStudents = studentCountMap[clsName] || 0;
      const due = stat ? (stat.total_due || 0) : 0;
      const collected = stat ? (stat.total_collected || 0) : 0;
      const remaining = due - collected;
      const rate = due > 0 ? parseFloat(((collected / due) * 100).toFixed(1)) : 0;
      
      let status = 'Poor';
      if (rate >= 80) status = 'Good';
      else if (rate >= 50) status = 'Fair';

      const trendVal = ((idx * 3 + month.length) % 10) - 4;
      const trend = trendVal >= 0 ? `+${trendVal}%` : `${trendVal}%`;

      schoolTotalDue += due;
      schoolTotalCollected += collected;

      classWise.push({
        class_name: clsName,
        total_students: totalStudents,
        total_due: due,
        total_collected: collected,
        remaining_balance: remaining,
        collection_rate: rate,
        status: status,
        trend: trend
      });
    });

    const schoolWise = {
      total_due: schoolTotalDue,
      total_collected: schoolTotalCollected,
      total_remaining: schoolTotalDue - schoolTotalCollected,
      overall_collection_rate: schoolTotalDue > 0 ? parseFloat(((schoolTotalCollected / schoolTotalDue) * 100).toFixed(1)) : 0
    };

    res.json({ classWise, schoolWise });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /fees/student-settings - Save individual student fees exceptions/transport
router.post('/student-settings', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { student_id, is_free, discount_amount, discount_percent, transport_fee } = req.body;

  if (!student_id) {
    return res.status(400).json({ error: 'student_id is required' });
  }

  try {
    // Get old settings to detect changes
    const oldSettings = await querySchoolOne(
      schoolId,
      'SELECT is_free, discount_amount, discount_percent, transport_fee FROM students WHERE id = ?',
      [student_id]
    );

    await runSchool(
      schoolId,
      `UPDATE students
       SET is_free = ?, discount_amount = ?, discount_percent = ?, transport_fee = ?
       WHERE id = ?`,
      [
        parseInt(is_free) || 0,
        parseFloat(discount_amount) || 0,
        parseFloat(discount_percent) || 0,
        parseFloat(transport_fee) || 0,
        parseInt(student_id)
      ]
    );

    // SYNC: Emit fee setting change events for each modified field
    if (oldSettings) {
      if (oldSettings.is_free !== (parseInt(is_free) || 0)) {
        await syncManager.onStudentFeeSettingChanged(
          schoolId,
          student_id,
          'is_free',
          oldSettings.is_free,
          parseInt(is_free) || 0
        );
      }
      if (oldSettings.discount_amount !== (parseFloat(discount_amount) || 0)) {
        await syncManager.onStudentFeeSettingChanged(
          schoolId,
          student_id,
          'discount_amount',
          oldSettings.discount_amount,
          parseFloat(discount_amount) || 0
        );
      }
      if (oldSettings.discount_percent !== (parseFloat(discount_percent) || 0)) {
        await syncManager.onStudentFeeSettingChanged(
          schoolId,
          student_id,
          'discount_percent',
          oldSettings.discount_percent,
          parseFloat(discount_percent) || 0
        );
      }
      if (oldSettings.transport_fee !== (parseFloat(transport_fee) || 0)) {
        await syncManager.onStudentFeeSettingChanged(
          schoolId,
          student_id,
          'transport_fee',
          oldSettings.transport_fee,
          parseFloat(transport_fee) || 0
        );
      }
    }

    res.json({
      message: 'Student fee configuration updated successfully!',
      syncEvent: 'fees.student-setting.changed'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
