// attendance.js — student roster, attendance capture, absence detection,
// and the parent-notification pipeline (manual now, auto-ready for later).
//
// Design:
//  - Every non-teacher, non-whiteboard join is matched against the `students`
//    table by (room_id, name). Unmatched names still get an attendance row
//    (student_id = NULL) so nothing is silently dropped, but they show up as
//    "미등록 학생" in the admin panel so the teacher can register them.
//  - A background sweep (checkAbsences) runs every few minutes. For any
//    active student whose scheduled class time + grace period has passed
//    today with no attendance row, it creates an 'absent' row and a
//    'pending' notification_log entry.
//  - sendKakaoAlimtalk() is a stub: until Phase 2 (Kakao business channel +
//    a dealer like Solapi/Aligo/Bizgo) is wired up via env vars, it always
//    reports "not configured". So even if a room's auto-send is switched
//    on, nothing actually goes out — pending items just wait for the
//    teacher to handle them manually from the 결석 알림 tab. Once real
//    credentials are added, flipping the toggle starts sending for real
//    with no other code changes needed.

const express = require('express');
const db = require('./db');

const KST_TZ = 'Asia/Seoul';
const DAY_CODES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const GRACE_MINUTES = Number(process.env.ATTENDANCE_GRACE_MINUTES || 10);
const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

function kstParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: KST_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  });
  const parts = {};
  fmt.formatToParts(date).forEach((p) => { parts[p.type] = p.value; });
  const dayCode = DAY_CODES[new Date(date.toLocaleString('en-US', { timeZone: KST_TZ })).getDay()];
  return {
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
    hhmm: `${parts.hour}:${parts.minute}`,
    dayCode,
  };
}

function isKakaoConfigured() {
  // Phase 2: set these once a dealer (Solapi/Aligo/Bizgo/NHN Cloud) account
  // and an approved template exist. Until then this stays false everywhere.
  return !!(process.env.KAKAO_ALIMTALK_API_KEY && process.env.KAKAO_ALIMTALK_SENDER_KEY);
}

async function sendKakaoAlimtalk(/* student, message */) {
  if (!isKakaoConfigured()) return { ok: false, reason: 'not_configured' };
  // TODO(Phase 2): call the chosen dealer's API here once credentials exist.
  return { ok: false, reason: 'not_implemented' };
}

function buildMessage(student, dateStr) {
  return `[MAGIC ENGLISH] ${student.name} 학생이 ${dateStr} 수업에 참석하지 않았습니다. 확인 부탁드립니다.`;
}

// --- Teams 단체반 출석: 선생님이 팀즈 "참가자" 목록을 붙여넣으면 파싱한다 ---
// Teams에서 회의 종료 후 참석자 패널을 복사하면 보통
// "이름 \t 첫 참가 \t 마지막 퇴장 \t 기간" 형태의 탭 구분 텍스트가 됨.
// 여러 로캘/버전에 따라 컬럼 구성이 달라 시각까지는 신뢰성 있게 파싱하지
// 않고, 첫 칸(이름)만 뽑아 "참석"으로 반영한다 — 출결 여부 판정에는
// 시각까지 필요하지 않기 때문.
function parseTeamsNames(rawText) {
  const headerKeywords = [
    'name', '이름', '참석자', 'attendee', 'full name', 'role', '역할',
    'join time', 'leave time', 'duration', '기간', '이메일', 'email',
    '1:1', 'meeting', '요약', 'summary', '참가', '참석',
  ];
  const lines = String(rawText || '').split(/\r?\n/);
  const names = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cells = trimmed.split('\t').map((c) => c.trim()).filter(Boolean);
    const first = (cells[0] || trimmed).trim();
    if (!first || first.length > 40) continue;
    const lower = first.toLowerCase();
    if (headerKeywords.some((k) => lower === k || lower.startsWith(k))) continue;
    if (/^\d/.test(first)) continue; // 시각/기간 등 숫자로 시작하는 행 제외
    if (first.includes('@')) continue; // 이메일 컬럼 제외
    names.push(first);
  }
  return Array.from(new Set(names));
}

// --- 문자(SMS)로 들어오는 학생 정보 파싱 -----------------------------------
// "이름(태그)" 형태의 줄을 새 블록의 시작으로 보고, 그 아래 "생 010..."
// (학생 번호) / "모 010..." 또는 "부 010..." (학부모 번호) 줄을 찾는다.
// 여러 건이 한 번에 붙여넣어져도 블록 단위로 잘라서 각각 반환한다.
function parseSmsBlocks(rawText) {
  const lines = String(rawText || '').split(/\r?\n/);
  const headerRe = /^(.{2,10}?)\([^)]*\)\s*$/;
  const blocks = [];
  let current = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(headerRe);
    if (m) {
      if (current) blocks.push(current);
      current = { name: m[1].trim(), studentPhone: '', parentPhone: '' };
      continue;
    }
    if (!current) continue;
    const sm = line.match(/^생\s*[:.]?\s*([0-9][0-9\s-]{8,14})/);
    if (sm) current.studentPhone = sm[1].replace(/[\s-]/g, '');
    const pm = line.match(/^(모|부)\s*[:.]?\s*([0-9][0-9\s-]{8,14})/);
    if (pm) current.parentPhone = pm[2].replace(/[\s-]/g, '');
  }
  if (current) blocks.push(current);
  return blocks.filter((b) => b.name);
}



async function recordJoin({ name, roomId }) {
  if (!db.enabled) return null;
  const cleanName = (name || '').trim();
  if (!cleanName) return null;
  const { dateStr } = kstParts();

  const studentRes = await db.query(
    'SELECT id FROM students WHERE room_id=$1 AND lower(name)=lower($2) AND active=true LIMIT 1',
    [roomId, cleanName]
  );
  const studentId = studentRes.rows[0] ? studentRes.rows[0].id : null;

  if (studentId) {
    const existing = await db.query(
      'SELECT id FROM attendance WHERE student_id=$1 AND class_date=$2',
      [studentId, dateStr]
    );
    if (existing.rows[0]) {
      await db.query('UPDATE attendance SET leave_time=NULL WHERE id=$1', [existing.rows[0].id]);
      return existing.rows[0].id;
    }
    const ins = await db.query(
      `INSERT INTO attendance (student_id, room_id, class_date, join_time, status, matched_name)
       VALUES ($1,$2,$3, now(), 'present', $4) RETURNING id`,
      [studentId, roomId, dateStr, cleanName]
    );
    return ins.rows[0].id;
  }

  // No roster match — still log it as unmatched so the teacher can register
  // the student later without losing the record. Reuse the same day's row
  // instead of piling up duplicates for every reconnect.
  const existingUnmatched = await db.query(
    'SELECT id FROM attendance WHERE student_id IS NULL AND room_id=$1 AND matched_name=$2 AND class_date=$3',
    [roomId, cleanName, dateStr]
  );
  if (existingUnmatched.rows[0]) {
    await db.query('UPDATE attendance SET leave_time=NULL WHERE id=$1', [existingUnmatched.rows[0].id]);
    return existingUnmatched.rows[0].id;
  }
  const ins = await db.query(
    `INSERT INTO attendance (student_id, room_id, class_date, join_time, status, matched_name)
     VALUES (NULL,$1,$2, now(), 'present', $3) RETURNING id`,
    [roomId, dateStr, cleanName]
  );
  return ins.rows[0].id;
}

async function recordLeave(attendanceId) {
  if (!db.enabled || !attendanceId) return;
  await db.query('UPDATE attendance SET leave_time=now() WHERE id=$1', [attendanceId]);
}

// --- Absence sweep ---------------------------------------------------------

async function checkAbsences() {
  if (!db.enabled) return;
  const { dateStr, hhmm, dayCode } = kstParts();

  const studentsRes = await db.query(
    `SELECT * FROM students WHERE active=true AND schedule_days LIKE '%' || $1 || '%' AND schedule_time <> ''`,
    [dayCode]
  );

  for (const student of studentsRes.rows) {
    if (student.schedule_time > hhmm) continue; // class hasn't started yet
    const [h, m] = student.schedule_time.split(':').map(Number);
    const scheduledMinutes = h * 60 + m;
    const [nh, nm] = hhmm.split(':').map(Number);
    const nowMinutes = nh * 60 + nm;
    if (nowMinutes - scheduledMinutes < GRACE_MINUTES) continue; // still within grace period

    const already = await db.query(
      'SELECT id FROM attendance WHERE student_id=$1 AND class_date=$2',
      [student.id, dateStr]
    );
    if (already.rows[0]) continue; // present, or already marked absent

    const att = await db.query(
      `INSERT INTO attendance (student_id, room_id, class_date, status, matched_name)
       VALUES ($1,$2,$3,'absent',$4) RETURNING id`,
      [student.id, student.room_id, dateStr, student.name]
    );
    const message = buildMessage(student, dateStr);
    const log = await db.query(
      `INSERT INTO notification_log (student_id, attendance_id, channel, status, message)
       VALUES ($1,$2,'kakao','pending',$3) RETURNING id`,
      [student.id, att.rows[0].id, message]
    );

    await maybeAutoNotify(student.room_id, log.rows[0].id, student, message);
  }
}

async function maybeAutoNotify(roomId, logId, student, message) {
  const settingsRes = await db.query('SELECT auto_send FROM notification_settings WHERE room_id=$1', [roomId]);
  const autoOn = !!(settingsRes.rows[0] && settingsRes.rows[0].auto_send);
  if (!autoOn) return; // stays 'pending' for the teacher to send manually

  const result = await sendKakaoAlimtalk(student, message);
  if (result.ok) {
    await db.query(
      `UPDATE notification_log SET status='sent_auto', sent_by='auto', resolved_at=now() WHERE id=$1`,
      [logId]
    );
  }
  // If not configured/not implemented yet, we deliberately leave it 'pending'
  // rather than 'failed' — nothing was actually attempted from the teacher's
  // point of view, so it should still show up for manual handling.
}

function startScheduler() {
  if (!db.enabled) return;
  checkAbsences().catch((e) => console.error('[attendance] sweep failed:', e.message));
  setInterval(() => {
    checkAbsences().catch((e) => console.error('[attendance] sweep failed:', e.message));
  }, SWEEP_INTERVAL_MS);
}

// --- REST API (mounted under /api/admin/attendance, admin-token gated) ---

function buildRouter({ verifyToken, bearer }) {
  const router = express.Router();

  function requireAdmin(req, res, next) {
    if (!db.enabled) return res.status(503).json({ ok: false, error: 'db-not-configured' });
    if (!verifyToken(bearer(req), 'admin')) return res.status(401).json({ ok: false, error: 'unauthorized' });
    next();
  }
  router.use(requireAdmin);

  // Students -----------------------------------------------------------
  router.get('/students', async (req, res) => {
    const r = await db.query('SELECT * FROM students ORDER BY room_id, name');
    res.json({ ok: true, students: r.rows });
  });

  router.post('/students', async (req, res) => {
    const { name, roomId, parentPhone, scheduleDays, scheduleTime } = req.body || {};
    if (!name || !roomId) return res.status(400).json({ ok: false, error: 'missing-fields' });
    const r = await db.query(
      `INSERT INTO students (name, room_id, parent_phone, schedule_days, schedule_time)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [String(name).slice(0, 40), String(roomId), parentPhone || '', scheduleDays || '', scheduleTime || '']
    );
    res.json({ ok: true, student: r.rows[0] });
  });

  router.put('/students/:id', async (req, res) => {
    const { name, roomId, parentPhone, scheduleDays, scheduleTime, active } = req.body || {};
    const r = await db.query(
      `UPDATE students SET name=COALESCE($1,name), room_id=COALESCE($2,room_id),
       parent_phone=COALESCE($3,parent_phone), schedule_days=COALESCE($4,schedule_days),
       schedule_time=COALESCE($5,schedule_time), active=COALESCE($6,active)
       WHERE id=$7 RETURNING *`,
      [name, roomId, parentPhone, scheduleDays, scheduleTime, active, req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ ok: false, error: 'not-found' });
    res.json({ ok: true, student: r.rows[0] });
  });

  router.delete('/students/:id', async (req, res) => {
    await db.query('DELETE FROM students WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  });

  // 문자로 들어온 학생 정보 -------------------------------------------------
  router.post('/sms-import', async (req, res) => {
    const { rawText } = req.body || {};
    if (!rawText) return res.status(400).json({ ok: false, error: 'missing-fields' });
    const blocks = parseSmsBlocks(rawText);
    let inserted = 0;
    for (const b of blocks) {
      await db.query(
        `INSERT INTO sms_intake (name, student_phone, parent_phone, raw_text) VALUES ($1,$2,$3,$4)`,
        [b.name, b.studentPhone, b.parentPhone, rawText]
      );
      inserted += 1;
    }
    res.json({ ok: true, count: inserted, items: blocks });
  });

  router.get('/sms-pending', async (req, res) => {
    const r = await db.query(
      `SELECT * FROM sms_intake WHERE claimed=false ORDER BY created_at DESC LIMIT 200`
    );
    res.json({ ok: true, items: r.rows });
  });

  router.post('/sms-pending/:id/claim', async (req, res) => {
    const { roomId, scheduleDays, scheduleTime } = req.body || {};
    if (!roomId) return res.status(400).json({ ok: false, error: 'missing-fields' });
    const rowRes = await db.query('SELECT * FROM sms_intake WHERE id=$1 AND claimed=false', [req.params.id]);
    const row = rowRes.rows[0];
    if (!row) return res.status(404).json({ ok: false, error: 'not-found' });

    const studentRes = await db.query(
      `INSERT INTO students (name, room_id, parent_phone, schedule_days, schedule_time)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [row.name.slice(0, 40), String(roomId), row.parent_phone || '', scheduleDays || '', scheduleTime || '']
    );
    await db.query('UPDATE sms_intake SET claimed=true WHERE id=$1', [row.id]);
    res.json({ ok: true, student: studentRes.rows[0] });
  });

  router.delete('/sms-pending/:id', async (req, res) => {
    await db.query('DELETE FROM sms_intake WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  });

  // 미매칭 출석: 명부에 없는 이름으로 들어온 기록들을 모아 보여주고,
  // 그 자리에서 학생으로 등록하면서 기존 출석 기록도 함께 연결한다.
  router.get('/unmatched', async (req, res) => {
    const r = await db.query(
      `SELECT room_id, matched_name, COUNT(*) AS cnt, MAX(class_date) AS last_date
       FROM attendance
       WHERE student_id IS NULL AND matched_name IS NOT NULL AND matched_name <> ''
       GROUP BY room_id, matched_name
       ORDER BY last_date DESC`
    );
    res.json({ ok: true, items: r.rows });
  });

  router.post('/unmatched/register', async (req, res) => {
    const { roomId, matchedName, parentPhone, scheduleDays, scheduleTime } = req.body || {};
    if (!roomId || !matchedName) return res.status(400).json({ ok: false, error: 'missing-fields' });

    const studentRes = await db.query(
      `INSERT INTO students (name, room_id, parent_phone, schedule_days, schedule_time)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [String(matchedName).slice(0, 40), String(roomId), parentPhone || '', scheduleDays || '', scheduleTime || '']
    );
    const student = studentRes.rows[0];

    const rowsRes = await db.query(
      `SELECT id, class_date FROM attendance
       WHERE student_id IS NULL AND room_id=$1 AND matched_name=$2
       ORDER BY class_date ASC, join_time ASC NULLS LAST`,
      [roomId, matchedName]
    );

    // A student can only have one attendance row per class_date (unique
    // index), so if the same unmatched name joined more than once on the
    // same day before being registered, keep the earliest row for that day
    // and drop the rest rather than failing the link.
    const seenDates = new Set();
    const keepIds = [];
    const dropIds = [];
    for (const row of rowsRes.rows) {
      const key = String(row.class_date);
      if (seenDates.has(key)) dropIds.push(row.id);
      else { seenDates.add(key); keepIds.push(row.id); }
    }
    if (dropIds.length) {
      await db.query('DELETE FROM attendance WHERE id = ANY($1::int[])', [dropIds]);
    }
    if (keepIds.length) {
      await db.query('UPDATE attendance SET student_id=$1 WHERE id = ANY($2::int[])', [student.id, keepIds]);
    }

    res.json({ ok: true, student, linkedCount: keepIds.length, mergedDuplicates: dropIds.length });
  });

  // 팀즈 단체반 출석 가져오기 ---------------------------------------------
  router.post('/teams-import', async (req, res) => {
    const { roomId, classDate, rawText } = req.body || {};
    if (!roomId || !classDate || !rawText) {
      return res.status(400).json({ ok: false, error: 'missing-fields' });
    }
    const presentNames = parseTeamsNames(rawText);
    const studentsRes = await db.query('SELECT * FROM students WHERE room_id=$1 AND active=true', [roomId]);

    const matched = [];
    const unmatched = [];
    const matchedStudentIds = new Set();

    for (const nm of presentNames) {
      const student = studentsRes.rows.find((s) => s.name.toLowerCase() === nm.toLowerCase());
      if (!student) { unmatched.push(nm); continue; }
      matchedStudentIds.add(student.id);
      matched.push(nm);
      await db.query(
        `INSERT INTO attendance (student_id, room_id, class_date, status, matched_name)
         VALUES ($1,$2,$3,'present',$4)
         ON CONFLICT (student_id, class_date) WHERE student_id IS NOT NULL
         DO UPDATE SET status='present', matched_name=$4`,
        [student.id, roomId, classDate, nm]
      );
    }

    let absentCount = 0;
    for (const student of studentsRes.rows) {
      if (matchedStudentIds.has(student.id)) continue;
      const existing = await db.query(
        'SELECT id FROM attendance WHERE student_id=$1 AND class_date=$2',
        [student.id, classDate]
      );
      if (existing.rows[0]) continue; // 이미 기록됨 (다른 경로로)

      const att = await db.query(
        `INSERT INTO attendance (student_id, room_id, class_date, status, matched_name)
         VALUES ($1,$2,$3,'absent',$4) RETURNING id`,
        [student.id, roomId, classDate, student.name]
      );
      const message = buildMessage(student, classDate);
      const log = await db.query(
        `INSERT INTO notification_log (student_id, attendance_id, channel, status, message)
         VALUES ($1,$2,'kakao','pending',$3) RETURNING id`,
        [student.id, att.rows[0].id, message]
      );
      await maybeAutoNotify(roomId, log.rows[0].id, student, message);
      absentCount += 1;
    }

    res.json({ ok: true, matchedCount: matched.length, absentCount, unmatched });
  });

  // Stats ----------------------------------------------------------------
  router.get('/stats', async (req, res) => {
    const { roomId, from, to } = req.query;
    const clauses = [];
    const params = [];
    if (roomId) { params.push(roomId); clauses.push(`s.room_id=$${params.length}`); }
    if (from) { params.push(from); clauses.push(`a.class_date>=$${params.length}`); }
    if (to) { params.push(to); clauses.push(`a.class_date<=$${params.length}`); }
    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
    const r = await db.query(
      `SELECT s.id, s.name, s.room_id,
              COUNT(*) FILTER (WHERE a.status='present') AS present_count,
              COUNT(*) FILTER (WHERE a.status='absent') AS absent_count,
              COUNT(*) AS total_count
       FROM students s
       LEFT JOIN attendance a ON a.student_id = s.id
       ${where}
       GROUP BY s.id, s.name, s.room_id
       ORDER BY s.room_id, s.name`,
      params
    );
    res.json({ ok: true, stats: r.rows });
  });

  // Absence / notification queue -----------------------------------------
  router.get('/absences', async (req, res) => {
    const r = await db.query(
      `SELECT n.id AS log_id, n.status, n.message, n.created_at, n.sent_by,
              a.class_date, a.room_id, s.id AS student_id, s.name, s.parent_phone
       FROM notification_log n
       JOIN attendance a ON a.id = n.attendance_id
       JOIN students s ON s.id = n.student_id
       ORDER BY n.created_at DESC LIMIT 200`
    );
    res.json({ ok: true, items: r.rows, kakaoConfigured: isKakaoConfigured() });
  });

  router.post('/notify', async (req, res) => {
    const { logId, action } = req.body || {}; // action: 'send' | 'skip'
    if (!logId || !['send', 'skip'].includes(action)) {
      return res.status(400).json({ ok: false, error: 'bad-request' });
    }
    const status = action === 'send' ? 'sent_manual' : 'skipped';
    const r = await db.query(
      `UPDATE notification_log SET status=$1, sent_by='manual', resolved_at=now()
       WHERE id=$2 AND status='pending' RETURNING id`,
      [status, logId]
    );
    if (!r.rows[0]) return res.status(409).json({ ok: false, error: 'already-resolved' });
    res.json({ ok: true });
  });

  // Auto-send toggle, per room ---------------------------------------------
  router.get('/settings', async (req, res) => {
    const r = await db.query('SELECT room_id, auto_send FROM notification_settings');
    res.json({ ok: true, settings: r.rows, kakaoConfigured: isKakaoConfigured() });
  });

  router.post('/settings/:roomId', async (req, res) => {
    const autoSend = !!(req.body && req.body.autoSend);
    await db.query(
      `INSERT INTO notification_settings (room_id, auto_send) VALUES ($1,$2)
       ON CONFLICT (room_id) DO UPDATE SET auto_send=$2`,
      [req.params.roomId, autoSend]
    );
    res.json({ ok: true, kakaoConfigured: isKakaoConfigured() });
  });

  return router;
}

// 폰 자동화 앱(MacroDroid 등)이 문자 수신 시 호출하는 웹훅. 관리자 로그인
// 토큰(8시간 만료)과는 별개로, SMS_INTAKE_SECRET 환경변수 하나로만 인증한다.
// 이 값이 설정돼 있지 않으면 항상 503을 반환해 실수로 열려있지 않게 한다.
function buildWebhookRouter() {
  const router = express.Router();
  router.post('/', async (req, res) => {
    const secret = process.env.SMS_INTAKE_SECRET || '';
    if (!secret) return res.status(503).json({ ok: false, error: 'sms-intake-not-configured' });
    if (!db.enabled) return res.status(503).json({ ok: false, error: 'db-not-configured' });

    const provided = req.headers['x-intake-key'] || (req.body && req.body.key) || '';
    if (provided !== secret) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const rawText = (req.body && req.body.text) || '';
    if (!rawText) return res.status(400).json({ ok: false, error: 'missing-text' });

    const blocks = parseSmsBlocks(rawText);
    for (const b of blocks) {
      await db.query(
        `INSERT INTO sms_intake (name, student_phone, parent_phone, raw_text) VALUES ($1,$2,$3,$4)`,
        [b.name, b.studentPhone, b.parentPhone, rawText]
      );
    }
    res.json({ ok: true, count: blocks.length });
  });
  return router;
}

module.exports = { recordJoin, recordLeave, startScheduler, buildRouter, buildWebhookRouter, isKakaoConfigured };
