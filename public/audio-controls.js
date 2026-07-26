/*
 * audio-controls.js  —  MAGIC ENGLISH 화상 수업용 오디오 진단/설정 모듈
 * ------------------------------------------------------------------
 * 기능
 *  1) 마이크·스피커 장치 목록 조회 및 선택 (설정창)
 *  2) 내 마이크 입력 레벨 실시간 미터 + "소리 감지" 진단
 *  3) 스피커 테스트 음 재생 (선택한 출력 장치로)
 *  4) "내 목소리가 상대방에게 전송 중인지" 진단
 *  5) 상대방 영상 위에 마이크 아이콘 표시 (말하는 중 = 초록/애니메이션)
 *
 * 통합 방법 (client.js에서):
 *   AudioControls.init({
 *     localStream: myStream,                 // getUserMedia로 받은 내 스트림
 *     getPeerConnections: () => Object.values(peers), // RTCPeerConnection 배열 반환
 *     showButton: true,                      // 우하단 톱니바퀴 버튼 표시
 *     onMicChange: (track) => { /* 필요시 후처리 *\/ }
 *   });
 *
 *   // 원격 참가자 트랙이 도착했을 때 (ontrack 콜백 안):
 *   AudioControls.attachRemote(peerId, remoteStream, tileElement);
 *
 *   // 참가자가 나갔을 때:
 *   AudioControls.detachRemote(peerId);
 *
 *   // 설정창 열기 (직접 버튼에 연결하고 싶을 때):
 *   AudioControls.open();
 */
(function (global) {
  'use strict';

  var state = {
    audioCtx: null,
    localStream: null,
    getPeerConnections: null,
    onMicChange: null,
    remoteMonitors: new Map(), // peerId -> monitor
    localMonitor: null,
    selectedMicId: null,
    selectedSpeakerId: null,
    speakingThreshold: 0.045, // 발화 판정 임계값 (0~1 RMS)
    panelEl: null,
    open: false,
    resumedOnce: false
  };

  var SUPPORTS_SINK = ('setSinkId' in HTMLMediaElement.prototype);

  /* ---------------- AudioContext ---------------- */
  function ctx() {
    if (!state.audioCtx) {
      var AC = global.AudioContext || global.webkitAudioContext;
      state.audioCtx = new AC();
    }
    return state.audioCtx;
  }
  function resumeCtx() {
    var c = ctx();
    if (c.state === 'suspended') { c.resume().catch(function () {}); }
  }

  /* ---------------- 레벨 분석기 ---------------- */
  // 스트림에서 RMS 레벨(0~1)을 읽는 분석기 생성
  function makeAnalyser(stream) {
    var c = ctx();
    var source = c.createMediaStreamSource(stream);
    var analyser = c.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);

    // 크롬 원격 스트림 분석 버그 우회: 무음(gain 0)으로 destination에 연결해
    // 오디오 그래프가 데이터를 끌어오도록 함 (실제 소리는 안 남)
    var sink = c.createGain();
    sink.gain.value = 0;
    analyser.connect(sink);
    sink.connect(c.destination);

    var buf = new Uint8Array(analyser.frequencyBinCount);
    function level() {
      analyser.getByteTimeDomainData(buf);
      var sum = 0;
      for (var i = 0; i < buf.length; i++) {
        var v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      return Math.sqrt(sum / buf.length);
    }
    function cleanup() {
      try { source.disconnect(); } catch (e) {}
      try { analyser.disconnect(); } catch (e) {}
      try { sink.disconnect(); } catch (e) {}
    }
    return { level: level, cleanup: cleanup };
  }

  /* ---------------- 장치 목록 ---------------- */
  function listDevices() {
    return navigator.mediaDevices.enumerateDevices().then(function (devs) {
      return {
        mics: devs.filter(function (d) { return d.kind === 'audioinput'; }),
        speakers: devs.filter(function (d) { return d.kind === 'audiooutput'; })
      };
    });
  }

  /* ---------------- 마이크 전환 ---------------- */
  function switchMic(deviceId) {
    return navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    }).then(function (ns) {
      var newTrack = ns.getAudioTracks()[0];

      // 모든 피어 연결의 오디오 sender 교체
      var pcs = state.getPeerConnections ? state.getPeerConnections() : [];
      var jobs = pcs.map(function (pc) {
        var sender = pc.getSenders().find(function (s) {
          return s.track && s.track.kind === 'audio';
        });
        // 오디오 sender가 아직 없으면 추가
        if (!sender) {
          try { pc.addTrack(newTrack, state.localStream); } catch (e) {}
          return Promise.resolve();
        }
        return sender.replaceTrack(newTrack);
      });

      return Promise.all(jobs).then(function () {
        // 로컬 스트림 갱신
        if (state.localStream) {
          var old = state.localStream.getAudioTracks()[0];
          if (old) { state.localStream.removeTrack(old); old.stop(); }
          state.localStream.addTrack(newTrack);
        }
        state.selectedMicId = deviceId;
        // 로컬 미터 재부착
        startLocalMonitor();
        if (state.onMicChange) { try { state.onMicChange(newTrack); } catch (e) {} }
        return newTrack;
      });
    });
  }

  /* ---------------- 스피커 전환 ---------------- */
  function collectMediaElements() {
    // 모든 원격 video/audio 요소에 setSinkId 적용
    var els = [];
    state.remoteMonitors.forEach(function (m) {
      if (m.tileEl) {
        var v = m.tileEl.querySelector('video, audio');
        if (v) els.push(v);
      }
    });
    // 명시적으로 등록된 요소 없더라도 페이지의 모든 미디어에 적용 (보수적)
    Array.prototype.forEach.call(document.querySelectorAll('video, audio'), function (el) {
      if (els.indexOf(el) === -1) els.push(el);
    });
    return els;
  }
  function switchSpeaker(deviceId) {
    if (!SUPPORTS_SINK) {
      return Promise.reject(new Error('이 브라우저는 스피커 선택을 지원하지 않습니다 (iOS/Safari 등).'));
    }
    var els = collectMediaElements();
    return Promise.all(els.map(function (el) {
      return el.setSinkId(deviceId).catch(function () {});
    })).then(function () { state.selectedSpeakerId = deviceId; });
  }

  /* ---------------- 스피커 테스트 음 ---------------- */
  function playTestTone(deviceId) {
    var c = ctx();
    resumeCtx();
    var osc = c.createOscillator();
    var gain = c.createGain();
    var dest = c.createMediaStreamDestination();
    osc.type = 'sine';
    osc.frequency.value = 523.25; // C5
    gain.gain.value = 0.0001;
    osc.connect(gain).connect(dest);

    var audio = new Audio();
    audio.srcObject = dest.stream;

    var start = function () {
      audio.play().catch(function () {});
      osc.start();
      var t = c.currentTime;
      gain.gain.exponentialRampToValueAtTime(0.2, t + 0.05);
      setTimeout(function () {
        var t2 = c.currentTime;
        gain.gain.exponentialRampToValueAtTime(0.0001, t2 + 0.15);
        setTimeout(function () {
          try { osc.stop(); } catch (e) {}
          try { audio.pause(); } catch (e) {}
        }, 200);
      }, 700);
    };

    if (deviceId && audio.setSinkId) {
      audio.setSinkId(deviceId).then(start).catch(start);
    } else {
      start();
    }
  }

  /* ---------------- 전송 진단 ---------------- */
  // 내 오디오가 상대방에게 실제로 전송 중인지 판단
  function diagnoseOutgoing() {
    var result = { permission: false, trackLive: false, sending: false, detail: '' };
    var track = state.localStream ? state.localStream.getAudioTracks()[0] : null;
    if (track) {
      result.permission = true;
      result.trackLive = (track.readyState === 'live' && track.enabled && !track.muted);
    }
    var pcs = state.getPeerConnections ? state.getPeerConnections() : [];
    var anySender = false;
    pcs.forEach(function (pc) {
      var s = pc.getSenders().find(function (x) {
        return x.track && x.track.kind === 'audio' &&
               x.track.readyState === 'live' && x.track.enabled && !x.track.muted;
      });
      if (s) anySender = true;
    });
    result.sending = anySender && result.trackLive;
    if (!result.permission) result.detail = '마이크 권한이 없거나 오디오 트랙이 없습니다.';
    else if (!result.trackLive) result.detail = '마이크 트랙이 음소거/비활성 상태입니다.';
    else if (pcs.length === 0) result.detail = '아직 연결된 상대가 없습니다.';
    else if (!anySender) result.detail = '오디오가 상대방에게 전송되지 않고 있습니다.';
    else result.detail = '정상적으로 전송 중입니다.';
    return result;
  }

  /* ================= 상대방 발화 표시 ================= */
  function ensureBadge(tileEl) {
    if (getComputedStyle(tileEl).position === 'static') {
      tileEl.style.position = 'relative';
    }
    var badge = tileEl.querySelector('.ac-mic-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'ac-mic-badge';
      badge.innerHTML =
        '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">' +
        '<path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3z"/>' +
        '<path d="M19 11a1 1 0 1 0-2 0 5 5 0 0 1-10 0 1 1 0 1 0-2 0 7 7 0 0 0 6 6.92V20H8a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2h-3v-2.08A7 7 0 0 0 19 11z"/>' +
        '</svg>';
      tileEl.appendChild(badge);
    }
    return badge;
  }

  function startRemoteMonitor(peerId, stream, tileEl) {
    resumeCtx();
    var an;
    try { an = makeAnalyser(stream); } catch (e) { return; }
    var badge = ensureBadge(tileEl);
    var track = stream.getAudioTracks()[0];
    var raf;
    var speaking = false;

    function tick() {
      var noAudio = !track || track.readyState !== 'live' || track.muted;
      if (noAudio) {
        badge.className = 'ac-mic-badge ac-muted';
        tileEl.classList.remove('ac-speaking');
      } else {
        var lv = an.level();
        var nowSpeaking = lv > state.speakingThreshold;
        if (nowSpeaking !== speaking) {
          speaking = nowSpeaking;
          tileEl.classList.toggle('ac-speaking', speaking);
          badge.className = 'ac-mic-badge' + (speaking ? ' ac-active' : '');
        }
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);

    state.remoteMonitors.set(peerId, {
      analyser: an, raf: function () { return raf; },
      stop: function () { cancelAnimationFrame(raf); an.cleanup(); },
      tileEl: tileEl, badge: badge
    });
  }

  /* ================= 로컬 미터 ================= */
  function startLocalMonitor() {
    if (state.localMonitor) { state.localMonitor.stop(); state.localMonitor = null; }
    if (!state.localStream || !state.localStream.getAudioTracks()[0]) return;
    resumeCtx();
    var an = makeAnalyser(state.localStream);
    var raf;
    function tick() {
      var lv = an.level();
      updateMeterUI(lv);
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    state.localMonitor = { stop: function () { cancelAnimationFrame(raf); an.cleanup(); } };
  }

  function updateMeterUI(lv) {
    if (!state.panelEl || !state.open) return;
    var fill = state.panelEl.querySelector('.ac-meter-fill');
    var status = state.panelEl.querySelector('.ac-meter-status');
    if (fill) fill.style.width = Math.min(100, lv * 300) + '%';
    if (status) {
      if (lv > state.speakingThreshold) {
        status.textContent = '소리가 감지되고 있습니다 ✓';
        status.className = 'ac-meter-status ac-ok';
      } else {
        status.textContent = '말해 보세요… (소리 감지 대기 중)';
        status.className = 'ac-meter-status';
      }
    }
  }

  /* ================= 설정창 UI ================= */
  function injectStyles() {
    if (document.getElementById('ac-styles')) return;
    var css = document.createElement('style');
    css.id = 'ac-styles';
    css.textContent = [
      '.ac-btn-gear{position:fixed;right:20px;bottom:20px;z-index:9998;width:52px;height:52px;border-radius:50%;',
      'border:none;cursor:pointer;background:#1f2937;color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.35);',
      'display:flex;align-items:center;justify-content:center;transition:transform .15s}',
      '.ac-btn-gear:hover{transform:scale(1.06);background:#374151}',
      '.ac-overlay{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.5);',
      'display:flex;align-items:center;justify-content:center;padding:16px}',
      '.ac-panel{width:100%;max-width:420px;max-height:90vh;overflow:auto;background:#111827;color:#e5e7eb;',
      'border-radius:18px;padding:22px;box-shadow:0 20px 60px rgba(0,0,0,.5);',
      'font-family:"Noto Sans KR",system-ui,sans-serif}',
      '.ac-panel h2{margin:0 0 4px;font-size:18px;font-weight:700;color:#fff}',
      '.ac-panel .ac-sub{font-size:12px;color:#9ca3af;margin-bottom:18px}',
      '.ac-sec{margin-bottom:20px}',
      '.ac-sec label{display:block;font-size:13px;font-weight:600;margin-bottom:8px;color:#d1d5db}',
      '.ac-sel{width:100%;padding:11px 12px;border-radius:10px;background:#1f2937;color:#fff;',
      'border:1px solid #374151;font-size:14px}',
      '.ac-meter{height:12px;background:#1f2937;border-radius:6px;overflow:hidden;margin-top:10px;border:1px solid #374151}',
      '.ac-meter-fill{height:100%;width:0;background:linear-gradient(90deg,#22c55e,#84cc16,#eab308);transition:width .06s}',
      '.ac-meter-status{font-size:12px;margin-top:6px;color:#9ca3af}',
      '.ac-meter-status.ac-ok{color:#22c55e;font-weight:600}',
      '.ac-row{display:flex;gap:8px;align-items:center;margin-top:10px}',
      '.ac-test{padding:10px 14px;border:none;border-radius:10px;background:#2563eb;color:#fff;',
      'font-size:13px;font-weight:600;cursor:pointer}',
      '.ac-test:hover{background:#1d4ed8}',
      '.ac-note{font-size:11px;color:#f59e0b;margin-top:8px}',
      '.ac-diag{background:#0b1220;border:1px solid #1f2937;border-radius:12px;padding:12px 14px;font-size:13px}',
      '.ac-diag-line{display:flex;align-items:center;gap:8px;padding:4px 0}',
      '.ac-dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto;background:#6b7280}',
      '.ac-dot.ok{background:#22c55e}.ac-dot.bad{background:#ef4444}',
      '.ac-diag-detail{font-size:12px;color:#9ca3af;margin-top:8px}',
      '.ac-close{margin-top:8px;width:100%;padding:12px;border:none;border-radius:10px;',
      'background:#374151;color:#fff;font-size:14px;font-weight:600;cursor:pointer}',
      '.ac-close:hover{background:#4b5563}',
      /* 발화 표시 */
      '.ac-mic-badge{position:absolute;right:8px;top:8px;z-index:5;width:26px;height:26px;border-radius:50%;',
      'display:flex;align-items:center;justify-content:center;background:rgba(17,24,39,.75);color:#9ca3af;',
      'backdrop-filter:blur(4px);transition:all .15s;pointer-events:none}',
      '.ac-mic-badge.ac-active{background:#16a34a;color:#fff;box-shadow:0 0 0 0 rgba(34,197,94,.6);animation:ac-pulse 1s infinite}',
      '.ac-mic-badge.ac-muted{background:rgba(127,29,29,.85);color:#fecaca}',
      '.ac-mic-badge.ac-muted::after{content:"";position:absolute;width:2px;height:20px;background:#fecaca;transform:rotate(45deg);border-radius:2px}',
      '.ac-speaking{box-shadow:inset 0 0 0 3px #22c55e, 0 0 12px rgba(34,197,94,.5) !important;transition:box-shadow .12s}',
      '@keyframes ac-pulse{0%{box-shadow:0 0 0 0 rgba(34,197,94,.6)}70%{box-shadow:0 0 0 8px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}'
    ].join('');
    document.head.appendChild(css);
  }

  function buildPanel() {
    var overlay = document.createElement('div');
    overlay.className = 'ac-overlay';
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close();
    });

    var panel = document.createElement('div');
    panel.className = 'ac-panel';
    panel.innerHTML =
      '<h2>오디오 설정 · 진단</h2>' +
      '<div class="ac-sub">마이크·스피커 상태를 확인하고 장치를 선택하세요.</div>' +

      '<div class="ac-sec">' +
        '<label>🎤 마이크 (입력)</label>' +
        '<select class="ac-sel ac-mic-select"></select>' +
        '<div class="ac-meter"><div class="ac-meter-fill"></div></div>' +
        '<div class="ac-meter-status">말해 보세요… (소리 감지 대기 중)</div>' +
      '</div>' +

      '<div class="ac-sec">' +
        '<label>🔊 스피커 (출력)</label>' +
        '<select class="ac-sel ac-spk-select"></select>' +
        '<div class="ac-row"><button class="ac-test ac-test-btn">테스트 소리 재생</button></div>' +
        '<div class="ac-note ac-spk-note" style="display:none">이 브라우저(iOS/Safari 등)는 스피커 선택을 지원하지 않습니다. 기기 자체 볼륨/출력 설정을 확인하세요.</div>' +
      '</div>' +

      '<div class="ac-sec">' +
        '<label>🩺 전송 진단 (내 목소리 → 상대방)</label>' +
        '<div class="ac-diag">' +
          '<div class="ac-diag-line"><span class="ac-dot" data-k="permission"></span><span>마이크 권한 / 트랙</span></div>' +
          '<div class="ac-diag-line"><span class="ac-dot" data-k="trackLive"></span><span>마이크 활성 (음소거 아님)</span></div>' +
          '<div class="ac-diag-line"><span class="ac-dot" data-k="sending"></span><span>상대방에게 전송 중</span></div>' +
          '<div class="ac-diag-detail"></div>' +
        '</div>' +
      '</div>' +

      '<button class="ac-close">닫기</button>';

    overlay.appendChild(panel);
    state.panelEl = overlay;

    panel.querySelector('.ac-close').addEventListener('click', close);
    panel.querySelector('.ac-test-btn').addEventListener('click', function () {
      playTestTone(state.selectedSpeakerId);
    });
    panel.querySelector('.ac-mic-select').addEventListener('change', function (e) {
      switchMic(e.target.value).catch(function (err) {
        alert('마이크 전환 실패: ' + err.message);
      });
    });
    panel.querySelector('.ac-spk-select').addEventListener('change', function (e) {
      switchSpeaker(e.target.value).catch(function (err) {
        alert(err.message);
      });
    });

    return overlay;
  }

  function fillSelects() {
    var micSel = state.panelEl.querySelector('.ac-mic-select');
    var spkSel = state.panelEl.querySelector('.ac-spk-select');
    var spkNote = state.panelEl.querySelector('.ac-spk-note');

    return listDevices().then(function (d) {
      micSel.innerHTML = '';
      d.mics.forEach(function (m, i) {
        var o = document.createElement('option');
        o.value = m.deviceId;
        o.textContent = m.label || ('마이크 ' + (i + 1));
        micSel.appendChild(o);
      });
      // 현재 사용 중인 마이크 표시
      var cur = state.localStream && state.localStream.getAudioTracks()[0];
      if (cur && cur.getSettings) {
        var id = cur.getSettings().deviceId;
        if (id) micSel.value = id;
      } else if (state.selectedMicId) {
        micSel.value = state.selectedMicId;
      }

      spkSel.innerHTML = '';
      if (SUPPORTS_SINK && d.speakers.length) {
        d.speakers.forEach(function (s, i) {
          var o = document.createElement('option');
          o.value = s.deviceId;
          o.textContent = s.label || ('스피커 ' + (i + 1));
          spkSel.appendChild(o);
        });
        if (state.selectedSpeakerId) spkSel.value = state.selectedSpeakerId;
        spkSel.disabled = false;
        spkNote.style.display = 'none';
      } else {
        var o = document.createElement('option');
        o.textContent = '기기 기본 출력';
        spkSel.appendChild(o);
        spkSel.disabled = true;
        spkNote.style.display = 'block';
      }
    });
  }

  function refreshDiag() {
    if (!state.panelEl || !state.open) return;
    var r = diagnoseOutgoing();
    var dots = state.panelEl.querySelectorAll('.ac-dot');
    dots.forEach(function (dot) {
      var k = dot.getAttribute('data-k');
      dot.className = 'ac-dot ' + (r[k] ? 'ok' : 'bad');
    });
    var detail = state.panelEl.querySelector('.ac-diag-detail');
    if (detail) detail.textContent = r.detail;
  }

  /* ---------------- 열기/닫기 ---------------- */
  function open() {
    resumeCtx();
    injectStyles();
    if (!state.panelEl) buildPanel();
    document.body.appendChild(state.panelEl);
    state.open = true;

    // 권한이 있어야 라벨이 보임. 없으면 한 번 요청.
    (state.localStream ? Promise.resolve() :
      navigator.mediaDevices.getUserMedia({ audio: true, video: false })
        .then(function (s) { state.localStream = s; }).catch(function () {})
    ).then(function () {
      return fillSelects();
    }).then(function () {
      startLocalMonitor();
      refreshDiag();
      state._diagTimer = setInterval(refreshDiag, 1000);
    });
  }

  function close() {
    state.open = false;
    if (state._diagTimer) { clearInterval(state._diagTimer); state._diagTimer = null; }
    if (state.localMonitor) { state.localMonitor.stop(); state.localMonitor = null; }
    if (state.panelEl && state.panelEl.parentNode) {
      state.panelEl.parentNode.removeChild(state.panelEl);
    }
  }

  /* ================= 공개 API ================= */
  var AudioControls = {
    init: function (opts) {
      opts = opts || {};
      state.localStream = opts.localStream || null;
      state.getPeerConnections = opts.getPeerConnections || function () { return []; };
      state.onMicChange = opts.onMicChange || null;
      if (opts.speakingThreshold != null) state.speakingThreshold = opts.speakingThreshold;
      injectStyles();

      // 최초 사용자 제스처에서 AudioContext 활성화 (iOS 대응)
      var resumeOnce = function () {
        if (state.resumedOnce) return;
        state.resumedOnce = true;
        resumeCtx();
        document.removeEventListener('click', resumeOnce);
        document.removeEventListener('touchstart', resumeOnce);
      };
      document.addEventListener('click', resumeOnce);
      document.addEventListener('touchstart', resumeOnce);

      if (opts.showButton) {
        var btn = document.createElement('button');
        btn.className = 'ac-btn-gear';
        btn.title = '오디오 설정';
        btn.innerHTML =
          '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">' +
          '<path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm9.4 4c0-.6-.05-1.17-.14-1.73l2.02-1.58-2-3.46-2.38.96a7.6 7.6 0 0 0-3-1.73L15 2H9l-.9 2.46a7.6 7.6 0 0 0-3 1.73l-2.38-.96-2 3.46 2.02 1.58c-.09.56-.14 1.13-.14 1.73s.05 1.17.14 1.73L.72 15.58l2 3.46 2.38-.96c.87.74 1.88 1.32 3 1.73L9 22h6l.9-2.46a7.6 7.6 0 0 0 3-1.73l2.38.96 2-3.46-2.02-1.58c.09-.56.14-1.13.14-1.73z"/>' +
          '</svg>';
        btn.addEventListener('click', open);
        document.body.appendChild(btn);
        state.gearBtn = btn;
      }

      // 장치 변경(케이블 뽑기 등) 감지 시 목록 갱신
      if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
        navigator.mediaDevices.addEventListener('devicechange', function () {
          if (state.open) fillSelects();
        });
      }
    },

    open: open,
    close: close,

    // 로컬 스트림을 나중에 넘기는 경우
    setLocalStream: function (stream) { state.localStream = stream; },

    attachRemote: function (peerId, stream, tileEl) {
      if (!stream || !tileEl) return;
      if (state.remoteMonitors.has(peerId)) this.detachRemote(peerId);
      startRemoteMonitor(peerId, stream, tileEl);
    },

    detachRemote: function (peerId) {
      var m = state.remoteMonitors.get(peerId);
      if (m) {
        m.stop();
        if (m.badge && m.badge.parentNode) m.badge.parentNode.removeChild(m.badge);
        if (m.tileEl) m.tileEl.classList.remove('ac-speaking');
        state.remoteMonitors.delete(peerId);
      }
    },

    setSpeakingThreshold: function (v) { state.speakingThreshold = v; },

    showButton: function () { if (state.gearBtn) state.gearBtn.style.display = 'flex'; },
    hideButton: function () { if (state.gearBtn) state.gearBtn.style.display = 'none'; },

    supportsSpeakerSelect: SUPPORTS_SINK
  };

  global.AudioControls = AudioControls;
})(window);
