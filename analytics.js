// analytics.js — 홈페이지 방문 통계 + 수업방 접속 통계.
//
// 두 가지를 한 화면에서 본다.
//   1) 홈페이지 방문: 이 파일이 새로 만드는 page_sessions 테이블.
//      방문자 브라우저가 20초마다 /api/track/ping 을 보내고, 마지막으로
//      받은 시각을 세션 종료로 본다.
//   2) 수업방 접속: 이미 있는 attendance 테이블의 join_time / leave_time.
//      attendance.recordJoin/recordLeave 가 이미 쌓고 있으므로 별도 테이블을
//      만들지 않는다. 같은 사실을 두 곳에 적으면 언젠가 서로 어긋나고,
//      그때 어느 쪽이 맞는지 알 수 없게 된다.
//
// 시간대: Render 는 UTC 로 돈다. TIMESTAMPTZ 컬럼에서 요일·시각을 뽑을 때는
// 반드시 AT TIME ZONE 'Asia/Seoul' 을 거친다. class_date 는 attendance.js 가
// 이미 KST 기준으로 넣고 있으므로 그대로 쓴다.
//
// 타입: pg 는 COUNT(*)(bigint) 와 EXTRACT(numeric) 을 문자열로, DATE 를 Date
// 객체로 돌려준다. isoDate() 를 곳곳에 두는 대신 SQL 안에서 ::int 와
// to_char() 로 확정해 프런트에는 항상 숫자/문자열만 간다.

const express = require('express');
const db = require('./db');

const TZ = 'Asia/Seoul';
const HEARTBEAT_SEC = 20; // analytics-client.js 의 주기와 맞춰야 한다

const BOT_RE = /bot|crawler|spider|crawling|slurp|bingpreview|facebookexternalhit|headless|lighthouse|pingdom|uptime|curl|wget|python-requests|axios|postman/i;

function classifyDevice(ua = '') {
  if (/iPad|Tablet|Android(?!.*Mobile)/i.test(ua)) return 'tablet';
  if (/Mobile|iPhone|Android|iPod/i.test(ua)) return 'mobile';
  return 'desktop';
}

function classifyBrowser(ua = '') {
  if (/Edg\//.test(ua)) return 'Edge';
  if (/Whale/.test(ua)) return 'Whale';
  if (/SamsungBrowser/.test(ua)) return 'Samsung';
  if (/KAKAOTALK/i.test(ua)) return 'KakaoTalk';
  if (/OPR\/|Opera/.test(ua)) return 'Opera';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return '기타';
}

function shortReferrer(ref, host) {
  if (!ref) return null;
  try {
    const u = new URL(ref);
    if (host && u.host === host) return null; // 사이트 안에서의 이동은 유입이 아니다
    return u.host.slice(0, 80);
  } catch (_) {
    return null;
  }
}

// --- 스키마 --------------------------------------------------------------
// 전부 IF NOT EXISTS. attendance 쪽 인덱스는 손대지 않는다.

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS page_sessions (
  id           BIGSERIAL PRIMARY KEY,
  session_key  TEXT        NOT NULL,
  visitor_id   TEXT        NOT NULL,
  user_label   TEXT,
  entry_path   TEXT,
  last_path    TEXT,
  referrer     TEXT,
  device       TEXT,
  browser      TEXT,
  page_views   INTEGER     NOT NULL DEFAULT 1,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS page_sessions_key_uq   ON page_sessions (session_key);
CREATE INDEX IF NOT EXISTS page_sessions_started_idx     ON page_sessions (started_at);
CREATE INDEX IF NOT EXISTS page_sessions_visitor_idx     ON page_sessions (visitor_id, started_at);

-- 수업방 통계가 attendance 를 스캔하므로 시각 기준 인덱스를 하나 더 둔다.
CREATE INDEX IF NOT EXISTS attendance_join_time_idx
  ON attendance (join_time) WHERE join_time IS NOT NULL;
`;

async function initSchema() {
  if (!db.enabled) return false;
  await db.pool.query(SCHEMA_SQL);
  console.log('[analytics] schema ready');
  return true;
}

// --- 수집 라우터 (인증 없음) ---------------------------------------------
// 방문자 브라우저가 직접 부르는 통로라 열려 있어야 한다. 쓰기만 하고
// 아무것도 돌려주지 않으며(204), 실패해도 조용히 넘어간다.

function buildTrackRouter() {
  const router = express.Router();

  // server.js 에 이미 express.json({limit:'64kb'}) 이 걸려 있어 JSON 은 그쪽에서
  // 파싱된다(body-parser 는 req._body 를 보고 두 번 파싱하지 않는다). 다만
  // sendBeacon 은 본문을 text/plain 으로 보내므로 그건 여기서 따로 받는다.
  router.use(express.json({ limit: '8kb' }));
  router.use(express.text({ type: 'text/plain', limit: '8kb' }));

  router.post('/ping', (req, res) => {
    res.status(204).end(); // 응답을 먼저 끊고 기록은 뒤에서 한다

    if (!db.enabled) return;

    const ua = req.headers['user-agent'] || '';
    if (BOT_RE.test(ua)) return;

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = null; } }
    if (!body || typeof body !== 'object') return;

    const sessionKey = String(body.sk || '').slice(0, 80);
    const visitorId = String(body.vid || '').slice(0, 80);
    if (!sessionKey || !visitorId) return;

    const path = String(body.path || '/').slice(0, 300);
    const label = body.label ? String(body.label).slice(0, 80) : null;

    db.pool.query(
      `INSERT INTO page_sessions
         (session_key, visitor_id, user_label, entry_path, last_path, referrer, device, browser)
       VALUES ($1,$2,$3,$4,$4,$5,$6,$7)
       ON CONFLICT (session_key) DO UPDATE SET
         last_seen_at = now(),
         page_views   = page_sessions.page_views
                        + CASE WHEN EXCLUDED.last_path IS DISTINCT FROM page_sessions.last_path
                               THEN 1 ELSE 0 END,
         last_path    = EXCLUDED.last_path,
         user_label   = COALESCE(EXCLUDED.user_label, page_sessions.user_label)`,
      [sessionKey, visitorId, label, path,
       shortReferrer(body.ref, req.headers.host), classifyDevice(ua), classifyBrowser(ua)]
    ).catch((e) => console.error('[analytics] ping 저장 실패:', e.message));
  });

  return router;
}

// --- 조회 라우터 (관리자 토큰) -------------------------------------------
// attendance.buildRouter 와 같은 방식으로 인증한다.

function buildStatsRouter({ verifyToken, bearer }) {
  const router = express.Router();

  router.use((req, res, next) => {
    if (!db.enabled) return res.status(503).json({ ok: false, error: 'db-not-configured' });
    if (!verifyToken(bearer(req), 'admin')) return res.status(401).json({ ok: false, error: 'unauthorized' });
    next();
  });

  // attendance.js 의 ah() 와 같은 이유. 여기서 프라미스가 새어나가면 Node 가
  // 프로세스를 죽이고, 그 순간 수업 중이던 사람들의 화상 연결이 전부 끊긴다.
  const ah = (fn) => (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      console.error('[analytics] route error:', err && err.message);
      if (!res.headersSent) res.status(500).json({ ok: false, error: 'server-error' });
    });
  };

  const days = (req) => {
    const n = parseInt(req.query.days, 10);
    return Number.isFinite(n) && n > 0 && n <= 400 ? n : 30;
  };

  // 수업방 기록에서 "실제로 들어왔던" 행만 고른다. 결석 행과 팀즈로 가져온
  // 행은 join_time 이 비어 있으므로 자연히 빠진다.
  const JOINED = `a.join_time IS NOT NULL
                  AND a.class_date >= (now() AT TIME ZONE '${TZ}')::date - ($1::int - 1)`;
  // 아직 나가지 않았거나 시각이 뒤집힌 행은 시간 계산에서 뺀다.
  const CLOSED = `${JOINED} AND a.leave_time IS NOT NULL AND a.leave_time > a.join_time`;
  const SECS = `EXTRACT(EPOCH FROM (a.leave_time - a.join_time))`;

  // 요약 -----------------------------------------------------------------
  router.get('/summary', ah(async (req, res) => {
    const d = days(req);

    const web = await db.pool.query(
      `SELECT COUNT(*)::int                   AS sessions,
              COUNT(DISTINCT visitor_id)::int AS visitors,
              COALESCE(SUM(page_views), 0)::int AS page_views,
              COALESCE(AVG(EXTRACT(EPOCH FROM (last_seen_at - started_at))), 0)::int AS avg_sec
         FROM page_sessions
        WHERE started_at > now() - ($1 || ' days')::interval`,
      [d]
    );

    const repeat = await db.pool.query(
      `SELECT COUNT(*)::int AS repeat_visitors FROM (
         SELECT visitor_id FROM page_sessions
          WHERE started_at > now() - ($1 || ' days')::interval
          GROUP BY visitor_id HAVING COUNT(*) > 1) t`,
      [d]
    );

    const room = await db.pool.query(
      `SELECT COUNT(*)::int AS sessions,
              COUNT(DISTINCT COALESCE(a.matched_name, a.id::text))::int AS people,
              COUNT(DISTINCT a.room_id)::int AS rooms,
              COALESCE(SUM(CASE WHEN a.leave_time > a.join_time THEN ${SECS} END), 0)::int AS total_sec,
              COALESCE(AVG(CASE WHEN a.leave_time > a.join_time THEN ${SECS} END), 0)::int AS avg_sec
         FROM attendance a
        WHERE ${JOINED}`,
      [d]
    );

    res.json({ ok: true, days: d, web: { ...web.rows[0], ...repeat.rows[0] }, room: room.rows[0] });
  }));

  // 요일 × 시간대 --------------------------------------------------------
  router.get('/heatmap', ah(async (req, res) => {
    const d = days(req);
    const isRoom = req.query.source === 'room';

    const sql = isRoom
      ? `SELECT EXTRACT(DOW  FROM a.join_time AT TIME ZONE '${TZ}')::int AS dow,
                EXTRACT(HOUR FROM a.join_time AT TIME ZONE '${TZ}')::int AS hour,
                COUNT(*)::int AS value
           FROM attendance a
          WHERE ${JOINED}
          GROUP BY 1, 2`
      : `SELECT EXTRACT(DOW  FROM started_at AT TIME ZONE '${TZ}')::int AS dow,
                EXTRACT(HOUR FROM started_at AT TIME ZONE '${TZ}')::int AS hour,
                COUNT(DISTINCT visitor_id)::int AS value
           FROM page_sessions
          WHERE started_at > now() - ($1 || ' days')::interval
          GROUP BY 1, 2`;

    const r = await db.pool.query(sql, [d]);
    res.json({ ok: true, source: isRoom ? 'room' : 'web', cells: r.rows });
  }));

  // 일별 추이 ------------------------------------------------------------
  router.get('/daily', ah(async (req, res) => {
    const d = days(req);
    const r = await db.pool.query(
      `WITH span AS (
         SELECT to_char(g, 'YYYY-MM-DD') AS day
           FROM generate_series((now() AT TIME ZONE '${TZ}')::date - ($1::int - 1),
                                (now() AT TIME ZONE '${TZ}')::date,
                                interval '1 day') g),
       w AS (
         SELECT to_char(started_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS day,
                COUNT(DISTINCT visitor_id)::int AS visitors
           FROM page_sessions
          WHERE started_at > now() - ($1 || ' days')::interval
          GROUP BY 1),
       r AS (
         SELECT to_char(a.class_date, 'YYYY-MM-DD') AS day,
                COUNT(*)::int AS joins,
                COALESCE(SUM(CASE WHEN a.leave_time > a.join_time THEN ${SECS} END), 0)::int AS total_sec
           FROM attendance a
          WHERE ${JOINED}
          GROUP BY 1)
       SELECT span.day,
              COALESCE(w.visitors, 0)  AS visitors,
              COALESCE(r.joins, 0)     AS joins,
              COALESCE(r.total_sec, 0) AS total_sec
         FROM span
         LEFT JOIN w ON w.day = span.day
         LEFT JOIN r ON r.day = span.day
        ORDER BY span.day`,
      [d]
    );
    res.json({ ok: true, rows: r.rows });
  }));

  // 홈페이지 체류 시간 분포 ----------------------------------------------
  router.get('/duration', ah(async (req, res) => {
    const d = days(req);
    const r = await db.pool.query(
      `SELECT bucket, ord, COUNT(*)::int AS value FROM (
         SELECT CASE WHEN s < ${HEARTBEAT_SEC} THEN '한 번만 열어봄'
                     WHEN s < 60   THEN '1분 미만'
                     WHEN s < 180  THEN '1~3분'
                     WHEN s < 600  THEN '3~10분'
                     WHEN s < 1800 THEN '10~30분'
                     ELSE               '30분 이상' END AS bucket,
                CASE WHEN s < ${HEARTBEAT_SEC} THEN 1 WHEN s < 60 THEN 2 WHEN s < 180 THEN 3
                     WHEN s < 600 THEN 4 WHEN s < 1800 THEN 5 ELSE 6 END AS ord
           FROM (SELECT EXTRACT(EPOCH FROM (last_seen_at - started_at))::int AS s
                   FROM page_sessions
                  WHERE started_at > now() - ($1 || ' days')::interval) x) y
       GROUP BY bucket, ord ORDER BY ord`,
      [d]
    );
    res.json({ ok: true, rows: r.rows });
  }));

  // 페이지 · 기기 · 유입 · 반 --------------------------------------------
  router.get('/breakdown', ah(async (req, res) => {
    const d = days(req);

    const pages = await db.pool.query(
      `SELECT COALESCE(last_path, '/') AS label, COUNT(*)::int AS value
         FROM page_sessions WHERE started_at > now() - ($1 || ' days')::interval
        GROUP BY 1 ORDER BY value DESC LIMIT 8`, [d]);

    const devices = await db.pool.query(
      `SELECT COALESCE(device, '기타') AS label, COUNT(*)::int AS value
         FROM page_sessions WHERE started_at > now() - ($1 || ' days')::interval
        GROUP BY 1 ORDER BY value DESC`, [d]);

    const referrers = await db.pool.query(
      `SELECT COALESCE(referrer, '직접 방문') AS label, COUNT(*)::int AS value
         FROM page_sessions WHERE started_at > now() - ($1 || ' days')::interval
        GROUP BY 1 ORDER BY value DESC LIMIT 8`, [d]);

    const rooms = await db.pool.query(
      `SELECT a.room_id AS label, COUNT(*)::int AS value,
              COALESCE(SUM(CASE WHEN a.leave_time > a.join_time THEN ${SECS} END), 0)::int AS total_sec
         FROM attendance a WHERE ${JOINED}
        GROUP BY 1 ORDER BY value DESC`, [d]);

    res.json({ ok: true, pages: pages.rows, devices: devices.rows,
               referrers: referrers.rows, rooms: rooms.rows });
  }));

  // 수업방 참여자별 ------------------------------------------------------
  router.get('/participants', ah(async (req, res) => {
    const d = days(req);
    const r = await db.pool.query(
      `SELECT COALESCE(s.name, a.matched_name, '(이름 없음)') AS name,
              (s.id IS NULL) AS unmatched,
              COUNT(*)::int AS sessions,
              COALESCE(SUM(${SECS}), 0)::int AS total_sec,
              COALESCE(AVG(${SECS}), 0)::int AS avg_sec,
              string_agg(DISTINCT a.room_id, ',') AS rooms,
              to_char(MAX(a.join_time) AT TIME ZONE '${TZ}', 'MM-DD HH24:MI') AS last_join
         FROM attendance a
         LEFT JOIN students s ON s.id = a.student_id
        WHERE ${CLOSED}
        GROUP BY 1, 2
        ORDER BY total_sec DESC
        LIMIT 60`,
      [d]
    );
    res.json({ ok: true, rows: r.rows });
  }));

  return router;
}

module.exports = { initSchema, buildTrackRouter, buildStatsRouter, classifyDevice, classifyBrowser };
