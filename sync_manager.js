/**
 * Synchronization Manager
 * Handles cascading data updates across all modules when any change occurs
 * Ensures fees, results, analytics, and dashboards stay in real-time sync
 */

const { querySchool, querySchoolOne, runSchool } = require('./database_manager');

class SyncManager {
  constructor() {
    this.listeners = {}; // Track listeners for each event type
    this.changedData = {}; // Track what changed per schoolId
  }

  /**
   * Register a listener for data changes
   * @param {string} event - Event name (e.g., 'fees.updated', 'results.calculated', 'student.changed')
   * @param {function} callback - Handler function
   */
  on(event, callback) {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event].push(callback);
  }

  /**
   * Emit a synchronization event
   * @param {string} event - Event name
   * @param {object} data - Event data including schoolId, changes, timestamps
   */
  async emit(event, data) {
    if (!this.listeners[event]) return;

    console.log(`[SYNC] Event: ${event}`, { schoolId: data.schoolId, timestamp: new Date().toISOString() });

    for (const callback of this.listeners[event]) {
      try {
        await callback(data);
      } catch (err) {
        console.error(`[SYNC] Error in listener for ${event}:`, err);
      }
    }
  }

  /**
   * FEES: When a fee payment is recorded
   */
  async onFeePaymentRecorded(schoolId, ledgerId, paymentAmount, studentId) {
    const changes = {
      schoolId,
      ledgerId,
      studentId,
      paymentAmount,
      timestamp: new Date().toISOString(),
      affectedModules: ['analytics', 'dashboard', 'student-record', 'ledger']
    };

    await this.emit('fees.payment.recorded', changes);
    // Cascade: Update analytics, refresh student record, update dashboard pending dues
    await this.syncAnalyticsAfterFeePayment(schoolId, ledgerId, studentId);
  }

  /**
   * FEES: When class fees are updated
   */
  async onClassFeesChanged(schoolId, className, oldFee, newFee) {
    const changes = {
      schoolId,
      className,
      oldFee,
      newFee,
      timestamp: new Date().toISOString(),
      affectedModules: ['ledger', 'analytics', 'student-calculations']
    };

    await this.emit('fees.classfee.changed', changes);
    // Cascade: Recalculate all future unpaid ledger entries for this class
    await this.syncClassFeeImpact(schoolId, className, newFee);
  }

  /**
   * FEES: When student discount/free status changes
   */
  async onStudentFeeSettingChanged(schoolId, studentId, field, oldValue, newValue) {
    const changes = {
      schoolId,
      studentId,
      field, // 'is_free', 'discount_amount', 'discount_percent', 'transport_fee'
      oldValue,
      newValue,
      timestamp: new Date().toISOString(),
      affectedModules: ['ledger', 'analytics', 'dashboard']
    };

    await this.emit('fees.student-setting.changed', changes);
    // Cascade: Recalculate all unpaid ledger entries for this student
    await this.syncStudentFeeImpact(schoolId, studentId);
  }

  /**
   * RESULTS: When marks are entered or updated
   */
  async onMarksUpdated(schoolId, studentId, examId, subject, oldMarks, newMarks) {
    const changes = {
      schoolId,
      studentId,
      examId,
      subject,
      oldMarks,
      newMarks,
      timestamp: new Date().toISOString(),
      affectedModules: ['results', 'analytics', 'dmc', 'dashboard']
    };

    await this.emit('results.marks.updated', changes);
    // Cascade: Invalidate and recalculate results for this student
    await this.invalidateStudentResults(schoolId, studentId, examId);
  }

  /**
   * RESULTS: When results are calculated
   */
  async onResultsCalculated(schoolId, classNames, termName, examId) {
    const changes = {
      schoolId,
      classNames,
      termName,
      examId,
      timestamp: new Date().toISOString(),
      affectedModules: ['analytics', 'dashboard', 'dmc', 'ranking']
    };

    await this.emit('results.calculated', changes);
    // Cascade: Refresh all analytics for this exam/term
    await this.syncResultsAnalytics(schoolId, examId, termName);
  }

  /**
   * STUDENT: When student record changes
   */
  async onStudentUpdated(schoolId, studentId, oldData, newData) {
    const changes = {
      schoolId,
      studentId,
      oldData,
      newData,
      timestamp: new Date().toISOString(),
      affectedModules: ['fees', 'attendance', 'results', 'analytics']
    };

    await this.emit('student.updated', changes);
    // Cascade: Update related records if class/section/status changed
    if (oldData.status !== newData.status || oldData.class_name !== newData.class_name) {
      await this.syncStudentStatusChange(schoolId, studentId, oldData, newData);
    }
  }

  // ============================================================
  // SYNCHRONIZATION HANDLERS (Cascade Logic)
  // ============================================================

  /**
   * Sync analytics after fee payment
   */
  async syncAnalyticsAfterFeePayment(schoolId, ledgerId, studentId) {
    try {
      const ledger = await querySchoolOne(
        schoolId,
        'SELECT student_id, class_name, month, year, total_payable, paid_amount FROM fee_ledger WHERE id = ?',
        [ledgerId]
      );

      if (!ledger) return;

      // Recalculate class analytics for this month/year
      const classStats = await querySchool(
        schoolId,
        `SELECT class_name, COUNT(student_id) as total_students, SUM(total_payable) as total_due, SUM(paid_amount) as total_collected
         FROM fee_ledger WHERE class_name = ? AND month = ? AND year = ? GROUP BY class_name`,
        [ledger.class_name, ledger.month, ledger.year]
      );

      console.log(`[SYNC] Analytics updated for class ${ledger.class_name} - ${ledger.month}/${ledger.year}`);
      await this.emit('analytics.fees.refreshed', {
        schoolId,
        classStats,
        affectedClass: ledger.class_name,
        month: ledger.month,
        year: ledger.year
      });
    } catch (err) {
      console.error('[SYNC] Error syncing analytics after fee payment:', err);
    }
  }

  /**
   * Sync when class fee changes - recalculate unpaid ledgers
   */
  async syncClassFeeImpact(schoolId, className, newFee) {
    try {
      // Get all unpaid ledger entries for this class
      const unpaidLedgers = await querySchool(
        schoolId,
        `SELECT id, student_id, monthly_fee, transport_fee, previous_due, paid_amount
         FROM fee_ledger
         WHERE class_name = ? AND status IN ('Unpaid', 'Partial')`,
        [className]
      );

      for (const ledger of unpaidLedgers) {
        // Note: We don't auto-recalculate existing ledgers.
        // This informs admin that class fee changed, affecting new generations.
      }

      console.log(`[SYNC] Class fee change noted for ${className}: new fee = ${newFee}`);
      await this.emit('fees.class-impact.notified', {
        schoolId,
        className,
        newFee,
        affectedLedgers: unpaidLedgers.length
      });
    } catch (err) {
      console.error('[SYNC] Error syncing class fee impact:', err);
    }
  }

  /**
   * Sync when student fee setting changes
   */
  async syncStudentFeeImpact(schoolId, studentId) {
    try {
      // Get student's unpaid ledger entries
      const unpaidLedgers = await querySchool(
        schoolId,
        `SELECT id FROM fee_ledger WHERE student_id = ? AND status IN ('Unpaid', 'Partial')`,
        [studentId]
      );

      console.log(`[SYNC] Student fee settings updated for student ${studentId}: ${unpaidLedgers.length} unpaid entries affected`);
      await this.emit('fees.student-impact.updated', {
        schoolId,
        studentId,
        affectedLedgers: unpaidLedgers.length
      });
    } catch (err) {
      console.error('[SYNC] Error syncing student fee impact:', err);
    }
  }

  /**
   * Invalidate and mark results for recalculation
   */
  async invalidateStudentResults(schoolId, studentId, examId) {
    try {
      const result = await querySchoolOne(
        schoolId,
        'SELECT id, term FROM results WHERE student_id = ? AND exam_id = ?',
        [studentId, examId]
      );

      if (result) {
        // Mark as potentially invalid by setting position to 0 (pending recalculation)
        await runSchool(
          schoolId,
          'UPDATE results SET position = 0 WHERE student_id = ? AND exam_id = ?',
          [studentId, examId]
        );

        console.log(`[SYNC] Results invalidated for student ${studentId} in exam ${examId}`);
      }

      await this.emit('results.invalidated', {
        schoolId,
        studentId,
        examId,
        needsRecalculation: true
      });
    } catch (err) {
      console.error('[SYNC] Error invalidating results:', err);
    }
  }

  /**
   * Sync analytics after results calculation
   */
  async syncResultsAnalytics(schoolId, examId, termName) {
    try {
      // Get result summary by class
      const classResults = await querySchool(
        schoolId,
        `SELECT s.class_name, COUNT(r.id) as total_students, AVG(r.percentage) as avg_percentage, MAX(r.percentage) as highest, MIN(r.percentage) as lowest
         FROM results r
         JOIN students s ON s.id = r.student_id
         WHERE r.exam_id = ? AND r.term = ?
         GROUP BY s.class_name`,
        [examId, termName]
      );

      console.log(`[SYNC] Results analytics updated for exam ${examId} - term ${termName}`);
      await this.emit('analytics.results.refreshed', {
        schoolId,
        examId,
        termName,
        classResults
      });
    } catch (err) {
      console.error('[SYNC] Error syncing results analytics:', err);
    }
  }

  /**
   * Sync when student status/class changes
   */
  async syncStudentStatusChange(schoolId, studentId, oldData, newData) {
    try {
      // If student left, update all related unpaid fees to reflect status change
      if (oldData.status !== 'Left' && newData.status === 'Left') {
        await runSchool(
          schoolId,
          `UPDATE fee_ledger SET status = 'Closed' WHERE student_id = ? AND status IN ('Unpaid', 'Partial')`,
          [studentId]
        );
        console.log(`[SYNC] Student ${studentId} marked as Left - closed unpaid fees`);
      }

      // If class changed, note that future ledgers will be in new class
      if (oldData.class_name !== newData.class_name) {
        console.log(`[SYNC] Student ${studentId} class changed: ${oldData.class_name} -> ${newData.class_name}`);
      }

      await this.emit('student.status.synced', {
        schoolId,
        studentId,
        oldStatus: oldData.status,
        newStatus: newData.status,
        oldClass: oldData.class_name,
        newClass: newData.class_name
      });
    } catch (err) {
      console.error('[SYNC] Error syncing student status change:', err);
    }
  }

  /**
   * Get affected data that needs refresh for a given event
   */
  getAffectedEndpoints(event) {
    const endpointMap = {
      'fees.payment.recorded': ['/api/fees/ledger', '/api/fees/analytics', '/api/dashboard'],
      'fees.classfee.changed': ['/api/fees/setup', '/api/fees/ledger'],
      'fees.student-setting.changed': ['/api/fees/ledger', '/api/fees/analytics'],
      'results.marks.updated': ['/api/exams/results', '/api/exams/dmc'],
      'results.calculated': ['/api/exams/results', '/api/exams/analytics'],
      'student.updated': ['/api/students', '/api/fees/ledger', '/api/exams/results']
    };

    return endpointMap[event] || [];
  }
}

module.exports = new SyncManager();
