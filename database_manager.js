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

class SchoolDbTursoProxy {
  constructor(client, schoolId) {
    this.client = client;
    this.schoolId = schoolId;
  }

  _getFirstTable(sql) {
    const SQL_KEYWORDS = new Set([
      'WHERE', 'SET', 'VALUES', 'ORDER', 'GROUP', 'HAVING',
      'LIMIT', 'OFFSET', 'UNION', 'EXCEPT', 'INTERSECT',
      'INNER', 'LEFT', 'RIGHT', 'OUTER', 'CROSS', 'JOIN',
      'ON', 'AND', 'OR', 'NOT', 'INSERT', 'UPDATE', 'DELETE',
      'SELECT', 'FROM', 'INTO', 'CREATE', 'DROP', 'ALTER',
      'INDEX', 'TABLE', 'DISTINCT', 'AS', 'CASE', 'WHEN',
      'THEN', 'ELSE', 'END', 'IN', 'BETWEEN', 'LIKE', 'IS',
      'NULL', 'ASC', 'DESC', 'REPLACE', 'INTO'
    ]);
    const m = sql.match(/\bFROM\s+(\w+)(?:\s+(\w+))?/i);
    if (m) {
      if (m[2] && !SQL_KEYWORDS.has(m[2].toUpperCase())) return m[2];
      return m[1];
    }
    const um = sql.match(/\bUPDATE\s+(\w+)/i);
    if (um) return um[1];
    return null;
  }

  _insertWhereBefore(sql, qualified, params, sid) {
    const markers = [/\bGROUP\s+BY\b/i, /\bHAVING\b/i, /\bORDER\s+BY\b/i, /\bLIMIT\b/i];
    for (const p of markers) {
      const idx = sql.search(p);
      if (idx !== -1) {
        return { sql: sql.slice(0, idx) + `WHERE ${qualified} = ? ` + sql.slice(idx), params: [sid, ...params] };
      }
    }
    return { sql: sql.trimEnd().replace(/;?\s*$/, '') + ` WHERE ${qualified} = ?`, params: [...params, sid] };
  }

  _rewrite(sql, params) {
    const sid = this.schoolId;

    if (/^\s*INSERT\s+/i.test(sql)) {
      const m = sql.match(/INSERT\s+(?:OR\s+REPLACE\s+)?INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
      if (m) {
        const cols = m[2].split(',').map(c => c.trim());
        const vals = m[3].split(',').map(v => v.trim());
        cols.push('school_id');
        vals.push('?');
        return { sql: `INSERT INTO ${m[1]} (${cols.join(', ')}) VALUES (${vals.join(', ')})`, params: [...params, sid] };
      }
    }

    if (/^\s*SELECT\b/i.test(sql) && !/\bWHERE\b/i.test(sql)) {
      const tbl = this._getFirstTable(sql);
      const qualified = tbl ? `${tbl}.school_id` : 'school_id';
      return this._insertWhereBefore(sql, qualified, params, sid);
    }

    if (/\bWHERE\b/i.test(sql)) {
      const tbl = this._getFirstTable(sql);
      const qualified = tbl ? `${tbl}.school_id` : 'school_id';
      const whereIdx = sql.search(/\bWHERE\b/i);
      const before = sql.slice(0, whereIdx + 5);
      let after = sql.slice(whereIdx + 5);
      let endIdx = after.length;
      for (const p of [/\bORDER\s+BY\b/i, /\bGROUP\s+BY\b/i, /\bLIMIT\b/i]) {
        const idx = after.search(p);
        if (idx !== -1 && idx < endIdx) endIdx = idx;
      }
      const cond = after.slice(0, endIdx).trim();
      const rest = after.slice(endIdx);
      return { sql: before + ' (' + cond + ') AND ' + qualified + ' = ?' + rest, params: [...params, sid] };
    }

    if (/^\s*UPDATE\s+/i.test(sql)) {
      const tbl = this._getFirstTable(sql);
      const qualified = tbl ? `${tbl}.school_id` : 'school_id';
      return { sql: sql + ` WHERE ${qualified} = ?`, params: [...params, sid] };
    }

    if (/^\s*DELETE\s+/i.test(sql)) {
      const tbl = this._getFirstTable(sql);
      const qualified = tbl ? `${tbl}.school_id` : 'school_id';
      return { sql: sql + ` WHERE ${qualified} = ?`, params: [...params, sid] };
    }

    return { sql, params };
  }

  all(sql, params = [], callback) {
    if (typeof params === 'function') { callback = params; params = []; }
    const { sql: s, params: p } = this._rewrite(sql, params);
    this.client.execute({ sql: s, args: p })
      .then(r => callback(null, r.rows))
      .catch(e => callback(e));
  }

  get(sql, params = [], callback) {
    if (typeof params === 'function') { callback = params; params = []; }
    const { sql: s, params: p } = this._rewrite(sql, params);
    this.client.execute({ sql: s, args: p })
      .then(r => callback(null, r.rows[0] || undefined))
      .catch(e => callback(e));
  }

  run(sql, params = [], callback) {
    if (typeof params === 'function') { callback = params; params = []; }
    const { sql: s, params: p } = this._rewrite(sql, params);
    this.client.execute({ sql: s, args: p })
      .then(r => {
        const ctx = { lastID: Number(r.lastInsertRowid), changes: r.rowsAffected };
        if (callback) callback.call(ctx, null);
      })
      .catch(e => { if (callback) callback(e); else console.error('Turso run error:', e); });
  }

  serialize(callback) { callback(); }
  close(callback) { if (callback) callback(); }
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

    if (config.useTurso) {
      const proxy = new SchoolDbTursoProxy(getTursoClient(), schoolId);
      schoolDbCache[schoolId] = proxy;
      return resolve(proxy);
    }

    const lookupAndConnect = async () => {
      let school;
      school = await new Promise((res, rej) => {
        const db = getMainDb();
        db.get('SELECT db_file FROM schools WHERE id = ?', [schoolId], (err, row) => {
          if (err) rej(err);
          else res(row);
        });
      });

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
