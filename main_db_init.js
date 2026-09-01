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

  console.log('main.db initialized successfully via Turso.');
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
