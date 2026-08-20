/**
 * public/js/ice-client.js
 * ICE 서버 목록을 서버에서 받아와 캐시하고, 만료 전에 갱신한다.
 *
 * HTML에서:
 *   <script src="/js/ice-client.js"></script>
 *
 * 사용:
 *   const pc = new RTCPeerConnection({
 *     iceServers: await IceClient.get(roomId),
 *     iceCandidatePoolSize: 10
 *   });
 *   IceClient.track(pc, roomId);   // 장시간 통화 시 자격증명 자동 갱신
 */
(function (global) {
  'use strict';

  var FALLBACK = [
    { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }
  ];

  var cache = null;        // { iceServers, expiresAt }
  var inflight = null;
  var tracked = [];        // 갱신 대상 RTCPeerConnection 목록

  function fetchIceServers(roomId) {
    var url = '/api/ice-servers';
    if (roomId) url += '?room=' + encodeURIComponent(roomId);

    return fetch(url, { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (!data || !Array.isArray(data.iceServers)) {
          throw new Error('잘못된 응답 형식');
        }
        var ttlMs = (data.ttl || 0) * 1000;
        cache = {
          iceServers: data.iceServers,
          // 만료 10분 전을 유효기한으로 본다. ttl이 0이면 폴백이므로 캐시하지 않는다.
          expiresAt: ttlMs > 0 ? Date.now() + ttlMs - 10 * 60 * 1000 : 0
        };
        if (data.source === 'stun-only') {
          console.warn('[ICE] TURN 사용 불가 — STUN만으로 동작합니다. ' +
                       '제한적인 네트워크의 참가자는 연결에 실패할 수 있습니다.');
        }
        return cache.iceServers;
      });
  }

  /**
   * ICE 서버 목록을 반환한다. 실패해도 예외를 던지지 않고 STUN 폴백을 준다.
   */
  function get(roomId) {
    if (cache && cache.expiresAt > Date.now()) {
      return Promise.resolve(cache.iceServers);
    }
    if (inflight) return inflight;

    inflight = fetchIceServers(roomId)
      .catch(function (err) {
        console.error('[ICE] 목록을 가져오지 못했습니다:', err.message);
        return FALLBACK;
      })
      .then(function (servers) {
        inflight = null;
        return servers;
      });

    return inflight;
  }

  /**
   * 통화가 TTL보다 길어질 경우를 대비해 자격증명을 교체한다.
   * setConfiguration은 진행 중인 연결을 끊지 않는다.
   */
  function track(pc, roomId) {
    if (!pc || tracked.indexOf(pc) !== -1) return;
    tracked.push(pc);

    pc.addEventListener('connectionstatechange', function () {
      if (pc.connectionState === 'closed' || pc.connectionState === 'failed') {
        var i = tracked.indexOf(pc);
        if (i !== -1) tracked.splice(i, 1);
      }
    });
  }

  function refreshAll() {
    if (tracked.length === 0) return;
    if (cache && cache.expiresAt > Date.now()) return;

    cache = null;
    get().then(function (servers) {
      tracked.forEach(function (pc) {
        try {
          if (pc.connectionState !== 'closed' && pc.setConfiguration) {
            var conf = pc.getConfiguration();
            conf.iceServers = servers;
            pc.setConfiguration(conf);
          }
        } catch (e) {
          console.warn('[ICE] 자격증명 갱신 실패:', e.message);
        }
      });
      console.log('[ICE] 자격증명을 갱신했습니다 (' + tracked.length + '개 연결)');
    });
  }

  // 5분마다 만료 여부 확인
  setInterval(refreshAll, 5 * 60 * 1000);

  global.IceClient = { get: get, track: track };
})(window);
