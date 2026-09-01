// db.js — thin Postgres wrapper for the attendance feature.
//
// Any Postgres via DATABASE_URL — Render, Neon, Supabase, Railway, Aiven 등
// 어디든 상관없다. 어느 서비스를 쓰고 있는지는 아래 기동 로그의 host로 확인할 수 있다.
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
  // 어느 DB 서비스에 붙어 있는지 기동 로그로 알 수 있게 host만 남긴다.
  // 비밀번호·사용자명은 절대 찍지 않는다.
  try {
    const u = new URL(DATABASE_URL);
    const host = u.hostname;
    const guess = /\.render\.com$/.test(host) ? 'Render'
      : /\.neon\.tech$/.test(host) ? 'Neon'
      : /\.supabase\.(co|com)$/.test(host) ? 'Supabase'
      : /\.railway\.app$/.test(host) || /rlwy\.net$/.test(host) ? 'Railway'
      : /\.aivencloud\.com$/.test(host) ? 'Aiven'
      : /\.neon\.build$/.test(host) ? 'Neon'
      : '알 수 없음';
    console.log(`[db] connecting to ${host} (추정 서비스: ${guess})`);
  } catch (_) { /* URL 형식이 아니어도 접속 자체는 시도한다 */ }
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
-- 유일성은 (학생, 반, 날짜)로 잡는다. 한 학생이 같은 날 두 반 수업을 들을 수
-- 있기 때문. 예전 (학생, 날짜) 인덱스는 아래 마이그레이션에서 지운다 —
-- 여기서 다시 만들면 재배포 때마다 충돌로 initSchema가 죽는다.
CREATE UNIQUE INDEX IF NOT EXISTS attendance_student_room_date
  ON attendance (student_id, room_id, class_date) WHERE student_id IS NOT NULL;

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

CREATE TABLE IF NOT EXISTS sms_intake (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  student_phone TEXT DEFAULT '',
  parent_phone TEXT DEFAULT '',
  raw_text TEXT,
  claimed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 이하 마이그레이션 ─────────────────────────────────────────────────
-- 이미 배포된 DB에도 안전하게 적용되도록 전부 IF NOT EXISTS로 쓴다.

-- 문자 가져오기로 들어오는 항목들. 등록일은 선생님이 직접 넣도록 비워 둔다.
ALTER TABLE students    ADD COLUMN IF NOT EXISTS student_phone TEXT DEFAULT '';
ALTER TABLE students    ADD COLUMN IF NOT EXISTS enrolled_at   DATE;
ALTER TABLE students    ADD COLUMN IF NOT EXISTS city          TEXT DEFAULT '';
ALTER TABLE students    ADD COLUMN IF NOT EXISTS tag           TEXT DEFAULT '';
ALTER TABLE students    ADD COLUMN IF NOT EXISTS memo          TEXT DEFAULT '';
ALTER TABLE sms_intake  ADD COLUMN IF NOT EXISTS city          TEXT DEFAULT '';
ALTER TABLE sms_intake  ADD COLUMN IF NOT EXISTS tag           TEXT DEFAULT '';
ALTER TABLE sms_intake  ADD COLUMN IF NOT EXISTS memo          TEXT DEFAULT '';

-- 한 학생이 여러 반에 속할 수 있게 하는 연결 테이블.
-- 반마다 수업 요일·시각이 다를 수 있으므로 일정도 여기에 함께 둔다
-- (students.schedule_* 는 호환을 위해 남겨두되 이제 쓰지 않는다).
CREATE TABLE IF NOT EXISTS student_classes (
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL,
  schedule_days TEXT DEFAULT '',
  schedule_time TEXT DEFAULT '',
  PRIMARY KEY (student_id, room_id)
);
CREATE INDEX IF NOT EXISTS student_classes_room ON student_classes (room_id);

-- 기존 단일 반(students.room_id) 정보를 새 테이블로 옮긴다. 아직 반이 하나도
-- 없는 학생만 대상으로 하므로 여러 번 실행돼도 안전하다.
INSERT INTO student_classes (student_id, room_id, schedule_days, schedule_time)
SELECT s.id, s.room_id, COALESCE(s.schedule_days,''), COALESCE(s.schedule_time,'')
FROM students s
WHERE s.room_id IS NOT NULL AND s.room_id <> ''
  AND NOT EXISTS (SELECT 1 FROM student_classes sc WHERE sc.student_id = s.id)
ON CONFLICT DO NOTHING;

-- 재원 상태: 재원(active) / 휴원(paused) / 퇴원(withdrawn).
-- 기존 active 불리언은 그대로 두고 이 값과 항상 함께 갱신한다. 그래야
-- 결석 감지·팀즈 명부 같은 기존 쿼리를 건드리지 않아도 휴원·퇴원 학생이
-- 자동으로 빠지고, 지난 출석 기록은 그대로 보존된다.
ALTER TABLE students ADD COLUMN IF NOT EXISTS enroll_status TEXT NOT NULL DEFAULT 'active';
UPDATE students SET enroll_status='paused' WHERE active=false AND enroll_status='active';

-- 문자에서 찾아낸 날짜 후보(등록일 "이 날짜로 채우기"용).
ALTER TABLE sms_intake ADD COLUMN IF NOT EXISTS date_hints TEXT DEFAULT '';

-- 연속 결석 계산과 월별 출석부 조회를 위한 인덱스.
CREATE INDEX IF NOT EXISTS attendance_student_date_desc ON attendance (student_id, class_date DESC);
CREATE INDEX IF NOT EXISTS attendance_room_date ON attendance (room_id, class_date);

-- 다중 반 등록의 핵심: 같은 학생이 같은 날 두 반 수업을 들을 수 있으므로
-- (학생, 날짜)가 아니라 (학생, 반, 날짜)가 유일해야 한다. 옛 인덱스가 더
-- 엄격했으므로 새 인덱스로 바꿔도 충돌은 생기지 않는다.
DROP INDEX IF EXISTS attendance_student_date;
`;

async function initSchema() {
  if (!enabled) return false;
  await pool.query(SCHEMA_SQL);
  console.log('[db] schema ready');
  return true;
}

module.exports = { enabled, query, initSchema, pool };
