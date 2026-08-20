/**
 * ice-servers.js
 * Cloudflare Realtime TURN 단기 자격증명 발급 라우터
 *
 * 사용법 (server.js):
 *   const iceServersRouter = require('./ice-servers');
 *   app.use(iceServersRouter);
 *
 * 필요 환경변수 (Render > Environment):
 *   TURN_KEY_ID
 *   TURN_KEY_API_TOKEN
 *   TURN_TTL_SECONDS  (선택, 기본 14400 = 4시간)
 */

const express = require('express');
const router = express.Router();

const TURN_KEY_ID = process.env.TURN_KEY_ID;
const TURN_KEY_API_TOKEN = process.env.TURN_KEY_API_TOKEN;
const TTL_SECONDS = Number(process.env.TURN_TTL_SECONDS || 14400);

// 만료 10분 전에 미리 갱신 (수업 도중 끊기는 것 방지)
const REFRESH_MARGIN_MS = 10 * 60 * 1000;

// TURN 발급이 실패해도 STUN만으로 대부분의 연결은 성립하므로 폴백을 둔다
const STUN_ONLY = [
  { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }
];

// identifier 별 캐시 { servers, expiresAt }
const cache = new Map();
// 동시 요청이 몰릴 때 중복 API 호출 방지
const inflight = new Map();

function isConfigured() {
  return Boolean(TURN_KEY_ID && TURN_KEY_API_TOKEN);
}

/**
 * 로그/분석용 태그. Cloudflare GraphQL Analytics에서
 * customIdentifier 별 사용량을 조회할 수 있다.
 * 외부 입력이므로 길이와 문자셋을 제한한다.
 */
function sanitizeIdentifier(raw) {
  if (typeof raw !== 'string') return 'default';
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  return cleaned || 'default';
}

async function requestCredentials(identifier) {
  const url =
    `https://rtc.live.cloudflare.com/v1/turn/keys/${TURN_KEY_ID}` +
    `/credentials/generate-ice-servers`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TURN_KEY_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        ttl: TTL_SECONDS,
        customIdentifier: identifier
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Cloudflare TURN ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = await res.json();
    if (!Array.isArray(data.iceServers) || data.iceServers.length === 0) {
      throw new Error('Cloudflare 응답에 iceServers가 없음');
    }
    return data.iceServers;
  } finally {
    clearTimeout(timeout);
  }
}

async function getIceServers(identifier) {
  const cached = cache.get(identifier);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.servers;
  }

  if (inflight.has(identifier)) {
    return inflight.get(identifier);
  }

  const promise = requestCredentials(identifier)
    .then((servers) => {
      cache.set(identifier, {
        servers,
        expiresAt: Date.now() + TTL_SECONDS * 1000 - REFRESH_MARGIN_MS
      });
      return servers;
    })
    .finally(() => {
      inflight.delete(identifier);
    });

  inflight.set(identifier, promise);
  return promise;
}

router.get('/api/ice-servers', async (req, res) => {
  // 브라우저가 오래된 자격증명을 재사용하지 않도록
  res.set('Cache-Control', 'no-store');

  if (!isConfigured()) {
    console.warn('[ICE] TURN_KEY_ID / TURN_KEY_API_TOKEN 미설정 — STUN 폴백');
    return res.json({ iceServers: STUN_ONLY, ttl: 0, source: 'stun-only' });
  }

  const identifier = sanitizeIdentifier(req.query.room);

  try {
    const iceServers = await getIceServers(identifier);
    res.json({ iceServers, ttl: TTL_SECONDS, source: 'cloudflare' });
  } catch (err) {
    console.error('[ICE] 발급 실패:', err.message);
    res.json({ iceServers: STUN_ONLY, ttl: 0, source: 'stun-only' });
  }
});

module.exports = router;
