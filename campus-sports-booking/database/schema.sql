BEGIN;

CREATE TABLE IF NOT EXISTS users (
  user_id BIGSERIAL PRIMARY KEY,
  full_name VARCHAR(120) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'student' CHECK (role IN ('student','staff','admin')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS facilities (
  facility_id BIGSERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  sport_type VARCHAR(80) NOT NULL,
  location VARCHAR(180) NOT NULL,
  capacity INTEGER NOT NULL CHECK (capacity > 0),
  description TEXT,
  image_url TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS time_slots (
  slot_id BIGSERIAL PRIMARY KEY,
  facility_id BIGINT NOT NULL REFERENCES facilities(facility_id) ON DELETE RESTRICT,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  is_open BOOLEAN NOT NULL DEFAULT TRUE,
  CHECK (ends_at > starts_at),
  UNIQUE (facility_id, starts_at, ends_at)
);

CREATE TABLE IF NOT EXISTS equipment (
  equipment_id BIGSERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  sport_type VARCHAR(80) NOT NULL,
  description TEXT,
  total_quantity INTEGER NOT NULL CHECK (total_quantity >= 0),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive'))
);

CREATE TABLE IF NOT EXISTS bookings (
  booking_id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  slot_id BIGINT NOT NULL REFERENCES time_slots(slot_id) ON DELETE RESTRICT,
  status VARCHAR(20) NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('confirmed','cancelled','completed')),
  purpose TEXT,
  booked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelled_at TIMESTAMPTZ
);

-- Hard requirement: at most one active booking for each facility time slot.
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_booking_per_slot
  ON bookings(slot_id) WHERE status = 'confirmed';

CREATE TABLE IF NOT EXISTS booking_equipment (
  booking_equipment_id BIGSERIAL PRIMARY KEY,
  booking_id BIGINT NOT NULL REFERENCES bookings(booking_id) ON DELETE RESTRICT,
  equipment_id BIGINT NOT NULL REFERENCES equipment(equipment_id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  UNIQUE (booking_id, equipment_id)
);

CREATE TABLE IF NOT EXISTS maintenance_periods (
  maintenance_id BIGSERIAL PRIMARY KEY,
  facility_id BIGINT NOT NULL REFERENCES facilities(facility_id) ON DELETE RESTRICT,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  reason TEXT NOT NULL,
  created_by BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS idx_slots_facility_start ON time_slots(facility_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_bookings_user_status ON bookings(user_id, status);
CREATE INDEX IF NOT EXISTS idx_maintenance_facility_dates ON maintenance_periods(facility_id, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS idx_booking_equipment_equipment ON booking_equipment(equipment_id);

-- Demo facilities
INSERT INTO facilities (name,sport_type,location,capacity,description,image_url)
SELECT * FROM (VALUES
 ('Basketball Court 1','Basketball','Outdoor Sports Complex',10,'Full-size outdoor basketball court.',''),
 ('Football Ground','Football','Main Sports Ground',22,'Full-size football playing field.',''),
 ('Badminton Court 1','Badminton','Indoor Sports Hall',4,'Indoor badminton court.',''),
 ('Multi-purpose Court','Multi-sport','Recreation Block',12,'Flexible court for recreational activities.','')
) AS v(name,sport_type,location,capacity,description,image_url)
WHERE NOT EXISTS (SELECT 1 FROM facilities);

-- Demo equipment
INSERT INTO equipment (name,sport_type,description,total_quantity)
SELECT * FROM (VALUES
 ('Basketball','Basketball','Official-size basketball',12),
 ('Football','Football','Match/training football',10),
 ('Badminton Racket','Badminton','Standard badminton racket',16),
 ('Shuttlecock Set','Badminton','Tube of shuttlecocks',20),
 ('Training Cones','Multi-sport','Set of training cones',30)
) AS v(name,sport_type,description,total_quantity)
WHERE NOT EXISTS (SELECT 1 FROM equipment);

-- Generate dated slots for the next 14 days, 07:00–09:00, 09:00–11:00,
-- 15:00–17:00 and 17:00–19:00, using the database session timezone.
INSERT INTO time_slots (facility_id, starts_at, ends_at)
SELECT f.facility_id,
       (d.day_date + t.start_time)::timestamptz,
       (d.day_date + t.end_time)::timestamptz
FROM facilities f
CROSS JOIN generate_series(CURRENT_DATE + 1, CURRENT_DATE + 14, INTERVAL '1 day') AS d(day_date)
CROSS JOIN (VALUES
  (TIME '07:00', TIME '09:00'),
  (TIME '09:00', TIME '11:00'),
  (TIME '15:00', TIME '17:00'),
  (TIME '17:00', TIME '19:00')
) AS t(start_time,end_time)
ON CONFLICT DO NOTHING;

COMMIT;
