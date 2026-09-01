const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const config = require('./config');
const { createSchoolDatabaseSchema } = require('./school_db_template');

let libsql = null;
if (config.useTurso) {
  libsql = require('@libsql/client');
}

const mainDbPath = path.join(config.DATABASES_DIR, 'main.db');
let mainDb = null;
const schoolDbCache = {};

let tursoClient = null;

function getTursoClient() {
  if (!tursoClient) {
    tursoClient = libsql.createClient({
      url: config.TURSO_URL,
      authToken: config.TURSO_AUTH_TOKEN,
    });
  }
  return tursoClient;
}

function getMainDb() {
  if (!mainDb) {
    if (!fs.existsSync(mainDbPath)) {
      console.warn('main.db not found at', mainDbPath, '- will be created by initMainDb');
    }
    mainDb = new sqlite3.Database(mainDbPath, (err) => {
      if (err) {
        console.error('CRITICAL: Failed to open main.db:', err);
      }
    });
  }
  return mainDb;
}

function resetMainDb() {
  if (mainDb) {
    try { mainDb.close(); } catch (e) {}
    mainDb = null;
  }
}

async function queryMain(sql, params = []) {
  if (config.useTurso) {
    const result = await getTursoClient().execute({ sql, args: params });
    return result.rows;
  }
  const db = getMainDb();
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function queryMainOne(sql, params = []) {
  if (config.useTurso) {
    const result = await getTursoClient().execute({ sql, args: params });
    return result.rows[0] || null;
  }
  const db = getMainDb();
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

async function runMain(sql, params = []) {
  if (config.useTurso) {
    const result = await getTursoClient().execute({ sql, args: params });
    return { id: Number(result.lastInsertRowid), changes: result.rowsAffected };
  }
  const db = getMainDb();
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

// Dynamic school db connection pool
function getSchoolDb(schoolId) {
  return new Promise((resolve, reject) => {
    if (schoolDbCache[schoolId]) {
      return resolve(schoolDbCache[schoolId]);
    }

    const lookupAndConnect = async () => {
      let school;
      if (config.useTurso) {
        const result = await getTursoClient().execute({
          sql: 'SELECT db_file FROM schools WHERE id = ?',
          args: [schoolId]
        });
        school = result.rows[0] || null;
      } else {
        school = await new Promise((res, rej) => {
          const db = getMainDb();
          db.get('SELECT db_file FROM schools WHERE id = ?', [schoolId], (err, row) => {
            if (err) rej(err);
            else res(row);
          });
        });
      }

      if (!school) {
        throw new Error('School not found or invalid tenant ID');
      }

      const schoolDbPath = path.join(config.DATABASES_DIR, school.db_file);

      const dir = path.dirname(schoolDbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const schoolDb = new sqlite3.Database(schoolDbPath, (dbErr) => {
        if (dbErr) {
          console.error(`Failed to connect to tenant database ${school.db_file}:`, dbErr);
          return reject(dbErr);
        }

        createSchoolDatabaseSchema(schoolDb)
          .then(() => {
            schoolDbCache[schoolId] = schoolDb;
            resolve(schoolDb);
          })
          .catch((schemaErr) => {
            console.error(`Schema initialization failed for tenant ${school.db_file}:`, schemaErr);
            reject(schemaErr);
          });
      });
    };

    lookupAndConnect().catch(reject);
  });
}

// Helper methods for querying school DBs
function querySchool(schoolId, sql, params = []) {
  return getSchoolDb(schoolId).then((db) => {
    return new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  });
}

function querySchoolOne(schoolId, sql, params = []) {
  return getSchoolDb(schoolId).then((db) => {
    return new Promise((resolve, reject) => {
      db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  });
}

function runSchool(schoolId, sql, params = []) {
  return getSchoolDb(schoolId).then((db) => {
    return new Promise((resolve, reject) => {
      db.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve({ id: this.lastID, changes: this.changes });
      });
    });
  });
}

// Transaction runner for school db
function runSchoolTransaction(schoolId, statements) {
  return getSchoolDb(schoolId).then((db) => {
    return new Promise((resolve, reject) => {
      db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        
        const executeNext = (index) => {
          if (index >= statements.length) {
            db.run('COMMIT', (err) => {
              if (err) reject(err);
              else resolve();
            });
            return;
          }

          const { sql, params } = statements[index];
          db.run(sql, params || [], (err) => {
            if (err) {
              db.run('ROLLBACK');
              reject(err);
            } else {
              executeNext(index + 1);
            }
          });
        };

        executeNext(0);
      });
    });
  });
}

function closeSchoolDb(schoolId) {
  return new Promise((resolve) => {
    const db = schoolDbCache[schoolId];
    if (db) {
      db.close((err) => {
        if (err) console.error(`Error closing database for school ${schoolId}:`, err);
        delete schoolDbCache[schoolId];
        resolve();
      });
    } else {
      resolve();
    }
  });
}

module.exports = {
  queryMain,
  queryMainOne,
  runMain,
  getSchoolDb,
  querySchool,
  querySchoolOne,
  runSchool,
  runSchoolTransaction,
  closeSchoolDb,
  resetMainDb
};
