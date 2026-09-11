const sqlite3 = require('sqlite3');
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

// LRU-style school DB cache with max size and pending connection tracking
const SCHOOL_DB_MAX = 50;
const schoolDbCache = {};
const schoolDbPending = {}; // prevents race condition on concurrent connects
const schoolDbAccessOrder = [];

let tursoClient = null;

// Module-level SQL keywords (not recreated per query)
const SQL_KEYWORDS = new Set([
  'WHERE', 'SET', 'VALUES', 'ORDER', 'GROUP', 'HAVING',
  'LIMIT', 'OFFSET', 'UNION', 'EXCEPT', 'INTERSECT',
  'INNER', 'LEFT', 'RIGHT', 'OUTER', 'CROSS', 'JOIN',
  'ON', 'AND', 'OR', 'NOT', 'INSERT', 'UPDATE', 'DELETE',
  'SELECT', 'FROM', 'INTO', 'CREATE', 'DROP', 'ALTER',
  'TABLE', 'INDEX', 'VIEW', 'TRIGGER', 'PRIMARY', 'KEY',
  'FOREIGN', 'REFERENCES', 'CONSTRAINT', 'UNIQUE', 'CHECK',
  'DEFAULT', 'NULL', 'IS', 'IN', 'LIKE', 'BETWEEN',
  'EXISTS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'AS', 'DISTINCT', 'ALL', 'ASC', 'DESC', 'NULLS',
  'FIRST', 'LAST', 'LIMIT', 'OFFSET', 'FETCH', 'NEXT',
  'ROW', 'ROWS', 'ONLY', 'WITH', 'RECURSIVE',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE',
  'TRANSACTION', 'DEFERRED', 'IMMEDIATE', 'EXCLUSIVE',
  'OR', 'REPLACE', 'CONFLICT', 'ABORT', 'ROLLBACK',
  'IGNORE', 'FAIL', 'AUTOINCREMENT', 'COLLATE', 'NO',
  'CONFLICT', 'GLOB', 'REGEXP', 'MATCH', 'QUERY',
  'PLAN', 'ANALYZE', 'ATTACH', 'DETACH', 'DATABASE',
  'PRAGMA', 'TABLE_INFO', 'INDEX_LIST', 'INDEX_INFO',
  'VACUUM', 'REINDEX', 'INSTEAD', 'OF', 'BEFORE',
  'AFTER', 'TEMPORARY', 'TEMP', 'IF', 'RENAME',
  'ADD', 'COLUMN', 'TO', 'RENAME', 'TABLE'
]);

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
    const upper = sql.toUpperCase().trim();
    const SQL_KEYWORDS = new Set([
      'SELECT', 'FROM', 'WHERE', 'JOIN', 'ON', 'AND', 'OR', 'NOT',
      'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER',
      'INDEX', 'TABLE', 'DISTINCT', 'AS', 'CASE', 'WHEN',
      'THEN', 'ELSE', 'END', 'IN', 'BETWEEN', 'LIKE', 'IS',
      'NULL', 'ASC', 'DESC', 'REPLACE', 'INTO',
      'ORDER', 'GROUP', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'EXCEPT', 'INTERSECT',
      'SET', 'VALUES', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'NATURAL',
      'IF', 'EXISTS', 'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'CONSTRAINT',
      'DEFAULT', 'CHECK', 'UNIQUE', 'AUTO_INCREMENT', 'INTEGER', 'TEXT', 'REAL', 'BLOB', 'NUMERIC'
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
    if (sid === undefined || sid === null) {
      console.error('[TURSO_PROXY] schoolId is null/undefined, skipping rewrite. SQL:', sql);
      return { sql, params };
    }

    if (/^\s*INSERT\s+/i.test(sql)) {
      const m = sql.match(/(INSERT\s+(?:OR\s+(?:REPLACE|IGNORE)\s+)?)INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
      if (m) {
        const prefix = m[1];
        const table = m[2];
        const colsRaw = m[3].split(',').map(c => c.trim());
        const valsRaw = m[4].split(',').map(v => v.trim());
        const hasSchoolId = colsRaw.some(c => c.toLowerCase() === 'school_id');
        if (!hasSchoolId) {
          colsRaw.push('school_id');
          valsRaw.push('?');
        }
        const suffix = sql.slice(sql.indexOf('VALUES') + 6).replace(/\(([^)]*)\)/i, '').trim();
        const finalSql = `${prefix}INTO ${table} (${colsRaw.join(', ')}) VALUES (${valsRaw.join(', ')})${suffix ? ' ' + suffix : ''}`;
        return { sql: finalSql, params: [...params, ...(hasSchoolId ? [] : [sid])] };
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
      const paddedRest = rest.startsWith(' ') ? rest : ' ' + rest;
      return { sql: before + ' (' + cond + ') AND ' + qualified + ' = ?' + paddedRest, params: [...params, sid] };
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
    const sanitized = params.map(p => (p === undefined || p === null) ? null : p);
    const { sql: s, params: p } = this._rewrite(sql, sanitized);
    this.client.execute({ sql: s, args: p })
      .then(r => callback(null, r.rows))
      .catch(e => {
        console.error('[TURSO_PROXY_ERR]', e.message, '\n  SQL:', s, '\n  Params:', JSON.stringify(p));
        callback(e);
      });
  }

  get(sql, params = [], callback) {
    if (typeof params === 'function') { callback = params; params = []; }
    const sanitized = params.map(p => (p === undefined || p === null) ? null : p);
    const { sql: s, params: p } = this._rewrite(sql, sanitized);
    this.client.execute({ sql: s, args: p })
      .then(r => callback(null, r.rows[0] || undefined))
      .catch(e => {
        console.error('[TURSO_PROXY_ERR]', e.message, '\n  SQL:', s, '\n  Params:', JSON.stringify(p));
        callback(e);
      });
  }

  run(sql, params = [], callback) {
    if (typeof params === 'function') { callback = params; params = []; }
    const sanitized = params.map(p => (p === undefined || p === null) ? null : p);
    const { sql: s, params: p } = this._rewrite(sql, sanitized);
    this.client.execute({ sql: s, args: p })
      .then(r => {
        const ctx = { lastID: Number(r.lastInsertRowid), changes: r.rowsAffected };
        if (callback) callback.call(ctx, null);
      })
      .catch(e => {
        console.error('[TURSO_PROXY_ERR]', e.message, '\n  SQL:', s, '\n  Params:', JSON.stringify(p));
        if (callback) callback(e); else console.error('Turso run error:', e);
      });
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
      } else {
        // WAL mode for concurrent read/write performance
        mainDb.run('PRAGMA journal_mode=WAL');
        mainDb.run('PRAGMA busy_timeout=5000');
        mainDb.run('PRAGMA synchronous=NORMAL');
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
const migratedSchools = new Set();
const BACKFILL_VERSION = 3;
const backfillVersions = new Map();
async function ensureSchoolTables(db, schoolId) {
  // Use raw Turso client for DDL/DML to avoid proxy rewriting
  const isProxy = db && typeof db.client !== 'undefined' && typeof db._rewrite === 'function';
  const rawClient = isProxy ? db.client : null;
  const runRaw = async (sql, params = []) => {
    if (rawClient) {
      return rawClient.execute({ sql, args: params });
    } else {
      return new Promise((res, rej) => { db.run(sql, params, function(err) { if (err) rej(err); else res(); }); });
    }
  };
  const tables = [
    'students', 'sections', 'class_fees', 'student_fee_exceptions',
    'fee_ledger', 'attendance', 'fee_payments', 'fee_dues', 'past_dues',
    'fee_reminder_templates', 'date_sheet_templates', 'exams', 'exam_subjects',
    'marks', 'dmc_templates', 'results', 'student_promotion_history',
    'fee_settings', 'users', 'settings', 'result_sections',
    'parents', 'student_parents', 'timetable', 'fee_reminders',
    'announcements', 'assignments', 'student_certificates', 'student_documents',
    'student_transfer_history', 'transport_vehicles', 'transport_drivers', 'transport_routes', 'transport_assignments', 'roll_slip_templates',
    'teachers', 'teacher_salaries', 'salary_payments'
  ];
  for (const t of tables) {
    await runRaw(`ALTER TABLE ${t} ADD COLUMN school_id INTEGER`).catch(() => {});
  }
  await runRaw(`ALTER TABLE teachers ADD COLUMN assigned_class TEXT DEFAULT ''`).catch(() => {});
  await runRaw(`ALTER TABLE teachers ADD COLUMN can_collect_fees INTEGER DEFAULT 0`).catch(() => {});

  if (schoolId) {
    const ver = backfillVersions.get(String(schoolId)) || 0;
    if (ver < BACKFILL_VERSION) {
      let totalUpdated = 0;
      for (const t of tables) {
        try {
          const r = await runRaw(`UPDATE ${t} SET school_id = ? WHERE school_id IS NULL`, [schoolId]);
          const affected = r && r.rowsAffected ? r.rowsAffected : 0;
          if (affected > 0) totalUpdated += affected;
        } catch (e) {
          console.error(`[TURSO_BACKFILL] Failed on ${t}:`, e.message);
        }
      }
      backfillVersions.set(String(schoolId), BACKFILL_VERSION);
      console.log(`[TURSO_BACKFILL] school_id=${schoolId} updated ${totalUpdated} total rows across ${tables.length} tables`);
    }
  }
}
function getSchoolDb(schoolId) {
  return new Promise((resolve, reject) => {
    if (schoolDbCache[schoolId]) {
      // Move to end of access order (MRU)
      const idx = schoolDbAccessOrder.indexOf(schoolId);
      if (idx > -1) schoolDbAccessOrder.splice(idx, 1);
      schoolDbAccessOrder.push(schoolId);

      if (!migratedSchools.has(schoolId)) {
        migratedSchools.add(schoolId);
        ensureSchoolTables(schoolDbCache[schoolId], schoolId).then(() => resolve(schoolDbCache[schoolId])).catch(() => resolve(schoolDbCache[schoolId]));
      } else {
        return resolve(schoolDbCache[schoolId]);
      }
      return;
    }

    // Prevent race condition: if a connect is pending, wait for it
    if (schoolDbPending[schoolId]) {
      return schoolDbPending[schoolId].then(resolve).catch(reject);
    }

    if (config.useTurso) {
      const proxy = new SchoolDbTursoProxy(getTursoClient(), schoolId);
      schoolDbCache[schoolId] = proxy;
      schoolDbAccessOrder.push(schoolId);
      if (!migratedSchools.has(schoolId)) {
        migratedSchools.add(schoolId);
        ensureSchoolTables(proxy, schoolId)
          .then(() => resolve(proxy))
          .catch(e => { console.error('[TURSO_MIGRATE]', e.message); resolve(proxy); });
      } else {
        return resolve(proxy);
      }
      return;
    }

    // Create pending promise to prevent race condition
    schoolDbPending[schoolId] = (async () => {
      try {
        const school = await new Promise((res, rej) => {
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

        const schoolDb = await new Promise((res, rej) => {
          const db = new sqlite3.Database(schoolDbPath, (dbErr) => {
            if (dbErr) {
              console.error(`Failed to connect to tenant database ${school.db_file}:`, dbErr);
              return rej(dbErr);
            }
            // WAL mode + busy timeout for concurrent access
            db.run('PRAGMA journal_mode=WAL');
            db.run('PRAGMA busy_timeout=5000');
            db.run('PRAGMA synchronous=NORMAL');
            res(db);
          });
        });

        await createSchoolDatabaseSchema(schoolDb);

        // LRU eviction if cache is full
        while (schoolDbAccessOrder.length >= SCHOOL_DB_MAX) {
          const lruId = schoolDbAccessOrder.shift();
          if (lruId && schoolDbCache[lruId]) {
            try { schoolDbCache[lruId].close(); } catch (e) {}
            delete schoolDbCache[lruId];
          }
        }

        schoolDbCache[schoolId] = schoolDb;
        schoolDbAccessOrder.push(schoolId);
        return schoolDb;
      } finally {
        delete schoolDbPending[schoolId];
      }
    })();

    schoolDbPending[schoolId].then(resolve).catch(reject);
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
    // Turso proxy does not support BEGIN/COMMIT over HTTP — execute sequentially
    if (config.useTurso) {
      return new Promise(async (resolve, reject) => {
        for (const { sql, params } of statements) {
          try {
            await new Promise((res, rej) => {
              db.run(sql, params || [], function (err) {
                if (err) rej(err);
                else res();
              });
            });
          } catch (err) {
            return reject(err);
          }
        }
        resolve();
      });
    }

    // Local SQLite — use real transactions
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

async function migrateSchoolTable(schoolId, tableName) {
  const db = await getSchoolDb(schoolId);
  return new Promise((resolve) => {
    db.run(`ALTER TABLE ${tableName} ADD COLUMN school_id INTEGER`, (err) => {
      resolve(); // ignore error if column already exists
    });
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
  resetMainDb,
  migrateSchoolTable
};
