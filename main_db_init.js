const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const config = require('./config');

const mainDbPath = path.join(config.DATABASES_DIR, 'main.db');

let libsql = null;
let tursoClient = null;
if (config.useTurso) {
  libsql = require('@libsql/client');
}

function getTursoClient() {
  if (!tursoClient) {
    tursoClient = libsql.createClient({
      url: config.TURSO_URL,
      authToken: config.TURSO_AUTH_TOKEN,
    });
  }
  return tursoClient;
}

function runDb(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) resolve({ error: err }); // resolve not reject — migrations are best-effort
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function getDb(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function closeDb(db) {
  return new Promise((resolve) => {
    db.close((err) => {
      if (err) console.error('Error closing DB:', err);
      resolve();
    });
  });
}

async function runTurso(sql, params = []) {
  try {
    await getTursoClient().execute({ sql, args: params });
    return { changes: 1 };
  } catch (err) {
    return { error: err };
  }
}

async function getTursoOne(sql, params = []) {
  const result = await getTursoClient().execute({ sql, args: params });
  return result.rows[0] || null;
}

async function initMainDbTurso() {
  const client = getTursoClient();

  await client.execute(`CREATE TABLE IF NOT EXISTS schools (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    db_file TEXT UNIQUE NOT NULL,
    subscription_status TEXT DEFAULT 'pending',
    subscription_amount REAL DEFAULT 1500,
    next_due_date TEXT,
    created_at TEXT,
    phone TEXT,
    school_code TEXT UNIQUE
  )`);

  const migrations = [
    'ALTER TABLE schools ADD COLUMN phone TEXT',
    'ALTER TABLE schools ADD COLUMN school_code TEXT',
    'ALTER TABLE schools ADD COLUMN selected_package TEXT'
  ];
  for (const m of migrations) {
    try { await client.execute(m); } catch (e) { /* column already exists */ }
  }

  await client.execute(`CREATE TABLE IF NOT EXISTS payment_slips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER,
    payment_date TEXT,
    amount REAL,
    receipt_photo TEXT,
    status TEXT DEFAULT 'pending',
    notes TEXT,
    submitted_at TEXT,
    FOREIGN KEY (school_id) REFERENCES schools(id)
  )`);

  await client.execute(`CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    name TEXT,
    created_at TEXT,
    last_login TEXT
  )`);

  const admin = await getTursoOne('SELECT id FROM admin_users WHERE email = ?', ['skyhonix56@gmail.com']);
  if (!admin) {
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash('skyhonixthegreat', salt);
    await client.execute({
      sql: 'INSERT INTO admin_users (email, password, name, created_at) VALUES (?, ?, ?, ?)',
      args: ['skyhonix56@gmail.com', hashedPassword, 'Master Admin', new Date().toISOString()]
    });
    console.log('Default admin user created (Turso): skyhonix56@gmail.com / skyhonixthegreat');
  }

  await initSchoolTablesTurso(client);

  console.log('main.db initialized successfully via Turso.');
}

async function initSchoolTablesTurso(client) {
  const t = async (sql) => {
    try { await client.execute(sql); } catch (e) { /* ignore */ }
  };

  await t(`CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER NOT NULL,
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
  )`);

  await t(`CREATE TABLE IF NOT EXISTS sections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER NOT NULL,
    class_name TEXT NOT NULL,
    section_name TEXT NOT NULL,
    UNIQUE(school_id, class_name, section_name)
  )`);

  await t(`CREATE TABLE IF NOT EXISTS class_fees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER NOT NULL,
    class_name TEXT,
    monthly_fee REAL DEFAULT 0,
    UNIQUE(school_id, class_name)
  )`);

  await t(`CREATE TABLE IF NOT EXISTS student_fee_exceptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER NOT NULL,
    student_id INTEGER,
    discount_amount REAL DEFAULT 0,
    is_free INTEGER DEFAULT 0,
    UNIQUE(school_id, student_id)
  )`);

  await t(`CREATE TABLE IF NOT EXISTS fee_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER NOT NULL,
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
  )`);

  await t(`CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER NOT NULL,
    student_id INTEGER,
    class_name TEXT,
    section_name TEXT,
    date TEXT,
    status TEXT,
    time TEXT,
    UNIQUE(school_id, student_id, date)
  )`);

  await t(`CREATE TABLE IF NOT EXISTS fee_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER NOT NULL,
    student_id INTEGER,
    class_name TEXT,
    month TEXT,
    year INTEGER,
    amount_paid REAL,
    payment_date TEXT,
    fee_ledger_id INTEGER
  )`);

  await t(`CREATE TABLE IF NOT EXISTS fee_dues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER NOT NULL,
    student_id INTEGER,
    due_amount REAL DEFAULT 0,
    UNIQUE(school_id, student_id)
  )`);

  await t(`CREATE TABLE IF NOT EXISTS past_dues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER NOT NULL,
    student_id INTEGER,
    amount REAL NOT NULL DEFAULT 0,
    note TEXT,
    created_at TEXT
  )`);

  await t(`CREATE TABLE IF NOT EXISTS fee_reminder_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER NOT NULL,
    name TEXT,
    template_json TEXT,
    is_active INTEGER DEFAULT 0,
    created_at TEXT
  )`);

  await t(`CREATE TABLE IF NOT EXISTS date_sheet_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER NOT NULL,
    name TEXT,
    template_json TEXT,
    is_active INTEGER DEFAULT 0
  )`);

  await t(`CREATE TABLE IF NOT EXISTS exams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER NOT NULL,
    exam_name TEXT,
    year INTEGER,
    classes TEXT DEFAULT '[]'
  )`);

  await t(`CREATE TABLE IF NOT EXISTS exam_subjects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER NOT NULL,
    exam_id INTEGER,
    class TEXT,
    subject TEXT,
    max_marks INTEGER,
    term TEXT DEFAULT '1st Term'
  )`);

  await t(`CREATE TABLE IF NOT EXISTS marks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER NOT NULL,
    student_id INTEGER,
    exam_id INTEGER,
    subject TEXT,
    marks INTEGER,
    term TEXT DEFAULT '1st Term',
    teacher_id INTEGER
  )`);

  await t(`CREATE TABLE IF NOT EXISTS dmc_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER NOT NULL,
    name TEXT,
    template_json TEXT,
    is_active INTEGER DEFAULT 0,
    created_at TEXT
  )`);

  await t(`CREATE TABLE IF NOT EXISTS results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER NOT NULL,
    student_id INTEGER,
    exam_id INTEGER,
    term TEXT,
    total INTEGER,
    obtained INTEGER,
    percentage REAL,
    grade TEXT,
    position INTEGER,
    remarks TEXT
  )`);

  await t(`CREATE TABLE IF NOT EXISTS student_promotion_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER NOT NULL,
    student_id INTEGER,
    from_class TEXT,
    to_class TEXT,
    exam_year INTEGER,
    promotion_date TEXT,
    final_percentage REAL,
    final_grade TEXT,
    remarks TEXT
  )`);

  await t(`CREATE TABLE IF NOT EXISTS fee_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER NOT NULL,
    school_name TEXT,
    logo_path TEXT,
    footer_text TEXT,
    phone TEXT,
    registration_number TEXT,
    UNIQUE(school_id)
  )`);

  await t(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER NOT NULL,
    username TEXT,
    password TEXT,
    role TEXT,
    UNIQUE(school_id, username)
  )`);

  await t(`CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER NOT NULL,
    key TEXT,
    value TEXT,
    UNIQUE(school_id, key)
  )`);

  await t(`CREATE TABLE IF NOT EXISTS result_sections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER NOT NULL,
    class_name TEXT NOT NULL,
    section_name TEXT NOT NULL,
    roll_start INTEGER NOT NULL,
    roll_end INTEGER NOT NULL,
    UNIQUE(school_id, class_name, section_name)
  )`);

  await t(`CREATE TABLE IF NOT EXISTS teachers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    password TEXT NOT NULL,
    subject TEXT,
    qualification TEXT,
    status TEXT DEFAULT 'Active',
    created_at TEXT,
    UNIQUE(school_id, phone)
  )`);

  await t(`CREATE TABLE IF NOT EXISTS parents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    password TEXT NOT NULL,
    cnic TEXT,
    address TEXT,
    status TEXT DEFAULT 'Active',
    created_at TEXT,
    UNIQUE(school_id, phone)
  )`);

  await t(`CREATE TABLE IF NOT EXISTS student_parents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER NOT NULL,
    student_id INTEGER NOT NULL,
    parent_id INTEGER NOT NULL,
    relation TEXT DEFAULT 'Father',
    UNIQUE(school_id, student_id, parent_id)
  )`);

  await t(`CREATE TABLE IF NOT EXISTS timetable (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER NOT NULL,
    class_name TEXT NOT NULL,
    section_name TEXT,
    day TEXT NOT NULL,
    period INTEGER NOT NULL,
    start_time TEXT,
    end_time TEXT,
    subject TEXT,
    teacher_id INTEGER,
    room TEXT,
    UNIQUE(school_id, class_name, section_name, day, period)
  )`);

  await t(`CREATE TABLE IF NOT EXISTS fee_reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER NOT NULL,
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
  )`);

  await t(`CREATE TABLE IF NOT EXISTS announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    message TEXT,
    target_role TEXT DEFAULT 'all',
    created_by TEXT,
    created_at TEXT
  )`);

  await t(`CREATE TABLE IF NOT EXISTS assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER NOT NULL,
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
    created_at TEXT
  )`);

  await t(`CREATE TABLE IF NOT EXISTS roll_slip_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER NOT NULL,
    name TEXT,
    template_json TEXT,
    is_active INTEGER DEFAULT 0,
    created_at TEXT
  )`);

  console.log('School tenant tables initialized in Turso.');
}

async function initMainDb() {
  if (config.useTurso) {
    return initMainDbTurso();
  }

  if (!fs.existsSync(config.DATABASES_DIR)) {
    fs.mkdirSync(config.DATABASES_DIR, { recursive: true });
  }
  if (!fs.existsSync(config.UPLOADS_DIR)) {
    fs.mkdirSync(config.UPLOADS_DIR, { recursive: true });
  }
  if (!fs.existsSync(config.BACKUPS_DIR)) {
    fs.mkdirSync(config.BACKUPS_DIR, { recursive: true });
  }

  const db = await new Promise((resolve, reject) => {
    const conn = new sqlite3.Database(mainDbPath, (err) => {
      if (err) {
        console.error('Failed to open main.db:', err);
        return reject(err);
      }
      resolve(conn);
    });
  });

  try {
    await runDb(db, `
      CREATE TABLE IF NOT EXISTS schools (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        school_name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        db_file TEXT UNIQUE NOT NULL,
        subscription_status TEXT DEFAULT 'pending',
        subscription_amount REAL DEFAULT 1500,
        next_due_date TEXT,
        created_at TEXT,
        phone TEXT,
        school_code TEXT UNIQUE
      )
    `);

    // Migrations for schools table
    await runDb(db, `ALTER TABLE schools ADD COLUMN phone TEXT`);
    await runDb(db, `ALTER TABLE schools ADD COLUMN school_code TEXT`);
    await runDb(db, `ALTER TABLE schools ADD COLUMN selected_package TEXT`);

    await runDb(db, `
      CREATE TABLE IF NOT EXISTS payment_slips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        school_id INTEGER,
        payment_date TEXT,
        amount REAL,
        receipt_photo TEXT,
        status TEXT DEFAULT 'pending',
        notes TEXT,
        submitted_at TEXT,
        FOREIGN KEY (school_id) REFERENCES schools(id)
      )
    `);

    await runDb(db, `
      CREATE TABLE IF NOT EXISTS admin_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        name TEXT,
        created_at TEXT,
        last_login TEXT
      )
    `);

    const admin = await getDb(db, 'SELECT id FROM admin_users WHERE email = ?', ['skyhonix56@gmail.com']);
    if (!admin) {
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash('skyhonixthegreat', salt);
      await runDb(db,
        'INSERT INTO admin_users (email, password, name, created_at) VALUES (?, ?, ?, ?)',
        ['skyhonix56@gmail.com', hashedPassword, 'Master Admin', new Date().toISOString()]
      );
      console.log('Default admin user created: skyhonix56@gmail.com / skyhonixthegreat');
    }

    console.log('main.db initialized successfully.');
  } finally {
    await closeDb(db);
  }
}

if (require.main === module) {
  initMainDb().then(() => console.log('Done'));
}

module.exports = {
  initMainDb,
  mainDbPath
};
