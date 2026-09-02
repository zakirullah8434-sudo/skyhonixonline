const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
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

  const parsedAmount = parseFloat(amount_paid);
  const parsedLedgerId = parseInt(ledger_id);

  if (!parsedLedgerId || isNaN(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ error: 'Valid ledger_id and a positive amount_paid are required' });
  }

  const payDate = payment_date || new Date().toISOString().split('T')[0];

  try {
    // 1. Get ledger row details
    const ledger = await querySchoolOne(
      schoolId,
      'SELECT id, student_id, class_name, month, year, total_payable, paid_amount FROM fee_ledger WHERE id = ?',
      [parsedLedgerId]
    );

    if (!ledger) {
      return res.status(404).json({ error: 'Ledger record not found' });
    }

    let newPaidAmount = ledger.paid_amount + parsedAmount;
    let newStatus = 'Unpaid';
    if (newPaidAmount >= ledger.total_payable) {
      newStatus = 'Paid';
      newPaidAmount = ledger.total_payable; // Cap at total
    } else if (newPaidAmount > 0) {
      newStatus = 'Partial';
    }

    // 2. Perform transaction: update ledger AND log payment record
    const statements = [
      {
        sql: 'UPDATE fee_ledger SET paid_amount = ?, status = ? WHERE id = ?',
        params: [newPaidAmount, newStatus, parsedLedgerId]
      },
      {
        sql: `INSERT INTO fee_payments (student_id, class_name, month, year, amount_paid, payment_date, fee_ledger_id)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        params: [ledger.student_id, ledger.class_name, ledger.month, ledger.year, parsedAmount, payDate, parsedLedgerId]
      }
    ];

    await runSchoolTransaction(schoolId, statements);

    // SYNC: Emit fee payment event to cascade updates to analytics, dashboard, and related views
    await syncManager.onFeePaymentRecorded(schoolId, parsedLedgerId, parsedAmount, ledger.student_id);

    res.json({
      message: 'Payment recorded successfully!',
      ledger: {
        id: parsedLedgerId,
        total_payable: ledger.total_payable,
        paid_amount: newPaidAmount,
        status: newStatus
      },
      syncEvent: 'fees.payment.recorded'
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
    const monthOrder = { 'January':1,'February':2,'March':3,'April':4,'May':5,'June':6,'July':7,'August':8,'September':9,'October':10,'November':11,'December':12 };
    const currentMonthName = new Date().toLocaleString('en-US', { month: 'long' });
    const currentYear = new Date().getFullYear();
    const reqMonth = month || currentMonthName;
    const reqYear = parseInt(year) || currentYear;

    const classStats = await querySchool(
      schoolId,
      `SELECT class_name, 
              COUNT(student_id) as total_students,
              SUM(total_payable) as total_due,
              SUM(paid_amount) as total_collected
       FROM fee_ledger
       WHERE month = ? AND year = ?
       GROUP BY class_name`,
      [reqMonth, reqYear]
    );

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

    const classSet = new Set();
    classStats.forEach(cs => classSet.add(cs.class_name));
    activeStudentCounts.forEach(r => classSet.add(r.class_name));
    const classList = Array.from(classSet).sort();

    const prevMonthIndex = (monthOrder[reqMonth] || 1) - 1;
    const prevMonthName = Object.keys(monthOrder).find(k => monthOrder[k] === prevMonthIndex) || Object.keys(monthOrder).find(k => monthOrder[k] === 12);
    const prevYear = prevMonthIndex === 0 ? reqYear - 1 : reqYear;

    const prevMonthStats = await querySchool(
      schoolId,
      `SELECT class_name, SUM(paid_amount) as prev_collected
       FROM fee_ledger WHERE month = ? AND year = ?
       GROUP BY class_name`,
      [prevMonthName, prevYear]
    );
    const prevCollectedMap = {};
    prevMonthStats.forEach(p => {
      prevCollectedMap[p.class_name] = p.prev_collected || 0;
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

      const prevCollected = prevCollectedMap[clsName] || 0;
      let trend = '0%';
      if (prevCollected > 0) {
        const change = ((collected - prevCollected) / prevCollected * 100).toFixed(0);
        trend = change >= 0 ? `+${change}%` : `${change}%`;
      } else if (collected > 0) {
        trend = '+100%';
      }

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

    // Compute total outstanding across ALL months (matches dashboard logic)
    const allLedger = await querySchool(
      schoolId,
      `SELECT SUM(COALESCE(total_payable,0) - COALESCE(paid_amount,0)) AS total_outstanding
       FROM fee_ledger`
    );
    const totalOutstanding = allLedger[0] ? (allLedger[0].total_outstanding || 0) : 0;

    // Also include opening dues from fee_dues table
    const openingDuesRow = await querySchool(
      schoolId,
      `SELECT COALESCE(SUM(due_amount), 0) AS total_opening_dues FROM fee_dues`
    );
    const totalOpeningDues = openingDuesRow[0] ? (openingDuesRow[0].total_opening_dues || 0) : 0;

    schoolWise.total_outstanding_all = totalOutstanding + totalOpeningDues;

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

// GET /fees/slip/:student_id - Get fee slip data for a student (12-month view)
router.get('/slip/:student_id', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const studentId = parseInt(req.params.student_id);
  const { year } = req.query;

  try {
    const student = await querySchoolOne(
      schoolId,
      `SELECT id, name, roll_no, father_name, class_name, section_name, admission_no 
       FROM students WHERE id = ?`,
      [studentId]
    );
    if (!student) return res.status(404).json({ error: 'Student not found' });

    const settings = await querySchoolOne(schoolId, 'SELECT * FROM fee_settings LIMIT 1');

    let logoBase64 = '';
    if (settings && settings.logo_path) {
      try {
        const logoFullPath = path.join(__dirname, '..', 'public', settings.logo_path);
        if (fs.existsSync(logoFullPath)) {
          const ext = path.extname(logoFullPath).toLowerCase().replace('.', '');
          const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
          const data = fs.readFileSync(logoFullPath);
          logoBase64 = `data:${mime};base64,${data.toString('base64')}`;
        }
      } catch (e) {}
    }

    const slipYear = parseInt(year) || new Date().getFullYear();
    const months = ['Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec','Jan','Feb'];
    const fullMonthMap = {
      'Mar':'March','Apr':'April','May':'May','Jun':'June',
      'Jul':'July','Aug':'August','Sep':'September','Oct':'October',
      'Nov':'November','Dec':'December','Jan':'January','Feb':'February'
    };
    const yearMap = {
      'Mar': slipYear, 'Apr': slipYear, 'May': slipYear, 'Jun': slipYear,
      'Jul': slipYear, 'Aug': slipYear, 'Sep': slipYear, 'Oct': slipYear,
      'Nov': slipYear, 'Dec': slipYear, 'Jan': slipYear + 1, 'Feb': slipYear + 1
    };

    const ledgerRows = await querySchool(
      schoolId,
      `SELECT month, year, base_fee, monthly_fee, transport_fee, previous_due, total_payable, paid_amount, status 
       FROM fee_ledger WHERE student_id = ? AND year IN (?, ?)`,
      [studentId, slipYear, slipYear + 1]
    );

    const ledgerMap = {};
    ledgerRows.forEach(r => {
      const shortMonth = months.find(m => fullMonthMap[m] === r.month);
      if (shortMonth && r.year === yearMap[shortMonth]) {
        ledgerMap[shortMonth] = r;
      }
    });

    const monthlyFee = {};
    const transportFee = {};
    const due = {};
    const total = {};
    const paid = {};
    const unpaid = {};
    let netTotal = 0;

    months.forEach(m => {
      const entry = ledgerMap[m];
      if (entry) {
        monthlyFee[m] = entry.monthly_fee || 0;
        transportFee[m] = entry.transport_fee || 0;
        due[m] = entry.previous_due || 0;
        total[m] = entry.total_payable || 0;
        paid[m] = entry.paid_amount || 0;
        unpaid[m] = (entry.total_payable || 0) - (entry.paid_amount || 0);
        netTotal += unpaid[m] > 0 ? unpaid[m] : 0;
      } else {
        monthlyFee[m] = null;
        transportFee[m] = null;
        due[m] = null;
        total[m] = null;
        paid[m] = null;
        unpaid[m] = null;
      }
    });

    res.json({
      student,
      school: {
        name: settings ? settings.school_name : '',
        phone: settings ? settings.phone : '',
        reg: settings ? settings.registration_number : '',
        logo: logoBase64 || (settings ? settings.logo_path : '')
      },
      year: slipYear,
      months,
      monthlyFee,
      transportFee,
      due,
      total,
      paid,
      unpaid,
      netTotal
    });
  } catch (err) {
    console.error('Fee slip error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /fees/unpaid-students - Get students with unpaid fees for reminders
router.get('/unpaid-students', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { class_name, section_name, year } = req.query;

  try {
    let query = `
      SELECT s.id, s.name, s.roll_no, s.father_name, s.class_name, s.section_name, s.admission_no,
             COALESCE(SUM(CASE WHEN f.total_payable IS NOT NULL THEN f.total_payable - f.paid_amount ELSE 0 END), 0) as total_unpaid,
             COUNT(f.id) as ledger_entries
      FROM students s
      LEFT JOIN fee_ledger f ON f.student_id = s.id AND f.year = ?
      WHERE (s.status IS NULL OR s.status != 'Left')
    `;
    const params = [parseInt(year) || new Date().getFullYear()];

    if (class_name) {
      query += ' AND s.class_name = ?';
      params.push(class_name);
    }
    if (section_name) {
      query += ' AND s.section_name = ?';
      params.push(section_name);
    }

    query += ' GROUP BY s.id ORDER BY s.class_name, s.roll_no';

    const students = await querySchool(schoolId, query, params);
    res.json(students);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /fees/reminders - Save a fee reminder
router.post('/reminders', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { title, class_name, section_name, year, student_ids, total_amount, student_count } = req.body;

  try {
    const result = await runSchool(schoolId,
      `INSERT INTO fee_reminders (title, class_name, section_name, year, student_ids, total_amount, student_count, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Active', datetime('now'))`,
      [
        title || `Fee Reminder - ${class_name || 'All'} - ${year}`,
        class_name || '',
        section_name || '',
        year || new Date().getFullYear(),
        JSON.stringify(student_ids || []),
        total_amount || 0,
        student_count || 0
      ]
    );
    res.json({ id: result.id, message: 'Reminder saved successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /fees/reminders - List all saved reminders
router.get('/reminders', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;

  try {
    const reminders = await querySchool(schoolId,
      'SELECT * FROM fee_reminders ORDER BY created_at DESC'
    );
    res.json(reminders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /fees/reminders/:id/print - Mark reminder as printed
router.put('/reminders/:id/print', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { id } = req.params;

  try {
    await runSchool(schoolId,
      `UPDATE fee_reminders SET printed_at = datetime('now') WHERE id = ?`,
      [id]
    );
    res.json({ message: 'Reminder marked as printed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /fees/reminders/:id - Delete a saved reminder
router.delete('/reminders/:id', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { id } = req.params;

  try {
    await runSchool(schoolId, 'DELETE FROM fee_reminders WHERE id=?', [id]);
    res.json({ message: 'Reminder deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /fees/reminders/generate-pdf - Generate PDF for selected students
router.post('/reminders/generate-pdf', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { student_ids, year, title } = req.body;

  if (!student_ids || !Array.isArray(student_ids) || student_ids.length === 0) {
    return res.status(400).json({ error: 'student_ids array is required' });
  }

  try {
    const PDFDocument = require('pdfkit');
    const path = require('path');
    const fs = require('fs');

    const slipYear = parseInt(year) || new Date().getFullYear();
    const months = ['Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec','Jan','Feb'];
    const fullMonthMap = {
      'Mar':'March','Apr':'April','May':'May','Jun':'June',
      'Jul':'July','Aug':'August','Sep':'September','Oct':'October',
      'Nov':'November','Dec':'December','Jan':'January','Feb':'February'
    };
    const yearMap = {
      'Mar': slipYear, 'Apr': slipYear, 'May': slipYear, 'Jun': slipYear,
      'Jul': slipYear, 'Aug': slipYear, 'Sep': slipYear, 'Oct': slipYear,
      'Nov': slipYear, 'Dec': slipYear, 'Jan': slipYear + 1, 'Feb': slipYear + 1
    };

    // Get school settings
    const settings = await querySchoolOne(schoolId, 'SELECT * FROM fee_settings LIMIT 1');
    const schoolName = settings ? settings.school_name : 'School Name';
    const schoolPhone = settings ? settings.phone : '';
    const schoolReg = settings ? settings.registration_number : '';

    // Create uploads directory if not exists
    const uploadsDir = path.join(__dirname, '..', 'public', 'uploads', 'reminders');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    const fileName = `reminder_${Date.now()}.pdf`;
    const filePath = path.join(uploadsDir, fileName);

    // Collect all student data first
    const studentDataList = [];
    for (const studentId of student_ids) {
      const student = await querySchoolOne(
        schoolId,
        `SELECT id, name, roll_no, father_name, class_name, section_name, admission_no 
         FROM students WHERE id = ?`,
        [studentId]
      );
      if (!student) continue;

      const ledgerRows = await querySchool(
        schoolId,
        `SELECT month, year, base_fee, monthly_fee, transport_fee, previous_due, total_payable, paid_amount, status 
         FROM fee_ledger WHERE student_id = ? AND year IN (?, ?)`,
        [studentId, slipYear, slipYear + 1]
      );

      const ledgerMap = {};
      ledgerRows.forEach(r => {
        const shortMonth = months.find(m => fullMonthMap[m] === r.month);
        if (shortMonth && r.year === yearMap[shortMonth]) {
          ledgerMap[shortMonth] = r;
        }
      });

      let netTotal = 0;
      months.forEach(m => {
        if (ledgerMap[m]) {
          const unpaid = (ledgerMap[m].total_payable || 0) - (ledgerMap[m].paid_amount || 0);
          if (unpaid > 0) netTotal += unpaid;
        }
      });

      studentDataList.push({ student, ledgerMap, netTotal });
    }

    if (studentDataList.length === 0) {
      return res.status(404).json({ error: 'No valid students found' });
    }

    // Create PDF
    const doc = new PDFDocument({ size: 'A4', bufferPages: true });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    const SLIP_W = 267;
    const SLIP_H = 380;
    const MARGIN = 15;
    const GAP = 13;

    function drawSlip(slipData, x, y) {
      const { student, ledgerMap, netTotal } = slipData;

      // Border
      doc.rect(x, y, SLIP_W, SLIP_H).stroke();

      // School header
      doc.font('Helvetica-Bold').fontSize(8);
      doc.text(schoolName.toUpperCase(), x + 5, y + 6, { width: SLIP_W - 10, align: 'center' });
      doc.font('Helvetica').fontSize(5);
      doc.text(`Contact: ${schoolPhone} | Reg No: ${schoolReg}`, x + 5, y + 17, { width: SLIP_W - 10, align: 'center' });

      // Separator line
      const sepY = y + 25;
      doc.moveTo(x + 5, sepY).lineTo(x + SLIP_W - 5, sepY).lineWidth(0.5).stroke().lineWidth(1);

      // Student info
      let iy = y + 28;
      doc.font('Helvetica-Bold').fontSize(5.5);
      doc.text('Name:', x + 7, iy, { continued: true }).font('Helvetica').text(` ${student.name}`, { width: SLIP_W / 2 - 10 });
      doc.font('Helvetica-Bold').text('Roll No:', x + SLIP_W / 2, iy, { continued: true }).font('Helvetica').text(` ${student.roll_no || '-'}`, { width: SLIP_W / 2 - 10 });

      iy += 10;
      doc.font('Helvetica-Bold').text('F-Name:', x + 7, iy, { continued: true }).font('Helvetica').text(` ${student.father_name || '-'}`, { width: SLIP_W / 2 - 10 });
      doc.font('Helvetica-Bold').text('ID:', x + SLIP_W / 2, iy, { continued: true }).font('Helvetica').text(` ${student.admission_no || student.id}`, { width: SLIP_W / 2 - 10 });

      iy += 10;
      doc.font('Helvetica-Bold').text('Class:', x + 7, iy, { continued: true }).font('Helvetica').text(` ${student.class_name}${student.section_name ? ' (' + student.section_name + ')' : ''}`, { width: SLIP_W / 2 - 10 });
      doc.font('Helvetica-Bold').text('FEE REMINDER', x + SLIP_W / 2, iy, { width: SLIP_W / 2 - 7, align: 'center' });

      // Fee table
      const tableX = x + 5;
      const tableTopY = iy + 14;
      const labelW = 35;
      const dataW = (SLIP_W - 10 - labelW) / 12;
      const rowH = 9;

      // Header row background
      doc.rect(tableX, tableTopY, SLIP_W - 10, rowH).fill('#f0f0f0').stroke();
      doc.fill('#000');

      // Month headers
      let hx = tableX + labelW;
      doc.font('Helvetica-Bold').fontSize(3.8);
      months.forEach((m) => {
        doc.text(m, hx, tableTopY + 2, { width: dataW, align: 'center' });
        hx += dataW;
      });

      // Data rows
      const rowDefs = [
        { label: 'Mnth Fee', key: 'monthly_fee' },
        { label: 'Transport', key: 'transport_fee' },
        { label: 'Due', key: 'previous_due' },
        { label: 'Total', key: 'total_payable' },
        { label: 'Paid', key: 'paid_amount' },
        { label: 'Unpaid', key: 'unpaid' }
      ];

      rowDefs.forEach((rd, ri) => {
        const ry = tableTopY + rowH + ri * rowH;

        // Row border
        doc.moveTo(tableX, ry).lineTo(tableX + SLIP_W - 10, ry).lineWidth(0.3).stroke().lineWidth(1);

        // Label
        doc.font('Helvetica-Bold').fontSize(3.8);
        doc.text(rd.label, tableX + 2, ry + 2, { width: labelW - 2 });

        // Data cells
        let cx = tableX + labelW;
        doc.font('Helvetica').fontSize(3.8);
        months.forEach((m) => {
          let val = '';
          if (ledgerMap[m]) {
            if (rd.key === 'unpaid') {
              val = ((ledgerMap[m].total_payable || 0) - (ledgerMap[m].paid_amount || 0)).toLocaleString();
            } else {
              val = (ledgerMap[m][rd.key] || 0).toLocaleString();
            }
          }
          doc.text(val, cx, ry + 2, { width: dataW, align: 'center' });
          cx += dataW;
        });
      });

      // Bottom border of table
      const tableBottomY = tableTopY + rowH + rowDefs.length * rowH;
      doc.moveTo(tableX, tableBottomY).lineTo(tableX + SLIP_W - 10, tableBottomY).lineWidth(0.5).stroke().lineWidth(1);

      // Footer
      const footY = tableBottomY + 6;
      doc.moveTo(x + 5, footY).lineTo(x + SLIP_W - 5, footY).lineWidth(0.5).stroke().lineWidth(1);

      doc.font('Helvetica').fontSize(5);
      doc.text('Principal Sign: _______________', x + 7, footY + 3, { width: SLIP_W / 2 });

      doc.font('Helvetica-Bold').fontSize(6);
      doc.text(`NET TOTAL: ${netTotal.toLocaleString()}`, x + SLIP_W / 2, footY + 3, { width: SLIP_W / 2 - 7, align: 'right' });
    }

    // Layout: 2 columns x 2 rows per page
    for (let i = 0; i < studentDataList.length; i++) {
      const posOnPage = i % 4;
      const col = posOnPage % 2;
      const row = Math.floor(posOnPage / 2);

      if (posOnPage === 0 && i > 0) {
        doc.addPage();
      }

      const sx = MARGIN + col * (SLIP_W + GAP);
      const sy = MARGIN + row * (SLIP_H + GAP);

      drawSlip(studentDataList[i], sx, sy);
    }

    doc.end();

    stream.on('finish', () => {
      res.json({
        message: 'PDF generated successfully',
        file_name: fileName,
        file_path: `/uploads/reminders/${fileName}`,
        student_count: studentDataList.length
      });
    });

    stream.on('error', (err) => {
      res.status(500).json({ error: 'Failed to generate PDF: ' + err.message });
    });

  } catch (err) {
    console.error('PDF generation error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /fees/reminders/download/:filename - Download generated PDF
router.get('/reminders/download/:filename', authenticateToken, async (req, res) => {
  const { filename } = req.params;
  const path = require('path');
  const fs = require('fs');

  const filePath = path.join(__dirname, '..', 'public', 'uploads', 'reminders', filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  res.download(filePath, filename);
});

module.exports = router;
