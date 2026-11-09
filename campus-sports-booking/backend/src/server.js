import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from './db.js';
import { requireAuth, allowRoles, errorHandler } from './middleware.js';

dotenv.config();
if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required.');
const app = express();
app.use(helmet());
app.use(cors({ origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173' }));
app.use(express.json({ limit: '1mb' }));

const asyncRoute = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);
const sign = user => jwt.sign({ userId: user.user_id, role: user.role, name: user.full_name }, process.env.JWT_SECRET, { expiresIn: '8h' });

app.get('/api/health', (req,res) => res.json({ status:'ok', service:'campus-sports-api' }));

app.post('/api/auth/register', asyncRoute(async (req,res) => {
  const { fullName, email, password, role = 'student' } = req.body;
  if (!fullName?.trim() || !email?.trim() || !password || password.length < 8)
    return res.status(400).json({ error:'Name, email and a password of at least 8 characters are required.' });
  if (!['student','staff'].includes(role)) return res.status(400).json({ error:'Public registration is limited to student and staff roles.' });
  const hash = await bcrypt.hash(password, 12);
  const { rows } = await pool.query(
    'INSERT INTO users(full_name,email,password_hash,role) VALUES($1,$2,$3,$4) RETURNING user_id,full_name,email,role',
    [fullName.trim(), email.trim().toLowerCase(), hash, role]
  );
  const user = rows[0];
  res.status(201).json({ token:sign(user), user });
}));

app.post('/api/auth/login', asyncRoute(async (req,res) => {
  const { email, password } = req.body;
  const { rows } = await pool.query('SELECT * FROM users WHERE email=$1 AND is_active=TRUE', [String(email || '').toLowerCase()]);
  if (!rows[0] || !(await bcrypt.compare(password || '', rows[0].password_hash)))
    return res.status(401).json({ error:'Invalid email or password.' });
  const u = rows[0], user = { user_id:u.user_id, full_name:u.full_name, email:u.email, role:u.role };
  res.json({ token:sign(user), user });
}));

app.get('/api/auth/me', requireAuth, asyncRoute(async (req,res) => {
  const { rows } = await pool.query('SELECT user_id,full_name,email,role FROM users WHERE user_id=$1 AND is_active=TRUE', [req.user.userId]);
  if (!rows[0]) return res.status(401).json({ error:'Account is unavailable.' });
  res.json({ user:rows[0] });
}));

app.get('/api/facilities', asyncRoute(async (req,res) => {
  const { rows } = await pool.query(`SELECT f.*,
    (SELECT COUNT(*)::int FROM time_slots s
      WHERE s.facility_id=f.facility_id AND s.starts_at>NOW() AND s.is_open=TRUE
      AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.slot_id=s.slot_id AND b.status='confirmed')
      AND NOT EXISTS (SELECT 1 FROM maintenance_periods m WHERE m.facility_id=f.facility_id
        AND m.starts_at<s.ends_at AND m.ends_at>s.starts_at)
    ) AS available_slots
    FROM facilities f WHERE f.status='active' ORDER BY f.name`);
  res.json({ facilities:rows });
}));

app.get('/api/facilities/:id/slots', asyncRoute(async (req,res) => {
  const { rows } = await pool.query(`SELECT s.slot_id,s.facility_id,s.starts_at,s.ends_at,
    CASE WHEN b.booking_id IS NOT NULL OR m.maintenance_id IS NOT NULL OR s.is_open=FALSE THEN FALSE ELSE TRUE END AS available
    FROM time_slots s
    LEFT JOIN bookings b ON b.slot_id=s.slot_id AND b.status='confirmed'
    LEFT JOIN maintenance_periods m ON m.facility_id=s.facility_id AND m.starts_at<s.ends_at AND m.ends_at>s.starts_at
    WHERE s.facility_id=$1 AND s.starts_at>NOW()
    ORDER BY s.starts_at`, [req.params.id]);
  res.json({ slots:rows });
}));

app.get('/api/equipment', asyncRoute(async (req,res) => {
  const { rows } = await pool.query(`SELECT e.*,
    GREATEST(e.total_quantity-COALESCE((SELECT SUM(be.quantity)::int
      FROM booking_equipment be JOIN bookings b ON b.booking_id=be.booking_id
      JOIN time_slots s ON s.slot_id=b.slot_id
      WHERE be.equipment_id=e.equipment_id AND b.status='confirmed'
      AND s.starts_at>NOW()),0),0)::int AS available_quantity
    FROM equipment e WHERE e.status='active' ORDER BY e.name`);
  res.json({ equipment:rows });
}));

app.post('/api/bookings', requireAuth, asyncRoute(async (req,res) => {
  const { slotId, purpose = '', equipment = [] } = req.body;
  if (!Number.isInteger(Number(slotId))) return res.status(400).json({ error:'A valid slotId is required.' });
  if (!Array.isArray(equipment)) return res.status(400).json({ error:'Equipment must be an array.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize competing attempts for the same slot.
    const slotResult = await client.query(
      `SELECT s.*,f.status AS facility_status FROM time_slots s
       JOIN facilities f ON f.facility_id=s.facility_id
       WHERE s.slot_id=$1 FOR UPDATE OF s`, [slotId]);
    const slot = slotResult.rows[0];
    if (!slot || !slot.is_open || slot.facility_status !== 'active' || new Date(slot.starts_at) <= new Date()) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error:'This time slot is not available.' });
    }
    const maintenance = await client.query(
      `SELECT 1 FROM maintenance_periods WHERE facility_id=$1
       AND starts_at<$3 AND ends_at>$2 LIMIT 1`,
      [slot.facility_id, slot.starts_at, slot.ends_at]);
    if (maintenance.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error:'The facility is under maintenance during this slot.' });
    }
    const existing = await client.query("SELECT 1 FROM bookings WHERE slot_id=$1 AND status='confirmed'", [slotId]);
    if (existing.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error:'Sorry, another user has already booked this slot.' });
    }
    // Lock equipment rows in sorted order to reduce deadlock risk.
    const normalized = equipment.map(x => ({ id:Number(x.equipmentId), qty:Number(x.quantity) }));
    if (normalized.some(x => !Number.isInteger(x.id) || !Number.isInteger(x.qty) || x.qty < 1) ||
        new Set(normalized.map(x=>x.id)).size !== normalized.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error:'Invalid equipment selection.' });
    }
    for (const item of [...normalized].sort((a,b)=>a.id-b.id)) {
      const e = await client.query("SELECT * FROM equipment WHERE equipment_id=$1 AND status='active' FOR UPDATE", [item.id]);
      if (!e.rows[0]) { await client.query('ROLLBACK'); return res.status(400).json({ error:'Selected equipment is unavailable.' }); }
      const reserved = await client.query(`SELECT COALESCE(SUM(be.quantity),0)::int AS qty
        FROM booking_equipment be JOIN bookings b ON b.booking_id=be.booking_id
        JOIN time_slots s ON s.slot_id=b.slot_id
        WHERE be.equipment_id=$1 AND b.status='confirmed' AND s.starts_at<$3 AND s.ends_at>$2`, [item.id, slot.starts_at, slot.ends_at]);
      if (e.rows[0].total_quantity - reserved.rows[0].qty < item.qty) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error:`Not enough ${e.rows[0].name} available.` });
      }
    }
    const inserted = await client.query(
      `INSERT INTO bookings(user_id,slot_id,purpose) VALUES($1,$2,$3)
       RETURNING booking_id,status,booked_at`, [req.user.userId, slotId, purpose]);
    const booking = inserted.rows[0];
    for (const item of normalized) {
      await client.query('INSERT INTO booking_equipment(booking_id,equipment_id,quantity) VALUES($1,$2,$3)',
        [booking.booking_id,item.id,item.qty]);
    }
    await client.query('COMMIT');
    res.status(201).json({ message:'Booking confirmed.', booking });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error:'Sorry, another user has already booked this slot.' });
    throw err;
  } finally { client.release(); }
}));

app.get('/api/bookings/my', requireAuth, asyncRoute(async (req,res) => {
  const { rows } = await pool.query(`SELECT b.booking_id,b.status,b.purpose,b.booked_at,b.cancelled_at,
    s.starts_at,s.ends_at,f.name AS facility_name,f.sport_type,
    COALESCE(json_agg(json_build_object('equipment_id',e.equipment_id,'name',e.name,'quantity',be.quantity))
      FILTER (WHERE e.equipment_id IS NOT NULL),'[]') AS equipment
    FROM bookings b JOIN time_slots s ON s.slot_id=b.slot_id JOIN facilities f ON f.facility_id=s.facility_id
    LEFT JOIN booking_equipment be ON be.booking_id=b.booking_id
    LEFT JOIN equipment e ON e.equipment_id=be.equipment_id
    WHERE b.user_id=$1 GROUP BY b.booking_id,s.starts_at,s.ends_at,f.name,f.sport_type
    ORDER BY s.starts_at DESC`, [req.user.userId]);
  res.json({ bookings:rows });
}));

app.patch('/api/bookings/:id/cancel', requireAuth, asyncRoute(async (req,res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`SELECT b.*,s.starts_at FROM bookings b
      JOIN time_slots s ON s.slot_id=b.slot_id WHERE b.booking_id=$1 FOR UPDATE OF b`, [req.params.id]);
    const b = rows[0];
    if (!b || (b.user_id !== req.user.userId && req.user.role !== 'admin')) {
      await client.query('ROLLBACK'); return res.status(404).json({ error:'Booking not found.' });
    }
    if (b.status !== 'confirmed' || new Date(b.starts_at) <= new Date()) {
      await client.query('ROLLBACK'); return res.status(409).json({ error:'This booking is no longer eligible for cancellation.' });
    }
    await client.query("UPDATE bookings SET status='cancelled',cancelled_at=NOW() WHERE booking_id=$1", [b.booking_id]);
    await client.query('COMMIT');
    res.json({ message:'Booking cancelled. Reserved equipment is available again.' });
  } catch(err) { await client.query('ROLLBACK'); throw err; }
  finally { client.release(); }
}));

app.get('/api/admin/summary', requireAuth, allowRoles('admin'), asyncRoute(async (req,res) => {
  const { rows } = await pool.query(`SELECT
    (SELECT COUNT(*)::int FROM users) AS users,
    (SELECT COUNT(*)::int FROM facilities) AS facilities,
    (SELECT COUNT(*)::int FROM bookings) AS bookings,
    (SELECT COUNT(*)::int FROM bookings WHERE status='confirmed') AS active_bookings,
    (SELECT COUNT(*)::int FROM bookings WHERE status='cancelled') AS cancelled_bookings,
    (SELECT COUNT(*)::int FROM equipment) AS equipment`);
  res.json({ summary:rows[0] });
}));

app.get('/api/admin/bookings', requireAuth, allowRoles('admin'), asyncRoute(async (req,res) => {
  const { rows } = await pool.query(`SELECT b.booking_id,b.status,b.booked_at,u.full_name,u.email,
    f.name AS facility_name,s.starts_at,s.ends_at
    FROM bookings b JOIN users u ON u.user_id=b.user_id
    JOIN time_slots s ON s.slot_id=b.slot_id JOIN facilities f ON f.facility_id=s.facility_id
    ORDER BY b.booked_at DESC LIMIT 300`);
  res.json({ bookings:rows });
}));

app.post('/api/admin/facilities', requireAuth, allowRoles('admin'), asyncRoute(async (req,res) => {
  const { name,sportType,location,capacity,description='' } = req.body;
  if (!name || !sportType || !location || Number(capacity)<1) return res.status(400).json({error:'Name, sport, location and positive capacity are required.'});
  const { rows } = await pool.query(`INSERT INTO facilities(name,sport_type,location,capacity,description)
    VALUES($1,$2,$3,$4,$5) RETURNING *`,[name,sportType,location,capacity,description]);
  res.status(201).json({ facility:rows[0] });
}));

app.put('/api/admin/facilities/:id', requireAuth, allowRoles('admin'), asyncRoute(async (req,res) => {
  const { name,sportType,location,capacity,description,status } = req.body;
  const { rows } = await pool.query(`UPDATE facilities SET name=$1,sport_type=$2,location=$3,capacity=$4,
    description=$5,status=$6 WHERE facility_id=$7 RETURNING *`,
    [name,sportType,location,capacity,description,status,req.params.id]);
  if (!rows[0]) return res.status(404).json({error:'Facility not found.'});
  res.json({facility:rows[0]});
}));

app.post('/api/admin/equipment', requireAuth, allowRoles('admin'), asyncRoute(async (req,res) => {
  const { name,sportType,description='',totalQuantity } = req.body;
  if (!name || !sportType || !Number.isInteger(Number(totalQuantity)) || Number(totalQuantity)<0)
    return res.status(400).json({error:'Valid equipment details are required.'});
  const { rows } = await pool.query(`INSERT INTO equipment(name,sport_type,description,total_quantity)
    VALUES($1,$2,$3,$4) RETURNING *`,[name,sportType,description,totalQuantity]);
  res.status(201).json({equipment:rows[0]});
}));

app.post('/api/admin/maintenance', requireAuth, allowRoles('admin'), asyncRoute(async (req,res) => {
  const { facilityId,startsAt,endsAt,reason } = req.body;
  if (!facilityId || !startsAt || !endsAt || !reason || new Date(endsAt)<=new Date(startsAt))
    return res.status(400).json({error:'Valid facility, date range and reason are required.'});
  const conflict = await pool.query(`SELECT 1 FROM bookings b JOIN time_slots s ON s.slot_id=b.slot_id
    WHERE s.facility_id=$1 AND b.status='confirmed' AND s.starts_at<$3 AND s.ends_at>$2 LIMIT 1`,
    [facilityId,startsAt,endsAt]);
  if (conflict.rowCount) return res.status(409).json({error:'Existing confirmed bookings overlap this maintenance period. Resolve them first.'});
  const { rows } = await pool.query(`INSERT INTO maintenance_periods(facility_id,starts_at,ends_at,reason,created_by)
    VALUES($1,$2,$3,$4,$5) RETURNING *`,[facilityId,startsAt,endsAt,reason,req.user.userId]);
  res.status(201).json({maintenance:rows[0]});
}));

app.use(errorHandler);
const port = process.env.PORT || 5000;
app.listen(port, () => console.log(`Campus Sports API listening on http://localhost:${port}`));
