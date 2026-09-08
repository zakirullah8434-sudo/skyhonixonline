const express = require('express');
const router = express.Router();
const { authenticateToken } = require('./auth');
const { querySchool, querySchoolOne, runSchool } = require('../database_manager');

// ==========================================
// VEHICLES
// ==========================================

// GET /api/transport/vehicles - List all vehicles
router.get('/vehicles', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  try {
    await runSchool(schoolId, `CREATE TABLE IF NOT EXISTS transport_vehicles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      plate_number TEXT,
      type TEXT DEFAULT 'Bus',
      capacity INTEGER DEFAULT 0,
      status TEXT DEFAULT 'Active',
      monthly_fee REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    const vehicles = await querySchool(schoolId, 'SELECT * FROM transport_vehicles ORDER BY id DESC');
    res.json(vehicles);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/transport/vehicles - Create vehicle
router.post('/vehicles', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { name, plate_number, type, capacity, status, monthly_fee } = req.body;
  try {
    await runSchool(schoolId, `CREATE TABLE IF NOT EXISTS transport_vehicles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      plate_number TEXT,
      type TEXT DEFAULT 'Bus',
      capacity INTEGER DEFAULT 0,
      status TEXT DEFAULT 'Active',
      monthly_fee REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    const result = await runSchool(schoolId,
      'INSERT INTO transport_vehicles (name, plate_number, type, capacity, status, monthly_fee) VALUES (?, ?, ?, ?, ?, ?)',
      [name || '', plate_number || '', type || 'Bus', capacity || 0, status || 'Active', monthly_fee || 0]
    );
    res.status(201).json({ message: 'Vehicle added', id: result.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/transport/vehicles/:id - Update vehicle
router.put('/vehicles/:id', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { name, plate_number, type, capacity, status, monthly_fee } = req.body;
  try {
    await runSchool(schoolId,
      'UPDATE transport_vehicles SET name=?, plate_number=?, type=?, capacity=?, status=?, monthly_fee=? WHERE id=?',
      [name, plate_number, type, capacity, status, monthly_fee, parseInt(req.params.id)]
    );
    res.json({ message: 'Vehicle updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/transport/vehicles/:id - Delete vehicle
router.delete('/vehicles/:id', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  try {
    await runSchool(schoolId, 'DELETE FROM transport_vehicles WHERE id=?', [parseInt(req.params.id)]);
    res.json({ message: 'Vehicle deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// DRIVERS
// ==========================================

// GET /api/transport/drivers - List all drivers
router.get('/drivers', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  try {
    await runSchool(schoolId, `CREATE TABLE IF NOT EXISTS transport_drivers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      phone TEXT,
      license_number TEXT,
      address TEXT,
      vehicle_id INTEGER,
      status TEXT DEFAULT 'Active',
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    const drivers = await querySchool(schoolId, `
      SELECT d.*, v.name as vehicle_name, v.plate_number as vehicle_plate
      FROM transport_drivers d
      LEFT JOIN transport_vehicles v ON d.vehicle_id = v.id
      ORDER BY d.id DESC
    `);
    res.json(drivers);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/transport/drivers - Create driver
router.post('/drivers', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { name, phone, license_number, address, vehicle_id, status } = req.body;
  try {
    await runSchool(schoolId, `CREATE TABLE IF NOT EXISTS transport_drivers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      phone TEXT,
      license_number TEXT,
      address TEXT,
      vehicle_id INTEGER,
      status TEXT DEFAULT 'Active',
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    const result = await runSchool(schoolId,
      'INSERT INTO transport_drivers (name, phone, license_number, address, vehicle_id, status) VALUES (?, ?, ?, ?, ?, ?)',
      [name || '', phone || '', license_number || '', address || '', vehicle_id || null, status || 'Active']
    );
    res.status(201).json({ message: 'Driver added', id: result.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/transport/drivers/:id - Update driver
router.put('/drivers/:id', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { name, phone, license_number, address, vehicle_id, status } = req.body;
  try {
    await runSchool(schoolId,
      'UPDATE transport_drivers SET name=?, phone=?, license_number=?, address=?, vehicle_id=?, status=? WHERE id=?',
      [name, phone, license_number, address, vehicle_id || null, status, parseInt(req.params.id)]
    );
    res.json({ message: 'Driver updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/transport/drivers/:id - Delete driver
router.delete('/drivers/:id', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  try {
    await runSchool(schoolId, 'DELETE FROM transport_drivers WHERE id=?', [parseInt(req.params.id)]);
    res.json({ message: 'Driver deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// TRANSPORT ROUTES (Pickup/Drop Locations)
// ==========================================

// GET /api/transport/routes - List all routes
router.get('/routes', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  try {
    await runSchool(schoolId, `CREATE TABLE IF NOT EXISTS transport_routes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      pickup_locations TEXT DEFAULT '[]',
      drop_locations TEXT DEFAULT '[]',
      vehicle_id INTEGER,
      monthly_fee REAL DEFAULT 0,
      status TEXT DEFAULT 'Active',
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    const routes = await querySchool(schoolId, `
      SELECT r.*, v.name as vehicle_name, v.plate_number as vehicle_plate
      FROM transport_routes r
      LEFT JOIN transport_vehicles v ON r.vehicle_id = v.id
      ORDER BY r.id DESC
    `);
    routes.forEach(r => {
      try { r.pickup_locations = JSON.parse(r.pickup_locations || '[]'); } catch (e) { r.pickup_locations = []; }
      try { r.drop_locations = JSON.parse(r.drop_locations || '[]'); } catch (e) { r.drop_locations = []; }
    });
    res.json(routes);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/transport/routes - Create route
router.post('/routes', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { name, pickup_locations, drop_locations, vehicle_id, monthly_fee, status } = req.body;
  try {
    await runSchool(schoolId, `CREATE TABLE IF NOT EXISTS transport_routes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      pickup_locations TEXT DEFAULT '[]',
      drop_locations TEXT DEFAULT '[]',
      vehicle_id INTEGER,
      monthly_fee REAL DEFAULT 0,
      status TEXT DEFAULT 'Active',
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    const result = await runSchool(schoolId,
      'INSERT INTO transport_routes (name, pickup_locations, drop_locations, vehicle_id, monthly_fee, status) VALUES (?, ?, ?, ?, ?, ?)',
      [name || '', JSON.stringify(pickup_locations || []), JSON.stringify(drop_locations || []), vehicle_id || null, monthly_fee || 0, status || 'Active']
    );
    res.status(201).json({ message: 'Route created', id: result.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/transport/routes/:id - Update route
router.put('/routes/:id', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { name, pickup_locations, drop_locations, vehicle_id, monthly_fee, status } = req.body;
  try {
    await runSchool(schoolId,
      'UPDATE transport_routes SET name=?, pickup_locations=?, drop_locations=?, vehicle_id=?, monthly_fee=?, status=? WHERE id=?',
      [name, JSON.stringify(pickup_locations || []), JSON.stringify(drop_locations || []), vehicle_id || null, monthly_fee || 0, status, parseInt(req.params.id)]
    );
    res.json({ message: 'Route updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/transport/routes/:id - Delete route
router.delete('/routes/:id', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  try {
    await runSchool(schoolId, 'DELETE FROM transport_routes WHERE id=?', [parseInt(req.params.id)]);
    res.json({ message: 'Route deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// STUDENT TRANSPORT ASSIGNMENTS
// ==========================================

// GET /api/transport/assignments - List all student assignments
router.get('/assignments', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  try {
    await runSchool(schoolId, `CREATE TABLE IF NOT EXISTS transport_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      vehicle_id INTEGER,
      route_id INTEGER,
      pickup_point TEXT,
      drop_point TEXT,
      monthly_fee REAL DEFAULT 0,
      status TEXT DEFAULT 'Active',
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    const assignments = await querySchool(schoolId, `
      SELECT a.*, s.name as student_name, s.class_name, s.roll_no, s.father_name,
             v.name as vehicle_name, v.plate_number, v.type as vehicle_type,
             r.name as route_name
      FROM transport_assignments a
      LEFT JOIN students s ON a.student_id = s.id
      LEFT JOIN transport_vehicles v ON a.vehicle_id = v.id
      LEFT JOIN transport_routes r ON a.route_id = r.id
      ORDER BY a.id DESC
    `);
    res.json(assignments);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/transport/assignments - Assign student to transport
router.post('/assignments', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { student_id, vehicle_id, route_id, pickup_point, drop_point, monthly_fee, status } = req.body;
  try {
    await runSchool(schoolId, `CREATE TABLE IF NOT EXISTS transport_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      vehicle_id INTEGER,
      route_id INTEGER,
      pickup_point TEXT,
      drop_point TEXT,
      monthly_fee REAL DEFAULT 0,
      status TEXT DEFAULT 'Active',
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    // Check if student already assigned
    const existing = await querySchoolOne(schoolId,
      'SELECT id FROM transport_assignments WHERE student_id = ? AND status = "Active"',
      [student_id]
    );
    if (existing) {
      return res.status(400).json({ error: 'Student is already assigned to transport. Update or remove the existing assignment first.' });
    }
    const result = await runSchool(schoolId,
      'INSERT INTO transport_assignments (student_id, vehicle_id, route_id, pickup_point, drop_point, monthly_fee, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [student_id, vehicle_id || null, route_id || null, pickup_point || '', drop_point || '', monthly_fee || 0, status || 'Active']
    );
    // Also update student's transport_fee field
    await runSchool(schoolId, 'UPDATE students SET transport_fee = ? WHERE id = ?', [monthly_fee || 0, student_id]);
    res.status(201).json({ message: 'Student assigned to transport', id: result.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/transport/assignments/:id - Update assignment
router.put('/assignments/:id', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { student_id, vehicle_id, route_id, pickup_point, drop_point, monthly_fee, status } = req.body;
  try {
    await runSchool(schoolId,
      'UPDATE transport_assignments SET student_id=?, vehicle_id=?, route_id=?, pickup_point=?, drop_point=?, monthly_fee=?, status=? WHERE id=?',
      [student_id, vehicle_id || null, route_id || null, pickup_point || '', drop_point || '', monthly_fee || 0, status, parseInt(req.params.id)]
    );
    // Sync student's transport_fee
    if (status === 'Active') {
      await runSchool(schoolId, 'UPDATE students SET transport_fee = ? WHERE id = ?', [monthly_fee || 0, student_id]);
    }
    res.json({ message: 'Assignment updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/transport/assignments/:id - Remove assignment
router.delete('/assignments/:id', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  try {
    const assignment = await querySchoolOne(schoolId, 'SELECT student_id FROM transport_assignments WHERE id=?', [parseInt(req.params.id)]);
    await runSchool(schoolId, 'DELETE FROM transport_assignments WHERE id=?', [parseInt(req.params.id)]);
    // Clear student's transport_fee if no other active assignment
    if (assignment && assignment.student_id) {
      const other = await querySchoolOne(schoolId,
        'SELECT id FROM transport_assignments WHERE student_id=? AND status="Active" AND id!=?',
        [assignment.student_id, parseInt(req.params.id)]
      );
      if (!other) {
        await runSchool(schoolId, 'UPDATE students SET transport_fee = 0 WHERE id = ?', [assignment.student_id]);
      }
    }
    res.json({ message: 'Assignment removed' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// TRANSPORT FEE SETTINGS
// ==========================================

// GET /api/transport/fees - Get transport fee summary
router.get('/fees', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  try {
    const vehicles = await querySchool(schoolId, 'SELECT id, name, plate_number, monthly_fee FROM transport_vehicles WHERE status="Active"');
    const assignments = await querySchool(schoolId, `
      SELECT a.id, a.student_id, a.monthly_fee, a.status, s.name as student_name, s.class_name, v.name as vehicle_name
      FROM transport_assignments a
      LEFT JOIN students s ON a.student_id = s.id
      LEFT JOIN transport_vehicles v ON a.vehicle_id = v.id
      ORDER BY s.class_name, s.name
    `);
    const totalAssigned = assignments.filter(a => a.status === 'Active').length;
    const totalMonthlyRevenue = assignments.filter(a => a.status === 'Active').reduce((sum, a) => sum + (a.monthly_fee || 0), 0);
    res.json({ vehicles, assignments, totalAssigned, totalMonthlyRevenue });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// DASHBOARD STATS
// ==========================================

// GET /api/transport/stats - Transport dashboard stats
router.get('/stats', authenticateToken, async (req, res) => {
  const schoolId = req.user.schoolId;
  try {
    const vehicles = await querySchool(schoolId, 'SELECT COUNT(*) as count FROM transport_vehicles WHERE status="Active"');
    const drivers = await querySchool(schoolId, 'SELECT COUNT(*) as count FROM transport_drivers WHERE status="Active"');
    const routes = await querySchool(schoolId, 'SELECT COUNT(*) as count FROM transport_routes WHERE status="Active"');
    const assignments = await querySchool(schoolId, 'SELECT COUNT(*) as count FROM transport_assignments WHERE status="Active"');
    const revenue = await querySchool(schoolId, 'SELECT COALESCE(SUM(monthly_fee), 0) as total FROM transport_assignments WHERE status="Active"');
    res.json({
      totalVehicles: vehicles.count || 0,
      totalDrivers: drivers.count || 0,
      totalRoutes: routes.count || 0,
      totalStudents: assignments.count || 0,
      monthlyRevenue: revenue.total || 0
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
