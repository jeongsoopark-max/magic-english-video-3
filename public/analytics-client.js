/*
 * 방문 통계 수집 스크립트.
 * <script src="/analytics-client.js" defer></script> 한 줄이면 됩니다.
 *
 * - visitor_id : localStorage (같은 사람이 다시 왔는지 판별)
 * - session_key: sessionStorage (탭 단위 1회 방문)
 * - 체류 시간  : 20초 heartbeat. 탭이 백그라운드면 멈추므로
 *                "실제로 화면을 보고 있던 시간" 에 가깝습니다.
 *                beforeunload 는 iOS Safari 에서 자주 누락돼 쓰지 않습니다.
 */
(function () {
  'use strict';

  var ENDPOINT = '/api/track/ping';
  var INTERVAL = 20000;

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function stored(store, key) {
    try {
      var v = store.getItem(key);
      if (!v) { v = uid(); store.setItem(key, v); }
      return v;
    } catch (e) {
      return uid(); // 프라이빗 모드 등
    }
  }

  var visitorId = stored(window.localStorage, 'me_vid');
  var sessionKey = stored(window.sessionStorage, 'me_sk');
  var referrer = document.referrer || '';
  var timer = null;

  function send() {
    var payload = JSON.stringify({
      sk: sessionKey,
      vid: visitorId,
      path: location.pathname,
      ref: referrer,
      label: window.ME_USER_LABEL || null, // 로그인했다면 이름을 넣어주세요
    });

    if (navigator.sendBeacon) {
      navigator.sendBeacon(ENDPOINT, new Blob([payload], { type: 'text/plain' }));
    } else {
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true,
      }).catch(function () {});
    }
  }

  function start() {
    if (timer) return;
    send();
    timer = setInterval(send, INTERVAL);
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
    send(); // 마지막 시각 기록
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') start();
    else stop();
  });

  window.addEventListener('pagehide', stop);

  if (document.visibilityState === 'visible') start();
})();
