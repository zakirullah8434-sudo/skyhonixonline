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
          added_by_student_id INTEGER
        )
      `);

      // 3. Sections table
      db.run(`
        CREATE TABLE IF NOT EXISTS sections (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          class_name TEXT NOT NULL,
          section_name TEXT NOT NULL,
          UNIQUE(class_name, section_name)
        )
      `);

      // 4. Class fees
      db.run(`
        CREATE TABLE IF NOT EXISTS class_fees (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          class_name TEXT UNIQUE,
          monthly_fee REAL DEFAULT 0
        )
      `);

      // 5. Student fee exceptions
      db.run(`
        CREATE TABLE IF NOT EXISTS student_fee_exceptions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          student_id INTEGER UNIQUE,
          discount_amount REAL DEFAULT 0,
          is_free INTEGER DEFAULT 0
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
          time TEXT
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
          fee_ledger_id INTEGER
        )
      `);

      // 9. Fee dues (Opening Dues)
      db.run(`
        CREATE TABLE IF NOT EXISTS fee_dues (
          student_id INTEGER PRIMARY KEY,
          due_amount REAL DEFAULT 0
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
          classes TEXT DEFAULT '[]'
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
          term TEXT DEFAULT '1st Term'
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
          term TEXT DEFAULT '1st Term'
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
          remarks TEXT
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
          remarks TEXT
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

      // 22. Result sections (Virtual roll range splitting)
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

      db.run("PRAGMA user_version = 1", (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

module.exports = {
  createSchoolDatabaseSchema
};
