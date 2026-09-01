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
// 수업 시작 후 이 분(分)을 넘겨 들어오면 '지각'으로 기록한다.
const LATE_MINUTES = Number(process.env.ATTENDANCE_LATE_MINUTES || 5);
// 연속 결석 경고 기준과, 최근 30일 결석 누적 경고 기준.
const ALERT_STREAK = Number(process.env.ATTENDANCE_ALERT_STREAK || 2);
const ALERT_MONTHLY = Number(process.env.ATTENDANCE_ALERT_MONTHLY || 3);
const ENROLL_STATUSES = ['active', 'paused', 'withdrawn'];
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

// 이 파일의 모든 API 핸들러는 async라서, DB 쿼리가 하나라도 실패하면(예:
// 무료 Postgres가 절전 모드에서 깨어나는 순간의 일시적 연결 오류) 그 에러가
// Express 밖으로 새어나가 Node 프로세스 전체를 죽일 수 있다(Node 15+는
// 처리되지 않은 프라미스 거부 시 기본적으로 프로세스를 종료함). 이건 그
// 순간 접속해 있던 모든 사람의 화상 수업을 동시에 끊어버리는 결과로
// 이어지므로, 모든 라우트를 이 래퍼로 감싸서 500 응답만 내려주고 서버는
// 계속 살아있도록 한다. buildRouter와 buildWebhookRouter가 함께 쓰므로
// 모듈 최상위에 둔다.
function ah(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((err) => {
      console.error('[attendance] route error:', err && err.message);
      if (!res.headersSent) res.status(500).json({ ok: false, error: 'server-error' });
    });
  };
}

// --- 반 코드 -------------------------------------------------------------
// 명부·통계에서 반을 한 글자로 압축해 보여준다. 한 학생이 여러 반이면
// "A G" 처럼 나란히 붙는다.
const ROOM_LETTER = {
  basic: 'B', grammar: 'G', intermediate: 'I', advanced: 'A', private: 'P',
};
const ROOM_IDS = Object.keys(ROOM_LETTER);
function roomLetter(roomId) { return ROOM_LETTER[roomId] || String(roomId || '?').slice(0, 1).toUpperCase(); }
function validRooms(list) {
  const arr = Array.isArray(list) ? list : (list ? [list] : []);
  return Array.from(new Set(arr.map(String).filter((r) => ROOM_IDS.includes(r))));
}

// --- 지역(시) 추출 --------------------------------------------------------
// 실제 문자에서 주소 형식이 제각각이라("부산시 해운대구", "경기도 김포시",
// "기흥구동백죽전대로…") 두 단계로 찾는다.
// 1) '○○시/군'을 직접 찾되, '수시·정시' 같은 입시 낱말은 걸러낸다.
// 2) 시가 없고 구만 있으면 구→시 표에서 되찾는다(기흥구 → 용인시).
const NOT_CITY = new Set([
  '수시', '정시', '입시', '응시', '고시', '즉시', '당시', '동시', '임시',
  '일시', '잠시', '무시', '예시', '표시', '지시', '실시', '개시', '제시', '중시', '명시',
]);
const GU_TO_CITY = {
  종로구: '서울시', 용산구: '서울시', 성동구: '서울시', 광진구: '서울시', 동대문구: '서울시',
  중랑구: '서울시', 성북구: '서울시', 강북구: '서울시', 도봉구: '서울시', 노원구: '서울시',
  은평구: '서울시', 서대문구: '서울시', 마포구: '서울시', 양천구: '서울시', 구로구: '서울시',
  금천구: '서울시', 영등포구: '서울시', 동작구: '서울시', 관악구: '서울시', 서초구: '서울시',
  강남구: '서울시', 송파구: '서울시', 강동구: '서울시',
  해운대구: '부산시', 수영구: '부산시', 사하구: '부산시', 금정구: '부산시', 연제구: '부산시',
  동래구: '부산시', 사상구: '부산시', 영도구: '부산시', 기장군: '부산시',
  미추홀구: '인천시', 연수구: '인천시', 남동구: '인천시', 부평구: '인천시', 계양구: '인천시', 옹진군: '인천시',
  달서구: '대구시', 수성구: '대구시', 달성군: '대구시',
  유성구: '대전시', 대덕구: '대전시', 광산구: '광주시', 울주군: '울산시',
  장안구: '수원시', 권선구: '수원시', 팔달구: '수원시', 영통구: '수원시',
  수정구: '성남시', 중원구: '성남시', 분당구: '성남시',
  만안구: '안양시', 동안구: '안양시', 상록구: '안산시', 단원구: '안산시',
  덕양구: '고양시', 일산동구: '고양시', 일산서구: '고양시',
  처인구: '용인시', 기흥구: '용인시', 수지구: '용인시',
  동남구: '천안시', 서북구: '천안시',
  상당구: '청주시', 서원구: '청주시', 흥덕구: '청주시', 청원구: '청주시',
  완산구: '전주시', 덕진구: '전주시',
  의창구: '창원시', 성산구: '창원시', 마산합포구: '창원시', 마산회원구: '창원시', 진해구: '창원시',
};

function extractCity(text) {
  const s = String(text || '');
  const re = /([가-힣]{2,6}?)(?:특별자치시|광역시|특별시|자치시|시|군)(?=[\s,/]|$|[가-힣]{2,6}(?:구|읍|면))/g;
  let m;
  while ((m = re.exec(s))) {
    const base = m[1];
    if (NOT_CITY.has(base + '시') || NOT_CITY.has(base)) continue;
    if (base.endsWith('도')) continue; // '경기도' 같은 광역 단위는 시가 아니다
    return base + '시';
  }
  const gus = s.match(/[가-힣]{2,6}구/g);
  if (gus) { for (const g of gus) { if (GU_TO_CITY[g]) return GU_TO_CITY[g]; } }
  return '';
}

// --- 날짜 정규화 ----------------------------------------------------------
// pg는 DATE 컬럼을 문자열이 아니라 Date 객체로 돌려준다. 그대로 String()을
// 씌우면 "Tue Sep 01 2026 …"이 되어 slice(0,10)이 엉뚱한 값을 준다.
// toISOString()은 UTC로 바꾸며 하루가 밀릴 수 있으므로 로컬 값을 직접 쓴다.
function isoDate(v) {
  if (v instanceof Date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v || '').slice(0, 10);
}

// --- 전화번호 정규화 ------------------------------------------------------
function normPhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('01')) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  if (d.length === 10 && d.startsWith('01')) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  return '';
}

// '생'/'모'/'부' 표시 뒤의 번호를 줄 안 어디에 있든 찾는다. 실제 문자에는
// "생01092207626모01082787626"(붙어 있음), "생 010… 모 010…"(한 줄),
// "생0108005-4101"(하이픈 오타) 같은 변형이 섞여 들어온다. 0으로 시작하는
// 것만 받으므로 "생baseballking1004@naver.com" 같은 이메일은 걸러진다.
function grabPhone(text, markers) {
  const re = new RegExp(`(?:${markers})\\s*[:.]?\\s*(0[\\d\\s.-]{8,16})`, 'g');
  let m;
  while ((m = re.exec(text))) { const p = normPhone(m[1]); if (p) return p; }
  return '';
}

// --- 문자 속 날짜 후보 --------------------------------------------------
// 문자에 "2024년12월19일 국민카드 500만 결제완료"처럼 결제·상담 날짜가 적혀
// 오는 일이 많다. 이걸 등록일로 자동 확정해 버리면 틀릴 수 있으니, 후보만
// 뽑아서 화면에 버튼으로 보여주고 선생님이 눌러서 채우도록 한다.
function extractDateHints(text) {
  const s = String(text || '');
  const out = [];
  const push = (y, m, d) => {
    const yy = Number(y) < 100 ? 2000 + Number(y) : Number(y);
    const mm = Number(m); const dd = Number(d);
    if (yy < 2000 || yy > 2100 || mm < 1 || mm > 12 || dd < 1 || dd > 31) return;
    const iso = `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    if (!out.includes(iso)) out.push(iso);
  };
  let m;
  const reKo = /(\d{2,4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/g;
  while ((m = reKo.exec(s))) push(m[1], m[2], m[3]);
  const reNum = /(?<![\d-])(\d{4})[.\-\/](\d{1,2})[.\-\/](\d{1,2})(?![\d-])/g;
  while ((m = reNum.exec(s))) push(m[1], m[2], m[3]);
  return out.slice(0, 5);
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

  // 한 조각(이름 후보)을 다듬는다. 목록을 복사하지 못해 이름만 손으로 적는
  // 경우도 받아야 하므로, 번호 매김("1. 김은설")·역할 표시("김은설(게스트)")
  // 같은 군더더기를 떼어낸 뒤에 판정한다.
  function cleanCandidate(piece) {
    let s = String(piece || '').trim();
    if (!s) return '';
    s = s.replace(/^[\d]+\s*[.)]\s*/, '');      // "1. " / "2) " 번호 매김
    s = s.replace(/^[-–—•*·]\s*/, '');           // 글머리 기호
    s = s.replace(/\([^)]*\)\s*$/, '').trim();   // 뒤에 붙은 "(주최자)" 등
    s = s.replace(/\s*(주최자|발표자|참석자|게스트|organizer|presenter|attendee)\s*$/i, '').trim();
    if (!s || s.length > 40) return '';
    const lower = s.toLowerCase();
    if (headerKeywords.some((k) => lower === k || lower.startsWith(k))) return '';
    if (/^\d/.test(s)) return '';   // 시각·기간 등 숫자로 시작하는 값
    if (s.includes('@')) return ''; // 이메일 컬럼
    return s;
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.includes('\t')) {
      // 팀즈 참석자 표를 그대로 붙여넣은 경우: 첫 칸(이름)만 쓴다.
      const first = trimmed.split('\t')[0].trim();
      const nm = cleanCandidate(first);
      if (nm) names.push(nm);
    } else {
      // 이름만 적은 경우: 줄바꿈뿐 아니라 쉼표·가운뎃점 구분도 받아준다.
      trimmed.split(/[,;·、\/]+/).forEach((piece) => {
        const nm = cleanCandidate(piece);
        if (nm) names.push(nm);
      });
    }
  }
  return Array.from(new Set(names));
}

// --- 문자(SMS)로 들어오는 학생 정보 파싱 -----------------------------------
// "이름(태그)" 형태의 줄을 새 블록의 시작으로 보고, 그 아래 "생 010..."
// (학생 번호) / "모 010..." 또는 "부 010..." (학부모 번호) 줄을 찾는다.
// 여러 건이 한 번에 붙여넣어져도 블록 단위로 잘라서 각각 반환한다.
function parseSmsBlocks(rawText) {
  // 1단계: 줄 정리. 카톡/문자 내보내기의 "[보낸사람] [시각]" 접두어를 떼고,
  // 본문과 내용이 겹치는 "제목 …" 미리보기 줄은 버린다. (한글은 자바스크립트
  // 정규식의 \w가 아니라서 \b 경계가 먹지 않으므로 뒤 문자를 직접 지정한다.)
  const lines = [];
  for (const raw of String(rawText || '').split(/\r?\n/)) {
    const line = raw.replace(/^\s*\[[^\]]{1,40}\]\s*\[[^\]]{1,30}\]\s*/, '').trim();
    if (!line) continue;
    if (/^제목[\s:]/.test(line)) continue;
    lines.push(line);
  }

  // 2단계: "이름(태그)"만 있는 줄을 새 학생의 시작으로 보고 블록을 자른다.
  // 태그는 지역이 아니라 담당자·전형 표시라서(예: "최진영/학종") 따로 담는다.
  const headerRe = /^(.{2,10}?)\(([^)]*)\)\s*$/;
  const blocks = [];
  let current = null;

  function finish() {
    if (!current) return;
    const body = current.bodyLines.join(' ');
    blocks.push({
      name: current.name,
      tag: current.tag,
      studentPhone: grabPhone(body, '생'),
      parentPhone: grabPhone(body, '모|부|학부모'),
      city: extractCity(body),
      dateHints: extractDateHints(body),
      // 학교·등급·희망학과처럼 우리가 따로 칸을 두지 않은 정보도 버리지 않고
      // 메모로 남겨, 나중에 명부에서 검색할 수 있게 한다.
      memo: body.slice(0, 500),
    });
    current = null;
  }

  for (const line of lines) {
    const m = line.match(headerRe);
    if (m) { finish(); current = { name: m[1].trim(), tag: m[2].trim(), bodyLines: [] }; continue; }
    if (!current) continue;
    current.bodyLines.push(line);
  }
  finish();
  return blocks.filter((b) => b.name);
}



// 수업 시작 시각이 정해져 있고, 그보다 LATE_MINUTES 넘게 늦게 들어왔으면 지각.
// 시각이 비어 있는 반(자유 시간표)은 지각 판정을 하지 않는다.
function isLate(scheduleTime, hhmm) {
  if (!scheduleTime || !/^\d{1,2}:\d{2}$/.test(scheduleTime)) return false;
  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  return toMin(hhmm) - toMin(scheduleTime) > LATE_MINUTES;
}

async function recordJoin({ name, roomId }) {
  if (!db.enabled) return null;
  const cleanName = (name || '').trim();
  if (!cleanName) return null;
  const { dateStr, hhmm } = kstParts();

  // 이 방에 등록된 학생인지 student_classes로 확인한다(한 학생이 여러 반).
  // 지각 판정에 쓸 이 반의 수업 시작 시각도 함께 가져온다.
  const studentRes = await db.query(
    `SELECT s.id, sc.schedule_time FROM students s
       JOIN student_classes sc ON sc.student_id = s.id
      WHERE sc.room_id=$1 AND lower(s.name)=lower($2) AND s.active=true
      LIMIT 1`,
    [roomId, cleanName]
  );
  const studentId = studentRes.rows[0] ? studentRes.rows[0].id : null;

  if (studentId) {
    const existing = await db.query(
      'SELECT id FROM attendance WHERE student_id=$1 AND room_id=$2 AND class_date=$3',
      [studentId, roomId, dateStr]
    );
    if (existing.rows[0]) {
      // 재접속이면 상태는 건드리지 않는다 — 처음 들어온 시각으로 이미 판정했다.
      await db.query('UPDATE attendance SET leave_time=NULL WHERE id=$1', [existing.rows[0].id]);
      return existing.rows[0].id;
    }
    const status = isLate(studentRes.rows[0].schedule_time, hhmm) ? 'late' : 'present';
    const ins = await db.query(
      `INSERT INTO attendance (student_id, room_id, class_date, join_time, status, matched_name)
       VALUES ($1,$2,$3, now(), $4, $5) RETURNING id`,
      [studentId, roomId, dateStr, status, cleanName]
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

  // 반마다 요일·시각이 다를 수 있으므로 (학생 × 반) 단위로 훑는다.
  const studentsRes = await db.query(
    `SELECT s.id, s.name, sc.room_id, sc.schedule_time
       FROM students s
       JOIN student_classes sc ON sc.student_id = s.id
      WHERE s.active=true
        AND sc.schedule_days LIKE '%' || $1 || '%'
        AND sc.schedule_time <> ''`,
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
      'SELECT id FROM attendance WHERE student_id=$1 AND room_id=$2 AND class_date=$3',
      [student.id, student.room_id, dateStr]
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
  // 학생 한 명이 여러 반에 속하므로, 반 목록은 student_classes에서 모아
  // classes 배열로 함께 내려준다. 정렬(이름순·등록일순 등)은 화면에서
  // 즉시 바꿀 수 있도록 클라이언트가 담당한다.
  const STUDENT_SELECT = `
    SELECT s.*,
           COALESCE(
             json_agg(json_build_object(
               'roomId', sc.room_id, 'days', sc.schedule_days, 'time', sc.schedule_time
             ) ORDER BY sc.room_id) FILTER (WHERE sc.room_id IS NOT NULL),
             '[]'::json) AS classes
      FROM students s
      LEFT JOIN student_classes sc ON sc.student_id = s.id`;

  function withLetters(row) {
    const classes = (row.classes || []).map((c) => ({ ...c, letter: roomLetter(c.roomId) }));
    return { ...row, classes };
  }

  // 재원 상태를 바꿀 때 기존 active 불리언도 함께 맞춘다. 결석 감지·팀즈
  // 명부 등 기존 쿼리가 전부 active를 보고 있어서, 이렇게 해두면 휴원·퇴원
  // 학생이 자동으로 빠지면서 지난 출석 기록은 그대로 남는다.
  async function setEnrollStatus(id, status) {
    if (!ENROLL_STATUSES.includes(status)) return false;
    await db.query('UPDATE students SET enroll_status=$1, active=$2 WHERE id=$3',
      [status, status === 'active', id]);
    return true;
  }

  // 요청으로 들어온 반 목록을 통째로 갈아끼운다. ['basic','grammar'] 처럼
  // 문자열 배열이어도 되고, [{roomId, days, time}] 형태여도 된다.
  async function saveClasses(studentId, classes) {
    const list = (Array.isArray(classes) ? classes : []).map((c) => (
      typeof c === 'string' ? { roomId: c, days: '', time: '' } : (c || {})
    )).filter((c) => ROOM_IDS.includes(String(c.roomId)));
    const seen = new Set();
    await db.query('DELETE FROM student_classes WHERE student_id=$1', [studentId]);
    for (const c of list) {
      if (seen.has(c.roomId)) continue;
      seen.add(c.roomId);
      await db.query(
        `INSERT INTO student_classes (student_id, room_id, schedule_days, schedule_time)
         VALUES ($1,$2,$3,$4) ON CONFLICT (student_id, room_id)
         DO UPDATE SET schedule_days=$3, schedule_time=$4`,
        [studentId, c.roomId, c.days || '', c.time || '']
      );
    }
    return Array.from(seen);
  }

  async function fetchStudent(id) {
    const r = await db.query(`${STUDENT_SELECT} WHERE s.id=$1 GROUP BY s.id`, [id]);
    return r.rows[0] ? withLetters(r.rows[0]) : null;
  }

  router.get('/students', ah(async (req, res) => {
    const r = await db.query(`${STUDENT_SELECT} GROUP BY s.id ORDER BY s.name`);
    res.json({ ok: true, students: r.rows.map(withLetters), rooms: ROOM_LETTER });
  }));

  router.post('/students', ah(async (req, res) => {
    const b = req.body || {};
    const rooms = validRooms(b.classes && b.classes.length ? b.classes.map((c) => (typeof c === 'string' ? c : c.roomId)) : b.roomId);
    if (!b.name || rooms.length === 0) return res.status(400).json({ ok: false, error: 'missing-fields' });
    const r = await db.query(
      `INSERT INTO students (name, room_id, parent_phone, student_phone, enrolled_at, city, tag, memo,
                             schedule_days, schedule_time)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        String(b.name).slice(0, 40), rooms[0], b.parentPhone || '', b.studentPhone || '',
        b.enrolledAt || null, b.city || '', b.tag || '', b.memo || '',
        b.scheduleDays || '', b.scheduleTime || '',
      ]
    );
    const id = r.rows[0].id;
    await saveClasses(id, b.classes && b.classes.length ? b.classes : rooms.map((rm) => ({
      roomId: rm, days: b.scheduleDays || '', time: b.scheduleTime || '',
    })));
    res.json({ ok: true, student: await fetchStudent(id) });
  }));

  router.put('/students/:id', ah(async (req, res) => {
    const b = req.body || {};
    // enrolledAt은 빈 문자열로 지울 수 있어야 하므로 undefined일 때만 건너뛴다.
    const enrolled = b.enrolledAt === undefined ? undefined : (b.enrolledAt || null);
    const r = await db.query(
      `UPDATE students SET name=COALESCE($1,name),
              parent_phone=COALESCE($2,parent_phone), student_phone=COALESCE($3,student_phone),
              enrolled_at=CASE WHEN $4::boolean THEN $5::date ELSE enrolled_at END,
              city=COALESCE($6,city), tag=COALESCE($7,tag), memo=COALESCE($8,memo),
              active=COALESCE($9,active)
       WHERE id=$10 RETURNING id`,
      [
        b.name ?? null, b.parentPhone ?? null, b.studentPhone ?? null,
        enrolled !== undefined, enrolled ?? null,
        b.city ?? null, b.tag ?? null, b.memo ?? null, b.active ?? null, req.params.id,
      ]
    );
    if (!r.rows[0]) return res.status(404).json({ ok: false, error: 'not-found' });
    if (Array.isArray(b.classes)) {
      const rooms = await saveClasses(req.params.id, b.classes);
      if (rooms[0]) await db.query('UPDATE students SET room_id=$1 WHERE id=$2', [rooms[0], req.params.id]);
    }
    if (b.enrollStatus) await setEnrollStatus(req.params.id, b.enrollStatus);
    res.json({ ok: true, student: await fetchStudent(req.params.id) });
  }));

  router.delete('/students/:id', ah(async (req, res) => {
    await db.query('DELETE FROM students WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  }));

  // 문자로 들어온 학생 정보 -------------------------------------------------
  router.post('/sms-import', ah(async (req, res) => {
    const { rawText } = req.body || {};
    if (!rawText) return res.status(400).json({ ok: false, error: 'missing-fields' });
    const blocks = parseSmsBlocks(rawText);
    let inserted = 0;
    for (const b of blocks) {
      await db.query(
        `INSERT INTO sms_intake (name, student_phone, parent_phone, city, tag, memo, date_hints, raw_text)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [b.name, b.studentPhone, b.parentPhone, b.city, b.tag, b.memo,
         (b.dateHints || []).join(','), rawText]
      );
      inserted += 1;
    }
    res.json({ ok: true, count: inserted, items: blocks });
  }));

  router.get('/sms-pending', ah(async (req, res) => {
    const r = await db.query(
      `SELECT * FROM sms_intake WHERE claimed=false ORDER BY created_at DESC LIMIT 200`
    );
    res.json({ ok: true, items: r.rows });
  }));

  router.post('/sms-pending/:id/claim', ah(async (req, res) => {
    const b = req.body || {};
    const rooms = validRooms(b.classes && b.classes.length ? b.classes : b.roomId);
    if (rooms.length === 0) return res.status(400).json({ ok: false, error: 'missing-fields' });
    const rowRes = await db.query('SELECT * FROM sms_intake WHERE id=$1 AND claimed=false', [req.params.id]);
    const row = rowRes.rows[0];
    if (!row) return res.status(404).json({ ok: false, error: 'not-found' });

    // 등록일·지역은 선생님이 화면에서 고친 값이 있으면 그걸 우선한다.
    // 등록일은 문자에서 자동으로 채우지 않고 빈칸으로 두는 것이 기본이다.
    const studentRes = await db.query(
      `INSERT INTO students (name, room_id, parent_phone, student_phone, enrolled_at, city, tag, memo,
                             schedule_days, schedule_time)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        row.name.slice(0, 40), rooms[0], row.parent_phone || '', row.student_phone || '',
        b.enrolledAt || null, b.city !== undefined ? b.city : (row.city || ''),
        row.tag || '', row.memo || '', b.scheduleDays || '', b.scheduleTime || '',
      ]
    );
    const id = studentRes.rows[0].id;
    await saveClasses(id, rooms.map((rm) => ({ roomId: rm, days: b.scheduleDays || '', time: b.scheduleTime || '' })));
    await db.query('UPDATE sms_intake SET claimed=true WHERE id=$1', [row.id]);
    res.json({ ok: true, student: await fetchStudent(id) });
  }));

  router.delete('/sms-pending/:id', ah(async (req, res) => {
    await db.query('DELETE FROM sms_intake WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  }));

  // 미매칭 출석: 명부에 없는 이름으로 들어온 기록들을 모아 보여주고,
  // 그 자리에서 학생으로 등록하면서 기존 출석 기록도 함께 연결한다.
  router.get('/unmatched', ah(async (req, res) => {
    const r = await db.query(
      `SELECT room_id, matched_name, COUNT(*) AS cnt, MAX(class_date) AS last_date
       FROM attendance
       WHERE student_id IS NULL AND matched_name IS NOT NULL AND matched_name <> ''
       GROUP BY room_id, matched_name
       ORDER BY last_date DESC`
    );
    res.json({ ok: true, items: r.rows });
  }));

  router.post('/unmatched/register', ah(async (req, res) => {
    const { roomId, matchedName, parentPhone, scheduleDays, scheduleTime } = req.body || {};
    if (!roomId || !matchedName) return res.status(400).json({ ok: false, error: 'missing-fields' });

    const studentRes = await db.query(
      `INSERT INTO students (name, room_id, parent_phone, schedule_days, schedule_time)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [String(matchedName).slice(0, 40), String(roomId), parentPhone || '', scheduleDays || '', scheduleTime || '']
    );
    const student = studentRes.rows[0];
    // 여러 반을 함께 지정했으면 모두 등록한다(지정이 없으면 이 방 하나만).
    const rooms = validRooms((req.body && req.body.classes) || [roomId]);
    await saveClasses(student.id, (rooms.length ? rooms : [roomId]).map((rm) => ({
      roomId: rm, days: scheduleDays || '', time: scheduleTime || '',
    })));

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
      const key = isoDate(row.class_date);
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
  }));

  // 팀즈 단체반 출석 가져오기 ---------------------------------------------
  router.post('/teams-import', ah(async (req, res) => {
    const { roomId, classDate, rawText, lateText } = req.body || {};
    if (!roomId || !classDate || !rawText) {
      return res.status(400).json({ ok: false, error: 'missing-fields' });
    }
    const presentNames = parseTeamsNames(rawText);
    // 지각한 학생 이름을 따로 적어주면 그 학생만 '지각'으로 기록한다.
    // 참석 목록에 빠져 있어도 지각 명단에 있으면 참석한 것으로 본다.
    const lateNames = parseTeamsNames(lateText || '');
    const lateSet = new Set(lateNames.map((n) => n.toLowerCase()));
    lateNames.forEach((n) => { if (!presentNames.includes(n)) presentNames.push(n); });
    // 이 반에 등록된 학생 전체(다른 반에도 속해 있을 수 있다).
    const studentsRes = await db.query(
      `SELECT s.* FROM students s
         JOIN student_classes sc ON sc.student_id = s.id
        WHERE sc.room_id=$1 AND s.active=true`,
      [roomId]
    );

    const matched = [];
    const unmatched = [];
    const matchedStudentIds = new Set();

    for (const nm of presentNames) {
      const student = studentsRes.rows.find((s) => s.name.toLowerCase() === nm.toLowerCase());
      if (!student) { unmatched.push(nm); continue; }
      matchedStudentIds.add(student.id);
      matched.push(nm);
      const st = lateSet.has(nm.toLowerCase()) ? 'late' : 'present';
      await db.query(
        `INSERT INTO attendance (student_id, room_id, class_date, status, matched_name)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (student_id, room_id, class_date) WHERE student_id IS NOT NULL
         DO UPDATE SET status=$4, matched_name=$5`,
        [student.id, roomId, classDate, st, nm]
      );
    }

    let absentCount = 0;
    for (const student of studentsRes.rows) {
      if (matchedStudentIds.has(student.id)) continue;
      const existing = await db.query(
        'SELECT id FROM attendance WHERE student_id=$1 AND room_id=$2 AND class_date=$3',
        [student.id, roomId, classDate]
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

    res.json({
      ok: true, matchedCount: matched.length, absentCount, unmatched,
      lateCount: matched.filter((n) => lateSet.has(n.toLowerCase())).length,
    });
  }));

  // 결석 경고 -------------------------------------------------------------
  // 연속 결석과 최근 30일 결석 누적을 학생·반 단위로 계산한다. 연속 횟수는
  // 최근 날짜부터 훑어 'absent'가 이어지는 만큼만 센다(중간에 출석/지각이
  // 하나라도 있으면 거기서 끊긴다).
  router.get('/alerts', ah(async (req, res) => {
    const r = await db.query(
      `SELECT a.student_id, a.room_id, a.class_date, a.status, s.name, s.parent_phone
         FROM attendance a JOIN students s ON s.id = a.student_id
        WHERE a.student_id IS NOT NULL AND s.enroll_status='active'
        ORDER BY a.student_id, a.room_id, a.class_date DESC`
    );
    const today = new Date();
    const cutoff = new Date(today.getTime() - 30 * 86400000).toISOString().slice(0, 10);

    const byPair = new Map();
    for (const row of r.rows) {
      const key = `${row.student_id}|${row.room_id}`;
      if (!byPair.has(key)) {
        byPair.set(key, {
          studentId: row.student_id, roomId: row.room_id, letter: roomLetter(row.room_id),
          name: row.name, parentPhone: row.parent_phone,
          streak: 0, streakOpen: true, recentAbsences: 0, lastAbsentDate: null,
        });
      }
      const acc = byPair.get(key);
      const date = isoDate(row.class_date);
      if (row.status === 'absent') {
        if (acc.streakOpen) { acc.streak += 1; if (!acc.lastAbsentDate) acc.lastAbsentDate = date; }
        if (date >= cutoff) acc.recentAbsences += 1;
      } else {
        acc.streakOpen = false; // 출석·지각이 나오면 연속 카운트를 멈춘다
      }
    }

    const items = Array.from(byPair.values())
      .filter((a) => a.streak >= ALERT_STREAK || a.recentAbsences >= ALERT_MONTHLY)
      .map(({ streakOpen, ...rest }) => rest)
      .sort((a, b) => (b.streak - a.streak) || (b.recentAbsences - a.recentAbsences));

    res.json({ ok: true, items, thresholds: { streak: ALERT_STREAK, monthly: ALERT_MONTHLY } });
  }));

  // 월별 출석부 내보내기 ---------------------------------------------------
  // 엑셀에서 한글이 깨지지 않도록 UTF-8 BOM을 붙인 CSV로 내려준다.
  // 행=학생, 열=그 달의 날짜, 칸=○(출석) △(지각) ✕(결석) -(수업 없음).
  router.get('/export', ah(async (req, res) => {
    const month = String(req.query.month || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ ok: false, error: 'bad-month' });
    const roomId = req.query.roomId ? String(req.query.roomId) : '';
    if (roomId && !ROOM_IDS.includes(roomId)) return res.status(400).json({ ok: false, error: 'bad-room' });

    const from = `${month}-01`;
    const [y, m] = month.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const to = `${month}-${String(lastDay).padStart(2, '0')}`;

    const params = [from, to];
    let roomClause = '';
    if (roomId) { params.push(roomId); roomClause = ` AND a.room_id=$${params.length}`; }

    const rows = await db.query(
      `SELECT a.student_id, a.room_id, a.class_date, a.status, s.name, s.city, s.enroll_status
         FROM attendance a JOIN students s ON s.id = a.student_id
        WHERE a.student_id IS NOT NULL AND a.class_date BETWEEN $1 AND $2${roomClause}
        ORDER BY s.name, a.room_id, a.class_date`,
      params
    );

    const MARK = { present: '○', late: '△', absent: '✕' };
    const dates = [];
    for (let d = 1; d <= lastDay; d += 1) dates.push(`${month}-${String(d).padStart(2, '0')}`);

    const byPair = new Map();
    for (const row of rows.rows) {
      const key = `${row.student_id}|${row.room_id}`;
      if (!byPair.has(key)) {
        byPair.set(key, {
          name: row.name, city: row.city || '', letter: roomLetter(row.room_id),
          status: row.enroll_status, cells: {}, present: 0, late: 0, absent: 0,
        });
      }
      const acc = byPair.get(key);
      const date = isoDate(row.class_date);
      acc.cells[date] = MARK[row.status] || '';
      if (row.status === 'present') acc.present += 1;
      else if (row.status === 'late') acc.late += 1;
      else if (row.status === 'absent') acc.absent += 1;
    }

    const STATUS_KO = { active: '재원', paused: '휴원', withdrawn: '퇴원' };
    const esc = (v) => {
      const t = String(v == null ? '' : v);
      return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const lines = [];
    lines.push([`${month} 출석부${roomId ? ' · ' + roomId : ''}`].map(esc).join(','));
    lines.push(['○ 출석', '△ 지각', '✕ 결석', '- 수업 없음'].map(esc).join(','));
    lines.push([]);
    lines.push(['이름', '반', '지역', '상태', ...dates.map((d) => d.slice(8)), '출석', '지각', '결석', '출석률'].map(esc).join(','));
    for (const a of byPair.values()) {
      const held = a.present + a.late + a.absent;
      const rate = held ? Math.round(((a.present + a.late) / held) * 100) + '%' : '-';
      lines.push([
        a.name, a.letter, a.city, STATUS_KO[a.status] || a.status,
        ...dates.map((d) => a.cells[d] || '-'),
        a.present, a.late, a.absent, rate,
      ].map(esc).join(','));
    }

    const csv = '\uFEFF' + lines.join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename="attendance-${month}${roomId ? '-' + roomId : ''}.csv"`);
    res.send(csv);
  }));

  // Stats ----------------------------------------------------------------
  router.get('/stats', ah(async (req, res) => {
    const { roomId, from, to } = req.query;
    const clauses = [];
    const params = [];
    if (roomId) {
      params.push(roomId);
      clauses.push(`EXISTS (SELECT 1 FROM student_classes sc WHERE sc.student_id=s.id AND sc.room_id=$${params.length})`);
    }
    if (from) { params.push(from); clauses.push(`a.class_date>=$${params.length}`); }
    if (to) { params.push(to); clauses.push(`a.class_date<=$${params.length}`); }
    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
    const r = await db.query(
      `SELECT s.id, s.name, s.city, s.enrolled_at, s.enroll_status,
              (SELECT string_agg(sc.room_id, ',' ORDER BY sc.room_id)
                 FROM student_classes sc WHERE sc.student_id = s.id) AS room_ids,
              COUNT(a.id) FILTER (WHERE a.status='present') AS present_count,
              COUNT(a.id) FILTER (WHERE a.status='late') AS late_count,
              COUNT(a.id) FILTER (WHERE a.status='absent') AS absent_count,
              COUNT(a.id) AS total_count
       FROM students s
       LEFT JOIN attendance a ON a.student_id = s.id
       ${where}
       GROUP BY s.id
       ORDER BY s.name`,
      params
    );
    // COUNT(*)를 쓰면 출석 기록이 하나도 없는 학생도 총 1회로 잡혀 출석률이
    // 0%로 보이던 문제가 있어, 출석 행이 실제로 있는 것만 센다.
    const stats = r.rows.map((row) => ({
      ...row,
      letters: String(row.room_ids || '').split(',').filter(Boolean).map(roomLetter),
    }));
    res.json({ ok: true, stats });
  }));

  // Absence / notification queue -----------------------------------------
  router.get('/absences', ah(async (req, res) => {
    const r = await db.query(
      `SELECT n.id AS log_id, n.status, n.message, n.created_at, n.sent_by,
              a.class_date, a.room_id, s.id AS student_id, s.name, s.parent_phone
       FROM notification_log n
       JOIN attendance a ON a.id = n.attendance_id
       JOIN students s ON s.id = n.student_id
       ORDER BY n.created_at DESC LIMIT 200`
    );
    res.json({ ok: true, items: r.rows, kakaoConfigured: isKakaoConfigured() });
  }));

  router.post('/notify', ah(async (req, res) => {
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
  }));

  // Auto-send toggle, per room ---------------------------------------------
  router.get('/settings', ah(async (req, res) => {
    const r = await db.query('SELECT room_id, auto_send FROM notification_settings');
    res.json({ ok: true, settings: r.rows, kakaoConfigured: isKakaoConfigured() });
  }));

  router.post('/settings/:roomId', ah(async (req, res) => {
    const autoSend = !!(req.body && req.body.autoSend);
    await db.query(
      `INSERT INTO notification_settings (room_id, auto_send) VALUES ($1,$2)
       ON CONFLICT (room_id) DO UPDATE SET auto_send=$2`,
      [req.params.roomId, autoSend]
    );
    res.json({ ok: true, kakaoConfigured: isKakaoConfigured() });
  }));

  return router;
}

// 폰 자동화 앱(MacroDroid 등)이 문자 수신 시 호출하는 웹훅. 관리자 로그인
// 토큰(8시간 만료)과는 별개로, SMS_INTAKE_SECRET 환경변수 하나로만 인증한다.
// 이 값이 설정돼 있지 않으면 항상 503을 반환해 실수로 열려있지 않게 한다.
function buildWebhookRouter() {
  const router = express.Router();
  router.post('/', ah(async (req, res) => {
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
        `INSERT INTO sms_intake (name, student_phone, parent_phone, city, tag, memo, date_hints, raw_text)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [b.name, b.studentPhone, b.parentPhone, b.city, b.tag, b.memo,
         (b.dateHints || []).join(','), rawText]
      );
    }
    res.json({ ok: true, count: blocks.length });
  }));
  return router;
}

module.exports = {
  recordJoin, recordLeave, startScheduler, buildRouter, buildWebhookRouter, isKakaoConfigured,
  // 파서는 단위 테스트용으로도 노출한다(순수 함수라 DB 없이 검증 가능).
  parseSmsBlocks, parseTeamsNames, extractCity, extractDateHints, normPhone, isLate, isoDate, ROOM_LETTER,
};
