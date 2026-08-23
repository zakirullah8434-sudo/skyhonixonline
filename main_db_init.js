const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const config = require('./config');

// Ensure database directories exist
if (!fs.existsSync(config.DATABASES_DIR)) {
  fs.mkdirSync(config.DATABASES_DIR, { recursive: true });
}
if (!fs.existsSync(config.UPLOADS_DIR)) {
  fs.mkdirSync(config.UPLOADS_DIR, { recursive: true });
}
if (!fs.existsSync(config.BACKUPS_DIR)) {
  fs.mkdirSync(config.BACKUPS_DIR, { recursive: true });
}

const mainDbPath = path.join(config.DATABASES_DIR, 'main.db');

function initMainDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(mainDbPath, (err) => {
      if (err) {
        console.error('Failed to open main.db:', err);
        return reject(err);
      }

      db.serialize(() => {
        // Create schools table
        db.run(`
          CREATE TABLE IF NOT EXISTS schools (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            school_name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            db_file TEXT UNIQUE NOT NULL,
            subscription_status TEXT DEFAULT 'suspended', -- 'active', 'suspended', 'trial'
            subscription_amount REAL DEFAULT 1500,
            next_due_date TEXT,
            created_at TEXT,
            phone TEXT,
            school_code TEXT UNIQUE
          )
        `, (err) => {
          if (!err) {
            db.run(`ALTER TABLE schools ADD COLUMN phone TEXT`, () => {});
            db.run(`ALTER TABLE schools ADD COLUMN school_code TEXT`, () => {});
          }
        });

        // Create payment slips table
        db.run(`
          CREATE TABLE IF NOT EXISTS payment_slips (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            school_id INTEGER,
            payment_date TEXT,
            amount REAL,
            receipt_photo TEXT,
            status TEXT DEFAULT 'pending', -- 'pending', 'approved', 'rejected'
            notes TEXT,
            submitted_at TEXT,
            FOREIGN KEY (school_id) REFERENCES schools(id)
          )
        `);

        // Create admin users table
        db.run(`
          CREATE TABLE IF NOT EXISTS admin_users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            name TEXT,
            created_at TEXT,
            last_login TEXT
          )
        `, async (err) => {
          if (!err) {
            // Check if default admin exists, if not create one
            db.get('SELECT id FROM admin_users WHERE email = ?', ['skyhonix56@gmail.com'], async (err, row) => {
              if (!row) {
                try {
                  const salt = await bcrypt.genSalt(10);
                  const hashedPassword = await bcrypt.hash('skyhonixthegreat', salt);
                  db.run(
                    'INSERT INTO admin_users (email, password, name, created_at) VALUES (?, ?, ?, ?)',
                    ['skyhonix56@gmail.com', hashedPassword, 'Master Admin', new Date().toISOString()],
                    (err) => {
                      if (err) console.error('Error creating default admin:', err);
                      else console.log('Default admin user created: skyhonix56@gmail.com / skyhonixthegreat');
                    }
                  );
                } catch (hashErr) {
                  console.error('Error hashing admin password:', hashErr);
                }
              }
            });
          }
        });

        console.log('main.db initialized successfully.');
        db.close(resolve);
      });
    });
  });
}

if (require.main === module) {
  initMainDb().then(() => console.log('Done'));
}

module.exports = {
  initMainDb,
  mainDbPath
};
