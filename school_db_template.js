/**
 * School Tenant Database Schema Template
 * Initializes all required tables for a single school's database.
 */

function createSchoolDatabaseSchema(db) {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      // 1. Roll slip templates
      db.run(`
        CREATE TABLE IF NOT EXISTS roll_slip_templates (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT,
          template_json TEXT,
          is_active INTEGER DEFAULT 0,
          created_at TEXT
        )
      `);

      // 2. Students table
      db.run(`
        CREATE TABLE IF NOT EXISTS students (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          student_id TEXT,
          admission_no TEXT,
          roll_no TEXT,
          name TEXT,
          father_name TEXT,
          class_name TEXT,
          phone TEXT,
          photo TEXT,
          dob TEXT,
          dob_words TEXT,
          admission_date TEXT,
          admission_class TEXT,
          slc_no TEXT,
          national_id TEXT,
          religion TEXT,
          gender TEXT,
          status TEXT,
          discount_amount REAL DEFAULT 0,
          discount_percent REAL DEFAULT 0,
          is_free INTEGER DEFAULT 0,
          section_name TEXT,
          family_head_id INTEGER,
          transport_fee REAL DEFAULT 0,
          added_to_family_date TEXT,
          added_by_student_id INTEGER,
          address TEXT,
          previous_school TEXT,
          previous_school_contact TEXT,
          blood_group TEXT,
          school_id INTEGER
        )
      `);

      // 3. Sections table
      db.run(`
        CREATE TABLE IF NOT EXISTS sections (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          class_name TEXT NOT NULL,
          section_name TEXT NOT NULL,
          school_id INTEGER,
          UNIQUE(class_name, section_name)
        )
      `);

      // 4. Class fees
      db.run(`
        CREATE TABLE IF NOT EXISTS class_fees (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          class_name TEXT UNIQUE,
          monthly_fee REAL DEFAULT 0,
          school_id INTEGER
        )
      `);

      // 5. Student fee exceptions
      db.run(`
        CREATE TABLE IF NOT EXISTS student_fee_exceptions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          student_id INTEGER UNIQUE,
          discount_amount REAL DEFAULT 0,
          is_free INTEGER DEFAULT 0,
          school_id INTEGER
        )
      `);

      // 6. Fee ledger
      db.run(`
        CREATE TABLE IF NOT EXISTS fee_ledger (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          student_id INTEGER,
          class_name TEXT,
          section_name TEXT,
          month TEXT,
          year INTEGER,
          base_fee REAL,
          discount REAL,
          monthly_fee REAL,
          previous_due REAL,
          total_payable REAL,
          paid_amount REAL DEFAULT 0,
          status TEXT,
          transport_fee REAL DEFAULT 0,
          school_id INTEGER,
          created_at TEXT
        )
      `);

      // 7. Attendance
      db.run(`
        CREATE TABLE IF NOT EXISTS attendance (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          student_id INTEGER,
          class_name TEXT,
          section_name TEXT,
          date TEXT,
          status TEXT,
          time TEXT,
          school_id INTEGER
        )
      `);

      db.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_unique
        ON attendance (student_id, date)
      `);

      // 8. Fee payments
      db.run(`
        CREATE TABLE IF NOT EXISTS fee_payments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          student_id INTEGER,
          class_name TEXT,
          month TEXT,
          year INTEGER,
          amount_paid REAL,
          payment_date TEXT,
          fee_ledger_id INTEGER,
          school_id INTEGER
        )
      `);

      // 9. Fee dues (Opening Dues)
      db.run(`
        CREATE TABLE IF NOT EXISTS fee_dues (
          student_id INTEGER PRIMARY KEY,
          due_amount REAL DEFAULT 0,
          school_id INTEGER
        )
      `);

      // 10. Past dues list
      db.run(`
        CREATE TABLE IF NOT EXISTS past_dues (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          student_id INTEGER NOT NULL,
          amount REAL NOT NULL DEFAULT 0,
          note TEXT,
          created_at TEXT
        )
      `);

      // 11. Fee reminder templates
      db.run(`
        CREATE TABLE IF NOT EXISTS fee_reminder_templates (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT,
          template_json TEXT,
          is_active INTEGER DEFAULT 0,
          created_at TEXT
        )
      `);

      // 12. Date sheet templates
      db.run(`
        CREATE TABLE IF NOT EXISTS date_sheet_templates (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT,
          template_json TEXT,
          is_active INTEGER DEFAULT 0
        )
      `);

      // 13. Exams
      db.run(`
        CREATE TABLE IF NOT EXISTS exams (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          exam_name TEXT,
          year INTEGER,
          classes TEXT DEFAULT '[]',
          school_id INTEGER
        )
      `);
      // Migration: add classes column to existing exams tables
      db.run(`ALTER TABLE exams ADD COLUMN classes TEXT DEFAULT '[]'`, () => {});

      // 14. Exam subjects
      db.run(`
        CREATE TABLE IF NOT EXISTS exam_subjects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          exam_id INTEGER,
          class TEXT,
          subject TEXT,
          max_marks INTEGER,
          term TEXT DEFAULT '1st Term',
          school_id INTEGER
        )
      `);

      // 15. Marks
      db.run(`
        CREATE TABLE IF NOT EXISTS marks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          student_id INTEGER,
          exam_id INTEGER,
          subject TEXT,
          marks INTEGER,
          term TEXT DEFAULT '1st Term',
          school_id INTEGER
        )
      `);

      // 16. DMC templates
      db.run(`
        CREATE TABLE IF NOT EXISTS dmc_templates (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT,
          template_json TEXT,
          is_active INTEGER DEFAULT 0,
          created_at TEXT
        )
      `);

      // 17. Results
      db.run(`
        CREATE TABLE IF NOT EXISTS results (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          student_id INTEGER,
          exam_id INTEGER,
          term TEXT,
          total INTEGER,
          obtained INTEGER,
          percentage REAL,
          grade TEXT,
          position INTEGER,
          remarks TEXT,
          school_id INTEGER
        )
      `);

      // 18. Student promotion history
      db.run(`
        CREATE TABLE IF NOT EXISTS student_promotion_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          student_id INTEGER NOT NULL,
          from_class TEXT,
          to_class TEXT,
          exam_year INTEGER,
          promotion_date TEXT,
          final_percentage REAL,
          final_grade TEXT,
          remarks TEXT,
          school_id INTEGER
        )
      `);

      // 19. School details / fee settings
      db.run(`
        CREATE TABLE IF NOT EXISTS fee_settings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          school_name TEXT,
          logo_path TEXT,
          footer_text TEXT,
          phone TEXT,
          registration_number TEXT
        )
      `);

      // 20. Users table (for staff/teachers login within the school tenant)
      db.run(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE,
          password TEXT,
          role TEXT
        )
      `);

      // 21. Settings table
      db.run(`
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT
        )
      `);

      // 22. Holidays table (Festival / Holiday tracking)
      db.run(`
        CREATE TABLE IF NOT EXISTS holidays (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          date TEXT NOT NULL,
          name TEXT NOT NULL,
          type TEXT DEFAULT 'Holiday',
          school_id INTEGER
        )
      `);

      db.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_holidays_date
        ON holidays (date)
      `);

      // 23. Result sections (Virtual roll range splitting)
      db.run(`
        CREATE TABLE IF NOT EXISTS result_sections (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          class_name TEXT NOT NULL,
          section_name TEXT NOT NULL,
          roll_start INTEGER NOT NULL,
          roll_end INTEGER NOT NULL,
          UNIQUE(class_name, section_name)
        )
      `);

      // 24. Teachers table (for teacher portal login)
      db.run(`
        CREATE TABLE IF NOT EXISTS teachers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          phone TEXT UNIQUE NOT NULL,
          password TEXT NOT NULL,
          subject TEXT,
          qualification TEXT,
          status TEXT DEFAULT 'Active',
          school_id INTEGER,
          created_at TEXT,
          assigned_class TEXT DEFAULT '',
          can_collect_fees INTEGER DEFAULT 0
        )
      `);

      // 25. Parents table (for parent portal login)
      db.run(`
        CREATE TABLE IF NOT EXISTS parents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          phone TEXT UNIQUE NOT NULL,
          password TEXT NOT NULL,
          cnic TEXT,
          address TEXT,
          status TEXT DEFAULT 'Active',
          school_id INTEGER,
          created_at TEXT
        )
      `);

      // 26. Student-Parent mapping
      db.run(`
        CREATE TABLE IF NOT EXISTS student_parents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          student_id INTEGER NOT NULL,
          parent_id INTEGER NOT NULL,
          relation TEXT DEFAULT 'Father',
          school_id INTEGER,
          UNIQUE(student_id, parent_id)
        )
      `);

      // 27. Timetable
      db.run(`
        CREATE TABLE IF NOT EXISTS timetable (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          class_name TEXT NOT NULL,
          section_name TEXT,
          day TEXT NOT NULL,
          period INTEGER NOT NULL,
          start_time TEXT,
          end_time TEXT,
          subject TEXT,
          teacher_id INTEGER,
          room TEXT,
          UNIQUE(class_name, section_name, day, period)
        )
      `);

      // 28. Saved Fee Reminders
      db.run(`
        CREATE TABLE IF NOT EXISTS fee_reminders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT,
          class_name TEXT,
          section_name TEXT,
          year INTEGER,
          student_ids TEXT,
          total_amount REAL DEFAULT 0,
          student_count INTEGER DEFAULT 0,
          status TEXT DEFAULT 'Draft',
          created_at TEXT,
          printed_at TEXT
        )
      `);

      // 29. Announcements table
      db.run(`
        CREATE TABLE IF NOT EXISTS announcements (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          message TEXT,
          target_role TEXT DEFAULT 'all',
          created_by TEXT,
          created_at TEXT
        )
      `);

      // 30. Assignments table (homework, tests, projects shared by teachers)
      db.run(`
        CREATE TABLE IF NOT EXISTS assignments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          teacher_id INTEGER,
          teacher_name TEXT,
          subject TEXT,
          class_name TEXT,
          section_name TEXT,
          title TEXT NOT NULL,
          description TEXT,
          type TEXT DEFAULT 'homework',
          due_date TEXT,
          priority TEXT DEFAULT 'medium',
          school_id INTEGER,
          created_at TEXT
        )
      `);

      // 31. Student Certificates (always ensure exists for existing DBs)
      db.run(`CREATE TABLE IF NOT EXISTS student_certificates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        school_id INTEGER,
        student_id INTEGER NOT NULL,
        certificate_name TEXT NOT NULL,
        certificate_type TEXT DEFAULT 'General',
        issue_date TEXT,
        description TEXT,
        created_at TEXT
      )`);

      // 32. Student Documents
      db.run(`CREATE TABLE IF NOT EXISTS student_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        school_id INTEGER,
        student_id INTEGER NOT NULL,
        document_name TEXT NOT NULL,
        document_type TEXT DEFAULT 'Other',
        upload_date TEXT,
        description TEXT,
        file_data TEXT,
        created_at TEXT
      )`);

      // 33. Student Transfer History
      db.run(`CREATE TABLE IF NOT EXISTS student_transfer_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        school_id INTEGER,
        student_id INTEGER NOT NULL,
        transfer_date TEXT,
        from_class TEXT,
        to_class TEXT,
        to_school TEXT,
        reason TEXT,
        remarks TEXT,
        created_at TEXT
      )`);

      // Migrations: Add teacher_id to marks if missing
      db.all("PRAGMA table_info(marks)", (err, columns) => {
        if (!err && Array.isArray(columns)) {
          const hasTeacherId = columns.some(c => c.name === 'teacher_id');
          if (!hasTeacherId) {
            db.run("ALTER TABLE marks ADD COLUMN teacher_id INTEGER", (e) => {
              if (e) console.error('Migration: failed to add teacher_id to marks:', e.message);
              else console.log('Migration: added teacher_id to marks table');
            });
          }
        }
      });

      // Migration: Add school_id to teachers if missing
      db.all("PRAGMA table_info(teachers)", (err, columns) => {
        if (!err && Array.isArray(columns)) {
          const hasSchoolId = columns.some(c => c.name === 'school_id');
          if (!hasSchoolId) {
            db.run("ALTER TABLE teachers ADD COLUMN school_id INTEGER", (e) => {
              if (e) console.error('Migration: failed to add school_id to teachers:', e.message);
              else console.log('Migration: added school_id to teachers table');
            });
          }
          const hasAssignedClass = columns.some(c => c.name === 'assigned_class');
          if (!hasAssignedClass) {
            db.run("ALTER TABLE teachers ADD COLUMN assigned_class TEXT DEFAULT ''", (e) => {
              if (e) console.error('Migration: failed to add assigned_class to teachers:', e.message);
              else console.log('Migration: added assigned_class to teachers table');
            });
          }
          const hasCanCollectFees = columns.some(c => c.name === 'can_collect_fees');
          if (!hasCanCollectFees) {
            db.run("ALTER TABLE teachers ADD COLUMN can_collect_fees INTEGER DEFAULT 0", (e) => {
              if (e) console.error('Migration: failed to add can_collect_fees to teachers:', e.message);
              else console.log('Migration: added can_collect_fees to teachers table');
            });
          }
        }
      });

      // Migration: Add school_id to student_certificates if missing
      db.all("PRAGMA table_info(student_certificates)", (err, columns) => {
        if (!err && Array.isArray(columns)) {
          const has = columns.some(c => c.name === 'school_id');
          if (!has) {
            db.run("ALTER TABLE student_certificates ADD COLUMN school_id INTEGER", () => {});
          }
        }
      });

      // Migration: Add school_id to student_documents if missing
      db.all("PRAGMA table_info(student_documents)", (err, columns) => {
        if (!err && Array.isArray(columns)) {
          const has = columns.some(c => c.name === 'school_id');
          if (!has) {
            db.run("ALTER TABLE student_documents ADD COLUMN school_id INTEGER", () => {});
          }
        }
      });

      // Migration: Add school_id to student_transfer_history if missing
      db.all("PRAGMA table_info(student_transfer_history)", (err, columns) => {
        if (!err && Array.isArray(columns)) {
          const has = columns.some(c => c.name === 'school_id');
          if (!has) {
            db.run("ALTER TABLE student_transfer_history ADD COLUMN school_id INTEGER", () => {});
          }
        }
      });

      // 34. Transport Vehicles
      db.run(`
        CREATE TABLE IF NOT EXISTS transport_vehicles (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          school_id INTEGER NOT NULL,
          name TEXT,
          plate_number TEXT,
          type TEXT DEFAULT 'Bus',
          capacity INTEGER DEFAULT 0,
          status TEXT DEFAULT 'Active',
          monthly_fee REAL DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);

      // 35. Transport Drivers
      db.run(`
        CREATE TABLE IF NOT EXISTS transport_drivers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          school_id INTEGER NOT NULL,
          name TEXT,
          phone TEXT,
          license_number TEXT,
          address TEXT,
          vehicle_id INTEGER,
          status TEXT DEFAULT 'Active',
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);

      // 36. Transport Routes
      db.run(`
        CREATE TABLE IF NOT EXISTS transport_routes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          school_id INTEGER NOT NULL,
          name TEXT,
          pickup_locations TEXT DEFAULT '[]',
          drop_locations TEXT DEFAULT '[]',
          vehicle_id INTEGER,
          monthly_fee REAL DEFAULT 0,
          status TEXT DEFAULT 'Active',
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);

      // 37. Transport Assignments (Student-Vehicle-Route)
      db.run(`
        CREATE TABLE IF NOT EXISTS transport_assignments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          school_id INTEGER NOT NULL,
          student_id INTEGER NOT NULL,
          vehicle_id INTEGER,
          route_id INTEGER,
          pickup_point TEXT,
          drop_point TEXT,
          monthly_fee REAL DEFAULT 0,
          status TEXT DEFAULT 'Active',
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);

      // 38. Teacher Salary Structure
      db.run(`
        CREATE TABLE IF NOT EXISTS teacher_salaries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          teacher_id INTEGER NOT NULL,
          basic_salary REAL DEFAULT 0,
          house_allowance REAL DEFAULT 0,
          medical_allowance REAL DEFAULT 0,
          transport_allowance REAL DEFAULT 0,
          other_allowances REAL DEFAULT 0,
          deductions REAL DEFAULT 0,
          tax REAL DEFAULT 0,
          effective_date TEXT,
          school_id INTEGER,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);

      // 39. Salary Payments
      db.run(`
        CREATE TABLE IF NOT EXISTS salary_payments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          teacher_id INTEGER NOT NULL,
          month TEXT NOT NULL,
          year INTEGER NOT NULL,
          basic_salary REAL DEFAULT 0,
          allowances REAL DEFAULT 0,
          deductions REAL DEFAULT 0,
          tax REAL DEFAULT 0,
          net_salary REAL DEFAULT 0,
          payment_date TEXT,
          payment_method TEXT DEFAULT 'Cash',
          reference_no TEXT,
          remarks TEXT,
          paid_by TEXT,
          school_id INTEGER,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);

      // Migrations: Add address column to students if missing
      db.all("PRAGMA table_info(students)", (err, columns) => {
        if (!err && Array.isArray(columns)) {
          const hasAddress = columns.some(c => c.name === 'address');
          if (!hasAddress) {
            db.run("ALTER TABLE students ADD COLUMN address TEXT", (e) => {
              if (e) console.error('Migration: failed to add address to students:', e.message);
              else console.log('Migration: added address to students table');
            });
          }
          const hasPrevSchool = columns.some(c => c.name === 'previous_school');
          if (!hasPrevSchool) {
            db.run("ALTER TABLE students ADD COLUMN previous_school TEXT", (e) => {
              if (e) console.error('Migration: failed to add previous_school to students:', e.message);
              else console.log('Migration: added previous_school to students table');
            });
          }
          const hasPrevSchoolContact = columns.some(c => c.name === 'previous_school_contact');
          if (!hasPrevSchoolContact) {
            db.run("ALTER TABLE students ADD COLUMN previous_school_contact TEXT", (e) => {
              if (e) console.error('Migration: failed to add previous_school_contact to students:', e.message);
              else console.log('Migration: added previous_school_contact to students table');
            });
          }
          const HasBloodGroup = columns.some(c => c.name === 'blood_group');
          if (!HasBloodGroup) {
            db.run("ALTER TABLE students ADD COLUMN blood_group TEXT", (e) => {
              if (e) console.error('Migration: failed to add blood_group to students:', e.message);
              else console.log('Migration: added blood_group to students table');
            });
          }
        }
      });

      // Populate default settings & master user
      db.get("SELECT COUNT(*) as count FROM users", (err, row) => {
        if (!err && row.count === 0) {
          // Default admin: admin/admin123, teacher: teacher/teacher123
          // Password will be hashed by auth endpoint upon login or setup,
          // but we store them plain or hashed.
          // Let's store them hashed (using bcrypt default values, or keep plain text as in Py5, but hashed is much better online!
          // We will use standard bcrypt hashes for:
          // admin123 -> $2a$10$U.9Vd6Fas5k26Cwq/M6V5ehZ4T.O3M0mDSw4WzP777Cez8/b8kG2y
          // teacher123 -> $2a$10$1r2/K69fLwJ1W8s1v5Gqg.R9Zl1ZlX/lP.X1wX1P6p2r1X1gP.q3G
          const adminHash = '$2a$10$U.9Vd6Fas5k26Cwq/M6V5ehZ4T.O3M0mDSw4WzP777Cez8/b8kG2y'; // 'admin123'
          const teacherHash = '$2a$10$1r2/K69fLwJ1W8s1v5Gqg.R9Zl1ZlX/lP.X1wX1P6p2r1X1gP.q3G'; // 'teacher123'
          db.run("INSERT INTO users (username, password, role) VALUES (?, ?, ?)", ["admin", adminHash, "admin"]);
          db.run("INSERT INTO users (username, password, role) VALUES (?, ?, ?)", ["teacher", teacherHash, "teacher"]);
        }
      });

      db.get("SELECT COUNT(*) as count FROM settings WHERE key='master_pin'", (err, row) => {
        if (!err && row.count === 0) {
          db.run("INSERT INTO settings (key, value) VALUES ('master_pin', 'goldensunbk')");
        }
      });

      // Performance indexes for frequently queried columns
      db.run(`CREATE INDEX IF NOT EXISTS idx_students_class_section ON students(class_name, section_name, status)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_students_family_head ON students(family_head_id)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_students_status ON students(status)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_fee_ledger_student ON fee_ledger(student_id)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_fee_ledger_month_year ON fee_ledger(month, year)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_fee_ledger_class_month ON fee_ledger(class_name, month, year)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_fee_payments_student ON fee_payments(student_id)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_marks_student_exam ON marks(student_id, exam_id, term)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_marks_exam_subject ON marks(exam_id, subject, term)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_results_student_exam ON results(student_id, exam_id, term)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_results_exam_term ON results(exam_id, term)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_attendance_class_date ON attendance(class_name, date)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_exam_subjects_exam_class ON exam_subjects(exam_id, class, term)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_assignments_teacher ON assignments(teacher_id)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_assignments_class ON assignments(class_name, section_name)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_timetable_teacher ON timetable(teacher_id)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_student_parents_student ON student_parents(student_id)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_student_parents_parent ON student_parents(parent_id)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_promotion_history_student ON student_promotion_history(student_id)`);

      db.run("PRAGMA user_version = 1", (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

function migrateSchoolDatabase(db) {
  return new Promise((resolve, reject) => {
    db.run(`
      CREATE TABLE IF NOT EXISTS holidays (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT DEFAULT 'Holiday',
        school_id INTEGER
      )
    `, (err1) => {
      if (err1) { console.error('[MIGRATE] holidays table error:', err1.message); }
      db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_holidays_date ON holidays (date)`, (err2) => {
        if (err2) { console.error('[MIGRATE] holidays index error:', err2.message); }
        resolve();
      });
    });
  });
}

module.exports = {
  createSchoolDatabaseSchema,
  migrateSchoolDatabase
};
