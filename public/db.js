// db.js — thin Postgres wrapper for the attendance feature.
//
// Uses Render's free Postgres addon (or any Postgres) via DATABASE_URL.
// If DATABASE_URL isn't set yet, every helper below becomes a harmless
// no-op so the rest of the server keeps running — the attendance feature
// just stays disabled until the teacher adds the env var.

const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || '';
const enabled = !!DATABASE_URL;

let pool = null;
if (enabled) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    // Render's managed Postgres uses a self-signed chain internally.
    ssl: { rejectUnauthorized: false },
  });
  pool.on('error', (err) => console.error('[db] idle client error:', err.message));
} else {
  console.warn('[warn] DATABASE_URL not set — attendance/notification features are disabled until it is configured.');
}

async function query(text, params) {
  if (!enabled) throw new Error('db-not-configured');
  return pool.query(text, params);
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS students (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  room_id TEXT NOT NULL,
  parent_phone TEXT,
  schedule_days TEXT DEFAULT '',   -- comma list, e.g. "mon,wed,fri"
  schedule_time TEXT DEFAULT '',   -- "HH:MM" 24h
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS attendance (
  id SERIAL PRIMARY KEY,
  student_id INTEGER REFERENCES students(id) ON DELETE SET NULL,
  room_id TEXT NOT NULL,
  class_date DATE NOT NULL,
  join_time TIMESTAMPTZ,
  leave_time TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'present', -- present | late | absent
  matched_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS attendance_student_date
  ON attendance (student_id, class_date) WHERE student_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS notification_settings (
  room_id TEXT PRIMARY KEY,
  auto_send BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS notification_log (
  id SERIAL PRIMARY KEY,
  student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
  attendance_id INTEGER REFERENCES attendance(id) ON DELETE CASCADE,
  channel TEXT NOT NULL DEFAULT 'kakao',
  status TEXT NOT NULL DEFAULT 'pending', -- pending | sent_auto | sent_manual | skipped | failed
  sent_by TEXT,
  message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
`;

async function initSchema() {
  if (!enabled) return false;
  await pool.query(SCHEMA_SQL);
  console.log('[db] schema ready');
  return true;
}

module.exports = { enabled, query, initSchema, pool };
