/* inapp-guard.js — 인앱브라우저 탈출 가드
 *
 * 카카오톡·인스타그램·페이스북 등의 인앱브라우저는 getUserMedia / WebRTC가
 * 막혀 있거나 불안정합니다. 학생이 카톡으로 받은 수업 링크를 그대로 누르면
 * 화상 수업이 열리지 않으므로, 여기서 감지해 외부 브라우저로 넘깁니다.
 *
 * index.html / class.html 의 <head> 최상단에서 가장 먼저 로드됩니다.
 * 어떤 경우에도 예외를 던지지 않도록 전체를 try/catch로 감쌉니다.
 */
(function () {
  'use strict';

  try {
    var ua = navigator.userAgent || '';
    var href = location.href;

    // 이미 한 번 탈출을 시도한 뒤 되돌아온 경우 무한 반복을 막는다.
    var GUARD_KEY = 'me_inapp_escaped';
    var alreadyTried = false;
    try { alreadyTried = sessionStorage.getItem(GUARD_KEY) === '1'; } catch (e) {}

    var isKakao     = /KAKAOTALK/i.test(ua);
    var isLine      = /Line\//i.test(ua);
    var isNaver     = /NAVER\(inapp/i.test(ua);
    var isInstagram = /Instagram/i.test(ua);
    var isFacebook  = /FBAN|FBAV/i.test(ua);
    var isDaum      = /DaumApps|Daum\//i.test(ua);
    var isEveryone  = /everytimeApp/i.test(ua);

    var isInApp = isKakao || isLine || isNaver || isInstagram ||
                  isFacebook || isDaum || isEveryone;
    if (!isInApp) return;

    var isAndroid = /Android/i.test(ua);

    // --- 1) 카카오톡: 공식 스킴으로 외부 브라우저를 연다 (안드로이드/iOS 공통) ---
    if (isKakao && !alreadyTried) {
      try { sessionStorage.setItem(GUARD_KEY, '1'); } catch (e) {}
      location.href = 'kakaotalk://web/openExternal?url=' + encodeURIComponent(href);
      return;
    }

    // --- 2) 라인: 쿼리 파라미터로 외부 브라우저를 강제한다 ---
    if (isLine && !alreadyTried) {
      try { sessionStorage.setItem(GUARD_KEY, '1'); } catch (e) {}
      location.href = href + (href.indexOf('?') >= 0 ? '&' : '?') + 'openExternalBrowser=1';
      return;
    }

    // --- 3) 그 외 안드로이드 인앱: intent 스킴으로 크롬에 넘긴다 ---
    if (isAndroid && !alreadyTried) {
      try { sessionStorage.setItem(GUARD_KEY, '1'); } catch (e) {}
      var stripped = href.replace(/^https?:\/\//, '');
      location.href = 'intent://' + stripped +
        '#Intent;scheme=https;package=com.android.chrome;end';
      return;
    }

    // --- 4) iOS의 인스타/페북 등: 자동 탈출 수단이 없으므로 안내 배너를 띄운다 ---
    showManualBanner();

    function showManualBanner() {
      var render = function () {
        if (document.getElementById('inapp-guard-banner')) return;

        var bar = document.createElement('div');
        bar.id = 'inapp-guard-banner';
        bar.setAttribute('role', 'alert');
        bar.style.cssText = [
          'position:fixed', 'left:0', 'right:0', 'bottom:0', 'z-index:2147483647',
          'background:#0f172a', 'color:#f8fafc', 'padding:16px 18px',
          'font-family:"Noto Sans KR",system-ui,-apple-system,sans-serif',
          'font-size:14px', 'line-height:1.6',
          'box-shadow:0 -4px 20px rgba(0,0,0,.28)'
        ].join(';');

        var msg = document.createElement('div');
        msg.style.cssText = 'margin-bottom:10px';
        msg.innerHTML =
          '<strong style="color:#34d399">화상 수업은 이 화면에서 열리지 않습니다.</strong><br>' +
          '우측 하단 <b>···</b> 메뉴에서 <b>Safari로 열기</b>를 눌러 주세요.';

        var row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:8px';

        var copy = document.createElement('button');
        copy.type = 'button';
        copy.textContent = '주소 복사';
        copy.style.cssText =
          'flex:1;padding:10px;border:0;border-radius:8px;background:#10b981;' +
          'color:#fff;font-weight:700;font-size:14px;cursor:pointer';
        copy.onclick = function () {
          var done = function () { copy.textContent = '복사됨 · Safari에 붙여넣기'; };
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(href).then(done, fallbackCopy);
          } else {
            fallbackCopy();
          }
          function fallbackCopy() {
            var ta = document.createElement('textarea');
            ta.value = href;
            ta.style.cssText = 'position:fixed;opacity:0';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); done(); } catch (e) {}
            document.body.removeChild(ta);
          }
        };

        var close = document.createElement('button');
        close.type = 'button';
        close.textContent = '닫기';
        close.setAttribute('aria-label', '안내 닫기');
        close.style.cssText =
          'padding:10px 16px;border:1px solid #475569;border-radius:8px;' +
          'background:transparent;color:#cbd5e1;font-size:14px;cursor:pointer';
        close.onclick = function () { bar.remove(); };

        row.appendChild(copy);
        row.appendChild(close);
        bar.appendChild(msg);
        bar.appendChild(row);
        document.body.appendChild(bar);
      };

      if (document.body) render();
      else document.addEventListener('DOMContentLoaded', render);
    }
  } catch (e) {
    // 가드가 페이지 로딩을 막는 일은 절대 없어야 한다.
    if (window.console && console.warn) console.warn('[inapp-guard]', e);
  }
})();
